// =============================================================================
// @onegrid/bigquery
//
// BigQuery adapter for oneGrid's server-side row model. Three pieces:
// a pure GoogleSQL compiler, a DataSource over an injectable
// queryable, and a polling CDC adapter over an ingestion-time
// partitioned outbox.
//
// DESIGN DECISIONS
//
// 1. NO CLIENT-LIBRARY DEPENDENCY. `@google-cloud/bigquery` drags in
//    the whole Google auth stack, and plenty of deployments reach
//    BigQuery through a proxy or the raw REST API instead. The adapter
//    takes a `BigQueryQueryable` — SQL plus typed named parameters in,
//    rows out — which every transport satisfies in a few lines. Same
//    call the SQLite adapter made with `SqliteQueryable`.
//
// 2. BYTES SCANNED IS THE REAL BUDGET. BigQuery bills by scan, so the
//    compiler treats pruning as a first-class output, not a hint: it
//    reorders the conjuncts of a top-level AND to put partition and
//    clustering predicates first, compiles `_PARTITIONTIME` bounds
//    ahead of everything else, and the DataSource forwards
//    `maximumBytesBilled` on every job. A grid that can bill five
//    figures by scrolling is a broken grid.
//
// 3. PARAMETERS CARRY THEIR TYPES. BigQuery rejects a job whose named
//    parameters are untyped, so `CompiledQuery` emits `paramType`
//    alongside `params`, sourced from the descriptor's declared column
//    types. IN-lists become one `UNNEST(@p)` ARRAY parameter rather
//    than one parameter per value, because a set filter routinely runs
//    to thousands of values and BigQuery caps parameter count.
//
// 4. KEYSET, NOT OFFSET. `OFFSET n` re-scans and re-bills every row it
//    skips. GoogleSQL compares STRUCTs only for equality, so the
//    cursor predicate compiles to an expanded lexicographic chain —
//    which also gets mixed-direction multi-sort right, something the
//    tuple form cannot express.
//
// 5. INT64 STAYS EXACT. BigQuery's only integer type is 64-bit, so
//    EVERY integer column exceeds float64's exact range. The type
//    mapper puts them on `int64` and the DataSource stringifies BigInt
//    and `{ value }`-wrapped row ids rather than coercing them — a
//    rounded cursor silently skips rows.
// =============================================================================

/** @public */
export { createBigQueryDataSource } from './datasource';
/** @public */
export type {
  BigQueryDataSourceOptions,
  BigQueryJobRequest,
  BigQueryQueryable,
  BigQueryResult,
} from './datasource';

/** @public */
export {
  compileBlockQuery,
  orderByPruningValue,
  quoteTable,
  encodeKeysetCursor,
  decodeKeysetCursor,
  isKeysetCursor,
  isLegacyOffsetCursor,
} from './sql';
/** @public */
export type {
  BqCompileOption,
  BqPartitionFilter,
  BqPartitionPseudoColumn,
  BqTableDescriptor,
  CompiledQuery,
} from './sql';

/** @public */
export { bqColumnType, buildBqSchema, buildColumnTypeMap, isBigIntSafeRequired } from './type';
/** @public */
export type { BqFieldDescription } from './type';

/** @public */
export { createBqCdcAdapter, createOutboxStatement, SnapshotRequired } from './cdc';
/** @public */
export type { BqCdcAdapter, BqCdcAdapterOptions } from './cdc';
