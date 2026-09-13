// =============================================================================
// Distinct values — SQL compile snapshots + injection safety.
// =============================================================================

import { describe, expect, it, vi } from 'vitest';
import type { DistinctRequest } from '@onegrid/protocol';
import { createPgDataSource } from '../datasource';
import { compileDistinctQuery, type PgTableDescriptor } from '../sql';

const TABLE: PgTableDescriptor = {
  table: 'public.orders',
  columns: ['id', 'status', 'amount', 'customer'],
  primaryKey: 'id',
};

const req = (overrides: Partial<DistinctRequest> = {}): DistinctRequest => ({
  columnId: 'status',
  filter: null,
  limit: 50,
  ...overrides,
});

describe('compileDistinctQuery', () => {
  it('groups, counts and orders by count with one truncation-probe row', () => {
    expect(compileDistinctQuery(req(), TABLE)).toEqual({
      sql:
        'SELECT "status" AS "value", COUNT(*)::int AS "count" FROM "public"."orders"' +
        ' GROUP BY "status" ORDER BY "count" DESC, "status" ASC NULLS LAST LIMIT $1',
      params: [51],
    });
  });

  it('compiles the filter and search prefix to placeholders', () => {
    const { sql, params } = compileDistinctQuery(
      req({
        filter: { type: 'comparison', columnId: 'amount', op: 'gt', value: 10 },
        search: 'ac',
      }),
      TABLE,
    );
    expect(sql).toBe(
      'SELECT "status" AS "value", COUNT(*)::int AS "count" FROM "public"."orders"' +
        ' WHERE "amount" > $1 AND LOWER(CAST("status" AS TEXT)) LIKE LOWER($2)' +
        ' GROUP BY "status" ORDER BY "count" DESC, "status" ASC NULLS LAST LIMIT $3',
    );
    expect(params).toEqual([10, 'ac%', 51]);
  });

  it('keeps hostile values out of the SQL string', () => {
    const hostile = "x'; DROP TABLE orders; --%_";
    const { sql, params } = compileDistinctQuery(
      req({
        filter: { type: 'comparison', columnId: 'customer', op: 'eq', value: hostile },
        search: hostile,
      }),
      TABLE,
    );
    expect(sql).not.toContain('DROP');
    expect(sql).not.toContain("'");
    expect(params[0]).toBe(hostile);
    // LIKE metacharacters in the search are escaped, then the prefix wildcard added.
    expect(params[1]).toBe("x'; DROP TABLE orders; --\\%\\_%");
  });

  it('refuses a column outside the table descriptor', () => {
    expect(() => compileDistinctQuery(req({ columnId: 'password' }), TABLE)).toThrow(/unknown column/);
    expect(() => compileDistinctQuery(req({ columnId: 'status"; DROP TABLE orders; --' }), TABLE)).toThrow(
      /unknown column/,
    );
  });
});

describe('createPgDataSource.fetchDistinct', () => {
  it('trims the probe row, reports truncation and coerces counts', async () => {
    const query = vi.fn((_sql: string, _params?: ReadonlyArray<unknown>) =>
      Promise.resolve({
        rows: [
          { value: 'active', count: '3' },
          { value: null, count: 2 },
          { value: 'closed', count: 1 },
        ] as ReadonlyArray<Record<string, unknown>>,
      }),
    );
    const ds = createPgDataSource({ client: { query }, table: TABLE, schema: [] });
    const result = await ds.fetchDistinct!(req({ limit: 2, requestId: 'r1' }));
    expect(result).toEqual({
      kind: 'distinct',
      entry: [
        { value: 'active', count: 3 },
        { value: null, count: 2 },
      ],
      truncated: true,
      requestId: 'r1',
    });
    expect(query.mock.calls[0]![1]).toEqual([3]);
  });
});
