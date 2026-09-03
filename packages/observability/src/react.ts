// =============================================================================
// React error-boundary integration — types only, no React dependency
//
// React's error boundary is a class component, and the community standard for
// using one declaratively is `react-error-boundary`'s `<ErrorBoundary>` with
// `onError` / `onReset` props. Neither React nor that package is a dependency
// here: this module declares the STRUCTURAL shape of those props and produces
// an object that satisfies them, so the adopter spreads it onto their boundary
// and the grid's taxonomy, logger and metrics get wired in without this package
// ever importing React.
//
// Design decisions:
//
//   - The returned object is a prop BAG, not a component. Rendering the
//     fallback is the host application's job — it owns the design system — and
//     a component here would drag in JSX, a React peer range, and a build step
//     this package does not otherwise need.
//
//   - `componentStack` goes into the error context rather than the message.
//     It is long, it is noisy in an alert title, and it is exactly what you
//     want available structurally when you open the record.
//
//   - React calls `onError` for a render throw anywhere in the subtree, so
//     failures arriving here are classified as `render` unless they are already
//     typed. A `DataFetchError` thrown from a suspended fetch keeps its own
//     classification, because `toGridError` is idempotent.
// =============================================================================

import { toGridError, type ErrorContext, type ErrorSubsystem, type GridError } from './error';
import type { Logger } from './logger';
import type { MetricRegistry } from './metric';

/**
 * React's `ErrorInfo`. Declared structurally so React's own type is assignable
 * without importing it.
 * @public
 */
export interface ReactErrorInfo {
  readonly componentStack?: string | null | undefined;
}

/**
 * The props `react-error-boundary`'s `<ErrorBoundary>` accepts, and equally the
 * hooks a hand-rolled class boundary calls from `componentDidCatch`.
 * @public
 */
export interface ReactErrorBoundaryProp {
  readonly onError: (error: Error, info: ReactErrorInfo) => void;
  readonly onReset: () => void;
}

/** @public */
export interface ReactErrorBoundaryOption {
  /** Receives the classified error. The adopter's alerting hook. */
  readonly onError?: (error: GridError, info: ReactErrorInfo) => void;
  /** Called when React remounts the subtree — clear per-cell error state here. */
  readonly onReset?: () => void;
  /** Failures are reported through this logger, redacted. */
  readonly logger?: Logger;
  /** Increments `onegrid.react.boundary.failure`. */
  readonly metric?: MetricRegistry;
  /** Classification for untyped throws. Default `'render'`. */
  readonly subsystem?: ErrorSubsystem;
  /** Merged into every classified error's context. */
  readonly context?: ErrorContext;
}

/**
 * Build the prop bag.
 *
 * ```tsx
 * import { ErrorBoundary } from 'react-error-boundary';
 * import { toReactErrorBoundaryProp, createConsoleLogger } from '@onegrid/observability';
 *
 * const prop = toReactErrorBoundaryProp({ logger: createConsoleLogger() });
 *
 * <ErrorBoundary {...prop} fallbackRender={({ error }) => <GridCrashed error={error} />}>
 *   <Grid />
 * </ErrorBoundary>
 * ```
 *
 * For a hand-rolled class boundary, call `prop.onError(error, info)` from
 * `componentDidCatch` and `prop.onReset()` from whatever clears your state.
 * @public
 */
export function toReactErrorBoundaryProp(
  option: ReactErrorBoundaryOption = {},
): ReactErrorBoundaryProp {
  const subsystem = option.subsystem ?? 'render';
  return {
    onError(error, info) {
      const typed = toGridError(error, {
        subsystem,
        context: {
          ...option.context,
          reactComponentStack: info.componentStack ?? undefined,
        },
      });
      option.metric?.incCounter('onegrid.react.boundary.failure');
      option.logger?.reportError(typed, { source: 'react-error-boundary' });
      option.onError?.(typed, info);
    },
    onReset() {
      option.metric?.incCounter('onegrid.react.boundary.reset');
      option.logger?.info('react error boundary reset');
      option.onReset?.();
    },
  };
}
