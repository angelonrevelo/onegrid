// =============================================================================
// /distinct — set-filter value lists for the mock server.
//
// The TableIndex is built once per column and reused across requests, so a
// set-filter popover costs one pass over the column's dictionary (plus the
// filter, itself evaluated per distinct value) instead of a scan of every row
// on every open. Kept out of server.ts so it is testable without binding a
// port.
// =============================================================================

import { enumerateDistinctIndexed, filterIndexed, type TableIndex } from '@onegrid/data';
import type { DistinctRequest, DistinctResponse } from '@onegrid/protocol';

export function answerDistinct(tableIndex: TableIndex, req: DistinctRequest): DistinctResponse {
  const limit = Math.max(0, Math.floor(req.limit));
  const echo = req.requestId !== undefined ? { requestId: req.requestId } : {};
  if (!tableIndex.table.hasColumn(req.columnId)) {
    return { kind: 'distinct', entry: [], truncated: false, ...echo };
  }
  const selection = req.filter === null ? undefined : filterIndexed(tableIndex, req.filter);
  let all = enumerateDistinctIndexed(tableIndex, req.columnId, {
    ...(selection ? { selection } : {}),
    limit: null,
  });
  if (req.search) {
    const prefix = req.search.toLowerCase();
    all = all.filter((d) => String(d.value ?? '').toLowerCase().startsWith(prefix));
  }
  return {
    kind: 'distinct',
    entry: all.slice(0, limit).map((d) => ({ value: d.value, count: d.count })),
    truncated: all.length > limit,
    ...echo,
  };
}
