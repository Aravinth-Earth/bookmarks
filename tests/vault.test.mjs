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
  REMEMBER_LIFETIME_MS,
  createVault,
  indexedDbAdapter
} from '../public/vault.js';
import { keyFromBytes, open, proveAuth, seal } from '../public/crypto.js';

const ACCOUNT_A = 'accountAaccountAaccoun';
const ACCOUNT_B = 'accountBaccountBaccoun';

/* 32 random bytes, base64url: the material a remembered record used to hold as text. */
function secretText() {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
}

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
  assert.equal(await vault.hasVault(), false);
});

test('a device with a sealed document says so before any phrase is entered', async () => {
  const vault = createVault(memoryAdapter(), { now: clock() });
  await vault.save(ACCOUNT_A, sealedAt(1), 1);
  assert.equal(await vault.hasVault(), true);

  await vault.forget();
  assert.equal(await vault.hasVault(), true, 'locking does not remove the sealed document');

  await vault.clear();
  assert.equal(await vault.hasVault(), false);
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

test('a remembered device stores keys, never the bytes that made them', async () => {
  const adapter = memoryAdapter();
  const vault = createVault(adapter, { now: clock() });

  const vaultKey = await keyFromBytes(secretText());
  const document = { bookmarks: [{ id: 'one' }] };
  const sealed = await seal(vaultKey, document, ACCOUNT_A);

  await vault.remember(ACCOUNT_A, vaultKey, secretText());

  const record = adapter.raw.get('remembered');
  assert.deepEqual(Object.keys(record).sort(), ['accountId', 'authKey', 'key', 'savedAt']);
  assert.equal(record.keyBytes, undefined, 'the old key field is gone');
  assert.equal(record.authSecret, undefined, 'no readable auth secret is stored');

  assert.ok(record.key instanceof CryptoKey, 'the vault key is a CryptoKey');
  assert.equal(record.key.type, 'secret');
  assert.equal(record.key.algorithm.name, 'AES-GCM');
  assert.equal(record.key.extractable, false, 'the vault key cannot be exported');

  assert.ok(record.authKey instanceof CryptoKey, 'the auth secret is a CryptoKey');
  assert.equal(record.authKey.algorithm.name, 'HMAC');
  assert.equal(record.authKey.extractable, false, 'the auth key cannot be exported');

  await assert.rejects(() => crypto.subtle.exportKey('raw', record.key), /not extractable/i);
  await assert.rejects(() => crypto.subtle.exportKey('raw', record.authKey), /not extractable/i);

  /* Stored and used are the same thing: the record still opens the document it sealed. */
  const remembered = await vault.readRemembered();
  assert.deepEqual(await open(remembered.key, sealed, ACCOUNT_A), document);

  await vault.forget();
  assert.equal(await vault.readRemembered(), null);
  assert.equal((await vault.load(ACCOUNT_A)).version, 0, 'the vault itself is untouched');
});

test('a record written before keys were stored migrates without the phrase', async () => {
  const adapter = memoryAdapter();
  const keyBytes = secretText();
  const authSecret = secretText();
  const vaultKey = await keyFromBytes(keyBytes);
  const document = { bookmarks: [{ id: 'one', url: 'https://example.com' }] };
  const sealed = await seal(vaultKey, document, ACCOUNT_A);

  /* Exactly the shape the old build wrote. */
  adapter.raw.set('remembered', { accountId: ACCOUNT_A, keyBytes, authSecret, savedAt: 1_001 });

  const vault = createVault(adapter, { now: () => 1_002 });
  const remembered = await vault.readRemembered();

  assert.equal(remembered.accountId, ACCOUNT_A);
  assert.ok(remembered.key instanceof CryptoKey);
  assert.ok(remembered.authKey instanceof CryptoKey);
  assert.equal(remembered.key.extractable, false);
  assert.deepEqual(await open(remembered.key, sealed, ACCOUNT_A), document);

  /* The auth key signs what the old text signed, so sync keeps working. */
  assert.equal(
    await proveAuth(remembered.authKey, ACCOUNT_A, 'nonce'),
    await proveAuth(authSecret, ACCOUNT_A, 'nonce')
  );

  const stored = adapter.raw.get('remembered');
  assert.deepEqual(Object.keys(stored).sort(), ['accountId', 'authKey', 'key', 'savedAt']);
  assert.equal(stored.keyBytes, undefined);
  assert.equal(stored.authSecret, undefined);
  assert.equal(stored.savedAt, 1_001, 'the migration does not restart the clock');
});

test('a record without an auth secret migrates its key and reports no auth key', async () => {
  const adapter = memoryAdapter();
  const keyBytes = secretText();
  const vaultKey = await keyFromBytes(keyBytes);
  const sealed = await seal(vaultKey, { bookmarks: [] }, ACCOUNT_A);

  adapter.raw.set('remembered', { accountId: ACCOUNT_A, keyBytes, savedAt: 1_001 });

  const vault = createVault(adapter, { now: () => 1_002 });
  const remembered = await vault.readRemembered();

  assert.ok(remembered.key instanceof CryptoKey);
  assert.equal(remembered.authKey, undefined);
  assert.deepEqual(await open(remembered.key, sealed, ACCOUNT_A), { bookmarks: [] });
  assert.deepEqual(Object.keys(adapter.raw.get('remembered')).sort(), [
    'accountId',
    'key',
    'savedAt'
  ]);
});

test('a remembered device expires: the phrase is asked for again and the record is gone', async () => {
  const adapter = memoryAdapter();
  let at = 1_000;
  const vault = createVault(adapter, { now: () => at });
  await vault.save(ACCOUNT_A, sealedAt(1), 1);
  await vault.remember(ACCOUNT_A, await keyFromBytes(secretText()), secretText());
  assert.equal((await vault.readRemembered()).savedAt, 1_000);

  at += REMEMBER_LIFETIME_MS - 1;
  assert.ok(await vault.readRemembered(), 'one millisecond short of the lifetime still opens');

  at += 1;
  assert.equal(await vault.readRemembered(), null);
  assert.equal(adapter.raw.has('remembered'), false, 'the expired record is deleted');
  assert.equal((await vault.load(ACCOUNT_A)).version, 1, 'the vault is not deleted');
});

test('an expired record written in the old shape is deleted, not migrated', async () => {
  const adapter = memoryAdapter();
  adapter.raw.set('remembered', {
    accountId: ACCOUNT_A,
    keyBytes: secretText(),
    authSecret: secretText(),
    savedAt: 1_000
  });

  const vault = createVault(adapter, { now: () => 1_000 + REMEMBER_LIFETIME_MS });
  assert.equal(await vault.readRemembered(), null);
  assert.equal(adapter.raw.has('remembered'), false);
});

test('clear removes the vault, its history and the remembered key', async () => {
  const vault = createVault(memoryAdapter(), { now: clock() });
  await vault.save(ACCOUNT_A, sealedAt(1), 1);
  await vault.save(ACCOUNT_A, sealedAt(2), 2);
  await vault.remember(ACCOUNT_A, await keyFromBytes(secretText()), secretText());

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
