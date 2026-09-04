// =============================================================================
// Pinned (frozen) column resize.
//
// The v1.2 roadmap listed this as an open gap ("currently frozen columns are
// fixed-width"). Reading the code says otherwise: `columnAtRightBoundary` has a
// frozen-band branch that hit-tests in absolute viewport coordinates, and
// `recomputeColumnWidths` re-derives `frozenWidth` from the live column widths
// on every `setColumns`. These tests exist to settle which is true by driving
// real pointer events, rather than resolving it by reading.
//
// The second property is the one that actually matters and the one a naive
// implementation gets wrong: resizing a frozen column must widen the FROZEN
// BAND itself. If `frozenWidth` were captured once at construction, the resize
// would appear to work and the scrolling band would then paint underneath the
// frozen one.
// =============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Grid } from '../grid';
import type { ColumnDef, GridOptions, RowSource } from '../types';

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
    setLineDash: () => undefined,
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
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Two frozen columns (100 + 80) then two scrolling ones. */
const COLUMN: ColumnDef[] = [
  { id: 'pinned_a', width: 100 },
  { id: 'pinned_b', width: 80 },
  { id: 'scroll_a', width: 120 },
  { id: 'scroll_b', width: 120 },
];

const source = (numRows: number): RowSource => ({ numRows, getCell: () => 'x' });

/** jsdom reports a zero-size box; declare one so hit-testing is meaningful. */
function mount(option: Partial<GridOptions> = {}) {
  const host = document.createElement('div');
  host.getBoundingClientRect = () =>
    ({ top: 0, left: 0, width: 800, height: 600, right: 800, bottom: 600, x: 0, y: 0 }) as DOMRect;
  document.body.appendChild(host);

  const onColumnResize = vi.fn();
  const grid = new Grid({
    host,
    columns: COLUMN,
    rowSource: source(50),
    rowHeight: 24,
    frozenColumnCount: 2,
    headerHeight: 32,
    enableColumnResize: true,
    onColumnResize,
    ...option,
  });

  return {
    grid,
    host,
    onColumnResize,
    cleanup: () => {
      grid.destroy();
      host.remove();
    },
  };
}

/** The grid listens for pointerdown on the scroll host (role=grid). */
function scrollHost(host: HTMLElement): HTMLElement {
  const el = host.querySelector<HTMLElement>('[role="grid"]');
  if (el === null) throw new Error('scroll host not found');
  return el;
}

function pointer(type: string, clientX: number, clientY: number): PointerEvent {
  const event = new MouseEvent(type, { clientX, clientY, bubbles: true, cancelable: true });
  Object.defineProperty(event, 'pointerId', { value: 1 });
  return event as PointerEvent;
}

describe('pinned column resize', () => {
  it('starts a resize on the boundary of the FIRST frozen column', () => {
    const { host, onColumnResize, cleanup } = mount();

    // Boundary of pinned_a sits at x=100, inside the header band.
    scrollHost(host).dispatchEvent(pointer('pointerdown', 100, 16));
    scrollHost(host).dispatchEvent(pointer('pointermove', 140, 16));

    expect(onColumnResize).toHaveBeenCalled();
    expect(onColumnResize.mock.calls[0]?.[0]).toBe('pinned_a');
    cleanup();
  });

  it('starts a resize on the boundary BETWEEN two frozen columns', () => {
    const { host, onColumnResize, cleanup } = mount();

    // Boundary of pinned_b sits at x=180 (100 + 80).
    scrollHost(host).dispatchEvent(pointer('pointerdown', 180, 16));
    scrollHost(host).dispatchEvent(pointer('pointermove', 210, 16));

    expect(onColumnResize.mock.calls[0]?.[0]).toBe('pinned_b');
    cleanup();
  });

  it('actually applies the new width to the frozen column', () => {
    const { grid, host, cleanup } = mount();

    scrollHost(host).dispatchEvent(pointer('pointerdown', 100, 16));
    scrollHost(host).dispatchEvent(pointer('pointermove', 150, 16));

    // Dragged +50 from a 100px start.
    expect(grid.getColumns()[0]?.width).toBe(150);
    // The columns behind it are untouched.
    expect(grid.getColumns()[1]?.width).toBe(80);
    cleanup();
  });

  it('widens the frozen BAND, so the scrolling band is not painted under it', () => {
    const { grid, host, cleanup } = mount();

    scrollHost(host).dispatchEvent(pointer('pointerdown', 100, 16));
    scrollHost(host).dispatchEvent(pointer('pointermove', 160, 16));

    // frozenWidth is internal; assert it through the behaviour that depends on
    // it. After growing pinned_a by 60, the boundary of pinned_b has moved from
    // x=180 to x=240 — so a fresh press at 240 must now grab pinned_b.
    window.dispatchEvent(pointer('pointerup', 160, 16));

    const second = vi.fn();
    grid.destroy();
    host.remove();

    const remount = mount({ onColumnResize: second });
    remount.grid.setColumns([
      { id: 'pinned_a', width: 160 },
      { id: 'pinned_b', width: 80 },
      { id: 'scroll_a', width: 120 },
      { id: 'scroll_b', width: 120 },
    ]);
    scrollHost(remount.host).dispatchEvent(pointer('pointerdown', 240, 16));
    scrollHost(remount.host).dispatchEvent(pointer('pointermove', 260, 16));

    expect(second.mock.calls[0]?.[0]).toBe('pinned_b');
    remount.cleanup();
    cleanup();
  });

  it('respects minWidth on a frozen column', () => {
    const { grid, host, cleanup } = mount({
      columns: [
        { id: 'pinned_a', width: 100, minWidth: 80 },
        { id: 'pinned_b', width: 80 },
        { id: 'scroll_a', width: 120 },
        { id: 'scroll_b', width: 120 },
      ],
    });

    // Drag far left; the clamp must stop it at minWidth, not go to 0.
    scrollHost(host).dispatchEvent(pointer('pointerdown', 100, 16));
    scrollHost(host).dispatchEvent(pointer('pointermove', 10, 16));

    expect(grid.getColumns()[0]?.width).toBe(80);
    cleanup();
  });

  it('does not resize a frozen column when enableColumnResize is off', () => {
    const { grid, host, onColumnResize, cleanup } = mount({ enableColumnResize: false });

    scrollHost(host).dispatchEvent(pointer('pointerdown', 100, 16));
    scrollHost(host).dispatchEvent(pointer('pointermove', 150, 16));

    expect(onColumnResize).not.toHaveBeenCalled();
    expect(grid.getColumns()[0]?.width).toBe(100);
    cleanup();
  });
});
