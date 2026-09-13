// =============================================================================
// excludeColumnFilter
//
// A set-filter popover lists one column's values under every OTHER active
// filter. If the column's own set rule stayed in, unticking a value would make
// it vanish from the very list used to tick it back.
//
// Only that column's `in` / `notIn` leaves that are ANDed into the filter are
// dropped. Removing a leaf from inside an OR or a NOT would widen or invert
// the result, so those subtrees are kept whole.
// =============================================================================

import type { FilterModel, FilterNode } from '@onegrid/protocol';

/** @public */
export function excludeColumnFilter(filter: FilterModel, columnId: string): FilterModel {
  if (filter === null) return null;
  return strip(filter, columnId);
}

function strip(node: FilterNode, columnId: string): FilterNode | null {
  if (node.type === 'comparison') {
    const isSetRule = node.op === 'in' || node.op === 'notIn';
    return node.columnId === columnId && isSetRule ? null : node;
  }
  if (node.op !== 'and') return node;
  const kept: FilterNode[] = [];
  let changed = false;
  for (const child of node.filters) {
    const next = strip(child, columnId);
    if (next !== child) changed = true;
    if (next !== null) kept.push(next);
  }
  if (!changed) return node;
  // An AND with nothing left matches everything, which is "no filter".
  if (kept.length === 0) return null;
  if (kept.length === 1) return kept[0]!;
  return { type: 'logical', op: 'and', filters: kept };
}
