# @onegrid/print

Print and advanced export for oneGrid: a pagination engine, a dependency-free PDF
writer, a `@media print` stylesheet emitter, a printable-HTML emitter, and canvas
screenshot capture that tiles a grid taller than its viewport.

It is the sibling of [`@onegrid/export`](../export). That package answers *"give me
this data in another program"*; this one answers *"give me this data on paper"* —
and paper has constraints a spreadsheet does not.

## Why it exists

Printing a virtualised data grid from the browser produces one screenful of rows and
a truncated table, because the DOM only ever holds the visible window and no browser
splits a wide table horizontally. Every commercial grid charges for the fix. This is
the fix, MIT, with zero runtime dependencies.

The pagination engine is the product; every renderer is a thin layer over
`PrintPage[]`:

- **A row is atomic.** It never straddles a page break. A row taller than the whole
  printable area gets a page to itself instead of being clipped in half.
- **A table wider than the sheet splits into bands**, and every band repeats the
  **key columns**, so band 3 of a wide report is still readable.
- **Headers repeat** — the column header on every page, and a group header
  re-emitted with `continued: true` when its group crosses a break.
- **Scale is applied before packing**, so `fitWidth` / `fitPage` / `scale(n)` change
  what fits rather than shrinking the rendered result afterwards.
- **`totalPage` is correct**, resolved on a second pass, because the total is the
  product of the row-slice count and the band count and neither is known while
  packing.

## Install

```sh
pnpm add @onegrid/print
```

## Usage

```ts
import {
  paginate,
  renderPdf,
  printStylesheet,
  printHtmlDocument,
  captureTallGrid,
  type PrintColumn,
} from '@onegrid/print';

const column: PrintColumn[] = [
  { id: 'sku', header: 'SKU', width: 80, key: true },
  { id: 'name', header: 'Product', width: 220 },
  {
    id: 'revenue',
    header: 'Revenue',
    width: 100,
    numberFormat: { style: 'currency', currency: 'USD' },
    conditionalStyle: (v) => (typeof v === 'number' && v < 0 ? { color: '#cc0000' } : undefined),
  },
];

const table = [
  { sku: 'A-1', name: 'Widget', revenue: 12_400.5 },
  { sku: 'A-2', name: 'Gadget', revenue: -318 },
];

// 1. Lay the data onto paper.
const page = paginate({
  table,
  column,
  page: { size: 'A4', orientation: 'landscape', margin: 36, scaling: { mode: 'fitWidth' } },
  option: {
    rowHeight: 20,
    repeatHeader: true,
    group: [{ label: 'North region', startRow: 0, endRow: 2 }],
  },
});

console.log(page.length, page[0].totalPage, page[0].band.total);

// 2a. Emit a real PDF — no jsPDF, no pdf-lib.
const pdf = renderPdf(page, table, { title: 'Q1 revenue' });
// pdf.bytes is a Uint8Array beginning with %PDF-1.7

// 2b. Or print from the DOM, where the browser owns the paper.
document.head.append(
  Object.assign(document.createElement('style'), {
    textContent: printStylesheet({ size: 'A4', orientation: 'landscape', scope: '#grid' }),
  }),
);
window.print();

// 2c. Or produce a standalone printable document.
const html = printHtmlDocument(page, table, { title: 'Q1 revenue' });

// 3. Screenshot a grid taller than its viewport.
const shot = await captureTallGrid({
  canvas: gridCanvas,
  totalHeight: 20_000,
  viewportHeight: 800,
  scrollTo: (y) => grid.scrollTo(y),
  settle: () => new Promise(requestAnimationFrame),
});
// shot.dataUrl is a full-height PNG, stitched from shot.tileCount captures.
```

## Format preservation

Nothing is flattened to text. `formatCell` resolves the number format, alignment and
conditional colour once, and the PDF, HTML and `toStyledSheet` outputs all consume
that same projection, so they cannot disagree. `PrintColumn` extends
`@onegrid/export`'s `ExportColumn`, so a column set written for CSV or XLSX drops in
unchanged and only gains `width`, `align`, `key`, `numberFormat`, `style` and
`conditionalStyle`.

## The PDF writer

`renderPdf` writes the byte stream directly: `%PDF-1.7` header, indirect objects, the
base-14 Helvetica and Helvetica-Bold fonts (no embedded font file), a
20-byte-per-entry cross-reference table, and a trailer whose `startxref` points at
it. Text is escaped for PDF literal-string syntax, and text metrics come from the
published Helvetica advance widths so right-alignment and ellipsis truncation land
where the reader will actually draw the glyphs.

## The `@media print` path

`printStylesheet` emits real `@page { size; margin }` geometry plus
`thead { display: table-header-group }` — **native**, browser-implemented header
repetition, no JavaScript — `break-inside: avoid` on rows and group headers,
`print-color-adjust: exact` so conditional fills are not stripped by ink-saving
heuristics, expansion of the virtualised scroll port, and hiding of interactive
chrome.

## Testing

```sh
pnpm --filter @onegrid/print test
```

100 tests: pagination arithmetic across all four page sizes and both orientations,
the no-row-split invariant, column banding with repeated key columns, group-header
continuation, all four scaling modes, PDF structural validity (header, xref offsets,
20-byte entries, page-object count, stream lengths) and string escaping, the CSS
emitter's contents, and the screenshot stitching maths.

MIT.
