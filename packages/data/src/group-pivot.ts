// =============================================================================
// groupPivot — recursive row grouping whose LEAF level carries pivot columns
//
// `group.ts` builds a row hierarchy. `pivot.ts` turns distinct values into
// synthetic columns. Neither composes with the other, and the combination is
// what a financial or analytics grid actually asks for: "revenue by region ▸
// country ▸ city, split into columns by quarter and channel, with a subtotal
// on every level and a grand total at the bottom."
//
// Three decisions drive this file.
//
// 1. The output is a plain ColumnTable. That is the same architectural
//    constraint `pivot.ts` honours, and for the same reason: the renderer,
//    the sort path and the filter path all read `table.column(id).get(row)`.
//    If a pivoted result needed a bespoke row model, every one of those paths
//    would need a second code path. Materializing to a ColumnTable means the
//    pivot is invisible below the API surface. The hierarchy that a plain
//    table cannot express — depth, expand/collapse, which rows are subtotals
//    — travels alongside in `row`/`tree` rather than inside the table.
//
// 2. Pivot keys are discovered GLOBALLY, once, across every row that survives
//    the filter — not per group. A group with no rows for a given pivot key
//    still gets that key's columns, holding null. Discovering keys per group
//    would give different groups different column sets, and the columns would
//    misalign the moment a group is sparse. Sparse means null, never absent.
//
// 3. Subtotals roll up through an accumulator, not through the child cells.
//    Averaging a column of averages is the classic wrong answer; here `avg`
//    is read back as `sum / count` from a merged accumulator, so a parent's
//    average is the average of its ROWS regardless of how unevenly they are
//    distributed across children. Aggregations that genuinely cannot be
//    merged from a fixed-size accumulator — countDistinct, first, last, any
//    custom aggregator — are recomputed from the underlying rows (exact), or,
//    when the adopter would rather pay nothing for it, reported as
//    unavailable via `option.nonDecomposableRollup: 'unavailable'` and left
//    null above the leaf level. Silently averaging averages is not on the
//    menu.
// =============================================================================

import type { Aggregation, AggregationType, ColumnType } from '@onegrid/protocol';
import { aggregate as runAggregate } from './aggregate';
import { createColumnTable, type ColumnInput, type ColumnTable } from './column-table';
import { pathKey } from './group';
import { flattenTree, type FlatTreeEntry, type TreeNode } from './tree';

/**
 * How a subtotal is produced for an aggregation that cannot be merged from a
 * fixed-size accumulator (countDistinct, first, last, custom aggregators).
 *
 * - `'recompute'` — re-run the aggregator over every source row beneath the
 *   node. Exact, and costs one pass per subtotal cell.
 * - `'unavailable'` — leave the cell null above the leaf level and list the
 *   affected column ids in `GroupPivotResult.unavailableColumn`. Nothing is
 *   guessed and nothing is wrong; the value is simply declared absent.
 */
export type NonDecomposableRollup = 'recompute' | 'unavailable';

export interface GroupPivotOption {
  /** Subset of source rows to include. Defaults to every row. */
  readonly rowFilter?: (rowIndex: number) => boolean;
  /** Emit a grand-total row covering every included row. Default true. */
  readonly grandTotal?: boolean;
  /** Label carried on the grand-total row's meta. Default `'Total'`. */
  readonly grandTotalLabel?: string;
  /** Subtotal strategy for non-decomposable aggregations. Default `'recompute'`. */
  readonly nonDecomposableRollup?: NonDecomposableRollup;
}

export interface GroupPivotInput {
  readonly table: ColumnTable;
  /** Row-grouping columns, outer → inner. At least one. */
  readonly groupBy: ReadonlyArray<string>;
  /** Pivot-key columns, outer → inner. May be empty (one column per measure). */
  readonly pivotBy: ReadonlyArray<string>;
  /** Measures materialized once per pivot key. At least one. */
  readonly measure: ReadonlyArray<Aggregation>;
  readonly option?: GroupPivotOption;
}

/** One materialized measure column in the output table. */
export interface PivotColumnLeaf {
  readonly id: string;
  /** Pivot-key values that produced this column, outer → inner. */
  readonly pivotPath: ReadonlyArray<unknown>;
  readonly measure: Aggregation;
  /** False when subtotals for this column need a recompute (or are unavailable). */
  readonly decomposable: boolean;
}

/**
 * A node in the pivot COLUMN header tree. Interior nodes correspond to a
 * pivot-key value at some depth and render as a spanning header cell of width
 * `leafCount`; leaves correspond to an actual output column and carry
 * `leafId` + `measure`.
 */
export interface PivotColumnNode {
  /** Pivot-by column id at this depth. Empty string on measure leaves. */
  readonly columnId: string;
  /** Pivot-key value at this depth; the measure alias on measure leaves. */
  readonly key: unknown;
  readonly path: ReadonlyArray<unknown>;
  readonly depth: number;
  readonly child: ReadonlyArray<PivotColumnNode>;
  /** Output column id — non-null exactly on measure leaves. */
  readonly leafId: string | null;
  /** The measure — non-null exactly on measure leaves. */
  readonly measure: Aggregation | null;
  /** Number of output columns beneath this node; the header cell's colspan. */
  readonly leafCount: number;
}

/** Per-output-row descriptor. Index-parallel to the rows of `GroupPivotResult.table`. */
export interface GroupPivotRow {
  readonly kind: 'group' | 'grandTotal';
  /** Stable id — `pathKey(path)` for groups, `'\u0002total'` for the grand total. */
  readonly id: string;
  readonly path: ReadonlyArray<unknown>;
  /** 0 for the outermost grouping level. The grand total reports -1. */
  readonly depth: number;
  /** Grouping column id at this depth. Empty on the grand total. */
  readonly columnId: string;
  /** Group key at this depth, or the grand-total label. */
  readonly key: unknown;
  /** Index of this row in `GroupPivotResult.table`. */
  readonly rowIndex: number;
  /** Source rows beneath this node. */
  readonly rowCount: number;
  /** True when this node holds source rows directly (innermost grouping level). */
  readonly isLeafLevel: boolean;
}

export interface GroupPivotResult {
  /** Materialized output: group columns first, then one column per pivot leaf. */
  readonly table: ColumnTable;
  /** Group-by column ids, in output order. */
  readonly groupColumn: ReadonlyArray<string>;
  /** Measure columns, in output order (they follow the group columns). */
  readonly pivotColumn: ReadonlyArray<PivotColumnLeaf>;
  /** Hierarchical column headers for the header band. */
  readonly columnTree: ReadonlyArray<PivotColumnNode>;
  /** Row hierarchy in the shape `flattenTree` consumes. */
  readonly tree: ReadonlyArray<TreeNode<GroupPivotRow>>;
  /** Row descriptors, index-parallel to `table`. */
  readonly row: ReadonlyArray<GroupPivotRow>;
  /** Column ids whose subtotals are null because they cannot be rolled up
   *  and `nonDecomposableRollup` is `'unavailable'`. Empty otherwise. */
  readonly unavailableColumn: ReadonlyArray<string>;
}

/**
 * Aggregations whose subtotal can be read back exactly from a fixed-size
 * accumulator. `avg` qualifies because the accumulator keeps sum AND count
 * separately — that is the whole reason it is on this list.
 */
const DECOMPOSABLE: ReadonlySet<string> = new Set<AggregationType>([
  'sum',
  'avg',
  'count',
  'min',
  'max',
]);

interface MeasureAcc {
  /** Non-null value count. Also the divisor for `avg`. */
  count: number;
  sum: number;
  min: unknown;
  max: unknown;
}

interface GroupNodeState {
  columnId: string;
  key: unknown;
  path: unknown[];
  child: GroupNodeState[];
  rowIndex: number[];
  /** Source rows bucketed by encoded pivot key. Present on leaf-level nodes
   *  always, on interior nodes only when a recompute needs them. */
  byPivot: Map<string, number[]> | null;
  /** Encoded pivot key → per-measure accumulator (decomposable measures only). */
  acc: Map<string, MeasureAcc[]>;
}

export function groupPivot(input: GroupPivotInput): GroupPivotResult {
  const { table, groupBy, pivotBy, measure } = input;
  const option = input.option ?? {};
  if (groupBy.length === 0) {
    throw new Error('groupPivot: groupBy requires at least one column.');
  }
  if (measure.length === 0) {
    throw new Error('groupPivot: measure requires at least one aggregation.');
  }
  for (const id of [...groupBy, ...pivotBy]) {
    if (!table.hasColumn(id)) {
      throw new Error(`groupPivot: unknown column "${id}".`);
    }
  }

  const wantGrandTotal = option.grandTotal ?? true;
  const rollup: NonDecomposableRollup = option.nonDecomposableRollup ?? 'recompute';
  const grandTotalLabel = option.grandTotalLabel ?? 'Total';

  const decomposable = measure.map((m) => DECOMPOSABLE.has(String(m.fn)));
  const hasNonDecomposable = decomposable.some((d) => !d);
  // Interior nodes only need the per-pivot row lists when something has to be
  // recomputed from raw rows up there. Skipping them keeps memory at O(n) for
  // the common all-decomposable case instead of O(n × depth).
  const needInteriorRowList = hasNonDecomposable && rollup === 'recompute';

  const rowFilter = option.rowFilter;
  const allRowIndex: number[] = [];
  for (let i = 0; i < table.numRows; i++) {
    if (!rowFilter || rowFilter(i)) allRowIndex.push(i);
  }

  // ---------------------------------------------------------------------------
  // Pass 1 — discover the pivot key space globally, so every group is scored
  // against the same set of columns.
  // ---------------------------------------------------------------------------
  const pivotReader = pivotBy.map((id) => table.column(id));
  const pivotPathByKey = new Map<string, unknown[]>();
  const rowPivotKey = new Map<number, string>();
  for (const i of allRowIndex) {
    const values = pivotReader.map((r) => (r.isNull(i) ? null : r.get(i)));
    const key = encodeKey(values);
    if (!pivotPathByKey.has(key)) pivotPathByKey.set(key, values);
    rowPivotKey.set(i, key);
  }
  if (pivotPathByKey.size === 0) {
    // No rows at all — still emit the degenerate single key so the output has
    // a stable column set rather than none.
    pivotPathByKey.set(encodeKey(pivotBy.map(() => null)), pivotBy.map(() => null));
  }
  const pivotKeyOrder = [...pivotPathByKey.keys()].sort((a, b) =>
    compareKeyTuple(pivotPathByKey.get(a)!, pivotPathByKey.get(b)!),
  );

  // ---------------------------------------------------------------------------
  // Column layout — the leaf order here IS the output column order, and the
  // header tree is built over exactly the same leaves.
  // ---------------------------------------------------------------------------
  const usedId = new Set<string>(groupBy);
  const pivotColumn: PivotColumnLeaf[] = [];
  const leafIdByCell = new Map<string, string>(); // `${pivotKey}\u0000${measureIdx}`
  for (const key of pivotKeyOrder) {
    const pivotPath = pivotPathByKey.get(key)!;
    for (let m = 0; m < measure.length; m++) {
      const spec = measure[m]!;
      const id = uniqueId(leafId(pivotPath, spec), usedId);
      pivotColumn.push({ id, pivotPath, measure: spec, decomposable: decomposable[m]! });
      leafIdByCell.set(`${key}\u0000${m}`, id);
    }
  }
  const columnTree = buildColumnTree(
    pivotKeyOrder.map((k) => pivotPathByKey.get(k)!),
    pivotKeyOrder,
    pivotBy,
    measure,
    leafIdByCell,
  );

  // ---------------------------------------------------------------------------
  // Pass 2 — build the group hierarchy, accumulating bottom-up.
  // ---------------------------------------------------------------------------
  const root: GroupNodeState = {
    columnId: '',
    key: grandTotalLabel,
    path: [],
    child: [],
    rowIndex: allRowIndex,
    byPivot: null,
    acc: new Map(),
  };
  buildLevel(root, 0);

  function buildLevel(node: GroupNodeState, depth: number): void {
    if (depth >= groupBy.length) {
      // Leaf level: bucket this node's rows by pivot key and accumulate.
      node.byPivot = bucketByPivot(node.rowIndex);
      for (const [key, list] of node.byPivot) {
        node.acc.set(key, accFromRow(list));
      }
      return;
    }
    const columnId = groupBy[depth]!;
    const column = table.column(columnId);
    const bucket = new Map<unknown, number[]>();
    for (const i of node.rowIndex) {
      const key = column.isNull(i) ? null : column.get(i);
      let list = bucket.get(key);
      if (!list) {
        list = [];
        bucket.set(key, list);
      }
      list.push(i);
    }
    node.child = [...bucket.entries()]
      .map(([key, list]) => ({
        columnId,
        key,
        path: [...node.path, key],
        child: [] as GroupNodeState[],
        rowIndex: list,
        byPivot: null,
        acc: new Map<string, MeasureAcc[]>(),
      }))
      .sort((a, b) => compareKey(a.key, b.key));
    for (const child of node.child) buildLevel(child, depth + 1);
    // Roll the children up. This is the only path by which an interior node
    // gets its numbers — it never reads a child's rendered cell.
    for (const child of node.child) {
      for (const [key, childAcc] of child.acc) {
        const own = node.acc.get(key);
        if (!own) {
          node.acc.set(key, childAcc.map(cloneAcc));
          continue;
        }
        for (let m = 0; m < measure.length; m++) {
          mergeAcc(own[m]!, childAcc[m]!);
        }
      }
      if (needInteriorRowList && child.byPivot) {
        node.byPivot ??= new Map<string, number[]>();
        for (const [key, list] of child.byPivot) {
          const own = node.byPivot.get(key);
          if (own) own.push(...list);
          else node.byPivot.set(key, [...list]);
        }
      }
    }
    if (needInteriorRowList) node.byPivot ??= new Map<string, number[]>();
  }

  function bucketByPivot(rowIndex: ReadonlyArray<number>): Map<string, number[]> {
    const out = new Map<string, number[]>();
    for (const i of rowIndex) {
      const key = rowPivotKey.get(i)!;
      let list = out.get(key);
      if (!list) {
        list = [];
        out.set(key, list);
      }
      list.push(i);
    }
    return out;
  }

  function accFromRow(rowIndex: ReadonlyArray<number>): MeasureAcc[] {
    const out: MeasureAcc[] = measure.map(() => ({
      count: 0,
      sum: 0,
      min: null,
      max: null,
    }));
    for (let m = 0; m < measure.length; m++) {
      if (!decomposable[m]) continue;
      const column = table.column(measure[m]!.columnId);
      const acc = out[m]!;
      for (const i of rowIndex) {
        if (column.isNull(i)) continue;
        const v = column.get(i);
        acc.count += 1;
        acc.sum += toNumeric(v);
        if (acc.min === null || compareValue(v, acc.min) < 0) acc.min = v;
        if (acc.max === null || compareValue(v, acc.max) > 0) acc.max = v;
      }
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Pass 3 — materialize. DFS pre-order: a node's own (subtotal) row precedes
  // its children, and the grand total closes the table.
  // ---------------------------------------------------------------------------
  const orderedNode: GroupNodeState[] = [];
  for (const child of root.child) collect(child);
  function collect(node: GroupNodeState): void {
    orderedNode.push(node);
    for (const child of node.child) collect(child);
  }

  const outRowCount = orderedNode.length + (wantGrandTotal ? 1 : 0);
  const rowMeta: GroupPivotRow[] = orderedNode.map((node, rowIndex) => ({
    kind: 'group' as const,
    id: pathKey(node.path),
    path: node.path,
    depth: node.path.length - 1,
    columnId: node.columnId,
    key: node.key,
    rowIndex,
    rowCount: node.rowIndex.length,
    isLeafLevel: node.child.length === 0,
  }));
  if (wantGrandTotal) {
    rowMeta.push({
      kind: 'grandTotal',
      id: GRAND_TOTAL_ID,
      path: [],
      depth: -1,
      columnId: '',
      key: grandTotalLabel,
      rowIndex: orderedNode.length,
      rowCount: root.rowIndex.length,
      isLeafLevel: false,
    });
  }

  const columnInput: ColumnInput[] = [];
  for (let g = 0; g < groupBy.length; g++) {
    const id = groupBy[g]!;
    const data = new Array<unknown>(outRowCount).fill(null);
    for (let r = 0; r < orderedNode.length; r++) {
      const path = orderedNode[r]!.path;
      // A subtotal row identifies itself only down to its own depth; deeper
      // group columns are null, which is what makes the row read as a total.
      data[r] = g < path.length ? (path[g] ?? null) : null;
    }
    columnInput.push({ schema: { id, type: table.column(id).schema.type }, data });
  }

  const unavailableColumn: string[] = [];
  for (let c = 0; c < pivotColumn.length; c++) {
    const leaf = pivotColumn[c]!;
    const measureIndex = c % measure.length;
    const key = pivotKeyOrder[Math.floor(c / measure.length)]!;
    const data = new Array<unknown>(outRowCount).fill(null);
    for (let r = 0; r < orderedNode.length; r++) {
      data[r] = cellValue(orderedNode[r]!, key, measureIndex);
    }
    if (wantGrandTotal) data[orderedNode.length] = cellValue(root, key, measureIndex);
    columnInput.push({ schema: { id: leaf.id, type: cellType(measure[measureIndex]!) }, data });
    if (!leaf.decomposable && rollup === 'unavailable') unavailableColumn.push(leaf.id);
  }

  function cellValue(node: GroupNodeState, pivotKey: string, measureIndex: number): unknown {
    const spec = measure[measureIndex]!;
    if (decomposable[measureIndex]) {
      const acc = node.acc.get(pivotKey)?.[measureIndex];
      // A missing accumulator means no row landed in this (group, pivotKey)
      // cell. That is the sparse case, and it is null — not zero, and never
      // a skipped column.
      return acc ? readAcc(acc, spec.fn) : null;
    }
    const isLeafLevel = node.child.length === 0;
    if (!isLeafLevel && rollup === 'unavailable') return null;
    const rowIndex = node.byPivot?.get(pivotKey);
    if (!rowIndex || rowIndex.length === 0) return null;
    return runAggregate(table, spec, rowIndex);
  }

  function cellType(spec: Aggregation): ColumnType {
    switch (spec.fn) {
      case 'sum':
      case 'avg':
        return 'float64';
      case 'count':
      case 'countDistinct':
        return 'int32';
      case 'min':
      case 'max':
      case 'first':
      case 'last':
        return table.hasColumn(spec.columnId)
          ? table.column(spec.columnId).schema.type
          : 'unknown';
      default:
        return 'unknown';
    }
  }

  // ---------------------------------------------------------------------------
  // Pass 4 — the expand/collapse forest, in exactly the shape `flattenTree`
  // reads. Nothing here re-implements tree walking; `flattenGroupPivot` hands
  // this straight to `flattenTree`.
  // ---------------------------------------------------------------------------
  const metaByNode = new Map<GroupNodeState, GroupPivotRow>();
  for (let r = 0; r < orderedNode.length; r++) {
    metaByNode.set(orderedNode[r]!, rowMeta[r]!);
  }
  const tree: TreeNode<GroupPivotRow>[] = root.child.map(toTreeNode);
  function toTreeNode(node: GroupNodeState): TreeNode<GroupPivotRow> {
    const meta = metaByNode.get(node)!;
    return node.child.length === 0
      ? { id: meta.id, data: meta }
      : { id: meta.id, data: meta, children: node.child.map(toTreeNode) };
  }
  if (wantGrandTotal) {
    const meta = rowMeta[rowMeta.length - 1]!;
    tree.push({ id: meta.id, data: meta });
  }

  return {
    table: createColumnTable(columnInput),
    groupColumn: groupBy,
    pivotColumn,
    columnTree,
    tree,
    row: rowMeta,
    unavailableColumn,
  };
}

/**
 * Flatten a group-pivot result to render order against an expansion set,
 * reusing `flattenTree` verbatim so group-pivot rows behave identically to
 * data-driven tree rows: same `depth`, same `isLeaf` / `hasChildren` /
 * `expanded` semantics, same closed-subtree elision.
 *
 * `openId` holds `GroupPivotRow.id` values (i.e. `pathKey(path)`).
 */
export function flattenGroupPivot(
  result: GroupPivotResult,
  openId: ReadonlySet<string>,
): FlatTreeEntry<GroupPivotRow>[] {
  return flattenTree(result.tree, openId);
}

/** Stable id of the grand-total row. `\u0002` cannot collide with `pathKey`
 *  output, which only ever emits `\u0000` and `\u0001` as sentinels. */
const GRAND_TOTAL_ID = '\u0002total';

// -----------------------------------------------------------------------------
// Accumulator algebra
// -----------------------------------------------------------------------------

function cloneAcc(acc: MeasureAcc): MeasureAcc {
  return { count: acc.count, sum: acc.sum, min: acc.min, max: acc.max };
}

function mergeAcc(into: MeasureAcc, from: MeasureAcc): void {
  into.count += from.count;
  into.sum += from.sum;
  if (from.min !== null && (into.min === null || compareValue(from.min, into.min) < 0)) {
    into.min = from.min;
  }
  if (from.max !== null && (into.max === null || compareValue(from.max, into.max) > 0)) {
    into.max = from.max;
  }
}

function readAcc(acc: MeasureAcc, fn: AggregationType | (string & {})): unknown {
  switch (fn) {
    case 'sum':
      return acc.sum;
    case 'count':
      return acc.count;
    case 'avg':
      // sum / count of the ROWS beneath this node. Never the mean of the
      // children's means — those weight every child equally regardless of
      // how many rows it holds.
      return acc.count === 0 ? null : acc.sum / acc.count;
    case 'min':
      return acc.min;
    case 'max':
      return acc.max;
    default:
      return null;
  }
}

// -----------------------------------------------------------------------------
// Column header tree
// -----------------------------------------------------------------------------

function buildColumnTree(
  pivotPath: ReadonlyArray<ReadonlyArray<unknown>>,
  pivotKey: ReadonlyArray<string>,
  pivotBy: ReadonlyArray<string>,
  measure: ReadonlyArray<Aggregation>,
  leafIdByCell: ReadonlyMap<string, string>,
): PivotColumnNode[] {
  return level(
    pivotPath.map((_, i) => i),
    0,
    [],
  );

  function level(pathIndex: number[], depth: number, prefix: unknown[]): PivotColumnNode[] {
    if (depth >= pivotBy.length) {
      // Bottom of the key hierarchy: one leaf per measure, per key.
      const out: PivotColumnNode[] = [];
      for (const i of pathIndex) {
        for (let m = 0; m < measure.length; m++) {
          const spec = measure[m]!;
          out.push({
            columnId: '',
            key: spec.alias ?? `${String(spec.fn)}_${spec.columnId}`,
            path: prefix,
            depth,
            child: [],
            leafId: leafIdByCell.get(`${pivotKey[i]!}\u0000${m}`)!,
            measure: spec,
            leafCount: 1,
          });
        }
      }
      return out;
    }
    // Paths arrive pre-sorted, so equal prefixes are already adjacent; a
    // Map keyed on the value at this depth preserves that order.
    const bucket = new Map<unknown, number[]>();
    for (const i of pathIndex) {
      const value = pivotPath[i]![depth] ?? null;
      let list = bucket.get(value);
      if (!list) {
        list = [];
        bucket.set(value, list);
      }
      list.push(i);
    }
    const out: PivotColumnNode[] = [];
    for (const [value, list] of bucket) {
      const path = [...prefix, value];
      const child = level(list, depth + 1, path);
      out.push({
        columnId: pivotBy[depth]!,
        key: value,
        path,
        depth,
        child,
        leafId: null,
        measure: null,
        leafCount: child.reduce((n, c) => n + c.leafCount, 0),
      });
    }
    return out;
  }
}

// -----------------------------------------------------------------------------
// Keys and coercion — deliberately identical in behaviour to pivot.ts /
// group.ts so a grid can mix the three without surprises.
// -----------------------------------------------------------------------------

function leafId(pivotPath: ReadonlyArray<unknown>, spec: Aggregation): string {
  const alias = spec.alias ?? `${String(spec.fn)}_${spec.columnId}`;
  if (pivotPath.length === 0) return alias;
  const path = pivotPath
    .map((p) => (p === null || p === undefined ? '∅' : String(p)))
    .join('|');
  return `${alias}__${path}`;
}

function uniqueId(candidate: string, used: Set<string>): string {
  if (!used.has(candidate)) {
    used.add(candidate);
    return candidate;
  }
  let n = 2;
  while (used.has(`${candidate}#${n}`)) n += 1;
  const id = `${candidate}#${n}`;
  used.add(id);
  return id;
}

function encodeKey(value: ReadonlyArray<unknown>): string {
  return value
    .map((v) => (v === null || v === undefined ? '\u0001' : String(v)))
    .join('\u0000');
}

function compareKey(a: unknown, b: unknown): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b));
}

function compareKeyTuple(a: ReadonlyArray<unknown>, b: ReadonlyArray<unknown>): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const cmp = compareKey(a[i] ?? null, b[i] ?? null);
    if (cmp !== 0) return cmp;
  }
  return a.length - b.length;
}

function compareValue(a: unknown, b: unknown): number {
  if (typeof a === 'string' || typeof b === 'string') {
    const sa = String(a ?? '');
    const sb = String(b ?? '');
    if (sa < sb) return -1;
    if (sa > sb) return 1;
    return 0;
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
