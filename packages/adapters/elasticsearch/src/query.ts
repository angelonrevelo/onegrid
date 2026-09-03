// =============================================================================
// Elasticsearch query compiler — turns a BlockRequest into a literal ES 8.x
// `_search` request body.
//
// Three decisions drive everything in this file.
//
// 1. `search_after`, never `from`/`size`. Elasticsearch's `from` parameter
//    forces every shard to materialise and sort `from + size` hits before
//    discarding all but the last page, which is why `index.max_result_window`
//    defaults to 10 000 and why deep paging is the classic way to OOM a
//    cluster. oneGrid's SSRM is an infinite-scroll row model that pages
//    forever, so the compiler emits `search_after` keyset pagination
//    exclusively. `from` never appears in a body this module produces.
//
// 2. Every sort needs a tiebreaker, or `search_after` silently loses and
//    duplicates rows. ES sorts are not stable on their own: two documents
//    with the same `@timestamp` can come back in either order on consecutive
//    requests, and the keyset resume point then lands in the middle of the
//    tie. The compiler always appends a tiebreaker — `_shard_doc` when the
//    caller supplied a point-in-time (the only context where ES exposes it),
//    otherwise the index descriptor's primary key.
//
// 3. Full-text is a first-class filter operator, not an afterthought. The
//    protocol's `ComparisonOperator` set is SQL-shaped (`eq`, `contains`,
//    `startsWith`). Those are all expressible against a `keyword` field, but
//    they throw away the entire reason anyone runs Elasticsearch. So this
//    module widens `FilterNode` with a `type: 'text'` variant carrying
//    `match` / `match_phrase` / `multi_match` / `query_string`. The widening
//    is additive: a plain protocol `FilterModel` is assignable to
//    `ElasticsearchFilterModel` unchanged, so callers that never touch
//    full-text pay nothing.
//
// Identifier safety: every field id is checked against the index
// descriptor's whitelist before it reaches a query body. Elasticsearch will
// happily accept an unknown field name and return zero hits rather than an
// error, so an unchecked, request-supplied field id turns into a silent
// wrong-answer bug rather than a loud one.
// =============================================================================

import type {
  Aggregation,
  BlockRequest,
  ComparisonFilter,
  KeysetCursor,
  SortField,
} from '@onegrid/protocol';

// -----------------------------------------------------------------------------
// Index descriptor
// -----------------------------------------------------------------------------

/**
 * Describes the index the adapter is bound to. `field` is the whitelist of
 * addressable field ids; `primaryKey` doubles as the keyset tiebreaker unless
 * a point-in-time makes `_shard_doc` available.
 */
export interface ElasticsearchIndexDescriptor {
  /** Index or alias name, e.g. `order-2026.09` or `order`. */
  readonly index: string;
  /** Field ids that exist in the mapping. Anything else is rejected. */
  readonly field: ReadonlyArray<string>;
  /**
   * Doc-values-enabled field that uniquely identifies a document. Used as the
   * `search_after` tiebreaker. `_id` is NOT a valid choice: it has no doc
   * values by default and sorting on it is disabled in modern ES — index an
   * explicit id field (a `keyword` copy) instead.
   */
  readonly primaryKey: string;
  /**
   * Fields whose exact-term operators must target a `.keyword` sub-field.
   * When a field is mapped as `text`, `term`/`terms`/`prefix` against the
   * analysed field matches analysed tokens, which is almost never what an
   * equality filter means. Listing the field here makes the compiler emit
   * `field.keyword` for exact operators while leaving full-text operators on
   * the analysed field.
   */
  readonly keywordSubfield?: ReadonlyArray<string>;
}

// -----------------------------------------------------------------------------
// Full-text filter extension
// -----------------------------------------------------------------------------

/** The four full-text query families oneGrid exposes as filter operators. */
export type ElasticsearchTextOperator =
  | 'match'
  | 'matchPhrase'
  | 'matchPhrasePrefix'
  | 'multiMatch'
  | 'queryString';

/**
 * Full-text filter node. `columnId` accepts an array for `multiMatch` (and
 * for `queryString`, where it becomes `fields`).
 */
export interface ElasticsearchTextFilter {
  readonly type: 'text';
  readonly columnId: string | ReadonlyArray<string>;
  readonly op: ElasticsearchTextOperator;
  readonly query: string;
  /** `match` only: how the analysed terms combine. Default ES behaviour is 'or'. */
  readonly operator?: 'and' | 'or';
  readonly fuzziness?: 'AUTO' | number;
  readonly minimumShouldMatch?: string | number;
  /** `multiMatch` only. Default 'best_fields'. */
  readonly multiMatchType?: 'best_fields' | 'most_fields' | 'cross_fields' | 'phrase' | 'phrase_prefix';
  readonly boost?: number;
  /**
   * When true the clause lands in `bool.must` so it contributes to `_score`;
   * when false (default) it lands in `bool.filter`, which is cacheable and
   * skips scoring entirely. Set this if the grid sorts by relevance.
   */
  readonly scored?: boolean;
}

/**
 * Logical node widened to carry text filters. Structurally a superset of the
 * protocol's `LogicalFilter`, so protocol filters flow in unchanged. The
 * property stays spelled `filters` to preserve that assignability.
 */
export interface ElasticsearchLogicalFilter {
  readonly type: 'logical';
  readonly op: 'and' | 'or' | 'not';
  readonly filters: ReadonlyArray<ElasticsearchFilterNode>;
}

/** Protocol filter node widened with the Elasticsearch full-text variant. */
export type ElasticsearchFilterNode =
  | ComparisonFilter
  | ElasticsearchLogicalFilter
  | ElasticsearchTextFilter;

/** Null = no filter applied. Accepts a plain protocol `FilterModel`. */
export type ElasticsearchFilterModel = ElasticsearchFilterNode | null;

/**
 * `BlockRequest` with the filter slot widened to accept full-text nodes.
 * A plain `BlockRequest` is assignable to this type.
 */
export type ElasticsearchBlockRequest = Omit<BlockRequest, 'filter'> & {
  readonly filter: ElasticsearchFilterModel;
};

// -----------------------------------------------------------------------------
// Compiled shapes
// -----------------------------------------------------------------------------

/** A `bool` query. Empty clause arrays are omitted so bodies stay readable. */
export interface EsBoolQuery {
  readonly bool: {
    must?: ReadonlyArray<Record<string, unknown>>;
    filter?: ReadonlyArray<Record<string, unknown>>;
    must_not?: ReadonlyArray<Record<string, unknown>>;
    should?: ReadonlyArray<Record<string, unknown>>;
    minimum_should_match?: number;
  };
}

/** One entry of the ES `sort` array. */
export type EsSortEntry = Record<string, { order: 'asc' | 'desc'; missing?: '_first' | '_last' }>;

/** Point-in-time handle. When present the request must NOT name an index. */
export interface ElasticsearchPointInTime {
  readonly id: string;
  readonly keepAlive: string;
}

/** Body for the flat (one-row-per-document) path. */
export interface CompiledSearchQuery {
  readonly kind: 'search';
  /** Null when a point-in-time is in play — ES forbids an index there. */
  readonly index: string | null;
  readonly body: {
    readonly size: number;
    readonly query: EsBoolQuery;
    readonly sort: ReadonlyArray<EsSortEntry | '_shard_doc'>;
    readonly search_after?: ReadonlyArray<unknown>;
    readonly _source?: ReadonlyArray<string>;
    readonly track_total_hits: boolean | number;
    readonly pit?: { readonly id: string; readonly keep_alive: string };
  };
}

/** Body for the grouped (one-row-per-group) aggregation path. */
export interface CompiledAggregationQuery {
  readonly kind: 'aggregation';
  readonly index: string | null;
  /** Which agg family the body uses — the response parser needs to know. */
  readonly strategy: 'composite' | 'terms';
  /** Group columns in nesting order; the parser maps bucket keys back to these. */
  readonly groupColumn: ReadonlyArray<string>;
  /** Output aliases, parallel to the request's aggregation model. */
  readonly alias: ReadonlyArray<string>;
  /**
   * Aliases satisfied by the bucket's own `doc_count` rather than by a
   * sub-aggregation — i.e. `count('*')`. ES has no `value_count` for "all
   * documents"; the bucket already carries that number, so emitting a
   * sub-aggregation for it would be a wasted pass over the shard.
   */
  readonly docCountAlias: ReadonlyArray<string>;
  readonly body: {
    readonly size: 0;
    readonly query: EsBoolQuery;
    readonly track_total_hits: boolean;
    readonly aggs: Record<string, unknown>;
  };
}

export type CompiledQuery = CompiledSearchQuery | CompiledAggregationQuery;

/** Name of the top-level aggregation bucket. Stable so the parser can find it. */
export const GROUP_AGG_NAME = 'onegrid_group';

/** Per-group row count key, matching the protocol's documented contract. */
export const GROUP_COUNT_KEY = '__count__';

// -----------------------------------------------------------------------------
// Options
// -----------------------------------------------------------------------------

export interface CompileOptions {
  /** Resume point from a previous block. */
  readonly cursor?: KeysetCursor | null;
  /**
   * Point-in-time handle. Supplying one is what makes `_shard_doc` available
   * as a tiebreaker and what makes pagination immune to concurrent refreshes.
   */
  readonly pointInTime?: ElasticsearchPointInTime;
  /**
   * `track_total_hits` for the flat path. `false` (default) is the cheap
   * option and matches SSRM's infinite-scroll semantics; pass a number to cap
   * the count, or `true` to make ES count everything.
   */
  readonly trackTotalHits?: boolean | number;
  /**
   * Aggregation family. `composite` (default) paginates over group keys and
   * is exact; `terms` is a single-shot top-N and only legal for one group
   * column, but it is markedly cheaper when the cardinality is small.
   */
  readonly aggregationStrategy?: 'composite' | 'terms';
  /** `composite` resume key from the previous grouped block. */
  readonly afterKey?: Record<string, unknown>;
  /** `terms` bucket cap. Default 1000. Ignored by the composite strategy. */
  readonly termsSize?: number;
}

// -----------------------------------------------------------------------------
// Entry point
// -----------------------------------------------------------------------------

export function compileBlockQuery(
  req: ElasticsearchBlockRequest,
  descriptor: ElasticsearchIndexDescriptor,
  options: CompileOptions = {},
): CompiledQuery {
  if (req.grouping && req.grouping.columns.length > 0) {
    return compileAggregation(req, descriptor, options);
  }
  return compileSearch(req, descriptor, options);
}

// -----------------------------------------------------------------------------
// Flat path
// -----------------------------------------------------------------------------

function compileSearch(
  req: ElasticsearchBlockRequest,
  descriptor: ElasticsearchIndexDescriptor,
  options: CompileOptions,
): CompiledSearchQuery {
  const query = compileFilter(req.filter, descriptor);
  const sort = compileSort(req.sort, descriptor, req.direction, options.pointInTime !== undefined);
  const source = compileSource(req.columns, descriptor);
  const cursor = options.cursor ?? null;

  const body: Mutable<CompiledSearchQuery['body']> = {
    size: req.limit,
    query,
    sort,
    track_total_hits: options.trackTotalHits ?? false,
  };
  if (source) body._source = source;
  if (cursor) body.search_after = [...cursor.sortValues, cursor.rowId];
  if (options.pointInTime) {
    body.pit = { id: options.pointInTime.id, keep_alive: options.pointInTime.keepAlive };
  }

  return {
    kind: 'search',
    index: options.pointInTime ? null : descriptor.index,
    body,
  };
}

/**
 * Build the `sort` array. Directions are flipped wholesale when paging
 * backwards — ES has no "walk the index in reverse" mode, so the only way to
 * fetch the block *before* a cursor is to invert the ordering, take the
 * first N hits, and reverse them client-side (the datasource does that half).
 */
function compileSort(
  sort: ReadonlyArray<SortField>,
  descriptor: ElasticsearchIndexDescriptor,
  direction: BlockRequest['direction'],
  hasPointInTime: boolean,
): ReadonlyArray<EsSortEntry | '_shard_doc'> {
  const backwards = direction === 'before';
  const out: Array<EsSortEntry | '_shard_doc'> = [];
  for (const entry of sort) {
    requireField(entry.columnId, descriptor);
    const ascending = (entry.direction === 'asc') !== backwards;
    const clause: { order: 'asc' | 'desc'; missing?: '_first' | '_last' } = {
      order: ascending ? 'asc' : 'desc',
    };
    // Protocol null-handling maps onto ES's `missing` sentinel. ES defaults
    // missing values to `_last` for ascending and `_first` for descending,
    // which is NOT what `nulls: 'last'` means on a descending sort — so we
    // always emit it explicitly when the request asks.
    if (entry.nulls) clause.missing = entry.nulls === 'first' ? '_first' : '_last';
    out.push({ [entry.columnId]: clause });
  }
  // The tiebreaker. `_shard_doc` is the cheapest possible one (it is a
  // synthetic doc ordinal, requires no doc values, and is globally unique)
  // but ES only exposes it inside a point-in-time.
  if (hasPointInTime) {
    out.push('_shard_doc');
  } else {
    out.push({ [descriptor.primaryKey]: { order: backwards ? 'desc' : 'asc' } });
  }
  return out;
}

function compileSource(
  column: ReadonlyArray<string> | undefined,
  descriptor: ElasticsearchIndexDescriptor,
): ReadonlyArray<string> | null {
  if (!column || column.length === 0) return null;
  const out: string[] = [];
  for (const id of column) {
    requireField(id, descriptor);
    out.push(id);
  }
  // The primary key is not optional: without it the datasource cannot build
  // the next cursor, so pagination would stop after one block.
  if (!out.includes(descriptor.primaryKey)) out.push(descriptor.primaryKey);
  return out;
}

// -----------------------------------------------------------------------------
// Aggregation path
// -----------------------------------------------------------------------------

function compileAggregation(
  req: ElasticsearchBlockRequest,
  descriptor: ElasticsearchIndexDescriptor,
  options: CompileOptions,
): CompiledAggregationQuery {
  const groupColumn = req.grouping!.columns;
  for (const id of groupColumn) requireField(id, descriptor);

  const strategy = options.aggregationStrategy ?? 'composite';
  if (strategy === 'terms' && groupColumn.length !== 1) {
    throw new Error(
      `@onegrid/elasticsearch: the 'terms' aggregation strategy handles exactly one group column, got ${groupColumn.length}. Use 'composite' for multi-column grouping.`,
    );
  }

  const alias: string[] = [];
  const docCountAlias: string[] = [];
  const subAgg: Record<string, unknown> = {};
  for (const aggregation of req.aggregations ?? []) {
    const key = aliasOf(aggregation);
    alias.push(key);
    if (aggregation.fn === 'count' && aggregation.columnId === '*') {
      docCountAlias.push(key);
      continue;
    }
    subAgg[key] = compileAggregationFn(aggregation, descriptor);
  }
  const hasSubAgg = Object.keys(subAgg).length > 0;

  const inner: Record<string, unknown> =
    strategy === 'composite'
      ? {
          composite: {
            size: req.limit,
            sources: groupColumn.map((id) => ({
              [id]: { terms: { field: exactField(id, descriptor), order: 'asc' } },
            })),
            ...(options.afterKey ? { after: options.afterKey } : {}),
          },
          ...(hasSubAgg ? { aggs: subAgg } : {}),
        }
      : {
          terms: {
            field: exactField(groupColumn[0]!, descriptor),
            size: options.termsSize ?? 1000,
            order: { _key: 'asc' },
          },
          ...(hasSubAgg ? { aggs: subAgg } : {}),
        };

  return {
    kind: 'aggregation',
    index: options.pointInTime ? null : descriptor.index,
    strategy,
    groupColumn,
    alias,
    docCountAlias,
    body: {
      size: 0,
      query: compileFilter(req.filter, descriptor),
      track_total_hits: false,
      aggs: { [GROUP_AGG_NAME]: inner },
    },
  };
}

/** Default alias matches the protocol's documented `${fn}_${columnId}`. */
export function aliasOf(aggregation: Aggregation): string {
  return aggregation.alias ?? `${aggregation.fn}_${aggregation.columnId}`;
}

function compileAggregationFn(
  aggregation: Aggregation,
  descriptor: ElasticsearchIndexDescriptor,
): Record<string, unknown> {
  requireField(aggregation.columnId, descriptor);
  const field = aggregation.columnId;
  switch (aggregation.fn) {
    case 'sum':
      return { sum: { field } };
    case 'avg':
      return { avg: { field } };
    case 'min':
      return { min: { field } };
    case 'max':
      return { max: { field } };
    case 'count':
      // `value_count` counts non-null values of a field, which is exactly
      // SQL's COUNT(col). COUNT(*) never reaches here — it is served from
      // the bucket's doc_count instead.
      return { value_count: { field } };
    case 'countDistinct':
      // `cardinality` is a HyperLogLog++ sketch, not an exact count. That is
      // the only distinct-count Elasticsearch offers at scale; the default
      // precision_threshold of 3000 means counts below 3000 are exact.
      return { cardinality: { field } };
    default:
      throw new Error(
        `@onegrid/elasticsearch: unsupported aggregation fn "${aggregation.fn}". Supported: sum, avg, min, max, count, countDistinct.`,
      );
  }
}

// -----------------------------------------------------------------------------
// Aggregation response parsing
// -----------------------------------------------------------------------------

/** Buckets as ES returns them, before we flatten them into grid rows. */
export interface EsAggregationBucket {
  readonly key: string | number | boolean | Record<string, unknown>;
  readonly doc_count: number;
  readonly [alias: string]: unknown;
}

export interface EsAggregationResult {
  readonly buckets: ReadonlyArray<EsAggregationBucket>;
  readonly after_key?: Record<string, unknown>;
}

/**
 * Flatten an aggregation response into oneGrid's one-row-per-group shape.
 *
 * ES returns metric sub-aggregations wrapped (`{ sum_revenue: { value: 42 } }`)
 * and composite bucket keys as an object keyed by source name, while a
 * `terms` bucket key is the bare value. Both collapse to the same flat row
 * `{ status: 'active', sum_revenue: 42, __count__: 200000 }` that the grid
 * binds columns against.
 */
export function parseAggregationResponse(
  compiled: CompiledAggregationQuery,
  response: { aggregations?: Record<string, unknown> },
): { row: ReadonlyArray<Record<string, unknown>>; afterKey: Record<string, unknown> | null } {
  const raw = response.aggregations?.[GROUP_AGG_NAME] as EsAggregationResult | undefined;
  const bucket_ = raw?.buckets;
  if (!bucket_) {
    return { row: [], afterKey: null };
  }
  const row = bucket_.map((bucket) => {
    const out: Record<string, unknown> = {};
    if (compiled.strategy === 'composite') {
      const key = bucket.key as Record<string, unknown>;
      for (const id of compiled.groupColumn) out[id] = key[id] ?? null;
    } else {
      out[compiled.groupColumn[0]!] = bucket.key;
    }
    out[GROUP_COUNT_KEY] = bucket.doc_count;
    for (const key of compiled.alias) {
      out[key] = compiled.docCountAlias.includes(key)
        ? bucket.doc_count
        : unwrapMetric(bucket[key]);
    }
    return out;
  });
  return { row, afterKey: raw.after_key ?? null };
}

/**
 * ES metric aggregations answer `{ value: n }`; `top_hits`-style ones answer
 * something else entirely. Unwrap the common case and pass anything else
 * through untouched rather than guessing.
 */
function unwrapMetric(value: unknown): unknown {
  if (value !== null && typeof value === 'object' && 'value' in value) {
    return value.value;
  }
  return value ?? null;
}

// -----------------------------------------------------------------------------
// Filter compilation
// -----------------------------------------------------------------------------

/**
 * Compile a filter model into a `bool` query.
 *
 * Everything that is not a full-text clause goes into `filter` / `must_not`,
 * never `must`: those two contexts skip relevance scoring entirely and are
 * eligible for the shard request cache. A grid filter has no meaningful
 * notion of "how well does this row match", so paying for `_score` would be
 * pure waste.
 */
export function compileFilter(
  filter: ElasticsearchFilterModel,
  descriptor: ElasticsearchIndexDescriptor,
): EsBoolQuery {
  if (!filter) return { bool: {} };
  const clause = compileNode(filter, descriptor);
  return { bool: clause };
}

type BoolClause = EsBoolQuery['bool'];

function compileNode(
  node: ElasticsearchFilterNode,
  descriptor: ElasticsearchIndexDescriptor,
): BoolClause {
  if (node.type === 'logical') return compileLogical(node, descriptor);
  if (node.type === 'text') {
    const query = compileText(node, descriptor);
    return node.scored ? { must: [query] } : { filter: [query] };
  }
  return compileComparison(node, descriptor);
}

function compileLogical(
  node: ElasticsearchLogicalFilter,
  descriptor: ElasticsearchIndexDescriptor,
): BoolClause {
  if (node.op === 'not') {
    const inner = node.filters[0];
    if (!inner) return {};
    return { must_not: [{ bool: compileNode(inner, descriptor) }] };
  }
  if (node.filters.length === 0) return {};
  const child = node.filters.map((f) => ({ bool: compileNode(f, descriptor) }));
  if (node.op === 'and') return { filter: child };
  // `should` alone does not constrain a bool query that also has a `filter`
  // clause, so minimum_should_match is mandatory for OR semantics.
  return { should: child, minimum_should_match: 1 };
}

function compileComparison(
  node: ComparisonFilter,
  descriptor: ElasticsearchIndexDescriptor,
): BoolClause {
  requireField(node.columnId, descriptor);
  const field = exactField(node.columnId, descriptor);
  // `caseSensitive` defaults to true across the protocol; ES's
  // `case_insensitive` flag is the inverse and only exists on the term-level
  // queries that accept it (term, prefix, wildcard).
  const insensitive = node.caseSensitive === false;
  const ci = insensitive ? { case_insensitive: true } : {};

  switch (node.op) {
    case 'eq':
      return { filter: [{ term: { [field]: { value: node.value, ...ci } } }] };
    case 'neq':
      return { must_not: [{ term: { [field]: { value: node.value, ...ci } } }] };
    case 'lt':
      return { filter: [{ range: { [field]: { lt: node.value } } }] };
    case 'lte':
      return { filter: [{ range: { [field]: { lte: node.value } } }] };
    case 'gt':
      return { filter: [{ range: { [field]: { gt: node.value } } }] };
    case 'gte':
      return { filter: [{ range: { [field]: { gte: node.value } } }] };
    case 'in':
      return { filter: [{ terms: { [field]: [...(node.values ?? [])] } }] };
    case 'notIn':
      return { must_not: [{ terms: { [field]: [...(node.values ?? [])] } }] };
    case 'isNull':
      // ES has no null: a field is either present with a value or absent.
      // "is null" therefore means "does not exist".
      return { must_not: [{ exists: { field } }] };
    case 'isNotNull':
      return { filter: [{ exists: { field } }] };
    case 'contains':
      return { filter: [{ wildcard: { [field]: { value: `*${escapeWildcard(str(node.value))}*`, ...ci } } }] };
    case 'notContains':
      return { must_not: [{ wildcard: { [field]: { value: `*${escapeWildcard(str(node.value))}*`, ...ci } } }] };
    case 'startsWith':
      return { filter: [{ prefix: { [field]: { value: str(node.value), ...ci } } }] };
    case 'endsWith':
      return { filter: [{ wildcard: { [field]: { value: `*${escapeWildcard(str(node.value))}`, ...ci } } }] };
    case 'between': {
      const [lo, hi] = node.values ?? [];
      return { filter: [{ range: { [field]: { gte: lo, lte: hi } } }] };
    }
    case 'notBetween': {
      const [lo, hi] = node.values ?? [];
      return { must_not: [{ range: { [field]: { gte: lo, lte: hi } } }] };
    }
  }
}

function compileText(
  node: ElasticsearchTextFilter,
  descriptor: ElasticsearchIndexDescriptor,
): Record<string, unknown> {
  const fieldList = (Array.isArray(node.columnId) ? node.columnId : [node.columnId]) as string[];
  for (const id of fieldList) requireField(id, descriptor);
  const single = fieldList[0]!;

  switch (node.op) {
    case 'match':
      return {
        match: {
          [single]: {
            query: node.query,
            ...(node.operator ? { operator: node.operator } : {}),
            ...(node.fuzziness !== undefined ? { fuzziness: node.fuzziness } : {}),
            ...(node.minimumShouldMatch !== undefined
              ? { minimum_should_match: node.minimumShouldMatch }
              : {}),
            ...(node.boost !== undefined ? { boost: node.boost } : {}),
          },
        },
      };
    case 'matchPhrase':
      return { match_phrase: { [single]: { query: node.query, ...(node.boost !== undefined ? { boost: node.boost } : {}) } } };
    case 'matchPhrasePrefix':
      return { match_phrase_prefix: { [single]: { query: node.query, ...(node.boost !== undefined ? { boost: node.boost } : {}) } } };
    case 'multiMatch':
      return {
        multi_match: {
          query: node.query,
          fields: fieldList,
          type: node.multiMatchType ?? 'best_fields',
          ...(node.operator ? { operator: node.operator } : {}),
          ...(node.fuzziness !== undefined ? { fuzziness: node.fuzziness } : {}),
          ...(node.minimumShouldMatch !== undefined
            ? { minimum_should_match: node.minimumShouldMatch }
            : {}),
          ...(node.boost !== undefined ? { boost: node.boost } : {}),
        },
      };
    case 'queryString':
      // `query_string` parses Lucene syntax out of user input, so it can
      // throw on malformed queries. `lenient: true` degrades to zero hits
      // instead of a 400 — a grid filter box must not 500 the request.
      return {
        query_string: {
          query: node.query,
          fields: fieldList,
          lenient: true,
          ...(node.operator ? { default_operator: node.operator.toUpperCase() } : {}),
          ...(node.minimumShouldMatch !== undefined
            ? { minimum_should_match: node.minimumShouldMatch }
            : {}),
          ...(node.boost !== undefined ? { boost: node.boost } : {}),
        },
      };
  }
}

// -----------------------------------------------------------------------------
// Cursor codec — same `ks:` wire format every oneGrid adapter emits
// -----------------------------------------------------------------------------

const KEYSET_PREFIX = 'ks:';

export function isKeysetCursor(cursor: string): boolean {
  return cursor.startsWith(KEYSET_PREFIX);
}

export function encodeKeysetCursor(cursor: KeysetCursor): string {
  const json = JSON.stringify({ s: cursor.sortValues, r: cursor.rowId });
  const b64 =
    typeof globalThis.btoa === 'function'
      ? globalThis.btoa(json)
      : Buffer.from(json, 'utf-8').toString('base64');
  return KEYSET_PREFIX + b64;
}

export function decodeKeysetCursor(cursor: string): KeysetCursor {
  const b64 = cursor.startsWith(KEYSET_PREFIX) ? cursor.slice(KEYSET_PREFIX.length) : cursor;
  const json =
    typeof globalThis.atob === 'function'
      ? globalThis.atob(b64)
      : Buffer.from(b64, 'base64').toString('utf-8');
  const parsed: unknown = JSON.parse(json);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('@onegrid/elasticsearch: malformed keyset cursor.');
  }
  const obj = parsed as Record<string, unknown>;
  if (Array.isArray(obj.s) && 'r' in obj) {
    return { sortValues: obj.s, rowId: obj.r as string | number };
  }
  if (Array.isArray(obj.sortValues) && 'rowId' in obj) {
    return { sortValues: obj.sortValues, rowId: obj.rowId as string | number };
  }
  throw new Error('@onegrid/elasticsearch: malformed keyset cursor.');
}

/** Composite `after_key`s round-trip through the same opaque cursor slot. */
const AFTER_PREFIX = 'esafter:';

export function encodeAfterKey(afterKey: Record<string, unknown>): string {
  const json = JSON.stringify(afterKey);
  const b64 =
    typeof globalThis.btoa === 'function'
      ? globalThis.btoa(json)
      : Buffer.from(json, 'utf-8').toString('base64');
  return AFTER_PREFIX + b64;
}

export function decodeAfterKey(cursor: string): Record<string, unknown> | null {
  if (!cursor.startsWith(AFTER_PREFIX)) return null;
  const b64 = cursor.slice(AFTER_PREFIX.length);
  const json =
    typeof globalThis.atob === 'function'
      ? globalThis.atob(b64)
      : Buffer.from(b64, 'base64').toString('utf-8');
  const parsed: unknown = JSON.parse(json);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return parsed as Record<string, unknown>;
}

// -----------------------------------------------------------------------------
// Internals
// -----------------------------------------------------------------------------

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

function str(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
}

/**
 * `*` and `?` are the wildcard metacharacters; a literal one in user input
 * would otherwise silently widen the match. ES also treats `\` as the escape
 * character inside a wildcard value, so it has to be escaped first.
 */
function escapeWildcard(input: string): string {
  return input.replace(/[\\*?]/g, (m) => `\\${m}`);
}

/** Route exact-term operators at the `.keyword` sub-field when declared. */
function exactField(id: string, descriptor: ElasticsearchIndexDescriptor): string {
  return descriptor.keywordSubfield?.includes(id) ? `${id}.keyword` : id;
}

function requireField(id: string, descriptor: ElasticsearchIndexDescriptor): void {
  if (id === descriptor.primaryKey) return;
  if (!descriptor.field.includes(id)) {
    throw new Error(
      `@onegrid/elasticsearch: unknown field "${id}" (not in the index descriptor).`,
    );
  }
}
