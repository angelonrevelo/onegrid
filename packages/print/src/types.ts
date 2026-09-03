// =============================================================================
// Shared types for @onegrid/print.
//
// A print column is an export column plus the two things paper needs and a
// spreadsheet does not: a physical WIDTH in points, and a visual style that
// must survive the trip to the page. `PrintColumn` therefore *extends*
// `@onegrid/export`'s `ExportColumn` rather than redeclaring it — the
// `id` / `header` / `format` projection contract is identical across the two
// packages by construction, so a column definition written for CSV or XLSX
// export drops into `paginate()` unchanged and only gains defaults.
//
// Everything physical is measured in PostScript points (1 pt = 1/72 in),
// because that is the unit PDF speaks natively and CSS's `pt` maps to
// exactly. Millimetres and inches are conversion helpers, never storage.
// =============================================================================

import type { ExportColumn, ExportRow } from '@onegrid/export';

// -----------------------------------------------------------------------------
// Geometry
// -----------------------------------------------------------------------------

/**
 * Named paper sizes, in points. `custom` is expressed as an explicit box.
 * @public
 */
export type PageSizeName = 'A4' | 'Letter' | 'Legal' | 'A3';

/** @public */
export type PageOrientation = 'portrait' | 'landscape';

/**
 * Margins in points. Every side is required once resolved; the caller-facing
 * option accepts a partial or a single number.
 * @public
 */
export interface PageMargin {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

/**
 * A fully resolved page box: the physical sheet plus the printable area left
 * after margins. `contentWidth`/`contentHeight` are what the paginator
 * actually fills.
 * @public
 */
export interface PageBox {
  readonly width: number;
  readonly height: number;
  readonly margin: PageMargin;
  readonly contentWidth: number;
  readonly contentHeight: number;
}

/**
 * Scaling strategy applied before pagination.
 *
 *   none      — 1:1. Wide tables spill into extra column bands.
 *   fitWidth  — shrink until the full column set fits one band. Never
 *               enlarges: growing a table to fill paper is a surprise, not a
 *               feature.
 *   fitPage   — fitWidth, further shrunk until every row also fits one page.
 *   scale     — an explicit factor, e.g. 0.75 for "75%" in a print dialog.
 * @public
 */
export type PageScaling =
  | { readonly mode: 'none' }
  | { readonly mode: 'fitWidth' }
  | { readonly mode: 'fitPage' }
  | { readonly mode: 'scale'; readonly factor: number };

/**
 * Physical page configuration. All fields optional — the defaults are A4
 * portrait with 36 pt (half-inch) margins and no scaling.
 * @public
 */
export interface PageOption {
  readonly size?: PageSizeName | { readonly width: number; readonly height: number };
  readonly orientation?: PageOrientation;
  /** A single number applies to all four sides. */
  readonly margin?: number | Partial<PageMargin>;
  readonly scaling?: PageScaling;
}

// -----------------------------------------------------------------------------
// Columns, cells and styling
// -----------------------------------------------------------------------------

/** @public */
export type CellAlign = 'left' | 'center' | 'right';

/**
 * The visual attributes carried from grid to page. Colours are `#rrggbb`
 * strings — the PDF writer converts to device RGB, the CSS and HTML emitters
 * pass them through untouched.
 * @public
 */
export interface CellStyle {
  readonly color?: string;
  readonly background?: string;
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly align?: CellAlign;
}

/**
 * A print column. Extends the export column so the same definition drives
 * CSV, XLSX and paper.
 * @public
 */
export interface PrintColumn<TValue = unknown> extends ExportColumn<TValue> {
  /** Layout width in points at scale 1. Default 72 (one inch). */
  readonly width?: number;
  /** Default horizontal alignment. Numbers fall back to `right`. */
  readonly align?: CellAlign;
  /**
   * Marks the column as a key/frozen column. Key columns are REPEATED at the
   * left edge of every horizontal band so a table too wide for one sheet
   * stays readable — a band of anonymous numeric columns is worthless.
   */
  readonly key?: boolean;
  /**
   * `Intl.NumberFormat` options used when the value is numeric and no
   * `format` callback is supplied. This is the format-preserving path:
   * currency, percent and fraction digits reach the page instead of being
   * flattened by `String(value)`.
   */
  readonly numberFormat?: Intl.NumberFormatOptions;
  /** BCP-47 locale for `numberFormat`. Default `'en-US'` for reproducibility. */
  readonly locale?: string;
  /** Static style for every cell in the column. */
  readonly style?: CellStyle;
  /**
   * Conditional style, merged over `style`. This is how a red-negative or
   * heat-mapped grid keeps its colours in the PDF.
   */
  readonly conditionalStyle?: (value: TValue, row: ExportRow, rowIndex: number) => CellStyle | undefined;
}

/**
 * A cell after formatting and style resolution — text plus everything a
 * renderer needs, with no further lookups required.
 * @public
 */
export interface PrintCell {
  readonly columnId: string;
  readonly text: string;
  readonly align: CellAlign;
  readonly style: CellStyle;
  /** True when the source value was numeric; renderers use it for alignment. */
  readonly numeric: boolean;
}

// -----------------------------------------------------------------------------
// Grouping
// -----------------------------------------------------------------------------

/**
 * A contiguous run of rows under one group header. `endRow` is exclusive.
 * When a group spans a page break its header is re-emitted at the top of the
 * continuation page with `continued: true`.
 * @public
 */
export interface RowGroup {
  readonly label: string;
  readonly startRow: number;
  readonly endRow: number;
}

/** @public */
export interface RenderedGroupHeader {
  readonly label: string;
  /** Row index the header sits above, on this page. */
  readonly rowIndex: number;
  /** True when the group started on an earlier page. */
  readonly continued: boolean;
}

// -----------------------------------------------------------------------------
// Pagination input / output
// -----------------------------------------------------------------------------

/**
 * Pagination knobs that are about content rather than paper.
 * @public
 */
export interface PaginateOption {
  /** Fixed row height in points, or a per-row measurement callback. Default 18. */
  readonly rowHeight?: number | ((row: ExportRow, rowIndex: number) => number);
  /** Header band height in points. Default 22. */
  readonly headerHeight?: number;
  /** Group header height in points. Default 20. */
  readonly groupHeaderHeight?: number;
  /** Reserved strip at the bottom of every page (page number, footnote). Default 0. */
  readonly footerHeight?: number;
  /** Repeat the column header on every page. Default true. */
  readonly repeatHeader?: boolean;
  /** Repeat a group's header when the group continues onto a new page. Default true. */
  readonly repeatGroupHeader?: boolean;
  /** Row groups, in ascending `startRow` order. */
  readonly group?: ReadonlyArray<RowGroup>;
  /**
   * Extra column ids to repeat on every band, beyond those marked `key`.
   * Useful when the key column is decided at print time.
   */
  readonly keyColumnId?: ReadonlyArray<string>;
  /** Default column width in points when a column omits one. Default 72. */
  readonly defaultColumnWidth?: number;
}

/** @public */
export interface PaginateInput<TRow extends ExportRow = ExportRow> {
  /** The row data, already sorted / filtered / projected by the caller. */
  readonly table: ReadonlyArray<TRow>;
  /** Column definitions, in display order. */
  readonly column: ReadonlyArray<PrintColumn>;
  /** Paper configuration. */
  readonly page?: PageOption;
  /** Content configuration. */
  readonly option?: PaginateOption;
}

/**
 * One horizontal slice of the column set. `column` always leads with the
 * repeated key columns; `keyColumnCount` says how many of them there are so a
 * renderer can rule them off visually.
 * @public
 */
export interface ColumnBand {
  readonly index: number;
  readonly total: number;
  readonly column: ReadonlyArray<PrintColumn>;
  readonly keyColumnCount: number;
  /** Sum of member widths at scale 1. */
  readonly width: number;
  /** True when a single column is wider than the printable area. */
  readonly overflow: boolean;
}

/**
 * A single sheet of output. Knows its rows, its columns, its repeated header
 * and its position in the document.
 * @public
 */
export interface PrintPage {
  /** 0-based index into the returned array. */
  readonly index: number;
  /** 1-based, for display. */
  readonly pageNumber: number;
  /** Total pages in the document — correct, resolved on a second pass. */
  readonly totalPage: number;
  /** Inclusive first row index. */
  readonly rowStart: number;
  /** Exclusive last row index. `rowEnd - rowStart` is the row count. */
  readonly rowEnd: number;
  /** Which vertical slice of rows this is (same for every band of a slice). */
  readonly rowSliceIndex: number;
  readonly band: ColumnBand;
  /** The repeated header cells for this band, or empty when repeatHeader is off. */
  readonly header: ReadonlyArray<PrintCell>;
  /** Group headers rendered on this page, in row order. */
  readonly groupHeader: ReadonlyArray<RenderedGroupHeader>;
  /** Per-row heights at scale 1, parallel to `rowStart..rowEnd`. */
  readonly rowHeight: ReadonlyArray<number>;
  /** Layout height consumed at scale 1, including header and group headers. */
  readonly usedHeight: number;
  /** Height of the repeated column header on this page; 0 when it is absent. */
  readonly headerHeight: number;
  /** Height of one group header band at scale 1. */
  readonly groupHeaderHeight: number;
  /** The scale factor applied to this document. */
  readonly scale: number;
  /** The resolved paper box. */
  readonly box: PageBox;
}

export type { ExportColumn, ExportRow };
