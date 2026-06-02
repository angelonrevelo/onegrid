// =============================================================================
// Grid — oneGrid's Canvas-2D renderer + DOM accessibility shadow.
//
// Architecture:
//   - <canvas> for pixels.
//   - A native scrollbar over a tall transparent <div> for native scroll feel.
//   - A FenwickHeights tree for O(log n) offsetForRow / rowAtOffset.
//   - A hidden <table role="grid"> mirror of the visible viewport ± buffer
//     so screen readers (NVDA, VoiceOver, JAWS) get a real ARIA grid to
//     traverse, with `aria-rowindex` / `aria-colindex` carrying the *true*
//     virtual row position even though only a window of cells is in the DOM.
//   - DPR-aware drawing for crisp text on retina.
//   - Velocity-aware overscan to avoid blank frames during fast flings.
//
// No framework dependency. The host is any HTMLElement.
// =============================================================================

import { FenwickHeights } from '@onegrid/data';
import { ariaCellId, LiveAnnouncer } from '@onegrid/a11y';
import { RendererPool } from './render/renderer-pool';
import {
  DEFAULT_THEME,
  type ColumnDef,
  type FrameStats,
  type GridOptions,
  type GridTheme,
  type MetricsSnapshot,
  type RowSource,
  type ValidationResult,
} from './types';
import { SelectionModel, type CellPosition, type SelectionSnapshot } from './selection';
import type {
  Aggregation,
  AggregationModel,
  AggregationType,
  ComparisonFilter,
  ComparisonOperator,
  FilterModel,
  SortModel,
} from '@onegrid/protocol';

import {
  VIRTUAL_SCROLL_CAP_PX,
  computeScrollScale,
  logicalToPhysical,
  physicalToLogical,
} from './scroll-math';

let nextGridSequence = 0;

interface FrameSample {
  ts: number;
  drawDurationMs: number;
  scrollDelta: number;
  cells: number;
}

const STATUS_BAR_HEIGHT = 24;
const COLUMN_GROUP_BAND_HEIGHT = 24;
const FLOATING_FILTER_ROW_HEIGHT = 28;
const GROUP_BAR_HEIGHT = 36;
const SIDE_PANEL_WIDTH = 240;

/** Aggregator picker options (v1.3). 'none' clears the column's entry;
 *  the rest map 1:1 to protocol AggregationType. Module-level so the
 *  aggregation + pivot panels share one source of truth. */
const AGGREGATOR_OPTIONS: ReadonlyArray<{ value: 'none' | AggregationType; label: string }> = [
  { value: 'none', label: '—' },
  { value: 'sum', label: 'Sum' },
  { value: 'avg', label: 'Avg' },
  { value: 'count', label: 'Count' },
  { value: 'countDistinct', label: 'Count distinct' },
  { value: 'min', label: 'Min' },
  { value: 'max', label: 'Max' },
  { value: 'first', label: 'First' },
  { value: 'last', label: 'Last' },
];

/** Filter-panel operator picker options (v1.3). Maps 1:1 to protocol
 *  ComparisonOperator. 'none' clears the column's filter. */
const FILTER_OPERATOR_OPTIONS: ReadonlyArray<{
  value: 'none' | ComparisonOperator;
  label: string;
}> = [
  { value: 'none', label: '—' },
  { value: 'eq', label: '=' },
  { value: 'neq', label: '≠' },
  { value: 'lt', label: '<' },
  { value: 'lte', label: '≤' },
  { value: 'gt', label: '>' },
  { value: 'gte', label: '≥' },
  { value: 'contains', label: 'contains' },
  { value: 'notContains', label: 'not contains' },
  { value: 'startsWith', label: 'starts with' },
  { value: 'endsWith', label: 'ends with' },
  { value: 'in', label: 'in' },
  { value: 'notIn', label: 'not in' },
  { value: 'between', label: 'between' },
  { value: 'notBetween', label: 'not between' },
  { value: 'isNull', label: 'is null' },
  { value: 'isNotNull', label: 'is not null' },
];

/** Operators that take NO value (unary). */
const UNARY_FILTER_OPS: ReadonlySet<ComparisonOperator> = new Set<ComparisonOperator>([
  'isNull',
  'isNotNull',
]);

/** Operators that take a comma-split `values` array rather than a single
 *  `value`. */
const MULTI_VALUE_FILTER_OPS: ReadonlySet<ComparisonOperator> = new Set<ComparisonOperator>([
  'in',
  'notIn',
  'between',
  'notBetween',
]);

interface PerformanceWithMemory extends Performance {
  readonly memory?: {
    readonly usedJSHeapSize: number;
  };
}

export class Grid {
  private readonly host: HTMLElement;
  private readonly gridId: string;
  // Mutable so the in-grid column drag-drop can splice live without
  // forcing a full reconstruction (which would lose scroll/selection).
  // Constructor copies the user's array, so the user's reference is
  // not mutated.
  private columns: ColumnDef[];
  private rowSource: RowSource;
  private fenwick: FenwickHeights;
  private readonly headerHeight: number;
  private readonly frozenColumnCount: number;
  private readonly theme: GridTheme;
  private readonly onFrame: ((stats: FrameStats) => void) | undefined;

  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly scrollHost: HTMLDivElement;
  private readonly scrollSpacer: HTMLDivElement;
  private readonly a11yMount: HTMLDivElement;
  private readonly resizeObserver: ResizeObserver;

  private dpr: number;
  private viewportWidth = 0;
  private viewportHeight = 0;
  private scrollTop = 0;
  private scrollLeft = 0;
  private lastRenderedScrollTop = -1;
  private lastRenderedScrollLeft = -1;

  // Scroll virtualization. Browsers cap CSS element heights around
  // 16-33 Mpx (Firefox ~17.9M, Chrome ~33.5M, Safari similar). 5M rows
  // × 28 px = 140 Mpx — far past the cap, so the scrollbar would only
  // reach ~24% of the dataset. We cap the physical spacer at
  // VIRTUAL_SCROLL_CAP_PX and scale browser `scrollTop` (physical) to
  // our internal `scrollTop` (logical, data-px). All scroll consumers
  // stay in logical units; only the bridge to/from the DOM scrollHost
  // multiplies/divides by `scrollScale`.
  private scrollScale = 1;
  // Suppress the scroll handler while we're imperatively driving the
  // host's scrollTop (e.g., scrollToRow). Without this, the resulting
  // scroll event would re-derive `this.scrollTop` from the rounded
  // physical position and undo a precise jump.
  private suppressScrollEvent = false;

  private rafHandle: number | null = null;
  private needsRender = true;
  private destroyed = false;

  private readonly frameBufferCap = 4096;
  private readonly frameBuffer: FrameSample[] = [];
  private frameBufferHead = 0;
  /**
   * Per-scroll-event magnitude (`|Δscrollτ|`). Raw signal; the
   * v0.0.10 adaptive overscan derives a smoothed estimate from it.
   */
  private velocity = 0;
  /**
   * Exponentially-smoothed scroll velocity. Filtered to suppress
   * single-frame spikes from trackpad inertia + browser stutter so
   * the overscan window doesn't snap between sizes mid-fling.
   */
  private velocitySmoothed = 0;
  /**
   * +1 down, -1 up, 0 stationary. Drives direction-aware overscan —
   * pre-fetching ahead of travel matters; pre-fetching behind doesn't.
   */
  private scrollDirection: -1 | 0 | 1 = 0;
  private debugLog = false;

  private cumulativeColumnWidths: Float32Array;
  private totalColumnsWidth = 0;
  private frozenWidth = 0;

  private readonly selection = new SelectionModel();
  private readonly onSelectionChange: ((s: SelectionSnapshot) => void) | undefined;
  private readonly onHeaderClick: ((columnId: string) => void) | undefined;
  private sort: SortModel = [];
  private isPointerDragging = false;
  private suppressSelectionUntilUp = false;

  // Master-detail (expandable rows) state.
  private baseHeights: Float32Array;
  private expanded: Set<number> = new Set();
  private readonly detailHeight: number;
  private readonly getDetailContent: ((rowIndex: number) => HTMLElement | null) | undefined;
  private readonly onToggleExpand: ((rowIndex: number) => void) | undefined;
  private readonly onDetailUnmount:
    | ((rowIndex: number, el: HTMLElement) => void)
    | undefined;
  private detailLayer: HTMLDivElement | null = null;
  private mountedDetails = new Map<number, HTMLDivElement>();
  private readonly chevronWidth = 24;

  // Cell editing.
  private readonly editable: boolean | ((row: number, columnId: string) => boolean) | undefined;
  private readonly onCellEdit:
    | ((row: number, columnId: string, newValue: string, oldValue: unknown) => void)
    | undefined;
  private readonly onBeginEdit: ((row: number, columnId: string) => void) | undefined;
  private readonly onPaste:
    | ((anchorRow: number, anchorCol: number, rows: ReadonlyArray<ReadonlyArray<string>>) => void)
    | undefined;
  private editingRow: number | null = null;
  private editingCol: number | null = null;
  private editorEl: HTMLInputElement | null = null;
  /** Active custom-editor instance for the current edit session. Null
   *  when the default text input is in use OR when not editing. */
  private editorInstance: import('./types').CellEditorInstance | null = null;
  // IME composition state. Authoritative: gated on composition events,
  // not on KeyboardEvent.isComposing (UA dispatch order varies and the
  // 229 keydown sentinel is unreliable on Android Chrome where it fires
  // for *all* soft-keyboard input).
  private editorIsComposing = false;

  // Validation state. The error bubble is a single shared element that
  // moves with the editor; aria-invalid + aria-errormessage on the
  // editor input link to it. The live announcer is the screen-reader
  // fallback (NVDA + VoiceOver under-support aria-errormessage).
  private editorErrorEl: HTMLDivElement | null = null;
  private editorInputDebounce: ReturnType<typeof setTimeout> | null = null;
  private editorAsyncAbort: AbortController | null = null;
  private editorHasTyped = false;
  private liveAnnouncer: LiveAnnouncer | null = null;

  // Custom cell renderer infrastructure. The overlay layer sits above
  // the canvas and holds DOM nodes produced by ColumnDef.renderer. The
  // pool keeps mounted instances alive across scroll so framework
  // reactivity (React fiber, Svelte runes, etc.) survives.
  private cellOverlayEl: HTMLDivElement | null = null;
  private rendererPool: RendererPool | null = null;
  // Active assignments keyed by `${rendererId}:${row}:${col}` so the
  // same cell coordinate reuses its element across frames (no flicker).
  private activeRendererCells = new Map<string, HTMLElement>();

  // Tooltip state: a single shared <div role="tooltip"> that gets
  // re-targeted per cell, with hover-delay + Escape dismiss following
  // WCAG 1.4.13 (content on hover/focus). One element instead of one
  // per cell keeps DOM allocation flat regardless of dataset size.
  private tooltipEl: HTMLDivElement | null = null;
  private tooltipShowTimer: ReturnType<typeof setTimeout> | null = null;
  private tooltipHoveredKey: string | null = null;

  // Floating filter row: a sticky DOM band below the column headers
  // with one <input> per column. Mounted only when `floatingFilters`
  // is enabled.
  private readonly floatingFiltersEnabled: boolean;
  private readonly onFloatingFilterChange:
    | ((columnId: string, value: string) => void)
    | undefined;
  private floatingFilterBandEl: HTMLDivElement | null = null;
  private readonly floatingFilterInputs = new Map<string, HTMLInputElement>();

  // Drag-to-group pill bar (v1.3). A strip at the top of the header
  // chrome holding one pill per active group-by column + a drop target.
  // The grid owns the ordered column-id list as UI state; mutations fire
  // onRowGrouping. The bar consumes vertical space folded into
  // fullHeaderHeight() (same mechanism as the column-group band).
  private readonly groupBarEnabled: boolean;
  private readonly onRowGrouping:
    | ((columnIds: string[]) => void)
    | undefined;
  private groupColumns: string[] = [];
  private groupBarEl: HTMLDivElement | null = null;
  /** Index in groupColumns where a dragged pill would drop, or -1 when
   *  no pill drag is active. Drives the live insertion caret. */
  private groupPillDragFrom = -1;
  private groupPillDragTo = -1;

  // Aggregation side panel (v1.3). Docked aside listing every column with
  // an aggregator picker. The panel owns a columnId → AggregationType map
  // as UI state and composes the full AggregationModel on each change.
  private readonly aggregationPanelEnabled: boolean;
  private readonly onAggregationChange:
    | ((model: AggregationModel) => void)
    | undefined;
  private aggregationPanelEl: HTMLDivElement | null = null;
  private aggregatorByColumn = new Map<string, AggregationType>();

  // Filter side panel (v1.3). Docked aside with a per-column operator +
  // value. UI edits accumulate in draftFilters; Apply composes the
  // FilterModel and fires onFilterModelChange (batched, not per-keystroke).
  private readonly filterPanelEnabled: boolean;
  private readonly onFilterModelChange:
    | ((model: FilterModel) => void)
    | undefined;
  private filterPanelEl: HTMLDivElement | null = null;
  /** Per-column draft operator + raw value string (pre-Apply). */
  private readonly filterDraft = new Map<
    string,
    { op: ComparisonOperator; raw: string }
  >();

  // Pinned rows + column groups + status bar.
  private pinnedTopRowSource: RowSource | undefined;
  private pinnedBottomRowSource: RowSource | undefined;
  private readonly pinnedRowHeight: number;
  private readonly columnGroups: ReadonlyArray<import('./types').ColumnGroupDef> | undefined;
  private readonly statusBarEnabled: boolean;
  private statusBarEl: HTMLDivElement | null = null;

  // Row grouping.
  private readonly getRowMeta:
    | ((rowIndex: number) => import('./types').RowMeta | null | undefined)
    | undefined;
  private readonly onToggleGroup: ((path: string) => void) | undefined;
  private readonly stickyGroupRowsEnabled: boolean;

  // Fill handle (drag-extend selection). Drag state is null when the
  // user isn't actively dragging the handle.
  private readonly fillHandleEnabled: boolean;
  private readonly onFillHandle:
    | ((
        source: { rowStart: number; rowEnd: number; colStart: number; colEnd: number },
        fill: { rowStart: number; rowEnd: number; colStart: number; colEnd: number },
      ) => void)
    | undefined;
  private fillHandleSize = 6;
  private fillDragState: {
    source: import('./selection').NormalizedRange;
    targetRow: number;
    targetCol: number;
  } | null = null;

  // Context menu — observers only. The Grid resolves the target
  // (cell / header / empty), prevents the native menu, and forwards
  // the payload. Rendering the menu is the consumer's responsibility.
  private readonly onContextMenu:
    | ((target: import('./types').ContextMenuTarget) => void)
    | undefined;

  // Column reorder (drag-drop). When enabled, header pointerdown
  // captures a drag-candidate; on sufficient movement it promotes to
  // an active drag with a visible drop indicator; on pointerup it
  // splices `this.columns` and fires `onColumnReorder`. onHeaderClick
  // is deferred to pointerup so a pure click still toggles sort.
  private readonly columnReorderEnabled: boolean;
  private readonly onColumnReorder:
    | ((fromIndex: number, toIndex: number, columnId: string) => void)
    | undefined;
  private dragCandidateColumn: number | null = null;
  private dragCandidateClientX = 0;
  private dragActiveColumn: number | null = null;
  private dragIndicatorEl: HTMLDivElement | null = null;

  // Cell flash-on-update (wave 24). Adopters wire their CDC handler to
  // `flashCell(rowIndex, columnId)` whenever a value changes; the grid
  // keeps a small map of recently-flashed cells and tints their
  // background by the remaining fade time on each render frame. O(N)
  // where N is the flash-buffer size, which is bounded by the visible
  // viewport — irrelevant compared to per-frame draw cost.
  private readonly flashes = new Map<string, number>(); // key → start timestamp
  private flashDurationMs = 600;
  private flashColor = '#fce28a';

  // Find / replace state (wave 25).
  private readonly findEnabled: boolean;
  private readonly onReplaceCallback:
    | ((rowIndex: number, columnId: string, newValue: string, oldValue: unknown) => void)
    | undefined;
  private findQuery = '';
  private findToolbarEl: HTMLDivElement | null = null;
  private findInputEl: HTMLInputElement | null = null;
  private replaceInputEl: HTMLInputElement | null = null;
  private findHighlightColor = '#fde047'; // soft yellow

  // Loading / no-rows overlay state (wave 24).
  private readonly overlayEl: HTMLDivElement;
  private loading: boolean;
  private readonly loadingOverlay: ((host: HTMLElement) => void) | undefined;
  private readonly noRowsOverlay: ((host: HTMLElement) => void) | undefined;
  private lastOverlayMode: 'hidden' | 'loading' | 'no-rows' = 'hidden';

  // Column resize state. v1.2 — pointer enters resize mode when it
  // lands inside the rightmost RESIZE_HANDLE_PX of a column header.
  // We then track the width delta per frame until pointerup.
  private readonly columnResizeEnabled: boolean;
  private readonly onColumnResize:
    | ((columnId: string, newWidth: number, finalCommit: boolean) => void)
    | undefined;
  private resizeColumn: number | null = null;
  private resizeStartClientX = 0;
  private resizeStartWidth = 0;

  // Row resize state (wave 24). Mirror of column resize on the Y axis;
  // hit-zone is the bottom RESIZE_HANDLE_PX of any data cell when
  // `enableRowResize` is on. No header gutter today.
  private readonly rowResizeEnabled: boolean;
  private readonly onRowResize:
    | ((rowIndex: number, newHeight: number, finalCommit: boolean) => void)
    | undefined;
  private resizeRow: number | null = null;
  private resizeStartClientY = 0;
  private resizeStartHeight = 0;

  // Row reorder state (wave 26). Mirror of column reorder on the Y axis.
  // Trigger: pointerdown inside any cell of `rowDragColumnId`. We track
  // a candidate first (so a tap on the cell still works as cell-select)
  // and only "promote" to an active drag once the pointer moves a few
  // pixels.
  private readonly rowDragColumnId: string | undefined;
  private readonly onRowReorder:
    | ((fromRows: ReadonlyArray<number>, toRow: number) => void)
    | undefined;
  private rowDragCandidateRow: number | null = null;
  private rowDragCandidateClientY = 0;
  private rowDragActiveRow: number | null = null;
  private rowDragInsertIndex = 0;
  /** The full set of rows that travel together when a drag is active
   *  (multi-row since v1.2). Captured at drag-start: if the grabbed row
   *  is inside the current selection, this is every selected row;
   *  otherwise it is just the grabbed row. Always ascending. */
  private rowDragRows: number[] = [];
  private rowDragIndicatorEl: HTMLDivElement | null = null;
  /** Drag insertion index (the column index where the dragged column
   *  would land if dropped now). Range: [0, this.columns.length]. */
  private dragInsertIndex = 0;

  constructor(options: GridOptions) {
    this.host = options.host;
    this.gridId = `onegrid-${String(++nextGridSequence)}`;
    // Copy so subsequent in-grid mutations (column reorder) don't
    // touch the caller's array.
    this.columns = [...options.columns];
    this.rowSource = options.rowSource;
    this.headerHeight = options.headerHeight ?? 32;
    this.frozenColumnCount = options.frozenColumnCount ?? 0;
    this.theme = { ...DEFAULT_THEME, ...options.theme };
    this.onFrame = options.onFrame;
    this.onSelectionChange = options.onSelectionChange;
    this.onHeaderClick = options.onHeaderClick;
    this.sort = options.sort ?? [];
    this.columnReorderEnabled = options.enableColumnReorder ?? false;
    this.onColumnReorder = options.onColumnReorder;
    this.columnResizeEnabled = options.enableColumnResize ?? false;
    this.onColumnResize = options.onColumnResize;
    this.rowResizeEnabled = options.enableRowResize ?? false;
    this.onRowResize = options.onRowResize;
    this.rowDragColumnId = options.rowDragColumnId;
    this.onRowReorder = options.onRowReorder;
    this.findEnabled = options.enableFind ?? false;
    this.onReplaceCallback = options.onReplace;
    this.onContextMenu = options.onContextMenu;

    this.dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;

    // Master-detail wiring: track BASE row heights separately so we can
    // compose effective heights = base + (expanded ? detailHeight : 0)
    // when the user toggles row expansion.
    this.detailHeight = options.detailHeight ?? 200;
    this.getDetailContent = options.getDetailContent;
    this.onToggleExpand = options.onToggleExpand;
    this.onDetailUnmount = options.onDetailUnmount;

    // Cell editing wiring.
    this.editable = options.editable;
    this.onCellEdit = options.onCellEdit;
    this.onBeginEdit = options.onBeginEdit;
    this.onPaste = options.onPaste;

    // Pinned rows + column groups + status bar.
    this.pinnedTopRowSource = options.pinnedTopRowSource;
    this.pinnedBottomRowSource = options.pinnedBottomRowSource;
    this.pinnedRowHeight = options.pinnedRowHeight ?? 28;
    this.columnGroups = options.columnGroups;
    this.statusBarEnabled = options.statusBar === true;

    // Row grouping.
    this.getRowMeta = options.getRowMeta;
    this.onToggleGroup = options.onToggleGroup;
    // Sticky group rows default ON whenever getRowMeta is provided —
    // it's always desirable for grouped/tree views, and is cheap to
    // compute. Consumers can opt-out by passing `false`.
    this.stickyGroupRowsEnabled =
      options.stickyGroupRows ?? options.getRowMeta !== undefined;
    this.fillHandleEnabled = options.enableFillHandle ?? false;
    this.onFillHandle = options.onFillHandle;

    // Floating filter row.
    this.floatingFiltersEnabled = options.floatingFilters === true;
    this.onFloatingFilterChange = options.onFloatingFilterChange;

    // Drag-to-group pill bar (v1.3).
    this.groupBarEnabled = options.enableGroupBar ?? false;
    this.onRowGrouping = options.onRowGrouping;
    this.groupColumns = options.groupColumns ? [...options.groupColumns] : [];

    // Aggregation side panel (v1.3).
    this.aggregationPanelEnabled = options.enableAggregationPanel ?? false;
    this.onAggregationChange = options.onAggregationChange;
    if (options.aggregations) {
      for (const a of options.aggregations) {
        // Only seed builtin types; custom string keys aren't pickable in
        // the panel, so they'd have no <option> to select.
        if (AGGREGATOR_OPTIONS.some((o) => o.value === a.fn)) {
          this.aggregatorByColumn.set(a.columnId, a.fn as AggregationType);
        }
      }
    }

    // Filter side panel (v1.3).
    this.filterPanelEnabled = options.enableFilterPanel ?? false;
    this.onFilterModelChange = options.onFilterModelChange;
    if (options.expanded) {
      this.expanded = new Set(options.expanded);
    }
    this.baseHeights =
      typeof options.rowHeight === 'number'
        ? new Float32Array(options.rowSource.numRows).fill(options.rowHeight)
        : new Float32Array(options.rowHeight); // copy so the user's array isn't mutated
    this.fenwick = new FenwickHeights(this.computeEffectiveHeights());

    // The host needs to be a positioning context for our absolute children.
    // Only force `position: relative` if it's currently `static` — otherwise
    // we'd clobber a caller's deliberate `position: absolute / fixed`, which
    // would collapse the host to 0 height because relative positioning
    // requires an explicit dimension to size against.
    if (getComputedStyle(this.host).position === 'static') {
      this.host.style.position = 'relative';
    }
    // We do NOT clear the host — React (or any framework) may own children
    // there. The Grid only manages elements it appended itself, removed in
    // destroy() via Element.remove().

    this.canvas = document.createElement('canvas');
    this.canvas.style.position = 'absolute';
    this.canvas.style.inset = '0';
    this.canvas.style.pointerEvents = 'none';
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('Grid: 2D context unavailable.');
    this.ctx = ctx;

    this.scrollHost = document.createElement('div');
    this.scrollHost.style.position = 'absolute';
    this.scrollHost.style.inset = '0';
    this.scrollHost.style.overflow = 'auto';
    this.scrollHost.style.outline = 'none';
    this.scrollHost.tabIndex = 0;
    this.scrollHost.id = this.gridId;
    this.scrollHost.setAttribute('role', 'grid');
    this.scrollHost.setAttribute('aria-rowcount', String(this.rowSource.numRows));
    this.scrollHost.setAttribute('aria-colcount', String(this.columns.length));
    // Range selection is supported, so screen readers should announce
    // the grid as multi-selectable per WAI-ARIA 1.2 grid semantics.
    this.scrollHost.setAttribute('aria-multiselectable', 'true');

    this.scrollSpacer = document.createElement('div');
    this.scrollSpacer.style.position = 'relative';
    this.scrollHost.appendChild(this.scrollSpacer);

    this.a11yMount = document.createElement('div');
    this.a11yMount.style.cssText =
      'position:absolute;left:-100000px;top:-100000px;width:1px;height:1px;overflow:hidden;';
    this.a11yMount.setAttribute('aria-hidden', 'false');

    this.host.appendChild(this.canvas);
    this.host.appendChild(this.scrollHost);
    this.host.appendChild(this.a11yMount);

    // Master-detail layer: only created when getDetailContent is provided.
    // Sits above the canvas but inherits pointer-events from each panel
    // child (so detail UIs can be interactive without intercepting grid
    // scrolling).
    if (this.getDetailContent) {
      this.detailLayer = document.createElement('div');
      this.detailLayer.style.cssText =
        'position:absolute;inset:0;pointer-events:none;overflow:hidden;';
      this.host.appendChild(this.detailLayer);
    }

    // Custom cell renderer overlay: a single layer sized to the host
    // that holds DOM nodes produced by ColumnDef.renderer. pointer-events
    // are inherited from each rendered cell so widgets can be interactive
    // (checkboxes, dropdowns, sparklines), while the layer itself doesn't
    // intercept grid scrolling. Mounted only when at least one column
    // has a renderer — pure-canvas grids don't pay the DOM cost.
    if (this.columns.some((c) => c.renderer)) {
      this.cellOverlayEl = document.createElement('div');
      this.cellOverlayEl.style.cssText =
        'position:absolute;inset:0;pointer-events:none;overflow:hidden;z-index:2;';
      this.host.appendChild(this.cellOverlayEl);
      this.rendererPool = new RendererPool(this.cellOverlayEl);
    }

    // Loading / no-rows overlay layer (wave 24). A single positioned
    // element that the render loop shows/hides based on `loading` +
    // `rowSource.numRows`. Sits below cell-overlay z-index so renderer
    // pool widgets still receive pointer events when only "loading" is
    // ambient (not modal).
    this.overlayEl = document.createElement('div');
    this.overlayEl.setAttribute('role', 'status');
    this.overlayEl.setAttribute('aria-live', 'polite');
    this.overlayEl.style.cssText =
      'position:absolute;left:0;right:0;display:none;' +
      'align-items:center;justify-content:center;flex-direction:column;gap:8px;' +
      `color:${this.theme.mutedText};font-family:${this.theme.fontFamily};` +
      'font-size:12px;pointer-events:none;z-index:1;' +
      'background:rgba(11,13,16,0.6);backdrop-filter:blur(2px);';
    this.host.appendChild(this.overlayEl);
    this.loading = options.loading ?? false;
    this.loadingOverlay = options.loadingOverlay;
    this.noRowsOverlay = options.noRowsOverlay;

    // Find / replace toolbar (wave 25). Mounted only when enableFind is
    // on. Lives above the data band, anchored to the top-right of the
    // host; `display:none` until openFind() / Ctrl+F flips it visible.
    if (this.findEnabled) {
      this.findToolbarEl = document.createElement('div');
      this.findToolbarEl.setAttribute('role', 'toolbar');
      this.findToolbarEl.setAttribute('aria-label', 'Find and replace');
      this.findToolbarEl.style.cssText =
        'position:absolute;top:8px;right:12px;display:none;flex-direction:column;gap:4px;' +
        `background:${this.theme.headerBackground};color:${this.theme.text};` +
        'border:1px solid #2a2f37;border-radius:6px;padding:6px 8px;z-index:5;' +
        `font-family:${this.theme.fontFamily};font-size:12px;` +
        'box-shadow:0 4px 12px rgba(0,0,0,0.5);';
      const buildRow = (
        labelText: string,
        input: HTMLInputElement,
        actions: HTMLButtonElement[],
      ) => {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;gap:4px;';
        const label = document.createElement('span');
        label.textContent = labelText;
        label.style.cssText = `color:${this.theme.mutedText};font-size:11px;min-width:54px;`;
        row.appendChild(label);
        row.appendChild(input);
        for (const a of actions) row.appendChild(a);
        return row;
      };
      this.findInputEl = document.createElement('input');
      this.findInputEl.type = 'search';
      this.findInputEl.placeholder = 'Find';
      this.findInputEl.style.cssText =
        `background:${this.theme.background};color:${this.theme.text};` +
        'border:1px solid #2a2f37;border-radius:3px;padding:2px 6px;width:160px;font-size:12px;';
      this.findInputEl.addEventListener('input', () => {
        this.setFindQuery(this.findInputEl?.value ?? '');
      });
      this.findInputEl.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          this.closeFind();
          e.preventDefault();
        } else if (e.key === 'Enter') {
          if (e.shiftKey) this.findPrev();
          else this.findNext();
          e.preventDefault();
        }
      });
      const mkBtn = (text: string, onClick: () => void) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = text;
        b.style.cssText =
          `background:${this.theme.background};color:${this.theme.text};` +
          'border:1px solid #2a2f37;border-radius:3px;padding:2px 6px;font-size:11px;cursor:pointer;';
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          onClick();
        });
        return b;
      };
      const prevBtn = mkBtn('▲', () => this.findPrev());
      prevBtn.setAttribute('aria-label', 'Previous match');
      const nextBtn = mkBtn('▼', () => this.findNext());
      nextBtn.setAttribute('aria-label', 'Next match');
      const closeBtn = mkBtn('✕', () => this.closeFind());
      closeBtn.setAttribute('aria-label', 'Close find');
      this.findToolbarEl.appendChild(
        buildRow('Find', this.findInputEl, [prevBtn, nextBtn, closeBtn]),
      );
      this.replaceInputEl = document.createElement('input');
      this.replaceInputEl.type = 'text';
      this.replaceInputEl.placeholder = 'Replace';
      this.replaceInputEl.style.cssText = this.findInputEl.style.cssText;
      const replaceBtn = mkBtn('Replace', () => this.replaceCurrent());
      const replaceAllBtn = mkBtn('Replace all', () => {
        const replaceWith = this.replaceInputEl?.value ?? '';
        this.replaceAll(replaceWith);
      });
      this.findToolbarEl.appendChild(
        buildRow('Replace', this.replaceInputEl, [replaceBtn, replaceAllBtn]),
      );
      this.host.appendChild(this.findToolbarEl);
    }
    if (options.flash?.durationMs !== undefined) {
      this.flashDurationMs = options.flash.durationMs;
    }
    if (options.flash?.color !== undefined) {
      this.flashColor = options.flash.color;
    }

    // Floating filter row: a DOM band below the header with one
    // <input role="searchbox"> per column. Mounted only when enabled.
    if (this.floatingFiltersEnabled) {
      const band = document.createElement('div');
      band.setAttribute('role', 'toolbar');
      band.setAttribute('aria-label', 'Column filters');
      band.setAttribute('aria-controls', this.gridId);
      band.style.cssText =
        `position:absolute;left:0;right:0;height:${String(FLOATING_FILTER_ROW_HEIGHT)}px;` +
        `background:${this.theme.headerBackground};border-bottom:1px solid #2a2f37;` +
        'z-index:4;display:flex;overflow:hidden;';
      this.host.appendChild(band);
      this.floatingFilterBandEl = band;
      this.buildFloatingFilterInputs();
    }

    // Drag-to-group pill bar (v1.3): a strip at the very top of the host
    // holding one pill per active group-by column. Folded into
    // fullHeaderHeight() so the data band sits below it.
    if (this.groupBarEnabled) {
      const bar = document.createElement('div');
      bar.setAttribute('role', 'toolbar');
      bar.setAttribute('aria-label', 'Group by columns');
      bar.setAttribute('aria-controls', this.gridId);
      bar.style.cssText =
        `position:absolute;left:0;right:0;top:0;height:${String(GROUP_BAR_HEIGHT)}px;` +
        `background:${this.theme.headerBackground};color:${this.theme.text};` +
        'border-bottom:1px solid #2a2f37;z-index:4;display:flex;align-items:center;' +
        `gap:6px;padding:0 10px;overflow:hidden;font-family:${this.theme.fontFamily};` +
        'font-size:12px;box-sizing:border-box;';
      this.host.appendChild(bar);
      this.groupBarEl = bar;
      this.renderGroupBar();
    }

    // Aggregation side panel (v1.3): a docked aside on the right edge,
    // floating over the data band (no layout-math change). Hidden until
    // opened unless aggregationPanelOpen was set.
    if (this.aggregationPanelEnabled) {
      this.aggregationPanelEl = this.buildSidePanel('Aggregation', 'Aggregation panel');
      this.host.appendChild(this.aggregationPanelEl);
      this.renderAggregationPanel();
      if (options.aggregationPanelOpen) this.openAggregationPanel();
    }

    // Filter side panel (v1.3): docked right-edge aside, batched Apply.
    if (this.filterPanelEnabled) {
      this.filterPanelEl = this.buildSidePanel('Filters', 'Filter panel');
      this.host.appendChild(this.filterPanelEl);
      this.renderFilterPanel();
      if (options.filterPanelOpen) this.openFilterPanel();
    }

    // Tooltip: a shared element re-targeted per hovered cell. Mounted
    // only when at least one column has a tooltip provider.
    if (this.columns.some((c) => c.tooltip)) {
      const tip = document.createElement('div');
      tip.setAttribute('role', 'tooltip');
      tip.style.cssText =
        'position:absolute;display:none;box-sizing:border-box;' +
        'background:#1b1f26;color:#e7e9ec;border:1px solid #2a2f37;' +
        'padding:6px 10px;border-radius:4px;max-width:320px;' +
        `font-family:${this.theme.fontFamily};font-size:${String(this.theme.fontSize - 1)}px;` +
        'line-height:1.35;pointer-events:none;z-index:10;' +
        'box-shadow:0 4px 12px rgba(0,0,0,0.4);';
      this.host.appendChild(tip);
      this.tooltipEl = tip;
    }

    // Status bar: a single absolute-positioned div pinned to the host's
    // bottom edge. The render loop writes its text content; layout never
    // shifts because the canvas already accounts for statusBarHeight().
    if (this.statusBarEnabled) {
      this.statusBarEl = document.createElement('div');
      this.statusBarEl.style.cssText =
        `position:absolute;left:0;right:0;bottom:0;height:${String(STATUS_BAR_HEIGHT)}px;` +
        `background:${this.theme.headerBackground};color:${this.theme.mutedText};` +
        'border-top:1px solid #2a2f37;display:flex;align-items:center;gap:18px;' +
        `padding:0 14px;font-family:${this.theme.fontFamily};font-size:11px;` +
        'font-variant-numeric:tabular-nums;pointer-events:none;user-select:none;z-index:3;';
      this.host.appendChild(this.statusBarEl);
    }

    this.cumulativeColumnWidths = new Float32Array(this.columns.length + 1);
    this.recomputeColumnLayout();

    this.resizeObserver = new ResizeObserver(() => {
      this.handleResize();
    });
    this.resizeObserver.observe(this.host);
    this.scrollHost.addEventListener('scroll', this.handleScroll, { passive: true });
    this.scrollHost.addEventListener('pointerdown', this.handlePointerDown);
    this.scrollHost.addEventListener('pointermove', this.handlePointerMove);
    this.scrollHost.addEventListener('pointerleave', this.handlePointerLeave);
    this.scrollHost.addEventListener('dblclick', this.handleDoubleClick);
    this.scrollHost.addEventListener('contextmenu', this.handleContextMenu);
    window.addEventListener('pointerup', this.handlePointerUp);
    window.addEventListener('keydown', this.handleKeyDown);
    window.addEventListener('paste', this.handlePaste);

    this.handleResize();
    this.scheduleRender();

    try {
      this.debugLog = new URLSearchParams(window.location.search).get('debug') === '1';
    } catch {
      this.debugLog = false;
    }
  }

  // ---------------------------------------------------------------------------
  // Public imperative API
  // ---------------------------------------------------------------------------

  /** Replace the live column array. Recomputes layout and triggers a
   *  redraw without remounting the host — preserves scroll position
   *  and selection by *id* (selection by *index* may shift when the
   *  column count or order changes). Use this to reorder or hide
   *  columns from outside (e.g. a tool-panel sidebar) without paying
   *  the cost of a full Grid teardown. */
  setColumns(columns: ReadonlyArray<ColumnDef>): void {
    this.columns = [...columns];
    this.cumulativeColumnWidths = new Float32Array(this.columns.length + 1);
    this.recomputeColumnLayout();
    this.scrollSpacer.style.width = `${this.totalColumnsWidth}px`;
    this.scrollHost.setAttribute('aria-colcount', String(this.columns.length));
    this.scheduleRender();
  }

  /** Returns a snapshot of the current column array. The returned
   *  array is a copy — mutating it does not affect the Grid. */
  getColumns(): ReadonlyArray<ColumnDef> {
    return [...this.columns];
  }

  /**
   * Read the current viewport / scroll state. Useful for E2E tests
   * that need to assert on the *logical* scroll position (not the
   * physical scrollHost.scrollTop, which is scaled by the virtual-
   * scroll cap for >16 Mpx datasets).
   */
  getViewportInfo(): {
    readonly scrollTop: number;
    readonly scrollLeft: number;
    readonly scrollScale: number;
    readonly totalHeight: number;
    readonly numRows: number;
    readonly viewportWidth: number;
    readonly viewportHeight: number;
    readonly firstVisibleRow: number;
    readonly lastVisibleRow: number;
  } {
    const dataTop = this.dataBandTop();
    const dataBottom = this.dataBandBottom();
    const dataHeight = Math.max(0, dataBottom - dataTop);
    const numRows = this.rowSource.numRows;
    const first = numRows === 0 ? 0 : this.fenwick.indexAtOffset(this.scrollTop);
    const last =
      numRows === 0
        ? 0
        : Math.min(numRows - 1, this.fenwick.indexAtOffset(this.scrollTop + dataHeight));
    return {
      scrollTop: this.scrollTop,
      scrollLeft: this.scrollLeft,
      scrollScale: this.scrollScale,
      totalHeight: this.fenwick.totalHeight,
      numRows,
      viewportWidth: this.viewportWidth,
      viewportHeight: this.viewportHeight,
      firstVisibleRow: first,
      lastVisibleRow: last,
    };
  }

  setRowSource(rowSource: RowSource, rowHeight: number | Float32Array): void {
    this.rowSource = rowSource;
    // Update baseHeights too — not just fenwick. Without this, a later
    // setExpanded / toggleExpanded (which React fires when the
    // expandedRows state resets on mode or numRows change) calls
    // rebuildHeightsFromExpansion() which rebuilds fenwick from the
    // STALE baseHeights, instantly reverting the fenwick to whatever
    // size the previous dataset had. Symptom: visible-row meter caps
    // at the previous dataset's last row even after switching to a
    // larger dataset.
    this.baseHeights =
      typeof rowHeight === 'number'
        ? new Float32Array(rowSource.numRows).fill(rowHeight)
        : new Float32Array(rowHeight); // copy so consumer's array isn't mutated downstream
    this.fenwick = new FenwickHeights(this.computeEffectiveHeights());
    this.scrollHost.setAttribute('aria-rowcount', String(rowSource.numRows));
    this.scrollTop = 0;
    this.scrollLeft = 0;
    this.scrollHost.scrollTo(0, 0);
    this.lastRenderedScrollTop = -1;
    this.lastRenderedScrollLeft = -1;
    this.recomputeColumnLayout();
    this.updateScrollSpacerHeight();
    this.scheduleRender();
  }

  /**
   * Swap the pinned-bottom row source live (e.g., a totals row whose
   * sums depend on cell edits). Pass `undefined` to remove the pinned
   * bottom band entirely.
   */
  setPinnedBottomRowSource(rowSource: RowSource | undefined): void {
    const hadBefore = this.pinnedBottomRowSource;
    this.pinnedBottomRowSource = rowSource;
    // Mounting / unmounting the pinned-bottom band changes the data
    // band height, so the cell-overlay clip needs to shrink/grow to
    // match. (Re-applying inset() with the same numbers is cheap.)
    if (!hadBefore !== !rowSource) {
      this.updateCellOverlayBounds();
    }
    this.scheduleRender();
  }

  /**
   * Swap the pinned-top row source live. Symmetric with
   * `setPinnedBottomRowSource`.
   */
  setPinnedTopRowSource(rowSource: RowSource | undefined): void {
    const hadBefore = this.pinnedTopRowSource;
    this.pinnedTopRowSource = rowSource;
    if (!hadBefore !== !rowSource) {
      this.updateCellOverlayBounds();
    }
    this.scheduleRender();
  }

  scrollBy(deltaY: number): void {
    this.setLogicalScrollTop(this.scrollTop + deltaY);
    this.scheduleRender();
  }

  scrollToRow(rowIndex: number): void {
    const clamped = Math.max(0, Math.min(rowIndex, this.rowSource.numRows - 1));
    this.setLogicalScrollTop(this.fenwick.prefixSum(clamped));
    this.scheduleRender();
  }

  getMetricsSnapshot(): MetricsSnapshot {
    const frames = this.framesInOrder();
    const frameCount = frames.length;
    if (frameCount === 0) return EMPTY_SNAPSHOT;
    const first = frames[0]!;
    const last = frames[frameCount - 1]!;
    const windowMs = last.ts - first.ts;

    const intervals: number[] = [];
    let scrollPxTotal = 0;
    let cellsTotal = 0;
    let long16 = 0;
    let long33 = 0;
    let long50 = 0;
    for (let i = 1; i < frameCount; i++) {
      const cur = frames[i]!;
      const prev = frames[i - 1]!;
      const dt = cur.ts - prev.ts;
      intervals.push(dt);
      if (dt > 16.7) long16++;
      if (dt > 33.4) long33++;
      if (dt > 50) long50++;
      scrollPxTotal += cur.scrollDelta;
      cellsTotal += cur.cells;
    }
    cellsTotal += first.cells;

    const draws = frames.map((f) => f.drawDurationMs);
    const fpsAvg =
      windowMs > 0 ? Math.round(((frameCount - 1) / windowMs) * 1000 * 10) / 10 : 0;

    const heap =
      typeof performance !== 'undefined' && (performance as PerformanceWithMemory).memory
        ? (performance as PerformanceWithMemory).memory!.usedJSHeapSize
        : undefined;

    return {
      windowMs: Math.round(windowMs),
      frameCount,
      fpsAvg,
      intervalMsP50: percentile(intervals, 0.5),
      intervalMsP95: percentile(intervals, 0.95),
      intervalMsP99: percentile(intervals, 0.99),
      drawMsP50: percentile(draws, 0.5),
      drawMsP95: percentile(draws, 0.95),
      drawMsP99: percentile(draws, 0.99),
      longFramesGt16: long16,
      longFramesGt33: long33,
      longFramesGt50: long50,
      scrollPxTotal: Math.round(scrollPxTotal),
      cellsPerFrameAvg: Math.round(cellsTotal / frameCount),
      ...(heap !== undefined ? { heapUsedBytes: heap } : {}),
    };
  }

  resetMetrics(): void {
    this.frameBuffer.length = 0;
    this.frameBufferHead = 0;
  }

  /** Force a redraw on the next animation frame. */
  refresh(): void {
    this.lastRenderedScrollTop = -1;
    this.scheduleRender();
  }

  /** Replace the current sort and redraw header indicators. Caller is
   *  responsible for re-fetching / re-sorting the underlying data. */
  setSort(sort: SortModel): void {
    this.sort = sort;
    this.refresh();
  }

  // ---------------------------------------------------------------------------
  // Master-detail (expandable rows) — public API
  // ---------------------------------------------------------------------------

  /** Replace the expanded set. Triggers a layout pass + redraw so heights
   *  update and detail panels mount/unmount as needed. */
  setExpanded(expanded: ReadonlySet<number> | ReadonlyArray<number>): void {
    this.expanded = new Set(expanded);
    this.rebuildHeightsFromExpansion();
    this.handleResize();
    this.refresh();
  }

  /** Toggle a single row's expansion. */
  toggleExpanded(rowIndex: number): void {
    if (this.expanded.has(rowIndex)) {
      this.expanded.delete(rowIndex);
    } else {
      this.expanded.add(rowIndex);
    }
    this.onToggleExpand?.(rowIndex);
    this.rebuildHeightsFromExpansion();
    this.handleResize();
    this.refresh();
  }

  isExpanded(rowIndex: number): boolean {
    return this.expanded.has(rowIndex);
  }

  destroy(): void {
    this.destroyed = true;
    if (this.rafHandle !== null) cancelAnimationFrame(this.rafHandle);
    this.resizeObserver.disconnect();
    this.scrollHost.removeEventListener('scroll', this.handleScroll);
    this.scrollHost.removeEventListener('pointerdown', this.handlePointerDown);
    this.scrollHost.removeEventListener('pointermove', this.handlePointerMove);
    this.scrollHost.removeEventListener('pointerleave', this.handlePointerLeave);
    this.scrollHost.removeEventListener('dblclick', this.handleDoubleClick);
    this.scrollHost.removeEventListener('contextmenu', this.handleContextMenu);
    window.removeEventListener('pointerup', this.handlePointerUp);
    window.removeEventListener('keydown', this.handleKeyDown);
    window.removeEventListener('paste', this.handlePaste);
    // Only remove the elements we appended — leave any framework-owned
    // siblings alone.
    this.canvas.remove();
    this.scrollHost.remove();
    this.a11yMount.remove();
    this.overlayEl.remove();
    this.findToolbarEl?.remove();
    this.rowDragIndicatorEl?.remove();
    this.detailLayer?.remove();
    this.editorEl?.remove();
    this.editorEl = null;
    this.editorInstance?.destroy?.();
    this.editorInstance?.element.remove();
    this.editorInstance = null;
    this.editorErrorEl?.remove();
    this.editorErrorEl = null;
    this.editorAsyncAbort?.abort();
    this.editorAsyncAbort = null;
    if (this.editorInputDebounce !== null) {
      clearTimeout(this.editorInputDebounce);
      this.editorInputDebounce = null;
    }
    this.liveAnnouncer?.destroy();
    this.liveAnnouncer = null;
    this.rendererPool?.destroy();
    this.rendererPool = null;
    this.cellOverlayEl?.remove();
    this.cellOverlayEl = null;
    this.activeRendererCells.clear();
    if (this.tooltipShowTimer !== null) {
      clearTimeout(this.tooltipShowTimer);
      this.tooltipShowTimer = null;
    }
    this.tooltipEl?.remove();
    this.tooltipEl = null;
    this.floatingFilterBandEl?.remove();
    this.floatingFilterBandEl = null;
    this.floatingFilterInputs.clear();
    this.groupBarEl?.remove();
    this.groupBarEl = null;
    this.aggregationPanelEl?.remove();
    this.aggregationPanelEl = null;
    this.filterPanelEl?.remove();
    this.filterPanelEl = null;
    this.statusBarEl?.remove();
    this.statusBarEl = null;
    // Tear down any still-mounted detail panels so nested Grids /
    // framework roots inside them get a chance to clean up.
    if (this.onDetailUnmount) {
      for (const [row, panel] of this.mountedDetails) {
        const userContent = panel.firstChild as HTMLElement | null;
        if (userContent) this.onDetailUnmount(row, userContent);
      }
    }
    this.mountedDetails.clear();
  }

  /** Combine baseHeights + detailHeight per expanded row into the array
   *  the FenwickHeights tree consumes. Cheap: ~1 alloc + O(rows) iteration.
   *  Called on expansion changes. */
  private computeEffectiveHeights(): Float32Array {
    if (this.expanded.size === 0) return this.baseHeights;
    const out = new Float32Array(this.baseHeights.length);
    for (let i = 0; i < this.baseHeights.length; i++) {
      out[i] = (this.baseHeights[i] ?? 0) + (this.expanded.has(i) ? this.detailHeight : 0);
    }
    return out;
  }

  private rebuildHeightsFromExpansion(): void {
    this.fenwick = new FenwickHeights(this.computeEffectiveHeights());
  }

  // ---------------------------------------------------------------------------
  // Selection
  // ---------------------------------------------------------------------------

  getSelection(): SelectionSnapshot {
    return this.selection.snapshot();
  }

  /** Ascending, de-duplicated list of every row index touched by any
   *  current selection range. Used by row drag-reorder to decide the
   *  travelling block. Empty when nothing is selected. */
  private selectedRowIndices(): number[] {
    const seen = new Set<number>();
    for (const norm of this.selection.normalizedRanges()) {
      for (let r = norm.rowStart; r <= norm.rowEnd; r++) seen.add(r);
    }
    return Array.from(seen).sort((a, b) => a - b);
  }

  selectCell(pos: CellPosition): void {
    this.selection.selectCell(pos);
    this.notifySelectionChange();
    this.scheduleRender();
  }

  clearSelection(): void {
    this.selection.clear();
    this.notifySelectionChange();
    this.scheduleRender();
  }

  selectAll(): void {
    this.selection.selectAll(this.rowSource.numRows, this.columns.length);
    this.notifySelectionChange();
    this.scheduleRender();
  }

  /**
   * Serialize the current selection as TSV (Excel/Sheets-compatible) and
   * write it to the system clipboard. Returns the TSV string for testability.
   */
  async copySelectionToClipboard(): Promise<string> {
    const tsv = this.selection.toTsv((row, col) => {
      const column = this.columns[col];
      if (!column) return '';
      const value = this.rowSource.getCell(row, column.id);
      return column.format ? column.format(value, row) : String(value ?? '');
    });
    if (tsv && typeof navigator !== 'undefined' && navigator.clipboard) {
      try {
        await navigator.clipboard.writeText(tsv);
      } catch {
        // Clipboard write can fail in non-secure contexts; the caller still
        // gets the string back and can use a custom fallback.
      }
    }
    return tsv;
  }

  private notifySelectionChange(): void {
    this.updateActiveDescendant();
    this.onSelectionChange?.(this.selection.snapshot());
  }

  /** Mirror the active cell into `aria-activedescendant` on the grid root.
   *  The id resolves to a `<td role="gridcell">` in the a11y shadow; the
   *  shadow expands its render window to include the active row so the
   *  attribute always points at a live DOM node. */
  private updateActiveDescendant(): void {
    const active = this.selection.active;
    if (!active) {
      this.scrollHost.removeAttribute('aria-activedescendant');
      return;
    }
    this.scrollHost.setAttribute(
      'aria-activedescendant',
      ariaCellId(this.gridId, active.row, active.col),
    );
  }

  // ---------------------------------------------------------------------------
  // Layout
  // ---------------------------------------------------------------------------

  private recomputeColumnLayout(): void {
    this.cumulativeColumnWidths = new Float32Array(this.columns.length + 1);
    let acc = 0;
    for (let i = 0; i < this.columns.length; i++) {
      acc += this.columns[i]?.width ?? 0;
      this.cumulativeColumnWidths[i + 1] = acc;
    }
    this.totalColumnsWidth = acc;
    let frozen = 0;
    for (let i = 0; i < this.frozenColumnCount; i++) {
      frozen += this.columns[i]?.width ?? 0;
    }
    this.frozenWidth = frozen;
  }

  private handleResize = (): void => {
    const rect = this.host.getBoundingClientRect();
    const newDpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    const newViewportWidth = Math.max(0, Math.floor(rect.width));
    const newViewportHeight = Math.max(0, Math.floor(rect.height));
    const sameDimensions =
      newViewportWidth === this.viewportWidth &&
      newViewportHeight === this.viewportHeight &&
      newDpr === this.dpr;
    if (sameDimensions) return;
    // Distinguish a "real" resize (user resized window, sidebar toggled,
    // DPR changed) from "jitter" (toolbar reflowing by 1-2 px because a
    // sibling element's text content changed digit count). The canvas
    // buffer only needs to be reallocated for real resizes — jitter
    // just needs the layout-dependent state updated.
    //
    // Reassigning canvas.width / .height CLEARS the canvas to
    // transparent regardless of whether the value changed. During a
    // column-resize drag the toolbar's FPS / draw-ms / visible-row
    // meter fluctuates digit count each frame, the toolbar's
    // flex-wrap repacks, and the host height ticks ±1 px. Treating
    // those as real resizes would flash the entire canvas on every
    // drag frame — exactly the head-to-toe flicker the user reports.
    const widthJitter = Math.abs(newViewportWidth - this.viewportWidth);
    const heightJitter = Math.abs(newViewportHeight - this.viewportHeight);
    const dprChanged = newDpr !== this.dpr;
    const isJitter = !dprChanged && widthJitter <= 2 && heightJitter <= 2;
    this.dpr = newDpr;
    this.viewportWidth = newViewportWidth;
    this.viewportHeight = newViewportHeight;
    if (!isJitter) {
      this.canvas.width = Math.floor(this.viewportWidth * this.dpr);
      this.canvas.height = Math.floor(this.viewportHeight * this.dpr);
      this.canvas.style.width = `${this.viewportWidth}px`;
      this.canvas.style.height = `${this.viewportHeight}px`;
    }
    this.scrollSpacer.style.width = `${this.totalColumnsWidth}px`;
    this.updateScrollSpacerHeight();
    this.updateCellOverlayBounds();
    this.lastRenderedScrollTop = -1;
    // Reassigning canvas.width / .height clears the canvas to
    // transparent. If we waited for the next rAF to redraw, the
    // browser would paint the blank canvas in between — visible as
    // a head-to-toe flicker on every window resize tick. Render
    // synchronously inside the same task so the canvas is never
    // observably blank.
    if (!isJitter) {
      this.render();
      this.lastRenderedScrollTop = this.scrollTop;
      this.lastRenderedScrollLeft = this.scrollLeft;
    } else {
      this.scheduleRender();
    }
  };

  /**
   * Clip the DOM cell overlay (status pills, score bars, sparklines)
   * to the data band only — below the header + floating filter band,
   * above the pinned-bottom totals row + status bar. Without this clip
   * the overlay's `inset:0` made it cover the whole host and DOM cells
   * positioned at canvas-row coordinates could paint over the header
   * or the totals row when they were physically inside those bands
   * (visible as status / score pills appearing above the totals row
   * and the filter row during scroll).
   *
   * Uses CSS `clip-path: inset(...)` so the overlay's coordinate
   * system stays host-relative — `syncCellOverlay` positions each
   * DOM cell with the same `top` value that the canvas renderer
   * draws into, and the clip-path simply hides anything outside the
   * data band region. No coordinate rebase needed.
   *
   * Called from handleResize. Pinned-band height changes route through
   * handleResize too via the existing pinned-source setters.
   */
  private updateCellOverlayBounds(): void {
    if (!this.cellOverlayEl) return;
    const top = this.dataBandTop();
    const bottomBands =
      this.pinnedBottomBandHeight() + this.statusBarHeight();
    // `inset(top right bottom left)` — DOM cells outside this rectangle
    // are not painted. The overlay itself still spans the host, so cell
    // positioning math (which expects host-relative top) is unchanged.
    this.cellOverlayEl.style.clipPath = `inset(${top}px 0px ${bottomBands}px 0px)`;
  }

  /**
   * Recompute the spacer's physical height and the virtualization
   * scale. Call after anything that changes `fenwick.totalHeight` or
   * the surrounding band heights (resize, setRowSource, group toggle,
   * detail expand, etc.).
   */
  private updateScrollSpacerHeight(): void {
    const bands = this.dataBandTop() + this.pinnedBottomBandHeight() + this.statusBarHeight();
    const logicalTotal = bands + this.fenwick.totalHeight;
    const previousScale = this.scrollScale;
    if (logicalTotal <= VIRTUAL_SCROLL_CAP_PX) {
      this.scrollSpacer.style.height = `${String(logicalTotal)}px`;
      if (previousScale !== 1) {
        this.scrollScale = 1;
        // Re-derive logical scrollTop from the current physical scroll
        // position so the next handleScroll doesn't compute a bogus
        // delta against a stale-scale value.
        this.scrollTop = this.scrollHost.scrollTop;
      }
      return;
    }
    this.scrollSpacer.style.height = `${String(VIRTUAL_SCROLL_CAP_PX)}px`;
    // Read back the *actually rendered* spacer height. Browsers cap
    // CSS element heights below our requested value on some engines
    // (Firefox ~17.9 Mpx, mobile Safari lower). If the browser clamped
    // to e.g. 10 Mpx, scale must be derived from that clamped value
    // — otherwise the physical scrollbar's max maps to only a fraction
    // of the logical data, the bottom rows become unreachable, and
    // (worse) the scrollbar can appear to "reset" because handleScroll
    // sees a smaller physical max than we expect.
    //
    // Reading offsetHeight forces a layout flush so we get the
    // post-clamp value in the same turn.
    const physicalSpacer = this.scrollSpacer.offsetHeight;
    const newScale = computeScrollScale(logicalTotal, this.viewportHeight, physicalSpacer);
    if (newScale !== previousScale) {
      this.scrollScale = newScale;
      // Keep this.scrollTop in sync with the new scale. Without this,
      // a mid-session resize (toolbar wrap, FPS-pill widening, host
      // pane resize) would leave handleScroll computing deltas across
      // two different scales, which appears to the user as the row
      // counter going backwards while scrolling down.
      this.scrollTop = this.scrollHost.scrollTop * newScale;
    }
  }

  /**
   * Set the host's scrollTop in *logical* (data-pixel) coordinates.
   * Internally divides by `scrollScale` so the physical scrollbar
   * position lands at the right fraction of the spacer.
   */
  private setLogicalScrollTop(logicalY: number): void {
    const clamped = Math.max(0, logicalY);
    this.suppressScrollEvent = true;
    this.scrollHost.scrollTop = logicalToPhysical(clamped, this.scrollScale);
    this.suppressScrollEvent = false;
    this.scrollTop = clamped;
  }

  private handleScroll = (): void => {
    if (this.suppressScrollEvent) return;
    const newTop = physicalToLogical(this.scrollHost.scrollTop, this.scrollScale);
    const newLeft = this.scrollHost.scrollLeft;
    const delta = newTop - this.scrollTop;
    this.velocity = Math.abs(delta);
    // EMA — α = 0.4 retains responsiveness while damping single-frame
    // trackpad-inertia spikes (60 fps × 16 ms × ~7 frames to converge).
    this.velocitySmoothed =
      this.velocitySmoothed * 0.6 + this.velocity * 0.4;
    this.scrollDirection = delta > 0 ? 1 : delta < 0 ? -1 : this.scrollDirection;
    this.scrollTop = newTop;
    this.scrollLeft = newLeft;
    // Tooltip dismiss on scroll: anchored content makes no sense once
    // its anchor moves under the pointer.
    if (this.tooltipEl) this.hideTooltip();
    this.scheduleRender();
  };

  private handleKeyDown = (e: KeyboardEvent): void => {
    if (document.activeElement !== this.scrollHost) return;

    // Escape dismisses any showing tooltip — WCAG 1.4.13 dismissable
    // requirement for content-on-hover.
    if (e.key === 'Escape' && this.tooltipEl?.style.display === 'block') {
      this.hideTooltip();
      e.preventDefault();
      return;
    }

    // Ctrl/Cmd + C → copy selection as TSV.
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'c') {
      void this.copySelectionToClipboard();
      e.preventDefault();
      return;
    }
    // Ctrl/Cmd + A → select all.
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a') {
      this.selectAll();
      e.preventDefault();
      return;
    }
    // Ctrl/Cmd + F → open find toolbar (wave 25).
    if (this.findEnabled && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') {
      this.openFind();
      e.preventDefault();
      return;
    }

    // F2 / Enter → begin editing the active cell with current value
    // pre-selected. Excel/Sheets convention.
    const active = this.selection.active;
    if (active && (e.key === 'F2' || e.key === 'Enter') && !e.metaKey && !e.ctrlKey && !e.altKey) {
      if (this.isEditableAt(active.row, active.col)) {
        this.beginEdit(active.row, active.col);
        e.preventDefault();
        return;
      }
    }
    // Delete / Backspace → clear active cell via empty edit. Bypasses the
    // editor so power users can blow through ranges.
    if (active && (e.key === 'Delete' || e.key === 'Backspace') && !e.metaKey && !e.ctrlKey) {
      const column = this.columns[active.col];
      if (column && this.isEditableAt(active.row, active.col)) {
        const oldValue = this.rowSource.getCell(active.row, column.id);
        this.onCellEdit?.(active.row, column.id, '', oldValue);
        e.preventDefault();
        return;
      }
    }
    // Type-ahead: any printable single character with no modifiers
    // (other than Shift) opens the editor with that character as the
    // initial value, replacing whatever was in the cell.
    if (
      active &&
      e.key.length === 1 &&
      !e.metaKey &&
      !e.ctrlKey &&
      !e.altKey &&
      this.isEditableAt(active.row, active.col)
    ) {
      this.beginEdit(active.row, active.col, e.key);
      e.preventDefault();
      return;
    }

    // Wave 24 — Excel-class keyboard nav.
    //
    // Ctrl+Home → first cell (0,0). Ctrl+End → last cell. Excel/Sheets
    // convention; shift extends selection rather than moves.
    if ((e.metaKey || e.ctrlKey) && e.key === 'Home') {
      this.gotoCell(0, 0, e.shiftKey);
      e.preventDefault();
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 'End') {
      this.gotoCell(this.rowSource.numRows - 1, this.columns.length - 1, e.shiftKey);
      e.preventDefault();
      return;
    }
    // Home / End without modifier → row-extent navigation.
    if (e.key === 'Home' && !e.metaKey && !e.ctrlKey) {
      if (active) this.gotoCell(active.row, 0, e.shiftKey);
      e.preventDefault();
      return;
    }
    if (e.key === 'End' && !e.metaKey && !e.ctrlKey) {
      if (active) this.gotoCell(active.row, this.columns.length - 1, e.shiftKey);
      e.preventDefault();
      return;
    }
    // Ctrl+arrow → jump to the edge of the data block in the arrow's
    // direction. Excel "go to extent" behavior. For now (no per-cell
    // emptiness model) we jump to the dataset edge — the most common
    // expectation for a dense grid.
    if (
      (e.metaKey || e.ctrlKey) &&
      (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'ArrowLeft' || e.key === 'ArrowRight')
    ) {
      if (active) {
        const dr =
          e.key === 'ArrowDown' ? this.rowSource.numRows - 1 - active.row
          : e.key === 'ArrowUp' ? -active.row
          : 0;
        const dc =
          e.key === 'ArrowRight' ? this.columns.length - 1 - active.col
          : e.key === 'ArrowLeft' ? -active.col
          : 0;
        this.gotoCell(active.row + dr, active.col + dc, e.shiftKey);
      }
      e.preventDefault();
      return;
    }
    // PageUp / PageDown — jump by one viewport's worth of rows.
    if (e.key === 'PageDown' || e.key === 'PageUp') {
      if (active) {
        const dataHeight = this.dataBandBottom() - this.dataBandTop();
        const approxRowHeight = this.baseHeights[active.row] ?? 28;
        const rows = Math.max(1, Math.floor(dataHeight / approxRowHeight));
        const dr = e.key === 'PageDown' ? rows : -rows;
        this.gotoCell(
          Math.max(0, Math.min(this.rowSource.numRows - 1, active.row + dr)),
          active.col,
          e.shiftKey,
        );
      }
      e.preventDefault();
      return;
    }

    // Selection-aware arrow keys: extend with shift, replace without.
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const dr = e.key === 'ArrowDown' ? 1 : e.key === 'ArrowUp' ? -1 : 0;
      const dc = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      if (e.shiftKey && !this.selection.isEmpty()) {
        this.selection.extendActiveBy(dr, dc, this.rowSource.numRows, this.columns.length);
      } else {
        this.selection.moveActive(dr, dc, this.rowSource.numRows, this.columns.length);
      }
      this.notifySelectionChange();
      this.scrollActiveIntoView();
      this.scheduleRender();
      e.preventDefault();
      return;
    }

    // Fallback: scroll-only nav.
    const pageStep = Math.max(1, Math.floor(this.viewportHeight / 24));
    let delta = 0;
    if (e.key === 'PageDown') delta = pageStep * 24;
    else if (e.key === 'PageUp') delta = -pageStep * 24;
    else if (e.key === 'Home') {
      this.setLogicalScrollTop(0);
      this.scheduleRender();
      e.preventDefault();
      return;
    } else if (e.key === 'End') {
      this.setLogicalScrollTop(this.fenwick.totalHeight);
      this.scheduleRender();
      e.preventDefault();
      return;
    } else return;
    this.setLogicalScrollTop(this.scrollTop + delta);
    this.scheduleRender();
    e.preventDefault();
  };

  // ---------------------------------------------------------------------------
  // Pointer events → selection
  // ---------------------------------------------------------------------------

  private handlePointerDown = (e: PointerEvent): void => {
    const rect = this.host.getBoundingClientRect();
    const localY = e.clientY - rect.top;
    const localX = e.clientX - rect.left;

    const fullHeader = this.fullHeaderHeight();
    const dataTop = this.dataBandTop();

    // Column resize hit-test (highest priority in the header band):
    // pointer landing inside the rightmost RESIZE_HANDLE_PX of a
    // column header enters resize mode. Hit-zone is 6 px on either
    // side of the boundary so the cursor finds it without precision.
    if (
      this.columnResizeEnabled &&
      localY >= 0 &&
      localY < fullHeader
    ) {
      const colAtBoundary = this.columnAtRightBoundary(localX);
      if (colAtBoundary !== null && this.columns[colAtBoundary]) {
        this.resizeColumn = colAtBoundary;
        this.resizeStartClientX = e.clientX;
        this.resizeStartWidth = this.columns[colAtBoundary]!.width;
        this.suppressSelectionUntilUp = true;
        try {
          this.scrollHost.setPointerCapture(e.pointerId);
        } catch {
          // capture refused — fall back to window pointerup
        }
        return;
      }
    }

    // Row resize hit-test (wave 24): pointer in the bottom RESIZE_HANDLE_PX
    // of any visible data row enters row-resize mode. Lives below the
    // column-resize check so column resize wins on header boundaries.
    if (this.rowResizeEnabled && localY >= dataTop) {
      const rowAtBoundary = this.rowAtBottomBoundary(localY);
      if (rowAtBoundary !== null) {
        this.resizeRow = rowAtBoundary;
        this.resizeStartClientY = e.clientY;
        this.resizeStartHeight = this.baseHeights[rowAtBoundary] ?? 0;
        this.suppressSelectionUntilUp = true;
        try {
          this.scrollHost.setPointerCapture(e.pointerId);
        } catch {
          // ignore
        }
        return;
      }
    }

    // Row drag-reorder candidate (wave 26). Pointerdown inside any cell
    // of `rowDragColumnId` captures a candidate; promotes to active drag
    // once the pointer crosses the 6-px threshold. Lives below the row-
    // resize check so resize wins on row boundaries.
    if (this.rowDragColumnId && this.onRowReorder && localY >= dataTop) {
      const cell = this.cellAtClient(e.clientX, e.clientY);
      const col = cell ? this.columns[cell.col] : undefined;
      if (cell && col && col.id === this.rowDragColumnId) {
        this.rowDragCandidateRow = cell.row;
        this.rowDragCandidateClientY = e.clientY;
        this.suppressSelectionUntilUp = true;
        try {
          this.scrollHost.setPointerCapture(e.pointerId);
        } catch {
          // ignore
        }
        return;
      }
    }

    // Header click? When column reorder is enabled, capture a drag
    // candidate and defer the onHeaderClick fire to pointerup — that
    // way a tap still toggles sort while a drag enters reorder mode.
    // When reorder is disabled, fire immediately (legacy behavior).
    if (localY >= 0 && localY < fullHeader) {
      const col = this.columnAtLocalX(localX);
      if (col !== null && this.columns[col]) {
        if (this.columnReorderEnabled) {
          this.dragCandidateColumn = col;
          this.dragCandidateClientX = e.clientX;
          this.suppressSelectionUntilUp = true;
          // Capture pointer so we still get move/up events even when
          // the cursor leaves the scrollHost.
          try {
            this.scrollHost.setPointerCapture(e.pointerId);
          } catch {
            // Some browsers refuse capture during certain events; if
            // that happens we still get the global window pointerup
            // listener, just no smooth tracking outside the host.
          }
          return;
        }
        if (this.onHeaderClick) {
          this.onHeaderClick(this.columns[col]!.id);
          this.suppressSelectionUntilUp = true;
          return;
        }
      }
      if (col !== null && this.onHeaderClick) {
        return;
      }
    }

    // Group chevron click: detect when the click falls in a group row
    // and is within that row's chevron zone (depth-aware). Higher
    // priority than master-detail chevron / cell selection.
    if (this.getRowMeta && this.onToggleGroup && localY >= dataTop) {
      const yInLayout = localY - dataTop + this.scrollTop;
      if (yInLayout >= 0) {
        const groupRow = this.fenwick.indexAtOffset(yInLayout);
        if (groupRow >= 0 && groupRow < this.rowSource.numRows) {
          const meta = this.getRowMeta(groupRow);
          if (meta && meta.kind === 'group') {
            const hitMin = meta.depth * 16 + 4;
            const hitMax = hitMin + 24 + (meta.label ? 200 : 0);
            if (localX >= hitMin && localX < hitMax) {
              this.onToggleGroup(meta.path);
              this.suppressSelectionUntilUp = true;
              return;
            }
            // Click anywhere else in a group row → no-op (don't start
            // a selection on synthetic group rows).
            return;
          }
          if (meta && meta.kind === 'tree' && !meta.isLeaf) {
            // Tree rows: small chevron at depth-indented column 0.
            const hitMin = meta.depth * 16 + 4;
            const hitMax = hitMin + 20;
            if (localX >= hitMin && localX < hitMax) {
              this.onToggleGroup(meta.id);
              this.suppressSelectionUntilUp = true;
              return;
            }
            // Click elsewhere in a tree row → fall through to normal
            // cell selection.
          }
        }
      }
    }

    // Fill-handle drag start: if the click lands on the small square
    // at the bottom-right corner of the active selection, capture
    // the source range and enter fill-drag mode. Pointer capture so
    // the move/up tracking continues outside the host.
    if (this.fillHandleEnabled && !this.selection.isEmpty()) {
      const ranges = this.selection.normalizedRanges();
      const last = ranges[ranges.length - 1];
      if (last) {
        const c = Math.min(last.colEnd, this.columns.length - 1);
        const isFrozen = c < this.frozenColumnCount;
        const handleRightX = isFrozen
          ? (this.cumulativeColumnWidths[c + 1] ?? 0)
          : this.frozenWidth +
            ((this.cumulativeColumnWidths[c + 1] ?? 0) -
              (this.cumulativeColumnWidths[this.frozenColumnCount] ?? 0)) -
            this.scrollLeft;
        const handleBottomY =
          this.dataBandTop() +
          this.fenwick.prefixSum(last.rowEnd) -
          this.scrollTop +
          this.fenwick.get(last.rowEnd);
        const s = this.fillHandleSize + 2; // +2px tolerance
        if (
          localX >= handleRightX - s &&
          localX <= handleRightX + 2 &&
          localY >= handleBottomY - s &&
          localY <= handleBottomY + 2
        ) {
          this.fillDragState = {
            source: last,
            targetRow: last.rowEnd,
            targetCol: last.colEnd,
          };
          this.suppressSelectionUntilUp = true;
          try {
            this.scrollHost.setPointerCapture(e.pointerId);
          } catch {
            // ignore — global pointerup still fires.
          }
          this.scheduleRender();
          return;
        }
      }
    }

    // Master-detail chevron click: leftmost `chevronWidth` pixels of any
    // row toggle that row's expansion. Higher priority than cell selection.
    if (
      this.getDetailContent &&
      localY >= dataTop &&
      localX >= 0 &&
      localX < this.chevronWidth
    ) {
      const yInLayout = localY - dataTop + this.scrollTop;
      if (yInLayout >= 0) {
        const row = this.fenwick.indexAtOffset(yInLayout);
        if (row >= 0 && row < this.rowSource.numRows) {
          this.toggleExpanded(row);
          this.suppressSelectionUntilUp = true;
          return;
        }
      }
    }

    const cell = this.cellAtClient(e.clientX, e.clientY);
    if (!cell) return;
    if (e.shiftKey && !this.selection.isEmpty()) {
      this.selection.extendActiveRange(cell);
    } else if (e.metaKey || e.ctrlKey) {
      this.selection.addRange(cell);
    } else {
      this.selection.startRange(cell);
    }
    this.isPointerDragging = true;
    try {
      this.scrollHost.setPointerCapture(e.pointerId);
    } catch {
      // setPointerCapture can throw if the element doesn't have it; harmless.
    }
    this.notifySelectionChange();
    this.scheduleRender();
  };

  private columnAtLocalX(localX: number): number | null {
    if (localX < 0) return null;
    if (localX < this.frozenWidth) {
      return colAtX(this.cumulativeColumnWidths, localX, 0, this.frozenColumnCount);
    }
    if (localX > this.viewportWidth) return null;
    const xInLayout =
      localX -
      this.frozenWidth +
      this.scrollLeft +
      (this.cumulativeColumnWidths[this.frozenColumnCount] ?? 0);
    return colAtX(
      this.cumulativeColumnWidths,
      xInLayout,
      this.frozenColumnCount,
      this.columns.length,
    );
  }

  /**
   * Resize-handle hit-test. Returns the column whose RIGHT edge falls
   * within the rightmost `RESIZE_HANDLE_PX` of its own header (i.e.,
   * the cursor lands in the column's own resize-zone strip, NOT in
   * the next column). Standard UX convention: resize handle belongs
   * to the column on the LEFT side of the boundary.
   *
   * Used by `handlePointerDown` to enter column-resize mode before
   * reorder / sort / selection paths claim the event.
   */
  private columnAtRightBoundary(localX: number): number | null {
    // Hit zone straddles the column boundary so the cursor doesn't have
    // to land precisely on the 1-px edge. 6 px each side = 12 px total
    // — wide enough to find easily, narrow enough that two adjacent
    // boundaries don't overlap at typical column widths.
    const RESIZE_HANDLE_PX = 6;
    // Frozen band: boundaries live in absolute viewport coords.
    if (localX <= this.frozenWidth + RESIZE_HANDLE_PX) {
      for (let i = 0; i < this.frozenColumnCount; i++) {
        const boundary = this.cumulativeColumnWidths[i + 1] ?? 0;
        if (
          localX >= boundary - RESIZE_HANDLE_PX &&
          localX <= boundary + RESIZE_HANDLE_PX
        ) {
          return i;
        }
      }
      // Fall through if no frozen boundary matched but the pointer is
      // in the seam between frozen + scrolling bands — check scrolling.
    }
    // Scrolling band: account for scrollLeft + the gap before the
    // first non-frozen column.
    const baseOffset = this.cumulativeColumnWidths[this.frozenColumnCount] ?? 0;
    for (let i = this.frozenColumnCount; i < this.columns.length; i++) {
      const boundaryInLayout = this.cumulativeColumnWidths[i + 1] ?? 0;
      const boundaryInViewport =
        boundaryInLayout - baseOffset - this.scrollLeft + this.frozenWidth;
      if (
        localX >= boundaryInViewport - RESIZE_HANDLE_PX &&
        localX <= boundaryInViewport + RESIZE_HANDLE_PX
      ) {
        return i;
      }
      if (boundaryInViewport > this.viewportWidth + RESIZE_HANDLE_PX) break;
    }
    return null;
  }

  /**
   * Row-resize hit-test (wave 24). Returns the row whose BOTTOM edge
   * falls within the bottom RESIZE_HANDLE_PX of its visible band. By
   * analogy with `columnAtRightBoundary`, the handle belongs to the
   * row ABOVE the boundary. Returns null when the pointer isn't in a
   * row-boundary strip or row resize is off.
   */
  private rowAtBottomBoundary(localY: number): number | null {
    if (!this.rowResizeEnabled) return null;
    const RESIZE_HANDLE_PX = 6;
    const dataTop = this.dataBandTop();
    const dataBottom = this.dataBandBottom();
    if (localY < dataTop || localY > dataBottom) return null;
    const yInData = localY - dataTop + this.scrollTop;
    const rowAtY = this.fenwick.indexAtOffset(yInData);
    if (rowAtY < 0 || rowAtY >= this.rowSource.numRows) return null;
    const bottomOfRow = this.fenwick.prefixSum(rowAtY + 1);
    if (Math.abs(yInData - bottomOfRow) <= RESIZE_HANDLE_PX) return rowAtY;
    return null;
  }

  private handlePointerMove = (e: PointerEvent): void => {
    // Column resize tracking: update the column width per-frame as
    // the pointer moves; fire onColumnResize with finalCommit=false.
    if (this.resizeColumn !== null) {
      const col = this.columns[this.resizeColumn];
      if (col) {
        const delta = e.clientX - this.resizeStartClientX;
        const minW = col.minWidth ?? 24;
        const maxW = col.maxWidth ?? 4096;
        const nextWidth = Math.max(minW, Math.min(maxW, this.resizeStartWidth + delta));
        if (nextWidth !== col.width) {
          // Splice an updated ColumnDef in place. cumulativeColumnWidths
          // is rebuilt by recomputeColumnWidths(); setColumns() also
          // calls scheduleRender().
          const next = [...this.columns];
          next[this.resizeColumn] = { ...col, width: nextWidth };
          this.setColumns(next);
          this.onColumnResize?.(col.id, nextWidth, false);
        }
      }
      return;
    }

    // Row resize tracking (wave 24). Mirror of the column path; clamps
    // to a minimum to keep at least the text-baseline visible.
    if (this.resizeRow !== null) {
      const delta = e.clientY - this.resizeStartClientY;
      const next = Math.max(16, this.resizeStartHeight + delta);
      const current = this.baseHeights[this.resizeRow] ?? 0;
      if (next !== current) {
        this.baseHeights[this.resizeRow] = next;
        this.rebuildHeightsFromExpansion();
        this.scheduleRender();
        this.onRowResize?.(this.resizeRow, next, false);
      }
      return;
    }

    // Hover affordance: when the pointer is inside the header band and
    // over a resize-handle hit zone (but not yet actively resizing),
    // show the col-resize cursor so the user can find the handle. We
    // only mutate cursor style when it actually changes — avoids
    // thrashing the style attribute on every pointermove.
    if (this.columnResizeEnabled && !this.isPointerDragging && this.dragActiveColumn === null) {
      const rect = this.host.getBoundingClientRect();
      const localY = e.clientY - rect.top;
      const localX = e.clientX - rect.left;
      const inHeader = localY >= 0 && localY < this.fullHeaderHeight();
      const overHandle =
        inHeader && this.columnAtRightBoundary(localX) !== null;
      const desired = overHandle ? 'col-resize' : '';
      if (this.scrollHost.style.cursor !== desired) {
        this.scrollHost.style.cursor = desired;
      }
    }
    if (this.isPointerDragging) {
      const cell = this.cellAtClient(e.clientX, e.clientY);
      if (cell) {
        this.selection.extendActiveRange(cell);
        this.notifySelectionChange();
        this.scheduleRender();
      }
    }
    // Column drag: promote candidate → active once movement crosses
    // the threshold, then track the cursor's nearest column boundary.
    if (this.dragCandidateColumn !== null) {
      if (Math.abs(e.clientX - this.dragCandidateClientX) > 6) {
        this.dragActiveColumn = this.dragCandidateColumn;
        this.dragCandidateColumn = null;
        this.ensureDragIndicator();
      }
    }
    if (this.dragActiveColumn !== null) {
      this.updateDragIndicator(e.clientX);
    }
    // Row drag-reorder (wave 26): promote candidate → active after the
    // 6-px threshold; then track the cursor's nearest row boundary.
    if (this.rowDragCandidateRow !== null) {
      if (Math.abs(e.clientY - this.rowDragCandidateClientY) > 6) {
        const grabbed = this.rowDragCandidateRow;
        this.rowDragActiveRow = grabbed;
        this.rowDragCandidateRow = null;
        // Capture the travelling set at drag-start (multi-row since
        // v1.2). If the grabbed row is part of the current selection,
        // every selected row moves as one block; otherwise just the
        // grabbed row. Snapshot here so later selection changes during
        // the drag don't alter what moves.
        const selectedRows = this.selectedRowIndices();
        this.rowDragRows =
          selectedRows.length > 1 && selectedRows.includes(grabbed)
            ? selectedRows
            : [grabbed];
        this.ensureRowDragIndicator();
      }
    }
    if (this.rowDragActiveRow !== null) {
      this.updateRowDragIndicator(e.clientY);
    }
    // Fill-handle drag tracking: convert cursor → cell, update
    // target, redraw the dashed preview.
    if (this.fillDragState) {
      const cell = this.cellAtClient(e.clientX, e.clientY);
      if (cell) {
        const next = {
          ...this.fillDragState,
          targetRow: cell.row,
          targetCol: cell.col,
        };
        if (
          next.targetRow !== this.fillDragState.targetRow ||
          next.targetCol !== this.fillDragState.targetCol
        ) {
          this.fillDragState = next;
          this.scheduleRender();
        }
      }
    }
    // Tooltip hover-tracking is independent of dragging — track on
    // every move when at least one column has a tooltip provider.
    if (this.tooltipEl) this.handleTooltipPointerMove(e);
  };

  private handlePointerUp = (e: PointerEvent): void => {
    // Column resize finalize: fire onColumnResize one more time
    // with finalCommit=true so consumers can persist on the drop.
    if (this.resizeColumn !== null) {
      const col = this.columns[this.resizeColumn];
      if (col) this.onColumnResize?.(col.id, col.width, true);
      this.resizeColumn = null;
      this.suppressSelectionUntilUp = false;
      try {
        this.scrollHost.releasePointerCapture(e.pointerId);
      } catch {
        // release may fail; harmless
      }
      return;
    }
    // Row resize finalize (wave 24). Same shape as column resize.
    if (this.resizeRow !== null) {
      const h = this.baseHeights[this.resizeRow] ?? 0;
      this.onRowResize?.(this.resizeRow, h, true);
      this.resizeRow = null;
      this.suppressSelectionUntilUp = false;
      try {
        this.scrollHost.releasePointerCapture(e.pointerId);
      } catch {
        // ignore
      }
      return;
    }
    this.isPointerDragging = false;
    this.suppressSelectionUntilUp = false;
    // Fill-handle drag finalize. Compute the *fill* rectangle
    // (target minus source — the cells the user wants populated) and
    // hand it to the consumer along with the original source range.
    // Then extend the live selection to span source ∪ fill so the
    // post-fill highlight reflects the user's commit.
    if (this.fillDragState) {
      const f = this.fillDragState;
      this.fillDragState = null;
      const sourceRect = {
        rowStart: f.source.rowStart,
        rowEnd: f.source.rowEnd,
        colStart: f.source.colStart,
        colEnd: f.source.colEnd,
      };
      const unionRowStart = Math.min(f.source.rowStart, f.targetRow);
      const unionRowEnd = Math.max(f.source.rowEnd, f.targetRow);
      const unionColStart = Math.min(f.source.colStart, f.targetCol);
      const unionColEnd = Math.max(f.source.colEnd, f.targetCol);
      // Fill rect = the union *minus* the source. For simplicity we
      // pass the bounding union and let the consumer subtract the
      // source — this is the same shape Excel reports.
      const fillRect = {
        rowStart: unionRowStart,
        rowEnd: unionRowEnd,
        colStart: unionColStart,
        colEnd: unionColEnd,
      };
      // Only fire if the user actually dragged outside the source.
      const grew =
        unionRowStart !== sourceRect.rowStart ||
        unionRowEnd !== sourceRect.rowEnd ||
        unionColStart !== sourceRect.colStart ||
        unionColEnd !== sourceRect.colEnd;
      if (grew && this.onFillHandle) {
        this.onFillHandle(sourceRect, fillRect);
      }
      // Extend the visible selection to the union so the fill is
      // immediately highlighted.
      if (grew) {
        this.selection.startRange({ row: unionRowStart, col: unionColStart });
        this.selection.extendActiveRange({ row: unionRowEnd, col: unionColEnd });
        this.notifySelectionChange();
      }
      try {
        this.scrollHost.releasePointerCapture(e.pointerId);
      } catch {
        // ignore.
      }
      this.scheduleRender();
      return;
    }
    // Row drag-reorder finalize (wave 26; multi-row since v1.2). The grid
    // doesn't own the row store, so we just emit
    // `onRowReorder(fromRows, toRow)` — the adopter performs the actual
    // data mutation. `toRow` is the insertion index in the original row
    // coordinate space; the adopter removes every `fromRows` entry and
    // re-inserts the block at the position `toRow` refers to after
    // removal.
    if (this.rowDragActiveRow !== null) {
      const fromRows = this.rowDragRows.length > 0 ? this.rowDragRows : [this.rowDragActiveRow];
      const to = this.rowDragInsertIndex;
      this.rowDragActiveRow = null;
      this.rowDragRows = [];
      this.removeRowDragIndicator();
      // No-op detection: dropping a contiguous block back inside (or at
      // either edge of) the run it already occupies changes nothing.
      // `fromRows` is ascending; it is contiguous when its span equals
      // its length. A contiguous run [lo..hi] is unchanged by an
      // insertion index in [lo, hi+1]. Non-contiguous selections always
      // relocate into a single block, so they are never a no-op.
      const lo = fromRows[0] ?? 0;
      const hi = fromRows[fromRows.length - 1] ?? 0;
      const contiguous = hi - lo + 1 === fromRows.length;
      const noop = contiguous && to >= lo && to <= hi + 1;
      if (!noop && this.onRowReorder) {
        this.onRowReorder(fromRows, to);
      }
      this.suppressSelectionUntilUp = false;
      try {
        this.scrollHost.releasePointerCapture(e.pointerId);
      } catch {
        // ignore
      }
      return;
    }
    if (this.rowDragCandidateRow !== null) {
      this.rowDragCandidateRow = null;
      this.suppressSelectionUntilUp = false;
      try {
        this.scrollHost.releasePointerCapture(e.pointerId);
      } catch {
        // ignore
      }
      // Fall through: pointerup on a candidate (no movement) is just a
      // click — but we already suppressed cell-selection on pointerdown
      // so we don't need to do anything more here.
      return;
    }

    // Column drag finalize. If a drag was active, splice columns + fire
    // onColumnReorder. If only a candidate was held (no movement), it
    // counts as a header click — fire onHeaderClick.
    if (this.dragActiveColumn !== null) {
      const from = this.dragActiveColumn;
      const to = this.dragInsertIndex;
      this.dragActiveColumn = null;
      this.removeDragIndicator();
      // Translate the post-splice insertion index into the visible
      // column index after the splice. If we move forwards, the
      // splice removes `from` first so the target shifts left by 1.
      const targetIndex = to > from ? to - 1 : to;
      if (targetIndex !== from) {
        const moved = this.columns[from]!;
        this.columns.splice(from, 1);
        this.columns.splice(targetIndex, 0, moved);
        this.recomputeColumnLayout();
        this.scrollSpacer.style.width = `${this.totalColumnsWidth}px`;
        this.scheduleRender();
        this.onColumnReorder?.(from, targetIndex, moved.id);
      }
      try {
        this.scrollHost.releasePointerCapture(e.pointerId);
      } catch {
        // ignore — pointer capture may have already been released.
      }
      return;
    }
    if (this.dragCandidateColumn !== null) {
      const col = this.dragCandidateColumn;
      this.dragCandidateColumn = null;
      const column = this.columns[col];
      if (column && this.onHeaderClick) {
        this.onHeaderClick(column.id);
      }
      try {
        this.scrollHost.releasePointerCapture(e.pointerId);
      } catch {
        // ignore.
      }
    }
  };

  /** Lazily mount the vertical drop indicator that visually marks
   *  where the dragged column will land. Pointer-events:none so it
   *  never blocks the drag itself. */
  private ensureDragIndicator(): void {
    if (this.dragIndicatorEl) return;
    const el = document.createElement('div');
    el.style.cssText =
      'position:absolute;top:0;width:2px;background:#6ea8fe;pointer-events:none;' +
      'z-index:20;box-shadow:0 0 4px rgba(110,168,254,0.6);';
    this.host.appendChild(el);
    this.dragIndicatorEl = el;
  }

  private removeDragIndicator(): void {
    this.dragIndicatorEl?.remove();
    this.dragIndicatorEl = null;
  }

  /** Compute the nearest column boundary to the cursor and snap the
   *  drop indicator there. Insertion index range: [0, columns.length]. */
  private updateDragIndicator(clientX: number): void {
    if (!this.dragIndicatorEl) return;
    const hostRect = this.host.getBoundingClientRect();
    const localX = clientX - hostRect.left;
    // Account for horizontal scroll when computing layout-space X.
    const layoutX =
      localX < this.frozenWidth ? localX : localX + this.scrollLeft;
    // Find the nearest cumulative-width boundary.
    let bestIndex = 0;
    let bestDelta = Infinity;
    for (let i = 0; i <= this.columns.length; i++) {
      const boundary = this.cumulativeColumnWidths[i] ?? 0;
      const delta = Math.abs(boundary - layoutX);
      if (delta < bestDelta) {
        bestDelta = delta;
        bestIndex = i;
      }
    }
    this.dragInsertIndex = bestIndex;
    // Boundary in viewport coords: subtract scroll for non-frozen
    // columns. The first frozen-column boundaries (up to
    // frozenColumnCount) are not scrolled.
    const boundary = this.cumulativeColumnWidths[bestIndex] ?? 0;
    const viewportX =
      bestIndex <= this.frozenColumnCount
        ? boundary
        : boundary - this.scrollLeft;
    this.dragIndicatorEl.style.left = `${String(viewportX - 1)}px`;
    this.dragIndicatorEl.style.height = `${String(this.viewportHeight)}px`;
  }

  // ---- Row drag-reorder indicator (wave 26) -------------------------------

  private ensureRowDragIndicator(): void {
    if (this.rowDragIndicatorEl) return;
    const el = document.createElement('div');
    el.style.cssText =
      'position:absolute;left:0;right:0;height:2px;background:#6ea8fe;pointer-events:none;' +
      'z-index:20;box-shadow:0 0 4px rgba(110,168,254,0.6);';
    this.host.appendChild(el);
    this.rowDragIndicatorEl = el;
  }

  private removeRowDragIndicator(): void {
    this.rowDragIndicatorEl?.remove();
    this.rowDragIndicatorEl = null;
  }

  /** Compute the nearest row boundary to the cursor and snap the drop
   *  indicator there. Insertion index range: [0, rowSource.numRows]. */
  private updateRowDragIndicator(clientY: number): void {
    if (!this.rowDragIndicatorEl) return;
    const hostRect = this.host.getBoundingClientRect();
    const localY = clientY - hostRect.top;
    const dataTop = this.dataBandTop();
    const yInData = Math.max(0, localY - dataTop + this.scrollTop);
    // Find the row index whose top-or-bottom is closest to the cursor.
    let bestIndex = 0;
    let bestDelta = Infinity;
    const maxRows = this.rowSource.numRows;
    // Sample boundaries at every visible row; cheap because we only
    // walk the visible range.
    const start = Math.max(0, this.fenwick.indexAtOffset(this.scrollTop) - 1);
    const visibleEnd = Math.min(
      maxRows,
      this.fenwick.indexAtOffset(this.scrollTop + this.viewportHeight - dataTop) + 2,
    );
    for (let i = start; i <= visibleEnd; i++) {
      const boundary = this.fenwick.prefixSum(i);
      const delta = Math.abs(boundary - yInData);
      if (delta < bestDelta) {
        bestDelta = delta;
        bestIndex = i;
      }
    }
    this.rowDragInsertIndex = bestIndex;
    const boundary = this.fenwick.prefixSum(bestIndex);
    const viewportY = boundary - this.scrollTop + dataTop;
    this.rowDragIndicatorEl.style.top = `${String(viewportY - 1)}px`;
  }

  private handlePointerLeave = (): void => {
    this.hideTooltip();
    if (this.scrollHost.style.cursor !== '') {
      this.scrollHost.style.cursor = '';
    }
  };

  /** Native contextmenu event → resolve the target (cell / header /
   *  empty), prevent the browser's default menu, hand off to the
   *  consumer's onContextMenu callback. No menu is rendered here —
   *  consumers position their own popover at (clientX, clientY). */
  private handleContextMenu = (e: MouseEvent): void => {
    if (!this.onContextMenu) return;
    e.preventDefault();
    const rect = this.host.getBoundingClientRect();
    const localY = e.clientY - rect.top;
    const localX = e.clientX - rect.left;
    const fullHeader = this.fullHeaderHeight();
    if (localY >= 0 && localY < fullHeader) {
      const col = this.columnAtLocalX(localX);
      const column = col !== null ? this.columns[col] : null;
      if (column) {
        this.onContextMenu({
          kind: 'header',
          columnId: column.id,
          clientX: e.clientX,
          clientY: e.clientY,
        });
        return;
      }
    }
    const cell = this.cellAtClient(e.clientX, e.clientY);
    if (cell) {
      const column = this.columns[cell.col];
      if (column) {
        this.onContextMenu({
          kind: 'cell',
          rowIndex: cell.row,
          columnId: column.id,
          clientX: e.clientX,
          clientY: e.clientY,
        });
        return;
      }
    }
    this.onContextMenu({
      kind: 'empty',
      clientX: e.clientX,
      clientY: e.clientY,
    });
  };

  // -------------------------------------------------------------------------
  // Tooltip
  // -------------------------------------------------------------------------

  /** Hover tracking for tooltips. Schedules a delayed show on enter,
   *  cancels on leave to a different cell. WCAG 1.4.13 says content
   *  on hover must be dismissable, hoverable, persistent — we honor
   *  dismiss (Escape, scroll, leave) and persistence (the tooltip
   *  stays until the user moves elsewhere); hoverable is moot since
   *  pointer-events:none makes the tooltip itself non-interactive. */
  private handleTooltipPointerMove(e: PointerEvent): void {
    const cell = this.cellAtClient(e.clientX, e.clientY);
    if (!cell) {
      this.hideTooltip();
      return;
    }
    const column = this.columns[cell.col];
    if (!column?.tooltip) {
      this.hideTooltip();
      return;
    }
    const key = `${String(cell.row)}:${String(cell.col)}`;
    if (this.tooltipHoveredKey === key) return; // same cell, no work
    // Moved to a different cell — hide any currently-shown tooltip
    // and reset the timer for the new target.
    if (this.tooltipEl && this.tooltipEl.style.display === 'block') {
      this.tooltipEl.style.display = 'none';
    }
    if (this.tooltipShowTimer !== null) clearTimeout(this.tooltipShowTimer);
    this.tooltipHoveredKey = key;
    // 500ms hover delay matches platform conventions (Windows + macOS
    // tooltip systems both default to ~500ms).
    this.tooltipShowTimer = setTimeout(() => {
      this.showTooltipFor(cell.row, cell.col);
    }, 500);
  }

  /** Render tooltip content for (row, col) and position it. */
  private showTooltipFor(row: number, col: number): void {
    if (!this.tooltipEl) return;
    const column = this.columns[col];
    if (!column?.tooltip) return;
    const value = this.rowSource.getCell(row, column.id);
    const content = column.tooltip(value, row);
    if (content === null || content === undefined || content === '') {
      this.tooltipEl.style.display = 'none';
      return;
    }
    // Wipe + set fresh content.
    while (this.tooltipEl.firstChild) this.tooltipEl.firstChild.remove();
    if (typeof content === 'string') {
      this.tooltipEl.textContent = content;
    } else {
      this.tooltipEl.appendChild(content);
    }
    this.positionTooltip(row, col);
  }

  /** Place the tooltip below the cell, flipping above if no room. */
  private positionTooltip(row: number, col: number): void {
    if (!this.tooltipEl) return;
    const rect = this.cellViewportRect(row, col);
    if (!rect) {
      this.tooltipEl.style.display = 'none';
      return;
    }
    this.tooltipEl.style.display = 'block';
    // Measure the tooltip after content is set.
    const tipRect = this.tooltipEl.getBoundingClientRect();
    const gap = 6;
    let top = rect.top + rect.height + gap;
    if (top + tipRect.height > this.viewportHeight) {
      top = rect.top - tipRect.height - gap;
    }
    let left = rect.left;
    if (left + tipRect.width > this.viewportWidth) {
      left = Math.max(4, this.viewportWidth - tipRect.width - 4);
    }
    this.tooltipEl.style.left = `${String(left)}px`;
    this.tooltipEl.style.top = `${String(Math.max(4, top))}px`;
  }

  private hideTooltip(): void {
    if (!this.tooltipEl) return;
    if (this.tooltipShowTimer !== null) {
      clearTimeout(this.tooltipShowTimer);
      this.tooltipShowTimer = null;
    }
    this.tooltipEl.style.display = 'none';
    this.tooltipHoveredKey = null;
  }

  private cellAtClient(clientX: number, clientY: number): CellPosition | null {
    const rect = this.host.getBoundingClientRect();
    const localX = clientX - rect.left;
    const localY = clientY - rect.top;
    const dataTop = this.dataBandTop();
    const dataBottom = this.dataBandBottom();
    if (localY < dataTop || localY >= dataBottom) return null;
    if (localX < 0) return null;
    if (localX > this.viewportWidth || localY > this.viewportHeight) return null;

    const yInLayout = localY - dataTop + this.scrollTop;
    if (yInLayout < 0) return null;
    const row = this.fenwick.indexAtOffset(yInLayout);
    if (row < 0 || row >= this.rowSource.numRows) return null;

    let col: number;
    if (localX < this.frozenWidth) {
      // Frozen band: column index lies in [0, frozenColumnCount).
      col = colAtX(this.cumulativeColumnWidths, localX, 0, this.frozenColumnCount);
    } else {
      // Scrolling band: subtract frozen offset, add scrollLeft.
      const xInLayout =
        localX -
        this.frozenWidth +
        this.scrollLeft +
        (this.cumulativeColumnWidths[this.frozenColumnCount] ?? 0);
      col = colAtX(
        this.cumulativeColumnWidths,
        xInLayout,
        this.frozenColumnCount,
        this.columns.length,
      );
    }
    if (col < 0) return null;
    return { row, col };
  }

  private scrollActiveIntoView(): void {
    const active = this.selection.active;
    if (!active) return;
    const top = this.fenwick.prefixSum(active.row);
    const bottom = top + this.fenwick.get(active.row);
    const viewportTop = this.scrollTop;
    const dataHeight = this.dataBandBottom() - this.dataBandTop();
    const viewportBottom = this.scrollTop + dataHeight;
    if (top < viewportTop) {
      this.setLogicalScrollTop(top);
      this.scheduleRender();
    } else if (bottom > viewportBottom) {
      this.setLogicalScrollTop(bottom - dataHeight);
      this.scheduleRender();
    }
  }

  // ---------------------------------------------------------------------------
  // Pinned bands + status bar layout
  // ---------------------------------------------------------------------------

  /** Band reserved above the data rows for column-group labels (zero
   *  unless `columnGroups` was supplied). */
  private columnGroupBandHeight(): number {
    return this.columnGroups && this.columnGroups.length > 0 ? COLUMN_GROUP_BAND_HEIGHT : 0;
  }

  /** Strip reserved at the very top of the header chrome for the
   *  drag-to-group pill bar (v1.3). Zero unless `enableGroupBar`. The
   *  bar itself is a DOM overlay; the canvas only reserves the space and
   *  paints nothing in it. Sits ABOVE the column-group band. */
  private groupBarHeight(): number {
    return this.groupBarEnabled ? GROUP_BAR_HEIGHT : 0;
  }

  /** Total header band height — group bar (v1.3) + base header +
   *  column-group band when groups are present + floating filter row
   *  when enabled. Cell-positioning math below uses this instead of the
   *  raw `headerHeight`. */
  private fullHeaderHeight(): number {
    return (
      this.groupBarHeight() +
      this.headerHeight +
      this.columnGroupBandHeight() +
      this.floatingFilterRowHeight()
    );
  }

  private floatingFilterRowHeight(): number {
    return this.floatingFiltersEnabled ? FLOATING_FILTER_ROW_HEIGHT : 0;
  }

  /** Create one <input> per column inside the filter band. Inputs
   *  are kept around for the grid's lifetime — only their positions
   *  update on scroll/resize. Wires onChange → onFloatingFilterChange. */
  private buildFloatingFilterInputs(): void {
    if (!this.floatingFilterBandEl) return;
    for (const column of this.columns) {
      const input = document.createElement('input');
      input.type = 'search';
      input.placeholder = column.displayName ?? column.id;
      input.setAttribute('aria-label', `Filter ${column.displayName ?? column.id}`);
      input.style.cssText =
        'position:absolute;box-sizing:border-box;margin:0;padding:0 6px;' +
        'border:1px solid #2a2f37;background:#0b0d10;color:#e7e9ec;' +
        `font-family:${this.theme.fontFamily};font-size:${String(this.theme.fontSize - 1)}px;` +
        'border-radius:3px;outline:none;height:22px;top:3px;';
      input.addEventListener('input', () => {
        this.onFloatingFilterChange?.(column.id, input.value);
      });
      // Stop keydown propagation so arrow keys / Enter don't bubble
      // up to the grid's selection / commit handlers.
      input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Escape') {
          input.value = '';
          this.onFloatingFilterChange?.(column.id, '');
        }
      });
      this.floatingFilterBandEl.appendChild(input);
      this.floatingFilterInputs.set(column.id, input);
    }
  }

  // ---------------------------------------------------------------------------
  // Group bar (v1.3)
  // ---------------------------------------------------------------------------

  /** Rebuild the pill bar from `groupColumns`. One pill per grouped
   *  column (draggable for reorder, with an ✕ remove button) plus an
   *  "add column" <select> listing the columns not yet grouped. Cheap to
   *  rebuild wholesale — the list is tiny. */
  private renderGroupBar(): void {
    const bar = this.groupBarEl;
    if (!bar) return;
    bar.replaceChildren();

    const label = document.createElement('span');
    label.textContent = 'Group by:';
    label.style.cssText = `color:${this.theme.mutedText};font-size:11px;margin-right:2px;`;
    bar.appendChild(label);

    if (this.groupColumns.length === 0) {
      const hint = document.createElement('span');
      hint.textContent = 'none — add a column →';
      hint.style.cssText = `color:${this.theme.mutedText};font-size:11px;font-style:italic;`;
      bar.appendChild(hint);
    }

    this.groupColumns.forEach((colId, index) => {
      const pill = document.createElement('span');
      pill.setAttribute('role', 'listitem');
      pill.draggable = true;
      pill.dataset.groupIndex = String(index);
      const display = this.columns.find((c) => c.id === colId)?.displayName ?? colId;
      pill.style.cssText =
        `display:inline-flex;align-items:center;gap:4px;background:${this.theme.background};` +
        `color:${this.theme.text};border:1px solid #2a2f37;border-radius:12px;` +
        'padding:2px 6px 2px 10px;font-size:11px;cursor:grab;user-select:none;' +
        'white-space:nowrap;';
      const text = document.createElement('span');
      text.textContent = display;
      pill.appendChild(text);
      const x = document.createElement('button');
      x.type = 'button';
      x.textContent = '✕';
      x.setAttribute('aria-label', `Remove ${display} from grouping`);
      x.style.cssText =
        `background:none;border:none;color:${this.theme.mutedText};cursor:pointer;` +
        'font-size:10px;padding:0 2px;line-height:1;';
      x.addEventListener('click', (e) => {
        e.stopPropagation();
        this.removeGroupColumn(colId);
      });
      pill.appendChild(x);

      // Native HTML5 drag for reorder.
      pill.addEventListener('dragstart', (e) => {
        this.groupPillDragFrom = index;
        this.groupPillDragTo = index;
        e.dataTransfer?.setData('text/plain', colId);
        if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
      });
      pill.addEventListener('dragover', (e) => {
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
        this.groupPillDragTo = index;
      });
      pill.addEventListener('drop', (e) => {
        e.preventDefault();
        this.commitGroupPillReorder(index);
      });
      pill.addEventListener('dragend', () => {
        this.groupPillDragFrom = -1;
        this.groupPillDragTo = -1;
      });
      bar.appendChild(pill);
    });

    const ungrouped = this.columns.filter((c) => !this.groupColumns.includes(c.id));
    if (ungrouped.length > 0) {
      const add = document.createElement('select');
      add.setAttribute('aria-label', 'Add column to grouping');
      add.style.cssText =
        `background:${this.theme.background};color:${this.theme.text};` +
        'border:1px solid #2a2f37;border-radius:3px;font-size:11px;padding:1px 4px;' +
        'margin-left:auto;cursor:pointer;';
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = '+ add';
      add.appendChild(placeholder);
      for (const c of ungrouped) {
        const opt = document.createElement('option');
        opt.value = c.id;
        opt.textContent = c.displayName ?? c.id;
        add.appendChild(opt);
      }
      add.addEventListener('change', () => {
        if (add.value) this.addGroupColumn(add.value);
      });
      bar.appendChild(add);
    }
  }

  /** Move the dragged pill (groupPillDragFrom) to land before `target`. */
  private commitGroupPillReorder(target: number): void {
    const from = this.groupPillDragFrom;
    this.groupPillDragFrom = -1;
    this.groupPillDragTo = -1;
    if (from < 0 || from === target) return;
    const next = [...this.groupColumns];
    const [moved] = next.splice(from, 1);
    if (moved === undefined) return;
    // After removal, indices ≥ from shift left by one — the same
    // insertion-index convention as column / row reorder.
    const insertAt = target > from ? target - 1 : target;
    next.splice(insertAt, 0, moved);
    this.setGroupColumns(next);
  }

  private addGroupColumn(colId: string): void {
    if (this.groupColumns.includes(colId)) return;
    this.setGroupColumns([...this.groupColumns, colId]);
  }

  private removeGroupColumn(colId: string): void {
    this.setGroupColumns(this.groupColumns.filter((id) => id !== colId));
  }

  /** Replace the group-by column list. Rebuilds the pill bar and fires
   *  `onRowGrouping`. The public imperative entry point — also used by
   *  the bar's own add / remove / reorder handlers. No-ops (and stays
   *  silent) when the list is unchanged. */
  setGroupColumns(columnIds: ReadonlyArray<string>): void {
    const next = [...columnIds];
    const same =
      next.length === this.groupColumns.length &&
      next.every((id, i) => id === this.groupColumns[i]);
    if (same) return;
    this.groupColumns = next;
    this.renderGroupBar();
    this.onRowGrouping?.([...this.groupColumns]);
  }

  /** Current group-by column ids, in nesting order. */
  getGroupColumns(): string[] {
    return [...this.groupColumns];
  }

  // ---------------------------------------------------------------------------
  // Side panels (v1.3): aggregation / filter / pivot
  // ---------------------------------------------------------------------------

  /** Build an empty docked side panel shell (right edge, floats over the
   *  data band — no layout-math change). Returns the element with a
   *  header row (title + ✕ close) already mounted; callers fill the body
   *  via a `[data-panel-body]` child. `display:none` until opened. Shared
   *  by the aggregation / filter / pivot panels. */
  private buildSidePanel(title: string, ariaLabel: string): HTMLDivElement {
    const panel = document.createElement('div');
    panel.setAttribute('role', 'region');
    panel.setAttribute('aria-label', ariaLabel);
    panel.style.cssText =
      `position:absolute;top:0;right:0;bottom:0;width:${String(SIDE_PANEL_WIDTH)}px;` +
      `background:${this.theme.headerBackground};color:${this.theme.text};` +
      'border-left:1px solid #2a2f37;z-index:6;display:none;flex-direction:column;' +
      `font-family:${this.theme.fontFamily};font-size:12px;` +
      'box-shadow:-4px 0 12px rgba(0,0,0,0.35);box-sizing:border-box;';

    const head = document.createElement('div');
    head.style.cssText =
      'display:flex;align-items:center;justify-content:space-between;' +
      'padding:8px 10px;border-bottom:1px solid #2a2f37;flex:0 0 auto;';
    const titleEl = document.createElement('span');
    titleEl.textContent = title;
    titleEl.style.cssText = 'font-weight:600;font-size:12px;';
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = '✕';
    close.setAttribute('aria-label', `Close ${title.toLowerCase()} panel`);
    close.style.cssText =
      `background:none;border:none;color:${this.theme.mutedText};cursor:pointer;font-size:12px;`;
    close.addEventListener('click', () => {
      panel.style.display = 'none';
    });
    head.appendChild(titleEl);
    head.appendChild(close);
    panel.appendChild(head);

    const body = document.createElement('div');
    body.dataset.panelBody = '';
    body.style.cssText = 'flex:1 1 auto;overflow:auto;padding:6px 10px;';
    panel.appendChild(body);

    return panel;
  }

  private panelBody(panel: HTMLDivElement | null): HTMLDivElement | null {
    return panel ? (panel.querySelector('[data-panel-body]') as HTMLDivElement | null) : null;
  }

  /** One labelled row per column, each with an aggregator <select>.
   *  Selecting a type updates `aggregatorByColumn` and fires the composed
   *  AggregationModel. */
  private renderAggregationPanel(): void {
    const body = this.panelBody(this.aggregationPanelEl);
    if (!body) return;
    body.replaceChildren();
    for (const column of this.columns) {
      const row = document.createElement('label');
      row.style.cssText =
        'display:flex;align-items:center;justify-content:space-between;gap:8px;' +
        'padding:3px 0;white-space:nowrap;';
      const name = document.createElement('span');
      name.textContent = column.displayName ?? column.id;
      name.style.cssText = 'overflow:hidden;text-overflow:ellipsis;';
      const sel = document.createElement('select');
      sel.setAttribute('aria-label', `Aggregator for ${column.displayName ?? column.id}`);
      sel.dataset.columnId = column.id;
      sel.style.cssText =
        `background:${this.theme.background};color:${this.theme.text};` +
        'border:1px solid #2a2f37;border-radius:3px;font-size:11px;padding:1px 4px;cursor:pointer;';
      const current = this.aggregatorByColumn.get(column.id) ?? 'none';
      for (const opt of AGGREGATOR_OPTIONS) {
        const o = document.createElement('option');
        o.value = opt.value;
        o.textContent = opt.label;
        if (opt.value === current) o.selected = true;
        sel.appendChild(o);
      }
      sel.addEventListener('change', () => {
        this.setColumnAggregator(column.id, sel.value as 'none' | AggregationType);
      });
      row.appendChild(name);
      row.appendChild(sel);
      body.appendChild(row);
    }
  }

  /** Compose the current AggregationModel from `aggregatorByColumn`, in
   *  column order. Each entry's alias defaults to the column id. */
  private composeAggregationModel(): Aggregation[] {
    const model: Aggregation[] = [];
    for (const column of this.columns) {
      const fn = this.aggregatorByColumn.get(column.id);
      if (fn) model.push({ columnId: column.id, fn, alias: column.id });
    }
    return model;
  }

  /** Set (or clear, with 'none') a single column's aggregator and fire
   *  `onAggregationChange` with the recomposed model. Public imperative
   *  entry point; also used by the panel's own <select> handlers. */
  setColumnAggregator(columnId: string, fn: 'none' | AggregationType): void {
    const prev = this.aggregatorByColumn.get(columnId);
    if (fn === 'none') {
      if (prev === undefined) return;
      this.aggregatorByColumn.delete(columnId);
    } else {
      if (prev === fn) return;
      this.aggregatorByColumn.set(columnId, fn);
    }
    this.onAggregationChange?.(this.composeAggregationModel());
  }

  /** Current composed AggregationModel (copy). */
  getAggregationModel(): AggregationModel {
    return this.composeAggregationModel();
  }

  openAggregationPanel(): void {
    if (this.aggregationPanelEl) this.aggregationPanelEl.style.display = 'flex';
  }

  closeAggregationPanel(): void {
    if (this.aggregationPanelEl) this.aggregationPanelEl.style.display = 'none';
  }

  // ---- Filter panel (v1.3) ----

  /** One row per column (operator <select> + value <input>) plus an
   *  Apply / Clear footer. Edits accumulate in `filterDraft`; nothing
   *  fires until Apply (batched). */
  private renderFilterPanel(): void {
    const body = this.panelBody(this.filterPanelEl);
    if (!body) return;
    body.replaceChildren();

    for (const column of this.columns) {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;flex-direction:column;gap:2px;padding:4px 0;';
      const name = document.createElement('span');
      name.textContent = column.displayName ?? column.id;
      name.style.cssText = `color:${this.theme.mutedText};font-size:11px;`;
      row.appendChild(name);

      const controls = document.createElement('div');
      controls.style.cssText = 'display:flex;gap:4px;';
      const draft = this.filterDraft.get(column.id);

      const op = document.createElement('select');
      op.setAttribute('aria-label', `Filter operator for ${column.displayName ?? column.id}`);
      op.dataset.filterOp = column.id;
      op.style.cssText =
        `background:${this.theme.background};color:${this.theme.text};` +
        'border:1px solid #2a2f37;border-radius:3px;font-size:11px;padding:1px 2px;cursor:pointer;flex:0 0 auto;';
      for (const o of FILTER_OPERATOR_OPTIONS) {
        const opt = document.createElement('option');
        opt.value = o.value;
        opt.textContent = o.label;
        if (draft && o.value === draft.op) opt.selected = true;
        op.appendChild(opt);
      }

      const val = document.createElement('input');
      val.type = 'text';
      val.dataset.filterVal = column.id;
      val.setAttribute('aria-label', `Filter value for ${column.displayName ?? column.id}`);
      val.value = draft?.raw ?? '';
      val.style.cssText =
        `background:${this.theme.background};color:${this.theme.text};` +
        'border:1px solid #2a2f37;border-radius:3px;font-size:11px;padding:1px 4px;flex:1 1 auto;min-width:0;';
      // Unary ops disable the value input.
      const syncValDisabled = (): void => {
        const unary = UNARY_FILTER_OPS.has(op.value as ComparisonOperator);
        val.disabled = unary || op.value === 'none';
        val.placeholder = MULTI_VALUE_FILTER_OPS.has(op.value as ComparisonOperator)
          ? 'comma,separated'
          : '';
      };
      syncValDisabled();

      const stash = (): void => {
        if (op.value === 'none') this.filterDraft.delete(column.id);
        else this.filterDraft.set(column.id, { op: op.value as ComparisonOperator, raw: val.value });
      };
      op.addEventListener('change', () => {
        syncValDisabled();
        stash();
      });
      val.addEventListener('input', stash);
      // Keep panel keystrokes out of the grid's selection handlers.
      val.addEventListener('keydown', (e) => e.stopPropagation());

      controls.appendChild(op);
      controls.appendChild(val);
      row.appendChild(controls);
      body.appendChild(row);
    }

    const footer = document.createElement('div');
    footer.style.cssText =
      'display:flex;gap:6px;justify-content:flex-end;padding-top:8px;' +
      'border-top:1px solid #2a2f37;margin-top:6px;position:sticky;bottom:0;' +
      `background:${this.theme.headerBackground};`;
    const mkBtn = (text: string, onClick: () => void): HTMLButtonElement => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = text;
      b.style.cssText =
        `background:${this.theme.background};color:${this.theme.text};` +
        'border:1px solid #2a2f37;border-radius:3px;padding:3px 10px;font-size:11px;cursor:pointer;';
      b.addEventListener('click', onClick);
      return b;
    };
    footer.appendChild(mkBtn('Clear', () => this.clearFilterPanel()));
    footer.appendChild(mkBtn('Apply', () => this.applyFilterPanel()));
    body.appendChild(footer);
  }

  /** Compose the FilterModel from `filterDraft` and fire
   *  `onFilterModelChange`. Single-value ops use `value`; multi-value ops
   *  split the raw input on commas into `values`; unary ops carry
   *  neither. Skips a column whose value is required but empty. Emits
   *  `null` when no usable filter remains. The batched commit point. */
  applyFilterPanel(): void {
    const filters: ComparisonFilter[] = [];
    for (const column of this.columns) {
      const draft = this.filterDraft.get(column.id);
      if (!draft) continue;
      const { op, raw } = draft;
      if (UNARY_FILTER_OPS.has(op)) {
        filters.push({ type: 'comparison', columnId: column.id, op });
      } else if (MULTI_VALUE_FILTER_OPS.has(op)) {
        const values = raw
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        if (values.length === 0) continue;
        filters.push({ type: 'comparison', columnId: column.id, op, values });
      } else {
        if (raw.trim().length === 0) continue;
        filters.push({ type: 'comparison', columnId: column.id, op, value: raw });
      }
    }
    const model: FilterModel =
      filters.length === 0 ? null : { type: 'logical', op: 'and', filters };
    this.onFilterModelChange?.(model);
  }

  /** Reset every column's draft, re-render the panel, and fire `null`. */
  clearFilterPanel(): void {
    this.filterDraft.clear();
    this.renderFilterPanel();
    this.onFilterModelChange?.(null);
  }

  openFilterPanel(): void {
    if (this.filterPanelEl) this.filterPanelEl.style.display = 'flex';
  }

  closeFilterPanel(): void {
    if (this.filterPanelEl) this.filterPanelEl.style.display = 'none';
  }

  /** Position the band + each input over its column. Called from
   *  tick() so the layout stays in sync with horizontal scroll. The
   *  frozen-column band is left for a follow-up commit. */
  private repositionFloatingFilters(): void {
    if (!this.floatingFilterBandEl) return;
    const top = this.headerHeight + this.columnGroupBandHeight();
    this.floatingFilterBandEl.style.top = `${String(top)}px`;
    for (let col = 0; col < this.columns.length; col++) {
      const column = this.columns[col];
      if (!column) continue;
      const input = this.floatingFilterInputs.get(column.id);
      if (!input) continue;
      const isFrozen = col < this.frozenColumnCount;
      const colLeft = this.cumulativeColumnWidths[col] ?? 0;
      const colWidth = (this.cumulativeColumnWidths[col + 1] ?? colLeft) - colLeft;
      let left: number;
      if (isFrozen) {
        left = colLeft;
      } else {
        const frozenEnd = this.cumulativeColumnWidths[this.frozenColumnCount] ?? 0;
        left = this.frozenWidth + (colLeft - frozenEnd) - this.scrollLeft;
      }
      input.style.left = `${String(left + 4)}px`;
      input.style.width = `${String(Math.max(0, colWidth - 8))}px`;
      input.style.display =
        left + colWidth < this.frozenWidth || left > this.viewportWidth ? 'none' : 'block';
    }
  }

  private pinnedTopBandHeight(): number {
    if (!this.pinnedTopRowSource) return 0;
    return this.pinnedTopRowSource.numRows * this.pinnedRowHeight;
  }

  private pinnedBottomBandHeight(): number {
    if (!this.pinnedBottomRowSource) return 0;
    return this.pinnedBottomRowSource.numRows * this.pinnedRowHeight;
  }

  private statusBarHeight(): number {
    return this.statusBarEnabled ? STATUS_BAR_HEIGHT : 0;
  }

  /** First viewport y where data rows begin. */
  private dataBandTop(): number {
    return this.fullHeaderHeight() + this.pinnedTopBandHeight();
  }

  /** Viewport y where data rows end (exclusive). */
  private dataBandBottom(): number {
    return this.viewportHeight - this.pinnedBottomBandHeight() - this.statusBarHeight();
  }

  // ---------------------------------------------------------------------------
  // Cell editing
  // ---------------------------------------------------------------------------

  /** Whether (row, columnId) accepts edits given the current `editable`
   *  prop. Falls through to false if `editable` was never supplied. */
  private isEditableAt(row: number, col: number): boolean {
    if (!this.editable) return false;
    const column = this.columns[col];
    if (!column) return false;
    if (typeof this.editable === 'function') return this.editable(row, column.id);
    return this.editable === true;
  }

  isEditing(): boolean {
    return this.editingRow !== null && this.editingCol !== null;
  }

  /** Begin editing at (row, col). Optional initial text replaces the
   *  current cell value (used for type-ahead — pressing 'A' on a cell
   *  starts the editor with 'A'). When omitted, the editor opens
   *  pre-populated with the current displayed value. */
  beginEdit(row: number, col: number, initialText?: string): void {
    if (!this.isEditableAt(row, col)) return;
    if (this.isEditing()) this.commitEdit();
    const column = this.columns[col];
    if (!column) return;

    this.editingRow = row;
    this.editingCol = col;

    // Custom editor variant: mount a fresh instance per edit session.
    // Variants compose onto the existing pipeline — Enter/Tab commit,
    // Escape cancels, validators run on commit, IME state machine
    // gates the Enter/Escape via the instance's keydown bubble.
    if (column.editor) {
      const value = this.rowSource.getCell(row, column.id);
      const displayText = column.format ? column.format(value, row) : String(value ?? '');
      const instance = column.editor.mount({
        value,
        rowIndex: row,
        columnId: column.id,
        displayText,
        ...(initialText !== undefined ? { initialText } : {}),
      });
      instance.element.style.position = 'absolute';
      instance.element.style.zIndex = '5';
      instance.element.addEventListener('keydown', this.handleEditorKeyDown);
      instance.element.addEventListener('blur', this.handleEditorBlur, true);
      this.host.appendChild(instance.element);
      this.editorInstance = instance;
      this.editorHasTyped = initialText !== undefined;
      this.repositionEditor();
      instance.focus();
      this.onBeginEdit?.(row, column.id);
      return;
    }

    if (!this.editorEl) {
      const input = document.createElement('input');
      input.type = 'text';
      input.spellcheck = false;
      input.style.cssText =
        'position:absolute;box-sizing:border-box;margin:0;padding:0 6px;' +
        'border:2px solid #6ea8fe;outline:none;background:#ffffff;color:#0b0d10;' +
        `font-family:${this.theme.fontFamily};font-size:${String(this.theme.fontSize)}px;` +
        'z-index:5;';
      input.addEventListener('keydown', this.handleEditorKeyDown);
      input.addEventListener('blur', this.handleEditorBlur);
      input.addEventListener('input', this.handleEditorInput);
      // IME state machine: tracks composition lifecycle so Enter/Tab
      // commits can wait until the user picks a candidate. Composition
      // events are the authoritative source — KeyboardEvent.isComposing
      // and keyCode===229 are advisory only.
      input.addEventListener('compositionstart', this.handleCompositionStart);
      input.addEventListener('compositionend', this.handleCompositionEnd);
      this.host.appendChild(input);
      this.editorEl = input;

      // Error bubble: a single shared element pinned just below the
      // editor. aria-invalid + aria-errormessage on the input link to
      // its id so AT can find the message via the W3C-spec'd path.
      const err = document.createElement('div');
      err.id = `${this.gridId}-editor-error`;
      err.setAttribute('aria-live', 'polite');
      err.style.cssText =
        'position:absolute;box-sizing:border-box;padding:4px 8px;' +
        'background:#3a1818;color:#ff8a8a;border:1px solid #e56f6f;' +
        `font-family:${this.theme.fontFamily};font-size:${String(this.theme.fontSize - 1)}px;` +
        'border-radius:4px;z-index:6;display:none;pointer-events:none;' +
        'max-width:320px;line-height:1.3;';
      this.host.appendChild(err);
      this.editorErrorEl = err;
      input.setAttribute('aria-errormessage', err.id);

      // LiveAnnouncer is the screen-reader fallback. Mounted lazily on
      // first edit so non-editable grids don't pay the DOM cost.
      this.liveAnnouncer = new LiveAnnouncer(this.host);
    }
    // Reset per-edit-session state. Type-ahead counts as user-typed
    // (the keystroke that opened the editor IS user input), so we
    // set the flag when initialText was supplied.
    this.editorHasTyped = initialText !== undefined;
    this.clearEditorError();

    if (initialText !== undefined) {
      this.editorEl.value = initialText;
    } else {
      const value = this.rowSource.getCell(row, column.id);
      this.editorEl.value = column.format ? column.format(value, row) : String(value ?? '');
    }
    this.editorEl.style.display = 'block';
    this.repositionEditor();
    this.editorEl.focus();
    if (initialText === undefined) this.editorEl.select();
    else {
      const len = this.editorEl.value.length;
      this.editorEl.setSelectionRange(len, len);
    }

    this.onBeginEdit?.(row, column.id);
  }

  /** Commit the current edit and notify via onCellEdit. No-op when not
   *  editing. Runs the column validator first; rejection keeps the
   *  editor open with the error message visible (reject-and-keep-open
   *  pattern). For async validators, returns a Promise so callers can
   *  await the resolution. The grid does not write the value back
   *  itself; the consumer is expected to update its row source. */
  commitEdit(): void | Promise<void> {
    if (!this.isEditing()) return;
    if (!this.editorEl && !this.editorInstance) return;
    const row = this.editingRow!;
    const col = this.editingCol!;
    const column = this.columns[col];
    const newValue = this.readEditorValue();

    if (column?.validate) {
      const result = this.runValidator('commit');
      if (result instanceof Promise) {
        return result.then((r) => {
          if (!r.ok) return; // Reject-and-keep-open
          this.finalizeCommit(row, column, newValue);
        });
      }
      if (!result.ok) return; // Reject-and-keep-open
    }
    this.finalizeCommit(row, column, newValue);
  }

  /** Read the current edit value from whichever editor is active. */
  private readEditorValue(): string {
    if (this.editorInstance) return this.editorInstance.getValue();
    return this.editorEl?.value ?? '';
  }

  private finalizeCommit(row: number, column: ColumnDef | undefined, newValue: string): void {
    if (this.editorEl) this.editorEl.style.display = 'none';
    if (this.editorInstance) this.tearDownEditorInstance();
    this.editingRow = null;
    this.editingCol = null;
    this.clearEditorError();
    if (this.editorInputDebounce !== null) {
      clearTimeout(this.editorInputDebounce);
      this.editorInputDebounce = null;
    }
    if (column) {
      const oldValue = this.rowSource.getCell(row, column.id);
      this.onCellEdit?.(row, column.id, newValue, oldValue);
    }
    this.scrollHost.focus();
    this.scheduleRender();
  }

  cancelEdit(): void {
    if (!this.isEditing()) return;
    if (!this.editorEl && !this.editorInstance) return;
    this.editingRow = null;
    this.editingCol = null;
    if (this.editorEl) this.editorEl.style.display = 'none';
    if (this.editorInstance) this.tearDownEditorInstance();
    this.clearEditorError();
    this.editorAsyncAbort?.abort();
    this.editorAsyncAbort = null;
    if (this.editorInputDebounce !== null) {
      clearTimeout(this.editorInputDebounce);
      this.editorInputDebounce = null;
    }
    this.scrollHost.focus();
    this.scheduleRender();
  }

  /** Detach + destroy the active custom editor instance. The default
   *  text editor is pooled (kept across sessions for perf); custom
   *  variants always teardown so framework state doesn't leak. */
  private tearDownEditorInstance(): void {
    if (!this.editorInstance) return;
    this.editorInstance.destroy?.();
    this.editorInstance.element.remove();
    this.editorInstance = null;
  }

  /** Position the editor over the editing cell. Called from beginEdit
   *  and from tick() so the editor tracks scroll. If the cell is
   *  scrolled offscreen we hide the editor (display:none) but keep the
   *  pending value — re-shown when the cell scrolls back in. */
  private repositionEditor(): void {
    if (this.editingRow === null || this.editingCol === null) return;
    const activeEl: HTMLElement | null = this.editorInstance?.element ?? this.editorEl;
    if (!activeEl) return;
    const rect = this.cellViewportRect(this.editingRow, this.editingCol);
    if (!rect) {
      activeEl.style.display = 'none';
      if (this.editorErrorEl) this.editorErrorEl.style.display = 'none';
      return;
    }
    activeEl.style.display = 'block';
    activeEl.style.left = `${String(rect.left)}px`;
    activeEl.style.top = `${String(rect.top)}px`;
    activeEl.style.width = `${String(rect.width)}px`;
    activeEl.style.height = `${String(rect.height)}px`;
    // Anchor error bubble below the editor; only show if there's a
    // current error message (textContent set in applyValidationResult).
    if (this.editorErrorEl && this.editorErrorEl.textContent) {
      this.editorErrorEl.style.left = `${String(rect.left)}px`;
      this.editorErrorEl.style.top = `${String(rect.top + rect.height + 2)}px`;
      this.editorErrorEl.style.display = 'block';
    }
  }

  /** Viewport-relative bounding box for (row, col), accounting for
   *  scroll, frozen columns, and the header band. Returns null if the
   *  cell is fully outside the visible area. */
  private cellViewportRect(
    row: number,
    col: number,
  ): { left: number; top: number; width: number; height: number } | null {
    if (row < 0 || row >= this.rowSource.numRows) return null;
    if (col < 0 || col >= this.columns.length) return null;

    const dataTop = this.dataBandTop();
    const dataBottom = this.dataBandBottom();
    const rowTop = this.fenwick.prefixSum(row) - this.scrollTop + dataTop;
    const rowHeight = this.fenwick.get(row);
    if (rowTop + rowHeight <= dataTop) return null;
    if (rowTop >= dataBottom) return null;

    const colLeft = this.cumulativeColumnWidths[col] ?? 0;
    const colWidth = (this.cumulativeColumnWidths[col + 1] ?? colLeft) - colLeft;

    let left: number;
    if (col < this.frozenColumnCount) {
      left = colLeft;
    } else {
      const frozenEnd = this.cumulativeColumnWidths[this.frozenColumnCount] ?? 0;
      left = this.frozenWidth + (colLeft - frozenEnd) - this.scrollLeft;
      if (left + colWidth <= this.frozenWidth) return null;
      if (left >= this.viewportWidth) return null;
    }

    return { left, top: rowTop, width: colWidth, height: rowHeight };
  }

  /** Flip the IME state to composing. Called when the user starts a
   *  multi-keystroke input (Pinyin, Kana, Hangul, dead-key sequences).
   *  While composing, Enter/Tab/Escape do not commit/cancel — they're
   *  consumed by the IME to pick or dismiss candidates. */
  private handleCompositionStart = (): void => {
    this.editorIsComposing = true;
  };

  /** Composition ended — the IME has produced a final value. Re-enable
   *  commit shortcuts. Note: `compositionend` may fire *before* the
   *  final keydown of the trigger key in some Chromium versions, so we
   *  also defensively check `e.isComposing` inside handleEditorKeyDown. */
  private handleCompositionEnd = (): void => {
    this.editorIsComposing = false;
  };

  private handleEditorKeyDown = (e: KeyboardEvent): void => {
    // Authoritative IME guard. Block all commit / navigation shortcuts
    // while composing. Defensive secondary check on KeyboardEvent props
    // (`isComposing` and the 229 sentinel) catches the narrow window
    // where compositionend hasn't fired yet but the IME is still active.
    // keyCode is deprecated but still emitted by every browser; 229 is
    // the well-known IME-active sentinel and there is no replacement.
    const keyCode = (e as KeyboardEvent & { keyCode: number }).keyCode;
    if (this.editorIsComposing || e.isComposing || keyCode === 229) {
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      this.commitEdit();
      this.selection.moveActive(
        e.shiftKey ? -1 : 1,
        0,
        this.rowSource.numRows,
        this.columns.length,
      );
      this.notifySelectionChange();
      this.scrollActiveIntoView();
      return;
    }
    if (e.key === 'Tab') {
      e.preventDefault();
      e.stopPropagation();
      this.commitEdit();
      this.selection.moveActive(
        0,
        e.shiftKey ? -1 : 1,
        this.rowSource.numRows,
        this.columns.length,
      );
      this.notifySelectionChange();
      this.scrollActiveIntoView();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      this.cancelEdit();
      return;
    }
  };

  private handleEditorBlur = (): void => {
    if (this.isEditing()) this.commitEdit();
  };

  /** Per-keystroke validator dispatch. Debounced ~100ms so we don't
   *  re-run the validator on every character of fast typing. Skipped
   *  while the IME is composing — partial codepoints would otherwise
   *  be flagged as invalid mid-composition. Async validators are
   *  intentionally NOT awaited here; their result is computed at
   *  commit time, so input-phase only runs synchronous validators. */
  private handleEditorInput = (): void => {
    if (this.editorIsComposing) return;
    this.editorHasTyped = true;
    if (this.editorInputDebounce !== null) clearTimeout(this.editorInputDebounce);
    this.editorInputDebounce = setTimeout(() => {
      this.editorInputDebounce = null;
      this.runValidator('input');
    }, 100);
  };

  /** Run the active column's validator at the given phase. Sync results
   *  apply immediately; promise results are wrapped with AbortController
   *  so a fast-typing user never sees stale validation errors. */
  private runValidator(phase: 'input' | 'commit'): ValidationResult | Promise<ValidationResult> {
    if (this.editingRow === null || this.editingCol === null || !this.editorEl) {
      return { ok: true };
    }
    const column = this.columns[this.editingCol];
    if (!column?.validate) return { ok: true };

    // Cancel any in-flight async validator from a previous keystroke.
    this.editorAsyncAbort?.abort();
    this.editorAsyncAbort = new AbortController();
    const myAbort = this.editorAsyncAbort;

    const result = column.validate(this.editorEl.value, {
      rowIndex: this.editingRow,
      columnId: column.id,
      phase,
    });

    if (!(result instanceof Promise)) {
      this.applyValidationResult(result);
      return result;
    }
    return result.then((r) => {
      // Drop the result if a newer keystroke superseded this one.
      if (myAbort.signal.aborted) return r;
      this.applyValidationResult(r);
      return r;
    });
  }

  private applyValidationResult(result: ValidationResult): void {
    if (!this.editorEl || !this.editorErrorEl) return;
    if (result.ok) {
      this.clearEditorError();
      return;
    }
    // aria-invalid is only set AFTER the user has typed — setting it on
    // initial focus causes JAWS/VoiceOver to announce "invalid entry"
    // before the user has had a chance to type anything.
    if (this.editorHasTyped) {
      this.editorEl.setAttribute('aria-invalid', 'true');
    }
    this.editorErrorEl.textContent = result.message;
    this.editorErrorEl.style.display = 'block';
    this.liveAnnouncer?.announce(result.message, 'polite');
  }

  private clearEditorError(): void {
    if (this.editorEl) this.editorEl.removeAttribute('aria-invalid');
    if (this.editorErrorEl) {
      this.editorErrorEl.textContent = '';
      this.editorErrorEl.style.display = 'none';
    }
  }

  private handleDoubleClick = (e: MouseEvent): void => {
    // Wave 24: double-click on a column-resize boundary triggers
    // auto-size for that column. Same hit-zone as the resize drag.
    if (this.columnResizeEnabled) {
      const rect = this.scrollHost.getBoundingClientRect();
      const localX = e.clientX - rect.left;
      const localY = e.clientY - rect.top;
      if (localY >= 0 && localY < this.fullHeaderHeight()) {
        const colIdx = this.columnAtRightBoundary(localX);
        if (colIdx !== null && this.columns[colIdx]) {
          this.autoSizeColumn(this.columns[colIdx].id);
          e.preventDefault();
          return;
        }
      }
    }
    const cell = this.cellAtClient(e.clientX, e.clientY);
    if (!cell) return;
    if (!this.isEditableAt(cell.row, cell.col)) return;
    this.beginEdit(cell.row, cell.col);
    e.preventDefault();
  };

  private handlePaste = (e: ClipboardEvent): void => {
    if (this.isEditing()) return; // let the input handle native paste
    if (document.activeElement !== this.scrollHost) return;
    if (!this.onPaste) return;
    const text = e.clipboardData?.getData('text/plain') ?? '';
    if (!text) return;
    const anchor = this.selection.active;
    if (!anchor) return;
    const rows = parseTsv(text);
    if (rows.length === 0) return;
    e.preventDefault();
    this.onPaste(anchor.row, anchor.col, rows);
  };

  // ---------------------------------------------------------------------------
  // Render loop
  // ---------------------------------------------------------------------------

  private scheduleRender(): void {
    this.needsRender = true;
    if (this.rafHandle === null && !this.destroyed) {
      this.rafHandle = requestAnimationFrame(this.tick);
    }
  }

  private tick = (ts: number): void => {
    this.rafHandle = null;
    if (this.destroyed) return;
    const scrollDelta = Math.abs(this.scrollTop - this.lastRenderedScrollTop);
    const hasWork =
      this.needsRender ||
      this.scrollTop !== this.lastRenderedScrollTop ||
      this.scrollLeft !== this.lastRenderedScrollLeft;
    if (hasWork) {
      const t0 = performance.now();
      const stats = this.render();
      const t1 = performance.now();
      this.recordFrame(ts, t1 - t0, scrollDelta, stats.drawCellsPerFrame);
      this.onFrame?.({
        ...stats,
        drawDurationMs: t1 - t0,
        fps: this.computeRollingFps(),
      });
      this.lastRenderedScrollTop = this.scrollTop;
      this.lastRenderedScrollLeft = this.scrollLeft;
      this.needsRender = false;
      // Track the cell editor with the latest layout. Cheap when not editing.
      if (this.isEditing()) this.repositionEditor();
      if (this.floatingFilterBandEl) this.repositionFloatingFilters();
    }
    // v0.0.10 incremental-redraw discipline: stop the always-on rAF
    // loop. Previously we re-armed unconditionally — fine for cell-
    // pool overlays that want a steady 60 Hz pulse, terrible for
    // battery on idle grids. Now we only re-arm when there's work
    // queued (mid-fling scroll mismatch, cell-edit reposition window,
    // floating filters needing layout). scheduleRender() restarts the
    // loop on demand.
    const stillDirty =
      this.scrollTop !== this.lastRenderedScrollTop ||
      this.scrollLeft !== this.lastRenderedScrollLeft ||
      this.isEditing() ||
      this.floatingFilterBandEl !== null ||
      this.flashes.size > 0;
    if (!this.destroyed && stillDirty) {
      this.rafHandle = requestAnimationFrame(this.tick);
    }
  };

  private recordFrame(
    ts: number,
    drawDurationMs: number,
    scrollDelta: number,
    cells: number,
  ): void {
    const sample: FrameSample = { ts, drawDurationMs, scrollDelta, cells };
    if (this.frameBuffer.length < this.frameBufferCap) {
      this.frameBuffer.push(sample);
    } else {
      this.frameBuffer[this.frameBufferHead] = sample;
      this.frameBufferHead = (this.frameBufferHead + 1) % this.frameBufferCap;
    }
    if (this.debugLog && drawDurationMs > 16) {
      console.warn(
        `[onegrid] long frame ${drawDurationMs.toFixed(1)}ms (cells=${String(cells)}, dy=${scrollDelta.toFixed(0)}px)`,
      );
    }
  }

  private framesInOrder(): FrameSample[] {
    if (this.frameBuffer.length < this.frameBufferCap) return this.frameBuffer.slice();
    return [
      ...this.frameBuffer.slice(this.frameBufferHead),
      ...this.frameBuffer.slice(0, this.frameBufferHead),
    ];
  }

  private computeRollingFps(): number {
    const frames = this.framesInOrder();
    if (frames.length < 2) return 0;
    const cutoff = (frames[frames.length - 1]?.ts ?? 0) - 1000;
    let i = frames.length - 1;
    while (i > 0 && (frames[i - 1]?.ts ?? 0) >= cutoff) i--;
    const window = frames.slice(i);
    if (window.length < 2) return 0;
    const first = window[0];
    const last = window[window.length - 1];
    if (!first || !last) return 0;
    const elapsed = last.ts - first.ts;
    if (elapsed <= 0) return 0;
    return Math.round((window.length - 1) / (elapsed / 1000));
  }

  // ---------------------------------------------------------------------------
  // Loading / no-rows overlay (wave 24)
  // ---------------------------------------------------------------------------

  /**
   * Public setter for the loading flag. Adopters who use SSRM block-fetch
   * pending state, ORM query-in-flight, or async filter recompute call
   * this whenever their async pipeline starts / finishes.
   */
  setLoading(value: boolean): void {
    if (this.loading === value) return;
    this.loading = value;
    this.scheduleRender();
  }

  /**
   * Flash a cell with the configured tint (wave 24). Adopters call this
   * from their CDC handler / optimistic-mutation onCommit / formula
   * recompute callback. Idempotent within one flash window — calling
   * twice resets the start time so the user sees the latest change.
   */
  flashCell(rowIndex: number, columnId: string): void {
    if (this.flashDurationMs <= 0) return;
    this.flashes.set(`${String(rowIndex)}:${columnId}`, performance.now());
    this.scheduleRender();
  }

  /** Same as flashCell, broadcast to every column in a row. */
  flashRow(rowIndex: number): void {
    if (this.flashDurationMs <= 0) return;
    const now = performance.now();
    for (const c of this.columns) {
      this.flashes.set(`${String(rowIndex)}:${c.id}`, now);
    }
    this.scheduleRender();
  }

  /**
   * Resize a column to fit the widest visible cell + a constant padding
   * (wave 24). Measures via the canvas 2D `measureText` so the result
   * matches the renderer's actual font metrics. Clamped to the column's
   * `minWidth` / `maxWidth` if set; emits `onColumnResize(id, width, true)`
   * so the host store stays in sync.
   */
  autoSizeColumn(columnId: string): void {
    const colIdx = this.columns.findIndex((c) => c.id === columnId);
    if (colIdx < 0) return;
    const column = this.columns[colIdx];
    if (!column) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.font = `${String(this.theme.fontSize)}px ${this.theme.fontFamily}`;
    // Measure across the currently-visible row range — auto-sizing the
    // whole 10M-row dataset would be O(N) and unnecessary; the visible
    // sample matches what the user expects.
    const dataTop = this.dataBandTop();
    const dataBottom = this.dataBandBottom();
    const start = Math.max(0, this.fenwick.indexAtOffset(this.scrollTop));
    const end = Math.min(
      this.rowSource.numRows - 1,
      this.fenwick.indexAtOffset(this.scrollTop + (dataBottom - dataTop)),
    );
    let maxText = 0;
    // Include the header text in the measurement.
    const headerText = column.displayName ?? column.id;
    maxText = Math.max(maxText, ctx.measureText(headerText).width);
    for (let r = start; r <= end; r++) {
      const value = this.rowSource.getCell(r, column.id);
      const text = column.format
        ? column.format(value, r)
        : String(value ?? '');
      const w = ctx.measureText(text).width;
      if (w > maxText) maxText = w;
    }
    ctx.restore();
    const PAD = 24; // 12 px left + right
    let target = Math.ceil(maxText + PAD);
    if (column.minWidth !== undefined) target = Math.max(target, column.minWidth);
    if (column.maxWidth !== undefined) target = Math.min(target, column.maxWidth);
    if (target === column.width) return;
    const next = [...this.columns];
    next[colIdx] = { ...column, width: target };
    this.columns = next;
    this.recomputeColumnLayout();
    this.scheduleRender();
    this.onColumnResize?.(column.id, target, true);
  }

  /** Auto-size every column. Useful as a one-off "fit everything" action. */
  autoSizeColumns(): void {
    for (const c of this.columns) this.autoSizeColumn(c.id);
  }

  // ---------------------------------------------------------------------------
  // Find / replace (wave 25)
  // ---------------------------------------------------------------------------

  /** Show the find toolbar and focus its input. */
  openFind(): void {
    if (!this.findToolbarEl) return;
    this.findToolbarEl.style.display = 'flex';
    this.findInputEl?.focus();
    this.findInputEl?.select();
  }

  /** Hide the find toolbar and clear the query so highlights disappear. */
  closeFind(): void {
    if (!this.findToolbarEl) return;
    this.findToolbarEl.style.display = 'none';
    this.findQuery = '';
    this.scheduleRender();
  }

  /** Set the current find query (highlights every visible match). */
  setFindQuery(query: string): void {
    this.findQuery = query;
    this.scheduleRender();
  }

  /** Return the active find query, or '' when no find is in flight. */
  getFindQuery(): string {
    return this.findQuery;
  }

  /**
   * Advance the selection to the next matching cell. Searches forward
   * from the current active cell; if no later match exists, wraps to
   * the start of the dataset (Excel/VS Code behavior).
   */
  findNext(): boolean {
    return this.findStep(1);
  }

  /** Step backward. Wraps to end when no earlier match exists. */
  findPrev(): boolean {
    return this.findStep(-1);
  }

  /**
   * Apply `newValue` to the cell currently matched. Fires `onReplace`
   * for the adopter to actually mutate the data — the grid doesn't own
   * the row store. Then advances to the next match.
   */
  replaceCurrent(newValue?: string): void {
    if (!this.onReplaceCallback) return;
    const replaceWith = newValue ?? this.replaceInputEl?.value ?? '';
    const active = this.selection.active;
    if (!active) return;
    const column = this.columns[active.col];
    if (!column) return;
    const oldValue = this.rowSource.getCell(active.row, column.id);
    if (!this.cellMatches(active.row, column.id)) {
      this.findNext();
      return;
    }
    this.onReplaceCallback(active.row, column.id, replaceWith, oldValue);
    this.findNext();
  }

  /**
   * Walk every cell across the visible viewport and call `onReplace`
   * for each match. Adopters who want whole-dataset scope can scroll
   * to the top, call this, then iterate. The grid intentionally does
   * NOT walk 10M rows in one call.
   */
  replaceAll(newValue: string): number {
    if (!this.onReplaceCallback) return 0;
    if (!this.findQuery) return 0;
    let count = 0;
    // Default scope: visible viewport. If the viewport has no usable
    // height (test envs, hidden grids), fall back to a hard-capped
    // whole-dataset walk so the operation isn't silently a no-op.
    const dataTop = this.dataBandTop();
    const dataBottom = this.dataBandBottom();
    const viewportHeight = Math.max(0, dataBottom - dataTop);
    let start = 0;
    let end = Math.min(this.rowSource.numRows - 1, 50_000);
    if (viewportHeight > 0) {
      start = Math.max(0, this.fenwick.indexAtOffset(this.scrollTop));
      end = Math.min(
        this.rowSource.numRows - 1,
        this.fenwick.indexAtOffset(this.scrollTop + viewportHeight),
      );
    }
    for (let r = start; r <= end; r++) {
      for (const col of this.columns) {
        if (this.cellMatches(r, col.id)) {
          const oldValue = this.rowSource.getCell(r, col.id);
          this.onReplaceCallback(r, col.id, newValue, oldValue);
          count++;
        }
      }
    }
    this.scheduleRender();
    return count;
  }

  /** Test whether a single cell's stringified value contains the query. */
  private cellMatches(rowIndex: number, columnId: string): boolean {
    if (!this.findQuery) return false;
    const v = this.rowSource.getCell(rowIndex, columnId);
    const text = v === null || v === undefined ? '' : String(v);
    return text.toLowerCase().includes(this.findQuery.toLowerCase());
  }

  /** Walk forward (+1) or backward (-1) to the next match; return true if found. */
  private findStep(direction: 1 | -1): boolean {
    if (!this.findQuery) return false;
    const active = this.selection.active;
    const startRow = active?.row ?? 0;
    const startCol = active?.col ?? 0;
    const rows = this.rowSource.numRows;
    const cols = this.columns.length;
    // Linear scan across the visible range first (cheap, matches user
    // expectation). If nothing visible, fall back to whole-dataset scan
    // capped at a hard limit so the UI doesn't freeze.
    const HARD_CAP = 50_000;
    const scanRows = Math.min(rows, HARD_CAP);
    for (let off = 1; off <= scanRows * cols; off++) {
      const total = scanRows * cols;
      const delta = direction === 1 ? off : -off;
      const idx = ((startRow * cols + startCol + delta) % total + total) % total;
      const r = Math.floor(idx / cols);
      const c = idx % cols;
      const col = this.columns[c];
      if (col && this.cellMatches(r, col.id)) {
        this.gotoCell(r, c, false);
        return true;
      }
    }
    return false;
  }

  /**
   * Move (or shift-extend) the active cell to an absolute (row, col)
   * position, clamped to the grid extent. Used by Ctrl+Home / Ctrl+End /
   * Ctrl+arrow / PageUp / PageDown handlers and exposed publicly so
   * adopters can drive navigation imperatively too.
   */
  gotoCell(row: number, col: number, extend = false): void {
    const targetRow = Math.max(0, Math.min(this.rowSource.numRows - 1, row));
    const targetCol = Math.max(0, Math.min(this.columns.length - 1, col));
    const active = this.selection.active;
    const dr = active ? targetRow - active.row : targetRow;
    const dc = active ? targetCol - active.col : targetCol;
    if (extend && active && !this.selection.isEmpty()) {
      this.selection.extendActiveBy(dr, dc, this.rowSource.numRows, this.columns.length);
    } else {
      this.selection.moveActive(dr, dc, this.rowSource.numRows, this.columns.length);
    }
    this.notifySelectionChange();
    this.scrollActiveIntoView();
    this.scheduleRender();
  }

  /**
   * Sync the overlay element to the current grid state. Runs every frame
   * because it's cheap (mode comparison + a couple style writes); the
   * mode-change guard avoids touching DOM unless something flipped.
   */
  private syncOverlay(): void {
    const dataTop = this.dataBandTop();
    const dataBottom = this.dataBandBottom();
    this.overlayEl.style.top = `${String(dataTop)}px`;
    this.overlayEl.style.height = `${String(Math.max(0, dataBottom - dataTop))}px`;
    const mode: 'hidden' | 'loading' | 'no-rows' = this.loading
      ? 'loading'
      : this.rowSource.numRows === 0
        ? 'no-rows'
        : 'hidden';
    if (mode === this.lastOverlayMode) return;
    this.lastOverlayMode = mode;
    if (mode === 'hidden') {
      this.overlayEl.style.display = 'none';
      this.overlayEl.replaceChildren();
      return;
    }
    this.overlayEl.style.display = 'flex';
    this.overlayEl.replaceChildren();
    if (mode === 'loading' && this.loadingOverlay) {
      this.loadingOverlay(this.overlayEl);
      return;
    }
    if (mode === 'no-rows' && this.noRowsOverlay) {
      this.noRowsOverlay(this.overlayEl);
      return;
    }
    // Built-in default: small spinner-ish dot + label.
    const label = document.createElement('div');
    label.style.cssText =
      'display:flex;align-items:center;gap:8px;padding:8px 14px;' +
      `background:${this.theme.headerBackground};border:1px solid #2a2f37;border-radius:6px;`;
    if (mode === 'loading') {
      const dot = document.createElement('div');
      dot.style.cssText =
        'width:12px;height:12px;border-radius:50%;border:2px solid #2a2f37;' +
        `border-top-color:${this.theme.text};animation:onegrid-spin 0.8s linear infinite;`;
      // Inject keyframes once.
      if (!document.getElementById('onegrid-overlay-keyframes')) {
        const style = document.createElement('style');
        style.id = 'onegrid-overlay-keyframes';
        style.textContent =
          '@keyframes onegrid-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }';
        document.head.appendChild(style);
      }
      label.appendChild(dot);
      const text = document.createElement('span');
      text.textContent = 'Loading…';
      label.appendChild(text);
    } else {
      const text = document.createElement('span');
      text.textContent = 'No rows to show';
      label.appendChild(text);
    }
    this.overlayEl.appendChild(label);
  }

  // ---------------------------------------------------------------------------
  // Drawing
  // ---------------------------------------------------------------------------

  private render(): Omit<FrameStats, 'fps' | 'drawDurationMs'> {
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.viewportWidth, this.viewportHeight);

    this.syncOverlay();

    const dataTop = this.dataBandTop();
    const dataBottom = this.dataBandBottom();
    const dataHeight = Math.max(0, dataBottom - dataTop);

    // Direction-aware row overscan — pre-fetch more rows ahead of
    // travel than behind. See adaptiveOverscan() for derivation.
    const { ahead, behind } = this.adaptiveOverscan();
    const overscanTop = this.scrollDirection < 0 ? ahead : behind;
    const overscanBottom = this.scrollDirection < 0 ? behind : ahead;
    const start = Math.max(0, this.fenwick.indexAtOffset(this.scrollTop) - overscanTop);
    const endOffset = this.scrollTop + dataHeight;
    const end = Math.min(
      this.rowSource.numRows - 1,
      this.fenwick.indexAtOffset(endOffset) + overscanBottom,
    );

    const firstRowTop = this.fenwick.prefixSum(start);
    let drawnCells = 0;

    // Scrolling band — non-frozen columns.
    ctx.save();
    ctx.beginPath();
    ctx.rect(
      this.frozenWidth,
      dataTop,
      this.viewportWidth - this.frozenWidth,
      dataHeight,
    );
    ctx.clip();
    drawnCells += this.drawRows(
      start,
      end,
      firstRowTop,
      this.frozenColumnCount,
      this.columns.length,
      this.scrollLeft,
    );
    ctx.restore();

    // Frozen columns (always on top of scrolling band).
    if (this.frozenColumnCount > 0) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, dataTop, this.frozenWidth, dataHeight);
      ctx.clip();
      drawnCells += this.drawRows(start, end, firstRowTop, 0, this.frozenColumnCount, 0);
      ctx.restore();
    }

    this.drawSelectionOverlay(start, end);
    if (this.getDetailContent) {
      this.drawChevrons(start, end, firstRowTop);
      this.syncDetailLayer(start, end, firstRowTop);
    }
    drawnCells += this.drawPinnedBand(this.pinnedTopRowSource, this.fullHeaderHeight());
    drawnCells += this.drawPinnedBand(
      this.pinnedBottomRowSource,
      dataBottom,
    );
    this.drawHeader();
    this.drawStickyGroupRow(start);
    this.drawPinnedDataRows(start, end);
    this.updateStatusBar();
    if (this.rendererPool) this.syncCellOverlay(start, end);
    this.updateAccessibilityShadow(start, end);

    return {
      visibleRowStart: start,
      visibleRowEnd: end,
      drawCellsPerFrame: drawnCells,
    };
  }

  /** Paint a small ▶/▼ chevron at the leftmost edge of every visible row.
   *  Click detection lives in handlePointerDown; this is purely visual.
   *  Drawn after rows but before the header so it doesn't bleed into the
   *  header band on scroll. */
  private drawChevrons(start: number, end: number, firstRowTop: number): void {
    const ctx = this.ctx;
    let y = this.dataBandTop() + (firstRowTop - this.scrollTop);
    ctx.font = `${String(this.theme.fontSize)}px ${this.theme.fontFamily}`;
    ctx.textBaseline = 'middle';
    ctx.fillStyle = this.theme.mutedText;
    for (let row = start; row <= end; row++) {
      const baseH = this.baseHeights[row] ?? 0;
      const expanded = this.expanded.has(row);
      const glyph = expanded ? '\u25BC' : '\u25B6'; // ▼ / ▶
      // Center the chevron vertically in the row's BASE band (not over
      // the detail panel area).
      ctx.fillText(glyph, 8, y + baseH / 2 + 1);
      y += baseH + (expanded ? this.detailHeight : 0);
    }
  }

  /** Mount / position / unmount detail panel divs based on which expanded
   *  rows fall in the visible viewport. Reuses cached panel elements so
   *  the user's content survives scroll without re-render. */
  private syncDetailLayer(start: number, end: number, firstRowTop: number): void {
    if (!this.detailLayer || !this.getDetailContent) return;
    const visibleExpanded = new Set<number>();
    let y = this.dataBandTop() + (firstRowTop - this.scrollTop);
    for (let row = start; row <= end; row++) {
      const baseH = this.baseHeights[row] ?? 0;
      if (this.expanded.has(row)) {
        visibleExpanded.add(row);
        let panel = this.mountedDetails.get(row);
        if (!panel) {
          const content = this.getDetailContent(row);
          if (content) {
            panel = document.createElement('div');
            panel.style.cssText =
              'position:absolute;left:0;right:0;pointer-events:auto;overflow:hidden;';
            panel.appendChild(content);
            this.detailLayer.appendChild(panel);
            this.mountedDetails.set(row, panel);
          }
        }
        if (panel) {
          panel.style.top = `${String(y + baseH)}px`;
          panel.style.height = `${String(this.detailHeight)}px`;
        }
      }
      y += baseH + (this.expanded.has(row) ? this.detailHeight : 0);
    }
    // Garbage-collect panels for rows that are no longer in view OR no
    // longer expanded. Fire onDetailUnmount FIRST so the consumer can
    // tear down nested resources (e.g. a nested Grid's destroy()).
    for (const [row, panel] of this.mountedDetails) {
      if (!visibleExpanded.has(row)) {
        const userContent = panel.firstChild as HTMLElement | null;
        if (userContent && this.onDetailUnmount) {
          this.onDetailUnmount(row, userContent);
        }
        panel.remove();
        this.mountedDetails.delete(row);
      }
    }
  }

  private drawSelectionOverlay(start: number, end: number): void {
    if (this.selection.isEmpty()) return;
    const ctx = this.ctx;
    const ranges = this.selection.normalizedRanges();
    const active = this.selection.active;

    for (const range of ranges) {
      if (range.rowEnd < start || range.rowStart > end) continue;
      const rowFrom = Math.max(range.rowStart, start);
      const rowTo = Math.min(range.rowEnd, end);
      const yTop =
        this.dataBandTop() + (this.fenwick.prefixSum(rowFrom) - this.scrollTop);
      let h = 0;
      for (let r = rowFrom; r <= rowTo; r++) h += this.fenwick.get(r);

      const colFrom = Math.max(range.colStart, 0);
      const colTo = Math.min(range.colEnd, this.columns.length - 1);
      for (let c = colFrom; c <= colTo; c++) {
        const isFrozen = c < this.frozenColumnCount;
        const x = isFrozen
          ? (this.cumulativeColumnWidths[c] ?? 0)
          : this.frozenWidth +
            ((this.cumulativeColumnWidths[c] ?? 0) -
              (this.cumulativeColumnWidths[this.frozenColumnCount] ?? 0)) -
            this.scrollLeft;
        const w = this.columns[c]?.width ?? 0;
        if (x + w < 0 || x > this.viewportWidth) continue;
        ctx.fillStyle = 'rgba(110, 168, 254, 0.18)';
        ctx.fillRect(x, yTop, w, h);
      }
    }

    if (active && active.row >= start && active.row <= end) {
      const isFrozen = active.col < this.frozenColumnCount;
      const x = isFrozen
        ? (this.cumulativeColumnWidths[active.col] ?? 0)
        : this.frozenWidth +
          ((this.cumulativeColumnWidths[active.col] ?? 0) -
            (this.cumulativeColumnWidths[this.frozenColumnCount] ?? 0)) -
          this.scrollLeft;
      const y = this.dataBandTop() + (this.fenwick.prefixSum(active.row) - this.scrollTop);
      const w = this.columns[active.col]?.width ?? 0;
      const h = this.fenwick.get(active.row);
      ctx.strokeStyle = '#6ea8fe';
      ctx.lineWidth = 2;
      ctx.strokeRect(x + 1, y + 1, w - 2, h - 2);
    }

    // Fill handle on the bottom-right of the *last* range (Excel/Sheets
    // convention — when you have a multi-rect selection the handle
    // attaches to the most recently anchored range).
    if (this.fillHandleEnabled && ranges.length > 0) {
      const last = ranges[ranges.length - 1]!;
      if (last.rowEnd >= start && last.rowEnd <= end) {
        const c = Math.min(last.colEnd, this.columns.length - 1);
        const isFrozen = c < this.frozenColumnCount;
        const x = isFrozen
          ? (this.cumulativeColumnWidths[c + 1] ?? 0)
          : this.frozenWidth +
            ((this.cumulativeColumnWidths[c + 1] ?? 0) -
              (this.cumulativeColumnWidths[this.frozenColumnCount] ?? 0)) -
            this.scrollLeft;
        const y =
          this.dataBandTop() +
          this.fenwick.prefixSum(last.rowEnd) -
          this.scrollTop +
          this.fenwick.get(last.rowEnd);
        const s = this.fillHandleSize;
        ctx.fillStyle = '#6ea8fe';
        ctx.fillRect(x - s, y - s, s, s);
      }
    }

    // Live fill-drag preview: a dashed outline of the union of the
    // source range and the cells the cursor has dragged into.
    if (this.fillDragState) {
      const f = this.fillDragState;
      const rowStart = Math.min(f.source.rowStart, f.targetRow);
      const rowEnd = Math.max(f.source.rowEnd, f.targetRow);
      const colStart = Math.min(f.source.colStart, f.targetCol);
      const colEnd = Math.max(f.source.colEnd, f.targetCol);
      if (rowEnd >= start && rowStart <= end) {
        const cFrom = Math.max(colStart, 0);
        const cTo = Math.min(colEnd, this.columns.length - 1);
        const isFrozen = cFrom < this.frozenColumnCount;
        const xLeft = isFrozen
          ? (this.cumulativeColumnWidths[cFrom] ?? 0)
          : this.frozenWidth +
            ((this.cumulativeColumnWidths[cFrom] ?? 0) -
              (this.cumulativeColumnWidths[this.frozenColumnCount] ?? 0)) -
            this.scrollLeft;
        const xRight =
          cTo < this.frozenColumnCount
            ? (this.cumulativeColumnWidths[cTo + 1] ?? 0)
            : this.frozenWidth +
              ((this.cumulativeColumnWidths[cTo + 1] ?? 0) -
                (this.cumulativeColumnWidths[this.frozenColumnCount] ?? 0)) -
              this.scrollLeft;
        const yTop =
          this.dataBandTop() +
          (this.fenwick.prefixSum(Math.max(rowStart, start)) - this.scrollTop);
        let yH = 0;
        for (let r = Math.max(rowStart, start); r <= Math.min(rowEnd, end); r++) {
          yH += this.fenwick.get(r);
        }
        ctx.save();
        ctx.strokeStyle = '#6ea8fe';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.strokeRect(xLeft + 0.5, yTop + 0.5, xRight - xLeft - 1, yH - 1);
        ctx.restore();
      }
    }
  }

  /**
   * Narrow [colStart, colEnd) to the inclusive [first, last] visible
   * range given the band's horizontalOffset. Returns the running `x`
   * at `first` so the cell-paint loop can start from there. v0.0.10
   * column virtualization: avoids iterating columns that are off-screen
   * to the left or right of the viewport. Wins compound with column
   * count — a 200-column grid showing 12 columns no longer pays for
   * the other 188 in every drawn row.
   */
  private visibleColumnRangeInBand(
    colStart: number,
    colEnd: number,
    horizontalOffset: number,
  ): { first: number; last: number; xStart: number } {
    // x at col c in viewport coords =
    //   -horizontalOffset + cumulativeColumnWidths[c]
    //
    // (The pre-v0.0.10 drawRows did `x = -horizontalOffset; if (colStart
    // > 0) x += cumulativeColumnWidths[colStart]`, then advanced by
    // widths in the loop. This helper preserves the same invariant —
    // the leading `cumulativeColumnWidths[colStart]` term is what
    // accounts for the frozen-column gap when the scrolling band is
    // drawn after the frozen band.)
    const base = this.cumulativeColumnWidths[colStart] ?? 0;
    let x = -horizontalOffset + base;
    let first = colStart;
    for (let c = colStart; c < colEnd; c++) {
      const w = this.columns[c]?.width ?? 0;
      if (x + w >= 0) {
        first = c;
        break;
      }
      x += w;
      first = c + 1;
    }
    if (first >= colEnd) {
      return { first: colEnd, last: colEnd - 1, xStart: x };
    }
    const xStart = x;
    let last = first;
    let xCur = xStart;
    for (let c = first; c < colEnd; c++) {
      if (xCur > this.viewportWidth) break;
      last = c;
      xCur += this.columns[c]?.width ?? 0;
    }
    return { first, last, xStart };
  }

  private drawRows(
    start: number,
    end: number,
    firstRowTop: number,
    colStart: number,
    colEnd: number,
    horizontalOffset: number,
  ): number {
    const ctx = this.ctx;
    const theme = this.theme;
    let y = this.dataBandTop() + (firstRowTop - this.scrollTop);
    let drawn = 0;

    ctx.font = `${String(theme.fontSize)}px ${theme.fontFamily}`;
    ctx.textBaseline = 'middle';

    // Column virtualization: compute once per band (horizontalOffset is
    // constant within a drawRows call).
    const colRange = this.visibleColumnRangeInBand(
      colStart,
      colEnd,
      horizontalOffset,
    );

    for (let row = start; row <= end; row++) {
      const h = this.fenwick.get(row);
      const meta = this.getRowMeta?.(row);

      if (meta && meta.kind === 'group') {
        // Paint group-row band (only on the non-frozen pass to avoid
        // double-painting; the frozen-band caller passes colStart=0
        // and colEnd=frozenColumnCount, so we detect that case).
        const isFrozenPass = colStart === 0 && colEnd === this.frozenColumnCount;
        if (!isFrozenPass) {
          this.drawGroupRow(meta, y, h, horizontalOffset);
          drawn++;
        }
        y += h;
        continue;
      }
      // Tree rows render normal cells PLUS a chevron + indent on the
      // leftmost column; cell-paint pass below shifts text by the
      // tree indent computed here.
      const treeMeta = meta && meta.kind === 'tree' ? meta : null;

      ctx.fillStyle = row % 2 === 0 ? theme.background : theme.altRowBackground;
      ctx.fillRect(0, y, this.viewportWidth, h);

      let x = colRange.xStart;

      for (let col = colRange.first; col <= colRange.last; col++) {
        const column = this.columns[col];
        if (!column) continue;
        const w = column.width;

        {
          // Custom-renderer columns: leave the cell blank so the DOM
          // overlay paints the visual. Still draw the column divider
          // so the grid lines stay continuous.
          if (column.renderer) {
            ctx.strokeStyle = theme.border;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(x + w - 0.5, y);
            ctx.lineTo(x + w - 0.5, y + h);
            ctx.stroke();
            x += w;
            continue;
          }
          const value = this.rowSource.getCell(row, column.id);
          const text = column.format ? column.format(value, row) : String(value ?? '');
          const fg = column.color?.(value, row) ?? theme.text;
          const bg = column.background?.(value, row);

          if (bg) {
            ctx.fillStyle = bg;
            ctx.fillRect(x, y, w, h);
          }

          // Wave-25 find/replace highlight: tint cells whose stringified
          // value contains the active query. Drawn on top of bg fill,
          // below the flash overlay, behind the text.
          if (this.findQuery && this.cellMatches(row, column.id)) {
            ctx.globalAlpha = 0.55;
            ctx.fillStyle = this.findHighlightColor;
            ctx.fillRect(x, y, w, h);
            ctx.globalAlpha = 1;
          }

          // Wave-24 cell flash overlay. Sits between the bg paint and
          // the text so it tints the background but doesn't wash out
          // the text. Cheap when the flash buffer is empty.
          if (this.flashes.size > 0) {
            const flashStart = this.flashes.get(`${String(row)}:${column.id}`);
            if (flashStart !== undefined) {
              const elapsed = performance.now() - flashStart;
              if (elapsed >= this.flashDurationMs) {
                this.flashes.delete(`${String(row)}:${column.id}`);
              } else {
                const fade = 1 - elapsed / this.flashDurationMs;
                ctx.globalAlpha = fade;
                ctx.fillStyle = this.flashColor;
                ctx.fillRect(x, y, w, h);
                ctx.globalAlpha = 1;
              }
            }
          }

          // Tree row: paint chevron + indent on the leftmost column,
          // shift text right by indent amount.
          let textPad = 12;
          const isLeftmostCol = col === colStart && colStart === 0;
          if (treeMeta && isLeftmostCol) {
            const indent = treeMeta.depth * 16;
            textPad = 12 + indent + (treeMeta.isLeaf ? 0 : 18);
            if (!treeMeta.isLeaf) {
              ctx.fillStyle = theme.mutedText;
              ctx.fillText(
                treeMeta.expanded ? '\u25BC' : '\u25B6',
                x + 8 + indent,
                y + h / 2 + 1,
              );
            }
            ctx.fillStyle = fg;
          } else {
            ctx.fillStyle = fg;
          }
          ctx.save();
          ctx.beginPath();
          ctx.rect(x + textPad - 4, y, w - (textPad - 4) - 8, h);
          ctx.clip();
          ctx.fillText(text, x + textPad, y + h / 2 + 1);
          ctx.restore();

          ctx.strokeStyle = theme.border;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(x + w - 0.5, y);
          ctx.lineTo(x + w - 0.5, y + h);
          ctx.stroke();
          drawn++;
        }
        x += w;
      }

      ctx.strokeStyle = theme.border;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, y + h - 0.5);
      ctx.lineTo(this.viewportWidth, y + h - 0.5);
      ctx.stroke();

      y += h;
    }

    return drawn;
  }

  /** Paint a group-row band: full-width accent, indent + chevron + label
   *  + count, then aggregate values laid out at the natural column
   *  positions (so they line up with their data columns). */
  private drawGroupRow(
    meta: import('./types').RowGroupMeta,
    y: number,
    h: number,
    horizontalOffset: number,
  ): void {
    const ctx = this.ctx;
    const theme = this.theme;
    const indent = meta.depth * 16 + 8;
    const chevronX = indent;

    ctx.fillStyle = '#1b1f26';
    ctx.fillRect(0, y, this.viewportWidth, h);
    ctx.strokeStyle = theme.border;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, y + h - 0.5);
    ctx.lineTo(this.viewportWidth, y + h - 0.5);
    ctx.stroke();

    // Chevron + label live in the leftmost band, anchored at the
    // viewport's left edge regardless of horizontal scroll.
    ctx.fillStyle = theme.mutedText;
    ctx.font = `${String(theme.fontSize)}px ${theme.fontFamily}`;
    ctx.textBaseline = 'middle';
    ctx.fillText(meta.expanded ? '\u25BC' : '\u25B6', chevronX, y + h / 2 + 1);

    const labelX = chevronX + 14;
    ctx.fillStyle = theme.text;
    ctx.font = `600 ${String(theme.fontSize)}px ${theme.fontFamily}`;
    const label =
      meta.count !== undefined ? `${meta.label}  (${String(meta.count)})` : meta.label;
    ctx.fillText(label, labelX, y + h / 2 + 1);

    // Per-column aggregate values use the column's own format() so dollar
    // amounts, percentages etc. render consistently with data rows.
    if (meta.aggregates) {
      ctx.font = `${String(theme.fontSize)}px ${theme.fontFamily}`;
      ctx.fillStyle = theme.mutedText;
      let x = -horizontalOffset;
      for (let i = 0; i < this.columns.length; i++) {
        const column = this.columns[i];
        if (!column) continue;
        const w = column.width;
        const isFrozen = i < this.frozenColumnCount;
        const cellX = isFrozen
          ? (this.cumulativeColumnWidths[i] ?? 0)
          : x +
            this.frozenWidth +
            ((this.cumulativeColumnWidths[i] ?? 0) -
              (this.cumulativeColumnWidths[this.frozenColumnCount] ?? 0));
        if (cellX + w < 0 || cellX > this.viewportWidth) {
          x = isFrozen ? x : x;
          continue;
        }
        const agg = meta.aggregates[column.id];
        if (agg !== undefined && agg !== null && agg !== '') {
          // Skip painting in the leftmost label band so we don't overlap
          // the chevron/label.
          const labelEnd = labelX + ctx.measureText(label).width + 12;
          if (cellX < labelEnd) continue;
          const text = column.format ? column.format(agg, -1) : String(agg);
          ctx.save();
          ctx.beginPath();
          ctx.rect(cellX + 8, y, w - 16, h);
          ctx.clip();
          ctx.fillText(text, cellX + 12, y + h / 2 + 1);
          ctx.restore();
        }
      }
    }
  }

  /** Render the topmost ancestor group row pinned to the top of the
   *  data band whenever the user has scrolled past it. Walks
   *  backwards from the topmost-visible row to find the most recent
   *  group, then re-renders that row at y=dataTop on top of the
   *  scrolling content (already drawn) so the user sees their
   *  current group context at all times.
   *
   *  Single-level only — for tree views with depth > 1 this stacks
   *  exactly one ancestor (the immediate group). Multi-level sticky
   *  is a v0.0.8 follow-up. */
  /**
   * Paint mid-table pinned data rows (wave 26). Finds the highest-priority
   * pinned row in each direction (top, bottom) whose natural Y has
   * scrolled off-band, and re-paints it at the sticky position. Uses the
   * existing drawRows pipeline so styling, column-band logic, and column
   * pinning all "just work."
   */
  private drawPinnedDataRows(_visibleStart: number, _visibleEnd: number): void {
    if (!this.getRowMeta) return;
    const numRows = this.rowSource.numRows;
    if (numRows === 0) return;
    const dataTop = this.dataBandTop();
    const dataBottom = this.dataBandBottom();
    const dataHeight = Math.max(0, dataBottom - dataTop);

    // Walk every row checking for pinned-data meta. We assume adopters
    // mark only a handful of rows pinned; the walk is bounded by a hard
    // cap so a buggy resolver can't lock the UI.
    const HARD_CAP = 50_000;
    const scanLimit = Math.min(numRows, HARD_CAP);
    let pinnedTopRow = -1;
    let pinnedBottomRow = -1;
    for (let r = 0; r < scanLimit; r++) {
      const m = this.getRowMeta(r);
      if (!m || m.kind !== 'data') continue;
      if (m.pinned === 'top' && pinnedTopRow < 0) pinnedTopRow = r;
      else if (m.pinned === 'bottom' && pinnedBottomRow < 0) pinnedBottomRow = r;
      if (pinnedTopRow >= 0 && pinnedBottomRow >= 0) break;
    }

    const ctx = this.ctx;

    const paintRowAt = (row: number, stickY: number): void => {
      const h = this.fenwick.get(row);
      const fakeFirstRowTop = this.scrollTop + (stickY - dataTop);
      ctx.save();
      ctx.beginPath();
      ctx.rect(this.frozenWidth, stickY, this.viewportWidth - this.frozenWidth, h);
      ctx.clip();
      this.drawRows(
        row,
        row,
        fakeFirstRowTop,
        this.frozenColumnCount,
        this.columns.length,
        -this.scrollLeft,
      );
      ctx.restore();
      // Frozen band
      if (this.frozenColumnCount > 0) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, stickY, this.frozenWidth, h);
        ctx.clip();
        this.drawRows(row, row, fakeFirstRowTop, 0, this.frozenColumnCount, 0);
        ctx.restore();
      }
    };

    // Pinned-top: only show when its natural position has scrolled off.
    if (pinnedTopRow >= 0) {
      const naturalTop = this.fenwick.prefixSum(pinnedTopRow);
      if (naturalTop < this.scrollTop) {
        paintRowAt(pinnedTopRow, dataTop);
      }
    }
    // Pinned-bottom: show when its natural position is below the
    // viewport bottom.
    if (pinnedBottomRow >= 0) {
      const naturalTop = this.fenwick.prefixSum(pinnedBottomRow);
      const h = this.fenwick.get(pinnedBottomRow);
      const viewportBottomInData = this.scrollTop + dataHeight;
      if (naturalTop > viewportBottomInData - h) {
        paintRowAt(pinnedBottomRow, dataBottom - h);
      }
    }
  }

  private drawStickyGroupRow(_visibleStart: number): void {
    if (!this.stickyGroupRowsEnabled || !this.getRowMeta) return;
    if (this.rowSource.numRows === 0) return;
    // Use the un-overscanned topmost-visible row index — overscan
    // can include rows above the actual viewport edge and would
    // hide the sticky case (when the parent group is in the
    // overscan band but scrolled above the data top).
    const topmost = this.fenwick.indexAtOffset(this.scrollTop);
    if (topmost < 0 || topmost >= this.rowSource.numRows) return;
    // Walk backwards (or use topmost itself) looking for the nearest
    // ancestor group row that has scrolled above the data band's top.
    let parentRow = -1;
    let parentMeta: import('./types').RowGroupMeta | null = null;
    const startScan = topmost;
    for (let r = startScan; r >= 0; r--) {
      const m = this.getRowMeta(r);
      if (m && m.kind === 'group') {
        const y = this.fenwick.prefixSum(r);
        const h = this.fenwick.get(r);
        if (y + h <= this.scrollTop) {
          parentRow = r;
          parentMeta = m;
          break;
        }
        // Group row is still partially or fully visible at its own
        // position — no sticky needed for this scroll position.
        return;
      }
    }
    if (!parentMeta || parentRow < 0) return;
    const parentH = this.fenwick.get(parentRow);
    const dataTop = this.dataBandTop();
    const ctx = this.ctx;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, dataTop, this.viewportWidth, parentH);
    ctx.clip();
    this.drawGroupRow(parentMeta, dataTop, parentH, this.scrollLeft);
    ctx.restore();
  }

  private drawHeader(): void {
    const ctx = this.ctx;
    const theme = this.theme;
    const groupBarH = this.groupBarHeight();
    const groupH = this.columnGroupBandHeight();
    // Column-header labels sit below the group bar (v1.3) AND the
    // column-group band. The group bar is a DOM overlay, so the canvas
    // only reserves its strip and paints nothing in it.
    const headerTop = groupBarH + groupH;
    const fullHeader = this.fullHeaderHeight();

    // Background spans the header chrome BELOW the group bar (the DOM bar
    // covers its own strip). Starting at groupBarH keeps the canvas from
    // double-painting under the bar.
    ctx.fillStyle = theme.headerBackground;
    ctx.fillRect(0, groupBarH, this.viewportWidth, fullHeader - groupBarH);

    ctx.font = `600 ${String(theme.fontSize - 1)}px ${theme.fontFamily}`;
    ctx.textBaseline = 'middle';

    const drawCell = (column: ColumnDef, x: number): void => {
      const sortIndex = this.sort.findIndex((s) => s.columnId === column.id);
      const sortField = sortIndex >= 0 ? this.sort[sortIndex] : undefined;
      const arrow = sortField
        ? sortField.direction === 'asc'
          ? ' \u25B2'
          : ' \u25BC'
        : '';
      const label = (column.displayName ?? column.id) + arrow;
      ctx.save();
      ctx.beginPath();
      ctx.rect(x + 8, headerTop, column.width - 16, this.headerHeight);
      ctx.clip();
      ctx.fillStyle = theme.text;
      ctx.fillText(label, x + 12, headerTop + this.headerHeight / 2 + 1);
      ctx.restore();
      if (sortField && this.sort.length > 1) {
        ctx.font = `500 ${String(theme.fontSize - 3)}px ${theme.fontFamily}`;
        ctx.fillStyle = theme.mutedText;
        ctx.fillText(
          String(sortIndex + 1),
          x + column.width - 14,
          headerTop + this.headerHeight / 2 + 1,
        );
        ctx.font = `600 ${String(theme.fontSize - 1)}px ${theme.fontFamily}`;
      }
    };

    // v0.0.10 column virtualization — narrow header iteration to the
    // visible non-frozen columns. The cumulativeColumnWidths offset is
    // equivalent to passing horizontalOffset = scrollLeft into
    // visibleColumnRangeInBand once the leading frozen-band gap is
    // subtracted.
    const headerColRange = this.visibleColumnRangeInBand(
      this.frozenColumnCount,
      this.columns.length,
      this.scrollLeft,
    );
    let x = headerColRange.xStart;
    for (let col = headerColRange.first; col <= headerColRange.last; col++) {
      const column = this.columns[col];
      if (!column) continue;
      ctx.fillStyle = theme.text;
      drawCell(column, x);
      x += column.width;
    }

    if (this.frozenColumnCount > 0) {
      let fx = 0;
      for (let col = 0; col < this.frozenColumnCount; col++) {
        const column = this.columns[col];
        if (!column) continue;
        ctx.fillStyle = theme.headerBackground;
        ctx.fillRect(fx, groupBarH, column.width, fullHeader - groupBarH);
        ctx.fillStyle = theme.text;
        drawCell(column, fx);
        fx += column.width;
      }
    }

    if (this.columnGroups && this.columnGroups.length > 0) {
      this.drawColumnGroupBand();
    }

    ctx.strokeStyle = '#2a2f37';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, fullHeader - 0.5);
    ctx.lineTo(this.viewportWidth, fullHeader - 0.5);
    ctx.stroke();
  }

  /** Draw a single label band above the column headers, with each group
   *  spanning its child columns' combined width. Cells outside any group
   *  show as background. Frozen columns are drawn last so they sit on
   *  top of scrolling group spans. */
  private drawColumnGroupBand(): void {
    if (!this.columnGroups) return;
    const ctx = this.ctx;
    const theme = this.theme;
    const groupH = this.columnGroupBandHeight();
    if (groupH === 0) return;

    // The band's local coordinate space starts at y=0; shift it down by
    // the group bar (v1.3) so the whole band sits below the pill bar
    // without rewriting every y-coordinate below.
    const groupBarH = this.groupBarHeight();
    ctx.save();
    if (groupBarH !== 0) ctx.translate(0, groupBarH);

    const colIndex = new Map<string, number>();
    for (let i = 0; i < this.columns.length; i++) {
      const col = this.columns[i];
      if (col) colIndex.set(col.id, i);
    }

    ctx.font = `600 ${String(theme.fontSize - 2)}px ${theme.fontFamily}`;
    ctx.textBaseline = 'middle';

    const paintGroup = (
      group: { label: string; columnIds: ReadonlyArray<string>; background?: string },
      visibleStart: number,
      visibleEnd: number,
      isFrozenContext: boolean,
    ): void => {
      let groupStart = Infinity;
      let groupEnd = -Infinity;
      for (const id of group.columnIds) {
        const idx = colIndex.get(id);
        if (idx === undefined) continue;
        if (idx < groupStart) groupStart = idx;
        if (idx > groupEnd) groupEnd = idx;
      }
      if (groupStart === Infinity) return;
      if (groupEnd < visibleStart || groupStart > visibleEnd) return;

      const xStart = this.cumulativeColumnWidths[groupStart] ?? 0;
      const xEnd = this.cumulativeColumnWidths[groupEnd + 1] ?? xStart;
      const isFrozenGroup = groupEnd < this.frozenColumnCount;
      if (isFrozenContext !== isFrozenGroup) return;

      let x: number;
      let w: number;
      if (isFrozenGroup) {
        x = xStart;
        w = xEnd - xStart;
      } else {
        const frozenEnd = this.cumulativeColumnWidths[this.frozenColumnCount] ?? 0;
        x = this.frozenWidth + (xStart - frozenEnd) - this.scrollLeft;
        w = xEnd - xStart;
      }

      ctx.fillStyle = group.background ?? '#161a20';
      ctx.fillRect(x, 0, w, groupH);
      ctx.strokeStyle = '#2a2f37';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x + w - 0.5, 0);
      ctx.lineTo(x + w - 0.5, groupH);
      ctx.stroke();

      ctx.save();
      ctx.beginPath();
      ctx.rect(x + 6, 0, Math.max(0, w - 12), groupH);
      ctx.clip();
      ctx.fillStyle = theme.text;
      ctx.fillText(group.label, x + 10, groupH / 2 + 1);
      ctx.restore();
    };

    // Two passes: scrolling groups first, then frozen on top.
    ctx.save();
    ctx.beginPath();
    ctx.rect(this.frozenWidth, 0, this.viewportWidth - this.frozenWidth, groupH);
    ctx.clip();
    for (const g of this.columnGroups) {
      paintGroup(g, this.frozenColumnCount, this.columns.length - 1, false);
    }
    ctx.restore();

    if (this.frozenColumnCount > 0) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, this.frozenWidth, groupH);
      ctx.clip();
      for (const g of this.columnGroups) {
        paintGroup(g, 0, this.frozenColumnCount - 1, true);
      }
      ctx.restore();
    }

    ctx.strokeStyle = '#2a2f37';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, groupH - 0.5);
    ctx.lineTo(this.viewportWidth, groupH - 0.5);
    ctx.stroke();

    ctx.restore(); // undo the group-bar translate
  }

  /** Draw a fixed-height band of pinned rows starting at `bandTop`. Cells
   *  read from the supplied RowSource (separate from the main one) so
   *  callers can pass synthetic aggregation rows without touching their
   *  primary dataset. Returns cell count for metrics. */
  private drawPinnedBand(source: RowSource | undefined, bandTop: number): number {
    if (!source || source.numRows === 0) return 0;
    const ctx = this.ctx;
    const theme = this.theme;
    const rowH = this.pinnedRowHeight;
    const bandHeight = source.numRows * rowH;
    let drawn = 0;

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, bandTop, this.viewportWidth, bandHeight);
    ctx.clip();

    ctx.fillStyle = theme.headerBackground;
    ctx.fillRect(0, bandTop, this.viewportWidth, bandHeight);
    ctx.font = `${String(theme.fontSize)}px ${theme.fontFamily}`;
    ctx.textBaseline = 'middle';

    const paintRow = (
      row: number,
      colStart: number,
      colEnd: number,
      horizontalOffset: number,
    ): void => {
      const y = bandTop + row * rowH;
      let x = -horizontalOffset;
      if (colStart > 0) x += this.cumulativeColumnWidths[colStart] ?? 0;
      for (let col = colStart; col < colEnd; col++) {
        const column = this.columns[col];
        if (!column) continue;
        const w = column.width;
        if (x + w >= 0 && x <= this.viewportWidth) {
          const value = source.getCell(row, column.id);
          const text = column.format ? column.format(value, row) : String(value ?? '');
          const fg = column.color?.(value, row) ?? theme.text;
          const bg = column.background?.(value, row);
          if (bg) {
            ctx.fillStyle = bg;
            ctx.fillRect(x, y, w, rowH);
          }
          ctx.fillStyle = fg;
          ctx.save();
          ctx.beginPath();
          ctx.rect(x + 8, y, w - 16, rowH);
          ctx.clip();
          ctx.fillText(text, x + 12, y + rowH / 2 + 1);
          ctx.restore();
          drawn++;
        }
        x += w;
      }
    };

    // Scrolling band — pinned rows × non-frozen columns.
    ctx.save();
    ctx.beginPath();
    ctx.rect(this.frozenWidth, bandTop, this.viewportWidth - this.frozenWidth, bandHeight);
    ctx.clip();
    for (let r = 0; r < source.numRows; r++) {
      paintRow(r, this.frozenColumnCount, this.columns.length, this.scrollLeft);
    }
    ctx.restore();

    // Frozen columns within the pinned band.
    if (this.frozenColumnCount > 0) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, bandTop, this.frozenWidth, bandHeight);
      ctx.clip();
      for (let r = 0; r < source.numRows; r++) {
        paintRow(r, 0, this.frozenColumnCount, 0);
      }
      ctx.restore();
    }

    // Top + bottom dividers.
    ctx.strokeStyle = '#2a2f37';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, bandTop - 0.5);
    ctx.lineTo(this.viewportWidth, bandTop - 0.5);
    ctx.moveTo(0, bandTop + bandHeight - 0.5);
    ctx.lineTo(this.viewportWidth, bandTop + bandHeight - 0.5);
    ctx.stroke();

    ctx.restore();
    return drawn;
  }

  /** Recompute selection-aggregation summary text and write into the
   *  status bar div. Cheap: one pass over the active selection's
   *  bounding rectangle. */
  private updateStatusBar(): void {
    if (!this.statusBarEl) return;
    const ranges = this.selection.normalizedRanges();
    if (ranges.length === 0) {
      this.statusBarEl.textContent = 'no selection';
      return;
    }

    let cellCount = 0;
    let numericCount = 0;
    let sum = 0;
    let min = Infinity;
    let max = -Infinity;

    for (const r of ranges) {
      const rowFrom = Math.max(0, r.rowStart);
      const rowTo = Math.min(this.rowSource.numRows - 1, r.rowEnd);
      const colFrom = Math.max(0, r.colStart);
      const colTo = Math.min(this.columns.length - 1, r.colEnd);
      for (let row = rowFrom; row <= rowTo; row++) {
        for (let col = colFrom; col <= colTo; col++) {
          const column = this.columns[col];
          if (!column) continue;
          cellCount++;
          const value = this.rowSource.getCell(row, column.id);
          const n = typeof value === 'number' ? value : Number(value);
          if (Number.isFinite(n)) {
            numericCount++;
            sum += n;
            if (n < min) min = n;
            if (n > max) max = n;
          }
        }
      }
    }

    const parts: string[] = [`count ${String(cellCount)}`];
    if (numericCount > 0) {
      const avg = sum / numericCount;
      parts.push(
        `sum ${formatStatusNum(sum)}`,
        `avg ${formatStatusNum(avg)}`,
        `min ${formatStatusNum(min)}`,
        `max ${formatStatusNum(max)}`,
      );
    }
    this.statusBarEl.textContent = parts.join('  ·  ');
  }

  /**
   * Static fallback used at sites that haven't migrated to the
   * direction-aware shape yet. Returns the larger of (ahead, behind)
   * so any pre-v0.0.10 caller stays conservative.
   */
  private velocityAwareOverscan(): number {
    const { ahead, behind } = this.adaptiveOverscan();
    return Math.max(ahead, behind);
  }

  /**
   * Adaptive overscan (v0.0.10 item 2). Splits the row-prefetch
   * window across travel direction:
   *   - `ahead`  rows to render in the direction of travel
   *   - `behind` rows to render against the direction of travel
   * Driven by `velocitySmoothed` (EMA) so a single noisy frame can't
   * snap the window. Stationary returns a balanced minimum; flinging
   * skews aggressively forward.
   */
  private adaptiveOverscan(): { ahead: number; behind: number } {
    const v = this.velocitySmoothed;
    let ahead: number;
    let behind: number;
    if (v > 200) {
      ahead = 16;
      behind = 4;
    } else if (v > 50) {
      ahead = 8;
      behind = 3;
    } else if (v > 5) {
      ahead = 4;
      behind = 2;
    } else {
      ahead = 2;
      behind = 2;
    }
    // Direction flip — swap ahead/behind so the bigger window faces
    // travel regardless of sign.
    if (this.scrollDirection < 0) {
      const t = ahead;
      ahead = behind;
      behind = t;
    }
    return { ahead, behind };
  }

  /**
   * Mount / position / unmount custom-renderer DOM nodes for the visible
   * window. Cells with `ColumnDef.renderer` set are NOT painted to the
   * canvas — the canvas just paints the cell background — and the
   * rendered DOM element from the pool fills in on top. Instances that
   * scrolled out of view return to the pool with reset() called.
   */
  private syncCellOverlay(start: number, end: number): void {
    if (!this.rendererPool || !this.cellOverlayEl) return;
    const claimed: Map<string, Set<HTMLElement>> = new Map();
    const nextActive = new Map<string, HTMLElement>();

    for (let row = start; row <= end; row++) {
      // Skip cell renderers on synthetic group rows — those rows are
      // a horizontal banner (chevron + label + aggregates), not a
      // table-row with per-column data. Mounting an interactive
      // renderer (e.g. a checkbox) on a group row would intercept
      // the chevron-click pointer path. Tree rows DO have per-column
      // data so they continue to render normally.
      const meta = this.getRowMeta?.(row);
      if (meta && meta.kind === 'group') continue;
      for (let col = 0; col < this.columns.length; col++) {
        const column = this.columns[col];
        if (!column?.renderer) continue;
        const rect = this.cellViewportRect(row, col);
        if (!rect) continue;

        const renderer = column.renderer;
        const key = `${renderer.id}:${String(row)}:${String(col)}`;
        const value = this.rowSource.getCell(row, column.id);
        const ctx = { value, rowIndex: row, columnId: column.id };

        // Reuse the existing element for this cell coordinate if we had
        // one last frame; otherwise acquire a new instance from the pool.
        let el = this.activeRendererCells.get(key);
        if (!el) {
          const inst = this.rendererPool.acquire(renderer, ctx);
          el = inst.el;
          inst.lastCol = col;
        }
        el.style.position = 'absolute';
        el.style.left = `${String(rect.left)}px`;
        el.style.top = `${String(rect.top)}px`;
        el.style.width = `${String(rect.width)}px`;
        el.style.height = `${String(rect.height)}px`;
        el.style.display = 'block';
        el.style.pointerEvents = 'auto';
        renderer.update(el, ctx);

        nextActive.set(key, el);
        let claimSet = claimed.get(renderer.id);
        if (!claimSet) {
          claimSet = new Set();
          claimed.set(renderer.id, claimSet);
        }
        claimSet.add(el);
      }
    }

    // Release everything that wasn't claimed this frame back to the
    // pool. The pool calls reset() on each going-out instance.
    const allRendererIds = new Set<string>();
    for (const c of this.columns) if (c.renderer) allRendererIds.add(c.renderer.id);
    for (const id of allRendererIds) {
      const renderer = this.columns.find((c) => c.renderer?.id === id)?.renderer;
      this.rendererPool.releaseUnclaimed(
        id,
        claimed.get(id) ?? new Set(),
        renderer?.reset,
      );
    }
    this.activeRendererCells = nextActive;
  }

  // ---------------------------------------------------------------------------
  // Accessibility shadow
  // ---------------------------------------------------------------------------

  private updateAccessibilityShadow(start: number, end: number): void {
    // Cap shadow size for performance, but always include the active
    // row so `aria-activedescendant` resolves to a live <td>.
    let firstRow = start;
    let lastRow = Math.min(end, start + 80);
    const active = this.selection.active;
    if (active && (active.row < firstRow || active.row > lastRow)) {
      // Re-anchor to a window centered on the active row.
      firstRow = Math.max(0, active.row - 40);
      lastRow = Math.min(this.rowSource.numRows - 1, active.row + 40);
    }

    const rows: string[] = [];
    rows.push('<table role="grid"><thead><tr role="row">');
    for (const col of this.columns) {
      rows.push(`<th role="columnheader">${escapeHtml(col.displayName ?? col.id)}</th>`);
    }
    rows.push('</tr></thead><tbody>');
    for (let r = firstRow; r <= lastRow; r++) {
      rows.push(`<tr role="row" aria-rowindex="${String(r + 2)}">`);
      for (let c = 0; c < this.columns.length; c++) {
        const col = this.columns[c];
        if (!col) continue;
        const value = this.rowSource.getCell(r, col.id);
        const text = col.format ? col.format(value, r) : String(value ?? '');
        const id = ariaCellId(this.gridId, r, c);
        const isActive = active && active.row === r && active.col === c;
        rows.push(
          `<td id="${id}" role="gridcell" aria-colindex="${String(c + 1)}" tabindex="-1"${
            isActive ? ' aria-selected="true"' : ''
          }>${escapeHtml(text)}</td>`,
        );
      }
      rows.push('</tr>');
    }
    rows.push('</tbody></table>');
    this.a11yMount.innerHTML = rows.join('');
  }
}

const EMPTY_SNAPSHOT: MetricsSnapshot = {
  windowMs: 0,
  frameCount: 0,
  fpsAvg: 0,
  intervalMsP50: 0,
  intervalMsP95: 0,
  intervalMsP99: 0,
  drawMsP50: 0,
  drawMsP95: 0,
  drawMsP99: 0,
  longFramesGt16: 0,
  longFramesGt33: 0,
  longFramesGt50: 0,
  scrollPxTotal: 0,
  cellsPerFrameAvg: 0,
};

function colAtX(
  cumulative: Float32Array,
  x: number,
  start: number,
  endExclusive: number,
): number {
  for (let c = start; c < endExclusive; c++) {
    if ((cumulative[c + 1] ?? 0) > x) return c;
  }
  return endExclusive - 1;
}

function percentile(sorted: ReadonlyArray<number>, p: number): number {
  if (sorted.length === 0) return 0;
  const arr = [...sorted].sort((a, b) => a - b);
  const idx = Math.min(arr.length - 1, Math.max(0, Math.floor(p * (arr.length - 1))));
  return Math.round((arr[idx] ?? 0) * 100) / 100;
}

function formatStatusNum(n: number): string {
  if (!Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(2);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      case "'":
        return '&#39;';
      default:
        return ch;
    }
  });
}

/**
 * Parse Excel-style TSV (tab-separated values, with double-quote
 * wrapping and `""` escaping) into a 2D array of strings. Trailing
 * empty rows are dropped so a clipboard payload that ends with a
 * newline doesn't produce a phantom row.
 */
function parseTsv(input: string): string[][] {
  const rows: string[][] = [];
  let cur: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"' && field === '') {
      inQuotes = true;
      continue;
    }
    if (ch === '\t') {
      cur.push(field);
      field = '';
      continue;
    }
    if (ch === '\r') continue;
    if (ch === '\n') {
      cur.push(field);
      rows.push(cur);
      cur = [];
      field = '';
      continue;
    }
    field += ch;
  }
  if (field !== '' || cur.length > 0) {
    cur.push(field);
    rows.push(cur);
  }
  while (rows.length > 0 && rows[rows.length - 1]!.length === 1 && rows[rows.length - 1]![0] === '') {
    rows.pop();
  }
  return rows;
}
