// =============================================================================
// @onegrid/prisma
//
// Prisma adapter for oneGrid's server-side row model.
//
// Design decisions, and why:
//
//   - No dependency on `@prisma/client`, by necessity rather than preference.
//     The generated client is a per-project artifact built from the adopter's
//     own `schema.prisma`; there is no stable package to depend on. What every
//     generated client does have is a delegate per model exposing the same six
//     methods, so the adapter declares that shape as `PrismaDelegate` and
//     accepts `prisma.order` structurally. The same interface is what makes
//     the test suite run against an in-memory fake instead of a database.
//
//   - `cursor` + `take` + `skip: 1`, never `skip: N`. Prisma's `skip` is
//     OFFSET, and OFFSET makes the database walk and discard every skipped
//     row — scrolling to row 500 000 costs 500 000 rows of work. Cursor
//     pagination re-anchors on an indexed unique value, and `take: -n` serves
//     the `before` direction without inverting the sort by hand.
//
//   - Grouping goes through `groupBy`, so the rollup happens in SQL. A group
//     over 200 000 rows returns one row, not 200 000. Prisma answers with
//     nested aggregate buckets (`{ _sum: { revenue } }`); the adapter
//     flattens them into the protocol's documented one-row-per-group shape
//     with `__count__`.
//
//   - `BigInt` and `Decimal` stay off the float64 path. Prisma returns those
//     as a native `bigint` and a Decimal.js instance precisely because they
//     do not fit a double — large ids and money. They map to `int64` and
//     `decimal`, and `normalizePrismaRow` serialises them as strings, because
//     `JSON.stringify` throws on a bigint and quietly emits Decimal.js
//     internals for a Decimal.
//
//   - Live sync conforms to `@onegrid/orm-sync` instead of duplicating it.
//     That package already owns the Prisma-side contract (`extractFromPrisma`,
//     `bindOrmSync`); this one supplies the missing `CdcAdapter` and wires the
//     two together. Prisma has no change feed, so the default adapter polls a
//     monotonic column — and says so rather than implying otherwise.
// =============================================================================

/** @public */
export { createPrismaDataSource } from './datasource';
/** @public */
export type { PrismaDataSourceOptions, PrismaDelegate } from './datasource';

/** @public */
export {
  aliasOf,
  compileOrderBy,
  compilePrismaQuery,
  compileSelect,
  compileWhere,
  decodeKeysetCursor,
  encodeKeysetCursor,
  isKeysetCursor,
  parseGroupByResult,
  GROUP_COUNT_KEY,
} from './query';
/** @public */
export type {
  CompiledFindManyQuery,
  CompiledGroupByQuery,
  CompiledMetric,
  CompiledPrismaQuery,
  PrismaFindManyArg,
  PrismaGroupByArg,
  PrismaModelDescriptor,
  PrismaOrderBy,
  PrismaWhere,
} from './query';

/** @public */
export {
  descriptorFromDmmf,
  normalizePrismaRow,
  primaryKeyOfDmmf,
  prismaTypeToColumnType,
  schemaFromDmmf,
  toOrmSyncModel,
} from './schema';
/** @public */
export type {
  NormalizeOptions,
  PrismaDmmfField,
  PrismaDmmfModel,
  PrismaFieldKind,
  PrismaSyncField,
  PrismaSyncModel,
  SchemaFromDmmfOptions,
} from './schema';

/** @public */
export { bindPrismaSync, createPrismaCdcAdapter } from './sync';
/** @public */
export type {
  BindPrismaSyncOptions,
  PrismaCdcAdapter,
  PrismaCdcAdapterOptions,
  PrismaCdcScheduler,
} from './sync';
