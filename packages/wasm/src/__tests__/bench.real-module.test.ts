// =============================================================================
// JS reference vs the real compiled kernel, at grid scale.
//
// docs/adoption.md in the `index` repo says of this module: "proven correct by
// their harness, not yet proven faster — do not merge on a speed claim that has
// not been measured." This is that measurement, through the SAME binding the
// grid would use (createWasmBackend: alloc, copy in, call, copy out), so the
// marshalling cost is inside the number rather than flattered out of it.
//
// Opt-in: set OG_ACCEL_WASM to the artifact. Correctness is asserted once per
// case at full size before anything is timed; speed is reported, not asserted,
// because a CI box's timings are not a contract.
// =============================================================================

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { AccelModule } from '../abi';
import { compareBackend } from '../bench';
import { byteLengthFor } from '../bit';
import { assertBackendEquivalent, type AccelCase } from '../differential';
import { createJsBackend } from '../js-backend';
import { createWasmBackend } from '../wasm-backend';

const ARTIFACT = process.env.OG_ACCEL_WASM;
const N = Number(process.env.OG_ACCEL_BENCH_ROW ?? 1_000_000);

function load(path: string, name: string) {
  const instance = new WebAssembly.Instance(new WebAssembly.Module(readFileSync(path)), {});
  return createWasmBackend(instance.exports as unknown as AccelModule, { name });
}

function column(seed: number, cardinality: number): { value: Float64Array; validity: Uint8Array } {
  let s = seed >>> 0 || 1;
  const rand = () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return s >>> 0;
  };
  const value = new Float64Array(N);
  const validity = new Uint8Array(byteLengthFor(N));
  for (let i = 0; i < N; i++) {
    value[i] = (rand() % cardinality) - cardinality / 2;
    if (rand() % 16 !== 0) validity[i >>> 3]! |= 1 << (i & 7);
  }
  return { value, validity };
}

describe.skipIf(!ARTIFACT)(`real kernel vs JS reference at ${N.toLocaleString()} rows`, () => {
  it('reports min-of-N speedup per kernel, after proving equivalence at full size', () => {
    const reference = createJsBackend();
    const candidate = [load(ARTIFACT!, 'wasm')];
    const simd = process.env.OG_ACCEL_WASM_SIMD;
    if (simd) candidate.push(load(simd, 'wasm-simd'));

    const wide = column(0x9e3779b9, 1_000_000);
    const narrow = column(0x85ebca6b, 64);
    const a = new Uint8Array(byteLengthFor(N)).map((_, i) => (i * 2654435761) >>> 24);
    const b = new Uint8Array(byteLengthFor(N)).map((_, i) => (i * 40503) >>> 8);
    const index = Int32Array.from({ length: N >>> 2 }, (_, i) => i * 4);

    const testCase: AccelCase[] = [
      { kind: 'filterMask', name: 'filterMask gt', column: wide, predicate: { op: 'gt', operand: 0 } },
      {
        kind: 'filterMask',
        name: 'filterMask in(8)',
        column: narrow,
        predicate: { op: 'in', set: Float64Array.from([1, 3, 5, 7, -2, -4, -6, -8]) },
      },
      { kind: 'aggregate', name: 'aggregate sum', column: wide, op: 'sum', index: null },
      { kind: 'aggregate', name: 'aggregate countDistinct', column: narrow, op: 'countDistinct', index: null },
      { kind: 'aggregate', name: 'aggregate avg (25% subset)', column: wide, op: 'avg', index },
      { kind: 'groupKey', name: 'groupKey 64-card', key: [narrow], length: N },
      { kind: 'topK', name: 'topK 100', column: wide, k: 100, option: { descending: true } },
      { kind: 'bitmapOp', name: 'bitmapOp and', op: 'and', a, b, bitLength: N },
      { kind: 'sortIndex', name: 'sortIndex 1 key', key: [wide], length: N },
      { kind: 'sortIndex', name: 'sortIndex 2 key', key: [narrow, wide], length: N },
    ];

    const line: string[] = [];
    line.push(
      `${'case'.padEnd(28)}${'js ms'.padStart(10)}` +
        candidate.map((c) => `${(c.name + ' ms').padStart(14)}${'×'.padStart(8)}`).join(''),
    );
    for (const current of testCase) {
      const iteration = current.kind === 'sortIndex' ? 3 : 10;
      let row = '';
      let jsMs = 0;
      for (const backend of candidate) {
        assertBackendEquivalent(reference, backend, current);
        const cmp = compareBackend(reference, backend, current, { iteration, warmup: 2 });
        jsMs = cmp.baseline.minMs;
        row += `${cmp.candidate.minMs.toFixed(2).padStart(14)}${cmp.speedup.toFixed(2).padStart(8)}`;
        expect(backend.heap.usedByte).toBe(0);
      }
      line.push(`${current.name.padEnd(28)}${jsMs.toFixed(2).padStart(10)}${row}`);
    }
    console.log(`\n[bench] accel at ${N.toLocaleString()} rows (min of N)\n${line.join('\n')}`);
  }, 600_000);
});
