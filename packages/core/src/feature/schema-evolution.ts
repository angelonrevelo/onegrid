// =============================================================================
// Sub-path entry: `@onegrid/core/schema-evolution`
//
// Runtime schema-change reconciliation.
//
// Opt-in rather than re-exported from the package root, so the base engine
// bundle does not carry a feature an adopter never imports. The design notes
// live at the implementation site.
// =============================================================================

/** @public */
export {
  brokenReference,
  diffSchema,
  reconcileActiveCell,
  reconcileColumnIndex,
  reconcileEditSession,
  reconcileFilter,
  reconcileSort,
} from '../schema-evolution';

/** @public */
export type {
  ReconcileResult,
  SchemaChange,
  SchemaDiff,
} from '../schema-evolution';

