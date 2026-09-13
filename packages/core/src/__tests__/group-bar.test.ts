// =============================================================================
// Drag-to-group pill bar (v1.3 — wave 28).
//
// The bar is host-mounted DOM (like the wave-25 find toolbar). These tests
// exercise the DOM behavior + the onRowGrouping callback payload: mount,
// pill render, add via the select, remove via the ✕, imperative
// setGroupColumns, native-drag reorder, and destroy cleanup. The grid
// computes no grouping itself — it only emits the ordered column-id list.
// =============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Grid } from '../grid';
import type { ColumnDef, RowSource } from '../types';

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
    translate: () => undefined,
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
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const COLUMNS: ColumnDef[] = [
  { id: 'region', width: 100, displayName: 'Region' },
  { id: 'product', width: 120, displayName: 'Product' },
  { id: 'revenue', width: 90, displayName: 'Revenue' },
];

function source(numRows: number): RowSource {
  return { numRows, getCell: () => 'x' };
}

function groupBarOf(host: HTMLElement): HTMLElement | null {
  return host.querySelector('[aria-label="Group by columns"]');
}
function pillsOf(host: HTMLElement): HTMLElement[] {
  const bar = groupBarOf(host);
  return bar ? Array.from(bar.querySelectorAll('[role="listitem"]')) : [];
}
function addSelectOf(host: HTMLElement): HTMLSelectElement | null {
  const bar = groupBarOf(host);
  return bar ? bar.querySelector('select') : null;
}

interface Built {
  grid: Grid;
  host: HTMLDivElement;
  onRowGrouping: ReturnType<typeof vi.fn>;
}

function build(groupColumns?: string[]): Built {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const onRowGrouping = vi.fn();
  const grid = new Grid({
    host,
    columns: COLUMNS,
    rowSource: source(50),
    rowHeight: 24,
    enableGroupBar: true,
    ...(groupColumns ? { groupColumns } : {}),
    onRowGrouping,
  });
  return { grid, host, onRowGrouping };
}

describe('Group bar — mount + render', () => {
  it('mounts the bar only when enableGroupBar is set', () => {
    const off = document.createElement('div');
    document.body.appendChild(off);
    const g = new Grid({ host: off, columns: COLUMNS, rowSource: source(10), rowHeight: 24 });
    expect(groupBarOf(off)).toBeNull();
    g.destroy();
    document.body.removeChild(off);

    const b = build();
    expect(groupBarOf(b.host)).not.toBeNull();
    b.grid.destroy();
    document.body.removeChild(b.host);
  });

  it('renders one pill per seeded group column, in order, with display names', () => {
    const b = build(['region', 'product']);
    const pills = pillsOf(b.host);
    expect(pills.map((p) => p.textContent?.replace('✕', '').trim())).toEqual([
      'Region',
      'Product',
    ]);
    expect(b.grid.getGroupColumns()).toEqual(['region', 'product']);
    b.grid.destroy();
    document.body.removeChild(b.host);
  });

  it('the add-select lists only ungrouped columns', () => {
    const b = build(['region']);
    const sel = addSelectOf(b.host)!;
    const optionVals = Array.from(sel.options)
      .map((o) => o.value)
      .filter(Boolean);
    expect(optionVals).toEqual(['product', 'revenue']);
    b.grid.destroy();
    document.body.removeChild(b.host);
  });

  it('hides the add-select when every column is already grouped', () => {
    const b = build(['region', 'product', 'revenue']);
    expect(addSelectOf(b.host)).toBeNull();
    b.grid.destroy();
    document.body.removeChild(b.host);
  });
});

describe('Group bar — mutations fire onRowGrouping', () => {
  it('selecting a column in the add-select appends it and fires', () => {
    const b = build([]);
    const sel = addSelectOf(b.host)!;
    sel.value = 'product';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    expect(b.onRowGrouping).toHaveBeenCalledTimes(1);
    expect(b.onRowGrouping.mock.calls[0]![0]).toEqual(['product']);
    expect(b.grid.getGroupColumns()).toEqual(['product']);
    b.grid.destroy();
    document.body.removeChild(b.host);
  });

  it('clicking a pill ✕ removes that column and fires', () => {
    const b = build(['region', 'product']);
    const firstPill = pillsOf(b.host)[0]!;
    const removeBtn = firstPill.querySelector('button')!;
    removeBtn.click();
    expect(b.onRowGrouping).toHaveBeenCalledTimes(1);
    expect(b.onRowGrouping.mock.calls[0]![0]).toEqual(['product']);
    expect(b.grid.getGroupColumns()).toEqual(['product']);
    b.grid.destroy();
    document.body.removeChild(b.host);
  });

  it('setGroupColumns replaces the list and fires once', () => {
    const b = build(['region']);
    b.grid.setGroupColumns(['revenue', 'product']);
    expect(b.onRowGrouping).toHaveBeenCalledTimes(1);
    expect(b.onRowGrouping.mock.calls[0]![0]).toEqual(['revenue', 'product']);
    // bar rebuilt
    expect(pillsOf(b.host).map((p) => p.textContent?.replace('✕', '').trim())).toEqual([
      'Revenue',
      'Product',
    ]);
    b.grid.destroy();
    document.body.removeChild(b.host);
  });

  it('setGroupColumns with an identical list is a silent no-op', () => {
    const b = build(['region', 'product']);
    b.grid.setGroupColumns(['region', 'product']);
    expect(b.onRowGrouping).not.toHaveBeenCalled();
    b.grid.destroy();
    document.body.removeChild(b.host);
  });

  it('re-applying the current list (getGroupColumns round-trip) does not fire', () => {
    const b = build(['region', 'product']);
    b.grid.setGroupColumns(b.grid.getGroupColumns());
    expect(b.onRowGrouping).not.toHaveBeenCalled();
    b.grid.destroy();
    document.body.removeChild(b.host);
  });
});

describe('Group bar — drag reorder', () => {
  function fireDrag(pill: HTMLElement, type: string): void {
    const ev = new Event(type, { bubbles: true }) as DragEvent & {
      dataTransfer: Partial<DataTransfer>;
    };
    Object.defineProperty(ev, 'dataTransfer', {
      value: { setData: () => undefined, getData: () => '', effectAllowed: '', dropEffect: '' },
      configurable: true,
    });
    pill.dispatchEvent(ev);
  }

  it('dragging pill 0 onto pill 2 reorders and fires with the new order', () => {
    const b = build(['region', 'product', 'revenue']);
    const pills = pillsOf(b.host);
    fireDrag(pills[0]!, 'dragstart'); // grab 'region' (index 0)
    fireDrag(pills[2]!, 'dragover'); // hover index 2
    fireDrag(pills[2]!, 'drop'); // drop at index 2
    expect(b.onRowGrouping).toHaveBeenCalledTimes(1);
    // from=0, target=2 → insertAt = 2-1 = 1 → [product, region, revenue]
    expect(b.onRowGrouping.mock.calls[0]![0]).toEqual(['product', 'region', 'revenue']);
    b.grid.destroy();
    document.body.removeChild(b.host);
  });

  it('dropping a pill back on itself is a no-op', () => {
    const b = build(['region', 'product']);
    const pills = pillsOf(b.host);
    fireDrag(pills[1]!, 'dragstart');
    fireDrag(pills[1]!, 'dragover');
    fireDrag(pills[1]!, 'drop');
    expect(b.onRowGrouping).not.toHaveBeenCalled();
    b.grid.destroy();
    document.body.removeChild(b.host);
  });
});

describe('Group bar — teardown', () => {
  it('destroy removes the bar from the host', () => {
    const b = build(['region']);
    expect(groupBarOf(b.host)).not.toBeNull();
    b.grid.destroy();
    expect(groupBarOf(b.host)).toBeNull();
    expect(b.host.children.length).toBe(0);
    document.body.removeChild(b.host);
  });
});
