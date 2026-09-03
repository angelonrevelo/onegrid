import { describe, expect, it } from 'vitest';
import { createColumnTable, type ColumnInput } from '../column-table';
import { flattenGroupTree, groupRows, pathKey } from '../group';

const regionCol: ColumnInput = {
  schema: { id: 'region', type: 'utf8' },
  data: ['EMEA', 'AMER', 'EMEA', 'APAC', 'AMER', 'EMEA'],
};

const productCol: ColumnInput = {
  schema: { id: 'product', type: 'utf8' },
  data: ['A', 'A', 'B', 'A', 'B', 'A'],
};

const revenueCol: ColumnInput = {
  schema: { id: 'revenue', type: 'int32' },
  data: new Int32Array([100, 200, 150, 50, 300, 75]),
};

describe('groupRows', () => {
  it('groups by a single column with sum aggregate', () => {
    const t = createColumnTable([regionCol, productCol, revenueCol]);
    const root = groupRows(
      t,
      { columns: ['region'], openKeys: [] },
      {
        aggregations: [{ columnId: 'revenue', fn: 'sum', alias: 'total' }],
      },
    );
    expect(root.children).toHaveLength(3);
    const totals: Record<string, unknown> = {};
    for (const c of root.children) totals[String(c.path[0])] = c.aggregates.total;
    expect(totals).toEqual({ AMER: 500, APAC: 50, EMEA: 325 });
  });

  it('groups by two columns hierarchically', () => {
    const t = createColumnTable([regionCol, productCol, revenueCol]);
    const root = groupRows(t, { columns: ['region', 'product'], openKeys: [] });
    expect(root.children.length).toBe(3);
    const emea = root.children.find((c) => c.path[0] === 'EMEA')!;
    expect(emea.children.length).toBe(2);
    expect(emea.children.map((c) => c.path[1]).sort()).toEqual(['A', 'B']);
  });

  it('row count is preserved up the tree', () => {
    const t = createColumnTable([regionCol, productCol]);
    const root = groupRows(t, { columns: ['region'], openKeys: [] });
    expect(root.rowCount).toBe(6);
    expect(root.children.reduce((sum, c) => sum + c.rowCount, 0)).toBe(6);
  });

  it('rowFilter narrows the input set', () => {
    const t = createColumnTable([regionCol, productCol]);
    const root = groupRows(t, { columns: ['region'], openKeys: [] }, {
      rowFilter: (i) => i < 3,
    });
    expect(root.rowCount).toBe(3);
  });

  it('flattenGroupTree honors openPaths', () => {
    const t = createColumnTable([regionCol, productCol, revenueCol]);
    const root = groupRows(t, { columns: ['region'], openKeys: [] });
    const closed = flattenGroupTree(root, new Set());
    expect(closed.every((e) => e.kind === 'group')).toBe(true);

    const opened = flattenGroupTree(root, new Set([pathKey(['EMEA'])]));
    const groupCount = opened.filter((e) => e.kind === 'group').length;
    const rowCount = opened.filter((e) => e.kind === 'row').length;
    expect(groupCount).toBe(3);
    expect(rowCount).toBe(3); // EMEA has 3 rows (indices 0, 2, 5)
  });

  it('pathKey is stable for equal paths', () => {
    expect(pathKey(['a', 1, null])).toBe(pathKey(['a', 1, null]));
    expect(pathKey(['a', 1])).not.toBe(pathKey(['a', 2]));
  });
});
