// =============================================================================
// @onegrid/embed — auto-resize reporting from the guest side.
//
// An iframe has no intrinsic content sizing: the host must be told how tall the
// document is or the block renders in a fixed box with its own scrollbar, which
// is exactly the thing that makes embedded content feel foreign in a document.
// So the guest measures itself and reports.
//
// Three decisions worth stating:
//
//   - ResizeObserver where available, a polling fallback where not. Observer is
//     precise and cheap; polling at a modest interval is the only thing that
//     works in older WebViews and in test environments that do not implement the
//     observer. The fallback compares against the last reported height, so a
//     static block costs one measurement per tick and zero messages.
//   - Debounced, trailing edge. A grid resize cascade fires the observer many
//     times in one frame; each message is a structured clone plus a host layout
//     pass. Coalescing to one message per quiet period is the difference between
//     a smooth resize and a janky one.
//   - A minimum delta before reporting. Sub-pixel and one-pixel jitter from
//     fractional layout would otherwise produce an endless resize loop between
//     host and guest — the host resizes the frame, that changes content height
//     by a pixel, which reports a resize. The threshold breaks the loop.
// =============================================================================

/**
 * The slice of `ResizeObserver` this module needs. Injectable so the polling
 * path and the observer path can both be exercised in a test.
 *
 * @public
 */
export interface ResizeObserverLike {
  observe(target: Element): void;
  disconnect(): void;
}

/**
 * Constructor shape for {@link ResizeObserverLike}.
 *
 * @public
 */
export type ResizeObserverFactory = (callback: () => void) => ResizeObserverLike;

/**
 * Options for {@link startAutoResize}.
 *
 * @public
 */
export interface AutoResizeOption {
  /** Element whose height is reported. Usually the grid's root. */
  readonly target: Element;
  /** Called with the measured height whenever it settles. */
  readonly report: (height: number) => void;
  /** Trailing-edge debounce window, ms. Default 100. */
  readonly debounceMs?: number;
  /** Minimum change, in px, before a report fires. Default 2. */
  readonly thresholdPx?: number;
  /** Poll interval for the fallback path, ms. Default 250. */
  readonly pollMs?: number;
  /**
   * Override the observer. Pass `null` to force the polling fallback — useful
   * for testing, and for hosts where the observer misreports inside a frame.
   */
  readonly observerFactory?: ResizeObserverFactory | null;
  /** Override measurement. Defaults to `scrollHeight` on the target. */
  readonly measure?: (target: Element) => number;
}

/**
 * A running auto-resize reporter.
 *
 * @public
 */
export interface AutoResizeHandle {
  /** Measure and report immediately, bypassing the debounce and threshold. */
  flush(): void;
  /** Last height reported, or -1 before the first report. */
  readonly lastHeight: number;
  /** Whether the ResizeObserver path is in use (false = polling fallback). */
  readonly usingObserver: boolean;
  stop(): void;
}

function defaultMeasure(target: Element): number {
  // scrollHeight rather than getBoundingClientRect().height: the latter reports
  // the CLIPPED box, so a grid taller than its container would report its own
  // container's height and never grow.
  return target.scrollHeight;
}

function resolveFactory(option: AutoResizeOption): ResizeObserverFactory | null {
  if (option.observerFactory !== undefined) return option.observerFactory;
  const Ctor = (globalThis as { ResizeObserver?: new (cb: () => void) => ResizeObserverLike })
    .ResizeObserver;
  if (typeof Ctor !== 'function') return null;
  return (callback) => new Ctor(callback);
}

/**
 * Start reporting the target's content height. Returns a handle; call `stop()`
 * when the block unmounts or the observer / interval leaks for the lifetime of
 * the document.
 *
 * @public
 */
export function startAutoResize(option: AutoResizeOption): AutoResizeHandle {
  const debounceMs = option.debounceMs ?? 100;
  const thresholdPx = option.thresholdPx ?? 2;
  const pollMs = option.pollMs ?? 250;
  const measure = option.measure ?? defaultMeasure;

  let lastHeight = -1;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let interval: ReturnType<typeof setInterval> | null = null;
  let observer: ResizeObserverLike | null = null;
  let stopped = false;

  const emit = (force: boolean): void => {
    if (stopped) return;
    const height = measure(option.target);
    if (!force && lastHeight >= 0 && Math.abs(height - lastHeight) < thresholdPx) return;
    lastHeight = height;
    option.report(height);
  };

  const schedule = (): void => {
    if (stopped) return;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      emit(false);
    }, debounceMs);
  };

  const factory = resolveFactory(option);
  if (factory) {
    observer = factory(schedule);
    observer.observe(option.target);
  } else {
    interval = setInterval(schedule, pollMs);
  }

  // Report once up front so the host is not left at its placeholder height
  // waiting for the first mutation that may never come.
  emit(true);

  return {
    flush() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      emit(true);
    },
    get lastHeight() {
      return lastHeight;
    },
    usingObserver: observer !== null,
    stop() {
      if (stopped) return;
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      if (interval !== null) clearInterval(interval);
      observer?.disconnect();
      observer = null;
    },
  };
}
