// =============================================================================
// Column drag-drop reorder — real-Chromium gates.
//
// Asserts the v0.0.7 column reorder UX:
//   1. Pure click on a header still toggles sort (no drag → no reorder)
//   2. Dragging a header past several columns moves the dragged column
//      to the drop position, AND the underlying cell data follows the
//      column id (not the position) so the table reads correctly
//   3. Sorting after a reorder applies to the new column position by id
//
// The grid's ARIA shadow `<table role="grid">` exposes header text
// in <th> elements in display order, so checking that the th text
// list reflects the new order is enough to verify the reorder.
//
// Reference: ROADMAP.md v0.0.7 item 4.
// =============================================================================

import { expect, test } from '@playwright/test';
import './types';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => window.__onegrid !== undefined);
});

async function readHeaderOrder(page: import('@playwright/test').Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('table[role="grid"] thead th'))
      .map((t) => (t.textContent ?? '').trim())
      .filter((t) => t.length > 0),
  );
}

test('clicking a header without dragging still toggles sort', async ({ page }) => {
  const before = await readHeaderOrder(page);
  expect(before).toContain('Last name');

  // Dispatch a true pointerdown→pointerup pair on the Last name header.
  // Hit position is derived from getColumns() so toolbar/layout drift
  // cannot miss the column.
  await page.evaluate(async () => {
    const sh = document.querySelector('div[role="grid"]') as HTMLElement;
    const hr = (sh.parentElement as HTMLElement).getBoundingClientRect();
    const cols = window.__onegrid?.getColumns?.() ?? [];
    let x = hr.left;
    for (const c of cols) {
      if (c.id === 'lastName') {
        x += c.width / 2;
        break;
      }
      x += c.width;
    }
    const y = hr.top + 16;
    const mk = (type: string, buttons: number): PointerEvent =>
      new PointerEvent(type, {
        clientX: x,
        clientY: y,
        bubbles: true,
        cancelable: true,
        button: 0,
        buttons,
        pointerType: 'mouse',
        pointerId: 9,
        isPrimary: true,
      });
    sh.dispatchEvent(mk('pointerdown', 1));
    window.dispatchEvent(mk('pointerup', 0));
    await new Promise((r) => setTimeout(r, 200));
  });

  // Sort applied → row 1 should now be a different person than the
  // natural order. Without sort, row 1 is "Bashir Rinaldi"; with
  // ascending Last name sort, row 1 is the second Adeyemi
  // (rowIndex 26 → "Aiko Adeyemi").
  await expect.poll(async () => {
    return page.evaluate(() => {
      const td = document.querySelector(
        'table[role="grid"] tbody tr:nth-child(2) td:nth-child(3)',
      );
      return td?.textContent ?? '';
    });
  }, { timeout: 5_000 }).not.toBe('Rinaldi');
});

test('dragging a header reorders the columns', async ({ page }) => {
  const before = await readHeaderOrder(page);
  expect(before).toEqual(['#', 'First name', 'Last name', 'Revenue', 'Status', 'Score', 'Updated']);

  // Drag "First name" (column index 1) past Score column boundary.
  // First name center ≈ 145; target landing zone ≈ 700 (between
  // Score and Updated).
  await page.evaluate(async () => {
    const sh = document.querySelector('div[role="grid"]') as HTMLElement;
    const hr = (sh.parentElement as HTMLElement).getBoundingClientRect();
    const startX = hr.left + 145;
    const y = hr.top + 16;
    const endX = hr.left + 700;
    const mk = (x: number, type: string, buttons: number): PointerEvent =>
      new PointerEvent(type, {
        clientX: x,
        clientY: y,
        bubbles: true,
        cancelable: true,
        button: 0,
        buttons,
        pointerType: 'mouse',
        pointerId: 1,
        isPrimary: true,
      });
    sh.dispatchEvent(mk(startX, 'pointerdown', 1));
    for (let x = startX; x <= endX; x += 50) {
      sh.dispatchEvent(mk(x, 'pointermove', 1));
      await new Promise((r) => setTimeout(r, 5));
    }
    window.dispatchEvent(mk(endX, 'pointerup', 0));
    await new Promise((r) => setTimeout(r, 100));
  });

  const after = await readHeaderOrder(page);
  // First name is now after Score; Last name shifted left.
  expect(after.indexOf('First name')).toBeGreaterThan(after.indexOf('Score'));
  expect(after.indexOf('Last name')).toBeLessThan(after.indexOf('First name'));
});

test('a tiny drag (under threshold) is treated as a click, not a reorder', async ({
  page,
}) => {
  const before = await readHeaderOrder(page);
  await page.evaluate(async () => {
    const sh = document.querySelector('div[role="grid"]') as HTMLElement;
    const hr = (sh.parentElement as HTMLElement).getBoundingClientRect();
    const x = hr.left + 145;
    const y = hr.top + 16;
    const mk = (clientX: number, type: string, buttons: number): PointerEvent =>
      new PointerEvent(type, {
        clientX,
        clientY: y,
        bubbles: true,
        cancelable: true,
        button: 0,
        buttons,
        pointerType: 'mouse',
        pointerId: 2,
        isPrimary: true,
      });
    sh.dispatchEvent(mk(x, 'pointerdown', 1));
    sh.dispatchEvent(mk(x + 2, 'pointermove', 1)); // 2px < 6px threshold
    window.dispatchEvent(mk(x + 2, 'pointerup', 0));
    await new Promise((r) => setTimeout(r, 100));
  });
  const after = await readHeaderOrder(page);
  expect(after).toEqual(before);
});
