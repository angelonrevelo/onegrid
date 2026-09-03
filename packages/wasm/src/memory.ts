// =============================================================================
// WasmHeap — a JS-side bump allocator over a module's linear memory
//
// The Rust kernel in `crate/` has no allocator. That is a feature: an
// allocator inside the module means a second heap, a second fragmentation
// story, and a `malloc` symbol we would have to keep ABI-compatible forever.
// Instead the module exports where its static data ends (`og_heap_base`) and
// JavaScript owns everything above it.
//
// Bump allocation fits the call pattern exactly. A single accelerated
// operation allocates its inputs, its scratch, and its output, runs, copies
// the output out, and releases everything. There is no long-lived object and
// no interleaved lifetime, so the O(1) "reset the pointer" free is not a
// simplification — it is the correct algorithm. `free` is still explicit and
// still checked, because a leak inside one operation would grow the memory
// unboundedly across calls.
//
// -----------------------------------------------------------------------------
// The detached-ArrayBuffer trap
// -----------------------------------------------------------------------------
//
// `WebAssembly.Memory.prototype.grow` REPLACES the underlying ArrayBuffer.
// Every TypedArray view created before the grow is instantly detached:
// `byteLength` becomes 0, reads return undefined, writes are silently
// discarded. The classic bug is
//
//     const view = new Float64Array(memory.buffer, ptr, n);
//     const out  = heap.alloc(bigNumber);   // <- grows the memory
//     view.set(data);                        // <- writes into nothing
//
// and it is silent, intermittent, and only reproduces once a dataset crosses
// a page boundary. The defence here is structural rather than disciplinary:
// this class never stores a view. Every accessor re-derives one from
// `memory.buffer` at the moment of use, and `generation` increments on each
// grow so callers that do cache a view can assert it is still current.
// =============================================================================

/** One WebAssembly page. Memory grows in whole pages, never in bytes. */
export const WASM_PAGE_BYTE = 65536;

/**
 * The part of `WebAssembly.Memory` this allocator needs. Declared structurally
 * so tests can drive it with a fake and so a module compiled with a shared
 * memory (SharedArrayBuffer-backed) satisfies it unchanged.
 */
export interface AccelMemory {
  readonly buffer: ArrayBufferLike;
  grow(delta: number): number;
}

/** Raised for every allocator failure, so callers can distinguish OOM from a kernel bug. */
export class AccelMemoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AccelMemoryError';
  }
}

interface Allocation {
  readonly start: number;
  readonly end: number;
  freed: boolean;
}

export class WasmHeap {
  private readonly memory: AccelMemory;
  private readonly base: number;
  private top: number;
  private readonly live: Allocation[] = [];
  private lastBuffer: ArrayBufferLike;
  private growth = 0;

  constructor(memory: AccelMemory, heapBase: number) {
    this.memory = memory;
    this.base = align(Math.max(0, heapBase), 8);
    this.top = this.base;
    this.lastBuffer = memory.buffer;
  }

  /**
   * Increments every time the underlying buffer is replaced. A caller holding
   * a cached view can compare against the generation it captured; a mismatch
   * means the view is detached and must be re-derived.
   */
  get generation(): number {
    // Detect a grow performed by anyone — the module itself may have grown
    // memory during a call — not just the ones this allocator triggered.
    if (this.memory.buffer !== this.lastBuffer) {
      this.lastBuffer = this.memory.buffer;
      this.growth += 1;
    }
    return this.growth;
  }

  /** Current capacity in bytes. Re-read every time; it changes under us. */
  get byteLength(): number {
    return this.memory.buffer.byteLength;
  }

  /** Bytes handed out and not yet freed. Zero between operations, or we leak. */
  get usedByte(): number {
    return this.top - this.base;
  }

  /**
   * Reserve `byteLength` bytes, growing linear memory if needed. Returns a
   * byte offset into the memory — deliberately a number and not a view,
   * because a view returned here would be exactly the thing that goes stale.
   */
  alloc(byteLength: number, alignment = 8): number {
    if (!Number.isFinite(byteLength) || byteLength < 0) {
      throw new AccelMemoryError(`WasmHeap.alloc: invalid size ${byteLength}.`);
    }
    const start = align(this.top, alignment);
    const end = start + Math.ceil(byteLength);
    this.ensure(end);
    this.top = end;
    this.live.push({ start, end, freed: false });
    return start;
  }

  /**
   * Release a pointer. Bump allocators reclaim in LIFO order, so freeing a
   * pointer that is not the newest marks it dead and reclaims lazily once the
   * allocations above it are gone. Double-free and unknown-pointer are hard
   * errors rather than silent no-ops: both mean the calling kernel binding is
   * wrong, and a silent allocator is how a leak survives to production.
   */
  free(pointer: number): void {
    for (let i = this.live.length - 1; i >= 0; i--) {
      const entry = this.live[i]!;
      if (entry.start !== pointer) continue;
      if (entry.freed) {
        throw new AccelMemoryError(`WasmHeap.free: double free at ${pointer}.`);
      }
      entry.freed = true;
      while (this.live.length > 0 && this.live[this.live.length - 1]!.freed) {
        this.top = this.live.pop()!.start;
      }
      return;
    }
    throw new AccelMemoryError(`WasmHeap.free: ${pointer} is not a live allocation.`);
  }

  /** Capture the current bump position for `release`. */
  mark(): number {
    return this.top;
  }

  /** Drop every allocation made since `mark`. The O(1) escape hatch. */
  release(mark: number): void {
    while (this.live.length > 0 && this.live[this.live.length - 1]!.start >= mark) {
      this.live.pop();
    }
    this.top = Math.max(this.base, mark);
  }

  /**
   * Run `body` inside an allocation scope. Everything allocated inside is
   * released on the way out, including when `body` throws — which is what
   * keeps a kernel that traps from leaking the whole heap.
   */
  scope<T>(body: (heap: WasmHeap) => T): T {
    const mark = this.mark();
    try {
      return body(this);
    } finally {
      this.release(mark);
    }
  }

  // ---------------------------------------------------------------------------
  // Views. Every one of these is created fresh against the CURRENT buffer.
  // Never store the result across a call that can allocate.
  // ---------------------------------------------------------------------------

  u8(pointer: number, length: number): Uint8Array {
    this.check(pointer, length, 1);
    return new Uint8Array(this.memory.buffer, pointer, length);
  }

  i32(pointer: number, length: number): Int32Array {
    this.check(pointer, length, 4);
    return new Int32Array(this.memory.buffer, pointer, length);
  }

  f64(pointer: number, length: number): Float64Array {
    this.check(pointer, length, 8);
    return new Float64Array(this.memory.buffer, pointer, length);
  }

  /** Allocate and copy in one step. Returns the pointer, never a view. */
  writeF64(source: Float64Array): number {
    const pointer = this.alloc(source.length * 8, 8);
    // Deliberately AFTER alloc: alloc may have grown memory and detached any
    // view taken before it.
    this.f64(pointer, source.length).set(source);
    return pointer;
  }

  writeU8(source: Uint8Array): number {
    const pointer = this.alloc(source.length, 8);
    this.u8(pointer, source.length).set(source);
    return pointer;
  }

  writeI32(source: Int32Array): number {
    const pointer = this.alloc(source.length * 4, 8);
    this.i32(pointer, source.length).set(source);
    return pointer;
  }

  /** Copy out of linear memory into a JS-owned array. */
  readI32(pointer: number, length: number): Int32Array {
    return Int32Array.from(this.i32(pointer, length));
  }

  readU8(pointer: number, length: number): Uint8Array {
    return Uint8Array.from(this.u8(pointer, length));
  }

  readF64(pointer: number, length: number): Float64Array {
    return Float64Array.from(this.f64(pointer, length));
  }

  // ---------------------------------------------------------------------------

  private ensure(end: number): void {
    const have = this.memory.buffer.byteLength;
    if (end <= have) return;
    const page = Math.ceil((end - have) / WASM_PAGE_BYTE);
    try {
      this.memory.grow(page);
    } catch {
      throw new AccelMemoryError(
        `WasmHeap: cannot grow linear memory by ${page} page(s) to reach ${end} bytes.`,
      );
    }
    if (this.memory.buffer.byteLength < end) {
      throw new AccelMemoryError(
        `WasmHeap: grow(${page}) left only ${this.memory.buffer.byteLength} bytes, needed ${end}.`,
      );
    }
    // Refresh the generation bookkeeping immediately so a caller that checks
    // it right after an alloc sees the bump.
    void this.generation;
  }

  private check(pointer: number, length: number, size: number): void {
    if (pointer % size !== 0) {
      throw new AccelMemoryError(`WasmHeap: pointer ${pointer} is not ${size}-byte aligned.`);
    }
    if (pointer < 0 || pointer + length * size > this.memory.buffer.byteLength) {
      throw new AccelMemoryError(
        `WasmHeap: [${pointer}, ${pointer + length * size}) is outside linear memory of ${this.memory.buffer.byteLength} bytes.`,
      );
    }
  }
}

function align(value: number, alignment: number): number {
  const a = Math.max(1, alignment);
  return Math.ceil(value / a) * a;
}

/**
 * True when a typed array has been detached by a memory grow. Detached views
 * report a zero byteLength while still having a non-zero `length` recorded at
 * construction in some engines, so both are checked.
 */
export function isDetached(view: ArrayBufferView): boolean {
  return view.byteLength === 0 && view.buffer.byteLength === 0;
}
