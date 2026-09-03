import { describe, expect, it } from 'vitest';
import { headerHeightFor, wrapHeaderText } from '../header-wrap';

/** Deterministic monospace measurement: 10px per character. */
const measure = (text: string): number => text.length * 10;

describe('wrapHeaderText', () => {
  it('leaves a header that fits on one line', () => {
    const result = wrapHeaderText('Name', { width: 100, measure });
    expect(result.line).toEqual(['Name']);
    expect(result.truncated).toBe(false);
  });

  it('wraps on whitespace when the header is too long', () => {
    // "Adjusted Gross" = 14 chars = 140px > 100; so it breaks.
    const result = wrapHeaderText('Adjusted Gross Margin', { width: 100, measure });
    expect(result.line).toEqual(['Adjusted', 'Gross', 'Margin']);
    expect(result.truncated).toBe(false);
  });

  it('breaks after a slash, keeping the slash on the first line', () => {
    const result = wrapHeaderText('Revenue/Cost', { width: 90, measure });
    expect(result.line).toEqual(['Revenue/', 'Cost']);
  });

  it('breaks after a hyphen', () => {
    const result = wrapHeaderText('Year-over-Year', { width: 60, measure });
    expect(result.line).toEqual(['Year-', 'over-', 'Year']);
  });

  it('breaks mid-word when a single word cannot fit at all', () => {
    // A 12-char token in a 50px (5-char) column must be chopped, not overflow.
    const result = wrapHeaderText('Supercalifra', { width: 50, measure });
    expect(result.line).toEqual(['Super', 'calif', 'ra']);
    expect(result.line.every((l) => measure(l) <= 50)).toBe(true);
  });

  it('ellipsises the last line past maxLine', () => {
    const result = wrapHeaderText('One Two Three Four Five', {
      width: 60,
      measure,
      maxLine: 2,
    });

    expect(result.line).toHaveLength(2);
    expect(result.truncated).toBe(true);
    expect(result.line[1]).toMatch(/…$/);
    expect(measure(result.line[1]!)).toBeLessThanOrEqual(60);
  });

  it('does not truncate when the content fits inside maxLine', () => {
    const result = wrapHeaderText('One Two', { width: 40, measure, maxLine: 3 });
    expect(result.truncated).toBe(false);
  });

  it('handles an empty header', () => {
    expect(wrapHeaderText('', { width: 100, measure }).line).toEqual([]);
  });

  it('returns the text unwrapped for a non-positive width rather than looping', () => {
    const result = wrapHeaderText('Some Header', { width: 0, measure });
    expect(result.line).toEqual(['Some Header']);
  });

  it('collapses runs of whitespace', () => {
    const result = wrapHeaderText('A   B', { width: 100, measure });
    expect(result.line).toEqual(['A B']);
  });
});

describe('headerHeightFor', () => {
  const option = { lineHeight: 16, padding: 8, minHeight: 32 };

  it('returns the minimum for single-line headers', () => {
    const wrapped = [
      { line: ['Name'], truncated: false },
      { line: ['Email'], truncated: false },
    ];
    expect(headerHeightFor(wrapped, option)).toBe(32);
  });

  it('sizes the whole band to the tallest header', () => {
    const wrapped = [
      { line: ['Name'], truncated: false },
      { line: ['Adjusted', 'Gross', 'Margin'], truncated: false },
    ];
    // 3 lines * 16 + 8 = 56, above the 32 minimum.
    expect(headerHeightFor(wrapped, option)).toBe(56);
  });

  it('never returns below the minimum for an empty set', () => {
    expect(headerHeightFor([], option)).toBe(32);
  });
});
