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

import { MAX_CODES_PER_CALL, MAX_INVITES, INVITE_TTL_MS, hashCode, newCode, shortHash } from './invites.js';

const ACCOUNT_ID = /^[A-Za-z0-9_-]{22}$/;
const DAY_MS = 86_400_000;

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

  /**
   * The number of accounts this server will hold.
   *
   * The operator's page can set it, and a set value outranks the deploy: raising a cap should not need a deploy, and
   * lowering it never deletes an account that already exists — it only stops the next one.
   */
  async max() {
    const stored = Number((await this.settings()).maxAccounts);
    if (Number.isInteger(stored) && stored > 0) return stored;
    const configured = Number(this.env?.MAX_ACCOUNTS);
    return Number.isInteger(configured) && configured > 0 ? configured : MAX_ACCOUNTS;
  }

  async settings() {
    return (await this.storage.get('settings')) ?? {};
  }

  /* Whether a new account needs a code. A var, so the same build can run open on a laptop and closed in public. */
  invitesRequired() {
    return String(this.env?.INVITES_REQUIRED ?? '').toLowerCase() === 'true';
  }

  async invites() {
    return (await this.storage.get('invites')) ?? [];
  }

  async fetch(request) {
    const path = new URL(request.url).pathname;

    if (path === '/reserve' && request.method === 'POST') return this.reserve(request);
    if (path === '/invites' && request.method === 'GET') return this.listInvites();
    if (path === '/invites/new' && request.method === 'POST') return this.createInvites(request);
    if (path === '/invites/revoke' && request.method === 'POST') return this.revokeInvite(request);
    if (path === '/settings' && request.method === 'GET') return json({ settings: await this.settings(), max: await this.max() });
    if (path === '/settings' && request.method === 'POST') return this.saveSettings(request);
    if (path === '/release' && request.method === 'POST') return this.release(request);
    /* Operator route: the ids the cap is counted from, for a Worker bound to this object. */
    if (path === '/admin-list' && request.method === 'GET') {
      const accounts = (await this.storage.get('accounts')) ?? [];
      return json({ ids: accounts.slice(), count: accounts.length, max: await this.max() });
    }
    if (path === '/stats' && request.method === 'GET') {
      const accounts = (await this.storage.get('accounts')) ?? [];
      return json({ count: accounts.length, max: await this.max() });
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
      return json({ ok: true, alreadyReserved: true, count: accounts.length, max: await this.max() });
    }

    /* The cap is counted over accounts only: a code already handed out is a promise of a slot, which is why the
       generator will not promise more of them than there are slots (see `/invites/new`). */
    if (accounts.length >= await this.max()) {
      return json({ error: 'full', max: await this.max() }, 429);
    }

    /* How this account came to exist is written down with it, so the operator view can say whether a vault paid for
       itself, came in on a code, or was the first one on the server. An account that already exists is never
       re-decided: this branch is only reached on creation. */
    const firstOnServer = accounts.length === 0;
    let via = firstOnServer ? 'owner' : 'direct';

    if (this.invitesRequired()) {
      const hash = typeof body.value?.inviteHash === 'string' ? body.value.inviteHash : '';
      const invites = await this.invites();
      const at = hash === '' ? -1 : invites.findIndex((entry) => entry.hash === hash);

      if (at === -1) return json({ error: 'invite_required' }, 403);

      const invite = invites[at];
      if (invite.usedAt) return json({ error: 'invite_used' }, 422);
      if (invite.expiresAt <= Date.now()) return json({ error: 'invite_expired' }, 410);

      /* Marked here, inside the one object that owns the list, so two creations cannot spend the same code. */
      invites[at] = { ...invite, usedAt: Date.now(), accountId };
      await this.storage.put('invites', invites);
      via = 'invite';
    }

    accounts.push(accountId);
    await this.storage.put('accounts', accounts);
    return json({ ok: true, via, count: accounts.length, max: await this.max() });
  }

  /**
   * Free a slot when its account is deleted. Unknown ids are a no-op, so a retried deletion is
   * harmless.
   */
  /**
   * The cap, set from the operator's page.
   *
   * It never deletes anything: an account that exists keeps existing, and a lower cap only refuses the next one.
   * Codes already handed out are promises of slots, so the page is told how many of them the new cap can still keep.
   */
  async saveSettings(request) {
    const body = await readJson(request);
    if (body.tooLarge) return json({ error: 'too_large' }, 413);

    const wanted = Number(body.value?.maxAccounts);
    if (!Number.isInteger(wanted) || wanted < 0 || wanted > 5000) return json({ error: 'invalid' }, 400);

    const current = await this.settings();
    const settings = { ...current };
    if (wanted === 0) delete settings.maxAccounts;
    else settings.maxAccounts = wanted;

    await this.storage.put('settings', settings);

    const accounts = (await this.storage.get('accounts')) ?? [];
    const live = (await this.invites()).filter((entry) => !entry.usedAt && entry.expiresAt > Date.now()).length;

    return json({ ok: true, settings, max: await this.max(), accounts: accounts.length, live });
  }

  /**
   * Mint codes.
   *
   * A code is a promise that a slot will be free, so the number of live codes plus the number of accounts can never
   * pass the cap: asking for more than there is room for hands back what fits and says so, rather than promising
   * slots that do not exist.
   */
  async createInvites(request) {
    const body = await readJson(request);
    if (body.tooLarge) return json({ error: 'too_large' }, 413);

    const wanted = Number(body.value?.count ?? 1);
    const days = Number(body.value?.days ?? INVITE_TTL_MS / DAY_MS);
    const count = Number.isInteger(wanted) && wanted > 0 ? Math.min(wanted, MAX_CODES_PER_CALL) : 1;
    const ttl = Number.isFinite(days) && days > 0 ? Math.min(days, 90) * DAY_MS : INVITE_TTL_MS;

    const now = Date.now();
    const accounts = (await this.storage.get('accounts')) ?? [];
    const invites = (await this.invites()).filter((entry) => entry.usedAt || entry.expiresAt > now);

    const live = invites.filter((entry) => !entry.usedAt).length;
    const room = (await this.max()) - accounts.length - live;
    if (room <= 0) {
      return json({ error: 'no_room_for_codes', accounts: accounts.length, live, max: await this.max() }, 429);
    }

    const made = Math.min(count, room);
    const codes = [];
    for (let index = 0; index < made; index += 1) {
      const code = newCode();
      codes.push(code);
      invites.push({ hash: await hashCode(code), createdAt: now, expiresAt: now + ttl, usedAt: null });
    }

    /* The list stays bounded: oldest spent codes go first when it is full. */
    invites.sort((left, right) => Number(Boolean(left.usedAt)) - Number(Boolean(right.usedAt)) || left.createdAt - right.createdAt);
    await this.storage.put('invites', invites.slice(-MAX_INVITES));

    return json({ codes, expiresAt: now + ttl, roomLeft: room - made, accounts: accounts.length, max: await this.max() });
  }

  /** The codes, named by a digest prefix: enough to revoke one, useless to anyone reading the list. */
  async listInvites() {
    const now = Date.now();
    const accounts = (await this.storage.get('accounts')) ?? [];
    const invites = await this.invites();

    return json({
      accounts: accounts.length,
      max: await this.max(),
      required: this.invitesRequired(),
      invites: invites
        .slice()
        .sort((left, right) => right.createdAt - left.createdAt)
        .map((entry) => ({
          id: shortHash(entry.hash),
          createdAt: entry.createdAt,
          expiresAt: entry.expiresAt,
          usedAt: entry.usedAt ?? null,
          usedBy: entry.accountId ? shortHash(entry.accountId) : null,
          state: entry.usedAt ? 'used' : entry.expiresAt <= now ? 'expired' : 'live'
        }))
    });
  }

  /** Spend nothing: a revoked code is simply gone, and a used one cannot be revoked. */
  async revokeInvite(request) {
    const body = await readJson(request);
    if (body.tooLarge) return json({ error: 'too_large' }, 413);

    const hash = String(body.value?.hash ?? body.value?.id ?? '');
    if (hash === '') return json({ error: 'invalid' }, 400);

    const invites = await this.invites();
    const kept = invites.filter((entry) => {
      const matches = body.value?.id ? shortHash(entry.hash) === hash : entry.hash === hash;
      return !(matches && !entry.usedAt);
    });

    if (kept.length === invites.length) return json({ error: 'not_found' }, 404);

    await this.storage.put('invites', kept);
    return json({ ok: true, revoked: invites.length - kept.length });
  }

  async release(request) {
    const body = await readJson(request);
    if (body.tooLarge) return json({ error: 'too_large' }, 413);

    const accountId = body.value?.accountId;

    if (!ACCOUNT_ID.test(accountId ?? '')) return json({ error: 'invalid' }, 400);

    const accounts = (await this.storage.get('accounts')) ?? [];
    const remaining = accounts.filter((id) => id !== accountId);
    if (remaining.length !== accounts.length) await this.storage.put('accounts', remaining);

    return json({ ok: true, count: remaining.length, max: await this.max() });
  }
}
