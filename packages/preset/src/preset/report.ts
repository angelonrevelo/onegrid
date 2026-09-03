// =============================================================================
// @onegrid/preset/report
//
// The print / PDF / scheduled-export profile. This is the one preset where
// virtualization is OFF, and that is the entire point: a paginator, a print
// stylesheet and a headless-Chrome PDF pass all need every row present in the
// document. A virtualized grid prints one screenful and a blank tail.
//
// Consequently the row budget is the adopter's problem here, not the grid's —
// this preset is for a bounded result set (a month of invoices), never for the
// unbounded table `analyticsPreset` targets.
//
// Interaction is off across the board: no resize, no reorder, no context menu,
// no editing. A report is a document.
// =============================================================================

import type { Preset } from '../type.js';

/**
 * Pivoted, printable report. No interaction, no virtualization.
 * @public
 */
export const reportPreset: Preset = {
  name: 'report',
  description:
    'Print and PDF output: pivot plus grouping with totals, column group bands, exporters, every row in the document because pagination cannot see virtualized rows.',
  feature: ['pivot', 'export', 'columnGroup', 'pinnedRow', 'i18n'],
  disabled: [
    'editing',
    'clipboard',
    'fillHandle',
    'formula',
    'undo',
    'find',
    'chart',
    'contextMenu',
    'columnResize',
    'rowResize',
    'columnReorder',
    'rowReorder',
    'toolPanel',
    'selectionCheckbox',
    'flashCell',
    'masterDetail',
  ],
  density: 'compact',
  // Print is ink on white. A dark theme here wastes toner and reads badly.
  theme: 'light',
  interaction: {
    pointer: 'fine',
    hitTargetPx: 24,
    hoverAffordance: false,
    swipeAction: false,
    keyboardFirst: false,
    motion: 'none',
    readOnly: true,
    virtualScroll: false,
    overscanRow: 0,
  },
};

export default reportPreset;
