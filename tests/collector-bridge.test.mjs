/**
 * The page's handle on the extension, and the one thing that makes it optional: a reply that never comes.
 *
 * The window is a fake, so these run in `node --test` with no browser and no extension installed.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { BRIDGE_SOURCE, BRIDGE_VERSION, PAGE_SOURCE, createBridge, isSnapshot } from '../public/w/bookmarks/collector.js';

function fakeWindow() {
  const listeners = new Set();
  const posted = [];
  const host = {
    location: { origin: 'https://bookmarks.332321.xyz' },
    addEventListener(type, listener) {
      if (type === 'message') listeners.add(listener);
    },
    removeEventListener(type, listener) {
      if (type === 'message') listeners.delete(listener);
    },
    postMessage(data) {
      posted.push(data);
    }
  };
  return {
    host,
    posted,
    deliver(data, source = host) {
      for (const listener of listeners) listener({ source, data });
    }
  };
}

const answer = (id, reply) => ({ source: BRIDGE_SOURCE, version: BRIDGE_VERSION, id, reply });
const snapshot = {
  ok: true,
  version: BRIDGE_VERSION,
  policy: { enabled: true },
  items: [{ url: 'https://a.example/', host: 'a.example', visits: 2 }]
};

test('a request is answered by whatever the extension replies with', async () => {
  const { host, posted, deliver } = fakeWindow();
  const bridge = createBridge({ window: host });

  const pending = bridge.request();
  assert.equal(posted.length, 1);
  assert.equal(posted[0].source, PAGE_SOURCE);
  assert.equal(posted[0].type, 'request');
  assert.equal(posted[0].version, BRIDGE_VERSION);

  deliver(answer(posted[0].id, snapshot));
  assert.deepEqual(await pending, snapshot);
});

test('no answer is null, not a hang and not an exception', async () => {
  const { host } = fakeWindow();
  const bridge = createBridge({ window: host, timeout: 10 });
  assert.equal(await bridge.request(), null);
});

test('a message from another window, or another version, is ignored', async () => {
  const { host, posted, deliver } = fakeWindow();
  const bridge = createBridge({ window: host, timeout: 10 });

  const pending = bridge.request();
  deliver(answer(posted[0].id, snapshot), { not: 'us' });
  deliver({ ...answer(posted[0].id, snapshot), version: BRIDGE_VERSION + 1 });
  deliver({ source: 'somebody-else', version: BRIDGE_VERSION, id: posted[0].id, reply: snapshot });

  assert.equal(await pending, null);
});

test('a change the extension reports reaches every listener', () => {
  const { host, deliver } = fakeWindow();
  const bridge = createBridge({ window: host });
  const seen = [];
  const off = bridge.onChange((change) => seen.push(change));

  deliver({ source: BRIDGE_SOURCE, version: BRIDGE_VERSION, changed: { count: 4 } });
  assert.deepEqual(seen, [{ count: 4 }]);

  off();
  deliver({ source: BRIDGE_SOURCE, version: BRIDGE_VERSION, changed: { count: 5 } });
  assert.equal(seen.length, 1);
});

test('a reply is used only when it is actually a snapshot', () => {
  assert.equal(isSnapshot(snapshot), true);
  assert.equal(isSnapshot(null), false);
  assert.equal(isSnapshot({ error: 'refused' }), false);
  assert.equal(isSnapshot({ ok: true, policy: {}, items: 'nope' }), false);
});
