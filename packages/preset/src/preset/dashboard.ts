// =============================================================================
// @onegrid/preset/dashboard
//
// The read-only monitoring profile. The grid is one tile among several on a
// screen somebody glances at, so it optimizes for comprehension at a distance
// rather than manipulation: comfortable density, grouped rows with aggregates
// pinned as totals, in-cell sparklines for trend, range charts for detail, and
// a flash on every changed cell so a live feed is visible without staring.
//
// `readOnly` is enforced twice — as an interaction flag AND by putting the
// whole editing family in `disabled`, so the editing machinery is never
// constructed rather than merely hidden behind a predicate.
// =============================================================================

import type { Preset } from '../type.js';

/**
 * Live read-only dashboard tile. Comfortable, theme-following, chart-heavy.
 * @public
 */
export const dashboardPreset: Preset = {
  name: 'dashboard',
  description:
    'Read-only monitoring grid: grouped rows with aggregates, pinned totals, in-cell sparklines, range charts, and cell flash on live updates.',
  feature: [
    'sort',
    'filter',
    'grouping',
    'chart',
    'sparkline',
    'statusBar',
    'pinnedRow',
    'columnGroup',
    'flashCell',
    'overlay',
    'export',
    'i18n',
  ],
  disabled: [
    'editing',
    'clipboard',
    'fillHandle',
    'formula',
    'undo',
    'find',
    'rowResize',
    'rowReorder',
    'toolPanel',
  ],
  density: 'comfortable',
  // Dashboards hang on wall displays and on laptops in dark rooms; following
  // prefers-color-scheme is the only answer that is right in both.
  theme: 'auto',
  interaction: {
    pointer: 'fine',
    // Larger than the editors: a dashboard is read from further away and
    // clicked rarely, so the few targets it has should be generous.
    hitTargetPx: 32,
    hoverAffordance: true,
    swipeAction: false,
    keyboardFirst: false,
    motion: 'full',
    readOnly: true,
    virtualScroll: true,
    overscanRow: 4,
  },
};

export default dashboardPreset;
