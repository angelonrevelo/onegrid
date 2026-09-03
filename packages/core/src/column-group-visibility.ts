// =============================================================================
// Column-group visibility manager
//
// Single-column show/hide already ships in `<ColumnToolPanel>`. What is missing
// is toggling a whole header group in one action — "hide all of Q3" — and the
// tri-state bookkeeping that makes such a toggle honest when only some of a
// group's columns are hidden.
//
// Design decisions, and why:
//
//   1. THE GROUP IS TRI-STATE, LIKE A CHECKBOX TREE. `'all' | 'some' | 'none'`.
//      A group whose columns are half-hidden must render indeterminate, and
//      clicking it must go to a defined place — here, to fully visible, because
//      "show me everything in this group" is the action a user reaches for when
//      they cannot find a column.
//
//   2. HIDING EVERYTHING IS REFUSED. A grid with zero visible columns renders
//      as an empty box with no way back, and adopters hit this immediately with
//      a "hide all" button. `applyGroupVisibility` keeps a configurable minimum
//      (default 1) and reports the refusal instead of silently ignoring it.
//
//   3. ORDER IS PRESERVED ACROSS A HIDE/SHOW CYCLE. Hiding a column and showing
//      it again must put it back where it was, not at the end. The manager
//      therefore stores visibility as a set over the FULL ordered column list
//      and derives the visible list from it, rather than splicing columns out
//      of an array and pushing them back later.
//
//   4. A COLUMN IN NO GROUP IS STILL MANAGEABLE. Real column sets are a mix of
//      grouped and ungrouped columns; they are reported under a synthetic
//      ungrouped bucket rather than being invisible to the manager.
// =============================================================================

import type { ColumnDef, ColumnGroupDef } from './types';

/** @public */
export type GroupVisibility = 'all' | 'some' | 'none';

/** @public */
export interface GroupState {
  readonly label: string;
  readonly columnId: ReadonlyArray<string>;
  readonly visibility: GroupVisibility;
  readonly visibleCount: number;
  readonly totalCount: number;
}

/** @public */
export interface VisibilityResult {
  /** The new hidden set. Unchanged (by identity) when the change was refused. */
  readonly hidden: ReadonlySet<string>;
  /** True when the request was refused by the minimum-visible guard. */
  readonly refused: boolean;
  readonly reason?: string;
}

/** Synthetic group label for columns that belong to no declared group. @public */
export const UNGROUPED_LABEL = '(ungrouped)';

/**
 * Current tri-state for every group, plus the ungrouped bucket.
 * @public
 */
export function groupState(
  column: ReadonlyArray<ColumnDef>,
  group: ReadonlyArray<ColumnGroupDef>,
  hidden: ReadonlySet<string>,
): GroupState[] {
  const known = new Set<string>();
  const state: GroupState[] = [];

  for (const g of group) {
    // Only count ids that actually exist as columns; a group may name a column
    // that has since been removed and counting it would skew the tri-state.
    const id = g.columnIds.filter((cid) => column.some((c) => c.id === cid));
    id.forEach((cid) => known.add(cid));

    const visibleCount = id.filter((cid) => !hidden.has(cid)).length;
    state.push({
      label: g.label,
      columnId: id,
      totalCount: id.length,
      visibleCount,
      visibility:
        id.length === 0 || visibleCount === 0
          ? 'none'
          : visibleCount === id.length
            ? 'all'
            : 'some',
    });
  }

  const ungrouped = column.map((c) => c.id).filter((id) => !known.has(id));
  if (ungrouped.length > 0) {
    const visibleCount = ungrouped.filter((id) => !hidden.has(id)).length;
    state.push({
      label: UNGROUPED_LABEL,
      columnId: ungrouped,
      totalCount: ungrouped.length,
      visibleCount,
      visibility:
        visibleCount === 0 ? 'none' : visibleCount === ungrouped.length ? 'all' : 'some',
    });
  }

  return state;
}

/** @public */
export interface ApplyVisibilityOption {
  /** Minimum columns that must remain visible. Default 1. See design note 2. */
  readonly minVisible?: number;
}

/**
 * Show or hide every column in a group.
 *
 * `visible: undefined` toggles using the tri-state rule from design note 1:
 * a fully-visible group hides, and anything else shows.
 * @public
 */
export function applyGroupVisibility(
  column: ReadonlyArray<ColumnDef>,
  group: ReadonlyArray<ColumnGroupDef>,
  hidden: ReadonlySet<string>,
  label: string,
  visible?: boolean,
  option: ApplyVisibilityOption = {},
): VisibilityResult {
  const minVisible = option.minVisible ?? 1;
  const state = groupState(column, group, hidden).find((s) => s.label === label);

  if (state === undefined) {
    return { hidden, refused: true, reason: `unknown group "${label}"` };
  }

  const target = visible ?? state.visibility !== 'all';
  const next = new Set(hidden);

  for (const id of state.columnId) {
    if (target) next.delete(id);
    else next.add(id);
  }

  const visibleCount = column.filter((c) => !next.has(c.id)).length;
  if (visibleCount < minVisible) {
    return {
      hidden,
      refused: true,
      reason: `refused: would leave ${visibleCount} visible column(s), minimum is ${minVisible}`,
    };
  }

  return { hidden: next, refused: false };
}

/**
 * Show or hide one column, under the same minimum-visible guard.
 * @public
 */
export function applyColumnVisibility(
  column: ReadonlyArray<ColumnDef>,
  hidden: ReadonlySet<string>,
  columnId: string,
  visible?: boolean,
  option: ApplyVisibilityOption = {},
): VisibilityResult {
  const minVisible = option.minVisible ?? 1;
  if (!column.some((c) => c.id === columnId)) {
    return { hidden, refused: true, reason: `unknown column "${columnId}"` };
  }

  const target = visible ?? hidden.has(columnId);
  const next = new Set(hidden);
  if (target) next.delete(columnId);
  else next.add(columnId);

  const visibleCount = column.filter((c) => !next.has(c.id)).length;
  if (visibleCount < minVisible) {
    return {
      hidden,
      refused: true,
      reason: `refused: would leave ${visibleCount} visible column(s), minimum is ${minVisible}`,
    };
  }

  return { hidden: next, refused: false };
}

/**
 * Derive the visible column list, in the original declared order.
 * This is what makes a hide/show cycle order-preserving — see design note 3.
 * @public
 */
export function visibleColumn(
  column: ReadonlyArray<ColumnDef>,
  hidden: ReadonlySet<string>,
): ColumnDef[] {
  return column.filter((c) => !hidden.has(c.id));
}

/**
 * Drop hidden ids from the column-group band so a group whose columns are all
 * hidden does not paint an empty header cell.
 * @public
 */
export function visibleGroup(
  group: ReadonlyArray<ColumnGroupDef>,
  hidden: ReadonlySet<string>,
): ColumnGroupDef[] {
  return group
    .map((g) => ({ ...g, columnIds: g.columnIds.filter((id) => !hidden.has(id)) }))
    .filter((g) => g.columnIds.length > 0);
}
