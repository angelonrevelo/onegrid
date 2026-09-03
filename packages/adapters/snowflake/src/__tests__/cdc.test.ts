// =============================================================================
// Snowflake STREAM CDC — unit tests. Driven through the exposed
// `poll()` so the assertions are deterministic; the timer path is
// exercised separately with injected timer stubs.
// =============================================================================

import { describe, expect, it, vi } from 'vitest';
import type { RowDiff } from '@onegrid/protocol';
import {
  createSnowflakeCdcAdapter,
  createStreamStatement,
  streamHasDataStatement,
} from '../cdc';
import type { SnowflakeQueryable, SnowflakeStatement } from '../datasource';

function streamClient(
  ...batch: ReadonlyArray<ReadonlyArray<Record<string, unknown>>>
): SnowflakeQueryable & { statement: SnowflakeStatement[] } {
  const statement: SnowflakeStatement[] = [];
  let drain = 0;
  return {
    statement,
    execute(stmt) {
      statement.push(stmt);
      if (stmt.sql.includes('SYSTEM$STREAM_HAS_DATA')) {
        return Promise.resolve({ row: [{ HAS_DATA: (batch[drain]?.length ?? 0) > 0 }] });
      }
      if (stmt.sql.startsWith('CREATE OR REPLACE TEMPORARY TABLE')) {
        return Promise.resolve({ row: [] });
      }
      const row = batch[drain] ?? [];
      drain++;
      return Promise.resolve({ row });
    },
  };
}

/** A no-op timer pair: these tests drive the loop by hand, so the
 *  adapter must never leave a real interval behind. */
const NOOP_TIMER = {
  setTimeoutImpl: (() => 0) as unknown as typeof setTimeout,
  clearTimeoutImpl: (() => undefined) as unknown as typeof clearTimeout,
};

/** Let the adapter's kick-on-first-subscribe drain complete. */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

const INSERT_ROW = {
  'METADATA$ACTION': 'INSERT',
  'METADATA$ISUPDATE': false,
  'METADATA$ROW_ID': 'r1',
  id: 1,
  status: 'open',
};

describe('createSnowflakeCdcAdapter', () => {
  it('probes SYSTEM$STREAM_HAS_DATA before spending a warehouse query', async () => {
    const client = streamClient([]);
    const cdc = createSnowflakeCdcAdapter({
      client,
      stream: 'ANALYTICS.PUBLIC.ORDER_STREAM',
      primaryKey: 'id',
    });
    const emitted = await cdc.poll();
    expect(emitted).toBe(0);
    expect(client.statement).toHaveLength(1);
    expect(client.statement[0]!.sql).toBe(
      'SELECT SYSTEM$STREAM_HAS_DATA(\'ANALYTICS.PUBLIC.ORDER_STREAM\') AS "HAS_DATA"',
    );
  });

  it('drains through a temp table so the stream offset actually advances', async () => {
    const client = streamClient([INSERT_ROW]);
    const cdc = createSnowflakeCdcAdapter({
      client,
      stream: 'DB.SCH.ORDER_STREAM',
      primaryKey: 'id',
      ...NOOP_TIMER,
    });
    const seen: RowDiff[] = [];
    cdc.subscribe((d) => seen.push(d));
    await flush();
    const sqlText = client.statement.map((s) => s.sql);
    expect(sqlText[1]).toBe(
      'CREATE OR REPLACE TEMPORARY TABLE "ONEGRID_STREAM_CONSUME" AS SELECT * FROM "DB"."SCH"."ORDER_STREAM"',
    );
    expect(sqlText[2]).toContain('SELECT * FROM "ONEGRID_STREAM_CONSUME" LIMIT 1000');
    expect(seen).toEqual([
      { kind: 'insert', version: 1, pkey: 1, fields: { id: 1, status: 'open' } },
    ]);
    await cdc.close();
  });

  it('peek mode reads the stream directly without advancing it', async () => {
    const client = streamClient([INSERT_ROW]);
    const cdc = createSnowflakeCdcAdapter({
      client,
      stream: 'DB.SCH.ORDER_STREAM',
      primaryKey: 'id',
      consume: 'peek',
      pollLimit: 25,
    });
    await cdc.poll();
    expect(client.statement.some((s) => s.sql.includes('CREATE OR REPLACE'))).toBe(false);
    expect(client.statement[1]!.sql).toBe(
      'SELECT * FROM "DB"."SCH"."ORDER_STREAM" LIMIT 25',
    );
  });

  it('collapses the DELETE+INSERT pair Snowflake emits for an update', async () => {
    const client = streamClient([
      {
        'METADATA$ACTION': 'DELETE',
        'METADATA$ISUPDATE': true,
        'METADATA$ROW_ID': 'r1',
        id: 1,
        status: 'open',
      },
      {
        'METADATA$ACTION': 'INSERT',
        'METADATA$ISUPDATE': true,
        'METADATA$ROW_ID': 'r1',
        id: 1,
        status: 'shipped',
      },
    ]);
    const cdc = createSnowflakeCdcAdapter({
      client,
      stream: 'DB.SCH.ORDER_STREAM',
      primaryKey: 'id',
    });
    const seen: RowDiff[] = [];
    cdc.subscribe((d) => seen.push(d));
    await flush();
    expect(seen).toEqual([
      { kind: 'update', version: 1, pkey: 1, fields: { id: 1, status: 'shipped' } },
    ]);
    await cdc.close();
  });

  it('maps a real delete to a delete diff with no fields', async () => {
    const client = streamClient([
      {
        'METADATA$ACTION': 'DELETE',
        'METADATA$ISUPDATE': false,
        'METADATA$ROW_ID': 'r9',
        id: 9,
        status: 'open',
      },
    ]);
    const cdc = createSnowflakeCdcAdapter({
      client,
      stream: 'DB.SCH.ORDER_STREAM',
      primaryKey: 'id',
      startVersion: 40,
      ...NOOP_TIMER,
    });
    const seen: RowDiff[] = [];
    cdc.subscribe((d) => seen.push(d));
    await flush();
    expect(seen).toEqual([{ kind: 'delete', version: 41, pkey: 9 }]);
    await cdc.close();
  });

  it('assigns strictly increasing versions across drains', async () => {
    const client = streamClient([INSERT_ROW, INSERT_ROW], [INSERT_ROW]);
    const cdc = createSnowflakeCdcAdapter({
      client,
      stream: 'DB.SCH.ORDER_STREAM',
      primaryKey: 'id',
    });
    const seen: RowDiff[] = [];
    cdc.subscribe((d) => seen.push(d));
    await flush();
    await cdc.poll();
    expect(seen.map((d) => d.version)).toEqual([1, 2, 3]);
    await cdc.close();
  });

  it('stringifies a wide BigInt pkey rather than rounding it', async () => {
    const client = streamClient([
      { ...INSERT_ROW, id: 12345678901234567890n, amount: 7n },
    ]);
    const cdc = createSnowflakeCdcAdapter({
      client,
      stream: 'DB.SCH.ORDER_STREAM',
      primaryKey: 'id',
    });
    const seen: RowDiff[] = [];
    cdc.subscribe((d) => seen.push(d));
    await flush();
    expect(seen[0]!.pkey).toBe('12345678901234567890');
    expect(seen[0]!.fields).toEqual({
      id: '12345678901234567890',
      status: 'open',
      amount: '7',
    });
    await cdc.close();
  });

  it('unsubscribing the last subscriber stops the poll timer', async () => {
    const client = streamClient([]);
    const setTimeoutImpl = vi.fn(() => 7 as unknown as ReturnType<typeof setTimeout>);
    const clearTimeoutImpl = vi.fn();
    const cdc = createSnowflakeCdcAdapter({
      client,
      stream: 'DB.SCH.ORDER_STREAM',
      primaryKey: 'id',
      setTimeoutImpl: setTimeoutImpl as unknown as typeof setTimeout,
      clearTimeoutImpl: clearTimeoutImpl as unknown as typeof clearTimeout,
    });
    const off = cdc.subscribe(() => undefined);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(setTimeoutImpl).toHaveBeenCalled();
    off();
    expect(clearTimeoutImpl).toHaveBeenCalledWith(7);
    await cdc.close();
  });

  it('answers snapshot: true when no durable replay source is configured', async () => {
    const client = streamClient([]);
    const cdc = createSnowflakeCdcAdapter({
      client,
      stream: 'DB.SCH.ORDER_STREAM',
      primaryKey: 'id',
      startVersion: 12,
    });
    const res = await cdc.resync({ fromVersion: 3 });
    expect(res).toEqual({ fromVersion: 3, toVersion: 12, diffs: [], snapshot: true });
  });

  it('replays through resyncQuery and falls back to a snapshot past the window', async () => {
    const client = streamClient([]);
    const diff: RowDiff[] = [
      { kind: 'insert', version: 4, pkey: 1 },
      { kind: 'update', version: 5, pkey: 1, fields: { status: 'shipped' } },
    ];
    const cdc = createSnowflakeCdcAdapter({
      client,
      stream: 'DB.SCH.ORDER_STREAM',
      primaryKey: 'id',
      resyncQuery: () => Promise.resolve(diff),
    });
    expect(await cdc.resync({ fromVersion: 3 })).toEqual({
      fromVersion: 3,
      toVersion: 5,
      diffs: diff,
    });

    const tight = createSnowflakeCdcAdapter({
      client,
      stream: 'DB.SCH.ORDER_STREAM',
      primaryKey: 'id',
      maxResyncDiffs: 1,
      resyncQuery: () => Promise.resolve(diff),
    });
    expect(await tight.resync({ fromVersion: 3 })).toEqual({
      fromVersion: 3,
      toVersion: 5,
      diffs: [],
      snapshot: true,
    });
  });

  it('rejects a stream name that is not a bare qualified identifier', () => {
    const client = streamClient([]);
    expect(() =>
      createSnowflakeCdcAdapter({
        client,
        stream: "DB.SCH.S') OR SYSTEM$ABORT_SESSION(1) --",
        primaryKey: 'id',
      }),
    ).toThrow(/not a valid identifier/);
    expect(() => streamHasDataStatement('a b')).toThrow(/not a valid identifier/);
  });
});

describe('createStreamStatement', () => {
  it('emits CREATE STREAM DDL with the requested options', () => {
    expect(
      createStreamStatement({
        stream: 'DB.SCH.ORDER_STREAM',
        sourceTable: 'DB.SCH.ORDER',
        showInitialRow: true,
      }),
    ).toEqual({
      sql: 'CREATE STREAM IF NOT EXISTS "DB"."SCH"."ORDER_STREAM" ON TABLE "DB"."SCH"."ORDER" SHOW_INITIAL_ROWS = TRUE',
      bind: [],
    });
    expect(
      createStreamStatement({
        stream: 'S',
        sourceTable: 'T',
        appendOnly: true,
      }).sql,
    ).toBe('CREATE STREAM IF NOT EXISTS "S" ON TABLE "T" APPEND_ONLY = TRUE');
  });

  it('validates both identifiers', () => {
    expect(() =>
      createStreamStatement({ stream: 'ok', sourceTable: 'bad"; DROP TABLE x' }),
    ).toThrow(/not a valid identifier/);
  });
});
