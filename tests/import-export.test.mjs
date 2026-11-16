/**
 * Importing the library that already exists, and exporting one that still will.
 *
 * The retired app's `sites.json` is the first shape these tests use, because it is the only
 * input that actually exists: 194 entries with `click_count`, `button_color` and dates. A file
 * with one bad URL must still land its good ones.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_BOOKMARKS,
  addBookmark,
  createDocument,
  deleteBookmark,
  recordClick,
  updateBookmark
} from '../public/bookmarks.js';
import {
  MAX_IMPORT_BYTES,
  PLAIN_FORMAT,
  SEALED_FORMAT,
  exportBrowserBookmarks,
  exportPlain,
  exportSealed,
  importBrowserBookmarks,
  importPlain,
  mergeInto,
  parseSealed
} from '../public/import-export.js';

const T1 = Date.UTC(2025, 11, 26, 10, 30, 0);
const T2 = Date.UTC(2025, 11, 27, 15, 45, 0);
const NOW = Date.UTC(2026, 0, 1);
const now = () => NOW;

const LEGACY = [
  {
    url: 'https://example.com',
    name: 'Example',
    click_count: 42,
    button_color: '#4a90e2',
    is_familiar: true,
    created_date: '2025-12-26T10:30:00Z',
    last_updated: '2025-12-27T15:45:00Z'
  },
  {
    url: 'github.com',
    name: '',
    actual_name: 'GitHub',
    click_count: 7,
    button_color: 'not-a-colour'
  },
  { url: 'nameless.example', name: '', actual_name: '' },
  { url: 'javascript:alert(1)', name: 'Nope', click_count: 1 }
];

test('the retired sites.json imports, with its dates, colours and click counts', () => {
  const { document, statistics } = importPlain(LEGACY, now);

  assert.equal(statistics.imported, 3);
  assert.equal(statistics.skipped, 1);
  assert.equal(statistics.duplicates, 0);
  assert.equal(document.bookmarks.length, 3);

  const example = document.bookmarks.find((bookmark) => bookmark.hostname === 'example.com');
  assert.equal(example.url, 'https://example.com/');
  assert.equal(example.name, 'Example');
  assert.equal(example.clickCount, 42);
  assert.equal(example.color, '#4a90e2');
  assert.equal(example.createdAt, new Date(T1).toISOString());
  assert.equal(example.updatedAt, new Date(T2).toISOString());
  assert.equal(example.hideLabel, true, 'is_familiar means icon-only');

  const github = document.bookmarks.find((bookmark) => bookmark.hostname === 'github.com');
  assert.equal(github.name, '', 'actual_name is never promoted to a label');
  assert.equal(github.search, 'GitHub', 'it is kept as a hidden search term');
  assert.equal(github.url, 'https://github.com/');
  assert.equal(github.color, null, 'an invalid colour is dropped, not stored');
  assert.equal(github.hideLabel, true, 'an unnamed entry stays an icon-only pill');

  const nameless = document.bookmarks.find((bookmark) => bookmark.hostname === 'nameless.example');
  assert.equal(nameless.hideLabel, true, 'no label means an icon-only pill');
});

test('a plain export and a bare document both import', () => {
  const first = importPlain(LEGACY, now).document;

  const fromWrapper = importPlain(exportPlain(first, now), now);
  assert.equal(fromWrapper.statistics.imported, 3);
  assert.equal(fromWrapper.document.bookmarks.length, 3);

  const fromDocument = importPlain(first, now);
  assert.equal(fromDocument.statistics.imported, 3);
  assert.equal(fromDocument.document.bookmarks.length, 3);
});

test('a duplicate inside one import is counted, not added twice', () => {
  const { document, statistics } = importPlain(
    [
      { url: 'example.com', name: 'One' },
      { url: 'https://example.com', name: 'Two' }
    ],
    now
  );

  assert.equal(statistics.imported, 1);
  assert.equal(statistics.duplicates, 1);
  assert.equal(document.bookmarks.length, 1);
  assert.equal(document.bookmarks[0].name, 'One');

  /* The dialog names the offender, so the count alone is not enough: the second row of the file
     is the one that was dropped, and it has to be identifiable. */
  assert.deepEqual(statistics.repeats, [{ url: 'https://example.com', name: 'Two' }]);
});

test('a malformed payload is refused rather than half-read', () => {
  assert.throws(() => importPlain('{not json', now), /not JSON/);
  assert.throws(() => importPlain({ hello: 'world' }, now), /not a bookmark export/);
  assert.throws(() => importPlain(42, now), /not a bookmark export/);
  assert.throws(() => importPlain(null, now), /not a bookmark export/);
});

test('merging an import matches by URL and applies the same rules as a sync', () => {
  const existing = importPlain(
    [{ url: 'example.com', name: 'Existing', click_count: 5, last_updated: '2026-01-02T00:00:00' }],
    now
  ).document;

  const incoming = importPlain(
    [
      /* Older edit: the existing name wins, the larger click count survives. */
      { url: 'example.com', name: 'Stale', click_count: 3, last_updated: '2026-01-01T00:00:00' },
      { url: 'new.example.org', name: 'Fresh', click_count: 1 }
    ],
    now
  ).document;

  const { document, statistics } = mergeInto(existing, incoming, now);
  assert.equal(statistics.updated, 1);
  assert.equal(statistics.added, 1);
  assert.equal(statistics.skipped, 0);
  assert.equal(document.bookmarks.length, 2);

  const example = document.bookmarks.find((bookmark) => bookmark.hostname === 'example.com');
  assert.equal(example.name, 'Existing');
  assert.equal(example.clickCount, 5);

  assert.ok(document.bookmarks.some((bookmark) => bookmark.hostname === 'new.example.org'));
});

test('a merge stops at the limit and reports what it left out', () => {
  const full = {
    schema: 1,
    tombstones: [],
    prefs: { iconOnly: false },
    bookmarks: Array.from({ length: MAX_BOOKMARKS }, (_, index) => ({
      id: `id-${index}`,
      url: `https://site-${index}.example/`,
      hostname: `site-${index}.example`,
      origin: `https://site-${index}.example`,
      name: '',
      clickCount: 0,
      pinned: false,
      hideLabel: false,
      icon: null,
      color: null,
      createdAt: new Date(NOW).toISOString(),
      updatedAt: new Date(NOW).toISOString(),
      lastClickedAt: null
    }))
  };
  const incoming = importPlain([{ url: 'one-more.example' }], now).document;

  const { document, statistics } = mergeInto(full, incoming, now);
  assert.equal(statistics.added, 0);
  assert.equal(statistics.skipped, 1);
  assert.equal(document.bookmarks.length, MAX_BOOKMARKS);
});

test('a browser bookmark file imports, decoding entities and keeping the added date', () => {
  const html = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<DL><p>
    <DT><A HREF="https://news.example.com/?a=1&amp;b=2" ADD_DATE="1766232000">News &amp; Views</A>
    <DT><A HREF="https://tools.example.org/">Tools &#39;n&#39; things</A>
    <DT><A HREF="javascript:alert(1)">Bookmarklet</A>
    <DT><A HREF="place:type=6">Recent</A>
</DL><p>`;

  const { document, statistics } = importBrowserBookmarks(html, now);
  assert.equal(statistics.imported, 2);
  assert.equal(document.bookmarks.length, 2);

  const news = document.bookmarks.find((bookmark) => bookmark.hostname === 'news.example.com');
  assert.equal(news.name, 'News & Views');
  assert.equal(news.url, 'https://news.example.com/?a=1&b=2');
  assert.equal(news.createdAt, new Date(1766232000 * 1000).toISOString());

  const tools = document.bookmarks.find((bookmark) => bookmark.hostname === 'tools.example.org');
  assert.equal(tools.name, "Tools 'n' things");
});

test('a name with a formed tag inside it loses every tag, not only the first pass', () => {
  const html = '<DL><DT><A HREF="https://nested.example/"><<b>Nested</b></A></DL>';
  const { document } = importBrowserBookmarks(html, now);
  assert.equal(document.bookmarks[0].name, 'Nested');
});

test('an import larger than the limit is refused before it is parsed', () => {
  const huge = 'x'.repeat(MAX_IMPORT_BYTES + 1);

  assert.throws(() => importPlain(huge, now), /too large/);
  assert.throws(() => importBrowserBookmarks(huge, now), /too large/);
});

test('a file of unclosed anchors is scanned in linear time', () => {
  /* The old expression rescanned the rest of the file from every `<a`, which is quadratic: this
     input took seconds and a larger one froze the tab. The scan has to finish without revisiting
     the tail, and an anchor with no closing tag is not an entry. */
  const html = '<a href="https://example.com/">'.repeat(30_000);
  const started = Date.now();
  const { document } = importBrowserBookmarks(html, now);
  const elapsed = Date.now() - started;

  assert.equal(document.bookmarks.length, 0);
  assert.ok(elapsed < 1000, `the scan took ${elapsed}ms`);
});

test('a wrapper inside a wrapper is refused, and one wrapper still imports', () => {
  const document = importPlain(LEGACY, now).document;
  const refused = (error) =>
    error.code === 'INVALID_IMPORT' && /wrapped more than once/.test(error.message);

  assert.throws(
    () => importPlain({ format: PLAIN_FORMAT, document: exportPlain(document, now) }, now),
    refused
  );

  /* A file can nest its own envelope as deep as it likes, and following them all used to spend
     the stack until the tab gave up. The second envelope is refused where it is found. */
  let nested = document;
  for (let depth = 0; depth < 50_000; depth += 1) {
    nested = { format: PLAIN_FORMAT, document: nested };
  }
  assert.throws(() => importPlain(nested, now), refused);

  const fromOneWrapper = importPlain(exportPlain(document, now), now);
  assert.equal(fromOneWrapper.statistics.imported, 3);
  assert.deepEqual(
    fromOneWrapper.document.bookmarks.map((bookmark) => bookmark.url).sort(),
    document.bookmarks.map((bookmark) => bookmark.url).sort()
  );
});

test('a browser export re-imports to the same two bookmarks', () => {
  const original = importPlain(LEGACY, now).document;
  const html = exportBrowserBookmarks(original);

  assert.match(html, /^<!DOCTYPE NETSCAPE-Bookmark-file-1>/);
  assert.match(html, /<A HREF="https:\/\/example\.com\/"/i);

  const again = importBrowserBookmarks(html, now);
  assert.equal(again.statistics.imported, 3);
  assert.deepEqual(
    again.document.bookmarks.map((bookmark) => bookmark.url).sort(),
    original.bookmarks.map((bookmark) => bookmark.url).sort()
  );
});

test('a sealed backup round-trips and refuses anything else', () => {
  const sealed = { iv: 'abcdefghijkl', ct: 'opqrstuvwxyz' };
  const envelope = exportSealed(sealed, now);

  assert.equal(envelope.format, SEALED_FORMAT);
  assert.deepEqual(parseSealed(envelope), sealed);
  assert.deepEqual(parseSealed(JSON.stringify(envelope)), sealed);

  assert.throws(() => parseSealed({ format: 'other/1' }), /not a sealed backup/);
  assert.throws(() => parseSealed({ format: SEALED_FORMAT }), /no sealed vault/);
  assert.throws(() => parseSealed('{not json'), /not JSON/);
  assert.throws(() => exportSealed(null, now), /no sealed vault/);
});

test('the plain export names its format and carries the document untouched', () => {
  const document = importPlain(LEGACY, now).document;
  const envelope = exportPlain(document, now);

  assert.equal(envelope.format, PLAIN_FORMAT);
  assert.equal(envelope.document, document);
  assert.equal(envelope.exported_at, new Date(NOW).toISOString());
  assert.deepEqual(createDocument().bookmarks, []);
});

test('a plain export brought back into an empty vault is the vault it was taken from', () => {
  /* Every field the model defines is set to something other than its default, so a field the
     import drops cannot pass by looking like one that was never there. */
  const T0 = Date.UTC(2025, 5, 1, 9, 0, 0);
  const T1 = Date.UTC(2025, 5, 2, 9, 0, 0);
  const T2 = Date.UTC(2025, 5, 3, 9, 0, 0);
  const T3 = Date.UTC(2025, 5, 4, 9, 0, 0);
  const at = (moment) => () => moment;

  const added = addBookmark(
    createDocument(),
    {
      url: 'https://example.com/deep',
      name: 'Example',
      search: 'Hidden Title',
      clickCount: 7,
      uses: { 'device-one': 4 },
      hideLabel: true
    },
    at(T0)
  );
  const clickedId = added.bookmark.id;

  let document = updateBookmark(
    added.document,
    clickedId,
    { pinned: true, icon: 'data:image/png;base64,AAAA', color: '#ff0000' },
    at(T1)
  );
  document = recordClick(document, clickedId, at(T2), { device: 'device-one' });

  const gone = addBookmark(document, { url: 'https://gone.example/', name: 'Gone' }, at(T0));
  document = deleteBookmark(gone.document, gone.bookmark.id, at(T3));
  document = { ...document, prefs: { ...document.prefs, iconOnly: true, sort: 'recent' } };

  /* The fields the equality below is about, named once so a later edit that stops setting one
     cannot make the test pass by comparing two defaults. */
  const exported = document.bookmarks[0];
  assert.equal(exported.pinned, true);
  assert.equal(exported.icon, 'data:image/png;base64,AAAA');
  assert.equal(exported.color, '#ff0000');
  assert.equal(exported.lastClickedAt, new Date(T2).toISOString());
  assert.equal(document.tombstones.length, 1);
  assert.equal(document.prefs.iconOnly, true);

  const file = JSON.stringify(exportPlain(document, at(T3)));
  const { document: back, statistics } = importPlain(file, at(T3));

  assert.equal(statistics.imported, 1);
  assert.deepEqual(back.bookmarks, document.bookmarks, 'every field of every record crosses');
  assert.deepEqual(back.tombstones, document.tombstones, 'the deletion crosses with it');
  assert.deepEqual(back.prefs, document.prefs, 'the view it was taken from crosses too');

  /* A count that arrives from a file still leaves one line, and the line the file carried for
     the record it describes is still filed under that record. */
  assert.ok(
    back.activity.some((event) => event.bookmarkId === clickedId && event.cause === 'click'),
    'the click the file recorded is still filed under the bookmark'
  );
  assert.ok(
    back.activity.some((event) => event.bookmarkId === clickedId && event.cause === 'import'),
    'the count that arrived from the file left a line'
  );
});

test('a file that repeats an id still gives each record its own', () => {
  /* Identity crosses with the record, so a file naming one id twice must not produce two
     records that answer to it: every later lookup would find the first. */
  const { document, statistics } = importPlain(
    [
      { id: 'same', url: 'https://one.example/', name: 'One' },
      { id: 'same', url: 'https://two.example/', name: 'Two' }
    ],
    now
  );

  assert.equal(statistics.imported, 2);
  assert.equal(document.bookmarks[0].id, 'same', 'the first keeps the id the file gave it');
  assert.equal(new Set(document.bookmarks.map((bookmark) => bookmark.id)).size, 2);
});

test('a document round-trip keeps the label choice it was exported with', () => {
  const document = importPlain(
    [{ url: 'quiet.example', name: '', hideLabel: false }],
    now
  ).document;

  assert.equal(document.bookmarks[0].hideLabel, false);
  assert.equal(document.bookmarks[0].name, '');

  const again = importPlain(exportPlain(document, now), now).document;
  assert.equal(again.bookmarks[0].hideLabel, false, 'an explicit false survives the round-trip');
});
