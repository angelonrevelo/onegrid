import { describe, expect, it } from 'vitest';
import {
  area,
  createDamageTracker,
  intersects,
  mergeRegion,
  union,
  type DamageRect,
} from '../damage';

const rect = (x: number, y: number, width: number, height: number): DamageRect => ({
  x,
  y,
  width,
  height,
});

const viewport = { width: 1000, height: 800 };

describe('rectangle helpers', () => {
  it('detects overlap and separation', () => {
    expect(intersects(rect(0, 0, 10, 10), rect(5, 5, 10, 10))).toBe(true);
    expect(intersects(rect(0, 0, 10, 10), rect(50, 50, 10, 10))).toBe(false);
  });

  it('treats exactly-touching rectangles as intersecting, so they merge', () => {
    // Two adjacent cells share an edge; clipping them separately is waste.
    expect(intersects(rect(0, 0, 10, 10), rect(10, 0, 10, 10))).toBe(true);
  });

  it('unions to the covering box', () => {
    expect(union(rect(0, 0, 10, 10), rect(20, 30, 5, 5))).toEqual(rect(0, 0, 25, 35));
  });

  it('computes area and clamps negative extents to zero', () => {
    expect(area(rect(0, 0, 4, 5))).toBe(20);
    expect(area(rect(0, 0, -4, 5))).toBe(0);
  });
});

describe('mergeRegion', () => {
  it('collapses a chain of overlaps into one rectangle', () => {
    const merged = mergeRegion([
      rect(0, 0, 10, 10),
      rect(9, 0, 10, 10),
      rect(18, 0, 10, 10),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toEqual(rect(0, 0, 28, 10));
  });

  it('keeps disjoint rectangles separate', () => {
    const merged = mergeRegion([rect(0, 0, 10, 10), rect(500, 500, 10, 10)]);
    expect(merged).toHaveLength(2);
  });

  it('re-checks earlier rectangles after a union widens one', () => {
    // A and C do not touch; B bridges them. A correct merge yields ONE rect.
    const merged = mergeRegion([rect(0, 0, 10, 10), rect(40, 0, 10, 10), rect(9, 0, 32, 10)]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toEqual(rect(0, 0, 50, 10));
  });
});

describe('createDamageTracker', () => {
  it('plans nothing when nothing was damaged', () => {
    expect(createDamageTracker().plan(viewport)).toEqual({ kind: 'none' });
  });

  it('plans a partial redraw for a small isolated region', () => {
    const tracker = createDamageTracker();
    tracker.damage(rect(10, 10, 20, 20));

    const plan = tracker.plan(viewport);
    expect(plan.kind).toBe('partial');
    if (plan.kind !== 'partial') throw new Error('expected partial');
    expect(plan.region).toEqual([rect(10, 10, 20, 20)]);
  });

  it('ignores zero-area damage', () => {
    const tracker = createDamageTracker();
    tracker.damage(rect(10, 10, 0, 20));
    tracker.damage(rect(10, 10, 20, 0));
    expect(tracker.pendingCount()).toBe(0);
    expect(tracker.plan(viewport)).toEqual({ kind: 'none' });
  });

  it('escalates to a full redraw once damage passes the ratio', () => {
    const tracker = createDamageTracker({ fullRedrawRatio: 0.5 });
    // 700x600 = 420,000 of 800,000 => 0.525, over the threshold.
    tracker.damage(rect(0, 0, 700, 600));
    expect(tracker.plan(viewport)).toEqual({ kind: 'full' });
  });

  it('stays partial just under the ratio', () => {
    const tracker = createDamageTracker({ fullRedrawRatio: 0.5 });
    // 500x600 = 300,000 of 800,000 => 0.375.
    tracker.damage(rect(0, 0, 500, 600));
    expect(tracker.plan(viewport).kind).toBe('partial');
  });

  it('collapses to one bounding box past maxRegion', () => {
    const tracker = createDamageTracker({ maxRegion: 3, fullRedrawRatio: 0.99 });
    // Five disjoint 2x2 specks — far apart so they never merge naturally.
    for (let i = 0; i < 5; i++) tracker.damage(rect(i * 100, i * 100, 2, 2));

    const plan = tracker.plan(viewport);
    expect(plan.kind).toBe('partial');
    if (plan.kind !== 'partial') throw new Error('expected partial');
    expect(plan.region).toHaveLength(1);
    expect(plan.region[0]).toEqual(rect(0, 0, 402, 402));
  });

  it('keeps regions separate while at or under maxRegion', () => {
    const tracker = createDamageTracker({ maxRegion: 5, fullRedrawRatio: 0.99 });
    for (let i = 0; i < 4; i++) tracker.damage(rect(i * 100, i * 100, 2, 2));

    const plan = tracker.plan(viewport);
    if (plan.kind !== 'partial') throw new Error('expected partial');
    expect(plan.region).toHaveLength(4);
  });

  it('marks the frame full after a scroll and ignores later partial damage', () => {
    const tracker = createDamageTracker();
    tracker.damage(rect(0, 0, 5, 5));
    tracker.noteScroll();
    tracker.damage(rect(10, 10, 5, 5));

    expect(tracker.pendingCount()).toBe(0);
    expect(tracker.plan(viewport)).toEqual({ kind: 'full' });
  });

  it('clears back to none after a painted frame', () => {
    const tracker = createDamageTracker();
    tracker.damageAll();
    expect(tracker.plan(viewport)).toEqual({ kind: 'full' });

    tracker.clear();
    expect(tracker.plan(viewport)).toEqual({ kind: 'none' });
  });

  it('does not divide by zero on a zero-sized viewport', () => {
    const tracker = createDamageTracker();
    tracker.damage(rect(0, 0, 10, 10));
    expect(tracker.plan({ width: 0, height: 0 }).kind).toBe('partial');
  });
});
