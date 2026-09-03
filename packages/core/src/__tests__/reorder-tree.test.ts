import { describe, expect, it } from 'vitest';
import {
  applyDrop,
  dropPositionFor,
  normalizeDragSet,
  resolveDrop,
  subtreeOf,
  type FlatNode,
} from '../reorder-tree';

/**
 * root
 *  ├ a          (folder)
 *  │  ├ a1
 *  │  └ a2
 *  ├ b          (folder, empty)
 *  └ c
 */
const node: FlatNode[] = [
  { id: 'a', parentId: null, depth: 0, canAcceptChild: true },
  { id: 'a1', parentId: 'a', depth: 1, canAcceptChild: false },
  { id: 'a2', parentId: 'a', depth: 1, canAcceptChild: false },
  { id: 'b', parentId: null, depth: 0, canAcceptChild: true },
  { id: 'c', parentId: null, depth: 0, canAcceptChild: false },
];

const index = (id: string): number => node.findIndex((n) => n.id === id);

describe('normalizeDragSet', () => {
  it('passes independent nodes through in order', () => {
    expect(normalizeDragSet(['a1', 'c'], node)).toEqual(['a1', 'c']);
  });

  it('drops a child whose ancestor is also selected', () => {
    // Moving both 'a' and 'a1' would move 'a1' twice.
    expect(normalizeDragSet(['a', 'a1'], node)).toEqual(['a']);
  });

  it('drops a deep descendant, not just a direct child', () => {
    const deep: FlatNode[] = [
      { id: 'x', parentId: null, depth: 0, canAcceptChild: true },
      { id: 'y', parentId: 'x', depth: 1, canAcceptChild: true },
      { id: 'z', parentId: 'y', depth: 2, canAcceptChild: false },
    ];
    expect(normalizeDragSet(['x', 'z'], deep)).toEqual(['x']);
  });

  it('ignores ids that are not in the tree', () => {
    expect(normalizeDragSet(['ghost', 'c'], node)).toEqual(['c']);
  });

  it('terminates on a malformed cyclic parent chain', () => {
    const cyclic: FlatNode[] = [
      { id: 'p', parentId: 'q', depth: 0, canAcceptChild: true },
      { id: 'q', parentId: 'p', depth: 0, canAcceptChild: true },
    ];
    expect(() => normalizeDragSet(['p'], cyclic)).not.toThrow();
  });
});

describe('subtreeOf', () => {
  it('includes the node and every descendant', () => {
    expect([...subtreeOf('a', node)].sort()).toEqual(['a', 'a1', 'a2']);
  });

  it('is just the node itself for a leaf', () => {
    expect([...subtreeOf('c', node)]).toEqual(['c']);
  });
});

describe('dropPositionFor', () => {
  it('uses thirds over a node that can take children', () => {
    expect(dropPositionFor(2, 30, true)).toBe('before');
    expect(dropPositionFor(15, 30, true)).toBe('inside');
    expect(dropPositionFor(28, 30, true)).toBe('after');
  });

  it('uses halves over a leaf, never offering "inside"', () => {
    expect(dropPositionFor(2, 30, false)).toBe('before');
    expect(dropPositionFor(15, 30, false)).toBe('after');
    expect(dropPositionFor(28, 30, false)).toBe('after');
  });

  it('clamps an out-of-range offset', () => {
    expect(dropPositionFor(-10, 30, true)).toBe('before');
    expect(dropPositionFor(500, 30, true)).toBe('after');
  });

  it('degrades safely on a zero row height', () => {
    expect(dropPositionFor(5, 0, true)).toBe('before');
  });
});

describe('resolveDrop', () => {
  it('resolves an "inside" drop to a parent with an append', () => {
    const result = resolveDrop(['c'], index('b'), 15, 30, node);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.target).toMatchObject({
      position: 'inside',
      parentId: 'b',
      beforeId: null,
      indicatorDepth: 1,
    });
  });

  it('resolves a "before" drop to the hovered node as the sibling', () => {
    const result = resolveDrop(['c'], index('a1'), 2, 30, node);
    if (!result.ok) throw new Error('expected ok');
    expect(result.target).toMatchObject({
      position: 'before',
      parentId: 'a',
      beforeId: 'a1',
    });
  });

  it('skips descendants when finding the next sibling for an "after" drop', () => {
    // Dropping after 'a' must target 'b' — NOT 'a1', the next flat row.
    const result = resolveDrop(['c'], index('a'), 28, 30, node);
    if (!result.ok) throw new Error('expected ok');
    expect(result.target).toMatchObject({
      position: 'after',
      parentId: null,
      beforeId: 'b',
    });
  });

  it('appends when there is no next sibling', () => {
    const result = resolveDrop(['a1'], index('c'), 28, 30, node);
    if (!result.ok) throw new Error('expected ok');
    expect(result.target).toMatchObject({ parentId: null, beforeId: null });
  });

  it('refuses a drop into the dragged node’s own subtree', () => {
    const result = resolveDrop(['a'], index('a1'), 15, 30, node);
    expect(result).toEqual({ ok: false, rejection: { reason: 'into-own-subtree' } });
  });

  it('refuses a drop onto the dragged node itself', () => {
    const result = resolveDrop(['a'], index('a'), 15, 30, node);
    expect(result).toEqual({ ok: false, rejection: { reason: 'into-own-subtree' } });
  });

  it('refuses a no-op drop back where the node already is', () => {
    // 'a2' dropped before... nothing changes: it already precedes 'b'.
    const result = resolveDrop(['a2'], index('b'), 2, 30, node);
    expect(result).toEqual({ ok: false, rejection: { reason: 'unchanged' } });
  });

  it('reports no target for an out-of-range index', () => {
    expect(resolveDrop(['a'], 99, 15, 30, node)).toEqual({
      ok: false,
      rejection: { reason: 'no-target' },
    });
  });

  it('reports not-droppable for an empty drag set', () => {
    expect(resolveDrop([], 0, 15, 30, node)).toEqual({
      ok: false,
      rejection: { reason: 'not-droppable' },
    });
  });
});

describe('applyDrop', () => {
  it('moves a leaf into a folder, re-parenting and re-depthing it', () => {
    const result = resolveDrop(['c'], index('b'), 15, 30, node);
    if (!result.ok) throw new Error('expected ok');

    const next = applyDrop(node, ['c'], result.target);
    const moved = next.find((n) => n.id === 'c');
    expect(moved).toMatchObject({ parentId: 'b', depth: 1 });
    expect(next.map((n) => n.id)).toEqual(['a', 'a1', 'a2', 'b', 'c']);
  });

  it('carries a whole subtree along and keeps inner parents intact', () => {
    const target = { position: 'inside' as const, parentId: 'b', beforeId: null, overIndex: 3, indicatorDepth: 1 };
    const next = applyDrop(node, ['a'], target);

    expect(next.find((n) => n.id === 'a')).toMatchObject({ parentId: 'b', depth: 1 });
    // Children follow, re-depthed but still parented to 'a'.
    expect(next.find((n) => n.id === 'a1')).toMatchObject({ parentId: 'a', depth: 2 });
    expect(next.find((n) => n.id === 'a2')).toMatchObject({ parentId: 'a', depth: 2 });
    expect(next).toHaveLength(node.length);
  });

  it('moves a multi-row selection as one block, preserving relative order', () => {
    const target = { position: 'before' as const, parentId: null, beforeId: 'a', overIndex: 0, indicatorDepth: 0 };
    const next = applyDrop(node, ['b', 'c'], target);

    expect(next.map((n) => n.id)).toEqual(['b', 'c', 'a', 'a1', 'a2']);
  });

  it('does not duplicate a child when its parent is also in the drag set', () => {
    const target = { position: 'before' as const, parentId: null, beforeId: 'c', overIndex: 4, indicatorDepth: 0 };
    const next = applyDrop(node, ['a', 'a1'], target);

    expect(next).toHaveLength(node.length);
    expect(next.filter((n) => n.id === 'a1')).toHaveLength(1);
  });

  it('appends to the end when beforeId is null', () => {
    const target = { position: 'after' as const, parentId: null, beforeId: null, overIndex: 4, indicatorDepth: 0 };
    const next = applyDrop(node, ['a1'], target);
    expect(next[next.length - 1]?.id).toBe('a1');
    expect(next.find((n) => n.id === 'a1')).toMatchObject({ parentId: null, depth: 0 });
  });
});
