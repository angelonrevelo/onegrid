import { describe, expect, it, vi } from 'vitest';
import { createSsrmDataSource } from '../datasource';
import type { SsrmTransport } from '../types';
import type {
  BlockRequest,
  BlockResponse,
  Mutation,
  MutationResult,
  Patch,
  Schema,
} from '@onegrid/protocol';

const SCHEMA: Schema = [
  { id: 'id', type: 'int64' },
  { id: 'name', type: 'utf8' },
];

const baseReq: BlockRequest = {
  cursor: null,
  direction: 'after',
  limit: 100,
  sort: [],
  filter: null,
};

function fakeResponse(label: string): BlockResponse {
  return {
    encoding: 'json',
    rows: [{ id: label }],
    nextCursor: `next-${label}`,
    prevCursor: null,
  };
}

function makeTransport(
  overrides: Partial<SsrmTransport> = {},
): SsrmTransport & {
  requestMock: ReturnType<typeof vi.fn>;
  schemaMock: ReturnType<typeof vi.fn>;
} {
  const requestMock = vi.fn(async (_req: BlockRequest) => fakeResponse('default'));
  const schemaMock = vi.fn(() => SCHEMA);
  return {
    request: requestMock,
    schema: schemaMock,
    requestMock,
    schemaMock,
    ...overrides,
  };
}

describe('createSsrmDataSource', () => {
  it('memoizes schema across calls', async () => {
    const t = makeTransport();
    const ds = createSsrmDataSource(t);
    const a = await Promise.resolve(ds.schema());
    const b = await Promise.resolve(ds.schema());
    expect(a).toEqual(SCHEMA);
    expect(b).toEqual(SCHEMA);
    expect(t.schemaMock).toHaveBeenCalledTimes(1);
  });

  it('caches block responses keyed by full request shape', async () => {
    const t = makeTransport();
    const ds = createSsrmDataSource(t);
    await ds.fetchBlock(baseReq);
    await ds.fetchBlock(baseReq);
    expect(t.requestMock).toHaveBeenCalledTimes(1);
  });

  it('deduplicates concurrent inflight requests', async () => {
    let resolveFn: ((res: BlockResponse) => void) | null = null;
    const requestMock = vi.fn(
      () =>
        new Promise<BlockResponse>((resolve) => {
          resolveFn = resolve;
        }),
    );
    const t: SsrmTransport = { request: requestMock, schema: () => SCHEMA };
    const ds = createSsrmDataSource(t);

    const p1 = ds.fetchBlock(baseReq);
    const p2 = ds.fetchBlock(baseReq);
    expect(requestMock).toHaveBeenCalledTimes(1);

    resolveFn!(fakeResponse('shared'));
    const [a, b] = await Promise.all([p1, p2]);
    expect(a).toBe(b);
  });

  it('keeps the previous query\'s blocks when the sort fingerprint changes (default retainQueryCount 2)', async () => {
    const t = makeTransport();
    const ds = createSsrmDataSource(t, { maxBlocks: 10 });

    await ds.fetchBlock(baseReq);
    expect(ds.getCacheStats().size).toBe(1);

    const sortedReq: BlockRequest = {
      ...baseReq,
      sort: [{ columnId: 'name', direction: 'asc' }],
    };
    await ds.fetchBlock(sortedReq);
    expect(ds.getCacheStats().size).toBe(2);
    expect(ds.getCacheStats().fingerprint).not.toBeNull();
  });

  it('drops cached blocks when sort fingerprint changes with retainQueryCount 1', async () => {
    const t = makeTransport();
    const ds = createSsrmDataSource(t, { maxBlocks: 10, retainQueryCount: 1 });

    await ds.fetchBlock(baseReq);
    const sortedReq: BlockRequest = {
      ...baseReq,
      sort: [{ columnId: 'name', direction: 'asc' }],
    };
    await ds.fetchBlock(sortedReq);
    expect(ds.getCacheStats().size).toBe(1);
  });

  it('omits subscribe and mutate when transport does not support them', () => {
    const t: SsrmTransport = {
      request: async () => fakeResponse('x'),
      schema: () => SCHEMA,
    };
    const ds = createSsrmDataSource(t);
    expect(ds.subscribe).toBeUndefined();
    expect(ds.mutate).toBeUndefined();
  });

  it('exposes subscribe when transport supports it and clears cache on global invalidate', async () => {
    const subscribers = new Set<(p: Patch) => void>();
    const t: SsrmTransport = {
      request: async () => fakeResponse('x'),
      schema: () => SCHEMA,
      subscribe: (onPatch) => {
        subscribers.add(onPatch);
        return () => subscribers.delete(onPatch);
      },
    };
    const ds = createSsrmDataSource(t);
    await ds.fetchBlock(baseReq);
    expect(ds.getCacheStats().size).toBe(1);

    const seen: Patch[] = [];
    const unsub = ds.subscribe!((p) => seen.push(p));

    for (const fn of subscribers) {
      fn({ kind: 'invalidate', scope: null });
    }

    expect(ds.getCacheStats().size).toBe(0);
    expect(seen).toHaveLength(1);
    unsub();
  });

  it('exposes mutate when transport supports it and forwards mutations', async () => {
    const mutateMock = vi.fn(async (): Promise<MutationResult> => []);
    const t: SsrmTransport = {
      request: async () => fakeResponse('x'),
      schema: () => SCHEMA,
      mutate: mutateMock,
    };
    const ds = createSsrmDataSource(t);
    const muts: Mutation[] = [
      { kind: 'insert', clientId: 'c1', row: { id: 1 } },
    ];
    await ds.mutate!(muts);
    expect(mutateMock).toHaveBeenCalledWith(muts, undefined);
  });

  it('invalidate() drops schema and cached blocks', async () => {
    const t = makeTransport();
    const ds = createSsrmDataSource(t);
    await Promise.resolve(ds.schema());
    await ds.fetchBlock(baseReq);
    ds.invalidate();
    expect(ds.getCacheStats().size).toBe(0);
    expect(ds.getCacheStats().fingerprint).toBeNull();
    await Promise.resolve(ds.schema());
    expect(t.schemaMock).toHaveBeenCalledTimes(2);
  });
});
