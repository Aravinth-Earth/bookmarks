/**
 * The account cap.
 *
 * One object holds the set of account ids that exist. Reserving is idempotent, so a retried
 * first sync does not consume a second slot, and the cap is what stands in place of a
 * provisioning token: creation is open, but not unbounded.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { MAX_ACCOUNTS, RELEASED_LIMIT, Registry } from '../src/registry.js';

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

/* The question the edge asks before it names a Durable Object: a GET, and an id in the query. */
function exists(account, method = 'GET') {
  return new Request(`https://registry/exists?account=${encodeURIComponent(account ?? '')}`, { method });
}

/* Every key and value the object holds, in one string, so a read can be compared with what
   storage looked like before it. */
function snapshot(map) {
  return JSON.stringify([...map.entries()]);
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

/* A sixty-four character id is the one a public key commits to. It is counted exactly like the
   twenty-two character id a phrase hashes to, because the cap counts accounts and not shapes. */
const COMMITTED = 'ab'.repeat(32);

test('a committed id reserves, repeats, exists and releases exactly as a legacy one', async () => {
  const { registry, storage } = harness();

  const first = await json(await registry.fetch(reserve({ accountId: COMMITTED })));
  assert.equal(first.status, 200);
  assert.equal(first.body.count, 1);

  const again = await json(await registry.fetch(reserve({ accountId: COMMITTED })));
  assert.equal(again.status, 200);
  assert.equal(again.body.alreadyReserved, true);
  assert.equal(again.body.count, 1);
  assert.deepEqual(storage.raw.get('accounts'), [COMMITTED]);

  const known = await json(await registry.fetch(exists(COMMITTED)));
  assert.equal(known.status, 200);
  assert.deepEqual(known.body, { exists: true, room: true });

  const released = await json(await registry.fetch(release({ accountId: COMMITTED })));
  assert.equal(released.status, 200);
  assert.equal(released.body.count, 0, 'the slot is free again');
  assert.deepEqual(storage.raw.get('accounts'), []);
  /* Released, not forgotten: the object's tombstone still has to answer for this id. */
  assert.deepEqual((await json(await registry.fetch(exists(COMMITTED)))).body, {
    exists: true,
    room: true
  });
});

test('a sixty-four character id that is not lowercase hex is refused', async () => {
  const { registry, storage } = harness();

  for (const accountId of ['A'.repeat(64), 'g'.repeat(64), `${'a'.repeat(63)}!`]) {
    const reserveRefused = await json(await registry.fetch(reserve({ accountId })));
    assert.equal(reserveRefused.status, 400, accountId);
    assert.deepEqual(reserveRefused.body, { error: 'invalid' });

    const readRefused = await json(await registry.fetch(exists(accountId)));
    assert.equal(readRefused.status, 400, accountId);
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

/* A typo in the cap is a server that does not know how many accounts it may hold. Falling back to
   fifty would answer it by opening more slots than the operator asked for, which is the one
   direction a cap must never move. */
test('a cap that cannot be read refuses a new account instead of falling back', async () => {
  const { registry, storage } = harness({ MAX_ACCOUNTS: '5O' });

  const response = await json(await registry.fetch(reserve({ accountId: accountId(1) })));

  assert.equal(response.status, 500);
  assert.deepEqual(response.body, { error: 'cap_unreadable' });
  assert.equal(storage.raw.has('accounts'), false);
});

test('a cap written as words refuses rather than opening fifty slots', async () => {
  const { registry, storage } = harness({ MAX_ACCOUNTS: 'none' });

  const response = await json(await registry.fetch(reserve({ accountId: accountId(1) })));

  assert.equal(response.status, 500);
  assert.deepEqual(response.body, { error: 'cap_unreadable' });
  assert.equal(storage.raw.has('accounts'), false);
});

/* The var is not the stored setting: the operator page writes zero to clear a setting, but a
   deploy that says zero means zero. */
test('zero is a cap, not an absent value', async () => {
  const { registry, storage } = harness({ MAX_ACCOUNTS: '0' });

  const first = await json(await registry.fetch(reserve({ accountId: accountId(1) })));
  assert.equal(first.status, 429);
  assert.deepEqual(first.body, { error: 'full', max: 0 });

  const second = await json(await registry.fetch(reserve({ accountId: accountId(2) })));
  assert.equal(second.status, 429);

  assert.equal(storage.raw.has('accounts'), false);
});

test('an absent cap still falls back to the built-in default', async () => {
  const { registry } = harness({});

  const response = await json(await registry.fetch(reserve({ accountId: accountId(1) })));

  assert.equal(response.status, 200);
  assert.equal(response.body.max, MAX_ACCOUNTS);
});

test('a padded number is still a number', async () => {
  const { registry } = harness({ MAX_ACCOUNTS: ' 2 ' });

  assert.equal((await json(await registry.fetch(reserve({ accountId: accountId(1) })))).status, 200);
  assert.equal((await json(await registry.fetch(reserve({ accountId: accountId(2) })))).status, 200);

  const refused = await json(await registry.fetch(reserve({ accountId: accountId(3) })));
  assert.equal(refused.status, 429);
  assert.equal(refused.body.max, 2);
});

/* Reads stay answerable: the cap is reported as unknown rather than as a number nobody chose, and
   the room hint stays permissive, because a hint that cannot be computed must not refuse. */
test('an unreadable cap leaves the read routes answerable', async () => {
  const { registry } = harness({ MAX_ACCOUNTS: '5O' });

  const stats = await json(await registry.fetch(new Request('https://registry/stats')));
  assert.equal(stats.status, 200);
  assert.deepEqual(stats.body, { count: 0, max: null });

  const settings = await json(await registry.fetch(new Request('https://registry/settings')));
  assert.equal(settings.status, 200);
  assert.equal(settings.body.max, null);

  const room = await json(await registry.fetch(exists(accountId(1))));
  assert.equal(room.status, 200);
  assert.deepEqual(room.body, { exists: false, room: true });
});

test('a stored cap that cannot be read is refused the same way', async () => {
  const { registry, storage } = harness();
  await storage.put('settings', { maxAccounts: 'soon' });

  const response = await json(await registry.fetch(reserve({ accountId: accountId(1) })));

  assert.equal(response.status, 500);
  assert.deepEqual(response.body, { error: 'cap_unreadable' });
  assert.equal(storage.raw.has('accounts'), false);
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

test('the settings read says whether the gate is on, from the environment', async () => {
  const off = harness({ INVITES_REQUIRED: 'false' });
  const readOff = await json(await off.registry.fetch(new Request('https://registry/settings')));
  assert.equal(readOff.body.invitesRequired, false);

  const on = harness({ INVITES_REQUIRED: 'true' });
  const readOn = await json(await on.registry.fetch(new Request('https://registry/settings')));
  assert.equal(readOn.body.invitesRequired, true);
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

test('releasing an account frees its slot and stops the spent code naming it', async () => {
  const { registry } = harness({ INVITES_REQUIRED: 'true', MAX_ACCOUNTS: '1' });
  const minted = await mint(registry);
  assert.equal((await spend(registry, minted.body.codes[0])).status, 200);

  const before = await registry.storage.get('invites');
  assert.equal(before[0].accountId, accountId(9));

  const released = await json(await registry.fetch(release({ accountId: accountId(9) })));
  assert.equal(released.status, 200);
  assert.equal(released.body.count, 0, 'the slot is free again');

  const after = await registry.storage.get('invites');
  assert.equal(after[0].accountId, undefined, 'the code no longer names a deleted account');
  assert.equal(typeof after[0].usedAt, 'number', 'the code stays spent');

  /* The same code is still refused, and the free slot takes a new account. */
  const { hashCode } = await import('../src/invites.js');
  const refused = await json(
    await registry.fetch(
      reserve({ accountId: accountId(2), inviteHash: await hashCode(minted.body.codes[0]) })
    )
  );
  assert.equal(refused.status, 422);

  const fresh = await mint(registry);
  assert.equal(fresh.status, 200);
  assert.equal((await spend(registry, fresh.body.codes[0])).status, 200);
});

test('an id that was reserved exists, and one that was only well formed does not', async () => {
  const { registry } = harness();
  await registry.fetch(reserve({ accountId: accountId(1) }));

  const known = await json(await registry.fetch(exists(accountId(1))));
  assert.equal(known.status, 200);
  assert.deepEqual(known.body, { exists: true, room: true });

  const unknown = await json(await registry.fetch(exists(accountId(2))));
  assert.equal(unknown.status, 200);
  assert.deepEqual(unknown.body, { exists: false, room: true });
});

test('the read says there is no room once the accounts fill the cap', async () => {
  const { registry } = harness({ MAX_ACCOUNTS: '1' });
  await registry.fetch(reserve({ accountId: accountId(1) }));

  /* Both answers: the account that is there is still there, and nothing more will be made. */
  assert.deepEqual((await json(await registry.fetch(exists(accountId(1))))).body, {
    exists: true,
    room: false
  });
  assert.deepEqual((await json(await registry.fetch(exists(accountId(2))))).body, {
    exists: false,
    room: false
  });
});

test('the read writes nothing, whatever it is asked', async () => {
  const { registry, storage } = harness({ MAX_ACCOUNTS: '1' });
  await registry.fetch(reserve({ accountId: accountId(1) }));

  const before = snapshot(storage.raw);
  await registry.fetch(exists(accountId(1)));
  await registry.fetch(exists(accountId(2)));
  await registry.fetch(exists('not-an-id'));

  assert.equal(snapshot(storage.raw), before, 'a question is not a change');
});

test('the read is a GET, and any other verb is not a route', async () => {
  const { registry, storage } = harness();
  await registry.fetch(reserve({ accountId: accountId(1) }));
  const before = snapshot(storage.raw);

  for (const method of ['POST', 'PUT', 'DELETE']) {
    const response = await json(await registry.fetch(exists(accountId(1), method)));
    assert.equal(response.status, 404, method);
    assert.deepEqual(response.body, { error: 'not_found' });
  }

  assert.equal(snapshot(storage.raw), before);
});

test('the read refuses an id that is not an account id', async () => {
  const { registry, storage } = harness();
  const before = snapshot(storage.raw);

  for (const candidate of ['', 'short', 'A'.repeat(21), 'A'.repeat(23), `${'A'.repeat(21)}!`]) {
    const response = await json(await registry.fetch(exists(candidate)));
    assert.equal(response.status, 400, candidate);
    assert.deepEqual(response.body, { error: 'invalid' });
  }

  assert.equal(snapshot(storage.raw), before);
});

test('a released id still exists, so its tombstone can answer, and its slot is free', async () => {
  const { registry } = harness({ MAX_ACCOUNTS: '1' });
  await registry.fetch(reserve({ accountId: accountId(1) }));
  assert.equal((await json(await registry.fetch(exists(accountId(1))))).body.room, false);

  const released = await json(await registry.fetch(release({ accountId: accountId(1) })));
  assert.equal(released.status, 200);
  assert.equal(released.body.count, 0, 'the slot is free again');

  /* The object keeps a tombstone and answers 410; that answer is only reachable if the id is not
     refused as unknown at the edge. */
  assert.deepEqual((await json(await registry.fetch(exists(accountId(1))))).body, {
    exists: true,
    room: true
  });

  const stats = await json(await registry.fetch(new Request('https://registry/stats')));
  assert.equal(stats.body.count, 0, 'and the deleted account is not counted against the cap');
});

test('the released ids are bounded, and the oldest is forgotten first', async () => {
  const { registry, storage } = harness();

  /* One more deletion than the list can hold. An id need not have had a slot to be remembered: a
     release is the statement that the id was here. */
  for (let index = 0; index <= RELEASED_LIMIT; index += 1) {
    assert.equal((await json(await registry.fetch(release({ accountId: accountId(index) })))).status, 200);
  }

  const kept = await registry.storage.get('released');
  assert.equal(kept.length, RELEASED_LIMIT, 'the list stays bounded');
  assert.equal(kept.at(-1), accountId(RELEASED_LIMIT), 'newest kept');

  assert.equal((await json(await registry.fetch(exists(accountId(0))))).body.exists, false, 'oldest fell out');
  assert.equal((await json(await registry.fetch(exists(accountId(1))))).body.exists, true);
  assert.equal(storage.raw.get('released').length, RELEASED_LIMIT);
});
