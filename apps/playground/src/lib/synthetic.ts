/**
 * Synthetic dataset generator. Two flavors:
 *
 *   generateSynthetic(numRows)       — lazy: getCell returns rowIndex,
 *                                      column.format derives cell content
 *                                      from the index. Allocation-free at
 *                                      any size — best for pure render
 *                                      benchmarks at 1M+ rows.
 *
 *   materializeSynthetic(numRows)    — eager: builds typed-array columns
 *                                      and a ColumnTable so @onegrid/data's
 *                                      sortIndex / filterIndex / aggregate
 *                                      can operate on it. Memory cost:
 *                                      ~50 bytes/row (≈ 50 MB at 1M rows).
 *
 *   buildMemoryView(table, sort, filter)
 *                                    — applies sort + filter to a
 *                                      ColumnTable and returns a permutation-
 *                                      backed RowSource. The renderer reads
 *                                      cells through it as if the data were
 *                                      pre-sorted; no data is copied.
 *
 * Deterministic, seeded by row index so output is reproducible across
 * benchmark runs.
 */

import {
  createColumnTable,
  filterIndex,
  filterIndexed,
  sortIndex,
  type TableIndex,
  type ColumnInput,
  type ColumnTable,
} from '@onegrid/data';
import { createSelectEditor } from '@onegrid/core';
import type { ColumnDef, FilterModel, RowSource, SortModel } from '@onegrid/react';

export interface SyntheticDataset {
  readonly columns: ReadonlyArray<ColumnDef>;
  readonly rowSource: RowSource;
  /** Per-row heights, or one uniform height for datasets past VARIABLE_HEIGHT_LIMIT. */
  readonly heights: Float32Array | number;
}

export interface MaterializedSyntheticDataset extends SyntheticDataset {
  readonly table: ColumnTable;
  /** Mutate a cell in place. Coerces the raw string to the column's
   *  typed-array type (number columns parse, string columns store as-is).
   *  Returns false when the value can't be coerced. */
  readonly writeCell: (sourceRow: number, columnId: string, raw: string) => boolean;
}

const FIRST_NAMES = [
  'Aiko', 'Bashir', 'Camila', 'Dmitri', 'Elena', 'Farhan', 'Gabriela', 'Hideki',
  'Imani', 'Jin', 'Kalani', 'Lior', 'Maya', 'Nadir', 'Olamide', 'Priya',
  'Quentin', 'Ravi', 'Saskia', 'Tomás', 'Uma', 'Viktor', 'Wren', 'Xiomara',
  'Yara', 'Zane',
];

const LAST_NAMES = [
  'Adeyemi', 'Bukowski', 'Chen', 'Dvorak', 'Eriksen', 'Fitzgerald', 'Garibay',
  'Halevi', 'Ivanova', 'Jónsson', 'Kapur', 'Lindqvist', 'Mokoena', 'Nakamura',
  'Okonkwo', 'Petrov', 'Quesada', 'Rinaldi', 'Saito', 'Tahir', 'Ueda', 'Vargas',
  'Watanabe', 'Xu', 'Yusuf', 'Zografos',
];

const STATUSES = ['active', 'pending', 'archived', 'pilot', 'churned'] as const;

const STATUS_COLORS: Record<(typeof STATUSES)[number], string> = {
  active: '#62d68a',
  pending: '#f4c768',
  archived: '#7f8893',
  pilot: '#6ea8fe',
  churned: '#e56f6f',
};

/** Row counts above this get a uniform height instead of a per-row array. */
export const VARIABLE_HEIGHT_LIMIT = 10_000_000;
const UNIFORM_ROW_HEIGHT = 28;

function makeHeights(numRows: number): Float32Array {
  const heights = new Float32Array(numRows);
  // 30% tall, 70% short — exercises FenwickHeights' variable-height path.
  for (let i = 0; i < numRows; i++) heights[i] = i % 10 < 3 ? 40 : 24;
  return heights;
}

/**
 * Lazy synthetic dataset — column.format derives display from the row index.
 * Use this when you only need rendering performance (no sort/filter).
 */
export function generateSynthetic(numRows: number): SyntheticDataset {
  // Past VARIABLE_HEIGHT_LIMIT a per-row height array is itself the cost being
  // measured (4 GB of Float32 at 1B rows before the grid adds its own), so the
  // big datasets use one uniform height — the path the grid stores sparsely.
  const heights = numRows > VARIABLE_HEIGHT_LIMIT ? UNIFORM_ROW_HEIGHT : makeHeights(numRows);
  const columns: ReadonlyArray<ColumnDef> = [
    {
      id: 'rowIndex',
      width: 80,
      displayName: '#',
      format: (_v, i) => (i + 1).toString(),
      color: () => '#8b929c',
    },
    {
      id: 'firstName',
      width: 130,
      displayName: 'First name',
      format: (_v, i) => FIRST_NAMES[i % FIRST_NAMES.length] ?? '',
    },
    {
      id: 'lastName',
      width: 150,
      displayName: 'Last name',
      format: (_v, i) => LAST_NAMES[(i * 17) % LAST_NAMES.length] ?? '',
    },
    {
      id: 'revenue',
      width: 130,
      displayName: 'Revenue',
      format: (_v, i) => {
        const v = ((i * 1009) % 1_000_000) / 100;
        return `$${v.toFixed(2)}`;
      },
    },
    {
      id: 'status',
      width: 110,
      displayName: 'Status',
      format: (_v, i) => STATUSES[i % STATUSES.length] ?? 'active',
      color: (_v, i) => STATUS_COLORS[STATUSES[i % STATUSES.length] ?? 'active'],
    },
    {
      id: 'score',
      width: 90,
      displayName: 'Score',
      format: (_v, i) => ((i * 31) % 100).toString(),
    },
    {
      id: 'updatedAt',
      width: 170,
      displayName: 'Updated',
      format: (_v, i) => {
        const t = 1_700_000_000_000 + i * 60_000;
        return new Date(t).toISOString().slice(0, 16).replace('T', ' ');
      },
    },
  ];

  const rowSource: RowSource = {
    numRows,
    getCell: (rowIndex) => rowIndex,
  };

  return { columns, rowSource, heights };
}

/**
 * Eager synthetic dataset — typed-array columns + a ColumnTable so
 * @onegrid/data ops (sortIndex, filterIndex, aggregate) can run.
 *
 * Memory cost: ~50 bytes per row. 1M rows ≈ 50 MB. Avoid at 10M unless
 * you really need sort/filter — use generateSynthetic instead for
 * pure render benchmarks at that scale.
 */
export function materializeSynthetic(numRows: number): MaterializedSyntheticDataset {
  const heights = makeHeights(numRows);

  const rowIndexCol = new Int32Array(numRows);
  const firstNameCol: string[] = new Array(numRows);
  const lastNameCol: string[] = new Array(numRows);
  const revenueCol = new Float64Array(numRows);
  const statusCol: string[] = new Array(numRows);
  const scoreCol = new Int32Array(numRows);
  const updatedAtCol: string[] = new Array(numRows);

  for (let i = 0; i < numRows; i++) {
    rowIndexCol[i] = i;
    firstNameCol[i] = FIRST_NAMES[i % FIRST_NAMES.length] ?? '';
    lastNameCol[i] = LAST_NAMES[(i * 17) % LAST_NAMES.length] ?? '';
    revenueCol[i] = ((i * 1009) % 1_000_000) / 100;
    statusCol[i] = STATUSES[i % STATUSES.length] ?? 'active';
    scoreCol[i] = (i * 31) % 100;
    const t = 1_700_000_000_000 + i * 60_000;
    updatedAtCol[i] = new Date(t).toISOString().slice(0, 16).replace('T', ' ');
  }

  const columnInputs: ColumnInput[] = [
    { schema: { id: 'rowIndex', type: 'int32' }, data: rowIndexCol },
    { schema: { id: 'firstName', type: 'utf8' }, data: firstNameCol },
    { schema: { id: 'lastName', type: 'utf8' }, data: lastNameCol },
    { schema: { id: 'revenue', type: 'float64' }, data: revenueCol },
    { schema: { id: 'status', type: 'utf8' }, data: statusCol },
    { schema: { id: 'score', type: 'int32' }, data: scoreCol },
    { schema: { id: 'updatedAt', type: 'utf8' }, data: updatedAtCol },
  ];

  const table = createColumnTable(columnInputs);

  // Visual columns read raw values out of the typed arrays — formatters
  // operate on the cell value, not the row index. This is what lets sort
  // and filter "actually work" visually: when the renderer asks for
  // visual row 0, we hand back source row N's value through a permutation.
  const columns: ReadonlyArray<ColumnDef> = [
    {
      id: 'rowIndex',
      width: 80,
      displayName: '#',
      // Show VISUAL row position (1-based), not the source-row index
      // stored in rowIndexCol. The source index is still queryable
      // through the materialized table (rowIndexCol[sourceRow] = i)
      // but the # column tracks the user's visible position so it
      // ascends as you scroll and matches the visible-row meter.
      format: (_v, i) => (i + 1).toString(),
      color: () => '#8b929c',
    },
    {
      id: 'firstName',
      width: 130,
      displayName: 'First name',
      format: (v) => String(v ?? ''),
    },
    {
      id: 'lastName',
      width: 150,
      displayName: 'Last name',
      format: (v) => String(v ?? ''),
    },
    {
      id: 'revenue',
      width: 130,
      displayName: 'Revenue',
      format: (v) => (typeof v === 'number' ? `$${v.toFixed(2)}` : ''),
      // Sync validator: revenue must parse as a finite non-negative number.
      validate: (raw) => {
        const trimmed = raw.trim().replace(/^\$/, '');
        const n = Number(trimmed);
        if (!Number.isFinite(n)) return { ok: false, message: 'Revenue must be a number' };
        if (n < 0) return { ok: false, message: 'Revenue cannot be negative' };
        return { ok: true };
      },
    },
    {
      id: 'status',
      width: 110,
      displayName: 'Status',
      format: (v) => String(v ?? ''),
      color: (v) =>
        typeof v === 'string' ? STATUS_COLORS[v as (typeof STATUSES)[number]] : undefined,
      // Sync validator: status must be one of the known set.
      validate: (raw) => {
        const v = raw.trim();
        if (!STATUSES.includes(v as (typeof STATUSES)[number])) {
          return { ok: false, message: `Status must be one of: ${STATUSES.join(', ')}` };
        }
        return { ok: true };
      },
      // Use a <select> dropdown instead of free-form text — the
      // validator's job becomes redundant, but it stays as a defense
      // against external setRowSource pushing invalid values.
      editor: createSelectEditor({
        id: 'status-dropdown',
        options: STATUSES.map((s) => ({ value: s, label: s })),
      }),
    },
    {
      id: 'score',
      width: 110,
      displayName: 'Score',
      format: (v) => String(v ?? ''),
      validate: (raw) => {
        const n = Number(raw.trim());
        if (!Number.isInteger(n)) return { ok: false, message: 'Score must be an integer' };
        if (n < 0 || n > 100) return { ok: false, message: 'Score must be 0–100' };
        return { ok: true };
      },
      // Custom DOM renderer: a horizontal progress bar with the value
      // overlaid as text. Demonstrates the pool / overlay mechanism —
      // only on-screen rows have DOM nodes; everything else paints to
      // the canvas. Pool size stays bounded by viewport height, not
      // dataset size.
      renderer: {
        id: 'score-bar',
        mount: () => {
          const root = document.createElement('div');
          root.style.cssText =
            'box-sizing:border-box;padding:6px 10px;display:flex;align-items:center;' +
            'gap:8px;font-family:ui-sans-serif,system-ui,sans-serif;font-size:12px;' +
            'color:#e7e9ec;';

          const track = document.createElement('div');
          track.className = 'score-track';
          track.style.cssText =
            'flex:1;height:8px;background:#1c2027;border-radius:4px;overflow:hidden;';

          const fill = document.createElement('div');
          fill.className = 'score-fill';
          fill.style.cssText = 'height:100%;background:#62d68a;transition:none;';
          track.appendChild(fill);

          const label = document.createElement('span');
          label.className = 'score-label';
          label.style.cssText = 'min-width:24px;text-align:right;color:#a5b1c2;';

          root.appendChild(track);
          root.appendChild(label);
          return root;
        },
        update: (el, ctx) => {
          const n = Number(ctx.value);
          const pct = Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 0;
          const fill = el.querySelector('.score-fill') as HTMLElement;
          const label = el.querySelector('.score-label') as HTMLElement;
          fill.style.width = `${String(pct)}%`;
          // Color drifts from green → yellow → red as score drops.
          fill.style.background = pct >= 70 ? '#62d68a' : pct >= 40 ? '#f4c768' : '#e56f6f';
          label.textContent = String(Math.round(pct));
        },
      },
    },
    {
      id: 'updatedAt',
      width: 170,
      displayName: 'Updated',
      format: (v) => String(v ?? ''),
      // Hover tooltip: show the full timestamp + the row index it
      // belongs to. Demonstrates the WCAG 1.4.13 hover-tooltip path.
      tooltip: (v, rowIndex) => {
        if (v === null || v === undefined) return null;
        return `Row ${String(rowIndex + 1)} · last updated ${String(v)}`;
      },
    },
  ];

  const rowSource: RowSource = {
    numRows,
    getCell: (rowIndex, columnId) => table.column(columnId).get(rowIndex),
  };

  // Map columnId → the underlying mutable backing array. The ColumnTable
  // wraps these via a closure but reads through on every get(), so writing
  // here is reflected on the next render.
  const writeBack: Record<string, (sourceRow: number, raw: string) => boolean> = {
    rowIndex: (i, raw) => {
      const n = Number(raw);
      if (!Number.isFinite(n)) return false;
      rowIndexCol[i] = n | 0;
      return true;
    },
    firstName: (i, raw) => {
      firstNameCol[i] = raw;
      return true;
    },
    lastName: (i, raw) => {
      lastNameCol[i] = raw;
      return true;
    },
    revenue: (i, raw) => {
      const n = Number(raw.replace(/^\$/, ''));
      if (!Number.isFinite(n)) return false;
      revenueCol[i] = n;
      return true;
    },
    status: (i, raw) => {
      statusCol[i] = raw;
      return true;
    },
    score: (i, raw) => {
      const n = Number(raw);
      if (!Number.isFinite(n)) return false;
      scoreCol[i] = n | 0;
      return true;
    },
    updatedAt: (i, raw) => {
      updatedAtCol[i] = raw;
      return true;
    },
  };

  const writeCell = (sourceRow: number, columnId: string, raw: string): boolean => {
    if (sourceRow < 0 || sourceRow >= numRows) return false;
    const fn = writeBack[columnId];
    if (!fn) return false;
    const ok = fn(sourceRow, raw);
    if (ok && columnId !== 'updatedAt') {
      updatedAtCol[sourceRow] = new Date().toISOString().slice(0, 16).replace('T', ' ');
    }
    return ok;
  };

  return { columns, rowSource, heights, table, writeCell };
}

// The sort permutation depends only on (table, sort), but buildMemoryView
// runs on every filter keystroke — so without this, typing into the quick
// filter re-sorted a million rows per character (~1s each at 1M).
const sortCache = new WeakMap<ColumnTable, { key: string; perm: Int32Array }>();

function cachedSortIndex(table: ColumnTable, sort: SortModel): Int32Array {
  const key = JSON.stringify(sort);
  const hit = sortCache.get(table);
  if (hit && hit.key === key) return hit.perm;
  const perm = sortIndex(table, sort);
  sortCache.set(table, { key, perm });
  return perm;
}

export interface MemoryView {
  readonly numRows: number;
  readonly rowSource: RowSource;
  /** Source-row indices in visual order. null = identity (no permutation). */
  readonly permutation: Int32Array | null;
}

/**
 * Apply sort + filter to a ColumnTable and return a permutation-backed
 * RowSource. The renderer sees `numRows` reduced when filter narrows; the
 * permutation maps visual rows to source rows in O(1) per cell read.
 *
 * Performance:
 *   - filterIndex: O(rows × filter_complexity)
 *   - sortIndex:   O(n log n) with one Intl.Collator instance for utf8
 *
 * 1M rows: filter typically <300ms, sort 400-600ms on M-class hardware
 * (single-threaded; can move to a Web Worker if it becomes interactive
 * blocker — that's v0.0.5 work).
 */
export function buildMemoryView(
  table: ColumnTable,
  sort: SortModel,
  filter: FilterModel,
  tableIndex?: TableIndex,
): MemoryView {
  let perm: Int32Array | null = null;

  // Defensive: drop sort entries that reference columns absent from
  // this table. Happens when the user switches modes (e.g. tree → memory)
  // and the prior sort state carries a column id ("name") that doesn't
  // exist in the new mode. Without this guard, sortIndex throws and
  // takes down the whole React tree on mode switch.
  const safeSort: SortModel = sort.filter((f) => table.hasColumn(f.columnId));

  if (filter !== null) {
    // With a TableIndex the filter costs one predicate call per DISTINCT
    // value rather than per row — the quick-filter box stops rescanning
    // a million strings on every keystroke.
    const sel = tableIndex ? filterIndexed(tableIndex, filter) : filterIndex(table, filter);
    if (safeSort.length > 0) {
      const fullPerm = cachedSortIndex(table, safeSort);
      const out = new Int32Array(sel.cardinality);
      let j = 0;
      for (let i = 0; i < fullPerm.length; i++) {
        const srcIdx = fullPerm[i] ?? 0;
        if (sel.contains(srcIdx)) out[j++] = srcIdx;
      }
      perm = out.subarray(0, j);
    } else {
      perm = sel.toIndices();
    }
  } else if (safeSort.length > 0) {
    perm = cachedSortIndex(table, safeSort);
  }

  if (perm === null) {
    return {
      numRows: table.numRows,
      rowSource: {
        numRows: table.numRows,
        getCell: (rowIndex, columnId) => table.column(columnId).get(rowIndex),
      },
      permutation: null,
    };
  }

  const finalPerm = perm;
  return {
    numRows: finalPerm.length,
    rowSource: {
      numRows: finalPerm.length,
      getCell: (visualRow, columnId) => {
        const srcIdx = finalPerm[visualRow] ?? 0;
        return table.column(columnId).get(srcIdx);
      },
    },
    permutation: finalPerm,
  };
}
