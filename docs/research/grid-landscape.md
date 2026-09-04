# The data-grid landscape

A survey of every data grid, spreadsheet component and database-table UI worth
knowing about, read from the vendors' own current documentation.

**Surveyed:** 2026-09-04 · **Entries:** see `grid-registry.json`

---

## Why this document exists

oneGrid's positioning claim is "one MIT-licensed grid that consolidates what
real applications need at scale." That claim is only meaningful against a
measured field. This document is the measurement.

It is written for three specific decisions:

1. **Where the tier line actually falls.** Almost every serious grid is
   free-until-you-need-it. Knowing *exactly* which feature triggers a licence
   purchase tells us which features are worth shipping MIT, because those are
   the ones people are currently paying for.
2. **DOM vs canvas.** This is the fork in the road for a grid's architecture,
   and it determines the row ceiling, the accessibility story and whether a
   consumer's CSS carries over. Every entry records which side it took.
3. **What is genuinely hard to replicate.** Feature lists are cheap. The
   `distinctive` field on each entry is the honest answer to "what would we
   actually struggle to build?"

## Method, and its limits

- Findings come from **publicly-published documentation, marketing pages and
  public repositories**, fetched during the survey — not from recall. Each entry
  cites the pages it was derived from.
- This inherits the clean-room rule in
  `packages/migrate/src/transforms/ag-grid.ts`: no third-party source code, type
  definitions or non-public documentation was consulted.
- Where a vendor does not document a capability, the entry says **`not
  documented`** and cites the page that was checked. That is a real finding. It
  is never a guess, and the words "probably" and "likely" do not appear in a
  field value.
- **Limits worth stating.** Documentation lags implementation, marketing pages
  overstate, and several of these products ship weekly. Version-sensitive claims
  (function counts, tier boundaries, pricing) are the first thing to rot here.
  Nothing below was verified by building an application against it.

## Scope boundary

Deliberately excluded, recorded so it is not re-litigated:

- **Virtualization primitives with no grid semantics** — `react-window`,
  `react-virtual`, TanStack Virtual. They solve one axis of the problem and are
  a dependency of several entries below, not competitors to them.
- **Charting libraries with an incidental table view.**
- **BI and dashboard products where the grid is not embeddable by a developer** —
  Tableau, Power BI, Looker.

Categories used: `oss` (permissive, single tier), `hybrid-tier` (a free tier
plus a paid one), `commercial` (paid), `db-ui` (a table UI over a database
rather than a component you embed).

---

## The field at a glance

*(Comparison matrix is generated after the per-entry sections below. See
"Cross-cutting findings" at the end for the synthesis.)*

---

## Entries

### AG Grid {#grid:ag-grid}

- **license:** Open-core, two editions. **Community = MIT** (`ag-grid-community`); **Enterprise = commercial EULA** (`ag-grid-enterprise`), trialable but requiring a paid key in production. The line is sharp and unusually high: Community gets rows/columns, sorting, filtering, pagination, cell renderers, themes, keyboard nav and ARIA, and row+column virtualization. Enterprise gates **row grouping, aggregation, pivoting, master/detail, tree data, integrated charts, cell/range selection and range operations, the tool panels and sidebar, custom context menu, advanced clipboard, styled Excel export, and the Server-Side and Viewport row models**. An "Enterprise Bundle" pairs AG Grid Enterprise with AG Charts Enterprise. Practically: anything an analyst would call "analytics" is paid; anything a developer would call "a table" is free.
- **rendering:** DOM. Documented as rendering roughly 40 visible rows at a time regardless of dataset size, with both row and column virtualization in the Community build.
- **virtualization:** Row + column, both in Community. No hard ceiling documented; the client-side guidance is that 100k+ rows is fine because render count is bounded by the viewport, and the docs advise switching row models only when *network transfer or data extraction* becomes the bottleneck, not rendering.
- **nesting:** All four exist. Row grouping (Enterprise), tree data (Enterprise, `TreeDataModule` — hierarchy expressible three ways: `getDataPath` path arrays, `treeDataChildrenField` nested children, or `treeDataParentIdField` parent-id links), and master-detail (Enterprise). A grid **can** contain another full grid: `detailGridOptions` takes a complete `GridOptions<TDetail>`, so the detail is a real AG Grid with its own columns and its own row model. Constraint: the *master* grid must use Client-Side or Server-Side row model — not Viewport or Infinite.
- **charting:** Yes — Integrated Charts, Enterprise-gated, requiring both `IntegratedChartsModule` and a charts engine module (`AgChartsCommunityModule` or `AgChartsEnterpriseModule`). A user drags a cell range (needs `cellSelection: true`), right-clicks, and picks a type from the "Chart Range" context sub-menu; the chart then stays live against grid sorting and filtering. Choosing AG Charts Enterprise adds twelve further chart types (polar: radar line/area, nightingale, radial column, radial bar; statistical: box plot, range bar, range area; hierarchical).
- **formula:** not documented as an Excel-style formula engine. The docs surface formulas only as an *Excel export* concern (writing formulas into exported .xlsx) and via aggregation functions; there is no in-grid recalculation engine on the licensing or pivot pages checked.
- **pivot:** Yes, Enterprise (`PivotModule`). Client-side pivot works only with the Client-Side Row Model and only in combination with row grouping; the Server-Side Row Model separately supports server-side pivot. Two distinct states — `pivotMode: true` (infrastructure on, non-aggregated columns hidden) versus pivot *active* (a column actually acting as a column label, generating pivot result columns). Documented limitation: pivoting with tree data is not supported.
- **editing:** Cell editing with provided and custom editors in Community. Range selection, range manipulation and the advanced clipboard (Excel-grade copy/paste behaviour) sit in Enterprise, as does styled Excel export. CSV export is Community.
- **framework:** JavaScript/TypeScript, React, Angular, Vue.
- **dataModel:** Four row models — **Client-Side** (Community, everything in memory), **Infinite** (Community, block-wise scroll loading of a flat list), **Server-Side** (Enterprise; adds lazy-loaded groups, server-side grouping/aggregation/pivot, partial store), **Viewport** (Enterprise; the server is told the exact first/last visible row index and pushes only those — built for live streams where updates target the users actually looking at a row). No direct database integration; the docs ship full-stack reference examples (Node/MySQL, Java/Oracle, GraphQL/MySQL, Java/Spark) but you build the server layer.
- **distinctive:** The **module system plus the row-model matrix** is the moat, not any single feature. Since v33 (docs read at v36.1.0) features ship as registrable modules — `ModuleRegistry.registerModules([...])`, or per-grid via the `modules` property on `createGrid()` so two grids in one app can carry different feature sets, with `api.isModuleRegistered()` and `enableDevValidations()` for diagnosis, and `AllCommunityModule`/`AllEnterpriseModule` as escape hatches. Combined with four row models that let the *same* grouping/pivot UI run either in-browser or pushed down to a server, this is the thing a competitor cannot cheaply replicate: it is years of API surface, not a feature.

Sources: https://www.ag-grid.com/javascript-data-grid/licensing/, https://www.ag-grid.com/javascript-data-grid/modules/, https://www.ag-grid.com/javascript-data-grid/row-models/, https://www.ag-grid.com/javascript-data-grid/server-side-model/, https://www.ag-grid.com/javascript-data-grid/pivoting/, https://www.ag-grid.com/javascript-data-grid/tree-data/, https://www.ag-grid.com/javascript-data-grid/master-detail/, https://www.ag-grid.com/javascript-data-grid/integrated-charts/

### TanStack Table {#grid:tanstack-table}

- **license:** MIT, single tier, no paid edition and no gated features.
- **rendering:** **None.** This is the defining property. It is a headless library providing "the logic, state, processing, and APIs for UI elements" while deliberately omitting "markup, styles, or pre-built implementations." You write every `<tr>` yourself. There is no DOM/canvas answer because the library never touches the document.
- **virtualization:** **None, deliberately.** The docs state the packages ship no virtualization APIs and direct users to compose with TanStack Virtual, react-window or similar. No row ceiling is documented because the ceiling is whatever your own renderer can take.
- **nesting:** Row expanding, row grouping and aggregation exist as *state and model* features (among 17 built-in features, alongside cell/row selection, filtering and faceting, sorting, pagination, column pinning/resizing/ordering/visibility, row pinning, cell spanning). Master-detail and "a grid inside a grid" are not library concerns — you render whatever you want in an expanded row, so nesting is trivially possible and entirely your code.
- **charting:** not documented — out of scope by design; the docs position composition with sibling libraries (Query, Virtual, Form) rather than charting.
- **formula:** not documented. No formula engine; aggregation functions are the only computed-value mechanism.
- **pivot:** not documented as a pivot feature. Grouping + aggregation give the raw material, but there is no pivot-table construct in the feature list.
- **editing:** not documented as a feature. There is no editor, no validation, no clipboard, no fill handle, no undo — editing is entirely the consumer's responsibility, consistent with headless design.
- **framework:** The broadest adapter list in this set: React, Preact, Vue, Solid, Svelte, Angular, Ember, Lit, Alpine, Octane, plus framework-free `@tanstack/table-core`.
- **dataModel:** Client-side models only, with manual modes — you can flip sorting/filtering/pagination to server-controlled and feed the table pre-processed rows, but the library performs no fetching. No infinite/viewport row model, no database integration.
- **distinctive:** It is the **anti-grid**: v9 is ~25 KB min+brotli and modular, bundling only the features you register, because it ships zero pixels. That is simultaneously its moat (it composes with any design system without fighting vendor CSS, and it is the only entrant with ten framework adapters) and the gap a competitor exploits — a team choosing TanStack still has to build virtualization, editing, and every visual affordance themselves.

Sources: https://tanstack.com/table/latest/docs/overview, https://tanstack.com/table/v8/docs/guide/virtualization, https://github.com/TanStack/table/blob/main/docs/guide/virtualization.md

### MUI X Data Grid {#grid:mui-x-data-grid}

- **license:** Open-core, three tiers, and the exact line matters because the marketing pricing table is easy to misread. **Community (MIT, `@mui/x-data-grid`)**: editing, sorting, filtering, pagination, selection, virtualization, accessibility, localization. **Pro (commercial, `@mui/x-data-grid-pro`, $299/dev/yr)**: advanced/multi filtering, header filters, column pinning, column and row reordering, **tree data**, master detail. **Premium (commercial, `@mui/x-data-grid-premium`, $599/dev/yr)**: everything in Pro plus **row grouping, aggregation, pivoting, Excel export, charts integration, and the AI assistant** — each of those pages carries an explicit "Premium plan" badge and requires the `DataGridPremium` component. Licence count must equal the number of concurrent developers touching front-end code.
- **rendering:** DOM, React-only, built on the MUI/Material design system.
- **virtualization:** Row + column virtualization, and it is in the **MIT tier** — the Community overview lists virtualization among the free capabilities. (The pricing-page rendering suggesting virtualization is Pro-only is not borne out by the Data Grid docs.) No row ceiling documented.
- **nesting:** Tree data (Pro), master detail (Pro), row grouping (Premium). Detail panels render arbitrary React, so a grid can contain another grid.
- **charting:** Yes, and it is the newest tier-defining feature — **Premium only**. Enabled by the `chartsIntegration` prop plus a `<GridChartsPanel />` in the `chartsPanel` slot, wired through `GridChartsIntegrationContextProvider` / `GridChartsRendererProxy` from the Premium data grid package and a `ChartRenderer` from `@mui/x-charts-premium`. Notably it requires the Premium *charts* package too, not just the Premium grid.
- **formula:** not documented. Aggregation functions (sum, average, etc.) exist at Premium, but there is no Excel formula engine on the Data Grid docs checked.
- **pivot:** Yes — **Premium**, `DataGridPremium`, drag-and-drop configuration of rows/columns/values from the toolbar. Both client-side and server-side pivoting are documented; the feature is marked new but documented as production-ready.
- **editing:** Cell and row editing in the MIT tier, with editors, validation and controlled edit state. **Clipboard paste is Pro**; CSV, print and clipboard *export* are available from the base grid, while **Excel export is Premium**.
- **framework:** React only.
- **dataModel:** Client-side by default; server-side data source support for sorting/filtering/pagination, lazy loading, and server-side pivot at Premium. No direct database integration.
- **distinctive:** The **AI assistant (Premium)** is the thing none of the others in this set ship: users type "sort by name" or "show amounts larger than 1000" in natural language and the grid's state — filters, sorts, visualisations — updates accordingly, via either MUI's hosted processing service with an API key or a backend you host. Beyond that, the real pull is being the native grid for the largest React design system on earth, which is a distribution moat rather than a technical one.

Sources: https://mui.com/x/introduction/licensing/, https://mui.com/x/react-data-grid/, https://mui.com/pricing/, https://mui.com/x/react-data-grid/aggregation/, https://mui.com/x/react-data-grid/pivoting/, https://mui.com/x/react-data-grid/row-grouping/, https://mui.com/x/react-data-grid/export/, https://mui.com/x/react-data-grid/ai-assistant/, https://mui.com/x/react-data-grid/charts-integration/

### Handsontable {#grid:handsontable}

- **license:** **Proprietary, dual-track — and it is not open source.** Two options: a free **Non-Commercial** licence covering "research, private study, and evaluation," which explicitly forbids reaching production if the project is "in any way connected with your commercial activity"; and a paid **Commercial** licence for everything else, quoted by sales. Both require a `licenseKey` in config; the non-commercial key is the literal string `non-commercial-and-evaluation`. Historically MIT through **v6.2.2 (December 2018)**, then relicensed — which is why stale advice calling it "the open-source spreadsheet grid" is wrong. This is the sharpest trap in the survey: the split is not by *feature* but by *who you are*.
- **rendering:** DOM.
- **virtualization:** Row + column, both documented as separate guides. No hard ceiling is published; instead the docs offer tuning knobs — pre-rendered row/column counts, constant row heights and column widths to skip measurement, batched operations that suspend rendering — and recommend pagination when "struggling with performance" on thousands of rows. That recommendation is itself a finding: it implies the virtualization is not the unconditional answer AG Grid's is.
- **nesting:** Nested rows and nested headers exist as features, plus collapsible columns. Master-detail and grid-in-a-grid are not the model, though the **`handsontable` cell editor type embeds a Handsontable instance inside a cell editor** — a grid inside a cell, not inside a row.
- **charting:** not documented — no integrated charting product on the pages checked.
- **formula:** **Yes, and this is the headline.** Powered by **HyperFormula**, a separate calculation engine, exposing roughly **400 built-in functions** across math, engineering, statistical, financial and logical categories, with cross-sheet references, named expressions, and relative-reference adjustment on autofill that matches spreadsheet behaviour. Licensing subtlety: a HyperFormula instance bound to Handsontable uses the key `'internal-use-in-handsontable'`, but using HyperFormula standalone (e.g. server-side) requires its own dedicated licence key.
- **pivot:** not documented.
- **editing:** The strongest editing story in the set. **Ten built-in editors** (autocomplete, checkbox, date, dropdown, handsontable, numeric, password, select, text, time), cell validators with `finishEditing()` validate-or-restore semantics, a **CopyPaste plugin writing both `text/plain` and `text/html`** so round-trips with Excel and Google Sheets preserve structure, an **Autofill plugin** with a real drag fill handle (plus double-click to fill down and a drag-preview border), and an **UndoRedo plugin** stacking value changes, row/column insert and remove, sorting, filtering, moves, merge/unmerge and alignment — explicitly *not* tracking resize, hide, or trim.
- **framework:** JavaScript/TypeScript, React, Angular, Vue 3, with SSR examples for Next.js, Astro, Remix and Nuxt.
- **dataModel:** Client-side. No server-side/infinite/viewport row model is documented; pagination is the recommended answer to large data. No direct database integration.
- **distinctive:** It is a **spreadsheet, not a developer grid** — the design centre is a user who expects Excel muscle memory (fill handle, merged cells, context menu, ~400 formula functions, HTML-fidelity clipboard) rather than a developer who expects a data-bound component. The moat is HyperFormula: a real, separately-maintained calculation engine with spreadsheet-accurate reference semantics is a multi-year build, and it is the single hardest thing on this list to replicate. The counterweight for an MIT competitor is that Handsontable's licence disqualifies it outright for most commercial teams that will not pay.

Sources: https://handsontable.com/docs/react-data-grid/software-license/, https://handsontable.com/docs/javascript-data-grid/, https://handsontable.com/docs/javascript-data-grid/formula-calculation/, https://handsontable.com/docs/javascript-data-grid/cell-editor/, https://handsontable.com/docs/javascript-data-grid/basic-clipboard/, https://handsontable.com/docs/javascript-data-grid/autofill-values/, https://handsontable.com/docs/javascript-data-grid/undo-redo/, https://handsontable.com/docs/javascript-data-grid/performance/

### Glide Data Grid {#grid:glide-data-grid}

- **license:** **MIT**, single tier, explicitly "free for commercial projects," maintained by Glide (the no-code app company) as a byproduct of their own product. No paid edition, no gated features, no licence key.
- **rendering:** **Canvas** — and the README states the reasoning outright: virtualized DOM rendering collapses under churn, since "once you need to load/unload hundreds of DOM elements per frame nothing can save you." This is the architectural fork in the road, and within this survey it is one of only a handful of canvas grids.
- **virtualization:** Row + column via lazy cell rendering; documented as scaling to **millions of rows**, with native (not JS-emulated) scrollbars and a claimed throughput of hundreds of thousands of updates per second. No ceiling published.
- **nesting:** Not a nesting-oriented grid. Merged cells and variable row heights exist; drilldown cells exist as a cell *type*. Master-detail, tree data, row grouping and grid-in-a-grid are **not documented** on the pages checked.
- **charting:** Partial — there is no charting product, but **inline sparkline cells** for time-series are built in as a cell renderer. No range-select-and-chart flow.
- **formula:** not documented. No formula engine.
- **pivot:** not documented.
- **editing:** Built-in cell editing, resizable and movable columns, single and multi row/cell selection, merged cells, search. Notably, **filtering and sorting are the consumer's job** — the grid is data-source agnostic and asks only for column definitions, a row count, and a `getCellContent` function. Clipboard support exists; a fill handle and undo are not documented on the pages checked.
- **framework:** React only (React 16–19), full TypeScript, Next.js via dynamic import.
- **dataModel:** Pure pull model — you supply `getCellContent(cell)` and a row count, so the grid is indifferent to whether data is local, paged, or streaming. There is no built-in row model taxonomy and no database integration; async/streaming sources are supported by returning loading cells.
- **distinctive:** **Canvas rendering with a hidden-DOM accessibility layer.** Because canvas is invisible to assistive technology, the grid maintains a DOM structure mirroring visible cells, with ARIA roles and keyboard navigation, so it can claim "first class accessibility." Critically, the maintainers are candid that "none of the primary developers are accessibility users so there are likely flaws in the implementation we are not aware of" — the precise, honest statement of the canvas trade-off. For a competitor this is the key strategic read: canvas buys the millions-of-rows and updates-per-second numbers, and the bill is that accessibility, text selection, browser find, and DOM-based testing all become things you must rebuild by hand.

Sources: https://grid.glideapps.com/, https://github.com/glideapps/glide-data-grid, https://docs.grid.glideapps.com/

### RevoGrid {#grid:revogrid}

- **license:** **Open-core, and this is a change worth flagging — it is no longer purely MIT.** The core remains MIT ("MIT core, always free… 0 royalties"), but there is now a commercial **RevoGrid Pro** tier advertising **58 additional features across 13 categories**: audit trails, collaborative editing, Excel import/export, smart auto-fill, hierarchical data views, row transpose, cell merging, column grouping, drill-down, **pivot tables, charts, heatmaps, conditional formatting**, Gantt, Kanban, Scheduler, and server-side grouping / infinite scroll / remote pagination. Pro ships as the *same component* with capabilities switched on — "no plugin sprawl, no separate bundles, no migration when you go from MIT to Pro" — distributed via a 30-day public npm trial. Pricing is on a separate page and was not stated on the Pro page checked.
- **rendering:** DOM, via **StencilJS-compiled Web Components** with a "VNode Reactive DOM" that re-renders only changed parts rather than the whole grid.
- **virtualization:** Row + column ("virtual rows and columns keep rendering fast as datasets grow"). No documented row ceiling or capacity number.
- **nesting:** Tree structures and grouping are in the MIT core; hierarchical data views, column grouping and drill-down are listed as Pro. Grid-in-a-grid is **not documented**, though native framework components can be embedded inside cells.
- **charting:** Charts and heatmaps are listed as **Pro** features. Range-select-to-chart is not documented.
- **formula:** not documented in the core; the Pro feature list names "smart auto-fill" but no formula engine appears on the pages checked.
- **pivot:** Yes — but **Pro only**; not present in the MIT core.
- **editing:** Core includes focus management, range selection, inline editing, sorting, filtering, column and row pinning, real-time updates, and export to CSV, PDF and Excel. Smart auto-fill, Excel import/export and collaborative editing are Pro. Undo and validation are not documented on the pages checked.
- **framework:** The broadest reach per line of code here, because Web Components mean one core with thin wrappers: React, Angular, Vue 2 and 3, Svelte, Stencil, TypeScript, plain JS, plus **Dash/Python** for data-science workflows.
- **dataModel:** Client-side core with documented server-side data operations; server-side grouping, infinite scroll and remote pagination are Pro. No direct database integration.
- **distinctive:** **One Web Component, five-plus frameworks, one API** — it solves the framework-matrix problem at the compiler level (Stencil) instead of maintaining N hand-written wrappers, and the Dash/Python binding is a distribution channel no other grid here targets. The strategic read for an MIT competitor: RevoGrid is the closest analogue in positioning, and it has recently drawn its own paid line — meaning the "MIT grid with pivot and charts included" slot it used to occupy is now partly vacated.

Sources: https://rv-grid.com/guide/, https://rv-grid.com/guide/overview, https://rv-grid.com/guide/plugin/, https://rv-grid.com/pro/

### Tabulator {#grid:tabulator}

- **license:** **MIT, single tier, no commercial edition** — confirmed on the npm registry metadata for `tabulator-tables` v6.5.2. Everything the project ships is free, which makes it the most feature-complete genuinely-MIT grid in this set.
- **rendering:** DOM with a **virtual DOM** renderer: it "only renders the rows you see in the table (plus a few above and below the current view) and creates and destroys the rows as you scroll."
- **virtualization:** Row virtualization by default, plus **horizontal virtual DOM** (added in the 4.8 line) for wide tables. Render mode is selectable between basic and virtual. No documented row ceiling.
- **nesting:** Strong. Row grouping via a `groupBy` option; **tree data** for collapsible nested row sets; and genuine **nested tables** — the `rowFormatter` callback is the documented mechanism for creating "tables nested in other tables," so a grid can contain another grid. Group headers, data trees and column calculations all survive into exported files.
- **charting:** not documented — no built-in charting.
- **formula:** No Excel formula engine. The nearest equivalent is **column calculations**: configurable top/bottom calculation rows with built-in functions (avg, sum, min, max, count, etc.) and custom calculators. Confirmation of the calc page was blocked (HTTP 403 on `tabulator.info/docs/6.x/calc`); no formula engine appears anywhere in the documented module list.
- **pivot:** not documented.
- **editing:** Full editing module with editors and validators, **cell range selection** (shift+drag or shift+arrows to expand, ctrl to add disjoint ranges), a clipboard module for bulk copy/paste between cells and sheets, and download/export to CSV, JSON, XLSX (`table.download("xlsx", …)`), PDF and HTML.
- **framework:** Framework-agnostic vanilla JS core with documented use alongside React, Angular and Vue; instantiable from an existing HTML `<table>`, a JS array, or JSON.
- **dataModel:** Local arrays plus ajax remote data, remote/server-side pagination, and progressive loading (infinite scroll). Direct fetch of the `6.x/data` page returned HTTP 403, so the server-side sort/filter specifics are cited from the download and release docs rather than read directly. No database integration.
- **distinctive:** **Spreadsheet Mode** — a dedicated module that lays out columns and rows, handles **multiple sheets of data** with navigable footer tabs (`spreadsheetSheetTabs`), and maps data in and out in array format. Combined with the range-selection, edit and clipboard modules it gives "a fully functional spreadsheet that allows for bulk copying and pasting of data between cells and sheets." That a multi-sheet spreadsheet surface, tree data, nested tables and XLSX export all sit under MIT with no paid tier is the finding that matters most for a team building an MIT competitor: Tabulator, not AG Grid Community, is the real free-tier benchmark to beat.

Sources: https://github.com/olifolkerd/tabulator, https://registry.npmjs.org/tabulator-tables/latest, https://www.tabulator.info/docs/6.x/spreadsheet/, https://www.tabulator.info/docs/6.x/range/, https://www.tabulator.info/docs/6.x/tree/, https://www.tabulator.info/docs/6.x/download/, https://tabulator.info/docs/4.8/release

### DataTables {#grid:datatables}

- **license:** **Core is MIT** and has been since **1.10**; versions **1.9 and earlier were dual-licensed GPL v2 + BSD 3-clause**, so the project moved *toward* permissiveness — the opposite direction from Handsontable. Fifteen-odd extensions are also free (AutoFill, Buttons, ColReorder, ColumnControl, DateTime, FixedColumns, FixedHeader, KeyTable, Responsive, RowGroup, RowReorder, **Scroller**, SearchBuilder, Select, StateRestore). The paid layer is **DataTables Plus** — a separate commercial licence covering **Editor** (full editing UI with server-side libraries) and **CardView** — priced per developer: **$219 for 1 dev ($88/yr renewal)**, $999/5, $1,699/10, $3,225/20+, with a 15-day trial. Core stays MIT regardless.
- **rendering:** DOM. Current version is **3.0.3**.
- **virtualization:** Not in core — core renders the page you are on. Virtual scrolling is the **Scroller** extension (free), "a virtual renderer for DataTables, allowing the table to look like it scrolls for the full data set." No documented row ceiling; the scale answer is server-side processing, which the FAQ describes as handling "millions of rows."
- **nesting:** **RowGroup** (free extension) gives visual grouping with aggregation. Child rows are a core concept and can hold arbitrary HTML — including another DataTable — so grid-in-a-grid is achievable, though tree data and a first-class master-detail construct are **not documented** as named features.
- **charting:** not documented.
- **formula:** not documented. No formula engine.
- **pivot:** not documented — no pivot feature in the core or the extension list.
- **editing:** Core has none; editing is the **commercial Editor extension** (multiple editing modes, inline/bubble/form, with matching server-side libraries). Free adjuncts: **AutoFill** (Excel-like drag fill), **KeyTable** (Excel-style cell navigation), **Select**. Clipboard export sits in the free Buttons extension. Undo is not documented.
- **framework:** Styling integrations for eight frameworks (DataTables default, Bootstrap 3/4/5, Bulma, Foundation, jQuery UI, Fomantic UI) and official **React and Vue** components.
- **dataModel:** Client-side by default; **server-side processing** via the `serverSide` option, where the server performs paging, sorting and filtering and returns JSON including a `draw` token that must echo the request count (the classic anti-race guard). No direct database integration in the browser library, though Editor ships server-side libraries that do talk to databases.
- **distinctive:** **The jQuery dependency is gone — as of DataTables 3.** DataTables 2 kept "a single dependency on jQuery" as a DOM-abstraction and event layer; DataTables 3 ships with **zero external dependencies** while still operating identically *with* jQuery for backwards compatibility, and the global `DataTable` object and the jQuery plugin interface are equivalent so both styles can coexist on one page. Anyone still describing DataTables as "the jQuery table plugin" is one major version out of date. Beyond that it is closer to a **progressive-enhancement table** than a modern component grid — its distinguishing move is starting from existing server-rendered HTML `<table>` markup, a genuinely different entry point from every other grid here, but the feature set (no pivot, no charts, no formulas, editing behind a paywall) is otherwise commodity.

Sources: https://datatables.net/license/, https://datatables.net/manual/core/jquery, https://datatables.net/blog/2024/datatables-2, https://datatables.net/download/, https://datatables.net/extensions/index, https://datatables.net/plus/, https://datatables.net/faqs/index

### Grid.js {#grid:gridjs}

- **license:** MIT, single tier, no commercial edition. The npm `gridjs` package declares `"license": "MIT"` and the GitHub repo's license metadata resolves to `MIT`. Everything documented — plugins, server-side mode, the framework wrappers — is in the free package.
- **rendering:** DOM. It ships Preact as its one runtime dependency (`preact: ^10.11.3`) and renders a real `<table>`; the plugin docs state plainly that "a Grid.js plugin is a Preact Functional Component that render a Virtual Node." No canvas or WebGL anywhere in the source tree.
- **virtualization:** None. A search of the whole `grid-js/gridjs` repository for the string `virtual` returns zero code matches, and the source tree has no viewport/windowing module — the row-limiting layer is `src/pipeline/limit/pagination.ts` and `serverPagination.ts`. Pagination *is* the scaling story: `pagination.limit` bounds what is in the DOM. No row ceiling is documented, because there is no windowing to state one for.
- **nesting:** not documented. There is no master-detail, tree-data, row-grouping or nested-grid API in the config surface (`data`, `from`, `columns`, `server`, `style`, `className`, `language`, `width`, `height`, `autoWidth`, `fixedHeader`, `search`, `sort`, `pagination`) and none in the examples navigation. The closest thing is column-level `plugin: { component: ... }`, which renders an arbitrary Preact component into a cell — you could hand-mount a second Grid there, but the library documents no such pattern.
- **charting:** not documented. No chart module, no range-to-chart flow, nothing in the config or examples navigation.
- **formula:** not documented. No formula engine, no function catalogue.
- **pivot:** not documented. The pipeline has extract / filter / sort / limit / transform stages but no aggregation or cross-tab stage.
- **editing:** not documented. There is no cell editor, validation, clipboard/Excel paste, fill handle, or undo in the config surface or the examples list. Interaction is read-only: global search, sort, resizable columns, hidden columns, and row/cell **selection** via the separate `gridjs-selection` plugin, which keeps checked rows in a small Redux-style store you subscribe to.
- **framework:** Vanilla JS plus official wrappers for React (`gridjs-react`), Vue (`gridjs-vue`) and Angular (`gridjs-angular`). Wrapper freshness is uneven: `gridjs-react` 6.1.1 (Jan 2024), `gridjs-angular` 2.0.0 (Feb 2024), `gridjs-vue` 5.0.4 (Aug 2021 — four years stale and still on a v5 core).
- **dataModel:** Both. Client-side via `data` (array-of-arrays, array-of-objects, or a function) or `from` (scrape an existing HTML `<table>`), and a genuine server model via `server: { url, method, headers, body, then, handle, total }`, with server-side pagination, sorting and global search as dedicated pipeline processors. No direct database integration — it is `fetch` against your endpoint.
- **distinctive:** The pipeline. Grid.js models the whole data path as an ordered, cached, typed chain of `Processor` steps (initiator → extractor → transformer → filter → sort → limit), and swapping the client processor for its server twin is what turns a local grid into a remote one — same grid, different pipeline nodes. That plus a Preact-component plugin system with named render positions makes it the most extensible-per-kilobyte option here. Maintenance, honestly: the last release is `6.2.0` on 2024-03-03 — roughly two and a half years with no tagged release. The repo is not archived and community PRs were still merged in late Jan 2026, but with 94 open issues and nothing shipped to npm, users are pinned to a 2024 build.

Sources: https://gridjs.io/, https://gridjs.io/docs/index, https://gridjs.io/docs/config/server, https://gridjs.io/docs/plugins/basics, https://github.com/grid-js/gridjs, https://registry.npmjs.org/gridjs

### react-data-grid (Adazzle) {#grid:react-data-grid}

- **license:** MIT, single tier, nothing gated. Ownership correction: **`adazzle/react-data-grid` now redirects to `Comcast/react-data-grid`** — the adazzle path 404s on direct fetch and the npm manifest's `repository` field points at `git+https://github.com/Comcast/react-data-grid.git`. The LICENSE file is MIT: "Original work Copyright (c) 2014 Prometheus Research / Modified work Copyright 2015 Comcast." GitHub's classifier reports `NOASSERTION` only because of that dual-copyright preamble; the body is verbatim MIT.
- **rendering:** DOM, and unusually literally so — the root element sets `display: grid` in `src/style/core.ts` and every cell is a `div` placed by CSS Grid, with frozen columns done via `position: sticky` rather than a second scrolling pane. Styling is CSS custom properties (`--rdg-*`) with `light-dark()` for automatic theming. No canvas.
- **virtualization:** Row **and** column, on by default — `enableVirtualization?: Maybe<boolean>` in `DataGrid.tsx` defaults to `true`, backed by `useViewportRows.ts` and `useViewportColumns.ts`. No row ceiling documented; the shipped stress demo is `MillionCells`, a 1000-row × 1000-column grid with the first five columns frozen.
- **nesting:** Row grouping and tree data exist as a first-class second component, `TreeDataGrid`, exported from the package root; it takes `groupBy` plus a `rowGrouper` function and implements the ARIA `treegrid` pattern with keyboard expand/collapse. Column grouping (multi-level headers) is separate. **Yes, a grid can contain a grid** — but as a userland pattern, not an API: the official `MasterDetail` example defines a `DETAIL` row type, gives it a `colSpan` spanning the full width, and renders a nested `<DataGrid>` inside that cell's renderer.
- **charting:** not documented. No chart module, nothing in the exported API surface or the demo route list.
- **formula:** not documented. No formula parser or function library.
- **pivot:** not documented. `TreeDataGrid` does hierarchical grouping with summary rows, but there is no cross-tab pivot construct.
- **editing:** Renderer-driven: setting a column's `renderEditCell` "automatically set[s] the column to be editable", with `editable` accepting a boolean *or* a per-row predicate. Only one editor ships (`renderTextEditor`) — every other variant is yours to write. Clipboard is `onCellCopy` / `onCellPaste` (you own the transform, so Excel paste is possible but not provided), and there **is** a fill handle via `onFill`. Undo: not documented — state lives outside the grid and arrives via `onRowsChange`. Worth flagging: built-in **filters were deleted** in v7 canary.48 (`filters`, `onFiltersChange`, `enableFilterRow`, `Column.filterRenderer` all removed) — the `HeaderFilters` demo now reimplements them in a custom header renderer.
- **framework:** React only, and aggressively current — the published peer range is `react: ^19.2` / `react-dom: ^19.2`, so React 18 is not supported by the latest build. TypeScript-first, SSR-capable, published as ESM, zero runtime dependencies.
- **dataModel:** Client-side only. `rows` is a plain in-memory array you pass in; there is no server-side, viewport, or infinite row model, and no database integration. Remote paging is emulated in userland. Sorting, filtering and grouping are all "you compute it, we render it".
- **distinctive:** It is the serious MIT grid that refuses to own your data. Everything stateful — sort, group, filter, edit commits, selection — is lifted out to the host app, leaving a rendering engine that is genuinely small (no runtime deps) and genuinely fast. The technically interesting part is the CSS-Grid layout: rather than absolute-positioning virtualized rows, it emits real grid tracks and leans on `contain: content` + `content-visibility: auto`, which is what lets column spanning, variable row heights, RTL and sticky frozen columns coexist without a manual layout pass. The moat is the accessibility and keyboard model (roving tabindex, `treegrid` semantics, `aria-colspan`). Release status, honestly: v7 has never gone stable — `latest` on npm is `7.0.0-beta.61`, published 2026-07-14, and the tag has been in alpha/canary/beta since 2020. The repo is very much alive (commits 2026-09-03, ~7.7k stars) — permanent-beta versioning, not abandonment.

Sources: https://github.com/Comcast/react-data-grid, https://github.com/Comcast/react-data-grid/blob/main/LICENSE, https://github.com/Comcast/react-data-grid/blob/main/src/DataGrid.tsx, https://github.com/Comcast/react-data-grid/blob/main/website/routes/MasterDetail.tsx, https://comcast.github.io/react-data-grid/, https://registry.npmjs.org/react-data-grid

### SlickGrid / Slickgrid-Universal {#grid:slickgrid}

- **license:** MIT across the whole lineage. The original `mleibman/SlickGrid` is MIT and effectively abandoned (owner's 2014 note that he can no longer give it "the time and attention it deserves"; the README points readers to the 6pac fork as "the most active fork"). `6pac/SlickGrid` (v5.17.0 line) is the maintained MIT core; `ghiscoding/slickgrid-universal` is MIT and is the actively developed modern line (v10.10.0, 2026-08-28). No paid tier, no enterprise gate anywhere in the lineage.
- **rendering:** DOM. The core builds real DOM rows/cells and only materializes visible ones; Slickgrid-Universal ships a `shadow-dom.md` doc for running the grid inside a shadow root, which only makes sense for DOM output. No canvas/WebGL documented.
- **virtualization:** Row virtualization is the core mechanism ("adaptive virtual scrolling"; the original README claims hundreds of thousands of rows, Slickgrid-Universal claims smooth scrolling with "even a million rows"). No hard row ceiling documented. Column-level virtualization is not documented as a separate feature.
- **nesting:** Tree data supports both flat parent-id datasets (infinite depth) and pre-nested `children` arrays, with sum/avg/count/min/max aggregators over tree nodes and lazy child loading on expand. Separate row grouping with aggregators plus draggable grouping. Row detail renders an expandable panel per row; the `keepComponentAlive` option explicitly refers to preserving "nested grid state, filters, sorts", so a grid inside a row-detail panel is a supported pattern, though the doc warns the panel is best for static content. Tree data is documented as incompatible with backend pagination.
- **charting:** No charting. The documentation tree contains no chart topic; `grid-functionalities/` lists 27 files with none chart-related.
- **formula:** not documented. No formula engine, function library, or spreadsheet-expression topic appears anywhere in the docs tree.
- **pivot:** Not implemented. The pivot request (6pac/SlickGrid issue #1020, opened 2024-05-14) is still open and carries a **"not planned"** label; the requester notes the gap versus AG Grid. Grouping + aggregators is the closest shipped substitute.
- **editing:** Strong. Built-in editors: checkbox, date, float, integer, text, longText, autocomplete, single/multi select. Every editor implements `validate()` and there is an `EditorValidator` type for custom rules. A composite-editor modal edits several columns (or a whole selection) in one dialog, and there is a row-based edit mode. Excel clipboard round-trip via `enableExcelCopyBuffer: true` (Ctrl+C/Ctrl+V against real Excel, per-column `denyPaste`, `onBeforePasteCell`, multiline/quote handling). Export to Excel, PDF and text file. **Undo is not documented**; no fill handle is documented.
- **framework:** Framework-agnostic vanilla TS/JS core, plus official wrappers in the slickgrid-universal monorepo: Angular-Slickgrid, Aurelia-Slickgrid, Slickgrid-React, Slickgrid-Vue, and Salesforce LWC. jQuery has been optional since v4.0, with SortableJS the only hard dependency.
- **dataModel:** Primarily client-side via the DataView object, but with real backend services: OData, GraphQL, a `sql-backend` doc, and a `custom-backend-service` extension point handling server-side sort/filter/pagination. Infinite scroll works against either local JSON or a backend service — note it appends to the in-memory dataset rather than being a true viewport row model. No direct database driver.
- **distinctive:** The backend-service abstraction plus wrapper breadth is the moat: one MIT core with first-party OData/GraphQL/SQL query builders that translate grid sort/filter/page state into server queries, shipped identically to Angular, Aurelia, React, Vue and Salesforce LWC from a single monorepo (5,684 commits, ~5,000 Vitest unit tests at 100% coverage plus 1,000+ Cypress E2E). That combination — server-side query generation for free, under MIT, across five frameworks — is what a competitor would find expensive to replicate; the grid primitives themselves are conventional.

Sources: https://github.com/6pac/SlickGrid, https://github.com/mleibman/SlickGrid, https://github.com/ghiscoding/slickgrid-universal, https://github.com/ghiscoding/slickgrid-universal/blob/master/docs/column-functionalities/editors.md, https://github.com/ghiscoding/slickgrid-universal/blob/master/docs/grid-functionalities/excel-copy-buffer.md, https://github.com/6pac/SlickGrid/issues/1020

### canvas-datagrid {#grid:canvas-datagrid}

- **license:** BSD-3-Clause, single tier, no commercial edition (confirmed on both GitHub metadata and the npm registry record).
- **rendering:** Canvas, immediate mode — the README's framing is "millions of contiguous hierarchical rows and columns without paging or loading, on a single canvas element" and the docs state "data size does not impact performance." It is hybrid only at the edit seam: the tutorial explicitly says "the editing input/textarea is DOM" so that native key commands, copy and paste keep working over a canvas surface.
- **virtualization:** Effectively row+column, and inherent rather than a feature flag — an immediate-mode painter only ever draws the cells inside the viewport, in both axes, which is why the docs claim "unlimited rows and columns without paging or loading." No row ceiling documented; a `largeArraysDemo` ships in the tutorials folder.
- **nesting:** This is its signature. Hierarchical drill-in plus grids inside cells: set a schema column's (or a cell's) `type` to `'canvas-datagrid'` and that cell's value becomes the data source for a child grid instance, with `cell.isGrid === true` on such cells. Two hooks govern it — `beforecreatecellgrid` (mutate `e.cellGridAttributes`) and `beforerendercellgrid` (`e.preventDefault()` to suppress it). So a grid can literally contain another grid, recursively, inside one canvas. Row grouping and master-detail as named features: not documented.
- **charting:** No integrated charting product. A `sparklineDemo` ships in tutorials, but sparklines are not documented as a library feature, and select-a-range-and-chart is not documented.
- **formula:** not documented — the API tutorial covers `filters`, `sorters`, formatters and the data/schema model, with no formula engine.
- **pivot:** Not a library feature. A `pivotFormDemo` exists in tutorials, but it is a hand-rolled demo driving the ordinary `grid.schema` / `grid.data` / `draw()` APIs — there is no pivot module.
- **editing:** Cell editing exists and is one of the four things the docs site advertises, with custom cell renderers and editors as a customization point and a `beforebeginedit` event. The edit surface is a real DOM input/textarea overlaid on the canvas, which gives it native clipboard behaviour. Selection is settable declaratively (`<canvas-datagrid selectionmode='row'>`). Editor variant catalogue, validation API, fill handle and undo: **not documented**.
- **framework:** Ships as a W3C custom element, `<canvas-datagrid>`, so framework-neutral by construction; the repo ships worked examples for plain JS, React, Vue, AMD and Webpack. No first-party Angular wrapper documented.
- **dataModel:** Client-side in-memory only — `data` takes an array of objects or arrays, with an optional `schema`. Per-user preference persistence goes to localStorage. There is no server-side or viewport row model and no database integration; the only remote pattern is the `xhrPagingDemo` tutorial, which is demo code, not an API.
- **distinctive:** Recursive grids-in-cells on a single canvas element. Because the whole grid is one immediate-mode painter, a child grid is not another component mounted into a DOM cell — it is painted inside the parent's own draw pass. Nothing DOM-based can nest that cheaply. Maintenance is the caveat and it is serious: last commit to master 2025-09-18, last release **v0.4.7 published 2023-05-22** — over three years stale — 148 open issues, repo not archived, ~5.7k npm downloads/week. No fork is documented as the maintained successor. Treat it as a reference architecture for canvas nesting, not a dependency.

Sources: https://github.com/TonyGermaneri/canvas-datagrid, https://raw.githubusercontent.com/TonyGermaneri/canvas-datagrid/master/tutorials/canvasDatagrid.md, https://canvas-datagrid.js.org/, https://registry.npmjs.org/canvas-datagrid/latest

### regular-table {#grid:regular-table}

- **license:** Apache-2.0 (single tier, no paid edition). The README carries a FINOS "Graduated" lifecycle badge and OpenSSF Best Practices "Passing". The project lives at `finos/regular-table` — the `prospective-software/regular-table` URL is a 404.
- **rendering:** Real DOM. It renders an actual HTML `<table>` with `<thead>/<tbody>/<tr>/<th>/<td>`, positioned `sticky` inside a scrollable viewport. How we know: the README states it "renders a regular HTML `<table>` to a `sticky` position within a scollable viewport", prints the produced DOM tree literally in the QuickStart, documents styling as "works with any regular CSS for `<table>`", and its styling API works by `querySelectorAll("tbody th")` over live elements. Notably one of its own examples is `canvas_data_model` — a canvas used as a *data source*, not as the renderer.
- **virtualization:** Row + column by default, configurable per data listener via `virtual_mode`: `"both"` (default), `"vertical"`, `"horizontal"`, `"none"`. No hard row ceiling documented; the shipped `two_billion_rows` example declares `NUM_ROWS = 2000000000` and `NUM_COLUMNS = 1000` generated on the fly, so the ceiling is whatever the data callback can answer, not a DOM limit. `row_height` can be pinned to override DOM auto-detection, and a `sub-cell-scrolling.css` stylesheet exists because a `<table>` otherwise scrolls only in whole-cell increments.
- **nesting:** No built-in master-detail, tree-data or row-grouping *engine*. What it ships is hierarchical headers: `column_headers` / `row_headers` are arrays-of-arrays, and contiguous equal `<th>` values are merged with `colspan`/`rowspan` (`merge_headers`, `column_header_merge_depth`). Tree/file-tree and pivot-shaped output are demonstrated as *examples* — the expand/collapse state is your data model's job. Nested grid-inside-a-grid: not documented.
- **charting:** No charting. It is a table renderer only.
- **formula:** No formula engine in the library. The bundled `spreadsheet` example implements a toy expression language on top — cells beginning with `=`, e.g. `=sum(A2..C4)` — but that is demo code, not a shipped API, and no function catalogue is documented.
- **pivot:** No pivot engine of its own. The README's "Pivots, Filters, Sorts, and Column Expressions with `perspective`" section is explicit that you get pivots by using a `perspective.Table` as the virtual data model — regular-table supplies only the hierarchical-header rendering that pivot output needs.
- **editing:** No editing API. Interaction is "it's a normal `HTMLElement`" — you attach DOM listeners and map the event target back to data coordinates with `getMeta()`. The `spreadsheet` example gets editing by setting `contenteditable` on `<td>` itself. Editor variants, validation, Excel paste, fill handle and undo: not documented.
- **framework:** Framework-agnostic by construction — a Custom Element registered as an import side effect. The README shows a React/JSX usage snippet and ships a `react` example. No official per-framework wrapper packages documented.
- **dataModel:** Callback-driven and async-first — there is no client-side row store at all. You register `setDataListener((x0, y0, x1, y1) => ...)`, returning `{num_rows, num_columns, data}` plus optional headers and metadata. The callback may be async; the table blocks rendering until it resolves and will not re-enter the listener while a call is outstanding. That makes it inherently a viewport row model: remote/Node/WebSocket/Web Worker backends are the documented case. No direct database integration.
- **distinctive:** A viewport-windowed renderer with *no data model, no features, and no opinions* — the entire product surface is three hooks (`setDataListener`, `addStyleListener` + `getMeta`, and plain `addEventListener`) over a real `<table>`. That is the moat in reverse: because the output is genuine `<table>` DOM, native CSS, accessibility semantics, text selection and browser find-in-page work for free, which canvas grids must reimplement — and it still services a 2-billion-row viewport. `addStyleListener` is the specific trick that makes this viable: CSS cannot express "style column 3 of the *data*" when a `<td>` maps to a different data column depending on horizontal scroll, so styling is a callback invoked on every redraw that resolves each element to its virtual `(x, y)`. Maintenance: active — v0.9.0 published 2026-08-11, repo pushed 2026-09-04. It is the renderer behind Perspective's grid.

Sources: https://raw.githubusercontent.com/finos/regular-table/master/README.md, https://github.com/finos/regular-table, https://raw.githubusercontent.com/finos/regular-table/master/examples/two_billion_rows/two_billion_rows.js, https://registry.npmjs.org/regular-table

### Perspective {#grid:perspective}

- **license:** Apache-2.0, one tier, nothing gated. **Governance has moved:** it is now an **OpenJS Foundation** member project, not FINOS, and the repo is `perspective-dev/perspective` with `perspective.finos.org` 301-redirecting to `perspective-dev.github.io`. npm packages are scoped `@perspective-dev/*`; Python `perspective` on PyPI; Rust `perspective` on crates.io.
- **rendering:** Hybrid, split by plugin. The `Datagrid` plugin is DOM — "a custom high-performance data-grid component based on HTML `<table>`", and its npm package pins `regular-table` as a dependency. The `Charts` plugin is **WebGL** — "WebGL charting engine with 15+ chart types". Note for anyone working from older material: the d3fc-based chart package is gone from current docs; the plugin roster is now datagrid + WebGL charts + tile-based maps.
- **virtualization:** Row + column, and it goes further than DOM windowing — the *query* is virtualized too. Datasets can be "virtualized server-side, streaming only what's visible", so scrolling, pivots and sorting execute against the C++ engine rather than a materialized JS array. No row ceiling documented as a number; the documented constraint is memory, and there is a **64-bit `memory64` WASM build specifically for in-browser datasets larger than 4 GB**. Plugins carry per-plugin render limits (`max_cells`, `max_columns`).
- **nesting:** `group_by` produces a real tree hierarchy in the grid, with server-side expansion control: `view.expand(5)`, `view.collapse(5)`, and a set-depth call. Crucially, **collapsed rows are not recomputed on update** — aggregates for a collapsed subtree are calculated lazily when expanded, a genuine streaming-workload optimization. `split_by` gives column pivots. Nested grid-in-a-grid is not supported as a cell renderer, but a `<perspective-viewer>` now hosts **multiple panels** — `addPanel`/`removePanel`/`setActivePanel`, `saveWorkspace()`/`restoreWorkspace()`, and a `perspective-global-filter` event fired by a "master panel" selection to drive the others. That is master-detail at the dashboard level rather than the row level.
- **charting:** Integrated, free, same package family, no separate paid product. `@perspective-dev/viewer-charts` registers into the same plugin dropdown as the grid, so a user swaps grid↔chart over one identical `ViewConfig`. Documented types: X Bar, Y Bar, Y Line, Y Scatter, Y Area, X/Y Scatter, X/Y Line, Density, Treemap, Sunburst, Heatmap, Candlestick, OHLC, Map Scatter, Map Line, Map Density. Maps draw glyphs over a raster XYZ basemap chosen by a `map_tile_provider` enum, shipping `osm` (default) and `versatiles-satellite`, with `registerTileSource` for custom providers. Charts emit `perspective-select` on selection change; charting a *grid* range selection specifically is not documented — selections are exposed for export.
- **formula:** Not Excel formulas — a columnar **expression language based on ExprTK**, evaluated inside the C++ engine, authored in a Monaco-backed editor behind the viewer's "New Column" button. Strongly typed with **no implicit coercion** (`to_integer`, `to_float`, `to_string`, `to_boolean`). Roughly 50–60 documented functions: operators incl. `if...else`; ExprTK numerics (`abs`, `ceil`, `floor`, `round`, `exp`, `log`, `sqrt`, `min`, `max`, `pow`, `clamp`, trig); ~13 string functions incl. regex (`match`, `match_all`, `search`, `replace_all`, `substring`); date/datetime (`today`, `now`, `hour_of_day`, `day_of_week`, `bucket` by `s/m/h/D/W/M/Y`); and `is_null`, `percent_of`, `random`, `col(name)`, `vlookup(col, key)`. Expressions are **row-local** by design; a separate `windows` property provides SQL-style window columns (`column`, `aggregate`, `rows`, `partition_by`) for moving averages, updating incrementally *including rows outside the update batch whose window frames were affected*. `table.validate_expressions()` type-checks against the schema before a View is built.
- **pivot:** Yes, first-class, free, and the product's center of gravity. `group_by` (row pivots, with per-group total rows) and `split_by` (column pivots) with configurable `group_rollup_mode` and `split_rollup_mode` (`"rollup"` emits grand-total and subtotal columns per aggregate). `aggregates` is a column→function map with type-defaulted behavior (`sum` for int/float, `count` otherwise). Client or server is a deployment choice, not a tier: the same `ViewConfig` executes in-process, in a Web Worker, over WebSocket against Python/Node/Rust, or is translated into native SQL by a Virtual Server.
- **editing:** Yes — `<perspective-viewer editable>` turns on grid cell editing, and the docs show distributed editing where a client-side table mirrors a server table and edits synchronize both ways; `getEditPort()` exposes a panel's edit port so writes are attributable. Clipboard: `viewer.copy({method: "csv-selected"})` plus `json-selected` / `arrow-selected` and `getSelection`/`setSelection`. Edits land via `table.update()` against an **indexed** table, where matching index values replace rows. Editor variants, validation rules, fill handle, undo, and Excel paste: not documented (the FAQ also states there is no built-in Excel export — you go through `to_csv`/`to_arrow`).
- **framework:** Framework-agnostic by design — the UI is a Custom Element. Officially published bindings: React (`@perspective-dev/react`), a Jupyter widget built on **anywidget**, and Python server handlers for **aiohttp, Starlette and Tornado**. Language APIs: JavaScript/TypeScript, Python, Rust.
- **dataModel:** All three, symmetric. The *same* Client API attaches to an engine (a) in-process, (b) in a Web Worker via WebAssembly, or (c) remotely over WebSocket. Data in/out is Apache Arrow, CSV or JSON with streaming Arrow support. **Direct database integration: yes.** "Virtual Servers" implement a handler interface translating a Perspective `ViewConfig` into native queries against an external engine, with shipped implementations for **DuckDB** (including `duckdb-wasm`, i.e. querying DuckDB *in the browser*), **ClickHouse**, and Polars/PostgreSQL named among delegation targets — "no ETL or data copy required". Also supports reactive joins across tables and a `get_features` capability handshake so a viewer degrades gracefully.
- **distinctive:** It is not a grid with an analytics bolt-on — it is a C++ columnar streaming query engine (WASM/native) that happens to expose a grid as one of its renderers. Hard to replicate: (1) *incremental* recomputation — `table.update()` ticks pivots, aggregates, filters, sorts, expression columns and window columns forward without a full recompute, with collapsed pivot subtrees skipped until expanded; (2) the symmetric client/server API where moving from in-browser to server-virtualized is a connection change, not a rewrite; (3) Virtual Servers, which compile the viewer's config down to native DuckDB/ClickHouse queries so the grid becomes a UI over a warehouse with no data copy; (4) a `memory64` WASM build for >4 GB in-browser working sets. A JS-only MIT grid competes with the *rendering* layer (which is `regular-table`, Apache-2.0 and separable) but not with the engine.

Sources: https://perspective-dev.github.io/guide/, https://perspective-dev.github.io/guide/print.html, https://github.com/perspective-dev/perspective, https://registry.npmjs.org/@perspective-dev/viewer-datagrid/latest, https://github.com/ArashPartow/exprtk

### Frappe DataTable {#grid:frappe-datatable}

- **license:** MIT, single tier. No commercial/enterprise edition exists — every documented feature is in the one npm package (`frappe-datatable`, latest 1.20.7).
- **rendering:** DOM. The library builds HTML elements directly (vanilla JS, explicitly "without jQuery"); its runtime dependency set is `hyperlist` (a DOM virtual-list), `sortablejs` and `lodash`. No canvas/WebGL documented.
- **virtualization:** Row only, **on by default** — the documented option `clusterize` (Boolean, default `true`) is described as "Whether to use clusterize to render the data". Note the naming drift: the option is still called `clusterize` while the shipped dependency is `hyperlist`. Column virtualization: not documented. Documented row ceiling: not documented — the README only claims it "can be used to render large amount of rows without sacrificing performance".
- **nesting:** Tree data only. `treeView` (Boolean, default `false`) renders "rows in a tree structure" driven by per-row indent values, and recent commits explicitly maintain tree expand/collapse state across column freeze. Master-detail, row grouping with aggregation, and grid-inside-a-grid are **not documented**.
- **charting:** not documented (checked the configuration reference and README — no chart option; Frappe ships charts as a separate library, but no integration is documented here).
- **formula:** not documented (no formula/expression option in the configuration reference).
- **pivot:** not documented (no pivot option in the configuration reference).
- **editing:** Real, and the strongest part of the library. Per-column `editable` flag (default true), double-click to edit inline, a `getEditor` hook (default `null`) for swapping in a custom editor control, mouse-drag cell/range selection plus keyboard cell navigation, cell-content copy, and `pasteFromClipboard` (default `false`, flagged **experimental**). `inlineFilters` (default `false`) opens a per-column filter row on Ctrl/Cmd+F. So the Excel-like selection/keyboard/copy-paste reputation checks out, but paste is opt-in and self-labelled experimental. Fill handle, cell validation, and undo/redo: **not documented**.
- **framework:** Vanilla JavaScript only. Installed via yarn or a plain `<script>` tag; no official React/Vue/Angular/Svelte wrapper documented.
- **dataModel:** Client-side only — you hand it `columns` and `data` arrays, mutated through a documented DataManager API. No server-side, infinite, or viewport row model, and no direct database integration.
- **distinctive:** It is the only credibly-maintained MIT, zero-framework grid that ships a spreadsheet-style interaction model — mouse range selection + keyboard traversal + clipboard paste into a selection — layered on an always-on virtual list that also supports `dynamicRowHeight`, which is the genuinely hard combination: variable row heights and virtualization normally fight each other. Its moat is provenance, not surface area: it was written to replace SlickGrid inside ERPNext and is battle-tested as that product's production grid, which is why the recent commit log is all sticky-column/z-index/freeze-state edge cases rather than new features. Maintenance (honest read): alive but low-velocity — v1.20.7 released 2026-07-22; commits run through July 2026 and are exclusively small community bug fixes; ~1,332 stars, 62 open issues. Do not expect charting/pivot/formula to ever arrive here.

Sources: https://github.com/frappe/datatable, https://frappe.io/datatable, https://frappe.io/datatable/docs/configuration, https://registry.npmjs.org/frappe-datatable/latest

### Ant Design Table {#grid:antd-table}

- **license:** MIT, single tier, no paid edition. The whole of `antd` (currently 6.6.2) is MIT; the optional `@ant-design/pro-table` (3.21.0) is separately published but also MIT. Nothing in either is commercially gated — the free/paid fork in the road simply does not exist for this product.
- **rendering:** DOM. A React component tree emitting real `<table>/<thead>/<tbody>` markup, delegating to `@rc-component/table` (the renamed `rc-table`). Fixed columns use CSS `position: sticky` rather than rendering a duplicate shadow table — stated explicitly in antd's own virtual-table blog post. No canvas anywhere.
- **virtualization:** **Not by default — strictly opt-in.** The `virtual` prop was added in **v5.9.0**; the blog post confirms "developers must explicitly add the `virtual` prop". It requires both `scroll.x` and `scroll.y` to be numeric. Underneath, the default `<tbody>` is swapped for `@rc-component/virtual-list`, which the team extended to also handle horizontal scrolling — so it is effectively row+column once enabled. Documented limitation: rowSpan/colSpan support is partial (only `rowSpan > 1` and `rowSpan = 0`), and performance degrades with heavy cell merging. No documented row ceiling.
- **nesting:** Three separate mechanisms, all built in. (1) `expandable.expandedRowRender` for master-detail, and the documented "Nested tables" demo puts a full `<Table>` inside the expanded row — **so a grid can contain another grid**. (2) Tree data via `expandable.childrenColumnName`, default `"children"`. (3) Grouping *headers* (multi-level column groups) and `colSpan`/`rowSpan` cell merging. What does **not** exist: row grouping with aggregation — no group-by/aggregate API is documented.
- **charting:** not documented (no chart integration, no range-to-chart. AntV/Ant Design Charts is a distinct product and is not referenced from the Table API).
- **formula:** not documented (no formula, expression, or function-library API).
- **pivot:** not documented (no pivot mode, client or server).
- **editing:** **There is no built-in editing feature.** The "Editable Cells" / "Editable Rows" entries are *demos*, not props: the official `edit-cell` demo implements a userland `EditableCell` component, shares a Form instance through React Context, and injects it by overriding `components.body.cell` — `components` is documented merely as "Override default table elements". The demo also carries a caveat about a `shouldCellUpdate` closure bug (issue #29243). No editor-variant registry, no validation layer, no Excel clipboard paste, no fill handle, no undo/redo. Editing as a *product* lives in the separate `@ant-design/pro-table` package — i.e. antd's answer to editing is "install another package".
- **framework:** React only. `antd@6.6.2` declares peer deps `react >=18.0.0`. No Vue/Angular/Svelte builds published by this project.
- **dataModel:** Client-side only — a `dataSource` array plus columns. Server-side work is done by controlling `pagination` / `loading` and reacting to the `onChange` callback yourself; there is no server-side, infinite, or viewport row model, and no direct database integration.
- **distinctive:** Honestly, on grid capability this is close to a **commodity table** — a presentation component for a design system, not a data-grid engine: no editing engine, no grouping/aggregation, no pivot, no charts, no formulas, no server row model. That is a real finding for a competitor: antd's users are not being served on the spreadsheet axis at all. The one genuinely non-trivial piece of engineering is the v5.9.0 virtual retrofit — antd kept `position: sticky` fixed columns, expandable rows, and (partial) rowSpan/colSpan merging *working inside* a virtualized `<tbody>`, by teaching rc-virtual-list horizontal scrolling instead of forking the table. Retrofitting virtualization into an existing non-virtual table API without breaking sticky columns and merged cells is the hard bit, and the only part of this product that would be painful to replicate.

Sources: https://ant.design/components/table, https://ant.design/docs/blog/virtual-table/, https://raw.githubusercontent.com/ant-design/ant-design/master/components/table/demo/edit-cell.tsx, https://registry.npmjs.org/antd/latest, https://registry.npmjs.org/@ant-design/pro-table/latest

### PrimeNG / PrimeReact / PrimeVue DataTable {#grid:primeng-table}

- **license:** Two eras. PrimeNG 21 / PrimeReact 10 / PrimeVue 4 and earlier are MIT and stay MIT permanently. From PrimeNG 22 / PrimeReact 11 / PrimeVue 5 onward PrimeTek moved to the proprietary **PrimeUI** license: a *Community* tier free only for orgs under $1M revenue, <5 developers, <10 employees and <$3M VC funding (12-month key, 30-day grace), and a *Commercial* tier at $599/developer perpetual (launch price through 2026, $799 from 2027) with one year of updates, $399/yr thereafter. The PrimeNG GitHub repo was archived 2026-06-29. The DataTable itself is not feature-gated — the *whole library* moved behind the key.
- **rendering:** DOM. Angular/React/Vue templates emitting real `<table>`/`<tr>`/`<td>` with per-cell content templates; no canvas layer documented.
- **virtualization:** Row only. `[virtualScroll]` with a fixed `virtualScrollItemSize`, in preload and lazy modes. Column virtualization and a documented row ceiling: not documented.
- **nesting:** Row expansion renders arbitrary templated content, and the docs' row-expansion pattern is a nested DataTable inside the expanded row — so a grid can contain a grid. Row grouping exists in subheader, rowspan and expandable modes. Hierarchical data is a **separate component**, `TreeTable`, not a mode of DataTable.
- **charting:** No chart integration and no select-a-range-and-chart flow documented on the DataTable page.
- **formula:** not documented (checked the DataTable page).
- **pivot:** not documented (checked the DataTable page).
- **editing:** Cell editing (`pEditableColumn`) and row editing (`pEditableRow` / `pInitEditableRow` / `pSaveEditableRow` / `pCancelEditableRow`); editors are arbitrary templates, so any input component works. Clipboard/Excel paste, fill handle and undo: not documented. Export is CSV only from the built-in exporter.
- **framework:** Angular (PrimeNG), React (PrimeReact), Vue (PrimeVue) — three separate ports of the same API surface. Also PrimeFaces for JSF, which stays open source under volunteer maintenance.
- **dataModel:** Client-side by default; `lazy` mode with an `onLazyLoad` event hands paging, sorting and filtering to the server. No direct database integration.
- **distinctive:** A full-featured DOM grid inside a general-purpose UI kit, whose differentiator right now is negative rather than technical: it is the highest-profile mainstream grid to have *left* MIT mid-2026, with an archived repo and a revenue/headcount-tested "free" tier. For a team shipping an MIT grid, PrimeNG 21 is now a frozen upstream that a lot of Angular teams are stranded on.

Sources: https://primeng.dev/table, https://primeng.dev/treetable, https://primeui.dev/nextchapter, https://github.com/primefaces/primeng/blob/master/LICENSE.md

### Element Plus Table {#grid:element-plus-table}

- **license:** MIT (single tier, no paid edition). Repo `element-plus/element-plus`, actively pushed (2026-09-04).
- **rendering:** DOM for both components. The classic `el-table` renders a real HTML table; `el-table-v2` renders absolutely-positioned virtualized rows. No canvas.
- **virtualization:** None in `el-table` — it renders every row, which is why a second component exists. `el-table-v2` (TableV2) does row virtualization and is explicitly labelled beta: the docs say it is still under testing, use at your own risk, and some APIs are undocumented. No documented row ceiling.
- **nesting:** Classic Table has tree data (`row-key` + `children`) with lazy child loading via a `load` callback, expandable rows (`type="expand"`) whose content is a slot — so a nested grid is possible — and grouped/multi-level column headers via nested `el-table-column`. TableV2 has **none** of tree, expandable rows, or native colspan/rowspan.
- **charting:** not documented (checked both table pages).
- **formula:** not documented (checked both table pages).
- **pivot:** not documented (checked both table pages).
- **editing:** No built-in cell editor. Editing is done by putting an input into a column slot / custom cell renderer. Validation, clipboard paste, fill handle and undo: not documented.
- **framework:** Vue 3 only.
- **dataModel:** Client-side array. Sorting and filtering can be delegated via `sortable="custom"` / `filter-method` and refetching yourself; there is no server-side or viewport row model abstraction. Lazy loading exists only for tree children. No database integration.
- **distinctive:** The instructive thing is the **fork in the component, not in the product**: Element Plus could not retrofit virtualization onto its table, so it shipped TableV2 as a parallel component with a materially smaller feature set (no tree, no expand, no rowspan) and left it in beta. That is exactly the trap a DOM-table-first architecture sets, and the strongest argument in this survey for designing the virtualization layer before the feature layer.

Sources: https://element-plus.org/en-US/component/table.html, https://element-plus.org/en-US/component/table-v2.html, https://api.github.com/repos/element-plus/element-plus

### Vaadin Grid {#grid:vaadin-grid}

- **license:** Split by component, not by feature flag. Base **Grid** and **Tree Grid** are Apache 2.0; depending on `vaadin-core` instead of `vaadin` gives only the Apache-licensed set. **Grid Pro** (in-cell editing + full keyboard navigation), **Charts**, **CRUD**, **Dashboard**, **Map**, **Rich Text Editor**, **Board**, **Spreadsheet** and TestBench require a commercial subscription under the Vaadin Commercial License and Service Terms.
- **rendering:** DOM, via web components (Lit-based custom elements) with Shadow DOM; the Java API is a server-side wrapper over the same elements. No canvas.
- **virtualization:** Row only (windowed rows, reused). Column virtualization and a documented row ceiling: not documented.
- **nesting:** Tree Grid (hierarchy column) and row details (an expandable per-row detail area taking arbitrary content, so it can host another Grid) are both documented, as is column grouping under shared headers/footers. Aggregating row grouping in the pivot sense: not documented.
- **charting:** Vaadin Charts exists but is a **separate Pro component**, not integrated into Grid. Select-a-range-and-chart: not documented.
- **formula:** No formula engine in Grid. Vaadin Spreadsheet is a separate Pro component that opens and edits XLSX in the browser; function count not documented.
- **pivot:** not documented (checked the Grid docs and the pricing component list).
- **editing:** The free Grid has editing only via the general editor/binder pattern; the polished in-cell experience — single-click edit, single-cell edit, enter-moves-to-next-row, built-in typed editors, full keyboard nav — is **Grid Pro, paid**. Clipboard/Excel paste, fill handle and undo: not documented.
- **framework:** Web Components (framework-agnostic), with first-class React and Java (Vaadin Flow) APIs.
- **dataModel:** Three documented patterns — static in-memory, buffered, and paginated/lazy via a data provider receiving offset/limit/sort/filter plus a separate count callback. A genuine server-side row model; in Vaadin Flow the grid is driven entirely from the server. No direct database integration in the component, though the Java stack is normally wired straight to JPA/SQL.
- **distinctive:** The Java-server-driven model. In Vaadin Flow the grid's state, data provider and event handlers live in server-side Java and the browser component is a thin renderer synced over a websocket — you can bind a Grid to a JPA repository without writing a REST endpoint or any client code. No other grid here makes the server the source of truth for the *component*, not just the data. The commercial line is drawn at editing ergonomics, which is unusually cheeky: reading is free, editing well costs money.

Sources: https://vaadin.com/docs/latest/components/grid, https://vaadin.com/docs/latest/components/grid/columns, https://vaadin.com/docs/latest/components/grid-pro, https://vaadin.com/pricing, https://vaadin.com/license

### Blueprint Table (Palantir) {#grid:blueprint-table}

- **license:** Apache-2.0, single tier. Shipped as a **separate package**, `@blueprintjs/table`, not part of `@blueprintjs/core` — opt-in, with its own CSS and its own major-version migration notes.
- **rendering:** DOM, with what the README calls viewport-only or *lazy* rendering — only cells inside the visible region are mounted. No canvas.
- **virtualization:** Row **and** column — "viewport-only rendering for scale" covers both axes, consistent with its spreadsheet-style layout of fixed column headers plus a row-index gutter. No documented row ceiling.
- **nesting:** None documented. No master-detail, tree data, row grouping or nested grids (checked the package README and the Blueprint 6.0 / Table 6.0 wiki pages). A flat cell matrix by design.
- **charting:** not documented (checked the package README and Blueprint docs index).
- **formula:** not documented (checked the package README).
- **pivot:** not documented (checked the package README).
- **editing:** Inline editable cells and editable column headers (`EditableCell`, `EditableName`). Right-click copies a selected cell region to the clipboard. Selection is region-based — columns, rows, or multiple discontiguous cell regions — the spreadsheet selection model rather than the row-selection model. Paste-in, fill handle, validation and undo: not documented.
- **framework:** React only.
- **dataModel:** There is no data model. The API is a cell renderer callback over row/column indices; you own the data entirely. No server-side/infinite/viewport row model and no database integration documented.
- **distinctive:** **This is not a data grid, it is a spreadsheet surface without the spreadsheet.** No notion of a row object, column definition, sorting, filtering or pagination — you hand it a `(rowIndex, colIndex) => Cell` function and get Excel-grade region selection, resizable rows *and* columns with double-click autosize, and a frozen header/index gutter. A plausible *substrate* to build on, a non-starter as a drop-in grid. On maintenance: not formally deprecated, and it did receive a 6.0 major (June 2025) migrating it to the new hotkeys and context-menu APIs — but that 6.0 also turned `<Table>`, `<EditableCell>` and `<ContextMenu>` into deprecated aliases of versioned variants, and the tracker carries a large open-issue backlog (941 repo-wide) with a standing `Package: table` label. A formal maintenance-mode or EOL statement: not documented.

Sources: https://github.com/palantir/blueprint/tree/develop/packages/table, https://github.com/palantir/blueprint/wiki/Table-6.0-changes, https://github.com/palantir/blueprint/wiki/Blueprint-6.0, https://blueprintjs.com/docs/#table

### Fluent UI DataGrid / DetailsList {#grid:fluent-datagrid}

- **license:** MIT, single tier (`microsoft/fluentui`). Both the v9 `@fluentui/react-components` DataGrid and the legacy v8 DetailsList are free.
- **rendering:** DOM. v9 renders semantic table elements via `Table`/`TableRow`/`TableCell` primitives styled with Griffel CSS-in-JS; DetailsList renders div-based rows with ARIA grid roles. No canvas in either.
- **virtualization:** **Not in the core v9 DataGrid.** Virtualization is not part of `@fluentui/react-table`; it comes from out-of-band contrib packages — `@fluentui-contrib/react-data-grid-react-window` for rows and `@fluentui-contrib/react-data-grid-react-window-grid` for 2D (row+column), both wrapping `react-window`. The 2D variant changes the API: you render cells directly and `DataGridRow` is not used. The older v8 DetailsList *does* virtualize rows out of the box. This is a genuine regression v8 → v9 and a recurring complaint in the project's own discussions. No documented row ceiling.
- **nesting:** not documented for the v9 DataGrid — no master-detail, tree data, row grouping or nested-grid API in `@fluentui/react-table`. (v8 DetailsList had `GroupedList`/grouped headers; the v9 equivalent is not documented.)
- **charting:** No chart integration in DataGrid. Charts ship as a separate package (`@fluentui/react-charting`), not wired to the grid. Select-a-range-and-chart: not documented.
- **formula:** not documented (checked the react-table package docs).
- **pivot:** not documented. Note the naming trap: Fluent's `Pivot` component is a **tab strip**, not a pivot table.
- **editing:** No cell editor, editing state, validation, clipboard paste, fill handle or undo — none documented. You compose editing yourself inside a cell renderer. Selection (single/multi) and column resizing are the interaction features that exist.
- **framework:** React only for v9 DataGrid. Microsoft also ships Fluent web components separately.
- **dataModel:** Client-side array only. The composable hooks — `useTableFeatures` with `useTableSort`, `useTableSelection`, `useTableColumnSizing` — operate over an in-memory items array. No server-side/infinite/viewport row model and no database integration documented.
- **distinctive:** The architecture is the interesting part: v9 splits into **`Table` primitives** (composable subcomponents) and **`DataGrid`** (an opinionated wrapper over `useTableFeatures`), each feature an opt-in hook so you only pay bundle size for what you use — headless-plus-components, with the docs explicitly telling you to drop to the primitives when your scenario diverges. The cost is that it is a **styled table with a few hooks, not a grid engine**: no virtualization in core, no grouping, no editing, no server data model. The older v8 DetailsList is in several respects still the more capable component, which is why migration guides advise leaving the grid for last and running v8 alongside v9 during transition.

Sources: https://storybooks.fluentui.dev/react/?path=/docs/components-datagrid--docs, https://raw.githubusercontent.com/microsoft/fluentui/master/packages/react-components/react-table/library/README.md, https://github.com/microsoft/fluentui-contrib/blob/main/packages/react-data-grid-react-window-grid/README.md, https://github.com/microsoft/fluentui/discussions/29813

### Carbon Data Table (IBM) {#grid:carbon-data-table}

- **license:** Apache-2.0, single tier (`carbon-design-system/carbon`, actively pushed 2026-09-04).
- **rendering:** DOM — a semantic `<table>` with Carbon's class names. No canvas.
- **virtualization:** **None documented.** The usage guidance covers row sizes, pagination and skeleton loading states; virtualization and large-dataset handling are not documented anywhere on the Data Table usage page. Pagination is the documented answer to volume, so there is no row ceiling because there is no windowing.
- **nesting:** Expandable rows are documented (`TableExpandRow` / `TableExpandedRow` in React), including a batch-expand control to open all sections at once, and expandable can combine with selectable (expand icon left of the selection icon). The expanded region takes arbitrary content, so it can host another table. Tree data, aggregating row grouping and a true master-detail row model: not documented.
- **charting:** Not part of Data Table. IBM ships charting as a separate library (Carbon Charts), not integrated. Select-a-range-and-chart: not documented.
- **formula:** not documented (checked the Data Table usage docs).
- **pivot:** not documented (checked the Data Table usage docs).
- **editing:** Inline editing is **not documented** on the usage page. What is documented is a toolbar of up to five actions with search, a batch-action bar appearing when rows are selected, per-row overflow menus, and five row-height sizes (xs/sm/md/lg/xl) with a rule that the header row matches the body row size. Clipboard paste, fill handle, validation and undo: not documented.
- **framework:** React is the first-party implementation maintained by the Carbon core team (`@carbon/react`, itself a wrapper over Carbon Web Components). Web Components, Angular, Vue and Svelte implementations exist but are **community-maintained**, and they diverge — the Svelte DataTable has a `stickyHeader` prop incompatible with custom column widths, a feature interaction with no equivalent in the design-system spec.
- **dataModel:** Client-side only. The React `DataTable` is a render-prop component over an in-memory `rows`/`headers` array managing sort and selection state; no server-side, infinite or viewport row model and no database integration documented. Server paging is left to the consumer via the standalone Pagination component.
- **distinctive:** **A design-system table, not a grid engine** — the clearest case of that in this survey. Its unit of thought is the *design spec* (row heights, header/row size parity, batch-action bar behaviour, skeleton-not-spinner loading), not the *data pipeline*. Its actual moat is non-technical: IBM's accessibility and design-review process specifies the interaction patterns to a level of detail almost no component library matches. If you are shipping a competing grid, Carbon is not a competitor — it is a downstream consumer that would happily wrap a real engine.

Sources: https://carbondesignsystem.com/components/data-table/usage/, https://github.com/carbon-design-system/carbon-website/blob/main/src/pages/components/data-table/usage.mdx, https://github.com/carbon-design-system/carbon-components-react/blob/master/src/components/DataTable/README.md, https://svelte.carbondesignsystem.com/components/DataTable

### Bootstrap Table {#grid:bootstrap-table}

- **license:** MIT for the code, CC BY 3.0 for the documentation. Single tier, no gated features. Version 1.27.3; repo `wenzhixin/bootstrap-table`, ~11.8k stars, actively committed.
- **rendering:** DOM. A jQuery plugin that decorates or generates a real `<table>` — it reads configuration from `data-*` attributes on existing markup or builds the table from JSON. **jQuery is a hard dependency.** No canvas.
- **virtualization:** **None.** No windowing or virtual scroll documented. The scale answer is server-side pagination (`sidePagination: 'server'`), plus a `sticky-header` extension and a scrollable fixed-header mode for the visual effect only.
- **nesting:** Two mechanisms. A **detail view** (per-row expander rendered via `detailFormatter`) gives master-detail and can host another Bootstrap Table. The **treegrid** extension gives hierarchical rows, and **group-by-v2** gives grouped rows. Nothing is a first-class row model; each is a plugin over the same flat table.
- **charting:** not documented (checked the site and the extensions directory).
- **formula:** not documented (checked the site and the extensions directory).
- **pivot:** not documented (checked the site and the extensions directory).
- **editing:** Not in core — provided by the **editable** extension (built on X-editable), giving per-cell inline editors. Clipboard/Excel paste, fill handle, validation and undo: not documented. Export is a separate **export** extension (CSV/JSON/XLSX/PDF via TableExport).
- **framework:** Framework-agnostic jQuery, targeting multiple CSS frameworks rather than multiple JS frameworks: Bootstrap 3/4/5, Semantic UI, Bulma, Material Design and Foundation. A Vue.js wrapper is referenced in the repo.
- **dataModel:** Client-side array or AJAX-loaded JSON, plus a genuine server-side mode where paging, sorting and searching parameters are sent to a URL you supply. No infinite/viewport row model, no direct database integration.
- **distinctive:** The **extension ecosystem is the product**: the core is a deliberately small jQuery table and everything else bolts on — 24 extension directories ship in `src/extensions`, including treegrid, editable, export, filter-control, fixed-columns, group-by-v2, reorder-rows/columns, resizable, sticky-header, multiple-sort, cookie (persist state), addrbar (sync state to the URL), print, copy-rows, auto-refresh, custom-view, mobile, i18n-enhance and pipeline. The other distinguishing trait is **declarative HTML configuration** — a sortable, paginated, server-backed table entirely from `data-*` attributes with zero JavaScript, which no modern framework grid offers. The trade-off: jQuery, no virtualization, and a feature set that composes only as far as the extensions happen to compose with each other.

Sources: https://bootstrap-table.com/, https://github.com/wenzhixin/bootstrap-table, https://github.com/wenzhixin/bootstrap-table/tree/develop/src/extensions

### jqGrid / free-jqGrid {#grid:jqgrid}

- **license:** The messiest licensing story in the survey, and a two-way fork rather than a tier structure. Tony Tomov's original jqGrid was **MIT/GPLv2 dual-licensed through 4.7.0 (2014-12-08)**. Immediately after, the project relicensed and rebranded as **Guriddo jqGrid JS**: free only under **CC BY-NC 3.0** (non-commercial), with commercial use paid — Standard $239, Subscription $359 (adds updates, 10 support hours, 36-hour SLA), plus multi-developer, Enterprise (source access) and OEM tiers. **free-jqGrid** is a community fork *of 4.7.0* — the last MIT/GPL commit — maintained by Oleg Kiriljuk, staying MIT/GPL dual-licensed; GitHub reports it as "Other" with no SPDX id, so a legal review would need to read the LICENSE text rather than trust the badge. Practically: free-jqGrid is genuinely free for commercial use; anything branded Guriddo is not.
- **rendering:** DOM. jQuery plugin generating a real `<table>`. No canvas.
- **virtualization:** **None** in the windowing sense. `scroll: 1` "virtual scrolling" is really AJAX-paged infinite scrolling — it fetches the next page as you scroll and does not maintain a fixed DOM window. No row ceiling documented.
- **nesting:** Unusually strong for its era. **SubGrid** embeds a full second jqGrid inside an expanded row (a grid inside a grid, first-class, not a formatter hack), **TreeGrid** provides hierarchical rows in adjacency or nested-set form, and **grouping** provides collapsible grouped rows with per-group summary rows.
- **charting:** not documented (checked the free-jqGrid repo and the Guriddo product pages).
- **formula:** No Excel-style formula engine. Column-level aggregate footers/group summaries exist (sum/count/avg/min/max), which is aggregation, not formulas.
- **pivot:** **Yes** — a client-side `jqPivot` transforms a flat input array into a pivoted grid with cross-tab column generation and aggregation. Client-side only; server-side pivot: not documented. It is present in free-jqGrid (MIT), notable because pivot is a paid-tier feature in most modern grids.
- **editing:** The deepest editing story of the DOM-table generation: **inline editing**, **cell editing** and **form editing** (a generated modal add/edit dialog), with per-column `editrules` validation (required, number, integer, email, url, date, min/max, custom), typed `edittype` editors (text, textarea, select, checkbox, password, file, custom), and a full CRUD navigator toolbar wired to server URLs. Clipboard/Excel paste, fill handle and undo: not documented.
- **framework:** jQuery / jQuery UI only — no Angular, React or Vue bindings. free-jqGrid adds Bootstrap 3/4 theming and Font Awesome 4/5 icon sets.
- **dataModel:** Built server-first, unusual for its time: `datatype: 'json'|'xml'|'local'|'function'`, with the server receiving page/rows/sidx/sord/search parameters and returning `{total, page, records, rows}`. `loadonce` flips a server-fed grid into client-side mode after first load. No direct database integration in the JS, but the whole contract is shaped around a paging backend.
- **distinctive:** For a 2009-era jQuery plugin it has a feature list that embarrasses several modern design-system tables — nested SubGrids, TreeGrid, client-side pivot, and three distinct editing modes with declarative validation rules, all MIT in the free-jqGrid fork. **Maintenance status, honestly: dormant.** free-jqGrid's last push was **2023-08-22**, three years stale; not archived, but 76 open issues, ~479 stars, last release 4.15.5. The commercial Guriddo product continues under CC BY-NC / paid terms. Treat free-jqGrid as a well-stocked reference implementation and a licensing cautionary tale — a widely-adopted MIT grid that relicensed out from under its users, forcing a fork that then slowly died — rather than a live competitor.

Sources: https://github.com/free-jqgrid/jqGrid, https://free-jqgrid.github.io/jqGrid/, https://guriddo.net/?page_id=103334, http://www.trirand.com/blog/?page_id=400

### Material React Table {#grid:material-react-table}

- **license:** MIT, single tier, no paid edition and no feature gating. Every documented feature (virtualization, aggregation, editing, pinning) is in the one free package. Its cost is transitive dependency weight, not money: it hard-depends on Material UI v6 and TanStack Table v8, and the docs quote "30-56kb gzipped" for MRT itself on top of MUI.
- **rendering:** DOM. Normally it emits semantic MUI `<Table>` markup; when virtualization is switched on, `layoutMode` flips automatically to `'grid'` and the table renders as CSS Grid/Flexbox `<div>`s instead. No canvas or WebGL path documented.
- **virtualization:** Row and column, both opt-in via `enableRowVirtualization` / `enableColumnVirtualization`, powered by `@tanstack/react-virtual` v3. No ceiling documented — the guidance is a floor instead ("only becomes necessary when you have more than 50 rows or so at the same time with no pagination"), and the reference demo runs 10,000 rows.
- **nesting:** Expanding sub-rows (tree data) and a detail panel are both documented as first-class guides, plus row grouping with aggregation. A detail panel renders arbitrary React, so a grid inside a grid is possible by construction, but nested-grid support as a named feature is not documented. Master-detail as a distinct server-driven row model is not documented.
- **charting:** not documented. There is no charting entry in the feature list or the guides index.
- **formula:** not documented. No Excel-formula engine appears anywhere in the docs or feature list.
- **pivot:** not documented. It has grouping and aggregation (Sum, Average, Count, etc.) but no pivot mode — grouping collapses rows, it does not project fields onto a column axis.
- **editing:** Five editing modes — modal (default), row, cell, table, and custom. Editor variants documented are text (default) and select; autocomplete/date variants are not documented as built-ins. Validation is done by hand through `muiEditTextFieldProps` `onBlur`/`onChange` handlers setting error state, not through a declarative rule set. Clipboard/Excel paste, fill handle, and undo are all not documented.
- **framework:** React only, React 18+, with Material UI v6 as a peer requirement.
- **dataModel:** Client-side by default, with every heavy operation (filtering, pagination, sorting) documented as switchable to server-side via manual mode; async loading is a documented guide. No direct database integration and no viewport/infinite row model in the AG-Grid sense.
- **distinctive:** It is the "batteries-included" packaging layer over a headless core — what it adds over raw TanStack Table is not table logic but the ~40 pre-wired MUI surfaces (column action menus, density toggle, full-screen toggle, drag handles, filter variants, 30+ locales) that a team would otherwise hand-build on top of the headless hook. Architecturally it inherits everything from TanStack: same DOM rendering, same client-first model, same absence of pivot/charts/formula. The moat is breadth of finished UI, not engine capability, and it is trivially replaceable by anyone willing to write that UI themselves.

Sources: https://www.material-react-table.com/, https://www.material-react-table.com/docs/guides/virtualization, https://www.material-react-table.com/docs/guides/editing, https://github.com/KevinVandy/material-react-table/blob/v3/README.md

### Mantine React Table {#grid:mantine-react-table}

- **license:** MIT, single tier, no paid edition. Same shape as MRT — no feature gating.
- **rendering:** DOM, via Mantine v7 table components. Described by its own README as "A fully featured Mantine V7 implementation of TanStack React Table V8, forked from Material React Table," so the rendering strategy is the fork parent's. Canvas/WebGL: not documented.
- **virtualization:** Documented as a guide topic ("Virtualization (Large Data)") inheriting TanStack Virtual from the fork parent. No documented row ceiling. Whether column virtualization is separately exposed is not documented at the guides-index level.
- **nesting:** Detail panel (expanding) and expanding sub-rows (tree data) are both documented guides, plus aggregation and grouping. Nested grid as a named feature is not documented; master-detail as a server row model is not documented.
- **charting:** not documented. Absent from the 32-guide index.
- **formula:** not documented.
- **pivot:** not documented. Aggregation and grouping only.
- **editing:** "Data Editing (4 different editing modes)" per the README — one fewer than MRT's five as documented. Editor variants, validation mechanics, clipboard paste, fill handle and undo are not documented at the guides-index level.
- **framework:** React only, with Mantine v7 as the peer UI library.
- **dataModel:** Client-side by default; filtering, sorting and pagination are documented as supporting server-side, and there is an async-loading guide. No direct database integration.
- **distinctive:** It is the same product as Material React Table with the design system swapped — same author (KevinVandy), same TanStack v8 engine, same guide list almost line-for-line. That is the finding: the "MRT-class" grid is a UI-shell layer thin enough to be re-skinned wholesale, which tells you the defensible value in this tier sits in the headless engine underneath, not in either wrapper. Practically it exists so Mantine shops do not have to pull MUI in for one component.

Sources: https://www.mantine-react-table.com/docs/guides, https://github.com/KevinVandy/mantine-react-table, https://www.mantine-react-table.com/

### svelte-headless-table {#grid:svelte-headless-table}

- **license:** MIT (npm license badge on the README; no dual tier, no paid edition). Free in full.
- **rendering:** None — it is headless. It computes table state and hands back stores; the consumer writes every `<table>`/`<div>` element. There is an `addGridLayout` plugin that supplies CSS-Grid-oriented layout state, but the library itself emits no markup.
- **virtualization:** not documented — no virtualization plugin exists in the plugin list (addSortBy, addColumnFilters, addTableFilter, addColumnOrder, addHiddenColumns, addPagination, addSubRows, addGroupBy, addExpandedRows, addSelectedRows, addResizedColumns, addGridLayout). Because rendering is the consumer's job, virtualization is also the consumer's job. No row ceiling documented.
- **nesting:** Sub-rows (`addSubRows`), row grouping with aggregation (`addGroupBy`), and expansion (`addExpandedRows`) exist as plugins. Master-detail and nested grids are not documented.
- **charting:** not documented.
- **formula:** not documented.
- **pivot:** not documented. Grouping with aggregation only.
- **editing:** not documented — there is no editing plugin. Cell editing, validation, clipboard paste, fill handle and undo are all outside the library's scope by design.
- **framework:** Svelte 3 and 4 only. Svelte 5 is explicitly not coming from this repo.
- **dataModel:** Client-side over a Svelte store of rows. Server-side/infinite/viewport row models and database integration are not documented.
- **distinctive:** The honest headline is maintenance status, not features. The maintainer's own README says he has "been struggling to juggle my full-time job and this project simultaneously," states there are no plans for a Svelte 5 port and no maintenance schedule for Svelte 3/4, will merge incoming PRs only, and recommends looking elsewhere for new projects. The repo is not archived, but it is frozen at the Svelte 4 boundary while Svelte 5 runes are the current model — so a third-party fork (humanspeak/svelte-headless-table, runes-native, ~15 plugins) is where the lineage continues. For a competitor this is a live vacancy in the Svelte ecosystem rather than a rival.

Sources: https://github.com/bryanmylee/svelte-headless-table/blob/main/README.md, https://svelte-headless-table.bryanmylee.com/, https://github.com/humanspeak/svelte-headless-table

### Salesforce Lightning Datatable {#grid:lightning-datatable}

Provenance note: `developer.salesforce.com` returned HTTP 403 to direct fetch on every attempt (three URLs tried), so the doc-page facts below come from indexed excerpts of those exact pages rather than a successful fetch; the GitHub repo cited was fetched directly.

- **license:** Not a licensed component at all — it ships as part of the Salesforce platform and is consumed under a Salesforce org subscription. There is no standalone SKU, no per-seat component price, and no npm-installable licensed build. The `base-components-recipes` reference implementation was published MIT but is archived (May 2023) and points users to the `lightning-base-components` npm package instead.
- **rendering:** DOM, Salesforce Lightning Design System markup, driven by Lightning Web Components. Canvas/WebGL: not documented.
- **virtualization:** No virtualization is documented. Instead, the performance guidance is a hard advisory ceiling: Salesforce's own testing puts best performance at a maximum of ~1,000 rows and 5 columns, recommends loading at most 50 rows at a time, and directs you to `enable-infinite-loading` with an `onloadmore` handler (default trigger 20px from the bottom, tunable via `load-more-offset`) rather than to a virtual scroller. That is a paging strategy, not row recycling.
- **nesting:** Row grouping, master-detail and nested grids are not documented on the datatable. Tree data lives in a *separate component*, `lightning-tree-grid`, which the docs describe as implementing `lightning-datatable` internally with expandable rows, styled for up to 20 nested levels, and with some datatable features unavailable. A grid inside a grid is not documented.
- **charting:** not documented.
- **formula:** not documented. (Salesforce formula fields are a data-layer feature of the platform, not a grid capability.)
- **pivot:** not documented.
- **editing:** Inline editing via `editable` on the component plus `editable: true` per column; edits accumulate in `draft-values`, surface an `oncellchange` event, and are committed through an `onsave` handler that you implement — so the grid tracks the diff but the persistence is yours. Typed column renderers (text, number, percent with fraction-digit control, date/time honouring the user's Salesforce locale, currency, url, button, action) double as editors. Declarative validation, clipboard/Excel paste, fill handle and undo are not documented.
- **framework:** Lightning Web Components only. Not published for React, Angular or Vue. The archived reference repo states plainly that "Base Components in the `c` namespace are intended for use on the Salesforce platform," with off-platform use described as experimental.
- **dataModel:** Client-side array of records passed to `data`, with `enable-infinite-loading` for progressive append. The "direct database integration" is the platform itself — records typically arrive via Apex or the LWC wire adapters against Salesforce objects, which is the tightest data coupling in this set and also the least portable.
- **distinctive:** The distinctive fact is the lock, not the feature list. This is the most-deployed grid in enterprise CRM by sheer install base, and it cannot be used outside Salesforce — no license to buy, no framework build to install, and even the MIT reference implementation is archived and dependency-bound. Feature-wise it is a modest grid whose documented performance envelope (~1,000 rows × 5 columns) is one to two orders of magnitude below every commercial grid here. For a competing MIT grid it is not a competitor in the addressable market at all; it is a captive-audience baseline, and the interesting signal is that Salesforce shops routinely reimplement it because the stock component runs out of road so early.

Sources: https://developer.salesforce.com/docs/platform/lightning-component-reference/guide/lightning-datatable.html, https://developer.salesforce.com/docs/platform/lwc/guide/data-table-performance.html, https://developer.salesforce.com/docs/platform/lightning-component-reference/guide/lightning-tree-grid.html, https://github.com/salesforce/base-components-recipes

### Kendo UI Grid (Telerik) {#grid:kendo-grid}

- **license:** Commercial, subscription (annual, not perpetual), and the Grid is explicitly outside the free tier. Kendo UI Core is Apache-2.0, but its own comparison table marks Grid ❌ for Core and ✅ for Professional. Paid tiers are sold as support levels over the same code — Lite $799/yr (72h response, 10 incidents), Priority $899/yr (24h, unlimited), Ultimate $1,299/yr (adds phone/remote); one purchase covers all four framework libraries (450+ components across Angular, React, jQuery, Vue). Wider bundles: DevCraft UI $1,149/yr, Complete $1,299/yr, Ultimate $1,649/yr. KendoReact additionally enforces licensing at runtime — "Using the KendoReact Grid requires either a commercial license key or an active trial license key" — so this is one of the few grids that will not simply run unlicensed.
- **rendering:** DOM. Canvas/WebGL: not documented.
- **virtualization:** Row and column virtualization are both documented for KendoReact ("With row and column virtualization, you can render only the visible data"); Kendo Angular documents virtual scroll for row data, and column virtualization is not documented on its Grid overview; Kendo jQuery documents "paging, virtualization and infinite scrolling." No row ceiling is documented on any flavour.
- **nesting:** Master-detail is documented across flavours — Angular via a detail row template, jQuery as a "hierarchical Grid," React as "Master-detail layout." Grouping with aggregates is documented everywhere. Because the detail row is a template, a Grid inside a Grid is the standard hierarchy idiom rather than a special feature.
- **charting:** Not in the Grid. Kendo ships Charts as separate components in the same suite; range-select-and-chart from the grid is not documented.
- **formula:** Not in the Grid — but the suite includes a separate **Spreadsheet** widget that "supports many of the Excel formulas and functions," supports array formulas, and lets you register custom ones via `kendo.spreadsheet.defineFunction(name, func)`. An exact function count is not documented on the Grid pages.
- **pivot:** Not in the Grid; a separate **PivotGrid** widget (and a rewritten PivotGrid v2 for jQuery, plus a PivotGrid for Angular) handles it, binding to an OLAP cube or to flat data, locally or remotely, with KPI support.
- **editing:** In-cell and inline edit modes plus editing from an external form (Angular); jQuery lists editing among core features; React documents Clipboard and keyboard navigation as separate Grid features. Declarative validation, fill handle and undo are not documented on the Grid overview pages.
- **framework:** Four first-class flavours — jQuery, Angular, React, Vue — each a native implementation rather than a wrapper, all covered by one licence.
- **dataModel:** Remote data binding via built-in and custom data-binding directives (Angular), plus "Streaming data" and remote data for React; virtualization and infinite scrolling supply the large-dataset path. Direct database integration is not documented on the JS side.
- **distinctive:** The suite-decomposition is the architecture: Telerik does not build one omni-grid, it builds Grid + PivotGrid + Spreadsheet + Charts as separate licensed widgets and expects you to compose them. So the "AG-Grid Enterprise" bundle of pivot-plus-charts-inside-the-grid does not exist here; you get four narrower, older, very heavily hardened components instead, times four frameworks. The moat is the four-framework parity under a single subscription — replicating Angular, React, Vue and jQuery natively is four engineering surfaces, and the runtime license-key enforcement in KendoReact shows they treat that investment as something to be defended in code.

Sources: https://www.telerik.com/kendo-ui/grid, https://www.telerik.com/purchase/kendo-ui, https://github.com/telerik/kendo-ui-core, https://www.telerik.com/kendo-react-ui/components/grid/, https://www.telerik.com/kendo-angular-ui/components/grid/

### Syncfusion DataGrid {#grid:syncfusion-grid}

- **license:** Two tiers over identical code. A **Community License** is genuinely free for commercial use, but the eligibility test is unusually strict and compounding: under $1M USD annual gross revenue **and** never having taken more than $3M USD in outside capital **and** 5 or fewer developers **and** 10 or fewer total employees. It "continues until you or your company are ineligible," so a funding round or a sixth developer terminates it. Government-related organisations funded by tax dollars are excluded outright. Everyone else pays. This is the notable term: the gate is on *the company*, not on the features — you get the whole enterprise grid free, or you get nothing free.
- **rendering:** DOM. Documented as DOM virtualization that "lightens the browser's load by minimizing the DOM elements." Canvas/WebGL: not documented.
- **virtualization:** Row and column. Rows load on demand while scrolling vertically ("load millions of records"); columns via `enableColumnVirtualization`, which renders only in-viewport columns. Column virtualization carries documented constraints worth noting for anyone building the same thing: widths must be in pixels (percentages rejected, undefined defaults to 200px), selection state outside the viewport is lost, cell selection is unsupported, and Ctrl+Home/Ctrl+End stop working. No absolute row ceiling documented.
- **nesting:** Hierarchy via `childGrid` + `childGrid.queryString` with the `DetailRow` module injected — literally a Grid inside a Grid, to "n level of child grids" with no documented depth limit. There is also a detail template, but the docs state hierarchical binding and DetailTemplate are mutually exclusive. Row grouping with aggregates is documented separately, and a distinct TreeGrid component covers tree data.
- **charting:** Charts integration is listed on the DataGrid product page, and Syncfusion ships a separate Charts control suite. Range-select-then-chart from within the grid is not documented.
- **formula:** Not in the Grid. Syncfusion has a separate **Spreadsheet** control with a formula engine plus a "Calculate" library; the docs also acknowledge gaps — INDIRECT, TEXTJOIN and LEFT are noted as not natively supported. Exact function count: not documented.
- **pivot:** Not in the Grid; a separate **Pivot Table** control provides drill up/down, Excel-like filtering and sorting, editing, Excel/PDF export, built-in aggregations, a field list, and calculated fields. The Grid itself does grouping and aggregation only.
- **editing:** Normal/inline (double-click to edit), dialog, and **batch** — batch is the Excel-like one, where cell-by-cell edits accumulate and commit together via the toolbar Update button or `batchSave()`, with a confirm dialog on by default. Editors: `numericedit`, `datepickeredit`, `dropdownedit`, plus custom controls and templates; foreign-key, complex (`Name___FirstName`), boolean and enum column editing all documented. Validation is declarative (`required: true, number: true`, min/max). Clipboard/Excel paste and fill handle: not documented. Undo: not documented.
- **framework:** JavaScript/TypeScript, React, Angular, Vue, Blazor, plus ASP.NET Core and MVC wrappers over the same EJ2 core.
- **dataModel:** Local or remote — JSON, REST, OData, and custom adaptors — with virtual scrolling and infinite scrolling for large sets, plus live/streaming updates and state persistence. Direct database integration is not documented client-side (it goes through the data-adaptor layer).
- **distinctive:** Breadth-per-dollar with a company-size gate. The unusual thing is not any single grid feature — it is that a solo founder or a 5-person shop gets the *entire* enterprise control suite (grid, pivot, spreadsheet, charts, PDF/Excel libraries, 4+ frameworks) at zero cost while a funded startup at the same headcount does not, because the $3M outside-capital clause disqualifies on the cap table rather than on usage. Technically the grid is a very complete DOM grid whose closest architectural sibling here is Kendo: capability split across separate Grid / Pivot / Spreadsheet controls rather than unified.

Sources: https://www.syncfusion.com/javascript-ui-controls/js-data-grid, https://www.syncfusion.com/products/communitylicense, https://ej2.syncfusion.com/javascript/documentation/grid/scrolling/virtual-scrolling, https://ej2.syncfusion.com/documentation/grid/hierarchy-grid, https://ej2.syncfusion.com/documentation/grid/editing/batch-editing

### DevExtreme DataGrid (DevExpress) {#grid:devextreme-datagrid}

- **license:** Commercial, subscription, per-developer — "Each developer within your organization must obtain an individual license for DevExtreme UI components." Tiers: DevExtreme Complete $899.99/yr, ASP.NET & Blazor (includes DevExtreme) $1,099.99/yr, DXperience $1,699.99/yr, Universal $2,299.99/yr; renewals $449.99–$1,149.99. Each includes 12 months of updates and support, **source code access**, and royalty-free redistribution; 30-day trial and a 60-day money-back guarantee. There is no free community tier and no open-source edition — but note the product's GitHub repo is public, so the code is readable while the licence is not free.
- **rendering:** DOM. Column virtualization is described in terms of DOM removal ("once a column becomes invisible during scrolling, it's removed from DOM"). Canvas/WebGL: not documented.
- **virtualization:** Row and column. Three row scrolling modes: `standard` (all rows at once, paged), `virtual` (pages load on entering the viewport and are removed on leaving, with `preloadEnabled` for adjacent pages), and `infinite` (next page loads when the scrollbar hits the end). Column virtualization via `scrolling.columnRenderingMode: 'virtual'` (since v18.1), which requires `columnWidth`, `columnAutoWidth`, or an explicit width on all columns. No documented row ceiling.
- **nesting:** Master-detail is a headline capability — "build and display master-detail layouts of any complexity" — and the detail section takes arbitrary content, so a DataGrid inside a DataGrid is the normal pattern. Multi-column grouping is documented. Tree data is a **separate component**, TreeList, not a DataGrid mode.
- **charting:** Not in the DataGrid. The suite ships Charts separately (30+ chart types) alongside gauges, sparklines, treemaps and diagrams. In-grid range-select-to-chart: not documented.
- **formula:** not documented — the suite has no Spreadsheet component and no formula engine. Aggregation is via summary/aggregate functions, not Excel expressions.
- **pivot:** Not in the DataGrid; a separate **PivotGrid** component in the same package handles pivoting. The DataGrid itself does grouping and summaries only.
- **editing:** Five edit modes — row, batch, cell, form, and popup — the widest documented mode set in this cohort, with batch being the accumulate-then-save Excel-like path. Built-in client-side validation with a predefined rule set. Excel export is documented. Clipboard/Excel paste, fill handle and undo are not documented on the pages checked.
- **framework:** React, Angular, Vue, and jQuery, from one codebase; ASP.NET Core/MVC and Blazor wrappers exist in the wider DevExpress lineup.
- **dataModel:** Client array, or remote via DevExtreme's data layer with paged loading driven by the virtual/infinite scrolling modes. Direct database integration is not documented on the JS side (the .NET-side `DevExtreme.AspNet.Data` server library is the intended bridge).
- **distinctive:** The five-edit-mode matrix plus the fact that a paid subscription ships **full source code** — that combination is what enterprises actually buy here, since it converts a black-box dependency into something a team can patch in place when a shipped bug blocks a release. Architecturally it is the same suite-decomposition as Kendo and Syncfusion (DataGrid / TreeList / PivotGrid / Charts as four components), so the DataGrid alone is not a super-grid; it is a very mature, very conservatively-DOM grid whose differentiation is operational (source access, per-dev licence, 60-day refund) rather than a capability no one else has.

Sources: https://js.devexpress.com/React/DataGrid/, https://js.devexpress.com/React/Documentation/Guide/UI_Components/DataGrid/Scrolling/, https://js.devexpress.com/Buy/

### Infragistics Ignite UI Grid {#grid:igniteui-grid}

- **license:** Two-tier, and the free tier is real and recent. **Grid Lite** is MIT-licensed, "free for commercial use," "no licensing fees," explicitly "no feature gating" within its scope, published on npm as `igniteui-grid-lite` — a genuine MIT competitor from a commercial vendor, with React and Blazor versions positioned alongside. The full **Ignite UI** grids are commercial (per-developer subscription; specific pricing not documented on the pages checked), and some capabilities are gated even inside the paid product — Excel/CSV/PDF export services are described as premium features.
- **rendering:** DOM. Marketed as "the world's fastest virtualized Angular data grid"; the Lite variant is delivered as a Web Component that runs "dependency-free with or without a web framework." Canvas/WebGL: not documented.
- **virtualization:** Row **and** column, and this is the vendor's central performance claim: "Virtualized Rows and Columns so you can load millions of records," with remote virtualization for server-backed sources. Grid Lite includes row virtualization only. No hard row ceiling documented — "unlimited rows and columns" is the claim.
- **nesting:** This is the three-variant answer. **Grid** is the flat data grid (with master-detail templating and row grouping). **TreeGrid** displays self-similar hierarchical data of one consistent schema, built either from a child collection per object or from primary/foreign keys, with `expansionDepth` (default `Infinity`) and `hasChildrenKey` supplying the expander flag before children load. **HierarchicalGrid** is the different-schema case: each nesting level is an independently configured grid with its own columns and its own features, with load-on-demand per level, and `showExpandAll` off by default for performance. So a grid literally contains another grid — that is what HierarchicalGrid *is*, and the Grid/TreeGrid split is same-schema-recursive versus different-schema-nested. A separate **PivotGrid** makes four grid components in the family, five counting Lite.
- **charting:** Not in the grid. Notably, chart *creation* appears in the Excel library instead — the Excel library documents "Chart creation" as part of writing XLSX. In-grid charting and range-select-to-chart: not documented.
- **formula:** Yes, but in a sibling library rather than the grid: "The Ignite UI for Angular Excel library includes 300+ formulas, Table support, Conditional Formatting, Chart creation and more." That is a documented ~300-function Excel engine shipped alongside the grids, used for XLSX/XLS/TSV/CSV import-export. In-cell formula entry inside the grid itself is not documented.
- **pivot:** Yes — a dedicated **PivotGrid** component for aggregation and pivoting, with remote operations and state persistence. Excluded from Grid Lite. Remote operations are documented, so both client and server.
- **editing:** Cell, row, and **batch** editing (batch is called out as an advanced feature), with cell/header/edit templating, plus state persistence across sessions. Excel-style filtering and Outlook-style grouping are the two signature interaction models. Clipboard/Excel paste, fill handle and undo are not documented on the pages checked.
- **framework:** Angular (the flagship), Web Components, React, and Blazor, with the same grid family mirrored across them; Grid Lite is framework-agnostic as a Web Component.
- **dataModel:** Local or remote, with remote virtualization, remote sorting and remote filtering documented as first-class, plus paging and load-on-demand per hierarchy level. Direct database integration is not documented.
- **distinctive:** Two things, pointing in opposite directions. Technically, the Grid/TreeGrid/HierarchicalGrid triple is a real architectural position rather than marketing — most vendors fold tree data into one grid with a mode flag, whereas Infragistics separates *recursive same-schema* (TreeGrid, keyed by parent/child or FK) from *heterogeneous nested grids with independent per-level configuration and load-on-demand* (HierarchicalGrid), which is the harder of the two to retrofit. Strategically, the release of MIT-licensed **Grid Lite** — free, unfenced, Web-Component-based, from an incumbent whose business is selling grids — is the most competitively significant fact in this whole survey for a team building an MIT grid: the free-tier floor in this market is being raised by the paid vendors themselves.

Sources: https://www.infragistics.com/products/ignite-ui-angular/angular/components/grids-and-lists, https://www.infragistics.com/products/ignite-ui-angular/angular/components/grid-lite/overview, https://www.infragistics.com/products/ignite-ui-angular/angular/components/treegrid/tree-grid, https://www.infragistics.com/products/ignite-ui-angular/angular/components/hierarchicalgrid/hierarchical-grid

### Wijmo FlexGrid (MESCIUS) {#grid:wijmo-flexgrid}

- **license:** Commercial, per-developer, no free tier. Wijmo Enterprise is $799/developer new, $599/developer renewal, including one year of updates plus Platinum Support; the licence itself is perpetual and royalty-free for distribution. Deployment is separately gated — the $799 covers five hostname deployment licences for internal/non-commercial use only, and each commercial deployment hostname costs an additional $499. SaaS and OEM are explicitly excluded from the standard grant and need a separate agreement. Notably there is one product tier: FlexGrid, FlexSheet, FlexChart, OLAP and the input controls all sit inside the same Enterprise licence rather than being upsold individually.
- **rendering:** DOM. The overview demo describes customizable cells and cell templates rendered into the document; no canvas or WebGL surface is documented.
- **virtualization:** Row and column, applied automatically. MESCIUS states the grid stays fast on large datasets via this mechanism. No documented row ceiling.
- **nesting:** Row grouping (with a drag-target GroupPanel), tree data via hierarchical binding, and row-detail expansion. Master-detail is documented explicitly as either a second linked grid or a nested grid hosted inside a detail row, so a FlexGrid can contain another FlexGrid.
- **charting:** No charting inside FlexGrid itself. FlexChart is a separate control in the same Wijmo suite, covered by the same Enterprise licence. Range-select-and-chart, of the kind AG Grid's integrated charts offer, is not documented on the FlexGrid demo or product pages checked.
- **formula:** Not in FlexGrid. Excel formulas live in FlexSheet, a separate spreadsheet component built on the same grid core, documented at roughly 140+ Excel functions across math/trig, text, logical, statistical, date/time and lookup categories, plus a custom-function registration API. Whether the evaluator is an independently packaged engine is not documented.
- **pivot:** Yes, as the separate `wijmo.olap` module (PivotEngine + PivotGrid + PivotPanel), included in the Enterprise licence. Client-side by default — the docs claim summarisation of hundreds of thousands of records in fractions of a second, computed asynchronously so the UI never blocks. Server-side is also supported: direct connection to SSAS OLAP cubes, or pushing view definitions to a ComponentOne DataEngine/Web API service for server aggregation.
- **editing:** Inline and popup editors, custom editors, quick-edit mode, cell validation both event-based and via CollectionView validation rules, and change tracking with highlighting of modified cells. Clipboard/Excel paste, fill handle and undo are documented for FlexSheet; the FlexGrid overview page does not document a fill handle or undo stack.
- **framework:** Vanilla JavaScript/TypeScript, Angular, React, Vue, and Redux-based apps, each with its own demo track.
- **dataModel:** Client-side CollectionView is the primary model, with server-side/OData and virtual scrolling collection views available; the OLAP module is where genuine server-side computation lives (SSAS cube and DataEngine connections). No direct database driver in the grid itself.
- **distinctive:** The size claim is the pitch — MESCIUS markets the datagrid module at under 150 KB with no dependencies, roughly an order of magnitude below the enterprise grids it competes with, achieved by splitting FlexSheet, FlexChart and OLAP into separate modules you opt into rather than shipping one monolith. The second distinctive move is licensing by *deployment hostname* as well as by developer, which is unusual in this market and makes multi-tenant or many-domain deployments materially more expensive than the $799 headline suggests.

Sources: https://developer.mescius.com/wijmo/demos/Grid/Overview, https://developer.mescius.com/wijmo/pricing, https://developer.mescius.com/wijmo/docs/Topics/Grid/FlexSheet/FlexSheet-Fomulas, https://developer.mescius.com/wijmo/docs/Topics/OLAP/Data/Pivot-Engine-Overview, https://developer.mescius.com/wijmo/docs/Topics/OLAP/OLAP-Architecture

### Bryntum Grid {#grid:bryntum-grid}

- **license:** Commercial only, no free tier — a 45-day trial is the evaluation path. Two published end-user tiers: $680/developer with a 3-developer minimum ($2,040 entry) including Standard support, and $600/developer with a 10-developer minimum ($6,000) including Premium support. Both are **perpetual with one year of free upgrades**, and both include full source code and npm registry access. Critically for anyone building a product: if you ship a SaaS or a commercial redistributable, the EUL does not cover you and you need a subscription-based OEM licence quoted on enquiry. Discounts: 30% charity/education, 15% for a published blog post, startup pricing on request.
- **rendering:** DOM. Bryntum describes vanilla-JavaScript rendering with "minimal DOM interactions" and element reuse, and the layout is composed of one or more subgrids each owning its own horizontal scroller while sharing one vertical scroller.
- **virtualization:** Row virtualization ("virtual rendering") with DOM element recycling, plus lazy loading of large datasets. The subgrid architecture partitions columns into independently scrolled regions rather than virtualizing columns per se; a dedicated column-virtualization guide is not documented. No published row ceiling.
- **nesting:** All four. Tree grid, row grouping (including header grouping), row expander, and explicitly "nested grids" — a row expander whose body hosts a full Grid instance — so a grid can contain another grid. Merged cells spanning rows with identical values are also supported.
- **charting:** Not documented in the Grid product. Bryntum's suite is scheduling-oriented (Scheduler, Scheduler Pro, Gantt, Calendar, Task Board) rather than BI-oriented, and no integrated chart feature or range-to-chart flow appears in the Grid examples index.
- **formula:** There is a `formula` column property, but it is not an Excel calculation engine — it is the entry point for the AI feature added in v6.2.0, where a cell takes syntax like `=AI(Summarize the $meetingNotes)` and the value is generated by an LLM you connect. A conventional spreadsheet function library is not documented. A "Spreadsheet" example exists, but covers cell selection, multi-cell edit and copy/paste rather than formulas.
- **pivot:** Not documented in the Grid examples or product page.
- **editing:** Cell editing with per-column validation (numeric ranges, date formats), popup/window editors via action columns, spreadsheet-style multi-cell selection with copy/paste, and a drag-fill handle (documented in the AI workflow, where dragging the corner square extends generated values down a column). Excel export is a documented feature. An undo stack is not documented for Grid.
- **framework:** Vanilla JS/TypeScript core with first-party wrappers for React ≥16, Vue ≥3 and Angular ≥9 (Node ≥20 to build), plus platform integrations for Salesforce, SharePoint and Power Apps.
- **dataModel:** Client store by default, with documented infinite scroll backed by a server implementation and a paged store doing remote sort and filter — so both viewport-style and paged remote models exist. No direct database integration; the Salesforce/SharePoint integrations are the closest analogue.
- **distinctive:** The LLM-in-a-cell formula is genuinely unlike anything else in this survey — `=AI(...)` as a first-class column type, plus a chat panel bound to the grid that can filter, sort, create and update records from natural language, and an AI filter that turns "show me all tasks completed last week" into a filter set. The other distinguishing trait is commercial rather than technical: the 3-developer minimum means Bryntum has no single-developer price point at all, and the EUL/OEM split makes it the wrong choice for anyone embedding a grid in a product they sell.

Sources: https://bryntum.com/products/grid/, https://bryntum.com/store/grid/, https://bryntum.com/products/grid/examples/, https://bryntum.com/products/grid/docs/api/Grid/feature/AI, https://bryntum.com/blog/creating-ai-powered-columns-in-bryntum-grid/

### Webix DataTable {#grid:webix-datatable}

- **license:** Genuinely dual-licensed, and the split is the whole story. **Webix Standard — which includes DataTable — is available free under GPLv3**, so an open-source project can ship the grid at zero cost provided it accepts copyleft. Commercial use requires Webix Pro, sold as one-time perpetual packs with one year of updates and support: Custom Pack from $848 (1 project, up to 2 developers), Company Pack from $2,499 (1 project, unlimited developers), DevTeam Pack from $3,999 (unlimited projects, 5 developers), Unlim Pack from $9,499 (unlimited projects and developers, priority support). Renewals run 30% off if the subscription is still active. The "complex widgets" — Pivot, SpreadSheet, Kanban, Scheduler, Gantt, File Manager and others, 15 in total — are licensed on top: a Custom Pack bundles anywhere from 1 to 14 of them, so the pack you need depends less on team size than on which widgets you touch.
- **rendering:** DOM. The docs describe a pure-JavaScript component producing scrollable, sortable HTML tables with CSS-styled cells; no canvas path is documented.
- **virtualization:** Row-level, described as a "dynamic mode for handling thousands of records". The mechanism is dynamic loading rather than pure viewport recycling — `datafetch` controls how many records each request pulls (50 by default) and `datathrottle` the milliseconds between calls, with `loadahead` prefetching. Column virtualization is not documented. No stated row ceiling.
- **nesting:** Row grouping and subrows/subviews are documented on DataTable; hierarchical data is served by TreeTable, a separate widget sharing DataTable's API, which supports branch-by-branch dynamic loading. Because a subview accepts any Webix UI component, a DataTable can host another DataTable — master-detail is achieved through the generic subview mechanism rather than a dedicated feature.
- **charting:** Not in DataTable. Webix ships a separate Chart widget in the same library. Range-select-to-chart is not documented.
- **formula:** Not in DataTable. Webix SpreadSheet is a separate complex widget (Pro only, from $848) documenting **over 250 built-in Excel-like formulas** plus a custom-function API — the largest documented function library among the six commercial grids here.
- **pivot:** Yes, but as a separate Pivot complex widget rather than a DataTable feature, and it is Pro-gated. Client-side.
- **editing:** Inline cell editing with a range of editor types, validation, and documented clipboard operations. Fill handle and an undo stack are not documented on the DataTable overview.
- **framework:** Webix is its own UI framework with its own layout and component system rather than a component for someone else's. Wrappers/integration guides exist for Angular, React and Vue, plus documented server-side integrations for PHP, .NET and Java.
- **dataModel:** Client-side collection by default, with dynamic server-side loading on scroll for both flat and hierarchical structures, and server-side sorting/filtering/paging via its own backend protocol. No direct database driver, though the Query widget and the documented PHP/.NET/Java connectors sit close to that role.
- **distinctive:** Webix is not a grid vendor — it is a full UI framework (100+ widgets, its own layout engine) where DataTable is one citizen, and it is the only product in this survey whose grid is available under a real OSI licence (GPLv3). That makes the free-vs-paid line here about *copyleft*, not about features: you get the same DataTable either way, and what money buys is permissive redistribution plus the complex widgets (Pivot, SpreadSheet) that live outside the core.

Sources: https://docs.webix.com/datatable__overview.html, https://docs.webix.com/desktop__dynamic_loading.html, https://docs.webix.com/desktop__treetable.html, https://webix.com/licenses/, https://webix.com/spreadsheet/, https://blog.webix.com/webix-birthday-sale/

### Sencha Ext JS Grid {#grid:extjs-grid}

- **license:** Three published subscription tiers, all **annual per-developer, not perpetual**: Community Edition $0, Pro $1,499/developer/year, Enterprise $1,899/developer/year. Community Edition is the sharpest constraint in this survey — free only for individuals until revenue reaches $10,000/year, with startups and nonprofits capped at 5 developers and the same $10K ceiling. The tier line matters technically as well as commercially: **the pivot grid, the D3 adapter, the Exporter plugin, Calendar and Sencha Test are all Enterprise-only**, while Architect, Themer, Cmd and ReExt (the React interop layer) are Pro-and-up. So a free Ext JS grid cannot pivot or export.
- **rendering:** DOM. The classic toolkit renders through `Ext.view.Table` into HTML, with the `Ext.grid.plugin.BufferedRenderer` plugin instantiated automatically on every grid.
- **virtualization:** Both axes as of the current release. Row buffering has been standard for years via BufferedRenderer, which keeps a small window of rows in the DOM and shifts it when scrolling brings the viewport within `numFromEdge` rows of the rendered edge. Ext JS 8.0 (April 2026) added **horizontal column buffering to the Modern toolkit**, rendering columns as they enter the viewport and interoperating with locking, grouping, filtering and RTL — which is why Sencha's pitch is wide datasets, not just tall ones. No documented row ceiling; BufferedStore is the mechanism for datasets that exceed memory.
- **nesting:** Row grouping, tree grid (`Ext.tree.Panel` shares the grid's column machinery), row expander and row body plugins for master-detail. A grid can be placed inside an expanded row body, so grid-in-grid is achievable through the standard component model.
- **charting:** Yes, and it is tier-gated. Sencha Charts ship with the framework, and the **D3 adapter is Enterprise-only**, giving sunburst, treemap, heatmap and force-layout visualizations. Charting a user-selected grid range is not documented.
- **formula:** Not documented as a spreadsheet feature. Ext JS has a `formulas` concept in its ViewModel/data-binding layer, which computes derived values reactively, but that is application state binding rather than an Excel function library in cells.
- **pivot:** Yes — a dedicated pivot grid component with multiple layout options, described as summarising large datasets rapidly. **Enterprise tier only ($1,899/dev/yr).** Client-side, with the standard store machinery available for remote aggregation.
- **editing:** Cell editing and row editing plugins, a full editor/field library (the framework ships 140+ components, so every form field is available as an editor), and validation through the data model's field validators. Excel export requires the Enterprise Exporter plugin. Fill handle and an undo stack are not documented.
- **framework:** Ext JS is its own framework, not a component for others — it brings a class system, data package, layout engine and two toolkits (Classic for desktop, Modern for mobile/modern). React consumption is possible only through ReExt, which is Pro/Enterprise-gated. GXT covers Java. No Vue or Angular story is documented.
- **dataModel:** The strongest server-side story here by age and depth. `Ext.data.Store` for client-side data, `Ext.data.BufferedStore` for a paged sliding-window model where only requested pages and their neighbours live on the client, with the BufferedRenderer's `scrollToLoadBuffer` debouncing page requests during fast scrolls. Proxies for REST/AJAX/JSONP/localStorage. No direct database integration.
- **distinctive:** It is the veteran, and it is still shipping — Idera acquired Sencha in **August 2017**, and development has continued through 7.9 (April 2025) and 8.0 (April 2026), so "legacy" describes its architecture, not its maintenance status. The genuinely distinctive engineering is the BufferedStore/BufferedRenderer pairing: a sliding page cache on the data side coupled to a sliding DOM window on the render side, which predates and outlives most of its imitators. The distinctive *risk* is that it is an all-or-nothing framework — adopting the grid means adopting the class system, the build tool (Cmd) and the annual per-seat subscription for every developer who touches it.

Sources: https://www.sencha.com/products/extjs/, https://store.sencha.com/, https://www.sencha.com/products/extjs/communityedition/, https://docs.sencha.com/extjs/7.7.0/classic/Ext.grid.plugin.BufferedRenderer.html, https://docs.sencha.com/extjs/7.1.0/classic/Ext.data.BufferedStore.html

### jQWidgets jqxGrid {#grid:jqwidgets-grid}

- **license:** Free tier exists but **explicitly excludes the grid**. The Community licence is $0 and permits personal, internal-company and even commercial use provided copyright notices stay in the JS files — but jqxGrid, jqxScheduler, jqxChart and the other advanced widgets are carved out of it, so the grid is never free. Paid tiers are **perpetual with royalty-free distribution and full source code**: Developer $399 (listed as on sale from $499) for one developer and unlimited projects, Team $1,499 for 5+ developers, and a custom Enterprise/OEM tier. Each includes one year of updates and support; renewal is 50% of the new-licence price. 15-day money-back guarantee. One licence covers the jQuery, Angular, React, Vue, ASP.NET and Blazor builds — you are not charged per framework.
- **rendering:** DOM. jqxGrid is documented as a jQuery widget that renders a DOM table structure and minimises the number of DOM elements through virtualization.
- **virtualization:** **Both rows and columns.** The docs state the grid supports full UI virtualization on both axes, minimising rendered DOM elements for scenarios with thousands of rows *and* columns — column virtualization is comparatively rare in this price bracket. Separately, "Virtual Data" mode populates the grid on demand as the user scrolls or pages. No stated row ceiling.
- **nesting:** Nested grids and master-detail via the row-details feature, with configurable detail-area height and custom data templates; the docs note the layout permits nesting any content, UI element or widget, including another data grid. Outlook-style grouping by dragging columns to a group bar, plus programmatic grouping. Column hierarchy (grouped column headers) is supported. A dedicated tree grid is a separate widget (jqxTreeGrid) rather than a jqxGrid mode.
- **charting:** Not inside the grid. jqxChart is a separate widget covered by the same licence. jQWidgets' own material notes there is no pivot-chart component pairing jqxChart with jqxPivotGrid, and the two components' data formats are not directly interchangeable — so charting a pivot result requires manual transformation.
- **formula:** Not documented. jQWidgets publishes no spreadsheet widget or Excel function library.
- **pivot:** Yes, as the separate jqxPivotGrid widget — described as feature-complete with a pivot table designer for multi-dimensional and hierarchical data. Client-side. Included in the same paid licence as jqxGrid, not a separate purchase, but excluded from Community like every other advanced widget.
- **editing:** Cell editing is shipped as an **optional module you include separately** (`jqxgrid.edit.js`), with built-in validation, inline and popup edit modes, and custom editors. This modular file split is how jQWidgets keeps the base grid small. Clipboard, fill handle and undo are not documented.
- **framework:** jQuery is the native form. Official builds exist for Angular, React, Vue, ASP.NET and Blazor, plus SvGrid, a distinct data grid product for Svelte 5. All covered by one licence.
- **dataModel:** `jqxDataAdapter` binds local arrays, JSON, XML, CSV, tab-delimited files and JSONP for cross-domain, with server-side paging, sorting and filtering, and on-demand virtual data loading tied to scroll or page changes. No direct database integration.
- **distinctive:** Two things stand out and both are commercial rather than architectural. First, it is the cheapest paid entry point in this survey at $399 perpetual for a single developer with source code included — roughly a quarter of an Ext JS seat's *annual* cost — and one purchase covers six framework builds. Second, the modular file design (`jqxgrid.edit.js`, `jqxgrid.grouping.js` and so on) means you load only the features you use, an approach that predates tree-shaking and still yields small payloads. Technically it is close to a commodity jQuery-era grid; the genuine differentiator is that both-axis UI virtualization is standard rather than an enterprise add-on.

Sources: https://www.jqwidgets.com/jquery-widgets-documentation/documentation/jqxgrid/jquery-grid-getting-started.htm, https://www.jqwidgets.com/license/, https://www.jqwidgets.com/jquery-widgets-documentation/documentation/jqxpivotgrid/jquery-pivotgrid-introduction.htm

### Smart UI Grid (HTML Elements) {#grid:smart-grid}

- **license:** Community tier is free but **the Grid is not in it**. Smart UI Community covers 40+ core components for personal, educational and evaluation use, requires attribution in distributed apps, and states plainly that advanced components — Grid, Scheduler, Charts and similar — require a commercial licence. Paid tiers are **perpetual with royalty-free distribution and full source code**, quoted both monthly and annually: Developer at $39/month or $399/year per developer, Team at $149/month or $1,499/year per 5 developers, Unlimited at $2,999 for unlimited developers within one company, and a custom Enterprise tier. All paid tiers bundle one year of support and updates; renewal is 50% off, and volume discounts run 10–35%.
- **rendering:** DOM, via native Custom Elements. The grid is a standards-based web component (`smart-webcomponents` on npm) that renders into the DOM; no canvas surface is documented.
- **virtualization:** Row virtualization is documented, tied to server-side operations — the docs describe virtual scrolling that avoids rendering every row and supports load-on-demand. Column virtualization is not separately documented. No stated row ceiling.
- **nesting:** Tree grid, grouping with expandable groups, and master-detail through nested grids — all documented as Grid features rather than separate components. A CardView alternative rendering is also available. So a grid can contain another grid.
- **charting:** A separate Chart component exists, and the docs include "using with Chart" and "Dashboard Grid" demos wiring the two together, so integration is demonstrated rather than built in. A range-select-and-chart flow inside the grid is not documented.
- **formula:** Yes — "Formulas" is a documented Grid capability, and the Grid additionally has a **Spreadsheet mode**, with separate "Spreadsheet from JSON" and "Spreadsheet with Tabs" demos. The exact number of supported functions is not documented on the pages checked, nor is whether the evaluator is a separately packaged engine.
- **pivot:** Yes, and unusually it exists in two forms: a Pivot Grid capability *within* the Grid component, and a standalone Smart.PivotTable component. Client-side summarisation with sums, averages and other aggregates. Both are behind the commercial licence.
- **editing:** Inline editing in cell, row and form modes, custom editors, and cascading cell editors (where one editor's value constrains another's options). Excel and CSV export via `exportData()`. Conditional formatting and cell-level styling. Clipboard, fill handle and an undo stack are not documented.
- **framework:** Angular 17+, React 18+, Vue 3+, Blazor, and plain JavaScript/TypeScript via ES modules, plus documented integrations for Electron, Next.js, Stencil, Svelte and Ionic. Because the core is a Custom Element, the framework wrappers are thin bindings rather than reimplementations — one engine, many adapters. React components can be rendered directly inside grid cells.
- **dataModel:** Server-side operations through virtual scrolling and load-on-demand, remote binding to REST APIs, and — the unusual part — **documented direct bindings to Firebase, AWS DynamoDB and Azure Cosmos DB**. That is closer to a database UI than most developer grid components attempt.
- **distinctive:** Smart UI is the same house as jQWidgets rebuilt on Custom Elements, and it collapses four product categories into one component: the Grid *is* the spreadsheet (formula cells, tabs), *is* the pivot table, and *is* the card/board/calendar view, switched by props rather than by buying separate widgets — where Wijmo and Webix sell FlexSheet/SpreadSheet and OLAP/Pivot as distinct modules. The cloud-database bindings (Firebase, DynamoDB, Cosmos DB) are the second genuine outlier; no other grid in this survey documents talking to a database service directly. The free-vs-paid line is the simplest here and the least useful to evaluators: Community is a 40-component trial that deliberately withholds the only component anyone comes for.

Sources: https://www.htmlelements.com/docs/grid/, https://www.htmlelements.com/license/, https://www.htmlelements.com/demos/, https://www.htmlelements.com/docs/pivot-table/

### Univer {#grid:univer}

- **license:** Apache-2.0 for the open-source SDK — the `LICENSE` file at `dream-num/univer@dev` is verbatim Apache License 2.0, and `dream-num/univer-presets@dev` is also Apache-2.0, so the widely-repeated claim of a relicensing away from Apache did not happen to the OSS core as of this check. The split is by *package*, not by license revision: Univer Pro ships separately under the "Univer Commercial License", usable unlicensed only for evaluation with watermark, import-size and collaboration quotas. Pro gates collaboration, edit history, import/export (XLSX/DOCX/PPTX), print, charts, pivot tables, sparklines, outlines, shapes, in-cell graphics, data connectors, and the *advanced formula engine*.
- **rendering:** Canvas. The repo describes a shared canvas rendering engine used across spreadsheet/doc/slide document types, with DOM only for chrome and editors.
- **virtualization:** Canvas rendering means only the viewport is drawn, so effectively row+column. The marketing site states support for up to 10M cells; no per-axis row ceiling is documented.
- **nesting:** Row grouping/outlines exist but are Pro-gated. Master-detail and grid-in-grid are not documented — Univer is a workbook, not a component grid; the nesting story is multiple sheets and cross-sheet/cross-workbook references, plus a separate "relational table" product with Grid/Kanban/Calendar/Gantt/Gallery views.
- **charting:** Yes, but Pro-gated. 29 chart types advertised, plus sparklines and 180+ shapes. Range-select-then-chart is not documented on the pages checked.
- **formula:** **528 functions documented** in the sheets formula feature docs (the marketing homepage rounds this to "500+"). The engine **is separable**: `@univerjs/engine-formula` is a headless package and there is a documented Headless SDK path for Node.js, plus a documented recommendation to run calculation in a Web Worker to keep the main thread free. Array/dynamic-array formulas are supported — `FILTER`, `UNIQUE`, `SORT`, `TRANSPOSE`, `MAKEARRAY`, `FLATTEN` are in the function list. Also documented: cross-workbook references, 3D sheet references, circular-reference iteration control, and async batch execution via the Facade API. The Pro "advanced formula engine" is a faster reimplementation — the docs cite 5.19× on a 68K-formula engineering workbook — which means the OSS engine is the slow tier by the vendor's own admission.
- **pivot:** Yes, client-side, **Pro-gated**.
- **editing:** Rich-text in-cell editing, formatting, data validation, conditional formatting, filtering, sorting, freeze panes. Collaborative/simultaneous editing and edit history are Pro. Fill handle and undo/redo specifics are not documented on the pages checked.
- **framework:** React 18/19 officially (16.9/17 minimal), Vue integration, Web Components, and Node.js ≥18.17.0 headless/server-side.
- **dataModel:** Client-side workbook document model, but uniquely also a server runtime — the same document model runs headless in Node for server-side calculation and import/export. No direct database integration documented; data connectors are Pro.
- **distinctive:** This is a full Office suite, not a grid: one canvas rendering engine and one plugin architecture serve spreadsheet, document, slide, and canvas document types, and the *same* model runs on the server. That symmetry — identical formula engine in browser, worker, and Node — is the hard-to-replicate part, and it is what lets them market it as an "office harness for AI agents".

Sources: https://univer.ai/, https://github.com/dream-num/univer, https://github.com/dream-num/univer/blob/dev/LICENSE, https://docs.univer.ai/guides/sheets/features/core/formula, https://docs.univer.ai/guides/sheets/features/advanced-formula, https://docs.univer.ai/guides/pro/license

### Luckysheet {#grid:luckysheet}

- **license:** MIT.
- **rendering:** Canvas grid with jQuery-managed DOM chrome.
- **virtualization:** Canvas viewport rendering; no documented row ceiling. Row/column-level virtualization details are not documented.
- **nesting:** Multiple sheets and pivot tables; master-detail, tree data and grid-in-grid are not documented.
- **charting:** Yes, charts are listed as a feature. The archived README explicitly cites chart styles as one of the areas where Univer is better, so treat this as legacy-quality.
- **formula:** Built-in, remote and custom formulas and functions are documented as a feature category, but **no function count is published** — not documented. The engine is not separable; it is entangled with the workbook UI. Array/dynamic-array formula support is not documented.
- **pivot:** Yes, client-side, free.
- **editing:** Cell formatting and styling, conditional formatting, data filtering and sorting, comments, XLSX import/export, cooperative editing.
- **framework:** Vanilla JS via CDN, with documented usage from Vue 2, Vue 3 + Vite, and React. It is jQuery-based underneath.
- **dataModel:** Client-side only, full workbook JSON in memory.
- **distinctive:** Its distinguishing property today is that it is **dead**. The repository was archived on 2025-10-30 with an explicit notice that it is no longer maintained and that production users should migrate to Univer — same team (DreamNum), rebuilt from scratch. As a technical reference it is still the most-forked free canvas spreadsheet (16.6k stars), but adopting it now means adopting an archived jQuery codebase whose own authors have redirected traffic elsewhere. That is a finding, not a caveat.

Sources: https://github.com/dream-num/Luckysheet, https://dream-num.github.io/LuckysheetDocs/guide/, https://univer.ai/

### FortuneSheet {#grid:fortune-sheet}

- **license:** MIT.
- **rendering:** Hybrid. It inherits Luckysheet's canvas grid but replaces the jQuery layer — the README states it uses "native React/Vue + immer to manage the dom and state", which is also what permits multiple independent instances on one page (a specific Luckysheet defect they set out to fix).
- **virtualization:** Canvas viewport rendering inherited from Luckysheet. No documented row ceiling — not documented.
- **nesting:** Multiple sheets and pivot tables. Master-detail, tree data and grid-in-grid are not documented.
- **charting:** Charts and sparklines are listed in the feature guide.
- **formula:** **No function count is published — not documented.** The calculation layer is a fork of Handsontable's `formula-parser`, published as `@fortune-sheet/formula-parser`; the upstream package exposes its function list only at runtime via `SUPPORTED_FORMULAS`. Practically the engine **is separable** — it is a distinct npm package — but it is a fork of a parser that Handsontable itself superseded with HyperFormula, so it is a generation behind: array/dynamic-array formula support is not documented and the parser lineage predates dynamic arrays.
- **pivot:** Yes, client-side, free.
- **editing:** Formatting and conditional formatting, drag-move cells, fill handle, multi-select, merge, row/column insert/delete/hide/freeze, comments, XLSX import/export plugin, and simultaneous multi-user editing.
- **framework:** React is first-class (`@fortune-sheet/react`); Vue support is listed but on the roadmap rather than complete. Core is framework-agnostic TypeScript.
- **dataModel:** Client-side only.
- **distinctive:** It is the *live* branch of the Luckysheet lineage. Where DreamNum abandoned Luckysheet for a ground-up rewrite (Univer) with a Pro paywall over charts and pivot, ruilisi took the Luckysheet code, ported it to TypeScript, swapped jQuery for React+immer, and kept the whole thing MIT — so pivot tables and charts that cost money in Univer are free here. The tradeoff is stated in the repo: pre-1.0, data structures and APIs may still change.

Sources: https://github.com/ruilisi/fortune-sheet, https://ruilisi.github.io/fortune-sheet-docs/guide/, https://www.npmjs.com/package/@fortune-sheet/formula-parser

### Jspreadsheet (jExcel) {#grid:jspreadsheet}

- **license:** Two products, not two tiers of one. **Jspreadsheet CE is MIT** (`jspreadsheet/ce`, currently v5 with workbook/tab support). **Jspreadsheet Pro is proprietary and paid**, validated by an offline certificate — 12 months for subscription accounts, 100 years for one-time-fee clients, 30 days for demo accounts. Third-party listings put Pro around $1,999/year for a 5-developer team. Pro gates charting, XLSX/PDF/Google Sheets import-export, comments, validation, search, pivot, and client/server collaboration.
- **rendering:** DOM. The CE repo advertises "no use of selectors, leading to faster performance" and describes itself as a lightweight data grid component; an explicit statement of table-vs-div is not documented on the pages checked.
- **virtualization:** not documented as virtualization. What is documented is **pagination and lazy loading** in CE — a different mechanism with a different failure mode. No row ceiling published.
- **nesting:** Merge columns and multi-worksheet workbooks. Master-detail, tree data and grid-in-grid are not documented.
- **charting:** Pro only, listed among the enterprise extensions.
- **formula:** The strongest free-adjacent story in this batch after HyperFormula. **500+ Excel-compatible functions documented** in the Pro function reference, and the list explicitly includes modern dynamic-array functions — `FILTER`, `SORT`, `UNIQUE`, `TRANSPOSE`, `HSTACK`, `VSTACK`, plus lambda-family `BYCOL`, `BYROW`, `MAP`, `REDUCE`, `SCAN` — so array/dynamic arrays are supported. It is **tiered within Pro**: "Formula Basic" ships by default, and the "Formula Pro" extension adds matrix calculations, cross-sheet calculation, secure private scopes, whole-column/row dynamic ranges (`A:A`, `1:1`), and the `%` and `@` operators. The engine is separable to the extent that Pro markets it as runnable "as both a frontend and backend solution", and CE ships its own dependency-free formula engine. Note the hard constraint: all function names, including custom ones, must be capitalized.
- **pivot:** Pro only.
- **editing:** Rich column types (dropdown, calendar, image, checkbox, numeric, color picker, rating, progress), Excel-like copy/paste, drag-and-drop columns, resizable rows, full-screen mode, image upload, keyboard navigation. Validation is Pro.
- **framework:** Vanilla JS core with official React and Vue wrappers, Angular support, jQuery examples, and web-component usage.
- **dataModel:** Client-side, loading from JS arrays, JSON, CSV and XLSX; lazy loading and pagination for larger sets. Pro adds client/server components for collaboration. No direct database integration documented.
- **distinctive:** The cleanest CE/Pro fault line in the batch, and it runs straight through the formula engine — CE gives you an MIT grid with a basic calculator, and everything a spreadsheet actually needs (500+ functions, matrix ops, cross-sheet refs, whole-column ranges) sits behind two stacked paywalls (Pro, then the Formula Pro extension). For a team building an MIT grid, Jspreadsheet is the clearest illustration of where a vendor believes the money is.

Sources: https://bossanova.uk/jspreadsheet/, https://github.com/jspreadsheet/ce, https://jspreadsheet.com/docs/formulas, https://jspreadsheet.com/docs/formulas/functions, https://jspreadsheet.com/docs/v11/license

### x-spreadsheet {#grid:x-spreadsheet}

- **license:** MIT.
- **rendering:** Canvas. It is one of the earliest pure-canvas web spreadsheets and renders the entire grid, including text and borders, to a single canvas.
- **virtualization:** Inherent to canvas — only the visible viewport is painted. No documented row ceiling — not documented.
- **nesting:** Multiple sheets only. Master-detail, tree data, row grouping and grid-in-grid are not documented.
- **charting:** not documented.
- **formula:** Functions are supported but **no function count is published — not documented**. The engine is not separable; formula evaluation lives inside the library. Array/dynamic-array formula support is not documented. Realistically this is a small hand-rolled function set, not an Excel-parity engine.
- **pivot:** not documented.
- **editing:** Cell formatting (font, color, border, alignment), merge cells, freeze panes, undo/redo, copy/cut/paste, autofill, row/column insert/delete/hide, data validation, print.
- **framework:** Framework-agnostic standalone library via npm or CDN; no official framework wrappers documented.
- **dataModel:** Client-side only.
- **distinctive:** Historically important as the proof that a canvas-rendered spreadsheet in ~a single bundle was viable, and it is **unmaintained** — the repository header states the project has migrated to `@wolf-table/table`, with the successor's own activity trailing off around mid-2024. Its real value now is as a compact, readable reference implementation of canvas grid painting and hit-testing, not as a dependency.

Sources: https://github.com/myliang/x-spreadsheet, https://github.com/wolf-table/table

### HyperFormula {#grid:hyperformula}

- **license:** Dual, and this is the trap. **GPLv3 or a paid proprietary licence** — there is no permissive free option. GPLv3 for a browser-shipped library is viral in a way that matters: fine for open-source or internal work, hostile to a closed-source SaaS frontend. Published commercial tiers: Small Business $1,490/yr (≤5,000 users), Big Teams $5,990/yr (>5,000 users), Enterprise custom. Same vendor as Handsontable (Handsoncode).
- **rendering:** None. **This is a headless calculation engine with no UI whatsoever** — the vendor's own phrase is "headless spreadsheet". Rendering is the integrator's problem.
- **virtualization:** Not applicable — no view layer. Scale is a function of the dependency graph, not a viewport.
- **nesting:** Not applicable. It models workbooks → sheets → cells and named expressions; there is no visual nesting concept.
- **charting:** None. Out of scope by design.
- **formula:** This is the whole product, and it is the state of the art in this batch. **423 built-in functions documented** across 13 categories (array manipulation, database, date/time, engineering, financial, information, logical, lookup and reference, math and trigonometry, matrix, operator, statistical, text) — note the README still says "~400", so cite the function-list page, not the README. It is **maximally separable — separability is the product**: runs in browser, Node.js, or a worker, alongside React/Angular/Vue/Svelte or no framework at all. Array/dynamic arrays: yes — an `ARRAYFORMULA()` wrapper enables array arithmetic mode per formula, `ARRAY_CONSTRAIN` truncates results, and `TRANSPOSE`, `SORT`, `UNIQUE`, `HSTACK`, `VSTACK` are present. Also documented: CRUD operations that maintain the graph, undo/redo, clipboard, named expressions, custom functions, and formula localization into 17 languages. **Excluded** by the vendor: database functions in the Excel `DSUM` sense, OLAP/cube, and web-service functions.
- **pivot:** No. Not a feature of the engine.
- **editing:** No UI editing. It exposes a CRUD API (insert/remove rows and columns, move cells, set contents) that rewrites the dependency graph transactionally, plus undo/redo and clipboard semantics at the API level.
- **framework:** React, Angular, Vue, Svelte, plus plain Node.js server-side.
- **dataModel:** In-memory sheet model, engine-owned. No database integration — you feed it arrays or set cell contents through the API.
- **distinctive:** **The dependency graph is the moat, and the specific trick is range-node decomposition.** Every cell is a node in a directed graph, edges are formula references, and evaluation follows dependency order. The naive implementation of a range reference like `SUM(B5:D20)` creates an edge per cell and blows up quadratically; HyperFormula instead inserts *range nodes* and decomposes hierarchically — on seeing `B5:D20` it checks whether a node for `B5:D19` already exists and expresses the larger range as that node plus the edge cells, so overlapping ranges across many formulas share structure instead of multiplying edges. The public API surfaces the graph directly via `getCellPrecedents()` / `getCellDependents()`, though transitive discovery is left to the caller to BFS. Lazy-versus-eager evaluation strategy is not documented. For a team building a formula engine, this is the reference design — and the GPLv3 wall is precisely why building your own may be the point.

Sources: https://hyperformula.handsontable.com/, https://hyperformula.handsontable.com/guide/built-in-functions.html, https://hyperformula.handsontable.com/guide/dependency-graph.html, https://hyperformula.handsontable.com/docs/guide/licensing.html, https://github.com/handsontable/hyperformula

### SheetJS {#grid:sheetjs}

- **license:** **SheetJS Community Edition is Apache-2.0** — genuinely permissive, the most liberal licence in this batch. **SheetJS Pro is proprietary and paid**, sold as separate add-on modules; pricing is not published on the public pages checked (quote-based). Pro modules documented: **Pro Formula** (a formula calculator that evaluates expressions, updates dependent cells and refreshes whole workbooks), **Pro Edit/VBA** (read and write VBA code and UserForms), and **SSF Pro** (locale-aware number and date formatting).
- **rendering:** None. **This is a file-format library, not a grid** — it parses and writes spreadsheet binaries and exposes a plain JS object model. Any rendering is done by whatever grid you pair it with.
- **virtualization:** Not applicable.
- **nesting:** Not applicable. It models workbooks, sheets, ranges, and cells.
- **charting:** None.
- **formula:** Split precisely along the paywall, and this is the decision-relevant fact. **Community Edition reads and writes formula *text* into and out of files but does not evaluate it** — no function count applies because it implements no functions. **Evaluation is a Pro module** (Pro Formula), whose documented function count is not documented on the public pages. The calculator is by construction separable from any UI, since SheetJS has no UI. Array/dynamic-array *evaluation* support is not documented; CE does round-trip array-formula metadata as part of format fidelity.
- **pivot:** No.
- **editing:** No editing UI. CE gives programmatic cell read/write, range utilities, and conversion helpers (sheet↔JSON/CSV/HTML). Excel-fidelity concerns like number formats and VBA are Pro.
- **framework:** Framework-agnostic. Documented targets include Node.js, browsers, React, Vue, Deno, and a long tail of bundlers.
- **dataModel:** Not a data-model product — it produces and consumes an in-memory workbook object. No database integration.
- **distinctive:** **It is not on the public npm registry, and that is the single most operationally important fact about it.** The maintainers pulled out — citing npm's 2FA requirements for top projects, GitHub's decision-making, and legal matters between SheetJS and npm — and now publish exclusively to `https://cdn.sheetjs.com`, installed via a tarball URL rather than a package name. The `xlsx` package still sitting on npmjs.com is frozen at 0.18.5 and is stale, so anyone who "installs SheetJS" the obvious way silently gets an abandoned version. Source hosting also moved off GitHub to self-hosted `git.sheetjs.com`. For a dependency with roughly 1.4M weekly downloads at the time of the move, this breaks every default assumption about lockfiles, private registry mirrors, air-gapped builds and supply-chain scanning — budget for it explicitly.

Sources: https://sheetjs.com/, https://github.com/sheetjs/sheetjs, https://docs.sheetjs.com/docs/getting-started/installation/frameworks/, https://docs.sheetjs.com/docs/csf/features/formulae/, https://git.sheetjs.com/sheetjs/sheetjs/issues/2667

### Kendo UI Spreadsheet {#grid:kendo-spreadsheet}

- **license:** Commercial only. Kendo UI Core is the free Apache-2.0 distribution, but **the Spreadsheet is not in it** — it is one of the advanced components (with Grid and Charts) reserved for the paid product. Since the 2025 Q1 release a licence key file is required at build time, and even trials need a trial key. No free tier for this component.
- **rendering:** DOM. Telerik's guidance frames performance in terms of the weight of generated DOM and recommends limiting rendered rows and columns; no canvas layer is documented.
- **virtualization:** Marketing claims "virtually no limitations on the number of cells" and cites thousands of cells. A Spreadsheet-specific virtualization mechanism is not documented — the virtualization documentation Telerik publishes is for the Grid, not the Spreadsheet, and the Spreadsheet overview instead warns that the component is "primarily targeted at desktop users" with limited mobile performance. No published row ceiling.
- **nesting:** Multiple sheets. Master-detail, tree data, row grouping and grid-in-grid are not documented for the Spreadsheet; PivotGrid is a separate component in the suite.
- **charting:** Not built into the Spreadsheet. Charts are a separate Kendo component in the same paid suite. Range-select-and-chart inside the Spreadsheet is not documented.
- **formula:** Strong and well documented. **463 formulas and functions listed** in the end-user reference, spanning math/trig, statistical, text, date/time, logical, lookup/reference, financial, engineering and conversion. **Array formulas are explicitly supported** with Excel's own semantics — "returns a matrix of values", entered by pre-selecting the target range and pressing Ctrl+Shift+Enter (the legacy CSE model, not modern spill-based dynamic arrays). Custom functions register via `kendo.spreadsheet.defineFunction(name, fn)`, case-insensitive, and **asynchronous custom functions are supported** via `argsAsync` — the documented example fetches currency data from a remote server, a genuinely useful capability most engines here lack. The engine is **not separable**: it lives in the `kendo.spreadsheet` namespace and is not sold or documented as a standalone calculator.
- **pivot:** Not in the Spreadsheet. Separate PivotGrid components exist in the suite.
- **editing:** Cell formatting for strings/dates/numbers, styles and themes, custom editors for predefined value selection with pickers (ColorPicker, DatePicker), validation for common formats plus custom rules, images in cells, cell comments, localization. Fill handle and undo/redo specifics are not documented on the pages checked.
- **framework:** This particular product is the **jQuery** flavour. The Kendo family ships parallel Angular, React and Vue suites, and Kendo UI for Angular documents its own Spreadsheet with built-in formulas — but they are separately licensed products, not one component with four wrappers.
- **dataModel:** Client-side workbook model. Notably, **import/export is processed server-side** for large files, and export targets PDF and Excel. No direct database integration for the Spreadsheet.
- **distinctive:** Async custom functions — `argsAsync` lets a formula resolve against a remote service without freezing the sheet, which pushes the calculation graph into genuinely asynchronous territory. Beyond that it is an aging component: still jQuery, IE9+ support in its compatibility matrix, and a documented "desktop only, limited on mobile" posture. The 463-function library is the real asset; the shell around it is the weakest of the commercial options here.

Sources: https://www.telerik.com/kendo-ui/spreadsheet, https://www.telerik.com/kendo-jquery-ui/documentation/controls/data-management/spreadsheet/end-user/list-of-formulas, https://www.telerik.com/kendo-jquery-ui/documentation/controls/spreadsheet/overview, https://docs.telerik.com/kendo-ui/controls/data-management/spreadsheet/custom-functions

### Syncfusion Spreadsheet {#grid:syncfusion-spreadsheet}

- **license:** Commercial, per-developer, annual, **minimum 5-developer purchase**. The Spreadsheet Editor SDK is $1,199/developer/year standalone; the full UI Component Suite (1,600+ components across frameworks) is also $1,199/developer/year. The differentiator is the **free Community License**, granting the entire Essential Studio line at no cost to organizations with under $1M annual revenue, ≤5 developers and ≤10 employees — with an explicit VC/PE carve-out requiring under $3M in external funding. That is the most generous free path of any commercial vendor in this batch, and also the most conditional.
- **rendering:** DOM-based client-side rendering. A canvas layer is not documented.
- **virtualization:** **Row and column virtualization** is documented as the mechanism for large datasets. No published row/column ceiling — not documented.
- **nesting:** Multiple sheets, sorting, filtering, grouping of rows/columns. Master-detail, tree data and grid-in-grid are not documented for the Spreadsheet; Syncfusion ships separate TreeGrid and PivotTable components.
- **charting:** Yes, built in — charts and images embed directly into cells within the Spreadsheet component itself, not as a bolt-on. Range-select-then-chart is not documented on the pages checked.
- **formula:** The weakest documented formula story of the three commercial options. **Roughly 100+ formulas listed** in the supported-formulas table (mathematical, statistical, text, date/time, lookup, logical) — the docs present a table rather than a headline count, so treat "100+" as a floor read off the list, not a vendor figure. Marketing claims "broad Excel formula parity", which the published list does not substantiate at Kendo's 463 or Jspreadsheet's 500+. Custom functions register via `addCustomFunction`. **Array/dynamic-array formulas: not documented** — no mention anywhere in the formula documentation. The engine is **not separable**: there is no standalone calculator package, and calculation behaviour is controlled from the component via a `calculationMode` property.
- **pivot:** Not documented as part of the Spreadsheet component; PivotTable is a separate control in Essential Studio.
- **editing:** Full editor as well as viewer — cell editing, formulas, formatting, data validation, conditional formatting, sorting, filtering, freeze panes, and Excel/CSV/PDF export.
- **framework:** The broadest coverage in the batch. `@syncfusion/ej2-spreadsheet` is the JS/TS core, with first-party wrappers for Angular, React, Vue, plus ASP.NET Core, ASP.NET MVC and Blazor — the same component with per-framework documentation sets, which is unusual (Kendo, by contrast, sells four separate suites).
- **dataModel:** Client-side with row/column virtualization; a documented open/save server pipeline handles Excel import/export server-side. No direct database integration documented.
- **distinctive:** Reach over depth. One component, one licence, genuinely rendered across six-plus framework and server stacks including .NET server-side rendering, backed by a community licence that makes it free for small teams — and the formula engine is the price paid for that breadth, at roughly a fifth of Kendo's documented function count with no array-formula support on record. If the requirement is "spreadsheet UI everywhere our stack goes", it wins; if the requirement is calculation fidelity, it does not.

Sources: https://www.syncfusion.com/javascript-ui-controls/js-spreadsheet, https://help.syncfusion.com/document-processing/excel/spreadsheet/javascript-es6/formulas, https://www.syncfusion.com/sales/teamlicense, https://www.npmjs.com/package/@syncfusion/ej2-spreadsheet

### Supabase Table Editor {#grid:supabase-table-editor}

- **license:** The product is a hosted dashboard (Supabase Studio) whose source lives in the `supabase/supabase` monorepo under **Apache-2.0**. The grid itself was originally published separately as `@supabase/react-data-grid` (a fork of the Comcast/adazzle `react-data-grid` lineage, **MIT**) and `supabase/grid`; both standalone repos are now archived (`supabase/grid` archived 2022-06-04, `supabase/react-data-grid` archived 2024-01-10) and the component was folded into the Studio app. So the grid is reusable, but only as an archived MIT fork or by vendoring from an Apache-2.0 monorepo — there is no supported standalone package.
- **rendering:** DOM. It descends from `react-data-grid`, whose README describes rendering React elements per cell with columns and rows outside the viewport not rendered.
- **virtualization:** Row + column. The upstream README states "columns and rows outside the viewport are not rendered." No documented row ceiling; the Table Editor pages data from Postgres, so the practical ceiling is the query, not the grid.
- **nesting:** Row grouping exists in the `react-data-grid` fork. Master-detail, tree data and grid-in-grid are **not documented** in the Table Editor docs or the grid README. What the Table Editor does instead is a foreign-key row peek — clicking a FK cell surfaces the referenced row.
- **charting:** not documented for the Table Editor (checked the tables guide). Charts in Supabase are a separate SQL-editor/Reports concern, not a grid feature.
- **formula:** No Excel-style formula engine. Computed values come from Postgres — generated columns, views, and SQL — not from a client-side formula language. This is the sharpest split from the Airtable class.
- **pivot:** not documented (checked the tables guide). Pivoting is done in SQL.
- **editing:** Inline cell editing that issues real `UPDATE`/`INSERT`/`DELETE` against Postgres, plus a side-panel row editor. The grid layer contributes cell copy/paste, drag-fill of cell values, keyboard navigation, multi-column sort, frozen columns, column resize and custom cell formatters. Validation is the database's — type and constraint errors surface from Postgres. Undo is **not documented**.
- **framework:** React only (Next.js app; the grid is a React component).
- **dataModel:** **Direct database integration — this is the whole product.** There is no client-side dataset; the grid is a view onto a live Postgres schema, reading through the Studio API against `information_schema`/`pg_catalog` and writing real SQL. Rows are fetched per page from the server.
- **distinctive:** **Yes — it alters schema from the UI, and that is the point.** Documented UI schema operations: create a table, add columns, and pick column data types, with the docs conceding "We only support a subset of these in the Table Editor in an effort to keep the experience focused for people with less experience with databases." Foreign keys are a first-class UI affordance — the Foreign Key Selector lets you visually pick the referenced table/column, and the docs describe managing all foreign keys for a table from the table side panel rather than column-by-column. RLS is enabled and policies are authored from **Database > Policies** in the dashboard, not from the grid itself. The moat is not the grid widget (it is an MIT `react-data-grid` fork anyone can take) — it is the schema-introspection and DDL-generation layer sitting behind it, plus the RLS-aware policy editor. Anything not covered by the subset falls through to the SQL Editor.

Sources: https://supabase.com/docs/guides/database/tables, https://supabase.com/features/foreign-key-selector, https://supabase.com/docs/guides/database/postgres/row-level-security, https://github.com/supabase/react-data-grid, https://github.com/supabase/grid

### NocoDB {#grid:nocodb}

- **license:** **The licence changed.** Versions through 0.300.x were **AGPL-3.0**; from **v0.301.0 (effective 2026-01-09)** NocoDB moved to a **Sustainable Use License (SUL)**, "fair-code", source-available and explicitly *not* OSI-approved. Free for individual developers, internal company use at any size, self-hosting internal tools, and education/research; a commercial licence is required if you "offer NocoDB as a hosted or managed service" or "provide direct NocoDB access to external customers." The `nocodb/nocodb:latest` image ships Community *and* Enterprise code in one binary, with Enterprise unlocked by `NC_LICENSE_KEY` (SQL Server and Oracle connectors are Enterprise add-ons).
- **rendering:** DOM (Vue/Nuxt frontend). Rendering technique is **not documented** on the product site.
- **virtualization:** not documented on the pages checked. Marketing claims scaling "to millions of rows"; no row ceiling is published.
- **nesting:** Record expand into a detail panel, and linked-record fields that surface related rows. Row grouping is documented as a grid feature. Master-detail as a nested grid inside a row, and grid-in-grid, are **not documented**.
- **charting:** not documented. Views offered are Grid, Kanban, Gallery, Form and Calendar — no chart view listed.
- **formula:** Yes, a proprietary formula field with **100+ functions** documented across numeric, string, date, array, conditional, JSON and generic categories, plus numeric/logical operators. It is a separate expression engine compiled down to the underlying SQL dialect, not a spreadsheet cell-reference model — formulas reference field names, not cell coordinates.
- **pivot:** not documented (checked the view list).
- **editing:** Spreadsheet-style cell editing that writes straight through to the connected database, multi-field editing, expanded-row form editing, bulk CSV/Excel import and export, webhooks on record change. Clipboard/Excel paste, fill handle and undo are **not documented** on the pages checked.
- **framework:** Not a component you embed in your app — it is a deployed application (Vue/Nuxt frontend, Node backend, Docker image). It exposes REST APIs and webhooks for programmatic access instead.
- **dataModel:** **Connects to an EXISTING database — it does not have to own the schema.** Supported external sources are PostgreSQL v14+, MySQL v5.7+, and (Enterprise) Microsoft SQL Server and Oracle. It reads the existing tables and presents them as spreadsheet views; a **Meta Sync** mechanism detects schema drift made outside NocoDB, marks changed tables in red, and applies it on "Sync now." It can also run in owned-schema mode against its own bundled database.
- **distinctive:** **Yes, it can alter schema — but it is off by default and the vendor warns you off it.** Connecting an external source has an explicit **schema editing** permission: when enabled, users can "create, modify, and delete tables, fields and relationships (links) within the connected datasource from NocoDB UI"; the docs "strongly advise against enabling the schema editing option unless absolutely necessary," and the default is **disabled**. The genuinely interesting design point for a table-editor team is the fallback: with schema editing off, users can still add **virtual columns** — Lookup, Rollup, Formula — which live in NocoDB's own metadata store and never touch the customer's DDL. That is a clean answer to "give me Airtable features over a database I am not allowed to migrate," and it is the architectural trick worth copying.

Sources: https://nocodb.com/, https://nocodb.com/docs/self-hosting/license, https://github.com/nocodb/nocodb/discussions/12891, https://nocodb.com/docs/product-docs/data-sources, https://nocodb.com/docs/product-docs/data-sources/sync-with-data-source, https://nocodb.com/docs/product-docs/fields/field-types/formula/formula

### Baserow {#grid:baserow}

- **license:** Open-core with a clean directory split. The Open Source Edition is **MIT (Expat)**; code under the `premium/` and `enterprise/` directories carries separate proprietary licences. Self-hosted paid tiers are **Premium**, **Advanced** and **Enterprise** (Enterprise is self-hosted-only, custom priced). Free/MIT gates you to Grid, Gallery and Form views and CSV export. **Premium** (EUR 5/user/mo cloud) adds Kanban, Calendar, Timeline and personal views, JSON/Excel/XML export, row comments, row coloring, AI field and AI formula generator. **Advanced** (EUR 20/user/mo) adds RBAC, field-level permissions, SSO, audit logging, applications, data sync and white-labelling. The self-hosted MIT edition has **no row, storage or user limits** — those caps are cloud-plan limits, not code limits. This is the decision-relevant line: the *grid* is MIT, the *view types* are the paywall.
- **rendering:** DOM, Vue 2 + Nuxt.js frontend against a Python/Django REST backend.
- **virtualization:** Row (and horizontal buffering). The frontend implements virtual scrolling with a buffered-rows pattern and lazy row loading via the Vuex store. No documented row ceiling for self-hosted; cloud ceilings are plan-based.
- **nesting:** Row grouping and linked-row fields (link to table) with record expand into a row modal. Master-detail as an embedded grid, tree data, and grid-in-grid are **not documented**.
- **charting:** not documented as a view type (views listed are Grid, Gallery, Form, Kanban, Calendar, Timeline).
- **formula:** Yes — a formula field with mathematical, logical, text and date/time functions, documented in a dedicated reference guide plus a repo tutorial. An exact function count is **not documented** on the pages checked. It is a separate expression engine that Baserow compiles into Postgres expressions, not a cell-reference spreadsheet engine. An AI formula generator exists but is Premium.
- **pivot:** not documented (checked the pricing/plans view list).
- **editing:** Grid cell editing with optimistic updates and real-time multi-user collaboration over WebSockets (Django Channels). Row create/delete, row comments (Premium), row coloring (Premium), CSV/JSON/Excel/XML export. Clipboard/Excel paste, fill handle and undo are **not documented** on the user-docs pages checked.
- **framework:** Not an embeddable component — a self-hostable Django + Nuxt application with a REST API. Plugin architecture is modular (Database, Builder, Automation application types).
- **dataModel:** Server-side. Baserow **owns its schema**: it is a Django app over its own Postgres, and it does not present an existing customer database as tables the way NocoDB does. Rows load lazily from the REST API into a buffered store. Cross-source ingestion is via **data sync** (an Advanced feature) rather than a live external connection.
- **distinctive:** **Schema editing yes — but only of Baserow's own tables, never of a foreign database.** Users create tables, add fields, and change field types from the UI, because Baserow is the system of record. Contrast with Supabase and NocoDB: those two point at a database the user already owns; Baserow makes you migrate into it. The distinctive engineering fact is the open-core boundary being **directory-level and licence-checked at runtime** rather than a separate build — the whole codebase ships and a licence key lights up `premium/`+`enterprise/`. For a team building an MIT grid, Baserow is the closest precedent that MIT-licensing the core grid while charging for view types and governance (RBAC, SSO, audit) is a viable line.

Sources: https://github.com/baserow/baserow, https://baserow.io/user-docs/pricing-plans, https://baserow.io/user-docs/self-hosted-licenses, https://baserow.io/blog/under-the-hood-of-baserow, https://baserow.io/user-docs/understanding-formulas

### Teable {#grid:teable}

- **license:** Open-core. Community Edition is **AGPL-3.0** for the main codebase, with everything under `packages/` **MIT**. GitHub reports the repo licence as `NOASSERTION` because of that mixed layout. The published Docker image ships the full product; **AI features and enterprise capabilities activate with a licence key** — no image swap, no migration. A separate `teableio/teable-enterprise` repo exists for EE issue tracking. Repo is active (21.7k stars, pushed 2026-09-04).
- **rendering:** not documented explicitly in the README or on the marketing site. The README claims "1 million rows demo" performance and "automatic database indexing for maximum speed" but does not state the client rendering technique. Do not assume canvas without checking the source.
- **virtualization:** not documented as a named feature (checked the README). Documented scale claims are "millions of data" with filtering and sorting and a published 1-million-row demo.
- **nesting:** Grouping and column freezing are documented; link fields relate records across tables. Master-detail, tree data and grid-in-grid are **not documented**.
- **charting:** Listed as **upcoming**, not shipped, in the README's roadmap section (alongside conditional formatting, data validation, undo/redo, comments, find/replace). Per the survey's rules this is not a present capability.
- **formula:** Yes — a formula field alongside aggregation functions, grouping and data formatting. An exact documented function count is **not documented** in the README. Notably it is *also* backed by real SQL, since the data lives in Postgres columns.
- **pivot:** not documented (checked the README feature list).
- **editing:** Cell editing, batch data operations, import/export, real-time collaboration, filtering/sorting/grouping/aggregation, column freezing. **Undo/redo, data validation, conditional formatting and find/replace are listed as upcoming, i.e. not shipped.** Clipboard/Excel paste and fill handle are **not documented**.
- **framework:** Deployed application (Docker, Railway, Zeabur, Sealos), not an embeddable grid component. Access is via REST API and direct SQL.
- **dataModel:** **This is the interesting bit and it holds up.** Teable is described as a "Postgres-Airtable Fusion," "built on Postgres," "spreadsheet-simple on the surface, real PostgreSQL underneath." Critically it advertises **full-featured SQL support** — you query the data with native SQL and point BI tools (Metabase, PowerBI) and no-code tools (Appsmith) straight at the database. That means user tables are real Postgres tables, not rows in an EAV blob, which is precisely what Airtable-class products give up. **"Bring your own database" is listed on the roadmap as not yet shipped**, so as of the README it owns its own Postgres rather than adopting your existing schema; multi-database support (SQLite, MySQL, MariaDB, TiDB) carries the same unshipped status.
- **distinctive:** **Yes — schema editing from the UI, and every schema change is a real Postgres DDL change.** Adding a field adds a column; "field conversion" (changing a field's type) is documented as a first-class feature. The moat is the two-way contract: an Airtable-grade UI where a DBA can simultaneously attach a psql session or a BI tool and see ordinary relational tables with real indexes. Every other Airtable clone in this batch either owns an opaque schema (Baserow) or refuses to touch DDL by default (NocoDB). The corresponding trap for anyone copying it: type conversion in the UI means generating and running `ALTER TABLE ... TYPE ... USING`, with all the failure modes that implies.

Sources: https://raw.githubusercontent.com/teableio/teable/main/README.md, https://github.com/teableio/teable, https://teable.ai/, https://github.com/teableio/teable-enterprise

### Rowy {#grid:rowy}

- **license:** **Apache-2.0** (LICENSE file, © Rowy Inc. 2022, standard text with no custom clauses). GitHub's API reports `NOASSERTION`, but the file itself is unmodified Apache-2.0. Single tier — no premium/enterprise split in the repo. A hosted Rowy cloud offering exists alongside the self-hosted build.
- **rendering:** DOM (React/TypeScript). Rendering technique is **not documented** in the README.
- **virtualization:** not documented in the README. No row ceiling published; the practical ceiling is Firestore query paging.
- **nesting:** Firestore sub-collections are navigable, and a **Reference** field type points at other documents. Master-detail, row grouping, tree data and grid-in-grid are **not documented**.
- **charting:** not documented (checked the README feature list).
- **formula:** No spreadsheet formula language. The equivalent is **derivative/computed fields written in JavaScript/TypeScript**, and field-level cloud-function workflows that run on data change and can use any NPM module or API. That is a materially different model from Airtable formulas — it is code, not an expression DSL.
- **pivot:** not documented (checked the README).
- **editing:** Full CRUD in a spreadsheet UI over Firestore, **30+ field types** (text variants, date pickers, selectors, file uploaders, and rich JSON/Code/Markdown/HTML editors), column operations (lock, freeze, resize, hide, rename), sort and filter by row values, multiple filters, bulk delete, and bulk CSV/JSON/TSV import and export. Clipboard/Excel paste, fill handle and undo are **not documented**.
- **framework:** React application, self-hosted to your own Google Cloud project (Cloud Run), not an embeddable grid component.
- **dataModel:** **Direct Firestore integration.** The grid is a live view onto your own Firestore collections — "your data and cloud functions stay on your own Firestore/GCP." This is the NoSQL member of the category: there is no fixed schema in the database at all, so Rowy's "schema" is metadata Rowy stores about how to render and validate each field.
- **distinctive:** **It edits schema only in the sense that a schemaless store allows — it defines and edits the *column configuration*, not database DDL, because Firestore has no DDL.** Adding a column adds a field definition to Rowy's own settings and a key to subsequently written documents; there is no type-alter or foreign-key concept to expose, and referential integrity is a `Reference` field, not a constraint. **Maintenance status, honestly: this looks stalled.** The last release is **v3.0.0 on 2023-10-27**; the last push to the default branch was **2024-11-23**; 79 open issues; and the repository has been transferred from `rowyio/rowy` to **`buildship-ai/rowy`**, while the team's public energy has moved to BuildShip. The repo is **not** formally archived and there is no explicit unmaintained notice, but roughly two years without a release is the finding. Treat Rowy as a reference design, not a live competitor. Its one genuinely transferable idea is putting a code editor in the column config so a cell's value can be derived by a deployed cloud function.

Sources: https://github.com/rowyio/rowy, https://github.com/buildship-ai/rowy, https://github.com/buildship-ai/rowy/releases, https://raw.githubusercontent.com/buildship-ai/rowy/main/LICENSE, https://www.rowy.io/

### Airtable {#grid:airtable}

- **license:** Proprietary, closed-source SaaS. No self-hosting, no source, no embeddable grid component. Tiering is by plan (Free / Team / Business / Enterprise Scale): Timeline, Gantt and Form views require paid plans, as do personal views, locked views, favourite views and custom view sections; pivot tables in Interfaces require Teams plan or higher. There is a public REST API and an Extensions/Blocks SDK, but the grid itself is not licensable.
- **rendering:** not documented publicly. The only public engineering statement found is a 2016 post noting Airtable "kept around some Grid View components that were highly optimized for rendering performance and unlikely to work as performantly in React" — i.e. the grid was deliberately excluded from their React migration for performance reasons, which tells you it is a bespoke rendering path but not which one. Do not state canvas as fact.
- **virtualization:** not documented publicly (checked the views guide). Row ceilings are published as plan limits (records per base) rather than as a grid rendering limit.
- **nesting:** Record expand opens a full record detail modal; **linked records** relate rows across tables and render as chips inside a cell that expand to the referenced record. Row grouping is supported in grid views (with collapsible groups and per-group summaries). A grid nested inside another grid is **not documented**; the closest thing is the linked-record cell expanding into a list.
- **charting:** Not in the grid. Charts are delivered through **Extensions** (formerly Apps) and through Interface Designer elements — a separate surface from the grid view, not a select-a-range-and-chart affordance.
- **formula:** Yes — a mature formula field. Formulas are **field-scoped expressions referencing other field names in the same record**, not A1-style cell references, which is the fundamental difference from Excel/Google Sheets. An exact documented function count is **not documented** on the field-types overview page checked.
- **pivot:** Yes, in two places, both outside the grid view: the **Pivot table Extension** in the Airtable Marketplace, and native pivot tables inside **Interfaces** for Teams plan and above. Client-side/server-side split is **not documented**.
- **editing:** Cell editing per field type with type-enforced editors, record expand editing, row height (short/medium/tall/extra tall), field hide/show, record coloring, filtering, sorting, grouping, CSV export, and forms for external data entry. Clipboard paste from Excel, fill handle and undo behaviour are **not documented** on the pages checked.
- **framework:** None — it is a hosted product. Integration is via REST API, the Extensions SDK (React, running inside Airtable's own shell), Interfaces, and automations.
- **dataModel:** Airtable **owns the data entirely.** There is no connection to a customer database — a "base" is Airtable's own store, reached only through the API. This is the opposite pole from Supabase/NocoDB/Teable. Sync features pull external data *into* a base rather than presenting a live foreign schema.
- **distinctive:** **Yes, it alters its own schema from the grid — adding a field, changing a field type and creating a linked-record relationship are all one-click operations — but there is no underlying user-visible database, so this is schema editing without DDL.** The real finding for a developer-grid team is **what its field system does that a developer grid does not**: 31 documented field types where the *type is the behaviour*, not just a renderer. Linked record stores a live reference to rows in another table (not a copy, so it stays correct when the target changes); **Lookup** pulls a chosen field's values across that link without duplicating them; **Rollup** runs an aggregate formula (sum, max, …) over the linked rows; **Count** returns the number of linked rows; plus Attachment, Button, Barcode, Rating, Duration, Currency, Percent, Autonumber, and five audit-trail types (Created time, Created by, Last modified time, Last modified by, User). A developer grid gives you a cell renderer and an editor; Airtable gives you a **relational field-type system with derived-value propagation**, and that propagation graph — recomputing lookups and rollups across links on every edit, live, for all collaborators — is the part that is genuinely hard to replicate. The second moat is views: seven view types over the same table, each with its own saved filter/sort/group/hidden-field state, shared or personal or locked. Views-as-saved-configuration, not views-as-separate-data, is a cheap and very copyable idea.

Sources: https://support.airtable.com/docs/supported-field-types-in-airtable-overview, https://support.airtable.com/docs/getting-started-with-airtable-views, https://support.airtable.com/articles/8927322518-lookup-field-overview, https://support.airtable.com/articles/7497685062-rollup-field-overview, https://support.airtable.com/docs/pivot-table-extension, https://medium.com/@matt_bush/how-airtable-uses-react-5e37066a87d4

### Retool Table {#grid:retool-table}

- **license:** Proprietary, closed-source, and **only usable inside Retool**. It is one component in Retool's app builder, not a distributable package — there is no npm module and no source. Retool is priced per user with Free / Team / Business / Enterprise plans; apps can be shown to **external users** on Business and Enterprise (50 external users/month free on Business cloud, then roughly $8/$6/$4 per user at the 51–250 / 251–500 / 500+ tiers). The current component is documented as "Table," with the prior generation still available as "Table (legacy)."
- **rendering:** not documented. The changelog states the rebuilt Table can "render, updating, and scrolling through hundreds of thousands of rows and hundreds of columns with diverse data types fast" but does not name the rendering or scrolling technology, and does not name an underlying third-party grid library.
- **virtualization:** not documented as such (checked the rows guide). The published capability is "hundreds of thousands of rows and hundreds of columns," plus explicit **client-side or server-side pagination** — server-side pagination is the documented answer to large datasets, which implies paging rather than pure client virtualization.
- **nesting:** **Expandable rows** that can contain arbitrary other Retool components, with `currentRow` and `currentSourceRow` in scope — so a row can literally expand into another Table, which is Retool's answer to master-detail. **Row grouping** by column value produces collapsible sections. Tree data is **not documented**.
- **charting:** Not part of the Table. Retool has a separate Chart component; select-a-range-and-chart from the grid is **not documented**.
- **formula:** No Excel-style formula engine. The equivalent is **JavaScript expressions in `{{ }}` bindings** anywhere in the component's configuration (cell values, formatting, visibility, event handlers). Column-level **summarization with different aggregation methods** exists as a footer feature, which is the nearest thing to a formula.
- **pivot:** not documented for the Table component (checked the component docs and the Rows guide).
- **editing:** Inline cell editing on columns marked editable. **The editing model is the notable part and it is explicitly not automatic:** edits accumulate in a `changesetArray` on the component and are *not* written anywhere until you author a query — the docs tell you to "write a query that references `newRows` and saves them to the existing data source," recommending a bulk upsert. Added rows land in a `newRows` property via an Add Row toolbar button. A built-in delete-rows feature is **not documented**. Column formats include tags (with dropdown/multiselect), checkboxes, and action buttons; there are column-level event handlers, toolbar actions, cell captions, header tooltips, and keyboard shortcuts. Filtering (including nested filters), multi-column sorting, search, and a primary-key setting that preserves row selection across operations. Validation and undo are **not documented**.
- **framework:** React internally, but **there is no framework story for consumers** — you cannot install it. The only way to put this table on a page you own is to embed an entire Retool app via iframe/SSO or a single-use secure link.
- **dataModel:** Both, and decoupled from any one database. The Table binds to a **query result** from any Retool resource (Postgres, MySQL, REST, GraphQL, Snowflake, …). Filtering, sorting and pagination each toggle between client-side and server-side, so server-side mode hands the grid a page at a time and pushes the work to the resource. There is no direct database ownership — Retool is a client, and the write path is a query you write.
- **distinctive:** **No — it does not alter schema. It only edits rows, and even then only into a changeset you must explicitly persist.** There is no add-column, no type change, no foreign-key creation; the columns are whatever your query returned. That is the cleanest contrast in this batch: Supabase, Teable and NocoDB (with the flag on) generate DDL, Airtable and Baserow edit their own schema, and Retool deliberately does neither — it is a presentation-and-mutation surface over somebody else's query. Its actual distinctive feature is **expandable rows containing arbitrary components**, which makes the row a composition slot rather than a fixed detail template, combined with the explicit changeset/`newRows` staging model that makes "what gets written and when" the developer's decision rather than the grid's. For a team building an embeddable MIT grid, the strategic note is that Retool's table is very good and completely unavailable outside Retool — which is exactly the gap an embeddable grid fills.

Sources: https://docs.retool.com/apps/web/guides/components/table, https://docs.retool.com/apps/guides/data/table/rows, https://docs.retool.com/changelog/weve-supercharged-the-table-component-agHVavZn, https://docs.retool.com/org-users/concepts/external-users, https://retool.com/pricing

### Directus {#grid:directus}

- **license:** Source-available, not OSI-open. Originally GPLv3, relicensed to **BSL 1.1** (2023) with a usage grant, then relicensed again at **v12 (May 2026)** to the **Monospace Sustainable Core License (MSCL)**, derived from the Fair Core License. Each released version auto-converts to **GPLv3 after 4 years**. Free use is granted by a separate "Open Innovation Grant" for organisations under **$5M annual revenue AND under 50 employees**; above that, self-hosting is restricted to the free **Core** tier (3 seats, 25 collections, 5 flows) or a paid **Team** ($499/mo annual) / **Enterprise** plan. Directus Cloud is a $99/mo add-on. The tier gates SSO, collection count and seats — not the grid itself.
- **rendering:** DOM. The Data Studio is a Vue single-page app (Vue.js from the ground up, per the vendor's own framing); the table layout is a standard HTML table rendered by Vue components.
- **virtualization:** not documented. The table layout is paginated server-side through the Items API (filter/sort/limit/offset), so the browser holds one page rather than the full set; no documented row ceiling for the layout itself.
- **nesting:** Relational fields (M2O / O2M / M2M / M2A) render as related-item interfaces and drill into a separate item detail page, not an in-grid expansion. No documented master-detail row expansion, tree-data mode, or grid-inside-a-grid in the stock table layout.
- **charting:** Insights dashboards provide chart panels (time series, bar, pie, metric, etc.) as a separate module. There is no select-a-range-and-chart-it gesture in the table layout.
- **formula:** No Excel-style formula language. Computation is done with Flows (its automation engine) and database-level defaults; not a spreadsheet engine.
- **pivot:** not documented for the table layout.
- **editing:** The stock table layout is a **navigation surface, not an editable grid** — clicking a row opens a full item form; batch edit applies one change set to selected rows. Inline cell editing is supplied only by community extensions (`directus-extension-editable-layout`, `directus-super-table`), which is itself the finding. No documented fill handle, Excel paste, or undo stack.
- **framework:** Vue 3 for the Studio; the product is consumed as a deployed application plus REST/GraphQL APIs, with SDKs for JS/TS. It is not distributed as an embeddable grid component.
- **dataModel:** **This is the point of the product.** Directus connects to an existing SQL database (Postgres, MySQL, MSSQL, SQLite, OracleDB, CockroachDB and others), introspects the existing tables, columns and foreign keys, and layers a REST + GraphQL API and admin UI on top without owning or migrating the schema. A "collection" is literally a SQL table and a "field" a column. Directus-specific presentation metadata lives in side tables.
- **distinctive:** Database-first, not app-first: point it at a legacy production schema and you get an API and an admin grid over the actual tables, with no proprietary storage layer — and if you drop Directus, your data is still just your database. The trade is the licence: it has now been relicensed twice away from open source, and the current MSCL gate is revenue-and-headcount based, which makes it unusable as a dependency for a permissively licensed project.

Sources: https://directus.com/pricing, https://directus.com/resources/directus-v12-license-change, https://directus.io/blog/why-we-are-relicensing-directus, https://directus.com/features/existing-database, https://docs.directus.io/user-guide/content-module/layouts.html, https://github.com/directus/directus

### Appsmith Table {#grid:appsmith-table}

- **license:** The Appsmith platform is **Apache 2.0** — genuinely permissive, and apps built with it can be sold. Commercial gating is by hosted plan rather than by grid feature: Free ($0), Business ($15/user/mo), Enterprise (custom). The Table widget's documented capabilities are not gated per tier in the widget reference.
- **rendering:** DOM. Appsmith's client is React and the widget is a React component tree (the widget reference documents `TableWidgetV2` properties and JS bindings); the docs page itself does not state the rendering technology.
- **virtualization:** Row virtualization exists — the vendor describes "virtual row" handling so large row counts scroll without a performance cliff, and infinite scroll dynamically appends records when server-side pagination is on. No documented row ceiling.
- **nesting:** not documented in the Table widget reference — no master-detail, tree data, row grouping, or nested-grid section. The idiomatic pattern is a second widget bound to `selectedRow`, which is a page-layout answer rather than a grid answer.
- **charting:** No integrated charting in the Table widget. Appsmith has a separate Chart widget you bind to the same query; there is no select-a-range-and-chart gesture.
- **formula:** No Excel formula engine. Cell values are computed with **JavaScript bindings** in `{{ }}` mustache expressions (e.g. `{{currentRow.price * 1.2}}`), a general scripting model rather than a named-function spreadsheet library.
- **pivot:** not documented.
- **editing:** Inline editing is a first-class documented feature: double-click a cell to edit, column-level editability, **single-row or multi-row save modes** with explicit Save/Discard, validation rules per editable column, default values for new rows, and an add-new-row flow. Clipboard/Excel paste, fill handle and an undo stack are **not documented**.
- **framework:** None in the component sense — this is a widget inside the Appsmith low-code builder, not an npm package you import. You get it by building an Appsmith app (self-hosted via Docker/K8s or cloud), not by adding a dependency to your own React project.
- **dataModel:** Server-side by design. The widget binds to an Appsmith query against one of 25+ datasources (Postgres, MySQL, MongoDB, REST APIs and others), with documented **server-side pagination** in both offset and cursor form, server-side search, and server-side sort — Appsmith will even generate the paginating query for you. Client-side search/sort is the alternative for small sets.
- **distinctive:** The datasource-aware wiring: the builder introspects your connected database and writes the paginated/searchable query for the table, so server-side paging is a toggle rather than an integration task. Against a competing developer grid it is not really a competitor — you cannot embed it — but the "table widget knows about the query behind it" model is the idea worth stealing.

Sources: https://docs.appsmith.com/reference/widgets/table, https://github.com/appsmithorg/appsmith, https://github.com/appsmithorg/appsmith/blob/release/LICENSE, https://www.appsmith.com/pricing

### Budibase Table {#grid:budibase-table}

- **license:** Split. The Budibase builder/server is **GPLv3**; the **client and component libraries are MPL**, deliberately so that apps you build carry no copyleft obligation. Self-hosted open source is free with unlimited apps/users/actions; cloud plans run Pro $19/mo → Premium $49/mo → Business $299/mo → Enterprise. Gating is on actions, log retention, workspaces, creator seats, custom branding, SSO, backups and audit logs — not on table features.
- **rendering:** DOM. Budibase's builder and client library are **Svelte** applications; the table/grid is a Svelte component. (Budibase also publishes `svelte-ag-grid`, a wrapper around AG Grid, but that is a separate repository, not the documented Table component.)
- **virtualization:** not documented on the Table component page. Configurable row height and a fixed-height component are documented; no stated row ceiling or virtualization mechanism.
- **nesting:** No master-detail or tree data in the Table component. Relationship columns display a related row's designated **display column**, and drilling deeper is done by binding another component to `Selected Rows`. Grid-in-grid: not documented.
- **charting:** No charting in the Table component; Budibase has separate chart components. Conditional formatting is the only in-cell visual encoding documented.
- **formula:** No Excel formula language. Budibase DB has a **Formula column type** with two modes — **Dynamic** (recomputed on every read) and **Static** (computed on write and persisted, which is what makes it filterable). Expressions are handlebars/JS bindings, not a named-function library.
- **pivot:** not documented.
- **editing:** The Table component is pitched as "the quickest, most direct way to provide a CRUD interface" — add/edit/delete are toggleable per table. Column visibility, labels and drag-reorder are configurable and end users can further adjust them for their session. Row striping, a quiet style, row selection with a `Selected Rows` binding for bulk operations, and conditional formatting evaluated top-to-bottom are documented. Clipboard/Excel paste, fill handle, undo and validation are **not documented** on this page.
- **framework:** None as a component. It is a drag-and-drop component inside the Budibase builder; you deploy Budibase (Docker, K8s, cloud), you do not `npm install` this grid.
- **dataModel:** Bound to a Budibase datasource — either the internal **Budibase DB** or an external connection (PostgreSQL, MySQL, MariaDB, MSSQL, MongoDB, REST, and others). In the component hierarchy the Grid does not fetch data itself; a **Data Provider** component owns fetching and the grid renders what it is handed. Paging mode and behaviour are not documented on the Table page.
- **distinctive:** The MPL-licensed client library is the interesting bit — Budibase deliberately kept the runtime components under a weaker copyleft than the GPLv3 builder so that generated apps are redistributable. Product-wise the Table is a competent CRUD grid with a real formula-column concept (static vs dynamic evaluation), but it is a component in a builder, not an embeddable grid.

Sources: https://docs.budibase.com/docs/table, https://docs.budibase.com/docs/formula, https://docs.budibase.com/docs/budibasedb, https://github.com/budibase/budibase, https://budibase.com/pricing/

### Metabase {#grid:metabase}

- **license:** Dual, in one repository. The Open Source Edition is **AGPLv3**; the Pro/Enterprise editions live in the same repo under the **Metabase Commercial Software License**. The AGPL network clause is the real constraint — embedding Metabase in a customer-facing SaaS pushes you to a commercial licence. **Editable tables (write-back) is Pro/Enterprise only**, self-hosted or cloud. That is the tier line that matters here.
- **rendering:** DOM. Metabase's frontend is a React application and the table visualisation is rendered as DOM elements; the docs do not state canvas or WebGL anywhere.
- **virtualization:** not documented as such. What *is* documented is a hard product ceiling rather than a rendering one: the UI caps a table or chart at **2,000 rows for raw results** (10,000 for aggregated), and anything larger must be downloaded as CSV/Excel. So the question of virtualising a million rows never arises — Metabase refuses to display them.
- **nesting:** No master-detail rows and no tree data. Clicking an entity-key cell opens a **detail view** of that record on its own; grouping is expressed by re-running the query with a summarise/breakout, not by expandable grid rows. No nested grids.
- **charting:** Charting is the whole product, but it lives beside the table, not inside it: a question renders *as* a table or *as* a chart and you toggle the visualisation. Inside the table the only chart-like element is the **mini bar chart** column formatting for numeric columns. There is no select-a-range-and-chart gesture — the equivalent is drill-through, where clicking a cell pivots you into a new question.
- **formula:** No Excel formula grammar, but a real expression language: **custom columns / custom expressions** in the query builder, with documented function families (string, math, date, conditional, aggregation). It is a query-builder expression engine that compiles to SQL, not a client-side spreadsheet engine — expressions execute in the database.
- **pivot:** Yes, and it is a distinct visualisation type. Fields are assigned to three buckets — **rows, columns, measures** — with nesting when multiple fields go in one bucket, and collapsible subtotals. Computed **server-side** (Metabase rewrites the query to produce subtotals), which is exactly why the docs state you **cannot pivot a native SQL question** — it has no safe way to modify your SQL. The plain table visualisation also auto-pivots the simple case of one numeric plus two grouping columns.
- **editing:** Historically read-only; write-back now exists in two forms. **Editable tables** (Pro/Enterprise, **PostgreSQL and MySQL only**, admin-enabled per database, requires write privileges on the connection) allow spreadsheet-style in-place edits, `+ New record` inserts, and multi-row deletes, with type constraints enforced and dropdowns for constrained columns; **sequential primary keys cannot be edited** and deletes fail against referential integrity. **Actions** are the other route — custom parameterised forms/queries, which is how you give non-admins write access, since direct table editing is admin-only. No documented fill handle, Excel paste, or undo.
- **framework:** Not an embeddable grid component. Metabase is a deployed JVM application (Clojure backend, React frontend) that you embed at the *iframe/SDK* level — static embedding, interactive embedding, or the Embedded Analytics SDK for React. You cannot take its table and drop it in your app as a library.
- **dataModel:** Server-side, always. Every table is the result of a query against a connected warehouse or OLTP database (Postgres, MySQL, BigQuery, Snowflake, Redshift, Mongo and many more); Metabase stores only metadata and caches in its application database. The 2,000-row display cap plus dashboard-card pagination is the row model.
- **distinctive:** The drill-through model — a table cell is not an endpoint but a query fragment, so clicking a value re-derives a *new* question (filtered, or broken out, or zoomed to the record) rather than expanding a row. Combined with the semantic layer (admin-curated field metadata, display names, hidden columns), it means the grid's behaviour is driven by data-model metadata rather than by per-column config in code. The newer editable-tables feature is the notable inversion: a BI tool that writes back, but only on Postgres/MySQL, only for admins, and only if you pay.

Sources: https://www.metabase.com/docs/latest/data-modeling/editable-tables, https://www.metabase.com/docs/latest/questions/visualizations/table, https://www.metabase.com/docs/latest/questions/visualizations/pivot-table, https://www.metabase.com/license, https://github.com/metabase/metabase

### DBeaver data editor {#grid:dbeaver}

- **license:** Genuine two-product split. **DBeaver Community Edition is Apache 2.0** — free for any purpose including commercial use, and the fullest free desktop SQL client in this batch. **DBeaver PRO** is proprietary and tiered: **Lite** (~$113/yr) adds the visual query builder with limited development tools; **Enterprise** (~$255/yr) adds development tools, DBA tools/dashboards and Git integration; **Ultimate** (~$510/yr) adds Cloud Explorer and AWS/GCP/Azure support; **CloudBeaver / Team Edition** ($1,025–$1,630/yr) is the web/collaborative product. PRO also gates NoSQL and cloud drivers, credential encryption with a master password, and enterprise auth (SAML, SSO, Okta, Kerberos), plus AI query explanation. The core results grid — inline edit, virtual keys, FK navigation — is in Community.
- **rendering:** **Not a web component at all.** DBeaver is a Java desktop application built on the Eclipse RCP platform, and the results grid is an SWT-based native widget. DOM/canvas/WebGL does not apply. (The sibling product CloudBeaver is the browser-based one.)
- **virtualization:** Not virtualization in the web sense — it is **JDBC cursor paging**, which is the more interesting answer. The grid holds one fetched segment at a time; **default 200 rows**, configurable in the toolbar and preferences, with a separate "Maximum result-set size" cap. Scrolling to the last row **auto-fetches the next N rows** (disableable), and there are explicit **Fetch next page** and **Fetch all rows** commands. On a million-row table it therefore streams by default and only materialises everything if you ask — and the docs warn plainly that "Fetch all rows" on a huge set "might cause program hangup or out-of-memory errors". Row count is a separate on-demand `COUNT` action, not something the grid knows for free.
- **nesting:** No master-detail row expansion. Nesting is expressed by **navigation instead of hierarchy**: complex/struct and array column values open in a nested value viewer/editor panel, and FK navigation opens a *new* result tab rather than expanding in place.
- **charting:** Not in the results grid in Community. Grouping and value-frequency panels exist alongside the grid; **dashboards are a PRO (Enterprise and above) feature**. No select-a-range-and-chart in the grid.
- **formula:** No Excel formula engine — this is a SQL client, and the expression language is SQL. Grid-level expression evaluation is **not documented**.
- **pivot:** The grid offers alternative presentations of a result set (grid / text / grouping panel), and PRO adds richer analysis surfaces; a spreadsheet-style pivot builder in the results grid is **not documented** in the Community docs.
- **editing:** Strongest editing story of the three desktop clients. Inline cell editing in the grid with an editing transaction you explicitly **Save** (and the generated `UPDATE`/`INSERT`/`DELETE` can be previewed as **Generate SQL** before it runs), plus row insert/duplicate/delete, multi-cell paste, and value editors per type (JSON, XML, binary, image, spatial). **No primary key is the interesting case:** DBeaver does not simply go read-only — when you edit a result set with no PK or unique index it offers to define a **virtual key**, either "use all columns" (with an explicit warning that this can update multiple rows if the combination is not actually unique) or a **Custom Unique Key** over columns you pick. Virtual keys live in DBeaver's own metadata, never in the database, so this works even on engines that have no such constraint concept.
- **framework:** Java / Eclipse RCP / SWT desktop application for Windows, macOS and Linux. **It is not embeddable in a web application** and exposes no component API — extensibility is via Eclipse plugins.
- **dataModel:** Live JDBC connections to 100+ engines. There is no client-side row model to speak of: the grid is a window onto a server-side cursor, with fetch size, max result-set size and transaction mode (auto-commit vs manual) as the tuning knobs. Foreign-key navigation is driven by introspected schema metadata.
- **distinctive:** **Virtual keys** — the deliberate decision that a result set without a primary key should still be editable, by letting the user assert a uniqueness contract the database never declared, with an honest warning about the blast radius. Every other client in this batch answers "no PK" with "read-only". Paired with bidirectional FK navigation (`Navigate → Referenced tables` from a cell, and a command to find dependents), it makes the grid a graph browser over the schema rather than a table viewer.

Sources: https://dbeaver.com/docs/dbeaver/Navigation/, https://dbeaver.com/docs/dbeaver/Virtual-Keys/, https://dbeaver.com/edition/, https://dbeaver.io/about/, https://github.com/dbeaver/dbeaver/wiki/Virtual-Keys/Ultimate-Edition

### TablePlus {#grid:tableplus}

- **license:** **Proprietary, closed source.** The public GitHub repository is an issue tracker, not source. Sold as a **perpetual licence including one year of updates** — after that year you either renew to keep updating or keep running the last build you were entitled to, indefinitely, with no feature loss. There is also a **free tier with no time limit** but hard concurrency caps: **2 open tabs, 2 open windows, 2 advanced filters** (advanced filters are absent entirely from the free Windows build). Licences are per-user across devices with separate macOS/Windows/Linux scoping.
- **rendering:** **Not a web component.** TablePlus is a genuinely native desktop application — Swift and Objective-C plus C/C++ and Perl on macOS, **C# on Windows**, and Go on the server side. The grid is an OS-native table view, which is precisely why it feels faster than the Electron clients; "modern native designs that match your beloved OS" is the explicit positioning. DOM/canvas/WebGL is not applicable.
- **virtualization:** not documented. The vendor markets high performance and native rendering rather than publishing a fetch-size or paging model, and the documentation does not state a row ceiling, a page size, or whether a large result set is streamed or fetched whole. This is a real documentation gap, not a feature absence — the product clearly handles large tables, but the mechanism is undocumented.
- **nesting:** No master-detail or tree-data rows. Hierarchy is handled by **opening more surfaces**: multi-tab and multi-window, and split panes (results split horizontally, or results split into tabs). Foreign-key relationships are traversed by clicking the arrow icon on the foreign-key section of a row, which opens the referenced data rather than expanding it inline.
- **charting:** No charting in the data grid. A "metrics dashboard for internal reporting" is marketed separately; the grid itself is not a charting surface and there is no select-a-range-and-chart gesture.
- **formula:** No Excel formula support; the expression language is SQL. **not documented** as a grid feature.
- **pivot:** not documented.
- **editing:** Inline edit is a headline feature — edit rows **and query results** directly in the grid, with changes staged and committed. **Safe Mode** is the distinguishing control: on connections you mark as production, it forces a **code review** step showing the SQL that is about to run before it touches the database. Advanced filters (paid, and macOS/Linux only in practice) build multi-condition filters over the grid. Behaviour when a table has **no primary key** is **not documented**. Fill handle and undo depth are **not documented**.
- **framework:** None — this is a desktop and iOS application (macOS 10.11+, Windows 7+, Linux, iOS 12+), **not embeddable in any web application**. Extensibility is via **JavaScript plugins** (in beta), which is the only programmable surface.
- **dataModel:** Live native driver connections to 14+ engines — PostgreSQL, MySQL, MariaDB, SQLite, SQL Server, Redshift, Oracle, CockroachDB, Snowflake, Cassandra, Redis, Vertica, BigQuery, ClickHouse, Turso, MongoDB (beta) — with libssh tunnelling and TLS built in. There is no client row model exposed; the grid is bound directly to a result set.
- **distinctive:** **Safe Mode with mandatory code review on production connections** — the grid refuses to be a foot-gun by making every staged edit produce reviewable SQL before commit. That, plus true native rendering on three desktop platforms *and* iOS, is the moat; the cost is that it is closed source, undocumented at the mechanism level (no published paging or no-PK behaviour), and contributes nothing reusable to anyone building a component.

Sources: https://tableplus.com/, https://docs.tableplus.com/, https://docs.tableplus.com/utilities/licensing, https://tableplus.com/pricing, https://tableplus.com/blog/2018/10/tableplus-free-vs-paid.html

### pgAdmin data editor {#grid:pgadmin}

- **license:** **PostgreSQL License** (a permissive BSD/MIT-style licence) — single edition, no tiers, no paid version, no gated features. Of everything in this batch it is the only product with no commercial split at all, which is the whole point of it being the reference client.
- **rendering:** **DOM, but not as an embeddable component.** pgAdmin 4 is a Python/Flask server with a React frontend, shipped either as a desktop application (a bundled runtime wrapping the web app) or deployed as a web server. The data grid is React-rendered HTML, so it is technically DOM — but it is an application, not a library.
- **virtualization:** **Batched on-demand fetch as you scroll.** The grid does not fetch the whole result set: it pulls a batch at a time, controlled by the **"Number of rows to fetch in a batch"** preference (**default 1,000**, historically the `ON_DEMAND_RECORD_COUNT` config value, renamed `DATA_RESULT_ROWS_PER_PAGE` in recent versions), and fetches the next batch as you scroll toward the end. Separately, the View/Edit Data context menu lets you cap the query itself at *First 100 rows / Last 100 rows / All rows*. On a million-row table it therefore streams in 1,000-row batches rather than materialising the set.
- **nesting:** None. No master-detail, no tree data, no row grouping in the grid, no nested grids. The object tree in the left browser is the only hierarchy, and it is schema objects, not data rows.
- **charting:** Not in the data grid. The Query Tool has a **Graph Visualiser** tab that plots a result set (line, stacked line, bar, stacked bar, pie) by picking X and Y columns, and there is a separate server **Dashboard** with activity charts. There is no select-a-range-and-chart gesture within the grid, and geometry columns open in a separate **Geometry Viewer** map panel (PostGIS).
- **formula:** None. The expression language is SQL; **not documented** as a grid capability.
- **pivot:** not documented.
- **editing:** The strictest editability rule of the three clients, and stated flatly: **"To modify the content of a table, each row in the table must be uniquely identifiable. If the table definition does not include an OID or a primary key, the displayed data is read only."** There is no virtual-key escape hatch — unlike DBeaver, pgAdmin simply refuses. **Views cannot be edited**, and rule-based updatable views are explicitly unsupported. Where editing *is* allowed: numeric cells edit inline on double-click, non-numeric open an edit bubble, empty means `NULL` and `''` means empty string, and changes are staged until you press **Save Data**. Dedicated editors exist for JSON (Code/Tree/Form/Preview modes) and for geometry. Primary-key columns are marked `[PK]` in the header. Sorting and filtering go through a Sort/Filter dialog that builds a real SQL `WHERE` clause with configurable NULL ordering — filtering is server-side, not a client predicate. Fill handle, Excel paste and undo are **not documented**.
- **framework:** None as a component. Python/Flask + React application, distributed as a desktop app, a Docker container, or a WSGI web deployment. **Not embeddable**, no component API. Notably, **View/Edit Data and the Query Tool are the same tool in two operating modes** — the editable grid is literally the query result grid with row identity resolved.
- **dataModel:** PostgreSQL only (plus EDB Postgres Advanced Server). Always a live server-side cursor over a connection; the batch-fetch preference is the only row-model knob. No client-side dataset, no offline mode. Foreign-key navigation from a grid cell is **not documented** — a real capability gap against DBeaver.
- **distinctive:** It is the honest baseline: a permissively licensed, single-edition, PostgreSQL-only grid that batches 1,000 rows on demand and **refuses to let you edit anything it cannot uniquely identify**. That refusal is the design position worth noting — where DBeaver hands the user a virtual key and a warning, pgAdmin decides that a grid which might update the wrong row is worse than a grid that is read-only. Its weakness as a grid is equally clear: no FK navigation, no nesting, no pivot, and filtering that round-trips to the server as SQL.

Sources: https://www.pgadmin.org/docs/pgadmin4/latest/editgrid.html, https://www.pgadmin.org/docs/pgadmin4/latest/preferences.html, https://www.pgadmin.org/docs/pgadmin4/9.6/editgrid.html, https://www.pgadmin.org/

---

## Cross-cutting findings

Sixty-one products, read in one pass. The patterns below are the reason the
document exists; every claim traces to a section above.

### 1. DOM won, and almost nobody admits why

**Fifty-plus of sixty-one render to the DOM.** The canvas cohort is small and
tells a specific story: `glide-data-grid`, `canvas-datagrid`, and the
spreadsheet lineage (Univer, Luckysheet, FortuneSheet, x-spreadsheet). Of
those, `canvas-datagrid` (last release 2023-05-22), Luckysheet (archived
2025-10-30) and x-spreadsheet (migrated away) are dead or dying.

**Not one of the fifteen commercial grids uses canvas.** Wijmo, Bryntum,
Webix, Ext JS, jQWidgets, Smart UI, Kendo, Syncfusion, DevExtreme,
Infragistics, Vaadin, Handsontable, Salesforce — all DOM. That is not
conservatism; DOM buys accessibility, text selection, browser find, CSS
theming and DOM-based test suites for free, and every one of those is a
support-ticket generator for an enterprise vendor.

Glide states the trade honestly and is the fairest summary in the survey:
canvas is chosen because "once you need to load/unload hundreds of DOM
elements per frame nothing can save you" — and its maintainers add that "none
of the primary developers are accessibility users so there are likely flaws in
the implementation we are not aware of."

The counter-example that should unsettle any canvas advocate is
**`regular-table`**: a real HTML `<table>`, DOM all the way down, servicing a
**two-billion-row** example — its demo sets `NUM_ROWS = 2000000000`. So "canvas
is required for scale" is not established by this field. Canvas buys *update
throughput under churn*, which is a narrower and more honest claim.

### 2. The paywall falls in the same place every time

Across every open-core product, the line runs through the same features:

| Gated feature | AG Grid | MUI X | RevoGrid | Ext JS | Vaadin | Jspreadsheet | Univer |
|---|---|---|---|---|---|---|---|
| Pivot | Enterprise | Premium | Pro | Enterprise | — | Pro | Pro |
| Charts | Enterprise | Premium | Pro | Enterprise | Pro | Pro | Pro |
| Tree / master-detail | Enterprise | Pro | Pro | — | — | — | — |
| Server row model | Enterprise | — | Pro | — | — | — | — |
| Excel export | Enterprise (styled) | Premium | Pro | Enterprise | Pro | Pro | Pro |
| In-cell editing polish | — | — | — | — | **Pro** | — | — |

**Pivot and charts are paid in seven of seven.** If a competitor wants a claim
that survives a procurement conversation, "pivot and integrated charts, MIT" is
it — that is the sentence every one of these vendors decided is worth money.

Vaadin is the outlier worth noting for its cheek: reading is free, *editing
well* is Pro. Single-click edit, enter-moves-to-next-row, typed editors and full
keyboard navigation are the paid product.

### 3. The MIT benchmark is Tabulator, not AG Grid Community

The instinctive comparison is AG Grid Community, and it is the wrong one. AG
Grid Community withholds tree data, master-detail, grouping, pivot, charts,
range selection and the advanced clipboard.

**Tabulator, MIT with no commercial edition at all, ships:** tree data, genuine
nested tables (a grid inside a grid via `rowFormatter`), range selection,
clipboard, XLSX/PDF export, and a **multi-sheet Spreadsheet Mode** with footer
sheet tabs. **SlickGrid-Universal** (also MIT) adds first-party
OData/GraphQL/SQL backend-service query builders across five framework
wrappers, with ~5,000 unit tests at 100% coverage.

Any "most capable MIT grid" claim is measured against those two, and both are
stronger than the reflexive comparison suggests.

### 4. 2026 was a bad year for permissive licences — with two exceptions

The drift is almost entirely one-directional:

- **PrimeNG/PrimeReact/PrimeVue** left MIT (PrimeNG 22+); the GitHub repo was
  **archived 2026-06-29**. The free tier now tests revenue, headcount *and* VC funding.
- **NocoDB** left AGPL-3.0 for the Sustainable Use License at **v0.301.0
  (2026-01-09)** — source-available, not OSI-approved.
- **Directus** relicensed **twice** — GPLv3 → BSL 1.1 (2023) → MSCL (v12, May 2026).
- **Handsontable** left MIT after **v6.2.2 (Dec 2018)**; the free tier is now
  non-commercial-only.
- **jqGrid** relicensed to CC BY-NC after 4.7.0, forcing the `free-jqGrid` fork —
  which then went dormant (last push 2023-08-22).

Two counter-currents, and both matter:

- **DataTables moved *toward* permissive** — GPL+BSD through 1.9, MIT from 1.10 on.
- **Infragistics released `igniteui-grid-lite` under MIT** — a paid grid vendor
  shipping a free, unfenced, Web-Component grid. When incumbents raise the
  free-tier floor themselves, "MIT" alone stops being a differentiator.

For a project whose thesis is "MIT end to end," the strategic read is that the
*promise of permanence* is now worth as much as the licence itself. Five of the
products above were MIT when their users adopted them.

### 5. Formula engines are the genuine moat, and they are nearly all paid

| Engine | Documented functions | Licence |
|---|---|---|
| Univer | **528** | Apache-2.0 core, but the *fast* engine is Pro |
| Jspreadsheet Pro | **500+** (incl. `MAP`/`REDUCE`/`SCAN`) | Paid, then Formula Pro on top |
| Kendo Spreadsheet | **463** | Paid only |
| HyperFormula | **423** | **GPLv3 or pay** — no permissive option |
| Ignite UI Excel library | ~300 | Paid |
| Webix SpreadSheet | 250+ | Pro only |
| Wijmo FlexSheet | ~140 | Paid |
| Syncfusion Spreadsheet | ~100+ | Paid (free under a company-size cap) |
| SheetJS CE | **0 — reads formula text, does not evaluate** | Apache-2.0; evaluation is Pro |

There is **no permissively-licensed, Excel-scale formula engine** in this field.
HyperFormula is the reference design and is GPLv3. Univer's core is Apache-2.0
but the vendor's own docs cite the Pro engine at **5.19×** on a 68K-formula
workbook, so the free tier is explicitly the slow one.

The technique worth stealing is HyperFormula's **range-node decomposition**:
`SUM(B5:D20)` naively creates one graph edge per cell and grows quadratically;
inserting *range nodes* and reusing an existing `B5:D19` node lets overlapping
ranges share structure. That is the difference between a toy and an engine.

### 6. Almost nobody does incremental recomputation

Every grid here recomputes derived state — sorts, filters, aggregates, pivots —
by re-running the pipeline. **Perspective is the exception**, and it is a C++
columnar engine compiled to WASM rather than a grid: `table.update()` ticks
pivots, aggregates, filters and window columns forward without a full
recompute, and collapsed pivot subtrees are skipped entirely until expanded.
Its **Virtual Servers** then compile a viewer config into native DuckDB or
ClickHouse queries, so the grid becomes a UI over a warehouse with no data copy.

That is the one product here a JS grid cannot out-engineer on the data axis. It
is also Apache-2.0, its renderer (`regular-table`) is separable, and it has no
editing story worth the name — which is precisely the seam.

### 7. Nesting is common; nesting *cheaply* is not

Grid-inside-a-grid is supported by AG Grid (`detailGridOptions` — a real grid
with its own row model), Syncfusion (`childGrid`, n levels), Infragistics
(**HierarchicalGrid**, independent per-level configuration and load-on-demand),
jqGrid (SubGrid, since 2009), Tabulator, Bryntum, Wijmo, jQWidgets, Smart UI,
antd, PrimeNG, react-data-grid (userland), and canvas-datagrid.

Two are structurally interesting. **Infragistics** splits *recursive
same-schema* (TreeGrid) from *heterogeneous nested grids with per-level config*
(HierarchicalGrid) — most vendors fold both into one mode flag, and the split is
the harder thing to retrofit. **canvas-datagrid** nests by painting the child
inside the parent's own draw pass, which nothing DOM-based can match on cost —
and it is three years stale, so the idea is sitting unused.

### 8. Database UIs split three ways on one question: does it emit DDL?

- **Generates real DDL from the UI:** Supabase (a documented *subset* of types,
  a FK selector, RLS on a separate policies screen), **Teable** (field add and
  type conversion against real Postgres columns), NocoDB (full
  create/modify/delete — but **disabled by default**, with the vendor advising
  against enabling it).
- **Edits only its own owned schema:** Baserow, Airtable.
- **Refuses entirely:** **Retool** — rows only, and even then into a
  `changesetArray` you must persist with a query you write yourself.

The best idea in the category is **NocoDB's virtual columns**: with schema
editing off, users still get Lookup, Rollup and Formula fields stored in
NocoDB's *own* metadata, never touching the customer's DDL. That is the right
answer for a table editor pointed at a production database, and it applies
directly to `@onegrid/studio`.

The desktop clients answer the sharpest question in the survey — *what happens
when a result set has no primary key?* — in opposite ways. **DBeaver** offers a
**virtual key**, letting the user assert a uniqueness contract the database
never declared, with an explicit warning about updating multiple rows.
**pgAdmin** refuses outright: "If the table definition does not include an OID
or a primary key, the displayed data is read only." Both positions are
defensible; having no position is not.

### 9. The graveyard

Recorded because "which of these can we learn from without adopting" matters:

| Product | Last release / push | Status |
|---|---|---|
| Luckysheet | archived 2025-10-30 | Dead; authors redirect to Univer |
| canvas-datagrid | v0.4.7, 2023-05-22 | Dormant, 148 open issues, no successor fork |
| Rowy | v3.0.0, 2023-10-27 | Dormant; repo moved to `buildship-ai` |
| free-jqGrid | push 2023-08-22 | Dormant |
| x-spreadsheet | migrated to `@wolf-table/table` | Superseded, successor quiet |
| Grid.js | v6.2.0, 2024-03-03 | Commits continue, nothing shipped to npm |
| svelte-headless-table | frozen at Svelte 4 | Maintainer says look elsewhere |
| PrimeNG (MIT line) | archived 2026-06-29 | Frozen upstream at v21 |

### 10. Where that leaves oneGrid

Read against this field, three claims survive and one does not.

**Survives — the database edge.** No developer grid here compiles a request into
real dialect SQL across nine engines with keyset pagination and aggregation
pushdown. The commercial suites stop at a data-adaptor abstraction; the database
UIs own the whole application and are not embeddable. Perspective is the only
serious counterparty, and it delegates to DuckDB/ClickHouse rather than speaking
each dialect itself.

**Survives — MIT pivot + charts + tree + master-detail + server row model.**
That exact bundle is gated in seven of seven open-core products.

**Survives — a 457-function formula engine under MIT.** Every comparable engine
is GPLv3 (HyperFormula), paid (Kendo, Jspreadsheet, Webix, Wijmo), or
permissive-but-slow-by-the-vendor's-own-benchmark (Univer). This is probably the
most under-claimed thing in the repository.

**Does not survive — "canvas is required for scale."** `regular-table` does two
billion rows in a real `<table>`. The defensible version is narrower: canvas
buys update throughput under churn, and oneGrid pairs it with a DOM
accessibility shadow — the same architecture as Glide, whose maintainers are
publicly unsure their a11y layer is correct. Since oneGrid runs an axe-core CI
gate over its shadow, that is a genuine and checkable differentiator. Claim
*that*, not the row count.

**The gap none of this closes:** every product above can be installed.
