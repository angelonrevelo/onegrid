import type { Page } from '@playwright/test';

/** Values of the playground `<select aria-label="data source mode">`. */
export type PlaygroundMode =
  | 'memory'
  | 'ssrm'
  | 'formula'
  | 'duckdb'
  | 'pivot'
  | 'tree'
  | 'ssrm-tree'
  | 'studio';

/** Switch playground data source. The toolbar is a select, not mode buttons. */
export async function selectMode(page: Page, mode: PlaygroundMode): Promise<void> {
  await page.getByLabel('data source mode').selectOption(mode);
}

/**
 * Demo toggles (v009/v010/v011/v100) live inside a closed `<details>` labelled
 * Demos. Open it, click the toggle, then close the menu so it cannot intercept
 * clicks in the demo panel.
 */
export async function openDemo(page: Page, testId: string): Promise<void> {
  const toggle = page.getByTestId(testId);
  const summary = page.locator('summary', { hasText: 'Demos' });
  const details = page.locator('details.menu').filter({ has: summary });
  if (!(await toggle.isVisible())) {
    await summary.click();
  }
  await toggle.click();
  await details.evaluate((el) => {
    (el as HTMLDetailsElement).open = false;
  });
}
