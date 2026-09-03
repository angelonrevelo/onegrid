import { describe, expect, it, vi } from 'vitest';
import { createTable, defineView, type View } from '../index.js';
import type { RowDiff } from '@onegrid/protocol';

interface Sale extends Record<string, unknown> {
  id: number;
  region: string;
  channel: string;
  amount: number;
}

const sale = (id: number, region: string, channel: string, amount: number): Sale => ({
  id,
  region,
  channel,
  amount,
});

const baseRow: Sale[] = [
  sale(1, 'EMEA', 'web', 10),
  sale(2, 'EMEA', 'retail', 20),
  sale(3, 'AMER', 'web', 30),
  sale(4, 'AMER', 'retail', 40),
];

const cellOf = (view: View, columnId: string): unknown[] =>
  Array.from({ length: view.numRows }, (_, i) => view.getCell(i, columnId));

const rowFor = (view: View, key: string): Record<string, unknown> | undefined => {
  const at = view.rowKey.indexOf(key);
  return at === -1 ? undefined : (view.row[at] as Record<string, unknown>);
};

describe('createTable', () => {
  it('loads rows and reports numRows', () => {
    const table = createTable();
    table.load(baseRow);
    expect(table.numRows).toBe(4);
    expect(table.snapshot().get('1')).toEqual(baseRow[0]);
  });

  it('emits a retraction and an insertion for an update, in that order', () => {
    const table = createTable();
    table.load([sale(1, 'EMEA', 'web', 10)]);
    const seen: Array<[string, number]> = [];
    table.connect((diff) => {
      for (const e of diff.entries) seen.push([String(e.row.region), e.weight]);
    });
    table.apply({ kind: 'update', pkey: 1, fields: { region: 'AMER' } });
    expect(seen).toEqual([
      ['EMEA', -1],
      ['AMER', 1],
    ]);
  });

  it('merges a partial update over the cached row', () => {
    const table = createTable();
    table.load([sale(1, 'EMEA', 'web', 10)]);
    table.apply({ kind: 'update', pkey: 1, fields: { amount: 99 } });
    expect(table.snapshot().get('1')).toEqual({ id: 1, region: 'EMEA', channel: 'web', amount: 99 });
  });

  it('ignores a delete for an unknown key', () => {
    const table = createTable();
    const sink = vi.fn();
    table.connect(sink);
    table.apply({ kind: 'delete', pkey: 404 });
    expect(sink).not.toHaveBeenCalled();
    expect(table.numRows).toBe(0);
  });

  it('honours a custom key field', () => {
    const table = createTable({ key: 'sku' });
    table.load([{ sku: 'A1', amount: 5 }]);
    expect(table.snapshot().get('A1')).toEqual({ sku: 'A1', amount: 5 });
  });
});

describe('defineView — RowSource conformance', () => {
  it('exposes numRows + getCell, the whole of core RowSource', () => {
    const table = createTable();
    table.load(baseRow);
    const view = defineView({ from: table });
    // Structural conformance to `@onegrid/core`'s RowSource. Assigning to the
    // shape is the test — if core ever widens it, this stops compiling.
    const asRowSource: { numRows: number; getCell: (r: number, c: string) => unknown } = view;
    expect(asRowSource.numRows).toBe(4);
    expect(asRowSource.getCell(0, 'region')).toBe('EMEA');
    expect(asRowSource.getCell(99, 'region')).toBeUndefined();
    expect(asRowSource.getCell(0, 'nope')).toBeUndefined();
  });

  it('backfills from a source that already holds rows', () => {
    const table = createTable();
    table.load(baseRow);
    const view = defineView({ from: table, where: (r) => Number(r.amount) >= 20 });
    expect(view.numRows).toBe(3);
    expect(cellOf(view, 'id')).toEqual([2, 3, 4]);
  });

  it('tracks a source that is empty at definition time', () => {
    const table = createTable();
    const view = defineView({ from: table });
    expect(view.numRows).toBe(0);
    table.load(baseRow);
    expect(view.numRows).toBe(4);
  });

  it('rejects agg without groupBy', () => {
    const table = createTable();
    expect(() =>
      defineView({ from: table, agg: [{ out: 'total', src: 'amount', kind: 'sum' }] }),
    ).toThrow(/groupBy/);
  });
});

describe('defineView — where', () => {
  it('drops rows that fail the predicate and admits ones that start passing', () => {
    const table = createTable();
    table.load(baseRow);
    const view = defineView({ from: table, where: (r) => r.region === 'EMEA' });
    expect(cellOf(view, 'id')).toEqual([1, 2]);
    table.apply({ kind: 'update', pkey: 3, fields: { region: 'EMEA' } });
    expect(cellOf(view, 'id')).toEqual([1, 2, 3]);
  });

  it('removes a row that stops passing the predicate', () => {
    const table = createTable();
    table.load(baseRow);
    const view = defineView({ from: table, where: (r) => r.region === 'EMEA' });
    table.apply({ kind: 'update', pkey: 1, fields: { region: 'APAC' } });
    expect(cellOf(view, 'id')).toEqual([2]);
  });

  it('keeps row order stable across an in-place update', () => {
    const table = createTable();
    table.load(baseRow);
    const view = defineView({ from: table });
    table.apply({ kind: 'update', pkey: 1, fields: { amount: 111 } });
    expect(cellOf(view, 'id')).toEqual([1, 2, 3, 4]);
    expect(view.getCell(0, 'amount')).toBe(111);
  });

  it('closes the gap when a row in the middle is deleted', () => {
    const table = createTable();
    table.load(baseRow);
    const view = defineView({ from: table });
    table.apply({ kind: 'delete', pkey: 2 });
    expect(cellOf(view, 'id')).toEqual([1, 3, 4]);
    expect(view.numRows).toBe(3);
  });
});

describe('defineView — groupBy + agg', () => {
  const build = () => {
    const table = createTable();
    table.load(baseRow);
    const view = defineView({
      from: table,
      groupBy: ['region'],
      agg: [
        { out: 'total', src: 'amount', kind: 'sum' },
        { out: 'n', kind: 'count' },
        { out: 'mean', src: 'amount', kind: 'avg' },
      ],
    });
    return { table, view };
  };

  it('materializes one row per group with its aggregates', () => {
    const { view } = build();
    expect(view.numRows).toBe(2);
    expect(rowFor(view, 'EMEA')).toMatchObject({ region: 'EMEA', total: 30, n: 2, mean: 15 });
    expect(rowFor(view, 'AMER')).toMatchObject({ region: 'AMER', total: 70, n: 2, mean: 35 });
  });

  it('updates the aggregate in place when a member row changes', () => {
    const { table, view } = build();
    table.apply({ kind: 'update', pkey: 1, fields: { amount: 100 } });
    expect(rowFor(view, 'EMEA')).toMatchObject({ total: 120, n: 2, mean: 60 });
    expect(view.numRows).toBe(2);
  });

  it('moves a row between groups as -1 on the old group and +1 on the new', () => {
    const { table, view } = build();
    table.apply({ kind: 'update', pkey: 1, fields: { region: 'AMER' } });
    expect(rowFor(view, 'EMEA')).toMatchObject({ total: 20, n: 1 });
    expect(rowFor(view, 'AMER')).toMatchObject({ total: 80, n: 3 });
    expect(view.numRows).toBe(2);
  });

  it('drops the group entirely when its last member leaves', () => {
    const { table, view } = build();
    table.apply({ kind: 'delete', pkey: 1 });
    table.apply({ kind: 'delete', pkey: 2 });
    expect(view.rowKey).toEqual(['AMER']);
    expect(rowFor(view, 'EMEA')).toBeUndefined();
    expect(view.numRows).toBe(1);
  });

  it('drops the group when its last member MOVES to another group', () => {
    const table = createTable();
    table.load([sale(1, 'EMEA', 'web', 10), sale(2, 'AMER', 'web', 30)]);
    const view = defineView({
      from: table,
      groupBy: ['region'],
      agg: [{ out: 'total', src: 'amount', kind: 'sum' }],
    });
    table.apply({ kind: 'update', pkey: 1, fields: { region: 'AMER' } });
    expect(view.rowKey).toEqual(['AMER']);
    expect(rowFor(view, 'AMER')).toMatchObject({ total: 40 });
  });

  it('re-creates a group after it has been emptied', () => {
    const { table, view } = build();
    table.apply({ kind: 'delete', pkey: 1 });
    table.apply({ kind: 'delete', pkey: 2 });
    expect(view.rowKey).toEqual(['AMER']);
    table.apply({ kind: 'insert', pkey: 9, fields: sale(9, 'EMEA', 'web', 5) });
    expect(rowFor(view, 'EMEA')).toMatchObject({ total: 5 });
    expect(view.numRows).toBe(2);
  });

  it('groups by a multi-column key', () => {
    const table = createTable();
    table.load(baseRow);
    const view = defineView({
      from: table,
      groupBy: ['region', 'channel'],
      agg: [{ out: 'total', src: 'amount', kind: 'sum' }],
    });
    expect(view.numRows).toBe(4);
    table.apply({ kind: 'update', pkey: 1, fields: { channel: 'retail' } });
    expect(view.numRows).toBe(3);
    expect(view.row.find((r) => r.region === 'EMEA' && r.channel === 'retail')).toMatchObject({
      total: 30,
    });
  });

  it('applies where before groupBy', () => {
    const table = createTable();
    table.load(baseRow);
    const view = defineView({
      from: table,
      where: (r) => r.channel === 'web',
      groupBy: ['region'],
      agg: [{ out: 'total', src: 'amount', kind: 'sum' }],
    });
    expect(rowFor(view, 'EMEA')).toMatchObject({ total: 10 });
    expect(rowFor(view, 'AMER')).toMatchObject({ total: 30 });
  });
});

describe('defineView — subscribe emits protocol RowDiffs', () => {
  it('emits insert / update / delete with monotonic versions', () => {
    const table = createTable();
    const view = defineView({ from: table });
    const seen: RowDiff[] = [];
    view.subscribe((diff) => seen.push(...diff));

    table.apply({ kind: 'insert', pkey: 1, fields: sale(1, 'EMEA', 'web', 10) });
    table.apply({ kind: 'update', pkey: 1, fields: { amount: 11 } });
    table.apply({ kind: 'delete', pkey: 1 });

    expect(seen.map((d) => d.kind)).toEqual(['insert', 'update', 'delete']);
    expect(seen.map((d) => d.version)).toEqual([1, 2, 3]);
    expect(seen.every((d) => d.pkey === '1')).toBe(true);
    expect(seen[1]?.fields).toMatchObject({ amount: 11 });
    // A delete carries no fields, exactly as the protocol specifies.
    expect(seen[2]?.fields).toBeUndefined();
  });

  it('reports a group that disappears as a delete', () => {
    const table = createTable();
    table.load([sale(1, 'EMEA', 'web', 10)]);
    const view = defineView({
      from: table,
      groupBy: ['region'],
      agg: [{ out: 'total', src: 'amount', kind: 'sum' }],
    });
    const seen: RowDiff[] = [];
    view.subscribe((diff) => seen.push(...diff));
    table.apply({ kind: 'delete', pkey: 1 });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ kind: 'delete', pkey: 'EMEA' });
  });

  it('reports a moved row as an emptied group delete plus a group update', () => {
    const table = createTable();
    table.load([sale(1, 'EMEA', 'web', 10), sale(2, 'AMER', 'web', 30)]);
    const view = defineView({
      from: table,
      groupBy: ['region'],
      agg: [{ out: 'total', src: 'amount', kind: 'sum' }],
    });
    const seen: RowDiff[] = [];
    view.subscribe((diff) => seen.push(...diff));
    table.apply({ kind: 'update', pkey: 1, fields: { region: 'AMER' } });
    expect(seen.map((d) => `${d.kind}:${String(d.pkey)}`).sort()).toEqual([
      'delete:EMEA',
      'update:AMER',
    ]);
  });

  it('stops delivering after unsubscribe and after dispose', () => {
    const table = createTable();
    const view = defineView({ from: table });
    const listener = vi.fn();
    const off = view.subscribe(listener);
    table.apply({ kind: 'insert', pkey: 1, fields: sale(1, 'EMEA', 'web', 10) });
    expect(listener).toHaveBeenCalledTimes(1);
    off();
    table.apply({ kind: 'insert', pkey: 2, fields: sale(2, 'EMEA', 'web', 10) });
    expect(listener).toHaveBeenCalledTimes(1);

    const other = vi.fn();
    view.subscribe(other);
    view.dispose();
    table.apply({ kind: 'insert', pkey: 3, fields: sale(3, 'EMEA', 'web', 10) });
    expect(other).not.toHaveBeenCalled();
  });
});

describe('defineView — incrementality', () => {
  const bigBase = (n: number): Array<Record<string, unknown>> =>
    Array.from({ length: n }, (_, i) => sale(i, i % 50 === 0 ? 'EMEA' : 'AMER', 'web', i));

  it('does work proportional to the delta, not the base', () => {
    const table = createTable();
    table.load(bigBase(10_000));
    const view = defineView({
      from: table,
      where: (r) => Number(r.amount) >= 0,
      groupBy: ['region'],
      agg: [{ out: 'total', src: 'amount', kind: 'sum' }],
    });
    expect(table.numRows).toBe(10_000);

    view.resetStat();
    table.apply({ kind: 'insert', pkey: 999_999, fields: sale(999_999, 'EMEA', 'web', 7) });

    // Two operators (filter, groupAgg), one entry each. The base has 10k rows;
    // the work is bounded by the delta, so this is a constant, not 20_000.
    expect(view.stat.operatorCallCount).toBe(2);
    expect(view.stat.rowInCount).toBeLessThanOrEqual(4);
    expect(view.stat.rowOutCount).toBeLessThanOrEqual(4);
  });

  it('keeps a between-group move at delta cost too', () => {
    const table = createTable();
    table.load(bigBase(10_000));
    const view = defineView({
      from: table,
      groupBy: ['region'],
      agg: [{ out: 'total', src: 'amount', kind: 'sum' }],
    });
    const before = Number(rowFor(view, 'EMEA')?.total);

    view.resetStat();
    // Row 50 is an EMEA row carrying amount 50; moving it must debit EMEA and
    // credit AMER by exactly that much.
    table.apply({ kind: 'update', pkey: 50, fields: { region: 'AMER' } });

    // One operator, one retract + one insert.
    expect(view.stat.operatorCallCount).toBe(1);
    expect(view.stat.rowInCount).toBe(2);
    expect(Number(rowFor(view, 'EMEA')?.total)).toBe(before - 50);
    expect(view.numRows).toBe(2);
  });

  it('recomputes the aggregate correctly despite never rescanning the base', () => {
    const table = createTable();
    table.load(bigBase(1_000));
    const view = defineView({
      from: table,
      groupBy: ['channel'],
      agg: [
        { out: 'total', src: 'amount', kind: 'sum' },
        { out: 'n', kind: 'count' },
      ],
    });
    const expected = (999 * 1000) / 2;
    expect(rowFor(view, 'web')).toMatchObject({ total: expected, n: 1000 });
    table.apply({ kind: 'delete', pkey: 999 });
    expect(rowFor(view, 'web')).toMatchObject({ total: expected - 999, n: 999 });
  });
});

describe('defineView — composability', () => {
  it('defines a view over another view and propagates transitively', () => {
    const table = createTable();
    table.load(baseRow);
    const web = defineView({ from: table, where: (r) => r.channel === 'web' });
    const byRegion = defineView({
      from: web,
      groupBy: ['region'],
      agg: [{ out: 'total', src: 'amount', kind: 'sum' }],
    });
    expect(byRegion.numRows).toBe(2);
    expect(rowFor(byRegion, 'EMEA')).toMatchObject({ total: 10 });

    table.apply({ kind: 'insert', pkey: 5, fields: sale(5, 'EMEA', 'web', 90) });
    expect(rowFor(byRegion, 'EMEA')).toMatchObject({ total: 100 });

    // A change filtered out upstream never reaches the downstream view.
    byRegion.resetStat();
    table.apply({ kind: 'insert', pkey: 6, fields: sale(6, 'EMEA', 'retail', 1000) });
    expect(byRegion.stat.operatorCallCount).toBe(0);
    expect(rowFor(byRegion, 'EMEA')).toMatchObject({ total: 100 });
  });

  it('propagates a between-group move through two view levels', () => {
    const table = createTable();
    table.load(baseRow);
    const positive = defineView({ from: table, where: (r) => Number(r.amount) > 0 });
    const byRegion = defineView({
      from: positive,
      groupBy: ['region'],
      agg: [{ out: 'total', src: 'amount', kind: 'sum' }],
    });
    table.apply({ kind: 'update', pkey: 1, fields: { region: 'AMER' } });
    expect(rowFor(byRegion, 'EMEA')).toMatchObject({ total: 20 });
    expect(rowFor(byRegion, 'AMER')).toMatchObject({ total: 80 });
  });

  it('propagates a group disappearing to a third level', () => {
    const table = createTable();
    table.load([sale(1, 'EMEA', 'web', 10), sale(2, 'AMER', 'web', 30)]);
    const level1 = defineView({ from: table, where: (r) => Number(r.amount) > 0 });
    const level2 = defineView({
      from: level1,
      groupBy: ['region'],
      agg: [{ out: 'total', src: 'amount', kind: 'sum' }],
    });
    const level3 = defineView({ from: level2, where: (r) => Number(r.total) > 20 });
    expect(level3.rowKey).toEqual(['AMER']);
    table.apply({ kind: 'delete', pkey: 2 });
    expect(level3.numRows).toBe(0);
    table.apply({ kind: 'update', pkey: 1, fields: { amount: 50 } });
    expect(level3.rowKey).toEqual(['EMEA']);
    expect(rowFor(level3, 'EMEA')).toMatchObject({ total: 50 });
  });

  it('lets a downstream view subscribe to row-diffs of its own', () => {
    const table = createTable();
    const level1 = defineView({ from: table });
    const level2 = defineView({ from: level1, where: (r) => Number(r.amount) > 5 });
    const seen: RowDiff[] = [];
    level2.subscribe((diff) => seen.push(...diff));
    table.apply({ kind: 'insert', pkey: 1, fields: sale(1, 'EMEA', 'web', 1) });
    expect(seen).toHaveLength(0);
    table.apply({ kind: 'update', pkey: 1, fields: { amount: 10 } });
    expect(seen.map((d) => d.kind)).toEqual(['insert']);
  });
});
