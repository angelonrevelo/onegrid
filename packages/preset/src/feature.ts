// =============================================================================
// @onegrid/preset/feature — the feature registry
//
// oneGrid's option surface is one flat interface with ~60 fields plus a
// nested namespace form. That is the right shape for the renderer and the
// wrong shape for a human deciding what kind of grid they want. This module
// is the translation layer: a closed union of the features oneGrid actually
// ships, what each one costs in options, and which ones cannot exist without
// each other.
//
// Design decisions:
//
//  - The union is DERIVED, not invented. Every member maps to a real field
//    on `GridOptions` (packages/core/src/types.ts), a real workspace package,
//    or a real registry in `@onegrid/plugin-kit`. `FEATURE_META[f].option` is
//    typed as `Partial<GridOptions>`, so a feature that stops existing in core
//    breaks this file at compile time instead of lying at runtime.
//
//  - Dependency is a real edge, not documentation. `pivot` without `grouping`
//    produces a pivot table whose group rows never render; `fillHandle`
//    without `editing` drags a handle that can never write. `resolveFeature`
//    takes the transitive closure so an adopter lists intent, not plumbing.
//
//  - A disabled dependency is an ERROR, not a silent override. If someone
//    asks for `fillHandle` while forbidding `editing`, both readings of the
//    request are wrong — enabling editing violates the ban, disabling the
//    fill handle ignores the ask. We throw and make the adopter choose.
//
//  - `toGridOptions` emits BOTH shapes because core's nested schema is a
//    strict subset of its flat one. `flat` is complete and is what you spread
//    into `new Grid({...})`; `nested` covers only the namespaces core's
//    `defineGridOptions` understands today. They are not interchangeable —
//    core rejects unknown namespaces, so you cannot mix them in one call.
//
// Named error codes:
//   OG_FEATURE_UNKNOWN        a name outside the FeatureName union
//   OG_FEATURE_DEP_CONFLICT   a feature needs a dependency that is banned
// =============================================================================

import type { GridOptions, NestedGridOptions } from '@onegrid/core';

/**
 * Every toggleable oneGrid feature. Closed union — adding a member here is
 * a breaking change to the presets that enumerate it.
 * @public
 */
export type FeatureName =
  | 'sort'
  | 'filter'
  | 'grouping'
  | 'pivot'
  | 'tree'
  | 'masterDetail'
  | 'editing'
  | 'clipboard'
  | 'fillHandle'
  | 'formula'
  | 'chart'
  | 'sparkline'
  | 'export'
  | 'find'
  | 'columnResize'
  | 'rowResize'
  | 'rowReorder'
  | 'columnReorder'
  | 'contextMenu'
  | 'toolPanel'
  | 'statusBar'
  | 'selectionCheckbox'
  | 'undo'
  | 'columnGroup'
  | 'pinnedRow'
  | 'overlay'
  | 'flashCell'
  | 'touch'
  | 'i18n'
  | 'serverSideRow'
  | 'duckdb';

/**
 * The namespaces of core's nested option form a preset is allowed to fill.
 * `host` and `data` are the adopter's — a preset knows nothing about which
 * element or which rows.
 * @public
 */
export type PresetNestedOption = Omit<NestedGridOptions, 'host' | 'data'>;

/**
 * A feature's complete entry in the registry.
 * @public
 */
export interface FeatureMeta {
  readonly name: FeatureName;
  /** One line on what turning this on gets you. */
  readonly summary: string;
  /** Features that must also be enabled. Transitive — see `resolveFeature`. */
  readonly dependency: readonly FeatureName[];
  /**
   * Workspace package the implementation lives in. `@onegrid/core` means the
   * code is in the always-bundled floor and the feature is free at the module
   * level (it still costs option surface and a few branches).
   */
  readonly package: string;
  /** Flat `GridOptions` fields this feature sets. */
  readonly option: Partial<GridOptions>;
  /** Nested-form fragment, where core's nested schema has a slot for it. */
  readonly nested: PresetNestedOption;
  /**
   * Option the adopter must supply themselves for the feature to do anything.
   * The grid never owns row data, so every mutating feature terminates in a
   * callback the adopter writes. Listing them turns "nothing happens" into a
   * checklist.
   */
  readonly requiredBinding: readonly string[];
}

// -----------------------------------------------------------------------------
// The registry
// -----------------------------------------------------------------------------

/**
 * Every feature, its dependency edges, its option payload, and the package it
 * is paid for from.
 * @public
 */
export const FEATURE_META: Readonly<Record<FeatureName, FeatureMeta>> = {
  sort: {
    name: 'sort',
    summary: 'Sort indicators in the header band; caller owns the SortModel.',
    dependency: [],
    package: '@onegrid/core',
    option: {},
    nested: {},
    requiredBinding: ['sorting.onHeaderClick'],
  },
  filter: {
    name: 'filter',
    summary: 'Per-column floating filter row pinned under the header.',
    dependency: [],
    package: '@onegrid/core',
    option: { floatingFilters: true },
    nested: {},
    requiredBinding: ['onFloatingFilterChange'],
  },
  grouping: {
    name: 'grouping',
    summary: 'Group header rows with chevron, indent, count and aggregates.',
    dependency: [],
    package: '@onegrid/data',
    option: { stickyGroupRows: true },
    nested: { grouping: { stickyGroupRows: true } },
    requiredBinding: ['getRowMeta', 'onToggleGroup'],
  },
  pivot: {
    // Pivot output IS grouped output — the pivot result set reaches the
    // renderer as group rows via getRowMeta. Without grouping the pivot
    // computes correctly and renders as an undifferentiated flat table.
    name: 'pivot',
    summary: 'Cross-tab aggregation over row / column / value axes.',
    dependency: ['grouping'],
    package: '@onegrid/data',
    option: {},
    nested: {},
    requiredBinding: ['rowSource'],
  },
  tree: {
    // Tree rows ride the same RowMeta channel and the same onToggleGroup
    // callback as groups (see RowTreeMeta in core/src/types.ts) — enabling
    // tree without grouping means wiring half a handler.
    name: 'tree',
    summary: 'Hierarchical parent/child rows with expand and collapse.',
    dependency: ['grouping'],
    package: '@onegrid/core',
    option: {},
    nested: {},
    requiredBinding: ['getRowMeta', 'onToggleGroup'],
  },
  masterDetail: {
    name: 'masterDetail',
    summary: 'Expandable rows with an adopter-rendered detail panel.',
    dependency: [],
    package: '@onegrid/core',
    option: { detailHeight: 200 },
    nested: { detail: { height: 200 } },
    requiredBinding: ['detail.getContent', 'detail.onToggle'],
  },
  editing: {
    name: 'editing',
    summary: 'In-cell editors: F2 / Enter / double-click / type-ahead.',
    dependency: [],
    package: '@onegrid/core',
    option: { editable: true },
    nested: {},
    requiredBinding: ['onCellEdit'],
  },
  clipboard: {
    // onPaste delivers a TSV rectangle the adopter must WRITE. A grid that
    // cannot be edited has nowhere to put it.
    name: 'clipboard',
    summary: 'Cmd/Ctrl+C copy and Cmd/Ctrl+V paste of TSV rectangles.',
    dependency: ['editing'],
    package: '@onegrid/core',
    option: {},
    nested: {},
    requiredBinding: ['onPaste'],
  },
  fillHandle: {
    name: 'fillHandle',
    summary: 'Drag the selection corner to extend a range; adopter fills it.',
    dependency: ['editing'],
    package: '@onegrid/core',
    option: { enableFillHandle: true },
    nested: { editing: { enableFillHandle: true } },
    requiredBinding: ['editing.onFillHandle'],
  },
  formula: {
    name: 'formula',
    summary: 'Spreadsheet formula engine — 41 base functions, incremental.',
    dependency: ['editing'],
    package: '@onegrid/formula',
    option: {},
    nested: { formula: {} },
    requiredBinding: [],
  },
  chart: {
    name: 'chart',
    summary: 'Range charts bound live to a selected cell rectangle.',
    dependency: [],
    package: '@onegrid/chart',
    option: {},
    nested: {},
    requiredBinding: [],
  },
  sparkline: {
    name: 'sparkline',
    summary: 'In-cell line / bar / win-loss micro-charts.',
    dependency: [],
    package: '@onegrid/sparklines',
    option: {},
    nested: {},
    requiredBinding: [],
  },
  export: {
    name: 'export',
    summary: 'CSV / TSV / XLSX / clipboard-HTML exporters.',
    dependency: [],
    package: '@onegrid/export',
    option: {},
    nested: {},
    requiredBinding: [],
  },
  find: {
    name: 'find',
    summary: 'Ctrl/Cmd+F find toolbar with in-viewport match highlighting.',
    dependency: [],
    package: '@onegrid/core',
    option: { enableFind: true },
    nested: {},
    requiredBinding: ['onReplace'],
  },
  columnResize: {
    name: 'columnResize',
    summary: 'Drag a column header edge to resize.',
    dependency: [],
    package: '@onegrid/core',
    option: { enableColumnResize: true },
    nested: {},
    requiredBinding: ['onColumnResize'],
  },
  rowResize: {
    name: 'rowResize',
    summary: 'Drag the bottom edge of a data cell to resize the row.',
    dependency: [],
    package: '@onegrid/core',
    option: { enableRowResize: true },
    nested: {},
    requiredBinding: ['onRowResize'],
  },
  rowReorder: {
    name: 'rowReorder',
    summary: 'Drag a row by its handle column to a new position.',
    dependency: [],
    package: '@onegrid/core',
    option: {},
    nested: {},
    // rowDragColumnId names an adopter column, so there is no default worth
    // guessing — omitting it is how core keeps row reorder off by default.
    requiredBinding: ['onRowReorder', 'rowDragColumnId'],
  },
  columnReorder: {
    name: 'columnReorder',
    summary: 'Drag column headers left and right to reorder.',
    dependency: [],
    package: '@onegrid/core',
    option: { enableColumnReorder: true },
    nested: { columns: { enableReorder: true } },
    requiredBinding: ['columns.onReorder'],
  },
  contextMenu: {
    name: 'contextMenu',
    summary: 'Right-click / long-press target reporting; adopter draws the menu.',
    dependency: [],
    package: '@onegrid/core',
    option: {},
    nested: {},
    requiredBinding: ['contextMenu.onContextMenu'],
  },
  toolPanel: {
    // The tool panel's whole job is reordering and hiding columns, which is
    // the same capability columnReorder exposes by drag.
    name: 'toolPanel',
    summary: 'Side panel listing columns with show / hide and reorder controls.',
    dependency: ['columnReorder'],
    package: '@onegrid/react',
    option: {},
    nested: {},
    requiredBinding: [],
  },
  statusBar: {
    name: 'statusBar',
    summary: 'Status band summarizing the selection: count, min, max, sum, avg.',
    dependency: [],
    package: '@onegrid/core',
    option: { statusBar: true },
    nested: {},
    requiredBinding: [],
  },
  selectionCheckbox: {
    name: 'selectionCheckbox',
    summary: 'Leading checkbox column plus a header select-all control.',
    dependency: [],
    package: '@onegrid/react',
    option: {},
    nested: {},
    requiredBinding: ['selection.onChange'],
  },
  undo: {
    // Undo inverts mutations. With nothing mutable there is nothing to invert.
    name: 'undo',
    summary: 'Cmd+Z / Cmd+Shift+Z over grouped inverse-pair mutations.',
    dependency: ['editing'],
    package: '@onegrid/undo',
    option: {},
    nested: {},
    requiredBinding: [],
  },
  columnGroup: {
    name: 'columnGroup',
    summary: 'Second header band spanning adjacent columns under one label.',
    dependency: [],
    package: '@onegrid/core',
    option: {},
    nested: {},
    requiredBinding: ['columnGroups'],
  },
  pinnedRow: {
    name: 'pinnedRow',
    summary: 'Read-only bands pinned above and below the scrolling rows.',
    dependency: [],
    package: '@onegrid/core',
    option: { pinnedRowHeight: 28 },
    nested: {},
    requiredBinding: ['pinnedTopRowSource'],
  },
  overlay: {
    name: 'overlay',
    summary: 'Loading spinner and no-rows overlays over the data band.',
    dependency: [],
    package: '@onegrid/core',
    option: { loading: false },
    nested: {},
    requiredBinding: [],
  },
  flashCell: {
    name: 'flashCell',
    summary: 'Fade-out tint on changed cells, driven by Grid.flashCell().',
    dependency: [],
    package: '@onegrid/core',
    option: { flash: { durationMs: 600 } },
    nested: {},
    requiredBinding: [],
  },
  touch: {
    name: 'touch',
    summary: 'Gesture recognizer, touch CSS and VirtualKeyboard adaptation.',
    dependency: [],
    package: '@onegrid/touch',
    option: {},
    nested: { touch: { longPressAction: 'context-menu' } },
    requiredBinding: [],
  },
  i18n: {
    name: 'i18n',
    summary: 'Locale-aware number and date formatting, ICU messages, RTL.',
    dependency: [],
    package: '@onegrid/intl',
    option: {},
    nested: { i18n: {} },
    requiredBinding: ['i18n.locale'],
  },
  serverSideRow: {
    name: 'serverSideRow',
    summary: 'Block-paged server-side row model with LRU cache and cursors.',
    dependency: [],
    package: '@onegrid/ssrm',
    option: {},
    nested: { ssrm: {} },
    requiredBinding: ['rowSource'],
  },
  duckdb: {
    name: 'duckdb',
    summary: 'DuckDB-WASM query backend for large in-browser datasets.',
    dependency: [],
    package: '@onegrid/duckdb',
    option: {},
    nested: {},
    requiredBinding: ['rowSource'],
  },
};

/**
 * Every feature name, in registry order. Derived from `FEATURE_META` so it
 * can never drift from it.
 * @public
 */
export const FEATURE_NAME: readonly FeatureName[] = Object.keys(
  FEATURE_META,
) as FeatureName[];

/**
 * Type guard for untrusted input — a query string, a saved layout, a config
 * file — before it reaches `resolveFeature`.
 * @public
 */
export function isFeatureName(value: unknown): value is FeatureName {
  return typeof value === 'string' && Object.hasOwn(FEATURE_META, value);
}

// -----------------------------------------------------------------------------
// Errors
// -----------------------------------------------------------------------------

/**
 * Thrown when the dependency closure of a requested feature set reaches a
 * feature the same request explicitly disabled. Carries the full chain so the
 * message can name the intermediate hop rather than just the endpoints.
 * @public
 */
export class FeatureDependencyError extends Error {
  readonly code = 'OG_FEATURE_DEP_CONFLICT';
  /** The feature whose closure hit the wall. */
  readonly feature: FeatureName;
  /** The disabled feature it needs. */
  readonly dependency: FeatureName;
  /** Path from a requested feature to `dependency`, inclusive of both ends. */
  readonly chain: readonly FeatureName[];

  constructor(
    feature: FeatureName,
    dependency: FeatureName,
    chain: readonly FeatureName[],
  ) {
    super(
      `[OG_FEATURE_DEP_CONFLICT] '${feature}' requires '${dependency}', which this ` +
        `request explicitly disables` +
        (chain.length > 2 ? ` (via ${chain.join(' -> ')})` : '') +
        `. Either drop '${dependency}' from \`disable\` or drop ` +
        `'${chain[0] ?? feature}' from \`enable\`.`,
    );
    this.name = 'FeatureDependencyError';
    this.feature = feature;
    this.dependency = dependency;
    this.chain = chain;
  }
}

// -----------------------------------------------------------------------------
// Resolution
// -----------------------------------------------------------------------------

/**
 * What to turn on, and what must stay off no matter what asks for it.
 * @public
 */
export interface FeatureRequest {
  readonly enable: readonly FeatureName[];
  readonly disable?: readonly FeatureName[];
}

/**
 * The transitive closure of a request.
 * @public
 */
export interface ResolvedFeature {
  /** Everything that ends up on: requested plus implied. */
  readonly feature: ReadonlySet<FeatureName>;
  /** The subset nobody asked for — pulled in purely by a dependency edge.
   *  Surface this in a "why is my bundle this big" report. */
  readonly implied: ReadonlySet<FeatureName>;
  /** Exactly what was requested, deduped, in the order given. */
  readonly requested: readonly FeatureName[];
  /** The explicit deny list that was honoured. */
  readonly disabled: ReadonlySet<FeatureName>;
}

function assertKnown(name: FeatureName, where: string): void {
  if (!Object.hasOwn(FEATURE_META, name)) {
    throw new Error(
      `[OG_FEATURE_UNKNOWN] '${String(name)}' is not a oneGrid feature (in ${where}). ` +
        `Known: ${FEATURE_NAME.join(', ')}`,
    );
  }
}

/**
 * Expand a feature request into its transitive dependency closure.
 *
 * Breadth-first from the requested set, following `FEATURE_META[f].dependency`.
 * Every queued node carries the path that reached it, so a conflict three hops
 * deep reports the route rather than an unexplained pairing.
 *
 * Throws {@link FeatureDependencyError} if the closure reaches a disabled
 * feature — including the degenerate case of a feature that is both enabled
 * and disabled in the same request.
 * @public
 */
export function resolveFeature(
  input: readonly FeatureName[] | FeatureRequest,
): ResolvedFeature {
  const request: FeatureRequest = Array.isArray(input)
    ? { enable: input as readonly FeatureName[] }
    : (input as FeatureRequest);

  const disabled = new Set<FeatureName>(request.disable ?? []);
  for (const name of disabled) assertKnown(name, 'disable');

  const requested: FeatureName[] = [];
  const seen = new Set<FeatureName>();
  for (const name of request.enable) {
    assertKnown(name, 'enable');
    if (seen.has(name)) continue;
    seen.add(name);
    requested.push(name);
  }

  const feature = new Set<FeatureName>();
  const implied = new Set<FeatureName>();
  const queue: { readonly name: FeatureName; readonly chain: readonly FeatureName[] }[] =
    requested.map((name) => ({ name, chain: [name] }));

  while (queue.length > 0) {
    const entry = queue.shift()!;
    if (disabled.has(entry.name)) {
      throw new FeatureDependencyError(
        entry.chain[entry.chain.length - 2] ?? entry.name,
        entry.name,
        entry.chain,
      );
    }
    if (feature.has(entry.name)) continue;
    feature.add(entry.name);
    if (!seen.has(entry.name)) implied.add(entry.name);
    for (const dep of FEATURE_META[entry.name].dependency) {
      queue.push({ name: dep, chain: [...entry.chain, dep] });
    }
  }

  return { feature, implied, requested, disabled };
}

// -----------------------------------------------------------------------------
// Option projection
// -----------------------------------------------------------------------------

/**
 * The option payload a feature set implies.
 * @public
 */
export interface PresetGridOption {
  /**
   * Complete flat `GridOptions` patch. Spread it next to your `host`,
   * `columns`, `rowSource` and `rowHeight` and you have a working grid.
   */
  readonly flat: Partial<GridOptions>;
  /**
   * The same intent in core's nested namespaces — a strict SUBSET, because
   * the nested schema has no home yet for `statusBar`, `enableFind`,
   * `enableColumnResize` and friends. Do not merge `flat` into a nested call:
   * `defineGridOptions` throws `OG_OPT_UNKNOWN_NAMESPACE` on any top-level key
   * outside its namespace catalog.
   */
  readonly nested: PresetNestedOption;
  /** Union of every enabled feature's `requiredBinding`, deduped and sorted. */
  readonly requiredBinding: readonly string[];
}

/** Namespaces are one level deep in core's nested form, so a one-level object
 *  merge is exactly right here — no general deep merge needed. */
function mergeNested(
  target: Record<string, unknown>,
  source: Readonly<Record<string, unknown>>,
): void {
  for (const [key, value] of Object.entries(source)) {
    const prior = target[key];
    if (
      prior !== null &&
      typeof prior === 'object' &&
      value !== null &&
      typeof value === 'object'
    ) {
      target[key] = { ...prior, ...value };
    } else {
      target[key] = value;
    }
  }
}

/**
 * Project a feature set onto the options that actually turn it on.
 *
 * Accepts a bare feature list, a {@link FeatureRequest}, or an already
 * resolved set, so callers never have to remember whether closure has
 * happened yet.
 * @public
 */
export function toGridOptions(
  input: readonly FeatureName[] | FeatureRequest | ResolvedFeature,
): PresetGridOption {
  const resolved: ResolvedFeature =
    !Array.isArray(input) && (input as ResolvedFeature).feature instanceof Set
      ? (input as ResolvedFeature)
      : resolveFeature(input as readonly FeatureName[] | FeatureRequest);

  const flat: Record<string, unknown> = {};
  const nested: Record<string, unknown> = {};
  const binding = new Set<string>();

  // Registry order, not request order — the output must be a pure function of
  // the SET, so two requests differing only in ordering produce identical
  // objects and cache keys stay stable.
  for (const name of FEATURE_NAME) {
    if (!resolved.feature.has(name)) continue;
    const meta = FEATURE_META[name];
    Object.assign(flat, meta.option);
    mergeNested(nested, meta.nested);
    for (const b of meta.requiredBinding) binding.add(b);
  }

  return {
    flat,
    nested,
    requiredBinding: [...binding].sort(),
  };
}
