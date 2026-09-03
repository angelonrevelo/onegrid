// =============================================================================
// The JS side of the raw-pointer ABI
//
// There is no wasm-bindgen here, on purpose. wasm-bindgen generates a JS shim
// whose shape is tied to the exact toolchain version that produced it, which
// means the binary and the binding must be regenerated together forever. This
// package instead pins a hand-written C ABI: integers, floats and pointers,
// nothing else. A module produced by any toolchain — rustc, clang, zig, hand-
// written wat — satisfies it as long as it exports these symbols, and the
// binding below never needs to be regenerated.
//
// The numeric operator codes in this file are the load-bearing half of the
// contract. They MUST match `crate/src/lib.rs` exactly; both sides carry the
// same table, and `og_abi_version` is checked at bind time so a stale binary
// fails loudly at startup instead of silently computing `lt` where the caller
// asked for `gt`.
// =============================================================================

import type { AccelMemory } from './memory';
import type { AccelAggregateOp, AccelBitmapOp, AccelPredicateOp } from './types';

/**
 * Bumped whenever a signature or an operator code changes. A module reporting
 * a different version is rejected rather than adapted — the whole value of a
 * hand-written ABI is that it is small enough to version honestly.
 */
export const ACCEL_ABI_VERSION = 1;

export const PREDICATE_CODE: Record<AccelPredicateOp, number> = {
  eq: 0,
  neq: 1,
  lt: 2,
  lte: 3,
  gt: 4,
  gte: 5,
  between: 6,
  notBetween: 7,
  in: 8,
  notIn: 9,
  isNull: 10,
  isNotNull: 11,
};

export const AGGREGATE_CODE: Record<AccelAggregateOp, number> = {
  sum: 0,
  avg: 1,
  count: 2,
  countDistinct: 3,
  min: 4,
  max: 5,
  first: 6,
  last: 7,
};

export const BITMAP_CODE: Record<AccelBitmapOp, number> = {
  and: 0,
  or: 1,
  not: 2,
  andNot: 3,
  xor: 4,
};

/**
 * Every export the kernel must provide. All pointers are byte offsets into
 * `memory`; all lengths are element counts; every `u32` boolean is 0 or 1.
 * See `crate/src/lib.rs` for the authoritative per-function documentation.
 * @public
 */
export interface AccelModule {
  readonly memory: AccelMemory;

  /** Must equal ACCEL_ABI_VERSION. */
  og_abi_version(): number;
  /** First byte above the module's static data. The JS bump allocator owns everything from here up. */
  og_heap_base(): number;

  /** One stable sort pass, refining an existing permutation in place. */
  og_sort_pass(
    valuePtr: number,
    presencePtr: number,
    length: number,
    descending: number,
    missingFirst: number,
    permPtr: number,
    scratchPtr: number,
  ): void;

  og_filter_mask(
    valuePtr: number,
    presencePtr: number,
    length: number,
    op: number,
    operand: number,
    upper: number,
    setPtr: number,
    setLength: number,
    outPtr: number,
  ): void;

  /** Factorise one column. Returns the cardinality, or -1 if the hash table filled. */
  og_group_code(
    valuePtr: number,
    presencePtr: number,
    length: number,
    outPtr: number,
    slotKeyPtr: number,
    slotCodePtr: number,
    slotCapacity: number,
  ): number;

  /** Renumber (a[i], b[i]) pairs into dense codes. Returns the cardinality, or -1. */
  og_group_combine(
    aPtr: number,
    bPtr: number,
    length: number,
    outPtr: number,
    slotAPtr: number,
    slotBPtr: number,
    slotCodePtr: number,
    slotCapacity: number,
  ): number;

  /** Writes the result to outPtr. Returns 1 when a value exists, 0 for null. */
  og_aggregate(
    op: number,
    valuePtr: number,
    presencePtr: number,
    length: number,
    indexPtr: number,
    indexLength: number,
    slotKeyPtr: number,
    slotStatePtr: number,
    slotCapacity: number,
    outPtr: number,
  ): number;

  og_bitmap_op(
    op: number,
    aPtr: number,
    bPtr: number,
    bitLength: number,
    outPtr: number,
  ): void;

  /** Returns the number of indices written to outPtr (min(k, length)). */
  og_top_k(
    valuePtr: number,
    presencePtr: number,
    length: number,
    k: number,
    descending: number,
    missingFirst: number,
    outPtr: number,
    scratchPtr: number,
  ): number;
}

/**
 * Open-addressed tables need slack or probing degenerates. Two-times the row
 * count rounded to a power of two keeps the load factor at or below 0.5, which
 * is the point where linear probing stays O(1) in practice.
 */
export function hashCapacityFor(length: number): number {
  let capacity = 16;
  const want = Math.max(1, length) * 2;
  while (capacity < want) capacity *= 2;
  return capacity;
}
