# oneGrid Roadmap

The full list of work that gets oneGrid from a credible v0.0.5 grid to the
most capable open-source grid in the JavaScript ecosystem. Items are
grouped by where they create leverage, not by release order — see
"Sequencing" at the bottom for milestone framing.

**Last updated:** 2026-06-02

## Status legend

- ✅ **Shipped** — landed on `main`, has tests, exposed in the public API
- 🟡 **In progress** — partial implementation, behind a flag, or scaffolded
- 🔵 **Planned** — design is settled, ready to be picked up
- 🟣 **Research** — needs prototype + measurement before committing to design

---

## 1. Grid surface area

The "feels like a real grid" pieces. Each item below is something a real
application reaches for at some point.

| Feature | Status | Notes |
|---|---|---|
| Canvas-2D renderer (10M rows, variable heights) | ✅ | Fenwick-backed |
| Frozen columns | ✅ | |
| Range selection (drag, shift-click, ctrl-click multi-range) | ✅ | |
| Sort (single + multi) | ✅ | |
| Filter (quick + per-column rules) | ✅ | |
| Cell editing (F2/Enter/double-click/type-ahead) | ✅ | DOM overlay |
| Clipboard copy/paste (TSV) | ✅ | |
| Master-detail expandable rows | ✅ | DOM detail layer |
| Pinned top + bottom row sources | ✅ | |
| Column groups (header tree band) | ✅ | |
| Status bar (selection aggregates) | ✅ | |
| Row grouping with aggregations | ✅ | |
| Pivot tables | ✅ | |
| CSV + XLSX export | ✅ | |
| Tree data | ✅ | `flattenTree` / `RowTreeMeta` in @onegrid/data; lazy `loadChildren` per node; nested grids inside detail panels piggy-back on the same row-meta path |
| Server-side hierarchical fetches | ✅ | `BlockRequest.parentId` + per-row `HierarchyEntry`; `createSsrmTreeSource` lazy children fetcher |
| Set filter (distinct-values checkbox + counts) | ✅ | `enumerateDistinct` in @onegrid/data + popover UI |
| Floating filter row | ✅ | Per-column `<input role=searchbox>` band, sticky below header |
| Column tool panel / sidebar | ✅ | React `<ColumnToolPanel>` with show/hide + within-panel drag-drop; `Grid.setColumns()` / `getColumns()` imperative API |
| Context menu | ✅ | `ContextMenuTarget` discriminated union; native menu suppressed; consumer renders the popover |
| Drag-drop column reorder | ✅ | Header pointerdown → drop indicator → in-place column splice; click-vs-drag at the 6px threshold |
| **Drag-drop row reorder** | 🔵 | Within-tree-or-group reorder is a v0.0.8 follow-up |
| **Row + column span (merged cells)** | 🔵 | |
| Sticky group rows | ✅ | `drawStickyGroupRow` re-renders the topmost ancestor at the data band top with aggregates intact |
| **Loading / no-rows / skeleton overlays** | 🔵 | v0.0.9 side-quest — depend on theme tokens (item 2) |
| Tooltip system | ✅ | Single shared `<div role=tooltip>` with hover delay + Escape/scroll dismiss |
| Custom cell renderers | ✅ | Pool + overlay layer in core; React adapter shipped (Vue/Svelte/Solid follow-up) |
| Editor variants | ✅ | `createSelectEditor` / `createDateEditor` / `createTextareaEditor` (autocomplete + multi-select chips follow-up) |
| Selection checkbox column | ✅ | `createSelectionCheckboxColumn` factory + `<SelectAllCheckbox>` tri-state widget; module-scoped store keeps cells in sync via `useSyncExternalStore` |
| **Range chart** | 🔵 | Select cells → embed a chart bound to the selection |
| **Sparklines in cells** | 🔵 | |
| **Undo/redo** | 🔵 | Transactional edit history |
| **Light theme + density variants** | 🔵 | v0.0.9 item 2 — DTCG 2025.10 JSON tokens compiled to CSS variables on `[data-og-root]`; 3 density bundles (compact/comfortable/spacious) |
| IME composition-aware editor commit | ✅ | State machine on composition events + `keyCode===229` guard |
| Cell editor validation | ✅ | Sync + async with `AbortController`; aria-invalid + aria-errormessage + LiveAnnouncer fallback |
| Range fill-handle | ✅ | Bottom-right handle, dashed-outline drag preview, `onFillHandle(source, fill)` callback |
| **Multi-select cell type with chips** | 🔵 | Multi-value column type rendering chips per cell, with a popover editor |
| **Column-group visibility manager** | 🔵 | Toggle whole header groups on/off in one action (single-column visibility ships in `<ColumnToolPanel>`) |
| **Header text wrap** | 🔵 | v0.0.9 side-quest — opt-in wrap with auto-row-height in the header band; tracks density/typography work |
| **Page-level sticky header** | 🔵 | Header sticks to page scroll, not just the grid container — works for grids embedded in long-scroll pages |
| **FDC3 broadcast + intent listener** | 🔵 | Fintech-desk interop: broadcast row context to peer apps, receive intents back |
| **Mobile swipe-row actions** | 🔵 | v0.0.9 item 7 — gesture vocabulary inside `@onegrid/touch` (swipe-left / swipe-right templates) |

## 2. Performance

Where commercial grids have soft ceilings. These are the wins that show up
on benchmark charts.

| Feature | Status | Notes |
|---|---|---|
| Velocity-aware overscan | ✅ | Basic — needs adaptive tuning |
| GPU compute kernels (parallel reduce + filter mask) | ✅ | `@onegrid/webgpu` |
| **Column virtualization** | 🔵 | For 500+ column grids |
| **Web Worker offload** | 🔵 | Sort/filter/group/pivot off the main thread |
| **Full WebGPU rendering path** | 🟣 | Canvas replacement: MSDF/SDF glyph atlas first, Slug-style per-curve evaluation as a phase-2 fallback, per-cell vertex buffer pipeline |
| **Arrow IPC ingestion** | 🔵 | Zero-copy from server, streaming via Arrow Flight (gRPC-Web/Connect-Web) |
| **Differential dataflow** | 🟣 | Source change → recompute only affected derived views; grounded in DBSP operator algebra (Budiu et al. VLDB 2023) |
| **Incremental redraw with dirty-rect protocol** | 🟣 | Track dirty cell rectangles since last frame; paint only those rectangles |
| **SharedArrayBuffer for cross-thread viewport** | 🟣 | Worker writes directly into a SAB the renderer reads — eliminates postMessage cost |
| **Adaptive overscan** | 🔵 | Velocity-aware tuning that learns from real fling traces |
| Aggregation-pushdown SSRM | ✅ | `BlockRequest.aggregations?: AggregationModel`; database adapters emit one row per group with the alias columns + `__count__` |
| **Worker-pool budget controller** | 🔵 | Cap how many cores the grid consumes so collaborative apps don't stall |
| **BigInt-safe formula path** | 🔵 | Keep DB-typed integers in their own lane through the formula graph for currency / large-id columns |
| **GPU hash-aggregate for group-by** | 🟣 | Parallel hash-aggregate compute kernel beyond reduce/filter |

## 3. Hierarchy & nesting

The "inner tables" axis: data and UI that nest cleanly.

| Feature | Status | Notes |
|---|---|---|
| Master-detail expandable rows | ✅ | |
| Row grouping (aggregation-driven, not data-driven) | ✅ | |
| Tree data with lazy-load children | ✅ | Caller-supplied tree, `loadChildren` invoked on first expand; same `getRowMeta` / `onToggleGroup` path used by row grouping |
| Nested grids inside detail panels | ✅ | Recursive oneGrid-in-oneGrid; `Grid.onDetailUnmount` lifecycle hook lets the consumer destroy() inner instances on collapse / scroll-out / outer destroy |
| Server-side tree | ✅ | `BlockRequest.parentId` + per-row `HierarchyEntry`; `createSsrmTreeSource` lazy children fetcher; `parentId` participates in cache fingerprint |
| **Recursive grouping + pivot mix** | 🔵 | Tree data with pivot columns at leaf level |
| **Drag-drop reorder within tree / group** | 🔵 | Reorder rows across siblings in tree data and across groups; the most-requested gap in the wider grid ecosystem |
| Aggregation-aware group-row pin | ✅ | `drawStickyGroupRow` re-renders the topmost ancestor group at the data band top with its aggregates intact |

## 4. Database + data infrastructure

The consolidation moat. oneGrid is positioned to own the database edge in
ways commercial grids are structurally bad at.

| Feature | Status | Notes |
|---|---|---|
| Server-side row model (cursor + block cache) | ✅ | |
| Drizzle adapter | ✅ | |
| Kysely adapter | ✅ | |
| DuckDB-WASM as backing engine | ✅ | |
| Raw Postgres adapter | ✅ | `@onegrid/postgres` — pure SQL compiler + `pg`-compatible queryable + LISTEN/NOTIFY CDC against an outbox table |
| MySQL adapter | ✅ | `@onegrid/mysql` — same compiler shape; polling-based CDC against an outbox (no LISTEN/NOTIFY equivalent without binlog) |
| SQLite adapter | ✅ | `@onegrid/sqlite` — works with better-sqlite3, node:sqlite, bun:sqlite, Cloudflare D1, libsql/Turso through one queryable interface |
| ClickHouse adapter | ✅ | `@onegrid/clickhouse` — native named-parameter syntax (`{p0:Type}`), JSONEachRow + Arrow IPC response paths |
| MongoDB adapter | ✅ | `@onegrid/mongo` — find / aggregation pipeline; change-streams-backed CDC with resume tokens |
| **Snowflake adapter** | 🔵 | |
| **BigQuery adapter** | 🔵 | |
| **Elasticsearch adapter** | 🔵 | |
| **Prisma adapter** | 🔵 | |
| Live updates / subscriptions | ✅ | Postgres LISTEN/NOTIFY, Mongo change streams, MySQL/SQLite polling-outbox — all conform to the universal `CdcAdapter` shape from `@onegrid/ssrm` |
| Optimistic mutations + conflict resolution | ✅ | `createOptimisticMutator` orchestrates apply → submit → commit/rollback with onCommit / onRollback / onTransportError callbacks; tracks pending mutations by clientId |
| **Row-level security / column permissions** | 🔵 | Declarative, server-enforced |
| **Cross-database joins via DuckDB-WASM** | 🟣 | Remote Postgres + local Parquet + CSV, joined in-browser |
| **Query builder UI** | 🟣 | Build SQL/Mongo queries through the grid UI itself, anchored on the column tool panel |
| Keyset/cursor canonicalization in SSRM | ✅ | Canonical `ks:<base64-json>` codec in `@onegrid/ssrm`; legacy `offset:N` accepted via `parseLegacyOffsetCursor` |
| Aggregation-pushdown protocol | ✅ | `BlockRequest.aggregations?: AggregationModel`; servers emit one row per group with alias columns + `__count__` |
| Real-time row diff protocol | ✅ | `RowDiff { kind, version, pkey, fields? }` + `ResyncRequest`/`ResyncResponse` with `snapshot: true` fallback when the gap is too large to replay |
| Universal CDC adapter shape | ✅ | `CdcAdapter` + `createRowDiffStream` in `@onegrid/ssrm`; gap detection via `RowDiffTracker` |
| Schema introspection helper | ✅ | `@onegrid/introspect` — `columnsFromSchema`, `schemaFromSqlRows`, `schemaFromSqliteRows`, `columnTypeFromSql`. ORM-specific paths (Drizzle / Prisma) follow in v0.0.9 |

## 5. Differentiation moats

Where oneGrid wins on its own axes — not by parity, but because it owns
the data layer and rendering layer in a way commercial alternatives don't.

| Feature | Status | Notes |
|---|---|---|
| Formula engine (Adapton-style demand-driven recompute) | ✅ | |
| Multi-framework adapters (React/Vue/Svelte/Solid/Angular/WC) | ✅ | All six are real implementations sharing the React-discovered shape-key recreate gate + imperative-update fan-out + callback late-bind pattern. Vue/Solid/Svelte/Angular/WC stay `@beta` per surface policy until a minor of stability. |
| ORM-first data layer | ✅ | First commit-class citizen, not an afterthought |
| GPU compute kernels | ✅ | |
| **Live ORM sync** | 🟣 | Grid edits → DB writes via Drizzle/Kysely/Prisma, atomically |
| **Time-travel / temporal data** | 🟣 | Every edit versioned; scrub timeline UI |
| **Collaborative real-time editing** | 🟣 | CRDT (Yjs / Automerge) over the row source |
| **AI integration** | 🟣 | Natural language → filters/sorts/formulas/charts |
| **Notebook-style cells** | 🟣 | Jupyter pattern over grid data; formula + DuckDB + GPU as the kernel |
| **Plugin / extension API** | 🔵 | v0.0.9 item 1 — `@onegrid/plugin-kit` with ten domain-specific facet/extension registries (cellRenderer, cellEditor, exporter, dataSource, theme, formulaFunction, aggregator, filterOperator, columnTool, i18nCatalog) |
| **Embeddable block** | 🟣 | Drop oneGrid into Notion/Coda/Obsidian-style hosts |
| **Linear range decomposition in the formula engine** | 🔵 | Sharing work across overlapping aggregates (A1:A100 → A1:A99 + A100) |
| **Spill-style dynamic arrays** | 🔵 | Excel-365-style spilling formulas with `#SPILL!` errors when the spill range is blocked |
| **Function library expansion** | 🔵 | Target ≥400 built-in functions across categories: lookup (VLOOKUP/INDEX/MATCH/XLOOKUP), statistical, financial, text, logical, date/time |
| **Conditional formatting** | 🔵 | Per-cell rules driven by the formula engine; rule editor in the column tool panel |
| **Schema introspection** | 🔵 | Auto-derive `ColumnDef[]` from a database/ORM schema |
| `@onegrid/migrate` CLI | ✅ | jscodeshift-based codemod with transformers for the major incumbent grid configurations, golden-file fixtures, `--write` / `--dry-run` modes; ambiguous translations get inline TODO comments. Source mappings carry SOURCE: <public-url> provenance per the clean-room rule. |
| **MCP server for the grid** | 🟣 | Expose read/write/range/formula tools over the Model Context Protocol so LLMs can drive the grid as a first-class peer |
| **DBSP-style derived view registration** | 🔵 | Public `defineView({ from, where, groupBy, agg })` API returning a live RowSource backed by incremental view maintenance |
| **Salsa-style reactivity substrate** | 🔵 | v0.0.11 — on-demand memoization framework backing the formula engine, derived views, and the column tool panel; same pattern as `salsa-rs` |
| Accessibility conformance suite (CI-gated) | ✅ | `@onegrid/a11y` package + `aria-activedescendant` + 4 axe-core/WAI-ARIA Playwright specs in CI |
| **Per-feature bundle slicing** | 🔵 | v0.0.9 item 5 — `bundle-budget.json` per package + `size-limit` + esbuild metafile; PR fails on >5% regression unless `[budget-bump:]` justification |
| **Range navigation history** | 🔵 | Browser-style back/forward stack within huge sheets — surprisingly absent across the field |
| **Headless engine contract** | 🔵 | v0.0.9 item 4 — `@onegrid/headless` wraps `Grid` with Lit-`ReactiveController`-shaped lifecycle (`hostConnected`/`hostUpdate`/`hostUpdated`/`hostDisconnected`) + imperative core + `subscribe` for reactive frameworks; SSR via `renderAccessibilityShadowHTML()` |
| **Nested namespaced configuration schema** | 🔵 | v0.0.9 item 3 — `defineGridOptions({ data, columns, selection, editing, ... })` factory + flat→nested codemod + preset helpers; construct-time validation throws named codes |
| **i18n / l10n / RTL** | 🔵 | v0.0.9 item 6 — `@onegrid/intl` with `Intl.Collator` cache, ICU MessageFormat catalogs, BCP 47 validator; CSS logical properties throughout `@onegrid/core/style/*`; `getRtlAwareScrollLeft()` helper |
| **Touch + mobile interaction** | 🔵 | v0.0.9 item 7 — `@onegrid/touch` with Pointer Events bridge, gesture recognizer (tap / long-press / swipe / drag-edge resize), `touch-action` declarations, `overscroll-behavior: contain`, `(pointer: coarse)` density overrides at Apple HIG 44pt floor, VirtualKeyboard API + `visualViewport` fallback |
| **Worker-boundary plugin trust tier** | 🔵 | v0.0.9 item 8 — second trust tier for user-supplied formula functions / aggregators authored over Arrow vectors; structured-clone-friendly `WorkerPlugin` shape with `Transferable` zero-copy |
| **Error boundaries + observability** | 🟣 | v0.0.9 item 9 (research pending) — `onError(err, context)`, error-state cell rendering, structured logs / OpenTelemetry breadcrumbs, framework error-boundary integration |
| **Schema evolution at runtime** | 🟣 | v0.0.9 item 10 (research pending) — selection-by-index vs by-id under column add/remove, sort/filter on a removed column, formula `#REF!` semantics |
| **Row-level security / column permissions** | 🔵 | v0.0.9 item 11 — server-canonical permissions (adapter-level filter on `BlockRequest`) + client-cosmetic UI (hide / disable / read-only per column or row) |
| **Backwards-compat / deprecation policy** | 🟣 | v0.0.9 item 12 (research pending) — stable-vs-experimental tier within a major, deprecation timeline, intra-version migrations via `@onegrid/migrate` |
| **`@onegrid/test` adopter harness** | 🟣 | v0.0.9 item 13 (research pending) — testing recipes for cell editing, SSRM block-fetch waits, jsdom limits + Playwright / vitest browser mode integration |
| **Print + advanced export** | 🟣 | v0.0.9 item 14 (research pending) — PDF (jsPDF / pdf-lib), screenshot, format-preserving spreadsheet export, `@media print` paginated layout, header repetition per page |
| **Cross-cell / row-level / sheet-level validators** | 🟣 | v0.0.9 item 15 (research pending) — composes onto the per-cell validator; reuses the formula engine's Adapton-style invalidation graph; topological-pass cap to break cycles |
| **Compile-time feature opt-in (sub-path exports)** | 🟣 | v0.0.9 item 16 (research pending) — critical features always bundled; optional features (formula engine, WebGPU, pivot, tree) opt-in via explicit imports; `package.json` conditional sub-path exports |
| **Forced-colors / high-contrast support** | 🔵 | v0.0.9 side-quest — `@media (forced-colors: active)` maps tokens to system colors |

## 6. Sequencing

A suggested release plan that interleaves parity work with moat work, so
each release lands a noticeable surface improvement *and* a hard-to-copy
capability.

### v0.0.6 — "actually editable"

Polish on what just shipped + the editing experience users expect.
Detailed implementation patterns (architecture, edge cases, test
strategy, code surface, citations) are in
**[docs/v0.0.6.md](docs/v0.0.6.md)**.

Implementation order — each item builds on the previous so the
critical path is *not* the order they appeared in the original
roadmap; it's the order in which retrofits would be most painful:

1. **Accessibility conformance suite (CI-gated)** — first, because
   ARIA grid semantics (`aria-rowindex`/`aria-colindex`/
   `aria-activedescendant`) underlie every other surface and are
   nearly impossible to retrofit later.
2. **IME composition-aware editor commit** — second, because the
   editor depends on it; `keyCode === 229` paths are silent in
   English-locale CI and surface only in CJKT production use.
3. **Cell editor validation (sync + async)** — sits on top of (1)
   and (2); reuses the live-region work from the a11y suite.
4. **Custom cell renderers (React/Vue/Svelte/Solid pool)** — once
   editing is stable. The renderer pool is the most complex non-a11y
   subsystem; deferring lets adapter teams parallelise.
5. **Tooltip system** — depends on a11y `aria-describedby` plumbing
   and is needed by validation error UI.
6. **Floating filters** + **Set filter** — paired; the toolbar a11y
   plumbing is shared, and set-filter UX needs the floating row to
   live in.
7. **Editor variants** (dropdown, date picker, large text,
   autocomplete, multi-select chips) — composes onto the validated
   editor pipeline.
8. **`@onegrid/migrate` CLI** — last. Migration value is proportional
   to API stability; shipping it before 1–7 settle would force the
   migrator to rewrite itself.

Side-quests that ship anywhere in v0.0.6 (no ordering dependency):
- Header text wrap
- Light theme + density variants
- Loading / no-rows / skeleton overlays
- Schema introspection helper for adapters

### v0.0.7 — "hierarchical"

Tree data + nested grids = the "inner tables" milestone.

Implementation order (critical path — hardest-to-retrofit first, same
principle that drove v0.0.6 sequencing):

1. ✅ **Tree data with lazy-load children** — `flattenTree` /
   `RowTreeMeta` row model in `@onegrid/data` + a `getRowMeta`
   discriminated-union extension in core.
2. ✅ **Nested grids inside detail panels** — `Grid.onDetailUnmount`
   lifecycle hook, recursive `Grid` inside `getDetailContent`, full
   destroy() on collapse / scroll-out / outer destroy.
3. ✅ **Server-side tree expansion** — `BlockRequest.parentId` +
   per-row `HierarchyEntry`, `createSsrmTreeSource` lazy children
   fetcher, mock-server hierarchical dataset.
4. ✅ **Drag-drop reorder** (columns) — header pointerdown →
   drag-candidate → vertical drop indicator → in-place column
   splice + `onColumnReorder` callback. Click-vs-drag disambiguated
   at the 6px threshold. (Row + tree/group reorder is a v0.0.8
   follow-up.)
5. ✅ **Column tool panel / sidebar** — `<ColumnToolPanel>` React
   component with show/hide checkboxes + within-panel drag-drop;
   `Grid.setColumns()` / `Grid.getColumns()` imperative API.
6. ✅ **Context menu** — `ContextMenuTarget` discriminated union
   (cell / header / empty), native menu suppressed, consumer renders
   their own popover.
7. ✅ **Sticky group rows + aggregation-aware group-row pin** —
   `drawStickyGroupRow` re-renders the topmost ancestor group at
   the data band top when scrolled past, with aggregates intact.
8. ✅ **Range fill-handle** — bottom-right handle, dashed-outline
   drag preview, `onFillHandle(source, fill)` callback so the
   consumer applies the data policy.
9. ✅ **Selection checkbox column** — `createSelectionCheckboxColumn`
   factory + `<SelectAllCheckbox>` tri-state widget; renderer-pool
   cells subscribe to a module-scoped store via
   `useSyncExternalStore` so toggles repaint without a Grid remount.

Side-quests with no ordering dependency (ship anywhere in v0.0.7):
- Aggregation-aware group-row pin tuning
- Tree-aware drag-drop polish (constrained-to-same-parent reorder)
- Recursive grouping + pivot mix experiments

### v0.0.8 — "data infrastructure"  ✅ **Shipped**

Lean into the database moat. Detailed implementation patterns are in
**`docs/v0.0.8.md`** (post-hoc).

Implementation order (critical path — same hardest-to-retrofit-first
principle that drove v0.0.6 and v0.0.7 sequencing). The first six items
are *protocol* additions that must lock before any real database
adapter ships; otherwise every adapter would inherit the wrong
protocol and force a v0.0.8.1 break:

1. ✅ **Keyset/cursor canonicalization in SSRM** — first, because every
   real database adapter needs to materialize cursors and we don't
   want offset-style cursors leaking into the production protocol.
   Make compound `(sortValues, rowId)` keyset cursors the canonical
   shape; document offset as legacy. Existing `KeysetCursor` type in
   `@onegrid/protocol` becomes the wire-default.
2. ✅ **Aggregation-pushdown protocol** — `BlockRequest.aggregations`
   landed; servers emit one row per group with the alias columns +
   `__count__`. Mock server demonstrates the path; the five real
   adapters below all support it.
3. ✅ **Real-time row diff protocol** — `RowDiff { kind, version,
   pkey, fields? }` plus `ResyncRequest` / `ResyncResponse` with the
   `snapshot: true` fallback for unrecoverable gaps. Client-side
   `RowDiffTracker` does monotonic-version gap detection.
4. ✅ **Universal CDC adapter shape** — `CdcAdapter` interface +
   `createRowDiffStream` in `@onegrid/ssrm`; composes the tracker
   with any adapter that exposes `subscribe` + `resync` + `close?`.
5. ✅ **Optimistic mutations + conflict resolution** —
   `createOptimisticMutator` orchestrates the apply→submit→commit/
   rollback lifecycle with `onCommit` / `onRollback` /
   `onTransportError`; tracks pending by clientId.
6. ✅ **Arrow IPC ingestion** — `ArrowDecoder` hook on row + tree
   sources; HTTP transport sniffs `Content-Type:
   application/vnd.apache.arrow.stream` and returns
   `BlockResponse<'arrow-ipc'>` with cursors carried via response
   headers.
7. ✅ **Raw Postgres adapter** — `@onegrid/postgres`. Pure SQL
   compiler (35 unit tests against fake `pg`) + LISTEN/NOTIFY CDC
   against an outbox table. README documents the trigger DDL.
8. ✅ **MySQL adapter** — `@onegrid/mysql`. Same compiler shape,
   four documented divergences (backticks, `?` placeholders,
   emulated NULLS handling, `BINARY` for case-sensitive). Polling-
   based CDC since MySQL has no LISTEN/NOTIFY equivalent.
9. ✅ **SQLite adapter** — `@onegrid/sqlite`. Works with better-
   sqlite3 / node:sqlite / bun:sqlite / Cloudflare D1 / libsql via
   one queryable interface (sync OR async returns).
10. ✅ **ClickHouse adapter** — `@onegrid/clickhouse`. Native
    `{p0:Type}` named-parameter syntax; JSONEachRow + Arrow IPC
    response paths.
11. ✅ **MongoDB adapter** — `@onegrid/mongo`. find / aggregation
    pipeline; change-streams CDC with resume tokens; keyset
    pagination expands to chained `$or` mirroring SQL row-tuple
    comparison.
12. ✅ **Schema introspection helper** — `@onegrid/introspect`.
    `columnsFromSchema`, `schemaFromSqlRows`, `schemaFromSqliteRows`,
    `columnTypeFromSql`. ORM-specific (Drizzle / Prisma) follows in
    v0.0.9.

Side-quests with no ordering dependency (ship anywhere in v0.0.8):
- Row-level security / column permissions (declarative, server-enforced)
- Snowflake adapter, BigQuery adapter, Elasticsearch adapter, Prisma adapter

### v0.0.9 — "extensibility + ergonomics"  ✅ **Items 1–8 shipped**

Systems-design layer. Detailed implementation patterns will land in
**`docs/v0.0.9.md`** as the milestone progresses; the architectural
direction is sourced from a public-source-only systems-design research
report (see "Research foundations" below — the report cites W3C / MDN
/ RFCs / individual engineer writing / open-source design docs from
CodeMirror / ProseMirror / Lit / Vite / ESLint / Floating UI /
FormatJS / DTCG, never any commercial grid library).

Implementation order (critical path — same hardest-to-retrofit-first
principle as v0.0.6 / v0.0.7 / v0.0.8). Items 1–8 are the seven
sections covered in the v0.0.9 research plus a Worker-boundary plugin
follow-up; items 9–16 cover concerns flagged for follow-up research
that will be detailed in `docs/v0.0.9.md` once their architecture is
settled.

1. **Plugin / extension API** — `@onegrid/plugin-kit` with ten
   domain-specific registries (cellRenderer, cellEditor, exporter,
   dataSource, theme, formulaFunction, aggregator, filterOperator,
   columnTool, i18nCatalog). CodeMirror-6-style facet/extension
   shape with explicit precedence, automatic deduplication, hot-
   reconfigure via `Compartment`, typed `interfaceVersion` for
   plugin/core compatibility, narrowed `PluginContext` (no raw
   DOM/canvas access). Tree-shake-friendly: each registry is a
   separate module path under `@onegrid/core/plugins/*`. Ships
   first because themes, i18n catalogs, aggregators, and filter
   operators all register through it.
2. **Theme + density system** — `@onegrid/tokens` ships W3C DTCG
   2025.10 JSON compiled to CSS custom properties scoped to
   `[data-og-root]`. `[data-og-theme]` + `[data-og-density]`
   attribute selectors give per-instance theming + 3 density
   bundles (compact / comfortable / spacious). `MediaQueryList`
   watcher with cleanup drives `prefers-color-scheme: auto`.
   Comprehensive token taxonomy (≈30 color tokens covering
   bg/header/pinned/sticky/hover/selection/focus/borders/text/
   scrollbar/chevron/detail-panel/status-bar/floating-filter/
   tooltip/drag-indicator/validation/aggregation/pivot/context-
   menu, ≈15 density tokens covering row/header/detail heights +
   font sizes + padding + border thickness + chevron/checkbox/
   resize-handle sizes + line heights). Forced-colors media query
   maps tokens to system colors for high-contrast.
3. **Configuration schema migration** — flat `GridOptions` →
   nested namespaces (`{ data, columns, selection, editing,
   sorting, filtering, grouping, pivot, rendering, scrolling,
   a11y, i18n, touch, ssrm, formula, plugins }`). `defineGridOptions()`
   factory accepts both shapes; flat fields trigger a one-time
   `[OG_DEPRECATED_FLAT_OPT]` warning + auto-hoist.
   `@onegrid/migrate` gains a `--from-flat-options` codemod.
   Preset helpers (`editingPreset`, `mobilePreset`,
   `enterprisePreset`, `accessibilityPreset`) compose via spread.
   Construct-time validation throws with named codes
   (`OG_INVALID_OPTION`, `OG_OPT_REQUIRES`, `OG_OPT_CONFLICT`,
   `OG_OPT_UNKNOWN_NAMESPACE`, `OG_I18N_INVALID_LOCALE`).
4. **Headless contract** — `@onegrid/headless` published as a
   separate package wrapping `@onegrid/core`'s `Grid` class with
   Lit-`ReactiveController`-shaped lifecycle (`hostConnected` /
   `hostUpdate` / `hostUpdated` / `hostDisconnected` +
   `requestUpdate`). Imperative surface (`grid.setSort()`,
   `grid.setFilter()`, `grid.setColumns()`, `grid.scrollToRow()`,
   `grid.subscribe(event, fn)`). Single
   `grid.invalidate(reason)` scheduling primitive coalesces work
   into one `requestAnimationFrame`. SSR path:
   `grid.renderAccessibilityShadowHTML()` returns a static HTML
   string from the ARIA shadow (canvas not meaningful in SSR);
   client-side `grid.mount({ hydrateFrom })` adopts existing
   nodes. Reference adapters: vanilla JS, Lit, Solid example apps.
5. **Per-feature bundle budgeting** — `bundle-budget.json` per
   package committed in the repo. CI runs `size-limit` (gating)
   + emits `esbuild --metafile` JSON (diagnosis). PR comment via
   `andresz1/size-limit-action`. Per-feature granularity: each
   feature lives in its own entry point
   (`@onegrid/core/features/tree-data`,
   `@onegrid/core/features/pivot`, etc.); feature cost measured
   as `bundle(core + feature) - bundle(core)`. PR fails if any
   feature exceeds budget by >5% unless description carries
   `[budget-bump: <feature>]` justification. WebGPU + CPU
   fallback both ship → budget the sum, not the max.
6. **i18n / l10n / RTL** — `@onegrid/intl` ships `Intl.*` thin
   wrappers (`formatNumber`, `formatDate`, `formatRelative`,
   `formatList`), cached `Intl.Collator` (`getCollator(locale)`),
   ICU MessageFormat catalog runtime via FormatJS
   (`loadCatalog`, `t(messageId, params)`), BCP 47 validator
   (`Intl.Locale`-backed canonicalization), locale-aware
   number/date parsers (`parseLocalizedNumber` via
   `Intl.NumberFormat({...}).formatToParts`). Full translation
   string enumeration: chevron a11y labels, empty state,
   validation messages, context menu items, column tool panel
   labels, row group footers, aggregation function names, filter
   operator names, status bar, floating filter placeholders,
   drag-drop indicators, pagination, tooltip help text, detail
   panel labels, date picker month/weekday names, AM/PM, week-
   start day, currency. RTL: `dir="rtl"` on the host + CSS
   logical properties throughout (`inset-inline-*`,
   `margin-inline-*`, `border-inline-*`, `padding-inline`).
   `getRtlAwareScrollLeft()` helper abstracts engine-version
   `scrollLeft` quirks. Logical-direction keyboard nav per WAI-
   ARIA grid pattern. Mixed-direction content via `<bdi>` /
   `unicode-bidi: plaintext`.
7. **Mobile + touch interaction** — `@onegrid/touch` ships
   Pointer Events bridge with `pointercancel` cleanup, gesture
   recognizer (tap, double-tap, long-press ≥500 ms, swipe,
   drag-from-edge resize, drag-header reorder), `touch-action`
   declarations on every affordance (`manipulation` for tappables,
   `none` for drag affordances, `pan-x pan-y` on grid body
   reserving pinch for the OS), `overscroll-behavior: contain`
   on grid body to prevent scroll chaining without disabling
   local rubberband, `(pointer: coarse)` density overrides
   meeting Apple HIG 44pt / Material 48dp floors,
   `--og-density-touch-hit-zone` token, VirtualKeyboard API
   path (`navigator.virtualKeyboard.overlaysContent = true` +
   `geometrychange` listener + `env(keyboard-inset-height, 0px)`)
   with `visualViewport` fallback for iOS Safari, `inputmode`
   on cell editors driven by column data type. Default
   `touch.longPressAction: 'context-menu'` (matches platform
   conventions; opt-in `'row-drag'` for spreadsheet-style apps).
8. **Worker-boundary plugins** — second trust tier for
   user-supplied formula functions and aggregators authored
   over Arrow vectors. Plugin module loads in a dedicated
   Worker; registry exposes a structured-clone-friendly
   `WorkerPlugin` shape. Arrow-vector zero-copy via
   `Transferable` where alignment permits. Errors caught in
   the postMessage adapter, surfaced as `{ ok: false, error }`
   without crashing the main thread. Iframe sandboxing
   intentionally NOT offered — too much overhead for hot paths.
9. **Error boundaries + observability** — research pending. A
   renderer / formatter / validator throwing must not crash the
   grid; error policy + recovery surface (`onError(err, context)`,
   error-state cell rendering, React error-boundary integration,
   structured logs / OpenTelemetry breadcrumbs) to be detailed
   in `docs/v0.0.9.md` once researched.
10. **Schema evolution at runtime** — research pending. When a
    database column is added or removed mid-session, what does the
    grid do? Selection-by-index vs by-id, sort/filter on a removed
    column, formula `#REF!` semantics, breaking-change-detection
    for `Grid.setColumns(...)`.
11. **Multi-tenancy / RLS / column permissions** — research
    pending. Server-canonical permissions (adapter-level filter on
    `BlockRequest`), client-cosmetic UI (hide / disable / read-only
    per column or row), permission-aware
    `getColumnVector(colId)` returning `undefined` instead of
    throwing.
12. **Backwards-compat / deprecation policy** — research pending.
    Stable-vs-experimental tier within a major, deprecation
    timeline (warn-for-N-minor-versions before removal),
    `@deprecated` JSDoc + console.warn + ESLint rule, intra-version
    migrations via `@onegrid/migrate`.
13. **Adopter testing harness** — research pending. `@onegrid/test`
    package or documented testing recipes — assert "row 5 column 3
    contains 'X'", drive cell editing in tests, wait for SSRM
    blocks, jsdom limits (no canvas), Playwright / vitest browser
    mode integration recipes.
14. **Print / advanced export** — research pending. PDF (jsPDF /
    pdf-lib), screenshot, format-preserving Excel, `@media print`
    paginated layout, header repetition per page,
    `print-color-adjust`.
15. **Validation system extensibility** — research pending.
    Cross-cell / row-level / sheet-level validators composing on
    top of the per-cell validator. Adapton-style invalidation graph
    reuse (the formula engine already has one). Topological-pass
    cap to prevent cycles.
16. **Runtime feature flags vs compile-time tree-shaking** —
    research pending. Critical features always bundled (renderer,
    selection); optional features (formula engine, WebGPU, pivot,
    tree) opt-in via explicit imports. Conditional sub-path
    exports in `package.json`.

Side-quests with no ordering dependency (ship anywhere in v0.0.9):
- Light theme as a first-class DTCG token bundle (lands inside item 2)
- A11y forced-colors mode (lands inside item 2)
- Header text wrap (had no home; tracks the density/typography work)
- Loading / no-rows / skeleton overlays (depend on theme tokens)

### v0.0.10 — "performance" (was v0.0.9)  ✅ **Shipped**

Push the ceiling above what commercial grids can hit.
- DBSP-grounded operator algebra spec (prerequisite for differential dataflow)
- Web Worker offload for sort/filter/group/pivot, with worker-pool budget controller
- Column virtualization
- Differential dataflow updates
- Incremental redraw with dirty-rect protocol
- Adaptive overscan
- BigInt-safe formula path
- Range chart + sparklines

### v0.0.11 — "moats" (was v0.0.10)  ✅ **Shipped**

The signature features that aren't on any other grid.
- Live ORM sync (Drizzle/Kysely/Prisma)
- Collaborative real-time editing (Yjs/Automerge)
- Time-travel / temporal data
- AI integration (filters/sorts/formulas from natural language)
- MCP server for the grid (LLMs read/write through standardized tools)
- Salsa-style reactivity substrate refactor
  (Plugin / extension API moved to v0.0.9 item 1.)

### v0.1.0 — "WebGPU rendering"  ✅ **Shipped (scaffold + protocol; renderer migration in v0.1.0.x)**
The flagship moonshot.
- MSDF glyph atlas (the lower-risk path, ports cleanly from the public WebGPU MSDF sample)
- Slug-style per-curve quadratic Bézier text (atlas-free fallback for arbitrarily-large zoom)
- Per-cell vertex buffer pipeline
- GPU hash-aggregate compute kernel for group-by
- Compute-shader sort/filter at viewport scale
- Cross-database joins via DuckDB-WASM in the same render frame

### v1.0.0 — "stable"  🟡 **RC shipped (2026-05-16); 5 of 7 final blockers done (2026-05-29) — pending external audit + auto-promotion at v1.3**
Surface freeze, full a11y audit, every adapter promoted from
experimental, semver guarantees, security review.

RC posture upgrade (configuration-only, no implementation cost): claim
**WCAG 2.2 AA** conformance in `docs/SURFACE.md` + `docs/SECURITY.md`.
Bump `a11y-modes.spec.ts` to
`withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa','wcag22aa'])`.
Marketable since the broader commercial-grid market typically claims
only WCAG 2.0 AA.

RC ([docs/v1.0.0.md](./docs/v1.0.0.md)) ships:
- [`docs/SURFACE.md`](./docs/SURFACE.md) — four stability tiers (`@public`/`@beta`/`@internal`/`@deprecated`); public surface enumerated for every package.
- [`docs/SEMVER.md`](./docs/SEMVER.md) — semver policy (what counts as breaking) + deprecation lifecycle + wire-protocol stability rule.
- [`docs/SECURITY.md`](./docs/SECURITY.md) — threat model + in-scope defenses (XSS / SQL injection / formula eval / Worker messages / MCP mutation discipline / CSP) + out-of-scope items.
- `apps/benchmarks/src/a11y-modes.spec.ts` — axe-core WCAG 2.1 A/AA gate on every playground mode + column tool panel + filters + group-by sticky rows. 7 new tests, all green.

Final ([docs/v1.0.0.md](./docs/v1.0.0.md) §"What v1.0.0 final still needs") status as of 2026-05-29:
- ✅ Workspace-wide version bump (0.0.x → 1.0.0; all 43 packages bumped).
- ✅ `@public` / `@beta` JSDoc tags on every public export (252 exports tagged, [`scripts/check-public-surface.mjs`](./scripts/check-public-surface.mjs) gate).
- ✅ Auto-generated API report (`docs/api/*.api.md`) per package — 43 baselines, `pnpm api:check` gate via [`scripts/generate-api-reports.mjs`](./scripts/generate-api-reports.mjs).
- 🔵 Third-party security audit report (external work; pending commission).
- ✅ Fuzz harness in CI (formula parser, cursor codec, postgres filter compiler, duckdb-join SQL escape — 12 fast-check specs across 4 packages; `pnpm fuzz` script).
- ✅ Deprecation-import lint rule (`@typescript-eslint/no-deprecated: error`, ships with installed tseslint 8.59).
- 🔵 v0.0.11 + v0.1.0 packages auto-promote `@beta` → `@public` at v1.3 per surface policy (mechanical, lands at v1.3 cut).

### v1.1.0 — "spreadsheet-grade compat"  🟡 **Substantively complete — formula library 457/480 (2026-06-02, waves 13–23); LAMBDA family + dynamic-array spilling + structured table refs + named ranges + Excel-compat bug-list + CJK locale all shipped; `@onegrid/xlsx` reads + writes `.xlsx` end-to-end (waves 21–22) with a cross-validation harness (wave 23); CRDT Chunk C shipped. R1C1 mode, iterative calc, and long-period odd bonds deferred to v1.1.x with documented placeholders. Scope plan in [docs/v1.1.0.md](./docs/v1.1.0.md).**

Excel/Sheets-grade formula coverage. v0.0.5–v1.0 ships a working
Adapton-based formula engine with ~41 functions covering the common
arithmetic / aggregation / text / date / logical set; v1.1 brings the
function library and the structural semantics to feature parity with
Excel's published behavior. Public source only — Microsoft's published
function documentation and the OOXML spec (ECMA-376) for the wire
shape; never any proprietary engine source.

**Chunk B (formula library) status as of 2026-05-29.** Twelve waves
landed against an own-implementation target of ~480 functions (per
user direction). `packages/formula/src/functions.ts` refactored from
a 3,031-line monolith into a per-category `packages/formula/src/functions/`
split (one file per Excel category + `_shared` for helpers +
`_aliases` for cross-category names).

- Wave 1 (`fbf4c55`) — math + stats + logical + info expansion (+86).
- Wave 2 (`6c926cf`) — lookup / reference family (+20).
- Wave 3 (`dfe8e64`) — text family expansion (+20).
- Wave 4 (`3be8f12`) — date / time expansion (+20).
- Wave 5 (`79660d1`) — financial family (+26).
- Wave 6 (`c238eb7`) — statistical distributions (+40, with shared
  erf / gammaLn / regGamma / regBeta / bisectInverse numerical
  primitives).
- Wave 7 (`34a2eea`) — engineering family (+54: BIN/OCT/HEX with signed
  two's-complement, bitwise on 48-bit BigInt, BESSEL I/J/K/Y, ERF/ERFC,
  26 IM\* complex-number functions, CONVERT with SI/binary prefixes
  across 13 dimensions).
- Wave 8 (`40bf1e2`) — database family (+12: DSUM/DGET/DAVERAGE/DCOUNT/
  DMAX/DMIN/DPRODUCT/DSTDEV/DSTDEVP/DVAR/DVARP/DCOUNTA, with criteria
  semantics matching Excel — AND within row by header, OR across rows).
- Wave 9 (`ce07786`) — web (ENCODEURL/HYPERLINK real impls) + CUBE.\* /
  WEBSERVICE / FILTERXML stubs (+11).
- Wave 10 (`6afd483`) — math/matrix/array-shape/stubs (+46):
  QUOTIENT/FACTDOUBLE/MULTINOMIAL/ROMAN/ARABIC/BASE/DECIMAL/RANDARRAY,
  MMULT/MINVERSE/MDETERM/TRANSPOSE/MUNIT, dynamic-array shape
  (TAKE/DROP/WRAPROWS/WRAPCOLS/CHOOSEROWS/CHOOSECOLS/EXPAND/TOROW/TOCOL/
  HSTACK/VSTACK), CELL/INFO/locale/pivot/RTD stubs.
- Wave 11 (`9ff0f1c`) — stats extras (+17): GEOMEAN/HARMEAN/TRIMMEAN/
  DEVSQ/AVEDEV/MODE.MULT/PROB/FREQUENCY/CONFIDENCE.NORM/CONFIDENCE.T,
  hypothesis tests Z.TEST/T.TEST(paired+equal-variance+Welch)/F.TEST/
  CHISQ.TEST, OLS regression LINEST/LOGEST/GROWTH.
- Wave 12 (`42da53e`) — financial extras (+28): CUMIPMT/CUMPRINC/EFFECT/
  NOMINAL/ISPMT/RRI/PDURATION/DOLLARDE/DOLLARFR/DISC/INTRATE/RECEIVED/
  PRICEDISC/YIELDDISC/PRICEMAT/YIELDMAT/TBILLEQ/TBILLPRICE/TBILLYIELD.
- Wave 13 (2026-06-02) — day-count plumbing (+9): unblocked
  COUPDAYS / COUPDAYBS / COUPDAYSNC / AMORDEGRC / AMORLINC /
  ODDFPRICE / ODDFYIELD / ODDLPRICE / ODDLYIELD on the back of new
  `daysByBasis` / `coupPeriodDays` / `daysInYear` helpers in
  `packages/formula/src/functions/_shared.ts`. Odd-period bonds cover
  the short-first / short-last cases; long-first / long-last require
  multi-quasi-coupon traversal (deferred). 25/25 tests green.
- Wave 14 (2026-06-02) — cell-metadata introspection (+7): real
  implementations for CELL (address/col/row/contents/type/prefix/width
  info_types), INFO (host-independent info_types), SHEET, SHEETS,
  FORMULATEXT, ISFORMULA, ISREF. Powered by a new CallContext
  sidechannel in `_shared.ts` that the evaluator sets per-call;
  introspection functions read the un-evaluated argument AST and the
  active resolver so they can answer correctly for refs vs literals.
  14/14 tests green.
- Wave 15 (2026-06-02) — parser/evaluator extensions (+6):
  OFFSET + INDIRECT (now real, AST-context aware), REGEX.TEST +
  REGEX.EXTRACT + REGEX.REPLACE (mode 0/1/2 + occurrence semantics),
  LET (sequential bindings + body via evaluator special-case, parser
  now surfaces bare identifiers as zero-arg call nodes so LET binding
  names compose). LAMBDA / BYROW / BYCOL / REDUCE / SCAN / MAP /
  MAKEARRAY / ISOMITTED registered as #NAME! deferrals — they need a
  first-class function-value type tracked under v1.1.x.
  19/19 tests green.
- Wave 16 (2026-06-02) — **LAMBDA family** (+8): new `LambdaNode` AST +
  `FormulaFunction` value kind in `_shared`. LAMBDA constructed via
  evaluator special-case captures the active resolver as closure scope.
  Consumers BYROW / BYCOL / MAP / REDUCE / SCAN / MAKEARRAY / ISOMITTED
  invoke the lambda via its `.call(args)` thunk. Lambdas compose with
  LET bindings, nest cleanly, and survive REDUCE/MAP/etc. dispatch.
  16/16 tests green.
- Wave 17 (2026-06-02) — **dynamic-array spilling** (structural layer):
  `#` spilled-range operator (`A1#`), `@` implicit-intersection
  operator, `#SPILL!` error code, and a new `SpillTracker` registry +
  `asSpilled` shape normalization + `checkSpillCollision` helper.
  `CellResolver` gains an optional `getSpill(anchor)` hook adopters
  wire from their cell store. Spilled ranges compose with the wave 16
  higher-order family — `MAP(A1#, ...)` works end-to-end.
  15/15 tests green.
- Wave 18 (2026-06-02) — **structured table refs + named ranges**:
  tokenizer recognizes `Table1[Column]` / `[@Column]` / `[#Headers]` /
  `[[#All],[Column]]` as one composite token; new `TableRefNode` AST
  kind + `CellResolver.getTable` / `getNamedRange` hooks. Parser now
  preserves identifier casing (was uppercasing) so named ranges and
  LET bindings stay case-sensitive (matches Excel). 18/18 tests green.
- Wave 19 (2026-06-02) — **Excel-compat bug-list + date-serial**:
  three real bug fixes — `INT(-2.5) = -3` (was `-2`),
  `ROUND(-2.5, 0) = -3` (half-away-from-zero, was `-2`),
  `ISBLANK("") = false` (was `true`). New `dateToSerial` /
  `serialToDate` / `isPhantomLeapSlot` helpers gated by `DateSystem`
  ('1900' / '1900-strict' / '1904') — opt-in; preserves the
  Lotus-1-2-3 leap-year-1900 bug for OOXML round-trip. R1C1 mode
  deferred. 22/22 tests green.
- Wave 20 (2026-06-02) — **CJK locale text**: BAHTTEXT (Thai-baht),
  ASC (full→half-width with katakana table), JIS / DBCS (half→full
  width), PHONETIC (degrades to source text without ruby markup).
  Iterative calc + long-period odd bonds explicitly deferred to
  v1.1.x with regression-locks. +5 functions → 457/480. 14/14 tests.
- Wave 21 (2026-06-02) — **`@onegrid/xlsx` container layer**:
  streaming ZIP reader + writer (no jszip dep — uses
  `DecompressionStream` in browsers, `node:zlib` under Node), CRC-32
  implementation, OPC parts + relationships graph,
  `[Content_Types].xml` + `_rels/*` parsing. Bomb-resistance gate
  (decompressed-byte + ratio cap). 7/7 tests.
- Wave 22 (2026-06-02) — **`@onegrid/xlsx` SpreadsheetML round-trip**:
  `readWorkbook(bytes)` → typed Workbook with shared-strings
  dereferenced + formulas parsed to AST; `writeWorkbook(workbook)`
  emits a fresh `.xlsx`. 7/7 tests including write→read round-trip
  for mixed cell types + shared-string dedup + date1904 flag.
- Wave 23 (2026-06-02) — **cross-validation harness**: 33 hand-authored
  formulas with their Excel-computed answers → write through
  `writeWorkbook` → read through `readWorkbook` → evaluate through
  `@onegrid/formula` → assert results match. All 33 round-trip and
  evaluate correctly.
- Wave 24 (2026-06-02) — **v1.2 interaction polish** (six features in
  one wave, all wired through the showcase live tab + verified in real
  Chrome): loading / no-rows overlay (`loading` / `loadingOverlay` /
  `noRowsOverlay` GridOptions + `setLoading()` setter); cell flash on
  update (`flashCell` / `flashRow` + `flash: { durationMs, color }`
  config); auto-size column on dblclick + `autoSizeColumn(id)` /
  `autoSizeColumns()` imperative API; Excel-class keyboard nav
  (Ctrl+Home/End/arrow/Home/End/PgUp/PgDn) + `gotoCell(row, col,
  extend)` public method; row drag-to-resize (in-cell variant since
  no row-gutter; `enableRowResize` + `onRowResize`); column-resize
  surfaced through the React adapter slot props. 96/96 core tests
  pass; production build verified.
- Wave 25 (2026-06-02) — **v1.2 interaction polish, part 2** — find /
  replace within cells. `enableFind: true` mounts an in-host toolbar
  (search input + replace input + prev/next/close/replace/replace-all
  buttons + ARIA-labeled controls); Ctrl/Cmd+F opens it; Esc closes.
  Canvas paint hook tints every matching cell yellow (case-insensitive
  substring). Imperative API: `openFind` / `closeFind` /
  `setFindQuery` / `findNext` / `findPrev` / `replaceCurrent` /
  `replaceAll`. Adopters wire `onReplace(rowIndex, columnId,
  newValue, oldValue)` to mutate their data store — the grid never
  owns row data so it can't mutate directly. Verified in real Chrome:
  typed "Linus" into the showcase live grid, yellow highlight rendered
  on the matching cell in row 5. 104/104 core tests pass.
  Multi-row drag-reorder + dynamic mid-table row pinning deferred
  to wave 26 — pointer arbitration + sticky-render math each deserve
  their own session. (Both shipped in wave 26, same day.)
- Wave 26 (2026-06-02) — **v1.2 interaction polish, part 3**: row
  drag-reorder + mid-table row pinning. `rowDragColumnId` GridOption
  designates a column whose cells act as the row-drag handle;
  pointerdown captures a candidate, 6-px movement promotes to active
  drag, horizontal drop indicator snaps to the nearest row boundary,
  drop fires `onRowReorder(fromRow, toRow)`. Mid-table row pinning
  adds a new `RowDataMeta { kind: 'data', pinned: 'top' | 'bottom' }`
  variant to `RowMeta`; renderer re-paints those rows at the data-band
  edges when their natural scroll position would scroll them off.
  Verified in showcase: row 1 stayed at the top after Ctrl+End jumped
  to row 100,000. 110/110 core tests pass.
- Wave 27 (2026-06-02) — **v1.2 tail** — closes the milestone.
  Multi-row drag-reorder: `onRowReorder` now emits
  `(fromRows: ReadonlyArray<number>, toRow: number)`; drag-start
  snapshots the travelling block (grabbed row inside the selection →
  whole block moves; otherwise just that row), and a contiguous block
  dropped back inside its own run is suppressed as a no-op (breaking:
  first arg was `fromRow: number`). Pinned column resize was found to
  already work — `columnAtRightBoundary` has covered the frozen band
  since the v1.2 starter — so the work was the missing regression
  coverage: `column-resize.test.ts` (5 tests) drives the resize FSM over
  frozen + scrolling boundaries with min/max clamp; `row-reorder.test.ts`
  grew to 11 tests driving the full drag. 123/123 core tests pass.
- Wave 28 (2026-06-02) — **v1.3 tool panels, part 1** — drag-to-group
  pill bar. `enableGroupBar: true` mounts a host DOM strip at the top of
  the header chrome (folded into `fullHeaderHeight()`; the column-group
  band is shifted down by a single `ctx.translate` so no header-draw
  coordinates were rewritten). Pills are removable + native-HTML5-drag
  reorderable; an "add column" `<select>` lists ungrouped columns. The
  grid emits `onRowGrouping(columnIds: string[])` on every change and
  exposes `setGroupColumns()` / `getGroupColumns()`; seed via
  `groupColumns`. Pure UI — computes no grouping (consumer wires to
  `@onegrid/data` `groupRows()`). `group-bar.test.ts` (12 tests, DOM +
  callback-payload driven). 135/135 core tests. Open item: the bar does
  not auto-refresh pill labels on `setColumns()` (avoids rebuilding 60×/s
  during a column-resize drag); fine for static column sets.

**Chunk A (OOXML interop) status as of 2026-06-02.** `@onegrid/xlsx`
scaffold shipped: package manifest + tsup/tsconfig + worksheet
formula reader (`parseSheetFormulas` walks `<c>/<f>` cells, handles
shared-formula `si` reuse + array variant, attaches the
@onegrid/formula AST per cell), serializer (`serializeFormula`
emits OOXML-compatible text with minimal parens via per-operator
precedence table), and an XML escape/unescape helper. 10/10 tests
green; clean-room from ECMA-376 only.

Remaining gap to ~480 after wave 15: the **LAMBDA family**
(LAMBDA / BYROW / BYCOL / REDUCE / SCAN / MAP / MAKEARRAY /
ISOMITTED) and **odd-period long-first / long-last** bond
variants (multi-quasi-coupon traversal in ODDFPRICE et al.).
CJK locale (BAHTTEXT / ASC / JIS / DBCS / PHONETIC) and the
pivot / RTD / IMAGE family remain pure deferrals — they need
host infrastructure that doesn't live in this engine.

Chunk C (CRDT live-collab) shipped 2026-06-02 (commit `ace7507`).
Chunk A (OOXML / `@onegrid/xlsx`) scaffold shipped 2026-06-02
(this update). Full ZIP container parsing / styles graph /
write-out of the archive tracked as follow-ups under chunk A.

Function library — ~460 additional functions across nine groups:

- **Lookup / reference** (~15) — VLOOKUP, HLOOKUP, XLOOKUP, INDEX,
  MATCH, OFFSET, INDIRECT, CHOOSE, FILTER, SORT, UNIQUE, SEQUENCE,
  LET, LAMBDA, MAP
- **Statistical** (~80) — MEDIAN, MODE family, STDEV* / VAR*,
  PERCENTILE* / QUARTILE*, RANK*, COUNTIF* / AVERAGEIF* / SUMIF*,
  regression family (SLOPE, INTERCEPT, RSQ, FORECAST*, LINEST,
  TREND), distribution functions (NORM*, T*, CHISQ*, BINOM*, POISSON,
  WEIBULL, GAMMA*)
- **Financial** (~55) — NPV, IRR, MIRR, PMT, FV, PV, RATE, NPER, the
  depreciation family (SLN, SYD, DDB, VDB), bond math (PRICE,
  YIELD, DURATION, MDURATION, ACCRINT, COUPNUM)
- **Date / time** (~25) — DATEDIF, NETWORKDAYS / NETWORKDAYS.INTL,
  WORKDAY / WORKDAY.INTL, EOMONTH, EDATE, WEEKNUM with all 11 week
  bases, ISOWEEKNUM, YEARFRAC with all 5 basis modes
- **Text** (~30) — TEXTSPLIT, TEXTJOIN, TEXTBEFORE / TEXTAFTER,
  the new REGEX* family (REGEXTEST, REGEXEXTRACT, REGEXREPLACE),
  PROPER, CLEAN, EXACT, T, VALUE, NUMBERVALUE, CHAR / CODE /
  UNICHAR / UNICODE, DOLLAR / FIXED
- **Math** (~60) — LOG family, full trig (SIN/COS/TAN/A* and
  hyperbolic), matrix ops (MMULT, MINVERSE, MDETERM, MUNIT),
  GCD / LCM, COMBIN / COMBINA / PERMUT / PERMUTATIONA, ROMAN /
  ARABIC, SIGN, modular arithmetic, RAND / RANDBETWEEN /
  RANDARRAY
- **Logical** (~10) — IFS, SWITCH, XOR, LET, BYROW, BYCOL,
  REDUCE, SCAN, MAKEARRAY
- **Engineering** (~50) — BIN2HEX / HEX2BIN / DEC2BIN / OCT2*
  family, BITAND / BITOR / BITXOR / BITLSHIFT / BITRSHIFT,
  Bessel functions (BESSELI / J / K / Y), complex number math
  (COMPLEX, IMABS, IMSUM, IMAGINARY, IMREAL, IMARGUMENT,
  IMCONJUGATE, IMEXP, IMLN, IMLOG10, IMSQRT, IMPOWER, IMPRODUCT,
  IMDIV, IMSUB), error functions (ERF / ERFC), unit conversion
  (CONVERT with all unit groups)
- **Database / cube / web** (~50) — DGET, DSUM, DAVERAGE,
  DCOUNT*, DMAX, DMIN, DPRODUCT, DSTDEV*, DVAR*, CUBEMEMBER,
  CUBEVALUE, CUBESET, CUBEFIELD, CUBEKPIMEMBER (subset behind
  optional sub-path; many require OLAP connectivity), WEBSERVICE,
  FILTERXML, ENCODEURL, HYPERLINK

Structural semantics (the bigger lift than function count):

- **Dynamic arrays + spilling** — single-formula multi-cell output,
  `#` spilled-range operator, implicit-intersection `@` operator
  introduced in Excel 2019. Requires evaluator refactor — the
  current single-cell model isn't enough.
- **Structured table references** — `Table1[#Headers]`,
  `Table1[@Column]`, `Table1[[#All],[Column]]` syntax + parser
  hooks.
- **Named ranges with workbook / sheet scope** — name resolution
  before A1 resolution, scope shadowing rules.
- **R1C1 vs A1 reference modes** — switchable at workbook level;
  relative references in R1C1 use `R[1]C[-1]`-style brackets.
- **Mixed / absolute references** — `$A$1`, `A$1`, `$A1` mode
  combinations and how copy-paste shifts them.

Excel-compatibility bug-list (matching exact behavior so adopters'
existing spreadsheets evaluate the same number):

- **1900 leap year bug** — Excel treats 1900 as a leap year for
  Lotus 1-2-3 compatibility; serial number 60 maps to a non-
  existent date. Match the bug; let opt-out via
  `formula.dateSystem: '1904'` (Mac mode) or
  `'1900-strict'` (no bug — breaks .xlsx round-trip).
- **Volatile function semantics** — `NOW()` / `TODAY()` / `RAND()` /
  `RANDBETWEEN()` / `OFFSET()` / `INDIRECT()` / `INFO()` /
  `CELL()` re-evaluate on EVERY recompute, not just when their
  dependencies change. Adapton's demand-driven path needs an opt-in
  "volatile" marker per function — without it, value-equivalent-skip
  would incorrectly cache stale `NOW()` results. Same applies after
  the Salsa migration in v0.0.11.x.
- **Iterative calculation** for circular references —
  `formula.iteration: { max: 100, epsilon: 0.001 }` per Excel's
  manual-iteration mode. Without iteration enabled, circular refs
  emit `#REF!` and stop. Load-bearing knob for accounting-style
  depreciation workbooks.
- **15-digit display precision rule** — Excel rounds at the cell
  level to suppress `0.1 + 0.2 = 0.30000000000000004`. The
  underlying stored value keeps full f64 precision; only the
  displayed value rounds. Different from the v0.0.10 BigInt path —
  this is float-precision display specifically.
- **Spill collision emits `#SPILL!`** (Excel-spec compliant) on
  dynamic-array overlap. Differentiates from non-compliant
  implementations that emit `#VALUE!` for spill conflicts.
- **DATE serial number epoch** — 1900-01-01 = 1 in 1900 mode,
  1904-01-01 = 0 in 1904 mode.
- **Float-precision display rules** — Excel rounds at the cell
  level to suppress `0.1 + 0.2 = 0.30000000000000004`; document
  exact threshold and match.
- **Operator precedence edge cases** — `-2^2 = -4` in Excel
  (unary minus binds tighter than `^`); standard math says +4.
  Decision: match Excel; document the divergence from
  mathematical convention.
- **Empty-cell vs zero coercion** — empty cell is 0 in arithmetic,
  "" in text, FALSE in logical, but `ISBLANK` distinguishes.
- **Error propagation order** — `#NULL!` < `#DIV/0!` < `#VALUE!`
  < `#REF!` < `#NAME?` < `#NUM!` < `#N/A`. First error wins
  unless wrapped in IFERROR / IFNA.
- **Implicit intersection `@`** — pre-2019 Excel implicitly
  intersected ranges with the formula's row; modern Excel requires
  the explicit `@` operator. Both modes opt-in via
  `formula.implicitIntersection`.
- **Circular references** — opt-in iterative calculation
  (`formula.iteration: { max: 100, epsilon: 0.001 }`); without
  it, return `#REF!` and stop.
- **Locale-aware decimal / list separators** — `;` vs `,` for
  function arguments, `,` vs `.` for decimals. Driven by the
  v0.0.9 i18n locale.
- **Text-as-number coercion** — `"5" + 3 = 8` in Excel; `"5x" + 3
  = #VALUE!`. Match exactly.
- **Boolean ↔ 0/1 promotion** — TRUE + 1 = 2; SUM(TRUE, FALSE) = 1.
- **ROUND vs ROUNDDOWN vs INT vs TRUNC sign-handling** —
  `INT(-2.5) = -3` (rounds toward negative infinity);
  `TRUNC(-2.5) = -2` (rounds toward zero); document each.
- **Operator precedence table** — full table matching ECMA-376
  §18.17 precedence ordering.

Test strategy: a public corpus of Excel-formula behavior tests
(adapted from public spreadsheet-engine projects' OWN test
suites — never from proprietary Excel source). Each test
includes the formula, expected value, expected error code if
any, and the OOXML reference. Coverage gate: 95% of corpus
green before v1.1 ships.

OOXML interop: `@onegrid/xlsx` (new package) — read .xlsx
formulas from a workbook, parse to oneGrid's AST, write back.
SheetJS-style approach; pure parser, no proprietary dependencies.

Ships behind sub-path imports so adopters who only need the
v1.0 41-function set don't pay the bundle cost:

```ts
import '@onegrid/formula';                     // 41 base functions
import '@onegrid/formula/excel-compat';        // +460 functions
import '@onegrid/formula/excel-compat/financial';  // just the finance subset
```

### v1.2.0 — "interaction polish" (NEW — feature-parity track)  ✅ **Complete — 11 of 11 items shipped across waves 24–27 (2026-06-02).**

Closes the most-visible UX gaps surfacing in adopter feedback. Each
item is roughly half-a-session of work; the milestone is one batch.

**Waves shipped this milestone.** Three back-to-back sessions on
2026-06-02:

- Wave 24 ([`dafd28e`](https://github.com/onegrid/onegrid/commit/dafd28e)):
  loading / no-rows overlay, cell flash on update, auto-size column,
  Excel-class keyboard nav, row drag-to-resize, column-resize surfaced
  through the React adapter. 96/96 core tests.
- Wave 25 ([`1a48e22`](https://github.com/onegrid/onegrid/commit/1a48e22)):
  find / replace within cells. Canvas paint hook tints matches, in-host
  toolbar + ARIA + imperative API + `onReplace` callback. 104/104
  core tests.
- Wave 26 ([`7a1ac29`](https://github.com/onegrid/onegrid/commit/7a1ac29)):
  row drag-reorder (`rowDragColumnId` + `onRowReorder`) + mid-table
  row pinning (`RowMeta.kind === 'data'` with `pinned: 'top' | 'bottom'`).
  110/110 core tests. Verified in real Chrome — pinned row 1 stayed at
  top after Ctrl+End scrolled to row 100,000.

**Wave 27 (2026-06-02) — v1.2 tail.** Closed the last two items.

- ✅ **Pinned column resize** — turned out to already work: the
  `columnAtRightBoundary` hit-test has handled the frozen band since the
  v1.2 column-resize starter, and the resize move handler recomputes
  `frozenWidth` via `setColumns` on each frame. Wave 27 added the missing
  regression coverage — `column-resize.test.ts` drives the
  pointerdown → pointermove → pointerup state machine over frozen and
  scrolling boundaries, including min/max clamp (5 tests). The earlier
  "frozen columns are fixed-width" note was wrong.
- ✅ **Multi-row drag-drop reorder** — `onRowReorder` now emits
  `(fromRows: ReadonlyArray<number>, toRow: number)`. At drag-start the
  grid snapshots the travelling block: if the grabbed row is inside the
  current selection, every selected row moves as one block (Excel /
  AG-Grid convention); otherwise just the grabbed row. `toRow` is the
  insertion index in the original row coordinate space. No-op detection
  suppresses the callback when a contiguous block drops back inside its
  own run. `row-reorder.test.ts` now drives the full drag for single-row,
  multi-row-block, grab-outside-selection, and four no-op cases (11
  tests). **Breaking:** the callback's first argument changed from
  `fromRow: number` to `fromRows: ReadonlyArray<number>`.

**Wave 24 (2026-06-02).** Six features in one wave, all wired through
the showcase live tab + verified in real Chrome via chrome-devtools
MCP. 96/96 core tests pass.

**Cell + column resize (the headline gap)**
- ✅ **Column drag-to-resize** — already wired in core (v1.2 starter);
  wave 24 surfaced it through the React adapter slot props + the
  showcase live tab.
- ✅ **Row drag-to-resize** (wave 24) — in-cell variant since we don't
  ship a row-number gutter today; pointer in the bottom 4 px of any
  data row enters resize mode, updates `baseHeights[row]` per frame,
  fires `onRowResize(rowIndex, newHeight, finalCommit)`. Adopters opt
  in via `enableRowResize: true`.
- ✅ **Auto-size column to content** (wave 24) — `Grid.autoSizeColumn(id)`
  measures text via canvas `measureText` across visible rows + a 24px
  padding constant, clamped to `minWidth`/`maxWidth`. Wired to
  double-click on the column-resize handle when `enableColumnResize`
  is on.
- ✅ **Auto-size all columns** (wave 24) — `Grid.autoSizeColumns()`
  loops every column. Surfaced in the showcase as a button.

**Interaction nuances**
- ✅ **Cell flash on update** (wave 24) — `Grid.flashCell(rowIndex,
  columnId)` / `Grid.flashRow(rowIndex)` push entries onto a flash
  buffer the render loop paints with a fading translucent rectangle.
  Adopters wire CDC handlers / optimistic-mutation onCommit / formula
  recompute callbacks to these methods. Configurable via
  `flash: { durationMs, color }` GridOption.
- ✅ **Loading / no-rows / skeleton overlay** (wave 24) — built-in
  overlay element shown when `loading === true` or `rowSource.numRows
  === 0`. Adopters override via `loadingOverlay(host)` /
  `noRowsOverlay(host)` callbacks. `Grid.setLoading(value)` imperative
  setter for runtime toggle.
- ✅ **Find / replace within cells** (wave 25) — opt-in via
  `enableFind: true`; Ctrl+F (Cmd+F on macOS) opens an in-host
  toolbar with Find input + Replace input + prev/next/close/replace/
  replace-all buttons. Canvas paint hook tints every matching cell
  yellow (case-insensitive substring match). Public imperative API:
  `Grid.openFind()` / `closeFind()` / `setFindQuery(q)` /
  `findNext()` / `findPrev()` / `replaceCurrent(value?)` /
  `replaceAll(value)`. Adopters wire `onReplace(rowIndex, columnId,
  newValue, oldValue)` to mutate their data store. Scope is the
  visible viewport (with a 50K-row fallback when the viewport
  height is unknown); whole-dataset scope is the adopter's job to
  drive via scrolling.
- ✅ **Excel-class keyboard nav** (wave 24) — Ctrl+Home → (0,0),
  Ctrl+End → last data cell, Ctrl+arrow → jump to data extent in the
  arrow's direction, Home/End → row-extent navigation,
  PageUp/PageDown → jump by one viewport's worth of rows. Shift extends
  selection. `Grid.gotoCell(row, col, extend)` public method for
  imperative use.
- ✅ **Row drag-reorder** (wave 26) — `rowDragColumnId` GridOption
  designates a column whose cells act as the drag handle. Pointerdown
  starts a candidate, 6-px movement promotes to active drag, horizontal
  drop indicator snaps to the nearest row boundary. On drop, fires
  `onRowReorder(fromRow, toRow)` — adopter applies the move.
- ✅ **Dynamic mid-table row pinning** (wave 26) — `getRowMeta` may
  return `{ kind: 'data', pinned: 'top' | 'bottom' }` for any row. When
  its natural position would scroll off-band, the renderer re-paints
  it stuck at the data-band top or bottom. Verified in showcase: row 1
  pinned-top stays visible after Ctrl+End scrolled to row 100,000.
- Pinned column resize — currently frozen columns are fixed-width.

**Customization surface expansion**
- Zero-config helper — `<Grid data={array} />` infers `RowSource`,
  schema, default widths from the first row.
- Keyboard nav extension point (`keymap` registry in plugin-kit) —
  swap arrow-key behavior per-grid.
- Selection-model swap — `BitmapSelection` becomes one impl of a
  `SelectionBackend` interface; sparse-rectangle backend for
  multi-rectangle selection.
- Render-cycle hooks: `onBeforeRender(stats)`, `onAfterLayout(stats)`,
  `onCellMount(cell)`, `onCellUnmount(cell)`.
- Per-row rendering override — `rowRenderer(rowIndex) → CellRenderer | null`
  for full-row replacement (banner rows, custom group headers, etc.).
- Per-instance font swap without raw CSS — `theme.fontFamily` first-class.
- Documented "grid inside cell renderer" pattern — formalized lifecycle,
  demo in the playground.
- Tree mode + master-detail combined — undocumented today; formalize
  the row-meta interaction.
- **`PullRowSource` interface** — pull-model row sourcing alongside the
  existing eager `RowSource`. Caller implements
  `getCellContent(rowIndex, columnId) → CellValue` + an
  `onVisibleRegionChanged(start, end)` prefetch event. Memory scales
  with viewport, not dataset. Maps onto `@onegrid/reactive` substrate.
- **Finer-grained `CellRenderer`** — extend with optional
  `measure(value, column) → number` + `themeOverride(rowIndex, columnId)
  → Partial<GridTheme>` hooks. Backwards-compatible; existing
  renderers keep working. Lets plugins compose grid-wide overrides
  without CSS-recalc cost.
- **`ColumnMeta` + `GridMeta` declaration-merging interfaces** — empty
  `interface ColumnMeta {}` / `interface GridMeta {}` in
  `@onegrid/core` so adopters augment column/grid context with
  strongly-typed custom fields. Zero runtime cost; immediate
  ergonomic win.
- **`@onegrid/react` slot props** — `<OneGrid slots={{ toolbar:
  MyToolbar, noRowsOverlay: MyEmpty, columnToolPanel: MyPanel }}
  slotProps={{...}} />` for the toolbar / status bar / overlays /
  column-tool panel / filter panel. `useGridApiContext()` +
  `useGridSelector()` hooks for slot components to read state.
  Module-augmentation escape hatch via
  `${SlotPascalCase}PropsOverrides`. Complements `@onegrid/plugin-kit`
  (which covers compute-time customization; slots cover render-time
  component substitution).

### v1.3.0 — "tool panels + UI surfaces"  🟡 **In progress — group bar shipped (wave 28, 2026-06-02); aggregation / filter / pivot panels next.**

Surfaces every grid library is expected to ship as out-of-the-box UI.
Today the column tool panel + the group bar exist.

**Architecture (all tool panels).** Panels mount as DOM chrome inside
`host` — same pattern as the wave-25 find toolbar — and emit
model-shaped callbacks. `@onegrid/core` computes NOTHING: the consumer
wires each callback to `@onegrid/data` (`groupRows` / `pivot` /
`filterIndex`) and feeds results back via `setRowSource()` /
`setColumns()`. Every new GridOption is additive (optional). Panels
reuse only TYPE-ONLY imports of the `@onegrid/protocol` model shapes.

- ✅ **Drag-to-group pill bar** (wave 28) — `enableGroupBar: true`
  mounts a strip at the top of the header chrome (folded into
  `fullHeaderHeight()`, so the data band sits below it) holding one
  removable, drag-reorderable pill per active group-by column plus an
  "add column" picker. The grid owns the ordered list as UI state and
  emits `onRowGrouping(columnIds: string[])` on every change; seed it
  with `groupColumns`. Imperative `setGroupColumns()` / `getGroupColumns()`.
- **Pivot side panel UI** — drag rows / columns / values bins; updates
  the PivotModel; the existing pivot compute path consumes it.
- **Filter side panel** — every column's filter accessible from one
  panel (current: floating filter row + per-column popovers).
- **Aggregation side panel** — per-group-by-column aggregator picker.
- **Status-bar plugin surface** — adopters add per-grid panels
  (selection / row-count / KPIs); extends the existing status bar
  which has fixed selection-aggregate slots only.
- **Loading + no-rows overlays** — first-class overlay layer + built-in
  default UIs + override hook. Currently up to the adopter.
- **Controlled-state overlay per feature** — `defineGridOptions`
  accepts optional `state.sort` / `onSortChange(updater)` style
  controlled state per feature (sorting / filtering / pagination /
  selection / column visibility). Mechanical binding to external
  stores (URL-sync, Redux, Zustand, Jotai) becomes trivial; the
  existing imperative `setSort` / `setFilter` API stays as the
  uncontrolled path. Per-feature controlled-vs-uncontrolled is the
  axis (URL-synced sort + in-memory filter coexists out of the box).

### v1.4.0 — "charts + advanced clipboard"

- **Range chart** — select N×M cells → context-menu "Create chart" →
  line / bar / scatter / pie rendered alongside the grid via a small
  embedded chart engine (clean-room from public chart-rendering
  references; not vendor-locked). Pivot chart uses the same engine
  against a PivotModel.
- **Sparkline column type** — `@onegrid/sparklines` shipped in v0.0.10;
  v1.4 adds the grid-level convenience: a `kind: 'sparkline'`
  ColumnDef shortcut that auto-wires `getData(row) → number[]`.
- **Multi-rectangle range clipboard** — Ctrl+click extends selection
  to disjoint rectangles; copy emits a TSV with rectangle separators
  the paste path understands.
- **Drag fill with series patterns** — extends the existing fill-handle
  (currently consumer-applies-policy) with built-in linear / exponential /
  copy / weekday / month / quarter patterns.

### v1.5.0 — "editing + export depth"

- **Date picker editor with calendar UI** — `createDateEditor` today
  is a native `<input type="date">`; ship a calendar popover variant.
- **Multi-select editor variant** — checkbox-list popover (the current
  `createSelectEditor` is single-pick).
- **Built-in context-menu defaults** — Copy / Paste / Cut / Delete /
  Filter / Pin column / Group by / Export… (currently `onContextMenu`
  is a hook with no built-in items).
- **Excel export with styling** — header bold, currency formatting,
  frozen rows preserved, column widths honored (`@onegrid/export`
  XLSX path today is value-only).
- **PDF export** — pdf-lib-driven; `@media print` paginated layout;
  header-row repetition per page; `print-color-adjust`.
- **Screenshot export** — html2canvas-style fallback path for the
  visible viewport.
- **Cell-level animations + transitions** — fade-in on first paint,
  scale on edit commit, opt-in via theme tokens (`--og-anim-*`).

### v1.6.0 — "server modes + master-detail variants"

- **Infinite row model** — strict scroll-and-fetch; no cache eviction
  (caller controls memory). Contrast with the block-cache SSRM that
  ships today.
- **Viewport row model** — server tracks the client's visible window
  and pushes deltas. Alternative to client-pulled blocks; better for
  bandwidth-constrained mobile.
- **Master-detail variants** — side-panel mount, modal mount, below-
  grid mount. Today only row-expand is supported.
- **Master-detail in tree mode** — combine the two hierarchical paths;
  today they're mutually exclusive.
- **Real-database CI** — ephemeral Postgres / MySQL / Mongo containers
  in CI for every adapter; current tests are unit-level over a mock.

### Operational / ecosystem track (parallel to milestones)

These are gates the **codebase doesn't ship** — they live in CI, infra,
or external services. Each is a fix-it batch, not a feature milestone.

**Distribution + reachability**
- 🔴 **Publish to npm** — every dep is currently `workspace:*`;
  nothing on the registry. Blocks every external adopter.
- 🔴 **Live demo URL** — `apps/playground` and the broader [`apps/showcase`](./apps/showcase) (every-package-wired-together demo, `0244521`) are local-only; no hosted preview yet. Vercel / Netlify / Cloudflare Pages configs ship with the showcase as of 2026-06-02 (`61af59e`'s follow-up); flips to 🟢 once a hosted URL exists.
- 🔴 **Docs site** — `docs/*.md` are markdown only; no rendered site
  (`docs.onegrid.dev` or similar via Astro / Nextra / VitePress).
- **CDN / unpkg bundle** — standalone `<script>`-tag distribution.
- **Storybook for component packages** — `@onegrid/react`'s
  `<ColumnToolPanel>`, `<SelectAllCheckbox>`, etc.
- **Example starter apps** beyond `apps/playground` — Next.js, Remix,
  Vite-React, SvelteKit, Nuxt, Astro Islands.

**CI gates we don't run**
- 🟡 **Real-database CI** — covered above in v1.6.
- 🟡 **WebGPU CI** — every WebGPU test currently `skipped` (no GPU in
  CI env); land a `playwright-headed-gpu` runner or use Apple-silicon
  macOS runner.
- 🟡 **Mobile real-device CI** — `@onegrid/touch` tested in jsdom only;
  iOS Safari `visualViewport` / Android Chrome VirtualKeyboard
  untested on real hardware. BrowserStack / Sauce Labs integration.
- 🟡 **Screen-reader CI** — axe-core static scan only; need NVDA /
  VoiceOver / JAWS smoke via Guidepup or similar.
- 🟡 **Continuous benchmarking history** — `perf-scroll.spec.ts` emits
  numbers but they're not persisted across commits; need a dashboard.
- 🟡 **Real Excel-written `.xlsx` corpus** — the wave-23 cross-validation
  harness only round-trips workbooks `writeWorkbook` itself produced;
  same author for both sides of the oracle. Real adopter confidence
  needs at least one Excel-saved and one LibreOffice-saved fixture in
  the corpus. Tracked in `docs/v1.1.0.md` ("Test-coverage gaps");
  promoted here so the top-level operational view doesn't claim full
  OOXML round-trip coverage.
- 🟡 **Fuzz harness** — formula parser, cursor codec, duckdb-join SQL
  generator, filter expression validator all accept untrusted input;
  each needs a property-test pass.

**i18n + a11y completion**
- 🔴 **Real i18n catalogs** — `en` / `es` fixtures exist for tests;
  no actual translated catalogs for the 75 enumerated translation
  IDs across major locales (de, fr, pt-BR, ja, zh-Hans, ar, etc.).
  Community contribution path: write `@onegrid/intl-locale-<tag>`
  packages.
- 🟡 **RTL real-world test** — `getRtlAwareScrollLeft` shipped but
  not end-to-end-tested with an RTL locale in Playwright.
- 🔴 **Real screen-reader smoke** — currently only the static-scan
  axe-core gate runs.

**Audit + governance**
- 🔴 **Third-party security audit** — scheduled for v1.0.0 final;
  external pen-test against the threat model in `docs/SECURITY.md`.
- 🟡 **Deprecation-import lint rule** — ESLint plugin firing on
  `@deprecated`-tagged imports.
- 🟡 **Auto-generated API surface reports** — `docs/api/*.api.md` per
  package via api-extractor; PR-diff gate.
- 🟡 **`@public` / `@beta` JSDoc tags** — `docs/SURFACE.md` lists the
  public surface; source files don't carry the tags yet.
- 🟡 **Workspace version bump** — every package at `0.0.x`; bump to
  `1.0.0` is the v1.0.0 final blocker.

**Community + adoption**
- 🔴 **Zero production users** — the velocity claim is unproven in
  real workloads. First production case study is the trust ratchet.
- 🔴 **Zero external contributors** — bug-triage process, PR-review
  cadence, RFC template all need to exist before contributors arrive.
- 🔴 **No bug bounty / vulnerability disclosure mechanism running** —
  `security@onegrid.dev` mailbox + workflow.
- **No release cadence established** — every milestone has shipped as
  a marathon. Steady-state cadence (e.g., minor every 4–6 weeks) is
  the v1.0.0+ commitment.

### Per-milestone `.x` patches (deferred from in-flight milestones)

These are work the parent milestone explicitly deferred. Each `.x`
ships when its specific dependency soaks.

**v0.0.9.x — research-pending items (8 carryovers)**
- Error boundaries + observability — renderer/formatter/validator
  throws not caught yet; a thrown formatter crashes the row.
  `onError(err, context)`, error-state cell rendering, React error-
  boundary integration, OpenTelemetry breadcrumbs.
- Schema evolution at runtime — column added/removed mid-session:
  selection-by-index vs by-id, formula `#REF!` on removed columns,
  `setColumns` breaking-change detection.
- Multi-tenancy / RLS / column permissions — server-canonical filter
  on `BlockRequest`; client-cosmetic UI (hide / disable / read-only).
- Backwards-compat / deprecation policy — `@deprecated` JSDoc +
  console.warn + ESLint rule + the v1.0.0 final lint rule above.
- Adopter testing harness — `@onegrid/test` package; "row 5 column 3
  contains X", drive editing, wait for SSRM blocks, jsdom canvas
  limits, Playwright + vitest browser-mode recipes.
- Print / advanced export — covered in v1.5 above.
- Validation system extensibility — cross-cell / row-level / sheet-
  level validators on top of per-cell. Adapton invalidation reuse.
- Runtime feature flags vs compile-time tree-shaking — sub-path
  exports for `tree-data`, `pivot`, `formula`, `webgpu` opt-in.

**v0.0.10.x — DBSP + perf carryovers**
- Full DBSP join — delta-join with indexed state on both sides.
- Red-black-tree incremental sort — currently top-K via heap baseline.
- Operator checkpoint / resume — serialize operator state to survive
  process restart.
- Full dirty-rect partial canvas repaint — clip to changed regions
  instead of full `clearRect`. Border-continuity invariant rework.

**v0.0.11.x — moats carryovers**
- Formula engine migration onto `@onegrid/reactive` (Salsa) — replace
  the Adapton substrate; backdating cascade-protection in formula
  recompute.
- Derived-views package built on the reactive substrate.
- Column-tool panel reactivity migration onto the substrate.
- Automerge heads-based diff walking — current bridge is shallow
  snapshot diff; fine for small workspaces, won't scale to thousands
  of rows.

**v0.1.0.x — WebGPU rendering carryovers**
- 🔴 **Canvas → WebGPU paint-loop port** — the actual moonshot the
  v0.1.0 scaffold was leading up to. The scaffolding (device,
  swap chain, cell-quad pipeline, MSDF, vertex buffer protocol) is
  in place; the renderer's `tick()` + `drawRows()` + `syncCellOverlay()`
  rewrite onto the GPU is the work.
- Hash-aggregate linear probing — drops the "pick numBuckets ≥ 4×
  cardinality" constraint; works for unknown-cardinality joins.
- Slug-style per-curve text — atlas-free fallback for arbitrary
  zoom; complements the MSDF-atlas path.
- WebGPU benchmark suite — 100 visible cells × 10M rows scroll at
  60 FPS as the gate before promoting WebGPU as the default render.

---

## Roadmap-ahead summary

| Track | Where it lives |
| --- | --- |
| **v1.0.0 final** (audit + version bumps + JSDoc tags + API reports) | Stability milestone |
| **v1.1.0** spreadsheet-grade compat (~460 Excel functions + dynamic arrays + OOXML) | Above |
| **v1.2.0** interaction polish (drag-resize columns / rows, auto-size, cell flash, find/replace, keyboard nav, zero-config, keymap, selection backend, render hooks, grid-in-cell) | v1.2 section above |
| **v1.3.0** tool panels (drag-to-group bar, pivot side panel, filter side panel, aggregation panel, status bar plugins, overlays) | v1.3 section |
| **v1.4.0** charts + advanced clipboard (range chart, pivot chart, multi-rect clipboard, drag-fill patterns) | v1.4 section |
| **v1.5.0** editing + export depth (calendar editor, multi-select editor, context-menu defaults, styled Excel export, PDF, screenshot, cell animations) | v1.5 section |
| **v1.6.0** server modes + master-detail variants (infinite row model, viewport row model, side/modal/below-grid master-detail, MD-in-tree, real-DB CI) | v1.6 section |
| **Operational track** (npm publish, docs site, live demo, CDN, Storybook, starters, real-DB CI, GPU CI, mobile CI, SR CI, perf history, fuzz, real i18n catalogs, audit, version bump, public-tagging, API reports, deprecation lint, community/adoption) | Operational section |
| **`.x` patches** (v0.0.9.x research-pending, v0.0.10.x DBSP/perf, v0.0.11.x reactive migration, v0.1.0.x WebGPU paint port) | Per-milestone `.x` section |

---

## Research foundations

Several roadmap entries lean on published research and standards. These
are public academic / standards references, not third-party
implementations — oneGrid will reimplement everything from the public
descriptions, never from any commercial source.

- **Adapton (Hammer et al., PLDI 2014)** — demand-driven self-adjusting
  computation. Already underpins the formula engine; will be extended to
  derived views (groupings, pivots, filters) as first-class observers.
  → `@onegrid/formula`, plus a planned `@onegrid/derived` package.
- **DBSP (Budiu et al., VLDB 2023)** — generalized incremental view
  maintenance. The principled foundation for the "differential dataflow"
  roadmap entry.
  → `@onegrid/ssrm` block-cache invalidation + a planned `@onegrid/dbsp`
  operator engine.
- **Differential Dataflow (McSherry et al., CIDR 2013)** — the
  computation model DBSP formalizes; useful for multi-version timestamping
  when grid edits race against server pushes.
- **Noria (Gjengset et al., OSDI 2018)** — partially-stateful dataflow
  for read-heavy apps. Shape for an SSRM mode that asks the server to
  materialize only the visible viewport's state.
- **salsa-rs** — Rust on-demand memoization framework used by
  rust-analyzer. Target for a TS port as the reactivity substrate
  beneath the formula engine, derived columns, and the column tool panel.
- **HyperFormula range decomposition** — share work across overlapping
  aggregates by splitting `A1:A100` into `A1:A99 ∪ A100`. The signature
  technique behind the "linear range decomposition" roadmap entry.
- **Apache Arrow Flight** — gRPC + Arrow record batches as wire format
  with parallel transfer. The standard oneGrid will adopt for any
  high-throughput data adapter.
- **MSDF / Slug glyph rendering** — multi-channel signed distance fields
  (atlas-based) and per-curve quadratic Bézier evaluation (atlas-free)
  as the two-phase path for the WebGPU text pipeline.
- **WAI-ARIA 1.2 grid pattern** — the standards-conformance target the
  accessibility CI suite gates against.
- **Yjs (YATA) and Automerge** — the two CRDT lineages the
  collaborative-editing layer will offer as pluggable backends.
- **CodeMirror 6 facets / extensions** (Marijn Haverbeke,
  https://marijnhaverbeke.nl/blog/facets.html) — labeled
  composable extension points with explicit precedence and
  deduplication. The plugin/registry shape oneGrid adopts in
  v0.0.9 item 1 (`@onegrid/plugin-kit`).
- **Lit `ReactiveController`** (https://lit.dev/docs/composition/controllers/)
  — minimal lifecycle vocabulary (`hostConnected` / `hostUpdate` /
  `hostUpdated` / `hostDisconnected` + `requestUpdate`) the
  framework-agnostic headless contract uses in v0.0.9 item 4
  (`@onegrid/headless`).
- **W3C Design Tokens Format Module 2025.10**
  (https://www.designtokens.org/tr/drafts/format/) — the JSON
  shape for design tokens (`$value` / `$type` / `$description` +
  alias resolution). Compiled to CSS variables for v0.0.9 item 2
  (`@onegrid/tokens`). First stable version was published
  2025-10-28
  (https://www.w3.org/community/design-tokens/2025/10/28/design-tokens-specification-reaches-first-stable-version/).
- **ICU MessageFormat + CLDR** (https://formatjs.github.io/docs/intl-messageformat/,
  https://cldr.unicode.org/) — translation message syntax with
  plural/select/gendered forms. The runtime under v0.0.9 item 6
  (`@onegrid/intl`).
- **W3C Pointer Events Level 3** (https://www.w3.org/TR/pointerevents3/)
  + **CSS `touch-action`** + **CSS `overscroll-behavior`** +
  **VirtualKeyboard API** (https://www.w3.org/TR/virtual-keyboard/) —
  the four-property CSS surface plus three-API JS surface that
  v0.0.9 item 7 (`@onegrid/touch`) builds on.
- **ESLint flat config + Vite `defineConfig`** — the typed-factory
  + nested-namespaces shape that v0.0.9 item 3 adopts for
  `defineGridOptions()`.

---

## How to propose a change

1. Open an issue with the feature, the use case it unlocks, and the
   category it belongs to.
2. If the design is non-trivial, sketch a short RFC in the issue —
   protocol additions, render hooks, performance budget.
3. Check that nothing in [CONTRIBUTING.md](CONTRIBUTING.md)'s
   architectural guardrails would be violated.
4. Once accepted, the issue moves to "🔵 Planned" status here.

oneGrid will not cut scope on this list. If a feature is on the roadmap,
it ships.
