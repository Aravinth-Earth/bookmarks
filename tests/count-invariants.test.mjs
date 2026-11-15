/**
 * A count never falls, on every path that touches `uses` or `clickCount`.
 *
 * The per-device split is the explanation of where a total comes from, so each case reads the
 * total *and* the slots after the change. A path that keeps the sum right while moving a number
 * from one slot to another is still a loss: the device whose visits they were can no longer
 * account for them.
 *
 * The cases are the paths named in the audit: a click, an extension total, a merge, an edit, an
 * import and a legacy open count. Restore is the same merge with a backup on the right.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createDocument,
  mergeBookmark,
  mergeDocuments,
  normaliseUses,
  recordClick,
  recordUses,
  updateBookmark,
  useCount,
  useSplit
} from '../public/bookmarks.js';
import { importBrowserBookmarks, importPlain } from '../public/import-export.js';

const T1 = Date.UTC(2026, 0, 1, 10, 0, 0);
const T2 = Date.UTC(2026, 0, 2, 10, 0, 0);
const T3 = Date.UTC(2026, 0, 3, 10, 0, 0);

const at = (moment) => () => moment;
const iso = (moment) => new Date(moment).toISOString();

function record(overrides = {}) {
  const created = iso(T1);
  return {
    id: 'id-1',
    url: 'https://example.com/',
    hostname: 'example.com',
    origin: 'https://example.com',
    name: 'Example',
    search: '',
    clickCount: 0,
    uses: {},
    pinned: false,
    hideLabel: false,
    icon: null,
    color: null,
    createdAt: created,
    updatedAt: created,
    lastClickedAt: null,
    ...overrides
  };
}

function doc(bookmarks = [], tombstones = []) {
  return { schema: 1, bookmarks, tombstones, prefs: { iconOnly: false } };
}

/** The total and the slots in one reading, so a test can assert both without a second call. */
function reading(bookmark, device = 'device-a') {
  return {
    total: useCount(bookmark),
    uses: normaliseUses(bookmark.uses),
    split: useSplit(bookmark, device)
  };
}

test('a click raises the total by one and leaves every device slot where it was', () => {
  const before = record({ clickCount: 2, uses: { 'device-a': 5, 'device-b': 3 } });
  const after = recordClick(doc([before]), before.id, at(T2)).bookmarks[0];

  assert.equal(useCount(after), useCount(before) + 1);
  assert.deepEqual(after.uses, before.uses, 'a click on this list does not touch a device slot');
  assert.deepEqual(reading(after), {
    total: 11,
    uses: { 'device-a': 5, 'device-b': 3 },
    split: { here: 8, elsewhere: 3, total: 11 }
  });
  assert.equal(after.uses['device-a'], 5);
  assert.equal(after.uses['device-b'], 3);
});

test('an extension total only raises its own slot, and the total never falls', () => {
  const before = record({ clickCount: 1, uses: { 'device-a': 4, 'device-b': 2 } });

  const raised = recordUses(doc([before]), before.id, 'device-a', 6, at(T2)).bookmarks[0];
  assert.deepEqual(raised.uses, { 'device-a': 6, 'device-b': 2 });
  assert.equal(useCount(raised), 9, 'one click plus six and two');
  assert.equal(useCount(raised) >= useCount(before), true);

  const stale = recordUses(doc([before]), before.id, 'device-a', 1, at(T2));
  assert.equal(stale.bookmarks[0], before, 'a lower total for the same slot changes nothing');
  assert.equal(useCount(stale.bookmarks[0]), useCount(before));

  const same = recordUses(doc([before]), before.id, 'device-a', 4, at(T2));
  assert.equal(same.bookmarks[0], before, 'the same total is not a change either');
});

test('a legacy single number keeps its slot and is not overwritten by a smaller one', () => {
  const legacy = record({ clickCount: 0, uses: undefined, openCount: 7 });
  assert.equal(useCount(legacy), 7, 'the old number is still a use');

  const counted = recordUses(doc([legacy]), legacy.id, 'device-a', 2, at(T2)).bookmarks[0];
  assert.deepEqual(counted.uses, { legacy: 7, 'device-a': 2 });
  assert.equal(useCount(counted), 9);

  const stale = mergeBookmark(counted, legacy);
  assert.equal(useCount(stale), 9, 'an old document cannot replace the slot with its single number');
  assert.deepEqual(stale.uses, { legacy: 7, 'device-a': 2 });
});

test('a merge takes the larger number inside each slot, so neither side loses a visit', () => {
  const left = record({ clickCount: 2, uses: { 'device-a': 5, 'device-b': 1 }, updatedAt: iso(T1) });
  const right = record({
    clickCount: 1,
    uses: { 'device-a': 3, 'device-b': 4 },
    updatedAt: iso(T2),
    name: 'Renamed'
  });

  const merged = mergeBookmark(left, right);
  assert.deepEqual(merged.uses, { 'device-a': 5, 'device-b': 4 });
  assert.equal(merged.clickCount, 2);
  assert.equal(useCount(merged), 11);
  assert.ok(useCount(merged) >= useCount(left));
  assert.ok(useCount(merged) >= useCount(right));
  assert.equal(merged.name, 'Renamed', 'the field rules still pick the later edit');
});

test('a stale server copy cannot lower a total, and its slots do not replace the local ones', () => {
  /* The reported shape: this device read 6, and the copy the server answered with was older and
     carried 3. The merge is the only thing that stands between the person and the drop. */
  const local = record({
    id: 'shared',
    clickCount: 1,
    uses: { 'device-a': 5 },
    updatedAt: iso(T2)
  });
  const stale = record({
    id: 'shared',
    clickCount: 0,
    uses: { 'device-a': 2 },
    updatedAt: iso(T1)
  });

  const { document } = mergeDocuments(doc([local]), doc([stale]), at(T3));
  const merged = document.bookmarks[0];

  assert.equal(useCount(merged), 6, 'the local total survives an older copy');
  assert.deepEqual(merged.uses, { 'device-a': 5 });
  assert.deepEqual(merged, local, 'nothing changed, so nothing is rewritten');
});

test('a merge of two devices adds their slots, and merging the same copy again adds nothing', () => {
  const laptop = record({ id: 'shared', uses: { laptop: 3 }, updatedAt: iso(T1) });
  const phone = record({ id: 'shared', uses: { phone: 2 }, updatedAt: iso(T2) });

  const once = mergeDocuments(doc([laptop]), doc([phone]), at(T3)).document;
  assert.equal(useCount(once.bookmarks[0]), 5);
  assert.deepEqual(once.bookmarks[0].uses, { laptop: 3, phone: 2 });

  const twice = mergeDocuments(once, doc([phone]), at(T3)).document;
  assert.equal(useCount(twice.bookmarks[0]), 5, 'the same phone copy is not a second visit');
  assert.deepEqual(twice.bookmarks[0].uses, { laptop: 3, phone: 2 });

  const third = mergeDocuments(twice, doc([record({ id: 'shared', uses: { tablet: 4 }, updatedAt: iso(T3) })]), at(T3)).document;
  assert.deepEqual(third.bookmarks[0].uses, { laptop: 3, phone: 2, tablet: 4 });
  assert.equal(useCount(third.bookmarks[0]), 9);
});

test('an edit cannot lower the count it shows, even with a sheet opened before a merge', () => {
  /* The sheet is drawn from a reading; a sync that raises the count while it is open must not let
     Save write the older number back. */
  const before = record({ id: 'shared', clickCount: 3, uses: { 'device-a': 2 } });
  const document = doc([before]);

  const afterMerge = doc([
    record({ id: 'shared', clickCount: 6, uses: { 'device-a': 2 }, updatedAt: iso(T2) })
  ]);

  const stale = updateBookmark(afterMerge, 'shared', { clickCount: 3 }, at(T3));
  assert.equal(useCount(stale.bookmarks[0]), 8, 'the count under the sheet is kept');
  assert.equal(stale.bookmarks[0].clickCount, 6);

  const raised = updateBookmark(document, 'shared', { clickCount: 5 }, at(T3));
  assert.equal(raised.bookmarks[0].clickCount, 5, 'a deliberate correction upwards is accepted');
  assert.equal(useCount(raised.bookmarks[0]) >= useCount(before), true);
});

test('a plain import carries the per-device slots and the old single number', () => {
  const source = doc([
    record({
      id: 'one',
      clickCount: 2,
      uses: { 'device-a': 4, 'device-b': 1 },
      updatedAt: iso(T2)
    }),
    record({
      id: 'two',
      url: 'https://legacy.example/',
      hostname: 'legacy.example',
      origin: 'https://legacy.example',
      name: 'Legacy',
      clickCount: 0,
      uses: undefined,
      openCount: 7
    })
  ]);

  const { document } = importPlain(
    { format: 'bookmarks-plain/1', document: source },
    at(T3)
  );
  const [one, two] = document.bookmarks;

  assert.equal(useCount(one), 7, 'two clicks and five device visits');
  assert.deepEqual(one.uses, { 'device-a': 4, 'device-b': 1 });
  assert.equal(useCount(two), 7, 'the old single number is not dropped by the import');
  assert.deepEqual(two.uses, { legacy: 7 });
});

test('a browser bookmark file never invents a count, and keeps the imported total at zero', () => {
  const html = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<DL><p>
  <DT><A HREF="https://e2e.local/one" ADD_DATE="1767225600">One</A>
  <DT><A HREF="https://e2e.local/two" ADD_DATE="1767225600">Two</A>
</DL><p>`;

  const { document } = importBrowserBookmarks(html, at(T3));
  assert.equal(document.bookmarks.length, 2);
  for (const bookmark of document.bookmarks) {
    assert.equal(useCount(bookmark), 0);
    assert.deepEqual(bookmark.uses, {});
  }
});

test('restoring an older backup is a merge, so the total and the slots survive', () => {
  /* What the restore path does with an old sealed copy: the copy is the right side of a merge,
     not a replacement. The reason is the same one that stops a stale server copy. */
  const current = record({
    id: 'shared',
    clickCount: 1,
    uses: { 'device-a': 2, 'device-b': 1 },
    updatedAt: iso(T3)
  });
  const backup = record({
    id: 'shared',
    clickCount: 0,
    uses: { 'device-a': 2 },
    updatedAt: iso(T1)
  });

  const { document } = mergeDocuments(doc([current]), doc([backup]), at(T3));
  const restored = document.bookmarks[0];

  assert.equal(useCount(restored), 4, 'the device that counted a visit after the backup is not erased');
  assert.deepEqual(restored.uses, { 'device-a': 2, 'device-b': 1 });
});

test('the paths that add visits never mutate the document they were given', () => {
  const original = doc([record({ id: 'shared', clickCount: 1, uses: { 'device-a': 2 } })]);
  const before = JSON.stringify(original);

  recordClick(original, 'shared', at(T2));
  recordUses(original, 'shared', 'device-b', 3, at(T2));
  updateBookmark(original, 'shared', { clickCount: 9 }, at(T2));
  mergeDocuments(original, doc([record({ id: 'shared', uses: { 'device-c': 4 }, updatedAt: iso(T3) })]), at(T3));

  assert.equal(JSON.stringify(original), before);
});

test('an empty document has nowhere to lose a count, and a new bookmark starts at zero', () => {
  const empty = createDocument();
  assert.equal(empty.bookmarks.length, 0);
  assert.deepEqual(empty.bookmarks, []);
  assert.equal(useCount(record()), 0);
});
