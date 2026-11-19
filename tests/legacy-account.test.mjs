/**
 * An account that was created the old way — a 22-character id and an auth secret, no public key —
 * still signs in, still reads its vault, and can still be created.
 *
 * These tests are the guard on the phrase id's second job. The id is the input to the vault key's
 * salt and the associated data of every sealed blob, so it has to keep being exactly what it was.
 * The last test pins it to a literal, and the rest exercise a record written the shape the server
 * stored before phrase-derived keys existed.
 *
 * Storage is a Map with the Durable Object storage shape, as in vault-object.test.mjs, so the
 * object under test is the real one and the clock is still injectable.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import { Vault } from '../src/vault.js';
import {
  accountIdFromPhrase,
  deriveAccount,
  deriveVaultKey,
  sealVault,
  openVault
} from '../public/crypto.js';
import { WORDLIST } from '../public/wordlist.js';
import { quiet } from './logs.mjs';

/* The refusals these tests cause write event lines that events.test.mjs is about. */
quiet();

/* A fixed phrase from the wordlist, spelled out rather than sliced out of it, so a change to the
   list cannot quietly change what this file is testing. */
const PHRASE = 'acid acorn acre acts afar affix aged agent agile aging agony ahead aide';

/* The 22-character id this phrase derived when this file was written. It is pinned deliberately:
   a later change to the derivation must fail here instead of passing unnoticed. This id is the
   salt input of the vault key (`deriveMaster`) and the associated data of every sealed blob, so it
   must never move — a new id would make every vault written before the change unopenable. */
const LEGACY_ID = '-ujuZKcA605OXg27xAP6EA';

/* A different 22-character id, for showing that the id is the associated data and not decoration. */
const OTHER_ID = '-ujuZKcA605OXg27xAP6EB';

/* A second phrase, only for its credential material: a real HMAC secret that is the wrong one, and
   a real Ed25519 public key that commits to an id of its own. */
const STRANGER = await deriveAccount(WORDLIST.slice(13, 26).join(' '));

const account = await deriveAccount(PHRASE);

function storage() {
  const map = new Map();
  const alarms = [];
  return {
    async get(key) {
      return map.get(key);
    },
    async put(key, value) {
      map.set(key, structuredClone(value));
    },
    async delete(key) {
      return map.delete(key);
    },
    async list({ prefix = '' } = {}) {
      return new Map(
        [...map]
          .filter(([key]) => key.startsWith(prefix))
          .map(([key, value]) => [key, structuredClone(value)])
      );
    },
    async setAlarm(at) {
      alarms.push(at);
    },
    async deleteAll() {
      map.clear();
    },
    alarms,
    raw: map
  };
}

function object() {
  const ctx = {
    storage: storage(),
    id: { name: LEGACY_ID }
  };

  const env = {
    OWNER_ACCOUNT_ID: '',
    ADMIN_SECRET: 'test-admin-secret-0123456789abcdef',
    REGISTRY: {
      idFromName: (name) => ({ name }),
      get: () => ({
        fetch: async () =>
          new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          })
      })
    }
  };

  let clock = 1_000_000;
  const vault = new Vault(ctx, env, { now: () => clock });

  return {
    vault,
    env,
    storage: ctx.storage,
    advance(ms) {
      clock += ms;
    }
  };
}

function request(path, { method = 'POST', body, headers = {} } = {}) {
  return new Request(`https://vault${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

async function read(response) {
  return { status: response.status, body: await response.json() };
}

/**
 * The HMAC a client signs with an auth secret: over the account id, a newline, and the nonce,
 * keyed by the raw bytes of the secret and written as unpadded base64url.
 */
function prove(secret, accountId, nonce) {
  return createHmac('sha256', Buffer.from(secret, 'base64url'))
    .update(`${accountId}\n${nonce}`)
    .digest('base64url');
}

/** The record the server wrote before it stored a public key instead of a secret. */
function legacyRecord() {
  return {
    accountId: LEGACY_ID,
    authSecret: account.authSecret,
    plan: 'free',
    units: 0,
    via: 'direct',
    createdAt: 900_000,
    lastSeenAt: 900_000,
    paidUntil: null
  };
}

test('a record written with an auth secret and no proof key signs in, and a wrong proof does not', async () => {
  const harness = object();
  await harness.storage.put('account', legacyRecord());

  const challenge = await read(await harness.vault.fetch(request('/challenge')));
  assert.equal(challenge.status, 200);
  assert.equal(typeof challenge.body.nonce, 'string');
  assert.ok(challenge.body.nonce.length > 0);

  const proof = prove(account.authSecret, LEGACY_ID, challenge.body.nonce);
  assert.equal(proof.length, 43, 'an HMAC proof is 43 base64url characters');
  assert.match(proof, /^[A-Za-z0-9_-]{43}$/);

  const session = await read(await harness.vault.fetch(request('/login', { body: { proof } })));
  assert.equal(session.status, 200);
  assert.equal(typeof session.body.token, 'string');
  assert.match(session.body.token, /^[A-Za-z0-9_-]{43}$/, 'a session token comes back');

  const record = await harness.storage.get('account');
  assert.equal(record.authSecret, account.authSecret, 'the record is read, not rewritten');
  assert.equal('proofKey' in record, false, 'and no key was added to it');

  const before = (await harness.storage.list({ prefix: 'session:' })).size;
  assert.equal(before, 1, 'one session is stored');

  /* A proof signed by another secret, over a live nonce: a well-formed attempt that is not the
     phrase's, which must be refused and must not leave a session behind. */
  const second = await read(await harness.vault.fetch(request('/challenge')));
  assert.equal(second.status, 200);
  const wrong = prove(STRANGER.authSecret, LEGACY_ID, second.body.nonce);
  assert.notEqual(wrong, prove(account.authSecret, LEGACY_ID, second.body.nonce));

  const refused = await read(await harness.vault.fetch(request('/login', { body: { proof: wrong } })));
  assert.equal(refused.status, 401);
  assert.equal(refused.body.error, 'bad_proof');
  assert.equal(
    (await harness.storage.list({ prefix: 'session:' })).size,
    before,
    'a refused sign-in stores no session'
  );
});

test('a vault sealed for that record still opens with its phrase and its id', async () => {
  const harness = object();
  await harness.storage.put('account', legacyRecord());

  const document = {
    bookmarks: [{ url: 'https://example.com/', title: 'one bookmark' }],
    tags: ['example']
  };

  /* The phrase's real vault key, sealed under the id the record carries as its associated data. */
  const key = await deriveVaultKey(PHRASE);
  const sealed = await sealVault(key, document, LEGACY_ID, 1);
  assert.equal(typeof sealed.iv, 'string');
  assert.equal(typeof sealed.ct, 'string');

  await harness.storage.put('vault', { baseVersion: 0, ...sealed });
  const stored = await harness.storage.get('vault');
  assert.deepEqual(stored, { baseVersion: 0, ...sealed }, 'the blob is stored as it was sealed');

  const opened = await openVault(await deriveVaultKey(PHRASE), stored, LEGACY_ID, 1);
  assert.deepEqual(opened, document, 'the same phrase and the same id open it');

  /* The id is the associated data, not a label beside it: the same blob under another id refuses,
     which is also the proof that the id is still the salt input the key was derived against. */
  await assert.rejects(openVault(key, stored, OTHER_ID, 1));
});

test('a legacy-shaped id is still created through its auth secret, and stores no key', async () => {
  const harness = object();

  const blind = await read(
    await harness.vault.fetch(
      request('/account', { body: { accountId: LEGACY_ID, authSecret: account.authSecret } })
    )
  );
  assert.equal(blind.status, 428);
  assert.equal(blind.body.error, 'proof_required');
  assert.equal(typeof blind.body.nonce, 'string');
  assert.equal(await harness.storage.get('account'), undefined, 'nothing is written yet');

  const proof = prove(account.authSecret, LEGACY_ID, blind.body.nonce);
  const created = await read(
    await harness.vault.fetch(
      request('/account', {
        body: { accountId: LEGACY_ID, authSecret: account.authSecret, proof }
      })
    )
  );
  assert.equal(created.status, 201);
  assert.equal(created.body.created, true);

  const record = await harness.storage.get('account');
  assert.equal(record.accountId, LEGACY_ID);
  assert.equal(record.authSecret, account.authSecret, 'the secret is what the record keeps');
  assert.equal('proofKey' in record, false, 'and it keeps no key alongside it');

  /* The account it just created signs in, so the secret it stored is the one it will check. */
  const challenge = await read(await harness.vault.fetch(request('/challenge')));
  const signedIn = await read(
    await harness.vault.fetch(
      request('/login', {
        body: { proof: prove(account.authSecret, LEGACY_ID, challenge.body.nonce) }
      })
    )
  );
  assert.equal(signedIn.status, 200);
});

test('a legacy-shaped id cannot be created with a proof key', async () => {
  const harness = object();

  /* A real 32-byte Ed25519 public key, 43 base64url characters — the one credential shape that
     has to be refused here, because a 22-character id commits to nothing and anyone who knows it
     could otherwise attach their own key to it. */
  assert.equal(STRANGER.proofKeyText.length, 43);

  const response = await read(
    await harness.vault.fetch(
      request('/account', { body: { accountId: LEGACY_ID, proofKey: STRANGER.proofKeyText } })
    )
  );

  assert.ok(
    response.status === 400 || response.status === 401,
    `a proof key at a legacy id is refused with 400 or 401, not ${response.status}`
  );
  assert.equal(await harness.storage.get('account'), undefined, 'no account is written');
  assert.equal(await harness.storage.get('create-nonce'), undefined, 'no challenge was even minted');
});

test('the phrase id derivation still returns the pinned 22-character id', async () => {
  /* The phrase is a real wordlist phrase, so the pin below is not a string this file invented. */
  const words = PHRASE.split(' ');
  assert.equal(words.length, 13);
  for (const word of words) assert.ok(WORDLIST.includes(word), word);

  const id = await accountIdFromPhrase(PHRASE);

  /* Pinned on purpose: this value is the vault's salt input and its associated data, so a change
     to the derivation must break here rather than silently strand every vault written so far. */
  assert.equal(id, LEGACY_ID);
  assert.equal(id.length, 22);
  assert.equal(account.accountId, LEGACY_ID, 'and the id deriveAccount hands out is the same one');
});
