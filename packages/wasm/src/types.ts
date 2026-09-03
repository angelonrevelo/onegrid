// =============================================================================
// AccelBackend — the acceleration seam's contract
//
// Everything crossing this boundary is a typed array or a scalar. No object
// arrays, no strings, no callbacks. That is the whole point: an implementation
// on the other side may be JavaScript, WebAssembly over linear memory, or one
// day a native/GPU kernel, and the marshalling cost must stay proportional to
// sizeof(payload) rather than to the row count.
//
// -----------------------------------------------------------------------------
// The missing-value model (the one semantic every implementation must copy)
// -----------------------------------------------------------------------------
//
// A row is MISSING when its validity bit is clear, or when its value is NaN.
// Folding NaN into "missing" is deliberate. A comparator that returns 0 for
// every NaN pair is not a total order, and a sort built on a non-total order
// is allowed to produce different permutations for different algorithms —
// which would make JS and Rust legitimately disagree and make the differential
// harness worthless. Declaring NaN missing restores a total order, so the two
// implementations are obliged to agree element for element.
//
// Consequences, all of them intentional and all of them tested:
//   - Missing rows never satisfy a comparison predicate. Only isNull /
//     isNotNull observe them.
//   - Missing rows are skipped by every aggregate, exactly as @onegrid/data
//     skips nulls. avg of an all-missing column is null, not NaN.
//   - -0 and 0 compare equal, hash equal, and group together. Sorting is
//     stable, so a -0 that started before a 0 stays before it.
//
// -----------------------------------------------------------------------------
// Why indices and masks rather than reordered data
// -----------------------------------------------------------------------------
//
// sortIndex returns a permutation, filterMask returns a bitmask, topK returns
// indices. None of them move a byte of the source column. The grid reads
// column.get(perm[visibleRow]) for the ~40 rows actually on screen, so
// materialising a sorted copy of a million-row column would be pure waste. It
// also means a WASM implementation only has to copy the key column in and a
// 4-byte-per-row permutation out.
// =============================================================================

/**
 * A numeric column as it crosses the acceleration boundary.
 *
 * `value` is always float64 — every numeric grid type (int32, dates as epoch
 * millis, booleans as 0/1) is losslessly representable in a double up to 2^53,
 * and one payload type keeps the ABI to a single set of entry points. Strings
 * are deliberately out of scope: they cannot be accelerated without also
 * shipping a collator, and collation is where the interesting cost lives.
 * @public
 */
export interface AccelColumn {
  readonly value: Float64Array;
  /**
   * Optional Arrow-style validity bitmap: bit `i` set means row `i` is
   * present. Omit it to mean "every row present" — NaN still reads as missing.
   */
  readonly validity?: Uint8Array;
}

/** One level of a multi-column sort. @public */
export interface AccelSortKey extends AccelColumn {
  readonly descending?: boolean;
  /** Place missing rows before present ones. Default false (missing last). */
  readonly missingFirst?: boolean;
}

/**
 * Predicate operators `filterMask` understands. This is the numeric subset of
 * `ComparisonOperator` from `@onegrid/protocol` — the string operators are
 * absent because this boundary carries no strings.
 * @public
 */
export type AccelPredicateOp =
  | 'eq'
  | 'neq'
  | 'lt'
  | 'lte'
  | 'gt'
  | 'gte'
  | 'between'
  | 'notBetween'
  | 'in'
  | 'notIn'
  | 'isNull'
  | 'isNotNull';

/** @public */
export interface AccelPredicate {
  readonly op: AccelPredicateOp;
  /** Scalar operand for eq/neq/lt/lte/gt/gte and the lower bound of between. */
  readonly operand?: number;
  /** Upper bound, inclusive, for between/notBetween. */
  readonly upper?: number;
  /** Membership set for in/notIn. Compared by value, so -0 matches 0. */
  readonly set?: Float64Array;
}

/** Bitwise operators `bitmapOp` understands. @public */
export type AccelBitmapOp = 'and' | 'or' | 'not' | 'andNot' | 'xor';

/**
 * Reducers `aggregate` understands — the `AggregationType` union from
 * `@onegrid/protocol`, restricted to the ones that produce a number.
 * @public
 */
export type AccelAggregateOp =
  | 'sum'
  | 'avg'
  | 'count'
  | 'countDistinct'
  | 'min'
  | 'max'
  | 'first'
  | 'last';

/**
 * Dense group codes. `code[i]` is the group ordinal of row `i`, assigned in
 * order of first appearance so the result is deterministic and independent of
 * hash iteration order. `cardinality` is the number of distinct groups.
 * @public
 */
export interface AccelGroupCode {
  readonly code: Int32Array;
  readonly cardinality: number;
}

/** @public */
export interface AccelTopKOption {
  readonly descending?: boolean;
  readonly missingFirst?: boolean;
}

/**
 * What a host can actually run. Every field is a hard capability, never a
 * heuristic: each is decided by handing real module bytes to
 * `WebAssembly.validate`, or by reading a global the platform defines.
 * @public
 */
export interface AccelCapability {
  readonly wasm: boolean;
  readonly simd: boolean;
  readonly thread: boolean;
}

/**
 * The acceleration seam. Six operations, chosen because they are the six that
 * dominate a profile of `@onegrid/data` on a large grid: sorting a column,
 * evaluating a filter leaf, factorising a group-by key, reducing a group,
 * combining selection bitmaps, and answering "the biggest 100".
 * @public
 */
export interface AccelBackend {
  /** Stable identifier: `js`, `wasm`, or an adopter's own. */
  readonly name: string;
  readonly capability: AccelCapability;

  /**
   * Stable multi-key sort. Returns a permutation: `result[i]` is the source
   * row that belongs at output position `i`. Keys are applied left to right,
   * highest priority first. An empty key list returns the identity
   * permutation of `length`.
   */
  sortIndex(key: ReadonlyArray<AccelSortKey>, length: number): Int32Array;

  /**
   * Evaluate one predicate over one column. Returns a validity-style bitmask
   * of `ceil(length / 8)` bytes; bit `i` set means row `i` matched.
   */
  filterMask(column: AccelColumn, predicate: AccelPredicate): Uint8Array;

  /**
   * Factorise one or more columns into dense group codes. Rows sharing every
   * key value share a code; missing values form their own group per column.
   */
  groupKey(key: ReadonlyArray<AccelColumn>, length: number): AccelGroupCode;

  /**
   * Reduce a column, optionally restricted to `index`. Returns null where the
   * reduction is undefined (avg/min/max/first/last over no present row); sum
   * of nothing is 0 and count of nothing is 0, matching `@onegrid/data`.
   */
  aggregate(
    op: AccelAggregateOp,
    column: AccelColumn,
    index: Int32Array | null,
  ): number | null;

  /**
   * Combine selection bitmaps. `b` is ignored for `not`. Bits past
   * `bitLength` in the final byte are always cleared, so two bitmaps of the
   * same length are always byte-comparable.
   */
  bitmapOp(
    op: AccelBitmapOp,
    a: Uint8Array,
    b: Uint8Array | null,
    bitLength: number,
  ): Uint8Array;

  /**
   * The first `k` rows of `sortIndex` over the same column and option,
   * without paying for the other `n - k`. Returns fewer than `k` entries only
   * when the column is shorter than `k`.
   */
  topK(column: AccelColumn, k: number, option?: AccelTopKOption): Int32Array;

  /**
   * Release any resource the backend holds (WASM scratch space, worker
   * handles). Safe to call twice; the JS backend holds nothing and no-ops.
   */
  dispose(): void;
}
