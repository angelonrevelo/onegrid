// =============================================================================
// @onegrid/data
//
// Columnar data primitives for oneGrid: Apache-Arrow-compatible
// Struct-of-Arrays tables, Fenwick-tree row heights, bitmap selection
// vectors, multi-column sort, recursive filter evaluation, and
// hierarchical grouping with aggregations.
//
// All types are framework-agnostic — these are the pieces every renderer,
// formula engine, and SSRM datasource depends on. No DOM, no React.
// =============================================================================

export { FenwickHeights } from './fenwick';

export { createColumnTable } from './column-table';
export type {
  ColumnData,
  ColumnInput,
  ColumnTable,
  ColumnVector,
} from './column-table';

export { BitmapSelection } from './selection';

export { sortIndex } from './sort';
export type { SortOptions } from './sort';

export { filterIndex } from './filter';
export type { FilterOptions } from './filter';

export { aggregate, registerAggregator } from './aggregate';
export type { AggregatorFn, AggregatorFactory } from './aggregate';

export { groupRows, flattenGroupTree, pathKey } from './group';
export type {
  FlatGroupEntry,
  FlatGroupHeader,
  FlatLeafRow,
  GroupNode,
  GroupRowsOptions,
} from './group';

export { pivot } from './pivot';
export type { PivotedTable } from './pivot';

export { groupPivot, flattenGroupPivot } from './group-pivot';
export type {
  GroupPivotInput,
  GroupPivotOption,
  GroupPivotResult,
  GroupPivotRow,
  NonDecomposableRollup,
  PivotColumnLeaf,
  PivotColumnNode,
} from './group-pivot';

export { enumerateDistinct, enumerateDistinctChunked } from './distinct';
export type { DistinctValue, EnumerateDistinctOptions } from './distinct';

export { flattenTree, countTreeNodes } from './tree';
export type { TreeNode, FlatTreeEntry } from './tree';
