// =============================================================================
// Text layout — advance + kerning positioning, ellipsis truncation, alignment.
//
// This is deliberately SHAPING-FREE. A real shaper (HarfBuzz) resolves ligature
// substitution, contextual alternates and bidi reordering; it is ~1 MB of WASM
// and it is the wrong trade for a grid, where the overwhelming majority of
// cells are numbers, dates, identifiers and short Latin labels. What a grid
// cannot get away with skipping is per-pair KERNING — unkerned "Yo" and "AV" in
// a header row are visible as uneven spacing on any screen — so we do the pair
// adjustment and skip everything else. The GlyphMetricSource supplies the pair
// values, which means an adopter who does have a shaper can feed real GPOS data
// through the same interface without touching this file.
//
// Measurement and layout share ONE advance accumulator (advanceRun). That is
// not a tidiness preference: if measurement and drawing disagree by a fraction
// of a pixel, ellipsis truncation picks a different cut point than the drawing
// pass and text either overflows its cell or clips a character early. The two
// paths must be the same arithmetic, so they are the same function.
//
// Coordinates are pixels, y grows downward (viewport convention), and the
// returned pen positions are BASELINE positions — which is what the glyph quad
// builder needs, and what a Canvas-2D fillText call would take, so the two
// renderers can be compared pixel-for-pixel during the migration.
// =============================================================================

import type { GlyphMetricSource } from './glyph-source.js';

/** Horizontal alignment inside the cell's content box. */
export type HorizontalAlign = 'left' | 'center' | 'right';
/** Vertical alignment inside the cell's content box. */
export type VerticalAlign = 'top' | 'middle' | 'bottom';

/** One positioned glyph. `penX` is the pen, not the ink's left edge. */
export interface PositionedGlyph {
  readonly codePoint: number;
  readonly penX: number;
  readonly penY: number;
  /** Advance actually applied after this glyph, kerning included. */
  readonly advance: number;
}

export interface TextMetric {
  /** Total advance width, kerning included. */
  readonly width: number;
  readonly ascent: number;
  readonly descent: number;
  /** Code point count, which is NOT the UTF-16 length for astral characters. */
  readonly glyphCount: number;
}

/** Iterate code points — `for...of` on a string already does this correctly,
 *  including surrogate pairs, which a naive charCodeAt loop does not. */
function codePointList(text: string): number[] {
  const out: number[] = [];
  for (const ch of text) out.push(ch.codePointAt(0)!);
  return out;
}

/**
 * The single accumulator every other function in this file goes through.
 * Calls `visit` with the pen position of each glyph and returns total width.
 */
function advanceRun(
  codePoint: readonly number[],
  source: GlyphMetricSource,
  visit?: (codePoint: number, penX: number, advance: number, index: number) => void,
): number {
  let penX = 0;
  for (let i = 0; i < codePoint.length; i++) {
    const cp = codePoint[i]!;
    let advance = source.advanceOf(cp);
    const next = codePoint[i + 1];
    // Kerning belongs to the PAIR, so it is folded into the left glyph's
    // advance. Folding it into the right glyph's position instead would give
    // the same visual result but a different last-glyph total width, and the
    // total is what truncation compares against.
    if (next !== undefined) advance += source.kernOf(cp, next);
    visit?.(cp, penX, advance, i);
    penX += advance;
  }
  return penX;
}

/** Measure a string. Matches layoutText exactly, by construction. */
export function measureText(text: string, source: GlyphMetricSource): TextMetric {
  const codePoint = codePointList(text);
  return {
    width: advanceRun(codePoint, source),
    ascent: source.ascentPx,
    descent: source.descentPx,
    glyphCount: codePoint.length,
  };
}

export interface TruncateResult {
  readonly text: string;
  readonly width: number;
  readonly truncated: boolean;
}

/**
 * Cut `text` to fit `maxWidth`, appending `ellipsis` when it does not.
 *
 * The subtlety is that the ellipsis has its own width AND its own kern pair
 * against whatever character ends up before it, so you cannot cut to
 * `maxWidth - ellipsisWidth` and append. We grow the kept prefix one code point
 * at a time and re-measure prefix+ellipsis, which is O(n^2) in the worst case
 * but n is a cell's worth of characters and the alternative (a binary search
 * over cut points) is wrong when kerning makes width non-monotonic in the
 * removed-character count.
 *
 * When even the ellipsis does not fit, the result is the empty string — never a
 * partial ellipsis, which reads as a stray dot.
 */
export function truncateToWidth(
  text: string,
  maxWidth: number,
  source: GlyphMetricSource,
  ellipsis = '…',
): TruncateResult {
  const codePoint = codePointList(text);
  const full = advanceRun(codePoint, source);
  if (full <= maxWidth) return { text, width: full, truncated: false };

  const ellipsisPoint = codePointList(ellipsis);
  const ellipsisWidth = advanceRun(ellipsisPoint, source);
  if (ellipsisWidth > maxWidth) return { text: '', width: 0, truncated: true };

  let bestCount = 0;
  let bestWidth = ellipsisWidth;
  for (let count = 1; count <= codePoint.length; count++) {
    const candidate = [...codePoint.slice(0, count), ...ellipsisPoint];
    const candidateWidth = advanceRun(candidate, source);
    if (candidateWidth > maxWidth) break;
    bestCount = count;
    bestWidth = candidateWidth;
  }
  const kept = codePoint
    .slice(0, bestCount)
    .map((cp) => String.fromCodePoint(cp))
    .join('');
  return { text: kept + ellipsis, width: bestWidth, truncated: true };
}

export interface CellTextLayoutOption {
  readonly text: string;
  readonly source: GlyphMetricSource;
  /** Cell rect in viewport pixels. */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly paddingX?: number;
  readonly paddingY?: number;
  readonly align?: HorizontalAlign;
  readonly verticalAlign?: VerticalAlign;
  /** Scale applied to the source's em size, e.g. 14px text off a 48px source. */
  readonly scale?: number;
  readonly ellipsis?: string;
}

export interface CellTextLayout {
  readonly glyph: readonly PositionedGlyph[];
  /** Baseline y in viewport pixels. */
  readonly baselineY: number;
  /** Left edge of the laid-out run in viewport pixels. */
  readonly originX: number;
  readonly width: number;
  readonly truncated: boolean;
  /** Text actually drawn — differs from the input when truncated. */
  readonly text: string;
}

/**
 * Lay one cell's text out: truncate to the content box, align horizontally and
 * vertically, and emit baseline-relative pen positions in viewport pixels.
 *
 * `scale` exists because the atlas rasterises at a fixed em (48px by default)
 * while cells render at whatever the theme says. Metrics are measured in source
 * units and multiplied once here, rather than scaling every advance inside the
 * accumulator — one multiply per glyph instead of three, and truncation still
 * compares like with like because the content width is divided into source
 * units before the comparison.
 */
export function layoutCellText(option: CellTextLayoutOption): CellTextLayout {
  const {
    text,
    source,
    x,
    y,
    width,
    height,
    paddingX = 0,
    paddingY = 0,
    align = 'left',
    verticalAlign = 'middle',
    scale = 1,
    ellipsis = '…',
  } = option;

  const contentWidth = Math.max(0, width - paddingX * 2);
  const contentHeight = Math.max(0, height - paddingY * 2);
  const sourceWidthBudget = scale > 0 ? contentWidth / scale : 0;

  const fit = truncateToWidth(text, sourceWidthBudget, source, ellipsis);
  const runWidth = fit.width * scale;

  let originX = x + paddingX;
  if (align === 'center') originX = x + paddingX + (contentWidth - runWidth) / 2;
  else if (align === 'right') originX = x + paddingX + (contentWidth - runWidth);

  const ascent = source.ascentPx * scale;
  const descent = source.descentPx * scale;
  let baselineY = y + paddingY + ascent;
  if (verticalAlign === 'middle') {
    // Centre the ink box (ascent + descent), not the line box. Grid rows are
    // sized by the theme, not by the font's line height, so centring the line
    // box leaves text visibly high in a tight row.
    baselineY = y + paddingY + (contentHeight - (ascent + descent)) / 2 + ascent;
  } else if (verticalAlign === 'bottom') {
    baselineY = y + paddingY + contentHeight - descent;
  }

  const glyph: PositionedGlyph[] = [];
  advanceRun(codePointList(fit.text), source, (codePoint, penX, advance) => {
    glyph.push({
      codePoint,
      penX: originX + penX * scale,
      penY: baselineY,
      advance: advance * scale,
    });
  });

  return {
    glyph,
    baselineY,
    originX,
    width: runWidth,
    truncated: fit.truncated,
    text: fit.text,
  };
}

/**
 * Content width a column needs to show `sample` without truncation — the
 * measurement path an auto-size column fit calls. Returns the widest sample
 * plus twice the padding, so it is directly assignable as a column width.
 */
export function measureColumnWidth(
  sample: readonly string[],
  source: GlyphMetricSource,
  option: { readonly scale?: number; readonly paddingX?: number } = {},
): number {
  const scale = option.scale ?? 1;
  const paddingX = option.paddingX ?? 0;
  let widest = 0;
  for (const value of sample) {
    const w = measureText(value, source).width;
    if (w > widest) widest = w;
  }
  return widest * scale + paddingX * 2;
}
