// =============================================================================
// Row drag-reorder (wave 26; multi-row since v1.2).
//
// The wave-26 tests assert option wiring + indicator cleanup. The v1.2
// tail tests drive the actual pointerdown → pointermove → pointerup state
// machine to verify onRowReorder fires with the right (fromRows, toRow)
// payload for single-row, multi-row-block, and no-op drops.
// =============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Grid } from '../grid';
import type { ColumnDef, RowSource } from '../types';

const HOST_WIDTH = 400;
const HOST_HEIGHT = 600;
const ROW_HEIGHT = 24;

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    return setTimeout(() => {
      cb(performance.now());
    }, 0) as unknown as number;
  });
  vi.stubGlobal('cancelAnimationFrame', (handle: number) => {
    clearTimeout(handle as unknown as ReturnType<typeof setTimeout>);
  });
  const ctxStub: Partial<CanvasRenderingContext2D> = {
    setTransform: () => undefined,
    clearRect: () => undefined,
    fillRect: () => undefined,
    fillText: () => undefined,
    strokeRect: () => undefined,
    save: () => undefined,
    restore: () => undefined,
    beginPath: () => undefined,
    rect: () => undefined,
    clip: () => undefined,
    moveTo: () => undefined,
    lineTo: () => undefined,
    stroke: () => undefined,
    measureText: (() => ({ width: 0 })) as unknown as CanvasRenderingContext2D['measureText'],
    fillStyle: '',
    strokeStyle: '',
    font: '',
    textBaseline: 'middle' as CanvasTextBaseline,
    lineWidth: 1,
    globalAlpha: 1,
  };
  const original = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (
    this: HTMLCanvasElement,
    contextId: string,
  ) {
    if (contextId === '2d') return ctxStub as CanvasRenderingContext2D;
    return original.call(this, contextId as unknown as '2d');
  } as typeof HTMLCanvasElement.prototype.getContext;
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {
        return undefined;
      }
      unobserve(): void {
        return undefined;
      }
      disconnect(): void {
        return undefined;
      }
    },
  );
  Element.prototype.scrollTo = function (): void {
    return undefined;
  } as Element['scrollTo'];
  // The pointer handlers read host.getBoundingClientRect() for the local
  // coordinate frame; jsdom returns a zero rect by default.
  HTMLDivElement.prototype.getBoundingClientRect = function (): DOMRect {
    return {
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: HOST_WIDTH,
      bottom: HOST_HEIGHT,
      width: HOST_WIDTH,
      height: HOST_HEIGHT,
      toJSON: () => ({}),
    } as DOMRect;
  };
  Element.prototype.setPointerCapture = function (): void {
    return undefined;
  };
  Element.prototype.releasePointerCapture = function (): void {
    return undefined;
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const COLUMNS: ColumnDef[] = [
  { id: 'drag', width: 40 },
  { id: 'name', width: 100 },
];

function source(numRows: number): RowSource {
  return { numRows, getCell: () => 'x' };
}

interface Built {
  grid: Grid;
  host: HTMLDivElement;
  scrollHost: HTMLElement;
  onRowReorder: ReturnType<typeof vi.fn>;
}

function build(): Built {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const onRowReorder = vi.fn();
  const grid = new Grid({
    host,
    columns: COLUMNS,
    rowSource: source(20),
    rowHeight: ROW_HEIGHT,
    headerHeight: 0, // dataBandTop() === 0 → row R center = R*ROW_HEIGHT + 12
    rowDragColumnId: 'drag',
    onRowReorder,
  });
  const scrollHost = host.querySelector('div') as HTMLElement;
  return { grid, host, scrollHost, onRowReorder };
}

function pointer(
  scrollHost: HTMLElement,
  type: string,
  clientX: number,
  clientY: number,
  shiftKey = false,
): void {
  const target = type === 'pointerup' ? window : scrollHost;
  const ev = new Event(type, { bubbles: true }) as PointerEvent & {
    clientX: number;
    clientY: number;
    pointerId: number;
    shiftKey: boolean;
  };
  Object.defineProperty(ev, 'clientX', { value: clientX, configurable: true });
  Object.defineProperty(ev, 'clientY', { value: clientY, configurable: true });
  Object.defineProperty(ev, 'pointerId', { value: 1, configurable: true });
  Object.defineProperty(ev, 'shiftKey', { value: shiftKey, configurable: true });
  target.dispatchEvent(ev);
}

/** Y of the vertical center of row R (headerHeight 0, scrollTop 0). */
function rowCenterY(row: number): number {
  return row * ROW_HEIGHT + ROW_HEIGHT / 2;
}

/** Y of the top boundary of row R — the insertion index `to === R`. */
function boundaryY(insertIndex: number): number {
  return insertIndex * ROW_HEIGHT;
}

const DRAG_COL_X = 20; // inside the 40px-wide 'drag' column
const NAME_COL_X = 80; // inside the 'name' column

/** Build a multi-row selection by clicking row `from` then shift-clicking
 *  row `to` in a non-drag column. */
function selectRows(b: Built, from: number, to: number): void {
  pointer(b.scrollHost, 'pointerdown', NAME_COL_X, rowCenterY(from));
  pointer(b.scrollHost, 'pointerup', NAME_COL_X, rowCenterY(from));
  pointer(b.scrollHost, 'pointerdown', NAME_COL_X, rowCenterY(to), true);
  pointer(b.scrollHost, 'pointerup', NAME_COL_X, rowCenterY(to), true);
}

/** Drag the handle of `grabRow` until the drop indicator sits at
 *  insertion index `toIndex`. Crosses the 6px promotion threshold first. */
function dragHandle(b: Built, grabRow: number, toIndex: number): void {
  const startY = rowCenterY(grabRow);
  pointer(b.scrollHost, 'pointerdown', DRAG_COL_X, startY);
  // Cross the promotion threshold (>6px) so candidate → active.
  pointer(b.scrollHost, 'pointermove', DRAG_COL_X, startY + 8);
  // Move to the target boundary so updateRowDragIndicator snaps there.
  pointer(b.scrollHost, 'pointermove', DRAG_COL_X, boundaryY(toIndex));
  pointer(b.scrollHost, 'pointerup', DRAG_COL_X, boundaryY(toIndex));
}

describe('Wave 26 — Row drag-reorder (option wiring)', () => {
  it('accepts rowDragColumnId + onRowReorder options without throwing', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const onRowReorder = vi.fn();
    const grid = new Grid({
      host,
      columns: COLUMNS,
      rowSource: source(10),
      rowHeight: 24,
      rowDragColumnId: 'drag',
      onRowReorder,
    });
    expect(onRowReorder).not.toHaveBeenCalled();
    grid.destroy();
    document.body.removeChild(host);
  });

  it('without rowDragColumnId, no row-drag state is mounted', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const grid = new Grid({
      host,
      columns: COLUMNS,
      rowSource: source(10),
      rowHeight: 24,
    });
    const blue = Array.from(host.children).find(
      (c) => (c as HTMLElement).style.background === 'rgb(110, 168, 254)',
    );
    expect(blue).toBeUndefined();
    grid.destroy();
    document.body.removeChild(host);
  });

  it('destroy cleans up the row-drag indicator when one is mounted', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const grid = new Grid({
      host,
      columns: COLUMNS,
      rowSource: source(10),
      rowHeight: 24,
      rowDragColumnId: 'drag',
      onRowReorder: () => undefined,
    });
    expect(() => grid.destroy()).not.toThrow();
    expect(host.children.length).toBe(0);
    document.body.removeChild(host);
  });
});

describe('Row drag-reorder — single row (v1.2 payload shape)', () => {
  it('dragging one unselected row fires onRowReorder([from], to)', () => {
    const b = build();
    dragHandle(b, 2, 6); // grab row 2, drop before row 6
    expect(b.onRowReorder).toHaveBeenCalledTimes(1);
    const [fromRows, to] = b.onRowReorder.mock.calls[0]!;
    expect(fromRows).toEqual([2]);
    expect(to).toBe(6);
    b.grid.destroy();
    document.body.removeChild(b.host);
  });

  it('dropping a single row back onto itself is a no-op (does not fire)', () => {
    const b = build();
    // Grab row 3, drop at boundary 3 (its own top edge) → in-place.
    dragHandle(b, 3, 3);
    expect(b.onRowReorder).not.toHaveBeenCalled();
    b.grid.destroy();
    document.body.removeChild(b.host);
  });

  it('dropping a single row at its bottom edge is a no-op', () => {
    const b = build();
    // Grab row 3, drop at boundary 4 (its own bottom edge) → in-place.
    dragHandle(b, 3, 4);
    expect(b.onRowReorder).not.toHaveBeenCalled();
    b.grid.destroy();
    document.body.removeChild(b.host);
  });
});

describe('Row drag-reorder — multi-row block (v1.2)', () => {
  it('grabbing a row inside the selection moves the whole block', () => {
    const b = build();
    selectRows(b, 2, 4); // rows 2,3,4 selected
    dragHandle(b, 3, 10); // grab row 3 (inside selection), drop before row 10
    expect(b.onRowReorder).toHaveBeenCalledTimes(1);
    const [fromRows, to] = b.onRowReorder.mock.calls[0]!;
    expect(fromRows).toEqual([2, 3, 4]);
    expect(to).toBe(10);
    b.grid.destroy();
    document.body.removeChild(b.host);
  });

  it('grabbing a row OUTSIDE the selection moves only that row', () => {
    const b = build();
    selectRows(b, 2, 4); // rows 2,3,4 selected
    dragHandle(b, 8, 0); // grab row 8 (not selected), drop at top
    expect(b.onRowReorder).toHaveBeenCalledTimes(1);
    const [fromRows, to] = b.onRowReorder.mock.calls[0]!;
    expect(fromRows).toEqual([8]);
    expect(to).toBe(0);
    b.grid.destroy();
    document.body.removeChild(b.host);
  });

  it('dropping a contiguous block back inside its own run is a no-op', () => {
    const b = build();
    selectRows(b, 2, 4); // contiguous block 2..4
    dragHandle(b, 3, 3); // drop at boundary 3 — inside [2,5]
    expect(b.onRowReorder).not.toHaveBeenCalled();
    b.grid.destroy();
    document.body.removeChild(b.host);
  });

  it('dropping a contiguous block just past its bottom edge is a no-op', () => {
    const b = build();
    selectRows(b, 2, 4); // block 2..4 → no-op range [2, 5]
    dragHandle(b, 4, 5); // boundary 5 == hi+1
    expect(b.onRowReorder).not.toHaveBeenCalled();
    b.grid.destroy();
    document.body.removeChild(b.host);
  });

  it('moving a block just above its run DOES fire', () => {
    const b = build();
    selectRows(b, 4, 6); // block 4..6 → no-op range [4, 7]
    dragHandle(b, 5, 2); // boundary 2 < lo → real move
    expect(b.onRowReorder).toHaveBeenCalledTimes(1);
    const [fromRows, to] = b.onRowReorder.mock.calls[0]!;
    expect(fromRows).toEqual([4, 5, 6]);
    expect(to).toBe(2);
    b.grid.destroy();
    document.body.removeChild(b.host);
  });
});
