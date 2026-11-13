/**
 * The client half of sync: sign in, read the sealed blob, write a new one.
 *
 * It never sees a bookmark. The blob arrives sealed and is opened by `crypto.js` with the key
 * that never leaves the page; this module only moves three strings and a version number.
 *
 * The session token is kept in memory and nowhere else. Re-signing in costs one challenge, one
 * HMAC and one request, which is cheaper than leaving a bearer token at rest on a device.
 */

import { proveAuth } from './crypto.js';

/**
 * The only thing the server is told about this device: one word, no user agent, no name.
 * It is what makes the account's session list readable as "2 places".
 */
export function clientKind() {
  try {
    const coarse = globalThis.matchMedia?.('(pointer: coarse)');
    if (!coarse) return 'unknown';
    return coarse.matches ? 'mobile' : 'desktop';
  } catch {
    return 'unknown';
  }
}

export class SyncError extends Error {
  constructor(code, message, { status = 0, current = null, currentVersion = 0 } = {}) {
    super(message);
    this.name = 'SyncError';
    this.code = code;
    this.status = status;
    this.current = current;
    this.currentVersion = currentVersion;
  }
}

/**
 * What a failed sync means to the person reading about it.
 *
 * The page owns the words it shows for a refusal that needs an address in it, so the cap case
 * carries no `message`: it is the only failure with its own persistent notice. Every other case
 * returns one sentence that a wrong phrase, a dead connection, an account that does not exist and
 * a full server cannot share — those are different events and reading one as another is a lie.
 */
export function describeSyncFailure(error) {
  const code = typeof error?.code === 'string' ? error.code : 'NETWORK';
  const status = Number(error?.status) || 0;

  switch (code) {
    case 'FULL':
      return { kind: 'cap', label: 'No new accounts' };
    case 'LOGIN_FAILED':
      return status === 401
        ? {
            kind: 'phrase',
            label: 'Not signed in',
            message: 'The phrase did not match this account.'
          }
        : {
            kind: 'server',
            label: 'Not synced',
            message: 'The server refused the sign-in.'
          };
    case 'NO_ACCOUNT':
      return {
        kind: 'missing',
        label: 'Account not found',
        message: 'This vault is not registered on the server.'
      };
    case 'LOCKED':
      return { kind: 'locked', label: 'Locked out', message: 'Too many attempts. Try again later.' };
    case 'CONFLICT':
      return {
        kind: 'conflict',
        label: 'Sync conflict',
        message: 'Another device changed the vault at the same time.'
      };
    case 'UNAUTHORIZED':
      return { kind: 'unauthorized', label: 'Signing in…' };
    case 'PUSH_FAILED':
      return status === 413
        ? {
            kind: 'size',
            label: 'Vault too large',
            message:
              'This vault is larger than the server allows. Export a sealed backup and trim it.'
          }
        : { kind: 'server', label: 'Not synced', message: 'The server did not save the vault.' };
    case 'PULL_FAILED':
      return { kind: 'server', label: 'Not synced', message: 'The server did not send the vault.' };
    case 'REGISTER_FAILED':
      return {
        kind: 'server',
        label: 'Not synced',
        message: 'The server did not create the account.'
      };
    /* The invite refusals share a kind because the page asks for a code in one place, but each
       keeps its own sentence: "find a code", "that one is spent" and "that one is past its date"
       ask the person to do three different things. */
    case 'INVITE_REQUIRED':
      return {
        kind: 'invite',
        label: 'Invite needed',
        message: 'This server needs an invite code to create an account.'
      };
    case 'INVITE_USED':
      return {
        kind: 'invite',
        label: 'Invite used',
        message: 'That invite code has already been used.'
      };
    case 'INVITE_EXPIRED':
      return {
        kind: 'invite',
        label: 'Invite expired',
        message: 'That invite code has expired.'
      };
    case 'CHALLENGE_FAILED':
      return { kind: 'server', label: 'Not synced', message: 'The server did not answer.' };
    case 'SESSIONS_FAILED':
      return {
        kind: 'server',
        label: 'Not synced',
        message: 'The server did not list the connected places.'
      };
    default:
      return {
        kind: 'network',
        label: 'Offline',
        message: 'No connection to the server. The vault still works on this device.'
      };
  }
}

/**
 * The three ways a registry can turn a creation down when a code is in play. Each is its own
 * failure rather than one "refused" bucket because the person holding the phone has to do a
 * different thing about each: ask for a code, ask for a fresh one, or ask for a code that has
 * not run out. `null` for any other status, which the caller handles on its own terms.
 */
function inviteFailure(status) {
  switch (status) {
    case 403:
      return new SyncError(
        'INVITE_REQUIRED',
        'This server needs an invite code to create an account.',
        { status }
      );
    case 422:
      return new SyncError('INVITE_USED', 'That invite code has already been used.', { status });
    case 410:
      return new SyncError('INVITE_EXPIRED', 'That invite code has expired.', { status });
    default:
      return null;
  }
}

export class SyncClient {
  constructor({ base = '/w/bookmarks/api', fetch: fetchImpl = globalThis.fetch.bind(globalThis) } = {}) {
    this.base = base.replace(/\/+$/, '');
    this.fetch = fetchImpl;
    this.token = null;
    this.accountId = null;
  }

  get signedIn() {
    return typeof this.token === 'string' && this.token !== '';
  }

  async request(path, { method = 'GET', body, token = null } = {}) {
    const headers = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (token) headers.authorization = `Bearer ${token}`;

    const response = await this.fetch(`${this.base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
      cache: 'no-store'
    });

    const payload = await response.json().catch(() => ({}));
    return { status: response.status, ok: response.ok, payload };
  }

  async login(accountId, authSecret) {
    const challenge = await this.request(`/a/${accountId}/challenge`, { method: 'POST' });
    if (challenge.status === 404) {
      throw new SyncError('NO_ACCOUNT', 'This vault is not registered on the server.');
    }
    if (!challenge.ok || typeof challenge.payload.nonce !== 'string') {
      throw new SyncError('CHALLENGE_FAILED', 'The server did not answer.', {
        status: challenge.status
      });
    }

    const proof = await proveAuth(authSecret, accountId, challenge.payload.nonce);
    const session = await this.request(`/a/${accountId}/login`, {
      method: 'POST',
      body: { proof, client: clientKind() }
    });

    if (session.status === 429) {
      throw new SyncError('LOCKED', 'Too many attempts. Try again later.', { status: 429 });
    }
    if (!session.ok || typeof session.payload.token !== 'string') {
      throw new SyncError('LOGIN_FAILED', 'The server refused the sign-in.', {
        status: session.status
      });
    }

    this.token = session.payload.token;
    this.accountId = accountId;
    return session.payload;
  }

  /**
   * Create the account on the server.
   *
   * The first request writes nothing: the server answers 428 with a nonce, and the proof is the
   * same HMAC that signing in uses, so an account cannot be created for an id whose phrase the
   * caller does not hold. A second attempt is made when the nonce was spent or replaced before
   * the proof arrived, which is what two devices creating the same account at once looks like.
   *
   * `created: false` means the account already existed and this caller proved the same secret,
   * so a retried creation is success and does not take a second slot.
   *
   * `invite` is the code an invite-only server asks for. It defaults to an empty string rather
   * than being left off, because the account route reads an empty code as "none offered" and the
   * second request must describe the same creation as the first one did.
   */
  async register(accountId, authSecret, invite = '') {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await this.registerOnce(accountId, authSecret, invite);
      if (result) return result;
    }
    throw new SyncError('REGISTER_FAILED', 'Could not create the account.');
  }

  /** One creation round trip. `null` means the challenge was stale and is worth retrying. */
  async registerOnce(accountId, authSecret, invite = '') {
    const challenge = await this.request(`/a/${accountId}/account`, {
      method: 'POST',
      body: { accountId, authSecret, invite }
    });

    if (challenge.status === 429) {
      throw new SyncError('FULL', 'This server is not accepting new vaults.');
    }
    if (challenge.status === 409) return { created: false };
    const inviteRefused = inviteFailure(challenge.status);
    if (inviteRefused) throw inviteRefused;
    if (challenge.status !== 428 || typeof challenge.payload.nonce !== 'string') {
      throw new SyncError('REGISTER_FAILED', 'Could not create the account.', {
        status: challenge.status
      });
    }

    const proof = await proveAuth(authSecret, accountId, challenge.payload.nonce);
    const response = await this.request(`/a/${accountId}/account`, {
      method: 'POST',
      body: { accountId, authSecret, proof, invite }
    });

    if (response.status === 201) return { created: true };
    if (response.status === 200) return { created: false };
    if (response.status === 429) {
      throw new SyncError('FULL', 'This server is not accepting new vaults.');
    }
    /* The registry only decides about the code after the proof checks out, so the refusal
       normally lands on this second request; the first check above is for a server that says
       no earlier. */
    const proofRefused = inviteFailure(response.status);
    if (proofRefused) throw proofRefused;
    if (response.status === 401 || response.status === 428) return null;
    throw new SyncError('REGISTER_FAILED', 'Could not create the account.', {
      status: response.status
    });
  }

  /**
   * Whether this account exists on the server, answered without a session. The challenge route
   * is the cheapest honest question: it 404s for an account that was never created.
   */
  async accountExists(accountId) {
    const response = await this.request(`/a/${accountId}/challenge`, { method: 'POST' });
    if (response.status === 404) return false;
    if (response.ok && typeof response.payload.nonce === 'string') return true;
    throw new SyncError('CHALLENGE_FAILED', 'The server did not answer.', {
      status: response.status
    });
  }

  /** The places this account is signed in on. Needs a live session; no key material moves. */
  async sessions() {
    this.requireSession();
    const response = await this.request(`/a/${this.accountId}/sessions`, { token: this.token });

    if (response.status === 401) {
      this.token = null;
      throw new SyncError('UNAUTHORIZED', 'The session expired.');
    }
    if (!response.ok) {
      throw new SyncError('SESSIONS_FAILED', 'Could not read the connected places.', {
        status: response.status
      });
    }
    return response.payload;
  }

  /** @returns {Promise<{version: number, iv: string, ct: string, updatedAt: number} | null>} */
  async pull() {
    this.requireSession();
    const response = await this.request(`/a/${this.accountId}/vault`, { token: this.token });

    if (response.status === 401) {
      this.token = null;
      throw new SyncError('UNAUTHORIZED', 'The session expired.');
    }
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new SyncError('PULL_FAILED', 'Could not read the vault.', { status: response.status });
    }
    return response.payload;
  }

  /**
   * @returns {Promise<{conflict: boolean, version?: number, current?: object, currentVersion?: number}>}
   */
  async push(baseVersion, sealed) {
    this.requireSession();
    const response = await this.request(`/a/${this.accountId}/vault`, {
      method: 'PUT',
      token: this.token,
      body: { baseVersion, iv: sealed.iv, ct: sealed.ct }
    });

    if (response.status === 401) {
      this.token = null;
      throw new SyncError('UNAUTHORIZED', 'The session expired.');
    }
    if (response.status === 409) {
      return {
        conflict: true,
        currentVersion: response.payload.currentVersion ?? 0,
        current: response.payload.current ?? null
      };
    }
    if (!response.ok) {
      throw new SyncError('PUSH_FAILED', 'Could not save to the server.', {
        status: response.status
      });
    }
    return { conflict: false, version: response.payload.version, updatedAt: response.payload.updatedAt };
  }

  async logout() {
    if (!this.signedIn) return;
    const accountId = this.accountId;
    const token = this.token;
    this.token = null;
    try {
      await this.request(`/a/${accountId}/logout`, { method: 'POST', token });
    } catch {
      /* A session that outlives the call expires on its own. */
    }
  }

  requireSession() {
    if (!this.signedIn) {
      throw new SyncError('UNAUTHORIZED', 'Not signed in.');
    }
  }
}
