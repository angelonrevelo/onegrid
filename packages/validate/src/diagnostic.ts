// =============================================================================
// Diagnostic construction and rollup
//
// Severity resolution has a precedence order worth stating explicitly, because
// two layers can both express an opinion: the individual result a rule returns
// wins over the rule's declared default, which wins over `error`. A rule that
// normally errors can therefore downgrade one particular finding to a warning
// without a second rule.
//
// `blockCommit` then derives from the resolved severity — an error rejects the
// edit, a warning or info lets it through — unless the rule states otherwise.
// That override is what a "soft required" field needs: severity `error` so it
// paints red, `blockCommit: false` so the user can still leave the cell.
// =============================================================================

import type { Diagnostic, DiagnosticSummary, Rule, Severity } from './type';

/** Resolve a diagnostic's severity: result → rule default → `error`. */
export function resolveSeverity(rule: Rule, resultSeverity: Severity | undefined): Severity {
  return resultSeverity ?? rule.severity ?? 'error';
}

/** Resolve whether a diagnostic rejects a commit: rule override → severity. */
export function resolveBlockCommit(rule: Rule, severity: Severity): boolean {
  return rule.blockCommit ?? severity === 'error';
}

/**
 * Count diagnostics by severity, plus how many of them would reject a commit.
 * The renderer uses the counts for a status bar; the editor uses `blocking` to
 * decide whether Enter is allowed to close the editor.
 */
export function summarize(diagnostic: readonly Diagnostic[]): DiagnosticSummary {
  let error = 0;
  let warning = 0;
  let info = 0;
  let blocking = 0;
  for (const d of diagnostic) {
    if (d.severity === 'error') error += 1;
    else if (d.severity === 'warning') warning += 1;
    else info += 1;
    if (d.blockCommit) blocking += 1;
  }
  return { error, warning, info, total: diagnostic.length, blocking };
}

/**
 * Stable ordering for a report: sheet-wide diagnostics last, otherwise by row
 * then rule id. A stable order means a diff of two reports is meaningful and a
 * test can assert on `diagnostic[0]` without being flaky.
 */
export function compareDiagnostic(a: Diagnostic, b: Diagnostic): number {
  const rowA = a.row ?? Number.MAX_SAFE_INTEGER;
  const rowB = b.row ?? Number.MAX_SAFE_INTEGER;
  if (rowA !== rowB) return rowA - rowB;
  if (a.ruleId !== b.ruleId) return a.ruleId < b.ruleId ? -1 : 1;
  const colA = a.column.join(',');
  const colB = b.column.join(',');
  if (colA !== colB) return colA < colB ? -1 : 1;
  return a.message < b.message ? -1 : a.message > b.message ? 1 : 0;
}
