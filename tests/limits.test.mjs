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

import worker, { FETCH_CEILING, LIMITS } from '../src/index.js';
import { quiet } from './logs.mjs';
import { withFetch } from './dns.mjs';

/* The refusals here are about the counter, not the line the refusal writes. */
quiet();

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

/**
 * The same harness with the Registry the Worker asks before it names an object.
 *
 * Its answer is the one that costs nothing either way — no account, room to make one — so what
 * the tests count is how often the question itself is put, not what it decided.
 */
function withRegistry(env) {
  const asked = [];
  env.REGISTRY = {
    idFromName: (name) => ({ name }),
    get: (id) => ({
      fetch: async (request) => {
        asked.push({ name: id.name, account: new URL(request.url).searchParams.get('account') });
        return new Response(JSON.stringify({ exists: false, room: true }), {
          headers: { 'content-type': 'application/json' }
        });
      }
    })
  };
  return asked;
}

function api(path, { method = 'GET', source = SOURCE, body, headers = {} } = {}) {
  return new Request(`https://bookmarks.332321.xyz/api${path}`, {
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

test('a stylesheet request is an asset request, so it spends no fetch budget', async () => {
  const { env: limiters } = limits();
  const { env } = harness(limiters);
  let upstream = 0;

  await withFetch(
    async () => {
      upstream += 1;
      return upstreamMiss();
    },
    async () => {
      const sheet = new Request('https://bookmarks.332321.xyz/css/tokens.css', {
        headers: { 'cf-connecting-ip': SOURCE }
      });

      /* The two stylesheets are the app's own files. An asset request costs nothing against the
         outbound budget, so a page load cannot be throttled by its own stylesheet and the whole
         budget is still there for the one route that does leave this origin. */
      for (let at = 0; at < LIMITS.fetch.limit; at += 1) {
        const response = await worker.fetch(sheet, env);
        assert.equal(response.status, 200, `stylesheet request ${at + 1} is served`);
      }

      assert.equal(upstream, 0, 'no stylesheet request fetched another origin');

      const icon = await worker.fetch(api(ICON.path, { headers: ICON.headers }), env);
      assert.equal(icon.status, 404, 'the icon route still has its whole budget');
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

test('one IPv6 allocation is one source, because a /64 is what an allocation gets', async () => {
  const { env: limiters } = limits();
  const { env } = harness(limiters);
  const first = '2606:4700:4700:0:1:2:3:4';
  const sameGroup = '2606:4700:4700:0:ffff::1';
  const elsewhere = '2606:4700:4701::1';

  await withFetch(upstreamMiss, async () => {
    for (let at = 0; at < LIMITS.fetch.limit; at += 1) {
      const response = await worker.fetch(
        api(ICON.path, { headers: ICON.headers, source: first }),
        env
      );
      assert.notEqual(response.status, 429, `request ${at + 1} from the first address`);
    }

    const shared = await worker.fetch(
      api(ICON.path, { headers: ICON.headers, source: sameGroup }),
      env
    );
    assert.equal(shared.status, 429, 'another address in the same /64 has spent that budget');

    const other = await worker.fetch(
      api(ICON.path, { headers: ICON.headers, source: elsewhere }),
      env
    );
    assert.notEqual(other.status, 429, 'a different /64 is a different source');
  });
});

test('one ceiling bounds every outbound fetch, whatever source asks', async () => {
  const { env: limiters } = limits();
  const seen = new Map();
  const { env } = harness({
    ...limiters,
    [FETCH_CEILING.binding]: {
      async limit({ key }) {
        const count = (seen.get(key) ?? 0) + 1;
        seen.set(key, count);
        return { success: count <= FETCH_CEILING.limit };
      }
    }
  });

  let upstream = 0;
  await withFetch(
    async () => {
      upstream += 1;
      return upstreamMiss();
    },
    async () => {
      /* A fresh address for every request, so no per-source budget is ever spent: only the
         counter every source shares can refuse one. */
      const source = (index) => `198.18.${Math.floor(index / 256)}.${index % 256}`;

      for (let at = 0; at < FETCH_CEILING.limit; at += 1) {
        const response = await worker.fetch(
          api(ICON.path, { headers: ICON.headers, source: source(at) }),
          env
        );
        assert.notEqual(response.status, 429, `request ${at + 1} is served`);
      }

      const before = upstream;
      const refused = await worker.fetch(
        api(ICON.path, { headers: ICON.headers, source: source(FETCH_CEILING.limit) }),
        env
      );
      assert.equal(refused.status, 429, 'the ceiling refuses a source with its own budget intact');
      assert.equal(refused.headers.get('retry-after'), String(FETCH_CEILING.period));
      assert.equal(upstream, before, 'the refused request fetched nothing');
    }
  );
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

test('deleting spends the sign-in budget, and ending a place spends the vault budget', async () => {
  const { env: limiters } = limits();
  const { env } = harness(limiters);

  /* The deletion is a proof of the phrase, so it is counted with the routes that check one. */
  for (let at = 0; at < LIMITS.signin.limit; at += 1) {
    const response = await worker.fetch(api(`/a/${ACCOUNT}/delete`, { method: 'POST', body: {} }), env);
    assert.equal(response.status, 200, `deletion ${at + 1} is served`);
  }
  const signinSpent = await worker.fetch(
    api(`/a/${ACCOUNT}/delete`, { method: 'POST', body: {} }),
    env
  );
  assert.equal(signinSpent.status, 429);
  assert.equal(signinSpent.headers.get('retry-after'), '60');

  /* A whole family named by an id is the same one budget: `/sessions` is the vault class. */
  for (let at = 0; at < LIMITS.vault.limit; at += 1) {
    const response = await worker.fetch(
      api(`/a/${ACCOUNT}/sessions/ABCDEFGHIJK`, { method: 'DELETE' }),
      env
    );
    assert.equal(response.status, 200, `place ${at + 1} is served`);
  }
  const vaultSpent = await worker.fetch(
    api(`/a/${ACCOUNT}/sessions/ABCDEFGHIJK`, { method: 'DELETE' }),
    env
  );
  assert.equal(vaultSpent.status, 429);
  assert.equal(vaultSpent.headers.get('retry-after'), '60');

  /* The two classes are apart: a spent sign-in budget does not take the place list with it. */
  const stillListed = await worker.fetch(api(`/a/${ACCOUNT}/sessions`), env);
  assert.equal(stillListed.status, 429, 'the same vault class is spent, as documented');
  const challenge = await worker.fetch(api(`/a/${ACCOUNT}/challenge`, { method: 'POST' }), env);
  assert.equal(challenge.status, 429, 'the sign-in class is spent by the deletions');
});

/**
 * The Registry is one object for the whole service, and every account path is put to it before
 * an object is named. That question is therefore part of the cost of a request: a caller whose
 * class is spent must be refused before it is asked, and a path no route answers must not be
 * worth asking for at all.
 */
test('a caller over its budget asks the registry nothing', async () => {
  const { env: limiters } = limits();
  const { env, calls } = harness(limiters);
  const asked = withRegistry(env);

  /* No account answers to this id, so each served request is a 404 and stops at the registry. */
  for (let at = 0; at < LIMITS.signin.limit; at += 1) {
    const response = await worker.fetch(
      api(`/a/${ACCOUNT}/login`, { method: 'POST', body: { proof: 'a' } }),
      env
    );
    assert.equal(response.status, 404, `request ${at + 1} is served`);
  }
  assert.equal(asked.length, LIMITS.signin.limit, 'each served request was put to the registry');
  assert.equal(calls.length, 0, 'and none of them named an object');

  const refused = await worker.fetch(
    api(`/a/${ACCOUNT}/login`, { method: 'POST', body: { proof: 'a' } }),
    env
  );
  assert.equal(refused.status, 429);
  assert.equal(refused.headers.get('retry-after'), '60');
  assert.equal(asked.length, LIMITS.signin.limit, 'the refused request asked nothing');
  assert.equal(calls.length, 0, 'the refused request named nothing');
});

test('an account path no route answers is a 404 without asking the registry', async () => {
  const { env: limiters } = limits();
  const { env, calls } = harness(limiters);
  const asked = withRegistry(env);

  for (const path of [`/a/${ACCOUNT}/nothing`, `/a/${ACCOUNT}/admin-list`]) {
    const response = await worker.fetch(api(path), env);
    assert.equal(response.status, 404, path);
    assert.deepEqual(await response.json(), { error: 'not_found' }, path);
  }

  assert.equal(asked.length, 0, 'a path the object cannot answer is not worth a registry question');
  assert.equal(calls.length, 0, 'and it is not forwarded to the object either');
});
