// =============================================================================
// Async waits
//
// Three waits cover the three clocks a grid test races against: the block
// fetch (network), the render loop (rAF), and "everything has settled"
// (both, plus the grid's internal debounces).
//
// Design decisions:
//
//   1. Every wait polls on real macrotasks rather than draining a fake
//      scheduler. The grid mixes `requestAnimationFrame` with `setTimeout`
//      (the validator debounce is 100 ms) and resolves promises from data
//      sources; only a real timeline advances all three consistently. The
//      cost is wall-clock milliseconds, which is the right trade for a suite
//      that is measured in tens of tests.
//
//   2. A timeout produces a diagnostic, never a bare "timed out". The message
//      names what was awaited AND prints the state that was actually observed
//      — which blocks were requested, how many frames were painted, what the
//      pending queue held. A grid test that fails at 3 a.m. with "timeout"
//      costs an hour; the same test naming "block 4 never arrived; requested
//      [0, 1]; pending []" costs a minute.
//
//   3. The waits take narrow structural types, not concrete classes. Anything
//      with `getMetricsSnapshot()` can be waited on for a frame; anything with
//      `hasBlock` / `pending` / `call` can be waited on for a block. That
//      keeps them usable against an adopter's own instrumented wrapper.
// =============================================================================

/** Shared shape for every wait's timeout knobs. */
export interface WaitOption {
  /** Milliseconds before the wait gives up. Default 1000. */
  readonly timeoutMs?: number;
  /** Milliseconds between polls. Default 5. */
  readonly intervalMs?: number;
}

/** Minimum surface `waitForBlock` needs — satisfied by `FakeDataSourceHandle`. */
export interface BlockWaitTarget {
  readonly hasBlock: (index: number) => boolean;
  readonly pending: ReadonlyArray<number>;
  readonly call: ReadonlyArray<{ readonly blockIndex: number }>;
}

/** Minimum surface `waitForRender` / `waitForIdle` need — satisfied by `Grid`. */
export interface FrameWaitTarget {
  readonly getMetricsSnapshot: () => { readonly frameCount: number };
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Poll `predicate` until it is true or the budget runs out. On timeout it
 * throws with `describe()`'s snapshot of the world appended, so a failure
 * carries its own diagnosis.
 */
async function pollUntil(
  what: string,
  predicate: () => boolean,
  describe: () => string,
  option: WaitOption,
): Promise<void> {
  const timeoutMs = option.timeoutMs ?? 1000;
  const intervalMs = option.intervalMs ?? 5;
  const deadline = Date.now() + timeoutMs;
  // Check before the first sleep: a synchronous grid may already be done.
  if (predicate()) return;
  while (Date.now() < deadline) {
    await sleep(intervalMs);
    if (predicate()) return;
  }
  throw new Error(
    `@onegrid/test: timed out after ${String(timeoutMs)}ms waiting for ${what}.\n` +
      `Actual state: ${describe()}`,
  );
}

/**
 * Wait until block `index` has been fetched AND delivered by the data source.
 *
 * Fails with the full request log, which distinguishes the two failures that
 * look identical from the outside: the block was never requested (a scroll or
 * overscan bug) versus requested but never delivered (a source stuck in
 * `manual` mode with no `flush()`).
 *
 * @public
 */
export async function waitForBlock(
  source: BlockWaitTarget,
  index: number,
  option: WaitOption = {},
): Promise<void> {
  await pollUntil(
    `block ${String(index)} to be delivered`,
    () => source.hasBlock(index),
    () => {
      const requested = source.call.map((c) => c.blockIndex);
      const pending = [...source.pending];
      const detail =
        requested.includes(index)
          ? `block ${String(index)} WAS requested but never delivered — if the source is ` +
            'in manual mode, call flush()'
          : `block ${String(index)} was never requested at all`;
      return (
        `${detail}. requested blocks: [${requested.join(', ')}]; ` +
        `pending blocks: [${pending.join(', ')}]`
      );
    },
    option,
  );
}

/**
 * Wait until the grid paints at least one more frame than it had when this
 * was called. Use after any imperative change that only schedules a render
 * (`refresh`, `setSort`, `scrollBy`) and before reading the accessibility
 * shadow.
 *
 * @public
 */
export async function waitForRender(
  grid: FrameWaitTarget,
  option: WaitOption = {},
): Promise<void> {
  const before = grid.getMetricsSnapshot().frameCount;
  await pollUntil(
    'the grid to paint a frame',
    () => grid.getMetricsSnapshot().frameCount > before,
    () =>
      `frameCount is still ${String(grid.getMetricsSnapshot().frameCount)} ` +
      `(was ${String(before)} when the wait started). The grid never scheduled a ` +
      'render — check that the change actually dirtied it, and that ' +
      'installGridEnvironment() patched requestAnimationFrame.',
    option,
  );
}

/** Options for {@link waitForIdle}. */
export interface IdleWaitOption extends WaitOption {
  /**
   * Consecutive polls with an unchanged frame count before the grid counts as
   * idle. Default 3 — enough to ride out the one-frame gap between a scroll
   * settling and the follow-up repaint, cheap enough not to dominate a suite.
   */
  readonly quietPoll?: number;
}

/**
 * Wait until the grid stops painting: `quietPoll` consecutive polls with no
 * new frame. This is the wait to use after a scroll, a fill-handle drag, or
 * anything that produces a burst of frames whose length you do not want to
 * hard-code.
 *
 * @public
 */
export async function waitForIdle(
  grid: FrameWaitTarget,
  option: IdleWaitOption = {},
): Promise<void> {
  const timeoutMs = option.timeoutMs ?? 1000;
  const intervalMs = option.intervalMs ?? 5;
  const quietPoll = option.quietPoll ?? 3;
  const deadline = Date.now() + timeoutMs;
  let last = grid.getMetricsSnapshot().frameCount;
  let quiet = 0;
  while (Date.now() < deadline) {
    await sleep(intervalMs);
    const now = grid.getMetricsSnapshot().frameCount;
    if (now === last) {
      quiet++;
      if (quiet >= quietPoll) return;
    } else {
      quiet = 0;
      last = now;
    }
  }
  throw new Error(
    `@onegrid/test: timed out after ${String(timeoutMs)}ms waiting for the grid to go idle.\n` +
      `Actual state: it is still painting — frameCount reached ` +
      `${String(grid.getMetricsSnapshot().frameCount)} and never held still for ` +
      `${String(quietPoll)} consecutive ${String(intervalMs)}ms polls. Something is ` +
      're-arming the render loop every frame (an always-dirty flag, or an open cell editor).',
  );
}
