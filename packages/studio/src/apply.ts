// =============================================================================
// Apply compiled statements to a queryable.
//
// Compilation stays pure (`compileDdl` / `insertRow` / …). This module is
// the one I/O step: send the statement, return the rows the server produced
// (`RETURNING *` for DML, empty for DDL). Studio UI and the in-process
// memory queryable both go through here so a test never bypasses the
// compiler.
// =============================================================================

import { compileDdl, type DdlOperation } from './ddl';
import {
  deleteRow,
  insertRow,
  listRow,
  selectRow,
  updateRow,
  type RowKey,
  type RowValue,
} from './dml';
import { introspectDatabase } from './introspect';
import type { CompiledStatement, DatabaseSchema, PostgresQueryable, TableDescriptor } from './model';

/**
 * Run one compiled statement. Normalises the queryable's sync-or-async
 * return to an array of row objects.
 * @public
 */
export async function applyStatement(
  queryable: PostgresQueryable,
  statement: CompiledStatement,
): Promise<readonly Record<string, unknown>[]> {
  const result: unknown = await queryable.query(statement.sql, statement.param);
  if (Array.isArray(result)) return result as readonly Record<string, unknown>[];
  if (result && typeof result === 'object' && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: Record<string, unknown>[] }).rows;
  }
  return [];
}

/**
 * Compile a DDL operation and apply it. Returns the compiled statement so
 * a SQL preview can show what ran without compiling twice.
 * @public
 */
export async function applyDdl(
  queryable: PostgresQueryable,
  operation: DdlOperation,
): Promise<CompiledStatement> {
  const statement = compileDdl(operation);
  await applyStatement(queryable, statement);
  return statement;
}

/**
 * Compile + apply an INSERT. Returns the row that actually landed.
 * @public
 */
export async function applyInsert(
  queryable: PostgresQueryable,
  table: TableDescriptor,
  value: RowValue,
): Promise<readonly Record<string, unknown>[]> {
  return applyStatement(queryable, insertRow(table, value));
}

/**
 * Compile + apply an UPDATE addressed by primary key.
 * @public
 */
export async function applyUpdate(
  queryable: PostgresQueryable,
  table: TableDescriptor,
  key: RowKey,
  patch: RowValue,
): Promise<readonly Record<string, unknown>[]> {
  return applyStatement(queryable, updateRow(table, key, patch));
}

/**
 * Compile + apply a DELETE addressed by primary key.
 * @public
 */
export async function applyDelete(
  queryable: PostgresQueryable,
  table: TableDescriptor,
  key: RowKey,
): Promise<readonly Record<string, unknown>[]> {
  return applyStatement(queryable, deleteRow(table, key));
}

/**
 * Compile + apply a SELECT of every row in a table.
 * @public
 */
export async function applyList(
  queryable: PostgresQueryable,
  table: TableDescriptor,
): Promise<readonly Record<string, unknown>[]> {
  return applyStatement(queryable, listRow(table));
}

/**
 * Compile + apply a SELECT of one row by primary key.
 * @public
 */
export async function applySelect(
  queryable: PostgresQueryable,
  table: TableDescriptor,
  key: RowKey,
): Promise<readonly Record<string, unknown>[]> {
  return applyStatement(queryable, selectRow(table, key));
}

/**
 * A session: one queryable, apply helpers, and a refresh that re-introspects.
 * @public
 */
export interface StudioSession {
  readonly queryable: PostgresQueryable;
  applyDdl(operation: DdlOperation): Promise<CompiledStatement>;
  insert(table: TableDescriptor, value: RowValue): Promise<readonly Record<string, unknown>[]>;
  update(
    table: TableDescriptor,
    key: RowKey,
    patch: RowValue,
  ): Promise<readonly Record<string, unknown>[]>;
  remove(table: TableDescriptor, key: RowKey): Promise<readonly Record<string, unknown>[]>;
  list(table: TableDescriptor): Promise<readonly Record<string, unknown>[]>;
  introspect(): Promise<DatabaseSchema>;
}

/**
 * Bind apply helpers to one queryable. The fixture path is a session
 * constructed with {@link createMemoryQueryable}, not a hardcoded schema.
 * @public
 */
export function createStudioSession(queryable: PostgresQueryable): StudioSession {
  return {
    queryable,
    applyDdl: (operation) => applyDdl(queryable, operation),
    insert: (table, value) => applyInsert(queryable, table, value),
    update: (table, key, patch) => applyUpdate(queryable, table, key, patch),
    remove: (table, key) => applyDelete(queryable, table, key),
    list: (table) => applyList(queryable, table),
    introspect: () => introspectDatabase(queryable),
  };
}
