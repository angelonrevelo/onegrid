// =============================================================================
// Range navigation history — browser-style back/forward within a huge sheet
//
// In a 10M-row grid, jumping to a named range, following a lookup, or landing
// on a find hit loses your place instantly, and there is no way back. Every
// browser solved this in 1994 and almost no grid has it.
//
// Design decisions, and why:
//
//   1. THE STACK HAS BROWSER SEMANTICS, NOT UNDO SEMANTICS. Navigating after
//      going back TRUNCATES the forward stack, exactly like following a link
//      after pressing Back. This is deliberately different from
//      `@onegrid/undo`, which models edits; conflating the two produces a
//      history that can move you to a place you never visited.
//
//   2. ADJACENT SMALL MOVES COALESCE. Arrow-keying across ten cells should not
//      cost ten Back presses. A push within `coalesceDistance` of the previous
//      entry, and within `coalesceWindowMs`, replaces it instead of stacking.
//      That is what makes Back land somewhere meaningful rather than one cell
//      up.
//
//   3. POSITIONS ARE STORED, NOT RESTORED. This module owns the stack and
//      hands back an entry; the caller scrolls and selects. Same split as
//      every other stateful helper in this repo — the grid owns the viewport,
//      the helper owns the semantics.
// =============================================================================

/** A visited location. `col` is a column INDEX, not an id, so it stays valid
 *  under column reorder — see `remapHistory` for the id-based alternative.
 *  @public */
export interface NavigationEntry {
  readonly row: number;
  readonly col: number;
  /** Optional range anchored at (row, col), when the visit selected a range. */
  readonly rowEnd?: number;
  readonly colEnd?: number;
  /** Optional human label for a history menu ("Find: 'invoice'", "Ctrl+End"). */
  readonly label?: string;
  /** Wall-clock push time. */
  readonly ts: number;
}

/** @public */
export interface NavigationHistoryOption {
  /** Max entries retained. Older entries drop FIFO. Default 50. */
  readonly maxDepth?: number;
  /**
   * Chebyshev distance in cells within which a new push REPLACES the previous
   * entry instead of stacking. Default 5.
   */
  readonly coalesceDistance?: number;
  /** Coalescing also requires the pushes be closer together than this, in ms.
   *  Default 1500. A pause means the user settled; that deserves an entry. */
  readonly coalesceWindowMs?: number;
  /** Notified after every mutation, for toolbar enable/disable state. */
  readonly onChange?: (state: NavigationState) => void;
  /** Injectable clock, so tests are not time-dependent. */
  readonly now?: () => number;
}

/** @public */
export interface NavigationState {
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly backCount: number;
  readonly forwardCount: number;
  readonly current: NavigationEntry | null;
}

/** @public */
export interface NavigationHistory {
  /** Record a visit. Truncates the forward stack, like a browser. */
  readonly push: (entry: Omit<NavigationEntry, 'ts'>) => void;
  /** Step back one entry, or null when there is nowhere to go. */
  readonly back: () => NavigationEntry | null;
  /** Step forward one entry, or null. */
  readonly forward: () => NavigationEntry | null;
  readonly state: () => NavigationState;
  readonly clear: () => void;
  /** The back stack, newest last — for rendering a history dropdown. */
  readonly entry: () => ReadonlyArray<NavigationEntry>;
}

const chebyshev = (a: NavigationEntry, b: Omit<NavigationEntry, 'ts'>): number =>
  Math.max(Math.abs(a.row - b.row), Math.abs(a.col - b.col));

/** @public */
export function createNavigationHistory(
  option: NavigationHistoryOption = {},
): NavigationHistory {
  const maxDepth = option.maxDepth ?? 50;
  const coalesceDistance = option.coalesceDistance ?? 5;
  const coalesceWindowMs = option.coalesceWindowMs ?? 1500;
  const now = option.now ?? (() => Date.now());

  /** Everything visited, oldest first. `cursor` indexes the current position. */
  let stack: NavigationEntry[] = [];
  let cursor = -1;

  const state = (): NavigationState => ({
    canGoBack: cursor > 0,
    canGoForward: cursor >= 0 && cursor < stack.length - 1,
    backCount: Math.max(0, cursor),
    forwardCount: Math.max(0, stack.length - 1 - cursor),
    current: cursor >= 0 ? (stack[cursor] ?? null) : null,
  });

  const notify = (): void => option.onChange?.(state());

  return {
    state,
    entry: () => stack.slice(0, cursor + 1),

    push: (partial) => {
      const ts = now();
      const current = cursor >= 0 ? stack[cursor] : undefined;

      // Coalesce a small, quick move into the entry we are standing on.
      if (
        current !== undefined &&
        ts - current.ts <= coalesceWindowMs &&
        chebyshev(current, partial) <= coalesceDistance
      ) {
        stack[cursor] = { ...partial, ts };
        notify();
        return;
      }

      // Browser semantics: navigating discards anything ahead of the cursor.
      stack = stack.slice(0, cursor + 1);
      stack.push({ ...partial, ts });

      if (stack.length > maxDepth) {
        stack.shift();
      }
      cursor = stack.length - 1;
      notify();
    },

    back: () => {
      if (cursor <= 0) return null;
      cursor--;
      notify();
      return stack[cursor] ?? null;
    },

    forward: () => {
      if (cursor < 0 || cursor >= stack.length - 1) return null;
      cursor++;
      notify();
      return stack[cursor] ?? null;
    },

    clear: () => {
      stack = [];
      cursor = -1;
      notify();
    },
  };
}
