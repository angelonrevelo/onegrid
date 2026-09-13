// =============================================================================
// The same randomized equivalence, on the REAL compiled kernel.
//
// Opt-in: set OG_ACCEL_WASM to an index-accel artifact. CI has no Rust
// toolchain, so without it this file skips rather than failing the suite.
// =============================================================================

import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createWasmBackend } from '@onegrid/wasm';
import type { AccelModule } from '@onegrid/wasm';
import { createDataWorkerHandler } from '../handler.js';
import { assertAccelEquivalent } from './accel-case.js';

const ARTIFACT = process.env.OG_ACCEL_WASM;
const HAVE_ARTIFACT = ARTIFACT !== undefined && existsSync(ARTIFACT);

describe.skipIf(!HAVE_ARTIFACT)('accelerated dispatch on the real kernel', () => {
  it('agrees with @onegrid/data on 600 randomized tables', () => {
    const module = new WebAssembly.Instance(new WebAssembly.Module(readFileSync(ARTIFACT!)), {})
      .exports as unknown as AccelModule;
    const backend = createWasmBackend(module);
    const hit = assertAccelEquivalent(backend, 0xacce1, 600);
    expect(hit.sortIndex + hit.filterMask + hit.groupKey + hit.aggregate).toBeGreaterThan(300);
    expect(backend.heap.usedByte).toBe(0);
  });

  it('configureAccel binds the artifact bytes inside the handler', async () => {
    const handler = createDataWorkerHandler();
    expect(handler.accelStatus().backend).toBe('js');
    const status = await handler.configureAccel({ byte: readFileSync(ARTIFACT!) });
    expect(status.backend).not.toBe('js');
    expect(status.reason).toMatch(/bound kernel module/);
  });
});
