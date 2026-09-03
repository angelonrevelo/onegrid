// =============================================================================
// Mapping → Schema translation, and CDC polling.
//
// The mapping tests care most about the two places a naive translation loses
// information: 64-bit integers silently becoming float64, and nested/object
// containers collapsing into an opaque scalar.
// =============================================================================

import { describe, expect, it } from 'vitest';
import type { RowDiff } from '@onegrid/protocol';
import {
  descriptorFromMapping,
  elasticsearchTypeToColumnType,
  mappingToFieldList,
  mappingToNestedPath,
  mappingToSchema,
  type ElasticsearchMapping,
} from '../schema';
import { createElasticsearchCdcAdapter, type CdcScheduler } from '../cdc';
import type { ElasticsearchQueryable, ElasticsearchSearchResponse } from '../datasource';

const MAPPING: ElasticsearchMapping = {
  properties: {
    order_id: { type: 'keyword' },
    title: { type: 'text', fields: { keyword: { type: 'keyword' } } },
    quantity: { type: 'long' },
    ratio: { type: 'double' },
    price: { type: 'scaled_float', scaling_factor: 100 },
    active: { type: 'boolean' },
    '@timestamp': { type: 'date' },
    location: { type: 'geo_point' },
    payload: { type: 'binary' },
    address: {
      properties: {
        city: { type: 'keyword' },
        zip: { type: 'keyword' },
      },
    },
    line: {
      type: 'nested',
      properties: {
        sku: { type: 'keyword' },
        qty: { type: 'integer' },
      },
    },
  },
};

describe('mappingToSchema', () => {
  it('keeps 64-bit integers off the float64 path', () => {
    expect(elasticsearchTypeToColumnType('long')).toBe('int64');
    expect(elasticsearchTypeToColumnType('unsigned_long')).toBe('uint64');
    expect(elasticsearchTypeToColumnType('double')).toBe('float64');
    expect(elasticsearchTypeToColumnType('float')).toBe('float32');
    expect(elasticsearchTypeToColumnType('scaled_float')).toBe('decimal');
  });

  it('translates the core scalar types', () => {
    const schema = mappingToSchema(MAPPING);
    const byId = Object.fromEntries(schema.map((c) => [c.id, c.type]));
    expect(byId).toMatchObject({
      order_id: 'utf8',
      title: 'utf8',
      quantity: 'int64',
      ratio: 'float64',
      price: 'decimal',
      active: 'bool',
      '@timestamp': 'timestamp',
      payload: 'binary',
    });
  });

  it('marks every column nullable, because ES has no NOT NULL', () => {
    expect(mappingToSchema(MAPPING).every((c) => c.nullable === true)).toBe(true);
  });

  it('gives object and nested containers struct children', () => {
    const schema = mappingToSchema(MAPPING);
    const address = schema.find((c) => c.id === 'address')!;
    expect(address.type).toBe('struct');
    expect(address.children?.map((c) => c.id)).toEqual(['city', 'zip']);
    const line = schema.find((c) => c.id === 'line')!;
    expect(line.type).toBe('struct');
    expect(line.children?.map((c) => c.type)).toEqual(['utf8', 'int32']);
  });

  it('synthesises lat/lon children for geo_point, which has no properties', () => {
    const location = mappingToSchema(MAPPING).find((c) => c.id === 'location')!;
    expect(location.type).toBe('struct');
    expect(location.children).toEqual([
      { id: 'lat', type: 'float64' },
      { id: 'lon', type: 'float64' },
    ]);
  });

  it('falls back to unknown for a type it has never heard of', () => {
    expect(elasticsearchTypeToColumnType('sparse_vector')).toBe('unknown');
  });
});

describe('mappingToFieldList / nested paths / descriptorFromMapping', () => {
  it('flattens nested properties into dotted, queryable field ids', () => {
    const field = mappingToFieldList(MAPPING);
    expect(field).toContain('address');
    expect(field).toContain('address.city');
    expect(field).toContain('line.sku');
    expect(field).toContain('title.keyword');
  });

  it('lists nested paths separately from plain objects', () => {
    expect(mappingToNestedPath(MAPPING)).toEqual(['line']);
  });

  it('routes text fields with a keyword multi-field to .keyword for exact ops', () => {
    const descriptor = descriptorFromMapping('order', MAPPING, 'order_id');
    expect(descriptor.index).toBe('order');
    expect(descriptor.primaryKey).toBe('order_id');
    expect(descriptor.keywordSubfield).toEqual(['title']);
    expect(descriptor.field).toContain('quantity');
  });
});

// -----------------------------------------------------------------------------
// CDC
// -----------------------------------------------------------------------------

interface FakePoll {
  readonly client: ElasticsearchQueryable;
  readonly body: Record<string, unknown>[];
  push(...hit: { _source: Record<string, unknown> }[]): void;
}

function createPollingCluster(): FakePoll {
  const body: Record<string, unknown>[] = [];
  const queue: { _source: Record<string, unknown> }[][] = [];
  const client: ElasticsearchQueryable = {
    search(request) {
      body.push(request.body);
      const batch = queue.shift() ?? [];
      const response: ElasticsearchSearchResponse = {
        hits: {
          hits: batch.map((h) => ({
            _source: h._source,
            sort: [h._source['@timestamp'], h._source.order_id],
          })),
        },
      };
      return Promise.resolve(response);
    },
  };
  return {
    client,
    body,
    push(...hit) {
      queue.push(hit);
    },
  };
}

const IMMEDIATE_SCHEDULER: CdcScheduler = {
  setInterval: () => 'handle',
  clearInterval: () => undefined,
};

describe('createElasticsearchCdcAdapter', () => {
  it('emits one diff per polled document with monotonic versions', async () => {
    const cluster = createPollingCluster();
    cluster.push(
      { _source: { order_id: 'a1', '@timestamp': 1, status: 'new' } },
      { _source: { order_id: 'a2', '@timestamp': 2, status: 'new' } },
    );
    const cdc = createElasticsearchCdcAdapter({
      client: cluster.client,
      index: 'order',
      watermarkField: '@timestamp',
      primaryKey: 'order_id',
      scheduler: IMMEDIATE_SCHEDULER,
    });
    const seen: RowDiff[] = [];
    cdc.subscribe((d) => seen.push(d));
    await cdc.poll();
    expect(seen.map((d) => d.pkey)).toEqual(['a1', 'a2']);
    expect(seen.map((d) => d.version)).toEqual([0, 1]);
    expect(seen[0]!.fields).toEqual({ order_id: 'a1', '@timestamp': 1, status: 'new' });
    cdc.close();
  });

  it('advances the watermark and resumes with search_after on the next poll', async () => {
    const cluster = createPollingCluster();
    cluster.push({ _source: { order_id: 'a1', '@timestamp': 5 } });
    cluster.push({ _source: { order_id: 'a2', '@timestamp': 9 } });
    const cdc = createElasticsearchCdcAdapter({
      client: cluster.client,
      index: 'order',
      watermarkField: '@timestamp',
      primaryKey: 'order_id',
      scheduler: IMMEDIATE_SCHEDULER,
    });
    cdc.subscribe(() => undefined);
    await cdc.poll();
    expect(cdc.lastWatermark()).toBe(5);
    await cdc.poll();
    expect(cdc.lastWatermark()).toBe(9);
    // First poll has no anchor, so it must not filter at all.
    expect(cluster.body[0]!.query).toEqual({ match_all: {} });
    // Second poll resumes inclusively, relying on search_after to walk past
    // the part of the boundary tie it already delivered.
    expect(cluster.body[1]!.search_after).toEqual([5, 'a1']);
    expect(cluster.body[1]!.query).toEqual({
      bool: { filter: [{ range: { '@timestamp': { gte: 5 } } }] },
    });
    cdc.close();
  });

  it('uses an exclusive range on a cold start from a persisted watermark', async () => {
    const cluster = createPollingCluster();
    cluster.push({ _source: { order_id: 'a9', '@timestamp': 100 } });
    const cdc = createElasticsearchCdcAdapter({
      client: cluster.client,
      index: 'order',
      watermarkField: '@timestamp',
      primaryKey: 'order_id',
      startAfter: 42,
      scheduler: IMMEDIATE_SCHEDULER,
    });
    cdc.subscribe(() => undefined);
    await cdc.poll();
    expect(cluster.body[0]!.query).toEqual({
      bool: { filter: [{ range: { '@timestamp': { gt: 42 } } }] },
    });
    cdc.close();
  });

  it('classifies a first-write as insert when createdField is configured', async () => {
    const cluster = createPollingCluster();
    cluster.push(
      { _source: { order_id: 'a1', '@timestamp': 7, created_at: 7 } },
      { _source: { order_id: 'a2', '@timestamp': 7, created_at: 3 } },
    );
    const cdc = createElasticsearchCdcAdapter({
      client: cluster.client,
      index: 'order',
      watermarkField: '@timestamp',
      primaryKey: 'order_id',
      createdField: 'created_at',
      scheduler: IMMEDIATE_SCHEDULER,
    });
    const seen: RowDiff[] = [];
    cdc.subscribe((d) => seen.push(d));
    await cdc.poll();
    expect(seen.map((d) => d.kind)).toEqual(['insert', 'update']);
    cdc.close();
  });

  it('emits a delete for a soft-deleted document and drops its fields', async () => {
    const cluster = createPollingCluster();
    cluster.push({ _source: { order_id: 'a1', '@timestamp': 1, deleted: true } });
    const cdc = createElasticsearchCdcAdapter({
      client: cluster.client,
      index: 'order',
      watermarkField: '@timestamp',
      primaryKey: 'order_id',
      softDeleteField: 'deleted',
      scheduler: IMMEDIATE_SCHEDULER,
    });
    const seen: RowDiff[] = [];
    cdc.subscribe((d) => seen.push(d));
    await cdc.poll();
    expect(seen[0]).toEqual({ kind: 'delete', version: 0, pkey: 'a1' });
    cdc.close();
  });

  it('replays retained history on resync and snapshots when the gap is too old', async () => {
    const cluster = createPollingCluster();
    cluster.push(
      { _source: { order_id: 'a1', '@timestamp': 1 } },
      { _source: { order_id: 'a2', '@timestamp': 2 } },
      { _source: { order_id: 'a3', '@timestamp': 3 } },
    );
    const cdc = createElasticsearchCdcAdapter({
      client: cluster.client,
      index: 'order',
      watermarkField: '@timestamp',
      primaryKey: 'order_id',
      historySize: 2,
      scheduler: IMMEDIATE_SCHEDULER,
    });
    cdc.subscribe(() => undefined);
    await cdc.poll();
    // History retained versions 1 and 2; version 0 has been evicted.
    const replay = await cdc.resync({ fromVersion: 1 });
    expect(replay.diffs.map((d) => d.version)).toEqual([2]);
    expect(replay.snapshot).toBeUndefined();
    const stale = await cdc.resync({ fromVersion: -1 });
    expect(stale.snapshot).toBe(true);
    expect(stale.diffs).toEqual([]);
    cdc.close();
  });

  it('reports a poll failure through onError instead of rejecting', async () => {
    const failing: ElasticsearchQueryable = {
      search: () => Promise.reject(new Error('cluster_block_exception')),
    };
    const error: unknown[] = [];
    const cdc = createElasticsearchCdcAdapter({
      client: failing,
      index: 'order',
      watermarkField: '@timestamp',
      primaryKey: 'order_id',
      onError: (e) => error.push(e),
      scheduler: IMMEDIATE_SCHEDULER,
    });
    cdc.subscribe(() => undefined);
    await expect(cdc.poll()).resolves.toBe(0);
    expect((error[0] as Error).message).toBe('cluster_block_exception');
    cdc.close();
  });

  it('stops delivering after unsubscribe and after close', async () => {
    const cluster = createPollingCluster();
    cluster.push({ _source: { order_id: 'a1', '@timestamp': 1 } });
    cluster.push({ _source: { order_id: 'a2', '@timestamp': 2 } });
    const cdc = createElasticsearchCdcAdapter({
      client: cluster.client,
      index: 'order',
      watermarkField: '@timestamp',
      primaryKey: 'order_id',
      scheduler: IMMEDIATE_SCHEDULER,
    });
    const seen: RowDiff[] = [];
    const off = cdc.subscribe((d) => seen.push(d));
    await cdc.poll();
    off();
    await cdc.poll();
    expect(seen).toHaveLength(1);
    cdc.close();
    expect(await cdc.poll()).toBe(0);
  });

  it('starts the interval loop exactly once, on first subscribe', () => {
    const cluster = createPollingCluster();
    const started: number[] = [];
    const cdc = createElasticsearchCdcAdapter({
      client: cluster.client,
      index: 'order',
      watermarkField: '@timestamp',
      primaryKey: 'order_id',
      pollIntervalMs: 250,
      scheduler: {
        setInterval: (_handler, ms) => {
          started.push(ms);
          return 'h';
        },
        clearInterval: () => undefined,
      },
    });
    cdc.subscribe(() => undefined);
    cdc.subscribe(() => undefined);
    expect(started).toEqual([250]);
    cdc.close();
  });
});
