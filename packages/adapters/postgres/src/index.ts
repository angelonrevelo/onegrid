// =============================================================================
// @onegrid/postgres
//
// Raw Postgres adapter for oneGrid SSRM. Translates BlockRequest
// into parameterized SQL via a pure SQL compiler; subscribes to
// LISTEN/NOTIFY for row-diff events.
//
// Requires `pg` ^8.11.0 as a peer dependency. The adapter borrows a
// pg client/pool from the caller — it does NOT manage the
// connection lifecycle.
//
// See README.md for the recommended database trigger setup that
// emits NOTIFY messages on every row mutation.
// =============================================================================

export { createPgDataSource } from './datasource';
export type { PgDataSourceOptions, PgQueryable } from './datasource';

export { createHttpQueryable } from './http';
export type { HttpQueryableOption } from './http';

export { createPgCdcAdapter, SnapshotRequired } from './cdc';
export type {
  PgCdcAdapter,
  PgCdcAdapterOptions,
  PgListenClient,
  PgNotification,
} from './cdc';

export {
  compileBlockQuery,
  encodeKeysetCursor,
  decodeKeysetCursor,
  isKeysetCursor,
  isLegacyOffsetCursor,
} from './sql';
export type { CompiledQuery, PgTableDescriptor } from './sql';
