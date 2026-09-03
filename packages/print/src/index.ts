// =============================================================================
// @onegrid/print
//
// Print and advanced export. The sibling of @onegrid/export: that package
// answers "give me this data in another program", this one answers "give me
// this data on paper" — and paper has constraints a spreadsheet does not.
//
// Design decisions, and why:
//
//   THE PAGINATOR IS THE PRODUCT. PDF writing, CSS emission and screenshotting
//   are all thin layers over one engine that answers a single hard question:
//   which rows and which columns land on which sheet. It packs in points, it
//   never splits a row, it splits wide tables into column BANDS that each
//   repeat the key columns, it repeats column and group headers, and it
//   resolves `totalPage` on a second pass because the total is not knowable
//   while packing. Every renderer consumes `PrintPage[]` and adds nothing.
//
//   THE COLUMN CONTRACT IS @onegrid/export's. `PrintColumn` extends
//   `ExportColumn`, so `id`/`header`/`format` projection is literally the same
//   type. A column set written for CSV works here unchanged; print adds width,
//   alignment, number format, key-column flag and conditional style on top.
//
//   THE PDF WRITER IS OURS. jsPDF and pdf-lib are hundreds of kilobytes to
//   draw text and straight lines, and the repo takes no new runtime
//   dependencies. `renderPdf` emits the byte stream directly: header, indirect
//   objects, base-14 Helvetica, a 20-byte-per-entry xref table, trailer.
//
//   THE BROWSER PRINT PATH IS NOT A FALLBACK. `printStylesheet` emits real
//   `@page` geometry plus `thead { display: table-header-group }`, which is
//   NATIVE per-page header repetition — better output than any canvas
//   rasterisation for an interactive Ctrl+P, at the printer's own DPI.
//
//   SCREENSHOTS TILE BY DEFAULT. A virtualised grid's canvas holds one
//   viewport of rows; capturing it and calling that a screenshot of the grid
//   is a bug. `captureTallGrid` scrolls, captures and stitches, with the
//   clamped-final-tile arithmetic naive stitchers get wrong.
//
//   NOTHING IS FLATTENED TO TEXT. Number formats, alignment and conditional
//   colours resolve once in `formatCell` and travel to PDF, HTML and the
//   styled sheet identically.
// =============================================================================

// -- Paper geometry -----------------------------------------------------------

/** @public */
export { PAGE_SIZE_POINT, DEFAULT_MARGIN, resolvePageBox, mmToPoint, inchToPoint } from './page';

// -- Pagination engine --------------------------------------------------------

/** @public */
export { paginate, pageCell, splitColumnBand, resolveScale, totalColumnWidth } from './paginate';

// -- Format-preserving projection --------------------------------------------

/** @public */
export { formatCell, headerCell, toStyledSheet, columnWidth, DEFAULT_COLUMN_WIDTH } from './format';
/** @public */
export type { StyledSheet } from './format';

// -- PDF ----------------------------------------------------------------------

/** @public */
export {
  renderPdf,
  printToPdf,
  downloadPdf,
  escapePdfString,
  measureText,
  truncateToWidth,
} from './pdf';
/** @public */
export type { PdfOption, PdfDocument } from './pdf';

// -- @media print CSS ---------------------------------------------------------

/** @public */
export { printStylesheet } from './css';
/** @public */
export type { PrintStylesheetOption } from './css';

// -- Printable HTML -----------------------------------------------------------

/** @public */
export {
  printHtmlTable,
  printHtmlPage,
  printHtmlDocument,
  cellStyleAttribute,
  escapeHtml,
} from './html';

// -- Screenshot ---------------------------------------------------------------

/** @public */
export { captureGrid, captureTallGrid, planTile, domStitchCanvas } from './screenshot';
/** @public */
export type {
  CanvasSource,
  StitchCanvas,
  StitchCanvasFactory,
  ScrollableGridSource,
  CaptureTile,
  TilePlanOption,
  CaptureOption,
  GridCapture,
} from './screenshot';

// -- Types --------------------------------------------------------------------

/** @public */
export type {
  PageSizeName,
  PageOrientation,
  PageMargin,
  PageBox,
  PageScaling,
  PageOption,
  CellAlign,
  CellStyle,
  PrintColumn,
  PrintCell,
  RowGroup,
  RenderedGroupHeader,
  PaginateOption,
  PaginateInput,
  ColumnBand,
  PrintPage,
  ExportColumn,
  ExportRow,
} from './types';
