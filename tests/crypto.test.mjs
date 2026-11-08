/**
 * The vault's browser crypto core: the phrase, the account id, the key and the sealed blob.
 *
 * Every absence check is paired with a presence check, so a module that returns nothing cannot
 * make a test pass by making it vacuous.
 *
 * The determinism test is the important one. The retired client generated a new salt on every
 * unlock and never read the stored one back, so every session derived a different key and
 * anything sealed earlier became unopenable. A test that derives twice and opens across the two
 * derivations is the one thing that would have caught it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ACCOUNT_ID_LENGTH,
  DOMAIN_PREFIX,
  IV_BYTES,
  KEY_BITS,
  LABELS,
  PAD_BUCKET_BYTES,
  PAD_VERSION,
  PBKDF2_ITERATIONS,
  VAULT_AD_VERSION,
  WORD_COUNT,
  accountIdFromPhrase,
  authKeyFromBytes,
  deriveAccount,
  deriveAuthSecret,
  deriveVaultKey,
  generatePhrase,
  keyFromBytes,
  normalizePhrase,
  open,
  openVault,
  phraseProblem,
  proveAuth,
  seal,
  sealVault,
  vaultAssociated
} from '../public/w/bookmarks/crypto.js';
import { WORDLIST } from '../public/w/bookmarks/wordlist.js';

const WORD = /^[a-z]+(?:-[a-z]+)*$/;
const BASE64URL_22 = /^[A-Za-z0-9_-]{22}$/;
const BASE64URL_43 = /^[A-Za-z0-9_-]{43}$/;

/* Two fixed phrases, so a failure names a specific input rather than a random one. */
const PHRASE_A = WORDLIST.slice(0, WORD_COUNT).join(' ');
const PHRASE_B = WORDLIST.slice(WORD_COUNT, WORD_COUNT * 2).join(' ');

function flipFirstCharacter(text) {
  const first = text[0] === 'A' ? 'B' : 'A';
  return first + text.slice(1);
}

/* What the stored length is read as: the ciphertext bytes, where GCM adds a 16-byte tag. */
const GCM_TAG_BYTES = 16;

function ciphertextBytes(sealed) {
  return Buffer.from(sealed.ct, 'base64url').length;
}

/* The exact byte accounting of the padded envelope, written out so the tests state the format. */
function envelopeBytes(document) {
  return Buffer.byteLength(JSON.stringify({ v: PAD_VERSION, doc: document, pad: '' }));
}

/** Seal the way the module did before padding existed: the bare document, no envelope. */
async function sealUnpadded(key, value, associated) {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv,
      tagLength: 128,
      additionalData: new TextEncoder().encode(associated)
    },
    key,
    new TextEncoder().encode(JSON.stringify(value))
  );
  return {
    iv: Buffer.from(iv).toString('base64url'),
    ct: Buffer.from(ciphertext).toString('base64url')
  };
}

test('the wordlist is the EFF short list and thirteen words carry 134 bits', () => {
  assert.equal(WORDLIST.length, 1296);
  assert.equal(new Set(WORDLIST).size, 1296, 'no word may repeat');
  for (const word of WORDLIST) {
    assert.match(word, WORD, `"${word}" is not a lowercase word`);
    assert.ok(word.length >= 3 && word.length <= 5, `"${word}" is outside 3-5 letters`);
  }

  assert.equal(WORD_COUNT, 13);
  assert.ok(Math.log2(WORDLIST.length) * WORD_COUNT > 134, 'the phrase must exceed 134 bits');
});

test('the constants name the plan, and the domain prefix is bmk1:', () => {
  assert.equal(DOMAIN_PREFIX, 'bmk1:');
  assert.equal(PBKDF2_ITERATIONS, 210_000);
  assert.equal(KEY_BITS, 256);
  assert.equal(IV_BYTES, 12);
  assert.equal(ACCOUNT_ID_LENGTH, 22);
});

test('every derivation label carries the bmk1: prefix and no label repeats', () => {
  assert.deepEqual(Object.keys(LABELS).sort(), ['account', 'auth', 'key']);
  for (const [name, label] of Object.entries(LABELS)) {
    assert.ok(label.startsWith(DOMAIN_PREFIX), `${name} label "${label}" leaves the domain`);
  }
  assert.equal(new Set(Object.values(LABELS)).size, 3, 'each derivation gets its own label');
});

test('generatePhrase returns thirteen listed words, and two phrases differ', () => {
  const seen = new Set();
  for (let at = 0; at < 50; at += 1) {
    const phrase = generatePhrase();
    const words = phrase.split(' ');
    assert.equal(words.length, WORD_COUNT);
    assert.equal(phrase, words.join(' '), 'words are separated by one space');
    for (const word of words) assert.ok(WORDLIST.includes(word), `"${word}" is not listed`);
    seen.add(phrase);
  }
  assert.equal(seen.size, 50, 'fifty generated phrases must not collide');
});

test('normalizePhrase folds case, spacing and dashes, and refuses anything else', () => {
  const canonical = normalizePhrase(PHRASE_A);
  assert.equal(canonical, PHRASE_A.toLowerCase());

  const messy = `  ${PHRASE_A.toUpperCase().split(' ').join(' \t\n ')}  `;
  assert.equal(normalizePhrase(messy), canonical);

  const hyphenated = WORDLIST.indexOf('yo-yo');
  if (hyphenated !== -1) {
    const phrase = [...WORDLIST.slice(0, WORD_COUNT - 1), 'yo-yo'].join(' ');
    assert.equal(normalizePhrase(phrase.toUpperCase()), phrase);
  }

  assert.throws(() => normalizePhrase(''), /phrase/i);
  assert.throws(() => normalizePhrase(WORDLIST.slice(0, WORD_COUNT - 1).join(' ')), /words/i);
  assert.throws(() => normalizePhrase(`${PHRASE_A} notaword`), /words|word/i);
});

test('the same phrase derives the same account id and the same key', async () => {
  const accountId = await accountIdFromPhrase(PHRASE_A);
  assert.match(accountId, BASE64URL_22);
  assert.equal(await accountIdFromPhrase(`  ${PHRASE_A.toUpperCase()}  `), accountId);

  const document = { bookmarks: [{ url: 'https://example.com', clicks: 3 }] };
  const first = await deriveVaultKey(PHRASE_A);
  const sealed = await seal(first, document, accountId);

  /* A separate derivation, exactly as a reload or a second device performs it. */
  const second = await deriveVaultKey(PHRASE_A);
  assert.deepEqual(await open(second, sealed, accountId), document);
});

test('different phrases are different accounts, keys and auth secrets', async () => {
  const accountA = await accountIdFromPhrase(PHRASE_A);
  const accountB = await accountIdFromPhrase(PHRASE_B);
  assert.notEqual(accountA, accountB);

  const authA = await deriveAuthSecret(PHRASE_A);
  const authB = await deriveAuthSecret(PHRASE_B);
  assert.match(authA, BASE64URL_43);
  assert.notEqual(authA, authB);
  assert.notEqual(authA, accountA, 'the auth secret is not the account id');

  const keyA = await deriveVaultKey(PHRASE_A);
  const keyB = await deriveVaultKey(PHRASE_B);
  const sealed = await seal(keyA, { secret: true }, accountA);

  await assert.rejects(() => open(keyB, sealed, accountA), /sealed under this key/);
  await assert.rejects(() => open(keyA, sealed, accountB), /sealed under this key/);
});

test('a tampered or malformed blob is refused, never partially read', async () => {
  const accountId = await accountIdFromPhrase(PHRASE_A);
  const key = await deriveVaultKey(PHRASE_A);
  const sealed = await seal(key, { bookmarks: [] }, accountId);

  await assert.rejects(
    () => open(key, { iv: sealed.iv, ct: flipFirstCharacter(sealed.ct) }, accountId),
    /sealed under this key/
  );
  await assert.rejects(
    () => open(key, { iv: flipFirstCharacter(sealed.iv), ct: sealed.ct }, accountId),
    /sealed under this key/
  );
  await assert.rejects(() => open(key, { ct: sealed.ct }, accountId), /iv and a ct/);
  await assert.rejects(() => open(key, { iv: sealed.iv }, accountId), /iv and a ct/);
  await assert.rejects(() => open(key, null, accountId), /iv and a ct/);
});

test('a phrase problem names what to fix, not what the parser saw', async () => {
  /* Five words: the count is the whole story. */
  assert.match(phraseProblem('one two three four five'), /That is 5 words — the phrase is 13\./);

  /* Thirteen words with one that is not in the list: name it, do not say "normalisation failed". */
  const unknown = `${WORDLIST.slice(0, 12).join(' ')} notaword`;
  assert.match(phraseProblem(unknown), /“notaword” is not one of the words these phrases use/);

  /* A real phrase has nothing to report. */
  assert.equal(phraseProblem(WORDLIST.slice(0, 13).join(' ')), null);
  assert.equal(phraseProblem('  '), 'The phrase has 13 words.');
});

test('one derivation returns keys that cannot be exported, and the text the server is given', async () => {
  const { accountId, vaultKey, authKey, authSecret } = await deriveAccount(PHRASE_A);

  assert.equal(accountId, await accountIdFromPhrase(PHRASE_A));
  assert.equal(authSecret, await deriveAuthSecret(PHRASE_A), 'the account secret is unchanged');

  assert.ok(vaultKey instanceof CryptoKey);
  assert.equal(vaultKey.algorithm.name, 'AES-GCM');
  assert.equal(vaultKey.extractable, false);
  assert.ok(authKey instanceof CryptoKey);
  assert.equal(authKey.algorithm.name, 'HMAC');
  assert.equal(authKey.extractable, false);

  await assert.rejects(() => crypto.subtle.exportKey('raw', vaultKey), /not extractable/i);
  await assert.rejects(() => crypto.subtle.exportKey('raw', authKey), /not extractable/i);
  assert.equal('vaultKeyBytes' in (await deriveAccount(PHRASE_A)), false, 'no raw key is returned');
});

test('a proof from a stored key is the proof from the secret it was made from', async () => {
  const { vaultKey, authKey, authSecret } = await deriveAccount(PHRASE_A);
  const accountId = await accountIdFromPhrase(PHRASE_A);

  const fromText = await proveAuth(authSecret, accountId, 'nonce-one');
  assert.match(fromText, BASE64URL_43);

  /* The remembered record holds the key, so this is the path a reload takes. */
  assert.equal(await proveAuth(authKey, accountId, 'nonce-one'), fromText);
  assert.equal(await proveAuth(await authKeyFromBytes(authSecret), accountId, 'nonce-one'), fromText);
  assert.notEqual(await proveAuth(authKey, accountId, 'nonce-two'), fromText);
  assert.notEqual(await proveAuth(authKey, await accountIdFromPhrase(PHRASE_B), 'nonce-one'), fromText);

  await assert.rejects(() => proveAuth(vaultKey, accountId, 'nonce-one'), /HMAC/);
  await assert.rejects(() => proveAuth(authKey, accountId, ''), /nonce/);
});

test('remembered material is only ever a non-extractable key', async () => {
  const { vaultKey } = await deriveAccount(PHRASE_A);
  assert.equal(await keyFromBytes(vaultKey), vaultKey, 'a CryptoKey passes through');

  const raw = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
  const imported = await keyFromBytes(raw);
  assert.ok(imported instanceof CryptoKey);
  assert.equal(imported.extractable, false);
  await assert.rejects(() => crypto.subtle.exportKey('raw', imported), /not extractable/i);

  /* The refusals stay meaningful next to the acceptance above. */
  await assert.rejects(() => keyFromBytes(''), /base64url/);
  await assert.rejects(
    () => keyFromBytes(Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64url')),
    /256 bits/
  );
  await assert.rejects(() => keyFromBytes({}), /base64url/);
});

test('a blob sealed before padding existed still opens, and gains no pad key', async () => {
  const accountId = await accountIdFromPhrase(PHRASE_A);
  const key = await deriveVaultKey(PHRASE_A);
  const document = {
    bookmarks: [{ url: 'https://example.com', clicks: 4 }],
    prefs: { view: 'all', updatedAt: 1 }
  };

  const legacy = await sealUnpadded(key, document, accountId);

  /* The old blob has no envelope, so the length is the document's own and nothing is stripped. */
  assert.equal(
    ciphertextBytes(legacy),
    Buffer.byteLength(JSON.stringify(document)) + GCM_TAG_BYTES
  );
  assert.deepEqual(await open(key, legacy, accountId), document);
  assert.equal('pad' in (await open(key, legacy, accountId)), false, 'no padding leaks out');

  /* An old document that happens to own `doc` and `pad` keys is handed back whole, not unwrapped:
     only the marked envelope is one. */
  const lookalike = { doc: { url: 'https://example.com' }, pad: 'not padding at all' };
  const sealedLookalike = await sealUnpadded(key, lookalike, accountId);
  assert.deepEqual(await open(key, sealedLookalike, accountId), lookalike);
});

test('a new blob round-trips the document and hides the pad', async () => {
  const accountId = await accountIdFromPhrase(PHRASE_A);
  const key = await deriveVaultKey(PHRASE_A);
  const document = { bookmarks: [{ url: 'https://example.com', clicks: 2 }], prefs: { view: 'all' } };

  const sealed = await seal(key, document, accountId);
  assert.deepEqual(await open(key, sealed, accountId), document);
  assert.equal((ciphertextBytes(sealed) - GCM_TAG_BYTES) % PAD_BUCKET_BYTES, 0, 'a whole bucket');

  /* Same document, second derivation, exactly as another device opens it. */
  const other = await deriveVaultKey(PHRASE_A);
  assert.deepEqual(await open(other, sealed, accountId), document);
});

test('two documents of clearly different sizes seal into the same bucket', async () => {
  const accountId = await accountIdFromPhrase(PHRASE_A);
  const key = await deriveVaultKey(PHRASE_A);

  const small = { bookmarks: [{ url: 'https://a.example' }] };
  const large = {
    bookmarks: Array.from({ length: 8 }, (unused, at) => ({
      url: `https://b${at}.example`,
      name: 'x'.repeat(40)
    }))
  };

  const smallBytes = envelopeBytes(small);
  const largeBytes = envelopeBytes(large);
  assert.ok(largeBytes - smallBytes > 200, 'the two documents differ by more than 200 bytes');

  const sealedSmall = await seal(key, small, accountId);
  const sealedLarge = await seal(key, large, accountId);

  assert.equal(ciphertextBytes(sealedSmall), ciphertextBytes(sealedLarge));
  assert.equal((ciphertextBytes(sealedSmall) - GCM_TAG_BYTES) % PAD_BUCKET_BYTES, 0);
  assert.deepEqual(await open(key, sealedSmall, accountId), small);
  assert.deepEqual(await open(key, sealedLarge, accountId), large);
});

test('a document just over a bucket boundary moves to the next bucket', async () => {
  const accountId = await accountIdFromPhrase(PHRASE_A);
  const key = await deriveVaultKey(PHRASE_A);

  /* The note length that fills the first bucket exactly, then one character more. */
  const empty = { note: '' };
  const roomInBucket = PAD_BUCKET_BYTES - envelopeBytes(empty);
  assert.ok(roomInBucket > 0 && roomInBucket < PAD_BUCKET_BYTES, 'the first bucket has room');

  const atBoundary = { note: 'a'.repeat(roomInBucket) };
  const overBoundary = { note: 'a'.repeat(roomInBucket + 1) };
  assert.equal(envelopeBytes(atBoundary), PAD_BUCKET_BYTES);
  assert.equal(envelopeBytes(overBoundary), PAD_BUCKET_BYTES + 1);

  const sealedAt = await seal(key, atBoundary, accountId);
  const sealedOver = await seal(key, overBoundary, accountId);

  assert.equal(ciphertextBytes(sealedAt), PAD_BUCKET_BYTES + GCM_TAG_BYTES);
  assert.equal(ciphertextBytes(sealedOver), PAD_BUCKET_BYTES * 2 + GCM_TAG_BYTES);
  assert.deepEqual(await open(key, sealedAt, accountId), atBoundary);
  assert.deepEqual(await open(key, sealedOver, accountId), overBoundary);
});

/* ---------------------------------------------------- the version in the associated data */

test('a vault blob is sealed at its version and opens only at that version', async () => {
  const accountId = await accountIdFromPhrase(PHRASE_A);
  const key = await deriveVaultKey(PHRASE_A);
  const document = { bookmarks: [{ url: 'https://example.com', clicks: 1 }], prefs: { view: 'all' } };

  const sealed = await sealVault(key, document, accountId, 7);
  assert.equal(sealed.at, 7, 'the blob names the version it was sealed at');
  assert.deepEqual(await openVault(key, sealed, accountId, 7), document);

  /* The server reports another number for the same bytes: that is the replay this closes. The
     blob is marked, so it is not retried with the older associated data either. */
  await assert.rejects(
    () => openVault(key, sealed, accountId, 8, { allowLegacy: true }),
    /not sealed under this key/,
    'an older ciphertext must not open under a newer version'
  );
  await assert.rejects(() => openVault(key, sealed, accountId, 6), /not sealed under this key/);
});

test('the associated data names the version, and the account beside it', async () => {
  const accountId = await accountIdFromPhrase(PHRASE_A);
  const otherAccount = await accountIdFromPhrase(PHRASE_B);

  assert.equal(vaultAssociated(accountId, 1), `${VAULT_AD_VERSION}\n${accountId}\n1`);
  assert.notEqual(vaultAssociated(accountId, 1), vaultAssociated(accountId, 2), 'the version counts');
  assert.notEqual(vaultAssociated(accountId, 1), vaultAssociated(otherAccount, 1), 'the account counts');

  assert.throws(() => vaultAssociated(accountId, 0), /positive integer/);
  assert.throws(() => vaultAssociated(accountId, 1.5), /positive integer/);
  assert.throws(() => vaultAssociated('', 1), /names the account/);
});

test('a blob sealed before the version was bound still opens, once the caller allows it', async () => {
  const accountId = await accountIdFromPhrase(PHRASE_A);
  const key = await deriveVaultKey(PHRASE_A);
  const document = { bookmarks: [{ url: 'https://example.com', clicks: 3 }] };

  /* The shape every existing vault is in: the account id is the whole associated data. */
  const legacy = await seal(key, document, accountId);
  assert.equal('at' in legacy, false, 'the old shape carries no version');

  assert.deepEqual(await openVault(key, legacy, accountId, 4, { allowLegacy: true }), document);

  /* A device that has already written a bound blob refuses the old shape, so a pre-upgrade
     ciphertext cannot be served to it again later. */
  await assert.rejects(() => openVault(key, legacy, accountId, 5), /not sealed under this key/);
});
