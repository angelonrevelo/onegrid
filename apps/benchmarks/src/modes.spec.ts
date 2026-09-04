// =============================================================================
// Mode switching — real-browser gates for each playground mode.
//
// Each of the five modes wires a different data source through the same
// renderer. A regression in any one of them used to be invisible at
// the unit level; this spec spawns the playground in real Chromium
// and asserts each mode renders cells through the standard
// `<td role="gridcell">` path.
//
// Modes: in-memory · SSRM (localhost:3001) · Formula · DuckDB · Pivot
// =============================================================================

import { expect, test } from '@playwright/test';
import { selectMode } from './mode';
import './types';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => window.__onegrid !== undefined);
});

test('default mode is in-memory and renders cells', async ({ page }) => {
  await expect(page.getByLabel('data source mode')).toHaveValue('memory');
  await expect(page.locator('[role="gridcell"]').first()).toBeVisible();
  // Status bar is the canonical "memory mode is alive" tell.
  await expect(page.getByText(/^no selection$|^count /)).toBeVisible();
});

test('switching to Formula renders the spreadsheet-style grid', async ({ page }) => {
  await selectMode(page, 'formula');
  // Formula mode shows the formula bar with a cell address.
  await expect(page.getByPlaceholder(/Type a value or =FORMULA/)).toBeVisible();
  // The 20-row × 7-column dataset must populate.
  const cells = page.locator('[role="gridcell"]');
  await expect.poll(async () => cells.count(), { timeout: 5_000 }).toBeGreaterThan(20);
});

test('switching to DuckDB connects to WASM and renders 100k rows', async ({ page }) => {
  await selectMode(page, 'duckdb');
  // The DuckDB cold-start takes a few seconds (CDN bundle fetch +
  // WASM init + CSV ingest). Wait for the row count text.
  await expect(page.getByText(/100,000 rows · cache/)).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[role="gridcell"]').first()).toBeVisible();
});

test('switching to Pivot rebuilds the dataset and renders pivoted columns', async ({
  page,
}) => {
  await selectMode(page, 'pivot');
  // Pivot output: 5 status rows × 26 firstName pivot keys × 2 measures
  // = 1 row-group col + 52 measure cols → aria-colcount ≈ 53.
  const grid = page.locator('[role="grid"]').first();
  await expect(grid).toBeVisible();
  await expect
    .poll(
      async () => Number((await grid.getAttribute('aria-colcount')) ?? '0'),
      { timeout: 10_000 },
    )
    .toBeGreaterThan(20);
  // Row count should drop dramatically (5 status values).
  await expect(grid).toHaveAttribute('aria-rowcount', '5');
});

test('returning to In-memory after another mode rehydrates the dataset', async ({
  page,
}) => {
  await selectMode(page, 'formula');
  await expect(page.getByPlaceholder(/Type a value or =FORMULA/)).toBeVisible();
  await selectMode(page, 'memory');
  await expect(page.getByText(/1,000,000 rows/)).toBeVisible({ timeout: 5_000 });
  await expect(page.locator('[role="gridcell"]').first()).toBeVisible();
});
