// =============================================================================
// Paper geometry.
//
// Sizes are stored PORTRAIT and in points, exactly as the PDF and CSS `@page`
// specifications define them, and rotated on demand. Storing one orientation
// and deriving the other is the only way `landscape` can never disagree with
// `portrait` — a table of eight literals would eventually drift.
//
// A4 is 210 x 297 mm = 595.28 x 841.89 pt. We keep the fractional value: PDF
// consumers compare page boxes and a rounded A4 is visibly not A4 when two
// documents are merged.
// =============================================================================

import type { PageBox, PageMargin, PageOption, PageOrientation, PageSizeName } from './types';

/** Points per inch. PostScript's definition, and PDF's user-space unit. */
const PT_PER_INCH = 72;
/** Points per millimetre. */
const PT_PER_MM = PT_PER_INCH / 25.4;

/**
 * Named paper sizes in points, portrait. Values are exact conversions of the
 * ISO 216 millimetre sizes and the US ANSI inch sizes.
 * @public
 */
export const PAGE_SIZE_POINT: Readonly<Record<PageSizeName, { width: number; height: number }>> = {
  A4: { width: 210 * PT_PER_MM, height: 297 * PT_PER_MM },
  A3: { width: 297 * PT_PER_MM, height: 420 * PT_PER_MM },
  Letter: { width: 8.5 * PT_PER_INCH, height: 11 * PT_PER_INCH },
  Legal: { width: 8.5 * PT_PER_INCH, height: 14 * PT_PER_INCH },
};

/** Default margin: half an inch on every side. @public */
export const DEFAULT_MARGIN: PageMargin = { top: 36, right: 36, bottom: 36, left: 36 };

/** Convert millimetres to points. @public */
export function mmToPoint(mm: number): number {
  return mm * PT_PER_MM;
}

/** Convert inches to points. @public */
export function inchToPoint(inch: number): number {
  return inch * PT_PER_INCH;
}

function resolveMargin(margin: PageOption['margin']): PageMargin {
  if (margin === undefined) return DEFAULT_MARGIN;
  if (typeof margin === 'number') {
    return { top: margin, right: margin, bottom: margin, left: margin };
  }
  return {
    top: margin.top ?? DEFAULT_MARGIN.top,
    right: margin.right ?? DEFAULT_MARGIN.right,
    bottom: margin.bottom ?? DEFAULT_MARGIN.bottom,
    left: margin.left ?? DEFAULT_MARGIN.left,
  };
}

/**
 * Resolve a `PageOption` into a concrete box. Orientation is applied by
 * swapping the stored portrait dimensions, so `landscape` of any size — named
 * or custom — is always exactly the transpose.
 * @public
 */
export function resolvePageBox(page: PageOption = {}): PageBox {
  const named = page.size ?? 'A4';
  const base = typeof named === 'string' ? PAGE_SIZE_POINT[named] : named;
  const orientation: PageOrientation = page.orientation ?? 'portrait';
  const width = orientation === 'landscape' ? base.height : base.width;
  const height = orientation === 'landscape' ? base.width : base.height;
  const margin = resolveMargin(page.margin);

  // Margins larger than the sheet would produce a negative content box and
  // every downstream loop would then run forever or emit nothing. Clamp at
  // zero and let the caller see an empty printable area instead.
  const contentWidth = Math.max(0, width - margin.left - margin.right);
  const contentHeight = Math.max(0, height - margin.top - margin.bottom);
  return { width, height, margin, contentWidth, contentHeight };
}
