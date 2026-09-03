# @onegrid/elasticsearch

Elasticsearch 8.x adapter for oneGrid's server-side row model (SSRM).
Compiles a `BlockRequest` into a literal `_search` body — `query.bool` from
the filter model, a `sort` array with a guaranteed tiebreaker, `search_after`
keyset pagination, `composite`/`terms` aggregation pushdown — and translates
an index mapping into a oneGrid `Schema`.

No npm dependency on `@elastic/*`. The transport is a one-method injectable
you wire to the official client, an API-gateway route, or a fake.

## Why it exists

Elasticsearch is the database people reach for when they have more rows than
Postgres wants to scan and they also need relevance search. Both halves are
easy to get wrong from a grid:

- **Deep paging.** `from`/`size` makes every shard sort `from + size` hits and
  discard all but the last page. That is why `index.max_result_window` defaults
  to 10 000, and it is exactly the workload an infinitely-scrolling grid
  generates. This adapter never emits `from`. Every block is a `search_after`
  continuation, and every sort carries a tiebreaker (`_shard_doc` under a
  point-in-time, the descriptor's primary key otherwise) because ES sorts are
  not stable without one.
- **Full-text as an afterthought.** oneGrid's protocol filter operators are
  SQL-shaped. This adapter widens them with `match`, `match_phrase`,
  `multi_match` and `query_string` as first-class filter nodes, so the grid's
  filter model can express the thing you bought Elasticsearch for. The widening
  is additive — a plain protocol `FilterModel` compiles unchanged.

## Install

```sh
pnpm add @onegrid/elasticsearch @onegrid/protocol
```

## Quickstart

```ts
import { Client } from '@elastic/elasticsearch';
import {
  createElasticsearchDataSource,
  createElasticsearchCdcAdapter,
  descriptorFromMapping,
  mappingToSchema,
  type ElasticsearchQueryable,
} from '@onegrid/elasticsearch';

const es = new Client({ node: process.env.ES_URL! });

// The whole transport contract. Adapt whatever client you already have.
const client: ElasticsearchQueryable = {
  search: (req) =>
    es.search({
      ...(req.index ? { index: req.index } : {}),
      ...req.body,
    }) as Promise<never>,
};

// One `_mapping` call at boot gives you both the Schema and the field
// whitelist, so no hand-maintained field list can drift from the index.
const raw = await es.indices.getMapping({ index: 'order' });
const mapping = raw.order!.mappings;

const dataSource = createElasticsearchDataSource({
  client,
  descriptor: descriptorFromMapping('order', mapping, 'order_id'),
  schema: mappingToSchema(mapping),
  // Pin the segments for the life of a scroll session; also upgrades the
  // keyset tiebreaker to `_shard_doc`.
  // pointInTime: { id: pitId, keepAlive: '2m' },
});

const block = await dataSource.fetchBlock({
  cursor: null,
  direction: 'after',
  limit: 200,
  sort: [{ columnId: 'amount', direction: 'desc' }],
  filter: {
    type: 'logical',
    op: 'and',
    filters: [
      { type: 'comparison', columnId: 'status', op: 'in', values: ['active', 'shipped'] },
      // Full-text, alongside the exact-term operators.
      { type: 'text', columnId: ['title', 'note'], op: 'multiMatch', query: 'late delivery' },
    ],
  },
});

// `block.nextCursor` is an opaque string. Hand it straight back on the next
// fetch — it carries the `search_after` payload.
```

### Grouping

A `BlockRequest` with `grouping` compiles to a `composite` aggregation with
metric sub-aggregations and comes back as one row per group, keyed by the
group columns plus the protocol's `__count__`:

```ts
const grouped = await dataSource.fetchBlock({
  cursor: null,
  direction: 'after',
  limit: 100,
  sort: [],
  filter: null,
  grouping: { columns: ['status'], openKeys: [] },
  aggregations: [
    { columnId: 'amount', fn: 'sum' },
    { columnId: 'customer', fn: 'countDistinct' },
  ],
});
// [{ status: 'active', __count__: 200000, sum_amount: 9.99e9, countDistinct_customer: 4102 }, …]
```

`nextCursor` on a grouped block carries the composite `after_key`, so grouped
blocks paginate through the same opaque cursor slot as flat ones.

### Live updates

Elasticsearch has no change stream — no logical replication slot, no oplog.
The correct implementation is polling a monotonic watermark, and this adapter
says so rather than pretending otherwise:

```ts
const cdc = createElasticsearchCdcAdapter({
  client,
  index: 'order',
  watermarkField: '@timestamp',
  primaryKey: 'order_id',
  createdField: 'created_at',   // lets the poll tell insert from update
  softDeleteField: 'deleted',   // the only deletes a poll can observe
  pollIntervalMs: 1000,
});

const off = cdc.subscribe((diff) => applyToCache(diff));
```

The adapter matches `CdcAdapter` from `@onegrid/ssrm` structurally, so it
drops into `RowDiffStream` and `bindOrmSync` with no shim.

## Mapping translation

`mappingToSchema` walks the mapping tree. `long` → `int64` and
`unsigned_long` → `uint64` deliberately stay off the `float64` path, because
mapping them there loses precision above 2^53 — the exact shape of a Snowflake
id or a Kafka offset. `object`, `nested` and `geo_point` become `struct`
columns with children; `mappingToNestedPath` tells you which containers are
genuinely `nested` and therefore need a `nested` query to address.

## Licence

MIT.
