// =============================================================================
// WasmHeap — bump allocation and the detached-buffer guard.
//
// These run against a genuine `WebAssembly.Memory`, not a stub. A stub can be
// written to detach views on grow, but only the real thing detaches them for
// the real reason, and the bug being guarded against is one that only ever
// shows up against the real thing.
// =============================================================================

import { describe, expect, it } from 'vitest';
import { AccelMemoryError, WASM_PAGE_BYTE, WasmHeap, isDetached } from '../memory';

function heapOf(initialPage = 1, maximumPage = 8): WasmHeap {
  const memory = new WebAssembly.Memory({ initial: initialPage, maximum: maximumPage });
  return new WasmHeap(memory, 1024);
}

describe('WasmHeap — allocation', () => {
  it('hands out aligned, non-overlapping pointers above the heap base', () => {
    const heap = heapOf();
    const a = heap.alloc(10, 8);
    const b = heap.alloc(10, 8);
    expect(a).toBeGreaterThanOrEqual(1024);
    expect(a % 8).toBe(0);
    expect(b % 8).toBe(0);
    expect(b).toBeGreaterThanOrEqual(a + 10);
  });

  it('reclaims in LIFO order and reports usage back to zero', () => {
    const heap = heapOf();
    const a = heap.alloc(64);
    const b = heap.alloc(64);
    heap.free(b);
    heap.free(a);
    expect(heap.usedByte).toBe(0);
  });

  it('defers reclamation when a pointer is freed out of order', () => {
    const heap = heapOf();
    const a = heap.alloc(64);
    const b = heap.alloc(64);
    heap.free(a);
    expect(heap.usedByte).toBeGreaterThan(0);
    heap.free(b);
    expect(heap.usedByte).toBe(0);
  });

  it('rejects a double free and an unknown pointer', () => {
    const heap = heapOf();
    const a = heap.alloc(8);
    heap.free(a);
    expect(() => heap.free(a)).toThrow(AccelMemoryError);
    expect(() => heap.free(999_999)).toThrow(AccelMemoryError);
  });

  it('releases everything allocated inside a scope, including when it throws', () => {
    const heap = heapOf();
    expect(() =>
      heap.scope((h) => {
        h.alloc(4096);
        throw new Error('kernel trapped');
      }),
    ).toThrow('kernel trapped');
    expect(heap.usedByte).toBe(0);
  });

  it('refuses a negative or non-finite size', () => {
    const heap = heapOf();
    expect(() => heap.alloc(-1)).toThrow(AccelMemoryError);
    expect(() => heap.alloc(Number.NaN)).toThrow(AccelMemoryError);
  });

  it('refuses a view that runs past the end of linear memory', () => {
    const heap = heapOf();
    expect(() => heap.i32(heap.byteLength - 4, 100)).toThrow(AccelMemoryError);
  });

  it('refuses a misaligned view', () => {
    const heap = heapOf();
    expect(() => heap.f64(1025, 1)).toThrow(AccelMemoryError);
  });
});

describe('WasmHeap — memory growth and detached buffers', () => {
  it('grows linear memory to satisfy an allocation larger than one page', () => {
    const heap = heapOf(1, 8);
    expect(heap.byteLength).toBe(WASM_PAGE_BYTE);
    const before = heap.generation;
    heap.alloc(WASM_PAGE_BYTE * 3);
    expect(heap.byteLength).toBeGreaterThanOrEqual(WASM_PAGE_BYTE * 3);
    expect(heap.generation).toBeGreaterThan(before);
  });

  it('detaches views taken before a grow — the bug this class exists to prevent', () => {
    const heap = heapOf(1, 8);
    const pointer = heap.alloc(64);
    const stale = heap.i32(pointer, 16);
    stale[0] = 7;
    expect(isDetached(stale)).toBe(false);

    heap.alloc(WASM_PAGE_BYTE * 2);

    // The view is now pointing at a buffer that no longer exists. This is the
    // silent failure: no throw, no warning, writes simply evaporate.
    expect(isDetached(stale)).toBe(true);
    expect(stale[0]).toBeUndefined();
  });

  it('re-acquires a live view after a grow, with the old contents intact', () => {
    const heap = heapOf(1, 8);
    const pointer = heap.alloc(64);
    heap.i32(pointer, 16).set([1, 2, 3, 4], 0);
    heap.alloc(WASM_PAGE_BYTE * 2);
    const fresh = heap.i32(pointer, 16);
    expect(isDetached(fresh)).toBe(false);
    // WebAssembly.Memory.grow copies the existing contents into the new
    // buffer, so a write made BEFORE the grow survives; only the stale VIEW is
    // dead.
    expect(Array.from(fresh.subarray(0, 4))).toEqual([1, 2, 3, 4]);
  });

  it('writeF64 copies correctly even when its own allocation triggered a grow', () => {
    const heap = heapOf(1, 8);
    const big = new Float64Array(WASM_PAGE_BYTE / 4);
    for (let i = 0; i < big.length; i++) big[i] = i * 1.5;
    const pointer = heap.writeF64(big);
    const readBack = heap.readF64(pointer, big.length);
    expect(readBack[0]).toBe(0);
    expect(readBack[big.length - 1]).toBe((big.length - 1) * 1.5);
  });

  it('survives repeated grows across several allocations', () => {
    const heap = heapOf(1, 16);
    const pointer: number[] = [];
    for (let i = 0; i < 6; i++) {
      const source = Int32Array.from({ length: 4096 }, (_, j) => i * 10000 + j);
      pointer.push(heap.writeI32(source));
    }
    expect(heap.generation).toBeGreaterThan(0);
    for (let i = 0; i < pointer.length; i++) {
      const back = heap.readI32(pointer[i]!, 4096);
      expect(back[0]).toBe(i * 10000);
      expect(back[4095]).toBe(i * 10000 + 4095);
    }
  });

  it('reports OOM as an AccelMemoryError rather than a raw RangeError', () => {
    const heap = heapOf(1, 2);
    expect(() => heap.alloc(WASM_PAGE_BYTE * 100)).toThrow(AccelMemoryError);
  });

  it('notices a grow performed by someone other than the allocator', () => {
    const memory = new WebAssembly.Memory({ initial: 1, maximum: 8 });
    const heap = new WasmHeap(memory, 0);
    const before = heap.generation;
    memory.grow(1);
    expect(heap.generation).toBe(before + 1);
  });
});
