# @onegrid/snowflake

Snowflake adapter for oneGrid's server-side row model. Compiles a
`BlockRequest` into Snowflake SQL — double-quoted UPPER-CASE
identifiers, positional `?` binds, `QUALIFY` deduplication, keyset
pagination, aggregation pushdown — and ships a STREAM-backed CDC
adapter for live updates.

No driver dependency. `snowflake-sdk` is heavyweight and roughly half
of production Snowflake traffic goes over the SQL REST API or a
serverless proxy instead, so the adapter takes a one-method
`SnowflakeQueryable` that all three transports satisfy.

## Install

```sh
npm install @onegrid/snowflake
```

## Quickstart with `snowflake-sdk`

```ts
import snowflake from 'snowflake-sdk';
import {
  buildSnowflakeSchema,
  createSnowflakeDataSource,
  type SnowflakeStatement,
} from '@onegrid/snowflake';

const connection = snowflake.createConnection({
  account: process.env.SNOWFLAKE_ACCOUNT!,
  username: process.env.SNOWFLAKE_USER!,
  password: process.env.SNOWFLAKE_PASSWORD!,
  warehouse: 'ANALYTICS_WH',
});

const dataSource = createSnowflakeDataSource({
  client: {
    execute({ sql, bind }: SnowflakeStatement) {
      return new Promise((resolve, reject) => {
        connection.execute({
          sqlText: sql,
          binds: bind as snowflake.Binds,
          complete: (err, stmt, rows) =>
            err ? reject(err) : resolve({ row: rows ?? [], queryId: stmt.getQueryId() }),
        });
      });
    },
  },
  table: {
    table: 'ANALYTICS.PUBLIC.ORDER',
    columns: ['id', 'status', 'amount', 'created_at'],
    primaryKey: 'id',
  },
  // Feed this from a DESCRIBE TABLE; the mapper is precision-aware.
  schema: buildSnowflakeSchema([
    { name: 'ID', type: 'NUMBER(38,0)', nullable: false },
    { name: 'STATUS', type: 'VARCHAR(64)' },
    { name: 'AMOUNT', type: 'NUMBER(12,2)' },
    { name: 'CREATED_AT', type: 'TIMESTAMP_LTZ(9)' },
  ], { sessionTimezone: 'UTC' }),
});
```

The generated first-block SQL:

```sql
SELECT "ID", "STATUS", "AMOUNT", "CREATED_AT"
FROM "ANALYTICS"."PUBLIC"."ORDER"
ORDER BY "ID" ASC LIMIT 100
```

## Why identifiers are upper-cased

Snowflake folds *unquoted* DDL identifiers to upper case but matches
*quoted* ones byte-for-byte. A table created as
`CREATE TABLE order (order_id NUMBER)` stores `ORDER_ID`, so emitting
`"order_id"` fails with "invalid identifier" — the single most common
Snowflake integration bug. The compiler resolves every descriptor
identifier to upper case before quoting. If your DDL used quoted
lower-case names, set `preserveCase: true` on the descriptor.

## Compiler differences vs `@onegrid/postgres`

| Concern | Postgres | Snowflake |
|---|---|---|
| Identifier quoting | `"col"` verbatim | `"COL"` (upper-cased first) |
| Placeholders | `$1`, `$2` | `?` positional, in emission order |
| Keyset predicate | `(a, b) > ($1, $2)` | expanded `a > ? OR (a = ? AND b > ?)` |
| `LIMIT` | `$n` bind | inlined integer (Snowflake won't bind it) |
| Case-insensitive `LIKE` | `LOWER()` wrap | `ILIKE` (native, stays prunable) |
| Latest-row-per-key | subquery | `QUALIFY ROW_NUMBER() … = 1` |

Snowflake has no row-value comparison, so the tuple form the Postgres
adapter uses is not available. The expanded chain is not a workaround
tax: it is also what makes **mixed-direction** multi-sort
(`status ASC, amount DESC`) paginate correctly, which the tuple form
cannot express at all.

`LIMIT` is the one clause that takes a caller-supplied number as
literal text, so it is validated as a non-negative safe integer before
it is inlined. Every identifier is checked against the descriptor's
`columns` allowlist first; values only ever travel as binds.

## Latest-row-per-key with `QUALIFY`

Warehouse tables are frequently append-only change logs. Rather than
making you wrap one in a view, put the dedup on the descriptor:

```ts
table: {
  table: 'ANALYTICS.PUBLIC.ORDER_EVENT',
  columns: ['id', 'status', 'amount', 'created_at'],
  primaryKey: 'id',
  dedupe: { partition: ['id'], recency: 'created_at' },
}
// …  QUALIFY ROW_NUMBER() OVER (PARTITION BY "ID" ORDER BY "CREATED_AT" DESC) = 1
```

## Type mapping

| Snowflake | oneGrid `ColumnType` |
|---|---|
| `NUMBER(p,0)`, p ≤ 9 | `int32` |
| `NUMBER(38,0)`, bare `NUMBER`, `BIGINT` | `int64` (BigInt-safe path) |
| `NUMBER(p,s)`, s > 0 | `decimal` (+ precision/scale) |
| `FLOAT` / `DOUBLE` / `REAL` | `float64` |
| `VARCHAR` / `STRING` / `TEXT` | `utf8` |
| `TIMESTAMP_NTZ` | `timestamp` |
| `TIMESTAMP_TZ` / `TIMESTAMP_LTZ` | `timestamp_tz` (+ timezone) |
| `VARIANT` | `json` |
| `OBJECT` | `map` |
| `ARRAY` | `list` |
| `GEOGRAPHY` / `GEOMETRY` | `json` (GeoJSON is the default output) |

`NUMBER(38,0)` is Snowflake's default integer and reaches 10^38, far
past float64's exact 2^53. It stays on the `int64` path, and the
DataSource stringifies a BigInt row id rather than calling `Number()`
on it — a rounded cursor silently skips or repeats rows forever. Use
`isBigIntSafeRequired(type)` to decide whether a column needs the same
treatment in your own code.

## CDC via STREAMs

```ts
import { createSnowflakeCdcAdapter, createStreamStatement } from '@onegrid/snowflake';

// One-time DDL (identifiers validated, so it is safe to template):
await client.execute(createStreamStatement({
  stream: 'ANALYTICS.PUBLIC.ORDER_STREAM',
  sourceTable: 'ANALYTICS.PUBLIC.ORDER',
  showInitialRow: true,
}));

const cdc = createSnowflakeCdcAdapter({
  client,
  stream: 'ANALYTICS.PUBLIC.ORDER_STREAM',
  primaryKey: 'id',
  pollIntervalMs: 1000,
});

const off = cdc.subscribe((diff) => applyToGrid(diff));
```

Each poll first asks `SYSTEM$STREAM_HAS_DATA`, which answers from
metadata without resuming the warehouse — an idle stream costs
essentially nothing. When there is data, the default
`consume: 'temp-table'` mode runs
`CREATE OR REPLACE TEMPORARY TABLE … AS SELECT * FROM <stream>`,
because a bare `SELECT` does **not** advance a stream's offset and
would re-deliver the same changes forever. `consume: 'peek'` keeps the
non-advancing read for dashboards and tests.

Snowflake represents an update as a `DELETE` row plus an `INSERT` row
sharing a `METADATA$ROW_ID`; the adapter drops the delete half and
emits one `kind: 'update'` diff. Versions are a monotonic in-memory
counter, so replay across a process restart needs a durable source —
pass `resyncQuery` for that. Without one, `resync` honestly answers
`snapshot: true` instead of returning an empty diff list the client
would read as "nothing changed".

## License

MIT
