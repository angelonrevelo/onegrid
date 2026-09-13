// =============================================================================
// Pivot side panel (v1.3 — wave 31).
//
// Docked aside binding columns to the three PivotModel bins (rows /
// columns / values). Each column has a bin <select>; a values-bin column
// also gets an aggregator <select>. Any change composes the full
// PivotModel and fires onPivotChange. The grid computes no pivot itself.
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
  { id: 'product', width: 100, displayName: 'Product' },
  { id: 'revenue', width: 90, displayName: 'Revenue' },
];

function source(numRows: number): RowSource {
  return { numRows, getCell: () => 'x' };
}

function panelOf(host: HTMLElement): HTMLElement | null {
  return host.querySelector('[aria-label="Pivot panel"]');
}
function binSelect(host: HTMLElement, columnId: string): HTMLSelectElement {
  return panelOf(host)!.querySelector(`select[data-pivot-bin="${columnId}"]`)!;
}
function aggSelect(host: HTMLElement, columnId: string): HTMLSelectElement {
  return panelOf(host)!.querySelector(`select[data-pivot-agg="${columnId}"]`)!;
}

interface Built {
  grid: Grid;
  host: HTMLDivElement;
  onPivotChange: ReturnType<typeof vi.fn>;
}

function build(opts: Partial<GridOptions> = {}): Built {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const onPivotChange = vi.fn();
  const grid = new Grid({
    host,
    columns: COLUMNS,
    rowSource: source(50),
    rowHeight: 24,
    enablePivotPanel: true,
    onPivotChange,
    ...opts,
  });
  return { grid, host, onPivotChange };
}

function setBin(host: HTMLElement, columnId: string, bin: string): void {
  const sel = binSelect(host, columnId);
  sel.value = bin;
  sel.dispatchEvent(new Event('change', { bubbles: true }));
}
function setAgg(host: HTMLElement, columnId: string, fn: string): void {
  const sel = aggSelect(host, columnId);
  sel.value = fn;
  sel.dispatchEvent(new Event('change', { bubbles: true }));
}

function lastModel(b: Built) {
  return b.onPivotChange.mock.calls.at(-1)![0];
}

describe('Pivot panel — mount + render', () => {
  it('mounts only when enablePivotPanel is set', () => {
    const off = document.createElement('div');
    document.body.appendChild(off);
    const g = new Grid({ host: off, columns: COLUMNS, rowSource: source(10), rowHeight: 24 });
    expect(panelOf(off)).toBeNull();
    g.destroy();
    document.body.removeChild(off);

    const b = build();
    expect(panelOf(b.host)).not.toBeNull();
    b.grid.destroy();
    document.body.removeChild(b.host);
  });

  it('renders one bin select per column, defaulting to none', () => {
    const b = build();
    for (const c of COLUMNS) {
      expect(binSelect(b.host, c.id).value).toBe('none');
    }
    b.grid.destroy();
    document.body.removeChild(b.host);
  });

  it('the aggregator select is hidden until a column enters the values bin', () => {
    const b = build();
    expect(aggSelect(b.host, 'revenue').style.display).toBe('none');
    setBin(b.host, 'revenue', 'values');
    expect(aggSelect(b.host, 'revenue').style.display).toBe('block');
    b.grid.destroy();
    document.body.removeChild(b.host);
  });

  it('pivotPanelOpen: true starts open', () => {
    const b = build({ pivotPanelOpen: true });
    expect(panelOf(b.host)!.style.display).toBe('flex');
    b.grid.destroy();
    document.body.removeChild(b.host);
  });

  it('seeds bins from the pivotModel option', () => {
    const b = build({
      pivotModel: {
        rows: ['region'],
        columns: ['product'],
        measures: [{ columnId: 'revenue', fn: 'avg' }],
      },
    });
    expect(binSelect(b.host, 'region').value).toBe('rows');
    expect(binSelect(b.host, 'product').value).toBe('columns');
    expect(binSelect(b.host, 'revenue').value).toBe('values');
    expect(aggSelect(b.host, 'revenue').value).toBe('avg');
    expect(b.grid.getPivotModel()).toEqual({
      rows: ['region'],
      columns: ['product'],
      measures: [{ columnId: 'revenue', fn: 'avg', alias: 'revenue' }],
    });
    b.grid.destroy();
    document.body.removeChild(b.host);
  });
});

describe('Pivot panel — bin assignment composes PivotModel', () => {
  it('assigning rows / columns / values composes the full model', () => {
    const b = build();
    setBin(b.host, 'region', 'rows');
    expect(lastModel(b)).toEqual({ rows: ['region'], columns: [], measures: [] });
    setBin(b.host, 'product', 'columns');
    expect(lastModel(b)).toEqual({ rows: ['region'], columns: ['product'], measures: [] });
    setBin(b.host, 'revenue', 'values');
    expect(lastModel(b)).toEqual({
      rows: ['region'],
      columns: ['product'],
      measures: [{ columnId: 'revenue', fn: 'sum', alias: 'revenue' }],
    });
    b.grid.destroy();
    document.body.removeChild(b.host);
  });

  it('values-bin column defaults to sum, then honors the aggregator picker', () => {
    const b = build();
    setBin(b.host, 'revenue', 'values');
    expect(lastModel(b).measures).toEqual([
      { columnId: 'revenue', fn: 'sum', alias: 'revenue' },
    ]);
    setAgg(b.host, 'revenue', 'max');
    expect(lastModel(b).measures).toEqual([
      { columnId: 'revenue', fn: 'max', alias: 'revenue' },
    ]);
    b.grid.destroy();
    document.body.removeChild(b.host);
  });

  it('rows / columns preserve column order regardless of assignment order', () => {
    const b = build();
    // assign revenue (last column) to rows first, then region (first)
    setBin(b.host, 'revenue', 'rows');
    setBin(b.host, 'region', 'rows');
    // model is column-ordered: region before revenue
    expect(lastModel(b).rows).toEqual(['region', 'revenue']);
    b.grid.destroy();
    document.body.removeChild(b.host);
  });

  it('unassigning a column (none) removes it and recomposes', () => {
    const b = build({ pivotModel: { rows: ['region'], columns: [], measures: [] } });
    setBin(b.host, 'region', 'none');
    expect(lastModel(b)).toEqual({ rows: [], columns: [], measures: [] });
    b.grid.destroy();
    document.body.removeChild(b.host);
  });

  it('changing a non-values aggregator does not fire (no measure to affect)', () => {
    const b = build();
    setBin(b.host, 'revenue', 'rows'); // not values
    b.onPivotChange.mockClear();
    // The agg select is hidden, but firing its change must be a no-op
    // because the column isn't in the values bin.
    setAgg(b.host, 'revenue', 'avg');
    expect(b.onPivotChange).not.toHaveBeenCalled();
    b.grid.destroy();
    document.body.removeChild(b.host);
  });

  it('imperative setPivotBin works and updates getPivotModel', () => {
    const b = build();
    b.grid.setPivotBin('product', 'values');
    expect(b.grid.getPivotModel()).toEqual({
      rows: [],
      columns: [],
      measures: [{ columnId: 'product', fn: 'sum', alias: 'product' }],
    });
    expect(b.onPivotChange).toHaveBeenCalledTimes(1);
    b.grid.destroy();
    document.body.removeChild(b.host);
  });

  it('setPivotBin to the same bin is a silent no-op', () => {
    const b = build({ pivotModel: { rows: ['region'], columns: [], measures: [] } });
    b.grid.setPivotBin('region', 'rows');
    expect(b.onPivotChange).not.toHaveBeenCalled();
    b.grid.destroy();
    document.body.removeChild(b.host);
  });
});

describe('Pivot panel — teardown', () => {
  it('destroy removes the panel from the host', () => {
    const b = build();
    expect(panelOf(b.host)).not.toBeNull();
    b.grid.destroy();
    expect(panelOf(b.host)).toBeNull();
    expect(b.host.children.length).toBe(0);
    document.body.removeChild(b.host);
  });
});
