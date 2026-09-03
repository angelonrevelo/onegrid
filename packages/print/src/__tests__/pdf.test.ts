import { describe, expect, it } from 'vitest';
import { escapePdfString, measureText, renderPdf, truncateToWidth } from '../pdf';
import { paginate } from '../paginate';
import type { ExportRow, PrintColumn } from '../types';

const column: PrintColumn[] = [
  { id: 'id', header: 'ID', width: 60, key: true },
  { id: 'name', header: 'Name', width: 160 },
  {
    id: 'amount',
    header: 'Amount',
    width: 90,
    numberFormat: { style: 'currency', currency: 'USD' },
    conditionalStyle: (v) => (typeof v === 'number' && v < 0 ? { color: '#cc0000' } : undefined),
  },
];

function table(count: number): ExportRow[] {
  const row: ExportRow[] = [];
  for (let i = 0; i < count; i++) {
    row.push({ id: i, name: `Row (${i}) \\ item`, amount: i % 3 === 0 ? -i : i * 10 });
  }
  return row;
}

function decode(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return s;
}

describe('PDF string escaping', () => {
  it('escapes the syntax characters that would otherwise corrupt the file', () => {
    expect(escapePdfString('a(b)c\\d')).toBe('a\\(b\\)c\\\\d');
  });

  it('escapes newlines and tabs rather than breaking the literal', () => {
    expect(escapePdfString('a\nb\tc\rd')).toBe('a\\nb\\tc\\rd');
  });

  it('emits Latin-1 as three-digit octal and drops control characters', () => {
    expect(escapePdfString('café')).toBe('caf\\351');
    expect(escapePdfString('ab')).toBe('ab');
  });

  it('replaces glyphs a base-14 font cannot render', () => {
    expect(escapePdfString('価')).toBe('?');
  });

  it('leaves ordinary ASCII untouched', () => {
    expect(escapePdfString('Total: 1,234.50 USD')).toBe('Total: 1,234.50 USD');
  });
});

describe('text metrics', () => {
  it('uses real Helvetica advance widths, not a monospace guess', () => {
    // 'i' (222/1000) is far narrower than 'W' (944/1000) at the same size.
    expect(measureText('i', 10)).toBeCloseTo(2.22, 5);
    expect(measureText('W', 10)).toBeCloseTo(9.44, 5);
    expect(measureText('', 10)).toBe(0);
  });

  it('bold measures wider than regular', () => {
    expect(measureText('Amount', 10, true)).toBeGreaterThan(measureText('Amount', 10));
  });

  it('truncates to a width with an ellipsis and leaves fitting text alone', () => {
    expect(truncateToWidth('short', 200, 10)).toBe('short');
    const cut = truncateToWidth('a very long cell value indeed', 40, 10);
    expect(cut.endsWith('…')).toBe(true);
    expect(measureText(cut, 10)).toBeLessThanOrEqual(40);
    expect(truncateToWidth('anything', 0, 10)).toBe('');
  });
});

describe('PDF document structure', () => {
  const row = table(120);
  const page = paginate({
    table: row,
    column,
    page: { size: 'A4' },
    option: { rowHeight: 20 },
  });
  const doc = renderPdf(page, row, { title: 'Q1 Report (draft)' });
  const text = decode(doc.bytes);

  it('starts with the PDF header and a binary marker line', () => {
    expect(text.startsWith('%PDF-')).toBe(true);
    expect(text.slice(0, 8)).toBe('%PDF-1.7');
    expect(doc.bytes[9]).toBe(0x25); // '%' of the binary comment
    expect(doc.bytes[10]).toBeGreaterThan(127);
  });

  it('ends with %%EOF', () => {
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
  });

  it('has a startxref offset that actually points at the xref table', () => {
    const match = /startxref\n(\d+)\n%%EOF/.exec(text);
    expect(match).not.toBeNull();
    const offset = Number(match![1]);
    expect(offset).toBeGreaterThan(0);
    expect(offset).toBeLessThan(doc.bytes.length);
    expect(text.slice(offset, offset + 4)).toBe('xref');
  });

  it('records a byte offset for every object, each landing on its obj header', () => {
    const xrefStart = Number(/startxref\n(\d+)\n/.exec(text)![1]);
    const xref = text.slice(xrefStart);
    const size = Number(/\/Size (\d+)/.exec(text)![1]);
    const entry = [...xref.matchAll(/^(\d{10}) (\d{5}) ([nf]) $/gm)];
    expect(entry).toHaveLength(size);
    // Entry 0 is the free-list head; the rest must point at "<n> 0 obj".
    expect(entry[0]![3]).toBe('f');
    for (let i = 1; i < entry.length; i++) {
      const off = Number(entry[i]![1]);
      expect(text.slice(off, off + `${i} 0 obj`.length)).toBe(`${i} 0 obj`);
    }
  });

  it('every xref entry is exactly 20 bytes, as readers require', () => {
    const xrefStart = Number(/startxref\n(\d+)\n/.exec(text)![1]);
    const body = text.slice(xrefStart);
    const header = /xref\n\d+ \d+\n/.exec(body)![0];
    const size = Number(/\/Size (\d+)/.exec(text)![1]);
    const tableText = body.slice(header.length, header.length + size * 20);
    expect(tableText).toHaveLength(size * 20);
    for (let i = 0; i < size; i++) {
      expect(/^\d{10} \d{5} [nf] \n$/.test(tableText.slice(i * 20, i * 20 + 20))).toBe(true);
    }
  });

  it('contains exactly one page object per paginated page', () => {
    const pageObj = [...text.matchAll(/\/Type \/Page[^s]/g)];
    expect(pageObj).toHaveLength(page.length);
    expect(doc.pageCount).toBe(page.length);
    expect(/\/Type \/Pages \/Count (\d+)/.exec(text)![1]).toBe(String(page.length));
  });

  it('declares a page tree whose /Kids count matches /Count', () => {
    const kid = /\/Kids \[([^\]]*)\]/.exec(text)![1]!.trim().split(/\s+(?=\d+ 0 R)/);
    expect(kid).toHaveLength(page.length);
  });

  it('embeds both base-14 fonts and no font file', () => {
    expect(text).toContain('/BaseFont /Helvetica ');
    expect(text).toContain('/BaseFont /Helvetica-Bold');
    expect(text).not.toContain('/FontFile');
  });

  it('sets a MediaBox matching the resolved A4 page box', () => {
    expect(text).toContain('/MediaBox [0 0 595.276 841.89]');
  });

  it('escapes parentheses and backslashes coming from cell data', () => {
    expect(text).toContain('Row \\(0\\) \\\\ item');
    expect(text).not.toMatch(/\(Row \(0\)/);
  });

  it('writes the title into the info dictionary, escaped', () => {
    expect(text).toContain('/Title (Q1 Report \\(draft\\))');
  });

  it('draws page numbers with the correct total', () => {
    expect(text).toContain(`(Page 1 of ${page.length}) Tj`);
    expect(text).toContain(`(Page ${page.length} of ${page.length}) Tj`);
  });

  it('carries conditional colour into the content stream as a fill', () => {
    // #cc0000 => 0.8 0 0 rg
    expect(text).toContain('0.8 0 0 rg');
  });

  it('declares each content stream /Length equal to its real byte length', () => {
    for (const m of text.matchAll(/<< \/Length (\d+) >>\nstream\n/g)) {
      const declared = Number(m[1]);
      const start = m.index + m[0].length;
      expect(text.slice(start + declared, start + declared + 10)).toBe('\nendstream');
    }
  });

  it('emits a valid single-page document for an empty table', () => {
    const emptyPage = paginate({ table: [], column });
    const empty = renderPdf(emptyPage, []);
    const t = decode(empty.bytes);
    expect(t.startsWith('%PDF-')).toBe(true);
    expect(empty.pageCount).toBe(1);
    expect(t).toContain('(Page 1 of 1) Tj');
  });

  it('produces one page object per band for a wide table', () => {
    const wide: PrintColumn[] = Array.from({ length: 14 }, (_v, i) => ({
      id: `c${i}`,
      header: `C${i}`,
      width: 100,
      ...(i === 0 ? { key: true } : {}),
    }));
    const wideRow = table(40);
    const wp = paginate({ table: wideRow, column: wide, page: { size: 'A4' }, option: { rowHeight: 20 } });
    expect(wp[0]!.band.total).toBeGreaterThan(1);
    const out = renderPdf(wp, wideRow);
    expect(out.pageCount).toBe(wp.length);
    expect([...decode(out.bytes).matchAll(/\/Type \/Page[^s]/g)]).toHaveLength(wp.length);
  });
});
