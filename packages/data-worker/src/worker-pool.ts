// =============================================================================
// WorkerPool — a budget controller, not just a scheduler
//
// The failure this exists to prevent: a grid that "goes fast" by spawning
// `navigator.hardwareConcurrency` workers and sorting a million rows across
// all of them. On a developer's 16-core machine that looks like a win. Inside
// a collaborative app — a doc with a CRDT worker, a presence websocket, an
// audio call, a service worker — it is a denial of service against the host
// application, and the symptom the user reports is "typing lags when the grid
// loads", which nobody traces back to the grid.
//
// So concurrency here is a *budget* the host application owns, not a number
// the grid maximises.
//
// -----------------------------------------------------------------------------
// Why half the cores, and never all of them
// -----------------------------------------------------------------------------
// The default is `floor(hardwareConcurrency * 0.5)`, clamped to at least 1 and
// to at most `hardwareConcurrency - 1`. Three reasons for that shape:
//
//   1. The main thread is a core. Saturating every core means the renderer
//      competes with our own workers for the CPU it needs to paint the result
//      we just computed — the work finishes sooner and the frame lands later.
//   2. `navigator.hardwareConcurrency` counts logical cores, so on an SMT
//      machine half of them are hyperthreads that deliver far less than a full
//      core for the memory-bound scan/sort work a grid does. Half the logical
//      count is roughly the physical count.
//   3. We are a component, not an application. Anything above half is a budget
//      the embedding app never agreed to. Adopters who own the whole page can
//      raise it with `setBudget({ maxUtilization: 0.75 })`.
//
// The clamp to `hardwareConcurrency - 1` is the hard rule: the pool never
// requests every core, even when asked for a utilization of 1.
//
// -----------------------------------------------------------------------------
// Adaptive budgeting
// -----------------------------------------------------------------------------
// A static cap is still wrong under contention, because the right number
// depends on what else the page is doing, which changes. The pool watches two
// signals and lowers its *effective* limit below the configured cap:
//
//   - Task latency vs. queue depth. Rising p95 while the queue is deeper than
//     the current limit means the workers are contending, not progressing:
//     adding parallelism there buys nothing and costs the main thread. Back
//     off by one.
//   - Reported main-thread latency. The host can call
//     `observeMainThreadLatency(ms)` with its own rAF or scheduler drift. If
//     the main thread is starved, the pool is a suspect regardless of how
//     healthy its own numbers look, so it backs off immediately.
//
// Recovery is deliberately slower than back-off (one slot per healthy
// completion, only while work remains) so a single quiet moment does not undo
// the throttle.
//
// -----------------------------------------------------------------------------
// Degradation
// -----------------------------------------------------------------------------
// Where `Worker` does not exist — SSR, a jsdom test, an old embedded WebView —
// the pool runs the task inline via the `fallback` executor the adopter
// supplies. Same API, same priorities, same cap; the work simply happens on
// this thread. That is the honest degradation: slower, never broken.
// =============================================================================

import { WorkerPluginHost, type WorkerLike } from '@onegrid/worker-plugins';

/**
 * Queue priority. `high` is interactive work the user is waiting on (sorting
 * the visible viewport), `normal` is the default, `low` is speculative
 * prefetch that must never delay the other two.
 * @public
 */
export type TaskPriority = 'high' | 'normal' | 'low';

const PRIORITY_ORDER: ReadonlyArray<TaskPriority> = ['high', 'normal', 'low'];

/** @public */
export interface PoolTask {
  /** Handler name registered in the worker via `definePluginWorker`. */
  readonly fn: string;
  readonly arg?: ReadonlyArray<unknown>;
  /** Default `normal`. */
  readonly priority?: TaskPriority;
  /** Cancels the task whether it is queued or already running. */
  readonly signal?: AbortSignal;
  readonly transfer?: ReadonlyArray<Transferable>;
}

/** Runtime-adjustable share of the machine the grid may consume. @public */
export interface WorkerBudget {
  /** Absolute worker ceiling. Overrides the utilization-derived value. */
  readonly maxWorker?: number;
  /** Fraction of `hardwareConcurrency`, in (0, 1]. Never yields all cores. */
  readonly maxUtilization?: number;
}

/** Injectable timers so idle teardown is testable without wall-clock waits. @public */
export interface PoolTimer {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

/** @public */
export interface WorkerPoolOptions {
  /**
   * Creates one worker. Called lazily — the pool spawns a worker only when a
   * task is waiting and every existing worker is busy.
   */
  readonly spawn?: () => WorkerLike;
  /**
   * In-thread executor used when no worker transport is available. Receives
   * the same `fn`/`arg` pair the worker handler would, and may return a
   * promise — the pool awaits whatever comes back.
   */
  readonly fallback?: (fn: string, arg: ReadonlyArray<unknown>) => unknown;
  readonly maxWorker?: number;
  /** Default 0.5. See the banner for why. */
  readonly maxUtilization?: number;
  /** Injectable so the budget maths is testable. Defaults to the navigator value. */
  readonly hardwareConcurrency?: number;
  /** Terminate a worker idle this long. Default 15 000 ms. 0 disables. */
  readonly idleTimeoutMs?: number;
  /** Default true. */
  readonly adaptive?: boolean;
  /** p95 above this, with a deep queue, triggers back-off. Default 250 ms. */
  readonly latencyBudgetMs?: number;
  /** Reported main-thread latency above this triggers back-off. Default 50 ms. */
  readonly mainThreadBudgetMs?: number;
  /** Per-task timeout handed to the worker host. Default 60 000 ms. */
  readonly taskTimeoutMs?: number;
  /**
   * Terminate the worker running an aborted task. Default true — a Worker
   * cannot be interrupted any other way, and leaving it grinding on a
   * cancelled 1M-row sort spends exactly the budget we are protecting.
   */
  readonly terminateOnAbort?: boolean;
  /** Test/SSR seam. Defaults to `typeof Worker !== 'undefined'`. */
  readonly workerAvailable?: boolean;
  readonly now?: () => number;
  readonly timer?: PoolTimer;
}

/** @public */
export interface WorkerPoolStat {
  readonly mode: 'worker' | 'inline';
  /** Tasks currently executing. */
  readonly active: number;
  /** Tasks waiting for a slot. */
  readonly queued: number;
  readonly completed: number;
  readonly failed: number;
  readonly cancelled: number;
  /** Workers currently alive (spawned and not torn down). */
  readonly spawnedWorker: number;
  /** Alive workers with no task. */
  readonly idleWorker: number;
  /** The cap derived from the budget. */
  readonly maxWorker: number;
  /** The cap after adaptive reduction. Always <= `maxWorker`. */
  readonly concurrencyLimit: number;
  readonly p95LatencyMs: number;
  readonly meanLatencyMs: number;
}

interface QueueEntry {
  readonly seq: number;
  readonly task: PoolTask;
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: Error) => void;
  readonly priority: TaskPriority;
  detach: (() => void) | null;
  settled: boolean;
  /**
   * The slot executing this entry, so a cancellation terminates the worker
   * that is actually burning cycles rather than an arbitrary busy one.
   */
  slot: Slot | null;
  /** True once this entry's completion has been counted exactly once. */
  accounted: boolean;
}

interface Slot {
  readonly worker: WorkerLike;
  readonly host: WorkerPluginHost;
  busy: boolean;
  idleHandle: unknown;
  disposed: boolean;
}

/** Rejection produced by `AbortSignal` cancellation. @public */
export function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

function abortError(reason: unknown): Error {
  const err = new Error(
    typeof reason === 'string' ? reason : '[OG_POOL_ABORTED] task was aborted.',
  );
  err.name = 'AbortError';
  return err;
}

const DEFAULT_TIMER: PoolTimer = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** How many samples the latency window keeps. */
const LATENCY_SAMPLE_CAPACITY = 64;

/**
 * Resolve the worker ceiling from a utilization fraction.
 *
 * Exported because the number is a policy decision an adopter may want to
 * reproduce in their own telemetry rather than guess at.
 * @public
 */
export function resolveWorkerCap(
  hardwareConcurrency: number,
  maxUtilization: number,
): number {
  const core = Number.isFinite(hardwareConcurrency) && hardwareConcurrency > 0
    ? Math.floor(hardwareConcurrency)
    : 4;
  const util = Math.min(1, Math.max(0, maxUtilization));
  // Never every core: on a 1-core machine that means 1, everywhere else it
  // means at least one core is left for the thread that has to paint.
  const ceiling = Math.max(1, core - 1);
  return Math.max(1, Math.min(ceiling, Math.floor(core * util)));
}

function detectHardwareConcurrency(): number {
  const nav = (globalThis as { navigator?: { hardwareConcurrency?: number } }).navigator;
  const value = nav?.hardwareConcurrency;
  return typeof value === 'number' && value > 0 ? value : 4;
}

/**
 * A concurrency-capped, priority-ordered, cancellable task pool over
 * `@onegrid/worker-plugins` workers. See the file banner for the budget
 * policy and the adaptive rules.
 * @public
 */
export class WorkerPool {
  readonly mode: 'worker' | 'inline';

  private readonly option: WorkerPoolOptions;
  private readonly timer: PoolTimer;
  private readonly now: () => number;
  private readonly slot: Slot[] = [];
  private readonly queue: QueueEntry[] = [];
  private readonly latencySample: number[] = [];

  private hardwareConcurrency: number;
  private maxUtilization: number;
  private explicitMaxWorker: number | undefined;
  private maxWorker: number;
  private concurrencyLimit: number;

  private nextSeq = 1;
  private active = 0;
  private completed = 0;
  private failed = 0;
  private cancelled = 0;
  private disposed = false;

  constructor(option: WorkerPoolOptions = {}) {
    this.option = option;
    this.timer = option.timer ?? DEFAULT_TIMER;
    this.now = option.now ?? (() => Date.now());
    this.hardwareConcurrency = option.hardwareConcurrency ?? detectHardwareConcurrency();
    this.maxUtilization = option.maxUtilization ?? 0.5;
    this.explicitMaxWorker = option.maxWorker;
    this.maxWorker =
      this.explicitMaxWorker ??
      resolveWorkerCap(this.hardwareConcurrency, this.maxUtilization);
    this.concurrencyLimit = this.maxWorker;
    const workerAvailable =
      option.workerAvailable ??
      (globalThis as { Worker?: unknown }).Worker !== undefined;
    this.mode = option.spawn && workerAvailable ? 'worker' : 'inline';
  }

  /**
   * Queue a task. Resolves with the handler's return value; rejects with the
   * worker-side error, a timeout, or an `AbortError` if the signal fires.
   */
  submit<T = unknown>(task: PoolTask): Promise<T> {
    if (this.disposed) {
      return Promise.reject(new Error('[OG_POOL_DISPOSED] pool has been disposed.'));
    }
    if (task.signal?.aborted) {
      this.cancelled++;
      return Promise.reject(abortError(task.signal.reason));
    }
    return new Promise<T>((resolve, reject) => {
      const entry: QueueEntry = {
        seq: this.nextSeq++,
        task,
        resolve: resolve as (v: unknown) => void,
        reject,
        priority: task.priority ?? 'normal',
        detach: null,
        settled: false,
        slot: null,
        accounted: false,
      };
      if (task.signal) {
        const onAbort = (): void => this.abortEntry(entry, task.signal!.reason);
        task.signal.addEventListener('abort', onAbort, { once: true });
        entry.detach = () => task.signal!.removeEventListener('abort', onAbort);
      }
      this.queue.push(entry);
      this.pump();
    });
  }

  /**
   * Change the budget at runtime. Lowering the cap does not kill running
   * tasks — it stops new ones from starting until the pool is back under the
   * new limit, which is the behaviour a host wants when a call starts and it
   * needs its cores back within a second, not immediately.
   */
  setBudget(budget: WorkerBudget): void {
    if (budget.maxUtilization !== undefined) {
      this.maxUtilization = Math.min(1, Math.max(0, budget.maxUtilization));
      this.explicitMaxWorker = undefined;
    }
    if (budget.maxWorker !== undefined) {
      this.explicitMaxWorker = Math.max(1, Math.floor(budget.maxWorker));
    }
    this.maxWorker =
      this.explicitMaxWorker ??
      resolveWorkerCap(this.hardwareConcurrency, this.maxUtilization);
    this.concurrencyLimit = Math.min(this.concurrencyLimit, this.maxWorker);
    if (this.concurrencyLimit < 1) this.concurrencyLimit = 1;
    // Raising the budget should take effect now, not at the next completion.
    if (this.concurrencyLimit < this.maxWorker && this.queue.length > 0) {
      this.concurrencyLimit = this.maxWorker;
    }
    this.pump();
  }

  /**
   * Feed the pool the host's own main-thread latency measurement (rAF delta,
   * `scheduler.yield` drift, long-task duration). Anything above the budget
   * costs the pool a slot immediately — see the banner.
   */
  observeMainThreadLatency(ms: number): void {
    if (this.option.adaptive === false) return;
    const budget = this.option.mainThreadBudgetMs ?? 50;
    if (ms > budget) this.reduceConcurrency();
  }

  /** Point-in-time snapshot. Cheap enough to poll from a debug overlay. */
  stat(): WorkerPoolStat {
    return {
      mode: this.mode,
      active: this.active,
      queued: this.queue.length,
      completed: this.completed,
      failed: this.failed,
      cancelled: this.cancelled,
      spawnedWorker: this.slot.length,
      idleWorker: this.slot.filter((s) => !s.busy).length,
      maxWorker: this.maxWorker,
      concurrencyLimit: this.concurrencyLimit,
      p95LatencyMs: this.percentileLatency(0.95),
      meanLatencyMs: this.meanLatency(),
    };
  }

  /** Reject everything queued, terminate every worker. */
  dispose(): void {
    this.disposed = true;
    for (const entry of this.queue.splice(0, this.queue.length)) {
      entry.detach?.();
      if (!entry.settled) {
        entry.settled = true;
        entry.reject(new Error('[OG_POOL_DISPOSED] pool has been disposed.'));
      }
    }
    for (const s of this.slot.splice(0, this.slot.length)) this.teardownSlot(s);
  }

  // ---------------------------------------------------------------------------
  // Scheduling
  // ---------------------------------------------------------------------------

  private pump(): void {
    while (!this.disposed && this.queue.length > 0 && this.active < this.concurrencyLimit) {
      const entry = this.takeNext();
      if (!entry) return;
      this.run(entry);
    }
  }

  /**
   * Highest priority first, FIFO within a priority. A linear scan beats a heap
   * here: the queue is short (bounded by the number of viewport operations in
   * flight) and the constant factor of a heap is not worth the code.
   */
  private takeNext(): QueueEntry | null {
    for (const priority of PRIORITY_ORDER) {
      let bestIndex = -1;
      for (let i = 0; i < this.queue.length; i++) {
        const e = this.queue[i]!;
        if (e.priority !== priority) continue;
        if (bestIndex === -1 || e.seq < this.queue[bestIndex]!.seq) bestIndex = i;
      }
      if (bestIndex !== -1) return this.queue.splice(bestIndex, 1)[0]!;
    }
    return null;
  }

  private run(entry: QueueEntry): void {
    this.active++;
    const start = this.now();
    const settle = (fn: () => void): void => {
      if (entry.settled) return;
      entry.settled = true;
      entry.detach?.();
      fn();
    };

    if (this.mode === 'inline') {
      void this.runInline(entry, start, settle);
      return;
    }

    const slot = this.acquireSlot();
    entry.slot = slot;
    slot.busy = true;
    this.clearIdleTimer(slot);
    slot.host
      .invoke(entry.task.fn, entry.task.arg ?? [], entry.task.transfer ?? [])
      .then(
        (value) => {
          this.completeEntry(entry, slot, start, true);
          settle(() => entry.resolve(value));
        },
        (err: unknown) => {
          this.completeEntry(entry, slot, start, false);
          settle(() => entry.reject(err instanceof Error ? err : new Error(String(err))));
        },
      );
  }

  private async runInline(
    entry: QueueEntry,
    start: number,
    settle: (fn: () => void) => void,
  ): Promise<void> {
    const fallback = this.option.fallback;
    if (!fallback) {
      entry.accounted = true;
      this.active--;
      this.failed++;
      settle(() =>
        entry.reject(
          new Error(
            '[OG_POOL_NO_EXECUTOR] no `spawn` worker factory and no `fallback` ' +
              'in-thread executor — the pool has nothing to run the task on.',
          ),
        ),
      );
      this.pump();
      return;
    }
    try {
      const value = await fallback(entry.task.fn, entry.task.arg ?? []);
      if (!entry.accounted) {
        entry.accounted = true;
        this.active--;
        this.recordLatency(this.now() - start);
        this.completed++;
      }
      settle(() => entry.resolve(value));
    } catch (err) {
      if (!entry.accounted) {
        entry.accounted = true;
        this.active--;
        this.recordLatency(this.now() - start);
        this.failed++;
      }
      settle(() => entry.reject(err instanceof Error ? err : new Error(String(err))));
    }
    this.adapt();
    this.pump();
  }

  private completeEntry(
    entry: QueueEntry,
    slot: Slot,
    start: number,
    ok: boolean,
  ): void {
    // A cancelled entry already released its slot and its accounting; the
    // rejection arriving afterwards from the terminated host must not
    // double-count.
    if (!entry.accounted) {
      entry.accounted = true;
      this.active--;
      this.recordLatency(this.now() - start);
      if (ok) this.completed++;
      else this.failed++;
    }
    if (!slot.disposed) {
      slot.busy = false;
      this.armIdleTimer(slot);
    }
    this.adapt();
    this.pump();
  }

  private abortEntry(entry: QueueEntry, reason: unknown): void {
    if (entry.settled) return;
    const index = this.queue.indexOf(entry);
    if (index !== -1) {
      // Still queued — drop it before it ever costs a slot.
      this.queue.splice(index, 1);
      entry.settled = true;
      entry.detach?.();
      this.cancelled++;
      entry.reject(abortError(reason));
      return;
    }
    // Already running. Reject the caller now; a Worker cannot be interrupted,
    // so unless we terminate it the cancelled task keeps burning the budget.
    entry.settled = true;
    entry.detach?.();
    this.cancelled++;
    if (!entry.accounted) {
      entry.accounted = true;
      this.active = Math.max(0, this.active - 1);
    }
    entry.reject(abortError(reason));
    if (
      this.mode === 'worker' &&
      entry.slot &&
      !entry.slot.disposed &&
      (this.option.terminateOnAbort ?? true)
    ) {
      this.removeSlot(entry.slot);
    }
    this.pump();
  }

  // ---------------------------------------------------------------------------
  // Worker slots — lazy spawn, idle teardown
  // ---------------------------------------------------------------------------

  private acquireSlot(): Slot {
    const idle = this.slot.find((s) => !s.busy && !s.disposed);
    if (idle) return idle;
    const spawn = this.option.spawn!;
    const worker = spawn();
    const slot: Slot = {
      worker,
      host: new WorkerPluginHost({
        worker,
        timeoutMs: this.option.taskTimeoutMs ?? 60_000,
      }),
      busy: false,
      idleHandle: null,
      disposed: false,
    };
    this.slot.push(slot);
    return slot;
  }

  private armIdleTimer(slot: Slot): void {
    const idleTimeoutMs = this.option.idleTimeoutMs ?? 15_000;
    if (idleTimeoutMs <= 0) return;
    this.clearIdleTimer(slot);
    slot.idleHandle = this.timer.set(() => {
      if (slot.busy || slot.disposed) return;
      this.removeSlot(slot);
    }, idleTimeoutMs);
  }

  private clearIdleTimer(slot: Slot): void {
    if (slot.idleHandle !== null) {
      this.timer.clear(slot.idleHandle);
      slot.idleHandle = null;
    }
  }

  private removeSlot(slot: Slot): void {
    const index = this.slot.indexOf(slot);
    if (index !== -1) this.slot.splice(index, 1);
    this.teardownSlot(slot);
  }

  private teardownSlot(slot: Slot): void {
    if (slot.disposed) return;
    slot.disposed = true;
    this.clearIdleTimer(slot);
    // Rejects the host's pending calls and terminates the worker.
    slot.host.dispose();
  }

  // ---------------------------------------------------------------------------
  // Adaptive budgeting
  // ---------------------------------------------------------------------------

  private adapt(): void {
    if (this.option.adaptive === false) return;
    const budget = this.option.latencyBudgetMs ?? 250;
    const p95 = this.percentileLatency(0.95);
    if (p95 > budget && this.queue.length > this.concurrencyLimit) {
      // Deep queue AND slow tasks: more parallelism would only deepen the
      // contention that made them slow.
      this.reduceConcurrency();
      return;
    }
    if (p95 <= budget * 0.5 && this.queue.length > 0) {
      this.growConcurrency();
    }
  }

  private reduceConcurrency(): void {
    if (this.concurrencyLimit > 1) this.concurrencyLimit--;
  }

  private growConcurrency(): void {
    if (this.concurrencyLimit < this.maxWorker) this.concurrencyLimit++;
  }

  private recordLatency(ms: number): void {
    this.latencySample.push(ms);
    if (this.latencySample.length > LATENCY_SAMPLE_CAPACITY) this.latencySample.shift();
  }

  private percentileLatency(q: number): number {
    if (this.latencySample.length === 0) return 0;
    const sorted = [...this.latencySample].sort((a, b) => a - b);
    const index = Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1);
    return sorted[Math.max(0, index)]!;
  }

  private meanLatency(): number {
    if (this.latencySample.length === 0) return 0;
    let sum = 0;
    for (const v of this.latencySample) sum += v;
    return sum / this.latencySample.length;
  }
}

/** @public */
export function createWorkerPool(option: WorkerPoolOptions = {}): WorkerPool {
  return new WorkerPool(option);
}
