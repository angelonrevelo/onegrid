// =============================================================================
// @onegrid/dbsp — incremental view maintenance via the DBSP operator algebra
//
// Reference implementation of docs/dbsp-spec.md. Each operator implements
// applyDiff(diff) → diff in time proportional to the input diff, not the
// snapshot size. The DBSP incrementalization theorem (Budiu et al., VLDB
// 2023) gives the formal guarantee.
//
// Scope for v0.0.10:
//   - Z-set / Diff types
//   - Source / map / filter / union / distinct / groupAgg / sort-topK
//   - Operator-graph IR + run-step driver
//
// Out of scope (v0.0.10.x or v0.0.11):
//   - Full join (delta-join with indexed state on both sides)
//   - Full sort (red-black tree incremental sorted index)
//   - Checkpoint / resume after process restart
// =============================================================================

import type { SortModel } from '@onegrid/protocol';

// -----------------------------------------------------------------------------
// Z-sets and Diffs
// -----------------------------------------------------------------------------

/** @public */
export type Row = Readonly<Record<string, unknown>>;

/**
 * A Z-set entry: a row with integer weight (signed multiplicity).
 * @public
 */
export interface ZEntry {
  readonly key: string;
  readonly row: Row;
  readonly weight: number;
}

/**
 * A diff is the stream's per-tick Z-set delta.
 * @public
 */
export interface Diff {
  readonly entries: ReadonlyArray<ZEntry>;
}

/**
 * Coalesce duplicate keys: sums weights, last row wins. Drops weight-0.
 * @public
 */
export function coalesce(entries: ReadonlyArray<ZEntry>): ZEntry[] {
  const m = new Map<string, ZEntry>();
  for (const e of entries) {
    const prev = m.get(e.key);
    if (prev) {
      const w = prev.weight + e.weight;
      if (w === 0) m.delete(e.key);
      else m.set(e.key, { key: e.key, row: e.row, weight: w });
    } else {
      m.set(e.key, e);
    }
  }
  return [...m.values()];
}

/**
 * Integrate a stream of diffs into a snapshot map.
 * @public
 */
export function integrate(diffs: ReadonlyArray<Diff>): Map<string, Row> {
  const snap = new Map<string, Row>();
  for (const d of diffs) {
    for (const e of d.entries) {
      const cur = snap.get(e.key);
      const curW = cur ? 1 : 0;
      const nextW = curW + e.weight;
      if (nextW <= 0) snap.delete(e.key);
      else snap.set(e.key, e.row);
    }
  }
  return snap;
}

// -----------------------------------------------------------------------------
// Operator interface
// -----------------------------------------------------------------------------

/** @public */
export interface Operator {
  /** Apply an input diff, return the corresponding output diff. */
  applyDiff(diff: Diff): Diff;
  /** Read the current snapshot (test / debug hook). */
  snapshot(): ReadonlyMap<string, Row>;
  /** Tear down auxiliary state. */
  dispose(): void;
}

// -----------------------------------------------------------------------------
// Source — passthrough; the entry point of every plan
// -----------------------------------------------------------------------------

/** @public */
export function createSource(): Operator {
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

// -----------------------------------------------------------------------------
// Map — project each row
// -----------------------------------------------------------------------------

/** @public */
export function createMap(project: (r: Row) => Row): Operator {
  const state = new Map<string, Row>();
  return {
    applyDiff: (diff) => {
      const out: ZEntry[] = [];
      for (const e of diff.entries) {
        const mapped = project(e.row);
        if (e.weight > 0) state.set(e.key, mapped);
        else if (e.weight < 0) state.delete(e.key);
        out.push({ key: e.key, row: mapped, weight: e.weight });
      }
      return { entries: out };
    },
    snapshot: () => state,
    dispose: () => state.clear(),
  };
}

// -----------------------------------------------------------------------------
// Filter — predicate keep/drop
// -----------------------------------------------------------------------------

/** @public */
export function createFilter(predicate: (r: Row) => boolean): Operator {
  const state = new Map<string, Row>();
  return {
    applyDiff: (diff) => {
      const out: ZEntry[] = [];
      for (const e of diff.entries) {
        if (!predicate(e.row)) continue;
        if (e.weight > 0) state.set(e.key, e.row);
        else if (e.weight < 0) state.delete(e.key);
        out.push(e);
      }
      return { entries: out };
    },
    snapshot: () => state,
    dispose: () => state.clear(),
  };
}

// -----------------------------------------------------------------------------
// Union — sum two diff streams pointwise
// -----------------------------------------------------------------------------

/** @public */
export function createUnion(): {
  readonly left: Operator;
  readonly right: Operator;
  readonly merged: Operator;
} {
  const state = new Map<string, { row: Row; weight: number }>();
  const apply = (diff: Diff): Diff => {
    const out: ZEntry[] = [];
    for (const e of diff.entries) {
      const cur = state.get(e.key);
      const nextW = (cur?.weight ?? 0) + e.weight;
      if (nextW <= 0) state.delete(e.key);
      else state.set(e.key, { row: e.row, weight: nextW });
      out.push(e);
    }
    return { entries: out };
  };
  const passthrough = (): Operator => ({
    applyDiff: apply,
    snapshot: () => {
      const m = new Map<string, Row>();
      for (const [k, v] of state) m.set(k, v.row);
      return m;
    },
    dispose: () => state.clear(),
  });
  // Both `left` and `right` write into the same shared state — the
  // operator is "merged" by construction.
  const left = passthrough();
  const right = passthrough();
  return { left, right, merged: left };
}

// -----------------------------------------------------------------------------
// Distinct — collapse weights to {-1, +1}
// -----------------------------------------------------------------------------

/** @public */
export function createDistinct(): Operator {
  const weights = new Map<string, number>();
  const rows = new Map<string, Row>();
  const present = new Map<string, boolean>(); // last emitted sign
  return {
    applyDiff: (diff) => {
      const out: ZEntry[] = [];
      for (const e of diff.entries) {
        const nextW = (weights.get(e.key) ?? 0) + e.weight;
        const wasPresent = present.get(e.key) ?? false;
        const isPresent = nextW > 0;
        if (nextW === 0) weights.delete(e.key);
        else weights.set(e.key, nextW);
        if (isPresent !== wasPresent) {
          present.set(e.key, isPresent);
          if (isPresent) {
            rows.set(e.key, e.row);
            out.push({ key: e.key, row: e.row, weight: 1 });
          } else {
            const r = rows.get(e.key) ?? e.row;
            rows.delete(e.key);
            out.push({ key: e.key, row: r, weight: -1 });
          }
        }
      }
      return { entries: out };
    },
    snapshot: () => rows,
    dispose: () => {
      weights.clear();
      rows.clear();
      present.clear();
    },
  };
}

// -----------------------------------------------------------------------------
// GroupAgg — group by keys + per-group aggregate
// -----------------------------------------------------------------------------

/** @public */
export type AggKind = 'sum' | 'count' | 'avg' | 'min' | 'max';

/** @public */
export interface AggSpec {
  /** Output column name. */
  readonly out: string;
  /** Source column name (ignored for `count`). */
  readonly src?: string;
  readonly kind: AggKind;
}

/**
 * Per-(group, source-column) aggregate state. count lives at the
 * group level (shared across all spec.src values); sum + values
 * live per source column so two aggs reading different columns
 * don't double-count.
 */
interface ColState {
  sum: number;
  /** Per-row source values keyed by row id, for min/max rescan after delete. */
  values: Map<string, number>;
}

interface AggState {
  count: number;
  cols: Map<string, ColState>;
}

function newAggState(): AggState {
  return { count: 0, cols: new Map() };
}

function colState(state: AggState, src: string): ColState {
  let c = state.cols.get(src);
  if (!c) {
    c = { sum: 0, values: new Map() };
    state.cols.set(src, c);
  }
  return c;
}

function readAgg(state: AggState, spec: AggSpec): number | null {
  if (state.count === 0) return null;
  if (spec.kind === 'count') return state.count;
  const col = spec.src ?? spec.out;
  const c = state.cols.get(col);
  if (!c) return null;
  switch (spec.kind) {
    case 'sum':
      return c.sum;
    case 'avg':
      return c.sum / state.count;
    case 'min': {
      let m = Infinity;
      for (const v of c.values.values()) if (v < m) m = v;
      return m;
    }
    case 'max': {
      let m = -Infinity;
      for (const v of c.values.values()) if (v > m) m = v;
      return m;
    }
  }
}

/** @public */
export function createGroupAgg(
  keys: ReadonlyArray<string>,
  aggs: ReadonlyArray<AggSpec>,
): Operator {
  if (keys.length === 0) throw new Error('[OG_DBSP_INVALID_PLAN] groupAgg requires ≥ 1 key column');
  const states = new Map<string, AggState>(); // groupKey → state
  const lastEmitted = new Map<string, Row>();
  const memberKeys = new Map<string, string>(); // input row key → group key
  const groupKey = (r: Row): string => keys.map((k) => String(r[k])).join('\x1f');

  return {
    applyDiff: (diff) => {
      const touched = new Set<string>();
      for (const e of diff.entries) {
        const gk = e.weight > 0 ? groupKey(e.row) : (memberKeys.get(e.key) ?? groupKey(e.row));
        let st = states.get(gk);
        if (!st) {
          st = newAggState();
          states.set(gk, st);
        }
        // Bump count once per diff entry. Per-column sums/values
        // are bumped once per UNIQUE src column referenced by the
        // agg specs.
        if (e.weight > 0) st.count++;
        else st.count--;
        const touchedCols = new Set<string>();
        for (const spec of aggs) {
          if (spec.kind === 'count') continue;
          const src = spec.src ?? spec.out;
          if (touchedCols.has(src)) continue;
          touchedCols.add(src);
          const col = colState(st, src);
          const v = Number(e.row[src] ?? 0);
          if (e.weight > 0) {
            col.sum += v;
            col.values.set(e.key, v);
          } else {
            col.sum -= v;
            col.values.delete(e.key);
          }
        }
        if (e.weight > 0) memberKeys.set(e.key, gk);
        else memberKeys.delete(e.key);
        touched.add(gk);
      }
      const out: ZEntry[] = [];
      for (const gk of touched) {
        const st = states.get(gk)!;
        const prev = lastEmitted.get(gk);
        const row: Record<string, unknown> = {};
        for (let i = 0; i < keys.length; i++) {
          const k = keys[i]!;
          const parts = gk.split('\x1f');
          row[k] = parts[i];
        }
        if (st.count === 0) {
          if (prev) {
            out.push({ key: gk, row: prev, weight: -1 });
            lastEmitted.delete(gk);
          }
          states.delete(gk);
          continue;
        }
        for (const spec of aggs) {
          row[spec.out] = readAgg(st, spec);
        }
        if (prev) out.push({ key: gk, row: prev, weight: -1 });
        out.push({ key: gk, row, weight: 1 });
        lastEmitted.set(gk, row);
      }
      return { entries: out };
    },
    snapshot: () => lastEmitted,
    dispose: () => {
      states.clear();
      lastEmitted.clear();
      memberKeys.clear();
    },
  };
}

// -----------------------------------------------------------------------------
// Top-K sort — keep the K rows with the smallest sort tuple
// -----------------------------------------------------------------------------

function compareSort(a: Row, b: Row, sort: SortModel): number {
  for (const field of sort) {
    const av = a[field.columnId];
    const bv = b[field.columnId];
    const cmp =
      av === bv ? 0 : (av as number) < (bv as number) ? -1 : 1;
    if (cmp !== 0) return field.direction === 'desc' ? -cmp : cmp;
  }
  return 0;
}

/** @public */
export function createTopK(sort: SortModel, k: number): Operator {
  const state = new Map<string, Row>();
  let lastEmittedKeys: Set<string> = new Set();
  return {
    applyDiff: (diff) => {
      for (const e of diff.entries) {
        if (e.weight > 0) state.set(e.key, e.row);
        else if (e.weight < 0) state.delete(e.key);
      }
      // Recompute top-K. O(N log K) — sort full state would be N log N;
      // a real impl would keep a heap. v0.0.10 baseline is the simple
      // sort+slice.
      const sorted = [...state.entries()].sort((a, b) =>
        compareSort(a[1], b[1], sort),
      );
      const top = new Map<string, Row>();
      for (let i = 0; i < Math.min(k, sorted.length); i++) {
        const [key, row] = sorted[i]!;
        top.set(key, row);
      }
      const out: ZEntry[] = [];
      // Emit removals for keys that left the window.
      for (const k of lastEmittedKeys) {
        if (!top.has(k)) {
          out.push({ key: k, row: state.get(k) ?? {}, weight: -1 });
        }
      }
      // Emit additions for keys that entered the window.
      for (const [k, row] of top) {
        if (!lastEmittedKeys.has(k)) {
          out.push({ key: k, row, weight: 1 });
        }
      }
      lastEmittedKeys = new Set(top.keys());
      return { entries: out };
    },
    snapshot: () => {
      const m = new Map<string, Row>();
      for (const k of lastEmittedKeys) {
        const r = state.get(k);
        if (r) m.set(k, r);
      }
      return m;
    },
    dispose: () => {
      state.clear();
      lastEmittedKeys.clear();
    },
  };
}

// -----------------------------------------------------------------------------
// Operator graph — chain operators by feeding output diff into the next.
// -----------------------------------------------------------------------------

/** @public */
export class Pipeline {
  private readonly ops: Operator[];

  constructor(ops: ReadonlyArray<Operator>) {
    this.ops = [...ops];
  }

  step(diff: Diff): Diff {
    let cur = diff;
    for (const op of this.ops) {
      cur = op.applyDiff(cur);
    }
    return cur;
  }

  dispose(): void {
    for (const op of this.ops) op.dispose();
  }
}

// -----------------------------------------------------------------------------
// Public view API — `defineView` and the base table that feeds it. Defined in
// `view.ts` so this file stays the operator algebra; the two form a cycle at
// module level only (view.ts imports operators, index.ts re-exports the view
// API), and nothing is read at module-init time on either side.
// -----------------------------------------------------------------------------

export { createTable, defineView } from './view';
export type {
  Table,
  TableChange,
  TableOption,
  View,
  ViewDefinition,
  ViewSource,
  ViewStat,
} from './view';
