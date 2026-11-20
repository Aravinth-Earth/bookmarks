/**
 * The page's own bookkeeping on this device.
 *
 * The page needs a few things before any phrase is entered: how the list looks, which theme is
 * chosen, and the name this browser profile counts under. None of it is vault data, so none of it
 * is sealed. The two icon maps are no longer on this list: when each site was last asked for an
 * icon, and the pictures the collected rows show, both live inside the sealed document. A copy of
 * this browser profile therefore holds ciphertext for them and names no site.
 *
 * The two old key names are still listed, because a device upgraded from an earlier version can
 * hold one until the first unlock deletes it, and "Clear this device" has to be able to reach a
 * leftover. Every key the page writes is listed here, so a clear removes all of them rather than
 * the vault alone.
 */

export const ICON_TRIES_KEY = 'bookmarks-icon-tries';
export const VIEW_KEY = 'bookmarks-view';
export const SIZE_KEY = 'bookmarks-font-size';
export const THEME_KEY = 'site-theme';
export const DEVICE_ID_KEY = 'bookmarks-device-id';
export const COLLECTED_ICON_KEY = 'collected-icons';

/**
 * Every localStorage key the page writes, and every key it used to write.
 *
 * The two icon keys are the names earlier versions wrote. Nothing reads them now: a clear map is
 * not migrated into the sealed document, because carrying it across would keep the leak for every
 * profile copied before this version ran. They stay on the list so a leftover is removed with the
 * rest, and `forgetLegacyIconMaps` deletes both when a vault is opened.
 */
export const DEVICE_KEYS = [ICON_TRIES_KEY, VIEW_KEY, SIZE_KEY, THEME_KEY, COLLECTED_ICON_KEY];

/**
 * This browser profile's own name, made once and kept.
 *
 * It is not an account, not a fingerprint and not derived from anything: eight random bytes, so two devices cannot
 * share one by accident, and a count can say which device saw which visits.
 *
 * It is deliberately not in DEVICE_KEYS: a name that a wipe throws away is a name the next unlock invents again, and
 * the counts this device already put in the vault would be counted a second time under the new name. Clearing a
 * device removes the sealed vault and this page's settings, and leaves eight random bytes that name nothing.
 */
export function deviceId(storage = globalThis.localStorage) {
  try {
    const saved = storage.getItem(DEVICE_ID_KEY);
    if (typeof saved === 'string' && /^[0-9a-f]{16}$/.test(saved)) return saved;

    const made = Array.from(crypto.getRandomValues(new Uint8Array(8)), (byte) => byte.toString(16).padStart(2, '0')).join('');
    storage.setItem(DEVICE_ID_KEY, made);
    return made;
  } catch {
    /* Storage refused: a name that lasts as long as the page beats no counts at all. */
    return 'unsettled';
  }
}

/** A key is what `hostKey` returns: thirty-two lowercase hex characters. */
const KEY_SHAPE = /^[0-9a-f]{32}$/;

/**
 * A stable digest of a hostname, so the retry index stays small and keeps one shape across launches.
 *
 * The digest is not what protects the map — the map is sealed inside the vault now, and a copy of
 * the profile holds ciphertext — but it is still fixed and short, and one digest per host is both.
 * It is also a dictionary lookup for anyone who does hold the bytes: the input is a hostname, so
 * a guess is cheap. That is a reason the bytes are sealed, not a reason to keep them here.
 */
export async function hostKey(hostname) {
  const bytes = new TextEncoder().encode(`bookmarks-icon-host:${String(hostname).toLowerCase()}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest).slice(0, 16), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/* The retry index is a courtesy, not a record: a host answered in the last season and no answer
   changes after that, so an entry older than the window is noise inside a document that is
   sealed and pushed. */
export const ICON_TRIES_DAYS = 90;
const ICON_TRIES_MS = ICON_TRIES_DAYS * 24 * 60 * 60 * 1000;

/**
 * Keeps the entries that are a digest with a usable timestamp from the last season. Anything
 * else — a name from an earlier version of the page, a value that is not a number, an entry
 * older than the window — is dropped, so a map that predates the digest does not survive its
 * first read.
 *
 * `now` and `maxAgeMs` are parameters so a caller, or a test, can ask about a particular moment
 * rather than about today.
 */
export function pruneIconTries(entries, { now = Date.now(), maxAgeMs = ICON_TRIES_MS } = {}) {
  const kept = {};
  let dropped = 0;
  for (const [key, at] of Object.entries(entries && typeof entries === 'object' ? entries : {})) {
    const stamp = Number(at);
    if (KEY_SHAPE.test(key) && Number.isFinite(stamp) && stamp >= now - maxAgeMs) kept[key] = stamp;
    else dropped += 1;
  }
  return { kept, dropped };
}

/**
 * Delete the two icon maps earlier versions kept on this device.
 *
 * Called the moment a vault is opened, before either map is read. Nothing is read out of them
 * first: their contents are exactly the clear map this change exists to stop copying around, and
 * carrying them into the sealed document would leave that map readable in every profile copied
 * before the sweep ran.
 */
export function forgetLegacyIconMaps(storage = globalThis.localStorage) {
  for (const key of [ICON_TRIES_KEY, COLLECTED_ICON_KEY]) {
    try {
      storage.removeItem(key);
    } catch {
      /* Storage refused; the key stays on the clear list, and the next open tries again. */
    }
  }
}

/** Removes every key the page writes from this device. */
export function clearDeviceStorage(storage = globalThis.localStorage) {
  for (const key of DEVICE_KEYS) {
    try {
      storage.removeItem(key);
    } catch {
      /* Storage refused or is unavailable; there is nothing more to remove. */
    }
  }
}

/**
 * Wipe this device: the vault it holds, and every key this page writes.
 *
 * Both halves run from one call so a clear cannot take the vault and leave a key behind, or empty
 * the keys and keep the seal. The icon maps are inside the sealed document, so `vault.clear()` is
 * what removes them — the document, its history and the remembered key share one store, and it
 * deletes every record in it. The key names an earlier version wrote are on `DEVICE_KEYS` and go
 * with the rest.
 *
 * `vault` is the store from vault.js. A storage refusal is the caller's to handle: the caller
 * decides whether a device that could not be wiped may go on being used.
 */
export async function clearDevice({ vault, storage = globalThis.localStorage }) {
  await vault.clear();
  clearDeviceStorage(storage);
}
