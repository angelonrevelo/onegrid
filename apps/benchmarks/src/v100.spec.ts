// =============================================================================
// v0.1.0 — real-Chromium verification for the v0.1.0 packages exposed via
// the V100Demo panel:
//
//   - @onegrid/webgpu-render: packCells produces the documented byte layout
//     (32 bytes × cellCount + 16 bytes × glyphCount), MSDF_WGSL non-empty,
//     screenPxRange formula
//   - @onegrid/webgpu: cpuHashAggSumF32 oracle groups 5 rows / 3 keys correctly
//   - @onegrid/duckdb-join: registerSource SQL string for a 'rows' source
//
// The actual GPU pipeline + DuckDB-WASM query path can't run in this
// headless test environment without real hardware; those gates land in
// v0.1.0.x via a dedicated WebGPU benchmark suite.
// =============================================================================

import { expect, test } from '@playwright/test';
import { openDemo } from './mode';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await openDemo(page, 'v100-demo-toggle');
  await expect(page.getByTestId('v100-demo')).toBeVisible();
});

test('webgpu-render: packCells byte layout matches CELL_STRIDE × cellCount', async ({
  page,
}) => {
  // 2 cells × CELL_STRIDE(32) = 64 bytes; 3 glyphs × GLYPH_STRIDE(16) = 48 bytes
  await expect(page.getByTestId('v100-pack-stride')).toHaveText(
    'CELL_STRIDE = 32 · GLYPH_STRIDE = 16',
  );
  await expect(page.getByTestId('v100-pack-bytes')).toHaveText(
    'cells.byteLength = 64 (2 cells × 32) · glyphs.byteLength = 48 (3 glyphs × 16)',
  );
});

test('webgpu-render: screenPxRange formula uses distanceRange × (em/size) ratio', async ({
  page,
}) => {
  // atlas.distanceRange=4, atlas.size=32, screenEm=16 → 4 × (16/32) = 2.00
  await expect(page.getByTestId('v100-msdf-pxrange')).toHaveText(
    'screenPxRange(atlas, 16px EM) = 2.00',
  );
});

test('webgpu-render: MSDF_WGSL is loaded (non-empty)', async ({ page }) => {
  await expect(page.getByTestId('v100-msdf-wgsl-loaded')).toContainText(/MSDF_WGSL: \d+ chars/);
  const charCount = await page.getByTestId('v100-msdf-wgsl-loaded').textContent();
  const n = Number(charCount?.match(/(\d+)/)?.[1] ?? '0');
  expect(n).toBeGreaterThan(100);
});

test('webgpu: hash-agg CPU oracle groups by key correctly (3 distinct keys)', async ({
  page,
}) => {
  await page.getByTestId('v100-hashagg-run').click();
  // Keys [1,2,1,2,3] with values [10,20,5,7,100], numBuckets=16:
  //   bucket[1] = 10 + 5  = 15
  //   bucket[2] = 20 + 7  = 27
  //   bucket[3] = 100
  await expect(page.getByTestId('v100-hashagg-result')).toHaveText(
    'bucket[1]=15 · bucket[2]=27 · bucket[3]=100',
  );
});

test('duckdb-join: VALUES-based view DDL matches the documented shape', async ({
  page,
}) => {
  await page.getByTestId('v100-join-run').click();
  await expect(page.getByTestId('v100-join-sql')).toHaveText(
    `CREATE OR REPLACE VIEW "orders" AS SELECT * FROM (VALUES (1, 'Alpha'), (2, 'Beta')) AS t("id", "customer")`,
  );
});
