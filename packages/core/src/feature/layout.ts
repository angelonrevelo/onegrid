// =============================================================================
// Sub-path entry: `@onegrid/core/layout`
//
// Header text wrap, page-level sticky header, and the column-group visibility manager.
//
// Opt-in rather than re-exported from the package root, so the base engine
// bundle does not carry a feature an adopter never imports. The design notes
// live at the implementation site.
// =============================================================================

/** @public */
export { headerHeightFor, wrapHeaderText } from '../header-wrap';
/** @public */
export type { HeaderHeightOption, HeaderWrapOption, WrappedHeader } from '../header-wrap';

/** @public */
export { resolveStickyHeader, stickyHeaderChanged } from '../sticky-page-header';
/** @public */
export type { StickyHeaderInput, StickyHeaderMode, StickyHeaderState } from '../sticky-page-header';

/** @public */
export {
  applyColumnVisibility,
  applyGroupVisibility,
  groupState,
  UNGROUPED_LABEL,
  visibleColumn,
  visibleGroup,
} from '../column-group-visibility';
/** @public */
export type {
  ApplyVisibilityOption,
  GroupState,
  GroupVisibility,
  VisibilityResult,
} from '../column-group-visibility';
