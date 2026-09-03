// =============================================================================
// Sub-path entry: `@onegrid/core/multi-select`
//
// The multi-value chip cell type and its popover editor.
//
// Opt-in rather than re-exported from the package root, so the base engine
// bundle does not carry a feature an adopter never imports. The design notes
// live at the implementation site.
// =============================================================================

/** @public */
export {
  createMultiSelectEditor,
  filterOption,
  formatMultiValue,
  layoutChip,
  MULTI_VALUE_DELIMITER,
  parseMultiValue,
  toggleValue,
} from '../editing/multi-select';
/** @public */
export type {
  ChipLayout,
  ChipLayoutOption,
  ChipLayoutResult,
  MultiSelectEditorConfig,
  MultiSelectOption,
} from '../editing/multi-select';
