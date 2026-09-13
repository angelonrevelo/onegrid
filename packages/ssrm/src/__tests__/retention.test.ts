// =============================================================================
// Query retention + distinct dedupe in the cache / SsrmDataSource layer.
// =============================================================================

import { describe, expect, it, vi } from 'vitest';
import type {
  BlockRequest,
  BlockResponse,
  DistinctRequest,
  DistinctResult,
  FilterModel,
} from '@onegrid/protocol';
import { BlockCache } from '../cache';
import { createSsrmDataSource } from '../datasource';
import type { SsrmTransport } from '../types';

const filterOn = (value: string): FilterModel => ({
  type: 'comparison',
  columnId: 'name',
  op: 'contains',
  value,
});

const req = (filter: FilterModel): BlockRequest => ({
  cursor: null,
  direction: 'after',
  limit: 100,
  sort: [],
  filter,
});

const response: BlockResponse = {
  encoding: 'json',
  rows: [{ id: 1 }],
  nextCursor: null,
  prevCursor: null,
};

function transport(): SsrmTransport & { requestMock: ReturnType<typeof vi.fn> } {
  const requestMock = vi.fn((_req: BlockRequest) => Promise.resolve(response));
  return { request: requestMock, schema: () => [], requestMock };
}

describe('BlockCache.retainRecentFingerprint', () => {
  it('keeps the blocks of the last N queries and evicts older ones', () => {
    const cache = new BlockCache({ maxBlocks: 10 });
    for (const value of ['a', 'b', 'c']) {
      const r = req(filterOn(value));
      cache.retainRecentFingerprint(BlockCache.fingerprintFor(r), 2);
      cache.set(BlockCache.keyFor(r), response, BlockCache.fingerprintFor(r));
    }
    expect(cache.get(BlockCache.keyFor(req(filterOn('a'))))).toBeUndefined();
    expect(cache.get(BlockCache.keyFor(req(filterOn('b'))))).toBe(response);
    expect(cache.get(BlockCache.keyFor(req(filterOn('c'))))).toBe(response);
  });

  it('re-activating a query moves it to the front instead of evicting it', () => {
    const cache = new BlockCache({ maxBlocks: 10 });
    const fa = BlockCache.fingerprintFor(req(filterOn('a')));
    const fb = BlockCache.fingerprintFor(req(filterOn('b')));
    const fc = BlockCache.fingerprintFor(req(filterOn('c')));
    cache.retainRecentFingerprint(fa, 2);
    cache.set(BlockCache.keyFor(req(filterOn('a'))), response, fa);
    cache.retainRecentFingerprint(fb, 2);
    cache.retainRecentFingerprint(fa, 2);
    cache.retainRecentFingerprint(fc, 2);
    expect(cache.get(BlockCache.keyFor(req(filterOn('a'))))).toBe(response);
  });
});

describe('SsrmDataSource query retention', () => {
  it('toggling back to the previous filter is a cache hit (default keeps 2)', async () => {
    const t = transport();
    const ds = createSsrmDataSource(t);
    await ds.fetchBlock(req(filterOn('a')));
    await ds.fetchBlock(req(filterOn('b')));
    await ds.fetchBlock(req(filterOn('a')));
    expect(t.requestMock).toHaveBeenCalledTimes(2);
  });

  it('a third query evicts the oldest one', async () => {
    const t = transport();
    const ds = createSsrmDataSource(t);
    for (const value of ['a', 'b', 'c', 'a']) await ds.fetchBlock(req(filterOn(value)));
    expect(t.requestMock).toHaveBeenCalledTimes(4);
  });

  it('retainQueryCount: 1 restores evict-on-every-change', async () => {
    const t = transport();
    const ds = createSsrmDataSource(t, { retainQueryCount: 1 });
    for (const value of ['a', 'b', 'a']) await ds.fetchBlock(req(filterOn(value)));
    expect(t.requestMock).toHaveBeenCalledTimes(3);
  });
});

describe('SsrmDataSource.fetchDistinct', () => {
  const distinctReq: DistinctRequest = { columnId: 'status', filter: null, limit: 50 };

  it('is absent when the transport cannot answer distinct', () => {
    const ds = createSsrmDataSource(transport());
    expect(ds.fetchDistinct).toBeUndefined();
  });

  it('shares one round-trip between identical in-flight requests', async () => {
    const release: Array<(r: DistinctResult) => void> = [];
    const distinct = vi.fn(
      () =>
        new Promise<DistinctResult>((resolve) => {
          release.push(resolve);
        }),
    );
    const ds = createSsrmDataSource({ ...transport(), distinct });
    const a = ds.fetchDistinct!(distinctReq);
    const b = ds.fetchDistinct!({ ...distinctReq });
    const c = ds.fetchDistinct!({ ...distinctReq, search: 'ac' });
    expect(distinct).toHaveBeenCalledTimes(2);
    for (const resolve of release) resolve({ kind: 'distinct', entry: [], truncated: false });
    expect(await a).toBe(await b);
    await c;
    // Once settled, the next identical call goes to the server again.
    void ds.fetchDistinct!(distinctReq);
    expect(distinct).toHaveBeenCalledTimes(3);
  });
});
