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
