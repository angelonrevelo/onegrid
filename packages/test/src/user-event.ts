// =============================================================================
// User-event helpers
//
// These replay the event sequences @onegrid/core actually listens for, read
// off its listener table rather than inferred from the UI:
//
//   pointerdown / pointermove / pointerup  on the role="grid" scroll host,
//                                          with pointerup bound to `window`
//   dblclick                               on the scroll host
//   keydown                                on `window`, gated on
//                                          `document.activeElement` being the
//                                          scroll host
//   paste                                  on `window`, same focus gate,
//                                          reading `clipboardData`
//   keydown / input                        on the editor <input>, which is a
//                                          SEPARATE listener from the grid's
//                                          window-level one
//
// Design decisions:
//
//   1. Pointer events are built from `MouseEvent` with `pointerId` grafted on.
//      jsdom ships no `PointerEvent` constructor; the listener only reads
//      clientX / clientY / the modifier flags / pointerId, and the dispatched
//      TYPE is what routes the event, so a MouseEvent is indistinguishable
//      from the grid's point of view.
//
//   2. Clicks land on the CENTRE of the target cell. The grid reserves the
//      rightmost and bottom-most 6 px of every cell for resize handles and the
//      bottom-right corner for the fill handle; a click on a cell's edge
//      silently enters a drag mode instead of selecting, which is a
//      spectacularly confusing test failure.
//
//   3. Keyboard helpers focus the scroll host first, unconditionally. The
//      grid's keydown handler returns immediately unless the scroll host holds
//      focus, so a helper that skips the focus call produces a test that
//      passes trivially by doing nothing at all.
//
//   4. `typeIntoCell` drives the real editor element rather than calling
//      `commitEdit()`. The value the grid commits is read off the input's
//      `.value`, and the debounced validator only runs on a real `input`
//      event, so an editing test that skips the DOM skips the half of the
//      pipeline most likely to break.
// =============================================================================

import type { GridTestHandle } from './mount';

/** Modifier keys any helper can carry. */
export interface EventModifier {
  readonly shiftKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
  readonly altKey?: boolean;
}

let nextPointerId = 1;

function pointerEvent(
  type: string,
  clientX: number,
  clientY: number,
  modifier: EventModifier,
  pointerId: number,
): MouseEvent {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX,
    clientY,
    button: 0,
    buttons: type === 'pointerup' ? 0 : 1,
    shiftKey: modifier.shiftKey ?? false,
    ctrlKey: modifier.ctrlKey ?? false,
    metaKey: modifier.metaKey ?? false,
    altKey: modifier.altKey ?? false,
  });
  Object.defineProperty(event, 'pointerId', { value: pointerId, configurable: true });
  Object.defineProperty(event, 'pointerType', { value: 'mouse', configurable: true });
  return event;
}

/**
 * Click a cell: pointerdown on the scroll host, pointerup on the window.
 * With `shiftKey` the grid extends the current range; with `ctrlKey` /
 * `metaKey` it adds a disjoint range.
 *
 * @public
 */
export function clickCell(
  handle: GridTestHandle,
  row: number,
  column: number,
  modifier: EventModifier = {},
): void {
  const point = handle.geometry.cellPoint(row, column);
  const pointerId = nextPointerId++;
  handle.scrollHost.dispatchEvent(
    pointerEvent('pointerdown', point.clientX, point.clientY, modifier, pointerId),
  );
  window.dispatchEvent(
    pointerEvent('pointerup', point.clientX, point.clientY, modifier, pointerId),
  );
}

/**
 * Drag-select from one cell to another: pointerdown at `from`, a pointermove
 * over `to`, then pointerup. This is the sequence a real drag produces, and it
 * exercises `extendActiveRange` rather than the imperative selection API.
 *
 * @public
 */
export function selectRange(
  handle: GridTestHandle,
  from: { readonly row: number; readonly col: number },
  to: { readonly row: number; readonly col: number },
): void {
  const start = handle.geometry.cellPoint(from.row, from.col);
  const end = handle.geometry.cellPoint(to.row, to.col);
  const pointerId = nextPointerId++;
  handle.scrollHost.dispatchEvent(
    pointerEvent('pointerdown', start.clientX, start.clientY, {}, pointerId),
  );
  handle.scrollHost.dispatchEvent(
    pointerEvent('pointermove', end.clientX, end.clientY, {}, pointerId),
  );
  window.dispatchEvent(pointerEvent('pointerup', end.clientX, end.clientY, {}, pointerId));
}

/**
 * Double-click a cell — the grid's open-the-editor gesture. Fires the
 * pointerdown/up pair first so selection lands on the cell, then the
 * `dblclick` the editor path listens for.
 *
 * @public
 */
export function doubleClickCell(handle: GridTestHandle, row: number, column: number): void {
  clickCell(handle, row, column);
  const point = handle.geometry.cellPoint(row, column);
  handle.scrollHost.dispatchEvent(
    new MouseEvent('dblclick', {
      bubbles: true,
      cancelable: true,
      clientX: point.clientX,
      clientY: point.clientY,
    }),
  );
}

/**
 * Focus the grid and send a keydown. `key` is a `KeyboardEvent.key` value —
 * `'ArrowDown'`, `'Enter'`, `'a'`, `'F2'`, `'Escape'`.
 *
 * @public
 */
export function pressKey(
  handle: GridTestHandle,
  key: string,
  modifier: EventModifier = {},
): void {
  focusGrid(handle);
  handle.scrollHost.dispatchEvent(
    new KeyboardEvent('keydown', {
      key,
      bubbles: true,
      cancelable: true,
      shiftKey: modifier.shiftKey ?? false,
      ctrlKey: modifier.ctrlKey ?? false,
      metaKey: modifier.metaKey ?? false,
      altKey: modifier.altKey ?? false,
    }),
  );
}

/**
 * Give the scroll host DOM focus. Every keyboard helper calls this; it is
 * exported because an adopter asserting focus management needs the same
 * starting state.
 *
 * @public
 */
export function focusGrid(handle: GridTestHandle): void {
  handle.scrollHost.focus();
  if (document.activeElement !== handle.scrollHost) {
    // jsdom refuses focus on elements without a tabindex; the grid sets one,
    // so this only trips if the host was detached from the document.
    throw new Error(
      '@onegrid/test: could not focus the grid. The host must be attached to ' +
        'document.body — mountGrid() does this for you.',
    );
  }
}

/**
 * Paste tab-separated text into the grid at the active cell. Dispatches a
 * `paste` event carrying a minimal `clipboardData` — jsdom implements neither
 * `ClipboardEvent` nor `DataTransfer`, and the grid only ever calls
 * `getData('text/plain')`.
 *
 * The grid does not write the values itself; it hands the parsed rows to
 * `onPaste`, so the test must supply that callback to observe anything.
 *
 * @public
 */
export function pasteTsv(handle: GridTestHandle, tsv: string): void {
  focusGrid(handle);
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', {
    configurable: true,
    value: {
      getData: (type: string): string => (type === 'text/plain' ? tsv : ''),
    },
  });
  window.dispatchEvent(event);
}

/** Options for {@link typeIntoCell}. */
export interface TypeIntoCellOption {
  /**
   * How the edit ends. `'Enter'` commits and moves down, `'Tab'` commits and
   * moves right, `'Escape'` discards, `'blur'` commits via focus loss, and
   * `false` leaves the editor open so a test can assert on validation state.
   * Default `'Enter'`.
   */
  readonly commit?: 'Enter' | 'Tab' | 'Escape' | 'blur' | false;
  /**
   * Open the editor by double-click (default) or by typing the first
   * character, which is the grid's type-ahead path and replaces the cell's
   * existing value.
   */
  readonly open?: 'dblclick' | 'typeahead';
}

/**
 * Find the live cell editor input. The grid gives it an `aria-errormessage`
 * pointing at the shared error bubble, which no other input it mounts has —
 * that attribute is the discriminator against floating-filter and find-bar
 * inputs living in the same host.
 *
 * @public
 */
export function getCellEditor(handle: GridTestHandle): HTMLInputElement | null {
  if (!handle.grid.isEditing()) return null;
  return handle.host.querySelector<HTMLInputElement>('input[aria-errormessage]');
}

/**
 * Open the editor on a cell, replace its text, and commit. Returns the editor
 * element when `commit: false` left it open, otherwise null.
 *
 * @public
 */
export function typeIntoCell(
  handle: GridTestHandle,
  row: number,
  column: number,
  text: string,
  option: TypeIntoCellOption = {},
): HTMLInputElement | null {
  const commit = option.commit ?? 'Enter';

  if (option.open === 'typeahead') {
    clickCell(handle, row, column);
    // Type-ahead needs a printable single character; the grid opens the
    // editor seeded with it, so the remainder is typed into the input.
    pressKey(handle, text.slice(0, 1) || ' ');
  } else {
    doubleClickCell(handle, row, column);
  }

  const editor = getCellEditor(handle);
  if (!editor) {
    throw new Error(
      `@onegrid/test: typeIntoCell(${String(row)}, ${String(column)}) did not open an ` +
        'editor. The grid only edits cells its `editable` option accepts, and the ' +
        'cell must be inside the visible viewport for the pointer hit-test to find it.',
    );
  }

  editor.value = text;
  editor.dispatchEvent(new Event('input', { bubbles: true }));

  if (commit === false) return editor;
  if (commit === 'blur') {
    editor.dispatchEvent(new FocusEvent('blur'));
    return null;
  }
  editor.dispatchEvent(
    new KeyboardEvent('keydown', { key: commit, bubbles: true, cancelable: true }),
  );
  return null;
}
