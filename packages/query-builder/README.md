# @onegrid/query-builder

The headless model and edit algebra behind a visual query builder — the thing an
"Advanced filter" panel anchored on the column tool panel is a thin shell over.

It owns the query AST, the operator catalogue, validation, the immutable edit
operations, and — the point of the package — compilation to four targets:

| target | function | why |
| --- | --- | --- |
| oneGrid protocol | `toFilterModel` / `fromFilterModel` | drives **every existing oneGrid adapter for free** |
| SQL | `toSql(ast, dialect)` | `postgres` \| `mysql` \| `sqlite` \| `clickhouse`, always parameterised |
| MongoDB | `toMongo(ast)` | a filter document you hand straight to `find()` |
| a human | `describeQuery(ast, schema)` | the sentence a collapsed summary chip shows |

No rendering lives here. This repo keeps UI-framework code in the adapter
packages; a React/Vue/Svelte builder is a component that walks the AST, calls
`operatorForType` to fill its dropdown, calls an edit operation on click, and
paints `validateQuery`'s errors onto the nodes their paths address.

## Why it exists

A grid's per-column filter row can express "price > 10 AND name contains widget"
and nothing harder. The moment a user needs `(a OR b) AND NOT c` they leave the
grid and go write SQL. This package is the model that lets them stay — and
because it compiles to the protocol's own `FilterModel`, whatever they build
pushes down through the same adapter that was already serving the grid.

## Install

```sh
pnpm add @onegrid/query-builder
```

## Usage

```ts
import type { Schema } from '@onegrid/protocol';
import {
  addCondition,
  describeQuery,
  emptyQuery,
  operatorForType,
  toFilterModel,
  toSql,
  validateQuery,
  wrapInGroup,
} from '@onegrid/query-builder';

const schema: Schema = [
  { id: 'name', type: 'utf8', displayName: 'Name' },
  { id: 'price', type: 'float64', displayName: 'Price' },
  { id: 'created', type: 'timestamp', displayName: 'Created' },
];

// What a dropdown should offer for this column — derived from its type.
operatorForType('timestamp');
// → ['eq','neq','before','after','between','notBetween','inLast','inNext','isNull','isNotNull']

// Every edit returns a NEW tree; nothing is mutated.
let query = emptyQuery();
query = addCondition(query, [], {
  kind: 'condition',
  column: 'price',
  operator: 'gt',
  value: 100,
});
query = addCondition(query, [], {
  kind: 'condition',
  column: 'created',
  operator: 'inLast',
  value: 7,
  unit: 'day',
});
// Bracket the second condition and OR a text match into it.
query = wrapInGroup(query, [1], 'or');
query = addCondition(query, [1], {
  kind: 'condition',
  column: 'name',
  operator: 'contains',
  value: 'widget',
});

validateQuery(query, schema); // → [] — safe to compile

describeQuery(query, schema);
// → 'Price greater than 100 and (Created in the last 7 days or Name contains "widget")'

// Drives any oneGrid adapter, unchanged.
toFilterModel(query, { schema });

// Or query a database directly. Values NEVER appear in `text`.
const sql = toSql(query, 'postgres', { schema });
sql.text;
// '"price" > $1 AND ("created" BETWEEN $2 AND $3 OR LOWER("name") LIKE $4 ESCAPE \'!\')'
sql.param;
// [100, <Date>, <Date>, '%widget%']
```

## The AST

The root is always a `QueryGroup`, even when empty — a UI never has to
special-case "no query yet", and every node has a parent to be inserted into or
removed from.

```ts
type QueryNode = QueryGroup | QueryCondition;

interface QueryGroup {
  kind: 'group';
  operator: 'and' | 'or' | 'not';
  child: readonly QueryNode[];
}

interface QueryCondition {
  kind: 'condition';
  column: string;
  operator: QueryOperator;
  value?: unknown;              // scalar operand
  operand?: readonly unknown[]; // in/notIn, between/notBetween
  unit?: DateUnit;              // inLast/inNext
  caseSensitive?: boolean;
}
```

Nodes are addressed by **path** — the sequence of child indices from the root.
`[]` is the root, `[1, 0]` is the first child of the second child. Paths fall
straight out of the tree a renderer already walks, need no id bookkeeping across
an immutable edit, and give validation errors somewhere precise to point.

## Edit operations

All pure, all path-addressed, all returning a new root. Untouched subtrees keep
their identity, so `===` is a valid change check for a memoising renderer, and
undo is just keeping the previous root around.

`addCondition` · `addNode` · `removeNode` · `updateCondition` ·
`setGroupOperator` · `moveNode` · `wrapInGroup` · `ungroup`

`moveNode` rebases the destination after the removal, so dragging a node past
its own former position lands where the user dropped it; moving a group into its
own descendant throws rather than detaching the tree.

## Validation

`validateQuery(ast, schema)` returns **every** problem, not just the first,
each addressed at the node that caused it:

| code | meaning |
| --- | --- |
| `unknown-column` | no `ColumnSchema` with that id |
| `operator-not-allowed` | `operatorForType` would not have offered it |
| `value-not-coercible` | operand cannot be read as the column's type (`operandIndex` narrows to one chip) |
| `missing-value` | a scalar/duration operator with nothing to compare against |
| `wrong-operand-count` | empty `in` list, or a `between` without exactly two ends |
| `invalid-regex` | `matches` pattern does not compile |
| `invalid-unit` | `inLast`/`inNext` without a valid `DateUnit` |
| `empty-group` | a group with no children |

## Round-trip guarantee

Sixteen of the operators are spelled exactly as the protocol's
`ComparisonOperator`. For any AST where `isProtocolExpressible(ast)` holds,
`fromFilterModel(toFilterModel(ast))` deep-equals `ast`. The test suite asserts
this per-operator and over a nested tree.

The builder-only operators lower where they can — `before` → `lt`, `after` →
`gt`, `isTrue` → `eq true`, `inLast(n, unit)` → a resolved `between` — and
`matches` throws a path-addressed `QueryCompileError`, because the protocol has
no regex comparison. Compile it to SQL or Mongo instead.

## SQL notes

- **Values are never interpolated.** Only quoted identifiers, keywords and
  placeholders reach `text`. Asserted directly against quote- and
  `--`-bearing input across all four dialects.
- Placeholders are `$1…` (postgres), `?` (mysql, sqlite) and typed named
  `{p0:Int64}` (clickhouse). `SqlQuery.param` is positional; `SqlQuery.named`
  is the same values keyed `p0`, `p1`, … for ClickHouse's driver.
- LIKE metacharacters are escaped with `!` and an `ESCAPE '!'` clause, not a
  backslash — MySQL consumes backslash escapes inside string literals before
  LIKE ever sees them.
- ClickHouse uses its native `position` / `startsWith` / `endsWith` / `match`
  rather than LIKE, because it has no `ESCAPE` clause.
- `matches` emits `~*`/`~` on postgres, `REGEXP` on mysql and sqlite, `match()`
  on clickhouse. **SQLite has no built-in REGEXP function** — register one on
  the connection if you offer that operator.
- Relative dates resolve at compile time against `option.now` (default: the
  wall clock), so compilation is a pure function of `(ast, now)`.

## License

MIT
