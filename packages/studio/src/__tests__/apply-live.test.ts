import { describe, expect, it } from 'vitest';

import {
  applyDdl,
  applyDelete,
  applyInsert,
  applyList,
  applyUpdate,
  createMemoryQueryable,
  createStudioSession,
  findTable,
  introspectDatabase,
  listRow,
  measureQuery,
  seedStudioDemo,
} from '../index';

describe('compile-and-apply through a memory queryable', () => {
  it('creates tables, adds a typed column, sets a PK, adds an FK, and round-trips row DML', async () => {
    const queryable = createMemoryQueryable();

    await applyDdl(queryable, {
      kind: 'createTable',
      schema: 'public',
      table: 'account',
      column: [
        { name: 'account_id', type: 'uuid', isNullable: false },
        { name: 'email', type: 'text', isNullable: false },
      ],
    });
    await applyDdl(queryable, {
      kind: 'addPrimaryKey',
      schema: 'public',
      table: 'account',
      column: ['account_id'],
      name: 'account_pkey',
    });
    await applyDdl(queryable, {
      kind: 'addColumn',
      schema: 'public',
      table: 'account',
      column: { name: 'display_name', type: 'text', isNullable: true },
    });
    await applyDdl(queryable, {
      kind: 'createTable',
      schema: 'public',
      table: 'order_line',
      column: [
        { name: 'order_line_id', type: 'bigint', isNullable: false, isPrimaryKey: true },
        { name: 'account_id', type: 'uuid', isNullable: false },
        { name: 'total_amount', type: 'numeric', isNullable: false },
      ],
    });
    await applyDdl(queryable, {
      kind: 'addForeignKey',
      schema: 'public',
      table: 'order_line',
      name: 'order_line_account_id_fkey',
      column: ['account_id'],
      referencedSchema: 'public',
      referencedTable: 'account',
      referencedColumn: ['account_id'],
      onDelete: 'cascade',
    });

    const schema = await introspectDatabase(queryable);
    const account = findTable(schema, { schema: 'public', name: 'account' });
    const orderLine = findTable(schema, { schema: 'public', name: 'order_line' });
    expect(account).not.toBeNull();
    expect(orderLine).not.toBeNull();
    expect(account!.column.map((c) => c.name)).toEqual([
      'account_id',
      'email',
      'display_name',
    ]);
    expect(account!.column.find((c) => c.name === 'display_name')?.dataType).toBe('text');
    expect(account!.column.find((c) => c.name === 'display_name')?.isNullable).toBe(true);
    expect(account!.primaryKey?.column).toEqual(['account_id']);
    expect(orderLine!.foreignKey).toHaveLength(1);
    expect(orderLine!.foreignKey[0]!.referencedTable).toBe('account');
    expect(orderLine!.foreignKey[0]!.column).toEqual(['account_id']);
    expect(orderLine!.foreignKey[0]!.onDelete).toBe('cascade');

    const inserted = await applyInsert(queryable, account!, {
      account_id: 'a-1',
      email: 'ada@onegrid.dev',
    });
    expect(inserted).toHaveLength(1);
    expect(inserted[0]!.email).toBe('ada@onegrid.dev');
    expect(inserted[0]!.display_name).toBeNull();

    const updated = await applyUpdate(
      queryable,
      account!,
      { account_id: 'a-1' },
      { display_name: 'Ada' },
    );
    expect(updated[0]!.display_name).toBe('Ada');

    const listed = await applyList(queryable, account!);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.display_name).toBe('Ada');

    const snap = queryable.snapshot();
    const stored = snap.find((t) => t.name === 'account');
    expect(stored?.row).toHaveLength(1);
    expect(stored?.row[0]?.display_name).toBe('Ada');
    expect(stored?.primaryKey).toEqual(['account_id']);

    const removed = await applyDelete(queryable, account!, { account_id: 'a-1' });
    expect(removed).toHaveLength(1);
    expect(await applyList(queryable, account!)).toEqual([]);
  });
});

describe('measureQuery', () => {
  it('reports finite duration ≥ 0 and the known row count, twice', async () => {
    const queryable = createMemoryQueryable();
    await applyDdl(queryable, {
      kind: 'createTable',
      schema: 'public',
      table: 'sample',
      column: [
        { name: 'sample_id', type: 'int', isNullable: false, isPrimaryKey: true },
        { name: 'label', type: 'text', isNullable: false },
      ],
    });
    const schema = await introspectDatabase(queryable);
    const sample = findTable(schema, { schema: 'public', name: 'sample' })!;
    await applyInsert(queryable, sample, { sample_id: 1, label: 'a' });
    await applyInsert(queryable, sample, { sample_id: 2, label: 'b' });
    await applyInsert(queryable, sample, { sample_id: 3, label: 'c' });

    const statement = listRow(sample);
    const first = await measureQuery(queryable, statement);
    const second = await measureQuery(queryable, statement);

    expect(Number.isFinite(first.durationMs)).toBe(true);
    expect(first.durationMs).toBeGreaterThanOrEqual(0);
    expect(first.rowCount).toBe(3);
    expect(first.sql).toContain('SELECT * FROM');
    expect(Number.isFinite(second.durationMs)).toBe(true);
    expect(second.durationMs).toBeGreaterThanOrEqual(0);
    expect(second.rowCount).toBe(3);
  });
});

describe('seedStudioDemo', () => {
  async function accountId(queryable: ReturnType<typeof createMemoryQueryable>) {
    const session = createStudioSession(queryable);
    const schema = await session.introspect();
    const account = findTable(schema, { schema: 'public', name: 'account' });
    expect(account).not.toBeNull();
    const row = await applyList(queryable, account!);
    return row.map((r) => String(r.account_id ?? '')).sort();
  }

  it('invoking twice on one queryable yields 2 unique account rows, not 4', async () => {
    const queryable = createMemoryQueryable();
    const session = createStudioSession(queryable);
    await seedStudioDemo(session);
    await seedStudioDemo(session);
    const id = await accountId(queryable);
    expect(id).toHaveLength(2);
    expect(id).toEqual(['a-1', 'a-2']);
    expect(new Set(id).size).toBe(2);
  });

  it('concurrent invocations on one queryable still yield 2 unique account rows', async () => {
    const queryable = createMemoryQueryable();
    const session = createStudioSession(queryable);
    await Promise.all([seedStudioDemo(session), seedStudioDemo(session)]);
    const id = await accountId(queryable);
    expect(id).toHaveLength(2);
    expect(id).toEqual(['a-1', 'a-2']);
    expect(new Set(id).size).toBe(2);
  });
});
