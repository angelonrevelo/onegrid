// =============================================================================
// BigQuery SQL compiler — unit tests.
//
// Every assertion checks the SQL text, the parameter map AND the
// declared parameter types together: BigQuery rejects an untyped
// parameter outright, so a compiler that emitted the right SQL with
// the wrong type declaration would fail at job submission.
// =============================================================================

import { describe, expect, it } from 'vitest';
import type { BlockRequest } from '@onegrid/protocol';
import {
  compileBlockQuery,
  decodeKeysetCursor,
  encodeKeysetCursor,
  isKeysetCursor,
  isLegacyOffsetCursor,
  orderByPruningValue,
  quoteTable,
  type BqTableDescriptor,
} from '../sql';

const TABLE: BqTableDescriptor = {
  project: 'acme-analytics',
  dataset: 'warehouse',
  table: 'order',
  columns: ['id', 'status', 'amount', 'event_date', 'customer_id'],
  primaryKey: 'id',
  columnType: {
    id: 'INT64',
    status: 'STRING',
    amount: 'NUMERIC',
    event_date: 'DATE',
    customer_id: 'INT64',
  },
  partitionColumn: 'event_date',
  clusterColumn: ['customer_id', 'status'],
};

function req(override: Partial<BlockRequest> = {}): BlockRequest {
  return {
    cursor: null,
    direction: 'after',
    limit: 100,
    sort: [],
    filter: null,
    ...override,
  };
}

describe('identifiers', () => {
  it('addresses the table as one backticked project.dataset.table path', () => {
    const { sql } = compileBlockQuery(req(), TABLE, null);
    expect(sql).toContain('FROM `acme-analytics.warehouse.order`');
    // NOT `acme-analytics`.`warehouse`.`order` — BigQuery reads that
    // as a field access.
    expect(sql).not.toContain('`.`');
    expect(quoteTable(TABLE)).toBe('`acme-analytics.warehouse.order`');
  });

  it('backticks each projected column', () => {
    const { sql } = compileBlockQuery(req({ columns: ['id', 'status'] }), TABLE, null);
    expect(sql).toContain('SELECT `id`, `status` FROM');
  });
});

describe('injection guard', () => {
  it('rejects a filter naming a column outside the descriptor allowlist', () => {
    expect(() =>
      compileBlockQuery(
        req({
          filter: {
            type: 'comparison',
            columnId: 'id` , (SELECT 1) AS `x',
            op: 'eq',
            value: 1,
          },
        }),
        TABLE,
        null,
      ),
    ).toThrow(/unknown column/);
  });

  it('rejects an unknown projection, sort and group column', () => {
    expect(() => compileBlockQuery(req({ columns: ['secret'] }), TABLE, null)).toThrow(
      /unknown column/,
    );
    expect(() =>
      compileBlockQuery(req({ sort: [{ columnId: 'secret', direction: 'asc' }] }), TABLE, null),
    ).toThrow(/unknown column/);
    expect(() =>
      compileBlockQuery(req({ grouping: { columns: ['secret'], openKeys: [] } }), TABLE, null),
    ).toThrow(/unknown column/);
  });

  it('rejects a table path that is not a valid BigQuery identifier', () => {
    expect(() =>
      compileBlockQuery(req(), { ...TABLE, dataset: 'w`) UNION SELECT (1' }, null),
    ).toThrow(/not a valid BigQuery identifier/);
  });

  it('rejects a backtick in an aggregation alias rather than escaping it', () => {
    expect(() =>
      compileBlockQuery(
        req({
          grouping: { columns: ['status'], openKeys: [] },
          aggregations: [{ columnId: 'amount', fn: 'sum', alias: 'x`, 1 AS `y' }],
        }),
        TABLE,
        null,
      ),
    ).toThrow(/contains a backtick/);
  });

  it('refuses a non-integer limit rather than inlining it', () => {
    expect(() => compileBlockQuery(req({ limit: 2.5 }), TABLE, null)).toThrow(/safe integer/);
    expect(() =>
      compileBlockQuery(req({ limit: '10; DROP TABLE x' as unknown as number }), TABLE, null),
    ).toThrow(/safe integer/);
  });

  it('never puts a filter value in the SQL text', () => {
    const { sql, params } = compileBlockQuery(
      req({
        filter: {
          type: 'comparison',
          columnId: 'status',
          op: 'eq',
          value: "shipped' OR 1=1 --",
        },
      }),
      TABLE,
      null,
    );
    expect(sql).not.toContain('OR 1=1');
    expect(sql).toContain('`status` = @p0');
    expect(params).toEqual({ p0: "shipped' OR 1=1 --" });
  });
});

describe('typed named parameters', () => {
  it('declares each parameter type from the descriptor', () => {
    const { params, paramType } = compileBlockQuery(
      req({
        filter: {
          type: 'logical',
          op: 'and',
          filters: [
            { type: 'comparison', columnId: 'status', op: 'eq', value: 'open' },
            { type: 'comparison', columnId: 'amount', op: 'gte', value: 10 },
          ],
        },
      }),
      TABLE,
      null,
    );
    expect(params).toEqual({ p0: 'open', p1: 10 });
    expect(paramType).toEqual({ p0: 'STRING', p1: 'NUMERIC' });
  });

  it('falls back to STRING for a column with no declared type', () => {
    const { columnType: _declared, ...withoutType } = TABLE;
    const bare: BqTableDescriptor = withoutType;
    const { paramType } = compileBlockQuery(
      req({ filter: { type: 'comparison', columnId: 'amount', op: 'eq', value: 1 } }),
      bare,
      null,
    );
    expect(paramType).toEqual({ p0: 'STRING' });
  });

  it('stringifies a BigInt parameter, because INT64 exceeds float64', () => {
    const { params, paramType } = compileBlockQuery(
      req({
        filter: {
          type: 'comparison',
          columnId: 'id',
          op: 'eq',
          value: 9007199254740993n,
        },
      }),
      TABLE,
      null,
    );
    expect(params).toEqual({ p0: '9007199254740993' });
    expect(paramType).toEqual({ p0: 'INT64' });
  });

  it('sends an IN list as one UNNEST array parameter, not one per value', () => {
    const { sql, params, paramType } = compileBlockQuery(
      req({
        filter: { type: 'comparison', columnId: 'status', op: 'in', values: ['a', 'b', 'c'] },
      }),
      TABLE,
      null,
    );
    expect(sql).toContain('`status` IN UNNEST(@p0)');
    expect(params).toEqual({ p0: ['a', 'b', 'c'] });
    expect(paramType).toEqual({ p0: 'ARRAY<STRING>' });
  });
});

describe('partition and cluster aware predicate ordering', () => {
  it('hoists the partition predicate ahead of an unindexed one', () => {
    const { sql, params } = compileBlockQuery(
      req({
        filter: {
          type: 'logical',
          op: 'and',
          filters: [
            { type: 'comparison', columnId: 'amount', op: 'gt', value: 100 },
            { type: 'comparison', columnId: 'event_date', op: 'eq', value: '2026-01-01' },
          ],
        },
      }),
      TABLE,
      null,
    );
    expect(sql).toContain('(`event_date` = @p0 AND `amount` > @p1)');
    expect(params).toEqual({ p0: '2026-01-01', p1: 100 });
  });

  it('orders clustering columns by their declaration order', () => {
    const { sql } = compileBlockQuery(
      req({
        filter: {
          type: 'logical',
          op: 'and',
          filters: [
            { type: 'comparison', columnId: 'amount', op: 'gt', value: 1 },
            { type: 'comparison', columnId: 'status', op: 'eq', value: 'open' },
            { type: 'comparison', columnId: 'customer_id', op: 'eq', value: 7 },
            { type: 'comparison', columnId: 'event_date', op: 'eq', value: '2026-01-01' },
          ],
        },
      }),
      TABLE,
      null,
    );
    expect(sql).toContain(
      '(`event_date` = @p0 AND `customer_id` = @p1 AND `status` = @p2 AND `amount` > @p3)',
    );
  });

  it('is stable for equally-rated predicates and leaves OR alone', () => {
    const node = [
      { type: 'comparison', columnId: 'amount', op: 'gt', value: 1 },
      { type: 'comparison', columnId: 'id', op: 'eq', value: 2 },
    ] as const;
    expect(orderByPruningValue(node, TABLE)).toEqual([node[0], node[1]]);

    const { sql } = compileBlockQuery(
      req({
        filter: {
          type: 'logical',
          op: 'or',
          filters: [
            { type: 'comparison', columnId: 'amount', op: 'gt', value: 1 },
            { type: 'comparison', columnId: 'event_date', op: 'eq', value: '2026-01-01' },
          ],
        },
      }),
      TABLE,
      null,
    );
    expect(sql).toContain('(`amount` > @p0 OR `event_date` = @p1)');
  });
});

describe('_PARTITIONTIME pruning', () => {
  // Ingestion-time partitioning means there is no partition COLUMN at
  // all — the pseudo-column is the only handle on the partitions.
  const { partitionColumn: _none, ...withoutPartitionColumn } = TABLE;
  const INGESTION: BqTableDescriptor = {
    ...withoutPartitionColumn,
    partitionPseudoColumn: '_PARTITIONTIME',
  };

  it('emits bounded pseudo-column predicates ahead of the user filter', () => {
    const { sql, params, paramType } = compileBlockQuery(
      req({ filter: { type: 'comparison', columnId: 'status', op: 'eq', value: 'open' } }),
      INGESTION,
      null,
      {
        partitionFilter: {
          from: new Date('2026-01-01T00:00:00.000Z'),
          to: '2026-02-01T00:00:00.000Z',
        },
      },
    );
    expect(sql).toContain(
      'WHERE _PARTITIONTIME >= TIMESTAMP(@p0) AND _PARTITIONTIME < TIMESTAMP(@p1) AND `status` = @p2',
    );
    expect(params).toEqual({
      p0: '2026-01-01T00:00:00.000Z',
      p1: '2026-02-01T00:00:00.000Z',
      p2: 'open',
    });
    expect(paramType).toEqual({ p0: 'TIMESTAMP', p1: 'TIMESTAMP', p2: 'STRING' });
  });

  it('supports a one-sided window and the _PARTITIONDATE flavour', () => {
    const { sql, paramType } = compileBlockQuery(
      req(),
      { ...INGESTION, partitionPseudoColumn: '_PARTITIONDATE' },
      null,
      { partitionFilter: { from: '2026-01-01' } },
    );
    expect(sql).toContain('WHERE _PARTITIONDATE >= DATE(@p0)');
    expect(sql).not.toContain('<');
    expect(paramType).toEqual({ p0: 'DATE' });
  });

  it('refuses to prune a table that declares no pseudo-column', () => {
    expect(() =>
      compileBlockQuery(req(), TABLE, null, { partitionFilter: { from: '2026-01-01' } }),
    ).toThrow(/partitionPseudoColumn/);
  });

  it('prunes the grouped path too', () => {
    const { sql } = compileBlockQuery(
      req({ grouping: { columns: ['status'], openKeys: [] } }),
      INGESTION,
      null,
      { partitionFilter: { from: '2026-01-01T00:00:00.000Z' } },
    );
    expect(sql).toContain('WHERE _PARTITIONTIME >= TIMESTAMP(@p0) GROUP BY `status`');
  });
});

describe('filter operators', () => {
  it('compiles comparisons, BETWEEN and null checks in emission order', () => {
    const { sql, params } = compileBlockQuery(
      req({
        filter: {
          type: 'logical',
          op: 'and',
          filters: [
            { type: 'comparison', columnId: 'status', op: 'neq', value: 'draft' },
            { type: 'comparison', columnId: 'amount', op: 'between', values: [1, 2] },
            { type: 'comparison', columnId: 'status', op: 'isNull' },
          ],
        },
      }),
      TABLE,
      null,
    );
    expect(sql).toContain(
      '(`status` != @p0 AND `status` IS NULL AND `amount` BETWEEN @p1 AND @p2)',
    );
    expect(params).toEqual({ p0: 'draft', p1: 1, p2: 2 });
  });

  it('folds both sides with LOWER for case-insensitive matching (GoogleSQL has no ILIKE)', () => {
    const sensitive = compileBlockQuery(
      req({
        filter: { type: 'comparison', columnId: 'status', op: 'contains', value: '50%_off' },
      }),
      TABLE,
      null,
    );
    expect(sensitive.sql).toContain('`status` LIKE @p0');
    expect(sensitive.params).toEqual({ p0: '%50\\%\\_off%' });

    const insensitive = compileBlockQuery(
      req({
        filter: {
          type: 'comparison',
          columnId: 'status',
          op: 'startsWith',
          value: 'Ship',
          caseSensitive: false,
        },
      }),
      TABLE,
      null,
    );
    expect(insensitive.sql).toContain('LOWER(`status`) LIKE LOWER(@p0)');
    expect(insensitive.params).toEqual({ p0: 'Ship%' });
  });

  it('collapses an empty IN to FALSE and an empty NOT IN to TRUE', () => {
    expect(
      compileBlockQuery(
        req({ filter: { type: 'comparison', columnId: 'status', op: 'in', values: [] } }),
        TABLE,
        null,
      ).sql,
    ).toContain('WHERE FALSE');
    expect(
      compileBlockQuery(
        req({ filter: { type: 'comparison', columnId: 'status', op: 'notIn', values: [] } }),
        TABLE,
        null,
      ).sql,
    ).toContain('WHERE TRUE');
  });

  it('compiles NOT over a nested tree', () => {
    const { sql } = compileBlockQuery(
      req({
        filter: {
          type: 'logical',
          op: 'not',
          filters: [
            {
              type: 'logical',
              op: 'or',
              filters: [
                { type: 'comparison', columnId: 'status', op: 'endsWith', value: 'x' },
                { type: 'comparison', columnId: 'amount', op: 'isNotNull' },
              ],
            },
          ],
        },
      }),
      TABLE,
      null,
    );
    expect(sql).toContain('(NOT (`status` LIKE @p0 OR `amount` IS NOT NULL))');
  });
});

describe('keyset pagination', () => {
  it('expands the cursor into a lexicographic chain (GoogleSQL compares STRUCTs only for =)', () => {
    const { sql, params, paramType } = compileBlockQuery(
      req({
        sort: [
          { columnId: 'status', direction: 'asc' },
          { columnId: 'amount', direction: 'desc' },
        ],
      }),
      TABLE,
      { sortValues: ['shipped', 42], rowId: '7' },
    );
    expect(sql).toContain(
      '(`status` > @p0 OR (`status` = @p1 AND (`amount` < @p2 OR (`amount` = @p3 AND `id` > @p4))))',
    );
    expect(params).toEqual({ p0: 'shipped', p1: 'shipped', p2: 42, p3: 42, p4: '7' });
    expect(paramType.p4).toBe('INT64');
  });

  it('degenerates to a bare pk predicate when nothing is sorted', () => {
    const { sql, params } = compileBlockQuery(req(), TABLE, { sortValues: [], rowId: 5 });
    expect(sql).toContain('WHERE `id` > @p0');
    expect(params).toEqual({ p0: 5 });
  });

  it('flips the chain for descending sorts and for a `before` fetch', () => {
    const desc = compileBlockQuery(
      req({ sort: [{ columnId: 'amount', direction: 'desc' }] }),
      TABLE,
      { sortValues: [9], rowId: 1 },
    );
    expect(desc.sql).toContain('(`amount` < @p0 OR (`amount` = @p1 AND `id` < @p2))');
    expect(desc.sql).toContain('ORDER BY `amount` DESC NULLS LAST, `id` DESC');

    const before = compileBlockQuery(
      req({ direction: 'before', sort: [{ columnId: 'amount', direction: 'desc' }] }),
      TABLE,
      { sortValues: [9], rowId: 1 },
    );
    expect(before.sql).toContain('(`amount` > @p0 OR (`amount` = @p1 AND `id` > @p2))');
    expect(before.sql).toContain('ORDER BY `amount` ASC NULLS LAST, `id` ASC');
  });

  it('numbers filter parameters before cursor parameters', () => {
    const { params } = compileBlockQuery(
      req({
        filter: { type: 'comparison', columnId: 'status', op: 'eq', value: 'open' },
        sort: [{ columnId: 'amount', direction: 'asc' }],
      }),
      TABLE,
      { sortValues: [5], rowId: 3 },
    );
    expect(params).toEqual({ p0: 'open', p1: 5, p2: 5, p3: 3 });
  });

  it('round-trips a cursor through the ks: codec', () => {
    const encoded = encodeKeysetCursor({ sortValues: [null, 2], rowId: '9007199254740993' });
    expect(isKeysetCursor(encoded)).toBe(true);
    expect(isLegacyOffsetCursor(encoded)).toBe(false);
    expect(decodeKeysetCursor(encoded)).toEqual({
      sortValues: [null, 2],
      rowId: '9007199254740993',
    });
  });
});

describe('aggregation pushdown', () => {
  it('emits group keys, __count__ and one aliased column per aggregation', () => {
    const { sql } = compileBlockQuery(
      req({
        grouping: { columns: ['status'], openKeys: [] },
        aggregations: [
          { columnId: 'amount', fn: 'sum' },
          { columnId: 'amount', fn: 'avg', alias: 'mean_amount' },
          { columnId: 'customer_id', fn: 'countDistinct' },
          { columnId: 'amount', fn: 'min' },
        ],
      }),
      TABLE,
      null,
    );
    expect(sql).toBe(
      'SELECT `status`, COUNT(*) AS `__count__`, IFNULL(CAST(SUM(`amount`) AS FLOAT64), 0) AS `sum_amount`, ' +
        'CAST(AVG(`amount`) AS FLOAT64) AS `mean_amount`, COUNT(DISTINCT `customer_id`) AS `countDistinct_customer_id`, ' +
        'MIN(`amount`) AS `min_amount` FROM `acme-analytics.warehouse.order` GROUP BY `status` ORDER BY `status` ASC',
    );
  });

  it('pushes the filter down alongside the rollup', () => {
    const { sql, params } = compileBlockQuery(
      req({
        grouping: { columns: ['status', 'event_date'], openKeys: [] },
        filter: { type: 'comparison', columnId: 'amount', op: 'gt', value: 100 },
      }),
      TABLE,
      null,
    );
    expect(sql).toContain('WHERE `amount` > @p0 GROUP BY `status`, `event_date`');
    expect(params).toEqual({ p0: 100 });
  });

  it('rejects an unsupported aggregation function', () => {
    expect(() =>
      compileBlockQuery(
        req({
          grouping: { columns: ['status'], openKeys: [] },
          aggregations: [{ columnId: 'amount', fn: 'median' }],
        }),
        TABLE,
        null,
      ),
    ).toThrow(/unsupported aggregation/);
  });
});
