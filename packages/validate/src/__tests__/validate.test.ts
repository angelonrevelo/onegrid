import { describe, expect, it } from 'vitest';
import {
  CYCLE_RULE_ID,
  compareColumn,
  compareValue,
  createValidator,
  fromColumnValidator,
  isBlank,
  oneOf,
  pattern,
  planRule,
  range,
  referentialIntegrity,
  required,
  rowCountBetween,
  summarize,
  sumEquals,
  toColumnValidator,
  toNumber,
  unique,
} from '../index';
import type { CellRule, Diagnostic, RowRule, SheetSource } from '../index';

// -----------------------------------------------------------------------------
// A mutable in-memory table standing in for the adopter's data store. Rows are
// plain records; `id` doubles as the stable row key so insert and delete in the
// middle of the table can be tested honestly.
// -----------------------------------------------------------------------------

interface Table extends SheetSource {
  readonly row: Record<string, unknown>[];
}

function makeTable(row: Record<string, unknown>[]): Table {
  const table: Table = {
    row,
    get numRows() {
      return row.length;
    },
    getCell: (rowIndex, columnId) => row[rowIndex]?.[columnId],
    getRowKey: (rowIndex) => String(row[rowIndex]?.['id'] ?? rowIndex),
  };
  return table;
}

function messageOf(diagnostic: readonly Diagnostic[]): string[] {
  return diagnostic.map((d) => d.message).sort();
}

// -----------------------------------------------------------------------------
// Scope: cell
// -----------------------------------------------------------------------------

describe('cell scope', () => {
  it('flags a blank required cell and addresses it by row and column', async () => {
    const table = makeTable([
      { id: 'a', name: 'Ada' },
      { id: 'b', name: '  ' },
    ]);
    const validator = createValidator({ source: table, rule: [required({ column: 'name' })] });
    const report = await validator.validateAll();

    expect(report.diagnostic).toHaveLength(1);
    expect(report.diagnostic[0]?.scope).toBe('cell');
    expect(report.diagnostic[0]?.row).toBe(1);
    expect(report.diagnostic[0]?.rowKey).toBe('b');
    expect(report.diagnostic[0]?.column).toEqual(['name']);
  });

  it('serves diagnosticAt for the renderer to tint one cell', async () => {
    const table = makeTable([{ id: 'a', name: '', age: 12 }]);
    const validator = createValidator({
      source: table,
      rule: [required({ column: 'name' }), range({ column: 'age', min: 18 })],
    });
    await validator.validateAll();

    expect(validator.diagnosticAt(0, 'name')).toHaveLength(1);
    expect(validator.diagnosticAt(0, 'age')).toHaveLength(1);
    expect(validator.diagnosticAt(0, 'other')).toHaveLength(0);
    expect(validator.diagnosticAt(1, 'name')).toHaveLength(0);
  });

  it('clears a cell diagnostic once the edit fixes it', async () => {
    const table = makeTable([{ id: 'a', name: '' }]);
    const validator = createValidator({ source: table, rule: [required({ column: 'name' })] });
    expect((await validator.validateAll()).diagnostic).toHaveLength(1);

    table.row[0]!['name'] = 'Ada';
    const report = await validator.applyChange({
      type: 'update',
      rowIndex: 0,
      before: { name: '' },
      after: { name: 'Ada' },
    });
    expect(report.diagnostic).toHaveLength(0);
  });
});

// -----------------------------------------------------------------------------
// Scope: row
// -----------------------------------------------------------------------------

describe('row scope', () => {
  it('rejects a row whose end_date precedes its start_date', async () => {
    const table = makeTable([
      { id: 'a', start_date: '2026-01-01', end_date: '2026-02-01' },
      { id: 'b', start_date: '2026-05-01', end_date: '2026-03-01' },
    ]);
    const validator = createValidator({
      source: table,
      rule: [compareColumn({ left: 'end_date', right: 'start_date', operator: '>' })],
    });
    const report = await validator.validateAll();

    expect(report.diagnostic).toHaveLength(1);
    expect(report.diagnostic[0]?.scope).toBe('row');
    expect(report.diagnostic[0]?.row).toBe(1);
    expect(report.diagnostic[0]?.column).toEqual(['end_date', 'start_date']);
  });

  it('implicates the columns a row rule names', async () => {
    const table = makeTable([{ id: 'a', price: 10, discount: 20 }]);
    const rule: RowRule = {
      kind: 'row',
      id: 'discount-cap',
      input: ['price', 'discount'],
      validate: (row) =>
        Number(row['discount']) > Number(row['price'])
          ? { ok: false, message: 'discount exceeds price', column: ['discount'] }
          : { ok: true },
    };
    const validator = createValidator({ source: table, rule: [rule] });
    const report = await validator.validateAll();
    expect(report.diagnostic[0]?.column).toEqual(['discount']);
  });

  it('passes a row comparison when either side is blank', async () => {
    const table = makeTable([{ id: 'a', start_date: '', end_date: '2020-01-01' }]);
    const validator = createValidator({
      source: table,
      rule: [compareColumn({ left: 'end_date', right: 'start_date', operator: '>' })],
    });
    expect((await validator.validateAll()).diagnostic).toHaveLength(0);
  });
});

// -----------------------------------------------------------------------------
// Scope: sheet
// -----------------------------------------------------------------------------

describe('sheet scope', () => {
  it('flags every row sharing a duplicated key', async () => {
    const table = makeTable([
      { id: 'a', sku: 'X1' },
      { id: 'b', sku: 'X1' },
      { id: 'c', sku: 'X2' },
    ]);
    const validator = createValidator({ source: table, rule: [unique({ column: 'sku' })] });
    const report = await validator.validateAll();

    expect(report.diagnostic).toHaveLength(2);
    expect(report.diagnostic.map((d) => d.row)).toEqual([0, 1]);
    expect(report.diagnostic[0]?.scope).toBe('sheet');
  });

  it('supports a composite unique key', async () => {
    const table = makeTable([
      { id: 'a', tenant: 't1', code: 'C' },
      { id: 'b', tenant: 't2', code: 'C' },
      { id: 'c', tenant: 't1', code: 'C' },
    ]);
    const validator = createValidator({
      source: table,
      rule: [unique({ column: ['tenant', 'code'] })],
    });
    const report = await validator.validateAll();
    expect(report.diagnostic.map((d) => d.rowKey)).toEqual(['a', 'c']);
  });

  it('never indexes a blank value for uniqueness', async () => {
    const table = makeTable([
      { id: 'a', sku: '' },
      { id: 'b', sku: null },
      { id: 'c', sku: undefined },
    ]);
    const validator = createValidator({ source: table, rule: [unique({ column: 'sku' })] });
    expect((await validator.validateAll()).diagnostic).toHaveLength(0);
  });

  it('checks an aggregate sum per group', async () => {
    const table = makeTable([
      { id: 'a', dept: 'eng', allocation: 60 },
      { id: 'b', dept: 'eng', allocation: 40 },
      { id: 'c', dept: 'ops', allocation: 70 },
    ]);
    const validator = createValidator({
      source: table,
      rule: [sumEquals({ column: 'allocation', total: 100, groupBy: 'dept' })],
    });
    const report = await validator.validateAll();

    expect(report.diagnostic).toHaveLength(1);
    expect(report.diagnostic[0]?.group).toBe('ops');
    expect(report.diagnostic[0]?.message).toContain('70');
  });

  it('checks referential integrity against another column', async () => {
    const table = makeTable([
      { id: 'a', employee_id: 'e1', manager_id: null },
      { id: 'b', employee_id: 'e2', manager_id: 'e1' },
      { id: 'c', employee_id: 'e3', manager_id: 'e9' },
    ]);
    const validator = createValidator({
      source: table,
      rule: [referentialIntegrity({ column: 'manager_id', target: 'employee_id' })],
    });
    const report = await validator.validateAll();

    expect(report.diagnostic).toHaveLength(1);
    expect(report.diagnostic[0]?.rowKey).toBe('c');
  });

  it('re-resolves referential integrity when the missing target arrives', async () => {
    const table = makeTable([{ id: 'a', employee_id: 'e1', manager_id: 'e9' }]);
    const validator = createValidator({
      source: table,
      rule: [referentialIntegrity({ column: 'manager_id', target: 'employee_id' })],
    });
    expect((await validator.validateAll()).diagnostic).toHaveLength(1);

    table.row.push({ id: 'b', employee_id: 'e9', manager_id: null });
    const report = await validator.applyChange({ type: 'insert', rowIndex: 1 });
    expect(report.diagnostic).toHaveLength(0);
  });

  it('bounds the row count', async () => {
    const table = makeTable([{ id: 'a' }, { id: 'b' }]);
    const validator = createValidator({
      source: table,
      rule: [rowCountBetween({ min: 3, max: 5 })],
    });
    expect((await validator.validateAll()).diagnostic).toHaveLength(1);

    table.row.push({ id: 'c' });
    const report = await validator.applyChange({ type: 'insert', rowIndex: 2 });
    expect(report.diagnostic).toHaveLength(0);
  });
});

// -----------------------------------------------------------------------------
// Incremental revalidation — proven by counting rule invocations
// -----------------------------------------------------------------------------

function bigTable(count: number): Table {
  const row: Record<string, unknown>[] = [];
  for (let i = 0; i < count; i += 1) {
    row.push({ id: `r${i}`, sku: `S${i}`, name: `n${i}`, note: '' });
  }
  return makeTable(row);
}

describe('incremental revalidation', () => {
  it('touches every row once on the full pass', async () => {
    const table = bigTable(2000);
    const validator = createValidator({
      source: table,
      rule: [required({ column: 'name' }), unique({ column: 'sku' })],
    });
    await validator.validateAll();

    const stat = validator.stat();
    expect(stat.invocation['required:name']).toBe(2000);
    // Seed plus one diagnose — the aggregate is never asked per row.
    expect(stat.invocation['unique:sku']).toBe(2);
  });

  it('revalidates one row, not the sheet, after a cell edit', async () => {
    const table = bigTable(2000);
    const validator = createValidator({
      source: table,
      rule: [required({ column: 'name' }), unique({ column: 'sku' })],
    });
    await validator.validateAll();
    validator.resetStat();

    table.row[7]!['name'] = '';
    await validator.applyChange({
      type: 'update',
      rowIndex: 7,
      before: { name: 'n7' },
      after: { name: '' },
    });

    const stat = validator.stat();
    expect(stat.invocation['required:name']).toBe(1);
    expect(stat.invocation['unique:sku']).toBeUndefined();
    expect(stat.totalInvocation).toBe(1);
    expect(validator.report().diagnostic).toHaveLength(1);
  });

  it('costs the same on a 2000-row table as on a 20-row one', async () => {
    const cost = async (count: number): Promise<number> => {
      const table = bigTable(count);
      const validator = createValidator({
        source: table,
        rule: [required({ column: 'name' }), unique({ column: 'sku' })],
      });
      await validator.validateAll();
      validator.resetStat();
      table.row[3]!['sku'] = 'S0';
      await validator.applyChange({
        type: 'update',
        rowIndex: 3,
        before: { sku: 'S3' },
        after: { sku: 'S0' },
      });
      return validator.stat().totalInvocation;
    };
    expect(await cost(2000)).toBe(await cost(20));
  });

  it('invokes nothing when the edited column feeds no rule', async () => {
    const table = bigTable(50);
    const validator = createValidator({ source: table, rule: [required({ column: 'name' })] });
    await validator.validateAll();
    validator.resetStat();

    table.row[0]!['note'] = 'irrelevant';
    await validator.applyChange({
      type: 'update',
      rowIndex: 0,
      before: { note: '' },
      after: { note: 'irrelevant' },
    });
    expect(validator.stat().totalInvocation).toBe(0);
  });

  it('propagates invalidation transitively through a rule that reads another rule', async () => {
    const table = bigTable(10);
    const downstream: RowRule = {
      kind: 'row',
      id: 'downstream',
      input: ['note'],
      dependsOn: ['required:name'],
      validate: (_row, context) =>
        context.diagnosticOf('required:name').length > 0
          ? { ok: false, message: 'blocked by name' }
          : { ok: true },
    };
    const validator = createValidator({
      source: table,
      rule: [required({ column: 'name' }), downstream],
    });
    await validator.validateAll();
    validator.resetStat();

    table.row[2]!['name'] = '';
    await validator.applyChange({
      type: 'update',
      rowIndex: 2,
      before: { name: 'n2' },
      after: { name: '' },
    });
    // `downstream` reads `note`, not `name` — the rule-to-rule edge is what
    // pulls it back into the dirty set.
    expect(validator.stat().invocation['downstream']).toBe(1);
    expect(messageOf(validator.report().diagnostic)).toContain('blocked by name');
  });
});

// -----------------------------------------------------------------------------
// The incremental uniqueness index
// -----------------------------------------------------------------------------

describe('incremental uniqueness index', () => {
  it('clears both duplicates when one of them is deleted', async () => {
    const table = makeTable([
      { id: 'a', sku: 'X1' },
      { id: 'b', sku: 'X1' },
    ]);
    const validator = createValidator({ source: table, rule: [unique({ column: 'sku' })] });
    expect((await validator.validateAll()).diagnostic).toHaveLength(2);

    table.row.splice(0, 1);
    const report = await validator.applyChange({
      type: 'delete',
      rowIndex: 0,
      rowKey: 'a',
      before: { sku: 'X1' },
    });
    expect(report.diagnostic).toHaveLength(0);
  });

  it('re-flags the duplicate when the deleted row is reinserted', async () => {
    const table = makeTable([
      { id: 'a', sku: 'X1' },
      { id: 'b', sku: 'X1' },
    ]);
    const validator = createValidator({ source: table, rule: [unique({ column: 'sku' })] });
    await validator.validateAll();

    table.row.splice(0, 1);
    await validator.applyChange({ type: 'delete', rowIndex: 0, rowKey: 'a', before: { sku: 'X1' } });

    table.row.unshift({ id: 'a', sku: 'X1' });
    const report = await validator.applyChange({ type: 'insert', rowIndex: 0 });
    expect(report.diagnostic).toHaveLength(2);
    expect(report.diagnostic.map((d) => d.rowKey).sort()).toEqual(['a', 'b']);
  });

  it('keeps two of three duplicates flagged after one is deleted', async () => {
    const table = makeTable([
      { id: 'a', sku: 'X1' },
      { id: 'b', sku: 'X1' },
      { id: 'c', sku: 'X1' },
    ]);
    const validator = createValidator({ source: table, rule: [unique({ column: 'sku' })] });
    expect((await validator.validateAll()).diagnostic).toHaveLength(3);

    table.row.splice(1, 1);
    const report = await validator.applyChange({
      type: 'delete',
      rowIndex: 1,
      rowKey: 'b',
      before: { sku: 'X1' },
    });
    expect(report.diagnostic).toHaveLength(2);
    expect(report.diagnostic.map((d) => d.rowKey).sort()).toEqual(['a', 'c']);
  });

  it('follows an edit away from and back to a duplicate key', async () => {
    const table = makeTable([
      { id: 'a', sku: 'X1' },
      { id: 'b', sku: 'X1' },
    ]);
    const validator = createValidator({ source: table, rule: [unique({ column: 'sku' })] });
    await validator.validateAll();

    table.row[1]!['sku'] = 'X2';
    expect(
      (
        await validator.applyChange({
          type: 'update',
          rowIndex: 1,
          before: { sku: 'X1' },
          after: { sku: 'X2' },
        })
      ).diagnostic,
    ).toHaveLength(0);

    table.row[1]!['sku'] = 'X1';
    expect(
      (
        await validator.applyChange({
          type: 'update',
          rowIndex: 1,
          before: { sku: 'X2' },
          after: { sku: 'X1' },
        })
      ).diagnostic,
    ).toHaveLength(2);
  });

  it('re-addresses surviving diagnostics after rows shift', async () => {
    const table = makeTable([
      { id: 'a', name: '' },
      { id: 'b', name: '' },
    ]);
    const validator = createValidator({ source: table, rule: [required({ column: 'name' })] });
    await validator.validateAll();
    expect(validator.diagnosticAt(1, 'name')).toHaveLength(1);

    table.row.splice(0, 1);
    await validator.applyChange({ type: 'delete', rowIndex: 0, rowKey: 'a', before: { name: '' } });

    // Row `b` moved from index 1 to index 0; its diagnostic moved with it.
    expect(validator.diagnosticAt(0, 'name')).toHaveLength(1);
    expect(validator.report().diagnostic).toHaveLength(1);
  });

  it('adjusts a running sum by delta instead of rescanning', async () => {
    const table = makeTable([
      { id: 'a', dept: 'eng', allocation: 60 },
      { id: 'b', dept: 'eng', allocation: 30 },
    ]);
    const validator = createValidator({
      source: table,
      rule: [sumEquals({ column: 'allocation', total: 100, groupBy: 'dept' })],
    });
    expect((await validator.validateAll()).diagnostic).toHaveLength(1);

    table.row[1]!['allocation'] = 40;
    const report = await validator.applyChange({
      type: 'update',
      rowIndex: 1,
      before: { allocation: 30 },
      after: { allocation: 40 },
    });
    expect(report.diagnostic).toHaveLength(0);
  });

  it('moves a row between groups without corrupting either sum', async () => {
    const table = makeTable([
      { id: 'a', dept: 'eng', allocation: 100 },
      { id: 'b', dept: 'ops', allocation: 100 },
      { id: 'c', dept: 'ops', allocation: 0 },
    ]);
    const validator = createValidator({
      source: table,
      rule: [sumEquals({ column: 'allocation', total: 100, groupBy: 'dept' })],
    });
    expect((await validator.validateAll()).diagnostic).toHaveLength(0);

    table.row[2]!['dept'] = 'eng';
    const report = await validator.applyChange({
      type: 'update',
      rowIndex: 2,
      before: { dept: 'ops', allocation: 0 },
      after: { dept: 'eng', allocation: 0 },
    });
    expect(report.diagnostic).toHaveLength(0);
  });
});

// -----------------------------------------------------------------------------
// Cycles
// -----------------------------------------------------------------------------

/** Two rules that never agree: each flips on the other's verdict. */
function oscillatingRule(): RowRule[] {
  const a: RowRule = {
    kind: 'row',
    id: 'osc-a',
    input: ['name'],
    dependsOn: ['osc-b'],
    validate: (_row, context) =>
      context.diagnosticOf('osc-b').length === 0 ? { ok: false, message: 'a fails' } : { ok: true },
  };
  const b: RowRule = {
    kind: 'row',
    id: 'osc-b',
    input: ['name'],
    dependsOn: ['osc-a'],
    validate: (_row, context) =>
      context.diagnosticOf('osc-a').length > 0 ? { ok: false, message: 'b fails' } : { ok: true },
  };
  return [a, b];
}

describe('cycle handling', () => {
  it('reports the cycle path', async () => {
    const table = makeTable([{ id: 'a', name: 'x' }]);
    const validator = createValidator({ source: table, rule: oscillatingRule() });
    const report = await validator.validateAll();

    expect(report.cycle).toHaveLength(1);
    expect(report.cycle[0]?.path[0]).toBe(report.cycle[0]?.path.at(-1));
    expect([...(report.cycle[0]?.path ?? [])].sort()).toEqual(['osc-a', 'osc-a', 'osc-b']);
  });

  it('emits a cycle diagnostic naming the path and the cap', async () => {
    const table = makeTable([{ id: 'a', name: 'x' }]);
    const validator = createValidator({ source: table, rule: oscillatingRule(), maxPass: 4 });
    const report = await validator.validateAll();

    const cycle = report.diagnostic.find((d) => d.ruleId === CYCLE_RULE_ID);
    expect(cycle).toBeDefined();
    expect(cycle?.severity).toBe('error');
    expect(cycle?.message).toContain('osc-a → osc-b → osc-a');
    expect(cycle?.message).toContain('at most 4 passes');
  });

  it('terminates a non-converging cycle at the pass cap', async () => {
    const table = makeTable([{ id: 'a', name: 'x' }]);
    const validator = createValidator({ source: table, rule: oscillatingRule(), maxPass: 4 });
    await validator.validateAll();
    expect(validator.stat().passUsed).toBe(4);
    expect(validator.report().cycle[0]?.passUsed).toBe(4);
  });

  it('honours a lower pass cap', async () => {
    const table = makeTable([{ id: 'a', name: 'x' }]);
    const validator = createValidator({ source: table, rule: oscillatingRule(), maxPass: 2 });
    await validator.validateAll();
    expect(validator.stat().passUsed).toBe(2);
    expect(validator.report().cycle[0]?.passCap).toBe(2);
  });

  it('detects a rule that depends on itself', () => {
    const self: RowRule = {
      kind: 'row',
      id: 'self',
      input: ['name'],
      dependsOn: ['self'],
      validate: () => ({ ok: true }),
    };
    const plan = planRule([self]);
    expect(plan.cyclePath).toEqual([['self', 'self']]);
  });

  it('orders an acyclic rule set so a dependent sees its prerequisite', async () => {
    const table = makeTable([{ id: 'a', name: '' }]);
    const downstream: RowRule = {
      kind: 'row',
      id: 'downstream',
      input: ['name'],
      dependsOn: ['required:name'],
      validate: (_row, context) =>
        context.diagnosticOf('required:name').length > 0
          ? { ok: false, message: 'saw the upstream failure' }
          : { ok: true },
    };
    // Declared in the wrong order on purpose — the topological sort fixes it.
    const validator = createValidator({
      source: table,
      rule: [downstream, required({ column: 'name' })],
    });
    const report = await validator.validateAll();

    expect(report.cycle).toHaveLength(0);
    expect(messageOf(report.diagnostic)).toContain('saw the upstream failure');
    const plan = planRule([downstream, required({ column: 'name' })]);
    expect(plan.stage.map((s) => (s.kind === 'linear' ? s.ruleId : '?'))).toEqual([
      'required:name',
      'downstream',
    ]);
  });
});

// -----------------------------------------------------------------------------
// Async rules, abort, and the stale-result race
// -----------------------------------------------------------------------------

interface Pending {
  readonly value: unknown;
  readonly signal: AbortSignal;
  readonly settle: (message: string | null) => void;
}

function gatedRule(pending: Pending[]): CellRule {
  return {
    kind: 'cell',
    id: 'gated',
    column: 'name',
    validate: (value, context) =>
      new Promise((resolve) => {
        pending.push({
          value,
          signal: context.signal,
          settle: (message) => resolve(message === null ? { ok: true } : { ok: false, message }),
        });
      }),
  };
}

describe('async rules', () => {
  it('awaits an async rule and records its verdict', async () => {
    const table = makeTable([{ id: 'a', name: 'x' }]);
    const rule: CellRule = {
      kind: 'cell',
      id: 'async-ok',
      column: 'name',
      validate: (value) => Promise.resolve(value === 'x' ? { ok: false, message: 'x is taken' } : { ok: true }),
    };
    const validator = createValidator({ source: table, rule: [rule] });
    const report = await validator.validateAll();
    expect(messageOf(report.diagnostic)).toEqual(['x is taken']);
  });

  it('aborts the superseded run', async () => {
    const table = makeTable([{ id: 'a', name: 'A' }]);
    const pending: Pending[] = [];
    const validator = createValidator({ source: table, rule: [gatedRule(pending)] });

    const first = validator.validateAll();
    const second = validator.validateAll();
    expect(pending).toHaveLength(2);
    expect(pending[0]?.signal.aborted).toBe(true);
    expect(pending[1]?.signal.aborted).toBe(false);

    pending[1]?.settle(null);
    await second;
    pending[0]?.settle('stale answer');
    await first;
  });

  it('never lets a stale result overwrite a fresh one', async () => {
    const table = makeTable([{ id: 'a', name: 'A' }]);
    const pending: Pending[] = [];
    const validator = createValidator({ source: table, rule: [gatedRule(pending)] });
    const initial = validator.validateAll();
    pending[0]?.settle(null);
    await initial;
    pending.length = 0;

    table.row[0]!['name'] = 'B';
    const slow = validator.applyChange({
      type: 'update',
      rowIndex: 0,
      before: { name: 'A' },
      after: { name: 'B' },
    });
    table.row[0]!['name'] = 'C';
    const fast = validator.applyChange({
      type: 'update',
      rowIndex: 0,
      before: { name: 'B' },
      after: { name: 'C' },
    });

    expect(pending).toHaveLength(2);
    pending[1]?.settle('C is bad');
    const fresh = await fast;
    expect(messageOf(fresh.diagnostic)).toEqual(['C is bad']);

    // The superseded run resolves last and must be discarded, not applied.
    pending[0]?.settle('B is bad');
    const stale = await slow;
    expect(stale.stale).toBe(true);
    expect(messageOf(validator.report().diagnostic)).toEqual(['C is bad']);
  });

  it('stops evaluating once disposed', async () => {
    const table = makeTable([{ id: 'a', name: 'A' }]);
    const pending: Pending[] = [];
    const validator = createValidator({ source: table, rule: [gatedRule(pending)] });
    const run = validator.validateAll();
    validator.dispose();
    pending[0]?.settle('too late');
    expect((await run).stale).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// Severity and blockCommit
// -----------------------------------------------------------------------------

describe('severity and blockCommit', () => {
  it('rejects a commit that produces an error', async () => {
    const table = makeTable([{ id: 'a', sku: 'X1' }, { id: 'b', sku: 'X2' }]);
    const validator = createValidator({ source: table, rule: [unique({ column: 'sku' })] });
    await validator.validateAll();

    const decision = await validator.checkCommit({
      type: 'update',
      rowIndex: 1,
      before: { sku: 'X2' },
      after: { sku: 'X1' },
    });
    expect(decision.allowed).toBe(false);
    expect(decision.summary.error).toBe(2);
    expect(decision.summary.blocking).toBe(2);
  });

  it('permits a commit that only produces a warning', async () => {
    const table = makeTable([{ id: 'a', sku: 'X1' }, { id: 'b', sku: 'X2' }]);
    const validator = createValidator({
      source: table,
      rule: [unique({ column: 'sku', severity: 'warning' })],
    });
    await validator.validateAll();

    const decision = await validator.checkCommit({
      type: 'update',
      rowIndex: 1,
      before: { sku: 'X2' },
      after: { sku: 'X1' },
    });
    expect(decision.allowed).toBe(true);
    expect(decision.summary.warning).toBe(2);
    expect(decision.summary.blocking).toBe(0);
  });

  it('lets a rule decouple severity from blocking', async () => {
    const table = makeTable([{ id: 'a', name: '' }]);
    const validator = createValidator({
      source: table,
      rule: [required({ column: 'name', severity: 'error', blockCommit: false })],
    });
    await validator.validateAll();

    const decision = await validator.checkCommit({
      type: 'update',
      rowIndex: 0,
      before: { name: '' },
      after: { name: '' },
    });
    expect(decision.summary.error).toBe(1);
    expect(decision.allowed).toBe(true);
  });

  it('lets an individual result override the rule severity', async () => {
    const table = makeTable([{ id: 'a', name: 'x' }]);
    const rule: CellRule = {
      kind: 'cell',
      id: 'soft',
      column: 'name',
      validate: () => ({ ok: false, message: 'just so you know', severity: 'info' }),
    };
    const validator = createValidator({ source: table, rule: [rule] });
    const report = await validator.validateAll();
    expect(report.summary.info).toBe(1);
    expect(report.summary.blocking).toBe(0);
  });

  it('rolls every aggregate back after a speculative check', async () => {
    const table = makeTable([{ id: 'a', sku: 'X1' }, { id: 'b', sku: 'X2' }]);
    const validator = createValidator({ source: table, rule: [unique({ column: 'sku' })] });
    await validator.validateAll();

    await validator.checkCommit({
      type: 'update',
      rowIndex: 1,
      before: { sku: 'X2' },
      after: { sku: 'X1' },
    });
    // The edit was never applied — the committed report must be untouched, and
    // a second identical check must reach the same verdict.
    expect(validator.report().diagnostic).toHaveLength(0);
    const again = await validator.checkCommit({
      type: 'update',
      rowIndex: 1,
      before: { sku: 'X2' },
      after: { sku: 'X1' },
    });
    expect(again.allowed).toBe(false);
    expect(again.summary.error).toBe(2);
  });

  it('summarizes counts by severity', () => {
    const base = { scope: 'cell' as const, row: 0, rowKey: 'a', column: [], group: null };
    const diagnostic: Diagnostic[] = [
      { ...base, ruleId: 'r1', severity: 'error', message: 'e', blockCommit: true },
      { ...base, ruleId: 'r2', severity: 'warning', message: 'w', blockCommit: false },
      { ...base, ruleId: 'r3', severity: 'info', message: 'i', blockCommit: false },
      { ...base, ruleId: 'r4', severity: 'error', message: 'e2', blockCommit: false },
    ];
    expect(summarize(diagnostic)).toEqual({
      error: 2,
      warning: 1,
      info: 1,
      total: 4,
      blocking: 1,
    });
  });
});

// -----------------------------------------------------------------------------
// The stock rule library
// -----------------------------------------------------------------------------

describe('stock rules', () => {
  const run = async (rule: Parameters<typeof createValidator>[0]['rule'], row: Record<string, unknown>[]) => {
    const validator = createValidator({ source: makeTable(row), rule });
    return (await validator.validateAll()).diagnostic;
  };

  it('required rejects blank and accepts content', async () => {
    expect(await run([required({ column: 'a' })], [{ id: '1', a: null }, { id: '2', a: 0 }])).toHaveLength(1);
  });

  it('range enforces both bounds and rejects non-numbers', async () => {
    const diagnostic = await run([range({ column: 'a', min: 1, max: 10 })], [
      { id: '1', a: 0 },
      { id: '2', a: 5 },
      { id: '3', a: 11 },
      { id: '4', a: 'abc' },
      { id: '5', a: '' },
    ]);
    expect(diagnostic.map((d) => d.row)).toEqual([0, 2, 3]);
  });

  it('pattern is not confused by a global regexp', async () => {
    const diagnostic = await run([pattern({ column: 'a', regexp: /^[A-Z]+$/g })], [
      { id: '1', a: 'AB' },
      { id: '2', a: 'CD' },
      { id: '3', a: 'ef' },
    ]);
    expect(diagnostic.map((d) => d.row)).toEqual([2]);
  });

  it('oneOf accepts only the allowed set', async () => {
    const diagnostic = await run([oneOf({ column: 'a', allowed: ['open', 'closed'] })], [
      { id: '1', a: 'open' },
      { id: '2', a: 'pending' },
    ]);
    expect(diagnostic).toHaveLength(1);
    expect(diagnostic[0]?.message).toContain('open, closed');
  });

  it('compareColumn handles numbers, dates and equality', async () => {
    const numeric = await run(
      [compareColumn({ left: 'a', right: 'b', operator: '<=' })],
      [
        { id: '1', a: 5, b: 10 },
        { id: '2', a: 11, b: 10 },
      ],
    );
    expect(numeric.map((d) => d.row)).toEqual([1]);

    const equal = await run(
      [compareColumn({ left: 'a', right: 'b', operator: '===' })],
      [{ id: '1', a: 'x', b: 'y' }],
    );
    expect(equal).toHaveLength(1);
  });

  it('sumEquals works ungrouped with a tolerance', async () => {
    expect(
      await run([sumEquals({ column: 'a', total: 1, tolerance: 0.01 })], [
        { id: '1', a: 0.3 },
        { id: '2', a: 0.3 },
        { id: '3', a: 0.4 },
      ]),
    ).toHaveLength(0);
  });

  it('rowCountBetween reports the actual count', async () => {
    const diagnostic = await run([rowCountBetween({ max: 1 })], [{ id: '1' }, { id: '2' }]);
    expect(diagnostic[0]?.message).toContain('row count is 2');
    expect(diagnostic[0]?.row).toBeNull();
  });

  it('exposes the value helpers it is built on', () => {
    expect(isBlank('  ')).toBe(true);
    expect(isBlank(0)).toBe(false);
    expect(toNumber('12')).toBe(12);
    expect(toNumber('abc')).toBeNull();
    expect(compareValue('2026-01-02', '2026-01-01')).toBe(1);
    expect(compareValue(null, 3)).toBeNull();
  });

  it('rejects two rules sharing an id', () => {
    expect(() =>
      createValidator({
        source: makeTable([]),
        rule: [required({ column: 'a', id: 'dup' }), required({ column: 'b', id: 'dup' })],
      }),
    ).toThrow(/OG_VALIDATE_DUPLICATE_RULE/);
  });
});

// -----------------------------------------------------------------------------
// Composition with @onegrid/core
// -----------------------------------------------------------------------------

describe('composition with the per-cell validator', () => {
  it('folds cell rules into a ColumnDef.validate function', async () => {
    const validate = toColumnValidator([required({ column: 'name' }), pattern({ column: 'name', regexp: /^[A-Z]/ })]);
    expect(await validate('', { rowIndex: 0, columnId: 'name', phase: 'commit' })).toEqual({
      ok: false,
      message: 'name is required',
      severity: 'error',
    });
    expect(await validate('ada', { rowIndex: 0, columnId: 'name', phase: 'commit' })).toMatchObject({
      ok: false,
    });
    expect(await validate('Ada', { rowIndex: 0, columnId: 'name', phase: 'commit' })).toEqual({ ok: true });
  });

  it('downgrades info to warning, which is all core understands', async () => {
    const rule: CellRule = {
      kind: 'cell',
      id: 'note',
      column: 'name',
      severity: 'info',
      validate: () => ({ ok: false, message: 'heads up' }),
    };
    const result = await toColumnValidator(rule)('x', { rowIndex: 0, columnId: 'name', phase: 'input' });
    expect(result).toEqual({ ok: false, message: 'heads up', severity: 'warning' });
  });

  it('wraps an existing core validator as a cell rule', async () => {
    const table = makeTable([{ id: 'a', name: 'nope' }]);
    const rule = fromColumnValidator({
      id: 'legacy',
      column: 'name',
      validate: (value) => (value === 'nope' ? { ok: false, message: 'legacy says no' } : { ok: true }),
    });
    const validator = createValidator({ source: table, rule: [rule] });
    expect(messageOf((await validator.validateAll()).diagnostic)).toEqual(['legacy says no']);
  });
});
