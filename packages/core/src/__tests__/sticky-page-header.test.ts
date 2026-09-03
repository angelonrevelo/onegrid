import { describe, expect, it } from 'vitest';
import { resolveStickyHeader, stickyHeaderChanged } from '../sticky-page-header';

const base = { gridHeight: 1000, headerHeight: 32 };

describe('resolveStickyHeader', () => {
  it('is natural while the grid sits below the fold', () => {
    expect(resolveStickyHeader({ ...base, gridTop: 300 })).toEqual({
      mode: 'natural',
      offset: 0,
    });
  });

  it('is natural at the exact moment the grid top reaches the fold', () => {
    expect(resolveStickyHeader({ ...base, gridTop: 0 })).toEqual({
      mode: 'natural',
      offset: 0,
    });
  });

  it('sticks by exactly how far the grid has scrolled past the fold', () => {
    expect(resolveStickyHeader({ ...base, gridTop: -250 })).toEqual({
      mode: 'stuck',
      offset: 250,
    });
  });

  it('docks at the grid bottom instead of overhanging it', () => {
    // Scrolled 990 past, but the header can only travel 1000-32 = 968.
    expect(resolveStickyHeader({ ...base, gridTop: -990 })).toEqual({
      mode: 'docked',
      offset: 968,
    });
  });

  it('docks exactly at the boundary', () => {
    expect(resolveStickyHeader({ ...base, gridTop: -968 })).toEqual({
      mode: 'docked',
      offset: 968,
    });
  });

  it('accounts for a page-level fixed navbar', () => {
    // The usable viewport starts 64px down, so the grid is still natural at 64.
    expect(resolveStickyHeader({ ...base, gridTop: 64, viewportTop: 64 })).toEqual({
      mode: 'natural',
      offset: 0,
    });
    // At gridTop 0 it has scrolled 64 past the navbar.
    expect(resolveStickyHeader({ ...base, gridTop: 0, viewportTop: 64 })).toEqual({
      mode: 'stuck',
      offset: 64,
    });
  });

  it('never returns a negative offset for a grid shorter than its header', () => {
    const state = resolveStickyHeader({
      gridTop: -500,
      gridHeight: 20,
      headerHeight: 32,
    });
    expect(state.offset).toBe(0);
    expect(state.mode).toBe('docked');
  });
});

describe('stickyHeaderChanged', () => {
  it('always repaints the first frame', () => {
    expect(stickyHeaderChanged(null, { mode: 'natural', offset: 0 })).toBe(true);
  });

  it('repaints on a mode change even at the same offset', () => {
    expect(
      stickyHeaderChanged({ mode: 'stuck', offset: 10 }, { mode: 'docked', offset: 10 }),
    ).toBe(true);
  });

  it('repaints when the offset moves at least one device pixel', () => {
    expect(
      stickyHeaderChanged({ mode: 'stuck', offset: 10 }, { mode: 'stuck', offset: 11 }, 1),
    ).toBe(true);
  });

  it('skips a sub-pixel move', () => {
    expect(
      stickyHeaderChanged(
        { mode: 'stuck', offset: 10 },
        { mode: 'stuck', offset: 10.2 },
        1,
      ),
    ).toBe(false);
  });

  it('is more sensitive on a high-DPR display', () => {
    // At DPR 2 a half-CSS-pixel move IS a whole device pixel.
    expect(
      stickyHeaderChanged(
        { mode: 'stuck', offset: 10 },
        { mode: 'stuck', offset: 10.5 },
        2,
      ),
    ).toBe(true);
  });
});
