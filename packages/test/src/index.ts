// =============================================================================
// @onegrid/test
//
// The testing toolkit an ADOPTER uses to test their own grid-based UI. Not a
// test suite for oneGrid — a library of utilities that makes a real `Grid`
// assertable from a plain vitest + jsdom run, with no browser and no native
// canvas build.
//
// The four problems it solves, in the order an adopter hits them:
//
//   1. THE GRID WILL NOT MOUNT. jsdom returns `null` from
//      `getContext('2d')`, and @onegrid/core dereferences the context in its
//      constructor. `installCanvasStub()` supplies a recording fake covering
//      exactly the Canvas-2D surface core calls, with a deterministic
//      `measureText` so layout is reproducible across machines. Because it
//      records an ordered call log, "did the header get painted before the
//      cells" is an assertion rather than a guess.
//
//   2. THERE IS NOTHING TO QUERY. The grid paints to a canvas, so
//      `getByText` has no target — except that core also maintains a
//      `<table role="grid">` accessibility shadow. That shadow is the query
//      surface: `getCell`, `getRowElement`, `getHeader`, `readGridText`,
//      `expectGridToMatch`. Asserting there means asserting on what a screen
//      reader would report, which is the strictest available definition of
//      "the grid rendered it".
//
//   3. EVERYTHING IS ASYNCHRONOUS AND THE FAILURES ARE MUTE. `waitForBlock`,
//      `waitForRender` and `waitForIdle` are timeout-bounded and each fails
//      with what it was waiting for AND the state it actually observed — the
//      request log, the frame count, the pending queue.
//
//   4. REAL DATA SOURCES ARE RACY. `createFakeRowSource` and
//      `createFakeDataSource` generate deterministic values and, crucially,
//      let the test own the clock: `manual: true` parks every fetch until
//      `flush()`, which is the only reliable way to assert on a loading state.
//
// Everything above composes through `installGridEnvironment()` +
// `mountGrid()`, which mount a real `Grid` into a sized, document-attached
// host. The user-event helpers then replay the exact DOM sequences core's
// listeners are bound to — pointerdown on the scroll host, pointerup on the
// window, focus-gated keydown, a hand-built `clipboardData` for paste.
//
// Zero runtime dependencies outside the workspace. `vitest` is NOT imported;
// `installGridMatcher(expect)` takes the runner's `expect` as an argument so
// the harness works unchanged under vitest browser mode or a Playwright
// component runner.
// =============================================================================

/** @public */
export { installCanvasStub } from './canvas-stub';
/** @public */
export type {
  CanvasCall,
  CanvasStubHandle,
  CanvasStubOption,
  RecordingContext2D,
} from './canvas-stub';

/** @public */
export { installGridEnvironment, mountGrid, setElementRect } from './mount';
/** @public */
export type {
  ClientPoint,
  GridEnvironmentHandle,
  GridEnvironmentOption,
  GridGeometry,
  GridTestHandle,
  MountGridOption,
} from './mount';

/** @public */
export {
  expectGridToMatch,
  getCell,
  getCellText,
  getHeader,
  getHeaderText,
  getRowElement,
  readGridText,
  readGridWindow,
  resolveColumnIndex,
} from './query';
/** @public */
export type { ColumnRef, GridMatchOption, GridWindow } from './query';

/** @public */
export { waitForBlock, waitForIdle, waitForRender } from './wait';
/** @public */
export type {
  BlockWaitTarget,
  FrameWaitTarget,
  IdleWaitOption,
  WaitOption,
} from './wait';

/** @public */
export { createFakeDataSource, createFakeRowSource } from './fake';
/** @public */
export type {
  FakeBlockCall,
  FakeDataSourceHandle,
  FakeDataSourceOption,
  FakeRowSourceHandle,
  FakeRowSourceOption,
} from './fake';

/** @public */
export {
  clickCell,
  doubleClickCell,
  focusGrid,
  getCellEditor,
  pasteTsv,
  pressKey,
  selectRange,
  typeIntoCell,
} from './user-event';
/** @public */
export type { EventModifier, TypeIntoCellOption } from './user-event';

/** @public */
export { gridMatcher, installGridMatcher } from './matcher';
/** @public */
export type {
  ExpectedRange,
  ExpectWithExtend,
  GridMatcher,
  MatcherImplementation,
  MatcherResult,
} from './matcher';
