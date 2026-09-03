// =============================================================================
// @onegrid/touch — swipe-to-reveal row actions
//
// The gesture vocabulary that turns the recognizer in `./index.ts` into the
// iOS/Android "swipe a row to reveal Archive / Delete" affordance.
//
// Design decisions, and why:
//
//   1. ONE detector. This module never listens to raw pointer events for
//      swipe classification — it binds `bindGestures` and consumes its
//      `pan` / `swipe` / `panEnd` / `tap` output. A second detector would
//      drift from the first (different slop, different velocity window) and
//      produce a grid where a swipe means one thing to the row and another
//      to the grid body. The recognizer's `swipeVelocity` knob is wired to
//      this module's `flickVelocity` option so there is exactly one
//      velocity threshold in the system.
//
//   2. Thresholds read RAW travel; the offset the renderer draws is
//      RESISTED. Mixing the two is the classic bug: once rubber-banding
//      compresses travel, a distance threshold expressed in drawn pixels
//      becomes unreachable. So `commitDistance` and `fullSwipeDistance`
//      compare against |dx|, and `state.offset` is the eased value.
//
//   3. Rubber-banding is the UIScrollView curve, not a clamp:
//          extra = (1 - 1 / (over * factor / dimension + 1)) * dimension
//      Monotonic, C¹ at the boundary (slope = factor), and asymptotic to
//      `dimension` so the row can never be dragged off-screen. A hard clamp
//      reads as a broken gesture because the finger and the pixels
//      desynchronise instantly instead of gradually.
//
//   4. Axis lock is one-way and permanent for the gesture. The first
//      movement past `axisLockSlop` decides horizontal or vertical, and
//      nothing re-decides it. Re-deciding mid-gesture is the single most
//      common mobile-grid bug: a diagonal drag flickers between opening the
//      row and scrolling the list. A gesture locked vertical additionally
//      closes any open row, because that gesture IS a scroll.
//
//   5. Exactly one row is open, tracked by the controller rather than the
//      row. Every attached row shares one controller, so "open B" is
//      naturally "close A, open B" — there is no cross-row bookkeeping for
//      the adopter to get wrong.
//
//   6. Headless. Nothing here touches the DOM beyond the gesture binding.
//      Animation is exposed as `offset` + `settleProgress`, and the frame
//      source is injectable, so the same controller drives DOM, canvas, or
//      a test with a hand-cranked clock. `prefers-reduced-motion` collapses
//      every animation to an instant snap rather than a fast one — a
//      shortened animation still moves, which is what the media query asks
//      us not to do.
//
//   7. Swipe is never the only path to an action. `rowActionMenuItem`
//      projects the identical action set onto an activatable list for
//      keyboard and screen-reader users, and every state change emits
//      announcement text. A swipe-only destructive action is unreachable
//      for a switch-control user.
//
// RTL: `leading` / `trailing` are LOGICAL sides, following the same
// inline-start / inline-end model `@onegrid/intl`'s `getRtlAwareScrollLeft`
// normalises to. The action set does not change under RTL; the physical
// edge each side occupies, and therefore the sign of the drag that reveals
// it, mirrors.
// =============================================================================

import { bindGestures, type GestureEvent } from './index.js';

// -----------------------------------------------------------------------------
// Actions
// -----------------------------------------------------------------------------

/**
 * Logical side of the row an action lives on. `leading` is inline-start
 * (physically left in LTR, right in RTL); `trailing` is inline-end.
 * @public
 */
export type RowActionSide = 'leading' | 'trailing';

/**
 * Physical edge a logical side resolves to for a given writing direction.
 * @public
 */
export type RowActionEdge = 'left' | 'right';

/**
 * Semantic weight of an action. `destructive` is the only intent eligible
 * for full-swipe commit — an accidental over-drag must never fire a
 * constructive action the user cannot see the consequences of.
 * @public
 */
export type RowActionIntent = 'default' | 'destructive' | 'constructive';

/**
 * Why an action fired. Handlers routinely branch on this — a full-swipe
 * delete usually skips the confirmation sheet a menu delete shows.
 * @public
 */
export type RowActionTrigger = 'swipe' | 'fullSwipe' | 'menu' | 'programmatic';

/**
 * What a row action handler receives. Deliberately carries the row key
 * rather than row data: the controller is headless and holds no model.
 * @public
 */
export interface RowActionContext {
  readonly rowKey: string;
  readonly action: RowAction;
  readonly side: RowActionSide;
  readonly trigger: RowActionTrigger;
}

/**
 * A single swipe-revealed row action.
 * @public
 */
export interface RowAction {
  readonly side: RowActionSide;
  readonly id: string;
  readonly label: string;
  readonly icon?: string;
  readonly intent: RowActionIntent;
  /**
   * Hit width in CSS px. Always at least {@link MIN_TOUCH_TARGET_PX};
   * `defineRowAction` raises anything smaller.
   */
  readonly width: number;
  readonly handler: (ctx: RowActionContext) => void | Promise<void>;
}

/**
 * The two logical sides of a row, each an ordered list rendered from the
 * edge inward — the order the platform conventions use.
 * @public
 */
export interface RowActionSet {
  readonly leading: readonly RowAction[];
  readonly trailing: readonly RowAction[];
}

/**
 * Apple HIG's 44pt minimum hit target — the same floor
 * `touchCss()`'s `(pointer: coarse)` block enforces on tap and drag
 * affordances. Material's 48dp is larger; 44 is the floor, adopters are
 * free to pass more.
 * @public
 */
export const MIN_TOUCH_TARGET_PX = 44;

/**
 * Shape accepted by {@link defineRowAction}. `width` is optional and
 * defaults to the 44pt floor.
 * @public
 */
export interface RowActionSpec {
  readonly side: RowActionSide;
  readonly id: string;
  readonly label: string;
  readonly icon?: string;
  readonly intent: RowActionIntent;
  readonly width?: number;
  readonly handler: (ctx: RowActionContext) => void | Promise<void>;
}

/**
 * Define one swipe row action. Validates eagerly — an action with a blank
 * id or label is unreachable by screen reader and would fail silently at
 * runtime, so it throws here instead.
 * @public
 */
export function defineRowAction(spec: RowActionSpec): RowAction {
  if (!spec.id.trim()) throw new Error('defineRowAction: id must be non-empty');
  if (!spec.label.trim()) {
    throw new Error(`defineRowAction: action "${spec.id}" must have a label`);
  }
  const width = Math.max(MIN_TOUCH_TARGET_PX, spec.width ?? MIN_TOUCH_TARGET_PX);
  return {
    side: spec.side,
    id: spec.id,
    label: spec.label,
    ...(spec.icon !== undefined ? { icon: spec.icon } : {}),
    intent: spec.intent,
    width,
    handler: spec.handler,
  };
}

/**
 * Group a flat list of actions into the per-side set the controller wants.
 * Duplicate ids across the whole set are rejected — `commit(id)` and the
 * accessible menu both address actions by id, and a duplicate makes both
 * ambiguous.
 * @public
 */
export function defineRowActionSet(action: readonly RowAction[]): RowActionSet {
  const seen = new Set<string>();
  const leading: RowAction[] = [];
  const trailing: RowAction[] = [];
  for (const a of action) {
    if (seen.has(a.id)) {
      throw new Error(`defineRowActionSet: duplicate action id "${a.id}"`);
    }
    seen.add(a.id);
    (a.side === 'leading' ? leading : trailing).push(a);
  }
  return { leading, trailing };
}

/**
 * Total reveal width of a side — the offset at which the side is fully
 * revealed and rubber-banding begins.
 * @public
 */
export function revealWidth(set: RowActionSet, side: RowActionSide): number {
  let total = 0;
  for (const a of set[side]) total += a.width;
  return total;
}

// -----------------------------------------------------------------------------
// RTL mirroring
// -----------------------------------------------------------------------------

/**
 * Writing direction. Matches the `'ltr' | 'rtl'` vocabulary
 * `@onegrid/intl` reads off `dir` / `getComputedStyle().direction`.
 * @public
 */
export type WritingDirection = 'ltr' | 'rtl';

/**
 * Physical edge a logical side occupies. This is the whole of RTL support:
 * the action set is direction-agnostic, only the edge mirrors.
 * @public
 */
export function edgeForSide(
  side: RowActionSide,
  direction: WritingDirection = 'ltr',
): RowActionEdge {
  const startIsLeft = direction === 'ltr';
  const isStart = side === 'leading';
  return isStart === startIsLeft ? 'left' : 'right';
}

/**
 * Sign of the horizontal drag that reveals a side: +1 means "drag right".
 * Revealing a left-edge side means pushing the row content right.
 * @public
 */
export function revealSign(
  side: RowActionSide,
  direction: WritingDirection = 'ltr',
): 1 | -1 {
  return edgeForSide(side, direction) === 'left' ? 1 : -1;
}

/**
 * Which logical side a horizontal delta is trying to reveal. Returns
 * `null` for a zero delta.
 * @public
 */
export function sideForDelta(
  dx: number,
  direction: WritingDirection = 'ltr',
): RowActionSide | null {
  if (dx === 0) return null;
  const wantLeftEdge = dx > 0;
  const leadingIsLeft = edgeForSide('leading', direction) === 'left';
  return wantLeftEdge === leadingIsLeft ? 'leading' : 'trailing';
}

// -----------------------------------------------------------------------------
// Rubber-banding
// -----------------------------------------------------------------------------

/**
 * The UIScrollView rubber-band curve. `over` is travel beyond the limit,
 * `dimension` is the limit itself, `factor` the initial slope (Apple uses
 * 0.55). Asymptotic to `dimension`, so overdrag is bounded without ever
 * hitting a wall.
 * @public
 */
export function rubberBand(over: number, dimension: number, factor = 0.55): number {
  if (over <= 0 || dimension <= 0) return 0;
  return (1 - 1 / ((over * factor) / dimension + 1)) * dimension;
}

/**
 * Map raw travel to drawn travel: linear up to `limit`, rubber-banded past
 * it. `limit` of 0 (a side with no actions) yields no movement at all,
 * which is the honest signal that there is nothing to reveal.
 * @public
 */
export function resistedOffset(raw: number, limit: number, factor = 0.55): number {
  const magnitude = Math.abs(raw);
  if (limit <= 0) return 0;
  const eased =
    magnitude <= limit ? magnitude : limit + rubberBand(magnitude - limit, limit, factor);
  return raw < 0 ? -eased : eased;
}

// -----------------------------------------------------------------------------
// Controller state
// -----------------------------------------------------------------------------

/**
 * The state machine's phases.
 *
 *   idle       nothing revealed, no gesture in flight
 *   tracking   a gesture owns the row; offset follows the finger
 *   revealed   a side is latched open at its full reveal width
 *   committing an action's handler is running (it may be async)
 *   closing    animating back to zero
 *
 * `committing` and `closing` both terminate at `idle`.
 * @public
 */
export type SwipeRowPhase = 'idle' | 'tracking' | 'revealed' | 'committing' | 'closing';

/**
 * Which axis the in-flight gesture has been locked to. `none` means the
 * lock has not been decided yet — movement is still below `axisLockSlop`.
 * @public
 */
export type SwipeAxis = 'none' | 'horizontal' | 'vertical';

/**
 * Everything a renderer needs, and nothing it does not. Immutable — every
 * transition publishes a fresh object so subscribers can compare by
 * identity.
 * @public
 */
export interface SwipeRowState {
  readonly phase: SwipeRowPhase;
  /** Row currently owning the gesture or the open reveal, else null. */
  readonly rowKey: string | null;
  /** Logical side being revealed, else null. */
  readonly side: RowActionSide | null;
  /** Signed drawn translation of the row content, in CSS px. */
  readonly offset: number;
  /** `|offset| / revealWidth`. Exceeds 1 while rubber-banding. */
  readonly progress: number;
  readonly axis: SwipeAxis;
  /** True once travel passes the full-swipe threshold on a side that has a destructive action. */
  readonly fullSwipeArmed: boolean;
  /** 0..1 progress of the current snap animation; 1 when settled. */
  readonly settleProgress: number;
  /** Action id currently being committed, else null. */
  readonly committingActionId: string | null;
  /** Live-region text for the most recent transition. */
  readonly announcement: string;
}

const IDLE_STATE: SwipeRowState = {
  phase: 'idle',
  rowKey: null,
  side: null,
  offset: 0,
  progress: 0,
  axis: 'none',
  fullSwipeArmed: false,
  settleProgress: 1,
  committingActionId: null,
  announcement: '',
};

/**
 * Why the open row closed. Surfaced to `onClose` so an adopter can, for
 * example, keep focus where it was on `scroll` but restore it on
 * `outsideTap`.
 * @public
 */
export type SwipeRowCloseReason =
  | 'release'
  | 'commit'
  | 'scroll'
  | 'outsideTap'
  | 'otherRow'
  | 'cancel'
  | 'programmatic';

/**
 * Injectable frame source. Returns a cancel function. Defaults to
 * `requestAnimationFrame` where it exists; supply your own to drive
 * animation from a test clock or an existing render loop.
 * @public
 */
export type FrameScheduler = (cb: () => void) => () => void;

/**
 * Announcement inputs, so adopters can localise via `@onegrid/intl`'s
 * `t()` instead of shipping the built-in English.
 * @public
 */
export interface SwipeRowAnnouncementInput {
  readonly kind: 'revealed' | 'committed' | 'closed';
  readonly rowKey: string;
  readonly side: RowActionSide | null;
  readonly action: readonly RowAction[];
  readonly committed: RowAction | null;
}

/** @public */
export interface SwipeRowOption {
  /** Writing direction. Mirrors leading/trailing. Default `'ltr'`. */
  readonly direction?: WritingDirection;
  /** Movement (px) before the axis lock is decided. Default 8. */
  readonly axisLockSlop?: number;
  /** Fraction of the reveal width a slow drag must pass to commit. Default 0.5. */
  readonly commitRatio?: number;
  /** Multiple of the reveal width that arms a full-swipe destructive commit. Default 1.6. */
  readonly fullSwipeRatio?: number;
  /** Flick velocity (px/ms) that commits regardless of distance. Default 0.3. */
  readonly flickVelocity?: number;
  /** Rubber-band initial slope. Default 0.55 (Apple's value). */
  readonly rubberBandFactor?: number;
  /** Snap animation duration in ms. Default 220. */
  readonly snapDurationMs?: number;
  /** Force reduced motion. Defaults to the `prefers-reduced-motion` media query. */
  readonly reduceMotion?: boolean;
  /** Clock, in ms. Default `performance.now` / `Date.now`. */
  readonly now?: () => number;
  /** Frame source for snap animation. */
  readonly scheduleFrame?: FrameScheduler;
  /** Called after every state transition. */
  readonly onChange?: (state: SwipeRowState) => void;
  /** Called with live-region text on every announced transition. */
  readonly onAnnounce?: (text: string) => void;
  /** Called when an open row closes. */
  readonly onClose?: (rowKey: string, reason: SwipeRowCloseReason) => void;
  /** Override the built-in English announcement text. */
  readonly formatAnnouncement?: (input: SwipeRowAnnouncementInput) => string;
}

interface ResolvedOption {
  direction: WritingDirection;
  axisLockSlop: number;
  commitRatio: number;
  fullSwipeRatio: number;
  flickVelocity: number;
  rubberBandFactor: number;
  snapDurationMs: number;
  reduceMotion: boolean;
  now: () => number;
  scheduleFrame: FrameScheduler;
}

/**
 * Read the `prefers-reduced-motion` media query, defaulting to `false`
 * where `matchMedia` is unavailable (SSR, jsdom without a stub).
 * @public
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

function defaultNow(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

const defaultScheduleFrame: FrameScheduler = (cb) => {
  if (typeof requestAnimationFrame === 'function') {
    const id = requestAnimationFrame(() => cb());
    return () => cancelAnimationFrame(id);
  }
  const id = setTimeout(cb, 16);
  return () => clearTimeout(id);
};

// easeOutCubic — fast departure, soft landing. The standard snap curve.
function easeOutCubic(t: number): number {
  const inv = 1 - t;
  return 1 - inv * inv * inv;
}

// -----------------------------------------------------------------------------
// Accessible projection
// -----------------------------------------------------------------------------

/**
 * One entry of the keyboard/screen-reader-reachable action list. Carries
 * the same `activate()` the swipe path calls, so the two can never drift.
 * @public
 */
export interface RowActionMenuItem {
  readonly id: string;
  readonly label: string;
  readonly icon?: string;
  readonly intent: RowActionIntent;
  readonly side: RowActionSide;
  /** ARIA role to render with. */
  readonly role: 'menuitem';
  /** Accessible name; includes the destructive warning where relevant. */
  readonly ariaLabel: string;
  /** Minimum hit box, in px, for both axes. */
  readonly minSizePx: number;
  /** Fires the action's handler with `trigger: 'menu'`. */
  readonly activate: (rowKey: string) => void | Promise<void>;
}

/**
 * Project an action set (or a flat action list) onto an activatable menu.
 * This is the non-swipe path to every action and is required, not
 * optional: a swipe is a pointer-only gesture, so an action reachable only
 * by swipe is unreachable by keyboard, switch control and screen reader.
 * @public
 */
export function rowActionMenuItem(
  action: RowActionSet | readonly RowAction[],
): readonly RowActionMenuItem[] {
  const flat: readonly RowAction[] =
    'leading' in action ? [...action.leading, ...action.trailing] : action;
  return flat.map((a) => ({
    id: a.id,
    label: a.label,
    ...(a.icon !== undefined ? { icon: a.icon } : {}),
    intent: a.intent,
    side: a.side,
    role: 'menuitem' as const,
    ariaLabel: a.intent === 'destructive' ? `${a.label} (destructive)` : a.label,
    minSizePx: MIN_TOUCH_TARGET_PX,
    activate: (rowKey: string) =>
      a.handler({ rowKey, action: a, side: a.side, trigger: 'menu' }),
  }));
}

// -----------------------------------------------------------------------------
// Controller
// -----------------------------------------------------------------------------

/** @public */
export interface SwipeRowController {
  /** Current immutable state. */
  readonly state: SwipeRowState;
  /** Subscribe to state transitions. Returns an unsubscribe function. */
  subscribe(listener: (state: SwipeRowState) => void): () => void;
  /**
   * Bind the shared gesture recognizer to one row's element. Returns a
   * detach function. Every row shares this controller, which is what makes
   * the one-open-row invariant free.
   */
  attach(target: Element, rowKey: string): () => void;
  /** Programmatically latch a side open (closing any other open row). */
  open(rowKey: string, side: RowActionSide): void;
  /** Close the open row, if any. */
  close(reason?: SwipeRowCloseReason): void;
  /** Fire an action by id. Resolves once an async handler settles. */
  commit(rowKey: string, actionId: string, trigger?: RowActionTrigger): Promise<void>;
  /** Tell the controller the grid scrolled — closes the open row. */
  notifyScroll(): void;
  /** Tell the controller a tap landed outside the grid — closes the open row. */
  notifyOutsideTap(): void;
  /** Advance the snap animation. Called automatically by the frame scheduler. */
  tick(): void;
  /** Actions for a side, in edge-inward render order. */
  actionForSide(side: RowActionSide): readonly RowAction[];
  /** Physical edge a logical side occupies under the configured direction. */
  edgeForSide(side: RowActionSide): RowActionEdge;
  /** Full reveal width of a side, in px. */
  revealWidth(side: RowActionSide): number;
  /** The accessible, non-swipe path to every action. */
  menuItem(): readonly RowActionMenuItem[];
  /** True while a horizontal gesture owns the pointer — host must not scroll. */
  readonly isHorizontalLocked: boolean;
  /** Detach every row and cancel any animation. */
  destroy(): void;
}

/** @public */
export interface SwipeRowControllerSpec {
  readonly action: RowActionSet;
  readonly option?: SwipeRowOption;
}

interface Animation {
  from: number;
  to: number;
  start: number;
  duration: number;
  onDone: (() => void) | null;
}

interface GestureTrack {
  rowKey: string;
  baseOffset: number;
  axis: SwipeAxis;
  side: RowActionSide | null;
  flick: { dx: number; velocity: number } | null;
}

function defaultAnnouncement(input: SwipeRowAnnouncementInput): string {
  if (input.kind === 'committed') {
    return input.committed ? `${input.committed.label} activated` : 'Action activated';
  }
  if (input.kind === 'closed') return 'Row actions dismissed';
  const label = input.action.map((a) => a.label).join(', ');
  return label ? `Row actions available: ${label}` : 'No row actions available';
}

/**
 * Build the swipe-to-reveal controller for a grid. One controller serves
 * every row; `attach` binds it to a row element via the package's existing
 * gesture recognizer.
 *
 * @example
 * ```ts
 * const action = defineRowActionSet([
 *   defineRowAction({ side: 'trailing', id: 'delete', label: 'Delete',
 *                     intent: 'destructive', handler: (c) => remove(c.rowKey) }),
 * ]);
 * const controller = createSwipeRowController({ action, option: { direction: 'rtl' } });
 * const detach = controller.attach(rowEl, 'row-7');
 * ```
 * @public
 */
export function createSwipeRowController(
  spec: SwipeRowControllerSpec,
): SwipeRowController {
  const set = spec.action;
  const o = spec.option ?? {};
  const cfg: ResolvedOption = {
    direction: o.direction ?? 'ltr',
    axisLockSlop: o.axisLockSlop ?? 8,
    commitRatio: o.commitRatio ?? 0.5,
    fullSwipeRatio: o.fullSwipeRatio ?? 1.6,
    flickVelocity: o.flickVelocity ?? 0.3,
    rubberBandFactor: o.rubberBandFactor ?? 0.55,
    snapDurationMs: o.snapDurationMs ?? 220,
    reduceMotion: o.reduceMotion ?? prefersReducedMotion(),
    now: o.now ?? defaultNow,
    scheduleFrame: o.scheduleFrame ?? defaultScheduleFrame,
  };
  const announce = o.formatAnnouncement ?? defaultAnnouncement;

  let state: SwipeRowState = IDLE_STATE;
  const listener = new Set<(s: SwipeRowState) => void>();
  const detacher = new Map<string, () => void>();
  let track: GestureTrack | null = null;
  let animation: Animation | null = null;
  let cancelFrame: (() => void) | null = null;

  const width = (side: RowActionSide): number => revealWidth(set, side);

  const hasDestructive = (side: RowActionSide): boolean =>
    set[side].some((a) => a.intent === 'destructive');

  const destructiveOf = (side: RowActionSide): RowAction | undefined =>
    set[side].find((a) => a.intent === 'destructive');

  const publish = (next: Partial<SwipeRowState>): void => {
    state = { ...state, ...next };
    o.onChange?.(state);
    for (const l of listener) l(state);
  };

  const emitAnnounce = (input: SwipeRowAnnouncementInput): string => {
    const text = announce(input);
    o.onAnnounce?.(text);
    return text;
  };

  const progressFor = (offset: number, side: RowActionSide | null): number => {
    if (side === null) return 0;
    const w = width(side);
    return w > 0 ? Math.abs(offset) / w : 0;
  };

  const stopAnimation = (): void => {
    cancelFrame?.();
    cancelFrame = null;
    animation = null;
  };

  const pump = (): void => {
    if (animation === null) return;
    cancelFrame = cfg.scheduleFrame(() => {
      cancelFrame = null;
      tick();
    });
  };

  const finishAnimation = (): void => {
    const done = animation?.onDone ?? null;
    const to = animation?.to ?? state.offset;
    stopAnimation();
    publish({
      offset: to,
      progress: progressFor(to, state.side),
      settleProgress: 1,
    });
    done?.();
  };

  function tick(): void {
    if (animation === null) return;
    const elapsed = cfg.now() - animation.start;
    const raw = animation.duration <= 0 ? 1 : elapsed / animation.duration;
    if (raw >= 1) {
      finishAnimation();
      return;
    }
    const t = easeOutCubic(Math.max(0, raw));
    const offset = animation.from + (animation.to - animation.from) * t;
    publish({
      offset,
      progress: progressFor(offset, state.side),
      settleProgress: Math.max(0, raw),
    });
    pump();
  }

  /**
   * Animate to a target offset. Reduced motion snaps instantly — a
   * shortened animation is still motion, and the media query is a request
   * for none.
   */
  const animateTo = (to: number, onDone: (() => void) | null): void => {
    stopAnimation();
    if (cfg.reduceMotion || cfg.snapDurationMs <= 0 || state.offset === to) {
      publish({ offset: to, progress: progressFor(to, state.side), settleProgress: 1 });
      onDone?.();
      return;
    }
    animation = {
      from: state.offset,
      to,
      start: cfg.now(),
      duration: cfg.snapDurationMs,
      onDone,
    };
    publish({ settleProgress: 0 });
    pump();
  };

  const goIdle = (): void => {
    publish({
      phase: 'idle',
      rowKey: null,
      side: null,
      offset: 0,
      progress: 0,
      // A gesture still in flight keeps its axis lock: the lock outlives the
      // reveal it dismissed, so a scroll that closed a row cannot then be
      // re-interpreted as a horizontal drag.
      axis: track?.axis ?? 'none',
      fullSwipeArmed: false,
      settleProgress: 1,
      committingActionId: null,
    });
  };

  const closeInternal = (reason: SwipeRowCloseReason): void => {
    const rowKey = state.rowKey;
    if (rowKey === null && state.phase === 'idle') return;
    const text = rowKey !== null
      ? emitAnnounce({ kind: 'closed', rowKey, side: state.side, action: [], committed: null })
      : '';
    publish({
      phase: 'closing',
      axis: track?.axis ?? 'none',
      fullSwipeArmed: false,
      announcement: text,
    });
    animateTo(0, () => {
      goIdle();
      if (rowKey !== null) o.onClose?.(rowKey, reason);
    });
  };

  const reveal = (rowKey: string, side: RowActionSide): void => {
    const target = width(side) * revealSign(side, cfg.direction);
    const text = emitAnnounce({
      kind: 'revealed',
      rowKey,
      side,
      action: set[side],
      committed: null,
    });
    publish({ phase: 'revealed', rowKey, side, axis: 'none', fullSwipeArmed: false, announcement: text });
    animateTo(target, null);
  };

  const runHandler = async (
    rowKey: string,
    action: RowAction,
    trigger: RowActionTrigger,
  ): Promise<void> => {
    const text = emitAnnounce({
      kind: 'committed',
      rowKey,
      side: action.side,
      action: set[action.side],
      committed: action,
    });
    publish({
      phase: 'committing',
      rowKey,
      side: action.side,
      committingActionId: action.id,
      announcement: text,
    });
    try {
      await action.handler({ rowKey, action, side: action.side, trigger });
    } finally {
      closeInternal('commit');
    }
  };

  // ---------------------------------------------------------------------------
  // Gesture handling — everything below consumes bindGestures output only.
  // ---------------------------------------------------------------------------

  const beginTrack = (rowKey: string): GestureTrack => {
    // Opening a different row closes the current one. Doing this here, at
    // the first movement, is what makes "only one row open" free.
    if (state.rowKey !== null && state.rowKey !== rowKey && state.phase !== 'idle') {
      stopAnimation();
      const previous = state.rowKey;
      goIdle();
      o.onClose?.(previous, 'otherRow');
    }
    stopAnimation();
    const base = state.rowKey === rowKey ? state.offset : 0;
    const t: GestureTrack = {
      rowKey,
      baseOffset: base,
      axis: 'none',
      side: null,
      flick: null,
    };
    track = t;
    publish({ phase: 'tracking', rowKey, offset: base, settleProgress: 1 });
    return t;
  };

  const onPan = (e: GestureEvent, rowKey: string): void => {
    const t = track?.rowKey === rowKey ? track : beginTrack(rowKey);

    // Axis lock: decided exactly once, then never revisited.
    if (t.axis === 'none') {
      const ax = Math.abs(e.dx);
      const ay = Math.abs(e.dy);
      if (Math.max(ax, ay) < cfg.axisLockSlop) return;
      t.axis = ax > ay ? 'horizontal' : 'vertical';
      publish({ axis: t.axis });
      if (t.axis === 'vertical') {
        // The gesture is a scroll. Hand the pointer back to the scroller and
        // close anything open — a scroll dismisses the reveal, it never
        // half-drags it.
        if (state.offset !== 0) closeInternal('scroll');
        else publish({ phase: 'idle', rowKey: null, side: null, axis: 'vertical' });
        return;
      }
    }
    if (t.axis !== 'horizontal') return;

    const raw = t.baseOffset + e.dx;
    const side = sideForDelta(raw, cfg.direction);
    t.side = side;
    if (side === null) {
      publish({ phase: 'tracking', side: null, offset: 0, progress: 0, fullSwipeArmed: false });
      return;
    }
    const w = width(side);
    const offset = resistedOffset(raw, w, cfg.rubberBandFactor);
    const armed =
      w > 0 && hasDestructive(side) && Math.abs(raw) >= w * cfg.fullSwipeRatio;
    publish({
      phase: 'tracking',
      rowKey,
      side,
      offset,
      progress: w > 0 ? Math.abs(offset) / w : 0,
      fullSwipeArmed: armed,
      settleProgress: 1,
    });
  };

  const onSwipe = (e: GestureEvent, rowKey: string): void => {
    // The recognizer only emits `swipe` past its velocity threshold, which
    // we configured from `flickVelocity` — so its mere arrival IS the
    // velocity signal. We keep the magnitude for the direction check.
    const t = track?.rowKey === rowKey ? track : null;
    if (t === null || t.axis !== 'horizontal') return;
    if (e.edge !== 'left' && e.edge !== 'right') return;
    t.flick = { dx: e.dx, velocity: Math.abs(e.dx) / Math.max(1, e.elapsedMs) };
  };

  const onPanEnd = (e: GestureEvent, rowKey: string): void => {
    const t = track?.rowKey === rowKey ? track : null;
    track = null;
    if (t === null) return;
    if (t.axis !== 'horizontal') {
      if (state.phase === 'tracking') publish({ phase: 'idle', axis: 'none' });
      return;
    }

    const raw = t.baseOffset + e.dx;
    const side = sideForDelta(raw, cfg.direction);
    if (side === null || width(side) === 0) {
      closeInternal('release');
      return;
    }
    const w = width(side);
    const magnitude = Math.abs(raw);

    // Full swipe wins over everything: dragging past `fullSwipeRatio` on a
    // side carrying a destructive action fires it directly on release.
    const destructive = destructiveOf(side);
    if (destructive !== undefined && magnitude >= w * cfg.fullSwipeRatio) {
      void runHandler(rowKey, destructive, 'fullSwipe');
      return;
    }

    // A fast flick commits regardless of distance, provided it points the
    // same way as the reveal; a slow drag commits on distance alone.
    const sign = revealSign(side, cfg.direction);
    const flicked =
      t.flick !== null &&
      Math.sign(t.flick.dx) === sign &&
      t.flick.velocity >= cfg.flickVelocity;
    const dragged = magnitude >= w * cfg.commitRatio;

    if (flicked || dragged) reveal(rowKey, side);
    else closeInternal('release');
  };

  const onTap = (rowKey: string): void => {
    // A tap on a row that is not the open one dismisses the open row —
    // the platform "tap anywhere else to close" behaviour.
    if (state.rowKey !== null && state.rowKey !== rowKey && state.phase !== 'idle') {
      closeInternal('outsideTap');
    }
  };

  const attach = (target: Element, rowKey: string): (() => void) => {
    detacher.get(rowKey)?.();
    const cleanup = bindGestures(
      target,
      (e) => {
        switch (e.kind) {
          case 'pan':
            onPan(e, rowKey);
            break;
          case 'swipe':
            onSwipe(e, rowKey);
            break;
          case 'panEnd':
            onPanEnd(e, rowKey);
            break;
          case 'tap':
          case 'doubleTap':
            onTap(rowKey);
            break;
          default:
            break;
        }
      },
      // One detector, one velocity threshold: the recognizer's swipe
      // classification IS this module's flick classification.
      { swipeVelocity: cfg.flickVelocity, tapSlop: cfg.axisLockSlop },
    );
    const detach = (): void => {
      cleanup();
      detacher.delete(rowKey);
      if (track?.rowKey === rowKey) track = null;
    };
    detacher.set(rowKey, detach);
    return detach;
  };

  return {
    get state() {
      return state;
    },
    get isHorizontalLocked() {
      return state.axis === 'horizontal';
    },
    subscribe(l) {
      listener.add(l);
      return () => listener.delete(l);
    },
    attach,
    open(rowKey, side) {
      if (state.rowKey !== null && state.rowKey !== rowKey && state.phase !== 'idle') {
        const previous = state.rowKey;
        stopAnimation();
        goIdle();
        o.onClose?.(previous, 'otherRow');
      }
      track = null;
      reveal(rowKey, side);
    },
    close(reason = 'programmatic') {
      track = null;
      closeInternal(reason);
    },
    async commit(rowKey, actionId, trigger = 'programmatic') {
      const action = [...set.leading, ...set.trailing].find((a) => a.id === actionId);
      if (action === undefined) {
        throw new Error(`commit: unknown action id "${actionId}"`);
      }
      await runHandler(rowKey, action, trigger);
    },
    notifyScroll() {
      track = null;
      if (state.phase !== 'idle') closeInternal('scroll');
    },
    notifyOutsideTap() {
      track = null;
      if (state.phase !== 'idle') closeInternal('outsideTap');
    },
    tick,
    actionForSide(side) {
      return set[side];
    },
    edgeForSide(side) {
      return edgeForSide(side, cfg.direction);
    },
    revealWidth(side) {
      return width(side);
    },
    menuItem() {
      return rowActionMenuItem(set);
    },
    destroy() {
      stopAnimation();
      for (const [, d] of [...detacher]) d();
      detacher.clear();
      listener.clear();
      track = null;
      state = IDLE_STATE;
    },
  };
}
