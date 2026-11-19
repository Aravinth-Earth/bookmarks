/**
 * The two icon maps inside the sealed vault.
 *
 * `iconTries` is when each host was last asked for an icon, `collectedIcons` is the picture a
 * collected row shows. Both used to sit on the device in the clear; they live in the document now,
 * so the cases that matter are that a document without them stays without them, that they survive
 * a seal and an open, that a merge or an import unions them instead of dropping either side, that
 * the pictures are bounded before the seal, and that the old device keys are deleted rather than
 * migrated.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FREE_DOCUMENT_BYTES,
  MAX_COLLECTED_ICONS,
  MAX_COLLECTED_ICON_BYTES,
  addBookmark,
  collectedIconFor,
  collectedIconsOf,
  createDocument,
  fitActivity,
  fitCollectedIcons,
  iconTriesOf,
  mergeDocuments,
  withCollectedIcon
} from '../public/bookmarks.js';
import { mergeInto, sanitizeDocument } from '../public/import-export.js';
import { openVault, sealVault } from '../public/crypto.js';
import { COLLECTED_ICON_KEY, ICON_TRIES_KEY, forgetLegacyIconMaps } from '../public/device-store.js';
import { tileFor } from '../public/tiles.js';

const T1 = Date.UTC(2026, 0, 1, 10, 0, 0);
const T2 = Date.UTC(2026, 0, 2, 10, 0, 0);
const T3 = Date.UTC(2026, 0, 3, 10, 0, 0);

const at = (moment) => () => moment;
const iso = (moment) => new Date(moment).toISOString();
const bytes = (value) => new TextEncoder().encode(JSON.stringify(value)).length;

/* A 1x1 PNG, which is the shape `fetchAndStoreIcon` puts in the map. */
const PICTURE =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const OTHER_PICTURE = `${PICTURE.slice(0, 40)}AAAA${PICTURE.slice(44)}`;

const DIGEST = '4e7fe59a1fa4bc50b55b4968d21fddf8';
const OTHER_DIGEST = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

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

function doc(bookmarks = []) {
  return {
    schema: 1,
    bookmarks,
    tombstones: [],
    activity: [],
    prefs: { iconOnly: false }
  };
}

function fakeStorage(initial = {}) {
  const kept = new Map(Object.entries(initial));
  return {
    kept: Object.fromEntries(kept),
    getItem: (key) => (kept.has(key) ? kept.get(key) : null),
    setItem: (key, value) => kept.set(key, String(value)),
    removeItem: (key) => {
      kept.delete(key);
    }
  };
}

test('a document written before the maps existed carries neither, and reading it invents none', () => {
  const document = createDocument();

  assert.equal('iconTries' in document, false, 'a new document has no attempt map');
  assert.equal('collectedIcons' in document, false, 'a new document has no picture map');
  assert.deepEqual(iconTriesOf(document), {});
  assert.deepEqual(collectedIconsOf(document), {});

  /* Before the vault is open there is no document at all, and the row draws its letter. */
  assert.deepEqual(iconTriesOf(null), {});
  assert.deepEqual(collectedIconsOf(null), {});
  assert.equal(collectedIconFor(null, 'itsfoss.com'), null);
  assert.equal(collectedIconFor(document, 'itsfoss.com'), null);

  /* Anything that is not a map reads as none, rather than as an object to write into. */
  for (const value of [null, undefined, 'text', 7, []]) {
    assert.deepEqual(iconTriesOf({ iconTries: value }), {});
    assert.deepEqual(collectedIconsOf({ collectedIcons: value }), {});
  }
});

test('the two maps survive a seal and an open, and the sealed bytes name no host', async () => {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt'
  ]);
  const accountId = 'A'.repeat(22);
  const document = {
    ...doc([record()]),
    iconTries: { [DIGEST]: T1 },
    collectedIcons: { 'itsfoss.com': PICTURE }
  };

  const sealed = await sealVault(key, document, accountId, 1);
  assert.equal(sealed.ct.includes('itsfoss.com'), false, 'the host is inside the ciphertext');
  assert.equal(sealed.ct.includes(PICTURE), false, 'the picture is inside the ciphertext');

  const opened = await openVault(key, sealed, accountId, 1);
  assert.deepEqual(opened.iconTries, { [DIGEST]: T1 });
  assert.deepEqual(opened.collectedIcons, { 'itsfoss.com': PICTURE });
  assert.equal(collectedIconFor(opened, 'itsfoss.com'), PICTURE);
});

test('the lettered tile turns into the picture once the document has one', () => {
  const empty = createDocument();
  const lettered = tileFor({ hostname: 'itsfoss.com', color: null });

  assert.equal(lettered.initial, 'I', 'the row starts with its letter');
  assert.equal(collectedIconFor(empty, 'itsfoss.com'), null, 'and no picture to show');

  const document = withCollectedIcon(empty, 'itsfoss.com', PICTURE);

  assert.equal(collectedIconFor(document, 'itsfoss.com'), PICTURE);
  assert.equal(tileFor({ hostname: 'itsfoss.com', color: null }).initial, lettered.initial,
    'the letter is still there for a host with no picture');
  assert.equal(document.iconTries, undefined, 'collecting a picture writes no attempt');
  assert.equal(empty.collectedIcons, undefined, 'the input document is not mutated');

  /* The same host asked again keeps the copy it has instead of reopening the map; a different
     answer replaces the picture in place, so the order a trim reads as age does not move. */
  assert.equal(withCollectedIcon(document, 'itsfoss.com', PICTURE), document);
  const replaced = withCollectedIcon(document, 'itsfoss.com', OTHER_PICTURE);
  assert.equal(collectedIconFor(replaced, 'itsfoss.com'), OTHER_PICTURE);
  assert.deepEqual(Object.keys(replaced.collectedIcons), ['itsfoss.com'], 'replacing keeps the order');

  /* A host or a picture that could not be drawn is refused rather than sealed. */
  assert.equal(withCollectedIcon(document, '', PICTURE), document);
  assert.equal(withCollectedIcon(document, 'other.example', ''), document);
});

test('the legacy sweep deletes both old keys and leaves the document empty', () => {
  const storage = fakeStorage({
    [ICON_TRIES_KEY]: JSON.stringify({ [DIGEST]: T1 }),
    [COLLECTED_ICON_KEY]: JSON.stringify({ 'itsfoss.com': PICTURE })
  });

  forgetLegacyIconMaps(storage);

  assert.equal(storage.getItem(ICON_TRIES_KEY), null, 'the attempt index is gone');
  assert.equal(storage.getItem(COLLECTED_ICON_KEY), null, 'the pictures are gone');

  /* Nothing is read out of them first: the document that opens after the sweep carries neither
     map, so a profile copied before this version names no site. */
  const document = createDocument();
  assert.deepEqual(iconTriesOf(document), {});
  assert.deepEqual(collectedIconsOf(document), {});
});

test('a sync with a copy that has neither map leaves the local maps untouched', () => {
  const local = {
    ...doc([record()]),
    iconTries: { [DIGEST]: T2 },
    collectedIcons: { 'itsfoss.com': PICTURE }
  };

  const { document } = mergeDocuments(local, doc(), at(T3));

  assert.deepEqual(document.iconTries, { [DIGEST]: T2 });
  assert.deepEqual(document.collectedIcons, { 'itsfoss.com': PICTURE });

  /* And the other way round: a local side with no maps gains none from an empty remote copy. */
  const bare = mergeDocuments(doc(), doc(), at(T3)).document;
  assert.equal('iconTries' in bare, false, 'an empty merge writes no attempt map');
  assert.equal('collectedIcons' in bare, false, 'an empty merge writes no picture map');
});

test('a sync with a copy that carries one map unions it, newest attempt winning', () => {
  const local = {
    ...doc([record()]),
    iconTries: { [DIGEST]: T2 },
    collectedIcons: { 'itsfoss.com': PICTURE }
  };
  const remote = {
    ...doc(),
    iconTries: { [DIGEST]: T1, [OTHER_DIGEST]: T1 },
    collectedIcons: { 'remote.example': OTHER_PICTURE }
  };

  const { document } = mergeDocuments(local, remote, at(T3));

  assert.deepEqual(
    document.iconTries,
    { [DIGEST]: T2, [OTHER_DIGEST]: T1 },
    'the newer stamp wins and a digest only the remote side carries is added'
  );
  assert.deepEqual(
    document.collectedIcons,
    { 'itsfoss.com': PICTURE, 'remote.example': OTHER_PICTURE },
    'a picture only the remote side carries is added, and the local one is kept'
  );

  /* The union is stable: merging the answer again changes neither map. */
  const again = mergeDocuments(document, remote, at(T3)).document;
  assert.deepEqual(again.iconTries, document.iconTries);
  assert.deepEqual(again.collectedIcons, document.collectedIcons);
});

test('an import unions both maps, and sanitising the file does not drop them', () => {
  const local = {
    ...doc([record()]),
    iconTries: { [DIGEST]: T2 },
    collectedIcons: { 'itsfoss.com': PICTURE }
  };
  const incoming = {
    ...doc([record({ id: 'id-2', url: 'https://file.example/', hostname: 'file.example', origin: 'https://file.example' })]),
    iconTries: { [OTHER_DIGEST]: T1 },
    collectedIcons: { 'file.example': OTHER_PICTURE }
  };

  const { document: safe, dropped } = sanitizeDocument(incoming);
  assert.equal(dropped, 0);
  assert.deepEqual(safe.iconTries, incoming.iconTries, 'the attempt map survives sanitising');
  assert.deepEqual(safe.collectedIcons, incoming.collectedIcons, 'the pictures survive sanitising');

  const { document } = mergeInto(local, safe, at(T3));

  assert.deepEqual(document.iconTries, { [DIGEST]: T2, [OTHER_DIGEST]: T1 });
  assert.deepEqual(document.collectedIcons, {
    'itsfoss.com': PICTURE,
    'file.example': OTHER_PICTURE
  });

  /* A file with neither map leaves the local ones as they are. */
  const plain = mergeInto(local, doc(), at(T3)).document;
  assert.deepEqual(plain.iconTries, local.iconTries);
  assert.deepEqual(plain.collectedIcons, local.collectedIcons);
});

test('the pictures have a count cap and lose the oldest first', () => {
  assert.equal(MAX_COLLECTED_ICONS, 48, 'the documented count cap');
  assert.equal(MAX_COLLECTED_ICON_BYTES, 24_000, 'the documented byte cap');

  let document = createDocument();
  const hosts = Array.from(
    { length: MAX_COLLECTED_ICONS + 12 },
    (_, index) => `host-${String(index).padStart(3, '0')}.example`
  );
  for (const host of hosts) document = withCollectedIcon(document, host, PICTURE);

  const fitted = fitActivity(document);
  const kept = Object.keys(fitted.collectedIcons);

  assert.equal(kept.length, MAX_COLLECTED_ICONS, 'the map is bounded by its count cap');
  assert.equal(kept.includes(hosts[0]), false, 'the oldest picture is gone');
  assert.equal(kept.includes(hosts[11]), false, 'the oldest twelve are gone');
  assert.equal(kept[0], hosts[12], 'the first kept one is the first that still fits');
  assert.equal(kept.at(-1), hosts.at(-1), 'the newest picture is kept');
  assert.ok(bytes(fitted) <= FREE_DOCUMENT_BYTES, 'the document still fits the free copy');

  /* Nothing to drop leaves the same document, so a render does not rewrite the vault. */
  const plain = createDocument();
  assert.equal(fitCollectedIcons(plain), plain, 'a document with no pictures is returned as it is');
});

test('the pictures have a byte cap of their own, older ones falling first', () => {
  const big = `${PICTURE.slice(0, 30)}${'A'.repeat(2000)}`;
  let document = createDocument();
  const hosts = Array.from({ length: 30 }, (_, index) => `big-${String(index).padStart(2, '0')}.example`);
  for (const host of hosts) document = withCollectedIcon(document, host, big);

  const fitted = fitActivity(document);
  const kept = Object.keys(fitted.collectedIcons);
  const keptBytes = bytes(fitted.collectedIcons);

  assert.ok(kept.length < 30, 'the byte cap dropped pictures, not the host list');
  assert.ok(keptBytes <= MAX_COLLECTED_ICON_BYTES, `the map is ${keptBytes} bytes, inside its cap`);
  assert.equal(kept.includes(hosts[0]), false, 'the oldest picture is gone');
  assert.equal(kept.at(-1), hosts.at(-1), 'the newest picture is kept');

  /* A library that leaves no room takes the pictures down further, oldest first. */
  let crowded = createDocument();
  for (let index = 0; index < 200; index += 1) {
    crowded = addBookmark(
      crowded,
      { url: `https://a-long.example/read/2026/11/${'x'.repeat(1200)}/${index}`, name: `Bookmark ${index}` },
      at(T1)
    ).document;
    if (bytes(crowded) >= FREE_DOCUMENT_BYTES * 0.93) break;
  }
  assert.ok(bytes(crowded) < FREE_DOCUMENT_BYTES, 'the library alone still fits');

  const small = `${PICTURE.slice(0, 30)}${'A'.repeat(380)}`;
  for (const host of hosts.slice(0, MAX_COLLECTED_ICONS)) {
    crowded = withCollectedIcon(crowded, host, small);
  }
  assert.ok(bytes(crowded) > FREE_DOCUMENT_BYTES, 'the pictures are what pushed it over');

  const trimmed = fitActivity(crowded);
  const pictures = Object.keys(trimmed.collectedIcons);

  /* The count and byte caps alone leave this document over the free copy's size; it is the room
     left in the document that the seal needs, and the pictures are what give it back. */
  const capsOnly = fitCollectedIcons(crowded, { maxDocumentBytes: Number.POSITIVE_INFINITY });
  assert.ok(bytes(capsOnly) > FREE_DOCUMENT_BYTES, 'the map caps alone do not fit the seal');

  assert.ok(bytes(trimmed) <= FREE_DOCUMENT_BYTES, 'trimming brings the whole document back');
  assert.ok(pictures.length > 0, 'the newest pictures are kept');
  assert.ok(pictures.length < MAX_COLLECTED_ICONS, 'the oldest pictures went');
  assert.equal(pictures.at(-1), hosts.at(-1), 'the newest is still there');
  assert.equal(pictures.includes(hosts[0]), false, 'the oldest is not');
  assert.deepEqual(trimmed.bookmarks, crowded.bookmarks, 'the library itself is untouched');
});
