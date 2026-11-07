/**
 * The device store: one sealed document, a bounded history, and the remembered key.
 *
 * The adapter is four methods, so these tests run under `node --test` with a Map standing in
 * for IndexedDB. The IndexedDB adapter itself is exercised in the browser, where IndexedDB
 * actually exists.
 *
 * Every refusal is paired with the acceptance it protects: "version 2 is refused" is only
 * meaningful next to "version 3 is accepted".
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  HISTORY_LIMIT,
  createVault,
  indexedDbAdapter
} from '../public/w/bookmarks/vault.js';

const ACCOUNT_A = 'accountAaccountAaccoun';
const ACCOUNT_B = 'accountBaccountBaccoun';

function memoryAdapter() {
  const map = new Map();
  return {
    async get(key) {
      return map.get(key);
    },
    async put(key, value) {
      map.set(key, structuredClone(value));
    },
    async delete(key) {
      map.delete(key);
    },
    async keys() {
      return [...map.keys()];
    },
    /* Not part of the adapter contract; the tests use it to inspect what was written. */
    raw: map
  };
}

function sealedAt(version) {
  return { iv: `iv-${version}`, ct: `ct-${version}` };
}

function clock(start = 1_000) {
  let at = start;
  return () => {
    at += 1;
    return at;
  };
}

test('a fresh device holds no document and reports version zero', async () => {
  const vault = createVault(memoryAdapter());
  assert.deepEqual(await vault.load(ACCOUNT_A), { sealed: null, version: 0, updatedAt: null });
  assert.deepEqual(await vault.history(), []);
  assert.equal(await vault.readRemembered(), null);
});

test('a saved document loads back with its version, account and timestamp', async () => {
  const vault = createVault(memoryAdapter(), { now: clock() });
  const saved = await vault.save(ACCOUNT_A, sealedAt(1), 1);

  assert.equal(saved.version, 1);
  assert.equal(saved.updatedAt, 1_001);

  const loaded = await vault.load(ACCOUNT_A);
  assert.deepEqual(loaded.sealed, sealedAt(1));
  assert.equal(loaded.version, 1);
  assert.equal(loaded.updatedAt, 1_001);
});

test('a version must move forward: the same or a lower one is refused', async () => {
  const vault = createVault(memoryAdapter(), { now: clock() });
  await vault.save(ACCOUNT_A, sealedAt(2), 2);

  await assert.rejects(() => vault.save(ACCOUNT_A, sealedAt(2), 2), /does not follow/);
  await assert.rejects(() => vault.save(ACCOUNT_A, sealedAt(1), 1), /does not follow/);
  await assert.rejects(() => vault.save(ACCOUNT_A, sealedAt(0), 0), /positive integer/);
  await assert.rejects(() => vault.save(ACCOUNT_A, sealedAt(1), 1.5), /positive integer/);

  await assert.doesNotReject(() => vault.save(ACCOUNT_A, sealedAt(3), 3));
  assert.equal((await vault.load(ACCOUNT_A)).version, 3);
});

test('a vault sealed for one phrase is not readable or replaceable by another', async () => {
  const vault = createVault(memoryAdapter(), { now: clock() });
  await vault.save(ACCOUNT_A, sealedAt(1), 1);

  await assert.rejects(() => vault.load(ACCOUNT_B), /different phrase/);
  await assert.rejects(() => vault.save(ACCOUNT_B, sealedAt(2), 2), /different phrase/);

  /* The refusal is not a silent success: the original record is untouched. */
  assert.deepEqual((await vault.load(ACCOUNT_A)).sealed, sealedAt(1));
});

test('history keeps the previous versions newest first and stops at the limit', async () => {
  const vault = createVault(memoryAdapter(), { now: clock() });
  for (let version = 1; version <= HISTORY_LIMIT + 3; version += 1) {
    await vault.save(ACCOUNT_A, sealedAt(version), version);
  }

  const versions = await vault.history();
  assert.equal(versions.length, HISTORY_LIMIT);
  assert.deepEqual(versions, [...versions].sort((left, right) => right - left));
  assert.equal(versions[0], HISTORY_LIMIT + 2, 'the newest previous version comes first');

  const newest = await vault.readHistory(versions[0]);
  assert.deepEqual(newest.sealed, sealedAt(HISTORY_LIMIT + 2));
  await assert.rejects(() => vault.readHistory(999), /no history/);
});

test('the remembered key round-trips and forget clears only that record', async () => {
  const vault = createVault(memoryAdapter(), { now: clock() });
  await vault.save(ACCOUNT_A, sealedAt(1), 1);

  await vault.remember(ACCOUNT_A, 'key-bytes', 'auth-secret');
  const remembered = await vault.readRemembered();
  assert.equal(remembered.accountId, ACCOUNT_A);
  assert.equal(remembered.keyBytes, 'key-bytes');
  assert.equal(remembered.authSecret, 'auth-secret');
  assert.equal(remembered.savedAt, 1_002);

  await assert.rejects(() => vault.remember(ACCOUNT_A, '', 'auth-secret'), /key bytes/);
  await assert.rejects(() => vault.remember(ACCOUNT_A, 'key-bytes', ''), /auth secret/);

  await vault.forget();
  assert.equal(await vault.readRemembered(), null);
  assert.equal((await vault.load(ACCOUNT_A)).version, 1, 'the vault itself is untouched');
});

test('clear removes the vault, its history and the remembered key', async () => {
  const vault = createVault(memoryAdapter(), { now: clock() });
  await vault.save(ACCOUNT_A, sealedAt(1), 1);
  await vault.save(ACCOUNT_A, sealedAt(2), 2);
  await vault.remember(ACCOUNT_A, 'key-bytes', 'auth-secret');

  await vault.clear();

  assert.deepEqual(await vault.load(ACCOUNT_A), { sealed: null, version: 0, updatedAt: null });
  assert.deepEqual(await vault.history(), []);
  assert.equal(await vault.readRemembered(), null);
});

test('the browser adapter is the shape the vault expects', () => {
  const adapter = indexedDbAdapter();
  for (const method of ['get', 'put', 'delete', 'keys']) {
    assert.equal(typeof adapter[method], 'function', `adapter.${method} is a function`);
  }
});
