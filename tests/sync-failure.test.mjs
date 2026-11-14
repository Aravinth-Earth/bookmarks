/**
 * How a failed sync is explained.
 *
 * The page shows one notice for a server that refuses a new account and another sentence for
 * every other failure, so this map is what keeps those cases from being told as the same event.
 * It is a pure function: the browser and these tests read the same answer.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { SyncClient, SyncError, describeSyncFailure } from '../public/sync.js';

test('a refused account is not the same failure as a wrong phrase, a lost connection or a missing account', () => {
  const failures = [
    describeSyncFailure(new SyncError('FULL', 'full', { status: 429 })),
    describeSyncFailure(new SyncError('LOGIN_FAILED', 'refused', { status: 401 })),
    describeSyncFailure(new TypeError('fetch failed')),
    describeSyncFailure(new SyncError('NO_ACCOUNT', 'missing', { status: 404 }))
  ];

  assert.deepEqual(
    failures.map((failure) => failure.kind),
    ['cap', 'phrase', 'network', 'missing']
  );

  const messages = failures.map((failure) => failure.message).filter(Boolean);
  assert.equal(new Set(messages).size, messages.length, 'the four sentences must differ');
});

test('the cap notice carries no alarm and no server vocabulary', () => {
  const failure = describeSyncFailure(new SyncError('FULL', 'full', { status: 429 }));

  assert.equal(failure.kind, 'cap');
  /* The sentence with the address lives in the page; the status line only labels the state. */
  assert.equal(failure.message, undefined);
  assert.equal(failure.label, 'No new accounts');
  assert.ok(!failure.label.includes('!'));
  assert.ok(!/\b429\b/.test(failure.label));
  assert.ok(!/registr/i.test(failure.label));
});

test('an error the page has no sentence for is shown as itself, not as a lost connection', () => {
  /* What a failed decryption looks like: a DOMException, no string code. It used to fall through
     to the network sentence, which said "no connection" while the server was answering. */
  const failure = describeSyncFailure(
    new DOMException('The operation failed for an operation-specific reason', 'OperationError')
  );

  assert.equal(failure.kind, 'unknown');
  assert.equal(failure.label, 'Sync failed');
  assert.match(failure.message, /OperationError/);
  assert.match(failure.message, /operation-specific reason/);
  assert.doesNotMatch(failure.message, /No connection/);
});

test('a server copy that cannot be opened has its own sentence, not the network one', () => {
  const failure = describeSyncFailure(
    new SyncError('REMOTE_UNREADABLE', 'The copy on the server could not be opened with this phrase.')
  );

  assert.equal(failure.kind, 'unreadable');
  assert.equal(failure.label, 'Copy not opened');
  assert.match(failure.message, /older version of the app/);
  assert.doesNotMatch(failure.message, /No connection/);
});

test('a request that never reached the server is still called offline', async () => {
  const client = new SyncClient({
    fetch: async () => {
      throw new TypeError('fetch failed');
    }
  });

  await assert.rejects(
    () => client.request('/health'),
    (error) => error.code === 'NETWORK'
  );
  assert.equal(describeSyncFailure(new SyncError('NETWORK', 'x')).kind, 'network');
});

test('a 429 from the register route is the cap, not a generic server failure', async () => {
  const fetch = async () => new Response(JSON.stringify({ error: 'full', max: 1 }), { status: 429 });
  const client = new SyncClient({ fetch });

  await assert.rejects(
    () => client.register('a'.repeat(22), 'b'.repeat(43)),
    (error) => error instanceof SyncError && describeSyncFailure(error).kind === 'cap'
  );
});

test('a rejected phrase is its own answer, and a server error is not called a phrase', () => {
  const phrase = describeSyncFailure(new SyncError('LOGIN_FAILED', 'no', { status: 401 }));
  const broken = describeSyncFailure(new SyncError('LOGIN_FAILED', 'no', { status: 500 }));

  assert.equal(phrase.kind, 'phrase');
  assert.match(phrase.message, /phrase/);
  assert.equal(broken.kind, 'server');
  assert.notEqual(broken.message, phrase.message);
});

test('an expired session asks for a sign-in rather than announcing a failure', () => {
  const failure = describeSyncFailure(new SyncError('UNAUTHORIZED', 'expired'));
  assert.equal(failure.kind, 'unauthorized');
  assert.equal(failure.message, undefined);
});
