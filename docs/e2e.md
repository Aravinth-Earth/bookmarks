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
| a different target | set `E2E_BASE_URL=https://bookmarks.332321.xyz` and no server is started |

`wrangler dev` writes into `.wrangler/e2e-state-<port>`, which is ignored by git and removed before each run: the
registry allows one account on this machine, so a creation test would otherwise meet a full server on its second pass
and fail for a reason that has nothing to do with the code. Pointed at someone else's server (`E2E_BASE_URL`), nothing
is removed.

## What is covered

| File | Flows |
|---|---|
| `vault.spec.mjs` | create a vault, add, search, lock/unlock, duplicate refusal, wrong phrase, pills vs list, settings |
| `collected.spec.mjs` | off by default, capture, repeat visits, approval, the vault's own count, batch add, dismiss, exclusion, per-site rule, clear, visit floor |
| `edge.spec.mjs` | non-web pages, search narrowing the section, a `javascript:` address, and a browser with no extension |
| `roundtrip.spec.mjs` | a vault, a collected page, a sealed backup downloaded, the device wiped, the same vault restored |
| `a11y.spec.mjs` | names and labels, keyboard reach, focus rings and focus movement, live regions, table and heading structure |
| `layout.spec.mjs` | overflow and column tracks at phone, tablet and desktop, pills, settings modal, bulk bar, 200% zoom, 320px reflow |
| `ux.spec.mjs` | first run, refusals, search and sort, lock and unlock, settings, selection, undo, import and export |
| `perf-security.spec.mjs` | same-origin-only cold load, timings, security headers, sealed bytes, XSS through a name, lock hygiene |
| `invite.spec.mjs` | a server that needs a code: the field, the three refusals, the code never kept, and a phone/monitor fit |
| `theme.spec.mjs` | dark regardless of the system setting, a light theme saved by an older build, and the picker |
| `setup.spec.mjs` | the install link, the consent question, the defaults, "keep it off", and that the question is asked once |

Eighty-one tests; a full run takes about five minutes on four workers, sixteen on one (`E2E_WORKERS=1`). Every test opens its own browser profile, so running them side by side is safe; the performance budgets are the one thing to re-read on an idle machine.

## When a requirement is not met

Write the test at the real requirement and mark it `test.fail`. The run stays green, the defect stays visible in the
file and in its comment, and fixing the app turns that test red with "passed unexpectedly" — the reminder to remove
the mark. A test softened to pass is worse than no test. Every pin the suite once carried has since been removed
because the defect behind it was fixed.

## What cannot be covered here

- **Private windows.** Playwright's persistent context has no incognito window, and the extension also needs the
  browser's own "allow in private windows" switch. Verify it by hand: turn on *Include private windows* in the
  vault, allow the extension in private windows at the extensions page, then open a private window and check the
  section does not change.
- **The icon fetch** for a real site, because the mock pages have no favicon. The pipeline is covered by the Worker's
  own tests.
