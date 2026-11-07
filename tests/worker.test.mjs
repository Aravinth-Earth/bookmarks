/**
 * The Worker's own routing: the provisioning gate, the account path, and the asset passthrough.
 *
 * The Durable Object has its own tests; this file covers the layer in front of it — in
 * particular that `/api/accounts` cannot be reached without the provisioning token, because
 * that one route is the difference between "one account" and "free anonymous storage".
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import worker from '../src/index.js';

const ACCOUNT = 'TcDVkYwhQ4qi7lOyIR8OdQ';
const TOKEN = 'provision-secret';

function harness({ doStatus = 201, doBody = { ok: true } } = {}) {
  const calls = [];
  const env = {
    PROVISION_TOKEN: TOKEN,
    VAULTS: {
      idFromName: (name) => ({ name }),
      get: (id) => ({
        fetch: async (request) => {
          const body = request.method === 'GET' ? null : await request.clone().text();
          calls.push({
            name: id.name,
            path: new URL(request.url).pathname,
            method: request.method,
            body
          });
          return new Response(JSON.stringify(doBody), {
            status: doStatus,
            headers: { 'content-type': 'application/json' }
          });
        }
      })
    },
    ASSETS: {
      fetch: async () =>
        new Response('<!doctype html><title>app</title>', {
          headers: { 'content-type': 'text/html' }
        })
    }
  };
  return { env, calls };
}

function api(path, options = {}) {
  return new Request(`https://www.332321.xyz/w/bookmarks/api${path}`, options);
}

function provision(body, token) {
  return api('/accounts', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify(body)
  });
}

const VALID_ACCOUNT = {
  accountId: ACCOUNT,
  authSecret: 'Gaos_uER3VT3TFbI_q_8gbDYdAEp3q3CSviR6cONsA4'
};

test('health answers without any credential', async () => {
  const response = await worker.fetch(api('/health'), harness().env);
  assert.equal(response.status, 200);

  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(typeof body.version, 'string');
});

test('account creation is closed without the provisioning token', async () => {
  for (const token of [null, 'wrong-token', '']) {
    const { env, calls } = harness();
    const response = await worker.fetch(provision(VALID_ACCOUNT, token), env);

    assert.equal(response.status, 401, `token ${JSON.stringify(token)}`);
    assert.equal(calls.length, 0, 'nothing reaches the Durable Object');
  }
});

test('the provisioning token is compared whole, not as a prefix', async () => {
  const { env, calls } = harness();
  const response = await worker.fetch(provision(VALID_ACCOUNT, TOKEN.slice(0, 8)), env);

  assert.equal(response.status, 401);
  assert.equal(calls.length, 0);
});

test('a malformed provisioning body is refused before the object is called', async () => {
  for (const body of [
    {},
    { accountId: 'short', authSecret: VALID_ACCOUNT.authSecret },
    { accountId: ACCOUNT, authSecret: 42 }
  ]) {
    const { env, calls } = harness();
    const response = await worker.fetch(provision(body, TOKEN), env);
    assert.equal(response.status, 400, JSON.stringify(body).slice(0, 60));
    assert.equal(calls.length, 0);
  }
});

test('a valid provisioning call reaches the named object at /account', async () => {
  const { env, calls } = harness();
  const response = await worker.fetch(provision(VALID_ACCOUNT, TOKEN), env);

  assert.equal(response.status, 201);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, ACCOUNT);
  assert.equal(calls[0].path, '/account');
  assert.equal(calls[0].method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].body), VALID_ACCOUNT);
});

test('account paths are forwarded to that account and nothing else', async () => {
  const { env, calls } = harness({ doStatus: 200, doBody: { nonce: 'abc' } });
  const response = await worker.fetch(api(`/a/${ACCOUNT}/challenge`, { method: 'POST' }), env);

  assert.equal(response.status, 200);
  assert.equal(calls[0].name, ACCOUNT);
  assert.equal(calls[0].path, '/challenge');
});

test('an account path with a malformed id is refused before dispatch', async () => {
  for (const path of ['/a/nope/challenge', '/a/short/vault', `/a/${ACCOUNT}`]) {
    const { env, calls } = harness();
    const response = await worker.fetch(api(path), env);
    assert.ok(response.status === 400 || response.status === 404, `${path} -> ${response.status}`);
    assert.equal(calls.length, 0, path);
  }
});

test('an unknown API path is a 404', async () => {
  const response = await worker.fetch(api('/nothing'), harness().env);
  assert.equal(response.status, 404);
});

test('the app is served through the assets binding with the security headers', async () => {
  const response = await worker.fetch(
    new Request('https://www.332321.xyz/w/bookmarks/'),
    harness().env
  );

  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-security-policy'), /default-src 'self'/);
  assert.match(response.headers.get('content-security-policy'), /script-src 'self'/);
  assert.match(await response.text(), /title>app/);
});

test('the bare path redirects to the slashed one', async () => {
  const response = await worker.fetch(
    new Request('https://www.332321.xyz/w/bookmarks'),
    harness().env
  );

  assert.equal(response.status, 301);
  assert.equal(response.headers.get('location'), 'https://www.332321.xyz/w/bookmarks/');
});
