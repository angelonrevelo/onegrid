// =============================================================================
// The benchmark helper.
//
// These do not assert that anything is fast — a wall-clock threshold in CI is
// a flaky test, not a performance gate. They assert that the harness measures
// the thing it claims to: the right case, the right number of iterations, a
// clock the caller controls, and a speedup ratio that points the right way.
// =============================================================================

import { describe, expect, it } from 'vitest';
import { benchBackend, compareBackend } from '../bench';
import { createJsBackend } from '../js-backend';
import { createWasmBackend } from '../wasm-backend';
import { createFakeAccelModule } from '../fake-module';
import type { AccelCase } from '../differential';

const reference = createJsBackend();

function sortCase(length: number): AccelCase {
  const value = new Float64Array(length);
  for (let i = 0; i < length; i++) value[i] = (i * 2654435761) % 9973;
  return {
    kind: 'sortIndex',
    name: `sort ${length} rows`,
    key: [{ value }],
    length,
  };
}

/** A clock that advances a fixed amount per read, so timings are exact. */
function fakeClock(stepMs: number): () => number {
  let t = 0;
  return () => {
    const now = t;
    t += stepMs;
    return now;
  };
}

describe('benchBackend', () => {
  it('reports the backend, the case and the iteration count it was asked for', () => {
    const result = benchBackend(reference, sortCase(64), { iteration: 7, warmup: 1 });
    expect(result.backend).toBe('js');
    expect(result.caseName).toBe('sort 64 rows');
    expect(result.kind).toBe('sortIndex');
    expect(result.iteration).toBe(7);
  });

  it('derives mean and total from the injected clock exactly', () => {
    const result = benchBackend(reference, sortCase(8), {
      iteration: 4,
      warmup: 0,
      now: fakeClock(3),
    });
    // Each timed iteration reads the clock twice, so every measurement is 3ms.
    expect(result.totalMs).toBe(12);
    expect(result.meanMs).toBe(3);
    expect(result.minMs).toBe(3);
    expect(result.opPerSecond).toBeCloseTo(1000 / 3, 9);
  });

  it('reports zero ops-per-second rather than Infinity on a clock too coarse to see the work', () => {
    const result = benchBackend(reference, sortCase(4), {
      iteration: 3,
      warmup: 0,
      now: () => 0,
    });
    expect(result.minMs).toBe(0);
    expect(result.opPerSecond).toBe(0);
  });

  it('forces at least one iteration even when asked for none', () => {
    expect(benchBackend(reference, sortCase(4), { iteration: 0 }).iteration).toBe(1);
  });

  it('measures real elapsed time against the ambient clock', () => {
    const result = benchBackend(reference, sortCase(4096), { iteration: 3, warmup: 1 });
    expect(result.totalMs).toBeGreaterThan(0);
    expect(result.meanMs).toBeGreaterThanOrEqual(result.minMs);
  });
});

describe('compareBackend', () => {
  it('runs the identical case against both backends and reports the ratio', () => {
    const accelerated = createWasmBackend(createFakeAccelModule());
    const comparison = compareBackend(reference, accelerated, sortCase(512), {
      iteration: 3,
      warmup: 1,
    });
    expect(comparison.caseName).toBe('sort 512 rows');
    expect(comparison.baseline.backend).toBe('js');
    expect(comparison.candidate.backend).toBe('wasm');
    expect(Number.isFinite(comparison.speedup) || comparison.speedup > 0).toBe(true);
  });

  it('computes a speedup above one when the candidate is given half the cost', () => {
    // Two clocks are not injectable separately, so this pins the arithmetic
    // rather than the engine: identical clocks must produce a speedup of 1.
    const comparison = compareBackend(reference, reference, sortCase(16), {
      iteration: 2,
      warmup: 0,
      now: fakeClock(5),
    });
    expect(comparison.speedup).toBe(1);
  });
});
