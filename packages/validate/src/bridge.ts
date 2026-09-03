// =============================================================================
// The bridge onto @onegrid/core's per-cell validator
//
// `@onegrid/core` already owns cell-scope validation: `ColumnDef.validate`
// takes the in-progress string and a `{ rowIndex, columnId, phase }` context,
// returns a sync or async `{ ok }` result, and the grid handles the
// AbortController, the error bubble, `aria-invalid` and the live-region
// announcement. This package does not reimplement any of that — it reuses the
// exact result shape, and these two functions move a rule across the boundary
// in either direction.
//
// The one lossy step is severity: core knows `error | warning`, this package
// adds `info`. An `info` result is handed to core as a `warning`, because the
// alternative — dropping it — would let a cell go un-annotated.
// =============================================================================

import type {
  CellRule,
  CellRuleContext,
  ValidationPhase,
  ValidationResult,
  RowSnapshot,
} from './type';

/** The shape `@onegrid/core` passes to a `ColumnDef.validate` function. */
export interface ColumnValidationContext {
  readonly rowIndex: number;
  readonly columnId: string;
  readonly phase: ValidationPhase;
}

/** The shape `@onegrid/core` accepts as `ColumnDef.validate`. */
export type ColumnValidator = (
  value: string,
  context: ColumnValidationContext,
) => ValidationResult | Promise<ValidationResult>;

/** Options for `toColumnValidator`. */
export interface ColumnValidatorOptions {
  /** Read the rest of the row, for cell rules that inspect siblings. */
  readonly row?: (rowIndex: number) => RowSnapshot;
  /** Stable row key, if the adopter has one. Defaults to the row index. */
  readonly rowKey?: (rowIndex: number) => string;
}

/**
 * Fold one or more cell rules into a single function assignable to
 * `ColumnDef.validate`. Rules run in order and the first failure wins, which
 * matches how a user reads an error bubble: one message, the most specific one
 * the author put first.
 *
 * Each call aborts the previous one's signal, mirroring the grid's own
 * behaviour so an async rule sees the same cancellation it would see inside
 * core.
 */
export function toColumnValidator(
  rule: CellRule | readonly CellRule[],
  option: ColumnValidatorOptions = {},
): ColumnValidator {
  const list = Array.isArray(rule) ? (rule as readonly CellRule[]) : [rule as CellRule];
  let inflight: AbortController | null = null;

  return (value, context) => {
    inflight?.abort();
    const controller = new AbortController();
    inflight = controller;

    const row = option.row?.(context.rowIndex) ?? { [context.columnId]: value };
    const ruleContext: CellRuleContext = {
      rowIndex: context.rowIndex,
      rowKey: option.rowKey?.(context.rowIndex) ?? String(context.rowIndex),
      columnId: context.columnId,
      phase: context.phase,
      row,
      signal: controller.signal,
      diagnosticOf: () => [],
    };

    const step = (index: number): ValidationResult | Promise<ValidationResult> => {
      if (index >= list.length) return { ok: true };
      const current = list[index]!;
      const result = current.validate(value, ruleContext);
      if (result instanceof Promise) {
        return result.then((settled) =>
          settled.ok ? step(index + 1) : downgrade(settled, current),
        );
      }
      return result.ok ? step(index + 1) : downgrade(result, current);
    };
    return step(0);
  };
}

function downgrade(result: ValidationResult, rule: CellRule): ValidationResult {
  if (result.ok) return result;
  const severity = result.severity ?? rule.severity ?? 'error';
  return {
    ok: false,
    message: result.message,
    severity: severity === 'info' ? 'warning' : severity,
  };
}

/**
 * The inverse: wrap an existing `ColumnDef.validate` function as a cell rule so
 * a column that already validates inside core participates in sheet-wide
 * reporting, `summarize`, and `blockCommit` without being rewritten.
 */
export function fromColumnValidator(option: {
  readonly id: string;
  readonly column: string;
  readonly validate: ColumnValidator;
}): CellRule {
  return {
    kind: 'cell',
    id: option.id,
    column: option.column,
    validate: (value, context) =>
      option.validate(value === null || value === undefined ? '' : String(value), {
        rowIndex: context.rowIndex,
        columnId: context.columnId,
        phase: context.phase,
      }),
  };
}
