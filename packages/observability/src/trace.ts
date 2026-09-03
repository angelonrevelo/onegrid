// =============================================================================
// OpenTelemetry-shaped breadcrumbs, without an OpenTelemetry dependency
//
// oneGrid is a library. Pulling `@opentelemetry/api` into it would force the
// dependency on every adopter, including the ones who ship the grid into a
// bundle-size-sensitive page and have no tracing backend at all. So this module
// declares the MINIMAL structural slice of the OTel API it uses — `startSpan`
// on a tracer; `setAttribute`, `addEvent`, `recordException`, `setStatus` and
// `end` on a span — and adapts whatever the adopter hands it.
//
// Design decisions:
//
//   - The interfaces are structural and deliberately narrower than OTel's. A
//     real `@opentelemetry/api` Tracer is assignable to `OtelLikeTracer`
//     because its extra parameters are optional and its Span has a superset of
//     methods, so `adaptTracer(otelApi.trace.getTracer('onegrid'))` type-checks
//     with no cast. Nothing here imports OTel, and nothing forces it.
//
//   - `setStatus` takes a NUMERIC code because that is what OTel's
//     `SpanStatusCode` enum is (UNSET 0, OK 1, ERROR 2). Using a string union
//     would look nicer and would not be assignable to the real thing.
//
//   - With no tracer the whole layer collapses to a no-op object allocated
//     once. `startSpan` on the no-op tracer returns a shared frozen span, so
//     instrumenting the render frame costs nothing when tracing is off — which
//     is the default and the common case.
//
//   - The instrumented operation list is closed (`GRID_OPERATION`) rather than
//     free-form. Span names are cardinality-sensitive in every tracing backend;
//     a free string invites `block.fetch:0`, `block.fetch:1`, ... and an
//     unusable dashboard. Per-block identity goes in an ATTRIBUTE.
//
//   - `traceSync` and `traceAsync` both record the exception and set the ERROR
//     status before rethrowing, and both end the span in a `finally`. An
//     unended span is a leak in every backend.
// =============================================================================

import { toGridError, type ErrorSubsystem, type GridError } from './error';

/** Attribute values OTel accepts. Deliberately matches their `AttributeValue`. @public */
export type SpanAttributeValue =
  | string
  | number
  | boolean
  | readonly string[]
  | readonly number[]
  | readonly boolean[];

/** @public */
export type SpanAttribute = Readonly<Record<string, SpanAttributeValue | undefined>>;

/**
 * OTel `SpanStatusCode`. Numeric so a real OTel span's `setStatus` accepts it
 * unchanged.
 * @public
 */
export const SPAN_STATUS = Object.freeze({
  UNSET: 0,
  OK: 1,
  ERROR: 2,
} as const);

/** @public */
export type SpanStatusCode = (typeof SPAN_STATUS)[keyof typeof SPAN_STATUS];

/**
 * The slice of an OTel Span this package calls. A real
 * `@opentelemetry/api` Span satisfies this structurally.
 * @public
 */
export interface OtelLikeSpan {
  setAttribute(key: string, value: SpanAttributeValue): unknown;
  addEvent(name: string, attribute?: SpanAttribute): unknown;
  recordException(exception: Error): unknown;
  setStatus(status: { code: SpanStatusCode; message?: string }): unknown;
  end(): void;
}

/**
 * The slice of an OTel Tracer this package calls. `@opentelemetry/api`'s
 * `Tracer.startSpan(name, options?, context?)` is assignable here: the extra
 * parameters are optional, and its Span is a superset of `OtelLikeSpan`.
 * @public
 */
export interface OtelLikeTracer {
  startSpan(name: string, option?: { attributes?: SpanAttribute }): OtelLikeSpan;
}

/**
 * Operations worth a span. Closed on purpose — span names must stay
 * low-cardinality. `sort`, `filter`, `group` and `pivot` are the exact function
 * names `@onegrid/data-worker` invokes on its worker host.
 * @public
 */
export const GRID_OPERATION = Object.freeze([
  'block.fetch',
  'sort',
  'filter',
  'group',
  'pivot',
  'formula.recompute',
  'render.frame',
] as const);

/** @public */
export type GridOperation = (typeof GRID_OPERATION)[number];

/** Which subsystem's errors a failing operation should be classified under. */
const OPERATION_SUBSYSTEM: Readonly<Record<GridOperation, ErrorSubsystem>> = Object.freeze({
  'block.fetch': 'data',
  sort: 'worker',
  filter: 'worker',
  group: 'worker',
  pivot: 'worker',
  'formula.recompute': 'formula',
  'render.frame': 'render',
});

/** The span handle this package hands back. @public */
export interface GridSpan {
  readonly name: string;
  readonly setAttribute: (key: string, value: SpanAttributeValue) => GridSpan;
  /** Breadcrumb inside the span — "block cache miss", "worker dispatched". */
  readonly addEvent: (name: string, attribute?: SpanAttribute) => GridSpan;
  /** Records the exception AND sets ERROR status; the two always go together. */
  readonly recordError: (error: unknown) => GridSpan;
  readonly setStatus: (code: SpanStatusCode, message?: string) => GridSpan;
  readonly end: () => void;
  /** False for the no-op span, so callers can skip building attributes. */
  readonly isRecording: boolean;
}

/** @public */
export interface GridTracer {
  /** Start a span for one of the known operations. */
  readonly startSpan: (operation: GridOperation, attribute?: SpanAttribute) => GridSpan;
  /** Run `body` in a span; records + rethrows on throw, always ends the span. */
  readonly traceSync: <T>(operation: GridOperation, body: (span: GridSpan) => T, attribute?: SpanAttribute) => T;
  /** Async form. The span ends when the promise settles, not when it is created. */
  readonly traceAsync: <T>(
    operation: GridOperation,
    body: (span: GridSpan) => Promise<T>,
    attribute?: SpanAttribute,
  ) => Promise<T>;
  readonly isRecording: boolean;
}

const NOOP_SPAN: GridSpan = Object.freeze({
  name: 'noop',
  setAttribute: () => NOOP_SPAN,
  addEvent: () => NOOP_SPAN,
  recordError: () => NOOP_SPAN,
  setStatus: () => NOOP_SPAN,
  end: () => undefined,
  isRecording: false,
});

/**
 * Tracer used when the adopter supplies none. Allocation-free: every call
 * returns the same frozen span, so instrumenting the frame loop is safe to
 * leave in production with tracing off.
 * @public
 */
export function createNoopTracer(): GridTracer {
  const tracer: GridTracer = {
    startSpan: () => NOOP_SPAN,
    traceSync: (_operation, body) => body(NOOP_SPAN),
    traceAsync: (_operation, body) => body(NOOP_SPAN),
    isRecording: false,
  };
  return tracer;
}

/** @public */
export interface TracerOption {
  /** Prefixed onto every span name. Default `'onegrid.'`. */
  readonly namePrefix?: string;
  /** Attributes stamped on every span (grid id, dataset name, build sha). */
  readonly baseAttribute?: SpanAttribute;
}

/**
 * Wrap a real OTel tracer. Undefined in, no-op out — so a call site can pass
 * `adaptTracer(option.tracer)` unconditionally and never branch on presence.
 * @public
 */
export function adaptTracer(
  tracer: OtelLikeTracer | undefined | null,
  option: TracerOption = {},
): GridTracer {
  if (!tracer) return createNoopTracer();
  const prefix = option.namePrefix ?? 'onegrid.';
  const baseAttribute = option.baseAttribute;

  const start = (operation: GridOperation, attribute?: SpanAttribute): GridSpan => {
    const name = `${prefix}${operation}`;
    const merged: SpanAttribute = { ...baseAttribute, ...attribute, 'onegrid.operation': operation };
    const raw = tracer.startSpan(name, { attributes: stripUndefined(merged) });
    return wrapSpan(name, raw, operation);
  };

  return {
    startSpan: start,
    isRecording: true,
    traceSync(operation, body, attribute) {
      const span = start(operation, attribute);
      try {
        const out = body(span);
        span.setStatus(SPAN_STATUS.OK);
        return out;
      } catch (err) {
        span.recordError(err);
        throw err;
      } finally {
        span.end();
      }
    },
    async traceAsync(operation, body, attribute) {
      const span = start(operation, attribute);
      try {
        const out = await body(span);
        span.setStatus(SPAN_STATUS.OK);
        return out;
      } catch (err) {
        span.recordError(err);
        throw err;
      } finally {
        span.end();
      }
    },
  };
}

function wrapSpan(name: string, raw: OtelLikeSpan, operation: GridOperation): GridSpan {
  const span: GridSpan = {
    name,
    isRecording: true,
    setAttribute(key, value) {
      raw.setAttribute(key, value);
      return span;
    },
    addEvent(eventName, attribute) {
      raw.addEvent(eventName, attribute ? stripUndefined(attribute) : undefined);
      return span;
    },
    recordError(error) {
      // Normalising here means the span carries the taxonomy code as an
      // attribute, which is what makes a trace searchable by failure mode.
      const typed: GridError = toGridError(error, { subsystem: OPERATION_SUBSYSTEM[operation] });
      raw.setAttribute('onegrid.error.code', typed.code);
      raw.setAttribute('onegrid.error.subsystem', typed.subsystem);
      raw.setAttribute('onegrid.error.retryable', typed.retryable);
      raw.recordException(typed);
      raw.setStatus({ code: SPAN_STATUS.ERROR, message: typed.message });
      return span;
    },
    setStatus(code, message) {
      raw.setStatus(message === undefined ? { code } : { code, message });
      return span;
    },
    end() {
      raw.end();
    },
  };
  return span;
}

/** OTel rejects undefined attribute values; drop them rather than send them. */
function stripUndefined(attribute: SpanAttribute): Record<string, SpanAttributeValue> {
  const out: Record<string, SpanAttributeValue> = {};
  for (const [key, value] of Object.entries(attribute)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * Minimal in-memory tracer used by tests and by adopters who want breadcrumbs
 * without a backend. Records the full span tree so an assertion can check that
 * a block fetch produced a span with the right attributes.
 * @public
 */
export interface RecordedSpan {
  readonly name: string;
  readonly attribute: Record<string, SpanAttributeValue>;
  readonly event: { readonly name: string; readonly attribute?: SpanAttribute }[];
  readonly exception: Error[];
  status: { code: SpanStatusCode; message?: string | undefined };
  ended: boolean;
}

/** @public */
export interface MemoryTracer extends OtelLikeTracer {
  readonly span: readonly RecordedSpan[];
  readonly clear: () => void;
}

/**
 * A tracer that records into an array. Doubles as the reference implementation
 * of `OtelLikeTracer` — if this satisfies the interface, so does the real one.
 * @public
 */
export function createMemoryTracer(): MemoryTracer {
  const span: RecordedSpan[] = [];
  return {
    span,
    clear: () => {
      span.length = 0;
    },
    startSpan(name, option) {
      const recorded: RecordedSpan = {
        name,
        attribute: { ...(option?.attributes as Record<string, SpanAttributeValue> | undefined) },
        event: [],
        exception: [],
        status: { code: SPAN_STATUS.UNSET },
        ended: false,
      };
      span.push(recorded);
      return {
        setAttribute(key, value) {
          recorded.attribute[key] = value;
        },
        addEvent(eventName, attribute) {
          recorded.event.push(attribute ? { name: eventName, attribute } : { name: eventName });
        },
        recordException(exception) {
          recorded.exception.push(exception);
        },
        setStatus(status) {
          recorded.status = status;
        },
        end() {
          recorded.ended = true;
        },
      };
    },
  };
}
