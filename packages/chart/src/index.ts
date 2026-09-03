// =============================================================================
// @onegrid/chart
//
// Range charts for oneGrid. The user drags a rectangle over cells and gets a
// chart bound to that rectangle — it re-derives and repaints as the selection
// moves. This is the full-size sibling of @onegrid/sparklines: same Canvas2D
// drawing idiom, same structural-context trick, an order of magnitude more
// chart.
//
// The package is four layers, deliberately separable:
//
//   derive.ts    ChartData from (ColumnTable, ChartRange). Pure. Infers which
//                column is the category axis and which are numeric series.
//   spec.ts      ChartSpec — a discriminated union over seven chart kinds.
//                What to draw, independent of the numbers and the canvas.
//   geometry.ts  ChartGeometry from (spec, data, box). Every coordinate,
//                computed ONCE so the renderer and the hit-tester cannot
//                disagree about where a bar is.
//   render.ts    Paints a geometry through a narrow Canvas2D subset.
//   hit.ts       Reads the same geometry backwards for tooltips.
//   bind.ts      The controller that wires the three to a live selection.
//
// Design decisions worth stating:
//
//   - NOTHING here imports a grid. The selection and the table arrive through
//     injected getters (`getRange`, `getTable`), which is why the whole
//     package tests against an in-memory ColumnTable and a recording canvas
//     double with no DOM at all. jsdom is present for parity with the rest of
//     the repo, not because anything needs it.
//   - Axis ticks come from a real nice-numbers pass (Heckbert 1990), not from
//     dividing the extent into N equal parts. An axis labelled 0 / 13.7 / 27.4
//     is a bug, and the cheapest place to prevent it is the scale layer.
//   - Null holes are holes. A missing cell breaks a line and skips a bar; it
//     is never silently drawn as zero, because a zero is a claim about the
//     data that the data did not make.
//   - Zero runtime dependencies. The two workspace deps are type-only.
// =============================================================================

export { deriveChartData, normalizeChartRange } from './derive';
export type {
  ChartData,
  ChartRange,
  ChartSeries,
  DeriveChartDataOption,
} from './derive';

export { bandScale, formatTick, linearScale, niceDomain } from './scale';
export type { BandScale, LinearScale, NiceDomain } from './scale';

export { DEFAULT_PADDING, DEFAULT_PALETTE } from './spec';
export type {
  AreaChartSpec,
  BarChartSpec,
  CartesianChartSpecBase,
  ChartKind,
  ChartPadding,
  ChartSpec,
  ChartSpecBase,
  DonutChartSpec,
  LineChartSpec,
  PieChartSpec,
  ScatterChartSpec,
  StackedBarChartSpec,
} from './spec';

export { computeChartGeometry } from './geometry';
export type {
  ChartBox,
  ChartGeometry,
  ChartLayout,
  ChartSlice,
  MeasureText,
} from './geometry';

export { isBarChartKind, renderChart } from './render';
export type { ChartContext } from './render';

export { hitTestChart } from './hit';
export type { ChartHit } from './hit';

export { bindRangeChart, normalizeSelection } from './bind';
export type { RangeChartBinding, RangeChartInput } from './bind';
