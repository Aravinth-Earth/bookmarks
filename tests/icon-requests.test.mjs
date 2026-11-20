/**
 * Who may ask the server for an icon, and what an import is allowed to name.
 *
 * The icon route learns a hostname every time it is asked, so a sweep is a list of the sites in a
 * vault. Two paths used to walk that list without anyone asking: an import, and the top-up a page
 * ran on unlock. Both are gone, and the decision lives in `sweepHosts`, so a caller that does not
 * say who asked gets no host back. These cases drive the real queue and the real request path with
 * `fetch` counted, which is the only way "no request" and "a request per host" are distinguishable.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { addBookmark, createDocument, updateBookmark } from '../public/bookmarks.js';
import { importPlain, mergeInto } from '../public/import-export.js';
import { fetchIconOutcome, sweepHosts } from '../public/icons.js';
import { tileFor } from '../public/tiles.js';

const publicDir = join(dirname(dirname(fileURLToPath(import.meta.url))), 'public');

const NOW = Date.UTC(2026, 0, 1, 9, 0, 0);
const now = () => NOW;

/* A 1x1 PNG, which is the shape a stored icon has. */
const PICTURE =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const FILE_HOSTS = Array.from({ length: 40 }, (_, index) => `site-${String(index).padStart(2, '0')}.example`);

/** The file an import brings: one entry per host, with nothing to say about icons. */
function importFile(hosts = FILE_HOSTS) {
  return hosts.map((host, index) => ({ url: `https://${host}/read/${index}`, name: `Site ${index}` }));
}

function importedDocument() {
  return importPlain(importFile(), now).document;
}

/* Node has Blob and Response but no FileReader, and `shrink` falls back to one. A 404 never
   reaches that path, but the stub keeps the module's own shape rather than a branch invented for
   this file. */
class StubFileReader {
  readAsDataURL(blob) {
    blob
      .arrayBuffer()
      .then((buffer) => {
        this.result = `data:${blob.type};base64,${Buffer.from(buffer).toString('base64')}`;
        this.onload?.();
      })
      .catch((error) => {
        this.error = error;
        this.onerror?.();
      });
  }
}

/** Runs `body` with every `fetch` recorded, answering "this host has no icon". */
async function withCountedFetch(body) {
  const originalFetch = globalThis.fetch;
  const previousReader = globalThis.FileReader;
  const asked = [];

  globalThis.fetch = async (url, options) => {
    asked.push({ url: String(url), host: options?.headers?.['x-icon-host'] ?? null });
    return new Response(null, { status: 404, headers: { 'cache-control': 'no-store' } });
  };
  globalThis.FileReader = StubFileReader;

  try {
    return { asked, result: await body() };
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.FileReader = previousReader;
  }
}

test('a sweep asks each host once, and only when a person asked for it', () => {
  const hosts = ['a.example', 'a.example', '', 'b.example', null];

  assert.deepEqual(sweepHosts(hosts), [], 'no grant, no host');
  assert.deepEqual(sweepHosts(hosts, {}), [], 'an empty option is not a grant');
  assert.deepEqual(sweepHosts(hosts, { explicit: 'yes' }), [], 'only true is a grant');
  assert.deepEqual(sweepHosts(hosts, { explicit: true }), ['a.example', 'b.example'], 'each host once, blanks dropped');
});

test('importing a file sends the server no hostname at all', async () => {
  const document = importedDocument();
  assert.equal(document.bookmarks.length, FILE_HOSTS.length, 'the file landed in full');

  /* What the page does after an import: it hands the hosts it would sweep to the same function the
     Settings action uses. An import carries no grant, so the list is empty. */
  const hosts = sweepHosts(document.bookmarks.map((bookmark) => bookmark.hostname));

  const { asked } = await withCountedFetch(async () => {
    for (const host of hosts) await fetchIconOutcome(host);
  });

  assert.deepEqual(hosts, [], 'the import offered the sweep nothing to ask');
  assert.equal(asked.length, 0, `an import of ${FILE_HOSTS.length} bookmarks made ${asked.length} requests`);
});

test('the Settings action reaches a host, one request per host, each naming it', async () => {
  /* The other half of the case above: the same document, the same code, with the grant a person's
     own request carries. Without this, "zero requests" could be a harness that never counted. */
  const document = importedDocument();
  const hosts = sweepHosts(
    document.bookmarks.map((bookmark) => bookmark.hostname),
    { explicit: true }
  );
  assert.equal(hosts.length, FILE_HOSTS.length, 'an explicit run covers every host missing an icon');

  /* Four, not forty: the queue paces request starts at the ceiling's own gap, and the property
     under test is one request per host, not how many fit in a minute. */
  const { asked } = await withCountedFetch(async () => {
    for (const host of hosts.slice(0, 4)) await fetchIconOutcome(host);
  });

  assert.equal(asked.length, 4, 'one request per host asked');
  for (const call of asked) {
    assert.equal(call.url.startsWith('/api/icon?h='), true, 'the request is same-origin and carries only a hash');
    assert.equal(FILE_HOSTS.includes(call.host), true, `the request named ${call.host}, which is not a host of the file`);
  }
});

test('the page starts a sweep only from a request, and never on unlock', () => {
  const source = readFileSync(join(publicDir, 'app.js'), 'utf8');

  const calls = [];
  for (const match of source.matchAll(/fetchMissingIcons\(([^)]*)\)/g)) {
    const before = source.slice(Math.max(0, match.index - 30), match.index);
    if (/function\s*$/.test(before)) continue;
    calls.push(match[1]);
  }

  assert.ok(calls.length >= 1, 'expected the page to call the sweep somewhere');
  for (const args of calls) {
    assert.match(args, /explicit:\s*true/, `a sweep called with "${args}" names hosts nobody asked for`);
  }

  /* The unlock top-up walked the library by itself. A name here means an unattended sweep is back,
     whether or not it reaches `fetchMissingIcons`. */
  assert.equal(source.includes('scheduleIconTopUp'), false, 'the page runs an icon sweep nobody asked for');
});

test('an import keeps a stored icon, and a row without one still draws its letter', () => {
  const { document: start, bookmark } = addBookmark(
    createDocument(),
    { url: 'https://cached.example/one', name: 'Cached' },
    now
  );
  const withIcon = updateBookmark(start, bookmark.id, { icon: PICTURE }, now);

  const merged = mergeInto(withIcon, importedDocument(), now, { device: 'test-device' }).document;

  const kept = merged.bookmarks.find((entry) => entry.id === bookmark.id);
  assert.equal(kept.icon, PICTURE, 'the icon the vault already held still paints');

  const bare = merged.bookmarks.find((entry) => entry.hostname === FILE_HOSTS[0]);
  assert.ok(bare, 'the imported bookmark is in the list');
  assert.equal(bare.icon, null, 'an import brings no icon, so the row is a lettered tile');
  assert.equal(tileFor(bare).initial, 'S', 'and the tile it falls back to reads its name');
  assert.equal(
    merged.bookmarks.filter((entry) => entry.icon).length,
    1,
    'nothing but the stored icon was filled in'
  );
});
