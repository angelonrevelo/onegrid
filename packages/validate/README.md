# @onegrid/validate

Cross-cell, row-level and sheet-level validation for oneGrid. Composes onto the
per-cell validator already in `@onegrid/core` — it does not replace it.

## Why

`@onegrid/core` validates one cell against one column's validator. That covers
"this must be a number between 1 and 100" and nothing else. The constraints that
actually reject real spreadsheets are relational:

- `end_date` must be after `start_date` — needs the **row**.
- `sku` must be unique; `sum(allocation)` must be 100 per department;
  `manager_id` must name an employee that exists — needs the **sheet**.

Naively, every sheet-scope rule is a full scan, and every keystroke pays for it.
This package makes that incremental instead:

- Each rule declares the columns it reads. Those declarations become an
  invalidation graph — literally `DependencyGraph` from `@onegrid/formula`, the
  Adapton-style demand graph the formula engine already maintains. An edit
  revalidates only the rules that graph reaches.
- Sheet rules are backed by an **aggregate**: seeded once by a full scan, then
  advanced by O(1) deltas. A uniqueness index adjusts one key; a running sum
  adjusts by one difference. `stat().invocation` counts rule calls, so this is
  measurable rather than asserted — editing one cell in a 2000-row table invokes
  exactly one rule.
- Rules may read each other's verdicts (`dependsOn`). They are topologically
  ordered, and cycles are collapsed into groups that run under a real numeric
  pass cap (`maxPass`, default 4). A cycle is reported with its path —
  `a → b → a` — and evaluation stops. It never hangs.
- Async rules get an `AbortSignal`; a new run aborts the previous one and a
  superseded run's results are discarded rather than written. The same guarantee
  core makes in the cell editor.
- `error | warning | info` says how loud a diagnostic is. `blockCommit` says
  whether it rejects the edit. They are separate, so "paints red but still lets
  you leave the cell" is expressible.

## Install

```sh
pnpm add @onegrid/validate
```

## Usage

```ts
import {
  createValidator,
  required,
  compareColumn,
  unique,
  sumEquals,
  referentialIntegrity,
  summarize,
} from '@onegrid/validate';

const row = [
  { id: 'a', sku: 'X1', dept: 'eng', allocation: 60, start_date: '2026-01-01', end_date: '2026-06-01' },
  { id: 'b', sku: 'X1', dept: 'eng', allocation: 40, start_date: '2026-02-01', end_date: '2026-01-01' },
];

// Any `RowSource`-shaped object works, including a grid's own row source.
const source = {
  get numRows() {
    return row.length;
  },
  getCell: (rowIndex: number, columnId: string) => row[rowIndex]?.[columnId],
  getRowKey: (rowIndex: number) => String(row[rowIndex]?.id),
};

const validator = createValidator({
  source,
  rule: [
    required({ column: 'sku' }),
    compareColumn({ left: 'end_date', right: 'start_date', operator: '>' }),
    unique({ column: 'sku' }),
    sumEquals({ column: 'allocation', total: 100, groupBy: 'dept' }),
  ],
});

const report = await validator.validateAll();
summarize(report.diagnostic); // { error: 3, warning: 0, info: 0, total: 3, blocking: 3 }

// The renderer tints from this.
validator.diagnosticAt(1, 'end_date');

// The editor gates Enter on this — the edit has NOT been applied yet, and every
// aggregate is rolled back before the promise resolves.
const decision = await validator.checkCommit({
  type: 'update',
  rowIndex: 1,
  before: { sku: 'X1' },
  after: { sku: 'X2' },
});
if (decision.allowed) {
  row[1].sku = 'X2';
  await validator.applyChange({
    type: 'update',
    rowIndex: 1,
    before: { sku: 'X1' },
    after: { sku: 'X2' },
  });
}
```

## Composing onto the per-cell validator

A `CellRule` returns the same `{ ok }` shape as `ColumnDef.validate` in
`@onegrid/core`, so rules move across the boundary in either direction:

```ts
import { toColumnValidator, fromColumnValidator, required, pattern } from '@onegrid/validate';

// Hand stock rules to the grid's own editor pipeline (error bubble,
// aria-invalid, live-region announcement, AbortController — all core's).
const column = {
  id: 'sku',
  width: 120,
  validate: toColumnValidator([required({ column: 'sku' }), pattern({ column: 'sku', regexp: /^[A-Z]\d+$/ })]),
};

// Or pull a validator core already has into sheet-wide reporting.
const rule = fromColumnValidator({ id: 'legacy-sku', column: 'sku', validate: column.validate });
```

`info` is downgraded to `warning` on the way into core, which only knows
`error | warning`.

## Stock rules

| Rule | Scope | Checks |
| --- | --- | --- |
| `required` | cell | value is not blank |
| `range` | cell | numeric, within inclusive bounds |
| `pattern` | cell | matches a regexp (`g`/`y` flags stripped) |
| `oneOf` | cell | value is in an allowed set |
| `compareColumn` | row | `left <op> right` (numbers, dates, or strings) |
| `unique` | sheet | one column or a composite key is unique |
| `sumEquals` | sheet | column sums to a total, optionally per group |
| `referentialIntegrity` | sheet | every value appears in another column |
| `rowCountBetween` | sheet | table holds between `min` and `max` rows |

Blank never fails anything except `required`, and blank is never indexed for
uniqueness — SQL's rule.

## Writing a sheet rule

A sheet rule ships a `SheetAggregate`. `apply` must be exactly invertible:
`checkCommit` speculates by applying a change, diagnosing, and then applying the
inverse. Keep counts, not sets — a `Set`-based uniqueness index gets the
delete-then-reinsert case wrong (remove one of two duplicates and the survivor
silently turns valid) and cannot be rolled back.

```ts
const nonEmpty: SheetRule = {
  kind: 'sheet',
  id: 'at-least-one-active',
  input: ['status'],
  createAggregate: () => {
    let active = 0;
    return {
      seed: (scan) => {
        active = 0;
        for (let i = 0; i < scan.numRows; i += 1) {
          if (scan.getCell(i, 'status') === 'active') active += 1;
        }
      },
      apply: (change) => {
        if (change.before['status'] === 'active') active -= 1;
        if (change.after['status'] === 'active') active += 1;
      },
      diagnose: () => (active > 0 ? [] : [{ message: 'at least one row must be active' }]),
    };
  },
};
```

## Notes

- Supply `getRowKey` when rows can be inserted or deleted in the middle of the
  table. Diagnostics are held against stable keys and re-addressed to new row
  indices after a structural change; without a key the index *is* the identity.
- `checkCommit` and `applyChange` are not designed to overlap. The editor flow
  is check-then-apply, and speculative aggregate state lives only for the
  duration of a `checkCommit`.
- A speculative `insert` addresses a row the source does not hold yet, so pass
  `rowKey` explicitly for it.

## License

MIT
