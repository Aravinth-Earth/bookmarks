/**
 * The page's own storage: what it keeps outside the vault, and what "Clear this device" removes.
 *
 * Neither icon map is device-side any more — both live inside the sealed document — so the cases
 * that matter here are that the two old key names are still reachable by a clear, that opening a
 * vault deletes a leftover instead of reading it, that a map written before the digest existed
 * does not survive its first read, and that the retry index is bounded to its season.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  COLLECTED_ICON_KEY,
  DEVICE_ID_KEY,
  DEVICE_KEYS,
  ICON_TRIES_DAYS,
  ICON_TRIES_KEY,
  SIZE_KEY,
  THEME_KEY,
  VIEW_KEY,
  clearDeviceStorage,
  forgetLegacyIconMaps,
  hostKey,
  pruneIconTries
} from '../public/device-store.js';

function fakeStorage(seed = {}) {
  const kept = new Map(Object.entries(seed));
  return {
    kept,
    getItem: (key) => (kept.has(key) ? kept.get(key) : null),
    setItem: (key, value) => kept.set(key, String(value)),
    removeItem: (key) => kept.delete(key)
  };
}

test('a hostname becomes a stable digest that names no site', async () => {
  const key = await hostKey('itsfoss.com');
  assert.match(key, /^[0-9a-f]{32}$/);
  assert.equal(key.includes('itsfoss'), false);
  assert.equal(await hostKey('itsfoss.com'), key, 'the same host keys the same way every launch');
  assert.notEqual(await hostKey('example.com'), key);
});

test('the digest ignores the case of the hostname', async () => {
  assert.equal(await hostKey('ITSFOSS.com'), await hostKey('itsfoss.com'));
});

test('a map of plaintext hostnames is dropped, a map of digests is kept', async () => {
  const digest = await hostKey('itsfoss.com');
  const at = 1700000000000;
  const { kept, dropped } = pruneIconTries(
    {
      'itsfoss.com': at,
      'example.com': 'not a timestamp',
      [digest]: at
    },
    { now: at }
  );
  assert.deepEqual(kept, { [digest]: at });
  assert.equal(dropped, 2);
});

test('an attempt older than the season is dropped, and one inside it is kept', async () => {
  const digest = await hostKey('itsfoss.com');
  const other = await hostKey('example.com');
  const now = 1_700_000_000_000;
  const season = ICON_TRIES_DAYS * 24 * 60 * 60 * 1000;
  const { kept, dropped } = pruneIconTries(
    {
      [digest]: now - season - 1,
      [other]: now - season + 1
    },
    { now }
  );

  assert.deepEqual(kept, { [other]: now - season + 1 }, 'a stamp outside the season is noise');
  assert.equal(dropped, 1);
  assert.equal(ICON_TRIES_DAYS, 90);
});

test('anything that is not a map prunes to nothing rather than throwing', () => {
  for (const value of [null, undefined, 'text', 7, []]) {
    assert.deepEqual(pruneIconTries(value), { kept: {}, dropped: 0 });
  }
});

test('clearing a device removes every key the page writes', () => {
  const storage = fakeStorage({
    [ICON_TRIES_KEY]: '{"aa":1}',
    [VIEW_KEY]: 'list',
    [SIZE_KEY]: 'large',
    [THEME_KEY]: 'nord',
    [COLLECTED_ICON_KEY]: '{"itsfoss.com":"data:image/png;base64,AAAA"}',
    'unrelated-key': 'kept'
  });

  clearDeviceStorage(storage);

  for (const key of DEVICE_KEYS) assert.equal(storage.getItem(key), null, `${key} is gone`);
  assert.equal(storage.getItem('unrelated-key'), 'kept', 'only the page’s own keys are removed');
});

test('a clear reaches the icon keys an earlier version wrote', () => {
  /* The two icon maps live inside the sealed document now, so a clear reaches them through the
     vault. The old key names stay on the list for the device that has not been opened since the
     upgrade: a copy no clear can reach is exactly what this app exists to prevent. */
  const storage = fakeStorage({
    [ICON_TRIES_KEY]: JSON.stringify({ '4e7fe59a1fa4bc50b55b4968d21fddf8': 1_700_000_000_000 }),
    [COLLECTED_ICON_KEY]: JSON.stringify({ 'itsfoss.com': 'data:image/png;base64,iVBORw0KGgo=' })
  });

  clearDeviceStorage(storage);

  assert.equal(storage.getItem(ICON_TRIES_KEY), null);
  assert.equal(storage.getItem(COLLECTED_ICON_KEY), null);
  assert.deepEqual(Object.keys(storage.kept), []);
});

test('the two icon key names stay listed, so a leftover is removed rather than migrated', () => {
  assert.equal(COLLECTED_ICON_KEY, 'collected-icons');
  assert.equal(ICON_TRIES_KEY, 'bookmarks-icon-tries');
  assert.equal(DEVICE_KEYS.includes(COLLECTED_ICON_KEY), true);
  assert.equal(DEVICE_KEYS.includes(ICON_TRIES_KEY), true);
});

test('opening a vault deletes both old icon keys without reading them', () => {
  const storage = fakeStorage({
    [ICON_TRIES_KEY]: JSON.stringify({ '4e7fe59a1fa4bc50b55b4968d21fddf8': 1_700_000_000_000 }),
    [COLLECTED_ICON_KEY]: JSON.stringify({ 'itsfoss.com': 'data:image/png;base64,iVBORw0KGgo=' }),
    [VIEW_KEY]: 'list'
  });

  forgetLegacyIconMaps(storage);

  assert.equal(storage.getItem(ICON_TRIES_KEY), null, 'the retry index is gone');
  assert.equal(storage.getItem(COLLECTED_ICON_KEY), null, 'the pictures are gone');
  assert.equal(storage.getItem(VIEW_KEY), 'list', 'the settings this page still keeps are untouched');
});

test('a sweep that cannot reach storage is not an error', () => {
  const storage = {
    removeItem() {
      throw new Error('denied');
    }
  };
  assert.doesNotThrow(() => forgetLegacyIconMaps(storage));
});

test('the page lists every key a clear has to reach, and the device name outlives it', () => {
  assert.deepEqual(
    [...DEVICE_KEYS],
    [ICON_TRIES_KEY, VIEW_KEY, SIZE_KEY, THEME_KEY, COLLECTED_ICON_KEY],
    'a key absent from this list is a key a clear cannot reach'
  );
  assert.equal(
    DEVICE_KEYS.includes(DEVICE_ID_KEY),
    false,
    'the device name outlives a wipe: a new name would count the same visits twice'
  );
  assert.equal(ICON_TRIES_KEY, 'bookmarks-icon-tries');
});

test('a device names itself once, keeps the name, and is cleared with the rest', async () => {
  const { deviceId } = await import('../public/device-store.js');
  const map = new Map();
  const storage = {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key)
  };

  const first = deviceId(storage);
  assert.match(first, /^[0-9a-f]{16}$/, 'a name, not a fingerprint');
  assert.equal(deviceId(storage), first, 'the same name the second time');
  assert.notEqual(deviceId({ getItem: () => null, setItem: () => {} }), first, 'another device, another name');
});

test('a device with no storage still counts, under a name that lasts as long as the page', async () => {
  const { deviceId } = await import('../public/device-store.js');
  const broken = {
    getItem() {
      throw new Error('denied');
    },
    setItem() {
      throw new Error('denied');
    }
  };
  assert.equal(deviceId(broken), 'unsettled');
});

test('clearing a device survives storage that refuses to be read', () => {
  const storage = {
    removeItem() {
      throw new Error('denied');
    }
  };
  assert.doesNotThrow(() => clearDeviceStorage(storage));
});
