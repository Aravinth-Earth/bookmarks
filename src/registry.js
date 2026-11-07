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

const MAX_BODY = 4 * 1024;

async function readJson(request, max = MAX_BODY) {
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
    if (path === '/release' && request.method === 'POST') return this.release(request);
    if (path === '/stats' && request.method === 'GET') {
      const accounts = (await this.storage.get('accounts')) ?? [];
      return json({ count: accounts.length, max: this.max() });
    }

    return json({ error: 'not_found' }, 404);
  }

  async reserve(request) {
    const body = await readJson(request);
    if (body.tooLarge) return json({ error: 'too_large' }, 413);

    const accountId = body.value?.accountId;

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

  /**
   * Free a slot when its account is deleted. Unknown ids are a no-op, so a retried deletion is
   * harmless.
   */
  async release(request) {
    const body = await readJson(request);
    if (body.tooLarge) return json({ error: 'too_large' }, 413);

    const accountId = body.value?.accountId;

    if (!ACCOUNT_ID.test(accountId ?? '')) return json({ error: 'invalid' }, 400);

    const accounts = (await this.storage.get('accounts')) ?? [];
    const remaining = accounts.filter((id) => id !== accountId);
    if (remaining.length !== accounts.length) await this.storage.put('accounts', remaining);

    return json({ ok: true, count: remaining.length, max: this.max() });
  }
}
