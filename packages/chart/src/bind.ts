// =============================================================================
// bindRangeChart — keep a chart tracking the grid's selection
//
// The roadmap row this package closes is "select cells, embed a chart bound
// to the selection". `deriveChartData` and `renderChart` are the two halves;
// this is the wire between them and the grid.
//
// Design decisions:
//
//   - The grid is INJECTED, not imported. The controller asks for
//     `getRange`, `getTable` and an `onRangeChange` subscribe function that
//     returns its own unsubscribe. That is the same narrow-interface pattern
//     `SqliteQueryable` uses in the sqlite adapter, and it means this works
//     against a real Grid, a headless table, or a test double with no DOM.
//   - Repaints are DEDUPED on the range identity. Dragging a selection fires
//     a change event per pointer move, but the range only changes on a cell
//     boundary; re-deriving 10k rows on every mousemove would drop frames.
//     `refresh(true)` forces past the dedupe when the underlying data changed
//     but the range did not.
//   - Painting is optional. Supply `ctx` and it paints; supply only
//     `onData` and it is a pure data pipeline feeding a DOM/SVG/React chart.
//   - `dispose()` is idempotent and unsubscribes. A chart embedded in a cell
//     is created and destroyed as the user scrolls, so leaking a selection
//     listener per embed would be a real leak, not a theoretical one.
// =============================================================================

import type { ColumnTable } from '@onegrid/data';
import type { SelectionSnapshot } from '@onegrid/core';
import {
  deriveChartData,
  type ChartData,
  type ChartRange,
  type DeriveChartDataOption,
} from './derive';
import { computeChartGeometry, type ChartGeometry, type ChartLayout } from './geometry';
import { hitTestChart, type ChartHit } from './hit';
import { renderChart, type ChartContext } from './render';
import type { ChartSpec } from './spec';

/** @public */
export interface RangeChartInput {
  /** Current selection rectangle, or null when nothing is selected. */
  readonly getRange: () => ChartRange | null;
  /** The table the range indexes into. Re-read on every refresh. */
  readonly getTable: () => ColumnTable | null;
  /**
   * Subscribe to selection changes. Must return an unsubscribe function —
   * `dispose()` calls it.
   */
  readonly onRangeChange: (listener: () => void) => () => void;
  readonly spec: ChartSpec;
  readonly layout: ChartLayout;
  /** Paint target. Omit for a data-only binding. */
  readonly ctx?: ChartContext;
  /** Called after every re-derive, painted or not. */
  readonly onData?: (data: ChartData, geometry: ChartGeometry) => void;
  readonly option?: DeriveChartDataOption;
}

/** @public */
export interface RangeChartBinding {
  /** Latest derived dataset. Empty until the first refresh. */
  readonly data: ChartData;
  /** Geometry of the latest paint — hand straight to `hitTestChart`. */
  readonly geometry: ChartGeometry;
  /** The range the current data came from, or null. */
  readonly range: ChartRange | null;
  /** Re-derive and repaint. Skips work when the range is unchanged unless forced. */
  readonly refresh: (force?: boolean) => void;
  /** Swap the chart kind/styling and repaint immediately. */
  readonly setSpec: (spec: ChartSpec) => void;
  /** Resize and repaint immediately. */
  readonly setLayout: (layout: ChartLayout) => void;
  /** Hit-test against the latest geometry. */
  readonly hitTest: (x: number, y: number) => ChartHit | null;
  /** Unsubscribe. Idempotent. */
  readonly dispose: () => void;
  /** Number of paints performed — the cheap way to assert dedupe works. */
  readonly paintCount: number;
}

const EMPTY_RANGE_KEY = '';

// A key rangeKey() can never produce, so the first refresh always runs.
const SENTINEL_KEY = 'init';

function rangeKey(range: ChartRange | null): string {
  if (range === null) return EMPTY_RANGE_KEY;
  return `${range.rowStart}:${range.rowEnd}:${range.colStart}:${range.colEnd}`;
}

/**
 * Convert a core `SelectionSnapshot` into a chart range.
 *
 * Takes the LAST range in the snapshot, which is the one the user most
 * recently dragged — matching how a spreadsheet decides which of several
 * ctrl-clicked rectangles a new chart should use. Returns null for an empty
 * selection.
 * @public
 */
export function normalizeSelection(snapshot: SelectionSnapshot): ChartRange | null {
  const range = snapshot.ranges[snapshot.ranges.length - 1];
  if (range === undefined) return null;
  return {
    rowStart: Math.min(range.anchor.row, range.active.row),
    rowEnd: Math.max(range.anchor.row, range.active.row),
    colStart: Math.min(range.anchor.col, range.active.col),
    colEnd: Math.max(range.anchor.col, range.active.col),
  };
}

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
 * Bind a chart to a live grid selection. Derives immediately, then re-derives
 * and repaints on every selection change until disposed.
 * @public
 */
export function bindRangeChart(input: RangeChartInput): RangeChartBinding {
  let spec = input.spec;
  let layout = input.layout;
  let data: ChartData = EMPTY_DATA;
  let geometry: ChartGeometry = computeChartGeometry(spec, data, layout);
  let range: ChartRange | null = null;
  let key = SENTINEL_KEY;
  let paintCount = 0;
  let disposed = false;

  const paint = (): void => {
    if (input.ctx !== undefined) {
      geometry = renderChart(input.ctx, spec, data, layout);
    } else {
      geometry = computeChartGeometry(spec, data, layout);
    }
    paintCount++;
    input.onData?.(data, geometry);
  };

  const refresh = (force = false): void => {
    if (disposed) return;
    const next = input.getRange();
    const nextKey = rangeKey(next);
    if (!force && nextKey === key) return;
    key = nextKey;
    range = next;
    const table = input.getTable();
    data = next === null || table === null ? EMPTY_DATA : deriveChartData(table, next, input.option ?? {});
    paint();
  };

  const unsubscribe = input.onRangeChange(() => refresh(false));
  refresh(true);

  return {
    get data() {
      return data;
    },
    get geometry() {
      return geometry;
    },
    get range() {
      return range;
    },
    get paintCount() {
      return paintCount;
    },
    refresh,
    setSpec: (next: ChartSpec) => {
      spec = next;
      paint();
    },
    setLayout: (next: ChartLayout) => {
      layout = next;
      paint();
    },
    hitTest: (x: number, y: number) => hitTestChart(spec, data, layout, x, y, geometry),
    dispose: () => {
      if (disposed) return;
      disposed = true;
      unsubscribe();
    },
  };
}
