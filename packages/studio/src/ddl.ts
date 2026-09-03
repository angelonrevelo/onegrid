// =============================================================================
// DDL compilation.
//
// `DdlOperation` is a discriminated union of every schema change a table
// editor can make, and `compileDdl` turns one operation into one Postgres
// statement. Four decisions:
//
// 1. **One operation, one statement.** No operation compiles to a script.
//    That keeps `assessRisk` honest (a risk verdict describes exactly one
//    statement), makes `reverseOperation` a total function on the union, and
//    means a UI can run operations through its own transaction policy rather
//    than inheriting ours. Multi-statement changes are `DdlOperation[]`, and
//    `planMigration` produces exactly that.
//
// 2. **The union is data, not builders.** A `createTable` operation is a
//    plain object. It can be persisted, diffed, replayed, shown in a "review
//    these changes" panel, and round-tripped through JSON. A builder API
//    would have made the fluent path prettier and the review panel
//    impossible.
//
// 3. **`param` is always empty.** Postgres refuses bind parameters in
//    utility statements, so every literal here is escaped by `sqlLiteral`
//    instead. The field exists so DDL and DML share `CompiledStatement`, and
//    it is documented rather than quietly dropped, because "why is this not
//    parameterised" is the first question a reviewer asks.
//
// 4. **Expression positions are declared as expressions.** A CHECK body, an
//    RLS `USING` clause, a column default and an index predicate are SQL
//    code, not values. They pass through `sqlSafeExpression`, which blocks
//    the statement-splitting characters and otherwise trusts the caller. The
//    type names them `*Expression` so no one mistakes them for data.
// =============================================================================

import {
  qualifiedIdentifier,
  sqlLiteral,
  sqlSafeExpression,
  sqlSafeIdentifier,
  sqlSafeTypeName,
} from './identifier';
import type {
  CompiledStatement,
  ForeignKeyAction,
  IndexMethod,
  PolicyCommand,
} from './model';

// -----------------------------------------------------------------------------
// Column specification — shared by createTable and addColumn
// -----------------------------------------------------------------------------

/** A column as a human specifies it in a New Column form. Distinct from
 *  `ColumnDescriptor`, which is what the database reports back.
 * @public
 */
export interface ColumnSpec {
  readonly name: string;
  /** Postgres type name, with modifier if any: `text`, `numeric(10,2)`. */
  readonly type: string;
  readonly isNullable?: boolean;
  /** Raw default expression — `now()`, `'draft'`, `gen_random_uuid()`. */
  readonly defaultExpression?: string;
  /** Emit `GENERATED ALWAYS/BY DEFAULT AS IDENTITY`. */
  readonly identity?: 'always' | 'by default';
  /** Emit `GENERATED ALWAYS AS (expr) STORED`. */
  readonly generatedExpression?: string;
  readonly isUnique?: boolean;
  readonly isPrimaryKey?: boolean;
  readonly comment?: string;
  /** Inline single-column REFERENCES clause. */
  readonly reference?: {
    readonly schema?: string;
    readonly table: string;
    readonly column: string;
    readonly onDelete?: ForeignKeyAction;
    readonly onUpdate?: ForeignKeyAction;
  };
}

// -----------------------------------------------------------------------------
// The operation union
// -----------------------------------------------------------------------------

/** @public */
export interface CreateSchemaOperation {
  readonly kind: 'createSchema';
  readonly schema: string;
  readonly ifNotExists?: boolean;
  readonly authorization?: string;
}

/** @public */
export interface DropSchemaOperation {
  readonly kind: 'dropSchema';
  readonly schema: string;
  readonly cascade?: boolean;
  readonly ifExists?: boolean;
}

/** @public */
export interface CreateTableOperation {
  readonly kind: 'createTable';
  readonly schema: string;
  readonly table: string;
  readonly column: readonly ColumnSpec[];
  /** Compound primary key. A single-column key can also be set with
   *  `ColumnSpec.isPrimaryKey`; setting both is an error. */
  readonly primaryKeyColumn?: readonly string[];
  readonly ifNotExists?: boolean;
  readonly isUnlogged?: boolean;
}

/** @public */
export interface DropTableOperation {
  readonly kind: 'dropTable';
  readonly schema: string;
  readonly table: string;
  readonly cascade?: boolean;
  readonly ifExists?: boolean;
}

/** @public */
export interface RenameTableOperation {
  readonly kind: 'renameTable';
  readonly schema: string;
  readonly table: string;
  readonly newName: string;
}

/** @public */
export interface SetTableCommentOperation {
  readonly kind: 'setTableComment';
  readonly schema: string;
  readonly table: string;
  /** null clears the comment (`IS NULL`). */
  readonly comment: string | null;
}

/** @public */
export interface AddColumnOperation {
  readonly kind: 'addColumn';
  readonly schema: string;
  readonly table: string;
  readonly column: ColumnSpec;
  readonly ifNotExists?: boolean;
}

/** @public */
export interface DropColumnOperation {
  readonly kind: 'dropColumn';
  readonly schema: string;
  readonly table: string;
  readonly column: string;
  readonly cascade?: boolean;
  readonly ifExists?: boolean;
}

/** @public */
export interface RenameColumnOperation {
  readonly kind: 'renameColumn';
  readonly schema: string;
  readonly table: string;
  readonly column: string;
  readonly newName: string;
}

/** @public */
export interface AlterColumnTypeOperation {
  readonly kind: 'alterColumnType';
  readonly schema: string;
  readonly table: string;
  readonly column: string;
  readonly newType: string;
  /** `USING` cast expression. Postgres requires one whenever there is no
   *  assignment cast between the old and new type, and a UI that omits it
   *  gets a runtime error instead of a review-time warning. */
  readonly usingExpression?: string;
  /** Carried for `reverseOperation`; never emitted. */
  readonly previousType?: string;
}

/** @public */
export interface SetColumnDefaultOperation {
  readonly kind: 'setColumnDefault';
  readonly schema: string;
  readonly table: string;
  readonly column: string;
  readonly expression: string;
  /** Carried so the reverse restores the old default rather than dropping
   *  the default outright. */
  readonly previousExpression?: string | null;
}

/** @public */
export interface DropColumnDefaultOperation {
  readonly kind: 'dropColumnDefault';
  readonly schema: string;
  readonly table: string;
  readonly column: string;
  readonly previousExpression?: string | null;
}

/** @public */
export interface SetNotNullOperation {
  readonly kind: 'setNotNull';
  readonly schema: string;
  readonly table: string;
  readonly column: string;
}

/** @public */
export interface DropNotNullOperation {
  readonly kind: 'dropNotNull';
  readonly schema: string;
  readonly table: string;
  readonly column: string;
}

/** @public */
export interface SetColumnCommentOperation {
  readonly kind: 'setColumnComment';
  readonly schema: string;
  readonly table: string;
  readonly column: string;
  readonly comment: string | null;
}

/** @public */
export interface AddPrimaryKeyOperation {
  readonly kind: 'addPrimaryKey';
  readonly schema: string;
  readonly table: string;
  readonly column: readonly string[];
  readonly name?: string;
}

/** @public */
export interface DropPrimaryKeyOperation {
  readonly kind: 'dropPrimaryKey';
  readonly schema: string;
  readonly table: string;
  /** Postgres has no `DROP PRIMARY KEY`; the constraint name is required. */
  readonly name: string;
  readonly cascade?: boolean;
}

/** @public */
export interface AddUniqueOperation {
  readonly kind: 'addUnique';
  readonly schema: string;
  readonly table: string;
  readonly column: readonly string[];
  readonly name?: string;
  /** Attach to an index built CONCURRENTLY, avoiding the table rewrite. */
  readonly usingIndex?: string;
}

/** @public */
export interface AddCheckOperation {
  readonly kind: 'addCheck';
  readonly schema: string;
  readonly table: string;
  readonly expression: string;
  readonly name?: string;
  /** `NOT VALID` skips the full-table scan; the constraint still applies to
   *  new rows and can be validated later. */
  readonly notValid?: boolean;
}

/** @public */
export interface DropConstraintOperation {
  readonly kind: 'dropConstraint';
  readonly schema: string;
  readonly table: string;
  readonly name: string;
  readonly cascade?: boolean;
  readonly ifExists?: boolean;
}

/** @public */
export interface AddForeignKeyOperation {
  readonly kind: 'addForeignKey';
  readonly schema: string;
  readonly table: string;
  readonly column: readonly string[];
  readonly referencedSchema?: string;
  readonly referencedTable: string;
  readonly referencedColumn: readonly string[];
  readonly onDelete?: ForeignKeyAction;
  readonly onUpdate?: ForeignKeyAction;
  readonly name?: string;
  readonly notValid?: boolean;
}

/** @public */
export interface DropForeignKeyOperation {
  readonly kind: 'dropForeignKey';
  readonly schema: string;
  readonly table: string;
  readonly name: string;
  readonly cascade?: boolean;
}

/** @public */
export interface CreateIndexOperation {
  readonly kind: 'createIndex';
  readonly schema: string;
  readonly table: string;
  readonly name?: string;
  /** Plain columns. Mutually exclusive with `expression` per position; give
   *  one or the other (or both, for a mixed index — columns emit first). */
  readonly column?: readonly string[];
  readonly expression?: readonly string[];
  readonly method?: IndexMethod;
  readonly isUnique?: boolean;
  /** CONCURRENTLY — cannot run inside a transaction block. The risk
   *  assessor treats its absence on a large table as blocking. */
  readonly isConcurrent?: boolean;
  /** `WHERE` body of a partial index. */
  readonly predicate?: string;
  readonly ifNotExists?: boolean;
  /** Per-column ordering, positionally aligned with `column`. */
  readonly ordering?: readonly ('asc' | 'desc')[];
  readonly nullOrdering?: readonly ('first' | 'last')[];
}

/** @public */
export interface DropIndexOperation {
  readonly kind: 'dropIndex';
  readonly schema: string;
  readonly name: string;
  readonly isConcurrent?: boolean;
  readonly cascade?: boolean;
  readonly ifExists?: boolean;
  /** Carried so `reverseOperation` can rebuild the index verbatim. */
  readonly previousDefinition?: string;
}

/** @public */
export interface CreateEnumOperation {
  readonly kind: 'createEnum';
  readonly schema: string;
  readonly name: string;
  readonly label: readonly string[];
}

/** @public */
export interface DropEnumOperation {
  readonly kind: 'dropEnum';
  readonly schema: string;
  readonly name: string;
  readonly cascade?: boolean;
  readonly ifExists?: boolean;
}

/** @public */
export interface AddEnumValueOperation {
  readonly kind: 'addEnumValue';
  readonly schema: string;
  readonly name: string;
  readonly label: string;
  readonly before?: string;
  readonly after?: string;
  readonly ifNotExists?: boolean;
}

/** @public */
export interface EnableRlsOperation {
  readonly kind: 'enableRls';
  readonly schema: string;
  readonly table: string;
  /** FORCE also applies policies to the table owner, who is otherwise
   *  exempt — the single most common RLS surprise. */
  readonly force?: boolean;
}

/** @public */
export interface DisableRlsOperation {
  readonly kind: 'disableRls';
  readonly schema: string;
  readonly table: string;
}

/** @public */
export interface CreatePolicyOperation {
  readonly kind: 'createPolicy';
  readonly schema: string;
  readonly table: string;
  readonly name: string;
  readonly command?: PolicyCommand;
  /** Default true (PERMISSIVE). */
  readonly isPermissive?: boolean;
  readonly role?: readonly string[];
  readonly usingExpression?: string;
  readonly withCheckExpression?: string;
}

/** @public */
export interface DropPolicyOperation {
  readonly kind: 'dropPolicy';
  readonly schema: string;
  readonly table: string;
  readonly name: string;
  readonly ifExists?: boolean;
}

/** Every schema change the studio can make, as one discriminated union.
 * @public
 */
export type DdlOperation =
  | CreateSchemaOperation
  | DropSchemaOperation
  | CreateTableOperation
  | DropTableOperation
  | RenameTableOperation
  | SetTableCommentOperation
  | AddColumnOperation
  | DropColumnOperation
  | RenameColumnOperation
  | AlterColumnTypeOperation
  | SetColumnDefaultOperation
  | DropColumnDefaultOperation
  | SetNotNullOperation
  | DropNotNullOperation
  | SetColumnCommentOperation
  | AddPrimaryKeyOperation
  | DropPrimaryKeyOperation
  | AddUniqueOperation
  | AddCheckOperation
  | DropConstraintOperation
  | AddForeignKeyOperation
  | DropForeignKeyOperation
  | CreateIndexOperation
  | DropIndexOperation
  | CreateEnumOperation
  | DropEnumOperation
  | AddEnumValueOperation
  | EnableRlsOperation
  | DisableRlsOperation
  | CreatePolicyOperation
  | DropPolicyOperation;

/** The `kind` discriminant of `DdlOperation`.
 * @public
 */
export type DdlOperationKind = DdlOperation['kind'];

// -----------------------------------------------------------------------------
// Compilation
// -----------------------------------------------------------------------------

/**
 * Compile one `DdlOperation` into one Postgres statement.
 *
 * The returned `param` is always empty: Postgres does not accept bind
 * parameters in utility statements, so literals are escaped inline by
 * `sqlLiteral`. Identifiers are validated and double-quoted by
 * `sqlSafeIdentifier`; expression positions are floor-checked by
 * `sqlSafeExpression`.
 * @public
 */
export function compileDdl(operation: DdlOperation): CompiledStatement {
  return { sql: compileSql(operation), param: [] };
}

/** Compile a list of operations into a list of statements, preserving order.
 *  A convenience over mapping `compileDdl`, and the shape a migration runner
 *  wants.
 * @public
 */
export function compileDdlBatch(
  operation: readonly DdlOperation[],
): readonly CompiledStatement[] {
  return operation.map(compileDdl);
}

function compileSql(op: DdlOperation): string {
  switch (op.kind) {
    case 'createSchema': {
      const exists = op.ifNotExists === true ? 'IF NOT EXISTS ' : '';
      const auth =
        op.authorization === undefined
          ? ''
          : ` AUTHORIZATION ${sqlSafeIdentifier(op.authorization)}`;
      return `CREATE SCHEMA ${exists}${sqlSafeIdentifier(op.schema)}${auth}`;
    }

    case 'dropSchema':
      return `DROP SCHEMA ${ifExists(op.ifExists)}${sqlSafeIdentifier(op.schema)}${cascade(op.cascade)}`;

    case 'createTable':
      return compileCreateTable(op);

    case 'dropTable':
      return `DROP TABLE ${ifExists(op.ifExists)}${rel(op)}${cascade(op.cascade)}`;

    case 'renameTable':
      return `ALTER TABLE ${rel(op)} RENAME TO ${sqlSafeIdentifier(op.newName)}`;

    case 'setTableComment':
      return `COMMENT ON TABLE ${rel(op)} IS ${commentValue(op.comment)}`;

    case 'addColumn': {
      const exists = op.ifNotExists === true ? 'IF NOT EXISTS ' : '';
      return `ALTER TABLE ${rel(op)} ADD COLUMN ${exists}${compileColumnSpec(op.column)}`;
    }

    case 'dropColumn':
      return `ALTER TABLE ${rel(op)} DROP COLUMN ${ifExists(op.ifExists)}${sqlSafeIdentifier(op.column)}${cascade(op.cascade)}`;

    case 'renameColumn':
      return `ALTER TABLE ${rel(op)} RENAME COLUMN ${sqlSafeIdentifier(op.column)} TO ${sqlSafeIdentifier(op.newName)}`;

    case 'alterColumnType': {
      const using =
        op.usingExpression === undefined
          ? ''
          : ` USING ${sqlSafeExpression(op.usingExpression)}`;
      return `ALTER TABLE ${rel(op)} ALTER COLUMN ${sqlSafeIdentifier(op.column)} TYPE ${sqlSafeTypeName(op.newType)}${using}`;
    }

    case 'setColumnDefault':
      return `ALTER TABLE ${rel(op)} ALTER COLUMN ${sqlSafeIdentifier(op.column)} SET DEFAULT ${sqlSafeExpression(op.expression)}`;

    case 'dropColumnDefault':
      return `ALTER TABLE ${rel(op)} ALTER COLUMN ${sqlSafeIdentifier(op.column)} DROP DEFAULT`;

    case 'setNotNull':
      return `ALTER TABLE ${rel(op)} ALTER COLUMN ${sqlSafeIdentifier(op.column)} SET NOT NULL`;

    case 'dropNotNull':
      return `ALTER TABLE ${rel(op)} ALTER COLUMN ${sqlSafeIdentifier(op.column)} DROP NOT NULL`;

    case 'setColumnComment':
      return `COMMENT ON COLUMN ${rel(op)}.${sqlSafeIdentifier(op.column)} IS ${commentValue(op.comment)}`;

    case 'addPrimaryKey':
      return `ALTER TABLE ${rel(op)} ADD ${constraintName(op.name)}PRIMARY KEY (${columnList(op.column)})`;

    case 'dropPrimaryKey':
      return `ALTER TABLE ${rel(op)} DROP CONSTRAINT ${sqlSafeIdentifier(op.name)}${cascade(op.cascade)}`;

    case 'addUnique': {
      if (op.usingIndex !== undefined) {
        return `ALTER TABLE ${rel(op)} ADD ${constraintName(op.name)}UNIQUE USING INDEX ${sqlSafeIdentifier(op.usingIndex)}`;
      }
      return `ALTER TABLE ${rel(op)} ADD ${constraintName(op.name)}UNIQUE (${columnList(op.column)})`;
    }

    case 'addCheck': {
      const valid = op.notValid === true ? ' NOT VALID' : '';
      return `ALTER TABLE ${rel(op)} ADD ${constraintName(op.name)}CHECK (${sqlSafeExpression(op.expression)})${valid}`;
    }

    case 'dropConstraint':
      return `ALTER TABLE ${rel(op)} DROP CONSTRAINT ${ifExists(op.ifExists)}${sqlSafeIdentifier(op.name)}${cascade(op.cascade)}`;

    case 'addForeignKey':
      return compileAddForeignKey(op);

    case 'dropForeignKey':
      // A foreign key IS a constraint; the distinct operation exists so a UI
      // can offer "remove relationship" without knowing that.
      return `ALTER TABLE ${rel(op)} DROP CONSTRAINT ${sqlSafeIdentifier(op.name)}${cascade(op.cascade)}`;

    case 'createIndex':
      return compileCreateIndex(op);

    case 'dropIndex': {
      const conc = op.isConcurrent === true ? 'CONCURRENTLY ' : '';
      return `DROP INDEX ${conc}${ifExists(op.ifExists)}${qualifiedIdentifier(op.schema, op.name)}${cascade(op.cascade)}`;
    }

    case 'createEnum': {
      if (op.label.length === 0) {
        throw new Error('@onegrid/studio: createEnum needs at least one label.');
      }
      const label = op.label.map(sqlLiteral).join(', ');
      return `CREATE TYPE ${qualifiedIdentifier(op.schema, op.name)} AS ENUM (${label})`;
    }

    case 'dropEnum':
      return `DROP TYPE ${ifExists(op.ifExists)}${qualifiedIdentifier(op.schema, op.name)}${cascade(op.cascade)}`;

    case 'addEnumValue': {
      if (op.before !== undefined && op.after !== undefined) {
        throw new Error(
          '@onegrid/studio: addEnumValue takes `before` or `after`, not both.',
        );
      }
      const exists = op.ifNotExists === true ? 'IF NOT EXISTS ' : '';
      const position =
        op.before !== undefined
          ? ` BEFORE ${sqlLiteral(op.before)}`
          : op.after !== undefined
            ? ` AFTER ${sqlLiteral(op.after)}`
            : '';
      return `ALTER TYPE ${qualifiedIdentifier(op.schema, op.name)} ADD VALUE ${exists}${sqlLiteral(op.label)}${position}`;
    }

    case 'enableRls': {
      const clause = op.force === true ? 'FORCE ROW LEVEL SECURITY' : 'ENABLE ROW LEVEL SECURITY';
      return `ALTER TABLE ${rel(op)} ${clause}`;
    }

    case 'disableRls':
      return `ALTER TABLE ${rel(op)} DISABLE ROW LEVEL SECURITY`;

    case 'createPolicy':
      return compileCreatePolicy(op);

    case 'dropPolicy':
      return `DROP POLICY ${ifExists(op.ifExists)}${sqlSafeIdentifier(op.name)} ON ${rel(op)}`;
  }
}

// -----------------------------------------------------------------------------
// The operations complex enough to deserve their own function
// -----------------------------------------------------------------------------

function compileCreateTable(op: CreateTableOperation): string {
  if (op.column.length === 0) {
    throw new Error(
      `@onegrid/studio: createTable ${op.schema}.${op.table} needs at least one column.`,
    );
  }
  const inlinePrimaryKey = op.column.filter((c) => c.isPrimaryKey === true);
  if (inlinePrimaryKey.length > 0 && op.primaryKeyColumn !== undefined) {
    throw new Error(
      '@onegrid/studio: createTable takes an inline primary key OR primaryKeyColumn, not both.',
    );
  }
  const piece = op.column.map((c) => compileColumnSpec(c));
  if (op.primaryKeyColumn !== undefined && op.primaryKeyColumn.length > 0) {
    // A compound key can only be expressed as a table constraint, so it goes
    // last in the column list rather than on any one column.
    piece.push(`PRIMARY KEY (${columnList(op.primaryKeyColumn)})`);
  }
  const unlogged = op.isUnlogged === true ? 'UNLOGGED ' : '';
  const exists = op.ifNotExists === true ? 'IF NOT EXISTS ' : '';
  return `CREATE ${unlogged}TABLE ${exists}${rel(op)} (${piece.join(', ')})`;
}

function compileColumnSpec(spec: ColumnSpec): string {
  const part: string[] = [sqlSafeIdentifier(spec.name), sqlSafeTypeName(spec.type)];
  if (spec.generatedExpression !== undefined) {
    part.push(`GENERATED ALWAYS AS (${sqlSafeExpression(spec.generatedExpression)}) STORED`);
  }
  if (spec.identity !== undefined) {
    part.push(`GENERATED ${spec.identity === 'always' ? 'ALWAYS' : 'BY DEFAULT'} AS IDENTITY`);
  }
  if (spec.defaultExpression !== undefined) {
    part.push(`DEFAULT ${sqlSafeExpression(spec.defaultExpression)}`);
  }
  // NOT NULL is emitted only when explicitly requested. `isNullable: undefined`
  // means "leave it to Postgres", which defaults to nullable — the same
  // default a New Column form shows.
  if (spec.isNullable === false) part.push('NOT NULL');
  if (spec.isPrimaryKey === true) part.push('PRIMARY KEY');
  if (spec.isUnique === true) part.push('UNIQUE');
  if (spec.reference !== undefined) {
    const r = spec.reference;
    part.push(
      `REFERENCES ${qualifiedIdentifier(r.schema, r.table)} (${sqlSafeIdentifier(r.column)})`,
    );
    if (r.onDelete !== undefined) part.push(`ON DELETE ${referentialAction(r.onDelete)}`);
    if (r.onUpdate !== undefined) part.push(`ON UPDATE ${referentialAction(r.onUpdate)}`);
  }
  return part.join(' ');
}

function compileAddForeignKey(op: AddForeignKeyOperation): string {
  if (op.column.length === 0) {
    throw new Error('@onegrid/studio: addForeignKey needs at least one column.');
  }
  if (op.column.length !== op.referencedColumn.length) {
    // A composite FK's column lists are positionally paired. A length
    // mismatch is the bug that produces a cartesian join later, so it is
    // caught here rather than at the server.
    throw new Error(
      `@onegrid/studio: addForeignKey column count (${String(op.column.length)}) must match referencedColumn count (${String(op.referencedColumn.length)}).`,
    );
  }
  const name = constraintName(op.name);
  const target = qualifiedIdentifier(op.referencedSchema ?? op.schema, op.referencedTable);
  const onDelete =
    op.onDelete === undefined ? '' : ` ON DELETE ${referentialAction(op.onDelete)}`;
  const onUpdate =
    op.onUpdate === undefined ? '' : ` ON UPDATE ${referentialAction(op.onUpdate)}`;
  const valid = op.notValid === true ? ' NOT VALID' : '';
  return (
    `ALTER TABLE ${rel(op)} ADD ${name}FOREIGN KEY (${columnList(op.column)}) ` +
    `REFERENCES ${target} (${columnList(op.referencedColumn)})${onDelete}${onUpdate}${valid}`
  );
}

function compileCreateIndex(op: CreateIndexOperation): string {
  const key: string[] = [];
  const column = op.column ?? [];
  column.forEach((c, i) => {
    const direction = op.ordering?.[i];
    const nulls = op.nullOrdering?.[i];
    key.push(
      sqlSafeIdentifier(c) +
        (direction === undefined ? '' : ` ${direction.toUpperCase()}`) +
        (nulls === undefined ? '' : ` NULLS ${nulls.toUpperCase()}`),
    );
  });
  for (const e of op.expression ?? []) {
    // Postgres requires an expression index key to be parenthesised unless
    // it is already a bare function call. Always parenthesising is legal for
    // both and removes the special case.
    key.push(`(${sqlSafeExpression(e)})`);
  }
  if (key.length === 0) {
    throw new Error('@onegrid/studio: createIndex needs a column or an expression.');
  }
  const unique = op.isUnique === true ? 'UNIQUE ' : '';
  const conc = op.isConcurrent === true ? 'CONCURRENTLY ' : '';
  // CREATE INDEX CONCURRENTLY IF NOT EXISTS is legal; the order is fixed.
  const exists = op.ifNotExists === true ? 'IF NOT EXISTS ' : '';
  const name =
    op.name === undefined
      ? ''
      : `${sqlSafeIdentifier(op.name)} `;
  if (op.name === undefined && op.ifNotExists === true) {
    throw new Error(
      '@onegrid/studio: createIndex with ifNotExists needs an explicit name (Postgres cannot check an auto-generated one).',
    );
  }
  const method = op.method === undefined ? '' : ` USING ${op.method}`;
  const where =
    op.predicate === undefined ? '' : ` WHERE ${sqlSafeExpression(op.predicate)}`;
  return `CREATE ${unique}INDEX ${conc}${exists}${name}ON ${rel(op)}${method} (${key.join(', ')})${where}`;
}

function compileCreatePolicy(op: CreatePolicyOperation): string {
  const command = op.command === undefined ? '' : ` FOR ${op.command.toUpperCase()}`;
  // PERMISSIVE is the Postgres default; emit AS RESTRICTIVE only when asked,
  // so a diff of two policies does not churn on an implicit clause.
  const permissive = op.isPermissive === false ? ' AS RESTRICTIVE' : '';
  const role =
    op.role === undefined || op.role.length === 0
      ? ''
      : ` TO ${op.role.map(policyRole).join(', ')}`;
  const using =
    op.usingExpression === undefined
      ? ''
      : ` USING (${sqlSafeExpression(op.usingExpression)})`;
  const withCheck =
    op.withCheckExpression === undefined
      ? ''
      : ` WITH CHECK (${sqlSafeExpression(op.withCheckExpression)})`;
  return `CREATE POLICY ${sqlSafeIdentifier(op.name)} ON ${rel(op)}${permissive}${command}${role}${using}${withCheck}`;
}

// -----------------------------------------------------------------------------
// Fragment helpers
// -----------------------------------------------------------------------------

function rel(op: { readonly schema: string; readonly table: string }): string {
  return qualifiedIdentifier(op.schema, op.table);
}

function columnList(column: readonly string[]): string {
  return column.map(sqlSafeIdentifier).join(', ');
}

function constraintName(name: string | undefined): string {
  return name === undefined ? '' : `CONSTRAINT ${sqlSafeIdentifier(name)} `;
}

function ifExists(flag: boolean | undefined): string {
  return flag === true ? 'IF EXISTS ' : '';
}

function cascade(flag: boolean | undefined): string {
  return flag === true ? ' CASCADE' : '';
}

function commentValue(comment: string | null): string {
  return comment === null ? 'NULL' : sqlLiteral(comment);
}

const REFERENTIAL_ACTION_SQL: Record<ForeignKeyAction, string> = {
  cascade: 'CASCADE',
  'set null': 'SET NULL',
  'set default': 'SET DEFAULT',
  restrict: 'RESTRICT',
  'no action': 'NO ACTION',
};

function referentialAction(action: ForeignKeyAction): string {
  const sql = REFERENTIAL_ACTION_SQL[action];
  if (sql === undefined) {
    throw new Error(`@onegrid/studio: unknown referential action "${String(action)}".`);
  }
  return sql;
}

// `PUBLIC` and `CURRENT_USER` are keywords in the TO clause, not role names,
// and quoting them turns them into a role that almost certainly does not
// exist. Everything else is a real role and gets quoted.
const ROLE_KEYWORD = new Set(['public', 'current_user', 'session_user', 'current_role']);

function policyRole(role: string): string {
  return ROLE_KEYWORD.has(role.toLowerCase()) ? role.toUpperCase() : sqlSafeIdentifier(role);
}
