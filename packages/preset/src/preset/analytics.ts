// =============================================================================
// @onegrid/preset/analytics
//
// The exploratory-analysis profile: tens of millions of rows the browser can
// neither hold nor scan, so the aggregation runs in DuckDB-WASM and the grid
// pages the result through the server-side row model. What the user does is
// slice — group, pivot, chart — never type.
//
// Distinct from dashboardPreset, which is also read-only: a dashboard renders
// a fixed, pre-aggregated view for glancing at, so it is comfortable density
// with a shallow overscan and full motion. This is a working surface — compact
// density to fit more cross-tab on screen, a deep overscan because the user
// drags the scrollbar across a huge range, and reduced motion because
// animating a re-pivot of a million rows is noise.
//
// Distinct from reportPreset, which also pivots: a report is a bounded,
// non-virtualized document. This is unbounded and virtualized, and the two
// cannot be the same preset.
// =============================================================================

import type { Preset } from '../type.js';

/**
 * Large-dataset exploration. DuckDB-backed, server-paged, pivot and chart.
 * @public
 */
export const analyticsPreset: Preset = {
  name: 'analytics',
  description:
    'Large-dataset exploration: DuckDB-WASM aggregation behind a server-paged row model, grouping and pivot, range charts and sparklines, column tool panel, read-only.',
  feature: [
    'sort',
    'filter',
    'grouping',
    'pivot',
    'chart',
    'sparkline',
    'duckdb',
    'serverSideRow',
    'export',
    'statusBar',
    'columnGroup',
    'pinnedRow',
    'contextMenu',
    'columnResize',
    // toolPanel pulls columnReorder in as an implied dependency — hiding and
    // reordering columns is the same capability from the panel's side.
    'toolPanel',
    'overlay',
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
    'masterDetail',
    'flashCell',
  ],
  density: 'compact',
  theme: 'dark',
  interaction: {
    pointer: 'fine',
    hitTargetPx: 24,
    hoverAffordance: true,
    swipeAction: false,
    keyboardFirst: true,
    motion: 'reduced',
    readOnly: true,
    virtualScroll: true,
    // Deepest overscan of any preset. Scrubbing the scrollbar across a
    // ten-million-row result set is the normal gesture here, and each block
    // miss is a DuckDB query, not a memory read.
    overscanRow: 64,
  },
};

export default analyticsPreset;
