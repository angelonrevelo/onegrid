import { describe, expect, it } from 'vitest';
import { createNavigationHistory } from '../navigation-history';

/** Controllable clock so coalescing is tested by intent, not by wall time. */
function clock(start = 1000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

describe('createNavigationHistory', () => {
  it('starts empty and refuses to move', () => {
    const history = createNavigationHistory();
    expect(history.state()).toMatchObject({
      canGoBack: false,
      canGoForward: false,
      current: null,
    });
    expect(history.back()).toBeNull();
    expect(history.forward()).toBeNull();
  });

  it('walks back and forward through distant jumps', () => {
    const c = clock();
    const history = createNavigationHistory({ now: c.now });

    history.push({ row: 0, col: 0 });
    c.advance(5000);
    history.push({ row: 5000, col: 2 });
    c.advance(5000);
    history.push({ row: 900_000, col: 1 });

    expect(history.state().backCount).toBe(2);
    expect(history.back()).toMatchObject({ row: 5000, col: 2 });
    expect(history.back()).toMatchObject({ row: 0, col: 0 });
    expect(history.back()).toBeNull();

    expect(history.forward()).toMatchObject({ row: 5000, col: 2 });
    expect(history.forward()).toMatchObject({ row: 900_000, col: 1 });
    expect(history.forward()).toBeNull();
  });

  it('truncates the forward stack when navigating after going back', () => {
    const c = clock();
    const history = createNavigationHistory({ now: c.now });

    history.push({ row: 0, col: 0 });
    c.advance(5000);
    history.push({ row: 100, col: 0 });
    c.advance(5000);
    history.push({ row: 200, col: 0 });

    history.back();
    expect(history.state().canGoForward).toBe(true);

    c.advance(5000);
    history.push({ row: 999, col: 0 });

    // Browser semantics: row 200 is now unreachable.
    expect(history.state().canGoForward).toBe(false);
    expect(history.back()).toMatchObject({ row: 100 });
  });

  it('coalesces a small, quick move into the current entry', () => {
    const c = clock();
    const history = createNavigationHistory({ now: c.now, coalesceDistance: 5 });

    history.push({ row: 100, col: 0 });
    c.advance(100);
    history.push({ row: 102, col: 0 });
    c.advance(100);
    history.push({ row: 104, col: 0 });

    // Three arrow-key moves, one history entry.
    expect(history.state().backCount).toBe(0);
    expect(history.state().current).toMatchObject({ row: 104 });
  });

  it('does not coalesce once the user pauses', () => {
    const c = clock();
    const history = createNavigationHistory({
      now: c.now,
      coalesceDistance: 5,
      coalesceWindowMs: 1000,
    });

    history.push({ row: 100, col: 0 });
    c.advance(2000);
    history.push({ row: 102, col: 0 });

    expect(history.state().backCount).toBe(1);
  });

  it('does not coalesce a far jump even when it is fast', () => {
    const c = clock();
    const history = createNavigationHistory({ now: c.now, coalesceDistance: 5 });

    history.push({ row: 100, col: 0 });
    c.advance(10);
    history.push({ row: 90_000, col: 0 });

    expect(history.state().backCount).toBe(1);
  });

  it('measures coalescing distance on both axes', () => {
    const c = clock();
    const history = createNavigationHistory({ now: c.now, coalesceDistance: 3 });

    history.push({ row: 10, col: 0 });
    c.advance(50);
    // Same row, far column — Chebyshev distance is 40, so it must not coalesce.
    history.push({ row: 10, col: 40 });

    expect(history.state().backCount).toBe(1);
  });

  it('drops the oldest entry past maxDepth', () => {
    const c = clock();
    const history = createNavigationHistory({ now: c.now, maxDepth: 3 });

    for (let i = 0; i < 5; i++) {
      history.push({ row: i * 1000, col: 0 });
      c.advance(5000);
    }

    expect(history.entry()).toHaveLength(3);
    expect(history.entry()[0]).toMatchObject({ row: 2000 });
  });

  it('reports state changes to onChange', () => {
    const c = clock();
    const seen: number[] = [];
    const history = createNavigationHistory({
      now: c.now,
      onChange: (s) => seen.push(s.backCount),
    });

    history.push({ row: 0, col: 0 });
    c.advance(5000);
    history.push({ row: 500, col: 0 });
    history.back();

    expect(seen).toEqual([0, 1, 0]);
  });

  it('carries a label and range through the stack', () => {
    const history = createNavigationHistory();
    history.push({ row: 4, col: 1, rowEnd: 9, colEnd: 3, label: "Find: 'invoice'" });

    expect(history.state().current).toMatchObject({
      rowEnd: 9,
      colEnd: 3,
      label: "Find: 'invoice'",
    });
  });

  it('clears back to empty', () => {
    const c = clock();
    const history = createNavigationHistory({ now: c.now });
    history.push({ row: 1, col: 1 });
    c.advance(5000);
    history.push({ row: 2, col: 2 });

    history.clear();
    expect(history.state()).toMatchObject({ canGoBack: false, current: null });
    expect(history.entry()).toHaveLength(0);
  });
});
