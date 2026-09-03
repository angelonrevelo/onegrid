import { describe, expect, it } from 'vitest';
import {
  applyColumnVisibility,
  applyGroupVisibility,
  groupState,
  UNGROUPED_LABEL,
  visibleColumn,
  visibleGroup,
} from '../column-group-visibility';
import type { ColumnDef, ColumnGroupDef } from '../types';

const col = (id: string): ColumnDef => ({ id, width: 100 });

const column = [col('id'), col('q1'), col('q2'), col('q3'), col('note')];

const group: ColumnGroupDef[] = [
  { label: 'Quarter', columnIds: ['q1', 'q2', 'q3'] },
];

describe('groupState', () => {
  it('reports a fully visible group as "all"', () => {
    const state = groupState(column, group, new Set());
    expect(state[0]).toMatchObject({
      label: 'Quarter',
      visibility: 'all',
      visibleCount: 3,
      totalCount: 3,
    });
  });

  it('reports a partially hidden group as "some"', () => {
    const state = groupState(column, group, new Set(['q2']));
    expect(state[0]).toMatchObject({ visibility: 'some', visibleCount: 2 });
  });

  it('reports a fully hidden group as "none"', () => {
    const state = groupState(column, group, new Set(['q1', 'q2', 'q3']));
    expect(state[0]).toMatchObject({ visibility: 'none', visibleCount: 0 });
  });

  it('buckets ungrouped columns under a synthetic group', () => {
    const state = groupState(column, group, new Set());
    const ungrouped = state.find((s) => s.label === UNGROUPED_LABEL);
    expect(ungrouped?.columnId).toEqual(['id', 'note']);
  });

  it('ignores a group member that is not a real column', () => {
    const stale: ColumnGroupDef[] = [
      { label: 'Quarter', columnIds: ['q1', 'q2', 'q3', 'q4_deleted'] },
    ];
    const state = groupState(column, stale, new Set());
    // Counting the phantom would report 3/4 and render indeterminate forever.
    expect(state[0]).toMatchObject({ totalCount: 3, visibility: 'all' });
  });

  it('omits the ungrouped bucket when every column is grouped', () => {
    const full: ColumnGroupDef[] = [
      { label: 'All', columnIds: ['id', 'q1', 'q2', 'q3', 'note'] },
    ];
    const state = groupState(column, full, new Set());
    expect(state.some((s) => s.label === UNGROUPED_LABEL)).toBe(false);
  });
});

describe('applyGroupVisibility', () => {
  it('hides a fully visible group when toggled', () => {
    const result = applyGroupVisibility(column, group, new Set(), 'Quarter');
    expect(result.refused).toBe(false);
    expect([...result.hidden].sort()).toEqual(['q1', 'q2', 'q3']);
  });

  it('shows a partially hidden group when toggled, rather than hiding the rest', () => {
    const result = applyGroupVisibility(column, group, new Set(['q2']), 'Quarter');
    expect(result.hidden.size).toBe(0);
  });

  it('honours an explicit visible flag over the toggle rule', () => {
    const result = applyGroupVisibility(column, group, new Set(), 'Quarter', true);
    expect(result.hidden.size).toBe(0);
    expect(result.refused).toBe(false);
  });

  it('refuses a change that would leave no visible column', () => {
    const hidden = new Set(['id', 'note']);
    const result = applyGroupVisibility(column, group, hidden, 'Quarter');

    expect(result.refused).toBe(true);
    expect(result.reason).toMatch(/minimum/);
    // The original set is handed straight back, unmutated.
    expect(result.hidden).toBe(hidden);
  });

  it('honours a custom minVisible', () => {
    const result = applyGroupVisibility(column, group, new Set(), 'Quarter', undefined, {
      minVisible: 3,
    });
    // Hiding the 3 quarter columns would leave 2, below the floor of 3.
    expect(result.refused).toBe(true);
  });

  it('refuses an unknown group by name', () => {
    const result = applyGroupVisibility(column, group, new Set(), 'Nope');
    expect(result.refused).toBe(true);
    expect(result.reason).toMatch(/unknown group/);
  });

  it('can toggle the ungrouped bucket', () => {
    const result = applyGroupVisibility(column, group, new Set(), UNGROUPED_LABEL);
    expect([...result.hidden].sort()).toEqual(['id', 'note']);
  });
});

describe('applyColumnVisibility', () => {
  it('hides then shows a single column', () => {
    const hiddenOnce = applyColumnVisibility(column, new Set(), 'q1');
    expect([...hiddenOnce.hidden]).toEqual(['q1']);

    const shownAgain = applyColumnVisibility(column, hiddenOnce.hidden, 'q1');
    expect(shownAgain.hidden.size).toBe(0);
  });

  it('refuses to hide the last visible column', () => {
    const hidden = new Set(['id', 'q1', 'q2', 'q3']);
    const result = applyColumnVisibility(column, hidden, 'note');
    expect(result.refused).toBe(true);
  });

  it('refuses an unknown column', () => {
    const result = applyColumnVisibility(column, new Set(), 'nope');
    expect(result.refused).toBe(true);
    expect(result.reason).toMatch(/unknown column/);
  });
});

describe('visibleColumn and visibleGroup', () => {
  it('restores original order across a hide/show cycle', () => {
    const hidden = applyColumnVisibility(column, new Set(), 'q1').hidden;
    expect(visibleColumn(column, hidden).map((c) => c.id)).toEqual([
      'id',
      'q2',
      'q3',
      'note',
    ]);

    const shown = applyColumnVisibility(column, hidden, 'q1').hidden;
    // q1 returns to index 1, not to the end.
    expect(visibleColumn(column, shown).map((c) => c.id)).toEqual([
      'id',
      'q1',
      'q2',
      'q3',
      'note',
    ]);
  });

  it('trims hidden ids out of the group band', () => {
    const trimmed = visibleGroup(group, new Set(['q2']));
    expect(trimmed[0]?.columnIds).toEqual(['q1', 'q3']);
  });

  it('drops a group whose columns are all hidden', () => {
    expect(visibleGroup(group, new Set(['q1', 'q2', 'q3']))).toEqual([]);
  });
});
