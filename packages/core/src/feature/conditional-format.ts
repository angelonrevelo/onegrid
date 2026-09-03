// =============================================================================
// Sub-path entry: `@onegrid/core/conditional-format`
//
// Conditional formatting (colour scales, data bars, icon sets).
//
// Opt-in rather than re-exported from the package root, so the base engine
// bundle does not carry a feature an adopter never imports. The design notes
// live at the implementation site.
// =============================================================================

/** @public */
export {
  evaluateFormat,
  interpolateColor,
  prepareFormat,
  testOperator,
} from '../conditional-format';

/** @public */
export type {
  CellStyle,
  ColumnStat,
  FormatOperator,
  FormatRule,
  PreparedFormat,
} from '../conditional-format';

