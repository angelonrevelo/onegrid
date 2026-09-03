// =============================================================================
// Row-level DML.
//
// Unlike DDL, these are plannable statements, so every value flows through a
// real `$n` bind. No user value is ever concatenated into the SQL — only
// identifiers, which come from a `TableDescriptor` the database itself
// produced and are quoted anyway.
//
// Two decisions worth stating:
//
// 1. **Primary-key-aware, compound-key-first.** A row is addressed by a
//    `RowKey` — `Record<columnName, value>` — not by a scalar id. Every
//    UPDATE and DELETE requires the full primary key and throws when a key
//    column is missing, because an UPDATE that silently drops half a
//    compound key predicate rewrites the wrong rows and there is no undo for
//    that. Tables without a primary key are rejected outright rather than
//    falling back to `ctid`: `ctid` moves under VACUUM, so a UI holding one
//    across a round trip can address a different row than the one the user
//    clicked.
//
// 2. **Everything returns `RETURNING *`.** A table editor has to show the
//    row that actually landed, not the row it sent — defaults fired,
//    triggers rewrote values, an identity column allocated. Making it
//    unconditional means the caller never has to decide.
// =============================================================================

import { qualifiedIdentifier, sqlSafeIdentifier } from './identifier';
import {
  isColumnWriteBlocked,
  type ColumnDescriptor,
  type CompiledStatement,
  type TableDescriptor,
} from './model';

/** A row addressed by its primary key. Every key column must be present.
 * @public
 */
export type RowKey = Readonly<Record<string, unknown>>;

/** Column values for an insert or update.
 * @public
 */
export type RowValue = Readonly<Record<string, unknown>>;

/**
 * Compile an INSERT for one row.
 *
 * Columns absent from `value` are simply left out of the column list, so the
 * database applies its own defaults — which is what an "add row" form wants
 * when the user leaves a defaulted field untouched. An entirely empty `value`
 * compiles to `DEFAULT VALUES`, the only legal spelling of a zero-column
 * insert in Postgres.
 * @public
 */
export function insertRow(
  table: TableDescriptor,
  value: RowValue,
): CompiledStatement {
  const entry = Object.entries(value).filter(([name]) => {
    requireColumn(table, name);
    return true;
  });
  const target = relation(table);
  if (entry.length === 0) {
    return { sql: `INSERT INTO ${target} DEFAULT VALUES RETURNING *`, param: [] };
  }
  const param: unknown[] = [];
  const column: string[] = [];
  const placeholder: string[] = [];
  for (const [name, v] of entry) {
    column.push(sqlSafeIdentifier(name));
    param.push(v);
    placeholder.push(`$${String(param.length)}`);
  }
  return {
    sql: `INSERT INTO ${target} (${column.join(', ')}) VALUES (${placeholder.join(', ')}) RETURNING *`,
    param,
  };
}

/**
 * Compile an UPDATE of one row addressed by its full primary key.
 *
 * The SET clause is built first so its placeholders come before the WHERE
 * clause's, which keeps the parameter array in the same order a reader
 * expects when debugging a logged statement.
 * @public
 */
export function updateRow(
  table: TableDescriptor,
  key: RowKey,
  patch: RowValue,
): CompiledStatement {
  const entry = Object.entries(patch);
  if (entry.length === 0) {
    throw new Error(
      `@onegrid/studio: updateRow on ${table.schema}.${table.name} needs at least one column to set.`,
    );
  }
  const param: unknown[] = [];
  const assignment: string[] = [];
  for (const [name, v] of entry) {
    requireColumn(table, name);
    param.push(v);
    assignment.push(`${sqlSafeIdentifier(name)} = $${String(param.length)}`);
  }
  const where = compileKeyPredicate(table, key, param);
  return {
    sql: `UPDATE ${relation(table)} SET ${assignment.join(', ')} WHERE ${where} RETURNING *`,
    param,
  };
}

/**
 * Compile a DELETE of one row addressed by its full primary key.
 * @public
 */
export function deleteRow(table: TableDescriptor, key: RowKey): CompiledStatement {
  const param: unknown[] = [];
  const where = compileKeyPredicate(table, key, param);
  return {
    sql: `DELETE FROM ${relation(table)} WHERE ${where} RETURNING *`,
    param,
  };
}

/**
 * Compile a "duplicate this row" INSERT.
 *
 * Written as `INSERT ... SELECT` rather than read-then-write so the copy is
 * atomic and never round-trips the row's values through the client — which
 * matters for large jsonb, bytea, and anything the driver would lose
 * precision on. Identity-ALWAYS and stored generated columns are excluded so
 * the database re-derives them; the primary key is excluded too when it is a
 * single column the database can regenerate (identity or a `nextval`
 * default), and kept otherwise so the caller is forced to override it via
 * `override` rather than silently inserting a duplicate key.
 * @public
 */
export function duplicateRow(
  table: TableDescriptor,
  key: RowKey,
  override: RowValue = {},
): CompiledStatement {
  const skip = new Set<string>(Object.keys(override));
  for (const column of table.column) {
    if (isColumnWriteBlocked(column)) skip.add(column.name);
    if (isPrimaryKeyColumn(table, column.name) && isDatabaseGenerated(column)) {
      skip.add(column.name);
    }
  }
  const copied = table.column.filter((c) => !skip.has(c.name));
  const overridden = Object.keys(override);
  for (const name of overridden) requireColumn(table, name);
  if (copied.length === 0 && overridden.length === 0) {
    throw new Error(
      `@onegrid/studio: duplicateRow on ${table.schema}.${table.name} has no copyable column.`,
    );
  }

  const param: unknown[] = [];
  const projection: string[] = copied.map((c) => sqlSafeIdentifier(c.name));
  for (const name of overridden) {
    param.push(override[name]);
    projection.push(`$${String(param.length)}`);
  }
  const columnList = [
    ...copied.map((c) => sqlSafeIdentifier(c.name)),
    ...overridden.map((n) => sqlSafeIdentifier(n)),
  ];
  const where = compileKeyPredicate(table, key, param);
  const target = relation(table);
  return {
    sql: `INSERT INTO ${target} (${columnList.join(', ')}) SELECT ${projection.join(', ')} FROM ${target} WHERE ${where} RETURNING *`,
    param,
  };
}

/**
 * Compile a multi-row DELETE.
 *
 * A single-column key uses `= ANY($1)` — one parameter holding an array,
 * which keeps the statement text identical for 1 row and 10,000 and so
 * reuses the same prepared plan. A compound key has no `ANY` spelling, so it
 * falls back to a row-constructor `IN` list with one parameter per key
 * column per row; the statement text then varies with row count, which is
 * the price of composite keys and is worth naming.
 * @public
 */
export function bulkDelete(
  table: TableDescriptor,
  key: readonly RowKey[],
): CompiledStatement {
  const keyColumn = requirePrimaryKey(table);
  if (key.length === 0) {
    throw new Error('@onegrid/studio: bulkDelete needs at least one row key.');
  }
  const target = relation(table);
  const single = keyColumn.length === 1 ? keyColumn[0] : undefined;
  if (single !== undefined) {
    const value = key.map((k) => readKeyValue(table, k, single));
    return {
      sql: `DELETE FROM ${target} WHERE ${sqlSafeIdentifier(single)} = ANY($1) RETURNING *`,
      param: [value],
    };
  }
  const param: unknown[] = [];
  const tuple = key.map((k) => {
    const slot = keyColumn.map((c) => {
      param.push(readKeyValue(table, k, c));
      return `$${String(param.length)}`;
    });
    return `(${slot.join(', ')})`;
  });
  const lhs = keyColumn.map(sqlSafeIdentifier).join(', ');
  return {
    sql: `DELETE FROM ${target} WHERE (${lhs}) IN (${tuple.join(', ')}) RETURNING *`,
    param,
  };
}

/**
 * Compile a keyset-free SELECT of one row by primary key — the query behind
 * "open this row in the side panel".
 * @public
 */
export function selectRow(table: TableDescriptor, key: RowKey): CompiledStatement {
  const param: unknown[] = [];
  const where = compileKeyPredicate(table, key, param);
  return { sql: `SELECT * FROM ${relation(table)} WHERE ${where} LIMIT 1`, param };
}

/**
 * Compile a SELECT of every row in a table — the grid's data source after
 * an apply. No filter, no keyset; the caller pages if they need to.
 * @public
 */
export function listRow(table: TableDescriptor): CompiledStatement {
  return { sql: `SELECT * FROM ${relation(table)}`, param: [] };
}

// -----------------------------------------------------------------------------
// Default row for the "add row" form
// -----------------------------------------------------------------------------

/** One field of the form an "add row" dialog renders.
 * @public
 */
export interface RowDefaultField {
  readonly column: string;
  readonly dataType: string;
  /** The value the form starts with. `undefined` when the database supplies
   *  it and the form should show a placeholder instead of an input value. */
  readonly value: unknown;
  /** True when the value comes from the database — an identity column, a
   *  generated column, or a default that is a function call rather than a
   *  literal. The form shows these read-only. */
  readonly isDatabaseGenerated: boolean;
  /** NOT NULL with no default: the form cannot submit until it is filled. */
  readonly isRequired: boolean;
  readonly defaultExpression: string | null;
  /** Labels when the column is an enum, so the form can render a select. */
  readonly enumTypeName: string | null;
}

/** The starting state of an "add row" form.
 * @public
 */
export interface RowDefault {
  readonly field: readonly RowDefaultField[];
  /** The subset of `field` a client should actually send, as a row object.
   *  Database-generated columns are omitted entirely rather than sent as
   *  null, because sending null to an identity column is an error while
   *  omitting it is the intent. */
  readonly value: Record<string, unknown>;
}

/**
 * Build the default row an "add row" form starts from.
 *
 * The rules, in the order they apply:
 *   - identity ALWAYS and stored generated columns are database-generated
 *     and are never sent;
 *   - a default expression that parses as a literal (`'draft'`, `0`, `true`,
 *     `NULL`) becomes that value, so the form shows what will actually land;
 *   - a default expression that is a function call (`now()`,
 *     `gen_random_uuid()`, `nextval(...)`) is database-generated — we do not
 *     evaluate it client-side, because a client clock is not the server
 *     clock and a UUID generated here is not the one the row will get;
 *   - a nullable column with no default starts as null;
 *   - a NOT NULL column with no default starts as null and is marked
 *     required, which is what makes the form's submit button correct.
 * @public
 */
export function buildRowDefault(table: TableDescriptor): RowDefault {
  const field: RowDefaultField[] = [];
  const value: Record<string, unknown> = {};
  for (const column of table.column) {
    const generated = isDatabaseGenerated(column);
    const literal = generated ? undefined : parseDefaultLiteral(column.defaultExpression);
    const hasLiteral = literal !== undefined;
    const initial = hasLiteral ? literal.value : generated ? undefined : null;
    const entry: RowDefaultField = {
      column: column.name,
      dataType: column.dataType,
      value: initial,
      isDatabaseGenerated: generated,
      isRequired: !column.isNullable && !generated && !hasLiteral,
      defaultExpression: column.defaultExpression,
      enumTypeName: column.enumTypeName,
    };
    field.push(entry);
    if (!generated) value[column.name] = initial;
  }
  return { field, value };
}

/** True when the database — not the client — supplies this column's value.
 * @public
 */
export function isDatabaseGenerated(column: ColumnDescriptor): boolean {
  if (isColumnWriteBlocked(column)) return true;
  if (column.identity === 'by default') return true;
  const def = column.defaultExpression;
  if (def === null) return false;
  return parseDefaultLiteral(def) === undefined;
}

interface ParsedLiteral {
  readonly value: unknown;
}

/**
 * Parse a Postgres default expression when — and only when — it is a plain
 * literal. Returns `undefined` for anything else, which the caller reads as
 * "the server has to compute this".
 *
 * Deliberately narrow. A default like `('a'::text || 'b'::text)` is
 * computable in principle and is not attempted, because a wrong guess in a
 * form is worse than an honest "the database will fill this in".
 * @public
 */
export function parseDefaultLiteral(
  expression: string | null,
): ParsedLiteral | undefined {
  if (expression === null) return undefined;
  // Postgres reports defaults with an explicit cast suffix: 'draft'::text.
  const stripped = expression.trim().replace(/::[A-Za-z_][A-Za-z0-9_ ."[\]]*$/, '').trim();
  if (stripped.length === 0) return undefined;
  if (/^NULL$/i.test(stripped)) return { value: null };
  if (/^TRUE$/i.test(stripped)) return { value: true };
  if (/^FALSE$/i.test(stripped)) return { value: false };
  if (/^-?\d+$/.test(stripped)) return { value: Number(stripped) };
  if (/^-?\d*\.\d+$/.test(stripped)) return { value: Number(stripped) };
  const quoted = /^'((?:[^']|'')*)'$/.exec(stripped);
  if (quoted !== null) return { value: quoted[1]?.replace(/''/g, "'") ?? '' };
  return undefined;
}

// -----------------------------------------------------------------------------
// Key handling
// -----------------------------------------------------------------------------

function relation(table: TableDescriptor): string {
  return qualifiedIdentifier(table.schema, table.name);
}

function requirePrimaryKey(table: TableDescriptor): readonly string[] {
  const pk = table.primaryKey;
  if (pk === null || pk.column.length === 0) {
    throw new Error(
      `@onegrid/studio: ${table.schema}.${table.name} has no primary key; row-level DML needs one to address a row unambiguously.`,
    );
  }
  return pk.column;
}

function isPrimaryKeyColumn(table: TableDescriptor, name: string): boolean {
  return table.primaryKey !== null && table.primaryKey.column.includes(name);
}

function readKeyValue(table: TableDescriptor, key: RowKey, column: string): unknown {
  if (!Object.prototype.hasOwnProperty.call(key, column)) {
    throw new Error(
      `@onegrid/studio: row key for ${table.schema}.${table.name} is missing primary-key column "${column}".`,
    );
  }
  const value = key[column];
  if (value === null || value === undefined) {
    // `WHERE id = NULL` matches nothing, so a null key silently no-ops an
    // UPDATE and looks like a lost write. Fail instead.
    throw new Error(
      `@onegrid/studio: primary-key column "${column}" cannot be null in a row key.`,
    );
  }
  return value;
}

function compileKeyPredicate(
  table: TableDescriptor,
  key: RowKey,
  param: unknown[],
): string {
  const keyColumn = requirePrimaryKey(table);
  return keyColumn
    .map((column) => {
      param.push(readKeyValue(table, key, column));
      return `${sqlSafeIdentifier(column)} = $${String(param.length)}`;
    })
    .join(' AND ');
}

function requireColumn(table: TableDescriptor, name: string): void {
  if (!table.column.some((c) => c.name === name)) {
    throw new Error(
      `@onegrid/studio: unknown column "${name}" on ${table.schema}.${table.name}.`,
    );
  }
}
