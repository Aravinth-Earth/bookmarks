/**
 * The account cap.
 *
 * One object holds the set of account ids that exist. Reserving is idempotent, so a retried
 * first sync does not consume a second slot, and the cap is what stands in place of a
 * provisioning token: creation is open, but not unbounded.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { MAX_ACCOUNTS, Registry } from '../src/registry.js';

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
    raw: map
  };
}

function harness(env = {}) {
  const ctx = { storage: storage() };
  return { registry: new Registry(ctx, env), storage: ctx.storage };
}

function accountId(seed) {
  return String(seed).padStart(22, '0');
}

function reserve(body, path = '/reserve') {
  return new Request(`https://registry${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
}

function release(body) {
  return reserve(body, '/release');
}

async function json(response) {
  return { status: response.status, body: await response.json() };
}

test('a new account id takes a slot', async () => {
  const { registry } = harness();
  const response = await json(await registry.fetch(reserve({ accountId: accountId(1) })));

  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.count, 1);
  assert.equal(response.body.max, MAX_ACCOUNTS);
});

test('the same account id reserves once, however often it is presented', async () => {
  const { registry, storage } = harness();

  await registry.fetch(reserve({ accountId: accountId(1) }));
  const again = await json(await registry.fetch(reserve({ accountId: accountId(1) })));

  assert.equal(again.status, 200);
  assert.equal(again.body.alreadyReserved, true);
  assert.equal(again.body.count, 1);
  assert.deepEqual(storage.raw.get('accounts'), [accountId(1)]);
});

test('an id that is not an account id is refused', async () => {
  const { registry, storage } = harness();

  for (const accountId of ['', 'short', 'A'.repeat(21), 'A'.repeat(23), 'A'.repeat(21) + '!']) {
    const response = await json(await registry.fetch(reserve({ accountId })));
    assert.equal(response.status, 400, accountId);
  }

  assert.equal(storage.raw.has('accounts'), false);
});

test('the cap holds, and the account after it is refused', async () => {
  const { registry, storage } = harness();

  for (let at = 0; at < MAX_ACCOUNTS; at += 1) {
    const response = await json(await registry.fetch(reserve({ accountId: accountId(at) })));
    assert.equal(response.status, 200, `account ${at}`);
  }

  const refused = await json(await registry.fetch(reserve({ accountId: accountId(MAX_ACCOUNTS) })));
  assert.equal(refused.status, 429);
  assert.equal(refused.body.error, 'full');
  assert.equal(storage.raw.get('accounts').length, MAX_ACCOUNTS);
});

test('a var can lower the cap without a code change', async () => {
  const { registry } = harness({ MAX_ACCOUNTS: '2' });

  assert.equal((await json(await registry.fetch(reserve({ accountId: accountId(1) })))).status, 200);
  assert.equal((await json(await registry.fetch(reserve({ accountId: accountId(2) })))).status, 200);

  const refused = await json(await registry.fetch(reserve({ accountId: accountId(3) })));
  assert.equal(refused.status, 429);
  assert.equal(refused.body.max, 2);
});

test('stats report the count and the cap', async () => {
  const { registry } = harness({ MAX_ACCOUNTS: '3' });
  await registry.fetch(reserve({ accountId: accountId(1) }));

  const response = await registry.fetch(
    new Request('https://registry/stats', { method: 'GET' })
  );
  const body = await response.json();

  assert.deepEqual(body, { count: 1, max: 3 });
});

test('an unknown route is a 404', async () => {
  const { registry } = harness();
  const response = await registry.fetch(new Request('https://registry/nothing'));
  assert.equal(response.status, 404);
});

test('releasing a slot lets another account take it', async () => {
  const { registry } = harness({ MAX_ACCOUNTS: '1' });

  await registry.fetch(reserve({ accountId: accountId(1) }));
  const refused = await json(await registry.fetch(reserve({ accountId: accountId(2) })));
  assert.equal(refused.status, 429);

  const released = await json(await registry.fetch(release({ accountId: accountId(1) })));
  assert.equal(released.status, 200);
  assert.equal(released.body.count, 0);

  const accepted = await json(await registry.fetch(reserve({ accountId: accountId(2) })));
  assert.equal(accepted.status, 200);
});

test('releasing an unknown id is harmless, an invalid one is refused', async () => {
  const { registry } = harness();

  const unknown = await json(await registry.fetch(release({ accountId: accountId(9) })));
  assert.equal(unknown.status, 200);
  assert.equal(unknown.body.count, 0);

  const invalid = await json(await registry.fetch(release({ accountId: 'short' })));
  assert.equal(invalid.status, 400);
});

test('an oversized reserve body is refused', async () => {
  const { registry, storage } = harness();
  const response = await registry.fetch(
    new Request('https://registry/reserve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'a'.repeat(5000)
    })
  );

  assert.equal(response.status, 413);
  assert.equal(storage.raw.has('accounts'), false);
});

test('the admin list reports the ids the cap is counted from', async () => {
  const { registry } = harness({ MAX_ACCOUNTS: '3' });
  for (const seed of [1, 2, 3]) {
    await registry.fetch(reserve({ accountId: accountId(seed) }));
  }

  const response = await registry.fetch(
    new Request('https://registry/admin-list', { method: 'GET' })
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body, {
    ids: [accountId(1), accountId(2), accountId(3)],
    count: 3,
    max: 3
  });
});

test('the admin list is a GET route, starts empty and answers a POST with 404', async () => {
  const { registry } = harness();

  const empty = await registry.fetch(new Request('https://registry/admin-list', { method: 'GET' }));
  assert.deepEqual(await empty.json(), { ids: [], count: 0, max: MAX_ACCOUNTS });

  const posted = await registry.fetch(
    new Request('https://registry/admin-list', { method: 'POST' })
  );
  assert.equal(posted.status, 404);
});

/* ---- invite codes ---------------------------------------------------------------------------------------- */

function operator(body, path) {
  return new Request(`https://registry${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {})
  });
}

async function mint(registry, body = { count: 1 }) {
  return json(await registry.fetch(operator(body, '/invites/new')));
}

async function spend(registry, code) {
  const { hashCode } = await import('../src/invites.js');
  return json(await registry.fetch(reserve({ accountId: accountId(9), inviteHash: await hashCode(code) })));
}

test('a code is a long, unambiguous string with a digest kept in its place', async () => {
  const { newCode, hashCode, normaliseCode, CODE_CHARS } = await import('../src/invites.js');

  const code = newCode();
  const bare = normaliseCode(code);
  assert.equal(bare.length, CODE_CHARS, 'fifty-one characters of Crockford base32');
  assert.match(bare, /^[0-9A-HJKMNP-TV-Z]{51}$/, 'no I, L, O or U');
  assert.notEqual(newCode(), code, 'two codes are not the same code');

  const digest = await hashCode(code);
  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.equal(await hashCode(code.toLowerCase().replace(/-/g, '')), digest, 'case and dashes do not matter');
});

test('a code is needed to create an account when the server says so, and nothing else changes', async () => {
  const { registry } = harness({ INVITES_REQUIRED: 'true' });

  const refused = await json(await registry.fetch(reserve({ accountId: accountId(1) })));
  assert.equal(refused.status, 403);
  assert.equal(refused.body.error, 'invite_required');

  const fresh = await mint(registry);
  assert.equal(fresh.status, 200);
  assert.equal(fresh.body.codes.length, 1);

  const spent = await spend(registry, fresh.body.codes[0]);
  assert.equal(spent.status, 200);
  assert.equal(spent.body.ok, true);

  /* The same code again is the same slot asked for twice. */
  const twice = await json(
    await registry.fetch(
      reserve({ accountId: accountId(2), inviteHash: (await import('../src/invites.js')).hashCode(fresh.body.codes[0]) ? await (await import('../src/invites.js')).hashCode(fresh.body.codes[0]) : '' })
    )
  );
  assert.equal(twice.status, 422);
  assert.equal(twice.body.error, 'invite_used');
});

test('a code that has expired is refused, and one that was never minted cannot be guessed', async () => {
  const { registry } = harness({ INVITES_REQUIRED: 'true' });
  const minted = await mint(registry, { count: 1, days: 1 });

  const stored = await registry.storage.get('invites');
  await registry.storage.put(
    'invites',
    stored.map((entry) => ({ ...entry, expiresAt: Date.now() - 1 }))
  );

  const expired = await spend(registry, minted.body.codes[0]);
  assert.equal(expired.status, 410);
  assert.equal(expired.body.error, 'invite_expired');

  const invented = await json(await registry.fetch(reserve({ accountId: accountId(3), inviteHash: 'ab'.repeat(32) })));
  assert.equal(invented.status, 403);
});

test('an account that already exists is never asked for a code', async () => {
  const { registry } = harness({ INVITES_REQUIRED: 'true' });
  const minted = await mint(registry);
  assert.equal((await spend(registry, minted.body.codes[0])).status, 200);

  /* Same account, no code: this is a retried first sync, or the same phrase on another device. */
  const again = await json(await registry.fetch(reserve({ accountId: accountId(9) })));
  assert.equal(again.status, 200);
  assert.equal(again.body.alreadyReserved, true);
});

test('the server will not hand out more codes than there are slots', async () => {
  const { registry } = harness({ INVITES_REQUIRED: 'true', MAX_ACCOUNTS: '2' });

  const first = await mint(registry, { count: 5 });
  assert.equal(first.body.codes.length, 2, 'two slots, two codes');

  const second = await mint(registry, { count: 1 });
  assert.equal(second.status, 429);
  assert.equal(second.body.error, 'no_room_for_codes');

  /* Spending one code makes an account of it, and the other code is still a promise: still nothing to give. */
  await spend(registry, first.body.codes[0]);
  assert.equal((await mint(registry, { count: 1 })).status, 429, 'an account and a code fill two slots');

  /* Raise the cap and there is room again: the count is recounted from the accounts and the codes, not remembered. */
  await registry.fetch(operator({ maxAccounts: 3 }, '/settings'));
  const third = await mint(registry, { count: 2 });
  assert.equal(third.status, 200);
  assert.equal(third.body.codes.length, 1, 'one free slot, one code');
});

test('the cap can be set from the operator side, and lowering it deletes nothing', async () => {
  const { registry } = harness({ MAX_ACCOUNTS: '1' });
  assert.equal((await json(await registry.fetch(reserve({ accountId: accountId(1) })))).status, 200);
  assert.equal((await json(await registry.fetch(reserve({ accountId: accountId(2) })))).status, 429);

  const raised = await json(await registry.fetch(operator({ maxAccounts: 3 }, '/settings')));
  assert.equal(raised.status, 200);
  assert.equal(raised.body.max, 3);
  assert.equal((await json(await registry.fetch(reserve({ accountId: accountId(2) })))).status, 200);

  const lowered = await json(await registry.fetch(operator({ maxAccounts: 1 }, '/settings')));
  assert.equal(lowered.body.max, 1);
  assert.equal(lowered.body.accounts, 2, 'the accounts that exist keep existing');

  const list = await json(await registry.fetch(new Request('https://registry/admin-list')));
  assert.equal(list.body.ids.length, 2, 'and none was deleted');
});

test('a revoked code is gone, and a spent one cannot be revoked', async () => {
  const { registry } = harness({ INVITES_REQUIRED: 'true' });
  const minted = await mint(registry, { count: 2 });
  const [first, second] = minted.body.codes;

  const listed = await json(await registry.fetch(new Request('https://registry/invites')));
  assert.equal(listed.body.invites.length, 2);
  assert.equal(listed.body.invites[0].id.length, 8, 'named by a digest prefix, not by the code');

  const revoked = await json(
    await registry.fetch(operator({ id: listed.body.invites[0].id }, '/invites/revoke'))
  );
  assert.equal(revoked.body.revoked, 1);

  assert.equal((await spend(registry, first)).status, 403, 'the revoked code opens nothing');
  assert.equal((await spend(registry, second)).status, 200, 'the other one still does');

  const afterUse = await json(
    await registry.fetch(operator({ id: listed.body.invites[1].id }, '/invites/revoke'))
  );
  assert.equal(afterUse.status, 404, 'a spent code is not a code that can be revoked');
});
