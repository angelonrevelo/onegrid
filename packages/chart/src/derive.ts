// =============================================================================
// deriveChartData — turn a rectangular cell range into a plottable dataset
//
// The user does not tell us what to chart. They drag a rectangle over the
// grid, and we have to guess what they meant. The rule this module implements
// is the one every spreadsheet has converged on, and it is worth stating
// explicitly because it is the whole product:
//
//   1. Every column inside the range is classified numeric or categorical by
//      looking at its VALUES in the selected rows — not by its declared
//      schema type. A grid column typed `string` that happens to hold "12.5"
//      in the selected rows is a series; a column typed `int32` holding a
//      year is still numeric and the user can override.
//   2. The category axis is the first NON-numeric column in the range. If
//      every column is numeric there is no label column, so the category is
//      the source row index — which is exactly what Excel does.
//   3. Everything else numeric becomes a series, in range order.
//
// Classification uses a MAJORITY rule over non-null cells rather than
// requiring every cell to parse. Real selections have a stray "N/A" in an
// otherwise numeric column; failing the whole column over one bad cell would
// silently drop the series the user wanted. Cells that do not parse become
// null holes instead, and every renderer here treats a null hole as a gap to
// skip rather than a zero to draw.
// =============================================================================

import type { ColumnTable } from '@onegrid/data';

/**
 * A rectangular block of cells, with inclusive bounds.
 *
 * Structurally identical to `NormalizedRange` in `@onegrid/core`'s selection
 * model — that type is not re-exported from the core entry point, so it is
 * restated here rather than reached into. Values from `normalizeSelection`
 * or from the grid's own normalizer drop straight in.
 * @public
 */
export interface ChartRange {
  readonly rowStart: number;
  readonly rowEnd: number;
  readonly colStart: number;
  readonly colEnd: number;
}

/** @public */
export interface ChartSeries {
  /** Source column id. */
  readonly id: string;
  /** Human label — the column's `displayName`, falling back to its id. */
  readonly label: string;
  /** Index of the source column within the table schema. */
  readonly columnIndex: number;
  /** One entry per category, in category order. `null` is a hole, not a zero. */
  readonly value: ReadonlyArray<number | null>;
  /** Extent over the non-null values. Both 0 when the series is all holes. */
  readonly min: number;
  readonly max: number;
  /** Sum of non-null values — pie/donut slice weights come from here. */
  readonly total: number;
}

/** @public */
export interface ChartData {
  /** Axis labels, one per plotted row. */
  readonly category: ReadonlyArray<string>;
  /** Column id the categories came from, or null when they are row indices. */
  readonly categoryColumnId: string | null;
  /** Source row index behind each category — lets a tooltip jump to the row. */
  readonly rowIndex: ReadonlyArray<number>;
  readonly series: ReadonlyArray<ChartSeries>;
  /** Extent across every series. Both 0 when there is nothing numeric. */
  readonly min: number;
  readonly max: number;
  /** Per-category sum across all series — the stacked-bar and area domain. */
  readonly stackMax: number;
  readonly stackMin: number;
  /** True when there is nothing to draw (no rows, or no numeric column). */
  readonly isEmpty: boolean;
}

/** @public */
export interface DeriveChartDataOption {
  /**
   * Force a specific column to be the category axis. Ignored when the column
   * is not inside the range — a chart must never read cells the user did not
   * select.
   */
  readonly categoryColumnId?: string;
  /** Force the series columns, in this order. Ids outside the range are dropped. */
  readonly seriesColumnId?: ReadonlyArray<string>;
  /**
   * Cap on plotted rows. A 200k-row selection would allocate 200k labels for
   * a 400px-wide chart; beyond this cap we take the first `maxRow` rows.
   * Default 10000.
   */
  readonly maxRow?: number;
  /**
   * Fraction of non-null cells that must parse as a finite number for a
   * column to count as a series. Default 0.5.
   */
  readonly numericThreshold?: number;
}

const DEFAULT_MAX_ROW = 10_000;
const DEFAULT_NUMERIC_THRESHOLD = 0.5;

const EMPTY_DATA: ChartData = {
  category: [],
  categoryColumnId: null,
  rowIndex: [],
  series: [],
  min: 0,
  max: 0,
  stackMin: 0,
  stackMax: 0,
  isEmpty: true,
};

/**
 * Clamp a range to a table's real extent and put its bounds in ascending
 * order. A selection dragged upward has `rowStart > rowEnd`; a selection made
 * before a schema change can point past the last column. Both are normal, and
 * both must produce a drawable range rather than an exception.
 * @public
 */
export function normalizeChartRange(range: ChartRange, table: ColumnTable): ChartRange | null {
  const lastRow = table.numRows - 1;
  const lastCol = table.schema.length - 1;
  if (lastRow < 0 || lastCol < 0) return null;
  const rowStart = Math.max(0, Math.min(range.rowStart, range.rowEnd));
  const rowEnd = Math.min(lastRow, Math.max(range.rowStart, range.rowEnd));
  const colStart = Math.max(0, Math.min(range.colStart, range.colEnd));
  const colEnd = Math.min(lastCol, Math.max(range.colStart, range.colEnd));
  if (rowStart > rowEnd || colStart > colEnd) return null;
  return { rowStart, rowEnd, colStart, colEnd };
}

/**
 * Coerce one cell to a plottable number, or null.
 *
 * Booleans deliberately do NOT coerce: a boolean column charted as 1/0 is
 * almost never what the user meant, and treating it as categorical keeps it
 * available as the category axis. Dates do not coerce either — an epoch
 * millisecond axis is unreadable, so a date column becomes a label.
 */
function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return null;
    // Strip thousands separators and a trailing percent sign, both of which
    // are display artefacts of a genuinely numeric column.
    const cleaned = trimmed.replace(/,/g, '').replace(/%$/, '');
    const parsed = Number(cleaned);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** Render one cell as an axis label. */
function toLabel(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'object') return JSON.stringify(value) ?? '';
  return String(value);
}

/**
 * Derive a typed chart dataset from a columnar table and a cell range.
 *
 * Never throws on a bad range — an out-of-bounds, inverted, empty or
 * all-text selection returns an `isEmpty` dataset, because this runs on every
 * selection change and a chart that explodes mid-drag is worse than a chart
 * that goes blank.
 * @public
 */
export function deriveChartData(
  table: ColumnTable,
  range: ChartRange,
  option: DeriveChartDataOption = {},
): ChartData {
  const normalized = normalizeChartRange(range, table);
  if (normalized === null) return EMPTY_DATA;

  const maxRow = Math.max(1, option.maxRow ?? DEFAULT_MAX_ROW);
  const threshold = Math.min(1, Math.max(0, option.numericThreshold ?? DEFAULT_NUMERIC_THRESHOLD));

  const rowIndex: number[] = [];
  for (let r = normalized.rowStart; r <= normalized.rowEnd && rowIndex.length < maxRow; r++) {
    rowIndex.push(r);
  }
  if (rowIndex.length === 0) return EMPTY_DATA;

  // Read every column in the range once into a raw buffer. One pass over the
  // vectors beats re-reading them for classification and then for extraction.
  const candidate: CandidateColumn[] = [];
  for (let c = normalized.colStart; c <= normalized.colEnd; c++) {
    const schema = table.schema[c];
    if (schema === undefined) continue;
    const vector = table.column(schema.id);
    const raw: unknown[] = [];
    const numeric: Array<number | null> = [];
    let nonNull = 0;
    let parsed = 0;
    for (const r of rowIndex) {
      const isNull = vector.isNull(r);
      const value = isNull ? null : vector.get(r);
      raw.push(value);
      const asNumber = isNull ? null : toNumber(value);
      numeric.push(asNumber);
      if (!isNull && value !== null && value !== undefined) nonNull++;
      if (asNumber !== null) parsed++;
    }
    candidate.push({
      id: schema.id,
      label: schema.displayName ?? schema.id,
      columnIndex: c,
      raw,
      numeric,
      isNumeric: nonNull > 0 && parsed / nonNull >= threshold,
    });
  }
  if (candidate.length === 0) return EMPTY_DATA;

  // --- Category axis -------------------------------------------------------
  let categoryColumn: CandidateColumn | null = null;
  if (option.categoryColumnId !== undefined) {
    categoryColumn = candidate.find((c) => c.id === option.categoryColumnId) ?? null;
  }
  if (categoryColumn === null && option.categoryColumnId === undefined) {
    categoryColumn = candidate.find((c) => !c.isNumeric) ?? null;
  }

  const category: string[] =
    categoryColumn === null
      ? rowIndex.map((r) => String(r))
      : categoryColumn.raw.map(toLabel);

  // --- Series --------------------------------------------------------------
  let seriesColumn: CandidateColumn[];
  if (option.seriesColumnId !== undefined) {
    seriesColumn = [];
    for (const id of option.seriesColumnId) {
      const found = candidate.find((c) => c.id === id);
      if (found !== undefined) seriesColumn.push(found);
    }
  } else {
    seriesColumn = candidate.filter((c) => c.isNumeric && c.id !== categoryColumn?.id);
  }

  const series: ChartSeries[] = seriesColumn.map((c) => {
    let min = Infinity;
    let max = -Infinity;
    let total = 0;
    for (const v of c.numeric) {
      if (v === null) continue;
      if (v < min) min = v;
      if (v > max) max = v;
      total += v;
    }
    const hasValue = min !== Infinity;
    return {
      id: c.id,
      label: c.label,
      columnIndex: c.columnIndex,
      value: c.numeric,
      min: hasValue ? min : 0,
      max: hasValue ? max : 0,
      total,
    };
  });

  if (series.length === 0) {
    return {
      category,
      categoryColumnId: categoryColumn?.id ?? null,
      rowIndex,
      series: [],
      min: 0,
      max: 0,
      stackMin: 0,
      stackMax: 0,
      isEmpty: true,
    };
  }

  let min = Infinity;
  let max = -Infinity;
  for (const s of series) {
    for (const v of s.value) {
      if (v === null) continue;
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  if (min === Infinity) {
    min = 0;
    max = 0;
  }

  // Stacked charts need the per-category running total, and positive and
  // negative contributions stack in opposite directions.
  let stackMin = 0;
  let stackMax = 0;
  for (let i = 0; i < category.length; i++) {
    let positive = 0;
    let negative = 0;
    for (const s of series) {
      const v = s.value[i];
      if (v === null || v === undefined) continue;
      if (v >= 0) positive += v;
      else negative += v;
    }
    if (positive > stackMax) stackMax = positive;
    if (negative < stackMin) stackMin = negative;
  }

  return {
    category,
    categoryColumnId: categoryColumn?.id ?? null,
    rowIndex,
    series,
    min,
    max,
    stackMin,
    stackMax,
    isEmpty: category.length === 0,
  };
}

interface CandidateColumn {
  readonly id: string;
  readonly label: string;
  readonly columnIndex: number;
  readonly raw: ReadonlyArray<unknown>;
  readonly numeric: ReadonlyArray<number | null>;
  readonly isNumeric: boolean;
}
