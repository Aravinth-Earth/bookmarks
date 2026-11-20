/**
 * The store privacy policy.
 *
 * The Chrome Web Store asks for one public page that says what an extension touches, and one
 * justification for the permission that produces a warning. The page is served by the same Worker
 * as the vault, so it is a file in `public/` — which also means `npm run check` scans it for an
 * external host, an inline handler and overclaiming copy like every other public asset.
 *
 * These tests hold the page to the manifest and to the collector rather than to its own prose: the
 * permission table has to name exactly the permissions the manifest declares, the `tabs` row has to
 * carry the platform's own warning and the argument for it, and the address the documents publish
 * has to be the address this page answers at. A permission added to the manifest, or a version bump
 * with the page left behind, fails here instead of being found in review.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const read = (path) => readFileSync(join(ROOT, path), 'utf8');

/** Where the policy is published, and the file the asset binding answers that path with. */
const POLICY_URL = 'https://bookmarks.332321.xyz/privacy/';
const POLICY_PATH = 'public/privacy/index.html';

const manifest = JSON.parse(read('extension/manifest.json'));
const page = existsSync(join(ROOT, POLICY_PATH)) ? read(POLICY_PATH) : null;

/** The documents that describe the extension to a reader: the listing copy and the guide. */
const DOCUMENTS = ['extension/README.md', 'extension/INSTALL.md'];

/** One row of the page's permission table, as its cells. */
function permissionRows(html) {
  return [...html.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map((row) => row[1]);
}

/** The text of one table row, tags stripped. */
function rowText(row) {
  return row
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

test('the policy is a page the vault origin serves, and the extension documents publish that address', () => {
  assert.ok(page !== null, `${POLICY_PATH} exists, because ${POLICY_URL} is a store field and cannot be a 404`);

  /* The published path is the page's own directory, so the address and the file cannot drift apart. */
  const pathname = new URL(POLICY_URL).pathname;
  assert.equal(
    pathname.endsWith('/') ? `public${pathname}index.html` : `public${pathname}.html`,
    POLICY_PATH,
    'the published address names the page this repository serves'
  );

  for (const name of DOCUMENTS) {
    assert.ok(read(name).includes(POLICY_URL), `${name} links the policy at ${POLICY_URL}`);
  }
});

test('the page explains exactly the permissions the manifest declares', () => {
  assert.ok(page !== null, `${POLICY_PATH} exists`);

  const named = [...page.matchAll(/<td><code>([^<]+)<\/code><\/td>/g)].map((match) => match[1]);

  assert.deepEqual(
    new Set(named),
    new Set(manifest.permissions ?? []),
    'the permission table names every permission the manifest asks for, and no other'
  );
});

test('the tabs row carries the warning the browser shows and the reason the permission is needed', () => {
  assert.ok(page !== null, `${POLICY_PATH} exists`);

  const rows = permissionRows(page).filter((row) => row.includes('<td><code>tabs</code></td>'));
  assert.equal(rows.length, 1, 'the page has one row for tabs');

  const text = rowText(rows[0]);
  assert.match(text, /read your browsing history/i, 'the row quotes the platform warning the install shows');
  assert.match(text, /no narrower permission/i, 'the row says why no narrower permission will do');
  assert.match(text, /finish(ed)? loading/i, 'the row says when an address is read');
});

test('the page says where the data is kept, and that it is not sent anywhere by the extension', () => {
  assert.ok(page !== null, `${POLICY_PATH} exists`);

  assert.match(page, /chrome\.storage\.local/, 'the page names the store the collector writes to');
  assert.match(page, /local/i, 'the page says the list stays on the device');

  /* The manifest is the mechanism the promise rests on, so the page names it and this test reads it. */
  const csp = manifest.content_security_policy?.extension_pages ?? '';
  assert.match(csp, /connect-src 'none'/);
  assert.match(page, /connect-src 'none'/, 'the page names the policy that refuses a connection');

  for (const sink of ['fetch', 'XMLHttpRequest', 'sendBeacon', 'WebSocket']) {
    assert.ok(page.includes(sink), `the page names ${sink}, the calls the guard refuses`);
  }
});

test('the page names the version it describes, so a release has to look at it', () => {
  assert.ok(page !== null, `${POLICY_PATH} exists`);

  assert.ok(page.includes(manifest.version), `the page names version ${manifest.version} from the manifest`);
});

test('a policy has nothing to run, so the page loads no script', () => {
  assert.ok(page !== null, `${POLICY_PATH} exists`);

  assert.doesNotMatch(page, /<script/i, 'the page carries no script tag');
});
