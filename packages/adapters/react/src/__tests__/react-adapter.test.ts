import { describe, expect, it } from 'vitest';
import {
  createSelectionCheckboxColumn,
  createReactCellRenderer,
} from '../index';

describe('createSelectionCheckboxColumn', () => {
  it('returns a column def with a renderer and a default id', () => {
    const checked = new Set<number>();
    const column = createSelectionCheckboxColumn({
      checkedRows: checked,
      onChange: () => undefined,
    });
    expect(column.id).toBe('__onegrid_select__');
    expect(column.width).toBe(36);
    expect(column.renderer).toBeDefined();
  });

  it('honours width and id overrides', () => {
    const column = createSelectionCheckboxColumn({
      checkedRows: new Set(),
      onChange: () => undefined,
      width: 48,
      id: 'pick',
    });
    expect(column.id).toBe('pick');
    expect(column.width).toBe(48);
  });
});

describe('createReactCellRenderer', () => {
  it('exposes the renderer id the pool keys on', () => {
    const renderer = createReactCellRenderer({
      id: 'status-pill',
      component: () => null,
    });
    expect(renderer.id).toBe('status-pill');
    expect(typeof renderer.mount).toBe('function');
  });
});

describe('ColumnToolPanel export', () => {
  it('is a function component', async () => {
    const { ColumnToolPanel } = await import('../column-tool-panel');
    expect(typeof ColumnToolPanel).toBe('function');
  });
});
