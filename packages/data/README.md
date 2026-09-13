# @onegrid/data

Columnar data primitives for oneGrid: Apache-Arrow-compatible Struct-of-Arrays
tables, Fenwick-tree row heights, bitmap selection vectors, multi-column sort,
recursive filter evaluation, hierarchical grouping with aggregations, and
pivoting. Framework-agnostic — no DOM, no React.

Part of [oneGrid](https://github.com/CelestialBrain/onegrid) — a free, MIT-licensed, framework-agnostic
data grid. See the [monorepo README](https://github.com/CelestialBrain/onegrid#readme) for the full
package map, architecture, and roadmap.

## Install

```sh
npm install @onegrid/data
```

## What's in it

| Export | What it does |
| ------ | ------------ |
| `createColumnTable` | Struct-of-Arrays table; `column(id).get(row)` is a typed-array lookup |
| `FenwickHeights` | Prefix-sum row heights for variable-height virtualization |
| `BitmapSelection` | Bitset selection vector with range ops |
| `sortIndex` / `filterIndex` | Multi-column sort and recursive filter over row indices |
| `aggregate` / `registerAggregator` | Built-in and custom column reducers |
| `groupRows` / `flattenGroupTree` | Grouping tree + render-order flattening |
| `pivot` | Distinct values become columns, materialized to a ColumnTable |
| `groupPivot` / `flattenGroupPivot` | Recursive grouping whose leaf level carries pivot columns |
| `flattenTree` / `countTreeNodes` | Caller-supplied tree data, flattened against an open set |
| `enumerateDistinct` | Distinct-value enumeration for filter menus |

## Grouping × pivot

`groupPivot` composes the two pipelines: an arbitrarily deep row hierarchy
whose leaf level carries pivoted measure columns, with a subtotal on every
group level and a grand total. The output is a plain `ColumnTable`, so the
renderer, sort and filter paths carry it with no special-casing.

```ts
import { createColumnTable, groupPivot, flattenGroupPivot, pathKey } from '@onegrid/data';

const table = createColumnTable([
  { schema: { id: 'region', type: 'utf8' }, data: ['EMEA', 'EMEA', 'AMER'] },
  { schema: { id: 'country', type: 'utf8' }, data: ['DE', 'FR', 'US'] },
  { schema: { id: 'quarter', type: 'utf8' }, data: ['Q1', 'Q1', 'Q2'] },
  { schema: { id: 'revenue', type: 'float64' }, data: new Float64Array([10, 300, 40]) },
]);

const result = groupPivot({
  table,
  groupBy: ['region', 'country'],
  pivotBy: ['quarter'],
  measure: [{ fn: 'avg', columnId: 'revenue', alias: 'avgRev' }],
});

result.pivotColumn.map((c) => c.id);      // ['avgRev__Q1', 'avgRev__Q2']
result.columnTree[0].leafCount;           // colspan for the 'Q1' header cell

// Render order against an expansion set — same shape as flattenTree.
const flat = flattenGroupPivot(result, new Set([pathKey(['EMEA'])]));
flat.map((e) => [e.depth, e.data.key]);   // [[0,'AMER'], [0,'EMEA'], [1,'DE'], [1,'FR'], [0,'Total']]
```

Three behaviours worth knowing:

- **Subtotals roll up through an accumulator.** `avg` is read back as
  `sum / count` over the rows beneath a node, never as the mean of the
  children's means.
- **Non-decomposable aggregations** (`countDistinct`, `first`, `last`, custom
  aggregators) are recomputed exactly from the underlying rows. Set
  `option.nonDecomposableRollup: 'unavailable'` to skip that cost instead;
  their subtotals then read null and the column ids are listed in
  `result.unavailableColumn`.
- **Sparse cells are null, never absent.** Pivot keys are discovered once
  across the whole table, so every group is scored against the same column
  set and nothing misaligns.

## License

MIT

## Documentation

The public API surface is tracked in
[`docs/api`](https://github.com/CelestialBrain/onegrid/tree/main/docs/api).
