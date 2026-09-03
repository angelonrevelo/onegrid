// =============================================================================
// @onegrid/preset/spreadsheet
//
// The Excel / Google Sheets profile: the user's mental model is a canvas of
// cells they type into, not a report they read. Everything that makes a cell
// grid feel like a spreadsheet is on — formula, fill handle, find and replace,
// undo, clipboard, in-place resize of both axes.
//
// Deliberately NOT here: serverSideRow and duckdb. A spreadsheet's data is
// local and fully materialized; block-paging it breaks fill-down across a
// range that spans a page boundary. They are in `disabled` rather than merely
// absent so extending this preset cannot quietly add them back.
// =============================================================================

import type { Preset } from '../type.js';

/**
 * Full-fat spreadsheet. Compact density, light theme, keyboard-first.
 * @public
 */
export const spreadsheetPreset: Preset = {
  name: 'spreadsheet',
  description:
    'Excel-style editable canvas: formula engine, fill handle, find and replace, undo, clipboard, resizable rows and columns.',
  feature: [
    'sort',
    'filter',
    'editing',
    'clipboard',
    'fillHandle',
    'formula',
    'find',
    'undo',
    'columnResize',
    'rowResize',
    'columnReorder',
    'rowReorder',
    'contextMenu',
    'statusBar',
    'export',
    'columnGroup',
    'pinnedRow',
    'flashCell',
    'overlay',
  ],
  disabled: ['serverSideRow', 'duckdb', 'pivot', 'tree'],
  density: 'compact',
  theme: 'light',
  interaction: {
    pointer: 'fine',
    hitTargetPx: 24,
    hoverAffordance: true,
    swipeAction: false,
    // Spreadsheet users live on the keyboard: arrows, F2, Enter-to-commit,
    // type-ahead-to-replace. Every affordance has a chord.
    keyboardFirst: true,
    // Animation between cells competes with fast keyboard travel — a
    // 150 ms selection tween is 150 ms of lag at 8 keystrokes a second.
    motion: 'reduced',
    readOnly: false,
    virtualScroll: true,
    overscanRow: 8,
  },
};

export default spreadsheetPreset;
