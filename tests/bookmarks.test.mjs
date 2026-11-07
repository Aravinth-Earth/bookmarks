/**
 * The document model: adding, editing, deleting, ordering and converging.
 *
 * Timestamps are fixed constants rather than the wall clock, so each merge case names the
 * ordering it depends on. Every refusal is paired with the acceptance it protects.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_BOOKMARKS,
  MAX_NAME_LENGTH,
  MAX_URL_LENGTH,
  SCHEMA,
  TOMBSTONE_DAYS,
  addBookmark,
  createDocument,
  deleteBookmark,
  filterBookmarks,
  mergeDocuments,
  normalizeUrl,
  recordClick,
  sortBookmarks,
  togglePin,
  updateBookmark
} from '../public/w/bookmarks/bookmarks.js';

const T1 = Date.UTC(2026, 0, 1, 10, 0, 0);
const T2 = Date.UTC(2026, 0, 2, 10, 0, 0);
const T3 = Date.UTC(2026, 0, 3, 10, 0, 0);

const at = (moment) => () => moment;
const iso = (moment) => new Date(moment).toISOString();

function seed() {
  return addBookmark(createDocument(), { url: 'example.com', name: 'Example' }, at(T1));
}

function record(overrides = {}) {
  const created = iso(T1);
  return {
    id: 'id-1',
    url: 'https://example.com/',
    hostname: 'example.com',
    origin: 'https://example.com',
    name: 'Example',
    clickCount: 0,
    pinned: false,
    hideLabel: false,
    icon: null,
    createdAt: created,
    updatedAt: created,
    lastClickedAt: null,
    ...overrides
  };
}

function doc(bookmarks = [], tombstones = []) {
  return { schema: SCHEMA, bookmarks, tombstones, prefs: { iconOnly: false } };
}

test('normalizeUrl accepts http and https, and adds the scheme when it is missing', () => {
  assert.equal(normalizeUrl('example.com').url, 'https://example.com/');
  assert.equal(normalizeUrl('  https://Example.COM/Path  ').url, 'https://example.com/Path');
  assert.equal(normalizeUrl('http://example.com/a?b=1#c').url, 'http://example.com/a?b=1#c');
  assert.equal(normalizeUrl('example.com').hostname, 'example.com');
  assert.equal(normalizeUrl('localhost:8080').url, 'https://localhost:8080/');
});

test('normalizeUrl refuses a scheme that is not a bookmark', () => {
  for (const bad of ['', '   ', 'javascript:alert(1)', 'data:text/html,hi', 'file:///etc/passwd']) {
    assert.throws(() => normalizeUrl(bad), /URL|scheme|bookmark/, `"${bad}" must be refused`);
  }
  assert.throws(() => normalizeUrl('ftp://example.com'), /scheme/);
  assert.throws(() => normalizeUrl('https://nodot'), /host/);
  assert.throws(() => normalizeUrl(`https://example.com/${'a'.repeat(MAX_URL_LENGTH)}`), /characters/);
});

test('createDocument is empty, schema 1, and carries preferences', () => {
  const document = createDocument();
  assert.equal(document.schema, SCHEMA);
  assert.deepEqual(document.bookmarks, []);
  assert.deepEqual(document.tombstones, []);
  assert.equal(document.prefs.iconOnly, false);
});

test('addBookmark stores the normalised URL and the defaults', () => {
  const { document, bookmark } = seed();

  assert.equal(document.bookmarks.length, 1);
  assert.equal(bookmark.url, 'https://example.com/');
  assert.equal(bookmark.hostname, 'example.com');
  assert.equal(bookmark.name, 'Example');
  assert.equal(bookmark.search, '');
  assert.equal(bookmark.clickCount, 0);
  assert.equal(bookmark.pinned, false);
  assert.equal(bookmark.icon, null);
  assert.equal(bookmark.lastClickedAt, null);
  assert.equal(bookmark.createdAt, iso(T1));
  assert.ok(bookmark.id);
});

test('addBookmark refuses a duplicate URL and names the existing record', () => {
  const { document, bookmark } = seed();

  assert.throws(
    () => addBookmark(document, { url: 'https://example.com' }, at(T2)),
    (error) => error.code === 'DUPLICATE' && error.existingId === bookmark.id
  );
  assert.equal(document.bookmarks.length, 1, 'the refusal changes nothing');
});

test('addBookmark refuses a full vault and a bad name or count', () => {
  const full = doc(Array.from({ length: MAX_BOOKMARKS }, (_, index) => record({ id: `id-${index}` })));
  assert.throws(() => addBookmark(full, { url: 'extra.com' }, at(T2)), /at most 500/);

  const empty = createDocument();
  assert.throws(
    () => addBookmark(empty, { url: 'a.com', name: 'x'.repeat(MAX_NAME_LENGTH + 1) }, at(T2)),
    /characters/
  );
  assert.throws(() => addBookmark(empty, { url: 'a.com', clickCount: -1 }, at(T2)), /whole number/);
  assert.throws(() => addBookmark(empty, { url: 'a.com', clickCount: 1.5 }, at(T2)), /whole number/);
  assert.doesNotReject(async () => addBookmark(empty, { url: 'a.com', clickCount: 7 }, at(T2)));
});

test('updateBookmark changes only what it is given, and re-checks a changed URL', () => {
  const first = seed();
  const second = addBookmark(first.document, { url: 'other.com', name: 'Other' }, at(T1)).document;
  const target = second.bookmarks[0];

  const renamed = updateBookmark(second, target.id, { name: 'Renamed' }, at(T2));
  const after = renamed.bookmarks.find((bookmark) => bookmark.id === target.id);
  assert.equal(after.name, 'Renamed');
  assert.equal(after.url, target.url, 'the URL is untouched');
  assert.equal(after.updatedAt, iso(T2));

  assert.throws(
    () => updateBookmark(second, target.id, { url: 'https://other.com' }, at(T2)),
    (error) => error.code === 'DUPLICATE'
  );
  assert.throws(() => updateBookmark(second, 'missing', { name: 'x' }, at(T2)), /no bookmark/);
  assert.throws(
    () => updateBookmark(second, target.id, { clickCount: -3 }, at(T2)),
    /whole number/
  );
});

test('updateBookmark ignores a field it does not own', () => {
  const { document, bookmark } = seed();
  const updated = updateBookmark(document, bookmark.id, { id: 'hijacked', schema: 9 }, at(T2));
  const after = updated.bookmarks[0];
  assert.equal(after.id, bookmark.id);
  assert.equal(updated.schema, SCHEMA);
});

test('deleteBookmark removes the record and leaves a tombstone', () => {
  const { document, bookmark } = seed();
  const after = deleteBookmark(document, bookmark.id, at(T2));

  assert.equal(after.bookmarks.length, 0);
  assert.deepEqual(after.tombstones, [{ id: bookmark.id, deletedAt: iso(T2) }]);
  assert.throws(() => deleteBookmark(document, 'missing', at(T2)), /no bookmark/);
});

test('recordClick increments the count and stamps the moment', () => {
  const { document, bookmark } = seed();
  const clicked = recordClick(document, bookmark.id, at(T2)).bookmarks[0];

  assert.equal(clicked.clickCount, 1);
  assert.equal(clicked.lastClickedAt, iso(T2));
  assert.equal(clicked.updatedAt, iso(T2));
  assert.throws(() => recordClick(document, 'missing', at(T2)), /no bookmark/);
});

test('togglePin flips the flag and nothing else', () => {
  const { document, bookmark } = seed();
  const pinned = togglePin(document, bookmark.id, at(T2)).bookmarks[0];
  assert.equal(pinned.pinned, true);
  assert.equal(pinned.clickCount, bookmark.clickCount);

  const unpinned = togglePin(togglePin(document, bookmark.id, at(T2)), bookmark.id, at(T3))
    .bookmarks[0];
  assert.equal(unpinned.pinned, false);
});

test('filterBookmarks matches the hidden search term an import carries', () => {
  const { document } = addBookmark(
    createDocument(),
    { url: 'wolframalpha.com', name: '', search: 'Wolfram Alpha' },
    at(T1)
  );
  assert.equal(filterBookmarks(document, 'wolfram alpha').length, 1);
  assert.equal(filterBookmarks(document, 'nothing').length, 0);
});

test('filterBookmarks matches the name, the host and the URL, case-insensitively', () => {
  const one = seed();
  const two = addBookmark(one.document, { url: 'https://news.example.org/x', name: 'News' }, at(T1));
  const document = two.document;

  assert.equal(filterBookmarks(document, '').length, 2);
  assert.equal(filterBookmarks(document, '   ').length, 2);
  assert.equal(filterBookmarks(document, 'EXAMPLE').length, 2);
  assert.equal(filterBookmarks(document, 'news').length, 1);
  assert.equal(filterBookmarks(document, '/x').length, 1);
  assert.equal(filterBookmarks(document, 'nothing').length, 0);
});

test('sortBookmarks orders by each mode, with pinned first where names do not matter', () => {
  let document = createDocument();
  document = addBookmark(document, { url: 'b.com', name: 'Beta' }, at(T1)).document;
  document = addBookmark(document, { url: 'a.com', name: 'Alpha' }, at(T2)).document;
  document = addBookmark(document, { url: 'c.com', name: 'Gamma' }, at(T3)).document;
  document = recordClick(document, document.bookmarks[0].id, at(T3));

  assert.deepEqual(
    sortBookmarks(document, 'clicks').map((bookmark) => bookmark.name),
    ['Beta', 'Alpha', 'Gamma']
  );
  assert.deepEqual(
    sortBookmarks(document, 'recent').map((bookmark) => bookmark.name),
    ['Gamma', 'Alpha', 'Beta']
  );
  assert.deepEqual(
    sortBookmarks(document, 'name').map((bookmark) => bookmark.name),
    ['Alpha', 'Beta', 'Gamma']
  );
  assert.deepEqual(
    sortBookmarks(document, 'lastClicked').map((bookmark) => bookmark.name),
    ['Beta', 'Alpha', 'Gamma']
  );

  const pinned = togglePin(document, document.bookmarks[1].id, at(T3));
  assert.equal(sortBookmarks(pinned, 'clicks')[0].name, 'Alpha', 'pinned leads the click order');
  assert.equal(sortBookmarks(pinned, 'name')[0].name, 'Alpha', 'the name order is unaffected');

  assert.throws(() => sortBookmarks(document, 'random'), /sort mode/);
});

test('mergeDocuments unions two devices with no shared bookmark', () => {
  const left = doc([record({ id: 'a' })]);
  const right = doc([record({ id: 'b', url: 'https://b.com/', hostname: 'b.com' })]);

  const { document, statistics } = mergeDocuments(left, right, at(T3));
  assert.deepEqual(document.bookmarks.map((bookmark) => bookmark.id).sort(), ['a', 'b']);
  assert.equal(statistics.added, 1);
  assert.equal(statistics.removed, 0);
});

test('merge takes the newer fields, the larger click count and the earlier creation', () => {
  const left = record({ id: 'a', name: 'Old', updatedAt: iso(T1), clickCount: 2 });
  const right = record({
    id: 'a',
    name: 'New',
    updatedAt: iso(T2),
    clickCount: 5,
    createdAt: iso(T2),
    lastClickedAt: iso(T2)
  });

  const { document, statistics } = mergeDocuments(doc([left]), doc([right]), at(T3));
  const merged = document.bookmarks[0];

  assert.equal(merged.name, 'New', 'the later edit wins the field');
  assert.equal(merged.clickCount, 5, 'clicks take the larger side');
  assert.equal(merged.createdAt, iso(T1), 'creation takes the earlier side');
  assert.equal(merged.lastClickedAt, iso(T2));
  assert.equal(statistics.updated, 1);
});

test('a tombstone removes the record the other device still holds', () => {
  const left = record({ id: 'a', updatedAt: iso(T1) });
  const tombstone = { id: 'a', deletedAt: iso(T2) };

  const { document, statistics } = mergeDocuments(doc([left]), doc([], [tombstone]), at(T3));
  assert.equal(document.bookmarks.length, 0);
  assert.deepEqual(document.tombstones, [tombstone], 'the deletion is carried forward');
  assert.equal(statistics.removed, 1);
});

test('an edit after a deletion survives, because it is strictly newer', () => {
  const edited = record({ id: 'a', updatedAt: iso(T3) });
  const tombstone = { id: 'a', deletedAt: iso(T2) };

  const { document } = mergeDocuments(doc([edited]), doc([], [tombstone]), at(T3));
  assert.equal(document.bookmarks.length, 1);
  assert.deepEqual(document.tombstones, [], 'the resolved tombstone is dropped');
});

test('a tombstone older than the limit is pruned', () => {
  const old = new Date(T1 - (TOMBSTONE_DAYS + 1) * 24 * 60 * 60 * 1000).toISOString();
  const { document } = mergeDocuments(doc(), doc([], [{ id: 'gone', deletedAt: old }]), at(T1));
  assert.deepEqual(document.tombstones, []);
});

test('mergeDocuments refuses a document that is not one', () => {
  assert.throws(() => mergeDocuments({}, doc(), at(T1)), /schema/);
  assert.throws(() => mergeDocuments(doc(), { schema: 1 }, at(T1)), /bookmarks and tombstones/);
});

test('no operation mutates the document it was given', () => {
  const { document, bookmark } = seed();
  const before = JSON.stringify(document);

  addBookmark(document, { url: 'second.com' }, at(T2));
  updateBookmark(document, bookmark.id, { name: 'Changed' }, at(T2));
  deleteBookmark(document, bookmark.id, at(T2));
  recordClick(document, bookmark.id, at(T2));
  togglePin(document, bookmark.id, at(T2));

  assert.equal(JSON.stringify(document), before);
});
