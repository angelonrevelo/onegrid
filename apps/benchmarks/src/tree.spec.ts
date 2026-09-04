// =============================================================================
// Tree-data mode — real-Chromium gate.
//
// Asserts the v0.0.7 hierarchical row model wires through the same
// getRowMeta / onToggleGroup path used by row grouping:
//
//   1. Tree mode renders 3 collapsed root nodes (EMEA / Americas / APAC)
//   2. Clicking a chevron expands and reveals children
//   3. Lazy-load: clicking a node with `loadChildren` runs the async
//      loader before flushing the open state
//
// Reference: ROADMAP.md v0.0.7 item 1.
// =============================================================================

import { expect, test } from '@playwright/test';
import { selectMode } from './mode';
import './types';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => window.__onegrid !== undefined);
  await selectMode(page, 'tree');
});

test('tree mode mounts with 3 collapsed roots', async ({ page }) => {
  const grid = page.locator('[role="grid"]').first();
  // 3 region rows visible.
  await expect(grid).toHaveAttribute('aria-rowcount', '3');
});

test('clicking a tree chevron expands and reveals children', async ({ page }) => {
  const grid = page.locator('[role="grid"]').first();
  // Tree mode header chrome: 32 (header) + 0 (no group band) + 0
  // (no floating filter) = 32. Row 0 starts at y=32, height 28 →
  // click at (8, 50) hits the EMEA chevron at depth 0.
  await grid.click({ position: { x: 8, y: 50 } });
  // EMEA expanded → 3 root rows + 2 EMEA children = 5.
  await expect.poll(
    async () => Number((await grid.getAttribute('aria-rowcount')) ?? '0'),
    { timeout: 5_000 },
  ).toBe(5);
});

test('lazy-loaded country fetches children on first expand', async ({ page }) => {
  const grid = page.locator('[role="grid"]').first();
  // Expand Americas (root index 1, y ≈ 32 + 28 = 60).
  await grid.click({ position: { x: 8, y: 75 } });
  await expect.poll(
    async () => Number((await grid.getAttribute('aria-rowcount')) ?? '0'),
    { timeout: 5_000 },
  ).toBe(5); // 3 roots + 2 Americas children (US + Brazil)

  // Brazil is the 2nd Americas child (y ≈ 32 + (1+2)*28 = 116).
  // It's at depth 1 → chevron hit zone is x in [16+4, 16+4+20].
  // Click at x=22, y=120 to hit Brazil's chevron.
  await grid.click({ position: { x: 22, y: 120 } });

  // Brazil's loadChildren has a 600ms delay. Wait for the rowcount
  // to grow (it should reach 7: 3 roots + 2 Americas + 2 Brazil cities).
  await expect.poll(
    async () => Number((await grid.getAttribute('aria-rowcount')) ?? '0'),
    { timeout: 5_000 },
  ).toBe(7);
});
