// =============================================================================
// Sub-path entry: `@onegrid/core/reorder`
//
// Tree/group-aware and multi-row drag reorder.
//
// Opt-in rather than re-exported from the package root, so the base engine
// bundle does not carry a feature an adopter never imports. The design notes
// live at the implementation site.
// =============================================================================

/** @public */
export {
  applyDrop,
  dropPositionFor,
  normalizeDragSet,
  resolveDrop,
  subtreeOf,
} from '../reorder-tree';

/** @public */
export type {
  DropPosition,
  DropRejection,
  DropResolution,
  DropTarget,
  FlatNode,
} from '../reorder-tree';

