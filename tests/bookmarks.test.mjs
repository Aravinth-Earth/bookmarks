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
  SEARCH_CLEAR_DELAY_MS,
  TOMBSTONE_DAYS,
  addBookmark,
  createDocument,
  deleteBookmark,
  filterBookmarks,
  mergeDocuments,
  newerPrefs,
  normalizeUrl,
  recordClick,
  searchNarrowsList,
  sortBookmarks,
  togglePin,
  updateBookmark
} from '../public/bookmarks.js';

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

test('updateBookmark sets and clears hideLabel in one patch', () => {
  const { document, bookmark } = seed();
  const hidden = updateBookmark(document, bookmark.id, { hideLabel: true }, at(T2));
  const after = hidden.bookmarks[0];

  assert.equal(after.hideLabel, true);
  assert.equal(after.name, bookmark.name, 'the name is untouched');
  assert.equal(after.clickCount, bookmark.clickCount, 'the count is untouched');
  assert.equal(after.updatedAt, iso(T2));
  assert.equal(hidden.bookmarks.length, 1);

  const shown = updateBookmark(hidden, bookmark.id, { hideLabel: false }, at(T3));
  assert.equal(shown.bookmarks[0].hideLabel, false);
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

test('searchNarrowsList is true only while a query hides some of the list', () => {
  const one = seed();
  const two = addBookmark(one.document, { url: 'https://news.example.org/x', name: 'News' }, at(T1));
  const document = two.document;

  assert.equal(searchNarrowsList(document, ''), false);
  assert.equal(searchNarrowsList(document, '   '), false);
  /* Every bookmark matches, so the list is what it was before the search. */
  assert.equal(searchNarrowsList(document, 'example'), false);
  assert.equal(searchNarrowsList(document, 'news'), true);
  assert.equal(searchNarrowsList(document, 'nothing'), true);
});

test('SEARCH_CLEAR_DELAY_MS pauses for about five seconds', () => {
  assert.equal(Number.isInteger(SEARCH_CLEAR_DELAY_MS), true);
  assert.equal(SEARCH_CLEAR_DELAY_MS, 5000);
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

test('newerPrefs takes the stamped side, and the later stamp when both carry one', () => {
  const legacy = { iconOnly: false };
  const older = { iconOnly: false, sort: 'name', view: 'list', updatedAt: T1 };
  const newer = { iconOnly: false, sort: 'lastClicked', view: 'pills', updatedAt: T2 };

  assert.deepEqual(newerPrefs(legacy, older), older, 'a stamped copy beats an unstamped one');
  assert.deepEqual(newerPrefs(older, legacy), older, 'and it beats it from either side');
  assert.deepEqual(newerPrefs(older, newer), newer, 'the later stamp wins');
  assert.deepEqual(newerPrefs(newer, older), newer, 'whichever side it is on');
  assert.deepEqual(
    newerPrefs(older, { ...older }),
    older,
    'an equal stamp keeps the local copy'
  );
  assert.deepEqual(
    newerPrefs({ iconOnly: false, sort: 'name' }, { iconOnly: true }),
    { iconOnly: false, sort: 'name' },
    'with no stamp on either side the local copy is kept'
  );
  assert.deepEqual(newerPrefs(undefined, newer), newer, 'a document with no prefs takes the other');
});

/* Silently losing these is how collection switched itself off: the newer copy simply had never carried the key. */
test('newerPrefs keeps a preference the winning copy has never carried', () => {
  const withCollection = {
    iconOnly: false,
    view: 'pills',
    updatedAt: T1,
    collector: { enabled: true, minVisits: 1, sites: [], exclude: [] }
  };
  const newerWithoutIt = { iconOnly: false, view: 'pills', sort: 'name', updatedAt: T2 };

  const merged = newerPrefs(withCollection, newerWithoutIt);
  assert.deepEqual(merged.collector, withCollection.collector, 'the collection settings survive');
  assert.equal(merged.sort, 'name', 'and the newer copy still wins on what it carries');
  assert.equal(merged.updatedAt, T2, 'the newer stamp is the one kept');

  const other = newerPrefs(newerWithoutIt, withCollection);
  assert.deepEqual(other.collector, withCollection.collector, 'from either side');
});

test('a preference changed on this device survives a merge with an older server copy', () => {
  const localPrefs = { iconOnly: false, sort: 'clicks', updatedAt: T2 };
  const remotePrefs = { iconOnly: false, sort: 'name', updatedAt: T1 };
  const local = { ...doc([record({ id: 'a' })]), prefs: localPrefs };
  const remote = { ...doc([record({ id: 'a' })]), prefs: remotePrefs };

  const { document: kept } = mergeDocuments(local, remote, at(T3));
  assert.equal(kept.prefs.sort, 'clicks', 'the newer local sort is not replaced');
  assert.equal(kept.prefs.updatedAt, T2, 'the stamp travels with it');

  const newerRemote = {
    ...doc([record({ id: 'a' })]),
    prefs: { iconOnly: false, sort: 'lastClicked', updatedAt: T3 }
  };
  const { document: absorbed } = mergeDocuments(local, newerRemote, at(T3));
  assert.equal(absorbed.prefs.sort, 'lastClicked', 'a newer change on the server reaches here');
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


test('a bookmark counts every use: the ones opened here and the ones opened in the browser', async () => {
  const { addBookmark, recordUses, useCount } = await import('../public/bookmarks.js');

  const document = { schema: 1, bookmarks: [], tombstones: [], prefs: { iconOnly: false } };
  const { document: added, bookmark } = addBookmark(document, { url: 'https://a.example/x', name: 'A' });

  assert.deepEqual(bookmark.uses, {}, 'a new bookmark has been opened nowhere');
  assert.equal(useCount(bookmark), 0);

  const counted = recordUses(added, bookmark.id, 'device-one', 4);
  assert.equal(useCount(counted.bookmarks[0]), 4);
  assert.equal(recordUses(counted, bookmark.id, 'device-one', 4), counted, 'the same total is not a change');
  assert.equal(recordUses(counted, bookmark.id, 'device-one', 2), counted, 'a smaller total is ignored');

  /* A second device has its own slot, and the two are added: 4 here and 3 there is seven uses. */
  const both = recordUses(counted, bookmark.id, 'device-two', 3);
  assert.equal(useCount(both.bookmarks[0]), 7);
  assert.equal(recordUses(both, bookmark.id, 'device-two', 3), both, 'and the same slot twice is not');
});

test('a count splits into what this device saw and what the others saw', async () => {
  const { addBookmark, recordUses, useSplit } = await import('../public/bookmarks.js');

  const document = { schema: 1, bookmarks: [], tombstones: [], prefs: { iconOnly: false } };
  const { document: added, bookmark } = addBookmark(document, { url: 'https://a.example/x', name: 'A' });
  assert.deepEqual(useSplit(bookmark, 'device-one'), { here: 0, elsewhere: 0, total: 0 });

  const counted = recordUses(added, bookmark.id, 'device-one', 4);
  assert.deepEqual(useSplit(counted.bookmarks[0], 'device-one'), { here: 4, elsewhere: 0, total: 4 });

  /* The same vault read from either device: the total is shared, the split is not. */
  const both = recordUses(counted, bookmark.id, 'device-two', 3);
  assert.deepEqual(useSplit(both.bookmarks[0], 'device-one'), { here: 4, elsewhere: 3, total: 7 });
  assert.deepEqual(useSplit(both.bookmarks[0], 'device-two'), { here: 3, elsewhere: 4, total: 7 });

  /* The old single number and the old unnamed slot belong to the device asking. */
  const legacy = { ...both.bookmarks[0], uses: { legacy: 2, other: 1 }, clickCount: 5 };
  assert.deepEqual(useSplit(legacy, 'device-one'), { here: 7, elsewhere: 1, total: 8 });
});

test('a merge adds two devices\' slots and keeps the larger number inside one slot', async () => {
  const { mergeBookmark, useCount } = await import('../public/bookmarks.js');

  const base = {
    id: 'a',
    url: 'https://a.example/',
    clickCount: 1,
    uses: { one: 4, two: 1 },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  };
  const other = { ...base, uses: { one: 2, two: 6 }, updatedAt: '2026-01-02T00:00:00.000Z' };
  const merged = mergeBookmark(base, other);

  assert.deepEqual(merged.uses, { one: 4, two: 6 }, 'the larger number inside each slot');
  assert.equal(useCount(merged), 11, 'and the total is their sum, plus the one click');

  /* A merge is idempotent: the same two sides again is the same answer, which is what stops a count from growing
     every time the same blob is merged. */
  assert.deepEqual(mergeBookmark(merged, other).uses, { one: 4, two: 6 });

  /* A document that only ever had one number keeps it, in a slot of its own. */
  const legacy = { ...base, uses: undefined, openCount: 7 };
  assert.deepEqual(mergeBookmark(legacy, other).uses, { legacy: 7, one: 2, two: 6 });
});

test('two devices that counted the same bookmark add up, and merging again adds nothing', async () => {
  const { mergeDocuments, useCount } = await import('../public/bookmarks.js');

  const device = (deviceId, count, updatedAt) => ({
    schema: 1,
    bookmarks: [
      {
        id: 'same',
        url: 'https://a.example/',
        hostname: 'a.example',
        origin: 'https://a.example',
        name: 'A',
        search: '',
        clickCount: 0,
        uses: { [deviceId]: count },
        pinned: false,
        hideLabel: false,
        icon: null,
        color: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt,
        lastClickedAt: null
      }
    ],
    tombstones: [],
    prefs: { iconOnly: false }
  });

  const laptop = device('laptop', 3, '2026-01-02T00:00:00.000Z');
  const phone = device('phone', 2, '2026-01-03T00:00:00.000Z');

  const once = mergeDocuments(laptop, phone).document;
  assert.equal(useCount(once.bookmarks[0]), 5, 'three on one device and two on the other');

  const twice = mergeDocuments(once, phone).document;
  assert.equal(useCount(twice.bookmarks[0]), 5, 'merging the same device again adds nothing');

  const third = mergeDocuments(twice, device('tablet', 4, '2026-01-04T00:00:00.000Z')).document;
  assert.equal(useCount(third.bookmarks[0]), 9, 'a third device brings its own count');
});
