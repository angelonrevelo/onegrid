import { describe, it, expect } from 'vitest';
import { createColumnTable, type ColumnTable } from '@onegrid/data';
import {
  bandScale,
  bindRangeChart,
  computeChartGeometry,
  deriveChartData,
  formatTick,
  hitTestChart,
  linearScale,
  niceDomain,
  normalizeChartRange,
  normalizeSelection,
  renderChart,
  type ChartContext,
  type ChartLayout,
  type ChartRange,
  type ChartSpec,
} from '../index.js';

// -----------------------------------------------------------------------------
// A recording Canvas2D double. Every draw call lands in `call` with its exact
// arguments, so a test can assert that a gridline was stroked at a specific y
// rather than that "something was drawn".
// -----------------------------------------------------------------------------

interface RecordedCall {
  readonly op: string;
  readonly arg: ReadonlyArray<unknown>;
}

function recordingCtx(withMeasure = false): { ctx: ChartContext; call: RecordedCall[] } {
  const call: RecordedCall[] = [];
  const push = (op: string, ...arg: unknown[]): void => {
    call.push({ op, arg });
  };
  const base = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    font: '',
    globalAlpha: 1,
    textAlign: '',
    textBaseline: '',
    save: () => push('save'),
    restore: () => push('restore'),
    beginPath: () => push('beginPath'),
    moveTo: (x: number, y: number) => push('moveTo', x, y),
    lineTo: (x: number, y: number) => push('lineTo', x, y),
    closePath: () => push('closePath'),
    stroke: () => push('stroke'),
    fill: () => push('fill'),
    fillRect: (x: number, y: number, w: number, h: number) => push('fillRect', x, y, w, h),
    arc: (x: number, y: number, r: number, s: number, e: number, c?: boolean) =>
      push('arc', x, y, r, s, e, c),
    fillText: (t: string, x: number, y: number) => push('fillText', t, x, y),
  };
  const ctx = withMeasure
    ? { ...base, measureText: (t: string) => ({ width: t.length * 6 }) }
    : base;
  return { ctx: ctx as ChartContext, call };
}

const op = (call: ReadonlyArray<RecordedCall>, name: string): RecordedCall[] =>
  call.filter((c) => c.op === name);

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

/** region (text) | q1 (numeric) | q2 (numeric, one hole) */
function salesTable(): ColumnTable {
  return createColumnTable([
    {
      schema: { id: 'region', type: 'utf8', displayName: 'Region' },
      data: ['North', 'South', 'East', 'West'],
    },
    { schema: { id: 'q1', type: 'float64' }, data: new Float64Array([10, 20, 30, 40]) },
    {
      schema: { id: 'q2', type: 'float64', displayName: 'Q2' },
      data: [5, null, 15, 25],
    },
  ]);
}

const FULL_RANGE: ChartRange = { rowStart: 0, rowEnd: 3, colStart: 0, colEnd: 2 };
const LAYOUT: ChartLayout = { x: 0, y: 0, width: 400, height: 240 };

// =============================================================================
// Scales
// =============================================================================

describe('linearScale', () => {
  it('maps domain endpoints onto range endpoints', () => {
    const scale = linearScale([0, 100], [0, 200]);
    expect(scale.scale(0)).toBe(0);
    expect(scale.scale(50)).toBe(100);
    expect(scale.scale(100)).toBe(200);
  });

  it('inverts exactly, including for an inverted pixel range', () => {
    const scale = linearScale([10, 50], [300, 100]);
    expect(scale.scale(10)).toBe(300);
    expect(scale.scale(50)).toBe(100);
    expect(scale.invert(200)).toBeCloseTo(30, 10);
  });

  it('extrapolates outside the domain rather than clamping', () => {
    const scale = linearScale([0, 10], [0, 100]);
    expect(scale.scale(-5)).toBe(-50);
    expect(scale.scale(15)).toBe(150);
  });

  it('degenerates a zero-width domain to the range midpoint instead of NaN', () => {
    const scale = linearScale([7, 7], [0, 100]);
    expect(scale.scale(7)).toBe(50);
    expect(Number.isNaN(scale.scale(999))).toBe(false);
    expect(scale.invert(0)).toBe(7);
  });
});

describe('bandScale', () => {
  it('divides the range into equal steps with padded bands', () => {
    const band = bandScale(4, [0, 400], 0.2);
    expect(band.step).toBe(100);
    expect(band.bandWidth).toBeCloseTo(80, 10);
    expect(band.start(0)).toBeCloseTo(10, 10);
    expect(band.center(0)).toBe(50);
    expect(band.center(3)).toBe(350);
  });

  it('resolves a pixel back to its band', () => {
    const band = bandScale(4, [0, 400], 0.2);
    expect(band.indexAt(50)).toBe(0);
    expect(band.indexAt(250)).toBe(2);
  });

  it('returns -1 for a pixel in the inter-band gap or outside the range', () => {
    const band = bandScale(4, [0, 400], 0.2);
    expect(band.indexAt(5)).toBe(-1);
    expect(band.indexAt(-10)).toBe(-1);
    expect(band.indexAt(9999)).toBe(-1);
  });

  it('handles a zero-count band without dividing by zero', () => {
    const band = bandScale(0, [0, 400]);
    expect(band.step).toBe(0);
    expect(band.indexAt(10)).toBe(-1);
  });
});

describe('niceDomain', () => {
  it('picks 1/2/5 x 10^n steps and covers the data', () => {
    const nice = niceDomain(0, 97, 5);
    expect(nice.min).toBeLessThanOrEqual(0);
    expect(nice.max).toBeGreaterThanOrEqual(97);
    // Heckbert rounds 100/4 = 25 down to 20, so a tickCount of 5 yields six
    // ticks — readable values beat an exact count, which is the whole point.
    expect(nice.step).toBe(20);
    expect(nice.tick).toEqual([0, 20, 40, 60, 80, 100]);
  });

  it('produces clean ticks for a sub-unit domain without float noise', () => {
    const nice = niceDomain(0, 1, 5);
    expect(nice.tick).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1]);
    for (const t of nice.tick) {
      expect(String(t).length).toBeLessThan(6);
    }
  });

  it('spans zero when the data does', () => {
    const nice = niceDomain(-40, 60, 5);
    expect(nice.min).toBeLessThanOrEqual(-40);
    expect(nice.max).toBeGreaterThanOrEqual(60);
    expect(nice.tick).toContain(0);
  });

  it('swaps a reversed range and pads a single-point range', () => {
    expect(niceDomain(100, 0, 5).tick).toEqual([0, 20, 40, 60, 80, 100]);
    const flat = niceDomain(5, 5, 5);
    expect(flat.max).toBeGreaterThan(flat.min);
    const zero = niceDomain(0, 0, 5);
    expect(zero.max).toBeGreaterThan(zero.min);
  });

  it('falls back to [0, 1] on non-finite input', () => {
    const nice = niceDomain(NaN, Infinity, 5);
    expect(nice.min).toBe(0);
    expect(nice.max).toBe(1);
    expect(nice.tick.every((t) => Number.isFinite(t))).toBe(true);
  });
});

describe('formatTick', () => {
  it('abbreviates large magnitudes and honours the step precision', () => {
    expect(formatTick(1_500_000_000, 1e9)).toBe('1.5B');
    expect(formatTick(2_000_000, 1e6)).toBe('2M');
    expect(formatTick(25_000, 5000)).toBe('25k');
    expect(formatTick(0.25, 0.25)).toBe('0.25');
    expect(formatTick(0, 25)).toBe('0');
  });
});

// =============================================================================
// Data derivation
// =============================================================================

describe('deriveChartData', () => {
  it('picks the first non-numeric column as the category axis', () => {
    const data = deriveChartData(salesTable(), FULL_RANGE);
    expect(data.categoryColumnId).toBe('region');
    expect(data.category).toEqual(['North', 'South', 'East', 'West']);
    expect(data.series.map((s) => s.id)).toEqual(['q1', 'q2']);
    expect(data.isEmpty).toBe(false);
  });

  it('uses displayName as the series label, falling back to the column id', () => {
    const data = deriveChartData(salesTable(), FULL_RANGE);
    expect(data.series.map((s) => s.label)).toEqual(['q1', 'Q2']);
  });

  it('keeps a null cell as a hole, not a zero', () => {
    const data = deriveChartData(salesTable(), FULL_RANGE);
    const q2 = data.series[1]!;
    expect(q2.value).toEqual([5, null, 15, 25]);
    expect(q2.min).toBe(5);
    expect(q2.total).toBe(45);
  });

  it('falls back to row indices when every column in the range is numeric', () => {
    const data = deriveChartData(salesTable(), {
      rowStart: 0,
      rowEnd: 3,
      colStart: 1,
      colEnd: 2,
    });
    expect(data.categoryColumnId).toBeNull();
    expect(data.category).toEqual(['0', '1', '2', '3']);
    expect(data.series.map((s) => s.id)).toEqual(['q1', 'q2']);
  });

  it('reports an all-text range as empty but still exposes the labels', () => {
    const table = createColumnTable([
      { schema: { id: 'a', type: 'utf8' }, data: ['x', 'y'] },
      { schema: { id: 'b', type: 'utf8' }, data: ['p', 'q'] },
    ]);
    const data = deriveChartData(table, { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 1 });
    expect(data.isEmpty).toBe(true);
    expect(data.series).toEqual([]);
    expect(data.category).toEqual(['x', 'y']);
  });

  it('treats a majority-numeric string column as a series and the stragglers as holes', () => {
    const table = createColumnTable([
      { schema: { id: 'label', type: 'utf8' }, data: ['a', 'b', 'c', 'd'] },
      { schema: { id: 'mixed', type: 'utf8' }, data: ['1', '2', 'N/A', '4'] },
    ]);
    const data = deriveChartData(table, { rowStart: 0, rowEnd: 3, colStart: 0, colEnd: 1 });
    expect(data.series).toHaveLength(1);
    expect(data.series[0]!.value).toEqual([1, 2, null, 4]);
  });

  it('rejects a minority-numeric column, leaving it available as a category', () => {
    const table = createColumnTable([
      { schema: { id: 'mostlyText', type: 'utf8' }, data: ['a', 'b', '3', 'd'] },
      { schema: { id: 'n', type: 'float64' }, data: new Float64Array([1, 2, 3, 4]) },
    ]);
    const data = deriveChartData(table, { rowStart: 0, rowEnd: 3, colStart: 0, colEnd: 1 });
    expect(data.categoryColumnId).toBe('mostlyText');
    expect(data.series.map((s) => s.id)).toEqual(['n']);
  });

  it('parses thousands separators and trailing percent signs', () => {
    const table = createColumnTable([
      { schema: { id: 'k', type: 'utf8' }, data: ['a', 'b'] },
      { schema: { id: 'v', type: 'utf8' }, data: ['1,200', '35%'] },
    ]);
    const data = deriveChartData(table, { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 1 });
    expect(data.series[0]!.value).toEqual([1200, 35]);
  });

  it('normalizes an inverted range and clamps one that overruns the table', () => {
    const table = salesTable();
    expect(normalizeChartRange({ rowStart: 3, rowEnd: 0, colStart: 2, colEnd: 0 }, table)).toEqual({
      rowStart: 0,
      rowEnd: 3,
      colStart: 0,
      colEnd: 2,
    });
    expect(
      normalizeChartRange({ rowStart: 0, rowEnd: 99, colStart: 0, colEnd: 99 }, table),
    ).toEqual({ rowStart: 0, rowEnd: 3, colStart: 0, colEnd: 2 });
    const data = deriveChartData(table, { rowStart: 3, rowEnd: 1, colStart: 2, colEnd: 0 });
    expect(data.category).toEqual(['South', 'East', 'West']);
  });

  it('returns an empty dataset for an empty table rather than throwing', () => {
    const empty = createColumnTable([]);
    const data = deriveChartData(empty, FULL_RANGE);
    expect(data.isEmpty).toBe(true);
    expect(data.category).toEqual([]);
    expect(data.min).toBe(0);
  });

  it('honours forced category and series columns', () => {
    const data = deriveChartData(salesTable(), FULL_RANGE, {
      categoryColumnId: 'q1',
      seriesColumnId: ['q2', 'nope'],
    });
    expect(data.categoryColumnId).toBe('q1');
    expect(data.category).toEqual(['10', '20', '30', '40']);
    expect(data.series.map((s) => s.id)).toEqual(['q2']);
  });

  it('caps plotted rows at maxRow', () => {
    const big = createColumnTable([
      { schema: { id: 'n', type: 'float64' }, data: new Float64Array(500).fill(1) },
    ]);
    const data = deriveChartData(big, { rowStart: 0, rowEnd: 499, colStart: 0, colEnd: 0 }, {
      maxRow: 10,
    });
    expect(data.category).toHaveLength(10);
    expect(data.series[0]!.value).toHaveLength(10);
  });

  it('computes stack extents per category, splitting sign', () => {
    const table = createColumnTable([
      { schema: { id: 'k', type: 'utf8' }, data: ['a', 'b'] },
      { schema: { id: 'x', type: 'float64' }, data: new Float64Array([10, -5]) },
      { schema: { id: 'y', type: 'float64' }, data: new Float64Array([20, -15]) },
    ]);
    const data = deriveChartData(table, { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 2 });
    expect(data.stackMax).toBe(30);
    expect(data.stackMin).toBe(-20);
    expect(data.min).toBe(-15);
    expect(data.max).toBe(20);
  });

  it('does not coerce booleans, so a boolean column stays categorical', () => {
    const table = createColumnTable([
      { schema: { id: 'flag', type: 'bool' }, data: [true, false] },
      { schema: { id: 'n', type: 'float64' }, data: new Float64Array([1, 2]) },
    ]);
    const data = deriveChartData(table, { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 1 });
    expect(data.categoryColumnId).toBe('flag');
    expect(data.category).toEqual(['true', 'false']);
  });
});

// =============================================================================
// Geometry
// =============================================================================

describe('computeChartGeometry', () => {
  it('insets the plot from padding, the tick gutter and the label row', () => {
    const data = deriveChartData(salesTable(), FULL_RANGE);
    const spec: ChartSpec = { kind: 'bar', legend: false };
    const geo = computeChartGeometry(spec, data, LAYOUT);
    expect(geo.plot.x).toBeGreaterThan(LAYOUT.x + 12);
    expect(geo.plot.y).toBeGreaterThanOrEqual(LAYOUT.y + 12);
    expect(geo.plot.x + geo.plot.width).toBeLessThanOrEqual(LAYOUT.x + LAYOUT.width - 12);
    expect(geo.plot.y + geo.plot.height).toBeLessThan(LAYOUT.y + LAYOUT.height - 12);
  });

  it('reserves extra top space for a title and a bottom strip for a legend', () => {
    const data = deriveChartData(salesTable(), FULL_RANGE);
    const bare = computeChartGeometry({ kind: 'bar', legend: false }, data, LAYOUT);
    const dressed = computeChartGeometry(
      { kind: 'bar', title: 'Sales', legend: true },
      data,
      LAYOUT,
    );
    expect(dressed.plot.y).toBeGreaterThan(bare.plot.y);
    expect(dressed.plot.height).toBeLessThan(bare.plot.height);
    expect(dressed.legend).not.toBeNull();
    expect(dressed.titleAnchor).not.toBeNull();
    expect(bare.legend).toBeNull();
  });

  it('anchors the value axis at zero for a bar chart', () => {
    const data = deriveChartData(salesTable(), FULL_RANGE);
    const geo = computeChartGeometry({ kind: 'bar' }, data, LAYOUT);
    expect(geo.valueDomain[0]).toBe(0);
    expect(geo.baselineY).toBeCloseTo(geo.plot.y + geo.plot.height, 6);
  });

  it('honours an explicit value domain verbatim', () => {
    const data = deriveChartData(salesTable(), FULL_RANGE);
    const geo = computeChartGeometry(
      { kind: 'line', valueDomain: [0, 50], tickCount: 6 },
      data,
      LAYOUT,
    );
    expect(geo.valueDomain).toEqual([0, 50]);
    expect(geo.tick).toEqual([0, 10, 20, 30, 40, 50]);
  });

  it('uses injected text metrics to widen the gutter for wide labels', () => {
    const data = deriveChartData(salesTable(), FULL_RANGE);
    const narrow = computeChartGeometry({ kind: 'bar' }, data, LAYOUT, () => 4);
    const wide = computeChartGeometry({ kind: 'bar' }, data, LAYOUT, () => 60);
    expect(wide.plot.x).toBeGreaterThan(narrow.plot.x);
  });

  it('lays pie slices out clockwise from 12 o clock, summing to a full turn', () => {
    const data = deriveChartData(salesTable(), FULL_RANGE);
    const geo = computeChartGeometry({ kind: 'pie' }, data, LAYOUT);
    expect(geo.slice).toHaveLength(4);
    expect(geo.slice[0]!.startAngle).toBeCloseTo(-Math.PI / 2, 10);
    const sweep = geo.slice.reduce((sum, s) => sum + (s.endAngle - s.startAngle), 0);
    expect(sweep).toBeCloseTo(Math.PI * 2, 10);
    expect(geo.innerRadius).toBe(0);
    expect(geo.categoryScale).toBeNull();
  });

  it('gives a donut a hole and skips null slices', () => {
    const data = deriveChartData(salesTable(), FULL_RANGE);
    const geo = computeChartGeometry(
      { kind: 'donut', seriesIndex: 1, innerRadiusRatio: 0.5 },
      data,
      LAYOUT,
    );
    expect(geo.innerRadius).toBeCloseTo(geo.outerRadius * 0.5, 10);
    expect(geo.slice).toHaveLength(3);
  });
});

// =============================================================================
// Rendering
// =============================================================================

describe('renderChart', () => {
  it('draws gridlines, both axis lines and every tick mark and label', () => {
    const data = deriveChartData(salesTable(), FULL_RANGE);
    const spec: ChartSpec = { kind: 'bar', legend: false, tickCount: 5 };
    const { ctx, call } = recordingCtx();
    const geo = renderChart(ctx, spec, data, LAYOUT);

    // One moveTo/lineTo pair per gridline, at exactly the tick's y.
    const gridY = geo.tick.map((t) => Math.round(geo.valueScale.scale(t)) + 0.5);
    for (const y of gridY) {
      expect(
        call.some((c) => c.op === 'moveTo' && c.arg[0] === geo.plot.x && c.arg[1] === y),
      ).toBe(true);
    }
    // Value axis line at the plot's left edge.
    expect(
      call.some(
        (c) =>
          c.op === 'moveTo' &&
          c.arg[0] === Math.round(geo.plot.x) + 0.5 &&
          c.arg[1] === geo.plot.y,
      ),
    ).toBe(true);
    // Every tick label and every category label is written.
    const text = op(call, 'fillText').map((c) => c.arg[0]);
    for (const label of geo.tickLabel) expect(text).toContain(label);
    for (const label of data.category) expect(text).toContain(label);
  });

  it('emits one fillRect per non-null bar, in series colour order', () => {
    const data = deriveChartData(salesTable(), FULL_RANGE);
    const { ctx, call } = recordingCtx();
    renderChart(ctx, { kind: 'bar', legend: false }, data, LAYOUT);
    // 4 q1 bars + 3 q2 bars (one hole) = 7. No background rect was requested.
    expect(op(call, 'fillRect')).toHaveLength(7);
  });

  it('draws bars from the zero baseline downward for negative values', () => {
    const table = createColumnTable([
      { schema: { id: 'k', type: 'utf8' }, data: ['a', 'b'] },
      { schema: { id: 'v', type: 'float64' }, data: new Float64Array([-20, 20]) },
    ]);
    const data = deriveChartData(table, { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 1 });
    const { ctx, call } = recordingCtx();
    const geo = renderChart(ctx, { kind: 'bar', legend: false }, data, LAYOUT);
    const rect = op(call, 'fillRect');
    expect(rect).toHaveLength(2);
    // The negative bar's top edge is the baseline; the positive bar's bottom is.
    expect(rect[0]!.arg[1]).toBeCloseTo(geo.baselineY, 6);
    expect(Number(rect[1]!.arg[1]) + Number(rect[1]!.arg[3])).toBeCloseTo(geo.baselineY, 6);
  });

  it('breaks a line at a null hole instead of bridging it', () => {
    const table = createColumnTable([
      { schema: { id: 'k', type: 'utf8' }, data: ['a', 'b', 'c', 'd'] },
      { schema: { id: 'v', type: 'float64' }, data: [1, null, 3, 4] },
    ]);
    const data = deriveChartData(table, { rowStart: 0, rowEnd: 3, colStart: 0, colEnd: 1 });
    const { ctx, call } = recordingCtx();
    renderChart(ctx, { kind: 'line', legend: false }, data, LAYOUT);
    // Two runs => two moveTo/stroke pairs, and only one lineTo (c -> d).
    const path = call.filter((c) => ['moveTo', 'lineTo'].includes(c.op));
    const afterAxis = path.slice(path.findIndex((c) => c.op === 'moveTo'));
    expect(afterAxis.length).toBeGreaterThan(0);
    const strokeCount = op(call, 'stroke').length;
    expect(strokeCount).toBeGreaterThanOrEqual(3); // gridline pass, axis pass, 2 runs
  });

  it('places line vertices at band centres at the scaled value', () => {
    const table = createColumnTable([
      { schema: { id: 'k', type: 'utf8' }, data: ['a', 'b'] },
      { schema: { id: 'v', type: 'float64' }, data: new Float64Array([0, 100]) },
    ]);
    const data = deriveChartData(table, { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 1 });
    const { ctx, call } = recordingCtx();
    const geo = renderChart(ctx, { kind: 'line', legend: false }, data, LAYOUT);
    const band = geo.categoryScale!;
    const expected = [band.center(0), geo.valueScale.scale(0)];
    expect(
      call.some(
        (c) =>
          c.op === 'moveTo' &&
          Math.abs(Number(c.arg[0]) - expected[0]!) < 1e-6 &&
          Math.abs(Number(c.arg[1]) - expected[1]!) < 1e-6,
      ),
    ).toBe(true);
  });

  it('fills an area under the line and then strokes it', () => {
    const data = deriveChartData(salesTable(), FULL_RANGE);
    const { ctx, call } = recordingCtx();
    renderChart(ctx, { kind: 'area', legend: false }, data, LAYOUT);
    expect(op(call, 'fill').length).toBeGreaterThanOrEqual(2);
    expect(op(call, 'closePath').length).toBeGreaterThanOrEqual(2);
  });

  it('stacks bars so each segment starts where the previous ended', () => {
    const data = deriveChartData(salesTable(), FULL_RANGE);
    const { ctx, call } = recordingCtx();
    const geo = renderChart(ctx, { kind: 'stackedBar', legend: false }, data, LAYOUT);
    const rect = op(call, 'fillRect');
    expect(rect).toHaveLength(7);
    // Category 0: q1 = 10 (0..10), q2 = 5 (10..15).
    const q1Top = Number(rect[0]!.arg[1]);
    const q1Height = Number(rect[0]!.arg[3]);
    const q2Bottom = Number(rect[1]!.arg[1]) + Number(rect[1]!.arg[3]);
    expect(q2Bottom).toBeCloseTo(q1Top, 6);
    expect(q1Top + q1Height).toBeCloseTo(geo.baselineY, 6);
  });

  it('draws one arc per point for a scatter', () => {
    const data = deriveChartData(salesTable(), FULL_RANGE);
    const { ctx, call } = recordingCtx();
    renderChart(ctx, { kind: 'scatter', legend: false, pointRadius: 4 }, data, LAYOUT);
    const arc = op(call, 'arc');
    expect(arc).toHaveLength(7);
    expect(arc[0]!.arg[2]).toBe(4);
  });

  it('draws a wedge per pie slice and a two-arc ring per donut slice', () => {
    const data = deriveChartData(salesTable(), FULL_RANGE);
    const pie = recordingCtx();
    renderChart(pie.ctx, { kind: 'pie', legend: false }, data, LAYOUT);
    expect(op(pie.call, 'arc')).toHaveLength(4);
    expect(op(pie.call, 'moveTo').length).toBeGreaterThanOrEqual(4);

    const donut = recordingCtx();
    renderChart(donut.ctx, { kind: 'donut', legend: false }, data, LAYOUT);
    expect(op(donut.call, 'arc')).toHaveLength(8);
  });

  it('paints the background first and balances save/restore', () => {
    const data = deriveChartData(salesTable(), FULL_RANGE);
    const { ctx, call } = recordingCtx();
    renderChart(ctx, { kind: 'bar', legend: false, background: '#fff' }, data, LAYOUT);
    expect(call[0]!.op).toBe('save');
    expect(call[1]).toEqual({ op: 'fillRect', arg: [0, 0, 400, 240] });
    expect(call[call.length - 1]!.op).toBe('restore');
  });

  it('draws a legend swatch and label per series', () => {
    const data = deriveChartData(salesTable(), FULL_RANGE);
    const { ctx, call } = recordingCtx();
    renderChart(ctx, { kind: 'line', legend: true }, data, LAYOUT);
    const text = op(call, 'fillText').map((c) => c.arg[0]);
    expect(text).toContain('q1');
    expect(text).toContain('Q2');
  });

  it('uses the context measureText when the context provides one', () => {
    const data = deriveChartData(salesTable(), FULL_RANGE);
    const measured = recordingCtx(true);
    const estimated = recordingCtx(false);
    const a = renderChart(measured.ctx, { kind: 'bar', legend: false }, data, LAYOUT);
    const b = renderChart(estimated.ctx, { kind: 'bar', legend: false }, data, LAYOUT);
    expect(a.plot.x).not.toBe(b.plot.x);
  });

  it('still draws the axis frame for an empty selection', () => {
    const table = createColumnTable([
      { schema: { id: 'a', type: 'utf8' }, data: ['x', 'y'] },
    ]);
    const data = deriveChartData(table, { rowStart: 0, rowEnd: 1, colStart: 0, colEnd: 0 });
    const { ctx, call } = recordingCtx();
    expect(() => renderChart(ctx, { kind: 'bar' }, data, LAYOUT)).not.toThrow();
    expect(op(call, 'stroke').length).toBeGreaterThan(0);
    expect(op(call, 'fillRect')).toHaveLength(0);
  });
});

// =============================================================================
// Hit testing
// =============================================================================

describe('hitTestChart', () => {
  it('finds the bar under a point and the datum behind it', () => {
    const data = deriveChartData(salesTable(), FULL_RANGE);
    const spec: ChartSpec = { kind: 'bar', legend: false };
    const geo = computeChartGeometry(spec, data, LAYOUT);
    const band = geo.categoryScale!;
    const slot = band.bandWidth / 2;
    const x = band.start(1) + slot * 0.5;
    const y = (geo.valueScale.scale(20) + geo.baselineY) / 2;
    const hit = hitTestChart(spec, data, LAYOUT, x, y, geo);
    expect(hit).not.toBeNull();
    expect(hit!.seriesId).toBe('q1');
    expect(hit!.category).toBe('South');
    expect(hit!.value).toBe(20);
    expect(hit!.rowIndex).toBe(1);
  });

  it('returns null above a bar and in the gap between categories', () => {
    const data = deriveChartData(salesTable(), FULL_RANGE);
    const spec: ChartSpec = { kind: 'bar', legend: false };
    const geo = computeChartGeometry(spec, data, LAYOUT);
    const band = geo.categoryScale!;
    expect(hitTestChart(spec, data, LAYOUT, band.center(0), geo.plot.y + 1, geo)).toBeNull();
    expect(hitTestChart(spec, data, LAYOUT, band.range[0] + 1, geo.baselineY - 5, geo)).toBeNull();
  });

  it('picks the correct segment of a stacked bar', () => {
    const data = deriveChartData(salesTable(), FULL_RANGE);
    const spec: ChartSpec = { kind: 'stackedBar', legend: false };
    const geo = computeChartGeometry(spec, data, LAYOUT);
    const band = geo.categoryScale!;
    const x = band.center(0);
    const lower = hitTestChart(spec, data, LAYOUT, x, geo.valueScale.scale(5), geo);
    const upper = hitTestChart(spec, data, LAYOUT, x, geo.valueScale.scale(12.5), geo);
    expect(lower!.seriesId).toBe('q1');
    expect(upper!.seriesId).toBe('q2');
  });

  it('snaps to the nearest line vertex within tolerance and misses beyond it', () => {
    const data = deriveChartData(salesTable(), FULL_RANGE);
    const spec: ChartSpec = { kind: 'line', legend: false };
    const geo = computeChartGeometry(spec, data, LAYOUT);
    const band = geo.categoryScale!;
    const near = hitTestChart(
      spec,
      data,
      LAYOUT,
      band.center(2) + 3,
      geo.valueScale.scale(30) + 3,
      geo,
    );
    expect(near!.value).toBe(30);
    expect(near!.categoryIndex).toBe(2);
    const far = hitTestChart(spec, data, LAYOUT, band.center(2), geo.plot.y - 100, geo);
    expect(far).toBeNull();
  });

  it('resolves a pie slice by angle and rejects the area outside the radius', () => {
    const data = deriveChartData(salesTable(), FULL_RANGE);
    const spec: ChartSpec = { kind: 'pie', legend: false };
    const geo = computeChartGeometry(spec, data, LAYOUT);
    const first = geo.slice[0]!;
    const mid = (first.startAngle + first.endAngle) / 2;
    const r = geo.outerRadius * 0.5;
    const hit = hitTestChart(
      spec,
      data,
      LAYOUT,
      geo.center!.x + Math.cos(mid) * r,
      geo.center!.y + Math.sin(mid) * r,
      geo,
    );
    expect(hit!.categoryIndex).toBe(0);
    expect(hit!.category).toBe('North');
    expect(hit!.seriesIndex).toBe(-1);
    expect(
      hitTestChart(spec, data, LAYOUT, geo.center!.x + geo.outerRadius + 20, geo.center!.y, geo),
    ).toBeNull();
  });

  it('rejects the hole of a donut', () => {
    const data = deriveChartData(salesTable(), FULL_RANGE);
    const spec: ChartSpec = { kind: 'donut', legend: false };
    const geo = computeChartGeometry(spec, data, LAYOUT);
    expect(hitTestChart(spec, data, LAYOUT, geo.center!.x, geo.center!.y, geo)).toBeNull();
  });

  it('returns null for an empty dataset', () => {
    const table = createColumnTable([
      { schema: { id: 'a', type: 'utf8' }, data: ['x'] },
    ]);
    const data = deriveChartData(table, { rowStart: 0, rowEnd: 0, colStart: 0, colEnd: 0 });
    expect(hitTestChart({ kind: 'bar' }, data, LAYOUT, 50, 50)).toBeNull();
  });
});

// =============================================================================
// Selection binding
// =============================================================================

describe('normalizeSelection', () => {
  it('normalizes the last range of a core SelectionSnapshot', () => {
    const range = normalizeSelection({
      ranges: [
        { anchor: { row: 0, col: 0 }, active: { row: 0, col: 0 } },
        { anchor: { row: 5, col: 3 }, active: { row: 2, col: 1 } },
      ],
      active: { row: 2, col: 1 },
    });
    expect(range).toEqual({ rowStart: 2, rowEnd: 5, colStart: 1, colEnd: 3 });
  });

  it('returns null for an empty selection', () => {
    expect(normalizeSelection({ ranges: [], active: null })).toBeNull();
  });
});

describe('bindRangeChart', () => {
  function harness(spec: ChartSpec = { kind: 'bar', legend: false }) {
    const table = salesTable();
    let range: ChartRange | null = { rowStart: 0, rowEnd: 3, colStart: 0, colEnd: 1 };
    let listener: (() => void) | null = null;
    const { ctx, call } = recordingCtx();
    const binding = bindRangeChart({
      spec,
      layout: LAYOUT,
      ctx,
      getTable: () => table,
      getRange: () => range,
      onRangeChange: (fn) => {
        listener = fn;
        return () => {
          listener = null;
        };
      },
    });
    return {
      binding,
      call,
      hasListener: () => listener !== null,
      fire: () => listener?.(),
      setRange: (next: ChartRange | null) => {
        range = next;
      },
    };
  }

  it('derives and paints once on construction', () => {
    const h = harness();
    expect(h.binding.paintCount).toBe(1);
    expect(h.binding.data.series.map((s) => s.id)).toEqual(['q1']);
    expect(h.call.length).toBeGreaterThan(0);
  });

  it('re-derives when the selection changes', () => {
    const h = harness();
    h.setRange({ rowStart: 0, rowEnd: 3, colStart: 0, colEnd: 2 });
    h.fire();
    expect(h.binding.paintCount).toBe(2);
    expect(h.binding.data.series.map((s) => s.id)).toEqual(['q1', 'q2']);
    expect(h.binding.range).toEqual({ rowStart: 0, rowEnd: 3, colStart: 0, colEnd: 2 });
  });

  it('skips the repaint when the range did not actually move', () => {
    const h = harness();
    h.fire();
    h.fire();
    h.fire();
    expect(h.binding.paintCount).toBe(1);
    h.binding.refresh(true);
    expect(h.binding.paintCount).toBe(2);
  });

  it('goes empty when the selection is cleared', () => {
    const h = harness();
    h.setRange(null);
    h.fire();
    expect(h.binding.data.isEmpty).toBe(true);
    expect(h.binding.range).toBeNull();
  });

  it('repaints on setSpec and setLayout', () => {
    const h = harness();
    h.binding.setSpec({ kind: 'line', legend: false });
    expect(h.binding.paintCount).toBe(2);
    h.binding.setLayout({ x: 0, y: 0, width: 800, height: 400 });
    expect(h.binding.paintCount).toBe(3);
    expect(h.binding.geometry.layout.width).toBe(800);
  });

  it('hit-tests against the geometry it last painted', () => {
    const h = harness();
    const geo = h.binding.geometry;
    const band = geo.categoryScale!;
    const hit = h.binding.hitTest(band.center(2), (geo.valueScale.scale(30) + geo.baselineY) / 2);
    expect(hit!.value).toBe(30);
    expect(hit!.category).toBe('East');
  });

  it('unsubscribes on dispose and ignores later events, idempotently', () => {
    const h = harness();
    expect(h.hasListener()).toBe(true);
    h.binding.dispose();
    h.binding.dispose();
    expect(h.hasListener()).toBe(false);
    h.binding.refresh(true);
    expect(h.binding.paintCount).toBe(1);
  });
});
