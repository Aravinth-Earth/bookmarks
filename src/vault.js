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

/* One paid unit is about ten bookmarks; 10 units is about a hundred. The cap is bytes because
   the server cannot count entries in a sealed vault. */
export const UNIT_CT_CHARS = 14_000;
/* The owner's balance. It is a number like anyone else's, so the paid path is the same code. */
export const OWNER_UNITS = 100;
/* About 11 units: roughly a hundred bookmarks with icons. */
export const FREE_MAX_CT_CHARS = 160_000;
export const FREE_TRIAL_MS = 30 * 24 * 60 * 60 * 1000;
export const READ_ONLY_GRACE_MS = 7 * 24 * 60 * 60 * 1000;
const OWNER_RECHECK_MS = 365 * 24 * 60 * 60 * 1000;
const HISTORY_LIMIT = 3;
const NONCE_TTL_MS = 60_000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/* A session's last-seen stamp is written only when it is this stale, so an ordinary read or
   write does not each cost a storage write. */
const LAST_SEEN_STEP_MS = 60 * 60 * 1000;
/* What a client says it is. Anything else is stored as unknown; no user agent is kept. */
const CLIENT_KINDS = new Set(['mobile', 'desktop']);
/* One sign-in is one place. The oldest are dropped rather than accumulated forever. */
const MAX_SESSIONS = 20;
const MAX_FAILURES = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

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

  /** One-time provisioning, called by the Worker with the provisioning token already checked. */
  async createAccount(request) {
    if (request.method !== 'POST') return json({ error: 'method' }, 405);

    const body = await readJson(request, MAX_SMALL_BODY);
    if (body.tooLarge) return json({ error: 'too_large' }, 413);

    const accountId = body.value?.accountId;
    const authSecret = body.value?.authSecret;

    if (!ACCOUNT_ID.test(accountId ?? '') || !AUTH_SECRET.test(authSecret ?? '')) {
      return json({ error: 'invalid' }, 400);
    }
    /* The object's own name is the account id, so a provisioning call cannot write one
       account's secret into another account's object. */
    if (this.ctx.id?.name && this.ctx.id.name !== accountId) {
      return json({ error: 'mismatch' }, 400);
    }

    const existing = await this.storage.get('account');
    if (existing) return json({ error: 'exists' }, 409);

    /* The cap lives in one object, so creation is serialised against it. An existing account
       never reaches this point, so a full registry cannot lock out the person who already has
       one, and a retried first sync cannot consume a second slot. */
    const registry = this.env?.REGISTRY;
    if (registry) {
      const stub = registry.get(registry.idFromName('registry'));
      const reserved = await stub.fetch(
        new Request('https://registry/reserve', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ accountId })
        })
      );
      if (!reserved.ok) return json({ error: 'full' }, 429);
    }

    /* Creation always starts free. Ownership is only granted after a successful proof of the
       phrase, so a leaked owner id cannot be used to pre-create the account and claim the plan. */
    const now = this.now();
    const plan = 'free';
    const trialEndsAt = now + FREE_TRIAL_MS;
    const units = 0;

    await this.storage.put('account', {
      accountId,
      authSecret,
      plan,
      units,
      createdAt: now,
      lastSeenAt: now,
      trialEndsAt,
      paidUntil: null
    });

    if (plan === 'free' && typeof this.storage.setAlarm === 'function') {
      await this.storage.setAlarm(trialEndsAt);
    }

    return json({ ok: true, plan, trialEndsAt }, 201);
  }

  async challenge(request) {
    if (request.method !== 'POST') return json({ error: 'method' }, 405);

    const account = await this.storage.get('account');
    if (!account) return json({ error: 'no_account' }, 404);

    const nonce = toBase64Url(crypto.getRandomValues(new Uint8Array(16)));
    await this.storage.put('nonce', { value: nonce, expiresAt: this.now() + NONCE_TTL_MS });
    return json({ nonce });
  }

  async login(request) {
    if (request.method !== 'POST') return json({ error: 'method' }, 405);

    let account = await this.storage.get('account');
    if (!account) return json({ error: 'no_account' }, 404);

    const now = this.now();
    const lock = (await this.storage.get('lock')) ?? { failures: 0, until: 0 };
    if (lock.until > now) {
      return json({ error: 'locked', retryAfter: Math.ceil((lock.until - now) / 1000) }, 429);
    }

    const nonce = await this.storage.get('nonce');
    if (!nonce || nonce.expiresAt <= now) {
      await this.storage.delete('nonce');
      return json({ error: 'challenge_expired' }, 401);
    }
    /* Single use: spent whether the proof is right or wrong, so a captured proof cannot be
       replayed and a guess cannot be retried against the same challenge. */
    await this.storage.delete('nonce');

    const body = await readJson(request, MAX_SMALL_BODY);
    if (body.tooLarge) return json({ error: 'too_large' }, 413);

    const proof = body.value?.proof;
    const client = CLIENT_KINDS.has(body.value?.client) ? body.value.client : 'unknown';
    const ok =
      typeof proof === 'string' && proof.length > 0
        ? await verifyProof(account.authSecret, account.accountId, nonce.value, proof)
        : false;

    if (!ok) {
      const failures = lock.failures + 1;
      const locked = failures >= MAX_FAILURES;
      await this.storage.put('lock', {
        failures: locked ? 0 : failures,
        until: locked ? now + LOCKOUT_MS : 0
      });
      return json({ error: 'bad_proof' }, 401);
    }

    await this.storage.put('lock', { failures: 0, until: 0 });

    /* The flag can be set after the account already exists: the next login upgrades it. */
    account = await this.claimOwner(account);
    await this.storage.put('account', { ...account, lastSeenAt: now });
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
      units: account.units ?? 0,
      trialEndsAt: account.trialEndsAt ?? null,
      paidUntil: account.paidUntil ?? null,
      places
    });
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

    if (this.trialEnded(account)) {
      return json({ error: 'trial_ended' }, 402);
    }

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

    const upgraded = { ...account, plan: 'owner', units: OWNER_UNITS, trialEndsAt: null };
    await this.storage.put('account', upgraded);
    return upgraded;
  }

  /**
   * Dates, sizes and counts for an operator view: how much space an account holds against its
   * cap, when it was last seen, whether its trial has run out.
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
      units: account.units ?? 0,
      createdAt: account.createdAt ?? null,
      lastSeenAt: account.lastSeenAt ?? null,
      trialEndsAt: account.trialEndsAt ?? null,
      paidUntil: account.paidUntil ?? null,
      vaultVersion: vault.version ?? 0,
      ctChars: typeof vault.ct === 'string' ? vault.ct.length : 0,
      updatedAt: vault.updatedAt ?? null,
      capChars: this.capChars(account),
      readOnly: this.trialEnded(account),
      sessions
    });
  }

  /** Paid and owner accounts hold a number of units; free accounts hold a fixed trial size. */
  capChars(account) {
    if (account.plan === 'owner' || account.plan === 'paid') {
      const units = Number.isInteger(account.units) ? account.units : 0;
      return Math.max(0, units) * UNIT_CT_CHARS;
    }
    return FREE_MAX_CT_CHARS;
  }

  /** A free trial that has run out is read-only: the data can still be read and exported. */
  trialEnded(account) {
    if (!account || account.plan === 'owner' || account.plan === 'paid') return false;
    if (account.paidUntil && account.paidUntil > this.now()) return false;
    return typeof account.trialEndsAt === 'number' && this.now() >= account.trialEndsAt;
  }

  /**
   * The deadline the runtime wakes this object for: the end of the trial, then the end of the
   * read-only grace, then deletion. An owner or a paying account is rescheduled a year out.
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

    const trialEnds = account.trialEndsAt ?? 0;
    if (now < trialEnds) {
      await this.storage.setAlarm(trialEnds);
      return;
    }
    if (now < trialEnds + READ_ONLY_GRACE_MS) {
      await this.storage.setAlarm(trialEnds + READ_ONLY_GRACE_MS);
      return;
    }

    await this.releaseSlot(account.accountId);
    await this.storage.deleteAll();
  }

  /** Give the account's slot back, so the cap frees itself as trials end. */
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
