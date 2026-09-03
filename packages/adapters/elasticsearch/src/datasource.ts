// =============================================================================
// Elasticsearch-backed DataSource.
//
// The adapter takes no npm dependency on `@elastic/elasticsearch`. The
// official client's surface is enormous, its generated types churn every
// minor, and bundling it would drag a Node-only HTTP stack into a package
// that also has to build for the browser-facing showcase. So the transport is
// a one-method injectable — `ElasticsearchQueryable` — and the adopter
// supplies the three-line shim that maps it onto their client, their proxy
// route, or a fake. This is the same shape `SqliteQueryable` uses in the
// SQLite adapter, and it is what makes the whole thing testable without a
// cluster.
//
// Cursor policy: the flat path emits `ks:`-prefixed keyset cursors carrying
// the hit's own `sort` array, which is precisely what `search_after` wants
// back. The grouped path emits `esafter:`-prefixed cursors carrying the
// composite aggregation's `after_key`. Both occupy the protocol's single
// opaque `Cursor` slot, and the datasource dispatches on the prefix — a
// client never has to know which mode produced the block it is holding.
// =============================================================================

import type {
  BlockRequest,
  BlockResponse,
  Cursor,
  DataSource,
  FetchOptions,
  KeysetCursor,
  Schema,
  SortField,
} from '@onegrid/protocol';
import {
  compileBlockQuery,
  decodeAfterKey,
  decodeKeysetCursor,
  encodeAfterKey,
  encodeKeysetCursor,
  isKeysetCursor,
  parseAggregationResponse,
  type CompiledAggregationQuery,
  type CompileOptions,
  type ElasticsearchBlockRequest,
  type ElasticsearchIndexDescriptor,
  type ElasticsearchPointInTime,
} from './query';

// -----------------------------------------------------------------------------
// Transport
// -----------------------------------------------------------------------------

/** A `_search` request as this adapter emits it. */
export interface ElasticsearchSearchRequest {
  /** Index or alias. Null when the body carries a point-in-time. */
  readonly index: string | null;
  readonly body: Record<string, unknown>;
  readonly signal?: AbortSignal;
}

/** One hit from a `_search` response. */
export interface ElasticsearchHit {
  readonly _id?: string;
  readonly _index?: string;
  readonly _score?: number | null;
  readonly _source?: Record<string, unknown>;
  /** The sort values ES computed for this hit — the `search_after` payload. */
  readonly sort?: ReadonlyArray<unknown>;
}

/** The subset of a `_search` response the adapter reads. */
export interface ElasticsearchSearchResponse {
  readonly hits?: {
    readonly total?: number | { readonly value: number; readonly relation?: string };
    readonly hits?: ReadonlyArray<ElasticsearchHit>;
  };
  readonly aggregations?: Record<string, unknown>;
  readonly pit_id?: string;
}

/**
 * The only thing the adapter needs from an Elasticsearch client. Wrap the
 * official client with:
 *
 * ```ts
 * const queryable: ElasticsearchQueryable = {
 *   search: (req) =>
 *     client.search({ ...(req.index ? { index: req.index } : {}), ...req.body }),
 * };
 * ```
 */
export interface ElasticsearchQueryable {
  search(request: ElasticsearchSearchRequest): Promise<ElasticsearchSearchResponse>;
}

// -----------------------------------------------------------------------------
// Options
// -----------------------------------------------------------------------------

export interface ElasticsearchDataSourceOptions {
  readonly client: ElasticsearchQueryable;
  readonly descriptor: ElasticsearchIndexDescriptor;
  /**
   * Schema for the index. Build it once at boot with `mappingToSchema` over a
   * `_mapping` response — the adapter deliberately does not call `_mapping`
   * itself, because that would force the transport interface to grow a second
   * method for a call every adopter makes exactly once.
   */
  readonly schema: Schema;
  /** Page size when a request omits `limit`. Default 200. */
  readonly defaultLimit?: number;
  /**
   * Ask ES for a total hit count. `false` (default) is free; `true` makes
   * every request count the full result set, which on a large index costs
   * more than the page itself. A number caps the count at that value.
   */
  readonly trackTotalHits?: boolean | number;
  /**
   * Point-in-time handle. Supply one to pin the searched segments for the
   * lifetime of a scroll session — without it, a refresh between two blocks
   * can shift documents across the keyset boundary. Passing a PIT also
   * upgrades the tiebreaker to `_shard_doc`.
   */
  readonly pointInTime?: ElasticsearchPointInTime;
  /** Aggregation family for grouped requests. Default 'composite'. */
  readonly aggregationStrategy?: 'composite' | 'terms';
  /** Bucket cap for the 'terms' strategy. Default 1000. */
  readonly termsSize?: number;
}

// -----------------------------------------------------------------------------
// Factory
// -----------------------------------------------------------------------------

export function createElasticsearchDataSource(
  options: ElasticsearchDataSourceOptions,
): DataSource {
  const defaultLimit = options.defaultLimit ?? 200;

  async function fetchBlock(
    request: BlockRequest,
    fetchOptions?: FetchOptions,
  ): Promise<BlockResponse<'json'>> {
    throwIfAborted(fetchOptions);
    const req: ElasticsearchBlockRequest = {
      ...request,
      limit: request.limit > 0 ? request.limit : defaultLimit,
    };

    const compileOption: CompileOptions = {
      cursor: keysetFrom(request.cursor),
      trackTotalHits: options.trackTotalHits ?? false,
      aggregationStrategy: options.aggregationStrategy ?? 'composite',
      ...(options.pointInTime ? { pointInTime: options.pointInTime } : {}),
      ...(options.termsSize !== undefined ? { termsSize: options.termsSize } : {}),
      ...(afterKeyFrom(request.cursor) ? { afterKey: afterKeyFrom(request.cursor)! } : {}),
    };

    const compiled = compileBlockQuery(req, options.descriptor, compileOption);
    const response = await options.client.search({
      index: compiled.index,
      body: compiled.body,
      ...(fetchOptions?.signal ? { signal: fetchOptions.signal } : {}),
    });
    throwIfAborted(fetchOptions);

    if (compiled.kind === 'aggregation') {
      return groupedResponse(compiled, response);
    }

    const hit = response.hits?.hits ?? [];
    // A hit's `sort` array is authoritative: it is what ES itself computed
    // for the ordering, including any script or missing-value substitution.
    // Rebuilding the cursor from `_source` would diverge the moment a sort
    // field is a multi-field, a runtime field, or absent from `_source`.
    const row = hit.map((h) => h._source ?? {});
    const orderedRow = request.direction === 'before' ? row.slice().reverse() : row;
    const orderedHit = request.direction === 'before' ? hit.slice().reverse() : hit;

    // A short page means ES has nothing further in that direction. A full
    // page means there *may* be more; the next fetch settles it. We never
    // over-fetch by one here because `search_after` makes the extra round
    // trip cheap and the +1 trick would corrupt the emitted `sort` cursor.
    const full = hit.length === req.limit;
    const last = orderedHit[orderedHit.length - 1];
    const first = orderedHit[0];
    const forward = request.direction === 'after';

    const tailCursor = full && last ? cursorFromHit(last, request.sort, options.descriptor) : null;
    const headCursor = first ? cursorFromHit(first, request.sort, options.descriptor) : null;

    const total = normaliseTotal(response.hits?.total);

    return {
      encoding: 'json',
      rows: orderedRow,
      nextCursor: forward ? tailCursor : headCursor,
      prevCursor: forward ? (request.cursor ? headCursor : null) : tailCursor,
      ...(total !== null ? { totalRowCount: total } : {}),
      ...(request.requestId !== undefined ? { requestId: request.requestId } : {}),
    };
  }

  return {
    schema: () => options.schema,
    fetchBlock,
  };
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function groupedResponse(
  compiled: CompiledAggregationQuery,
  response: ElasticsearchSearchResponse,
): BlockResponse<'json'> {
  const parsed = parseAggregationResponse(compiled, response);
  return {
    encoding: 'json',
    rows: parsed.row,
    // A composite aggregation returns `after_key` on every non-final page
    // and omits it once the buckets are exhausted, so it doubles as the
    // end-of-stream signal. `terms` has no continuation at all.
    nextCursor: parsed.afterKey ? encodeAfterKey(parsed.afterKey) : null,
    prevCursor: null,
  };
}

/**
 * Turn a hit into a keyset cursor. The hit's `sort` array is `[...sortValues,
 * tiebreaker]`, which maps exactly onto `KeysetCursor`'s `sortValues` +
 * `rowId` split.
 */
export function cursorFromHit(
  hit: ElasticsearchHit,
  sort: ReadonlyArray<SortField>,
  descriptor: ElasticsearchIndexDescriptor,
): Cursor {
  const sortValue = hit.sort;
  if (sortValue && sortValue.length > 0) {
    const rowId = sortValue[sortValue.length - 1];
    return encodeKeysetCursor({
      sortValues: sortValue.slice(0, -1),
      rowId: rowId as string | number,
    });
  }
  // No `sort` on the hit means the caller asked for `_score` ordering or the
  // response came from a fake without one. Fall back to _source, which is
  // correct whenever every sort field is a stored top-level field.
  const source = hit._source ?? {};
  const rawId = source[descriptor.primaryKey] ?? hit._id;
  if (typeof rawId !== 'string' && typeof rawId !== 'number') {
    throw new Error(
      `@onegrid/elasticsearch: cannot build a cursor — hit carried no 'sort' array and no usable "${descriptor.primaryKey}" in _source.`,
    );
  }
  return encodeKeysetCursor({
    sortValues: sort.map((s) => source[s.columnId] ?? null),
    rowId: rawId,
  });
}

function keysetFrom(cursor: Cursor | null): KeysetCursor | null {
  if (!cursor) return null;
  if (!isKeysetCursor(cursor)) return null;
  try {
    return decodeKeysetCursor(cursor);
  } catch {
    return null;
  }
}

function afterKeyFrom(cursor: Cursor | null): Record<string, unknown> | null {
  if (!cursor) return null;
  try {
    return decodeAfterKey(cursor);
  } catch {
    return null;
  }
}

function normaliseTotal(
  total: number | { value: number; relation?: string } | undefined,
): number | null {
  if (total === undefined) return null;
  if (typeof total === 'number') return total;
  // `relation: 'gte'` means ES stopped counting at track_total_hits. Reporting
  // a lower bound as an exact total would give the grid a scrollbar that lies,
  // so we withhold it entirely.
  if (total.relation && total.relation !== 'eq') return null;
  return total.value;
}

function throwIfAborted(fetchOptions: FetchOptions | undefined): void {
  if (fetchOptions?.signal?.aborted) {
    throw new DOMException('aborted', 'AbortError');
  }
}
