// =============================================================================
// computeChartGeometry — every coordinate, computed once
//
// Rendering and hit-testing must agree to the pixel, or a tooltip points at
// the wrong bar. The only way to guarantee that is to have exactly one place
// that turns (spec, data, box) into coordinates, and have both the renderer
// and the hit-tester read it. That place is this module; `renderChart` and
// `hitTestChart` are both thin consumers of a `ChartGeometry`.
//
// The plot box is derived, not configured. It is the layout box inset by
// padding, then further inset by whatever the chart actually needs: a title
// row, an axis-caption row, the widest value-tick label plus its tick mark,
// a category-label row, and a legend row. Measuring the tick labels requires
// knowing the ticks, which requires knowing the domain — so the domain and
// nice-number pass run BEFORE the box is finalised.
//
// Text width is an injected function. Canvas `measureText` is authoritative
// but only exists on a real context; headless callers and tests get a
// per-character estimate that is close enough for gutter arithmetic. This is
// the repo's narrow-injectable-interface pattern applied to text metrics.
// =============================================================================

import type { ChartData } from './derive';
import {
  isBarKind,
  isRadialKind,
  resolvePadding,
  seriesColor,
  type ChartPadding,
  type ChartSpec,
} from './spec';
import { bandScale, formatTick, linearScale, niceDomain, type BandScale, type LinearScale } from './scale';

/** @public */
export interface ChartBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * The outer box a chart is drawn into — canvas coordinates, not CSS pixels.
 * @public
 */
export type ChartLayout = ChartBox;

/** One pie/donut slice, in radians, clockwise from 12 o'clock. @public */
export interface ChartSlice {
  readonly categoryIndex: number;
  readonly label: string;
  readonly value: number;
  readonly startAngle: number;
  readonly endAngle: number;
  readonly color: string;
}

/** @public */
export interface ChartGeometry {
  readonly layout: ChartLayout;
  /** The drawable area inside padding, title, axis gutters and legend. */
  readonly plot: ChartBox;
  /** Legend strip, or null when the legend is off or there is no room. */
  readonly legend: ChartBox | null;
  /** Title baseline anchor, or null when there is no title. */
  readonly titleAnchor: { readonly x: number; readonly y: number } | null;
  readonly valueDomain: readonly [number, number];
  readonly tick: ReadonlyArray<number>;
  readonly tickStep: number;
  /** Formatted tick labels, index-aligned with `tick`. */
  readonly tickLabel: ReadonlyArray<string>;
  /** Value -> y pixel. Inverted (larger value = smaller y). */
  readonly valueScale: LinearScale;
  /** Category index -> x band. Null for radial kinds. */
  readonly categoryScale: BandScale | null;
  /** Pixel y of the value-zero line, clamped into the plot. */
  readonly baselineY: number;
  /** Radial centre, or null for cartesian kinds. */
  readonly center: { readonly x: number; readonly y: number } | null;
  readonly outerRadius: number;
  readonly innerRadius: number;
  readonly slice: ReadonlyArray<ChartSlice>;
  readonly fontSize: number;
  readonly padding: ChartPadding;
}

/** @public */
export interface MeasureText {
  (text: string, font: string): number;
}

/** Rough advance width when no real text metrics are available. */
function estimateTextWidth(text: string, fontSize: number): number {
  return text.length * fontSize * 0.6;
}

const TICK_MARK_LENGTH = 4;
const TICK_LABEL_GAP = 4;

/**
 * Compute every coordinate a chart needs. Pure — no context, no DOM.
 *
 * Pass `measure` when a real canvas context is available so the left gutter
 * matches the glyphs that will actually be drawn.
 * @public
 */
export function computeChartGeometry(
  spec: ChartSpec,
  data: ChartData,
  layout: ChartLayout,
  measure?: MeasureText,
): ChartGeometry {
  const padding = resolvePadding(spec);
  const fontSize = spec.fontSize ?? 11;
  const font = spec.font ?? `${fontSize}px sans-serif`;
  const width = (text: string): number =>
    measure ? measure(text, font) : estimateTextWidth(text, fontSize);

  let left = layout.x + padding.left;
  let top = layout.y + padding.top;
  let right = layout.x + layout.width - padding.right;
  let bottom = layout.y + layout.height - padding.bottom;

  let titleAnchor: { x: number; y: number } | null = null;
  if (spec.title !== undefined && spec.title !== '') {
    titleAnchor = { x: left, y: top + fontSize };
    top += fontSize + 6;
  }

  const seriesCount = data.series.length;
  const legendWanted = spec.legend ?? seriesCount > 1;
  let legend: ChartBox | null = null;
  if (legendWanted && seriesCount > 0) {
    const legendHeight = fontSize + 6;
    if (bottom - top > legendHeight * 2) {
      legend = { x: left, y: bottom - legendHeight, width: right - left, height: legendHeight };
      bottom -= legendHeight + 4;
    }
  }

  const radial = isRadialKind(spec.kind);

  // --- Value domain + ticks (needed before the gutter can be measured) -----
  const stacked = spec.kind === 'stackedBar';
  let domainLo: number;
  let domainHi: number;
  if (stacked) {
    domainLo = Math.min(0, data.stackMin);
    domainHi = Math.max(0, data.stackMax);
  } else {
    domainLo = data.min;
    domainHi = data.max;
  }
  const zeroBaseline =
    'zeroBaseline' in spec && spec.zeroBaseline !== undefined
      ? spec.zeroBaseline
      : isBarKind(spec.kind) || spec.kind === 'area';
  if (zeroBaseline) {
    domainLo = Math.min(0, domainLo);
    domainHi = Math.max(0, domainHi);
  }

  const explicitDomain = 'valueDomain' in spec ? spec.valueDomain : undefined;
  const tickCount = 'tickCount' in spec ? (spec.tickCount ?? 5) : 5;
  let tick: number[];
  let tickStep: number;
  let valueLo: number;
  let valueHi: number;
  if (explicitDomain !== undefined) {
    // An explicit domain is a promise the caller made about comparability
    // across charts; honour it exactly rather than rounding it outward.
    [valueLo, valueHi] = explicitDomain;
    const wanted = Math.max(2, Math.floor(tickCount));
    tickStep = (valueHi - valueLo) / (wanted - 1);
    tick = [];
    for (let i = 0; i < wanted; i++) tick.push(valueLo + i * tickStep);
  } else {
    const nice = niceDomain(domainLo, domainHi, tickCount);
    valueLo = nice.min;
    valueHi = nice.max;
    tickStep = nice.step;
    tick = nice.tick.slice();
  }
  const tickLabel = tick.map((t) => formatTick(t, tickStep));

  // --- Axis gutters --------------------------------------------------------
  if (!radial) {
    if ('valueAxisLabel' in spec && spec.valueAxisLabel !== undefined) {
      top += fontSize + 4;
    }
    let gutter = 0;
    for (const label of tickLabel) {
      const w = width(label);
      if (w > gutter) gutter = w;
    }
    left += gutter + TICK_MARK_LENGTH + TICK_LABEL_GAP;
    // Category tick labels sit in a row under the axis line.
    bottom -= fontSize + TICK_MARK_LENGTH + TICK_LABEL_GAP;
    if ('categoryAxisLabel' in spec && spec.categoryAxisLabel !== undefined) {
      bottom -= fontSize + 4;
    }
    // The rightmost category label overhangs the plot; give it half its width
    // so it is not clipped by the layout edge.
    const lastLabel = data.category[data.category.length - 1];
    if (lastLabel !== undefined) {
      right -= Math.min(width(lastLabel) / 2, 24);
    }
  }

  const plot: ChartBox = {
    x: left,
    y: top,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  };

  const valueScale = linearScale([valueLo, valueHi], [plot.y + plot.height, plot.y]);
  const baselineY = Math.max(plot.y, Math.min(plot.y + plot.height, valueScale.scale(0)));

  const barPadding =
    'barPadding' in spec && spec.barPadding !== undefined ? spec.barPadding : 0.2;
  // Line, area and scatter put their vertices at band CENTRES, so they still
  // want a band scale — just one whose padding does not matter.
  const categoryScale = radial
    ? null
    : bandScale(data.category.length, [plot.x, plot.x + plot.width], isBarKind(spec.kind) ? barPadding : 0);

  // --- Radial --------------------------------------------------------------
  let center: { x: number; y: number } | null = null;
  let outerRadius = 0;
  let innerRadius = 0;
  const slice: ChartSlice[] = [];
  if (radial) {
    center = { x: plot.x + plot.width / 2, y: plot.y + plot.height / 2 };
    outerRadius = Math.max(0, Math.min(plot.width, plot.height) / 2 - 2);
    innerRadius =
      spec.kind === 'donut' ? outerRadius * (spec.innerRadiusRatio ?? 0.55) : 0;
    const seriesIndex = 'seriesIndex' in spec ? (spec.seriesIndex ?? 0) : 0;
    const source = data.series[seriesIndex];
    if (source !== undefined) {
      // Negative values have no meaningful angular width; a pie of mixed
      // signs is a broken chart, so we weight by magnitude and let the
      // tooltip report the signed value.
      let total = 0;
      for (const v of source.value) total += v === null ? 0 : Math.abs(v);
      let angle = -Math.PI / 2;
      for (let i = 0; i < source.value.length; i++) {
        const v = source.value[i];
        if (v === null || v === undefined) continue;
        const sweep = total === 0 ? 0 : (Math.abs(v) / total) * Math.PI * 2;
        slice.push({
          categoryIndex: i,
          label: data.category[i] ?? String(i),
          value: v,
          startAngle: angle,
          endAngle: angle + sweep,
          color: seriesColor(spec, i),
        });
        angle += sweep;
      }
    }
  }

  return {
    layout,
    plot,
    legend,
    titleAnchor,
    valueDomain: [valueLo, valueHi],
    tick,
    tickStep,
    tickLabel,
    valueScale,
    categoryScale,
    baselineY,
    center,
    outerRadius,
    innerRadius,
    slice,
    fontSize,
    padding,
  };
}
