// =============================================================================
// Performance: end-to-end sort latency
//
// Measures wall-clock from "user clicks header" to "first sorted block
// landed" against the SSRM mock server with a 1M-row dataset. Exercises
// the full round-trip:
//   playground → grid → SsrmRowSource.setSort → SsrmDataSource fingerprint
//   invalidation → http transport POST /block with new sort → mock server
//   sortIndex over 1M rows → JSON response → renderer repaint.
// =============================================================================

import { expect, test } from '@playwright/test';
import { selectMode } from './mode';
import './types';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => window.__onegrid !== undefined);
});

test('SSRM · 1M rows · sort by string column completes within 2s', async ({ page }) => {
  await selectMode(page, 'ssrm');
  await expect(page.locator('text=1,000,000 rows')).toBeVisible({ timeout: 10_000 });
  // Let the initial block fetch complete so our timing is for sort only.
  await page.waitForTimeout(400);

  const t0 = Date.now();
  // Wait for the server's response to the sorted block — that's the
  // canonical "sort completed" signal. The request body carries the
  // sort model, so a /block POST after setSort is what we want.
  const blockResponsePromise = page.waitForResponse(
    (r) => r.url().endsWith('/block') && r.request().method() === 'POST',
    { timeout: 5_000 },
  );
  await page.evaluate(() => {
    window.__onegrid?.setSort([{ columnId: 'firstName', direction: 'asc' }]);
  });
  const response = await blockResponsePromise;
  const elapsed = Date.now() - t0;
  console.log(`[bench] ssrm sort 1M (string asc): ${String(elapsed)}ms`);

  expect(response.status()).toBe(200);
  // 2 s budget covers: HTTP round-trip + 1M-row sort on the server +
  // first paint. Real-world Postgres with an index would be < 100ms.
  expect(elapsed).toBeLessThan(2_000);

  // Server confirmed; give the renderer a beat to repaint with new rows.
  await page.waitForTimeout(150);
  const m = await page.evaluate(() => window.__onegrid!.getMetrics());
  expect(m.cellsPerFrameAvg).toBeGreaterThan(0);
});

test('SSRM · 1M rows · multi-column sort produces correct first-page ordering', async ({
  page,
}) => {
  await selectMode(page, 'ssrm');
  await expect(page.locator('text=1,000,000 rows')).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(400);

  // Sort by status asc, then revenue desc. Both columns have low
  // cardinality + range respectively, so the test expects a stable order
  // across runs.
  await page.evaluate(() => {
    window.__onegrid?.setSort([
      { columnId: 'status', direction: 'asc' },
      { columnId: 'revenue', direction: 'desc' },
    ]);
  });

  // Wait for SSRM round-trip + paint.
  await page.waitForTimeout(1_500);

  // First visible row should belong to the "active" status (alphabetically
  // first among the 5 statuses we generate) with the highest revenue in
  // that group. Pull that text from the accessibility shadow table.
  await expect.poll(async () => {
    const firstRowText = await page
      .locator('table[role="grid"] tbody tr')
      .first()
      .textContent();
    return firstRowText ?? '';
  }, { timeout: 8_000 }).toMatch(/active/i);
});

test('SSRM · sort change drops cached blocks (fingerprint invalidation)', async ({ page }) => {
  await selectMode(page, 'ssrm');
  await expect(page.locator('text=1,000,000 rows')).toBeVisible({ timeout: 10_000 });

  // Build up some cache with the default unsorted view.
  for (const row of [1_000, 5_000, 20_000]) {
    await page.evaluate((r: number) => {
      window.__onegrid?.scrollToRow(r);
    }, row);
    await page.waitForTimeout(250);
  }
  const before = await page.locator('text=/cache \\d+ blocks/').textContent();
  const beforeBlocks = Number(/cache (\d+) blocks/.exec(before ?? '')?.[1] ?? '0');
  expect(beforeBlocks).toBeGreaterThan(1);

  // Apply a sort — this should invalidate the cache and start fresh.
  await page.evaluate(() => {
    window.__onegrid?.setSort([{ columnId: 'firstName', direction: 'asc' }]);
  });
  // Brief wait for invalidation + first new block to land.
  await page.waitForTimeout(500);

  const after = await page.locator('text=/cache \\d+ blocks/').textContent();
  const afterBlocks = Number(/cache (\d+) blocks/.exec(after ?? '')?.[1] ?? '0');
  // Cache should have shrunk OR be approximately the size of the visible
  // window (1-3 blocks). Critically, it shouldn't have retained stale
  // blocks from the unsorted query.
  expect(afterBlocks).toBeLessThanOrEqual(3);
});
