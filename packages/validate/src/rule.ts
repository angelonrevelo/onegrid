// =============================================================================
// The stock rule library
//
// Ten rules cover the overwhelming majority of what a grid is asked to check.
// Four are cell-scope and delegate straight to the per-cell contract already in
// `@onegrid/core`; one is row-scope; five are sheet-scope and each ships an
// aggregate that is maintained by delta.
//
// Two conventions run through the sheet aggregates and both are deliberate:
//
//   Values are indexed by their STRING form. A grid round-trips every value
//   through a text editor, so `1` and `'1'` are the same cell content to a
//   user, and a uniqueness rule that disagrees is a bug report. Blank (null,
//   undefined, empty string) is never indexed — SQL's rule, and the reason
//   `required` exists separately.
//
//   Every index keeps COUNTS, not sets. A `Set<string>` uniqueness index is
//   the classic wrong answer: deleting one of three duplicates removes the key
//   entirely and the two survivors silently become valid. Counting also makes
//   `apply` exactly invertible, which is what lets `checkCommit` speculate and
//   roll back.
// =============================================================================

import type {
  CellRule,
  ResolvedChange,
  RowRule,
  RowSnapshot,
  ScalarComparison,
  Severity,
  SheetAggregate,
  SheetFinding,
  SheetRule,
  SheetScan,
} from './type';

// -----------------------------------------------------------------------------
// Value helpers
// -----------------------------------------------------------------------------

/** Separator for composite keys. U+0000 cannot come out of a text editor. */
const SEPARATOR = '\u0000';

/** Blank means null, undefined, or a string that is empty once trimmed. */
export function isBlank(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
}

/** Index key for a value, or null when the value is blank (never indexed). */
function keyOfValue(value: unknown): string | null {
  if (isBlank(value)) return null;
  return String(value);
}

/** Composite index key across several columns; null if any part is blank. */
function keyOfRow(row: RowSnapshot, column: readonly string[]): string | null {
  const part: string[] = [];
  for (const c of column) {
    const key = keyOfValue(row[c]);
    if (key === null) return null;
    // U+0000 cannot appear in a cell rendered from a text editor, so it is a
    // safe separator: a single value cannot be confused with two.
    part.push(key);
  }
  return part.join(SEPARATOR);
}

/** Coerce to a finite number, or null. Accepts numeric strings; rejects ''. */
export function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string') {
    if (value.trim() === '') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (value instanceof Date) return value.getTime();
  return null;
}

/**
 * Order two cell values. Numbers (and numeric strings) compare numerically,
 * ISO-ish date strings compare chronologically, everything else compares
 * lexicographically. Returns null when either side is blank — a comparison
 * against a blank is not a violation, it is a job for `required`.
 */
export function compareValue(left: unknown, right: unknown): number | null {
  if (isBlank(left) || isBlank(right)) return null;
  const numberLeft = toNumber(left);
  const numberRight = toNumber(right);
  if (numberLeft !== null && numberRight !== null) return sign(numberLeft - numberRight);
  const timeLeft = toTime(left);
  const timeRight = toTime(right);
  if (timeLeft !== null && timeRight !== null) return sign(timeLeft - timeRight);
  const stringLeft = String(left);
  const stringRight = String(right);
  return stringLeft < stringRight ? -1 : stringLeft > stringRight ? 1 : 0;
}

function toTime(value: unknown): number | null {
  if (value instanceof Date) return value.getTime();
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function sign(delta: number): number {
  return delta < 0 ? -1 : delta > 0 ? 1 : 0;
}

/** Test an ordering result against a comparison operator. */
export function satisfies(order: number, comparison: ScalarComparison): boolean {
  switch (comparison) {
    case '<':
      return order < 0;
    case '<=':
      return order <= 0;
    case '>':
      return order > 0;
    case '>=':
      return order >= 0;
    case '===':
      return order === 0;
    case '!==':
      return order !== 0;
  }
}

// -----------------------------------------------------------------------------
// Cell-scope rules
// -----------------------------------------------------------------------------

interface CellOption {
  readonly id?: string;
  readonly severity?: Severity;
  readonly blockCommit?: boolean;
  readonly message?: string;
}

function cellOf(
  option: CellOption,
  fallbackId: string,
  validate: CellRule['validate'],
  column: string,
): CellRule {
  const rule: {
    kind: 'cell';
    id: string;
    column: string;
    validate: CellRule['validate'];
    severity?: Severity;
    blockCommit?: boolean;
  } = { kind: 'cell', id: option.id ?? fallbackId, column, validate };
  if (option.severity !== undefined) rule.severity = option.severity;
  if (option.blockCommit !== undefined) rule.blockCommit = option.blockCommit;
  return rule;
}

/** The value must not be blank. */
export function required(option: CellOption & { readonly column: string }): CellRule {
  const message = option.message ?? `${option.column} is required`;
  return cellOf(
    option,
    `required:${option.column}`,
    (value) => (isBlank(value) ? { ok: false, message } : { ok: true }),
    option.column,
  );
}

/** The value must be a number within an inclusive bound. Blank passes. */
export function range(
  option: CellOption & { readonly column: string; readonly min?: number; readonly max?: number },
): CellRule {
  const { min, max } = option;
  return cellOf(
    option,
    `range:${option.column}`,
    (value) => {
      if (isBlank(value)) return { ok: true };
      const parsed = toNumber(value);
      if (parsed === null) {
        return { ok: false, message: option.message ?? `${option.column} must be a number` };
      }
      if (min !== undefined && parsed < min) {
        return { ok: false, message: option.message ?? `${option.column} must be at least ${min}` };
      }
      if (max !== undefined && parsed > max) {
        return { ok: false, message: option.message ?? `${option.column} must be at most ${max}` };
      }
      return { ok: true };
    },
    option.column,
  );
}

/**
 * The value must match a regular expression. Blank passes. The pattern is
 * re-created without the `g`/`y` flags: a sticky or global regexp carries
 * `lastIndex` between calls and would make every second row spuriously fail.
 */
export function pattern(
  option: CellOption & { readonly column: string; readonly regexp: RegExp },
): CellRule {
  const stateless = new RegExp(option.regexp.source, option.regexp.flags.replace(/[gy]/g, ''));
  const message = option.message ?? `${option.column} does not match ${String(option.regexp)}`;
  return cellOf(
    option,
    `pattern:${option.column}`,
    (value) =>
      isBlank(value) || stateless.test(String(value)) ? { ok: true } : { ok: false, message },
    option.column,
  );
}

/** The value must be one of an allowed set (compared by string form). */
export function oneOf(
  option: CellOption & { readonly column: string; readonly allowed: readonly unknown[] },
): CellRule {
  const allowed = new Set(option.allowed.map((v) => String(v)));
  const message =
    option.message ?? `${option.column} must be one of: ${option.allowed.map(String).join(', ')}`;
  return cellOf(
    option,
    `oneOf:${option.column}`,
    (value) => (isBlank(value) || allowed.has(String(value)) ? { ok: true } : { ok: false, message }),
    option.column,
  );
}

// -----------------------------------------------------------------------------
// Row-scope rule
// -----------------------------------------------------------------------------

/**
 * Compare two columns of the same row: `end_date > start_date`,
 * `discount <= price`. Blank on either side passes — pair with `required` when
 * the columns are mandatory.
 */
export function compareColumn(
  option: CellOption & {
    readonly left: string;
    readonly right: string;
    readonly operator: ScalarComparison;
  },
): RowRule {
  const { left, right, operator } = option;
  const message = option.message ?? `${left} must be ${operator} ${right}`;
  const rule: {
    kind: 'row';
    id: string;
    input: readonly string[];
    validate: RowRule['validate'];
    severity?: Severity;
    blockCommit?: boolean;
  } = {
    kind: 'row',
    id: option.id ?? `compare:${left}${operator}${right}`,
    input: [left, right],
    validate: (row) => {
      const order = compareValue(row[left], row[right]);
      if (order === null || satisfies(order, operator)) return { ok: true };
      return { ok: false, message, column: [left, right] };
    },
  };
  if (option.severity !== undefined) rule.severity = option.severity;
  if (option.blockCommit !== undefined) rule.blockCommit = option.blockCommit;
  return rule;
}

// -----------------------------------------------------------------------------
// Sheet-scope rules
// -----------------------------------------------------------------------------

interface SheetOption {
  readonly id?: string;
  readonly severity?: Severity;
  readonly blockCommit?: boolean;
  readonly message?: string;
}

function sheetOf(
  option: SheetOption,
  fallbackId: string,
  input: readonly string[],
  createAggregate: () => SheetAggregate,
): SheetRule {
  const rule: {
    kind: 'sheet';
    id: string;
    input: readonly string[];
    createAggregate: () => SheetAggregate;
    severity?: Severity;
    blockCommit?: boolean;
  } = { kind: 'sheet', id: option.id ?? fallbackId, input, createAggregate };
  if (option.severity !== undefined) rule.severity = option.severity;
  if (option.blockCommit !== undefined) rule.blockCommit = option.blockCommit;
  return rule;
}

/**
 * Incremental uniqueness index over one column or a composite key.
 *
 * Exported because it is the reference implementation of an invertible
 * aggregate: rows are tracked per key, a key is a duplicate exactly while it
 * holds more than one row, and `diagnose` walks only the duplicate keys rather
 * than the table.
 */
export class UniqueIndex implements SheetAggregate {
  private readonly keyOfRowKey = new Map<string, string>();
  private readonly rowKeyOfKey = new Map<string, Set<string>>();
  private readonly duplicate = new Set<string>();

  constructor(
    private readonly column: readonly string[],
    private readonly message?: string,
  ) {}

  seed(scan: SheetScan): void {
    this.keyOfRowKey.clear();
    this.rowKeyOfKey.clear();
    this.duplicate.clear();
    for (let i = 0; i < scan.numRows; i += 1) {
      const row: Record<string, unknown> = {};
      for (const c of this.column) row[c] = scan.getCell(i, c);
      this.add(scan.rowKeyOf(i), keyOfRow(row, this.column));
    }
  }

  apply(change: ResolvedChange): void {
    if (change.type !== 'insert') this.remove(change.rowKey);
    if (change.type !== 'delete') this.add(change.rowKey, keyOfRow(change.after, this.column));
  }

  diagnose(): readonly SheetFinding[] {
    const finding: SheetFinding[] = [];
    for (const key of this.duplicate) {
      const member = this.rowKeyOfKey.get(key);
      if (!member) continue;
      const shown = key.split(SEPARATOR).join(', ');
      for (const rowKey of member) {
        finding.push({
          message:
            this.message ?? `Duplicate ${this.column.join(' + ')}: ${shown} appears ${member.size} times`,
          rowKey,
          column: this.column,
        });
      }
    }
    return finding;
  }

  /** How many rows share a key. Exposed for tests and for adopter tooling. */
  countOf(key: string): number {
    return this.rowKeyOfKey.get(key)?.size ?? 0;
  }

  private add(rowKey: string, key: string | null): void {
    if (key === null) return;
    this.keyOfRowKey.set(rowKey, key);
    let member = this.rowKeyOfKey.get(key);
    if (!member) {
      member = new Set<string>();
      this.rowKeyOfKey.set(key, member);
    }
    member.add(rowKey);
    if (member.size > 1) this.duplicate.add(key);
  }

  private remove(rowKey: string): void {
    const key = this.keyOfRowKey.get(rowKey);
    if (key === undefined) return;
    this.keyOfRowKey.delete(rowKey);
    const member = this.rowKeyOfKey.get(key);
    if (!member) return;
    member.delete(rowKey);
    if (member.size <= 1) this.duplicate.delete(key);
    if (member.size === 0) this.rowKeyOfKey.delete(key);
  }
}

/** Every row's value in `column` (or the composite key) must be unique. */
export function unique(
  option: SheetOption & { readonly column: string | readonly string[] },
): SheetRule {
  const column = typeof option.column === 'string' ? [option.column] : option.column;
  return sheetOf(option, `unique:${column.join('+')}`, column, () =>
    option.message === undefined ? new UniqueIndex(column) : new UniqueIndex(column, option.message),
  );
}

/**
 * Running sum per group. The sum is adjusted by the delta of the changed row,
 * never recomputed — which is also why `tolerance` exists: a few million float
 * deltas accumulate a little drift, and an equality test on a float is a
 * promise nobody can keep.
 */
class SumIndex implements SheetAggregate {
  private readonly sum = new Map<string, number>();
  private readonly count = new Map<string, number>();

  constructor(
    private readonly column: string,
    private readonly total: number,
    private readonly groupBy: string | null,
    private readonly tolerance: number,
    private readonly message: string | undefined,
  ) {}

  seed(scan: SheetScan): void {
    this.sum.clear();
    this.count.clear();
    for (let i = 0; i < scan.numRows; i += 1) {
      const group = this.groupBy === null ? '' : String(scan.getCell(i, this.groupBy));
      this.adjust(group, toNumber(scan.getCell(i, this.column)) ?? 0, 1);
    }
  }

  apply(change: ResolvedChange): void {
    if (change.type !== 'insert') {
      const group = this.groupOf(change.before);
      this.adjust(group, -(toNumber(change.before[this.column]) ?? 0), -1);
    }
    if (change.type !== 'delete') {
      const group = this.groupOf(change.after);
      this.adjust(group, toNumber(change.after[this.column]) ?? 0, 1);
    }
  }

  diagnose(): readonly SheetFinding[] {
    const finding: SheetFinding[] = [];
    for (const [group, sum] of this.sum) {
      if (Math.abs(sum - this.total) <= this.tolerance) continue;
      const where = this.groupBy === null ? '' : ` for ${this.groupBy} '${group}'`;
      finding.push({
        message: this.message ?? `sum(${this.column})${where} is ${sum}, expected ${this.total}`,
        column: [this.column],
        ...(this.groupBy === null ? {} : { group }),
      });
    }
    return finding;
  }

  private groupOf(row: RowSnapshot): string {
    return this.groupBy === null ? '' : String(row[this.groupBy]);
  }

  private adjust(group: string, delta: number, countDelta: number): void {
    const count = (this.count.get(group) ?? 0) + countDelta;
    if (count <= 0) {
      // The group has no rows left; drop it rather than report a phantom.
      this.count.delete(group);
      this.sum.delete(group);
      return;
    }
    this.count.set(group, count);
    this.sum.set(group, (this.sum.get(group) ?? 0) + delta);
  }
}

/** The values of `column` must sum to `total`, optionally per group. */
export function sumEquals(
  option: SheetOption & {
    readonly column: string;
    readonly total: number;
    readonly groupBy?: string;
    readonly tolerance?: number;
  },
): SheetRule {
  const groupBy = option.groupBy ?? null;
  const input = groupBy === null ? [option.column] : [option.column, groupBy];
  return sheetOf(
    option,
    `sumEquals:${option.column}${groupBy === null ? '' : `/${groupBy}`}`,
    input,
    () => new SumIndex(option.column, option.total, groupBy, option.tolerance ?? 1e-9, option.message),
  );
}

/**
 * Referential integrity within one table: every non-blank value in `column`
 * must appear in some row's `target` column (the parent/child pattern —
 * `manager_id` must name an existing `employee_id`).
 *
 * The violating set is maintained, not searched: when a target value's count
 * crosses 0↔1 the rows referencing it are un-flagged or flagged in one step.
 */
class ReferenceIndex implements SheetAggregate {
  private readonly targetCount = new Map<string, number>();
  private readonly targetOfRow = new Map<string, string>();
  private readonly sourceOfRow = new Map<string, string>();
  private readonly rowOfSource = new Map<string, Set<string>>();
  private readonly violating = new Set<string>();

  constructor(
    private readonly column: string,
    private readonly target: string,
    private readonly message: string | undefined,
  ) {}

  seed(scan: SheetScan): void {
    this.targetCount.clear();
    this.targetOfRow.clear();
    this.sourceOfRow.clear();
    this.rowOfSource.clear();
    this.violating.clear();
    // Targets first: a source row may reference a target defined below it.
    for (let i = 0; i < scan.numRows; i += 1) {
      this.addTarget(scan.rowKeyOf(i), scan.getCell(i, this.target));
    }
    for (let i = 0; i < scan.numRows; i += 1) {
      this.addSource(scan.rowKeyOf(i), scan.getCell(i, this.column));
    }
  }

  apply(change: ResolvedChange): void {
    if (change.type !== 'insert') {
      this.removeSource(change.rowKey);
      this.removeTarget(change.rowKey);
    }
    if (change.type !== 'delete') {
      this.addTarget(change.rowKey, change.after[this.target]);
      this.addSource(change.rowKey, change.after[this.column]);
    }
  }

  diagnose(): readonly SheetFinding[] {
    const finding: SheetFinding[] = [];
    for (const rowKey of this.violating) {
      const value = this.sourceOfRow.get(rowKey) ?? '';
      finding.push({
        message: this.message ?? `${this.column} '${value}' has no matching ${this.target}`,
        rowKey,
        column: [this.column],
      });
    }
    return finding;
  }

  private addTarget(rowKey: string, value: unknown): void {
    const key = keyOfValue(value);
    if (key === null) return;
    this.targetOfRow.set(rowKey, key);
    const count = (this.targetCount.get(key) ?? 0) + 1;
    this.targetCount.set(key, count);
    if (count === 1) {
      for (const referring of this.rowOfSource.get(key) ?? []) this.violating.delete(referring);
    }
  }

  private removeTarget(rowKey: string): void {
    const key = this.targetOfRow.get(rowKey);
    if (key === undefined) return;
    this.targetOfRow.delete(rowKey);
    const count = (this.targetCount.get(key) ?? 0) - 1;
    if (count <= 0) {
      this.targetCount.delete(key);
      for (const referring of this.rowOfSource.get(key) ?? []) this.violating.add(referring);
    } else {
      this.targetCount.set(key, count);
    }
  }

  private addSource(rowKey: string, value: unknown): void {
    const key = keyOfValue(value);
    if (key === null) return;
    this.sourceOfRow.set(rowKey, key);
    let member = this.rowOfSource.get(key);
    if (!member) {
      member = new Set<string>();
      this.rowOfSource.set(key, member);
    }
    member.add(rowKey);
    if ((this.targetCount.get(key) ?? 0) === 0) this.violating.add(rowKey);
  }

  private removeSource(rowKey: string): void {
    const key = this.sourceOfRow.get(rowKey);
    if (key === undefined) return;
    this.sourceOfRow.delete(rowKey);
    this.violating.delete(rowKey);
    const member = this.rowOfSource.get(key);
    if (!member) return;
    member.delete(rowKey);
    if (member.size === 0) this.rowOfSource.delete(key);
  }
}

/** Every non-blank `column` value must appear in some row's `target` column. */
export function referentialIntegrity(
  option: SheetOption & { readonly column: string; readonly target: string },
): SheetRule {
  return sheetOf(
    option,
    `reference:${option.column}->${option.target}`,
    [option.column, option.target],
    () => new ReferenceIndex(option.column, option.target, option.message),
  );
}

/** Row count must stay within bounds. The cheapest possible aggregate. */
class RowCountIndex implements SheetAggregate {
  private count = 0;

  constructor(
    private readonly min: number,
    private readonly max: number,
    private readonly message: string | undefined,
  ) {}

  seed(scan: SheetScan): void {
    this.count = scan.numRows;
  }

  apply(change: ResolvedChange): void {
    if (change.type === 'insert') this.count += 1;
    else if (change.type === 'delete') this.count -= 1;
  }

  diagnose(): readonly SheetFinding[] {
    if (this.count >= this.min && this.count <= this.max) return [];
    return [
      {
        message:
          this.message ??
          `row count is ${this.count}, must be between ${this.min} and ${this.max}`,
      },
    ];
  }
}

/** The table must hold between `min` and `max` rows (inclusive). */
export function rowCountBetween(
  option: SheetOption & { readonly min?: number; readonly max?: number },
): SheetRule {
  const min = option.min ?? 0;
  const max = option.max ?? Number.MAX_SAFE_INTEGER;
  return sheetOf(
    option,
    `rowCount:${min}-${max}`,
    [],
    () => new RowCountIndex(min, max, option.message),
  );
}
