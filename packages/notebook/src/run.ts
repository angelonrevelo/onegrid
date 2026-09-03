// =============================================================================
// Execution
//
// Runs are demand-driven and minimal. `runNotebook` evaluates everything;
// `runCell` evaluates one cell plus its TRANSITIVE DEPENDENTS and nothing
// else — a cell nobody downstream of the edit reads is never handed to a
// kernel again. That is the property the incremental tests assert by
// counting kernel invocations, and it is the whole reason the graph exists.
//
// Three decisions worth stating:
//
//   1. Errors do not throw, they become outputs. A failing cell yields an
//      `ErrorOutput` and every dependent inherits it WITH THE ORIGIN'S ID
//      attached, so the UI blames the cell that actually broke. A run
//      always completes; the document tells you what went wrong.
//
//   2. Cancellation DOES throw, because a cancelled run has no meaningful
//      result. `NotebookAbortError` carries the partial document so a caller
//      that wants to keep completed work can.
//
//   3. Cycles are detected before the first kernel call. Participants get an
//      error output naming the full path; their downstream cells get the
//      propagated error. Nothing hangs, nothing recurses.
// =============================================================================

import { buildGraph, findAllCycle, topoOrder, transitiveDependent } from './graph';
import { setCellResult } from './document';
import { unwrapOutput } from './output';
import type { KernelRegistry } from './kernel';
import { createKernelRegistry } from './kernel';
import type {
  CellOutput,
  ErrorOutput,
  Kernel,
  KernelScope,
  NotebookCell,
  NotebookDocument,
} from './types';

/**
 * Thrown when a run is cancelled through its `AbortSignal`. `partial` is the
 * document as of the last cell that finished, so completed work is not lost.
 * @public
 */
export class NotebookAbortError extends Error {
  readonly partial: NotebookDocument;
  constructor(partial: NotebookDocument) {
    super('[OG_NOTEBOOK_ABORTED] notebook run cancelled');
    this.name = 'NotebookAbortError';
    this.partial = partial;
  }
}

/** @public */
export interface RunOption {
  /** Kernels by language. An array is wrapped in a registry for you. */
  readonly kernel: ReadonlyArray<Kernel> | KernelRegistry;
  /** Cancels the run between cells, and inside a cooperating kernel. */
  readonly signal?: AbortSignal;
  /**
   * Called with the document after every state transition (queued →
   * running → ok/error). Each call receives a NEW document — this is the
   * hook a UI renders from.
   */
  readonly onProgress?: (doc: NotebookDocument) => void;
}

function asRegistry(kernel: RunOption['kernel']): KernelRegistry {
  return Array.isArray(kernel)
    ? createKernelRegistry(kernel)
    : (kernel as KernelRegistry);
}

/**
 * Evaluate every cell, in dependency order.
 * @public
 */
export function runNotebook(doc: NotebookDocument, option: RunOption): Promise<NotebookDocument> {
  return execute(doc, new Set(doc.cell.map((c) => c.id)), option);
}

/**
 * Evaluate one cell and everything transitively downstream of it. Cells
 * outside that set keep their existing outputs and are never re-evaluated.
 * @public
 */
export function runCell(
  doc: NotebookDocument,
  id: string,
  option: RunOption,
): Promise<NotebookDocument> {
  const target = doc.cell.find((c) => c.id === id);
  if (!target) return Promise.resolve(doc);
  return execute(doc, new Set([id, ...transitiveDependent(doc, id)]), option);
}

/**
 * Evaluate every cell that is not currently `ok` — the "refresh what the
 * edits invalidated" entry point — plus everything downstream of those.
 * @public
 */
export function runStale(doc: NotebookDocument, option: RunOption): Promise<NotebookDocument> {
  const dirty = new Set<string>();
  for (const cell of doc.cell) {
    if (cell.state === 'ok') continue;
    dirty.add(cell.id);
    for (const down of transitiveDependent(doc, cell.id)) dirty.add(down);
  }
  return execute(doc, dirty, option);
}

async function execute(
  input: NotebookDocument,
  target: ReadonlySet<string>,
  option: RunOption,
): Promise<NotebookDocument> {
  const registry = asRegistry(option.kernel);
  const graph = buildGraph(input);
  const signal = option.signal ?? new AbortController().signal;

  // --- cycles, before anything runs -----------------------------------
  const cycle = findAllCycle(input, graph);
  const cycleErrorById = new Map<string, ErrorOutput>();
  for (const c of cycle) {
    const rendered = c.label.join(' → ');
    for (const id of new Set(c.path)) {
      cycleErrorById.set(id, {
        kind: 'error',
        message: `[OG_NOTEBOOK_CYCLE] circular reference: ${rendered}`,
        cellId: id,
      });
    }
  }

  const { order, blocked } = topoOrder(input, graph);
  const runOrder = order.filter((id) => target.has(id));

  // --- queue every cell we are about to touch --------------------------
  let doc = input;
  const queued = new Set([...runOrder, ...blocked.filter((id) => target.has(id))]);
  if (queued.size > 0) {
    doc = {
      cell: doc.cell.map((c) => (queued.has(c.id) ? { ...c, state: 'queued' as const } : c)),
      revision: doc.revision + 1,
    };
    option.onProgress?.(doc);
  }

  const nameById = new Map<string, string>();
  for (const cell of input.cell) if (cell.name !== undefined) nameById.set(cell.id, cell.name);

  // --- the DAG portion --------------------------------------------------
  for (const id of runOrder) {
    if (signal.aborted) throw new NotebookAbortError(doc);
    const cell = doc.cell.find((c) => c.id === id)!;

    doc = setCellResult(doc, id, 'running', cell.output);
    option.onProgress?.(doc);

    const upstreamProblem = firstUpstreamProblem(doc, graph, id, nameById);
    if (upstreamProblem) {
      doc = setCellResult(doc, id, 'error', upstreamProblem);
      option.onProgress?.(doc);
      continue;
    }

    const kernel = registry.get(cell.kind);
    if (!kernel) {
      doc = setCellResult(doc, id, 'error', {
        kind: 'error',
        message: `[OG_NOTEBOOK_NO_KERNEL] no kernel registered for kind "${cell.kind}"`,
        cellId: id,
      });
      option.onProgress?.(doc);
      continue;
    }

    let output: CellOutput;
    try {
      output = await kernel.evaluate(cell.source, makeScope(doc, graph, cell, signal));
    } catch (err) {
      if (signal.aborted) throw new NotebookAbortError(doc);
      output = {
        kind: 'error',
        message: err instanceof Error ? err.message : String(err),
        cellId: id,
      };
    }
    if (signal.aborted) throw new NotebookAbortError(doc);
    doc = setCellResult(doc, id, output.kind === 'error' ? 'error' : 'ok', output);
    option.onProgress?.(doc);
  }

  // --- cells the DAG could not reach (cycles + their downstream) --------
  for (const id of blocked) {
    if (!target.has(id)) continue;
    const output =
      cycleErrorById.get(id) ??
      downstreamOfCycleError(id, graph, cycleErrorById, nameById) ?? {
        kind: 'error' as const,
        message: '[OG_NOTEBOOK_CYCLE] cell is downstream of a circular reference',
        cellId: id,
      };
    doc = setCellResult(doc, id, 'error', output);
    option.onProgress?.(doc);
  }

  return doc;
}

/** Walk up from a blocked cell to the cycle that is holding it back. */
function downstreamOfCycleError(
  id: string,
  graph: ReturnType<typeof buildGraph>,
  cycleErrorById: ReadonlyMap<string, ErrorOutput>,
  nameById: ReadonlyMap<string, string>,
): ErrorOutput | undefined {
  const seen = new Set<string>([id]);
  const stack = [...(graph.dependency.get(id) ?? [])];
  while (stack.length > 0) {
    const next = stack.pop()!;
    if (seen.has(next)) continue;
    seen.add(next);
    const origin = cycleErrorById.get(next);
    if (origin) {
      return {
        kind: 'error',
        message: `[OG_NOTEBOOK_UPSTREAM] depends on "${nameById.get(next) ?? next}": ${origin.message}`,
        cellId: origin.cellId,
      };
    }
    for (const up of graph.dependency.get(next) ?? []) stack.push(up);
  }
  return undefined;
}

/**
 * A cell runs only when every dependency has a usable output. An upstream
 * error propagates with the ORIGIN cell id intact; an upstream cell that was
 * never computed is its own distinct failure.
 */
function firstUpstreamProblem(
  doc: NotebookDocument,
  graph: ReturnType<typeof buildGraph>,
  id: string,
  nameById: ReadonlyMap<string, string>,
): ErrorOutput | undefined {
  for (const depId of graph.dependency.get(id) ?? []) {
    const dep = doc.cell.find((c) => c.id === depId);
    if (!dep) continue;
    const label = nameById.get(depId) ?? depId;
    if (dep.output === undefined) {
      return {
        kind: 'error',
        message: `[OG_NOTEBOOK_UNCOMPUTED] depends on "${label}", which has no output`,
        cellId: depId,
      };
    }
    if (dep.output.kind === 'error') {
      return {
        kind: 'error',
        message: `[OG_NOTEBOOK_UPSTREAM] depends on "${label}": ${dep.output.message}`,
        // The origin id, not the direct dependency — blame the real culprit.
        cellId: dep.output.cellId,
      };
    }
  }
  return undefined;
}

/** Build the scope a kernel sees. Table materialisation is lazy + cached. */
function makeScope(
  doc: NotebookDocument,
  graph: ReturnType<typeof buildGraph>,
  cell: NotebookCell,
  signal: AbortSignal,
): KernelScope {
  const visible = new Map<string, CellOutput>();
  for (const depId of graph.dependency.get(cell.id) ?? []) {
    const dep = doc.cell.find((c) => c.id === depId);
    if (dep?.name !== undefined && dep.output !== undefined) visible.set(dep.name, dep.output);
  }
  const cache = new Map<string, unknown>();
  return {
    cellId: cell.id,
    name: [...visible.keys()],
    has: (name) => visible.has(name),
    output: (name) => visible.get(name),
    get: (name) => {
      if (cache.has(name)) return cache.get(name);
      const value = unwrapOutput(visible.get(name));
      cache.set(name, value);
      return value;
    },
    signal,
  };
}

/**
 * A serialising run queue. Runs never overlap — a notebook has one shared
 * kernel state, so two concurrent runs would interleave writes to it. Each
 * call queues behind the previous one and resolves with its own document.
 * @public
 */
export interface NotebookRunner {
  readonly run: (doc: NotebookDocument, signal?: AbortSignal) => Promise<NotebookDocument>;
  readonly runCell: (
    doc: NotebookDocument,
    id: string,
    signal?: AbortSignal,
  ) => Promise<NotebookDocument>;
  readonly runStale: (doc: NotebookDocument, signal?: AbortSignal) => Promise<NotebookDocument>;
  /** Abort the in-flight run and everything already queued behind it. */
  readonly cancel: () => void;
  /** Runs queued but not finished, including the in-flight one. */
  readonly pendingCount: () => number;
}

/** @public */
export interface RunnerOption {
  readonly kernel: ReadonlyArray<Kernel> | KernelRegistry;
  readonly onProgress?: (doc: NotebookDocument) => void;
}

/** @public */
export function createNotebookRunner(option: RunnerOption): NotebookRunner {
  const registry = asRegistry(option.kernel);
  let tail: Promise<unknown> = Promise.resolve();
  let pending = 0;
  let controller = new AbortController();

  const enqueue = (
    task: (runOption: RunOption) => Promise<NotebookDocument>,
    signal: AbortSignal | undefined,
  ): Promise<NotebookDocument> => {
    pending += 1;
    // Capture the controller AT ENQUEUE TIME. `cancel()` swaps in a fresh
    // one, so everything already queued shares the aborted controller and
    // dies together, while anything enqueued afterwards runs normally.
    const generation = controller;
    const start = (): Promise<NotebookDocument> => {
      const merged = mergeSignal(generation.signal, signal);
      const runOption: RunOption = option.onProgress
        ? { kernel: registry, signal: merged, onProgress: option.onProgress }
        : { kernel: registry, signal: merged };
      return task(runOption);
    };
    // A failed predecessor must not poison the queue — both arms start us.
    const result = tail.then(start, start);
    tail = result.then(
      () => {
        pending -= 1;
      },
      () => {
        pending -= 1;
      },
    );
    return result;
  };

  return {
    run: (doc, signal) => enqueue((o) => runNotebook(doc, o), signal),
    runCell: (doc, id, signal) => enqueue((o) => runCell(doc, id, o), signal),
    runStale: (doc, signal) => enqueue((o) => runStale(doc, o), signal),
    cancel: () => {
      controller.abort();
      // A fresh controller so the runner is reusable after a cancel.
      controller = new AbortController();
    },
    pendingCount: () => pending,
  };
}

/** Combine two abort signals into one that fires when either does. */
function mergeSignal(a: AbortSignal, b: AbortSignal | undefined): AbortSignal {
  if (!b) return a;
  const merged = new AbortController();
  if (a.aborted || b.aborted) merged.abort();
  else {
    const onAbort = (): void => merged.abort();
    a.addEventListener('abort', onAbort, { once: true });
    b.addEventListener('abort', onAbort, { once: true });
  }
  return merged.signal;
}
