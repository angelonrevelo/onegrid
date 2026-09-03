import { describe, expect, it } from 'vitest';
import { columnWidth, formatCell, headerCell, toStyledSheet } from '../format';
import { printHtmlDocument, printHtmlTable, cellStyleAttribute, escapeHtml } from '../html';
import { paginate } from '../paginate';
import type { ExportRow, PrintColumn } from '../types';

const row: ExportRow[] = [
  { id: 1, name: 'Widget', amount: 1234.5, ratio: 0.0725, when: new Date('2024-03-01T00:00:00Z') },
  { id: 2, name: 'Gadget "Pro"', amount: -80, ratio: 0.5, when: null },
];

const column: PrintColumn[] = [
  { id: 'id', header: 'ID', width: 40, key: true },
  { id: 'name', header: 'Name', width: 120 },
  {
    id: 'amount',
    header: 'Amount',
    width: 90,
    numberFormat: { style: 'currency', currency: 'USD' },
    conditionalStyle: (v) => (typeof v === 'number' && v < 0 ? { color: '#cc0000' } : undefined),
  },
  { id: 'ratio', header: 'Ratio', width: 60, numberFormat: { style: 'percent', minimumFractionDigits: 2 } },
  { id: 'when', header: 'When', width: 120 },
];

describe('format-preserving projection', () => {
  it('carries a currency number format through instead of flattening to text', () => {
    const cell = formatCell(column[2]!, 1234.5, row[0]!, 0);
    expect(cell.text).toBe('$1,234.50');
    expect(cell.numeric).toBe(true);
  });

  it('carries a percent format with fraction digits', () => {
    expect(formatCell(column[3]!, 0.0725, row[0]!, 0).text).toBe('7.25%');
  });

  it('lets an explicit format callback win over numberFormat', () => {
    const col: PrintColumn = { id: 'x', numberFormat: { style: 'percent' }, format: () => 'CUSTOM' };
    expect(formatCell(col, 0.5, {}, 0).text).toBe('CUSTOM');
  });

  it('right-aligns numerics by default and left-aligns text', () => {
    expect(formatCell(column[2]!, 10, row[0]!, 0).align).toBe('right');
    expect(formatCell(column[1]!, 'Widget', row[0]!, 0).align).toBe('left');
  });

  it('merges a conditional style over the column style', () => {
    const col: PrintColumn = {
      id: 'amount',
      style: { background: '#ffffff', color: '#000000' },
      conditionalStyle: (v) => (typeof v === 'number' && v < 0 ? { color: '#cc0000' } : undefined),
    };
    expect(formatCell(col, -1, {}, 0).style).toEqual({ background: '#ffffff', color: '#cc0000' });
    expect(formatCell(col, 1, {}, 0).style).toEqual({ background: '#ffffff', color: '#000000' });
  });

  it('stringifies dates as ISO and nullish as empty', () => {
    expect(formatCell(column[4]!, new Date('2024-03-01T00:00:00Z'), row[0]!, 0).text).toBe(
      '2024-03-01T00:00:00.000Z',
    );
    expect(formatCell(column[4]!, null, row[1]!, 1).text).toBe('');
    expect(formatCell(column[4]!, undefined, row[1]!, 1).text).toBe('');
  });

  it('does not treat NaN or Infinity as formattable numbers', () => {
    expect(formatCell(column[2]!, Number.NaN, {}, 0).numeric).toBe(false);
    expect(formatCell(column[2]!, Number.POSITIVE_INFINITY, {}, 0).text).toBe('Infinity');
  });

  it('marks header cells bold and inherits column alignment', () => {
    const h = headerCell({ id: 'amount', header: 'Amount', align: 'right' });
    expect(h).toMatchObject({ text: 'Amount', align: 'right' });
    expect(h.style.bold).toBe(true);
  });

  it('falls back to the id when a column has no header', () => {
    expect(headerCell({ id: 'sku' }).text).toBe('sku');
  });

  it('defaults and sanitises column widths', () => {
    expect(columnWidth({ id: 'a' })).toBe(72);
    expect(columnWidth({ id: 'a', width: 0 })).toBe(72);
    expect(columnWidth({ id: 'a', width: 33 })).toBe(33);
  });

  it('builds a styled sheet with headers, cells and widths in parallel', () => {
    const sheet = toStyledSheet(row, column);
    expect(sheet.header).toHaveLength(5);
    expect(sheet.row).toHaveLength(2);
    expect(sheet.columnWidth).toEqual([40, 120, 90, 60, 120]);
    expect(sheet.row[1]![2]!.style.color).toBe('#cc0000');
  });
});

describe('printable HTML', () => {
  it('escapes HTML-significant characters in cell text', () => {
    expect(escapeHtml('a & b < c > "d"')).toBe('a &amp; b &lt; c &gt; &quot;d&quot;');
  });

  it('renders preserved formatting as inline style', () => {
    const cell = formatCell(column[2]!, -80, row[1]!, 1);
    const attr = cellStyleAttribute(cell);
    expect(attr).toContain('text-align:right');
    expect(attr).toContain('color:#cc0000');
  });

  it('emits a real thead so the browser can repeat it natively', () => {
    const html = printHtmlTable(row, column);
    expect(html).toContain('<thead>');
    expect(html).toContain('<col style="width:40pt">');
    expect(html).toContain('Gadget &quot;Pro&quot;');
  });

  it('emits one section per paginated page with explicit breaks', () => {
    const page = paginate({
      table: row,
      column,
      page: { size: { width: 200, height: 120 }, margin: 5 },
      option: { rowHeight: 20, headerHeight: 20 },
    });
    const doc = printHtmlDocument(page, row, { title: 'Report & Co' });
    expect(doc.startsWith('<!doctype html>')).toBe(true);
    expect(doc).toContain('Report &amp; Co');
    expect(doc).toContain('@page');
    expect((doc.match(/onegrid-print-page/g) ?? []).length).toBe(page.length);
    expect(doc).toContain('break-before:page');
    expect(doc).toContain(`Page 1 of ${page.length}`);
  });
});
