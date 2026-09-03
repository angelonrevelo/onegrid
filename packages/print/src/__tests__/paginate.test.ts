import { describe, expect, it } from 'vitest';
import { paginate, pageCell, resolveScale, splitColumnBand, totalColumnWidth } from '../paginate';
import { resolvePageBox, PAGE_SIZE_POINT } from '../page';
import type { ExportRow, PrintColumn } from '../types';

// A 100 pt column keeps every band arithmetic check mental-arithmetic simple.
function makeColumn(count: number, key = 0): PrintColumn[] {
  const column: PrintColumn[] = [];
  for (let i = 0; i < count; i++) {
    column.push({ id: `c${i}`, header: `Col ${i}`, width: 100, ...(i < key ? { key: true } : {}) });
  }
  return column;
}

function makeRow(count: number): ExportRow[] {
  const row: ExportRow[] = [];
  for (let i = 0; i < count; i++) {
    const r: ExportRow = {};
    for (let c = 0; c < 12; c++) r[`c${c}`] = `r${i}c${c}`;
    row.push(r);
  }
  return row;
}

describe('page geometry', () => {
  it('resolves A4 portrait to the exact ISO 216 point size', () => {
    const box = resolvePageBox({ size: 'A4' });
    expect(box.width).toBeCloseTo(595.2756, 3);
    expect(box.height).toBeCloseTo(841.8898, 3);
    expect(box.contentWidth).toBeCloseTo(595.2756 - 72, 3);
    expect(box.contentHeight).toBeCloseTo(841.8898 - 72, 3);
  });

  it('resolves the US sizes in whole inches', () => {
    expect(PAGE_SIZE_POINT.Letter).toEqual({ width: 612, height: 792 });
    expect(PAGE_SIZE_POINT.Legal).toEqual({ width: 612, height: 1008 });
    expect(PAGE_SIZE_POINT.A3.height).toBeCloseTo(1190.5512, 3);
  });

  it('landscape is exactly the transpose of portrait', () => {
    const portrait = resolvePageBox({ size: 'Letter', orientation: 'portrait' });
    const landscape = resolvePageBox({ size: 'Letter', orientation: 'landscape' });
    expect(landscape.width).toBe(portrait.height);
    expect(landscape.height).toBe(portrait.width);
  });

  it('accepts a scalar margin and a partial margin object', () => {
    expect(resolvePageBox({ size: 'Letter', margin: 10 }).margin).toEqual({
      top: 10,
      right: 10,
      bottom: 10,
      left: 10,
    });
    const partial = resolvePageBox({ size: 'Letter', margin: { left: 72 } }).margin;
    expect(partial).toEqual({ top: 36, right: 36, bottom: 36, left: 72 });
  });

  it('clamps a content box that margins would drive negative', () => {
    const box = resolvePageBox({ size: 'Letter', margin: 500 });
    expect(box.contentWidth).toBe(0);
    expect(box.contentHeight).toBe(0);
  });

  it('honours a custom page box', () => {
    const box = resolvePageBox({ size: { width: 400, height: 300 }, margin: 0 });
    expect(box.contentWidth).toBe(400);
    expect(box.contentHeight).toBe(300);
  });
});

describe('row packing', () => {
  it('fits exactly floor((content - header) / rowHeight) rows on an A4 page', () => {
    const page = paginate({
      table: makeRow(200),
      column: makeColumn(3),
      page: { size: 'A4' },
      option: { rowHeight: 20, headerHeight: 22 },
    });
    // 841.8898 - 72 margin = 769.8898; minus 22 header = 747.8898; / 20 = 37.
    expect(page[0]!.rowEnd - page[0]!.rowStart).toBe(37);
    expect(page.length).toBe(Math.ceil(200 / 37));
  });

  it('never splits a row and covers every row exactly once', () => {
    const table = makeRow(500);
    const page = paginate({
      table,
      column: makeColumn(3),
      page: { size: 'Letter' },
      option: { rowHeight: (_r, i) => 12 + (i % 7) * 6 },
    });
    let cursor = 0;
    for (const p of page) {
      expect(p.rowStart).toBe(cursor);
      expect(p.rowEnd).toBeGreaterThan(p.rowStart);
      cursor = p.rowEnd;
    }
    expect(cursor).toBe(table.length);
  });

  it('never exceeds the printable height with variable row heights', () => {
    const page = paginate({
      table: makeRow(300),
      column: makeColumn(3),
      page: { size: 'A4' },
      option: { rowHeight: (_r, i) => 10 + (i % 11) * 5, headerHeight: 22, footerHeight: 18 },
    });
    for (const p of page) {
      expect(p.usedHeight).toBeLessThanOrEqual(p.box.contentHeight + 1e-9);
    }
  });

  it('gives a row taller than the page its own page rather than clipping it', () => {
    const page = paginate({
      table: makeRow(4),
      column: makeColumn(2),
      page: { size: 'A4' },
      option: { rowHeight: (_r, i) => (i === 1 ? 2000 : 20) },
    });
    const giant = page.find((p) => p.rowStart === 1)!;
    expect(giant.rowEnd - giant.rowStart).toBe(1);
    expect(page.map((p) => p.rowStart)).toEqual([0, 1, 2]);
  });

  it('reserves the footer strip, reducing rows per page', () => {
    const base = paginate({
      table: makeRow(400),
      column: makeColumn(2),
      option: { rowHeight: 20, footerHeight: 0 },
    });
    const withFooter = paginate({
      table: makeRow(400),
      column: makeColumn(2),
      option: { rowHeight: 20, footerHeight: 100 },
    });
    expect(withFooter[0]!.rowEnd).toBeLessThan(base[0]!.rowEnd);
  });

  it('emits one header-only page for an empty table', () => {
    const page = paginate({ table: [], column: makeColumn(3) });
    expect(page).toHaveLength(1);
    expect(page[0]!.rowStart).toBe(0);
    expect(page[0]!.rowEnd).toBe(0);
    expect(page[0]!.header).toHaveLength(3);
  });
});

describe('page numbering', () => {
  it('stamps a total that matches the real page count on every page', () => {
    const page = paginate({
      table: makeRow(300),
      column: makeColumn(12, 2),
      page: { size: 'A4' },
      option: { rowHeight: 20 },
    });
    expect(page.length).toBeGreaterThan(3);
    for (const p of page) expect(p.totalPage).toBe(page.length);
  });

  it('numbers pages 1..n in emission order', () => {
    const page = paginate({ table: makeRow(120), column: makeColumn(10, 1), option: { rowHeight: 20 } });
    expect(page.map((p) => p.pageNumber)).toEqual(page.map((_p, i) => i + 1));
    expect(page.map((p) => p.index)).toEqual(page.map((_p, i) => i));
  });

  it('emits every band of a row slice consecutively (rows-major order)', () => {
    const page = paginate({
      table: makeRow(100),
      column: makeColumn(12, 1),
      page: { size: 'A4' },
      option: { rowHeight: 20 },
    });
    const bandCount = page[0]!.band.total;
    expect(bandCount).toBeGreaterThan(1);
    for (let i = 0; i < page.length; i += bandCount) {
      const slice = page.slice(i, i + bandCount);
      const start = slice[0]!.rowStart;
      for (const p of slice) expect(p.rowStart).toBe(start);
      expect(slice.map((p) => p.band.index)).toEqual(slice.map((_p, j) => j));
    }
  });
});

describe('column banding', () => {
  it('splits a wide column set into bands that each fit the page', () => {
    const column = makeColumn(10, 1);
    const band = splitColumnBand(column, 523.2756);
    // Key column costs 100, leaving 423 pt => 4 non-key columns per band.
    expect(band).toHaveLength(3);
    expect(band.map((b) => b.column.length)).toEqual([5, 5, 2]);
    for (const b of band) expect(b.width).toBeLessThanOrEqual(523.2756);
  });

  it('repeats the key columns at the head of every band', () => {
    const column = makeColumn(10, 2);
    const band = splitColumnBand(column, 523.2756);
    expect(band.length).toBeGreaterThan(1);
    for (const b of band) {
      expect(b.keyColumnCount).toBe(2);
      expect(b.column.slice(0, 2).map((c) => c.id)).toEqual(['c0', 'c1']);
    }
    // ... and never duplicates them into the non-key run.
    for (const b of band) {
      const ids = b.column.map((c) => c.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it('accepts key columns named at print time via keyColumnId', () => {
    const column = makeColumn(10);
    const band = splitColumnBand(column, 523.2756, { keyColumnId: ['c3'] });
    for (const b of band) expect(b.column[0]!.id).toBe('c3');
  });

  it('stamps band.total on every band', () => {
    const band = splitColumnBand(makeColumn(10, 1), 523.2756);
    for (const b of band) expect(b.total).toBe(band.length);
  });

  it('covers every non-key column exactly once across the bands', () => {
    const column = makeColumn(11, 2);
    const band = splitColumnBand(column, 523.2756);
    const seen = band.flatMap((b) => b.column.slice(b.keyColumnCount).map((c) => c.id));
    expect(seen).toEqual(column.slice(2).map((c) => c.id));
  });

  it('marks a column wider than the page as overflow instead of looping', () => {
    const column: PrintColumn[] = [
      { id: 'k', width: 80, key: true },
      { id: 'wide', width: 4000 },
      { id: 'also', width: 4000 },
    ];
    const band = splitColumnBand(column, 523.2756);
    expect(band).toHaveLength(2);
    for (const b of band) expect(b.overflow).toBe(true);
  });

  it('returns a single band when everything already fits', () => {
    const band = splitColumnBand(makeColumn(4), 523.2756);
    expect(band).toHaveLength(1);
    expect(band[0]!.overflow).toBe(false);
  });

  it('handles a column set that is entirely key columns', () => {
    const band = splitColumnBand(makeColumn(3, 3), 523.2756);
    expect(band).toHaveLength(1);
    expect(band[0]!.keyColumnCount).toBe(3);
  });

  it('sums column widths, defaulting undeclared widths', () => {
    expect(totalColumnWidth([{ id: 'a' }, { id: 'b', width: 30 }])).toBe(102);
  });
});

describe('header repetition', () => {
  it('repeats the column header on every page by default', () => {
    const page = paginate({ table: makeRow(200), column: makeColumn(3), option: { rowHeight: 20 } });
    expect(page.length).toBeGreaterThan(1);
    for (const p of page) expect(p.header.map((c) => c.text)).toEqual(['Col 0', 'Col 1', 'Col 2']);
  });

  it('emits the header only on the first slice when repeatHeader is false', () => {
    const page = paginate({
      table: makeRow(200),
      column: makeColumn(3),
      option: { rowHeight: 20, repeatHeader: false },
    });
    expect(page[0]!.header).toHaveLength(3);
    expect(page[1]!.header).toHaveLength(0);
    expect(page[1]!.headerHeight).toBe(0);
  });

  it('repeats a group header with continued:true when the group spans pages', () => {
    const page = paginate({
      table: makeRow(80),
      column: makeColumn(2),
      page: { size: { width: 300, height: 200 }, margin: 10 },
      option: {
        rowHeight: 20,
        headerHeight: 20,
        groupHeaderHeight: 20,
        group: [{ label: 'North', startRow: 0, endRow: 80 }],
      },
    });
    expect(page.length).toBeGreaterThan(1);
    expect(page[0]!.groupHeader).toEqual([{ label: 'North', rowIndex: 0, continued: false }]);
    expect(page[1]!.groupHeader[0]).toMatchObject({ label: 'North', continued: true });
  });

  it('omits the continuation group header when repeatGroupHeader is false', () => {
    const page = paginate({
      table: makeRow(80),
      column: makeColumn(2),
      page: { size: { width: 300, height: 200 }, margin: 10 },
      option: {
        rowHeight: 20,
        headerHeight: 20,
        repeatGroupHeader: false,
        group: [{ label: 'North', startRow: 0, endRow: 80 }],
      },
    });
    expect(page[0]!.groupHeader).toHaveLength(1);
    expect(page[1]!.groupHeader).toHaveLength(0);
  });

  it('emits a group header for each group starting mid-page', () => {
    const page = paginate({
      table: makeRow(6),
      column: makeColumn(2),
      option: {
        rowHeight: 20,
        group: [
          { label: 'A', startRow: 0, endRow: 3 },
          { label: 'B', startRow: 3, endRow: 6 },
        ],
      },
    });
    expect(page).toHaveLength(1);
    expect(page[0]!.groupHeader.map((g) => g.label)).toEqual(['A', 'B']);
    expect(page[0]!.groupHeader.every((g) => !g.continued)).toBe(true);
  });
});

describe('scaling', () => {
  const box = resolvePageBox({ size: 'A4' });

  it('none is 1:1', () => {
    expect(resolveScale({ mode: 'none' }, box, 2000, 5000)).toBe(1);
    expect(resolveScale(undefined, box, 2000, 5000)).toBe(1);
  });

  it('scale(n) passes the factor through and rejects nonsense', () => {
    expect(resolveScale({ mode: 'scale', factor: 0.75 }, box, 2000, 5000)).toBe(0.75);
    expect(resolveScale({ mode: 'scale', factor: 0 }, box, 2000, 5000)).toBe(1);
  });

  it('fitWidth shrinks a wide table to exactly one band', () => {
    const column = makeColumn(12, 1);
    const page = paginate({
      table: makeRow(20),
      column,
      page: { size: 'A4', scaling: { mode: 'fitWidth' } },
      option: { rowHeight: 20 },
    });
    expect(page[0]!.scale).toBeCloseTo(box.contentWidth / 1200, 6);
    expect(page[0]!.band.total).toBe(1);
    expect(page[0]!.band.column).toHaveLength(12);
  });

  it('fitWidth never enlarges a narrow table', () => {
    const page = paginate({
      table: makeRow(5),
      column: makeColumn(2),
      page: { size: 'A4', scaling: { mode: 'fitWidth' } },
    });
    expect(page[0]!.scale).toBe(1);
  });

  it('fitPage shrinks until the whole table is one page', () => {
    const page = paginate({
      table: makeRow(200),
      column: makeColumn(12, 1),
      page: { size: 'A4', scaling: { mode: 'fitPage' } },
      option: { rowHeight: 20 },
    });
    expect(page).toHaveLength(1);
    expect(page[0]!.scale).toBeLessThan(
      resolveScale({ mode: 'fitWidth' }, box, 1200, 4022) + 1e-9,
    );
  });

  it('scale(0.5) roughly doubles the rows that fit a page', () => {
    const full = paginate({
      table: makeRow(400),
      column: makeColumn(2),
      page: { size: 'A4' },
      option: { rowHeight: 20, headerHeight: 0 },
    });
    const half = paginate({
      table: makeRow(400),
      column: makeColumn(2),
      page: { size: 'A4', scaling: { mode: 'scale', factor: 0.5 } },
      option: { rowHeight: 20, headerHeight: 0 },
    });
    expect(half[0]!.rowEnd).toBe(full[0]!.rowEnd * 2);
  });
});

describe('pageCell', () => {
  it('projects exactly this page’s rows and this band’s columns', () => {
    const table = makeRow(100);
    const page = paginate({
      table,
      column: makeColumn(12, 1),
      page: { size: 'A4' },
      option: { rowHeight: 20 },
    });
    const target = page[1]!;
    const cell = pageCell(target, table);
    expect(cell).toHaveLength(target.rowEnd - target.rowStart);
    expect(cell[0]!.map((c) => c.columnId)).toEqual(target.band.column.map((c) => c.id));
    expect(cell[0]![0]!.text).toBe(`r${target.rowStart}c0`);
  });
});
