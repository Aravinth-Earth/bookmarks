/**
 * The page's own bookkeeping on this device.
 *
 * Three things live outside the sealed vault because the page needs them before any phrase is
 * entered: how the list looks, which theme is chosen, and when each site was last asked for an
 * icon. None of it is vault data, so none of it is sealed — which makes the icon index the one
 * place a list of sites could sit in the clear. It is keyed by a digest of the hostname for that
 * reason, and every key the page writes is listed here so "Clear this device" can remove all of
 * them rather than the vault alone.
 */

export const ICON_TRIES_KEY = 'bookmarks-icon-tries';
export const VIEW_KEY = 'bookmarks-view';
export const SIZE_KEY = 'bookmarks-font-size';
export const THEME_KEY = 'site-theme';
export const DEVICE_ID_KEY = 'bookmarks-device-id';

/** Every localStorage key the page writes. Clearing a device removes each one. */
export const DEVICE_KEYS = [ICON_TRIES_KEY, VIEW_KEY, SIZE_KEY, THEME_KEY];

/**
 * This browser profile's own name, made once and kept.
 *
 * It is not an account, not a fingerprint and not derived from anything: eight random bytes, so two devices cannot
 * share one by accident, and a count can say which device saw which visits.
 *
 * It is deliberately not in DEVICE_KEYS: a name that a wipe throws away is a name the next unlock invents again, and
 * the counts this device already put in the vault would be counted a second time under the new name. Clearing a
 * device removes what names a place (the icon index) and leaves eight random bytes that name nothing.
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
 * A stable digest of a hostname. The retry index is keyed by this rather than by the name, so the
 * record of which sites were asked names no site in the clear.
 */
export async function hostKey(hostname) {
  const bytes = new TextEncoder().encode(`bookmarks-icon-host:${String(hostname).toLowerCase()}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest).slice(0, 16), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Keeps the entries that are a digest with a usable timestamp. Anything else — a name from an
 * earlier version of the page, a value that is not a number — is dropped, so a stored map that
 * predates the digest does not survive its first read.
 */
export function pruneIconTries(entries) {
  const kept = {};
  let dropped = 0;
  for (const [key, at] of Object.entries(entries && typeof entries === 'object' ? entries : {})) {
    const stamp = Number(at);
    if (KEY_SHAPE.test(key) && Number.isFinite(stamp)) kept[key] = stamp;
    else dropped += 1;
  }
  return { kept, dropped };
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
