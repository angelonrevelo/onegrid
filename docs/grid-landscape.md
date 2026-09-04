# Web data-grid landscape (OSS, FOSS, paid)

Retrieved **2026-09-04**. Every capability line below is taken from that product’s own docs or marketing site, with a URL. A “none / not documented” is a real finding. A blank cell is not allowed.

This is a **research** document for oneGrid. It does not change ROADMAP status or implement competitor APIs.

**Method.** Primary vendor pages were opened (docs, product, GitHub README when that is the official docs). Secondary blogs were used only as a discovery list, never as the source of a capability claim. Pages that 404’d or returned empty are listed under [Unreachable](#unreachable-this-pass), not guessed.

**Out of scope (one line).** Native desktop grids (WinForms, WPF, Qt, Cocoa, SwiftUI Table) are not surveyed here.

---

## How to read this

Five dimensions, same for every product:

| Dimension | What it means |
|---|---|
| **Render** | How pixels get on screen: native HTML table, virtualized DOM (divs), canvas, WebGL, headless (no UI), hybrid |
| **Nesting** | Tree data, master-detail / nested grid, row grouping — vendor’s own name |
| **UI / design** | Theming, density, a11y, mobile, spreadsheet chrome vs dashboard table |
| **Charting** | In-grid range charts, sparklines, or explicit none |
| **Excel / formula** | In-cell formulas, fill handle, xlsx import/export, clipboard — or explicit none |

**Three product kinds** keep getting conflated in comparison blogs. They are not interchangeable:

1. **Data grid** — query results, admin tables, SSRM/infinite rows (AG Grid, MUI X, Kendo, Tabulator).
2. **Spreadsheet** — cell addresses, workbooks, formula engine, Excel file fidelity (Handsontable, SpreadJS, Univer, Jspreadsheet).
3. **Headless table engine** — state + APIs, you own markup (TanStack Table).
4. **Design-system table** — themed HTML `<table>` for page UI, not a million-row grid (Ant Table, Carbon DataTable, Element Plus Table).

---

## Matrix

Legend: **Y** = vendor documents it on the product itself. **Pro** = paid/Pro/Enterprise only. **sep** = sibling product in the same suite, not the grid. **n/d** = not documented on pages opened. **headless** = you build it.

| Product | Kind | License (vendor) | Render | Tree | Nested grid / master-detail | Grouping | Charts | In-grid formulas | xlsx |
|---|---|---|---|---|---|---|---|---|---|
| AG Grid Community | data grid | MIT, free production | virtual DOM | n/d | n/d | n/d | n/d | n/d | CSV |
| AG Grid Enterprise | data grid | commercial EULA | virtual DOM | Y | Y (Detail Grid) | Y | sparklines; Integrated Charts = Bundle | Y (`allowFormula`) | Y |
| TanStack Table | headless | MIT | headless | expanding (you render) | custom | Y (logic) | none | none | none |
| Tabulator | data grid | MIT | virtual DOM | Y | n/d | Y | none (progress formatter) | spreadsheet: not yet | Y (SheetJS) |
| Handsontable | spreadsheet | paid; hobby non-commercial | virtual DOM both axes | NestedRows tree | same (not child grid) | via NestedRows | none | HyperFormula ~400 | Y (ExcelJS) |
| Glide Data Grid | data grid | MIT | canvas | n/d | n/d | column groups | sparklines (homepage) | none | none |
| SlickGrid | data grid | MIT | virtual DOM | example | Row Detail / Master-Detail examples | DataView | post-render graphs example | formula-editor example | copy/paste examples |
| RevoGrid (MIT) | data grid | MIT | virtual DOM (WC) | n/d | n/d | n/d | custom SVG cells | n/d | n/d |
| RevoGrid Pro | data grid | paid | same | Y | Y | Y | cell charts; Gantt sep | formulajs | Y |
| Grid.js | table | MIT | DOM `<table>` (Preact) | n/d | n/d | nested **headers** | none | none | n/d |
| MUI X Community | data grid | MIT | virtual DOM | n/d | n/d | n/d | sep Charts | none | CSV |
| MUI X Pro | data grid | commercial | virtual DOM | Y | Y (panel can be another Grid) | n/d | sep | none | CSV |
| MUI X Premium | data grid | commercial | virtual DOM | Y | Y | Y | sep | none (fill/paste Excel-like) | Y |
| Syncfusion DataGrid | data grid | commercial + community licence | virtual DOM | sep Tree Grid | Y | Y | integrate Charts | sep Spreadsheet | Y |
| KendoReact Grid | data grid | free + premium features | virtual DOM | sep TreeList | Pro | Pro | Pro integration | sep Spreadsheet | Pro |
| DevExtreme DataGrid | data grid | commercial | virtual / infinite DOM | sep TreeList | Y | Y | sep Chart/Sparkline | n/d | Y |
| DHTMLX Grid | data grid | GPL v2 Standard + paid PRO | smart-render DOM | TreeGrid PRO | row expander / nested subgrids | Y | sep Chart | sep Spreadsheet 170+ | Y |
| Webix DataTable | data grid | GPLv3 + paid PRO | lazy HTML5 DOM | TreeTable | subview can nest DataTable | column groups | **sparklines in cells** | **Y** (`math: true`) | Y |
| Bryntum Grid | data grid | commercial | virtual DOM | Y | nested grid / master-detail | Y | nested chart demo | n/d | Y |
| Sencha Ext JS Grid | data grid | CE (rev. cap) + paid | buffered / infinite DOM | Tree Grid | expand + group | Grouped Grid | widget cells; Charts paid | spreadsheet **selection** | Y (Exporter paid) |
| Univer | spreadsheet | Apache-2 + Pro | canvas + DOM chrome; headless Node | outline **Pro** | n/d (relational table is sep) | Pro outline | **Pro** | full spreadsheet | Pro |
| Luckysheet | spreadsheet | MIT, **archived 2025-10-30** | canvas | n/d | n/d | n/d | Y | Y | Y (advanced → Univer) |
| Jspreadsheet CE | spreadsheet | MIT | DOM table | nested headers | n/d | n/d | n/d | basic formulas | cannot parse xlsx (vendor) |
| Jspreadsheet Pro | spreadsheet | paid | virtual DOM both axes | grouping Premium | n/d | Premium | floating charts | 500+ | Y |
| SpreadJS | spreadsheet | commercial | canvas paint | Excel outlines / pivot add-on | n/d | pivot add-on | 30+ types + sparklines | 500+ | Y |
| Wijmo FlexGrid | data grid | commercial | virtual DOM | TreeGrid | master-detail / NestedGrids | Y | sparklines (CellMaker) | none (xlsx I/O only) | Y |
| SVAR DataGrid | data grid | MIT | virtual DOM | Y | n/d | column grouping | none | none | CSV |
| FancyGrid | data grid | commercial | DOM | Tree / Sub Grid | row expander | Y | Highcharts + sparklines | none | Y |
| Vaadin Grid | data grid | Apache-2 | virtualized WC | TreeGrid | item details | n/d | sep Charts paid | sep Spreadsheet paid | n/d |
| Ignite UI Grid | data grid | commercial | row+col virtual DOM | Tree Grid | Hierarchical Grid | Y | sep charts | none | Y |
| PrimeReact DataTable | table | MIT (repo archived 2026-06) | DOM + optional virtual | TreeTable sep | row expansion | Y | none | none | CSV |
| Ant Design Table | table | MIT | DOM; optional virtual | Y | nested table demo | header groups | none (promo AntV S2) | none | none |
| Element Plus Table | table | MIT | DOM; table-v2 virtual | Y | expand | n/d | none | none | none |
| react-data-grid (Comcast) | data grid | MIT | virtual DOM | TreeDataGrid | n/d | Y | none | none (fill-drag) | none |
| Material React Table | data grid | MIT | MUI + TanStack Virtual | expanding sub-rows | detail panel | Y | none | none | CSV |
| DataTables | table | MIT core; Editor paid | HTML `<table>` | n/d | child rows (ext) | n/d | none | none | Buttons export |
| Highcharts Grid | data grid | Lite free EULA / Pro paid | HTML table + row virtual | n/d | n/d | headers; rowGrouping Pro | Pro sparklines | none | none |
| Carbon DataTable | table | Apache-2 | HTML table | n/d | expandable rows | n/d | none | **explicit not a spreadsheet** | none |
| FortuneSheet | spreadsheet | MIT | canvas | n/d | n/d | n/d | roadmap | Y | plugin |
| HyperFormula | engine | GPL-3 / commercial | **headless — not a grid** | n/a | n/a | n/a | none | ~400 Excel functions | n/a |
| Canvas Datagrid | data grid | (site: canvas lib) | canvas | hierarchical rows | cell-in-cell | n/d | n/d | n/d | n/d |
| Cheetah Grid | data grid | MIT | canvas (docs site) | n/d | n/d | multi header | n/d | n/d | n/d |
| VisActor VTable | analysis table | (ByteDance OSS family) | canvas | tree display | n/d | pivot | Y (analysis) | n/d | n/d |
| oneGrid (this repo) | data grid | MIT | canvas-2D + DOM overlay | Y | master-detail | Y | range chart + sparklines | formula package | xlsx package |

---

## Named products (criterion 3)

### AG Grid Community and Enterprise

- **Site:** [https://www.ag-grid.com/](https://www.ag-grid.com/) · [Community vs Enterprise](https://www.ag-grid.com/javascript-data-grid/community-vs-enterprise/) · [DOM virtualisation](https://www.ag-grid.com/javascript-data-grid/dom-virtualisation/)
- **License.** Community: MIT, free including production. Enterprise: commercial EULA; local test without a key shows a watermark. Pricing page (opened 2026-09-04 via Community vs Enterprise): per-developer perpetual with 1 year of updates. ([community-vs-enterprise](https://www.ag-grid.com/javascript-data-grid/community-vs-enterprise/))
- **Render.** Virtualised DOM: “the grid only renders what you see on the screen… row and column virtualisation.” Inspecting the DOM shows `div` cells inserted and removed on scroll — not a native `<table>`. Default row buffer 10; max 500 rendered rows unless `suppressMaxRenderedRowRestriction`. ([DOM virtualisation](https://www.ag-grid.com/javascript-data-grid/dom-virtualisation/)) Community lists “Column and row virtualization enabled by default.” ([community-vs-enterprise](https://www.ag-grid.com/javascript-data-grid/community-vs-enterprise/))
- **Nesting.** **Enterprise:** Master / Detail — “another grid is displayed… known as the Detail Grid” (`masterDetail`, `detailGridOptions`). ([master-detail](https://www.ag-grid.com/javascript-data-grid/master-detail/)) Tree Data and Row Grouping are listed as Enterprise. ([community-vs-enterprise](https://www.ag-grid.com/javascript-data-grid/community-vs-enterprise/)) Community docs opened do not offer those modules.
- **UI / design.** Theming API, built-in themes, compactness / row height, ARIA `grid` / `treegrid`, keyboard nav. Look: dense enterprise data grid; spreadsheet extras (range, fill, formulas) sit on Enterprise. ([community-vs-enterprise](https://www.ag-grid.com/javascript-data-grid/community-vs-enterprise/))
- **Charting.** Community: none of Integrated Charts / sparklines on the Community feature list. Enterprise: sparklines via `agSparklineCellRenderer` + `SparklinesModule`. ([sparklines-overview](https://www.ag-grid.com/javascript-data-grid/sparklines-overview/)) Enterprise Bundle: Integrated Charts — “Just set `enableCharts=true` to allow users to create charts from inside the grid.” ([integrated-charts](https://www.ag-grid.com/javascript-data-grid/integrated-charts/))
- **Excel / formula.** Community: CSV, cell editing. Enterprise: Excel export, clipboard, fill handle, **Formulas** (`allowFormula: true`, `=SUM`, fill-handle offsets relative refs). Formulas are **not** supported with tree data, grouping, pivot, master-detail, or SSRM. CSV export writes evaluated values; Excel export writes the formulas. ([formulas](https://www.ag-grid.com/javascript-data-grid/formulas/))

**Visual.** Quartz/Alpine-class themed grid: frozen columns, status bar, side tool panels, Excel-like filter menus on Enterprise. Cells are absolutely positioned divs over a viewport; not a spreadsheet workbook (no sheet tabs in the core grid).

---

### TanStack Table

- **Site:** [https://tanstack.com/table](https://tanstack.com/table) · [docs](https://tanstack.com/table/latest/docs)
- **License.** MIT (homepage + GitHub).
- **Render.** **Headless.** Vendor: “supplies state and typed APIs without prescribing a single element or style.” You render `<table>` or anything else. Virtualisation is **not** included; official examples use TanStack Virtual. ([homepage](https://tanstack.com/table))
- **Nesting.** Grouping, expanding sub-rows (`getSubRows`), “detail panels, sub-tables” as **your** UI. No nested-grid widget.
- **UI / design.** 100% yours. Examples for shadcn, MUI, Mantine, Chakra, HeroUI, React Aria. Cell selection described as “spreadsheet-style rectangular ranges.”
- **Charting.** None in the documented engine.
- **Excel / formula.** None (no formula engine, no xlsx). Clipboard/export would be application code.

**Visual.** There is no default look. Products using it (shadcn Data Table) look like the host design system.

---

### Tabulator

- **Site:** [https://www.tabulator.info/](https://www.tabulator.info/) · [virtual DOM](https://www.tabulator.info/docs/6.x/virtual-dom/) · [tree](https://www.tabulator.info/docs/6.x/tree/) · [spreadsheet](https://www.tabulator.info/docs/6.x/spreadsheet/)
- **License.** MIT; commercial use without a fee. Optional paid support. ([license](https://www.tabulator.info/docs/6.x/license/))
- **Render.** Virtualised DOM: “Lightning fast rendering of large data sets using a virtualized DOM.” Basic renderer can paint all rows. Horizontal virtual DOM exists. `role="grid"`. ([homepage](https://www.tabulator.info/))
- **Nesting.** Tree (`dataTree`, `_children`). Row grouping (`groupBy`). Nested *grid instance* not documented as a first-class module.
- **UI / design.** Five packaged themes + Bootstrap / Semantic / Bulma / Materialize. `responsiveLayout` hide/collapse. ARIA. “Fully functional on mobile touch devices.” Optional **Spreadsheet** module for sheet UX.
- **Charting.** None. Formatters include progress bar / star — not charts.
- **Excel / formula.** Clipboard; download CSV/JSON/XLSX/PDF (XLSX needs SheetJS); import xlsx/csv/ods. Spreadsheet module: **“does not currently support cell based formulas, but this will be comming in a future release.”** ([spreadsheet](https://www.tabulator.info/docs/6.x/spreadsheet/))

**Visual.** Classic HTML-table-looking widget with CSS themes; optional midnight/modern skins. Spreadsheet mode adds A1 headers and range selection without a formula bar.

---

### Handsontable

- **Site:** [https://handsontable.com/docs/javascript-data-grid/](https://handsontable.com/docs/javascript-data-grid/) · [formulas](https://handsontable.com/docs/javascript-data-grid/formula-calculation/) · [pricing](https://handsontable.com/pricing)
- **License.** Commercial (Standard from vendor pricing page). Hobby / `licenseKey: 'non-commercial-and-evaluation'` is not for commercial products. ([docs introduction](https://handsontable.com/docs/javascript-data-grid/))
- **Render.** Vendor homepage (cited in OSS research pass): virtualisation on **both axes**, dynamic row heights. Docs describe drawing only the visible part of the grid. DOM cells (Walkontable), not canvas.
- **Nesting.** NestedRows / “Row parent-child” as a **tree grid**. Vendor also calls the same pattern “master-detail view or grouping rows.” Not a child Grid instance. **Formulas do not support nested object data.** ([formula-calculation known limitations](https://handsontable.com/docs/javascript-data-grid/formula-calculation/))
- **UI / design.** “Spreadsheet-like data grid.” Themes `main` / `horizon` / `classic`; density default/compact/comfortable; WCAG 2.1 AA claimed on a11y docs (OSS pass). Excel-like headers, fill handle, formula bar when Formulas is on.
- **Charting.** None documented on the introduction or formula pages opened.
- **Excel / formula.** Formulas plugin powered by **HyperFormula** (~400 functions, cross-sheet, named expressions, custom functions, `HYPERLINK` rendering). Autofill adjusts relative refs. ([formula-calculation](https://handsontable.com/docs/javascript-data-grid/formula-calculation/))

**Visual.** Closest of the “data grids” to Excel: row/col headers, frozen panes, fill handle square, optional formula highlighting. Horizon theme hides vertical rules for a more “analysis table” look.

---

### Glide Data Grid

- **Site:** [https://github.com/glideapps/glide-data-grid](https://github.com/glideapps/glide-data-grid) · [docs.grid.glideapps.com](https://docs.grid.glideapps.com/) · [grid.glideapps.com](https://grid.glideapps.com)
- **License.** MIT. Pricing page lists $0 SKUs (joke / free).
- **Render.** **Canvas.** README: “A canvas-based data grid… Cells are rendered lazily on demand.” FAQ: they left virtualized DOM because “once you need to load/unload hundreds of DOM elements per frame nothing can save you.” Custom renderers **must** use Canvas. Overlay editors use a portal `div`.
- **Nesting.** No tree / master-detail API in DataEditor docs. `DrilldownCell` is a pill of text/images, not a nested grid. `experimental.isSubGrid` exists without nested-grid docs.
- **UI / design.** Theme object, freeze columns, native scrolling, row markers. A11y: “Does it work with screen readers…? Yes.” Spreadsheet-like canvas surface.
- **Charting.** Homepage claims “Inline charts (sparklines).” Dedicated sparkline cell docs URL was empty this pass — treat as **homepage-claimed, API page not confirmed**.
- **Excel / formula.** Editing, paste, fill handle. No formula engine. No xlsx API in DataEditor docs.

**Visual.** Single full-bleed canvas, native OS scrollbars, Excel-ish selection rectangle and fill handle, HTML overlay only for the editor. Looks closer to Glide’s data editor than to Material tables.

---

### SlickGrid (6pac)

- **Site:** [https://github.com/6pac/SlickGrid](https://github.com/6pac/SlickGrid) — `slickgrid.net` redirects here.
- **License.** MIT.
- **Render.** Virtualised DOM “canvas of divs,” not `<table>`, not WebGL. Manifesto: a grid/spreadsheet toolkit, not a styled HTML table. Examples include 500,000-row DataView.
- **Nesting.** Wiki examples: tree expand/collapse; multi-level grouping; Master/Detail grids; Row Detail Panel plugin.
- **UI / design.** Alpine theme (v5). Default `rowHeight` 25. Spreadsheet-capable, dated-unless-themed.
- **Charting.** Example “background post-rendering to add graphs.” No chart engine.
- **Excel / formula.** Examples: cell range selection, Excel-style formula editor, drag-fill, Excel-compatible copy/paste. Not a HyperFormula-class core.

**Visual.** Compact rows, spreadsheet selection, plugin chrome. Looks like 2010s finance grids unless Alpine is applied.

---

### RevoGrid

- **Site:** [https://rv-grid.com/](https://rv-grid.com/) · [guide](https://rv-grid.com/guide/) · [pro](https://rv-grid.com/pro/)
- **License.** MIT core, free commercial. Pro Lite/Advanced/Enterprise paid; 30-day trial. ([pricing](https://rv-grid.com/pricing))
- **Render.** Web Component, virtual rows **and** columns, buffer outside viewport, pinned regions. `disableVirtualX` / `disableVirtualY`. Custom cells via hyperscript (can include SVG).
- **Nesting.** MIT core: not listed. Pro: tree data, master detail (“nested grid, form, or custom product view”). `/guide/grouping` **404** this pass.
- **UI / design.** Demo `theme = 'compact'`. “Spreadsheet-grade editing.” `/guide/themes` **404**. Pro: “Next Line Focus (WCAG).”
- **Charting.** Core: SVG in cell templates. Pro: inline cell charts; Advanced: Gantt as a separate module.
- **Excel / formula.** Pro: formula engine (formulajs, `=SUM(A1:B2)`), Excel import/export, smart auto fill. `/guide/export` **404**.

**Visual.** Spreadsheet-capable web component; compact theme; range selection. Pro demos add tree carets and nested detail panes.

---

### Grid.js

- **Site:** [https://gridjs.io/](https://gridjs.io/) · [docs](https://gridjs.io/docs)
- **License.** MIT.
- **Render.** DOM table via Preact. `className` hooks for `table`/`td`/`th`. No virtualisation docs; pagination is the large-data story. `/docs/index` **404**; homepage and `/docs` work.
- **Nesting.** Nested **headers** example. Tree / master-detail / nested grid: not documented. `/docs/examples/nested` **404**.
- **UI / design.** CSS + optional CSS-in-JS. Lightweight HTML table, not a spreadsheet.
- **Charting.** None.
- **Excel / formula.** None documented. `/docs/examples/import-export` **404**.

**Visual.** Clean paginated HTML table with search box; Material-ish default CSS.

---

### MUI X Data Grid (Community / Pro / Premium)

- **Site:** [https://mui.com/x/react-data-grid/](https://mui.com/x/react-data-grid/) · [virtualization](https://mui.com/x/react-data-grid/virtualization/) · [licensing](https://mui.com/x/introduction/licensing/)
- **License.** Community MIT (`@mui/x-data-grid`). Pro/Premium commercial. 30-day eval.
- **Render.** DOM virtualisation, row + column. Community row virtualisation capped at 100 rows; Pro/Premium for large sets. Can disable virtualisation for jsdom. **Not headless** — “Unlike headless table libraries, you can start building immediately.”
- **Nesting.** Pro: tree data; master-detail panels (“even another Data Grid”). Premium: row grouping + aggregation.
- **UI / design.** Material UI integration; `sx`; density `standard` / `compact` / `comfortable`; WCAG 2.2 AA target. Dashboard table, not spreadsheet chrome.
- **Charting.** Separate `@mui/x-charts`. Grid charts-integration URL **404**.
- **Excel / formula.** Community: CSV, print, copy. Premium: Excel export (exceljs), clipboard paste, drag-to-fill “similar to … Excel.” Formulas on export are **escaped** (CSV injection) — not an in-grid engine.

**Visual.** Material header, density toggle, column menu; Pro adds pin and tree carets; Premium adds group rows and Excel export.

---

### Syncfusion DataGrid

- **Site:** [https://www.syncfusion.com/javascript-ui-controls/js-data-grid](https://www.syncfusion.com/javascript-ui-controls/js-data-grid)
- **License.** Commercial; community licence if org revenue &lt; $1M, ≤5 developers, ≤10 employees.
- **Render.** Row and column virtualisation: “loading only the visible rows in the Grid viewport.”
- **Nesting.** Grouping. Master-detail DataGrid (detail is another grid). **Tree Grid is a separate control.**
- **UI / design.** Fluent, Tailwind, Bootstrap, Material, Fabric + Theme Studio. Adaptive UI: rows stack vertically on small screens. WAI-ARIA, touch.
- **Charting.** Integrates with Syncfusion Charts (sibling). Sparkline is a separate control.
- **Excel / formula.** Excel-like filtering; export Excel/CSV/PDF; clipboard. **No in-grid formula engine** — Spreadsheet Editor is a separate product.

**Visual.** Bootstrap/Material enterprise table, Excel-style filter popups, optional stacked mobile layout.

---

### Kendo UI / KendoReact Grid

- **Site:** [https://www.telerik.com/kendo-react-ui/components/grid](https://www.telerik.com/kendo-react-ui/components/grid) · [free vs premium](https://www.telerik.com/kendo-react-ui/components/getting-started/free-vs-premium)
- **License.** Mixed: 50+ free components; premium features need a key. Grid row virtualisation, grouping, master-detail, Excel/PDF, clipboard, chart integration are **premium**.
- **Render.** Column virtualisation (free). Row virtualisation (premium). “Render only the visible data.” RSC mode can run data ops on the server. Row-virtualisation deep-link **404** this pass; feature still listed on free-vs-premium.
- **Nesting.** Premium hierarchy (`detail`). Grouping premium. TreeList is a separate premium component.
- **UI / design.** Default / Bootstrap / Material / Fluent. Premium stacked/card layout for mobile. WCAG 2.2 AA + Section 508 claimed.
- **Charting.** Premium chart integration; Charts package is premium.
- **Excel / formula.** CSV free; Excel/PDF premium. **Spreadsheet is a separate premium component** with built-in formulas — not the Grid.

**Visual.** Polished suite chrome, consistent with Kendo buttons/inputs; optional card layout on phones.

---

### DevExtreme DataGrid

- **Site:** [https://js.devexpress.com/React/Documentation/Guide/UI_Components/DataGrid/Overview/](https://js.devexpress.com/React/Documentation/Guide/UI_Components/DataGrid/Overview/)
- **License.** Paid per developer; 30-day trial. ([licensing](https://js.devexpress.com/React/Documentation/Guide/Common/Licensing/))
- **Render.** Virtual and infinite scrolling; `rowRenderingMode` / `columnRenderingMode` = `"virtual"` — “UI elements are only rendered when they come into the viewport.”
- **Nesting.** `masterDetail` template. Grouping. TreeList is a separate component.
- **UI / design.** Fluent theme CSS in docs; ThemeBuilder. Keyboard, WAI-ARIA, RTL; WCAG with documented exceptions. Excel-style filter row.
- **Charting.** Charts / Sparkline are sibling components, not a Grid column type on the overview.
- **Excel / formula.** Export PDF and Excel. In-grid Excel formulas: **not claimed** on DataGrid pages opened.

**Visual.** Fluent/office-adjacent enterprise grid; filter row under headers.

---

### DHTMLX Grid

- **Site:** [https://dhtmlx.com/docs/products/dhtmlxGrid/](https://dhtmlx.com/docs/products/dhtmlxGrid/) · [docs](https://docs.dhtmlx.com/suite/grid/)
- **License.** GPL v2 Standard (npm) for OSS; paid PRO tiers listed on the product page.
- **Render.** “Only the rows currently visible in the viewport are rendered in the DOM” (smart rendering). Claims 100,000+ rows.
- **Nesting.** TreeGrid mode (`type: "tree"`, PRO). Row grouping. Row expander: “nested subgrids, forms, charts, and custom HTML.”
- **UI / design.** Light/dark/high-contrast; Theme Configurator. Keyboard, touch. Excel-like range selection highlighted.
- **Charting.** Suite Chart widget alongside the grid; expander can host charts.
- **Excel / formula.** Range selection; export xlsx/CSV/PDF/PNG. Formulas live in the **Spreadsheet** widget (170+ functions) — Grid docs say use Spreadsheet if you need Excel/Google Sheets behaviour.

**Visual.** Material-adjacent Suite widgets; expander chevrons; spreadsheet selection overlay.

---

### Webix DataTable

- **Site:** [https://webix.com/widget/datatable/](https://webix.com/widget/datatable/) · [formulas](https://docs.webix.com/datatable__formulas.html) · [sparklines](https://docs.webix.com/datatable__sparklines.html)
- **License.** Standard GPLv3 (source obligation). PRO commercial perpetual.
- **Render.** “Lazy rendering and pure JS”; “HTML5 based.” Dynamic loading on scroll. Not canvas.
- **Nesting.** TreeTable. Subrows/subviews: “can contain any Webix UI widget, even another JavaScript DataTable.”
- **UI / design.** Skin Builder. WAI-ARIA role **grid**. Frozen rows/cols, rowspan/colspan.
- **Charting.** **Sparklines in cells** (Line, Area, Bar, Spline, Pie).
- **Excel / formula.** **`math: true`** in-grid formulas (`=[:3,:2]-[:3,:3]`), `editMath`, clipboard into Excel, export Excel/PDF/PNG/CSV. SpreadSheet is a separate widget.

**Visual.** Classic JS widget look; optional sparkline columns; formula mode still looks like a datatable, not a workbook.

---

### Bryntum Grid

- **Site:** [https://bryntum.com/products/grid/](https://bryntum.com/products/grid/) · [features](https://bryntum.com/products/grid/features)
- **License.** Commercial (End-User vs OEM). 45-day trial. Every developer who touches the code needs a licence.
- **Render.** “Virtualized rendering”; “Minimal DOM interactions”; “Element reuse”; “Built entirely on web standards: JavaScript, HTML and CSS.” Subgrids share a vertical scroller.
- **Nesting.** Tree grid. Nested grid / master-detail examples. Row grouping.
- **UI / design.** Five preset themes + SASS. Responsive example. Keyboard nav. A11y guide URL redirected to generic docs (no WCAG sentence extracted).
- **Charting.** “Nested grid with a chart” demo — embedding, not a chart engine.
- **Excel / formula.** Export PDF/PNG/Excel. Pin rows “as in Excel.” AI cell “formula” is an AI instruction, not Excel calc. Formula engine **not claimed**.

**Visual.** Modern scheduler-family chrome (same visual language as Bryntum Gantt); striped rows; nested example shows a chart beside a child grid.

---

### Sencha Ext JS Grid

- **Site:** [https://www.sencha.com/products/extjs/](https://www.sencha.com/products/extjs/) · [grid](https://www.sencha.com/grid/) · [Ext.grid.Grid](https://docs.sencha.com/extjs/7.9.0/modern/Ext.grid.Grid.html)
- **License.** Community Edition free under revenue/dev caps. Pro/Enterprise commercial (store lists yearly per-dev prices). 30-day eval.
- **Render.** Modern Grid extends `Ext.dataview.List` with `infinite` buffering: extra items “rendered out of view” then repositioned. CE: virtual store, “only a small portion of these loaded records are rendered to the DOM.”
- **Nesting.** Tree Grid; Grouped Grid; Pivot Grid (paid). Expand operation on the marketing grid page.
- **UI / design.** Themer; Material in CE. ARIA package / Section 508 claim. Spreadsheet **selection** in CE.
- **Charting.** Widget cells can host bar charts / buttons. Charts + D3 adapters in paid matrix.
- **Excel / formula.** Spreadsheet-style **selection** and cell editing. Export CSV/TSV/HTML/PDF/XLS via Exporter (paid-matrix). **No Excel formula engine** claimed for Grid.

**Visual.** Classic Ext enterprise: panel headers, locked columns, buffered scroller. Looks like a desktop app ported to the web.

---

## Further sweep (≥5 beyond the named set)

### Univer (Luckysheet successor)

[univer.ai](https://univer.ai/) · [docs.univer.ai/guides/sheets](https://docs.univer.ai/guides/sheets) · [github.com/dream-num/univer](https://github.com/dream-num/univer)

Apache-2 core; Pro commercial (collab, import/export, charts, pivot, sparklines, outlines). **Canvas** render engine + React/DOM chrome; **headless Node**. Spreadsheet, not a tree data grid; Pro **outline grouping**. Charts/sparklines **Pro**. Full formula workbook; marketing 500+ functions; xlsx **Pro**.

### Luckysheet (archived)

[github.com/dream-num/Luckysheet](https://github.com/dream-num/Luckysheet) — MIT, **archived 2025-10-30**, production directed to Univer. HTML5 **canvas**. Charts (line/column/area/bar/pie). Built-in formulas; Excel import/export listed historically.

### Jspreadsheet CE / Pro

[github.com/jspreadsheet/ce](https://github.com/jspreadsheet/ce) · [jspreadsheet.com](https://jspreadsheet.com/)

CE MIT DOM table + lazy loading; basic formulas; **cannot parse xlsx** (vendor comparison). Pro paid: virtual rows **and** columns, 500+ formulas, xlsx/ods, fill handle, floating charts, grouping on Premium.

### MESCIUS SpreadJS

[developer.mescius.com/spreadjs](https://developer.mescius.com/spreadjs)

Commercial spreadsheet. Paint API (`suspendPaint`); vendor technical writing describes **HTML5 canvas + double-buffer**. 500+ Excel functions, full xlsx family, 30+ chart types, sparklines, Designer ribbon add-on. Closest “Excel in the browser.”

### MESCIUS Wijmo FlexGrid

Correct URL: [flexgrid-javascript-data-grid](https://developer.mescius.com/wijmo/flexgrid-javascript-data-grid) (`/flexgrid-js` **404**).

Commercial. Virtualised DOM (“number of DOM elements remains constant”). TreeGrid, master-detail, NestedGrids, grouping. **Sparklines** via CellMaker. Excel **import/export**, not a formula engine.

### SVAR React DataGrid

[svar.dev/react/datagrid](https://svar.dev/react/datagrid/) — MIT. Virtual rows/cols. Tree data. Willow light/dark. **No charts, no formulas.** CSV + print. (Webix’s sibling brand.)

### FancyGrid

[fancygrid.com](https://fancygrid.com/) — commercial. Tree, Sub Grid, row expander, grouping. **Highcharts + sparklines.** Excel/CSV export. Not a formula spreadsheet.

### Vaadin Grid

[vaadin.com/docs/latest/components/grid](https://vaadin.com/docs/latest/components/grid) — Apache-2. Virtualised web component. Item details + TreeGrid. Charts and Spreadsheet are **separate paid** Vaadin products.

### Ignite UI Grid

[infragistics.com/products/ignite-ui-react/react/components/grids/grid/overview](https://www.infragistics.com/products/ignite-ui-react/react/components/grids/grid/overview) — commercial. Row+column virtualisation. Tree Grid, Hierarchical Grid, grouping. Excel export + Excel-style filter. Charts are a separate family.

### PrimeReact DataTable / Ant Design Table / Element Plus Table

Design-system tables: MIT, DOM `<table>`, optional virtualisation, expand/tree, **no formula engine**, **no in-grid charts**. PrimeReact GitHub **archived 2026-06-28**; `primereact.dev/datatable` **404** — working archive [v9.primereact.org/datatable](https://v9.primereact.org/datatable/). Ant nested-table demo. Element Plus has `table-v2` for large data.

### react-data-grid (Comcast, formerly adazzle)

[github.com/Comcast/react-data-grid](https://github.com/Comcast/react-data-grid) — MIT. Row+column virtualisation. TreeDataGrid, fill-drag, copy/paste. **No formulas, no charts, no xlsx.**

### Material React Table

[material-react-table.com](https://www.material-react-table.com/) — MIT on TanStack Table + MUI + TanStack Virtual. Detail panel, expanding sub-rows, grouping. CSV. No charts/formulas.

### DataTables (jQuery)

[datatables.net](https://datatables.net/) — MIT core; Editor/Plus commercial. Progressive enhancement of an HTML table. Buttons: Excel/CSV/PDF. Not a calc engine. DataTables 3 in beta/nightly as of 2026.

### Highcharts Grid

[highcharts.com/products/grid](https://www.highcharts.com/products/grid/) — Lite free (own EULA); Pro commercial. HTML `<table>` + row virtualisation. Pro: sparklines + Highcharts Core. **No formulas.**

### Carbon DataTable

[carbondesignsystem.com/components/data-table/usage](https://carbondesignsystem.com/components/data-table/usage/) — Apache-2. Semantic HTML table. Expandable rows. Vendor **“When not to use… As a replacement for a spreadsheet application.”**

### FortuneSheet

[github.com/ruilisi/fortune-sheet](https://github.com/ruilisi/fortune-sheet) — MIT Luckysheet fork, canvas, React overlay, formulas, xlsx plugin. Charts/pivot still **roadmap**.

### HyperFormula (not a grid)

[hyperformula.handsontable.com](https://hyperformula.handsontable.com/) — GPLv3 or commercial. **Headless** spreadsheet engine, ~400 functions. No UI. Handsontable embeds it; other UIs can too.

### Canvas Datagrid

[canvas-datagrid.js.org](https://canvas-datagrid.js.org/) — canvas library; vendor: large datasets, custom cell renderers/editors, hierarchical rows / cell-in-cell (jsgrids + awesome-grid listings; homepage stresses performance + customisation).

### Cheetah Grid

[github.com/future-architect/cheetah-grid](https://github.com/future-architect/cheetah-grid) — MIT, “The fastest open-source data table for web.” Canvas `ListGrid`, frozen columns, check/button/image column types. Docs: [future-architect.github.io/cheetah-grid](https://future-architect.github.io/cheetah-grid/). Formulas/charts **not** in the README feature list.

### VisActor VTable

[visactor.io/vtable](https://visactor.io/vtable) — ByteDance canvas “multidimensional analysis table”; vendor: “Compared with traditional DOM table components, VTable mainly solves rendering and interactive performance problems… millions of data”; pivot / tree display / heatmaps. Analysis table, not Excel.

### Other notable (short)

| Name | URL | Note |
|---|---|---|
| w2ui grid | https://w2ui.com/web/docs/2.0/grid | MIT v2, no deps |
| Guriddo jqGrid | https://guriddo.net/?page_id=102666 | commercial; TreeGrid + Pivot |
| ParamQuery | https://paramquery.com/ | CE GPL-3; Pro spreadsheet/xlsx |
| Smart HTML Elements Grid | https://www.htmlelements.com/docs/grid-tree-grid/ | Grid is Enterprise; Community suite excludes Grid |
| Oracle JET `oj-table` / `oj-data-grid` | https://docs.oracle.com/en/middleware/developer-tools/jet/18.1/reference-api/oj-c.Table.html | table vs cell-oriented datagrid |
| Salesforce `lightning-datatable` / `tree-grid` | https://developer.salesforce.com/docs/platform/lightning-component-reference/guide/lightning-datatable.html | SLDS; tree-grid `_children` |
| Teable | https://teable.ai | Airtable-like **app**, not an embeddable grid SDK |
| Grist | https://www.getgrist.com/ | Apache-2 relational spreadsheet **app** |
| NocoDB / Baserow | https://nocodb.com/ · https://baserow.io/ | spreadsheet-DB apps |
| AntV S2 | listed on jsgrids.statico.io | analysis table (Ant Design promo) |
| TOAST UI Grid | listed on jsgrids.statico.io | NHN grid |
| ZingGrid | listed on jsgrids.statico.io | web component grid |
| Simple Table | https://www.simple-table.com/ | source-available TS grid (vendor comparison blog) |
| SvGrid | https://github.com/sv-grid/sv-grid | Svelte 5 MIT core + commercial pack |

---

## Visual reverse-engineering (what the sites actually look like)

Opened marketing/docs pages, not licensed demos under a paid key.

| Look | Who |
|---|---|
| **Excel workbook** (sheet tabs, formula bar, A1 headers, fill handle, frozen panes) | SpreadJS, Univer/Luckysheet, Handsontable (`main` theme), Jspreadsheet Pro, FortuneSheet |
| **Excel-ish data grid** (fill handle + range, no workbook) | AG Grid Enterprise, Glide, RevoGrid, Webix with `math`, SlickGrid spreadsheet examples, react-data-grid |
| **Material / Fluent dashboard table** | MUI X, Syncfusion, Kendo, DevExtreme, Carbon, Ant, Element Plus, Material React Table |
| **Headless / you bring the pixels** | TanStack Table |
| **Canvas full-bleed** (one surface, native scroll, overlay editor) | Glide, Cheetah, Canvas Datagrid, VTable, Univer sheet, SpreadJS |
| **Virtual DOM div grid** (inspect: repeating cell divs, not `<tr>`) | AG Grid, Tabulator, Handsontable, RevoGrid, MUI X, FlexGrid, Bryntum, Ext JS, Ignite |
| **Real `<table>`** | Grid.js, DataTables, Highcharts Grid Lite, Carbon, Ant/Element default, PrimeReact, Salesforce datatable |
| **Nested grid in an expander** | AG Grid Master/Detail, MUI Pro detail panel, Syncfusion master-detail, Kendo hierarchy, DevExtreme masterDetail, DHTMLX expander, Webix subview, Bryntum nested-grid, FlexGrid NestedGrids, RevoGrid Pro, FancyGrid Sub Grid |
| **Tree carets in first column** | AG Grid Tree Data, Tabulator dataTree, Handsontable NestedRows, MUI Pro treeData, Vaadin TreeGrid, FlexGrid TreeGrid, SVAR tree, Ant/Element tree, react-data-grid TreeDataGrid |
| **Sparkline / mini chart in a cell** | AG Grid Enterprise sparklines, Webix sparklines, Wijmo CellMaker, FancyGrid, Highcharts Grid Pro, Glide homepage, SpreadJS, Univer Pro |
| **Range chart from selection** | AG Grid Integrated Charts (Bundle); Syncfusion/Kendo “integrate Charts” as sibling widgets |

---

## oneGrid (this repo) — orientation only

Not a competitor write-up. From `ROADMAP.md` / packages: MIT canvas-2D grid with Fenwick variable row heights, DOM overlay for editors/renderers, tree + SSRM tree, master-detail, pivot, formula package + excel-compat import, sparklines package, range chart, xlsx package, Studio compile-and-apply editor. This survey exists so those choices can be compared to vendor-stated behaviour, not to auto-flip ROADMAP rows.

---

## Unreachable this pass

Attempted official URLs that 404’d, redirected into a generic shell, or returned empty. **Not invented.**

| URL | Product | What happened |
|---|---|---|
| https://mui.com/x/react-data-grid/components/charts-integration/ | MUI X | 404 |
| https://www.telerik.com/kendo-react-ui/components/grid/optimization/row-virtualization | KendoReact | 404 (feature still on free-vs-premium) |
| https://handsontable.com/docs/javascript-data-grid/installation/ | Handsontable | 404; intro + formula pages work |
| https://handsontable.com/docs/javascript-data-grid/clipboard/ | Handsontable | 404 (homepage still claims copy/paste) |
| https://gridjs.io/docs/index | Grid.js | 404; `/docs` and homepage work |
| https://gridjs.io/docs/examples/nested | Grid.js | 404 |
| https://gridjs.io/docs/examples/import-export | Grid.js | 404 |
| https://rv-grid.com/guide/types/tree | RevoGrid | 404 |
| https://rv-grid.com/guide/grouping | RevoGrid | 404 |
| https://rv-grid.com/guide/themes | RevoGrid | 404 |
| https://rv-grid.com/guide/export | RevoGrid | 404 |
| https://developer.mescius.com/wijmo/flexgrid-js | Wijmo | 404; use `flexgrid-javascript-data-grid` |
| https://primereact.dev/datatable/ | PrimeReact | 404; repo archived; use v9.primereact.org |
| https://docs.grid.glideapps.com/api/cells/sparkline | Glide | empty / unreachable |
| https://element-plus.org/en-US/component/table.html | Element Plus | empty body to fetcher; claims from same official URL via docs index |
| Bryntum a11y deep-link | Bryntum | redirected to generic docs; no WCAG sentence extracted |

**Not silently omitted, but not a drop-in JS grid widget:** Teable, Grist, NocoDB, Baserow, Airtable (apps). RealGrid (Korean-first enterprise canvas — listed on awesome-grid; English docs not fully verified this pass).

---

## Native / related (out of scope)

WinForms DataGridView, WPF DataGrid, Qt QTableView, Cocoa NSTableView, SwiftUI Table, .NET MAUI DataGrid, Flutter DataTable — desktop/mobile toolkits, not web libraries.

---

## Sources

Primary pages are linked inline. Discovery lists (not used as capability evidence): [jsgrids.statico.io/list](https://jsgrids.statico.io/list), [github.com/statico/jsgrids](https://github.com/statico/awesome-javascript-grids), [github.com/FancyGrid/awesome-grid](https://github.com/FancyGrid/awesome-grid).
