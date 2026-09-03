// =============================================================================
// Row + column span (merged cells)
//
// A spanned cell covers a rectangle of the grid instead of a single (row,
// column) slot. The adopter declares spans through `GridOptions.getCellSpan`,
// which the renderer consults per visible cell.
//
// Design decisions, and why:
//
//   1. The SPAN MODEL IS RESOLVED, NOT TRUSTED. An adopter's `getCellSpan`
//      can easily declare overlapping rectangles — two spans claiming the same
//      cell — and a renderer that trusts it paints garbage that is very hard to
//      debug. `resolveSpan` therefore builds an authoritative map in which
//      every covered cell points at exactly one anchor, resolving conflicts by
//      a documented rule (first anchor in row-major order wins; later
//      overlapping spans are truncated or dropped). The renderer then asks the
//      resolved map, never the callback.
//
//   2. RESOLUTION IS WINDOWED. Resolving every span in a 10M-row grid would
//      defeat the point of virtualization, so resolution runs over the visible
//      row window plus a margin. A span may legitimately START above the
//      window and extend into it, so the window is expanded upward by
//      `maxSpanHeight` — an adopter-declared bound. Without that bound we would
//      have to scan to row 0 to know whether row 500,000 is covered, which is
//      exactly the O(n) behaviour this grid exists to avoid.
//
//   3. HIT-TESTING FOLLOWS PAINTING. Clicking anywhere inside a merged region
//      must select the anchor, and keyboard navigation must skip over covered
//      cells rather than landing on a slot that is not painted. Both read the
//      same resolved map, so the two can never disagree.
// =============================================================================

/**
 * A span declared by the adopter for the cell at its top-left corner.
 * `rowSpan`/`colSpan` of 1 means "no span" and is the same as returning null.
 * @public
 */
export interface CellSpan {
  /** Rows covered, including the anchor row. Must be >= 1. */
  readonly rowSpan: number;
  /** Columns covered, including the anchor column. Must be >= 1. */
  readonly colSpan: number;
}

/**
 * Where a given cell sits relative to the span model.
 *
 * - `anchor`  — the top-left cell; this is the one that gets painted, and it
 *               paints across the whole rectangle.
 * - `covered` — inside a span but not its anchor; painted by the anchor, and
 *               skipped by hit-testing and keyboard navigation.
 * - `none`    — an ordinary unspanned cell.
 * @public
 */
export type SpanRole = 'anchor' | 'covered' | 'none';

/** A resolved span rectangle in grid coordinates. @public */
export interface SpanRect {
  readonly rowStart: number;
  readonly rowEnd: number;
  readonly colStart: number;
  readonly colEnd: number;
}

/** @public */
export interface ResolvedSpan {
  /** The rectangle covered, in grid coordinates (inclusive bounds). */
  readonly rect: SpanRect;
  /** The anchor cell that paints this rectangle. */
  readonly anchorRow: number;
  readonly anchorCol: number;
}

/**
 * The authoritative, conflict-free span map for a window of rows.
 * @public
 */
export interface SpanMap {
  /** Row range this map is valid for. Outside it, results are undefined. */
  readonly windowStart: number;
  readonly windowEnd: number;
  /** Role of a given cell. */
  readonly roleAt: (row: number, col: number) => SpanRole;
  /** The span covering a cell, or null when the cell is unspanned. Returns the
   *  same object for the anchor and for every covered cell in the rectangle. */
  readonly spanAt: (row: number, col: number) => ResolvedSpan | null;
  /** Every anchor in the window, in row-major order. The renderer iterates
   *  this to paint merged regions. */
  readonly anchor: ReadonlyArray<ResolvedSpan>;
  /** Spans that were dropped or truncated because they overlapped an earlier
   *  span. Surfaced rather than silently swallowed so an adopter can find the
   *  bug in their own span model. */
  readonly conflict: ReadonlyArray<SpanConflict>;
}

/** @public */
export interface SpanConflict {
  readonly row: number;
  readonly col: number;
  readonly requested: CellSpan;
  readonly reason: 'overlap' | 'out-of-bounds' | 'invalid';
}

/** @public */
export interface ResolveSpanOption {
  /** First row of the window to resolve, inclusive. */
  readonly windowStart: number;
  /** Last row of the window to resolve, inclusive. */
  readonly windowEnd: number;
  /** Total rows in the source; spans are clamped to it. */
  readonly rowCount: number;
  /** Total columns; spans are clamped to it. */
  readonly columnCount: number;
  /**
   * The tallest span the adopter will ever declare. Resolution starts this
   * many rows ABOVE `windowStart` so a span anchored off-screen above is still
   * discovered. Keep it as small as is truthful — it is a direct multiplier on
   * per-frame resolution cost. Default 1 (no span reaches into the window).
   */
  readonly maxSpanHeight?: number;
  /** The adopter's span declaration. */
  readonly getCellSpan: (row: number, col: number) => CellSpan | null | undefined;
}

const key = (row: number, col: number): string => `${row}:${col}`;

/**
 * Build the conflict-free span map for a row window.
 *
 * Conflict rule: cells are visited in row-major order and the FIRST span to
 * claim a cell keeps it. A later span that would overlap is dropped whole
 * rather than truncated — a half-painted merge is more confusing than an
 * unpainted one, and the conflict is reported so it can be fixed at source.
 * @public
 */
export function resolveSpan(option: ResolveSpanOption): SpanMap {
  const {
    windowStart,
    windowEnd,
    rowCount,
    columnCount,
    maxSpanHeight = 1,
    getCellSpan,
  } = option;

  const owner = new Map<string, ResolvedSpan>();
  const anchor: ResolvedSpan[] = [];
  const conflict: SpanConflict[] = [];

  // Start above the window so a span anchored off-screen is still found.
  const scanStart = Math.max(0, windowStart - Math.max(0, maxSpanHeight - 1));
  const scanEnd = Math.min(rowCount - 1, windowEnd);

  for (let row = scanStart; row <= scanEnd; row++) {
    for (let col = 0; col < columnCount; col++) {
      const declared = getCellSpan(row, col);
      if (!declared) continue;

      // A cell already covered by an earlier span cannot itself anchor one.
      // Report it rather than skipping silently: an adopter who declared a
      // span here needs to know it was swallowed, which is the whole reason
      // `conflict` exists.
      if (owner.has(key(row, col))) {
        if (declared.rowSpan !== 1 || declared.colSpan !== 1) {
          conflict.push({ row, col, requested: declared, reason: 'overlap' });
        }
        continue;
      }

      const { rowSpan, colSpan } = declared;
      if (rowSpan === 1 && colSpan === 1) continue;

      if (
        !Number.isInteger(rowSpan) ||
        !Number.isInteger(colSpan) ||
        rowSpan < 1 ||
        colSpan < 1
      ) {
        conflict.push({ row, col, requested: declared, reason: 'invalid' });
        continue;
      }

      const rowEnd = row + rowSpan - 1;
      const colEnd = col + colSpan - 1;

      if (rowEnd >= rowCount || colEnd >= columnCount) {
        conflict.push({ row, col, requested: declared, reason: 'out-of-bounds' });
        continue;
      }

      // Reject the whole rectangle if any part of it is already claimed.
      let overlaps = false;
      for (let r = row; r <= rowEnd && !overlaps; r++) {
        for (let c = col; c <= colEnd; c++) {
          if (owner.has(key(r, c))) {
            overlaps = true;
            break;
          }
        }
      }
      if (overlaps) {
        conflict.push({ row, col, requested: declared, reason: 'overlap' });
        continue;
      }

      const resolved: ResolvedSpan = {
        rect: { rowStart: row, rowEnd, colStart: col, colEnd },
        anchorRow: row,
        anchorCol: col,
      };
      for (let r = row; r <= rowEnd; r++) {
        for (let c = col; c <= colEnd; c++) {
          owner.set(key(r, c), resolved);
        }
      }
      anchor.push(resolved);
    }
  }

  const spanAt = (row: number, col: number): ResolvedSpan | null =>
    owner.get(key(row, col)) ?? null;

  const roleAt = (row: number, col: number): SpanRole => {
    const found = owner.get(key(row, col));
    if (!found) return 'none';
    return found.anchorRow === row && found.anchorCol === col ? 'anchor' : 'covered';
  };

  return { windowStart, windowEnd, roleAt, spanAt, anchor, conflict };
}

/**
 * Expand a selection rectangle so it never bisects a merged cell.
 *
 * Excel and Sheets both do this: select one cell of a merge and the whole
 * merge is selected; drag a range that clips a merge and the range grows to
 * contain it. Applied repeatedly until it reaches a fixed point, because
 * growing to contain one merge can bring a second merge into range.
 * @public
 */
export function expandRangeOverSpan(rect: SpanRect, map: SpanMap): SpanRect {
  let { rowStart, rowEnd, colStart, colEnd } = rect;

  for (let pass = 0; pass < 16; pass++) {
    let grew = false;

    for (let row = rowStart; row <= rowEnd; row++) {
      for (let col = colStart; col <= colEnd; col++) {
        const span = map.spanAt(row, col);
        if (!span) continue;
        const r = span.rect;
        if (r.rowStart < rowStart) { rowStart = r.rowStart; grew = true; }
        if (r.rowEnd > rowEnd) { rowEnd = r.rowEnd; grew = true; }
        if (r.colStart < colStart) { colStart = r.colStart; grew = true; }
        if (r.colEnd > colEnd) { colEnd = r.colEnd; grew = true; }
      }
    }

    if (!grew) break;
  }

  return { rowStart, rowEnd, colStart, colEnd };
}

/**
 * Resolve the cell keyboard navigation should actually land on.
 *
 * Moving into a covered cell must land on its anchor instead, otherwise the
 * focus ring sits on a slot that was never painted. Moving OUT of a merged
 * cell must clear the whole rectangle in one step rather than stepping through
 * the cells it covers, which is what makes arrow-key navigation feel right
 * across a merge.
 * @public
 */
export function navigateAcrossSpan(
  from: { row: number; col: number },
  direction: 'up' | 'down' | 'left' | 'right',
  map: SpanMap,
  bound: { rowCount: number; columnCount: number },
): { row: number; col: number } {
  const current = map.spanAt(from.row, from.col);
  const rect = current?.rect;

  let row = from.row;
  let col = from.col;

  // Step off the far edge of the current merge, not off the cell we entered at.
  switch (direction) {
    case 'up':
      row = (rect ? rect.rowStart : row) - 1;
      break;
    case 'down':
      row = (rect ? rect.rowEnd : row) + 1;
      break;
    case 'left':
      col = (rect ? rect.colStart : col) - 1;
      break;
    case 'right':
      col = (rect ? rect.colEnd : col) + 1;
      break;
  }

  if (row < 0 || col < 0 || row >= bound.rowCount || col >= bound.columnCount) {
    return from;
  }

  // Landing inside another merge snaps to that merge's anchor.
  const target = map.spanAt(row, col);
  if (target) return { row: target.anchorRow, col: target.anchorCol };

  return { row, col };
}
