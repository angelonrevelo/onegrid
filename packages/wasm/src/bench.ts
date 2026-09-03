// =============================================================================
// benchBackend — so "faster" is a number
//
// The claim this package makes to the rest of the repo is a performance claim,
// and a performance claim without a measurement is a wish. This is the smallest
// honest harness: a warmup phase (so the first run's JIT compilation and the
// first WASM call's memory growth are not counted as steady-state cost), a
// fixed iteration count, and both a mean and a minimum.
//
// The minimum is reported because it is the statistic that matters here. Grid
// interaction latency is dominated by the best case the machine can deliver;
// the mean is polluted by GC pauses and by whatever else the developer's
// laptop is doing, and a benchmark that reports only the mean will report a
// regression that is really a background browser tab.
// =============================================================================

import type { AccelBackend } from './types';
import type { AccelCase } from './differential';
import { runCase } from './differential';

/** @public */
export interface BenchOption {
  /** Timed repetitions. Default 50. */
  readonly iteration?: number;
  /** Untimed repetitions run first. Default 5. */
  readonly warmup?: number;
  /** Clock source. Defaults to `performance.now` where it exists, else `Date.now`. */
  readonly now?: () => number;
}

/** @public */
export interface BenchResult {
  readonly backend: string;
  readonly caseName: string;
  readonly kind: AccelCase['kind'];
  readonly iteration: number;
  readonly totalMs: number;
  readonly meanMs: number;
  readonly minMs: number;
  /** Calls per second derived from `minMs`; 0 when the clock is too coarse to see one. */
  readonly opPerSecond: number;
}

function defaultNow(): () => number {
  const perf = (globalThis as { performance?: { now?: () => number } }).performance;
  return typeof perf?.now === 'function' ? () => perf.now!() : () => Date.now();
}

/** Time one reified case against one backend. @public */
export function benchBackend(
  backend: AccelBackend,
  testCase: AccelCase,
  option: BenchOption = {},
): BenchResult {
  const iteration = Math.max(1, option.iteration ?? 50);
  const warmup = Math.max(0, option.warmup ?? 5);
  const now = option.now ?? defaultNow();

  for (let i = 0; i < warmup; i++) runCase(backend, testCase);

  let total = 0;
  let min = Number.POSITIVE_INFINITY;
  for (let i = 0; i < iteration; i++) {
    const start = now();
    runCase(backend, testCase);
    const elapsed = now() - start;
    total += elapsed;
    if (elapsed < min) min = elapsed;
  }
  const safeMin = Number.isFinite(min) ? min : 0;
  return {
    backend: backend.name,
    caseName: testCase.name,
    kind: testCase.kind,
    iteration,
    totalMs: total,
    meanMs: total / iteration,
    minMs: safeMin,
    opPerSecond: safeMin > 0 ? 1000 / safeMin : 0,
  };
}

/** @public */
export interface BenchComparison {
  readonly caseName: string;
  readonly baseline: BenchResult;
  readonly candidate: BenchResult;
  /** baseline.minMs / candidate.minMs. Above 1 means the candidate is faster. */
  readonly speedup: number;
}

/**
 * Bench two backends over the same case. The case is a value, so this is
 * necessarily the identical workload — which is the failure mode of most
 * hand-written A/B benchmarks.
 * @public
 */
export function compareBackend(
  baseline: AccelBackend,
  candidate: AccelBackend,
  testCase: AccelCase,
  option: BenchOption = {},
): BenchComparison {
  const a = benchBackend(baseline, testCase, option);
  const b = benchBackend(candidate, testCase, option);
  return {
    caseName: testCase.name,
    baseline: a,
    candidate: b,
    speedup: b.minMs > 0 ? a.minMs / b.minMs : Number.POSITIVE_INFINITY,
  };
}
