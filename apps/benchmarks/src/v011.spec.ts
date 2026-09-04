// =============================================================================
// v0.0.11 — real-Chromium verification for the v0.0.11 packages exposed
// via the V011Demo panel:
//
//   - @onegrid/mcp: tools/list + tools/call(set_sort) through the JSON-RPC handler
//   - @onegrid/temporal: snapshotAt past version + undo via invertDiff round-trip
//   - @onegrid/ai: parseIntentHeuristic on a natural-language query (no LLM)
//   - @onegrid/crdt: 3 local Y.Map edits flow through bindYjsRows as RowDiffs
//   - @onegrid/reactive: backdating cascade-protection on a 3-node graph
//
// @onegrid/orm-sync is type-only glue exercised by the v0.0.8 CDC adapter
// integration tests; no separate visible surface.
// =============================================================================

import { expect, test } from '@playwright/test';
import { openDemo } from './mode';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await openDemo(page, 'v011-demo-toggle');
  await expect(page.getByTestId('v011-demo')).toBeVisible();
});

test('MCP: tools/list returns tool names; tools/call(set_sort) applies', async ({
  page,
}) => {
  await page.getByTestId('v011-mcp-run').click();
  // First four tool names (alphabetical from the descriptor list).
  await expect(page.getByTestId('v011-mcp-tools')).toContainText('set_sort');
  await expect(page.getByTestId('v011-mcp-sort')).toHaveText('sort applied: amount desc');
});

test('Temporal: snapshotAt(1) recovers v1 state; undo round-trips to v1', async ({
  page,
}) => {
  await page.getByTestId('v011-temporal-run').click();
  await expect(page.getByTestId('v011-temporal-result')).toHaveText(
    'head=v3 · @v1.x=1 · after undo=1',
  );
});

test('AI heuristic: "amount >= 100" parses to a single filter intent', async ({
  page,
}) => {
  // Default input value is "amount >= 100" — the heuristic recognizes it.
  await expect(page.getByTestId('v011-ai-count')).toHaveText('1 intent(s)');
  await expect(page.getByTestId('v011-ai-kind')).toHaveText('filter');
  // Change to a sort phrase — heuristic flips to a sort intent.
  await page.getByTestId('v011-ai-input').fill('sort by amount desc');
  await expect(page.getByTestId('v011-ai-kind')).toHaveText('sort');
  // Unparseable input → 0 intents.
  await page.getByTestId('v011-ai-input').fill('show me something');
  await expect(page.getByTestId('v011-ai-count')).toHaveText('0 intent(s)');
});

test('CRDT: 3 Y.Map mutations flow through bindYjsRows as 3 RowDiffs', async ({
  page,
}) => {
  await page.getByTestId('v011-crdt-run').click();
  await expect(page.getByTestId('v011-crdt-log')).toHaveText(
    'insert:r1 · update:r1 · delete:r1',
  );
});

test('Reactive: backdating prevents downstream cascade across no-op input toggles', async ({
  page,
}) => {
  await page.getByTestId('v011-reactive-run').click();
  // Trace:
  //   1st downstream(undefined) — computes upstream + downstream once each
  //   x.set(-5) — bumps revision; Math.abs(-5) === 5 (same value)
  //   2nd downstream(undefined) — upstream re-runs (backdates); downstream
  //     observes upstream.computedAt unchanged → SKIPS its compute
  //   x.set(5) — same backdating story
  //   3rd downstream(undefined) — same skip
  //   final downstream() inside the report — also a cache hit
  // Expected: upstream=3, downstream=1, final=6.
  await expect(page.getByTestId('v011-reactive-stats')).toHaveText(
    'upstream=3 · downstream=1 · final=6',
  );
});
