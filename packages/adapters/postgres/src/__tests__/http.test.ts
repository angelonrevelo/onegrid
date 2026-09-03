import { describe, expect, it } from 'vitest';
import { createHttpQueryable } from '../http';

describe('createHttpQueryable', () => {
  it('POSTs { sql, param } and reads { row }', async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl: typeof fetch = async (url, init) => {
      seen.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ row: [{ id: 1, name: 'a' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const client = createHttpQueryable({
      url: 'https://boot.local/sql',
      header: { authorization: 'Bearer x' },
      fetch: fetchImpl,
    });
    const result = await client.query('select 1', [1]);
    expect(result.rows).toEqual([{ id: 1, name: 'a' }]);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe('https://boot.local/sql');
    const body = JSON.parse(String(seen[0]!.init.body));
    expect(body).toEqual({ sql: 'select 1', param: [1] });
  });

  it('accepts the node-postgres `rows` alias', async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify({ rows: [{ id: 2 }] }), { status: 200 });
    const client = createHttpQueryable({
      url: 'https://boot.local/sql',
      fetch: fetchImpl,
    });
    const result = await client.query('select 2');
    expect(result.rows).toEqual([{ id: 2 }]);
  });

  it('throws OG_PG_HTTP on a non-2xx response', async () => {
    const fetchImpl: typeof fetch = async () =>
      new Response('nope', { status: 503, statusText: 'Unavailable' });
    const client = createHttpQueryable({
      url: 'https://boot.local/sql',
      fetch: fetchImpl,
    });
    await expect(client.query('select 1')).rejects.toThrow(/OG_PG_HTTP/);
  });
});
