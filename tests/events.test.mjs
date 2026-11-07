/**
 * The event lines.
 *
 * Observability is on for this Worker, so a refused sign-in, a lockout, a refused creation, a
 * rate-limit refusal, a blocked proxy fetch and an exception at the boundary each have to leave
 * a line. What is tested here is that each one does, that the fields are the documented ones,
 * and that nothing identifying the account, the caller or the secret is ever in the output.
 *
 * The lines are read the way the platform reads them: `console.log` is captured around the
 * requests that cause them. The vault harness is the one from vault-object.test.mjs, cut down
 * to what these events need, with the clock injectable so a lockout needs no waiting.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import worker, { LIMITS } from '../src/index.js';
import { ACCOUNT_REF_HEX, accountRef, logEvent } from '../src/events.js';
import { Vault } from '../src/vault.js';
import { deriveAccount, proveAuth } from '../public/w/bookmarks/crypto.js';
import { WORDLIST } from '../public/w/bookmarks/wordlist.js';
import { parsed, withEvents } from './logs.mjs';

const PHRASE = WORDLIST.slice(0, 13).join(' ');
const ACCOUNT = await deriveAccount(PHRASE);
/* The only field an account may appear as: the prefix of its digest, never the id. */
const REF = createHash('sha256').update(ACCOUNT.accountId).digest('hex').slice(0, ACCOUNT_REF_HEX);
const SOURCE = '203.0.113.7';
const FIELDS = new Set(['event', 'route', 'reason', 'account', 'retry_after']);

/* --------------------------------------------------------------- the helper itself */

test('one event is one JSON line, with the account as a digest prefix', async () => {
  const { result, lines } = await withEvents(() =>
    logEvent('signin_failed', {
      route: 'signin',
      reason: 'bad_proof',
      account: ACCOUNT.accountId
    })
  );

  assert.equal(result, undefined, 'the helper returns nothing');
  assert.equal(lines.length, 1, 'one line');
  assert.equal(lines[0].includes('\n'), false, 'and no newline inside it');

  assert.deepEqual(JSON.parse(lines[0]), {
    event: 'signin_failed',
    route: 'signin',
    reason: 'bad_proof',
    account: REF
  });
  assert.equal(REF.length, ACCOUNT_REF_HEX);
  assert.notEqual(REF, ACCOUNT.accountId);
  assert.equal(await accountRef(ACCOUNT.accountId), REF, 'the same account always gets one handle');
});

test('the sink can be injected, so a caller need not write to the console', async () => {
  const collected = [];
  const { lines } = await withEvents(() =>
    logEvent('proxy_refused', { route: 'fetch', reason: 'blocked_host' }, (line) =>
      collected.push(line)
    )
  );

  assert.deepEqual(lines, [], 'nothing reached the console');
  assert.deepEqual(JSON.parse(collected[0]), {
    event: 'proxy_refused',
    route: 'fetch',
    reason: 'blocked_host'
  });
});

test('only fixed codes and whole seconds are written; other fields are dropped', async () => {
  const { lines } = await withEvents(() =>
    logEvent('rate_limited', {
      route: 'signin',
      reason: 'over_limit',
      retry_after: 60,
      address: SOURCE,
      path: `/${ACCOUNT.accountId}`,
      token: ACCOUNT.authSecret
    })
  );

  const line = JSON.parse(lines[0]);
  assert.deepEqual(Object.keys(line).sort(), ['event', 'reason', 'retry_after', 'route']);
  assert.equal(line.address, undefined);
  assert.equal(line.path, undefined);
  assert.equal(line.token, undefined);
});

/* -------------------------------------------------------------- the account object */

function storage() {
  const map = new Map();
  return {
    async get(key) {
      const value = map.get(key);
      return value === undefined ? undefined : structuredClone(value);
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
    async setAlarm() {},
    async deleteAll() {
      map.clear();
    }
  };
}

/** One account object, with a registry whose answer can be switched to "full". */
function vaultObject({ full = false, name = ACCOUNT.accountId } = {}) {
  const ctx = { storage: storage(), id: { name } };
  let atCap = full;
  const env = {
    REGISTRY: {
      idFromName: (registryName) => ({ name: registryName }),
      get: () => ({
        fetch: async () =>
          new Response(JSON.stringify(atCap ? { error: 'full' } : { ok: true }), {
            status: atCap ? 429 : 200,
            headers: { 'content-type': 'application/json' }
          })
      })
    }
  };

  let clock = 1_000_000;
  const vault = new Vault(ctx, env, { now: () => clock });

  return {
    vault,
    setFull(value) {
      atCap = value;
    },
    advance(ms) {
      clock += ms;
    }
  };
}

function vaultRequest(path, body) {
  return new Request(`https://vault${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

async function read(response) {
  return { status: response.status, body: await response.json() };
}

/** The blind creation request, which answers the nonce the proof signs. */
async function blind(vault, authSecret = ACCOUNT.authSecret) {
  return read(
    await vault.fetch(vaultRequest('/account', { accountId: ACCOUNT.accountId, authSecret }))
  );
}

async function provision(harness) {
  const challenge = await blind(harness.vault);
  assert.equal(challenge.status, 428);

  const proof = await proveAuth(ACCOUNT.authSecret, ACCOUNT.accountId, challenge.body.nonce);
  const created = await read(
    await harness.vault.fetch(
      vaultRequest('/account', {
        accountId: ACCOUNT.accountId,
        authSecret: ACCOUNT.authSecret,
        proof
      })
    )
  );
  assert.equal(created.status, 201);
}

/** A challenge and one wrong proof against it: a sign-in that is refused. */
async function failedLogin(harness) {
  const challenge = await read(await harness.vault.fetch(vaultRequest('/challenge')));
  assert.equal(challenge.status, 200);
  return read(await harness.vault.fetch(vaultRequest('/login', { proof: 'x'.repeat(43) })));
}

test('a failed sign-in writes signin_failed with the reason the object distinguished', async () => {
  const harness = vaultObject();
  await provision(harness);

  const { result, lines } = await withEvents(() => failedLogin(harness));

  assert.equal(result.status, 401);
  assert.deepEqual(result.body, { error: 'bad_proof' });
  assert.deepEqual(parsed(lines), [
    { event: 'signin_failed', route: 'signin', reason: 'bad_proof', account: REF }
  ]);
});

test('a sign-in with no live nonce writes signin_failed challenge_expired', async () => {
  const harness = vaultObject();
  await provision(harness);

  const { result, lines } = await withEvents(async () =>
    read(await harness.vault.fetch(vaultRequest('/login', { proof: 'x'.repeat(43) })))
  );
  assert.equal(result.status, 401);
  assert.deepEqual(result.body, { error: 'challenge_expired' });
  assert.deepEqual(parsed(lines), [
    { event: 'signin_failed', route: 'signin', reason: 'challenge_expired', account: REF }
  ]);
});

test('the fifth failure locks the account, and the refusal that reads the lock writes the window', async () => {
  const harness = vaultObject();
  await provision(harness);

  const { result, lines } = await withEvents(async () => {
    for (let at = 0; at < 5; at += 1) {
      const refused = await failedLogin(harness);
      assert.equal(refused.status, 401);
    }
    return failedLogin(harness);
  });

  assert.equal(result.status, 429);
  assert.equal(result.body.retryAfter, 15 * 60);

  const events = parsed(lines);
  assert.equal(events.length, 6, 'five failures and one lockout, one line each');
  for (const event of events.slice(0, 5)) {
    assert.deepEqual(event, {
      event: 'signin_failed',
      route: 'signin',
      reason: 'bad_proof',
      account: REF
    });
  }
  assert.deepEqual(events.at(-1), {
    event: 'signin_locked',
    route: 'signin',
    reason: 'locked',
    account: REF,
    retry_after: 900
  });
});

test('a creation refused at the cap writes create_refused cap_full', async () => {
  const harness = vaultObject({ full: true });
  const challenge = await blind(harness.vault);
  const proof = await proveAuth(ACCOUNT.authSecret, ACCOUNT.accountId, challenge.body.nonce);

  const { result, lines } = await withEvents(async () =>
    read(
      await harness.vault.fetch(
        vaultRequest('/account', {
          accountId: ACCOUNT.accountId,
          authSecret: ACCOUNT.authSecret,
          proof
        })
      )
    )
  );

  assert.equal(result.status, 429);
  assert.deepEqual(result.body, { error: 'full' });
  assert.deepEqual(parsed(lines), [
    { event: 'create_refused', route: 'signin', reason: 'cap_full', account: REF }
  ]);
});

test('a creation with a bad proof writes create_refused bad_proof', async () => {
  const harness = vaultObject();
  const challenge = await blind(harness.vault);
  assert.equal(challenge.status, 428);

  const { result, lines } = await withEvents(async () =>
    read(
      await harness.vault.fetch(
        vaultRequest('/account', {
          accountId: ACCOUNT.accountId,
          authSecret: ACCOUNT.authSecret,
          proof: 'x'.repeat(43)
        })
      )
    )
  );

  assert.equal(result.status, 401);
  assert.deepEqual(parsed(lines), [
    { event: 'create_refused', route: 'signin', reason: 'bad_proof', account: REF }
  ]);
});

test('a creation with a malformed body writes create_refused without an account', async () => {
  const harness = vaultObject();

  const { result, lines } = await withEvents(async () =>
    read(await harness.vault.fetch(vaultRequest('/account', { accountId: 'short' })))
  );

  assert.equal(result.status, 400);
  assert.deepEqual(parsed(lines), [
    { event: 'create_refused', route: 'signin', reason: 'invalid' }
  ]);
});

/* ------------------------------------------------------------------- the Worker */

function workerHarness({ refuse = [], throwOnObject = false } = {}) {
  const env = {
    VAULTS: {
      idFromName: (name) => ({ name }),
      get: () => ({
        fetch: async () => {
          if (throwOnObject) throw new Error('the object failed');
          return new Response(JSON.stringify({ ok: true }), {
            headers: { 'content-type': 'application/json' }
          });
        }
      })
    },
    ASSETS: { fetch: async () => new Response('<!doctype html><title>app</title>') }
  };

  for (const [className, rule] of Object.entries(LIMITS)) {
    env[rule.binding] = { async limit() { return { success: !refuse.includes(className) }; } };
  }

  return env;
}

function api(path, { method = 'GET', body, headers = {}, source = SOURCE } = {}) {
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

async function withFetch(implementation, run) {
  const original = globalThis.fetch;
  globalThis.fetch = implementation;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

const HOST = 'example.com';
const HOST_HASH = createHash('sha256').update(HOST).digest('base64url');

test('a refusal over a class ceiling names the class and its window, and answers unchanged', async () => {
  const env = workerHarness({ refuse: ['signin', 'fetch', 'vault'] });

  const { result, lines } = await withEvents(async () => {
    const signin = await worker.fetch(
      api(`/a/${ACCOUNT.accountId}/challenge`, { method: 'POST' }),
      env
    );
    const icon = await worker.fetch(
      api(`/icon?h=${HOST_HASH}`, { headers: { 'x-icon-host': HOST } }),
      env
    );
    const vault = await worker.fetch(api(`/a/${ACCOUNT.accountId}/vault`), env);
    return { signin, icon, vault };
  });

  for (const response of Object.values(result)) {
    assert.equal(response.status, 429);
    assert.deepEqual(await response.json(), { error: 'rate_limited' });
  }
  assert.equal(result.signin.headers.get('retry-after'), '60');
  assert.equal(result.icon.headers.get('retry-after'), '10');
  assert.equal(result.vault.headers.get('retry-after'), '60');

  assert.deepEqual(parsed(lines), [
    { event: 'rate_limited', route: 'signin', reason: 'over_limit', retry_after: 60 },
    { event: 'rate_limited', route: 'fetch', reason: 'over_limit', retry_after: 10 },
    { event: 'rate_limited', route: 'vault', reason: 'over_limit', retry_after: 60 }
  ]);
});

test('a served request writes no line at all', async () => {
  const env = workerHarness();

  const { result, lines } = await withEvents(async () => {
    const health = await worker.fetch(api('/health'), env);
    const challenge = await worker.fetch(
      api(`/a/${ACCOUNT.accountId}/challenge`, { method: 'POST' }),
      env
    );
    const icon = await withFetch(
      async () =>
        new Response(new Uint8Array([0x89]), { headers: { 'content-type': 'image/png' } }),
      () => worker.fetch(api(`/icon?h=${HOST_HASH}`, { headers: { 'x-icon-host': HOST } }), env)
    );
    return { health, challenge, icon };
  });

  assert.deepEqual(
    Object.values(result).map((response) => response.status),
    [200, 200, 200]
  );
  assert.deepEqual(lines, [], 'the volume follows the refusal, not the traffic');
});

test('a proxy refusal names the route and the reason, never the host', async () => {
  const env = workerHarness();
  const blocked = 'printer.local';
  const blockedHash = createHash('sha256').update(blocked).digest('base64url');

  const { result, lines } = await withEvents(async () => {
    const icon = await worker.fetch(
      api(`/icon?h=${blockedHash}`, { headers: { 'x-icon-host': blocked } }),
      env
    );
    const title = await worker.fetch(
      api(`/title?h=${HOST_HASH}`, { headers: { 'x-page-host': 'localhost' } }),
      env
    );
    return { icon, title };
  });

  assert.equal(result.icon.status, 400);
  assert.deepEqual(await result.icon.json(), { error: 'blocked_host' });
  assert.equal(result.title.status, 400);
  assert.deepEqual(await result.title.json(), { error: 'bad_host' });

  assert.deepEqual(parsed(lines), [
    { event: 'proxy_refused', route: 'fetch', reason: 'blocked_host' },
    { event: 'proxy_refused', route: 'fetch', reason: 'bad_host' }
  ]);
  for (const line of lines) {
    assert.equal(line.includes(blocked), false, 'the host is not in the line');
    assert.equal(line.includes(SOURCE), false);
  }
});

test('a proxy fetch that times out writes proxy_refused timeout', async () => {
  const env = { ...workerHarness(), ICON_TIMEOUT_MS: '25' };
  const hangs = async (url, init) =>
    new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });

  const { result, lines } = await withEvents(async () => {
    const icon = await withFetch(hangs, () =>
      worker.fetch(api(`/icon?h=${HOST_HASH}`, { headers: { 'x-icon-host': HOST } }), env)
    );
    const title = await withFetch(hangs, () =>
      worker.fetch(api(`/title?h=${HOST_HASH}`, { headers: { 'x-page-host': HOST } }), env)
    );
    return { icon, title };
  });

  assert.equal(result.icon.status, 502, 'the icon route answers a timeout as a failure');
  assert.equal(result.title.status, 404, 'the title route answers it as no title');
  assert.deepEqual(await result.title.json(), { error: 'no_title' });

  assert.deepEqual(parsed(lines), [
    { event: 'proxy_refused', route: 'fetch', reason: 'timeout' },
    { event: 'proxy_refused', route: 'fetch', reason: 'timeout' }
  ]);
});

test('a proxy fetch that cannot connect writes proxy_refused fetch_failed', async () => {
  const env = workerHarness();

  const { result, lines } = await withEvents(() =>
    withFetch(
      async () => {
        throw new Error('network down');
      },
      () => worker.fetch(api(`/icon?h=${HOST_HASH}`, { headers: { 'x-icon-host': HOST } }), env)
    )
  );

  assert.equal(result.status, 502);
  assert.deepEqual(parsed(lines), [
    { event: 'proxy_refused', route: 'fetch', reason: 'fetch_failed' }
  ]);
});

test('an unhandled exception writes one server_error and keeps the same 500', async () => {
  const env = workerHarness({ throwOnObject: true });

  const { result, lines } = await withEvents(() =>
    worker.fetch(api(`/a/${ACCOUNT.accountId}/vault`, { method: 'PUT', body: { baseVersion: 0 } }), env)
  );

  assert.equal(result.status, 500);
  assert.deepEqual(await result.json(), { error: 'internal' });
  assert.deepEqual(parsed(lines), [
    { event: 'server_error', route: 'vault', reason: 'unhandled', account: REF }
  ]);
});

test('no line carries an account id, a secret, a token, a hostname or a raw address', async () => {
  const harness = vaultObject();
  await provision(harness);
  const env = workerHarness({ refuse: ['signin'] });
  const blockedHash = createHash('sha256').update('printer.local').digest('base64url');

  const { lines } = await withEvents(async () => {
    await failedLogin(harness);
    await worker.fetch(api(`/a/${ACCOUNT.accountId}/challenge`, { method: 'POST' }), env);
    await worker.fetch(
      api(`/icon?h=${blockedHash}`, { headers: { 'x-icon-host': 'printer.local' } }),
      env
    );
    const challenge = await read(await harness.vault.fetch(vaultRequest('/challenge')));
    const login = await read(
      await harness.vault.fetch(vaultRequest('/login', { proof: 'x'.repeat(43) }))
    );
    assert.equal(challenge.status, 200);
    assert.equal(login.status, 401);
  });

  assert.equal(lines.length, 4, 'two refusals from the object, one from the limit, one from the proxy');
  for (const line of lines) {
    const event = JSON.parse(line);
    for (const key of Object.keys(event)) {
      assert.ok(FIELDS.has(key), `unexpected field ${key}`);
    }
    if (event.account !== undefined) assert.match(event.account, /^[0-9a-f]{12}$/);

    assert.equal(line.includes(ACCOUNT.accountId), false, 'no account id');
    assert.equal(line.includes(ACCOUNT.authSecret), false, 'no auth secret');
    assert.equal(line.includes(PHRASE), false, 'no phrase');
    assert.equal(line.includes(SOURCE), false, 'no raw address');
    assert.equal(line.includes('printer.local'), false, 'no hostname');
    /* An account id is 22 characters and a secret or token 43; nothing that long may appear. */
    assert.doesNotMatch(line, /[A-Za-z0-9_-]{22}/, 'no identifier-shaped token');
  }
});
