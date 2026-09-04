// =============================================================================
// SSRM-tree mode — real-Chromium gate.
//
// Asserts the v0.0.7 hierarchical SSRM extension works end-to-end:
//
//   1. Mode mounts with 3 collapsed roots (EMEA / Americas / APAC) fetched
//      from the localhost mock server's /block endpoint with parentId=null
//   2. Clicking a root chevron triggers a children fetch (parentId='r:emea')
//      and the flat row count grows once the response lands
//   3. Drilling into a country triggers a third fetch and the cities appear
//
// Reference: ROADMAP.md v0.0.7 item 3.
// =============================================================================

import { expect, test } from '@playwright/test';
import { selectMode } from './mode';
import './types';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => window.__onegrid !== undefined);
  await selectMode(page, 'ssrm-tree');
});

test('ssrm-tree mode mounts with 3 collapsed roots fetched from the server', async ({
  page,
}) => {
  const grid = page.locator('div[role="grid"]').first();
  await expect.poll(
    async () => Number((await grid.getAttribute('aria-rowcount')) ?? '0'),
    { timeout: 5_000 },
  ).toBe(3);
});

test('expanding a root triggers a server fetch and reveals children', async ({
  page,
}) => {
  const grid = page.locator('div[role="grid"]').first();
  await expect.poll(
    async () => Number((await grid.getAttribute('aria-rowcount')) ?? '0'),
    { timeout: 5_000 },
  ).toBe(3);

  // SSRM-tree mode has header (32) only, no floating filter band.
  // Row 0 starts at y=32, height 28 → click at (12, 46) hits the
  // EMEA chevron at depth 0 (hit zone x∈[4,24]).
  await grid.click({ position: { x: 12, y: 46 } });

  // EMEA expanded → 3 roots + Germany + France = 5.
  await expect.poll(
    async () => Number((await grid.getAttribute('aria-rowcount')) ?? '0'),
    { timeout: 5_000 },
  ).toBe(5);
});

test('expanding a country fetches grandchildren', async ({ page }) => {
  const grid = page.locator('div[role="grid"]').first();
  await expect.poll(
    async () => Number((await grid.getAttribute('aria-rowcount')) ?? '0'),
    { timeout: 5_000 },
  ).toBe(3);

  // Expand EMEA root (depth 0 chevron, y=46).
  await grid.click({ position: { x: 12, y: 46 } });
  await expect.poll(
    async () => Number((await grid.getAttribute('aria-rowcount')) ?? '0'),
    { timeout: 5_000 },
  ).toBe(5);

  // Expand Germany (depth 1 chevron). Row 1 starts at y=32+28=60,
  // depth 1 chevron hit zone x∈[20,40] → click (28, 74).
  await grid.click({ position: { x: 28, y: 74 } });

  // Germany has 2 cities → 5 + 2 = 7.
  await expect.poll(
    async () => Number((await grid.getAttribute('aria-rowcount')) ?? '0'),
    { timeout: 5_000 },
  ).toBe(7);
});
