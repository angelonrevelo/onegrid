# @onegrid/data-worker

Web Worker offload for `@onegrid/data`'s sort / filter / group / pivot
operations. Keeps 1M-row work off the render thread so the grid stays at
60 FPS while compute runs.

## Why

A 1M-row in-memory sort takes ~700 ms on a typical laptop (real-Chromium
bench). That's 42 frames of jank on the render thread. This package
moves the work to a Worker so the grid keeps painting while the sort
completes, then swaps in the result.

## Quickstart

```ts
// my-data-worker.ts — bundled as a Worker by your build tool
export {} from '@onegrid/data-worker/worker';
```

```ts
// app.ts
import { createDataWorker } from '@onegrid/data-worker';

const worker = new Worker(new URL('./my-data-worker.ts', import.meta.url), {
  type: 'module',
});
const data = createDataWorker({ worker });
await data.ready;

const sortedIndices = await data.sort(columnTable, [
  { columnId: 'price', direction: 'desc' },
]);
```

## API

- `data.sort(table, sortModel, options?)` → `Int32Array`
- `data.filter(table, filterModel, options?)` → BitmapSelection
- `data.group(table, groupingModel, options?)` → `GroupNode`
- `data.pivot(table, pivotModel)` → `PivotedTable`
- `data.dispose()` — terminate the worker, rejecting pending calls

Shared viewport: `ViewportBuffer`, `computeViewportLayout`,
`isSharedMemoryAvailable`, `VIEWPORT_LAYOUT_CONSTANT`,
`createViewportPublisher`, `createViewportSubscriber`.

Budget controller: `WorkerPool`, `createWorkerPool`, `resolveWorkerCap`,
`isAbortError`.

## SharedArrayBuffer viewport

Even with the compute off the main thread, handing the result back costs a
structured clone per frame — and that clone lands as a *task* on the thread
that is trying to paint. `ViewportBuffer` removes it: the worker writes the
visible window into a `SharedArrayBuffer` and the renderer reads it during its
own `requestAnimationFrame` callback. No message per frame.

```ts
// worker side
import {
  createViewportPublisher,
  type ViewportPortLike,
} from '@onegrid/data-worker';

const publisher = createViewportPublisher({
  port: self as unknown as ViewportPortLike,
  column: [
    { id: 'id', kind: 'int32' },
    { id: 'price', kind: 'float64' },
    { id: 'name', kind: 'utf8', textBytePerRow: 48 },
  ],
  capacityRow: 200, // the largest window the renderer will ask for
});

publisher.publish({
  rowOffset: 1200,
  rowCount: 3,
  column: [
    { id: 'id', value: new Int32Array([1, 2, 3]) },
    { id: 'price', value: new Float64Array([9.99, 12.5, 3.25]) },
    { id: 'name', value: ['ACME', 'Globex', 'Initech'] },
  ],
});
```

```ts
// main thread
import { createViewportSubscriber } from '@onegrid/data-worker';

const subscriber = createViewportSubscriber({ port: worker });

function frame(): void {
  const view = subscriber.poll(); // seqlock read, never blocks
  if (view) paint(view); // null => reuse last frame, do not stall
  requestAnimationFrame(frame);
}
```

### Synchronisation

The region is guarded by a **seqlock**, not a mutex. The writer bumps a counter
to odd, writes, bumps it to even; the reader loads the counter, copies the
payload, re-loads the counter, and retries if it changed or was odd. That makes
the reader wait-free — it can never block the compositor, and it can never
observe a half-written frame. `Atomics.wait` is offered only as
`buffer.waitForChange()`, which is **worker-only**: it throws on a browser main
thread by specification. `Atomics.notify` is safe everywhere and the writer
calls it for you.

### Byte layout

Fixed and documented, so a Wasm or Rust peer can address the same region:
a 64-byte header (magic, version, sequence, rowOffset, rowCount, columnCount,
capacityRow, generation), then one 32-byte descriptor per column, then the
8-byte-aligned data regions. `utf8` columns are stored as a
`Uint32Array(capacityRow + 1)` offset table plus a byte arena, since strings
cannot live in a typed array. `VIEWPORT_LAYOUT_CONSTANT` exports the offsets.

### Required headers — read this before you file a bug

`SharedArrayBuffer` only works in a **cross-origin isolated** document. Serve
both of these on the top-level document:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Every cross-origin subresource then needs `Cross-Origin-Resource-Policy:
cross-origin` (or CORS) or it will be blocked. `isSharedMemoryAvailable()`
reports the truth (`typeof SharedArrayBuffer !== 'undefined' &&
crossOriginIsolated`), and when it is false `createViewportPublisher` /
`createViewportSubscriber` fall back to the ordinary postMessage transport
automatically — the same `ViewportFrame` arrives, it just costs a message.
Nothing in your render code branches.

Under Node / `worker_threads`, `crossOriginIsolated` does not exist even though
shared memory works; pass `mode: 'shared'` (transport) or `preferShared: true`
(`ViewportBuffer.create`) there.

## Worker-pool budget controller

A grid is a component inside somebody else's application. `WorkerPool` caps how
much of the machine it takes, so a collaborative app's CRDT worker, call, and
main thread keep their share.

```ts
import { createWorkerPool } from '@onegrid/data-worker';

const pool = createWorkerPool({
  spawn: () => new Worker(new URL('./my-data-worker.ts', import.meta.url), {
    type: 'module',
  }),
  // Default: floor(navigator.hardwareConcurrency * 0.5), never all cores.
  maxUtilization: 0.5,
  idleTimeoutMs: 15_000,
  // Used when `Worker` is undefined (SSR, old WebView) — same API, in-thread.
  fallback: (fn, arg) => runSynchronously(fn, arg),
});

const controller = new AbortController();
const index = await pool.submit<Int32Array>({
  fn: 'sort',
  arg: [{ table, sort }],
  priority: 'high',
  signal: controller.signal,
});

pool.setBudget({ maxUtilization: 0.25 }); // a call started — give cores back
pool.observeMainThreadLatency(rafDelta); // let the pool see the starvation
pool.stat(); // { active, queued, completed, p95LatencyMs, concurrencyLimit, ... }
```

- **Half the cores, never all of them.** The main thread is a core; logical
  cores are half hyperthreads; and a component should not claim a budget the
  host app never agreed to. The cap is clamped to `hardwareConcurrency - 1`
  even at `maxUtilization: 1`.
- **Adaptive.** Rising p95 latency with a queue deeper than the current limit,
  or a main-thread latency report above budget, drops the effective limit by
  one. Recovery is one slot per healthy completion.
- **Lazy spawn and idle teardown.** Workers are created only when a task is
  waiting and every existing worker is busy, and terminated after
  `idleTimeoutMs` of inactivity.
- **Cancellation.** A queued task is dropped before it costs a slot; a running
  task rejects immediately and its worker is terminated (a `Worker` cannot be
  interrupted any other way).

## Bundler plumbing

We don't ship a pre-bundled `worker.js` because every build tool inlines
workers differently:

- **Vite**: `new Worker(new URL('./my-worker.ts', import.meta.url), { type: 'module' })`
- **webpack**: `worker-loader` or `new Worker(new URL(...), { type: 'module' })`
- **esbuild**: `--bundle` with a separate entry point

Re-exporting from `@onegrid/data-worker/worker` is enough — your bundler
inlines `@onegrid/data` into the worker bundle.

## License

MIT
