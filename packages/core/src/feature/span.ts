// =============================================================================
// Sub-path entry: `@onegrid/core/span`
//
// Merged cells (row + column span).
//
// Opt-in rather than re-exported from the package root, so the base engine
// bundle does not carry a feature an adopter never imports. The design notes
// live at the implementation site.
// =============================================================================

/** @public */
export {
  expandRangeOverSpan,
  navigateAcrossSpan,
  resolveSpan,
} from '../span';

/** @public */
export type {
  CellSpan,
  ResolvedSpan,
  ResolveSpanOption,
  SpanConflict,
  SpanMap,
  SpanRect,
  SpanRole,
} from '../span';

