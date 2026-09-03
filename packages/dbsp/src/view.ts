// =============================================================================
// defineView — the public, adopter-facing face of the Z-set operator algebra
//
// The operators in `index.ts` are correct and complete enough to maintain a
// view incrementally, but they are a dataflow assembly language: you hand
// them Z-set diffs and they hand you Z-set diffs back. Nothing in a grid
// wants to speak Z-sets. This module is the compiler and the runtime around
// them — `defineView({ from, where, groupBy, agg })` returns a handle that
// is a live RowSource, and every change fed into `from` walks the same
// operator chain and lands as a row-diff on the view's subscribers.
//
// Four decisions.
//
// 1. The view IS a RowSource, structurally. `@onegrid/core` declares
//    `RowSource` as `{ numRows, getCell(rowIndex, columnId) }` and that is
//    the entire contract; a `View` satisfies it by construction. We do NOT
//    import the type — `@onegrid/core` depends on the data layer, and dbsp
//    sits below both. Conforming structurally keeps the dependency arrow
//    pointing one way, and `view.test.ts` pins the shape so a drift in core
//    shows up as a failing test rather than a runtime surprise.
//
// 2. Changes travel as `RowDiff` — the protocol's existing real-time
//    row-diff envelope (kind / version / pkey / fields), not a shape
//    invented here. A view's subscriber is doing exactly what a WebSocket
//    client does with a server's change stream, so it gets exactly the same
//    events, monotonic `version` included.
//
// 3. An update is a retraction plus an insertion — `{-1 old, +1 new}` — and
//    the pair is never coalesced. Coalescing by key would cancel them to
//    weight 0 and the row would silently never leave its old group. Moving
//    a row between groups is the single most common IVM bug and this is
//    where it is either prevented or introduced.
//
// 4. Work is proportional to the delta. Every operator sees only the diff,
//    never the base; `view.stat` counts operator invocations and the rows
//    that crossed each operator boundary so that claim is measurable rather
//    than asserted. The one part that is NOT O(delta) is materialization
//    bookkeeping — keeping the dense row array ordered costs an O(n) index
//    fix-up on a delete. That is a memmove over pointers, not a recompute,
//    and it buys stable row order for the grid; the operator work, the part
//    IVM exists to bound, stays O(delta).
// =============================================================================

import type { RowDiff, Unsubscribe } from '@onegrid/protocol';
import {
  createFilter,
  createGroupAgg,
  Pipeline,
  type AggSpec,
  type Diff,
  type Operator,
  type Row,
  type ZEntry,
} from './index';

/**
 * A change pushed into a `Table`. This is the protocol's `RowDiff` with the
 * version made optional — the table stamps versions itself, so an adopter
 * relaying changes from somewhere else does not have to invent them.
 * @public
 */
export type TableChange = Omit<RowDiff, 'version'> & { readonly version?: number };

/**
 * Anything a view can be defined over: a base table, or another view.
 * Composition is exactly this interface being implemented by both.
 * @public
 */
export interface ViewSource {
  /** Attach a downstream sink. Returns an unsubscribe handle. */
  readonly connect: (sink: (diff: Diff) => void) => Unsubscribe;
  /** Current contents, keyed by row key. Used to backfill a new consumer. */
  readonly snapshot: () => ReadonlyMap<string, Row>;
}

/** @public */
export interface TableOption {
  /** Field carrying the primary key. Default `'id'`. */
  readonly key?: string;
}

/**
 * A base table: the root of every dataflow. Holds the current rows and turns
 * insert / update / delete into Z-set diffs.
 * @public
 */
export interface Table extends ViewSource {
  readonly numRows: number;
  /** Push one change or a batch. A batch is applied as a single diff. */
  readonly apply: (change: TableChange | ReadonlyArray<TableChange>) => void;
  /** Bulk-insert rows, taking the primary key from each row's key field. */
  readonly load: (row: ReadonlyArray<Record<string, unknown>>) => void;
  readonly dispose: () => void;
}

/** Live counters proving the incremental claim. @public */
export interface ViewStat {
  /** Times an operator's applyDiff ran. */
  readonly operatorCallCount: number;
  /** Z-set entries that entered an operator. */
  readonly rowInCount: number;
  /** Z-set entries an operator produced. */
  readonly rowOutCount: number;
}

/** @public */
export interface ViewDefinition {
  readonly from: ViewSource;
  /** Row predicate applied BEFORE grouping, like SQL's WHERE. */
  readonly where?: (row: Row) => boolean;
  /** Grouping key columns. Omit for a row-level view. */
  readonly groupBy?: ReadonlyArray<string>;
  /** Aggregations evaluated per group. Requires `groupBy`. */
  readonly agg?: ReadonlyArray<AggSpec>;
}

/**
 * A live derived view. Satisfies `@onegrid/core`'s `RowSource`
 * (`numRows` + `getCell`) so it can be handed straight to a Grid, and
 * `ViewSource` so another view can be defined over it.
 * @public
 */
export interface View extends ViewSource {
  readonly numRows: number;
  readonly getCell: (rowIndex: number, columnId: string) => unknown;
  /** Materialized rows in view order. */
  readonly row: ReadonlyArray<Row>;
  /** Row keys, index-parallel to `row`. */
  readonly rowKey: ReadonlyArray<string>;
  /** Emits the protocol row-diffs produced by one upstream change. */
  readonly subscribe: (listener: (diff: ReadonlyArray<RowDiff>) => void) => Unsubscribe;
  readonly stat: ViewStat;
  readonly resetStat: () => void;
  readonly dispose: () => void;
}

// -----------------------------------------------------------------------------
// Base table
// -----------------------------------------------------------------------------

/** @public */
export function createTable(option: TableOption = {}): Table {
  const keyField = option.key ?? 'id';
  const state = new Map<string, Row>();
  const sink = new Set<(diff: Diff) => void>();

  const emit = (entries: ZEntry[]): void => {
    if (entries.length === 0) return;
    // Copy the sink set: a sink may connect or disconnect while fanning out.
    for (const s of [...sink]) s({ entries });
  };

  const apply = (change: TableChange | ReadonlyArray<TableChange>): void => {
    const list: ReadonlyArray<TableChange> = isChangeList(change) ? change : [change];
    const entries: ZEntry[] = [];
    for (const c of list) {
      const key = String(c.pkey);
      const prev = state.get(key);
      if (c.kind === 'delete') {
        if (!prev) continue;
        state.delete(key);
        entries.push({ key, row: prev, weight: -1 });
        continue;
      }
      // An update merges over the cached row because the protocol allows a
      // server to send only the changed fields.
      const base = c.kind === 'update' ? (prev ?? {}) : {};
      const next: Row = { ...base, [keyField]: c.pkey, ...(c.fields ?? {}) };
      // Retract before inserting. Downstream, this pair is what lets a
      // grouped view move the row out of its old group and into the new one.
      if (prev) entries.push({ key, row: prev, weight: -1 });
      state.set(key, next);
      entries.push({ key, row: next, weight: 1 });
    }
    emit(entries);
  };

  return {
    get numRows() {
      return state.size;
    },
    apply,
    load: (row) => {
      apply(
        row.map((r) => ({
          kind: 'insert' as const,
          pkey: r[keyField] as string | number,
          fields: r,
        })),
      );
    },
    connect: (s) => {
      sink.add(s);
      return () => sink.delete(s);
    },
    snapshot: () => state,
    dispose: () => {
      state.clear();
      sink.clear();
    },
  };
}

// -----------------------------------------------------------------------------
// defineView
// -----------------------------------------------------------------------------

/** @public */
export function defineView(definition: ViewDefinition): View {
  const { from, where, groupBy, agg } = definition;
  if (agg && agg.length > 0 && (!groupBy || groupBy.length === 0)) {
    throw new Error('[OG_DBSP_INVALID_PLAN] defineView: agg requires groupBy');
  }

  const stat = { operatorCallCount: 0, rowInCount: 0, rowOutCount: 0 };

  const op: Operator[] = [];
  if (where) op.push(instrument(createFilter(where), stat));
  if (groupBy && groupBy.length > 0) {
    op.push(instrument(createGroupAgg(groupBy, agg ?? []), stat));
  }
  // A view with neither a predicate nor a grouping is still a real view — it
  // republishes its source. The identity operator keeps the pipeline shape
  // uniform so materialization has exactly one code path.
  if (op.length === 0) op.push(instrument(createIdentity(), stat));
  const pipeline = new Pipeline(op);

  const rowKey: string[] = [];
  const row: Row[] = [];
  const indexByKey = new Map<string, number>();
  const listener = new Set<(diff: ReadonlyArray<RowDiff>) => void>();
  const downstream = new Set<(diff: Diff) => void>();
  let version = 0;

  const step = (input: Diff): void => {
    const output = pipeline.step(input);
    if (output.entries.length === 0) return;
    const change = materialize(output);
    if (change.length > 0) {
      for (const l of [...listener]) l(change);
    }
    // Downstream views get the raw Z-set diff, retraction pair intact —
    // that is what lets a view over a grouped view regroup correctly.
    for (const d of [...downstream]) d(output);
  };

  function materialize(diff: Diff): RowDiff[] {
    // Net the diff per key first. A `-1 old, +1 new` pair for one key is an
    // UPDATE: the row keeps its position in the array instead of being
    // removed from the middle and re-appended at the end.
    const finalRow = new Map<string, Row | null>();
    for (const e of diff.entries) {
      finalRow.set(e.key, e.weight > 0 ? e.row : null);
    }
    const out: RowDiff[] = [];
    for (const [key, next] of finalRow) {
      const at = indexByKey.get(key);
      if (next === null) {
        if (at === undefined) continue;
        rowKey.splice(at, 1);
        row.splice(at, 1);
        indexByKey.delete(key);
        for (let i = at; i < rowKey.length; i++) indexByKey.set(rowKey[i]!, i);
        version += 1;
        out.push({ kind: 'delete', version, pkey: key });
        continue;
      }
      version += 1;
      if (at === undefined) {
        indexByKey.set(key, rowKey.length);
        rowKey.push(key);
        row.push(next);
        out.push({ kind: 'insert', version, pkey: key, fields: { ...next } });
      } else {
        row[at] = next;
        out.push({ kind: 'update', version, pkey: key, fields: { ...next } });
      }
    }
    return out;
  }

  // Connect first, then backfill from the source's current contents, so a
  // change racing the backfill lands after it rather than being lost.
  const detach = from.connect(step);
  const initial = [...from.snapshot()].map(
    ([key, r]): ZEntry => ({ key, row: r, weight: 1 }),
  );
  if (initial.length > 0) step({ entries: initial });

  const view: View = {
    get numRows() {
      return row.length;
    },
    getCell: (rowIndex, columnId) => row[rowIndex]?.[columnId],
    row,
    rowKey,
    subscribe: (l) => {
      listener.add(l);
      return () => listener.delete(l);
    },
    connect: (sink) => {
      downstream.add(sink);
      return () => downstream.delete(sink);
    },
    snapshot: () => {
      const m = new Map<string, Row>();
      for (let i = 0; i < rowKey.length; i++) m.set(rowKey[i]!, row[i]!);
      return m;
    },
    get stat(): ViewStat {
      return { ...stat };
    },
    resetStat: () => {
      stat.operatorCallCount = 0;
      stat.rowInCount = 0;
      stat.rowOutCount = 0;
    },
    dispose: () => {
      detach();
      pipeline.dispose();
      listener.clear();
      downstream.clear();
    },
  };
  return view;
}

// -----------------------------------------------------------------------------
// Internals
// -----------------------------------------------------------------------------

interface MutableStat {
  operatorCallCount: number;
  rowInCount: number;
  rowOutCount: number;
}

/**
 * Wrap an operator so every diff crossing it is counted. This is the
 * instrumentation the incrementality test reads: with a 10k-row base and a
 * one-row change, `rowInCount` must stay in single digits.
 */
function instrument(op: Operator, stat: MutableStat): Operator {
  return {
    applyDiff: (diff) => {
      stat.operatorCallCount += 1;
      stat.rowInCount += diff.entries.length;
      const out = op.applyDiff(diff);
      stat.rowOutCount += out.entries.length;
      return out;
    },
    snapshot: () => op.snapshot(),
    dispose: () => op.dispose(),
  };
}

/** `Array.isArray` widens a ReadonlyArray to `any[]`; this guard narrows the
 *  batch-or-single argument without leaking `any` into the caller. */
function isChangeList(
  change: TableChange | ReadonlyArray<TableChange>,
): change is ReadonlyArray<TableChange> {
  return Array.isArray(change);
}

/** Passthrough operator — a view with no predicate and no grouping. */
function createIdentity(): Operator {
  const state = new Map<string, Row>();
  return {
    applyDiff: (diff) => {
      for (const e of diff.entries) {
        if (e.weight > 0) state.set(e.key, e.row);
        else if (e.weight < 0) state.delete(e.key);
      }
      return diff;
    },
    snapshot: () => state,
    dispose: () => state.clear(),
  };
}
