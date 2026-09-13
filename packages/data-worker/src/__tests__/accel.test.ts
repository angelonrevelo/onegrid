import { describe, expect, it } from 'vitest';
import { createColumnTable, sortIndex } from '@onegrid/data';
import { createFakeAccelModule, createWasmBackend } from '@onegrid/wasm';
import { accelFilterIndex, accelSortIndex } from '../accel.js';
import { createDataWorkerHandler } from '../handler.js';
import { assertAccelEquivalent, counted } from './accel-case.js';

// The fake module is a JavaScript kernel over real WebAssembly.Memory, so this
// exercises the pointer marshalling and the eligibility rules without a Rust
// toolchain. The real kernel runs the same cases in accel.real-module.test.ts.
const backend = createWasmBackend(createFakeAccelModule());

describe('accelerated dispatch ≡ @onegrid/data', () => {
  it('sort, filter, group and aggregate agree on 600 randomized tables', () => {
    const hit = assertAccelEquivalent(backend, 0x5eed, 600);
    // Proof the kernel path was taken, not just the fallback.
    expect(hit.sortIndex).toBeGreaterThan(50);
    expect(hit.filterMask).toBeGreaterThan(100);
    expect(hit.groupKey).toBeGreaterThan(50);
    expect(hit.aggregate).toBeGreaterThan(50);
  });

  it('leaves the kernel heap empty after every call', () => {
    assertAccelEquivalent(backend, 0xbeef, 50);
    expect(backend.heap.usedByte).toBe(0);
  });
});

describe('eligibility', () => {
  const table = createColumnTable([
    { schema: { id: 'n', type: 'float64' }, data: new Float64Array([3, 1, 2]) },
    { schema: { id: 'nan', type: 'float64' }, data: new Float64Array([1, Number.NaN, 0]) },
    { schema: { id: 'u', type: 'utf8' }, data: [10, 9, 100] },
  ]);

  it('a NaN cell keeps the column off the kernel', () => {
    const { backend: spy, hit } = counted(backend);
    const sort = [{ columnId: 'nan', direction: 'asc' as const }];
    expect(Array.from(accelSortIndex(spy, table, sort))).toEqual(Array.from(sortIndex(table, sort)));
    expect(hit.sortIndex).toBe(0);
  });

  it('a utf8 schema sorts by collation even when the cells are numbers', () => {
    const { backend: spy, hit } = counted(backend);
    const sort = [{ columnId: 'u', direction: 'asc' as const }];
    expect(Array.from(accelSortIndex(spy, table, sort))).toEqual(Array.from(sortIndex(table, sort)));
    expect(hit.sortIndex).toBe(0);
  });

  it('a string operand keeps the leaf on @onegrid/data; a numeric one does not', () => {
    const { backend: spy, hit } = counted(backend);
    accelFilterIndex(spy, table, { type: 'comparison', columnId: 'n', op: 'gt', value: '1' });
    expect(hit.filterMask).toBe(0);
    accelFilterIndex(spy, table, { type: 'comparison', columnId: 'n', op: 'gt', value: 1 });
    expect(hit.filterMask).toBe(1);
  });
});

describe('createDataWorkerHandler', () => {
  it('binds a supplied kernel and reports it', () => {
    const handler = createDataWorkerHandler({ module: createFakeAccelModule() });
    expect(handler.accelStatus().backend).not.toBe('js');
  });

  it('without a kernel it runs @onegrid/data and says why', () => {
    const handler = createDataWorkerHandler();
    const status = handler.accelStatus();
    expect(status.backend).toBe('js');
    expect(status.reason).toMatch(/no kernel/);
  });

  it('a corrupt kernel does not demote the current backend', async () => {
    const handler = createDataWorkerHandler({ module: createFakeAccelModule() });
    const before = handler.accelStatus().backend;
    const status = await handler.configureAccel({ byte: new Uint8Array([0, 1, 2, 3]) });
    expect(status.backend).toBe(before);
    expect(status.reason).toMatch(/failed to instantiate/);
  });

  it('jobs through the handler equal @onegrid/data', () => {
    const handler = createDataWorkerHandler({ module: createFakeAccelModule() });
    const table = createColumnTable([
      { schema: { id: 'n', type: 'int32' }, data: new Int32Array([5, 3, 9, 3, 1]) },
    ]);
    const sort = [{ columnId: 'n', direction: 'desc' as const }];
    expect(Array.from(handler.sort({ table, sort }))).toEqual(Array.from(sortIndex(table, sort)));
    expect(handler.aggregate({ table, aggregation: { columnId: 'n', fn: 'sum' } })).toBe(21);
    expect(handler.aggregate({ table, aggregation: { columnId: 'n', fn: 'max' }, rowIndex: [1, 3, 4] })).toBe(3);
  });
});
