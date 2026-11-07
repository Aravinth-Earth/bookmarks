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
    const session = await this.request(`/a/${accountId}/login`, { method: 'POST', body: { proof } });

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
   * Create the account on the server. First write wins; a 409 means the account we wanted is
   * the account that exists, so it is success from the caller's point of view.
   */
  async register(accountId, authSecret) {
    const response = await this.request(`/a/${accountId}/account`, {
      method: 'POST',
      body: { accountId, authSecret }
    });

    if (response.status === 201) return { created: true };
    if (response.status === 409) return { created: false };
    if (response.status === 429) {
      throw new SyncError('FULL', 'This server is not accepting new vaults.');
    }
    throw new SyncError('REGISTER_FAILED', 'Could not create the account.', {
      status: response.status
    });
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
    if (response.status === 402) {
      throw new SyncError('TRIAL_ENDED', 'The free sync period has ended.', { status: 402 });
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
