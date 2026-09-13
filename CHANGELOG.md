# Changelog

All notable changes to the oneGrid packages are recorded here. Going
forward, entries are generated from [changesets](./.changeset) on each
release. This first entry was written by hand to capture the surface that
ships in the initial publish.

The `@onegrid/*` packages are versioned together (a `linked` changesets
group), so a release bumps every package to the same version.

## 1.0.0 — initial publish

First release to npm. Captures the v1.0–v1.3 milestone work that
accumulated pre-publish (see [`ROADMAP.md`](./ROADMAP.md) for the full
milestone history and per-wave detail).

### Core grid (`@onegrid/core`)

- Canvas renderer with row + column virtualization for millions of rows.
- Accessibility shadow DOM (WAI-ARIA 1.2 grid semantics), keyboard
  navigation, screen-reader announcer.
- Selection model (ranges, multi-range), fill handle, cell editing with
  validator + async + IME support.
- Frozen columns, pinned rows (band + mid-table), column groups, sticky
  group rows, master-detail.
- Interaction polish (v1.2): drag-to-resize columns (incl. frozen) +
  rows, auto-size, cell flash, find / replace, multi-row drag-reorder.
- Tool panels (v1.3): drag-to-group pill bar, aggregation / filter /
  pivot side panels — all host-mounted DOM emitting model-shaped
  callbacks; the grid computes no grouping/filter/pivot itself.
- Floating filter row, status bar, loading / no-rows overlays, tooltips.

### Data + protocol

- `@onegrid/data` — Arrow-compatible columnar tables, bitmap selection,
  sort cache, group tree, pivot, incremental-view-maintenance hooks.
- `@onegrid/protocol` — wire-format + database-adapter contract types
  (FilterModel, SortModel, GroupingModel, AggregationModel, PivotModel,
  block request/response). Types only, no runtime.
- `@onegrid/formula` — Excel-compatible formula engine: parser,
  dependency graph with range nodes, demand-driven recompute, 457
  built-in functions (per `docs/v1.1.0.md`), LAMBDA family, dynamic-array
  spilling, structured table refs + named ranges.
- `@onegrid/xlsx` — OOXML (.xlsx) formula interop, clean-room from
  ECMA-376.
- `@onegrid/crdt` — live-collaboration substrate.

### Framework adapters

- `@onegrid/react`, `@onegrid/vue`, `@onegrid/svelte`, `@onegrid/solid`,
  `@onegrid/angular`, `@onegrid/wc`, `@onegrid/headless`.

### Database / ORM adapters

- `@onegrid/postgres`, `@onegrid/mysql`, `@onegrid/sqlite`,
  `@onegrid/clickhouse`, `@onegrid/duckdb`, `@onegrid/mongo`,
  `@onegrid/drizzle`, `@onegrid/kysely`, plus `@onegrid/orm-sync`,
  `@onegrid/migrate`, `@onegrid/introspect`.

### Supporting packages

- `@onegrid/a11y`, `@onegrid/intl`, `@onegrid/touch`, `@onegrid/undo`,
  `@onegrid/temporal`, `@onegrid/reactive`, `@onegrid/dbsp`,
  `@onegrid/tokens`, `@onegrid/sparklines`, `@onegrid/export`,
  `@onegrid/ssrm`, `@onegrid/webgpu`, `@onegrid/webgpu-render`,
  `@onegrid/plugin-kit`, `@onegrid/worker-plugins`, `@onegrid/data-worker`,
  `@onegrid/ai`, `@onegrid/mcp`.

- `onegrid` — umbrella meta-package re-exporting the common surface.
