# @onegrid/prisma

Prisma adapter for oneGrid's server-side row model (SSRM). Compiles a
`BlockRequest` into the argument objects a Prisma Client delegate consumes —
`where`, `orderBy`, `cursor` + `take` + `skip: 1`, `select` — pushes grouping
down to `groupBy` with `_sum` / `_avg` / `_min` / `_max` / `_count`, derives a
oneGrid `Schema` from Prisma's DMMF, and bridges live changes into
`@onegrid/orm-sync`.

No npm dependency on `@prisma/client`.

## Why it exists

Two things go wrong when a grid talks to Prisma directly.

**Offset pagination.** Prisma's `skip` is SQL `OFFSET`: the database walks and
discards every skipped row, so scrolling to row 500 000 costs 500 000 rows of
work on every keystroke. This adapter paginates with `cursor` + `take` +
`skip: 1`, which re-anchors the scan on an indexed unique value, and uses
`take: -n` to serve the `before` direction without inverting the sort by hand.
`orderBy` always ends with the primary key, because Prisma's cursor is only
well-defined under a total ordering — with a tie at the anchor row, `skip: 1`
lands somewhere arbitrary inside the tie.

**`BigInt` and `Decimal`.** Prisma hands those to JavaScript as a native
`bigint` and a Decimal.js instance *precisely because* they do not fit a
double — large ids and money. Mapping them onto `float64` invites a renderer
to call `Number()` on them, which is a correctness bug that only appears on
the rows that matter. They map to `int64` and `decimal`, and
`normalizePrismaRow` serialises them as strings: `JSON.stringify` throws
outright on a bigint, and quietly emits `{"s":1,"e":2,"d":[…]}` for a Decimal.

## Install

```sh
pnpm add @onegrid/prisma @onegrid/protocol
```

## Quickstart

```ts
import { Prisma, PrismaClient } from '@prisma/client';
import {
  createPrismaDataSource,
  descriptorFromDmmf,
  schemaFromDmmf,
} from '@onegrid/prisma';

const prisma = new PrismaClient();

// Prisma ships its schema as runtime metadata — no code generation needed.
const model = Prisma.dmmf.datamodel.models.find((m) => m.name === 'Order')!;

const dataSource = createPrismaDataSource({
  // `PrismaDelegate` is six methods. Any generated delegate satisfies it.
  delegate: prisma.order,
  descriptor: descriptorFromDmmf(model),
  schema: schemaFromDmmf(model),
});

const block = await dataSource.fetchBlock({
  cursor: null,
  direction: 'after',
  limit: 200,
  sort: [
    { columnId: 'status', direction: 'asc' },
    { columnId: 'total', direction: 'desc' },
  ],
  filter: {
    type: 'logical',
    op: 'and',
    filters: [
      { type: 'comparison', columnId: 'status', op: 'in', values: ['active', 'shipped'] },
      { type: 'comparison', columnId: 'note', op: 'contains', value: 'urgent', caseSensitive: false },
    ],
  },
});

// Hand `block.nextCursor` straight back on the next fetch.
```

### Grouping

A request with `grouping` compiles to `groupBy`, so the rollup happens in SQL
and a group over 200 000 rows returns one row:

```ts
const grouped = await dataSource.fetchBlock({
  cursor: null,
  direction: 'after',
  limit: 100,
  sort: [],
  filter: null,
  grouping: { columns: ['status'], openKeys: [] },
  aggregations: [
    { columnId: 'total', fn: 'sum' },
    { columnId: 'total', fn: 'avg', alias: 'mean_total' },
  ],
});
// [{ status: 'active', __count__: 200000, sum_total: '9990000000', mean_total: 49.5 }, …]
```

Prisma answers with nested aggregate buckets (`{ _sum: { total } }`); the
adapter flattens them into the protocol's one-row-per-group shape with
`__count__`. `countDistinct` throws rather than silently answering a different
question — Prisma's `groupBy` has no distinct-count aggregate, so that column
needs `$queryRaw`.

### Writes

`mutate` is implemented, because Prisma is the ORM people reach for when the
grid is editable. Optimistic concurrency (`UpdateMutation.expected`) is checked
with a read before the write: Prisma's `update` accepts only unique fields in
`where`, so a non-unique guard column cannot go there, and `updateMany` reports
a count instead of the row a conflict response has to carry.

### Live sync

Prisma Client has no change feed — the removed `$subscribe` preview only ever
worked against the Data Proxy. The default CDC adapter polls a monotonic
column (an `@updatedAt` field is free) through the same delegate, and the
bridge into `@onegrid/orm-sync` is a thin call into that package's
`bindOrmSync` rather than a second copy of its logic:

```ts
import { bindPrismaSync, createPrismaCdcAdapter, toOrmSyncModel } from '@onegrid/prisma';

const cdc = createPrismaCdcAdapter({
  delegate: prisma.order,
  watermarkField: 'updatedAt',
  primaryKey: 'id',
  createdField: 'createdAt',   // lets the poll distinguish insert from update
  softDeleteField: 'deletedAt',
});

const handle = bindPrismaSync<Order>({
  model: toOrmSyncModel(model),
  cdc,
  onDiff: (diff) => applyToCache(diff),  // diff.row is Partial<Order>
});
```

Adopters who want true logical-decoding CDC point `bindPrismaSync` at
`@onegrid/postgres`'s LISTEN/NOTIFY adapter instead — the `cdc` slot takes any
`CdcAdapter`, and `toOrmSyncModel` is what they still need either way.

## Licence

MIT.
