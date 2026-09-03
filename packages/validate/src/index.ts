// =============================================================================
// @onegrid/validate
//
// Cross-cell, row-level and sheet-level validation. `@onegrid/core` already
// validates ONE cell against ONE column's validator; that covers "this must be
// a number between 1 and 100" and nothing else. The constraints that actually
// reject real spreadsheets are relational: `end_date > start_date`, `sku` is
// unique, `sum(allocation)` is 100 per department, `manager_id` names an
// employee that exists. This package adds those three scopes and composes onto
// core's per-cell contract rather than replacing it — a `CellRule` uses the
// same `{ ok }` result shape as `ColumnDef.validate`, and `toColumnValidator`
// hands a rule straight back to the grid.
//
// Design decisions worth stating, because each one is a road not taken:
//
//   INCREMENTAL, NOT RE-SCAN. Editing one cell in a 100k-row table must not
//   re-run a uniqueness check over 100k rows. Every rule declares the columns
//   it reads; those declarations become an invalidation graph — literally the
//   `DependencyGraph` from `@onegrid/formula`, the Adapton-style demand graph
//   the formula engine already maintains, rather than a second one written
//   here — and an edit revalidates only the rules that graph reaches. Sheet
//   rules go further: they are backed by an AGGREGATE, seeded once and then
//   advanced by O(1) deltas (a uniqueness index adjusted by one key, a running
//   sum adjusted by one difference). `stat().invocation` counts rule calls so
//   this is a measurable property, not a claim.
//
//   COUNTING INDEXES, NOT SETS. The uniqueness index tracks how many rows hold
//   each key and which ones. A `Set`-based index gets the delete-then-reinsert
//   case wrong — remove one of two duplicates and the survivor silently turns
//   valid — and it cannot be rolled back, which `checkCommit` requires.
//
//   CYCLES TERMINATE. Rules may read each other's verdicts via `dependsOn`,
//   which means adopters will eventually write a cycle. Rules are topologically
//   ordered, cycles are collapsed into groups, and each group runs under a real
//   numeric pass cap (`maxPass`, default 4). A cycle is reported with its path
//   — `a → b → a` — and evaluation stops. It never hangs.
//
//   STALE RESULTS ARE DISCARDED, NOT APPLIED. Async rules receive an
//   `AbortSignal`, a new run aborts the previous one, and every run accumulates
//   into a draft that is merged only if it is still the current run when it
//   finishes. A slow validator resolving after a fast one cannot repaint the
//   grid with an old answer — the same guarantee core makes in the cell editor.
//
//   SEVERITY IS SEPARATE FROM BLOCKING. `error | warning | info` says how loud
//   a diagnostic is; `blockCommit` says whether it rejects the edit. Errors
//   block and warnings do not, by default — but a rule can decouple them, which
//   is the only way to express a field that paints red and still lets the user
//   leave the cell.
// =============================================================================

/** @public Engine — create a validator over a rule set and a table. */
export { createValidator, CYCLE_RULE_ID } from './engine';

/** @public Diagnostic rollup and ordering helpers. */
export {
  summarize,
  compareDiagnostic,
  resolveSeverity,
  resolveBlockCommit,
} from './diagnostic';

/** @public The stock rule library. */
export {
  required,
  range,
  pattern,
  oneOf,
  compareColumn,
  unique,
  sumEquals,
  referentialIntegrity,
  rowCountBetween,
  UniqueIndex,
  isBlank,
  toNumber,
  compareValue,
  satisfies,
} from './rule';

/** @public Composition with `@onegrid/core`'s per-cell validator. */
export { toColumnValidator, fromColumnValidator } from './bridge';

/** @public Bridge types. */
export type {
  ColumnValidator,
  ColumnValidationContext,
  ColumnValidatorOptions,
} from './bridge';

/** @public The invalidation graph and the evaluation plan, for tooling. */
export { buildInvalidationGraph, planRule, columnNode, ruleNode, inputOf } from './graph';

/** @public Plan types. */
export type { RulePlan, RuleStage } from './graph';

/** @public The type surface. */
export type {
  CellRule,
  CellRuleContext,
  CommitDecision,
  CycleReport,
  Diagnostic,
  DiagnosticSummary,
  ResolvedChange,
  Rule,
  RuleScope,
  RowChange,
  RowRule,
  RowRuleContext,
  RowSnapshot,
  RowValidationResult,
  ScalarComparison,
  Severity,
  SheetAggregate,
  SheetFinding,
  SheetRule,
  SheetScan,
  SheetSource,
  ValidationPhase,
  ValidationReport,
  ValidationResult,
  Validator,
  ValidatorOptions,
  ValidatorStat,
} from './type';
