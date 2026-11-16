/**
 * The cached copy of the app is only as good as what gets written into it.
 *
 * A navigation is the one response the worker stores under `/`, and that slot is the whole app
 * for every later offline visit. A 404, a refusal or a redirect written there replaces the app
 * with something else until a new worker installs, which can be days later. These tests run the
 * worker's own fetch handler against a fake origin and read what it stored.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const SOURCE = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
const ORIGIN = 'https://bookmarks.332321.xyz';

function shellResponse({
  status = 200,
  url = `${ORIGIN}/somewhere`,
  type = 'basic',
  contentType = 'text/html; charset=utf-8'
} = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    url,
    type,
    headers: { get: (name) => (name.toLowerCase() === 'content-type' ? contentType : null) },
    clone: () => shellResponse({ status, url, type, contentType })
  };
}

function loadWorker(get) {
  const listeners = {};
  const puts = [];
  const cache = {
    put: async (key, value) => puts.push({ key, value }),
    addAll: async () => {}
  };
  const caches = {
    open: async () => cache,
    match: async () => ({ from: 'cache' }),
    keys: async () => [],
    delete: async () => true
  };
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (type, handler) => {
      listeners[type] = handler;
    },
    skipWaiting: () => {},
    clients: { claim: async () => {} }
  };

  /* The worker is read from this repository, not from a request; running it here is what lets the
     test see the real handler instead of a copy that can drift from it. */
  runInNewContext(SOURCE, { self, caches, fetch: get, URL });
  return { listeners, puts };
}

async function navigate(worker, url = `${ORIGIN}/missing`) {
  let answer;
  worker.listeners.fetch({
    request: { method: 'GET', mode: 'navigate', url },
    respondWith: (value) => {
      answer = value;
    }
  });
  return answer;
}

test('a failed navigation is not stored as the app shell', async () => {
  const worker = loadWorker(async () => shellResponse({ status: 404, url: `${ORIGIN}/missing` }));

  const response = await navigate(worker);
  assert.equal(response.status, 404, 'the caller still sees the refusal');
  assert.deepEqual(worker.puts, [], 'the 404 did not replace the offline shell');
});

test('a successful same-origin document is stored as the app shell', async () => {
  const worker = loadWorker(async () => shellResponse());

  const response = await navigate(worker);
  assert.equal(response.status, 200);
  assert.equal(worker.puts.length, 1);
  assert.equal(worker.puts[0].key, '/');
});

test('a response that ended on another origin is not stored', async () => {
  const worker = loadWorker(async () =>
    shellResponse({ url: 'https://login.example/session', type: 'cors' })
  );

  await navigate(worker);
  assert.deepEqual(worker.puts, [], 'a redirected document is not this app');
});

test('a successful response that is not a document is not stored', async () => {
  const worker = loadWorker(async () => shellResponse({ contentType: 'application/json' }));

  await navigate(worker);
  assert.deepEqual(worker.puts, []);
});

test('a navigation with no network still answers from the cache', async () => {
  const worker = loadWorker(async () => {
    throw new Error('offline');
  });

  const response = await navigate(worker);
  assert.deepEqual(response, { from: 'cache' });
});
