/**
 * Per-source request limits.
 *
 * The counters are the `[[ratelimits]]` bindings, so what is tested here is the Worker's half
 * of the contract: which class each route is counted as, that a refusal happens before the
 * route runs, that the key is a digest rather than the address, and that a refusal does not
 * outlive its window. The counting itself is exercised against the real binding in a local
 * `wrangler dev`. The stand-in below repeats the local implementation's fixed window so a
 * refill can be tested without waiting a minute.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import worker, { LIMITS } from '../src/index.js';

const ACCOUNT = 'B'.repeat(22);
const SOURCE = '203.0.113.7';
const OTHER_SOURCE = '198.51.100.9';

/** One counter per class, holding a count per key for the length of a period. */
function limits(now = () => 0) {
  const hits = [];
  const env = {};

  for (const [className, rule] of Object.entries(LIMITS)) {
    const state = { epoch: Math.floor(now() / (rule.period * 1000)), counts: new Map() };

    env[rule.binding] = {
      async limit({ key }) {
        hits.push({ className, key });

        const epoch = Math.floor(now() / (rule.period * 1000));
        if (epoch !== state.epoch) {
          state.epoch = epoch;
          state.counts.clear();
        }

        const count = (state.counts.get(key) ?? 0) + 1;
        state.counts.set(key, count);
        return { success: count <= rule.limit };
      }
    };
  }

  return { env, hits };
}

function harness(limiters = {}) {
  const calls = [];
  const env = {
    ...limiters,
    VAULTS: {
      idFromName: (name) => ({ name }),
      get: (id) => ({
        fetch: async (request) => {
          calls.push({ name: id.name, path: new URL(request.url).pathname });
          return new Response(JSON.stringify({ ok: true }), {
            headers: { 'content-type': 'application/json' }
          });
        }
      })
    },
    ASSETS: { fetch: async () => new Response('<!doctype html><title>app</title>') }
  };
  return { env, calls };
}

function api(path, { method = 'GET', source = SOURCE, body, headers = {} } = {}) {
  return new Request(`https://b.332321.xyz/w/bookmarks/api${path}`, {
    method,
    headers: {
      'cf-connecting-ip': source,
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...headers
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

const ICON_HOST = 'example.com';
const ICON_HASH = createHash('sha256').update(ICON_HOST).digest('base64url');

const ICON = { path: `/icon?h=${ICON_HASH}`, headers: { 'x-icon-host': ICON_HOST } };
const TITLE = { path: `/title?h=${ICON_HASH}`, headers: { 'x-page-host': ICON_HOST } };

async function withFetch(implementation, run) {
  const original = globalThis.fetch;
  globalThis.fetch = implementation;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

async function upstreamMiss() {
  return new Response(null, { status: 404 });
}

test('the sign-in routes share one budget per source, and the account is not reached past it', async () => {
  const { env: limiters } = limits();
  const { env, calls } = harness(limiters);
  const routes = [
    { path: `/a/${ACCOUNT}/challenge`, method: 'POST' },
    { path: `/a/${ACCOUNT}/login`, method: 'POST', body: { proof: 'x' } },
    { path: `/a/${ACCOUNT}/account`, method: 'POST', body: { accountId: ACCOUNT } }
  ];

  for (let at = 0; at < LIMITS.signin.limit; at += 1) {
    const route = routes[at % routes.length];
    const response = await worker.fetch(api(route.path, route), env);
    assert.equal(response.status, 200, `request ${at + 1} is served`);
  }

  assert.equal(calls.length, LIMITS.signin.limit, 'every served request reached the object');

  const refused = await worker.fetch(api(`/a/${ACCOUNT}/challenge`, { method: 'POST' }), env);

  assert.equal(refused.status, 429);
  assert.deepEqual(await refused.json(), { error: 'rate_limited' });
  assert.equal(refused.headers.get('retry-after'), '60');
  assert.equal(refused.headers.get('cache-control'), 'no-store');
  assert.equal(calls.length, LIMITS.signin.limit, 'the refused request never reaches the object');
});

test('a burst on the icon and title routes is refused before anything is fetched', async () => {
  const { env: limiters } = limits();
  const { env } = harness(limiters);
  let upstream = 0;

  await withFetch(
    async () => {
      upstream += 1;
      return upstreamMiss();
    },
    async () => {
      for (let at = 0; at < LIMITS.fetch.limit; at += 1) {
        const response = await worker.fetch(api(ICON.path, { headers: ICON.headers }), env);
        assert.notEqual(response.status, 429, `icon request ${at + 1} is served`);
      }

      const before = upstream;
      const refused = await worker.fetch(api(ICON.path, { headers: ICON.headers }), env);
      assert.equal(refused.status, 429);
      assert.equal(refused.headers.get('retry-after'), '10');
      assert.equal(upstream, before, 'the refused request fetched nothing');

      /* The title route is the same class and the same budget. */
      const title = await worker.fetch(api(TITLE.path, { headers: TITLE.headers }), env);
      assert.equal(title.status, 429);
      assert.equal(upstream, before, 'the refused title fetched nothing');
    }
  );
});

test('vault reads and writes are the cheapest class, counted apart from sign-in', async () => {
  const { env: limiters } = limits();
  const { env, calls } = harness(limiters);

  for (let at = 0; at < LIMITS.vault.limit; at += 1) {
    const response =
      at % 2 === 0
        ? await worker.fetch(
            api(`/a/${ACCOUNT}/vault`, { method: 'PUT', body: { baseVersion: 0 } }),
            env
          )
        : await worker.fetch(api(`/a/${ACCOUNT}/sessions`), env);
    assert.equal(response.status, 200, `vault request ${at + 1} is served`);
  }

  const refused = await worker.fetch(api(`/a/${ACCOUNT}/sessions`), env);
  assert.equal(refused.status, 429);
  assert.equal(calls.length, LIMITS.vault.limit);

  /* Its own budget is untouched, so a spent vault window does not lock a sign-in out. */
  const challenge = await worker.fetch(api(`/a/${ACCOUNT}/challenge`, { method: 'POST' }), env);
  assert.equal(challenge.status, 200);
});

test('the counter belongs to the source, so one spent caller leaves another served', async () => {
  const { env: limiters } = limits();
  const { env } = harness(limiters);

  for (let at = 0; at < LIMITS.signin.limit; at += 1) {
    await worker.fetch(api(`/a/${ACCOUNT}/challenge`, { method: 'POST' }), env);
  }

  const refused = await worker.fetch(api(`/a/${ACCOUNT}/challenge`, { method: 'POST' }), env);
  assert.equal(refused.status, 429);

  const other = await worker.fetch(
    api(`/a/${ACCOUNT}/challenge`, { method: 'POST', source: OTHER_SOURCE }),
    env
  );
  assert.equal(other.status, 200, 'a different address still has its own budget');
});

test('the counter is keyed by a digest of the class and the address, never the address', async () => {
  const { env: limiters, hits } = limits();
  const { env } = harness(limiters);

  await worker.fetch(api(`/a/${ACCOUNT}/challenge`, { method: 'POST' }), env);
  await withFetch(upstreamMiss, () =>
    worker.fetch(api(ICON.path, { headers: ICON.headers }), env)
  );
  await worker.fetch(api(`/a/${ACCOUNT}/challenge`, { method: 'POST', source: OTHER_SOURCE }), env);

  const expected = (className, address) =>
    createHash('sha256').update(`${className}\n${address}`).digest('base64url');

  assert.deepEqual(
    hits.map((hit) => hit.className),
    ['signin', 'fetch', 'signin'],
    'two callers asking for a challenge spend the same class once each'
  );

  for (const hit of hits) {
    assert.match(hit.key, /^[A-Za-z0-9_-]{43}$/, 'a base64url digest, not an address');
    assert.ok(!hit.key.includes(SOURCE) && !hit.key.includes(OTHER_SOURCE));
  }

  assert.equal(hits[0].key, expected('signin', SOURCE));
  assert.equal(hits[1].key, expected('fetch', SOURCE), 'the same address has a key per class');
  assert.equal(hits[2].key, expected('signin', OTHER_SOURCE));
  assert.notEqual(hits[0].key, hits[2].key);
});

test('a window that has passed is budget again', async () => {
  let at = 0;
  const { env: limiters } = limits(() => at);
  const { env } = harness(limiters);

  for (let request = 0; request < LIMITS.signin.limit; request += 1) {
    await worker.fetch(api(`/a/${ACCOUNT}/challenge`, { method: 'POST' }), env);
  }
  assert.equal(
    (await worker.fetch(api(`/a/${ACCOUNT}/challenge`, { method: 'POST' }), env)).status,
    429
  );

  /* One millisecond short of the minute, still spent. */
  at = LIMITS.signin.period * 1000 - 1;
  assert.equal(
    (await worker.fetch(api(`/a/${ACCOUNT}/challenge`, { method: 'POST' }), env)).status,
    429
  );

  at = LIMITS.signin.period * 1000;
  assert.equal(
    (await worker.fetch(api(`/a/${ACCOUNT}/challenge`, { method: 'POST' }), env)).status,
    200,
    'the next window serves the same source again'
  );
});

test('health is answered without a counter, and no class binding means nothing to enforce', async () => {
  const { env: limiters, hits } = limits();
  const { env } = harness(limiters);

  for (let at = 0; at < LIMITS.signin.limit + 5; at += 1) {
    const response = await worker.fetch(api('/health'), env);
    assert.equal(response.status, 200);
  }
  assert.deepEqual(hits, [], '/health spends nothing');

  /* A deployment without the bindings is unbounded rather than broken; scripts/check.mjs is
     what refuses that state in the configuration a deploy would ship. */
  const unbounded = harness();
  for (let at = 0; at < LIMITS.signin.limit + 5; at += 1) {
    const response = await worker.fetch(api(`/a/${ACCOUNT}/challenge`, { method: 'POST' }), unbounded.env);
    assert.equal(response.status, 200);
  }
});
