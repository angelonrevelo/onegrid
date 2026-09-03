// =============================================================================
// createWasmBackend — marshalling, and nothing but marshalling
//
// Not one line of grid semantics lives here. Every function below does the
// same four things: allocate, copy in, call the kernel, copy out. The
// semantics live in `crate/src/lib.rs`, and the proof that they match lives in
// the differential harness. Keeping this file dumb is what makes that proof
// meaningful — a binding that "fixed up" a kernel result would be hiding
// exactly the disagreement the harness exists to find.
//
// Two rules hold throughout, and both exist because of the detached-buffer
// trap described at the top of `memory.ts`:
//
//   1. Every allocation for a call happens BEFORE any view is taken. Once the
//      last `alloc` has returned, the buffer can no longer be replaced for the
//      duration of the call.
//   2. A view is never held across a call to `heap.alloc` or across a kernel
//      call. Kernels can grow memory (a future threaded kernel certainly
//      will), so views are re-derived after every kernel return.
//
// Rule 2 is why the read-back helpers on WasmHeap (`readI32`, `readU8`,
// `readF64`) copy rather than return a view: a view handed to the grid would
// be a landmine that detonates on the next accelerated call.
// =============================================================================

import type { AccelModule } from './abi';
import {
  ACCEL_ABI_VERSION,
  AGGREGATE_CODE,
  BITMAP_CODE,
  PREDICATE_CODE,
  hashCapacityFor,
} from './abi';
import { WasmHeap } from './memory';
import { byteLengthFor, presenceBitmap, trimTail } from './bit';
import type {
  AccelAggregateOp,
  AccelBackend,
  AccelBitmapOp,
  AccelCapability,
  AccelColumn,
  AccelGroupCode,
  AccelPredicate,
  AccelSortKey,
  AccelTopKOption,
} from './types';

/** @public */
export interface WasmBackendOption {
  /**
   * What the host can do. Purely informational for the backend itself — the
   * module was already compiled with or without SIMD — but adopters read it
   * off the returned backend to log or to choose a kernel bundle.
   */
  readonly capability?: AccelCapability;
  /** Override the name reported by the backend, e.g. 'wasm-simd'. */
  readonly name?: string;
}

/**
 * A bound WASM backend also exposes its heap. Leak assertions ("`usedByte` is
 * back to zero after the call") are the only cheap way to catch a marshalling
 * path that forgot to release, so the allocator is public rather than hidden.
 * @public
 */
export interface WasmAccelBackend extends AccelBackend {
  readonly heap: WasmHeap;
}

/** Raised when a module does not satisfy the ABI. @public */
export class AccelAbiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AccelAbiError';
  }
}

const REQUIRED_EXPORT = [
  'og_abi_version',
  'og_heap_base',
  'og_sort_pass',
  'og_filter_mask',
  'og_group_code',
  'og_group_combine',
  'og_aggregate',
  'og_bitmap_op',
  'og_top_k',
] as const;

function assertModule(module: AccelModule): void {
  if (!module.memory || typeof module.memory.grow !== 'function') {
    throw new AccelAbiError('createWasmBackend: module does not export a linear memory.');
  }
  for (const name of REQUIRED_EXPORT) {
    if (typeof module[name] !== 'function') {
      throw new AccelAbiError(`createWasmBackend: module is missing export "${name}".`);
    }
  }
  const version = module.og_abi_version();
  if (version !== ACCEL_ABI_VERSION) {
    throw new AccelAbiError(
      `createWasmBackend: module reports ABI version ${version}, this binding speaks ${ACCEL_ABI_VERSION}.`,
    );
  }
}

/**
 * Bind an already-instantiated kernel module. Instantiation is the adopter's
 * job — they know whether the bytes come from `fetch`, from a bundler asset,
 * or from `fs` — and keeping it out of here is what lets this package stay
 * free of any environment assumption.
 */
export function createWasmBackend(
  module: AccelModule,
  option: WasmBackendOption = {},
): WasmAccelBackend {
  assertModule(module);
  const heap = new WasmHeap(module.memory, module.og_heap_base());
  const capability: AccelCapability = option.capability ?? {
    wasm: true,
    simd: false,
    thread: false,
  };

  function sortIndex(key: ReadonlyArray<AccelSortKey>, length: number): Int32Array {
    const n = Math.max(0, length | 0);
    const identity = new Int32Array(n);
    for (let i = 0; i < n; i++) identity[i] = i;
    if (key.length === 0 || n === 0) return identity;

    return heap.scope(() => {
      // A multi-key sort is a sequence of stable single-key passes applied
      // from the LOWEST priority key to the highest. That is identical to one
      // lexicographic comparator over a stable sort, and it keeps the kernel
      // to a single-key merge sort with no comparator indirection — which is
      // the shape that actually vectorises.
      const permPtr = heap.writeI32(identity);
      const scratchPtr = heap.alloc(n * 4, 8);
      for (let k = key.length - 1; k >= 0; k--) {
        const level = key[k]!;
        const mark = heap.mark();
        const valuePtr = heap.writeF64(level.value.subarray(0, n));
        const presencePtr = heap.writeU8(
          presenceBitmap(level.value, level.validity, n),
        );
        module.og_sort_pass(
          valuePtr,
          presencePtr,
          n,
          level.descending === true ? 1 : 0,
          level.missingFirst === true ? 1 : 0,
          permPtr,
          scratchPtr,
        );
        heap.release(mark);
      }
      return heap.readI32(permPtr, n);
    });
  }

  function filterMask(column: AccelColumn, predicate: AccelPredicate): Uint8Array {
    const n = column.value.length;
    const maskByte = byteLengthFor(n);
    return heap.scope(() => {
      const set = predicate.set ?? new Float64Array(0);
      const valuePtr = heap.writeF64(column.value.subarray(0, n));
      const presencePtr = heap.writeU8(presenceBitmap(column.value, column.validity, n));
      const setPtr = heap.writeF64(set);
      const outPtr = heap.alloc(maskByte, 8);
      module.og_filter_mask(
        valuePtr,
        presencePtr,
        n,
        PREDICATE_CODE[predicate.op],
        predicate.operand ?? 0,
        predicate.upper ?? 0,
        setPtr,
        set.length,
        outPtr,
      );
      return trimTail(heap.readU8(outPtr, maskByte), n);
    });
  }

  function groupKey(key: ReadonlyArray<AccelColumn>, length: number): AccelGroupCode {
    const n = Math.max(0, length | 0);
    if (n === 0) return { code: new Int32Array(0), cardinality: 0 };
    if (key.length === 0) return { code: new Int32Array(n), cardinality: 1 };

    return heap.scope(() => {
      const capacity = hashCapacityFor(n);
      const runningPtr = heap.alloc(n * 4, 8);
      const levelPtr = heap.alloc(n * 4, 8);
      const outPtr = heap.alloc(n * 4, 8);
      const slotKeyPtr = heap.alloc(capacity * 8, 8);
      const slotAPtr = heap.alloc(capacity * 4, 8);
      const slotBPtr = heap.alloc(capacity * 4, 8);
      const slotCodePtr = heap.alloc(capacity * 4, 8);
      // Only now that every allocation is done is it safe to take a view:
      // the buffer cannot be replaced again for the rest of this scope except
      // by a kernel call, and none has happened yet.
      heap.i32(runningPtr, n).fill(0);
      let cardinality = 1;

      for (const column of key) {
        const mark = heap.mark();
        const valuePtr = heap.writeF64(column.value.subarray(0, n));
        const presencePtr = heap.writeU8(presenceBitmap(column.value, column.validity, n));
        const levelCardinality = module.og_group_code(
          valuePtr,
          presencePtr,
          n,
          levelPtr,
          slotKeyPtr,
          slotCodePtr,
          capacity,
        );
        heap.release(mark);
        if (levelCardinality < 0) {
          throw new AccelAbiError('og_group_code: hash table overflowed.');
        }
        cardinality = module.og_group_combine(
          runningPtr,
          levelPtr,
          n,
          outPtr,
          slotAPtr,
          slotBPtr,
          slotCodePtr,
          capacity,
        );
        if (cardinality < 0) {
          throw new AccelAbiError('og_group_combine: hash table overflowed.');
        }
        // Fold the combined codes back into the running buffer. The kernel
        // needs its input and output to be disjoint, so this copy is what buys
        // the next iteration a clean output slot.
        heap.i32(runningPtr, n).set(heap.i32(outPtr, n));
      }
      return { code: heap.readI32(runningPtr, n), cardinality };
    });
  }

  function aggregate(
    op: AccelAggregateOp,
    column: AccelColumn,
    index: Int32Array | null,
  ): number | null {
    const n = column.value.length;
    return heap.scope(() => {
      const capacity = op === 'countDistinct' ? hashCapacityFor(index?.length ?? n) : 1;
      const valuePtr = heap.writeF64(column.value.subarray(0, n));
      const presencePtr = heap.writeU8(presenceBitmap(column.value, column.validity, n));
      const indexPtr = index ? heap.writeI32(index) : 0;
      const slotKeyPtr = heap.alloc(capacity * 8, 8);
      const slotStatePtr = heap.alloc(capacity * 4, 8);
      const outPtr = heap.alloc(8, 8);
      const present = module.og_aggregate(
        AGGREGATE_CODE[op],
        valuePtr,
        presencePtr,
        n,
        indexPtr,
        index ? index.length : -1,
        slotKeyPtr,
        slotStatePtr,
        capacity,
        outPtr,
      );
      if (present === 0) return null;
      return heap.readF64(outPtr, 1)[0] ?? null;
    });
  }

  function bitmapOp(
    op: AccelBitmapOp,
    a: Uint8Array,
    b: Uint8Array | null,
    bitLength: number,
  ): Uint8Array {
    const n = Math.max(0, bitLength | 0);
    const maskByte = byteLengthFor(n);
    return heap.scope(() => {
      const left = new Uint8Array(maskByte);
      left.set(a.subarray(0, Math.min(a.length, maskByte)));
      const right = new Uint8Array(maskByte);
      if (b) right.set(b.subarray(0, Math.min(b.length, maskByte)));
      const aPtr = heap.writeU8(left);
      const bPtr = heap.writeU8(right);
      const outPtr = heap.alloc(maskByte, 8);
      module.og_bitmap_op(BITMAP_CODE[op], aPtr, bPtr, n, outPtr);
      return trimTail(heap.readU8(outPtr, maskByte), n);
    });
  }

  function topK(
    column: AccelColumn,
    k: number,
    topOption: AccelTopKOption = {},
  ): Int32Array {
    const n = column.value.length;
    const want = Math.max(0, Math.min(k | 0, n));
    if (want === 0) return new Int32Array(0);
    return heap.scope(() => {
      const valuePtr = heap.writeF64(column.value.subarray(0, n));
      const presencePtr = heap.writeU8(presenceBitmap(column.value, column.validity, n));
      const outPtr = heap.alloc(want * 4, 8);
      const scratchPtr = heap.alloc(want * 4, 8);
      const written = module.og_top_k(
        valuePtr,
        presencePtr,
        n,
        want,
        topOption.descending === true ? 1 : 0,
        topOption.missingFirst === true ? 1 : 0,
        outPtr,
        scratchPtr,
      );
      return heap.readI32(outPtr, Math.max(0, Math.min(written, want)));
    });
  }

  return {
    heap,
    name: option.name ?? 'wasm',
    capability,
    sortIndex,
    filterMask,
    groupKey,
    aggregate,
    bitmapOp,
    topK,
    dispose: () => {
      // Release the whole arena. The module's linear memory itself cannot be
      // shrunk — WebAssembly has no `shrink` — so the honest thing to do is
      // reset the bump pointer and let the pages be reused.
      heap.release(0);
    },
  };
}

