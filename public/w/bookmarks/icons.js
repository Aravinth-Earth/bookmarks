/**
 * Bookmarks — the favicon path, without a request from this page to any bookmarked site.
 *
 * The Worker fetches `https://<host>/favicon.ico`, or the icon the page declares, and serves it
 * back from our own origin. Because it is same-origin, the page can read the bytes; because it
 * can read them, the image can be downscaled and stored inside the sealed vault. After that the
 * icon is offline, and the host is asked again only if the icon is still missing a week later.
 *
 * The site learns that this Worker asked it for an icon, at that moment. The hostname travels
 * in a header; the query string carries only its SHA-256, an unsalted digest that a list of
 * hostnames can match.
 */

const API = '/w/bookmarks/api/icon';
const TITLE_API = '/w/bookmarks/api/title';
const MAX_BYTES = 64 * 1024;
const RAW_FALLBACK_BYTES = 8 * 1024;
const TILE_PX = 32;

function toBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The cache key the server recomputes before it fetches anything. */
export async function hostHash(hostname) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(hostname));
  return toBase64Url(new Uint8Array(digest));
}

function toDataUri(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error ?? new Error('could not read the icon'));
    reader.readAsDataURL(blob);
  });
}

/**
 * Decode, centre and downscale to a 32px PNG.
 *
 * A 5KB favicon becomes about 1KB, which is what lets a few hundred of them live inside a vault
 * that still has to fit through the sync cap. A format the browser cannot decode (some SVGs)
 * is kept as-is only when it is already small.
 */
async function shrink(blob) {
  if (typeof createImageBitmap !== 'function') {
    return blob.size <= RAW_FALLBACK_BYTES ? toDataUri(blob) : null;
  }

  try {
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    canvas.width = TILE_PX;
    canvas.height = TILE_PX;

    const context = canvas.getContext('2d');
    if (!context) throw new Error('no 2d context');

    const scale = Math.min(TILE_PX / bitmap.width, TILE_PX / bitmap.height);
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    context.drawImage(bitmap, (TILE_PX - width) / 2, (TILE_PX - height) / 2, width, height);
    bitmap.close?.();
    return canvas.toDataURL('image/png');
  } catch {
    if (blob.size > RAW_FALLBACK_BYTES) return null;
    return toDataUri(blob);
  }
}

/**
 * One icon as a data URI, or null. Never throws: an icon is an enhancement, and a site without
 * one simply keeps its lettered tile.
 *
 * @param {string} hostname
 * @param {{fresh?: boolean}} [options] `fresh` bypasses a cached "no icon" answer, which is
 *   what an explicit "fetch missing icons" run means.
 * @returns {Promise<string | null>}
 */
export async function fetchIcon(hostname, { fresh = false } = {}) {
  if (typeof hostname !== 'string' || hostname === '') return null;

  const hash = await hostHash(hostname);

  let response;
  try {
    response = await fetch(`${API}?h=${hash}`, {
      headers: { 'x-icon-host': hostname },
      credentials: 'same-origin',
      ...(fresh ? { cache: 'reload' } : {})
    });
  } catch {
    return null;
  }

  if (!response.ok) return null;

  const blob = await response.blob().catch(() => null);
  if (!blob || blob.size === 0 || blob.size > MAX_BYTES) return null;

  return shrink(blob).catch(() => null);
}

/**
 * The page's own <title>, for the name field. Same shape as the icon: the host rides in a
 * header, the query carries only its hash, and a miss is simply no suggestion.
 */
export async function fetchPageTitle(hostname) {
  if (typeof hostname !== 'string' || hostname === '') return null;

  let response;
  try {
    const hash = await hostHash(hostname);
    response = await fetch(`${TITLE_API}?h=${hash}`, {
      headers: { 'x-page-host': hostname },
      credentials: 'same-origin'
    });
  } catch {
    return null;
  }

  if (!response.ok) return null;

  const payload = await response.json().catch(() => null);
  const title = typeof payload?.title === 'string' ? payload.title.trim() : '';
  return title === '' ? null : title;
}
