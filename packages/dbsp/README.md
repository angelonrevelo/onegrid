# @onegrid/dbsp

Differential dataflow / DBSP operator algebra. Incremental view
maintenance — when a single row arrives via CDC, recompute group
totals, filtered counts, and pivot summaries in O(Δ) time instead
of O(N).

Reference implementation of [docs/dbsp-spec.md](../../docs/dbsp-spec.md).

## Operators

| Operator      | applyDiff cost          | Spec § |
| ------------- | ----------------------- | ------ |
| `source`      | O(\|Δ\|)                | 2.1    |
| `map`         | O(\|Δ\|)                | 2.1    |
| `filter`      | O(\|Δ\|)                | 2.2    |
| `union`       | O(\|Δ\|)                | 2.3    |
| `distinct`    | O(\|Δ\|)                | 2.4    |
| `groupAgg`    | O(\|Δ\| · #aggs)        | 2.5    |
| `topK` (sort) | O(N log K) baseline     | 2.8    |

Full join (delta-join with indexed state on both sides) and full
sort with red-black tree are scheduled for v0.0.10.x.

## Quickstart

```ts
import { Pipeline, createSource, createFilter, createGroupAgg } from '@onegrid/dbsp';

const pipeline = new Pipeline([
  createSource(),
  createFilter((r) => Number(r.amount) >= 100),
  createGroupAgg(['region'], [
    { out: 'total', src: 'amount', kind: 'sum' },
    { out: 'n', kind: 'count' },
  ]),
]);

// CDC diff arrives — pipeline updates group totals incrementally.
pipeline.step({
  entries: [
    { key: 'r1', row: { region: 'us', amount: 200 }, weight: 1 },
  ],
});
```

## Derived views — `defineView`

`defineView` is the public API over the operator algebra: it compiles
`{ from, where, groupBy, agg }` into an operator chain and returns a live
handle that satisfies `@onegrid/core`'s `RowSource` (`numRows` + `getCell`),
so it can be handed straight to a `Grid`.

```ts
import { createTable, defineView } from '@onegrid/dbsp';

const sale = createTable({ key: 'id' });
sale.load([
  { id: 1, region: 'EMEA', channel: 'web', amount: 10 },
  { id: 2, region: 'AMER', channel: 'web', amount: 30 },
]);

const byRegion = defineView({
  from: sale,
  where: (r) => Number(r.amount) > 0,
  groupBy: ['region'],
  agg: [
    { out: 'total', src: 'amount', kind: 'sum' },
    { out: 'n', kind: 'count' },
  ],
});

byRegion.subscribe((diff) => {
  // Protocol `RowDiff[]` — the same envelope a live server change stream uses.
  for (const d of diff) console.log(d.version, d.kind, d.pkey, d.fields);
});

// One row moves between groups: EMEA is debited, AMER credited, and the
// operator chain sees exactly two Z-set entries — not the whole base table.
sale.apply({ kind: 'update', pkey: 1, fields: { region: 'AMER' } });

byRegion.numRows;                 // 1 — the emptied EMEA group is gone
byRegion.getCell(0, 'total');     // 40
byRegion.stat.rowInCount;         // bounded by the delta, not by numRows
```

A view is itself a `ViewSource`, so views compose and changes propagate
transitively:

```ts
const big = defineView({ from: byRegion, where: (r) => Number(r.total) > 25 });
```

`view.stat` (`operatorCallCount` / `rowInCount` / `rowOutCount`) is live
instrumentation: it makes the O(Δ) claim measurable rather than asserted, and
the test suite pins it against a 10 000-row base with a one-row change.

## Property: incrementalization theorem

For each operator `f` in §2 of the spec:

```
↑f^Δ ≡ D ∘ ↑f ∘ ∫
```

— applying `f` incrementally to a diff stream produces the same
output as snapshotting, applying `f`, and differentiating back.
The test suite verifies this for every operator on synthesized
random diff streams.

## License

MIT
