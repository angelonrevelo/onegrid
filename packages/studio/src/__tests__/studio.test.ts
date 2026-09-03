import { describe, expect, it } from 'vitest';

import {
  DDL_OPERATION_KIND,
  INTROSPECTION_QUERY,
  assembleSchema,
  assessMigration,
  assessRisk,
  buildJoinQuery,
  buildRowDefault,
  bulkDelete,
  classifyStatement,
  compileDdl,
  compileDdlBatch,
  deleteRow,
  detectDisplayColumn,
  duplicateRow,
  findColumn,
  findTable,
  foreignKeyLookup,
  highestRisk,
  insertRow,
  introspectDatabase,
  isBareIdentifier,
  isJunctionTable,
  isUniquelyConstrained,
  parseDefaultLiteral,
  planMigration,
  qualifiedIdentifier,
  relationFieldName,
  resolveRelationship,
  reverseMigration,
  reverseOperation,
  selectRow,
  splitStatement,
  sqlLiteral,
  sqlSafeExpression,
  sqlSafeIdentifier,
  sqlSafeTypeName,
  stringArray,
  stripComment,
  tableKey,
  updateRow,
  type ColumnDescriptor,
  type DatabaseSchema,
  type DdlOperation,
  type ForeignKeyDescriptor,
  type PostgresQueryable,
  type TableDescriptor,
} from '../index';

// -----------------------------------------------------------------------------
// Fixture builders — keep every test readable by defaulting the boring parts.
// -----------------------------------------------------------------------------

function column(
  name: string,
  dataType: string,
  extra: Partial<ColumnDescriptor> = {},
): ColumnDescriptor {
  return {
    name,
    dataType,
    columnType: 'utf8',
    isNullable: true,
    defaultExpression: null,
    identity: 'none',
    generatedExpression: null,
    comment: null,
    ordinalPosition: 1,
    enumTypeName: null,
    characterMaximumLength: null,
    numericPrecision: null,
    numericScale: null,
    ...extra,
  };
}

function table(
  name: string,
  extra: Partial<TableDescriptor> = {},
): TableDescriptor {
  return {
    schema: 'public',
    name,
    kind: 'table',
    comment: null,
    isRlsEnabled: false,
    column: [],
    primaryKey: null,
    uniqueConstraint: [],
    checkConstraint: [],
    foreignKey: [],
    index: [],
    trigger: [],
    policy: [],
    estimatedRowCount: 0,
    ...extra,
  };
}

function schema(...t: TableDescriptor[]): DatabaseSchema {
  return { schemaName: ['public'], table: t, view: [], enumType: [], sequence: [] };
}

const userTable = table('user', {
  column: [
    column('id', 'uuid', { isNullable: false, ordinalPosition: 1, columnType: 'utf8' }),
    column('email', 'text', { isNullable: false, ordinalPosition: 2 }),
    column('name', 'text', { ordinalPosition: 3 }),
    column('created_at', 'timestamp with time zone', {
      isNullable: false,
      ordinalPosition: 4,
      columnType: 'timestamp_tz',
      defaultExpression: 'now()',
    }),
  ],
  primaryKey: { name: 'user_pkey', column: ['id'] },
  estimatedRowCount: 5000,
});

const postTable = table('post', {
  column: [
    column('id', 'bigint', {
      isNullable: false,
      ordinalPosition: 1,
      columnType: 'int64',
      identity: 'always',
    }),
    column('title', 'text', { isNullable: false, ordinalPosition: 2 }),
    column('author_id', 'uuid', { isNullable: false, ordinalPosition: 3 }),
    column('status', 'public.post_status', {
      ordinalPosition: 4,
      enumTypeName: 'public.post_status',
      defaultExpression: "'draft'::public.post_status",
    }),
  ],
  primaryKey: { name: 'post_pkey', column: ['id'] },
  foreignKey: [
    {
      name: 'post_author_id_fkey',
      column: ['author_id'],
      referencedSchema: 'public',
      referencedTable: 'user',
      referencedColumn: ['id'],
      onDelete: 'cascade',
      onUpdate: 'no action',
    },
  ],
});

// A compound-key table, because compound keys are where every naive
// implementation of this package falls over.
const membershipTable = table('membership', {
  column: [
    column('org_id', 'uuid', { isNullable: false, ordinalPosition: 1 }),
    column('user_id', 'uuid', { isNullable: false, ordinalPosition: 2 }),
    column('role', 'text', { isNullable: false, ordinalPosition: 3, defaultExpression: "'member'::text" }),
  ],
  primaryKey: { name: 'membership_pkey', column: ['org_id', 'user_id'] },
  foreignKey: [
    {
      name: 'membership_user_id_fkey',
      column: ['user_id'],
      referencedSchema: 'public',
      referencedTable: 'user',
      referencedColumn: ['id'],
      onDelete: 'cascade',
      onUpdate: 'no action',
    },
    {
      name: 'membership_org_id_fkey',
      column: ['org_id'],
      referencedSchema: 'public',
      referencedTable: 'org',
      referencedColumn: ['id'],
      onDelete: 'restrict',
      onUpdate: 'no action',
    },
  ],
});

// -----------------------------------------------------------------------------
// 1. Identifier guard
// -----------------------------------------------------------------------------

describe('sqlSafeIdentifier', () => {
  it('quotes a plain identifier', () => {
    expect(sqlSafeIdentifier('user')).toBe('"user"');
  });

  it('neutralises a statement-terminating injection attempt', () => {
    const hostile = '"; DROP TABLE x; --';
    const quoted = sqlSafeIdentifier(hostile);
    // The embedded quote is doubled, so the identifier has exactly two
    // unpaired quotes: the ones we added. Nothing inside can close it.
    expect(quoted).toBe('"""; DROP TABLE x; --"');
    expect(quoted.startsWith('"')).toBe(true);
    expect(quoted.endsWith('"')).toBe(true);
    // A scan of the interior finds no unpaired quote.
    const interior = quoted.slice(1, -1);
    expect(interior.replace(/""/g, '')).not.toContain('"');
  });

  it('keeps the injection inert all the way through compileDdl', () => {
    const sql = compileDdl({
      kind: 'addColumn',
      schema: 'public',
      table: '"; DROP TABLE x; --',
      column: { name: 'a', type: 'text' },
    }).sql;
    expect(sql).toBe('ALTER TABLE "public"."""; DROP TABLE x; --" ADD COLUMN "a" text');
    // One statement, and the DROP is inside the quoted identifier.
    expect(splitStatement(sql)).toHaveLength(1);
  });

  it('rejects an empty identifier and a NUL byte', () => {
    expect(() => sqlSafeIdentifier('')).toThrow(/must not be empty/);
    expect(() => sqlSafeIdentifier('a' + String.fromCharCode(0) + 'b')).toThrow(/NUL/);
  });

  it('rejects an identifier past the 63-byte Postgres limit', () => {
    expect(() => sqlSafeIdentifier('a'.repeat(64))).toThrow(/63/);
    expect(sqlSafeIdentifier('a'.repeat(63))).toHaveLength(65);
  });

  it('quotes each segment of a qualified name independently', () => {
    expect(qualifiedIdentifier('public', 'a.b')).toBe('"public"."a.b"');
    expect(qualifiedIdentifier(null, 'user')).toBe('"user"');
  });

  it('escapes literals and switches to E-string for backslashes', () => {
    expect(sqlLiteral("O'Brien")).toBe("'O''Brien'");
    expect(sqlLiteral('a\\b')).toBe("E'a\\\\b'");
  });

  it('blocks statement terminators and comments in an expression position', () => {
    expect(() => sqlSafeExpression('1=1; DROP TABLE x')).toThrow(/";"/);
    expect(() => sqlSafeExpression('1=1 -- x')).toThrow(/comment/);
    expect(sqlSafeExpression(' price > 0 ')).toBe('price > 0');
  });

  it('validates type names without quoting them', () => {
    expect(sqlSafeTypeName('numeric(10,2)')).toBe('numeric(10,2)');
    expect(sqlSafeTypeName('timestamp with time zone')).toBe('timestamp with time zone');
    expect(sqlSafeTypeName('public.mood')).toBe('public.mood');
    expect(sqlSafeTypeName('text[]')).toBe('text[]');
    expect(() => sqlSafeTypeName('text); DROP TABLE x; --')).toThrow(/invalid/);
  });

  it('knows which identifiers need quoting', () => {
    expect(isBareIdentifier('user_note')).toBe(true);
    expect(isBareIdentifier('order')).toBe(false);
    expect(isBareIdentifier('Order')).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// 2. DDL compilation — one test per operation family
// -----------------------------------------------------------------------------

describe('compileDdl', () => {
  const sqlOf = (op: DdlOperation): string => compileDdl(op).sql;

  it('compiles createSchema', () => {
    expect(sqlOf({ kind: 'createSchema', schema: 'app', ifNotExists: true })).toBe(
      'CREATE SCHEMA IF NOT EXISTS "app"',
    );
  });

  it('compiles createTable with an inline primary key and a default', () => {
    expect(
      sqlOf({
        kind: 'createTable',
        schema: 'public',
        table: 'note',
        column: [
          { name: 'id', type: 'bigint', identity: 'always', isPrimaryKey: true },
          { name: 'body', type: 'text', isNullable: false, defaultExpression: "''" },
        ],
      }),
    ).toBe(
      'CREATE TABLE "public"."note" ("id" bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, "body" text DEFAULT \'\' NOT NULL)',
    );
  });

  it('compiles createTable with a compound primary key as a table constraint', () => {
    expect(
      sqlOf({
        kind: 'createTable',
        schema: 'public',
        table: 'membership',
        column: [
          { name: 'org_id', type: 'uuid', isNullable: false },
          { name: 'user_id', type: 'uuid', isNullable: false },
        ],
        primaryKeyColumn: ['org_id', 'user_id'],
      }),
    ).toBe(
      'CREATE TABLE "public"."membership" ("org_id" uuid NOT NULL, "user_id" uuid NOT NULL, PRIMARY KEY ("org_id", "user_id"))',
    );
  });

  it('rejects a createTable that declares a primary key twice', () => {
    expect(() =>
      sqlOf({
        kind: 'createTable',
        schema: 'public',
        table: 't',
        column: [{ name: 'id', type: 'int', isPrimaryKey: true }],
        primaryKeyColumn: ['id'],
      }),
    ).toThrow(/inline primary key OR primaryKeyColumn/);
  });

  it('compiles dropTable, renameTable and setTableComment', () => {
    expect(sqlOf({ kind: 'dropTable', schema: 'public', table: 'note', cascade: true, ifExists: true })).toBe(
      'DROP TABLE IF EXISTS "public"."note" CASCADE',
    );
    expect(sqlOf({ kind: 'renameTable', schema: 'public', table: 'note', newName: 'memo' })).toBe(
      'ALTER TABLE "public"."note" RENAME TO "memo"',
    );
    expect(sqlOf({ kind: 'setTableComment', schema: 'public', table: 'note', comment: "Bob's notes" })).toBe(
      'COMMENT ON TABLE "public"."note" IS \'Bob\'\'s notes\'',
    );
    expect(sqlOf({ kind: 'setTableComment', schema: 'public', table: 'note', comment: null })).toBe(
      'COMMENT ON TABLE "public"."note" IS NULL',
    );
  });

  it('compiles the column operations', () => {
    expect(
      sqlOf({ kind: 'addColumn', schema: 'public', table: 'note', column: { name: 'tag', type: 'text[]' } }),
    ).toBe('ALTER TABLE "public"."note" ADD COLUMN "tag" text[]');
    expect(sqlOf({ kind: 'dropColumn', schema: 'public', table: 'note', column: 'tag', cascade: true })).toBe(
      'ALTER TABLE "public"."note" DROP COLUMN "tag" CASCADE',
    );
    expect(sqlOf({ kind: 'renameColumn', schema: 'public', table: 'note', column: 'tag', newName: 'label' })).toBe(
      'ALTER TABLE "public"."note" RENAME COLUMN "tag" TO "label"',
    );
    expect(sqlOf({ kind: 'setNotNull', schema: 'public', table: 'note', column: 'tag' })).toBe(
      'ALTER TABLE "public"."note" ALTER COLUMN "tag" SET NOT NULL',
    );
    expect(sqlOf({ kind: 'dropNotNull', schema: 'public', table: 'note', column: 'tag' })).toBe(
      'ALTER TABLE "public"."note" ALTER COLUMN "tag" DROP NOT NULL',
    );
    expect(
      sqlOf({ kind: 'setColumnDefault', schema: 'public', table: 'note', column: 'tag', expression: "'{}'::text[]" }),
    ).toBe('ALTER TABLE "public"."note" ALTER COLUMN "tag" SET DEFAULT \'{}\'::text[]');
    expect(sqlOf({ kind: 'dropColumnDefault', schema: 'public', table: 'note', column: 'tag' })).toBe(
      'ALTER TABLE "public"."note" ALTER COLUMN "tag" DROP DEFAULT',
    );
    expect(
      sqlOf({ kind: 'setColumnComment', schema: 'public', table: 'note', column: 'tag', comment: 'a tag' }),
    ).toBe('COMMENT ON COLUMN "public"."note"."tag" IS \'a tag\'');
  });

  it('compiles alterColumnType with a USING cast', () => {
    expect(
      sqlOf({
        kind: 'alterColumnType',
        schema: 'public',
        table: 'note',
        column: 'count',
        newType: 'integer',
        usingExpression: 'count::integer',
      }),
    ).toBe('ALTER TABLE "public"."note" ALTER COLUMN "count" TYPE integer USING count::integer');
  });

  it('compiles the constraint operations', () => {
    expect(
      sqlOf({ kind: 'addPrimaryKey', schema: 'public', table: 'm', column: ['a', 'b'], name: 'm_pkey' }),
    ).toBe('ALTER TABLE "public"."m" ADD CONSTRAINT "m_pkey" PRIMARY KEY ("a", "b")');
    expect(sqlOf({ kind: 'dropPrimaryKey', schema: 'public', table: 'm', name: 'm_pkey' })).toBe(
      'ALTER TABLE "public"."m" DROP CONSTRAINT "m_pkey"',
    );
    expect(sqlOf({ kind: 'addUnique', schema: 'public', table: 'm', column: ['email'] })).toBe(
      'ALTER TABLE "public"."m" ADD UNIQUE ("email")',
    );
    expect(
      sqlOf({ kind: 'addCheck', schema: 'public', table: 'm', expression: 'price > 0', name: 'm_price_check', notValid: true }),
    ).toBe('ALTER TABLE "public"."m" ADD CONSTRAINT "m_price_check" CHECK (price > 0) NOT VALID');
    expect(
      sqlOf({ kind: 'dropConstraint', schema: 'public', table: 'm', name: 'm_price_check', ifExists: true }),
    ).toBe('ALTER TABLE "public"."m" DROP CONSTRAINT IF EXISTS "m_price_check"');
  });

  it('compiles a foreign key with every referential action', () => {
    const of = (onDelete: ForeignKeyDescriptor['onDelete']): string =>
      sqlOf({
        kind: 'addForeignKey',
        schema: 'public',
        table: 'post',
        column: ['author_id'],
        referencedTable: 'user',
        referencedColumn: ['id'],
        onDelete,
      });
    expect(of('cascade')).toContain('ON DELETE CASCADE');
    expect(of('set null')).toContain('ON DELETE SET NULL');
    expect(of('restrict')).toContain('ON DELETE RESTRICT');
    expect(of('no action')).toContain('ON DELETE NO ACTION');
  });

  it('compiles a composite foreign key with paired column lists', () => {
    expect(
      sqlOf({
        kind: 'addForeignKey',
        schema: 'public',
        table: 'child',
        column: ['a', 'b'],
        referencedSchema: 'other',
        referencedTable: 'parent',
        referencedColumn: ['x', 'y'],
        onDelete: 'cascade',
        onUpdate: 'restrict',
        name: 'child_parent_fkey',
      }),
    ).toBe(
      'ALTER TABLE "public"."child" ADD CONSTRAINT "child_parent_fkey" FOREIGN KEY ("a", "b") ' +
        'REFERENCES "other"."parent" ("x", "y") ON DELETE CASCADE ON UPDATE RESTRICT',
    );
  });

  it('rejects a foreign key whose column lists cannot be paired', () => {
    expect(() =>
      sqlOf({
        kind: 'addForeignKey',
        schema: 'public',
        table: 'child',
        column: ['a', 'b'],
        referencedTable: 'parent',
        referencedColumn: ['x'],
      }),
    ).toThrow(/must match referencedColumn count/);
  });

  it('compiles every index method, unique, partial and concurrent', () => {
    expect(
      sqlOf({ kind: 'createIndex', schema: 'public', table: 'post', column: ['title'], method: 'gin' }),
    ).toBe('CREATE INDEX ON "public"."post" USING gin ("title")');
    expect(
      sqlOf({
        kind: 'createIndex',
        schema: 'public',
        table: 'post',
        name: 'post_title_idx',
        column: ['title'],
        method: 'btree',
        isUnique: true,
        isConcurrent: true,
        predicate: 'deleted_at IS NULL',
        ordering: ['desc'],
        nullOrdering: ['last'],
      }),
    ).toBe(
      'CREATE UNIQUE INDEX CONCURRENTLY "post_title_idx" ON "public"."post" USING btree ' +
        '("title" DESC NULLS LAST) WHERE deleted_at IS NULL',
    );
    expect(
      sqlOf({ kind: 'createIndex', schema: 'public', table: 'user', expression: ['lower(email)'], method: 'hash' }),
    ).toBe('CREATE INDEX ON "public"."user" USING hash ((lower(email)))');
    expect(
      sqlOf({ kind: 'dropIndex', schema: 'public', name: 'post_title_idx', isConcurrent: true, ifExists: true }),
    ).toBe('DROP INDEX CONCURRENTLY IF EXISTS "public"."post_title_idx"');
  });

  it('compiles the enum operations', () => {
    expect(sqlOf({ kind: 'createEnum', schema: 'public', name: 'mood', label: ['ok', "isn't"] })).toBe(
      'CREATE TYPE "public"."mood" AS ENUM (\'ok\', \'isn\'\'t\')',
    );
    expect(
      sqlOf({ kind: 'addEnumValue', schema: 'public', name: 'mood', label: 'great', after: 'ok', ifNotExists: true }),
    ).toBe('ALTER TYPE "public"."mood" ADD VALUE IF NOT EXISTS \'great\' AFTER \'ok\'');
    expect(() =>
      sqlOf({ kind: 'addEnumValue', schema: 'public', name: 'mood', label: 'x', before: 'a', after: 'b' }),
    ).toThrow(/not both/);
  });

  it('compiles the RLS operations', () => {
    expect(sqlOf({ kind: 'enableRls', schema: 'public', table: 'post' })).toBe(
      'ALTER TABLE "public"."post" ENABLE ROW LEVEL SECURITY',
    );
    expect(sqlOf({ kind: 'disableRls', schema: 'public', table: 'post' })).toBe(
      'ALTER TABLE "public"."post" DISABLE ROW LEVEL SECURITY',
    );
    expect(
      sqlOf({
        kind: 'createPolicy',
        schema: 'public',
        table: 'post',
        name: 'own post',
        command: 'select',
        role: ['authenticated', 'public'],
        usingExpression: 'author_id = auth.uid()',
        withCheckExpression: 'author_id = auth.uid()',
      }),
    ).toBe(
      'CREATE POLICY "own post" ON "public"."post" FOR SELECT TO "authenticated", PUBLIC ' +
        'USING (author_id = auth.uid()) WITH CHECK (author_id = auth.uid())',
    );
    expect(sqlOf({ kind: 'dropPolicy', schema: 'public', table: 'post', name: 'own post', ifExists: true })).toBe(
      'DROP POLICY IF EXISTS "own post" ON "public"."post"',
    );
  });

  it('compiles every operation kind without throwing on a minimal shape', () => {
    // Guards against a new union member being added without a case.
    expect(DDL_OPERATION_KIND).toHaveLength(31);
    expect(new Set(DDL_OPERATION_KIND).size).toBe(31);
  });

  it('never emits bind parameters, because Postgres refuses them in DDL', () => {
    const batch = compileDdlBatch([
      { kind: 'createSchema', schema: 'app' },
      { kind: 'setTableComment', schema: 'public', table: 't', comment: 'hi' },
    ]);
    expect(batch).toHaveLength(2);
    expect(batch.every((s) => s.param.length === 0)).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// 3. Row-level DML
// -----------------------------------------------------------------------------

describe('row DML', () => {
  it('parameterises an insert and returns the row', () => {
    const { sql, param } = insertRow(userTable, { email: 'a@b.c', name: 'A' });
    expect(sql).toBe(
      'INSERT INTO "public"."user" ("email", "name") VALUES ($1, $2) RETURNING *',
    );
    expect(param).toEqual(['a@b.c', 'A']);
  });

  it('uses DEFAULT VALUES for an empty insert', () => {
    expect(insertRow(userTable, {}).sql).toBe(
      'INSERT INTO "public"."user" DEFAULT VALUES RETURNING *',
    );
  });

  it('rejects an insert naming a column the table does not have', () => {
    expect(() => insertRow(userTable, { nope: 1 })).toThrow(/unknown column "nope"/);
  });

  it('orders update parameters SET-first then WHERE', () => {
    const { sql, param } = updateRow(userTable, { id: 'u1' }, { name: 'B' });
    expect(sql).toBe('UPDATE "public"."user" SET "name" = $1 WHERE "id" = $2 RETURNING *');
    expect(param).toEqual(['B', 'u1']);
  });

  it('requires every column of a compound primary key', () => {
    const { sql, param } = updateRow(
      membershipTable,
      { org_id: 'o1', user_id: 'u1' },
      { role: 'admin' },
    );
    expect(sql).toBe(
      'UPDATE "public"."membership" SET "role" = $1 WHERE "org_id" = $2 AND "user_id" = $3 RETURNING *',
    );
    expect(param).toEqual(['admin', 'o1', 'u1']);
    expect(() => updateRow(membershipTable, { org_id: 'o1' }, { role: 'x' })).toThrow(
      /missing primary-key column "user_id"/,
    );
  });

  it('refuses a null primary-key value rather than silently matching nothing', () => {
    expect(() => deleteRow(userTable, { id: null })).toThrow(/cannot be null/);
  });

  it('refuses row DML on a table with no primary key', () => {
    const keyless = table('log', { column: [column('message', 'text')] });
    expect(() => deleteRow(keyless, { message: 'x' })).toThrow(/no primary key/);
  });

  it('compiles delete and select by key', () => {
    expect(deleteRow(userTable, { id: 'u1' })).toEqual({
      sql: 'DELETE FROM "public"."user" WHERE "id" = $1 RETURNING *',
      param: ['u1'],
    });
    expect(selectRow(userTable, { id: 'u1' }).sql).toBe(
      'SELECT * FROM "public"."user" WHERE "id" = $1 LIMIT 1',
    );
  });

  it('uses = ANY for a single-column bulk delete so the plan is reused', () => {
    const { sql, param } = bulkDelete(userTable, [{ id: 'a' }, { id: 'b' }, { id: 'c' }]);
    expect(sql).toBe('DELETE FROM "public"."user" WHERE "id" = ANY($1) RETURNING *');
    expect(param).toEqual([['a', 'b', 'c']]);
  });

  it('falls back to a row-constructor IN list for a compound key', () => {
    const { sql, param } = bulkDelete(membershipTable, [
      { org_id: 'o1', user_id: 'u1' },
      { org_id: 'o2', user_id: 'u2' },
    ]);
    expect(sql).toBe(
      'DELETE FROM "public"."membership" WHERE ("org_id", "user_id") IN (($1, $2), ($3, $4)) RETURNING *',
    );
    expect(param).toEqual(['o1', 'u1', 'o2', 'u2']);
  });

  it('duplicates a row without copying database-generated columns', () => {
    const { sql, param } = duplicateRow(postTable, { id: 7 }, { title: 'Copy' });
    // `id` is identity ALWAYS, so it is neither copied nor listed.
    expect(sql).toBe(
      'INSERT INTO "public"."post" ("author_id", "status", "title") ' +
        'SELECT "author_id", "status", $1 FROM "public"."post" WHERE "id" = $2 RETURNING *',
    );
    expect(param).toEqual(['Copy', 7]);
  });
});

describe('buildRowDefault', () => {
  it('marks database-generated columns and omits them from the value', () => {
    const result = buildRowDefault(postTable);
    const byName = new Map(result.field.map((f) => [f.column, f]));
    expect(byName.get('id')?.isDatabaseGenerated).toBe(true);
    expect(Object.keys(result.value)).not.toContain('id');
    // A literal default is resolved so the form shows what will land.
    expect(byName.get('status')?.value).toBe('draft');
    expect(result.value['status']).toBe('draft');
    // NOT NULL with no default is required.
    expect(byName.get('title')?.isRequired).toBe(true);
    expect(result.value['title']).toBeNull();
    // The enum type name is surfaced so a form can render a select.
    expect(byName.get('status')?.enumTypeName).toBe('public.post_status');
  });

  it('treats a function default as database-supplied rather than guessing', () => {
    const result = buildRowDefault(userTable);
    const createdAt = result.field.find((f) => f.column === 'created_at');
    expect(createdAt?.isDatabaseGenerated).toBe(true);
    expect(createdAt?.isRequired).toBe(false);
    expect(Object.keys(result.value)).not.toContain('created_at');
  });

  it('parses only unambiguous literal defaults', () => {
    expect(parseDefaultLiteral("'draft'::text")).toEqual({ value: 'draft' });
    expect(parseDefaultLiteral("'it''s'::text")).toEqual({ value: "it's" });
    expect(parseDefaultLiteral('0')).toEqual({ value: 0 });
    expect(parseDefaultLiteral('-1.5')).toEqual({ value: -1.5 });
    expect(parseDefaultLiteral('true')).toEqual({ value: true });
    expect(parseDefaultLiteral('NULL')).toEqual({ value: null });
    expect(parseDefaultLiteral('now()')).toBeUndefined();
    expect(parseDefaultLiteral("('a'::text || 'b'::text)")).toBeUndefined();
    expect(parseDefaultLiteral(null)).toBeUndefined();
  });
});

// -----------------------------------------------------------------------------
// 4. Relationship intelligence
// -----------------------------------------------------------------------------

describe('resolveRelationship', () => {
  const orgTable = table('org', {
    column: [
      column('id', 'uuid', { isNullable: false, ordinalPosition: 1 }),
      column('name', 'text', { isNullable: false, ordinalPosition: 2 }),
    ],
    primaryKey: { name: 'org_pkey', column: ['id'] },
  });
  const db = schema(userTable, postTable, orgTable, membershipTable);

  it('derives the inbound edge Postgres does not store', () => {
    const graph = resolveRelationship(db);
    const user = graph.get({ schema: 'public', name: 'user' });
    expect(user?.outbound).toHaveLength(0);
    expect(user?.inbound.map((r) => r.source.name).sort()).toEqual(['membership', 'post']);
    expect(user?.inbound.find((r) => r.source.name === 'post')?.cardinality).toBe('one-to-many');
  });

  it('classifies an outbound edge as many-to-one and names its field', () => {
    const graph = resolveRelationship(db);
    const post = graph.get({ schema: 'public', name: 'post' });
    const fk = post?.outbound[0];
    expect(fk?.cardinality).toBe('many-to-one');
    expect(fk?.fieldName).toBe('author');
    expect(fk?.target).toEqual({ schema: 'public', name: 'user' });
    expect(fk?.isNullable).toBe(false);
  });

  it('gives every table an entry, including unrelated ones', () => {
    const lonely = table('audit', { column: [column('id', 'uuid')] });
    const graph = resolveRelationship(schema(lonely));
    expect(graph.get({ schema: 'public', name: 'audit' })).toEqual({
      table: { schema: 'public', name: 'audit' },
      outbound: [],
      inbound: [],
    });
    expect(graph.get({ schema: 'public', name: 'nope' })).toBeNull();
  });

  it('promotes an FK to one-to-one only when its columns are exactly unique', () => {
    const profile = table('profile', {
      column: [column('user_id', 'uuid', { isNullable: false })],
      primaryKey: { name: 'profile_pkey', column: ['user_id'] },
      foreignKey: [
        {
          name: 'profile_user_id_fkey',
          column: ['user_id'],
          referencedSchema: 'public',
          referencedTable: 'user',
          referencedColumn: ['id'],
          onDelete: 'cascade',
          onUpdate: 'no action',
        },
      ],
    });
    const graph = resolveRelationship(schema(userTable, profile));
    expect(graph.get({ schema: 'public', name: 'profile' })?.outbound[0]?.cardinality).toBe(
      'one-to-one',
    );
    expect(graph.get({ schema: 'public', name: 'user' })?.inbound[0]?.cardinality).toBe(
      'one-to-one',
    );
  });

  it('requires exact coverage, not a subset, for uniqueness', () => {
    const t = table('t', {
      column: [column('a', 'text'), column('b', 'text')],
      uniqueConstraint: [{ name: 't_ab_key', column: ['a', 'b'], isDeferrable: false }],
    });
    expect(isUniquelyConstrained(t, ['a', 'b'])).toBe(true);
    expect(isUniquelyConstrained(t, ['a'])).toBe(false);
  });

  it('recognises a junction table', () => {
    // `membership` qualifies: its PK is exactly its two FK columns, even
    // though it also carries a `role` payload column.
    expect(isJunctionTable(membershipTable)).toBe(true);
    expect(isJunctionTable(postTable)).toBe(false);
    const postTag = table('post_tag', {
      column: [column('post_id', 'bigint'), column('tag_id', 'bigint')],
      primaryKey: { name: 'post_tag_pkey', column: ['post_id', 'tag_id'] },
      foreignKey: [
        { name: 'a', column: ['post_id'], referencedSchema: 'public', referencedTable: 'post', referencedColumn: ['id'], onDelete: 'cascade', onUpdate: 'no action' },
        { name: 'b', column: ['tag_id'], referencedSchema: 'public', referencedTable: 'tag', referencedColumn: ['id'], onDelete: 'cascade', onUpdate: 'no action' },
      ],
    });
    expect(isJunctionTable(postTag)).toBe(true);
  });

  it('derives an embed field name from the FK column', () => {
    expect(relationFieldName(['author_id'], 'user')).toBe('author');
    expect(relationFieldName(['authorId'], 'user')).toBe('author');
    expect(relationFieldName(['a', 'b'], 'parent')).toBe('parent');
    expect(relationFieldName(['owner'], 'user')).toBe('user');
  });
});

describe('detectDisplayColumn', () => {
  it('prefers a human-readable name over a uuid primary key', () => {
    expect(detectDisplayColumn(userTable)).toBe('name');
  });

  it('falls back through the ranked name list', () => {
    const t = table('t', {
      column: [
        column('id', 'uuid', { isNullable: false, ordinalPosition: 1 }),
        column('email', 'text', { isNullable: false, ordinalPosition: 2 }),
        column('slug', 'text', { ordinalPosition: 3 }),
      ],
      primaryKey: { name: 'pk', column: ['id'] },
    });
    expect(detectDisplayColumn(t)).toBe('email');
  });

  it('recognises a suffixed label column', () => {
    const t = table('t', {
      column: [
        column('id', 'uuid', { ordinalPosition: 1 }),
        column('product_name', 'text', { isNullable: false, ordinalPosition: 2 }),
        column('note', 'text', { ordinalPosition: 3 }),
      ],
      primaryKey: { name: 'pk', column: ['id'] },
    });
    expect(detectDisplayColumn(t)).toBe('product_name');
  });

  it('never picks a non-text column', () => {
    const t = table('t', {
      column: [
        column('id', 'bigint', { columnType: 'int64', ordinalPosition: 1 }),
        column('created_at', 'timestamp', { columnType: 'timestamp', ordinalPosition: 2 }),
        column('payload', 'jsonb', { columnType: 'json', ordinalPosition: 3 }),
      ],
    });
    expect(detectDisplayColumn(t)).toBeNull();
  });

  it('penalises but does not exclude a natural-key text column', () => {
    const t = table('country', {
      column: [column('code', 'text', { isNullable: false, ordinalPosition: 1 })],
      primaryKey: { name: 'pk', column: ['code'] },
    });
    expect(detectDisplayColumn(t)).toBe('code');
  });

  it('prefers NOT NULL over nullable when names tie', () => {
    const t = table('t', {
      column: [
        column('description', 'text', { ordinalPosition: 1 }),
        column('summary', 'text', { isNullable: false, ordinalPosition: 2 }),
      ],
    });
    // description scores 45, summary 40 + 8 for NOT NULL = 48.
    expect(detectDisplayColumn(t)).toBe('summary');
  });
});

describe('foreignKeyLookup', () => {
  const fk = postTable.foreignKey[0]!;

  it('searches the referenced table by its display column', () => {
    const q = foreignKeyLookup({ fk, referencedTable: userTable }, 'ali');
    expect(q.displayColumn).toBe('name');
    expect(q.sql).toBe(
      'SELECT "id" AS "value", "name" AS "label" FROM "public"."user" ' +
        'WHERE "name"::text ILIKE $1 ORDER BY "name" LIMIT $2',
    );
    expect(q.param).toEqual(['%ali%', 20]);
  });

  it('drops the WHERE clause for the picker’s initial page', () => {
    const q = foreignKeyLookup({ fk, referencedTable: userTable, limit: 5 }, '   ');
    expect(q.sql).not.toContain('WHERE');
    expect(q.param).toEqual([5]);
  });

  it('escapes LIKE metacharacters so "100%" is a literal search', () => {
    const q = foreignKeyLookup({ fk, referencedTable: userTable }, '100%_x');
    expect(q.param[0]).toBe('%100\\%\\_x%');
  });

  it('falls back to the key itself when there is no display column', () => {
    const opaque = table('event', {
      column: [column('id', 'uuid', { isNullable: false })],
      primaryKey: { name: 'pk', column: ['id'] },
    });
    const q = foreignKeyLookup({ fk, referencedTable: opaque }, 'abc');
    expect(q.displayColumn).toBeNull();
    expect(q.labelAlias).toBe('value');
    expect(q.sql).toContain('"id"::text ILIKE $1');
  });

  it('emits a row constructor for a composite key', () => {
    const compositeFk: ForeignKeyDescriptor = {
      name: 'x',
      column: ['a', 'b'],
      referencedSchema: 'public',
      referencedTable: 'membership',
      referencedColumn: ['org_id', 'user_id'],
      onDelete: 'no action',
      onUpdate: 'no action',
    };
    const q = foreignKeyLookup({ fk: compositeFk, referencedTable: membershipTable }, '');
    expect(q.sql).toContain('("org_id", "user_id") AS "value"');
  });
});

describe('buildJoinQuery', () => {
  const db = schema(userTable, postTable);

  it('embeds a many-to-one relation as a jsonb object via LEFT JOIN', () => {
    const q = buildJoinQuery(db, { schema: 'public', name: 'post' }, ['author'], { column: ['id', 'title'] });
    expect(q.sql).toBe(
      'SELECT "t0"."id", "t0"."title", to_jsonb("t1".*) AS "author" ' +
        'FROM "public"."post" AS "t0" ' +
        'LEFT JOIN "public"."user" AS "t1" ON "t0"."author_id" = "t1"."id" LIMIT $1',
    );
    expect(q.embed).toEqual([
      { fieldName: 'author', table: { schema: 'public', name: 'user' }, cardinality: 'many-to-one', alias: 't1' },
    ]);
  });

  it('embeds a one-to-many relation as a lateral aggregate so root rows are not multiplied', () => {
    const q = buildJoinQuery(db, { schema: 'public', name: 'user' }, ['post'], { column: ['id'] });
    expect(q.sql).toContain('LEFT JOIN LATERAL');
    expect(q.sql).toContain('jsonb_agg(to_jsonb("t1".*))');
    expect(q.sql).toContain('WHERE "t1"."author_id" = "t0"."id"');
    expect(q.embed[0]?.cardinality).toBe('one-to-many');
  });

  it('resolves a path segment by table name and by constraint name too', () => {
    const byTable = buildJoinQuery(db, { schema: 'public', name: 'post' }, ['user']);
    const byConstraint = buildJoinQuery(db, { schema: 'public', name: 'post' }, ['post_author_id_fkey']);
    expect(byTable.sql).toContain('LEFT JOIN "public"."user"');
    expect(byConstraint.sql).toContain('LEFT JOIN "public"."user"');
  });

  it('rejects an unknown relation instead of emitting a broken join', () => {
    expect(() => buildJoinQuery(db, { schema: 'public', name: 'post' }, ['nope'])).toThrow(
      /no relation "nope"/,
    );
  });
});

// -----------------------------------------------------------------------------
// 5. Migration planning + risk
// -----------------------------------------------------------------------------

describe('planMigration', () => {
  it('creates a referenced table before the foreign key that needs it', () => {
    // `post` is listed FIRST in the target, so a planner that preserved
    // input order would emit its FK before `user` exists.
    const target = schema(postTable, userTable);
    const plan = planMigration(schema(), target);
    const kind = plan.map((op) => op.kind);
    const createUser = plan.findIndex(
      (op) => op.kind === 'createTable' && op.table === 'user',
    );
    const createPost = plan.findIndex(
      (op) => op.kind === 'createTable' && op.table === 'post',
    );
    const addFk = kind.indexOf('addForeignKey');
    expect(createUser).toBeGreaterThanOrEqual(0);
    expect(createUser).toBeLessThan(createPost);
    expect(addFk).toBeGreaterThan(createPost);
    // No foreign key is inlined into the CREATE TABLE.
    const createSql = compileDdl(plan[createPost]!).sql;
    expect(createSql).not.toContain('REFERENCES');
  });

  it('handles a reference cycle without failing to plan', () => {
    const a = table('a', {
      column: [column('id', 'uuid', { isNullable: false }), column('b_id', 'uuid')],
      primaryKey: { name: 'a_pkey', column: ['id'] },
      foreignKey: [
        { name: 'a_b_fkey', column: ['b_id'], referencedSchema: 'public', referencedTable: 'b', referencedColumn: ['id'], onDelete: 'no action', onUpdate: 'no action' },
      ],
    });
    const b = table('b', {
      column: [column('id', 'uuid', { isNullable: false }), column('a_id', 'uuid')],
      primaryKey: { name: 'b_pkey', column: ['id'] },
      foreignKey: [
        { name: 'b_a_fkey', column: ['a_id'], referencedSchema: 'public', referencedTable: 'a', referencedColumn: ['id'], onDelete: 'no action', onUpdate: 'no action' },
      ],
    });
    const plan = planMigration(schema(), schema(a, b));
    const lastCreate = plan.map((o) => o.kind).lastIndexOf('createTable');
    const firstFk = plan.map((o) => o.kind).indexOf('addForeignKey');
    expect(firstFk).toBeGreaterThan(lastCreate);
  });

  it('diffs columns into add / type / default / nullability operations', () => {
    const before = schema(
      table('t', {
        column: [
          column('id', 'uuid', { isNullable: false, ordinalPosition: 1 }),
          column('count', 'text', { ordinalPosition: 2 }),
          column('gone', 'text', { ordinalPosition: 3 }),
        ],
        primaryKey: { name: 'pk', column: ['id'] },
      }),
    );
    const after = schema(
      table('t', {
        column: [
          column('id', 'uuid', { isNullable: false, ordinalPosition: 1 }),
          column('count', 'integer', { isNullable: false, ordinalPosition: 2, defaultExpression: '0' }),
          column('added', 'text', { ordinalPosition: 4 }),
        ],
        primaryKey: { name: 'pk', column: ['id'] },
      }),
    );
    const kind = planMigration(before, after).map((op) => op.kind);
    expect(kind).toContain('alterColumnType');
    expect(kind).toContain('setColumnDefault');
    expect(kind).toContain('setNotNull');
    expect(kind).toContain('addColumn');
    expect(kind).toContain('dropColumn');
    // Drops come after adds, so no window exists with neither column present.
    expect(kind.indexOf('addColumn')).toBeLessThan(kind.indexOf('dropColumn'));
  });

  it('omits every drop when asked for an additive-only plan', () => {
    const before = schema(table('a', { column: [column('x', 'text')] }), table('b', { column: [column('y', 'text')] }));
    const after = schema(table('a', { column: [] as ColumnDescriptor[] }));
    const kind = planMigration(before, after, { includeDrop: false }).map((op) => op.kind);
    expect(kind).not.toContain('dropTable');
    expect(kind).not.toContain('dropColumn');
  });

  it('adds new enum labels in target order rather than appending blindly', () => {
    const before: DatabaseSchema = {
      ...schema(),
      enumType: [{ schema: 'public', name: 'mood', label: ['ok', 'sad'] }],
    };
    const after: DatabaseSchema = {
      ...schema(),
      enumType: [{ schema: 'public', name: 'mood', label: ['ok', 'great', 'sad'] }],
    };
    const plan = planMigration(before, after);
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({ kind: 'addEnumValue', label: 'great', after: 'ok' });
  });

  it('produces an empty plan for identical schemas', () => {
    const db = schema(userTable, postTable);
    expect(planMigration(db, db)).toEqual([]);
  });
});

describe('assessRisk', () => {
  it('calls a column drop lossy', () => {
    const r = assessRisk({ kind: 'dropColumn', schema: 'public', table: 't', column: 'c' });
    expect(r.level).toBe('lossy');
    expect(r.reason).toMatch(/destroys/);
    expect(r.isReversible).toBe(false);
  });

  it('calls NOT NULL without a default on a populated table blocking', () => {
    const op: DdlOperation = {
      kind: 'addColumn',
      schema: 'public',
      table: 't',
      column: { name: 'c', type: 'text', isNullable: false },
    };
    expect(assessRisk(op, { estimatedRowCount: 1 }).level).toBe('blocking');
    expect(assessRisk(op).level).toBe('blocking'); // unknown count assumes populated
    expect(assessRisk(op, { estimatedRowCount: 0 }).level).toBe('safe');
  });

  it('calls a non-concurrent index on a large table blocking and a concurrent one safe', () => {
    const base = { schema: 'public', table: 't', column: ['a'] } as const;
    expect(assessRisk({ kind: 'createIndex', ...base }, { estimatedRowCount: 1_000_000 }).level).toBe(
      'blocking',
    );
    expect(
      assessRisk({ kind: 'createIndex', ...base, isConcurrent: true }, { estimatedRowCount: 1_000_000 }).level,
    ).toBe('safe');
    expect(assessRisk({ kind: 'createIndex', ...base }, { estimatedRowCount: 10 }).level).toBe('safe');
  });

  it('treats an unknown row count as large', () => {
    expect(assessRisk({ kind: 'createIndex', schema: 'public', table: 't', column: ['a'] }).reason).toMatch(
      /row count unknown/,
    );
  });

  it('calls NOT VALID variants safe and validated ones blocking', () => {
    const check = { kind: 'addCheck', schema: 'public', table: 't', expression: 'x > 0' } as const;
    expect(assessRisk({ ...check, notValid: true }).level).toBe('safe');
    expect(assessRisk(check, { estimatedRowCount: 100 }).level).toBe('blocking');
  });

  it('warns that enabling RLS with no policy hides every row', () => {
    const r = assessRisk({ kind: 'enableRls', schema: 'public', table: 't' });
    expect(r.level).toBe('blocking');
    expect(r.reason).toMatch(/denies every row/);
  });

  it('summarises a plan and reports the worst level', () => {
    const assessed = assessMigration(
      [
        { kind: 'setTableComment', schema: 'public', table: 'user', comment: 'x' },
        { kind: 'dropColumn', schema: 'public', table: 'user', column: 'name' },
      ],
      schema(userTable),
    );
    expect(assessed.map((a) => a.risk.level)).toEqual(['safe', 'lossy']);
    expect(highestRisk(assessed)).toBe('lossy');
  });

  it('resolves the row count from the schema when assessing a plan', () => {
    const assessed = assessMigration(
      [{ kind: 'createIndex', schema: 'public', table: 'user', column: ['email'] }],
      schema(userTable), // 5000 rows, below the 10k default threshold
    );
    expect(assessed[0]?.risk.level).toBe('safe');
  });
});

describe('reverseOperation', () => {
  it('reverses the reversible operations', () => {
    expect(reverseOperation({ kind: 'createTable', schema: 'public', table: 't', column: [{ name: 'a', type: 'text' }] })).toEqual(
      { kind: 'dropTable', schema: 'public', table: 't', ifExists: true },
    );
    expect(reverseOperation({ kind: 'renameColumn', schema: 'public', table: 't', column: 'a', newName: 'b' })).toEqual(
      { kind: 'renameColumn', schema: 'public', table: 't', column: 'b', newName: 'a' },
    );
    expect(reverseOperation({ kind: 'setNotNull', schema: 'public', table: 't', column: 'a' })).toEqual(
      { kind: 'dropNotNull', schema: 'public', table: 't', column: 'a' },
    );
    expect(reverseOperation({ kind: 'enableRls', schema: 'public', table: 't' })).toEqual(
      { kind: 'disableRls', schema: 'public', table: 't' },
    );
  });

  it('restores the previous default when the operation carried it', () => {
    expect(
      reverseOperation({
        kind: 'setColumnDefault',
        schema: 'public',
        table: 't',
        column: 'a',
        expression: "'b'",
        previousExpression: "'a'",
      }),
    ).toMatchObject({ kind: 'setColumnDefault', expression: "'a'" });
    expect(
      reverseOperation({ kind: 'setColumnDefault', schema: 'public', table: 't', column: 'a', expression: "'b'" }),
    ).toMatchObject({ kind: 'dropColumnDefault' });
  });

  it('returns null for the genuinely irreversible operations', () => {
    const irreversible: DdlOperation[] = [
      { kind: 'dropColumn', schema: 'public', table: 't', column: 'a' },
      { kind: 'dropTable', schema: 'public', table: 't' },
      { kind: 'dropSchema', schema: 'app' },
      { kind: 'addEnumValue', schema: 'public', name: 'mood', label: 'x' },
      { kind: 'dropConstraint', schema: 'public', table: 't', name: 'c' },
      { kind: 'dropPolicy', schema: 'public', table: 't', name: 'p' },
      { kind: 'dropIndex', schema: 'public', name: 'i' },
      { kind: 'alterColumnType', schema: 'public', table: 't', column: 'a', newType: 'text' },
    ];
    for (const op of irreversible) expect(reverseOperation(op)).toBeNull();
  });

  it('reverses a whole plan in the opposite order, or not at all', () => {
    const plan: DdlOperation[] = [
      { kind: 'createSchema', schema: 'app' },
      { kind: 'createTable', schema: 'app', table: 't', column: [{ name: 'a', type: 'text' }] },
    ];
    expect(reverseMigration(plan)?.map((o) => o.kind)).toEqual(['dropTable', 'dropSchema']);
    expect(reverseMigration([...plan, { kind: 'dropColumn', schema: 'app', table: 't', column: 'a' }])).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// 6. SQL editor support
// -----------------------------------------------------------------------------

describe('splitStatement', () => {
  it('splits on top-level semicolons and drops the empty tail', () => {
    const s = splitStatement('SELECT 1; SELECT 2;');
    expect(s.map((x) => x.text)).toEqual(['SELECT 1', 'SELECT 2']);
  });

  it('keeps a dollar-quoted function body intact', () => {
    const sql = `
CREATE FUNCTION bump() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
SELECT 1;`;
    const s = splitStatement(sql);
    expect(s).toHaveLength(2);
    expect(s[0]?.text).toContain('RETURN NEW;');
    expect(s[1]?.text).toBe('SELECT 1');
  });

  it('honours a tagged dollar quote and ignores a non-matching inner tag', () => {
    const sql = `DO $body$ BEGIN RAISE NOTICE '$x$; not a boundary'; END $body$; SELECT 2;`;
    const s = splitStatement(sql);
    expect(s).toHaveLength(2);
    expect(s[0]?.text.startsWith('DO $body$')).toBe(true);
    expect(s[1]?.text).toBe('SELECT 2');
  });

  it('does not mistake a bind parameter for a dollar quote', () => {
    const s = splitStatement('SELECT * FROM t WHERE a = $1 AND b = $2; SELECT 3;');
    expect(s.map((x) => x.text)).toEqual([
      'SELECT * FROM t WHERE a = $1 AND b = $2',
      'SELECT 3',
    ]);
  });

  it('ignores semicolons inside string and quoted-identifier literals', () => {
    const s = splitStatement(`SELECT 'a;b', "c;d" FROM t; SELECT 2;`);
    expect(s).toHaveLength(2);
    expect(s[0]?.text).toBe(`SELECT 'a;b', "c;d" FROM t`);
  });

  it('handles a doubled quote inside a literal', () => {
    const s = splitStatement(`SELECT 'it''s; fine'; SELECT 2;`);
    expect(s.map((x) => x.text)).toEqual([`SELECT 'it''s; fine'`, 'SELECT 2']);
  });

  it('handles an E-string backslash escape', () => {
    const s = splitStatement(`SELECT E'a\\';b'; SELECT 2;`);
    expect(s).toHaveLength(2);
  });

  it('ignores semicolons in line and nested block comments', () => {
    const sql = `
-- a; comment
SELECT 1; /* block ; /* nested ; */ still in ; */ SELECT 2;`;
    const s = splitStatement(sql);
    // Two statements — the nested `/* ... */` did not terminate early. The
    // leading comment stays attached to the statement text; the splitter
    // locates statements, it does not rewrite them.
    expect(s).toHaveLength(2);
    expect(s[0]?.text.endsWith('SELECT 1')).toBe(true);
    expect(s[1]?.text.endsWith('SELECT 2')).toBe(true);
  });

  it('drops a comment-only trailing segment', () => {
    expect(splitStatement('SELECT 1;\n-- done\n')).toHaveLength(1);
    expect(splitStatement('   \n  ')).toHaveLength(0);
  });

  it('reports offsets and 1-based line numbers', () => {
    const sql = 'SELECT 1;\nSELECT 2;';
    const s = splitStatement(sql);
    expect(s[0]).toMatchObject({ start: 0, end: 8, line: 1 });
    expect(s[1]?.line).toBe(2);
    expect(sql.slice(s[1]!.start, s[1]!.end)).toBe('SELECT 2');
  });

  it('keeps an unterminated dollar quote as one statement', () => {
    const s = splitStatement('CREATE FUNCTION f() AS $$ BEGIN; SELECT 1;');
    expect(s).toHaveLength(1);
  });

  it('strips comments without touching literals', () => {
    expect(stripComment(`SELECT '-- not a comment' -- yes a comment`).trim()).toBe(
      `SELECT '-- not a comment'`,
    );
  });
});

describe('classifyStatement', () => {
  it('classifies the plain cases', () => {
    expect(classifyStatement('SELECT * FROM t')).toBe('read');
    expect(classifyStatement('  \n  select 1')).toBe('read');
    expect(classifyStatement('INSERT INTO t VALUES (1)')).toBe('write');
    expect(classifyStatement('UPDATE t SET a = 1')).toBe('write');
    expect(classifyStatement('DELETE FROM t')).toBe('write');
    expect(classifyStatement('TRUNCATE t')).toBe('write');
    expect(classifyStatement('CREATE TABLE t (a int)')).toBe('ddl');
    expect(classifyStatement('ALTER TABLE t ADD COLUMN b int')).toBe('ddl');
    expect(classifyStatement('GRANT SELECT ON t TO r')).toBe('ddl');
    expect(classifyStatement('WOMBAT t')).toBe('unknown');
    expect(classifyStatement('')).toBe('unknown');
  });

  it('sees through a leading comment', () => {
    expect(classifyStatement('/* header */ -- note\nDELETE FROM t')).toBe('write');
  });

  it('calls a data-modifying CTE a write, not a read', () => {
    expect(
      classifyStatement('WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d'),
    ).toBe('write');
    expect(classifyStatement('WITH x AS (SELECT 1) SELECT * FROM x')).toBe('read');
  });

  it('knows EXPLAIN ANALYZE executes and plain EXPLAIN does not', () => {
    expect(classifyStatement('EXPLAIN DELETE FROM t')).toBe('read');
    expect(classifyStatement('EXPLAIN ANALYZE DELETE FROM t')).toBe('write');
    expect(classifyStatement('EXPLAIN (ANALYZE, BUFFERS) INSERT INTO t VALUES (1)')).toBe('write');
  });

  it('calls SELECT ... INTO a schema change', () => {
    expect(classifyStatement('SELECT * INTO backup FROM t')).toBe('ddl');
  });
});

// -----------------------------------------------------------------------------
// 7. Introspection — including the cartesian-product regression
// -----------------------------------------------------------------------------

describe('introspection queries', () => {
  it('reads foreign keys from pg_constraint with paired unnest, not information_schema', () => {
    const q = INTROSPECTION_QUERY.foreignKey;
    // The regression this guards: an information_schema join pairs every
    // referencing column with every referenced column.
    // `information_schema` appears only in the system-schema exclusion list;
    // no information_schema RELATION is joined.
    expect(q).not.toContain('information_schema.');
    expect(q).not.toContain('key_column_usage');
    expect(q).not.toContain('constraint_column_usage');
    expect(q).toContain('pg_constraint');
    expect(q).toContain('unnest(con.conkey, con.confkey) WITH ORDINALITY');
    // Both column lists must be aggregated in the SAME ordinality order.
    expect(q).toContain('array_agg(la.attname ORDER BY k.ordinality)');
    expect(q).toContain('array_agg(ra.attname ORDER BY k.ordinality)');
  });

  it('filters system schemas out of every query', () => {
    for (const sql of Object.values(INTROSPECTION_QUERY)) {
      expect(sql).toContain("n.nspname NOT IN ('pg_catalog','information_schema','pg_toast')");
    }
  });

  it('assembles a composite foreign key with 2 columns, not 4', () => {
    // The exact shape pg_constraint returns for a 2-column FK: ONE row with
    // two paired arrays. The information_schema form would produce four rows
    // claiming four column pairings, only two of which are real.
    const built = assembleSchema({
      schema: [{ schema_name: 'public' }],
      relation: [
        { schema_name: 'public', table_name: 'child', relkind: 'r', rls_enabled: false, estimated_row_count: 3, table_comment: null, view_definition: null },
      ],
      column: [
        { schema_name: 'public', table_name: 'child', column_name: 'a', ordinal_position: 1, data_type: 'uuid', is_nullable: false, default_expression: null, identity_kind: '', generated_expression: null, column_comment: null, enum_type_name: null, character_maximum_length: null, numeric_precision: null, numeric_scale: null },
        { schema_name: 'public', table_name: 'child', column_name: 'b', ordinal_position: 2, data_type: 'uuid', is_nullable: false, default_expression: null, identity_kind: '', generated_expression: null, column_comment: null, enum_type_name: null, character_maximum_length: null, numeric_precision: null, numeric_scale: null },
      ],
      keyConstraint: [],
      checkConstraint: [],
      foreignKey: [
        {
          schema_name: 'public',
          table_name: 'child',
          constraint_name: 'child_parent_fkey',
          referenced_schema: 'public',
          referenced_table: 'parent',
          on_delete: 'c',
          on_update: 'a',
          column_name: '{a,b}',
          referenced_column: '{x,y}',
        },
      ],
      index: [],
      trigger: [],
      policy: [],
      enumType: [],
      sequence: [],
    });
    const fk = built.table[0]?.foreignKey ?? [];
    expect(fk).toHaveLength(1);
    expect(fk[0]?.column).toEqual(['a', 'b']);
    expect(fk[0]?.referencedColumn).toEqual(['x', 'y']);
    expect(fk[0]?.onDelete).toBe('cascade');
    expect(fk[0]?.onUpdate).toBe('no action');
  });

  it('rejects a row whose column lists cannot be paired — the cartesian bug, loudly', () => {
    expect(() =>
      assembleSchema({
        schema: [],
        relation: [
          { schema_name: 'public', table_name: 'child', relkind: 'r', rls_enabled: false, estimated_row_count: 0, table_comment: null, view_definition: null },
        ],
        column: [],
        keyConstraint: [],
        checkConstraint: [],
        foreignKey: [
          {
            schema_name: 'public',
            table_name: 'child',
            constraint_name: 'bogus',
            referenced_schema: 'public',
            referenced_table: 'parent',
            on_delete: 'a',
            on_update: 'a',
            // What the information_schema join yields: 4 pairings for a
            // 2-column key.
            column_name: '{a,a,b,b}',
            referenced_column: '{x,y}',
          },
        ],
        index: [],
        trigger: [],
        policy: [],
        enumType: [],
        sequence: [],
      }),
    ).toThrow(/cartesian product/);
  });

  it('parses a Postgres array literal whether or not the driver did', () => {
    expect(stringArray('{a,b}')).toEqual(['a', 'b']);
    expect(stringArray('{}')).toEqual([]);
    expect(stringArray('{"a,b",c}')).toEqual(['a,b', 'c']);
    expect(stringArray(['a', 'b'])).toEqual(['a', 'b']);
    expect(stringArray(null)).toEqual([]);
  });

  it('runs every query through the injected queryable and assembles a schema', async () => {
    const seen: string[] = [];
    const fake: PostgresQueryable = {
      query(sql, param) {
        seen.push(sql);
        expect(param).toEqual([['public']]);
        if (sql === INTROSPECTION_QUERY.schema) return [{ schema_name: 'public' }];
        if (sql === INTROSPECTION_QUERY.relation) {
          return [
            { schema_name: 'public', table_name: 'user', relkind: 'r', rls_enabled: true, estimated_row_count: 42.7, table_comment: 'people', view_definition: null },
            { schema_name: 'public', table_name: 'user_view', relkind: 'v', rls_enabled: false, estimated_row_count: 0, table_comment: null, view_definition: 'SELECT 1' },
          ];
        }
        if (sql === INTROSPECTION_QUERY.column) {
          return [
            { schema_name: 'public', table_name: 'user', column_name: 'id', ordinal_position: 1, data_type: 'bigint', is_nullable: false, default_expression: null, identity_kind: 'a', generated_expression: null, column_comment: null, enum_type_name: null, character_maximum_length: null, numeric_precision: 64, numeric_scale: 0 },
            { schema_name: 'public', table_name: 'user', column_name: 'name', ordinal_position: 2, data_type: 'text', is_nullable: true, default_expression: "'x'::text", identity_kind: '', generated_expression: null, column_comment: 'the name', enum_type_name: null, character_maximum_length: null, numeric_precision: null, numeric_scale: null },
          ];
        }
        if (sql === INTROSPECTION_QUERY.keyConstraint) {
          return [{ schema_name: 'public', table_name: 'user', constraint_name: 'user_pkey', constraint_type: 'p', is_deferrable: false, column_name: '{id}' }];
        }
        if (sql === INTROSPECTION_QUERY.checkConstraint) {
          return [{ schema_name: 'public', table_name: 'user', constraint_name: 'user_name_check', definition: 'CHECK ((length(name) > 0))' }];
        }
        if (sql === INTROSPECTION_QUERY.index) {
          return [{ schema_name: 'public', table_name: 'user', index_name: 'user_pkey', method: 'btree', is_unique: true, is_primary: true, definition: 'CREATE UNIQUE INDEX user_pkey ON public."user" USING btree (id)', predicate: null, column_name: '{id}', expression: null }];
        }
        if (sql === INTROSPECTION_QUERY.trigger) {
          // tgtype 23 = ROW(1) | BEFORE(2) | INSERT(4) | UPDATE(16)
          return [{ schema_name: 'public', table_name: 'user', trigger_name: 'bump', trigger_type: 23, enabled: 'O', function_name: 'bump_fn', definition: 'CREATE TRIGGER bump ...' }];
        }
        if (sql === INTROSPECTION_QUERY.policy) {
          return [{ schema_name: 'public', table_name: 'user', policy_name: 'own', command: 'r', is_permissive: true, role_name: '{authenticated}', using_expression: 'id = auth.uid()', with_check_expression: null }];
        }
        if (sql === INTROSPECTION_QUERY.enumType) {
          return [{ schema_name: 'public', type_name: 'mood', label: '{ok,great}' }];
        }
        if (sql === INTROSPECTION_QUERY.sequence) {
          return [{ schema_name: 'public', sequence_name: 'user_id_seq', data_type: 'bigint', start_value: '1', increment_by: '1', min_value: '1', max_value: '9223372036854775807', is_cycled: false, owned_by_table: 'user', owned_by_column: 'id' }];
        }
        return [];
      },
    };

    const db = await introspectDatabase(fake, { schemaName: ['public'] });
    expect(seen).toHaveLength(Object.keys(INTROSPECTION_QUERY).length);
    expect(db.schemaName).toEqual(['public']);
    expect(db.view.map((v) => v.name)).toEqual(['user_view']);
    expect(db.table.map((t) => t.name)).toEqual(['user']);

    const user = findTable(db, { schema: 'public', name: 'user' })!;
    expect(tableKey(user)).toBe('public.user');
    expect(user.isRlsEnabled).toBe(true);
    expect(user.comment).toBe('people');
    expect(user.estimatedRowCount).toBe(43);
    expect(user.primaryKey).toEqual({ name: 'user_pkey', column: ['id'] });
    // The CHECK wrapper is stripped so the body round-trips through addCheck.
    expect(user.checkConstraint[0]?.expression).toBe('(length(name) > 0)');
    expect(user.trigger[0]).toMatchObject({
      timing: 'before',
      orientation: 'row',
      event: ['insert', 'update'],
      isEnabled: true,
    });
    expect(user.policy[0]).toMatchObject({ command: 'select', role: ['authenticated'] });
    expect(user.index[0]?.isPrimary).toBe(true);

    const id = findColumn(user, 'id')!;
    expect(id.identity).toBe('always');
    expect(id.columnType).toBe('int64');
    expect(findColumn(user, 'name')?.comment).toBe('the name');
    expect(findColumn(user, 'nope')).toBeNull();

    expect(db.enumType[0]).toEqual({ schema: 'public', name: 'mood', label: ['ok', 'great'] });
    expect(db.sequence[0]?.ownedByColumn).toBe('id');

    // And the whole thing round-trips into a plan against an empty database.
    const plan = planMigration({ schemaName: [], table: [], view: [], enumType: [], sequence: [] }, db);
    expect(plan.map((o) => o.kind)).toContain('createTable');
    expect(compileDdlBatch(plan).every((s) => s.sql.length > 0)).toBe(true);
  });
});
