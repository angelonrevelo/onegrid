#!/usr/bin/env node
// Writes docs/roadmap-evidence.json from the mapping below.
// Each row: package (under packages/ or packages/adapters/), at least one
// symbol that appears in that package's src, and at least one test file
// path suffix the green-checker looks up with endsWith.

import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** @type {Record<string, { package: string, symbol: string[], test: string[] }>} */
const EVIDENCE = {
  'Canvas-2D renderer (10M rows, variable heights)': {
    package: 'core',
    symbol: ['class Grid', 'FenwickHeights'],
    test: ['__tests__/grid.test.ts'],
  },
  'Frozen columns': {
    package: 'core',
    symbol: ['frozenColumnCount'],
    test: ['__tests__/grid.test.ts'],
  },
  'Range selection (drag, shift-click, ctrl-click multi-range)': {
    package: 'core',
    symbol: ['SelectionModel'],
    test: ['__tests__/selection.test.ts'],
  },
  'Sort (single + multi)': {
    package: 'data',
    symbol: ['sortIndex'],
    test: ['__tests__/sort.test.ts'],
  },
  'Filter (quick + per-column rules)': {
    package: 'data',
    symbol: ['filterIndex'],
    test: ['__tests__/filter.test.ts'],
  },
  'Cell editing (F2/Enter/double-click/type-ahead)': {
    package: 'core',
    symbol: ['onCellEdit'],
    test: ['__tests__/grid.test.ts'],
  },
  'Clipboard copy/paste (TSV)': {
    package: 'core',
    symbol: ['onPaste'],
    test: ['__tests__/grid.test.ts'],
  },
  'Master-detail expandable rows': {
    package: 'core',
    symbol: ['getDetailContent', 'onToggleExpand'],
    test: ['__tests__/grid.test.ts'],
  },
  'Pinned top + bottom row sources': {
    package: 'core',
    symbol: ['pinnedTopRowSource'],
    test: ['__tests__/row-pinning.test.ts'],
  },
  'Column groups (header tree band)': {
    package: 'core',
    symbol: ['columnGroups'],
    test: ['__tests__/grid.test.ts'],
  },
  'Status bar (selection aggregates)': {
    package: 'core',
    symbol: ['statusBarEnabled'],
    test: ['__tests__/grid.test.ts'],
  },
  'Row grouping with aggregations': {
    package: 'data',
    symbol: ['groupRows'],
    test: ['__tests__/group.test.ts'],
  },
  'Pivot tables': {
    package: 'data',
    symbol: ['function pivot'],
    test: ['__tests__/pivot.test.ts'],
  },
  'CSV + XLSX export': {
    package: 'export',
    symbol: ['downloadCsv'],
    test: ['__tests__/csv.test.ts'],
  },
  'Tree data': {
    package: 'data',
    symbol: ['flattenTree'],
    test: ['__tests__/tree.test.ts'],
  },
  'Server-side hierarchical fetches': {
    package: 'ssrm',
    symbol: ['createSsrmTreeSource'],
    test: ['__tests__/tree-source.test.ts'],
  },
  'Set filter (distinct-values checkbox + counts)': {
    package: 'data',
    symbol: ['enumerateDistinct'],
    test: ['__tests__/distinct.test.ts'],
  },
  'Floating filter row': {
    package: 'core',
    symbol: ['floatingFiltersEnabled'],
    test: ['__tests__/grid.test.ts'],
  },
  'Column tool panel / sidebar': {
    package: 'react',
    symbol: ['ColumnToolPanel'],
    test: ['__tests__/react-adapter.test.ts'],
  },
  'Context menu': {
    package: 'core',
    symbol: ['ContextMenuTarget'],
    test: ['__tests__/grid.test.ts'],
  },
  'Drag-drop column reorder': {
    package: 'core',
    symbol: ['onColumnReorder'],
    test: ['__tests__/grid.test.ts'],
  },
  'Drag-drop row reorder': {
    package: 'core',
    symbol: ['onRowReorder'],
    test: ['__tests__/row-reorder.test.ts'],
  },
  'Row + column span (merged cells)': {
    package: 'core',
    symbol: ['resolveSpan'],
    test: ['__tests__/span.test.ts'],
  },
  'Sticky group rows': {
    package: 'core',
    symbol: ['stickyGroupRowsEnabled'],
    test: ['__tests__/grid.test.ts'],
  },
  'Loading / no-rows / skeleton overlays': {
    package: 'core',
    symbol: ['setLoading'],
    test: ['__tests__/overlay.test.ts'],
  },
  'Tooltip system': {
    package: 'core',
    symbol: ['tooltipEl'],
    test: ['__tests__/grid.test.ts'],
  },
  'Custom cell renderers': {
    package: 'core',
    symbol: ['RendererPool'],
    test: ['__tests__/renderer-pool.test.ts'],
  },
  'Editor variants': {
    package: 'core',
    symbol: ['createSelectEditor'],
    test: ['__tests__/editor-variants.test.ts'],
  },
  'Selection checkbox column': {
    package: 'react',
    symbol: ['createSelectionCheckboxColumn'],
    test: ['__tests__/react-adapter.test.ts'],
  },
  'Range chart': {
    package: 'chart',
    symbol: ['deriveChartData'],
    test: ['__tests__/chart.test.ts'],
  },
  'Sparklines in cells': {
    package: 'sparklines',
    symbol: ['drawSparkline'],
    test: ['__tests__/sparklines.test.ts'],
  },
  'Undo/redo': {
    package: 'undo',
    symbol: ['createUndoManager'],
    test: ['__tests__/undo.test.ts'],
  },
  'Light theme + density variants': {
    package: 'tokens',
    symbol: ['compileTheme'],
    test: ['__tests__/tokens.test.ts'],
  },
  'IME composition-aware editor commit': {
    package: 'core',
    symbol: ['editorIsComposing'],
    test: ['__tests__/grid.test.ts'],
  },
  'Cell editor validation': {
    package: 'core',
    symbol: ['ValidationResult'],
    test: ['__tests__/grid.test.ts'],
  },
  'Range fill-handle': {
    package: 'core',
    symbol: ['enableFillHandle'],
    test: ['__tests__/grid.test.ts'],
  },
  'Multi-select cell type with chips': {
    package: 'core',
    symbol: ['createMultiSelectEditor'],
    test: ['__tests__/multi-select.test.ts'],
  },
  'Column-group visibility manager': {
    package: 'core',
    symbol: ['applyGroupVisibility'],
    test: ['__tests__/column-group-visibility.test.ts'],
  },
  'Header text wrap': {
    package: 'core',
    symbol: ['wrapHeaderText'],
    test: ['__tests__/header-wrap.test.ts'],
  },
  'Page-level sticky header': {
    package: 'core',
    symbol: ['resolveStickyHeader'],
    test: ['__tests__/sticky-page-header.test.ts'],
  },
  'FDC3 broadcast + intent listener': {
    package: 'fdc3',
    symbol: ['createFdc3Bridge'],
    test: ['__tests__/fdc3.test.ts'],
  },
  'Mobile swipe-row actions': {
    package: 'touch',
    symbol: ['createSwipeRowController'],
    test: ['__tests__/swipe-row.test.ts'],
  },
  'Velocity-aware overscan': {
    package: 'core',
    symbol: ['velocitySmoothed'],
    test: ['__tests__/adaptive-overscan.test.ts'],
  },
  'GPU compute kernels (parallel reduce + filter mask)': {
    package: 'webgpu',
    symbol: ['gpuSumFloat32'],
    test: ['__tests__/cpu-fallbacks.test.ts'],
  },
  'Column virtualization': {
    package: 'core',
    symbol: ['visibleColumnRangeInBand'],
    test: ['__tests__/column-virtualization.test.ts'],
  },
  'Web Worker offload': {
    package: 'data-worker',
    symbol: ['createDataWorker'],
    test: ['__tests__/data-worker.test.ts'],
  },
  'Full WebGPU rendering path': {
    package: 'webgpu-render',
    symbol: ['createRenderScaffold'],
    test: ['__tests__/webgpu-render.test.ts'],
  },
  'Arrow IPC ingestion': {
    package: 'ssrm',
    symbol: ['ArrowDecoder'],
    test: ['__tests__/arrow.test.ts'],
  },
  'Differential dataflow': {
    package: 'dbsp',
    symbol: ['ZEntry'],
    test: ['__tests__/dbsp.test.ts'],
  },
  'Incremental redraw with dirty-rect protocol': {
    package: 'core',
    symbol: ['createDamageTracker'],
    test: ['__tests__/damage.test.ts'],
  },
  'SharedArrayBuffer for cross-thread viewport': {
    package: 'data-worker',
    symbol: ['ViewportBuffer'],
    test: ['__tests__/viewport-buffer.test.ts'],
  },
  'Adaptive overscan': {
    package: 'core',
    symbol: ['velocitySmoothed'],
    test: ['__tests__/adaptive-overscan.test.ts'],
  },
  'Aggregation-pushdown SSRM': {
    package: 'ssrm',
    symbol: ['aggregations'],
    test: ['__tests__/datasource.test.ts'],
  },
  'Worker-pool budget controller': {
    package: 'data-worker',
    symbol: ['createWorkerPool'],
    test: ['__tests__/worker-pool.test.ts'],
  },
  'BigInt-safe formula path': {
    package: 'formula',
    symbol: ['bigint'],
    test: ['__tests__/bigint.test.ts'],
  },
  'GPU hash-aggregate for group-by': {
    package: 'webgpu',
    symbol: ['gpuHashAggSumF32'],
    test: ['__tests__/hash-agg.test.ts'],
  },
  'Row grouping (aggregation-driven, not data-driven)': {
    package: 'data',
    symbol: ['groupRows'],
    test: ['__tests__/group.test.ts'],
  },
  'Tree data with lazy-load children': {
    package: 'data',
    symbol: ['loadChildren'],
    test: ['__tests__/tree.test.ts'],
  },
  'Nested grids inside detail panels': {
    package: 'core',
    symbol: ['onDetailUnmount'],
    test: ['__tests__/grid.test.ts'],
  },
  'Server-side tree': {
    package: 'ssrm',
    symbol: ['createSsrmTreeSource'],
    test: ['__tests__/tree-source.test.ts'],
  },
  'Recursive grouping + pivot mix': {
    package: 'data',
    symbol: ['groupPivot'],
    test: ['__tests__/group-pivot.test.ts'],
  },
  'Drag-drop reorder within tree / group': {
    package: 'core',
    symbol: ['resolveDrop'],
    test: ['__tests__/reorder-tree.test.ts'],
  },
  'Aggregation-aware group-row pin': {
    package: 'core',
    symbol: ['stickyGroupRowsEnabled'],
    test: ['__tests__/grid.test.ts'],
  },
  'Server-side row model (cursor + block cache)': {
    package: 'ssrm',
    symbol: ['createSsrmDataSource'],
    test: ['__tests__/cache.test.ts'],
  },
  'Drizzle adapter': {
    package: 'drizzle',
    symbol: ['createDrizzleDataSource'],
    test: ['__tests__/cursor.test.ts'],
  },
  'Kysely adapter': {
    package: 'kysely',
    symbol: ['createKyselyDataSource'],
    test: ['__tests__/datasource.test.ts'],
  },
  'DuckDB-WASM as backing engine': {
    package: 'duckdb',
    symbol: ['createDuckDbDataSource'],
    test: ['__tests__/sql.test.ts'],
  },
  'Raw Postgres adapter': {
    package: 'postgres',
    symbol: ['createPgDataSource'],
    test: ['__tests__/sql.test.ts'],
  },
  'MySQL adapter': {
    package: 'mysql',
    symbol: ['createMyDataSource'],
    test: ['__tests__/sql.test.ts'],
  },
  'SQLite adapter': {
    package: 'sqlite',
    symbol: ['createSqliteDataSource'],
    test: ['__tests__/sql.test.ts'],
  },
  'ClickHouse adapter': {
    package: 'clickhouse',
    symbol: ['createChDataSource'],
    test: ['__tests__/sql.test.ts'],
  },
  'MongoDB adapter': {
    package: 'mongo',
    symbol: ['createMongoDataSource'],
    test: ['__tests__/query.test.ts'],
  },
  'Snowflake adapter': {
    package: 'snowflake',
    symbol: ['createSnowflakeDataSource'],
    test: ['__tests__/sql.test.ts'],
  },
  'BigQuery adapter': {
    package: 'bigquery',
    symbol: ['createBigQueryDataSource'],
    test: ['__tests__/sql.test.ts'],
  },
  'Elasticsearch adapter': {
    package: 'elasticsearch',
    symbol: ['createElasticsearchDataSource'],
    test: ['__tests__/query.test.ts'],
  },
  'Prisma adapter': {
    package: 'prisma',
    symbol: ['createPrismaDataSource'],
    test: ['__tests__/query.test.ts'],
  },
  'Live updates / subscriptions': {
    package: 'ssrm',
    symbol: ['CdcAdapter'],
    test: ['__tests__/cdc.test.ts'],
  },
  'Optimistic mutations + conflict resolution': {
    package: 'ssrm',
    symbol: ['createOptimisticMutator'],
    test: ['__tests__/optimistic.test.ts'],
  },
  'Row-level security / column permissions': {
    package: 'permission',
    symbol: ['compilePolicyFilter'],
    test: ['__tests__/permission.test.ts'],
  },
  'Cross-database joins via DuckDB-WASM': {
    package: 'duckdb-join',
    symbol: ['executeJoinQuery'],
    test: ['__tests__/duckdb-join.test.ts'],
  },
  'Query builder UI': {
    package: 'query-builder',
    symbol: ['toFilterModel'],
    test: ['__tests__/query-builder.test.ts'],
  },
  'Keyset/cursor canonicalization in SSRM': {
    package: 'ssrm',
    symbol: ['encodeKeysetCursor'],
    test: ['__tests__/cursor.test.ts'],
  },
  'Aggregation-pushdown protocol': {
    package: 'ssrm',
    symbol: ['aggregations'],
    test: ['__tests__/datasource.test.ts'],
  },
  'Real-time row diff protocol': {
    package: 'ssrm',
    symbol: ['RowDiff'],
    test: ['__tests__/row-diff-tracker.test.ts'],
  },
  'Universal CDC adapter shape': {
    package: 'ssrm',
    symbol: ['CdcAdapter'],
    test: ['__tests__/cdc.test.ts'],
  },
  'Schema introspection helper': {
    package: 'introspect',
    symbol: ['columnsFromSchema'],
    test: ['__tests__/introspect.test.ts'],
  },
  'Formula engine (Adapton-style demand-driven recompute)': {
    package: 'formula',
    symbol: ['createFormulaEngine'],
    test: ['__tests__/incremental.test.ts'],
  },
  'Multi-framework adapters (React/Vue/Svelte/Solid/Angular/WC)': {
    package: 'react',
    symbol: ['useOneGrid'],
    test: ['__tests__/react-adapter.test.ts'],
  },
  'ORM-first data layer': {
    package: 'drizzle',
    symbol: ['createDrizzleDataSource'],
    test: ['__tests__/cursor.test.ts'],
  },
  'GPU compute kernels': {
    package: 'webgpu',
    symbol: ['gpuFilterMaskF32'],
    test: ['__tests__/cpu-fallbacks.test.ts'],
  },
  'Live ORM sync': {
    package: 'orm-sync',
    symbol: ['bindOrmSync'],
    test: ['__tests__/orm-sync.test.ts'],
  },
  'Time-travel / temporal data': {
    package: 'temporal',
    symbol: ['snapshotAt'],
    test: ['__tests__/temporal.test.ts'],
  },
  'Collaborative real-time editing': {
    package: 'crdt',
    symbol: ['bindYjsRows'],
    test: ['__tests__/crdt.test.ts'],
  },
  'AI integration': {
    package: 'ai',
    symbol: ['parseIntentHeuristic'],
    test: ['__tests__/ai.test.ts'],
  },
  'Notebook-style cells': {
    package: 'notebook',
    symbol: ['createNotebook'],
    test: ['__tests__/notebook.test.ts'],
  },
  'Plugin / extension API': {
    package: 'plugin-kit',
    symbol: ['PluginState'],
    test: ['__tests__/plugin-kit.test.ts'],
  },
  'Embeddable block': {
    package: 'embed',
    symbol: ['createBlock'],
    test: ['__tests__/embed.test.ts'],
  },
  'Linear range decomposition in the formula engine': {
    package: 'formula',
    symbol: ['rangeNodeCount'],
    test: ['__tests__/incremental.test.ts'],
  },
  'Spill-style dynamic arrays': {
    package: 'formula',
    symbol: ['SpillTracker'],
    test: ['__tests__/v1_1_wave17.test.ts'],
  },
  'Function library expansion': {
    package: 'formula',
    symbol: ['listFormulaFunctions'],
    test: ['__tests__/v1_1.test.ts'],
  },
  'Conditional formatting': {
    package: 'core',
    symbol: ['evaluateFormat'],
    test: ['__tests__/conditional-format.test.ts'],
  },
  'Schema introspection': {
    package: 'introspect',
    symbol: ['schemaFromSqlRows'],
    test: ['__tests__/introspect.test.ts'],
  },
  '@onegrid/migrate CLI': {
    package: 'migrate',
    symbol: ['transform'],
    test: ['__tests__/transforms.test.ts'],
  },
  'MCP server for the grid': {
    package: 'mcp',
    symbol: ['createMcpServer'],
    test: ['__tests__/mcp.test.ts'],
  },
  'DBSP-style derived view registration': {
    package: 'dbsp',
    symbol: ['defineView'],
    test: ['__tests__/view.test.ts'],
  },
  'Salsa-style reactivity substrate': {
    package: 'reactive',
    symbol: ['class Database'],
    test: ['__tests__/reactive.test.ts'],
  },
  'Accessibility conformance suite (CI-gated)': {
    package: 'a11y',
    symbol: ['LiveAnnouncer'],
    test: ['__tests__/live-announcer.test.ts'],
  },
  'Per-feature bundle slicing': {
    package: 'core',
    symbol: ['evaluateFormat'],
    test: ['__tests__/conditional-format.test.ts'],
  },
  'Range navigation history': {
    package: 'core',
    symbol: ['createNavigationHistory'],
    test: ['__tests__/navigation-history.test.ts'],
  },
  'Headless engine contract': {
    package: 'headless',
    symbol: ['HeadlessGrid'],
    test: ['__tests__/headless.test.ts'],
  },
  'Nested namespaced configuration schema': {
    package: 'core',
    symbol: ['defineGridOptions'],
    test: ['__tests__/options.test.ts'],
  },
  'i18n / l10n / RTL': {
    package: 'intl',
    symbol: ['getCollator'],
    test: ['__tests__/intl.test.ts'],
  },
  'Touch + mobile interaction': {
    package: 'touch',
    symbol: ['bindGestures'],
    test: ['__tests__/touch.test.ts'],
  },
  'Worker-boundary plugin trust tier': {
    package: 'worker-plugins',
    symbol: ['WorkerPluginHost'],
    test: ['__tests__/worker-plugins.test.ts'],
  },
  'Error boundaries + observability': {
    package: 'observability',
    symbol: ['createLogger'],
    test: ['__tests__/logger.test.ts'],
  },
  'Schema evolution at runtime': {
    package: 'core',
    symbol: ['diffSchema'],
    test: ['__tests__/schema-evolution.test.ts'],
  },
  'Backwards-compat / deprecation policy': {
    package: 'core',
    symbol: ['OG_DEPRECATED_FLAT_OPT'],
    test: ['__tests__/options.test.ts'],
  },
  '@onegrid/test adopter harness': {
    package: 'test',
    symbol: ['mountGrid'],
    test: ['__tests__/harness.test.ts'],
  },
  'Print + advanced export': {
    package: 'print',
    symbol: ['paginate'],
    test: ['__tests__/paginate.test.ts'],
  },
  'Cross-cell / row-level / sheet-level validators': {
    package: 'validate',
    symbol: ['createValidator'],
    test: ['__tests__/validate.test.ts'],
  },
  'Compile-time feature opt-in (sub-path exports)': {
    package: 'preset',
    symbol: ['resolveFeature'],
    test: ['__tests__/preset.test.ts'],
  },
  'Forced-colors / high-contrast support': {
    package: 'tokens',
    symbol: ['forcedColorsBlock'],
    test: ['__tests__/tokens.test.ts'],
  },
  'Studio table editor (DDL/DML/relationships)': {
    package: 'studio',
    symbol: ['compileDdl'],
    test: ['__tests__/studio.test.ts'],
  },
  'Feature presets + toggle registry': {
    package: 'preset',
    symbol: ['databaseEditorPreset'],
    test: ['__tests__/preset.test.ts'],
  },
  'Rust/WASM acceleration kernels': {
    package: 'wasm',
    symbol: ['createWasmBackend'],
    test: ['__tests__/wasm-binding.test.ts'],
  },
  'GPUI native host protocol': {
    package: 'native',
    symbol: ['encodeFrame'],
    test: ['__tests__/native.test.ts'],
  },
  'HTTP/fetch queryable (no in-process driver)': {
    package: 'postgres',
    symbol: ['createHttpQueryable'],
    test: ['__tests__/http.test.ts'],
  },
  'pgrx Postgres extension surface': {
    package: 'pgrx',
    symbol: ['compileExtensionSql'],
    test: ['__tests__/pgrx.test.ts'],
  },
};

const out = resolve(ROOT, 'docs/roadmap-evidence.json');
writeFileSync(out, JSON.stringify(EVIDENCE, null, 2) + '\n');
console.log(`wrote ${Object.keys(EVIDENCE).length} evidence entries → ${out}`);
