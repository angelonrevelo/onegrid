// =============================================================================
// Selection-checkbox column — real-Chromium gates.
//
// Asserts the v0.0.7 createSelectionCheckboxColumn factory + the
// SelectAllCheckbox toolbar widget the playground wires:
//   1. Each visible row mounts a row-level checkbox via the renderer
//      pool (one DOM <input> per visible row).
//   2. Toggling row checkboxes updates the count in the SelectAll
//      label without a Grid remount.
//   3. The SelectAll checkbox checks/unchecks every row.
//
// Reference: ROADMAP.md v0.0.7 item 9.
// =============================================================================

import { expect, test } from '@playwright/test';
import './types';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => window.__onegrid !== undefined);
  // The selection-checkbox column is opt-in in the playground (so other
  // tests get the original column layout). Click the toolbar toggle so
  // the column + SelectAll widget mount.
  await page.getByRole('button', { name: 'Selection col', exact: true }).click();
});

test('row checkboxes mount one per visible row', async ({ page }) => {
  // Wait for memoryDataset to materialize and the renderer pool to
  // mount a checkbox per visible row.
  await expect.poll(
    async () =>
      page.evaluate(
        () =>
          document.querySelectorAll(
            'input[type="checkbox"][aria-label^="Select row"]',
          ).length,
      ),
    { timeout: 5_000 },
  ).toBeGreaterThan(10);
});

test('toggling row checkboxes updates the SelectAll label', async ({ page }) => {
  // Firefox/WebKit pool checkboxes slower than Chromium — wait until
  // at least three row boxes exist before clicking indices.
  await page.waitForFunction(
    () =>
      document.querySelectorAll(
        'input[type="checkbox"][aria-label^="Select row"]',
      ).length >= 5,
    { timeout: 10_000 },
  );
  // Toggle three rows (0, 2, 4).
  await page.evaluate(() => {
    const cbs = document.querySelectorAll(
      'input[type="checkbox"][aria-label^="Select row"]',
    );
    (cbs[0] as HTMLInputElement).click();
    (cbs[2] as HTMLInputElement).click();
    (cbs[4] as HTMLInputElement).click();
  });
  await expect
    .poll(async () =>
      page.evaluate(() =>
        Array.from(document.querySelectorAll('label > span'))
          .map((s) => s.textContent ?? '')
          .find((t) => /selected$/.test(t)),
      ),
    )
    .toMatch(/^3 of/);
});

test('SelectAll toggles all rows', async ({ page }) => {
  await page.waitForFunction(
    () =>
      document.querySelectorAll(
        'input[type="checkbox"][aria-label^="Select row"]',
      ).length > 0,
  );
  await page
    .getByRole('checkbox', { name: 'Select all rows' })
    .click();
  await expect
    .poll(async () =>
      page.evaluate(() =>
        Array.from(document.querySelectorAll('label > span'))
          .map((s) => s.textContent ?? '')
          .find((t) => /selected$/.test(t)),
      ),
    )
    .toMatch(/^1000000 of/);
});
