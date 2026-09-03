// =============================================================================
// Format-preserving cell projection.
//
// The failure mode this module exists to prevent: an exporter that calls
// `String(value)` and ships `0.0725` where the grid showed `7.25%`, in black
// where the grid showed red, left-aligned where the grid showed a right-
// aligned currency column. Print output that does not look like the grid is
// not a print of the grid.
//
// The projection order is deliberate and matches @onegrid/export's:
//   1. `column.format(value, rowIndex)` — the caller's explicit formatter
//      always wins, exactly as in CSV/XLSX export.
//   2. `column.numberFormat` through `Intl.NumberFormat` for numeric values.
//   3. A conservative default stringifier (ISO for Date, '' for nullish).
//
// Style resolves as static `column.style` merged UNDER `conditionalStyle`, so
// a heat map or a red-negative rule overrides the column default per cell.
// Alignment falls back to `right` for numerics because that is what every
// spreadsheet does and what makes a column of figures readable.
// =============================================================================

import type { CellAlign, CellStyle, ExportRow, PrintCell, PrintColumn } from './types';

/** Default column width in points when a column declares none. @public */
export const DEFAULT_COLUMN_WIDTH = 72;

/** Locale used when a column declares none. Fixed for reproducible output. */
const DEFAULT_LOCALE = 'en-US';

/**
 * Effective width of a column in points, honouring the per-run default.
 * @public
 */
export function columnWidth(column: PrintColumn, fallback = DEFAULT_COLUMN_WIDTH): number {
  const w = column.width ?? fallback;
  // A zero or negative width would let a band accept infinite columns.
  return w > 0 ? w : fallback;
}

function stringifyValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') {
    return String(value);
  }
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function mergeStyle(base: CellStyle | undefined, over: CellStyle | undefined): CellStyle {
  if (!base) return over ?? {};
  if (!over) return base;
  // Only defined keys override, so `{ color: undefined }` from a conditional
  // callback does not erase the column's colour.
  return {
    ...base,
    ...(over.color !== undefined ? { color: over.color } : {}),
    ...(over.background !== undefined ? { background: over.background } : {}),
    ...(over.bold !== undefined ? { bold: over.bold } : {}),
    ...(over.italic !== undefined ? { italic: over.italic } : {}),
    ...(over.align !== undefined ? { align: over.align } : {}),
  };
}

/**
 * Project one raw value through a column definition into a fully resolved
 * `PrintCell`. Pure and synchronous — the paginator, the PDF writer and the
 * HTML emitter all call this so the three outputs cannot disagree.
 * @public
 */
export function formatCell(
  column: PrintColumn,
  value: unknown,
  row: ExportRow,
  rowIndex: number,
): PrintCell {
  const numeric = typeof value === 'number' && Number.isFinite(value);

  let text: string;
  if (column.format) {
    text = column.format(value, rowIndex);
  } else if (numeric && column.numberFormat) {
    text = new Intl.NumberFormat(column.locale ?? DEFAULT_LOCALE, column.numberFormat).format(
      value,
    );
  } else {
    text = stringifyValue(value);
  }

  const conditional = column.conditionalStyle?.(value, row, rowIndex);
  const style = mergeStyle(column.style, conditional);
  const align: CellAlign = style.align ?? column.align ?? (numeric ? 'right' : 'left');

  return { columnId: column.id, text, align, style, numeric };
}

/**
 * Header cell for a column. Headers are centre-agnostic: they inherit the
 * column's alignment so a right-aligned figure column gets a right-aligned
 * label sitting directly over its digits.
 * @public
 */
export function headerCell(column: PrintColumn): PrintCell {
  return {
    columnId: column.id,
    text: column.header ?? column.id,
    align: column.align ?? 'left',
    style: { bold: true, ...(column.style?.background !== undefined ? { background: column.style.background } : {}) },
    numeric: false,
  };
}

/**
 * A fully styled cell matrix — the format-preserving export surface. Feed the
 * result to SheetJS (`aoa` plus per-cell `s` styles), to a CSV writer that
 * only wants `.text`, or to any renderer; the formats, alignments and
 * conditional colours are already resolved and travel with the data.
 * @public
 */
export interface StyledSheet {
  readonly header: ReadonlyArray<PrintCell>;
  readonly row: ReadonlyArray<ReadonlyArray<PrintCell>>;
  /** Column widths in points, parallel to `header`. */
  readonly columnWidth: ReadonlyArray<number>;
}

/**
 * Build a `StyledSheet` from rows and columns. This is the sibling of
 * `exportToCsv` / `exportToXlsx` in @onegrid/export — same column contract,
 * but nothing is flattened to text-only.
 * @public
 */
export function toStyledSheet<TRow extends ExportRow>(
  table: ReadonlyArray<TRow>,
  column: ReadonlyArray<PrintColumn>,
  defaultWidth = DEFAULT_COLUMN_WIDTH,
): StyledSheet {
  const header = column.map((c) => headerCell(c));
  const row = table.map((r, i) => column.map((c) => formatCell(c, r[c.id], r, i)));
  const width = column.map((c) => columnWidth(c, defaultWidth));
  return { header, row, columnWidth: width };
}
