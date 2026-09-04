// =============================================================================
// Smoke tests: does the playground actually work end-to-end?
//
// These don't measure performance — they just verify the wire-up. Run on
// every PR to catch regressions in the canvas renderer, the SSRM transport,
// the row source bridge, and the React adapter all at once.
// =============================================================================

import { expect, test } from '@playwright/test';
import { selectMode } from './mode';
import './types';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  // Wait for the playground harness to expose its imperative hooks.
  await page.waitForFunction(() => window.__onegrid !== undefined);
});

test('in-memory mode renders rows on first paint', async ({ page }) => {
  const meter = page.locator('.meter');
  await expect(meter.locator('text=visible')).toBeVisible();

  // Grid only records frames when something changes. Nudge the scroll
  // a few times so we get frame samples.
  for (let i = 0; i < 8; i++) {
    await page.evaluate(() => {
      window.__onegrid?.scrollBy(50);
    });
    await page.waitForTimeout(30);
  }

  const stats = await page.evaluate(() => window.__onegrid!.getMetrics());
  expect(stats.frameCount).toBeGreaterThan(5);
  expect(stats.cellsPerFrameAvg).toBeGreaterThan(0);
});

test('switching to SSRM connects and shows the row count from the server', async ({
  page,
}) => {
  await selectMode(page, 'ssrm');

  // Toolbar reports the row count delivered by the mock server's probe block.
  await expect(page.locator('text=1,000,000 rows')).toBeVisible({ timeout: 10_000 });

  // Scroll a few times so frames are recorded. cellsPerFrameAvg > 0 proves
  // the canvas actually drew something — regression guard against the
  // 0-height host bug.
  for (let i = 0; i < 8; i++) {
    await page.evaluate(() => {
      window.__onegrid?.scrollBy(50);
    });
    await page.waitForTimeout(30);
  }

  const stats = await page.evaluate(() => window.__onegrid!.getMetrics());
  expect(stats.frameCount).toBeGreaterThan(5);
  expect(stats.cellsPerFrameAvg).toBeGreaterThan(0);
});

test('scrolling SSRM grid triggers new block fetches (cache grows)', async ({ page }) => {
  await selectMode(page, 'ssrm');
  await expect(page.locator('text=1,000,000 rows')).toBeVisible({ timeout: 10_000 });

  // Initial render fetches block 0 → cache 1 block
  await expect(page.locator('text=cache 1 blocks')).toBeVisible({ timeout: 5_000 });

  // Scroll deep into the dataset; SSRM should fetch new blocks.
  await page.evaluate(() => {
    window.__onegrid?.scrollToRow(5000);
  });
  await page.waitForTimeout(800);

  await page.evaluate(() => {
    window.__onegrid?.scrollToRow(50_000);
  });
  await page.waitForTimeout(800);

  // Verify the toolbar's "cache N blocks" counter advanced beyond 1.
  // Read the text instead of waiting for an exact number — different scroll
  // speeds and viewports change the exact count.
  const cacheText = await page.locator('text=/cache \\d+ blocks/').textContent();
  expect(cacheText).toBeTruthy();
  const match = cacheText!.match(/cache (\d+) blocks/);
  expect(match).toBeTruthy();
  const blocks = Number(match![1]);
  expect(blocks).toBeGreaterThan(1);
});

test('Cmd/Ctrl+A then Cmd/Ctrl+C selects all rows without errors', async ({
  page,
}) => {
  // The scroll host (role=grid) overlays the canvas — that's the actual
  // focus target, not the canvas. Clicking it focuses keyboard input.
  await expect(page.locator('text=visible')).toBeVisible();
  // Overlay/canvas children intercept a normal click on the scroll host.
  // Focus the mounted host so Cmd/Ctrl+A reaches the grid.
  await page.evaluate(() => {
    window.__onegrid?.host?.focus();
  });
  const focused = await page.evaluate(() => document.activeElement?.id ?? '');
  if (!focused) {
    await page.locator('div[role="grid"]').first().click({ force: true });
  }

  // Track JS errors during the keyboard interaction.
  const errors: string[] = [];
  page.on('pageerror', (err) => {
    errors.push(err.message);
  });

  await page.keyboard.press('Meta+a');
  await page.waitForTimeout(150);
  await page.keyboard.press('Meta+c');
  await page.waitForTimeout(150);

  expect(errors).toHaveLength(0);
});
