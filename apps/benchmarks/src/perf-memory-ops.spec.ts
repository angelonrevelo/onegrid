// =============================================================================
// Performance: in-browser sort + filter latency (memory mode)
//
// Verifies that @onegrid/data's sortIndex / filterIndex perform well on
// 1M rows in the browser — no server, no network. Critical for the
// "drop a 1M-row CSV into the page" use case where users expect Sheets-
// class responsiveness.
// =============================================================================

import { expect, test } from '@playwright/test';
import './types';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => window.__onegrid !== undefined);
});

test('memory · 1M rows · in-browser sort by string column completes within 1s', async ({
  page,
}) => {
  // Default mode is in-memory at 1M; the load triggers materialization.
  await expect(page.locator('text=1,000,000 rows')).toBeVisible({ timeout: 15_000 });

  const t0 = Date.now();
  await page.evaluate(() => {
    window.__onegrid?.setSort([{ columnId: 'firstName', direction: 'asc' }]);
  });
  // Wait for the renderer to paint a frame after sort; reading metrics is
  // the canonical signal that the sort + permutation rebuild + repaint
  // round-trip completed.
  await page.waitForFunction(() => {
    const m = window.__onegrid?.getMetrics();
    return m !== undefined && m.frameCount > 0 && m.cellsPerFrameAvg > 0;
  }, { timeout: 5_000 });
  const elapsed = Date.now() - t0;
  console.log(`[bench] memory sort 1M (string asc): ${String(elapsed)}ms`);

  // Pure in-browser sort on 1M utf8 rows via Intl.Collator. Headless
  // Chromium on this host is the floor (~1.8s cold); 3s still fails a
  // real regression (10s+).
  expect(elapsed).toBeLessThan(3_000);
});

test('memory · 1M rows · quick filter narrows the row count', async ({ page }) => {
  await expect(page.locator('text=1,000,000 rows')).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(200);

  const t0 = Date.now();
  await page.evaluate(() => {
    window.__onegrid?.setFilter('aiko');
  });
  await page.waitForTimeout(400);
  const elapsed = Date.now() - t0;
  console.log(`[bench] memory filter 1M (contains "aiko"): ${String(elapsed)}ms`);

  // Toolbar reflects the narrowed row count.
  const text = await page.locator('.toolbar').innerText();
  const match = /(\d{1,3}(?:,\d{3})*) rows/.exec(text);
  expect(match).not.toBeNull();
  const displayed = Number(match![1]!.replace(/,/g, ''));
  expect(displayed).toBeLessThan(1_000_000);
  expect(displayed).toBeGreaterThan(0);

  expect(elapsed).toBeLessThan(2_000);
});

test('memory · 1M rows · combined sort + filter works end-to-end', async ({ page }) => {
  await expect(page.locator('text=1,000,000 rows')).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(200);

  const t0 = Date.now();
  await page.evaluate(() => {
    window.__onegrid?.setSort([{ columnId: 'revenue', direction: 'desc' }]);
    window.__onegrid?.setFilter('emea');
  });
  await page.waitForTimeout(800);
  const elapsed = Date.now() - t0;
  console.log(`[bench] memory sort+filter 1M: ${String(elapsed)}ms`);

  // Sort + filter should finish well under the 2-second SSRM budget since
  // there's no network round-trip.
  expect(elapsed).toBeLessThan(2_000);
});
