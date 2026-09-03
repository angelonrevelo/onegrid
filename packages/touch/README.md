# @onegrid/touch

Touch / mobile interaction surface for oneGrid. 5.8 KB gz.

- **`bindGestures(target, listener, opts)`** — Pointer-Events-3
  recognizer for `tap`, `doubleTap`, `longPress` (≥500 ms), `pan`,
  `panEnd`, `swipe`, `dragFromEdge`. Cleans up on `pointercancel`.
- **`touchCss(selector?)`** — emits the four-property CSS oneGrid
  expects on the host: `touch-action: manipulation` on tappables,
  `none` on drag affordances, `pan-x pan-y` on the grid body
  reserving pinch for the OS, `overscroll-behavior: contain` to
  prevent scroll-chaining, and a `(pointer: coarse)` block that
  bumps row height + chevron hit-zone to `--og-size-touch-hit-zone`
  so Apple HIG 44pt / Material 48dp is met without forcing
  `density="spacious"` on desktop.
- **`attachVirtualKeyboard(onInset)`** — prefers the VirtualKeyboard
  API (Chromium-only, sets `overlaysContent: true` and listens for
  `geometrychange`); falls back to `visualViewport` resize tracking
  for iOS Safari. Returns a cleanup function.
- **`inputmodeForColumn(type)`** — maps a protocol `ColumnType` to
  the HTML `inputmode` value cell editors should use so the soft
  keyboard surfaces the right glyph set.
- **`createSwipeRowController({ action, option })`** — swipe-to-reveal
  row actions built *on top of* `bindGestures` (one detector, one
  velocity threshold). Rubber-band resistance, velocity-vs-distance
  commit, iOS full-swipe-to-delete, one-open-row, axis locking, RTL
  mirroring, reduced-motion, and an accessible non-swipe path via
  `rowActionMenuItem`.

## Quickstart

```ts
import {
  bindGestures, touchCss, attachVirtualKeyboard, inputmodeForColumn,
} from '@onegrid/touch';

// CSS — drop once at app boot
document.adoptedStyleSheets.push(
  new CSSStyleSheet().replaceSync(touchCss()),
);

// Gestures
const cleanup = bindGestures(gridBodyEl, (e) => {
  if (e.kind === 'longPress') openContextMenu(e.x, e.y);
  if (e.kind === 'dragFromEdge' && e.edge === 'left') startRowSelectDrag(e);
});

// Virtual keyboard inset for sticky footers
attachVirtualKeyboard((inset) => {
  document.documentElement.style.setProperty('--og-vk-inset', `${inset}px`);
});

// Cell editor — let the soft keyboard help
<input inputmode={inputmodeForColumn('float64')} />  // 'decimal'
```

## Swipe-to-reveal row actions

The iOS/Android "swipe a row to reveal Archive / Delete" affordance,
headless: the controller emits state, your renderer draws it.

```ts
import {
  defineRowAction, defineRowActionSet, createSwipeRowController,
  rowActionMenuItem,
} from '@onegrid/touch';

const action = defineRowActionSet([
  defineRowAction({
    side: 'leading', id: 'pin', label: 'Pin',
    intent: 'constructive', width: 72,
    handler: (c) => pinRow(c.rowKey),
  }),
  defineRowAction({
    side: 'trailing', id: 'archive', label: 'Archive',
    intent: 'default', width: 88,
    handler: (c) => archiveRow(c.rowKey),
  }),
  defineRowAction({
    side: 'trailing', id: 'delete', label: 'Delete',
    intent: 'destructive', width: 88,
    // `c.trigger` is 'fullSwipe' when the user swiped all the way across.
    handler: (c) => deleteRow(c.rowKey, { confirm: c.trigger !== 'fullSwipe' }),
  }),
]);

const controller = createSwipeRowController({
  action,
  option: {
    direction: document.dir === 'rtl' ? 'rtl' : 'ltr',
    onAnnounce: (text) => { liveRegionEl.textContent = text; },
  },
});

// One controller, many rows — the one-open-row invariant is free.
const detach = controller.attach(rowEl, 'row-7');

controller.subscribe((s) => {
  rowEl.style.transform = `translateX(${s.offset}px)`;
  rowEl.style.transition = 'none';               // the controller animates
  rowEl.classList.toggle('og-full-swipe', s.fullSwipeArmed);
});

// A scroll or a tap elsewhere dismisses the open row.
scrollerEl.addEventListener('scroll', () => controller.notifyScroll());
document.addEventListener('pointerdown', (e) => {
  if (!gridEl.contains(e.target as Node)) controller.notifyOutsideTap();
});

// The accessible path — swipe is never the only way to reach an action.
for (const item of rowActionMenuItem(action)) {
  menuEl.append(renderMenuItem(item, () => item.activate('row-7')));
}
```

### Behaviour

| Concern | What it does |
| --- | --- |
| Phases | `idle → tracking → revealed → committing → idle`, plus `closing` |
| Rubber-banding | UIScrollView curve `(1 - 1/(over·f/d + 1))·d`, asymptotic — not a clamp |
| Commit | fast flick (≥ `flickVelocity`, reusing the recognizer's own swipe classification) **or** slow drag past `commitRatio × revealWidth` |
| Full swipe | past `fullSwipeRatio × revealWidth` fires the side's `destructive` action on release |
| One open row | opening a row, scrolling, or tapping another row closes the previous one |
| Axis lock | decided once past `axisLockSlop`, never revisited; a vertical lock hands the pointer to the scroller and closes any reveal |
| RTL | `leading`/`trailing` are logical; `edgeForSide` / `revealSign` mirror them |
| Reduced motion | `prefers-reduced-motion` snaps instantly instead of animating |
| Hit targets | every action width is raised to `MIN_TOUCH_TARGET_PX` (44) |

`state.settleProgress` is 0..1 across the snap animation and
`state.progress` is `|offset| / revealWidth` (it exceeds 1 while
rubber-banding), so a renderer can drive both the translate and the
action-icon reveal without owning any timing itself. Pass
`option.scheduleFrame` / `option.now` to drive animation from an
existing render loop or a test clock.

## Defaults

`DEFAULT_LONG_PRESS_ACTION` is `'context-menu'` — matches Android
+ iOS platform conventions. Opt-in `'row-drag'` for
spreadsheet-style apps where long-press should pick up the row.

## Standards

- W3C Pointer Events Level 3 (https://www.w3.org/TR/pointerevents3/)
- CSS `touch-action` (CSS Pointer Events 2)
- CSS `overscroll-behavior` (CSS Overscroll Behavior Module 1)
- VirtualKeyboard API (https://www.w3.org/TR/virtual-keyboard/)
- HTML `inputmode` (HTML Living Standard)

## License

MIT
