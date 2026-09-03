// =============================================================================
// Property-based differential testing.
//
// The hand-written edge cases in `edgeCase()` cover the failures someone has
// already thought of. These cover the ones nobody has. The property is always
// the same one sentence — "the reference backend and the kernel compute the
// same function" — and fast-check's job is to find an input where that is
// false.
//
// The generators are weighted, not uniform. A uniform double generator almost
// never produces a NaN, a -0, a duplicate, or a value that ties, and ties are
// where a stable sort and a group-by are actually interesting. So the value
// arbitrary is a frequency mix that puts real weight on the pathological
// values, and the column length range starts at 0.
//
// Shrinking is the reason to use fast-check here rather than a loop over
// Math.random: when this fails it reports the smallest column that reproduces,
// which for a 200-element permutation mismatch is the difference between a
// five-minute fix and an afternoon.
// =============================================================================

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createJsBackend } from '../js-backend';
import { createWasmBackend } from '../wasm-backend';
import { createFakeAccelModule } from '../fake-module';
import { assertBackendEquivalent } from '../differential';
import type { AccelCase } from '../differential';
import { byteLengthFor, setBit } from '../bit';
import type { AccelAggregateOp, AccelBitmapOp, AccelColumn, AccelPredicateOp } from '../types';

const reference = createJsBackend();
const accelerated = createWasmBackend(createFakeAccelModule());

/**
 * Deliberately degenerate. Small integers guarantee ties and duplicate group
 * keys; NaN and -0 are the two values the missing-value model is built around;
 * the infinities catch a kernel that reaches for a sentinel min/max.
 */
const valueArb = fc.oneof(
  { weight: 6, arbitrary: fc.integer({ min: -4, max: 4 }).map((n) => n) },
  { weight: 2, arbitrary: fc.double({ min: -1000, max: 1000, noNaN: true }) },
  { weight: 2, arbitrary: fc.constantFrom(Number.NaN, -0, 0) },
  { weight: 1, arbitrary: fc.constantFrom(Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY) },
);

const columnArb = (minLength = 0, maxLength = 40): fc.Arbitrary<AccelColumn> =>
  fc
    .tuple(
      fc.array(valueArb, { minLength, maxLength }),
      fc.boolean(),
      fc.array(fc.nat({ max: 64 }), { maxLength: 8 }),
    )
    .map(([value, useValidity, hole]) => {
      const data = Float64Array.from(value);
      if (!useValidity) return { value: data };
      const validity = new Uint8Array(byteLengthFor(data.length));
      for (let i = 0; i < data.length; i++) {
        if (!hole.includes(i)) setBit(validity, i);
      }
      return { value: data, validity };
    });

const predicateOpArb = fc.constantFrom<AccelPredicateOp>(
  'eq',
  'neq',
  'lt',
  'lte',
  'gt',
  'gte',
  'between',
  'notBetween',
  'in',
  'notIn',
  'isNull',
  'isNotNull',
);

const aggregateOpArb = fc.constantFrom<AccelAggregateOp>(
  'sum',
  'avg',
  'count',
  'countDistinct',
  'min',
  'max',
  'first',
  'last',
);

const bitmapOpArb = fc.constantFrom<AccelBitmapOp>('and', 'or', 'not', 'andNot', 'xor');

const RUN = { numRuns: 250 } as const;

describe('differential properties — JS reference vs kernel', () => {
  it('(D1) sortIndex agrees for any column, direction and missing placement', () => {
    fc.assert(
      fc.property(
        columnArb(),
        fc.boolean(),
        fc.boolean(),
        (column, descending, missingFirst) => {
          const testCase: AccelCase = {
            kind: 'sortIndex',
            name: 'property sortIndex',
            key: [{ ...column, descending, missingFirst }],
            length: column.value.length,
          };
          assertBackendEquivalent(reference, accelerated, testCase);
        },
      ),
      RUN,
    );
  });

  it('(D2) a multi-key sortIndex agrees, which is where a stable-pass kernel breaks', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(columnArb(6, 6), fc.boolean(), fc.boolean()), {
          minLength: 1,
          maxLength: 3,
        }),
        (level) => {
          const testCase: AccelCase = {
            kind: 'sortIndex',
            name: 'property multi-key sortIndex',
            key: level.map(([column, descending, missingFirst]) => ({
              ...column,
              descending,
              missingFirst,
            })),
            length: 6,
          };
          assertBackendEquivalent(reference, accelerated, testCase);
        },
      ),
      RUN,
    );
  });

  it('(D3) filterMask agrees for every operator', () => {
    fc.assert(
      fc.property(
        columnArb(),
        predicateOpArb,
        valueArb,
        valueArb,
        fc.array(valueArb, { maxLength: 5 }),
        (column, op, operand, upper, set) => {
          const testCase: AccelCase = {
            kind: 'filterMask',
            name: `property filterMask ${op}`,
            column,
            predicate: { op, operand, upper, set: Float64Array.from(set) },
          };
          assertBackendEquivalent(reference, accelerated, testCase);
        },
      ),
      RUN,
    );
  });

  it('(D4) groupKey agrees on codes and cardinality across one to three key columns', () => {
    fc.assert(
      fc.property(fc.array(columnArb(12, 12), { minLength: 0, maxLength: 3 }), (key) => {
        const testCase: AccelCase = {
          kind: 'groupKey',
          name: 'property groupKey',
          key,
          length: 12,
        };
        assertBackendEquivalent(reference, accelerated, testCase);
      }),
      RUN,
    );
  });

  it('(D5) aggregate agrees for every reducer, with and without an index subset', () => {
    fc.assert(
      fc.property(
        columnArb(),
        aggregateOpArb,
        fc.option(fc.array(fc.nat({ max: 39 }), { maxLength: 20 }), { nil: null }),
        (column, op, index) => {
          const testCase: AccelCase = {
            kind: 'aggregate',
            name: `property aggregate ${op}`,
            column,
            op,
            index: index === null ? null : Int32Array.from(index),
          };
          assertBackendEquivalent(reference, accelerated, testCase);
        },
      ),
      RUN,
    );
  });

  it('(D6) bitmapOp agrees for every operator and every tail-bit alignment', () => {
    fc.assert(
      fc.property(
        bitmapOpArb,
        fc.nat({ max: 40 }),
        fc.array(fc.integer({ min: 0, max: 255 }), { maxLength: 6 }),
        fc.array(fc.integer({ min: 0, max: 255 }), { maxLength: 6 }),
        (op, bitLength, a, b) => {
          const testCase: AccelCase = {
            kind: 'bitmapOp',
            name: `property bitmapOp ${op}`,
            op,
            a: Uint8Array.from(a),
            b: Uint8Array.from(b),
            bitLength,
          };
          assertBackendEquivalent(reference, accelerated, testCase);
        },
      ),
      RUN,
    );
  });

  it('(D7) topK agrees for any k, including k past the end', () => {
    fc.assert(
      fc.property(
        columnArb(),
        fc.nat({ max: 45 }),
        fc.boolean(),
        fc.boolean(),
        (column, k, descending, missingFirst) => {
          const testCase: AccelCase = {
            kind: 'topK',
            name: 'property topK',
            column,
            k,
            option: { descending, missingFirst },
          };
          assertBackendEquivalent(reference, accelerated, testCase);
        },
      ),
      RUN,
    );
  });
});

describe('reference invariants — properties true of the semantics itself', () => {
  it('(R1) topK is exactly the prefix of the full sort', () => {
    fc.assert(
      fc.property(
        columnArb(),
        fc.nat({ max: 45 }),
        fc.boolean(),
        fc.boolean(),
        (column, k, descending, missingFirst) => {
          const full = reference.sortIndex(
            [{ ...column, descending, missingFirst }],
            column.value.length,
          );
          const want = Math.min(k, column.value.length);
          const top = reference.topK(column, k, { descending, missingFirst });
          expect(Array.from(top)).toEqual(Array.from(full.subarray(0, want)));
        },
      ),
      RUN,
    );
  });

  it('(R2) sortIndex always returns a permutation of 0..n-1', () => {
    fc.assert(
      fc.property(columnArb(), fc.boolean(), (column, descending) => {
        const n = column.value.length;
        const permutation = reference.sortIndex([{ ...column, descending }], n);
        expect(permutation.length).toBe(n);
        expect(Array.from(permutation).sort((a, b) => a - b)).toEqual(
          Array.from({ length: n }, (_, i) => i),
        );
      }),
      RUN,
    );
  });

  it('(R3) groupKey codes are dense — every value in [0, cardinality) is used', () => {
    fc.assert(
      fc.property(columnArb(1, 30), (column) => {
        const n = column.value.length;
        const result = reference.groupKey([column], n);
        const used = new Set(Array.from(result.code));
        expect(used.size).toBe(result.cardinality);
        for (const code of used) {
          expect(code).toBeGreaterThanOrEqual(0);
          expect(code).toBeLessThan(result.cardinality);
        }
      }),
      RUN,
    );
  });

  it('(R4) isNull and isNotNull masks are exact complements within the bit length', () => {
    fc.assert(
      fc.property(columnArb(), (column) => {
        const n = column.value.length;
        const nul = reference.filterMask(column, { op: 'isNull' });
        const notNul = reference.filterMask(column, { op: 'isNotNull' });
        expect(Array.from(reference.bitmapOp('or', nul, notNul, n))).toEqual(
          Array.from(reference.bitmapOp('not', new Uint8Array(nul.length), null, n)),
        );
        expect(Array.from(reference.bitmapOp('and', nul, notNul, n))).toEqual(
          Array.from(new Uint8Array(nul.length)),
        );
      }),
      RUN,
    );
  });

  it('(R5) filter masks obey De Morgan through bitmapOp', () => {
    fc.assert(
      fc.property(columnArb(), valueArb, valueArb, (column, lower, upper) => {
        const n = column.value.length;
        const lt = reference.filterMask(column, { op: 'lt', operand: lower });
        const gt = reference.filterMask(column, { op: 'gt', operand: upper });
        const left = reference.bitmapOp('not', reference.bitmapOp('or', lt, gt, n), null, n);
        const right = reference.bitmapOp(
          'and',
          reference.bitmapOp('not', lt, null, n),
          reference.bitmapOp('not', gt, null, n),
          n,
        );
        expect(Array.from(left)).toEqual(Array.from(right));
      }),
      RUN,
    );
  });
});
