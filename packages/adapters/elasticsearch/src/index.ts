// =============================================================================
// @onegrid/elasticsearch
//
// Elasticsearch 8.x adapter for oneGrid's server-side row model.
//
// Design decisions, and why:
//
//   - `search_after` only. `from`/`size` deep paging is what makes people
//     believe Elasticsearch "can't do big result sets": every shard sorts
//     `from + size` hits and throws away all but the last page, which is why
//     `index.max_result_window` exists at all. A grid that scrolls forever is
//     the exact workload that breaks it, so this adapter never emits `from`.
//     Every block is a keyset continuation, and every sort carries a
//     tiebreaker (`_shard_doc` under a point-in-time, the descriptor's
//     primary key otherwise) because ES sorts are not stable without one.
//
//   - Aggregations are pushed down, not computed client-side. A grouped
//     BlockRequest becomes a `composite` (or `terms`) aggregation with metric
//     sub-aggregations, and the response is flattened back into oneGrid's
//     one-row-per-group shape with the documented `__count__` key. Composite
//     is the default because it paginates over group keys exactly; `terms` is
//     available when the cardinality is small enough that a single top-N pass
//     is cheaper.
//
//   - Full-text is a first-class filter operator. `match`, `match_phrase`,
//     `multi_match` and `query_string` sit alongside `eq` / `contains` /
//     `startsWith` in the filter model, because relevance search is the
//     reason anyone chose Elasticsearch over Postgres. The widening is
//     additive — a plain protocol `FilterModel` compiles unchanged.
//
//   - CDC is polling, and says so. Elasticsearch has no change stream; the
//     correct implementation reads a monotonic watermark and resumes with
//     `search_after`. Pretending otherwise would ship a lie.
//
//   - No npm dependency on `@elastic/*`. The transport is a one-method
//     injectable (`ElasticsearchQueryable`) the adopter wires to the official
//     client, a proxy route, or a fake — the same pattern `SqliteQueryable`
//     uses, and what makes the whole surface testable without a cluster.
// =============================================================================

/** @public */
export { createElasticsearchDataSource, cursorFromHit } from './datasource';
/** @public */
export type {
  ElasticsearchDataSourceOptions,
  ElasticsearchHit,
  ElasticsearchQueryable,
  ElasticsearchSearchRequest,
  ElasticsearchSearchResponse,
} from './datasource';

/** @public */
export {
  aliasOf,
  compileBlockQuery,
  compileFilter,
  decodeAfterKey,
  decodeKeysetCursor,
  encodeAfterKey,
  encodeKeysetCursor,
  isKeysetCursor,
  parseAggregationResponse,
  GROUP_AGG_NAME,
  GROUP_COUNT_KEY,
} from './query';
/** @public */
export type {
  CompileOptions,
  CompiledAggregationQuery,
  CompiledQuery,
  CompiledSearchQuery,
  ElasticsearchBlockRequest,
  ElasticsearchFilterModel,
  ElasticsearchFilterNode,
  ElasticsearchIndexDescriptor,
  ElasticsearchLogicalFilter,
  ElasticsearchPointInTime,
  ElasticsearchTextFilter,
  ElasticsearchTextOperator,
  EsAggregationBucket,
  EsAggregationResult,
  EsBoolQuery,
  EsSortEntry,
} from './query';

/** @public */
export {
  descriptorFromMapping,
  elasticsearchTypeToColumnType,
  mappingToFieldList,
  mappingToNestedPath,
  mappingToSchema,
} from './schema';
/** @public */
export type { ElasticsearchMapping, ElasticsearchMappingProperty } from './schema';

/** @public */
export { createElasticsearchCdcAdapter } from './cdc';
/** @public */
export type {
  CdcScheduler,
  ElasticsearchCdcAdapter,
  ElasticsearchCdcAdapterOptions,
  Watermark,
} from './cdc';
