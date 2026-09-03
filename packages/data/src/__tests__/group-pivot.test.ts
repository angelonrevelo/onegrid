import { describe, expect, it } from 'vitest';
import { createColumnTable, type ColumnInput, type ColumnTable } from '../column-table';
import { registerAggregator } from '../aggregate';
import { flattenGroupPivot, groupPivot } from '../group-pivot';
import { pathKey } from '../group';

// Six rows across two regions × two countries, pivoted by quarter × channel.
// Deliberately UNEVEN: EMEA/FR has a single high-revenue row so an
// average-of-averages rollup produces a visibly different number to the
// correct sum/count rollup.
const region: ColumnInput = {
  schema: { id: 'region', type: 'utf8' },
  data: ['EMEA', 'EMEA', 'EMEA', 'AMER', 'AMER', 'EMEA'],
};
const country: ColumnInput = {
  schema: { id: 'country', type: 'utf8' },
  data: ['DE', 'DE', 'DE', 'US', 'US', 'FR'],
};
const quarter: ColumnInput = {
  schema: { id: 'quarter', type: 'utf8' },
  data: ['Q1', 'Q1', 'Q2', 'Q1', 'Q2', 'Q1'],
};
const channel: ColumnInput = {
  schema: { id: 'channel', type: 'utf8' },
  data: ['web', 'web', 'web', 'retail', 'retail', 'web'],
};
const revenue: ColumnInput = {
  schema: { id: 'revenue', type: 'float64' },
  data: new Float64Array([10, 20, 30, 40, 50, 300]),
};
const rep: ColumnInput = {
  schema: { id: 'rep', type: 'utf8' },
  data: ['ann', 'ann', 'bob', 'cat', 'cat', 'dee'],
};

const table = (): ColumnTable =>
  createColumnTable([region, country, quarter, channel, revenue, rep]);

const cell = (t: ColumnTable, rowIndex: number, columnId: string): unknown =>
  t.column(columnId).get(rowIndex);

describe('groupPivot — shape', () => {
  it('returns a plain ColumnTable carrying group columns then measure columns', () => {
    const out = groupPivot({
      table: table(),
      groupBy: ['region'],
      pivotBy: ['quarter'],
      measure: [{ fn: 'sum', columnId: 'revenue', alias: 'rev' }],
    });
    expect(out.table.hasColumn('region')).toBe(true);
    expect(out.pivotColumn.map((c) => c.id)).toEqual(['rev__Q1', 'rev__Q2']);
    // Group columns come first, measure columns after, in pivotColumn order.
    expect(out.table.schema.map((s) => s.id)).toEqual(['region', 'rev__Q1', 'rev__Q2']);
  });

  it('emits one row per group node plus a grand total, in DFS pre-order', () => {
    const out = groupPivot({
      table: table(),
      groupBy: ['region', 'country'],
      pivotBy: ['quarter'],
      measure: [{ fn: 'sum', columnId: 'revenue', alias: 'rev' }],
    });
    // AMER, AMER/US, EMEA, EMEA/DE, EMEA/FR, grand total.
    expect(out.row.map((r) => `${String(r.key)}@${r.depth}`)).toEqual([
      'AMER@0',
      'US@1',
      'EMEA@0',
      'DE@1',
      'FR@1',
      'Total@-1',
    ]);
    expect(out.table.numRows).toBe(6);
  });

  it('nulls the deeper group columns on a subtotal row', () => {
    const out = groupPivot({
      table: table(),
      groupBy: ['region', 'country'],
      pivotBy: ['quarter'],
      measure: [{ fn: 'sum', columnId: 'revenue' }],
    });
    const subtotal = out.row.find((r) => r.key === 'EMEA')!;
    expect(cell(out.table, subtotal.rowIndex, 'region')).toBe('EMEA');
    expect(cell(out.table, subtotal.rowIndex, 'country')).toBeNull();
    const leaf = out.row.find((r) => r.key === 'DE')!;
    expect(cell(out.table, leaf.rowIndex, 'country')).toBe('DE');
  });

  it('supports arbitrary group depth', () => {
    const out = groupPivot({
      table: table(),
      groupBy: ['region', 'country', 'rep'],
      pivotBy: ['quarter'],
      measure: [{ fn: 'sum', columnId: 'revenue' }],
    });
    const depth = out.row.filter((r) => r.kind === 'group').map((r) => r.depth);
    expect(Math.max(...depth)).toBe(2);
    const deepest = out.row.filter((r) => r.depth === 2);
    expect(deepest.map((r) => r.key).sort()).toEqual(['ann', 'bob', 'cat', 'dee']);
    expect(deepest.every((r) => r.isLeafLevel)).toBe(true);
  });

  it('supports arbitrary pivot-key depth and builds a hierarchical header tree', () => {
    const out = groupPivot({
      table: table(),
      groupBy: ['region'],
      pivotBy: ['quarter', 'channel'],
      measure: [{ fn: 'sum', columnId: 'revenue', alias: 'rev' }],
    });
    // Q1 splits into retail + web; Q2 splits into retail + web.
    expect(out.columnTree.map((n) => n.key)).toEqual(['Q1', 'Q2']);
    expect(out.columnTree[0]!.leafCount).toBe(2);
    expect(out.columnTree[0]!.child.map((n) => n.key)).toEqual(['retail', 'web']);
    const leafNode = out.columnTree[0]!.child[0]!.child[0]!;
    expect(leafNode.leafId).toBe('rev__Q1|retail');
    expect(leafNode.measure?.alias).toBe('rev');
  });

  it('gives each (pivotKey × measure) pair its own column', () => {
    const out = groupPivot({
      table: table(),
      groupBy: ['region'],
      pivotBy: ['quarter'],
      measure: [
        { fn: 'sum', columnId: 'revenue', alias: 'rev' },
        { fn: 'count', columnId: 'revenue', alias: 'n' },
      ],
    });
    expect(out.pivotColumn.map((c) => c.id)).toEqual([
      'rev__Q1',
      'n__Q1',
      'rev__Q2',
      'n__Q2',
    ]);
    expect(out.columnTree[0]!.leafCount).toBe(2);
  });

  it('allows an empty pivotBy — one column per measure', () => {
    const out = groupPivot({
      table: table(),
      groupBy: ['region'],
      pivotBy: [],
      measure: [{ fn: 'sum', columnId: 'revenue', alias: 'rev' }],
    });
    expect(out.pivotColumn.map((c) => c.id)).toEqual(['rev']);
    const emea = out.row.find((r) => r.key === 'EMEA')!;
    expect(cell(out.table, emea.rowIndex, 'rev')).toBe(360);
  });

  it('defaults the measure column id to `${fn}_${columnId}` without an alias', () => {
    const out = groupPivot({
      table: table(),
      groupBy: ['region'],
      pivotBy: ['quarter'],
      measure: [{ fn: 'sum', columnId: 'revenue' }],
    });
    expect(out.pivotColumn.map((c) => c.id)).toEqual([
      'sum_revenue__Q1',
      'sum_revenue__Q2',
    ]);
  });

  it('rejects an empty groupBy, an empty measure, and an unknown column', () => {
    const t = table();
    expect(() =>
      groupPivot({ table: t, groupBy: [], pivotBy: [], measure: [{ fn: 'sum', columnId: 'revenue' }] }),
    ).toThrow(/groupBy/);
    expect(() => groupPivot({ table: t, groupBy: ['region'], pivotBy: [], measure: [] })).toThrow(
      /measure/,
    );
    expect(() =>
      groupPivot({
        table: t,
        groupBy: ['nope'],
        pivotBy: [],
        measure: [{ fn: 'sum', columnId: 'revenue' }],
      }),
    ).toThrow(/unknown column/);
  });
});

describe('groupPivot — values', () => {
  it('computes leaf-level pivoted measures', () => {
    const out = groupPivot({
      table: table(),
      groupBy: ['region', 'country'],
      pivotBy: ['quarter'],
      measure: [{ fn: 'sum', columnId: 'revenue', alias: 'rev' }],
    });
    const de = out.row.find((r) => r.key === 'DE')!;
    expect(cell(out.table, de.rowIndex, 'rev__Q1')).toBe(30);
    expect(cell(out.table, de.rowIndex, 'rev__Q2')).toBe(30);
    const us = out.row.find((r) => r.key === 'US')!;
    expect(cell(out.table, us.rowIndex, 'rev__Q1')).toBe(40);
  });

  it('sums subtotals at every level and a grand total', () => {
    const out = groupPivot({
      table: table(),
      groupBy: ['region', 'country'],
      pivotBy: ['quarter'],
      measure: [{ fn: 'sum', columnId: 'revenue', alias: 'rev' }],
    });
    const emea = out.row.find((r) => r.key === 'EMEA' && r.depth === 0)!;
    expect(cell(out.table, emea.rowIndex, 'rev__Q1')).toBe(330); // 10 + 20 + 300
    expect(cell(out.table, emea.rowIndex, 'rev__Q2')).toBe(30);
    const total = out.row.find((r) => r.kind === 'grandTotal')!;
    expect(cell(out.table, total.rowIndex, 'rev__Q1')).toBe(370);
    expect(cell(out.table, total.rowIndex, 'rev__Q2')).toBe(80);
  });

  it('recomputes avg from sum + count rather than averaging child averages', () => {
    const out = groupPivot({
      table: table(),
      groupBy: ['region', 'country'],
      pivotBy: ['quarter'],
      measure: [{ fn: 'avg', columnId: 'revenue', alias: 'avgRev' }],
    });
    const de = out.row.find((r) => r.key === 'DE')!;
    const fr = out.row.find((r) => r.key === 'FR')!;
    expect(cell(out.table, de.rowIndex, 'avgRev__Q1')).toBe(15); // (10+20)/2
    expect(cell(out.table, fr.rowIndex, 'avgRev__Q1')).toBe(300);
    const emea = out.row.find((r) => r.key === 'EMEA' && r.depth === 0)!;
    // Correct: (10 + 20 + 300) / 3 = 110.
    expect(cell(out.table, emea.rowIndex, 'avgRev__Q1')).toBe(110);
    // The naive average-of-averages would be (15 + 300) / 2 = 157.5.
    expect(cell(out.table, emea.rowIndex, 'avgRev__Q1')).not.toBe(157.5);
  });

  it('keeps avg correct at the grand total across three grouping levels', () => {
    const out = groupPivot({
      table: table(),
      groupBy: ['region', 'country', 'rep'],
      pivotBy: [],
      measure: [{ fn: 'avg', columnId: 'revenue', alias: 'avgRev' }],
    });
    const total = out.row.find((r) => r.kind === 'grandTotal')!;
    expect(cell(out.table, total.rowIndex, 'avgRev')).toBeCloseTo(450 / 6, 10);
  });

  it('rolls count, min and max up exactly', () => {
    const out = groupPivot({
      table: table(),
      groupBy: ['region'],
      pivotBy: [],
      measure: [
        { fn: 'count', columnId: 'revenue', alias: 'n' },
        { fn: 'min', columnId: 'revenue', alias: 'lo' },
        { fn: 'max', columnId: 'revenue', alias: 'hi' },
      ],
    });
    const total = out.row.find((r) => r.kind === 'grandTotal')!;
    expect(cell(out.table, total.rowIndex, 'n')).toBe(6);
    expect(cell(out.table, total.rowIndex, 'lo')).toBe(10);
    expect(cell(out.table, total.rowIndex, 'hi')).toBe(300);
  });

  it('yields null for a sparse (group, pivotKey) cell instead of skipping it', () => {
    const out = groupPivot({
      table: table(),
      groupBy: ['region', 'country'],
      pivotBy: ['quarter'],
      measure: [{ fn: 'sum', columnId: 'revenue', alias: 'rev' }],
    });
    const fr = out.row.find((r) => r.key === 'FR')!;
    // FR has a Q1 row and no Q2 row — the Q2 column still exists and is null.
    expect(out.table.hasColumn('rev__Q2')).toBe(true);
    expect(cell(out.table, fr.rowIndex, 'rev__Q2')).toBeNull();
    expect(out.table.column('rev__Q2').isNull(fr.rowIndex)).toBe(true);
    // Every row carries every measure column — no misalignment.
    for (const r of out.row) {
      for (const c of out.pivotColumn) {
        expect(out.table.hasColumn(c.id)).toBe(true);
        expect(out.table.column(c.id).length).toBe(out.table.numRows);
        expect(r.rowIndex).toBeLessThan(out.table.numRows);
      }
    }
  });

  it('reports a sparse count cell as null, not zero', () => {
    const out = groupPivot({
      table: table(),
      groupBy: ['country'],
      pivotBy: ['quarter'],
      measure: [{ fn: 'count', columnId: 'revenue', alias: 'n' }],
    });
    const fr = out.row.find((r) => r.key === 'FR')!;
    expect(cell(out.table, fr.rowIndex, 'n__Q2')).toBeNull();
    expect(cell(out.table, fr.rowIndex, 'n__Q1')).toBe(1);
  });

  it('honours rowFilter and drops the excluded rows from every level', () => {
    const out = groupPivot({
      table: table(),
      groupBy: ['region'],
      pivotBy: [],
      measure: [{ fn: 'sum', columnId: 'revenue', alias: 'rev' }],
      option: { rowFilter: (i) => i < 3 },
    });
    expect(out.row.filter((r) => r.kind === 'group').map((r) => r.key)).toEqual(['EMEA']);
    const total = out.row.find((r) => r.kind === 'grandTotal')!;
    expect(cell(out.table, total.rowIndex, 'rev')).toBe(60);
  });

  it('omits the grand-total row when asked', () => {
    const out = groupPivot({
      table: table(),
      groupBy: ['region'],
      pivotBy: [],
      measure: [{ fn: 'sum', columnId: 'revenue' }],
      option: { grandTotal: false },
    });
    expect(out.row.some((r) => r.kind === 'grandTotal')).toBe(false);
    expect(out.table.numRows).toBe(2);
  });

  it('buckets null group keys and null pivot keys rather than dropping them', () => {
    const t = createColumnTable([
      { schema: { id: 'g', type: 'utf8' }, data: ['a', null, 'a'] },
      { schema: { id: 'p', type: 'utf8' }, data: ['x', 'x', null] },
      { schema: { id: 'v', type: 'float64' }, data: new Float64Array([1, 2, 4]) },
    ]);
    const out = groupPivot({
      table: t,
      groupBy: ['g'],
      pivotBy: ['p'],
      measure: [{ fn: 'sum', columnId: 'v', alias: 'v' }],
    });
    // Null group keys sort last; null pivot keys sort last too.
    expect(out.row.filter((r) => r.kind === 'group').map((r) => r.key)).toEqual(['a', null]);
    expect(out.pivotColumn.map((c) => c.id)).toEqual(['v__x', 'v__∅']);
    const total = out.row.find((r) => r.kind === 'grandTotal')!;
    expect(cell(out.table, total.rowIndex, 'v__x')).toBe(3);
    expect(cell(out.table, total.rowIndex, 'v__∅')).toBe(4);
  });
});

describe('groupPivot — non-decomposable aggregations', () => {
  it('recomputes countDistinct at every level instead of summing child counts', () => {
    const out = groupPivot({
      table: table(),
      groupBy: ['region', 'country'],
      pivotBy: [],
      measure: [{ fn: 'countDistinct', columnId: 'quarter', alias: 'q' }],
    });
    const de = out.row.find((r) => r.key === 'DE')!;
    const fr = out.row.find((r) => r.key === 'FR')!;
    expect(cell(out.table, de.rowIndex, 'q')).toBe(2); // Q1, Q2
    expect(cell(out.table, fr.rowIndex, 'q')).toBe(1); // Q1
    const emea = out.row.find((r) => r.key === 'EMEA' && r.depth === 0)!;
    // Summing children would give 3; the true distinct count is 2.
    expect(cell(out.table, emea.rowIndex, 'q')).toBe(2);
    expect(out.unavailableColumn).toEqual([]);
  });

  it('reports non-decomposable subtotals as unavailable when asked', () => {
    const out = groupPivot({
      table: table(),
      groupBy: ['region', 'country'],
      pivotBy: [],
      measure: [
        { fn: 'countDistinct', columnId: 'quarter', alias: 'q' },
        { fn: 'sum', columnId: 'revenue', alias: 'rev' },
      ],
      option: { nonDecomposableRollup: 'unavailable' },
    });
    expect(out.unavailableColumn).toEqual(['q']);
    const de = out.row.find((r) => r.key === 'DE')!;
    expect(cell(out.table, de.rowIndex, 'q')).toBe(2); // leaf level is exact
    const emea = out.row.find((r) => r.key === 'EMEA' && r.depth === 0)!;
    expect(cell(out.table, emea.rowIndex, 'q')).toBeNull();
    // Decomposable measures alongside it are unaffected.
    expect(cell(out.table, emea.rowIndex, 'rev')).toBe(360);
    expect(out.pivotColumn.find((c) => c.id === 'q')!.decomposable).toBe(false);
    expect(out.pivotColumn.find((c) => c.id === 'rev')!.decomposable).toBe(true);
  });

  it('recomputes a custom (median) aggregator at every level', () => {
    registerAggregator('gpMedian', () => (column, rowIndex) => {
      const value: number[] = [];
      const iterable =
        rowIndex ?? Array.from({ length: column.length }, (_, i) => i);
      for (const i of iterable) {
        if (!column.isNull(i)) value.push(Number(column.get(i)));
      }
      if (value.length === 0) return null;
      value.sort((a, b) => a - b);
      const mid = value.length >> 1;
      return value.length % 2 === 1 ? value[mid]! : (value[mid - 1]! + value[mid]!) / 2;
    });
    const out = groupPivot({
      table: table(),
      groupBy: ['region', 'country'],
      pivotBy: [],
      measure: [{ fn: 'gpMedian', columnId: 'revenue', alias: 'med' }],
    });
    const de = out.row.find((r) => r.key === 'DE')!;
    expect(cell(out.table, de.rowIndex, 'med')).toBe(20); // 10, 20, 30
    const emea = out.row.find((r) => r.key === 'EMEA' && r.depth === 0)!;
    // 10, 20, 30, 300 → (20 + 30) / 2 = 25. A median of medians would say 160.
    expect(cell(out.table, emea.rowIndex, 'med')).toBe(25);
    const total = out.row.find((r) => r.kind === 'grandTotal')!;
    // 10, 20, 30, 40, 50, 300 → (30 + 40) / 2 = 35.
    expect(cell(out.table, total.rowIndex, 'med')).toBe(35);
  });

  it('leaves a sparse non-decomposable cell null', () => {
    const out = groupPivot({
      table: table(),
      groupBy: ['country'],
      pivotBy: ['quarter'],
      measure: [{ fn: 'countDistinct', columnId: 'rep', alias: 'rep' }],
    });
    const fr = out.row.find((r) => r.key === 'FR')!;
    expect(cell(out.table, fr.rowIndex, 'rep__Q2')).toBeNull();
    expect(cell(out.table, fr.rowIndex, 'rep__Q1')).toBe(1);
  });
});

describe('flattenGroupPivot', () => {
  const build = () =>
    groupPivot({
      table: table(),
      groupBy: ['region', 'country'],
      pivotBy: ['quarter'],
      measure: [{ fn: 'sum', columnId: 'revenue', alias: 'rev' }],
    });

  it('emits only top-level groups plus the grand total when nothing is open', () => {
    const out = build();
    const flat = flattenGroupPivot(out, new Set());
    expect(flat.map((e) => e.data.key)).toEqual(['AMER', 'EMEA', 'Total']);
    expect(flat.every((e) => e.depth === 0)).toBe(true);
    expect(flat[0]!.hasChildren).toBe(true);
    expect(flat[0]!.expanded).toBe(false);
  });

  it('expands a group by its pathKey id and reports depth like flattenTree', () => {
    const out = build();
    const flat = flattenGroupPivot(out, new Set([pathKey(['EMEA'])]));
    expect(flat.map((e) => e.data.key)).toEqual(['AMER', 'EMEA', 'DE', 'FR', 'Total']);
    expect(flat.map((e) => e.depth)).toEqual([0, 0, 1, 1, 0]);
    expect(flat[1]!.expanded).toBe(true);
    expect(flat[2]!.isLeaf).toBe(true);
    expect(flat[2]!.hasChildren).toBe(false);
  });

  it('uses the row id as the tree node id so meta and tree agree', () => {
    const out = build();
    const flat = flattenGroupPivot(out, new Set([pathKey(['EMEA'])]));
    for (const entry of flat) {
      expect(entry.id).toBe(entry.data.id);
      expect(out.row[entry.data.rowIndex]).toBe(entry.data);
    }
  });

  it('keeps the grand total outside the group hierarchy', () => {
    const out = build();
    const flat = flattenGroupPivot(out, new Set([pathKey(['EMEA']), pathKey(['AMER'])]));
    const last = flat[flat.length - 1]!;
    expect(last.data.kind).toBe('grandTotal');
    expect(last.depth).toBe(0);
    expect(last.isLeaf).toBe(true);
  });
});
