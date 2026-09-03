// =============================================================================
// Incremental redraw — the dirty-rect protocol
//
// The renderer currently repaints the whole canvas every frame it is asked to.
// That is the right default (it is simple and it is correct), but it is waste
// when the only thing that changed is one cell's value, a hover highlight, or
// a flash fade. This module tracks WHAT changed since the last painted frame
// and decides whether a partial repaint is worth it.
//
// Design decisions, and why:
//
//   1. THE TRACKER NEVER PAINTS. It accumulates damage in grid coordinates and
//      converts to device pixels only when asked. That keeps it unit-testable
//      without a canvas, and keeps DPR handling in exactly one place.
//
//   2. MERGING IS BOUNDED, NOT OPTIMAL. Computing the minimal covering set of
//      rectangles is expensive and the answer stops mattering after a handful
//      of regions: each scissor/clip has fixed GPU and CPU cost, so a dozen
//      tight rectangles is slower than one loose one. The tracker merges
//      aggressively and, past `maxRegion`, collapses everything into a single
//      bounding box. Above `fullRedrawRatio` of the viewport it gives up and
//      reports a full redraw, because clipping to 85% of the screen costs more
//      than not clipping at all.
//
//   3. SCROLLING INVALIDATES EVERYTHING. Any scroll changes which rows map to
//      which pixels, so damage accumulated in grid coordinates is meaningless
//      across a scroll. Rather than trying to translate it, `noteScroll` marks
//      the frame full. Scroll frames are already the ones where the full-frame
//      path is fastest.
// =============================================================================

/** A rectangle in CSS pixels relative to the canvas origin. @public */
export interface DamageRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** What the renderer should do for the coming frame. @public */
export type RedrawPlan =
  | { readonly kind: 'none' }
  | { readonly kind: 'full' }
  | { readonly kind: 'partial'; readonly region: ReadonlyArray<DamageRect> };

/** @public */
export interface DamageTrackerOption {
  /**
   * Collapse to a single bounding box past this many pending regions. Each
   * region costs a clip/save/restore, so the crossover is low. Default 8.
   */
  readonly maxRegion?: number;
  /**
   * Report a full redraw once damage covers this fraction of the viewport.
   * Default 0.6 — past roughly two-thirds of the screen, clipping is a loss.
   */
  readonly fullRedrawRatio?: number;
}

/** @public */
export interface DamageTracker {
  /** Mark a rectangle in CSS pixels as needing repaint. */
  readonly damage: (rect: DamageRect) => void;
  /** Mark the whole frame. Any subsequent partial damage is subsumed. */
  readonly damageAll: () => void;
  /** A scroll happened; grid-coordinate damage no longer maps to pixels. */
  readonly noteScroll: () => void;
  /** Decide the plan for this frame, given the current viewport size. */
  readonly plan: (viewport: { width: number; height: number }) => RedrawPlan;
  /** Clear accumulated damage. Call after the frame has been painted. */
  readonly clear: () => void;
  /** Pending region count, before merging. Diagnostics only. */
  readonly pendingCount: () => number;
}

/** Do the two rectangles touch or overlap? @public */
export function intersects(a: DamageRect, b: DamageRect): boolean {
  return !(
    a.x + a.width < b.x ||
    b.x + b.width < a.x ||
    a.y + a.height < b.y ||
    b.y + b.height < a.y
  );
}

/** The smallest rectangle containing both. @public */
export function union(a: DamageRect, b: DamageRect): DamageRect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const right = Math.max(a.x + a.width, b.x + b.width);
  const bottom = Math.max(a.y + a.height, b.y + b.height);
  return { x, y, width: right - x, height: bottom - y };
}

/** @public */
export function area(rect: DamageRect): number {
  return Math.max(0, rect.width) * Math.max(0, rect.height);
}

/**
 * Merge overlapping/touching rectangles until none intersect.
 *
 * O(n²) per pass, which is fine because n is bounded by `maxRegion` — and
 * bounding it is exactly why that cap exists.
 * @public
 */
export function mergeRegion(region: ReadonlyArray<DamageRect>): DamageRect[] {
  const out: DamageRect[] = [];

  for (const next of region) {
    let merged = next;
    let index = 0;
    while (index < out.length) {
      const existing = out[index]!;
      if (intersects(existing, merged)) {
        merged = union(existing, merged);
        out.splice(index, 1);
        index = 0; // restart: the union may now touch something already passed
        continue;
      }
      index++;
    }
    out.push(merged);
  }

  return out;
}

/** @public */
export function createDamageTracker(option: DamageTrackerOption = {}): DamageTracker {
  const maxRegion = option.maxRegion ?? 8;
  const fullRedrawRatio = option.fullRedrawRatio ?? 0.6;

  let pending: DamageRect[] = [];
  let full = false;

  const damage = (rect: DamageRect): void => {
    if (full) return;
    if (rect.width <= 0 || rect.height <= 0) return;
    pending.push(rect);
  };

  const damageAll = (): void => {
    full = true;
    pending = [];
  };

  return {
    damage,
    damageAll,
    noteScroll: damageAll,
    pendingCount: () => pending.length,
    clear: () => {
      pending = [];
      full = false;
    },
    plan: (viewport) => {
      if (full) return { kind: 'full' };
      if (pending.length === 0) return { kind: 'none' };

      let region = mergeRegion(pending);

      // Too many regions to clip individually: collapse to one bounding box.
      if (region.length > maxRegion) {
        region = [region.reduce(union)];
      }

      const viewportArea = viewport.width * viewport.height;
      if (viewportArea > 0) {
        const damaged = region.reduce((sum, r) => sum + area(r), 0);
        if (damaged / viewportArea >= fullRedrawRatio) return { kind: 'full' };
      }

      return { kind: 'partial', region };
    },
  };
}
