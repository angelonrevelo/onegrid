// =============================================================================
// Demo seed — account + order_line over a live queryable.
//
// StrictMode mounts the Studio surface twice against the same session.
// Two concurrent CREATE TABLE + INSERT races duplicate PK rows because
// the in-process queryable does not enforce uniqueness. Coalesce on the
// queryable and skip once public.account already has rows.
// =============================================================================

import { findTable } from './model';
import type { StudioSession } from './apply';
import type { PostgresQueryable } from './model';

const inflight = new WeakMap<PostgresQueryable, Promise<void>>();

/**
 * Seed the Studio demo schema. Safe to call twice (or concurrently) on
 * the same queryable: the second call awaits the first and does not
 * insert again.
 * @public
 */
export async function seedStudioDemo(session: StudioSession): Promise<void> {
  const existing = inflight.get(session.queryable);
  if (existing) return existing;
  const run = applySeed(session);
  inflight.set(session.queryable, run);
  try {
    await run;
  } catch (err) {
    inflight.delete(session.queryable);
    throw err;
  }
}

async function applySeed(session: StudioSession): Promise<void> {
  let schema = await session.introspect();
  let account = findTable(schema, { schema: 'public', name: 'account' });
  if (account) {
    const existing = await session.list(account);
    if (existing.length > 0) return;
  }

  if (!account) {
    await session.applyDdl({
      kind: 'createTable',
      schema: 'public',
      table: 'account',
      column: [
        { name: 'account_id', type: 'uuid', isNullable: false, isPrimaryKey: true },
        { name: 'email', type: 'text', isNullable: false },
        { name: 'display_name', type: 'text', isNullable: true },
      ],
    });
  }

  schema = await session.introspect();
  const orderLine = findTable(schema, { schema: 'public', name: 'order_line' });
  if (!orderLine) {
    await session.applyDdl({
      kind: 'createTable',
      schema: 'public',
      table: 'order_line',
      column: [
        { name: 'order_line_id', type: 'bigint', isNullable: false, isPrimaryKey: true },
        { name: 'account_id', type: 'uuid', isNullable: false },
        { name: 'total_amount', type: 'numeric', isNullable: false },
      ],
    });
    await session.applyDdl({
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
  }

  schema = await session.introspect();
  account = findTable(schema, { schema: 'public', name: 'account' });
  if (!account) return;
  const existing = await session.list(account);
  if (existing.length > 0) return;

  await session.insert(account, {
    account_id: 'a-1',
    email: 'ada@onegrid.dev',
    display_name: 'Ada',
  });
  await session.insert(account, {
    account_id: 'a-2',
    email: 'grace@onegrid.dev',
    display_name: 'Grace',
  });
}
