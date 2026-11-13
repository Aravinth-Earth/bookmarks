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

import { describeSyncFailure, SyncClient, SyncError, clientKind } from '../public/w/bookmarks/sync.js';
import { deriveAccount, proveAuth } from '../public/w/bookmarks/crypto.js';
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

/** Swap the global fetch for the length of one check, and put it back even when the check throws. */
async function withFetch(fetch, run) {
  const original = globalThis.fetch;
  globalThis.fetch = fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

/**
 * A creation route in the shape the real one has: the first request is answered 428 with a
 * nonce, the proof-carrying second one is answered by whatever the test wants. Bodies are kept
 * so a test can read what the invite field actually looked like on the wire.
 */
function creationServer({ proofStatus = 201, proofBody = { ok: true, created: true }, nonce = 'nonce-value' } = {}) {
  const bodies = [];
  const fetch = async (_url, options = {}) => {
    const body = JSON.parse(options.body);
    bodies.push(body);
    const headers = { 'content-type': 'application/json' };
    if (body.proof === undefined) {
      return new Response(JSON.stringify({ error: 'proof_required', nonce }), { status: 428, headers });
    }
    return new Response(JSON.stringify(proofBody), { status: proofStatus, headers });
  };
  return { fetch, bodies };
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

test('registering asks for a nonce, proves the secret and resends', async () => {
  const nonce = 'nonce-value';
  const calls = [];
  const fetch = async (_url, options = {}) => {
    const body = JSON.parse(options.body);
    calls.push(body);
    const headers = { 'content-type': 'application/json' };

    if (body.proof === undefined) {
      return new Response(
        JSON.stringify({ error: 'proof_required', nonce, expiresAt: 2_000 }),
        { status: 428, headers }
      );
    }
    return new Response(JSON.stringify({ ok: true, created: true }), { status: 201, headers });
  };

  const result = await new SyncClient({ fetch }).register(ACCOUNT.accountId, ACCOUNT.authSecret);

  assert.deepEqual(result, { created: true });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].proof, undefined, 'the first request writes nothing');
  assert.equal(
    calls[1].proof,
    await proveAuth(ACCOUNT.authSecret, ACCOUNT.accountId, nonce),
    'the proof signs the server nonce with the account secret'
  );
});

test('a creation of an account that already exists is success, not a second account', async () => {
  let at = 0;
  const fetch = async () => {
    at += 1;
    const headers = { 'content-type': 'application/json' };
    if (at === 1) {
      return new Response(JSON.stringify({ error: 'proof_required', nonce: 'n', expiresAt: 2_000 }), {
        status: 428,
        headers
      });
    }
    return new Response(JSON.stringify({ ok: true, created: false }), { status: 200, headers });
  };

  const result = await new SyncClient({ fetch }).register(ACCOUNT.accountId, ACCOUNT.authSecret);
  assert.deepEqual(result, { created: false });
});

test('a proof that arrived after its nonce was replaced is retried once', async () => {
  const nonces = ['first', 'second'];
  let at = 0;
  const proofs = [];
  const fetch = async (_url, options = {}) => {
    const body = JSON.parse(options.body);
    const headers = { 'content-type': 'application/json' };
    if (body.proof === undefined) {
      const nonce = nonces[at];
      return new Response(JSON.stringify({ error: 'proof_required', nonce, expiresAt: 2_000 }), {
        status: 428,
        headers
      });
    }
    proofs.push(body.proof);
    if (at === 0) {
      at = 1;
      return new Response(JSON.stringify({ error: 'bad_proof' }), { status: 401, headers });
    }
    return new Response(JSON.stringify({ ok: true, created: true }), { status: 201, headers });
  };

  const result = await new SyncClient({ fetch }).register(ACCOUNT.accountId, ACCOUNT.authSecret);

  assert.deepEqual(result, { created: true });
  assert.equal(proofs.length, 2);
  assert.notEqual(proofs[0], proofs[1], 'the retry signs the fresh nonce');
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

test('the invite code rides on both creation requests', async () => {
  const server = creationServer();

  /* The client is built inside the swap: its default fetch is bound at construction time. */
  const result = await withFetch(server.fetch, () =>
    new SyncClient().register(ACCOUNT.accountId, ACCOUNT.authSecret, 'a-friend-code')
  );

  assert.deepEqual(result, { created: true });
  assert.equal(server.bodies.length, 2);
  assert.equal(server.bodies[0].invite, 'a-friend-code', 'the challenge request carries the code');
  assert.equal(server.bodies[1].invite, 'a-friend-code', 'the proof request carries it again');
});

test('an invite nobody typed is sent as an empty string, never left undefined', async () => {
  const server = creationServer();

  const results = await withFetch(server.fetch, async () => {
    const client = new SyncClient();
    const viaRegister = await client.register(ACCOUNT.accountId, ACCOUNT.authSecret);
    /* registerOnce is the same round trip without the retry loop, and owns the same default. */
    const viaRegisterOnce = await client.registerOnce(ACCOUNT.accountId, ACCOUNT.authSecret);
    return [viaRegister, viaRegisterOnce];
  });

  assert.deepEqual(results, [{ created: true }, { created: true }]);
  assert.equal(server.bodies.length, 4);
  for (const body of server.bodies) {
    assert.ok('invite' in body, 'the field is present even when empty');
    assert.equal(body.invite, '', 'an empty code is an empty string, not undefined');
  }
});

/* Each way a code can be turned down, with the sentence the person is owed for it. */
const INVITE_REFUSALS = [
  [403, 'invite_required', 'INVITE_REQUIRED', 'This server needs an invite code to create an account.'],
  [422, 'invite_used', 'INVITE_USED', 'That invite code has already been used.'],
  [410, 'invite_expired', 'INVITE_EXPIRED', 'That invite code has expired.']
];

for (const [status, serverError, code, message] of INVITE_REFUSALS) {
  test(`an invite refused with ${status} reads as ${code}`, async () => {
    /* The registry only decides about the code after the proof checks out, so the refusal lands
       on the second request — the same place the real route puts it. */
    const server = creationServer({ proofStatus: status, proofBody: { error: serverError } });

    await withFetch(server.fetch, async () => {
      await assert.rejects(
        () => new SyncClient().register(ACCOUNT.accountId, ACCOUNT.authSecret, 'a-friend-code'),
        (error) => {
          assert.ok(error instanceof SyncError);
          assert.equal(error.code, code);
          assert.equal(error.message, message);
          assert.equal(error.status, status);
          return true;
        }
      );
    });

    assert.equal(server.bodies.at(-1).invite, 'a-friend-code', 'the refused proof still carried the code');
  });
}

test('a full server still reads as FULL, whichever request says so', async () => {
  const headers = { 'content-type': 'application/json' };
  const alwaysFull = async () =>
    new Response(JSON.stringify({ error: 'full' }), { status: 429, headers });

  await withFetch(alwaysFull, async () => {
    await assert.rejects(
      () => new SyncClient().register(ACCOUNT.accountId, ACCOUNT.authSecret, 'a-friend-code'),
      (error) =>
        error instanceof SyncError &&
        error.code === 'FULL' &&
        error.message === 'This server is not accepting new vaults.'
    );
  });

  const fullOnProof = creationServer({ proofStatus: 429, proofBody: { error: 'full' } });
  await withFetch(fullOnProof.fetch, async () => {
    await assert.rejects(
      () => new SyncClient().register(ACCOUNT.accountId, ACCOUNT.authSecret, 'a-friend-code'),
      (error) =>
        error instanceof SyncError &&
        error.code === 'FULL' &&
        error.message === 'This server is not accepting new vaults.'
    );
  });
});

test('an account that already exists still answers created:false', async () => {
  const alreadyExists = async () =>
    new Response(JSON.stringify({ ok: true, created: false }), {
      status: 409,
      headers: { 'content-type': 'application/json' }
    });

  const result = await withFetch(alreadyExists, () =>
    new SyncClient().register(ACCOUNT.accountId, ACCOUNT.authSecret, 'a-friend-code')
  );

  assert.deepEqual(result, { created: false });
});

test('each invite failure tells the person what to do about it', () => {
  assert.deepEqual(describeSyncFailure(new SyncError('INVITE_REQUIRED', 'ignored')), {
    kind: 'invite',
    label: 'Invite needed',
    message: 'This server needs an invite code to create an account.'
  });
  assert.deepEqual(describeSyncFailure(new SyncError('INVITE_USED', 'ignored')), {
    kind: 'invite',
    label: 'Invite used',
    message: 'That invite code has already been used.'
  });
  assert.deepEqual(describeSyncFailure(new SyncError('INVITE_EXPIRED', 'ignored')), {
    kind: 'invite',
    label: 'Invite expired',
    message: 'That invite code has expired.'
  });
});
