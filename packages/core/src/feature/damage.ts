// =============================================================================
// Sub-path entry: `@onegrid/core/damage`
//
// The incremental-redraw dirty-rect protocol.
//
// Opt-in rather than re-exported from the package root, so the base engine
// bundle does not carry a feature an adopter never imports. The design notes
// live at the implementation site.
// =============================================================================

/** @public */
export {
  area,
  createDamageTracker,
  intersects,
  mergeRegion,
  union,
} from '../damage';

/** @public */
export type {
  DamageRect,
  DamageTracker,
  DamageTrackerOption,
  RedrawPlan,
} from '../damage';

