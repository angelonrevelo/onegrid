import { describe, expect, it } from 'vitest';
import { createHttpQueryable } from '@onegrid/postgres';
import { applyStatement } from '../apply';

describe('createHttpQueryable consumed outside the postgres package', () => {
  it('returns the rows the handler posted back', async () => {
    const posted: Array<{ sql: string; param: unknown[] }> = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
      posted.push(JSON.parse(String(init?.body)) as { sql: string; param: unknown[] });
      return new Response(JSON.stringify({ row: [{ account_id: 'a-1', email: 'ada@onegrid.dev' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const pg = createHttpQueryable({ url: 'https://boot.local/queryable', fetch: fetchImpl });
    const queryable = {
      async query(sql: string, param?: readonly unknown[]) {
        const result = await pg.query(sql, param);
        return result.rows;
      },
    };
    const row = await applyStatement(queryable, {
      sql: 'SELECT * FROM "public"."account"',
      param: [],
    });
    expect(row).toEqual([{ account_id: 'a-1', email: 'ada@onegrid.dev' }]);
    expect(posted).toEqual([{ sql: 'SELECT * FROM "public"."account"', param: [] }]);
  });
});
