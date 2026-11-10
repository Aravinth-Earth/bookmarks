/**
 * Playwright drives the real thing: a running Worker, a real Chromium profile, and the extension loaded into it.
 *
 * Nothing here names a path on one machine. The extension is found beside this file, the server is started by
 * `wrangler dev` on a port taken from `E2E_PORT`, and the browser is Playwright's own Chromium. Point
 * `E2E_BASE_URL` at any running instance — the deployed origin included — and no server is started at all.
 *
 * One worker, because the extension's storage belongs to one browser profile and two profiles would each collect
 * their own list.
 */

import { defineConfig } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT ?? 8899);
const BASE = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${PORT}`;
const external = Boolean(process.env.E2E_BASE_URL);

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 90_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: BASE,
    trace: 'off',
    screenshot: 'only-on-failure',
    video: 'off'
  },
  ...(external
    ? {}
    : {
        webServer: {
          command: `npx wrangler dev --port ${PORT} --ip 127.0.0.1 --local --persist-to .wrangler/e2e-state-${PORT}`,
          url: `${BASE}/w/bookmarks/api/health`,
          reuseExistingServer: false,
          timeout: 180_000,
          stdout: 'ignore',
          stderr: 'pipe'
        }
      })
});
