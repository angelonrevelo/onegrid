// =============================================================================
// Interactive (pointer-driven) column resize — including FROZEN columns
// (v1.2 tail). Auto-size tests exercise `autoSizeColumn`; this file drives
// the pointerdown → pointermove → pointerup state machine directly so the
// frozen-band hit-test path in `columnAtRightBoundary` is covered.
// =============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Grid } from '../grid';
import type { ColumnDef, RowSource } from '../types';

const HOST_WIDTH = 800;
const HOST_HEIGHT = 600;

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
    measureText: ((text: string) => ({ width: text.length * 7 })) as CanvasRenderingContext2D['measureText'],
    fillStyle: '',
    strokeStyle: '',
    font: '',
    textBaseline: 'middle' as CanvasTextBaseline,
    lineWidth: 1,
    globalAlpha: 1,
  };
  const original = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, contextId: string) {
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
  // jsdom returns a zero rect by default; the pointer handlers read
  // host.getBoundingClientRect() to build the local coordinate frame.
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
  // setPointerCapture / releasePointerCapture are not implemented in jsdom.
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
  { id: 'a', width: 100, displayName: 'A' },
  { id: 'b', width: 120, displayName: 'B' },
  { id: 'c', width: 140, displayName: 'C' },
  { id: 'd', width: 160, displayName: 'D' },
];

function source(numRows: number): RowSource {
  return {
    numRows,
    getCell: (rowIndex, columnId) => `${columnId}${rowIndex}`,
  };
}

interface Built {
  grid: Grid;
  host: HTMLDivElement;
  scrollHost: HTMLElement;
  onResize: ReturnType<typeof vi.fn>;
}

function build(frozenColumnCount: number): Built {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const onResize = vi.fn();
  const grid = new Grid({
    host,
    columns: COLUMNS.map((c) => ({ ...c })),
    rowSource: source(50),
    rowHeight: 24,
    enableColumnResize: true,
    onColumnResize: onResize,
    frozenColumnCount,
  });
  // The scrollHost is the first child div the Grid creates and binds
  // pointer listeners to.
  const scrollHost = host.querySelector('div') as HTMLElement;
  return { grid, host, scrollHost, onResize };
}

function pointer(scrollHost: HTMLElement, type: string, clientX: number, clientY: number): void {
  const target = type === 'pointerup' ? window : scrollHost;
  const ev = new Event(type, { bubbles: true }) as PointerEvent & {
    clientX: number;
    clientY: number;
    pointerId: number;
  };
  Object.defineProperty(ev, 'clientX', { value: clientX, configurable: true });
  Object.defineProperty(ev, 'clientY', { value: clientY, configurable: true });
  Object.defineProperty(ev, 'pointerId', { value: 1, configurable: true });
  target.dispatchEvent(ev);
}

/** Drag a column's right boundary by `dx` px starting from header Y. */
function dragBoundary(b: Built, boundaryX: number, dx: number, headerY = 5): void {
  pointer(b.scrollHost, 'pointerdown', boundaryX, headerY);
  pointer(b.scrollHost, 'pointermove', boundaryX + dx, headerY);
  pointer(b.scrollHost, 'pointerup', boundaryX + dx, headerY);
}

function widthOf(grid: Grid, id: string): number {
  return grid.getColumns().find((c) => c.id === id)?.width ?? 0;
}

describe('Interactive column resize — non-frozen baseline', () => {
  it('drag on a scrolling-band boundary widens that column', () => {
    const b = build(0);
    // Boundary after column 'a' sits at x=100 in viewport coords (scrollLeft=0).
    dragBoundary(b, 100, 40);
    expect(widthOf(b.grid, 'a')).toBe(140);
    // final commit fired with finalCommit=true
    const lastCall = b.onResize.mock.calls.at(-1);
    expect(lastCall?.[0]).toBe('a');
    expect(lastCall?.[2]).toBe(true);
    b.grid.destroy();
    document.body.removeChild(b.host);
  });
});

describe('Interactive column resize — FROZEN columns', () => {
  it('drag on a frozen column boundary resizes the frozen column', () => {
    const b = build(2); // columns a,b are frozen
    // Boundary after frozen column 'a' is at absolute x=100.
    dragBoundary(b, 100, 30);
    expect(widthOf(b.grid, 'a')).toBe(130);
    b.grid.destroy();
    document.body.removeChild(b.host);
  });

  it('drag on the second frozen column boundary resizes that column', () => {
    const b = build(2);
    // Boundary after frozen column 'b' is at absolute x=100+120=220.
    dragBoundary(b, 220, -20);
    expect(widthOf(b.grid, 'b')).toBe(100);
    b.grid.destroy();
    document.body.removeChild(b.host);
  });

  it('resizing a frozen column updates the frozen band width', () => {
    const b = build(2);
    // frozenWidth starts at 100+120=220. Widen 'a' by 50 → 270.
    dragBoundary(b, 100, 50);
    // The next non-frozen column 'c' now begins at the new frozen edge.
    // Probe via the public viewport info / column model: frozenWidth is
    // private, so assert through observable column widths instead.
    expect(widthOf(b.grid, 'a')).toBe(150);
    // A subsequent drag on the *other* frozen boundary must use the
    // updated layout — boundary after 'a','b' = 150+120 = 270.
    dragBoundary(b, 270, 10);
    expect(widthOf(b.grid, 'b')).toBe(130);
    b.grid.destroy();
    document.body.removeChild(b.host);
  });

  it('respects minWidth / maxWidth clamp on frozen columns', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const grid = new Grid({
      host,
      columns: [
        { id: 'a', width: 100, minWidth: 80, maxWidth: 160, displayName: 'A' },
        { id: 'b', width: 120, displayName: 'B' },
        { id: 'c', width: 140, displayName: 'C' },
      ],
      rowSource: source(20),
      rowHeight: 24,
      enableColumnResize: true,
      frozenColumnCount: 1,
    });
    const scrollHost = host.querySelector('div') as HTMLElement;
    const b: Built = { grid, host, scrollHost, onResize: vi.fn() };
    // Try to shrink well below minWidth: drag boundary at x=100 left by 60.
    dragBoundary(b, 100, -60);
    expect(widthOf(grid, 'a')).toBe(80); // clamped to minWidth
    // Try to grow well past maxWidth: from 80, drag right by 200.
    dragBoundary(b, 80, 200);
    expect(widthOf(grid, 'a')).toBe(160); // clamped to maxWidth
    grid.destroy();
    document.body.removeChild(host);
  });
});
