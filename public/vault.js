/**
 * Bookmarks — this device's copy of the vault.
 *
 * One sealed document, the version it was sealed at, a short history of the versions before it,
 * and the remembered key when the user asked this device to stay unlocked. Nothing here is
 * plaintext: the document arrives already sealed, and the remembered record holds only
 * non-extractable CryptoKeys, which IndexedDB can store and no script can read back as bytes.
 *
 * Storage sits behind a four-method adapter so the logic is testable under `node --test`, where
 * IndexedDB does not exist. `indexedDbAdapter()` is the only browser-specific part.
 */

import { authKeyFromBytes, keyFromBytes } from './crypto.js';

export const DB_NAME = 'bookmarks';
export const DB_VERSION = 1;
export const STORE = 'vault';
/* Five previous versions is enough to undo a bad import or a mistaken clear, and small enough
   that the whole store stays a few hundred kilobytes. */
export const HISTORY_LIMIT = 5;
/* A remembered device is a convenience with an expiry, not a permanent key: a record is used for
   at most thirty days of forward clock movement, and a record dated later than the clock is
   treated as expired rather than trusted, so the phrase is asked for again and a browser profile
   copied once stops being a way in. */
export const REMEMBER_LIFETIME_DAYS = 30;
export const REMEMBER_LIFETIME_MS = REMEMBER_LIFETIME_DAYS * 24 * 60 * 60 * 1000;

const DOCUMENT = 'document';
const REMEMBERED = 'remembered';
const HISTORY_PREFIX = 'history:';

function historyKey(version) {
  return `${HISTORY_PREFIX}${version}`;
}

function isVersion(value) {
  return Number.isInteger(value) && value > 0;
}

/**
 * The vault over any adapter. `now` is injectable so a test can name a timestamp.
 *
 * @param {{get: Function, put: Function, delete: Function, keys: Function}} adapter
 * @param {{now?: () => number}} [options]
 */
export function createVault(adapter, { now = () => Date.now() } = {}) {
  async function load(accountId) {
    const record = await adapter.get(DOCUMENT);
    if (!record) return { sealed: null, version: 0, updatedAt: null };

    if (record.accountId !== accountId) {
      throw new Error('bookmarks: this device holds a vault for a different phrase');
    }
    return { sealed: record.sealed, version: record.version, updatedAt: record.updatedAt };
  }

  async function save(accountId, sealed, version) {
    if (!isVersion(version)) {
      throw new Error('bookmarks: a vault version is a positive integer');
    }
    if (!sealed || typeof sealed.iv !== 'string' || typeof sealed.ct !== 'string') {
      throw new Error('bookmarks: a vault is sealed before it is stored');
    }

    const current = await adapter.get(DOCUMENT);
    if (current) {
      if (current.accountId !== accountId) {
        throw new Error('bookmarks: this device holds a vault for a different phrase');
      }
      if (version <= current.version) {
        throw new Error(
          `bookmarks: version ${version} does not follow the stored version ${current.version}`
        );
      }
      await adapter.put(historyKey(current.version), current);
      await prune();
    }

    const updatedAt = now();
    await adapter.put(DOCUMENT, { accountId, sealed, version, updatedAt });
    return { version, updatedAt };
  }

  async function prune() {
    const keys = (await adapter.keys()).filter((key) => key.startsWith(HISTORY_PREFIX));
    if (keys.length <= HISTORY_LIMIT) return;

    const versions = keys
      .map((key) => Number(key.slice(HISTORY_PREFIX.length)))
      .sort((left, right) => right - left);

    for (const version of versions.slice(HISTORY_LIMIT)) {
      await adapter.delete(historyKey(version));
    }
  }

  /** The stored versions, newest first, so the app can offer a rollback. */
  async function history() {
    const keys = (await adapter.keys()).filter((key) => key.startsWith(HISTORY_PREFIX));
    return keys
      .map((key) => Number(key.slice(HISTORY_PREFIX.length)))
      .sort((left, right) => right - left);
  }

  async function readHistory(version) {
    if (!isVersion(version)) {
      throw new Error('bookmarks: a vault version is a positive integer');
    }
    const record = await adapter.get(historyKey(version));
    if (!record) throw new Error(`bookmarks: there is no history for version ${version}`);
    return record;
  }

  /**
   * Keep this device unlocked: the vault key and the key that signs login proofs, both
   * non-extractable.
   *
   * `vaultKey` and `authSecret` may be CryptoKeys or the base64url text the older record
   * stored; either way what lands in the adapter is a pair of CryptoKeys, so a copy of the
   * profile yields keys that sign and decrypt but cannot be exported or read.
   *
   * `extras` carries what a device created under the committed scheme needs in order to sign in
   * without the phrase: `serverId`, the 64-hex name the server keeps the account under, and
   * `proofKey`, the non-extractable Ed25519 key that signs its proofs. They are optional, so a
   * three-argument call writes exactly the record it always did, and the record stays keyed by the
   * phrase's own account id either way. IndexedDB structured-clones a CryptoKey, so the signing
   * key is stored the same way the vault key is; the seed and the phrase are never written.
   */
  async function remember(accountId, vaultKey, authSecret, extras = {}) {
    if (vaultKey === undefined || vaultKey === null || vaultKey === '') {
      throw new Error('bookmarks: a remembered key carries the vault key');
    }
    if (authSecret === undefined || authSecret === null || authSecret === '') {
      throw new Error('bookmarks: a remembered device carries the auth key');
    }
    const [key, authKey] = await Promise.all([
      keyFromBytes(vaultKey),
      authKeyFromBytes(authSecret)
    ]);
    const record = { accountId, key, authKey, savedAt: now() };
    /* Only present when this device has them, so a record written by an older build reads the
       same and an older build reads a newer record by ignoring the two new fields. */
    if (typeof extras.serverId === 'string' && extras.serverId !== '') {
      record.serverId = extras.serverId;
    }
    if (extras.proofKey !== undefined && extras.proofKey !== null) {
      record.proofKey = extras.proofKey;
    }
    await adapter.put(REMEMBERED, record);
  }

  function isFresh(savedAt) {
    if (typeof savedAt !== 'number' || !Number.isFinite(savedAt)) return false;
    /* A record dated after the clock has no age a lifetime can bound, so it is stale, not fresh. */
    const age = now() - savedAt;
    return age >= 0 && age < REMEMBER_LIFETIME_MS;
  }

  /**
   * The remembered record, or null.
   *
   * A record past its lifetime is deleted and reports nothing, so the phrase is asked for
   * again. A record written before keys were stored carries `keyBytes` and `authSecret` as
   * base64url text; it is imported into non-extractable keys, written back in the new shape,
   * and the old fields go with the write. An upgrade keeps working without the phrase.
   *
   * A record written under the committed scheme also carries `serverId` and `proofKey`; they are
   * handed back as they were stored. A record from before that has neither, and its absence is the
   * whole signal that the phrase's own id is the name this device signs in under.
   */
  async function readRemembered() {
    const record = await adapter.get(REMEMBERED);
    if (!record) return null;

    if (!isFresh(record.savedAt)) {
      await adapter.delete(REMEMBERED);
      return null;
    }

    if (record.key !== undefined) return record;

    /* The pre-key shape. A record from before sync exists has no auth secret; the app asks
       for the phrase once and stores the key it derives. */
    if (typeof record.keyBytes !== 'string' || record.keyBytes === '') {
      await adapter.delete(REMEMBERED);
      return null;
    }

    let key;
    let authKey = null;
    try {
      key = await keyFromBytes(record.keyBytes);
      if (typeof record.authSecret === 'string' && record.authSecret !== '') {
        authKey = await authKeyFromBytes(record.authSecret);
      }
    } catch {
      await adapter.delete(REMEMBERED);
      return null;
    }

    const migrated = { accountId: record.accountId, key, savedAt: record.savedAt };
    if (authKey) migrated.authKey = authKey;
    await adapter.put(REMEMBERED, migrated);
    return migrated;
  }

  async function forget() {
    await adapter.delete(REMEMBERED);
  }

  /** Whether a sealed document is on this device, answerable before any phrase is entered. */
  async function hasVault() {
    return Boolean(await adapter.get(DOCUMENT));
  }

  /** Wipe this device: the sealed document, its history and the remembered key. */
  async function clear() {
    for (const key of await adapter.keys()) {
      await adapter.delete(key);
    }
  }

  return {
    load,
    save,
    history,
    readHistory,
    remember,
    readRemembered,
    forget,
    hasVault,
    clear
  };
}

/**
 * The browser adapter: one object store, every record keyed by a string.
 *
 * A transaction is opened per call. The store is a handful of records and the app writes once
 * per edit, so batching would add a lifecycle to reason about and buy nothing.
 */
export function indexedDbAdapter() {
  let database = null;

  function open() {
    if (database) return database;
    database = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE)) {
          request.result.createObjectStore(STORE);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('bookmarks: index is closed'));
      request.onblocked = () => reject(new Error('bookmarks: another tab is upgrading the index'));
    });
    return database;
  }

  async function get(key) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function put(key, value) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE, 'readwrite');
      transaction.objectStore(STORE).put(value, key);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  }

  async function remove(key) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE, 'readwrite');
      transaction.objectStore(STORE).delete(key);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  }

  async function keys() {
    const db = await open();
    return new Promise((resolve, reject) => {
      const request = db.transaction(STORE, 'readonly').objectStore(STORE).getAllKeys();
      request.onsuccess = () => resolve(request.result.map(String));
      request.onerror = () => reject(request.error);
    });
  }

  return { get, put, delete: remove, keys };
}
