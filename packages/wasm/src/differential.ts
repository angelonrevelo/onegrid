// =============================================================================
// Differential testing — the only reason to trust a second implementation
//
// A Rust kernel that is 6x faster and 0.01% wrong is worse than no kernel at
// all: the grid would show a different total depending on whether the host
// happened to support WebAssembly, and the bug would be unreproducible on the
// developer's machine. So the contract this package actually ships is not
// "there is a WASM path" — it is "the WASM path and the JS path are the same
// function".
//
// An `AccelCase` is a reified call: the operation plus its arguments, as data.
// Reifying it is what lets the same value drive `assertBackendEquivalent`
// (are these two backends the same?) and `benchBackend` (how much faster is
// one of them?), so a case that is proven equivalent is the exact case that
// gets benchmarked.
//
// Equality is structural and uses `Object.is` for scalars, deliberately. `===`
// would consider `-0` and `0` equal and would consider `NaN` unequal to
// itself; both are exactly the distinctions this package promises to preserve,
// so the comparison has to be able to see them.
// =============================================================================

import type {
  AccelAggregateOp,
  AccelBackend,
  AccelBitmapOp,
  AccelColumn,
  AccelGroupCode,
  AccelPredicate,
  AccelSortKey,
  AccelTopKOption,
} from './types';
import { byteLengthFor, setBit } from './bit';

/** A reified call against an AccelBackend. @public */
export type AccelCase =
  | {
      readonly kind: 'sortIndex';
      readonly name: string;
      readonly key: ReadonlyArray<AccelSortKey>;
      readonly length: number;
    }
  | {
      readonly kind: 'filterMask';
      readonly name: string;
      readonly column: AccelColumn;
      readonly predicate: AccelPredicate;
    }
  | {
      readonly kind: 'groupKey';
      readonly name: string;
      readonly key: ReadonlyArray<AccelColumn>;
      readonly length: number;
    }
  | {
      readonly kind: 'aggregate';
      readonly name: string;
      readonly op: AccelAggregateOp;
      readonly column: AccelColumn;
      readonly index: Int32Array | null;
    }
  | {
      readonly kind: 'bitmapOp';
      readonly name: string;
      readonly op: AccelBitmapOp;
      readonly a: Uint8Array;
      readonly b: Uint8Array | null;
      readonly bitLength: number;
    }
  | {
      readonly kind: 'topK';
      readonly name: string;
      readonly column: AccelColumn;
      readonly k: number;
      readonly option?: AccelTopKOption;
    };

/** Whatever the six operations can return. @public */
export type AccelResult = Int32Array | Uint8Array | AccelGroupCode | number | null;

/** Raised when two backends disagree. Carries both results for the failure message. @public */
export class AccelDivergenceError extends Error {
  readonly caseName: string;
  readonly left: AccelResult;
  readonly right: AccelResult;

  constructor(caseName: string, detail: string, left: AccelResult, right: AccelResult) {
    super(`AccelBackend divergence on "${caseName}": ${detail}`);
    this.name = 'AccelDivergenceError';
    this.caseName = caseName;
    this.left = left;
    this.right = right;
  }
}

/** Execute a reified case against a backend. @public */
export function runCase(backend: AccelBackend, testCase: AccelCase): AccelResult {
  switch (testCase.kind) {
    case 'sortIndex':
      return backend.sortIndex(testCase.key, testCase.length);
    case 'filterMask':
      return backend.filterMask(testCase.column, testCase.predicate);
    case 'groupKey':
      return backend.groupKey(testCase.key, testCase.length);
    case 'aggregate':
      return backend.aggregate(testCase.op, testCase.column, testCase.index);
    case 'bitmapOp':
      return backend.bitmapOp(testCase.op, testCase.a, testCase.b, testCase.bitLength);
    default:
      return backend.topK(testCase.column, testCase.k, testCase.option);
  }
}

function isGroupCode(value: AccelResult): value is AccelGroupCode {
  return typeof value === 'object' && value !== null && 'cardinality' in value;
}

/** Describe the first difference between two results, or null when identical. */
function difference(left: AccelResult, right: AccelResult): string | null {
  if (left === null || right === null) {
    return Object.is(left, right) ? null : `${describe(left)} vs ${describe(right)}`;
  }
  if (typeof left === 'number' || typeof right === 'number') {
    if (typeof left !== typeof right) return `${describe(left)} vs ${describe(right)}`;
    return Object.is(left, right) ? null : `${describe(left)} vs ${describe(right)}`;
  }
  if (isGroupCode(left) || isGroupCode(right)) {
    if (!isGroupCode(left) || !isGroupCode(right)) {
      return `${describe(left)} vs ${describe(right)}`;
    }
    if (left.cardinality !== right.cardinality) {
      return `cardinality ${left.cardinality} vs ${right.cardinality}`;
    }
    return difference(left.code, right.code);
  }
  if (left.length !== right.length) {
    return `length ${left.length} vs ${right.length}`;
  }
  for (let i = 0; i < left.length; i++) {
    const a = left[i] as number;
    const b = right[i] as number;
    if (!Object.is(a, b)) return `index ${i}: ${a} vs ${b}`;
  }
  return null;
}

function describe(value: AccelResult): string {
  if (value === null) return 'null';
  if (typeof value === 'number') return Object.is(value, -0) ? '-0' : String(value);
  if (isGroupCode(value)) return `groupCode(cardinality=${value.cardinality})`;
  return `${value.constructor.name}(${value.length})`;
}

/**
 * Run one case against both backends and throw unless the results are
 * identical. Returns the shared result so a caller can assert on it too —
 * "they agree" is worth little if they agree on something absurd.
 * @public
 */
export function assertBackendEquivalent(
  left: AccelBackend,
  right: AccelBackend,
  testCase: AccelCase,
): AccelResult {
  const a = runCase(left, testCase);
  const b = runCase(right, testCase);
  const detail = difference(a, b);
  if (detail !== null) {
    throw new AccelDivergenceError(
      `${testCase.name} (${left.name} vs ${right.name})`,
      detail,
      a,
      b,
    );
  }
  return a;
}

// -----------------------------------------------------------------------------
// Edge cases
// -----------------------------------------------------------------------------

function column(value: ReadonlyArray<number>, missing: ReadonlyArray<number> = []): AccelColumn {
  const data = Float64Array.from(value);
  if (missing.length === 0) return { value: data };
  const validity = new Uint8Array(byteLengthFor(data.length));
  for (let i = 0; i < data.length; i++) if (!missing.includes(i)) setBit(validity, i);
  return { value: data, validity };
}

/**
 * The cases that have historically broken every hand-rolled kernel. This list
 * is deliberately hand-written rather than generated: property generators find
 * *classes* of bugs, but they only reliably produce a NaN, a `-0` and an empty
 * input if someone remembers to weight them in, and the whole point of these
 * six is that they are the ones nobody remembers.
 * @public
 */
export function edgeCase(): ReadonlyArray<AccelCase> {
  const mixed = column([3, NaN, -0, 0, -1, NaN, 2]);
  const holed = column([5, 1, 9, 1, 5], [1, 3]);
  const empty = column([]);
  const single = column([42]);
  const singleMissing = column([7], [0]);

  const list: AccelCase[] = [];

  // Sorting. NaN must land with the missing rows, -0 must tie with 0 and lose
  // the tiebreak to whichever came first.
  for (const descending of [false, true]) {
    for (const missingFirst of [false, true]) {
      const suffix = `${descending ? 'desc' : 'asc'}/${missingFirst ? 'missingFirst' : 'missingLast'}`;
      list.push({
        kind: 'sortIndex',
        name: `sort mixed NaN and -0 ${suffix}`,
        key: [{ ...mixed, descending, missingFirst }],
        length: mixed.value.length,
      });
      list.push({
        kind: 'sortIndex',
        name: `sort validity holes ${suffix}`,
        key: [{ ...holed, descending, missingFirst }],
        length: holed.value.length,
      });
    }
  }
  list.push({ kind: 'sortIndex', name: 'sort empty', key: [{ ...empty }], length: 0 });
  list.push({ kind: 'sortIndex', name: 'sort single', key: [{ ...single }], length: 1 });
  list.push({
    kind: 'sortIndex',
    name: 'sort single missing',
    key: [{ ...singleMissing }],
    length: 1,
  });
  list.push({ kind: 'sortIndex', name: 'sort no key', key: [], length: 4 });
  // Two keys where the first is all ties: the result is decided entirely by
  // the second, which is how a multi-pass kernel proves it is really stable.
  list.push({
    kind: 'sortIndex',
    name: 'sort two keys, first all equal',
    key: [
      { value: Float64Array.from([1, 1, 1, 1, 1]) },
      { value: Float64Array.from([4, 2, 5, 1, 3]), descending: true },
    ],
    length: 5,
  });

  // Filtering.
  const predicate: ReadonlyArray<AccelPredicate> = [
    { op: 'eq', operand: 0 },
    { op: 'neq', operand: 0 },
    { op: 'lt', operand: 2 },
    { op: 'lte', operand: 2 },
    { op: 'gt', operand: -1 },
    { op: 'gte', operand: -1 },
    { op: 'between', operand: -1, upper: 3 },
    { op: 'notBetween', operand: -1, upper: 3 },
    { op: 'in', set: Float64Array.from([0, 9, 5]) },
    { op: 'notIn', set: Float64Array.from([0, 9, 5]) },
    { op: 'isNull' },
    { op: 'isNotNull' },
  ];
  for (const p of predicate) {
    list.push({ kind: 'filterMask', name: `filter ${p.op} on NaN/-0`, column: mixed, predicate: p });
    list.push({ kind: 'filterMask', name: `filter ${p.op} on holes`, column: holed, predicate: p });
    list.push({ kind: 'filterMask', name: `filter ${p.op} on empty`, column: empty, predicate: p });
    list.push({ kind: 'filterMask', name: `filter ${p.op} on single`, column: single, predicate: p });
  }

  // Grouping. -0 and 0 must land in one group; every missing row in another.
  list.push({ kind: 'groupKey', name: 'group NaN/-0', key: [mixed], length: mixed.value.length });
  list.push({ kind: 'groupKey', name: 'group holes', key: [holed], length: holed.value.length });
  list.push({ kind: 'groupKey', name: 'group empty', key: [empty], length: 0 });
  list.push({ kind: 'groupKey', name: 'group single', key: [single], length: 1 });
  list.push({ kind: 'groupKey', name: 'group no key', key: [], length: 3 });
  list.push({
    kind: 'groupKey',
    name: 'group two keys',
    key: [column([1, 1, 2, 2, 1]), column([7, 8, 7, 8, 7])],
    length: 5,
  });

  // Aggregation, with and without an index subset.
  const op: ReadonlyArray<AccelAggregateOp> = [
    'sum',
    'avg',
    'count',
    'countDistinct',
    'min',
    'max',
    'first',
    'last',
  ];
  for (const o of op) {
    list.push({ kind: 'aggregate', name: `${o} over NaN/-0`, op: o, column: mixed, index: null });
    list.push({ kind: 'aggregate', name: `${o} over holes`, op: o, column: holed, index: null });
    list.push({ kind: 'aggregate', name: `${o} over empty`, op: o, column: empty, index: null });
    list.push({ kind: 'aggregate', name: `${o} over single`, op: o, column: single, index: null });
    list.push({
      kind: 'aggregate',
      name: `${o} over all-missing`,
      op: o,
      column: singleMissing,
      index: null,
    });
    list.push({
      kind: 'aggregate',
      name: `${o} over index subset`,
      op: o,
      column: holed,
      index: Int32Array.from([4, 0, 2]),
    });
    list.push({
      kind: 'aggregate',
      name: `${o} over empty index`,
      op: o,
      column: holed,
      index: new Int32Array(0),
    });
  }

  // Bitmaps, including a length that is not a byte multiple so the tail bits
  // have to be cleared identically on both sides.
  const bitmapOp: ReadonlyArray<AccelBitmapOp> = ['and', 'or', 'not', 'andNot', 'xor'];
  for (const o of bitmapOp) {
    for (const bitLength of [0, 1, 7, 8, 9, 17]) {
      const bytes = byteLengthFor(bitLength);
      const a = new Uint8Array(bytes).fill(0b10110101);
      const b = new Uint8Array(bytes).fill(0b01101100);
      list.push({ kind: 'bitmapOp', name: `bitmap ${o} @${bitLength}`, op: o, a, b, bitLength });
    }
  }

  // topK, including k larger than the input and k of zero.
  for (const descending of [false, true]) {
    for (const k of [0, 1, 3, 99]) {
      list.push({
        kind: 'topK',
        name: `topK ${k} ${descending ? 'desc' : 'asc'} on NaN/-0`,
        column: mixed,
        k,
        option: { descending },
      });
      list.push({
        kind: 'topK',
        name: `topK ${k} ${descending ? 'desc' : 'asc'} missingFirst`,
        column: holed,
        k,
        option: { descending, missingFirst: true },
      });
      list.push({
        kind: 'topK',
        name: `topK ${k} ${descending ? 'desc' : 'asc'} on empty`,
        column: empty,
        k,
        option: { descending },
      });
    }
  }

  return list;
}
