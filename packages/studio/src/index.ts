// =============================================================================
// @onegrid/studio
//
// A headless Postgres table editor. Everything the Supabase table editor,
// pgAdmin, TablePlus, Prisma Studio or a Retool database resource does to a
// database — modelled as data and pure functions, with no rendering and no
// database driver. A separate package owns the React surface; this one owns
// the logic that surface needs to be correct.
//
// The design decisions that shaped it:
//
// **It is a compiler, not a client.** Nothing here opens a connection.
// `introspectDatabase` is the only function that performs I/O, and it does so
// through `PostgresQueryable` — a two-line interface any driver satisfies,
// deliberately shaped like `SqliteQueryable` in `@onegrid/sqlite` so an
// adopter recognises it. Everything else takes data and returns SQL. That is
// what makes the whole package testable without a server, runnable in a
// worker, and safe to import into a browser bundle.
//
// **Schema introspection builds on `@onegrid/introspect` rather than
// duplicating it.** That package already maps the SQL type vocabulary to the
// protocol's `ColumnType`; this one adds the catalog queries and the rich
// descriptors — constraint, index, trigger, policy, enum, sequence — that a
// type mapper has no business knowing about.
//
// **Foreign keys are read from `pg_constraint`, never from
// `information_schema`.** The information_schema join produces a cartesian
// product on composite keys — measured at 12,221 bogus foreign keys across
// 113 tables on a real database, against 77 real ones. `introspect.ts`
// carries the full explanation; it is the single most consequential
// correctness decision in the package, because a relationship graph built on
// bad edges poisons the FK picker, the "referenced by" badges and every
// generated join.
//
// **DDL is a data structure before it is a string.** `DdlOperation` is a
// discriminated union of thirty-one schema changes, and `compileDdl` turns
// one operation into exactly one statement. Keeping the operation as data is
// what lets `assessRisk` warn about it, `reverseOperation` undo it,
// `planMigration` produce it, and a review panel render it — none of which
// is possible once it is a string.
//
// **Risk assessment assumes the worst when it does not know.** An unknown
// row count is treated as a large populated table, because the failure mode
// of assuming "empty" is an outage and the failure mode of assuming "large"
// is an unnecessary warning.
//
// **Reversal is honest about what it cannot do.** `reverseOperation` returns
// null for a dropped column, a dropped table, and an added enum value —
// rather than emitting a CREATE that restores the shape and not the data,
// which would be a lie a UI would repeat to a user.
// =============================================================================

// --- Identifier + literal safety ---------------------------------------------
export {
  isBareIdentifier,
  qualifiedIdentifier,
  sqlLiteral,
  sqlSafeExpression,
  sqlSafeIdentifier,
  sqlSafeTypeName,
} from './identifier';

// --- Schema model -------------------------------------------------------------
export {
  findColumn,
  findTable,
  isColumnWriteBlocked,
  tableKey,
} from './model';
export type {
  CheckConstraintDescriptor,
  ColumnDescriptor,
  ColumnIdentityKind,
  CompiledStatement,
  DatabaseSchema,
  EnumTypeDescriptor,
  ForeignKeyAction,
  ForeignKeyDescriptor,
  IndexDescriptor,
  IndexMethod,
  PolicyCommand,
  PostgresQueryable,
  PrimaryKeyDescriptor,
  RelationKind,
  RlsPolicyDescriptor,
  SequenceDescriptor,
  TableDescriptor,
  TableRef,
  TriggerDescriptor,
  TriggerEvent,
  TriggerTiming,
  UniqueConstraintDescriptor,
  ViewDescriptor,
} from './model';

// --- Introspection ------------------------------------------------------------
export {
  INTROSPECTION_QUERY,
  assembleSchema,
  introspectDatabase,
  stringArray,
} from './introspect';
export type { IntrospectOptions, IntrospectionRowSet } from './introspect';

// --- DDL compilation ----------------------------------------------------------
export { compileDdl, compileDdlBatch } from './ddl';
export type {
  AddCheckOperation,
  AddColumnOperation,
  AddEnumValueOperation,
  AddForeignKeyOperation,
  AddPrimaryKeyOperation,
  AddUniqueOperation,
  AlterColumnTypeOperation,
  ColumnSpec,
  CreateEnumOperation,
  CreateIndexOperation,
  CreatePolicyOperation,
  CreateSchemaOperation,
  CreateTableOperation,
  DdlOperation,
  DdlOperationKind,
  DisableRlsOperation,
  DropColumnDefaultOperation,
  DropColumnOperation,
  DropConstraintOperation,
  DropEnumOperation,
  DropForeignKeyOperation,
  DropIndexOperation,
  DropNotNullOperation,
  DropPolicyOperation,
  DropPrimaryKeyOperation,
  DropSchemaOperation,
  DropTableOperation,
  EnableRlsOperation,
  RenameColumnOperation,
  RenameTableOperation,
  SetColumnCommentOperation,
  SetColumnDefaultOperation,
  SetNotNullOperation,
  SetTableCommentOperation,
} from './ddl';

// --- Row-level DML ------------------------------------------------------------
export {
  buildRowDefault,
  bulkDelete,
  deleteRow,
  duplicateRow,
  insertRow,
  isDatabaseGenerated,
  listRow,
  parseDefaultLiteral,
  selectRow,
  updateRow,
} from './dml';
export type { RowDefault, RowDefaultField, RowKey, RowValue } from './dml';

// --- Relationship intelligence -------------------------------------------------
export {
  buildJoinQuery,
  detectDisplayColumn,
  foreignKeyLookup,
  isJunctionTable,
  isUniquelyConstrained,
  relationFieldName,
  resolveRelationship,
} from './relationship';
export type {
  ForeignKeyLookupInput,
  ForeignKeyLookupQuery,
  InboundRelationship,
  JoinEmbed,
  JoinQuery,
  JoinQueryOptions,
  OutboundRelationship,
  RelationshipCardinality,
  RelationshipGraph,
  TableRelationship,
} from './relationship';

// --- Migration safety -----------------------------------------------------------
export {
  DDL_OPERATION_KIND,
  MIGRATION_PHASE,
  assessMigration,
  assessRisk,
  highestRisk,
  planMigration,
  reverseMigration,
  reverseOperation,
  sortTableByDependency,
} from './migration';
export type {
  AssessedOperation,
  MigrationPhase,
  MigrationPlanOptions,
  RiskAssessment,
  RiskContext,
  RiskLevel,
} from './migration';

// --- SQL editor support ----------------------------------------------------------
export { classifyScript, classifyStatement, splitStatement, stripComment } from './statement';
export type { SqlStatement, StatementClass } from './statement';

export {
  applyDelete,
  applyDdl,
  applyInsert,
  applyList,
  applySelect,
  applyStatement,
  applyUpdate,
  createStudioSession,
} from './apply';
export type { StudioSession } from './apply';

export { createMemoryQueryable } from './memory';
export type { MemoryQueryable } from './memory';

export { seedStudioDemo } from './seed';

export { measureQuery } from './bench';
export type { QueryBenchResult } from './bench';
