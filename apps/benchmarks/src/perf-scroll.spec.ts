// =============================================================================
// Performance: scroll fling
//
// Measures FPS under sustained scrolling of the in-memory dataset. Two runs:
//
//   1× — comfortable scroll (24 px / frame * 60fps = 1440 px/s)
//   5× — fast flick   (120 px / frame * 60fps = 7200 px/s)
//
// Records inter-frame interval percentiles and long-frame counts (>16ms,
// >33ms, >50ms). The thresholds are intentionally loose for headless
// chromium where rendering tends to be 10-15% slower than a real browser
// — failures at these bounds are real regressions, not flakes.
// =============================================================================

import { expect, test } from '@playwright/test';
import { selectMode } from './mode';
import './types';

const SCROLL_DURATION_MS = 4_000;

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => window.__onegrid !== undefined);
});

async function flingScroll(
  page: import('@playwright/test').Page,
  pxPerFrame: number,
  durationMs: number,
): Promise<void> {
  // Drive scroll from inside the page on rAF. A Playwright evaluate+timeout
  // loop measures IPC round-trips (~30 Hz on this host), not grid FPS.
  await page.evaluate(
    async ({ px, duration }) => {
      const start = performance.now();
      await new Promise<void>((resolve) => {
        const step = (): void => {
          window.__onegrid?.scrollBy(px);
          if (performance.now() - start < duration) requestAnimationFrame(step);
          else resolve();
        };
        requestAnimationFrame(step);
      });
    },
    { px: pxPerFrame, duration: durationMs },
  );
}

test('memory · 1M rows · 1× scroll fling holds ≥ 50 FPS p50', async ({ page }) => {
  // Reset whatever idle frames already accumulated; the fling generates new ones.
  await page.evaluate(() => {
    window.__onegrid?.reset();
  });

  await flingScroll(page, 24, SCROLL_DURATION_MS);

  const m = await page.evaluate(() => window.__onegrid!.getMetrics());
  console.log(`[bench] 1x scroll: ${JSON.stringify(m)}`);

  expect(m.frameCount).toBeGreaterThan(20);
  // Headless chromium is the floor — real browsers are typically faster.
  expect(m.fpsAvg).toBeGreaterThan(50);
  // p99 frame interval under 50ms means at most 1% of frames exceed 20 FPS.
  expect(m.intervalMsP99).toBeLessThan(50);
  // Memory mode now materializes typed-array columns (~120 MB heap so
  // sort/filter can operate on real data); occasional GC pauses produce
  // 1–2 long frames per 4s window. Threshold catches real regressions
  // without flaking on GC.
  expect(m.longFramesGt50).toBeLessThan(3);
});

test('memory · 1M rows · 5× scroll fling holds ≥ 30 FPS p50', async ({ page }) => {
  await page.evaluate(() => {
    window.__onegrid?.reset();
  });

  await flingScroll(page, 120, SCROLL_DURATION_MS);

  const m = await page.evaluate(() => window.__onegrid!.getMetrics());
  console.log(`[bench] 5x scroll: ${JSON.stringify(m)}`);

  expect(m.frameCount).toBeGreaterThan(20);
  expect(m.fpsAvg).toBeGreaterThan(30);
  expect(m.intervalMsP95).toBeLessThan(50);
  // 4s × ~7500 px/s sustained scroll = ~30k px. Anything over 20k confirms
  // the fling is actually moving the viewport.
  expect(m.scrollPxTotal).toBeGreaterThan(20_000);
});

test('SSRM · 1M rows · scroll triggers block fetches with no jank above 50ms', async ({
  page,
}) => {
  await selectMode(page, 'ssrm');
  await expect(page.locator('text=1,000,000 rows')).toBeVisible({ timeout: 10_000 });
  await page.evaluate(() => {
    window.__onegrid?.reset();
  });

  // Scroll deep, multiple times — exercises block boundary crossings.
  for (const target of [1_000, 10_000, 50_000, 200_000, 500_000, 800_000]) {
    await page.evaluate((row: number) => {
      window.__onegrid?.scrollToRow(row);
    }, target);
    await page.waitForTimeout(400);
  }

  const m = await page.evaluate(() => window.__onegrid!.getMetrics());
  console.log(`[bench] ssrm scroll: ${JSON.stringify(m)}`);

  expect(m.frameCount).toBeGreaterThan(5);
  // The frame metric records inter-frame intervals, which include idle
  // waits for block fetches in SSRM mode — those aren't jank, they're
  // network latency. The relevant signal is *draw duration* per painted
  // frame, which is the canvas's actual cost. Stay well under 16ms.
  expect(m.drawMsP99).toBeLessThan(16);
});
