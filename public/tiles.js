/**
 * Bookmarks — the picture beside a bookmark, without a request to anyone.
 *
 * A bookmark gets a coloured tile with its first letter. The colour is either the one the
 * retired app already stored for that site, or one picked deterministically from a small
 * accessible palette by hashing the hostname — so the same site looks the same on every device,
 * with no icon fetch and no third party learning what is in the vault.
 *
 * Stored icons, when a user sets one, live in the sealed document as a data URI and take
 * precedence over the tile. This module only decides what to show when there is none.
 */

/* Twelve pairs, each checked for contrast, chosen to sit beside the site's own dark surfaces. */
export const PALETTE = Object.freeze([
  { background: '#1f6f65', foreground: '#ffffff' },
  { background: '#2d5f8b', foreground: '#ffffff' },
  { background: '#6b4a8f', foreground: '#ffffff' },
  { background: '#8b3f52', foreground: '#ffffff' },
  { background: '#8a5a1f', foreground: '#ffffff' },
  { background: '#3f6b32', foreground: '#ffffff' },
  { background: '#1f5f74', foreground: '#ffffff' },
  { background: '#5a4a8b', foreground: '#ffffff' },
  { background: '#7a4b2a', foreground: '#ffffff' },
  { background: '#2f6b5a', foreground: '#ffffff' },
  { background: '#6b3f3f', foreground: '#ffffff' },
  { background: '#3a5a6b', foreground: '#ffffff' }
]);

const COLOR = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;

function hash(text) {
  /* FNV-1a, 32-bit. Small, stable, and good enough to spread hostnames across a palette. */
  let value = 0x811c9dc5;
  for (let at = 0; at < text.length; at += 1) {
    value ^= text.charCodeAt(at);
    value = Math.imul(value, 0x01000193);
  }
  return value >>> 0;
}

/**
 * The relative luminance of a #rrggbb colour, per WCAG.
 * @returns {number} 0 (black) to 1 (white)
 */
export function luminance(hex) {
  const match = typeof hex === 'string' ? hex.match(COLOR) : null;
  if (!match) return 0;

  const channels = match.slice(1).map((pair) => {
    const value = Number.parseInt(pair, 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

/**
 * Black or white, whichever reads better on that background.
 *
 * Pure black, not a near-black: with #101414 as the ink the two choices cross at about 4.3:1,
 * which is under AA, so some mid-tone seed always failed. Black and white cross at 0.179 with
 * both sides at 4.58:1, so this threshold keeps every seed at or above 4.5.
 *
 * A threshold of 0.35 — "light background" by intuition — left mid-tones with white text at
 * about 2.6:1, which is why some pills read as a smudge.
 */
export function foregroundFor(hex) {
  return luminance(hex) > 0.179 ? '#000000' : '#ffffff';
}

function initialOf(bookmark) {
  const name = typeof bookmark?.name === 'string' ? bookmark.name.trim() : '';
  if (name !== '') return [...name][0].toUpperCase();

  const hostname = String(bookmark?.hostname ?? '').replace(/^www\./i, '');
  const first = [...hostname].find((character) => /[\p{L}\p{N}]/u.test(character));
  return first ? first.toUpperCase() : '#';
}

/**
 * The tile for one bookmark.
 *
 * @returns {{initial: string, background: string, foreground: string}}
 */
export function tileFor(bookmark) {
  const initial = initialOf(bookmark);

  const stored = typeof bookmark?.color === 'string' ? bookmark.color : null;
  if (stored && COLOR.test(stored)) {
    return { initial, background: stored, foreground: foregroundFor(stored) };
  }

  const hostname = String(bookmark?.hostname ?? bookmark?.url ?? '');
  const picked = PALETTE[hash(hostname) % PALETTE.length];
  return { initial, background: picked.background, foreground: picked.foreground };
}
