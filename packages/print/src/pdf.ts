// =============================================================================
// A minimal, dependency-free PDF writer.
//
// The repo rule is zero new runtime dependencies, and jsPDF (~350 KB) or
// pdf-lib (~1 MB) to draw text and straight lines is a bad trade. A PDF that
// contains nothing but base-14 text and vector rules is a genuinely small
// format, and writing it directly means the byte stream is ours to reason
// about — no surprise embedded fonts, no canvas rasterisation, no license
// question.
//
// What a valid PDF needs, and what this module emits:
//
//   %PDF-1.7 header, plus a binary comment line so transfer agents treat the
//   file as binary rather than mangling line endings.
//
//   A body of numbered indirect objects: the catalog, the page tree, two
//   base-14 fonts (Helvetica and Helvetica-Bold, which every conforming
//   reader has built in — no font file to embed), a document info dictionary,
//   then one page object plus one content stream per page.
//
//   A cross-reference table whose entries are EXACTLY 20 bytes each, listing
//   the byte offset of every object. Readers seek by these offsets, so they
//   are recorded as the body is written rather than computed afterwards.
//
//   A trailer naming the catalog and the object count, then `startxref` with
//   the byte offset of the xref table, then %%EOF.
//
// Coordinates: PDF's origin is the BOTTOM-left and y grows upward, while
// every table layout in this package measures downward from the top. Rather
// than flip every call site, each page emits one `cm` transform that scales
// by the paginator's factor and translates to the content box's bottom-left
// corner; drawing code then works in unscaled layout units with a single
// `availableHeight - yDown` flip. One conversion, one place.
//
// Text metrics come from the published Helvetica AFM advance widths, so
// right-alignment and truncation land where a reader will actually draw the
// glyphs instead of where a monospace guess says they will.
// =============================================================================

import { columnWidth } from './format';
import { pageCell } from './paginate';
import type { ExportRow, PrintCell, PrintPage } from './types';

// -----------------------------------------------------------------------------
// Text metrics and escaping
// -----------------------------------------------------------------------------

// Helvetica advance widths, 1/1000 em, for code points 32..126 (AFM order).
const HELVETICA_WIDTH: readonly number[] = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556,
  556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667,
  611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667,
  667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500,
  222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];

/** Bold advances run a little wider; one factor beats a second 95-entry table. */
const BOLD_WIDTH_FACTOR = 1.06;

/**
 * Width of `text` in points at `size`, using Helvetica advance widths.
 * Characters outside the ASCII printable range fall back to the average
 * advance, which is what the WinAnsi fallback glyph roughly costs.
 * @public
 */
export function measureText(text: string, size: number, bold = false): number {
  let mille = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    mille += code >= 32 && code <= 126 ? HELVETICA_WIDTH[code - 32]! : 556;
  }
  const width = (mille / 1000) * size;
  return bold ? width * BOLD_WIDTH_FACTOR : width;
}

/**
 * Escape a JavaScript string for PDF literal-string syntax `( ... )`.
 *
 * Backslash and both parentheses are the syntax characters and must be
 * backslash-escaped — an unescaped `)` in a cell value terminates the string
 * early and corrupts every object after it, which is the single most common
 * way a hand-rolled PDF writer produces a file that will not open.
 * Non-ASCII is emitted as three-digit octal, which is unambiguous in every
 * PDF version, and control characters are dropped.
 * @public
 */
export function escapePdfString(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    const code = text.charCodeAt(i);
    if (ch === '\\') out += '\\\\';
    else if (ch === '(') out += '\\(';
    else if (ch === ')') out += '\\)';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (code < 32) continue;
    else if (code < 127) out += ch;
    else if (code < 256) out += `\\${code.toString(8).padStart(3, '0')}`;
    // Beyond Latin-1 a base-14 font has no glyph at all; a question mark is
    // an honest placeholder and keeps column widths meaningful.
    else out += '?';
  }
  return out;
}

/**
 * Truncate `text` with an ellipsis so it fits `maxWidth` points. Returns the
 * text unchanged when it already fits.
 * @public
 */
export function truncateToWidth(text: string, maxWidth: number, size: number, bold = false): string {
  if (maxWidth <= 0) return '';
  if (measureText(text, size, bold) <= maxWidth) return text;
  const ellipsis = '…';
  const ellipsisWidth = measureText('...', size, bold) / 3;
  let out = '';
  let width = 0;
  for (const ch of text) {
    const w = measureText(ch, size, bold);
    if (width + w + ellipsisWidth > maxWidth) break;
    out += ch;
    width += w;
  }
  return out + ellipsis;
}

// -----------------------------------------------------------------------------
// Options
// -----------------------------------------------------------------------------

/** @public */
export interface PdfOption {
  /** Body font size in points. Default 9. */
  readonly fontSize?: number;
  /** Header font size in points. Defaults to `fontSize`. */
  readonly headerFontSize?: number;
  /** Horizontal padding inside every cell, in points. Default 4. */
  readonly cellPadding?: number;
  /** Grid rule width in points. 0 disables rules. Default 0.5. */
  readonly ruleWidth?: number;
  /** Grid rule colour as `#rrggbb`. Default `#c8c8c8`. */
  readonly ruleColor?: string;
  /** Header band background as `#rrggbb`. Default `#eeeeee`. */
  readonly headerBackground?: string;
  /** Draw `Page X of Y` in the bottom margin. Default true. */
  readonly pageNumber?: boolean;
  /** Document title, written to the info dictionary and the footer. */
  readonly title?: string;
  /** Producer string for the info dictionary. */
  readonly producer?: string;
}

/** @public */
export interface PdfDocument {
  readonly bytes: Uint8Array;
  readonly mime: 'application/pdf';
  readonly extension: '.pdf';
  readonly pageCount: number;
}

// -----------------------------------------------------------------------------
// Colour
// -----------------------------------------------------------------------------

/** Parse `#rgb` / `#rrggbb` into PDF device-RGB components in 0..1. */
function parseColor(hex: string | undefined): [number, number, number] | null {
  if (!hex) return null;
  const h = hex.trim().replace(/^#/, '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return null;
  return [
    parseInt(full.slice(0, 2), 16) / 255,
    parseInt(full.slice(2, 4), 16) / 255,
    parseInt(full.slice(4, 6), 16) / 255,
  ];
}

function fmt(n: number): string {
  // Three decimals is below the resolution of any printer and keeps streams
  // short; `-0` is normalised because some readers dislike it.
  const v = Math.round(n * 1000) / 1000;
  return Object.is(v, -0) ? '0' : String(v);
}

// -----------------------------------------------------------------------------
// Content stream construction
// -----------------------------------------------------------------------------

class ContentStream {
  private readonly op: string[] = [];

  push(line: string): void {
    this.op.push(line);
  }

  fillRect(x: number, y: number, w: number, h: number, color: [number, number, number]): void {
    this.op.push(
      `q ${fmt(color[0])} ${fmt(color[1])} ${fmt(color[2])} rg ${fmt(x)} ${fmt(y)} ${fmt(w)} ${fmt(h)} re f Q`,
    );
  }

  line(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    width: number,
    color: [number, number, number],
  ): void {
    this.op.push(
      `q ${fmt(width)} w ${fmt(color[0])} ${fmt(color[1])} ${fmt(color[2])} RG ${fmt(x1)} ${fmt(y1)} m ${fmt(x2)} ${fmt(y2)} l S Q`,
    );
  }

  text(
    x: number,
    y: number,
    value: string,
    size: number,
    bold: boolean,
    color: [number, number, number],
  ): void {
    this.op.push(
      `BT /${bold ? 'F2' : 'F1'} ${fmt(size)} Tf ${fmt(color[0])} ${fmt(color[1])} ${fmt(color[2])} rg ${fmt(x)} ${fmt(y)} Td (${escapePdfString(value)}) Tj ET`,
    );
  }

  toString(): string {
    return this.op.join('\n');
  }
}

const BLACK: [number, number, number] = [0, 0, 0];

function alignedX(
  cell: Pick<PrintCell, 'align'>,
  text: string,
  boxX: number,
  boxWidth: number,
  padding: number,
  size: number,
  bold: boolean,
): number {
  const w = measureText(text, size, bold);
  if (cell.align === 'right') return boxX + boxWidth - padding - w;
  if (cell.align === 'center') return boxX + (boxWidth - w) / 2;
  return boxX + padding;
}

// -----------------------------------------------------------------------------
// Page rendering
// -----------------------------------------------------------------------------

function renderPage<TRow extends ExportRow>(
  page: PrintPage,
  table: ReadonlyArray<TRow>,
  option: PdfOption,
): string {
  const fontSize = option.fontSize ?? 9;
  const headerFontSize = option.headerFontSize ?? fontSize;
  const padding = option.cellPadding ?? 4;
  const ruleWidth = option.ruleWidth ?? 0.5;
  const ruleColor = parseColor(option.ruleColor ?? '#c8c8c8') ?? [0.78, 0.78, 0.78];
  const headerBg = parseColor(option.headerBackground ?? '#eeeeee');
  const scale = page.scale;
  const box = page.box;
  const availableHeight = box.contentHeight / scale;

  const cs = new ContentStream();
  // One transform: scale the whole page, then move the origin to the bottom
  // left of the printable area. Everything below is in layout units.
  cs.push(
    `q ${fmt(scale)} 0 0 ${fmt(scale)} ${fmt(box.margin.left)} ${fmt(box.margin.bottom)} cm`,
  );

  const colX: number[] = [];
  let x = 0;
  for (const c of page.band.column) {
    colX.push(x);
    x += columnWidth(c);
  }
  const bandWidth = x;

  // yDown measures downward from the top of the content box; toY flips it.
  const toY = (yDown: number): number => availableHeight - yDown;
  let yDown = 0;

  if (page.header.length > 0) {
    const h = page.headerHeight > 0 ? page.headerHeight : 22;
    if (headerBg) cs.fillRect(0, toY(yDown + h), bandWidth, h, headerBg);
    for (let i = 0; i < page.header.length; i++) {
      const cell = page.header[i]!;
      const col = page.band.column[i]!;
      const cw = columnWidth(col);
      const text = truncateToWidth(cell.text, cw - padding * 2, headerFontSize, true);
      const tx = alignedX(cell, text, colX[i]!, cw, padding, headerFontSize, true);
      cs.text(tx, toY(yDown + h) + (h - headerFontSize) / 2 + 1, text, headerFontSize, true, BLACK);
    }
    if (ruleWidth > 0) {
      cs.line(0, toY(yDown + h), bandWidth, toY(yDown + h), ruleWidth, ruleColor);
    }
    yDown += h;
  }

  const cell = pageCell(page, table);
  const groupAt = new Map<number, string>();
  for (const g of page.groupHeader) {
    groupAt.set(g.rowIndex, g.continued ? `${g.label} (continued)` : g.label);
  }

  for (let r = page.rowStart; r < page.rowEnd; r++) {
    const label = groupAt.get(r);
    if (label !== undefined) {
      const gh = page.groupHeaderHeight;
      cs.fillRect(0, toY(yDown + gh), bandWidth, gh, [0.93, 0.93, 0.93]);
      cs.text(padding, toY(yDown + gh) + (gh - fontSize) / 2 + 1, label, fontSize, true, BLACK);
      yDown += gh;
    }
    const h = page.rowHeight[r - page.rowStart] ?? 18;
    const rowCell = cell[r - page.rowStart];
    if (rowCell) {
      for (let i = 0; i < rowCell.length; i++) {
        const c = rowCell[i]!;
        const col = page.band.column[i]!;
        const cw = columnWidth(col);
        const bg = parseColor(c.style.background);
        if (bg) cs.fillRect(colX[i]!, toY(yDown + h), cw, h, bg);
        const bold = c.style.bold === true;
        const text = truncateToWidth(c.text, cw - padding * 2, fontSize, bold);
        if (text !== '') {
          const tx = alignedX(c, text, colX[i]!, cw, padding, fontSize, bold);
          const fg = parseColor(c.style.color) ?? BLACK;
          cs.text(tx, toY(yDown + h) + (h - fontSize) / 2 + 1, text, fontSize, bold, fg);
        }
      }
    }
    yDown += h;
    if (ruleWidth > 0) cs.line(0, toY(yDown), bandWidth, toY(yDown), ruleWidth, ruleColor);
  }

  // Vertical rules span header + body so the grid reads as a table.
  if (ruleWidth > 0 && page.band.column.length > 0) {
    for (let i = 0; i <= page.band.column.length; i++) {
      const vx = i === page.band.column.length ? bandWidth : colX[i]!;
      cs.line(vx, toY(0), vx, toY(yDown), ruleWidth, ruleColor);
    }
  }

  cs.push('Q');

  if (option.pageNumber !== false) {
    const label = `Page ${page.pageNumber} of ${page.totalPage}`;
    const size = 8;
    const y = Math.max(6, box.margin.bottom / 2 - size / 2);
    cs.text(box.margin.left, y, label, size, false, [0.4, 0.4, 0.4]);
    if (option.title !== undefined) {
      const w = measureText(option.title, size);
      cs.text(box.width - box.margin.right - w, y, option.title, size, false, [0.4, 0.4, 0.4]);
    }
  }

  return cs.toString();
}

// -----------------------------------------------------------------------------
// Document assembly
// -----------------------------------------------------------------------------

/** Latin-1 string → bytes. Every byte we emit is < 256 by construction. */
function toBytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

function pdfDate(now: Date): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  return `D:${p(now.getUTCFullYear(), 4)}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}Z`;
}

/**
 * Render paginated pages to a real PDF byte stream.
 *
 * The output opens in any conforming reader: `%PDF-1.7` header, indirect
 * objects, a 20-byte-per-entry xref table, and a trailer whose `startxref`
 * points at that table.
 * @public
 */
export function renderPdf<TRow extends ExportRow>(
  page: ReadonlyArray<PrintPage>,
  table: ReadonlyArray<TRow>,
  option: PdfOption = {},
): PdfDocument {
  const objectBody: string[] = [];
  const push = (body: string): number => {
    objectBody.push(body);
    return objectBody.length; // 1-based object number
  };

  // Fixed objects. The page tree's /Kids list is patched once page objects
  // exist, which is why object 2 is reserved here with a placeholder.
  push('<< /Type /Catalog /Pages 2 0 R >>'); // 1
  push('PAGES_PLACEHOLDER'); // 2
  push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'); // 3
  push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>'); // 4
  const infoTitle = option.title === undefined ? '' : ` /Title (${escapePdfString(option.title)})`;
  push(
    `<< /Producer (${escapePdfString(option.producer ?? '@onegrid/print')})${infoTitle} /CreationDate (${pdfDate(new Date())}) >>`,
  ); // 5
  const infoObj = 5;

  const pageObj: number[] = [];
  for (const p of page) {
    const content = renderPage(p, table, option);
    const streamObj = push(
      `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    );
    const box = p.box;
    const num = push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${fmt(box.width)} ${fmt(box.height)}] ` +
        `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${streamObj} 0 R >>`,
    );
    pageObj.push(num);
  }

  objectBody[1] = `<< /Type /Pages /Count ${pageObj.length} /Kids [${pageObj
    .map((n) => `${n} 0 R`)
    .join(' ')}] >>`;

  // Serialise, recording each object's byte offset for the xref table.
  let out = '%PDF-1.7\n%\xE2\xE3\xCF\xD3\n';
  const offset: number[] = [];
  for (let i = 0; i < objectBody.length; i++) {
    offset.push(out.length);
    out += `${i + 1} 0 obj\n${objectBody[i]!}\nendobj\n`;
  }

  const xrefOffset = out.length;
  out += `xref\n0 ${objectBody.length + 1}\n`;
  out += '0000000000 65535 f \n';
  for (const off of offset) {
    out += `${String(off).padStart(10, '0')} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${objectBody.length + 1} /Root 1 0 R /Info ${infoObj} 0 R >>\n`;
  out += `startxref\n${xrefOffset}\n%%EOF\n`;

  return {
    bytes: toBytes(out),
    mime: 'application/pdf',
    extension: '.pdf',
    pageCount: pageObj.length,
  };
}

/**
 * Paginate-and-render convenience: the one call an adopter usually wants.
 * @public
 */
export function printToPdf<TRow extends ExportRow>(
  page: ReadonlyArray<PrintPage>,
  table: ReadonlyArray<TRow>,
  option?: PdfOption,
): PdfDocument {
  return renderPdf(page, table, option);
}

/**
 * Browser convenience: render and trigger a download. Returns the object URL
 * so a caller can revoke it early; it is auto-revoked after 60 s, matching
 * @onegrid/export's download helpers.
 * @public
 */
export function downloadPdf<TRow extends ExportRow>(
  page: ReadonlyArray<PrintPage>,
  table: ReadonlyArray<TRow>,
  filename: string,
  option?: PdfOption,
): string {
  if (typeof document === 'undefined') {
    throw new Error('@onegrid/print downloadPdf: requires a browser document.');
  }
  const doc = renderPdf(page, table, option);
  // `.slice()` re-buffers into a plain ArrayBuffer, which is what BlobPart
  // accepts; a bare Uint8Array may be backed by a SharedArrayBuffer.
  const blob = new Blob([doc.bytes.slice().buffer], { type: doc.mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 60_000);
  return url;
}
