// =============================================================================
// Page-level sticky header
//
// The header band sticks to the top of the GRID container. That is correct for
// a grid that owns its own scrollport, and wrong for the very common case of a
// grid embedded in a long marketing/report/dashboard page, where the page
// scrolls and the grid does not: the header scrolls away with the document and
// the user is left reading unlabelled columns.
//
// Design decisions, and why:
//
//   1. THIS IS A GEOMETRY MODULE, NOT A DOM MODULE. It computes where the
//      header should be given the grid's bounding box and the viewport, and
//      returns a mode plus an offset. The renderer applies it. That keeps the
//      arithmetic — which is the part that is easy to get subtly wrong —
//      testable without a browser, and keeps DOM writes in one place.
//
//   2. `position: sticky` IS NOT ENOUGH ON ITS OWN. The header is painted into
//      a canvas, not laid out as a DOM box, so the browser cannot stick it for
//      us; and even in the DOM shadow, a sticky header inside a transformed or
//      `overflow: hidden` ancestor silently stops sticking. Computing the
//      offset ourselves is immune to both.
//
//   3. THE HEADER DETACHES AND RE-ATTACHES AT BOTH ENDS. Sticking must stop
//      when the grid's BOTTOM passes the viewport top, or the header floats
//      over whatever follows the grid — the single most common bug in
//      hand-rolled sticky headers. `resolveStickyHeader` returns `'docked'`
//      for that case, with the offset needed to park it at the grid's bottom
//      edge.
//
//   4. AN OCCLUDING TOP BAR IS AN INPUT. Pages have their own fixed navbars.
//      `viewportTop` lets the caller say "the usable viewport starts 64px
//      down", so the grid header stops underneath a site header instead of
//      behind it.
// =============================================================================

/** @public */
export type StickyHeaderMode =
  /** Grid is fully below the fold line: header sits in its natural place. */
  | 'natural'
  /** Header is floating at the viewport top while the grid scrolls past. */
  | 'stuck'
  /** Grid is scrolling out of view: header is parked at the grid's bottom. */
  | 'docked';

/** @public */
export interface StickyHeaderState {
  readonly mode: StickyHeaderMode;
  /**
   * Y offset in CSS px, relative to the grid container's top edge, at which
   * the header band should paint. Always >= 0.
   */
  readonly offset: number;
}

/** @public */
export interface StickyHeaderInput {
  /** Grid container's top edge relative to the viewport (a `getBoundingClientRect().top`). */
  readonly gridTop: number;
  /** Grid container's total height in CSS px. */
  readonly gridHeight: number;
  /** Header band height in CSS px. */
  readonly headerHeight: number;
  /**
   * Y coordinate of the usable viewport top — raise it to clear a page-level
   * fixed navbar. Default 0.
   */
  readonly viewportTop?: number;
}

/**
 * Where the header band belongs this frame.
 * @public
 */
export function resolveStickyHeader(input: StickyHeaderInput): StickyHeaderState {
  const { gridTop, gridHeight, headerHeight } = input;
  const viewportTop = input.viewportTop ?? 0;

  // The grid has not yet reached the fold: nothing to do.
  if (gridTop >= viewportTop) {
    return { mode: 'natural', offset: 0 };
  }

  // How far the grid's top has scrolled above the usable viewport top.
  const scrolledPast = viewportTop - gridTop;

  // Past this point the header would overhang the grid's bottom edge, so it
  // parks instead of floating free. See design note 3.
  const maxOffset = Math.max(0, gridHeight - headerHeight);

  if (scrolledPast >= maxOffset) {
    return { mode: 'docked', offset: maxOffset };
  }

  return { mode: 'stuck', offset: scrolledPast };
}

/**
 * Should the renderer repaint? Sticky offset changes on every page scroll
 * event, and repainting the canvas for a sub-pixel delta is waste.
 *
 * Returns true when the mode changed, or when the offset moved by at least one
 * device pixel — below that the paint is not observable.
 * @public
 */
export function stickyHeaderChanged(
  previous: StickyHeaderState | null,
  next: StickyHeaderState,
  devicePixelRatio = 1,
): boolean {
  if (previous === null) return true;
  if (previous.mode !== next.mode) return true;
  const epsilon = 1 / Math.max(1, devicePixelRatio);
  return Math.abs(previous.offset - next.offset) >= epsilon;
}
