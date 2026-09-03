// =============================================================================
// @onegrid/sqlite — REAL-database integration tests.
//
// SQLite needs no container — better-sqlite3 runs in-process. We
// drive the same SsrmDataSource contract that postgres/integration.test.ts
// proves against real PG: seed a table, paginate by keyset, sort,
// filter, and confirm the SQL-injection guard rejects an evil columnId.
// =============================================================================

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Database, { type Database as Db } from 'better-sqlite3';
import { createSqliteDataSource } from '../datasource';
import type { SqliteQueryable } from '../datasource';
import type { SqliteTableDescriptor } from '../sql';
import type { BlockRequest, Schema } from '@onegrid/protocol';

const TABLE_SCHEMA: Schema = [
  { id: 'id', type: 'int32' },
  { id: 'name', type: 'utf8' },
  { id: 'revenue', type: 'float64' },
  { id: 'status', type: 'utf8' },
];

const TABLE_DESC: SqliteTableDescriptor = {
  table: 'orders',
  columns: ['id', 'name', 'revenue', 'status'],
  primaryKey: 'id',
};

// better-sqlite3 is a NATIVE addon: it ships prebuilds per (node ABI, platform,
// arch) and `npm i` compiles one only when a toolchain is present. On a box
// whose Node ABI has no prebuild the module imports fine and throws
// "Could not locate the bindings file" at `new Database()` — a machine
// property, not a defect in this adapter. Probe once and skip, mirroring the
// docker auto-detect in postgres/integration.test.ts so a plain `pnpm test`
// is green everywhere and this suite runs wherever the binding does exist.
function hasNativeBinding(): boolean {
  try {
    new Database(':memory:').close();
    return true;
  } catch {
    return false;
  }
}

const SKIP = !hasNativeBinding();

let db: Db | null = null;
let queryable: SqliteQueryable;

beforeAll(() => {
  if (SKIP) return;
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE orders (
      id      INTEGER PRIMARY KEY,
      name    TEXT NOT NULL,
      revenue REAL NOT NULL,
      status  TEXT NOT NULL
    );
  `);
  const insert = db.prepare(
    'INSERT INTO orders (id, name, revenue, status) VALUES (?, ?, ?, ?)',
  );
  const statuses = ['active', 'pending', 'churned', 'pilot', 'archived'];
  const tx = db.transaction(() => {
    for (let i = 1; i <= 50; i++) {
      insert.run(i, `name_${i}`, ((i * 1009) % 10_000) / 100, statuses[i % statuses.length]);
    }
  });
  tx();

  queryable = {
    query(sql, params) {
      const stmt = db!.prepare(sql);
      return stmt.all(...(params ?? [])) as ReadonlyArray<Record<string, unknown>>;
    },
  };
});

afterAll(() => {
  db?.close();
});

describe.skipIf(SKIP)('@onegrid/sqlite — real-database integration', () => {
  it('fetchBlock returns rows from real SQLite', async () => {
    const ds = createSqliteDataSource({ client: queryable, table: TABLE_DESC, schema: TABLE_SCHEMA });
    const req: BlockRequest = {
      cursor: null,
      direction: 'after',
      limit: 10,
      sort: [{ columnId: 'id', direction: 'asc' }],
      filter: null,
    };
    const res = await ds.fetchBlock(req);
    expect(res.rows.length).toBe(10);
    expect((res.rows[0] as Record<string, unknown> | undefined)?.id).toBe(1);
    expect((res.rows[9] as Record<string, unknown> | undefined)?.id).toBe(10);
    expect(res.nextCursor).not.toBeNull();
  });

  it('keyset cursor paginates forward correctly across multiple blocks', async () => {
    const ds = createSqliteDataSource({ client: queryable, table: TABLE_DESC, schema: TABLE_SCHEMA });
    const seen: number[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 6; page++) {
      const res = await ds.fetchBlock({
        cursor,
        direction: 'after',
        limit: 10,
        sort: [{ columnId: 'id', direction: 'asc' }],
        filter: null,
      });
      for (const r of res.rows as ReadonlyArray<Record<string, unknown>>) {
        seen.push(Number(r.id));
      }
      cursor = res.nextCursor;
      if (cursor === null) break;
    }
    expect(seen).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
  });

  it('sort desc by revenue puts the largest first', async () => {
    const ds = createSqliteDataSource({ client: queryable, table: TABLE_DESC, schema: TABLE_SCHEMA });
    const res = await ds.fetchBlock({
      cursor: null,
      direction: 'after',
      limit: 5,
      sort: [{ columnId: 'revenue', direction: 'desc' }],
      filter: null,
    });
    expect(res.rows.length).toBe(5);
    const revenues = (res.rows as ReadonlyArray<Record<string, unknown>>).map((r) =>
      Number(r.revenue),
    );
    for (let i = 1; i < revenues.length; i++) {
      expect(revenues[i]).toBeLessThanOrEqual(revenues[i - 1]!);
    }
  });

  it('filter narrows results to matching rows', async () => {
    const ds = createSqliteDataSource({ client: queryable, table: TABLE_DESC, schema: TABLE_SCHEMA });
    const res = await ds.fetchBlock({
      cursor: null,
      direction: 'after',
      limit: 100,
      sort: [{ columnId: 'id', direction: 'asc' }],
      filter: {
        type: 'comparison',
        columnId: 'status',
        op: 'eq',
        value: 'active',
      },
    });
    expect(res.rows.length).toBeGreaterThan(0);
    expect(res.rows.length).toBeLessThan(50);
    for (const r of res.rows as ReadonlyArray<Record<string, unknown>>) {
      expect(r.status).toBe('active');
    }
  });

  it('unknown column in a filter is rejected at SQL compile time (no SQL injection)', async () => {
    const ds = createSqliteDataSource({ client: queryable, table: TABLE_DESC, schema: TABLE_SCHEMA });
    await expect(
      ds.fetchBlock({
        cursor: null,
        direction: 'after',
        limit: 5,
        sort: [{ columnId: 'id', direction: 'asc' }],
        filter: {
          type: 'comparison',
          columnId: 'evil"; DROP TABLE orders; --',
          op: 'eq',
          value: 'x',
        },
      }),
    ).rejects.toThrow(/unknown column/);

    const n = (db!.prepare('SELECT count(*) AS n FROM orders').get() as { n: number }).n;
    expect(n).toBe(50);
  });

  it('schema() returns the static schema without hitting the database', async () => {
    const ds = createSqliteDataSource({ client: queryable, table: TABLE_DESC, schema: TABLE_SCHEMA });
    expect(await ds.schema()).toEqual(TABLE_SCHEMA);
  });
});
