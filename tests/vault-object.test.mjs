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

import { Vault } from '../src/vault.js';
import { deriveAccount, proveAuth } from '../public/w/bookmarks/crypto.js';
import { WORDLIST } from '../public/w/bookmarks/wordlist.js';

const PHRASE = WORDLIST.slice(0, 13).join(' ');
const ACCOUNT = await deriveAccount(PHRASE);

const IV = 'abcdefghijklmnop';
const CT = 'abcdefghijklmnopqrstuvwxyz';

function storage() {
  const map = new Map();
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
    raw: map
  };
}

function object(overrides = {}) {
  const ctx = {
    storage: storage(),
    id: { name: overrides.name ?? ACCOUNT.accountId }
  };

  const reserved = [];
  let full = overrides.registryFull ?? false;

  const env = {
    REGISTRY: {
      idFromName: (name) => ({ name }),
      get: (id) => ({
        fetch: async (request) => {
          const body = await request.clone().json();
          reserved.push(body.accountId);
          return new Response(JSON.stringify(full ? { error: 'full' } : { ok: true }), {
            status: full ? 429 : 200,
            headers: { 'content-type': 'application/json' }
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

async function provision(harness) {
  return read(
    await harness.vault.fetch(
      request('/account', {
        body: { accountId: ACCOUNT.accountId, authSecret: ACCOUNT.authSecret }
      })
    )
  );
}

async function login(harness) {
  const challenge = await read(await harness.vault.fetch(request('/challenge')));
  assert.equal(challenge.status, 200);
  const proof = await proveAuth(ACCOUNT.authSecret, ACCOUNT.accountId, challenge.body.nonce);
  return read(await harness.vault.fetch(request('/login', { body: { proof } })));
}

test('an account is provisioned exactly once', async () => {
  const harness = object();

  const first = await provision(harness);
  assert.equal(first.status, 201);

  const second = await provision(harness);
  assert.equal(second.status, 409);
  assert.equal(second.body.error, 'exists');

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

test('a new account is refused when the registry is full', async () => {
  const harness = object({ registryFull: true });
  const response = await provision(harness);

  assert.equal(response.status, 429);
  assert.equal(response.body.error, 'full');
  assert.equal(harness.storage.raw.has('account'), false);
  assert.deepEqual(harness.reserved, [ACCOUNT.accountId]);
});

test('an existing account is unaffected by a full registry', async () => {
  const harness = object();
  assert.equal((await provision(harness)).status, 201);

  harness.setFull(true);
  const again = await provision(harness);

  assert.equal(again.status, 409, 'the existing check comes before the reservation');
  assert.equal(harness.reserved.length, 1);
});

test('the registry is asked once for a retried first sync', async () => {
  const harness = object();
  await provision(harness);
  await provision(harness);

  assert.deepEqual(harness.reserved, [ACCOUNT.accountId]);
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

test('a wrong proof is refused, and five in a row lock the account', async () => {
  const harness = object();
  await provision(harness);

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const challenge = await read(await harness.vault.fetch(request('/challenge')));
    assert.equal(challenge.status, 200, `challenge ${attempt}`);
    const response = await read(
      await harness.vault.fetch(request('/login', { body: { proof: 'not-the-proof' } }))
    );
    assert.equal(response.status, 401, `attempt ${attempt}`);
    assert.equal(response.body.error, 'bad_proof');
  }

  const locked = await read(await harness.vault.fetch(request('/challenge')));
  assert.equal(locked.status, 200, 'a challenge still arrives while locked');

  const refused = await read(
    await harness.vault.fetch(request('/login', { body: { proof: 'not-the-proof' } }))
  );
  assert.equal(refused.status, 429);
  assert.ok(refused.body.retryAfter > 0);

  harness.advance(15 * 60 * 1000 + 1);
  const after = await login(harness);
  assert.equal(after.status, 200, 'the lockout ends');
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

test('an unknown route is a 404, not a crash', async () => {
  const harness = object();
  const response = await read(await harness.vault.fetch(request('/nothing')));
  assert.equal(response.status, 404);
});
