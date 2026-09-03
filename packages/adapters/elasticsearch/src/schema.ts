// =============================================================================
// Elasticsearch mapping → oneGrid Schema.
//
// An ES mapping is a recursive tree of `properties`, not a flat column list,
// and its type vocabulary is wider than SQL's. Two translation decisions
// matter here.
//
// First, `object` and `nested` both become oneGrid `struct` columns with
// children, but they are NOT the same thing at query time: `nested` documents
// are indexed as separate Lucene documents and need a `nested` query to
// address, while `object` is flattened into the parent. The translation
// records which one a column came from on the descriptor's `nestedPath` list
// so query builders can tell them apart later.
//
// Second, ES's `long` is a 64-bit integer and `unsigned_long` goes past
// `Number.MAX_SAFE_INTEGER`. Mapping either onto `float64` would silently
// lose precision on ids above 2^53, which is exactly the shape of a Snowflake
// id or a Kafka offset. They map to `int64` / `uint64` and stay off the
// float path.
// =============================================================================

import type { ColumnSchema, ColumnType, Schema } from '@onegrid/protocol';
import type { ElasticsearchIndexDescriptor } from './query';

/** A single mapping node as returned by the `_mapping` API. */
export interface ElasticsearchMappingProperty {
  readonly type?: string;
  readonly properties?: Record<string, ElasticsearchMappingProperty>;
  readonly fields?: Record<string, ElasticsearchMappingProperty>;
  /** Present on `date` fields; carried through to `ColumnSchema.timezone`. */
  readonly format?: string;
  readonly scaling_factor?: number;
}

/** The `mappings` object of a `GET /<index>/_mapping` response. */
export interface ElasticsearchMapping {
  readonly properties?: Record<string, ElasticsearchMappingProperty>;
}

/**
 * ES field type → oneGrid ColumnType.
 *
 * `text` and `keyword` both land on `utf8` — the distinction is about
 * analysis, not storage width, and the grid renders both as strings. The
 * descriptor's `keywordSubfield` list is what preserves the operational
 * difference.
 */
const TYPE_MAP: Record<string, ColumnType> = {
  keyword: 'utf8',
  constant_keyword: 'utf8',
  wildcard: 'utf8',
  text: 'utf8',
  match_only_text: 'utf8',
  search_as_you_type: 'utf8',
  ip: 'utf8',
  version: 'utf8',
  byte: 'int8',
  short: 'int16',
  integer: 'int32',
  long: 'int64',
  unsigned_long: 'uint64',
  half_float: 'float32',
  float: 'float32',
  double: 'float64',
  scaled_float: 'decimal',
  boolean: 'bool',
  date: 'timestamp',
  date_nanos: 'timestamp',
  binary: 'binary',
  flattened: 'json',
  object: 'struct',
  nested: 'struct',
  geo_point: 'struct',
  geo_shape: 'json',
  point: 'struct',
  shape: 'json',
  histogram: 'json',
  dense_vector: 'list',
  rank_feature: 'float32',
  alias: 'unknown',
};

/**
 * `geo_point` has no `properties` in the mapping — ES accepts six different
 * input encodings for it — but the grid still needs to know it is a lat/lon
 * pair. Synthesise the children rather than surfacing an opaque struct.
 */
const GEO_POINT_CHILD: ReadonlyArray<ColumnSchema> = [
  { id: 'lat', type: 'float64' },
  { id: 'lon', type: 'float64' },
];

export function elasticsearchTypeToColumnType(esType: string): ColumnType {
  return TYPE_MAP[esType] ?? 'unknown';
}

/**
 * Translate a mapping into a oneGrid `Schema`.
 *
 * Every field in an ES mapping is nullable in the sense that matters to a
 * grid: ES has no NOT NULL, a document simply omits a field it has no value
 * for. So every column comes back `nullable: true` — claiming otherwise would
 * be a lie the renderer would then trust.
 */
export function mappingToSchema(mapping: ElasticsearchMapping): Schema {
  return translateProperty(mapping.properties ?? {});
}

function translateProperty(
  property: Record<string, ElasticsearchMappingProperty>,
): ReadonlyArray<ColumnSchema> {
  const out: ColumnSchema[] = [];
  for (const [id, node] of Object.entries(property)) {
    // A node with `properties` but no `type` is an implicit `object`; ES
    // omits the type keyword in that case.
    const esType = node.type ?? (node.properties ? 'object' : 'unknown');
    const type = elasticsearchTypeToColumnType(esType);
    const child = childOf(esType, node);
    out.push({
      id,
      type,
      nullable: true,
      ...(child ? { children: child } : {}),
    });
  }
  return out;
}

function childOf(
  esType: string,
  node: ElasticsearchMappingProperty,
): ReadonlyArray<ColumnSchema> | null {
  if (esType === 'geo_point' || esType === 'point') return GEO_POINT_CHILD;
  if (node.properties) return translateProperty(node.properties);
  return null;
}

/**
 * Flatten a mapping into the dotted field ids Elasticsearch actually accepts
 * in a query (`address.city`, not `address` → `city`), plus the top-level
 * container names. Both are needed: the container is addressable by a
 * `nested` query, the leaf by a `term`.
 */
export function mappingToFieldList(mapping: ElasticsearchMapping): ReadonlyArray<string> {
  const out: string[] = [];
  const walk = (
    property: Record<string, ElasticsearchMappingProperty>,
    prefix: string,
  ): void => {
    for (const [id, node] of Object.entries(property)) {
      const path = prefix ? `${prefix}.${id}` : id;
      out.push(path);
      // Multi-fields (`{ type: 'text', fields: { keyword: {...} } }`) are
      // addressable as `path.keyword` and belong in the whitelist, otherwise
      // `keywordSubfield` routing would immediately be rejected by the
      // compiler's own field check.
      for (const sub of Object.keys(node.fields ?? {})) out.push(`${path}.${sub}`);
      if (node.properties) walk(node.properties, path);
    }
  };
  walk(mapping.properties ?? {}, '');
  return out;
}

/** The `nested` paths in a mapping, dotted. Needed to build `nested` queries. */
export function mappingToNestedPath(mapping: ElasticsearchMapping): ReadonlyArray<string> {
  const out: string[] = [];
  const walk = (
    property: Record<string, ElasticsearchMappingProperty>,
    prefix: string,
  ): void => {
    for (const [id, node] of Object.entries(property)) {
      const path = prefix ? `${prefix}.${id}` : id;
      if (node.type === 'nested') out.push(path);
      if (node.properties) walk(node.properties, path);
    }
  };
  walk(mapping.properties ?? {}, '');
  return out;
}

/**
 * Build an index descriptor straight from a mapping. This is the path most
 * adopters want: one `_mapping` call at boot produces both the whitelist and
 * the `.keyword` routing table, so nobody hand-maintains a field list that
 * silently drifts from the index.
 */
export function descriptorFromMapping(
  index: string,
  mapping: ElasticsearchMapping,
  primaryKey: string,
): ElasticsearchIndexDescriptor {
  const field = mappingToFieldList(mapping);
  const keywordSubfield: string[] = [];
  const walk = (
    property: Record<string, ElasticsearchMappingProperty>,
    prefix: string,
  ): void => {
    for (const [id, node] of Object.entries(property)) {
      const path = prefix ? `${prefix}.${id}` : id;
      // A `text` field with a `keyword` multi-field is the standard dynamic
      // mapping ES produces for strings. Exact operators must go to the
      // sub-field or they match analysed tokens instead of the whole value.
      if (node.type === 'text' && node.fields?.keyword) keywordSubfield.push(path);
      if (node.properties) walk(node.properties, path);
    }
  };
  walk(mapping.properties ?? {}, '');
  return {
    index,
    field,
    primaryKey,
    ...(keywordSubfield.length > 0 ? { keywordSubfield } : {}),
  };
}
