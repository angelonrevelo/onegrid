// =============================================================================
// The reference backend, operation by operation.
//
// These assertions are the specification. Everything else in the package —
// the Rust kernel, the fake kernel, the differential harness — exists to be
// held against them, so they are written as literal expected arrays rather
// than as invariants: an invariant test would pass for two different-but-
// self-consistent semantics, which is precisely the failure being guarded.
// =============================================================================

import { describe, expect, it } from 'vitest';
import { createJsBackend } from '../js-backend';
import { byteLengthFor, setBit } from '../bit';
import type { AccelColumn } from '../types';

const backend = createJsBackend();

function column(value: ReadonlyArray<number>, missing: ReadonlyArray<number> = []): AccelColumn {
  const data = Float64Array.from(value);
  if (missing.length === 0) return { value: data };
  const validity = new Uint8Array(byteLengthFor(data.length));
  for (let i = 0; i < data.length; i++) if (!missing.includes(i)) setBit(validity, i);
  return { value: data, validity };
}

const bitOf = (mask: Uint8Array, length: number): number[] =>
  Array.from({ length }, (_, i) => ((mask[i >>> 3] ?? 0) >>> (i & 7)) & 1);

describe('createJsBackend — sortIndex', () => {
  it('sorts ascending and stably', () => {
    const key = [{ ...column([3, 1, 2, 1]) }];
    expect(Array.from(backend.sortIndex(key, 4))).toEqual([1, 3, 2, 0]);
  });

  it('sorts descending and keeps ties in source order', () => {
    const key = [{ ...column([3, 1, 2, 1]), descending: true }];
    expect(Array.from(backend.sortIndex(key, 4))).toEqual([0, 2, 1, 3]);
  });

  it('treats NaN as missing and places it last by default', () => {
    const key = [{ ...column([NaN, 5, 1, NaN]) }];
    expect(Array.from(backend.sortIndex(key, 4))).toEqual([2, 1, 0, 3]);
  });

  it('places missing rows first on request, still ahead of a descending run', () => {
    const key = [{ ...column([NaN, 5, 1, NaN]), descending: true, missingFirst: true }];
    expect(Array.from(backend.sortIndex(key, 4))).toEqual([0, 3, 1, 2]);
  });

  it('honours a validity bitmap independently of the values behind it', () => {
    const key = [{ ...column([9, 9, 9, 1], [0, 2]) }];
    expect(Array.from(backend.sortIndex(key, 4))).toEqual([3, 1, 0, 2]);
  });

  it('keeps -0 and 0 tied and resolves the tie by source order', () => {
    const key = [{ ...column([0, -0, -1]) }];
    expect(Array.from(backend.sortIndex(key, 3))).toEqual([2, 0, 1]);
  });

  it('applies a second key only where the first ties', () => {
    const key = [
      { ...column([1, 1, 0, 1]) },
      { ...column([7, 2, 9, 5]) },
    ];
    expect(Array.from(backend.sortIndex(key, 4))).toEqual([2, 1, 3, 0]);
  });

  it('returns the identity permutation for an empty key list', () => {
    expect(Array.from(backend.sortIndex([], 3))).toEqual([0, 1, 2]);
  });

  it('returns an empty permutation for a zero-length input', () => {
    expect(Array.from(backend.sortIndex([{ ...column([]) }], 0))).toEqual([]);
  });

  it('returns [0] for a single-element input regardless of direction', () => {
    expect(Array.from(backend.sortIndex([{ ...column([5]) }], 1))).toEqual([0]);
    expect(
      Array.from(backend.sortIndex([{ ...column([5]), descending: true }], 1)),
    ).toEqual([0]);
  });
});

describe('createJsBackend — filterMask', () => {
  const data = column([1, 2, 3, NaN, 2, 9], [5]);

  it('matches eq and excludes every missing row', () => {
    expect(bitOf(backend.filterMask(data, { op: 'eq', operand: 2 }), 6)).toEqual([
      0, 1, 0, 0, 1, 0,
    ]);
  });

  it('excludes missing rows from neq as well — missing is not "different"', () => {
    expect(bitOf(backend.filterMask(data, { op: 'neq', operand: 2 }), 6)).toEqual([
      1, 0, 1, 0, 0, 0,
    ]);
  });

  it('handles the ordered comparisons', () => {
    expect(bitOf(backend.filterMask(data, { op: 'lt', operand: 3 }), 6)).toEqual([
      1, 1, 0, 0, 1, 0,
    ]);
    expect(bitOf(backend.filterMask(data, { op: 'gte', operand: 3 }), 6)).toEqual([
      0, 0, 1, 0, 0, 0,
    ]);
  });

  it('treats between as inclusive on both ends', () => {
    expect(
      bitOf(backend.filterMask(data, { op: 'between', operand: 2, upper: 3 }), 6),
    ).toEqual([0, 1, 1, 0, 1, 0]);
    expect(
      bitOf(backend.filterMask(data, { op: 'notBetween', operand: 2, upper: 3 }), 6),
    ).toEqual([1, 0, 0, 0, 0, 0]);
  });

  it('matches membership by value, so -0 satisfies a set containing 0', () => {
    const signed = column([-0, 0, 1]);
    expect(
      bitOf(backend.filterMask(signed, { op: 'in', set: Float64Array.from([0]) }), 3),
    ).toEqual([1, 1, 0]);
  });

  it('reports missing rows through isNull and only through isNull', () => {
    expect(bitOf(backend.filterMask(data, { op: 'isNull' }), 6)).toEqual([
      0, 0, 0, 1, 0, 1,
    ]);
    expect(bitOf(backend.filterMask(data, { op: 'isNotNull' }), 6)).toEqual([
      1, 1, 1, 0, 1, 0,
    ]);
  });

  it('clears bits past the requested length in the final byte', () => {
    const nine = column([1, 1, 1, 1, 1, 1, 1, 1, 1]);
    const mask = backend.filterMask(nine, { op: 'isNotNull' });
    expect(mask.length).toBe(2);
    expect(mask[1]).toBe(0b1);
  });

  it('returns an empty mask for an empty column', () => {
    expect(backend.filterMask(column([]), { op: 'isNotNull' }).length).toBe(0);
  });
});

describe('createJsBackend — groupKey', () => {
  it('numbers groups in order of first appearance', () => {
    const result = backend.groupKey([column([7, 3, 7, 9, 3])], 5);
    expect(Array.from(result.code)).toEqual([0, 1, 0, 2, 1]);
    expect(result.cardinality).toBe(3);
  });

  it('puts every missing row — validity hole or NaN — into one shared group', () => {
    const result = backend.groupKey([column([1, NaN, 2, 5, NaN], [3])], 5);
    expect(Array.from(result.code)).toEqual([0, 1, 2, 1, 1]);
    expect(result.cardinality).toBe(3);
  });

  it('groups -0 with 0', () => {
    const result = backend.groupKey([column([0, -0, 1])], 3);
    expect(Array.from(result.code)).toEqual([0, 0, 1]);
    expect(result.cardinality).toBe(2);
  });

  it('refines across multiple key columns', () => {
    const result = backend.groupKey(
      [column([1, 1, 2, 2, 1]), column([7, 8, 7, 8, 7])],
      5,
    );
    expect(Array.from(result.code)).toEqual([0, 1, 2, 3, 0]);
    expect(result.cardinality).toBe(4);
  });

  it('puts everything in one group when there is no key at all', () => {
    const result = backend.groupKey([], 3);
    expect(Array.from(result.code)).toEqual([0, 0, 0]);
    expect(result.cardinality).toBe(1);
  });

  it('reports zero cardinality for zero rows', () => {
    expect(backend.groupKey([column([])], 0)).toEqual({
      code: new Int32Array(0),
      cardinality: 0,
    });
  });
});

describe('createJsBackend — aggregate', () => {
  const data = column([4, NaN, 2, 8, 2], [3]);

  it('skips missing rows in every reducer', () => {
    expect(backend.aggregate('sum', data, null)).toBe(8);
    expect(backend.aggregate('count', data, null)).toBe(3);
    expect(backend.aggregate('avg', data, null)).toBeCloseTo(8 / 3, 12);
    expect(backend.aggregate('countDistinct', data, null)).toBe(2);
    expect(backend.aggregate('min', data, null)).toBe(2);
    expect(backend.aggregate('max', data, null)).toBe(4);
    expect(backend.aggregate('first', data, null)).toBe(4);
    expect(backend.aggregate('last', data, null)).toBe(2);
  });

  it('restricts to an index subset and honours its order for first/last', () => {
    const index = Int32Array.from([4, 2, 0]);
    expect(backend.aggregate('first', data, index)).toBe(2);
    expect(backend.aggregate('last', data, index)).toBe(4);
    expect(backend.aggregate('sum', data, index)).toBe(8);
  });

  it('returns 0 for sum/count and null for the rest over no present row', () => {
    const none = column([NaN, NaN]);
    expect(backend.aggregate('sum', none, null)).toBe(0);
    expect(backend.aggregate('count', none, null)).toBe(0);
    expect(backend.aggregate('avg', none, null)).toBeNull();
    expect(backend.aggregate('min', none, null)).toBeNull();
    expect(backend.aggregate('max', none, null)).toBeNull();
    expect(backend.aggregate('first', none, null)).toBeNull();
    expect(backend.aggregate('last', none, null)).toBeNull();
  });

  it('handles an empty column and an empty index identically', () => {
    expect(backend.aggregate('avg', column([]), null)).toBeNull();
    expect(backend.aggregate('avg', data, new Int32Array(0))).toBeNull();
    expect(backend.aggregate('count', data, new Int32Array(0))).toBe(0);
  });

  it('counts -0 and 0 as one distinct value', () => {
    expect(backend.aggregate('countDistinct', column([0, -0, 1]), null)).toBe(2);
  });
});

describe('createJsBackend — bitmapOp', () => {
  const a = Uint8Array.from([0b1100]);
  const b = Uint8Array.from([0b1010]);

  it('computes the five operators', () => {
    expect(Array.from(backend.bitmapOp('and', a, b, 4))).toEqual([0b1000]);
    expect(Array.from(backend.bitmapOp('or', a, b, 4))).toEqual([0b1110]);
    expect(Array.from(backend.bitmapOp('xor', a, b, 4))).toEqual([0b0110]);
    expect(Array.from(backend.bitmapOp('andNot', a, b, 4))).toEqual([0b0100]);
    expect(Array.from(backend.bitmapOp('not', a, null, 4))).toEqual([0b0011]);
  });

  it('clears bits beyond the bit length rather than inverting them into existence', () => {
    expect(Array.from(backend.bitmapOp('not', Uint8Array.from([0]), null, 3))).toEqual([
      0b111,
    ]);
  });

  it('tolerates an oversized input and a zero length', () => {
    const oversized = Uint8Array.from([0xff, 0xff, 0xff]);
    expect(Array.from(backend.bitmapOp('and', oversized, oversized, 9))).toEqual([
      0xff, 0b1,
    ]);
    expect(backend.bitmapOp('or', oversized, oversized, 0).length).toBe(0);
  });
});

describe('createJsBackend — topK', () => {
  const data = column([5, 1, 9, 1, 7]);

  it('returns exactly the prefix of the full sort', () => {
    const full = backend.sortIndex([{ ...data }], 5);
    for (let k = 0; k <= 5; k++) {
      expect(Array.from(backend.topK(data, k))).toEqual(Array.from(full.subarray(0, k)));
    }
  });

  it('matches the descending sort prefix too', () => {
    const full = backend.sortIndex([{ ...data, descending: true }], 5);
    expect(Array.from(backend.topK(data, 3, { descending: true }))).toEqual(
      Array.from(full.subarray(0, 3)),
    );
  });

  it('clamps k to the row count and returns nothing for k = 0', () => {
    expect(backend.topK(data, 99).length).toBe(5);
    expect(backend.topK(data, 0).length).toBe(0);
    expect(backend.topK(column([]), 5).length).toBe(0);
  });

  it('orders missing rows per the option, and NaN counts as missing', () => {
    const holed = column([NaN, 3, 1], [1]);
    expect(Array.from(holed.value)).toHaveLength(3);
    expect(Array.from(backend.topK(holed, 3, { missingFirst: true }))).toEqual([0, 1, 2]);
    expect(Array.from(backend.topK(holed, 3))).toEqual([2, 0, 1]);
  });
});

describe('createJsBackend — identity', () => {
  it('names itself and claims no hardware capability', () => {
    expect(backend.name).toBe('js');
    expect(backend.capability).toEqual({ wasm: false, simd: false, thread: false });
  });

  it('disposes without complaint, twice', () => {
    expect(() => {
      backend.dispose();
      backend.dispose();
    }).not.toThrow();
  });
});
