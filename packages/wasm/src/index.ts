// =============================================================================
// @onegrid/wasm
//
// The hot-path acceleration seam. One interface — `AccelBackend` — with two
// implementations behind it, and a proof that they compute the same function.
//
// -----------------------------------------------------------------------------
// Why a seam and not a rewrite
// -----------------------------------------------------------------------------
//
// The tempting version of "make it faster with Rust" is to port `@onegrid/data`
// wholesale. That fails for a reason that has nothing to do with Rust: the
// moment two implementations of a comparator exist, they drift, and a grid
// that sorts differently depending on whether the browser loaded a .wasm is
// worse than a grid that is uniformly slower. So this package inverts the
// usual arrangement. The JavaScript implementation is the SPECIFICATION, it
// delegates to `@onegrid/data` rather than forking it, and the accelerated
// implementation is only allowed to exist as long as it can be shown identical
// to it — see `assertBackendEquivalent`.
//
// -----------------------------------------------------------------------------
// Six operations
// -----------------------------------------------------------------------------
//
// `sortIndex`, `filterMask`, `groupKey`, `aggregate`, `bitmapOp`, `topK`. These
// are not a general-purpose kernel library; they are the six functions that
// dominate `@onegrid/data` on a large grid. Every one of them takes typed
// arrays and returns typed arrays — permutations, bitmasks, dense codes — so
// the cost of crossing into WebAssembly is proportional to the columns
// involved and never to the object graph the grid happens to hold.
//
// -----------------------------------------------------------------------------
// What ships, and what does not
// -----------------------------------------------------------------------------
//
// `crate/` contains a real Rust kernel implementing the ABI in `abi.ts` with
// `#[no_mangle] extern "C"` exports over raw pointers, no wasm-bindgen, and no
// allocator (JavaScript owns the heap — see `WasmHeap`). No `.wasm` binary is
// committed and nothing in this package's build or test needs a Rust
// toolchain: `createFakeAccelModule` is a from-scratch JavaScript kernel over
// a real `WebAssembly.Memory`, which exercises the pointer marshalling, the
// bump allocator, and the memory-growth path without one. `build.md` covers
// compiling the real thing.
// =============================================================================

/** @public */
export type {
  AccelAggregateOp,
  AccelBackend,
  AccelBitmapOp,
  AccelCapability,
  AccelColumn,
  AccelGroupCode,
  AccelPredicate,
  AccelPredicateOp,
  AccelSortKey,
  AccelTopKOption,
} from './types';

/** @public */
export { createJsBackend } from './js-backend';

/** @public */
export { createWasmBackend, AccelAbiError } from './wasm-backend';
/** @public */
export type { WasmAccelBackend, WasmBackendOption } from './wasm-backend';

/** @public */
export { ACCEL_ABI_VERSION, AGGREGATE_CODE, BITMAP_CODE, PREDICATE_CODE, hashCapacityFor } from './abi';
/** @public */
export type { AccelModule } from './abi';

/** @public */
export { WasmHeap, AccelMemoryError, WASM_PAGE_BYTE, isDetached } from './memory';
/** @public */
export type { AccelMemory } from './memory';

/** @public */
export { detectCapability, PROBE_BASELINE, PROBE_SIMD, PROBE_THREAD } from './detect';
/** @public */
export type { AccelHost } from './detect';

/** @public */
export { selectBackend } from './select';
/** @public */
export type { BackendSelection, SelectBackendOption } from './select';

/** @public */
export { createFakeAccelModule } from './fake-module';
/** @public */
export type { FakeModuleOption } from './fake-module';

/** @public */
export { assertBackendEquivalent, runCase, edgeCase, AccelDivergenceError } from './differential';
/** @public */
export type { AccelCase, AccelResult } from './differential';

/** @public */
export { benchBackend, compareBackend } from './bench';
/** @public */
export type { BenchComparison, BenchOption, BenchResult } from './bench';

/** @public */
export { byteLengthFor, presenceBitmap, trimTail } from './bit';
