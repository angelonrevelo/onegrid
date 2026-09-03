import { describe, it, expect, vi } from 'vitest';
import {
  addCell,
  buildGraph,
  createFormulaKernel,
  createNotebook,
  createNotebookRunner,
  createTableOutput,
  findAllCycle,
  findCycle,
  findDuplicateName,
  findReference,
  fromJSON,
  getCell,
  getCellByName,
  markStale,
  moveCell,
  NotebookAbortError,
  parseNotebook,
  removeCell,
  renameCell,
  resetNotebook,
  runCell,
  runNotebook,
  runStale,
  stringifyNotebook,
  tableOutputFromRow,
  toColumnTable,
  toJSON,
  topoOrder,
  transitiveDependent,
  updateCellSource,
  unwrapOutput,
} from '../index.js';
import type { CellOutput, Kernel, KernelScope, NotebookDocument } from '../index.js';

// -----------------------------------------------------------------------------
// A counting kernel: every cell's source is a tiny arithmetic expression over
// its dependencies, and we record which cells were evaluated so the
// incremental tests can assert on invocation counts rather than on vibes.
// -----------------------------------------------------------------------------

interface CountingKernel {
  readonly kernel: Kernel;
  readonly callFor: (name: string) => number;
  readonly total: () => number;
  readonly reset: () => void;
}

function countingKernel(language: 'formula' | 'sql' | 'javascript' = 'javascript'): CountingKernel {
  const call = new Map<string, number>();
  const kernel: Kernel = {
    language,
    evaluate: (source, scope) => {
      const key = source.trim();
      call.set(key, (call.get(key) ?? 0) + 1);
      return { kind: 'scalar', value: evalExpression(source, scope) };
    },
  };
  return {
    kernel,
    callFor: (name) => call.get(name) ?? 0,
    total: () => [...call.values()].reduce((a, b) => a + b, 0),
    reset: () => call.clear(),
  };
}

/** `a + b * 2` where identifiers come from scope and numbers are literals. */
function evalExpression(source: string, scope: KernelScope): number {
  const token = source.split(/\s*([+*])\s*/).filter((t) => t !== '');
  let acc = valueOf(token[0]!, scope);
  for (let i = 1; i < token.length; i += 2) {
    const op = token[i];
    const rhs = valueOf(token[i + 1]!, scope);
    acc = op === '+' ? acc + rhs : acc * rhs;
  }
  return acc;
}

function valueOf(token: string, scope: KernelScope): number {
  const trimmed = token.trim();
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (!scope.has(trimmed)) throw new Error(`unknown reference "${trimmed}"`);
  return Number(scope.get(trimmed));
}

function doc3(): NotebookDocument {
  // base → double → total, plus an unrelated island.
  return createNotebook([
    { id: 'base', kind: 'javascript', source: '2', name: 'base' },
    { id: 'double', kind: 'javascript', source: 'base * 2', name: 'double' },
    { id: 'total', kind: 'javascript', source: 'double + 1', name: 'total' },
    { id: 'island', kind: 'javascript', source: '99', name: 'island' },
  ]);
}

function scalarOf(doc: NotebookDocument, id: string): unknown {
  const output = getCell(doc, id)?.output;
  return output?.kind === 'scalar' ? output.value : undefined;
}

// -----------------------------------------------------------------------------

describe('reference extraction', () => {
  const known = new Set(['base', 'total', 'sale']);

  it('finds bare identifiers that name other cells', () => {
    expect(findReference('base + total', 'javascript', known)).toEqual(['base', 'total']);
  });

  it('ignores identifiers inside string literals and comments', () => {
    expect(findReference("'base' + total -- base\n", 'sql', known)).toEqual(['total']);
    expect(findReference('/* base */ total // total', 'javascript', known)).toEqual(['total']);
  });

  it('ignores call callees so SUM(sale) does not reference a cell named SUM', () => {
    const withSum = new Set([...known, 'SUM']);
    expect(findReference('SUM(sale)', 'formula', withSum)).toEqual(['sale']);
  });

  it('ignores member access and self-reference', () => {
    expect(findReference('row.base + base', 'javascript', known, 'base')).toEqual([]);
  });

  it('markdown references only through {{name}}', () => {
    expect(findReference('the base is {{ total }}', 'markdown', known)).toEqual(['total']);
  });
});

describe('dependency graph', () => {
  it('orders topologically, not in document order', () => {
    // Declared bottom-up: the consumer comes first in the document.
    const doc = createNotebook([
      { id: 'c', kind: 'javascript', source: 'b + 1', name: 'c' },
      { id: 'b', kind: 'javascript', source: 'a * 2', name: 'b' },
      { id: 'a', kind: 'javascript', source: '1', name: 'a' },
    ]);
    const { order, blocked } = topoOrder(doc);
    expect(order).toEqual(['a', 'b', 'c']);
    expect(blocked).toEqual([]);
  });

  it('breaks ties by document order so runs are reproducible', () => {
    const doc = createNotebook([
      { id: 'x', kind: 'javascript', source: '1', name: 'x' },
      { id: 'y', kind: 'javascript', source: '2', name: 'y' },
      { id: 'z', kind: 'javascript', source: 'x + y', name: 'z' },
    ]);
    expect(topoOrder(doc).order).toEqual(['x', 'y', 'z']);
  });

  it('records both edge directions', () => {
    const graph = buildGraph(doc3());
    expect(graph.dependency.get('double')).toEqual(['base']);
    expect(graph.dependent.get('base')).toEqual(['double']);
    expect(graph.dependency.get('island')).toEqual([]);
  });

  it('transitiveDependent returns the full downstream closure in order', () => {
    expect(transitiveDependent(doc3(), 'base')).toEqual(['double', 'total']);
    expect(transitiveDependent(doc3(), 'total')).toEqual([]);
  });

  it('surfaces duplicate names', () => {
    const doc = createNotebook([
      { id: 'one', kind: 'javascript', source: '1', name: 'dup' },
      { id: 'two', kind: 'javascript', source: '2', name: 'dup' },
    ]);
    expect([...findDuplicateName(doc).get('dup')!]).toEqual(['one', 'two']);
  });
});

describe('cycle detection', () => {
  const cyclic = createNotebook([
    { id: 'a', kind: 'javascript', source: 'c + 1', name: 'a' },
    { id: 'b', kind: 'javascript', source: 'a + 1', name: 'b' },
    { id: 'c', kind: 'javascript', source: 'b + 1', name: 'c' },
    { id: 'free', kind: 'javascript', source: '7', name: 'free' },
  ]);

  it('reports the full cycle path rather than hanging', () => {
    const cycle = findCycle(cyclic);
    expect(cycle).toBeDefined();
    expect(cycle!.path[0]).toBe(cycle!.path[cycle!.path.length - 1]);
    expect(new Set(cycle!.path)).toEqual(new Set(['a', 'b', 'c']));
    expect(cycle!.label.join(' → ')).toMatch(/a|b|c/);
  });

  it('returns undefined for a DAG', () => {
    expect(findCycle(doc3())).toBeUndefined();
  });

  it('finds two independent cycles once each', () => {
    const doc = createNotebook([
      { id: 'p', kind: 'javascript', source: 'q + 1', name: 'p' },
      { id: 'q', kind: 'javascript', source: 'p + 1', name: 'q' },
      { id: 'r', kind: 'javascript', source: 's + 1', name: 'r' },
      { id: 's', kind: 'javascript', source: 'r + 1', name: 's' },
    ]);
    expect(findAllCycle(doc)).toHaveLength(2);
  });

  it('a run marks cycle members as errors carrying the path, and completes', async () => {
    const k = countingKernel();
    const ran = await runNotebook(cyclic, { kernel: [k.kernel] });
    for (const id of ['a', 'b', 'c']) {
      const cell = getCell(ran, id)!;
      expect(cell.state).toBe('error');
      expect(cell.output?.kind).toBe('error');
      expect((cell.output as { message: string }).message).toContain('circular reference');
      expect((cell.output as { message: string }).message).toContain('→');
    }
    expect(getCell(ran, 'free')!.state).toBe('ok');
    // No cycle member was ever handed to the kernel.
    expect(k.total()).toBe(1);
  });
});

describe('running', () => {
  it('runs the whole notebook in dependency order', async () => {
    const k = countingKernel();
    const ran = await runNotebook(doc3(), { kernel: [k.kernel] });
    expect(scalarOf(ran, 'base')).toBe(2);
    expect(scalarOf(ran, 'double')).toBe(4);
    expect(scalarOf(ran, 'total')).toBe(5);
    expect(ran.cell.every((c) => c.state === 'ok')).toBe(true);
  });

  it('re-runs only the transitive dependents of a change', async () => {
    const k = countingKernel();
    const first = await runNotebook(doc3(), { kernel: [k.kernel] });
    expect(k.callFor('99')).toBe(1);
    k.reset();

    const edited = updateCellSource(first, 'base', '10');
    const second = await runCell(edited, 'base', { kernel: [k.kernel] });

    expect(scalarOf(second, 'total')).toBe(21);
    expect(k.callFor('10')).toBe(1);
    expect(k.callFor('base * 2')).toBe(1);
    expect(k.callFor('double + 1')).toBe(1);
    // The island depends on nothing that changed — it must not be re-run.
    expect(k.callFor('99')).toBe(0);
    expect(k.total()).toBe(3);
  });

  it('runStale re-runs everything not currently ok, and nothing else', async () => {
    const k = countingKernel();
    const first = await runNotebook(doc3(), { kernel: [k.kernel] });
    k.reset();
    const edited = updateCellSource(first, 'double', 'base * 5');
    const second = await runStale(edited, { kernel: [k.kernel] });
    expect(scalarOf(second, 'total')).toBe(11);
    expect(k.callFor('2')).toBe(0);
    expect(k.callFor('99')).toBe(0);
    expect(k.total()).toBe(2);
  });

  it('emits progress documents with running / ok transitions', async () => {
    const k = countingKernel();
    const seen: string[] = [];
    await runNotebook(doc3(), {
      kernel: [k.kernel],
      onProgress: (d) => {
        const state = getCell(d, 'double')!.state;
        if (seen[seen.length - 1] !== state) seen.push(state);
      },
    });
    expect(seen).toContain('queued');
    expect(seen).toContain('running');
    expect(seen[seen.length - 1]).toBe('ok');
  });

  it('reports a missing kernel instead of throwing', async () => {
    const doc = createNotebook([{ id: 'q', kind: 'sql', source: 'select 1', name: 'q' }]);
    const ran = await runNotebook(doc, { kernel: [] });
    expect(getCell(ran, 'q')!.state).toBe('error');
    expect((getCell(ran, 'q')!.output as { message: string }).message).toContain('no kernel');
  });
});

describe('error propagation', () => {
  const broken: Kernel = {
    language: 'javascript',
    evaluate: (source, scope) => {
      if (source.includes('boom')) throw new Error('kernel exploded');
      return { kind: 'scalar', value: scope.has('bad') ? scope.get('bad') : 1 };
    },
  };

  it('a throwing kernel becomes an error output on its own cell', async () => {
    const doc = createNotebook([{ id: 'x', kind: 'javascript', source: 'boom', name: 'bad' }]);
    const ran = await runNotebook(doc, { kernel: [broken] });
    expect(getCell(ran, 'x')!.state).toBe('error');
    expect((getCell(ran, 'x')!.output as { message: string }).message).toBe('kernel exploded');
  });

  it('dependents inherit the error and keep the ORIGIN cell id', async () => {
    const doc = createNotebook([
      { id: 'x', kind: 'javascript', source: 'boom', name: 'bad' },
      { id: 'y', kind: 'javascript', source: 'bad + 1', name: 'mid' },
      { id: 'z', kind: 'javascript', source: 'mid + 1', name: 'end' },
    ]);
    const ran = await runNotebook(doc, { kernel: [broken] });
    for (const id of ['y', 'z']) {
      const output = getCell(ran, id)!.output;
      expect(getCell(ran, id)!.state).toBe('error');
      expect(output?.kind).toBe('error');
      // Blame lands on x, not on the direct upstream.
      expect((output as { cellId: string }).cellId).toBe('x');
    }
  });

  it('flags a dependency that has never been computed', async () => {
    const k = countingKernel();
    const doc = createNotebook([
      { id: 'a', kind: 'javascript', source: '1', name: 'a' },
      { id: 'b', kind: 'javascript', source: 'a + 1', name: 'b' },
    ]);
    const ran = await runCell(doc, 'b', { kernel: [k.kernel] });
    expect(getCell(ran, 'b')!.state).toBe('error');
    expect((getCell(ran, 'b')!.output as { message: string }).message).toContain('no output');
  });
});

describe('staleness', () => {
  it('marks dependents stale immediately, before any recompute', async () => {
    const k = countingKernel();
    const ran = await runNotebook(doc3(), { kernel: [k.kernel] });
    k.reset();
    const edited = updateCellSource(ran, 'base', '3');
    expect(getCell(edited, 'base')!.state).toBe('stale');
    expect(getCell(edited, 'double')!.state).toBe('stale');
    expect(getCell(edited, 'total')!.state).toBe('stale');
    expect(getCell(edited, 'island')!.state).toBe('ok');
    // Nothing ran: staleness is pure bookkeeping.
    expect(k.total()).toBe(0);
    // The old outputs survive so a UI can grey them rather than blank them.
    expect(scalarOf(edited, 'double')).toBe(4);
  });

  it('markStale handles an external input change', async () => {
    const k = countingKernel();
    const ran = await runNotebook(doc3(), { kernel: [k.kernel] });
    const stale = markStale(ran, 'double');
    expect(getCell(stale, 'double')!.state).toBe('stale');
    expect(getCell(stale, 'total')!.state).toBe('stale');
    expect(getCell(stale, 'base')!.state).toBe('ok');
  });

  it('a never-run cell stays idle rather than going stale', () => {
    const edited = updateCellSource(doc3(), 'base', '5');
    expect(getCell(edited, 'double')!.state).toBe('idle');
  });

  it('removing a cell stales what referenced it', async () => {
    const k = countingKernel();
    const ran = await runNotebook(doc3(), { kernel: [k.kernel] });
    const without = removeCell(ran, 'base');
    expect(getCell(without, 'base')).toBeUndefined();
    expect(getCell(without, 'double')!.state).toBe('stale');
    expect(getCell(without, 'island')!.state).toBe('ok');
  });

  it('renaming a cell stales the sources that mention either name', async () => {
    const k = countingKernel();
    const ran = await runNotebook(doc3(), { kernel: [k.kernel] });
    const renamed = renameCell(ran, 'base', 'root');
    expect(getCellByName(renamed, 'root')?.id).toBe('base');
    expect(getCell(renamed, 'double')!.state).toBe('stale');
  });
});

describe('immutability', () => {
  it('updateCellSource leaves the input document untouched', () => {
    const before = doc3();
    const snapshot = JSON.stringify(toJSON(before));
    const after = updateCellSource(before, 'base', '42');
    expect(JSON.stringify(toJSON(before))).toBe(snapshot);
    expect(after).not.toBe(before);
    expect(after.revision).toBe(before.revision + 1);
    expect(getCell(before, 'base')!.source).toBe('2');
    expect(getCell(after, 'base')!.source).toBe('42');
  });

  it('unchanged cells keep object identity across an update', () => {
    const before = doc3();
    const after = updateCellSource(before, 'base', '42');
    expect(getCell(after, 'island')).toBe(getCell(before, 'island'));
    expect(getCell(after, 'base')).not.toBe(getCell(before, 'base'));
  });

  it('a run does not mutate the document it was given', async () => {
    const k = countingKernel();
    const before = doc3();
    const ran = await runNotebook(before, { kernel: [k.kernel] });
    expect(before.cell.every((c) => c.state === 'idle')).toBe(true);
    expect(before.cell.every((c) => c.output === undefined)).toBe(true);
    expect(ran).not.toBe(before);
  });

  it('add / move / reset all return new documents', () => {
    const base = doc3();
    const added = addCell(base, { id: 'extra', kind: 'javascript', source: '1', name: 'extra' });
    expect(base.cell).toHaveLength(4);
    expect(added.cell).toHaveLength(5);
    const moved = moveCell(added, 'extra', 0);
    expect(moved.cell[0]!.id).toBe('extra');
    expect(added.cell[0]!.id).toBe('base');
    const reset = resetNotebook(moved);
    expect(reset.cell.every((c) => c.state === 'idle')).toBe(true);
  });

  it('rejects an invalid cell name at construction', () => {
    expect(() => createNotebook([{ kind: 'javascript', source: '1', name: '2bad' }])).toThrow(
      /BAD_NAME/,
    );
  });
});

describe('cancellation', () => {
  const slowKernel = (log: string[]): Kernel => ({
    language: 'javascript',
    evaluate: async (source) => {
      log.push(source);
      await new Promise((r) => setTimeout(r, 5));
      return { kind: 'scalar', value: source.length } as CellOutput;
    },
  });

  it('aborting mid-run throws NotebookAbortError with the partial document', async () => {
    const log: string[] = [];
    const controller = new AbortController();
    const doc = createNotebook([
      { id: 'a', kind: 'javascript', source: 'a', name: 'a' },
      { id: 'b', kind: 'javascript', source: 'a + 1', name: 'b' },
      { id: 'c', kind: 'javascript', source: 'b + 1', name: 'c' },
    ]);
    const promise = runNotebook(doc, { kernel: [slowKernel(log)], signal: controller.signal });
    setTimeout(() => controller.abort(), 8);
    await expect(promise).rejects.toBeInstanceOf(NotebookAbortError);
    await promise.catch((err: NotebookAbortError) => {
      expect(err.partial.cell.some((c) => c.state === 'ok')).toBe(true);
      expect(log.length).toBeLessThan(3);
    });
  });

  it('an already-aborted signal runs nothing', async () => {
    const log: string[] = [];
    const controller = new AbortController();
    controller.abort();
    await expect(
      runNotebook(doc3(), { kernel: [slowKernel(log)], signal: controller.signal }),
    ).rejects.toBeInstanceOf(NotebookAbortError);
    expect(log).toHaveLength(0);
  });

  it('runner.cancel() kills the in-flight run and everything queued behind it', async () => {
    const log: string[] = [];
    const runner = createNotebookRunner({ kernel: [slowKernel(log)] });
    const first = runner.run(doc3());
    const second = runner.run(doc3());
    expect(runner.pendingCount()).toBe(2);
    runner.cancel();
    await expect(first).rejects.toBeInstanceOf(NotebookAbortError);
    await expect(second).rejects.toBeInstanceOf(NotebookAbortError);
    expect(runner.pendingCount()).toBe(0);
  });
});

describe('runner queue', () => {
  it('serialises runs — no two overlap', async () => {
    let active = 0;
    let maxActive = 0;
    const kernel: Kernel = {
      language: 'javascript',
      evaluate: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 1));
        active -= 1;
        return { kind: 'scalar', value: 1 };
      },
    };
    const runner = createNotebookRunner({ kernel: [kernel] });
    await Promise.all([runner.run(doc3()), runner.run(doc3()), runner.run(doc3())]);
    expect(maxActive).toBe(1);
    expect(runner.pendingCount()).toBe(0);
  });

  it('a failed run does not poison the queue', async () => {
    const kernel: Kernel = {
      language: 'javascript',
      evaluate: () => ({ kind: 'scalar', value: 1 }),
    };
    const runner = createNotebookRunner({ kernel: [kernel] });
    const bad = runner.run(doc3(), AbortSignal.abort());
    await expect(bad).rejects.toBeInstanceOf(NotebookAbortError);
    const good = await runner.run(doc3());
    expect(good.cell.every((c) => c.state === 'ok')).toBe(true);
  });

  it('runner.runCell only re-runs the affected slice', async () => {
    const k = countingKernel();
    const runner = createNotebookRunner({ kernel: [k.kernel] });
    const first = await runner.run(doc3());
    k.reset();
    const second = await runner.runCell(updateCellSource(first, 'double', 'base * 3'), 'double');
    expect(scalarOf(second, 'total')).toBe(7);
    expect(k.callFor('2')).toBe(0);
    expect(k.callFor('99')).toBe(0);
  });
});

describe('outputs', () => {
  it('a table output feeds @onegrid/data directly', () => {
    const output = createTableOutput([
      { schema: { id: 'qty', type: 'int32' }, data: Int32Array.from([1, 2, 3]) },
      { schema: { id: 'label', type: 'utf8' }, data: ['a', 'b', 'c'] },
    ]);
    expect(output.numRow).toBe(3);
    const table = toColumnTable(output);
    expect(table.numRows).toBe(3);
    expect(table.column('qty').get(2)).toBe(3);
    expect(table.column('label').get(0)).toBe('a');
  });

  it('rejects ragged columns at the boundary', () => {
    expect(() =>
      createTableOutput([
        { schema: { id: 'a', type: 'int32' }, data: [1, 2] },
        { schema: { id: 'b', type: 'int32' }, data: [1] },
      ]),
    ).toThrow(/RAGGED/);
  });

  it('builds a table from driver-style row objects', () => {
    const output = tableOutputFromRow([
      { id: 1, city: 'Manila' },
      { id: 2, city: 'Cebu' },
    ]);
    expect(output.numRow).toBe(2);
    expect(toColumnTable(output).column('city').get(1)).toBe('Cebu');
  });

  it('unwraps each output variant for the consuming cell', () => {
    expect(unwrapOutput({ kind: 'scalar', value: 7 })).toBe(7);
    expect(unwrapOutput({ kind: 'markdown', text: 'hi' })).toBe('hi');
    expect(unwrapOutput({ kind: 'error', message: 'x', cellId: 'a' })).toBeUndefined();
    expect(unwrapOutput(undefined)).toBeUndefined();
  });

  it('a table output flows from one cell into the next', async () => {
    const source: Kernel = {
      language: 'sql',
      evaluate: () =>
        createTableOutput([
          { schema: { id: 'v', type: 'float64' }, data: Float64Array.from([1, 2, 3, 4]) },
        ]),
    };
    const consumer: Kernel = {
      language: 'javascript',
      evaluate: (_source, scope) => {
        const table = scope.get('sale') as ReturnType<typeof toColumnTable>;
        let sum = 0;
        for (let i = 0; i < table.numRows; i++) sum += Number(table.column('v').get(i));
        return { kind: 'scalar', value: sum };
      },
    };
    const doc = createNotebook([
      { id: 's', kind: 'sql', source: 'select v from t', name: 'sale' },
      { id: 'c', kind: 'javascript', source: 'sale', name: 'summed' },
    ]);
    const ran = await runNotebook(doc, { kernel: [source, consumer] });
    expect(scalarOf(ran, 'c')).toBe(10);
  });
});

describe('markdown kernel', () => {
  it('interpolates {{name}} from upstream outputs', async () => {
    const k = countingKernel();
    const doc = createNotebook([
      { id: 'n', kind: 'javascript', source: '41 + 1', name: 'answer' },
      { id: 'm', kind: 'markdown', source: 'The answer is {{answer}}.' },
    ]);
    const ran = await runNotebook(doc, { kernel: [k.kernel] });
    expect(getCell(ran, 'm')!.output).toEqual({
      kind: 'markdown',
      text: 'The answer is 42.',
    });
  });

  it('leaves an unknown placeholder alone', async () => {
    const doc = createNotebook([{ id: 'm', kind: 'markdown', source: '{{nope}}' }]);
    const ran = await runNotebook(doc, { kernel: [] });
    expect((getCell(ran, 'm')!.output as { text: string }).text).toBe('{{nope}}');
  });
});

describe('formula kernel', () => {
  it('resolves notebook names through the formula engine', async () => {
    const doc = createNotebook([
      { id: 'a', kind: 'formula', source: '=2 + 3', name: 'base' },
      { id: 'b', kind: 'formula', source: '=base * 10', name: 'scaled' },
    ]);
    const ran = await runNotebook(doc, { kernel: [createFormulaKernel()] });
    expect(scalarOf(ran, 'a')).toBe(5);
    expect(scalarOf(ran, 'b')).toBe(50);
  });

  it('aggregates a table-valued dependency', async () => {
    const sql: Kernel = {
      language: 'sql',
      evaluate: () =>
        createTableOutput([
          { schema: { id: 'amount', type: 'float64' }, data: Float64Array.from([10, 20, 30]) },
        ]),
    };
    const doc = createNotebook([
      { id: 'q', kind: 'sql', source: 'select amount from sale', name: 'sale' },
      { id: 'f', kind: 'formula', source: '=SUM(sale)', name: 'gross' },
    ]);
    const ran = await runNotebook(doc, { kernel: [sql, createFormulaKernel()] });
    expect(scalarOf(ran, 'f')).toBe(60);
  });

  it('turns a formula error into an ErrorOutput', async () => {
    const doc = createNotebook([{ id: 'a', kind: 'formula', source: '=1/0', name: 'oops' }]);
    const ran = await runNotebook(doc, { kernel: [createFormulaKernel()] });
    expect(getCell(ran, 'a')!.state).toBe('error');
    expect((getCell(ran, 'a')!.output as { message: string }).message).toContain('#DIV/0!');
  });

  it('honours an adopter-supplied A1 resolver', async () => {
    const getCellRef = vi.fn((ref: string) => (ref === 'A1' ? 4 : undefined));
    const doc = createNotebook([{ id: 'a', kind: 'formula', source: '=A1 * 2', name: 'x' }]);
    const ran = await runNotebook(doc, {
      kernel: [createFormulaKernel({ getCell: getCellRef })],
    });
    expect(scalarOf(ran, 'a')).toBe(8);
    expect(getCellRef).toHaveBeenCalledWith('A1');
  });
});

describe('serialisation', () => {
  it('round-trips a computed notebook through JSON', async () => {
    const k = countingKernel();
    const ran = await runNotebook(doc3(), { kernel: [k.kernel] });
    const restored = parseNotebook(stringifyNotebook(ran));
    expect(restored).toEqual(ran);
    expect(scalarOf(restored, 'total')).toBe(5);
    expect(getCell(restored, 'total')!.state).toBe('ok');
  });

  it('round-trips typed-array table columns without degrading them', () => {
    const doc: NotebookDocument = {
      revision: 3,
      cell: [
        {
          id: 't',
          kind: 'sql',
          source: 'select *',
          name: 'result',
          state: 'ok',
          output: createTableOutput([
            {
              schema: { id: 'qty', type: 'int32' },
              data: Int32Array.from([5, 6, 7]),
              validity: Uint8Array.from([7]),
            },
            { schema: { id: 'big', type: 'int64' }, data: BigInt64Array.from([1n, 2n, 3n]) },
            { schema: { id: 'name', type: 'utf8' }, data: ['a', 'b', 'c'] },
          ]),
        },
      ],
    };
    const restored = parseNotebook(stringifyNotebook(doc));
    const output = getCell(restored, 't')!.output as ReturnType<typeof createTableOutput>;
    expect(output.column[0]!.data).toBeInstanceOf(Int32Array);
    expect(Array.from(output.column[0]!.data as Int32Array)).toEqual([5, 6, 7]);
    expect(output.column[0]!.validity).toBeInstanceOf(Uint8Array);
    expect(output.column[1]!.data).toBeInstanceOf(BigInt64Array);
    expect(Array.from(output.column[1]!.data as BigInt64Array)).toEqual([1n, 2n, 3n]);
    expect(output.column[2]!.data).toEqual(['a', 'b', 'c']);
    expect(toColumnTable(output).column('name').get(2)).toBe('c');
  });

  it('can persist sources only', async () => {
    const k = countingKernel();
    const ran = await runNotebook(doc3(), { kernel: [k.kernel] });
    const lean = fromJSON(toJSON(ran, { includeOutput: false }));
    expect(lean.cell.every((c) => c.state === 'idle')).toBe(true);
    expect(lean.cell.every((c) => c.output === undefined)).toBe(true);
    expect(lean.cell.map((c) => c.source)).toEqual(ran.cell.map((c) => c.source));
  });

  it('refuses an unknown schema version', () => {
    const json = { ...toJSON(doc3()), schemaVersion: 99 };
    expect(() => fromJSON(json)).toThrow(/schemaVersion/);
  });

  it('a restored notebook re-runs incrementally, graph intact', async () => {
    const k = countingKernel();
    const ran = await runNotebook(doc3(), { kernel: [k.kernel] });
    const restored = parseNotebook(stringifyNotebook(ran));
    k.reset();
    const edited = updateCellSource(restored, 'base', '4');
    const second = await runCell(edited, 'base', { kernel: [k.kernel] });
    expect(scalarOf(second, 'total')).toBe(9);
    expect(k.callFor('99')).toBe(0);
  });
});
