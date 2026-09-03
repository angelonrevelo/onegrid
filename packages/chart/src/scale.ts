// =============================================================================
// Scales + nice-number axis selection
//
// Charts need two mappings and one aesthetic judgement:
//
//   linearScale  — continuous value -> pixel, invertible (hit-testing needs
//                  the inverse, tooltips need it more than drawing does).
//   bandScale    — ordinal index -> a slot of pixels, with padding, so bars
//                  and category ticks agree on where a category lives.
//   niceDomain   — pick a domain and a tick step humans read without effort.
//
// The tick step comes from Heckbert's "nice numbers" (Graphics Gems, 1990):
// round the raw step up to the nearest 1, 2, 5 or 10 times a power of ten.
// The alternative — dividing the data extent into N equal parts — produces
// axes labelled 0, 13.7, 27.4 which nobody can read. Ticks are snapped back
// to the step's decimal precision because 0.1 * 3 is 0.30000000000000004 in
// binary floating point and an axis label must never show that.
// =============================================================================

/** @public */
export interface LinearScale {
  /** Value -> pixel. Values outside the domain extrapolate; we never clamp. */
  readonly scale: (value: number) => number;
  /** Pixel -> value. Exact inverse of `scale`. */
  readonly invert: (pixel: number) => number;
  readonly domain: readonly [number, number];
  readonly range: readonly [number, number];
}

/**
 * Build an invertible linear value->pixel mapping.
 *
 * A zero-width domain would divide by zero, so it degenerates to the midpoint
 * of the range — a flat series draws down the middle of its plot rather than
 * producing NaN coordinates that silently blank the canvas.
 * @public
 */
export function linearScale(
  domain: readonly [number, number],
  range: readonly [number, number],
): LinearScale {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0;
  if (span === 0 || !Number.isFinite(span)) {
    const mid = (r0 + r1) / 2;
    return {
      scale: () => mid,
      invert: () => d0,
      domain,
      range,
    };
  }
  const k = (r1 - r0) / span;
  return {
    scale: (value: number) => r0 + (value - d0) * k,
    invert: (pixel: number) => d0 + (pixel - r0) / k,
    domain,
    range,
  };
}

/** @public */
export interface BandScale {
  /** Number of bands. */
  readonly count: number;
  /** Left edge of band `index`, in pixels. */
  readonly start: (index: number) => number;
  /** Centre of band `index` — where a tick label or a line vertex belongs. */
  readonly center: (index: number) => number;
  /** Width of one band, after padding is removed. */
  readonly bandWidth: number;
  /** Distance between successive band starts (bandWidth + gap). */
  readonly step: number;
  /** Which band contains this pixel, or -1 if the pixel is in a gap or outside. */
  readonly indexAt: (pixel: number) => number;
  readonly range: readonly [number, number];
}

/**
 * Build an ordinal index->pixel-slot mapping.
 *
 * `padding` is the fraction of each step given to the gap, matching d3's
 * `paddingInner`. 0 makes bars touch; 0.2 is the readable default for a
 * column chart. Categories are laid out left to right across the range.
 * @public
 */
export function bandScale(
  count: number,
  range: readonly [number, number],
  padding = 0.2,
): BandScale {
  const [r0, r1] = range;
  const width = r1 - r0;
  const n = Math.max(0, Math.floor(count));
  const pad = Math.min(0.95, Math.max(0, padding));
  const step = n > 0 ? width / n : 0;
  const bandWidth = step * (1 - pad);
  const offset = (step - bandWidth) / 2;
  return {
    count: n,
    bandWidth,
    step,
    range,
    start: (index: number) => r0 + index * step + offset,
    center: (index: number) => r0 + index * step + step / 2,
    indexAt: (pixel: number) => {
      if (n === 0 || step === 0) return -1;
      const raw = (pixel - r0) / step;
      const index = Math.floor(raw);
      if (index < 0 || index >= n) return -1;
      // Reject pixels that landed in the inter-band gap: a click between two
      // bars selected neither of them.
      const within = pixel - (r0 + index * step);
      if (within < offset || within > offset + bandWidth) return -1;
      return index;
    },
  };
}

/** @public */
export interface NiceDomain {
  readonly min: number;
  readonly max: number;
  readonly step: number;
  /** Tick values from min to max inclusive, snapped to the step's precision. */
  readonly tick: ReadonlyArray<number>;
}

/**
 * Round `value` to the nearest 1/2/5/10 times a power of ten.
 *
 * `round: false` rounds up (used for the overall extent, which must not
 * shrink below the data); `round: true` rounds to nearest (used for the step,
 * where 2.3 should become 2 rather than 5).
 */
function niceNumber(value: number, round: boolean): number {
  const exponent = Math.floor(Math.log10(value));
  const fraction = value / Math.pow(10, exponent);
  let nice: number;
  if (round) {
    if (fraction < 1.5) nice = 1;
    else if (fraction < 3) nice = 2;
    else if (fraction < 7) nice = 5;
    else nice = 10;
  } else {
    if (fraction <= 1) nice = 1;
    else if (fraction <= 2) nice = 2;
    else if (fraction <= 5) nice = 5;
    else nice = 10;
  }
  return nice * Math.pow(10, exponent);
}

/**
 * Decimals a value at this step needs, so a label never reads
 * 0.30000000000000004.
 *
 * Read off the step's own decimal representation rather than its magnitude:
 * a step of 0.25 has magnitude 1e-1 but needs TWO decimals, and rounding it
 * to one would print 0.25 and 0.5 as "0.3" and "0.5" — an axis that skips a
 * value. Exponential notation (1e-7) is matched separately because
 * `toString()` switches to it below 1e-6.
 */
function decimalCount(step: number): number {
  if (step <= 0 || !Number.isFinite(step)) return 0;
  const text = step.toString();
  const exponential = /e-(\d+)$/.exec(text);
  if (exponential !== null) return Math.min(20, Number(exponential[1]));
  const dot = text.indexOf('.');
  return dot < 0 ? 0 : Math.min(20, text.length - dot - 1);
}

/**
 * Expand [min, max] outward to round numbers and enumerate the ticks between.
 *
 * Degenerate input is handled rather than propagated: a reversed range is
 * swapped, a single-point range is padded outward so the axis still has
 * extent, and non-finite input falls back to [0, 1] because a NaN domain
 * would poison every coordinate downstream.
 * @public
 */
export function niceDomain(min: number, max: number, tickCount = 5): NiceDomain {
  let lo = min;
  let hi = max;
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
    lo = 0;
    hi = 1;
  }
  if (lo > hi) {
    const swap = lo;
    lo = hi;
    hi = swap;
  }
  if (lo === hi) {
    if (lo === 0) {
      lo = -0.5;
      hi = 0.5;
    } else {
      const magnitude = Math.abs(lo);
      lo -= magnitude * 0.5;
      hi += magnitude * 0.5;
    }
  }
  const wanted = Math.max(2, Math.floor(tickCount));
  const extent = niceNumber(hi - lo, false);
  const step = niceNumber(extent / (wanted - 1), true);
  const niceMin = Math.floor(lo / step) * step;
  const niceMax = Math.ceil(hi / step) * step;
  const digit = decimalCount(step);
  const tick: number[] = [];
  // Iterate on an integer counter rather than accumulating `+= step`, which
  // drifts and can emit a phantom final tick past niceMax.
  const total = Math.round((niceMax - niceMin) / step);
  for (let i = 0; i <= total; i++) {
    tick.push(roundTo(niceMin + i * step, digit));
  }
  return {
    min: roundTo(niceMin, digit),
    max: roundTo(niceMax, digit),
    step,
    tick,
  };
}

function roundTo(value: number, digit: number): number {
  const factor = Math.pow(10, digit);
  // `+ 0` normalises -0 to 0 so a zero tick never formats as "-0".
  return Math.round(value * factor) / factor + 0;
}

/**
 * Format a tick value for display at the given step's precision. Large
 * magnitudes get k/M/B suffixes because a 40px axis gutter cannot hold
 * "1200000000".
 * @public
 */
export function formatTick(value: number, step: number): string {
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${trimZero(value / 1e9)}B`;
  if (abs >= 1e6) return `${trimZero(value / 1e6)}M`;
  if (abs >= 1e4) return `${trimZero(value / 1e3)}k`;
  return value.toFixed(decimalCount(step));
}

function trimZero(value: number): string {
  const fixed = value.toFixed(1);
  return fixed.endsWith('.0') ? fixed.slice(0, -2) : fixed;
}
