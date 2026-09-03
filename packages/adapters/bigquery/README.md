# @onegrid/bigquery

BigQuery adapter for oneGrid's server-side row model. Compiles a
`BlockRequest` into GoogleSQL — backtick-qualified
`` `project.dataset.table` `` identifiers, typed `@named` query
parameters, partition- and cluster-aware predicate ordering, keyset
pagination, aggregation pushdown — and ships a polling CDC adapter over
an ingestion-time-partitioned outbox.

No client-library dependency. `@google-cloud/bigquery` drags in the
whole Google auth stack, and plenty of deployments reach BigQuery
through a proxy or the REST API instead, so the adapter takes a
one-method `BigQueryQueryable`.

## Install

```sh
npm install @onegrid/bigquery
```

## Quickstart with `@google-cloud/bigquery`

```ts
import { BigQuery } from '@google-cloud/bigquery';
import {
  buildBqSchema,
  buildColumnTypeMap,
  createBigQueryDataSource,
  type BigQueryJobRequest,
} from '@onegrid/bigquery';

const bq = new BigQuery({ projectId: 'acme-analytics' });

const field = [
  { name: 'id', type: 'INT64', mode: 'REQUIRED' },
  { name: 'status', type: 'STRING' },
  { name: 'amount', type: 'NUMERIC' },
  { name: 'event_date', type: 'DATE' },
  { name: 'customer_id', type: 'INT64' },
];

const dataSource = createBigQueryDataSource({
  client: {
    async query({ sql, params, paramType, location, maximumBytesBilled }: BigQueryJobRequest) {
      const [row] = await bq.query({
        query: sql,
        params,
        types: paramType,   // BigQuery rejects untyped parameters
        location,
        maximumBytesBilled,
      });
      return { row };
    },
  },
  table: {
    project: 'acme-analytics',
    dataset: 'warehouse',
    table: 'order',
    columns: field.map((f) => f.name),
    primaryKey: 'id',
    columnType: buildColumnTypeMap(field),
    partitionColumn: 'event_date',
    clusterColumn: ['customer_id', 'status'],
  },
  schema: buildBqSchema(field),
  location: 'US',
  // Set this. A grid should never be able to run a five-figure query
  // by scrolling.
  maximumBytesBilled: '10000000000',
});
```

The generated first-block SQL:

```sql
SELECT `id`, `status`, `amount`, `event_date`, `customer_id`
FROM `acme-analytics.warehouse.order`
ORDER BY `id` ASC LIMIT 100
```

## Bytes scanned is the budget

BigQuery bills by scan, so pruning is a first-class compiler output
rather than a hint.

**Predicate ordering.** The conjuncts of a top-level `AND` are
reordered — partition column first, then clustering columns in
declaration order (BigQuery only prunes blocks on a *prefix* of the
clustering key), then everything else. The reorder happens before
compilation, so parameter numbering follows the emitted text and `@p0`
is always the partition predicate's value:

```ts
// filter: amount > 100 AND event_date = '2026-01-01'
// WHERE (`event_date` = @p0 AND `amount` > @p1)
```

**`_PARTITIONTIME` pruning.** Ingestion-time-partitioned tables have no
real partition column, so the pseudo-column is the only handle:

```ts
createBigQueryDataSource({
  table: { /* … */ partitionPseudoColumn: '_PARTITIONTIME' },
  partitionFilter: { from: '2026-01-01T00:00:00Z', to: '2026-02-01T00:00:00Z' },
});
// WHERE _PARTITIONTIME >= TIMESTAMP(@p0) AND _PARTITIONTIME < TIMESTAMP(@p1) AND …
```

**Keyset, not OFFSET.** `OFFSET n` re-scans — and re-bills — every row
it skips, so scrolling gets quadratically more expensive. The adapter
pages by cursor throughout.

## Compiler differences vs `@onegrid/postgres`

| Concern | Postgres | BigQuery |
|---|---|---|
| Table identifier | `"schema"."table"` | `` `project.dataset.table` `` (one path) |
| Column identifier | `"col"` | `` `col` `` |
| Placeholders | `$1`, `$2` | `@p0`, `@p1` — with declared types |
| `IN` list | one placeholder per value | one `UNNEST(@p)` ARRAY parameter |
| Keyset predicate | `(a, b) > ($1, $2)` | expanded `a > @p0 OR (a = @p1 AND …)` |
| Case-insensitive `LIKE` | `LOWER()` wrap | `LOWER()` wrap (no `ILIKE` in GoogleSQL) |
| `LIMIT` | `$n` bind | inlined validated integer |

The table path is one backticked string on purpose: emitting
`` `project`.`dataset`.`table` `` makes BigQuery parse it as a field
access and reject the query.

GoogleSQL compares STRUCTs only for equality, so the tuple keyset form
is unavailable. The expanded chain is not a workaround tax — it is also
what makes **mixed-direction** multi-sort (`status ASC, amount DESC`)
paginate correctly.

## Injection guard

Every column identifier is checked against the descriptor's `columns`
allowlist before it is quoted; a backtick inside an identifier is
rejected outright rather than escaped (BigQuery forbids one anyway);
the project / dataset / table path is validated against BigQuery's
identifier grammar; and `LIMIT`'s row count must be a non-negative safe
integer before it is inlined. Values only ever travel as named
parameters.

## Type mapping

| BigQuery | oneGrid `ColumnType` |
|---|---|
| `INT64` / `INTEGER` | `int64` (BigInt-safe path) |
| `NUMERIC` | `decimal` (precision 38, scale 9) |
| `BIGNUMERIC` | `decimal` (precision 76, scale 38) |
| `FLOAT64` / `FLOAT` | `float64` |
| `BOOL` / `BOOLEAN` | `bool` |
| `STRING` | `utf8` |
| `BYTES` | `binary` |
| `DATE` / `TIME` | `date32` / `time64` |
| `DATETIME` | `timestamp` (civil) |
| `TIMESTAMP` | `timestamp_tz` (UTC) |
| `STRUCT` / `RECORD` | `struct` (+ children) |
| mode `REPEATED`, `ARRAY` | `list` (element type as child) |
| `JSON` | `json` |
| `GEOGRAPHY` | `utf8` (BigQuery renders WKT, not GeoJSON) |

Both vocabularies are accepted — the legacy REST names (`INTEGER`,
`FLOAT`, `BOOLEAN`, `RECORD`) and the GoogleSQL ones — because which
one you get depends on how the schema was fetched.

INT64 is BigQuery's *only* integer type, so **every** integer column
exceeds float64's exact range. Those columns map to `int64`, and the
DataSource stringifies BigInt and `BigQueryInt`-style `{ value }` row
ids rather than calling `Number()` on them: a rounded cursor silently
skips or repeats rows.

## CDC via a polling outbox

```ts
import { createBqCdcAdapter, createOutboxStatement } from '@onegrid/bigquery';

// One-time DDL — partitioned by ingestion time, which is what keeps
// polling cheap, plus optional auto-expiry so the outbox stays bounded.
await bq.query(createOutboxStatement({
  project: 'acme-analytics',
  dataset: 'warehouse',
  partitionExpirationDay: 7,
}));

const cdc = createBqCdcAdapter({
  client,
  project: 'acme-analytics',
  dataset: 'warehouse',
  pollIntervalMs: 2000,
  lookbackMs: 600_000,
});

const off = cdc.subscribe((diff) => applyToGrid(diff));
```

Your writers append `{ version, kind, pkey, fields }` rows on every
mutation; the adapter tails them by version. The poll query puts the
partition predicate first:

```sql
SELECT `version`, `kind`, `pkey`, `fields`
FROM `acme-analytics.warehouse.onegrid_outbox`
WHERE _PARTITIONTIME >= TIMESTAMP(@since) AND `version` > @fromVersion
ORDER BY `version` LIMIT 1000
```

Without that pseudo-column predicate the poll full-scans an
ever-growing outbox every two seconds — a query that gets more
expensive the longer the system runs. `lookbackMs` (default 10 minutes)
sets how far back the window reaches; it must comfortably exceed the
delay between a row being written and becoming queryable, since a
window that is too tight drops diffs permanently. An extra partition
scanned is cheap; a lost change is not.

`resync(fromVersion)` replays the same query and answers
`snapshot: true` when the gap exceeds `maxResyncDiffs` (default 10 000),
matching `@onegrid/mysql`'s contract exactly.

## License

MIT
