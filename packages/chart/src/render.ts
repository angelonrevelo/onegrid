// =============================================================================
// renderChart — Canvas2D painter
//
// Draws through the same narrow structural context @onegrid/sparklines uses:
// a `ChartContext` listing only the Canvas2D members we actually touch. A
// real `CanvasRenderingContext2D` satisfies it, an OffscreenCanvas context
// satisfies it, and a recording double satisfies it — which is how this is
// tested, since asserting on a call sequence proves the axes and marks landed
// at specific coordinates in a way pixel-diffing a real canvas never does.
//
// Draw order is deliberate and matters visually: background, gridlines, axis
// lines, tick marks, tick labels, series marks, legend, title. Marks go on
// top of gridlines because a gridline crossing a bar looks like a defect;
// labels go on top of everything because a clipped label is unreadable.
//
// The renderer never mutates its inputs and never allocates per frame beyond
// the geometry it is handed, so repainting on every selection drag is cheap.
// =============================================================================

import type { ChartData } from './derive';
import { computeChartGeometry, type ChartGeometry, type ChartLayout } from './geometry';
import { isBarKind, isRadialKind, seriesColor, type ChartSpec } from './spec';

/**
 * The Canvas2D subset this renderer touches. `measureText` is optional: when
 * present it is used for the axis gutter and legend spacing, when absent a
 * per-character estimate is used instead.
 * @public
 */
export interface ChartContext {
  fillStyle: string;
  strokeStyle: string;
  lineWidth: number;
  font: string;
  globalAlpha: number;
  textAlign: string;
  textBaseline: string;
  save(): void;
  restore(): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  closePath(): void;
  stroke(): void;
  fill(): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  arc(x: number, y: number, radius: number, start: number, end: number, counter?: boolean): void;
  fillText(text: string, x: number, y: number): void;
}

const TICK_MARK_LENGTH = 4;
const TICK_LABEL_GAP = 4;
const LEGEND_SWATCH = 8;
const LEGEND_GAP = 14;

const DEFAULT_AXIS_COLOR = '#8c959f';
const DEFAULT_GRID_COLOR = '#d8dee4';
const DEFAULT_TEXT_COLOR = '#57606a';

/**
 * Draw a chart into the given box and return the geometry it used.
 *
 * The returned geometry is the exact one to hand to `hitTestChart`, so a
 * tooltip lines up with what was painted. Passing a precomputed geometry via
 * `geometry` skips the layout pass — worth doing when repainting the same
 * chart at the same size on every animation frame.
 * @public
 */
export function renderChart(
  ctx: ChartContext,
  spec: ChartSpec,
  data: ChartData,
  layout: ChartLayout,
  geometry?: ChartGeometry,
): ChartGeometry {
  const measure = hasMeasureText(ctx)
    ? (text: string, font: string): number => {
        const previous = ctx.font;
        ctx.font = font;
        const w = ctx.measureText(text).width;
        ctx.font = previous;
        return w;
      }
    : undefined;
  const geo = geometry ?? computeChartGeometry(spec, data, layout, measure);

  const fontSize = geo.fontSize;
  const font = spec.font ?? `${fontSize}px sans-serif`;
  const axisColor = spec.axisColor ?? DEFAULT_AXIS_COLOR;
  const gridColor = spec.gridColor ?? DEFAULT_GRID_COLOR;
  const textColor = spec.textColor ?? DEFAULT_TEXT_COLOR;

  ctx.save();
  ctx.globalAlpha = 1;
  ctx.font = font;

  if (spec.background !== undefined) {
    ctx.fillStyle = spec.background;
    ctx.fillRect(layout.x, layout.y, layout.width, layout.height);
  }

  if (isRadialKind(spec.kind)) {
    drawRadial(ctx, spec, geo, textColor, fontSize);
  } else if (!data.isEmpty && geo.plot.width > 0 && geo.plot.height > 0) {
    drawAxis(ctx, spec, data, geo, axisColor, gridColor, textColor, fontSize);
    drawSeries(ctx, spec, data, geo);
  } else {
    // An empty selection still gets its axes so the chart frame does not
    // vanish and reappear as the user drags across text columns.
    drawAxis(ctx, spec, data, geo, axisColor, gridColor, textColor, fontSize);
  }

  if (geo.legend !== null) {
    drawLegend(ctx, spec, data, geo, textColor, measure, font, fontSize);
  }

  if (geo.titleAnchor !== null && spec.title !== undefined) {
    ctx.fillStyle = textColor;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(spec.title, geo.titleAnchor.x, geo.titleAnchor.y);
  }

  ctx.restore();
  return geo;
}

interface MeasuringContext extends ChartContext {
  measureText(text: string): { width: number };
}

function hasMeasureText(ctx: ChartContext): ctx is MeasuringContext {
  return typeof (ctx as Partial<MeasuringContext>).measureText === 'function';
}

// -----------------------------------------------------------------------------
// Axes
// -----------------------------------------------------------------------------

function drawAxis(
  ctx: ChartContext,
  spec: ChartSpec,
  data: ChartData,
  geo: ChartGeometry,
  axisColor: string,
  gridColor: string,
  textColor: string,
  fontSize: number,
): void {
  const { plot } = geo;
  const gridline = 'gridline' in spec ? (spec.gridline ?? true) : true;

  if (gridline) {
    ctx.strokeStyle = gridColor;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (const value of geo.tick) {
      // Half-pixel offset so a 1px line lands on a pixel rather than
      // straddling two and rendering as a 2px blur.
      const y = Math.round(geo.valueScale.scale(value)) + 0.5;
      ctx.moveTo(plot.x, y);
      ctx.lineTo(plot.x + plot.width, y);
    }
    ctx.stroke();
  }

  ctx.strokeStyle = axisColor;
  ctx.lineWidth = 1;
  ctx.beginPath();
  // Value axis (left) and category axis (at value zero, or the plot floor).
  ctx.moveTo(Math.round(plot.x) + 0.5, plot.y);
  ctx.lineTo(Math.round(plot.x) + 0.5, plot.y + plot.height);
  const axisY = Math.round(geo.baselineY) + 0.5;
  ctx.moveTo(plot.x, axisY);
  ctx.lineTo(plot.x + plot.width, axisY);
  // Tick marks on the value axis.
  for (const value of geo.tick) {
    const y = Math.round(geo.valueScale.scale(value)) + 0.5;
    ctx.moveTo(plot.x - TICK_MARK_LENGTH, y);
    ctx.lineTo(plot.x, y);
  }
  ctx.stroke();

  ctx.fillStyle = textColor;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let i = 0; i < geo.tick.length; i++) {
    const y = geo.valueScale.scale(geo.tick[i]!);
    ctx.fillText(geo.tickLabel[i]!, plot.x - TICK_MARK_LENGTH - TICK_LABEL_GAP, y);
  }

  const band = geo.categoryScale;
  if (band !== null && band.count > 0) {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    // With more categories than fit, label every Nth so labels never overlap.
    const minSlot = fontSize * 3;
    const stride = Math.max(1, Math.ceil(minSlot / Math.max(1, band.step)));
    for (let i = 0; i < band.count; i += stride) {
      const label = data.category[i];
      if (label === undefined) continue;
      ctx.fillText(
        label,
        band.center(i),
        plot.y + plot.height + TICK_MARK_LENGTH + TICK_LABEL_GAP,
      );
    }
  }

  if ('valueAxisLabel' in spec && spec.valueAxisLabel !== undefined) {
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(spec.valueAxisLabel, geo.layout.x + geo.padding.left, plot.y - 4);
  }
  if ('categoryAxisLabel' in spec && spec.categoryAxisLabel !== undefined) {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(
      spec.categoryAxisLabel,
      plot.x + plot.width / 2,
      plot.y + plot.height + TICK_MARK_LENGTH + TICK_LABEL_GAP + fontSize + 2,
    );
  }
}

// -----------------------------------------------------------------------------
// Series marks
// -----------------------------------------------------------------------------

function drawSeries(
  ctx: ChartContext,
  spec: ChartSpec,
  data: ChartData,
  geo: ChartGeometry,
): void {
  switch (spec.kind) {
    case 'bar':
      drawGroupedBar(ctx, spec, data, geo);
      return;
    case 'stackedBar':
      drawStackedBar(ctx, spec, data, geo);
      return;
    case 'area':
      drawArea(ctx, spec, data, geo);
      return;
    case 'line':
      drawLine(ctx, spec, data, geo, spec.lineWidth ?? 2, spec.pointRadius ?? 0);
      return;
    case 'scatter':
      drawScatter(ctx, spec, data, geo);
      return;
    default:
      return;
  }
}

function drawGroupedBar(
  ctx: ChartContext,
  spec: ChartSpec,
  data: ChartData,
  geo: ChartGeometry,
): void {
  const band = geo.categoryScale;
  if (band === null) return;
  const groupPadding = spec.kind === 'bar' ? (spec.groupPadding ?? 0.1) : 0.1;
  const seriesCount = data.series.length;
  const slot = band.bandWidth / Math.max(1, seriesCount);
  const barWidth = slot * (1 - groupPadding);
  for (let s = 0; s < seriesCount; s++) {
    const series = data.series[s]!;
    ctx.fillStyle = seriesColor(spec, s);
    for (let i = 0; i < band.count; i++) {
      const value = series.value[i];
      if (value === null || value === undefined) continue;
      const x = band.start(i) + s * slot + (slot - barWidth) / 2;
      const y = geo.valueScale.scale(value);
      const top = Math.min(y, geo.baselineY);
      const height = Math.abs(y - geo.baselineY);
      ctx.fillRect(x, top, barWidth, height);
    }
  }
}

function drawStackedBar(
  ctx: ChartContext,
  spec: ChartSpec,
  data: ChartData,
  geo: ChartGeometry,
): void {
  const band = geo.categoryScale;
  if (band === null) return;
  for (let i = 0; i < band.count; i++) {
    // Positive and negative contributions stack away from the baseline in
    // opposite directions, so each category tracks two running offsets.
    let positive = 0;
    let negative = 0;
    for (let s = 0; s < data.series.length; s++) {
      const value = data.series[s]!.value[i];
      if (value === null || value === undefined) continue;
      const base = value >= 0 ? positive : negative;
      const next = base + value;
      const y0 = geo.valueScale.scale(base);
      const y1 = geo.valueScale.scale(next);
      ctx.fillStyle = seriesColor(spec, s);
      ctx.fillRect(band.start(i), Math.min(y0, y1), band.bandWidth, Math.abs(y1 - y0));
      if (value >= 0) positive = next;
      else negative = next;
    }
  }
}

function drawArea(
  ctx: ChartContext,
  spec: ChartSpec,
  data: ChartData,
  geo: ChartGeometry,
): void {
  const band = geo.categoryScale;
  if (band === null) return;
  const fillAlpha = spec.kind === 'area' ? (spec.fillAlpha ?? 0.25) : 0.25;
  for (let s = 0; s < data.series.length; s++) {
    const series = data.series[s]!;
    const color = seriesColor(spec, s);
    // A null hole splits the area into independent filled runs rather than
    // bridging the gap, which would invent data the user does not have.
    for (const run of contiguousRun(series.value)) {
      ctx.globalAlpha = fillAlpha;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(band.center(run[0]!), geo.baselineY);
      for (const i of run) {
        ctx.lineTo(band.center(i), geo.valueScale.scale(series.value[i]!));
      }
      ctx.lineTo(band.center(run[run.length - 1]!), geo.baselineY);
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  }
  drawLine(ctx, spec, data, geo, spec.kind === 'area' ? (spec.lineWidth ?? 2) : 2, 0);
}

function drawLine(
  ctx: ChartContext,
  spec: ChartSpec,
  data: ChartData,
  geo: ChartGeometry,
  lineWidth: number,
  pointRadius: number,
): void {
  const band = geo.categoryScale;
  if (band === null) return;
  ctx.lineWidth = lineWidth;
  for (let s = 0; s < data.series.length; s++) {
    const series = data.series[s]!;
    ctx.strokeStyle = seriesColor(spec, s);
    for (const run of contiguousRun(series.value)) {
      ctx.beginPath();
      for (let k = 0; k < run.length; k++) {
        const i = run[k]!;
        const x = band.center(i);
        const y = geo.valueScale.scale(series.value[i]!);
        if (k === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    if (pointRadius > 0) {
      ctx.fillStyle = seriesColor(spec, s);
      for (let i = 0; i < series.value.length; i++) {
        const value = series.value[i];
        if (value === null || value === undefined) continue;
        ctx.beginPath();
        ctx.arc(band.center(i), geo.valueScale.scale(value), pointRadius, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
}

function drawScatter(
  ctx: ChartContext,
  spec: ChartSpec,
  data: ChartData,
  geo: ChartGeometry,
): void {
  const band = geo.categoryScale;
  if (band === null) return;
  const radius = spec.kind === 'scatter' ? (spec.pointRadius ?? 3) : 3;
  for (let s = 0; s < data.series.length; s++) {
    const series = data.series[s]!;
    ctx.fillStyle = seriesColor(spec, s);
    for (let i = 0; i < series.value.length; i++) {
      const value = series.value[i];
      if (value === null || value === undefined) continue;
      ctx.beginPath();
      ctx.arc(band.center(i), geo.valueScale.scale(value), radius, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function drawRadial(
  ctx: ChartContext,
  spec: ChartSpec,
  geo: ChartGeometry,
  textColor: string,
  fontSize: number,
): void {
  if (geo.center === null || geo.outerRadius <= 0) return;
  const { x: cx, y: cy } = geo.center;
  for (const slice of geo.slice) {
    ctx.fillStyle = slice.color;
    ctx.beginPath();
    if (geo.innerRadius > 0) {
      // Donut: outer arc forward, inner arc back, joined into one ring wedge.
      ctx.arc(cx, cy, geo.outerRadius, slice.startAngle, slice.endAngle);
      ctx.arc(cx, cy, geo.innerRadius, slice.endAngle, slice.startAngle, true);
    } else {
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, geo.outerRadius, slice.startAngle, slice.endAngle);
    }
    ctx.closePath();
    ctx.fill();
  }
  // Label slices wide enough to hold text — under ~18 degrees the label
  // collides with its neighbours and the legend carries it instead.
  ctx.fillStyle = textColor;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const labelRadius = geo.innerRadius > 0
    ? (geo.innerRadius + geo.outerRadius) / 2
    : geo.outerRadius * 0.65;
  for (const slice of geo.slice) {
    if (slice.endAngle - slice.startAngle < 0.31) continue;
    const mid = (slice.startAngle + slice.endAngle) / 2;
    ctx.fillText(
      slice.label,
      cx + Math.cos(mid) * labelRadius,
      cy + Math.sin(mid) * labelRadius + fontSize * 0.05,
    );
  }
}

function drawLegend(
  ctx: ChartContext,
  spec: ChartSpec,
  data: ChartData,
  geo: ChartGeometry,
  textColor: string,
  measure: ((text: string, font: string) => number) | undefined,
  font: string,
  fontSize: number,
): void {
  const box = geo.legend;
  if (box === null) return;
  // Pie and donut legend per SLICE, everything else per SERIES — the thing
  // the colours actually distinguish differs between the two families.
  const entry = isRadialKind(spec.kind)
    ? geo.slice.map((s) => ({ label: s.label, color: s.color }))
    : data.series.map((s, i) => ({ label: s.label, color: seriesColor(spec, i) }));
  let x = box.x;
  const y = box.y + box.height / 2;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  for (const item of entry) {
    const textWidth = measure ? measure(item.label, font) : item.label.length * fontSize * 0.6;
    const itemWidth = LEGEND_SWATCH + 4 + textWidth + LEGEND_GAP;
    if (x + itemWidth > box.x + box.width && x > box.x) return;
    ctx.fillStyle = item.color;
    ctx.fillRect(x, y - LEGEND_SWATCH / 2, LEGEND_SWATCH, LEGEND_SWATCH);
    ctx.fillStyle = textColor;
    ctx.fillText(item.label, x + LEGEND_SWATCH + 4, y);
    x += itemWidth;
  }
}

/**
 * Split a value array into runs of consecutive non-null indices. Used by line
 * and area so a null hole becomes a visible break rather than a straight
 * segment across missing data.
 */
function contiguousRun(value: ReadonlyArray<number | null>): number[][] {
  const run: number[][] = [];
  let current: number[] = [];
  for (let i = 0; i < value.length; i++) {
    if (value[i] === null || value[i] === undefined) {
      if (current.length > 0) run.push(current);
      current = [];
    } else {
      current.push(i);
    }
  }
  if (current.length > 0) run.push(current);
  return run;
}

/**
 * Whether this kind draws bars — exported because adopters building a chart
 * type picker need the same grouping the renderer uses.
 * @public
 */
export function isBarChartKind(kind: ChartSpec['kind']): boolean {
  return isBarKind(kind);
}
