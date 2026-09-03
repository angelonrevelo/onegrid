import { describe, it, expect, vi } from 'vitest';
import {
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
} from '../index.js';
import type {
  RowAction,
  RowActionContext,
  RowActionSet,
  SwipeRowOption,
  SwipeRowPhase,
  SwipeRowState,
} from '../index.js';

// -----------------------------------------------------------------------------
// Harness — jsdom ships no PointerEvent, so synthesize the fields the
// recognizer reads. Every controller test drives real DOM events through
// bindGestures, which is the point: it proves the controller reuses the
// existing recognizer rather than sniffing pointers itself.
// -----------------------------------------------------------------------------

function makeRow(): Element {
  const el = document.createElement('div');
  Object.defineProperty(el, 'getBoundingClientRect', {
    value: () => ({
      left: 0,
      top: 0,
      right: 1000,
      bottom: 800,
      width: 1000,
      height: 800,
      x: 0,
      y: 0,
      toJSON() {
        return {};
      },
    }),
  });
  return el;
}

function pointer(
  type: string,
  x: number,
  y: number,
  timeStamp: number,
  pointerId = 1,
): Event {
  const evt = new Event(type, { bubbles: true });
  Object.defineProperty(evt, 'pointerId', { value: pointerId });
  Object.defineProperty(evt, 'clientX', { value: x });
  Object.defineProperty(evt, 'clientY', { value: y });
  Object.defineProperty(evt, 'pointerType', { value: 'touch' });
  Object.defineProperty(evt, 'timeStamp', { value: timeStamp });
  return evt;
}

interface Step {
  readonly x: number;
  readonly y: number;
  readonly t: number;
}

/** Dispatch a full down → move* → up sequence starting at (x0, y0) at t=0. */
function drag(target: Element, x0: number, y0: number, step: readonly Step[]): void {
  target.dispatchEvent(pointer('pointerdown', x0, y0, 0));
  for (const s of step) target.dispatchEvent(pointer('pointermove', s.x, s.y, s.t));
  const last = step[step.length - 1] ?? { x: x0, y: y0, t: 0 };
  target.dispatchEvent(pointer('pointerup', last.x, last.y, last.t));
}

function tap(target: Element, x = 500, y = 400): void {
  target.dispatchEvent(pointer('pointerdown', x, y, 0));
  target.dispatchEvent(pointer('pointerup', x, y, 30));
}

// leading = 1 action (60 px). trailing = 2 actions (80 + 80 = 160 px).
// commit threshold = 80, full-swipe threshold = 256.
function makeSet(fired: RowActionContext[]): RowActionSet {
  return defineRowActionSet([
    defineRowAction({
      side: 'leading',
      id: 'pin',
      label: 'Pin',
      icon: 'pin',
      intent: 'constructive',
      width: 60,
      handler: (c) => {
        fired.push(c);
      },
    }),
    defineRowAction({
      side: 'trailing',
      id: 'archive',
      label: 'Archive',
      intent: 'default',
      width: 80,
      handler: (c) => {
        fired.push(c);
      },
    }),
    defineRowAction({
      side: 'trailing',
      id: 'delete',
      label: 'Delete',
      intent: 'destructive',
      width: 80,
      handler: (c) => {
        fired.push(c);
      },
    }),
  ]);
}

function setup(option: SwipeRowOption = {}) {
  const fired: RowActionContext[] = [];
  const action = makeSet(fired);
  const controller = createSwipeRowController({
    action,
    option: { reduceMotion: true, ...option },
  });
  const row = makeRow();
  const detach = controller.attach(row, 'row-1');
  return { fired, action, controller, row, detach };
}

// -----------------------------------------------------------------------------
// Action definition
// -----------------------------------------------------------------------------

describe('defineRowAction', () => {
  const noop = (): void => {};

  it('raises a sub-44px width to the Apple HIG hit-target floor', () => {
    const a = defineRowAction({
      side: 'trailing',
      id: 'x',
      label: 'X',
      intent: 'default',
      width: 12,
      handler: noop,
    });
    expect(a.width).toBe(MIN_TOUCH_TARGET_PX);
    expect(MIN_TOUCH_TARGET_PX).toBe(44);
  });

  it('defaults width to the hit-target floor and keeps larger widths', () => {
    const small = defineRowAction({
      side: 'leading',
      id: 'a',
      label: 'A',
      intent: 'default',
      handler: noop,
    });
    const big = defineRowAction({
      side: 'leading',
      id: 'b',
      label: 'B',
      intent: 'default',
      width: 120,
      handler: noop,
    });
    expect(small.width).toBe(44);
    expect(big.width).toBe(120);
  });

  it('rejects a blank id or label — both are screen-reader load-bearing', () => {
    expect(() =>
      defineRowAction({ side: 'leading', id: ' ', label: 'A', intent: 'default', handler: noop }),
    ).toThrow(/id must be non-empty/);
    expect(() =>
      defineRowAction({ side: 'leading', id: 'a', label: '', intent: 'default', handler: noop }),
    ).toThrow(/must have a label/);
  });

  it('groups a flat list by side and rejects duplicate ids', () => {
    const set = makeSet([]);
    expect(set.leading.map((a) => a.id)).toEqual(['pin']);
    expect(set.trailing.map((a) => a.id)).toEqual(['archive', 'delete']);
    expect(revealWidth(set, 'leading')).toBe(60);
    expect(revealWidth(set, 'trailing')).toBe(160);

    const dup: RowAction[] = [
      defineRowAction({ side: 'leading', id: 'z', label: 'Z', intent: 'default', handler: noop }),
      defineRowAction({ side: 'trailing', id: 'z', label: 'Z', intent: 'default', handler: noop }),
    ];
    expect(() => defineRowActionSet(dup)).toThrow(/duplicate action id/);
  });
});

// -----------------------------------------------------------------------------
// RTL mirroring
// -----------------------------------------------------------------------------

describe('RTL mirroring', () => {
  it('mirrors the physical edge of each logical side', () => {
    expect(edgeForSide('leading', 'ltr')).toBe('left');
    expect(edgeForSide('trailing', 'ltr')).toBe('right');
    expect(edgeForSide('leading', 'rtl')).toBe('right');
    expect(edgeForSide('trailing', 'rtl')).toBe('left');
  });

  it('mirrors the drag sign that reveals each side', () => {
    expect(revealSign('leading', 'ltr')).toBe(1);
    expect(revealSign('trailing', 'ltr')).toBe(-1);
    expect(revealSign('leading', 'rtl')).toBe(-1);
    expect(revealSign('trailing', 'rtl')).toBe(1);
  });

  it('maps a delta to the logical side, mirrored by direction', () => {
    expect(sideForDelta(50, 'ltr')).toBe('leading');
    expect(sideForDelta(-50, 'ltr')).toBe('trailing');
    expect(sideForDelta(50, 'rtl')).toBe('trailing');
    expect(sideForDelta(-50, 'rtl')).toBe('leading');
    expect(sideForDelta(0, 'ltr')).toBeNull();
  });

  it('reveals the leading side on a leftward drag under RTL', () => {
    const { controller, row } = setup({ direction: 'rtl' });
    drag(row, 500, 400, [
      { x: 460, y: 400, t: 500 },
      { x: 420, y: 400, t: 1000 },
    ]);
    expect(controller.state.phase).toBe('revealed');
    expect(controller.state.side).toBe('leading');
    // leading is the right-hand edge in RTL, so the content moves left.
    expect(controller.state.offset).toBe(-60);
    expect(controller.edgeForSide('leading')).toBe('right');
  });

  it('reveals the trailing side on a rightward drag under RTL', () => {
    const { controller, row } = setup({ direction: 'rtl' });
    drag(row, 200, 400, [
      { x: 280, y: 400, t: 500 },
      { x: 340, y: 400, t: 1000 },
    ]);
    expect(controller.state.side).toBe('trailing');
    expect(controller.state.offset).toBe(160);
  });
});

// -----------------------------------------------------------------------------
// Rubber-banding
// -----------------------------------------------------------------------------

describe('rubber-banding', () => {
  it('is the identity below the limit and eases above it', () => {
    expect(resistedOffset(50, 100)).toBe(50);
    expect(resistedOffset(100, 100)).toBe(100);
    const over = resistedOffset(200, 100);
    expect(over).toBeGreaterThan(100);
    expect(over).toBeLessThan(200);
    expect(over).toBeCloseTo(135.48, 1);
  });

  it('is asymptotic — overdrag never exceeds one extra dimension', () => {
    expect(rubberBand(0, 100)).toBe(0);
    expect(rubberBand(1e9, 100)).toBeLessThan(100);
    expect(rubberBand(1e9, 100)).toBeGreaterThan(99);
    // Monotonic and decelerating.
    const a = rubberBand(50, 100);
    const b = rubberBand(100, 100);
    const c = rubberBand(150, 100);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
    expect(c - b).toBeLessThan(b - a);
  });

  it('preserves sign and yields nothing when the side is empty', () => {
    expect(resistedOffset(-200, 100)).toBeCloseTo(-135.48, 1);
    expect(resistedOffset(-200, 0)).toBe(0);
    expect(resistedOffset(200, 0)).toBe(0);
  });

  it('applies resistance to the live offset past the reveal width', () => {
    const { controller, row } = setup();
    const row1 = row;
    row1.dispatchEvent(pointer('pointerdown', 500, 400, 0));
    row1.dispatchEvent(pointer('pointermove', 300, 400, 1000)); // raw -200, limit 160
    const s = controller.state;
    expect(s.phase).toBe('tracking');
    expect(Math.abs(s.offset)).toBeGreaterThan(160);
    expect(Math.abs(s.offset)).toBeLessThan(200);
    expect(s.progress).toBeGreaterThan(1);
  });
});

// -----------------------------------------------------------------------------
// State machine
// -----------------------------------------------------------------------------

describe('swipe row state machine', () => {
  it('starts idle', () => {
    const { controller } = setup();
    expect(controller.state).toMatchObject({
      phase: 'idle',
      rowKey: null,
      side: null,
      offset: 0,
      axis: 'none',
      settleProgress: 1,
    });
  });

  it('walks idle → tracking → revealed → committing → closing → idle', async () => {
    const { controller, row, fired } = setup();
    const phase: SwipeRowPhase[] = [];
    controller.subscribe((s: SwipeRowState) => {
      if (phase[phase.length - 1] !== s.phase) phase.push(s.phase);
    });
    drag(row, 500, 400, [
      { x: 440, y: 400, t: 500 },
      { x: 380, y: 400, t: 1000 },
    ]);
    expect(controller.state.phase).toBe('revealed');
    await controller.commit('row-1', 'archive', 'swipe');
    expect(phase).toEqual(['tracking', 'revealed', 'committing', 'closing', 'idle']);
    expect(fired.map((f) => f.action.id)).toEqual(['archive']);
    expect(fired[0]?.trigger).toBe('swipe');
  });

  it('commits on distance alone when the drag is slow', () => {
    const { controller, row } = setup();
    // 100 px over 1000 ms = 0.1 px/ms, well under the 0.3 flick threshold,
    // but past the 80 px (0.5 × 160) distance threshold.
    drag(row, 500, 400, [
      { x: 450, y: 400, t: 500 },
      { x: 400, y: 400, t: 1000 },
    ]);
    expect(controller.state.phase).toBe('revealed');
    expect(controller.state.side).toBe('trailing');
    expect(controller.state.offset).toBe(-160);
    expect(controller.state.progress).toBe(1);
  });

  it('commits on velocity when the distance threshold was never met', () => {
    const { controller, row } = setup();
    // 40 px (< 80) but 0.8 px/ms — a flick.
    drag(row, 500, 400, [
      { x: 480, y: 400, t: 25 },
      { x: 460, y: 400, t: 50 },
    ]);
    expect(controller.state.phase).toBe('revealed');
    expect(controller.state.offset).toBe(-160);
  });

  it('closes when the drag is both short and slow', () => {
    const { controller, row } = setup();
    const closed: [string, string][] = [];
    controller.subscribe(() => undefined);
    drag(row, 500, 400, [
      { x: 480, y: 400, t: 500 },
      { x: 460, y: 400, t: 1000 },
    ]);
    expect(closed).toEqual([]);
    expect(controller.state.phase).toBe('idle');
    expect(controller.state.offset).toBe(0);
  });

  it('reports the close reason to onClose', () => {
    const closed: [string, string][] = [];
    const { controller, row } = setup({
      onClose: (rowKey, reason) => closed.push([rowKey, reason]),
    });
    drag(row, 500, 400, [
      { x: 480, y: 400, t: 500 },
      { x: 460, y: 400, t: 1000 },
    ]);
    expect(closed).toEqual([['row-1', 'release']]);
    expect(controller.state.phase).toBe('idle');
  });

  it('does nothing on a side with no actions', () => {
    const fired: RowActionContext[] = [];
    const action = defineRowActionSet([
      defineRowAction({
        side: 'trailing',
        id: 'del',
        label: 'Delete',
        intent: 'destructive',
        handler: (c) => {
          fired.push(c);
        },
      }),
    ]);
    const empty = createSwipeRowController({ action, option: { reduceMotion: true } });
    const row = makeRow();
    empty.attach(row, 'r');
    expect(empty.revealWidth('leading')).toBe(0);
    drag(row, 200, 400, [
      { x: 300, y: 400, t: 500 },
      { x: 400, y: 400, t: 1000 },
    ]);
    expect(empty.state.phase).toBe('idle');
    expect(empty.state.offset).toBe(0);
  });

  it('resumes from the current offset when an open row is grabbed again', () => {
    const { controller, row } = setup();
    controller.open('row-1', 'trailing');
    expect(controller.state.offset).toBe(-160);
    // A small extra pull from the open position rubber-bands past the width.
    row.dispatchEvent(pointer('pointerdown', 500, 400, 0));
    row.dispatchEvent(pointer('pointermove', 460, 400, 500));
    expect(Math.abs(controller.state.offset)).toBeGreaterThan(160);
  });

  it('cancels cleanly when the pointer is cancelled mid-gesture', () => {
    const { controller, row } = setup();
    row.dispatchEvent(pointer('pointerdown', 500, 400, 0));
    row.dispatchEvent(pointer('pointermove', 420, 400, 500));
    expect(controller.state.phase).toBe('tracking');
    row.dispatchEvent(pointer('pointercancel', 420, 400, 600));
    controller.close('cancel');
    expect(controller.state.phase).toBe('idle');
    expect(controller.state.offset).toBe(0);
  });
});

// -----------------------------------------------------------------------------
// Full-swipe destructive commit
// -----------------------------------------------------------------------------

describe('full-swipe destructive commit', () => {
  it('arms past the full-swipe threshold and fires the destructive action on release', async () => {
    const { controller, row, fired } = setup();
    row.dispatchEvent(pointer('pointerdown', 600, 400, 0));
    row.dispatchEvent(pointer('pointermove', 400, 400, 1000)); // raw -200 < 256
    expect(controller.state.fullSwipeArmed).toBe(false);
    row.dispatchEvent(pointer('pointermove', 300, 400, 2000)); // raw -300 >= 256
    expect(controller.state.fullSwipeArmed).toBe(true);
    row.dispatchEvent(pointer('pointerup', 300, 400, 2000));
    await Promise.resolve();
    expect(fired.map((f) => [f.action.id, f.trigger])).toEqual([['delete', 'fullSwipe']]);
    expect(controller.state.phase).toBe('idle');
  });

  it('never arms a full swipe on a side with no destructive action', () => {
    const { controller, row, fired } = setup();
    // Leading holds only the constructive "Pin"; 60 × 1.6 = 96 px.
    row.dispatchEvent(pointer('pointerdown', 200, 400, 0));
    row.dispatchEvent(pointer('pointermove', 500, 400, 1000)); // raw +300
    expect(controller.state.side).toBe('leading');
    expect(controller.state.fullSwipeArmed).toBe(false);
    row.dispatchEvent(pointer('pointerup', 500, 400, 1000));
    expect(fired).toEqual([]);
    // It still latches open, because the distance threshold was passed.
    expect(controller.state.phase).toBe('revealed');
    expect(controller.state.offset).toBe(60);
  });

  it('waits for an async handler before returning to idle', async () => {
    let release: (() => void) | null = null;
    const fired: string[] = [];
    const action = defineRowActionSet([
      defineRowAction({
        side: 'trailing',
        id: 'slow',
        label: 'Slow',
        intent: 'destructive',
        handler: () =>
          new Promise<void>((res) => {
            release = () => {
              fired.push('slow');
              res();
            };
          }),
      }),
    ]);
    const controller = createSwipeRowController({ action, option: { reduceMotion: true } });
    const pending = controller.commit('r', 'slow');
    expect(controller.state.phase).toBe('committing');
    expect(controller.state.committingActionId).toBe('slow');
    release!();
    await pending;
    expect(fired).toEqual(['slow']);
    expect(controller.state.phase).toBe('idle');
  });

  it('rejects a commit for an unknown action id', async () => {
    const { controller } = setup();
    await expect(controller.commit('row-1', 'nope')).rejects.toThrow(/unknown action id/);
  });
});

// -----------------------------------------------------------------------------
// Axis locking
// -----------------------------------------------------------------------------

describe('axis locking', () => {
  it('locks vertical and refuses to move the row afterwards', () => {
    const { controller, row } = setup();
    row.dispatchEvent(pointer('pointerdown', 500, 400, 0));
    row.dispatchEvent(pointer('pointermove', 502, 440, 100)); // dominantly vertical
    expect(controller.state.axis).toBe('vertical');
    expect(controller.isHorizontalLocked).toBe(false);
    row.dispatchEvent(pointer('pointermove', 300, 440, 200)); // big horizontal — ignored
    expect(controller.state.offset).toBe(0);
    expect(controller.state.side).toBeNull();
    row.dispatchEvent(pointer('pointerup', 300, 440, 200));
    expect(controller.state.phase).toBe('idle');
  });

  it('locks horizontal and refuses to give the gesture up to a scroll', () => {
    const { controller, row } = setup();
    row.dispatchEvent(pointer('pointerdown', 500, 400, 0));
    row.dispatchEvent(pointer('pointermove', 440, 400, 100)); // dominantly horizontal
    expect(controller.state.axis).toBe('horizontal');
    expect(controller.isHorizontalLocked).toBe(true);
    row.dispatchEvent(pointer('pointermove', 440, 700, 200)); // big vertical — ignored
    expect(controller.state.axis).toBe('horizontal');
    expect(controller.state.offset).toBe(-60);
  });

  it('does not decide an axis below the slop', () => {
    const { controller, row } = setup({ axisLockSlop: 40 });
    row.dispatchEvent(pointer('pointerdown', 500, 400, 0));
    row.dispatchEvent(pointer('pointermove', 480, 400, 100));
    expect(controller.state.axis).toBe('none');
    expect(controller.state.offset).toBe(0);
  });

  it('a vertical lock closes a row that was already open', () => {
    const closed: string[] = [];
    const { controller, row } = setup({ onClose: (_k, reason) => closed.push(reason) });
    controller.open('row-1', 'trailing');
    expect(controller.state.phase).toBe('revealed');
    row.dispatchEvent(pointer('pointerdown', 500, 400, 0));
    row.dispatchEvent(pointer('pointermove', 502, 460, 100));
    expect(closed).toEqual(['scroll']);
    expect(controller.state.phase).toBe('idle');
  });
});

// -----------------------------------------------------------------------------
// One-open-row invariant
// -----------------------------------------------------------------------------

describe('single open row invariant', () => {
  it('opening a second row closes the first', () => {
    const closed: [string, string][] = [];
    const { controller } = setup({
      onClose: (rowKey, reason) => closed.push([rowKey, reason]),
    });
    const rowB = makeRow();
    controller.attach(rowB, 'row-2');
    controller.open('row-1', 'trailing');
    controller.open('row-2', 'leading');
    expect(closed).toEqual([['row-1', 'otherRow']]);
    expect(controller.state.rowKey).toBe('row-2');
    expect(controller.state.offset).toBe(60);
  });

  it('swiping a second row closes the first', () => {
    const closed: [string, string][] = [];
    const { controller } = setup({
      onClose: (rowKey, reason) => closed.push([rowKey, reason]),
    });
    const rowB = makeRow();
    controller.attach(rowB, 'row-2');
    controller.open('row-1', 'trailing');
    drag(rowB, 500, 400, [
      { x: 450, y: 400, t: 500 },
      { x: 400, y: 400, t: 1000 },
    ]);
    expect(closed[0]).toEqual(['row-1', 'otherRow']);
    expect(controller.state.rowKey).toBe('row-2');
    expect(controller.state.phase).toBe('revealed');
  });

  it('a tap on another row dismisses the open one', () => {
    const closed: [string, string][] = [];
    const { controller } = setup({
      onClose: (rowKey, reason) => closed.push([rowKey, reason]),
    });
    const rowB = makeRow();
    controller.attach(rowB, 'row-2');
    controller.open('row-1', 'trailing');
    tap(rowB);
    expect(closed).toEqual([['row-1', 'outsideTap']]);
    expect(controller.state.phase).toBe('idle');
  });

  it('a scroll or an outside tap closes the open row', () => {
    const closed: string[] = [];
    const { controller } = setup({ onClose: (_k, reason) => closed.push(reason) });
    controller.open('row-1', 'trailing');
    controller.notifyScroll();
    expect(controller.state.phase).toBe('idle');
    controller.open('row-1', 'leading');
    controller.notifyOutsideTap();
    expect(controller.state.phase).toBe('idle');
    expect(closed).toEqual(['scroll', 'outsideTap']);
  });

  it('detaching a row stops it driving the controller', () => {
    const { controller, row, detach } = setup();
    detach();
    drag(row, 500, 400, [
      { x: 450, y: 400, t: 500 },
      { x: 400, y: 400, t: 1000 },
    ]);
    expect(controller.state.phase).toBe('idle');
  });

  it('destroy() detaches every row and clears subscribers', () => {
    const { controller, row } = setup();
    const seen: SwipeRowState[] = [];
    controller.subscribe((s) => seen.push(s));
    controller.destroy();
    drag(row, 500, 400, [
      { x: 450, y: 400, t: 500 },
      { x: 400, y: 400, t: 1000 },
    ]);
    expect(seen).toEqual([]);
    expect(controller.state.phase).toBe('idle');
  });
});

// -----------------------------------------------------------------------------
// Animation / reduced motion
// -----------------------------------------------------------------------------

describe('snap animation', () => {
  it('advances settleProgress across frames and lands exactly on target', () => {
    let clock = 0;
    const frame: (() => void)[] = [];
    const { controller } = setup({
      reduceMotion: false,
      snapDurationMs: 200,
      now: () => clock,
      scheduleFrame: (cb) => {
        frame.push(cb);
        return () => undefined;
      },
    });
    controller.open('row-1', 'trailing');
    expect(controller.state.settleProgress).toBe(0);
    expect(controller.state.offset).toBe(0);

    const step = (ms: number): void => {
      clock += ms;
      const next = frame.shift();
      next?.();
    };
    step(100);
    expect(controller.state.settleProgress).toBeCloseTo(0.5, 5);
    expect(controller.state.offset).toBeLessThan(0);
    expect(controller.state.offset).toBeGreaterThan(-160);
    const midway = controller.state.offset;
    step(60);
    expect(controller.state.offset).toBeLessThan(midway);
    step(100);
    expect(controller.state.settleProgress).toBe(1);
    expect(controller.state.offset).toBe(-160);
    expect(controller.state.phase).toBe('revealed');
  });

  it('honours prefers-reduced-motion by snapping instantly, scheduling no frame', () => {
    const scheduleFrame = vi.fn(() => () => undefined);
    const { controller } = setup({ reduceMotion: true, scheduleFrame });
    controller.open('row-1', 'trailing');
    expect(controller.state.offset).toBe(-160);
    expect(controller.state.settleProgress).toBe(1);
    controller.close();
    expect(controller.state.offset).toBe(0);
    expect(controller.state.phase).toBe('idle');
    expect(scheduleFrame).not.toHaveBeenCalled();
  });

  it('reads the media query when reduceMotion is not given', () => {
    expect(typeof prefersReducedMotion()).toBe('boolean');
    const original = window.matchMedia;
    // @ts-expect-error — deliberately removing the API to exercise the fallback.
    delete window.matchMedia;
    expect(prefersReducedMotion()).toBe(false);
    window.matchMedia = original;
  });
});

// -----------------------------------------------------------------------------
// Accessibility
// -----------------------------------------------------------------------------

describe('accessible action list', () => {
  it('projects every action, both sides, onto activatable menu items', () => {
    const fired: RowActionContext[] = [];
    const set = makeSet(fired);
    const item = rowActionMenuItem(set);
    expect(item.map((i) => i.id)).toEqual(['pin', 'archive', 'delete']);
    expect(item.every((i) => i.role === 'menuitem')).toBe(true);
    expect(item.every((i) => i.minSizePx === MIN_TOUCH_TARGET_PX)).toBe(true);
    expect(item.find((i) => i.id === 'pin')?.side).toBe('leading');
    expect(item.find((i) => i.id === 'pin')?.icon).toBe('pin');
  });

  it('marks destructive items in the accessible name', () => {
    const item = rowActionMenuItem(makeSet([]));
    expect(item.find((i) => i.id === 'delete')?.ariaLabel).toBe('Delete (destructive)');
    expect(item.find((i) => i.id === 'archive')?.ariaLabel).toBe('Archive');
  });

  it('activating a menu item runs the same handler with trigger "menu"', async () => {
    const fired: RowActionContext[] = [];
    const item = rowActionMenuItem(makeSet(fired));
    await item.find((i) => i.id === 'delete')?.activate('row-9');
    expect(fired).toHaveLength(1);
    expect(fired[0]?.rowKey).toBe('row-9');
    expect(fired[0]?.trigger).toBe('menu');
    expect(fired[0]?.action.id).toBe('delete');
  });

  it('accepts a flat action list as well as a set', () => {
    const set = makeSet([]);
    expect(rowActionMenuItem([...set.trailing]).map((i) => i.id)).toEqual([
      'archive',
      'delete',
    ]);
  });

  it('exposes the same menu through the controller', () => {
    const { controller } = setup();
    expect(controller.menuItem().map((i) => i.id)).toEqual(['pin', 'archive', 'delete']);
    expect(controller.actionForSide('trailing').map((a) => a.id)).toEqual([
      'archive',
      'delete',
    ]);
  });

  it('announces reveal, commit and dismissal', async () => {
    const said: string[] = [];
    const { controller, row } = setup({ onAnnounce: (t) => said.push(t) });
    drag(row, 500, 400, [
      { x: 450, y: 400, t: 500 },
      { x: 400, y: 400, t: 1000 },
    ]);
    expect(said).toEqual(['Row actions available: Archive, Delete']);
    expect(controller.state.announcement).toBe('Row actions available: Archive, Delete');
    await controller.commit('row-1', 'delete');
    expect(said).toEqual([
      'Row actions available: Archive, Delete',
      'Delete activated',
      'Row actions dismissed',
    ]);
  });

  it('lets an adopter localise the announcement', () => {
    const said: string[] = [];
    const { controller } = setup({
      onAnnounce: (t) => said.push(t),
      formatAnnouncement: (i) => `${i.kind}:${i.side ?? '-'}:${i.action.length}`,
    });
    controller.open('row-1', 'leading');
    expect(said[0]).toBe('revealed:leading:1');
  });
});
