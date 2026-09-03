// =============================================================================
// The harness proves itself by USING itself.
//
// Every test here mounts a real `Grid` from @onegrid/core through the
// harness's own environment + mount helpers and asserts through the harness's
// own queries, waits, fakes and matchers. Nothing is mocked out: if the canvas
// stub misses a method core calls, the mount throws; if the geometry is off by
// a band, the pointer hit-tests miss and selection stays empty; if the query
// helpers misread the accessibility shadow, every value assertion fails.
//
// That is the point. A test harness whose own suite stubs the thing it is
// supposed to drive has proved nothing.
// =============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ColumnDef } from '@onegrid/core';
import {
  clickCell,
  createFakeDataSource,
  createFakeRowSource,
  doubleClickCell,
  expectGridToMatch,
  getCell,
  getCellEditor,
  getHeader,
  getHeaderText,
  getRowElement,
  installCanvasStub,
  installGridEnvironment,
  installGridMatcher,
  mountGrid,
  pasteTsv,
  pressKey,
  readGridText,
  readGridWindow,
  selectRange,
  typeIntoCell,
  waitForBlock,
  waitForIdle,
  waitForRender,
} from '../index';
import type { GridMatcher, GridTestHandle } from '../index';

declare module 'vitest' {
  // `T = any` matches vitest's own declaration of Assertion; TypeScript
  // requires every declaration of a merged interface to agree exactly.
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface Assertion<T = any> extends GridMatcher<T> {}
}

installGridMatcher(expect);

const COLUMN: ColumnDef[] = [
  { id: 'a', width: 120, displayName: 'Alpha' },
  { id: 'b', width: 120, displayName: 'Beta' },
  { id: 'c', width: 120, displayName: 'Gamma' },
];

let env: ReturnType<typeof installGridEnvironment>;
let mounted: GridTestHandle[] = [];

function mount(option: Partial<Parameters<typeof mountGrid>[0]> = {}): GridTestHandle {
  const row = createFakeRowSource({ rowCount: 200, column: ['a', 'b', 'c'] });
  const handle = mountGrid({
    columns: COLUMN,
    rowSource: row,
    rowHeight: 28,
    ...option,
  } as Parameters<typeof mountGrid>[0]);
  mounted.push(handle);
  return handle;
}

beforeEach(() => {
  env = installGridEnvironment();
});

afterEach(() => {
  for (const handle of mounted) handle.unmount();
  mounted = [];
  env.restore();
});

// -----------------------------------------------------------------------------
// Canvas stub
// -----------------------------------------------------------------------------

describe('installCanvasStub', () => {
  it('lets a real Grid mount, which jsdom alone cannot', () => {
    const handle = mount();
    expect(handle.host.querySelector('canvas')).not.toBeNull();
    expect(handle.scrollHost.getAttribute('role')).toBe('grid');
  });

  it('records the paint sequence, not just the fact that painting happened', () => {
    mount();
    const name = env.canvas.call.map((c) => c.name);
    // The renderer clears, then paints. Both must be present and in order.
    expect(name).toContain('clearRect');
    expect(name).toContain('fillRect');
    expect(name).toContain('fillText');
    expect(name.indexOf('clearRect')).toBeLessThan(name.lastIndexOf('fillText'));
  });

  it('records property assignments alongside calls so styling is assertable', () => {
    mount();
    const set = env.canvas.call.filter((c) => c.kind === 'set');
    expect(set.map((c) => c.name)).toContain('fillStyle');
    expect(set.map((c) => c.name)).toContain('font');
  });

  it('paints every visible cell value onto the canvas', () => {
    mount();
    expect(env.canvas.paintedText()).toContain('a-0');
    expect(env.canvas.paintedText()).toContain('Alpha');
  });

  it('measureText is deterministic and scales with font size', () => {
    const stub = installCanvasStub();
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d') as unknown as CanvasRenderingContext2D;
    ctx.font = '12px sans-serif';
    const small = ctx.measureText('hello').width;
    expect(ctx.measureText('hello').width).toBe(small);
    ctx.font = '24px sans-serif';
    expect(ctx.measureText('hello').width).toBe(small * 2);
    stub.restore();
  });

  it('honours a custom measureTextWidth so auto-size paths can be driven', () => {
    const stub = installCanvasStub({ measureTextWidth: (text) => text.length * 100 });
    const ctx = document
      .createElement('canvas')
      .getContext('2d') as unknown as CanvasRenderingContext2D;
    expect(ctx.measureText('abc').width).toBe(300);
    stub.restore();
  });

  it('restores the original getContext', () => {
    const before = HTMLCanvasElement.prototype.getContext;
    const stub = installCanvasStub();
    expect(HTMLCanvasElement.prototype.getContext).not.toBe(before);
    stub.restore();
    expect(HTMLCanvasElement.prototype.getContext).toBe(before);
  });
});

// -----------------------------------------------------------------------------
// Accessibility-shadow queries
// -----------------------------------------------------------------------------

describe('query helpers', () => {
  it('getCell reads the rendered text of a cell', () => {
    const handle = mount();
    expect(getCell(handle.host, 0, 0)?.textContent).toBe('a-0');
    expect(getCell(handle.host, 3, 2)?.textContent).toBe('c-3');
  });

  it('getCell resolves a column by header text as well as by index', () => {
    const handle = mount();
    expect(getCell(handle.host, 2, 'Beta')?.textContent).toBe('b-2');
    expect(getCell(handle.host, 2, 'Nope')).toBeNull();
  });

  it('getRowElement and getHeader return the right shadow nodes', () => {
    const handle = mount();
    expect(getRowElement(handle.host, 1)?.getAttribute('aria-rowindex')).toBe('3');
    expect(getHeader(handle.host, 1)?.textContent).toBe('Beta');
    expect(getHeaderText(handle.host)).toEqual(['Alpha', 'Beta', 'Gamma']);
  });

  it('readGridText returns a 2D array of what was rendered', () => {
    const handle = mount();
    const text = readGridText(handle.host);
    expect(text[0]).toEqual(['a-0', 'b-0', 'c-0']);
    expect(text[1]).toEqual(['a-1', 'b-1', 'c-1']);
    expect(text.length).toBeGreaterThan(5);
  });

  it('readGridWindow reports which dataset rows the shadow covers', () => {
    const handle = mount();
    const window = readGridWindow(handle.host);
    expect(window.firstRow).toBe(0);
    expect(window.lastRow).toBeGreaterThan(0);
    expect(window.text.length).toBe(window.lastRow - window.firstRow + 1);
  });

  it('expectGridToMatch passes on a matching sub-grid', () => {
    const handle = mount();
    expect(() => {
      expectGridToMatch(handle.host, [
        ['a-0', 'b-0'],
        ['a-1', 'b-1'],
      ]);
    }).not.toThrow();
  });

  it('expectGridToMatch fails with the offending cell AND the rendered grid', () => {
    const handle = mount();
    let message = '';
    try {
      expectGridToMatch(handle.host, [['a-0', 'WRONG']]);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('column 1');
    expect(message).toContain('"WRONG"');
    expect(message).toContain('Rendered grid:');
    expect(message).toContain('row 0: a-0 | b-0 | c-0');
  });

  it('returns null for a row outside the shadow window rather than throwing', () => {
    const handle = mount();
    expect(getCell(handle.host, 199, 0)).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// User events against the real listeners
// -----------------------------------------------------------------------------

describe('user-event helpers', () => {
  it('clickCell selects the clicked cell', () => {
    const handle = mount();
    clickCell(handle, 4, 1);
    expect(handle.grid.getSelection().active).toEqual({ row: 4, col: 1 });
    expect(handle).toHaveSelectedRange({ rowStart: 4, rowEnd: 4, colStart: 1, colEnd: 1 });
  });

  it('selectRange drags a rectangle via pointerdown/move/up', () => {
    const handle = mount();
    selectRange(handle, { row: 1, col: 0 }, { row: 3, col: 2 });
    expect(handle).toHaveSelectedRange({ rowStart: 1, rowEnd: 3, colStart: 0, colEnd: 2 });
  });

  it('pressKey moves the active cell with arrows', () => {
    const handle = mount();
    clickCell(handle, 0, 0);
    pressKey(handle, 'ArrowDown');
    pressKey(handle, 'ArrowRight');
    expect(handle.grid.getSelection().active).toEqual({ row: 1, col: 1 });
  });

  it('pressKey with shift extends the selection', () => {
    const handle = mount();
    clickCell(handle, 2, 0);
    pressKey(handle, 'ArrowDown', { shiftKey: true });
    pressKey(handle, 'ArrowRight', { shiftKey: true });
    expect(handle).toHaveSelectedRange({ rowStart: 2, rowEnd: 3, colStart: 0, colEnd: 1 });
  });

  it('pressKey routes ctrl+A to select-all', () => {
    const handle = mount();
    clickCell(handle, 0, 0);
    pressKey(handle, 'a', { ctrlKey: true });
    expect(handle).toHaveSelectedRange({ rowStart: 0, rowEnd: 199, colStart: 0, colEnd: 2 });
  });

  it('pasteTsv delivers parsed rows to onPaste at the active cell', () => {
    const onPaste = vi.fn();
    const handle = mount({ onPaste });
    clickCell(handle, 2, 1);
    pasteTsv(handle, 'x\ty\nz\tw');
    expect(onPaste).toHaveBeenCalledTimes(1);
    expect(onPaste.mock.calls[0]?.[0]).toBe(2);
    expect(onPaste.mock.calls[0]?.[1]).toBe(1);
    expect(onPaste.mock.calls[0]?.[2]).toEqual([
      ['x', 'y'],
      ['z', 'w'],
    ]);
  });

  it('doubleClickCell opens the editor on an editable cell', () => {
    const handle = mount({ editable: true });
    expect(handle.grid.isEditing()).toBe(false);
    doubleClickCell(handle, 1, 1);
    expect(handle.grid.isEditing()).toBe(true);
    expect(getCellEditor(handle)?.value).toBe('b-1');
  });

  it('doubleClickCell is inert on a non-editable grid', () => {
    const handle = mount();
    doubleClickCell(handle, 1, 1);
    expect(handle.grid.isEditing()).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// Editing end to end
// -----------------------------------------------------------------------------

describe('cell editing', () => {
  it('typeIntoCell commits through onCellEdit and the value re-renders', async () => {
    const row = createFakeRowSource({ rowCount: 50, column: ['a', 'b', 'c'] });
    const handle = mount({
      rowSource: row,
      editable: true,
      onCellEdit: (rowIndex: number, columnId: string, newValue: unknown) => {
        row.setCell(rowIndex, columnId, newValue);
        handle.grid.refresh();
      },
    });
    typeIntoCell(handle, 2, 1, 'edited');
    await waitForRender(handle.grid);
    expect(handle).toHaveGridValue(2, 1, 'edited');
    expect(handle.grid.isEditing()).toBe(false);
  });

  it('Escape cancels an edit and leaves the original value', async () => {
    const row = createFakeRowSource({ rowCount: 50, column: ['a', 'b', 'c'] });
    const handle = mount({
      rowSource: row,
      editable: true,
      onCellEdit: (rowIndex: number, columnId: string, newValue: unknown) => {
        row.setCell(rowIndex, columnId, newValue);
      },
    });
    typeIntoCell(handle, 2, 1, 'discarded', { commit: 'Escape' });
    handle.grid.refresh();
    await waitForRender(handle.grid);
    expect(handle).toHaveGridValue(2, 1, 'b-2');
  });

  it('commit: false leaves the editor open for validation assertions', () => {
    const handle = mount({ editable: true });
    const editor = typeIntoCell(handle, 0, 0, 'partial', { commit: false });
    expect(editor).not.toBeNull();
    expect(handle.grid.isEditing()).toBe(true);
    expect(editor?.value).toBe('partial');
  });

  it('type-ahead opens the editor seeded with the typed character', () => {
    const handle = mount({ editable: true });
    const editor = typeIntoCell(handle, 1, 0, 'Z', { commit: false, open: 'typeahead' });
    expect(handle.grid.isEditing()).toBe(true);
    expect(editor?.value).toBe('Z');
  });

  it('Enter commits and moves the active cell down, Excel-style', () => {
    const handle = mount({ editable: true, onCellEdit: () => undefined });
    typeIntoCell(handle, 3, 1, 'x', { commit: 'Enter' });
    expect(handle.grid.getSelection().active).toEqual({ row: 4, col: 1 });
  });

  it('typeIntoCell throws a diagnostic when the cell is not editable', () => {
    const handle = mount();
    expect(() => typeIntoCell(handle, 0, 0, 'x')).toThrow(/did not open an editor/);
  });
});

// -----------------------------------------------------------------------------
// Waits
// -----------------------------------------------------------------------------

describe('waits', () => {
  it('waitForRender resolves once the grid paints a scheduled frame', async () => {
    const handle = mount();
    const before = handle.grid.getMetricsSnapshot().frameCount;
    handle.grid.scrollToRow(50);
    await waitForRender(handle.grid);
    expect(handle.grid.getMetricsSnapshot().frameCount).toBeGreaterThan(before);
  });

  it('waitForRender explains itself when no frame ever lands', async () => {
    const never = { getMetricsSnapshot: () => ({ frameCount: 7 }) };
    await expect(waitForRender(never, { timeoutMs: 30 })).rejects.toThrow(
      /frameCount is still 7 \(was 7 when the wait started\)/,
    );
  });

  it('waitForIdle returns after the render loop stops re-arming', async () => {
    const handle = mount();
    handle.grid.scrollToRow(80);
    await waitForIdle(handle.grid, { timeoutMs: 500 });
    const settled = handle.grid.getMetricsSnapshot().frameCount;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(handle.grid.getMetricsSnapshot().frameCount).toBe(settled);
  });

  it('waitForIdle reports a grid that never stops painting', async () => {
    let frame = 0;
    const busy = { getMetricsSnapshot: () => ({ frameCount: frame++ }) };
    await expect(waitForIdle(busy, { timeoutMs: 40 })).rejects.toThrow(
      /still painting|re-arming the render loop/,
    );
  });

  it('scrolling re-anchors the shadow and the new rows are queryable', async () => {
    const handle = mount();
    handle.grid.scrollToRow(120);
    await waitForIdle(handle.grid, { timeoutMs: 500 });
    const window = readGridWindow(handle.host);
    expect(window.firstRow).toBeGreaterThan(50);
    expect(getCell(handle.host, 120, 0)?.textContent).toBe('a-120');
  });
});

// -----------------------------------------------------------------------------
// Fakes + block loading
// -----------------------------------------------------------------------------

describe('createFakeRowSource', () => {
  it('generates deterministic, cell-unique values', () => {
    const a = createFakeRowSource({ rowCount: 10, column: 3 });
    const b = createFakeRowSource({ rowCount: 10, column: 3 });
    expect(a.getCell(4, 'c1')).toBe(b.getCell(4, 'c1'));
    expect(a.getCell(4, 'c1')).not.toBe(a.getCell(4, 'c2'));
    expect(a.columnId).toEqual(['c0', 'c1', 'c2']);
  });

  it('setCell overrides a value and reset restores the generator', () => {
    const row = createFakeRowSource({ rowCount: 10, column: ['a'] });
    row.setCell(1, 'a', 'over');
    expect(row.getCell(1, 'a')).toBe('over');
    row.reset();
    expect(row.getCell(1, 'a')).toBe('a-1');
  });

  it('honours a custom value generator', () => {
    const row = createFakeRowSource({
      rowCount: 5,
      column: ['n'],
      value: (rowIndex) => rowIndex * 10,
    });
    expect(row.getCell(3, 'n')).toBe(30);
  });
});

describe('createFakeDataSource', () => {
  it('serves blocks and logs which ones were requested', async () => {
    const source = createFakeDataSource({ rowCount: 1000, column: ['a', 'b'] });
    const response = await source.fetchBlock({
      cursor: null,
      direction: 'after',
      limit: 100,
      sort: [],
      filter: null,
    });
    expect(response.encoding).toBe('json');
    expect(response.rows.length).toBe(100);
    expect((response.rows as Record<string, unknown>[])[0]).toEqual({ a: 'a-0', b: 'b-0' });
    expect(response.totalRowCount).toBe(1000);
    expect(source.call.map((c) => c.blockIndex)).toEqual([0]);
  });

  it('decodes offset cursors into block indices', async () => {
    const source = createFakeDataSource({ rowCount: 1000, column: 2 });
    await source.fetchBlock({
      cursor: 'offset:400',
      direction: 'after',
      limit: 100,
      sort: [],
      filter: null,
    });
    expect(source.call[0]?.blockIndex).toBe(4);
    expect(source.call[0]?.startRow).toBe(400);
    expect(source.hasBlock(4)).toBe(true);
  });

  it('manual mode parks fetches until flush, making loading state assertable', async () => {
    const source = createFakeDataSource({ rowCount: 100, column: 1, manual: true });
    let landed = false;
    void source
      .fetchBlock({ cursor: null, direction: 'after', limit: 50, sort: [], filter: null })
      .then(() => {
        landed = true;
      });
    await Promise.resolve();
    expect(source.pending).toEqual([0]);
    expect(landed).toBe(false);
    expect(source.hasBlock(0)).toBe(false);

    const released = await source.flush();
    expect(released).toBe(1);
    expect(landed).toBe(true);
    expect(source.pending).toEqual([]);
    expect(source.hasBlock(0)).toBe(true);
  });

  it('exposes a protocol-shaped schema', async () => {
    const source = createFakeDataSource({ rowCount: 10, column: ['x', 'y'] });
    const schema = await source.schema();
    expect(schema.map((c) => c.id)).toEqual(['x', 'y']);
    expect(schema[0]?.type).toBe('utf8');
  });

  it('reports the last block truncated to the dataset and a null nextCursor', async () => {
    const source = createFakeDataSource({ rowCount: 120, column: 1 });
    const response = await source.fetchBlock({
      cursor: 'offset:100',
      direction: 'after',
      limit: 100,
      sort: [],
      filter: null,
    });
    expect(response.rows.length).toBe(20);
    expect(response.nextCursor).toBeNull();
  });
});

describe('waitForBlock', () => {
  it('resolves once a latency-delayed block lands', async () => {
    const source = createFakeDataSource({ rowCount: 500, column: 2, latencyMs: 20 });
    void source.fetchBlock({
      cursor: 'offset:200',
      direction: 'after',
      limit: 100,
      sort: [],
      filter: null,
    });
    expect(source.hasBlock(2)).toBe(false);
    await waitForBlock(source, 2, { timeoutMs: 500 });
    expect(source.hasBlock(2)).toBe(true);
  });

  it('distinguishes "never requested" from "requested but never delivered"', async () => {
    const source = createFakeDataSource({ rowCount: 500, column: 2, manual: true });
    void source.fetchBlock({
      cursor: null,
      direction: 'after',
      limit: 100,
      sort: [],
      filter: null,
    });
    await expect(waitForBlock(source, 0, { timeoutMs: 40 })).rejects.toThrow(
      /WAS requested but never delivered.*call flush\(\)/s,
    );
    await expect(waitForBlock(source, 3, { timeoutMs: 40 })).rejects.toThrow(
      /block 3 was never requested at all/,
    );
  });

  it('failure text carries the whole request and pending log', async () => {
    const source = createFakeDataSource({ rowCount: 500, column: 2, manual: true });
    void source.fetchBlock({
      cursor: 'offset:100',
      direction: 'after',
      limit: 100,
      sort: [],
      filter: null,
    });
    let message = '';
    try {
      await waitForBlock(source, 9, { timeoutMs: 30 });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('requested blocks: [1]');
    expect(message).toContain('pending blocks: [1]');
  });
});

// -----------------------------------------------------------------------------
// Block-backed grid: the whole stack at once
// -----------------------------------------------------------------------------

describe('block-loaded grid', () => {
  it('renders placeholders, then real values once the block is flushed', async () => {
    const source = createFakeDataSource({
      rowCount: 1000,
      column: ['a', 'b', 'c'],
      manual: true,
    });
    const BLOCK = 100;
    const block = new Map<number, ReadonlyArray<Record<string, unknown>>>();
    const requested = new Set<number>();

    // A minimal block-backed RowSource: synchronous reads, async fills. This
    // is the shape @onegrid/ssrm's row source has, reduced to what the test
    // needs so the assertion is about the harness, not about ssrm.
    const rowSource = {
      numRows: 1000,
      getCell: (rowIndex: number, columnId: string): unknown => {
        const index = Math.floor(rowIndex / BLOCK);
        const loaded = block.get(index);
        if (loaded) return loaded[rowIndex % BLOCK]?.[columnId] ?? '';
        if (!requested.has(index)) {
          requested.add(index);
          void source
            .fetchBlock({
              cursor: index === 0 ? null : `offset:${String(index * BLOCK)}`,
              direction: 'after',
              limit: BLOCK,
              sort: [],
              filter: null,
            })
            .then((response) => {
              block.set(index, response.rows as ReadonlyArray<Record<string, unknown>>);
            });
        }
        return '…';
      },
    };

    const handle = mount({ rowSource });
    expect(handle).toHaveRowCount(1000);
    expect(handle).toHaveGridValue(0, 0, '…');
    expect(source.pending).toEqual([0]);

    await source.flush();
    await waitForBlock(source, 0, { timeoutMs: 500 });
    handle.grid.refresh();
    await waitForRender(handle.grid);

    expect(handle).toHaveGridValue(0, 0, 'a-0');
    expect(handle).toHaveGridValue(1, 2, 'c-1');
    expect(source.call.map((c) => c.blockIndex)).toEqual([0]);
  });
});

// -----------------------------------------------------------------------------
// Matchers
// -----------------------------------------------------------------------------

describe('matchers', () => {
  it('toHaveGridValue passes and negates', () => {
    const handle = mount();
    expect(handle).toHaveGridValue(1, 0, 'a-1');
    expect(handle).not.toHaveGridValue(1, 0, 'nope');
  });

  it('toHaveGridValue failure prints the rendered grid', () => {
    const handle = mount();
    let message = '';
    try {
      expect(handle).toHaveGridValue(1, 0, 'nope');
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('got "a-1"');
    expect(message).toContain('Rendered grid:');
  });

  it('toHaveRowCount reads the live row source', () => {
    const handle = mount();
    expect(handle).toHaveRowCount(200);
    handle.grid.setRowSource(createFakeRowSource({ rowCount: 7, column: 3 }), 28);
    expect(handle).toHaveRowCount(7);
  });

  it('toHaveSelectedRange reports the actual ranges on failure', () => {
    const handle = mount();
    clickCell(handle, 1, 1);
    let message = '';
    try {
      expect(handle).toHaveSelectedRange({ rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('rows 1..1 × cols 1..1');
    expect(message).toContain('Active cell: (1, 1)');
  });

  it('matchers reject anything that is not a mountGrid handle', () => {
    expect(() => expect({}).toHaveRowCount(1)).toThrow(/expects the handle returned by mountGrid/);
  });
});
