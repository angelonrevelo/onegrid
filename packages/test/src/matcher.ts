// =============================================================================
// Vitest matchers
//
// Three assertions cover what a grid test spends most of its time saying:
// a cell shows a value, a range is selected, the dataset is N rows.
//
// Design decisions:
//
//   1. `installGridMatcher` takes the `expect` object as an argument instead of
//      importing it. A library that imports `vitest` at module scope drags the
//      whole test runner into an adopter's dependency graph and breaks anyone
//      running the harness under Playwright's runner or vitest browser mode.
//      Passing `expect` in is the same narrow-injectable-interface pattern the
//      repo uses for SQL drivers.
//
//   2. Matchers read the ACCESSIBILITY SHADOW for values, not the row source.
//      Asserting against the row source proves the fixture is what the fixture
//      is; asserting against the shadow proves the grid rendered it — column
//      formatters, windowing and all.
//
//   3. Failure messages print the surrounding rendered rows. See the same
//      argument in `expectGridToMatch`: for a grid, the neighbours are the
//      diagnosis.
// =============================================================================

import type { GridTestHandle } from './mount';
import { getCellText, readGridWindow, resolveColumnIndex } from './query';
import type { ColumnRef } from './query';

/** A normalized, inclusive rectangle of cells. */
export interface ExpectedRange {
  readonly rowStart: number;
  readonly rowEnd: number;
  readonly colStart: number;
  readonly colEnd: number;
}

/** The result shape every matcher returns; matches vitest and jest. */
export interface MatcherResult {
  readonly pass: boolean;
  readonly message: () => string;
}

/** A registered matcher: a received value, then the arguments the assertion
 *  was called with, in exchange for a pass/message pair. */
export type MatcherImplementation = (...arg: unknown[]) => MatcherResult;

/**
 * The slice of `expect` this package needs. Declared with METHOD syntax on
 * purpose: TypeScript checks method parameters bivariantly, which is what
 * lets vitest's own richly-typed `extend` satisfy this deliberately loose
 * shape. Written as a property (`extend: (...) => void`) the contravariance
 * check rejects every real runner's `expect`.
 */
export interface ExpectWithExtend {
  extend(matcher: Record<string, MatcherImplementation>): void;
}

/**
 * Assertion methods added by {@link installGridMatcher}. Augment your runner's
 * `Assertion` interface with this to get types:
 *
 * ```ts
 * declare module 'vitest' {
 *   interface Assertion<T = any> extends GridMatcher<T> {}
 * }
 * ```
 *
 * @public
 */
export interface GridMatcher<R = unknown> {
  /** The cell at (row, column) renders exactly `value`. */
  toHaveGridValue: (row: number, column: ColumnRef, value: string) => R;
  /** The grid's selection is exactly one range covering `range`. */
  toHaveSelectedRange: (range: ExpectedRange) => R;
  /** The grid's row source reports `count` rows. */
  toHaveRowCount: (count: number) => R;
}

function renderWindow(handle: GridTestHandle): string {
  const window = readGridWindow(handle.host);
  if (window.text.length === 0) return '  (the accessibility shadow is empty)';
  return window.text
    .map((r, i) => `  row ${String(window.firstRow + i)}: ${r.join(' | ')}`)
    .join('\n');
}

function isHandle(value: unknown): value is GridTestHandle {
  return (
    typeof value === 'object' &&
    value !== null &&
    'grid' in value &&
    'host' in value &&
    'geometry' in value
  );
}

function requireHandle(received: unknown, matcher: string): GridTestHandle {
  if (!isHandle(received)) {
    throw new TypeError(
      `@onegrid/test: ${matcher} expects the handle returned by mountGrid(), ` +
        `received ${typeof received}.`,
    );
  }
  return received;
}

/**
 * The matcher implementations, exported unwrapped so a runner other than
 * vitest can register them under its own conventions.
 *
 * @public
 */
export const gridMatcher = {
  toHaveGridValue(received: unknown, row: number, column: ColumnRef, value: string): MatcherResult {
    const handle = requireHandle(received, 'toHaveGridValue');
    const index = resolveColumnIndex(handle.host, column);
    const actual = getCellText(handle.host, row, column);
    return {
      pass: actual === value,
      message: () =>
        actual === null
          ? `expected cell (row ${String(row)}, column ${JSON.stringify(column)}) to render ` +
            `${JSON.stringify(value)}, but that cell is not in the rendered window` +
            `${index < 0 ? ' (and no column matched that name)' : ''}.\n` +
            `Rendered grid:\n${renderWindow(handle)}`
          : `expected cell (row ${String(row)}, column ${JSON.stringify(column)}) to render ` +
            `${JSON.stringify(value)}, got ${JSON.stringify(actual)}.\n` +
            `Rendered grid:\n${renderWindow(handle)}`,
    };
  },

  toHaveSelectedRange(received: unknown, range: ExpectedRange): MatcherResult {
    const handle = requireHandle(received, 'toHaveSelectedRange');
    const snapshot = handle.grid.getSelection();
    const actual = snapshot.ranges.map((r) => ({
      rowStart: Math.min(r.anchor.row, r.active.row),
      rowEnd: Math.max(r.anchor.row, r.active.row),
      colStart: Math.min(r.anchor.col, r.active.col),
      colEnd: Math.max(r.anchor.col, r.active.col),
    }));
    const only = actual.length === 1 ? actual[0] : undefined;
    const pass =
      only !== undefined &&
      only.rowStart === range.rowStart &&
      only.rowEnd === range.rowEnd &&
      only.colStart === range.colStart &&
      only.colEnd === range.colEnd;
    const show = (r: ExpectedRange): string =>
      `rows ${String(r.rowStart)}..${String(r.rowEnd)} × cols ` +
      `${String(r.colStart)}..${String(r.colEnd)}`;
    return {
      pass,
      message: () =>
        actual.length === 0
          ? `expected the selection to be ${show(range)}, but nothing is selected.`
          : `expected the selection to be exactly one range ${show(range)}, got ` +
            `${String(actual.length)} range(s): ${actual.map(show).join('; ')}. ` +
            `Active cell: ${
              snapshot.active
                ? `(${String(snapshot.active.row)}, ${String(snapshot.active.col)})`
                : 'none'
            }.`,
    };
  },

  toHaveRowCount(received: unknown, count: number): MatcherResult {
    const handle = requireHandle(received, 'toHaveRowCount');
    const actual = handle.grid.getViewportInfo().numRows;
    return {
      pass: actual === count,
      message: () =>
        `expected the grid's row source to report ${String(count)} rows, got ` +
        `${String(actual)}.`,
    };
  },
};

/**
 * Register the grid matchers on a runner's `expect`. Call once, at the top of
 * a setup file:
 *
 * ```ts
 * import { expect } from 'vitest';
 * import { installGridMatcher } from '@onegrid/test';
 * installGridMatcher(expect);
 * ```
 *
 * @public
 */
export function installGridMatcher(expect: ExpectWithExtend): void {
  // The concrete matcher signatures are narrower than the registry's shared
  // shape; the runner supplies the arguments each one declares.
  expect.extend({ ...gridMatcher } as unknown as Record<string, MatcherImplementation>);
}
