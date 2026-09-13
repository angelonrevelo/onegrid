import { useCallback, useEffect, useMemo, useRef, useState, type JSX } from 'react';
import {
  ColumnToolPanel,
  createReactCellRenderer,
  createSelectionCheckboxColumn,
  SelectAllCheckbox,
  useOneGrid,
  type CellRenderContext,
  type ColumnDef,
  type ContextMenuTarget,
  type FilterModel,
  type FrameStats,
  type MetricsSnapshot,
  type RowSource,
  type SortModel,
} from '@onegrid/react';
import { downloadCsv, downloadXlsx, type ExportColumn } from '@onegrid/export';
import {
  buildMemoryView,
  generateSynthetic,
  materializeSynthetic,
  type MaterializedSyntheticDataset,
} from './lib/synthetic';
import {
  createTableIndex,
  enumerateDistinctIndexed,
  groupRows,
  flattenGroupTree,
  pathKey,
  pivot,
  type DistinctValue,
  type FlatGroupEntry,
  type PivotedTable,
} from '@onegrid/data';
import {
  webgpuAvailable,
  getGpuInfo,
  gpuSumFloat32,
  cpuSumFloat32,
} from '@onegrid/webgpu';
import { Grid, type RowMeta } from '@onegrid/core';
import { createUndoManager, type UndoManager } from '@onegrid/undo';
import { AuditClient, type AuditEvent } from './lib/audit-client';
import { V009Demo } from './v009-demo';
import { V010Demo } from './v010-demo';
import { V011Demo } from './v011-demo';
import { V100Demo } from './v100-demo';
import { StudioDemo } from './studio-demo';
import { connectSsrm, SSRM_COLUMNS, type SsrmConnection } from './lib/ssrm';
import {
  connectDuckDb,
  DUCKDB_COLUMNS,
  type DuckDbModeHandle,
} from './lib/duckdb-mode';
import {
  FILTER_OPS,
  buildColumnFilter,
  buildQuickFilter,
  isSetOp,
  isUnaryOp,
  newFilterRule,
  type FilterOp,
  type FilterRule,
} from './lib/filter';
import {
  createFormulaPlayground,
  FORMULA_COLUMNS,
  FORMULA_ROW_COUNT,
  indexToColumnId,
  type FormulaPlaygroundHandle,
} from './lib/formula-mode';
import { createTreeMode, type TreeModeHandle } from './lib/tree-mode';
import {
  connectSsrmTree,
  SSRM_TREE_COLUMNS,
  type SsrmTreeConnection,
} from './lib/ssrm-tree';

const ROW_OPTIONS = [1_000, 10_000, 100_000, 1_000_000, 10_000_000, 100_000_000, 1_000_000_000] as const;

const STATUS_PILL_BG: Record<string, string> = {
  active: '#1f3a2a',
  pending: '#3a2f17',
  archived: '#2a2f37',
  pilot: '#1d2c44',
  churned: '#3a1818',
};
const STATUS_PILL_FG: Record<string, string> = {
  active: '#62d68a',
  pending: '#f4c768',
  archived: '#a5b1c2',
  pilot: '#6ea8fe',
  churned: '#ff8a8a',
};

/**
 * React-based cell renderer for the status column. Renders a colored
 * pill via React state — exercises the framework adapter end-to-end:
 * the React fiber survives scroll-in/scroll-out (the DOM element is
 * pooled, the fiber is not unmounted).
 */
function StatusPillCell({ value }: CellRenderContext): JSX.Element {
  const v = typeof value === 'string' ? value : '';
  return (
    <span
      data-testid="status-pill"
      style={{
        display: 'inline-block',
        padding: '2px 10px',
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 600,
        background: STATUS_PILL_BG[v] ?? '#2a2f37',
        color: STATUS_PILL_FG[v] ?? '#a5b1c2',
        textTransform: 'uppercase',
        letterSpacing: 0.4,
      }}
    >
      {v}
    </span>
  );
}

const statusPillRenderer = createReactCellRenderer({
  id: 'status-pill-react',
  component: StatusPillCell,
});

interface SetFilterPopoverProps {
  readonly distinct: ReadonlyArray<DistinctValue>;
  readonly selected: ReadonlyArray<string>;
  readonly onApply: (values: ReadonlyArray<string>) => void;
  readonly onClose: () => void;
}

/**
 * Distinct-values checkbox popover backing the `in` / `notIn` filter
 * ops. Shows count per value and a search box that narrows the list.
 * Locale-aware comparison via the default Collator so "Café"/"Cafe"
 * collation surprises don't ship.
 */
function SetFilterPopover({
  distinct,
  selected,
  onApply,
  onClose,
}: SetFilterPopoverProps): JSX.Element {
  const [search, setSearch] = useState('');
  const [draft, setDraft] = useState<ReadonlySet<string>>(() => new Set(selected));

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return distinct;
    return distinct.filter((d) =>
      String(d.value ?? '').toLowerCase().includes(q),
    );
  }, [distinct, search]);

  const allSelected = filtered.length > 0 && filtered.every((d) => draft.has(String(d.value ?? '')));

  return (
    <div
      role="dialog"
      aria-label="Pick values"
      style={{
        position: 'absolute',
        zIndex: 50,
        background: 'var(--panel)',
        border: '1px solid var(--border)',
        borderRadius: 6,
        padding: 8,
        minWidth: 240,
        maxHeight: 360,
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
      }}
    >
      <input
        type="search"
        placeholder="Search values…"
        value={search}
        onChange={(e) => {
          setSearch(e.target.value);
        }}
        autoFocus
      />
      <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
        <input
          type="checkbox"
          checked={allSelected}
          onChange={(e) => {
            const checked = e.target.checked;
            setDraft((prev) => {
              const next = new Set(prev);
              for (const d of filtered) {
                if (checked) next.add(String(d.value ?? ''));
                else next.delete(String(d.value ?? ''));
              }
              return next;
            });
          }}
        />
        Select all{filtered.length !== distinct.length ? ' (filtered)' : ''}
      </label>
      <div
        data-testid="set-filter-list"
        style={{ flex: 1, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}
      >
        {filtered.map((d) => {
          const key = String(d.value ?? '');
          return (
            <label
              key={key}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 12,
                padding: '2px 4px',
              }}
            >
              <input
                type="checkbox"
                checked={draft.has(key)}
                onChange={(e) => {
                  setDraft((prev) => {
                    const next = new Set(prev);
                    if (e.target.checked) next.add(key);
                    else next.delete(key);
                    return next;
                  });
                }}
              />
              <span style={{ flex: 1, fontFamily: 'ui-monospace, monospace' }}>{key || '(blank)'}</span>
              <span style={{ color: 'var(--muted)', fontSize: 11 }}>{d.count.toLocaleString()}</span>
            </label>
          );
        })}
      </div>
      <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
        <button type="button" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          onClick={() => {
            onApply(Array.from(draft));
            onClose();
          }}
          style={{ fontWeight: 600 }}
        >
          Apply ({draft.size})
        </button>
      </div>
    </div>
  );
}

type Mode =
  | 'memory'
  | 'ssrm'
  | 'formula'
  | 'duckdb'
  | 'pivot'
  | 'tree'
  | 'ssrm-tree'
  | 'studio';

// Stable references so useOneGrid's effect doesn't re-fire while waiting
// for async data sources to resolve.
const EMPTY_COLUMNS: ReadonlyArray<ColumnDef> = [];
const EMPTY_ROW_SOURCE: RowSource = { numRows: 0, getCell: () => null };

declare global {
  interface Window {
    __onegrid?: {
      getMetrics: () => MetricsSnapshot;
      reset: () => void;
      scrollBy: (deltaY: number) => void;
      scrollToRow: (rowIndex: number) => void;
      setRows: (n: number) => void;
      setSort: (sort: SortModel) => void;
      getSort: () => SortModel;
      setFilter: (query: string) => void;
      getFilter: () => string;
      formulaSet?: (id: string, input: string) => void;
      formulaGet?: (id: string) => unknown;
      formulaStats?: () => unknown;
      getColumns?: () => ReadonlyArray<ColumnDef>;
      getViewportInfo?: () => {
        readonly scrollTop: number;
        readonly scrollLeft: number;
        readonly scrollScale: number;
        readonly totalHeight: number;
        readonly numRows: number;
        readonly viewportWidth: number;
        readonly viewportHeight: number;
        readonly firstVisibleRow: number;
        readonly lastVisibleRow: number;
      };
      setMode?: (m: string) => void;
      getMode?: () => string;
      undo?: () => void;
      redo?: () => void;
      undoState?: () =>
        | {
            readonly canUndo: boolean;
            readonly canRedo: boolean;
            readonly undoCount: number;
            readonly redoCount: number;
          }
        | undefined;
      auditQuery?: (sourceRow: number) => Promise<
        ReadonlyArray<{
          readonly ts: number;
          readonly event: string;
          readonly columnId: string;
          readonly oldValue: string;
          readonly newValue: string;
        }>
      >;
      auditAppend?: (
        sourceRow: number,
        ts: number,
        event: 'edit' | 'paste' | 'fill' | 'undo' | 'redo',
        columnId: string,
        oldValue: string,
        newValue: string,
      ) => void;
      auditClear?: () => void;
      writeCell?: (visualRow: number, columnId: string, newValue: string) => boolean;
      readCell?: (visualRow: number, columnId: string) => unknown;
      host?: HTMLElement;
    };
  }
}

/**
 * Three-state header click toggle: none → asc → desc → none. Honors shift
 * for multi-column sort priority (Excel/Sheets convention).
 */
function toggleSortFor(
  sort: SortModel,
  columnId: string,
  shiftKey: boolean,
): SortModel {
  const existing = sort.find((s) => s.columnId === columnId);
  const others = shiftKey ? sort.filter((s) => s.columnId !== columnId) : [];
  if (!existing) return [...others, { columnId, direction: 'asc' }];
  if (existing.direction === 'asc') {
    return [...others, { columnId, direction: 'desc' }];
  }
  return others; // was desc → remove from sort
}

export const App = (): JSX.Element => {
  const [mode, setMode] = useState<Mode>('memory');
  const [numRows, setNumRows] = useState<(typeof ROW_OPTIONS)[number]>(1_000_000);
  const [genMs, setGenMs] = useState<number>(0);
  const [stats, setStats] = useState<FrameStats | null>(null);
  const [sort, setSort] = useState<SortModel>([]);
  const [filterQuery, setFilterQuery] = useState<string>('');
  const [columnFilters, setColumnFilters] = useState<ReadonlyArray<FilterRule>>([]);
  // SSRM reads the filter box through a short debounce, so typing a word
  // issues one server query instead of one per keystroke.
  const [ssrmFilterQuery, setSsrmFilterQuery] = useState<string>('');
  const [showFilterPanel, setShowFilterPanel] = useState(false);
  const [showColumnPanel, setShowColumnPanel] = useState(false);
  const [showV009Demo, setShowV009Demo] = useState(false);
  const [showV010Demo, setShowV010Demo] = useState(false);
  const [showV011Demo, setShowV011Demo] = useState(false);
  const [showV100Demo, setShowV100Demo] = useState(false);
  const [contextMenu, setContextMenu] = useState<ContextMenuTarget | null>(null);
  const [checkedRows, setCheckedRows] = useState<Set<number>>(new Set());
  // Off by default — adding the checkbox column shifts every other
  // column right and adds a frozen-column slot, which would break
  // tests that pin coordinates to the original layout. The toolbar
  // toggle lets the user opt in.
  const [showCheckboxColumn, setShowCheckboxColumn] = useState(false);
  /** When non-null, a set-filter popover is open for this rule id. */
  const [setFilterOpenFor, setSetFilterOpenFor] = useState<string | null>(null);
  // SSRM set-filter values, fetched from the server (POST /distinct) when a
  // popover opens. Null while loading.
  const [ssrmDistinct, setSsrmDistinct] = useState<
    | { readonly ruleId: string; readonly distinct: ReadonlyArray<DistinctValue> }
    | { readonly ruleId: string; readonly error: string }
    | null
  >(null);
  /** Per-column substring filters from the floating filter row. */
  const [floatingFilters, setFloatingFilters] = useState<Record<string, string>>({});

  const handleFloatingFilterChange = useCallback(
    (columnId: string, value: string) => {
      setFloatingFilters((prev) => {
        if (value === '') {
          const next = { ...prev };
          delete next[columnId];
          return next;
        }
        return { ...prev, [columnId]: value };
      });
    },
    [],
  );
  // Capture shiftKey at click-time inside the canvas; the Grid's onHeaderClick
  // doesn't pass the event, so we read it from the latest pointer state.
  const [shiftDown, setShiftDown] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Shift') setShiftDown(e.type === 'keydown');
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKey);
    };
  }, []);

  // ----- in-memory dataset -----
  // Materialize typed-array columns (so @onegrid/data sort/filter can run)
  // for sizes up to 1M; for 10M, fall back to the lazy generator since
  // materialization would cost ~500 MB.
  const MATERIALIZE_LIMIT = 1_000_000;
  const memoryDataset = useMemo<
    | (MaterializedSyntheticDataset & { materialized: true })
    | (ReturnType<typeof generateSynthetic> & { materialized: false })
    | null
  >(() => {
    if (mode !== 'memory') return null;
    const t0 = performance.now();
    if (numRows <= MATERIALIZE_LIMIT) {
      const d = materializeSynthetic(numRows);
      const t1 = performance.now();
      setGenMs(Math.round(t1 - t0));
      return { ...d, materialized: true };
    }
    const d = generateSynthetic(numRows);
    const t1 = performance.now();
    setGenMs(Math.round(t1 - t0));
    return { ...d, materialized: false };
  }, [mode, numRows]);

  // Apply sort + column filters to the materialized dataset. For >1M rows
  // (no materialization), fall through with the lazy rowSource and disabled
  // sort/filter UI.
  // Dictionary + posting lists per column, built lazily on the first filter
  // that touches a column and reused for every keystroke after it.
  const memoryTableIndex = useMemo(
    () => (memoryDataset?.materialized ? createTableIndex(memoryDataset.table) : null),
    [memoryDataset],
  );

  const memoryView = useMemo(() => {
    if (!memoryDataset || !memoryDataset.materialized) return null;
    const t0 = performance.now();
    // Compose three filter sources: explicit column rules, the quick
    // filter, and per-column floating filters (substring contains).
    const explicit = buildColumnFilter(columnFilters);
    const quick = filterQuery
      ? buildQuickFilter(filterQuery, memoryDataset.columns.map((c) => c.id))
      : null;
    const floating: FilterModel | null = (() => {
      const entries = Object.entries(floatingFilters).filter(([, v]) => v !== '');
      if (entries.length === 0) return null;
      const comparisons = entries.map(([columnId, value]) => ({
        type: 'comparison' as const,
        columnId,
        op: 'contains' as const,
        value,
        caseSensitive: false,
      }));
      return comparisons.length === 1
        ? comparisons[0]!
        : { type: 'logical' as const, op: 'and' as const, filters: comparisons };
    })();
    const all = [explicit, quick, floating].filter((f): f is NonNullable<typeof f> => f !== null);
    const filterModel: FilterModel =
      all.length === 0 ? null : all.length === 1 ? all[0]! : { type: 'logical', op: 'and', filters: all };
    const view = buildMemoryView(memoryDataset.table, sort, filterModel, memoryTableIndex ?? undefined);
    const t1 = performance.now();
    if (view.permutation) {
      // eslint-disable-next-line no-console
      console.log(
        `[onegrid] memory sort+filter: ${(t1 - t0).toFixed(1)}ms · ${String(view.numRows)} rows`,
      );
    }
    return view;
  }, [memoryDataset, memoryTableIndex, sort, columnFilters, filterQuery, floatingFilters]);

  // ----- ssrm connection -----
  const [ssrm, setSsrm] = useState<SsrmConnection | null>(null);
  const [ssrmStatus, setSsrmStatus] = useState<'idle' | 'connecting' | 'connected' | 'error'>(
    'idle',
  );
  const [ssrmTick, setSsrmTick] = useState(0);

  // ----- formula playground -----
  const [formula, setFormula] = useState<FormulaPlaygroundHandle | null>(null);
  const [formulaTick, setFormulaTick] = useState(0);
  const [formulaActiveCell, setFormulaActiveCell] = useState<string>('A1');
  const [formulaInput, setFormulaInput] = useState<string>('');

  // ----- duckdb-wasm playground -----
  const [duckdb, setDuckdb] = useState<DuckDbModeHandle | null>(null);
  const [duckdbStatus, setDuckdbStatus] = useState<
    'idle' | 'connecting' | 'connected' | 'error'
  >('idle');
  const [duckdbProgress, setDuckdbProgress] = useState<string>('');
  const [duckdbTick, setDuckdbTick] = useState(0);

  // ----- tree-data playground -----
  const [tree, setTree] = useState<TreeModeHandle | null>(null);
  const [treeTick, setTreeTick] = useState(0);
  useEffect(() => {
    if (mode !== 'tree') {
      setTree(null);
      return;
    }
    const handle = createTreeMode(() => setTreeTick((t) => t + 1));
    setTree(handle);
  }, [mode]);

  // ----- SSRM-tree (server-side hierarchical) -----
  const [ssrmTree, setSsrmTree] = useState<SsrmTreeConnection | null>(null);
  const [ssrmTreeTick, setSsrmTreeTick] = useState(0);
  useEffect(() => {
    if (mode !== 'ssrm-tree') {
      setSsrmTree(null);
      return;
    }
    let canceled = false;
    connectSsrmTree(() => setSsrmTreeTick((t) => t + 1))
      .then((conn) => {
        if (canceled) return;
        setSsrmTree(conn);
      })
      .catch((err: unknown) => {
        if (canceled) return;
        console.error('[onegrid] ssrm-tree connect failed', err);
      });
    return () => {
      canceled = true;
    };
  }, [mode]);

  useEffect(() => {
    if (mode !== 'formula') {
      setFormula(null);
      return;
    }
    const handle = createFormulaPlayground();
    setFormula(handle);
    setFormulaInput(handle.getDisplaySource('A1'));
  }, [mode]);

  useEffect(() => {
    if (mode !== 'duckdb') {
      // Tear down on mode change so the worker + WASM heap are released.
      setDuckdb((prev) => {
        if (prev) void prev.close();
        return null;
      });
      setDuckdbStatus('idle');
      setDuckdbProgress('');
      return;
    }
    let canceled = false;
    setDuckdbStatus('connecting');
    setDuckdbProgress('starting…');
    connectDuckDb({
      numRows: 100_000,
      onProgress: (m) => {
        if (!canceled) setDuckdbProgress(m);
      },
      onUpdate: () => {
        if (!canceled) setDuckdbTick((t) => t + 1);
      },
    })
      .then((handle) => {
        if (canceled) {
          void handle.close();
          return;
        }
        setDuckdb(handle);
        setDuckdbStatus('connected');
      })
      .catch((err: unknown) => {
        if (canceled) return;
        console.error('[onegrid] duckdb connect failed', err);
        setDuckdbStatus('error');
      });
    return () => {
      canceled = true;
    };
  }, [mode]);

  useEffect(() => {
    if (mode !== 'ssrm') {
      setSsrm(null);
      setSsrmStatus('idle');
      return;
    }
    let canceled = false;
    setSsrmStatus('connecting');
    connectSsrm(() => {
      // Block landed → bump tick so the renderer repaints fresh cells.
      setSsrmTick((t) => t + 1);
    })
      .then((conn) => {
        if (canceled) return;
        setSsrm(conn);
        setSsrmStatus('connected');
      })
      .catch((err: unknown) => {
        if (canceled) return;
        console.error('[onegrid] ssrm connect failed', err);
        setSsrmStatus('error');
      });
    return () => {
      canceled = true;
    };
  }, [mode]);

  // ----- WebGPU benchmark -----
  const [gpuStatus, setGpuStatus] = useState<string>(
    webgpuAvailable() ? 'WebGPU available' : 'WebGPU unavailable',
  );
  const runGpuBench = useCallback(async (): Promise<void> => {
    setGpuStatus('benchmarking…');
    try {
      const info = await getGpuInfo();
      const N = 4_000_000;
      const data = new Float32Array(N);
      for (let i = 0; i < N; i++) data[i] = Math.random();

      const t0 = performance.now();
      const cpuSum = cpuSumFloat32(data);
      const cpuMs = performance.now() - t0;

      const t1 = performance.now();
      const gpuSum = await gpuSumFloat32(data);
      const gpuMs = performance.now() - t1;

      const speedup = (cpuMs / gpuMs).toFixed(1);
      const errPct = (Math.abs(cpuSum - gpuSum) / cpuSum * 100).toFixed(3);
      setGpuStatus(
        `${info?.description ?? 'GPU'}  ·  ${N.toLocaleString()} f32  ·  ` +
          `cpu ${cpuMs.toFixed(0)}ms  ·  gpu ${gpuMs.toFixed(0)}ms  ·  ` +
          `${speedup}× speedup  ·  ${errPct}% Δ`,
      );
    } catch (err) {
      setGpuStatus(`error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, []);

  // ----- Pivot mode -----
  // Pivot rebuilds a materialized synthetic dataset (so all groupings have
  // values to aggregate) and pivots region/status × measures into a fresh
  // ColumnTable + ColumnDef set. Cached on numRows so toggling between
  // modes doesn't pay the rebuild cost twice.
  const pivotResult = useMemo<{
    columns: ReadonlyArray<ColumnDef>;
    rowSource: RowSource;
    pivoted: PivotedTable;
  } | null>(() => {
    if (mode !== 'pivot') return null;
    const ds = materializeSynthetic(Math.min(numRows, 100_000));
    const pivoted = pivot(ds.table, {
      rows: ['status'],
      columns: ['firstName'],
      measures: [
        { fn: 'sum', columnId: 'revenue', alias: 'rev' },
        { fn: 'avg', columnId: 'score', alias: 'score' },
      ],
    });
    const columns: ColumnDef[] = [
      { id: 'status', width: 130, displayName: 'Status' },
    ];
    for (const c of pivoted.pivotColumns) {
      const head = String(c.pivotPath[0] ?? '');
      columns.push({
        id: c.id,
        width: 110,
        displayName: `${head} · ${c.measure.alias ?? c.measure.fn}`,
        format: (v) => {
          const n = typeof v === 'number' ? v : Number(v);
          if (!Number.isFinite(n)) return '—';
          return c.measure.fn === 'avg' ? n.toFixed(1) : `$${n.toFixed(0)}`;
        },
      });
    }
    return {
      columns,
      rowSource: {
        numRows: pivoted.table.numRows,
        getCell: (r, id) => pivoted.table.column(id).get(r),
      },
      pivoted,
    };
  }, [mode, numRows]);

  // ----- Row grouping (memory mode only) -----
  const [groupByColumn, setGroupByColumn] = useState<'none' | 'status'>('none');
  const [openGroups, setOpenGroups] = useState<ReadonlySet<string>>(() => new Set());

  const groupedFlat = useMemo<FlatGroupEntry[] | null>(() => {
    if (groupByColumn === 'none') return null;
    if (mode !== 'memory' || !memoryDataset?.materialized) return null;
    const root = groupRows(
      memoryDataset.table,
      { columns: [groupByColumn], openKeys: [] },
      {
        aggregations: [
          { fn: 'sum', columnId: 'revenue', alias: 'revenue' },
          { fn: 'avg', columnId: 'score', alias: 'score' },
          { fn: 'count', columnId: 'rowIndex', alias: '__count' },
        ],
      },
    );
    return flattenGroupTree(root, openGroups);
  }, [groupByColumn, mode, memoryDataset, openGroups]);

  const groupedRowSource = useMemo<RowSource | null>(() => {
    if (!groupedFlat || !memoryDataset?.materialized) return null;
    const flat = groupedFlat;
    const ds = memoryDataset;
    return {
      numRows: flat.length,
      getCell: (rowIndex: number, columnId: string) => {
        const entry = flat[rowIndex];
        if (!entry) return null;
        if (entry.kind === 'row') return ds.rowSource.getCell(entry.rowIndex, columnId);
        return null;
      },
    };
  }, [groupedFlat, memoryDataset]);

  const getRowMeta = useCallback(
    (rowIndex: number): RowMeta | null => {
      // Tree mode takes precedence — it has its own flat list.
      if (mode === 'tree' && tree) {
        const entry = tree.flat[rowIndex];
        if (!entry) return null;
        return {
          kind: 'tree',
          depth: entry.depth,
          id: entry.id,
          expanded: entry.expanded,
          isLeaf: entry.isLeaf,
          hasChildren: entry.hasChildren,
        };
      }
      if (mode === 'ssrm-tree' && ssrmTree) {
        return ssrmTree.handle.getRowMeta(rowIndex);
      }
      if (!groupedFlat) return null;
      const entry = groupedFlat[rowIndex];
      if (!entry || entry.kind !== 'group') return null;
      const node = entry.node;
      const path = pathKey(node.path);
      return {
        kind: 'group',
        depth: entry.depth,
        label: String(node.key ?? '(blank)'),
        path,
        expanded: openGroups.has(path),
        count: node.rowCount,
        aggregates: node.aggregates as Record<string, unknown>,
      };
    },
    [groupedFlat, openGroups, mode, tree, ssrmTree],
  );

  const handleToggleGroup = useCallback(
    (path: string) => {
      // In tree mode, the path argument is the tree node id; route
      // it through the tree handle's async toggle (which may run a
      // lazy loadChildren before the state update).
      if (mode === 'tree' && tree) {
        void tree.toggle(path);
        return;
      }
      if (mode === 'ssrm-tree' && ssrmTree) {
        ssrmTree.handle.toggle(path);
        return;
      }
      setOpenGroups((prev) => {
        const next = new Set(prev);
        if (next.has(path)) next.delete(path);
        else next.add(path);
        return next;
      });
    },
    [mode, tree, ssrmTree],
  );

  const dataReady =
    mode === 'memory'
      ? memoryDataset !== null
      : mode === 'ssrm'
        ? ssrm !== null
        : mode === 'duckdb'
          ? duckdb !== null
          : mode === 'pivot'
            ? pivotResult !== null
            : mode === 'tree'
              ? tree !== null
              : mode === 'ssrm-tree'
                ? ssrmTree !== null
                : formula !== null;

  // Module-level stable fallbacks so useOneGrid's effect doesn't re-fire
  // every render while we're waiting for the async data source.
  // Memory-mode columns with the React pill renderer overlaid on
  // the status column. Memoized so the array identity is stable —
  // useOneGrid uses `options.columns` as a dep, and a fresh array
  // each render would constantly remount the Grid.
  // Selection-checkbox column factory rebuilds on every checkedRows
  // change so its store reflects the latest set. The factory ID is
  // stable, so visible checkbox cells re-render through the
  // store-subscription path without a Grid remount.
  const selectionCheckboxColumn = useMemo(
    () =>
      createSelectionCheckboxColumn({
        checkedRows,
        onChange: setCheckedRows,
      }),
    [checkedRows],
  );

  // Per-id width overrides applied on top of the dataset's default
  // widths. v1.2 column drag-to-resize commits widths here via
  // `onColumnResize` so width changes survive React re-renders.
  const [columnWidthOverrides, setColumnWidthOverrides] = useState<
    Record<string, number>
  >({});

  const memoryColumnsWithRenderer = useMemo(() => {
    if (!memoryDataset) return null;
    const baseColumns = memoryDataset.columns.map((c) => {
      const overridden = columnWidthOverrides[c.id];
      const withWidth = overridden !== undefined ? { ...c, width: overridden } : c;
      return c.id === 'status'
        ? { ...withWidth, renderer: statusPillRenderer }
        : withWidth;
    });
    return showCheckboxColumn
      ? [selectionCheckboxColumn, ...baseColumns]
      : baseColumns;
    // selectionCheckboxColumn is intentionally excluded from deps; the
    // factory mutates a module-scoped store on every call so the
    // identity of this column ref doesn't need to change for the
    // checkbox state to update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memoryDataset, showCheckboxColumn, columnWidthOverrides]);

  const safeColumns: ReadonlyArray<ColumnDef> = !dataReady
    ? EMPTY_COLUMNS
    : mode === 'memory'
      ? memoryColumnsWithRenderer ?? memoryDataset!.columns
      : mode === 'ssrm'
        ? SSRM_COLUMNS
        : mode === 'duckdb'
          ? DUCKDB_COLUMNS
          : mode === 'pivot'
            ? pivotResult!.columns
            : mode === 'tree'
              ? tree!.columns
              : mode === 'ssrm-tree'
                ? SSRM_TREE_COLUMNS
                : FORMULA_COLUMNS;
  // Wrap the memory-mode rowSource to swallow lookups for synthetic
  // columns (e.g. the selection-checkbox column) whose id isn't in
  // the underlying materialized table. Memoize so the wrapper's
  // identity is stable across renders — useOneGrid's setRowSource
  // effect depends on rowSource identity, and a fresh wrapper each
  // render would reset scrollTop / Fenwick on every render.
  const memoryRowSourceWrapped = useMemo<RowSource | null>(() => {
    if (mode !== 'memory') return null;
    const base =
      groupedRowSource ?? memoryView?.rowSource ?? memoryDataset?.rowSource;
    if (!base) return null;
    return {
      numRows: base.numRows,
      getCell: (row, colId) => {
        if (colId.startsWith('__onegrid_')) return null;
        return base.getCell(row, colId);
      },
    };
  }, [mode, groupedRowSource, memoryView, memoryDataset]);

  const safeRowSource: RowSource = !dataReady
    ? EMPTY_ROW_SOURCE
    : mode === 'memory'
      ? memoryRowSourceWrapped ?? memoryDataset!.rowSource
      : mode === 'ssrm'
        ? ssrm!.rowSource
        : mode === 'duckdb'
          ? duckdb!.rowSource
          : mode === 'pivot'
            ? pivotResult!.rowSource
            : mode === 'tree'
              ? tree!.rowSource
              : mode === 'ssrm-tree'
                ? ssrmTree!.rowSource
                : formula!.rowSource;
  const safeRowHeight: number | Float32Array =
    mode === 'memory' && memoryDataset ? memoryDataset.heights : 28;

  const handleHeaderClick = useCallback(
    (columnId: string) => {
      setSort((prev) => toggleSortFor(prev, columnId, shiftDown));
    },
    [shiftDown],
  );

  // Master-detail (memory mode only): track which rows are expanded.
  const [expandedRows, setExpandedRows] = useState<ReadonlySet<number>>(() => new Set());

  // Reset expansion when the dataset changes (mode/numRows shift).
  useEffect(() => {
    setExpandedRows(new Set());
  }, [mode, numRows]);

  // Per-row audit log. Lives in a Worker (lib/audit-worker.ts) with a
  // ring-buffer cap and IndexedDB persistence. Edits postMessage
  // append; the main thread never holds the log in React state, so
  // cell edits don't re-render the App. The detail panel queries the
  // worker on expand and mutates the inner Grid's row source when the
  // result arrives.
  const auditClientRef = useRef<AuditClient | null>(null);
  if (auditClientRef.current === null) {
    auditClientRef.current = new AuditClient();
  }

  // Map a visual row index back to the source row index for the current
  // memory view. Hoisted above `getDetailContent` so the detail panel
  // can resolve `visualRow → sourceRow` for the audit log lookup.
  const visualToSourceRow = useCallback(
    (visualRow: number): number => {
      if (memoryView?.permutation) return memoryView.permutation[visualRow] ?? visualRow;
      return visualRow;
    },
    [memoryView],
  );

  // Build an HTMLElement-returning detail content function only in memory
  // mode. Other modes don't need it; passing undefined is the off switch.
  const getDetailContent = useMemo<((rowIndex: number) => HTMLElement | null) | undefined>(() => {
    if (mode !== 'memory' || !memoryDataset?.materialized) return undefined;
    return (rowIndex: number): HTMLElement | null => {
      const root = document.createElement('div');
      root.style.cssText =
        'background:#11141a;border-top:1px solid #2a2f37;padding:10px 14px;' +
        'height:100%;box-sizing:border-box;color:#a5b1c2;font-size:12px;' +
        'display:flex;flex-direction:column;gap:6px;' +
        'font-family:ui-sans-serif,system-ui,sans-serif;';

      const title = document.createElement('div');
      title.style.cssText = 'font-weight:600;color:#e7e9ec;font-size:13px;';
      title.textContent = `Row ${String(rowIndex + 1)} · audit log (nested grid)`;
      root.appendChild(title);

      // Nested Grid: 10 synthetic audit-log entries for this row,
      // rendered through a real Grid instance. The inner grid has its
      // own canvas, scrollHost, ARIA shadow, and selection — fully
      // independent of the outer one. Cleanup happens via
      // onDetailUnmount, which calls grid.destroy().
      const innerHost = document.createElement('div');
      innerHost.style.cssText =
        'flex:1;min-height:0;position:relative;border:1px solid #2a2f37;border-radius:4px;overflow:hidden;';
      root.appendChild(innerHost);

      const innerColumns: ColumnDef[] = [
        { id: 'ts', width: 170, displayName: 'Timestamp', format: (v) => String(v ?? '') },
        { id: 'event', width: 100, displayName: 'Event', format: (v) => String(v ?? '') },
        { id: 'column', width: 110, displayName: 'Column', format: (v) => String(v ?? '') },
        { id: 'oldValue', width: 140, displayName: 'Old', format: (v) => String(v ?? '') },
        { id: 'newValue', width: 140, displayName: 'New', format: (v) => String(v ?? '') },
      ];
      const sourceRow = visualToSourceRow(rowIndex);
      // Mutable entries box. We start empty (shows "(loading…)") and
      // swap to real entries when the worker's query resolves. The
      // inner Grid's rowSource closes over this variable, so we can
      // call inner.setRowSource(innerRowSource, 24) with the same
      // object after mutation and it'll re-read the new data.
      let entries: ReadonlyArray<AuditEvent> = [];
      let loaded = false;
      const innerRowSource: RowSource = {
        get numRows(): number {
          return Math.max(1, entries.length);
        },
        getCell: (i, columnId) => {
          if (entries.length === 0) {
            if (columnId === 'event' && i === 0) {
              return loaded ? '(no edits yet)' : '(loading…)';
            }
            return '';
          }
          const e = entries[i];
          if (!e) return '';
          if (columnId === 'ts') {
            return new Date(e.ts).toISOString().slice(0, 19).replace('T', ' ');
          }
          if (columnId === 'event') return e.event;
          if (columnId === 'column') return e.columnId;
          if (columnId === 'oldValue') return e.oldValue;
          if (columnId === 'newValue') return e.newValue;
          return null;
        },
      };

      // Build the inner grid synchronously. innerHost still has size
      // 0 at this point (parent container hasn't laid it out), but the
      // Grid uses a ResizeObserver and will resize as soon as the
      // browser flushes layout.
      const inner = new Grid({
        host: innerHost,
        columns: innerColumns,
        rowSource: innerRowSource,
        rowHeight: 24,
        headerHeight: 28,
      });

      // Kick off the worker query. When it resolves, mutate `entries`
      // and re-bind the row source so the Grid re-renders with the
      // real audit history. We guard with `inner.host` in case the
      // panel was torn down before the worker replied.
      const client = auditClientRef.current;
      if (client) {
        void client.query(sourceRow).then((result) => {
          entries = result;
          loaded = true;
          try {
            inner.setRowSource(innerRowSource, 24);
          } catch {
            // Inner Grid was destroyed before the query came back.
          }
        });
      }
      // Stash the inner grid on the root element so onDetailUnmount
      // can find + destroy it. Using a Symbol-keyed prop avoids
      // colliding with anything the consumer might add.
      (root as unknown as { __innerGrid: Grid }).__innerGrid = inner;

      return root;
    };
    // visualToSourceRow swaps when sort/filter changes the
    // permutation, so detail panels must remap. The audit data itself
    // flows from the worker — no React tick needed.
  }, [mode, memoryDataset, visualToSourceRow]);

  const handleDetailUnmount = useCallback(
    (_rowIndex: number, el: HTMLElement): void => {
      const inner = (el as unknown as { __innerGrid?: { destroy: () => void } })
        .__innerGrid;
      if (inner) inner.destroy();
    },
    [],
  );

  const handleToggleExpand = useCallback((rowIndex: number) => {
    setExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(rowIndex)) next.delete(rowIndex);
      else next.add(rowIndex);
      return next;
    });
  }, []);

  // Tick to force a re-render after edits mutate underlying data so the
  // canvas re-reads cells. Used in memory mode (writeCell) and formula
  // mode (applyInput).
  const [editTick, setEditTick] = useState(0);

  // Undo / redo manager. Adopter (this playground) owns the data store
  // (`memoryDataset`); the manager just keeps the stack and dispatches
  // payloads back into `apply` on Cmd+Z / Cmd+Shift+Z.
  type UndoPayload = {
    readonly sourceRow: number;
    readonly columnId: string;
    readonly value: string;
  };
  const undoRef = useRef<UndoManager<UndoPayload> | null>(null);
  // undoMode tracks whether the next apply() callback is invoked from
  // .undo() vs .redo() vs neither, so we tag the audit-log entry
  // correctly. The undo manager itself doesn't expose this in apply.
  const undoModeRef = useRef<'undo' | 'redo' | null>(null);
  if (undoRef.current === null) {
    undoRef.current = createUndoManager<UndoPayload>({
      apply: (p) => {
        const ds = memoryDatasetRef.current;
        if (!ds?.materialized) return;
        const oldVal = ds.rowSource.getCell(p.sourceRow, p.columnId);
        if (ds.writeCell(p.sourceRow, p.columnId, p.value)) {
          auditClientRef.current?.append({
            sourceRow: p.sourceRow,
            ts: Date.now(),
            event: undoModeRef.current ?? 'edit',
            columnId: p.columnId,
            oldValue: String(oldVal ?? ''),
            newValue: p.value,
          });
        }
        setEditTick((t) => t + 1);
      },
    });
  }
  // memoryDataset can swap when the user changes presets / mode. Keep
  // an always-fresh ref so the undo manager's apply() writes to the
  // current dataset rather than a captured stale one.
  const memoryDatasetRef = useRef(memoryDataset);
  memoryDatasetRef.current = memoryDataset;

  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const k = e.key.toLowerCase();
      const t = e.target;
      if (t instanceof HTMLElement) {
        const tag = t.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable) return;
      }
      if (k === 'z' && !e.shiftKey) {
        e.preventDefault();
        undoModeRef.current = 'undo';
        undoRef.current?.undo();
        undoModeRef.current = null;
      } else if ((k === 'z' && e.shiftKey) || k === 'y') {
        e.preventDefault();
        undoModeRef.current = 'redo';
        undoRef.current?.redo();
        undoModeRef.current = null;
      }
    };
    document.addEventListener('keydown', handler, true);
    return () => {
      document.removeEventListener('keydown', handler, true);
    };
  }, []);

  // Clear the undo stack + worker audit log when the underlying
  // dataset swaps — past entries refer to row indices that no longer
  // exist in the new dataset.
  useEffect(() => {
    undoRef.current?.clear();
    auditClientRef.current?.clear();
  }, [memoryDataset]);

  // Terminate the worker on unmount.
  useEffect(() => {
    return () => {
      auditClientRef.current?.destroy();
      auditClientRef.current = null;
    };
  }, []);

  const editable = useMemo<
    boolean | ((rowIndex: number, columnId: string) => boolean) | undefined
  >(() => {
    if (mode === 'memory' && memoryDataset?.materialized) {
      return (_row, columnId) => columnId !== 'rowIndex';
    }
    if (mode === 'formula') return true;
    return undefined;
  }, [mode, memoryDataset]);

  const handleCellEdit = useCallback(
    (rowIndex: number, columnId: string, newValue: string, oldValue: unknown): void => {
      if (mode === 'memory' && memoryDataset?.materialized) {
        const sourceRow = visualToSourceRow(rowIndex);
        const oldStr = String(oldValue ?? '');
        const ok = memoryDataset.writeCell(sourceRow, columnId, newValue);
        if (ok) {
          undoRef.current?.push({
            kind: 'cellEdit',
            label: 'Edit cell',
            forward: { sourceRow, columnId, value: newValue },
            inverse: { sourceRow, columnId, value: oldStr },
          });
          auditClientRef.current?.append({
            sourceRow,
            ts: Date.now(),
            event: 'edit',
            columnId,
            oldValue: oldStr,
            newValue,
          });
          setEditTick((t) => t + 1);
        }
        return;
      }
      if (mode === 'formula' && formula) {
        const id = formula.cellIdAt(rowIndex, columnId);
        formula.applyInput(id, newValue);
        setFormulaTick((t) => t + 1);
        return;
      }
    },
    [mode, memoryDataset, formula, visualToSourceRow],
  );

  // Pinned-bottom totals row: only meaningful in materialized memory mode.
  // Numeric columns sum into a single pinned row that lives beneath the
  // scrollable data and tracks live edits via editTick.
  const pinnedBottom = useMemo<RowSource | undefined>(() => {
    if (mode !== 'memory' || !memoryDataset?.materialized) return undefined;
    const totals: Record<string, unknown> = {};
    const numRows = memoryDataset.rowSource.numRows;
    for (const col of memoryDataset.columns) {
      let sum = 0;
      let any = false;
      for (let r = 0; r < numRows; r++) {
        const v = memoryDataset.rowSource.getCell(r, col.id);
        const n = typeof v === 'number' ? v : Number(v);
        if (Number.isFinite(n)) {
          sum += n;
          any = true;
        }
      }
      totals[col.id] = any ? sum : '';
    }
    totals.firstName = 'Σ totals';
    return {
      numRows: 1,
      getCell: (_row, columnId) => totals[columnId] ?? '',
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, memoryDataset, editTick]);

  // Column groups: only show in memory mode for the materialized dataset.
  // Maps the synthetic schema into three logical groups.
  const columnGroups = useMemo(() => {
    if (mode !== 'memory' || !memoryDataset?.materialized) return undefined;
    return [
      { label: 'Identity', columnIds: ['rowIndex', 'firstName', 'lastName'] },
      { label: 'Activity', columnIds: ['revenue', 'status'] },
      { label: 'Health', columnIds: ['score', 'updatedAt'] },
    ];
  }, [mode, memoryDataset]);

  const handlePaste = useCallback(
    (
      anchorRow: number,
      anchorCol: number,
      pasted: ReadonlyArray<ReadonlyArray<string>>,
    ): void => {
      if (mode === 'memory' && memoryDataset?.materialized) {
        let wrote = false;
        undoRef.current?.transaction(
          () => {
            for (let r = 0; r < pasted.length; r++) {
              const row = pasted[r]!;
              const visualRow = anchorRow + r;
              if (visualRow >= safeRowSource.numRows) break;
              const sourceRow = visualToSourceRow(visualRow);
              for (let c = 0; c < row.length; c++) {
                const colIdx = anchorCol + c;
                const column = safeColumns[colIdx];
                if (!column || column.id === 'rowIndex') continue;
                const oldVal = memoryDataset.rowSource.getCell(sourceRow, column.id);
                const newVal = row[c] ?? '';
                if (memoryDataset.writeCell(sourceRow, column.id, newVal)) {
                  wrote = true;
                  const oldStr = String(oldVal ?? '');
                  undoRef.current?.push({
                    kind: 'paste',
                    forward: { sourceRow, columnId: column.id, value: newVal },
                    inverse: { sourceRow, columnId: column.id, value: oldStr },
                  });
                  auditClientRef.current?.append({
                    sourceRow,
                    ts: Date.now(),
                    event: 'paste',
                    columnId: column.id,
                    oldValue: oldStr,
                    newValue: newVal,
                  });
                }
              }
            }
          },
          { kind: 'paste', label: 'Paste' },
        );
        if (wrote) setEditTick((t) => t + 1);
        return;
      }
      if (mode === 'formula' && formula) {
        for (let r = 0; r < pasted.length; r++) {
          const row = pasted[r]!;
          const visualRow = anchorRow + r;
          if (visualRow >= FORMULA_ROW_COUNT) break;
          for (let c = 0; c < row.length; c++) {
            const colIdx = anchorCol + c;
            const colId = indexToColumnId(colIdx);
            if (!colId) continue;
            const cellId = formula.cellIdAt(visualRow, colId);
            formula.applyInput(cellId, row[c] ?? '');
          }
        }
        setFormulaTick((t) => t + 1);
        return;
      }
    },
    [mode, memoryDataset, formula, safeColumns, safeRowSource, visualToSourceRow],
  );

  const { ref, grid } = useOneGrid({
    columns: safeColumns,
    rowSource: safeRowSource,
    rowHeight: safeRowHeight,
    headerHeight: 32,
    frozenColumnCount:
      mode === 'formula'
        ? 0
        : mode === 'memory' && showCheckboxColumn
          ? 2
          : 1,
    sort,
    expanded: expandedRows,
    detailHeight: 200,
    // Conditionally spread optional callbacks/props so undefined isn't
    // assigned to optional fields (exactOptionalPropertyTypes).
    ...(getDetailContent
      ? { getDetailContent, onDetailUnmount: handleDetailUnmount }
      : {}),
    ...(editable !== undefined ? { editable } : {}),
    ...(pinnedBottom ? { pinnedBottomRowSource: pinnedBottom } : {}),
    ...(columnGroups ? { columnGroups } : {}),
    ...(groupedFlat || mode === 'tree' || mode === 'ssrm-tree'
      ? { getRowMeta, onToggleGroup: handleToggleGroup }
      : {}),
    ...(mode === 'memory'
      ? {
          floatingFilters: true,
          onFloatingFilterChange: handleFloatingFilterChange,
        }
      : {}),
    // Column reorder is opt-in. Enable it in modes where the column
    // set is stable enough that the grid's internal mutation won't be
    // immediately overwritten by a fresh `columns` prop. The callback
    // is intentionally side-effect-free here — the Grid owns the
    // post-drag order.
    ...(mode === 'memory' || mode === 'ssrm' || mode === 'duckdb'
      ? {
          enableColumnReorder: true,
          enableColumnResize: true,
          onColumnResize: (
            columnId: string,
            newWidth: number,
          ): void => {
            // Commit on every callback (not just finalCommit) so the
            // React-level columns memo stays in sync with the Grid's
            // internal widths. Without this, unrelated re-renders mid-
            // drag (e.g., FPS state updates) snap the Grid back to
            // its original widths because useOneGrid sees stale
            // options.columns.
            setColumnWidthOverrides((prev) =>
              prev[columnId] === newWidth ? prev : { ...prev, [columnId]: newWidth },
            );
          },
        }
      : {}),
    ...(mode === 'memory' && memoryDataset?.materialized
      ? {
          enableFillHandle: true,
          onFillHandle: (
            source: { rowStart: number; rowEnd: number; colStart: number; colEnd: number },
            fill: { rowStart: number; rowEnd: number; colStart: number; colEnd: number },
          ): void => {
            // Excel-style copy: the top-left cell of the source range
            // is the seed; populate every cell in the fill rect that
            // is OUTSIDE the source rect with the seed value, on a
            // per-column basis (preserves the column's data type).
            if (!memoryDataset.materialized) return;
            undoRef.current?.transaction(
              () => {
                for (let r = fill.rowStart; r <= fill.rowEnd; r++) {
                  for (let c = fill.colStart; c <= fill.colEnd; c++) {
                    const inSource =
                      r >= source.rowStart &&
                      r <= source.rowEnd &&
                      c >= source.colStart &&
                      c <= source.colEnd;
                    if (inSource) continue;
                    const seedRow = source.rowStart;
                    const colDef = memoryDataset.columns[c];
                    if (!colDef) continue;
                    const seedVal = memoryDataset.rowSource.getCell(
                      visualToSourceRow(seedRow),
                      colDef.id,
                    );
                    const sourceRow = visualToSourceRow(r);
                    const oldVal = memoryDataset.rowSource.getCell(sourceRow, colDef.id);
                    const newVal = String(seedVal ?? '');
                    if (memoryDataset.writeCell(sourceRow, colDef.id, newVal)) {
                      const oldStr = String(oldVal ?? '');
                      undoRef.current?.push({
                        kind: 'fillHandle',
                        forward: { sourceRow, columnId: colDef.id, value: newVal },
                        inverse: {
                          sourceRow,
                          columnId: colDef.id,
                          value: oldStr,
                        },
                      });
                      auditClientRef.current?.append({
                        sourceRow,
                        ts: Date.now(),
                        event: 'fill',
                        columnId: colDef.id,
                        oldValue: oldStr,
                        newValue: newVal,
                      });
                    }
                  }
                }
              },
              { kind: 'fillHandle', label: 'Fill range' },
            );
            setEditTick((t) => t + 1);
          },
        }
      : {}),
    onContextMenu: (target) => {
      setContextMenu(target);
    },
    statusBar: true,
    onCellEdit: handleCellEdit,
    onPaste: handlePaste,
    onToggleExpand: handleToggleExpand,
    onFrame: (s) => {
      setStats(s);
    },
    onHeaderClick: handleHeaderClick,
    onSelectionChange: (selection) => {
      // In formula mode, mirror the active cell into the formula bar.
      if (mode !== 'formula' || !formula || !selection.active) return;
      const id = formula.cellIdAt(selection.active.row, indexToColumnId(selection.active.col));
      setFormulaActiveCell(id);
      setFormulaInput(formula.getDisplaySource(id));
    },
  });

  // Sync expanded set into the live grid imperatively. Re-creating the
  // grid on every Set identity change would cost a full unmount/remount.
  useEffect(() => {
    grid?.setExpanded(expandedRows);
  }, [grid, expandedRows]);

  // SSRM: when blocks land, ask the grid to repaint. scrollBy(0) is a
  // no-op when scroll position is unchanged, so use the explicit refresh.
  useEffect(() => {
    if (!grid || mode !== 'ssrm') return;
    grid.refresh();
  }, [grid, ssrmTick, mode]);

  // DuckDB: same idea as SSRM — block lands, repaint visible rows.
  useEffect(() => {
    if (!grid || mode !== 'duckdb') return;
    grid.refresh();
  }, [grid, duckdbTick, mode]);

  // Tree mode: every toggle (or async lazy-load completion) bumps
  // treeTick; the rowSource is the same object (it has live getters)
  // so we just need to nudge the renderer.
  useEffect(() => {
    if (!grid || mode !== 'tree') return;
    grid.refresh();
  }, [grid, treeTick, mode]);

  // SSRM-tree mode: ssrmTree.handle is a *live* RowSource (numRows
  // grows as children fetches land), but Grid's Fenwick heights are
  // sized to numRows at setRowSource time — refresh() alone won't
  // resize them. So every tick we re-call setRowSource against the
  // same handle, which rebuilds Fenwick + aria-rowcount.
  useEffect(() => {
    if (!grid || mode !== 'ssrm-tree' || !ssrmTree) return;
    grid.setRowSource(ssrmTree.rowSource, 28);
  }, [grid, ssrmTreeTick, mode, ssrmTree]);

  // Push sort state into the underlying data source. SSRM mode invalidates
  // the row-source cache and refetches; in-memory mode rebuilds memoryView
  // through @onegrid/data's sortIndex on every change.
  useEffect(() => {
    if (!grid) return;
    grid.setSort(sort);
    grid.scrollToRow(0);
    if (mode === 'ssrm' && ssrm) {
      ssrm.handle.setSort(sort);
    }
  }, [sort, grid, mode, ssrm]);

  // Debounce the filter box for SSRM: only the value that sits still for
  // 150ms reaches the server.
  useEffect(() => {
    if (mode !== 'ssrm') return undefined;
    const timer = setTimeout(() => {
      setSsrmFilterQuery(filterQuery);
    }, 150);
    return () => {
      clearTimeout(timer);
    };
  }, [filterQuery, mode]);

  // SSRM set-filter popover: ask the server for the column's distinct values
  // under the other active filters whenever a popover opens.
  useEffect(() => {
    if (mode !== 'ssrm' || !ssrm || setFilterOpenFor === null) return undefined;
    const rule = columnFilters.find((r) => r.id === setFilterOpenFor);
    if (!rule) return undefined;
    const ruleId = rule.id;
    const controller = new AbortController();
    setSsrmDistinct(null);
    void ssrm.handle
      .fetchDistinct(rule.columnId, { limit: 1000, signal: controller.signal })
      .then((result) => {
        setSsrmDistinct(
          result.kind === 'distinct'
            ? { ruleId, distinct: result.entry }
            : { ruleId, error: result.reason },
        );
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setSsrmDistinct({ ruleId, error: String(err) });
      });
    return () => {
      controller.abort();
    };
  }, [mode, ssrm, setFilterOpenFor, columnFilters]);

  // SSRM filter wiring: forward the merged FilterModel to the row source,
  // which invalidates blocks and refetches on next read.
  useEffect(() => {
    if (mode !== 'ssrm' || !ssrm) return;
    const columnIds = SSRM_COLUMNS.map((c) => c.id);
    const quick = buildQuickFilter(ssrmFilterQuery, columnIds);
    const columnar = buildColumnFilter(columnFilters);
    let merged: FilterModel = null;
    if (quick && columnar) {
      merged = { type: 'logical', op: 'and', filters: [quick, columnar] };
    } else {
      merged = quick ?? columnar;
    }
    ssrm.handle.setFilter(merged);
    grid?.scrollToRow(0);
  }, [ssrmFilterQuery, columnFilters, mode, ssrm, grid]);

  // Memory mode: when sort or filter changes, scroll to top and refresh so
  // the renderer reads through the new permutation.
  useEffect(() => {
    if (mode !== 'memory' || !grid) return;
    grid.scrollToRow(0);
    grid.refresh();
  }, [memoryView, grid, mode]);

  // Memory mode: writeCell mutates underlying typed arrays in place. The
  // canvas reads through getCell on every frame, but we still need to
  // explicitly force one pass after an edit so the cell repaints
  // immediately on commit (rather than waiting for the next scroll).
  useEffect(() => {
    if (mode !== 'memory' || !grid || editTick === 0) return;
    grid.refresh();
  }, [editTick, grid, mode]);

  const addColumnFilter = useCallback(() => {
    // Default to the first non-rowIndex column of the active mode so
    // adding a filter doesn't pre-select a useless column.
    const firstColumn =
      safeColumns.find((c) => c.id !== 'rowIndex')?.id ??
      safeColumns[0]?.id ??
      'firstName';
    setColumnFilters((prev) => [...prev, newFilterRule(firstColumn)]);
  }, [safeColumns]);

  const updateColumnFilter = useCallback(
    (id: string, patch: Partial<FilterRule>): void => {
      setColumnFilters((prev) =>
        prev.map((rule) => (rule.id === id ? { ...rule, ...patch } : rule)),
      );
    },
    [],
  );

  const removeColumnFilter = useCallback((id: string): void => {
    setColumnFilters((prev) => prev.filter((rule) => rule.id !== id));
  }, []);

  const clearAllColumnFilters = useCallback(() => {
    setColumnFilters([]);
  }, []);

  // Formula mode: every cell edit bumps formulaTick → grid.refresh() so the
  // canvas re-reads via getCell, which in turn calls engine.getValue (Adapton-
  // style demand-driven recompute). Cells that aren't visible are not
  // recomputed on read.
  useEffect(() => {
    if (mode !== 'formula' || !grid) return;
    grid.refresh();
  }, [grid, mode, formulaTick]);

  const applyFormula = useCallback(() => {
    if (!formula) return;
    formula.applyInput(formulaActiveCell, formulaInput);
    setFormulaTick((t) => t + 1);
    setFormulaInput(formula.getDisplaySource(formulaActiveCell));
  }, [formula, formulaActiveCell, formulaInput]);

  // Keep refs to anything the __onegrid test bridge dereferences, so
  // its closures always see the latest values even though the bridge
  // useEffect only re-binds on `grid`. Without this, e.g. visualToSourceRow
  // would be frozen at the first-mount permutation and readCell(0)
  // would skip past the user's sort.
  const visualToSourceRowRef = useRef(visualToSourceRow);
  visualToSourceRowRef.current = visualToSourceRow;
  const memoryDatasetBridgeRef = useRef(memoryDataset);
  memoryDatasetBridgeRef.current = memoryDataset;

  useEffect(() => {
    if (!grid) return;
    window.__onegrid = {
      getMetrics: () => grid.getMetricsSnapshot(),
      reset: () => {
        grid.resetMetrics();
      },
      scrollBy: (dy) => {
        grid.scrollBy(dy);
      },
      scrollToRow: (i) => {
        grid.scrollToRow(i);
      },
      getColumns: () => grid.getColumns(),
      getViewportInfo: () => grid.getViewportInfo(),
      host: grid['host' as never] as unknown as HTMLElement,
      setRows: (n) => {
        setNumRows(n as (typeof ROW_OPTIONS)[number]);
      },
      setSort: (s) => {
        setSort(s);
      },
      getSort: () => sort,
      setFilter: (q) => {
        setFilterQuery(q);
      },
      getFilter: () => filterQuery,
      formulaSet: (id, input) => {
        formula?.applyInput(id, input);
        setFormulaTick((t) => t + 1);
      },
      formulaGet: (id) => formula?.engine.getValue(id),
      formulaStats: () => formula?.engine.getStats(),
      // Test bridges:
      setMode: (m) => {
        setMode(m as typeof mode);
      },
      getMode: () => mode,
      undo: () => {
        undoModeRef.current = 'undo';
        undoRef.current?.undo();
        undoModeRef.current = null;
      },
      redo: () => {
        undoModeRef.current = 'redo';
        undoRef.current?.redo();
        undoModeRef.current = null;
      },
      undoState: () => undoRef.current?.state(),
      auditQuery: async (sourceRow: number) => {
        return (await auditClientRef.current?.query(sourceRow)) ?? [];
      },
      auditAppend: (sourceRow, ts, event, columnId, oldValue, newValue) => {
        auditClientRef.current?.append({ sourceRow, ts, event, columnId, oldValue, newValue });
      },
      auditClear: () => {
        auditClientRef.current?.clear();
      },
      writeCell: (visualRow, columnId, newValue) => {
        const ds = memoryDatasetBridgeRef.current;
        if (!ds?.materialized) return false;
        const sourceRow = visualToSourceRowRef.current(visualRow);
        const oldValue = ds.rowSource.getCell(sourceRow, columnId);
        const ok = ds.writeCell(sourceRow, columnId, newValue);
        if (ok) {
          undoRef.current?.push({
            kind: 'cellEdit',
            label: 'Edit cell',
            forward: { sourceRow, columnId, value: newValue },
            inverse: { sourceRow, columnId, value: String(oldValue ?? '') },
          });
          auditClientRef.current?.append({
            sourceRow,
            ts: Date.now(),
            event: 'edit',
            columnId,
            oldValue: String(oldValue ?? ''),
            newValue,
          });
          setEditTick((t) => t + 1);
        }
        return ok;
      },
      readCell: (visualRow, columnId) => {
        const ds = memoryDatasetBridgeRef.current;
        if (!ds?.materialized) return null;
        const sourceRow = visualToSourceRowRef.current(visualRow);
        return ds.rowSource.getCell(sourceRow, columnId);
      },
    };
    return () => {
      delete window.__onegrid;
    };
  }, [grid]);

  const copyMetrics = (): void => {
    if (!grid) return;
    const snap = grid.getMetricsSnapshot();
    void navigator.clipboard.writeText(JSON.stringify(snap, null, 2));
    console.log('[onegrid] metrics snapshot', snap);
  };

  /** Materialize up to N rows from the active row source for export.
   *  SSRM mode pulls only what's already in the row-source cache. */
  const collectExportData = (
    maxRows = 50_000,
  ): {
    rows: ReadonlyArray<Record<string, unknown>>;
    columns: ReadonlyArray<ExportColumn>;
  } => {
    const exportColumns: ExportColumn[] = safeColumns.map((c) => {
      const fmt = c.format;
      return {
        id: c.id,
        header: c.displayName ?? c.id,
        ...(fmt ? { format: (v: unknown, i: number) => fmt(v, i) } : {}),
      };
    });
    const limit = Math.min(safeRowSource.numRows, maxRows);
    const rows: Record<string, unknown>[] = [];
    for (let i = 0; i < limit; i++) {
      const row: Record<string, unknown> = {};
      for (const c of safeColumns) row[c.id] = safeRowSource.getCell(i, c.id);
      rows.push(row);
    }
    return { rows, columns: exportColumns };
  };

  const handleExportCsv = (): void => {
    const { rows, columns: cols } = collectExportData();
    const date = new Date().toISOString().slice(0, 10);
    downloadCsv(rows, cols, `onegrid-${mode}-${date}.csv`, { bom: true });
  };

  const handleExportXlsx = async (): Promise<void> => {
    const { rows, columns: cols } = collectExportData();
    const date = new Date().toISOString().slice(0, 10);
    await downloadXlsx(rows, cols, `onegrid-${mode}-${date}.xlsx`, {
      sheetName: 'oneGrid Export',
      meta: { title: 'oneGrid export', author: 'oneGrid' },
    });
  };

  return (
    <div className="app">
      <div className="toolbar">
        <h1>oneGrid · v0.1.0</h1>

        <label className="mode-picker">
          Mode{' '}
          <select
            value={mode}
            onChange={(e) => {
              setMode(e.target.value as typeof mode);
            }}
            aria-label="data source mode"
          >
            <option value="memory">In-memory</option>
            <option value="ssrm">SSRM</option>
            <option value="formula">Formula</option>
            <option value="duckdb">DuckDB</option>
            <option value="pivot">Pivot</option>
            <option value="tree">Tree</option>
            <option value="ssrm-tree">SSRM Tree</option>
            <option value="studio">Studio</option>
          </select>
        </label>

        {mode === 'memory' && (
          <>
            <label>
              Rows{' '}
              <select
                value={numRows}
                onChange={(e) => {
                  setNumRows(
                    Number(e.target.value) as (typeof ROW_OPTIONS)[number],
                  );
                }}
              >
                {ROW_OPTIONS.map((n) => (
                  <option key={n} value={n}>
                    {n.toLocaleString()}
                  </option>
                ))}
              </select>
            </label>
            <span style={{ color: 'var(--muted)' }}>
              gen {genMs}ms ·{' '}
              {memoryDataset?.materialized
                ? `${safeRowSource.numRows.toLocaleString()} rows`
                : `${numRows.toLocaleString()} rows (lazy — sort/filter disabled)`}
            </span>
            {memoryDataset?.materialized && (
              <>
                <input
                  type="search"
                  placeholder="Quick filter…"
                  value={filterQuery}
                  onChange={(e) => {
                    setFilterQuery(e.target.value);
                  }}
                  style={{ minWidth: 180 }}
                />
                <button
                  type="button"
                  onClick={() => {
                    setShowFilterPanel((s) => !s);
                  }}
                  style={{ fontWeight: showFilterPanel ? 600 : 400 }}
                >
                  Filters{columnFilters.length > 0 ? ` (${String(columnFilters.length)})` : ''}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowColumnPanel((s) => !s);
                  }}
                  style={{ fontWeight: showColumnPanel ? 600 : 400 }}
                >
                  Columns
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowCheckboxColumn((s) => !s);
                  }}
                  style={{ fontWeight: showCheckboxColumn ? 600 : 400 }}
                >
                  Selection col
                </button>
                {showCheckboxColumn && (
                  <SelectAllCheckbox
                    checkedRows={checkedRows}
                    onChange={setCheckedRows}
                    totalRows={safeRowSource.numRows}
                  />
                )}
                <label style={{ color: 'var(--muted)', fontSize: 12 }}>
                  Group by{' '}
                  <select
                    value={groupByColumn}
                    onChange={(e) => {
                      setGroupByColumn(e.target.value as 'none' | 'status');
                      setOpenGroups(new Set());
                    }}
                  >
                    <option value="none">none</option>
                    <option value="status">status</option>
                  </select>
                </label>
              </>
            )}
          </>
        )}

        {mode === 'ssrm' && (
          <>
            <span style={{ color: 'var(--muted)' }}>
              {ssrmStatus === 'connecting' && 'connecting…'}
              {ssrmStatus === 'connected' && ssrm
                ? `${safeRowSource.numRows.toLocaleString()} rows · cache ${String(ssrm.handle.getCacheSize())} blocks`
                : ''}
              {ssrmStatus === 'error' && 'connect failed (start: pnpm dev:server)'}
            </span>
            <input
              type="search"
              placeholder="Quick filter…"
              value={filterQuery}
              onChange={(e) => {
                setFilterQuery(e.target.value);
              }}
              style={{ minWidth: 180 }}
            />
            <button
              type="button"
              onClick={() => {
                setShowFilterPanel((s) => !s);
              }}
              style={{ fontWeight: showFilterPanel ? 600 : 400 }}
            >
              Filters{columnFilters.length > 0 ? ` (${String(columnFilters.length)})` : ''}
            </button>
          </>
        )}

        {mode === 'duckdb' && (
          <span style={{ color: 'var(--muted)' }}>
            {duckdbStatus === 'connecting' && `${duckdbProgress}`}
            {duckdbStatus === 'connected' && duckdb
              ? `${safeRowSource.numRows.toLocaleString()} rows · cache ${String(duckdb.handle.getCacheSize())} blocks`
              : ''}
            {duckdbStatus === 'error' && 'duckdb-wasm load failed (check network/CDN)'}
          </span>
        )}

        {mode === 'formula' && formula && (
          <>
            <span style={{ color: 'var(--muted)', fontFamily: 'ui-monospace, monospace' }}>
              {formulaActiveCell}
            </span>
            <input
              type="text"
              value={formulaInput}
              onChange={(e) => {
                setFormulaInput(e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  applyFormula();
                }
              }}
              placeholder="Type a value or =FORMULA, then Enter…"
              spellCheck={false}
              style={{
                minWidth: 320,
                fontFamily: 'ui-monospace, monospace',
              }}
            />
            <button type="button" onClick={applyFormula}>
              Apply
            </button>
            <span style={{ color: 'var(--muted)', fontSize: 12 }}>
              {(() => {
                const stats = formula.engine.getStats();
                return `${String(stats.formulaCount)} formulas · ${String(
                  stats.edgeCount,
                )} edges · ${String(stats.dirtyCount)} dirty`;
              })()}
            </span>
          </>
        )}

        <details className="menu">
          <summary>Demos</summary>
          <div className="menu-panel">
            <button
              type="button"
              data-testid="v009-demo-toggle"
              onClick={() => {
                setShowV009Demo((s) => !s);
              }}
              style={{ fontWeight: showV009Demo ? 600 : 400 }}
            >
              v0.0.9
            </button>
            <button
              type="button"
              data-testid="v010-demo-toggle"
              onClick={() => {
                setShowV010Demo((s) => !s);
              }}
              style={{ fontWeight: showV010Demo ? 600 : 400 }}
            >
              v0.0.10
            </button>
            <button
              type="button"
              data-testid="v011-demo-toggle"
              onClick={() => {
                setShowV011Demo((s) => !s);
              }}
              style={{ fontWeight: showV011Demo ? 600 : 400 }}
            >
              v0.0.11
            </button>
            <button
              type="button"
              data-testid="v100-demo-toggle"
              onClick={() => {
                setShowV100Demo((s) => !s);
              }}
              style={{ fontWeight: showV100Demo ? 600 : 400 }}
            >
              v0.1.0
            </button>
          </div>
        </details>

        <details className="menu">
          <summary>Export</summary>
          <div className="menu-panel">
            <button type="button" onClick={handleExportCsv} disabled={!dataReady}>
              CSV
            </button>
            <button
              type="button"
              onClick={() => {
                void handleExportXlsx();
              }}
              disabled={!dataReady}
            >
              XLSX
            </button>
          </div>
        </details>

        <details className="menu">
          <summary>Metrics</summary>
          <div className="menu-panel">
            <button type="button" onClick={copyMetrics}>
              Copy
            </button>
            <button
              type="button"
              onClick={() => {
                grid?.resetMetrics();
              }}
            >
              Reset
            </button>
            <button
              type="button"
              onClick={() => {
                void runGpuBench();
              }}
              title={gpuStatus}
            >
              GPU bench
            </button>
          </div>
        </details>
        <div className="meter">
          <span>
            FPS <strong>{stats?.fps ?? 0}</strong>
          </span>
          <span>
            draw{' '}
            <strong>{stats ? stats.drawDurationMs.toFixed(1) : '0.0'}</strong> ms
          </span>
          <span>
            visible{' '}
            <strong>
              {stats?.visibleRowStart ?? 0}–{stats?.visibleRowEnd ?? 0}
            </strong>
          </span>
          <span>
            cells/frame <strong>{stats?.drawCellsPerFrame ?? 0}</strong>
          </span>
        </div>
      </div>
      {(mode === 'ssrm' || mode === 'memory') && showFilterPanel && (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            padding: '10px 16px',
            background: 'var(--panel)',
            borderBottom: '1px solid var(--border)',
            fontSize: 12,
          }}
        >
          {columnFilters.length === 0 && (
            <div style={{ color: 'var(--muted)' }}>
              No column filters. Click <strong>Add filter</strong> to narrow with typed comparisons.
            </div>
          )}
          {columnFilters.map((rule) => {
            const opMeta = FILTER_OPS.find((o) => o.op === rule.op);
            return (
              <div
                key={rule.id}
                style={{ display: 'flex', gap: 6, alignItems: 'center' }}
              >
                <select
                  value={rule.columnId}
                  onChange={(e) => {
                    updateColumnFilter(rule.id, { columnId: e.target.value });
                  }}
                >
                  {safeColumns.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.displayName ?? c.id}
                    </option>
                  ))}
                </select>
                <select
                  value={rule.op}
                  onChange={(e) => {
                    updateColumnFilter(rule.id, { op: e.target.value as FilterOp });
                  }}
                >
                  {FILTER_OPS.map((o) => (
                    <option key={o.op} value={o.op}>
                      {o.label}
                    </option>
                  ))}
                </select>
                {isSetOp(rule.op) ? (
                  <div style={{ position: 'relative', flex: '0 1 240px' }}>
                    <button
                      type="button"
                      data-testid="set-filter-trigger"
                      onClick={() => {
                        setSetFilterOpenFor(
                          setFilterOpenFor === rule.id ? null : rule.id,
                        );
                      }}
                      style={{ width: '100%', textAlign: 'left' }}
                    >
                      {rule.values && rule.values.length > 0
                        ? `${String(rule.values.length)} value${rule.values.length === 1 ? '' : 's'} picked`
                        : 'Pick values…'}
                    </button>
                    {setFilterOpenFor === rule.id &&
                      mode === 'memory' &&
                      memoryTableIndex && (
                        <SetFilterPopover
                          distinct={enumerateDistinctIndexed(memoryTableIndex, rule.columnId, {
                            limit: 1000,
                          })}
                          selected={rule.values ?? []}
                          onApply={(values) => {
                            updateColumnFilter(rule.id, { values });
                          }}
                          onClose={() => {
                            setSetFilterOpenFor(null);
                          }}
                        />
                      )}
                    {setFilterOpenFor === rule.id &&
                      mode === 'ssrm' &&
                      ssrmDistinct !== null &&
                      ssrmDistinct.ruleId === rule.id &&
                      'distinct' in ssrmDistinct && (
                        <SetFilterPopover
                          distinct={ssrmDistinct.distinct}
                          selected={rule.values ?? []}
                          onApply={(values) => {
                            updateColumnFilter(rule.id, { values });
                          }}
                          onClose={() => {
                            setSetFilterOpenFor(null);
                          }}
                        />
                      )}
                    {setFilterOpenFor === rule.id &&
                      mode !== 'memory' &&
                      !(
                        mode === 'ssrm' &&
                        ssrmDistinct !== null &&
                        ssrmDistinct.ruleId === rule.id &&
                        'distinct' in ssrmDistinct
                      ) && (
                      <div
                        role="dialog"
                        style={{
                          position: 'absolute',
                          zIndex: 50,
                          background: 'var(--panel)',
                          border: '1px solid var(--border)',
                          borderRadius: 6,
                          padding: 12,
                          color: 'var(--muted)',
                          fontSize: 12,
                          maxWidth: 280,
                        }}
                      >
                        {mode === 'ssrm'
                          ? ssrmDistinct !== null &&
                            ssrmDistinct.ruleId === rule.id &&
                            'error' in ssrmDistinct
                            ? `The server could not list values: ${ssrmDistinct.error}`
                            : 'Loading values from the server…'
                          : 'Set filter values are enumerated locally. DuckDB / Pivot modes need server-side distinct; coming in a follow-up commit.'}
                        <div style={{ marginTop: 8 }}>
                          <button
                            type="button"
                            onClick={() => {
                              setSetFilterOpenFor(null);
                            }}
                          >
                            Close
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  <input
                    type="text"
                    placeholder={isUnaryOp(rule.op) ? '(no value)' : 'value'}
                    value={rule.value}
                    disabled={isUnaryOp(rule.op)}
                    onChange={(e) => {
                      updateColumnFilter(rule.id, { value: e.target.value });
                    }}
                    style={{
                      flex: '0 1 240px',
                      opacity: isUnaryOp(rule.op) || opMeta ? 1 : 0.5,
                    }}
                  />
                )}
                <button
                  type="button"
                  onClick={() => {
                    removeColumnFilter(rule.id);
                  }}
                  aria-label="remove filter"
                >
                  ×
                </button>
              </div>
            );
          })}
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" onClick={addColumnFilter}>
              + Add filter
            </button>
            {columnFilters.length > 0 && (
              <button type="button" onClick={clearAllColumnFilters}>
                Clear all
              </button>
            )}
          </div>
        </div>
      )}
      <div style={{ position: 'relative', flex: 1, minHeight: 0, display: 'flex' }}>
        {mode === 'studio' ? (
          <div style={{ flex: 1, minHeight: 0 }}>
            <StudioDemo />
          </div>
        ) : (
        <div
          ref={ref}
          style={{ flex: 1, position: 'relative', overflow: 'hidden' }}
        />
        )}
        {showColumnPanel && (
          <div
            style={{
              width: 240,
              flex: '0 0 240px',
              borderLeft: '1px solid var(--border)',
              background: 'var(--panel)',
              padding: 8,
              overflow: 'auto',
            }}
          >
            <ColumnToolPanel grid={grid} />
          </div>
        )}
        {showV009Demo && (
          <div
            style={{
              flex: '0 0 auto',
              borderLeft: '1px solid var(--border)',
              padding: 8,
              overflow: 'auto',
            }}
          >
            <V009Demo />
          </div>
        )}
        {showV010Demo && (
          <div
            style={{
              flex: '0 0 auto',
              borderLeft: '1px solid var(--border)',
              overflow: 'auto',
            }}
          >
            <V010Demo />
          </div>
        )}
        {showV011Demo && (
          <div
            style={{
              flex: '0 0 auto',
              borderLeft: '1px solid var(--border)',
              overflow: 'auto',
            }}
          >
            <V011Demo />
          </div>
        )}
        {showV100Demo && (
          <div
            style={{
              flex: '0 0 auto',
              borderLeft: '1px solid var(--border)',
              overflow: 'auto',
            }}
          >
            <V100Demo />
          </div>
        )}
        {!dataReady && mode !== 'studio' && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--muted)',
              pointerEvents: 'none',
            }}
          >
            {mode === 'ssrm'
              ? 'connecting to SSRM…'
              : mode === 'duckdb'
                ? `duckdb-wasm: ${duckdbProgress || 'starting…'}`
                : 'loading…'}
          </div>
        )}
      </div>
      {contextMenu && (
        <ContextMenuPopover
          target={contextMenu}
          onDismiss={() => {
            setContextMenu(null);
          }}
          onSort={(columnId) => {
            handleHeaderClick(columnId);
            setContextMenu(null);
          }}
          onHideColumn={(columnId) => {
            if (!grid) return;
            const next = grid.getColumns().filter((c) => c.id !== columnId);
            grid.setColumns(next);
            setContextMenu(null);
          }}
          onCopyCell={(rowIndex, columnId) => {
            const v = safeRowSource.getCell(rowIndex, columnId);
            void navigator.clipboard.writeText(String(v ?? ''));
            setContextMenu(null);
          }}
        />
      )}
    </div>
  );
};

interface ContextMenuPopoverProps {
  readonly target: ContextMenuTarget;
  readonly onDismiss: () => void;
  readonly onSort: (columnId: string) => void;
  readonly onHideColumn: (columnId: string) => void;
  readonly onCopyCell: (rowIndex: number, columnId: string) => void;
}

/** Lightweight popover. Real apps would use a portal + focus-trap;
 *  the playground keeps it inline and dismisses on click-outside or
 *  Escape. Position is set from the contextmenu event's clientX/Y. */
function ContextMenuPopover(props: ContextMenuPopoverProps): JSX.Element {
  const { target, onDismiss, onSort, onHideColumn, onCopyCell } = props;
  useEffect(() => {
    const onDocPointerDown = (e: PointerEvent): void => {
      const el = e.target as HTMLElement;
      if (el?.closest('[data-onegrid-context-menu]')) return;
      onDismiss();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onDismiss();
    };
    window.addEventListener('pointerdown', onDocPointerDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDocPointerDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [onDismiss]);

  const items: { label: string; onClick: () => void }[] = [];
  if (target.kind === 'cell') {
    items.push({
      label: `Copy cell`,
      onClick: () => {
        onCopyCell(target.rowIndex, target.columnId);
      },
    });
    items.push({
      label: `Sort by ${target.columnId}`,
      onClick: () => {
        onSort(target.columnId);
      },
    });
    items.push({
      label: `Hide ${target.columnId}`,
      onClick: () => {
        onHideColumn(target.columnId);
      },
    });
  } else if (target.kind === 'header') {
    items.push({
      label: `Sort by ${target.columnId}`,
      onClick: () => {
        onSort(target.columnId);
      },
    });
    items.push({
      label: `Hide ${target.columnId}`,
      onClick: () => {
        onHideColumn(target.columnId);
      },
    });
  } else {
    items.push({ label: '(no actions)', onClick: () => undefined });
  }

  return (
    <div
      data-onegrid-context-menu
      role="menu"
      style={{
        position: 'fixed',
        left: target.clientX,
        top: target.clientY,
        background: '#11141a',
        border: '1px solid #2a2f37',
        borderRadius: 4,
        boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
        padding: 4,
        minWidth: 180,
        zIndex: 30,
        fontFamily: 'ui-sans-serif,system-ui,sans-serif',
        fontSize: 12,
        color: '#e7e9ec',
      }}
    >
      {items.map((it, i) => (
        <button
          key={i}
          type="button"
          role="menuitem"
          onClick={it.onClick}
          style={{
            display: 'block',
            width: '100%',
            textAlign: 'left',
            background: 'transparent',
            border: 'none',
            color: 'inherit',
            padding: '6px 10px',
            cursor: 'pointer',
            font: 'inherit',
            borderRadius: 3,
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLButtonElement).style.background = '#1b1f26';
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLButtonElement).style.background = 'transparent';
          }}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}
