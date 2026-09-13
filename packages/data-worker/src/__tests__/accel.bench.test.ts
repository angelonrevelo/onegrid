// =============================================================================
// Worker jobs at grid scale: @onegrid/data vs accelerated dispatch.
//
// Opt-in (OG_ACCEL_BENCH=1). Uses the real kernel when OG_ACCEL_WASM points at
// one, otherwise the fake JS kernel — and says which, because a fake-kernel
// number is a marshalling measurement, not a speed claim. Every timed result is
// checked against @onegrid/data first, so a fast wrong answer fails the run.
// "cold" includes the one-time column conversion; "warm" reuses it.
// =============================================================================

import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { aggregate, createColumnTable, filterIndex, groupRows, sortIndex } from '@onegrid/data';
import type { FilterNode, GroupingModel, SortModel } from '@onegrid/protocol';
import { createFakeAccelModule, createWasmBackend } from '@onegrid/wasm';
import type { AccelModule } from '@onegrid/wasm';
import { accelAggregate, accelFilterIndex, accelGroupRows, accelSortIndex } from '../accel.js';
import { seeded } from './accel-case.js';

const N = Number(process.env.OG_ACCEL_BENCH_ROW ?? 1_000_000);
const ARTIFACT = process.env.OG_ACCEL_WASM;

function minOf(run: number, fn: () => unknown): number {
  let best = Number.POSITIVE_INFINITY;
  for (let r = 0; r < run; r++) {
    const t = performance.now();
    fn();
    best = Math.min(best, performance.now() - t);
  }
  return best;
}

describe.skipIf(!process.env.OG_ACCEL_BENCH)(`data-worker jobs at ${N.toLocaleString()} rows`, () => {
  it('reports @onegrid/data vs accelerated dispatch', () => {
    const real = ARTIFACT !== undefined && existsSync(ARTIFACT);
    const module = real
      ? (new WebAssembly.Instance(new WebAssembly.Module(readFileSync(ARTIFACT)), {}).exports as unknown as AccelModule)
      : createFakeAccelModule({ maximumPage: 16_384 });
    const backend = createWasmBackend(module);

    const rand = seeded(0x1234);
    const price = Float64Array.from({ length: N }, () => Math.round(rand() * 100_000) / 100 - 250);
    const qty = Int32Array.from({ length: N }, () => Math.floor(rand() * 1000));
    const region = Int32Array.from({ length: N }, () => Math.floor(rand() * 64));
    const makeTable = () =>
      createColumnTable([
        { schema: { id: 'price', type: 'float64' }, data: price },
        { schema: { id: 'qty', type: 'int32' }, data: qty },
        { schema: { id: 'region', type: 'int32' }, data: region },
      ]);

    const sort1: SortModel = [{ columnId: 'price', direction: 'asc' }];
    const sort2: SortModel = [
      { columnId: 'region', direction: 'asc' },
      { columnId: 'price', direction: 'desc' },
    ];
    const filter: FilterNode = {
      type: 'logical',
      op: 'and',
      filters: [
        { type: 'comparison', columnId: 'price', op: 'gt', value: 0 },
        { type: 'comparison', columnId: 'qty', op: 'between', values: [100, 500] },
        { type: 'comparison', columnId: 'region', op: 'in', values: [1, 3, 5, 7] },
      ],
    };
    const grouping: GroupingModel = { columns: ['region'], openKeys: [] };
    const aggregations = [
      { columnId: 'price', fn: 'sum' as const },
      { columnId: 'qty', fn: 'avg' as const },
    ];

    const job: Array<[string, (t: ReturnType<typeof makeTable>) => unknown, (t: ReturnType<typeof makeTable>) => unknown, (a: unknown, b: unknown) => void]> = [
      ['sort price', (t) => sortIndex(t, sort1), (t) => accelSortIndex(backend, t, sort1), (a, b) => expect(Array.from(a as Int32Array)).toEqual(Array.from(b as Int32Array))],
      ['sort region, price desc', (t) => sortIndex(t, sort2), (t) => accelSortIndex(backend, t, sort2), (a, b) => expect(Array.from(a as Int32Array)).toEqual(Array.from(b as Int32Array))],
      ['filter 3-leaf and', (t) => filterIndex(t, filter), (t) => accelFilterIndex(backend, t, filter), (a, b) => expect(Array.from((a as ReturnType<typeof filterIndex>)._bytes)).toEqual(Array.from((b as ReturnType<typeof filterIndex>)._bytes))],
      ['group region + 2 aggregates', (t) => groupRows(t, grouping, { aggregations }), (t) => accelGroupRows(backend, t, grouping, { aggregations }), (a, b) => expect(a).toEqual(b)],
      ['aggregate sum price', (t) => aggregate(t, aggregations[0]!), (t) => accelAggregate(backend, t, aggregations[0]!), (a, b) => expect(a).toBe(b)],
    ];

    const line = [`${'job'.padEnd(30)}${'data ms'.padStart(10)}${'cold ms'.padStart(10)}${'warm ms'.padStart(10)}${'× warm'.padStart(9)}`];
    for (const [name, dataJob, accelJob, same] of job) {
      const run = name.startsWith('sort') || name.startsWith('group') ? 2 : 5;
      const table = makeTable();
      same(accelJob(makeTable()), dataJob(table));
      const dataMs = minOf(run, () => dataJob(table));
      const coldMs = minOf(1, () => accelJob(makeTable()));
      const warmTable = makeTable();
      accelJob(warmTable);
      const warmMs = minOf(run, () => accelJob(warmTable));
      line.push(
        `${name.padEnd(30)}${dataMs.toFixed(1).padStart(10)}${coldMs.toFixed(1).padStart(10)}${warmMs.toFixed(1).padStart(10)}${(dataMs / warmMs).toFixed(2).padStart(9)}`,
      );
    }
    expect(backend.heap.usedByte).toBe(0);
    console.log(`\n[bench] data-worker jobs, ${real ? 'REAL index-accel kernel' : 'FAKE JS kernel (marshalling only)'}\n${line.join('\n')}`);
  }, 900_000);
});
