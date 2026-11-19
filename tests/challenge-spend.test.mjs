/**
 * What is allowed to spend a challenge.
 *
 * A challenge is spent by the proof presented for it. It is not spent by any string that happens
 * to arrive while it is live: a one-character proof matches the alphabet the routes used to test
 * for and nothing else, and spending a sign-in on it let any caller cancel one that was already in
 * progress. These tests hold a live challenge, post shapes that could never be the real proof, and
 * check that the challenge is still there afterwards — by value, and by using it. The other half is
 * the rule that has to survive: a proof of the right shape that is simply wrong still spends it, so
 * a captured proof cannot be replayed and a guess cannot be retried.
 *
 * Storage is a Map with the Durable Object storage shape, and a different source is the
 * `x-vault-source` header the Worker fills from a digest of the caller's address.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { MAX_FAILURES, Vault } from '../src/vault.js';
import { deriveAccount, proveAuth } from '../public/crypto.js';
import { WORDLIST } from '../public/wordlist.js';
import { quiet } from './logs.mjs';

/* These tests are about what the object answers and stores; its event lines have their own tests. */
quiet();

/* One phrase whose account is created the old way, with a secret, and one whose account is created
   from its public key under the id that key commits to. Both kinds have to obey the same rule. */
const SECRET = await deriveAccount(WORDLIST.slice(0, 13).join(' '));
const KEYED = await deriveAccount(WORDLIST.slice(13, 26).join(' '));
const STRANGER = await deriveAccount(WORDLIST.slice(26, 39).join(' '));

/** A source header: the Worker sends a digest of the caller's address, never the address. */
function source(index) {
  return index.toString(16).padStart(64, '0');
}

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

/**
 * One account's object, named the way the runtime names it. The registry answers every ask, so the
 * cap is never what a test is measuring.
 */
function objectNamed(name) {
  const ctx = { storage: storage(), id: { name } };
  const env = {
    ADMIN_SECRET: '',
    REGISTRY: {
      idFromName: (label) => ({ label }),
      get: () => ({
        fetch: async () =>
          new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          })
      })
    }
  };
  const vault = new Vault(ctx, env, { now: () => 1_000_000 });
  return { vault, storage: ctx.storage };
}

function request(path, { body, headers = {} } = {}) {
  return new Request(`https://vault${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

async function read(response) {
  return { status: response.status, body: await response.json() };
}

/** A secret-shaped proof that is the right length and the wrong value. */
function wrongSecretProof() {
  return 'a'.repeat(43);
}

/** An account created the old way, so its proofs are HMACs of 32 bytes. */
async function secretAccount() {
  const harness = objectNamed(SECRET.accountId);
  const challenge = await read(
    await harness.vault.fetch(
      request('/account', { body: { accountId: SECRET.accountId, authSecret: SECRET.authSecret } })
    )
  );
  assert.equal(challenge.status, 428);
  const proof = await proveAuth(SECRET.authSecret, SECRET.accountId, challenge.body.nonce);
  const created = await read(
    await harness.vault.fetch(
      request('/account', {
        body: { accountId: SECRET.accountId, authSecret: SECRET.authSecret, proof }
      })
    )
  );
  assert.equal(created.status, 201);
  return harness;
}

/** An account created from a public key, under the id that key hashes to. */
async function keyedAccount() {
  const harness = objectNamed(KEYED.serverId);
  const challenge = await read(
    await harness.vault.fetch(
      request('/account', { body: { accountId: KEYED.serverId, proofKey: KEYED.proofKeyText } })
    )
  );
  assert.equal(challenge.status, 428);
  const proof = await proveAuth(KEYED.proofKey, KEYED.serverId, challenge.body.nonce);
  const created = await read(
    await harness.vault.fetch(
      request('/account', {
        body: { accountId: KEYED.serverId, proofKey: KEYED.proofKeyText, proof }
      })
    )
  );
  assert.equal(created.status, 201);
  return harness;
}

/** A live sign-in challenge, and the copy of it the storage holds. */
async function liveChallenge(harness) {
  const challenge = await read(await harness.vault.fetch(request('/challenge')));
  assert.equal(challenge.status, 200);
  const stored = structuredClone(harness.storage.raw.get('nonce'));
  assert.equal(stored.value, challenge.body.nonce, 'the live challenge is the stored one');
  return { nonce: challenge.body.nonce, stored };
}

test('a one-character proof from another source leaves the sign-in challenge standing', async () => {
  const harness = await secretAccount();
  const { nonce, stored } = await liveChallenge(harness);

  const refusal = await read(
    await harness.vault.fetch(
      request('/login', {
        body: { proof: 'a' },
        headers: { 'x-vault-source': source(1) }
      })
    )
  );

  assert.equal(refusal.status, 401);
  assert.equal(refusal.body.error, 'bad_proof');
  assert.deepEqual(harness.storage.raw.get('nonce'), stored, 'the challenge is untouched');

  const proof = await proveAuth(SECRET.authSecret, SECRET.accountId, nonce);
  const signedIn = await read(await harness.vault.fetch(request('/login', { body: { proof } })));
  assert.equal(signedIn.status, 200);
  assert.equal(typeof signedIn.body.token, 'string');
});

test('a proof of the other kind of length does not spend a keyed account’s challenge', async () => {
  const harness = await keyedAccount();
  const { nonce, stored } = await liveChallenge(harness);

  /* 43 characters is a whole HMAC and half a signature: a plausible proof for a secret, and never
     one for a public key. */
  const refusal = await read(
    await harness.vault.fetch(
      request('/login', {
        body: { proof: wrongSecretProof() },
        headers: { 'x-vault-source': source(2) }
      })
    )
  );

  assert.equal(refusal.status, 401);
  assert.equal(refusal.body.error, 'bad_proof');
  assert.deepEqual(harness.storage.raw.get('nonce'), stored);

  const proof = await proveAuth(KEYED.proofKey, KEYED.serverId, nonce);
  const signedIn = await read(await harness.vault.fetch(request('/login', { body: { proof } })));
  assert.equal(signedIn.status, 200);
});

test('a proof of the right shape that is wrong still spends the challenge', async () => {
  const harness = await secretAccount();
  const { nonce } = await liveChallenge(harness);

  const refusal = await read(
    await harness.vault.fetch(
      request('/login', {
        body: { proof: wrongSecretProof() },
        headers: { 'x-vault-source': source(3) }
      })
    )
  );

  assert.equal(refusal.status, 401);
  assert.equal(refusal.body.error, 'bad_proof');
  assert.equal(await harness.storage.get('nonce'), undefined, 'one nonce, one attempt');

  /* The proof the person had already signed cannot land now: that is the point of single use. */
  const proof = await proveAuth(SECRET.authSecret, SECRET.accountId, nonce);
  const late = await read(await harness.vault.fetch(request('/login', { body: { proof } })));
  assert.equal(late.status, 401);
  assert.equal(late.body.error, 'challenge_expired');
});

test('a junk proof and a wrong proof are answered identically', async () => {
  const harness = await secretAccount();

  await liveChallenge(harness);
  const junk = await read(
    await harness.vault.fetch(request('/login', { body: { proof: 'a' }, headers: { 'x-vault-source': source(4) } }))
  );

  /* A fresh challenge, because the wrong proof below is going to spend the live one. */
  await liveChallenge(harness);
  const wrong = await read(
    await harness.vault.fetch(
      request('/login', { body: { proof: wrongSecretProof() }, headers: { 'x-vault-source': source(4) } })
    )
  );

  assert.deepEqual(junk, wrong, 'nothing about the record’s credential is learned from the answer');
});

test('a string that could never be the proof does not count toward the source lock', async () => {
  const harness = await secretAccount();
  const { nonce } = await liveChallenge(harness);

  /* More than the lock takes, all from the same source, none of them an attempt at this nonce. A
     count that included them would let anyone lock a person out without ever guessing. */
  for (let at = 0; at <= MAX_FAILURES; at += 1) {
    const refusal = await read(
      await harness.vault.fetch(
        request('/login', { body: { proof: 'a' }, headers: { 'x-vault-source': source(0) } })
      )
    );
    assert.equal(refusal.status, 401);
  }

  const proof = await proveAuth(SECRET.authSecret, SECRET.accountId, nonce);
  const signedIn = await read(
    await harness.vault.fetch(
      request('/login', { body: { proof }, headers: { 'x-vault-source': source(0) } })
    )
  );
  assert.equal(signedIn.status, 200);
});

test('a junk proof does not spend the challenge a deletion was about to prove', async () => {
  const harness = await secretAccount();

  const challenge = await read(await harness.vault.fetch(request('/challenge')));
  const proof = await proveAuth(SECRET.authSecret, SECRET.accountId, challenge.body.nonce);
  const session = await read(await harness.vault.fetch(request('/login', { body: { proof } })));
  assert.equal(session.status, 200);
  const token = session.body.token;

  /* A fresh challenge for the deletion itself. */
  const deletion = await read(await harness.vault.fetch(request('/challenge')));
  const stored = structuredClone(harness.storage.raw.get('nonce'));

  const junk = await read(
    await harness.vault.fetch(
      request('/delete', {
        body: { proof: 'a' },
        headers: { authorization: `Bearer ${token}`, 'x-vault-source': source(5) }
      })
    )
  );
  assert.equal(junk.status, 401);
  assert.equal(junk.body.error, 'bad_proof');
  assert.deepEqual(harness.storage.raw.get('nonce'), stored, 'the challenge is untouched');

  const signed = await proveAuth(SECRET.authSecret, SECRET.accountId, deletion.body.nonce);
  const deleted = await read(
    await harness.vault.fetch(
      request('/delete', {
        body: { proof: signed },
        headers: { authorization: `Bearer ${token}`, 'x-vault-source': source(5) }
      })
    )
  );
  assert.equal(deleted.status, 200);
  assert.equal(await harness.storage.get('account'), undefined);
});

test('a junk proof does not spend a live creation challenge', async () => {
  const harness = objectNamed(KEYED.serverId);

  const challenge = await read(
    await harness.vault.fetch(
      request('/account', { body: { accountId: KEYED.serverId, proofKey: KEYED.proofKeyText } })
    )
  );
  assert.equal(challenge.status, 428);
  const stored = structuredClone(harness.storage.raw.get('create-nonce'));

  /* Every shape that cannot be a 64-byte signature: one character, a whole HMAC, a length no
     base64url string can have, and one that is not base64url at all. */
  for (const proof of ['a', wrongSecretProof(), 'A'.repeat(85), 'not a proof!']) {
    const refusal = await read(
      await harness.vault.fetch(
        request('/account', {
          body: { accountId: KEYED.serverId, proofKey: KEYED.proofKeyText, proof },
          headers: { 'x-vault-source': source(6) }
        })
      )
    );
    assert.equal(refusal.status, 401, proof);
    assert.equal(refusal.body.error, 'bad_proof');
    assert.deepEqual(harness.storage.raw.get('create-nonce'), stored, `untouched by ${proof}`);
  }

  const signed = await proveAuth(KEYED.proofKey, KEYED.serverId, challenge.body.nonce);
  const created = await read(
    await harness.vault.fetch(
      request('/account', {
        body: { accountId: KEYED.serverId, proofKey: KEYED.proofKeyText, proof: signed }
      })
    )
  );
  assert.equal(created.status, 201);
});

test('a wrong signature of the right length still spends the creation challenge', async () => {
  const harness = objectNamed(KEYED.serverId);

  const challenge = await read(
    await harness.vault.fetch(
      request('/account', { body: { accountId: KEYED.serverId, proofKey: KEYED.proofKeyText } })
    )
  );
  assert.equal(challenge.status, 428);

  /* A real 86-character signature, made by a key that is not this account's. */
  const wrong = await proveAuth(STRANGER.proofKey, KEYED.serverId, challenge.body.nonce);
  const refusal = await read(
    await harness.vault.fetch(
      request('/account', {
        body: { accountId: KEYED.serverId, proofKey: KEYED.proofKeyText, proof: wrong },
        headers: { 'x-vault-source': source(7) }
      })
    )
  );
  assert.equal(refusal.status, 401);
  assert.equal(await harness.storage.get('create-nonce'), undefined, 'the challenge was spent');

  /* So the owner's proof over that nonce no longer creates anything; a fresh one is offered. */
  const signed = await proveAuth(KEYED.proofKey, KEYED.serverId, challenge.body.nonce);
  const late = await read(
    await harness.vault.fetch(
      request('/account', {
        body: { accountId: KEYED.serverId, proofKey: KEYED.proofKeyText, proof: signed }
      })
    )
  );
  assert.equal(late.status, 428);
  assert.notEqual(late.body.nonce, challenge.body.nonce);
});
