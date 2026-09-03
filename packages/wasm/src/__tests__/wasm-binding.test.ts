// =============================================================================
// The WASM binding, driven by a hand-written kernel over real linear memory.
//
// Two distinct things are under test here and they are worth separating:
//
//   1. MARSHALLING. Do pointers, lengths, alignments and bit offsets survive
//      the round trip? A kernel that is perfectly correct is still useless if
//      the binding hands it a mask one byte too short.
//   2. EQUIVALENCE. Does the kernel compute the same function as the reference
//      backend? That is `assertBackendEquivalent` over the hand-written edge
//      case list — NaN, -0, validity holes, empty and single-element inputs.
//
// The kernel here is JavaScript, so this proves nothing about the Rust. What
// it does prove is that the ABI, the allocator and the harness are all sound,
// which is the part that has to be right before compiling anything is worth
// doing.
// =============================================================================

import { describe, expect, it } from 'vitest';
import { createJsBackend } from '../js-backend';
import { createWasmBackend, AccelAbiError } from '../wasm-backend';
import { createFakeAccelModule } from '../fake-module';
import { ACCEL_ABI_VERSION } from '../abi';
import type { AccelModule } from '../abi';
import { assertBackendEquivalent, edgeCase, runCase } from '../differential';
import { WASM_PAGE_BYTE } from '../memory';

const reference = createJsBackend();
const accelerated = createWasmBackend(createFakeAccelModule());

describe('createWasmBackend — binding contract', () => {
  it('rejects a module with no linear memory', () => {
    const broken = { ...createFakeAccelModule(), memory: undefined } as unknown as AccelModule;
    expect(() => createWasmBackend(broken)).toThrow(AccelAbiError);
  });

  it('rejects a module missing a required export', () => {
    const broken = { ...createFakeAccelModule(), og_top_k: undefined } as unknown as AccelModule;
    expect(() => createWasmBackend(broken)).toThrow(/og_top_k/);
  });

  it('rejects a module speaking a different ABI version', () => {
    const stale: AccelModule = {
      ...createFakeAccelModule(),
      og_abi_version: () => ACCEL_ABI_VERSION + 7,
    };
    expect(() => createWasmBackend(stale)).toThrow(/ABI version/);
  });

  it('reports the capability and name it was given', () => {
    const backend = createWasmBackend(createFakeAccelModule(), {
      name: 'wasm-simd',
      capability: { wasm: true, simd: true, thread: false },
    });
    expect(backend.name).toBe('wasm-simd');
    expect(backend.capability.simd).toBe(true);
  });
});

describe('createWasmBackend — allocator discipline', () => {
  it('returns the heap to zero usage after every operation', () => {
    const backend = createWasmBackend(createFakeAccelModule());
    const column = { value: Float64Array.from([3, 1, 2]) };
    backend.sortIndex([column], 3);
    backend.filterMask(column, { op: 'gt', operand: 1 });
    backend.groupKey([column], 3);
    backend.aggregate('sum', column, null);
    backend.bitmapOp('and', Uint8Array.from([0xff]), Uint8Array.from([0x0f]), 8);
    backend.topK(column, 2);
    expect(backend.heap.usedByte).toBe(0);
  });

  it('grows linear memory for a payload larger than the initial page and still agrees with JS', () => {
    const backend = createWasmBackend(createFakeAccelModule({ initialPage: 1 }));
    const length = WASM_PAGE_BYTE / 4;
    const value = new Float64Array(length);
    for (let i = 0; i < length; i++) value[i] = (i * 2654435761) % 1000;
    const column = { value };

    const before = backend.heap.generation;
    const permutation = backend.sortIndex([column], length);
    expect(backend.heap.generation).toBeGreaterThan(before);
    expect(Array.from(permutation)).toEqual(
      Array.from(reference.sortIndex([column], length)),
    );
    expect(backend.heap.usedByte).toBe(0);
  });

  it('resets the arena on dispose', () => {
    const backend = createWasmBackend(createFakeAccelModule());
    backend.sortIndex([{ value: Float64Array.from([1, 2]) }], 2);
    backend.dispose();
    expect(backend.heap.usedByte).toBe(0);
  });
});

describe('createWasmBackend — marshalling round trips', () => {
  it('preserves a mask whose length is not a byte multiple', () => {
    const value = Float64Array.from([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
    const mask = accelerated.filterMask({ value }, { op: 'isNotNull' });
    expect(mask.length).toBe(2);
    expect(mask[0]).toBe(0xff);
    expect(mask[1]).toBe(0b111);
  });

  it('composes a multi-key sort out of single-key kernel passes', () => {
    const key = [
      { value: Float64Array.from([1, 1, 0, 1, 0]) },
      { value: Float64Array.from([7, 2, 9, 5, 3]), descending: true },
    ];
    expect(Array.from(accelerated.sortIndex(key, 5))).toEqual(
      Array.from(reference.sortIndex(key, 5)),
    );
  });

  it('carries an index subset across the boundary for aggregate', () => {
    const column = { value: Float64Array.from([10, 20, 30, 40]) };
    const index = Int32Array.from([3, 1]);
    expect(accelerated.aggregate('first', column, index)).toBe(40);
    expect(accelerated.aggregate('sum', column, index)).toBe(60);
  });

  it('returns a copy, never a view into linear memory', () => {
    const column = { value: Float64Array.from([5, 4, 3, 2, 1]) };
    const first = accelerated.sortIndex([column], 5);
    // A subsequent call reuses the same arena bytes. If the first result were
    // a view, this would silently rewrite it.
    accelerated.sortIndex([{ value: Float64Array.from([9, 8, 7, 6, 5]) }], 5);
    expect(Array.from(first)).toEqual([4, 3, 2, 1, 0]);
  });
});

describe('differential — kernel against the reference', () => {
  const list = edgeCase();

  it('covers a meaningful number of hand-written edge cases', () => {
    expect(list.length).toBeGreaterThan(100);
  });

  for (const testCase of list) {
    it(`agrees on: ${testCase.name}`, () => {
      expect(() => assertBackendEquivalent(reference, accelerated, testCase)).not.toThrow();
    });
  }
});

describe('assertBackendEquivalent — the harness itself', () => {
  it('detects a divergence rather than passing everything', () => {
    const wrong = {
      ...reference,
      name: 'sabotaged',
      topK: (column: { value: Float64Array }, k: number) =>
        reference.topK(column, k).reverse(),
    };
    const testCase = edgeCase().find((c) => c.kind === 'topK' && c.k === 3);
    expect(testCase).toBeDefined();
    expect(() => assertBackendEquivalent(reference, wrong, testCase!)).toThrow(
      /divergence/,
    );
  });

  it('distinguishes -0 from 0 in a scalar result', () => {
    const negative = { ...reference, name: 'negative-zero', aggregate: () => -0 };
    const positive = { ...reference, name: 'positive-zero', aggregate: () => 0 };
    expect(() =>
      assertBackendEquivalent(negative, positive, {
        kind: 'aggregate',
        name: 'signed zero',
        op: 'sum',
        column: { value: Float64Array.from([0]) },
        index: null,
      }),
    ).toThrow(/-0 vs 0/);
  });

  it('runs a case against a single backend for callers that only want the result', () => {
    const result = runCase(reference, {
      kind: 'aggregate',
      name: 'sum',
      op: 'sum',
      column: { value: Float64Array.from([1, 2, 3]) },
      index: null,
    });
    expect(result).toBe(6);
  });
});
