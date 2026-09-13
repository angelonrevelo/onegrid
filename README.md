# oneGrid

> A free, open-source, framework-agnostic data grid built for 10M+ rows (a billion with a uniform row height), multiple databases, formulas, instant updates, and modern ORM integrations. MIT-licensed end to end.

**Status:** through v1.3 (on `main`) — the governed roadmap surface is **130 / 130 ✅**, enforced by `node scripts/check-roadmap-green.mjs`, which refuses a green row that is not backed by a real exported symbol and a real test file. Engine + canvas renderer with column virtualization and adaptive overscan; SSRM with canonical keyset cursors / aggregation pushdown / real-time row-diff protocol / Arrow IPC ingestion; BigInt-safe formula engine; DuckDB-WASM mode with cross-source SQL joins; cell editing, row grouping, pivot tables, master-detail with nested grids, tree data with lazy-load; server-side hierarchical fetch; column drag-drop reorder, column tool panel, context menu, sticky group rows, range fill-handle, selection checkbox column; GPU compute kernels (reduce / filter / hash-aggregate) with CPU fallbacks; real database adapters (Postgres, MySQL, SQLite, ClickHouse, Mongo) with universal CDC + optimistic-mutation orchestration; schema introspection; framework + ORM adapter family; **plugin-kit + DTCG tokens + headless lifecycle + intl + touch + worker-plugins + bundle-budget CI** (v0.0.9); **DBSP operator algebra + data-worker offload + sparklines** (v0.0.10); **MCP server + time-travel + AI intents + live ORM sync + CRDT collab + Salsa reactivity substrate** (v0.0.11); **WebGPU render scaffold + MSDF text + cross-DB joins** (v0.1.0); **public API surface freeze + semver guarantees + WCAG a11y gate** (v1.0.0 — external security audit pending); **Excel-class formula engine at 457/480 functions — LAMBDA family, dynamic-array spilling, structured refs + named ranges — plus OOXML `.xlsx` formula round-trip and CRDT live collaboration** (v1.1.0); **interaction polish — drag-resize columns (including frozen) + rows, auto-size, cell flash, find / replace, multi-row drag-reorder** (v1.2.0); **tool panels — drag-to-group pill bar + aggregation / filter / pivot side panels, host-mounted DOM emitting protocol-shaped callbacks** (v1.3.0). All 44 `@onegrid/*` packages are publish-ready (see [`PUBLISHING.md`](PUBLISHING.md)); an Astro Starlight docs site ships in [`apps/docs`](apps/docs).

---

## What oneGrid is

A single MIT-licensed grid that consolidates the things real applications need at scale into one coherent stack:

- **Canvas-first rendering** at 10M rows with variable row heights and a billion with a uniform one, with a DOM accessibility shadow and DOM overlays for editors and detail panels.
- **Server-side row model** with cursor pagination, sliding-window block cache, optimistic mutations, and Arrow-friendly payloads — including hierarchical lazy fetches via `BlockRequest.parentId`.
- **Spreadsheet-class formulas** with a parser, dependency graph (with range nodes for linear-edge growth), and Adapton-style demand-driven recompute.
- **Columnar Apache-Arrow-compatible memory layout** for typed-array sort/filter and zero-copy slicing.
- **Cell editing + clipboard paste** — inline DOM overlay editor (F2/Enter/double-click/type-ahead), Excel-compatible TSV copy + paste, range selection.
- **Range fill-handle** — drag the bottom-right of a selection to extend; the consumer applies the data policy via `onFillHandle`.
- **Row grouping with aggregations** — sum/avg/count/min/max headers with collapse/expand, sticky group rows that pin while scrolling, native to the renderer.
- **Tree data with lazy-load children** — first-class hierarchical row model. The same `getRowMeta` / `onToggleGroup` path drives both row grouping and tree mode; children fetch on first expand.
- **Pivot tables** — bucketed (rowKey × pivotKey × measure) materializer that produces a regular ColumnTable, so the existing renderer/sort/filter pipeline carries pivots for free.
- **Pinned rows + column groups + status bar** — totals rows above/below the data, header tree band for grouped columns, selection-aggregate footer.
- **Master-detail expandable rows** with first-class DOM detail panels — including **nested oneGrids** inside the panel via the `onDetailUnmount` lifecycle hook.
- **Column drag-drop reorder + tool panel** — header drag with a vertical drop indicator; React `<ColumnToolPanel>` for show/hide and within-panel reorder.
- **Context menu** — right-click → Grid resolves the target (cell / header / empty) + suppresses the native menu; the consumer renders their own popover.
- **Selection-checkbox column** — Excel-style row selection separate from cell selection; `<SelectAllCheckbox>` toolbar widget for tri-state select-all.
- **DuckDB-WASM mode** as a turnkey in-browser query engine.
- **GPU compute kernels** (WebGPU) — parallel reductions and predicate filters over typed-array columns, with CPU fallbacks.
- **First-class ORM and database adapters** — Drizzle, Kysely, with more on the roadmap.

All under a single MIT license. No paywalled tiers. No commercial-only features.

---

## Packages

| Package | Description |
|---|---|
| [`onegrid`](packages/onegrid) | Convenience umbrella — re-exports core for casual install |
| [`@onegrid/core`](packages/core) | Engine: canvas renderer, accessibility shadow, layout, selection, editor, status bar |
| [`@onegrid/data`](packages/data) | Columnar data layer: Arrow-compatible tables, bitmap selection, sort/filter, group, pivot |
| [`@onegrid/protocol`](packages/protocol) | Wire-format and adapter contract types |
| [`@onegrid/ssrm`](packages/ssrm) | Server-side row model: cursor pagination, block cache, optimistic mutations |
| [`@onegrid/formula`](packages/formula) | Formula engine: parser, dependency graph, demand-driven recompute |
| [`@onegrid/duckdb`](packages/duckdb) | DuckDB-WASM as a client-side query engine |
| [`@onegrid/webgpu`](packages/webgpu) | GPU compute kernels (parallel reduce, predicate→mask filter) for hot data paths |
| [`@onegrid/export`](packages/export) | CSV + XLSX export |
| [`@onegrid/react`](packages/adapters/react) | React adapter |
| [`@onegrid/vue`](packages/adapters/vue) | Vue 3 adapter |
| [`@onegrid/svelte`](packages/adapters/svelte) | Svelte 5 adapter |
| [`@onegrid/solid`](packages/adapters/solid) | Solid.js adapter |
| [`@onegrid/angular`](packages/adapters/angular) | Angular adapter |
| [`@onegrid/wc`](packages/adapters/wc) | Web Component adapter |
| [`@onegrid/drizzle`](packages/adapters/drizzle) | Drizzle ORM datasource adapter |
| [`@onegrid/kysely`](packages/adapters/kysely) | Kysely query-builder datasource adapter |
| [`@onegrid/postgres`](packages/adapters/postgres) | Raw Postgres adapter — SQL compiler + LISTEN/NOTIFY CDC |
| [`@onegrid/mysql`](packages/adapters/mysql) | MySQL adapter — SQL compiler + polling-outbox CDC |
| [`@onegrid/sqlite`](packages/adapters/sqlite) | SQLite adapter — works with better-sqlite3, node:sqlite, bun:sqlite, D1, libsql |
| [`@onegrid/clickhouse`](packages/adapters/clickhouse) | ClickHouse adapter — native named parameters + Arrow IPC |
| [`@onegrid/mongo`](packages/adapters/mongo) | MongoDB adapter — find / aggregation pipeline + change-streams CDC |
| [`@onegrid/introspect`](packages/introspect) | Schema introspection — Schema → ColumnDef[], SQL data-type mapping |
| [`@onegrid/plugin-kit`](packages/plugin-kit) | CodeMirror-6-style facets + compartments + 10 typed plugin registries |
| [`@onegrid/tokens`](packages/tokens) | W3C DTCG 2025.10 design tokens → CSS variables (themes + density) |
| [`@onegrid/headless`](packages/headless) | Lit-`ReactiveController` lifecycle wrapping `Grid` (mount / requestUpdate / SSR shadow) |
| [`@onegrid/intl`](packages/intl) | i18n / l10n / RTL — `Intl.*` wrappers, ICU MessageFormat subset, BCP 47 validator |
| [`@onegrid/touch`](packages/touch) | Pointer Events 3 gesture recognizer + touch CSS emitter + VirtualKeyboard adapter |
| [`@onegrid/worker-plugins`](packages/worker-plugins) | Worker-boundary sandbox for user-supplied compute (formula fns, aggregators) |
| [`@onegrid/data-worker`](packages/data-worker) | Web Worker offload for `@onegrid/data` sort / filter / group / pivot; numeric jobs can run on an `@onegrid/wasm` kernel |
| [`@onegrid/dbsp`](packages/dbsp) | DBSP operator algebra — Z-sets + incremental view maintenance |
| [`@onegrid/sparklines`](packages/sparklines) | In-cell line / bar / win-loss charts drawn to the canvas |
| [`@onegrid/mcp`](packages/mcp) | Model Context Protocol surface — LLMs read + act on the grid through standardized tools |
| [`@onegrid/temporal`](packages/temporal) | Time-travel — append-only diff log, snapshotAt(version), branch, invertDiff |
| [`@onegrid/ai`](packages/ai) | Natural-language → typed grid intent (BYO-LLM contract) |
| [`@onegrid/orm-sync`](packages/orm-sync) | Live ORM sync — typed CDC bridge for Drizzle / Kysely / Prisma |
| [`@onegrid/crdt`](packages/crdt) | Collaborative editing — Yjs + Automerge bridges into RowDiff streams |
| [`@onegrid/reactive`](packages/reactive) | Salsa-style on-demand memoization substrate with backdating |
| [`@onegrid/webgpu-render`](packages/webgpu-render) | WebGPU rendering scaffold — device + cell-quad pipeline + MSDF text shader |
| [`@onegrid/duckdb-join`](packages/duckdb-join) | Cross-database SQL joins via DuckDB-WASM (rows / arrow / sql sources) |
| [`@onegrid/studio`](packages/studio) | Headless Supabase-class table editor — introspection, DDL compilation, migration planning with risk assessment, FK relationship graph |
| [`@onegrid/preset`](packages/preset) | Feature registry + toggleable presets (spreadsheet / database-editor / dashboard / report / mobile / minimal / analytics) + responsive profile |
| [`@onegrid/query-builder`](packages/query-builder) | Headless visual query model → `FilterModel` / parameterised SQL (4 dialects) / Mongo |
| [`@onegrid/permission`](packages/permission) | Declarative row-level security + column permissions; compiles into the adapter's `BlockRequest` filter |
| [`@onegrid/validate`](packages/validate) | Cross-cell / row / sheet validators with incremental revalidation and cycle breaking |
| [`@onegrid/chart`](packages/chart) | Range charts bound to a cell selection — 7 chart kinds, canvas renderer, hit-testing |
| [`@onegrid/notebook`](packages/notebook) | Reactive notebook cells over grid data with a pluggable kernel |
| [`@onegrid/print`](packages/print) | Paginated print + a dependency-free PDF writer + `@media print` CSS + screenshot stitching |
| [`@onegrid/embed`](packages/embed) | Embeddable block — versioned descriptor, sandboxed iframe + postMessage, custom element, oEmbed |
| [`@onegrid/observability`](packages/observability) | Typed error taxonomy, per-cell error boundary + circuit breaker, redaction-first logging, OTel-shaped spans |
| [`@onegrid/fdc3`](packages/fdc3) | FDC3 2.0 desktop interop — broadcast row context, raise and receive intents |
| [`@onegrid/wasm`](packages/wasm) | Rust/WASM acceleration seam with a JS reference backend, proven equivalent by differential property tests |
| [`@onegrid/undo`](packages/undo) | Undo / redo stack semantics with transactional grouping |
| [`@onegrid/xlsx`](packages/xlsx) | Reads and writes `.xlsx` end to end |
| [`@onegrid/test`](packages/test) | Adopter test harness — canvas stub, a11y-shadow queries, fakes, user-event helpers, matchers |
| [`@onegrid/snowflake`](packages/adapters/snowflake) | Snowflake adapter — SQL compiler + STREAM-based CDC |
| [`@onegrid/bigquery`](packages/adapters/bigquery) | BigQuery adapter — GoogleSQL + partition pruning + polling CDC |
| [`@onegrid/elasticsearch`](packages/adapters/elasticsearch) | Elasticsearch adapter — `search_after` keyset, composite aggregations, full-text operators |
| [`@onegrid/prisma`](packages/adapters/prisma) | Prisma adapter — argument compilation, `groupBy` pushdown, DMMF introspection |

---

## Roadmap

The full slate of planned work — surface area, performance, hierarchy, database adapters, and signature differentiation features — is tracked in **[ROADMAP.md](ROADMAP.md)**. Releases v0.0.6 through v1.0.0 are sketched there with explicit milestones.

---

## Architecture

- **[packages/protocol/src/index.ts](packages/protocol/src/index.ts)** — Load-bearing schema. The contract every other package depends on.
- **[apps/playground](apps/playground)** — Live demo with seven modes:
  - **In-memory** — materialized typed-array columns with sort/filter/quick-filter, cell editing, copy/paste, master-detail panels (with nested oneGrids), pinned totals row, column groups, status bar, fill-handle, opt-in selection-checkbox column, column drag-drop, column tool panel, context menu, and "group by status" with sticky group rows + revenue/score aggregates.
  - **SSRM (localhost:3001)** — block-paginated server-side row model wired to a mock Express server.
  - **SSRM Tree** — hierarchical fetches over the SSRM protocol against the mock server's regions → countries → cities dataset, with `parentId`-keyed cache fingerprinting.
  - **Formula** — incremental engine with live recompute, Adapton-style demand-driven evaluation, and a formula bar.
  - **DuckDB (in-browser)** — WASM DuckDB ingesting a 100k-row synthetic CSV, served through the same SsrmRowSource bridge.
  - **Pivot** — pivots a 100k-row dataset by status × firstName with sum(revenue) and avg(score), rendered through the standard column pipeline.
  - **Tree** — synthetic regions/countries/cities tree with a lazy-loaded country (Brazil) demonstrating the async `loadChildren` path.
- **[apps/benchmarks](apps/benchmarks)** — Playwright-driven performance gates: 1M-row scroll FPS, SSRM block latency, formula recompute throughput, throttled-CPU floors.
- **[apps/showcase](apps/showcase)** — Every public-surface package wired into one app, organized as nine tabs (live grid, formula+xlsx, data adapters, CRDT collab, framework adapters, WebGPU, cross-cutting, moats, export). Proves the contracts compose end-to-end; verified in real Chrome via chrome-devtools MCP. Screenshots in [`apps/showcase/screenshots/`](apps/showcase/screenshots/).

---

## Feature surface (through v1.3 on `main`)

### Renderer + interaction (v0.0.6–v0.0.10)
| Category | Status |
|---|---|
| Canvas-2D renderer (10M rows with variable row heights via Fenwick; 1B rows with a uniform height, no per-row storage) | shipped |
| Column virtualization (visible-range narrowing in draw loops) | shipped (v0.0.10) |
| Adaptive overscan (EMA-smoothed velocity + direction-aware split) | shipped (v0.0.10) |
| rAF discipline + dirty-state gate (no idle-loop battery drain) | shipped (v0.0.10) |
| Frozen columns | shipped |
| Sort (single + multi-column) | shipped |
| Filter (quick-filter, per-column rules, set filter with distinct counts, floating filter row) | shipped |
| In-memory column index for quick filter + set-filter values (`createTableIndex` / `filterIndexed` / `enumerateDistinctIndexed`) | shipped |
| Range selection (drag, shift-click, ctrl-click multi-range, shift+arrow extend) | shipped |
| Range fill-handle (Excel-style drag-to-extend) | shipped |
| Clipboard copy (TSV) + paste (TSV → onPaste hook) | shipped |
| Cell editing (F2/Enter/double-click/type-ahead, Tab/Enter/Escape) | shipped |
| Cell editor variants (select / date / textarea) + IME composition guard + sync/async validation | shipped |
| Tooltip system (single shared `<div role=tooltip>`, hover delay, Escape/scroll dismiss) | shipped |
| Custom cell renderers (pool + overlay layer in core; React-adapter-flavoured factory) | shipped |
| Master-detail expandable rows with DOM detail layer | shipped |
| Nested oneGrids inside detail panels (with `onDetailUnmount` lifecycle) | shipped |
| Tree data (hierarchical row model with lazy-load children) | shipped |
| Server-side hierarchical fetches (`BlockRequest.parentId` + `HierarchyEntry`) | shipped |
| Pinned top + bottom row sources | shipped |
| Column groups (header tree band) | shipped |
| Status bar (selection aggregates: count/sum/avg/min/max) | shipped |
| Row grouping with aggregations + collapse/expand chevrons | shipped |
| Sticky group rows (topmost ancestor pins to data band top while scrolled) | shipped |
| Pivot tables (bucketed compute → materialized output table) | shipped |
| Column drag-drop reorder (header drag with vertical drop indicator) | shipped |
| Column tool panel / sidebar (React `<ColumnToolPanel>` for show/hide + within-panel reorder) | shipped |
| Context menu (cell/header/empty target resolution, native menu suppressed) | shipped |
| Selection-checkbox column (`createSelectionCheckboxColumn` + `<SelectAllCheckbox>`) | shipped |
| In-cell sparklines (line / bar / winloss) | shipped (v0.0.10) |

### Data + adapters (v0.0.8)
| Category | Status |
|---|---|
| Server-side row model (cursor + block cache + optimistic mutations) | shipped |
| Server-side set-filter values (`fetchDistinct`; Postgres + DuckDB), debounced + cancellable query changes, recent-query block retention | shipped |
| Real database adapters: Postgres, MySQL, SQLite, ClickHouse, Mongo | shipped (v0.0.8) |
| Universal CDC adapter shape + monotonic row-diff stream + resync protocol | shipped (v0.0.8) |
| Schema introspection (`@onegrid/introspect`) | shipped (v0.0.8) |
| Arrow IPC ingestion (`application/vnd.apache.arrow.stream`) | shipped (v0.0.8) |
| BigInt-safe formula path (precision past 2^53 for int64 columns) | shipped (v0.0.10) |
| Formula engine (parser, dep graph, range nodes, Adapton-style recompute, 457 built-in fns) | shipped (457/480 at v1.1.0) |
| DuckDB-WASM as a backing engine | shipped |
| Cross-database SQL joins via DuckDB-WASM (`@onegrid/duckdb-join`) | shipped (v0.1.0) |
| Web Worker offload for sort / filter / group / pivot (`@onegrid/data-worker`); numeric jobs on an `@onegrid/wasm` kernel | shipped (v0.0.10) |
| DBSP operator algebra + incremental view maintenance (`@onegrid/dbsp`) | shipped (v0.0.10) |
| CSV + XLSX export | shipped |
| `@onegrid/migrate` CLI (config translator, AST-based) | shipped |
| ORM adapters: Drizzle, Kysely | shipped |
| Framework adapters: React, Vue, Svelte, Solid, Angular, Web Components | shipped |

### Extensibility + ergonomics (v0.0.9)
| Category | Status |
|---|---|
| Plugin / extension framework (`@onegrid/plugin-kit` — facets, compartments, 10 registries) | shipped (v0.0.9) |
| Design tokens — DTCG 2025.10 themes + density (`@onegrid/tokens`) | shipped (v0.0.9) |
| Nested config + `defineGridOptions` migration | shipped (v0.0.9) |
| Headless contract — Lit-`ReactiveController` lifecycle (`@onegrid/headless`) | shipped (v0.0.9) |
| Per-package bundle-budget CI (`pnpm bundle:check` with [budget-bump: pkg] escape hatch) | shipped (v0.0.9) |
| i18n / l10n / RTL (`@onegrid/intl` — Intl.\*, ICU MessageFormat subset, BCP 47) | shipped (v0.0.9) |
| Touch / mobile (`@onegrid/touch` — gestures, touch CSS, VirtualKeyboard) | shipped (v0.0.9) |
| Worker-boundary plugin sandbox (`@onegrid/worker-plugins`) | shipped (v0.0.9) |
| Error boundaries, schema-evolution, RLS, deprecation policy, test harness, print/export, validators, feature-flags | research-pending (v0.0.9.x) |

### Moats (v0.0.11)
| Category | Status |
|---|---|
| Model Context Protocol surface (`@onegrid/mcp`) | shipped (v0.0.11) |
| Time-travel — diff log, snapshotAt, branch, invertDiff (`@onegrid/temporal`) | shipped (v0.0.11) |
| AI integration — NL → typed intents, BYO-LLM (`@onegrid/ai`) | shipped (v0.0.11) |
| Live ORM sync — Drizzle / Kysely / Prisma (`@onegrid/orm-sync`) | shipped (v0.0.11) |
| Collaborative editing — Yjs / Automerge bridges (`@onegrid/crdt`) | shipped (v0.0.11) |
| Salsa-style reactivity substrate (`@onegrid/reactive`) | shipped (v0.0.11; formula migration in v0.0.11.x) |

### WebGPU (v0.0.5 → v0.1.0)
| Category | Status |
|---|---|
| GPU compute kernels: parallel reduce + predicate→mask filter | shipped (v0.0.5) |
| GPU hash-aggregate (atomic-CAS spin loop for f32 sums) | shipped (v0.1.0) |
| WebGPU render scaffold (device + cell-quad pipeline + MSDF text shader + per-cell vertex buffer protocol) | shipped (v0.1.0) |
| Canvas → WebGPU paint-loop port (full renderer replacement) | scaffold landed; full migration in v0.1.0.x |

### Stable track (v1.0)
| Category | Status |
|---|---|
| Public API surface freeze + semver guarantees (`docs/SURFACE.md`, `docs/SEMVER.md`) | shipped (v1.0.0 RC) |
| WCAG 2.1 A/AA axe-core gate across playground modes + tool panels + filters | shipped (v1.0.0) |
| External security audit | pending |

### Formulas + spreadsheet interop (v1.1)
| Category | Status |
|---|---|
| Formula library to 457/480 functions (LAMBDA family, dynamic-array spilling, structured refs + named ranges, CJK locale) | shipped (v1.1.0) |
| OOXML `.xlsx` formula round-trip — read + write, evaluated through the engine (`@onegrid/xlsx`, clean-room from ECMA-376) | shipped (v1.1.0) |
| CRDT live collaboration — field-granularity + presence (`@onegrid/crdt`) | shipped (v1.1.0) |

### Interaction polish (v1.2)
| Category | Status |
|---|---|
| Drag-to-resize columns (including frozen) + rows; auto-size column to content | shipped (v1.2.0) |
| Cell flash on update; loading / no-rows overlays surfaced | shipped (v1.2.0) |
| Find / replace within cells (in-host toolbar + `onReplace`) | shipped (v1.2.0) |
| Row drag-reorder + mid-table row pinning; multi-row drag-reorder (`onRowReorder(fromRow, toRow, movedRow)`) | shipped (v1.2.0) |

### Tool panels (v1.3)
| Category | Status |
|---|---|
| Drag-to-group pill bar (`enableGroupBar` → `onRowGrouping`) | shipped (v1.3.0) |
| Aggregation side panel (per-column aggregator → `onAggregationChange`) | shipped (v1.3.0) |
| Filter side panel (per-column operator + value, batched → `onFilterModelChange`) | shipped (v1.3.0) |
| Pivot side panel (rows / columns / values bins → `onPivotChange`) | shipped (v1.3.0) |
| Status-bar plugin surface; per-feature controlled-state overlays | planned (v1.3.x) |

Every tool panel is host-mounted DOM emitting protocol-shaped callbacks — `@onegrid/core` computes no grouping / filter / pivot itself; the consumer wires the callback to `@onegrid/data` and feeds results back.

### Distribution
| Category | Status |
|---|---|
| npm publish readiness (manifests, READMEs, LICENSEs, changesets, release workflow — see `PUBLISHING.md`) | ready; blocked on `@onegrid` org claim + `NPM_TOKEN` |
| Documentation site (Astro Starlight, `apps/docs`) | built; blocked on hosted URL |

### Roadmap ahead
- **v0.1.0.x** — canvas→WebGPU paint-loop migration, hash-agg linear probing, Slug-style per-curve text
- **v1.3.x** — status-bar plugin surface, per-feature controlled-state overlays
- **v1.4.0** — range charts, sparkline column type, multi-rectangle clipboard, drag-fill series patterns
- **Operational** — claim `@onegrid` npm org + publish 1.0.0; deploy the docs site + live demo (see [ROADMAP.md](ROADMAP.md) for the full operational track)
- **v1.1.0** — spreadsheet-grade compat: ~460 Excel functions, dynamic arrays + spilling, structured table refs, R1C1 mode, OOXML interop

---

## Development

```bash
pnpm install
pnpm build
pnpm test
pnpm typecheck
pnpm bench       # playwright performance suite
pnpm dev         # playground + mock SSRM server
```

Requires Node 20.10+ and pnpm 9+.

Query cost at database scale — needs the DuckDB CLI on `PATH` (or `DUCKDB=/path/to/duckdb`) and a built `@onegrid/duckdb`:

```bash
node apps/benchmarks/billion-db/run.mjs build <file.duckdb> <rows>   # reproducible benchmark table
node apps/benchmarks/billion-db/run.mjs bench <file.duckdb>          # time each grid query; non-zero exit on any query error
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution workflow.

---

## License

[MIT](LICENSE) — for all packages, no exceptions, no paywalled features.
