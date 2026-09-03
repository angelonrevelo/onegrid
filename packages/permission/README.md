# @onegrid/permission

Declarative row-level security and column permissions for oneGrid.

## The one thing to understand first

**The server is canonical. The client is cosmetic.**

A policy has two halves and they are not equals:

- **`compilePolicyFilter(policy, principal)`** is the enforcement boundary. It
  produces a `FilterModel` fragment — ordinary `@onegrid/protocol` filter nodes —
  that your adapter ANDs into **every** `BlockRequest` before it reaches the
  database. It becomes part of the `WHERE` clause the adapters already emit.
  There is no second filter language, and no path by which an excluded row is
  read out of the database.

- **`applyColumnPolicy` / `guardMutation`** are a user-experience layer. They
  exist so the grid does not offer a user an affordance the server would reject:
  a column they cannot read is not painted, a cell they cannot write does not
  open an editor, and an optimistic mutation that would be denied is refused
  before it is sent instead of being applied and rolled back a round-trip later.

**This client layer must never be the only enforcement.** It runs in a browser,
in code the user can edit, over data the user already has. Hiding a column means
not rendering it — if the server put the value in the response, the user has the
value. `guardMutation` returning `allowed: true` is a prediction, not an
authorisation. Run the same policy objects on the server, feed
`compilePolicyFilter` into your adapter, and re-check mutations there.

The package is deliberately isomorphic so that is cheap: the same `Policy`
values and the same functions run on both sides, and the client's prediction is
derived from the server's own rules rather than maintained beside them.

## Install

```sh
pnpm add @onegrid/permission
```

## Usage

```ts
import {
  definePolicy,
  compilePolicyFilter,
  applyColumnPolicy,
  guardMutation,
  andFilter,
  type Principal,
} from '@onegrid/permission';

const employeePolicy = definePolicy({
  resource: 'employee',
  role: ['analyst'],
  // Multi-tenancy: resolved per-principal at compile time into a plain
  // ComparisonFilter, so the adapter never learns what a principal is.
  attributeCondition: [{ columnId: 'tenant_id', attribute: 'tenant_id' }],
  columnRule: {
    name: 'write',
    salary: 'read',
    ssn: { access: 'masked', mask: 'last4' },
    internal_note: 'hidden',
  },
});

const principal: Principal = {
  id: 'u_42',
  role: ['analyst'],
  attribute: { tenant_id: 't_acme' },
};

// --- Server side: the canonical half -----------------------------------------
const guardedRequest = {
  ...request,
  filter: andFilter(request.filter, compilePolicyFilter(employeePolicy, principal)),
};
const response = await dataSource.fetchBlock(guardedRequest);

// --- Client side: the cosmetic half ------------------------------------------
const projection = applyColumnPolicy(schema, employeePolicy, principal);
projection.schema;          // `internal_note` is gone entirely
projection.writableColumn;  // ['name']
projection.maskCell('ssn', '123456789'); // '•••••6789'

const verdict = guardMutation(
  { kind: 'update', clientId: 'c1', rowId: 7, fields: { salary: 1 } },
  employeePolicy,
  principal,
);
// { allowed: false, reason: 'column-not-writable', columnId: 'salary', message: … }
```

### Role inheritance

```ts
const roleDefinition = [
  { name: 'admin', extend: ['manager'] },
  { name: 'manager', extend: ['analyst'] },
];

compilePolicyFilter(policySet, { id: 'u1', role: ['admin'] }, { roleDefinition });
```

Inheritance is a graph, not a tree, and it may contain cycles — human-edited
role hierarchies do. `expandRole` walks with a visited set and terminates on any
cycle rather than throwing, because a permission layer that crashes is a
permission layer that gets switched off.

## Conflict resolution: most-restrictive-wins

When several policies match one principal:

- Row filters are **ANDed** — an intersection, never a union.
- Column rules resolve on the lattice `write < read < masked < hidden`, taking
  the most restrictive.
- Mask strategies resolve to the one disclosing least: `last4 < hash < redact < null`.
- `allowInsert` / `allowDelete` are denied if **any** matching policy denies.

Adding a policy can therefore only ever remove access. That is the safe
direction: granting a second role by mistake narrows the view instead of
widening it.

## Fail closed

- A principal matching **no** policy gets `DENY_ALL_FILTER` and an empty visible
  column set.
- An `attributeCondition` whose principal attribute is missing denies the whole
  request rather than degrading into an unfiltered read.
- Columns with no explicit `columnRule` take `defaultColumnAccess`, which
  defaults to `'read'` — so nothing is writable unless a policy says so.

`DENY_ALL_FILTER` is `NOT (AND of nothing)`: structurally always-false under the
protocol's semantics, expressed purely in protocol nodes so no adapter needs a
special case, and naming **no column**, so it is safe to send on behalf of a
principal who is not allowed to know the schema.

## Mask strategies

| Strategy | Result for `'123456789'` | Use for |
| --- | --- | --- |
| `redact` | `'••••'` | anything that must not be seen at all |
| `last4` | `'•••••6789'` | card / account / SSN tails |
| `hash` | `'bb86b11c'` | equality must survive (grouping) but not plaintext |
| `null` | `null` | the value should look like missing data |

`hash` is FNV-1a — stable and dependency-free, not cryptographic and not claimed
to be. Anything that must resist inversion is masked server-side before the
value ever leaves the database.

## Exports

`definePolicy`, `compilePolicyFilter`, `applyColumnPolicy`, `guardMutation`,
`selectPolicy`, `expandRole`, `evaluateRowFilter`, `maskValue`, `andFilter`,
`isDenyAllFilter`, `DENY_ALL_FILTER`, `REDACTED_TOKEN`, plus the types
`Principal`, `RoleDefinition`, `Policy`, `PolicySpec`, `ColumnAccess`,
`ColumnRule`, `ColumnRuleObject`, `MaskStrategy`, `AttributeCondition`,
`PolicyEvaluationOption`, `ColumnPolicyResult`, `MutationGuardOption`,
`MutationGuardResult`, `MutationAllowed`, `MutationDenied`, `MutationDenyReason`.

MIT.
