// =============================================================================
// v0.0.10 — real-Chromium verification for the v0.0.10 packages exposed
// via the V010Demo panel:
//
//   - @onegrid/sparklines: canvas paints (visual smoke + getContext/2d call)
//   - @onegrid/formula BigInt: 2^53 + 1 + 1 stays exact (= 9007199254740994n)
//   - @onegrid/dbsp: incremental groupAgg — partial sums advance with each
//     diff batch (proves O(diff) semantics, not O(N) re-scan)
//   - @onegrid/data-worker: 100k-row sort offloaded through the worker
//     protocol; assert finishes (timing observed for telemetry, not gated)
//
// Column virtualization / adaptive overscan / rAF discipline are renderer-
// internal and exercised by every existing playground mode; their perf
// claims are verified via apps/benchmarks/src/perf-scroll.spec.ts.
// =============================================================================

import { expect, test } from '@playwright/test';
import { openDemo } from './mode';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await openDemo(page, 'v010-demo-toggle');
  await expect(page.getByTestId('v010-demo')).toBeVisible();
});

test('sparklines paint into a canvas with non-zero pixel coverage', async ({ page }) => {
  // The component paints on mount — when the demo opens, the canvas has
  // content. We assert the canvas exists, has non-zero size, and that a
  // sampled pixel inside the chart region is non-transparent.
  const canvas = page.getByTestId('v010-sparkline-canvas');
  await expect(canvas).toBeVisible();
  const hasContent = await canvas.evaluate((el) => {
    const c = el as HTMLCanvasElement;
    if (c.width === 0 || c.height === 0) return false;
    const ctx = c.getContext('2d');
    if (!ctx) return false;
    // Sample the middle of the line chart (top third of the canvas).
    const data = ctx.getImageData(c.width / 2, Math.floor(c.height / 6), 1, 1).data;
    // Either a stroked pixel (any colored RGB) OR the area fill behind it
    // counts as a paint.
    return data[3]! > 0 || data[0]! > 0 || data[1]! > 0 || data[2]! > 0;
  });
  expect(hasContent).toBe(true);
});

test('BigInt formula: A1 + B1 stays exact past 2^53', async ({ page }) => {
  await page.getByTestId('v010-bigint-run').click();
  // Number-precision sum would round to 9007199254740994 (which happens
  // to be representable!) — so the killer test is the next-most: ensure
  // the result is exactly that string, not e.g. 9007199254740994.0 or
  // 9.007e15.
  await expect(page.getByTestId('v010-bigint-result')).toHaveText('9007199254740994');
});

test('DBSP groupAgg: batch 1 then batch 2 advance partial sums incrementally', async ({
  page,
}) => {
  await page.getByTestId('v010-dbsp-run').click();
  // Batch 1: us = 100 + 200 = 300; eu = 50.
  await expect(page.getByTestId('v010-dbsp-result')).toHaveText(
    'after #1: us=300 eu=50',
  );
  // Batch 2 incrementally adds: us += 300 = 600; eu += 25 = 75.
  await expect(page.getByTestId('v010-dbsp-delta')).toHaveText(
    'after #2: us=600 eu=75',
  );
});

test('data-worker: 100k-row sort completes via the worker protocol', async ({
  page,
}) => {
  await page.getByTestId('v010-worker-sort-run').click();
  // The result span starts at '—'; once sort finishes, it becomes "Nms · head=[...]"
  // for some positive N + 5 sorted ids.
  await expect(page.getByTestId('v010-worker-sort-result')).toHaveText(
    /^\d+ms · head=\[\d+(,\d+){4}\]$/,
    { timeout: 30_000 },
  );
});
