/**
 * The activity log: one sealed line per count change.
 *
 * The log exists to make a count auditable on the owner's own device, so the tests read it the
 * way the page does: the event that a change wrote, the ones it did not write, the ring that
 * bounds it, and the fact that every byte of it lives in the sealed document rather than beside
 * it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ACTIVITY_DAYS,
  FREE_DOCUMENT_BYTES,
  MAX_ACTIVITY,
  MAX_ACTIVITY_CHARS,
  activityEvent,
  addBookmark,
  appendActivity,
  createDocument,
  fitActivity,
  mergeBookmark,
  mergeDocuments,
  normaliseActivity,
  recordClick,
  recordUses,
  useCount
} from '../public/bookmarks.js';
import { importBrowserBookmarks, importPlain, mergeInto } from '../public/import-export.js';
import { openVault, sealVault } from '../public/crypto.js';
import { FREE_MAX_CT_CHARS } from '../src/vault.js';

const T1 = Date.UTC(2026, 0, 1, 10, 0, 0);
const T2 = Date.UTC(2026, 0, 2, 10, 0, 0);
const T3 = Date.UTC(2026, 0, 3, 10, 0, 0);
const DAY = 24 * 60 * 60 * 1000;

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
  return { schema: 1, bookmarks, tombstones, activity: [], prefs: { iconOnly: false } };
}

test('a document starts with an empty log, and a document written before it reads as none', () => {
  assert.deepEqual(createDocument().activity, []);
  assert.deepEqual(normaliseActivity(undefined, at(T1)), []);
  assert.deepEqual(normaliseActivity('not a log', at(T1)), []);

  const old = doc([record()]);
  delete old.activity;
  const { document } = mergeDocuments(old, doc(), at(T2));
  assert.deepEqual(document.activity, [], 'a merge of an old vault answers with a log, not an error');
});

test('a click writes one line with the device, the address and both totals', () => {
  const before = record({ id: 'shared', clickCount: 2, uses: { 'device-a': 3 } });
  const after = recordClick(doc([before]), 'shared', at(T2), { device: 'device-a' }).bookmarks[0];

  const document = recordClick(doc([before]), 'shared', at(T2), { device: 'device-a' });
  assert.equal(document.activity.length, 1);

  const [event] = document.activity;
  assert.equal(event.cause, 'click');
  assert.equal(event.device, 'device-a');
  assert.equal(event.bookmarkId, 'shared');
  assert.equal(event.url, before.url);
  assert.equal(event.at, iso(T2));
  assert.equal(event.before, 5);
  assert.equal(event.after, 6);
  assert.deepEqual(event.slot, { device: 'device-a', before: 2, after: 3 });
  assert.ok(event.id, 'the line has an id to merge by');
  assert.equal(useCount(after), event.after);
});

test('two clicks are two lines; an extension total that did not move writes none', () => {
  const first = recordClick(doc([record()]), 'id-1', at(T2), { device: 'device-a' });
  assert.equal(first.activity.length, 1);

  const second = recordClick(first, 'id-1', at(T3), { device: 'device-a' });
  assert.equal(second.activity.length, 2, 'the second click is its own line');

  const counted = recordUses(doc([record()]), 'id-1', 'device-a', 4, at(T2));
  assert.equal(counted.activity.length, 1);
  assert.equal(counted.activity[0].cause, 'open');
  assert.deepEqual(counted.activity[0].slot, { device: 'device-a', before: 0, after: 4 });
  assert.equal(counted.activity[0].after, 4);

  /* The same number again, and a smaller one, are the same document: the log must not grow. */
  assert.equal(recordUses(counted, 'id-1', 'device-a', 4, at(T3)), counted);
  assert.equal(recordUses(counted, 'id-1', 'device-a', 2, at(T3)), counted);
  assert.equal(counted.activity.length, 1);
});

test('a merge writes one line per bookmark whose total rose, and none for a field-only edit', () => {
  const shared = record({ id: 'shared', uses: { laptop: 3 }, updatedAt: iso(T1) });
  const renamed = record({
    id: 'renamed',
    url: 'https://renamed.example/',
    hostname: 'renamed.example',
    name: 'Old',
    updatedAt: iso(T1)
  });
  const remote = record({
    id: 'shared',
    uses: { laptop: 3, phone: 2 },
    updatedAt: iso(T2)
  });
  const remoteRenamed = {
    ...record({ id: 'renamed', url: renamed.url, hostname: 'renamed.example', name: 'New' }),
    updatedAt: iso(T2)
  };

  const { document } = mergeDocuments(
    doc([shared, renamed]),
    doc([remote, remoteRenamed]),
    at(T3),
    { device: 'laptop' }
  );

  assert.equal(document.activity.length, 1, 'only the bookmark whose count moved wrote a line');
  const [event] = document.activity;
  assert.equal(event.cause, 'merge');
  assert.equal(event.bookmarkId, 'shared');
  assert.equal(event.device, 'laptop', 'the observer is this device');
  assert.equal(event.before, 3);
  assert.equal(event.after, 5);
  assert.deepEqual(event.slot, { device: 'phone', before: 0, after: 2 }, 'the slot that moved is named');
});

test('merging the same copy again adds no line, and an id already in the log is not duplicated', () => {
  const local = doc([record({ id: 'shared', uses: { laptop: 3 }, updatedAt: iso(T1) })]);
  const remote = doc([
    record({ id: 'shared', uses: { laptop: 3, phone: 2 }, updatedAt: iso(T2) })
  ]);

  const once = mergeDocuments(local, remote, at(T3), { device: 'laptop' });
  assert.equal(once.document.activity.length, 1);

  const twice = mergeDocuments(once.document, remote, at(T3), { device: 'laptop' });
  assert.equal(twice.document.activity.length, 1, 'the same merge does not grow the log');

  /* The same event arriving from the other copy is the same event: id, not position, is the key. */
  const away = mergeDocuments(remote, once.document, at(T3), { device: 'phone' });
  assert.equal(away.document.activity.length, 1);
  assert.deepEqual(
    away.document.activity.map((event) => event.id),
    once.document.activity.map((event) => event.id)
  );

  /* And the same two documents merged twice are the same lines, so a retry is not a second visit. */
  const again = mergeDocuments(local, remote, at(T3), { device: 'laptop' });
  assert.deepEqual(again.document.activity, once.document.activity);
});

test('a restore is filed under its own cause, with the same never-falls rule', () => {
  const current = record({
    id: 'shared',
    clickCount: 1,
    uses: { 'device-a': 2 },
    updatedAt: iso(T3)
  });
  /* A backup taken before the other device counted two visits. Restoring it is a merge: the
     visits made after the backup are not erased. */
  const backup = record({
    id: 'shared',
    uses: { 'device-a': 2, 'device-b': 2 },
    updatedAt: iso(T1)
  });

  const restored = mergeDocuments(doc([current]), doc([backup]), at(T3), {
    device: 'device-a',
    cause: 'restore'
  });

  assert.equal(useCount(restored.document.bookmarks[0]), 5, 'the click and the other device survive');
  assert.deepEqual(restored.document.bookmarks[0].uses, { 'device-a': 2, 'device-b': 2 });
  assert.equal(restored.document.activity.length, 1);
  assert.equal(restored.document.activity[0].cause, 'restore');
  assert.equal(restored.document.activity[0].before, 3);
  assert.equal(restored.document.activity[0].after, 5);
  assert.deepEqual(restored.document.activity[0].slot, { device: 'device-b', before: 0, after: 2 });

  /* The same backup again changes no count, so it writes no second line. */
  const again = mergeDocuments(restored.document, doc([backup]), at(T3), {
    device: 'device-a',
    cause: 'restore'
  });
  assert.equal(again.document.activity.length, 1);
});

test('an import writes one line per counted record and keeps the source log it can still explain', () => {
  const source = doc([
    record({ id: 'one', clickCount: 2, uses: { 'device-a': 4 }, updatedAt: iso(T2) }),
    record({
      id: 'two',
      url: 'https://quiet.example/',
      hostname: 'quiet.example',
      name: 'Quiet',
      clickCount: 0,
      updatedAt: iso(T2)
    })
  ]);
  source.activity = [
    activityEvent(
      {
        id: 'source-line',
        device: 'device-a',
        bookmarkId: 'one',
        url: 'https://example.com/',
        cause: 'open',
        before: 5,
        after: 6,
        slot: { device: 'device-a', before: 5, after: 6 }
      },
      at(T2)
    ),
    activityEvent(
      {
        id: 'orphan-line',
        device: 'device-a',
        bookmarkId: 'gone',
        url: 'https://gone.example/',
        cause: 'open',
        before: 0,
        after: 1
      },
      at(T2)
    )
  ];

  const { document } = importPlain({ format: 'bookmarks-plain/1', document: source }, at(T3), {
    device: 'device-a'
  });

  assert.equal(useCount(document.bookmarks[0]), 6);
  assert.equal(document.activity.length, 2, 'the import line and the source line for that record');
  assert.deepEqual(
    document.activity.map((event) => event.cause).sort(),
    ['import', 'open']
  );
  assert.ok(
    document.activity.every((event) => event.bookmarkId === document.bookmarks[0].id),
    'every line names the record this vault holds'
  );
  assert.equal(
    document.activity.some((event) => event.id === 'orphan-line'),
    false,
    'a line for a record the file did not carry is not imported'
  );

  const importLine = document.activity.find((event) => event.cause === 'import');
  assert.equal(importLine.before, 0);
  assert.equal(importLine.after, 6);
  assert.deepEqual(importLine.slot, { device: 'device-a', before: 0, after: 4 });

  const sourceLine = document.activity.find((event) => event.cause === 'open');
  assert.equal(
    sourceLine.bookmarkId,
    document.bookmarks[0].id,
    'a source line follows its record to the id this vault gave it'
  );
});

test('a merge import writes the line under the local id, not the file id', () => {
  const existing = doc([record({ id: 'local', uses: { laptop: 1 }, updatedAt: iso(T1) })]);
  const incoming = doc([
    record({ id: 'from-file', url: 'https://example.com/', uses: { laptop: 1, phone: 2 }, updatedAt: iso(T2) })
  ]);

  const { document } = mergeInto(existing, incoming, at(T3), { device: 'laptop' });
  assert.equal(document.bookmarks[0].id, 'local');
  assert.equal(useCount(document.bookmarks[0]), 3);
  assert.equal(document.activity.length, 1);
  assert.equal(document.activity[0].bookmarkId, 'local');
  assert.equal(document.activity[0].cause, 'import');
  assert.equal(document.activity[0].before, 1);
  assert.equal(document.activity[0].after, 3);

  /* The same file again is the same counts; it does not write another line. */
  const twice = mergeInto(document, incoming, at(T3), { device: 'laptop' });
  assert.equal(twice.document.activity.length, 1);
});

test('a browser file has no counts, so it writes no lines', () => {
  const html = '<DL><p><DT><A HREF="https://e2e.local/one" ADD_DATE="1767225600">One</A></DL><p>';
  const { document } = importBrowserBookmarks(html, at(T3), { device: 'device-a' });
  assert.equal(document.bookmarks.length, 1);
  assert.deepEqual(document.activity, []);
});

test('the log is a ring: at most 100 lines, 24,000 characters, and nothing past 90 days', () => {
  const tiny = Array.from({ length: MAX_ACTIVITY + 25 }, (_, index) => ({
    id: `e${index}`,
    at: iso(T1 + index * 1000),
    device: 'd',
    bookmarkId: 'b',
    url: '',
    cause: 'open',
    before: index,
    after: index + 1
  }));
  const capped = normaliseActivity(tiny, at(T1 + 1000 * 1000));
  assert.equal(capped.length, MAX_ACTIVITY);
  assert.equal(capped[0].id, `e${MAX_ACTIVITY + 24}`, 'newest first');
  assert.equal(capped.at(-1).id, 'e25', 'the oldest lines fall off the ring');

  let document = doc([record()]);
  for (let index = 0; index < MAX_ACTIVITY + 12; index += 1) {
    document = recordClick(document, 'id-1', () => T1 + index * 1000, { device: 'device-a' });
  }

  assert.ok(document.activity.length <= MAX_ACTIVITY);
  assert.equal(document.activity[0].at, iso(T1 + (MAX_ACTIVITY + 11) * 1000), 'the newest is kept');
  assert.ok(
    JSON.stringify(document.activity).length <= MAX_ACTIVITY_CHARS,
    'the log is bounded by its share of the vault'
  );
  assert.equal(new Set(document.activity.map((event) => event.id)).size, document.activity.length);
  assert.ok(document.activity.at(-1).at > iso(T1), 'the oldest lines fell off, not the newest');

  const young = recordClick(doc([record()]), 'id-1', at(T3), { device: 'device-a' });
  const old = activityEvent(
    {
      id: 'old',
      at: iso(T3 - (ACTIVITY_DAYS + 1) * DAY),
      device: 'device-a',
      bookmarkId: 'id-1',
      url: 'https://example.com/',
      cause: 'open',
      before: 0,
      after: 1
    },
    at(T3)
  );
  const withOld = appendActivity(young, [old], at(T3));
  assert.equal(withOld.activity.some((event) => event.id === 'old'), false);
  assert.equal(withOld.activity.length, 1);
});

test('a full log on a small vault seals inside the hosted copy the free plan allows', async () => {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt'
  ]);
  const accountId = 'A'.repeat(22);

  let document = doc([
    record({ id: 'id-1', url: 'https://a-quietly-long-hostname.example/read/2026/11/a-page' })
  ]);
  for (let index = 0; index < MAX_ACTIVITY; index += 1) {
    document = recordClick(document, 'id-1', () => T1 + index * 1000, { device: 'abcdef0123456789' });
  }
  assert.ok(document.activity.length > 0);
  assert.ok(document.activity.length <= MAX_ACTIVITY);
  assert.ok(JSON.stringify(document.activity).length <= MAX_ACTIVITY_CHARS);
  assert.ok(
    new TextEncoder().encode(JSON.stringify(document)).length <= FREE_DOCUMENT_BYTES,
    'the whole document, log included, stays inside its budget'
  );

  const sealed = await sealVault(key, document, accountId, 1);
  assert.ok(
    sealed.ct.length < FREE_MAX_CT_CHARS,
    `a full log seals to ${sealed.ct.length} characters, below ${FREE_MAX_CT_CHARS}`
  );

  /* Nothing on the way in or out may be readable: the URL and the event id are inside the
     ciphertext, not in the envelope that names the blob. */
  assert.equal(JSON.stringify({ iv: sealed.iv, ct: sealed.ct, at: sealed.at }).includes('example'), false);
  assert.deepEqual(await openVault(key, sealed, accountId, 1), document);
});

test('a vault already near the free copy keeps its books and drops the oldest lines until it fits', async () => {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt'
  ]);
  const accountId = 'A'.repeat(22);
  const bytes = (value) => new TextEncoder().encode(JSON.stringify(value)).length;

  /* A library that is close to the free copy on its own. The loop stops once it is well past
     three quarters of the document budget, so the log below has real competition for the room. */
  let document = createDocument();
  for (let index = 0; index < 120; index += 1) {
    document = addBookmark(
      document,
      {
        url: `https://a-long.example/read/2026/11/${'x'.repeat(1200)}/${index}`,
        name: `Bookmark ${index} ${'n'.repeat(40)}`
      },
      at(T1)
    ).document;
    if (bytes(document) >= FREE_DOCUMENT_BYTES * 0.85) break;
  }

  const bookmarksOnly = bytes(document);
  assert.ok(bookmarksOnly >= FREE_DOCUMENT_BYTES * 0.85, `the library is ${bookmarksOnly} bytes`);
  assert.ok(bookmarksOnly < FREE_DOCUMENT_BYTES, 'the library alone still fits');
  const sealedBookmarks = await sealVault(key, document, accountId, 1);
  assert.ok(sealedBookmarks.ct.length < FREE_MAX_CT_CHARS);

  /* A full log, in realistic lines: its own budget is full, and the two together are over the
     document budget. */
  const fullLog = normaliseActivity(
    Array.from({ length: 140 }, (_, index) => ({
      id: `line-${index}`,
      at: iso(T2 + index * 1000),
      device: 'abcdef0123456789',
      bookmarkId: document.bookmarks[0].id,
      url: 'https://a-real.example/read/2026/11/a-page',
      cause: 'open',
      before: index,
      after: index + 1
    })),
    at(T3)
  );
  assert.ok(JSON.stringify(fullLog).length >= MAX_ACTIVITY_CHARS * 0.9, 'the log is full');

  const oversized = { ...document, activity: fullLog };
  assert.ok(
    bytes(oversized) > FREE_DOCUMENT_BYTES,
    'a full log plus this library is over the document budget'
  );

  const fitted = fitActivity(oversized);
  assert.ok(bytes(fitted) <= FREE_DOCUMENT_BYTES, 'trimming brings the whole document back');
  assert.ok(fitted.activity.length > 0, 'the newest lines are kept');
  assert.ok(fitted.activity.length < fullLog.length, 'the oldest lines went');
  assert.equal(fitted.activity[0].id, fullLog[0].id, 'the newest line survives');
  assert.equal(fitted.activity.at(-1).id !== fullLog.at(-1).id, true, 'the oldest line does not');

  const sealed = await sealVault(key, fitted, accountId, 1);
  assert.ok(
    sealed.ct.length < FREE_MAX_CT_CHARS,
    `the trimmed vault seals to ${sealed.ct.length} characters, below ${FREE_MAX_CT_CHARS}`
  );
  assert.deepEqual(await openVault(key, sealed, accountId, 1), fitted);

  /* The bookmarks themselves are untouched: trimming is the log's job, not the library's. */
  assert.deepEqual(fitted.bookmarks, document.bookmarks);
});

test('an event needs the shape the log can read back', () => {
  assert.throws(
    () =>
      activityEvent(
        {
          device: 'device-a',
          bookmarkId: 'id-1',
          url: 'https://example.com/',
          cause: 'sideways',
          before: 0,
          after: 1
        },
        at(T1)
      ),
    /known cause/
  );
  /* A caller that did not name an observer still gets a whole event; the name is not invented. */
  const unsettled = activityEvent(
    { bookmarkId: 'id-1', url: 'https://example.com/', cause: 'click', before: 0, after: 1 },
    at(T1)
  );
  assert.equal(unsettled.device, 'unsettled');

  /* Unknown lines in a document from a newer build are dropped rather than opened. */
  const document = appendActivity(
    doc(),
    [
      { id: 'bad', at: iso(T1), device: 'd', bookmarkId: 'b', url: 'https://x.example/', cause: 'nope', before: 0, after: 1 },
      { id: 'good', at: iso(T1), device: 'd', bookmarkId: 'b', url: 'https://x.example/', cause: 'click', before: 0, after: 1 }
    ],
    at(T1)
  );
  assert.deepEqual(document.activity.map((event) => event.id), ['good']);
});

test('a merge of two documents with the same count writes no line even when fields differ', () => {
  const left = record({ id: 'shared', uses: { laptop: 2 }, updatedAt: iso(T2) });
  const right = record({ id: 'shared', uses: { laptop: 2, phone: 0 }, name: 'Newer', updatedAt: iso(T1) });
  const before = useCount(left);

  const { document } = mergeDocuments(doc([left]), doc([right]), at(T3), { device: 'laptop' });
  assert.equal(useCount(document.bookmarks[0]), before);
  assert.deepEqual(document.activity, []);

  /* Direct bookmark rules still keep each side's larger slot, so this is only about the log. */
  assert.deepEqual(mergeBookmark(left, right).uses, { laptop: 2 });
});
