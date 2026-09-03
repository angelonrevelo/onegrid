// =============================================================================
// Schema evolution at runtime
//
// Columns are added, removed, renamed and retyped while a grid is mounted —
// by a tool panel, by a live DDL change, by a query that returns a different
// shape. Everything the grid holds that is keyed BY POSITION (selection,
// active cell, sort, filter, the edit session) silently means something else
// afterwards. The classic symptom is a user's selection quietly jumping one
// column left after a hidden column is removed.
//
// Design decisions, and why:
//
//   1. SELECTION IS RECONCILED BY ID, NOT BY INDEX. The whole failure mode is
//      that indices are not stable, so `reconcileSelection` translates the old
//      indices to column IDs against the OLD column list, then back to indices
//      against the NEW one. A column that disappeared has no new index, and
//      the caller is told so rather than being handed a plausible wrong number.
//
//   2. A REMOVED COLUMN IS AN EVENT, NOT AN ERROR. Sorting or filtering on a
//      column that no longer exists is normal during evolution. The reconciler
//      drops those clauses and REPORTS the drop, so the adopter can re-query
//      rather than silently getting differently-ordered data.
//
//   3. RENAME IS DETECTED, NOT GUESSED. A rename is indistinguishable from a
//      drop-plus-add unless the adopter tells us. `SchemaChange` therefore has
//      an explicit `rename` kind; `diffSchema` will never infer one from
//      similarity, because a wrong inference silently moves a user's data.
//
//   4. AN IN-FLIGHT EDIT ON A VANISHED COLUMN IS CANCELLED, NOT COMMITTED.
//      Committing it would write to a column that no longer exists.
// =============================================================================

import type { ColumnDef } from './types';

/** @public */
export type SchemaChange =
  | { readonly kind: 'add'; readonly column: ColumnDef; readonly atIndex: number }
  | { readonly kind: 'remove'; readonly columnId: string }
  | { readonly kind: 'rename'; readonly from: string; readonly to: string }
  | { readonly kind: 'retype'; readonly columnId: string }
  | { readonly kind: 'reorder'; readonly columnId: string; readonly toIndex: number };

/** @public */
export interface SchemaDiff {
  readonly change: ReadonlyArray<SchemaChange>;
  readonly added: ReadonlyArray<string>;
  readonly removed: ReadonlyArray<string>;
  readonly reordered: ReadonlyArray<string>;
}

/**
 * Compare two column lists.
 *
 * Deliberately does NOT infer renames — see design note 3. A rename shows up
 * here as a remove plus an add, which is the honest reading of the evidence.
 * @public
 */
export function diffSchema(
  before: ReadonlyArray<ColumnDef>,
  after: ReadonlyArray<ColumnDef>,
): SchemaDiff {
  const beforeIndex = new Map(before.map((c, i) => [c.id, i] as const));
  const afterIndex = new Map(after.map((c, i) => [c.id, i] as const));

  const change: SchemaChange[] = [];
  const added: string[] = [];
  const removed: string[] = [];
  const reordered: string[] = [];

  for (const column of before) {
    if (!afterIndex.has(column.id)) {
      removed.push(column.id);
      change.push({ kind: 'remove', columnId: column.id });
    }
  }

  after.forEach((column, index) => {
    if (!beforeIndex.has(column.id)) {
      added.push(column.id);
      change.push({ kind: 'add', column, atIndex: index });
      return;
    }
    // Position changes are only meaningful relative to columns that survived,
    // so compare ranks within the surviving set rather than raw indices —
    // otherwise every column after an insertion looks reordered.
    const survivingBefore = before.filter((c) => afterIndex.has(c.id));
    const survivingAfter = after.filter((c) => beforeIndex.has(c.id));
    const oldRank = survivingBefore.findIndex((c) => c.id === column.id);
    const newRank = survivingAfter.findIndex((c) => c.id === column.id);
    if (oldRank !== newRank) {
      reordered.push(column.id);
      change.push({ kind: 'reorder', columnId: column.id, toIndex: index });
    }
  });

  return { change, added, removed, reordered };
}

/** @public */
export interface ReconcileResult<T> {
  readonly value: T;
  /** Column ids referenced by the old state that no longer exist. */
  readonly dropped: ReadonlyArray<string>;
}

/**
 * Translate a set of column INDICES through a schema change, by id.
 *
 * Indices whose column disappeared are dropped and reported; the rest land on
 * their new position.
 * @public
 */
export function reconcileColumnIndex(
  index: ReadonlyArray<number>,
  before: ReadonlyArray<ColumnDef>,
  after: ReadonlyArray<ColumnDef>,
): ReconcileResult<number[]> {
  const afterIndex = new Map(after.map((c, i) => [c.id, i] as const));
  const value: number[] = [];
  const dropped: string[] = [];

  for (const i of index) {
    const column = before[i];
    if (column === undefined) continue;
    const next = afterIndex.get(column.id);
    if (next === undefined) {
      dropped.push(column.id);
      continue;
    }
    value.push(next);
  }

  return { value: [...new Set(value)].sort((a, b) => a - b), dropped };
}

/**
 * Reconcile the active cell.
 *
 * When its column is gone we clamp to the nearest surviving column rather than
 * clearing the cursor: losing focus entirely on an unrelated schema change is
 * more disruptive than moving one column.
 * @public
 */
export function reconcileActiveCell(
  active: { row: number; col: number } | null,
  before: ReadonlyArray<ColumnDef>,
  after: ReadonlyArray<ColumnDef>,
): { row: number; col: number } | null {
  if (active === null) return null;
  if (after.length === 0) return null;

  const column = before[active.col];
  if (column === undefined) return null;

  const afterIndex = after.findIndex((c) => c.id === column.id);
  if (afterIndex >= 0) return { row: active.row, col: afterIndex };

  // Walk left through the old list for the nearest column that survived.
  for (let i = active.col - 1; i >= 0; i--) {
    const candidate = before[i];
    if (candidate === undefined) continue;
    const found = after.findIndex((c) => c.id === candidate.id);
    if (found >= 0) return { row: active.row, col: found };
  }

  return { row: active.row, col: 0 };
}

/**
 * Drop sort clauses whose column has gone.
 * `SortModel` is structurally `{ columnId, direction }[]`; typed loosely here
 * so this module does not depend on the protocol package.
 * @public
 */
export function reconcileSort<T extends { readonly columnId: string }>(
  sort: ReadonlyArray<T>,
  after: ReadonlyArray<ColumnDef>,
): ReconcileResult<T[]> {
  const alive = new Set(after.map((c) => c.id));
  const value: T[] = [];
  const dropped: string[] = [];

  for (const clause of sort) {
    if (alive.has(clause.columnId)) value.push(clause);
    else dropped.push(clause.columnId);
  }

  return { value, dropped };
}

/**
 * Drop filter entries whose column has gone. `FilterModel` is a record keyed
 * by column id in this repo, so the same rule applies key-wise.
 * @public
 */
export function reconcileFilter<T>(
  filter: Readonly<Record<string, T>>,
  after: ReadonlyArray<ColumnDef>,
): ReconcileResult<Record<string, T>> {
  const alive = new Set(after.map((c) => c.id));
  const value: Record<string, T> = {};
  const dropped: string[] = [];

  for (const [columnId, entry] of Object.entries(filter)) {
    if (alive.has(columnId)) value[columnId] = entry;
    else dropped.push(columnId);
  }

  return { value, dropped };
}

/**
 * What an in-flight edit session should do when the schema changes underneath
 * it. Committing an edit to a column that no longer exists would write into
 * nothing, so it is cancelled.
 * @public
 */
export function reconcileEditSession(
  session: { readonly row: number; readonly columnId: string } | null,
  after: ReadonlyArray<ColumnDef>,
): 'keep' | 'cancel' {
  if (session === null) return 'keep';
  return after.some((c) => c.id === session.columnId) ? 'keep' : 'cancel';
}

/**
 * The `#REF!` semantics a formula engine needs: which formula references broke.
 * Returns the referenced ids that no longer resolve, so the caller can mark
 * exactly those cells rather than invalidating every formula.
 * @public
 */
export function brokenReference(
  reference: ReadonlyArray<string>,
  after: ReadonlyArray<ColumnDef>,
): string[] {
  const alive = new Set(after.map((c) => c.id));
  return reference.filter((id) => !alive.has(id));
}
