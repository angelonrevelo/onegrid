// =============================================================================
// @onegrid/preset/mobile
//
// The coarse-pointer profile. Three physical facts drive every value here:
//
//  1. A fingertip contact patch is roughly 8-10 mm. 44 CSS px is the Apple HIG
//     figure and the WCAG 2.2 AAA (2.5.5) target size; anything smaller is a
//     mis-tap generator. Hence comfortable density, not compact.
//  2. A finger cannot hover. Every affordance that only appears on :hover is
//     invisible on touch, and sticky :hover after a tap is a known bug class —
//     so hoverAffordance is false and the affordances move to swipe and
//     long-press, both of which a finger can actually perform.
//  3. Drag handles are precision targets. A column-resize gutter is ~6 px and
//     a fill handle is a 4x4 px square; neither is reachable with a finger,
//     and both compete with the scroll gesture. They are disabled outright.
//
// Editing stays ON — mobile data entry is real — but it runs through the
// VirtualKeyboard adaptation in @onegrid/touch, which is why `touch` is in the
// feature list rather than being treated as a styling concern.
// =============================================================================

import type { Preset } from '../type.js';

/**
 * Phone and tablet. 44 px hit targets, swipe row actions, no hover, no drag
 * handles.
 * @public
 */
export const mobilePreset: Preset = {
  name: 'mobile',
  description:
    'Coarse-pointer grid: 44 px hit targets, comfortable density, swipe row actions, long-press context menu, virtual-keyboard-aware editing, no hover affordance and no drag handles.',
  feature: [
    'sort',
    'filter',
    'editing',
    'find',
    'contextMenu',
    'masterDetail',
    'selectionCheckbox',
    'touch',
    'i18n',
    'overlay',
  ],
  disabled: [
    'columnResize',
    'rowResize',
    'fillHandle',
    'rowReorder',
    'columnReorder',
    'toolPanel',
    'pivot',
    'chart',
    'statusBar',
    'columnGroup',
    'formula',
  ],
  density: 'comfortable',
  theme: 'auto',
  interaction: {
    pointer: 'coarse',
    hitTargetPx: 44,
    hoverAffordance: false,
    swipeAction: true,
    keyboardFirst: false,
    motion: 'full',
    readOnly: false,
    virtualScroll: true,
    // Fling scrolling on touch outruns the render loop badly; a deep overscan
    // is the difference between a smooth fling and a band of blank rows.
    overscanRow: 32,
  },
};

export default mobilePreset;
