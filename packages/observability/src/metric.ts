// =============================================================================
// Performance counters
//
// The grid's health is a distribution, not an average. A 60fps mean with a p99
// of 400ms is a janky grid, and a mean is exactly the statistic that hides it.
// So the frame recorder keeps quantiles.
//
// Design decisions:
//
//   - Quantiles come from a BOUNDED RESERVOIR — a fixed-capacity ring of the
//     most recent N frame durations (default 1024, roughly 17 seconds at 60fps)
//     — sorted only when a snapshot is taken. This is deliberate over both
//     alternatives. Sorting unbounded history is O(total) memory and grows
//     without limit in a grid left open all day. A P-squared streaming
//     estimator is O(1) but only APPROXIMATE, and an approximate p99 is hard to
//     act on when you are chasing a specific slow frame. A bounded ring is O(N)
//     memory with an EXACT answer over the recent window, which is the window
//     anyone actually cares about, and the sort is over at most 1024 doubles.
//
//   - The reservoir is a `Float64Array` allocated once. Frame recording runs
//     inside the render loop; it must not allocate, or the profiler ends up
//     measuring the profiler.
//
//   - Quantiles use the nearest-rank method (`ceil(q * n) - 1` on the sorted
//     window). It is the definition that returns an ACTUAL observed sample
//     rather than an interpolation between two, so "p99 = 41.2ms" names a frame
//     that really happened and can be hunted down in a trace.
//
//   - "Dropped" is counted against an explicit frame budget rather than
//     inferred from timestamps. The default budget is 16.67ms (60Hz). A frame
//     that overran the budget is dropped as far as the user's eye is concerned,
//     whether or not the browser also skipped a vsync.
//
//   - Gauges and counters are separate. A gauge is a level that is SET (row
//     count, heap bytes); a counter only ever increments (block fetches,
//     errors). Conflating them is how a metrics dashboard starts lying.
// =============================================================================

/** @public */
export interface FrameStat {
  /** Frames recorded since the last reset. Unbounded — not the window size. */
  readonly count: number;
  /** Frames that exceeded the budget. */
  readonly droppedCount: number;
  /** `droppedCount / count`, or 0 with no frames. */
  readonly dropRate: number;
  /** The following are computed over the retained window, not all history. */
  readonly windowCount: number;
  readonly meanMs: number;
  readonly minMs: number;
  readonly maxMs: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  /** Most recent frame duration, or 0 with no frames. */
  readonly lastMs: number;
  /** Frames per second implied by the window mean, or 0 with no frames. */
  readonly fps: number;
}

/** @public */
export interface FrameRecorderOption {
  /** Reservoir capacity. Default 1024 (~17s at 60fps). */
  readonly windowSize?: number;
  /** Over-budget frames count as dropped. Default 16.67 (60Hz). */
  readonly budgetMs?: number;
  /** Injectable monotonic clock for `beginFrame`. Default `performance.now`
   *  where available, else `Date.now`. */
  readonly now?: () => number;
}

/** @public */
export interface FrameRecorder {
  /** Record a completed frame's duration directly. */
  readonly record: (durationMs: number) => void;
  /** Start timing. Call the returned function when the frame is painted; it
   *  returns the measured duration. Safe to call once — a second call is a
   *  no-op returning the same duration, so a double-end cannot double-count. */
  readonly beginFrame: () => () => number;
  readonly stat: () => FrameStat;
  /** Exact quantile over the retained window. `q` in [0, 1]. */
  readonly quantile: (q: number) => number;
  readonly reset: () => void;
}

const DEFAULT_BUDGET_MS = 1000 / 60;

function defaultNow(): number {
  const perf = (globalThis as { performance?: { now?: () => number } }).performance;
  return typeof perf?.now === 'function' ? perf.now() : Date.now();
}

/** @public */
export function createFrameRecorder(option: FrameRecorderOption = {}): FrameRecorder {
  const windowSize = Math.max(1, Math.floor(option.windowSize ?? 1024));
  const budgetMs = option.budgetMs ?? DEFAULT_BUDGET_MS;
  const now = option.now ?? defaultNow;

  // Ring buffer. `filled` tracks how much of it is live so the first N frames
  // are not polluted by zeroes from the untouched tail.
  const ring = new Float64Array(windowSize);
  // Scratch buffer for sorting, allocated once. `stat()` may be called from a
  // devtools panel every frame; it must not churn the heap either.
  const scratch = new Float64Array(windowSize);
  let writeIndex = 0;
  let filled = 0;
  let count = 0;
  let droppedCount = 0;
  let lastMs = 0;

  const record = (durationMs: number): void => {
    if (!Number.isFinite(durationMs) || durationMs < 0) return;
    ring[writeIndex] = durationMs;
    writeIndex = (writeIndex + 1) % windowSize;
    if (filled < windowSize) filled++;
    count++;
    lastMs = durationMs;
    if (durationMs > budgetMs) droppedCount++;
  };

  /** Copy the live window into `scratch` and sort ascending. Returns its length. */
  const sortedWindow = (): number => {
    for (let i = 0; i < filled; i++) scratch[i] = ring[i] as number;
    const view = scratch.subarray(0, filled);
    view.sort();
    return filled;
  };

  const quantileFrom = (n: number, q: number): number => {
    if (n === 0) return 0;
    const clamped = q < 0 ? 0 : q > 1 ? 1 : q;
    // Nearest-rank: returns a real observation, never an interpolation.
    const rank = Math.ceil(clamped * n);
    const index = Math.min(n - 1, Math.max(0, rank - 1));
    return scratch[index] as number;
  };

  return {
    record,
    beginFrame() {
      const start = now();
      let done = false;
      let duration = 0;
      return () => {
        if (done) return duration;
        done = true;
        duration = now() - start;
        record(duration);
        return duration;
      };
    },
    quantile(q) {
      return quantileFrom(sortedWindow(), q);
    },
    stat() {
      const n = sortedWindow();
      if (n === 0) {
        return {
          count: 0,
          droppedCount: 0,
          dropRate: 0,
          windowCount: 0,
          meanMs: 0,
          minMs: 0,
          maxMs: 0,
          p50Ms: 0,
          p95Ms: 0,
          p99Ms: 0,
          lastMs: 0,
          fps: 0,
        };
      }
      let sum = 0;
      for (let i = 0; i < n; i++) sum += scratch[i] as number;
      const meanMs = sum / n;
      return {
        count,
        droppedCount,
        dropRate: droppedCount / count,
        windowCount: n,
        meanMs,
        minMs: scratch[0] as number,
        maxMs: scratch[n - 1] as number,
        p50Ms: quantileFrom(n, 0.5),
        p95Ms: quantileFrom(n, 0.95),
        p99Ms: quantileFrom(n, 0.99),
        lastMs,
        fps: meanMs > 0 ? 1000 / meanMs : 0,
      };
    },
    reset() {
      writeIndex = 0;
      filled = 0;
      count = 0;
      droppedCount = 0;
      lastMs = 0;
    },
  };
}

/**
 * Gauge names the registry knows about. Free-form names are also accepted;
 * these exist so the common ones are spelled the same everywhere.
 * @public
 */
export const GRID_GAUGE = Object.freeze({
  /** Total rows the datasource claims. */
  ROW_COUNT: 'grid.row.count',
  /** Rows currently materialised in memory. */
  ROW_LOADED: 'grid.row.loaded',
  /** Visible column count. */
  COLUMN_COUNT: 'grid.column.count',
  /** SSRM blocks resident in the block cache. */
  BLOCK_CACHED: 'grid.block.cached',
  /** JS heap bytes, when `performance.memory` is available. */
  HEAP_USED_BYTE: 'grid.memory.heap.used.byte',
  HEAP_LIMIT_BYTE: 'grid.memory.heap.limit.byte',
} as const);

/** @public */
export interface MetricSnapshot {
  readonly ts: number;
  readonly frame: FrameStat;
  readonly gauge: Readonly<Record<string, number>>;
  readonly counter: Readonly<Record<string, number>>;
}

/** @public */
export interface MetricRegistryOption extends FrameRecorderOption {
  /** Share an existing recorder rather than creating one. */
  readonly frame?: FrameRecorder;
}

/** @public */
export interface MetricRegistry {
  readonly frame: FrameRecorder;
  /** Set a level. Overwrites. */
  readonly setGauge: (name: string, value: number) => void;
  readonly getGauge: (name: string) => number | undefined;
  /** Increment a monotonic counter. `delta` defaults to 1. */
  readonly incCounter: (name: string, delta?: number) => void;
  readonly getCounter: (name: string) => number;
  /**
   * Read `performance.memory` where the browser exposes it (Chromium only) and
   * write it into the heap gauges. Returns false where unavailable, so a caller
   * can decide whether to show a memory panel at all.
   */
  readonly sampleMemory: () => boolean;
  /** Immutable point-in-time copy of every counter, gauge and frame statistic. */
  readonly snapshotMetric: () => MetricSnapshot;
  readonly reset: () => void;
}

interface MemoryLike {
  readonly usedJSHeapSize?: number;
  readonly jsHeapSizeLimit?: number;
}

/** @public */
export function createMetricRegistry(option: MetricRegistryOption = {}): MetricRegistry {
  const frame = option.frame ?? createFrameRecorder(option);
  const gauge = new Map<string, number>();
  const counter = new Map<string, number>();
  const now = option.now ?? defaultNow;

  return {
    frame,
    setGauge(name, value) {
      if (Number.isFinite(value)) gauge.set(name, value);
    },
    getGauge: (name) => gauge.get(name),
    incCounter(name, delta = 1) {
      if (!Number.isFinite(delta)) return;
      counter.set(name, (counter.get(name) ?? 0) + delta);
    },
    getCounter: (name) => counter.get(name) ?? 0,
    sampleMemory() {
      const memory = (globalThis as { performance?: { memory?: MemoryLike } }).performance?.memory;
      if (!memory || typeof memory.usedJSHeapSize !== 'number') return false;
      gauge.set(GRID_GAUGE.HEAP_USED_BYTE, memory.usedJSHeapSize);
      if (typeof memory.jsHeapSizeLimit === 'number') {
        gauge.set(GRID_GAUGE.HEAP_LIMIT_BYTE, memory.jsHeapSizeLimit);
      }
      return true;
    },
    snapshotMetric: () => ({
      ts: now(),
      frame: frame.stat(),
      gauge: Object.fromEntries(gauge),
      counter: Object.fromEntries(counter),
    }),
    reset() {
      frame.reset();
      gauge.clear();
      counter.clear();
    },
  };
}
