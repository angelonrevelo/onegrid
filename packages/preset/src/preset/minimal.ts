// =============================================================================
// @onegrid/preset/minimal
//
// The smallest grid still worth using: virtualized rows and clickable sort
// headers. Nothing else.
//
// Every other feature is listed in `disabled` rather than merely left out of
// `feature`. That is the difference between "not asked for" and "must not
// appear": with an explicit deny list, `extendPreset(minimalPreset, ...)` and
// any dependency edge that would drag a feature in raise
// FeatureDependencyError instead of quietly growing the bundle. A minimal
// preset that can be accidentally un-minimalized is not one.
// =============================================================================

import type { Preset } from '../type.js';

/**
 * Virtual scroll plus sort. The floor.
 * @public
 */
export const minimalPreset: Preset = {
  name: 'minimal',
  description:
    'The smallest useful grid: virtualized rows and sortable headers, with every optional feature explicitly denied so nothing can creep back in.',
  feature: ['sort'],
  disabled: [
    'filter',
    'grouping',
    'pivot',
    'tree',
    'masterDetail',
    'editing',
    'clipboard',
    'fillHandle',
    'formula',
    'chart',
    'sparkline',
    'export',
    'find',
    'columnResize',
    'rowResize',
    'rowReorder',
    'columnReorder',
    'contextMenu',
    'toolPanel',
    'statusBar',
    'selectionCheckbox',
    'undo',
    'columnGroup',
    'pinnedRow',
    'overlay',
    'flashCell',
    'touch',
    'i18n',
    'serverSideRow',
    'duckdb',
  ],
  density: 'compact',
  theme: 'dark',
  interaction: {
    pointer: 'fine',
    hitTargetPx: 24,
    hoverAffordance: true,
    swipeAction: false,
    keyboardFirst: true,
    motion: 'none',
    readOnly: true,
    virtualScroll: true,
    overscanRow: 2,
  },
};

export default minimalPreset;
