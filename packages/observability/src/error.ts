// =============================================================================
// Typed error taxonomy
//
// Every failure the grid can surface gets a class, and every class carries a
// STABLE machine-readable `code`. The codes are the contract: adopters route
// on them, dashboards group on them, support tickets quote them. Message
// strings are for humans and may be reworded in a patch release; a code never
// changes without a major bump. `taxonomy.test.ts` locks the full set.
//
// Design decisions:
//
//   - Codes use the repo's established `OG_` screaming-snake vocabulary
//     (`OG_WORKER_TIMEOUT`, `OG_WEBGPU_UNAVAILABLE`, `OG_PLUGIN_INTERFACE_VERSION`,
//     ...). The difference is that those live inside the message string as a
//     `[OG_X] detail` prefix, which is unparseable by machines; here the code is
//     a real field. Where a code names an existing failure it reuses the exact
//     spelling, so grepping for `OG_WORKER_TIMEOUT` finds both the thrower in
//     `@onegrid/worker-plugins` and the classified error here.
//
//   - The subsystem list mirrors what actually fails in this repo rather than a
//     generic HTTP-ish list: render (a cell renderer throwing mid-frame — today
//     swallowed by ~15 bare `catch {}` blocks in `core/src/grid.ts`), data (an
//     SSRM block fetch rejecting — today `.catch(() => {})` in
//     `ssrm/src/row-source.ts`), formula, editor commit/validation, adapter
//     (SqliteQueryable / PgQueryable driver rejections), worker, plugin, and
//     gpu (WebGPU device loss, which `webgpu/src/device.ts` currently discards).
//
//   - The class is named `FormulaEvalError`, not `FormulaError`, because
//     `@onegrid/formula` already exports a `FormulaError` with entirely
//     different semantics (it is a spreadsheet VALUE — `#DIV/0!`, `#REF!` — that
//     is returned rather than thrown). Colliding on that name would be a trap.
//     Instead, a formula sentinel's code travels in `context.formulaCode`.
//
//   - `isGridError` is a BRAND check, not `instanceof`. Errors cross worker
//     postMessage boundaries and structured-clone strips the prototype; an
//     `instanceof` check would silently misclassify every error raised inside a
//     worker. The brand is a plain own property, so it survives the clone.
//
//   - Errors round-trip losslessly through `serializeGridError` /
//     `deserializeGridError`, matching the wire shape
//     `worker-plugins/src/protocol.ts` already uses for failed results.
//
//   - `retryable` lives on the base class because the circuit breaker and the
//     SSRM block scheduler both need to know whether re-running the operation
//     could plausibly succeed. Device loss is retryable (the browser
//     re-provisions a GPUDevice); a formula cycle is not (the input is wrong).
// =============================================================================

/**
 * The grid subsystem a failure originated in. Groups errors and decides which
 * boundary should absorb them.
 * @public
 */
export type ErrorSubsystem =
  | 'render'
  | 'data'
  | 'formula'
  | 'editor'
  | 'adapter'
  | 'worker'
  | 'plugin'
  | 'gpu'
  | 'unknown';

/** @public */
export type RenderErrorCode =
  | 'OG_RENDER_CELL'
  | 'OG_RENDER_HEADER'
  | 'OG_RENDER_FRAME'
  | 'OG_RENDER_NO_CONTEXT';

/** @public */
export type DataFetchErrorCode =
  | 'OG_DATA_BLOCK_FETCH'
  | 'OG_DATA_BLOCK_TIMEOUT'
  | 'OG_DATA_BLOCK_SHAPE'
  | 'OG_DATA_CURSOR_DECODE';

/** @public */
export type FormulaEvalErrorCode =
  | 'OG_FORMULA_EVAL'
  | 'OG_FORMULA_PARSE'
  | 'OG_FORMULA_CYCLE'
  | 'OG_FORMULA_SPILL';

/** @public */
export type EditorErrorCode =
  | 'OG_EDITOR_COMMIT'
  | 'OG_EDITOR_VALIDATION'
  | 'OG_EDITOR_PARSE';

/** @public */
export type AdapterErrorCode =
  | 'OG_ADAPTER_QUERY'
  | 'OG_ADAPTER_CONNECT'
  | 'OG_ADAPTER_UNSUPPORTED';

/** @public */
export type WorkerErrorCode =
  | 'OG_WORKER_CRASH'
  | 'OG_WORKER_TIMEOUT'
  | 'OG_WORKER_DISPOSED'
  | 'OG_WORKER_PROTOCOL';

/** @public */
export type PluginErrorCode =
  | 'OG_PLUGIN_HOOK'
  | 'OG_PLUGIN_LOAD'
  | 'OG_PLUGIN_INTERFACE_VERSION';

/** @public */
export type GpuErrorCode =
  | 'OG_GPU_DEVICE_LOST'
  | 'OG_WEBGPU_UNAVAILABLE'
  | 'OG_GPU_VALIDATION'
  | 'OG_GPU_OUT_OF_MEMORY';

/**
 * Every code the taxonomy can emit. `OG_UNKNOWN` is the landing pad for a
 * non-Error value thrown by adopter code — `throw 'nope'` happens.
 * @public
 */
export type GridErrorCode =
  | RenderErrorCode
  | DataFetchErrorCode
  | FormulaEvalErrorCode
  | EditorErrorCode
  | AdapterErrorCode
  | WorkerErrorCode
  | PluginErrorCode
  | GpuErrorCode
  | 'OG_UNKNOWN';

/**
 * The complete, frozen code vocabulary. Exported so an adopter can validate a
 * code arriving over the wire, and so the stability test can assert the set
 * has not silently changed.
 * @public
 */
export const GRID_ERROR_CODE: readonly GridErrorCode[] = Object.freeze([
  'OG_RENDER_CELL',
  'OG_RENDER_HEADER',
  'OG_RENDER_FRAME',
  'OG_RENDER_NO_CONTEXT',
  'OG_DATA_BLOCK_FETCH',
  'OG_DATA_BLOCK_TIMEOUT',
  'OG_DATA_BLOCK_SHAPE',
  'OG_DATA_CURSOR_DECODE',
  'OG_FORMULA_EVAL',
  'OG_FORMULA_PARSE',
  'OG_FORMULA_CYCLE',
  'OG_FORMULA_SPILL',
  'OG_EDITOR_COMMIT',
  'OG_EDITOR_VALIDATION',
  'OG_EDITOR_PARSE',
  'OG_ADAPTER_QUERY',
  'OG_ADAPTER_CONNECT',
  'OG_ADAPTER_UNSUPPORTED',
  'OG_WORKER_CRASH',
  'OG_WORKER_TIMEOUT',
  'OG_WORKER_DISPOSED',
  'OG_WORKER_PROTOCOL',
  'OG_PLUGIN_HOOK',
  'OG_PLUGIN_LOAD',
  'OG_PLUGIN_INTERFACE_VERSION',
  'OG_GPU_DEVICE_LOST',
  'OG_WEBGPU_UNAVAILABLE',
  'OG_GPU_VALIDATION',
  'OG_GPU_OUT_OF_MEMORY',
  'OG_UNKNOWN',
] as const);

/**
 * Structured context travelling with an error. The well-known keys are typed
 * because the boundary and the cell error-state renderer read them directly;
 * the index signature keeps the bag open for subsystem-specific detail
 * (`blockIndex`, `sql`, `pluginId`, `formulaCode`, ...).
 *
 * Row and column identity use `rowIndex` / `columnId` — the spelling the rest
 * of the repo uses (`RowSource.getCell(rowIndex, columnId)`,
 * `ValidationContext`, `SortField`).
 *
 * Anything placed here is subject to redaction before it reaches a log sink —
 * see `createRedactor`. Never assume a value put here stays readable.
 * @public
 */
export interface ErrorContext {
  readonly rowIndex?: number | undefined;
  readonly columnId?: string | undefined;
  /** The traced operation in flight, e.g. `'block.fetch'`. */
  readonly operation?: string | undefined;
  readonly [key: string]: unknown;
}

/** @public */
export interface GridErrorOption {
  readonly context?: ErrorContext;
  readonly cause?: unknown;
  /** Overrides the subclass default. Device loss is retryable; a cycle is not. */
  readonly retryable?: boolean;
  /** Injectable clock so tests get deterministic timestamps. */
  readonly now?: () => number;
}

/**
 * Wire form of a GridError. JSON- and structured-clone-safe, and a superset of
 * the `{ name, message, stack }` failure shape `worker-plugins` already posts.
 * @public
 */
export interface SerializedGridError {
  readonly name: string;
  readonly code: GridErrorCode;
  readonly subsystem: ErrorSubsystem;
  readonly message: string;
  readonly context: ErrorContext;
  readonly retryable: boolean;
  readonly ts: number;
  readonly stack?: string | undefined;
  readonly cause?: SerializedCause | undefined;
}

/** @public */
export interface SerializedCause {
  readonly name: string;
  readonly message: string;
  readonly stack?: string | undefined;
}

/** Brand key. Survives structured-clone and crosses realms; `instanceof` does not. */
const BRAND = '__onegridError';

/**
 * Base of the taxonomy. Rarely constructed directly — every real failure gets
 * one of the subclasses below — but adopters may extend it to add codes for
 * their own subsystems.
 * @public
 */
export class GridError extends Error {
  /** Stable machine-readable identifier. Route on this, never on `message`. */
  readonly code: GridErrorCode;
  readonly subsystem: ErrorSubsystem;
  readonly context: ErrorContext;
  /** True when re-running the failed operation could plausibly succeed. */
  readonly retryable: boolean;
  readonly ts: number;
  /** @internal */
  readonly [BRAND] = true as const;

  constructor(
    message: string,
    code: GridErrorCode,
    subsystem: ErrorSubsystem,
    option: GridErrorOption = {},
  ) {
    super(message, option.cause === undefined ? undefined : { cause: option.cause });
    this.name = new.target.name;
    this.code = code;
    this.subsystem = subsystem;
    this.context = option.context ?? {};
    this.retryable = option.retryable ?? false;
    this.ts = (option.now ?? Date.now)();
    // Subclassing a built-in through a down-levelled target breaks the
    // prototype chain; restoring it keeps `instanceof RenderError` honest for
    // same-realm consumers even though `isGridError` is the supported check.
    Object.setPrototypeOf(this, new.target.prototype);
  }

  /**
   * Returns a COPY carrying additional context. Errors stay immutable so a
   * boundary can annotate an error with the cell it failed in without mutating
   * the object the thrower still holds a reference to.
   */
  withContext(extra: ErrorContext): GridError {
    const next = new GridError(this.message, this.code, this.subsystem, {
      context: { ...this.context, ...extra },
      cause: (this as { cause?: unknown }).cause,
      retryable: this.retryable,
      now: () => this.ts,
    });
    next.name = this.name;
    if (this.stack !== undefined) next.stack = this.stack;
    return next;
  }

  toJSON(): SerializedGridError {
    return {
      name: this.name,
      code: this.code,
      subsystem: this.subsystem,
      message: this.message,
      context: this.context,
      retryable: this.retryable,
      ts: this.ts,
      stack: this.stack,
      cause: serializeCause((this as { cause?: unknown }).cause),
    };
  }
}

function serializeCause(cause: unknown): SerializedCause | undefined {
  if (cause === undefined || cause === null) return undefined;
  if (cause instanceof Error) {
    return { name: cause.name, message: cause.message, stack: cause.stack };
  }
  // An already-serialized cause passes through unchanged. Without this,
  // deserialize-then-reserialize would wrap the wire form in a second
  // `NonError` envelope and the round-trip would not be idempotent.
  if (isSerializedCause(cause)) return cause;
  return { name: 'NonError', message: safeStringify(cause), stack: undefined };
}

function isSerializedCause(value: unknown): value is SerializedCause {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate['name'] === 'string' && typeof candidate['message'] === 'string';
}

/**
 * A cell, header, or frame renderer threw while painting. Today
 * `core/src/grid.ts` swallows these in bare `catch {}` blocks; classifying them
 * is what lets the boundary paint an error state in the offending cell instead.
 * @public
 */
export class RenderError extends GridError {
  constructor(message: string, option: GridErrorOption & { readonly code?: RenderErrorCode } = {}) {
    const code = option.code ?? 'OG_RENDER_CELL';
    super(message, code, 'render', {
      ...option,
      // A renderer that threw once may succeed next frame on different data,
      // so retry is allowed by default. The circuit breaker — not this flag —
      // is what stops a permanently broken renderer. A missing 2D context is
      // the exception: that never fixes itself.
      retryable: option.retryable ?? code !== 'OG_RENDER_NO_CONTEXT',
    });
  }
}

/**
 * An SSRM block fetch rejected, timed out, or returned an unusable shape.
 * `context.blockIndex` / `context.startRow` identify the block, matching
 * `ssrm/src/row-source.ts`.
 * @public
 */
export class DataFetchError extends GridError {
  constructor(
    message: string,
    option: GridErrorOption & { readonly code?: DataFetchErrorCode } = {},
  ) {
    const code = option.code ?? 'OG_DATA_BLOCK_FETCH';
    super(message, code, 'data', {
      ...option,
      // A malformed response or an undecodable cursor is deterministic; the
      // network failures are not.
      retryable:
        option.retryable ?? (code !== 'OG_DATA_BLOCK_SHAPE' && code !== 'OG_DATA_CURSOR_DECODE'),
    });
  }
}

/**
 * Formula parse or evaluation failure. Distinct from `@onegrid/formula`'s
 * `FormulaError`, which is a spreadsheet VALUE (`#DIV/0!`) returned rather than
 * thrown; put that sentinel's code in `context.formulaCode` when escalating one
 * of them into a reportable error.
 * @public
 */
export class FormulaEvalError extends GridError {
  constructor(
    message: string,
    option: GridErrorOption & { readonly code?: FormulaEvalErrorCode } = {},
  ) {
    // Formula failures are deterministic in their inputs: re-running the same
    // expression over the same cells fails identically. Never retryable.
    super(message, option.code ?? 'OG_FORMULA_EVAL', 'formula', {
      ...option,
      retryable: option.retryable ?? false,
    });
  }
}

/**
 * A cell editor commit or validation rejected the user's input. Pair with
 * `core`'s `ValidationResult` — put its `severity` in `context.severity`.
 * @public
 */
export class EditorError extends GridError {
  constructor(message: string, option: GridErrorOption & { readonly code?: EditorErrorCode } = {}) {
    super(message, option.code ?? 'OG_EDITOR_COMMIT', 'editor', {
      ...option,
      retryable: option.retryable ?? false,
    });
  }
}

/**
 * A datasource adapter (`SqliteQueryable`, `PgQueryable`, HTTP transport)
 * failed to connect or to run a query.
 * @public
 */
export class AdapterError extends GridError {
  constructor(
    message: string,
    option: GridErrorOption & { readonly code?: AdapterErrorCode } = {},
  ) {
    const code = option.code ?? 'OG_ADAPTER_QUERY';
    super(message, code, 'adapter', {
      ...option,
      retryable: option.retryable ?? code !== 'OG_ADAPTER_UNSUPPORTED',
    });
  }
}

/**
 * A worker crashed, stopped answering, or broke the message protocol.
 * `OG_WORKER_TIMEOUT` and `OG_WORKER_DISPOSED` are the exact codes
 * `@onegrid/worker-plugins` already embeds in its message strings.
 * @public
 */
export class WorkerError extends GridError {
  constructor(message: string, option: GridErrorOption & { readonly code?: WorkerErrorCode } = {}) {
    const code = option.code ?? 'OG_WORKER_CRASH';
    super(message, code, 'worker', {
      ...option,
      // A disposed host will never answer again; the rest are worth one retry.
      retryable: option.retryable ?? code !== 'OG_WORKER_DISPOSED',
    });
  }
}

/** A third-party plugin hook threw or violated its contract. @public */
export class PluginError extends GridError {
  constructor(message: string, option: GridErrorOption & { readonly code?: PluginErrorCode } = {}) {
    super(message, option.code ?? 'OG_PLUGIN_HOOK', 'plugin', {
      ...option,
      retryable: option.retryable ?? false,
    });
  }
}

/**
 * WebGPU failure. Device loss is the important one: the browser can revoke a
 * `GPUDevice` at any moment (driver reset, backgrounded tab, OOM) with no user
 * action. `webgpu/src/device.ts` currently drops the `GPUDeviceLostInfo` on the
 * floor; route it here with `context.reason` so the adopter can fall back to
 * the canvas renderer and re-acquire.
 * @public
 */
export class GpuError extends GridError {
  constructor(message: string, option: GridErrorOption & { readonly code?: GpuErrorCode } = {}) {
    const code = option.code ?? 'OG_GPU_DEVICE_LOST';
    super(message, code, 'gpu', {
      ...option,
      // Device loss re-provisions. No adapter at all, a validation bug, or OOM
      // will not fix itself on retry.
      retryable: option.retryable ?? code === 'OG_GPU_DEVICE_LOST',
    });
  }
}

type GridErrorClass = new (message: string, option: GridErrorOption) => GridError;

/**
 * Subsystem to constructor. Deserialization dispatches on the subsystem so an
 * error crossing a worker boundary rehydrates into its real subclass.
 */
const SUBSYSTEM_CLASS: Record<ErrorSubsystem, GridErrorClass | null> = {
  render: RenderError,
  data: DataFetchError,
  formula: FormulaEvalError,
  editor: EditorError,
  adapter: AdapterError,
  worker: WorkerError,
  plugin: PluginError,
  gpu: GpuError,
  unknown: null,
};

/**
 * Brand check. Prefer this to `instanceof GridError`: it stays true for an
 * error that crossed a structured-clone boundary and lost its prototype, and
 * it is true across realms (iframe, worker).
 * @public
 */
export function isGridError(value: unknown): value is GridError {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<string, unknown>)[BRAND] === true
  );
}

/**
 * Normalise anything a `catch` can hand you into a GridError. Adopter code
 * throws strings, DOMExceptions, and rejected promises carrying plain objects;
 * everything downstream of a boundary is entitled to assume a GridError.
 * Already-typed errors pass through with the supplied context merged in, so
 * wrapping is idempotent and never loses the original classification.
 * @public
 */
export function toGridError(
  value: unknown,
  option: { readonly subsystem?: ErrorSubsystem; readonly context?: ErrorContext } = {},
): GridError {
  if (isGridError(value)) {
    return option.context ? value.withContext(option.context) : value;
  }
  const subsystem = option.subsystem ?? 'unknown';
  const Ctor = SUBSYSTEM_CLASS[subsystem];
  const message =
    value instanceof Error
      ? value.message
      : typeof value === 'string'
        ? value
        : safeStringify(value);
  const inner: GridErrorOption = { cause: value, context: option.context ?? {} };
  const err = Ctor
    ? new Ctor(message, inner)
    : new GridError(message, 'OG_UNKNOWN', 'unknown', inner);
  // Keep the original throw site. A fresh stack would point at this function,
  // which is useless for debugging the thing that actually broke.
  if (value instanceof Error && value.stack !== undefined) err.stack = value.stack;
  return err;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    // Cyclic or a BigInt. String() still tells us something.
    return String(value);
  }
}

/**
 * Explicit serializer. Equivalent to `error.toJSON()`, exported so a worker can
 * serialize without relying on the method surviving whatever proxy the error
 * passed through.
 * @public
 */
export function serializeGridError(error: GridError): SerializedGridError {
  return error.toJSON();
}

/**
 * Rebuild a GridError from its wire form. The subsystem selects the subclass,
 * so `deserializeGridError(serializeGridError(e))` round-trips name, code,
 * subsystem, context, retryability, timestamp and stack.
 * @public
 */
export function deserializeGridError(wire: SerializedGridError): GridError {
  const Ctor = SUBSYSTEM_CLASS[wire.subsystem];
  const option: GridErrorOption = {
    context: wire.context,
    retryable: wire.retryable,
    now: () => wire.ts,
    ...(wire.cause ? { cause: wire.cause } : {}),
  };
  const err = Ctor
    ? new Ctor(wire.message, option)
    : new GridError(wire.message, wire.code, wire.subsystem, option);
  // A subclass default code is only a default; the wire value always wins, so
  // an unusual code survives the trip instead of being normalised away.
  (err as { code: GridErrorCode }).code = wire.code;
  err.name = wire.name;
  if (wire.stack !== undefined) err.stack = wire.stack;
  return err;
}
