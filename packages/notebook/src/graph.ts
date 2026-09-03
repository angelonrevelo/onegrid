// =============================================================================
// The reactive dependency graph
//
// This is the core of the package. Everything else — states, kernels,
// serialisation — is bookkeeping around these three answers:
//
//   1. Who depends on whom?      buildGraph
//   2. In what order do they run? topoOrder (Kahn, stable)
//   3. What did a change break?   transitiveDependent
//
// On the relationship to @onegrid/reactive: that package is a Salsa-style
// memoiser and it is the right substrate for SYNCHRONOUS derived values —
// `defineQuery(compute)` takes a `compute` returning `T`, tracks deps by
// side effect during the call, and has no notion of a cycle because a
// cyclic query would recurse until the stack blew. A notebook kernel is
// asynchronous (DuckDB, a GPU dispatch and a network kernel all are), its
// graph is authored by a human and therefore CAN be cyclic, and its
// document is an immutable value rather than a mutable database. Those
// three mismatches are load-bearing, so the graph here is explicit and
// first-class: we materialise the edges, detect cycles before running
// anything, and drive execution ourselves. The demand-driven IDEA is the
// same; the substrate could not be reused as-is.
//
// Cycles are reported, never hit. `findCycle` returns the full path
// (`a → b → c → a`) so the message names every participant instead of
// saying "circular reference somewhere".
// =============================================================================

import { findReference } from './reference';
import type { NotebookCell, NotebookDocument } from './types';

/**
 * The materialised dependency graph of a document.
 * @public
 */
export interface NotebookGraph {
  /** Document order, id → cell. */
  readonly cellById: ReadonlyMap<string, NotebookCell>;
  /** Cell name → id. First definition wins when a name is duplicated. */
  readonly idByName: ReadonlyMap<string, string>;
  /** id → ids it reads FROM (its direct dependencies). */
  readonly dependency: ReadonlyMap<string, ReadonlyArray<string>>;
  /** id → ids that read it (its direct dependents). The reverse edges. */
  readonly dependent: ReadonlyMap<string, ReadonlyArray<string>>;
  /** id → the names it references, in source order. */
  readonly referenceName: ReadonlyMap<string, ReadonlyArray<string>>;
}

/**
 * Parse every cell's source for references and materialise both edge
 * directions. O(total source length + edges).
 * @public
 */
export function buildGraph(doc: NotebookDocument): NotebookGraph {
  const cellById = new Map<string, NotebookCell>();
  const idByName = new Map<string, string>();
  for (const cell of doc.cell) {
    cellById.set(cell.id, cell);
    if (cell.name !== undefined && !idByName.has(cell.name)) {
      idByName.set(cell.name, cell.id);
    }
  }

  const knownName = new Set(idByName.keys());
  const dependency = new Map<string, ReadonlyArray<string>>();
  const referenceName = new Map<string, ReadonlyArray<string>>();
  const dependent = new Map<string, string[]>();
  for (const cell of doc.cell) dependent.set(cell.id, []);

  for (const cell of doc.cell) {
    const name = findReference(cell.source, cell.kind, knownName, cell.name);
    referenceName.set(cell.id, name);
    const dep: string[] = [];
    for (const n of name) {
      const upstreamId = idByName.get(n);
      // A name can only resolve to one cell, and self-reference was already
      // filtered out by findReference.
      if (upstreamId !== undefined && upstreamId !== cell.id) {
        dep.push(upstreamId);
        dependent.get(upstreamId)!.push(cell.id);
      }
    }
    dependency.set(cell.id, dep);
  }

  return { cellById, idByName, dependency, dependent, referenceName };
}

/**
 * Kahn's algorithm over the whole document. Ties are broken by document
 * order, so the execution order of independent cells is stable and a run
 * is reproducible.
 *
 * Returns the cells it could order plus the ones it could not — the
 * leftovers are exactly the cells inside or downstream of a cycle.
 * @public
 */
export function topoOrder(
  doc: NotebookDocument,
  graph: NotebookGraph = buildGraph(doc),
): { readonly order: ReadonlyArray<string>; readonly blocked: ReadonlyArray<string> } {
  const indegree = new Map<string, number>();
  for (const cell of doc.cell) {
    indegree.set(cell.id, (graph.dependency.get(cell.id) ?? []).length);
  }

  // Seed in document order; Kahn's frontier is a queue, so document order
  // is preserved among cells that became ready at the same moment.
  const queue: string[] = [];
  for (const cell of doc.cell) if (indegree.get(cell.id) === 0) queue.push(cell.id);

  const order: string[] = [];
  let head = 0;
  while (head < queue.length) {
    const id = queue[head++]!;
    order.push(id);
    for (const down of graph.dependent.get(id) ?? []) {
      const next = (indegree.get(down) ?? 0) - 1;
      indegree.set(down, next);
      if (next === 0) queue.push(down);
    }
  }

  const ordered = new Set(order);
  const blocked = doc.cell.map((c) => c.id).filter((id) => !ordered.has(id));
  return { order, blocked };
}

/**
 * A cycle, reported as the full path with the entry node repeated at the
 * end: `['a', 'b', 'a']`.
 * @public
 */
export interface NotebookCycle {
  /** Cell ids, first === last. */
  readonly path: ReadonlyArray<string>;
  /** The same path in names where the cells have one, ids otherwise. */
  readonly label: ReadonlyArray<string>;
}

/**
 * Depth-first search with an explicit on-stack set. Returns the first cycle
 * found in document order, or `undefined` when the graph is a DAG.
 * @public
 */
export function findCycle(
  doc: NotebookDocument,
  graph: NotebookGraph = buildGraph(doc),
): NotebookCycle | undefined {
  const WHITE = 0;
  const GREY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  for (const cell of doc.cell) color.set(cell.id, WHITE);
  const stack: string[] = [];

  const visit = (id: string): NotebookCycle | undefined => {
    color.set(id, GREY);
    stack.push(id);
    for (const dep of graph.dependency.get(id) ?? []) {
      const c = color.get(dep);
      if (c === GREY) {
        // `dep` is on the current stack — slice from it to close the loop.
        const start = stack.indexOf(dep);
        const path = [...stack.slice(start), dep];
        return { path, label: path.map((p) => labelOf(graph, p)) };
      }
      if (c === WHITE) {
        const found = visit(dep);
        if (found) return found;
      }
    }
    stack.pop();
    color.set(id, BLACK);
    return undefined;
  };

  for (const cell of doc.cell) {
    if (color.get(cell.id) === WHITE) {
      const found = visit(cell.id);
      if (found) return found;
    }
  }
  return undefined;
}

/**
 * Every cycle in the document, not just the first. Used for reporting:
 * when a notebook has two independent loops the user wants to see both.
 * @public
 */
export function findAllCycle(
  doc: NotebookDocument,
  graph: NotebookGraph = buildGraph(doc),
): ReadonlyArray<NotebookCycle> {
  const cycle: NotebookCycle[] = [];
  const seen = new Set<string>();
  const color = new Map<string, number>();
  const stack: string[] = [];
  for (const cell of doc.cell) color.set(cell.id, 0);

  const visit = (id: string): void => {
    color.set(id, 1);
    stack.push(id);
    for (const dep of graph.dependency.get(id) ?? []) {
      const c = color.get(dep);
      if (c === 1) {
        const start = stack.indexOf(dep);
        const path = [...stack.slice(start), dep];
        const key = canonicalCycleKey(path);
        if (!seen.has(key)) {
          seen.add(key);
          cycle.push({ path, label: path.map((p) => labelOf(graph, p)) });
        }
      } else if (c === 0) {
        visit(dep);
      }
    }
    stack.pop();
    color.set(id, 2);
  };

  for (const cell of doc.cell) if (color.get(cell.id) === 0) visit(cell.id);
  return cycle;
}

/** Rotation-independent identity for a cycle, so a→b→a and b→a→b match. */
function canonicalCycleKey(path: ReadonlyArray<string>): string {
  const ring = path.slice(0, -1);
  let best: string | undefined;
  for (let i = 0; i < ring.length; i++) {
    const rotated = [...ring.slice(i), ...ring.slice(0, i)].join('>');
    if (best === undefined || rotated < best) best = rotated;
  }
  return best ?? '';
}

function labelOf(graph: NotebookGraph, id: string): string {
  return graph.cellById.get(id)?.name ?? id;
}

/**
 * Every cell reachable downstream of `id`, in topological order, excluding
 * `id` itself. This is the incremental re-execution set: change one cell
 * and exactly these need to re-run.
 * @public
 */
export function transitiveDependent(
  doc: NotebookDocument,
  id: string,
  graph: NotebookGraph = buildGraph(doc),
): ReadonlyArray<string> {
  const affected = new Set<string>();
  const stack = [...(graph.dependent.get(id) ?? [])];
  while (stack.length > 0) {
    const next = stack.pop()!;
    if (affected.has(next)) continue;
    affected.add(next);
    for (const down of graph.dependent.get(next) ?? []) {
      if (!affected.has(down)) stack.push(down);
    }
  }
  const { order, blocked } = topoOrder(doc, graph);
  const ordered = order.filter((c) => affected.has(c));
  const rest = blocked.filter((c) => affected.has(c));
  return [...ordered, ...rest];
}

/**
 * Names defined by more than one cell. A duplicate is not fatal — the first
 * definition wins — but it silently changes what every reference means, so
 * it is worth surfacing in a UI.
 * @public
 */
export function findDuplicateName(doc: NotebookDocument): ReadonlyMap<string, ReadonlyArray<string>> {
  const byName = new Map<string, string[]>();
  for (const cell of doc.cell) {
    if (cell.name === undefined) continue;
    const list = byName.get(cell.name);
    if (list) list.push(cell.id);
    else byName.set(cell.name, [cell.id]);
  }
  const dup = new Map<string, ReadonlyArray<string>>();
  for (const [name, id] of byName) if (id.length > 1) dup.set(name, id);
  return dup;
}
