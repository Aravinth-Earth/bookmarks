/**
 * The account object: provisioning, challenge-response, sessions and the sealed vault.
 *
 * The proof is generated with the browser's own `proveAuth`, from the browser's own derivation,
 * so these tests fail if the two halves ever disagree — which is the failure a sync bug would
 * actually be. Storage is a Map with the Durable Object storage shape, and the clock is
 * injectable, so expiry and lockout are tested without waiting.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ACCOUNT_FREE_FAILURES,
  ACCOUNT_RETRY_MAX_MS,
  FREE_MAX_CT_CHARS,
  LOCKOUT_MS,
  MAX_FAILURES,
  MAX_TRACKED_SOURCES,
  MAX_VAULT_BODY,
  OWNER_UNITS,
  SESSION_TTL_MS,
  UNIT_CT_CHARS,
  UNUSED_RELEASE_MS,
  Vault
} from '../src/vault.js';
import { Registry } from '../src/registry.js';
import { deriveAccount, proveAuth } from '../public/crypto.js';
import { WORDLIST } from '../public/wordlist.js';
import { quiet, withEvents } from './logs.mjs';

/* These tests are about what the object answers and stores; the lines its refusals write are
   tested in events.test.mjs. */
quiet();

const PHRASE = WORDLIST.slice(0, 13).join(' ');
const ACCOUNT = await deriveAccount(PHRASE);

const IV = 'abcdefghijklmnop';
const CT = 'abcdefghijklmnopqrstuvwxyz';

function storage({ failPut } = {}) {
  const map = new Map();
  /* The runtime holds one alarm at a time, so this is the alarm this object has now, not a log of
     every time one was set. */
  const alarms = [];
  return {
    async get(key) {
      return map.get(key);
    },
    async put(key, value) {
      /* A key the test names fails once, so a write that cannot land is exercised without a
         storage that is broken for the account it was meant to protect. */
      if (failPut?.(key)) throw new Error('the storage write failed');
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
      alarms.splice(0, alarms.length, at);
    },
    async deleteAlarm() {
      alarms.splice(0, alarms.length);
    },
    async deleteAll() {
      map.clear();
    },
    alarms,
    raw: map
  };
}

function object(overrides = {}) {
  const ctx = {
    storage: overrides.storage ?? storage(),
    id: { name: overrides.name ?? ACCOUNT.accountId }
  };

  const reserved = [];
  const released = [];
  let full = overrides.registryFull ?? false;
  /* A Registry that is unavailable answers nothing: the path says whether this request is the one
     that fails, so a test can let it recover. */
  const registryFails = overrides.registryFails ?? (() => false);

  const env = {
    OWNER_ACCOUNT_ID: overrides.ownerId ?? '',
    ADMIN_SECRET: overrides.adminSecret ?? 'test-admin-secret-0123456789abcdef',
    ...(overrides.invitesRequired ? { INVITES_REQUIRED: 'true' } : {}),
    REGISTRY: overrides.registry ?? {
      idFromName: (name) => ({ name }),
      get: (id) => ({
        fetch: async (request) => {
          const path = new URL(request.url).pathname;
          if (registryFails(path)) throw new Error('the Registry is unavailable');
          const body = await request.clone().json();
          const headers = { 'content-type': 'application/json' };

          if (path === '/release') {
            released.push(body.accountId);
            return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
          }

          reserved.push(body.accountId);
          return new Response(JSON.stringify(full ? { error: 'full' } : { ok: true }), {
            status: full ? 429 : 200,
            headers
          });
        }
      })
    }
  };

  let clock = overrides.start ?? 1_000_000;
  const vault = new Vault(ctx, env, { now: () => (overrides.now ? overrides.now() : clock) });

  return {
    vault,
    ctx,
    env,
    storage: ctx.storage,
    reserved,
    released,
    setFull(value) {
      full = value;
    },
    advance(ms) {
      clock += ms;
    },
    at(moment) {
      clock = moment;
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

function adminRequest(path, body, secret = 'test-admin-secret-0123456789abcdef') {
  return request(path, {
    method: 'POST',
    body,
    headers: { 'x-admin-secret': secret }
  });
}

async function blind(harness, authSecret = ACCOUNT.authSecret) {
  return read(
    await harness.vault.fetch(
      request('/account', { body: { accountId: ACCOUNT.accountId, authSecret } })
    )
  );
}

/** The full creation flow: ask for a nonce, sign it with the secret, and write the account. */
async function provision(harness, authSecret = ACCOUNT.authSecret, invite) {
  const challenge = await blind(harness, authSecret);
  if (challenge.status !== 428) return challenge;

  const proof = await proveAuth(authSecret, ACCOUNT.accountId, challenge.body.nonce);
  return read(
    await harness.vault.fetch(
      request('/account', {
        body: { accountId: ACCOUNT.accountId, authSecret, proof, ...(invite === undefined ? {} : { invite }) }
      })
    )
  );
}

/** The same flow with the phrase's public proof key, under the id that key commits to. */
async function blindWithKey(harness, proofKey = ACCOUNT.proofKeyText) {
  return read(
    await harness.vault.fetch(
      request('/account', { body: { accountId: ACCOUNT.serverId, proofKey } })
    )
  );
}

async function provisionWithKey(harness) {
  const challenge = await blindWithKey(harness);
  if (challenge.status !== 428) return challenge;

  const proof = await proveAuth(ACCOUNT.proofKey, ACCOUNT.serverId, challenge.body.nonce);
  return read(
    await harness.vault.fetch(
      request('/account', {
        body: { accountId: ACCOUNT.serverId, proofKey: ACCOUNT.proofKeyText, proof }
      })
    )
  );
}

async function loginWithKey(harness, client) {
  const challenge = await read(await harness.vault.fetch(request('/challenge')));
  assert.equal(challenge.status, 200);
  const proof = await proveAuth(ACCOUNT.proofKey, ACCOUNT.serverId, challenge.body.nonce);
  return read(await harness.vault.fetch(request('/login', { body: { proof, client } })));
}

async function login(harness) {
  const challenge = await read(await harness.vault.fetch(request('/challenge')));
  assert.equal(challenge.status, 200);
  const proof = await proveAuth(ACCOUNT.authSecret, ACCOUNT.accountId, challenge.body.nonce);
  return read(await harness.vault.fetch(request('/login', { body: { proof } })));
}

test('a blind creation request writes nothing and answers with a nonce', async () => {
  const harness = object();

  const response = await blind(harness);

  assert.equal(response.status, 428);
  assert.equal(response.body.error, 'proof_required');
  assert.match(response.body.nonce, /^[A-Za-z0-9_-]{22}$/);
  assert.equal(typeof response.body.expiresAt, 'number');
  assert.equal(harness.storage.raw.has('account'), false, 'nothing is written yet');
  assert.deepEqual(harness.reserved, [], 'a blind request takes no slot');
});

test('a second blind creation request answers the live nonce and writes nothing', async () => {
  const harness = object();

  const first = await blind(harness);
  const stored = structuredClone(harness.storage.raw.get('create-nonce'));

  const second = await blind(harness);

  assert.equal(second.status, 428);
  assert.equal(second.body.error, 'proof_required');
  assert.equal(second.body.nonce, first.body.nonce, 'the live nonce is handed back');
  assert.equal(second.body.expiresAt, first.body.expiresAt, 'and so is its own deadline');
  assert.deepEqual(harness.storage.raw.get('create-nonce'), stored, 'asking again writes nothing');
});

test('a blind creation request cannot displace the challenge a proof is about to sign', async () => {
  const harness = object();

  /* The person takes a challenge; someone else, holding only the id, posts the same route. */
  const owner = await blind(harness);
  const stranger = await blind(harness);

  assert.equal(stranger.body.nonce, owner.body.nonce, 'one challenge, whoever asks');

  /* The proof the person signed over the nonce they were given still creates the account. */
  const proof = await proveAuth(ACCOUNT.authSecret, ACCOUNT.accountId, owner.body.nonce);
  const created = await read(
    await harness.vault.fetch(
      request('/account', {
        body: { accountId: ACCOUNT.accountId, authSecret: ACCOUNT.authSecret, proof }
      })
    )
  );

  assert.equal(created.status, 201);
  assert.equal(created.body.created, true);
});

test('a blind creation request does not extend the nonce it finds, and a stale one is replaced', async () => {
  const harness = object();

  const first = await blind(harness);

  /* Half a minute later the same nonce, still on its original deadline: asking is not a refresh. */
  harness.advance(30_000);
  const again = await blind(harness);
  assert.equal(again.body.nonce, first.body.nonce);
  assert.equal(again.body.expiresAt, first.body.expiresAt);

  /* Past the deadline the nonce is spent by time, so a fresh one is minted with a later stamp. */
  harness.advance(30_000);
  const fresh = await blind(harness);
  assert.notEqual(fresh.body.nonce, first.body.nonce);
  assert.ok(fresh.body.expiresAt > first.body.expiresAt);
});

test('a valid proof creates the account exactly once', async () => {
  const harness = object();

  const first = await provision(harness);
  assert.equal(first.status, 201);
  assert.equal(first.body.created, true);
  assert.equal((await harness.storage.get('account')).authSecret, ACCOUNT.authSecret);

  const second = await provision(harness);
  assert.equal(second.status, 200);
  assert.equal(second.body.created, false);
  assert.deepEqual(harness.reserved, [ACCOUNT.accountId], 'a retried creation takes one slot');

  for (const body of [
    {},
    { accountId: 'short', authSecret: ACCOUNT.authSecret },
    { accountId: ACCOUNT.accountId, authSecret: 'short' },
    { accountId: ACCOUNT.accountId, authSecret: 'x'.repeat(42) },
    { accountId: ACCOUNT.accountId, authSecret: `${'x'.repeat(42)}!` }
  ]) {
    const response = await read(await harness.vault.fetch(request('/account', { body })));
    assert.equal(response.status, 400, JSON.stringify(body));
  }
});

test('a proof signed with a different secret is refused and writes nothing', async () => {
  const harness = object();
  const other = await deriveAccount(WORDLIST.slice(13, 26).join(' '));

  const challenge = await blind(harness);
  assert.equal(challenge.status, 428);

  const proof = await proveAuth(other.authSecret, ACCOUNT.accountId, challenge.body.nonce);
  const response = await read(
    await harness.vault.fetch(
      request('/account', {
        body: { accountId: ACCOUNT.accountId, authSecret: ACCOUNT.authSecret, proof }
      })
    )
  );

  assert.equal(response.status, 401);
  assert.equal(response.body.error, 'bad_proof');
  assert.equal(harness.storage.raw.has('account'), false);
  assert.deepEqual(harness.reserved, []);
});

test('a nonce is single use, and a spent one earns a fresh challenge', async () => {
  const harness = object();
  const challenge = await blind(harness);
  const proof = await proveAuth(ACCOUNT.authSecret, ACCOUNT.accountId, challenge.body.nonce);

  const created = await read(
    await harness.vault.fetch(
      request('/account', { body: { accountId: ACCOUNT.accountId, authSecret: ACCOUNT.authSecret, proof } })
    )
  );
  assert.equal(created.status, 201);

  /* The same proof cannot be presented again: the nonce is gone, so a new challenge comes back. */
  const replay = await read(
    await harness.vault.fetch(
      request('/account', { body: { accountId: ACCOUNT.accountId, authSecret: ACCOUNT.authSecret, proof } })
    )
  );
  assert.equal(replay.status, 428);
  assert.equal(replay.body.error, 'proof_required');
  assert.notEqual(replay.body.nonce, challenge.body.nonce);
});

test('an existing account cannot be re-claimed with a different secret', async () => {
  const harness = object();
  await provision(harness);

  const other = await deriveAccount(WORDLIST.slice(13, 26).join(' '));
  const response = await provision(harness, other.authSecret);

  assert.equal(response.status, 401);
  assert.equal(response.body.error, 'bad_proof');
  assert.equal(
    (await harness.storage.get('account')).authSecret,
    ACCOUNT.authSecret,
    'the stored secret is untouched'
  );
  assert.equal((await login(harness)).status, 200, 'the real phrase still signs in');
});

/* ------------------------------------------------- the phrase-derived proof key */

test('a creation that presents a proof key stores the public key and no secret', async () => {
  const harness = object({ name: ACCOUNT.serverId });

  const created = await provisionWithKey(harness);
  assert.equal(created.status, 201);
  assert.equal(created.body.created, true);
  assert.deepEqual(harness.reserved, [ACCOUNT.serverId], 'the slot is taken once');

  const record = await harness.storage.get('account');
  assert.equal('authSecret' in record, false, 'the object holds no credential that can sign in');
  assert.equal(record.proofKey, ACCOUNT.proofKeyText);
  assert.equal(record.accountId, ACCOUNT.serverId);
  assert.equal(record.plan, 'free');
  assert.equal(record.units, 0);

  /* The same account signs in with the private half, which never left this side. */
  const session = await loginWithKey(harness, 'desktop');
  assert.equal(session.status, 200);
  assert.match(session.body.token, /^[A-Za-z0-9_-]{43}$/);

  /* And deletes behind that session and a fresh signature. */
  const challenge = await read(await harness.vault.fetch(request('/challenge')));
  const proof = await proveAuth(ACCOUNT.proofKey, ACCOUNT.serverId, challenge.body.nonce);
  const deleted = await read(
    await harness.vault.fetch(
      request('/delete', { body: { proof }, headers: withToken(session.body.token) })
    )
  );
  assert.equal(deleted.status, 200);
  assert.deepEqual([...harness.storage.raw.keys()], ['deleted'], 'only the tombstone remains');
});

test('a proof-key creation with a secret proof, or another phrase key, is refused and writes nothing', async () => {
  const harness = object({ name: ACCOUNT.serverId });
  const other = await deriveAccount(WORDLIST.slice(13, 26).join(' '));

  /* A body that asks for the public-key shape but signs the old way. */
  const first = await blindWithKey(harness);
  assert.equal(first.status, 428);
  const hmac = await proveAuth(ACCOUNT.authSecret, ACCOUNT.serverId, first.body.nonce);
  const asSecret = await read(
    await harness.vault.fetch(
      request('/account', {
        body: {
          accountId: ACCOUNT.serverId,
          authSecret: ACCOUNT.authSecret,
          proofKey: ACCOUNT.proofKeyText,
          proof: hmac
        }
      })
    )
  );
  assert.equal(asSecret.status, 401);
  assert.equal(asSecret.body.error, 'bad_proof');
  assert.equal(harness.storage.raw.has('account'), false);
  assert.deepEqual(harness.reserved, []);

  /* A valid signature, made by the wrong phrase's key. */
  const second = await blindWithKey(harness);
  assert.equal(second.status, 428);
  const foreign = await proveAuth(other.proofKey, ACCOUNT.serverId, second.body.nonce);
  const asOther = await read(
    await harness.vault.fetch(
      request('/account', {
        body: { accountId: ACCOUNT.serverId, proofKey: ACCOUNT.proofKeyText, proof: foreign }
      })
    )
  );
  assert.equal(asOther.status, 401);
  assert.equal(asOther.body.error, 'bad_proof');
  assert.equal(harness.storage.raw.has('account'), false);
  assert.deepEqual(harness.reserved, []);
});

test('a malformed proof key is an invalid creation, never a fallback to the secret', async () => {
  const harness = object({ name: ACCOUNT.serverId });

  /* A secret is present and well formed, so only the key can be what is refused. */
  for (const proofKey of ['x'.repeat(42), '', 'not a key at all', `${'A'.repeat(43)}!`, 42, null]) {
    const response = await read(
      await harness.vault.fetch(
        request('/account', {
          body: { accountId: ACCOUNT.serverId, authSecret: ACCOUNT.authSecret, proofKey }
        })
      )
    );
    assert.equal(response.status, 400, JSON.stringify(proofKey));
    assert.equal(response.body.error, 'invalid');
  }

  assert.equal(harness.storage.raw.has('create-nonce'), false, 'nothing was even minted');
  assert.equal(harness.storage.raw.has('account'), false);
});

test('a proof-key account cannot be re-claimed with a different secret or a different key', async () => {
  const harness = object({ name: ACCOUNT.serverId });
  assert.equal((await provisionWithKey(harness)).status, 201);

  const other = await deriveAccount(WORDLIST.slice(13, 26).join(' '));

  /* A different secret, presented against an id that commits to a key: the secret is the
     credential of the id the phrase itself hashed to, so there is nothing here for it to create. */
  const withSecret = await read(
    await harness.vault.fetch(
      request('/account', { body: { accountId: ACCOUNT.serverId, authSecret: other.authSecret } })
    )
  );
  assert.equal(withSecret.status, 400);
  assert.equal(withSecret.body.error, 'invalid');

  /* A different public key, signed by its own private half: a real signature for the wrong
     account. The id it is claimed with is the one the stored key commits to, so the claim ends
     before a nonce exists for it to sign — which is the whole of the difference this binding makes. */
  const withKey = await read(
    await harness.vault.fetch(
      request('/account', { body: { accountId: ACCOUNT.serverId, proofKey: other.proofKeyText } })
    )
  );
  assert.equal(withKey.status, 400);
  assert.equal(withKey.body.error, 'account_mismatch');

  const record = await harness.storage.get('account');
  assert.equal(record.proofKey, ACCOUNT.proofKeyText, 'the stored key is untouched');
  assert.equal('authSecret' in record, false, 'no secret was installed');
  assert.equal(await harness.storage.get('create-nonce'), undefined, 'and no nonce was minted');
  assert.equal((await loginWithKey(harness)).status, 200, 'the real phrase still signs in');
});

test('a record written before phrase-derived keys still signs in and deletes with its secret', async () => {
  const harness = object();

  /* The shape `createAccount` wrote before this change, written straight into storage. */
  await harness.storage.put('account', {
    accountId: ACCOUNT.accountId,
    authSecret: ACCOUNT.authSecret,
    plan: 'free',
    units: 0,
    via: 'direct',
    createdAt: 900_000,
    lastSeenAt: 900_000,
    paidUntil: null
  });

  const session = await login(harness);
  assert.equal(session.status, 200);
  assert.equal(
    (await harness.storage.get('account')).authSecret,
    ACCOUNT.authSecret,
    'the legacy record is read, not rewritten'
  );

  const challenge = await read(await harness.vault.fetch(request('/challenge')));
  const proof = await proveAuth(ACCOUNT.authSecret, ACCOUNT.accountId, challenge.body.nonce);
  const deleted = await read(
    await harness.vault.fetch(
      request('/delete', { body: { proof }, headers: withToken(session.body.token) })
    )
  );
  assert.equal(deleted.status, 200);
  assert.deepEqual([...harness.storage.raw.keys()], ['deleted']);
});

test('a new account is refused when the registry is full', async () => {
  const harness = object({ registryFull: true });
  const response = await provision(harness);

  assert.equal(response.status, 429);
  assert.equal(response.body.error, 'full');
  assert.equal(harness.storage.raw.has('account'), false);
  assert.deepEqual(harness.reserved, [ACCOUNT.accountId]);
});

test('a registry that cannot read its cap is not reported as a full server', async () => {
  const harness = object({
    registry: {
      idFromName: (name) => ({ name }),
      get: () => ({
        fetch: async () =>
          new Response(JSON.stringify({ error: 'cap_unreadable' }), {
            status: 500,
            headers: { 'content-type': 'application/json' }
          })
      })
    }
  });

  const response = await provision(harness);

  assert.equal(response.status, 500);
  assert.equal(response.body.error, 'cap_unreadable');
  assert.deepEqual(harness.reserved, []);
  assert.equal(harness.storage.raw.has('account'), false);
});

test('an existing account is unaffected by a full registry', async () => {
  const harness = object();
  assert.equal((await provision(harness)).status, 201);

  harness.setFull(true);
  const again = await provision(harness);

  assert.equal(again.status, 200, 'the existing check comes before the reservation');
  assert.equal(again.body.created, false);
  assert.equal(harness.reserved.length, 1);
});

test('the registry is asked once for a retried first sync', async () => {
  const harness = object();
  await provision(harness);
  await provision(harness);

  assert.deepEqual(harness.reserved, [ACCOUNT.accountId]);
});

test('a server that wants a code never asks a device whose account already exists', async () => {
  const { hashCode } = await import('../src/invites.js');
  const code = 'ABCD-EFGH-JKLM';
  const digest = await hashCode(code);
  const reserved = [];

  /* The Registry as a server that requires codes behaves: an empty or wrong digest is refused,
     the one live code reserves a slot and is spent. */
  const registry = {
    idFromName: (name) => ({ name }),
    get: () => ({
      fetch: async (request) => {
        const body = await request.clone().json();
        const headers = { 'content-type': 'application/json' };
        if (body.inviteHash !== digest) {
          return new Response(JSON.stringify({ error: 'invite_required' }), { status: 403, headers });
        }
        reserved.push(body.accountId);
        return new Response(JSON.stringify({ ok: true, via: 'invite' }), { status: 200, headers });
      }
    })
  };

  const harness = object({ registry });

  const noCode = await provision(harness);
  assert.equal(noCode.status, 403);
  assert.equal(noCode.body.error, 'invite_required');
  assert.deepEqual(reserved, [], 'a refused creation spends no slot');

  const withCode = await provision(harness, ACCOUNT.authSecret, code);
  assert.equal(withCode.status, 201);
  assert.equal((await harness.storage.get('account')).via, 'invite');
  assert.deepEqual(reserved, [ACCOUNT.accountId]);

  /* The same phrase on a second device: the account exists, so creation answers 200 before the
     registry is asked. No code is needed, and no second slot is spent. */
  const secondDevice = await provision(harness);
  assert.equal(secondDevice.status, 200);
  assert.equal(secondDevice.body.created, false);
  assert.deepEqual(reserved, [ACCOUNT.accountId], 'the registry was not asked a second time');
});

test('a provisioning call cannot write into a differently named object', async () => {
  const harness = object({ name: 'someoneelseaccountid' });
  const response = await provision(harness);
  assert.equal(response.status, 400);
  assert.equal(response.body.error, 'mismatch');
});

test('a challenge needs the account, and returns a nonce once it exists', async () => {
  const harness = object();

  const missing = await read(await harness.vault.fetch(request('/challenge')));
  assert.equal(missing.status, 404);

  await provision(harness);
  const challenge = await read(await harness.vault.fetch(request('/challenge')));
  assert.equal(challenge.status, 200);
  assert.match(challenge.body.nonce, /^[A-Za-z0-9_-]{22}$/);
});

test('a challenge from anywhere else does not displace the nonce a sign-in is holding', async () => {
  const harness = object();
  await provision(harness);

  const owner = await read(await harness.vault.fetch(request('/challenge')));
  assert.equal(owner.status, 200);

  /* Two more callers ask for a challenge while the first is still valid. */
  const stored = harness.storage.raw.get('nonce');
  const second = await read(await harness.vault.fetch(request('/challenge')));
  await harness.vault.fetch(request('/challenge'));

  assert.equal(second.body.nonce, owner.body.nonce, 'the live nonce is the same value');
  assert.equal(harness.storage.raw.get('nonce'), stored, 'and asking again writes nothing');

  const proof = await proveAuth(ACCOUNT.authSecret, ACCOUNT.accountId, owner.body.nonce);
  const login = await read(await harness.vault.fetch(request('/login', { body: { proof } })));
  assert.equal(login.status, 200, 'the sign-in that was in progress completes');
  assert.deepEqual(
    [...harness.storage.raw.keys()].filter((key) => key.startsWith('source:')),
    [],
    'and no failure is counted'
  );
});

test('a nonce that has expired is replaced, never handed out again', async () => {
  const harness = object();
  await provision(harness);

  const first = await read(await harness.vault.fetch(request('/challenge')));
  harness.advance(60_000);

  const second = await read(await harness.vault.fetch(request('/challenge')));
  assert.equal(second.status, 200);
  assert.notEqual(second.body.nonce, first.body.nonce);

  const stale = await proveAuth(ACCOUNT.authSecret, ACCOUNT.accountId, first.body.nonce);
  const login = await read(await harness.vault.fetch(request('/login', { body: { proof: stale } })));
  assert.equal(login.status, 401, 'the expired nonce no longer signs anything in');
});

test('the right proof logs in, and the same proof cannot be replayed', async () => {
  const harness = object();
  await provision(harness);

  const challenge = await read(await harness.vault.fetch(request('/challenge')));
  const proof = await proveAuth(ACCOUNT.authSecret, ACCOUNT.accountId, challenge.body.nonce);

  const first = await read(await harness.vault.fetch(request('/login', { body: { proof } })));
  assert.equal(first.status, 200);
  assert.match(first.body.token, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(first.body.expiresAt > 0);

  const replay = await read(await harness.vault.fetch(request('/login', { body: { proof } })));
  assert.equal(replay.status, 401);
  assert.equal(replay.body.error, 'challenge_expired');
});

test('an empty post to the login route does not end a sign-in that is in progress', async () => {
  const harness = object();
  await provision(harness);

  /* The person holds a nonce; a stranger who can reach the route posts nothing at all. */
  const challenge = await read(await harness.vault.fetch(request('/challenge')));
  const stored = structuredClone(harness.storage.raw.get('nonce'));

  const empty = await read(await harness.vault.fetch(request('/login', { body: {} })));
  const bodyless = await read(await harness.vault.fetch(request('/login')));

  assert.equal(empty.status, 401);
  assert.equal(empty.body.error, 'bad_proof');
  assert.equal(bodyless.status, 401);
  assert.equal(bodyless.body.error, 'bad_proof');
  assert.deepEqual(harness.storage.raw.get('nonce'), stored, 'the challenge is still there');

  /* And the proof the person had already signed still signs in. */
  const proof = await proveAuth(ACCOUNT.authSecret, ACCOUNT.accountId, challenge.body.nonce);
  const login = await read(await harness.vault.fetch(request('/login', { body: { proof } })));
  assert.equal(login.status, 200);
});

test('a login body that is refused as too large leaves the challenge standing', async () => {
  const harness = object();
  await provision(harness);

  const challenge = await read(await harness.vault.fetch(request('/challenge')));
  const stored = structuredClone(harness.storage.raw.get('nonce'));

  const huge = await read(
    await harness.vault.fetch(request('/login', { body: { proof: 'a'.repeat(5 * 1024) } }))
  );
  assert.equal(huge.status, 413);
  assert.deepEqual(harness.storage.raw.get('nonce'), stored);

  const proof = await proveAuth(ACCOUNT.authSecret, ACCOUNT.accountId, challenge.body.nonce);
  assert.equal((await read(await harness.vault.fetch(request('/login', { body: { proof } })))).status, 200);
});

test('a presented proof still spends the challenge, so a guess is not retried against it', async () => {
  const harness = object();
  await provision(harness);

  const challenge = await read(await harness.vault.fetch(request('/challenge')));
  const wrong = await proveAuth('A'.repeat(43), ACCOUNT.accountId, challenge.body.nonce);

  const refused = await read(await harness.vault.fetch(request('/login', { body: { proof: wrong } })));
  assert.equal(refused.status, 401);
  assert.equal(refused.body.error, 'bad_proof');
  assert.equal(await harness.storage.get('nonce'), undefined, 'the attempt spent it');

  const second = await read(await harness.vault.fetch(request('/login', { body: { proof: wrong } })));
  assert.equal(second.status, 401);
  assert.equal(second.body.error, 'challenge_expired');
});

test('a wrong proof is refused, and five in a row from the object lock the account it reached', async () => {
  const harness = object();
  await provision(harness);

  /* The right length and the wrong value, so each of these is an attempt. */
  const wrong = 'x'.repeat(43);
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const challenge = await read(await harness.vault.fetch(request('/challenge')));
    assert.equal(challenge.status, 200, `challenge ${attempt}`);
    const response = await read(
      await harness.vault.fetch(request('/login', { body: { proof: wrong } }))
    );
    assert.equal(response.status, 401, `attempt ${attempt}`);
    assert.equal(response.body.error, 'bad_proof');
  }

  const locked = await read(await harness.vault.fetch(request('/challenge')));
  assert.equal(locked.status, 200, 'a challenge still arrives while locked');

  const refused = await read(await harness.vault.fetch(request('/login', { body: { proof: wrong } })));
  assert.equal(refused.status, 429);
  assert.ok(refused.body.retryAfter > 0);

  harness.advance(15 * 60 * 1000 + 1);
  const after = await login(harness);
  assert.equal(after.status, 200, 'the lockout ends');
});

/* ------------------------------------------------------------- what a source carries */

/* Two digests of the shape the Worker forwards: the object never sees the address they came
   from, so a test can choose one per caller. */
const SOURCE_A = 'a'.repeat(64);
const SOURCE_B = 'b'.repeat(64);

/** A digest-shaped source for the Nth invented caller. */
function sourceOf(index) {
  return index.toString(16).padStart(64, '0');
}

async function failedLoginFrom(harness, source) {
  const challenge = await read(
    await harness.vault.fetch(request('/challenge', { headers: { 'x-vault-source': source } }))
  );
  assert.equal(challenge.status, 200, 'a challenge arrives');
  /* The right length and the wrong value. A string that could not be the proof at all is not an
     attempt at this nonce, so it is not counted, and these tests are about the count. */
  return read(
    await harness.vault.fetch(
      request('/login', {
        body: { proof: 'x'.repeat(43) },
        headers: { 'x-vault-source': source }
      })
    )
  );
}

async function loginFrom(harness, source) {
  const challenge = await read(
    await harness.vault.fetch(request('/challenge', { headers: { 'x-vault-source': source } }))
  );
  assert.equal(challenge.status, 200, 'a challenge arrives');
  const proof = await proveAuth(ACCOUNT.authSecret, ACCOUNT.accountId, challenge.body.nonce);
  return read(
    await harness.vault.fetch(
      request('/login', { body: { proof }, headers: { 'x-vault-source': source } })
    )
  );
}

test('five failures from one source lock that source alone', async () => {
  const harness = object();
  await provision(harness);

  for (let attempt = 1; attempt <= MAX_FAILURES; attempt += 1) {
    const refused = await failedLoginFrom(harness, SOURCE_A);
    assert.equal(refused.status, 401, `attempt ${attempt}`);
    assert.equal(refused.body.error, 'bad_proof');
  }

  const locked = await failedLoginFrom(harness, SOURCE_A);
  assert.equal(locked.status, 429);
  assert.equal(locked.body.error, 'locked');
  assert.equal(locked.body.retryAfter, LOCKOUT_MS / 1000);

  /* The second source is on its first failure, not its sixth: the budget is its own. */
  const other = await failedLoginFrom(harness, SOURCE_B);
  assert.equal(other.status, 401);
  assert.equal(other.body.error, 'bad_proof');
});

test('a locked source does not keep another source, the owner included, out', async () => {
  const harness = object({ ownerId: ACCOUNT.accountId });
  await provision(harness);

  for (let attempt = 1; attempt <= MAX_FAILURES; attempt += 1) {
    await failedLoginFrom(harness, SOURCE_A);
  }
  assert.equal((await failedLoginFrom(harness, SOURCE_A)).status, 429);

  const owner = await loginFrom(harness, SOURCE_B);
  assert.equal(owner.status, 200, 'the owner signs in from another place');
  assert.equal(owner.body.plan, 'owner');

  /* A sign-in elsewhere does not shorten the first source's lock either. */
  const still = await failedLoginFrom(harness, SOURCE_A);
  assert.equal(still.status, 429);
  assert.ok(still.body.retryAfter > 0);
});

test('a correct proof clears its own source, so four failures never become five', async () => {
  const harness = object();
  await provision(harness);

  for (let attempt = 1; attempt < MAX_FAILURES; attempt += 1) {
    assert.equal((await failedLoginFrom(harness, SOURCE_A)).status, 401);
  }

  assert.equal((await loginFrom(harness, SOURCE_A)).status, 200, 'the right proof still works');
  assert.deepEqual(
    [...harness.storage.raw.keys()].filter((key) => key.startsWith('source:')),
    [],
    'and the count it had is gone'
  );

  /* Four more would have crossed the threshold if the first four were still counted. */
  for (let attempt = 1; attempt < MAX_FAILURES; attempt += 1) {
    assert.equal((await failedLoginFrom(harness, SOURCE_A)).status, 401, `again ${attempt}`);
  }
  assert.equal((await loginFrom(harness, SOURCE_A)).status, 200, 'the count started at zero');
});

test('the source table keeps sixty-four entries and evicts the oldest rather than growing', async () => {
  const harness = object();
  await provision(harness);

  const total = MAX_TRACKED_SOURCES + 8;
  for (let index = 0; index < total; index += 1) {
    /* A minute between attempts keeps the whole-account throttle out of the way; a source entry
       only ages out after fifteen. */
    harness.advance(61_000);
    const refused = await failedLoginFrom(harness, sourceOf(index));
    assert.equal(refused.status, 401, `source ${index}`);
  }

  const keys = [...harness.storage.raw.keys()].filter((key) => key.startsWith('source:'));
  assert.equal(keys.length, MAX_TRACKED_SOURCES, 'the table is capped');

  const oldest = await harness.vault.failureKey(ACCOUNT.accountId, sourceOf(0));
  const newest = await harness.vault.failureKey(ACCOUNT.accountId, sourceOf(total - 1));
  assert.equal(keys.includes(oldest), false, 'the oldest entry made room');
  assert.equal(keys.includes(newest), true, 'the newest is the one kept');
});

test('a live lock is never the entry that makes room for a new source', async () => {
  const harness = object();
  await provision(harness);

  /* One source earns its lock. */
  for (let attempt = 1; attempt <= MAX_FAILURES; attempt += 1) {
    assert.equal((await failedLoginFrom(harness, SOURCE_A)).status, 401, `failure ${attempt}`);
  }
  assert.equal((await failedLoginFrom(harness, SOURCE_A)).body.error, 'locked');

  /* Enough invented sources to push the table past its cap, each recorded a moment after the
     last, so the locked entry is the oldest one in it. */
  for (let index = 0; index < MAX_TRACKED_SOURCES; index += 1) {
    await harness.vault.recordBadProof(ACCOUNT.accountId, sourceOf(index), 1_000_001 + index);
  }

  const keys = [...harness.storage.raw.keys()].filter((key) => key.startsWith('source:'));
  assert.equal(keys.length, MAX_TRACKED_SOURCES, 'the table is still capped');

  const lockedKey = await harness.vault.failureKey(ACCOUNT.accountId, SOURCE_A);
  assert.equal(keys.includes(lockedKey), true, 'the locked source kept its entry');

  const stillLocked = await failedLoginFrom(harness, SOURCE_A);
  assert.equal(stillLocked.status, 429);
  assert.equal(stillLocked.body.error, 'locked', 'the churn did not clear the lock');
});

test('a distributed attempt earns a wait that grows to a cap and never a lock', async () => {
  const harness = object();
  await provision(harness);

  for (let index = 0; index < ACCOUNT_FREE_FAILURES; index += 1) {
    assert.equal((await failedLoginFrom(harness, sourceOf(index))).status, 401, `free ${index}`);
  }
  /* The failure that crosses the allowance earns the first wait. */
  assert.equal(
    (await failedLoginFrom(harness, sourceOf(ACCOUNT_FREE_FAILURES))).status,
    401,
    'the failure itself is still counted'
  );

  const waits = [];
  for (let round = 0; round < 6; round += 1) {
    const refused = await failedLoginFrom(harness, sourceOf(100 + round));
    assert.equal(refused.status, 429, `round ${round}`);
    assert.equal(refused.body.error, 'throttled');
    waits.push(refused.body.retryAfter);

    harness.advance(refused.body.retryAfter * 1000);
    assert.equal(
      (await failedLoginFrom(harness, sourceOf(200 + round))).status,
      401,
      'the next failure earns a longer wait'
    );
  }

  assert.deepEqual(waits, [1, 2, 4, 8, 16, 30], 'one second, doubling, and no further');
  assert.equal(Math.max(...waits), ACCOUNT_RETRY_MAX_MS / 1000);

  /* A fresh minute, so the owner meets a wait that is running rather than an expired one. */
  harness.advance(61_000);
  for (let index = 0; index < ACCOUNT_FREE_FAILURES; index += 1) {
    assert.equal((await failedLoginFrom(harness, sourceOf(300 + index))).status, 401);
  }
  assert.equal(
    (await failedLoginFrom(harness, sourceOf(400))).status,
    401,
    'the failure that starts the wait'
  );

  /* The owner is delayed by the wait that is running, and gets in as soon as it ends. */
  const blocked = await loginFrom(harness, sourceOf(5_000));
  assert.equal(blocked.status, 429, 'a wait applies to every source');
  assert.ok(blocked.body.retryAfter <= ACCOUNT_RETRY_MAX_MS / 1000, 'and is at most the cap');

  harness.advance(blocked.body.retryAfter * 1000);
  const owner = await loginFrom(harness, sourceOf(5_000));
  assert.equal(owner.status, 200, 'the same proof is accepted once the wait is over');
  assert.equal(await harness.storage.get('attempts'), undefined, 'and the counter is cleared');
});

test('a nonce expires after a minute', async () => {
  const harness = object();
  await provision(harness);

  const challenge = await read(await harness.vault.fetch(request('/challenge')));
  const proof = await proveAuth(ACCOUNT.authSecret, ACCOUNT.accountId, challenge.body.nonce);

  harness.advance(61_000);
  const response = await read(await harness.vault.fetch(request('/login', { body: { proof } })));
  assert.equal(response.status, 401);
  assert.equal(response.body.error, 'challenge_expired');
});

test('the vault needs a session, and a session needs the right token', async () => {
  const harness = object();
  await provision(harness);

  assert.equal((await read(await harness.vault.fetch(request('/vault', { method: 'GET' })))).status, 401);
  assert.equal(
    (await read(await harness.vault.fetch(request('/vault', { method: 'PUT', body: {} })))).status,
    401
  );

  const forged = await read(
    await harness.vault.fetch(
      request('/vault', { method: 'GET', headers: { authorization: `Bearer ${'a'.repeat(43)}` } })
    )
  );
  assert.equal(forged.status, 401);
});

test('a write increments the version, and a stale base version gets the current blob back', async () => {
  const harness = object();
  await provision(harness);
  const session = await login(harness);
  const auth = { authorization: `Bearer ${session.body.token}` };

  const empty = await read(await harness.vault.fetch(request('/vault', { method: 'GET', headers: auth })));
  assert.equal(empty.status, 404);

  const first = await read(
    await harness.vault.fetch(
      request('/vault', { method: 'PUT', headers: auth, body: { baseVersion: 0, iv: IV, ct: CT } })
    )
  );
  assert.equal(first.status, 200);
  assert.equal(first.body.version, 1);
  assert.equal(first.body.iv, IV);
  assert.equal(first.body.ct, CT);

  const readBack = await read(
    await harness.vault.fetch(request('/vault', { method: 'GET', headers: auth }))
  );
  assert.equal(readBack.status, 200);
  assert.equal(readBack.body.version, 1);

  const stale = await read(
    await harness.vault.fetch(
      request('/vault', { method: 'PUT', headers: auth, body: { baseVersion: 0, iv: IV, ct: CT } })
    )
  );
  assert.equal(stale.status, 409);
  assert.equal(stale.body.currentVersion, 1);
  assert.equal(stale.body.current.ct, CT, 'the current blob comes back for a one-round-trip merge');

  const second = await read(
    await harness.vault.fetch(
      request('/vault', { method: 'PUT', headers: auth, body: { baseVersion: 1, iv: IV, ct: CT } })
    )
  );
  assert.equal(second.status, 200);
  assert.equal(second.body.version, 2);
});

test('the vault keeps the last three versions and drops the rest', async () => {
  const harness = object();
  await provision(harness);
  const session = await login(harness);
  const auth = { authorization: `Bearer ${session.body.token}` };

  for (let version = 0; version < 5; version += 1) {
    const response = await read(
      await harness.vault.fetch(
        request('/vault', {
          method: 'PUT',
          headers: auth,
          body: { baseVersion: version, iv: IV, ct: `${CT}${version}` }
        })
      )
    );
    assert.equal(response.status, 200);
  }

  const history = [...harness.storage.raw.keys()].filter((key) => key.startsWith('history:')).sort();
  assert.deepEqual(history, ['history:2', 'history:3', 'history:4']);
});

test('a bodiless or oversized write is refused before it is stored', async () => {
  const harness = object();
  await provision(harness);
  const session = await login(harness);
  const auth = { authorization: `Bearer ${session.body.token}` };

  const cases = [
    { body: { baseVersion: 0, iv: 'short', ct: CT }, status: 400 },
    { body: { baseVersion: 0, iv: IV, ct: '' }, status: 400 },
    { body: { baseVersion: -1, iv: IV, ct: CT }, status: 400 },
    { body: { baseVersion: '0', iv: IV, ct: CT }, status: 400 },
    { body: { baseVersion: 0, iv: IV, ct: 'a'.repeat(1_400_001) }, status: 413 }
  ];

  for (const { body, status } of cases) {
    const response = await read(
      await harness.vault.fetch(request('/vault', { method: 'PUT', headers: auth, body }))
    );
    assert.equal(response.status, status, JSON.stringify(body).slice(0, 80));
  }

  assert.equal(harness.storage.raw.has('vault'), false);
});

test('logout ends the session, and an expired one is refused', async () => {
  const harness = object();
  await provision(harness);

  const session = await login(harness);
  const auth = { authorization: `Bearer ${session.body.token}` };

  const out = await read(
    await harness.vault.fetch(request('/logout', { headers: auth, body: undefined }))
  );
  assert.equal(out.status, 200);

  const after = await read(await harness.vault.fetch(request('/vault', { method: 'GET', headers: auth })));
  assert.equal(after.status, 401);

  const second = await login(harness);
  const secondAuth = { authorization: `Bearer ${second.body.token}` };
  harness.advance(30 * 24 * 60 * 60 * 1000 + 1);

  const expired = await read(
    await harness.vault.fetch(request('/vault', { method: 'GET', headers: secondAuth }))
  );
  assert.equal(expired.status, 401);
});

/* A prefetcher, a cache, an image tag or a third-party script can put a URL in front of a
   browser, and a GET it causes must not end the session the page is holding. */
test('a logout is a POST; a GET or any other verb is refused and ends nothing', async () => {
  const harness = object();
  await provision(harness);
  const session = await login(harness);
  const auth = { authorization: `Bearer ${session.body.token}` };

  for (const method of ['GET', 'HEAD', 'PUT', 'DELETE']) {
    const refused = await harness.vault.fetch(
      request('/logout', { method, headers: auth, body: undefined })
    );
    assert.equal(refused.status, 405, method);
    assert.equal(refused.headers.get('allow'), 'POST', `${method} is told what to send instead`);
  }

  const still = await read(
    await harness.vault.fetch(request('/sessions', { method: 'GET', headers: auth }))
  );
  assert.equal(still.status, 200, 'the session a refused logout named is still signed in');
});

/* A route that answers every verb hides a caller's mistake, and a refusal that names no method
   leaves the caller retrying the one it just used. */
test('a verb a route does not answer is a 405 that names the ones it does', async () => {
  const harness = object();

  for (const [path, method, allow] of [
    ['/status', 'POST', 'GET'],
    ['/account', 'DELETE', 'POST'],
    ['/challenge', 'GET', 'POST'],
    ['/logout', 'PATCH', 'POST'],
    ['/delete', 'GET', 'POST'],
    ['/sessions', 'POST', 'GET'],
    ['/sessions/AAAAAAAAAAA', 'POST', 'DELETE'],
    ['/vault', 'DELETE', 'GET, PUT'],
    ['/admin-stats', 'POST', 'GET']
  ]) {
    const refused = await harness.vault.fetch(request(path, { method, body: undefined }));
    assert.equal(refused.status, 405, `${method} ${path}`);
    assert.equal(refused.headers.get('allow'), allow, `${method} ${path}`);
  }

  /* A path nothing answers at is still a 404: there is no method list to give for a route that
     does not exist, and a 405 there would claim one does. */
  const missing = await harness.vault.fetch(request('/nothing', { method: 'POST' }));
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get('allow'), null);
});

/* A body is parsed as JSON, so a body that never said it was JSON is refused before it is read
   rather than reported as malformed JSON. */
test('a route that reads JSON refuses a body of another type', async () => {
  const harness = object();

  const form = new Request('https://vault/account', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'accountId=x'
  });
  const refused = await harness.vault.fetch(form);
  assert.equal(refused.status, 415);
  assert.equal((await refused.json()).error, 'unsupported_media_type');

  /* The parameters after the type are not part of it: a charset does not change the format. */
  const typed = new Request('https://vault/account', {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ accountId: ACCOUNT.accountId, authSecret: ACCOUNT.authSecret })
  });
  assert.equal((await harness.vault.fetch(typed)).status, 428, 'the creation opens on its challenge');

  /* A route with no body at all is not a wrong media type, and is answered on its own terms. */
  const noBody = await harness.vault.fetch(new Request('https://vault/delete', { method: 'POST' }));
  assert.equal(noBody.status, 401, 'no body is a missing session, not a missing header');
});

test('an unknown route is a 404, not a crash', async () => {
  const harness = object();
  const response = await read(await harness.vault.fetch(request('/nothing')));
  assert.equal(response.status, 404);
});

const DAY = 24 * 60 * 60 * 1000;

test('the configured owner id gets the owner plan only after a proven login', async () => {
  const harness = object({ ownerId: ACCOUNT.accountId });
  await provision(harness);

  /* A leaked owner id must not be enough: creation always starts free. */
  assert.equal((await harness.storage.get('account')).plan, 'free');

  const session = await login(harness);
  assert.equal(session.body.plan, 'owner');
  assert.equal(session.body.units, OWNER_UNITS);

  harness.advance(10 * 365 * DAY);
  const refreshed = await login(harness);
  const auth = { authorization: `Bearer ${refreshed.body.token}` };
  const response = await read(
    await harness.vault.fetch(
      request('/vault', { method: 'PUT', headers: auth, body: { baseVersion: 0, iv: IV, ct: CT } })
    )
  );
  assert.equal(response.status, 200, 'the owner is never read-only');

  await harness.vault.alarm();
  assert.ok(harness.storage.raw.has('account'), 'the owner is never deleted');
  assert.deepEqual(harness.released, []);
});

test('a member account carries no deadline', async () => {
  const harness = object();
  await provision(harness);

  const session = await login(harness);
  assert.equal(session.body.plan, 'free');
  assert.equal(session.body.trialEndsAt, undefined, 'no deadline is sent');
  assert.equal((await harness.storage.get('account')).trialEndsAt, undefined, 'none is stored');
});

test('an account older than any former trial length still writes', async () => {
  const harness = object();
  await provision(harness);
  const session = await login(harness);
  const auth = { authorization: `Bearer ${session.body.token}` };

  const written = await read(
    await harness.vault.fetch(
      request('/vault', { method: 'PUT', headers: auth, body: { baseVersion: 0, iv: IV, ct: CT } })
    )
  );
  assert.equal(written.status, 200);

  /* Two years: well past the thirty days and the read-only week the old model had. */
  harness.advance(2 * 365 * DAY);

  const after = await login(harness);
  const again = await read(
    await harness.vault.fetch(
      request('/vault', {
        method: 'PUT',
        headers: { authorization: `Bearer ${after.body.token}` },
        body: { baseVersion: 1, iv: IV, ct: CT }
      })
    )
  );
  assert.equal(again.status, 200, 'the hosted copy is still writable');
  assert.equal(again.body.version, 2);
});

test('the alarm does not delete an account that has been used, however old', async () => {
  const harness = object();
  await provision(harness);
  const session = await login(harness);

  await harness.vault.fetch(
    request('/vault', {
      method: 'PUT',
      headers: { authorization: `Bearer ${session.body.token}` },
      body: { baseVersion: 0, iv: IV, ct: CT }
    })
  );

  harness.advance(2 * 365 * DAY);
  await harness.vault.alarm();

  assert.ok(harness.storage.raw.has('account'), 'the account is kept');
  assert.ok(harness.storage.raw.has('vault'), 'the hosted copy is kept');
  assert.deepEqual(harness.released, [], 'the slot is not given back');
});

test('an account created and never used releases its slot after the idle window', async () => {
  const harness = object();
  await provision(harness);
  assert.deepEqual(harness.reserved, [ACCOUNT.accountId]);

  harness.advance(UNUSED_RELEASE_MS - 1);
  await harness.vault.alarm();
  assert.ok(harness.storage.raw.has('account'), 'still inside the idle window');
  assert.deepEqual(harness.released, []);

  harness.advance(2);
  await harness.vault.alarm();
  assert.equal(harness.storage.raw.size, 0, 'the unused account is gone');
  assert.deepEqual(harness.released, [ACCOUNT.accountId]);
});

test('an account that signed in keeps its slot past the idle window', async () => {
  const harness = object();
  await provision(harness);
  const session = await login(harness);
  assert.equal(session.status, 200);

  harness.advance(UNUSED_RELEASE_MS + 1);
  await harness.vault.alarm();

  assert.ok(harness.storage.raw.has('account'));
  assert.deepEqual(harness.released, []);
});

test('a released unused account leaves no entry in the registry list', async () => {
  const registryStorage = storage();
  const registry = new Registry({ storage: registryStorage }, { MAX_ACCOUNTS: '1' });
  const binding = {
    idFromName: () => ({ name: 'registry' }),
    get: () => ({ fetch: (request) => registry.fetch(request) })
  };

  const harness = object({ registry: binding });
  await provision(harness);

  const before = await (await registry.fetch(new Request('https://registry/admin-list'))).json();
  assert.deepEqual(before.ids, [ACCOUNT.accountId]);

  harness.advance(UNUSED_RELEASE_MS + 1);
  await harness.vault.alarm();

  const after = await (await registry.fetch(new Request('https://registry/admin-list'))).json();
  assert.deepEqual(after.ids, [], 'no phantom entry is left behind');
  assert.equal(after.count, 0);
});

test('a paid account writes at any age', async () => {
  const harness = object();
  await provision(harness);

  const account = await harness.storage.get('account');
  await harness.storage.put('account', {
    ...account,
    plan: 'paid',
    units: 10,
    paidUntil: 1_000_000 + 90 * DAY
  });

  await login(harness);
  harness.advance(90 * DAY + 1);

  const refreshed = await login(harness);
  const response = await read(
    await harness.vault.fetch(
      request('/vault', {
        method: 'PUT',
        headers: { authorization: `Bearer ${refreshed.body.token}` },
        body: { baseVersion: 0, iv: IV, ct: CT }
      })
    )
  );
  assert.equal(response.status, 200);
});

test('a free vault is held to the smaller quota', async () => {
  const harness = object();
  await provision(harness);
  const session = await login(harness);

  const response = await read(
    await harness.vault.fetch(
      request('/vault', {
        method: 'PUT',
        headers: { authorization: `Bearer ${session.body.token}` },
        body: { baseVersion: 0, iv: IV, ct: 'a'.repeat(FREE_MAX_CT_CHARS + 1) }
      })
    )
  );

  assert.equal(response.status, 413);
  assert.equal(response.body.error, 'quota');
  assert.equal(response.body.limit, FREE_MAX_CT_CHARS);
});

test('the owner keeps the larger quota', async () => {
  const harness = object({ ownerId: ACCOUNT.accountId });
  await provision(harness);
  const session = await login(harness);

  const response = await read(
    await harness.vault.fetch(
      request('/vault', {
        method: 'PUT',
        headers: { authorization: `Bearer ${session.body.token}` },
        body: { baseVersion: 0, iv: IV, ct: 'a'.repeat(FREE_MAX_CT_CHARS + 1) }
      })
    )
  );

  assert.equal(response.status, 200);
});

test('an account created before the owner flag is configured is upgraded on login', async () => {
  const harness = object();
  await provision(harness);
  assert.equal((await harness.storage.get('account')).plan, 'free');

  harness.env.OWNER_ACCOUNT_ID = ACCOUNT.accountId;
  const session = await login(harness);

  assert.equal(session.body.plan, 'owner');
  assert.equal(session.body.units, OWNER_UNITS);
  assert.equal((await harness.storage.get('account')).plan, 'owner');
});

test('another account never becomes the owner', async () => {
  const harness = object({ ownerId: 'B'.repeat(22) });
  await provision(harness);

  const session = await login(harness);
  assert.equal(session.body.plan, 'free');
  assert.equal(session.body.units, 0);
});

test('a paid account is capped by the units it holds', async () => {
  const harness = object();
  await provision(harness);

  const account = await harness.storage.get('account');
  await harness.storage.put('account', { ...account, plan: 'paid', units: 1, paidUntil: null });

  const session = await login(harness);
  const response = await read(
    await harness.vault.fetch(
      request('/vault', {
        method: 'PUT',
        headers: { authorization: `Bearer ${session.body.token}` },
        body: { baseVersion: 0, iv: IV, ct: 'a'.repeat(UNIT_CT_CHARS + 1) }
      })
    )
  );

  assert.equal(response.status, 413);
  assert.equal(response.body.limit, UNIT_CT_CHARS);
});

test('a write is refused when the blob and its history together overrun the quota', async () => {
  const harness = object();
  await provision(harness);
  const session = await login(harness);
  const auth = { authorization: `Bearer ${session.body.token}` };

  /* Two saves that each fit: the second leaves the first beside it in history. */
  for (const [baseVersion, ct] of [
    [0, 'a'.repeat(70_000)],
    [1, 'b'.repeat(40_000)]
  ]) {
    const saved = await read(
      await harness.vault.fetch(
        request('/vault', { method: 'PUT', headers: auth, body: { baseVersion, iv: IV, ct } })
      )
    );
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
  }

  /* The incoming blob is under the cap on its own. What it would be stored beside — the blob it
     replaces and the version history already keeps — is not. */
  const refused = await read(
    await harness.vault.fetch(
      request('/vault', {
        method: 'PUT',
        headers: auth,
        body: { baseVersion: 2, iv: IV, ct: 'c'.repeat(60_000) }
      })
    )
  );

  assert.equal(refused.status, 413);
  assert.equal(refused.body.error, 'quota');
  assert.equal(refused.body.limit, FREE_MAX_CT_CHARS);
  assert.deepEqual(Object.keys(refused.body).sort(), ['error', 'limit']);

  /* A refusal writes nothing: the current blob and the history are as the accepted saves left
     them. */
  const held = await harness.storage.get('vault');
  assert.equal(held.version, 2);
  assert.equal(held.ct.length, 40_000);
  assert.deepEqual(
    [...harness.storage.raw.keys()].filter((key) => key.startsWith('history:')),
    ['history:1']
  );
});

test('a write that fits the whole stored object is accepted and keeps the previous version', async () => {
  const harness = object();
  await provision(harness);
  const session = await login(harness);
  const auth = { authorization: `Bearer ${session.body.token}` };

  const saves = [
    { baseVersion: 0, ct: 'a'.repeat(40_000) },
    { baseVersion: 1, ct: 'b'.repeat(60_000) },
    /* Exactly at the cap: 60,000 incoming, 60,000 as history, 40,000 older than that. */
    { baseVersion: 2, ct: 'c'.repeat(60_000) }
  ];

  for (const body of saves) {
    const saved = await read(
      await harness.vault.fetch(request('/vault', { method: 'PUT', headers: auth, body: { ...body, iv: IV } }))
    );
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
  }

  const held = await harness.storage.get('vault');
  assert.equal(held.version, 3);
  assert.equal(held.ct, saves[2].ct);

  const kept = await harness.storage.get('history:2');
  assert.equal(kept.version, 2, 'the version just replaced is the newest history entry');
  assert.equal(kept.ct, saves[1].ct);
  assert.equal((await harness.storage.get('history:1')).ct, saves[0].ct);
  assert.deepEqual(
    [...harness.storage.raw.keys()].filter((key) => key.startsWith('history:')).sort(),
    ['history:1', 'history:2']
  );
});

test('admin stats count the current blob and the history stored beside it', async () => {
  const harness = object();
  await provision(harness);
  const session = await login(harness);
  const auth = { authorization: `Bearer ${session.body.token}` };

  for (const [version, size] of [30_000, 20_000, 10_000].entries()) {
    await harness.vault.fetch(
      request('/vault', {
        method: 'PUT',
        headers: auth,
        body: { baseVersion: version, iv: IV, ct: 'a'.repeat(size) }
      })
    );
  }

  const { status, body } = await read(
    await harness.vault.fetch(request('/admin-stats', { method: 'GET' }))
  );
  assert.equal(status, 200);
  assert.equal(body.ctChars, 10_000, 'the current blob alone');
  assert.equal(body.historyChars, 30_000 + 20_000, 'every kept version beside it');
  assert.equal(body.storedChars, 60_000, 'the whole stored object');

  /* The figures reconcile with the entries the object actually holds. */
  const vault = await harness.storage.get('vault');
  const history = [...harness.storage.raw.entries()].filter(([key]) => key.startsWith('history:'));
  const counted =
    vault.ct.length + history.reduce((total, [, entry]) => total + entry.ct.length, 0);

  assert.equal(body.storedChars, counted);
  assert.equal(body.storedChars, body.ctChars + body.historyChars);
  assert.ok(body.storedChars <= body.capChars, 'what is reported fits the cap it is reported with');
});

test('an oversized body is refused before it is parsed', async () => {
  const harness = object();
  await provision(harness);
  const session = await login(harness);
  assert.equal(session.status, 200, JSON.stringify(session.body));

  const hugeVault = await read(
    await harness.vault.fetch(
      request('/vault', {
        method: 'PUT',
        headers: { authorization: `Bearer ${session.body.token}` },
        body: { baseVersion: 0, iv: IV, ct: 'a'.repeat(MAX_VAULT_BODY) }
      })
    )
  );
  assert.equal(hugeVault.status, 413);
  assert.equal(hugeVault.body.error, 'too_large');

  /* A login body is only reached after a challenge, so one has to exist to test the cap. */
  await harness.vault.fetch(request('/challenge'));
  const hugeLogin = await read(
    await harness.vault.fetch(
      request('/login', { body: { proof: 'a'.repeat(5 * 1024) } })
    )
  );
  assert.equal(hugeLogin.status, 413);
});

/* ------------------------------------------------------------- connected places */

async function loginAs(harness, client) {
  const challenge = await read(await harness.vault.fetch(request('/challenge')));
  const proof = await proveAuth(ACCOUNT.authSecret, ACCOUNT.accountId, challenge.body.nonce);
  return read(await harness.vault.fetch(request('/login', { body: { proof, client } })));
}

async function places(harness, token) {
  return read(
    await harness.vault.fetch(
      request('/sessions', { method: 'GET', headers: { authorization: `Bearer ${token}` } })
    )
  );
}

test('the place list needs a session', async () => {
  const harness = object();
  await provision(harness);

  const anonymous = await read(await harness.vault.fetch(request('/sessions', { method: 'GET' })));
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.body.error, 'unauthorized');

  const { body } = await loginAs(harness, 'desktop');
  /* Deliberately one character off, and never the same character: a token that differs
     by nothing is not a forged token, it is the real one. */
  const forged = `${body.token[0] === 'A' ? 'B' : 'A'}${body.token.slice(1)}`;
  const refused = await places(harness, forged);
  assert.equal(refused.status, 401, 'a token one character off is not a session');
});

test('each sign-in is one place, and this one is marked', async () => {
  const harness = object();
  await provision(harness);

  const first = await loginAs(harness, 'desktop');
  const second = await loginAs(harness, 'mobile');

  assert.equal(first.body.places, 1, 'the login answer carries the count');
  assert.equal(second.body.places, 2);

  const listed = await places(harness, second.body.token);
  assert.equal(listed.status, 200);
  assert.equal(listed.body.count, 2);
  assert.equal(listed.body.sessions.length, 2);
  assert.deepEqual(
    listed.body.sessions.map((session) => session.client).sort(),
    ['desktop', 'mobile']
  );
  assert.equal(
    listed.body.sessions.filter((session) => session.current).length,
    1,
    'exactly one place is this one'
  );
  assert.equal(listed.body.sessions.find((session) => session.current).client, 'mobile');

  /* A hash is what would let a caller act as another place, so it must not be in the answer. */
  for (const session of listed.body.sessions) {
    assert.deepEqual(Object.keys(session).sort(), [
      'client',
      'createdAt',
      'current',
      'expiresAt',
      'id',
      'lastSeenAt'
    ]);
    assert.match(session.id, /^[A-Za-z0-9_-]{11}$/, 'a public id, not a token or a hash');
  }
  const text = JSON.stringify(listed.body);
  assert.ok(!text.includes(first.body.token), 'the other session token never comes back');
  assert.ok(!text.includes('hash'));
});

test('a client that declares nothing usable is recorded as unknown', async () => {
  const harness = object();
  await provision(harness);

  const odd = await loginAs(harness, 'toaster');
  const listed = await places(harness, odd.body.token);

  assert.equal(listed.body.sessions[0].client, 'unknown');

  const quiet = await loginAs(harness, undefined);
  const again = await places(harness, quiet.body.token);
  assert.equal(again.body.sessions.filter((session) => session.client === 'unknown').length, 2);
});

test('a place that expires leaves the list, and the others stay', async () => {
  const harness = object();
  await provision(harness);

  const old = await loginAs(harness, 'desktop');
  harness.advance(29 * 24 * 60 * 60 * 1000);
  const fresh = await loginAs(harness, 'mobile');
  harness.advance(2 * 24 * 60 * 60 * 1000);

  const listed = await places(harness, fresh.body.token);
  assert.equal(listed.status, 200);
  assert.equal(listed.body.count, 1);
  assert.equal(listed.body.sessions[0].client, 'mobile');

  const dead = await places(harness, old.body.token);
  assert.equal(dead.status, 401, 'the expired token is refused too');
});

test('a place shows when it was last active, not only when it signed in', async () => {
  const harness = object();
  await provision(harness);

  const { body } = await loginAs(harness, 'desktop');
  const signedInAt = (await places(harness, body.token)).body.sessions[0].createdAt;

  harness.advance(2 * 60 * 60 * 1000);
  /* Any authenticated call refreshes the stamp; a read of an empty account is enough. */
  await harness.vault.fetch(
    request('/vault', { method: 'GET', headers: { authorization: `Bearer ${body.token}` } })
  );

  const listed = (await places(harness, body.token)).body.sessions[0];
  assert.equal(listed.createdAt, signedInAt, 'the sign-in time does not move');
  assert.ok(listed.lastSeenAt > listed.createdAt, 'the last-seen time does');
});

test('signing in more than twenty times keeps the newest twenty places', async () => {
  const harness = object();
  await provision(harness);

  let last = null;
  for (let attempt = 0; attempt < 25; attempt += 1) {
    harness.advance(1000);
    last = await loginAs(harness, 'desktop');
  }

  const listed = await places(harness, last.body.token);
  assert.equal(listed.body.count, 20);
  assert.equal(last.body.places, 20);
});

test('the sign-in answer carries the account dates the owner reads', async () => {
  const harness = object();
  await provision(harness);
  const created = (await harness.storage.get('account')).createdAt;

  const first = await loginAs(harness, 'desktop');
  assert.equal(first.body.createdAt, created, 'the creation date is the stored one, in milliseconds');
  assert.equal(first.body.lastSeenAt, created, 'the sign-in that follows creation is that moment');

  harness.advance(3 * 60 * 1000);
  const second = await loginAs(harness, 'desktop');
  assert.equal(second.body.createdAt, created, 'the creation date does not move');
  assert.equal(second.body.lastSeenAt, created + 3 * 60 * 1000, 'the last-activity date does');
});

/* ---------------------------------------------------------------- operator view */

test('admin stats carry dates, sizes and counts, and no secret or blob', async () => {
  const harness = object();
  await provision(harness);
  const session = await loginAs(harness, 'desktop');

  await harness.vault.fetch(
    request('/vault', {
      method: 'PUT',
      headers: { authorization: `Bearer ${session.body.token}` },
      body: { baseVersion: 0, iv: IV, ct: CT }
    })
  );

  const { status, body } = await read(await harness.vault.fetch(request('/admin-stats', { method: 'GET' })));
  assert.equal(status, 200);
  assert.deepEqual(Object.keys(body).sort(), [
    'capChars',
    'createdAt',
    'ctChars',
    'disabled',
    'historyChars',
    'lastSeenAt',
    'paidUntil',
    'plan',
    'sessions',
    'storedChars',
    'units',
    'updatedAt',
    'vaultVersion',
    'via'
  ]);

  assert.equal(body.disabled, null, 'a live account has no operator switch');
  assert.equal(body.plan, 'free');
  assert.equal(body.units, 0);
  assert.equal(body.vaultVersion, 1);
  assert.equal(body.ctChars, CT.length);
  assert.equal(body.historyChars, 0, 'one blob and nothing beside it');
  assert.equal(body.storedChars, CT.length, 'the whole stored object');
  assert.equal(body.capChars, FREE_MAX_CT_CHARS);
  assert.equal(body.sessions, 1);
  assert.equal(typeof body.createdAt, 'number');
  assert.equal(typeof body.updatedAt, 'number');

  /* The answer is account metadata only: the blob, the auth secret, the account id and the
     session token are each a way in, and none of them is here. */
  const text = JSON.stringify(body);
  for (const hidden of [CT, IV, ACCOUNT.authSecret, ACCOUNT.accountId, session.body.token]) {
    assert.ok(!text.includes(hidden), 'the answer does not carry a secret or the blob');
  }
});

test('admin stats carry no deadline, at any age', async () => {
  const aged = object();
  await provision(aged);
  const open = await read(await aged.vault.fetch(request('/admin-stats', { method: 'GET' })));
  assert.equal(open.body.readOnly, undefined);
  assert.equal(open.body.trialEndsAt, undefined);

  aged.advance(2 * 365 * DAY);
  const old = await read(await aged.vault.fetch(request('/admin-stats', { method: 'GET' })));
  assert.equal(old.body.plan, 'free', 'age changes no plan');
  assert.equal(old.body.readOnly, undefined, 'nothing is read-only');

  const owner = object({ ownerId: ACCOUNT.accountId });
  await provision(owner);
  await login(owner);
  const owned = await read(await owner.vault.fetch(request('/admin-stats', { method: 'GET' })));

  assert.equal(owned.body.plan, 'owner');
  assert.equal(owned.body.units, OWNER_UNITS);
  assert.equal(owned.body.capChars, OWNER_UNITS * UNIT_CT_CHARS);
  assert.equal(owned.body.trialEndsAt, undefined);
  assert.equal(owned.body.readOnly, undefined);
});

test('admin stats count live places only, and an empty object has no account', async () => {
  const empty = object();
  const missing = await read(await empty.vault.fetch(request('/admin-stats', { method: 'GET' })));
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error, 'no_account');
  assert.deepEqual(Object.keys(missing.body), ['error']);

  const harness = object();
  await provision(harness);
  await loginAs(harness, 'desktop');
  harness.advance(31 * 24 * 60 * 60 * 1000);

  const { body } = await read(await harness.vault.fetch(request('/admin-stats', { method: 'GET' })));
  assert.equal(body.sessions, 0, 'an expired place that has not been pruned is not counted');
});

/* ------------------------------------------------- the operator's switch */

test('the operator can disable a vault, every account route refuses, and enable restores it', async () => {
  const harness = object();
  await provision(harness);
  const session = await loginAs(harness, 'desktop');
  const token = session.body.token;

  const disabled = await read(
    await harness.vault.fetch(adminRequest('/admin-disable', { reason: 'testing', by: 'operator' }))
  );
  assert.equal(disabled.status, 200);
  assert.equal(disabled.body.disabled.reason, 'testing');

  const stats = await read(await harness.vault.fetch(request('/admin-stats', { method: 'GET' })));
  assert.equal(stats.body.disabled.reason, 'testing');

  const live = await read(await harness.vault.fetch(request('/status', { method: 'GET' })));
  assert.equal(live.status, 200);
  assert.deepEqual(live.body, { exists: true, disabled: true, disabledAt: stats.body.disabled.at });

  /* Every account-facing route answers the same 403, including a session that was valid a
     moment ago, and creation cannot re-claim the account. */
  for (const [label, response] of [
    ['challenge', await harness.vault.fetch(request('/challenge'))],
    ['login', await harness.vault.fetch(request('/login', { body: { proof: 'x' } }))],
    ['sessions', await harness.vault.fetch(request('/sessions', { method: 'GET', headers: { authorization: `Bearer ${token}` } }))],
    ['read', await harness.vault.fetch(request('/vault', { method: 'GET', headers: { authorization: `Bearer ${token}` } }))],
    ['write', await harness.vault.fetch(request('/vault', { method: 'PUT', headers: { authorization: `Bearer ${token}` }, body: { baseVersion: 0, iv: IV, ct: CT } }))],
    ['create', await harness.vault.fetch(request('/account', { body: { accountId: ACCOUNT.accountId, authSecret: ACCOUNT.authSecret } }))]
  ]) {
    assert.equal(response.status, 403, label);
    assert.equal((await response.json()).error, 'account_disabled', label);
  }

  const enabled = await read(await harness.vault.fetch(adminRequest('/admin-enable', {})));
  assert.equal(enabled.status, 200);

  const back = await read(await harness.vault.fetch(request('/status', { method: 'GET' })));
  assert.deepEqual(back.body, { exists: true, disabled: false, disabledAt: null });

  const again = await loginAs(harness, 'desktop');
  assert.equal(again.status, 200, 'the account works again');
  const readBack = await read(
    await harness.vault.fetch(request('/vault', { method: 'GET', headers: { authorization: `Bearer ${again.body.token}` } }))
  );
  assert.equal(readBack.status, 404, 'the vault is untouched by the switch; there is still no blob');
});

test('a wrong or missing operator secret changes nothing', async () => {
  const harness = object();
  await provision(harness);

  const wrong = await read(await harness.vault.fetch(adminRequest('/admin-disable', { reason: 'x' }, 'wrong-secret')));
  assert.equal(wrong.status, 401);

  const missing = await harness.vault.fetch(
    request('/admin-disable', { body: { reason: 'x' } })
  );
  assert.equal(missing.status, 401);

  const stats = await read(await harness.vault.fetch(request('/admin-stats', { method: 'GET' })));
  assert.equal(stats.body.disabled, null);
  assert.equal((await loginAs(harness, 'desktop')).status, 200);
});

test('an operator secret shorter than 32 bytes opens no operator route', async () => {
  /* Twenty-four bytes is longer than the old sixteen-character floor, so this environment is
     accepted unless the gate measures the configured key in bytes before comparing it. */
  const short = 'operator-secret-24-bytes';
  assert.equal(new TextEncoder().encode(short).length, 24);
  const harness = object({ adminSecret: short });
  await provision(harness);

  for (const [path, body] of [
    ['/admin-disable', { reason: 'too short' }],
    ['/admin-enable', {}],
    ['/admin-delete', {}]
  ]) {
    const refused = await read(await harness.vault.fetch(adminRequest(path, body, short)));
    assert.equal(refused.status, 401, `${path} refuses a short configured secret`);
    assert.deepEqual(refused.body, { error: 'unauthorized' });
  }

  const stats = await read(await harness.vault.fetch(request('/admin-stats', { method: 'GET' })));
  assert.equal(stats.body.disabled, null, 'nothing was disabled');
  assert.equal((await loginAs(harness, 'desktop')).status, 200, 'the account is untouched');

  /* One byte under the floor is still under it, so the refusal is not an accident of the number
     chosen above. */
  const justShort = 's'.repeat(31);
  const boundary = object({ adminSecret: justShort });
  await provision(boundary);
  const refused = await read(
    await boundary.vault.fetch(adminRequest('/admin-disable', {}, justShort))
  );
  assert.equal(refused.status, 401);
});

test('an operator secret of exactly 32 bytes is accepted, so the floor is the only refusal', async () => {
  const floor = 's'.repeat(32);
  const harness = object({ adminSecret: floor });
  await provision(harness);

  const disabled = await read(
    await harness.vault.fetch(adminRequest('/admin-disable', { reason: 'at the floor' }, floor))
  );
  assert.equal(disabled.status, 200);
  assert.equal(disabled.body.disabled.reason, 'at the floor');

  const enabled = await read(
    await harness.vault.fetch(adminRequest('/admin-enable', {}, floor))
  );
  assert.equal(enabled.status, 200);
  assert.deepEqual(enabled.body, { ok: true });
});

test('a refused operator call answers one unchanged body and writes no line', async () => {
  const short = 'operator-secret-24-bytes';
  const harness = object({ adminSecret: short });
  await provision(harness);

  const { result, lines } = await withEvents(async () =>
    read(await harness.vault.fetch(adminRequest('/admin-disable', { reason: 'x' }, short)))
  );

  assert.equal(result.status, 401);
  assert.deepEqual(result.body, { error: 'unauthorized' }, 'the answer says nothing about the configuration');
  assert.deepEqual(lines, [], 'no event line, so the secret has no echo');
});

test('the operator can delete a vault and free its slot, and a second call is a no-op', async () => {
  const harness = object();
  await provision(harness);
  await loginAs(harness, 'desktop');

  const removed = await read(await harness.vault.fetch(adminRequest('/admin-delete', { reason: 'ended' })));
  assert.equal(removed.status, 200);
  assert.equal(removed.body.ok, true);
  assert.deepEqual([...harness.storage.raw.keys()], [], 'every account key is gone');
  assert.deepEqual(harness.released, [ACCOUNT.accountId], 'the Registry slot is released');

  const again = await read(await harness.vault.fetch(adminRequest('/admin-delete', {})));
  assert.equal(again.status, 200);
  assert.equal(again.body.deleted, false);

  const status = await read(await harness.vault.fetch(request('/status', { method: 'GET' })));
  assert.equal(status.status, 404);
  assert.deepEqual(status.body, { exists: false, disabled: false });

  const missing = await read(await harness.vault.fetch(request('/admin-stats', { method: 'GET' })));
  assert.equal(missing.status, 404);
  assert.deepEqual(harness.released, [ACCOUNT.accountId, ACCOUNT.accountId], 'release is idempotent');
});

/* ------------------------------------------------------- deleting an account */

/** The proof a destructive route asks for: one challenge, signed with the phrase's secret. */
async function proofFor(harness) {
  const challenge = await read(await harness.vault.fetch(request('/challenge')));
  assert.equal(challenge.status, 200);
  return proveAuth(ACCOUNT.authSecret, ACCOUNT.accountId, challenge.body.nonce);
}

function withToken(token) {
  return { authorization: `Bearer ${token}` };
}

test('a delete that presents no proof leaves the challenge it will need', async () => {
  const harness = object();
  await provision(harness);
  const session = await loginAs(harness, 'desktop');
  const token = session.body.token;

  const challenge = await read(await harness.vault.fetch(request('/challenge')));
  const stored = structuredClone(harness.storage.raw.get('nonce'));

  const empty = await read(
    await harness.vault.fetch(request('/delete', { body: {}, headers: withToken(token) }))
  );
  assert.equal(empty.status, 401);
  assert.equal(empty.body.error, 'bad_proof');
  assert.deepEqual(harness.storage.raw.get('nonce'), stored, 'the challenge is still there');

  const proof = await proveAuth(ACCOUNT.authSecret, ACCOUNT.accountId, challenge.body.nonce);
  const deleted = await read(
    await harness.vault.fetch(request('/delete', { body: { proof }, headers: withToken(token) }))
  );
  assert.equal(deleted.status, 200);
  assert.equal(deleted.body.ok, true);
});

test('an account is deleted behind a live session and a fresh proof, leaving only a tombstone', async () => {
  const harness = object();
  await provision(harness);
  const session = await loginAs(harness, 'desktop');
  const token = session.body.token;

  /* Something in every key family the deletion must clear: a vault, its history, a second
     session, a live nonce, a creation nonce, the account's attempts and one source's failures. */
  const first = await read(
    await harness.vault.fetch(
      request('/vault', { method: 'PUT', headers: withToken(token), body: { baseVersion: 0, iv: IV, ct: CT } })
    )
  );
  assert.equal(first.status, 200);
  const second = await read(
    await harness.vault.fetch(
      request('/vault', { method: 'PUT', headers: withToken(token), body: { baseVersion: 1, iv: IV, ct: `${CT}b` } })
    )
  );
  assert.equal(second.status, 200);
  await loginAs(harness, 'mobile');
  /* One failed proof leaves the account's attempts key and a source key behind; the deletion
     has to take both. */
  const challenge = await read(await harness.vault.fetch(request('/challenge')));
  await harness.vault.fetch(
    request('/login', { body: { proof: await proveAuth('A'.repeat(43), ACCOUNT.accountId, challenge.body.nonce) } })
  );
  await blind(harness);

  /* The proof the deletion will present brings the live nonce with it. */
  const proof = await proofFor(harness);

  const keysBefore = [...harness.storage.raw.keys()];
  for (const prefix of ['account', 'vault', 'history:', 'session:', 'nonce', 'create-nonce', 'attempts']) {
    assert.ok(
      keysBefore.some((key) => key.startsWith(prefix)),
      `the fixture left a ${prefix} key to remove`
    );
  }

  const deleted = await read(
    await harness.vault.fetch(request('/delete', { body: { proof }, headers: withToken(token) }))
  );

  assert.equal(deleted.status, 200);
  assert.equal(deleted.body.ok, true);
  assert.equal(typeof deleted.body.deletedAt, 'number');

  assert.deepEqual([...harness.storage.raw.keys()], ['deleted'], 'only the tombstone remains');
  assert.deepEqual(harness.storage.raw.get('deleted'), { at: deleted.body.deletedAt });
  assert.deepEqual(harness.released, [ACCOUNT.accountId], 'the Registry slot is released');

  /* The token died with the session, so the next request is refused rather than answered. */
  const after = await read(
    await harness.vault.fetch(request('/vault', { method: 'GET', headers: withToken(token) }))
  );
  assert.equal(after.status, 401);

  /* A device that still holds the phrase is told the account is gone, not that it never
     existed: a 404 is the answer that would send it down the register path. */
  for (const [label, response] of [
    ['challenge', await harness.vault.fetch(request('/challenge'))],
    ['login', await harness.vault.fetch(request('/login', { body: { proof: 'x'.repeat(43) } }))],
    ['status', await harness.vault.fetch(request('/status', { method: 'GET' }))]
  ]) {
    assert.equal(response.status, 410, label);
    const body = await response.json();
    assert.equal(body.error, 'account_deleted', label);
    assert.equal(body.deletedAt, deleted.body.deletedAt, label);
  }

  /* A second delete is a no-op with the same answer, whether or not the session is still held. */
  for (const headers of [withToken(token), {}]) {
    const again = await read(await harness.vault.fetch(request('/delete', { body: { proof: 'x'.repeat(43) }, headers })));
    assert.equal(again.status, 410);
    assert.equal(again.body.error, 'account_deleted');
  }
  assert.deepEqual([...harness.storage.raw.keys()], ['deleted'], 'a second delete writes nothing');
  assert.deepEqual(harness.released, [ACCOUNT.accountId], 'the slot is released once');
});

test('deletion needs a live session, a live nonce and the right phrase, and writes nothing without all three', async () => {
  const harness = object();
  await provision(harness);
  const session = await loginAs(harness, 'desktop');
  const token = session.body.token;

  /* A proof with no session is refused before the nonce is spent. */
  const proof = await proofFor(harness);
  const anonymous = await read(await harness.vault.fetch(request('/delete', { body: { proof } })));
  assert.equal(anonymous.status, 401);
  assert.equal((await harness.storage.get('account')).accountId, ACCOUNT.accountId, 'nothing is deleted');

  /* A session with no live challenge has nothing to check a proof against. */
  await harness.storage.delete('nonce');
  const noNonce = await read(
    await harness.vault.fetch(request('/delete', { body: { proof }, headers: withToken(token) }))
  );
  assert.equal(noNonce.status, 401);
  assert.equal(noNonce.body.error, 'challenge_expired');

  /* A wrong phrase spends the nonce and counts like a failed sign-in. */
  const challenge = await read(await harness.vault.fetch(request('/challenge')));
  const wrong = await read(
    await harness.vault.fetch(
      request('/delete', {
        body: { proof: await proveAuth('A'.repeat(43), ACCOUNT.accountId, challenge.body.nonce) },
        headers: withToken(token)
      })
    )
  );
  assert.equal(wrong.status, 401);
  assert.equal(wrong.body.error, 'bad_proof');
  assert.equal(await harness.storage.get('nonce'), undefined, 'the nonce is spent');
  assert.equal((await harness.storage.get('account')).accountId, ACCOUNT.accountId, 'the account survives');

  const live = await harness.storage.get(await harness.vault.failureKey(ACCOUNT.accountId, null));
  assert.equal(live?.failures, 1, 'a failed deletion is counted against the source');

  /* The right phrase still works on the next challenge, so five failures were not needed. */
  const right = await read(
    await harness.vault.fetch(
      request('/delete', { body: { proof: await proofFor(harness) }, headers: withToken(token) })
    )
  );
  assert.equal(right.status, 200);
});

test('a deleted account is not recreated by another sync, and only an invite or the operator brings it back', async () => {
  const harness = object();
  await provision(harness);
  const session = await loginAs(harness, 'desktop');
  const token = session.body.token;

  const deleted = await read(
    await harness.vault.fetch(
      request('/delete', { body: { proof: await proofFor(harness) }, headers: withToken(token) })
    )
  );
  assert.equal(deleted.status, 200);
  const before = harness.reserved.length;

  /* The same phrase, proving itself again, is refused before a slot is asked for and before a
     new nonce is written. This is the path a restore on a still-signed-in device takes. */
  const blindAgain = await blind(harness);
  assert.equal(blindAgain.status, 410);
  assert.equal(blindAgain.body.error, 'account_deleted');
  assert.deepEqual([...harness.storage.raw.keys()], ['deleted']);
  assert.equal(harness.reserved.length, before, 'no slot is reserved for a tombstoned account');

  const provedAgain = await read(
    await harness.vault.fetch(
      request('/account', {
        body: {
          accountId: ACCOUNT.accountId,
          authSecret: ACCOUNT.authSecret,
          proof: await proveAuth(ACCOUNT.authSecret, ACCOUNT.accountId, 'dead-nonce')
        }
      })
    )
  );
  assert.equal(provedAgain.status, 428, 'no live challenge: the route offers one, and writes no account');

  /* Even that fresh challenge cannot bring the account back without a code. */
  const signedAgain = await read(
    await harness.vault.fetch(
      request('/account', {
        body: {
          accountId: ACCOUNT.accountId,
          authSecret: ACCOUNT.authSecret,
          proof: await proveAuth(ACCOUNT.authSecret, ACCOUNT.accountId, provedAgain.body.nonce)
        }
      })
    )
  );
  assert.equal(signedAgain.status, 410);
  assert.equal(signedAgain.body.error, 'account_deleted');
  assert.equal(harness.reserved.length, before, 'still no slot');
  assert.deepEqual([...harness.storage.raw.keys()], ['deleted'], 'the tombstone is still all that remains');

  /* The operator's end-account route removes the tombstone as well, which is the documented
     way back on a server that hands out no codes. */
  const cleared = await read(await harness.vault.fetch(adminRequest('/admin-delete', {})));
  assert.equal(cleared.status, 200);
  assert.deepEqual([...harness.storage.raw.keys()], []);

  const nowPossible = await provision(harness);
  assert.equal(nowPossible.status, 201, 'the id can be created again once the tombstone is gone');
});

/* ------------------------------- a deployment with no Registry binding */

/** An object whose environment carries no REGISTRY, which is what a preview or a fork gets. */
function unbound() {
  const store = storage();
  const vault = new Vault(
    { storage: store, id: { name: ACCOUNT.accountId } },
    { OWNER_ACCOUNT_ID: '', ADMIN_SECRET: 'test-admin-secret-0123456789abcdef' },
    { now: () => 1_000_000 }
  );
  return { vault, storage: store };
}

test('a deployment with no Registry binding refuses to create an account', async () => {
  const harness = unbound();

  /* A challenge stores nothing, so it is still answered on a server that cannot cap accounts. */
  const challenge = await blind(harness);
  assert.equal(challenge.status, 428);
  assert.equal(challenge.body.error, 'proof_required');

  const proof = await proveAuth(ACCOUNT.authSecret, ACCOUNT.accountId, challenge.body.nonce);
  const refused = await read(
    await harness.vault.fetch(
      request('/account', {
        body: { accountId: ACCOUNT.accountId, authSecret: ACCOUNT.authSecret, proof }
      })
    )
  );

  assert.equal(refused.status, 503);
  assert.deepEqual(refused.body, { error: 'registry_unavailable' });
  assert.equal(harness.storage.raw.has('account'), false, 'no account is written without a cap');
  assert.deepEqual(
    [...harness.storage.raw.keys()].filter((key) => key.startsWith('slot:')),
    [],
    'and no slot marker is written'
  );
});

test('a deployment with no Registry binding still signs in an account that already exists', async () => {
  const harness = unbound();
  await harness.storage.put('account', {
    accountId: ACCOUNT.accountId,
    authSecret: ACCOUNT.authSecret,
    plan: 'free',
    units: 0,
    via: 'direct',
    createdAt: 900_000,
    lastSeenAt: 900_000,
    paidUntil: null
  });

  const signed = await provision(harness);
  assert.equal(signed.status, 200, 'only making a new account is refused');
  assert.equal(signed.body.created, false);
  assert.equal(signed.body.plan, 'free');

  const session = await login(harness);
  assert.equal(session.status, 200);
});

/* ------------------------------- a slot that is reserved and must not be lost */

test('a creation whose account write fails gives the slot back on the next wake-up', async () => {
  let failed = false;
  const store = storage({
    failPut: (key) => {
      if (key !== 'account' || failed) return false;
      failed = true;
      return true;
    }
  });
  const harness = object({ storage: store });

  await assert.rejects(provision(harness), 'the creation cannot answer without an account');

  assert.equal(harness.storage.raw.has(`slot:${ACCOUNT.accountId}`), true, 'the slot is recorded');
  assert.equal(harness.storage.alarms.length, 1, 'and something will wake the object for it');
  assert.equal(harness.storage.raw.has('account'), false);

  await harness.vault.alarm();

  assert.deepEqual(harness.released, [ACCOUNT.accountId], 'the reserved slot goes back');
  assert.equal(harness.storage.raw.has(`slot:${ACCOUNT.accountId}`), false, 'the debt is settled');
  assert.equal(harness.storage.alarms.length, 0, 'and nothing is left to wake');
});

test('a deletion whose release fails is retried on the next alarm instead of dropped', async () => {
  let down = true;
  const harness = object({ registryFails: (path) => path === '/release' && down });
  await provision(harness);
  const session = await loginAs(harness, 'desktop');

  const deleted = await read(
    await harness.vault.fetch(
      request('/delete', {
        body: { proof: await proofFor(harness) },
        headers: withToken(session.body.token)
      })
    )
  );

  assert.equal(deleted.status, 200, 'the deletion still answers ok');
  assert.equal(deleted.body.ok, true);
  assert.equal(harness.storage.raw.has(`slot:${ACCOUNT.accountId}`), true, 'the slot is still owed');
  assert.equal(harness.storage.alarms.length, 1, 'and an alarm is armed to ask again');
  assert.deepEqual(harness.released, [], 'nothing was released');

  down = false;
  await harness.vault.alarm();

  assert.deepEqual(harness.released, [ACCOUNT.accountId], 'the retry gives the slot back');
  assert.equal(harness.storage.raw.has(`slot:${ACCOUNT.accountId}`), false);
  assert.equal(harness.storage.raw.has('deleted'), true, 'the tombstone is untouched');
  assert.equal(harness.storage.alarms.length, 0, 'a settled debt stops re-arming');
});

test('an unused account whose release fails is not wiped before its slot is free', async () => {
  let down = true;
  const harness = object({ registryFails: (path) => path === '/release' && down });
  await provision(harness);

  harness.advance(UNUSED_RELEASE_MS + 1);
  await harness.vault.alarm();

  assert.equal(harness.storage.raw.has('account'), true, 'the record stays while the slot is held');
  assert.equal((await harness.storage.get('account')).accountId, ACCOUNT.accountId);
  assert.equal(harness.storage.raw.has(`slot:${ACCOUNT.accountId}`), true, 'the debt is recorded');
  assert.deepEqual(harness.released, []);
  assert.equal(harness.storage.alarms.length, 1, 'the object is woken to try again');

  down = false;
  await harness.vault.alarm();

  assert.deepEqual(harness.released, [ACCOUNT.accountId]);
  assert.equal(harness.storage.raw.size, 0, 'the record and its marker are gone');
});

test('a normal creation and a normal deletion leave no marker and no alarm behind', async () => {
  const harness = object();
  await provision(harness);

  const created = await harness.storage.get('account');
  assert.deepEqual(
    [...harness.storage.raw.keys()].filter((key) => key.startsWith('slot:')),
    [],
    'an account that exists owes nothing'
  );
  assert.deepEqual(
    harness.storage.alarms,
    [created.createdAt + UNUSED_RELEASE_MS],
    'exactly the one unused-release alarm is armed'
  );

  const session = await loginAs(harness, 'desktop');
  const deleted = await read(
    await harness.vault.fetch(
      request('/delete', {
        body: { proof: await proofFor(harness) },
        headers: withToken(session.body.token)
      })
    )
  );

  assert.equal(deleted.status, 200);
  assert.deepEqual([...harness.storage.raw.keys()], ['deleted'], 'only the tombstone remains');
  assert.deepEqual(harness.storage.alarms, [], 'a confirmed release arms nothing further');

  await harness.vault.alarm();
  assert.deepEqual(harness.released, [ACCOUNT.accountId], 'the wake-up does not release twice');
  assert.deepEqual([...harness.storage.raw.keys()], ['deleted'], 'nor touch the tombstone');
});

test('a wake-up that finds nothing owed keeps no alarm behind', async () => {
  const harness = object();
  await provision(harness);

  /* An object with neither a record nor a marker: the deadline that woke it is the only thing
     here, and nothing under it can be settled. */
  await harness.storage.delete('account');
  assert.equal(harness.storage.alarms.length, 1, 'the unused-release alarm is still armed');

  await harness.vault.alarm();

  assert.deepEqual(harness.released, [], 'there is no marker to ask the Registry about');
  assert.deepEqual(harness.storage.alarms, [], 'and nothing is left to wake the object again');
});

test('a sign-in arms the alarm for the session record it just wrote', async () => {
  const harness = object({ start: 1_000_000 });
  await provision(harness);
  /* A sign-in comes after the creation, which is what makes the account a used one. */
  harness.advance(60_000);
  const loginMoment = 1_060_000;

  const session = await login(harness);

  assert.equal(session.status, 200);
  assert.deepEqual(
    harness.storage.alarms,
    [loginMoment + SESSION_TTL_MS],
    'the record and the alarm carry the same expiry'
  );
});

test('an expired record is deleted by the wake-up, and no alarm is left behind', async () => {
  const harness = object({ start: 1_000_000 });
  await provision(harness);
  harness.advance(60_000);
  assert.equal((await login(harness)).status, 200);

  harness.advance(SESSION_TTL_MS + 1);
  await harness.vault.alarm();

  assert.deepEqual(
    [...harness.storage.raw.keys()].filter((key) => key.startsWith('session:')),
    [],
    'the record of the device that never came back is gone'
  );
  assert.ok(harness.storage.raw.has('account'), 'the account itself is kept');
  assert.deepEqual(harness.storage.alarms, [], 'nothing is left to wake the object for');
});

test('a live session survives a mid-life wake-up, which re-arms to its remaining lifetime', async () => {
  const harness = object({ start: 1_000_000 });
  await provision(harness);
  harness.advance(60_000);
  const loginMoment = 1_060_000;
  assert.equal((await login(harness)).status, 200);

  harness.advance(10 * DAY);
  await harness.vault.alarm();

  const sessions = [...harness.storage.raw.keys()].filter((key) => key.startsWith('session:'));
  assert.equal(sessions.length, 1, 'the place that is still live is not pruned');
  assert.deepEqual(harness.storage.alarms, [loginMoment + SESSION_TTL_MS], 'held at its expiry');
});

test('the paid recheck is not lost when the wake-up deletes an expired record', async () => {
  const harness = object({ ownerId: ACCOUNT.accountId, start: 1_000_000 });
  await provision(harness);
  harness.advance(60_000);
  const session = await login(harness);
  assert.equal(session.body.plan, 'owner', 'the owner plan is granted at sign-in');

  harness.advance(SESSION_TTL_MS + 1);
  const now = 1_060_000 + SESSION_TTL_MS + 1;
  await harness.vault.alarm();

  assert.equal(
    [...harness.storage.raw.keys()].some((key) => key.startsWith('session:')),
    false,
    'the expired record is gone'
  );
  assert.deepEqual(
    harness.storage.alarms,
    [now + 365 * DAY],
    'the year recheck is the only deadline left'
  );
});

test('an operator removal with no id known gives up the alarm it cannot use', async () => {
  const harness = object({ name: '' });
  await harness.storage.setAlarm(1_000_000);

  const removed = await read(await harness.vault.fetch(adminRequest('/admin-delete', {})));

  assert.equal(removed.status, 200);
  assert.equal(removed.body.deleted, false, 'there was nothing to delete');
  assert.deepEqual(harness.released, [], 'a release needs an id to name');
  assert.deepEqual([...harness.storage.raw.keys()], [], 'and no marker is written without one');
  assert.deepEqual(harness.storage.alarms, [], 'the deadline this removal ended is not kept');
});

test('an operator removal settles a slot an earlier creation left recorded', async () => {
  const harness = object();
  await provision(harness);

  /* A reservation whose account write never landed outlives it as a marker on the object. */
  await harness.storage.put('slot:an-earlier-account', { at: 1 });

  const removed = await read(await harness.vault.fetch(adminRequest('/admin-delete', {})));

  assert.equal(removed.status, 200);
  assert.deepEqual(
    [...harness.released].sort(),
    [ACCOUNT.accountId, 'an-earlier-account'].sort(),
    'the account and the reservation it outlived both go back'
  );
  assert.deepEqual([...harness.storage.raw.keys()], [], 'no marker is left to retry from');
  assert.deepEqual(harness.storage.alarms, [], 'and a settled debt arms nothing');
});

test('a creation with an invite clears the tombstone on an invite-only server', async () => {
  const harness = object({ invitesRequired: true });
  assert.equal((await provision(harness)).status, 201);
  const session = await loginAs(harness, 'desktop');
  const token = session.body.token;
  const deleted = await read(
    await harness.vault.fetch(
      request('/delete', { body: { proof: await proofFor(harness) }, headers: withToken(token) })
    )
  );
  assert.equal(deleted.status, 200);

  /* The first request mints a creation nonce; the second proves and reserves with the code. */
  const challenge = await blind(harness);
  assert.equal(challenge.status, 428, 'an invite-only server asks for a proof first');
  const again = await read(
    await harness.vault.fetch(
      request('/account', {
        body: {
          accountId: ACCOUNT.accountId,
          authSecret: ACCOUNT.authSecret,
          proof: await proveAuth(ACCOUNT.authSecret, ACCOUNT.accountId, challenge.body.nonce),
          invite: 'a-new-code'
        }
      })
    )
  );
  assert.equal(again.status, 201);
  assert.equal(again.body.created, true);
  assert.equal(await harness.storage.get('deleted'), undefined, 'the tombstone is gone');
  assert.equal((await harness.storage.get('account')).accountId, ACCOUNT.accountId);
});

/* --------------------------------------------------------- ending one sign-in */

test('each sign-in carries a public id, and the list carries no token and no hash', async () => {
  const harness = object();
  await provision(harness);
  const first = await loginAs(harness, 'desktop');
  const second = await loginAs(harness, 'mobile');

  const list = await places(harness, second.body.token);
  assert.equal(list.status, 200);
  assert.equal(list.body.count, 2);

  const ids = list.body.sessions.map((session) => session.id);
  for (const id of ids) assert.match(id, /^[A-Za-z0-9_-]{11}$/, 'eight random bytes, base64url');
  assert.equal(new Set(ids).size, 2, 'two sign-ins never share one id');

  const raw = JSON.stringify(list.body);
  for (const token of [first.body.token, second.body.token]) assert.equal(raw.includes(token), false);
  assert.equal(raw.includes('hash'), false);
  assert.equal(raw.includes('token'), false);
  assert.equal(list.body.sessions.filter((session) => session.current).length, 1);
});

test('a place can be signed out from the list, and its token is refused on the next request', async () => {
  const harness = object();
  await provision(harness);
  const phone = await loginAs(harness, 'mobile');
  const computer = await loginAs(harness, 'desktop');

  const list = await places(harness, computer.body.token);
  const phoneId = list.body.sessions.find((session) => session.client === 'mobile').id;

  const revoked = await read(
    await harness.vault.fetch(
      request(`/sessions/${phoneId}`, { method: 'DELETE', headers: withToken(computer.body.token) })
    )
  );
  assert.equal(revoked.status, 200);
  assert.equal(revoked.body.ok, true);
  assert.equal(revoked.body.current, false);
  assert.equal(revoked.body.count, 1);

  const refused = await harness.vault.fetch(
    request('/vault', { method: 'GET', headers: withToken(phone.body.token) })
  );
  assert.equal(refused.status, 401, 'the ended place is refused on its next request');

  const after = await places(harness, computer.body.token);
  assert.equal(after.body.count, 1);
  assert.equal(after.body.sessions[0].client, 'desktop');
  assert.equal(after.body.sessions[0].current, true);

  /* The survivor still works: the account and its vault are untouched by ending one session. */
  const write = await read(
    await harness.vault.fetch(
      request('/vault', {
        method: 'PUT',
        headers: withToken(computer.body.token),
        body: { baseVersion: 0, iv: IV, ct: CT }
      })
    )
  );
  assert.equal(write.status, 200);
});

test('the last place, this one included, can be ended without touching the account or vault', async () => {
  const harness = object();
  await provision(harness);
  const only = await loginAs(harness, 'desktop');
  const list = await places(harness, only.body.token);

  const revoked = await read(
    await harness.vault.fetch(
      request(`/sessions/${list.body.sessions[0].id}`, {
        method: 'DELETE',
        headers: withToken(only.body.token)
      })
    )
  );
  assert.equal(revoked.status, 200);
  assert.equal(revoked.body.current, true, 'the caller is told this was this place');
  assert.equal(revoked.body.count, 0);

  const refused = await harness.vault.fetch(
    request('/vault', { method: 'GET', headers: withToken(only.body.token) })
  );
  assert.equal(refused.status, 401);

  /* The phrase still opens the account, which still holds its sealed blob. */
  const again = await loginAs(harness, 'desktop');
  assert.equal(again.status, 200);
  const readBack = await harness.vault.fetch(
    request('/vault', { method: 'GET', headers: withToken(again.body.token) })
  );
  assert.equal(readBack.status, 404, 'no blob was ever written; the account exists and answers');
  assert.equal((await harness.vault.fetch(request('/status', { method: 'GET' }))).status, 200);
});

test('ending a place needs a session, and an unknown id is a 404 that changes nothing', async () => {
  const harness = object();
  await provision(harness);
  const session = await loginAs(harness, 'desktop');

  const anonymous = await harness.vault.fetch(request('/sessions/AAAAAAAAAAA', { method: 'DELETE' }));
  assert.equal(anonymous.status, 401);

  const unknown = await read(
    await harness.vault.fetch(
      request('/sessions/AAAAAAAAAAA', { method: 'DELETE', headers: withToken(session.body.token) })
    )
  );
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.error, 'not_found');

  const still = await places(harness, session.body.token);
  assert.equal(still.body.count, 1, 'the unknown id revoked nothing');
});

/**
 * A write whose body is still arriving.
 *
 * `request()` hands over a finished string, which cannot be held open, so this builds the request
 * around a stream the test controls: the object can reach the body read and wait there while the
 * test acts on the account, and only then does the body arrive. `duplex: 'half'` is what Node's
 * fetch requires of a stream body.
 *
 * `arrived` resolves when the object asks the stream for the body, which is after it has
 * authorised the request and read the account ahead of the body. Waiting for that, rather than for
 * a timer, is what makes these tests deterministic: a timer can fire while the object is still
 * hashing the session, and the test then acts on an account the request never got as far as.
 */
function openWrite(headers = {}) {
  let controller;
  let reached;
  const arrived = new Promise((resolve) => {
    reached = resolve;
  });
  const body = new ReadableStream(
    {
      start(open) {
        controller = open;
      },
      /* The reader is waiting for a chunk, so the object is parked at its body read. */
      pull() {
        reached();
      }
    },
    /* A queued chunk is what `highWaterMark: 0` forbids, so `pull` is called only by a reader that
       is waiting, never when the request is merely constructed. */
    { highWaterMark: 0 }
  );
  const encoder = new TextEncoder();

  return {
    request: new Request('https://vault/vault', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...headers },
      body,
      duplex: 'half'
    }),
    arrived,
    send(value) {
      controller.enqueue(encoder.encode(JSON.stringify(value)));
    },
    close() {
      controller.close();
    }
  };
}

test('an owner claim made while a save is in flight survives the save', async () => {
  const harness = object();
  await provision(harness);
  const session = await login(harness);
  assert.equal((await harness.storage.get('account')).plan, 'free');

  harness.env.OWNER_ACCOUNT_ID = ACCOUNT.accountId;

  const held = openWrite(withToken(session.body.token));
  const pending = harness.vault.fetch(held.request);
  await held.arrived;

  /* The sign-in that lands while this body is still in the air is the only writer of the plan. */
  await harness.vault.claimOwner(await harness.storage.get('account'));

  held.send({ baseVersion: 0, iv: IV, ct: CT });
  held.close();
  const response = await read(await pending);

  assert.equal(response.status, 200);
  assert.equal(response.body.version, 1);

  const stored = await harness.storage.get('account');
  assert.equal(stored.plan, 'owner', 'the claim is still there');
  assert.equal(stored.units, OWNER_UNITS);
});

test('a units and paid-until grant made while a save is in flight survives the save', async () => {
  const harness = object();
  await provision(harness);
  const session = await login(harness);

  const first = await harness.storage.get('account');
  await harness.storage.put('account', { ...first, plan: 'paid', units: 1, paidUntil: 4_000_000 });
  harness.advance(120_000);

  const held = openWrite(withToken(session.body.token));
  const pending = harness.vault.fetch(held.request);
  await held.arrived;

  const granted = { ...(await harness.storage.get('account')), units: 3, paidUntil: 9_000_000 };
  await harness.storage.put('account', granted);
  const beforeWrite = structuredClone(granted);

  held.send({ baseVersion: 0, iv: IV, ct: CT });
  held.close();
  const response = await read(await pending);

  assert.equal(response.status, 200);
  assert.equal(response.body.updatedAt, 1_120_000);

  const stored = await harness.storage.get('account');
  assert.equal(stored.units, 3, 'the granted units are still there');
  assert.equal(stored.paidUntil, 9_000_000, 'the grant date is still there');
  assert.equal(stored.plan, 'paid');
  assert.equal(stored.accountId, beforeWrite.accountId);
  assert.equal(stored.createdAt, beforeWrite.createdAt);

  /* The write owns one field on the account, and this is the only one it moved. */
  assert.equal(stored.lastSeenAt, 1_120_000);
  assert.deepEqual({ ...stored, lastSeenAt: beforeWrite.lastSeenAt }, beforeWrite);
});

test('a body that lands after the operator ended the account is refused, not written', async () => {
  const harness = object();
  await provision(harness);
  const session = await login(harness);
  assert.equal(harness.storage.raw.has('vault'), false);

  const held = openWrite(withToken(session.body.token));
  const pending = harness.vault.fetch(held.request);
  await held.arrived;

  const removed = await read(await harness.vault.fetch(adminRequest('/admin-delete', {})));
  assert.equal(removed.status, 200);

  held.send({ baseVersion: 0, iv: IV, ct: CT });
  held.close();
  const response = await read(await pending);

  assert.equal(response.status, 404);
  assert.equal(response.body.error, 'no_account');
  assert.equal(harness.storage.raw.has('account'), false, 'the account that ended stays ended');
  assert.equal(harness.storage.raw.has('vault'), false, 'no envelope was left behind');
  assert.deepEqual(
    [...harness.storage.raw.keys()].filter((key) => key.startsWith('history:')),
    [],
    'no history was left behind either'
  );
});

/**
 * Hold one key's write open, so a test can act on the account in the window between the body
 * read and the account write. The fake storage is shared with the object, so replacing `put` on
 * it is what the object calls. `arrived` resolves when the object reaches the held write — a
 * fixed sleep would let the test act before the request had authorised, which proves nothing.
 */
function holdPut(harness, key) {
  const realPut = harness.storage.put.bind(harness.storage);
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let reached;
  const arrived = new Promise((resolve) => {
    reached = resolve;
  });
  harness.storage.put = async (name, value) => {
    if (name === key) {
      reached();
      await gate;
    }
    return realPut(name, value);
  };
  return { arrived, release };
}

test('an owner claim made just before the vault write survives the write', async () => {
  const harness = object();
  await provision(harness);
  const session = await login(harness);
  assert.equal((await harness.storage.get('account')).plan, 'free');

  harness.env.OWNER_ACCOUNT_ID = ACCOUNT.accountId;

  const { arrived, release } = holdPut(harness, 'vault');
  const pending = harness.vault.fetch(
    request('/vault', {
      method: 'PUT',
      headers: withToken(session.body.token),
      body: { baseVersion: 0, iv: IV, ct: CT }
    })
  );
  await arrived;

  /* The claim lands after the account read this route makes for its quota check. */
  await harness.vault.claimOwner(await harness.storage.get('account'));
  release();
  const response = await read(await pending);

  assert.equal(response.status, 200);
  const stored = await harness.storage.get('account');
  assert.equal(stored.plan, 'owner', 'the claim is still there');
  assert.equal(stored.units, OWNER_UNITS);
});

test('a deletion that lands just before the vault write is not undone by it', async () => {
  const harness = object();
  await provision(harness);
  const session = await login(harness);

  const { arrived, release } = holdPut(harness, 'vault');
  const pending = harness.vault.fetch(
    request('/vault', {
      method: 'PUT',
      headers: withToken(session.body.token),
      body: { baseVersion: 0, iv: IV, ct: CT }
    })
  );
  await arrived;

  const removed = await read(await harness.vault.fetch(adminRequest('/admin-delete', {})));
  assert.equal(removed.status, 200);
  release();
  const response = await read(await pending);

  assert.ok(response.status === 404 || response.status === 410, `answered ${response.status}`);
  assert.equal(harness.storage.raw.has('account'), false, 'the ended account stays ended');
  assert.equal(harness.storage.raw.has('vault'), false, 'the envelope written in the gap is gone');
  assert.deepEqual(
    [...harness.storage.raw.keys()].filter((key) => key.startsWith('history:')),
    [],
    'and no history entry from this request is left'
  );
});

test('an ordinary write still records its version and its time', async () => {
  const harness = object();
  await provision(harness);
  const session = await login(harness);
  const auth = withToken(session.body.token);

  harness.at(2_000_000);
  const first = await read(
    await harness.vault.fetch(
      request('/vault', { method: 'PUT', headers: auth, body: { baseVersion: 0, iv: IV, ct: CT } })
    )
  );

  assert.equal(first.status, 200);
  assert.equal(first.body.version, 1);
  assert.equal(first.body.updatedAt, 2_000_000);
  assert.equal(harness.storage.raw.get('vault').updatedAt, 2_000_000);
  assert.equal(harness.storage.raw.get('account').lastSeenAt, 2_000_000);

  harness.advance(1_000);
  const second = await read(
    await harness.vault.fetch(
      request('/vault', { method: 'PUT', headers: auth, body: { baseVersion: 1, iv: IV, ct: CT } })
    )
  );

  assert.equal(second.status, 200);
  assert.equal(second.body.version, 2);
  assert.equal(second.body.updatedAt, 2_001_000);
});
