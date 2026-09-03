// =============================================================================
// Snowflake SQL compiler — unit tests.
//
// These assert on the exact SQL text and the exact bind array, because
// both are the adapter's contract with the warehouse: a stray space is
// harmless, but a mis-ordered bind silently returns the wrong rows.
// =============================================================================

import { describe, expect, it } from 'vitest';
import type { BlockRequest } from '@onegrid/protocol';
import {
  compileBlockQuery,
  decodeKeysetCursor,
  encodeKeysetCursor,
  isKeysetCursor,
  isLegacyOffsetCursor,
  resolveIdent,
  type SnowflakeTableDescriptor,
} from '../sql';

const TABLE: SnowflakeTableDescriptor = {
  table: 'ANALYTICS.PUBLIC.ORDER',
  columns: ['id', 'status', 'amount', 'created_at'],
  primaryKey: 'id',
};

const QUOTED_TABLE: SnowflakeTableDescriptor = {
  table: 'analytics.public.order',
  columns: ['id', 'status'],
  primaryKey: 'id',
  preserveCase: true,
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

describe('identifier resolution', () => {
  it('upper-cases and double-quotes identifiers by default', () => {
    const { sql } = compileBlockQuery(req(), TABLE, null);
    expect(sql).toContain('"ANALYTICS"."PUBLIC"."ORDER"');
    expect(sql).toContain('"ID", "STATUS", "AMOUNT", "CREATED_AT"');
  });

  it('preserves case when the table was created with quoted DDL', () => {
    const { sql } = compileBlockQuery(req(), QUOTED_TABLE, null);
    expect(sql).toContain('"analytics"."public"."order"');
    expect(sql).toContain('"id", "status"');
    expect(resolveIdent('id', QUOTED_TABLE)).toBe('id');
    expect(resolveIdent('id', TABLE)).toBe('ID');
  });
});

describe('injection guard', () => {
  it('rejects a filter naming a column outside the descriptor allowlist', () => {
    expect(() =>
      compileBlockQuery(
        req({
          filter: {
            type: 'comparison',
            columnId: 'id" ; DROP TABLE "ORDER',
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
      compileBlockQuery(
        req({ grouping: { columns: ['secret'], openKeys: [] } }),
        TABLE,
        null,
      ),
    ).toThrow(/unknown column/);
  });

  it('doubles embedded quotes in an aggregation alias instead of trusting it', () => {
    const { sql } = compileBlockQuery(
      req({
        grouping: { columns: ['status'], openKeys: [] },
        aggregations: [{ columnId: 'amount', fn: 'sum', alias: 'x" , 1 AS "y' }],
      }),
      TABLE,
      null,
    );
    expect(sql).toContain('AS "X"" , 1 AS ""Y"');
  });

  it('refuses a non-integer limit rather than inlining it', () => {
    // LIMIT is the one clause Snowflake will not bind, so the value is
    // inlined — which makes validating it a security control.
    expect(() => compileBlockQuery(req({ limit: 1.5 }), TABLE, null)).toThrow(/safe integer/);
    expect(() => compileBlockQuery(req({ limit: -1 }), TABLE, null)).toThrow(/safe integer/);
    expect(() =>
      compileBlockQuery(req({ limit: '10; DROP TABLE X' as unknown as number }), TABLE, null),
    ).toThrow(/safe integer/);
  });

  it('never puts a filter value in the SQL text', () => {
    const { sql, bind } = compileBlockQuery(
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
    expect(sql).toContain('"STATUS" = ?');
    expect(bind).toEqual(["shipped' OR 1=1 --"]);
  });
});

describe('flat query shape', () => {
  it('emits SELECT / FROM / ORDER BY / LIMIT with an inlined row count', () => {
    const { sql, bind } = compileBlockQuery(req({ limit: 50 }), TABLE, null);
    expect(sql).toBe(
      'SELECT "ID", "STATUS", "AMOUNT", "CREATED_AT" FROM "ANALYTICS"."PUBLIC"."ORDER" ORDER BY "ID" ASC LIMIT 50',
    );
    expect(bind).toEqual([]);
  });

  it('orders multi-sort keys with NULLS handling then the pk tiebreaker', () => {
    const { sql } = compileBlockQuery(
      req({
        sort: [
          { columnId: 'status', direction: 'asc', nulls: 'first' },
          { columnId: 'amount', direction: 'desc' },
        ],
      }),
      TABLE,
      null,
    );
    expect(sql).toContain(
      'ORDER BY "STATUS" ASC NULLS FIRST, "AMOUNT" DESC NULLS LAST, "ID" ASC',
    );
  });

  it('reverses every sort key for a `before` fetch, not just the tiebreaker', () => {
    const { sql } = compileBlockQuery(
      req({ direction: 'before', sort: [{ columnId: 'amount', direction: 'asc' }] }),
      TABLE,
      null,
    );
    expect(sql).toContain('ORDER BY "AMOUNT" DESC NULLS LAST, "ID" DESC');
  });
});

describe('filter operators', () => {
  it('compiles every comparison operator with binds in emission order', () => {
    const { sql, bind } = compileBlockQuery(
      req({
        filter: {
          type: 'logical',
          op: 'and',
          filters: [
            { type: 'comparison', columnId: 'status', op: 'neq', value: 'draft' },
            { type: 'comparison', columnId: 'amount', op: 'gte', value: 10 },
            { type: 'comparison', columnId: 'amount', op: 'lt', value: 99 },
            { type: 'comparison', columnId: 'status', op: 'in', values: ['a', 'b'] },
            { type: 'comparison', columnId: 'amount', op: 'between', values: [1, 2] },
            { type: 'comparison', columnId: 'created_at', op: 'isNotNull' },
          ],
        },
      }),
      TABLE,
      null,
    );
    expect(sql).toContain(
      '("STATUS" != ? AND "AMOUNT" >= ? AND "AMOUNT" < ? AND "STATUS" IN (?, ?) AND "AMOUNT" BETWEEN ? AND ? AND "CREATED_AT" IS NOT NULL)',
    );
    expect(bind).toEqual(['draft', 10, 99, 'a', 'b', 1, 2]);
  });

  it('uses ILIKE for case-insensitive string operators and escapes wildcards', () => {
    const { sql, bind } = compileBlockQuery(
      req({
        filter: {
          type: 'comparison',
          columnId: 'status', op: 'contains',
          value: '50%_off',
          caseSensitive: false,
        },
      }),
      TABLE,
      null,
    );
    expect(sql).toContain('"STATUS" ILIKE ?');
    expect(bind).toEqual(['%50\\%\\_off%']);
  });

  it('collapses an empty IN to FALSE and an empty NOT IN to TRUE', () => {
    const inSql = compileBlockQuery(
      req({ filter: { type: 'comparison', columnId: 'status', op: 'in', values: [] } }),
      TABLE,
      null,
    ).sql;
    const notInSql = compileBlockQuery(
      req({ filter: { type: 'comparison', columnId: 'status', op: 'notIn', values: [] } }),
      TABLE,
      null,
    ).sql;
    expect(inSql).toContain('WHERE FALSE');
    expect(notInSql).toContain('WHERE TRUE');
  });

  it('compiles nested OR / NOT trees', () => {
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
                { type: 'comparison', columnId: 'status', op: 'startsWith', value: 'x' },
                { type: 'comparison', columnId: 'amount', op: 'isNull' },
              ],
            },
          ],
        },
      }),
      TABLE,
      null,
    );
    expect(sql).toContain('(NOT ("STATUS" LIKE ? ESCAPE \'\\\\\' OR "AMOUNT" IS NULL))');
  });
});

describe('keyset pagination', () => {
  it('expands the cursor into a lexicographic chain (Snowflake has no row comparison)', () => {
    const { sql, bind } = compileBlockQuery(
      req({
        sort: [
          { columnId: 'status', direction: 'asc' },
          { columnId: 'amount', direction: 'desc' },
        ],
      }),
      TABLE,
      { sortValues: ['shipped', 42], rowId: 7 },
    );
    expect(sql).toContain(
      '("STATUS" > ? OR ("STATUS" = ? AND ("AMOUNT" < ? OR ("AMOUNT" = ? AND "ID" > ?))))',
    );
    expect(sql).not.toContain('(, )');
    expect(bind).toEqual(['shipped', 'shipped', 42, 42, 7]);
  });

  it('degenerates to a bare pk predicate when nothing is sorted', () => {
    const { sql, bind } = compileBlockQuery(req(), TABLE, { sortValues: [], rowId: 'abc' });
    expect(sql).toContain('WHERE "ID" > ?');
    expect(bind).toEqual(['abc']);
  });

  it('flips the chain for a descending sort and for a `before` fetch', () => {
    const desc = compileBlockQuery(
      req({ sort: [{ columnId: 'amount', direction: 'desc' }] }),
      TABLE,
      { sortValues: [9], rowId: 1 },
    );
    expect(desc.sql).toContain('("AMOUNT" < ? OR ("AMOUNT" = ? AND "ID" < ?))');

    const before = compileBlockQuery(
      req({ direction: 'before', sort: [{ columnId: 'amount', direction: 'desc' }] }),
      TABLE,
      { sortValues: [9], rowId: 1 },
    );
    expect(before.sql).toContain('("AMOUNT" > ? OR ("AMOUNT" = ? AND "ID" > ?))');
  });

  it('keeps the filter binds ahead of the cursor binds', () => {
    const { bind } = compileBlockQuery(
      req({
        filter: { type: 'comparison', columnId: 'status', op: 'eq', value: 'open' },
        sort: [{ columnId: 'amount', direction: 'asc' }],
      }),
      TABLE,
      { sortValues: [5], rowId: 3 },
    );
    expect(bind).toEqual(['open', 5, 5, 3]);
  });

  it('round-trips a cursor through the ks: codec', () => {
    const encoded = encodeKeysetCursor({ sortValues: ['a', 2], rowId: '99999999999999999999' });
    expect(isKeysetCursor(encoded)).toBe(true);
    expect(isLegacyOffsetCursor(encoded)).toBe(false);
    expect(decodeKeysetCursor(encoded)).toEqual({
      sortValues: ['a', 2],
      rowId: '99999999999999999999',
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
          { columnId: 'id', fn: 'countDistinct' },
          { columnId: 'amount', fn: 'max' },
        ],
      }),
      TABLE,
      null,
    );
    expect(sql).toBe(
      'SELECT "STATUS", COUNT(*) AS "__count__", COALESCE(SUM("AMOUNT")::FLOAT, 0) AS "SUM_AMOUNT", ' +
        'AVG("AMOUNT")::FLOAT AS "MEAN_AMOUNT", COUNT(DISTINCT "ID") AS "COUNTDISTINCT_ID", ' +
        'MAX("AMOUNT") AS "MAX_AMOUNT" FROM "ANALYTICS"."PUBLIC"."ORDER" GROUP BY "STATUS" ORDER BY "STATUS" ASC',
    );
  });

  it('keeps the filter on the grouped path so the rollup is pushed down', () => {
    const { sql, bind } = compileBlockQuery(
      req({
        grouping: { columns: ['status', 'created_at'], openKeys: [] },
        filter: { type: 'comparison', columnId: 'amount', op: 'gt', value: 100 },
      }),
      TABLE,
      null,
    );
    expect(sql).toContain('WHERE "AMOUNT" > ? GROUP BY "STATUS", "CREATED_AT"');
    expect(bind).toEqual([100]);
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

describe('QUALIFY deduplication', () => {
  it('emits ROW_NUMBER dedup for append-only tables', () => {
    const dedupeTable: SnowflakeTableDescriptor = {
      ...TABLE,
      dedupe: { partition: ['id'], recency: 'created_at' },
    };
    const { sql } = compileBlockQuery(req({ limit: 10 }), dedupeTable, null);
    expect(sql).toContain(
      'QUALIFY ROW_NUMBER() OVER (PARTITION BY "ID" ORDER BY "CREATED_AT" DESC) = 1',
    );
    expect(sql.indexOf('QUALIFY')).toBeLessThan(sql.indexOf('ORDER BY "ID" ASC'));
  });

  it('validates the dedupe columns against the allowlist', () => {
    expect(() =>
      compileBlockQuery(
        req(),
        { ...TABLE, dedupe: { partition: ['nope'], recency: 'created_at' } },
        null,
      ),
    ).toThrow(/unknown column/);
    expect(() =>
      compileBlockQuery(
        req(),
        { ...TABLE, dedupe: { partition: [], recency: 'created_at' } },
        null,
      ),
    ).toThrow(/at least one column/);
  });
});
