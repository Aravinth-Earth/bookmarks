/**
 * The client half of sync, against a stub server.
 *
 * These tests exist because the browser client and the Durable Object must agree on two shapes
 * that node's own tests cannot see: the `places` count in a login answer, and the place list
 * behind `/sessions`. A stub that answers by URL keeps that agreement checkable without a
 * Worker, a network or a browser.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { SyncClient, SyncError, clientKind } from '../public/w/bookmarks/sync.js';
import { deriveAccount } from '../public/w/bookmarks/crypto.js';
import { WORDLIST } from '../public/w/bookmarks/wordlist.js';

const ACCOUNT = await deriveAccount(WORDLIST.slice(0, 13).join(' '));

/** A fetch that answers from a table of `[status, body]` and records what it was asked. */
function stub(routes) {
  const calls = [];
  const fetch = async (url, options = {}) => {
    const path = new URL(url, 'https://example.test').pathname;
    calls.push({ path, method: options.method ?? 'GET', body: options.body, headers: options.headers });
    const route = routes[path];
    if (!route) return new Response('{}', { status: 404 });
    const [status, payload] = route;
    return new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json' }
    });
  };
  return { fetch, calls };
}

test('the device kind is one word, and unknown when it cannot be told', () => {
  assert.ok(['mobile', 'desktop', 'unknown'].includes(clientKind()));
  /* No matchMedia in node, so this is also the branch that must not throw. */
  assert.equal(clientKind(), 'unknown');
});

test('an account that was never created answers false, not an error', async () => {
  const missing = stub({});
  const client = new SyncClient({ fetch: missing.fetch });
  assert.equal(await client.accountExists(ACCOUNT.accountId), false);

  const existing = stub({
    [`/w/bookmarks/api/a/${ACCOUNT.accountId}/challenge`]: [200, { nonce: 'n' }]
  });
  assert.equal(await new SyncClient({ fetch: existing.fetch }).accountExists(ACCOUNT.accountId), true);
});

test('a server that cannot answer is an error, not "no vault"', async () => {
  const broken = stub({ [`/w/bookmarks/api/a/${ACCOUNT.accountId}/challenge`]: [500, { error: 'x' }] });
  await assert.rejects(
    () => new SyncClient({ fetch: broken.fetch }).accountExists(ACCOUNT.accountId),
    (error) => error instanceof SyncError && error.code === 'CHALLENGE_FAILED'
  );
});

test('signing in says which kind of device this is', async () => {
  const base = '/w/bookmarks/api/a/';
  const { fetch, calls } = stub({
    [`${base}${ACCOUNT.accountId}/challenge`]: [200, { nonce: 'nonce-value' }],
    [`${base}${ACCOUNT.accountId}/login`]: [200, { token: 't'.repeat(43), plan: 'owner', units: 100, places: 2 }]
  });

  const client = new SyncClient({ fetch });
  const session = await client.login(ACCOUNT.accountId, ACCOUNT.authSecret);

  assert.equal(session.places, 2);
  const sent = JSON.parse(calls.at(-1).body);
  assert.equal(typeof sent.proof, 'string');
  assert.equal(sent.client, clientKind());
});

test('the place list needs a session and is read with the token', async () => {
  const base = '/w/bookmarks/api/a/';
  const payload = { count: 1, sessions: [{ client: 'desktop', current: true, createdAt: 1, lastSeenAt: 2, expiresAt: 3 }] };
  const { fetch, calls } = stub({ [`${base}${ACCOUNT.accountId}/sessions`]: [200, payload] });

  const client = new SyncClient({ fetch });
  await assert.rejects(
    () => client.sessions(),
    (error) => error instanceof SyncError && error.code === 'UNAUTHORIZED'
  );

  client.token = 'x'.repeat(43);
  client.accountId = ACCOUNT.accountId;
  const places = await client.sessions();

  assert.deepEqual(places, payload);
  assert.equal(calls.at(-1).headers.authorization, `Bearer ${'x'.repeat(43)}`);
});

test('an expired session drops the token instead of retrying with it', async () => {
  const base = '/w/bookmarks/api/a/';
  const { fetch } = stub({ [`${base}${ACCOUNT.accountId}/sessions`]: [401, { error: 'unauthorized' }] });

  const client = new SyncClient({ fetch });
  client.token = 'y'.repeat(43);
  client.accountId = ACCOUNT.accountId;

  await assert.rejects(
    () => client.sessions(),
    (error) => error instanceof SyncError && error.code === 'UNAUTHORIZED'
  );
  assert.equal(client.token, null);
});
