// =============================================================================
// Relationship intelligence.
//
// A table editor stops feeling like a SQL console and starts feeling like a
// product at exactly the point where it understands foreign keys. Four
// capabilities live here, and they build on each other:
//
//   resolveRelationship  — the FK graph, in BOTH directions. Postgres stores
//                          a constraint on the referencing side only, so the
//                          inbound edge ("what points at me?") has to be
//                          derived. Without it there is no "12 orders" badge
//                          on a customer row.
//   detectDisplayColumn  — which column is the human-readable one. A uuid
//                          primary key is useless in a picker; `name` is not.
//   foreignKeyLookup     — the query behind an FK value picker: search the
//                          referenced table by its display column, return
//                          value + label.
//   buildJoinQuery       — follow an FK path and embed the related rows,
//                          Supabase `select=*,author(*)` style.
//
// The cardinality rule used throughout: an outbound FK is many-to-one unless
// its columns are exactly covered by a unique constraint or the primary key,
// in which case it is one-to-one. That single check is what lets a UI decide
// between "show a picker" and "show an inline sub-form", and between
// embedding an object and embedding an array.
// =============================================================================

import { qualifiedIdentifier, sqlSafeIdentifier } from './identifier';
import {
  findTable,
  tableKey,
  type ColumnDescriptor,
  type CompiledStatement,
  type DatabaseSchema,
  type ForeignKeyDescriptor,
  type TableDescriptor,
  type TableRef,
} from './model';

/** @public */
export type RelationshipCardinality = 'one-to-one' | 'many-to-one' | 'one-to-many';

/** An FK seen from the table that declares it.
 * @public
 */
export interface OutboundRelationship {
  readonly constraintName: string;
  readonly column: readonly string[];
  readonly target: TableRef;
  readonly targetColumn: readonly string[];
  /** `one-to-one` when the local columns are uniquely constrained. */
  readonly cardinality: Extract<RelationshipCardinality, 'one-to-one' | 'many-to-one'>;
  /** Suggested field name if the relation were embedded — derived from the
   *  FK column (`author_id` becomes `author`) and falling back to the target
   *  table name. This is the key `buildJoinQuery` matches path segments
   *  against. */
  readonly fieldName: string;
  readonly isNullable: boolean;
}

/** The same FK seen from the table it points at.
 * @public
 */
export interface InboundRelationship {
  readonly constraintName: string;
  readonly source: TableRef;
  readonly sourceColumn: readonly string[];
  readonly column: readonly string[];
  readonly cardinality: Extract<RelationshipCardinality, 'one-to-one' | 'one-to-many'>;
  readonly fieldName: string;
}

/** @public */
export interface TableRelationship {
  readonly table: TableRef;
  readonly outbound: readonly OutboundRelationship[];
  readonly inbound: readonly InboundRelationship[];
}

/** The whole FK graph. `relationship` is plain data so the graph survives a
 *  `postMessage`; `get` is a convenience index over it.
 * @public
 */
export interface RelationshipGraph {
  readonly relationship: readonly TableRelationship[];
  get(ref: TableRef): TableRelationship | null;
}

/**
 * Build the two-directional FK graph for a schema.
 *
 * Every table gets an entry, including tables with no relationships at all,
 * so a UI can render "no relationships" without distinguishing "absent from
 * the graph" from "present with an empty list".
 * @public
 */
export function resolveRelationship(schema: DatabaseSchema): RelationshipGraph {
  const outbound = new Map<string, OutboundRelationship[]>();
  const inbound = new Map<string, InboundRelationship[]>();
  for (const table of schema.table) {
    outbound.set(tableKey(table), []);
    inbound.set(tableKey(table), []);
  }

  for (const table of schema.table) {
    for (const fk of table.foreignKey) {
      const target: TableRef = { schema: fk.referencedSchema, name: fk.referencedTable };
      const unique = isUniquelyConstrained(table, fk.column);
      const nullable = fk.column.every((name) => {
        const column = table.column.find((c) => c.name === name);
        return column === undefined ? true : column.isNullable;
      });
      outbound.get(tableKey(table))?.push({
        constraintName: fk.name,
        column: fk.column,
        target,
        targetColumn: fk.referencedColumn,
        cardinality: unique ? 'one-to-one' : 'many-to-one',
        fieldName: relationFieldName(fk.column, fk.referencedTable),
        isNullable: nullable,
      });
      // The inbound edge exists only in our derivation — pg_constraint has
      // one row, on the referencing side.
      const inboundList = inbound.get(tableKey(target));
      if (inboundList !== undefined) {
        inboundList.push({
          constraintName: fk.name,
          source: { schema: table.schema, name: table.name },
          sourceColumn: fk.column,
          column: fk.referencedColumn,
          cardinality: unique ? 'one-to-one' : 'one-to-many',
          fieldName: inboundFieldName(table.name, unique),
        });
      }
    }
  }

  const relationship: TableRelationship[] = schema.table.map((table) => ({
    table: { schema: table.schema, name: table.name },
    outbound: outbound.get(tableKey(table)) ?? [],
    inbound: inbound.get(tableKey(table)) ?? [],
  }));
  const index = new Map(relationship.map((r) => [tableKey(r.table), r]));
  return {
    relationship,
    get: (ref) => index.get(tableKey(ref)) ?? null,
  };
}

/**
 * True when `column` is exactly covered by the primary key or by some unique
 * constraint — the test that turns a many-to-one FK into a one-to-one.
 *
 * "Exactly" matters: a unique constraint on `(a, b)` does NOT make `a` alone
 * unique, so a set-equality check is required and a subset check would be
 * wrong.
 * @public
 */
export function isUniquelyConstrained(
  table: TableDescriptor,
  column: readonly string[],
): boolean {
  const candidate: readonly (readonly string[])[] = [
    ...(table.primaryKey === null ? [] : [table.primaryKey.column]),
    ...table.uniqueConstraint.map((u) => u.column),
    ...table.index.filter((i) => i.isUnique && i.predicate === null).map((i) => i.column),
  ];
  const want = new Set(column);
  return candidate.some(
    (c) => c.length === want.size && c.every((name) => want.has(name)),
  );
}

/**
 * True when the table is a pure junction (join) table: its primary key is
 * exactly the union of two foreign keys, and it carries no other data
 * column beyond audit-ish extras.
 *
 * A UI uses this to render `post` ↔ `tag` as a tag picker rather than as a
 * third table nobody wanted to see.
 * @public
 */
export function isJunctionTable(table: TableDescriptor): boolean {
  if (table.foreignKey.length !== 2) return false;
  const pk = table.primaryKey;
  if (pk === null) return false;
  const fkColumn = new Set(table.foreignKey.flatMap((fk) => fk.column));
  if (fkColumn.size !== pk.column.length) return false;
  return pk.column.every((c) => fkColumn.has(c));
}

// -----------------------------------------------------------------------------
// Display column heuristic
// -----------------------------------------------------------------------------

// Ranked by how well the column reads as a label for a row. The score is a
// base from this table, adjusted by type and nullability below.
const NAME_SCORE: Record<string, number> = {
  name: 100,
  title: 95,
  label: 90,
  display_name: 88,
  full_name: 86,
  username: 84,
  handle: 80,
  email: 78,
  slug: 74,
  subject: 70,
  headline: 68,
  code: 60,
  key: 55,
  description: 45,
  summary: 40,
};

// Suffix hints for columns that are named something bespoke but still read
// like a label — `product_name`, `first_name`, `company_title`.
const NAME_SUFFIX: readonly (readonly [string, number])[] = [
  ['_name', 82],
  ['_title', 78],
  ['_label', 74],
  ['_email', 70],
  ['_slug', 66],
  ['_code', 52],
];

/**
 * Pick the column that best identifies a row to a human, or null when the
 * table has none.
 *
 * The heuristic, in the order it applies:
 *   - a text-ish type is required; numbers, booleans, json, binary and
 *     timestamps are never labels;
 *   - `uuid` is excluded even though it is text-ish, because a uuid is the
 *     thing a display column exists to avoid showing;
 *   - a known label name scores highest, then a known label suffix, then any
 *     other text column at a low base score;
 *   - a NOT NULL column beats a nullable one (a picker full of blanks is
 *     useless), and an earlier ordinal position breaks remaining ties, since
 *     schema authors put the identifying column near the front;
 *   - primary-key and foreign-key columns are penalised heavily — they are
 *     identifiers, not labels — but not excluded, so a table whose only text
 *     column is a natural-key `code` still gets a label.
 * @public
 */
export function detectDisplayColumn(table: TableDescriptor): string | null {
  const primaryKey = new Set(table.primaryKey?.column ?? []);
  const foreignKeyColumn = new Set(table.foreignKey.flatMap((fk) => fk.column));

  let best: { name: string; score: number } | null = null;
  for (const column of table.column) {
    if (!isLabelType(column)) continue;
    let score = baseNameScore(column.name);
    if (score === 0) score = 20; // any other text column, as a last resort
    if (!column.isNullable) score += 8;
    if (primaryKey.has(column.name)) score -= 50;
    if (foreignKeyColumn.has(column.name)) score -= 40;
    // Earlier columns win ties without ever overtaking a better name.
    score -= Math.min(column.ordinalPosition, 20) * 0.1;
    if (best === null || score > best.score) best = { name: column.name, score };
  }
  return best === null ? null : best.name;
}

function baseNameScore(name: string): number {
  const lower = name.toLowerCase();
  const exact = NAME_SCORE[lower];
  if (exact !== undefined) return exact;
  for (const [suffix, score] of NAME_SUFFIX) {
    if (lower.endsWith(suffix)) return score;
  }
  return 0;
}

function isLabelType(column: ColumnDescriptor): boolean {
  if (column.columnType !== 'utf8') return false;
  const type = column.dataType.toLowerCase();
  if (type.includes('uuid')) return false;
  if (type.includes('[]')) return false;
  return true;
}

// -----------------------------------------------------------------------------
// Foreign-key value picker
// -----------------------------------------------------------------------------

/** @public */
export interface ForeignKeyLookupInput {
  readonly fk: ForeignKeyDescriptor;
  /** The table `fk` points at. Passed in rather than looked up so this works
   *  against a partially loaded schema. */
  readonly referencedTable: TableDescriptor;
  /** Override the detected display column. */
  readonly displayColumn?: string;
  /** Default 20 — a picker's page, not a data export. */
  readonly limit?: number;
}

/** The compiled picker query plus the aliases its rows come back under.
 * @public
 */
export interface ForeignKeyLookupQuery extends CompiledStatement {
  /** Alias of the column carrying the value to store in the FK column. */
  readonly valueAlias: string;
  /** Alias of the human-readable column. Equal to `valueAlias` when the
   *  table has no display column at all. */
  readonly labelAlias: string;
  readonly displayColumn: string | null;
}

/**
 * Compile the query behind a foreign-key value picker: search the referenced
 * table by its display column and return an id + label pair per row.
 *
 * An empty `searchText` compiles without a WHERE clause — the picker's
 * initial "here are the first 20" state. A non-empty one matches
 * case-insensitively anywhere in the display column, with `%` and `_`
 * escaped so a user typing `100%` searches for the literal string rather
 * than matching every row.
 *
 * Composite foreign keys have no single scalar value to store, so the value
 * expression is a row constructor; a UI that cannot handle that should read
 * `fk.referencedColumn.length` and fall back to a manual form.
 * @public
 */
export function foreignKeyLookup(
  input: ForeignKeyLookupInput,
  searchText: string,
): ForeignKeyLookupQuery {
  const { fk, referencedTable } = input;
  const display = input.displayColumn ?? detectDisplayColumn(referencedTable);
  const target = qualifiedIdentifier(fk.referencedSchema, fk.referencedTable);
  const keyColumn = fk.referencedColumn;
  if (keyColumn.length === 0) {
    throw new Error(
      `@onegrid/studio: foreign key "${fk.name}" references no column.`,
    );
  }
  const valueExpression =
    keyColumn.length === 1
      ? sqlSafeIdentifier(keyColumn[0] ?? '')
      : `(${keyColumn.map(sqlSafeIdentifier).join(', ')})`;

  const param: unknown[] = [];
  const projection = [`${valueExpression} AS "value"`];
  if (display !== null) projection.push(`${sqlSafeIdentifier(display)} AS "label"`);

  let where = '';
  const trimmed = searchText.trim();
  if (trimmed.length > 0 && display !== null) {
    param.push(`%${escapeLike(trimmed)}%`);
    where = ` WHERE ${sqlSafeIdentifier(display)}::text ILIKE $${String(param.length)}`;
  } else if (trimmed.length > 0) {
    // No display column — search the key itself, cast to text so a uuid or
    // integer key is still prefix-searchable.
    param.push(`%${escapeLike(trimmed)}%`);
    where = ` WHERE ${sqlSafeIdentifier(keyColumn[0] ?? '')}::text ILIKE $${String(param.length)}`;
  }

  const orderColumn = display === null ? (keyColumn[0] ?? '') : display;
  param.push(input.limit ?? 20);
  const sql =
    `SELECT ${projection.join(', ')} FROM ${target}${where} ` +
    `ORDER BY ${sqlSafeIdentifier(orderColumn)} LIMIT $${String(param.length)}`;
  return {
    sql,
    param,
    valueAlias: 'value',
    labelAlias: display === null ? 'value' : 'label',
    displayColumn: display,
  };
}

function escapeLike(input: string): string {
  return input.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

// -----------------------------------------------------------------------------
// Embedded joins
// -----------------------------------------------------------------------------

/** One embedded relation in a join query.
 * @public
 */
export interface JoinEmbed {
  readonly fieldName: string;
  readonly table: TableRef;
  readonly cardinality: RelationshipCardinality;
  /** The SQL alias the relation was given. */
  readonly alias: string;
}

/** @public */
export interface JoinQuery extends CompiledStatement {
  readonly embed: readonly JoinEmbed[];
}

/** @public */
export interface JoinQueryOptions {
  readonly limit?: number;
  /** Columns to project from the root table. Defaults to all of them. */
  readonly column?: readonly string[];
}

/**
 * Follow a foreign-key path from `from` and embed the related rows, the way
 * PostgREST's `select=*,author(*)` does.
 *
 * Each path segment names a relation on the current table, matched against
 * (in order) the derived field name (`author` for an `author_id` FK), the
 * target table name, and the constraint name. Segments resolve against
 * outbound FKs first, then inbound ones.
 *
 * The two directions compile differently, and that difference is the whole
 * point:
 *
 *   - **Outbound (many-to-one)** becomes a LEFT JOIN with the embedded
 *     table's row folded into a single jsonb column. A plain column-by-column
 *     join would collide on names — two tables both having `id` — and force
 *     the caller to invent a prefixing scheme.
 *   - **Inbound (one-to-many)** becomes a LEFT JOIN LATERAL over
 *     `jsonb_agg`. Joining a one-to-many directly would multiply the root
 *     rows, so `LIMIT 20` would stop meaning 20 root rows. The lateral
 *     aggregate keeps one row per root row, which is what a UI paginates on.
 * @public
 */
export function buildJoinQuery(
  schema: DatabaseSchema,
  from: TableRef,
  path: readonly string[],
  option: JoinQueryOptions = {},
): JoinQuery {
  const rootTable = findTable(schema, from);
  if (rootTable === null) {
    throw new Error(`@onegrid/studio: unknown table ${tableKey(from)}.`);
  }
  const graph = resolveRelationship(schema);

  const rootAlias = 't0';
  const projection: string[] = [];
  for (const column of option.column ?? rootTable.column.map((c) => c.name)) {
    projection.push(`${sqlSafeIdentifier(rootAlias)}.${sqlSafeIdentifier(column)}`);
  }
  const joinClause: string[] = [];
  const embed: JoinEmbed[] = [];

  let currentTable = rootTable;
  let currentAlias = rootAlias;
  path.forEach((segment, depth) => {
    const alias = `t${String(depth + 1)}`;
    const relationship = graph.get({ schema: currentTable.schema, name: currentTable.name });
    if (relationship === null) {
      throw new Error(
        `@onegrid/studio: ${tableKey(currentTable)} is not in the relationship graph.`,
      );
    }
    const out = relationship.outbound.find((r) => matchSegment(segment, r.fieldName, r.target.name, r.constraintName));
    if (out !== undefined) {
      const targetTable = findTable(schema, out.target);
      if (targetTable === null) {
        throw new Error(`@onegrid/studio: unknown table ${tableKey(out.target)}.`);
      }
      const on = out.column
        .map(
          (c, i) =>
            `${sqlSafeIdentifier(currentAlias)}.${sqlSafeIdentifier(c)} = ${sqlSafeIdentifier(alias)}.${sqlSafeIdentifier(out.targetColumn[i] ?? '')}`,
        )
        .join(' AND ');
      joinClause.push(
        `LEFT JOIN ${qualifiedIdentifier(out.target.schema, out.target.name)} AS ${sqlSafeIdentifier(alias)} ON ${on}`,
      );
      projection.push(
        `to_jsonb(${sqlSafeIdentifier(alias)}.*) AS ${sqlSafeIdentifier(out.fieldName)}`,
      );
      embed.push({
        fieldName: out.fieldName,
        table: out.target,
        cardinality: out.cardinality,
        alias,
      });
      currentTable = targetTable;
      currentAlias = alias;
      return;
    }

    const inb = relationship.inbound.find((r) => matchSegment(segment, r.fieldName, r.source.name, r.constraintName));
    if (inb === undefined) {
      throw new Error(
        `@onegrid/studio: no relation "${segment}" on ${tableKey(currentTable)}.`,
      );
    }
    const sourceTable = findTable(schema, inb.source);
    if (sourceTable === null) {
      throw new Error(`@onegrid/studio: unknown table ${tableKey(inb.source)}.`);
    }
    const on = inb.sourceColumn
      .map(
        (c, i) =>
          `${sqlSafeIdentifier(alias)}.${sqlSafeIdentifier(c)} = ${sqlSafeIdentifier(currentAlias)}.${sqlSafeIdentifier(inb.column[i] ?? '')}`,
      )
      .join(' AND ');
    joinClause.push(
      `LEFT JOIN LATERAL (SELECT coalesce(jsonb_agg(to_jsonb(${sqlSafeIdentifier(alias)}.*)), '[]'::jsonb) AS ${sqlSafeIdentifier('data')} ` +
        `FROM ${qualifiedIdentifier(inb.source.schema, inb.source.name)} AS ${sqlSafeIdentifier(alias)} WHERE ${on}) ` +
        `AS ${sqlSafeIdentifier(alias + '_agg')} ON TRUE`,
    );
    projection.push(
      `${sqlSafeIdentifier(alias + '_agg')}.${sqlSafeIdentifier('data')} AS ${sqlSafeIdentifier(inb.fieldName)}`,
    );
    embed.push({
      fieldName: inb.fieldName,
      table: inb.source,
      cardinality: inb.cardinality,
      alias,
    });
    currentTable = sourceTable;
    currentAlias = alias;
  });

  const param: unknown[] = [];
  param.push(option.limit ?? 100);
  const sql =
    `SELECT ${projection.join(', ')} FROM ${qualifiedIdentifier(from.schema, from.name)} AS ${sqlSafeIdentifier(rootAlias)}` +
    (joinClause.length > 0 ? ` ${joinClause.join(' ')}` : '') +
    ` LIMIT $${String(param.length)}`;
  return { sql, param, embed };
}

function matchSegment(
  segment: string,
  fieldName: string,
  tableName: string,
  constraintName: string,
): boolean {
  return segment === fieldName || segment === tableName || segment === constraintName;
}

// -----------------------------------------------------------------------------
// Naming
// -----------------------------------------------------------------------------

/** Derive the field name an outbound relation would be embedded under:
 *  `author_id` becomes `author`, a compound or non-`_id` key falls back to
 *  the target table name.
 * @public
 */
export function relationFieldName(
  column: readonly string[],
  referencedTable: string,
): string {
  if (column.length === 1) {
    const only = column[0] ?? '';
    if (only.endsWith('_id') && only.length > 3) return only.slice(0, -3);
    if (only.endsWith('Id') && only.length > 2) return only.slice(0, -2);
  }
  return referencedTable;
}

// An inbound one-to-many reads naturally as the child table's name; a
// one-to-one reads as the child table's name too, and the cardinality on the
// edge is what tells a consumer whether to expect an object or a list. The
// repo's singular-naming rule means we do NOT pluralise here.
function inboundFieldName(sourceTable: string, _isUnique: boolean): string {
  return sourceTable;
}
