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
/* What is left after a person deletes their account: a date, and nothing else. It is the only
   key in the object then, and it is what makes deletion stick against a device that is still
   signed in — login answers `account_deleted`, not `no_account`. */
const TOMBSTONE_KEY = 'deleted';
/* The operator's switch. It lives beside the account, not inside the sealed blob: the server
   has to read it before any proof is checked, and it must survive the vault being replaced. */
const ADMIN_DISABLED_KEY = 'admin-disabled';
const ADMIN_SECRET_HEADER = 'x-admin-secret';
/* The Worker's digest of the caller's address. A malformed header is not a source. */
const SOURCE_DIGEST = /^[0-9a-f]{64}$/;
/* The one bucket used when the object was reached without a source, as a test or a binding is. */
const UNATTRIBUTED = 'unattributed';

const ACCOUNT_ID = /^[A-Za-z0-9_-]{22}$/;
const AUTH_SECRET = /^[A-Za-z0-9_-]{43}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const SESSION_HASH = 43;
/* Eight random bytes, base64url: an id a person may read and a route may name, never the token
   and never its digest. */
const SESSION_ID = /^[A-Za-z0-9_-]{11}$/;

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

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...headers
    }
  });
}

/**
 * The refusal for a verb a route does not answer.
 *
 * `allow` is the part that makes a 405 useful: without it the caller is told it was wrong and
 * nothing about how to be right, and a caller reading only the status retries the same verb.
 */
function methodNotAllowed(methods) {
  return json({ error: 'method' }, 405, { allow: methods.join(', ') });
}

/**
 * Whether the caller says its body is JSON.
 *
 * Parameters after the type are ignored, because `application/json; charset=utf-8` is still
 * JSON. Anything else is refused before it is parsed: a body the parser was never promised is a
 * fault in the request, not in its contents, so answering "invalid JSON" would blame the wrong
 * thing.
 */
function isJson(request) {
  const type = (request.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  return type === 'application/json';
}

/* 415 rather than 405: the verb is allowed on this route, the representation is not. */
function unsupportedMediaType() {
  return json({ error: 'unsupported_media_type' }, 415);
}

/* Ending one place is `/sessions/<id>`, whose tail names an id rather than a route. */
const SESSION_ONE = '/sessions/';

/**
 * What each route answers, and whether it reads a body.
 *
 * Naming the methods here instead of testing for the one a handler wants is what makes a wrong
 * verb a 405 that says which ones work: a route that answers every verb hides the caller's
 * mistake, and a route that answers none of them silently is a 404 that hides the route. `json`
 * marks the routes that parse a body, so the media type is checked in one place rather than at
 * each of the six handlers that read one.
 */
const ROUTES = {
  '/admin-stats': { methods: ['GET'] },
  '/admin-disable': { methods: ['POST'], json: true },
  '/admin-enable': { methods: ['POST'] },
  '/admin-delete': { methods: ['POST'], json: true },
  '/status': { methods: ['GET'] },
  '/account': { methods: ['POST'], json: true },
  '/challenge': { methods: ['POST'] },
  '/login': { methods: ['POST'], json: true },
  '/logout': { methods: ['POST'] },
  '/delete': { methods: ['POST'], json: true },
  '/sessions': { methods: ['GET'] },
  [SESSION_ONE]: { methods: ['DELETE'] },
  '/vault': { methods: ['GET', 'PUT'], json: true }
};

/** The route a path names, or null when nothing answers there. */
function routeOf(path) {
  return ROUTES[path] ?? (path.startsWith(SESSION_ONE) ? ROUTES[SESSION_ONE] : null);
}

/* Constant-time comparison for the operator secret, so a wrong guess learns nothing from timing. */
function sameSecret(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  if (a.length === 0 || a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= a[index] ^ b[index];
  return difference === 0;
}

/** The operator routes are reachable only through a Worker binding and with the shared secret. */
function adminAllowed(request, env) {
  const secret = typeof env?.ADMIN_SECRET === 'string' ? env.ADMIN_SECRET : '';
  const given = request.headers.get(ADMIN_SECRET_HEADER) ?? '';
  return secret.length >= 16 && sameSecret(given, secret);
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

    const route = routeOf(path);
    if (!route) return json({ error: 'not_found' }, 404);
    if (!route.methods.includes(request.method)) return methodNotAllowed(route.methods);
    /* A body has to say it is JSON before it is read. A request with no body is still answered,
       because `/challenge` and `/logout` take a token and nothing else. */
    if (route.json && request.body && !isJson(request)) return unsupportedMediaType();

    if (path === '/admin-stats') return this.adminStats();
    if (path === '/admin-disable') return this.adminDisable(request);
    if (path === '/admin-enable') return this.adminEnable(request);
    if (path === '/admin-delete') return this.adminDelete(request);
    if (path === '/status') return this.status();
    if (path === '/account') return this.createAccount(request);
    if (path === '/challenge') return this.challenge(request);
    if (path === '/login') return this.login(request);
    /* Ending a session is the one write a URL alone must not cause: it used to be dispatched on
       the path, so a prefetcher or an image tag could sign a person out with a plain GET. It is
       in the table above as POST for that reason. */
    if (path === '/logout') return this.logout(request);
    if (path === '/delete') return this.deleteAccount(request);
    if (path === '/sessions') return this.listSessions(request);
    if (path.startsWith(SESSION_ONE)) {
      return this.revokeSession(request, path.slice(SESSION_ONE.length));
    }
    /* `/vault` is the one path with two verbs, and the check above has already refused the rest. */
    if (path === '/vault') {
      return request.method === 'PUT' ? this.writeVault(request) : this.readVault(request);
    }

    return json({ error: 'not_found' }, 404);
  }

  /**
   * The refusal every account route answers while the operator's switch is on.
   *
   * It is checked before a proof or a body is read: a disabled account costs no HMAC, no
   * storage write and no chance to try the phrase. The state carries the timestamp only; the
   * reason is for the operator, not for the caller.
   */
  async refuseDisabled() {
    const state = await this.storage.get(ADMIN_DISABLED_KEY);
    if (!state) return null;
    return json({ error: 'account_disabled', disabledAt: state.at ?? null }, 403);
  }

  /** The date this account was deleted, or null while it exists. */
  async tombstone() {
    const state = await this.storage.get(TOMBSTONE_KEY);
    return state && typeof state.at === 'number' ? state : null;
  }

  /**
   * The refusal a device that still holds a deleted account is owed.
   *
   * It is 410 and `account_deleted`, never 404: `404 no_account` is the answer that tells a
   * client "never created", and the client's next step for that is to create it again. A
   * deletion must not be undone by the next sync on another device.
   */
  deletedRefusal(tombstone) {
    return json({ error: 'account_deleted', deletedAt: tombstone.at }, 410);
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
    const shut = await this.refuseDisabled();
    if (shut) return shut;

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
         that secret belongs to. A tombstone is the exception: an id that was deleted is not
         offered a new creation challenge unless this server hands out codes, because a challenge
         is the first step of the path that would re-create it. */
      const tombstone = await this.tombstone();
      if (tombstone && !this.invitesRequired()) return this.deletedRefusal(tombstone);

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

    /* A deleted id is not re-created unless this server hands out codes and the code passed the
       Registry below. On a server without codes only the operator's route clears the tombstone;
       that is the documented way back, and it is deliberate rather than an oversight. */
    const tombstone = await this.tombstone();
    if (tombstone && !this.invitesRequired()) return this.deletedRefusal(tombstone);

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
    /* A code passed the Registry, which is the explicit way back. The tombstone goes with the
       creation it no longer describes. */
    await this.storage.delete(TOMBSTONE_KEY);

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
    const shut = await this.refuseDisabled();
    if (shut) return shut;

    const account = await this.storage.get('account');
    if (!account) {
      /* A deleted account is not a missing one: the caller must not be told to register. */
      const tombstone = await this.tombstone();
      if (tombstone) return this.deletedRefusal(tombstone);
      return json({ error: 'no_account' }, 404);
    }

    const live = await this.storage.get('nonce');
    if (live && live.expiresAt > this.now()) return json({ nonce: live.value });

    const nonce = toBase64Url(crypto.getRandomValues(new Uint8Array(16)));
    await this.storage.put('nonce', { value: nonce, expiresAt: this.now() + NONCE_TTL_MS });
    return json({ nonce });
  }

  async login(request) {
    const shut = await this.refuseDisabled();
    if (shut) return shut;

    let account = await this.storage.get('account');
    if (!account) {
      /* No account answers to this id, so there is no account reference to write either. A
         tombstone is still an answer, and it is not the one that leads to a registration. */
      const tombstone = await this.tombstone();
      if (tombstone) return this.deletedRefusal(tombstone);
      await logEvent('signin_failed', { route: 'signin', reason: 'no_account' });
      return json({ error: 'no_account' }, 404);
    }

    const now = this.now();
    const source = sourceOf(request);
    const refused = await this.lockedOut(account, source, now);
    if (refused) return refused;

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
      await this.recordBadProof(account.accountId, source, now);
      return json({ error: 'bad_proof' }, 401);
    }

    /* A correct proof clears this source immediately, and the account's throttle with it. */
    await this.storage.delete(await this.failureKey(account.accountId, source));
    await this.storage.delete(ATTEMPTS_KEY);

    /* The flag can be set after the account already exists: the next login upgrades it. */
    account = await this.claimOwner(account);
    /* Kept in this local too, so the answer below reads the moment that was just stored rather
       than the one it replaced. */
    account = { ...account, lastSeenAt: now };
    await this.storage.put('account', account);
    await this.pruneSessions();

    const token = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
    /* The public name of this sign-in: eight random bytes, never the token and never its hash.
       It is what the place list shows and what "sign out this place" names. */
    const id = toBase64Url(crypto.getRandomValues(new Uint8Array(8)));
    const expiresAt = now + SESSION_TTL_MS;
    await this.storage.put(`session:${await sessionHash(token)}`, {
      id,
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

  /**
   * The refusal a locked source or a throttled account owes, or null.
   *
   * Signing in and deleting are both proofs of the phrase, so they share this guard: a route
   * that checked a proof without it would be a second, unthrottled place to guess. It writes the
   * same line the sign-in path writes, because it is the same event.
   */
  async lockedOut(account, source, now) {
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
       delay the owner by at most the cap; it cannot keep him out. */
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

    return null;
  }

  /**
   * One more wrong proof from a source: five is that source's lock, and every failure after the
   * account's twentieth inside a minute is a growing wait. The same arithmetic signs in and
   * deletes, so a wrong phrase never has a cheaper route than the one it was tried on.
   */
  async recordBadProof(accountId, source, now) {
    const failureKey = await this.failureKey(accountId, source);
    const stored = await this.storage.get(failureKey);
    const failures = this.sourceFailures(stored, now);
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

    const attempts = await this.storage.get(ATTEMPTS_KEY);
    await this.storage.put(ATTEMPTS_KEY, this.nextAttempts(attempts, now));
  }

  async logout(request) {
    const shut = await this.refuseDisabled();
    if (shut) return shut;

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
    const shut = await this.refuseDisabled();
    if (shut) return shut;

    const auth = await this.authorize(request);
    if (!auth) return json({ error: 'unauthorized' }, 401);

    await this.pruneSessions();

    const sessions = [...(await this.storage.list({ prefix: 'session:' }))]
      .map(([key, session]) => ({
        /* The public name of the sign-in. A session written before this id existed has none, and
           the page offers no action for one: there is nothing to name it by. */
        id: SESSION_ID.test(session.id ?? '') ? session.id : null,
        client: CLIENT_KINDS.has(session.client) ? session.client : 'unknown',
        createdAt: session.createdAt ?? 0,
        lastSeenAt: session.lastSeenAt ?? session.createdAt ?? 0,
        expiresAt: session.expiresAt ?? 0,
        current: key === `session:${auth}`
      }))
      .sort((left, right) => right.lastSeenAt - left.lastSeenAt);

    return json({ count: sessions.length, sessions });
  }

  /**
   * End one place.
   *
   * The caller authorizes with its own live token; the place is named by its public id, which
   * the list handed out and which is not the token or its hash. The account, the sealed vault
   * and every other place are untouched. The last place may be ended, including this one: a
   * person who has lost a device should be able to cut it off even when it is the only one.
   */
  async revokeSession(request, id) {
    const shut = await this.refuseDisabled();
    if (shut) return shut;

    const auth = await this.authorize(request);
    if (!auth) return json({ error: 'unauthorized' }, 401);

    if (!SESSION_ID.test(id)) return json({ error: 'not_found' }, 404);

    const sessions = await this.storage.list({ prefix: 'session:' });
    for (const [key, session] of sessions) {
      if (session.id !== id) continue;
      await this.storage.delete(key);
      const count = [...(await this.storage.list({ prefix: 'session:' }))].length;
      return json({ ok: true, current: key === `session:${auth}`, count });
    }

    return json({ error: 'not_found' }, 404);
  }

  async readVault(request) {
    const shut = await this.refuseDisabled();
    if (shut) return shut;

    const auth = await this.authorize(request);
    if (!auth) return json({ error: 'unauthorized' }, 401);

    const vault = await this.storage.get('vault');
    if (!vault) return json({ error: 'no_vault' }, 404);
    return json(vault);
  }

  async writeVault(request) {
    const shut = await this.refuseDisabled();
    if (shut) return shut;

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

  /**
   * Delete what the server holds, behind a session and a fresh proof of the phrase.
   *
   * A session alone is not enough for a destructive act, and a proof alone is not enough to
   * show the caller is signed in. Both are required: the bearer token names the account's
   * session, and the HMAC over the last unspent nonce proves the caller holds the phrase. A
   * wrong proof is counted exactly as a failed sign-in is, so this route is not a cheaper way to
   * guess.
   *
   * What remains is one key: the date. A device still holding the phrase is answered 410
   * `account_deleted`, never 404 — `404` is the answer that makes a client create the account
   * again. The Registry's slot goes back, and nothing else about the person stays here.
   */
  async deleteAccount(request) {
    const account = await this.storage.get('account');
    if (!account) {
      /* A second submit, or a device that was told "deleted" and asked again: the tombstone is
         the no-op answer, and it needs no session to give it. */
      const gone = await this.tombstone();
      if (gone) return this.deletedRefusal(gone);
      return json({ error: 'unauthorized' }, 401);
    }

    const shut = await this.refuseDisabled();
    if (shut) return shut;

    const auth = await this.authorize(request);
    if (!auth) return json({ error: 'unauthorized' }, 401);

    const now = this.now();
    const source = sourceOf(request);
    const refused = await this.lockedOut(account, source, now);
    if (refused) return refused;

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
    /* Spent before it is compared, like every other proof: one nonce, one attempt. */
    await this.storage.delete('nonce');

    const body = await readJson(request, MAX_SMALL_BODY);
    if (body.tooLarge) return json({ error: 'too_large' }, 413);

    const proof = body.value?.proof;
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
      await this.recordBadProof(account.accountId, source, now);
      return json({ error: 'bad_proof' }, 401);
    }

    const accountId = account.accountId;
    const deletedAt = now;

    /* Every key this object owns: the account, the vault, its history, every session, the live
       nonces, the attempts and the per-source failures. The list is read once, before any of it
       is deleted, because deleting while listing would skip entries. */
    const keys = [...(await this.storage.list())].map(([key]) => key);
    for (const key of keys) await this.storage.delete(key);
    if (typeof this.storage.deleteAlarm === 'function') await this.storage.deleteAlarm();

    await this.storage.put(TOMBSTONE_KEY, { at: deletedAt });
    await this.releaseSlot(accountId);

    /* The one served request in this file that writes a line: a deletion is not a refusal, but
       it is the event an operator most needs to be able to count. */
    await logEvent('account_deleted', { route: 'vault', account: accountId });

    return json({ ok: true, deletedAt });
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
  /**
   * The one question a locked device may ask without a proof: does this account exist, and is
   * the operator's switch on? It answers no vault content and no account metadata; the id is
   * already a hash of the phrase. The app asks it only when sync is on.
   */
  async status() {
    const account = await this.storage.get('account');
    if (!account) {
      /* Deleted is an answer, and a different one from never-created. */
      const tombstone = await this.tombstone();
      if (tombstone) return this.deletedRefusal(tombstone);
      return json({ exists: false, disabled: false }, 404);
    }
    const disabled = await this.storage.get(ADMIN_DISABLED_KEY);
    return json({
      exists: true,
      disabled: Boolean(disabled),
      disabledAt: disabled?.at ?? null
    });
  }

  /**
   * Turn the operator's switch on or off. Both routes are binding-only and secret-guarded.
   *
   * Disabling never touches the vault, the account or a session: it is a refusal checked ahead
   * of every account route. Re-enabling is the same write in reverse, so a mistake is not
   * permanent and does not cost the slot.
   */
  async adminDisable(request) {
    if (!adminAllowed(request, this.env)) return json({ error: 'unauthorized' }, 401);
    const body = await readJson(request, 4096);
    if (body.tooLarge) return json({ error: 'too_large' }, 413);

    const account = await this.storage.get('account');
    if (!account) return json({ error: 'no_account' }, 404);

    const reason = typeof body.value?.reason === 'string' ? body.value.reason.trim().slice(0, 200) : '';
    const by = typeof body.value?.by === 'string' ? body.value.by.trim().slice(0, 100) : '';
    const disabled = { at: this.now(), reason, by };
    await this.storage.put(ADMIN_DISABLED_KEY, disabled);
    return json({ ok: true, disabled });
  }

  async adminEnable(request) {
    if (!adminAllowed(request, this.env)) return json({ error: 'unauthorized' }, 401);
    await this.storage.delete(ADMIN_DISABLED_KEY);
    return json({ ok: true });
  }

  /**
   * End an account from the operator side: no phrase is available and none is needed.
   *
   * The same key list as the user-facing deletion, then the Registry release. No tombstone:
   * this is a removal, not a ban — the operator can disable instead when the phrase must not
   * come back. A second call is a no-op, so a double submit cannot fail halfway.
   */
  async adminDelete(request) {
    if (!adminAllowed(request, this.env)) return json({ error: 'unauthorized' }, 401);
    const body = await readJson(request, 4096);
    if (body.tooLarge) return json({ error: 'too_large' }, 413);

    const account = await this.storage.get('account');
    const accountId = account?.accountId ?? this.ctx?.id?.name ?? '';

    const keys = [...(await this.storage.list())].map(([key]) => key);
    for (const key of keys) await this.storage.delete(key);
    if (typeof this.storage.deleteAlarm === 'function') await this.storage.deleteAlarm();

    if (accountId) await this.releaseSlot(accountId);
    return json({ ok: true, deleted: keys.length > 0 });
  }

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
      sessions,
      disabled: (await this.storage.get(ADMIN_DISABLED_KEY)) ?? null
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

  /**
   * Whether this server hands out codes. It is the same variable the Registry reads, and it
   * decides one thing here: a tombstone can only be cleared by a creation that presents one.
   */
  invitesRequired() {
    return String(this.env?.INVITES_REQUIRED ?? '').toLowerCase() === 'true';
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
