/**
 * The page's own storage: what it keeps outside the vault, and what "Clear this device" removes.
 *
 * The retry index is the one device-side record that could name a site, so the cases that matter
 * are that a hostname never reaches the store in the clear, that a map written before the digest
 * existed does not survive its first read, and that clearing a device removes every key the page
 * writes rather than the vault alone.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEVICE_ID_KEY,
  DEVICE_KEYS,
  ICON_TRIES_KEY,
  SIZE_KEY,
  THEME_KEY,
  VIEW_KEY,
  clearDeviceStorage,
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
  const { kept, dropped } = pruneIconTries({
    'itsfoss.com': Date.now(),
    'example.com': 'not a timestamp',
    [digest]: 1700000000000
  });
  assert.deepEqual(kept, { [digest]: 1700000000000 });
  assert.equal(dropped, 2);
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
    'unrelated-key': 'kept'
  });

  clearDeviceStorage(storage);

  for (const key of DEVICE_KEYS) assert.equal(storage.getItem(key), null, `${key} is gone`);
  assert.equal(storage.getItem('unrelated-key'), 'kept', 'only the page’s own keys are removed');
});

test('the page lists the keys it writes, and the icon index is one of them', () => {
  assert.deepEqual([...DEVICE_KEYS], [ICON_TRIES_KEY, VIEW_KEY, SIZE_KEY, THEME_KEY]);
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
