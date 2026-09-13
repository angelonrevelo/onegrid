// =============================================================================
// SsrmDataSource
//
// Implements the @onegrid/protocol DataSource contract by wrapping a
// transport (raw server connection) with a BlockCache, schema memoization,
// inflight deduplication, and fingerprint-based invalidation on
// sort/filter/group/pivot changes.
//
// Public construction goes through `createSsrmDataSource()`, which returns
// a value that satisfies DataSource and additionally exposes an
// `invalidate()` and `getCacheStats()` for tests / advanced consumers.
//
// The factory builds an object literal so optional protocol methods
// (`subscribe`, `mutate`, `fetchDistinct`) are present only when the
// underlying transport actually supports them — preserving the contract
// semantics that `transport.subscribe === undefined` means "no live updates."
// =============================================================================

import type {
  BlockRequest,
  BlockResponse,
  DataSource,
  DistinctRequest,
  DistinctResult,
  FetchOptions,
  Mutation,
  MutationResult,
  Patch,
  Schema,
  Unsubscribe,
} from '@onegrid/protocol';
import { BlockCache } from './cache';
import type { SsrmCacheOptions, SsrmTransport } from './types';

export interface SsrmDataSourceHandle extends DataSource {
  /** Drop every cached block + schema. Call on auth changes, server reconnect, etc. */
  readonly invalidate: () => void;
  readonly getCacheStats: () => { readonly size: number; readonly fingerprint: string | null };
}

export function createSsrmDataSource(
  transport: SsrmTransport,
  options: SsrmCacheOptions = {},
): SsrmDataSourceHandle {
  const cache = new BlockCache({ maxBlocks: options.maxBlocks ?? 50 });
  const retainQueryCount = Math.max(1, options.retainQueryCount ?? 2);

  let cachedSchema: Schema | null = null;
  let schemaPromise: Promise<Schema> | null = null;
  let currentFingerprint: string | null = null;

  const schema = (): Promise<Schema> | Schema => {
    if (cachedSchema) return cachedSchema;
    if (schemaPromise) return schemaPromise;
    const result = transport.schema();
    if (result instanceof Promise) {
      schemaPromise = result.then((s) => {
        cachedSchema = s;
        schemaPromise = null;
        return s;
      });
      return schemaPromise;
    }
    cachedSchema = result;
    return result;
  };

  const fetchBlock = async (req: BlockRequest, opts?: FetchOptions): Promise<BlockResponse> => {
    const fingerprint = BlockCache.fingerprintFor(req);
    if (currentFingerprint !== fingerprint) {
      // Keep the last few queries' blocks rather than only the active one:
      // a filter toggled off and back on, or a sort flipped and flipped
      // back, is then served from cache instead of refetched.
      cache.retainRecentFingerprint(fingerprint, retainQueryCount);
    }
    currentFingerprint = fingerprint;

    const key = BlockCache.keyFor(req);

    const cached = cache.get(key);
    if (cached) return cached;

    const inflight = cache.inflightGet(key);
    if (inflight) return inflight;

    const promise = (async (): Promise<BlockResponse> => {
      const response = await transport.request(req, opts);
      cache.set(key, response, fingerprint);
      return response;
    })();
    cache.inflightSet(key, promise);
    return promise;
  };

  const handle: {
    -readonly [K in keyof SsrmDataSourceHandle]: SsrmDataSourceHandle[K];
  } = {
    schema,
    fetchBlock,
    invalidate: () => {
      cache.clear();
      cachedSchema = null;
      schemaPromise = null;
      currentFingerprint = null;
    },
    getCacheStats: () => ({ size: cache.size, fingerprint: currentFingerprint }),
  };

  if (transport.subscribe) {
    const transportSubscribe = transport.subscribe;
    handle.subscribe = (
      onPatch: (patch: Patch) => void,
      opts?: FetchOptions,
    ): Unsubscribe =>
      transportSubscribe((patch) => {
        // Invalidation patches drop the matching cache entries before the
        // consumer sees the patch, so subsequent renders see fresh data.
        if (patch.kind === 'invalidate') {
          if (patch.scope === null) {
            cache.clear();
          }
          // Column-scoped invalidation isn't yet implemented; treat as a
          // full clear to preserve correctness over efficiency.
          else {
            cache.clear();
          }
        }
        onPatch(patch);
      }, opts);
  }

  if (transport.mutate) {
    const transportMutate = transport.mutate;
    handle.mutate = (
      mutations: ReadonlyArray<Mutation>,
      opts?: FetchOptions,
    ): Promise<MutationResult> => transportMutate(mutations, opts);
  }

  if (transport.distinct) {
    const transportDistinct = transport.distinct;
    // A set-filter popover re-renders while it waits; identical requests
    // share one round-trip. Results are not cached — the counts move with
    // the data, and the popover is opened rarely enough not to need it.
    const distinctInflight = new Map<string, Promise<DistinctResult>>();
    handle.fetchDistinct = (req: DistinctRequest, opts?: FetchOptions): Promise<DistinctResult> => {
      const key = JSON.stringify([req.columnId, req.filter, req.search ?? '', req.limit]);
      const existing = distinctInflight.get(key);
      if (existing) return existing;
      const promise = transportDistinct(req, opts);
      distinctInflight.set(key, promise);
      const cleanup = (): void => {
        if (distinctInflight.get(key) === promise) distinctInflight.delete(key);
      };
      promise.then(cleanup, cleanup);
      return promise;
    };
  }

  return handle;
}
