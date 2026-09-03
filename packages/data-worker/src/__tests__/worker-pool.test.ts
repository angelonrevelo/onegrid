import { describe, it, expect } from 'vitest';
import {
  WorkerPool,
  createWorkerPool,
  isAbortError,
  resolveWorkerCap,
  type PoolTimer,
} from '../worker-pool.js';
import type { WorkerLike } from '@onegrid/worker-plugins';

// -----------------------------------------------------------------------------
// Fake worker farm — speaks the @onegrid/worker-plugins wire protocol so the
// pool runs its real dispatch path, but every invocation parks until the test
// resolves it. That is what makes concurrency, priority and cancellation
// observable without racing a real thread.
// -----------------------------------------------------------------------------

interface Invocation {
  readonly worker: FakeWorker;
  readonly id: number;
  readonly fn: string;
  readonly arg: ReadonlyArray<unknown>;
}

class FakeWorker {
  readonly listener = new Map<string, Set<(e: unknown) => void>>();
  terminated = false;

  constructor(private readonly farm: FakeWorkerFarm) {}

  postMessage(message: unknown): void {
    const msg = message as { kind: string; id: number; fn: string; args: unknown[] };
    if (msg.kind !== 'invoke') return;
    this.farm.pending.push({ worker: this, id: msg.id, fn: msg.fn, arg: msg.args });
  }
  addEventListener(type: string, l: (e: unknown) => void): void {
    let set = this.listener.get(type);
    if (!set) this.listener.set(type, (set = new Set()));
    set.add(l);
  }
  removeEventListener(type: string, l: unknown): void {
    this.listener.get(type)?.delete(l as (e: unknown) => void);
  }
  terminate(): void {
    this.terminated = true;
    this.farm.terminatedCount++;
  }
  deliver(data: unknown): void {
    this.listener.get('message')?.forEach((fn) => fn({ data }));
  }
}

class FakeWorkerFarm {
  readonly spawned: FakeWorker[] = [];
  readonly pending: Invocation[] = [];
  readonly dispatchLog: string[] = [];
  terminatedCount = 0;
  maxInFlight = 0;

  readonly spawn = (): WorkerLike => {
    const worker = new FakeWorker(this);
    this.spawned.push(worker);
    // The overloaded addEventListener on WorkerLike is not expressible on a
    // plain test double; the wire shape is what matters here.
    return worker as unknown as WorkerLike;
  };

  /** Note every dispatch and the peak in-flight count before settling any. */
  observe(): void {
    for (const p of this.pending) {
      if (!this.dispatchLog.includes(`${p.fn}#${p.id}`)) {
        this.dispatchLog.push(`${p.fn}#${p.id}`);
      }
    }
    this.maxInFlight = Math.max(this.maxInFlight, this.pending.length);
  }

  /** Resolve the oldest in-flight invocation. */
  async settleNext(value: unknown = 'ok'): Promise<void> {
    this.observe();
    const next = this.pending.shift();
    if (!next) throw new Error('nothing in flight');
    next.worker.deliver({ kind: 'result', id: next.id, ok: true, value });
    await flush();
  }

  async settleAll(value: unknown = 'ok'): Promise<void> {
    while (this.pending.length > 0) await this.settleNext(value);
  }

  async failNext(message: string): Promise<void> {
    this.observe();
    const next = this.pending.shift();
    if (!next) throw new Error('nothing in flight');
    next.worker.deliver({
      kind: 'result',
      id: next.id,
      ok: false,
      error: { name: 'RangeError', message },
    });
    await flush();
  }
}

/** Let queued microtasks (the pool settles through promises) run. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

class ManualTimer implements PoolTimer {
  private nextHandle = 1;
  readonly entry = new Map<number, () => void>();
  set(fn: () => void, _ms: number): unknown {
    const handle = this.nextHandle++;
    this.entry.set(handle, fn);
    return handle;
  }
  clear(handle: unknown): void {
    this.entry.delete(handle as number);
  }
  /** Fire every armed timer, as a wall clock eventually would. */
  fire(): void {
    const pending = [...this.entry.values()];
    this.entry.clear();
    pending.forEach((fn) => fn());
  }
  get armedCount(): number {
    return this.entry.size;
  }
}

function makePool(
  farm: FakeWorkerFarm,
  option: Partial<ConstructorParameters<typeof WorkerPool>[0]> = {},
): WorkerPool {
  return new WorkerPool({
    spawn: farm.spawn,
    workerAvailable: true,
    hardwareConcurrency: 16,
    idleTimeoutMs: 0,
    ...option,
  });
}

// -----------------------------------------------------------------------------

describe('resolveWorkerCap', () => {
  it('takes half the logical cores by default', () => {
    expect(resolveWorkerCap(16, 0.5)).toBe(8);
    expect(resolveWorkerCap(8, 0.5)).toBe(4);
    expect(resolveWorkerCap(4, 0.5)).toBe(2);
  });

  it('never claims every core, even at utilization 1', () => {
    expect(resolveWorkerCap(16, 1)).toBe(15);
    expect(resolveWorkerCap(4, 1)).toBe(3);
    expect(resolveWorkerCap(2, 1)).toBe(1);
  });

  it('always yields at least one worker, however small or bogus the machine', () => {
    expect(resolveWorkerCap(1, 0.5)).toBe(1);
    expect(resolveWorkerCap(2, 0.5)).toBe(1);
    expect(resolveWorkerCap(0, 0.5)).toBe(2); // unknown core count -> assume 4
    expect(resolveWorkerCap(Number.NaN, 0.25)).toBe(1);
    expect(resolveWorkerCap(16, 0)).toBe(1);
  });

  it('is the cap the pool reports for the detected machine', () => {
    const pool = new WorkerPool({ hardwareConcurrency: 12, fallback: () => 1 });
    expect(pool.stat().maxWorker).toBe(6);
    expect(pool.stat().concurrencyLimit).toBe(6);
  });
});

describe('WorkerPool lazy spawn', () => {
  it('spawns nothing until a task exists', () => {
    const farm = new FakeWorkerFarm();
    const pool = makePool(farm);
    expect(farm.spawned.length).toBe(0);
    expect(pool.stat().spawnedWorker).toBe(0);
    pool.dispose();
  });

  it('spawns one worker per concurrently-running task, not per cap', async () => {
    const farm = new FakeWorkerFarm();
    const pool = makePool(farm, { maxWorker: 8 });
    void pool.submit({ fn: 'sort' });
    expect(farm.spawned.length).toBe(1);
    void pool.submit({ fn: 'sort' });
    void pool.submit({ fn: 'sort' });
    expect(farm.spawned.length).toBe(3);
    expect(pool.stat().maxWorker).toBe(8);
    await farm.settleAll();
    // Finished workers are reused rather than respawned.
    const reused = pool.submit({ fn: 'sort' });
    expect(farm.spawned.length).toBe(3);
    pool.dispose();
    await expect(reused).rejects.toThrow(/OG_WORKER_DISPOSED/);
  });
});

describe('WorkerPool concurrency cap', () => {
  it('never runs more tasks at once than the cap allows', async () => {
    const farm = new FakeWorkerFarm();
    const pool = makePool(farm, { maxWorker: 2, adaptive: false });
    const task = Array.from({ length: 10 }, () => pool.submit({ fn: 'sort' }));
    expect(pool.stat().active).toBe(2);
    expect(pool.stat().queued).toBe(8);
    while (farm.pending.length > 0) {
      expect(farm.pending.length).toBeLessThanOrEqual(2);
      await farm.settleNext();
    }
    await Promise.all(task);
    expect(farm.maxInFlight).toBe(2);
    expect(farm.spawned.length).toBe(2);
    expect(pool.stat().completed).toBe(10);
    pool.dispose();
  });

  it('honours a cap of one, serialising everything', async () => {
    const farm = new FakeWorkerFarm();
    const pool = makePool(farm, { maxWorker: 1, adaptive: false });
    const task = [pool.submit({ fn: 'a' }), pool.submit({ fn: 'b' })];
    expect(farm.pending.length).toBe(1);
    await farm.settleAll();
    await Promise.all(task);
    expect(farm.maxInFlight).toBe(1);
    pool.dispose();
  });
});

describe('WorkerPool priority', () => {
  it('runs high before normal before low', async () => {
    const farm = new FakeWorkerFarm();
    const pool = makePool(farm, { maxWorker: 1, adaptive: false });
    const running = pool.submit({ fn: 'running' });
    const low = pool.submit({ fn: 'low', priority: 'low' });
    const normal = pool.submit({ fn: 'normal' });
    const high = pool.submit({ fn: 'high', priority: 'high' });
    await farm.settleAll();
    await Promise.all([running, low, normal, high]);
    expect(farm.dispatchLog.map((s) => s.split('#')[0])).toEqual([
      'running',
      'high',
      'normal',
      'low',
    ]);
    pool.dispose();
  });

  it('is FIFO within one priority level', async () => {
    const farm = new FakeWorkerFarm();
    const pool = makePool(farm, { maxWorker: 1, adaptive: false });
    const task = ['a', 'b', 'c', 'd'].map((fn) => pool.submit({ fn }));
    await farm.settleAll();
    await Promise.all(task);
    expect(farm.dispatchLog.map((s) => s.split('#')[0])).toEqual(['a', 'b', 'c', 'd']);
    pool.dispose();
  });
});

describe('WorkerPool cancellation', () => {
  it('drops a queued task without ever dispatching it', async () => {
    const farm = new FakeWorkerFarm();
    const pool = makePool(farm, { maxWorker: 1, adaptive: false });
    const running = pool.submit({ fn: 'running' });
    const controller = new AbortController();
    const cancelled = pool.submit({ fn: 'cancelled', signal: controller.signal });
    expect(pool.stat().queued).toBe(1);
    controller.abort();
    await expect(cancelled).rejects.toSatisfy(isAbortError);
    expect(pool.stat().queued).toBe(0);
    expect(pool.stat().cancelled).toBe(1);
    await farm.settleAll();
    await running;
    expect(farm.dispatchLog.map((s) => s.split('#')[0])).toEqual(['running']);
    pool.dispose();
  });

  it('rejects a task whose signal is already aborted, without queueing it', async () => {
    const farm = new FakeWorkerFarm();
    const pool = makePool(farm);
    const controller = new AbortController();
    controller.abort();
    await expect(pool.submit({ fn: 'x', signal: controller.signal })).rejects.toSatisfy(
      isAbortError,
    );
    expect(farm.spawned.length).toBe(0);
    expect(pool.stat().cancelled).toBe(1);
    pool.dispose();
  });

  it('terminates the worker running an aborted task and frees the slot', async () => {
    const farm = new FakeWorkerFarm();
    const pool = makePool(farm, { maxWorker: 1, adaptive: false });
    const controller = new AbortController();
    const running = pool.submit({ fn: 'slow', signal: controller.signal });
    const queued = pool.submit({ fn: 'next' });
    const victim = farm.spawned[0]!;
    expect(pool.stat().active).toBe(1);
    controller.abort();
    await expect(running).rejects.toSatisfy(isAbortError);
    expect(victim.terminated).toBe(true);
    expect(farm.terminatedCount).toBe(1);
    // The queued task takes the freed slot on a freshly spawned worker.
    expect(farm.spawned.length).toBe(2);
    expect(pool.stat().active).toBe(1);
    await farm.settleAll();
    await expect(queued).resolves.toBe('ok');
    pool.dispose();
  });

  it('leaves the worker alive when terminateOnAbort is off', async () => {
    const farm = new FakeWorkerFarm();
    const pool = makePool(farm, {
      maxWorker: 1,
      adaptive: false,
      terminateOnAbort: false,
    });
    const controller = new AbortController();
    const running = pool.submit({ fn: 'slow', signal: controller.signal });
    controller.abort();
    await expect(running).rejects.toSatisfy(isAbortError);
    expect(farm.spawned[0]!.terminated).toBe(false);
    expect(farm.terminatedCount).toBe(0);
    pool.dispose();
  });
});

describe('WorkerPool adaptive budgeting', () => {
  it('reduces concurrency when latency is high and the queue is deep', async () => {
    const farm = new FakeWorkerFarm();
    // Every call to now() advances 100 ms, so each task measures as 100 ms —
    // far past the 10 ms budget.
    let clock = 0;
    const pool = makePool(farm, {
      maxWorker: 4,
      latencyBudgetMs: 10,
      now: () => (clock += 100),
    });
    const task = Array.from({ length: 20 }, () => pool.submit({ fn: 'sort' }));
    expect(pool.stat().concurrencyLimit).toBe(4);
    await farm.settleNext();
    expect(pool.stat().concurrencyLimit).toBe(3);
    await farm.settleNext();
    expect(pool.stat().concurrencyLimit).toBe(2);
    expect(pool.stat().p95LatencyMs).toBeGreaterThan(10);
    while (farm.pending.length > 0) await farm.settleNext();
    await Promise.all(task);
    expect(pool.stat().concurrencyLimit).toBeGreaterThanOrEqual(1);
    pool.dispose();
  });

  it('does not reduce concurrency when the queue is shallow', async () => {
    const farm = new FakeWorkerFarm();
    let clock = 0;
    const pool = makePool(farm, {
      maxWorker: 4,
      latencyBudgetMs: 10,
      now: () => (clock += 100),
    });
    const task = [pool.submit({ fn: 'a' }), pool.submit({ fn: 'b' })];
    await farm.settleAll();
    await Promise.all(task);
    expect(pool.stat().concurrencyLimit).toBe(4);
    pool.dispose();
  });

  it('backs off immediately on a starved main thread, and not on a healthy one', () => {
    const farm = new FakeWorkerFarm();
    const pool = makePool(farm, { maxWorker: 4, mainThreadBudgetMs: 50 });
    pool.observeMainThreadLatency(8);
    expect(pool.stat().concurrencyLimit).toBe(4);
    pool.observeMainThreadLatency(120);
    expect(pool.stat().concurrencyLimit).toBe(3);
    pool.observeMainThreadLatency(120);
    expect(pool.stat().concurrencyLimit).toBe(2);
    pool.dispose();
  });

  it('never adapts below one worker, and not at all when adaptive is off', () => {
    const farm = new FakeWorkerFarm();
    const pool = makePool(farm, { maxWorker: 2 });
    for (let i = 0; i < 10; i++) pool.observeMainThreadLatency(500);
    expect(pool.stat().concurrencyLimit).toBe(1);
    const fixed = makePool(farm, { maxWorker: 2, adaptive: false });
    for (let i = 0; i < 10; i++) fixed.observeMainThreadLatency(500);
    expect(fixed.stat().concurrencyLimit).toBe(2);
    pool.dispose();
    fixed.dispose();
  });

  it('recovers a slot per healthy completion while work remains', async () => {
    const farm = new FakeWorkerFarm();
    const pool = makePool(farm, { maxWorker: 4, latencyBudgetMs: 1000, now: () => 0 });
    pool.observeMainThreadLatency(500);
    pool.observeMainThreadLatency(500);
    expect(pool.stat().concurrencyLimit).toBe(2);
    const task = Array.from({ length: 6 }, () => pool.submit({ fn: 'sort' }));
    await farm.settleNext();
    expect(pool.stat().concurrencyLimit).toBe(3);
    while (farm.pending.length > 0) await farm.settleNext();
    await Promise.all(task);
    expect(pool.stat().concurrencyLimit).toBe(4);
    pool.dispose();
  });
});

describe('WorkerPool.setBudget', () => {
  it('lowers the cap at runtime without killing running work', async () => {
    const farm = new FakeWorkerFarm();
    const pool = makePool(farm, { maxWorker: 4, adaptive: false });
    const task = Array.from({ length: 6 }, () => pool.submit({ fn: 'sort' }));
    expect(pool.stat().active).toBe(4);
    pool.setBudget({ maxWorker: 1 });
    expect(pool.stat().maxWorker).toBe(1);
    expect(pool.stat().active).toBe(4); // in-flight work is not interrupted
    await farm.settleNext();
    await farm.settleNext();
    await farm.settleNext();
    // Back under the new limit, so exactly one task runs at a time now.
    expect(farm.pending.length).toBe(1);
    while (farm.pending.length > 0) await farm.settleNext();
    await Promise.all(task);
    pool.dispose();
  });

  it('derives the cap from maxUtilization and takes effect immediately', async () => {
    const farm = new FakeWorkerFarm();
    const pool = makePool(farm, { hardwareConcurrency: 16, adaptive: false });
    expect(pool.stat().maxWorker).toBe(8);
    pool.setBudget({ maxUtilization: 0.25 });
    expect(pool.stat().maxWorker).toBe(4);
    const task = Array.from({ length: 8 }, () => pool.submit({ fn: 'sort' }));
    expect(pool.stat().active).toBe(4);
    pool.setBudget({ maxUtilization: 0.5 });
    expect(pool.stat().maxWorker).toBe(8);
    expect(pool.stat().active).toBe(8); // the raise dispatched the backlog
    await farm.settleAll();
    await Promise.all(task);
    pool.dispose();
  });
});

describe('WorkerPool idle teardown', () => {
  it('terminates a worker that has been idle past the timeout', async () => {
    const farm = new FakeWorkerFarm();
    const timer = new ManualTimer();
    const pool = makePool(farm, { maxWorker: 2, idleTimeoutMs: 15_000, timer });
    const task = pool.submit({ fn: 'sort' });
    expect(timer.armedCount).toBe(0); // nothing idle while the task runs
    await farm.settleAll();
    await task;
    expect(timer.armedCount).toBe(1);
    timer.fire();
    expect(farm.spawned[0]!.terminated).toBe(true);
    expect(pool.stat().spawnedWorker).toBe(0);
    // A later task spawns a fresh worker rather than reusing a dead one.
    const next = pool.submit({ fn: 'sort' });
    expect(farm.spawned.length).toBe(2);
    await farm.settleAll();
    await expect(next).resolves.toBe('ok');
    pool.dispose();
  });

  it('does not arm the idle timer when the timeout is disabled', async () => {
    const farm = new FakeWorkerFarm();
    const timer = new ManualTimer();
    const pool = makePool(farm, { idleTimeoutMs: 0, timer });
    const task = pool.submit({ fn: 'sort' });
    await farm.settleAll();
    await task;
    expect(timer.armedCount).toBe(0);
    expect(pool.stat().idleWorker).toBe(1);
    pool.dispose();
  });
});

describe('WorkerPool degradation', () => {
  it('runs inline when no Worker exists, honouring the same cap', async () => {
    let inFlight = 0;
    let peak = 0;
    const release: Array<() => void> = [];
    const pool = createWorkerPool({
      workerAvailable: false,
      maxWorker: 2,
      adaptive: false,
      fallback: async (fn) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise<void>((resolve) => release.push(resolve));
        inFlight--;
        return `${fn}:inline`;
      },
    });
    expect(pool.mode).toBe('inline');
    const task = Array.from({ length: 5 }, () => pool.submit<string>({ fn: 'sort' }));
    await flush();
    expect(peak).toBe(2);
    while (release.length > 0) {
      release.shift()!();
      await flush();
    }
    expect(await Promise.all(task)).toEqual(Array<string>(5).fill('sort:inline'));
    expect(peak).toBe(2);
    expect(pool.stat().mode).toBe('inline');
    expect(pool.stat().completed).toBe(5);
    pool.dispose();
  });

  it('degrades to inline even when a spawn factory was supplied', () => {
    const farm = new FakeWorkerFarm();
    const pool = createWorkerPool({
      spawn: farm.spawn,
      workerAvailable: false,
      fallback: () => 1,
    });
    expect(pool.mode).toBe('inline');
    pool.dispose();
  });

  it('surfaces a clear error when there is nothing to run the task on', async () => {
    const pool = createWorkerPool({ workerAvailable: false });
    await expect(pool.submit({ fn: 'sort' })).rejects.toThrow(/OG_POOL_NO_EXECUTOR/);
    expect(pool.stat().failed).toBe(1);
    pool.dispose();
  });

  it('propagates an inline executor throw as a rejection', async () => {
    const pool = createWorkerPool({
      workerAvailable: false,
      fallback: () => {
        throw new RangeError('bad column');
      },
    });
    await expect(pool.submit({ fn: 'sort' })).rejects.toThrow(/bad column/);
    expect(pool.stat().failed).toBe(1);
    pool.dispose();
  });
});

describe('WorkerPool stat and disposal', () => {
  it('reports latency percentiles over completed tasks', async () => {
    const farm = new FakeWorkerFarm();
    const latency = [5, 5, 5, 5, 5, 5, 5, 5, 5, 400];
    let index = 0;
    let clock = 0;
    const pool = makePool(farm, {
      maxWorker: 1,
      adaptive: false,
      now: () => {
        // Alternating start/end pairs: end - start is the scripted latency.
        const isStart = index % 2 === 0;
        const value = isStart ? clock : clock + (latency[(index - 1) / 2] ?? 0);
        index++;
        if (!isStart) clock = value;
        return value;
      },
    });
    const task = Array.from({ length: 10 }, () => pool.submit({ fn: 'sort' }));
    await farm.settleAll();
    await Promise.all(task);
    const stat = pool.stat();
    expect(stat.completed).toBe(10);
    expect(stat.p95LatencyMs).toBe(400);
    expect(stat.meanLatencyMs).toBeCloseTo(44.5, 5);
    expect(stat.active).toBe(0);
    expect(stat.queued).toBe(0);
    expect(stat.idleWorker).toBe(1);
    pool.dispose();
  });

  it('counts worker-side failures without stalling the queue', async () => {
    const farm = new FakeWorkerFarm();
    const pool = makePool(farm, { maxWorker: 1, adaptive: false });
    const bad = pool.submit({ fn: 'sort' });
    const good = pool.submit({ fn: 'sort' });
    await farm.failNext('column "nope" is unknown');
    await expect(bad).rejects.toThrow(/column "nope" is unknown/);
    await farm.settleAll();
    await expect(good).resolves.toBe('ok');
    expect(pool.stat().failed).toBe(1);
    expect(pool.stat().completed).toBe(1);
    pool.dispose();
  });

  it('rejects queued work and terminates every worker on dispose', async () => {
    const farm = new FakeWorkerFarm();
    const pool = makePool(farm, { maxWorker: 1, adaptive: false });
    const running = pool.submit({ fn: 'a' });
    const queued = pool.submit({ fn: 'b' });
    pool.dispose();
    await expect(queued).rejects.toThrow(/OG_POOL_DISPOSED/);
    await expect(running).rejects.toThrow(/OG_WORKER_DISPOSED/);
    expect(farm.spawned[0]!.terminated).toBe(true);
    await expect(pool.submit({ fn: 'c' })).rejects.toThrow(/OG_POOL_DISPOSED/);
  });
});
