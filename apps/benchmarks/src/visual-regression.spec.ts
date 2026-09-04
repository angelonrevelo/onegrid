// =============================================================================
// Visual regression — pixel diff against checked-in baseline screenshots.
//
// Chromium-only by default. Cross-browser rendering differs by enough
// pixels that a single baseline can't pass all three; if you want
// per-browser baselines, copy this spec into a webkit/firefox-specific
// variant or use Playwright's `{ projects: [{ name: 'chromium-visual', ... }] }`
// pattern with separate snapshot dirs.
//
// Snapshots live in apps/benchmarks/src/<spec>-snapshots/. First run
// creates them with `--update-snapshots`; subsequent runs assert.
//
// We deliberately mask the .meter region (FPS / draw-ms / visible
// counters) because its content changes every frame and would
// produce false positives. Masking accepts whatever's there.
// =============================================================================

import { expect, test } from '@playwright/test';
import './types';

// Snapshots are chromium-darwin baselines (rendering differs cross-browser
// and cross-OS). Skip elsewhere rather than inventing a Windows baseline.
test.skip(
  ({ browserName }) => browserName !== 'chromium' || process.platform !== 'darwin',
  'visual regression — chromium-darwin baselines only',
);

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => window.__onegrid !== undefined);
  // Let the initial paint settle.
  await page.waitForTimeout(300);
});

test('memory mode @ top of dataset matches baseline', async ({ page }) => {
  await page.evaluate(() => window.__onegrid?.setMode?.('memory'));
  await page.waitForFunction(() => window.__onegrid?.getMode?.() === 'memory');
  await page.waitForTimeout(400);

  await expect(page).toHaveScreenshot('memory-top.png', {
    fullPage: false,
    // Mask the live perf meter — it changes every frame.
    mask: [page.locator('.meter')],
    // Some pixel drift is acceptable (font sub-pixel anti-aliasing,
    // tiny animation states). Keep this tight enough to catch real
    // regressions but loose enough to not flake.
    maxDiffPixelRatio: 0.01,
  });
});

test('memory mode after sort desc by revenue matches baseline', async ({ page }) => {
  await page.evaluate(() => window.__onegrid?.setMode?.('memory'));
  await page.waitForFunction(() => window.__onegrid?.getMode?.() === 'memory');
  await page.waitForTimeout(300);
  await page.evaluate(() =>
    window.__onegrid?.setSort([{ columnId: 'revenue', direction: 'desc' }]),
  );
  await page.waitForTimeout(500);

  await expect(page).toHaveScreenshot('memory-sorted-desc.png', {
    mask: [page.locator('.meter')],
    maxDiffPixelRatio: 0.01,
  });
});

test('formula mode initial paint matches baseline', async ({ page }) => {
  await page.evaluate(() => window.__onegrid?.setMode?.('formula'));
  await page.waitForFunction(() => window.__onegrid?.getMode?.() === 'formula');
  await page.waitForTimeout(400);

  await expect(page).toHaveScreenshot('formula-initial.png', {
    mask: [page.locator('.meter')],
    maxDiffPixelRatio: 0.01,
  });
});

test('pivot mode initial paint matches baseline', async ({ page }) => {
  await page.evaluate(() => window.__onegrid?.setMode?.('pivot'));
  await page.waitForFunction(() => window.__onegrid?.getMode?.() === 'pivot');
  await page.waitForTimeout(400);

  await expect(page).toHaveScreenshot('pivot-initial.png', {
    mask: [page.locator('.meter')],
    maxDiffPixelRatio: 0.01,
  });
});

test('tree mode initial paint matches baseline', async ({ page }) => {
  await page.evaluate(() => window.__onegrid?.setMode?.('tree'));
  await page.waitForFunction(() => window.__onegrid?.getMode?.() === 'tree');
  await page.waitForTimeout(400);

  await expect(page).toHaveScreenshot('tree-initial.png', {
    mask: [page.locator('.meter')],
    maxDiffPixelRatio: 0.01,
  });
});
