// =============================================================================
// pivot
//
// Pivot a ColumnTable along one or more "column" dimensions: distinct
// combinations of values in those columns become new output columns,
// each holding an aggregate of the requested measure(s) for the rows
// that match the (rowGroup × pivotKey) bucket.
//
//   pivot(table, {
//     rows: ['region'],
//     columns: ['status'],
//     measures: [{ fn: 'sum', columnId: 'revenue' }]
//   })
//
// produces a ColumnTable shaped like:
//
//   region   sum_revenue_active   sum_revenue_churned   ...
//   EMEA     1234.56              78.90                 ...
//   NA       ...                  ...                   ...
//
// The result is a fully-materialized ColumnTable (typed-array backed
// where the measure type permits) so it slots into the existing
// renderer + sort/filter pipeline with no special-casing.
// =============================================================================

import type { Aggregation, AggregationType, PivotModel } from '@onegrid/protocol';
import { createColumnTable, type ColumnInput, type ColumnTable } from './column-table';

export interface PivotedTable {
  /** Materialized output table, ready to feed a Grid. */
  readonly table: ColumnTable;
  /** Row-group column ids in display order (always come first). */
  readonly rowColumns: ReadonlyArray<string>;
  /** Synthetic measure columns produced by pivoting, in display order.
   *  Each entry tracks its source pivot-key path so callers can render
   *  multi-level column headers if they want. */
  readonly pivotColumns: ReadonlyArray<{
    readonly id: string;
    readonly pivotPath: ReadonlyArray<unknown>;
    readonly measure: Aggregation;
  }>;
}

export function pivot(table: ColumnTable, model: PivotModel): PivotedTable {
  const rowCols = model.rows;
  const pivotCols = model.columns;
  const measures = model.measures;
  const numRows = table.numRows;

  // Pre-resolve column readers for hot-path dispatch.
  const rowReaders = rowCols.map((id) => table.column(id));
  const pivotReaders = pivotCols.map((id) => table.column(id));
  const measureReaders = measures.map((m) => table.column(m.columnId));

  // Two passes:
  //   1. Discover distinct row-keys + pivot-keys, bucketing measure values.
  //   2. Materialize the output ColumnTable from the buckets.
  type Bucket = {
    nums: number[];
    nonNums: unknown[];
  };
  const rowKeyOrder: string[] = [];
  const rowKeyValues = new Map<string, ReadonlyArray<unknown>>();
  const pivotKeyOrder: string[] = [];
  const pivotKeyValues = new Map<string, ReadonlyArray<unknown>>();
  // bucketsByRowKey.get(rowKey).get(pivotKey)[measureIdx] = Bucket
  const bucketsByRowKey = new Map<string, Map<string, Bucket[]>>();

  for (let i = 0; i < numRows; i++) {
    const rowVals = rowReaders.map((r) => r.get(i));
    const pivotVals = pivotReaders.map((r) => r.get(i));
    const rowKey = encodeKey(rowVals);
    const pivotKey = encodeKey(pivotVals);

    if (!rowKeyValues.has(rowKey)) {
      rowKeyValues.set(rowKey, rowVals);
      rowKeyOrder.push(rowKey);
    }
    if (!pivotKeyValues.has(pivotKey)) {
      pivotKeyValues.set(pivotKey, pivotVals);
      pivotKeyOrder.push(pivotKey);
    }

    let perPivot = bucketsByRowKey.get(rowKey);
    if (!perPivot) {
      perPivot = new Map();
      bucketsByRowKey.set(rowKey, perPivot);
    }
    let buckets = perPivot.get(pivotKey);
    if (!buckets) {
      buckets = measures.map((): Bucket => ({ nums: [], nonNums: [] }));
      perPivot.set(pivotKey, buckets);
    }

    for (let m = 0; m < measures.length; m++) {
      const v = measureReaders[m]!.get(i);
      if (typeof v === 'number') {
        buckets[m]!.nums.push(v);
      } else if (v !== null && v !== undefined) {
        const n = Number(v);
        if (Number.isFinite(n)) buckets[m]!.nums.push(n);
        else buckets[m]!.nonNums.push(v);
      }
    }
  }

  // Sort keys for deterministic output. Numeric keys sort numeric, others
  // collate as strings.
  rowKeyOrder.sort((a, b) =>
    compareKeyTuples(rowKeyValues.get(a)!, rowKeyValues.get(b)!),
  );
  pivotKeyOrder.sort((a, b) =>
    compareKeyTuples(pivotKeyValues.get(a)!, pivotKeyValues.get(b)!),
  );

  const outRows = rowKeyOrder.length;
  const inputs: ColumnInput[] = [];

  // Row-group columns: just project each row-key tuple element back out.
  for (let r = 0; r < rowCols.length; r++) {
    const data = new Array<unknown>(outRows);
    for (let i = 0; i < outRows; i++) {
      data[i] = rowKeyValues.get(rowKeyOrder[i]!)![r] ?? null;
    }
    const reader = rowReaders[r]!;
    inputs.push({ schema: { id: rowCols[r]!, type: reader.schema.type }, data });
  }

  // Synthetic pivot columns: one per (pivotKey × measure) combination.
  const pivotColumns: Array<{
    id: string;
    pivotPath: ReadonlyArray<unknown>;
    measure: Aggregation;
  }> = [];
  for (const pivotKey of pivotKeyOrder) {
    const pivotPath = pivotKeyValues.get(pivotKey) ?? [];
    for (let m = 0; m < measures.length; m++) {
      const measure = measures[m]!;
      const id = pivotColumnId(pivotPath, measure);
      const data = new Float64Array(outRows);
      for (let i = 0; i < outRows; i++) {
        const buckets = bucketsByRowKey.get(rowKeyOrder[i]!)?.get(pivotKey);
        const bucket = buckets?.[m];
        data[i] = bucket ? aggregateBucket(measure.fn, bucket) : NaN;
      }
      inputs.push({ schema: { id, type: 'float64' }, data });
      pivotColumns.push({ id, pivotPath, measure });
    }
  }

  return {
    table: createColumnTable(inputs),
    rowColumns: rowCols,
    pivotColumns,
  };
}

function pivotColumnId(
  pivotPath: ReadonlyArray<unknown>,
  measure: Aggregation,
): string {
  const path = pivotPath.map((p) => (p === null || p === undefined ? '∅' : String(p))).join('|');
  const alias = measure.alias ?? `${String(measure.fn)}_${measure.columnId}`;
  return `${alias}__${path}`;
}

function aggregateBucket(
  fn: AggregationType | (string & {}),
  bucket: { nums: number[]; nonNums: unknown[] },
): number {
  const ns = bucket.nums;
  if (fn === 'count') return ns.length + bucket.nonNums.length;
  if (ns.length === 0) return NaN;
  switch (fn) {
    case 'sum': {
      let s = 0;
      for (const n of ns) s += n;
      return s;
    }
    case 'avg': {
      let s = 0;
      for (const n of ns) s += n;
      return s / ns.length;
    }
    case 'min': {
      let m = ns[0]!;
      for (const n of ns) if (n < m) m = n;
      return m;
    }
    case 'max': {
      let m = ns[0]!;
      for (const n of ns) if (n > m) m = n;
      return m;
    }
    default:
      // Unknown aggregator → fall back to count so the cell is still
      // populated rather than silently NaN.
      return ns.length + bucket.nonNums.length;
  }
}

function encodeKey(values: ReadonlyArray<unknown>): string {
  return values.map((v) => (v === null || v === undefined ? '\u0001' : String(v))).join('\u0000');
}

function compareKeyTuples(a: ReadonlyArray<unknown>, b: ReadonlyArray<unknown>): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const av = a[i];
    const bv = b[i];
    if (av === bv) continue;
    if (av === null || av === undefined) return 1;
    if (bv === null || bv === undefined) return -1;
    if (typeof av === 'number' && typeof bv === 'number') return av - bv;
    return String(av).localeCompare(String(bv));
  }
  return a.length - b.length;
}
