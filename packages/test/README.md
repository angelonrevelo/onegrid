# @onegrid/test

The testing toolkit for **adopters** of oneGrid — the utilities you need to
write tests for your own grid-based UI.

It is a library, not a document. Everything here is executable.

## Why it exists

A oneGrid grid renders to a Canvas-2D surface. That makes it fast and makes it
untestable by default:

| Problem | What this package ships |
| --- | --- |
| jsdom's `getContext('2d')` returns `null`, so a `Grid` cannot even construct | `installCanvasStub()` — a recording fake implementing exactly the 2D surface `@onegrid/core` calls, with a deterministic `measureText` |
| Cells are pixels, so `getByText` has nothing to find | Query helpers over the grid's `<table role="grid">` accessibility shadow |
| Rendering, block fetching and validation are all asynchronous | `waitForRender` / `waitForIdle` / `waitForBlock`, each timeout-bounded with a failure message that reports the state it actually saw |
| Real data sources make loading states a race | `createFakeRowSource` and `createFakeDataSource`, the latter with `manual` mode, a `pending` view, `flush()` and a request log |
| Pointer/keyboard sequences are easy to get subtly wrong | `clickCell`, `selectRange`, `doubleClickCell`, `pressKey`, `pasteTsv`, `typeIntoCell` — replaying the sequences core's listeners are actually bound to |

There is no runtime dependency on `vitest`. `installGridMatcher(expect)` takes
your runner's `expect` as an argument, so the harness works unchanged under
vitest's node and browser modes, or a Playwright component runner.

## Install

```sh
pnpm add -D @onegrid/test
```

Requires a DOM environment. In vitest:

```ts
// vitest.config.ts
export default { test: { environment: 'jsdom' } };
```

## Usage

```ts
import { afterEach, beforeEach, expect, it } from 'vitest';
import {
  clickCell,
  createFakeRowSource,
  installGridEnvironment,
  installGridMatcher,
  mountGrid,
  typeIntoCell,
  waitForRender,
} from '@onegrid/test';
import type { GridMatcher, GridTestHandle } from '@onegrid/test';

declare module 'vitest' {
  interface Assertion<T = any> extends GridMatcher<T> {}
}

installGridMatcher(expect);

let env: ReturnType<typeof installGridEnvironment>;
let grid: GridTestHandle;

beforeEach(() => {
  env = installGridEnvironment();
  const row = createFakeRowSource({ rowCount: 500, column: ['name', 'score'] });
  grid = mountGrid({
    columns: [
      { id: 'name', width: 160, displayName: 'Name' },
      { id: 'score', width: 100, displayName: 'Score' },
    ],
    rowSource: row,
    rowHeight: 28,
    editable: true,
    onCellEdit: (rowIndex, columnId, value) => {
      row.setCell(rowIndex, columnId, value);
      grid.grid.refresh();
    },
  });
});

afterEach(() => {
  grid.unmount();
  env.restore();
});

it('selects and edits a cell', async () => {
  clickCell(grid, 3, 1);
  expect(grid).toHaveSelectedRange({ rowStart: 3, rowEnd: 3, colStart: 1, colEnd: 1 });

  typeIntoCell(grid, 3, 1, '42');
  await waitForRender(grid.grid);
  expect(grid).toHaveGridValue(3, 1, '42');
});
```

### Driving block loading deterministically

```ts
import { createFakeDataSource, waitForBlock } from '@onegrid/test';

const source = createFakeDataSource({
  rowCount: 1_000_000,
  column: ['a', 'b'],
  manual: true, // nothing resolves until you say so
});

// ... mount a grid whose row source fetches from `source` ...

expect(source.pending).toEqual([0]);   // block 0 is in flight
expect(grid.grid.getSelection()).toBeDefined();

await source.flush();                  // release every parked fetch
await waitForBlock(source, 0);
expect(source.call.map((c) => c.blockIndex)).toEqual([0]);
```

`waitForBlock` distinguishes the two failures that look identical from the
outside — *the block was never requested* (an overscan or scroll bug) versus
*requested but never delivered* (a source still parked in `manual` mode) — and
prints the full request and pending logs either way.

### Asserting what was painted

```ts
const env = installGridEnvironment();
mountGrid({ /* … */ });

expect(env.canvas.paintedText()).toContain('Name');
expect(env.canvas.callTo('clearRect')).toHaveLength(1);
```

The call log is ordered and includes property assignments (`fillStyle`,
`font`, `lineWidth`, …) as `kind: 'set'` entries, so "the row background was
filled before the text" is an assertion rather than a guess.

## API

**Environment** — `installGridEnvironment`, `mountGrid`, `setElementRect`,
`installCanvasStub`

**Queries** — `getCell`, `getCellText`, `getRowElement`, `getHeader`,
`getHeaderText`, `readGridText`, `readGridWindow`, `resolveColumnIndex`,
`expectGridToMatch`

**Waits** — `waitForBlock`, `waitForRender`, `waitForIdle`

**Fakes** — `createFakeRowSource`, `createFakeDataSource`

**User events** — `clickCell`, `selectRange`, `doubleClickCell`, `pressKey`,
`pasteTsv`, `typeIntoCell`, `focusGrid`, `getCellEditor`

**Matchers** — `installGridMatcher`, `gridMatcher`, and the three assertions
`toHaveGridValue`, `toHaveSelectedRange`, `toHaveRowCount`

## Limits worth knowing

- **jsdom runs no layout engine.** `mountGrid` declares the host's box rather
  than measuring it (`width` / `height`, defaulting to 800×600); anything
  outside that box is not hit-testable, so scroll to a row before clicking it.
- **The accessibility shadow is windowed** to roughly the visible rows plus
  the active one. `getCell` returns `null` for a row outside the window — use
  `readGridWindow()` to see which rows are covered.
- **Canvas assertions are about calls, not pixels.** For pixel-level
  verification use Playwright or vitest browser mode against a real canvas;
  this package deliberately does not attempt image comparison in jsdom.

## License

MIT
