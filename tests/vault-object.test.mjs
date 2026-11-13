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
  UNIT_CT_CHARS,
  UNUSED_RELEASE_MS,
  Vault
} from '../src/vault.js';
import { Registry } from '../src/registry.js';
import { deriveAccount, proveAuth } from '../public/crypto.js';
import { WORDLIST } from '../public/wordlist.js';
import { quiet } from './logs.mjs';

/* These tests are about what the object answers and stores; the lines its refusals write are
   tested in events.test.mjs. */
quiet();

const PHRASE = WORDLIST.slice(0, 13).join(' ');
const ACCOUNT = await deriveAccount(PHRASE);

const IV = 'abcdefghijklmnop';
const CT = 'abcdefghijklmnopqrstuvwxyz';

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

function object(overrides = {}) {
  const ctx = {
    storage: storage(),
    id: { name: overrides.name ?? ACCOUNT.accountId }
  };

  const reserved = [];
  const released = [];
  let full = overrides.registryFull ?? false;

  const env = {
    OWNER_ACCOUNT_ID: overrides.ownerId ?? '',
    REGISTRY: overrides.registry ?? {
      idFromName: (name) => ({ name }),
      get: (id) => ({
        fetch: async (request) => {
          const path = new URL(request.url).pathname;
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

async function blind(harness, authSecret = ACCOUNT.authSecret) {
  return read(
    await harness.vault.fetch(
      request('/account', { body: { accountId: ACCOUNT.accountId, authSecret } })
    )
  );
}

/** The full creation flow: ask for a nonce, sign it with the secret, and write the account. */
async function provision(harness, authSecret = ACCOUNT.authSecret) {
  const challenge = await blind(harness, authSecret);
  if (challenge.status !== 428) return challenge;

  const proof = await proveAuth(authSecret, ACCOUNT.accountId, challenge.body.nonce);
  return read(
    await harness.vault.fetch(
      request('/account', {
        body: { accountId: ACCOUNT.accountId, authSecret, proof }
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

test('a wrong proof is refused, and five in a row from the object lock the account it reached', async () => {
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
  return read(
    await harness.vault.fetch(
      request('/login', {
        body: { proof: 'not-the-proof' },
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
      'lastSeenAt'
    ]);
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
    'lastSeenAt',
    'paidUntil',
    'plan',
    'sessions',
    'units',
    'updatedAt',
    'vaultVersion',
    'via'
  ]);

  assert.equal(body.plan, 'free');
  assert.equal(body.units, 0);
  assert.equal(body.vaultVersion, 1);
  assert.equal(body.ctChars, CT.length);
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
