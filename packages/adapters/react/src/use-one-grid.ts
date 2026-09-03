import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { DEFAULT_ROW_HEIGHT, Grid } from '@onegrid/core';
import type { ColumnDef, GridOptions } from '@onegrid/core';

export type UseOneGridOptions = Omit<GridOptions, 'host'>;

export interface UseOneGridReturn {
  /** Attach to a `<div>` you render. */
  readonly ref: RefObject<HTMLDivElement | null>;
  /** Live Grid instance once mounted. Null on first render. */
  readonly grid: Grid | null;
}

/**
 * Mount a oneGrid instance into a host `<div>`. The grid is recreated only
 * when columns / headerHeight / frozenColumnCount / theme change. Other
 * props update live via imperative paths:
 *
 *   - `rowSource` / `rowHeight` → `grid.setRowSource(...)` (preserves
 *     scroll, editor focus, floating filter inputs, etc.)
 *   - All callbacks (onFrame, onCellEdit, onPaste, onSelectionChange,
 *     onHeaderClick, onBeginEdit, getDetailContent, onToggleExpand,
 *     onFloatingFilterChange, getRowMeta, onToggleGroup) are stored in
 *     refs and called via stable wrappers. Closure changes propagate
 *     immediately without remounting the Grid — critical when the
 *     callbacks depend on React state that toggles (e.g. group
 *     expansion, master-detail, floating filter values).
 */
export function useOneGrid(options: UseOneGridOptions): UseOneGridReturn {
  const ref = useRef<HTMLDivElement | null>(null);
  const [grid, setGrid] = useState<Grid | null>(null);

  // Refs for every pass-through callback. `current` is reassigned on
  // every render so the latest closure is what fires when the Grid
  // dispatches.
  const onFrameRef = useRef(options.onFrame);
  onFrameRef.current = options.onFrame;
  const onSelectionChangeRef = useRef(options.onSelectionChange);
  onSelectionChangeRef.current = options.onSelectionChange;
  const onHeaderClickRef = useRef(options.onHeaderClick);
  onHeaderClickRef.current = options.onHeaderClick;
  const onCellEditRef = useRef(options.onCellEdit);
  onCellEditRef.current = options.onCellEdit;
  const onBeginEditRef = useRef(options.onBeginEdit);
  onBeginEditRef.current = options.onBeginEdit;
  const onPasteRef = useRef(options.onPaste);
  onPasteRef.current = options.onPaste;
  const onToggleExpandRef = useRef(options.onToggleExpand);
  onToggleExpandRef.current = options.onToggleExpand;
  const getDetailContentRef = useRef(options.getDetailContent);
  getDetailContentRef.current = options.getDetailContent;
  const onDetailUnmountRef = useRef(options.onDetailUnmount);
  onDetailUnmountRef.current = options.onDetailUnmount;
  const onFloatingFilterChangeRef = useRef(options.onFloatingFilterChange);
  onFloatingFilterChangeRef.current = options.onFloatingFilterChange;
  const getRowMetaRef = useRef(options.getRowMeta);
  getRowMetaRef.current = options.getRowMeta;
  const onToggleGroupRef = useRef(options.onToggleGroup);
  onToggleGroupRef.current = options.onToggleGroup;
  const onColumnReorderRef = useRef(options.onColumnReorder);
  onColumnReorderRef.current = options.onColumnReorder;
  const onContextMenuRef = useRef(options.onContextMenu);
  onContextMenuRef.current = options.onContextMenu;
  const onFillHandleRef = useRef(options.onFillHandle);
  onFillHandleRef.current = options.onFillHandle;

  // Stable "column shape" key. Changes when the COLUMN SET changes
  // (id / order / count) — NOT when only widths change. Used to gate
  // Grid recreation: shape change → destroy + recreate; width-only
  // change → imperative setColumns().
  const columnsShapeKey = useMemo(
    () => deriveColumnsShapeKey(options.columns),
    [options.columns],
  );

  useEffect(() => {
    if (!ref.current) return;
    if (options.columns.length === 0 || options.rowSource.numRows === 0) return;
    const instance = new Grid({
      ...options,
      host: ref.current,
      onFrame: (stats) => onFrameRef.current?.(stats),
      onSelectionChange: (s) => onSelectionChangeRef.current?.(s),
      onHeaderClick: (id) => onHeaderClickRef.current?.(id),
      onCellEdit: (row, col, n, o) => onCellEditRef.current?.(row, col, n, o),
      onBeginEdit: (row, col) => onBeginEditRef.current?.(row, col),
      onPaste: (row, col, rows) => onPasteRef.current?.(row, col, rows),
      onToggleExpand: (i) => onToggleExpandRef.current?.(i),
      // getDetailContent is read fresh on every chevron click — when
      // null the Grid disables the master-detail layer, so we always
      // pass a wrapper and let the wrapper return null when the React
      // option is undefined.
      getDetailContent: (i) => getDetailContentRef.current?.(i) ?? null,
      onDetailUnmount: (i, el) => onDetailUnmountRef.current?.(i, el),
      onFloatingFilterChange: (col, val) =>
        onFloatingFilterChangeRef.current?.(col, val),
      getRowMeta: (row) => getRowMetaRef.current?.(row) ?? null,
      onToggleGroup: (path) => onToggleGroupRef.current?.(path),
      onColumnReorder: (from, to, id) =>
        onColumnReorderRef.current?.(from, to, id),
      onContextMenu: (target) => onContextMenuRef.current?.(target),
      onFillHandle: (source, fill) => onFillHandleRef.current?.(source, fill),
    });
    setGrid(instance);
    return () => {
      instance.destroy();
      setGrid(null);
    };
    // Grid is recreated on column-SHAPE change (column id set / count
    // / header / frozen-count / theme). Within-shape changes (just
    // widths / formatters / renderers) flow imperatively via the
    // setColumns useEffect below. The shape-key derivation lives in
    // `columnsShapeKey` so we don't recreate the Grid on every render.
    //
    // Recreating the Grid on a columns identity change destroyed every
    // piece of in-flight interaction state (drag-to-resize / drag-to-
    // reorder / selection / scroll / pending edits). With this shape-
    // aware diff, drag-to-resize updates only trigger setColumns().
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    columnsShapeKey,
    options.headerHeight,
    options.frozenColumnCount,
    options.theme,
  ]);

  // Within-shape column updates flow imperatively, BUT only when the
  // shape actually changed (column id sequence, count, header, group).
  // Width changes during a drag round-trip back through React state
  // (onColumnResize → setState → re-render → fresh options.columns
  // reference). Echoing those widths into setColumns is a race:
  // mid-drag, an unrelated re-render (FPS pill update, hover state,
  // etc.) carries a STALE columns reference where the latest dragged
  // width hasn't been committed yet, so setColumns snaps the Grid
  // back to the previous width — visible as a head-to-toe flicker
  // across header, rows, and pinned bands.
  //
  // Resolution: the Grid owns column widths during interaction
  // (drag-resize, drag-reorder). React state mirrors them for
  // survival across mounts. We only push columns INTO the Grid on
  // shape changes; the Grid pushes width changes OUT through
  // onColumnResize. If you need to programmatically set a width from
  // React, expose a separate imperative API on the Grid (future).
  const optionsRef = useRef(options);
  optionsRef.current = options;
  useEffect(() => {
    if (!grid) return;
    grid.setColumns(optionsRef.current.columns);
  }, [grid, columnsShapeKey]);

  useEffect(() => {
    if (!grid) return;
    grid.setRowSource(options.rowSource, options.rowHeight ?? DEFAULT_ROW_HEIGHT);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grid, options.rowSource, options.rowHeight]);

  useEffect(() => {
    if (!grid) return;
    grid.setPinnedBottomRowSource(options.pinnedBottomRowSource);
  }, [grid, options.pinnedBottomRowSource]);

  useEffect(() => {
    if (!grid) return;
    grid.setPinnedTopRowSource(options.pinnedTopRowSource);
  }, [grid, options.pinnedTopRowSource]);

  return { ref, grid };
}

/**
 * Derive a stable key that changes when the column SET changes (id
 * sequence) but stays the same when only widths / formatters / etc.
 * change. Used by `useOneGrid` to distinguish "shape change → recreate
 * Grid" from "incremental update → call setColumns()".
 *
 * Cheap — joins the column ids into one string. For typical grids
 * (< 100 columns) this is sub-microsecond.
 */
function deriveColumnsShapeKey(columns: ReadonlyArray<ColumnDef>): string {
  // Pipe is reserved as a separator; column ids are simple identifiers.
  let s = '';
  for (let i = 0; i < columns.length; i++) {
    if (i > 0) s += '|';
    s += columns[i]?.id ?? '';
  }
  return s;
}
