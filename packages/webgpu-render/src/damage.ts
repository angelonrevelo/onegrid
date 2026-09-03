// =============================================================================
// Damage tracking and scissor planning.
//
// Redrawing only what changed is obviously cheaper than redrawing everything —
// right up until it is not. Every scissor rect costs a setScissorRect plus a
// draw call, and a draw call that covers 20 pixels still pays the full pipeline
// setup, the vertex fetch for every instance in the buffer, and the depth/
// stencil state validation. Past some coverage fraction, N small scissored
// draws are slower than one full-viewport draw, and BELOW some rect count the
// per-rect overhead dominates the pixels saved.
//
// The crossover is a property of the GPU, the driver and the pipeline — not a
// number anyone can derive at a desk. Published guesses range from 10% to 50%
// coverage, which is the tell that they are guesses. So this module does not
// hardcode one. calibrateDamageThreshold() derives it from timing samples the
// host actually measured on the machine it is running on, and
// DEFAULT_DAMAGE_THRESHOLD exists only as a documented starting value for the
// first few frames before calibration has data. measureDamageCrossover() runs
// the probe; it takes the frame-timing function as an argument so it can be
// driven by a real renderer in the browser and by a synthetic cost model in a
// test, with identical logic in both.
// =============================================================================

/** An axis-aligned rect in viewport pixels. y grows downward. */
export interface DamageRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface Viewport {
  readonly width: number;
  readonly height: number;
}

/** Area in pixels. Negative or zero extents count as zero, not as an error —
 *  an empty damage rect is a normal outcome of clipping. */
export function rectArea(rect: DamageRect): number {
  return Math.max(0, rect.width) * Math.max(0, rect.height);
}

/** Do two rects touch or overlap, allowing `gap` pixels of separation? */
export function rectAdjacent(a: DamageRect, b: DamageRect, gap = 0): boolean {
  return (
    a.x <= b.x + b.width + gap &&
    b.x <= a.x + a.width + gap &&
    a.y <= b.y + b.height + gap &&
    b.y <= a.y + a.height + gap
  );
}

/** Smallest rect containing both inputs. */
export function unionRect(a: DamageRect, b: DamageRect): DamageRect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const right = Math.max(a.x + a.width, b.x + b.width);
  const bottom = Math.max(a.y + a.height, b.y + b.height);
  return { x, y, width: right - x, height: bottom - y };
}

/** Clip to the viewport and snap outward to integers — scissor rects are
 *  integral, and rounding inward would leave a one-pixel seam of stale colour. */
export function clipRect(rect: DamageRect, viewport: Viewport): DamageRect | null {
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(viewport.width, Math.ceil(rect.x + rect.width));
  const y1 = Math.min(viewport.height, Math.ceil(rect.y + rect.height));
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

export interface MergeDamageOption {
  /** Rects within this many px of each other merge. Small non-zero values pay
   *  off: two adjacent dirty cells share a draw call instead of costing two. */
  readonly gapPx?: number;
  /** Hard cap on rect count. Beyond it, the cheapest pairs are force-merged. */
  readonly maxRect?: number;
}

/**
 * Merge overlapping and near-adjacent rects, then force the count down to
 * `maxRect` by repeatedly unioning the pair whose union wastes the least new
 * area. The greedy choice is not optimal — optimal rectangle covering is
 * NP-hard — but it is O(n^3) worst case on an n that is capped at a few dozen,
 * and it never picks the pathological pair a first-fit merge would.
 *
 * The output rects are pairwise non-overlapping, because merging runs to a
 * fixed point: any pair that overlapped got unioned.
 */
export function mergeDamageRect(
  rect: readonly DamageRect[],
  option: MergeDamageOption = {},
): DamageRect[] {
  const gapPx = option.gapPx ?? 0;
  const maxRect = option.maxRect ?? 16;
  let current = rect.filter((r) => rectArea(r) > 0);

  let changed = true;
  while (changed) {
    changed = false;
    outer: for (let i = 0; i < current.length; i++) {
      for (let j = i + 1; j < current.length; j++) {
        const a = current[i]!;
        const b = current[j]!;
        if (!rectAdjacent(a, b, gapPx)) continue;
        const merged = unionRect(a, b);
        const next = current.filter((_, k) => k !== i && k !== j);
        next.push(merged);
        current = next;
        changed = true;
        break outer;
      }
    }
  }

  while (current.length > maxRect) {
    let bestI = 0;
    let bestJ = 1;
    let bestWaste = Infinity;
    for (let i = 0; i < current.length; i++) {
      for (let j = i + 1; j < current.length; j++) {
        const a = current[i]!;
        const b = current[j]!;
        const waste = rectArea(unionRect(a, b)) - rectArea(a) - rectArea(b);
        if (waste < bestWaste) {
          bestWaste = waste;
          bestI = i;
          bestJ = j;
        }
      }
    }
    const merged = unionRect(current[bestI]!, current[bestJ]!);
    current = current.filter((_, k) => k !== bestI && k !== bestJ);
    current.push(merged);
  }

  return current;
}

/** How the frame should be drawn. */
export type DamageMode = 'none' | 'scissor' | 'full';

export interface DamagePlan {
  readonly mode: DamageMode;
  /** Scissor rects to draw, viewport-clipped and merged. For 'full' this is
   *  the single viewport rect; for 'none' it is empty. */
  readonly rect: readonly DamageRect[];
  /** Damaged fraction of the viewport, 0..1. */
  readonly coverage: number;
  /** Threshold the decision was made against — logged so a surprising
   *  full-frame redraw can be traced to its calibration. */
  readonly threshold: number;
}

/**
 * Starting threshold, in viewport coverage fraction, used before calibration
 * has run. Chosen from the low end of the published range because an
 * unnecessary full redraw is a bounded cost while an over-scissored frame on a
 * tiled GPU can be several times worse.
 */
export const DEFAULT_DAMAGE_THRESHOLD = 0.3;

export interface DamagePlanOption extends MergeDamageOption {
  /** Coverage fraction above which a full-frame redraw wins. */
  readonly threshold?: number;
}

/** Turn raw damage into a draw plan. */
export function planDamage(
  rect: readonly DamageRect[],
  viewport: Viewport,
  option: DamagePlanOption = {},
): DamagePlan {
  const threshold = option.threshold ?? DEFAULT_DAMAGE_THRESHOLD;
  const viewportArea = Math.max(1, viewport.width * viewport.height);
  const fullRect: DamageRect = {
    x: 0,
    y: 0,
    width: viewport.width,
    height: viewport.height,
  };

  const clipped: DamageRect[] = [];
  for (const r of rect) {
    const c = clipRect(r, viewport);
    if (c) clipped.push(c);
  }
  if (clipped.length === 0) {
    return { mode: 'none', rect: [], coverage: 0, threshold };
  }

  const merged = mergeDamageRect(clipped, option);
  let area = 0;
  for (const r of merged) area += rectArea(r);
  const coverage = Math.min(1, area / viewportArea);

  if (coverage >= threshold) {
    return { mode: 'full', rect: [fullRect], coverage, threshold };
  }
  return { mode: 'scissor', rect: merged, coverage, threshold };
}

// -----------------------------------------------------------------------------
// Calibration
// -----------------------------------------------------------------------------

/** One measured point: how long a frame took each way at this coverage. */
export interface DamageSample {
  readonly coverage: number;
  readonly scissorMs: number;
  readonly fullMs: number;
}

export interface DamageCalibration {
  readonly threshold: number;
  readonly sampleCount: number;
  /** False when the samples never crossed, so the threshold is a clamp
   *  (0 or 1) rather than an interpolated crossing. */
  readonly measured: boolean;
  readonly sample: readonly DamageSample[];
}

/**
 * Derive the crossover coverage from measured samples: the coverage at which
 * scissored drawing stops being cheaper than a full redraw.
 *
 * We linearly interpolate the zero of (scissorMs - fullMs) between the last
 * sample where scissor won and the first where it lost. Interpolating rather
 * than taking the first losing sample matters when the probe uses a coarse
 * coverage ladder — snapping to the sample would bias the threshold upward by
 * up to a whole step, and every frame in that band would then scissor when it
 * should not.
 */
export function calibrateDamageThreshold(
  sample: readonly DamageSample[],
): DamageCalibration {
  const sorted = [...sample].sort((a, b) => a.coverage - b.coverage);
  if (sorted.length === 0) {
    return {
      threshold: DEFAULT_DAMAGE_THRESHOLD,
      sampleCount: 0,
      measured: false,
      sample: [],
    };
  }

  const delta = sorted.map((s) => s.scissorMs - s.fullMs);
  const firstLoss = delta.findIndex((d) => d >= 0);

  if (firstLoss < 0) {
    // Scissoring won everywhere sampled: never redraw the full frame.
    return { threshold: 1, sampleCount: sorted.length, measured: false, sample: sorted };
  }
  if (firstLoss === 0) {
    // Scissoring lost even at the smallest coverage sampled: always full.
    return { threshold: 0, sampleCount: sorted.length, measured: false, sample: sorted };
  }

  const lo = sorted[firstLoss - 1]!;
  const hi = sorted[firstLoss]!;
  const dLo = delta[firstLoss - 1]!;
  const dHi = delta[firstLoss]!;
  const span = dHi - dLo;
  const t = span === 0 ? 0 : -dLo / span;
  const threshold = lo.coverage + t * (hi.coverage - lo.coverage);
  return {
    threshold: Math.max(0, Math.min(1, threshold)),
    sampleCount: sorted.length,
    measured: true,
    sample: sorted,
  };
}

export interface MeasureDamageCrossoverOption {
  /** Coverage ladder to probe. Defaults to 5% .. 80%. */
  readonly coverage?: readonly number[];
  /** Times one frame drawn `mode`-wise at the given coverage, in ms. */
  readonly runFrame: (mode: 'scissor' | 'full', coverage: number) => number | Promise<number>;
  /** Repeats per point; the MEDIAN is kept. A mean would let one scheduler
   *  hiccup move the threshold, and GPU timings are heavily right-tailed. */
  readonly repeat?: number;
}

const DEFAULT_COVERAGE_LADDER = [0.05, 0.1, 0.15, 0.2, 0.3, 0.4, 0.6, 0.8] as const;

function median(value: number[]): number {
  const sorted = [...value].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  if (sorted.length === 0) return 0;
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/**
 * Run the crossover probe and calibrate from what it measured. The host calls
 * this once at startup (or on a settings change) with a `runFrame` that renders
 * a synthetic frame of the requested damage coverage and returns its duration.
 */
export async function measureDamageCrossover(
  option: MeasureDamageCrossoverOption,
): Promise<DamageCalibration> {
  const ladder = option.coverage ?? DEFAULT_COVERAGE_LADDER;
  const repeat = Math.max(1, option.repeat ?? 5);
  const sample: DamageSample[] = [];
  for (const coverage of ladder) {
    const scissorRun: number[] = [];
    const fullRun: number[] = [];
    for (let i = 0; i < repeat; i++) {
      scissorRun.push(await option.runFrame('scissor', coverage));
      fullRun.push(await option.runFrame('full', coverage));
    }
    sample.push({
      coverage,
      scissorMs: median(scissorRun),
      fullMs: median(fullRun),
    });
  }
  return calibrateDamageThreshold(sample);
}
