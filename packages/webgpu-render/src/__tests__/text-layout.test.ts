import { describe, it, expect } from 'vitest';
import {
  layoutCellText,
  measureColumnWidth,
  measureText,
  truncateToWidth,
} from '../text-layout.js';
import type { GlyphMetricSource } from '../glyph-source.js';

const A = 65;
const V = 86;

/** Every glyph advances 10; the pair "AV" kerns -2. */
const source: GlyphMetricSource = {
  emPx: 10,
  ascentPx: 8,
  descentPx: 2,
  lineHeightPx: 12,
  advanceOf: () => 10,
  kernOf: (left, right) => (left === A && right === V ? -2 : 0),
};

describe('measureText', () => {
  it('sums advances', () => {
    expect(measureText('ABC', source).width).toBe(30);
  });

  it('applies the kern pair between adjacent glyphs', () => {
    expect(measureText('AV', source).width).toBe(18);
    expect(measureText('AVAV', source).width).toBe(36);
  });

  it('does not apply a kern after the final glyph', () => {
    // If the trailing kern leaked in, "VA" would also measure 18.
    expect(measureText('VA', source).width).toBe(20);
  });

  it('counts code points, not UTF-16 units', () => {
    const metric = measureText('\u{1D400}', source); // astral 'A'
    expect(metric.glyphCount).toBe(1);
    expect(metric.width).toBe(10);
  });

  it('measures the empty string as zero width', () => {
    expect(measureText('', source).width).toBe(0);
  });
});

describe('truncateToWidth', () => {
  it('returns the input untouched when it fits', () => {
    const result = truncateToWidth('ABC', 40, source);
    expect(result).toEqual({ text: 'ABC', width: 30, truncated: false });
  });

  it('keeps as many characters as fit alongside the ellipsis', () => {
    // Ellipsis is one glyph = 10. "AB…" = 30 fits in 35; "ABC…" = 40 does not.
    const result = truncateToWidth('ABCDEF', 35, source);
    expect(result.text).toBe('AB…');
    expect(result.width).toBe(30);
    expect(result.truncated).toBe(true);
  });

  it('accounts for the kern pair against the ellipsis itself', () => {
    const kerning: GlyphMetricSource = {
      ...source,
      // Every glyph kerns -5 against the ellipsis, so one more fits than a
      // naive maxWidth-minus-ellipsisWidth cut would allow.
      kernOf: (_left, right) => (right === 0x2026 ? -5 : 0),
    };
    // "ABC…" = 10+10+(10-5)+10 = 35.
    const result = truncateToWidth('ABCDEF', 35, kerning);
    expect(result.text).toBe('ABC…');
    expect(result.width).toBe(35);
  });

  it('yields the empty string when even the ellipsis does not fit', () => {
    expect(truncateToWidth('ABC', 5, source)).toEqual({
      text: '',
      width: 0,
      truncated: true,
    });
  });

  it('honours a custom ellipsis', () => {
    const result = truncateToWidth('ABCDEF', 35, source, '..');
    expect(result.text).toBe('A..');
    expect(result.width).toBe(30);
  });
});

describe('layoutCellText', () => {
  const cell = { x: 100, y: 200, width: 100, height: 20 };

  it('positions each glyph at its accumulated pen, kerning included', () => {
    const layout = layoutCellText({ ...cell, text: 'AVB', source, align: 'left' });
    expect(layout.glyph.map((g) => g.penX)).toEqual([100, 108, 118]);
    expect(layout.width).toBe(28);
  });

  it('aligns left, centre and right inside the content box', () => {
    const left = layoutCellText({ ...cell, text: 'AB', source, align: 'left' });
    const center = layoutCellText({ ...cell, text: 'AB', source, align: 'center' });
    const right = layoutCellText({ ...cell, text: 'AB', source, align: 'right' });
    expect(left.originX).toBe(100);
    expect(center.originX).toBe(140); // 100 + (100 - 20) / 2
    expect(right.originX).toBe(180);
  });

  it('respects horizontal padding on both edges', () => {
    const layout = layoutCellText({
      ...cell,
      text: 'AB',
      source,
      align: 'right',
      paddingX: 6,
    });
    // Content box is 88 wide starting at 106; the 20px run ends at its right.
    expect(layout.originX).toBe(174);
  });

  it('centres the ink box vertically, not the line box', () => {
    const middle = layoutCellText({ ...cell, text: 'A', source, verticalAlign: 'middle' });
    const top = layoutCellText({ ...cell, text: 'A', source, verticalAlign: 'top' });
    const bottom = layoutCellText({ ...cell, text: 'A', source, verticalAlign: 'bottom' });
    expect(middle.baselineY).toBe(213); // 200 + (20 - 10)/2 + 8
    expect(top.baselineY).toBe(208);
    expect(bottom.baselineY).toBe(218);
  });

  it('truncates to the content box and reports it', () => {
    const layout = layoutCellText({
      ...cell,
      width: 45,
      text: 'ABCDEF',
      source,
      paddingX: 5,
    });
    expect(layout.truncated).toBe(true);
    expect(layout.text).toBe('AB…');
    expect(layout.glyph).toHaveLength(3);
  });

  it('scales metrics to the on-screen font size', () => {
    // A 5px render off a 10px source halves every advance and the ascent.
    const layout = layoutCellText({ ...cell, text: 'AB', source, scale: 0.5 });
    expect(layout.width).toBe(10);
    expect(layout.glyph.map((g) => g.penX)).toEqual([100, 105]);
    expect(layout.baselineY).toBe(211.5); // 200 + (20 - 5)/2 + 4
  });

  it('truncates against the scaled content width, not the raw one', () => {
    // 100px content at scale 2 leaves room for 50 source units = 5 glyphs,
    // so "ABCDEF" loses one to the ellipsis.
    const layout = layoutCellText({ ...cell, text: 'ABCDEF', source, scale: 2 });
    expect(layout.text).toBe('ABCD…');
    expect(layout.width).toBe(100);
  });

  it('produces no glyphs for empty text', () => {
    const layout = layoutCellText({ ...cell, text: '', source });
    expect(layout.glyph).toEqual([]);
    expect(layout.width).toBe(0);
  });
});

describe('measureColumnWidth', () => {
  it('returns the widest sample plus padding, at the render scale', () => {
    expect(
      measureColumnWidth(['A', 'ABC', 'AB'], source, { scale: 1, paddingX: 4 }),
    ).toBe(38);
  });

  it('scales with the render size', () => {
    expect(measureColumnWidth(['ABC'], source, { scale: 0.5 })).toBe(15);
  });

  it('returns just the padding for an empty sample set', () => {
    expect(measureColumnWidth([], source, { paddingX: 3 })).toBe(6);
  });
});
