/**
 * Bookmarks — this device's copy of the vault.
 *
 * One sealed document, the version it was sealed at, a short history of the versions before it,
 * and the remembered key when the user asked this device to stay unlocked. Nothing here is
 * plaintext: the document arrives already sealed, and this module never sees the key that
 * sealed it.
 *
 * Storage sits behind a four-method adapter so the logic is testable under `node --test`, where
 * IndexedDB does not exist. `indexedDbAdapter()` is the only browser-specific part.
 */

export const DB_NAME = 'bookmarks';
export const DB_VERSION = 1;
export const STORE = 'vault';
/* Five previous versions is enough to undo a bad import or a mistaken clear, and small enough
   that the whole store stays a few hundred kilobytes. */
export const HISTORY_LIMIT = 5;

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

  async function remember(accountId, keyBytes, authSecret) {
    if (typeof keyBytes !== 'string' || keyBytes === '') {
      throw new Error('bookmarks: a remembered key carries the key bytes');
    }
    if (typeof authSecret !== 'string' || authSecret === '') {
      throw new Error('bookmarks: a remembered device carries the auth secret');
    }
    await adapter.put(REMEMBERED, { accountId, keyBytes, authSecret, savedAt: now() });
  }

  async function readRemembered() {
    return (await adapter.get(REMEMBERED)) ?? null;
  }

  async function forget() {
    await adapter.delete(REMEMBERED);
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
