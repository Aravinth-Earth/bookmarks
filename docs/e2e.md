# End-to-end tests

Real browser, real extension, real Worker. Playwright drives a Chromium profile with `extension/` loaded and the app
served by `wrangler dev`; nothing is mocked except the pages the tests ask the browser to open.

## Running them

```sh
npm install
npx playwright install chromium   # once per machine
npm run test:e2e
```

`npm test` stays what it was — `node --test`, no dependencies — and the end-to-end suite is a separate command because
it needs a browser.

## Where things come from

Nothing in the suite names a path on the machine it was written on:

| What | How it is found |
|---|---|
| the extension | `tests/e2e/fixtures.mjs` resolves `../../extension` from its own location |
| the app | `wrangler dev` on `E2E_PORT` (default 8899), started and stopped by Playwright |
| the browser | Playwright's own Chromium, `npx playwright install chromium` |
| the pages a test "visits" | a Playwright route answering `https://e2e.local/**`, so no network is needed |
| a different target | set `E2E_BASE_URL=https://b.332321.xyz` and no server is started |

`wrangler dev` writes into `.wrangler/e2e-state`, which is ignored by git, so a run never mixes with a development
vault.

## What is covered

| File | Flows |
|---|---|
| `vault.spec.mjs` | create a vault, add, search, lock/unlock, duplicate refusal, wrong phrase, pills vs list, settings |
| `collected.spec.mjs` | off by default, capture, repeat visits, approval, the vault's own count, batch add, dismiss, exclusion, per-site rule, clear, visit floor |
| `edge.spec.mjs` | non-web pages, search narrowing the section, a `javascript:` address, and a browser with no extension |

## What cannot be covered here

- **Private windows.** Playwright's persistent context has no incognito window, and the extension also needs the
  browser's own "allow in private windows" switch. Verify it by hand: turn on *Include private windows* in the
  vault, allow the extension in private windows at the extensions page, then open a private window and check the
  section does not change.
- **The icon fetch** for a real site, because the mock pages have no favicon. The pipeline is covered by the Worker's
  own tests.
