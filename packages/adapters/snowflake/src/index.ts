// =============================================================================
// @onegrid/snowflake
//
// Snowflake adapter for oneGrid's server-side row model. Three pieces:
// a pure SQL compiler, a DataSource over an injectable queryable, and
// a STREAM-backed CDC adapter.
//
// DESIGN DECISIONS
//
// 1. NO DRIVER DEPENDENCY. `snowflake-sdk` is a large package with a
//    connection lifecycle of its own, and half of the Snowflake
//    traffic in production goes over the SQL REST API or a serverless
//    proxy instead. The adapter therefore takes a `SnowflakeQueryable`
//    — one method, SQL plus positional binds in, rows out — which all
//    three transports satisfy in a few lines. The same choice the
//    SQLite adapter made with `SqliteQueryable`.
//
// 2. IDENTIFIERS ARE RESOLVED, NOT JUST QUOTED. Snowflake folds
//    unquoted DDL identifiers to upper case, so `"order_id"` does not
//    match a column created as `order_id`. The compiler upper-cases
//    every identifier before quoting unless the descriptor sets
//    `preserveCase`. Every identifier is checked against the
//    descriptor's column allowlist first, so a filter naming an
//    unknown column throws instead of reaching the SQL text.
//
// 3. KEYSET, NOT OFFSET. `OFFSET n` in a warehouse re-scans and
//    re-sorts n rows per block, which is the difference between a
//    grid that scrolls and one that times out at row 200k. Snowflake
//    has no row-value comparison, so the cursor predicate compiles to
//    an expanded lexicographic chain — which also gets mixed-direction
//    multi-sort right, something the tuple form cannot express.
//
// 4. WIDE INTEGERS STAY WIDE. NUMBER(38,0) is Snowflake's default
//    integer and exceeds float64's exact range, so the type mapper
//    puts it on `int64` and the DataSource stringifies BigInt row ids
//    rather than coercing them — a rounded cursor silently skips rows.
//
// 5. CDC VIA STREAMS. Snowflake's native change primitive, polled
//    behind the free `SYSTEM$STREAM_HAS_DATA` pre-check, with the
//    DELETE/INSERT pair Snowflake emits for an update collapsed into
//    one `update` diff. Poll shape matches @onegrid/mysql.
// =============================================================================

/** @public */
export { createSnowflakeDataSource } from './datasource';
/** @public */
export type {
  SnowflakeDataSourceOptions,
  SnowflakeQueryable,
  SnowflakeResult,
  SnowflakeStatement,
} from './datasource';

/** @public */
export {
  compileBlockQuery,
  resolveIdent,
  encodeKeysetCursor,
  decodeKeysetCursor,
  isKeysetCursor,
  isLegacyOffsetCursor,
} from './sql';
/** @public */
export type {
  CompiledQuery,
  SnowflakeDedupe,
  SnowflakeTableDescriptor,
} from './sql';

/** @public */
export {
  buildSnowflakeSchema,
  isBigIntSafeRequired,
  parseSnowflakeType,
  snowflakeColumnType,
} from './type';
/** @public */
export type { SnowflakeColumnDescription, SnowflakeTypeOptions } from './type';

/** @public */
export {
  createSnowflakeCdcAdapter,
  createStreamStatement,
  streamHasDataStatement,
  SnapshotRequired,
} from './cdc';
/** @public */
export type {
  SnowflakeCdcAdapter,
  SnowflakeCdcAdapterOptions,
  SnowflakeStreamConsumeMode,
} from './cdc';
