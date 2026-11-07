/**
 * Bookmarks — the account cap.
 *
 * One instance of this class exists. It holds the set of account ids that have been created and
 * refuses a new one once the cap is reached, so opening creation to everyone cannot turn this
 * Worker into unbounded free storage.
 *
 * Reserving is idempotent: the same account id can be presented again by a retried first sync
 * without consuming a second slot. This is the same job `Registry` does for splitter's rooms.
 */

const ACCOUNT_ID = /^[A-Za-z0-9_-]{22}$/;

/* A var of the same name can override this without a code change. */
export const MAX_ACCOUNTS = 50;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  });
}

export class Registry {
  constructor(ctx, env) {
    this.storage = ctx.storage;
    this.env = env;
  }

  max() {
    const configured = Number(this.env?.MAX_ACCOUNTS);
    return Number.isInteger(configured) && configured > 0 ? configured : MAX_ACCOUNTS;
  }

  async fetch(request) {
    const path = new URL(request.url).pathname;

    if (path === '/reserve' && request.method === 'POST') return this.reserve(request);
    if (path === '/stats' && request.method === 'GET') {
      const accounts = (await this.storage.get('accounts')) ?? [];
      return json({ count: accounts.length, max: this.max() });
    }

    return json({ error: 'not_found' }, 404);
  }

  async reserve(request) {
    const body = await request.json().catch(() => null);
    const accountId = body?.accountId;

    if (!ACCOUNT_ID.test(accountId ?? '')) return json({ error: 'invalid' }, 400);

    const accounts = (await this.storage.get('accounts')) ?? [];
    if (accounts.includes(accountId)) {
      return json({ ok: true, alreadyReserved: true, count: accounts.length, max: this.max() });
    }

    if (accounts.length >= this.max()) {
      return json({ error: 'full', max: this.max() }, 429);
    }

    accounts.push(accountId);
    await this.storage.put('accounts', accounts);
    return json({ ok: true, count: accounts.length, max: this.max() });
  }
}
