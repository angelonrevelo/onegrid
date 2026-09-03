# @onegrid/studio

A **headless Postgres table editor**. Everything the Supabase table editor,
pgAdmin, TablePlus, Prisma Studio or a Retool database resource does to a
database — modelled as plain data and pure functions, with no rendering and no
database driver.

A separate package owns the React surface. This one owns the logic that surface
needs in order to be correct: rich schema introspection, DDL compilation, row
DML, foreign-key intelligence, migration planning with risk assessment, and a
SQL statement splitter that survives dollar-quoted function bodies.

## Why it exists

Every database GUI re-implements the same six things, and every one of them
gets at least one of them subtly wrong. This package is those six things,
written once, tested hard, and separated from the pixels:

| Capability | What it gives you |
| --- | --- |
| **Introspection** | `introspectDatabase(queryable)` → a `DatabaseSchema` with columns, keys, unique + check constraints, foreign keys, indexes (partial and expression), enums, views, materialised views, sequences, triggers and RLS policies. |
| **DDL compilation** | A 31-member `DdlOperation` union and `compileDdl(op)` → one correctly-quoted Postgres statement. |
| **Row DML** | `insertRow` / `updateRow` / `deleteRow` / `duplicateRow` / `bulkDelete`, parameterised, compound-primary-key-aware, always `RETURNING *`. |
| **Relationships** | The FK graph in both directions, a display-column heuristic, the query behind an FK value picker, and PostgREST-style embedded joins. |
| **Migration safety** | `planMigration(current, target)`, `assessRisk(op)` → `safe \| lossy \| blocking` with a reason, and `reverseOperation(op)` → the down-migration or an honest `null`. |
| **SQL editor** | `splitStatement(script)` that handles `$$ … $$`, `$tag$ … $tag$`, E-strings, quoted identifiers and *nested* block comments; `classifyStatement(sql)` → `read \| write \| ddl \| unknown`. |

## Install

```sh
pnpm add @onegrid/studio
```

No runtime dependency beyond the oneGrid workspace. **No database driver** —
you supply a `PostgresQueryable`, exactly as `@onegrid/sqlite` takes a
`SqliteQueryable`:

```ts
import type { PostgresQueryable } from '@onegrid/studio';
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const queryable: PostgresQueryable = {
  query: (sql, param) => pool.query(sql, param ? [...param] : []).then((r) => r.rows),
};
```

## Usage

### Introspect, then edit a row

```ts
import {
  introspectDatabase,
  findTable,
  buildRowDefault,
  insertRow,
  updateRow,
} from '@onegrid/studio';

const schema = await introspectDatabase(queryable, { schemaName: ['public'] });
const post = findTable(schema, { schema: 'public', name: 'post' })!;

// What an "add row" form starts from. Identity and function-default columns
// are marked database-generated and left out of `value` entirely.
const { field, value } = buildRowDefault(post);

const insert = insertRow(post, { ...value, title: 'Hello' });
// INSERT INTO "public"."post" ("status", "title") VALUES ($1, $2) RETURNING *
await queryable.query(insert.sql, insert.param);

// Compound primary keys work; a missing key column throws rather than
// silently rewriting the wrong rows.
const update = updateRow(post, { id: 7 }, { title: 'Hello again' });
```

### Compile a schema change, and check it first

```ts
import { compileDdl, assessRisk, reverseOperation } from '@onegrid/studio';

const op = {
  kind: 'addColumn',
  schema: 'public',
  table: 'post',
  column: { name: 'slug', type: 'text', isNullable: false },
} as const;

assessRisk(op, { estimatedRowCount: post.estimatedRowCount });
// { level: 'blocking',
//   reason: 'Adding a NOT NULL column with no default to a populated table
//            fails outright — every existing row would violate it. …',
//   isReversible: true }

compileDdl(op).sql;
// ALTER TABLE "public"."post" ADD COLUMN "slug" text NOT NULL

reverseOperation(op);
// { kind: 'dropColumn', schema: 'public', table: 'post', column: 'slug', ifExists: true }
```

### Plan a migration between two schemas

```ts
import { planMigration, assessMigration, highestRisk, compileDdlBatch } from '@onegrid/studio';

const plan = planMigration(current, target);
const assessed = assessMigration(plan, current);

if (highestRisk(assessed) !== 'safe') {
  // show the review panel
}

for (const { sql } of compileDdlBatch(plan)) await queryable.query(sql);
```

Operations are emitted in fixed phases, so a foreign key is **always** created
after the table it references — including across a reference cycle, which a
topological sort alone cannot handle.

### Foreign-key picker and embedded joins

```ts
import { detectDisplayColumn, foreignKeyLookup, buildJoinQuery } from '@onegrid/studio';

detectDisplayColumn(user); // 'name' — never the uuid primary key

const q = foreignKeyLookup({ fk: post.foreignKey[0], referencedTable: user }, 'ali');
// SELECT "id" AS "value", "name" AS "label" FROM "public"."user"
//   WHERE "name"::text ILIKE $1 ORDER BY "name" LIMIT $2   ['%ali%', 20]

buildJoinQuery(schema, { schema: 'public', name: 'post' }, ['author']).sql;
// SELECT "t0".*, to_jsonb("t1".*) AS "author" FROM "public"."post" AS "t0"
//   LEFT JOIN "public"."user" AS "t1" ON "t0"."author_id" = "t1"."id" LIMIT $1
```

A one-to-many path compiles to a `LEFT JOIN LATERAL … jsonb_agg` instead, so
embedding children never multiplies the parent rows and `LIMIT` keeps meaning
what the UI thinks it means.

### Split and classify a SQL script

```ts
import { splitStatement, classifyStatement } from '@onegrid/studio';

splitStatement(`
  CREATE FUNCTION bump() RETURNS trigger AS $$
  BEGIN
    NEW.updated_at := now();
    RETURN NEW;
  END;
  $$ LANGUAGE plpgsql;
  SELECT 1;
`).length; // 2 — the semicolons inside $$ … $$ are not boundaries

classifyStatement('WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d'); // 'write'
classifyStatement('EXPLAIN ANALYZE DELETE FROM t');                        // 'write'
classifyStatement('EXPLAIN DELETE FROM t');                                // 'read'
```

## Two things worth knowing

**Foreign keys come from `pg_constraint`, never from `information_schema`.**
The usual `table_constraints ⋈ key_column_usage ⋈ constraint_column_usage`
join pairs every referencing column with every referenced column, so a
composite key yields a cartesian product of bogus edges. Measured on a real
database: **12,221 reported foreign keys across 113 tables, against 77 real
ones.** This package unnests `conkey` and `confkey` together `WITH ORDINALITY`,
which preserves the pairing by construction, and throws loudly if a row ever
arrives with mismatched list lengths.

**DDL carries no bind parameters, and that is not an oversight.** Postgres
refuses `$n` placeholders in utility statements, so every DDL literal is
escaped inline by `sqlLiteral` and every identifier by `sqlSafeIdentifier`,
which validates length and NUL bytes and doubles embedded quotes. `"; DROP
TABLE x; --` compiles to the single identifier `"""; DROP TABLE x; --"` — a
column with a silly name, not a statement boundary. DML *is* plannable, so it
uses real `$n` binds throughout.

## Licence

MIT
