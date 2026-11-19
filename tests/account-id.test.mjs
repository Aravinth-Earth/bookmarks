/**
 * The account id commits to the public key.
 *
 * A creation used to be verified against the key the request itself carried, so someone who knew
 * only a public account id could derive a phrase of their own and install its key on that id. These
 * tests hold two phrases apart — a victim and a stranger — and check the three things that make the
 * binding real: the stranger's request for the victim's id is refused before anything is minted or
 * written, the victim's own id still creates and signs in, and the stranger is still free to create
 * the account their own key names. The last one is what says the refusal is about the binding and
 * not about the key.
 *
 * The proof is made with the page's own derivation and its own `proveAuth`, so these tests fail if
 * the client and the object ever disagree about what the id is made of. Storage is a Map with the
 * Durable Object storage shape, and the registry answers a reservation without keeping anything.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { Vault } from '../src/vault.js';
import { deriveAccount, proveAuth } from '../public/crypto.js';
import { WORDLIST } from '../public/wordlist.js';
import { quiet } from './logs.mjs';

/* These tests are about what the object answers and stores; its event lines have their own tests. */
quiet();

const VICTIM = await deriveAccount(WORDLIST.slice(0, 13).join(' '));
const STRANGER = await deriveAccount(WORDLIST.slice(13, 26).join(' '));

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
 * One account's object, reached the way the runtime reaches it: the name it was asked for is the
 * id being created, and the registry answers a reservation so the cap is never what refused a test.
 */
function objectNamed(name) {
  const ctx = { storage: storage(), id: { name } };
  const reserved = [];
  const env = {
    ADMIN_SECRET: '',
    REGISTRY: {
      idFromName: (label) => ({ label }),
      get: () => ({
        fetch: async (request) => {
          const body = await request.clone().json();
          if (new URL(request.url).pathname === '/reserve') reserved.push(body.accountId);
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          });
        }
      })
    }
  };
  const vault = new Vault(ctx, env, { now: () => 1_000_000 });
  return { vault, storage: ctx.storage, reserved };
}

function request(path, { body } = {}) {
  return new Request(`https://vault${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

async function read(response) {
  return { status: response.status, body: await response.json() };
}

test('a stranger who knows the id cannot install their own key against it', async () => {
  const harness = objectNamed(VICTIM.serverId);

  /* The two phrases really are unrelated, so this is the attack and not a coincidence. */
  assert.notEqual(STRANGER.proofKeyText, VICTIM.proofKeyText);
  assert.notEqual(STRANGER.serverId, VICTIM.serverId);

  const response = await read(
    await harness.vault.fetch(
      request('/account', {
        body: { accountId: VICTIM.serverId, proofKey: STRANGER.proofKeyText }
      })
    )
  );

  assert.ok(
    [400, 401, 409, 428].includes(response.status),
    `a claim like this is refused, not created: ${response.status}`
  );
  assert.equal(response.status, 400);
  assert.equal(response.body.error, 'account_mismatch');
  /* The refusal does not hand back the id the stranger's key would produce. */
  assert.equal(JSON.stringify(response.body).includes(STRANGER.serverId), false);

  assert.equal(await harness.storage.get('account'), undefined, 'nothing was stored');
  assert.equal(await harness.storage.get('create-nonce'), undefined, 'nothing was even minted');
  assert.deepEqual(harness.reserved, [], 'and no slot was taken');
});

test('the victim creates and signs in under the id their own key commits to', async () => {
  const harness = objectNamed(VICTIM.serverId);

  const challenge = await read(
    await harness.vault.fetch(
      request('/account', { body: { accountId: VICTIM.serverId, proofKey: VICTIM.proofKeyText } })
    )
  );
  assert.equal(challenge.status, 428);
  assert.equal(challenge.body.error, 'proof_required');
  assert.equal(typeof challenge.body.nonce, 'string');

  const proof = await proveAuth(VICTIM.proofKey, VICTIM.serverId, challenge.body.nonce);
  const created = await read(
    await harness.vault.fetch(
      request('/account', {
        body: { accountId: VICTIM.serverId, proofKey: VICTIM.proofKeyText, proof }
      })
    )
  );
  assert.equal(created.status, 201);
  assert.equal(created.body.created, true);
  assert.deepEqual(harness.reserved, [VICTIM.serverId], 'the slot is taken once');

  const record = await harness.storage.get('account');
  assert.equal(record.accountId, VICTIM.serverId);
  assert.equal(record.proofKey, VICTIM.proofKeyText, 'the record holds the victim’s own key');
  assert.equal('authSecret' in record, false, 'and no secret beside it');

  const signIn = await read(await harness.vault.fetch(request('/challenge')));
  assert.equal(signIn.status, 200);
  const signature = await proveAuth(VICTIM.proofKey, VICTIM.serverId, signIn.body.nonce);
  const session = await read(
    await harness.vault.fetch(request('/login', { body: { proof: signature } }))
  );
  assert.equal(session.status, 200);
  assert.equal(typeof session.body.token, 'string');
  assert.notEqual(session.body.token, '');
});

test('the same stranger creates the account their own key names', async () => {
  const harness = objectNamed(STRANGER.serverId);

  const challenge = await read(
    await harness.vault.fetch(
      request('/account', { body: { accountId: STRANGER.serverId, proofKey: STRANGER.proofKeyText } })
    )
  );
  assert.equal(challenge.status, 428);

  const proof = await proveAuth(STRANGER.proofKey, STRANGER.serverId, challenge.body.nonce);
  const created = await read(
    await harness.vault.fetch(
      request('/account', {
        body: { accountId: STRANGER.serverId, proofKey: STRANGER.proofKeyText, proof }
      })
    )
  );
  assert.equal(created.status, 201, 'the key is not what was refused, the id it was claimed with was');
  assert.equal((await harness.storage.get('account')).proofKey, STRANGER.proofKeyText);
});
