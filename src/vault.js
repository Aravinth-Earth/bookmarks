/**
 * Bookmarks — one Durable Object per account.
 *
 * It is a mailbox for one sealed blob. It holds the account's auth secret (which authenticates
 * and cannot decrypt), the current vault, the last few versions, a single-use nonce, and the
 * session hashes. It never sees a bookmark, a name, a URL, an icon or a key.
 *
 * One object per account is what removes the write race: every request for that account is
 * serialized here, so "compare the version, then write" needs no retry loop and no conditional
 * SQL. The client still sends a base version, because that is what tells two devices apart.
 *
 * `now` is injectable so expiry and lockout are testable without waiting.
 */

import { digestHex, logEvent } from './events.js';
import { hashCode } from './invites.js';

/* One paid unit is about ten bookmarks; 10 units is about a hundred. The cap is bytes because
   the server cannot count entries in a sealed vault. */
export const UNIT_CT_CHARS = 14_000;
/* The owner's balance. It is a number like anyone else's, so the paid path is the same code. */
export const OWNER_UNITS = 100;
/* The hosted copy a member of the service holds: about 11 units, roughly a hundred bookmarks
   with icons. It is a size, not a period — no account expires. */
export const FREE_MAX_CT_CHARS = 160_000;
const OWNER_RECHECK_MS = 365 * 24 * 60 * 60 * 1000;
const HISTORY_LIMIT = 3;
const NONCE_TTL_MS = 60_000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/* An account that is created and then never signed in to or written is holding a slot it is not
   using. The alarm releases it after this long, so one abandoned creation cannot occupy the cap
   indefinitely. Signing in or writing a vault counts as use and cancels the release; an account
   that is ever used is kept for good. */
export const UNUSED_RELEASE_MS = 24 * 60 * 60 * 1000;
/* A session's last-seen stamp is written only when it is this stale, so an ordinary read or
   write does not each cost a storage write. */
const LAST_SEEN_STEP_MS = 60 * 60 * 1000;
/* What a client says it is. Anything else is stored as unknown; no user agent is kept. */
const CLIENT_KINDS = new Set(['mobile', 'desktop']);
/* One sign-in is one place. The oldest are dropped rather than accumulated forever. */
const MAX_SESSIONS = 20;

/* A sign-in failure is counted against the source it came from, not the account. Five wrong
   proofs from one place lock that place for fifteen minutes and leave every other place — the
   owner's included — able to sign in. */
export const MAX_FAILURES = 5;
export const LOCKOUT_MS = 15 * 60 * 1000;
/* Failures older than this are forgotten, so a typo last month is not part of today's count.
   It matches the lock, so the entry a lock leaves behind has already aged out when it expires. */
const FAILURE_WINDOW_MS = LOCKOUT_MS;
/* How many sources one account object remembers. A caller that invents sources cannot grow the
   object: the oldest entry is evicted to make room, and losing an entry can only forget
   failures, never extend a lock. */
export const MAX_TRACKED_SOURCES = 64;

/* The whole-account guard against a distributed attempt. It throttles and never locks: the
   count only covers the last minute, the wait doubles from a second and stops at thirty, and
   the moment a wait ends is written at most thirty seconds ahead, so no arrangement of sources
   can keep the owner out for longer than that cap. Twenty failures inside a minute is more than
   four sources can spend, because each of them is locked at five. */
export const ACCOUNT_FREE_FAILURES = 20;
const ACCOUNT_WINDOW_MS = 60_000;
const ACCOUNT_RETRY_FIRST_MS = 1_000;
export const ACCOUNT_RETRY_MAX_MS = 30_000;

const SOURCE_PREFIX = 'source:';
const ATTEMPTS_KEY = 'attempts';
/* The Worker's digest of the caller's address. A malformed header is not a source. */
const SOURCE_DIGEST = /^[0-9a-f]{64}$/;
/* The one bucket used when the object was reached without a source, as a test or a binding is. */
const UNATTRIBUTED = 'unattributed';

const ACCOUNT_ID = /^[A-Za-z0-9_-]{22}$/;
const AUTH_SECRET = /^[A-Za-z0-9_-]{43}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const SESSION_HASH = 43;

const encoder = new TextEncoder();

const MAX_SMALL_BODY = 4 * 1024;
export const MAX_VAULT_BODY = 4 * 1024 * 1024;

/**
 * Read a JSON body up to `max` bytes, refusing it before the parser sees it.
 *
 * `content-length` is checked first because a refusal that reads nothing is the cheap one, but
 * it is never trusted: the body is counted as it arrives and reading stops at the cap, so an
 * unbounded body cannot be buffered.
 *
 * @returns {Promise<{value?: object, tooLarge?: true, invalid?: true}>}
 */
async function readJson(request, max) {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) return { tooLarge: true };
  if (!request.body) return { value: null };

  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;

    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return { tooLarge: true };
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }

  try {
    return { value: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    return { invalid: true };
  }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  });
}

function toBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text, what) {
  if (typeof text !== 'string' || text === '' || !BASE64URL.test(text)) {
    throw new Error(`bookmarks: ${what} is not base64url`);
  }
  const padding = (4 - (text.length % 4)) % 4;
  let binary;
  try {
    if (padding === 3) throw new Error('impossible length');
    binary = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(padding));
  } catch {
    throw new Error(`bookmarks: ${what} is not base64url`);
  }
  const bytes = new Uint8Array(binary.length);
  for (let at = 0; at < binary.length; at += 1) bytes[at] = binary.charCodeAt(at);
  return bytes;
}

async function sha256(text) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text)));
}

async function sessionHash(token) {
  return toBase64Url(await sha256(token));
}

/**
 * The source a sign-in is counted against, or null when the request did not come through the
 * Worker.
 *
 * The Worker digests the caller's address and forwards only that digest, replacing any value
 * the caller sent, so this reads a digest and never an address. A request that reaches the
 * object without the header — a test, or an operator call through the binding — has nothing to
 * distinguish it from another such request, so they share one bucket.
 */
function sourceOf(request) {
  const header = request.headers.get('x-vault-source') ?? '';
  return SOURCE_DIGEST.test(header) ? header : null;
}

async function verifyProof(authSecret, accountId, nonce, proof) {
  try {
    const key = await crypto.subtle.importKey(
      'raw',
      fromBase64Url(authSecret, 'the auth secret'),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    );
    return await crypto.subtle.verify(
      'HMAC',
      key,
      fromBase64Url(proof, 'the proof'),
      encoder.encode(`${accountId}\n${nonce}`)
    );
  } catch {
    return false;
  }
}

export class Vault {
  constructor(ctx, env, options = {}) {
    this.ctx = ctx;
    this.env = env;
    this.storage = ctx.storage;
    this.now = options.now ?? (() => Date.now());
  }

  async fetch(request) {
    const path = new URL(request.url).pathname;

    if (path === '/admin-stats' && request.method === 'GET') return this.adminStats();
    if (path === '/account') return this.createAccount(request);
    if (path === '/challenge') return this.challenge(request);
    if (path === '/login') return this.login(request);
    if (path === '/logout') return this.logout(request);
    if (path === '/sessions' && request.method === 'GET') return this.listSessions(request);
    if (path === '/vault' && request.method === 'GET') return this.readVault(request);
    if (path === '/vault' && request.method === 'PUT') return this.writeVault(request);

    /* Operator route: read by a Worker bound to this object, never by a browser. The public
       API refuses any `/a/<id>/admin-` path, so this is reachable only through a binding. */
    if (path === '/admin-stats' && request.method === 'GET') return this.adminStats();

    return json({ error: 'not_found' }, 404);
  }

  /**
   * Create the account, gated on a proof of the secret it will store.
   *
   * A request without `proof` writes nothing. It stores a single-use nonce and answers 428 with
   * `{ error: 'proof_required', nonce, expiresAt }`; the caller signs `${accountId}\n${nonce}`
   * with the auth secret — the same HMAC `/login` verifies — and presents that proof with the
   * same body. Only that second request may write the account.
   *
   * An account that already exists is never written again and never overwritten. Its proof is
   * checked against the stored secret, and a wrong one answers exactly like a failed login, so
   * this route cannot be used to re-claim an id with a different secret.
   */
  async createAccount(request) {
    if (request.method !== 'POST') return json({ error: 'method' }, 405);

    const body = await readJson(request, MAX_SMALL_BODY);
    if (body.tooLarge) {
      /* The body was refused before it was parsed, so there is no account id to name. */
      await logEvent('create_refused', { route: 'signin', reason: 'too_large' });
      return json({ error: 'too_large' }, 413);
    }

    const accountId = body.value?.accountId;
    const authSecret = body.value?.authSecret;

    if (!ACCOUNT_ID.test(accountId ?? '') || !AUTH_SECRET.test(authSecret ?? '')) {
      /* Whatever was presented is not an account id or a secret, and is not written down. */
      await logEvent('create_refused', { route: 'signin', reason: 'invalid' });
      return json({ error: 'invalid' }, 400);
    }
    /* The object's own name is the account id, so a provisioning call cannot write one
       account's secret into another account's object. */
    if (this.ctx.id?.name && this.ctx.id.name !== accountId) {
      await logEvent('create_refused', {
        route: 'signin',
        reason: 'mismatch',
        account: accountId
      });
      return json({ error: 'mismatch' }, 400);
    }

    const proof = body.value?.proof;
    if (typeof proof !== 'string' || proof === '') {
      /* Nothing is written yet: the caller has a secret but has not shown it knows the phrase
         that secret belongs to. */
      const nonce = toBase64Url(crypto.getRandomValues(new Uint8Array(16)));
      const expiresAt = this.now() + NONCE_TTL_MS;
      await this.storage.put('create-nonce', { value: nonce, expiresAt });
      return json({ error: 'proof_required', nonce, expiresAt }, 428);
    }

    const challenge = await this.storage.get('create-nonce');
    if (!challenge || challenge.expiresAt <= this.now()) {
      /* A spent or stale nonce cannot be retried; offer a fresh one and the caller re-signs. */
      await this.storage.delete('create-nonce');
      const nonce = toBase64Url(crypto.getRandomValues(new Uint8Array(16)));
      const expiresAt = this.now() + NONCE_TTL_MS;
      await this.storage.put('create-nonce', { value: nonce, expiresAt });
      return json({ error: 'proof_required', nonce, expiresAt }, 428);
    }
    /* Single use, spent whether the proof is right or wrong, exactly as `/login` spends its own. */
    await this.storage.delete('create-nonce');

    const existing = await this.storage.get('account');
    /* For an existing account the proof is checked against the secret it was created with, so
       presenting the same id with a different secret can never re-claim it. */
    const expected = existing ? existing.authSecret : authSecret;
    if (!(await verifyProof(expected, accountId, challenge.value, proof))) {
      await logEvent('create_refused', {
        route: 'signin',
        reason: 'bad_proof',
        account: accountId
      });
      return json({ error: 'bad_proof' }, 401);
    }

    if (existing) {
      return json({ ok: true, created: false, plan: existing.plan ?? 'free' }, 200);
    }

    /* The cap lives in one object, so creation is serialised against it. An existing account
       never reaches this point, so a full registry cannot lock out the person who already has
       one, and a retried first sync cannot consume a second slot. */
    const registry = this.env?.REGISTRY;
    /* How the slot was granted: `owner` for the first account on a server, `invite` for a code, `direct` otherwise.
       The operator view reads it back; nothing here decides anything. */
    let via = 'direct';
    if (registry) {
      const stub = registry.get(registry.idFromName('registry'));
      /* The code is turned into a digest here, so the registry never holds a code that could be used. An absent
         code is an empty digest, which matches nothing. */
      const inviteHash =
        typeof body.value?.invite === 'string' && body.value.invite !== ''
          ? await hashCode(body.value.invite)
          : '';

      const reserved = await stub.fetch(
        new Request('https://registry/reserve', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ accountId, inviteHash })
        })
      );
      if (reserved.ok) {
        try {
          const answer = await reserved.clone().json();
          via = typeof answer.via === 'string' ? answer.via : via;
        } catch {
          /* An answer without a reason still reserves the slot; the reason stays unknown. */
        }
      }

      if (!reserved.ok) {
        /* The Registry's answer is the reason this creation wrote nothing: a full server, a missing code, a spent
           one or an expired one. They are told apart because each asks the person for something different. */
        const answer = await reserved.json().catch(() => ({}));
        const refusal =
          answer.error === 'invite_required'
            ? [403, 'invite_required', 'invite_required']
            : answer.error === 'invite_used'
              ? [422, 'invite_used', 'invite_used']
              : answer.error === 'invite_expired'
                ? [410, 'invite_expired', 'invite_expired']
                : [429, 'cap_full', 'full'];

        await logEvent('create_refused', {
          route: 'signin',
          reason: refusal[1],
          account: accountId
        });
        return json({ error: refusal[2] }, refusal[0]);
      }
    }

    /* Creation always starts on the free plan. Ownership is only granted after a successful
       proof of the phrase, so a leaked owner id cannot be used to pre-create the account and
       claim the plan. */
    const now = this.now();
    const plan = 'free';
    const units = 0;

    await this.storage.put('account', {
      accountId,
      authSecret,
      plan,
      units,
      via,
      createdAt: now,
      lastSeenAt: now,
      paidUntil: null
    });

    if (typeof this.storage.setAlarm === 'function') {
      /* The only deadline an account ever carries: the release of a slot that was reserved and
         then never used. Use cancels it, and an account that is used is never scheduled again. */
      await this.storage.setAlarm(now + UNUSED_RELEASE_MS);
    }

    return json({ ok: true, created: true, plan }, 201);
  }

  /**
   * One live nonce at a time.
   *
   * Asking again while a nonce is still valid answers with that same nonce and writes nothing,
   * so a request from anywhere else cannot invalidate a sign-in that is already in progress.
   * The nonce is spent by the first login that presents it and expires 60 seconds after it was
   * minted; the next request after either mints a new one.
   */
  async challenge(request) {
    if (request.method !== 'POST') return json({ error: 'method' }, 405);

    const account = await this.storage.get('account');
    if (!account) return json({ error: 'no_account' }, 404);

    const live = await this.storage.get('nonce');
    if (live && live.expiresAt > this.now()) return json({ nonce: live.value });

    const nonce = toBase64Url(crypto.getRandomValues(new Uint8Array(16)));
    await this.storage.put('nonce', { value: nonce, expiresAt: this.now() + NONCE_TTL_MS });
    return json({ nonce });
  }

  async login(request) {
    if (request.method !== 'POST') return json({ error: 'method' }, 405);

    let account = await this.storage.get('account');
    if (!account) {
      /* No account answers to this id, so there is no account reference to write either. */
      await logEvent('signin_failed', { route: 'signin', reason: 'no_account' });
      return json({ error: 'no_account' }, 404);
    }

    const now = this.now();
    const source = sourceOf(request);
    /* Counted per source: the key is a digest of the account and the source, so a caller who
       invents sources writes nothing that names one, and no source can spend another's budget. */
    const failureKey = await this.failureKey(account.accountId, source);

    const stored = await this.storage.get(failureKey);
    const failures = this.sourceFailures(stored, now);
    if (failures.until > now) {
      const retryAfter = Math.ceil((failures.until - now) / 1000);
      await logEvent('signin_locked', {
        route: 'signin',
        reason: 'locked',
        account: account.accountId,
        source,
        retry_after: retryAfter
      });
      return json({ error: 'locked', retryAfter }, 429);
    }

    /* The account-level guard, which answers a wait and never a lock. A distributed attempt can
       delay the owner by at most the cap below; it cannot keep him out. */
    const attempts = await this.storage.get(ATTEMPTS_KEY);
    const retryAfter = this.throttleOf(attempts, now);
    if (retryAfter > 0) {
      await logEvent('signin_locked', {
        route: 'signin',
        reason: 'throttled',
        account: account.accountId,
        retry_after: retryAfter
      });
      return json({ error: 'throttled', retryAfter }, 429);
    }

    const nonce = await this.storage.get('nonce');
    if (!nonce || nonce.expiresAt <= now) {
      await this.storage.delete('nonce');
      await logEvent('signin_failed', {
        route: 'signin',
        reason: 'challenge_expired',
        account: account.accountId
      });
      return json({ error: 'challenge_expired' }, 401);
    }
    /* Single use: spent whether the proof is right or wrong, so a captured proof cannot be
       replayed and a guess cannot be retried against the same challenge. */
    await this.storage.delete('nonce');

    const body = await readJson(request, MAX_SMALL_BODY);
    if (body.tooLarge) {
      await logEvent('signin_failed', {
        route: 'signin',
        reason: 'too_large',
        account: account.accountId
      });
      return json({ error: 'too_large' }, 413);
    }

    const proof = body.value?.proof;
    const client = CLIENT_KINDS.has(body.value?.client) ? body.value.client : 'unknown';
    const ok =
      typeof proof === 'string' && proof.length > 0
        ? await verifyProof(account.authSecret, account.accountId, nonce.value, proof)
        : false;

    if (!ok) {
      await logEvent('signin_failed', {
        route: 'signin',
        reason: 'bad_proof',
        account: account.accountId,
        source
      });

      /* Five from one source is that source's lock; a correct proof is what clears it, and the
         count also ages out on its own. */
      const count = failures.failures + 1;
      const locking = count >= MAX_FAILURES;
      await this.recordSource(
        failureKey,
        {
          failures: locking ? 0 : count,
          lastAt: now,
          until: locking ? now + LOCKOUT_MS : 0
        },
        stored === undefined
      );
      await this.storage.put(ATTEMPTS_KEY, this.nextAttempts(attempts, now));
      return json({ error: 'bad_proof' }, 401);
    }

    /* A correct proof clears this source immediately, and the account's throttle with it. */
    await this.storage.delete(failureKey);
    await this.storage.delete(ATTEMPTS_KEY);

    /* The flag can be set after the account already exists: the next login upgrades it. */
    account = await this.claimOwner(account);
    /* Kept in this local too, so the answer below reads the moment that was just stored rather
       than the one it replaced. */
    account = { ...account, lastSeenAt: now };
    await this.storage.put('account', account);
    await this.pruneSessions();

    const token = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
    const expiresAt = now + SESSION_TTL_MS;
    await this.storage.put(`session:${await sessionHash(token)}`, {
      expiresAt,
      createdAt: now,
      lastSeenAt: now,
      client
    });

    /* So the app can say "3 places" the moment it signs in, without a second request. */
    const places = await this.trimSessions();

    return json({
      token,
      expiresAt,
      plan: account.plan ?? 'free',
      via: account.via ?? 'direct',
      units: account.units ?? 0,
      paidUntil: account.paidUntil ?? null,
      /* The account's own dates, in milliseconds. They are only ever sent in this answer, which
         needs a proof of the phrase, so the owner can read when the vault was created and when
         it last moved without a second request — and nobody without the phrase is told either. */
      createdAt: account.createdAt ?? null,
      lastSeenAt: account.lastSeenAt ?? null,
      places
    });
  }

  /** The storage key a source's failures are counted under: two digests, never an address. */
  async failureKey(accountId, source) {
    const account = await digestHex(accountId);
    return `${SOURCE_PREFIX}${await digestHex(`${account}\n${source ?? UNATTRIBUTED}`)}`;
  }

  /**
   * What one source carries: its failures, and the end of a lock when it has earned one.
   *
   * A count older than the window is gone. The lock lasts exactly the window, so an entry that
   * has come back here has also aged out and starts again at nothing.
   */
  sourceFailures(entry, now) {
    if (!entry || now - (entry.lastAt ?? 0) >= FAILURE_WINDOW_MS) {
      return { failures: 0, lastAt: now, until: 0 };
    }
    return { failures: entry.failures ?? 0, lastAt: entry.lastAt ?? now, until: entry.until ?? 0 };
  }

  /**
   * Store one source's state, keeping the table bounded.
   *
   * A new key is admitted only after the oldest entry has gone, so a caller who invents sources
   * cannot grow the object. Evicting can only forget failures: a lock lives inside its entry and
   * nowhere else, so the worst an eviction does is let a source try again.
   */
  async recordSource(key, state, isNew) {
    if (isNew) {
      const entries = [...(await this.storage.list({ prefix: SOURCE_PREFIX }))].sort(
        (left, right) => (left[1].lastAt ?? 0) - (right[1].lastAt ?? 0)
      );
      for (const [oldest] of entries.slice(
        0,
        Math.max(0, entries.length - MAX_TRACKED_SOURCES + 1)
      )) {
        await this.storage.delete(oldest);
      }
    }
    await this.storage.put(key, state);
  }

  /**
   * The wait the whole account has earned, in seconds, or zero.
   *
   * Only a wait that is still running counts, and the wait is stored as a moment, not a lock:
   * the longest one written is the cap below, so an answer of thirty seconds is the worst any
   * arrangement of sources can produce and the next attempt comes after it.
   */
  throttleOf(entry, now) {
    if (!entry || (entry.until ?? 0) <= now) return 0;
    return Math.ceil((entry.until - now) / 1000);
  }

  /**
   * One more failure in the account's minute, or a fresh minute.
   *
   * The first twenty failures inside the window cost nothing, because a per-source lock already
   * stops five. Past that each failure buys a wait that doubles from a second and stops at the
   * cap, so a distributed attempt loses its guessing rate without ever being locked out.
   */
  nextAttempts(entry, now) {
    const fresh = !entry || now - (entry.firstAt ?? 0) >= ACCOUNT_WINDOW_MS;
    const failures = fresh ? 1 : (entry.failures ?? 0) + 1;
    const firstAt = fresh ? now : entry.firstAt;

    if (failures <= ACCOUNT_FREE_FAILURES) return { failures, firstAt, until: 0 };

    const ms = Math.min(
      ACCOUNT_RETRY_FIRST_MS * 2 ** (failures - ACCOUNT_FREE_FAILURES - 1),
      ACCOUNT_RETRY_MAX_MS
    );
    return { failures, firstAt, until: now + ms };
  }

  async logout(request) {
    const auth = await this.authorize(request);
    if (!auth) return json({ error: 'unauthorized' }, 401);

    await this.storage.delete(`session:${auth}`);
    return json({ ok: true });
  }

  /**
   * The places this account is signed in on.
   *
   * Only a session may ask, and only counts and timestamps leave: a session hash never does, so
   * knowing how many places exist cannot be turned into opening one of them. Nothing about a
   * bookmark, a name or a key is involved — this is account metadata, not vault content.
   */
  async listSessions(request) {
    const auth = await this.authorize(request);
    if (!auth) return json({ error: 'unauthorized' }, 401);

    await this.pruneSessions();

    const sessions = [...(await this.storage.list({ prefix: 'session:' }))]
      .map(([key, session]) => ({
        client: CLIENT_KINDS.has(session.client) ? session.client : 'unknown',
        createdAt: session.createdAt ?? 0,
        lastSeenAt: session.lastSeenAt ?? session.createdAt ?? 0,
        expiresAt: session.expiresAt ?? 0,
        current: key === `session:${auth}`
      }))
      .sort((left, right) => right.lastSeenAt - left.lastSeenAt);

    return json({ count: sessions.length, sessions });
  }

  async readVault(request) {
    const auth = await this.authorize(request);
    if (!auth) return json({ error: 'unauthorized' }, 401);

    const vault = await this.storage.get('vault');
    if (!vault) return json({ error: 'no_vault' }, 404);
    return json(vault);
  }

  async writeVault(request) {
    const auth = await this.authorize(request);
    if (!auth) return json({ error: 'unauthorized' }, 401);

    const account = await this.storage.get('account');
    if (!account) return json({ error: 'no_account' }, 404);

    const body = await readJson(request, MAX_VAULT_BODY);
    if (body.tooLarge) return json({ error: 'too_large' }, 413);
    if (!body.value || typeof body.value !== 'object') return json({ error: 'invalid' }, 400);

    const { baseVersion, iv, ct } = body.value;
    if (!Number.isInteger(baseVersion) || baseVersion < 0) {
      return json({ error: 'bad_version' }, 400);
    }
    if (typeof iv !== 'string' || iv.length !== 16 || !BASE64URL.test(iv)) {
      return json({ error: 'bad_iv' }, 400);
    }
    if (typeof ct !== 'string' || ct.length === 0 || !BASE64URL.test(ct)) {
      return json({ error: 'bad_ct' }, 400);
    }
    const limit = this.capChars(account);
    if (ct.length > limit) return json({ error: 'quota', limit }, 413);

    const current = (await this.storage.get('vault')) ?? { version: 0 };
    if (baseVersion !== current.version) {
      /* The current blob comes back so the caller can merge and retry in one round trip. */
      return json(
        {
          error: 'conflict',
          currentVersion: current.version,
          current: current.version === 0 ? null : current
        },
        409
      );
    }

    const version = current.version + 1;
    const updatedAt = this.now();

    if (current.version > 0) {
      await this.storage.put(`history:${current.version}`, current);
      await this.pruneHistory();
    }

    const vault = { version, iv, ct, updatedAt };
    await this.storage.put('vault', vault);
    await this.storage.put('account', { ...account, lastSeenAt: updatedAt });

    return json(vault);
  }

  /** The owner's flag is applied on login, so it can be configured after the account exists. */
  async claimOwner(account) {
    const owner = this.env?.OWNER_ACCOUNT_ID;
    if (!owner || owner !== account.accountId) return account;
    if (account.plan === 'owner' && account.units === OWNER_UNITS) return account;

    const upgraded = { ...account, plan: 'owner', units: OWNER_UNITS };
    await this.storage.put('account', upgraded);
    return upgraded;
  }

  /**
   * Dates, sizes and counts for an operator view: how much space an account holds against its
   * cap, and when it was last seen.
   *
   * The phrase, the auth secret, the session records and the sealed blob are not in the answer.
   */
  async adminStats() {
    const account = await this.storage.get('account');
    if (!account) return json({ error: 'no_account' }, 404);

    const vault = (await this.storage.get('vault')) ?? { version: 0 };
    const now = this.now();
    /* Only live places are counted, so an expired session that has not been pruned yet does
       not inflate the number an operator reads. */
    const sessions = [...(await this.storage.list({ prefix: 'session:' }))].filter(
      ([, session]) => (session.expiresAt ?? 0) > now
    ).length;

    return json({
      plan: account.plan ?? 'free',
      via: account.via ?? 'direct',
      units: account.units ?? 0,
      createdAt: account.createdAt ?? null,
      lastSeenAt: account.lastSeenAt ?? null,
      paidUntil: account.paidUntil ?? null,
      vaultVersion: vault.version ?? 0,
      ctChars: typeof vault.ct === 'string' ? vault.ct.length : 0,
      updatedAt: vault.updatedAt ?? null,
      capChars: this.capChars(account),
      sessions
    });
  }

  /**
   * Paid and owner accounts hold a number of units; a free account holds the fixed size of the
   * hosted copy that comes with the service. The cap is a size, never a deadline.
   */
  capChars(account) {
    if (account.plan === 'owner' || account.plan === 'paid') {
      const units = Number.isInteger(account.units) ? account.units : 0;
      return Math.max(0, units) * UNIT_CT_CHARS;
    }
    return FREE_MAX_CT_CHARS;
  }

  /**
   * The deadline the runtime wakes this object for.
   *
   * Creation arms one alarm, for the release of an account that was never used. An account that
   * has been signed in to or written is never deleted and is not rescheduled; an owner or a
   * paying account is only rechecked a year out, and that check never deletes it either.
   */
  async alarm() {
    const account = await this.storage.get('account');
    if (!account) return;

    const now = this.now();
    const paying = account.plan === 'owner' || (account.paidUntil && account.paidUntil > now);

    if (paying) {
      await this.storage.setAlarm(now + OWNER_RECHECK_MS);
      return;
    }

    /* An account nobody signed in to and nobody wrote to is only holding a slot. Release it
       after the idle window instead of reserving the cap indefinitely. */
    if (await this.isUnused(account)) {
      const releaseAt = (account.createdAt ?? 0) + UNUSED_RELEASE_MS;
      if (now < releaseAt) {
        await this.storage.setAlarm(releaseAt);
        return;
      }
      await this.releaseSlot(account.accountId);
      await this.storage.deleteAll();
      return;
    }

    /* A used account is kept. There is no deadline that deletes it: the local vault is free
       forever, and the hosted copy of an account that is in use is never taken away by time. */
  }

  /**
   * Created and never used: no sign-in, no vault. `lastSeenAt` moves on the first login, which
   * is what separates an abandoned creation from a device that simply has not written yet.
   */
  async isUnused(account) {
    if ((account.lastSeenAt ?? 0) > (account.createdAt ?? 0)) return false;
    if (await this.storage.get('vault')) return false;
    return (await this.storage.list({ prefix: 'session:' })).size === 0;
  }

  /** Give the account's slot back, so the cap frees itself as unused accounts are released. */
  async releaseSlot(accountId) {
    const registry = this.env?.REGISTRY;
    if (!registry) return;

    try {
      await registry.get(registry.idFromName('registry')).fetch(
        new Request('https://registry/release', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ accountId })
        })
      );
    } catch {
      /* The cap is a convenience; a failed release must not stop the deletion. */
    }
  }

  async authorize(request) {
    const header = request.headers.get('authorization') ?? '';
    const match = header.match(/^Bearer\s+([A-Za-z0-9_-]{20,})$/i);
    if (!match) return null;

    const hash = await sessionHash(match[1]);
    if (hash.length !== SESSION_HASH) return null;

    const session = await this.storage.get(`session:${hash}`);
    if (!session) return null;

    if (session.expiresAt <= this.now()) {
      await this.storage.delete(`session:${hash}`);
      return null;
    }

    /* "Connected places" is only useful if the list shows real activity, but a write per
       request would be wasteful — an hour of drift is enough to answer it. */
    const stamp = this.now();
    if (!session.lastSeenAt || stamp - session.lastSeenAt >= LAST_SEEN_STEP_MS) {
      await this.storage.put(`session:${hash}`, { ...session, lastSeenAt: stamp });
    }
    return hash;
  }

  async pruneSessions() {
    const now = this.now();
    const sessions = await this.storage.list({ prefix: 'session:' });
    for (const [key, session] of sessions) {
      if (session.expiresAt <= now) await this.storage.delete(key);
    }
  }

  /** Drop all but the newest sessions, and report how many places are left. */
  async trimSessions(keep = MAX_SESSIONS) {
    await this.pruneSessions();
    const entries = [...(await this.storage.list({ prefix: 'session:' }))].sort(
      (left, right) => (right[1].lastSeenAt ?? 0) - (left[1].lastSeenAt ?? 0)
    );
    for (const [key] of entries.slice(keep)) await this.storage.delete(key);
    return Math.min(entries.length, keep);
  }

  async pruneHistory() {
    const entries = await this.storage.list({ prefix: 'history:' });
    const versions = [...entries.keys()]
      .map((key) => Number(key.slice('history:'.length)))
      .sort((left, right) => right - left);

    for (const version of versions.slice(HISTORY_LIMIT)) {
      await this.storage.delete(`history:${version}`);
    }
  }
}
