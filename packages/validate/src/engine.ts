// =============================================================================
// The validation engine
//
// The whole design exists to answer one question cheaply: after this edit,
// which rules can possibly have changed their mind? Everything else follows.
//
//   - A full pass (`validateAll`) seeds every sheet aggregate with one scan and
//     evaluates every rule on every row. It happens once, at attach time.
//   - An incremental pass (`applyChange`) walks the invalidation graph from the
//     touched columns, evaluates only the rules that graph reaches, and only on
//     the changed row. Sheet rules do not rescan: their aggregate is advanced
//     by the delta and re-diagnosed from maintained state.
//   - `checkCommit` answers "may this edit land?" without the edit having
//     landed: it speculatively advances the aggregates, diagnoses, and then
//     applies the inverse change to roll every aggregate back.
//
// Staleness is handled the way `@onegrid/core` handles it in the cell editor,
// because an adopter who has read one should recognise the other: every run
// takes a token and an AbortController, a new run aborts the previous one, and
// a superseded run's results are DISCARDED rather than written. Results are
// accumulated in a draft and only merged into committed state if the token is
// still current at the end — so a slow validator that resolves after a faster
// one can never repaint the grid with an old answer.
// =============================================================================

import type { DependencyGraph } from '@onegrid/formula';
import { compareDiagnostic, resolveBlockCommit, resolveSeverity, summarize } from './diagnostic';
import { buildInvalidationGraph, columnNode, inputOf, planRule, ruleNode } from './graph';
import type {
  CommitDecision,
  CycleReport,
  Diagnostic,
  ResolvedChange,
  Rule,
  RowChange,
  RowSnapshot,
  SheetAggregate,
  Validator,
  ValidationPhase,
  ValidationReport,
  ValidatorOptions,
  ValidatorStat,
} from './type';
import type { RulePlan } from './graph';

/** Rule id the engine itself reports cycles under. */
export const CYCLE_RULE_ID = '@onegrid/validate/cycle';

const DEFAULT_MAX_PASS = 4;

/** Thrown internally when a run is superseded; never escapes the engine. */
class StaleRun extends Error {
  constructor() {
    super('validation run superseded');
    this.name = 'StaleRun';
  }
}

/** Per-run scratch space. Nothing here touches committed state until commit. */
interface RunScope {
  readonly token: number;
  readonly signal: AbortSignal;
  /** ruleId → rowKey → diagnostic, or null meaning "this row is now clean". */
  readonly draftRow: Map<string, Map<string, Diagnostic | null>>;
  readonly draftSheet: Map<string, Diagnostic[]>;
  /** Row indices to evaluate cell/row rules against. Null means every row. */
  readonly targetRow: readonly number[] | null;
  /** Rules to evaluate. Null means every rule. */
  readonly dirtyRule: ReadonlySet<string> | null;
  /** Speculative row overlay used by `checkCommit`, keyed by row index. */
  readonly overlay: { readonly rowIndex: number; readonly value: RowSnapshot } | null;
}

class ValidationEngine {
  private readonly ruleById = new Map<string, Rule>();
  private readonly ruleOrder: readonly Rule[];
  private readonly plan: RulePlan;
  private readonly graph: DependencyGraph;
  private readonly aggregate = new Map<string, SheetAggregate>();
  private readonly inputColumn: readonly string[];
  private readonly source: ValidatorOptions['source'];
  private readonly maxPass: number;
  private readonly phase: ValidationPhase;

  /** Committed diagnostics for cell and row rules: ruleId → rowKey → diagnostic. */
  private readonly rowDiagnostic = new Map<string, Map<string, Diagnostic>>();
  /** Committed diagnostics for sheet rules: ruleId → diagnostics. */
  private readonly sheetDiagnostic = new Map<string, Diagnostic[]>();

  private keyOfRow: string[] = [];
  private indexOfKey = new Map<string, number>();

  private runToken = 0;
  private abort: AbortController | null = null;
  private disposed = false;

  private invocation = new Map<string, number>();
  private passUsed = 0;
  private cyclePassUsed = new Map<string, number>();

  constructor(option: ValidatorOptions) {
    this.ruleOrder = option.rule;
    for (const rule of option.rule) {
      if (this.ruleById.has(rule.id)) {
        throw new Error(`[OG_VALIDATE_DUPLICATE_RULE] two rules share the id '${rule.id}'`);
      }
      this.ruleById.set(rule.id, rule);
      if (rule.kind === 'sheet') this.aggregate.set(rule.id, rule.createAggregate());
    }
    this.source = option.source;
    this.maxPass = Math.max(1, Math.floor(option.maxPass ?? DEFAULT_MAX_PASS));
    this.phase = option.phase ?? 'commit';
    this.graph = buildInvalidationGraph(option.rule);
    this.plan = planRule(option.rule);

    const column = new Set<string>();
    for (const rule of option.rule) for (const c of inputOf(rule)) column.add(c);
    this.inputColumn = [...column];

    this.refreshKey();
  }

  // ---------------------------------------------------------------------------
  // Row identity
  // ---------------------------------------------------------------------------

  /**
   * Rebuild the row-index ↔ row-key mapping. O(rows), so it runs at construction
   * and after a structural change (insert/delete) — never after a cell edit,
   * which cannot move a row.
   */
  private refreshKey(): void {
    const getRowKey = this.source.getRowKey;
    const count = this.source.numRows;
    const key: string[] = new Array<string>(count);
    const index = new Map<string, number>();
    for (let i = 0; i < count; i += 1) {
      const k = getRowKey ? getRowKey(i) : String(i);
      key[i] = k;
      index.set(k, i);
    }
    this.keyOfRow = key;
    this.indexOfKey = index;
  }

  private rowKeyOf(rowIndex: number): string {
    return this.keyOfRow[rowIndex] ?? String(rowIndex);
  }

  // ---------------------------------------------------------------------------
  // Reading
  // ---------------------------------------------------------------------------

  /** Read one row, restricted to columns some rule declared it reads. */
  private readRow(rowIndex: number, scope: RunScope | null): RowSnapshot {
    const out: Record<string, unknown> = {};
    // A speculative insert addresses a row the source does not hold yet; the
    // overlay is the only content there is, so skip the read rather than ask
    // the adopter's source for an index it never promised to serve.
    if (rowIndex < this.source.numRows) {
      for (const column of this.inputColumn) out[column] = this.source.getCell(rowIndex, column);
    }
    if (scope?.overlay && scope.overlay.rowIndex === rowIndex) {
      return { ...out, ...scope.overlay.value };
    }
    return out;
  }

  /**
   * Fill in everything a `RowChange` left implicit. The base is whatever the
   * source currently holds for the changed row; `before` and `after` then
   * override it. That is correct in both directions of use: after the adopter
   * has written the edit (the source holds the new value, `before` supplies the
   * old one), and before it has (the source holds the old value, `after`
   * supplies the new one).
   */
  private resolveChange(change: RowChange): ResolvedChange {
    const rowKey = change.rowKey ?? this.rowKeyOf(change.rowIndex);
    const touched =
      change.column ??
      [...new Set([...Object.keys(change.before ?? {}), ...Object.keys(change.after ?? {})])];

    if (change.type === 'delete') {
      const base = change.before ?? this.readRow(change.rowIndex, null);
      return {
        type: 'delete',
        rowIndex: change.rowIndex,
        rowKey,
        before: { ...base },
        after: {},
        column: touched.length > 0 ? touched : this.inputColumn,
      };
    }

    const base = this.readRow(change.rowIndex, null);
    const after = { ...base, ...(change.after ?? {}) };
    if (change.type === 'insert') {
      return {
        type: 'insert',
        rowIndex: change.rowIndex,
        rowKey,
        before: {},
        after,
        column: touched.length > 0 ? touched : this.inputColumn,
      };
    }
    const before = { ...base, ...(change.before ?? {}) };
    return {
      type: 'update',
      rowIndex: change.rowIndex,
      rowKey,
      before,
      after,
      column: touched.length > 0 ? touched : this.inputColumn,
    };
  }

  /** The exact inverse of a change — the rollback used by `checkCommit`. */
  private static invert(change: ResolvedChange): ResolvedChange {
    if (change.type === 'insert') {
      return { ...change, type: 'delete', before: change.after, after: {} };
    }
    if (change.type === 'delete') {
      return { ...change, type: 'insert', before: {}, after: change.before };
    }
    return { ...change, before: change.after, after: change.before };
  }

  // ---------------------------------------------------------------------------
  // Invalidation
  // ---------------------------------------------------------------------------

  /**
   * Which rules a change can possibly have flipped. Walks the invalidation
   * graph out from each touched column and keeps the rule nodes it reaches —
   * transitively, so a rule that reads another rule's verdict is caught too.
   * A structural change dirties everything with a sheet aggregate, because row
   * count and every index shift regardless of which columns were written.
   */
  private dirtyRuleFor(change: ResolvedChange): Set<string> {
    const dirty = new Set<string>();
    for (const column of change.column) {
      for (const node of this.graph.collectTransitiveDependents(columnNode(column))) {
        if (node.startsWith('rule:')) dirty.add(node.slice(5));
      }
    }
    if (change.type !== 'update') {
      for (const rule of this.ruleOrder) {
        if (rule.kind === 'sheet') {
          dirty.add(rule.id);
          // Anything reading a dirtied sheet rule's verdict is dirty too.
          for (const node of this.graph.collectTransitiveDependents(ruleNode(rule.id))) {
            if (node.startsWith('rule:')) dirty.add(node.slice(5));
          }
        }
      }
    }
    return dirty;
  }

  /** Advance every aggregate the change can affect. O(1) per aggregate. */
  private advanceAggregate(change: ResolvedChange): void {
    const touched = new Set(change.column);
    for (const rule of this.ruleOrder) {
      if (rule.kind !== 'sheet') continue;
      const aggregate = this.aggregate.get(rule.id);
      if (!aggregate) continue;
      const relevant =
        change.type !== 'update' || rule.input.some((column) => touched.has(column));
      if (relevant) aggregate.apply(change);
    }
  }

  // ---------------------------------------------------------------------------
  // Evaluation
  // ---------------------------------------------------------------------------

  private countInvocation(ruleId: string): void {
    this.invocation.set(ruleId, (this.invocation.get(ruleId) ?? 0) + 1);
  }

  /** Diagnostics a rule currently holds — draft first, then committed. */
  private diagnosticOf(ruleId: string, scope: RunScope | null): readonly Diagnostic[] {
    const out: Diagnostic[] = [];
    const draftSheet = scope?.draftSheet.get(ruleId);
    if (draftSheet) out.push(...draftSheet);
    else out.push(...(this.sheetDiagnostic.get(ruleId) ?? []));

    const committedRow = this.rowDiagnostic.get(ruleId);
    const draftRow = scope?.draftRow.get(ruleId);
    if (committedRow) {
      for (const [rowKey, diagnostic] of committedRow) {
        if (draftRow?.has(rowKey)) continue;
        out.push(diagnostic);
      }
    }
    if (draftRow) {
      for (const diagnostic of draftRow.values()) if (diagnostic) out.push(diagnostic);
    }
    return out;
  }

  private checkFresh(scope: RunScope): void {
    if (scope.token !== this.runToken || this.disposed) throw new StaleRun();
  }

  /** Evaluate one rule under a run scope, writing into the draft. */
  private async evaluateRule(rule: Rule, scope: RunScope): Promise<void> {
    if (rule.kind === 'sheet') {
      const aggregate = this.aggregate.get(rule.id);
      if (!aggregate) return;
      this.countInvocation(rule.id);
      const finding = aggregate.diagnose();
      const diagnostic: Diagnostic[] = finding.map((f) => {
        const severity = resolveSeverity(rule, f.severity);
        const rowKey = f.rowKey ?? null;
        const rowIndex = rowKey === null ? null : (this.indexOfKey.get(rowKey) ?? null);
        return {
          ruleId: rule.id,
          scope: 'sheet',
          severity,
          message: f.message,
          row: rowIndex,
          rowKey,
          column: f.column ?? rule.input,
          group: f.group ?? null,
          blockCommit: resolveBlockCommit(rule, severity),
        };
      });
      scope.draftSheet.set(rule.id, diagnostic);
      return;
    }

    const target = scope.targetRow ?? range(this.source.numRows);
    let draft = scope.draftRow.get(rule.id);
    if (!draft) {
      draft = new Map<string, Diagnostic | null>();
      scope.draftRow.set(rule.id, draft);
    }

    for (const rowIndex of target) {
      if (rowIndex < 0) continue;
      const speculative = scope.overlay?.rowIndex === rowIndex;
      if (rowIndex >= this.source.numRows && !speculative) continue;
      const rowKey = this.rowKeyOf(rowIndex);
      const row = this.readRow(rowIndex, scope);
      this.countInvocation(rule.id);

      if (rule.kind === 'cell') {
        const result = rule.validate(row[rule.column], {
          rowIndex,
          rowKey,
          columnId: rule.column,
          phase: this.phase,
          row,
          signal: scope.signal,
          diagnosticOf: (id) => this.diagnosticOf(id, scope),
        });
        const settled = result instanceof Promise ? await result : result;
        this.checkFresh(scope);
        if (settled.ok) {
          draft.set(rowKey, null);
        } else {
          const severity = resolveSeverity(rule, settled.severity);
          draft.set(rowKey, {
            ruleId: rule.id,
            scope: 'cell',
            severity,
            message: settled.message,
            row: rowIndex,
            rowKey,
            column: [rule.column],
            group: null,
            blockCommit: resolveBlockCommit(rule, severity),
          });
        }
        continue;
      }

      const result = rule.validate(row, {
        rowIndex,
        rowKey,
        phase: this.phase,
        signal: scope.signal,
        diagnosticOf: (id) => this.diagnosticOf(id, scope),
      });
      const settled = result instanceof Promise ? await result : result;
      this.checkFresh(scope);
      if (settled.ok) {
        draft.set(rowKey, null);
      } else {
        const severity = resolveSeverity(rule, settled.severity);
        draft.set(rowKey, {
          ruleId: rule.id,
          scope: 'row',
          severity,
          message: settled.message,
          row: rowIndex,
          rowKey,
          column: settled.column ?? rule.input,
          group: null,
          blockCommit: resolveBlockCommit(rule, severity),
        });
      }
    }
  }

  /**
   * Walk the evaluation plan. Linear stages run once. A cyclic stage runs its
   * whole group repeatedly until the group's diagnostics stop changing or the
   * pass cap fires — the cap is what guarantees termination, the convergence
   * check is only there to avoid burning passes a stable cycle does not need.
   */
  private async runPlan(scope: RunScope): Promise<void> {
    let maxPassUsed = 1;
    for (const stage of this.plan.stage) {
      if (stage.kind === 'linear') {
        const rule = this.ruleById.get(stage.ruleId)!;
        if (scope.dirtyRule && !scope.dirtyRule.has(rule.id)) continue;
        await this.evaluateRule(rule, scope);
        continue;
      }

      const member = stage.ruleId
        .map((id) => this.ruleById.get(id)!)
        .filter((rule) => !scope.dirtyRule || scope.dirtyRule.has(rule.id));
      if (member.length === 0) continue;

      let signature = this.groupSignature(stage.ruleId, scope);
      let pass = 0;
      while (pass < this.maxPass) {
        pass += 1;
        for (const rule of member) await this.evaluateRule(rule, scope);
        const next = this.groupSignature(stage.ruleId, scope);
        if (next === signature) break;
        signature = next;
      }
      this.cyclePassUsed.set(stage.path.join('>'), pass);
      if (pass > maxPassUsed) maxPassUsed = pass;
    }
    this.passUsed = maxPassUsed;
  }

  /** A cheap fingerprint of a rule group's current diagnostics. */
  private groupSignature(ruleId: readonly string[], scope: RunScope): string {
    const part: string[] = [];
    for (const id of ruleId) {
      const diagnostic = [...this.diagnosticOf(id, scope)].sort(compareDiagnostic);
      part.push(`${id}#${diagnostic.map((d) => `${d.rowKey ?? '-'}:${d.message}`).join('|')}`);
    }
    return part.join(';;');
  }

  // ---------------------------------------------------------------------------
  // Run lifecycle
  // ---------------------------------------------------------------------------

  private beginRun(
    targetRow: readonly number[] | null,
    dirtyRule: ReadonlySet<string> | null,
    overlay: RunScope['overlay'],
  ): RunScope {
    this.abort?.abort();
    const controller = new AbortController();
    this.abort = controller;
    this.runToken += 1;
    return {
      token: this.runToken,
      signal: controller.signal,
      draftRow: new Map(),
      draftSheet: new Map(),
      targetRow,
      dirtyRule,
      overlay,
    };
  }

  /** Merge a finished run's draft into committed state. */
  private commit(scope: RunScope): void {
    for (const [ruleId, draft] of scope.draftRow) {
      let committed = this.rowDiagnostic.get(ruleId);
      if (!committed) {
        committed = new Map<string, Diagnostic>();
        this.rowDiagnostic.set(ruleId, committed);
      }
      for (const [rowKey, diagnostic] of draft) {
        if (diagnostic) committed.set(rowKey, diagnostic);
        else committed.delete(rowKey);
      }
    }
    for (const [ruleId, diagnostic] of scope.draftSheet) {
      this.sheetDiagnostic.set(ruleId, diagnostic);
    }
  }

  /** Drop every diagnostic recorded against a row that no longer exists. */
  private forgetRow(rowKey: string): void {
    for (const committed of this.rowDiagnostic.values()) committed.delete(rowKey);
  }

  /**
   * Row diagnostics remember the row index they were produced at. After an
   * insert or delete the surviving rows have moved, so re-address them from
   * their stable keys rather than re-running the rules.
   */
  private readdress(): void {
    for (const committed of this.rowDiagnostic.values()) {
      for (const [rowKey, diagnostic] of committed) {
        const rowIndex = this.indexOfKey.get(rowKey);
        if (rowIndex === undefined) committed.delete(rowKey);
        else if (rowIndex !== diagnostic.row) committed.set(rowKey, { ...diagnostic, row: rowIndex });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Reporting
  // ---------------------------------------------------------------------------

  private cycleReport(): CycleReport[] {
    return this.plan.cyclePath.map((path) => ({
      path,
      passUsed: this.cyclePassUsed.get(path.join('>')) ?? 0,
      passCap: this.maxPass,
    }));
  }

  private cycleDiagnostic(): Diagnostic[] {
    return this.cycleReport().map((cycle) => ({
      ruleId: CYCLE_RULE_ID,
      scope: 'sheet' as const,
      severity: 'error' as const,
      message:
        `Rule dependency cycle ${cycle.path.join(' → ')}; ` +
        `evaluation stopped after ${cycle.passUsed} of at most ${cycle.passCap} passes.`,
      row: null,
      rowKey: null,
      column: [],
      group: null,
      blockCommit: true,
    }));
  }

  private collect(): Diagnostic[] {
    const out: Diagnostic[] = [];
    for (const committed of this.rowDiagnostic.values()) out.push(...committed.values());
    for (const diagnostic of this.sheetDiagnostic.values()) out.push(...diagnostic);
    out.push(...this.cycleDiagnostic());
    out.sort(compareDiagnostic);
    return out;
  }

  report(): ValidationReport {
    const diagnostic = this.collect();
    return {
      diagnostic,
      summary: summarize(diagnostic),
      cycle: this.cycleReport(),
      stale: false,
    };
  }

  private staleReport(): ValidationReport {
    const diagnostic = this.collect();
    return { diagnostic, summary: summarize(diagnostic), cycle: this.cycleReport(), stale: true };
  }

  diagnosticAt(rowIndex: number, columnId: string): readonly Diagnostic[] {
    const out: Diagnostic[] = [];
    for (const diagnostic of this.collect()) {
      if (diagnostic.row !== rowIndex) continue;
      if (diagnostic.column.length > 0 && !diagnostic.column.includes(columnId)) continue;
      out.push(diagnostic);
    }
    return out;
  }

  stat(): ValidatorStat {
    const invocation: Record<string, number> = {};
    let total = 0;
    for (const [ruleId, count] of this.invocation) {
      invocation[ruleId] = count;
      total += count;
    }
    return { invocation, totalInvocation: total, passUsed: this.passUsed };
  }

  resetStat(): void {
    this.invocation = new Map();
  }

  dispose(): void {
    this.disposed = true;
    this.abort?.abort();
    this.abort = null;
    this.rowDiagnostic.clear();
    this.sheetDiagnostic.clear();
    this.aggregate.clear();
  }

  // ---------------------------------------------------------------------------
  // Public operations
  // ---------------------------------------------------------------------------

  async validateAll(): Promise<ValidationReport> {
    this.refreshKey();
    const scan = {
      numRows: this.source.numRows,
      getCell: (rowIndex: number, columnId: string) => this.source.getCell(rowIndex, columnId),
      rowKeyOf: (rowIndex: number) => this.rowKeyOf(rowIndex),
    };
    for (const [ruleId, aggregate] of this.aggregate) {
      this.countInvocation(ruleId);
      aggregate.seed(scan);
    }
    const scope = this.beginRun(null, null, null);
    try {
      await this.runPlan(scope);
      this.checkFresh(scope);
    } catch (error) {
      if (error instanceof StaleRun) return this.staleReport();
      throw error;
    }
    this.rowDiagnostic.clear();
    this.sheetDiagnostic.clear();
    this.commit(scope);
    return this.report();
  }

  async applyChange(change: RowChange): Promise<ValidationReport> {
    // An insert has already shifted the adopter's rows, so the key map has to
    // be rebuilt BEFORE the change is resolved — otherwise the new row inherits
    // the key of whatever used to sit at its index.
    if (change.type === 'insert') this.refreshKey();
    const resolved = this.resolveChange(change);
    this.advanceAggregate(resolved);

    if (resolved.type !== 'update') {
      this.refreshKey();
      if (resolved.type === 'delete') this.forgetRow(resolved.rowKey);
      this.readdress();
    }

    const dirty = this.dirtyRuleFor(resolved);
    const target = resolved.type === 'delete' ? [] : [resolved.rowIndex];
    const scope = this.beginRun(target, dirty, null);
    try {
      await this.runPlan(scope);
      this.checkFresh(scope);
    } catch (error) {
      if (error instanceof StaleRun) return this.staleReport();
      throw error;
    }
    this.commit(scope);
    return this.report();
  }

  async checkCommit(change: RowChange): Promise<CommitDecision> {
    const resolved = this.resolveChange(change);
    // The adopter has NOT written the edit yet, so the aggregates advance
    // speculatively and every rule reads the row through an overlay.
    this.advanceAggregate(resolved);
    const dirty = this.dirtyRuleFor(resolved);
    const target = resolved.type === 'delete' ? [] : [resolved.rowIndex];
    const overlay =
      resolved.type === 'delete'
        ? null
        : { rowIndex: resolved.rowIndex, value: resolved.after };
    const scope = this.beginRun(target, dirty, overlay);
    try {
      await this.runPlan(scope);
      this.checkFresh(scope);
    } catch (error) {
      if (error instanceof StaleRun) {
        return { allowed: true, diagnostic: [], summary: summarize([]) };
      }
      throw error;
    } finally {
      // Roll every aggregate back. `apply` is required to be invertible, which
      // is why the stock aggregates keep counts instead of sets.
      this.advanceAggregate(ValidationEngine.invert(resolved));
    }

    const diagnostic: Diagnostic[] = [];
    for (const [, draft] of scope.draftRow) {
      for (const d of draft.values()) if (d) diagnostic.push(d);
    }
    for (const [, sheet] of scope.draftSheet) diagnostic.push(...sheet);
    diagnostic.push(...this.cycleDiagnostic());
    diagnostic.sort(compareDiagnostic);
    const summary = summarize(diagnostic);
    return { allowed: summary.blocking === 0, diagnostic, summary };
  }
}

function range(count: number): number[] {
  const out: number[] = new Array<number>(count);
  for (let i = 0; i < count; i += 1) out[i] = i;
  return out;
}

/**
 * Create a validator over a rule set and a table.
 *
 * Call `validateAll()` once when the grid attaches, then `applyChange()` after
 * every mutation the adopter writes to its store, and `checkCommit()` from the
 * editor when it needs to know whether Enter may close the editor.
 */
export function createValidator(option: ValidatorOptions): Validator {
  const engine = new ValidationEngine(option);
  return {
    validateAll: () => engine.validateAll(),
    applyChange: (change) => engine.applyChange(change),
    checkCommit: (change) => engine.checkCommit(change),
    report: () => engine.report(),
    diagnosticAt: (rowIndex, columnId) => engine.diagnosticAt(rowIndex, columnId),
    stat: () => engine.stat(),
    resetStat: () => engine.resetStat(),
    dispose: () => engine.dispose(),
  };
}
