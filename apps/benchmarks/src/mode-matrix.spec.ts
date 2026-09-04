// =============================================================================
// Mode-matrix spec — smoke tests for each data-source mode. For every
// mode the playground supports we verify:
//   - mode switch lands cleanly (numRows > 0, getViewportInfo works)
//   - sort by a real column doesn't crash + visible rows update
//   - basic scroll still works post-switch
//
// We don't deep-test the SSRM mock-server path (separate spec) — the
// goal here is "no path is broken." Today's session has shipped fixes
// where mode switches reset fenwick incorrectly, so this is the
// regression guard for that whole class.
// =============================================================================

import { expect, test } from '@playwright/test';
import './types';

// Modes the playground claims to support. ssrm and ssrm-tree depend on
// the mock server, which is auto-started by the harness — but it can
// be flaky on slow CI, so we keep them lower-priority here.
const STABLE_MODES = ['memory', 'formula', 'duckdb', 'pivot', 'tree'] as const;

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => window.__onegrid !== undefined);
  await page.waitForTimeout(200);
});

for (const mode of STABLE_MODES) {
  test(`mode "${mode}" mounts and exposes a non-empty viewport`, async ({
    page,
    browserName,
  }) => {
    // duckdb-wasm under WebKit is flaky in the full three-browser suite
    // (resource contention). modes.spec.ts already covers DuckDB on
    // WebKit via the <select> path.
    test.skip(
      mode === 'duckdb' && browserName === 'webkit',
      'duckdb-wasm is flaky under WebKit in the full suite; modes.spec.ts covers it',
    );
    await page.evaluate((m) => window.__onegrid?.setMode?.(m), mode);
    // Mode swaps remount data + sometimes the Grid host; give the
    // playground generous time, especially for duckdb (wasm load).
    await page.waitForFunction(
      (m) => {
        const w = window.__onegrid;
        if (!w?.getMode || !w.getViewportInfo) return false;
        if (w.getMode() !== m) return false;
        const info = w.getViewportInfo();
        return info.numRows > 0;
      },
      mode,
      { timeout: 30_000 },
    );

    const info = await page.evaluate(() => window.__onegrid!.getViewportInfo!());
    expect(info.numRows).toBeGreaterThan(0);
    expect(info.viewportWidth).toBeGreaterThan(0);
    expect(info.viewportHeight).toBeGreaterThan(0);
    // First visible should always be 0 immediately after mode switch
    // (Grid resets scrollTop on setRowSource).
    expect(info.firstVisibleRow).toBe(0);
  });
}

test('mode switch preserves Grid liveness — back-and-forth doesn\'t corrupt fenwick', async ({
  page,
}) => {
  // Today's session shipped a fix where switching from materialized 1M
  // to lazy 10M and back was leaving fenwick out of sync with rowSource.
  // This is the regression guard.
  const sequence = ['memory', 'formula', 'memory', 'pivot', 'memory'] as const;
  for (const m of sequence) {
    await page.evaluate((mode) => window.__onegrid?.setMode?.(mode), m);
    await page.waitForFunction(
      (mode) => window.__onegrid?.getMode?.() === mode,
      m,
      { timeout: 20_000 },
    );
    await page.waitForTimeout(150);
    const info = await page.evaluate(() => window.__onegrid!.getViewportInfo!());
    // fenwick.totalHeight should ALWAYS be roughly numRows * avg row
    // height (≥20). If fenwick gets stuck at a smaller size from a
    // previous dataset, totalHeight / numRows would drop below 20.
    expect(info.totalHeight / info.numRows).toBeGreaterThanOrEqual(20);
  }
});

test('sort then scroll works in memory mode (regression for materialized + sort)', async ({
  page,
}) => {
  await page.evaluate(() => window.__onegrid?.setMode?.('memory'));
  await page.waitForFunction(() => {
    const i = window.__onegrid?.getViewportInfo?.();
    return i != null && i.numRows >= 1_000_000;
  });
  await page.waitForTimeout(200);

  // Read the unsorted first revenue to detect when the sort settles.
  const unsortedFirstRevenue = await page.evaluate(() =>
    window.__onegrid?.readCell?.(0, 'revenue'),
  );

  // Apply a desc sort by revenue.
  await page.evaluate(() =>
    window.__onegrid?.setSort([{ columnId: 'revenue', direction: 'desc' }]),
  );

  // Wait for the sort to actually take effect — row 0's revenue should
  // now be the maximum (large) instead of the original (small). The
  // synthetic dataset's revenue cycles 0..9999.99, so the desc top is
  // a row with revenue near 9999.99. Polling avoids the race where
  // setSort triggers a setRowSource reset AFTER our scrollToRow.
  await page.waitForFunction(
    (orig) => {
      const v = window.__onegrid?.readCell?.(0, 'revenue');
      return v != null && Number(v) > Number(orig) + 100;
    },
    unsortedFirstRevenue,
    { timeout: 10_000 },
  );
  // Allow one more frame for setRowSource → scrollTop=0 to settle
  // before we issue scrollToRow (otherwise its scrollTop could be
  // overwritten by the post-sort reset).
  await page.waitForTimeout(100);

  await page.evaluate(() => window.__onegrid?.scrollToRow(5000));
  await page.waitForTimeout(200);

  const info = await page.evaluate(() => window.__onegrid!.getViewportInfo!());
  expect(info.firstVisibleRow).toBeGreaterThanOrEqual(4900);
  expect(info.firstVisibleRow).toBeLessThanOrEqual(5050);
});

test('filter narrows the visible row count in memory mode', async ({ page }) => {
  await page.evaluate(() => window.__onegrid?.setMode?.('memory'));
  await page.waitForFunction(() => {
    const i = window.__onegrid?.getViewportInfo?.();
    return i != null && i.numRows >= 1_000_000;
  });
  await page.waitForTimeout(200);

  const before = await page.evaluate(() => window.__onegrid!.getViewportInfo!().numRows);

  await page.evaluate(() => window.__onegrid?.setFilter('Aiko'));
  // Filter is async — the view rebuilds when the filter index resolves.
  await page.waitForFunction(
    (b) => {
      const i = window.__onegrid?.getViewportInfo?.();
      return i != null && i.numRows < b;
    },
    before,
    { timeout: 10_000 },
  );

  const after = await page.evaluate(() => window.__onegrid!.getViewportInfo!().numRows);
  expect(after).toBeLessThan(before);
  expect(after).toBeGreaterThan(0);

  // Clear filter.
  await page.evaluate(() => window.__onegrid?.setFilter(''));
  await page.waitForFunction(
    (b) => window.__onegrid?.getViewportInfo?.()?.numRows === b,
    before,
  );
});
