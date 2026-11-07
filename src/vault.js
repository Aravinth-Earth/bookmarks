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

const MAX_CT_CHARS = 1_400_000;
const HISTORY_LIMIT = 3;
const NONCE_TTL_MS = 60_000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_FAILURES = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

const ACCOUNT_ID = /^[A-Za-z0-9_-]{22}$/;
const AUTH_SECRET = /^[A-Za-z0-9_-]{43}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const SESSION_HASH = 43;

const encoder = new TextEncoder();

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
    if (path === '/vault' && request.method === 'GET') return this.readVault(request);
    if (path === '/vault' && request.method === 'PUT') return this.writeVault(request);

    return json({ error: 'not_found' }, 404);
  }

  /** One-time provisioning, called by the Worker with the provisioning token already checked. */
  async createAccount(request) {
    if (request.method !== 'POST') return json({ error: 'method' }, 405);

    const body = await request.json().catch(() => null);
    const accountId = body?.accountId;
    const authSecret = body?.authSecret;

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

    await this.storage.put('account', {
      accountId,
      authSecret,
      createdAt: this.now(),
      lastSeenAt: this.now()
    });
    return json({ ok: true }, 201);
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

    const account = await this.storage.get('account');
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

    const body = await request.json().catch(() => null);
    const proof = body?.proof;
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
    await this.storage.put('account', { ...account, lastSeenAt: now });
    await this.pruneSessions();

    const token = toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
    const expiresAt = now + SESSION_TTL_MS;
    await this.storage.put(`session:${await sessionHash(token)}`, { expiresAt, createdAt: now });

    return json({ token, expiresAt });
  }

  async logout(request) {
    const auth = await this.authorize(request);
    if (!auth) return json({ error: 'unauthorized' }, 401);

    await this.storage.delete(`session:${auth}`);
    return json({ ok: true });
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

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') return json({ error: 'invalid' }, 400);

    const { baseVersion, iv, ct } = body;
    if (!Number.isInteger(baseVersion) || baseVersion < 0) {
      return json({ error: 'bad_version' }, 400);
    }
    if (typeof iv !== 'string' || iv.length !== 16 || !BASE64URL.test(iv)) {
      return json({ error: 'bad_iv' }, 400);
    }
    if (typeof ct !== 'string' || ct.length === 0 || !BASE64URL.test(ct)) {
      return json({ error: 'bad_ct' }, 400);
    }
    if (ct.length > MAX_CT_CHARS) return json({ error: 'too_large' }, 413);

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

    const account = await this.storage.get('account');
    if (account) await this.storage.put('account', { ...account, lastSeenAt: updatedAt });

    return json(vault);
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
    return hash;
  }

  async pruneSessions() {
    const now = this.now();
    const sessions = await this.storage.list({ prefix: 'session:' });
    for (const [key, session] of sessions) {
      if (session.expiresAt <= now) await this.storage.delete(key);
    }
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
