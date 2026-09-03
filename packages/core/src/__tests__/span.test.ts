import { describe, expect, it } from 'vitest';
import {
  expandRangeOverSpan,
  navigateAcrossSpan,
  resolveSpan,
  type CellSpan,
} from '../span';

/** Build a getCellSpan from a sparse `"row,col": [rowSpan, colSpan]` map. */
function spanSource(
  declared: Record<string, [number, number]>,
): (row: number, col: number) => CellSpan | null {
  return (row, col) => {
    const found = declared[`${row},${col}`];
    return found ? { rowSpan: found[0], colSpan: found[1] } : null;
  };
}

const base = { windowStart: 0, windowEnd: 9, rowCount: 20, columnCount: 6 };

describe('resolveSpan', () => {
  it('marks the anchor and every covered cell of a 2x3 span', () => {
    const map = resolveSpan({
      ...base,
      getCellSpan: spanSource({ '1,1': [2, 3] }),
    });

    expect(map.roleAt(1, 1)).toBe('anchor');
    expect(map.roleAt(1, 2)).toBe('covered');
    expect(map.roleAt(1, 3)).toBe('covered');
    expect(map.roleAt(2, 1)).toBe('covered');
    expect(map.roleAt(2, 3)).toBe('covered');
    // Just outside the rectangle on both axes.
    expect(map.roleAt(3, 1)).toBe('none');
    expect(map.roleAt(1, 4)).toBe('none');
  });

  it('reports one anchor per span and shares the object with covered cells', () => {
    const map = resolveSpan({ ...base, getCellSpan: spanSource({ '0,0': [2, 2] }) });

    expect(map.anchor).toHaveLength(1);
    expect(map.spanAt(0, 0)).toBe(map.spanAt(1, 1));
    expect(map.spanAt(0, 0)?.rect).toEqual({
      rowStart: 0,
      rowEnd: 1,
      colStart: 0,
      colEnd: 1,
    });
  });

  it('treats a 1x1 declaration as no span at all', () => {
    const map = resolveSpan({ ...base, getCellSpan: spanSource({ '2,2': [1, 1] }) });
    expect(map.anchor).toHaveLength(0);
    expect(map.roleAt(2, 2)).toBe('none');
  });

  it('drops an overlapping span whole and reports the conflict', () => {
    const map = resolveSpan({
      ...base,
      getCellSpan: spanSource({ '0,0': [2, 2], '1,1': [2, 2] }),
    });

    expect(map.anchor).toHaveLength(1);
    expect(map.conflict).toHaveLength(1);
    expect(map.conflict[0]).toMatchObject({ row: 1, col: 1, reason: 'overlap' });
    // The loser leaves no partial footprint.
    expect(map.roleAt(2, 2)).toBe('none');
  });

  it('rejects a span running past the row or column count', () => {
    const map = resolveSpan({
      ...base,
      rowCount: 4,
      columnCount: 3,
      getCellSpan: spanSource({ '3,0': [2, 1], '0,2': [1, 2] }),
    });

    expect(map.conflict.map((c) => c.reason)).toEqual([
      'out-of-bounds',
      'out-of-bounds',
    ]);
    expect(map.anchor).toHaveLength(0);
  });

  it('rejects a non-integer or non-positive span', () => {
    const map = resolveSpan({
      ...base,
      getCellSpan: spanSource({ '0,0': [2.5, 1], '4,0': [0, 2], '6,0': [-1, 2] }),
    });
    expect(map.conflict.every((c) => c.reason === 'invalid')).toBe(true);
    expect(map.conflict).toHaveLength(3);
  });

  it('finds a span anchored above the window when maxSpanHeight allows it', () => {
    const declared = spanSource({ '8,0': [5, 1] });

    const blind = resolveSpan({
      windowStart: 10,
      windowEnd: 12,
      rowCount: 20,
      columnCount: 3,
      getCellSpan: declared,
    });
    // maxSpanHeight defaults to 1, so the off-screen anchor is not scanned.
    expect(blind.roleAt(10, 0)).toBe('none');

    const seeing = resolveSpan({
      windowStart: 10,
      windowEnd: 12,
      rowCount: 20,
      columnCount: 3,
      maxSpanHeight: 5,
      getCellSpan: declared,
    });
    expect(seeing.roleAt(10, 0)).toBe('covered');
    expect(seeing.spanAt(10, 0)?.anchorRow).toBe(8);
  });

  it('does not let a covered cell anchor a span of its own', () => {
    const map = resolveSpan({
      ...base,
      getCellSpan: spanSource({ '0,0': [3, 3], '1,1': [2, 2] }),
    });
    expect(map.anchor).toHaveLength(1);
    expect(map.spanAt(1, 1)?.anchorRow).toBe(0);
  });
});

describe('expandRangeOverSpan', () => {
  it('grows a range that clips a merge until it contains it', () => {
    const map = resolveSpan({ ...base, getCellSpan: spanSource({ '2,1': [3, 2] }) });

    const grown = expandRangeOverSpan(
      { rowStart: 3, rowEnd: 3, colStart: 2, colEnd: 2 },
      map,
    );
    expect(grown).toEqual({ rowStart: 2, rowEnd: 4, colStart: 1, colEnd: 2 });
  });

  it('reaches a fixed point when growing pulls in a second merge', () => {
    // Two merges side by side; selecting inside the first must swallow both.
    const map = resolveSpan({
      ...base,
      getCellSpan: spanSource({ '0,0': [1, 2], '0,2': [3, 2] }),
    });

    // The seed clips span A (cols 0-1) and span B (cols 2-3, rows 0-2).
    // Swallowing A is not enough — growing to reach B must then grow rows too.
    const grown = expandRangeOverSpan(
      { rowStart: 0, rowEnd: 0, colStart: 1, colEnd: 2 },
      map,
    );
    expect(grown).toEqual({ rowStart: 0, rowEnd: 2, colStart: 0, colEnd: 3 });
  });

  it('leaves a range that touches no merge untouched', () => {
    const map = resolveSpan({ ...base, getCellSpan: spanSource({ '9,5': [1, 1] }) });
    const rect = { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 1 };
    expect(expandRangeOverSpan(rect, map)).toEqual(rect);
  });
});

describe('navigateAcrossSpan', () => {
  const bound = { rowCount: 20, columnCount: 6 };

  it('steps off the far edge of a merge rather than into it', () => {
    const map = resolveSpan({ ...base, getCellSpan: spanSource({ '1,1': [3, 1] }) });
    // Standing on the anchor and pressing Down clears the whole 3-row merge.
    expect(navigateAcrossSpan({ row: 1, col: 1 }, 'down', map, bound)).toEqual({
      row: 4,
      col: 1,
    });
  });

  it('snaps to the anchor when it moves into a covered cell', () => {
    const map = resolveSpan({ ...base, getCellSpan: spanSource({ '5,2': [2, 2] }) });
    expect(navigateAcrossSpan({ row: 4, col: 3 }, 'down', map, bound)).toEqual({
      row: 5,
      col: 2,
    });
  });

  it('refuses to leave the grid at an edge', () => {
    const map = resolveSpan({ ...base, getCellSpan: spanSource({}) });
    expect(navigateAcrossSpan({ row: 0, col: 0 }, 'up', map, bound)).toEqual({
      row: 0,
      col: 0,
    });
    expect(navigateAcrossSpan({ row: 0, col: 0 }, 'left', map, bound)).toEqual({
      row: 0,
      col: 0,
    });
  });

  it('moves normally between unspanned cells', () => {
    const map = resolveSpan({ ...base, getCellSpan: spanSource({}) });
    expect(navigateAcrossSpan({ row: 3, col: 3 }, 'right', map, bound)).toEqual({
      row: 3,
      col: 4,
    });
  });
});
