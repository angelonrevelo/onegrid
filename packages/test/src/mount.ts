// =============================================================================
// jsdom environment + grid mounting
//
// A real `Grid` needs four things jsdom does not provide: a 2D context, a
// `ResizeObserver`, `Element.scrollTo` / `scrollBy`, and a host element whose
// `getBoundingClientRect()` reports a non-zero box. The last one is the
// subtle one — @onegrid/core derives its viewport size from that rect, and a
// zero-sized viewport makes every hit-test return null, so pointer-driven
// tests silently do nothing rather than fail loudly.
//
// Design decisions:
//
//   1. The fake `ResizeObserver` fires its callback SYNCHRONOUSLY from
//      `observe()`. @onegrid/core also calls `handleResize()` directly at the
//      end of its constructor, and a non-zero first measurement makes that
//      call paint synchronously — so `mountGrid` returns with the
//      accessibility shadow already populated and no `await` required for the
//      first assertion. Tests that never scroll never need to pump a frame.
//
//   2. `requestAnimationFrame` is backed by `setTimeout(0)`, not by a manual
//      queue the test drains. Manual queues force every helper to know about
//      the clock; a macrotask-backed rAF lets `waitForRender` be a plain
//      `await` and keeps `setTimeout`-based grid internals (the validator
//      debounce, flash decay) on the same timeline.
//
//   3. Geometry lives on the handle, not inside the event helpers. The
//      pointer helpers must convert (row, column) into client coordinates,
//      and the offsets that conversion needs — header band, column-group
//      band, floating-filter row, pinned-top band — are private to the Grid.
//      `mountGrid` is the one place that has the options in hand, so it is
//      the one place that can compute them correctly.
// =============================================================================

import { Grid } from '@onegrid/core';
import type { GridOptions } from '@onegrid/core';
import { installCanvasStub } from './canvas-stub';
import type { CanvasStubHandle, CanvasStubOption } from './canvas-stub';

// Layout constants mirrored from @onegrid/core. They are private there and
// stable in practice; mismatches surface immediately as an off-by-one-band
// hit-test failure in this package's own suite, which is why that suite
// drives selection through real pointer events rather than the imperative API.
const COLUMN_GROUP_BAND_HEIGHT = 24;
const FLOATING_FILTER_ROW_HEIGHT = 28;
const DEFAULT_HEADER_HEIGHT = 32;
const DEFAULT_PINNED_ROW_HEIGHT = 28;

/** Handle returned by {@link installGridEnvironment}. */
export interface GridEnvironmentHandle {
  /** The recording canvas stub backing every grid mounted in this environment. */
  readonly canvas: CanvasStubHandle;
  /** Undo every global patch. Call from `afterEach`. */
  readonly restore: () => void;
}

/** Options for {@link installGridEnvironment}. */
export interface GridEnvironmentOption {
  /** Forwarded to {@link installCanvasStub}. */
  readonly canvas?: CanvasStubOption;
}

/**
 * Patch the jsdom globals a mounted `Grid` requires, and return a handle that
 * removes the patches again. Safe to call once per test in `beforeEach`.
 *
 * @public
 */
export function installGridEnvironment(
  option: GridEnvironmentOption = {},
): GridEnvironmentHandle {
  const canvas = installCanvasStub(option.canvas ?? {});

  const globalRef = globalThis as unknown as Record<string, unknown>;
  const priorRaf = globalRef['requestAnimationFrame'];
  const priorCaf = globalRef['cancelAnimationFrame'];
  const priorResizeObserver = globalRef['ResizeObserver'];
  // Same reasoning as the canvas stub: we are deliberately capturing
  // prototype methods as values so `restore()` can put them back.
  /* eslint-disable @typescript-eslint/unbound-method */
  const priorScrollTo = Element.prototype.scrollTo;
  const priorScrollBy = Element.prototype.scrollBy;
  /* eslint-enable @typescript-eslint/unbound-method */

  const timer = new Set<ReturnType<typeof setTimeout>>();

  globalRef['requestAnimationFrame'] = (cb: FrameRequestCallback): number => {
    const handle = setTimeout(() => {
      timer.delete(handle);
      cb(performance.now());
    }, 0);
    timer.add(handle);
    return handle as unknown as number;
  };
  globalRef['cancelAnimationFrame'] = (handle: number): void => {
    const t = handle as unknown as ReturnType<typeof setTimeout>;
    timer.delete(t);
    clearTimeout(t);
  };

  globalRef['ResizeObserver'] = class {
    constructor(private readonly cb: () => void) {}
    observe(): void {
      // Synchronous first measurement — see decision (1) above.
      this.cb();
    }
    unobserve(): void {
      /* nothing to release in the fake */
    }
    disconnect(): void {
      /* nothing to release in the fake */
    }
  };

  // jsdom parses these off the CSSOM but never implements the methods.
  // @onegrid/core calls scrollTo when the row source is swapped.
  Element.prototype.scrollTo = function (): void {
    /* jsdom has no scrolling viewport */
  };
  Element.prototype.scrollBy = function (): void {
    /* jsdom has no scrolling viewport */
  };

  return {
    canvas,
    restore: () => {
      for (const t of timer) clearTimeout(t);
      timer.clear();
      canvas.restore();
      globalRef['requestAnimationFrame'] = priorRaf;
      globalRef['cancelAnimationFrame'] = priorCaf;
      globalRef['ResizeObserver'] = priorResizeObserver;
      Element.prototype.scrollTo = priorScrollTo;
      Element.prototype.scrollBy = priorScrollBy;
    },
  };
}

/**
 * Viewport-coordinate math for a mounted grid. Every value is in CSS pixels
 * relative to the host's top-left, which — because {@link mountGrid} pins the
 * host rect at the origin — is also the client coordinate a pointer event
 * should carry.
 *
 * @public
 */
export interface GridGeometry {
  /** Viewport y where data rows start (below header + pinned-top bands). */
  readonly dataTop: number;
  /** Viewport y of a row's top edge at the grid's current scroll offset. */
  readonly rowTop: (rowIndex: number) => number;
  /** Height of a single row, honouring a per-row `Float32Array` rowHeight. */
  readonly rowHeight: (rowIndex: number) => number;
  /** Viewport x of a column's left edge at the grid's current scroll offset. */
  readonly columnLeft: (columnIndex: number) => number;
  /** Width of a column in CSS pixels. */
  readonly columnWidth: (columnIndex: number) => number;
  /** Client point at the CENTRE of a cell — clear of every resize hit-zone. */
  readonly cellPoint: (rowIndex: number, columnIndex: number) => ClientPoint;
  /** Client point at the centre of a column header. */
  readonly headerPoint: (columnIndex: number) => ClientPoint;
}

/** A point in client coordinates, ready to put on a pointer event. */
export interface ClientPoint {
  readonly clientX: number;
  readonly clientY: number;
}

/** Options for {@link mountGrid} — every `GridOptions` field except `host`. */
export type MountGridOption = Omit<GridOptions, 'host'> & {
  /** Host width in CSS pixels. Default 800. */
  readonly width?: number;
  /** Host height in CSS pixels. Default 600. */
  readonly height?: number;
};

/** A mounted grid plus everything a test needs to drive and inspect it. */
export interface GridTestHandle {
  readonly grid: Grid;
  /** The element the grid was mounted into; already in `document.body`. */
  readonly host: HTMLElement;
  /** The `role="grid"` scroll host — the element that owns keyboard focus. */
  readonly scrollHost: HTMLElement;
  readonly geometry: GridGeometry;
  /** Destroy the grid and remove the host from the document. */
  readonly unmount: () => void;
}

/**
 * Size an element's bounding box. jsdom always reports a zero rect because it
 * runs no layout engine, so the box has to be declared rather than measured.
 *
 * @public
 */
export function setElementRect(el: HTMLElement, width: number, height: number): void {
  el.getBoundingClientRect = (): DOMRect => ({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: width,
    bottom: height,
    width,
    height,
    toJSON: () => ({}),
  });
}

/**
 * Mount a real `Grid` into a sized, document-attached host and hand back a
 * handle. Requires {@link installGridEnvironment} to have run first — without
 * the canvas stub the `Grid` constructor throws on a null 2D context.
 *
 * The returned handle's geometry is live: it reads the grid's current scroll
 * offsets on every call, so a pointer helper stays correct after scrolling.
 *
 * @public
 */
export function mountGrid(option: MountGridOption): GridTestHandle {
  const width = option.width ?? 800;
  const height = option.height ?? 600;

  const host = document.createElement('div');
  setElementRect(host, width, height);
  document.body.appendChild(host);

  const grid = new Grid({ ...option, host });

  const scrollHost = host.querySelector<HTMLElement>('[role="grid"]');
  if (!scrollHost) {
    grid.destroy();
    host.remove();
    throw new Error(
      '@onegrid/test: mounted grid produced no [role="grid"] element. ' +
        'This means installGridEnvironment() was not called, or @onegrid/core ' +
        'changed its DOM structure.',
    );
  }

  // Header band offsets. Recomputed per call rather than cached because
  // setColumns() can add a column group after mount.
  const headerHeight = option.headerHeight ?? DEFAULT_HEADER_HEIGHT;
  const pinnedRowHeight = option.pinnedRowHeight ?? DEFAULT_PINNED_ROW_HEIGHT;
  const fullHeaderHeight = (): number =>
    headerHeight +
    (option.columnGroups && option.columnGroups.length > 0 ? COLUMN_GROUP_BAND_HEIGHT : 0) +
    (option.floatingFilters ? FLOATING_FILTER_ROW_HEIGHT : 0);
  const dataTop =
    fullHeaderHeight() +
    (option.pinnedTopRowSource ? option.pinnedTopRowSource.numRows * pinnedRowHeight : 0);

  const rowHeight = (rowIndex: number): number =>
    typeof option.rowHeight === 'number'
      ? option.rowHeight
      : (option.rowHeight[rowIndex] ?? 0);

  const rowOffset = (rowIndex: number): number => {
    if (typeof option.rowHeight === 'number') return rowIndex * option.rowHeight;
    let acc = 0;
    for (let i = 0; i < rowIndex; i++) acc += option.rowHeight[i] ?? 0;
    return acc;
  };

  const frozenCount = option.frozenColumnCount ?? 0;
  const columnWidth = (columnIndex: number): number =>
    grid.getColumns()[columnIndex]?.width ?? 0;

  const columnOffset = (columnIndex: number): number => {
    const column = grid.getColumns();
    let acc = 0;
    for (let i = 0; i < columnIndex && i < column.length; i++) acc += column[i]?.width ?? 0;
    return acc;
  };

  const geometry: GridGeometry = {
    dataTop,
    rowHeight,
    columnWidth,
    rowTop: (rowIndex) => dataTop + rowOffset(rowIndex) - grid.getViewportInfo().scrollTop,
    columnLeft: (columnIndex) => {
      const raw = columnOffset(columnIndex);
      // Frozen columns are pinned at the viewport's left edge; scrolling
      // columns are shifted left by scrollLeft and sit after the frozen band.
      if (columnIndex < frozenCount) return raw;
      const frozenWidth = columnOffset(frozenCount);
      return frozenWidth + (raw - frozenWidth) - grid.getViewportInfo().scrollLeft;
    },
    cellPoint: (rowIndex, columnIndex) => ({
      clientX: geometry.columnLeft(columnIndex) + columnWidth(columnIndex) / 2,
      clientY: geometry.rowTop(rowIndex) + rowHeight(rowIndex) / 2,
    }),
    headerPoint: (columnIndex) => ({
      clientX: geometry.columnLeft(columnIndex) + columnWidth(columnIndex) / 2,
      clientY: fullHeaderHeight() - headerHeight / 2,
    }),
  };

  return {
    grid,
    host,
    scrollHost,
    geometry,
    unmount: () => {
      grid.destroy();
      host.remove();
    },
  };
}
