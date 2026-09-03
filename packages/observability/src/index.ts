// =============================================================================
// @onegrid/observability
//
// Error boundaries and observability for oneGrid. Five layers that compose, and
// each is usable on its own:
//
//   1. A TYPED ERROR TAXONOMY — `GridError` plus a subclass per subsystem that
//      actually fails in this repo, each carrying a stable machine-readable
//      `OG_*` code and a structured context bag. Codes are the contract; the
//      message text is not.
//   2. An ERROR BOUNDARY — `createErrorBoundary` wraps a subsystem call so one
//      failing cell renderer or one failing plugin cannot take the grid down,
//      with per-cell isolation and a circuit breaker that stops calling a
//      renderer that has thrown N times.
//   3. STRUCTURED LOGGING — level-filtered records with REDACTION ON BY
//      DEFAULT.
//   4. OTEL-SHAPED BREADCRUMBS — spans against the OpenTelemetry API shape with
//      no dependency on it, adapting a supplied tracer and no-oping without one.
//   5. PERFORMANCE COUNTERS — frame timing with exact windowed quantiles,
//      row-count and memory gauges, and `snapshotMetric()`.
//
// READ THIS BEFORE SHIPPING ERROR REPORTS OFF-DEVICE:
//
//   A grid holds customer data, and the most natural thing to attach to a "cell
//   renderer threw" report is the cell's value — which is precisely the thing
//   that must not leave the browser. Every logger built here therefore REDACTS
//   CELL VALUES BY DEFAULT. `value`, `oldValue`, `newValue`, `cellValue`,
//   `cell`, `row`, `rowData`, `datum`, `data` and `record` are replaced with
//   `'[redacted]'` at any depth, alongside the usual credential vocabulary
//   (`password`, `token`, `apiKey`, `authorization`, `cookie`, `email`, ...).
//   The full list is `DEFAULT_REDACTED_FIELD`. Turning a field back on is
//   explicit and per-logger via `redaction.allowField`; there is no global
//   switch, and redaction runs in the logger rather than in the sink so a
//   record is already clean by the time third-party transport code sees it.
//
// Zero runtime dependencies. Everything external — the tracer, the console, the
// clock, the log sink — is injected, which is also what makes the whole package
// testable without a browser.
// =============================================================================

export {
  GridError,
  RenderError,
  DataFetchError,
  FormulaEvalError,
  EditorError,
  AdapterError,
  WorkerError,
  PluginError,
  GpuError,
  GRID_ERROR_CODE,
  isGridError,
  toGridError,
  serializeGridError,
  deserializeGridError,
} from './error';
export type {
  ErrorSubsystem,
  ErrorContext,
  GridErrorCode,
  GridErrorOption,
  SerializedGridError,
  SerializedCause,
  RenderErrorCode,
  DataFetchErrorCode,
  FormulaEvalErrorCode,
  EditorErrorCode,
  AdapterErrorCode,
  WorkerErrorCode,
  PluginErrorCode,
  GpuErrorCode,
} from './error';

export {
  createErrorBoundary,
} from './boundary';
export type {
  CellRef,
  IsolationScope,
  CircuitState,
  BoundaryFailure,
  ErrorBoundary,
  ErrorBoundaryOption,
} from './boundary';

export {
  createLogger,
  createConsoleLogger,
  createMemoryLogger,
  createNoopLogger,
  createRedactor,
  DEFAULT_REDACTED_FIELD,
  LOG_LEVEL_VALUE,
} from './logger';
export type {
  LogLevel,
  LogField,
  LogRecord,
  LogSink,
  Logger,
  LoggerOption,
  MemoryLogger,
  ConsoleLike,
  Redactor,
  RedactionOption,
} from './logger';

export {
  adaptTracer,
  createNoopTracer,
  createMemoryTracer,
  GRID_OPERATION,
  SPAN_STATUS,
} from './trace';
export type {
  GridTracer,
  GridSpan,
  GridOperation,
  OtelLikeTracer,
  OtelLikeSpan,
  MemoryTracer,
  RecordedSpan,
  SpanAttribute,
  SpanAttributeValue,
  SpanStatusCode,
  TracerOption,
} from './trace';

export {
  createFrameRecorder,
  createMetricRegistry,
  GRID_GAUGE,
} from './metric';
export type {
  FrameRecorder,
  FrameRecorderOption,
  FrameStat,
  MetricRegistry,
  MetricRegistryOption,
  MetricSnapshot,
} from './metric';

export { toReactErrorBoundaryProp } from './react';
export type {
  ReactErrorBoundaryProp,
  ReactErrorBoundaryOption,
  ReactErrorInfo,
} from './react';
