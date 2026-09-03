// =============================================================================
// Drag-drop row reorder within a tree or a group, and for multi-row selections
//
// Wave 26 shipped flat single-row reorder: pick a row up, drop it at an index,
// fire `onRowReorder(from, to)`. That is correct for a flat list and wrong for
// hierarchical data, where a drop has to answer a question a flat index cannot
// express: did the row land BETWEEN two siblings, or INSIDE a node as its
// child? Every tree-reorder UI that feels bad has collapsed that distinction.
//
// Design decisions, and why:
//
//   1. A DROP IS A POSITION, NOT AN INDEX. `DropTarget` is
//      `{ parentId, beforeId }` — the semantic answer — with the flat index
//      carried alongside for renderers that want it. The adopter mutates their
//      tree with the parent/sibling pair, which is what their data structure
//      actually needs.
//
//   2. THE VERTICAL THIRD RULE DECIDES BETWEEN/INSIDE. Hovering the top or
//      bottom third of a row means "place before/after it"; the middle third
//      means "make it a child". This is the convention in every file tree and
//      it is what makes both actions reachable without a modifier key. The
//      middle band is suppressed for leaf nodes that cannot take children.
//
//   3. DROPPING A NODE INTO ITS OWN SUBTREE IS REFUSED. It detaches the
//      subtree from the tree and is the classic tree-reorder corruption bug.
//      `isValidDrop` rejects it, and the controller reports the rejection so
//      the renderer can show a no-drop cursor rather than silently doing
//      nothing.
//
//   4. MULTI-ROW DRAG MOVES A SET, PRESERVING RELATIVE ORDER, AND DROPS
//      ANCESTORS ONLY. If both a parent and its child are selected, moving
//      both would move the child twice — once on its own and once inside its
//      parent's subtree. `normalizeDragSet` reduces the selection to its
//      topmost members first.
// =============================================================================

/** A node in the flattened, currently-visible row list. @public */
export interface FlatNode {
  readonly id: string;
  readonly parentId: string | null;
  readonly depth: number;
  /** True when the node can accept children (a folder, an expandable group). */
  readonly canAcceptChild: boolean;
}

/** @public */
export type DropPosition = 'before' | 'after' | 'inside';

/** @public */
export interface DropTarget {
  readonly position: DropPosition;
  /** Parent the dragged node(s) end up under. Null means the tree root. */
  readonly parentId: string | null;
  /** Sibling to insert before; null means append as the last child. */
  readonly beforeId: string | null;
  /** Flat row index of the hovered row, for drawing the indicator. */
  readonly overIndex: number;
  /** Indicator depth, so the drop line indents to the level being dropped into. */
  readonly indicatorDepth: number;
}

/** @public */
export interface DropRejection {
  readonly reason: 'into-own-subtree' | 'unchanged' | 'not-droppable' | 'no-target';
}

/** @public */
export type DropResolution =
  | { readonly ok: true; readonly target: DropTarget }
  | { readonly ok: false; readonly rejection: DropRejection };

/**
 * Reduce a multi-row selection to the nodes that should actually move.
 *
 * A node whose ancestor is also selected is removed — it will travel inside
 * its ancestor's subtree. Relative order is preserved. See design note 4.
 * @public
 */
export function normalizeDragSet(
  selectedId: ReadonlyArray<string>,
  node: ReadonlyArray<FlatNode>,
): string[] {
  const byId = new Map(node.map((n) => [n.id, n] as const));
  const selected = new Set(selectedId);

  const hasSelectedAncestor = (id: string): boolean => {
    let current = byId.get(id)?.parentId ?? null;
    // Bounded by tree depth; a malformed cyclic parent chain is guarded by the
    // visited set so this can never spin.
    const seen = new Set<string>();
    while (current !== null && !seen.has(current)) {
      if (selected.has(current)) return true;
      seen.add(current);
      current = byId.get(current)?.parentId ?? null;
    }
    return false;
  };

  return selectedId.filter((id) => byId.has(id) && !hasSelectedAncestor(id));
}

/** Every descendant of `id`, plus `id` itself. @public */
export function subtreeOf(id: string, node: ReadonlyArray<FlatNode>): Set<string> {
  const childOf = new Map<string | null, string[]>();
  for (const n of node) {
    const bucket = childOf.get(n.parentId) ?? [];
    bucket.push(n.id);
    childOf.set(n.parentId, bucket);
  }

  const out = new Set<string>([id]);
  const queue = [id];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const child of childOf.get(current) ?? []) {
      if (out.has(child)) continue;
      out.add(child);
      queue.push(child);
    }
  }
  return out;
}

/**
 * Which third of the hovered row the pointer is in.
 *
 * `canAcceptChild === false` collapses the middle band into before/after, so a
 * leaf never advertises a drop it cannot honour.
 * @public
 */
export function dropPositionFor(
  offsetY: number,
  rowHeight: number,
  canAcceptChild: boolean,
): DropPosition {
  if (rowHeight <= 0) return 'before';
  const ratio = Math.min(1, Math.max(0, offsetY / rowHeight));

  if (!canAcceptChild) return ratio < 0.5 ? 'before' : 'after';
  if (ratio < 1 / 3) return 'before';
  if (ratio > 2 / 3) return 'after';
  return 'inside';
}

/**
 * Resolve a hover into a validated drop target.
 * @public
 */
export function resolveDrop(
  draggedId: ReadonlyArray<string>,
  overIndex: number,
  offsetY: number,
  rowHeight: number,
  node: ReadonlyArray<FlatNode>,
): DropResolution {
  const over = node[overIndex];
  if (over === undefined) {
    return { ok: false, rejection: { reason: 'no-target' } };
  }

  const moving = normalizeDragSet(draggedId, node);
  if (moving.length === 0) {
    return { ok: false, rejection: { reason: 'not-droppable' } };
  }

  const position = dropPositionFor(offsetY, rowHeight, over.canAcceptChild);

  // Refuse a drop anywhere inside the moving nodes' own subtrees.
  for (const id of moving) {
    if (subtreeOf(id, node).has(over.id)) {
      return { ok: false, rejection: { reason: 'into-own-subtree' } };
    }
  }

  if (position === 'inside') {
    return {
      ok: true,
      target: {
        position,
        parentId: over.id,
        beforeId: null, // append as last child
        overIndex,
        indicatorDepth: over.depth + 1,
      },
    };
  }

  const parentId = over.parentId;

  if (position === 'before') {
    // Dropping immediately before a node it already precedes is a no-op.
    if (moving.length === 1 && node[overIndex - 1]?.id === moving[0]) {
      return { ok: false, rejection: { reason: 'unchanged' } };
    }
    return {
      ok: true,
      target: { position, parentId, beforeId: over.id, overIndex, indicatorDepth: over.depth },
    };
  }

  // 'after' — insert before the hovered node's next SIBLING, which is not
  // necessarily the next flat row: the rows between may be its descendants.
  const nextSibling = node.slice(overIndex + 1).find((n) => n.parentId === parentId);

  if (moving.length === 1 && nextSibling?.id === moving[0]) {
    return { ok: false, rejection: { reason: 'unchanged' } };
  }

  return {
    ok: true,
    target: {
      position,
      parentId,
      beforeId: nextSibling?.id ?? null,
      overIndex,
      indicatorDepth: over.depth,
    },
  };
}

/**
 * Apply a resolved drop to a flat node list, returning the new order.
 *
 * The grid does not own row data — this exists so an adopter has a correct
 * reference implementation to compare against, and so the behaviour is
 * testable end to end.
 * @public
 */
export function applyDrop(
  node: ReadonlyArray<FlatNode>,
  movingId: ReadonlyArray<string>,
  target: DropTarget,
): FlatNode[] {
  const moving = normalizeDragSet(movingId, node);
  const movingSet = new Set<string>();
  for (const id of moving) {
    for (const descendant of subtreeOf(id, node)) movingSet.add(descendant);
  }

  // Lift the moving subtrees out, preserving their relative order.
  const lifted = node.filter((n) => movingSet.has(n.id));
  const remaining = node.filter((n) => !movingSet.has(n.id));

  // Re-parent only the dragged roots; their descendants keep their parents.
  const movingRoot = new Set(moving);
  const reparented = lifted.map((n) =>
    movingRoot.has(n.id) ? { ...n, parentId: target.parentId } : n,
  );

  // Re-depth the whole moved block by the delta applied to its roots.
  const depthOf = new Map(node.map((n) => [n.id, n.depth] as const));
  const parentDepth =
    target.parentId === null ? -1 : (depthOf.get(target.parentId) ?? -1);
  const firstRoot = moving[0];
  const delta =
    firstRoot === undefined ? 0 : parentDepth + 1 - (depthOf.get(firstRoot) ?? 0);
  const shifted = reparented.map((n) => ({ ...n, depth: Math.max(0, n.depth + delta) }));

  const insertAt =
    target.beforeId === null
      ? remaining.length
      : Math.max(0, remaining.findIndex((n) => n.id === target.beforeId));

  return [...remaining.slice(0, insertAt), ...shifted, ...remaining.slice(insertAt)];
}
