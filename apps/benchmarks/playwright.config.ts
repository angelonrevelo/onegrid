import { defineConfig, devices } from '@playwright/test';

// IPv6: on this box 127.0.0.1:5173 is booted; the playground binds [::1]:5173.
const PLAYGROUND_URL = 'http://[::1]:5173';
const SSRM_URL = 'http://localhost:3001';

// Spec subsets per browser. Perf and webgpu specs aren't meaningful or
// supported off-Chromium — running them against Firefox/WebKit would
// either be a flaky waste of CI time (perf numbers vary wildly between
// engines) or fail at feature-detect (WebGPU isn't shipped in WebKit
// yet, partial in Firefox).
const CHROMIUM_ONLY_GLOBS = [
  '**/perf-*.spec.ts',
  '**/webgpu.spec.ts',
  '**/agg-pushdown.spec.ts',
];

/**
 * The harness auto-starts both the playground (vite dev) and the SSRM mock
 * server (Node http) so a fresh checkout can run benchmarks with one
 * command. `reuseExistingServer` lets local dev keep its long-running
 * vite server alive between runs.
 *
 * Cross-browser projects: chromium runs everything; firefox/webkit run
 * the behavior-only subset (no perf, no webgpu). Today's session caught
 * a Float32-precision bug that would have hit Safari users differently;
 * the Tier-2 matrix is the regression guard for the "developed in Chrome,
 * silently broke in Safari" class.
 */
export default defineConfig({
  testDir: './src',
  fullyParallel: false, // Perf scenarios deserve isolated runs
  workers: 1,
  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
  ],
  use: {
    baseURL: PLAYGROUND_URL,
    headless: true,
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] },
      testIgnore: CHROMIUM_ONLY_GLOBS,
    },
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
      testIgnore: CHROMIUM_ONLY_GLOBS,
    },
  ],
  webServer: [
    {
      command: 'pnpm --filter @onegrid/playground dev',
      url: PLAYGROUND_URL,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: 'pnpm --filter @onegrid/ssrm-mock-server dev',
      url: `${SSRM_URL}/healthz`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  ],
});
