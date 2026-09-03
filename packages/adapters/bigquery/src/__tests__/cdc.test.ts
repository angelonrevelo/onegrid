// =============================================================================
// BigQuery outbox CDC — unit tests. The partition predicate is the
// assertion that matters most: without it the poll query full-scans an
// ever-growing outbox on every tick, which is a cost bug that only
// shows up on the invoice.
// =============================================================================

import { describe, expect, it, vi } from 'vitest';
import type { RowDiff } from '@onegrid/protocol';
import { createBqCdcAdapter, createOutboxStatement } from '../cdc';
import type { BigQueryJobRequest, BigQueryQueryable } from '../datasource';

function outboxClient(
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

const NOOP_TIMER = {
  setTimeoutImpl: (() => 0) as unknown as typeof setTimeout,
  clearTimeoutImpl: (() => undefined) as unknown as typeof clearTimeout,
};

const BASE = {
  project: 'acme-analytics',
  dataset: 'warehouse',
  nowImpl: () => Date.parse('2026-01-02T00:10:00.000Z'),
  ...NOOP_TIMER,
};

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

describe('createBqCdcAdapter', () => {
  it('prunes the poll query by ingestion time before filtering by version', async () => {
    const client = outboxClient([]);
    const cdc = createBqCdcAdapter({ client, ...BASE });
    await cdc.poll();
    expect(client.job[0]!.sql).toBe(
      'SELECT `version`, `kind`, `pkey`, `fields` FROM `acme-analytics.warehouse.onegrid_outbox`' +
        ' WHERE _PARTITIONTIME >= TIMESTAMP(@since) AND `version` > @fromVersion' +
        ' ORDER BY `version` LIMIT 1000',
    );
    // Default 10-minute lookback, measured from the injected clock.
    expect(client.job[0]!.params).toEqual({
      since: '2026-01-02T00:00:00.000Z',
      fromVersion: -1,
    });
    expect(client.job[0]!.paramType).toEqual({ since: 'TIMESTAMP', fromVersion: 'INT64' });
  });

  it('honours a custom outbox table, lookback, poll limit and pseudo-column', async () => {
    const client = outboxClient([]);
    const cdc = createBqCdcAdapter({
      client,
      ...BASE,
      outboxTable: 'order_change',
      partitionPseudoColumn: '_PARTITIONDATE',
      lookbackMs: 60_000,
      pollLimit: 25,
      startVersion: 100,
      location: 'EU',
    });
    await cdc.poll();
    expect(client.job[0]!.sql).toContain('`acme-analytics.warehouse.order_change`');
    expect(client.job[0]!.sql).toContain('_PARTITIONDATE >= DATE(@since)');
    expect(client.job[0]!.sql).toContain('LIMIT 25');
    expect(client.job[0]!.params).toEqual({
      since: '2026-01-02T00:09:00.000Z',
      fromVersion: 100,
    });
    expect(client.job[0]!.location).toBe('EU');
  });

  it('emits insert / update / delete diffs and advances the version watermark', async () => {
    const client = outboxClient(
      [
        { version: 1, kind: 'insert', pkey: 'a', fields: '{"status":"open"}' },
        { version: 2, kind: 'update', pkey: 'a', fields: { status: 'shipped' } },
        { version: 3, kind: 'delete', pkey: 'a' },
      ],
      [],
    );
    const cdc = createBqCdcAdapter({ client, ...BASE });
    const seen: RowDiff[] = [];
    cdc.subscribe((d) => seen.push(d));
    await flush();
    expect(seen).toEqual([
      { kind: 'insert', version: 1, pkey: 'a', fields: { status: 'open' } },
      { kind: 'update', version: 2, pkey: 'a', fields: { status: 'shipped' } },
      { kind: 'delete', version: 3, pkey: 'a' },
    ]);
    await cdc.poll();
    expect(client.job[1]!.params.fromVersion).toBe(3);
    await cdc.close();
  });

  it('unwraps an INT64 version arriving as a BigInt or a { value } wrapper', async () => {
    const client = outboxClient([
      { version: 7n, kind: 'insert', pkey: 1 },
      { version: { value: '8' }, kind: 'insert', pkey: 2n },
    ]);
    const cdc = createBqCdcAdapter({ client, ...BASE });
    const seen: RowDiff[] = [];
    cdc.subscribe((d) => seen.push(d));
    await flush();
    expect(seen).toEqual([
      { kind: 'insert', version: 7, pkey: 1 },
      { kind: 'insert', version: 8, pkey: '2' },
    ]);
    await cdc.close();
  });

  it('drops unusable rows instead of crashing the poll loop', async () => {
    const client = outboxClient([
      { version: 1, kind: 'nonsense', pkey: 'a' },
      { version: null, kind: 'insert', pkey: 'a' },
      { version: 4, kind: 'insert', pkey: { not: 'a key' } },
      { version: 5, kind: 'insert', pkey: 'b', fields: 'not json' },
    ]);
    const cdc = createBqCdcAdapter({ client, ...BASE });
    const seen: RowDiff[] = [];
    cdc.subscribe((d) => seen.push(d));
    await flush();
    expect(seen).toEqual([{ kind: 'insert', version: 5, pkey: 'b' }]);
    await cdc.close();
  });

  it('keeps polling after a failed job rather than dying', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const setTimeoutImpl = vi.fn(() => 3 as unknown as ReturnType<typeof setTimeout>);
    const client: BigQueryQueryable = {
      query: () => Promise.reject(new Error('rateLimitExceeded')),
    };
    const cdc = createBqCdcAdapter({
      client,
      project: 'p',
      dataset: 'd',
      setTimeoutImpl: setTimeoutImpl as unknown as typeof setTimeout,
      clearTimeoutImpl: (() => undefined) as unknown as typeof clearTimeout,
    });
    cdc.subscribe(() => undefined);
    await flush();
    expect(setTimeoutImpl).toHaveBeenCalled();
    expect(err).toHaveBeenCalled();
    err.mockRestore();
    await cdc.close();
  });

  it('unsubscribing the last subscriber clears the poll timer', async () => {
    const client = outboxClient([]);
    const setTimeoutImpl = vi.fn(() => 9 as unknown as ReturnType<typeof setTimeout>);
    const clearTimeoutImpl = vi.fn();
    const cdc = createBqCdcAdapter({
      client,
      project: 'p',
      dataset: 'd',
      setTimeoutImpl: setTimeoutImpl as unknown as typeof setTimeout,
      clearTimeoutImpl: clearTimeoutImpl as unknown as typeof clearTimeout,
    });
    const off = cdc.subscribe(() => undefined);
    await flush();
    off();
    expect(clearTimeoutImpl).toHaveBeenCalledWith(9);
    await cdc.close();
  });

  it('resyncs by replaying the outbox from the requested version', async () => {
    const client = outboxClient([
      { version: 4, kind: 'insert', pkey: 'a' },
      { version: 5, kind: 'update', pkey: 'a', fields: { status: 'shipped' } },
    ]);
    const cdc = createBqCdcAdapter({ client, ...BASE });
    expect(await cdc.resync({ fromVersion: 3 })).toEqual({
      fromVersion: 3,
      toVersion: 5,
      diffs: [
        { kind: 'insert', version: 4, pkey: 'a' },
        { kind: 'update', version: 5, pkey: 'a', fields: { status: 'shipped' } },
      ],
    });
    expect(client.job[0]!.params.fromVersion).toBe(3);
    expect(client.job[0]!.sql).toContain('LIMIT 10001');
  });

  it('answers snapshot: true when the gap exceeds the replay window', async () => {
    const client = outboxClient([
      { version: 4, kind: 'insert', pkey: 'a' },
      { version: 5, kind: 'insert', pkey: 'b' },
    ]);
    const cdc = createBqCdcAdapter({ client, ...BASE, maxResyncDiffs: 1 });
    expect(await cdc.resync({ fromVersion: 3 })).toEqual({
      fromVersion: 3,
      toVersion: 5,
      diffs: [],
      snapshot: true,
    });
  });

  it('rejects an outbox path that is not a valid BigQuery identifier', () => {
    const client = outboxClient([]);
    expect(() =>
      createBqCdcAdapter({ client, project: 'p', dataset: 'd', outboxTable: 'o`) UNION (' }),
    ).toThrow(/not a valid BigQuery identifier/);
  });
});

describe('createOutboxStatement', () => {
  it('emits ingestion-time-partitioned DDL with optional expiry', () => {
    expect(
      createOutboxStatement({ project: 'acme-analytics', dataset: 'warehouse' }),
    ).toBe(
      'CREATE TABLE IF NOT EXISTS `acme-analytics.warehouse.onegrid_outbox` ' +
        '(`version` INT64 NOT NULL, `kind` STRING NOT NULL, `pkey` STRING NOT NULL, `fields` JSON) ' +
        'PARTITION BY DATE(_PARTITIONTIME)',
    );
    expect(
      createOutboxStatement({
        project: 'p',
        dataset: 'd',
        outboxTable: 'ob',
        partitionExpirationDay: 7,
      }),
    ).toContain('OPTIONS (partition_expiration_days = 7)');
  });

  it('validates the path and the expiry', () => {
    expect(() => createOutboxStatement({ project: 'p!', dataset: 'd' })).toThrow(
      /not a valid BigQuery identifier/,
    );
    expect(() =>
      createOutboxStatement({ project: 'p', dataset: 'd', partitionExpirationDay: 0 }),
    ).toThrow(/positive safe integer/);
  });
});
