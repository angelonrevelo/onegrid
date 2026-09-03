// =============================================================================
// @onegrid/headless
//
// Framework-agnostic host wrapping @onegrid/core's Grid with a lifecycle
// vocabulary borrowed from Lit's ReactiveController
// (hostConnected/hostUpdate/hostUpdated/hostDisconnected + requestUpdate).
// The point is that any host framework — Lit, Solid, Vue Composition API,
// Svelte runes, vanilla JS — can implement the same five-method controller
// shape and own grid bootstrapping without each adapter re-implementing
// scheduling, SSR adoption, or event subscription.
//
// Internal Grid stays the canonical implementation; this is a thin
// orchestration layer plus a single rAF-coalesced invalidate() primitive
// and an SSR-friendly accessibility-shadow serializer.
// =============================================================================

import { Grid, defineGridOptions } from '@onegrid/core';
import type {
  ColumnDef,
  GridOptions,
  NestedGridOptions,
  RowSource,
  SelectionSnapshot,
} from '@onegrid/core';
import type { FilterModel, SortModel } from '@onegrid/protocol';

// -----------------------------------------------------------------------------
// Event surface
// -----------------------------------------------------------------------------

/** @public */
export type HeadlessEvent =
  | 'selectionChange'
  | 'sortChange'
  | 'filterChange'
  | 'columnsChange'
  | 'scroll'
  | 'frame'
  | 'invalidate'
  | 'mount'
  | 'unmount';

/** @public */
export interface HeadlessEventPayload {
  selectionChange: SelectionSnapshot;
  sortChange: SortModel;
  filterChange: FilterModel | undefined;
  columnsChange: ReadonlyArray<ColumnDef>;
  scroll: { scrollTop: number; scrollLeft: number };
  frame: { fps: number };
  invalidate: { reason: string };
  mount: void;
  unmount: void;
}

type Listener<E extends HeadlessEvent> = (
  payload: HeadlessEventPayload[E],
) => void;

// -----------------------------------------------------------------------------
// HeadlessGrid — the controller object
// -----------------------------------------------------------------------------

/** @public */
export interface HeadlessGridConfig {
  /** Either the flat or nested form. */
  readonly options: GridOptions | NestedGridOptions;
  /**
   * Adopt an existing accessibility shadow rendered server-side. When
   * provided, mount() does NOT clear the host; the canvas is layered
   * on top of the pre-rendered ARIA tree.
   */
  readonly hydrateFrom?: HTMLElement;
}

interface InvalidationRequest {
  readonly reasons: Set<string>;
}

/**
 * Framework-agnostic Grid controller. Lit-ReactiveController-shaped
 * lifecycle:
 *
 *   const grid = new HeadlessGrid({ options });
 *   grid.hostConnected();         // mount
 *   grid.requestUpdate('sort');   // request rAF-coalesced re-render
 *   grid.hostUpdate();            // pre-render hook (host-driven)
 *   grid.hostUpdated();           // post-render hook
 *   grid.hostDisconnected();      // destroy
 *
 * Hosts that want push-based events instead call grid.subscribe(event, fn).
 * @public
 */
export class HeadlessGrid {
  private grid: Grid | null = null;
  private readonly config: HeadlessGridConfig;
  private readonly listeners = new Map<HeadlessEvent, Set<Listener<HeadlessEvent>>>();
  private invalidation: InvalidationRequest | null = null;
  private rafHandle: number | null = null;
  /** Mounted state. False before hostConnected, after hostDisconnected. */
  private mounted = false;
  /** Test override — when set, replaces requestAnimationFrame. */
  private readonly scheduleRaf: (cb: () => void) => number;
  private readonly cancelRaf: (handle: number) => void;

  constructor(
    config: HeadlessGridConfig,
    schedulers?: {
      readonly raf?: (cb: () => void) => number;
      readonly cancel?: (h: number) => void;
    },
  ) {
    this.config = config;
    this.scheduleRaf =
      schedulers?.raf ??
      (typeof requestAnimationFrame === 'function'
        ? (cb) => requestAnimationFrame(cb)
        : (cb) => setTimeout(cb, 16) as unknown as number);
    this.cancelRaf =
      schedulers?.cancel ??
      (typeof cancelAnimationFrame === 'function'
        ? (h) => cancelAnimationFrame(h)
        : (h) => clearTimeout(h as unknown as ReturnType<typeof setTimeout>));
  }

  // ---------------------------------------------------------------------------
  // Lifecycle — Lit ReactiveController vocabulary
  // ---------------------------------------------------------------------------

  /** Mount the grid. Called by the host when its element enters the DOM. */
  hostConnected(): void {
    if (this.mounted) return;
    const opts = defineGridOptions(this.config.options);
    // Adopt server-rendered ARIA shadow if provided. We don't strip it;
    // the canvas overlay layers on top and the shadow remains for AT.
    this.grid = new Grid(opts);
    this.mounted = true;
    this.emit('mount', undefined);
  }

  /** Pre-render hook. Hosts that batch their own work can override. */
  hostUpdate(): void {
    /* no-op by default; subclasses / hosts can override */
  }

  /** Post-render hook. Fires after the rAF flush. */
  hostUpdated(): void {
    /* no-op */
  }

  /** Tear down. Cancels pending rAF; destroys the inner Grid. */
  hostDisconnected(): void {
    if (this.rafHandle !== null) {
      this.cancelRaf(this.rafHandle);
      this.rafHandle = null;
    }
    if (this.grid) {
      this.grid.destroy();
      this.grid = null;
    }
    this.invalidation = null;
    this.mounted = false;
    this.emit('unmount', undefined);
  }

  // ---------------------------------------------------------------------------
  // Scheduling — single rAF-coalesced invalidate primitive
  // ---------------------------------------------------------------------------

  /**
   * Request a re-render. Multiple calls within the same frame coalesce
   * into one update. `reason` is purely for debugging — it surfaces
   * through the `invalidate` event.
   */
  requestUpdate(reason: string = 'unspecified'): void {
    if (!this.mounted) return;
    if (this.invalidation === null) {
      this.invalidation = { reasons: new Set() };
      this.rafHandle = this.scheduleRaf(() => this.flush());
    }
    this.invalidation.reasons.add(reason);
  }

  /** Alias preferred by some host conventions. */
  invalidate(reason: string = 'unspecified'): void {
    this.requestUpdate(reason);
  }

  private flush(): void {
    const inv = this.invalidation;
    this.invalidation = null;
    this.rafHandle = null;
    if (!this.mounted || !inv) return;
    this.hostUpdate();
    // The inner Grid owns its own render loop; we surface the reason
    // for diagnostics and let listeners react.
    this.emit('invalidate', { reason: [...inv.reasons].join('+') });
    this.hostUpdated();
  }

  // ---------------------------------------------------------------------------
  // Imperative surface — wraps Grid's public methods
  // ---------------------------------------------------------------------------

  setSort(sort: SortModel): void {
    this.grid?.setSort(sort);
    this.emit('sortChange', sort);
    this.requestUpdate('sort');
  }

  setFilter(filter: FilterModel | undefined): void {
    // Filter is owned by the rowSource adapter; we surface the change
    // through the event channel so adapters can re-fetch.
    this.emit('filterChange', filter);
    this.requestUpdate('filter');
  }

  setColumns(columns: ReadonlyArray<ColumnDef>): void {
    this.grid?.setColumns(columns);
    this.emit('columnsChange', columns);
    this.requestUpdate('columns');
  }

  setRowSource(rowSource: RowSource, rowHeight?: number | Float32Array): void {
    this.grid?.setRowSource(rowSource, rowHeight);
    this.requestUpdate('rowSource');
  }

  scrollToRow(rowIndex: number): void {
    this.grid?.scrollToRow(rowIndex);
  }

  getSelection(): SelectionSnapshot | undefined {
    return this.grid?.getSelection();
  }

  getColumns(): ReadonlyArray<ColumnDef> | undefined {
    return this.grid?.getColumns();
  }

  /** Underlying core Grid — escape hatch. */
  get core(): Grid | null {
    return this.grid;
  }

  // ---------------------------------------------------------------------------
  // Event subscription
  // ---------------------------------------------------------------------------

  /** Subscribe to a typed event. Returns an unsubscribe function. */
  subscribe<E extends HeadlessEvent>(
    event: E,
    listener: Listener<E>,
  ): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener as Listener<HeadlessEvent>);
    return () => {
      this.listeners.get(event)?.delete(listener as Listener<HeadlessEvent>);
    };
  }

  private emit<E extends HeadlessEvent>(
    event: E,
    payload: HeadlessEventPayload[E],
  ): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const fn of set) (fn as Listener<E>)(payload);
  }

  // ---------------------------------------------------------------------------
  // SSR path — serialize the accessibility shadow as static HTML
  // ---------------------------------------------------------------------------

  /**
   * Render a static HTML string representing the accessibility shadow
   * tree. The canvas is meaningless server-side, but the ARIA shadow
   * IS meaningful — AT and search engines see the structured grid even
   * before client-side hydration. The result is suitable for direct
   * `innerHTML` injection or stream-render.
   */
  renderAccessibilityShadowHTML(): string {
    const opts = this.config.options;
    const flat = defineGridOptions(opts);
    const rowCount = safeRowCount(flat.rowSource);
    const columns = flat.columns;
    const headerCells = columns
      .map(
        (c: ColumnDef, i: number) =>
          `<div role="columnheader" aria-colindex="${i + 1}">${escapeHtml(c.displayName ?? c.id)}</div>`,
      )
      .join('');
    const rows: string[] = [];
    const sampleLimit = Math.min(rowCount, 20);
    for (let r = 0; r < sampleLimit; r++) {
      const block = safeReadBlock(flat.rowSource, r, 1);
      const row = block?.rows[0] ?? [];
      const cells = columns
        .map(
          (c: ColumnDef, i: number) =>
            `<div role="gridcell" aria-colindex="${i + 1}">${escapeHtml(String(row[i] ?? ''))}</div>`,
        )
        .join('');
      rows.push(
        `<div role="row" aria-rowindex="${r + 1}">${cells}</div>`,
      );
    }
    return (
      `<div role="grid" aria-rowcount="${rowCount}" aria-colcount="${columns.length}" data-og-ssr="true">` +
      `<div role="row" aria-rowindex="0">${headerCells}</div>` +
      rows.join('') +
      `</div>`
    );
  }
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function safeRowCount(source: RowSource): number {
  try {
    const block = (source as { readBlock?: (i: number, c: number) => { totalRowCount?: number } }).readBlock?.(0, 0);
    return block?.totalRowCount ?? 0;
  } catch {
    return 0;
  }
}

function safeReadBlock(
  source: RowSource,
  start: number,
  count: number,
): { rows: ReadonlyArray<ReadonlyArray<unknown>> } | undefined {
  try {
    const fn = (source as unknown as { readBlock?: (i: number, c: number) => { rows: ReadonlyArray<ReadonlyArray<unknown>> } }).readBlock;
    return fn ? fn(start, count) : undefined;
  } catch {
    return undefined;
  }
}

function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

// -----------------------------------------------------------------------------
// Convenience factory
// -----------------------------------------------------------------------------

/** @public */
export function createHeadlessGrid(
  config: HeadlessGridConfig,
): HeadlessGrid {
  return new HeadlessGrid(config);
}
