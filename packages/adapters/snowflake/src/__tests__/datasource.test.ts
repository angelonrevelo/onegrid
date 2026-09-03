// =============================================================================
// createSnowflakeDataSource — unit tests against an in-memory fake
// queryable. The fake records every statement it is handed, so the
// tests can assert on both the protocol behaviour (cursors) and the
// SQL that produced it.
// =============================================================================

import { describe, expect, it } from 'vitest';
import type { BlockRequest, Schema } from '@onegrid/protocol';
import {
  createSnowflakeDataSource,
  type SnowflakeQueryable,
  type SnowflakeStatement,
} from '../datasource';
import { decodeKeysetCursor, type SnowflakeTableDescriptor } from '../sql';

const TABLE: SnowflakeTableDescriptor = {
  table: 'ANALYTICS.PUBLIC.ORDER',
  columns: ['id', 'status', 'amount'],
  primaryKey: 'id',
};

const SCHEMA: Schema = [
  { id: 'ID', type: 'int64' },
  { id: 'STATUS', type: 'utf8' },
  { id: 'AMOUNT', type: 'float64' },
];

function fakeClient(
  ...batch: ReadonlyArray<ReadonlyArray<Record<string, unknown>>>
): SnowflakeQueryable & { statement: SnowflakeStatement[] } {
  const statement: SnowflakeStatement[] = [];
  let call = 0;
  return {
    statement,
    execute(stmt) {
      statement.push(stmt);
      const row = batch[call] ?? [];
      call++;
      return Promise.resolve({ row });
    },
  };
}

function req(override: Partial<BlockRequest> = {}): BlockRequest {
  return { cursor: null, direction: 'after', limit: 2, sort: [], filter: null, ...override };
}

describe('createSnowflakeDataSource', () => {
  it('returns the injected schema without touching the warehouse', async () => {
    const client = fakeClient([]);
    const ds = createSnowflakeDataSource({ client, table: TABLE, schema: SCHEMA });
    expect(await ds.schema()).toBe(SCHEMA);
    expect(client.statement).toHaveLength(0);
  });

  it('executes the compiled statement and returns json-encoded rows', async () => {
    const client = fakeClient([{ ID: 1, STATUS: 'open', AMOUNT: 5 }]);
    const ds = createSnowflakeDataSource({ client, table: TABLE, schema: SCHEMA });
    const res = await ds.fetchBlock(
      req({ filter: { type: 'comparison', columnId: 'status', op: 'eq', value: 'open' } }),
    );
    expect(res.encoding).toBe('json');
    expect(res.rows).toEqual([{ ID: 1, STATUS: 'open', AMOUNT: 5 }]);
    expect(client.statement[0]!.sql).toContain('"STATUS" = ?');
    expect(client.statement[0]!.bind).toEqual(['open']);
  });

  it('emits a next cursor only when the block came back full', async () => {
    const full = fakeClient([
      { ID: 1, STATUS: 'a', AMOUNT: 1 },
      { ID: 2, STATUS: 'b', AMOUNT: 2 },
    ]);
    const short = fakeClient([{ ID: 1, STATUS: 'a', AMOUNT: 1 }]);
    const dsFull = createSnowflakeDataSource({ client: full, table: TABLE, schema: SCHEMA });
    const dsShort = createSnowflakeDataSource({ client: short, table: TABLE, schema: SCHEMA });

    const fullRes = await dsFull.fetchBlock(req());
    const shortRes = await dsShort.fetchBlock(req());
    expect(fullRes.nextCursor).not.toBeNull();
    expect(decodeKeysetCursor(fullRes.nextCursor!)).toEqual({ sortValues: [], rowId: 2 });
    expect(shortRes.nextCursor).toBeNull();
    expect(fullRes.prevCursor).toBeNull(); // first block has nothing before it
  });

  it('paginates continuously: the cursor from block 1 filters block 2', async () => {
    const client = fakeClient(
      [
        { ID: 1, STATUS: 'a', AMOUNT: 10 },
        { ID: 2, STATUS: 'b', AMOUNT: 20 },
      ],
      [
        { ID: 3, STATUS: 'c', AMOUNT: 30 },
        { ID: 4, STATUS: 'd', AMOUNT: 40 },
      ],
    );
    const ds = createSnowflakeDataSource({ client, table: TABLE, schema: SCHEMA });
    const sort: BlockRequest['sort'] = [{ columnId: 'amount', direction: 'asc' }];

    const first = await ds.fetchBlock(req({ sort }));
    expect(client.statement[0]!.sql).not.toContain('WHERE');

    const second = await ds.fetchBlock(req({ sort, cursor: first.nextCursor }));
    expect(client.statement[1]!.sql).toContain(
      '("AMOUNT" > ? OR ("AMOUNT" = ? AND "ID" > ?))',
    );
    expect(client.statement[1]!.bind).toEqual([20, 20, 2]);
    expect(second.prevCursor).not.toBeNull();
    expect(decodeKeysetCursor(second.prevCursor!)).toEqual({ sortValues: [30], rowId: 3 });
  });

  it('reads sort values and the pk through Snowflake\'s upper-cased column names', async () => {
    const client = fakeClient([
      { ID: 1, STATUS: 'a', AMOUNT: 10 },
      { ID: 2, STATUS: 'b', AMOUNT: 20 },
    ]);
    const ds = createSnowflakeDataSource({ client, table: TABLE, schema: SCHEMA });
    const res = await ds.fetchBlock(
      req({ sort: [{ columnId: 'status', direction: 'asc' }] }),
    );
    expect(decodeKeysetCursor(res.nextCursor!)).toEqual({ sortValues: ['b'], rowId: 2 });
  });

  it('keeps a NUMBER(38,0) row id exact by stringifying the BigInt', async () => {
    const wide = 12345678901234567890n;
    const client = fakeClient([
      { ID: wide, STATUS: 'a', AMOUNT: 1 },
      { ID: wide + 1n, STATUS: 'b', AMOUNT: 2 },
    ]);
    const ds = createSnowflakeDataSource({ client, table: TABLE, schema: SCHEMA });
    const res = await ds.fetchBlock(req());
    const rowId = decodeKeysetCursor(res.nextCursor!).rowId;
    expect(rowId).toBe('12345678901234567891');
    expect(BigInt(rowId)).toBe(wide + 1n);
    // The float64 path would have rounded the last digits away, which
    // is exactly how a cursor starts skipping rows.
    expect(String(Number(rowId))).not.toBe(rowId);
  });

  it('throws when the primary key is missing from the result rows', async () => {
    const client = fakeClient([{ STATUS: 'a' }, { STATUS: 'b' }]);
    const ds = createSnowflakeDataSource({ client, table: TABLE, schema: SCHEMA });
    await expect(ds.fetchBlock(req())).rejects.toThrow(/primary key "id"/);
  });

  it('treats a legacy offset cursor as a first-block request', async () => {
    const client = fakeClient([{ ID: 1, STATUS: 'a', AMOUNT: 1 }]);
    const ds = createSnowflakeDataSource({ client, table: TABLE, schema: SCHEMA });
    await ds.fetchBlock(req({ cursor: 'offset:200' }));
    expect(client.statement[0]!.sql).not.toContain('WHERE');
  });

  it('echoes the requestId for telemetry correlation', async () => {
    const client = fakeClient([{ ID: 1, STATUS: 'a', AMOUNT: 1 }]);
    const ds = createSnowflakeDataSource({ client, table: TABLE, schema: SCHEMA });
    const res = await ds.fetchBlock(req({ requestId: 'block-7' }));
    expect(res.requestId).toBe('block-7');
  });
});
