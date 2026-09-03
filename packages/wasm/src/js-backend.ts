// =============================================================================
// createJsBackend — the semantic reference
//
// This backend is not a fallback in the apologetic sense. It is the definition
// of what every other backend must compute. When the Rust kernel and this file
// disagree, the Rust kernel is wrong.
//
// Four of the six operations delegate straight to @onegrid/data rather than
// reimplementing it. That is deliberate and it is the whole reason the seam is
// trustworthy: `sortIndex`, `filterMask`, `aggregate` and `bitmapOp` already
// have a tested implementation in this repo, and a second copy of a
// comparator or a null rule is a second place for the semantics to drift. The
// cost is that each call builds a one-column ColumnTable wrapper — a handful
// of closures, not a data copy, since Float64Array.subarray is a view.
//
// The two that do not delegate:
//   - groupKey. @onegrid/data has `groupRows`, which builds a tree of nodes
//     with aggregates. Dense factorisation is a different output shape, and
//     deriving codes from the tree would impose depth-first ordering rather
//     than first-appearance ordering — harder to mirror in a kernel that has
//     no allocator.
//   - topK. A bounded heap is the point of the operation; delegating to a full
//     sort would make the reference O(n log n) where the contract promises
//     O(n log k). The test suite pins it to `sortIndex(...).subarray(0, k)`
//     instead, which is the stronger statement anyway.
// =============================================================================

import type {
  Aggregation,
  AggregationType,
  ColumnSchema,
  ComparisonFilter,
  ComparisonOperator,
  SortModel,
} from '@onegrid/protocol';
import {
  BitmapSelection,
  aggregate as dataAggregate,
  createColumnTable,
  filterIndex,
  sortIndex as dataSortIndex,
} from '@onegrid/data';
import type { ColumnInput, ColumnTable } from '@onegrid/data';
import type {
  AccelAggregateOp,
  AccelBackend,
  AccelBitmapOp,
  AccelColumn,
  AccelGroupCode,
  AccelPredicate,
  AccelSortKey,
  AccelTopKOption,
} from './types';
import { byteLengthFor, compareRow, presenceBitmap, trimTail } from './bit';

const FLOAT64: Omit<ColumnSchema, 'id'> = { type: 'float64', nullable: true };

/**
 * Wrap a raw column as a single-column ColumnTable so @onegrid/data can
 * operate on it. `subarray` is a view over the same buffer, so this costs one
 * object allocation and no bytes copied.
 */
function columnInput(id: string, column: AccelColumn, length: number): ColumnInput {
  return {
    schema: { id, ...FLOAT64 },
    data: column.value.subarray(0, length),
    validity: presenceBitmap(column.value, column.validity, length),
  };
}

function tableOf(input: ReadonlyArray<ColumnInput>): ColumnTable {
  return createColumnTable(input);
}

// -----------------------------------------------------------------------------
// sortIndex
// -----------------------------------------------------------------------------

function jsSortIndex(key: ReadonlyArray<AccelSortKey>, length: number): Int32Array {
  const n = Math.max(0, length | 0);
  if (key.length === 0 || n === 0) {
    const identity = new Int32Array(n);
    for (let i = 0; i < n; i++) identity[i] = i;
    return identity;
  }
  const input = key.map((k, i) => columnInput(`k${i}`, k, n));
  const sort: SortModel = key.map((k, i) => ({
    columnId: `k${i}`,
    direction: k.descending === true ? ('desc' as const) : ('asc' as const),
    nulls: k.missingFirst === true ? ('first' as const) : ('last' as const),
  }));
  return dataSortIndex(tableOf(input), sort);
}

// -----------------------------------------------------------------------------
// filterMask
// -----------------------------------------------------------------------------

/**
 * The accel predicate vocabulary is a strict subset of the protocol's, so the
 * translation is a rename rather than a reinterpretation. Keeping it explicit
 * (rather than a cast) means adding an accel operator that the protocol lacks
 * becomes a type error here instead of a silent mismatch at runtime.
 */
const PREDICATE_OP: Record<AccelPredicate['op'], ComparisonOperator> = {
  eq: 'eq',
  neq: 'neq',
  lt: 'lt',
  lte: 'lte',
  gt: 'gt',
  gte: 'gte',
  between: 'between',
  notBetween: 'notBetween',
  in: 'in',
  notIn: 'notIn',
  isNull: 'isNull',
  isNotNull: 'isNotNull',
};

/**
 * A NaN OPERAND is the mirror of a NaN value, and it needs handling here
 * because `@onegrid/data` does not do it: its numeric comparator reduces
 * `compare(x, NaN)` to 0, which reports `x eq NaN` as a match. IEEE-754 says
 * every ordered comparison against NaN is false and only `!=` is true, the
 * kernel gets that for free from the hardware, and the property test found the
 * disagreement on its thirty-fourth case.
 *
 * Rather than fork the comparator, the seam normalises the predicate before it
 * reaches @onegrid/data: an unsatisfiable comparison becomes "match nothing"
 * and a trivially-satisfied one becomes "match every present row".
 */
function nanOperandOutcome(predicate: AccelPredicate): 'none' | 'present' | null {
  const { op } = predicate;
  if (op === 'isNull' || op === 'isNotNull' || op === 'in' || op === 'notIn') {
    // `in`/`notIn` need no special case: nothing equals NaN, so a NaN in the
    // set is inert on both sides of the seam.
    return null;
  }
  const lower = predicate.operand ?? 0;
  const upper = predicate.upper ?? 0;
  const bad =
    op === 'between' || op === 'notBetween'
      ? Number.isNaN(lower) || Number.isNaN(upper)
      : Number.isNaN(lower);
  if (!bad) return null;
  return op === 'neq' || op === 'notBetween' ? 'present' : 'none';
}

function jsFilterMask(column: AccelColumn, predicate: AccelPredicate): Uint8Array {
  const n = column.value.length;
  const outcome = nanOperandOutcome(predicate);
  if (outcome === 'none') return new Uint8Array(byteLengthFor(n));
  if (outcome === 'present') {
    return trimTail(presenceBitmap(column.value, column.validity, n), n);
  }
  const table = tableOf([columnInput('v', column, n)]);
  const op = PREDICATE_OP[predicate.op];
  const filter: ComparisonFilter = {
    type: 'comparison',
    columnId: 'v',
    op,
    value: predicate.operand ?? 0,
    values:
      op === 'between' || op === 'notBetween'
        ? [predicate.operand ?? 0, predicate.upper ?? 0]
        : Array.from(predicate.set ?? new Float64Array(0)),
  };
  const selection = filterIndex(table, filter);
  return trimTail(Uint8Array.from(selection._bytes), n);
}

// -----------------------------------------------------------------------------
// groupKey
// -----------------------------------------------------------------------------

/**
 * Factorise one column. Missing rows share a single code of their own, taken
 * at the position of the first missing row so the numbering stays
 * first-appearance for every row without a special case at the call site.
 */
function factorise(
  column: AccelColumn,
  length: number,
): { readonly code: Int32Array; readonly cardinality: number } {
  const present = presenceBitmap(column.value, column.validity, length);
  const code = new Int32Array(length);
  // Map keys use SameValueZero, which is exactly the -0 === 0 collapse the
  // contract promises. A Rust kernel gets there by normalising -0.0 to 0.0
  // before hashing the bit pattern.
  const seen = new Map<number, number>();
  let missingCode = -1;
  let next = 0;
  for (let i = 0; i < length; i++) {
    if (((present[i >>> 3] ?? 0) & (1 << (i & 7))) === 0) {
      if (missingCode < 0) missingCode = next++;
      code[i] = missingCode;
      continue;
    }
    const v = column.value[i] as number;
    let c = seen.get(v);
    if (c === undefined) {
      c = next++;
      seen.set(v, c);
    }
    code[i] = c;
  }
  return { code, cardinality: next };
}

function jsGroupKey(key: ReadonlyArray<AccelColumn>, length: number): AccelGroupCode {
  const n = Math.max(0, length | 0);
  if (n === 0) return { code: new Int32Array(0), cardinality: 0 };
  // Zero keys means one group containing everything — the degenerate but
  // well-defined "group by nothing" a totals row asks for.
  let code = new Int32Array(n);
  let cardinality = 1;
  for (const column of key) {
    const level = factorise(column, n);
    // Progressive refinement: pair the running code with this column's code
    // and renumber. A nested Map avoids composing the pair into one integer,
    // which would overflow float64 precision at realistic cardinalities.
    const pair = new Map<number, Map<number, number>>();
    const out = new Int32Array(n);
    let next = 0;
    for (let i = 0; i < n; i++) {
      const a = code[i] as number;
      const b = level.code[i] as number;
      let inner = pair.get(a);
      if (inner === undefined) {
        inner = new Map<number, number>();
        pair.set(a, inner);
      }
      let c = inner.get(b);
      if (c === undefined) {
        c = next++;
        inner.set(b, c);
      }
      out[i] = c;
    }
    code = out;
    cardinality = next;
  }
  return { code, cardinality };
}

// -----------------------------------------------------------------------------
// aggregate
// -----------------------------------------------------------------------------

const AGGREGATE_OP: Record<AccelAggregateOp, AggregationType> = {
  sum: 'sum',
  avg: 'avg',
  count: 'count',
  countDistinct: 'countDistinct',
  min: 'min',
  max: 'max',
  first: 'first',
  last: 'last',
};

function jsAggregate(
  op: AccelAggregateOp,
  column: AccelColumn,
  index: Int32Array | null,
): number | null {
  const n = column.value.length;
  const table = tableOf([columnInput('v', column, n)]);
  const spec: Aggregation = { columnId: 'v', fn: AGGREGATE_OP[op] };
  const raw = dataAggregate(table, spec, index);
  if (raw === null || raw === undefined) return null;
  return raw as number;
}

// -----------------------------------------------------------------------------
// bitmapOp
// -----------------------------------------------------------------------------

/**
 * Adopt an arbitrary byte array as a BitmapSelection of exactly `bitLength`
 * bits. Callers hand us masks produced by `filterMask`, by a worker, or by
 * WASM, and those may be over- or under-sized by a byte; normalising here is
 * cheaper than making every producer exact.
 */
function adopt(bytes: Uint8Array | null, bitLength: number): BitmapSelection {
  const exact = new Uint8Array(byteLengthFor(bitLength));
  if (bytes) exact.set(bytes.subarray(0, Math.min(bytes.length, exact.length)));
  trimTail(exact, bitLength);
  return BitmapSelection.fromBytes(bitLength, exact);
}

function jsBitmapOp(
  op: AccelBitmapOp,
  a: Uint8Array,
  b: Uint8Array | null,
  bitLength: number,
): Uint8Array {
  const n = Math.max(0, bitLength | 0);
  const left = adopt(a, n);
  if (op === 'not') return trimTail(Uint8Array.from(left.invert()._bytes), n);
  const right = adopt(b, n);
  let result: BitmapSelection;
  switch (op) {
    case 'and':
      result = left.intersect(right);
      break;
    case 'or':
      result = left.union(right);
      break;
    case 'andNot':
      result = left.intersect(right.invert());
      break;
    default:
      // XOR is not a BitmapSelection primitive; compose it rather than reach
      // into the byte array, so the tail-bit rule stays owned by one place.
      result = left.union(right).intersect(left.intersect(right).invert());
      break;
  }
  return trimTail(Uint8Array.from(result._bytes), n);
}

// -----------------------------------------------------------------------------
// topK
// -----------------------------------------------------------------------------

function jsTopK(
  column: AccelColumn,
  k: number,
  option: AccelTopKOption = {},
): Int32Array {
  const n = column.value.length;
  const want = Math.max(0, Math.min(k | 0, n));
  if (want === 0) return new Int32Array(0);
  const present = presenceBitmap(column.value, column.validity, n);
  const descending = option.descending === true;
  const missingFirst = option.missingFirst === true;
  const worse = (x: number, y: number): boolean =>
    compareRow(column.value, present, x, y, descending, missingFirst) > 0;

  // Max-heap of the `want` best rows so far, ordered so the ROOT is the worst
  // of them. A candidate only enters if it beats the root, which is the O(1)
  // rejection that makes this O(n log k) instead of O(n log n).
  const heap = new Int32Array(want);
  let size = 0;
  for (let i = 0; i < n; i++) {
    if (size < want) {
      heap[size] = i;
      let c = size++;
      while (c > 0) {
        const parent = (c - 1) >> 1;
        if (!worse(heap[c] as number, heap[parent] as number)) break;
        const t = heap[c] as number;
        heap[c] = heap[parent] as number;
        heap[parent] = t;
        c = parent;
      }
      continue;
    }
    // Evict only when the reigning worst is genuinely worse than the
    // candidate. Comparing the other way round keeps the WORST k rows, which
    // is the bug this reads as a guard against.
    if (!worse(heap[0] as number, i)) continue;
    heap[0] = i;
    let p = 0;
    for (;;) {
      const l = 2 * p + 1;
      const r = l + 1;
      let big = p;
      if (l < size && worse(heap[l] as number, heap[big] as number)) big = l;
      if (r < size && worse(heap[r] as number, heap[big] as number)) big = r;
      if (big === p) break;
      const t = heap[p] as number;
      heap[p] = heap[big] as number;
      heap[big] = t;
      p = big;
    }
  }
  const out = Array.from(heap.subarray(0, size));
  out.sort((x, y) => compareRow(column.value, present, x, y, descending, missingFirst));
  return Int32Array.from(out);
}

/**
 * Build the reference backend. It has no state and no teardown, so a single
 * instance can be shared process-wide; the factory exists so adopters can
 * treat every backend uniformly.
 */
export function createJsBackend(): AccelBackend {
  return {
    name: 'js',
    capability: { wasm: false, simd: false, thread: false },
    sortIndex: jsSortIndex,
    filterMask: jsFilterMask,
    groupKey: jsGroupKey,
    aggregate: jsAggregate,
    bitmapOp: jsBitmapOp,
    topK: jsTopK,
    dispose: () => {
      /* stateless */
    },
  };
}
