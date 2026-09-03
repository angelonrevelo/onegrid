// =============================================================================
// createBigQueryDataSource — unit tests against an in-memory fake
// queryable. The fake records every job it is handed, so the tests can
// assert on the protocol behaviour (cursors), the SQL that produced it
// and the job options that control cost.
// =============================================================================

import { describe, expect, it } from 'vitest';
import type { BlockRequest, Schema } from '@onegrid/protocol';
import {
  createBigQueryDataSource,
  type BigQueryJobRequest,
  type BigQueryQueryable,
} from '../datasource';
import { decodeKeysetCursor, type BqTableDescriptor } from '../sql';

const TABLE: BqTableDescriptor = {
  project: 'acme-analytics',
  dataset: 'warehouse',
  table: 'order',
  columns: ['id', 'status', 'amount'],
  primaryKey: 'id',
  columnType: { id: 'INT64', status: 'STRING', amount: 'NUMERIC' },
};

const SCHEMA: Schema = [
  { id: 'id', type: 'int64' },
  { id: 'status', type: 'utf8' },
  { id: 'amount', type: 'decimal' },
];

function fakeClient(
  ...batch: ReadonlyArray<ReadonlyArray<Record<string, unknown>>>
): BigQueryQueryable & { job: BigQueryJobRequest[] } {
  const job: BigQueryJobRequest[] = [];
  let call = 0;
  return {
    job,
    query(req) {
      job.push(req);
      const row = batch[call] ?? [];
      call++;
      return Promise.resolve({ row });
    },
  };
}

function req(override: Partial<BlockRequest> = {}): BlockRequest {
  return { cursor: null, direction: 'after', limit: 2, sort: [], filter: null, ...override };
}

describe('createBigQueryDataSource', () => {
  it('returns the injected schema without running a job', async () => {
    const client = fakeClient([]);
    const ds = createBigQueryDataSource({ client, table: TABLE, schema: SCHEMA });
    expect(await ds.schema()).toBe(SCHEMA);
    expect(client.job).toHaveLength(0);
  });

  it('submits the compiled SQL with its parameters and declared types', async () => {
    const client = fakeClient([{ id: 1, status: 'open', amount: 5 }]);
    const ds = createBigQueryDataSource({ client, table: TABLE, schema: SCHEMA });
    const res = await ds.fetchBlock(
      req({ filter: { type: 'comparison', columnId: 'status', op: 'eq', value: 'open' } }),
    );
    expect(res.encoding).toBe('json');
    expect(res.rows).toEqual([{ id: 1, status: 'open', amount: 5 }]);
    expect(client.job[0]!.sql).toContain('`status` = @p0');
    expect(client.job[0]!.params).toEqual({ p0: 'open' });
    expect(client.job[0]!.paramType).toEqual({ p0: 'STRING' });
  });

  it('forwards the location and byte ceiling on every job', async () => {
    const client = fakeClient([{ id: 1, status: 'a', amount: 1 }]);
    const ds = createBigQueryDataSource({
      client,
      table: TABLE,
      schema: SCHEMA,
      location: 'asia-northeast1',
      maximumBytesBilled: '1000000000',
    });
    await ds.fetchBlock(req());
    expect(client.job[0]!.location).toBe('asia-northeast1');
    expect(client.job[0]!.maximumBytesBilled).toBe('1000000000');
  });

  it('applies the standing partition filter to every block', async () => {
    const client = fakeClient([{ id: 1, status: 'a', amount: 1 }]);
    const ds = createBigQueryDataSource({
      client,
      table: { ...TABLE, partitionPseudoColumn: '_PARTITIONTIME' },
      schema: SCHEMA,
      partitionFilter: { from: '2026-01-01T00:00:00.000Z' },
    });
    await ds.fetchBlock(req());
    expect(client.job[0]!.sql).toContain('WHERE _PARTITIONTIME >= TIMESTAMP(@p0)');
    expect(client.job[0]!.params).toEqual({ p0: '2026-01-01T00:00:00.000Z' });
  });

  it('emits a next cursor only when the block came back full', async () => {
    const full = fakeClient([
      { id: 1, status: 'a', amount: 1 },
      { id: 2, status: 'b', amount: 2 },
    ]);
    const short = fakeClient([{ id: 1, status: 'a', amount: 1 }]);
    const dsFull = createBigQueryDataSource({ client: full, table: TABLE, schema: SCHEMA });
    const dsShort = createBigQueryDataSource({ client: short, table: TABLE, schema: SCHEMA });

    const fullRes = await dsFull.fetchBlock(req());
    const shortRes = await dsShort.fetchBlock(req());
    expect(decodeKeysetCursor(fullRes.nextCursor!)).toEqual({ sortValues: [], rowId: 2 });
    expect(shortRes.nextCursor).toBeNull();
    expect(fullRes.prevCursor).toBeNull();
  });

  it('paginates continuously: the cursor from block 1 filters block 2', async () => {
    const client = fakeClient(
      [
        { id: 1, status: 'a', amount: 10 },
        { id: 2, status: 'b', amount: 20 },
      ],
      [
        { id: 3, status: 'c', amount: 30 },
        { id: 4, status: 'd', amount: 40 },
      ],
    );
    const ds = createBigQueryDataSource({ client, table: TABLE, schema: SCHEMA });
    const sort: BlockRequest['sort'] = [{ columnId: 'amount', direction: 'asc' }];

    const first = await ds.fetchBlock(req({ sort }));
    expect(client.job[0]!.sql).not.toContain('WHERE');

    const second = await ds.fetchBlock(req({ sort, cursor: first.nextCursor }));
    expect(client.job[1]!.sql).toContain(
      '(`amount` > @p0 OR (`amount` = @p1 AND `id` > @p2))',
    );
    expect(client.job[1]!.params).toEqual({ p0: 20, p1: 20, p2: 2 });
    expect(decodeKeysetCursor(second.prevCursor!)).toEqual({ sortValues: [30], rowId: 3 });
  });

  it('unwraps the BigQueryInt-style { value } wrapper in cursors', async () => {
    const client = fakeClient([
      { id: { value: '9007199254740991' }, status: 'a', amount: { value: '1.5' } },
      { id: { value: '9007199254740993' }, status: 'b', amount: { value: '2.5' } },
    ]);
    const ds = createBigQueryDataSource({ client, table: TABLE, schema: SCHEMA });
    const res = await ds.fetchBlock(req({ sort: [{ columnId: 'amount', direction: 'asc' }] }));
    expect(decodeKeysetCursor(res.nextCursor!)).toEqual({
      sortValues: ['2.5'],
      rowId: '9007199254740993',
    });
  });

  it('keeps an INT64 row id exact by stringifying the BigInt', async () => {
    const wide = 9007199254740993n; // 2^53 + 1 — the first unrepresentable odd integer
    const client = fakeClient([
      { id: wide, status: 'a', amount: 1 },
      { id: wide + 2n, status: 'b', amount: 2 },
    ]);
    const ds = createBigQueryDataSource({ client, table: TABLE, schema: SCHEMA });
    const res = await ds.fetchBlock(req());
    const rowId = decodeKeysetCursor(res.nextCursor!).rowId;
    expect(rowId).toBe('9007199254740995');
    expect(BigInt(rowId)).toBe(wide + 2n);
    expect(String(Number(rowId))).not.toBe(rowId);
  });

  it('throws when the primary key is missing from the result rows', async () => {
    const client = fakeClient([{ status: 'a' }, { status: 'b' }]);
    const ds = createBigQueryDataSource({ client, table: TABLE, schema: SCHEMA });
    await expect(ds.fetchBlock(req())).rejects.toThrow(/primary key "id"/);
  });

  it('treats a legacy offset cursor as a first-block request', async () => {
    const client = fakeClient([{ id: 1, status: 'a', amount: 1 }]);
    const ds = createBigQueryDataSource({ client, table: TABLE, schema: SCHEMA });
    await ds.fetchBlock(req({ cursor: 'offset:200' }));
    expect(client.job[0]!.sql).not.toContain('WHERE');
  });

  it('echoes the requestId onto the job and the response', async () => {
    const client = fakeClient([{ id: 1, status: 'a', amount: 1 }]);
    const ds = createBigQueryDataSource({ client, table: TABLE, schema: SCHEMA });
    const res = await ds.fetchBlock(req({ requestId: 'block-7' }));
    expect(client.job[0]!.requestId).toBe('block-7');
    expect(res.requestId).toBe('block-7');
  });
});
