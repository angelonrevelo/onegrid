// =============================================================================
// Performance: a billion rows in a real browser
//
// The unit test (packages/core/src/__tests__/billion-row.test.ts) proves the
// layout math in jsdom. This proves the thing a user sees, in Chromium with a
// real scroll container: mounting 1B rows costs no per-row memory, the last row
// is reachable exactly, a wheel notch moves rows rather than thousands of rows,
// and scrolling holds a frame rate — at 1B rows, not 10M.
//
// Numbers are printed as [bench] lines; the assertions are generous ceilings so
// a failure is a regression, not a slow CI box.
// =============================================================================

import { expect, test } from '@playwright/test';
import { selectMode } from './mode';
import './types';

const BILLION = 1_000_000_000;

test.describe('memory mode · 1B rows', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', 'performance.memory is Chromium-only');

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => window.__onegrid !== undefined);
    await selectMode(page, 'memory');
  });

  test('mounts, seeks exactly, wheels by rows and scrolls smoothly', async ({ page }) => {
    const heapBefore = await page.evaluate(
      () => (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0,
    );
    const mountStart = Date.now();
    await page.evaluate((n) => window.__onegrid?.setRows(n), BILLION);
    await page.waitForFunction((n) => window.__onegrid?.getViewportInfo().numRows === n, BILLION, {
      timeout: 30_000,
    });
    const mountMs = Date.now() - mountStart;
    const heapAfter = await page.evaluate(
      () => (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0,
    );

    // Exact seek, top to bottom.
    const seek = await page.evaluate((n) => {
      const og = window.__onegrid!;
      const out: Array<[number, number]> = [];
      for (const row of [0, 123_456_789, 500_000_000, n - 1]) {
        og.scrollToRow(row);
        out.push([row, og.getViewportInfo().firstVisibleRow]);
      }
      return out;
    }, BILLION);

    // A real wheel notch in the middle of the dataset.
    await page.evaluate(() => window.__onegrid?.scrollToRow(500_000_000));
    const box = await page.evaluate(() => {
      const r = window.__onegrid!.host.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    await page.mouse.move(box.x, box.y);
    const beforeWheel = await page.evaluate(() => window.__onegrid!.getViewportInfo().firstVisibleRow);
    await page.mouse.wheel(0, 100);
    await page.waitForTimeout(250);
    const afterWheel = await page.evaluate(() => window.__onegrid!.getViewportInfo());

    // Sustained scroll at 1B rows.
    await page.evaluate(() => window.__onegrid?.reset());
    await page.evaluate(async () => {
      const start = performance.now();
      await new Promise<void>((resolve) => {
        const step = (): void => {
          window.__onegrid?.scrollBy(120);
          if (performance.now() - start < 3_000) requestAnimationFrame(step);
          else resolve();
        };
        requestAnimationFrame(step);
      });
    });
    const metric = await page.evaluate(() => window.__onegrid!.getMetrics());

    console.log(
      `[bench] 1B rows: mount ${String(mountMs)} ms, heap +${((heapAfter - heapBefore) / 1024 / 1024).toFixed(1)} MB, ` +
        `scale ${afterWheel.scrollScale.toFixed(0)}, wheel(100px) moved ${String(afterWheel.firstVisibleRow - beforeWheel)} rows, ` +
        `fps p50 ${(1000 / metric.intervalMsP50).toFixed(1)}, long>50ms ${String(metric.longFramesGt50)}`,
    );

    expect(mountMs).toBeLessThan(10_000);
    // Per-row storage would be ≥ 4 GB; the tab would not survive to measure it.
    expect(heapAfter - heapBefore).toBeLessThan(200 * 1024 * 1024);
    for (const [want, got] of seek) expect(got).toBe(want);
    expect(afterWheel.scrollScale).toBeGreaterThan(100);
    // One notch is a handful of rows, not thousands.
    expect(afterWheel.firstVisibleRow - beforeWheel).toBeGreaterThan(0);
    expect(afterWheel.firstVisibleRow - beforeWheel).toBeLessThan(20);
    expect(1000 / metric.intervalMsP50).toBeGreaterThan(30);
  });
});
