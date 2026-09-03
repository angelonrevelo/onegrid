// =============================================================================
// Paginated HTML emitter — the bridge between the paginator and the browser's
// own print pipeline.
//
// Two shapes come out of here, and the difference matters:
//
//   printHtmlTable  — ONE <table> containing every row, with a real <thead>.
//                     Pagination is left to the browser, which repeats the
//                     thead via `table-header-group` and honours
//                     `break-inside: avoid` on each <tr>. Preferred when the
//                     user is printing interactively: the engine knows the
//                     real paper and font metrics better than we do.
//
//   printHtmlDocument — one <table> PER PrintPage, separated by explicit page
//                     breaks. Deterministic: what the paginator computed is
//                     exactly what prints, including column bands. Required
//                     for wide tables, because no browser splits a table
//                     horizontally.
//
// Both carry the resolved cell styles inline, so number formats, alignment
// and conditional colours reach the paper — the same `formatCell` projection
// the PDF writer uses, so the two outputs cannot disagree.
// =============================================================================

import { columnWidth, toStyledSheet } from './format';
import { printStylesheet, type PrintStylesheetOption } from './css';
import { pageCell } from './paginate';
import type { ExportRow, PrintCell, PrintColumn, PrintPage } from './types';

/** Escape text for HTML text nodes and double-quoted attributes. @public */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Inline `style` attribute value carrying a cell's preserved formatting.
 * @public
 */
export function cellStyleAttribute(cell: PrintCell): string {
  const part: string[] = [`text-align:${cell.align}`];
  if (cell.style.color !== undefined) part.push(`color:${cell.style.color}`);
  if (cell.style.background !== undefined) part.push(`background-color:${cell.style.background}`);
  if (cell.style.bold === true) part.push('font-weight:700');
  if (cell.style.italic === true) part.push('font-style:italic');
  return part.join(';');
}

function td(cell: PrintCell, tag: 'td' | 'th'): string {
  const cls = cell.numeric ? ' class="onegrid-cell-numeric"' : '';
  return `<${tag}${cls} style="${cellStyleAttribute(cell)}">${escapeHtml(cell.text)}</${tag}>`;
}

function colgroup(column: ReadonlyArray<PrintColumn>): string {
  return `<colgroup>${column.map((c) => `<col style="width:${columnWidth(c)}pt">`).join('')}</colgroup>`;
}

/**
 * Render the whole table as one HTML table with a repeating `<thead>`,
 * letting the browser paginate.
 * @public
 */
export function printHtmlTable<TRow extends ExportRow>(
  table: ReadonlyArray<TRow>,
  column: ReadonlyArray<PrintColumn>,
): string {
  const sheet = toStyledSheet(table, column);
  const head = `<thead><tr>${sheet.header.map((c) => td(c, 'th')).join('')}</tr></thead>`;
  const body = sheet.row
    .map((r) => `<tr>${r.map((c) => td(c, 'td')).join('')}</tr>`)
    .join('');
  return `<table class="onegrid-print-table">${colgroup(column)}${head}<tbody>${body}</tbody></table>`;
}

/**
 * Render one HTML table per paginated page, with explicit page breaks. Use
 * this when column banding matters — the paginator's layout is authoritative.
 * @public
 */
export function printHtmlPage<TRow extends ExportRow>(
  page: PrintPage,
  table: ReadonlyArray<TRow>,
): string {
  const head =
    page.header.length > 0
      ? `<thead><tr>${page.header.map((c) => td(c, 'th')).join('')}</tr></thead>`
      : '';
  const groupAt = new Map<number, string>();
  for (const g of page.groupHeader) {
    groupAt.set(g.rowIndex, g.continued ? `${g.label} (continued)` : g.label);
  }
  const cell = pageCell(page, table);
  const body: string[] = [];
  for (let r = page.rowStart; r < page.rowEnd; r++) {
    const label = groupAt.get(r);
    if (label !== undefined) {
      body.push(
        `<tr class="onegrid-group-header"><th colspan="${page.band.column.length}" style="text-align:left">${escapeHtml(label)}</th></tr>`,
      );
    }
    const rowCell = cell[r - page.rowStart];
    if (rowCell) body.push(`<tr>${rowCell.map((c) => td(c, 'td')).join('')}</tr>`);
  }
  const footer = `<div class="onegrid-print-footer">Page ${page.pageNumber} of ${page.totalPage}</div>`;
  return (
    `<section class="onegrid-print-page"${page.index > 0 ? ' style="break-before:page"' : ''}>` +
    `<table class="onegrid-print-table">${colgroup(page.band.column)}${head}<tbody>${body.join('')}</tbody></table>` +
    `${footer}</section>`
  );
}

/**
 * A complete, standalone printable HTML document: the emitted print
 * stylesheet plus every paginated page. Open it in a hidden iframe and call
 * `print()`, or write it to disk.
 * @public
 */
export function printHtmlDocument<TRow extends ExportRow>(
  page: ReadonlyArray<PrintPage>,
  table: ReadonlyArray<TRow>,
  option: PrintStylesheetOption & { readonly title?: string } = {},
): string {
  const css = printStylesheet(option);
  const title = option.title ?? 'oneGrid print';
  const body = page.map((p) => printHtmlPage(p, table)).join('\n');
  return (
    '<!doctype html>\n<html><head><meta charset="utf-8">\n' +
    `<title>${escapeHtml(title)}</title>\n<style>\n${css}\n</style>\n</head>\n` +
    `<body class="onegrid">\n${body}\n</body></html>\n`
  );
}
