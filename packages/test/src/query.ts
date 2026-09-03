// =============================================================================
// Queries over the accessibility shadow
//
// The grid paints cells to a canvas, so there is no DOM node to query for a
// cell's text — except that @onegrid/core also maintains a parallel
// `<table role="grid">` shadow for screen readers, windowed to roughly the
// visible rows plus the active row. That shadow is the ONLY textual record of
// what the grid rendered, which makes it the natural query target: a test that
// asserts against it is asserting against exactly what an assistive technology
// user would hear.
//
// Design decisions:
//
//   1. Queries take the HOST element, not the Grid instance. The shadow is
//      plain DOM; keeping the queries DOM-shaped means an adopter can point
//      them at a grid mounted by their own framework wrapper without handing
//      over the Grid object.
//
//   2. A column may be addressed by index OR by header text. Index is what the
//      selection model speaks; header text is what a test author reads off the
//      screen. Supporting both removes a mental translation step that is a
//      reliable source of off-by-one bugs in grid tests.
//
//   3. Every lookup returns `null` rather than throwing. The shadow is
//      windowed, so "not present" is a legitimate, common answer for an
//      off-screen row — an exception there would be indistinguishable from a
//      genuine failure. `expectGridToMatch` is the one that throws, and it
//      throws with the full rendered grid in the message.
// =============================================================================

/** Address a column by zero-based index or by its rendered header text. */
export type ColumnRef = number | string;

/** Locate the `<table role="grid">` accessibility shadow inside a host. */
function shadowTable(host: HTMLElement): HTMLTableElement | null {
  // The scroll host also carries role="grid"; the shadow is the <table> one.
  return host.querySelector<HTMLTableElement>('table[role="grid"]');
}

/**
 * Resolve a {@link ColumnRef} to a zero-based column index using the shadow's
 * header row. Returns -1 when the name matches no header.
 *
 * @public
 */
export function resolveColumnIndex(host: HTMLElement, column: ColumnRef): number {
  if (typeof column === 'number') return column;
  const header = getHeaderText(host);
  return header.indexOf(column);
}

/**
 * The `<tr>` for a data row, or null when that row is outside the shadow's
 * window. `aria-rowindex` is 1-based and counts the header row, hence the +2.
 *
 * @public
 */
export function getRowElement(host: HTMLElement, row: number): HTMLTableRowElement | null {
  const table = shadowTable(host);
  if (!table) return null;
  return table.querySelector<HTMLTableRowElement>(
    `tbody tr[aria-rowindex="${String(row + 2)}"]`,
  );
}

/**
 * The `<td>` for a cell, or null when the row is outside the shadow window or
 * the column does not exist.
 *
 * @public
 */
export function getCell(
  host: HTMLElement,
  row: number,
  column: ColumnRef,
): HTMLTableCellElement | null {
  const rowEl = getRowElement(host, row);
  if (!rowEl) return null;
  const index = resolveColumnIndex(host, column);
  if (index < 0) return null;
  return rowEl.querySelectorAll('td')[index] ?? null;
}

/**
 * The rendered text of a cell, or null when the cell is not in the shadow.
 * This is the value an adopter almost always wants to assert on.
 *
 * @public
 */
export function getCellText(host: HTMLElement, row: number, column: ColumnRef): string | null {
  return getCell(host, row, column)?.textContent ?? null;
}

/**
 * The `<th>` for a column header, or null when the column does not exist.
 *
 * @public
 */
export function getHeader(host: HTMLElement, column: ColumnRef): HTMLTableCellElement | null {
  const table = shadowTable(host);
  if (!table) return null;
  const index = resolveColumnIndex(host, column);
  if (index < 0) return null;
  return table.querySelectorAll<HTMLTableCellElement>('thead th')[index] ?? null;
}

/**
 * Every header's text, left to right.
 *
 * @public
 */
export function getHeaderText(host: HTMLElement): string[] {
  const table = shadowTable(host);
  if (!table) return [];
  return Array.from(table.querySelectorAll('thead th'), (th) => th.textContent ?? '');
}

/**
 * The grid's rendered body as a 2D array of strings, row-major, covering the
 * shadow's current window. Row 0 of the result is the first row IN THE WINDOW,
 * which is row 0 of the dataset only while the grid is scrolled to the top —
 * use {@link readGridWindow} when the offset matters.
 *
 * @public
 */
export function readGridText(host: HTMLElement): string[][] {
  const table = shadowTable(host);
  if (!table) return [];
  return Array.from(table.querySelectorAll('tbody tr'), (tr) =>
    Array.from(tr.querySelectorAll('td'), (td) => td.textContent ?? ''),
  );
}

/** The dataset row indices the shadow currently covers, plus the text. */
export interface GridWindow {
  /** Dataset index of the first row present in the shadow. -1 when empty. */
  readonly firstRow: number;
  /** Dataset index of the last row present in the shadow. -1 when empty. */
  readonly lastRow: number;
  /** Row-major text, parallel to `firstRow..lastRow`. */
  readonly text: ReadonlyArray<ReadonlyArray<string>>;
}

/**
 * {@link readGridText} plus the dataset indices the window maps onto. Read the
 * indices off `aria-rowindex` rather than assuming the window starts at 0 —
 * the shadow re-anchors around the active cell when it is scrolled away.
 *
 * @public
 */
export function readGridWindow(host: HTMLElement): GridWindow {
  const table = shadowTable(host);
  if (!table) return { firstRow: -1, lastRow: -1, text: [] };
  const rowEl = Array.from(table.querySelectorAll('tbody tr'));
  if (rowEl.length === 0) return { firstRow: -1, lastRow: -1, text: [] };
  const indexOf = (tr: Element): number =>
    Number(tr.getAttribute('aria-rowindex') ?? '2') - 2;
  return {
    firstRow: indexOf(rowEl[0]!),
    lastRow: indexOf(rowEl[rowEl.length - 1]!),
    text: rowEl.map((tr) => Array.from(tr.querySelectorAll('td'), (td) => td.textContent ?? '')),
  };
}

/** Options for {@link expectGridToMatch}. */
export interface GridMatchOption {
  /**
   * Dataset row the first row of `expected` refers to. Default 0. Supplying it
   * lets a scrolled grid be asserted without recomputing the window offset by
   * hand.
   */
  readonly startRow?: number;
  /**
   * First column `expected` refers to. Default 0.
   */
  readonly startColumn?: number;
}

/**
 * Assert that the grid's rendered text matches `expected`, a row-major 2D
 * array. Only the region `expected` covers is compared, so a 2×2 fixture can
 * be checked against a 10 000-row grid.
 *
 * Throws an `Error` naming the first differing cell AND printing the whole
 * rendered window. A grid assertion that only says "expected 'b1' got 'b2'" is
 * nearly useless — the failure is usually that the grid is one row off, and
 * that is only visible with the surrounding rows in view.
 *
 * @public
 */
export function expectGridToMatch(
  host: HTMLElement,
  expected: ReadonlyArray<ReadonlyArray<string>>,
  option: GridMatchOption = {},
): void {
  const startRow = option.startRow ?? 0;
  const startColumn = option.startColumn ?? 0;
  const window = readGridWindow(host);

  const render = (): string =>
    window.text.length === 0
      ? '  (the accessibility shadow is empty — did the grid render?)'
      : window.text
          .map((r, i) => `  row ${String(window.firstRow + i)}: ${r.join(' | ')}`)
          .join('\n');

  for (let r = 0; r < expected.length; r++) {
    const expectedRow = expected[r];
    if (!expectedRow) continue;
    const datasetRow = startRow + r;
    const actualRow = window.text[datasetRow - window.firstRow];
    if (!actualRow) {
      throw new Error(
        `expectGridToMatch: row ${String(datasetRow)} is not in the rendered window ` +
          `(${String(window.firstRow)}..${String(window.lastRow)}).\n` +
          `Rendered grid:\n${render()}`,
      );
    }
    for (let c = 0; c < expectedRow.length; c++) {
      const datasetColumn = startColumn + c;
      const actual = actualRow[datasetColumn];
      const want = expectedRow[c];
      if (actual !== want) {
        throw new Error(
          `expectGridToMatch: cell (row ${String(datasetRow)}, column ` +
            `${String(datasetColumn)}) is ${JSON.stringify(actual ?? null)}, ` +
            `expected ${JSON.stringify(want)}.\nRendered grid:\n${render()}`,
        );
      }
    }
  }
}
