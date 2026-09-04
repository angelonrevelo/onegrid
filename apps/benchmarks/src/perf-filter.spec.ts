// =============================================================================
// Performance: end-to-end filter latency
//
// Same pattern as perf-sort.spec.ts — measures the wall-clock from typing
// a filter to the server's response with the narrowed result set. Also
// validates that the row count in the toolbar updates from server-supplied
// totalRowCount.
// =============================================================================

import { expect, test } from '@playwright/test';
import { selectMode } from './mode';
import './types';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => window.__onegrid !== undefined);
});

test('SSRM · 1M rows · quick filter completes within 1.5s and narrows row count', async ({
  page,
}) => {
  await selectMode(page, 'ssrm');
  await expect(page.locator('text=1,000,000 rows')).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(400);

  const t0 = Date.now();
  const blockResponsePromise = page.waitForResponse(
    (r) => r.url().endsWith('/block') && r.request().method() === 'POST',
    { timeout: 5_000 },
  );
  await page.evaluate(() => {
    // 'aiko' matches one cyclical first-name slot — narrows aggressively.
    window.__onegrid?.setFilter('aiko');
  });
  const response = await blockResponsePromise;
  const elapsed = Date.now() - t0;
  console.log(`[bench] ssrm filter 1M (contains "aiko"): ${String(elapsed)}ms`);

  expect(response.status()).toBe(200);
  expect(elapsed).toBeLessThan(1_500);

  // Server reports a narrower totalRowCount in the response payload.
  const body = (await response.json()) as { totalRowCount?: number };
  expect(body.totalRowCount).toBeLessThan(1_000_000);
  expect(body.totalRowCount).toBeGreaterThan(0);

  // Wait long enough for onUpdate → re-render to flush, then verify the
  // toolbar reflects the narrowed total.
  await page.waitForTimeout(800);
  const text = await page.locator('.toolbar').innerText();
  console.log(`[bench] toolbar after filter: ${text.replace(/\n/g, ' | ')}`);
  const match = /(\d{1,3}(?:,\d{3})*) rows/.exec(text);
  expect(match).not.toBeNull();
  const displayed = Number(match![1]!.replace(/,/g, ''));
  expect(displayed).toBeLessThan(1_000_000);
  expect(displayed).toBeGreaterThan(0);
});

test('SSRM · clearing filter restores 1M rows', async ({ page }) => {
  await selectMode(page, 'ssrm');
  await expect(page.locator('text=1,000,000 rows')).toBeVisible({ timeout: 10_000 });

  // Apply, then clear.
  await page.evaluate(() => {
    window.__onegrid?.setFilter('aiko');
  });
  await page.waitForTimeout(600);
  await page.evaluate(() => {
    window.__onegrid?.setFilter('');
  });
  await expect(page.locator('text=1,000,000 rows')).toBeVisible({ timeout: 5_000 });
});

test('SSRM · combined sort+filter completes within 2s', async ({ page }) => {
  await selectMode(page, 'ssrm');
  await expect(page.locator('text=1,000,000 rows')).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(400);

  const t0 = Date.now();
  const blockResponsePromise = page.waitForResponse(
    (r) => r.url().endsWith('/block') && r.request().method() === 'POST',
    { timeout: 5_000 },
  );
  await page.evaluate(() => {
    window.__onegrid?.setSort([{ columnId: 'firstName', direction: 'asc' }]);
    window.__onegrid?.setFilter('chen');
  });
  await blockResponsePromise;
  const elapsed = Date.now() - t0;
  console.log(`[bench] ssrm sort+filter 1M: ${String(elapsed)}ms`);

  expect(elapsed).toBeLessThan(2_000);
});
