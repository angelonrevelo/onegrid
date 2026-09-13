// =============================================================================
// A billion rows — mount, seek and scroll without per-row storage.
//
// Rendering only ever paints the visible rows, so row count should cost nothing
// at mount. It did: a uniform rowHeight still allocated a Float32Array per row,
// a copy of it, and FenwickHeights' two Float64Arrays — ~24 GB at 1B rows. And
// once the scroll range is scaled (16 Mpx spacer standing in for 28 Gpx of
// content) one physical scrollbar pixel is ~1,750 content pixels, so a native
// wheel notch jumped thousands of rows and the browser's own late `scroll` event
// snapped every precise jump back to the nearest physical pixel.
//
// jsdom has no layout, so the two browser behaviours these tests depend on are
// stubbed deliberately: `offsetHeight` reads the inline style height, and
// `scrollTop` rounds to a whole physical pixel the way a real scroll container
// does.
// =============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Grid } from '../grid';
import type { ColumnDef, RowSource } from '../types';

const ROW_HEIGHT = 28;
const BILLION = 1_000_000_000;

const COLUMNS: ColumnDef[] = [
  { id: 'a', width: 120, displayName: 'A' },
  { id: 'b', width: 120, displayName: 'B' },
];

const physicalScrollTop = new WeakMap<Element, number>();
let restore: Array<() => void> = [];

function stubProperty(target: object, key: string, descriptor: PropertyDescriptor): void {
  const original = Object.getOwnPropertyDescriptor(target, key);
  Object.defineProperty(target, key, { configurable: true, ...descriptor });
  restore.push(() => {
    if (original) Object.defineProperty(target, key, original);
    else delete (target as Record<string, unknown>)[key];
  });
}

beforeEach(() => {
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) =>
    setTimeout(() => cb(performance.now()), 0) as unknown as number,
  );
  vi.stubGlobal('cancelAnimationFrame', (h: number) =>
    clearTimeout(h as unknown as ReturnType<typeof setTimeout>),
  );
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
  const noop = (): undefined => undefined;
  const ctxStub = new Proxy({} as Record<string, unknown>, {
    get: (store, key) => (key in store ? store[key as string] : noop),
    set: (store, key, value) => {
      store[key as string] = value;
      return true;
    },
  });
  stubProperty(HTMLCanvasElement.prototype, 'getContext', {
    value: () => ctxStub as unknown as CanvasRenderingContext2D,
  });
  stubProperty(Element.prototype, 'scrollTo', { value: () => undefined });
  stubProperty(HTMLElement.prototype, 'offsetHeight', {
    get(this: HTMLElement) {
      const h = Number.parseFloat(this.style.height);
      return Number.isFinite(h) ? h : 0;
    },
  });
  stubProperty(Element.prototype, 'scrollTop', {
    get(this: Element) {
      return physicalScrollTop.get(this) ?? 0;
    },
    set(this: Element, value: number) {
      physicalScrollTop.set(this, Math.max(0, Math.round(value)));
    },
  });
});

afterEach(() => {
  for (const undo of restore.reverse()) undo();
  restore = [];
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

function mount(
  numRows: number,
  extra: Partial<ConstructorParameters<typeof Grid>[0]> = {},
): { grid: Grid; scrollHost: HTMLElement } {
  const host = document.createElement('div');
  Object.defineProperty(host, 'clientWidth', { value: 800 });
  Object.defineProperty(host, 'clientHeight', { value: 600 });
  host.getBoundingClientRect = () =>
    ({ x: 0, y: 0, top: 0, left: 0, right: 800, bottom: 600, width: 800, height: 600, toJSON: () => ({}) }) as DOMRect;
  document.body.appendChild(host);
  const rowSource = {
    numRows,
    getCell: (row: number, columnId: string) => `${columnId}:${String(row)}`,
  } as unknown as RowSource;
  const grid = new Grid({ host, columns: COLUMNS, rowSource, rowHeight: ROW_HEIGHT, ...extra });
  const scrollHost = host.querySelector<HTMLElement>('[role="grid"]');
  if (!scrollHost) throw new Error('scroll host not found');
  return { grid, scrollHost };
}

describe('row count costs nothing at mount', () => {
  it('mounting 5M uniform-height rows allocates no per-row storage', () => {
    const before = process.memoryUsage().arrayBuffers;
    const { grid } = mount(5_000_000);
    const grew = process.memoryUsage().arrayBuffers - before;
    // Per-row storage would be ≥ 20 MB (one Float32Array) and was ~100 MB.
    expect(grew).toBeLessThan(8 * 1024 * 1024);
    grid.destroy();
  });

  it('mounts a billion rows and seeks to any of them exactly', () => {
    const { grid } = mount(BILLION);
    const info = grid.getViewportInfo();
    expect(info.numRows).toBe(BILLION);
    expect(info.totalHeight).toBe(BILLION * ROW_HEIGHT);
    for (const row of [0, 1, 123_456_789, 500_000_000, BILLION - 1]) {
      grid.scrollToRow(row);
      expect(grid.getViewportInfo().firstVisibleRow).toBe(row);
    }
    grid.destroy();
  });
});

describe('expanded rows on a uniform height', () => {
  it('an expanded detail row adds its height exactly, a billion rows deep', () => {
    const { grid } = mount(BILLION);
    const detailHeight = (grid as unknown as { detailHeight: number }).detailHeight;
    expect(detailHeight).toBeGreaterThan(0);
    grid.setExpanded([7, 999_999_000]);
    expect(grid.getViewportInfo().totalHeight).toBe(BILLION * ROW_HEIGHT + 2 * detailHeight);
    // Rows after an expanded one shift down by exactly one panel.
    grid.scrollToRow(999_999_001);
    expect(grid.getViewportInfo().scrollTop).toBe(999_999_001 * ROW_HEIGHT + 2 * detailHeight);
    expect(grid.getViewportInfo().firstVisibleRow).toBe(999_999_001);
    grid.setExpanded([]);
    expect(grid.getViewportInfo().totalHeight).toBe(BILLION * ROW_HEIGHT);
    grid.destroy();
  });
});

describe('sticky group rows deep in a large table', () => {
  interface StickyInternal {
    render: () => unknown;
    stickyGroupRowAt?: () => number | null;
  }

  it('one frame calls getRowMeta a bounded number of times, however deep the scroll', () => {
    // Measured in Chromium before the fix: an 800 ms frame at row 500M,
    // 100 % of it in drawStickyGroupRow walking back to row 0.
    let call = 0;
    const { grid } = mount(50_000_000, {
      getRowMeta: () => {
        call++;
        return null;
      },
    });
    grid.scrollToRow(25_000_000);
    call = 0;
    (grid as unknown as StickyInternal).render();
    // drawPinnedDataRows' own capped scan is 50K; the sticky lookup must not
    // add a walk proportional to the scroll depth on top of it.
    expect(call).toBeLessThan(100_000);
    grid.destroy();
  });

  it('converges to exactly what a full backward walk finds', () => {
    const n = 200_000;
    const every = 25_000;
    const isGroup = (row: number): boolean => row % every === 0;
    const { grid } = mount(n, {
      getRowMeta: (row) =>
        isGroup(row)
          ? { kind: 'group', depth: 0, label: `G${String(row)}`, path: `g${String(row)}`, expanded: true }
          : null,
    });
    const internal = grid as unknown as StickyInternal;
    expect(typeof internal.stickyGroupRowAt).toBe('function');

    const reference = (): number => {
      const info = grid.getViewportInfo();
      const topmost = info.firstVisibleRow;
      for (let r = topmost; r >= 0; r--) {
        if (!isGroup(r)) continue;
        return (r + 1) * ROW_HEIGHT <= info.scrollTop ? r : -1;
      }
      return -1;
    };

    for (const row of [0, 12, 24_999, 25_000, 25_010, 49_999, 99_999, 150_030, 199_999, 3, 175_000]) {
      grid.scrollToRow(row);
      let got = internal.stickyGroupRowAt!();
      // Unknown means "an unscanned region remains above"; each call extends
      // the scan by a bounded budget, so it must settle within a few frames.
      for (let frame = 0; got === null && frame < 20; frame++) got = internal.stickyGroupRowAt!();
      expect(got).toBe(reference());
    }
    grid.destroy();
  });
});

describe('scroll precision when the scroll range is scaled', () => {
  it('a late scroll event from the rounded scrollbar does not undo a precise jump', () => {
    const { grid, scrollHost } = mount(BILLION);
    expect(grid.getViewportInfo().scrollScale).toBeGreaterThan(100);
    grid.scrollToRow(500_000_123);
    // The browser fires `scroll` asynchronously, after the synchronous
    // suppress flag is long gone, carrying the rounded physical position.
    scrollHost.dispatchEvent(new Event('scroll'));
    expect(grid.getViewportInfo().firstVisibleRow).toBe(500_000_123);
    grid.destroy();
  });

  it('the wheel scrolls by content pixels, not scaled physical pixels', () => {
    const { grid, scrollHost } = mount(BILLION);
    grid.scrollToRow(1_000);
    const before = grid.getViewportInfo().scrollTop;
    const wheel = new WheelEvent('wheel', { deltaY: 3 * ROW_HEIGHT, deltaMode: 0, bubbles: true, cancelable: true });
    scrollHost.dispatchEvent(wheel);
    expect(wheel.defaultPrevented).toBe(true);
    expect(grid.getViewportInfo().scrollTop).toBe(before + 3 * ROW_HEIGHT);
    expect(grid.getViewportInfo().firstVisibleRow).toBe(1_003);
    scrollHost.dispatchEvent(new Event('scroll'));
    expect(grid.getViewportInfo().firstVisibleRow).toBe(1_003);
    grid.destroy();
  });

  it('the wheel is left to the browser when the scroll range is not scaled', () => {
    const { grid, scrollHost } = mount(1_000);
    expect(grid.getViewportInfo().scrollScale).toBe(1);
    const wheel = new WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true });
    scrollHost.dispatchEvent(wheel);
    expect(wheel.defaultPrevented).toBe(false);
    grid.destroy();
  });
});
