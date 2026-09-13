// =============================================================================
// Distinct values — SQL snapshots, injection safety, and the data-source path
// over a fake AsyncDuckDB connection.
// =============================================================================

import { describe, expect, it, vi } from 'vitest';
import type { AsyncDuckDB } from '@duckdb/duckdb-wasm';
import { createDuckDbDataSource } from '../index';
import { buildDistinctSql } from '../sql';

describe('buildDistinctSql', () => {
  it('groups + counts with one truncation-probe row', () => {
    expect(
      buildDistinctSql({ source: 'events', request: { columnId: 'status', filter: null, limit: 20 } }),
    ).toEqual({
      sql:
        'SELECT "status" AS "value", COUNT(*) AS "count" FROM events' +
        ' GROUP BY "status" ORDER BY "count" DESC, "status" ASC NULLS LAST LIMIT 21',
      params: [],
    });
  });

  it('compiles the filter and search prefix to placeholders', () => {
    expect(
      buildDistinctSql({
        source: 'events',
        request: {
          columnId: 'status',
          filter: { type: 'comparison', columnId: 'region', op: 'eq', value: 'emea' },
          search: 'ac',
          limit: 5,
        },
      }),
    ).toEqual({
      sql:
        'SELECT "status" AS "value", COUNT(*) AS "count" FROM events' +
        ` WHERE "region" = ? AND CAST("status" AS VARCHAR) ILIKE ? ESCAPE '\\'` +
        ' GROUP BY "status" ORDER BY "count" DESC, "status" ASC NULLS LAST LIMIT 6',
      params: ['emea', 'ac%'],
    });
  });

  it('the search prefix declares its escape character', () => {
    const { sql, params } = buildDistinctSql({
      source: 'events',
      request: { columnId: 'status', filter: null, search: 'a_c', limit: 5 },
    });
    expect(sql).toContain(`CAST("status" AS VARCHAR) ILIKE ? ESCAPE '\\'`);
    expect(params).toEqual(['a\\_c%']);
  });

  it('keeps hostile input out of the SQL string', () => {
    const hostile = "x' OR 1=1; --%";
    const { sql, params } = buildDistinctSql({
      source: 'events',
      request: {
        columnId: 'sta"tus',
        filter: { type: 'comparison', columnId: 'region', op: 'contains', value: hostile },
        search: hostile,
        limit: 1.9,
      },
    });
    // The only quotes allowed are the fixed ESCAPE clause's own.
    expect(sql.replaceAll("ESCAPE '\\'", '')).not.toContain("'");
    expect(sql).not.toContain('1=1');
    expect(sql).toContain('"sta""tus"');
    expect(sql.endsWith('LIMIT 2')).toBe(true);
    expect(params).toEqual(["%x' OR 1=1; --\\%%", "x' OR 1=1; --\\%%"]);
  });
});

describe('createDuckDbDataSource.fetchDistinct', () => {
  it('trims the probe row, reports truncation and coerces bigint counts', async () => {
    const table = {
      schema: { fields: [] },
      numRows: 3,
      toArray: () => [
        { value: 'active', count: 5n },
        { value: 'pending', count: 2n },
        { value: null, count: 1n },
      ],
    };
    const stmt = {
      query: vi.fn(() => Promise.resolve(table)),
      close: vi.fn(() => Promise.resolve()),
    };
    const conn = {
      query: vi.fn(() => Promise.resolve(table)),
      prepare: vi.fn(() => Promise.resolve(stmt)),
      close: vi.fn(() => Promise.resolve()),
    };
    const db = { connect: vi.fn(() => Promise.resolve(conn)) } as unknown as AsyncDuckDB;
    const ds = createDuckDbDataSource({ db, source: 'events' });
    const result = await ds.fetchDistinct!({ columnId: 'status', filter: null, limit: 2 });
    expect(result).toEqual({
      kind: 'distinct',
      entry: [
        { value: 'active', count: 5 },
        { value: 'pending', count: 2 },
      ],
      truncated: true,
    });
  });

  it('refuses an already-aborted request before touching the connection', async () => {
    const db = { connect: vi.fn() } as unknown as AsyncDuckDB;
    const ds = createDuckDbDataSource({ db, source: 'events' });
    const controller = new AbortController();
    controller.abort();
    await expect(
      ds.fetchDistinct!({ columnId: 'status', filter: null, limit: 2 }, { signal: controller.signal }),
    ).rejects.toThrow(/aborted/);
    expect((db as unknown as { connect: ReturnType<typeof vi.fn> }).connect).not.toHaveBeenCalled();
  });
});
