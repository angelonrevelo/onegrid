// =============================================================================
// Filter side panel (v1.3 — wave 30).
//
// Docked aside with a per-column operator <select> + value <input>.
// Changes are BATCHED: nothing fires until Apply, which composes a
// FilterModel (LogicalFilter('and', [ComparisonFilter…])) and emits it.
// The grid applies no filtering itself.
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
  { id: 'name', width: 100, displayName: 'Name' },
  { id: 'age', width: 60, displayName: 'Age' },
  { id: 'tag', width: 80, displayName: 'Tag' },
];

function source(numRows: number): RowSource {
  return { numRows, getCell: () => 'x' };
}

function panelOf(host: HTMLElement): HTMLElement | null {
  return host.querySelector('[aria-label="Filter panel"]');
}
function opSelect(host: HTMLElement, columnId: string): HTMLSelectElement {
  return panelOf(host)!.querySelector(`select[data-filter-op="${columnId}"]`)!;
}
function valInput(host: HTMLElement, columnId: string): HTMLInputElement {
  return panelOf(host)!.querySelector(`input[data-filter-val="${columnId}"]`)!;
}
function applyBtn(host: HTMLElement): HTMLButtonElement {
  return Array.from(panelOf(host)!.querySelectorAll('button')).find(
    (b) => b.textContent === 'Apply',
  )!;
}
function clearBtn(host: HTMLElement): HTMLButtonElement {
  return Array.from(panelOf(host)!.querySelectorAll('button')).find(
    (b) => b.textContent === 'Clear',
  )!;
}

interface Built {
  grid: Grid;
  host: HTMLDivElement;
  onFilterModelChange: ReturnType<typeof vi.fn>;
}

function build(opts: Partial<GridOptions> = {}): Built {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const onFilterModelChange = vi.fn();
  const grid = new Grid({
    host,
    columns: COLUMNS,
    rowSource: source(50),
    rowHeight: 24,
    enableFilterPanel: true,
    onFilterModelChange,
    ...opts,
  });
  return { grid, host, onFilterModelChange };
}

function setOp(host: HTMLElement, columnId: string, op: string): void {
  const sel = opSelect(host, columnId);
  sel.value = op;
  sel.dispatchEvent(new Event('change', { bubbles: true }));
}
function setVal(host: HTMLElement, columnId: string, value: string): void {
  const inp = valInput(host, columnId);
  inp.value = value;
  inp.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('Filter panel — mount + render', () => {
  it('mounts only when enableFilterPanel is set', () => {
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

  it('renders one op-select + value-input per column, plus Apply/Clear', () => {
    const b = build();
    for (const c of COLUMNS) {
      expect(opSelect(b.host, c.id)).toBeTruthy();
      expect(valInput(b.host, c.id)).toBeTruthy();
    }
    expect(applyBtn(b.host)).toBeTruthy();
    expect(clearBtn(b.host)).toBeTruthy();
    b.grid.destroy();
    document.body.removeChild(b.host);
  });

  it('filterPanelOpen: true starts open', () => {
    const b = build({ filterPanelOpen: true });
    expect(panelOf(b.host)!.style.display).toBe('flex');
    b.grid.destroy();
    document.body.removeChild(b.host);
  });
});

describe('Filter panel — batching + compose on Apply', () => {
  it('editing op/value does NOT fire until Apply', () => {
    const b = build();
    setOp(b.host, 'name', 'contains');
    setVal(b.host, 'name', 'ann');
    expect(b.onFilterModelChange).not.toHaveBeenCalled();
    applyBtn(b.host).click();
    expect(b.onFilterModelChange).toHaveBeenCalledTimes(1);
    expect(b.onFilterModelChange.mock.calls[0]![0]).toEqual({
      type: 'logical',
      op: 'and',
      filters: [{ type: 'comparison', columnId: 'name', op: 'contains', value: 'ann' }],
    });
    b.grid.destroy();
    document.body.removeChild(b.host);
  });

  it('composes multiple columns into one and-logical', () => {
    const b = build();
    setOp(b.host, 'name', 'startsWith');
    setVal(b.host, 'name', 'A');
    setOp(b.host, 'age', 'gte');
    setVal(b.host, 'age', '18');
    applyBtn(b.host).click();
    expect(b.onFilterModelChange.mock.calls[0]![0]).toEqual({
      type: 'logical',
      op: 'and',
      filters: [
        { type: 'comparison', columnId: 'name', op: 'startsWith', value: 'A' },
        { type: 'comparison', columnId: 'age', op: 'gte', value: '18' },
      ],
    });
    b.grid.destroy();
    document.body.removeChild(b.host);
  });

  it('multi-value op splits the input on commas into values[]', () => {
    const b = build();
    setOp(b.host, 'tag', 'in');
    setVal(b.host, 'tag', 'red, green , blue');
    applyBtn(b.host).click();
    expect(b.onFilterModelChange.mock.calls[0]![0]).toEqual({
      type: 'logical',
      op: 'and',
      filters: [{ type: 'comparison', columnId: 'tag', op: 'in', values: ['red', 'green', 'blue'] }],
    });
    b.grid.destroy();
    document.body.removeChild(b.host);
  });

  it('unary op (isNull) carries neither value nor values', () => {
    const b = build();
    setOp(b.host, 'name', 'isNull');
    applyBtn(b.host).click();
    expect(b.onFilterModelChange.mock.calls[0]![0]).toEqual({
      type: 'logical',
      op: 'and',
      filters: [{ type: 'comparison', columnId: 'name', op: 'isNull' }],
    });
    // the value input is disabled for unary ops
    expect(valInput(b.host, 'name').disabled).toBe(true);
    b.grid.destroy();
    document.body.removeChild(b.host);
  });

  it('a value-required op with an empty value is skipped', () => {
    const b = build();
    setOp(b.host, 'name', 'contains'); // no value typed
    applyBtn(b.host).click();
    // nothing usable → null
    expect(b.onFilterModelChange.mock.calls[0]![0]).toBeNull();
    b.grid.destroy();
    document.body.removeChild(b.host);
  });

  it('Apply with no drafts emits null', () => {
    const b = build();
    applyBtn(b.host).click();
    expect(b.onFilterModelChange).toHaveBeenCalledTimes(1);
    expect(b.onFilterModelChange.mock.calls[0]![0]).toBeNull();
    b.grid.destroy();
    document.body.removeChild(b.host);
  });

  it('imperative applyFilterPanel() works without the button', () => {
    const b = build();
    setOp(b.host, 'age', 'lt');
    setVal(b.host, 'age', '5');
    b.grid.applyFilterPanel();
    expect(b.onFilterModelChange.mock.calls[0]![0]).toEqual({
      type: 'logical',
      op: 'and',
      filters: [{ type: 'comparison', columnId: 'age', op: 'lt', value: '5' }],
    });
    b.grid.destroy();
    document.body.removeChild(b.host);
  });
});

describe('Filter panel — clear', () => {
  it('Clear resets drafts and fires null', () => {
    const b = build();
    setOp(b.host, 'name', 'contains');
    setVal(b.host, 'name', 'x');
    applyBtn(b.host).click();
    b.onFilterModelChange.mockClear();
    clearBtn(b.host).click();
    expect(b.onFilterModelChange).toHaveBeenCalledTimes(1);
    expect(b.onFilterModelChange.mock.calls[0]![0]).toBeNull();
    // after clear, the op reset to none
    expect(opSelect(b.host, 'name').value).toBe('none');
    b.grid.destroy();
    document.body.removeChild(b.host);
  });
});

describe('Filter panel — teardown', () => {
  it('destroy removes the panel from the host', () => {
    const b = build();
    expect(panelOf(b.host)).not.toBeNull();
    b.grid.destroy();
    expect(panelOf(b.host)).toBeNull();
    expect(b.host.children.length).toBe(0);
    document.body.removeChild(b.host);
  });
});
