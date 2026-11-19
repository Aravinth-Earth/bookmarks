/**
 * The alert rule.
 *
 * A lockout nobody is told about is a lockout that never happened, so the deployment carries one
 * notification rule: `alerts/signin-failures.json`, next to `wrangler.toml`. Cloudflare's monitor
 * reads the same event lines this Worker writes, and what is tested here is the rule against the
 * real event lines — a sustained set raises exactly one notification, a single refusal raises none,
 * a set that outruns the window raises none, and a second set after it is a second notification.
 *
 * The lines are produced by the account object with the same harness `events.test.mjs` uses, and
 * the clock is the harness's own, so a fifteen-minute window needs no waiting. The monitor's
 * evaluation is restated here in JavaScript: count the rule's events per group inside a trailing
 * window, notify on the first evaluation that reaches the threshold, and stay quiet until the set
 * has been silent for longer than the window.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { Vault } from '../src/vault.js';
import { deriveAccount, proveAuth } from '../public/crypto.js';
import { WORDLIST } from '../public/wordlist.js';

const RULE = JSON.parse(
  readFileSync(fileURLToPath(new URL('../alerts/signin-failures.json', import.meta.url)), 'utf8')
);

const PHRASE = WORDLIST.slice(0, 13).join(' ');
const ACCOUNT = await deriveAccount(PHRASE);
/* The only handle a notification may name: the account, as the digest prefix its lines carry. */
const REF = await (async () => {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ACCOUNT.accountId));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('').slice(0, 12);
})();
const SOURCE = '203.0.113.7';

/* --------------------------------------------------------------- the harness */

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

/** One account object, with a clock the test moves. */
function vaultObject() {
  const ctx = { storage: storage(), id: { name: ACCOUNT.accountId } };
  const env = {
    REGISTRY: {
      idFromName: (name) => ({ name }),
      get: () => ({
        fetch: async () =>
          new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          })
      })
    }
  };

  let clock = 1_000_000;
  const vault = new Vault(ctx, env, { now: () => clock });

  return {
    vault,
    at: () => clock,
    advance(ms) {
      clock += ms;
    }
  };
}

function vaultRequest(path, body) {
  return new Request(`https://vault${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-vault-source': SOURCE },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

async function read(response) {
  return { status: response.status, body: await response.json() };
}

async function provision(harness) {
  const challenge = await read(
    await harness.vault.fetch(vaultRequest('/account', { accountId: ACCOUNT.accountId, authSecret: ACCOUNT.authSecret }))
  );
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

/** Run `run`, collecting every event line with the moment the clock held when it was written. */
async function collect(harness, run) {
  const events = [];
  const original = console.log;
  console.log = (...args) => {
    for (const arg of args) events.push({ at: harness.at(), ...JSON.parse(String(arg)) });
  };
  try {
    await run();
  } finally {
    console.log = original;
  }
  return events;
}

/* ------------------------------------------------------- the monitor, restated */

/** The notifications a rule raises over a set of timed event lines. */
function notificationsFor(rule, events) {
  const counted = events.filter((line) => rule.events.includes(line.event));
  const groups = new Map();

  for (const line of counted) {
    const key = rule.group_by.map((field) => line[field] ?? 'none').join('|');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(line);
  }

  const raised = [];
  for (const [group, lines] of groups) {
    const ordered = [...lines].sort((left, right) => left.at - right.at);
    let above = false;
    let previous = null;

    for (const line of ordered) {
      /* A set that has been silent for longer than the window is over: the next line begins again. */
      if (previous !== null && line.at - previous > rule.window_seconds * 1000) above = false;
      previous = line.at;

      const count = ordered.filter(
        (other) => other.at <= line.at && line.at - other.at < rule.window_seconds * 1000
      ).length;

      if (!above && count >= rule.threshold) {
        raised.push({ group, at: line.at, count });
        above = true;
      }
    }
  }

  return raised;
}

/* ------------------------------------------------------------------- the cases */

test('a sustained failure set raises one notification, and the rest of the set raises none', async () => {
  const harness = vaultObject();
  await provision(harness);

  const events = await collect(harness, async () => {
    for (let attempt = 0; attempt < RULE.threshold; attempt += 1) {
      const refused = await failedLogin(harness);
      assert.equal(refused.status, 401, `failure ${attempt + 1} is refused`);
    }

    /* The source is locked. It keeps trying for ten more minutes: the same sustained set, so
       the notification has already been sent and nothing further may be. */
    for (let attempt = 0; attempt < 20; attempt += 1) {
      harness.advance(30_000);
      const refused = await read(
        await harness.vault.fetch(vaultRequest('/login', { proof: 'x'.repeat(43) }))
      );
      assert.equal(refused.status, 429, `attempt ${attempt + 1} while locked`);
    }
  });

  assert.equal(
    events.filter((line) => line.event === 'signin_failed').length,
    RULE.threshold,
    'the set is the failures that lock the source'
  );

  const raised = notificationsFor(RULE, events);
  assert.equal(raised.length, 1, 'one sustained set is one notification');
  assert.equal(raised[0].group, REF, 'grouped by the account digest, never by a source');
  assert.equal(raised[0].count, RULE.threshold);
  for (const line of events) {
    assert.equal(JSON.stringify(line).includes(ACCOUNT.accountId), false, 'no account id is named');
    assert.equal(JSON.stringify(line).includes(SOURCE), false, 'no address is named');
  }
});

test('a single wrong proof raises nothing', async () => {
  const harness = vaultObject();
  await provision(harness);
  assert.ok(RULE.threshold > 1);

  const events = await collect(harness, async () => {
    const refused = await failedLogin(harness);
    assert.equal(refused.status, 401);
  });

  assert.equal(notificationsFor(RULE, events).length, 0);
});

test('failures that outrun the window never add up to a set', async () => {
  const harness = vaultObject();
  await provision(harness);

  const events = await collect(harness, async () => {
    for (let attempt = 0; attempt < RULE.threshold; attempt += 1) {
      const refused = await failedLogin(harness);
      assert.equal(refused.status, 401, `failure ${attempt + 1}`);
      harness.advance(RULE.window_seconds * 1000);
    }
  });

  assert.equal(events.filter((line) => line.event === 'signin_failed').length, RULE.threshold);
  assert.equal(notificationsFor(RULE, events).length, 0, 'no window held the whole set');
});

test('a second sustained set after the window is a second notification', async () => {
  const harness = vaultObject();
  await provision(harness);

  const events = await collect(harness, async () => {
    for (let attempt = 0; attempt < RULE.threshold; attempt += 1) {
      assert.equal((await failedLogin(harness)).status, 401);
    }
    harness.advance(RULE.window_seconds * 1000 + 1000);
    for (let attempt = 0; attempt < RULE.threshold; attempt += 1) {
      assert.equal((await failedLogin(harness)).status, 401, `second set, failure ${attempt + 1}`);
    }
  });

  const raised = notificationsFor(RULE, events);
  assert.equal(raised.length, 2, 'each set is told once');
  assert.deepEqual(
    raised.map((notification) => notification.count),
    [RULE.threshold, RULE.threshold]
  );
});
