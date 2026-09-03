// =============================================================================
// Error boundary with per-cell isolation and a circuit breaker
//
// The failure this exists to stop: one broken cell renderer taking down the
// whole grid. Today `core/src/grid.ts` has roughly fifteen bare `catch {}`
// blocks that achieve non-fatality by achieving silence — the frame survives,
// nobody finds out, and a renderer that throws on every paint burns CPU
// forever. A boundary is the same non-fatality with the failure recorded, the
// offending cell marked, and a limit on how many times it is allowed to fail.
//
// Design decisions:
//
//   - Isolation is a SCOPE, not a boolean. A cell renderer that throws on one
//     malformed value should be isolated per cell; a renderer that throws
//     because the whole column's formatter is broken should trip once for the
//     column rather than accumulate a hundred thousand per-cell records. The
//     scope also decides the key, and the key is what the breaker counts.
//
//   - The breaker counts CONSECUTIVE failures. A success resets the count,
//     because a renderer that fails on one scroll position and works on the
//     next is not broken — it met bad data. Only sustained failure trips.
//
//   - Once tripped, the guarded function is NOT CALLED. This is the whole
//     point: a renderer that throws is still expensive, and calling it every
//     frame to discover it still throws is how a broken cell spins the frame
//     loop at 100% CPU. `skippedCount` records how often that happened.
//
//   - After `resetAfterMs` the breaker goes half-open and allows exactly one
//     probe. A transient failure (a device-lost GPU renderer, a datasource
//     blip) heals on its own; a genuinely broken renderer re-trips on the probe
//     and costs one call per interval rather than one per frame.
//
//   - Tracked keys are bounded (`maxTrackedKey`, default 5000) with
//     oldest-first eviction. Keys are derived from row indices; an unbounded
//     map keyed by row index in a 100-million-row grid is a memory leak with
//     extra steps.
//
//   - `fallback` returns a VALUE rather than throwing, so a cell renderer's
//     guarded form has the same signature as the unguarded one and the grid
//     paints an error state instead of a hole. `failureAt(cell)` is what a
//     renderer reads to decide what that error state says.
// =============================================================================

import {
  toGridError,
  type ErrorContext,
  type ErrorSubsystem,
  type GridError,
} from './error';
import { createNoopLogger, type Logger } from './logger';
import type { MetricRegistry } from './metric';

/** Row / column identity, spelled the way the rest of the repo spells it. @public */
export interface CellRef {
  readonly rowIndex: number;
  readonly columnId: string;
}

/**
 * How widely a single failure is contained. Also selects the breaker key, so
 * `'column'` means all cells in a column share one failure budget.
 * @public
 */
export type IsolationScope = 'cell' | 'row' | 'column' | 'subsystem' | 'global';

/** The breaker's three states, named as the pattern names them. @public */
export type CircuitState = 'closed' | 'open' | 'half-open';

/** @public */
export interface BoundaryFailure {
  /** Breaker key, derived from the isolation scope. */
  readonly key: string;
  /** The most recent failure at this key, already normalised and annotated. */
  readonly error: GridError;
  /** Consecutive failures. Reset to 0 by a success. */
  readonly failureCount: number;
  /** Calls short-circuited because the breaker was open. */
  readonly skippedCount: number;
  readonly firstTs: number;
  readonly lastTs: number;
  readonly state: CircuitState;
  readonly rowIndex: number | undefined;
  readonly columnId: string | undefined;
}

/** @public */
export interface ErrorBoundaryOption<TFallback = undefined> {
  /**
   * Called once per real failure — never for a call short-circuited by an open
   * breaker, so an alerting hook cannot be spammed by a permanently broken
   * cell. This is the `onError(err, context)` the roadmap asks for; the context
   * is the `BoundaryFailure`.
   */
  readonly onError?: (error: GridError, failure: BoundaryFailure) => void;
  /**
   * Produces the value a guarded call returns when it fails or is skipped.
   * Without it the boundary returns `undefined` and the caller decides.
   */
  readonly fallback?: (error: GridError, failure: BoundaryFailure) => TFallback;
  /** Containment scope. Default `'cell'`. */
  readonly isolate?: IsolationScope;
  /** Consecutive failures before the breaker opens. Default 3. 0 disables it. */
  readonly failureThreshold?: number;
  /** Milliseconds before an open breaker allows a probe. Default 5000. 0 =
   *  never reopen without an explicit `reset`. */
  readonly resetAfterMs?: number;
  /** Max failure records retained. Default 5000, oldest evicted first. */
  readonly maxTrackedKey?: number;
  /** Subsystem attributed to untyped throws from inside this boundary.
   *  Default `'render'`. */
  readonly subsystem?: ErrorSubsystem;
  /** Failures are logged through this at `error` level (redacted). */
  readonly logger?: Logger;
  /** Counter names `onegrid.boundary.<subsystem>.{failure,skip,trip}` are
   *  incremented here when supplied. */
  readonly metric?: MetricRegistry;
  /** Injectable clock. Default `Date.now`. */
  readonly now?: () => number;
}

/** @public */
export interface ErrorBoundary<TFallback = undefined> {
  /** Run `body` under an explicit key. Returns the body's value, or the
   *  fallback when it throws or when the breaker is open. */
  readonly run: <T>(key: string, body: () => T) => T | TFallback;
  /** Run `body` for a cell. The key comes from the isolation scope, and the
   *  cell is attached to the recorded error's context. */
  readonly runCell: <T>(cell: CellRef, body: () => T) => T | TFallback;
  /** Async form. A rejected promise is a failure; the breaker treats it
   *  identically to a synchronous throw. */
  readonly runAsync: <T>(key: string, body: () => Promise<T>) => Promise<T | TFallback>;
  /** Wrap a function once and call it many times — the shape a cell renderer
   *  wants, since it keeps the renderer's own signature. */
  readonly guard: <A extends readonly unknown[], T>(
    keyOf: (...arg: A) => string,
    body: (...arg: A) => T,
  ) => (...arg: A) => T | TFallback;
  /** Wrap a cell renderer. The returned function has the renderer's signature
   *  and never throws. */
  readonly guardCellRenderer: <T>(
    render: (cell: CellRef) => T,
  ) => (cell: CellRef) => T | TFallback;
  readonly isTripped: (key: string) => boolean;
  readonly stateOf: (key: string) => CircuitState;
  readonly failureCount: (key: string) => number;
  readonly failure: (key: string) => BoundaryFailure | undefined;
  /** Failure record covering this cell under the current isolation scope.
   *  What a renderer calls to paint an error state in the right place. */
  readonly failureAt: (cell: CellRef) => BoundaryFailure | undefined;
  /** Every live failure record, newest last. Drives an error-summary panel. */
  readonly errorState: () => readonly BoundaryFailure[];
  /** Forget one key (closing its breaker), or all of them. */
  readonly reset: (key?: string) => void;
  readonly keyFor: (cell: CellRef) => string;
}

interface Entry {
  key: string;
  error: GridError;
  failureCount: number;
  skippedCount: number;
  firstTs: number;
  lastTs: number;
  open: boolean;
  rowIndex: number | undefined;
  columnId: string | undefined;
}

const GLOBAL_KEY = '*';

/**
 * Build a boundary. One boundary per subsystem is the intended shape: a render
 * boundary isolating per cell, a plugin boundary isolating per plugin id, a
 * data boundary isolating per block.
 * @public
 */
export function createErrorBoundary<TFallback = undefined>(
  option: ErrorBoundaryOption<TFallback> = {},
): ErrorBoundary<TFallback> {
  const isolate: IsolationScope = option.isolate ?? 'cell';
  const failureThreshold = option.failureThreshold ?? 3;
  const resetAfterMs = option.resetAfterMs ?? 5000;
  const maxTrackedKey = Math.max(1, option.maxTrackedKey ?? 5000);
  const subsystem: ErrorSubsystem = option.subsystem ?? 'render';
  const logger = option.logger ?? createNoopLogger();
  const metric = option.metric;
  const now = option.now ?? Date.now;

  const entry = new Map<string, Entry>();

  const keyFor = (cell: CellRef): string => {
    switch (isolate) {
      case 'cell':
        return `${cell.rowIndex}:${cell.columnId}`;
      case 'row':
        return `row:${cell.rowIndex}`;
      case 'column':
        return `col:${cell.columnId}`;
      case 'subsystem':
        return `sub:${subsystem}`;
      case 'global':
        return GLOBAL_KEY;
    }
  };

  const stateOf = (key: string): CircuitState => {
    const e = entry.get(key);
    if (!e || !e.open) return 'closed';
    // An open breaker that has waited out the cooldown is half-open: it will
    // allow exactly one probe, and that probe's outcome decides the next state.
    if (resetAfterMs > 0 && now() - e.lastTs >= resetAfterMs) return 'half-open';
    return 'open';
  };

  const toFailure = (e: Entry): BoundaryFailure => ({
    key: e.key,
    error: e.error,
    failureCount: e.failureCount,
    skippedCount: e.skippedCount,
    firstTs: e.firstTs,
    lastTs: e.lastTs,
    state: stateOf(e.key),
    rowIndex: e.rowIndex,
    columnId: e.columnId,
  });

  /** Oldest-first eviction. Map preserves insertion order, so the first key is
   *  the least recently CREATED — good enough, and O(1). */
  const evictIfNeeded = (): void => {
    while (entry.size > maxTrackedKey) {
      const oldest = entry.keys().next();
      if (oldest.done) return;
      entry.delete(oldest.value);
    }
  };

  const recordSuccess = (key: string): void => {
    const e = entry.get(key);
    if (!e) return;
    // A success closes the breaker and clears the record entirely: a cell that
    // renders is not in an error state, and leaving a stale record would keep
    // painting one.
    entry.delete(key);
  };

  const recordFailure = (
    key: string,
    raw: unknown,
    context: ErrorContext,
  ): { error: GridError; failure: BoundaryFailure } => {
    const ts = now();
    const error = toGridError(raw, { subsystem, context: { ...context, boundaryKey: key } });
    const previous = entry.get(key);
    const e: Entry = {
      key,
      error,
      failureCount: (previous?.failureCount ?? 0) + 1,
      skippedCount: previous?.skippedCount ?? 0,
      firstTs: previous?.firstTs ?? ts,
      lastTs: ts,
      open: false,
      rowIndex: typeof context.rowIndex === 'number' ? context.rowIndex : undefined,
      columnId: typeof context.columnId === 'string' ? context.columnId : undefined,
    };
    const wasOpen = previous?.open === true;
    e.open = failureThreshold > 0 && e.failureCount >= failureThreshold;
    entry.set(key, e);
    evictIfNeeded();

    const failure = toFailure(e);
    metric?.incCounter(`onegrid.boundary.${subsystem}.failure`);
    if (e.open && !wasOpen) metric?.incCounter(`onegrid.boundary.${subsystem}.trip`);
    logger.reportError(error, {
      boundaryKey: key,
      failureCount: e.failureCount,
      circuit: failure.state,
    });
    option.onError?.(error, failure);
    return { error, failure };
  };

  const fallbackOf = (error: GridError, failure: BoundaryFailure): TFallback =>
    option.fallback ? option.fallback(error, failure) : (undefined as TFallback);

  /** Shared short-circuit check. Returns the fallback wrapper when the call
   *  must not happen, or null when it may proceed. */
  const shortCircuit = (key: string): { value: TFallback } | null => {
    if (stateOf(key) !== 'open') return null;
    const e = entry.get(key);
    if (!e) return null;
    e.skippedCount++;
    metric?.incCounter(`onegrid.boundary.${subsystem}.skip`);
    return { value: fallbackOf(e.error, toFailure(e)) };
  };

  const boundary: ErrorBoundary<TFallback> = {
    keyFor,
    run(key, body) {
      const skip = shortCircuit(key);
      if (skip) return skip.value;
      try {
        const out = body();
        recordSuccess(key);
        return out;
      } catch (err) {
        const { error, failure } = recordFailure(key, err, {});
        return fallbackOf(error, failure);
      }
    },
    runCell(cell, body) {
      const key = keyFor(cell);
      const skip = shortCircuit(key);
      if (skip) return skip.value;
      try {
        const out = body();
        recordSuccess(key);
        return out;
      } catch (err) {
        const { error, failure } = recordFailure(key, err, {
          rowIndex: cell.rowIndex,
          columnId: cell.columnId,
        });
        return fallbackOf(error, failure);
      }
    },
    async runAsync(key, body) {
      const skip = shortCircuit(key);
      if (skip) return skip.value;
      try {
        const out = await body();
        recordSuccess(key);
        return out;
      } catch (err) {
        const { error, failure } = recordFailure(key, err, {});
        return fallbackOf(error, failure);
      }
    },
    guard(keyOf, body) {
      return (...arg) => boundary.run(keyOf(...arg), () => body(...arg));
    },
    guardCellRenderer(render) {
      return (cell) => boundary.runCell(cell, () => render(cell));
    },
    isTripped: (key) => stateOf(key) === 'open',
    stateOf,
    failureCount: (key) => entry.get(key)?.failureCount ?? 0,
    failure: (key) => {
      const e = entry.get(key);
      return e ? toFailure(e) : undefined;
    },
    failureAt: (cell) => {
      const e = entry.get(keyFor(cell));
      return e ? toFailure(e) : undefined;
    },
    errorState: () => [...entry.values()].map(toFailure),
    reset(key) {
      if (key === undefined) entry.clear();
      else entry.delete(key);
    },
  };
  return boundary;
}
