# @onegrid/notebook

Notebook-style cells over grid data — the Jupyter pattern with a spreadsheet's
reactivity, and a kernel you plug in.

A notebook is an ordered list of cells. Each cell has a source, an optional
**name**, a lifecycle state and an output. Reference another cell by name and
the dependency graph does the rest: execution is topologically ordered, an edit
re-runs only the transitive dependents of the cell you touched, and everything
downstream of an edit is marked `stale` on the same frame so a UI can grey it
before a single kernel call has been made.

Nothing here evaluates anything. A **kernel** does, and a kernel is two fields:

```ts
interface Kernel {
  readonly language: 'formula' | 'sql' | 'markdown' | 'javascript';
  readonly evaluate: (source: string, scope: KernelScope) => CellOutput | Promise<CellOutput>;
}
```

`@onegrid/formula`, DuckDB-WASM and a WebGPU compute pass all satisfy it.
`createFormulaKernel()` ships as the working reference implementation; the
markdown kernel is built in.

## Install

```sh
pnpm add @onegrid/notebook
```

## Usage

```ts
import {
  createNotebook,
  createFormulaKernel,
  createNotebookRunner,
  createTableOutput,
  getCell,
  toColumnTable,
  updateCellSource,
} from '@onegrid/notebook';

// A SQL kernel is whatever your driver is. This one is a stand-in.
const sqlKernel = {
  language: 'sql' as const,
  evaluate: async (source: string) => {
    const row = await myDuckDb.query(source);
    return createTableOutput([
      { schema: { id: 'amount', type: 'float64' }, data: Float64Array.from(row.map((r) => r.amount)) },
    ]);
  },
};

const doc = createNotebook([
  { id: 'q', kind: 'sql', name: 'sale', source: 'select amount from sale' },
  { id: 'f', kind: 'formula', name: 'gross', source: '=SUM(sale)' },
  { id: 'm', kind: 'markdown', source: 'Gross for the quarter: **{{gross}}**' },
]);

const runner = createNotebookRunner({ kernel: [sqlKernel, createFormulaKernel()] });
const ran = await runner.run(doc);

getCell(ran, 'f')?.output; // { kind: 'scalar', value: 1234 }
getCell(ran, 'm')?.output; // { kind: 'markdown', text: 'Gross for the quarter: **1234**' }

// A table output is @onegrid/data's own ColumnInput[], so it goes straight
// to a grid with no conversion:
const table = toColumnTable(getCell(ran, 'q')!.output as TableOutput);

// Edit: `gross` and the markdown cell go stale immediately; nothing runs yet.
const edited = updateCellSource(ran, 'q', 'select amount from sale where year = 2026');
getCell(edited, 'f')!.state; // 'stale'

// Re-run: exactly the three affected cells. Nothing else touches a kernel.
const next = await runner.runCell(edited, 'q');
```

Cancel a run — the in-flight one and everything queued behind it:

```ts
runner.cancel(); // pending promises reject with NotebookAbortError (carrying .partial)
```

Persist it:

```ts
import { parseNotebook, stringifyNotebook } from '@onegrid/notebook';

localStorage.setItem('nb', stringifyNotebook(next));
const restored = parseNotebook(localStorage.getItem('nb')!);
```

Typed-array table columns survive the round trip — the encoder records the array
constructor and rebuilds it, and `BigInt64Array` values go through as decimal
strings because `JSON.stringify` throws on a bigint.

## References

A cell references another by name. For `formula`, `sql` and `javascript` the
scan takes bare identifiers, skipping string literals, comments, member access
(`row.total`) and call callees — so a cell named `sum` is not "referenced" by
every `SUM(...)` in the notebook. Markdown cells reference only through
`{{name}}` interpolation, because prose is full of words.

Names must match `/^[A-Za-z_][A-Za-z0-9_]*$/`.

## Cycles

Detected before the first kernel call, and reported with the full path:

```ts
findCycle(doc)?.label.join(' → '); // 'a → b → c → a'
```

Participants get an error output naming every member; their downstream cells
get the propagated error. Nothing hangs.

## Errors vs cancellation

Errors are **data**: a failing cell yields `{ kind: 'error', message, cellId }`
where `cellId` is the cell that actually broke, and dependents inherit that id
rather than blaming themselves. A run always completes.

Cancellation is an **exception**: a cancelled run has no meaningful result, so
it throws `NotebookAbortError` — with `.partial` holding the document as of the
last cell that finished.

## Relationship to @onegrid/reactive

`@onegrid/reactive` is a Salsa-style memoiser and the right substrate for
synchronous derived values. It could not back this package: its `compute`
returns `T` (kernels are async), its database is mutable (a notebook document
is a value), and a cyclic query there recurses until the stack blows (a
human-authored notebook is cyclic all the time). The demand-driven idea is
shared; see the header of `src/graph.ts`.

## License

MIT
