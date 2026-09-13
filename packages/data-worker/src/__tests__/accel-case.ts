// =============================================================================
// Shared generators + the equivalence assertion for the accel tests.
//
// Seeded, not fast-check: data-worker carries no property-testing dependency,
// and a fixed xorshift seed makes a failure reproducible by case number.
//
// The pools lean on the values where the kernel's model and @onegrid/data's
// could plausibly part ways: -0 vs 0, ±Infinity, NaN (present in data, missing
// in the kernel), numbers in a utf8-typed column, strings and booleans mixed
// into a numeric column, NaN and string operands, out-of-range row indices.
// =============================================================================

import { expect } from 'vitest';
import { aggregate, createColumnTable, filterIndex, groupRows, sortIndex } from '@onegrid/data';
import type { ColumnInput, ColumnTable } from '@onegrid/data';
import type {
  Aggregation,
  ComparisonOperator,
  FilterNode,
  GroupingModel,
  SortModel,
} from '@onegrid/protocol';
import type { AccelBackend } from '@onegrid/wasm';
import { accelAggregate, accelFilterIndex, accelGroupRows, accelSortIndex } from '../accel.js';

export type Rand = () => number;

export function seeded(seed: number): Rand {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 0x100000000;
  };
}

const pick = <T>(rand: Rand, pool: ReadonlyArray<T>): T => pool[Math.floor(rand() * pool.length)]!;

const NUMBER = [-3, -1, -0, 0, 0, 1, 2, 2, 2.5, Infinity, -Infinity] as const;
export const COLUMN_ID = ['a', 'b', 'c', 'nan', 'u', 's', 'mix'] as const;

function validity(rand: Rand, n: number): Uint8Array | undefined {
  if (rand() < 0.5) return undefined;
  const out = new Uint8Array((n + 7) >>> 3);
  for (let i = 0; i < n; i++) if (rand() > 0.2) out[i >>> 3]! |= 1 << (i & 7);
  return out;
}

export function randomTable(rand: Rand, maxRow = 60): ColumnTable {
  const n = Math.floor(rand() * (maxRow + 1));
  const a = Float64Array.from({ length: n }, () => pick(rand, NUMBER));
  const b = Int32Array.from({ length: n }, () => Math.floor(rand() * 6) - 1);
  const c = Array.from({ length: n }, () => (rand() < 0.2 ? pick(rand, [null, undefined]) : pick(rand, NUMBER)));
  const nan = Float64Array.from({ length: n }, () => (rand() < 0.08 ? Number.NaN : pick(rand, NUMBER)));
  const u = Array.from({ length: n }, () => pick(rand, NUMBER));
  const s = Array.from({ length: n }, () => pick(rand, ['x', 'y', 'X', '1', '', null]));
  const mix = Array.from({ length: n }, () => (rand() < 0.1 ? pick(rand, [true, '2', new Date(5)]) : pick(rand, NUMBER)));
  const aValidity = validity(rand, n);
  const bValidity = validity(rand, n);
  const input: ColumnInput[] = [
    { schema: { id: 'a', type: 'float64' }, data: a, ...(aValidity ? { validity: aValidity } : {}) },
    { schema: { id: 'b', type: 'int32' }, data: b, ...(bValidity ? { validity: bValidity } : {}) },
    { schema: { id: 'c', type: 'float64' }, data: c },
    { schema: { id: 'nan', type: 'float64' }, data: nan },
    { schema: { id: 'u', type: 'utf8' }, data: u },
    { schema: { id: 's', type: 'utf8' }, data: s },
    { schema: { id: 'mix', type: 'float64' }, data: mix },
  ];
  return createColumnTable(input);
}

const OPERAND: ReadonlyArray<unknown> = [0, -0, 1, 2.5, -1, Infinity, Number.NaN, '1', 'x', null, true];
const OPERATOR: ReadonlyArray<ComparisonOperator> = [
  'eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'in', 'notIn', 'between', 'notBetween',
  'isNull', 'isNotNull', 'contains', 'notContains', 'startsWith', 'endsWith',
];

export function randomSort(rand: Rand): SortModel {
  const length = 1 + Math.floor(rand() * 3);
  return Array.from({ length }, () => ({
    columnId: pick(rand, COLUMN_ID),
    direction: pick(rand, ['asc', 'desc'] as const),
    ...(rand() < 0.66 ? { nulls: pick(rand, ['first', 'last'] as const) } : {}),
  }));
}

export function randomFilter(rand: Rand, depth = 0): FilterNode {
  if (depth >= 2 || rand() < 0.6) {
    const numericBias = rand() < 0.7;
    return {
      type: 'comparison',
      columnId: rand() < 0.05 ? 'missing' : pick(rand, COLUMN_ID),
      op: pick(rand, OPERATOR),
      value: numericBias ? pick(rand, NUMBER) : pick(rand, OPERAND),
      values: Array.from({ length: Math.floor(rand() * 4) }, () =>
        numericBias ? pick(rand, NUMBER) : pick(rand, OPERAND),
      ),
    };
  }
  return {
    type: 'logical',
    op: pick(rand, ['and', 'or', 'not'] as const),
    filters: Array.from({ length: Math.floor(rand() * 4) }, () => randomFilter(rand, depth + 1)),
  };
}

export function randomGrouping(rand: Rand): GroupingModel {
  const length = 1 + Math.floor(rand() * 2);
  return {
    columns: Array.from({ length }, () => pick(rand, ['a', 'b', 'c', 'nan', 's', 'mix'] as const)),
    openKeys: [],
  };
}

const AGGREGATE_FN = ['sum', 'avg', 'count', 'countDistinct', 'min', 'max', 'first', 'last'] as const;

export function randomAggregation(rand: Rand): Aggregation {
  return {
    columnId: pick(rand, COLUMN_ID),
    fn: pick(rand, AGGREGATE_FN),
    ...(rand() < 0.3 ? { alias: 'z' } : {}),
  };
}

export function randomRowIndex(rand: Rand, n: number): number[] | null {
  if (rand() < 0.4) return null;
  const out = Array.from({ length: Math.floor(rand() * (n + 1)) }, () => Math.floor(rand() * Math.max(1, n)));
  if (rand() < 0.1) out.push(n + 3); // out of range — must fall back, not read past the end
  return out;
}

export interface KernelHit {
  sortIndex: number;
  filterMask: number;
  groupKey: number;
  aggregate: number;
}

/** Wrap a backend so the tests can prove the kernel path actually ran. */
export function counted(backend: AccelBackend): { backend: AccelBackend; hit: KernelHit } {
  const hit: KernelHit = { sortIndex: 0, filterMask: 0, groupKey: 0, aggregate: 0 };
  return {
    hit,
    backend: {
      ...backend,
      sortIndex: (...arg) => {
        hit.sortIndex++;
        return backend.sortIndex(...arg);
      },
      filterMask: (...arg) => {
        hit.filterMask++;
        return backend.filterMask(...arg);
      },
      groupKey: (...arg) => {
        hit.groupKey++;
        return backend.groupKey(...arg);
      },
      aggregate: (...arg) => {
        hit.aggregate++;
        return backend.aggregate(...arg);
      },
    },
  };
}

/** Run `caseCount` randomized cases of every job against @onegrid/data. */
export function assertAccelEquivalent(backend: AccelBackend, seed: number, caseCount: number): KernelHit {
  const rand = seeded(seed);
  const wrapped = counted(backend);
  for (let k = 0; k < caseCount; k++) {
    const table = randomTable(rand);
    const label = `seed ${String(seed)} case ${String(k)}`;

    const sort = randomSort(rand);
    expect(Array.from(accelSortIndex(wrapped.backend, table, sort)), `${label} sort`).toEqual(
      Array.from(sortIndex(table, sort)),
    );

    const filter = randomFilter(rand);
    expect(Array.from(accelFilterIndex(wrapped.backend, table, filter)._bytes), `${label} filter`).toEqual(
      Array.from(filterIndex(table, filter)._bytes),
    );

    const grouping = randomGrouping(rand);
    const aggregations = Array.from({ length: Math.floor(rand() * 3) }, () => randomAggregation(rand));
    expect(accelGroupRows(wrapped.backend, table, grouping, { aggregations }), `${label} group`).toEqual(
      groupRows(table, grouping, { aggregations }),
    );

    const aggregation = randomAggregation(rand);
    const rowIndex = randomRowIndex(rand, table.numRows);
    const want = aggregate(table, aggregation, rowIndex);
    const got = accelAggregate(wrapped.backend, table, aggregation, rowIndex);
    // toBe is Object.is: -0 and 0 are different answers.
    expect(got, `${label} aggregate ${aggregation.fn}(${aggregation.columnId})`).toBe(want);
  }
  return wrapped.hit;
}
