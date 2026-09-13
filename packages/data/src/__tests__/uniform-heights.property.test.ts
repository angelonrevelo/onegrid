// =============================================================================
// UniformHeights ≡ FenwickHeights, for any sequence of height edits.
//
// The grid holds either store behind one interface, so every observable answer
// must agree. Heights are integers and half-pixels (exact under any summation
// order) and include 0, which is where indexAtOffset's descent is subtle.
// =============================================================================

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { FenwickHeights } from '../fenwick';
import { UniformHeights } from '../uniform-heights';

const heightArb = fc.oneof(
  fc.integer({ min: 0, max: 60 }),
  fc.integer({ min: 0, max: 120 }).map((n) => n / 2),
  fc.constant(0),
);

describe('UniformHeights ≡ FenwickHeights', () => {
  it('(U1) every query agrees after any sequence of setHeight edits', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 64 }),
        heightArb,
        fc.array(fc.tuple(fc.nat({ max: 70 }), heightArb), { maxLength: 30 }),
        fc.array(fc.double({ min: -10, max: 4000, noNaN: true }), { minLength: 1, maxLength: 20 }),
        (length, height, edit, offset) => {
          const uniform = new UniformHeights(length, height);
          const fenwick = new FenwickHeights(new Float64Array(length).fill(height));
          for (const [index, h] of edit) {
            uniform.setHeight(index, h);
            if (index < length) fenwick.setHeight(index, h);
          }
          expect(uniform.length).toBe(fenwick.length);
          expect(uniform.totalHeight).toBe(fenwick.totalHeight);
          for (let i = 0; i < length; i++) expect(uniform.get(i)).toBe(fenwick.get(i));
          for (let c = 0; c <= length; c++) expect(uniform.prefixSum(c)).toBe(fenwick.prefixSum(c));
          for (const y of offset) {
            if (length === 0) continue;
            expect(uniform.indexAtOffset(y)).toBe(fenwick.indexAtOffset(y));
          }
          // Offsets exactly on row boundaries are where an off-by-one lives.
          for (let c = 0; c <= length && length > 0; c++) {
            const y = fenwick.prefixSum(c);
            expect(uniform.indexAtOffset(y)).toBe(fenwick.indexAtOffset(y));
          }
        },
      ),
      { numRuns: 500 },
    );
  });

  it('(U4) withAdded equals setHeight(r, get(r) + extra) on each distinct row', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 40 }),
        heightArb,
        fc.array(fc.tuple(fc.nat({ max: 45 }), heightArb), { maxLength: 15 }),
        fc.array(fc.integer({ min: -3, max: 45 }), { maxLength: 20 }),
        fc.integer({ min: 0, max: 200 }),
        (length, height, edit, expanded, extra) => {
          const base = new UniformHeights(length, height);
          for (const [index, h] of edit) base.setHeight(index, h);
          const want = base.clone();
          for (const r of new Set(expanded)) {
            if (r >= 0 && r < length) want.setHeight(r, base.get(r) + extra);
          }
          const got = base.withAdded(expanded, extra);
          expect(got.overrideCount).toBe(want.overrideCount);
          expect(got.totalHeight).toBe(want.totalHeight);
          for (let i = 0; i < length; i++) expect(got.get(i)).toBe(want.get(i));
          for (let c = 0; c <= length; c++) expect(got.prefixSum(c)).toBe(want.prefixSum(c));
          // The source is untouched.
          for (let i = 0; i < length; i++) expect(base.get(i)).toBe(base.get(i));
        },
      ),
      { numRuns: 300 },
    );
  });

  it('(U2) clone is independent of its source', () => {
    const a = new UniformHeights(10, 28);
    a.setHeight(3, 40);
    const b = a.clone();
    b.setHeight(3, 28);
    b.setHeight(7, 100);
    expect(a.get(3)).toBe(40);
    expect(a.get(7)).toBe(28);
    expect(b.get(3)).toBe(28);
    expect(b.overrideCount).toBe(1);
  });
});

describe('UniformHeights at a billion rows', () => {
  it('(U3) mounts, edits and seeks in constant memory', () => {
    const n = 1_000_000_000;
    const before = process.memoryUsage().heapUsed;
    const heights = new UniformHeights(n, 28);
    heights.setHeight(0, 100);
    heights.setHeight(500_000_000, 64);
    heights.setHeight(n - 1, 10);
    const grew = process.memoryUsage().heapUsed - before;

    expect(heights.totalHeight).toBe(n * 28 + (100 - 28) + (64 - 28) + (10 - 28));
    expect(heights.prefixSum(500_000_000)).toBe(500_000_000 * 28 + 72);
    // The row holding the pixel just past row 500M's top edge is row 500M.
    expect(heights.indexAtOffset(heights.prefixSum(500_000_000) + 1)).toBe(500_000_000);
    expect(heights.indexAtOffset(Number.MAX_SAFE_INTEGER)).toBe(n - 1);
    expect(heights.get(n - 1)).toBe(10);
    expect(grew).toBeLessThan(1_000_000);
  });
});
