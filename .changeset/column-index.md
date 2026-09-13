---
"@onegrid/data": minor
---

Add an in-memory column index for filter and set-filter work. `createTableIndex(table, { mode })` builds, per column on first use, a dictionary of distinct values with posting lists of the rows holding each; `filterIndexed` evaluates a filter tree once per distinct value instead of once per row, with typeahead refinement for `contains`, and `enumerateDistinctIndexed` returns set-filter values and counts without rescanning the column. Results are bit-identical to `filterIndex` / `enumerateDistinct` (property-tested). `mode: 'auto'` (default) samples each column and filters near-unique columns row-by-row over cached strings instead of building a dictionary; `'dictionary'` and `'row'` force a mode. Measured at 1M rows: typing a 6-character quick filter 987 → 13 ms, set-filter distinct 188 → 6 ms.

Add `UniformHeights`, a row-height store for one default height plus sparse overrides, behind a new `RowHeights` interface that `FenwickHeights` also satisfies. Memory is O(overridden rows), so a billion-row grid mounts without per-row storage; every query answers exactly as `FenwickHeights` does.

`BitmapSelection.toIndices()` walks bytes directly instead of iterating a generator.
