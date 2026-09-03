// =============================================================================
// hitTestChart — which datum is under this pixel
//
// Tooltips, click-to-drill and keyboard focus all need the inverse of the
// render pass. Rather than maintain a parallel copy of the drawing maths,
// this reads the same `ChartGeometry` the renderer read, so the two cannot
// drift.
//
// The test differs by family:
//   bar / stackedBar — exact rectangle containment. A bar chart's marks tile
//                      the plot, so "nearest" would claim empty space.
//   line/area/scatter — nearest vertex within a pixel radius. The marks are
//                      sparse, so requiring an exact hit on a 3px dot makes
//                      tooltips feel broken; a tolerance is the correct UX.
//   pie / donut      — polar containment on radius then angle.
// =============================================================================

import type { ChartData } from './derive';
import { computeChartGeometry, type ChartGeometry, type ChartLayout } from './geometry';
import { isRadialKind, type ChartSpec } from './spec';

/** @public */
export interface ChartHit {
  /** Index into `data.series`. -1 for pie/donut, whose slices are categories. */
  readonly seriesIndex: number;
  /** Series column id, or '' when the hit is a pie slice. */
  readonly seriesId: string;
  /** Index into `data.category`. */
  readonly categoryIndex: number;
  readonly category: string;
  /** Source row index in the underlying table — enough to scroll the grid to it. */
  readonly rowIndex: number;
  readonly value: number;
  /** Canvas coordinate of the mark's anchor, for positioning a tooltip. */
  readonly x: number;
  readonly y: number;
}

/** Pixel tolerance for point-based kinds. */
const POINT_TOLERANCE = 12;

/**
 * Find the datum under a canvas-space point, or null.
 *
 * Pass the geometry returned by `renderChart` to skip recomputing layout —
 * on a mousemove handler that runs at pointer rate, that matters.
 * @public
 */
export function hitTestChart(
  spec: ChartSpec,
  data: ChartData,
  layout: ChartLayout,
  x: number,
  y: number,
  geometry?: ChartGeometry,
): ChartHit | null {
  const geo = geometry ?? computeChartGeometry(spec, data, layout);
  if (isRadialKind(spec.kind)) return hitRadial(data, geo, x, y);
  if (data.isEmpty) return null;
  if (spec.kind === 'bar') return hitGroupedBar(spec, data, geo, x, y);
  if (spec.kind === 'stackedBar') return hitStackedBar(data, geo, x, y);
  return hitPoint(data, geo, x, y);
}

function makeHit(
  data: ChartData,
  seriesIndex: number,
  categoryIndex: number,
  value: number,
  x: number,
  y: number,
): ChartHit {
  return {
    seriesIndex,
    seriesId: data.series[seriesIndex]?.id ?? '',
    categoryIndex,
    category: data.category[categoryIndex] ?? '',
    rowIndex: data.rowIndex[categoryIndex] ?? -1,
    value,
    x,
    y,
  };
}

function hitGroupedBar(
  spec: ChartSpec,
  data: ChartData,
  geo: ChartGeometry,
  x: number,
  y: number,
): ChartHit | null {
  const band = geo.categoryScale;
  if (band === null) return null;
  const categoryIndex = band.indexAt(x);
  if (categoryIndex < 0) return null;
  const groupPadding = spec.kind === 'bar' ? (spec.groupPadding ?? 0.1) : 0.1;
  const seriesCount = data.series.length;
  const slot = band.bandWidth / Math.max(1, seriesCount);
  const barWidth = slot * (1 - groupPadding);
  for (let s = 0; s < seriesCount; s++) {
    const value = data.series[s]!.value[categoryIndex];
    if (value === null || value === undefined) continue;
    const barX = band.start(categoryIndex) + s * slot + (slot - barWidth) / 2;
    if (x < barX || x > barX + barWidth) continue;
    const valueY = geo.valueScale.scale(value);
    const top = Math.min(valueY, geo.baselineY);
    const height = Math.abs(valueY - geo.baselineY);
    if (y < top || y > top + height) continue;
    return makeHit(data, s, categoryIndex, value, barX + barWidth / 2, valueY);
  }
  return null;
}

function hitStackedBar(
  data: ChartData,
  geo: ChartGeometry,
  x: number,
  y: number,
): ChartHit | null {
  const band = geo.categoryScale;
  if (band === null) return null;
  const categoryIndex = band.indexAt(x);
  if (categoryIndex < 0) return null;
  let positive = 0;
  let negative = 0;
  for (let s = 0; s < data.series.length; s++) {
    const value = data.series[s]!.value[categoryIndex];
    if (value === null || value === undefined) continue;
    const base = value >= 0 ? positive : negative;
    const next = base + value;
    const y0 = geo.valueScale.scale(base);
    const y1 = geo.valueScale.scale(next);
    const top = Math.min(y0, y1);
    const height = Math.abs(y1 - y0);
    if (y >= top && y <= top + height) {
      return makeHit(data, s, categoryIndex, value, band.start(categoryIndex) + band.bandWidth / 2, y1);
    }
    if (value >= 0) positive = next;
    else negative = next;
  }
  return null;
}

function hitPoint(data: ChartData, geo: ChartGeometry, x: number, y: number): ChartHit | null {
  const band = geo.categoryScale;
  if (band === null || band.count === 0) return null;
  // Only vertices in the two bands either side of the pointer can win, so
  // scan a narrow window instead of every point in a 10k-row selection.
  const approx = band.step === 0 ? 0 : Math.floor((x - band.range[0]) / band.step);
  const from = Math.max(0, approx - 2);
  const to = Math.min(band.count - 1, approx + 2);
  let best: ChartHit | null = null;
  let bestDistance = POINT_TOLERANCE * POINT_TOLERANCE;
  for (let i = from; i <= to; i++) {
    const px = band.center(i);
    for (let s = 0; s < data.series.length; s++) {
      const value = data.series[s]!.value[i];
      if (value === null || value === undefined) continue;
      const py = geo.valueScale.scale(value);
      const dx = px - x;
      const dy = py - y;
      const distance = dx * dx + dy * dy;
      if (distance <= bestDistance) {
        bestDistance = distance;
        best = makeHit(data, s, i, value, px, py);
      }
    }
  }
  return best;
}

function hitRadial(data: ChartData, geo: ChartGeometry, x: number, y: number): ChartHit | null {
  if (geo.center === null) return null;
  const dx = x - geo.center.x;
  const dy = y - geo.center.y;
  const radius = Math.sqrt(dx * dx + dy * dy);
  if (radius > geo.outerRadius || radius < geo.innerRadius) return null;
  // Slices start at -PI/2 (12 o'clock); normalise the pointer angle into the
  // same [-PI/2, 3PI/2) turn so a comparison against startAngle works.
  let angle = Math.atan2(dy, dx);
  if (angle < -Math.PI / 2) angle += Math.PI * 2;
  for (const slice of geo.slice) {
    if (angle >= slice.startAngle && angle < slice.endAngle) {
      const mid = (slice.startAngle + slice.endAngle) / 2;
      const anchor = (geo.innerRadius + geo.outerRadius) / 2 || geo.outerRadius * 0.65;
      return {
        seriesIndex: -1,
        seriesId: '',
        categoryIndex: slice.categoryIndex,
        category: slice.label,
        rowIndex: data.rowIndex[slice.categoryIndex] ?? -1,
        value: slice.value,
        x: geo.center.x + Math.cos(mid) * anchor,
        y: geo.center.y + Math.sin(mid) * anchor,
      };
    }
  }
  return null;
}
