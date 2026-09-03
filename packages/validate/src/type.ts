// =============================================================================
// @onegrid/validate — type surface
//
// Every type here is shaped so that a rule can be checked INCREMENTALLY. That
// constraint drives two decisions that look unusual at first glance:
//
//   1. Every rule declares the columns it reads (`column` for a cell rule,
//      `input` for row and sheet rules). Without a declared read-set there is
//      no dependency graph, and without a dependency graph a single cell edit
//      has to revalidate the whole sheet.
//   2. A sheet rule does not get a "look at the table and tell me what is
//      wrong" callback. It gets an AGGREGATE — a small stateful object seeded
//      once by a full scan and then advanced by O(1) deltas. A uniqueness rule
//      keeps a key index; a sum rule keeps a running total per group. The
//      engine never re-scans the table after seeding.
// =============================================================================

/**
 * Diagnostic severity. `error` rejects a commit by default, `warning` and
 * `info` permit it. See `blockCommit` on the rule for the override.
 */
export type Severity = 'error' | 'warning' | 'info';

/** Comparison operator for `compareColumn`. Spelled as JavaScript spells it. */
export type ScalarComparison = '<' | '<=' | '>' | '>=' | '===' | '!==';

/** Which slice of the table a rule (and therefore its diagnostic) addresses. */
export type RuleScope = 'cell' | 'row' | 'sheet';

/**
 * Phase a validation run is happening in — mirrors the `ValidationContext`
 * phase in `@onegrid/core` so a rule written for one is legible in the other.
 * `input` runs while the user types; `commit` runs when the edit is finalized.
 * Expensive async rules typically no-op on `input`.
 */
export type ValidationPhase = 'input' | 'commit';

/**
 * Result shape of a cell rule. Deliberately identical to `ValidationResult`
 * in `@onegrid/core` so an existing `ColumnDef.validate` function drops
 * straight into a `CellRule` and vice versa (see `toColumnValidator`).
 */
export type ValidationResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly message: string;
      readonly severity?: Severity;
    };

/** Result shape of a row rule — a cell result plus the columns it implicates. */
export type RowValidationResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly message: string;
      readonly severity?: Severity;
      /** Columns to tint. Defaults to the rule's declared `input`. */
      readonly column?: readonly string[];
    };

/** A row read as a plain record. Only declared input columns are populated. */
export type RowSnapshot = Readonly<Record<string, unknown>>;

/**
 * Random-access table reader. Structurally compatible with `RowSource` in
 * `@onegrid/core`, so a grid's row source can be handed to the validator
 * directly. `getRowKey` is the opt-in that makes structural edits exact: with
 * stable keys an insert or delete in the middle of the table does not
 * misattribute diagnostics to the rows that shifted.
 */
export interface SheetSource {
  readonly numRows: number;
  readonly getCell: (rowIndex: number, columnId: string) => unknown;
  /** Stable row identity. Defaults to the row index rendered as a string. */
  readonly getRowKey?: (rowIndex: number) => string;
}

/** The reader handed to `SheetAggregate.seed` — a source plus key resolution. */
export interface SheetScan {
  readonly numRows: number;
  readonly getCell: (rowIndex: number, columnId: string) => unknown;
  readonly rowKeyOf: (rowIndex: number) => string;
}

/**
 * A mutation the adopter reports to the validator. For `update` the adopter
 * has already written the new value to its store; `before` carries the old
 * values of the touched columns so aggregates can be adjusted by delta. For
 * `delete` the adopter must supply `before` (the engine can no longer read the
 * row). For `insert` the engine reads the new row from the source.
 */
export interface RowChange {
  readonly type: 'update' | 'insert' | 'delete';
  readonly rowIndex: number;
  /** Stable key. Defaults to the source's key for `rowIndex`. */
  readonly rowKey?: string;
  readonly before?: RowSnapshot;
  readonly after?: RowSnapshot;
  /** Touched columns. Defaults to the union of the `before`/`after` keys. */
  readonly column?: readonly string[];
}

/** A `RowChange` with every optional field filled in by the engine. */
export interface ResolvedChange {
  readonly type: 'update' | 'insert' | 'delete';
  readonly rowIndex: number;
  readonly rowKey: string;
  /** Every declared input column, at its pre-change value. `{}` for insert. */
  readonly before: RowSnapshot;
  /** Every declared input column, at its post-change value. `{}` for delete. */
  readonly after: RowSnapshot;
  readonly column: readonly string[];
}

/**
 * One problem found by one rule. `row` is the row index at diagnosis time and
 * `rowKey` is the stable identity; the renderer wants the former, an adopter
 * reconciling across a reorder wants the latter.
 */
export interface Diagnostic {
  readonly ruleId: string;
  readonly scope: RuleScope;
  readonly severity: Severity;
  readonly message: string;
  /** Row index, or null for a diagnostic that addresses the whole sheet. */
  readonly row: number | null;
  readonly rowKey: string | null;
  /** Implicated columns. Empty when the diagnostic is not column-specific. */
  readonly column: readonly string[];
  /** Group key for grouped aggregate rules (`sumEquals` per department). */
  readonly group: string | null;
  /** Whether this diagnostic rejects a commit. */
  readonly blockCommit: boolean;
}

/** Counts by severity, plus how many diagnostics would reject a commit. */
export interface DiagnosticSummary {
  readonly error: number;
  readonly warning: number;
  readonly info: number;
  readonly total: number;
  readonly blocking: number;
}

/** Context handed to a cell rule. */
export interface CellRuleContext {
  readonly rowIndex: number;
  readonly rowKey: string;
  readonly columnId: string;
  readonly phase: ValidationPhase;
  /** The whole row, restricted to columns some rule declared. */
  readonly row: RowSnapshot;
  /** Aborted when a newer validation run supersedes this one. */
  readonly signal: AbortSignal;
  /** Diagnostics currently held by another rule this rule `dependsOn`. */
  readonly diagnosticOf: (ruleId: string) => readonly Diagnostic[];
}

/** Context handed to a row rule. */
export interface RowRuleContext {
  readonly rowIndex: number;
  readonly rowKey: string;
  readonly phase: ValidationPhase;
  readonly signal: AbortSignal;
  readonly diagnosticOf: (ruleId: string) => readonly Diagnostic[];
}

/** A finding emitted by a sheet aggregate, before the engine addresses it. */
export interface SheetFinding {
  readonly message: string;
  readonly severity?: Severity;
  /** Stable key of the offending row, when the finding is row-specific. */
  readonly rowKey?: string;
  readonly column?: readonly string[];
  readonly group?: string;
}

/**
 * Incrementally maintained state behind a sheet rule. `seed` runs once over
 * the whole table; `apply` advances the state by one change in O(1); `diagnose`
 * reports from the maintained state without touching the table again.
 *
 * `apply` must be exactly invertible: the engine speculatively applies a
 * change during `checkCommit`, diagnoses, and then applies the inverse to roll
 * back. An aggregate that loses information on delete (the classic `Set`-based
 * uniqueness index) breaks both rollback and the delete-then-reinsert case.
 */
export interface SheetAggregate {
  readonly seed: (scan: SheetScan) => void;
  readonly apply: (change: ResolvedChange) => void;
  readonly diagnose: () => readonly SheetFinding[];
}

interface RuleCommon {
  readonly id: string;
  /** Severity of every diagnostic this rule emits. Default `error`. */
  readonly severity?: Severity;
  /** Override commit blocking. Default: true for `error`, false otherwise. */
  readonly blockCommit?: boolean;
  /**
   * Other rule ids this rule reads via `context.diagnosticOf`. Creates an
   * ordering edge: this rule runs after them. Cycles are detected, reported
   * with their path, and broken by the pass cap.
   */
  readonly dependsOn?: readonly string[];
}

/**
 * A per-cell rule. Delegates to the same contract `@onegrid/core` already
 * uses for `ColumnDef.validate`, so this package composes onto that pipeline
 * instead of duplicating it.
 */
export interface CellRule extends RuleCommon {
  readonly kind: 'cell';
  readonly column: string;
  readonly validate: (
    value: unknown,
    context: CellRuleContext,
  ) => ValidationResult | Promise<ValidationResult>;
}

/** A predicate over one whole row. */
export interface RowRule extends RuleCommon {
  readonly kind: 'row';
  /** Columns the predicate reads. Drives invalidation. */
  readonly input: readonly string[];
  readonly validate: (
    row: RowSnapshot,
    context: RowRuleContext,
  ) => RowValidationResult | Promise<RowValidationResult>;
}

/** A predicate over the whole table, backed by an incremental aggregate. */
export interface SheetRule extends RuleCommon {
  readonly kind: 'sheet';
  /** Columns the aggregate reads. Drives invalidation. */
  readonly input: readonly string[];
  /** Factory — the engine owns one aggregate instance per rule. */
  readonly createAggregate: () => SheetAggregate;
}

/** Any rule the engine accepts. */
export type Rule = CellRule | RowRule | SheetRule;

/** A dependency cycle among rules, and how many passes it was given. */
export interface CycleReport {
  /** The cycle, first node repeated at the end: `['a','b','a']`. */
  readonly path: readonly string[];
  readonly passUsed: number;
  readonly passCap: number;
}

/** The outcome of a validation run. */
export interface ValidationReport {
  readonly diagnostic: readonly Diagnostic[];
  readonly summary: DiagnosticSummary;
  readonly cycle: readonly CycleReport[];
  /** True when a newer run superseded this one; its diagnostics were discarded. */
  readonly stale: boolean;
}

/** The answer to "may this edit be committed?". */
export interface CommitDecision {
  readonly allowed: boolean;
  /** Diagnostics the edit would produce — including non-blocking warnings. */
  readonly diagnostic: readonly Diagnostic[];
  readonly summary: DiagnosticSummary;
}

/** Instrumentation. `invocation` is what proves revalidation is incremental. */
export interface ValidatorStat {
  /** Rule id → how many times its predicate/aggregate has been asked. */
  readonly invocation: Readonly<Record<string, number>>;
  readonly totalInvocation: number;
  /** Passes spent on the most recent run (>1 only when a cycle exists). */
  readonly passUsed: number;
}

/** Options for `createValidator`. */
export interface ValidatorOptions {
  readonly rule: readonly Rule[];
  readonly source: SheetSource;
  /**
   * Hard cap on evaluation passes over a cyclic rule group. A real number, not
   * a "run until stable" hope: a cycle terminates after this many passes even
   * if the diagnostics never converge. Default 4, minimum 1.
   */
  readonly maxPass?: number;
  /** Phase reported to rules. Default `commit`. */
  readonly phase?: ValidationPhase;
}

/** The validator handle. */
export interface Validator {
  /** Full pass: seeds every aggregate and evaluates every rule on every row. */
  readonly validateAll: () => Promise<ValidationReport>;
  /** Incremental pass: advances aggregates and re-runs only affected rules. */
  readonly applyChange: (change: RowChange) => Promise<ValidationReport>;
  /**
   * Speculative check for an edit that has NOT been applied to the store yet.
   * Rolls all aggregate state back before returning; leaves the report intact.
   */
  readonly checkCommit: (change: RowChange) => Promise<CommitDecision>;
  /** The last committed report. */
  readonly report: () => ValidationReport;
  /** Diagnostics touching a cell — what a renderer tints with. */
  readonly diagnosticAt: (rowIndex: number, columnId: string) => readonly Diagnostic[];
  readonly stat: () => ValidatorStat;
  readonly resetStat: () => void;
  /** Abort any in-flight run and drop all state. */
  readonly dispose: () => void;
}
