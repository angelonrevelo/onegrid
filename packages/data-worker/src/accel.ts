// =============================================================================
// Accelerated dispatch — @onegrid/data jobs on an AccelBackend
//
// @onegrid/wasm's `AccelBackend` is proven equivalent to @onegrid/data only
// under ITS missing-value model: a row is missing when its validity bit is
// clear OR its value is NaN. @onegrid/data has a different one — a NaN cell is
// present, and its numeric comparator scores `compare(NaN, x)` as 0. The two
// agree exactly on a column where every non-null cell is a non-NaN JS number,
// so that is the eligibility rule, checked per column:
//
//   - every non-null `get(i)` is `typeof 'number'` and not NaN
//     (no bigint, boolean, Date or string cells — @onegrid/data would coerce
//     those through `toNumeric`, the kernel never sees them)
//   - sort additionally requires a non-utf8 schema, because `sortIndex` picks
//     a string collator from the schema, not from the values
//   - a filter leaf additionally requires numeric, non-NaN operands
//
// Anything else — string operators, collation, custom aggregators, row
// filters, a NaN anywhere — runs the @onegrid/data function it always ran, per
// leaf or per job. Every result is byte-identical to the unaccelerated path;
// `__tests__/accel.test.ts` is the proof.
//
// Column conversion (`get(i)` → Float64Array + validity) is O(rows) and cached
// per (table, column). A ColumnTable is a snapshot; mutate the arrays behind
// it and the cache is stale, exactly as it would be for a sort permutation.
// =============================================================================

import {
  BitmapSelection,
  aggregate as dataAggregate,
  filterIndex,
  groupRows,
  sortIndex,
} from '@onegrid/data';
import type {
  ColumnTable,
  FilterOptions,
  GroupNode,
  GroupRowsOptions,
  SortOptions,
} from '@onegrid/data';
import type {
  Aggregation,
  AggregationModel,
  ComparisonFilter,
  FilterModel,
  FilterNode,
  GroupingModel,
  SortModel,
} from '@onegrid/protocol';
import type {
  AccelAggregateOp,
  AccelBackend,
  AccelColumn,
  AccelPredicate,
  AccelSortKey,
} from '@onegrid/wasm';

// -----------------------------------------------------------------------------
// Column eligibility + conversion
// -----------------------------------------------------------------------------

const columnCache = new WeakMap<ColumnTable, Map<string, AccelColumn | null>>();

function isNumber(v: unknown): v is number {
  return typeof v === 'number' && !Number.isNaN(v);
}

/** The column as the kernel sees it, or null when the kernel's model would diverge. */
function accelColumn(table: ColumnTable, columnId: string): AccelColumn | null {
  if (!table.hasColumn(columnId)) return null;
  let byId = columnCache.get(table);
  if (!byId) {
    byId = new Map();
    columnCache.set(table, byId);
  }
  const hit = byId.get(columnId);
  if (hit !== undefined) return hit;

  const column = table.column(columnId);
  const n = table.numRows;
  const value = new Float64Array(n);
  const validity = new Uint8Array((n + 7) >>> 3);
  let eligible = true;
  for (let i = 0; i < n; i++) {
    if (column.isNull(i)) continue;
    const v = column.get(i);
    if (!isNumber(v)) {
      eligible = false;
      break;
    }
    value[i] = v;
    validity[i >>> 3]! |= 1 << (i & 7);
  }
  const out: AccelColumn | null = eligible ? { value, validity } : null;
  byId.set(columnId, out);
  return out;
}

// -----------------------------------------------------------------------------
// sort
// -----------------------------------------------------------------------------

/**
 * `sortIndex`, on the kernel when every key is an eligible numeric column.
 * @public
 */
export function accelSortIndex(
  backend: AccelBackend,
  table: ColumnTable,
  sort: SortModel,
  options?: SortOptions,
): Int32Array {
  if (sort.length === 0) return sortIndex(table, sort, options);
  const key: AccelSortKey[] = [];
  for (const field of sort) {
    if (!table.hasColumn(field.columnId)) return sortIndex(table, sort, options);
    if (table.column(field.columnId).schema.type === 'utf8') return sortIndex(table, sort, options);
    const column = accelColumn(table, field.columnId);
    if (!column) return sortIndex(table, sort, options);
    key.push({
      ...column,
      descending: field.direction === 'desc',
      // @onegrid/data: nulls go last only when `nulls` is (or defaults to) 'last'.
      missingFirst: (field.nulls ?? 'last') !== 'last',
    });
  }
  return backend.sortIndex(key, table.numRows);
}

// -----------------------------------------------------------------------------
// filter
// -----------------------------------------------------------------------------

/** The kernel predicate for a leaf, or null when the leaf must stay on @onegrid/data. */
function accelPredicate(node: ComparisonFilter): AccelPredicate | null {
  const op = node.op;
  switch (op) {
    case 'isNull':
    case 'isNotNull':
      return { op };
    case 'in':
    case 'notIn': {
      const values = node.values ?? [];
      if (!values.every(isNumber)) return null;
      return { op, set: Float64Array.from(values) };
    }
    case 'between':
    case 'notBetween': {
      const [lo, hi] = node.values ?? [];
      if (!isNumber(lo) || !isNumber(hi)) return null;
      return { op, operand: lo, upper: hi };
    }
    case 'eq':
    case 'neq':
    case 'lt':
    case 'lte':
    case 'gt':
    case 'gte':
      return isNumber(node.value) ? { op, operand: node.value } : null;
    default:
      return null;
  }
}

/**
 * `filterIndex`, evaluating each eligible numeric leaf on the kernel and every
 * other leaf on @onegrid/data. The logical combinators mirror `filterIndex`.
 * @public
 */
export function accelFilterIndex(
  backend: AccelBackend,
  table: ColumnTable,
  filter: FilterModel,
  options: FilterOptions = {},
): BitmapSelection {
  if (filter === null) return new BitmapSelection(table.numRows, 'full');
  return evaluateNode(backend, table, filter, options);
}

function evaluateNode(
  backend: AccelBackend,
  table: ColumnTable,
  node: FilterNode,
  options: FilterOptions,
): BitmapSelection {
  if (node.type === 'comparison') {
    const predicate = accelPredicate(node);
    const column = predicate ? accelColumn(table, node.columnId) : null;
    if (!predicate || !column) return filterIndex(table, node, options);
    return BitmapSelection.fromBytes(table.numRows, backend.filterMask(column, predicate));
  }
  if (node.op === 'not') {
    const inner = node.filters[0];
    if (!inner) return new BitmapSelection(table.numRows, 'full');
    return evaluateNode(backend, table, inner, options).invert();
  }
  if (node.filters.length === 0) {
    return new BitmapSelection(table.numRows, node.op === 'and' ? 'full' : 'empty');
  }
  let result = evaluateNode(backend, table, node.filters[0]!, options);
  for (let i = 1; i < node.filters.length; i++) {
    const next = evaluateNode(backend, table, node.filters[i]!, options);
    result = node.op === 'and' ? result.intersect(next) : result.union(next);
  }
  return result;
}

// -----------------------------------------------------------------------------
// group
// -----------------------------------------------------------------------------

interface GroupLevel {
  /** Dense per-row code from the kernel. */
  readonly code: Int32Array;
  /** The value a code stands for, as `groupRows` would have keyed it. */
  readonly key: ReadonlyArray<unknown>;
}

function groupLevel(backend: AccelBackend, column: AccelColumn, n: number): GroupLevel {
  const { code, cardinality } = backend.groupKey([column], n);
  const key = new Array<unknown>(cardinality);
  const seen = new Uint8Array(cardinality);
  const validity = column.validity!;
  for (let i = 0; i < n; i++) {
    const c = code[i]!;
    if (seen[c] === 1) continue;
    seen[c] = 1;
    const present = ((validity[i >>> 3] ?? 0) & (1 << (i & 7))) !== 0;
    const v = column.value[i]!;
    // groupRows keys a Map by `get(i)`, and a Map stores a -0 key as +0.
    key[c] = present ? (v === 0 ? 0 : v) : null;
  }
  return { code, key };
}

/**
 * `groupRows`, bucketing each level by kernel group codes instead of a boxed
 * Map lookup per row. Aggregates still run on @onegrid/data.
 * @public
 */
export function accelGroupRows(
  backend: AccelBackend,
  table: ColumnTable,
  grouping: GroupingModel,
  options: GroupRowsOptions = {},
): GroupNode {
  if (options.rowFilter || grouping.columns.length === 0) return groupRows(table, grouping, options);
  const n = table.numRows;
  const level: GroupLevel[] = [];
  for (const columnId of grouping.columns) {
    if (!columnId) return groupRows(table, grouping, options);
    const column = accelColumn(table, columnId);
    if (!column) return groupRows(table, grouping, options);
    level.push(groupLevel(backend, column, n));
  }
  const index: number[] = [];
  for (let i = 0; i < n; i++) index.push(i);
  return buildNode(table, index, grouping.columns, level, 0, [], options.aggregations ?? []);
}

function buildNode(
  table: ColumnTable,
  rowIndices: number[],
  remainingColumns: ReadonlyArray<string>,
  level: ReadonlyArray<GroupLevel>,
  depth: number,
  path: ReadonlyArray<unknown>,
  aggregations: AggregationModel,
): GroupNode {
  if (remainingColumns.length === 0) {
    return {
      columnId: '',
      key: path[path.length - 1] ?? null,
      path,
      children: [],
      rowIndices,
      aggregates: computeAggregates(table, rowIndices, aggregations),
      rowCount: rowIndices.length,
    };
  }
  const [columnId, ...rest] = remainingColumns;
  const { code, key } = level[depth]!;
  const bucket = new Map<number, number[]>();
  for (const i of rowIndices) {
    const c = code[i]!;
    let member = bucket.get(c);
    if (!member) {
      member = [];
      bucket.set(c, member);
    }
    member.push(i);
  }
  const children = Array.from(bucket.entries())
    .map(([c, member]) =>
      buildNode(table, member, rest, level, depth + 1, [...path, key[c]], aggregations),
    )
    .sort((a, b) => compareKeys(a.key, b.key));
  return {
    columnId: columnId!,
    key: path[path.length - 1] ?? null,
    path,
    children,
    rowIndices: [],
    aggregates: computeAggregates(table, rowIndices, aggregations),
    rowCount: rowIndices.length,
  };
}

// Copied from group.ts on purpose: the equivalence contract is with THAT
// function, and the differential test catches a change to either copy.
function computeAggregates(
  table: ColumnTable,
  rowIndices: ReadonlyArray<number>,
  aggregations: AggregationModel,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const agg of aggregations) {
    const key = agg.alias ?? `${String(agg.fn)}_${agg.columnId}`;
    const column = ACCEL_AGGREGATE.has(agg.fn) ? accelColumn(table, agg.columnId) : null;
    out[key] = column
      ? columnAggregate(agg.fn as AccelAggregateOp, column, rowIndices)
      : dataAggregate(table, agg, rowIndices);
  }
  return out;
}

/**
 * The built-in reducers over an eligible column's typed arrays, for the
 * per-group aggregates. Not the kernel on purpose: a kernel call copies the
 * whole column in, and a group-by makes one call per group per aggregation —
 * measured at 1M rows × 64 groups, that marshalling made the kernel path SLOWER
 * than @onegrid/data. These loops visit rows in the same order and apply the
 * same comparisons as aggregate.ts, so every result, float sums included, is
 * bit-identical; what they drop is the generator and the boxed `get(i)`.
 */
function columnAggregate(op: AccelAggregateOp, column: AccelColumn, rowIndices: ReadonlyArray<number>): unknown {
  const value = column.value;
  const validity = column.validity!;
  const present = (i: number): boolean => ((validity[i >>> 3] ?? 0) & (1 << (i & 7))) !== 0;
  switch (op) {
    case 'sum': {
      let sum = 0;
      for (const i of rowIndices) if (present(i)) sum += value[i]!;
      return sum;
    }
    case 'avg': {
      let sum = 0;
      let n = 0;
      for (const i of rowIndices) {
        if (!present(i)) continue;
        sum += value[i]!;
        n += 1;
      }
      return n === 0 ? null : sum / n;
    }
    case 'count': {
      let n = 0;
      for (const i of rowIndices) if (present(i)) n += 1;
      return n;
    }
    case 'countDistinct': {
      const seen = new Set<number>();
      for (const i of rowIndices) if (present(i)) seen.add(value[i]!);
      return seen.size;
    }
    case 'min': {
      let acc: number | null = null;
      for (const i of rowIndices) {
        if (!present(i)) continue;
        const v = value[i]!;
        if (acc === null || v < acc) acc = v;
      }
      return acc;
    }
    case 'max': {
      let acc: number | null = null;
      for (const i of rowIndices) {
        if (!present(i)) continue;
        const v = value[i]!;
        if (acc === null || v > acc) acc = v;
      }
      return acc;
    }
    case 'first': {
      for (const i of rowIndices) if (present(i)) return value[i]!;
      return null;
    }
    case 'last': {
      let last: number | null = null;
      for (const i of rowIndices) if (present(i)) last = value[i]!;
      return last;
    }
  }
}

function compareKeys(a: unknown, b: unknown): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b));
}

// -----------------------------------------------------------------------------
// aggregate
// -----------------------------------------------------------------------------

const ACCEL_AGGREGATE: ReadonlySet<string> = new Set<AccelAggregateOp>([
  'sum',
  'avg',
  'count',
  'countDistinct',
  'min',
  'max',
  'first',
  'last',
]);

/**
 * `aggregate`, on the kernel for the eight built-in reducers over an eligible
 * column. Custom aggregators and out-of-range row indices stay on @onegrid/data.
 * @public
 */
export function accelAggregate(
  backend: AccelBackend,
  table: ColumnTable,
  aggregation: Aggregation,
  rowIndex: ReadonlyArray<number> | Int32Array | null = null,
): unknown {
  if (!ACCEL_AGGREGATE.has(aggregation.fn)) return dataAggregate(table, aggregation, rowIndex);
  const column = accelColumn(table, aggregation.columnId);
  if (!column) return dataAggregate(table, aggregation, rowIndex);
  let index: Int32Array | null = null;
  if (rowIndex !== null) {
    index = new Int32Array(rowIndex.length);
    for (let k = 0; k < rowIndex.length; k++) {
      const r = rowIndex[k]!;
      // @onegrid/data skips an out-of-range index as null; a kernel would read
      // out of bounds. Refuse rather than reinterpret.
      if (!Number.isInteger(r) || r < 0 || r >= table.numRows) {
        return dataAggregate(table, aggregation, rowIndex);
      }
      index[k] = r;
    }
  }
  return backend.aggregate(aggregation.fn as AccelAggregateOp, column, index);
}
