import { describe, expect, it } from 'vitest';
import { countTreeNodes, flattenTree, type TreeNode } from '../tree';

const tree: TreeNode<{ name: string }>[] = [
  {
    id: 'a',
    data: { name: 'A' },
    children: [
      {
        id: 'a.1',
        data: { name: 'A.1' },
        children: [
          { id: 'a.1.x', data: { name: 'A.1.x' } },
          { id: 'a.1.y', data: { name: 'A.1.y' } },
        ],
      },
      { id: 'a.2', data: { name: 'A.2' } },
    ],
  },
  { id: 'b', data: { name: 'B' } },
];

describe('flattenTree', () => {
  it('emits only roots when nothing is open', () => {
    const out = flattenTree(tree, new Set());
    expect(out.map((e) => e.id)).toEqual(['a', 'b']);
    expect(out[0]?.depth).toBe(0);
    expect(out[0]?.expanded).toBe(false);
    expect(out[0]?.isLeaf).toBe(false);
    expect(out[0]?.hasChildren).toBe(true);
    expect(out[1]?.isLeaf).toBe(true);
  });

  it('expands a node when its id is in openIds', () => {
    const out = flattenTree(tree, new Set(['a']));
    expect(out.map((e) => e.id)).toEqual(['a', 'a.1', 'a.2', 'b']);
    expect(out[1]?.depth).toBe(1);
    expect(out[2]?.depth).toBe(1);
  });

  it('expands recursively when multiple ancestors are open', () => {
    const out = flattenTree(tree, new Set(['a', 'a.1']));
    expect(out.map((e) => e.id)).toEqual(['a', 'a.1', 'a.1.x', 'a.1.y', 'a.2', 'b']);
    expect(out[2]?.depth).toBe(2);
  });

  it('marks a node with loadChildren but no children as hasChildren=true', () => {
    const lazy: TreeNode[] = [
      {
        id: 'lazy',
        data: {},
        loadChildren: () => Promise.resolve([]),
      },
    ];
    const out = flattenTree(lazy, new Set());
    expect(out[0]?.hasChildren).toBe(true);
    expect(out[0]?.isLeaf).toBe(false);
  });

  it('an open lazy node with empty children still emits just itself', () => {
    const lazy: TreeNode[] = [
      {
        id: 'lazy',
        data: {},
        loadChildren: () => Promise.resolve([]),
      },
    ];
    const out = flattenTree(lazy, new Set(['lazy']));
    expect(out.map((e) => e.id)).toEqual(['lazy']);
    expect(out[0]?.expanded).toBe(true);
  });
});

describe('countTreeNodes', () => {
  it('counts every node in every subtree', () => {
    expect(countTreeNodes(tree)).toBe(6);
  });

  it('counts a flat forest', () => {
    expect(
      countTreeNodes([
        { id: '1', data: 0 },
        { id: '2', data: 0 },
        { id: '3', data: 0 },
      ]),
    ).toBe(3);
  });
});
