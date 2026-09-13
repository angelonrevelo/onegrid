// =============================================================================
// Aggregation side panel (v1.3 — wave 29).
//
// Docked aside with one aggregator <select> per column. The grid owns the
// columnId → AggregationType map as UI state and composes the full
// AggregationModel on each change. These tests drive the DOM + assert the
// onAggregationChange payload. The grid computes no aggregation itself.
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
  { id: 'revenue', width: 90, displayName: 'Revenue' },
  { id: 'score', width: 80, displayName: 'Score' },
];

function source(numRows: number): RowSource {
  return { numRows, getCell: () => 'x' };
}

function panelOf(host: HTMLElement): HTMLElement | null {
  return host.querySelector('[aria-label="Aggregation panel"]');
}
function selectsOf(host: HTMLElement): HTMLSelectElement[] {
  const p = panelOf(host);
  return p ? Array.from(p.querySelectorAll('select')) : [];
}
function selectFor(host: HTMLElement, columnId: string): HTMLSelectElement {
  return selectsOf(host).find((s) => s.dataset.columnId === columnId)!;
}

interface Built {
  grid: Grid;
  host: HTMLDivElement;
  onAggregationChange: ReturnType<typeof vi.fn>;
}

function build(opts: Partial<GridOptions> = {}): Built {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const onAggregationChange = vi.fn();
  const grid = new Grid({
    host,
    columns: COLUMNS,
    rowSource: source(50),
    rowHeight: 24,
    enableAggregationPanel: true,
    onAggregationChange,
    ...opts,
  });
  return { grid, host, onAggregationChange };
}

function change(sel: HTMLSelectElement, value: string): void {
  sel.value = value;
  sel.dispatchEvent(new Event('change', { bubbles: true }));
}

describe('Aggregation panel — mount + render', () => {
  it('mounts only when enableAggregationPanel is set', () => {
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

  it('renders one aggregator select per column with a none default', () => {
    const b = build();
    const sels = selectsOf(b.host);
    expect(sels.map((s) => s.dataset.columnId)).toEqual(['region', 'revenue', 'score']);
    expect(sels.every((s) => s.value === 'none')).toBe(true);
    b.grid.destroy();
    document.body.removeChild(b.host);
  });

  it('starts hidden, opens via openAggregationPanel(), closes again', () => {
    const b = build();
    expect(panelOf(b.host)!.style.display).toBe('none');
    b.grid.openAggregationPanel();
    expect(panelOf(b.host)!.style.display).toBe('flex');
    b.grid.closeAggregationPanel();
    expect(panelOf(b.host)!.style.display).toBe('none');
    b.grid.destroy();
    document.body.removeChild(b.host);
  });

  it('aggregationPanelOpen: true starts the panel open', () => {
    const b = build({ aggregationPanelOpen: true });
    expect(panelOf(b.host)!.style.display).toBe('flex');
    b.grid.destroy();
    document.body.removeChild(b.host);
  });

  it('seeds selects from the aggregations option (builtin types only)', () => {
    const b = build({
      aggregations: [
        { columnId: 'revenue', fn: 'sum' },
        { columnId: 'score', fn: 'avg' },
      ],
    });
    expect(selectFor(b.host, 'revenue').value).toBe('sum');
    expect(selectFor(b.host, 'score').value).toBe('avg');
    expect(selectFor(b.host, 'region').value).toBe('none');
    expect(b.grid.getAggregationModel()).toEqual([
      { columnId: 'revenue', fn: 'sum', alias: 'revenue' },
      { columnId: 'score', fn: 'avg', alias: 'score' },
    ]);
    b.grid.destroy();
    document.body.removeChild(b.host);
  });
});

describe('Aggregation panel — changes fire onAggregationChange', () => {
  it('selecting an aggregator composes the model (column order, alias=id)', () => {
    const b = build();
    change(selectFor(b.host, 'revenue'), 'sum');
    expect(b.onAggregationChange).toHaveBeenCalledTimes(1);
    expect(b.onAggregationChange.mock.calls[0]![0]).toEqual([
      { columnId: 'revenue', fn: 'sum', alias: 'revenue' },
    ]);
    change(selectFor(b.host, 'score'), 'avg');
    // Model is column-ordered: region (none) < revenue < score
    expect(b.onAggregationChange.mock.calls[1]![0]).toEqual([
      { columnId: 'revenue', fn: 'sum', alias: 'revenue' },
      { columnId: 'score', fn: 'avg', alias: 'score' },
    ]);
    b.grid.destroy();
    document.body.removeChild(b.host);
  });

  it('selecting "none" clears that column and recomposes', () => {
    const b = build({ aggregations: [{ columnId: 'revenue', fn: 'sum' }] });
    b.onAggregationChange.mockClear();
    change(selectFor(b.host, 'revenue'), 'none');
    expect(b.onAggregationChange).toHaveBeenCalledTimes(1);
    expect(b.onAggregationChange.mock.calls[0]![0]).toEqual([]);
    b.grid.destroy();
    document.body.removeChild(b.host);
  });

  it('re-selecting the same aggregator is a silent no-op', () => {
    const b = build({ aggregations: [{ columnId: 'revenue', fn: 'sum' }] });
    b.onAggregationChange.mockClear();
    change(selectFor(b.host, 'revenue'), 'sum');
    expect(b.onAggregationChange).not.toHaveBeenCalled();
    b.grid.destroy();
    document.body.removeChild(b.host);
  });

  it('imperative setColumnAggregator fires and updates getAggregationModel', () => {
    const b = build();
    b.grid.setColumnAggregator('score', 'max');
    expect(b.onAggregationChange).toHaveBeenCalledTimes(1);
    expect(b.grid.getAggregationModel()).toEqual([
      { columnId: 'score', fn: 'max', alias: 'score' },
    ]);
    b.grid.destroy();
    document.body.removeChild(b.host);
  });

  it('clearing an unset column via setColumnAggregator(none) is a no-op', () => {
    const b = build();
    b.grid.setColumnAggregator('region', 'none');
    expect(b.onAggregationChange).not.toHaveBeenCalled();
    b.grid.destroy();
    document.body.removeChild(b.host);
  });
});

describe('Aggregation panel — teardown', () => {
  it('destroy removes the panel from the host', () => {
    const b = build();
    expect(panelOf(b.host)).not.toBeNull();
    b.grid.destroy();
    expect(panelOf(b.host)).toBeNull();
    expect(b.host.children.length).toBe(0);
    document.body.removeChild(b.host);
  });
});
