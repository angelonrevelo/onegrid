// =============================================================================
// The pagination engine — the core of @onegrid/print.
//
// Laying a grid onto paper is a two-dimensional bin-packing problem with hard
// constraints that browsers get wrong and most grid libraries do not attempt:
//
//  1. A ROW IS ATOMIC. It never straddles a page break. A row that will not
//     fit in the remaining space moves whole to the next page; a row taller
//     than the entire printable area gets a page to itself rather than being
//     silently clipped in half.
//
//  2. A TABLE WIDER THAN THE SHEET SPLITS INTO BANDS, and every band repeats
//     the key columns. Band 3 of an anonymous numeric table is unreadable
//     paper; band 3 with the id and name columns at its left edge is a usable
//     report. This is why `key` exists on PrintColumn.
//
//  3. HEADERS REPEAT. The column header on every page, and a group header
//     re-emitted with `continued: true` when its group crosses a break.
//
//  4. SCALE IS APPLIED BEFORE PACKING, NOT AFTER. The trick that keeps the
//     arithmetic honest is to divide the printable box by the scale factor
//     once, then pack in unscaled layout units: at scale 0.5 an A4 page
//     accepts twice the content, and every downstream number (row heights,
//     band widths, used height) stays in the same coordinate system as the
//     column definitions. Renderers multiply by `page.scale` exactly once.
//
//  5. TOTAL PAGE COUNT NEEDS A SECOND PASS. `pageNumber` is knowable while
//     packing; `totalPage` is not, because it is the product of the row-slice
//     count and the band count and neither is known until packing finishes.
//     We pack into a provisional list and then walk it again to stamp both
//     numbers. Anything else prints "Page 3 of 3" on page 3 of 7.
//
// Ordering is rows-major: every band of a row slice is emitted consecutively,
// so a reader gets all the columns of rows 1-40 before moving to rows 41-80.
// That is the order a stapled report has to be in to be readable.
// =============================================================================

import { columnWidth, DEFAULT_COLUMN_WIDTH, formatCell, headerCell } from './format';
import { resolvePageBox } from './page';
import type {
  ColumnBand,
  ExportRow,
  PaginateInput,
  PaginateOption,
  PageBox,
  PageScaling,
  PrintCell,
  PrintColumn,
  PrintPage,
  RenderedGroupHeader,
  RowGroup,
} from './types';

const DEFAULT_ROW_HEIGHT = 18;
const DEFAULT_HEADER_HEIGHT = 22;
const DEFAULT_GROUP_HEADER_HEIGHT = 20;

interface ResolvedOption {
  readonly headerHeight: number;
  readonly groupHeaderHeight: number;
  readonly footerHeight: number;
  readonly repeatHeader: boolean;
  readonly repeatGroupHeader: boolean;
  readonly group: ReadonlyArray<RowGroup>;
  readonly defaultColumnWidth: number;
}

function resolveOption(option: PaginateOption = {}): ResolvedOption {
  return {
    headerHeight: option.headerHeight ?? DEFAULT_HEADER_HEIGHT,
    groupHeaderHeight: option.groupHeaderHeight ?? DEFAULT_GROUP_HEADER_HEIGHT,
    footerHeight: option.footerHeight ?? 0,
    repeatHeader: option.repeatHeader ?? true,
    repeatGroupHeader: option.repeatGroupHeader ?? true,
    group: option.group ?? [],
    defaultColumnWidth: option.defaultColumnWidth ?? DEFAULT_COLUMN_WIDTH,
  };
}

function measureRowHeight(
  table: ReadonlyArray<ExportRow>,
  option: PaginateOption | undefined,
): number[] {
  const spec = option?.rowHeight ?? DEFAULT_ROW_HEIGHT;
  if (typeof spec === 'number') {
    const h = spec > 0 ? spec : DEFAULT_ROW_HEIGHT;
    return table.map(() => h);
  }
  return table.map((row, i) => {
    const h = spec(row, i);
    // A non-positive measured height would let a page absorb unbounded rows.
    return Number.isFinite(h) && h > 0 ? h : DEFAULT_ROW_HEIGHT;
  });
}

/**
 * Total unscaled width of a column set, in points.
 * @public
 */
export function totalColumnWidth(
  column: ReadonlyArray<PrintColumn>,
  defaultWidth = DEFAULT_COLUMN_WIDTH,
): number {
  let sum = 0;
  for (const c of column) sum += columnWidth(c, defaultWidth);
  return sum;
}

/**
 * Resolve a scaling mode into a concrete factor. Exposed because a print
 * dialog wants to show "Fit width — 68%" before anything is rendered.
 *
 * `fitWidth` and `fitPage` only ever shrink: enlarging a table to fill the
 * sheet changes the design the user configured, and nobody asks for it.
 * @public
 */
export function resolveScale(
  scaling: PageScaling | undefined,
  box: PageBox,
  contentWidth: number,
  contentHeight: number,
): number {
  const mode = scaling?.mode ?? 'none';
  if (mode === 'none') return 1;
  if (scaling?.mode === 'scale') {
    const f = scaling.factor;
    return Number.isFinite(f) && f > 0 ? f : 1;
  }
  const widthScale =
    contentWidth > 0 && box.contentWidth > 0 ? Math.min(1, box.contentWidth / contentWidth) : 1;
  if (mode === 'fitWidth') return widthScale;
  const heightScale =
    contentHeight > 0 && box.contentHeight > 0
      ? Math.min(1, box.contentHeight / contentHeight)
      : 1;
  return Math.min(widthScale, heightScale);
}

/**
 * Split a column set into horizontal bands that each fit `availableWidth`,
 * repeating the key columns at the head of every band.
 *
 * Key columns are those flagged `key` on the definition plus any listed in
 * `keyColumnId`; they keep their original relative order. When the key
 * columns alone already exceed the page, each band still carries them and is
 * marked `overflow` — truncating the very columns that identify the row is
 * strictly worse than an overfull band the renderer can clip.
 * @public
 */
export function splitColumnBand(
  column: ReadonlyArray<PrintColumn>,
  availableWidth: number,
  option: PaginateOption = {},
): ColumnBand[] {
  const defaultWidth = option.defaultColumnWidth ?? DEFAULT_COLUMN_WIDTH;
  const keyId = new Set(option.keyColumnId ?? []);
  const keyColumn = column.filter((c) => c.key === true || keyId.has(c.id));
  const restColumn = column.filter((c) => !(c.key === true || keyId.has(c.id)));
  const keyWidth = totalColumnWidth(keyColumn, defaultWidth);

  const make = (member: PrintColumn[], index: number): ColumnBand => {
    const width = totalColumnWidth(member, defaultWidth);
    return {
      index,
      total: 0, // stamped below, once the band count is known.
      column: member,
      keyColumnCount: keyColumn.length,
      width,
      overflow: width > availableWidth,
    };
  };

  if (restColumn.length === 0) {
    const band = [make([...keyColumn], 0)];
    return band.map((b) => ({ ...b, total: 1 }));
  }

  const band: ColumnBand[] = [];
  let member: PrintColumn[] = [...keyColumn];
  let used = keyWidth;
  for (const c of restColumn) {
    const w = columnWidth(c, defaultWidth);
    const memberCount = member.length - keyColumn.length;
    // Close the band when this column would overflow — unless the band holds
    // no non-key column yet, in which case it must take this one or we loop
    // forever on a column wider than the sheet.
    if (memberCount > 0 && used + w > availableWidth) {
      band.push(make(member, band.length));
      member = [...keyColumn];
      used = keyWidth;
    }
    member.push(c);
    used += w;
  }
  if (member.length > keyColumn.length || band.length === 0) {
    band.push(make(member, band.length));
  }
  return band.map((b) => ({ ...b, total: band.length }));
}

interface RowSlice {
  readonly rowStart: number;
  readonly rowEnd: number;
  readonly groupHeader: RenderedGroupHeader[];
  readonly usedHeight: number;
  readonly showHeader: boolean;
}

/** Index of the group containing `rowIndex`, or -1. Groups are disjoint. */
function groupOf(group: ReadonlyArray<RowGroup>, rowIndex: number): number {
  for (let g = 0; g < group.length; g++) {
    const item = group[g]!;
    if (rowIndex >= item.startRow && rowIndex < item.endRow) return g;
  }
  return -1;
}

/**
 * Pack rows into vertical slices. Never splits a row; reserves the repeated
 * column header and any group header the slice needs before deciding what
 * fits.
 */
function sliceRow(
  rowHeight: ReadonlyArray<number>,
  availableHeight: number,
  opt: ResolvedOption,
): RowSlice[] {
  const slice: RowSlice[] = [];
  const total = rowHeight.length;
  let cursor = 0;
  let sliceIndex = 0;

  // An empty table still deserves one page so the header prints.
  if (total === 0) {
    return [
      {
        rowStart: 0,
        rowEnd: 0,
        groupHeader: [],
        usedHeight: opt.headerHeight,
        showHeader: true,
      },
    ];
  }

  while (cursor < total) {
    const showHeader = sliceIndex === 0 || opt.repeatHeader;
    const reserved = (showHeader ? opt.headerHeight : 0) + opt.footerHeight;
    const budget = availableHeight - reserved;
    const groupHeader: RenderedGroupHeader[] = [];
    let used = 0;
    let i = cursor;
    let lastGroup = -2; // -2 = "nothing placed yet on this slice"

    while (i < total) {
      const g = groupOf(opt.group, i);
      let groupCost = 0;
      let pendingHeader: RenderedGroupHeader | null = null;
      if (g !== -1 && g !== lastGroup) {
        const item = opt.group[g]!;
        const continued = i > item.startRow;
        // A continuation header only costs height when we choose to repeat it.
        if (!continued || opt.repeatGroupHeader) {
          groupCost = opt.groupHeaderHeight;
          pendingHeader = { label: item.label, rowIndex: i, continued };
        }
      }
      const need = groupCost + rowHeight[i]!;
      // `i > cursor` guarantees forward progress: the first row of a slice is
      // always accepted, even if it is taller than the page on its own.
      if (i > cursor && used + need > budget) break;
      if (pendingHeader) groupHeader.push(pendingHeader);
      used += need;
      if (g !== -1) lastGroup = g;
      i++;
    }

    slice.push({
      rowStart: cursor,
      rowEnd: i,
      groupHeader,
      usedHeight: used + reserved,
      showHeader,
    });
    cursor = i;
    sliceIndex++;
  }
  return slice;
}

/**
 * Lay a table out onto pages.
 *
 * Returns the pages in reading order: all bands of the first row slice, then
 * all bands of the second, and so on. Every page carries its own row range,
 * its column band, its repeated header, its group headers, the resolved
 * scale, the paper box, and a `totalPage` that is correct because it is
 * stamped on a second pass after packing.
 * @public
 */
export function paginate<TRow extends ExportRow>(input: PaginateInput<TRow>): PrintPage[] {
  const opt = resolveOption(input.option);
  const box = resolvePageBox(input.page);
  const rowHeight = measureRowHeight(input.table, input.option);

  const fullWidth = totalColumnWidth(input.column, opt.defaultColumnWidth);
  const fullHeight =
    opt.headerHeight +
    opt.footerHeight +
    opt.group.length * opt.groupHeaderHeight +
    rowHeight.reduce((a, b) => a + b, 0);
  const scale = resolveScale(input.page?.scaling, box, fullWidth, fullHeight);

  // Pack in unscaled layout units — see the header comment, point 4.
  const availableWidth = box.contentWidth / scale;
  const availableHeight = box.contentHeight / scale;

  const band = splitColumnBand(input.column, availableWidth, {
    ...input.option,
    defaultColumnWidth: opt.defaultColumnWidth,
  });
  const slice = sliceRow(rowHeight, availableHeight, opt);

  // First pass: build every page without numbering.
  const draft: Omit<PrintPage, 'pageNumber' | 'totalPage' | 'index'>[] = [];
  for (let s = 0; s < slice.length; s++) {
    const item = slice[s]!;
    for (const b of band) {
      const header: PrintCell[] = item.showHeader ? b.column.map((c) => headerCell(c)) : [];
      draft.push({
        rowStart: item.rowStart,
        rowEnd: item.rowEnd,
        rowSliceIndex: s,
        band: b,
        header,
        groupHeader: item.groupHeader,
        rowHeight: rowHeight.slice(item.rowStart, item.rowEnd),
        usedHeight: item.usedHeight,
        headerHeight: item.showHeader ? opt.headerHeight : 0,
        groupHeaderHeight: opt.groupHeaderHeight,
        scale,
        box,
      });
    }
  }

  // Second pass: now — and only now — the total is known.
  const totalPage = draft.length;
  return draft.map((d, i) => ({ ...d, index: i, pageNumber: i + 1, totalPage }));
}

/**
 * The resolved cells for one page, in row-major order. Kept separate from
 * `paginate` so pagination stays cheap for a page-count preview: formatting
 * ten thousand cells to learn the document is seven pages long is waste.
 * @public
 */
export function pageCell<TRow extends ExportRow>(
  page: PrintPage,
  table: ReadonlyArray<TRow>,
): PrintCell[][] {
  const out: PrintCell[][] = [];
  for (let r = page.rowStart; r < page.rowEnd; r++) {
    const row = table[r];
    if (!row) continue;
    out.push(page.band.column.map((c) => formatCell(c, row[c.id], row, r)));
  }
  return out;
}
