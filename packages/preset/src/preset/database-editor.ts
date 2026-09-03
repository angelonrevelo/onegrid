// =============================================================================
// @onegrid/preset/database-editor
//
// The Supabase / phpMyAdmin / TablePlus profile: rows are database records,
// not free-form cells. That single fact drives every difference from the
// spreadsheet preset.
//
//  - Server-side row model, because the table has more rows than the browser
//    can hold and the source of truth is a query, not a document.
//  - Master-detail is the foreign-key peek: expanding a row renders the
//    referenced record inline instead of navigating away.
//  - Selection checkboxes plus a context menu, because the operations are
//    row-level (insert, duplicate, delete) rather than range-level.
//  - No formula and no fill handle. A fill handle writes a rectangle of cells
//    in one gesture; against a live table that is an unreviewable bulk UPDATE.
//  - Undo IS on: every edit is a single-row mutation with a clean inverse.
// =============================================================================

import type { Preset } from '../type.js';

/**
 * Live database table editor. Compact, dark, server-paged, row-oriented.
 * @public
 */
export const databaseEditorPreset: Preset = {
  name: 'database-editor',
  description:
    'Supabase-style table editor: server-paged rows, per-cell edits with undo, foreign-key detail expansion, row insert and delete via checkbox selection and context menu.',
  feature: [
    'sort',
    'filter',
    'editing',
    'clipboard',
    'undo',
    'find',
    'columnResize',
    'columnReorder',
    'toolPanel',
    'contextMenu',
    'selectionCheckbox',
    'masterDetail',
    'statusBar',
    'serverSideRow',
    'export',
    'overlay',
    'flashCell',
  ],
  disabled: ['pivot', 'formula', 'fillHandle', 'chart', 'sparkline', 'rowResize'],
  density: 'compact',
  theme: 'dark',
  interaction: {
    pointer: 'fine',
    hitTargetPx: 24,
    hoverAffordance: true,
    swipeAction: false,
    keyboardFirst: true,
    motion: 'reduced',
    readOnly: false,
    virtualScroll: true,
    // Higher than the spreadsheet's 8: a scroll that outruns the fetched
    // block shows the no-rows overlay, which reads as data loss. Overscan
    // buys the block fetcher a screen of runway.
    overscanRow: 24,
  },
};

export default databaseEditorPreset;
