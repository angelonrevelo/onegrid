// =============================================================================
// Multi-row drag-reorder (v1.2 follow-up to wave 26's single-row drag).
//
// Wave 26 emitted `onRowReorder(from, to)`. That is right for one row and
// silently wrong for a multi-row selection: the user drags five selected rows
// and one moves.
//
// The behaviour under test is the selection rule, which is what makes the
// feature discoverable without a modifier key:
//
//   - dragging a row INSIDE the selection moves the whole selection
//   - dragging a row OUTSIDE it moves only that row, and does NOT clear the
//     selection (a drag is not a click)
//
// `rowDragMovedRow` is private, so these tests exercise it through the public
// `onRowReorder` callback, which is the surface adopters actually bind to.
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

const COLUMN: ColumnDef[] = [
  { id: 'drag', width: 40 },
  { id: 'name', width: 160 },
];

const source = (numRows: number): RowSource => ({ numRows, getCell: () => 'x' });

const ROW_HEIGHT = 24;
const HEADER_HEIGHT = 32;

function mount(option: Partial<GridOptions> = {}) {
  const host = document.createElement('div');
  host.getBoundingClientRect = () =>
    ({ top: 0, left: 0, width: 600, height: 600, right: 600, bottom: 600, x: 0, y: 0 }) as DOMRect;
  document.body.appendChild(host);

  const onRowReorder = vi.fn();
  const grid = new Grid({
    host,
    columns: COLUMN,
    rowSource: source(20),
    rowHeight: ROW_HEIGHT,
    headerHeight: HEADER_HEIGHT,
    rowDragColumnId: 'drag',
    onRowReorder,
    ...option,
  });

  return {
    grid,
    host,
    onRowReorder,
    cleanup: () => {
      grid.destroy();
      host.remove();
    },
  };
}

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

/** Vertical centre of a data row, in client coordinates. */
const rowY = (rowIndex: number): number => HEADER_HEIGHT + rowIndex * ROW_HEIGHT + ROW_HEIGHT / 2;

/** Drag the handle cell of `fromRow` down onto `toRow`. */
function dragRow(host: HTMLElement, fromRow: number, toRow: number): void {
  const el = scrollHost(host);
  el.dispatchEvent(pointer('pointerdown', 20, rowY(fromRow)));
  // Past the 6px promotion threshold, then onto the target.
  el.dispatchEvent(pointer('pointermove', 20, rowY(fromRow) + 10));
  el.dispatchEvent(pointer('pointermove', 20, rowY(toRow)));
  window.dispatchEvent(pointer('pointerup', 20, rowY(toRow)));
}

describe('multi-row drag-reorder', () => {
  it('moves only the dragged row when nothing is selected', () => {
    const { host, onRowReorder, cleanup } = mount();

    dragRow(host, 2, 6);

    expect(onRowReorder).toHaveBeenCalledTimes(1);
    expect(onRowReorder.mock.calls[0]?.[2]).toEqual([2]);
    cleanup();
  });

  it('moves the whole selection when the dragged row is inside it', () => {
    const { grid, host, onRowReorder, cleanup } = mount();

    // Select rows 1..3 across both columns: anchor, then extend.
    grid.selectCell({ row: 1, col: 0 });
    grid.gotoCell(3, 1, true);
    dragRow(host, 2, 8);

    expect(onRowReorder).toHaveBeenCalledTimes(1);
    expect(onRowReorder.mock.calls[0]?.[2]).toEqual([1, 2, 3]);
    cleanup();
  });

  it('moves only the dragged row when it sits outside the selection', () => {
    const { grid, host, onRowReorder, cleanup } = mount();

    grid.selectCell({ row: 1, col: 0 });
    grid.gotoCell(3, 1, true);
    dragRow(host, 9, 14);

    expect(onRowReorder.mock.calls[0]?.[2]).toEqual([9]);
    cleanup();
  });

  it('keeps the leading two arguments at their wave-26 meaning', () => {
    const { host, onRowReorder, cleanup } = mount();

    dragRow(host, 2, 6);

    const call = onRowReorder.mock.calls[0];
    expect(typeof call?.[0]).toBe('number');
    expect(typeof call?.[1]).toBe('number');
    // The drag started on row 2, so that is still the reported origin.
    expect(call?.[0]).toBe(2);
    cleanup();
  });

  it('does not fire when a single row is dropped back where it started', () => {
    const { host, onRowReorder, cleanup } = mount();

    dragRow(host, 4, 4);

    expect(onRowReorder).not.toHaveBeenCalled();
    cleanup();
  });

  it('reports the moved set ascending regardless of selection direction', () => {
    const { grid, host, onRowReorder, cleanup } = mount();

    // Anchor BELOW the active cell — a bottom-up drag-select.
    grid.selectCell({ row: 5, col: 0 });
    grid.gotoCell(2, 1, true);
    dragRow(host, 3, 10);

    expect(onRowReorder.mock.calls[0]?.[2]).toEqual([2, 3, 4, 5]);
    cleanup();
  });
});
