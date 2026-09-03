import { describe, it, expect } from 'vitest';
import {
  calibrateDamageThreshold,
  clipRect,
  measureDamageCrossover,
  mergeDamageRect,
  planDamage,
  rectAdjacent,
  rectArea,
  unionRect,
  DEFAULT_DAMAGE_THRESHOLD,
  type DamageRect,
} from '../damage.js';

const viewport = { width: 1000, height: 1000 };

describe('rect maths', () => {
  it('measures area and treats a degenerate rect as empty', () => {
    expect(rectArea({ x: 0, y: 0, width: 10, height: 4 })).toBe(40);
    expect(rectArea({ x: 0, y: 0, width: -10, height: 4 })).toBe(0);
  });

  it('detects overlap, touching and separation', () => {
    const a: DamageRect = { x: 0, y: 0, width: 10, height: 10 };
    expect(rectAdjacent(a, { x: 5, y: 5, width: 10, height: 10 })).toBe(true);
    expect(rectAdjacent(a, { x: 10, y: 0, width: 10, height: 10 })).toBe(true);
    expect(rectAdjacent(a, { x: 20, y: 0, width: 10, height: 10 })).toBe(false);
    expect(rectAdjacent(a, { x: 20, y: 0, width: 10, height: 10 }, 12)).toBe(true);
  });

  it('unions to the bounding rect', () => {
    expect(
      unionRect({ x: 0, y: 0, width: 10, height: 10 }, { x: 20, y: 5, width: 10, height: 10 }),
    ).toEqual({ x: 0, y: 0, width: 30, height: 15 });
  });

  it('clips to the viewport and snaps outward to integers', () => {
    expect(clipRect({ x: -5, y: 0.4, width: 20, height: 10.2 }, viewport)).toEqual({
      x: 0,
      y: 0,
      width: 15,
      height: 11,
    });
  });

  it('returns null for a rect entirely outside the viewport', () => {
    expect(clipRect({ x: 2000, y: 0, width: 10, height: 10 }, viewport)).toBeNull();
  });
});

describe('mergeDamageRect', () => {
  it('merges overlapping rects into one', () => {
    const merged = mergeDamageRect([
      { x: 0, y: 0, width: 10, height: 10 },
      { x: 5, y: 5, width: 10, height: 10 },
    ]);
    expect(merged).toEqual([{ x: 0, y: 0, width: 15, height: 15 }]);
  });

  it('leaves separated rects alone', () => {
    const input = [
      { x: 0, y: 0, width: 10, height: 10 },
      { x: 500, y: 500, width: 10, height: 10 },
    ];
    expect(mergeDamageRect(input)).toHaveLength(2);
  });

  it('merges across a configured gap', () => {
    const input = [
      { x: 0, y: 0, width: 10, height: 10 },
      { x: 14, y: 0, width: 10, height: 10 },
    ];
    expect(mergeDamageRect(input, { gapPx: 0 })).toHaveLength(2);
    expect(mergeDamageRect(input, { gapPx: 8 })).toEqual([
      { x: 0, y: 0, width: 24, height: 10 },
    ]);
  });

  it('runs to a fixed point through a chain of overlaps', () => {
    const merged = mergeDamageRect([
      { x: 0, y: 0, width: 10, height: 10 },
      { x: 200, y: 0, width: 10, height: 10 },
      { x: 8, y: 0, width: 10, height: 10 },
      { x: 16, y: 0, width: 10, height: 10 },
    ]);
    expect(merged).toHaveLength(2);
    expect(merged).toContainEqual({ x: 0, y: 0, width: 26, height: 10 });
  });

  it('forces the count down to maxRect by the least-wasteful union', () => {
    const input = [
      { x: 0, y: 0, width: 10, height: 10 },
      { x: 20, y: 0, width: 10, height: 10 },
      { x: 900, y: 900, width: 10, height: 10 },
    ];
    const merged = mergeDamageRect(input, { maxRect: 2 });
    expect(merged).toHaveLength(2);
    // The two near rects merge; the far one is left alone because unioning it
    // would waste ~800k pixels.
    expect(merged).toContainEqual({ x: 900, y: 900, width: 10, height: 10 });
    expect(merged).toContainEqual({ x: 0, y: 0, width: 30, height: 10 });
  });

  it('drops empty rects', () => {
    expect(mergeDamageRect([{ x: 0, y: 0, width: 0, height: 10 }])).toEqual([]);
  });
});

describe('planDamage', () => {
  it('plans nothing when there is no damage', () => {
    const plan = planDamage([], viewport);
    expect(plan.mode).toBe('none');
    expect(plan.rect).toEqual([]);
    expect(plan.coverage).toBe(0);
  });

  it('scissors when damage is small', () => {
    const plan = planDamage([{ x: 10, y: 10, width: 100, height: 100 }], viewport);
    expect(plan.mode).toBe('scissor');
    expect(plan.rect).toEqual([{ x: 10, y: 10, width: 100, height: 100 }]);
    expect(plan.coverage).toBeCloseTo(0.01);
  });

  it('redraws the full frame once damage crosses the threshold', () => {
    const plan = planDamage([{ x: 0, y: 0, width: 1000, height: 400 }], viewport);
    expect(plan.mode).toBe('full');
    expect(plan.coverage).toBeCloseTo(0.4);
    expect(plan.rect).toEqual([{ x: 0, y: 0, width: 1000, height: 1000 }]);
  });

  it('uses the supplied (calibrated) threshold, not the default', () => {
    const damage = [{ x: 0, y: 0, width: 1000, height: 400 }];
    expect(planDamage(damage, viewport, { threshold: 0.5 }).mode).toBe('scissor');
    expect(planDamage(damage, viewport, { threshold: 0.2 }).mode).toBe('full');
  });

  it('clips damage to the viewport before deciding', () => {
    const plan = planDamage(
      [{ x: -100, y: -100, width: 150, height: 150 }],
      viewport,
    );
    expect(plan.rect).toEqual([{ x: 0, y: 0, width: 50, height: 50 }]);
    expect(plan.mode).toBe('scissor');
  });

  it('reports the threshold it decided against', () => {
    const plan = planDamage([{ x: 0, y: 0, width: 1, height: 1 }], viewport);
    expect(plan.threshold).toBe(DEFAULT_DAMAGE_THRESHOLD);
  });
});

describe('calibrateDamageThreshold', () => {
  it('interpolates the crossing between the last win and the first loss', () => {
    const calibration = calibrateDamageThreshold([
      { coverage: 0.1, scissorMs: 1, fullMs: 2 },
      { coverage: 0.3, scissorMs: 3, fullMs: 2 },
    ]);
    expect(calibration.threshold).toBeCloseTo(0.2);
    expect(calibration.measured).toBe(true);
    expect(calibration.sampleCount).toBe(2);
  });

  it('sorts unordered samples before looking for the crossing', () => {
    const calibration = calibrateDamageThreshold([
      { coverage: 0.3, scissorMs: 3, fullMs: 2 },
      { coverage: 0.1, scissorMs: 1, fullMs: 2 },
    ]);
    expect(calibration.threshold).toBeCloseTo(0.2);
  });

  it('never redraws fully when scissoring won at every sample', () => {
    const calibration = calibrateDamageThreshold([
      { coverage: 0.1, scissorMs: 1, fullMs: 5 },
      { coverage: 0.9, scissorMs: 2, fullMs: 5 },
    ]);
    expect(calibration.threshold).toBe(1);
    expect(calibration.measured).toBe(false);
  });

  it('always redraws fully when scissoring lost at every sample', () => {
    const calibration = calibrateDamageThreshold([
      { coverage: 0.05, scissorMs: 9, fullMs: 1 },
      { coverage: 0.5, scissorMs: 9, fullMs: 1 },
    ]);
    expect(calibration.threshold).toBe(0);
  });

  it('falls back to the documented default with no samples at all', () => {
    const calibration = calibrateDamageThreshold([]);
    expect(calibration.threshold).toBe(DEFAULT_DAMAGE_THRESHOLD);
    expect(calibration.sampleCount).toBe(0);
  });
});

describe('measureDamageCrossover', () => {
  it('finds the crossover of a known synthetic cost model', async () => {
    // Scissoring costs a fixed 0.2ms of setup plus 10ms per unit of coverage;
    // a full redraw is a flat 2ms. They cross at coverage = 0.18.
    const calibration = await measureDamageCrossover({
      repeat: 3,
      runFrame: (mode, coverage) =>
        mode === 'scissor' ? 0.2 + coverage * 10 : 2,
    });
    expect(calibration.measured).toBe(true);
    expect(calibration.threshold).toBeCloseTo(0.18, 5);
    expect(calibration.sampleCount).toBe(8);
  });

  it('takes the median of the repeats so one outlier cannot move the result', async () => {
    let call = 0;
    const calibration = await measureDamageCrossover({
      coverage: [0.1, 0.3],
      repeat: 3,
      runFrame: (mode, coverage) => {
        call++;
        // Inject a 500ms spike into one scissor sample at coverage 0.1.
        if (mode === 'scissor' && coverage === 0.1 && call === 1) return 500;
        return mode === 'scissor' ? coverage * 10 : 2;
      },
    });
    expect(calibration.sample[0]!.scissorMs).toBe(1);
    expect(calibration.threshold).toBeCloseTo(0.2);
  });

  it('accepts an async frame runner', async () => {
    const calibration = await measureDamageCrossover({
      coverage: [0.1, 0.5],
      repeat: 1,
      runFrame: (mode, coverage) =>
        Promise.resolve(mode === 'scissor' ? coverage * 10 : 2),
    });
    expect(calibration.threshold).toBeCloseTo(0.2);
  });
});
