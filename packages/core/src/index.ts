// =============================================================================
// @onegrid/core
//
// Framework-agnostic engine. Owns the canvas renderer, accessibility shadow
// DOM, layout (FenwickHeights row heights), velocity-aware overscan, and
// keyboard navigation.
//
// Public API:
//   - new Grid(options) — mount a grid into a host element
//   - createGrid(options) — equivalent factory for non-class style usage
//   - DEFAULT_THEME, types
// =============================================================================

export { Grid } from './grid';

export {
  DEFAULT_THEME,
  DEFAULT_ROW_HEIGHT,
} from './types';
export type {
  CellEditContext,
  CellEditor,
  CellEditorInstance,
  CellRenderContext,
  CellRenderer,
  ColumnDef,
  ColumnGroupDef,
  ColumnMeta,
  ContextMenuTarget,
  FrameStats,
  GridMeta,
  GridOptions,
  GridTheme,
  MetricsSnapshot,
  RowGroupMeta,
  RowMeta,
  RowSource,
  ValidationContext,
  ValidationResult,
} from './types';

export type { SelectionSnapshot } from './selection';

export {
  createSelectEditor,
  createDateEditor,
  createTextareaEditor,
} from './editing/variants';

import { Grid } from './grid';
import type { GridOptions } from './types';

/**
 * Functional alias for `new Grid(options)`.
 * @public
 */
export const createGrid = (options: GridOptions): Grid => new Grid(options);

export {
  defineGridOptions,
  editingPreset,
  mobilePreset,
  enterprisePreset,
  accessibilityPreset,
} from './options';
export type { NestedGridOptions } from './options';

// Re-export DataSource shapes from @onegrid/protocol so consumers don't need
// to know there's a separate package for the contract types.
export type {
  BlockRequest,
  BlockResponse,
  DataSource,
  FilterModel,
  Schema,
  SortModel,
} from '@onegrid/protocol';
