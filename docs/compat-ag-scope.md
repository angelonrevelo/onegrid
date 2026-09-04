# Scope: `@onegrid/compat-ag`

A migration shim that lets an AG-Grid-shaped call site keep compiling while
oneGrid is swapped in underneath.

**Status:** scoped, not built. This document is the decision record; nothing in
it has shipped.

---

## Why this exists

`@onegrid/migrate` already ports **column definitions** — nine 1:1 renames
(`field→id`, `headerName→displayName`, `cellRenderer→renderer`, …) plus eight
properties it annotates with a TODO rather than translating. That is the easy
20%. Measured against the real surface, the remaining 80% is:

| Surface | AG Grid | oneGrid |
|---|---|---|
| Documented API methods | ~180–200 across 30+ categories | 38 public methods on `Grid` |
| Documented events | ~85–90 across 22 categories | ~20 `on*` options |

Sources: <https://www.ag-grid.com/javascript-data-grid/grid-api/>,
<https://www.ag-grid.com/javascript-data-grid/grid-events/>

Without a shim, migrating means hand-rewriting every `gridApi.*` call and every
event handler. That is the difference between "a well-lit path" and "a switch",
and it is currently the largest single obstacle to adoption — larger than any
missing feature, because oneGrid's feature matrix is already 130/130.

**The precedent is in this house.** `akonga/client/src/components/ui/m-grid/`
shipped a `ModuleRegistry` that registers AG-Grid-named modules and throws
`"Module Not Implemented Error: The module X is not yet implemented in M-Grid"`
for the rest. It existed precisely so AG Grid call sites kept compiling while
the engine was replaced — and akonga's `package.json` now carries no `ag-grid`
dependency, so the swap completed. That is the pattern, validated on a real
codebase.

---

## Provenance

This package inherits the clean-room rule already written into
`packages/migrate/src/transforms/ag-grid.ts`:

> Every mapping is sourced from publicly-described configuration shapes. No
> third-party source code, type definitions, or non-public docs are consulted.
> New mappings must include a `// SOURCE: <public-url>` comment so the
> provenance is self-evident.

Every method and event the shim implements must carry a `// SOURCE:` link to
the AG Grid documentation page describing its **behaviour**. We reimplement from
the published description of what a method does, never from their code or their
`.d.ts`.

**This is a decision for the repo owner, not for an implementer.** Reimplementing
a published API surface is ordinary practice and the mappings are behavioural,
not copied — but the name-for-name shape is deliberate compatibility with a
commercial product, and that is a call worth making explicitly before any code is
written. Flagging it here rather than burying it.

---

## The one hard problem: data ownership

Everything else is naming. This is architecture.

- **AG Grid owns your rows.** `applyTransaction({add, update, remove})`,
  `setGridOption('rowData', …)` and `rowNode.setDataValue()` mutate a store the
  grid holds, and the grid re-renders itself.
- **oneGrid never owns rows.** It reads through a `RowSource` and emits
  `onCellEdit` / `onRowReorder` / `onFillHandle`; the adopter mutates their own
  store. This is consistent across the whole codebase — `@onegrid/undo` owns the
  *stack*, not the data.

A shim that forwards `applyTransaction` to a callback is not a shim; it is the
same rewrite with extra steps.

**Decision: the shim owns a store.** `@onegrid/compat-ag` maintains an internal
mutable row array, exposes it to `Grid` as a `RowSource`, and implements the AG
Grid mutation API against it. An AG Grid user's `applyTransaction` call then
works unchanged.

The cost, stated plainly so nobody is surprised: **a shimmed grid is a
client-side row model.** Adopters who want oneGrid's SSRM, keyset pagination or
database adapters must leave the shim. That is correct — the shim is a *bridge*,
not a destination, and it should say so in its README and emit a one-time
console notice naming the migration guide.

---

## Tiers

Fidelity is declared per member, and the tier is part of the public type.

### Tier A — behavioural equivalence (the Pareto set)

Implemented, tested against a documented behaviour, safe to rely on.

**Row data:** `applyTransaction`, `setGridOption('rowData')`, `getRowNode`,
`forEachNode`, `forEachNodeAfterFilterAndSort`, `getDisplayedRowCount`,
`getDisplayedRowAtIndex`
**Selection:** `selectAll`, `deselectAll`, `getSelectedRows`, `getSelectedNodes`,
`setNodesSelected`
**Editing:** `startEditingCell`, `stopEditing`, `getEditingCells`
**Columns:** `getColumns`, `getColumn`, `setColumnsVisible`, `setColumnsPinned`,
`moveColumns`, `getColumnState`, `applyColumnState`
**Sizing:** `autoSizeColumns`, `autoSizeAllColumns`, `sizeColumnsToFit`,
`setColumnWidths`
**Scrolling:** `ensureNodeVisible`, `ensureIndexVisible`, `ensureColumnVisible`
**Sorting/filtering:** `setFilterModel`, `getFilterModel` (see divergence below)
**Rendering:** `refreshCells`, `redrawRows`
**Lifecycle:** `destroy`

≈ 32 methods.

**Events (Tier A):** `onGridReady`, `onCellValueChanged`, `onRowValueChanged`,
`onSelectionChanged`, `onCellClicked`, `onCellDoubleClicked`, `onRowClicked`,
`onRowDoubleClicked`, `onSortChanged`, `onFilterChanged`, `onColumnResized`,
`onColumnMoved`, `onColumnVisible`, `onCellEditingStarted`,
`onCellEditingStopped`, `onPaginationChanged`, `onBodyScroll`,
`onFirstDataRendered`.

≈ 18 events, against ~90 documented. The claim is coverage of what applications
actually call, not of the reference.

### Tier B — approximate, with documented divergence

Works, but not identically. Each carries a `@remarks` block naming the
difference, and the divergence is asserted in a test so it cannot drift silently.

- **`setFilterModel` / `getFilterModel`** — AG Grid's filter model is
  per-column and set-filter-shaped. oneGrid's `FilterModel` lives at the data
  layer. Round-trips for the comparison operators; **set filters and custom
  filter components do not round-trip**.
- **`getColumnState` / `applyColumnState`** — width/visibility/pinned/sort
  translate; `flex`, `aggFunc`, `rowGroupIndex`, `pivotIndex` do not.
- **`exportDataAsCsv`** — delegates to `@onegrid/export`. Column ordering and
  value formatting match; AG Grid's `processCellCallback` hooks do not exist.
- **`paginationGoToPage` and friends** — oneGrid virtualises rather than
  paginating; emulated over a windowed `RowSource`. Behaviourally equivalent to
  a user, structurally different.

### Tier C — refused, loudly

Not implemented, and **throws a named error rather than silently no-op-ing** —
the single most important design rule in the package. A shim that quietly does
nothing produces a UI that looks fine and is wrong.

```
OG_COMPAT_UNSUPPORTED: gridApi.createRangeChart() is not implemented by
@onegrid/compat-ag. oneGrid's charting lives in @onegrid/chart and binds to a
range selection directly. See <migration-guide-url>#charts
```

Refused: Integrated Charts (`createRangeChart`, `getChartModels`, …), the
tool-panel/side-bar API, `getCellEditorInstances`, master-detail
`forEachDetailGridInfo`, the status-bar API, Excel export with styling, and the
long tail of ~150 remaining methods.

`ModuleRegistry.registerModules()` is accepted as a **no-op** that records what
was requested — so an AG Grid app's bootstrap line keeps compiling — and
`compatReport()` returns what was registered but is unimplemented. This is
M-Grid's pattern, with the failure made visible instead of thrown at render
time.

---

## Acceptance criteria

The gate, so "done" is a command and not a claim:

1. **Every Tier A member has a test** asserting the documented behaviour, and a
   `// SOURCE:` URL. A new export without both fails the build.
2. **A conformance corpus.** ~12 realistic AG-Grid-shaped app fixtures
   (client-side row model, sorting, selection, inline editing, transactions,
   column state persistence) that mount through the shim and assert observable
   outcomes via `@onegrid/test`. This is the real proof, and it is what tells us
   the tier split was drawn in the right place.
3. **`compatReport()` coverage test** — the Tier C list in the docs and the
   thrown-error list in the code are generated from one table, so they cannot
   disagree.
4. Standard repo gate: build / typecheck / test / lint / `surface:check` /
   `bundle:check`, plus a bundle budget for the new package.

## Effort

| Piece | Estimate |
|---|---|
| `RowNode` facade + the owned store + `applyTransaction` | 1 session — the hard part, and where the bugs will be |
| Tier A methods (~32) | 1–2 sessions |
| Tier A events (~18) | 1 session |
| Tier B four families + divergence tests | 1 session |
| Tier C error table + `ModuleRegistry` no-op + `compatReport` | half a session |
| Conformance corpus (12 fixtures) | 1 session |

≈ **5–6 sessions**, materially less than the ~40 packages already built, and
plausibly worth more than any of them for adoption.

## Risks

- **The shim becomes the product.** If it is good, nobody migrates off it and
  oneGrid inherits AG Grid's API as its de-facto surface. Mitigation: the
  client-side-row-model ceiling is real and load-bearing — the moment an adopter
  wants SSRM or a database adapter, they must leave. Do not soften that.
- **Tier B divergences get discovered in production.** Mitigation: every
  divergence is a test, and `compatReport()` is callable at runtime.
- **Perceived AG Grid endorsement.** The README must open by stating this is an
  unaffiliated compatibility layer built from public documentation.
- **Maintenance drift.** AG Grid ships constantly. Mitigation: pin the
  documented version the mappings were derived from, and treat their major
  releases as an explicit review trigger rather than a silent break.

## Not in scope

Vue/Angular/Svelte AG Grid wrappers (React first; the others only if the React
shim proves itself), AG Grid's theming/CSS variables, and any attempt to match
AG Grid's DOM structure — oneGrid paints to canvas, so DOM-dependent tests and
selectors in an adopter's suite will not port. That last one deserves a
prominent section in the migration guide, because it is what will actually
surprise people.
