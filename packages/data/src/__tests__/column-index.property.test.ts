// =============================================================================
// ColumnIndex equivalence — the indexed path must be filterIndex /
// enumerateDistinct, bit for bit.
//
// The generators lean on the values where a dictionary could plausibly go
// wrong: -0 vs 0 (one SameValueZero key, two Object.is values), NaN (its own
// key), '1' vs 1 (distinct keys that compare equal), case and accent variants
// (collator-sensitive), '' (contains every needle), and a validity bitmap that
// marks a present value null.
// =============================================================================

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { ComparisonOperator, FilterNode } from '@onegrid/protocol';
import { createColumnTable, type ColumnTable } from '../column-table';
import { enumerateDistinct } from '../distinct';
import { filterIndex } from '../filter';
import {
  createTableIndex,
  enumerateDistinctIndexed,
  filterIndexed,
  type ColumnIndexMode,
} from '../column-index';

const cellArb = fc.oneof(
  { weight: 5, arbitrary: fc.constantFrom('a', 'A', 'ab', 'Ab', 'ba', 'é', 'e', '', '1', 'aik', 'aiko') },
  { weight: 3, arbitrary: fc.constantFrom(1, 2, -0, 0, Number.NaN, 2.5, -3) },
  { weight: 2, arbitrary: fc.constantFrom(null, undefined) },
  { weight: 1, arbitrary: fc.constantFrom(true, false) },
);

const operandArb = fc.oneof(
  fc.constantFrom('a', 'A', 'b', '', '1', 'ai', 'é'),
  fc.constantFrom(0, -0, 1, 2, Number.NaN),
  fc.constantFrom(null, true),
);

const opArb = fc.constantFrom<ComparisonOperator>(
  'eq',
  'neq',
  'lt',
  'lte',
  'gt',
  'gte',
  'in',
  'notIn',
  'contains',
  'notContains',
  'startsWith',
  'endsWith',
  'isNull',
  'isNotNull',
  'between',
  'notBetween',
);

const COLUMN_ID = ['x', 'y'] as const;

const tableArb: fc.Arbitrary<ColumnTable> = fc
  .integer({ min: 0, max: 60 })
  .chain((n) =>
    fc.tuple(
      fc.array(cellArb, { minLength: n, maxLength: n }),
      fc.array(cellArb, { minLength: n, maxLength: n }),
      fc.option(fc.uint8Array({ minLength: (n + 7) >> 3, maxLength: (n + 7) >> 3 }), {
        nil: undefined,
      }),
    ),
  )
  .map(([x, y, validity]) =>
    createColumnTable([
      { schema: { id: 'x', type: 'utf8' }, data: x, ...(validity ? { validity } : {}) },
      { schema: { id: 'y', type: 'utf8' }, data: y },
    ]),
  );

const leafArb: fc.Arbitrary<FilterNode> = fc.record({
  type: fc.constant('comparison' as const),
  columnId: fc.constantFrom(...COLUMN_ID, 'missing'),
  op: opArb,
  value: operandArb,
  values: fc.array(operandArb, { maxLength: 3 }),
  caseSensitive: fc.boolean(),
});

const filterArb: fc.Arbitrary<FilterNode> = fc.letrec((tie) => ({
  node: fc.oneof(
    { weight: 3, arbitrary: leafArb },
    {
      weight: 1,
      arbitrary: fc.record({
        type: fc.constant('logical' as const),
        op: fc.constantFrom('and' as const, 'or' as const, 'not' as const),
        filters: fc.array(tie('node') as fc.Arbitrary<FilterNode>, { maxLength: 3 }),
      }),
    },
  ),
})).node;

// Every mode must be filterIndex. Small generated tables would always resolve
// 'auto' to 'dictionary', so 'row' is forced explicitly to exercise that path.
const modeArb = fc.constantFrom<ColumnIndexMode>('auto', 'dictionary', 'row');

const RUN = { numRuns: 400 } as const;

describe('filterIndexed ≡ filterIndex', () => {
  it('(I1) any filter tree over any table produces identical bitmaps, in every mode', () => {
    fc.assert(
      fc.property(tableArb, filterArb, modeArb, (table, filter, mode) => {
        const want = filterIndex(table, filter);
        const got = filterIndexed(createTableIndex(table, { mode }), filter);
        expect(Array.from(got._bytes)).toEqual(Array.from(want._bytes));
      }),
      RUN,
    );
  });

  it('(I2) a reused TableIndex stays exact across a keystroke sequence (typeahead refinement)', () => {
    fc.assert(
      fc.property(
        tableArb,
        fc.array(fc.constantFrom('', 'a', 'ai', 'aik', 'aiko', 'b', 'A', 'é', '1'), {
          maxLength: 8,
        }),
        fc.boolean(),
        modeArb,
        (table, needle, caseSensitive, mode) => {
          const tableIndex = createTableIndex(table, { mode });
          for (const value of needle) {
            for (const op of ['contains', 'notContains'] as const) {
              const filter: FilterNode = { type: 'comparison', columnId: 'x', op, value, caseSensitive };
              expect(Array.from(filterIndexed(tableIndex, filter)._bytes)).toEqual(
                Array.from(filterIndex(table, filter)._bytes),
              );
            }
          }
        },
      ),
      RUN,
    );
  });
});

describe('auto mode at scale', () => {
  it('(I5) near-unique and repeated columns in one 20K-row table match filterIndex', () => {
    const n = 20_000;
    const table = createColumnTable([
      // Near-unique: 'auto' must route these through the per-row path.
      { schema: { id: 'id', type: 'utf8' }, data: Array.from({ length: n }, (_, i) => `Row-${i}`) },
      { schema: { id: 'price', type: 'float64' }, data: Float64Array.from({ length: n }, (_, i) => i * 0.37) },
      // Repeated, with nulls: the dictionary path.
      {
        schema: { id: 'status', type: 'utf8' },
        data: Array.from({ length: n }, (_, i) => (i % 97 === 0 ? null : ['Active', 'pending', 'CLOSED'][i % 3]!)),
      },
    ]);
    const tableIndex = createTableIndex(table);
    const leaf = (columnId: string, op: ComparisonOperator, value: unknown, caseSensitive = false): FilterNode => ({
      type: 'comparison',
      columnId,
      op,
      value,
      caseSensitive,
    });
    const filter: FilterNode[] = [
      leaf('id', 'contains', 'row-1'),
      leaf('id', 'contains', 'Row-1', true),
      leaf('id', 'notContains', 'ow-19'),
      leaf('id', 'startsWith', 'row-19'),
      leaf('id', 'endsWith', '7'),
      leaf('id', 'eq', 'Row-42'),
      leaf('price', 'contains', '.37'),
      leaf('price', 'gt', 5000),
      leaf('status', 'contains', 'ACT'),
      leaf('status', 'isNull', null),
      {
        type: 'logical',
        op: 'or',
        filters: [leaf('id', 'contains', '99'), leaf('price', 'contains', '99'), leaf('status', 'contains', 'clo')],
      },
    ];
    for (const value of ['r', 'ro', 'row', 'row-', 'row-1', 'row-12', 'x', '']) {
      filter.push(leaf('id', 'contains', value));
    }
    for (const f of filter) {
      expect(Array.from(filterIndexed(tableIndex, f)._bytes)).toEqual(Array.from(filterIndex(table, f)._bytes));
    }
  });
});

describe('enumerateDistinctIndexed ≡ enumerateDistinct', () => {
  it('(I3) with no row filter', () => {
    fc.assert(
      fc.property(tableArb, fc.option(fc.nat({ max: 12 }), { nil: null }), (table, limit) => {
        const want = enumerateDistinct(table, 'x', { limit });
        const got = enumerateDistinctIndexed(createTableIndex(table), 'x', { limit });
        expect(got).toEqual(want);
      }),
      RUN,
    );
  });

  it('(I4) restricted to the rows another filter selected', () => {
    fc.assert(
      fc.property(tableArb, filterArb, (table, filter) => {
        const selection = filterIndex(table, filter);
        const want = enumerateDistinct(table, 'x', {
          rowFilter: (i) => selection.contains(i),
          limit: null,
        });
        const got = enumerateDistinctIndexed(createTableIndex(table), 'x', {
          selection,
          limit: null,
        });
        expect(got).toEqual(want);
      }),
      RUN,
    );
  });
});

describe('ColumnIndex structure', () => {
  it('posting lists partition the non-null rows in ascending order', () => {
    const table = createColumnTable([
      { schema: { id: 's', type: 'utf8' }, data: ['b', null, 'a', 'b', undefined, 'a', 'b'] },
    ]);
    const index = createTableIndex(table).column('s');
    expect(index.value).toEqual(['b', 'a']);
    expect(Array.from(index.code)).toEqual([0, -1, 1, 0, -1, 1, 0]);
    expect(Array.from(index.offset)).toEqual([0, 3, 5]);
    expect(Array.from(index.row)).toEqual([0, 3, 6, 2, 5]);
    expect(index.nullCount).toBe(2);
  });
});
