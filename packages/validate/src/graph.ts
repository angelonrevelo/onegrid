// =============================================================================
// Rule graph — invalidation edges and evaluation order
//
// Two different graphs live here, and conflating them is the usual mistake:
//
//   INVALIDATION (column → rule). Which rules must re-run when a column
//   changes. This is the Adapton-style demand graph the formula engine already
//   implements, so we reuse `DependencyGraph` from `@onegrid/formula` verbatim
//   rather than writing a second one: nodes are namespaced `col:<id>` and
//   `rule:<id>`, an edge means "reads", and `collectTransitiveDependents` on a
//   column node yields every rule that must be revalidated — including rules
//   that only read the changed column indirectly, through another rule.
//
//   ORDERING (rule → prerequisite rule). A rule that declares `dependsOn` reads
//   another rule's diagnostics, so it must run after it. That is a separate
//   question from invalidation and needs a topological sort — with the honest
//   admission that adopters will write cycles. We find the strongly connected
//   components with Tarjan, which conveniently emits them in exactly the order
//   we want to evaluate them (a component after everything it depends on), and
//   hand any component that is genuinely cyclic to the engine's bounded-pass
//   loop along with a concrete cycle path to print.
// =============================================================================

import { DependencyGraph } from '@onegrid/formula';
import type { Rule } from './type';

/** Namespaced node id for a column in the invalidation graph. */
export function columnNode(columnId: string): string {
  return `col:${columnId}`;
}

/** Namespaced node id for a rule in the invalidation graph. */
export function ruleNode(ruleId: string): string {
  return `rule:${ruleId}`;
}

/** Columns a rule reads. A cell rule reads exactly one. */
export function inputOf(rule: Rule): readonly string[] {
  return rule.kind === 'cell' ? [rule.column] : rule.input;
}

/**
 * Build the invalidation graph: every rule reads its declared input columns,
 * and reads any rule it declares `dependsOn`. Edges point from the reader to
 * what it reads, matching `DependencyGraph`'s convention, so dirty propagation
 * runs through `getDependents` / `collectTransitiveDependents`.
 */
export function buildInvalidationGraph(rule: readonly Rule[]): DependencyGraph {
  const graph = new DependencyGraph();
  const known = new Set(rule.map((r) => r.id));
  for (const r of rule) {
    const self = ruleNode(r.id);
    for (const column of inputOf(r)) graph.addEdge(self, columnNode(column));
    for (const upstream of r.dependsOn ?? []) {
      // An unknown prerequisite is not an error — a rule set can be assembled
      // in pieces — but it cannot create an edge either.
      if (known.has(upstream)) graph.addEdge(self, ruleNode(upstream));
    }
  }
  return graph;
}

/**
 * One unit of evaluation. A `linear` stage is a single rule with no cyclic
 * prerequisite and runs exactly once. A `cyclic` stage is a strongly connected
 * component: the engine re-runs the whole group until its diagnostics stop
 * changing or the pass cap fires, whichever comes first.
 */
export type RuleStage =
  | { readonly kind: 'linear'; readonly ruleId: string }
  | { readonly kind: 'cyclic'; readonly ruleId: readonly string[]; readonly path: readonly string[] };

/** The full evaluation plan for a rule set. */
export interface RulePlan {
  readonly stage: readonly RuleStage[];
  /** Every cycle found, each as a path with its first node repeated at the end. */
  readonly cyclePath: readonly (readonly string[])[];
}

/**
 * Topologically order the rules by their `dependsOn` edges, collapsing cycles
 * into `cyclic` stages. Deterministic: independent rules keep declaration
 * order, so a report is stable across runs.
 */
export function planRule(rule: readonly Rule[]): RulePlan {
  const prerequisite = new Map<string, string[]>();
  const known = new Set(rule.map((r) => r.id));
  for (const r of rule) {
    prerequisite.set(
      r.id,
      (r.dependsOn ?? []).filter((id) => known.has(id)),
    );
  }

  const component = tarjan(
    rule.map((r) => r.id),
    prerequisite,
  );

  const stage: RuleStage[] = [];
  const cyclePath: (readonly string[])[] = [];
  for (const group of component) {
    const selfLoop = group.length === 1 && (prerequisite.get(group[0]!) ?? []).includes(group[0]!);
    if (group.length === 1 && !selfLoop) {
      stage.push({ kind: 'linear', ruleId: group[0]! });
      continue;
    }
    const path = selfLoop ? [group[0]!, group[0]!] : findCyclePath(group, prerequisite);
    cyclePath.push(path);
    stage.push({ kind: 'cyclic', ruleId: group, path });
  }
  return { stage, cyclePath };
}

/**
 * Tarjan's strongly connected components. Emits each component only after
 * every component it points to, which — with edges pointing at prerequisites —
 * is precisely evaluation order. Iterative rather than recursive: rule sets
 * are small today, but a stack overflow inside a validator is an absurd way
 * for a grid to die.
 */
function tarjan(node: readonly string[], edge: ReadonlyMap<string, readonly string[]>): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const output: string[][] = [];
  let counter = 0;

  for (const root of node) {
    if (index.has(root)) continue;
    // Each frame remembers how far through its neighbour list it has walked.
    const frame: { id: string; next: number }[] = [{ id: root, next: 0 }];
    index.set(root, counter);
    low.set(root, counter);
    counter += 1;
    stack.push(root);
    onStack.add(root);

    while (frame.length > 0) {
      const top = frame[frame.length - 1]!;
      const neighbour = edge.get(top.id) ?? [];
      if (top.next < neighbour.length) {
        const next = neighbour[top.next]!;
        top.next += 1;
        if (!index.has(next)) {
          index.set(next, counter);
          low.set(next, counter);
          counter += 1;
          stack.push(next);
          onStack.add(next);
          frame.push({ id: next, next: 0 });
        } else if (onStack.has(next)) {
          low.set(top.id, Math.min(low.get(top.id)!, index.get(next)!));
        }
        continue;
      }
      frame.pop();
      const parent = frame[frame.length - 1];
      if (parent) low.set(parent.id, Math.min(low.get(parent.id)!, low.get(top.id)!));
      if (low.get(top.id) === index.get(top.id)) {
        const group: string[] = [];
        for (;;) {
          const popped = stack.pop()!;
          onStack.delete(popped);
          group.push(popped);
          if (popped === top.id) break;
        }
        group.reverse();
        output.push(group);
      }
    }
  }
  return output;
}

/**
 * Recover a concrete cycle inside a strongly connected component so the report
 * can name it: `a → b → c → a`. Any cycle through the component's first node
 * will do — every node in an SCC lies on some cycle with every other.
 */
function findCyclePath(
  group: readonly string[],
  edge: ReadonlyMap<string, readonly string[]>,
): readonly string[] {
  const member = new Set(group);
  const start = group[0]!;
  const seen = new Set<string>();
  const path: string[] = [];

  const walk = (id: string): boolean => {
    path.push(id);
    seen.add(id);
    for (const next of edge.get(id) ?? []) {
      if (!member.has(next)) continue;
      if (next === start) {
        path.push(start);
        return true;
      }
      if (!seen.has(next) && walk(next)) return true;
    }
    path.pop();
    return false;
  };

  if (walk(start)) return path;
  // Unreachable for a true SCC of size > 1, but a defensive fallback beats an
  // empty path in an error message.
  return [...group, start];
}
