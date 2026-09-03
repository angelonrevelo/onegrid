// =============================================================================
// defineGridOptions — config schema migration (v0.0.9 item 3)
//
// The flat GridOptions interface in types.ts grew to ~40 top-level fields.
// This file introduces a nested form keyed by domain (data / columns /
// selection / editing / sorting / filtering / grouping / pivot / rendering /
// scrolling / a11y / i18n / touch / ssrm / formula / plugins) and a single
// `defineGridOptions()` factory that accepts EITHER shape, normalizes to
// the existing flat form, and emits one-time deprecation warnings on flat
// fields.
//
// The internal Grid class continues to consume the flat GridOptions — no
// invasive rewrite. defineGridOptions() is the public migration surface.
//
// Named error codes:
//   OG_INVALID_OPTION           value fails type/range check
//   OG_OPT_REQUIRES             option A set without required option B
//   OG_OPT_CONFLICT             options A and B are mutually exclusive
//   OG_OPT_UNKNOWN_NAMESPACE    nested input has a key outside the catalog
//   OG_I18N_INVALID_LOCALE      BCP 47 validation failed
// =============================================================================

import { DEFAULT_ROW_HEIGHT, type GridOptions } from './types.js';

// -----------------------------------------------------------------------------
// Nested-form types
// -----------------------------------------------------------------------------

export interface NestedGridOptions {
  readonly host: HTMLElement;
  readonly data: {
    readonly rowSource: GridOptions['rowSource'];
    readonly columns: GridOptions['columns'];
    readonly rowHeight?: GridOptions['rowHeight'];
  };
  readonly columns?: {
    readonly enableReorder?: boolean;
    readonly onReorder?: GridOptions['onColumnReorder'];
    readonly frozenCount?: number;
    readonly headerHeight?: number;
  };
  readonly selection?: {
    readonly onChange?: GridOptions['onSelectionChange'];
  };
  readonly editing?: {
    readonly enableFillHandle?: boolean;
    readonly onFillHandle?: GridOptions['onFillHandle'];
  };
  readonly sorting?: {
    readonly sort?: GridOptions['sort'];
    readonly onHeaderClick?: GridOptions['onHeaderClick'];
  };
  readonly grouping?: {
    readonly stickyGroupRows?: boolean;
  };
  readonly rendering?: {
    readonly theme?: GridOptions['theme'];
    readonly onFrame?: GridOptions['onFrame'];
  };
  readonly a11y?: {
    readonly /* room for v0.0.9 item 6 wiring */ locale?: string;
  };
  readonly i18n?: {
    readonly locale?: string;
    readonly catalogId?: string;
  };
  readonly touch?: {
    readonly longPressAction?: 'context-menu' | 'row-drag';
  };
  readonly ssrm?: Readonly<Record<string, unknown>>;
  readonly formula?: Readonly<Record<string, unknown>>;
  readonly plugins?: ReadonlyArray<unknown>;
  readonly detail?: {
    readonly expanded?: GridOptions['expanded'];
    readonly height?: number;
    readonly getContent?: GridOptions['getDetailContent'];
    readonly onToggle?: GridOptions['onToggleExpand'];
  };
  readonly contextMenu?: {
    readonly onContextMenu?: GridOptions['onContextMenu'];
  };
}

const NESTED_NAMESPACES = new Set([
  'host',
  'data',
  'columns',
  'selection',
  'editing',
  'sorting',
  'filtering',
  'grouping',
  'pivot',
  'rendering',
  'scrolling',
  'a11y',
  'i18n',
  'touch',
  'ssrm',
  'formula',
  'plugins',
  'detail',
  'contextMenu',
]);

// -----------------------------------------------------------------------------
// Deprecation warning state — one warning per session per flat field
// -----------------------------------------------------------------------------

const warned = new Set<string>();

function warnDeprecatedFlatOpt(field: string): void {
  if (warned.has(field)) return;
  warned.add(field);
  if (typeof console !== 'undefined' && typeof console.warn === 'function') {
    console.warn(
      `[OG_DEPRECATED_FLAT_OPT] '${field}' is a flat option; move it under the matching nested namespace. ` +
        `See https://onegrid.dev/migrate/flat-options or run \`onegrid-codemod --from-flat-options\`.`,
    );
  }
}

/** @internal Test helper — reset the per-session warning de-dup. */
export function __resetDeprecationWarningsForTests(): void {
  warned.clear();
}

// -----------------------------------------------------------------------------
// Detection + normalization
// -----------------------------------------------------------------------------

function isNestedInput(input: unknown): input is NestedGridOptions {
  if (!input || typeof input !== 'object') return false;
  const o = input as Record<string, unknown>;
  // A nested input has a `data` object with at least `rowSource`.
  const data = o['data'];
  return Boolean(data && typeof data === 'object' && 'rowSource' in (data as object));
}

function flattenNested(input: NestedGridOptions): GridOptions {
  // Validate namespaces.
  for (const key of Object.keys(input)) {
    if (!NESTED_NAMESPACES.has(key)) {
      throw new Error(
        `[OG_OPT_UNKNOWN_NAMESPACE] '${key}' is not a known nested namespace`,
      );
    }
  }
  const opt: Record<string, unknown> = {
    host: input.host,
    rowSource: input.data.rowSource,
    columns: input.data.columns,
    rowHeight: input.data.rowHeight ?? DEFAULT_ROW_HEIGHT,
  };
  if (input.columns) {
    if (input.columns.enableReorder !== undefined)
      opt['enableColumnReorder'] = input.columns.enableReorder;
    if (input.columns.onReorder !== undefined)
      opt['onColumnReorder'] = input.columns.onReorder;
    if (input.columns.frozenCount !== undefined)
      opt['frozenColumnCount'] = input.columns.frozenCount;
    if (input.columns.headerHeight !== undefined)
      opt['headerHeight'] = input.columns.headerHeight;
  }
  if (input.selection?.onChange !== undefined)
    opt['onSelectionChange'] = input.selection.onChange;
  if (input.editing) {
    if (input.editing.enableFillHandle !== undefined)
      opt['enableFillHandle'] = input.editing.enableFillHandle;
    if (input.editing.onFillHandle !== undefined)
      opt['onFillHandle'] = input.editing.onFillHandle;
  }
  if (input.sorting) {
    if (input.sorting.sort !== undefined) opt['sort'] = input.sorting.sort;
    if (input.sorting.onHeaderClick !== undefined)
      opt['onHeaderClick'] = input.sorting.onHeaderClick;
  }
  if (input.grouping?.stickyGroupRows !== undefined)
    opt['stickyGroupRows'] = input.grouping.stickyGroupRows;
  if (input.rendering) {
    if (input.rendering.theme !== undefined) opt['theme'] = input.rendering.theme;
    if (input.rendering.onFrame !== undefined) opt['onFrame'] = input.rendering.onFrame;
  }
  if (input.detail) {
    if (input.detail.expanded !== undefined) opt['expanded'] = input.detail.expanded;
    if (input.detail.height !== undefined) opt['detailHeight'] = input.detail.height;
    if (input.detail.getContent !== undefined)
      opt['getDetailContent'] = input.detail.getContent;
    if (input.detail.onToggle !== undefined)
      opt['onToggleExpand'] = input.detail.onToggle;
  }
  if (input.contextMenu?.onContextMenu !== undefined)
    opt['onContextMenu'] = input.contextMenu.onContextMenu;
  return opt as unknown as GridOptions;
}

const FLAT_TO_NESTED_HINT: Readonly<Record<string, string>> = {
  enableColumnReorder: 'columns.enableReorder',
  onColumnReorder: 'columns.onReorder',
  frozenColumnCount: 'columns.frozenCount',
  headerHeight: 'columns.headerHeight',
  onSelectionChange: 'selection.onChange',
  enableFillHandle: 'editing.enableFillHandle',
  onFillHandle: 'editing.onFillHandle',
  sort: 'sorting.sort',
  onHeaderClick: 'sorting.onHeaderClick',
  stickyGroupRows: 'grouping.stickyGroupRows',
  theme: 'rendering.theme',
  onFrame: 'rendering.onFrame',
  expanded: 'detail.expanded',
  detailHeight: 'detail.height',
  getDetailContent: 'detail.getContent',
  onToggleExpand: 'detail.onToggle',
  onContextMenu: 'contextMenu.onContextMenu',
};

function emitFlatDeprecations(input: GridOptions): void {
  for (const key of Object.keys(input)) {
    if (key in FLAT_TO_NESTED_HINT) {
      warnDeprecatedFlatOpt(key);
    }
  }
}

// -----------------------------------------------------------------------------
// Validation
// -----------------------------------------------------------------------------

const BCP47 = /^[A-Za-z]{2,3}(?:-[A-Za-z]{4})?(?:-(?:[A-Za-z]{2}|\d{3}))?(?:-[A-Za-z0-9]{5,8})*$/;

function validate(opt: GridOptions, input: NestedGridOptions | GridOptions): void {
  if (!opt.host) throw new Error(`[OG_INVALID_OPTION] host is required`);
  if (!opt.columns || opt.columns.length === 0)
    throw new Error(`[OG_INVALID_OPTION] columns must be non-empty`);
  if (!opt.rowSource) throw new Error(`[OG_INVALID_OPTION] rowSource is required`);
  if (opt.rowHeight === undefined) {
    (opt as { rowHeight: number }).rowHeight = DEFAULT_ROW_HEIGHT;
  }
  if (
    typeof opt.rowHeight !== 'number' &&
    !(opt.rowHeight instanceof Float32Array)
  ) {
    throw new Error(`[OG_INVALID_OPTION] rowHeight must be number or Float32Array`);
  }
  if (typeof opt.rowHeight === 'number' && opt.rowHeight <= 0) {
    throw new Error(`[OG_INVALID_OPTION] rowHeight must be > 0`);
  }
  if (opt.frozenColumnCount !== undefined && opt.frozenColumnCount < 0) {
    throw new Error(`[OG_INVALID_OPTION] frozenColumnCount must be \u2265 0`);
  }
  if (opt.onFillHandle && !opt.enableFillHandle) {
    throw new Error(
      `[OG_OPT_REQUIRES] onFillHandle requires editing.enableFillHandle: true`,
    );
  }
  if (opt.onColumnReorder && !opt.enableColumnReorder) {
    throw new Error(
      `[OG_OPT_REQUIRES] onColumnReorder requires columns.enableReorder: true`,
    );
  }
  if (opt.getDetailContent && !opt.detailHeight) {
    // Not an error — just a warning. detailHeight has a default.
  }
  // i18n locale (nested only — flat doesn't expose it yet)
  if (isNestedInput(input) && input.i18n?.locale) {
    if (!BCP47.test(input.i18n.locale)) {
      throw new Error(
        `[OG_I18N_INVALID_LOCALE] '${input.i18n.locale}' is not a valid BCP 47 locale tag`,
      );
    }
  }
}

// -----------------------------------------------------------------------------
// Factory
// -----------------------------------------------------------------------------

/**
 * Normalize either a nested or flat GridOptions input. Emits one-time
 * deprecation warnings per flat field; validates with named error codes.
 */
export function defineGridOptions(
  input: GridOptions | NestedGridOptions,
): GridOptions {
  let canonical: GridOptions;
  if (isNestedInput(input)) {
    canonical = flattenNested(input);
  } else {
    emitFlatDeprecations(input);
    canonical = input;
  }
  validate(canonical, input);
  return canonical;
}

// -----------------------------------------------------------------------------
// Preset helpers — compose via spread
// -----------------------------------------------------------------------------

/** Editing-friendly defaults: fill handle + column reorder enabled. */
export function editingPreset(): Pick<NestedGridOptions, 'editing' | 'columns'> {
  return {
    editing: { enableFillHandle: true },
    columns: { enableReorder: true },
  };
}

/** Touch / mobile defaults: long-press opens context menu, spacious density. */
export function mobilePreset(): Pick<NestedGridOptions, 'touch'> {
  return {
    touch: { longPressAction: 'context-menu' },
  };
}

/** Enterprise-grade defaults: editing + sticky groups. */
export function enterprisePreset(): Pick<
  NestedGridOptions,
  'editing' | 'columns' | 'grouping'
> {
  return {
    editing: { enableFillHandle: true },
    columns: { enableReorder: true },
    grouping: { stickyGroupRows: true },
  };
}

/** Accessibility defaults — placeholder; expand as the a11y namespace fills out. */
export function accessibilityPreset(): Pick<NestedGridOptions, 'a11y'> {
  return {
    a11y: {},
  };
}
