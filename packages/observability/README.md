# @onegrid/observability

Error boundaries and observability for oneGrid.

A grid that is fast is not the same as a grid that is trustworthy. This package
is the difference: when a cell renderer throws, a block fetch times out, a plugin
hook misbehaves or the browser revokes the GPU device, something has to catch it,
classify it, contain it, and tell you — without shipping your customers' data to
your error tracker on the way.

Zero runtime dependencies. The tracer, the console, the clock and the log sink
are all injected, which is also why the whole package tests without a browser.

## Why it exists

`@onegrid/core` currently achieves non-fatality by achieving silence: roughly
fifteen bare `catch {}` blocks in `grid.ts`, and a `.catch(() => {})` on the SSRM
block fetch in `ssrm/src/row-source.ts`. The frame survives, nobody finds out,
and a renderer that throws on every paint burns CPU forever. This package is the
same non-fatality with the failure recorded, the offending cell marked, and a
limit on how many times it is allowed to fail.

## Redaction is on by default — read this before shipping error reports

A grid holds customer data. The most natural thing to attach to a "cell renderer
threw" report is the cell's value, which is precisely the thing that must not
leave the browser. **Every logger built here redacts cell values by default.**

`value`, `oldValue`, `newValue`, `cellValue`, `cell`, `row`, `rowData`, `datum`,
`data` and `record` are replaced with `'[redacted]'` at any depth, alongside the
usual credential vocabulary (`password`, `token`, `apiKey`, `authorization`,
`cookie`, `email`, `phone`, `ssn`, ...). The full list is `DEFAULT_REDACTED_FIELD`.

Turning a field back on is explicit and per-logger:

```ts
createConsoleLogger({ redaction: { allowField: ['value'] } });
```

There is no global switch. Redaction runs inside the logger rather than in the
sink, so a `LogRecord` is already clean by the time third-party transport code
sees it.

## Install

```sh
pnpm add @onegrid/observability
```

## Typed error taxonomy

`GridError` carries a stable machine-readable `code`, the `subsystem` it came
from, a structured `context` bag, and whether the operation is worth retrying.
The codes are the contract; message text is not.

| Class | Subsystem | Default code |
| --- | --- | --- |
| `RenderError` | `render` | `OG_RENDER_CELL` |
| `DataFetchError` | `data` | `OG_DATA_BLOCK_FETCH` |
| `FormulaEvalError` | `formula` | `OG_FORMULA_EVAL` |
| `EditorError` | `editor` | `OG_EDITOR_COMMIT` |
| `AdapterError` | `adapter` | `OG_ADAPTER_QUERY` |
| `WorkerError` | `worker` | `OG_WORKER_CRASH` |
| `PluginError` | `plugin` | `OG_PLUGIN_HOOK` |
| `GpuError` | `gpu` | `OG_GPU_DEVICE_LOST` |

The class is `FormulaEvalError`, not `FormulaError`, because `@onegrid/formula`
already exports a `FormulaError` that is a spreadsheet *value* (`#DIV/0!`) rather
than a thrown failure. Put that sentinel's code in `context.formulaCode`.

```ts
import {
  DataFetchError,
  isGridError,
  serializeGridError,
  deserializeGridError,
} from '@onegrid/observability';

const error = new DataFetchError('block 7 timed out', {
  code: 'OG_DATA_BLOCK_TIMEOUT',
  context: { blockIndex: 7, startRow: 700, operation: 'block.fetch' },
});

error.retryable; // true — a timeout is worth another go
```

`isGridError` is a brand check rather than `instanceof`, so it stays true for an
error that crossed a worker `postMessage` boundary and lost its prototype.
`serializeGridError` / `deserializeGridError` round-trip that same error back into
its real subclass on the other side.

## Error boundary with per-cell isolation and a circuit breaker

```ts
import { createErrorBoundary, createConsoleLogger } from '@onegrid/observability';

const boundary = createErrorBoundary<string>({
  isolate: 'cell',        // 'cell' | 'row' | 'column' | 'subsystem' | 'global'
  failureThreshold: 3,    // consecutive failures before the breaker opens
  resetAfterMs: 5000,     // then one probe is allowed through
  logger: createConsoleLogger(),
  fallback: () => '#ERR', // painted in the cell instead of crashing the frame
  onError: (error, failure) => report(error.code, failure.key),
});

const safeFormat = boundary.guardCellRenderer(({ rowIndex, columnId }) =>
  format(source.getCell(rowIndex, columnId)),
);

// In the paint loop — never throws, and stops calling a renderer that is broken.
const text = safeFormat({ rowIndex, columnId });

// While painting, ask whether this cell is in an error state.
const failure = boundary.failureAt({ rowIndex, columnId });
if (failure) paintErrorBadge(failure.error.code);
```

Once a key has failed `failureThreshold` times in a row the guarded function is
**not called at all** — that is the point, since calling a broken renderer every
frame to rediscover that it is broken is how one bad cell spins the frame loop.
A success resets the count; `resetAfterMs` later the breaker goes half-open and
allows exactly one probe. `boundary.errorState()` drives an error-summary panel.

Async works identically — a rejected promise is a failure:

```ts
const block = await boundary.runAsync(`block:${blockIndex}`, () => fetchBlock(request));
```

## Structured logging

```ts
import { createMemoryLogger } from '@onegrid/observability';

const logger = createMemoryLogger({ level: 'debug' });
logger.child({ blockIndex: 7 }).warn('block refetch', { attempt: 2 });
logger.reportError(error, { source: 'row-source' });

logger.isAbsent('ada@example.com'); // true — nothing leaked
```

`createLogger(sink, option)` is the primitive; `createConsoleLogger`,
`createMemoryLogger` (for tests) and `createNoopLogger` are built on it.

## OpenTelemetry breadcrumbs

This package never imports `@opentelemetry/api`. It declares the minimal
structural slice it calls, so a real OTel tracer is assignable with no cast, and
no tracer at all collapses to an allocation-free no-op.

```ts
import { trace } from '@opentelemetry/api';
import { adaptTracer } from '@onegrid/observability';

const tracer = adaptTracer(trace.getTracer('onegrid'), {
  baseAttribute: { 'grid.id': 'orders' },
});

const block = await tracer.traceAsync(
  'block.fetch',
  (span) => {
    span.addEvent('cache.miss');
    return fetchBlock(request);
  },
  { 'onegrid.block.index': 7 },
);
```

Traceable operations are a closed set — `block.fetch`, `sort`, `filter`, `group`,
`pivot`, `formula.recompute`, `render.frame` — because span names are
cardinality-sensitive in every backend. Per-block identity goes in an attribute.
A throw is recorded with its taxonomy code as a span attribute, the span status
is set to `ERROR`, the span is ended, and the error is rethrown.

`adaptTracer(undefined)` returns the no-op tracer, so call sites never branch.

## Performance counters

```ts
import { createMetricRegistry, GRID_GAUGE } from '@onegrid/observability';

const metric = createMetricRegistry({ budgetMs: 1000 / 60 });

const endFrame = metric.frame.beginFrame();
paint();
endFrame();

metric.setGauge(GRID_GAUGE.ROW_COUNT, source.totalRowCount);
metric.incCounter('onegrid.block.fetch');
metric.sampleMemory(); // false where performance.memory is unavailable

const snapshot = metric.snapshotMetric();
snapshot.frame.p99Ms;       // exact, over the retained window
snapshot.frame.droppedCount; // frames that overran the budget
```

Quantiles come from a bounded reservoir — a fixed-capacity ring of the most
recent N frame durations, default 1024 (~17s at 60fps) — sorted only on
snapshot. Unbounded history grows without limit in a grid left open all day, and
a P-squared estimator would be O(1) but only approximate; an exact p99 over the
recent window is both bounded and actionable. Nearest-rank means the reported p99
is a frame that really happened.

## React

No React dependency — the helper returns a prop bag matching the shape
`react-error-boundary` accepts.

```tsx
import { ErrorBoundary } from 'react-error-boundary';
import { toReactErrorBoundaryProp, createConsoleLogger } from '@onegrid/observability';

const prop = toReactErrorBoundaryProp({
  logger: createConsoleLogger(),
  onError: (error) => report(error.code),
  onReset: () => boundary.reset(),
});

<ErrorBoundary {...prop} fallbackRender={({ error }) => <GridCrashed error={error} />}>
  <Grid />
</ErrorBoundary>;
```

For a hand-rolled class boundary, call `prop.onError(error, info)` from
`componentDidCatch` and `prop.onReset()` from whatever clears your state.

## License

MIT
