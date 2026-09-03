// =============================================================================
// @onegrid/touch
//
// Touch / mobile interaction surface for oneGrid.
//
//   - PointerGestureRecognizer: Pointer Events Level 3-based recognizer
//     for tap, double-tap, long-press (≥500 ms), swipe, and
//     drag-from-edge. Cleans up state on pointercancel.
//   - CSS emitter: touch-action / overscroll-behavior declarations
//     for the four grid affordances + (pointer: coarse) density
//     overrides meeting Apple HIG 44pt / Material 48dp floors.
//   - VirtualKeyboardController: navigator.virtualKeyboard adapter
//     with visualViewport fallback for iOS Safari.
//   - inputmodeForColumn: map oneGrid ColumnType → HTML inputmode.
//
// Standards used:
//   - W3C Pointer Events Level 3 (https://www.w3.org/TR/pointerevents3/)
//   - CSS touch-action (CSS Pointer Events 2)
//   - CSS overscroll-behavior (CSS Overscroll Behavior Module 1)
//   - VirtualKeyboard API (https://www.w3.org/TR/virtual-keyboard/)
//   - HTML inputmode (HTML Living Standard)
// =============================================================================

import type { ColumnType } from '@onegrid/protocol';

// -----------------------------------------------------------------------------
// Gesture recognizer
// -----------------------------------------------------------------------------

/** @public */
export interface GestureOptions {
  /** Long-press threshold in ms. Default 500 (matches platform conventions). */
  readonly longPressMs?: number;
  /** Movement tolerance (px) before tap converts to drag. Default 8. */
  readonly tapSlop?: number;
  /** Time window (ms) within which two taps count as a double-tap. Default 300. */
  readonly doubleTapMs?: number;
  /** Swipe velocity threshold (px/ms). Default 0.3. */
  readonly swipeVelocity?: number;
  /** Edge-drag detection band width (px) from any edge. Default 20. */
  readonly edgeBand?: number;
}

const DEFAULTS: Required<GestureOptions> = {
  longPressMs: 500,
  tapSlop: 8,
  doubleTapMs: 300,
  swipeVelocity: 0.3,
  edgeBand: 20,
};

/** @public */
export type GestureKind =
  | 'tap'
  | 'doubleTap'
  | 'longPress'
  | 'swipe'
  | 'dragFromEdge'
  | 'pan'
  | 'panEnd';

/** @public */
export type GestureEdge = 'top' | 'right' | 'bottom' | 'left';

/** @public */
export interface GestureEvent {
  readonly kind: GestureKind;
  readonly x: number;
  readonly y: number;
  readonly dx: number;
  readonly dy: number;
  readonly elapsedMs: number;
  // `string & {}` keeps the three well-known values as autocomplete hints
  // while still accepting any future pointerType the UA reports.
  readonly pointerType: 'mouse' | 'touch' | 'pen' | (string & {});
  /** For 'swipe' / 'dragFromEdge', the dominant edge. */
  readonly edge?: GestureEdge;
}

/** @public */
export type GestureListener = (e: GestureEvent) => void;

interface PointerState {
  readonly id: number;
  readonly startX: number;
  readonly startY: number;
  readonly startTime: number;
  readonly pointerType: string;
  lastX: number;
  lastY: number;
  lastTime: number;
  longPressTimer: ReturnType<typeof setTimeout> | null;
  longPressFired: boolean;
  panActive: boolean;
  edge: GestureEdge | undefined;
}

/**
 * Bind a Pointer-Events-3-based gesture recognizer to a target.
 * Returns a cleanup function. Idempotent re-bind on the same target
 * is intentionally NOT supported — call cleanup() first.
 * @public
 */
export function bindGestures(
  target: Element,
  listener: GestureListener,
  opts: GestureOptions = {},
): () => void {
  const cfg = { ...DEFAULTS, ...opts };
  const state = new Map<number, PointerState>();
  let lastTapTime = 0;
  let lastTapX = 0;
  let lastTapY = 0;

  const detectEdge = (x: number, y: number): GestureEdge | undefined => {
    const rect = target.getBoundingClientRect();
    if (x - rect.left < cfg.edgeBand) return 'left';
    if (rect.right - x < cfg.edgeBand) return 'right';
    if (y - rect.top < cfg.edgeBand) return 'top';
    if (rect.bottom - y < cfg.edgeBand) return 'bottom';
    return undefined;
  };

  const onPointerDown = (e: PointerEvent): void => {
    const st: PointerState = {
      id: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      startTime: e.timeStamp,
      pointerType: e.pointerType,
      lastX: e.clientX,
      lastY: e.clientY,
      lastTime: e.timeStamp,
      longPressTimer: null,
      longPressFired: false,
      panActive: false,
      edge: detectEdge(e.clientX, e.clientY),
    };
    state.set(e.pointerId, st);
    target.setPointerCapture?.(e.pointerId);
    st.longPressTimer = setTimeout(() => {
      const live = state.get(e.pointerId);
      if (!live || live.panActive) return;
      live.longPressFired = true;
      listener({
        kind: 'longPress',
        x: live.startX,
        y: live.startY,
        dx: 0,
        dy: 0,
        elapsedMs: cfg.longPressMs,
        pointerType: live.pointerType,
        ...(live.edge ? { edge: live.edge } : {}),
      });
    }, cfg.longPressMs);
  };

  const onPointerMove = (e: PointerEvent): void => {
    const st = state.get(e.pointerId);
    if (!st) return;
    const dx = e.clientX - st.startX;
    const dy = e.clientY - st.startY;
    const dist = Math.hypot(dx, dy);
    st.lastX = e.clientX;
    st.lastY = e.clientY;
    st.lastTime = e.timeStamp;
    if (!st.panActive && dist > cfg.tapSlop) {
      st.panActive = true;
      if (st.longPressTimer !== null) {
        clearTimeout(st.longPressTimer);
        st.longPressTimer = null;
      }
      if (st.edge) {
        listener({
          kind: 'dragFromEdge',
          x: e.clientX,
          y: e.clientY,
          dx,
          dy,
          elapsedMs: e.timeStamp - st.startTime,
          pointerType: st.pointerType,
          edge: st.edge,
        });
      }
    }
    if (st.panActive) {
      listener({
        kind: 'pan',
        x: e.clientX,
        y: e.clientY,
        dx,
        dy,
        elapsedMs: e.timeStamp - st.startTime,
        pointerType: st.pointerType,
      });
    }
  };

  const onPointerUp = (e: PointerEvent): void => {
    const st = state.get(e.pointerId);
    if (!st) return;
    if (st.longPressTimer !== null) {
      clearTimeout(st.longPressTimer);
      st.longPressTimer = null;
    }
    const dx = e.clientX - st.startX;
    const dy = e.clientY - st.startY;
    const elapsed = e.timeStamp - st.startTime;
    if (st.panActive) {
      const velocity = Math.hypot(dx, dy) / Math.max(1, elapsed);
      if (velocity > cfg.swipeVelocity) {
        const dominant: GestureEdge =
          Math.abs(dx) > Math.abs(dy)
            ? dx > 0
              ? 'right'
              : 'left'
            : dy > 0
              ? 'bottom'
              : 'top';
        listener({
          kind: 'swipe',
          x: e.clientX,
          y: e.clientY,
          dx,
          dy,
          elapsedMs: elapsed,
          pointerType: st.pointerType,
          edge: dominant,
        });
      }
      listener({
        kind: 'panEnd',
        x: e.clientX,
        y: e.clientY,
        dx,
        dy,
        elapsedMs: elapsed,
        pointerType: st.pointerType,
      });
    } else if (!st.longPressFired) {
      // tap / doubleTap
      const isDouble =
        e.timeStamp - lastTapTime < cfg.doubleTapMs &&
        Math.hypot(e.clientX - lastTapX, e.clientY - lastTapY) <= cfg.tapSlop;
      if (isDouble) {
        listener({
          kind: 'doubleTap',
          x: e.clientX,
          y: e.clientY,
          dx,
          dy,
          elapsedMs: elapsed,
          pointerType: st.pointerType,
        });
        lastTapTime = 0;
      } else {
        listener({
          kind: 'tap',
          x: e.clientX,
          y: e.clientY,
          dx,
          dy,
          elapsedMs: elapsed,
          pointerType: st.pointerType,
        });
        lastTapTime = e.timeStamp;
        lastTapX = e.clientX;
        lastTapY = e.clientY;
      }
    }
    state.delete(e.pointerId);
    target.releasePointerCapture?.(e.pointerId);
  };

  const onPointerCancel = (e: PointerEvent): void => {
    const st = state.get(e.pointerId);
    if (st?.longPressTimer !== undefined && st?.longPressTimer !== null) {
      clearTimeout(st.longPressTimer);
    }
    state.delete(e.pointerId);
  };

  target.addEventListener('pointerdown', onPointerDown as EventListener);
  target.addEventListener('pointermove', onPointerMove as EventListener);
  target.addEventListener('pointerup', onPointerUp as EventListener);
  target.addEventListener('pointercancel', onPointerCancel as EventListener);

  return () => {
    target.removeEventListener('pointerdown', onPointerDown as EventListener);
    target.removeEventListener('pointermove', onPointerMove as EventListener);
    target.removeEventListener('pointerup', onPointerUp as EventListener);
    target.removeEventListener('pointercancel', onPointerCancel as EventListener);
    for (const [, st] of state) {
      if (st.longPressTimer !== null) clearTimeout(st.longPressTimer);
    }
    state.clear();
  };
}

// -----------------------------------------------------------------------------
// CSS emitter — touch-action / overscroll-behavior / (pointer: coarse)
// -----------------------------------------------------------------------------

/**
 * Emit the touch-related CSS oneGrid expects on the host. Selectors
 * are scoped to `[data-og-root]` so multiple grids on a page don't
 * collide. Drop the result into a `<style>` tag or adoptedStyleSheets.
 *
 *   .og-tap                   touch-action: manipulation (no 350 ms delay)
 *   .og-drag                  touch-action: none         (drag affordances)
 *   [data-og-grid-body]       touch-action: pan-x pan-y; overscroll-behavior: contain
 *   (pointer: coarse) bumps the row height + chevron hit-zone to
 *   `--og-size-touch-hit-zone` so Apple HIG 44pt / Material 48dp is
 *   met without forcing density="spacious" on desktop.
 * @public
 */
export function touchCss(
  selector: string = '[data-og-root]',
): string {
  return [
    `${selector} .og-tap { touch-action: manipulation; }`,
    `${selector} .og-drag { touch-action: none; user-select: none; }`,
    `${selector} [data-og-grid-body] {`,
    `  touch-action: pan-x pan-y;`,
    `  overscroll-behavior: contain;`,
    `}`,
    `@media (pointer: coarse) {`,
    `  ${selector} {`,
    `    --og-size-row-height: var(--og-size-touch-hit-zone);`,
    `    --og-size-chevron-hit: var(--og-size-touch-hit-zone);`,
    `  }`,
    `  ${selector} .og-tap,`,
    `  ${selector} .og-drag {`,
    `    min-width: var(--og-size-touch-hit-zone);`,
    `    min-height: var(--og-size-touch-hit-zone);`,
    `  }`,
    `}`,
  ].join('\n');
}

// -----------------------------------------------------------------------------
// VirtualKeyboard adapter
// -----------------------------------------------------------------------------

/** @public */
export type VirtualKeyboardListener = (insetPx: number) => void;

interface VirtualKeyboardLike {
  overlaysContent: boolean;
  addEventListener(
    type: 'geometrychange',
    listener: (e: { target: { boundingRect: DOMRectReadOnly } }) => void,
  ): void;
  removeEventListener(
    type: 'geometrychange',
    listener: (e: { target: { boundingRect: DOMRectReadOnly } }) => void,
  ): void;
}

/**
 * Attach a virtual-keyboard-aware inset listener. Prefers the
 * VirtualKeyboard API (Chromium); falls back to visualViewport
 * resize tracking for iOS Safari. Returns a cleanup function.
 * @public
 */
export function attachVirtualKeyboard(
  onInset: VirtualKeyboardListener,
): () => void {
  if (typeof navigator === 'undefined') return () => {};
  const vk = (navigator as unknown as { virtualKeyboard?: VirtualKeyboardLike })
    .virtualKeyboard;
  if (vk && 'overlaysContent' in vk) {
    vk.overlaysContent = true;
    const handler = (e: { target: { boundingRect: DOMRectReadOnly } }): void => {
      onInset(e.target.boundingRect.height);
    };
    vk.addEventListener('geometrychange', handler);
    return () => vk.removeEventListener('geometrychange', handler);
  }
  // Fallback: visualViewport (iOS Safari).
  const vv = (
    typeof window !== 'undefined' ? window.visualViewport : undefined
  ) as
    | { height: number; addEventListener: (k: string, fn: () => void) => void; removeEventListener: (k: string, fn: () => void) => void }
    | undefined;
  if (!vv) return () => {};
  const innerHeight = (typeof window !== 'undefined' ? window.innerHeight : 0) || 0;
  const handler = (): void => {
    const inset = Math.max(0, innerHeight - vv.height);
    onInset(inset);
  };
  vv.addEventListener('resize', handler);
  vv.addEventListener('scroll', handler);
  handler();
  return () => {
    vv.removeEventListener('resize', handler);
    vv.removeEventListener('scroll', handler);
  };
}

// -----------------------------------------------------------------------------
// inputmode mapping (HTML attribute on cell editors)
// -----------------------------------------------------------------------------

/** @public */
export type HtmlInputMode =
  | 'text'
  | 'numeric'
  | 'decimal'
  | 'email'
  | 'url'
  | 'tel'
  | 'search'
  | 'none';

/**
 * Pick the best inputmode value for a given protocol ColumnType.
 * @public
 */
export function inputmodeForColumn(type: ColumnType): HtmlInputMode {
  switch (type) {
    case 'int8':
    case 'int16':
    case 'int32':
    case 'int64':
    case 'uint8':
    case 'uint16':
    case 'uint32':
    case 'uint64':
      return 'numeric';
    case 'float32':
    case 'float64':
    case 'decimal':
      return 'decimal';
    case 'utf8':
    case 'json':
      return 'text';
    case 'date32':
    case 'date64':
    case 'timestamp':
    case 'timestamp_tz':
    case 'time32':
    case 'time64':
      return 'numeric'; // pickers usually drive the value; numeric keeps soft-keypad sensible
    default:
      return 'text';
  }
}

// -----------------------------------------------------------------------------
// Convenience — defaults for the `touch.longPressAction` option
// -----------------------------------------------------------------------------

/** @public */
export type LongPressAction = 'context-menu' | 'row-drag';
/** @public */
export const DEFAULT_LONG_PRESS_ACTION: LongPressAction = 'context-menu';

// -----------------------------------------------------------------------------
// Swipe-to-reveal row actions
//
// Lives in ./swipe-row.ts and is re-exported here so `@onegrid/touch` keeps a
// single entry point. It builds on `bindGestures` above rather than shipping a
// second swipe detector — see that module's header for the rationale.
// -----------------------------------------------------------------------------

export {
  MIN_TOUCH_TARGET_PX,
  defineRowAction,
  defineRowActionSet,
  revealWidth,
  edgeForSide,
  revealSign,
  sideForDelta,
  rubberBand,
  resistedOffset,
  prefersReducedMotion,
  rowActionMenuItem,
  createSwipeRowController,
} from './swipe-row.js';

export type {
  RowActionSide,
  RowActionEdge,
  RowActionIntent,
  RowActionTrigger,
  RowActionContext,
  RowAction,
  RowActionSet,
  RowActionSpec,
  RowActionMenuItem,
  WritingDirection,
  SwipeRowPhase,
  SwipeAxis,
  SwipeRowState,
  SwipeRowCloseReason,
  SwipeRowAnnouncementInput,
  SwipeRowOption,
  SwipeRowController,
  SwipeRowControllerSpec,
  FrameScheduler,
} from './swipe-row.js';
