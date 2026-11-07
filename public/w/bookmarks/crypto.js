/**
 * Bookmarks — the one module that turns a phrase into a vault key.
 *
 * A phrase is 13 words from `wordlist.js`, about 134 bits. It is stretched once with
 * PBKDF2-SHA256, and the result is split with HKDF into two values that never meet again:
 * the AES-256-GCM key that seals the vault, and the auth secret the server uses to recognise
 * the account. A database holding the auth secret says nothing about the key.
 *
 * The PBKDF2 salt is a hash of the account id, so it is deterministic per account and carries
 * no secret the server does not already hold. Nothing here is stored and nothing has to be
 * migrated: the same phrase derives the same key on any device, for as long as the phrase
 * exists. That is the property the retired client lacked.
 *
 * Plain ES module, one import (the word list), no build step. WebCrypto is `globalThis.crypto`
 * in a browser and under `node --test`.
 */

import { WORDLIST } from './wordlist.js';

export const DOMAIN_PREFIX = 'bmk1:';

/* Every derivation input starts with one of these, and no label prefixes another. */
export const LABELS = Object.freeze({
  account: `${DOMAIN_PREFIX}account:`,
  auth: `${DOMAIN_PREFIX}auth:`,
  key: `${DOMAIN_PREFIX}key:`
});

export const WORD_COUNT = 13;
export const PBKDF2_ITERATIONS = 210_000;
export const KEY_BITS = 256;
export const IV_BYTES = 12;
export const ACCOUNT_ID_BYTES = 16;
/* 16 bytes, base64url, unpadded. */
export const ACCOUNT_ID_LENGTH = 22;
/* 32 bytes, base64url, unpadded. */
export const AUTH_LENGTH = 43;

const WORD_SET = new Set(WORDLIST);
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/* 1296 does not divide 65536, so a plain modulo would bias the first 736 words. Read two bytes
   and discard anything past the last whole block instead. */
const WORDS_PER_BLOCK = Math.floor(65_536 / WORDLIST.length) * WORDLIST.length;

function toBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text, what) {
  if (typeof text !== 'string' || text === '' || !/^[A-Za-z0-9_-]+$/.test(text)) {
    throw new Error(`bookmarks: ${what} is not base64url`);
  }
  const padding = (4 - (text.length % 4)) % 4;
  let binary;
  try {
    if (padding === 3) throw new Error('impossible length');
    binary = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(padding));
  } catch {
    throw new Error(`bookmarks: ${what} is not base64url`);
  }
  const bytes = new Uint8Array(binary.length);
  for (let at = 0; at < binary.length; at += 1) bytes[at] = binary.charCodeAt(at);
  return bytes;
}

async function sha256(text) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text)));
}

function isCryptoKey(value) {
  return typeof CryptoKey === 'function' && value instanceof CryptoKey;
}

/** A fresh phrase, uniform over the list, joined by single spaces. */
export function generatePhrase() {
  const words = [];
  while (words.length < WORD_COUNT) {
    for (const value of crypto.getRandomValues(new Uint16Array(1))) {
      if (value < WORDS_PER_BLOCK) words.push(WORDLIST[value % WORDLIST.length]);
    }
  }
  return words.join(' ');
}

/**
 * Fold what a person typed into the canonical form, or refuse it.
 *
 * Case and spacing carry no meaning. An unknown word is a refusal rather than a silent
 * substitution: a phrase with a typo must not derive a key for a vault nobody can open.
 *
 * @returns {string} the 13 lowercase words, single-spaced
 */
/**
 * What is wrong with a typed phrase, in words a person can act on — or null when it is usable.
 *
 * `normalizePhrase` throws terse, internal messages; unlocking shows this instead, because "got
 * 12" and "is not a word in the list" tell the reader nothing about what to do next.
 */
export function phraseProblem(input) {
  const words = String(input ?? '')
    .toLowerCase()
    .replace(/[\s\u00a0]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);

  if (words.length !== WORD_COUNT) {
    const noun = words.length === 1 ? 'word' : 'words';
    return words.length === 0
      ? `The phrase has ${WORD_COUNT} words.`
      : `That is ${words.length} ${noun} — the phrase is ${WORD_COUNT}.`;
  }

  const unknown = words.find((word) => !WORD_SET.has(word));
  if (unknown) {
    return `“${unknown}” is not one of the words these phrases use — check the spelling.`;
  }

  return null;
}

export function normalizePhrase(input) {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new Error('bookmarks: a phrase is required');
  }

  const words = input
    .toLowerCase()
    .replace(/[\s\u00a0]+/g, ' ')
    .trim()
    .split(' ');

  if (words.length !== WORD_COUNT) {
    throw new Error(`bookmarks: a phrase is ${WORD_COUNT} words, got ${words.length}`);
  }
  for (const word of words) {
    if (!WORD_SET.has(word)) {
      throw new Error(`bookmarks: "${word}" is not a word in the list`);
    }
  }
  return words.join(' ');
}

async function accountIdFromNormalized(normalized) {
  const digest = await sha256(`${LABELS.account}${normalized}`);
  return toBase64Url(digest.slice(0, ACCOUNT_ID_BYTES));
}

/**
 * The public account id: 22 base64url characters, derived from the phrase so that no lookup
 * table, handle or email is needed to find the account. It is a fast hash of a 134-bit secret,
 * which is not a guessing target at that size.
 */
export async function accountIdFromPhrase(input) {
  return accountIdFromNormalized(normalizePhrase(input));
}

async function deriveMaster(normalized, accountId) {
  const salt = await sha256(`${LABELS.key}${accountId}`);
  const material = await crypto.subtle.importKey(
    'raw',
    encoder.encode(normalized),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    material,
    KEY_BITS
  );
  return { bits: new Uint8Array(bits), salt };
}

async function hkdf(master, salt, label) {
  const material = await crypto.subtle.importKey('raw', master, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info: encoder.encode(label) },
    material,
    KEY_BITS
  );
  return new Uint8Array(bits);
}

/**
 * The vault's AES-256-GCM key. Non-extractable: it exists to seal and open, never as bytes.
 */
export async function deriveVaultKey(input) {
  const normalized = normalizePhrase(input);
  const accountId = await accountIdFromNormalized(normalized);
  const { bits, salt } = await deriveMaster(normalized, accountId);
  const keyBits = await hkdf(bits, salt, `${LABELS.key}enc`);
  return crypto.subtle.importKey('raw', keyBits, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/**
 * The secret the server stores to recognise the account. It is a different HKDF output from
 * the key above, so a server that holds it can authenticate a request and can never open a vault.
 */
export async function deriveAuthSecret(input) {
  const normalized = normalizePhrase(input);
  const accountId = await accountIdFromNormalized(normalized);
  const { bits, salt } = await deriveMaster(normalized, accountId);
  return toBase64Url(await hkdf(bits, salt, `${LABELS.auth}secret`));
}

/**
 * Everything one phrase derives, from a single PBKDF2 pass. The app calls this once per unlock
 * instead of deriving each value separately.
 *
 * `vaultKey` and `authKey` are non-extractable CryptoKeys: they can seal, open and sign, and no
 * script can read them back as bytes. They are also the only form the "stay unlocked" record
 * stores, because IndexedDB structured-clones a CryptoKey and keeps it usable while keeping it
 * unexportable.
 *
 * `authSecret` is the base64url plaintext. It exists only because creating an account on the
 * server sends it once; nothing writes it to this device.
 *
 * @returns {Promise<{accountId: string, vaultKey: CryptoKey, authKey: CryptoKey, authSecret: string}>}
 */
export async function deriveAccount(input) {
  const normalized = normalizePhrase(input);
  const accountId = await accountIdFromNormalized(normalized);
  const { bits, salt } = await deriveMaster(normalized, accountId);
  const [keyBits, authBits] = await Promise.all([
    hkdf(bits, salt, `${LABELS.key}enc`),
    hkdf(bits, salt, `${LABELS.auth}secret`)
  ]);
  const [vaultKey, authKey] = await Promise.all([
    crypto.subtle.importKey('raw', keyBits, 'AES-GCM', false, ['encrypt', 'decrypt']),
    crypto.subtle.importKey('raw', authBits, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  ]);
  return {
    accountId,
    vaultKey,
    authKey,
    authSecret: toBase64Url(authBits)
  };
}

/**
 * The login proof: HMAC-SHA256 over the account and the server's nonce, keyed by the auth
 * secret. The secret itself never crosses the wire, and a proof is useless once the nonce is
 * spent. The account is inside the signed text so a proof cannot be replayed against another
 * account even if a nonce were somehow reused.
 *
 * `authSecret` is either the base64url secret a phrase derives or the non-extractable HMAC
 * CryptoKey a remembered device holds. Both sign the same text, so a reload keeps signing in.
 *
 * @returns {Promise<string>} base64url, 43 characters
 */
export async function proveAuth(authSecret, accountId, nonce) {
  if (typeof nonce !== 'string' || nonce === '') {
    throw new Error('bookmarks: a proof needs a nonce');
  }
  const key = isCryptoKey(authSecret)
    ? authSecret
    : await authKeyFromBytes(authSecret);
  if (key.algorithm?.name !== 'HMAC') {
    throw new Error('bookmarks: a proof is signed with an HMAC key');
  }
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(`${accountId}\n${nonce}`)
  );
  return toBase64Url(new Uint8Array(signature));
}

/**
 * The auth secret as the key that signs proofs, non-extractable and 256 bits. A CryptoKey is
 * returned as it is, so a remembered record can be passed straight through; base64url text is
 * imported, which is what a record written before the record stored keys still carries.
 */
export async function authKeyFromBytes(secret) {
  if (isCryptoKey(secret)) {
    if (secret.algorithm?.name !== 'HMAC') {
      throw new Error('bookmarks: an auth key signs HMAC');
    }
    return secret;
  }
  const raw = fromBase64Url(secret, 'the auth secret');
  if (raw.length * 8 !== KEY_BITS) {
    throw new Error(`bookmarks: an auth secret is ${KEY_BITS} bits`);
  }
  return crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

/**
 * The vault key from remembered material: a non-extractable CryptoKey passes through, and
 * base64url bytes are imported into one. The bytes are the shape older records stored; they are
 * used once and never kept, so an upgrade leaves no readable key behind.
 */
export async function keyFromBytes(material) {
  if (isCryptoKey(material)) {
    if (material.algorithm?.name !== 'AES-GCM') {
      throw new Error('bookmarks: a remembered key is an AES-GCM key');
    }
    return material;
  }
  const raw = fromBase64Url(material, 'the remembered key');
  if (raw.length * 8 !== KEY_BITS) {
    throw new Error(`bookmarks: a remembered key is ${KEY_BITS} bits`);
  }
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/**
 * The GCM parameters for one blob. The associated data is authenticated and never encrypted:
 * it names the account the blob belongs to, so a vault lifted into another account fails to
 * open even if that account somehow shares a key.
 */
function gcmParams(iv, associated) {
  const params = { name: 'AES-GCM', iv, tagLength: 128 };
  if (associated === undefined || associated === '') return params;
  if (typeof associated !== 'string') {
    throw new Error('bookmarks: associated data must be a string');
  }
  params.additionalData = encoder.encode(associated);
  return params;
}

/** Seal a JSON value under the vault key, with a fresh 12-byte IV every time. */
export async function seal(key, value, associated) {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = await crypto.subtle.encrypt(
    gcmParams(iv, associated),
    key,
    encoder.encode(JSON.stringify(value))
  );
  return { iv: toBase64Url(iv), ct: toBase64Url(new Uint8Array(ciphertext)) };
}

/**
 * Open a sealed value, or throw. The GCM tag is what decides: a flipped bit anywhere in the
 * ciphertext, the IV, the tag or the associated data is a refusal, never a partial read.
 */
export async function open(key, sealed, associated) {
  if (!sealed || typeof sealed.iv !== 'string' || typeof sealed.ct !== 'string') {
    throw new Error('bookmarks: a sealed value carries an iv and a ct');
  }

  const iv = fromBase64Url(sealed.iv, 'the iv');
  if (iv.length !== IV_BYTES) {
    throw new Error(`bookmarks: a sealed value carries a ${IV_BYTES}-byte iv`);
  }
  const ciphertext = fromBase64Url(sealed.ct, 'the ciphertext');

  let plaintext;
  try {
    plaintext = await crypto.subtle.decrypt(gcmParams(iv, associated), key, ciphertext);
  } catch {
    throw new Error('bookmarks: this value was not sealed under this key');
  }

  try {
    return JSON.parse(decoder.decode(plaintext));
  } catch {
    throw new Error('bookmarks: a sealed value carries JSON');
  }
}
