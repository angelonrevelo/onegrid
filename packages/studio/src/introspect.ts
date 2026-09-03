// =============================================================================
// Database introspection.
//
// Builds a `DatabaseSchema` from real `pg_catalog` queries. Type mapping is
// delegated to `@onegrid/introspect`'s `columnTypeFromSql` rather than
// reimplemented — that function already handles the whole Postgres /
// MySQL / SQLite type vocabulary, and a second copy would drift.
//
// Every query is exported as a named constant on `INTROSPECTION_QUERY` so a
// caller can run them itself (against a pooler, a replica, a cache) and hand
// the rows to `assembleSchema`. It also makes the queries testable without a
// server, which is how the foreign-key regression below is covered.
//
// ---------------------------------------------------------------------------
// WHY FOREIGN KEYS COME FROM pg_constraint AND NOT information_schema
// ---------------------------------------------------------------------------
// The obvious way to read foreign keys is the information_schema triple:
//
//     table_constraints
//       JOIN key_column_usage USING (constraint_name)
//       JOIN constraint_column_usage USING (constraint_name)
//
// That join is WRONG for any composite foreign key, and it is wrong in a way
// that looks fine on a toy schema. `key_column_usage` has one row per
// referencing column and `constraint_column_usage` has one row per
// referenced column; joining them on constraint name alone pairs EVERY
// referencing column with EVERY referenced column. A 2-column FK yields 4
// rows, a 3-column FK yields 9, and each bogus row claims a column pairing
// that does not exist. Nothing in the result set marks which pairings are
// real, because the ordinal that would distinguish them (`position_in_unique_
// constraint`) is not part of the join key most examples use.
//
// Measured on a real database: the information_schema form reported 12,221
// foreign keys across 113 tables. The pg_constraint form below reports 77.
// The other 12,144 were cartesian noise — and a relationship graph built on
// them produces junk joins, junk "referenced by" badges, and an FK picker
// pointed at the wrong column.
//
// The fix is to read `pg_constraint.conkey` and `confkey` — two int2vector
// columns whose elements are positionally paired by definition — and unnest
// them TOGETHER `WITH ORDINALITY`, so the pairing is preserved by
// construction instead of being reconstructed by a join that cannot
// reconstruct it. The ordinality also gives the key order, which a composite
// FK needs and which `array_agg` without an ORDER BY would scramble.
// =============================================================================

import { columnTypeFromSql } from '@onegrid/introspect';
import type { ColumnType } from '@onegrid/protocol';
import type {
  CheckConstraintDescriptor,
  ColumnDescriptor,
  ColumnIdentityKind,
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
  TriggerDescriptor,
  TriggerEvent,
  TriggerTiming,
  UniqueConstraintDescriptor,
  ViewDescriptor,
} from './model';

// Schemas that belong to the server, not to the user. Every query filters
// them out; a table editor that lists `pg_catalog` is a table editor nobody
// scrolls past.
const SYSTEM_SCHEMA_PREDICATE = `n.nspname NOT IN ('pg_catalog','information_schema','pg_toast') AND n.nspname NOT LIKE 'pg\\_temp\\_%' AND n.nspname NOT LIKE 'pg\\_toast\\_temp\\_%'`;

/**
 * The catalog queries this package runs, exported so a caller can execute
 * them itself and feed the rows to `assembleSchema`.
 *
 * Each takes one parameter: `$1`, a `text[]` of schema names to restrict to,
 * or NULL for "every non-system schema".
 * @public
 */
export const INTROSPECTION_QUERY = {
  schema: `
    SELECT n.nspname AS schema_name
    FROM pg_catalog.pg_namespace n
    WHERE ${SYSTEM_SCHEMA_PREDICATE}
      AND ($1::text[] IS NULL OR n.nspname = ANY($1::text[]))
    ORDER BY n.nspname`,

  relation: `
    SELECT n.nspname                                   AS schema_name,
           c.relname                                   AS table_name,
           c.relkind                                   AS relkind,
           c.relrowsecurity                            AS rls_enabled,
           GREATEST(c.reltuples, 0)::float8            AS estimated_row_count,
           obj_description(c.oid, 'pg_class')          AS table_comment,
           CASE WHEN c.relkind IN ('v','m')
                THEN pg_catalog.pg_get_viewdef(c.oid, true) END AS view_definition
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r','p','v','m','f')
      AND ${SYSTEM_SCHEMA_PREDICATE}
      AND ($1::text[] IS NULL OR n.nspname = ANY($1::text[]))
    ORDER BY n.nspname, c.relname`,

  column: `
    SELECT n.nspname                                          AS schema_name,
           c.relname                                          AS table_name,
           a.attname                                          AS column_name,
           a.attnum                                           AS ordinal_position,
           pg_catalog.format_type(a.atttypid, a.atttypmod)    AS data_type,
           NOT a.attnotnull                                   AS is_nullable,
           pg_catalog.pg_get_expr(d.adbin, d.adrelid)         AS default_expression,
           a.attidentity                                      AS identity_kind,
           CASE WHEN a.attgenerated = 's'
                THEN pg_catalog.pg_get_expr(d.adbin, d.adrelid) END AS generated_expression,
           col_description(c.oid, a.attnum)                   AS column_comment,
           CASE WHEN t.typtype = 'e' THEN tn.nspname || '.' || t.typname END AS enum_type_name,
           information_schema._pg_char_max_length(a.atttypid, a.atttypmod)  AS character_maximum_length,
           information_schema._pg_numeric_precision(a.atttypid, a.atttypmod) AS numeric_precision,
           information_schema._pg_numeric_scale(a.atttypid, a.atttypmod)     AS numeric_scale
    FROM pg_catalog.pg_attribute a
    JOIN pg_catalog.pg_class c      ON c.oid = a.attrelid
    JOIN pg_catalog.pg_namespace n  ON n.oid = c.relnamespace
    JOIN pg_catalog.pg_type t       ON t.oid = a.atttypid
    JOIN pg_catalog.pg_namespace tn ON tn.oid = t.typnamespace
    LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE a.attnum > 0
      AND NOT a.attisdropped
      AND c.relkind IN ('r','p','v','m','f')
      AND ${SYSTEM_SCHEMA_PREDICATE}
      AND ($1::text[] IS NULL OR n.nspname = ANY($1::text[]))
    ORDER BY n.nspname, c.relname, a.attnum`,

  // Primary keys and unique constraints. conkey is unnested WITH ORDINALITY
  // for the same reason foreign keys are: a compound key's column order is
  // part of its meaning, and array_agg without an explicit ORDER BY does not
  // promise to preserve it.
  keyConstraint: `
    SELECT n.nspname       AS schema_name,
           c.relname       AS table_name,
           con.conname     AS constraint_name,
           con.contype     AS constraint_type,
           con.condeferrable AS is_deferrable,
           array_agg(a.attname ORDER BY k.ordinality) AS column_name
    FROM pg_catalog.pg_constraint con
    JOIN pg_catalog.pg_class c     ON c.oid = con.conrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS k(attnum, ordinality)
    JOIN pg_catalog.pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
    WHERE con.contype IN ('p','u')
      AND ${SYSTEM_SCHEMA_PREDICATE}
      AND ($1::text[] IS NULL OR n.nspname = ANY($1::text[]))
    GROUP BY n.nspname, c.relname, con.conname, con.contype, con.condeferrable
    ORDER BY n.nspname, c.relname, con.conname`,

  checkConstraint: `
    SELECT n.nspname   AS schema_name,
           c.relname   AS table_name,
           con.conname AS constraint_name,
           pg_catalog.pg_get_constraintdef(con.oid, true) AS definition
    FROM pg_catalog.pg_constraint con
    JOIN pg_catalog.pg_class c     ON c.oid = con.conrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE con.contype = 'c'
      AND ${SYSTEM_SCHEMA_PREDICATE}
      AND ($1::text[] IS NULL OR n.nspname = ANY($1::text[]))
    ORDER BY n.nspname, c.relname, con.conname`,

  // See the banner. unnest(conkey, confkey) WITH ORDINALITY is the whole
  // point: the two arrays are consumed in lockstep so referencing column N
  // pairs with referenced column N and with nothing else. The
  // information_schema equivalent cannot express this and produces a
  // cartesian product on every composite key.
  foreignKey: `
    SELECT n.nspname        AS schema_name,
           c.relname        AS table_name,
           con.conname      AS constraint_name,
           rn.nspname       AS referenced_schema,
           rc.relname       AS referenced_table,
           con.confdeltype  AS on_delete,
           con.confupdtype  AS on_update,
           array_agg(la.attname ORDER BY k.ordinality) AS column_name,
           array_agg(ra.attname ORDER BY k.ordinality) AS referenced_column
    FROM pg_catalog.pg_constraint con
    JOIN pg_catalog.pg_class c      ON c.oid = con.conrelid
    JOIN pg_catalog.pg_namespace n  ON n.oid = c.relnamespace
    JOIN pg_catalog.pg_class rc     ON rc.oid = con.confrelid
    JOIN pg_catalog.pg_namespace rn ON rn.oid = rc.relnamespace
    CROSS JOIN LATERAL unnest(con.conkey, con.confkey) WITH ORDINALITY AS k(conkey, confkey, ordinality)
    JOIN pg_catalog.pg_attribute la ON la.attrelid = con.conrelid  AND la.attnum = k.conkey
    JOIN pg_catalog.pg_attribute ra ON ra.attrelid = con.confrelid AND ra.attnum = k.confkey
    WHERE con.contype = 'f'
      AND ${SYSTEM_SCHEMA_PREDICATE}
      AND ($1::text[] IS NULL OR n.nspname = ANY($1::text[]))
    GROUP BY n.nspname, c.relname, con.conname, rn.nspname, rc.relname,
             con.confdeltype, con.confupdtype
    ORDER BY n.nspname, c.relname, con.conname`,

  index: `
    SELECT n.nspname   AS schema_name,
           c.relname   AS table_name,
           ic.relname  AS index_name,
           am.amname   AS method,
           i.indisunique  AS is_unique,
           i.indisprimary AS is_primary,
           pg_catalog.pg_get_indexdef(i.indexrelid) AS definition,
           pg_catalog.pg_get_expr(i.indpred, i.indrelid, true) AS predicate,
           (SELECT array_agg(a.attname ORDER BY k.ordinality)
              FROM unnest(i.indkey::int2[]) WITH ORDINALITY AS k(attnum, ordinality)
              JOIN pg_catalog.pg_attribute a
                ON a.attrelid = i.indrelid AND a.attnum = k.attnum
             WHERE k.attnum > 0) AS column_name,
           pg_catalog.pg_get_expr(i.indexprs, i.indrelid, true) AS expression
    FROM pg_catalog.pg_index i
    JOIN pg_catalog.pg_class c      ON c.oid = i.indrelid
    JOIN pg_catalog.pg_class ic     ON ic.oid = i.indexrelid
    JOIN pg_catalog.pg_namespace n  ON n.oid = c.relnamespace
    JOIN pg_catalog.pg_am am        ON am.oid = ic.relam
    WHERE ${SYSTEM_SCHEMA_PREDICATE}
      AND ($1::text[] IS NULL OR n.nspname = ANY($1::text[]))
    ORDER BY n.nspname, c.relname, ic.relname`,

  trigger: `
    SELECT n.nspname   AS schema_name,
           c.relname   AS table_name,
           t.tgname    AS trigger_name,
           t.tgtype    AS trigger_type,
           t.tgenabled AS enabled,
           p.proname   AS function_name,
           pg_catalog.pg_get_triggerdef(t.oid, true) AS definition
    FROM pg_catalog.pg_trigger t
    JOIN pg_catalog.pg_class c     ON c.oid = t.tgrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_catalog.pg_proc p      ON p.oid = t.tgfoid
    WHERE NOT t.tgisinternal
      AND ${SYSTEM_SCHEMA_PREDICATE}
      AND ($1::text[] IS NULL OR n.nspname = ANY($1::text[]))
    ORDER BY n.nspname, c.relname, t.tgname`,

  policy: `
    SELECT n.nspname     AS schema_name,
           c.relname     AS table_name,
           pol.polname   AS policy_name,
           pol.polcmd    AS command,
           pol.polpermissive AS is_permissive,
           coalesce(
             (SELECT array_agg(pg_catalog.pg_get_userbyid(r) ORDER BY r)
                FROM unnest(pol.polroles) AS r
               WHERE r <> 0),
             ARRAY['public']::name[]
           )             AS role_name,
           pg_catalog.pg_get_expr(pol.polqual, pol.polrelid, true)      AS using_expression,
           pg_catalog.pg_get_expr(pol.polwithcheck, pol.polrelid, true) AS with_check_expression
    FROM pg_catalog.pg_policy pol
    JOIN pg_catalog.pg_class c     ON c.oid = pol.polrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE ${SYSTEM_SCHEMA_PREDICATE}
      AND ($1::text[] IS NULL OR n.nspname = ANY($1::text[]))
    ORDER BY n.nspname, c.relname, pol.polname`,

  enumType: `
    SELECT n.nspname AS schema_name,
           t.typname AS type_name,
           array_agg(e.enumlabel ORDER BY e.enumsortorder) AS label
    FROM pg_catalog.pg_type t
    JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
    JOIN pg_catalog.pg_enum e      ON e.enumtypid = t.oid
    WHERE t.typtype = 'e'
      AND ${SYSTEM_SCHEMA_PREDICATE}
      AND ($1::text[] IS NULL OR n.nspname = ANY($1::text[]))
    GROUP BY n.nspname, t.typname
    ORDER BY n.nspname, t.typname`,

  sequence: `
    SELECT n.nspname     AS schema_name,
           c.relname     AS sequence_name,
           pg_catalog.format_type(s.seqtypid, NULL) AS data_type,
           s.seqstart::text  AS start_value,
           s.seqincrement::text AS increment_by,
           s.seqmin::text    AS min_value,
           s.seqmax::text    AS max_value,
           s.seqcycle        AS is_cycled,
           oc.relname        AS owned_by_table,
           oa.attname        AS owned_by_column
    FROM pg_catalog.pg_sequence s
    JOIN pg_catalog.pg_class c     ON c.oid = s.seqrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_catalog.pg_depend dep
           ON dep.objid = c.oid AND dep.classid = 'pg_class'::regclass AND dep.deptype = 'a'
    LEFT JOIN pg_catalog.pg_class oc     ON oc.oid = dep.refobjid
    LEFT JOIN pg_catalog.pg_attribute oa ON oa.attrelid = dep.refobjid AND oa.attnum = dep.refobjsubid
    WHERE ${SYSTEM_SCHEMA_PREDICATE}
      AND ($1::text[] IS NULL OR n.nspname = ANY($1::text[]))
    ORDER BY n.nspname, c.relname`,
} as const;

/** @public */
export interface IntrospectOptions {
  /** Restrict to these schemas. Omit for every non-system schema. */
  readonly schemaName?: readonly string[];
}

/** The raw rows the introspection queries return, keyed the same way as
 *  `INTROSPECTION_QUERY`. Exposed so a caller can cache or transport them.
 * @public
 */
export type IntrospectionRowSet = {
  readonly [K in keyof typeof INTROSPECTION_QUERY]: readonly Record<
    string,
    unknown
  >[];
};

/**
 * Run every catalog query against `queryable` and assemble a
 * `DatabaseSchema`.
 *
 * The queries are issued in parallel because they are independent reads;
 * against a pooled connection that is a straight latency win, and against a
 * single connection the driver serialises them anyway.
 * @public
 */
export async function introspectDatabase(
  queryable: PostgresQueryable,
  option: IntrospectOptions = {},
): Promise<DatabaseSchema> {
  const filter = option.schemaName === undefined ? null : [...option.schemaName];
  const name = Object.keys(INTROSPECTION_QUERY) as (keyof typeof INTROSPECTION_QUERY)[];
  const result = await Promise.all(
    name.map(async (key) => {
      const row = await queryable.query(INTROSPECTION_QUERY[key], [filter]);
      return [key, row] as const;
    }),
  );
  const rowSet = Object.fromEntries(result) as unknown as IntrospectionRowSet;
  return assembleSchema(rowSet);
}

/**
 * Turn raw catalog rows into a `DatabaseSchema`. Split out from
 * `introspectDatabase` so the assembly is testable without a server, and so
 * a caller that fetched the rows some other way (a cache, a replica, a
 * snapshot in source control) can still get a schema.
 * @public
 */
export function assembleSchema(row: IntrospectionRowSet): DatabaseSchema {
  const columnByTable = groupBy(row.column, relationKeyOf);
  const keyByTable = groupBy(row.keyConstraint, relationKeyOf);
  const checkByTable = groupBy(row.checkConstraint, relationKeyOf);
  const foreignKeyByTable = groupBy(row.foreignKey, relationKeyOf);
  const indexByTable = groupBy(row.index, relationKeyOf);
  const triggerByTable = groupBy(row.trigger, relationKeyOf);
  const policyByTable = groupBy(row.policy, relationKeyOf);

  const table: TableDescriptor[] = [];
  const view: ViewDescriptor[] = [];

  for (const relation of row.relation) {
    const schema = str(relation['schema_name']);
    const name = str(relation['table_name']);
    const key = `${schema}.${name}`;
    const kind = relationKindOf(str(relation['relkind']));
    const column = (columnByTable.get(key) ?? []).map(toColumnDescriptor);

    if (kind === 'view' || kind === 'materialized view') {
      view.push({
        schema,
        name,
        isMaterialized: kind === 'materialized view',
        definition: strOrNull(relation['view_definition']) ?? '',
        column,
      });
      // A materialized view carries real indexes, so it is also emitted as a
      // table descriptor below. A plain view is not.
      if (kind === 'view') continue;
    }

    const keyRow = keyByTable.get(key) ?? [];
    let primaryKey: PrimaryKeyDescriptor | null = null;
    const uniqueConstraint: UniqueConstraintDescriptor[] = [];
    for (const k of keyRow) {
      const constraintColumn = stringArray(k['column_name']);
      if (str(k['constraint_type']) === 'p') {
        primaryKey = { name: str(k['constraint_name']), column: constraintColumn };
      } else {
        uniqueConstraint.push({
          name: str(k['constraint_name']),
          column: constraintColumn,
          isDeferrable: bool(k['is_deferrable']),
        });
      }
    }

    table.push({
      schema,
      name,
      kind,
      comment: strOrNull(relation['table_comment']),
      isRlsEnabled: bool(relation['rls_enabled']),
      estimatedRowCount: Math.max(0, Math.round(num(relation['estimated_row_count']))),
      column,
      primaryKey,
      uniqueConstraint,
      checkConstraint: (checkByTable.get(key) ?? []).map(toCheckDescriptor),
      foreignKey: (foreignKeyByTable.get(key) ?? []).map(toForeignKeyDescriptor),
      index: (indexByTable.get(key) ?? []).map(toIndexDescriptor),
      trigger: (triggerByTable.get(key) ?? []).map(toTriggerDescriptor),
      policy: (policyByTable.get(key) ?? []).map(toPolicyDescriptor),
    });
  }

  return {
    schemaName: row.schema.map((r) => str(r['schema_name'])),
    table,
    view,
    enumType: row.enumType.map(toEnumDescriptor),
    sequence: row.sequence.map(toSequenceDescriptor),
  };
}

// -----------------------------------------------------------------------------
// Row → descriptor
// -----------------------------------------------------------------------------

function toColumnDescriptor(r: Record<string, unknown>): ColumnDescriptor {
  const dataType = str(r['data_type']);
  const enumTypeName = strOrNull(r['enum_type_name']);
  return {
    name: str(r['column_name']),
    dataType,
    // An enum column reports as `schema.typename`, which no type mapper can
    // classify; treat it as text, which is what it renders and edits as.
    columnType: enumTypeName === null ? columnTypeOf(dataType) : 'utf8',
    isNullable: bool(r['is_nullable']),
    defaultExpression: strOrNull(r['default_expression']),
    identity: identityOf(strOrNull(r['identity_kind'])),
    generatedExpression: strOrNull(r['generated_expression']),
    comment: strOrNull(r['column_comment']),
    ordinalPosition: num(r['ordinal_position']),
    enumTypeName,
    characterMaximumLength: numOrNull(r['character_maximum_length']),
    numericPrecision: numOrNull(r['numeric_precision']),
    numericScale: numOrNull(r['numeric_scale']),
  };
}

function toCheckDescriptor(r: Record<string, unknown>): CheckConstraintDescriptor {
  // pg_get_constraintdef returns `CHECK ((price > 0))`; the body is what a
  // UI edits and what `addCheck` takes, so strip the wrapper once here.
  const definition = str(r['definition']);
  const match = /^CHECK\s*\((.*)\)(?:\s+NOT VALID)?$/is.exec(definition.trim());
  return {
    name: str(r['constraint_name']),
    expression: (match?.[1] ?? definition).trim(),
  };
}

const DELETE_ACTION: Record<string, ForeignKeyAction> = {
  a: 'no action',
  r: 'restrict',
  c: 'cascade',
  n: 'set null',
  d: 'set default',
};

function toForeignKeyDescriptor(r: Record<string, unknown>): ForeignKeyDescriptor {
  const column = stringArray(r['column_name']);
  const referencedColumn = stringArray(r['referenced_column']);
  if (column.length !== referencedColumn.length) {
    // Only reachable if the query is replaced by an information_schema join.
    // Loud, because a length mismatch here IS the cartesian-product bug.
    throw new Error(
      `@onegrid/studio: foreign key "${str(r['constraint_name'])}" has ${String(column.length)} referencing columns but ${String(referencedColumn.length)} referenced columns — the row source is producing a cartesian product.`,
    );
  }
  return {
    name: str(r['constraint_name']),
    column,
    referencedSchema: str(r['referenced_schema']),
    referencedTable: str(r['referenced_table']),
    referencedColumn,
    onDelete: DELETE_ACTION[str(r['on_delete'])] ?? 'no action',
    onUpdate: DELETE_ACTION[str(r['on_update'])] ?? 'no action',
  };
}

const INDEX_METHOD = new Set<IndexMethod>(['btree', 'hash', 'gin', 'gist', 'spgist', 'brin']);

function toIndexDescriptor(r: Record<string, unknown>): IndexDescriptor {
  const method = str(r['method']) as IndexMethod;
  const expression = strOrNull(r['expression']);
  return {
    name: str(r['index_name']),
    method: INDEX_METHOD.has(method) ? method : 'btree',
    isUnique: bool(r['is_unique']),
    isPrimary: bool(r['is_primary']),
    column: stringArray(r['column_name']),
    // pg_get_expr renders multiple index expressions comma-separated at the
    // top level; splitting on a bare comma is only correct outside parens,
    // which `splitTopLevel` handles.
    expression: expression === null ? [] : splitTopLevel(expression),
    predicate: strOrNull(r['predicate']),
    definition: str(r['definition']),
  };
}

// pg_trigger.tgtype is a bitmask: 1 = ROW, 2 = BEFORE, 4 = INSERT,
// 8 = DELETE, 16 = UPDATE, 32 = TRUNCATE, 64 = INSTEAD OF.
const TRIGGER_ROW = 1;
const TRIGGER_BEFORE = 2;
const TRIGGER_INSERT = 4;
const TRIGGER_DELETE = 8;
const TRIGGER_UPDATE = 16;
const TRIGGER_TRUNCATE = 32;
const TRIGGER_INSTEAD = 64;

function toTriggerDescriptor(r: Record<string, unknown>): TriggerDescriptor {
  const type = num(r['trigger_type']);
  const event: TriggerEvent[] = [];
  if ((type & TRIGGER_INSERT) !== 0) event.push('insert');
  if ((type & TRIGGER_UPDATE) !== 0) event.push('update');
  if ((type & TRIGGER_DELETE) !== 0) event.push('delete');
  if ((type & TRIGGER_TRUNCATE) !== 0) event.push('truncate');
  const timing: TriggerTiming =
    (type & TRIGGER_INSTEAD) !== 0
      ? 'instead of'
      : (type & TRIGGER_BEFORE) !== 0
        ? 'before'
        : 'after';
  return {
    name: str(r['trigger_name']),
    timing,
    event,
    orientation: (type & TRIGGER_ROW) !== 0 ? 'row' : 'statement',
    functionName: str(r['function_name']),
    // tgenabled: 'O' origin (the normal enabled state), 'D' disabled,
    // 'R' replica, 'A' always.
    isEnabled: str(r['enabled']) !== 'D',
    definition: str(r['definition']),
  };
}

const POLICY_COMMAND: Record<string, PolicyCommand> = {
  '*': 'all',
  r: 'select',
  a: 'insert',
  w: 'update',
  d: 'delete',
};

function toPolicyDescriptor(r: Record<string, unknown>): RlsPolicyDescriptor {
  return {
    name: str(r['policy_name']),
    command: POLICY_COMMAND[str(r['command'])] ?? 'all',
    isPermissive: bool(r['is_permissive']),
    role: stringArray(r['role_name']),
    usingExpression: strOrNull(r['using_expression']),
    withCheckExpression: strOrNull(r['with_check_expression']),
  };
}

function toEnumDescriptor(r: Record<string, unknown>): EnumTypeDescriptor {
  return {
    schema: str(r['schema_name']),
    name: str(r['type_name']),
    label: stringArray(r['label']),
  };
}

function toSequenceDescriptor(r: Record<string, unknown>): SequenceDescriptor {
  return {
    schema: str(r['schema_name']),
    name: str(r['sequence_name']),
    dataType: str(r['data_type']),
    startValue: str(r['start_value']),
    incrementBy: str(r['increment_by']),
    minValue: strOrNull(r['min_value']),
    maxValue: strOrNull(r['max_value']),
    isCycled: bool(r['is_cycled']),
    ownedByTable: strOrNull(r['owned_by_table']),
    ownedByColumn: strOrNull(r['owned_by_column']),
  };
}

// -----------------------------------------------------------------------------
// Coercion helpers. Drivers disagree about how they hand back bool, numeric
// and array columns (node-postgres parses arrays, some poolers return the
// literal `{a,b}` text), so every read goes through one of these.
// -----------------------------------------------------------------------------

function relationKeyOf(r: Record<string, unknown>): string {
  return `${str(r['schema_name'])}.${str(r['table_name'])}`;
}

function relationKindOf(relkind: string): RelationKind {
  switch (relkind) {
    case 'v':
      return 'view';
    case 'm':
      return 'materialized view';
    case 'f':
      return 'foreign table';
    case 'p':
      return 'partitioned table';
    default:
      return 'table';
  }
}

function identityOf(attidentity: string | null): ColumnIdentityKind {
  if (attidentity === 'a') return 'always';
  if (attidentity === 'd') return 'by default';
  return 'none';
}

function columnTypeOf(dataType: string): ColumnType {
  return columnTypeFromSql(dataType);
}

function groupBy(
  row: readonly Record<string, unknown>[],
  key: (r: Record<string, unknown>) => string,
): Map<string, Record<string, unknown>[]> {
  const out = new Map<string, Record<string, unknown>[]>();
  for (const r of row) {
    const k = key(r);
    const list = out.get(k);
    if (list === undefined) out.set(k, [r]);
    else list.push(r);
  }
  return out;
}

function str(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
}

function strOrNull(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function numOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function bool(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (value === null || value === undefined) return false;
  const s = String(value).toLowerCase();
  return s === 't' || s === 'true' || s === 'yes' || s === '1';
}

/** Read a Postgres array column whether the driver parsed it or handed back
 *  the `{a,b}` literal. Exported because an adopter assembling rows by hand
 *  hits the same problem.
 * @public
 */
export function stringArray(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) {
    return value.filter((v) => v !== null && v !== undefined).map((v) => String(v));
  }
  const text = String(value);
  if (!text.startsWith('{') || !text.endsWith('}')) return [text];
  const body = text.slice(1, -1);
  if (body.length === 0) return [];
  const out: string[] = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quoted) {
      if (ch === '\\') {
        i++;
        current += body[i] ?? '';
      } else if (ch === '"') quoted = false;
      else current += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ',') {
      out.push(current);
      current = '';
    } else current += ch;
  }
  out.push(current);
  return out;
}

/** Split on commas that are not inside parentheses, brackets or quotes.
 *  Used for index expression lists. */
function splitTopLevel(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quoted: string | null = null;
  let current = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] ?? '';
    if (quoted !== null) {
      current += ch;
      if (ch === quoted) quoted = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quoted = ch;
      current += ch;
      continue;
    }
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    if (ch === ',' && depth === 0) {
      out.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim().length > 0) out.push(current.trim());
  return out;
}
