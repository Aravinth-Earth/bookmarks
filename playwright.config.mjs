/**
 * Playwright drives the real thing: a running Worker, a real Chromium profile, and the extension loaded into it.
 *
 * Nothing here names a path on one machine. The extension is found beside this file, the server is started by
 * `wrangler dev` on a port taken from `E2E_PORT`, and the browser is Playwright's own Chromium. Point
 * `E2E_BASE_URL` at any running instance — the deployed origin included — and no server is started at all.
 *
 * Four workers by default: every test opens its own browser profile with its own copy of the extension, so nothing is
 * shared but the server. One worker takes the suite from about five minutes to sixteen — the clicks are what cost,
 * not the app — so `E2E_WORKERS=1` is there for a quiet machine when the timings themselves are the thing being read.
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
  workers: Number(process.env.E2E_WORKERS ?? 4),
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
          /* A run starts on a server that has never seen a vault: the Durable Objects persist on disk between runs, and the
               registry allows one account on this machine, so the second run of a creation test would meet a full server and
               fail for a reason that has nothing to do with the code under test. The account cap is raised here for the same
               reason: the deployed server takes one account, and more than one test needs a server that will take one. Removed before wrangler opens it, never
               after — a state directory deleted while workerd holds it answers SQLITE_CANTOPEN. */
          command: `rm -rf .wrangler/e2e-state-${PORT} && npx wrangler dev --port ${PORT} --ip 127.0.0.1 --local --persist-to .wrangler/e2e-state-${PORT} --var MAX_ACCOUNTS:8`,
          url: `${BASE}/w/bookmarks/api/health`,
          reuseExistingServer: false,
          timeout: 180_000,
          stdout: 'ignore',
          stderr: 'pipe'
        }
      })
});
