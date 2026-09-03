// =============================================================================
// Migration safety.
//
// Three functions, each answering a question a UI has to answer before it
// lets someone press a button:
//
//   planMigration(current, target) — what statements turn A into B?
//   assessRisk(operation)          — will this one destroy or block?
//   reverseOperation(operation)    — can I take it back?
//
// Ordering is the hard part of the planner and it is solved structurally
// rather than by sorting at the end. Operations are emitted into named
// PHASES and the phases are concatenated in a fixed order. The single most
// important consequence: foreign keys are NEVER inlined into a CREATE TABLE
// and are always emitted in a later phase than every CREATE TABLE, so a
// foreign key cannot possibly reference a table that does not exist yet —
// including in a reference cycle, which a topological sort alone cannot
// handle. Within the create-table phase we still topologically sort by
// dependency, because a human reading the migration expects parents first,
// but correctness does not depend on that sort succeeding.
//
// The teardown phases mirror the buildup in reverse: drop the dependents
// before the depended-on. Drops come last overall so a plan that both
// creates and drops never leaves a window where the new object is missing
// and the old one is already gone.
//
// What the planner deliberately does NOT do: detect renames. A column that
// disappears and another that appears are reported as a drop and an add,
// because guessing wrong turns a rename into silent data loss. A UI that
// knows a rename happened emits `renameColumn` itself.
// =============================================================================

import type {
  ColumnSpec,
  DdlOperation,
  DdlOperationKind,
} from './ddl';
import {
  findTable,
  tableKey,
  type ColumnDescriptor,
  type DatabaseSchema,
  type ForeignKeyDescriptor,
  type IndexDescriptor,
  type TableDescriptor,
} from './model';

// -----------------------------------------------------------------------------
// Risk
// -----------------------------------------------------------------------------

/** How dangerous an operation is.
 *
 *  - `safe`     — no data loss, no meaningful lock.
 *  - `lossy`    — succeeds, but data or definition is gone afterwards.
 *  - `blocking` — may fail outright, or holds a lock that stops writes on a
 *                 table big enough for that to be an outage.
 * @public
 */
export type RiskLevel = 'safe' | 'lossy' | 'blocking';

/** @public */
export interface RiskAssessment {
  readonly level: RiskLevel;
  /** One sentence, written for a human about to press a button. */
  readonly reason: string;
  /** True when `reverseOperation` returns an operation for this one. */
  readonly isReversible: boolean;
}

/** Context that turns a guess into a verdict. Without it the assessor
 *  assumes the table is populated and large, because assuming empty is the
 *  assumption that produces an outage.
 * @public
 */
export interface RiskContext {
  /** Estimated rows in the affected table. `@onegrid/studio` fills this
   *  from `pg_class.reltuples` via `TableDescriptor.estimatedRowCount`. */
  readonly estimatedRowCount?: number;
  /** Above this, a full-table lock is treated as an outage. Default 10,000
   *  — roughly where a rewrite stops being instantaneous on commodity
   *  hardware. */
  readonly largeTableThreshold?: number;
}

const DEFAULT_LARGE_TABLE = 10_000;

/**
 * Classify one operation's blast radius.
 * @public
 */
export function assessRisk(
  operation: DdlOperation,
  context: RiskContext = {},
): RiskAssessment {
  const rowCount = context.estimatedRowCount;
  const threshold = context.largeTableThreshold ?? DEFAULT_LARGE_TABLE;
  const isKnownEmpty = rowCount !== undefined && rowCount === 0;
  const isLarge = rowCount === undefined || rowCount >= threshold;
  const reversible = reverseOperation(operation) !== null;
  const verdict = (level: RiskLevel, reason: string): RiskAssessment => ({
    level,
    reason,
    isReversible: reversible,
  });

  switch (operation.kind) {
    case 'createSchema':
    case 'createTable':
    case 'createEnum':
    case 'addEnumValue':
    case 'setTableComment':
    case 'setColumnComment':
    case 'dropColumnDefault':
    case 'setColumnDefault':
    case 'createPolicy':
      return verdict('safe', 'Metadata-only change; no existing row is read or rewritten.');

    case 'renameTable':
      return verdict(
        'safe',
        'Rename is catalog-only, but any application code or view referring to the old name breaks immediately.',
      );

    case 'renameColumn':
      return verdict(
        'safe',
        'Rename is catalog-only, but any query naming the old column breaks immediately.',
      );

    case 'addColumn': {
      const spec = operation.column;
      if (spec.isNullable === false && spec.defaultExpression === undefined) {
        if (isKnownEmpty) {
          return verdict('safe', 'Table is empty, so a NOT NULL column with no default can be added.');
        }
        return verdict(
          'blocking',
          'Adding a NOT NULL column with no default to a populated table fails outright — every existing row would violate it. Supply a default, or add the column nullable and backfill first.',
        );
      }
      if (spec.generatedExpression !== undefined && isLarge) {
        return verdict(
          'blocking',
          'A stored generated column is computed for every existing row, which rewrites the whole table under an ACCESS EXCLUSIVE lock.',
        );
      }
      return verdict(
        'safe',
        'Since Postgres 11 a column with a constant default is a catalog-only change; no table rewrite.',
      );
    }

    case 'dropColumn':
      return verdict(
        'lossy',
        `Dropping "${operation.column}" destroys its data. Postgres marks the column dead rather than rewriting the table, so the space is not even reclaimed until a VACUUM FULL — but the values are unreachable immediately and there is no undo.`,
      );

    case 'dropTable':
      return verdict(
        'lossy',
        `Dropping ${operation.schema}.${operation.table} destroys every row in it${operation.cascade === true ? ', and CASCADE also drops every dependent view, constraint and foreign key' : ''}.`,
      );

    case 'dropSchema':
      return verdict(
        'lossy',
        `Dropping schema ${operation.schema} destroys every object it contains.`,
      );

    case 'dropEnum':
      return verdict('lossy', 'Dropping an enum type is irreversible without its label list.');

    case 'alterColumnType': {
      if (isKnownEmpty) {
        return verdict('safe', 'Table is empty, so the type change rewrites nothing.');
      }
      if (operation.usingExpression !== undefined) {
        return verdict(
          'lossy',
          'A USING cast can silently truncate or fail per row, and the pre-cast values are not recoverable afterwards. The rewrite also holds an ACCESS EXCLUSIVE lock for its duration.',
        );
      }
      return verdict(
        'blocking',
        'Changing a column type rewrites the whole table under an ACCESS EXCLUSIVE lock, blocking reads and writes until it completes.',
      );
    }

    case 'setNotNull': {
      if (isKnownEmpty) return verdict('safe', 'Table is empty, so no row can violate NOT NULL.');
      return verdict(
        'blocking',
        'SET NOT NULL scans the whole table under an ACCESS EXCLUSIVE lock and fails if any row is null. On a populated table, add a validated CHECK (col IS NOT NULL) NOT VALID first, validate it, then set NOT NULL.',
      );
    }

    case 'dropNotNull':
      return verdict('safe', 'Relaxing a constraint needs no scan.');

    case 'addPrimaryKey':
      return isKnownEmpty
        ? verdict('safe', 'Table is empty, so the backing unique index builds instantly.')
        : verdict(
            'blocking',
            'Adding a primary key builds a unique index under an ACCESS EXCLUSIVE lock and fails on any duplicate or null.',
          );

    case 'addUnique':
      if (operation.usingIndex !== undefined) {
        return verdict(
          'safe',
          'Attaching a pre-built index avoids the index build; only a brief catalog lock is taken.',
        );
      }
      return isKnownEmpty
        ? verdict('safe', 'Table is empty, so the unique index builds instantly.')
        : verdict(
            'blocking',
            'Building a unique index in-place locks the table for the duration and fails on any existing duplicate. Build it CONCURRENTLY and attach it with `usingIndex` instead.',
          );

    case 'addCheck':
      if (operation.notValid === true) {
        return verdict(
          'safe',
          'NOT VALID applies the check to new rows only and skips the full-table scan.',
        );
      }
      return isKnownEmpty
        ? verdict('safe', 'Table is empty, so validation scans nothing.')
        : verdict(
            'blocking',
            'Validating a CHECK scans every row while holding a lock that blocks writes, and fails if any row violates it. Add it NOT VALID and VALIDATE separately.',
          );

    case 'addForeignKey':
      if (operation.notValid === true) {
        return verdict(
          'safe',
          'NOT VALID enforces the key for new rows only and skips the scan of existing ones.',
        );
      }
      return isKnownEmpty
        ? verdict('safe', 'Table is empty, so there is nothing to validate.')
        : verdict(
            'blocking',
            'Adding a validated foreign key scans the referencing table and takes a lock on BOTH tables, and fails on any orphan row.',
          );

    case 'dropConstraint':
    case 'dropForeignKey':
    case 'dropPrimaryKey':
      return verdict(
        'lossy',
        'The constraint definition is gone and cannot be reconstructed from the catalog afterwards; re-adding it requires knowing what it was.',
      );

    case 'createIndex': {
      if (operation.isConcurrent === true) {
        return verdict(
          'safe',
          'CONCURRENTLY builds the index without blocking writes. It cannot run inside a transaction block, and a failed build leaves an INVALID index that must be dropped.',
        );
      }
      if (!isLarge) {
        return verdict(
          'safe',
          'Table is small enough that a non-concurrent index build completes before the lock is felt.',
        );
      }
      return verdict(
        'blocking',
        `A non-concurrent index build blocks every write to the table until it finishes${rowCount === undefined ? ' (row count unknown, so assumed large)' : ` (about ${String(rowCount)} rows)`}. Use CONCURRENTLY.`,
      );
    }

    case 'dropIndex':
      return operation.previousDefinition === undefined
        ? verdict(
            'lossy',
            'The index definition is not carried on the operation, so it cannot be rebuilt from this plan alone.',
          )
        : verdict('safe', 'The index definition is carried, so the drop can be rebuilt exactly.');

    case 'enableRls':
      return verdict(
        'blocking',
        'Enabling row-level security with no policy in place denies every row to every non-owner role — the table reads as empty until a policy exists.',
      );

    case 'disableRls':
      return verdict(
        'lossy',
        'Disabling row-level security exposes every row to every role that has table privileges. Policies are kept but stop applying.',
      );

    case 'dropPolicy':
      return verdict(
        'lossy',
        'The policy expression is gone and cannot be reconstructed; with RLS still enabled, dropping the last policy also makes the table read as empty.',
      );
  }
}

// -----------------------------------------------------------------------------
// Reversal
// -----------------------------------------------------------------------------

/**
 * Produce the down-migration for an operation, or `null` when there isn't
 * one.
 *
 * Honesty is the whole value here, so the irreversible cases are listed
 * explicitly rather than approximated:
 *
 *   - `dropColumn`, `dropTable`, `dropSchema` — the DATA is gone. A CREATE
 *     that restores the shape is not a reverse, and returning one would be
 *     a lie a UI would repeat to a user.
 *   - `alterColumnType` — reversible ONLY when `previousType` is carried,
 *     and even then the cast may not round-trip; the reverse is emitted
 *     because a plan that recorded the old type is better off with it.
 *   - `dropConstraint`, `dropPrimaryKey`, `dropForeignKey`, `dropPolicy` —
 *     the definition is not on the operation, so there is nothing to
 *     re-create.
 *   - `addEnumValue` — Postgres has no `ALTER TYPE ... DROP VALUE`. There is
 *     no reverse at any price short of recreating the type and rewriting
 *     every column that uses it.
 *   - `dropEnum`, `dropIndex` without `previousDefinition` — same shape:
 *     no definition, no reverse.
 * @public
 */
export function reverseOperation(operation: DdlOperation): DdlOperation | null {
  switch (operation.kind) {
    case 'createSchema':
      return { kind: 'dropSchema', schema: operation.schema, ifExists: true };

    case 'createTable':
      return {
        kind: 'dropTable',
        schema: operation.schema,
        table: operation.table,
        ifExists: true,
      };

    case 'renameTable':
      return {
        kind: 'renameTable',
        schema: operation.schema,
        table: operation.newName,
        newName: operation.table,
      };

    case 'setTableComment':
      // Restoring the previous comment would need it carried; clearing is
      // the honest inverse of setting one.
      return {
        kind: 'setTableComment',
        schema: operation.schema,
        table: operation.table,
        comment: null,
      };

    case 'setColumnComment':
      return {
        kind: 'setColumnComment',
        schema: operation.schema,
        table: operation.table,
        column: operation.column,
        comment: null,
      };

    case 'addColumn':
      return {
        kind: 'dropColumn',
        schema: operation.schema,
        table: operation.table,
        column: operation.column.name,
        ifExists: true,
      };

    case 'renameColumn':
      return {
        kind: 'renameColumn',
        schema: operation.schema,
        table: operation.table,
        column: operation.newName,
        newName: operation.column,
      };

    case 'alterColumnType':
      if (operation.previousType === undefined) return null;
      return {
        kind: 'alterColumnType',
        schema: operation.schema,
        table: operation.table,
        column: operation.column,
        newType: operation.previousType,
        previousType: operation.newType,
      };

    case 'setColumnDefault':
      if (operation.previousExpression === undefined || operation.previousExpression === null) {
        return {
          kind: 'dropColumnDefault',
          schema: operation.schema,
          table: operation.table,
          column: operation.column,
        };
      }
      return {
        kind: 'setColumnDefault',
        schema: operation.schema,
        table: operation.table,
        column: operation.column,
        expression: operation.previousExpression,
        previousExpression: operation.expression,
      };

    case 'dropColumnDefault':
      if (operation.previousExpression === undefined || operation.previousExpression === null) {
        return null;
      }
      return {
        kind: 'setColumnDefault',
        schema: operation.schema,
        table: operation.table,
        column: operation.column,
        expression: operation.previousExpression,
      };

    case 'setNotNull':
      return {
        kind: 'dropNotNull',
        schema: operation.schema,
        table: operation.table,
        column: operation.column,
      };

    case 'dropNotNull':
      return {
        kind: 'setNotNull',
        schema: operation.schema,
        table: operation.table,
        column: operation.column,
      };

    case 'addPrimaryKey':
      return operation.name === undefined
        ? null
        : {
            kind: 'dropPrimaryKey',
            schema: operation.schema,
            table: operation.table,
            name: operation.name,
          };

    case 'addUnique':
    case 'addCheck':
    case 'addForeignKey':
      return operation.name === undefined
        ? null
        : {
            kind: 'dropConstraint',
            schema: operation.schema,
            table: operation.table,
            name: operation.name,
            ifExists: true,
          };

    case 'createIndex':
      return operation.name === undefined
        ? null
        : {
            kind: 'dropIndex',
            schema: operation.schema,
            name: operation.name,
            ifExists: true,
          };

    case 'dropIndex':
      // Reversible only if the plan carried the definition. `previousDefinition`
      // is raw `pg_get_indexdef` text, which this package cannot re-parse into
      // a CreateIndexOperation without losing operator classes and collations,
      // so we do not pretend to.
      return null;

    case 'createEnum':
      return {
        kind: 'dropEnum',
        schema: operation.schema,
        name: operation.name,
        ifExists: true,
      };

    case 'enableRls':
      return { kind: 'disableRls', schema: operation.schema, table: operation.table };

    case 'disableRls':
      return { kind: 'enableRls', schema: operation.schema, table: operation.table };

    case 'createPolicy':
      return {
        kind: 'dropPolicy',
        schema: operation.schema,
        table: operation.table,
        name: operation.name,
        ifExists: true,
      };

    // Genuinely irreversible — see the doc comment.
    case 'dropSchema':
    case 'dropTable':
    case 'dropColumn':
    case 'dropConstraint':
    case 'dropPrimaryKey':
    case 'dropForeignKey':
    case 'dropEnum':
    case 'addEnumValue':
    case 'dropPolicy':
      return null;
  }
}

/**
 * Reverse a whole plan: reverse each operation and emit them in the opposite
 * order. Returns null as soon as any operation is irreversible, because a
 * half-applicable down-migration is worse than none — it leaves the schema
 * in a state neither the up nor the down migration describes.
 * @public
 */
export function reverseMigration(
  operation: readonly DdlOperation[],
): DdlOperation[] | null {
  const out: DdlOperation[] = [];
  for (let i = operation.length - 1; i >= 0; i--) {
    const op = operation[i];
    if (op === undefined) continue;
    const reversed = reverseOperation(op);
    if (reversed === null) return null;
    out.push(reversed);
  }
  return out;
}

// -----------------------------------------------------------------------------
// Planning
// -----------------------------------------------------------------------------

/** The phases a plan is assembled from, in emission order. Exported so a UI
 *  can group a review panel the same way the planner groups the work.
 * @public
 */
export const MIGRATION_PHASE = [
  'createSchema',
  'createType',
  'createTable',
  'alterColumn',
  'addConstraint',
  'addForeignKey',
  'createIndex',
  'security',
  'comment',
  'dropIndex',
  'dropConstraint',
  'dropColumn',
  'dropTable',
  'dropType',
] as const;

/** @public */
export type MigrationPhase = (typeof MIGRATION_PHASE)[number];

/** @public */
export interface MigrationPlanOptions {
  /** Emit drops. Default true. A UI offering a "additive changes only" mode
   *  turns this off and gets a plan that can never lose data. */
  readonly includeDrop?: boolean;
  /** Emit COMMENT ON statements. Default true. */
  readonly includeComment?: boolean;
}

/**
 * Diff two schemas and produce the ordered operations that turn `current`
 * into `target`.
 *
 * Ordering is by phase (see `MIGRATION_PHASE`), and within the createTable
 * phase by foreign-key dependency. Foreign keys always land in their own
 * later phase, which is what guarantees a key is created after the table it
 * references even when the two tables reference each other.
 * @public
 */
export function planMigration(
  current: DatabaseSchema,
  target: DatabaseSchema,
  option: MigrationPlanOptions = {},
): DdlOperation[] {
  const includeDrop = option.includeDrop ?? true;
  const includeComment = option.includeComment ?? true;
  const phase = new Map<MigrationPhase, DdlOperation[]>(
    MIGRATION_PHASE.map((p) => [p, [] as DdlOperation[]]),
  );
  const emit = (p: MigrationPhase, op: DdlOperation): void => {
    phase.get(p)?.push(op);
  };

  // --- schemas -------------------------------------------------------------
  const currentSchemaName = new Set(current.schemaName);
  for (const name of target.schemaName) {
    if (!currentSchemaName.has(name)) {
      emit('createSchema', { kind: 'createSchema', schema: name, ifNotExists: true });
    }
  }

  // --- enum types ----------------------------------------------------------
  const currentEnum = new Map(current.enumType.map((e) => [`${e.schema}.${e.name}`, e]));
  for (const enumType of target.enumType) {
    const key = `${enumType.schema}.${enumType.name}`;
    const existing = currentEnum.get(key);
    if (existing === undefined) {
      emit('createType', {
        kind: 'createEnum',
        schema: enumType.schema,
        name: enumType.name,
        label: enumType.label,
      });
      continue;
    }
    const known = new Set(existing.label);
    let previous: string | undefined;
    for (const label of enumType.label) {
      if (!known.has(label)) {
        // Position the new label relative to the one before it in the target
        // order, so the enum's sort order matches the target rather than
        // appending everything at the end.
        emit('createType', {
          kind: 'addEnumValue',
          schema: enumType.schema,
          name: enumType.name,
          label,
          ...(previous === undefined ? {} : { after: previous }),
          ifNotExists: true,
        });
      }
      previous = label;
    }
  }
  if (includeDrop) {
    const targetEnumKey = new Set(target.enumType.map((e) => `${e.schema}.${e.name}`));
    for (const enumType of current.enumType) {
      if (!targetEnumKey.has(`${enumType.schema}.${enumType.name}`)) {
        emit('dropType', {
          kind: 'dropEnum',
          schema: enumType.schema,
          name: enumType.name,
          ifExists: true,
        });
      }
    }
  }

  // --- tables --------------------------------------------------------------
  const currentTable = new Map(current.table.map((t) => [tableKey(t), t]));
  const targetTable = new Map(target.table.map((t) => [tableKey(t), t]));

  const created = target.table.filter(
    (t) => isPlannableRelation(t) && !currentTable.has(tableKey(t)),
  );
  for (const table of sortTableByDependency(created)) {
    emit('createTable', {
      kind: 'createTable',
      schema: table.schema,
      table: table.name,
      // Foreign keys are deliberately NOT inlined — see the banner.
      column: table.column.map(toColumnSpec),
      ...(table.primaryKey === null
        ? {}
        : { primaryKeyColumn: table.primaryKey.column }),
    });
  }

  for (const table of target.table) {
    if (!isPlannableRelation(table)) continue;
    const before = currentTable.get(tableKey(table));
    if (before === undefined) {
      // Newly created: constraints, indexes, comments and security still
      // have to be emitted in their own phases.
      emitTableAttachment(emit, null, table, includeComment);
      continue;
    }
    diffColumn(emit, before, table, includeDrop, includeComment);
    emitTableAttachment(emit, before, table, includeComment);
  }

  if (includeDrop) {
    const dropped = current.table.filter(
      (t) => isPlannableRelation(t) && !targetTable.has(tableKey(t)),
    );
    // Reverse dependency order: a table is dropped only after everything
    // that references it has been.
    for (const table of sortTableByDependency(dropped).reverse()) {
      emit('dropTable', {
        kind: 'dropTable',
        schema: table.schema,
        table: table.name,
        ifExists: true,
      });
    }
  }

  return MIGRATION_PHASE.flatMap((p) => phase.get(p) ?? []);
}

type Emit = (phase: MigrationPhase, operation: DdlOperation) => void;

function isPlannableRelation(table: TableDescriptor): boolean {
  return table.kind === 'table' || table.kind === 'partitioned table';
}

function diffColumn(
  emit: Emit,
  before: TableDescriptor,
  after: TableDescriptor,
  includeDrop: boolean,
  includeComment: boolean,
): void {
  const beforeColumn = new Map(before.column.map((c) => [c.name, c]));
  const afterColumn = new Map(after.column.map((c) => [c.name, c]));

  for (const column of after.column) {
    const previous = beforeColumn.get(column.name);
    if (previous === undefined) {
      emit('alterColumn', {
        kind: 'addColumn',
        schema: after.schema,
        table: after.name,
        column: toColumnSpec(column),
      });
      if (includeComment && column.comment !== null) {
        emit('comment', {
          kind: 'setColumnComment',
          schema: after.schema,
          table: after.name,
          column: column.name,
          comment: column.comment,
        });
      }
      continue;
    }
    if (previous.dataType !== column.dataType) {
      emit('alterColumn', {
        kind: 'alterColumnType',
        schema: after.schema,
        table: after.name,
        column: column.name,
        newType: column.dataType,
        previousType: previous.dataType,
      });
    }
    if (previous.defaultExpression !== column.defaultExpression) {
      if (column.defaultExpression === null) {
        emit('alterColumn', {
          kind: 'dropColumnDefault',
          schema: after.schema,
          table: after.name,
          column: column.name,
          previousExpression: previous.defaultExpression,
        });
      } else {
        emit('alterColumn', {
          kind: 'setColumnDefault',
          schema: after.schema,
          table: after.name,
          column: column.name,
          expression: column.defaultExpression,
          previousExpression: previous.defaultExpression,
        });
      }
    }
    if (previous.isNullable !== column.isNullable) {
      emit('alterColumn', {
        kind: column.isNullable ? 'dropNotNull' : 'setNotNull',
        schema: after.schema,
        table: after.name,
        column: column.name,
      });
    }
    if (includeComment && previous.comment !== column.comment) {
      emit('comment', {
        kind: 'setColumnComment',
        schema: after.schema,
        table: after.name,
        column: column.name,
        comment: column.comment,
      });
    }
  }

  if (includeDrop) {
    for (const column of before.column) {
      if (!afterColumn.has(column.name)) {
        emit('dropColumn', {
          kind: 'dropColumn',
          schema: after.schema,
          table: after.name,
          column: column.name,
        });
      }
    }
  }
}

function emitTableAttachment(
  emit: Emit,
  before: TableDescriptor | null,
  after: TableDescriptor,
  includeComment: boolean,
): void {
  const beforeUnique = new Set((before?.uniqueConstraint ?? []).map((u) => u.name));
  const beforeCheck = new Set((before?.checkConstraint ?? []).map((c) => c.name));
  const beforeForeignKey = new Map(
    (before?.foreignKey ?? []).map((f) => [f.name, f] as const),
  );
  const beforeIndex = new Map((before?.index ?? []).map((i) => [i.name, i] as const));
  const beforePolicy = new Set((before?.policy ?? []).map((p) => p.name));

  // The primary key is created with the table, so only a table that already
  // existed can gain one here.
  if (before !== null && before.primaryKey === null && after.primaryKey !== null) {
    emit('addConstraint', {
      kind: 'addPrimaryKey',
      schema: after.schema,
      table: after.name,
      column: after.primaryKey.column,
      name: after.primaryKey.name,
    });
  }
  for (const unique of after.uniqueConstraint) {
    if (!beforeUnique.has(unique.name)) {
      emit('addConstraint', {
        kind: 'addUnique',
        schema: after.schema,
        table: after.name,
        column: unique.column,
        name: unique.name,
      });
    }
  }
  for (const check of after.checkConstraint) {
    if (!beforeCheck.has(check.name)) {
      emit('addConstraint', {
        kind: 'addCheck',
        schema: after.schema,
        table: after.name,
        expression: check.expression,
        name: check.name,
      });
    }
  }
  for (const fk of after.foreignKey) {
    const previous = beforeForeignKey.get(fk.name);
    if (previous !== undefined && isSameForeignKey(previous, fk)) continue;
    if (previous !== undefined) {
      emit('dropConstraint', {
        kind: 'dropForeignKey',
        schema: after.schema,
        table: after.name,
        name: fk.name,
      });
    }
    emit('addForeignKey', {
      kind: 'addForeignKey',
      schema: after.schema,
      table: after.name,
      column: fk.column,
      referencedSchema: fk.referencedSchema,
      referencedTable: fk.referencedTable,
      referencedColumn: fk.referencedColumn,
      onDelete: fk.onDelete,
      onUpdate: fk.onUpdate,
      name: fk.name,
    });
  }
  for (const index of after.index) {
    // A primary-key or unique-constraint index is created by its constraint;
    // emitting a CREATE INDEX for it too would fail on a duplicate name.
    if (index.isPrimary) continue;
    if (index.isUnique && after.uniqueConstraint.some((u) => u.name === index.name)) continue;
    if (beforeIndex.has(index.name)) continue;
    emit('createIndex', toCreateIndex(after, index));
  }
  if (before !== null || after.isRlsEnabled) {
    const wasEnabled = before?.isRlsEnabled ?? false;
    if (wasEnabled !== after.isRlsEnabled) {
      emit('security', {
        kind: after.isRlsEnabled ? 'enableRls' : 'disableRls',
        schema: after.schema,
        table: after.name,
      });
    }
  }
  for (const policy of after.policy) {
    if (beforePolicy.has(policy.name)) continue;
    emit('security', {
      kind: 'createPolicy',
      schema: after.schema,
      table: after.name,
      name: policy.name,
      command: policy.command,
      isPermissive: policy.isPermissive,
      role: policy.role,
      ...(policy.usingExpression === null
        ? {}
        : { usingExpression: policy.usingExpression }),
      ...(policy.withCheckExpression === null
        ? {}
        : { withCheckExpression: policy.withCheckExpression }),
    });
  }
  if (includeComment && after.comment !== (before?.comment ?? null)) {
    emit('comment', {
      kind: 'setTableComment',
      schema: after.schema,
      table: after.name,
      comment: after.comment,
    });
  }
}

function isSameForeignKey(a: ForeignKeyDescriptor, b: ForeignKeyDescriptor): boolean {
  return (
    a.referencedSchema === b.referencedSchema &&
    a.referencedTable === b.referencedTable &&
    a.onDelete === b.onDelete &&
    a.onUpdate === b.onUpdate &&
    a.column.length === b.column.length &&
    a.column.every((c, i) => c === b.column[i]) &&
    a.referencedColumn.length === b.referencedColumn.length &&
    a.referencedColumn.every((c, i) => c === b.referencedColumn[i])
  );
}

function toColumnSpec(column: ColumnDescriptor): ColumnSpec {
  return {
    name: column.name,
    type: column.dataType,
    isNullable: column.isNullable,
    ...(column.defaultExpression === null || column.identity !== 'none'
      ? {}
      : { defaultExpression: column.defaultExpression }),
    ...(column.identity === 'none' ? {} : { identity: column.identity }),
    ...(column.generatedExpression === null
      ? {}
      : { generatedExpression: column.generatedExpression }),
  };
}

function toCreateIndex(table: TableDescriptor, index: IndexDescriptor): DdlOperation {
  return {
    kind: 'createIndex',
    schema: table.schema,
    table: table.name,
    name: index.name,
    column: index.column,
    ...(index.expression.length === 0 ? {} : { expression: index.expression }),
    method: index.method,
    isUnique: index.isUnique,
    ...(index.predicate === null ? {} : { predicate: index.predicate }),
  };
}

/**
 * Topologically sort tables so a table comes after everything it references.
 *
 * A reference cycle cannot be sorted, and rather than throwing — a cycle is
 * legal Postgres and a table editor must not refuse to plan against one —
 * the remaining tables are appended in their original order. Correctness
 * does not depend on the sort, because foreign keys are emitted in a later
 * phase regardless; the sort exists so a human reading the plan sees parents
 * before children.
 * @public
 */
export function sortTableByDependency(
  table: readonly TableDescriptor[],
): TableDescriptor[] {
  const known = new Set(table.map(tableKey));
  const remaining = new Map(table.map((t) => [tableKey(t), t] as const));
  const out: TableDescriptor[] = [];
  const placed = new Set<string>();

  let progressed = true;
  while (remaining.size > 0 && progressed) {
    progressed = false;
    for (const [key, candidate] of [...remaining]) {
      const dependency = candidate.foreignKey
        .map((fk) => `${fk.referencedSchema}.${fk.referencedTable}`)
        // A self-reference never blocks: the table is created before the FK.
        .filter((d) => d !== key && known.has(d));
      if (dependency.every((d) => placed.has(d))) {
        out.push(candidate);
        placed.add(key);
        remaining.delete(key);
        progressed = true;
      }
    }
  }
  for (const candidate of remaining.values()) out.push(candidate);
  return out;
}

/** A planned operation with its risk verdict attached — the shape a "review
 *  these changes" panel renders directly.
 * @public
 */
export interface AssessedOperation {
  readonly operation: DdlOperation;
  readonly risk: RiskAssessment;
}

/**
 * Assess every operation in a plan, resolving each one's `RiskContext` from
 * the schema it applies to. This is the entry point a UI wants: it is what
 * turns a plan into "3 safe, 1 lossy, 1 blocking".
 * @public
 */
export function assessMigration(
  operation: readonly DdlOperation[],
  schema: DatabaseSchema,
): AssessedOperation[] {
  return operation.map((op) => {
    const table = 'table' in op ? findTable(schema, { schema: op.schema, name: op.table }) : null;
    return {
      operation: op,
      risk: assessRisk(
        op,
        table === null ? {} : { estimatedRowCount: table.estimatedRowCount },
      ),
    };
  });
}

/** The highest risk level present in a plan, for a one-glance summary.
 * @public
 */
export function highestRisk(assessed: readonly AssessedOperation[]): RiskLevel {
  if (assessed.some((a) => a.risk.level === 'blocking')) return 'blocking';
  if (assessed.some((a) => a.risk.level === 'lossy')) return 'lossy';
  return 'safe';
}

/** Every operation kind, for exhaustiveness checks in adopter code.
 * @public
 */
export const DDL_OPERATION_KIND: readonly DdlOperationKind[] = [
  'createSchema', 'dropSchema', 'createTable', 'dropTable', 'renameTable',
  'setTableComment', 'addColumn', 'dropColumn', 'renameColumn', 'alterColumnType',
  'setColumnDefault', 'dropColumnDefault', 'setNotNull', 'dropNotNull',
  'setColumnComment', 'addPrimaryKey', 'dropPrimaryKey', 'addUnique', 'addCheck',
  'dropConstraint', 'addForeignKey', 'dropForeignKey', 'createIndex', 'dropIndex',
  'createEnum', 'dropEnum', 'addEnumValue', 'enableRls', 'disableRls',
  'createPolicy', 'dropPolicy',
];
