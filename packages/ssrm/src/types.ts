// =============================================================================
// Internal types for @onegrid/ssrm.
// =============================================================================

import type {
  BlockRequest,
  BlockResponse,
  DistinctRequest,
  DistinctResult,
  FetchOptions,
  Mutation,
  MutationResult,
  Patch,
  Schema,
  Unsubscribe,
} from '@onegrid/protocol';

/**
 * A raw server connection. Implementations include WebSocket, SSE, gRPC-Web,
 * or in-process adapters (e.g., DuckDB-WASM running in a Web Worker).
 *
 * The transport is responsible only for moving bytes; SsrmDataSource adds
 * caching, deduplication, and invalidation on top.
 */
export interface SsrmTransport {
  /** Required: deliver one block. May be Arrow IPC or JSON encoded. */
  readonly request: (req: BlockRequest, opts?: FetchOptions) => Promise<BlockResponse>;

  /** Schema is fetched once and cached by the datasource. */
  readonly schema: () => Promise<Schema> | Schema;

  /** Optional: live update channel. Undefined means no push. */
  readonly subscribe?: (onPatch: (patch: Patch) => void, opts?: FetchOptions) => Unsubscribe;

  /** Optional: write-back. Undefined means read-only. */
  readonly mutate?: (
    mutations: ReadonlyArray<Mutation>,
    opts?: FetchOptions,
  ) => Promise<MutationResult>;

  /** Optional: explicit close. Useful for WebSocket-backed transports. */
  readonly close?: () => void;

  /**
   * Optional: distinct values + counts for one column. Undefined means the
   * server cannot answer; SsrmDataSource then omits `fetchDistinct`.
   */
  readonly distinct?: (req: DistinctRequest, opts?: FetchOptions) => Promise<DistinctResult>;
}

export interface SsrmCacheOptions {
  /** Default 50. Blocks are evicted LRU-style when this is exceeded. */
  readonly maxBlocks?: number;
  /**
   * How many recent queries (sort / filter / group fingerprints) keep their
   * blocks. Default 2, so toggling back to the previous query is a cache
   * hit. 1 restores evict-on-every-change.
   */
  readonly retainQueryCount?: number;
  /** Reserved for future use: prefetch ±N blocks around the viewport. */
  readonly prefetchAhead?: number;
}
