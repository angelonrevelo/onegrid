// =============================================================================
// ChartSpec — the discriminated union that says WHAT to draw
//
// Split deliberately from ChartData (WHICH numbers) and ChartLayout (WHERE on
// the canvas). The same derived dataset can be re-rendered as a bar and then
// a line without touching the grid, and a spec can be persisted in a
// workbook file without dragging a snapshot of the data along with it.
//
// The union discriminates on `kind`. Cartesian kinds share an axis-bearing
// base; pie and donut have no axes at all, so they extend the plain base and
// simply do not carry tick or gridline options. That is the point of a
// discriminated union over one wide optional-everything interface: a pie spec
// with `tickCount` set is a type error, not a silently ignored field.
// =============================================================================

/** @public */
export type ChartKind = 'line' | 'bar' | 'stackedBar' | 'area' | 'scatter' | 'pie' | 'donut';

/** @public */
export interface ChartPadding {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

/** @public */
export interface ChartSpecBase {
  /** Drawn top-left inside the padding box. Omit for no title. */
  readonly title?: string;
  /** Series colors, cycled. Defaults to `DEFAULT_PALETTE`. */
  readonly palette?: ReadonlyArray<string>;
  /** Inset from the layout box. Defaults to `DEFAULT_PADDING`. */
  readonly padding?: Partial<ChartPadding>;
  /** Draw a series legend. Default true when there is more than one series. */
  readonly legend?: boolean;
  /** Filled behind everything. Omit for transparent. */
  readonly background?: string;
  /** Axis line + tick color. Default '#8c959f'. */
  readonly axisColor?: string;
  /** Gridline color. Default '#d8dee4'. */
  readonly gridColor?: string;
  /** Label color. Default '#57606a'. */
  readonly textColor?: string;
  /** CSS font shorthand for every label. Default '11px sans-serif'. */
  readonly font?: string;
  /** Font size in px, used for layout arithmetic. Default 11. */
  readonly fontSize?: number;
}

/** @public */
export interface CartesianChartSpecBase extends ChartSpecBase {
  /** Target number of value-axis ticks. The nice-number pass may return ±1. */
  readonly tickCount?: number;
  /** Horizontal gridlines at each value tick. Default true. */
  readonly gridline?: boolean;
  /** Value-axis caption, drawn rotated-free in the left gutter's header slot. */
  readonly valueAxisLabel?: string;
  /** Category-axis caption, drawn under the category ticks. */
  readonly categoryAxisLabel?: string;
  /**
   * Force the value domain to include zero. Default true for bar-like kinds
   * (a bar chart with a truncated baseline lies about magnitude) and false
   * for line/scatter (where the interesting variation is often far from 0).
   */
  readonly zeroBaseline?: boolean;
  /** Explicit value domain, bypassing the nice-number pass entirely. */
  readonly valueDomain?: readonly [number, number];
}

/** @public */
export interface LineChartSpec extends CartesianChartSpecBase {
  readonly kind: 'line';
  readonly lineWidth?: number;
  /** Radius of the vertex dot. 0 draws a bare polyline. Default 0. */
  readonly pointRadius?: number;
}

/** @public */
export interface AreaChartSpec extends CartesianChartSpecBase {
  readonly kind: 'area';
  readonly lineWidth?: number;
  /** Alpha applied to the palette color for the fill. Default 0.25. */
  readonly fillAlpha?: number;
}

/** @public */
export interface BarChartSpec extends CartesianChartSpecBase {
  readonly kind: 'bar';
  /** Fraction of each category slot given to the gap. Default 0.2. */
  readonly barPadding?: number;
  /** Fraction of a bar's width given to the gap between grouped series. Default 0.1. */
  readonly groupPadding?: number;
}

/** @public */
export interface StackedBarChartSpec extends CartesianChartSpecBase {
  readonly kind: 'stackedBar';
  readonly barPadding?: number;
}

/** @public */
export interface ScatterChartSpec extends CartesianChartSpecBase {
  readonly kind: 'scatter';
  readonly pointRadius?: number;
}

/** @public */
export interface PieChartSpec extends ChartSpecBase {
  readonly kind: 'pie';
  /** Which series supplies the slice weights. Default 0. */
  readonly seriesIndex?: number;
}

/** @public */
export interface DonutChartSpec extends ChartSpecBase {
  readonly kind: 'donut';
  readonly seriesIndex?: number;
  /** Hole radius as a fraction of the outer radius. Default 0.55. */
  readonly innerRadiusRatio?: number;
}

/** @public */
export type ChartSpec =
  | LineChartSpec
  | AreaChartSpec
  | BarChartSpec
  | StackedBarChartSpec
  | ScatterChartSpec
  | PieChartSpec
  | DonutChartSpec;

/**
 * Eight hues that stay distinguishable under the two common colour-vision
 * deficiencies and hold up on both light and dark grid themes.
 * @public
 */
export const DEFAULT_PALETTE: ReadonlyArray<string> = [
  '#0969da',
  '#cf222e',
  '#1a7f37',
  '#bf8700',
  '#8250df',
  '#0d9488',
  '#bc4c00',
  '#6e7781',
];

/** @public */
export const DEFAULT_PADDING: ChartPadding = { top: 12, right: 12, bottom: 12, left: 12 };

/** Radial kinds have no axes and lay out differently. */
export function isRadialKind(kind: ChartKind): kind is 'pie' | 'donut' {
  return kind === 'pie' || kind === 'donut';
}

/** Bar-like kinds share the band scale and default to a zero baseline. */
export function isBarKind(kind: ChartKind): kind is 'bar' | 'stackedBar' {
  return kind === 'bar' || kind === 'stackedBar';
}

/** Resolve `spec.padding` against the defaults. */
export function resolvePadding(spec: ChartSpec): ChartPadding {
  const p = spec.padding;
  if (p === undefined) return DEFAULT_PADDING;
  return {
    top: p.top ?? DEFAULT_PADDING.top,
    right: p.right ?? DEFAULT_PADDING.right,
    bottom: p.bottom ?? DEFAULT_PADDING.bottom,
    left: p.left ?? DEFAULT_PADDING.left,
  };
}

/** Series color by index, cycling the palette. */
export function seriesColor(spec: ChartSpec, index: number): string {
  const palette = spec.palette ?? DEFAULT_PALETTE;
  if (palette.length === 0) return DEFAULT_PALETTE[0]!;
  return palette[index % palette.length]!;
}
