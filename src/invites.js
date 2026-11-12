/**
 * Bookmarks — invite codes.
 *
 * A code is a bearer token for one slot: whoever holds it can create one account, once, until it expires. It is
 * long because length is the only thing standing between a guess and a slot — 256 random bits, written in an
 * alphabet with no letters that look like digits, so a code read aloud or copied by hand survives the trip.
 *
 * Only a digest is stored. The plaintext exists for the one reply that creates it and is never written anywhere
 * after that: a dump of the registry cannot be turned back into working codes.
 */

/** Crockford's alphabet: no I, L, O or U, so nothing reads as something else. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** Thirty-two bytes: 255 bits of randomness written out, which is 51 characters of this alphabet. */
export const CODE_BYTES = 32;
export const CODE_CHARS = 51;
/** Four characters to a group, so a code can be read out in pieces. */
const GROUP = 4;

/** A live code lasts a week unless the operator says otherwise. */
export const INVITE_TTL_MS = 7 * 86_400_000;
export const MAX_INVITES = 200;
export const MAX_CODES_PER_CALL = 20;

/**
 * A new code: random bytes, written in the alphabet, in groups of four separated by dashes.
 *
 * `crypto.getRandomValues` is the only source; there is no seed, no counter and nothing derived from the account
 * or the clock, so a code says nothing about who it is for.
 */
export function newCode(bytes = crypto.getRandomValues(new Uint8Array(CODE_BYTES))) {
  let bits = '';
  for (const byte of bytes) bits += byte.toString(2).padStart(8, '0');

  let code = '';
  for (let at = 0; at + 5 <= bits.length; at += 5) {
    code += ALPHABET[Number.parseInt(bits.slice(at, at + 5), 2)];
  }

  const groups = [];
  for (let at = 0; at < code.length; at += GROUP) groups.push(code.slice(at, at + GROUP));
  return groups.join('-');
}

/**
 * A code as it is compared: dashes, spaces and case are the reader's business, not the code's. A code that carries
 * a character outside the alphabet is returned as it was, so it cannot match any stored digest.
 */
export function normaliseCode(input) {
  return String(input ?? '')
    .toUpperCase()
    .replace(/[\s-]+/g, '');
}

/** The digest stored in place of the code. */
export async function hashCode(code) {
  const bytes = new TextEncoder().encode(`bookmarks-invite:${normaliseCode(code)}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** The first eight characters of a digest: enough to name a code in a list, useless as a code. */
export function shortHash(hash) {
  return String(hash ?? '').slice(0, 8);
}
