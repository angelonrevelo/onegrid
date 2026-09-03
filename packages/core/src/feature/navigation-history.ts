// =============================================================================
// Sub-path entry: `@onegrid/core/navigation-history`
//
// Browser-style back/forward within a sheet.
//
// Opt-in rather than re-exported from the package root, so the base engine
// bundle does not carry a feature an adopter never imports. The design notes
// live at the implementation site.
// =============================================================================

/** @public */
export {
  createNavigationHistory,
} from '../navigation-history';

/** @public */
export type {
  NavigationEntry,
  NavigationHistory,
  NavigationHistoryOption,
  NavigationState,
} from '../navigation-history';

