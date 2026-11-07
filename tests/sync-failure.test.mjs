/**
 * How a failed sync is explained.
 *
 * The page shows one notice for a server that refuses a new account and another sentence for
 * every other failure, so this map is what keeps those cases from being told as the same event.
 * It is a pure function: the browser and these tests read the same answer.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { SyncClient, SyncError, describeSyncFailure } from '../public/w/bookmarks/sync.js';

test('a refused account is not the same failure as a wrong phrase, a lost connection or an ended trial', () => {
  const failures = [
    describeSyncFailure(new SyncError('FULL', 'full', { status: 429 })),
    describeSyncFailure(new SyncError('LOGIN_FAILED', 'refused', { status: 401 })),
    describeSyncFailure(new TypeError('fetch failed')),
    describeSyncFailure(new SyncError('TRIAL_ENDED', 'ended', { status: 402 }))
  ];

  assert.deepEqual(
    failures.map((failure) => failure.kind),
    ['cap', 'phrase', 'network', 'trial']
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
