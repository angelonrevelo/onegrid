import { describe, expect, it } from 'vitest';
import type { FilterNode, Schema, UpdateMutation } from '@onegrid/protocol';
import {
  DENY_ALL_FILTER,
  REDACTED_TOKEN,
  andFilter,
  applyColumnPolicy,
  compilePolicyFilter,
  definePolicy,
  evaluateRowFilter,
  expandRole,
  guardMutation,
  isDenyAllFilter,
  maskValue,
  selectPolicy,
  type Policy,
  type Principal,
  type RoleDefinition,
} from '../index.js';

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

const schema: Schema = [
  { id: 'id', type: 'int64' },
  { id: 'tenant_id', type: 'utf8' },
  { id: 'name', type: 'utf8' },
  { id: 'salary', type: 'float64' },
  { id: 'ssn', type: 'utf8' },
  { id: 'internal_note', type: 'utf8' },
];

const analyst = definePolicy({
  resource: 'employee',
  role: ['analyst'],
  attributeCondition: [{ columnId: 'tenant_id', attribute: 'tenant_id' }],
  columnRule: {
    name: 'write',
    salary: 'read',
    ssn: { access: 'masked', mask: 'last4' },
    internal_note: 'hidden',
  },
});

const auditor = definePolicy({
  resource: 'employee',
  role: ['auditor'],
  rowFilter: { type: 'comparison', columnId: 'archived', op: 'eq', value: false },
  columnRule: { name: 'read', salary: 'hidden', ssn: { access: 'masked', mask: 'hash' } },
});

const principalOf = (id: string, role: string[], attribute?: Record<string, unknown>): Principal =>
  attribute ? { id, role, attribute } : { id, role };

// -----------------------------------------------------------------------------

describe('definePolicy', () => {
  it('normalises shorthand column rules into object form and defaults the mask', () => {
    const policy = definePolicy({
      resource: 'employee',
      role: ['analyst'],
      columnRule: { name: 'write', ssn: 'masked' },
    });
    expect(policy.columnRule['name']).toEqual({ access: 'write' });
    expect(policy.columnRule['ssn']).toEqual({ access: 'masked', mask: 'redact' });
    expect(policy.defaultColumnAccess).toBe('read');
    expect(policy.allowInsert).toBe(true);
  });

  it('rejects a mask on a non-masked column instead of silently ignoring it', () => {
    expect(() =>
      definePolicy({
        resource: 'employee',
        role: ['analyst'],
        columnRule: { ssn: { access: 'read', mask: 'last4' } },
      }),
    ).toThrow(/masks only apply/);
  });

  it('rejects an empty role list and an empty resource', () => {
    expect(() => definePolicy({ resource: 'employee', role: [] })).toThrow(/non-empty `role`/);
    expect(() => definePolicy({ resource: '', role: ['x'] })).toThrow(/non-empty `resource`/);
  });

  it('rejects an invalid access value', () => {
    expect(() =>
      definePolicy({
        resource: 'employee',
        role: ['analyst'],
        columnRule: { name: 'delete' as never },
      }),
    ).toThrow(/invalid access/);
  });
});

describe('expandRole', () => {
  const definition: readonly RoleDefinition[] = [
    { name: 'admin', extend: ['manager'] },
    { name: 'manager', extend: ['analyst'] },
    { name: 'analyst' },
  ];

  it('walks inheritance edges breadth-first and deterministically', () => {
    expect(expandRole(['admin'], definition)).toEqual(['admin', 'manager', 'analyst']);
  });

  it('terminates on a cycle rather than looping forever', () => {
    const cyclic: readonly RoleDefinition[] = [
      { name: 'a', extend: ['b'] },
      { name: 'b', extend: ['c'] },
      { name: 'c', extend: ['a'] },
    ];
    expect(expandRole(['a'], cyclic)).toEqual(['a', 'b', 'c']);
  });

  it('terminates on a self-referential role', () => {
    expect(expandRole(['loop'], [{ name: 'loop', extend: ['loop'] }])).toEqual(['loop']);
  });

  it('passes undefined roles through as leaves and dedupes', () => {
    expect(expandRole(['admin', 'analyst', 'ghost'], definition)).toEqual([
      'admin',
      'analyst',
      'ghost',
      'manager',
    ]);
  });
});

describe('selectPolicy', () => {
  it('matches through inherited roles', () => {
    const p = principalOf('u1', ['admin'], { tenant_id: 't1' });
    const matched = selectPolicy([analyst, auditor], p, {
      roleDefinition: [{ name: 'admin', extend: ['analyst', 'auditor'] }],
    });
    expect(matched).toHaveLength(2);
  });

  it('matches a wildcard policy for any principal', () => {
    const everyone = definePolicy({ resource: 'employee', role: '*', columnRule: { id: 'read' } });
    expect(selectPolicy([everyone], principalOf('u9', []))).toEqual([everyone]);
  });

  it('throws when the policy set spans resources and no resource is named', () => {
    const other = definePolicy({ resource: 'invoice', role: ['analyst'] });
    expect(() => selectPolicy([analyst, other], principalOf('u1', ['analyst']))).toThrow(
      /spans resources/,
    );
  });

  it('scopes to the named resource when one is given', () => {
    const other = definePolicy({ resource: 'invoice', role: ['analyst'] });
    const matched = selectPolicy([analyst, other], principalOf('u1', ['analyst']), {
      resource: 'invoice',
    });
    expect(matched).toEqual([other]);
  });
});

describe('compilePolicyFilter — the server-canonical half', () => {
  it('compiles a principal attribute into a plain protocol comparison', () => {
    const filter = compilePolicyFilter(analyst, principalOf('u1', ['analyst'], { tenant_id: 't1' }));
    expect(filter).toEqual({ type: 'comparison', columnId: 'tenant_id', op: 'eq', value: 't1' });
  });

  it('produces a different filter per principal', () => {
    const a = compilePolicyFilter(analyst, principalOf('u1', ['analyst'], { tenant_id: 't1' }));
    const b = compilePolicyFilter(analyst, principalOf('u2', ['analyst'], { tenant_id: 't2' }));
    expect(a).not.toEqual(b);
    expect(b).toEqual({ type: 'comparison', columnId: 'tenant_id', op: 'eq', value: 't2' });
  });

  it('denies all when the principal matches no policy', () => {
    const filter = compilePolicyFilter([analyst, auditor], principalOf('u3', ['intern']));
    expect(isDenyAllFilter(filter)).toBe(true);
    expect(filter).toEqual(DENY_ALL_FILTER);
  });

  it('denies all when a required principal attribute is missing', () => {
    const filter = compilePolicyFilter(analyst, principalOf('u4', ['analyst'], { region: 'eu' }));
    expect(isDenyAllFilter(filter)).toBe(true);
  });

  it('ANDs the fragments of every matching policy — most restrictive, never a union', () => {
    const principal = principalOf('u1', ['analyst', 'auditor'], { tenant_id: 't1' });
    const filter = compilePolicyFilter([analyst, auditor], principal);
    expect(filter).toEqual({
      type: 'logical',
      op: 'and',
      filters: [
        { type: 'comparison', columnId: 'tenant_id', op: 'eq', value: 't1' },
        { type: 'comparison', columnId: 'archived', op: 'eq', value: false },
      ],
    });
  });

  it('returns null (no filter) for an unrestricted matching policy', () => {
    const open = definePolicy({ resource: 'employee', role: '*' });
    expect(compilePolicyFilter(open, principalOf('u1', ['analyst']))).toBeNull();
  });

  it('supports a function rowFilter and flattens nested conjunctions', () => {
    const dynamic = definePolicy({
      resource: 'employee',
      role: ['analyst'],
      rowFilter: (p) => ({
        type: 'logical',
        op: 'and',
        filters: [
          { type: 'comparison', columnId: 'owner', op: 'eq', value: p.id },
          { type: 'comparison', columnId: 'archived', op: 'eq', value: false },
        ],
      }),
    });
    const filter = compilePolicyFilter(dynamic, principalOf('u7', ['analyst']));
    expect(filter).toEqual({
      type: 'logical',
      op: 'and',
      filters: [
        { type: 'comparison', columnId: 'owner', op: 'eq', value: 'u7' },
        { type: 'comparison', columnId: 'archived', op: 'eq', value: false },
      ],
    });
  });

  it('compiles an array-valued attribute into an `in` comparison', () => {
    const scoped = definePolicy({
      resource: 'employee',
      role: ['analyst'],
      attributeCondition: [{ columnId: 'region', attribute: 'region', op: 'in' }],
    });
    expect(
      compilePolicyFilter(scoped, principalOf('u1', ['analyst'], { region: ['eu', 'us'] })),
    ).toEqual({ type: 'comparison', columnId: 'region', op: 'in', values: ['eu', 'us'] });
  });
});

describe('andFilter', () => {
  it('drops nulls and flattens', () => {
    const a: FilterNode = { type: 'comparison', columnId: 'a', op: 'eq', value: 1 };
    const b: FilterNode = { type: 'comparison', columnId: 'b', op: 'eq', value: 2 };
    expect(andFilter(null, a)).toEqual(a);
    expect(andFilter(a, b)).toEqual({ type: 'logical', op: 'and', filters: [a, b] });
    expect(andFilter(null, null)).toBeNull();
  });

  it('short-circuits to deny-all if any operand denies', () => {
    const a: FilterNode = { type: 'comparison', columnId: 'a', op: 'eq', value: 1 };
    expect(andFilter(a, DENY_ALL_FILTER)).toEqual(DENY_ALL_FILTER);
  });
});

describe('deny-all filter semantics', () => {
  it('evaluates to false against any row', () => {
    expect(evaluateRowFilter(DENY_ALL_FILTER, { anything: 1 })).toBe(false);
  });

  it('names no column, so it is safe for a principal who may not know the schema', () => {
    expect(JSON.stringify(DENY_ALL_FILTER)).not.toContain('columnId');
  });

  it('does not misidentify an ordinary not-filter as deny-all', () => {
    expect(
      isDenyAllFilter({
        type: 'logical',
        op: 'not',
        filters: [{ type: 'comparison', columnId: 'a', op: 'eq', value: 1 }],
      }),
    ).toBe(false);
    expect(isDenyAllFilter(null)).toBe(false);
  });
});

describe('applyColumnPolicy', () => {
  const principal = principalOf('u1', ['analyst'], { tenant_id: 't1' });

  it('never lets a hidden column appear in the projected schema', () => {
    const result = applyColumnPolicy(schema, analyst, principal);
    expect(result.schema.map((c) => c.id)).not.toContain('internal_note');
    expect(result.visibleColumn).not.toContain('internal_note');
    expect(result.hiddenColumn).toEqual(['internal_note']);
  });

  it('partitions columns into visible / writable / masked', () => {
    const result = applyColumnPolicy(schema, analyst, principal);
    expect(result.writableColumn).toEqual(['name']);
    expect(result.maskedColumn).toEqual(['ssn']);
    expect(result.accessOf('salary')).toBe('read');
    expect(result.accessOf('id')).toBe('read'); // defaultColumnAccess
  });

  it('hides everything when no policy matches — fail closed', () => {
    const result = applyColumnPolicy(schema, [analyst, auditor], principalOf('nobody', []));
    expect(result.schema).toHaveLength(0);
    expect(result.hiddenColumn).toHaveLength(schema.length);
    expect(result.accessOf('name')).toBe('hidden');
  });

  it('resolves conflicts most-restrictive-wins across matching policies', () => {
    const dual = principalOf('u1', ['analyst', 'auditor'], { tenant_id: 't1' });
    const result = applyColumnPolicy(schema, [analyst, auditor], dual);
    // analyst says write, auditor says read → read wins.
    expect(result.accessOf('name')).toBe('read');
    // analyst says read, auditor says hidden → hidden wins.
    expect(result.accessOf('salary')).toBe('hidden');
    expect(result.schema.map((c) => c.id)).not.toContain('salary');
    // Both mask ssn: last4 vs hash → hash discloses less, so hash wins.
    expect(result.maskOf('ssn')).toBe('hash');
  });

  it('masks cells and rows, dropping hidden keys from the row entirely', () => {
    const result = applyColumnPolicy(schema, analyst, principal);
    const masked = result.maskRow({
      id: 1,
      tenant_id: 't1',
      name: 'Ada',
      salary: 120000,
      ssn: '123456789',
      internal_note: 'do not show',
    });
    expect(masked['ssn']).toBe(`${'•'.repeat(5)}6789`);
    expect(masked['name']).toBe('Ada');
    expect('internal_note' in masked).toBe(false);
  });

  it('passes non-masked values through maskCell untouched', () => {
    const result = applyColumnPolicy(schema, analyst, principal);
    expect(result.maskCell('name', 'Ada')).toBe('Ada');
    expect(result.maskOf('name')).toBeUndefined();
  });
});

describe('maskValue strategies', () => {
  it('redacts fully', () => {
    expect(maskValue('4111111111111111', 'redact')).toBe(REDACTED_TOKEN);
  });

  it('keeps the last four characters', () => {
    expect(maskValue('4111111111111111', 'last4')).toBe(`${'•'.repeat(12)}1111`);
  });

  it('redacts short values outright rather than revealing them as a tail', () => {
    expect(maskValue('1234', 'last4')).toBe(REDACTED_TOKEN);
    expect(maskValue('12', 'last4')).toBe(REDACTED_TOKEN);
  });

  it('hashes stably and equal plaintext hashes equally', () => {
    const a = maskValue('secret', 'hash');
    expect(a).toBe(maskValue('secret', 'hash'));
    expect(a).not.toBe(maskValue('secre1', 'hash'));
    expect(String(a)).toMatch(/^[0-9a-f]{8}$/);
  });

  it('nulls out', () => {
    expect(maskValue('anything', 'null')).toBeNull();
    expect(maskValue(null, 'null')).toBeNull();
  });

  it('passes null and undefined through for non-null strategies', () => {
    expect(maskValue(null, 'redact')).toBeNull();
    expect(maskValue(undefined, 'last4')).toBeUndefined();
  });
});

describe('evaluateRowFilter', () => {
  const row = { a: 5, s: 'Hello', n: null };

  it('handles the scalar comparison operators', () => {
    expect(evaluateRowFilter({ type: 'comparison', columnId: 'a', op: 'eq', value: 5 }, row)).toBe(
      true,
    );
    expect(evaluateRowFilter({ type: 'comparison', columnId: 'a', op: 'gt', value: 5 }, row)).toBe(
      false,
    );
    expect(evaluateRowFilter({ type: 'comparison', columnId: 'a', op: 'gte', value: 5 }, row)).toBe(
      true,
    );
    expect(evaluateRowFilter({ type: 'comparison', columnId: 'n', op: 'isNull' }, row)).toBe(true);
  });

  it('handles list and range operators', () => {
    expect(
      evaluateRowFilter({ type: 'comparison', columnId: 'a', op: 'in', values: [1, 5] }, row),
    ).toBe(true);
    expect(
      evaluateRowFilter(
        { type: 'comparison', columnId: 'a', op: 'between', values: [1, 10] },
        row,
      ),
    ).toBe(true);
    expect(
      evaluateRowFilter(
        { type: 'comparison', columnId: 'a', op: 'notBetween', values: [1, 10] },
        row,
      ),
    ).toBe(false);
  });

  it('is case-insensitive for string ops unless asked otherwise', () => {
    expect(
      evaluateRowFilter({ type: 'comparison', columnId: 's', op: 'contains', value: 'hell' }, row),
    ).toBe(true);
    expect(
      evaluateRowFilter(
        { type: 'comparison', columnId: 's', op: 'contains', value: 'hell', caseSensitive: true },
        row,
      ),
    ).toBe(false);
  });

  it('treats a null cell as failing every ordering comparison', () => {
    expect(evaluateRowFilter({ type: 'comparison', columnId: 'n', op: 'lt', value: 1 }, row)).toBe(
      false,
    );
    expect(evaluateRowFilter({ type: 'comparison', columnId: 'n', op: 'gt', value: 1 }, row)).toBe(
      false,
    );
  });

  it('handles logical composition and the null (no filter) case', () => {
    expect(evaluateRowFilter(null, row)).toBe(true);
    expect(
      evaluateRowFilter(
        {
          type: 'logical',
          op: 'or',
          filters: [
            { type: 'comparison', columnId: 'a', op: 'eq', value: 99 },
            { type: 'comparison', columnId: 's', op: 'startsWith', value: 'He' },
          ],
        },
        row,
      ),
    ).toBe(true);
  });
});

describe('guardMutation', () => {
  const principal = principalOf('u1', ['analyst'], { tenant_id: 't1' });
  const update = (fields: Record<string, unknown>): UpdateMutation => ({
    kind: 'update',
    clientId: 'c1',
    rowId: 1,
    fields,
  });

  it('allows an update to a writable column', () => {
    expect(guardMutation(update({ name: 'Ada' }), analyst, principal)).toEqual({ allowed: true });
  });

  it('denies an update to a read-only column with a typed reason', () => {
    const result = guardMutation(update({ salary: 1 }), analyst, principal);
    expect(result).toMatchObject({
      allowed: false,
      reason: 'column-not-writable',
      columnId: 'salary',
    });
  });

  it('denies an update to a hidden column with the hidden reason', () => {
    expect(guardMutation(update({ internal_note: 'x' }), analyst, principal)).toMatchObject({
      allowed: false,
      reason: 'column-hidden',
    });
  });

  it('denies everything for a principal with no matching policy', () => {
    expect(guardMutation(update({ name: 'x' }), analyst, principalOf('u9', ['intern']))).toMatchObject(
      { allowed: false, reason: 'no-matching-policy' },
    );
  });

  it('denies editing a row belonging to another tenant', () => {
    const result = guardMutation(update({ name: 'Ada' }), analyst, principal, {
      row: { tenant_id: 't2', name: 'Bob' },
    });
    expect(result).toMatchObject({ allowed: false, reason: 'row-filter-mismatch' });
  });

  it('denies re-tenanting your own row out of your slice', () => {
    const retenant = definePolicy({
      ...analyst,
      columnRule: { ...analyst.columnRule, tenant_id: 'write' },
    });
    const result = guardMutation(update({ tenant_id: 't2' }), retenant, principal, {
      row: { tenant_id: 't1' },
    });
    expect(result).toMatchObject({ allowed: false, reason: 'row-filter-mismatch' });
  });

  it('denies an insert into another tenant and allows one into your own', () => {
    const insertable = definePolicy({
      ...analyst,
      columnRule: { ...analyst.columnRule, tenant_id: 'write' },
    });
    expect(
      guardMutation(
        { kind: 'insert', clientId: 'c2', row: { tenant_id: 't2', name: 'Eve' } },
        insertable,
        principal,
      ),
    ).toMatchObject({ allowed: false, reason: 'row-filter-mismatch' });
    expect(
      guardMutation(
        { kind: 'insert', clientId: 'c3', row: { tenant_id: 't1', name: 'Eve' } },
        insertable,
        principal,
      ),
    ).toEqual({ allowed: true });
  });

  it('honours allowInsert / allowDelete with distinct reasons', () => {
    const readOnly = definePolicy({
      resource: 'employee',
      role: ['analyst'],
      allowInsert: false,
      allowDelete: false,
    });
    expect(
      guardMutation({ kind: 'insert', clientId: 'c4', row: {} }, readOnly, principal),
    ).toMatchObject({ allowed: false, reason: 'insert-not-permitted' });
    expect(
      guardMutation({ kind: 'delete', clientId: 'c5', rowId: 1 }, readOnly, principal),
    ).toMatchObject({ allowed: false, reason: 'delete-not-permitted' });
  });

  it('denies a delete when any matching policy forbids it — most restrictive wins', () => {
    const permissive = definePolicy({ resource: 'employee', role: ['analyst'] });
    const strict = definePolicy({ resource: 'employee', role: ['auditor'], allowDelete: false });
    const dual = principalOf('u1', ['analyst', 'auditor']);
    expect(
      guardMutation({ kind: 'delete', clientId: 'c6', rowId: 1 }, [permissive, strict], dual),
    ).toMatchObject({ allowed: false, reason: 'delete-not-permitted' });
  });

  it('allows a delete when the row is inside the principal slice', () => {
    expect(
      guardMutation({ kind: 'delete', clientId: 'c7', rowId: 1 }, analyst, principal, {
        row: { tenant_id: 't1' },
      }),
    ).toEqual({ allowed: true });
  });

  it('resolves writability most-restrictive-wins across matching policies', () => {
    const dual = principalOf('u1', ['analyst', 'auditor'], { tenant_id: 't1' });
    const policySet: readonly Policy[] = [analyst, auditor];
    // analyst grants write on `name`; auditor only read → the guard must deny.
    expect(guardMutation(update({ name: 'Ada' }), policySet, dual, { row: { tenant_id: 't1', archived: false } })).toMatchObject({
      allowed: false,
      reason: 'column-not-writable',
    });
  });
});
