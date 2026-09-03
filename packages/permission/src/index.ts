// =============================================================================
// @onegrid/permission
//
// Row-level security and column permissions for oneGrid.
//
// THE CENTRAL DESIGN POINT: THE SERVER IS CANONICAL, THE CLIENT IS COSMETIC.
//
// A policy in this package has two halves and they are not equals.
//
//   1. The server-canonical half is `compilePolicyFilter`. It turns a policy
//      plus a principal into a `FilterModel` fragment that the adapter ANDs
//      into EVERY `BlockRequest` before it reaches the database. Because the
//      fragment is expressed in the protocol's own filter vocabulary — the
//      same `ComparisonFilter` / `LogicalFilter` nodes `packages/protocol`
//      already defines — it compiles down into the WHERE clause the adapters
//      already emit. There is no second filter language to keep in sync, and
//      no code path where a row the policy excludes can be read out of the
//      database. This is the enforcement boundary.
//
//   2. The client-cosmetic half is `applyColumnPolicy` and `guardMutation`.
//      It exists ONLY so a user is not shown an affordance the server would
//      reject: a column they cannot read is not painted, a cell they cannot
//      write does not open an editor, an optimistic mutation that is going to
//      come back denied is rejected before it is sent so the grid never
//      flashes a value it has to roll back. It is a user-experience layer.
//
// IT MUST NEVER BE THE ONLY ENFORCEMENT. Everything in half 2 runs in the
// browser, in code the user can edit, against data the user already has. A
// hidden column is hidden by not being rendered; if the server put the value
// in the response, the user has the value. `guardMutation` is a courtesy that
// saves a round-trip, not a lock. Adopters MUST run the same policy set on the
// server, feed `compilePolicyFilter` into the adapter, and re-check mutations
// there. This package deliberately makes that easy by being isomorphic: the
// exact same `Policy` objects and the exact same functions run on both sides,
// so the client's guess about what the server will allow is derived from the
// server's own rules rather than hand-maintained beside them.
//
// Design decisions worth stating:
//
//   - FAIL CLOSED. A principal that matches no policy gets `DENY_ALL_FILTER`
//     (a filter that is structurally always-false in the protocol's semantics,
//     `NOT(AND of nothing)` = `NOT TRUE`) and an empty visible column set. An
//     attribute condition whose principal attribute is absent also denies. The
//     absence of a rule is never permission.
//
//   - MOST-RESTRICTIVE-WINS. When several policies match one principal their
//     row filters are ANDed (an intersection, never a union) and their column
//     rules are resolved on a restrictiveness lattice
//     (`write < read < masked < hidden`, most restrictive taken). Adding a
//     policy can therefore only ever remove access. That direction is the safe
//     one: an operator who grants a second role by mistake narrows the view
//     rather than widening it.
//
//   - ROLE INHERITANCE IS A GRAPH, NOT A TREE, AND MAY CONTAIN CYCLES. Real
//     role hierarchies get edited by humans and `admin extends manager extends
//     admin` happens. `expandRole` walks with a visited set and terminates on
//     any cycle rather than throwing, because a permission layer that crashes
//     is a permission layer that gets disabled.
//
//   - ATTRIBUTE CONDITIONS ARE THE MULTI-TENANT CASE. `principal.tenant_id ===
//     row.tenant_id` is the single most common row-level rule that exists, and
//     it cannot be written as a static filter because the value is per-user.
//     `AttributeCondition` names a principal attribute and a column; the
//     compiler resolves the attribute at compile time into a plain
//     `ComparisonFilter`, so the adapter still sees only ordinary protocol
//     nodes and needs to know nothing about principals.
// =============================================================================

import type {
  ComparisonFilter,
  ComparisonOperator,
  FilterModel,
  FilterNode,
  LogicalFilter,
  Mutation,
  Schema,
} from '@onegrid/protocol';

// -----------------------------------------------------------------------------
// Principal and roles
// -----------------------------------------------------------------------------

/**
 * The authenticated subject a policy is evaluated against. `attribute` carries
 * the claims that attribute-based conditions reference — `tenant_id`,
 * `region`, `department_code` and so on. On the server this comes from the
 * session/JWT; on the client it is whatever the server told the client it is,
 * which is exactly why the client half is cosmetic.
 * @public
 */
export interface Principal {
  readonly id: string;
  /** Directly assigned role names. Inherited roles are resolved separately. */
  readonly role: readonly string[];
  /** Claims referenced by `AttributeCondition`. */
  readonly attribute?: Readonly<Record<string, unknown>>;
}

/**
 * One node in the role graph. `extend` names roles this role inherits, so a
 * principal holding `name` effectively holds every role reachable from it.
 * @public
 */
export interface RoleDefinition {
  readonly name: string;
  readonly extend?: readonly string[];
}

/**
 * Expand directly-assigned role names into the full effective set by walking
 * `extend` edges.
 *
 * Cycles terminate: the walk carries a visited set, so `a extends b extends a`
 * yields `['a', 'b']` instead of looping forever. Unknown role names pass
 * through unchanged — a role with no definition is simply a leaf.
 *
 * Output order is deterministic: breadth-first from the assigned roles in the
 * order given. Deterministic output matters because it feeds policy selection,
 * and policy selection must not depend on Set iteration luck.
 * @public
 */
export function expandRole(
  role: readonly string[],
  definition: readonly RoleDefinition[] = [],
): readonly string[] {
  const byName = new Map<string, RoleDefinition>();
  for (const def of definition) byName.set(def.name, def);

  const seen = new Set<string>();
  const out: string[] = [];
  const queue: string[] = [...role];

  while (queue.length > 0) {
    const name = queue.shift() as string;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
    const def = byName.get(name);
    if (!def?.extend) continue;
    for (const parent of def.extend) {
      if (!seen.has(parent)) queue.push(parent);
    }
  }

  return out;
}

// -----------------------------------------------------------------------------
// Column rules
// -----------------------------------------------------------------------------

/**
 * What a principal may do with one column.
 *
 *   - `write`  — read and edit.
 *   - `read`   — visible, not editable.
 *   - `masked` — visible but the value is transformed by a `MaskStrategy`.
 *   - `hidden` — absent from the projected schema entirely.
 * @public
 */
export type ColumnAccess = 'read' | 'write' | 'hidden' | 'masked';

/**
 * How a `'masked'` column's value is degraded.
 *
 *   - `redact` — replaced wholesale with {@link REDACTED_TOKEN}.
 *   - `last4`  — all but the trailing four characters replaced (card / SSN
 *                tails, the one partial disclosure that is normally allowed).
 *   - `hash`   — a stable non-reversible digest, so equal values still compare
 *                equal client-side (grouping and joins survive) without the
 *                plaintext.
 *   - `null`   — the value becomes `null`, indistinguishable from missing data.
 * @public
 */
export type MaskStrategy = 'redact' | 'last4' | 'hash' | 'null';

/** @public */
export interface ColumnRuleObject {
  readonly access: ColumnAccess;
  /** Only meaningful when `access` is `'masked'`. Defaults to `'redact'`. */
  readonly mask?: MaskStrategy;
}

/**
 * Shorthand: a bare `ColumnAccess` is equivalent to `{ access }`.
 * @public
 */
export type ColumnRule = ColumnAccess | ColumnRuleObject;

/** The literal a `'redact'` mask substitutes for the real value. @public */
export const REDACTED_TOKEN = '••••';

// Restrictiveness lattice. Larger = more restrictive. Conflict resolution is
// `max` over this rank, which is what makes adding a policy monotonically
// narrowing.
const ACCESS_RANK: Readonly<Record<ColumnAccess, number>> = {
  write: 0,
  read: 1,
  masked: 2,
  hidden: 3,
};

// Same idea for masks: two policies masking one column differently must settle
// on the one that discloses least.
const MASK_RANK: Readonly<Record<MaskStrategy, number>> = {
  last4: 1,
  hash: 2,
  redact: 3,
  null: 4,
};

// -----------------------------------------------------------------------------
// Policy
// -----------------------------------------------------------------------------

/**
 * A row-level condition that references the principal rather than a constant.
 * `{ columnId: 'tenant_id', attribute: 'tenant_id' }` compiles to
 * `tenant_id = <the principal's tenant_id>`.
 *
 * If the principal has no such attribute the policy denies everything, because
 * an unresolvable tenant check must not silently become "no filter".
 * @public
 */
export interface AttributeCondition {
  /** Column on the row side of the comparison. */
  readonly columnId: string;
  /** Key into `Principal.attribute`. */
  readonly attribute: string;
  /** Comparison to emit. Default `'eq'`. */
  readonly op?: ComparisonOperator;
}

/** Input accepted by {@link definePolicy}. @public */
export interface PolicySpec {
  /** Logical table / dataset this policy governs. */
  readonly resource: string;
  /** Roles the policy applies to. `'*'` matches every principal. */
  readonly role: readonly string[] | '*';
  /**
   * Static row restriction in the protocol's own filter vocabulary, or a
   * function of the principal when the shape (not just a value) varies. `null`
   * or omitted means the policy adds no static row restriction.
   */
  readonly rowFilter?: FilterModel | ((principal: Principal) => FilterModel);
  /** Principal-attribute row conditions, ANDed with `rowFilter`. */
  readonly attributeCondition?: readonly AttributeCondition[];
  /** Per-column access. Columns absent here take `defaultColumnAccess`. */
  readonly columnRule?: Readonly<Record<string, ColumnRule>>;
  /** Access for columns with no explicit rule. Default `'read'`. */
  readonly defaultColumnAccess?: ColumnAccess;
  /** Whether this policy permits inserts. Default `true`. */
  readonly allowInsert?: boolean;
  /** Whether this policy permits deletes. Default `true`. */
  readonly allowDelete?: boolean;
}

/**
 * A validated, normalised, frozen policy. `columnRule` is normalised to object
 * form so downstream code never re-branches on the shorthand.
 * @public
 */
export interface Policy extends PolicySpec {
  readonly columnRule: Readonly<Record<string, ColumnRuleObject>>;
  readonly defaultColumnAccess: ColumnAccess;
  readonly allowInsert: boolean;
  readonly allowDelete: boolean;
}

const VALID_ACCESS = new Set<string>(['read', 'write', 'hidden', 'masked']);
const VALID_MASK = new Set<string>(['redact', 'last4', 'hash', 'null']);

function normaliseRule(columnId: string, rule: ColumnRule): ColumnRuleObject {
  const obj: ColumnRuleObject = typeof rule === 'string' ? { access: rule } : rule;
  if (!VALID_ACCESS.has(obj.access)) {
    throw new Error(
      `@onegrid/permission: column "${columnId}" has invalid access "${String(obj.access)}".`,
    );
  }
  if (obj.mask !== undefined) {
    if (!VALID_MASK.has(obj.mask)) {
      throw new Error(
        `@onegrid/permission: column "${columnId}" has invalid mask "${String(obj.mask)}".`,
      );
    }
    if (obj.access !== 'masked') {
      // Silently ignoring the mask would hide a real authoring mistake: the
      // author thinks the value is degraded and it is not.
      throw new Error(
        `@onegrid/permission: column "${columnId}" sets mask "${obj.mask}" but access is "${obj.access}"; masks only apply to access "masked".`,
      );
    }
    return Object.freeze({ access: obj.access, mask: obj.mask });
  }
  return Object.freeze(
    obj.access === 'masked'
      ? { access: obj.access, mask: 'redact' as MaskStrategy }
      : { access: obj.access },
  );
}

/**
 * Validate and normalise a policy. Authoring mistakes throw here — at module
 * load, in a test, on the developer's machine — rather than degrading to a
 * quietly permissive rule at request time.
 * @public
 */
export function definePolicy(spec: PolicySpec): Policy {
  if (!spec.resource) {
    throw new Error('@onegrid/permission: policy requires a non-empty `resource`.');
  }
  if (spec.role !== '*' && (!Array.isArray(spec.role) || spec.role.length === 0)) {
    throw new Error(
      `@onegrid/permission: policy for "${spec.resource}" requires a non-empty \`role\` array or the wildcard '*'.`,
    );
  }
  if (spec.defaultColumnAccess !== undefined && !VALID_ACCESS.has(spec.defaultColumnAccess)) {
    throw new Error(
      `@onegrid/permission: policy for "${spec.resource}" has invalid defaultColumnAccess "${String(spec.defaultColumnAccess)}".`,
    );
  }
  for (const condition of spec.attributeCondition ?? []) {
    if (!condition.columnId || !condition.attribute) {
      throw new Error(
        `@onegrid/permission: policy for "${spec.resource}" has an attributeCondition missing columnId or attribute.`,
      );
    }
  }

  const columnRule: Record<string, ColumnRuleObject> = {};
  for (const [columnId, rule] of Object.entries(spec.columnRule ?? {})) {
    columnRule[columnId] = normaliseRule(columnId, rule);
  }

  return Object.freeze({
    ...spec,
    columnRule: Object.freeze(columnRule),
    defaultColumnAccess: spec.defaultColumnAccess ?? 'read',
    allowInsert: spec.allowInsert ?? true,
    allowDelete: spec.allowDelete ?? true,
  });
}

/** Options shared by every evaluation entry point. @public */
export interface PolicyEvaluationOption {
  /**
   * Which resource is being evaluated. Required when the policy set spans more
   * than one resource — silently ANDing an unrelated resource's row filter
   * into a query is the kind of bug that shows up as "no rows" in production.
   */
  readonly resource?: string;
  /** Role graph used to expand `principal.role`. */
  readonly roleDefinition?: readonly RoleDefinition[];
}

// -----------------------------------------------------------------------------
// Deny-all
// -----------------------------------------------------------------------------

/**
 * A structurally always-false filter, expressed purely in protocol nodes so no
 * adapter needs a special case: `NOT (AND of nothing)`. An empty `and` is
 * vacuously true and `not` inverts it, so every conforming compiler emits
 * `NOT TRUE`. Crucially it names no column, so it is safe to emit for a
 * principal who is not allowed to know which columns exist.
 * @public
 */
export const DENY_ALL_FILTER: FilterNode = Object.freeze({
  type: 'logical',
  op: 'not',
  filters: [{ type: 'logical', op: 'and', filters: [] }],
} satisfies LogicalFilter);

/** True when `filter` is the canonical deny-all node. @public */
export function isDenyAllFilter(filter: FilterModel): boolean {
  if (!filter || filter.type !== 'logical' || filter.op !== 'not') return false;
  const inner = filter.filters[0];
  return (
    filter.filters.length === 1 &&
    inner !== undefined &&
    inner.type === 'logical' &&
    inner.op === 'and' &&
    inner.filters.length === 0
  );
}

// -----------------------------------------------------------------------------
// Policy selection
// -----------------------------------------------------------------------------

// `Array.isArray` widens a readonly tuple to `any[]`, so narrow through an
// explicit predicate instead of casting the result.
function isPolicyArray(policy: Policy | readonly Policy[]): policy is readonly Policy[] {
  return Array.isArray(policy);
}

function toArray(policy: Policy | readonly Policy[]): readonly Policy[] {
  return isPolicyArray(policy) ? policy : [policy];
}

/**
 * The policies that apply to `principal`, in declaration order.
 *
 * A policy matches when its `resource` matches the evaluated resource and its
 * `role` is `'*'` or intersects the principal's expanded role set.
 * @public
 */
export function selectPolicy(
  policy: Policy | readonly Policy[],
  principal: Principal,
  option: PolicyEvaluationOption = {},
): readonly Policy[] {
  const all = toArray(policy);
  const resource = resolveResource(all, option);
  const effectiveRole = new Set(expandRole(principal.role, option.roleDefinition ?? []));

  return all.filter((p) => {
    if (p.resource !== resource) return false;
    if (p.role === '*') return true;
    return p.role.some((r) => effectiveRole.has(r));
  });
}

function resolveResource(
  all: readonly Policy[],
  option: PolicyEvaluationOption,
): string | undefined {
  if (option.resource !== undefined) return option.resource;
  const distinct = new Set(all.map((p) => p.resource));
  if (distinct.size > 1) {
    throw new Error(
      `@onegrid/permission: the policy set spans resources [${[...distinct].sort().join(', ')}]; pass \`option.resource\` to say which one is being evaluated.`,
    );
  }
  return [...distinct][0];
}

// -----------------------------------------------------------------------------
// compilePolicyFilter — the server-canonical half
// -----------------------------------------------------------------------------

function and(node: readonly FilterNode[]): FilterModel {
  if (node.length === 0) return null;
  if (node.length === 1) return node[0] as FilterNode;
  return { type: 'logical', op: 'and', filters: node } satisfies LogicalFilter;
}

// Flatten one level of nested `and` so the emitted SQL is a flat conjunction
// rather than a parenthesis nest per policy. Adapters cope with either; query
// planners and humans reading logs prefer the flat form.
function flattenAnd(node: FilterNode): readonly FilterNode[] {
  if (node.type === 'logical' && node.op === 'and') {
    return node.filters.flatMap((f) => flattenAnd(f));
  }
  return [node];
}

function compileAttributeCondition(
  condition: AttributeCondition,
  principal: Principal,
): ComparisonFilter | null {
  const attribute = principal.attribute ?? {};
  if (!Object.prototype.hasOwnProperty.call(attribute, condition.attribute)) return null;
  const value = attribute[condition.attribute];
  if (value === undefined) return null;
  const op = condition.op ?? 'eq';
  // `in` / `notIn` / `between` take a list; everything else takes a scalar.
  if (op === 'in' || op === 'notIn' || op === 'between' || op === 'notBetween') {
    const values = Array.isArray(value) ? (value as readonly unknown[]) : [value];
    return { type: 'comparison', columnId: condition.columnId, op, values };
  }
  return { type: 'comparison', columnId: condition.columnId, op, value };
}

/**
 * Compile a policy set into the `FilterModel` fragment the adapter ANDs into
 * every `BlockRequest`. THIS IS THE ENFORCEMENT BOUNDARY — everything else in
 * this package is presentation.
 *
 * Returns `null` when the principal is unrestricted (the protocol's "no
 * filter"), {@link DENY_ALL_FILTER} when no policy matches or a required
 * principal attribute is missing, and otherwise a conjunction of every
 * matching policy's row filter and attribute conditions. Conjunction, not
 * disjunction: matching more policies can only narrow the visible rows.
 *
 * Typical adapter wiring:
 *
 * ```ts
 * const guarded: BlockRequest = {
 *   ...request,
 *   filter: andFilter(request.filter, compilePolicyFilter(policy, principal)),
 * };
 * ```
 * @public
 */
export function compilePolicyFilter(
  policy: Policy | readonly Policy[],
  principal: Principal,
  option: PolicyEvaluationOption = {},
): FilterModel {
  const matched = selectPolicy(policy, principal, option);
  if (matched.length === 0) return DENY_ALL_FILTER;

  const fragment: FilterNode[] = [];
  for (const p of matched) {
    const rowFilter = typeof p.rowFilter === 'function' ? p.rowFilter(principal) : p.rowFilter;
    if (rowFilter) fragment.push(...flattenAnd(rowFilter));

    for (const condition of p.attributeCondition ?? []) {
      const compiled = compileAttributeCondition(condition, principal);
      // Fail closed: an unresolvable attribute condition denies the whole
      // request rather than degrading into an unfiltered read.
      if (!compiled) return DENY_ALL_FILTER;
      fragment.push(compiled);
    }
  }

  if (fragment.some((f) => isDenyAllFilter(f))) return DENY_ALL_FILTER;
  return and(fragment);
}

/**
 * AND a request's own filter together with a policy fragment, preserving the
 * protocol's `null` = "no filter" convention. Adapters should route every
 * `BlockRequest.filter` through this.
 * @public
 */
export function andFilter(...filter: readonly FilterModel[]): FilterModel {
  const node = filter.filter((f): f is FilterNode => f !== null && f !== undefined);
  if (node.some((f) => isDenyAllFilter(f))) return DENY_ALL_FILTER;
  return and(node.flatMap((f) => flattenAnd(f)));
}

// -----------------------------------------------------------------------------
// Row-filter evaluation (client-side prediction only)
// -----------------------------------------------------------------------------

function compare(a: unknown, b: unknown): number | null {
  if (a === null || a === undefined || b === null || b === undefined) return null;
  if (typeof a === 'number' && typeof b === 'number') return a === b ? 0 : a < b ? -1 : 1;
  const sa = String(a);
  const sb = String(b);
  return sa === sb ? 0 : sa < sb ? -1 : 1;
}

function textOf(value: unknown, caseSensitive: boolean): string {
  const s = value === null || value === undefined ? '' : String(value);
  return caseSensitive ? s : s.toLowerCase();
}

function evaluateComparison(node: ComparisonFilter, row: Record<string, unknown>): boolean {
  const cell = row[node.columnId];
  // The protocol documents `caseSensitive` as defaulting to false. Adapters
  // have historically differed; policies that care should set it explicitly so
  // the client prediction and the server verdict cannot disagree.
  const cs = node.caseSensitive === true;
  const values = node.values ?? [];
  switch (node.op) {
    case 'eq':
      return cell === node.value;
    case 'neq':
      return cell !== node.value;
    case 'lt': {
      const c = compare(cell, node.value);
      return c !== null && c < 0;
    }
    case 'lte': {
      const c = compare(cell, node.value);
      return c !== null && c <= 0;
    }
    case 'gt': {
      const c = compare(cell, node.value);
      return c !== null && c > 0;
    }
    case 'gte': {
      const c = compare(cell, node.value);
      return c !== null && c >= 0;
    }
    case 'in':
      return values.includes(cell);
    case 'notIn':
      return !values.includes(cell);
    case 'contains':
      return textOf(cell, cs).includes(textOf(node.value, cs));
    case 'notContains':
      return !textOf(cell, cs).includes(textOf(node.value, cs));
    case 'startsWith':
      return textOf(cell, cs).startsWith(textOf(node.value, cs));
    case 'endsWith':
      return textOf(cell, cs).endsWith(textOf(node.value, cs));
    case 'isNull':
      return cell === null || cell === undefined;
    case 'isNotNull':
      return cell !== null && cell !== undefined;
    case 'between': {
      const lo = compare(cell, values[0]);
      const hi = compare(cell, values[1]);
      return lo !== null && hi !== null && lo >= 0 && hi <= 0;
    }
    case 'notBetween': {
      const lo = compare(cell, values[0]);
      const hi = compare(cell, values[1]);
      return lo === null || hi === null || lo < 0 || hi > 0;
    }
    default:
      // Unknown operator: fail closed. A filter this build cannot interpret
      // must not be treated as satisfied.
      return false;
  }
}

/**
 * Evaluate a `FilterModel` against an in-memory row.
 *
 * This is the client-cosmetic mirror of what the database does with the
 * compiled filter, used by {@link guardMutation} to predict a rejection. It is
 * a prediction, not a verdict — the database is the verdict. Empty `and` is
 * true and empty `or` is false, matching the adapters' compilers, which is
 * what makes {@link DENY_ALL_FILTER} evaluate to false here too.
 * @public
 */
export function evaluateRowFilter(filter: FilterModel, row: Record<string, unknown>): boolean {
  if (!filter) return true;
  if (filter.type === 'logical') {
    if (filter.op === 'and') return filter.filters.every((f) => evaluateRowFilter(f, row));
    if (filter.op === 'or') return filter.filters.some((f) => evaluateRowFilter(f, row));
    const inner = filter.filters[0];
    if (!inner) return true;
    return !evaluateRowFilter(inner, row);
  }
  return evaluateComparison(filter, row);
}

// -----------------------------------------------------------------------------
// Masking
// -----------------------------------------------------------------------------

// FNV-1a, 32-bit. Not a cryptographic hash and not claimed to be one — the
// point is a stable, dependency-free digest so equal plaintext still groups
// together client-side. Anything that must resist inversion masks server-side
// before the value ever leaves the database.
function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * Degrade one cell value according to a mask strategy.
 *
 * `null` / `undefined` pass through untouched under every strategy except
 * `'null'`: there is nothing to hide, and substituting a redaction token for
 * missing data would misrepresent the row.
 * @public
 */
export function maskValue(value: unknown, strategy: MaskStrategy = 'redact'): unknown {
  if (strategy === 'null') return null;
  if (value === null || value === undefined) return value;
  const text = String(value);
  switch (strategy) {
    case 'redact':
      return REDACTED_TOKEN;
    case 'last4':
      // Values of four characters or fewer are ALL tail, so revealing the tail
      // would reveal the value. Redact them outright.
      return text.length <= 4 ? REDACTED_TOKEN : '•'.repeat(text.length - 4) + text.slice(-4);
    case 'hash':
      return fnv1a(text);
    default:
      return REDACTED_TOKEN;
  }
}

// -----------------------------------------------------------------------------
// applyColumnPolicy — the client-cosmetic half
// -----------------------------------------------------------------------------

/** Resolved column permissions for one principal. @public */
export interface ColumnPolicyResult {
  /** The schema with every `hidden` column removed. Safe to hand to the grid. */
  readonly schema: Schema;
  readonly visibleColumn: readonly string[];
  readonly writableColumn: readonly string[];
  readonly maskedColumn: readonly string[];
  readonly hiddenColumn: readonly string[];
  /** Resolved access for any column id, including ones not in the schema. */
  readonly accessOf: (columnId: string) => ColumnAccess;
  /** Resolved mask for a `masked` column; `undefined` for every other access. */
  readonly maskOf: (columnId: string) => MaskStrategy | undefined;
  /** Apply this column's mask to a value. Non-masked columns pass through. */
  readonly maskCell: (columnId: string, value: unknown) => unknown;
  /** Drop hidden keys and mask masked ones across a whole row. */
  readonly maskRow: (row: Record<string, unknown>) => Record<string, unknown>;
}

/**
 * Project a schema through a policy set for one principal.
 *
 * A hidden column is removed from the returned `schema` outright — not flagged
 * — so a grid built from it cannot render the column even by accident, and no
 * `ColumnSchema` leaks the fact that the field exists. Column-level conflicts
 * resolve most-restrictive-wins on the `write < read < masked < hidden`
 * lattice; mask-level conflicts resolve to the strategy that discloses least.
 *
 * Remember what this is: the server still has to omit or mask those columns in
 * the response. Removing a column here removes a rendered header, nothing more.
 * @public
 */
export function applyColumnPolicy(
  schema: Schema,
  policy: Policy | readonly Policy[],
  principal: Principal,
  option: PolicyEvaluationOption = {},
): ColumnPolicyResult {
  const matched = selectPolicy(policy, principal, option);

  const resolve = (columnId: string): ColumnRuleObject => {
    // Fail closed: no matching policy means no access at all.
    if (matched.length === 0) return { access: 'hidden' };
    let access: ColumnAccess = 'write';
    let mask: MaskStrategy | undefined;
    for (const p of matched) {
      const rule = p.columnRule[columnId] ?? { access: p.defaultColumnAccess };
      if (ACCESS_RANK[rule.access] > ACCESS_RANK[access]) access = rule.access;
      if (rule.access === 'masked') {
        const candidate = rule.mask ?? 'redact';
        if (mask === undefined || MASK_RANK[candidate] > MASK_RANK[mask]) mask = candidate;
      }
    }
    return access === 'masked' ? { access, mask: mask ?? 'redact' } : { access };
  };

  const cache = new Map<string, ColumnRuleObject>();
  const ruleOf = (columnId: string): ColumnRuleObject => {
    let cached = cache.get(columnId);
    if (!cached) {
      cached = resolve(columnId);
      cache.set(columnId, cached);
    }
    return cached;
  };

  const visibleColumn: string[] = [];
  const writableColumn: string[] = [];
  const maskedColumn: string[] = [];
  const hiddenColumn: string[] = [];
  const projected: Schema = schema.filter((column) => {
    const rule = ruleOf(column.id);
    switch (rule.access) {
      case 'hidden':
        hiddenColumn.push(column.id);
        return false;
      case 'masked':
        maskedColumn.push(column.id);
        visibleColumn.push(column.id);
        return true;
      case 'write':
        writableColumn.push(column.id);
        visibleColumn.push(column.id);
        return true;
      default:
        visibleColumn.push(column.id);
        return true;
    }
  });

  const maskCell = (columnId: string, value: unknown): unknown => {
    const rule = ruleOf(columnId);
    if (rule.access !== 'masked') return value;
    return maskValue(value, rule.mask ?? 'redact');
  };

  return Object.freeze({
    schema: projected,
    visibleColumn,
    writableColumn,
    maskedColumn,
    hiddenColumn,
    accessOf: (columnId: string): ColumnAccess => ruleOf(columnId).access,
    maskOf: (columnId: string): MaskStrategy | undefined => {
      const rule = ruleOf(columnId);
      return rule.access === 'masked' ? (rule.mask ?? 'redact') : undefined;
    },
    maskCell,
    maskRow: (row: Record<string, unknown>): Record<string, unknown> => {
      const out: Record<string, unknown> = {};
      for (const [columnId, value] of Object.entries(row)) {
        if (ruleOf(columnId).access === 'hidden') continue;
        out[columnId] = maskCell(columnId, value);
      }
      return out;
    },
  });
}

// -----------------------------------------------------------------------------
// guardMutation — reject an optimistic write before it is sent
// -----------------------------------------------------------------------------

/** Why a mutation was refused. @public */
export type MutationDenyReason =
  | 'no-matching-policy'
  | 'column-hidden'
  | 'column-not-writable'
  | 'insert-not-permitted'
  | 'delete-not-permitted'
  | 'row-filter-mismatch';

/** @public */
export interface MutationAllowed {
  readonly allowed: true;
}

/** @public */
export interface MutationDenied {
  readonly allowed: false;
  readonly reason: MutationDenyReason;
  /** Human-readable explanation, safe to surface in a toast. */
  readonly message: string;
  /** The offending column, for column-scoped reasons. */
  readonly columnId?: string;
}

/** @public */
export type MutationGuardResult = MutationAllowed | MutationDenied;

/** @public */
export interface MutationGuardOption extends PolicyEvaluationOption {
  /**
   * The row as the client currently has it. Supplying it lets the guard check
   * the compiled row filter for updates and deletes — without it, row-level
   * checks for those kinds are skipped and left entirely to the server.
   */
  readonly row?: Record<string, unknown>;
}

/**
 * Decide whether a mutation is worth sending.
 *
 * Every denial is a prediction that the server would refuse this write, made
 * so the grid can refuse it first instead of applying an optimistic edit and
 * rolling it back a round-trip later. An `allowed: true` verdict is NOT
 * authorisation — the server re-runs the same policy and its answer is the
 * only one that counts.
 *
 * Checks, in order: a matching policy must exist; insert/delete must be
 * permitted by every matching policy; every touched column must resolve to
 * `write`; and the resulting row must satisfy the compiled row filter (so a
 * tenant cannot insert into, or move a row into, another tenant).
 * @public
 */
export function guardMutation(
  mutation: Mutation,
  policy: Policy | readonly Policy[],
  principal: Principal,
  option: MutationGuardOption = {},
): MutationGuardResult {
  const matched = selectPolicy(policy, principal, option);
  if (matched.length === 0) {
    return {
      allowed: false,
      reason: 'no-matching-policy',
      message: `Principal "${principal.id}" matches no policy for this resource.`,
    };
  }

  const columnPolicy = applyColumnPolicy([], policy, principal, option);
  const rowFilter = compilePolicyFilter(policy, principal, option);

  const checkColumn = (field: Record<string, unknown>): MutationDenied | null => {
    for (const columnId of Object.keys(field)) {
      const access = columnPolicy.accessOf(columnId);
      if (access === 'write') continue;
      return {
        allowed: false,
        reason: access === 'hidden' ? 'column-hidden' : 'column-not-writable',
        message:
          access === 'hidden'
            ? `Column "${columnId}" is not visible to principal "${principal.id}".`
            : `Column "${columnId}" is ${access}-only for principal "${principal.id}".`,
        columnId,
      };
    }
    return null;
  };

  if (mutation.kind === 'insert') {
    const blocking = matched.find((p) => !p.allowInsert);
    if (blocking) {
      return {
        allowed: false,
        reason: 'insert-not-permitted',
        message: `Policy on "${blocking.resource}" does not permit inserts for principal "${principal.id}".`,
      };
    }
    const denied = checkColumn(mutation.row);
    if (denied) return denied;
    if (!evaluateRowFilter(rowFilter, mutation.row)) {
      return {
        allowed: false,
        reason: 'row-filter-mismatch',
        message: `The inserted row falls outside the rows visible to principal "${principal.id}".`,
      };
    }
    return { allowed: true };
  }

  if (mutation.kind === 'delete') {
    const blocking = matched.find((p) => !p.allowDelete);
    if (blocking) {
      return {
        allowed: false,
        reason: 'delete-not-permitted',
        message: `Policy on "${blocking.resource}" does not permit deletes for principal "${principal.id}".`,
      };
    }
    if (option.row && !evaluateRowFilter(rowFilter, option.row)) {
      return {
        allowed: false,
        reason: 'row-filter-mismatch',
        message: `Row "${String(mutation.rowId)}" is outside the rows visible to principal "${principal.id}".`,
      };
    }
    return { allowed: true };
  }

  const denied = checkColumn(mutation.fields);
  if (denied) return denied;
  if (option.row) {
    // Check BOTH the row as it stands and the row as it would be after the
    // edit. The first stops editing someone else's row; the second stops
    // moving your own row out of your slice (re-tenanting).
    const before = option.row;
    const after = { ...option.row, ...mutation.fields };
    if (!evaluateRowFilter(rowFilter, before) || !evaluateRowFilter(rowFilter, after)) {
      return {
        allowed: false,
        reason: 'row-filter-mismatch',
        message: `Row "${String(mutation.rowId)}" would fall outside the rows visible to principal "${principal.id}".`,
      };
    }
  }
  return { allowed: true };
}
