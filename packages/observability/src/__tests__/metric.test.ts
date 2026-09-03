import { describe, expect, it } from 'vitest';
import { GRID_GAUGE, createFrameRecorder, createMetricRegistry } from '../index';

describe('performance counters', () => {
  it('computes exact quantiles against a known distribution', () => {
    // 1..1000, each appearing once. Nearest-rank p50 of 1000 samples is the
    // 500th, p95 the 950th, p99 the 990th — values that really occurred.
    const recorder = createFrameRecorder({ windowSize: 1000, budgetMs: 1e9 });
    for (let i = 1; i <= 1000; i++) recorder.record(i);
    const stat = recorder.stat();
    expect(stat.p50Ms).toBe(500);
    expect(stat.p95Ms).toBe(950);
    expect(stat.p99Ms).toBe(990);
    expect(stat.minMs).toBe(1);
    expect(stat.maxMs).toBe(1000);
    expect(stat.meanMs).toBeCloseTo(500.5, 10);
    expect(recorder.quantile(0)).toBe(1);
    expect(recorder.quantile(1)).toBe(1000);
    expect(recorder.quantile(0.25)).toBe(250);
  });

  it('is order-independent — a shuffled input gives identical quantiles', () => {
    const sample = Array.from({ length: 1000 }, (_, i) => i + 1);
    for (let i = sample.length - 1; i > 0; i--) {
      const j = (i * 7919) % (i + 1);
      [sample[i], sample[j]] = [sample[j] as number, sample[i] as number];
    }
    const recorder = createFrameRecorder({ windowSize: 1000, budgetMs: 1e9 });
    for (const value of sample) recorder.record(value);
    expect(recorder.stat().p99Ms).toBe(990);
    expect(recorder.stat().p50Ms).toBe(500);
  });

  it('keeps quantiles honest with a partly filled window', () => {
    const recorder = createFrameRecorder({ windowSize: 1000, budgetMs: 1e9 });
    for (const value of [10, 20, 30, 40]) recorder.record(value);
    const stat = recorder.stat();
    expect(stat.windowCount).toBe(4);
    // The untouched tail of the ring must not be counted as 0ms frames.
    expect(stat.minMs).toBe(10);
    expect(stat.p50Ms).toBe(20);
    expect(stat.meanMs).toBe(25);
  });

  it('bounds memory — the window forgets old frames but count does not', () => {
    const recorder = createFrameRecorder({ windowSize: 8, budgetMs: 1e9 });
    for (let i = 1; i <= 100; i++) recorder.record(i);
    const stat = recorder.stat();
    expect(stat.count).toBe(100);
    expect(stat.windowCount).toBe(8);
    // Only the last eight frames survive: 93..100.
    expect(stat.minMs).toBe(93);
    expect(stat.maxMs).toBe(100);
  });

  it('accounts dropped frames against the budget', () => {
    const recorder = createFrameRecorder({ budgetMs: 16 });
    for (const ms of [8, 9, 40, 12, 33, 10, 11, 7, 60, 6]) recorder.record(ms);
    const stat = recorder.stat();
    expect(stat.count).toBe(10);
    expect(stat.droppedCount).toBe(3);
    expect(stat.dropRate).toBeCloseTo(0.3, 10);
    expect(stat.lastMs).toBe(6);
  });

  it('reports fps derived from the window mean', () => {
    const recorder = createFrameRecorder();
    for (let i = 0; i < 10; i++) recorder.record(20);
    expect(recorder.stat().fps).toBeCloseTo(50, 10);
  });

  it('returns a zeroed stat before any frame, rather than NaN', () => {
    const stat = createFrameRecorder().stat();
    expect(stat).toEqual({
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
    });
    expect(createFrameRecorder().quantile(0.99)).toBe(0);
  });

  it('times a frame through beginFrame with an injected clock', () => {
    let clock = 0;
    const recorder = createFrameRecorder({ now: () => clock, budgetMs: 16 });
    const end = recorder.beginFrame();
    clock = 24;
    expect(end()).toBe(24);
    // A second call must not double-count the frame.
    expect(end()).toBe(24);
    expect(recorder.stat().count).toBe(1);
    expect(recorder.stat().droppedCount).toBe(1);
  });

  it('ignores nonsense durations rather than poisoning the distribution', () => {
    const recorder = createFrameRecorder();
    recorder.record(Number.NaN);
    recorder.record(-5);
    recorder.record(Number.POSITIVE_INFINITY);
    expect(recorder.stat().count).toBe(0);
  });

  it('reset clears everything', () => {
    const recorder = createFrameRecorder();
    recorder.record(50);
    recorder.reset();
    expect(recorder.stat().count).toBe(0);
    expect(recorder.stat().p99Ms).toBe(0);
  });

  it('keeps gauges and counters apart', () => {
    const registry = createMetricRegistry();
    registry.setGauge(GRID_GAUGE.ROW_COUNT, 1_000_000);
    registry.setGauge(GRID_GAUGE.ROW_COUNT, 999_999);
    registry.incCounter('onegrid.block.fetch');
    registry.incCounter('onegrid.block.fetch');
    registry.incCounter('onegrid.block.fetch', 3);
    // A gauge is a level and is overwritten; a counter only ever adds.
    expect(registry.getGauge(GRID_GAUGE.ROW_COUNT)).toBe(999_999);
    expect(registry.getCounter('onegrid.block.fetch')).toBe(5);
    expect(registry.getCounter('never.touched')).toBe(0);
    expect(registry.getGauge('never.set')).toBeUndefined();
    registry.setGauge('bad', Number.NaN);
    expect(registry.getGauge('bad')).toBeUndefined();
  });

  it('snapshotMetric is an immutable point-in-time copy', () => {
    const registry = createMetricRegistry({ now: () => 555, budgetMs: 16 });
    registry.setGauge(GRID_GAUGE.ROW_COUNT, 42);
    registry.incCounter('onegrid.error');
    registry.frame.record(8);
    registry.frame.record(32);

    const snapshot = registry.snapshotMetric();
    expect(snapshot.ts).toBe(555);
    expect(snapshot.gauge[GRID_GAUGE.ROW_COUNT]).toBe(42);
    expect(snapshot.counter['onegrid.error']).toBe(1);
    expect(snapshot.frame.count).toBe(2);
    expect(snapshot.frame.droppedCount).toBe(1);

    // Mutating the registry afterwards must not reach back into the snapshot.
    registry.setGauge(GRID_GAUGE.ROW_COUNT, 0);
    registry.incCounter('onegrid.error');
    expect(snapshot.gauge[GRID_GAUGE.ROW_COUNT]).toBe(42);
    expect(snapshot.counter['onegrid.error']).toBe(1);
  });

  it('sampleMemory reports availability instead of guessing', () => {
    const registry = createMetricRegistry();
    const perf = globalThis.performance as unknown as Record<string, unknown>;
    const had = 'memory' in perf;
    if (!had) {
      Object.defineProperty(perf, 'memory', {
        value: { usedJSHeapSize: 1024, jsHeapSizeLimit: 4096 },
        configurable: true,
      });
    }
    expect(registry.sampleMemory()).toBe(true);
    expect(registry.getGauge(GRID_GAUGE.HEAP_USED_BYTE)).toBeGreaterThan(0);
    expect(registry.getGauge(GRID_GAUGE.HEAP_LIMIT_BYTE)).toBeGreaterThan(0);
    if (!had) delete perf['memory'];
  });

  it('reset clears the registry and its recorder together', () => {
    const registry = createMetricRegistry();
    registry.setGauge('g', 1);
    registry.incCounter('c');
    registry.frame.record(10);
    registry.reset();
    const snapshot = registry.snapshotMetric();
    expect(snapshot.gauge).toEqual({});
    expect(snapshot.counter).toEqual({});
    expect(snapshot.frame.count).toBe(0);
  });
});
