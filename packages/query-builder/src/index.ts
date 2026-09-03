// =============================================================================
// @onegrid/query-builder
//
// The headless MODEL and edit algebra behind a visual query builder. A UI —
// the column tool panel, a modal, a sidebar — is a thin shell over this: it
// renders the AST, calls `operatorForType` to fill a dropdown, calls an edit
// operation on click, and paints `validateQuery`'s errors onto the exact node
// each one addresses. No rendering lives here; this repo keeps UI-framework
// code in the adapter packages.
//
// Design notes:
//   - THE AST IS A TREE OF GROUPS. A group carries an operator ('and' | 'or' |
//     'not') and an ordered child list; a leaf is a `{ column, operator, value }`
//     predicate. Nesting is arbitrary. The root is ALWAYS a group, even when
//     empty, so a UI never has to special-case "no query yet" and so every
//     node has a parent to be inserted into or removed from.
//   - NODES ARE ADDRESSED BY PATH, not by id. A `NodePath` is the sequence of
//     child indices from the root: `[]` is the root, `[0, 2]` is the third
//     child of the first child. Paths fall straight out of the render tree a
//     UI already walks, they need no id bookkeeping across an immutable edit,
//     and they give validation errors somewhere precise to point.
//   - EVERY EDIT RETURNS A NEW AST. Nothing is mutated — not the root, not the
//     untouched siblings' arrays. That makes undo a matter of keeping the
//     previous root around, and makes `===` a valid change check for a
//     memoising renderer.
//   - THE OPERATOR CATALOGUE IS DERIVED FROM COLUMN TYPE. `operatorForType`
//     is the single source of truth: a `date32` column offers before / after /
//     between / inLast, a `utf8` column offers contains / startsWith /
//     matches, numerics offer the comparison set. Validation rejects any
//     operator the catalogue would not have offered, so a UI that populates
//     its dropdown from this function can never build an invalid query.
//   - COMPILATION IS THE POINT. `toFilterModel` emits the protocol's own
//     `FilterModel` vocabulary — no parallel vocabulary is invented here —
//     so the builder drives every existing oneGrid adapter for free.
//     `toSql` and `toMongo` exist for adopters querying a database directly.
//   - VALUES ARE ALWAYS PARAMETERISED in SQL. `toSql` never interpolates a
//     value into the text, not even a number, not even a boolean. The only
//     things that reach the text are dialect-quoted identifiers, fixed
//     keywords, and placeholders. This is load-bearing and tested directly.
//   - RELATIVE DATE OPERATORS RESOLVE AT COMPILE TIME. `inLast(3, 'day')` is
//     stored relative — that is what the user chose and what should persist —
//     and is resolved against a `now` (injectable, defaulting to the wall
//     clock) into a concrete range when compiled. Compilation is therefore a
//     pure function of (ast, now), which is what makes it testable.
// =============================================================================

import type {
  ColumnSchema,
  ColumnType,
  ComparisonFilter,
  ComparisonOperator,
  FilterModel,
  FilterNode,
  Schema,
} from '@onegrid/protocol';

// -----------------------------------------------------------------------------
// AST
// -----------------------------------------------------------------------------

/**
 * The operator vocabulary a leaf predicate can use.
 *
 * The first sixteen are spelled exactly as the protocol's `ComparisonOperator`
 * — deliberately, so `toFilterModel` / `fromFilterModel` round-trip them with
 * no translation table and therefore no lossy corner. The remainder
 * (`matches`, `before`, `after`, `inLast`, `inNext`, `isTrue`, `isFalse`) are
 * builder-level affordances, because a human picking from a dropdown thinks in
 * them; they lower onto the protocol vocabulary where they can and are
 * rejected loudly by `toFilterModel` where they cannot.
 *
 * @public
 */
export type QueryOperator =
  | ComparisonOperator
  | 'matches'
  | 'before'
  | 'after'
  | 'inLast'
  | 'inNext'
  | 'isTrue'
  | 'isFalse';

/** @public */
export type GroupOperator = 'and' | 'or' | 'not';

/**
 * Unit for the relative-date operators (`inLast` / `inNext`).
 * @public
 */
export type DateUnit = 'minute' | 'hour' | 'day' | 'week' | 'month' | 'quarter' | 'year';

/**
 * A leaf predicate: one column, one operator, and whatever operand that
 * operator's arity calls for.
 * @public
 */
export interface QueryCondition {
  readonly kind: 'condition';
  /** Column id, matching a `ColumnSchema.id` in the schema. */
  readonly column: string;
  readonly operator: QueryOperator;
  /**
   * Scalar operand — for eq/neq/lt/lte/gt/gte/before/after/contains/… — and
   * the numeric magnitude for inLast/inNext.
   */
  readonly value?: unknown;
  /**
   * Operand list — for in/notIn (any length) and between/notBetween (exactly
   * two: lower then upper). Named singularly per repo convention.
   */
  readonly operand?: ReadonlyArray<unknown>;
  /** Unit that `value` counts, for inLast/inNext only. */
  readonly unit?: DateUnit;
  /** String operators only. Default false — matching the protocol default. */
  readonly caseSensitive?: boolean;
}

/**
 * A group: an operator applied to an ordered child list. `not` negates the
 * conjunction of its children, so a `not` group with two children means
 * NOT (a AND b).
 * @public
 */
export interface QueryGroup {
  readonly kind: 'group';
  readonly operator: GroupOperator;
  readonly child: ReadonlyArray<QueryNode>;
}

/** @public */
export type QueryNode = QueryGroup | QueryCondition;

/**
 * Address of a node as the sequence of child indices from the root. `[]` is
 * the root itself.
 * @public
 */
export type NodePath = ReadonlyArray<number>;

/**
 * How many operands an operator consumes.
 *
 * - `none` — isNull / isNotNull / isTrue / isFalse
 * - `scalar` — one `value`
 * - `list` — one or more entries in `operand`
 * - `range` — exactly two entries in `operand`
 * - `duration` — a numeric `value` plus a `unit`
 *
 * @public
 */
export type OperatorArity = 'none' | 'scalar' | 'list' | 'range' | 'duration';

/** @public */
export function isGroup(node: QueryNode): node is QueryGroup {
  return node.kind === 'group';
}

/** @public */
export function isCondition(node: QueryNode): node is QueryCondition {
  return node.kind === 'condition';
}

/**
 * A fresh empty root. Every AST starts here; an empty root means "no filter"
 * and compiles to `null` / `1 = 1` / `{}`.
 * @public
 */
export function emptyQuery(operator: GroupOperator = 'and'): QueryGroup {
  return { kind: 'group', operator, child: [] };
}

/**
 * Resolve a path to the node it addresses, or `undefined` when the path runs
 * off the tree. A UI uses this to read back the node it just edited.
 * @public
 */
export function nodeAt(root: QueryNode, path: NodePath): QueryNode | undefined {
  let current: QueryNode = root;
  for (const index of path) {
    if (!isGroup(current)) return undefined;
    const next = current.child[index];
    if (next === undefined) return undefined;
    current = next;
  }
  return current;
}

/**
 * Count the leaf predicates in a subtree — the number a summary chip shows
 * next to the description.
 * @public
 */
export function countCondition(node: QueryNode): number {
  if (isCondition(node)) return 1;
  let total = 0;
  for (const c of node.child) total += countCondition(c);
  return total;
}

// -----------------------------------------------------------------------------
// Type → operator catalogue
// -----------------------------------------------------------------------------

const NUMERIC_TYPE: ReadonlySet<ColumnType> = new Set<ColumnType>([
  'int8',
  'int16',
  'int32',
  'int64',
  'uint8',
  'uint16',
  'uint32',
  'uint64',
  'float32',
  'float64',
  'decimal',
]);

const INTEGER_TYPE: ReadonlySet<ColumnType> = new Set<ColumnType>([
  'int8',
  'int16',
  'int32',
  'int64',
  'uint8',
  'uint16',
  'uint32',
  'uint64',
]);

const DATE_TYPE: ReadonlySet<ColumnType> = new Set<ColumnType>([
  'date32',
  'date64',
  'timestamp',
  'timestamp_tz',
]);

const TIME_TYPE: ReadonlySet<ColumnType> = new Set<ColumnType>(['time32', 'time64']);

const NULLABILITY_OPERATOR: ReadonlyArray<QueryOperator> = ['isNull', 'isNotNull'];

const NUMERIC_OPERATOR: ReadonlyArray<QueryOperator> = [
  'eq',
  'neq',
  'lt',
  'lte',
  'gt',
  'gte',
  'between',
  'notBetween',
  'in',
  'notIn',
  ...NULLABILITY_OPERATOR,
];

const TEXT_OPERATOR: ReadonlyArray<QueryOperator> = [
  'eq',
  'neq',
  'contains',
  'notContains',
  'startsWith',
  'endsWith',
  'matches',
  'in',
  'notIn',
  ...NULLABILITY_OPERATOR,
];

const DATE_OPERATOR: ReadonlyArray<QueryOperator> = [
  'eq',
  'neq',
  'before',
  'after',
  'between',
  'notBetween',
  'inLast',
  'inNext',
  ...NULLABILITY_OPERATOR,
];

const TIME_OPERATOR: ReadonlyArray<QueryOperator> = [
  'eq',
  'neq',
  'lt',
  'lte',
  'gt',
  'gte',
  'between',
  'notBetween',
  ...NULLABILITY_OPERATOR,
];

const BOOL_OPERATOR: ReadonlyArray<QueryOperator> = [
  'isTrue',
  'isFalse',
  'eq',
  'neq',
  ...NULLABILITY_OPERATOR,
];

// Opaque types (binary/list/struct/map/json/unknown) get equality and
// nullability only. Anything richer would need a column-specific extractor the
// builder has no way to know about, and offering an operator the backend
// cannot honour is worse than offering none.
const OPAQUE_OPERATOR: ReadonlyArray<QueryOperator> = ['eq', 'neq', ...NULLABILITY_OPERATOR];

/**
 * The operator list a UI should offer for a column of this type, in the order
 * it should render them (most-used first).
 * is shared, not copied per call.
 * @public
 */
export function operatorForType(type: ColumnType): ReadonlyArray<QueryOperator> {
  if (NUMERIC_TYPE.has(type)) return NUMERIC_OPERATOR;
  if (type === 'utf8') return TEXT_OPERATOR;
  if (type === 'bool') return BOOL_OPERATOR;
  if (DATE_TYPE.has(type)) return DATE_OPERATOR;
  if (TIME_TYPE.has(type)) return TIME_OPERATOR;
  return OPAQUE_OPERATOR;
}

const ARITY: Readonly<Record<QueryOperator, OperatorArity>> = {
  eq: 'scalar',
  neq: 'scalar',
  lt: 'scalar',
  lte: 'scalar',
  gt: 'scalar',
  gte: 'scalar',
  before: 'scalar',
  after: 'scalar',
  contains: 'scalar',
  notContains: 'scalar',
  startsWith: 'scalar',
  endsWith: 'scalar',
  matches: 'scalar',
  in: 'list',
  notIn: 'list',
  between: 'range',
  notBetween: 'range',
  inLast: 'duration',
  inNext: 'duration',
  isNull: 'none',
  isNotNull: 'none',
  isTrue: 'none',
  isFalse: 'none',
};

/**
 * How many operands the operator needs — what a UI switches on to decide
 * whether to render no input, one input, two, or a chip list.
 * @public
 */
export function operatorArity(operator: QueryOperator): OperatorArity {
  return ARITY[operator];
}

const OPERATOR_LABEL: Readonly<Record<QueryOperator, string>> = {
  eq: 'equals',
  neq: 'does not equal',
  lt: 'less than',
  lte: 'at most',
  gt: 'greater than',
  gte: 'at least',
  before: 'before',
  after: 'after',
  contains: 'contains',
  notContains: 'does not contain',
  startsWith: 'starts with',
  endsWith: 'ends with',
  matches: 'matches regex',
  in: 'is one of',
  notIn: 'is not one of',
  between: 'between',
  notBetween: 'not between',
  inLast: 'in the last',
  inNext: 'in the next',
  isNull: 'is empty',
  isNotNull: 'is not empty',
  isTrue: 'is true',
  isFalse: 'is false',
};

/**
 * Human label for an operator — what a dropdown option shows.
 * @public
 */
export function operatorLabel(operator: QueryOperator): string {
  return OPERATOR_LABEL[operator];
}

const DATE_UNIT: ReadonlySet<string> = new Set<DateUnit>([
  'minute',
  'hour',
  'day',
  'week',
  'month',
  'quarter',
  'year',
]);

// -----------------------------------------------------------------------------
// Value coercion
// -----------------------------------------------------------------------------

interface CoerceResult {
  readonly ok: boolean;
  readonly value: unknown;
}

const BAD: CoerceResult = { ok: false, value: undefined };

/**
 * Can this raw operand (typically a string straight out of a text input) be
 * read as a value of the column's type, and what is it once read? Validation
 * calls this per operand; compilation calls it to normalise before emitting,
 * so `"42"` typed into a numeric filter reaches the database as the number 42.
 */
function coerce(raw: unknown, type: ColumnType): CoerceResult {
  if (raw === null || raw === undefined) return BAD;

  if (NUMERIC_TYPE.has(type)) {
    if (typeof raw === 'number') return Number.isFinite(raw) ? { ok: true, value: raw } : BAD;
    if (typeof raw === 'bigint') return { ok: true, value: raw };
    if (typeof raw === 'string') {
      const trimmed = raw.trim();
      if (trimmed === '') return BAD;
      const n = Number(trimmed);
      if (!Number.isFinite(n)) return BAD;
      // int64/uint64 beyond the double-safe range must not silently lose
      // precision — hand back a bigint so the driver binds it exactly.
      if (INTEGER_TYPE.has(type) && !Number.isSafeInteger(n) && /^-?\d+$/.test(trimmed)) {
        return { ok: true, value: BigInt(trimmed) };
      }
      return { ok: true, value: n };
    }
    return BAD;
  }

  if (type === 'bool') {
    if (typeof raw === 'boolean') return { ok: true, value: raw };
    if (typeof raw === 'number') {
      if (raw === 0) return { ok: true, value: false };
      if (raw === 1) return { ok: true, value: true };
      return BAD;
    }
    if (typeof raw === 'string') {
      const lowered = raw.trim().toLowerCase();
      if (lowered === 'true') return { ok: true, value: true };
      if (lowered === 'false') return { ok: true, value: false };
      return BAD;
    }
    return BAD;
  }

  if (DATE_TYPE.has(type)) {
    if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? BAD : { ok: true, value: raw };
    if (typeof raw === 'number') {
      return Number.isFinite(raw) ? { ok: true, value: new Date(raw) } : BAD;
    }
    if (typeof raw === 'string') {
      const t = Date.parse(raw);
      return Number.isNaN(t) ? BAD : { ok: true, value: new Date(t) };
    }
    return BAD;
  }

  if (TIME_TYPE.has(type)) {
    // A time-of-day has no date part to anchor to, so it stays a string in
    // HH:MM[:SS[.mmm]] form (or a raw offset number the backend interprets).
    if (typeof raw === 'number') return Number.isFinite(raw) ? { ok: true, value: raw } : BAD;
    if (typeof raw === 'string' && /^\d{1,2}:\d{2}(:\d{2}(\.\d{1,9})?)?$/.test(raw.trim())) {
      return { ok: true, value: raw.trim() };
    }
    return BAD;
  }

  if (type === 'utf8') {
    if (typeof raw === 'string') return { ok: true, value: raw };
    if (typeof raw === 'number' || typeof raw === 'boolean' || typeof raw === 'bigint') {
      return { ok: true, value: String(raw) };
    }
    return BAD;
  }

  // binary / list / struct / map / json / unknown — the builder has no basis
  // to judge these, so it passes them through rather than inventing a rule.
  return { ok: true, value: raw };
}

// -----------------------------------------------------------------------------
// Validation
// -----------------------------------------------------------------------------

/** @public */
export type QueryErrorCode =
  | 'unknown-column'
  | 'operator-not-allowed'
  | 'value-not-coercible'
  | 'missing-value'
  | 'wrong-operand-count'
  | 'invalid-regex'
  | 'invalid-unit'
  | 'empty-group';

/**
 * A validation failure, addressed at the exact node that caused it so a UI can
 * outline that row and nothing else. `operandIndex` narrows further to one
 * chip in an `in` list or one end of a `between`.
 * @public
 */
export interface QueryValidationError {
  readonly code: QueryErrorCode;
  readonly path: NodePath;
  readonly message: string;
  readonly column?: string;
  readonly operator?: QueryOperator;
  readonly operandIndex?: number;
}

/**
 * Check an AST against a schema. Returns every problem found — validation does
 * not stop at the first, because a UI wants to mark all of them at once.
 * An empty array means the query is safe to compile.
 * @public
 */
export function validateQuery(root: QueryNode, schema: Schema): ReadonlyArray<QueryValidationError> {
  const index = schemaIndex(schema);
  const error: QueryValidationError[] = [];
  walkValidate(root, [], index, error);
  return error;
}

function schemaIndex(schema: Schema): ReadonlyMap<string, ColumnSchema> {
  const map = new Map<string, ColumnSchema>();
  for (const column of schema) map.set(column.id, column);
  return map;
}

function walkValidate(
  node: QueryNode,
  path: NodePath,
  index: ReadonlyMap<string, ColumnSchema>,
  out: QueryValidationError[],
): void {
  if (isGroup(node)) {
    if (node.child.length === 0) {
      out.push({
        code: 'empty-group',
        path,
        message: `Empty ${node.operator.toUpperCase()} group — add a condition or remove the group.`,
      });
      return;
    }
    node.child.forEach((c, i) => walkValidate(c, [...path, i], index, out));
    return;
  }

  const column = index.get(node.column);
  if (column === undefined) {
    out.push({
      code: 'unknown-column',
      path,
      column: node.column,
      operator: node.operator,
      message: `Unknown column "${node.column}".`,
    });
    return;
  }

  const allowed = operatorForType(column.type);
  if (!allowed.includes(node.operator)) {
    out.push({
      code: 'operator-not-allowed',
      path,
      column: node.column,
      operator: node.operator,
      message: `Operator "${node.operator}" is not valid for a ${column.type} column.`,
    });
    return;
  }

  const arity = operatorArity(node.operator);
  const label = column.displayName ?? column.id;

  switch (arity) {
    case 'none':
      return;

    case 'scalar': {
      if (node.value === undefined || node.value === null) {
        out.push({
          code: 'missing-value',
          path,
          column: node.column,
          operator: node.operator,
          message: `"${label} ${operatorLabel(node.operator)}" needs a value.`,
        });
        return;
      }
      if (node.operator === 'matches') {
        // A regex operand is text no matter the column type, and an
        // unparseable pattern is its own distinct failure.
        if (typeof node.value !== 'string') {
          out.push({
            code: 'value-not-coercible',
            path,
            column: node.column,
            operator: node.operator,
            message: `"${label} matches regex" needs a pattern string.`,
          });
          return;
        }
        try {
          new RegExp(node.value);
        } catch {
          out.push({
            code: 'invalid-regex',
            path,
            column: node.column,
            operator: node.operator,
            message: `"${node.value}" is not a valid regular expression.`,
          });
        }
        return;
      }
      pushCoerceError(node, path, column, node.value, undefined, out);
      return;
    }

    case 'list': {
      const operand = node.operand;
      if (operand === undefined || operand.length === 0) {
        out.push({
          code: 'wrong-operand-count',
          path,
          column: node.column,
          operator: node.operator,
          message: `"${label} ${operatorLabel(node.operator)}" needs at least one value.`,
        });
        return;
      }
      operand.forEach((v, i) => pushCoerceError(node, path, column, v, i, out));
      return;
    }

    case 'range': {
      const operand = node.operand;
      if (operand === undefined || operand.length !== 2) {
        out.push({
          code: 'wrong-operand-count',
          path,
          column: node.column,
          operator: node.operator,
          message: `"${label} ${operatorLabel(node.operator)}" needs exactly two values.`,
        });
        return;
      }
      operand.forEach((v, i) => pushCoerceError(node, path, column, v, i, out));
      return;
    }

    case 'duration': {
      if (typeof node.value !== 'number' || !Number.isFinite(node.value) || node.value <= 0) {
        out.push({
          code: 'missing-value',
          path,
          column: node.column,
          operator: node.operator,
          message: `"${label} ${operatorLabel(node.operator)}" needs a positive number.`,
        });
      }
      if (node.unit === undefined || !DATE_UNIT.has(node.unit)) {
        out.push({
          code: 'invalid-unit',
          path,
          column: node.column,
          operator: node.operator,
          message: `"${label} ${operatorLabel(node.operator)}" needs a unit (minute, hour, day, week, month, quarter, year).`,
        });
      }
      return;
    }
  }
}

function pushCoerceError(
  node: QueryCondition,
  path: NodePath,
  column: ColumnSchema,
  raw: unknown,
  operandIndex: number | undefined,
  out: QueryValidationError[],
): void {
  if (coerce(raw, column.type).ok) return;
  const base = {
    code: 'value-not-coercible' as const,
    path,
    column: node.column,
    operator: node.operator,
    message: `${describeValue(raw)} is not a valid ${column.type} value for "${column.displayName ?? column.id}".`,
  };
  out.push(operandIndex === undefined ? base : { ...base, operandIndex });
}

function describeValue(raw: unknown): string {
  if (raw === null) return 'null';
  if (raw === undefined) return 'undefined';
  if (typeof raw === 'string') return JSON.stringify(raw);
  if (typeof raw === 'number' || typeof raw === 'boolean' || typeof raw === 'bigint') {
    return String(raw);
  }
  if (raw instanceof Date) return raw.toISOString();
  return Object.prototype.toString.call(raw);
}

// -----------------------------------------------------------------------------
// Relative-date resolution
// -----------------------------------------------------------------------------

const MS: Readonly<Record<'minute' | 'hour' | 'day' | 'week', number>> = {
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  week: 604_800_000,
};

/**
 * Shift a date by `count` units. Calendar units (month/quarter/year) go
 * through the Date arithmetic so month lengths and leap years behave; fixed
 * units are plain millisecond maths.
 */
function shift(from: Date, count: number, unit: DateUnit): Date {
  if (unit === 'month' || unit === 'quarter' || unit === 'year') {
    const out = new Date(from.getTime());
    if (unit === 'year') out.setFullYear(out.getFullYear() + count);
    else out.setMonth(out.getMonth() + count * (unit === 'quarter' ? 3 : 1));
    return out;
  }
  return new Date(from.getTime() + count * MS[unit]);
}

/**
 * The concrete [lower, upper] window an `inLast` / `inNext` condition means at
 * a given instant. Exported because a UI wants to show the resolved range in a
 * tooltip ("in the last 7 days — 2026-08-28 to 2026-09-04").
 * @public
 */
export function resolveDuration(
  operator: 'inLast' | 'inNext',
  count: number,
  unit: DateUnit,
  now: Date,
): readonly [Date, Date] {
  const other = shift(now, operator === 'inLast' ? -count : count, unit);
  return operator === 'inLast' ? [other, now] : [now, other];
}

// -----------------------------------------------------------------------------
// Compilation → protocol FilterModel
// -----------------------------------------------------------------------------

/**
 * Thrown when an AST cannot be expressed in the requested target. The `path`
 * addresses the offending node so a UI can point at it.
 * @public
 */
export class QueryCompileError extends Error {
  readonly path: NodePath;
  constructor(message: string, path: NodePath) {
    super(message);
    this.name = 'QueryCompileError';
    this.path = path;
  }
}

/** @public */
export interface CompileOption {
  /** Instant that relative-date operators resolve against. Default `new Date()`. */
  readonly now?: Date;
  /**
   * Schema used to coerce raw operands ("42" → 42) before emitting. Optional:
   * without it operands are emitted exactly as stored.
   */
  readonly schema?: Schema;
}

const PROTOCOL_OPERATOR: ReadonlySet<string> = new Set<ComparisonOperator>([
  'eq',
  'neq',
  'lt',
  'lte',
  'gt',
  'gte',
  'in',
  'notIn',
  'contains',
  'notContains',
  'startsWith',
  'endsWith',
  'isNull',
  'isNotNull',
  'between',
  'notBetween',
]);

/**
 * Is every leaf in this subtree expressible in the protocol's own operator
 * vocabulary with no lowering at all? That subset is exactly the one
 * `toFilterModel` / `fromFilterModel` round-trip losslessly.
 * @public
 */
export function isProtocolExpressible(node: QueryNode): boolean {
  if (isGroup(node)) return node.child.every(isProtocolExpressible);
  return PROTOCOL_OPERATOR.has(node.operator);
}

/**
 * Compile to the protocol's `FilterModel` — the vocabulary every oneGrid
 * adapter already speaks, so a query built here drives all of them for free.
 *
 * An empty root compiles to `null` ("no filter"), which is what the protocol
 * means by absence. Builder-only operators lower where they can (`before` →
 * `lt`, `isTrue` → `eq true`, `inLast` → a resolved `between`); `matches` has
 * no protocol equivalent and throws a `QueryCompileError` naming its path.
 * @public
 */
export function toFilterModel(root: QueryNode, option: CompileOption = {}): FilterModel {
  const now = option.now ?? new Date();
  const index = option.schema === undefined ? undefined : schemaIndex(option.schema);
  if (isGroup(root) && root.child.length === 0) return null;
  return filterNodeOf(root, [], now, index);
}

function filterNodeOf(
  node: QueryNode,
  path: NodePath,
  now: Date,
  index: ReadonlyMap<string, ColumnSchema> | undefined,
): FilterNode {
  if (isGroup(node)) {
    return {
      type: 'logical',
      op: node.operator,
      filters: node.child.map((c, i) => filterNodeOf(c, [...path, i], now, index)),
    };
  }
  return comparisonOf(node, path, now, index);
}

function comparisonOf(
  node: QueryCondition,
  path: NodePath,
  now: Date,
  index: ReadonlyMap<string, ColumnSchema> | undefined,
): ComparisonFilter {
  const type = index?.get(node.column)?.type;
  const one = (raw: unknown): unknown => (type === undefined ? raw : (coerce(raw, type).value ?? raw));
  const many = (raw: ReadonlyArray<unknown>): ReadonlyArray<unknown> => raw.map(one);

  const tail =
    node.caseSensitive === undefined ? {} : ({ caseSensitive: node.caseSensitive } as const);

  switch (node.operator) {
    case 'matches':
      throw new QueryCompileError(
        'The "matches" operator has no FilterModel equivalent — the protocol has no regex comparison. Use contains/startsWith/endsWith, or compile to SQL or Mongo instead.',
        path,
      );

    case 'isTrue':
      return { type: 'comparison', columnId: node.column, op: 'eq', value: true };
    case 'isFalse':
      return { type: 'comparison', columnId: node.column, op: 'eq', value: false };

    case 'before':
      return { type: 'comparison', columnId: node.column, op: 'lt', value: one(node.value) };
    case 'after':
      return { type: 'comparison', columnId: node.column, op: 'gt', value: one(node.value) };

    case 'inLast':
    case 'inNext': {
      const [lower, upper] = durationWindow(node, path, now);
      return { type: 'comparison', columnId: node.column, op: 'between', values: [lower, upper] };
    }

    case 'isNull':
    case 'isNotNull':
      return { type: 'comparison', columnId: node.column, op: node.operator };

    case 'in':
    case 'notIn':
    case 'between':
    case 'notBetween':
      return {
        type: 'comparison',
        columnId: node.column,
        op: node.operator,
        values: many(node.operand ?? []),
      };

    default:
      return {
        type: 'comparison',
        columnId: node.column,
        op: node.operator,
        value: one(node.value),
        ...tail,
      };
  }
}

function durationWindow(node: QueryCondition, path: NodePath, now: Date): readonly [Date, Date] {
  if (node.operator !== 'inLast' && node.operator !== 'inNext') {
    throw new QueryCompileError('Not a relative-date operator.', path);
  }
  if (typeof node.value !== 'number' || !Number.isFinite(node.value)) {
    throw new QueryCompileError(`"${node.operator}" needs a numeric count.`, path);
  }
  if (node.unit === undefined || !DATE_UNIT.has(node.unit)) {
    throw new QueryCompileError(`"${node.operator}" needs a valid unit.`, path);
  }
  return resolveDuration(node.operator, node.value, node.unit, now);
}

/**
 * Read a protocol `FilterModel` back into an AST. `null` becomes an empty root
 * group. A `ComparisonFilter` at the top becomes the sole child of an implicit
 * AND root, because the AST's root is always a group.
 *
 * This is the inverse of `toFilterModel` over the protocol-expressible subset:
 * for any AST where `isProtocolExpressible` holds,
 * `fromFilterModel(toFilterModel(ast))` deep-equals `ast`.
 * @public
 */
export function fromFilterModel(model: FilterModel): QueryGroup {
  if (model === null) return emptyQuery();
  const node = queryNodeOf(model);
  return isGroup(node) ? node : { kind: 'group', operator: 'and', child: [node] };
}

function queryNodeOf(filter: FilterNode): QueryNode {
  if (filter.type === 'logical') {
    return { kind: 'group', operator: filter.op, child: filter.filters.map(queryNodeOf) };
  }
  const base = { kind: 'condition' as const, column: filter.columnId, operator: filter.op };
  const withCase =
    filter.caseSensitive === undefined ? base : { ...base, caseSensitive: filter.caseSensitive };
  switch (filter.op) {
    case 'in':
    case 'notIn':
    case 'between':
    case 'notBetween':
      return { ...withCase, operand: [...(filter.values ?? [])] };
    case 'isNull':
    case 'isNotNull':
      return withCase;
    default:
      return filter.value === undefined ? withCase : { ...withCase, value: filter.value };
  }
}

// -----------------------------------------------------------------------------
// Compilation → SQL
// -----------------------------------------------------------------------------

/** @public */
export type SqlDialect = 'postgres' | 'mysql' | 'sqlite' | 'clickhouse';

/**
 * A parameterised SQL fragment. `text` is a boolean expression suitable for a
 * WHERE clause and contains NO values — only quoted identifiers, keywords and
 * placeholders. `param` is positional (`$1`/`?` order); `named` is the same
 * values keyed `p0`, `p1`, … for ClickHouse, whose driver binds by name.
 * @public
 */
export interface SqlQuery {
  readonly text: string;
  readonly param: ReadonlyArray<unknown>;
  readonly named: Readonly<Record<string, unknown>>;
}

/** @public */
export interface SqlOption extends CompileOption {
  /**
   * Prefix qualifying every column, e.g. `t` to emit `"t"."price"`. Quoted
   * with the same dialect rule as the column itself.
   */
  readonly tableAlias?: string;
}

// LIKE metacharacters are escaped with `!` rather than the more usual
// backslash: MySQL processes backslash escapes inside string literals before
// LIKE ever sees them, so `ESCAPE '\'` is a portability trap. `!` needs no
// escaping in any of the four dialects.
const LIKE_ESCAPE_CHAR = '!';

function likeEscape(text: string): string {
  return text.replace(/[!%_]/g, (m) => `${LIKE_ESCAPE_CHAR}${m}`);
}

function quoteIdent(name: string, dialect: SqlDialect): string {
  if (dialect === 'mysql') return `\`${name.replace(/`/g, '``')}\``;
  return `"${name.replace(/"/g, '""')}"`;
}

// ClickHouse binds parameters by name AND type — `{p0:String}` — so a
// placeholder needs to know what it is carrying. Everything else is inferred
// from the column schema where one was supplied, and falls back to String,
// which ClickHouse will cast from its text form.
function clickhouseType(type: ColumnType | undefined): string {
  if (type === undefined) return 'String';
  if (INTEGER_TYPE.has(type)) return 'Int64';
  if (NUMERIC_TYPE.has(type)) return 'Float64';
  if (type === 'bool') return 'Bool';
  if (DATE_TYPE.has(type)) return 'DateTime64(3)';
  return 'String';
}

interface ParamBag {
  readonly bind: (value: unknown, chType: string) => string;
  readonly value: unknown[];
  readonly named: Record<string, unknown>;
}

function makeParamBag(dialect: SqlDialect): ParamBag {
  const value: unknown[] = [];
  const named: Record<string, unknown> = {};
  return {
    value,
    named,
    bind(v: unknown, chType: string): string {
      const i = value.length;
      value.push(v);
      named[`p${i}`] = v;
      if (dialect === 'postgres') return `$${i + 1}`;
      if (dialect === 'clickhouse') return `{p${i}:${chType}}`;
      return '?';
    },
  };
}

/**
 * Compile to a parameterised SQL boolean expression.
 *
 * Values NEVER reach `text` — every operand becomes a placeholder and lands in
 * `param`. That is not a style preference: it is the only thing standing
 * between a filter typed into a grid header and an injection, and it is
 * asserted directly in the test suite with quote- and comment-bearing input.
 *
 * An empty group compiles to a constant (`1 = 1` for AND/NOT, `1 = 0` for OR)
 * rather than throwing, so a half-built query still produces runnable SQL
 * while the user is typing.
 *
 * Dialect notes: `matches` emits `~` on postgres, `REGEXP` on mysql and
 * sqlite (sqlite needs the host to register a REGEXP function — it has no
 * built-in one), and `match()` on clickhouse. ClickHouse takes its native
 * `position`/`startsWith`/`endsWith` for substring work rather than LIKE,
 * because it has no `ESCAPE` clause.
 * @public
 */
export function toSql(root: QueryNode, dialect: SqlDialect, option: SqlOption = {}): SqlQuery {
  const now = option.now ?? new Date();
  const index = option.schema === undefined ? undefined : schemaIndex(option.schema);
  const bag = makeParamBag(dialect);
  const text = sqlOf(root, [], dialect, bag, now, index, option.tableAlias);
  return { text, param: bag.value, named: bag.named };
}

function sqlOf(
  node: QueryNode,
  path: NodePath,
  dialect: SqlDialect,
  bag: ParamBag,
  now: Date,
  index: ReadonlyMap<string, ColumnSchema> | undefined,
  alias: string | undefined,
): string {
  if (isGroup(node)) {
    if (node.child.length === 0) return node.operator === 'or' ? '1 = 0' : '1 = 1';
    // Parenthesise a child only where precedence actually demands it: a
    // composite AND/OR subgroup. A leaf comparison is atomic and a `not`
    // subgroup already emits its own brackets, so wrapping either would only
    // produce noise a human reading the generated SQL has to see through.
    const part = node.child.map((c, i) => {
      const text = sqlOf(c, [...path, i], dialect, bag, now, index, alias);
      const composite = isGroup(c) && c.operator !== 'not' && c.child.length > 1;
      return composite ? `(${text})` : text;
    });
    const joined = part.join(node.operator === 'or' ? ' OR ' : ' AND ');
    return node.operator === 'not' ? `NOT (${joined})` : joined;
  }
  return sqlCondition(node, path, dialect, bag, now, index, alias);
}

function sqlCondition(
  node: QueryCondition,
  path: NodePath,
  dialect: SqlDialect,
  bag: ParamBag,
  now: Date,
  index: ReadonlyMap<string, ColumnSchema> | undefined,
  alias: string | undefined,
): string {
  const type = index?.get(node.column)?.type;
  const chType = clickhouseType(type);
  const qualified =
    alias === undefined
      ? quoteIdent(node.column, dialect)
      : `${quoteIdent(alias, dialect)}.${quoteIdent(node.column, dialect)}`;
  const bindOne = (raw: unknown): string =>
    bag.bind(type === undefined ? raw : (coerce(raw, type).value ?? raw), chType);
  const insensitive = node.caseSensitive !== true;

  switch (node.operator) {
    case 'eq':
      return `${qualified} = ${bindOne(node.value)}`;
    case 'neq':
      return `${qualified} <> ${bindOne(node.value)}`;
    case 'lt':
    case 'before':
      return `${qualified} < ${bindOne(node.value)}`;
    case 'lte':
      return `${qualified} <= ${bindOne(node.value)}`;
    case 'gt':
    case 'after':
      return `${qualified} > ${bindOne(node.value)}`;
    case 'gte':
      return `${qualified} >= ${bindOne(node.value)}`;

    case 'isNull':
      return `${qualified} IS NULL`;
    case 'isNotNull':
      return `${qualified} IS NOT NULL`;
    case 'isTrue':
      return `${qualified} = ${bag.bind(true, 'Bool')}`;
    case 'isFalse':
      return `${qualified} = ${bag.bind(false, 'Bool')}`;

    case 'in':
    case 'notIn': {
      const operand = node.operand ?? [];
      // An empty IN list is a syntax error in every dialect here, and its
      // meaning is unambiguous anyway: nothing is in the empty set.
      if (operand.length === 0) return node.operator === 'in' ? '1 = 0' : '1 = 1';
      const placeholder = operand.map(bindOne).join(', ');
      return `${qualified}${node.operator === 'notIn' ? ' NOT' : ''} IN (${placeholder})`;
    }

    case 'between':
    case 'notBetween': {
      const operand = node.operand ?? [];
      const lower = bindOne(operand[0]);
      const upper = bindOne(operand[1]);
      const negation = node.operator === 'notBetween' ? ' NOT' : '';
      return `${qualified}${negation} BETWEEN ${lower} AND ${upper}`;
    }

    case 'inLast':
    case 'inNext': {
      const [lower, upper] = durationWindow(node, path, now);
      return `${qualified} BETWEEN ${bag.bind(lower, chType)} AND ${bag.bind(upper, chType)}`;
    }

    case 'contains':
    case 'notContains':
    case 'startsWith':
    case 'endsWith':
      return sqlTextMatch(node, qualified, dialect, bag, insensitive);

    case 'matches': {
      const pattern = bag.bind(String(node.value), 'String');
      if (dialect === 'clickhouse') return `match(${qualified}, ${pattern})`;
      if (dialect === 'postgres') return `${qualified} ${insensitive ? '~*' : '~'} ${pattern}`;
      return `${qualified} REGEXP ${pattern}`;
    }
  }
}

function sqlTextMatch(
  node: QueryCondition,
  qualified: string,
  dialect: SqlDialect,
  bag: ParamBag,
  insensitive: boolean,
): string {
  const raw = String(node.value ?? '');
  const negated = node.operator === 'notContains';

  if (dialect === 'clickhouse') {
    const subject = insensitive ? `lower(${qualified})` : qualified;
    const needle = bag.bind(insensitive ? raw.toLowerCase() : raw, 'String');
    let expression: string;
    if (node.operator === 'startsWith') expression = `startsWith(${subject}, ${needle})`;
    else if (node.operator === 'endsWith') expression = `endsWith(${subject}, ${needle})`;
    else expression = `position(${subject}, ${needle}) > 0`;
    return negated ? `NOT (${expression})` : expression;
  }

  const escaped = likeEscape(raw);
  const pattern =
    node.operator === 'startsWith'
      ? `${escaped}%`
      : node.operator === 'endsWith'
        ? `%${escaped}`
        : `%${escaped}%`;
  const bound = bag.bind(insensitive ? pattern.toLowerCase() : pattern, 'String');
  const subject = insensitive ? `LOWER(${qualified})` : qualified;
  const expression = `${subject} LIKE ${bound} ESCAPE '${LIKE_ESCAPE_CHAR}'`;
  return negated ? `NOT (${expression})` : expression;
}

// -----------------------------------------------------------------------------
// Compilation → MongoDB
// -----------------------------------------------------------------------------

/**
 * A MongoDB filter document. Deliberately loose — the shape is whatever the
 * driver's `find()` accepts, and pinning it tighter would only fight the
 * driver's own types.
 * @public
 */
export type MongoFilter = Record<string, unknown>;

/**
 * Compile to a MongoDB filter document.
 *
 * `not` groups become `$nor` over the conjunction of their children, which is
 * exactly NOT(a AND b); Mongo's own `$not` only applies to a single field
 * operator and cannot express this. Case-insensitive text operators become
 * `$regex` with the `i` option and a fully escaped literal, so a user typing
 * `.` searches for a dot rather than any character.
 * @public
 */
export function toMongo(root: QueryNode, option: CompileOption = {}): MongoFilter {
  const now = option.now ?? new Date();
  const index = option.schema === undefined ? undefined : schemaIndex(option.schema);
  return mongoOf(root, [], now, index);
}

function mongoOf(
  node: QueryNode,
  path: NodePath,
  now: Date,
  index: ReadonlyMap<string, ColumnSchema> | undefined,
): MongoFilter {
  if (isGroup(node)) {
    if (node.child.length === 0) {
      // `{}` matches everything; `{ $expr: false }` matches nothing. An empty
      // OR is the empty disjunction, which is false.
      return node.operator === 'or' ? { $expr: false } : {};
    }
    const part = node.child.map((c, i) => mongoOf(c, [...path, i], now, index));
    if (node.operator === 'and') return { $and: part };
    if (node.operator === 'or') return { $or: part };
    return { $nor: [{ $and: part }] };
  }
  return mongoCondition(node, path, now, index);
}

const REGEX_META = /[.*+?^${}()|[\]\\]/g;

function regexEscape(text: string): string {
  return text.replace(REGEX_META, '\\$&');
}

function mongoCondition(
  node: QueryCondition,
  path: NodePath,
  now: Date,
  index: ReadonlyMap<string, ColumnSchema> | undefined,
): MongoFilter {
  const type = index?.get(node.column)?.type;
  const one = (raw: unknown): unknown => (type === undefined ? raw : (coerce(raw, type).value ?? raw));
  const operand = node.operand ?? [];
  const field = (expression: unknown): MongoFilter => ({ [node.column]: expression });
  const insensitive = node.caseSensitive !== true;
  const option = insensitive ? { $options: 'i' } : {};
  const raw = String(node.value ?? '');

  switch (node.operator) {
    case 'eq':
      return field({ $eq: one(node.value) });
    case 'neq':
      return field({ $ne: one(node.value) });
    case 'lt':
    case 'before':
      return field({ $lt: one(node.value) });
    case 'lte':
      return field({ $lte: one(node.value) });
    case 'gt':
    case 'after':
      return field({ $gt: one(node.value) });
    case 'gte':
      return field({ $gte: one(node.value) });

    case 'in':
      return field({ $in: operand.map(one) });
    case 'notIn':
      return field({ $nin: operand.map(one) });

    case 'between':
      return field({ $gte: one(operand[0]), $lte: one(operand[1]) });
    case 'notBetween':
      return { $nor: [field({ $gte: one(operand[0]), $lte: one(operand[1]) })] };

    case 'inLast':
    case 'inNext': {
      const [lower, upper] = durationWindow(node, path, now);
      return field({ $gte: lower, $lte: upper });
    }

    case 'isNull':
      return field({ $eq: null });
    case 'isNotNull':
      return field({ $ne: null });
    case 'isTrue':
      return field({ $eq: true });
    case 'isFalse':
      return field({ $eq: false });

    case 'contains':
      return field({ $regex: regexEscape(raw), ...option });
    case 'notContains':
      return field({ $not: new RegExp(regexEscape(raw), insensitive ? 'i' : '') });
    case 'startsWith':
      return field({ $regex: `^${regexEscape(raw)}`, ...option });
    case 'endsWith':
      return field({ $regex: `${regexEscape(raw)}$`, ...option });
    case 'matches':
      return field({ $regex: raw, ...option });
  }
}

// -----------------------------------------------------------------------------
// Immutable edit operations
// -----------------------------------------------------------------------------

function pathEqual(a: NodePath, b: NodePath): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function isPrefix(prefix: NodePath, of: NodePath): boolean {
  return prefix.length <= of.length && prefix.every((v, i) => v === of[i]);
}

function requireGroup(root: QueryNode, path: NodePath): QueryGroup {
  const node = nodeAt(root, path);
  if (node === undefined) throw new RangeError(`No node at path [${path.join(', ')}].`);
  if (!isGroup(node)) throw new TypeError(`Node at path [${path.join(', ')}] is not a group.`);
  return node;
}

/**
 * Rebuild the tree with the group at `path` replaced by `fn`'s result. Every
 * ancestor on the way down is copied too, which is what makes an edit produce
 * a wholly new spine while leaving untouched subtrees referentially identical.
 */
function replaceGroup(
  root: QueryNode,
  path: NodePath,
  fn: (group: QueryGroup) => QueryGroup,
): QueryGroup {
  const group = requireGroup(root, path);
  if (path.length === 0) return fn(group);
  const [head, ...rest] = path;
  const parent = requireGroup(root, []);
  const target = parent.child[head as number];
  if (target === undefined) throw new RangeError(`No node at path [${path.join(', ')}].`);
  const child = [...parent.child];
  child[head as number] = replaceGroup(target, rest, fn);
  return { ...parent, child };
}

/** Rebuild the tree with the node at `path` replaced by `next`, or dropped. */
function spliceAt(root: QueryGroup, path: NodePath, next: ReadonlyArray<QueryNode>): QueryGroup {
  if (path.length === 0) throw new RangeError('Cannot splice the root.');
  const parentPath = path.slice(0, -1);
  const at = path[path.length - 1] as number;
  return replaceGroup(root, parentPath, (group) => {
    if (at < 0 || at >= group.child.length) {
      throw new RangeError(`No node at path [${path.join(', ')}].`);
    }
    return { ...group, child: [...group.child.slice(0, at), ...next, ...group.child.slice(at + 1)] };
  });
}

/**
 * Append (or insert at `index`) a condition into the group at `groupPath`.
 * @public
 */
export function addCondition(
  root: QueryGroup,
  groupPath: NodePath,
  condition: QueryCondition,
  index?: number,
): QueryGroup {
  return replaceGroup(root, groupPath, (group) => {
    const at = clamp(index ?? group.child.length, 0, group.child.length);
    return { ...group, child: [...group.child.slice(0, at), condition, ...group.child.slice(at)] };
  });
}

/**
 * Insert an arbitrary node (condition or whole group) into the group at
 * `groupPath`.
 * @public
 */
export function addNode(
  root: QueryGroup,
  groupPath: NodePath,
  node: QueryNode,
  index?: number,
): QueryGroup {
  return replaceGroup(root, groupPath, (group) => {
    const at = clamp(index ?? group.child.length, 0, group.child.length);
    return { ...group, child: [...group.child.slice(0, at), node, ...group.child.slice(at)] };
  });
}

/**
 * Remove the node at `path`. The root cannot be removed — clear it with
 * `emptyQuery()` instead.
 * @public
 */
export function removeNode(root: QueryGroup, path: NodePath): QueryGroup {
  if (path.length === 0) throw new RangeError('Cannot remove the root group.');
  return spliceAt(root, path, []);
}

/**
 * Merge a patch into the condition at `path`. A key explicitly set to
 * `undefined` is REMOVED rather than assigned — that is how a UI clears an
 * operand when the user switches from `between` to `isNull`.
 * @public
 */
export function updateCondition(
  root: QueryGroup,
  path: NodePath,
  patch: Partial<Omit<QueryCondition, 'kind'>>,
): QueryGroup {
  const node = nodeAt(root, path);
  if (node === undefined) throw new RangeError(`No node at path [${path.join(', ')}].`);
  if (!isCondition(node)) throw new TypeError(`Node at path [${path.join(', ')}] is not a condition.`);
  const merged: Record<string, unknown> = { ...node };
  for (const key of Object.keys(patch)) {
    const v = (patch as Record<string, unknown>)[key];
    if (v === undefined) delete merged[key];
    else merged[key] = v;
  }
  merged['kind'] = 'condition';
  return spliceAt(root, path, [merged as unknown as QueryCondition]);
}

/**
 * Switch a group between AND / OR / NOT.
 * @public
 */
export function setGroupOperator(
  root: QueryGroup,
  path: NodePath,
  operator: GroupOperator,
): QueryGroup {
  return replaceGroup(root, path, (group) =>
    group.operator === operator ? group : { ...group, operator },
  );
}

/**
 * Move the node at `from` into the group at `toGroupPath`, at `index`
 * (default: appended).
 *
 * Removal happens first and the destination path is then rebased, so dragging
 * a node downward past its own former position lands where the user dropped it
 * rather than one slot off. Moving a group into its own descendant would
 * detach the tree and throws.
 * @public
 */
export function moveNode(
  root: QueryGroup,
  from: NodePath,
  toGroupPath: NodePath,
  index?: number,
): QueryGroup {
  if (from.length === 0) throw new RangeError('Cannot move the root group.');
  if (isPrefix(from, toGroupPath)) {
    throw new RangeError('Cannot move a node into itself or its own descendant.');
  }
  const node = nodeAt(root, from);
  if (node === undefined) throw new RangeError(`No node at path [${from.join(', ')}].`);

  const removed = removeNode(root, from);
  const rebased = rebase(toGroupPath, from);
  const fromIndex = from[from.length - 1] as number;
  const fromParent = from.slice(0, -1);

  let at = index;
  if (at !== undefined && pathEqual(rebased, fromParent) && at > fromIndex) at -= 1;

  return addNode(removed, rebased, node, at);
}

/**
 * After the node at `removed` is deleted, what does `path` become? Only a
 * later sibling on the removed node's own level shifts.
 */
function rebase(path: NodePath, removed: NodePath): NodePath {
  const depth = removed.length - 1;
  if (path.length < removed.length) return path;
  for (let i = 0; i < depth; i++) if (path[i] !== removed[i]) return path;
  const removedIndex = removed[depth] as number;
  const pathIndex = path[depth] as number;
  if (pathIndex <= removedIndex) return path;
  const out = [...path];
  out[depth] = pathIndex - 1;
  return out;
}

/**
 * Wrap the node at `path` in a new group with the given operator — the
 * "add brackets around this" gesture. Wrapping the root produces a new root
 * whose sole child is the old one.
 * @public
 */
export function wrapInGroup(
  root: QueryGroup,
  path: NodePath,
  operator: GroupOperator = 'and',
): QueryGroup {
  const node = nodeAt(root, path);
  if (node === undefined) throw new RangeError(`No node at path [${path.join(', ')}].`);
  const wrapped: QueryGroup = { kind: 'group', operator, child: [node] };
  if (path.length === 0) return wrapped;
  return spliceAt(root, path, [wrapped]);
}

/**
 * Dissolve the group at `path`, splicing its children into its parent in
 * place — the "remove brackets" gesture. The root has no parent to splice
 * into and throws.
 * @public
 */
export function ungroup(root: QueryGroup, path: NodePath): QueryGroup {
  if (path.length === 0) throw new RangeError('Cannot ungroup the root — it has no parent.');
  const node = nodeAt(root, path);
  if (node === undefined) throw new RangeError(`No node at path [${path.join(', ')}].`);
  if (!isGroup(node)) throw new TypeError(`Node at path [${path.join(', ')}] is not a group.`);
  return spliceAt(root, path, node.child);
}

function clamp(n: number, low: number, high: number): number {
  return n < low ? low : n > high ? high : n;
}

// -----------------------------------------------------------------------------
// Description
// -----------------------------------------------------------------------------

/** @public */
export interface DescribeOption {
  /** Instant relative-date operators are described against. Default `new Date()`. */
  readonly now?: Date;
  /** Text for an empty root. Default "Everything". */
  readonly emptyText?: string;
}

/**
 * A human-readable sentence for the whole query — what a summary chip shows
 * when the builder panel is collapsed.
 * @public
 */
export function describeQuery(
  root: QueryNode,
  schema: Schema,
  option: DescribeOption = {},
): string {
  const index = schemaIndex(schema);
  if (isGroup(root) && root.child.length === 0) return option.emptyText ?? 'Everything';
  const sentence = describeNode(root, index, true);
  return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

function describeNode(
  node: QueryNode,
  index: ReadonlyMap<string, ColumnSchema>,
  top: boolean,
): string {
  if (isCondition(node)) return describeCondition(node, index);
  if (node.child.length === 0) return node.operator === 'or' ? 'nothing' : 'anything';
  const part = node.child.map((c) => describeNode(c, index, false));
  const joined = part.join(node.operator === 'or' ? ' or ' : ' and ');
  if (node.operator === 'not') return `not (${joined})`;
  // Brackets only where they change the reading: a single child needs none,
  // and the outermost group is already unambiguous.
  if (part.length === 1 || top) return joined;
  return `(${joined})`;
}

function describeCondition(
  node: QueryCondition,
  index: ReadonlyMap<string, ColumnSchema>,
): string {
  const column = index.get(node.column);
  const label = column?.displayName ?? node.column;
  const operand = node.operand ?? [];

  switch (operatorArity(node.operator)) {
    case 'none':
      return `${label} ${operatorLabel(node.operator)}`;
    case 'list':
      return `${label} ${operatorLabel(node.operator)} ${operand.map(describeValue).join(', ')}`;
    case 'range':
      return `${label} ${operatorLabel(node.operator)} ${describeValue(operand[0])} and ${describeValue(operand[1])}`;
    case 'duration': {
      const count = typeof node.value === 'number' ? node.value : 0;
      const unit = node.unit ?? 'day';
      return `${label} ${operatorLabel(node.operator)} ${count} ${unit}${count === 1 ? '' : 's'}`;
    }
    case 'scalar':
      return `${label} ${operatorLabel(node.operator)} ${describeValue(node.value)}`;
  }
}
