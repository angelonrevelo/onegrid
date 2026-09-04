// =============================================================================
// v0.0.9 — real-Chromium verification for the six new packages.
//
// Each test drives a visible affordance in the playground's V009Demo panel
// and asserts an observable effect: theme switch flips CSS custom property,
// density cycle updates row-height var, locale toggle re-renders translated
// strings (plural form picks the right arm), gesture recognizer reports
// tap / longPress, worker-plugins host invokes a handler over postMessage
// and gets a number back, headless SSR serializer produces a role=grid tree,
// plugin-kit registries resolve theme + i18n catalogs.
//
// Browser-only behavior (Pointer Events, getComputedStyle on CSS vars,
// VirtualKeyboard) is intentionally tested HERE rather than in jsdom unit
// tests; the unit suites cover the algorithmic surface.
// =============================================================================

import { expect, test } from '@playwright/test';
import { openDemo } from './mode';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await openDemo(page, 'v009-demo-toggle');
  await expect(page.getByTestId('v009-demo')).toBeVisible();
});

test('plugin-kit interfaceVersion + registry resolutions are surfaced', async ({ page }) => {
  const iface = page.getByTestId('v009-iface-version');
  await expect(iface).toHaveText(/interfaceVersion = 1/);
  await expect(page.getByTestId('v009-theme-resolved')).toHaveText(
    /themeRegistry → light · i18nCatalogRegistry → en/,
  );
});

test('tokens — theme toggle flips --og-color-background through DTCG compile', async ({
  page,
}) => {
  const root = page.getByTestId('v009-demo');
  const light = await root.evaluate((el) =>
    getComputedStyle(el).getPropertyValue('--og-color-background').trim(),
  );
  expect(light).toBe('#ffffff');
  await page.getByTestId('v009-theme-toggle').click();
  await expect(page.getByTestId('v009-theme-toggle')).toHaveText(/dark/);
  const dark = await root.evaluate((el) =>
    getComputedStyle(el).getPropertyValue('--og-color-background').trim(),
  );
  expect(dark).toBe('#0d1117');
});

test('tokens — density cycle updates --og-size-row-height', async ({ page }) => {
  const root = page.getByTestId('v009-demo');
  const read = (): Promise<string> =>
    root.evaluate((el) =>
      getComputedStyle(el).getPropertyValue('--og-size-row-height').trim(),
    );
  expect(await read()).toBe('32px');         // comfortable
  await page.getByTestId('v009-density-cycle').click();
  await expect(page.getByTestId('v009-density-cycle')).toHaveText(/spacious/);
  expect(await read()).toBe('48px');          // spacious
  await page.getByTestId('v009-density-cycle').click();
  await expect(page.getByTestId('v009-density-cycle')).toHaveText(/compact/);
  expect(await read()).toBe('24px');          // compact
});

test('intl — locale toggle re-translates the title + plural arms', async ({ page }) => {
  await expect(page.getByTestId('v009-title')).toHaveText('v0.0.9 Demo');
  await expect(page.getByTestId('v009-plural-zero')).toHaveText('no items');
  await expect(page.getByTestId('v009-plural-one')).toHaveText('1 item');
  await expect(page.getByTestId('v009-plural-many')).toHaveText('1,234 items');

  await page.getByTestId('v009-locale-toggle').click();
  await expect(page.getByTestId('v009-title')).toHaveText('Demostración v0.0.9');
  await expect(page.getByTestId('v009-plural-zero')).toHaveText('sin elementos');
  await expect(page.getByTestId('v009-plural-one')).toHaveText('1 elemento');
  await expect(page.getByTestId('v009-plural-many')).toHaveText('1234 elementos');
});

test('intl — parseLocalizedNumber round-trips in en-US and de-DE', async ({ page }) => {
  // Default en-US, default value '1,234.5' → format back to '1,234.5'
  await expect(page.getByTestId('v009-parse-result')).toHaveText('→ 1,234.5');

  await page.getByTestId('v009-parse-locale').click();
  await expect(page.getByTestId('v009-parse-locale')).toHaveText('de-DE');
  await page.getByTestId('v009-parse-input').fill('1.234,5');
  await expect(page.getByTestId('v009-parse-result')).toHaveText('→ 1.234,5');
});

test('touch — gesture recognizer reports tap on a Pointer Events tap', async ({ page }) => {
  const target = page.getByTestId('v009-gesture-target');
  const box = await target.boundingBox();
  if (!box) throw new Error('gesture target has no bounding box');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.up();
  // Allow the gesture recognizer's synchronous emit to flush + React state.
  const log = page.getByTestId('v009-gesture-log');
  await expect(log).toContainText(/^tap@\(\d+,\d+\)$/m);
});

test('touch — long-press fires after 500 ms hold', async ({ page }) => {
  const target = page.getByTestId('v009-gesture-target');
  const box = await target.boundingBox();
  if (!box) throw new Error('no box');
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.waitForTimeout(600);
  await page.mouse.up();
  await expect(page.getByTestId('v009-gesture-log')).toContainText('longPress@');
});

test('worker-plugins — sumColumn(1..10) returns 55', async ({ page }) => {
  await page.getByTestId('v009-worker-sum').click();
  await expect(page.getByTestId('v009-worker-sum-result')).toHaveText('= 55');
});

test('headless — renderAccessibilityShadowHTML emits role=grid + aria-rowcount', async ({
  page,
}) => {
  await page.getByTestId('v009-ssr-render').click();
  const out = page.getByTestId('v009-ssr-output');
  await expect(out).toContainText('role="grid"');
  await expect(out).toContainText('aria-rowcount="3"');
  await expect(out).toContainText('role="columnheader"');
  await expect(out).toContainText('aria-colindex="1"');
});
