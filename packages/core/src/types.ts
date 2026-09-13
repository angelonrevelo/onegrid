// =============================================================================
// Core types for @onegrid/core.
// =============================================================================

import type { SelectionSnapshot } from './selection';
import type { AggregationModel, FilterModel, PivotModel, SortModel } from '@onegrid/protocol';

/**
 * Per-column configuration. Width is the only required visual property; the
 * rest is callbacks the renderer invokes per cell.
 */
/**
 * Empty interface adopters augment via TypeScript declaration merging
 * to add strongly-typed per-column context (zero runtime cost):
 *
 * ```ts
 * declare module '@onegrid/core' {
 *   interface ColumnMeta {
 *     glAccount?: string;
 *     analyticsTag?: 'pii' | 'public';
 *   }
 * }
 * ```
 *
 * `column.meta.glAccount` then type-checks across the codebase.
 */
export interface ColumnMeta {}

/**
 * Empty interface adopters augment via TypeScript declaration merging
 * to add strongly-typed grid-instance context:
 *
 * ```ts
 * declare module '@onegrid/core' {
 *   interface GridMeta {
 *     tenantId: string;
 *     featureFlags: ReadonlyArray<string>;
 *   }
 * }
 * ```
 */
export interface GridMeta {}

export interface ColumnDef<TValue = unknown> {
  readonly id: string;
  readonly width: number;
  readonly displayName?: string;
  readonly minWidth?: number;
  readonly maxWidth?: number;
  readonly pinned?: 'left' | 'right';
  /** Adopter-augmented context (declaration-merged via the
   *  `ColumnMeta` interface above). Zero runtime cost; carries
   *  strongly-typed custom fields. */
  readonly meta?: ColumnMeta;
  /** Formatter the renderer invokes to convert a cell value to display text. */
  readonly format?: (value: TValue, rowIndex: number) => string;
  /** Optional per-cell foreground color. */
  readonly color?: (value: TValue, rowIndex: number) => string | undefined;
  /** Optional per-cell background color. */
  readonly background?: (value: TValue, rowIndex: number) => string | undefined;
  /** Optional editor validator. Sync result keeps editor instant on
   *  every input keystroke; async result is awaited at commit time
   *  with AbortController so a fast-typing user never sees stale
   *  validation. Rejection keeps the editor open and announces the
   *  message via the live region. */
  readonly validate?: (
    value: string,
    context: ValidationContext,
  ) => ValidationResult | Promise<ValidationResult>;
  /** Custom DOM-based cell renderer. When set, the canvas paints a
   *  blank cell background and the rendered DOM element is positioned
   *  in the overlay layer above the canvas. The grid pools instances
   *  per renderer id so framework reactivity (React/Vue/Svelte/Solid)
   *  is preserved across scroll — only on-screen cells are mounted,
   *  off-screen cells return to the pool with their state reset. */
  readonly renderer?: CellRenderer;
  /** Custom editor variant. Default: a single-line text input. Use
   *  this to swap in a `<select>` dropdown, date picker, large-text
   *  textarea, autocomplete, multi-select, or any custom widget that
   *  implements the `CellEditor` interface. */
  readonly editor?: CellEditor;
  /** Optional tooltip content for cells in this column. String content
   *  renders as plain text; HTMLElement content renders as-is (use for
   *  rich tooltips like multi-line summaries or status indicators).
   *  Returning null/undefined suppresses the tooltip for that cell.
   *  Tooltips appear after a hover delay and dismiss on pointer-leave,
   *  Escape, or scroll. */
  readonly tooltip?: (
    value: TValue,
    rowIndex: number,
  ) => string | HTMLElement | null | undefined;
}

/** Per-cell render context handed to a CellRenderer's mount/update/
 *  reset hooks. Same shape as the `format` / `color` callbacks but
 *  with the rendered DOM element in scope so consumers can mutate it. */
export interface CellRenderContext {
  readonly value: unknown;
  readonly rowIndex: number;
  readonly columnId: string;
}

/**
 * Custom cell renderer interface.
 *
 * Renderers are framework-agnostic and DOM-only at this layer. The
 * core grid never instantiates React / Vue / Svelte / Solid components
 * directly — framework adapters wrap their component-per-cell pattern
 * in a CellRenderer and pass it through ColumnDef.renderer.
 *
 * Lifecycle:
 *   1. mount()   — produce a fresh DOM node when the pool is empty
 *                  for this renderer's id. Run once per pooled instance.
 *   2. update()  — called every frame the cell is visible, with the
 *                  current value/row/col. Should be cheap; do not
 *                  re-create the framework root inside.
 *   3. reset()   — called when the cell scrolls out of view and the
 *                  instance returns to the pool. Clear focus, transient
 *                  state, listeners that reference the previous cell.
 */
export interface CellRenderer {
  /** Stable identifier — used as the pool key. Two renderers with the
   *  same `id` share their pooled instances; with different ids each
   *  has its own pool. Pick something descriptive: `"status-pill"`,
   *  `"sparkline-line"`, etc. */
  readonly id: string;
  readonly mount: (context: CellRenderContext) => HTMLElement;
  readonly update: (el: HTMLElement, context: CellRenderContext) => void;
  readonly reset?: (el: HTMLElement) => void;
  /**
   * v1.2 — optional content-width measurement for auto-size-column.
   * Returns the natural pixel width the renderer would prefer for the
   * given value (e.g., text width + padding). When set, the grid's
   * `autoSizeColumn(id)` path consults this to derive the new
   * `column.width`. Defaults to the canvas `measureText` over
   * `column.format?.(value)` when omitted.
   */
  readonly measure?: (context: CellRenderContext) => number;
  /**
   * v1.2 — optional per-cell theme overrides. Returns a partial
   * GridTheme that overlays the grid-wide theme for THIS cell only.
   * Resolved at paint time; lets a plugin compose grid-wide visual
   * overrides without CSS-recalc cost (e.g., highlight every cell
   * matching a query without injecting a class). Return `undefined`
   * for cells that don't need an override (the common case).
   */
  readonly themeOverride?: (
    context: CellRenderContext,
  ) => Partial<GridTheme> | undefined;
}

/**
 * Per-edit context handed to a CellEditor's mount() hook. Same shape
 * as the renderer context plus the initial text (for type-ahead) and
 * the formatted display text the user was looking at before they
 * started editing.
 */
export interface CellEditContext {
  readonly value: unknown;
  readonly rowIndex: number;
  readonly columnId: string;
  readonly displayText: string;
  /** Set when the editor was opened by typing a printable key on a
   *  selected cell. Editors may want to use this as the initial value
   *  instead of `displayText`. */
  readonly initialText?: string;
}

/**
 * Custom cell editor variant.
 *
 * Variants compose onto the existing validated editor pipeline: the
 * grid handles positioning, focus management, IME composition, paste,
 * Escape-to-cancel, Enter-to-commit, and validator dispatch. The
 * variant just describes how to build + read the input widget.
 *
 * Examples (shipped as helpers in @onegrid/core/editing):
 *   createSelectEditor({ options })         — <select>
 *   createDateEditor()                      — <input type="date">
 *   createTextareaEditor()                  — multi-line <textarea>
 *
 * Lifecycle:
 *   1. mount() — called once per beginEdit. Return a fresh instance.
 *   2. instance.focus() — called by the grid after positioning.
 *   3. instance.getValue() — called on commit to extract the string.
 *   4. instance.destroy?.() — called when the editor closes (commit
 *      or cancel). The grid removes the element itself; this is for
 *      listener cleanup or framework root unmount.
 */
export interface CellEditor {
  readonly id: string;
  readonly mount: (context: CellEditContext) => CellEditorInstance;
}

export interface CellEditorInstance {
  /** Root DOM element the grid will position over the cell. */
  readonly element: HTMLElement;
  /** Read the current edit value as a string for commit. */
  readonly getValue: () => string;
  /** Focus the inner widget. Called by the grid after mount. */
  readonly focus: () => void;
  /** Optional teardown — listeners, framework roots, etc. */
  readonly destroy?: () => void;
}

export interface ValidationContext {
  readonly rowIndex: number;
  readonly columnId: string;
  /** Phase the validator is being invoked in. `input` runs on every
   *  keystroke (debounced); `commit` runs when the user attempts to
   *  finalize the edit. Async validators may want to skip `input`
   *  and only run on `commit` to avoid unnecessary network traffic. */
  readonly phase: 'input' | 'commit';
}

export type ValidationResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      /** Human-readable error message rendered in the editor's
       *  error bubble and announced via aria-live. */
      readonly message: string;
      readonly severity?: 'error' | 'warning';
    };

/**
 * Synchronous random-access row reader. The renderer calls `getCell` once per
 * visible cell per frame; allocations and async operations on this hot path
 * will tank FPS. RowSources backed by remote data (SSRM) cache blocks ahead
 * of time and serve cell reads from local typed arrays.
 */
export interface RowSource {
  readonly numRows: number;
  readonly getCell: (rowIndex: number, columnId: string) => unknown;
}

/**
 * Per-frame statistics emitted via `onFrame`. Same shape exposed in the
 * playground's live meter.
 */
export interface FrameStats {
  readonly fps: number;
  readonly visibleRowStart: number;
  readonly visibleRowEnd: number;
  readonly drawCellsPerFrame: number;
  readonly drawDurationMs: number;
}

/**
 * Aggregate metrics for a benchmark scenario.
 */
export interface MetricsSnapshot {
  readonly windowMs: number;
  readonly frameCount: number;
  readonly fpsAvg: number;
  readonly intervalMsP50: number;
  readonly intervalMsP95: number;
  readonly intervalMsP99: number;
  readonly drawMsP50: number;
  readonly drawMsP95: number;
  readonly drawMsP99: number;
  readonly longFramesGt16: number;
  readonly longFramesGt33: number;
  readonly longFramesGt50: number;
  readonly scrollPxTotal: number;
  readonly cellsPerFrameAvg: number;
  readonly heapUsedBytes?: number;
}

/** Theme tokens consumed by the canvas renderer. */
export interface GridTheme {
  readonly background: string;
  readonly altRowBackground: string;
  readonly headerBackground: string;
  readonly text: string;
  readonly mutedText: string;
  readonly border: string;
  readonly fontFamily: string;
  readonly fontSize: number;
  /** Background for group-header rows (row grouping / tree). Optional;
   *  falls back to `headerBackground` when unset, so existing themes are
   *  unchanged. Lets light themes avoid a hardcoded dark group band. */
  readonly groupBackground?: string;
}

/** Discriminated union describing what the user right-clicked. The
 *  consumer's onContextMenu handler reads `kind` and reaches for the
 *  fields appropriate for that variant. */
export type ContextMenuTarget =
  | {
      readonly kind: 'cell';
      readonly rowIndex: number;
      readonly columnId: string;
      readonly clientX: number;
      readonly clientY: number;
    }
  | {
      readonly kind: 'header';
      readonly columnId: string;
      readonly clientX: number;
      readonly clientY: number;
    }
  | {
      readonly kind: 'empty';
      readonly clientX: number;
      readonly clientY: number;
    };

export const DEFAULT_THEME: GridTheme = {
  background: '#0b0d10',
  altRowBackground: '#11141a',
  headerBackground: '#1b1f26',
  text: '#e7e9ec',
  mutedText: '#8b929c',
  border: '#1c2027',
  fontFamily: 'ui-sans-serif, system-ui, -apple-system, sans-serif',
  fontSize: 13,
};

/**
 * Comfortable-density row height used when the adopter omits `rowHeight`.
 * 32px matches `@onegrid/tokens` comfortable density and the value booted
 * had to discover by reading types rather than docs.
 * @public
 */
export const DEFAULT_ROW_HEIGHT = 32;

export interface GridOptions {
  /** DOM element to mount into. */
  readonly host: HTMLElement;
  /** Column definitions, left-to-right in display order. */
  readonly columns: ReadonlyArray<ColumnDef>;
  /** Synchronous row reader. */
  readonly rowSource: RowSource;
  /**
   * Per-row heights. A single number is applied uniformly. Omitted →
   * {@link DEFAULT_ROW_HEIGHT} (32). A missing value used to be a type
   * error with no runtime default, which is the first thing a new
   * consumer (booted included) hit.
   */
  readonly rowHeight?: number | Float32Array;
  /** Adopter-augmented grid-instance context (declaration-merged via
   *  the `GridMeta` interface). Zero runtime cost. */
  readonly meta?: GridMeta;
  /** Allow dragging the right edge of a column header to resize.
   *  Default: false. Resize respects `column.minWidth` and `column.maxWidth`
   *  if set. Emits `onColumnResize(columnId, newWidth, finalCommit)`
   *  during the drag (finalCommit=false) and on drop (true). */
  readonly enableColumnResize?: boolean;

  /** Wave 24. Enable row drag-to-resize. With no row-header gutter today,
   *  the hit-zone lives in the bottom 4–6 px of any data cell. Adopters
   *  who want a "drag row borders" UX flip this on; otherwise it stays
   *  off so the resize handle doesn't compete with cell-click. */
  readonly enableRowResize?: boolean;
  readonly onRowResize?: (
    rowIndex: number,
    newHeight: number,
    finalCommit: boolean,
  ) => void;

  /** Wave 26. Designate a column whose cells act as the row drag handle.
   *  Pointerdown inside any cell of that column starts a row-reorder
   *  drag (matches AG Grid's `rowDragManaged` UX). When omitted, row
   *  reorder is off — we don't grab cell-click events accidentally.
   *  Common values: the row-number column or a dedicated `id` column. */
  readonly rowDragColumnId?: string;

  /** Wave 26. Fires when a row drag-and-drop lands. Adopters apply the
   *  reorder to their data store (the grid never owns row data).
   *
   *  `movedRow` (v1.2 follow-up) carries EVERY row the drag moved, ascending.
   *  Dragging a row that is part of the current selection moves the whole
   *  selection; dragging an unselected row moves just that row, and
   *  `movedRow` is then `[fromRow]`. The two leading arguments keep their
   *  wave-26 meaning so existing handlers are unaffected — an adopter that
   *  wants multi-row support reads the third argument, and one that does not
   *  keeps working on the first row of the set.
   *
   *  No-op drops never fire: a contiguous moved set dropped back inside (or at
   *  either edge of) the run it occupies changes nothing. */
  readonly onRowReorder?: (
    fromRow: number,
    toRow: number,
    movedRow: ReadonlyArray<number>,
  ) => void;
  /** Fires while the user drags a column-resize handle and again on
   *  drop. `finalCommit=false` during the drag (for UI feedback);
   *  `finalCommit=true` on pointer-up. Consumers should persist the
   *  width on finalCommit only. */
  readonly onColumnResize?: (
    columnId: string,
    newWidth: number,
    finalCommit: boolean,
  ) => void;
  /** Header band height in CSS pixels. Default 32. */
  readonly headerHeight?: number;
  /** Number of left-pinned columns. Default 0. */
  readonly frozenColumnCount?: number;
  /** Theme tokens. Defaults to a dark palette. */
  readonly theme?: Partial<GridTheme>;
  /** Per-frame callback for live FPS meters. */
  readonly onFrame?: (stats: FrameStats) => void;
  /** Fires whenever the selection changes (click, drag, keyboard, programmatic). */
  readonly onSelectionChange?: (selection: SelectionSnapshot) => void;
  /** Current sort state. Renderer draws ▲/▼ in matching column headers.
   *  Caller owns the state — change in response to onHeaderClick and re-pass
   *  via setSort(). */
  readonly sort?: SortModel;
  /** Fires when the user clicks a column header. Use to toggle sort, open a
   *  filter menu, etc. Receives the columnId. */
  readonly onHeaderClick?: (columnId: string) => void;

  // ---- Column reorder (drag-and-drop) ----

  /** Allow dragging column headers left/right to reorder the columns
   *  array. When enabled, the grid splices its internal column array
   *  on drop and fires `onColumnReorder` so consumers can persist the
   *  new order. Default: false. */
  readonly enableColumnReorder?: boolean;

  /** Fires when a drag-reorder lands. Indices are post-reorder
   *  positions in the visible column array; the grid has already
   *  applied the move internally. Consumers should mirror the change
   *  in their own state so subsequent re-mounts see the same order. */
  readonly onColumnReorder?: (
    fromIndex: number,
    toIndex: number,
    columnId: string,
  ) => void;

  // ---- Fill handle (drag-extend a selection) ----

  /** Render a draggable fill handle (4×4 square) at the bottom-right
   *  corner of the active selection. Dragging the handle extends the
   *  range to the cells the user drags over; on drop, `onFillHandle`
   *  fires with the source and target rectangles so the consumer can
   *  copy / interpolate / pattern-fill the values themselves.
   *  Default: false. */
  readonly enableFillHandle?: boolean;

  /** Fires when a fill-handle drag lands. `source` is the original
   *  selection rectangle the user started from; `fill` is the cells
   *  the drag extended into (NOT including the source — that's what
   *  the consumer should copy from). The grid does NOT apply the
   *  fill itself; the consumer owns the data and decides the policy
   *  (copy, linear interpolation, sequence, etc.). */
  readonly onFillHandle?: (
    source: { rowStart: number; rowEnd: number; colStart: number; colEnd: number },
    fill: { rowStart: number; rowEnd: number; colStart: number; colEnd: number },
  ) => void;

  // ---- Overlays (wave 24) ----

  /** When true, render the `loadingOverlay` (or a built-in spinner) on
   *  top of the data band. Adopters bind this to their data-fetching
   *  state — e.g. SSRM block-pending, ORM query in flight, async
   *  filter recompute. Independent of `numRows` so a stale dataset
   *  can still show its rows while a refresh runs. Default: false. */
  readonly loading?: boolean;

  /** Override the built-in loading overlay. Receives the grid host so
   *  the override can append/replace whatever it wants; the grid
   *  removes the previously-rendered element before calling this.
   *  When omitted and `loading === true`, a small centered spinner +
   *  "Loading…" label render. */
  readonly loadingOverlay?: (host: HTMLElement) => void;

  /** Override the built-in no-rows overlay. Fires when `rowSource.numRows
   *  === 0` and `loading !== true`. When omitted, a centered "No rows
   *  to show" label renders. */
  readonly noRowsOverlay?: (host: HTMLElement) => void;

  /** Cell flash-on-update (wave 24). Configure the fade duration and
   *  flash tint applied by `Grid.flashCell(rowIndex, columnId)`. Adopters
   *  wire their CDC stream / optimistic-mutation onCommit / formula
   *  recompute callback to `flashCell` so changed values are visually
   *  obvious for a moment. Defaults: 600ms, soft amber. */
  readonly flash?: {
    readonly durationMs?: number;
    readonly color?: string;
  };

  /** Find / replace (wave 25). When true, Ctrl+F (Cmd+F on macOS) opens
   *  the find toolbar; the grid highlights every matching cell in the
   *  visible viewport. Default: false. */
  readonly enableFind?: boolean;

  /** Fires when a find-replace operation commits. The grid does not own
   *  the row store, so it can't mutate values itself; this callback hands
   *  the change to the adopter who applies it the same way they handle
   *  cell editing. */
  readonly onReplace?: (
    rowIndex: number,
    columnId: string,
    newValue: string,
    oldValue: unknown,
  ) => void;

  // ---- Sticky group rows ----

  /** Pin the topmost visible group ancestor's header to the top of
   *  the data band when the user scrolls past it. Without this, the
   *  user loses the "what group am I in" context as soon as the
   *  group's title scrolls off-screen. Default: true when
   *  `getRowMeta` is set. */
  readonly stickyGroupRows?: boolean;

  // ---- Context menu ----

  /** Fires on right-click (or pointerType=touch long-press) over any
   *  part of the grid. The Grid calls `preventDefault()` on the native
   *  event so the browser menu doesn't show — the consumer is then
   *  responsible for rendering their own menu (e.g. a popover) at the
   *  reported client coordinates.
   *
   *  Payload tells the consumer what was right-clicked so the menu
   *  can present contextual actions:
   *   - kind='cell'   : a data cell (rowIndex + columnId set)
   *   - kind='header' : a column header (columnId set, no rowIndex)
   *   - kind='empty'  : the grid background, below all rows
   */
  readonly onContextMenu?: (target: ContextMenuTarget) => void;

  // ---- Master-detail (expandable rows) ----

  /** Set of currently-expanded row indices. The renderer reserves
   *  `detailHeight` extra space below each expanded row and calls
   *  `getDetailContent` to render the panel. */
  readonly expanded?: ReadonlySet<number> | ReadonlyArray<number>;

  /** Pixels of detail content per expanded row. Default 200. */
  readonly detailHeight?: number;

  /** Returns the DOM element to mount in the detail panel for a given row.
   *  Return null to suppress the panel even though the row is in `expanded`.
   *  The Grid manages mount/unmount lifecycle and positioning; the caller
   *  is responsible only for producing the element. Re-mounted on layout
   *  changes (sort/filter); cache externally if construction is expensive. */
  readonly getDetailContent?: (rowIndex: number) => HTMLElement | null;

  /** Fires when the user clicks the chevron column on a row.
   *  Caller owns the expanded state and passes it back via `expanded`. */
  readonly onToggleExpand?: (rowIndex: number) => void;

  /** Called just before the grid removes a detail panel from the DOM
   *  (row collapsed OR scrolled out of view). Use this to tear down
   *  any nested resources the panel owns — e.g. a nested Grid created
   *  inside `getDetailContent` should call its `destroy()` here. */
  readonly onDetailUnmount?: (rowIndex: number, el: HTMLElement) => void;

  // ---- Cell editing ----

  /** Whether cells are editable. Pass a predicate to gate per cell.
   *  Default: not editable. */
  readonly editable?: boolean | ((rowIndex: number, columnId: string) => boolean);

  /** Fires when the user commits an edit (Enter, Tab, or focus loss).
   *  The grid does NOT mutate the row source itself — the consumer is
   *  responsible for writing the value back. `newValue` is the raw
   *  string from the editor; coerce as needed. */
  readonly onCellEdit?: (
    rowIndex: number,
    columnId: string,
    newValue: string,
    oldValue: unknown,
  ) => void;

  /** Fires when an edit session begins (F2, Enter, double-click, or
   *  type-ahead). Use to log/analytics; cancel by ignoring (the grid
   *  begins regardless). */
  readonly onBeginEdit?: (rowIndex: number, columnId: string) => void;

  /** Fires on Cmd/Ctrl+V when the grid has focus. The clipboard text
   *  is parsed as TSV and delivered as a 2D array of strings; the
   *  consumer writes them to whichever data source it owns, anchored
   *  at the current active cell. */
  readonly onPaste?: (
    anchorRow: number,
    anchorCol: number,
    rows: ReadonlyArray<ReadonlyArray<string>>,
  ) => void;

  // ---- Pinned rows ----

  /** Optional read-only RowSource pinned to the top of the viewport,
   *  below the header. Common use: aggregation/totals rows. Cells use
   *  the same column ids; the source's getCell is read each frame. */
  readonly pinnedTopRowSource?: RowSource;

  /** Symmetric pinned-bottom source. */
  readonly pinnedBottomRowSource?: RowSource;

  /** Fixed row height (CSS px) for pinned bands. Default 28. Pinned
   *  rows do not support per-row variable heights. */
  readonly pinnedRowHeight?: number;

  // ---- Column groups (header tree) ----

  /** Optional grouping band. Each entry spans `children.length` adjacent
   *  columns starting from the first un-grouped column. The header
   *  band height doubles when at least one group is supplied. */
  readonly columnGroups?: ReadonlyArray<ColumnGroupDef>;

  // ---- Status bar ----

  /** Show a status band below the data area summarizing the current
   *  selection: count plus min/max/sum/avg for numeric cells. Default
   *  false. */
  readonly statusBar?: boolean;

  // ---- Floating filter row ----

  /** Render a per-column filter input row pinned just below the
   *  column headers. Each visible column gets a `<input>` aligned
   *  with its band; typing fires `onFloatingFilterChange`. Default
   *  false. */
  readonly floatingFilters?: boolean;

  /** Called when a floating filter input changes. The grid does not
   *  apply the filter itself — the consumer translates the value to
   *  whatever FilterModel makes sense for that column (substring,
   *  numeric range, etc.) and threads it through the data source. */
  readonly onFloatingFilterChange?: (columnId: string, value: string) => void;

  // ---- Row grouping ----

  /** Per-row metadata hook. Return a RowGroupMeta to render the row as
   *  a group header (with chevron, indent, label, count, aggregates).
   *  Return null/undefined for normal data rows. The renderer calls
   *  this once per visible row per frame, so keep it cheap (typically
   *  a Map lookup keyed on rowIndex). */
  readonly getRowMeta?: (rowIndex: number) => RowMeta | null | undefined;

  /** Fires when the user clicks a group's chevron. Receives the
   *  RowGroupMeta.path so the caller can flip its expansion state and
   *  rebuild the wrapped RowSource. */
  readonly onToggleGroup?: (path: string) => void;

  // ---- Tool panels (v1.3) ----
  //
  // These mount as DOM chrome inside `host` and emit model-shaped
  // callbacks. The grid computes NOTHING — the consumer wires each
  // callback to @onegrid/data (groupRows / pivot / filterIndex) and
  // feeds results back via setRowSource() / setColumns(). All additive.

  /** v1.3. Show the drag-to-group pill bar — a strip at the top of the
   *  header chrome holding one removable, reorderable pill per active
   *  group-by column, plus a drop target. Default false. Seed the
   *  initial pills with `groupColumns`. The grid owns the pill list as
   *  UI state and emits `onRowGrouping` whenever it changes; the
   *  consumer rebuilds its grouped RowSource. */
  readonly enableGroupBar?: boolean;

  /** v1.3. Initial group-by column ids shown as pills in the group bar.
   *  Order is the nesting order (outer → inner), matching
   *  `GroupingModel.columns`. Only meaningful with `enableGroupBar`. */
  readonly groupColumns?: ReadonlyArray<string>;

  /** v1.3. Fires when the group-bar pill set changes (add / remove /
   *  reorder). Receives the new ordered column-id list — drop it
   *  straight into `GroupingModel.columns`. Empty array = ungrouped. */
  readonly onRowGrouping?: (columnIds: string[]) => void;

  /** v1.3. Show the aggregation side panel — a docked aside listing every
   *  column with an aggregator picker (none / sum / avg / count /
   *  countDistinct / min / max / first / last). Default false. Hidden
   *  until `openAggregationPanel()` (or starts open via
   *  `aggregationPanelOpen`). */
  readonly enableAggregationPanel?: boolean;

  /** v1.3. Start the aggregation panel open. Only meaningful with
   *  `enableAggregationPanel`. Default false (toggle via
   *  `openAggregationPanel()` / `closeAggregationPanel()`). */
  readonly aggregationPanelOpen?: boolean;

  /** v1.3. Seed aggregator pickers from an existing AggregationModel.
   *  Each entry's `columnId` + `fn` sets that column's picker. */
  readonly aggregations?: AggregationModel;

  /** v1.3. Fires when any aggregator picker changes. Receives the full
   *  composed `AggregationModel` (one `Aggregation` per column whose
   *  picker is not "none", `fn` = the chosen type, `alias` defaulting to
   *  the column id). Pass it to `@onegrid/data` aggregate / groupRows. */
  readonly onAggregationChange?: (model: AggregationModel) => void;

  /** v1.3. Show the filter side panel — a docked aside with a per-column
   *  operator picker + value input. Changes are BATCHED: the composed
   *  `FilterModel` is emitted on the Apply button (or `applyFilterPanel()`),
   *  not per keystroke. Default false. Distinct from the per-keystroke
   *  `floatingFilters` row. */
  readonly enableFilterPanel?: boolean;

  /** v1.3. Start the filter panel open. Default false. */
  readonly filterPanelOpen?: boolean;

  /** v1.3. Fires when the filter panel's Apply commits. Receives the
   *  composed `FilterModel` — a `LogicalFilter('and', [...])` of one
   *  `ComparisonFilter` per column with a set operator + value, or `null`
   *  when nothing is set. Values are strings (the consumer coerces to the
   *  column's type); multi-value ops (in/notIn/between/notBetween) split
   *  the input on commas into `values`. Pass it to `@onegrid/data`
   *  filterIndex(). */
  readonly onFilterModelChange?: (model: FilterModel) => void;

  /** v1.3. Show the pivot side panel — a docked aside binding columns to
   *  the three `PivotModel` bins (rows / columns / values). Each column
   *  has a bin picker; a column in the values bin also gets an aggregator
   *  picker. Default false. */
  readonly enablePivotPanel?: boolean;

  /** v1.3. Start the pivot panel open. Default false. */
  readonly pivotPanelOpen?: boolean;

  /** v1.3. Seed the pivot bins from an existing PivotModel. */
  readonly pivotModel?: PivotModel;

  /** v1.3. Fires when any pivot bin assignment or value-aggregator
   *  changes. Receives the full composed `PivotModel` (rows + columns are
   *  ordered column-id lists; measures is one `Aggregation` per
   *  values-bin column). Pass it to `@onegrid/data` pivot(). */
  readonly onPivotChange?: (model: PivotModel) => void;
}

export interface ColumnGroupDef {
  /** Display label drawn in the top header band. */
  readonly label: string;
  /** Column ids spanned by this group, in display order. */
  readonly columnIds: ReadonlyArray<string>;
  /** Optional band background. */
  readonly background?: string;
}

/**
 * Per-row hint that switches how the renderer paints a row. Returned
 * from `GridOptions.getRowMeta(rowIndex)`. Null/undefined means the row
 * is a normal data row (default rendering).
 */
export interface RowGroupMeta {
  readonly kind: 'group';
  /** Nesting level (0 = top-level group). Used for left indent. */
  readonly depth: number;
  /** Group label drawn in the row's left side. */
  readonly label: string;
  /** Stable id used by `onToggleGroup` to identify the group. */
  readonly path: string;
  /** Whether this group is currently expanded (children visible). */
  readonly expanded: boolean;
  /** Number of rows under this group. Drawn next to the label. */
  readonly count?: number;
  /** Aggregate values per column, drawn in the row's column slots. */
  readonly aggregates?: Record<string, unknown>;
}

/**
 * Row meta for hierarchical tree data (parent → child). Renderer
 * paints a chevron + indent matching `depth`, then falls through to
 * normal cell rendering for the row's columns. `onToggleGroup` is
 * the same callback used for groups — the tree's node `id` rides as
 * the `path` argument so consumers route both via one handler.
 */
export interface RowTreeMeta {
  readonly kind: 'tree';
  readonly depth: number;
  /** Stable node id; round-trips through onToggleGroup. */
  readonly id: string;
  /** Whether the children are visible. */
  readonly expanded: boolean;
  /** True when this node has no children AND no loader. Renderer
   *  paints no chevron for leaves. */
  readonly isLeaf: boolean;
  /** True when expanding could reveal children (children present OR
   *  loader supplied). When false but expanded, we render the chevron
   *  in expanded state but no indent change beneath. */
  readonly hasChildren: boolean;
}

/**
 * Mid-table row pinning (wave 26). Adopters mark specific rows from
 * the main RowSource as sticky-to-top or sticky-to-bottom; the renderer
 * pins them in place when their natural scroll position would otherwise
 * scroll off-screen. The minimal-viable implementation supports one
 * pinned row per direction — adopters who need stacked pins can pin
 * different rows from different scroll positions to compose.
 *
 * Returned from `GridOptions.getRowMeta(rowIndex)` as `{ kind: 'data',
 * pinned: 'top' }` etc. Mirrors how the existing group/tree row meta
 * shapes carry per-row hints to the renderer.
 */
export interface RowDataMeta {
  readonly kind: 'data';
  readonly pinned: 'top' | 'bottom';
}

export type RowMeta = RowGroupMeta | RowTreeMeta | RowDataMeta;
