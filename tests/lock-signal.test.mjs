/**
 * The lock signal: one tab's lock has to reach the others, and the message has to name no data.
 *
 * The cases that matter are that a lock posted on one tab arrives at another tab listening on the
 * same channel, that a message of any other shape is ignored, that the payload holds nothing but
 * its type, and that a browser without channels degrades to a no-op instead of a broken page.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { LOCK_CHANNEL, createLockSignal } from '../public/w/bookmarks/lock-signal.js';

/** A channel that records what it was asked to send and lets a test deliver a message. */
function fakeChannel() {
  const sent = [];
  const listeners = new Set();
  return {
    sent,
    posted: [],
    postMessage(message) {
      sent.push(message);
    },
    addEventListener(type, handler) {
      if (type === 'message') listeners.add(handler);
    },
    removeEventListener(type, handler) {
      if (type === 'message') listeners.delete(handler);
    },
    deliver(data) {
      for (const handler of [...listeners]) handler({ data });
    },
    get listenerCount() {
      return listeners.size;
    }
  };
}

/** BroadcastChannel delivers on a task, and how soon depends on what else the machine is doing: wait for the fact
    rather than for a clock, or this file fails only in the runs that are busy. */
async function until(predicate, timeout = 2000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return predicate();
}

test('a lock posted in one tab reaches another tab on the same name', async () => {
  const left = createLockSignal();
  const right = createLockSignal();
  let locked = 0;

  try {
    const unwatch = right.watch(() => {
      locked += 1;
    });
    assert.equal(LOCK_CHANNEL, 'bookmarks-lock');
    assert.equal(left.broadcast(), true);

    assert.equal(await until(() => locked === 1), true, 'the other tab was told to lock');
    unwatch();
  } finally {
    left.close();
    right.close();
  }
});

test('a tab never locks itself from its own broadcast', async () => {
  const signal = createLockSignal();
  let locked = 0;
  try {
    signal.watch(() => {
      locked += 1;
    });
    signal.broadcast();
    await until(() => locked > 0);
    assert.equal(locked, 0, 'the sender handles its own lock directly');
  } finally {
    signal.close();
  }
});

test('the message carries the type and nothing else', () => {
  const channel = fakeChannel();
  const signal = createLockSignal({ createChannel: () => channel });

  signal.broadcast();

  assert.deepEqual(channel.sent, [{ type: 'locked' }]);
  assert.deepEqual(Object.keys(channel.sent[0]), ['type'], 'no key, phrase or account id travels');
});

test('only a lock message runs the handler', () => {
  const channel = fakeChannel();
  const signal = createLockSignal({ createChannel: () => channel });
  let locked = 0;
  signal.watch(() => {
    locked += 1;
  });

  channel.deliver({ type: 'something-else' });
  channel.deliver(null);
  channel.deliver({ type: 'locked' });

  assert.equal(locked, 1);
});

test('unwatching stops delivery', () => {
  const channel = fakeChannel();
  const signal = createLockSignal({ createChannel: () => channel });
  let locked = 0;
  const unwatch = signal.watch(() => {
    locked += 1;
  });

  channel.deliver({ type: 'locked' });
  unwatch();
  channel.deliver({ type: 'locked' });

  assert.equal(locked, 1);
  assert.equal(channel.listenerCount, 0);
});

test('a browser without channels degrades to a no-op', () => {
  const signal = createLockSignal({
    createChannel: () => {
      throw new Error('BroadcastChannel is not defined');
    }
  });

  assert.equal(signal.broadcast(), false);
  const unwatch = signal.watch(() => {
    throw new Error('this must not run');
  });
  assert.equal(typeof unwatch, 'function');
  unwatch();
  signal.close();
});

test('a channel that refuses a post reports it rather than throwing', () => {
  const signal = createLockSignal({
    createChannel: () => ({
      postMessage() {
        throw new Error('closed');
      },
      addEventListener() {},
      removeEventListener() {},
      close() {}
    })
  });

  assert.equal(signal.broadcast(), false);
});
