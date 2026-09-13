// =============================================================================
// ColumnIndex — dictionary + posting lists over one column
//
// filterIndex and enumerateDistinct pay O(rows) of per-row work on every call:
// a boxed `get(i)`, a `String()`, a `toLowerCase()`, an `includes()`. On a
// quick-filter box that is the cost of every keystroke. Most grid columns are
// nowhere near unique — status, region, category, owner, currency — so the
// same few hundred strings are re-lowercased and re-searched a million times.
//
// The idea is the one a search engine is built on (the `index` repo's term
// dictionary + posting lists): factor the column once into
//
//   value[code]                 each distinct present value, first-seen order
//   code[row]                   dictionary code per row, -1 when the row is null
//   row[offset[c]..offset[c+1]] the rows holding code c, ascending
//
// and then evaluate a predicate ONCE PER DISTINCT VALUE instead of once per
// row. A leaf becomes O(distinct) predicate calls plus one tight typed-array
// pass (or a posting-list walk when few rows match).
//
// A dictionary only pays when values repeat. On a near-unique column (an id, a
// timestamp, a price) it is a 500K-entry Map built for nothing, and measured on
// the playground's dataset it made the FIRST keystroke slower than a plain scan
// (525 ms vs 335 ms). So each column picks a mode: 'dictionary', or 'row' —
// cached lower-cased strings per row with the same typeahead refinement, and
// every non-string operator delegated to filterIndex itself. 'auto' samples the
// column to decide.
//
// Equivalence contract: every result here is bit-identical to filterIndex /
// enumerateDistinct on the same table, in either mode. That holds because each
// filterIndex predicate is a pure function of `(isNull(i), get(i))`, and the
// dictionary keys by `get(i)` under SameValueZero — the same equality `in`/
// `notIn` and enumerateDistinct's Map already use. The property test pins it.
//
// The index is a snapshot. ColumnTable is immutable through its API, but the
// arrays it wraps are the caller's; mutate them and you must rebuild.
// =============================================================================

import type { ComparisonFilter, FilterModel, FilterNode } from '@onegrid/protocol';
import type { ColumnTable } from './column-table';
import type { DistinctValue } from './distinct';
import { filterIndex, type FilterOptions } from './filter';
import { BitmapSelection } from './selection';

export interface ColumnIndex {
  readonly columnId: string;
  readonly numRows: number;
  /** Distinct present values, in first-seen row order. */
  readonly value: ReadonlyArray<unknown>;
  /** Per-row dictionary code; -1 marks a null row. */
  readonly code: Int32Array;
  /** CSR offsets, length `value.length + 1`. */
  readonly offset: Int32Array;
  /** Row ids grouped by code, ascending within each code. */
  readonly row: Int32Array;
  readonly nullCount: number;
  /** How many distinct codes were assigned before the first null row (-1 if none). */
  readonly nullRank: number;
}

export function buildColumnIndex(table: ColumnTable, columnId: string): ColumnIndex {
  const column = table.column(columnId);
  const numRows = table.numRows;
  const code = new Int32Array(numRows);
  const dictionary = new Map<unknown, number>();
  const value: unknown[] = [];
  let nullCount = 0;
  let nullRank = -1;

  for (let i = 0; i < numRows; i++) {
    if (column.isNull(i)) {
      code[i] = -1;
      if (nullCount === 0) nullRank = value.length;
      nullCount++;
      continue;
    }
    const v = column.get(i);
    let c = dictionary.get(v);
    if (c === undefined) {
      c = value.length;
      dictionary.set(v, c);
      // A Map normalises a -0 key to +0, and enumerateDistinct reports Map
      // keys — so store the key the Map stores. Every filter predicate treats
      // -0 and 0 identically, so this cannot change a filter result.
      value.push(v === 0 ? 0 : v);
    }
    code[i] = c;
  }

  const offset = new Int32Array(value.length + 1);
  for (let i = 0; i < numRows; i++) {
    const c = code[i]!;
    if (c >= 0) offset[c + 1]!++;
  }
  for (let c = 0; c < value.length; c++) offset[c + 1]! += offset[c]!;
  const cursor = offset.slice(0, value.length);
  const row = new Int32Array(numRows - nullCount);
  for (let i = 0; i < numRows; i++) {
    const c = code[i]!;
    if (c >= 0) row[cursor[c]!++] = i;
  }

  return { columnId, numRows, value, code, offset, row, nullCount, nullRank };
}

// -----------------------------------------------------------------------------
// TableIndex — lazy per-column indexes plus the caches a quick filter keeps
// hitting (lower-cased strings, and the last contains-match per column).
// -----------------------------------------------------------------------------

/**
 * How a column answers string filters. 'dictionary' evaluates once per distinct
 * value; 'row' evaluates once per row over cached strings (no dictionary build);
 * 'auto' samples each column and picks 'row' when it is near-unique.
 */
export type ColumnIndexMode = 'auto' | 'dictionary' | 'row';

export interface TableIndexOption {
  /** Default 'auto'. */
  readonly mode?: ColumnIndexMode;
}

export interface TableIndex {
  readonly table: ColumnTable;
  /** Build (once) and return the dictionary index for a column, whatever its filter mode. */
  readonly column: (columnId: string) => ColumnIndex;
  /** Drop every cached column index — call after mutating the source arrays. */
  readonly invalidate: () => void;
}

interface ColumnState {
  readonly columnId: string;
  readonly mode: 'dictionary' | 'row';
  index: ColumnIndex | null;
  /** Haystack strings per code ('dictionary') or per row ('row'), lower-cased. */
  lower: string[] | null;
  /** Haystack strings, case preserved. */
  raw: string[] | null;
  /** 'row' mode only: 1 when the row is present (filterIndex never matches a null row). */
  present: Uint8Array | null;
  /** Last contains result (per code or per row), for typeahead refinement. */
  lastContain: { needle: string; caseSensitive: boolean; match: Uint8Array } | null;
}

interface TableState {
  readonly mode: ColumnIndexMode;
  readonly byColumn: Map<string, ColumnState>;
}

const STATE = new WeakMap<TableIndex, TableState>();

/** Rows sampled (evenly across the column, not just its head) to choose a mode. */
const SAMPLE_ROW = 4096;
/** Distinct share of the sample above which 'auto' treats a column as near-unique. */
const NEAR_UNIQUE_RATIO = 0.9;

export function createTableIndex(table: ColumnTable, option: TableIndexOption = {}): TableIndex {
  const byColumn = new Map<string, ColumnState>();
  const tableIndex: TableIndex = {
    table,
    column: (columnId) => ensureIndex(tableIndex.table, stateFor(tableIndex, columnId)),
    invalidate: () => byColumn.clear(),
  };
  STATE.set(tableIndex, { mode: option.mode ?? 'auto', byColumn });
  return tableIndex;
}

function stateFor(tableIndex: TableIndex, columnId: string): ColumnState {
  const tableState = STATE.get(tableIndex)!;
  let state = tableState.byColumn.get(columnId);
  if (!state) {
    state = {
      columnId,
      mode: chooseMode(tableIndex.table, columnId, tableState.mode),
      index: null,
      lower: null,
      raw: null,
      present: null,
      lastContain: null,
    };
    tableState.byColumn.set(columnId, state);
  }
  return state;
}

function chooseMode(table: ColumnTable, columnId: string, mode: ColumnIndexMode): 'dictionary' | 'row' {
  if (mode !== 'auto') return mode;
  const numRows = table.numRows;
  // Small tables: a dictionary is cheap whatever the cardinality.
  if (numRows <= SAMPLE_ROW) return 'dictionary';
  const column = table.column(columnId);
  const stride = Math.floor(numRows / SAMPLE_ROW);
  const seen = new Set<unknown>();
  let present = 0;
  for (let k = 0, i = 0; k < SAMPLE_ROW; k++, i += stride) {
    if (column.isNull(i)) continue;
    present++;
    seen.add(column.get(i));
  }
  return present > 0 && seen.size / present > NEAR_UNIQUE_RATIO ? 'row' : 'dictionary';
}

function ensureIndex(table: ColumnTable, state: ColumnState): ColumnIndex {
  if (!state.index) state.index = buildColumnIndex(table, state.columnId);
  return state.index;
}

// -----------------------------------------------------------------------------
// filterIndexed — filterIndex, one predicate call per distinct value (or per
// cached row string)
// -----------------------------------------------------------------------------

export function filterIndexed(
  tableIndex: TableIndex,
  filter: FilterModel,
  options: FilterOptions = {},
): BitmapSelection {
  const numRows = tableIndex.table.numRows;
  if (filter === null) return new BitmapSelection(numRows, 'full');
  return evaluateNode(tableIndex, filter, options);
}

function evaluateNode(
  tableIndex: TableIndex,
  node: FilterNode,
  options: FilterOptions,
): BitmapSelection {
  const numRows = tableIndex.table.numRows;
  if (node.type === 'comparison') return evaluateComparison(tableIndex, node, options);
  if (node.op === 'not') {
    const inner = node.filters[0];
    if (!inner) return new BitmapSelection(numRows, 'full');
    return evaluateNode(tableIndex, inner, options).invert();
  }
  if (node.filters.length === 0) {
    return new BitmapSelection(numRows, node.op === 'and' ? 'full' : 'empty');
  }
  let result = evaluateNode(tableIndex, node.filters[0]!, options);
  for (let i = 1; i < node.filters.length; i++) {
    const next = evaluateNode(tableIndex, node.filters[i]!, options);
    result = node.op === 'and' ? result.intersect(next) : result.union(next);
  }
  return result;
}

function isStringOp(op: ComparisonFilter['op']): boolean {
  return op === 'contains' || op === 'notContains' || op === 'startsWith' || op === 'endsWith';
}

function evaluateComparison(
  tableIndex: TableIndex,
  node: ComparisonFilter,
  options: FilterOptions,
): BitmapSelection {
  const table = tableIndex.table;
  if (!table.hasColumn(node.columnId)) return new BitmapSelection(table.numRows, 'empty');
  const state = stateFor(tableIndex, node.columnId);

  if (state.mode === 'row') {
    // Only the string operators have a per-row cache worth keeping; every other
    // operator IS filterIndex, so it cannot disagree with it.
    if (!isStringOp(node.op)) return filterIndex(table, node, options);
    return materialiseRow(table.numRows, matchRow(table, state, node));
  }

  const index = ensureIndex(table, state);
  if (node.op === 'isNull' || node.op === 'isNotNull') {
    return materialiseNull(index, node.op === 'isNull');
  }
  const match = matchCode(state, index, node, options);
  return materialise(index, match);
}

/** 'row' mode: one byte per row, 1 when that row satisfies a string operator. */
function matchRow(table: ColumnTable, state: ColumnState, node: ComparisonFilter): Uint8Array {
  const cs = node.caseSensitive ?? false;
  const hay = haystack(table, state, cs);
  const present = state.present!;
  const needleRaw = String(node.value ?? '');
  const needle = cs ? needleRaw : needleRaw.toLowerCase();
  const numRows = hay.length;
  const match = new Uint8Array(numRows);
  const op = node.op;

  if (op === 'contains' || op === 'notContains') {
    const contain = containMatch(state, hay, needle, cs);
    const flip = op === 'notContains' ? 1 : 0;
    for (let r = 0; r < numRows; r++) match[r] = present[r]! & (contain[r]! ^ flip);
    return match;
  }
  for (let r = 0; r < numRows; r++) {
    if (present[r] !== 1) continue;
    const h = hay[r]!;
    match[r] = (op === 'startsWith' ? h.startsWith(needle) : h.endsWith(needle)) ? 1 : 0;
  }
  return match;
}

/** One byte per dictionary code: 1 when that value satisfies the predicate. */
function matchCode(
  state: ColumnState,
  index: ColumnIndex,
  node: ComparisonFilter,
  options: FilterOptions,
): Uint8Array {
  const value = index.value;
  const distinct = value.length;
  const match = new Uint8Array(distinct);
  const op = node.op;
  const cs = node.caseSensitive ?? false;

  if (isStringOp(op)) {
    const hay = dictionaryHaystack(state, index, cs);
    const needleRaw = String(node.value ?? '');
    const needle = cs ? needleRaw : needleRaw.toLowerCase();

    if (op === 'contains' || op === 'notContains') {
      const contain = containMatch(state, hay, needle, cs);
      if (op === 'contains') return contain;
      for (let c = 0; c < distinct; c++) match[c] = contain[c]! ^ 1;
      return match;
    }
    for (let c = 0; c < distinct; c++) {
      const h = hay[c]!;
      match[c] = (op === 'startsWith' ? h.startsWith(needle) : h.endsWith(needle)) ? 1 : 0;
    }
    return match;
  }

  if (op === 'in' || op === 'notIn') {
    const set = new Set(node.values ?? []);
    const want = op === 'in';
    for (let c = 0; c < distinct; c++) match[c] = set.has(value[c]) === want ? 1 : 0;
    return match;
  }

  const collator = new Intl.Collator(options.locale, {
    numeric: true,
    sensitivity: cs ? 'variant' : 'accent',
  });

  if (op === 'between' || op === 'notBetween') {
    const [lo, hi] = (node.values ?? []) as [unknown, unknown];
    for (let c = 0; c < distinct; c++) {
      const v = value[c];
      const inRange = compareValues(v, lo, collator) >= 0 && compareValues(v, hi, collator) <= 0;
      match[c] = (op === 'between' ? inRange : !inRange) ? 1 : 0;
    }
    return match;
  }

  const target = node.value;
  for (let c = 0; c < distinct; c++) {
    const cmp = compareValues(value[c], target, collator);
    let ok: boolean;
    switch (op) {
      case 'eq':
        ok = cmp === 0;
        break;
      case 'neq':
        ok = cmp !== 0;
        break;
      case 'lt':
        ok = cmp < 0;
        break;
      case 'lte':
        ok = cmp <= 0;
        break;
      case 'gt':
        ok = cmp > 0;
        break;
      case 'gte':
        ok = cmp >= 0;
        break;
      default:
        ok = false;
    }
    match[c] = ok ? 1 : 0;
  }
  return match;
}

/**
 * Typeahead refinement. When the new needle contains the previous needle, every
 * string matching the new one also matched the old one, so only the old matches
 * need re-testing. Typing "ai" → "aik" → "aiko" narrows the candidate set on
 * every keystroke instead of rescanning.
 */
function containMatch(state: ColumnState, hay: string[], needle: string, cs: boolean): Uint8Array {
  const length = hay.length;
  const match = new Uint8Array(length);
  const last = state.lastContain;
  if (last && last.caseSensitive === cs && last.match.length === length && needle.includes(last.needle)) {
    const prev = last.match;
    for (let i = 0; i < length; i++) {
      if (prev[i] === 1 && hay[i]!.includes(needle)) match[i] = 1;
    }
  } else {
    for (let i = 0; i < length; i++) if (hay[i]!.includes(needle)) match[i] = 1;
  }
  state.lastContain = { needle, caseSensitive: cs, match };
  return match;
}

/**
 * `String(v ?? '')`, lower-cased when asked. A finite number's string form is
 * already lower case (digits, '-', '.', 'e', '+'), so it skips the second
 * allocation; NaN and Infinity do not, and are lower-cased like any string.
 */
function hayOf(v: unknown, lower: boolean): string {
  const s = String(v ?? '');
  return lower && !(typeof v === 'number' && Number.isFinite(v)) ? s.toLowerCase() : s;
}

function dictionaryHaystack(state: ColumnState, index: ColumnIndex, cs: boolean): string[] {
  if (cs) {
    if (!state.raw) state.raw = index.value.map((v) => hayOf(v, false));
    return state.raw;
  }
  if (!state.lower) state.lower = index.value.map((v) => hayOf(v, true));
  return state.lower;
}

function haystack(table: ColumnTable, state: ColumnState, cs: boolean): string[] {
  const cached = cs ? state.raw : state.lower;
  if (cached) return cached;
  const column = table.column(state.columnId);
  const numRows = table.numRows;
  const out = new Array<string>(numRows);
  const present = state.present ?? new Uint8Array(numRows);
  const fillPresent = state.present === null;
  for (let r = 0; r < numRows; r++) {
    if (column.isNull(r)) {
      out[r] = '';
      continue;
    }
    if (fillPresent) present[r] = 1;
    out[r] = hayOf(column.get(r), !cs);
  }
  state.present = present;
  if (cs) state.raw = out;
  else state.lower = out;
  return out;
}

function materialiseRow(numRows: number, match: Uint8Array): BitmapSelection {
  const sel = new BitmapSelection(numRows, 'empty');
  const bytes = sel._bytes;
  for (let r = 0; r < numRows; r++) {
    if (match[r] === 1) bytes[r >>> 3]! |= 1 << (r & 7);
  }
  return BitmapSelection.fromBytes(numRows, bytes);
}

/**
 * Turn a per-code match into a row bitmap. Walks posting lists when the match
 * is sparse (cost ∝ matching rows), otherwise one pass over the code array
 * (cost ∝ rows, but a typed-array read and a byte test per row).
 */
function materialise(index: ColumnIndex, match: Uint8Array): BitmapSelection {
  const sel = new BitmapSelection(index.numRows, 'empty');
  const bytes = sel._bytes;
  const { offset, row, code } = index;
  let matched = 0;
  for (let c = 0; c < match.length; c++) {
    if (match[c] === 1) matched += offset[c + 1]! - offset[c]!;
  }
  if (matched === 0) return sel;

  if (matched * 4 < index.numRows) {
    for (let c = 0; c < match.length; c++) {
      if (match[c] !== 1) continue;
      for (let p = offset[c]!, end = offset[c + 1]!; p < end; p++) {
        const r = row[p]!;
        bytes[r >>> 3]! |= 1 << (r & 7);
      }
    }
  } else {
    for (let r = 0; r < index.numRows; r++) {
      const c = code[r]!;
      if (c >= 0 && match[c] === 1) bytes[r >>> 3]! |= 1 << (r & 7);
    }
  }
  return BitmapSelection.fromBytes(index.numRows, bytes);
}

function materialiseNull(index: ColumnIndex, wantNull: boolean): BitmapSelection {
  const sel = new BitmapSelection(index.numRows, 'empty');
  const bytes = sel._bytes;
  const code = index.code;
  for (let r = 0; r < index.numRows; r++) {
    if ((code[r]! < 0) === wantNull) bytes[r >>> 3]! |= 1 << (r & 7);
  }
  return BitmapSelection.fromBytes(index.numRows, bytes);
}

// -----------------------------------------------------------------------------
// enumerateDistinctIndexed — set-filter values without rescanning the column
// -----------------------------------------------------------------------------

export interface EnumerateDistinctIndexedOptions {
  /** Only count rows in this selection (e.g. rows passing the other filters). */
  readonly selection?: BitmapSelection;
  /** Cap the result; null = no cap. Default 10000. */
  readonly limit?: number | null;
}

/**
 * Same output as `enumerateDistinct`, element for element. With no selection it
 * is O(distinct) — the counts are the posting-list lengths. With a selection it
 * counts only the selected rows through the code array.
 */
export function enumerateDistinctIndexed(
  tableIndex: TableIndex,
  columnId: string,
  options: EnumerateDistinctIndexedOptions = {},
): DistinctValue[] {
  const limit = options.limit === undefined ? 10000 : options.limit;
  const index = tableIndex.column(columnId);
  const out: DistinctValue[] = [];
  const selection = options.selection;
  // enumerateDistinct keys by `isNull(i) ? null : get(i)`, so a PRESENT cell
  // whose value is literally `null` (validity bit set) shares the null bucket.
  // The dictionary gives that value its own code; fold it back in here.
  const nullCode = index.value.indexOf(null);

  if (!selection) {
    const distinct = index.value.length;
    const nullTotal = index.nullCount + (nullCode >= 0 ? index.offset[nullCode + 1]! - index.offset[nullCode]! : 0);
    // Codes other than nullCode seen before the merged bucket's first row.
    const rank =
      nullCode < 0 ? index.nullRank : index.nullCount === 0 ? nullCode : Math.min(nullCode, index.nullRank);
    let k = 0;
    for (let c = 0; c < distinct; c++) {
      if (c === nullCode) continue;
      if (k === rank && nullTotal > 0) out.push({ value: null, count: nullTotal });
      out.push({ value: index.value[c], count: index.offset[c + 1]! - index.offset[c]! });
      k++;
    }
    if (nullTotal > 0 && rank === k) out.push({ value: null, count: nullTotal });
  } else {
    // Count in ascending row order so first-seen order (the sort's tie-break
    // for values that compare equal) matches enumerateDistinct's Map exactly.
    const count = new Int32Array(index.value.length);
    const order: number[] = [];
    let nullCount = 0;
    let nullRank = -1;
    const code = index.code;
    const bytes = selection._bytes;
    const numRows = Math.min(index.numRows, selection.length);
    for (let b = 0; b < bytes.length; b++) {
      let byte = bytes[b]!;
      while (byte !== 0) {
        const low = byte & -byte;
        const r = (b << 3) + (31 - Math.clz32(low));
        byte ^= low;
        if (r >= numRows) break;
        const c = code[r]!;
        if (c < 0 || c === nullCode) {
          if (nullCount === 0) nullRank = order.length;
          nullCount++;
        } else {
          if (count[c] === 0) order.push(c);
          count[c] = count[c]! + 1;
        }
      }
    }
    for (let k = 0; k < order.length; k++) {
      if (k === nullRank) out.push({ value: null, count: nullCount });
      const c = order[k]!;
      out.push({ value: index.value[c], count: count[c]! });
    }
    if (nullCount > 0 && nullRank === order.length) out.push({ value: null, count: nullCount });
  }

  out.sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return compareDistinct(a.value, b.value);
  });
  return limit === null ? out : out.slice(0, limit);
}

// Both comparators are copied verbatim from filter.ts / distinct.ts on purpose:
// sharing them would be tidier, but the equivalence contract is with THOSE
// functions, and a refactor of either must be caught by the property test
// rather than silently followed here.

function compareValues(a: unknown, b: unknown, collator: Intl.Collator): number {
  if (typeof a === 'string' || typeof b === 'string') {
    return collator.compare(String(a ?? ''), String(b ?? ''));
  }
  const an = toNumeric(a);
  const bn = toNumeric(b);
  if (an < bn) return -1;
  if (an > bn) return 1;
  return 0;
}

function toNumeric(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof Date) return v.getTime();
  if (v === null || v === undefined) return 0;
  const n = Number(v);
  return Number.isNaN(n) ? 0 : n;
}

function compareDistinct(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b));
}
