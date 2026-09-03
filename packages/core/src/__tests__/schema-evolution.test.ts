import { describe, expect, it } from 'vitest';
import {
  brokenReference,
  diffSchema,
  reconcileActiveCell,
  reconcileColumnIndex,
  reconcileEditSession,
  reconcileFilter,
  reconcileSort,
} from '../schema-evolution';
import type { ColumnDef } from '../types';

const col = (id: string): ColumnDef => ({ id, width: 100 });

const before = [col('id'), col('name'), col('email'), col('revenue')];

describe('diffSchema', () => {
  it('reports an added column with its index', () => {
    const after = [col('id'), col('name'), col('status'), col('email'), col('revenue')];
    const diff = diffSchema(before, after);

    expect(diff.added).toEqual(['status']);
    expect(diff.removed).toEqual([]);
    expect(diff.change).toContainEqual({
      kind: 'add',
      column: after[2],
      atIndex: 2,
    });
  });

  it('reports a removed column', () => {
    const after = [col('id'), col('name'), col('revenue')];
    const diff = diffSchema(before, after);

    expect(diff.removed).toEqual(['email']);
    expect(diff.change).toContainEqual({ kind: 'remove', columnId: 'email' });
  });

  it('does not report reorder for columns merely displaced by an insertion', () => {
    // This is the trap: inserting at index 2 shifts email and revenue right,
    // but their ORDER relative to each other is unchanged.
    const after = [col('id'), col('name'), col('status'), col('email'), col('revenue')];
    expect(diffSchema(before, after).reordered).toEqual([]);
  });

  it('reports a genuine reorder', () => {
    const after = [col('name'), col('id'), col('email'), col('revenue')];
    expect(diffSchema(before, after).reordered).toContain('name');
  });

  it('never infers a rename — it reports a remove plus an add', () => {
    const after = [col('id'), col('full_name'), col('email'), col('revenue')];
    const diff = diffSchema(before, after);

    expect(diff.removed).toEqual(['name']);
    expect(diff.added).toEqual(['full_name']);
    expect(diff.change.some((c) => c.kind === 'rename')).toBe(false);
  });

  it('reports nothing for an identical schema', () => {
    const diff = diffSchema(before, [...before]);
    expect(diff.change).toEqual([]);
  });
});

describe('reconcileColumnIndex', () => {
  it('follows columns to their new positions by id', () => {
    // Remove 'name' (index 1): email 2→1, revenue 3→2.
    const after = [col('id'), col('email'), col('revenue')];
    const result = reconcileColumnIndex([2, 3], before, after);

    expect(result.value).toEqual([1, 2]);
    expect(result.dropped).toEqual([]);
  });

  it('drops indices whose column is gone and names them', () => {
    const after = [col('id'), col('revenue')];
    const result = reconcileColumnIndex([1, 2, 3], before, after);

    expect(result.value).toEqual([1]);
    expect(result.dropped).toEqual(['name', 'email']);
  });

  it('deduplicates and sorts the result', () => {
    const after = [col('revenue'), col('id')];
    const result = reconcileColumnIndex([3, 0, 3], before, after);
    expect(result.value).toEqual([0, 1]);
  });
});

describe('reconcileActiveCell', () => {
  it('follows the active column to its new index', () => {
    const after = [col('revenue'), col('email'), col('name'), col('id')];
    expect(reconcileActiveCell({ row: 7, col: 1 }, before, after)).toEqual({
      row: 7,
      col: 2,
    });
  });

  it('clamps left to the nearest surviving column when its own is removed', () => {
    // 'email' (index 2) removed; the nearest survivor to its left is 'name'.
    const after = [col('id'), col('name'), col('revenue')];
    expect(reconcileActiveCell({ row: 3, col: 2 }, before, after)).toEqual({
      row: 3,
      col: 1,
    });
  });

  it('falls back to column 0 when nothing to the left survived', () => {
    const after = [col('revenue')];
    expect(reconcileActiveCell({ row: 3, col: 1 }, before, after)).toEqual({
      row: 3,
      col: 0,
    });
  });

  it('clears the cursor when every column is gone', () => {
    expect(reconcileActiveCell({ row: 3, col: 1 }, before, [])).toBeNull();
  });

  it('passes a null cursor through', () => {
    expect(reconcileActiveCell(null, before, before)).toBeNull();
  });
});

describe('reconcileSort and reconcileFilter', () => {
  it('drops sort clauses on removed columns and reports them', () => {
    const after = [col('id'), col('name')];
    const result = reconcileSort(
      [
        { columnId: 'name', direction: 'asc' },
        { columnId: 'revenue', direction: 'desc' },
      ],
      after,
    );

    expect(result.value).toEqual([{ columnId: 'name', direction: 'asc' }]);
    expect(result.dropped).toEqual(['revenue']);
  });

  it('drops filter entries on removed columns', () => {
    const after = [col('id'), col('name')];
    const result = reconcileFilter({ name: 'ab', email: 'x@y' }, after);

    expect(result.value).toEqual({ name: 'ab' });
    expect(result.dropped).toEqual(['email']);
  });

  it('leaves an untouched sort alone', () => {
    const result = reconcileSort([{ columnId: 'id', direction: 'asc' }], before);
    expect(result.dropped).toEqual([]);
    expect(result.value).toHaveLength(1);
  });
});

describe('reconcileEditSession', () => {
  it('keeps a session whose column survives', () => {
    expect(reconcileEditSession({ row: 1, columnId: 'name' }, before)).toBe('keep');
  });

  it('cancels a session whose column vanished, rather than committing to nothing', () => {
    const after = [col('id')];
    expect(reconcileEditSession({ row: 1, columnId: 'name' }, after)).toBe('cancel');
  });

  it('keeps when there is no session', () => {
    expect(reconcileEditSession(null, [])).toBe('keep');
  });
});

describe('brokenReference', () => {
  it('names only the references that no longer resolve', () => {
    const after = [col('id'), col('revenue')];
    expect(brokenReference(['id', 'name', 'revenue', 'email'], after)).toEqual([
      'name',
      'email',
    ]);
  });

  it('returns empty when everything still resolves', () => {
    expect(brokenReference(['id', 'name'], before)).toEqual([]);
  });
});
