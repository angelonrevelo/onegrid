# @onegrid/chart

Range charts for oneGrid. Select a rectangle of cells; get a chart bound to that
selection that re-derives and repaints as the selection moves.

This is the full-size sibling of [`@onegrid/sparklines`](../sparklines): the same
Canvas2D drawing idiom and the same narrow structural-context trick, scaled up to
axes, gridlines, legends and seven chart kinds.

## Why it exists

Every spreadsheet-shaped product eventually needs "chart this selection", and
every charting library available assumes it owns a DOM node, a data format and a
render loop. oneGrid owns all three already. This package supplies only the
pieces the grid does not have: figuring out what a rectangle of cells *means* as
a dataset, and painting it onto a canvas the grid already manages.

- **Zero runtime dependencies.** The two workspace deps are type-only.
- **No DOM.** Everything is pure functions over a structural Canvas2D subset, so
  it runs in a worker, in OffscreenCanvas, or against a recording test double.
- **The grid is injected, not imported.** `bindRangeChart` asks for `getRange`,
  `getTable` and `onRangeChange`. A real `Grid`, a headless table or a test
  double all satisfy it.

## Install

```sh
pnpm add @onegrid/chart
```

## Usage

```ts
import {
  bindRangeChart,
  normalizeSelection,
  type ChartSpec,
} from '@onegrid/chart';

const spec: ChartSpec = {
  kind: 'bar',
  title: 'Revenue by region',
  tickCount: 5,
  legend: true,
};

const canvas = document.querySelector('canvas')!;
const ctx = canvas.getContext('2d')!;

const binding = bindRangeChart({
  spec,
  layout: { x: 0, y: 0, width: canvas.width, height: canvas.height },
  ctx,
  getTable: () => table,                                  // your ColumnTable
  getRange: () => normalizeSelection(grid.getSelection()), // core SelectionSnapshot
  onRangeChange: (listener) => grid.on('selectionChange', listener),
});

canvas.addEventListener('mousemove', (event) => {
  const rect = canvas.getBoundingClientRect();
  const hit = binding.hitTest(event.clientX - rect.left, event.clientY - rect.top);
  tooltip.textContent = hit ? `${hit.category}: ${hit.value}` : '';
});

// Switch chart kind without touching the grid:
binding.setSpec({ ...spec, kind: 'line' });

// On teardown:
binding.dispose();
```

### One-shot, no controller

```ts
import { deriveChartData, renderChart, hitTestChart } from '@onegrid/chart';

const data = deriveChartData(table, { rowStart: 0, rowEnd: 11, colStart: 0, colEnd: 3 });
const geometry = renderChart(ctx, { kind: 'stackedBar' }, data, { x: 0, y: 0, width: 640, height: 360 });
const hit = hitTestChart({ kind: 'stackedBar' }, data, geometry.layout, x, y, geometry);
```

## How the selection is interpreted

`deriveChartData` classifies each column **by its values in the selected rows**,
not by its declared schema type:

1. A column is a **series** when at least half its non-null cells parse as a
   finite number. Cells that do not parse become null holes.
2. The **category axis** is the first non-numeric column in the range. If every
   column is numeric there is no label column, so the categories are the source
   row indices — which is what Excel does.
3. Everything else numeric becomes a series, in range order.

Both choices can be overridden with `categoryColumnId` / `seriesColumnId`.

Booleans and dates deliberately do **not** coerce to numbers: a boolean charted
as 1/0 is almost never what the user meant, and an epoch-millisecond axis is
unreadable. Both stay available as category labels.

A null cell is a **hole**, never a zero. It breaks a line, skips a bar, and
splits an area into independent filled runs.

## Chart kinds

`line` · `bar` · `stackedBar` · `area` · `scatter` · `pie` · `donut`

`ChartSpec` is a discriminated union on `kind`, so a `pie` spec carrying
`tickCount` is a type error rather than a silently ignored field.

## Axes

Value-axis ticks come from a real nice-numbers pass (Heckbert, *Graphics Gems*
1990): the raw step is rounded to the nearest 1, 2, 5 or 10 times a power of ten,
and tick values are snapped back to the step's decimal precision. Dividing the
extent into N equal parts produces axes labelled `0 / 13.7 / 27.4`, which is a
bug, and the scale layer is the cheapest place to prevent it.

`linearScale`, `bandScale` and `niceDomain` are exported for adopters building
their own marks on top of the same geometry.

## Layout

`computeChartGeometry(spec, data, layout, measure?)` derives every coordinate
once, and both `renderChart` and `hitTestChart` read it — so a tooltip can never
point at the wrong bar. The plot box is the layout box inset by padding, then by
whatever the chart actually needs: a title row, an axis caption, the widest tick
label plus its tick mark, a category-label row and a legend strip.

Text width is injected. A real canvas context supplies `measureText`; headless
callers get a per-character estimate that is close enough for gutter arithmetic.

## License

MIT
