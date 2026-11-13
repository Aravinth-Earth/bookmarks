/**
 * The collector — a count of the addresses this browser opened, and the ways a row leaves it.
 *
 * Nothing here measures time. A visit is one navigation to one address; how long the page stayed open, and which
 * tab was in front, are not asked and not stored. That is why there is no dwell state, no timer and no session
 * store: the only question this module answers is "which addresses, and how many times".
 *
 * Every address is its own key. One capture is one read and one write of one row, so the cost of a visit does not
 * grow with the size of the list. That is not a tidiness preference: the list was one object that had to be
 * rewritten whole on every visit, and a measured 2200-address day in one profile kept only 1192 of them because the
 * rewrite fell behind the navigations and Chrome dropped the events. The list is now a set of independent rows,
 * which is also what it always was.
 *
 * The list is bounded by `tidy`, by the vault reading it, and by any policy push — not by the visit itself. A visit
 * writes one row and stops; a cap enforced during capture was the other half of the same slow rewrite.
 *
 * Every function is over an injected store and an injected clock, so `node --test` runs the whole thing without a
 * browser. Every mutation runs through one promise chain, so a tab event and a restore of ten tabs cannot land on
 * each other.
 *
 * No row here is ever encrypted or synced. The list is plain text on this device, and leaving it here is what
 * makes "collected links are local only" true without a single conditional about sync.
 */

import { canonicalUrl, DEFAULT_POLICY, isExcluded, normalizePolicy, recordedUrl } from './policy.js';

/** One address per key. The prefix keeps these apart from `policy` and `day` on the same store. */
export const ITEM_PREFIX = 'u:';
/** The map this module used to keep every row in. Read once, then gone. */
export const ITEMS_KEY = 'items';
export const POLICY_KEY = 'policy';
export const DAY_KEY = 'day';

const DAY_MS = 86_400_000;

const itemKey = (url) => `${ITEM_PREFIX}${url}`;

/**
 * The calendar day of a moment, in the machine's own timezone: a UTC day would roll the daily cap over at 05:30
 * for a user in India, five and a half hours into their day.
 */
function dayOf(at) {
  const when = new Date(at);
  const pad = (value) => String(value).padStart(2, '0');
  return `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`;
}

function stamp(at) {
  return new Date(at).toISOString();
}

export function createCollector({ persistent, now = Date.now }) {
  /* One write at a time, in arrival order. The chain never rejects, so a refused visit cannot poison the next. */
  let chain = Promise.resolve();
  function exclusive(step) {
    const run = chain.then(step, step);
    chain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  async function readPolicy() {
    return normalizePolicy((await persistent.get(POLICY_KEY)) ?? DEFAULT_POLICY);
  }

  async function writePolicy(policy) {
    const normalized = normalizePolicy(policy);
    await persistent.put(POLICY_KEY, normalized);
    return normalized;
  }

  /**
   * Every row on the store, keyed by address.
   *
   * A build before this one kept the whole list in one `items` object; it is split into rows on the first read and
   * the old key is removed, so an installed copy upgrades itself instead of showing an empty section.
   */
  async function readAll() {
    const stored = (await persistent.all()) ?? {};
    const legacy = stored[ITEMS_KEY];
    const rows = {};

    for (const [key, value] of Object.entries(stored)) {
      if (key.startsWith(ITEM_PREFIX) && value && typeof value === 'object' && value.url) rows[value.url] = value;
    }

    if (legacy && typeof legacy === 'object') {
      const carried = Object.values(legacy).filter((row) => row && typeof row === 'object' && row.url);
      if (carried.length > 0) {
        const entries = {};
        for (const row of carried) if (!rows[row.url]) entries[itemKey(row.url)] = row;
        if (Object.keys(entries).length > 0) await persistent.putMany(entries);
        for (const row of carried) rows[row.url] ??= row;
      }
      await persistent.remove(ITEMS_KEY);
    }

    return rows;
  }

  /**
   * What survives one policy: what the exclusions cover, then the retention window, then the entry cap, both
   * counted from `lastSeenAt` so the rows kept are the ones seen most recently. A zero is unlimited, not a wipe.
   */
  function survived(items, policy, at) {
    let kept = Object.values(items).filter((item) => !isExcluded(item.url, policy.exclude));

    if (policy.retentionDays > 0) {
      const cutoff = at - policy.retentionDays * DAY_MS;
      kept = kept.filter((item) => Date.parse(item.lastSeenAt) >= cutoff);
    }

    if (policy.maxEntries > 0 && kept.length > policy.maxEntries) {
      /* Rows the person is allowed to see go first. A visit floor hides rows without deleting them, and a cap that
         spent itself on hidden rows could empty the section while the history it hid sits underneath. */
      const visible = (item) => (Number.isInteger(item.visits) ? item.visits : 0) >= policy.minVisits;
      kept = [...kept]
        .sort(
          (left, right) =>
            Number(visible(right)) - Number(visible(left)) ||
            right.lastSeenAt.localeCompare(left.lastSeenAt)
        )
        .slice(0, policy.maxEntries);
    }

    const next = {};
    for (const item of kept) next[item.url] = item;
    return next;
  }

  /** Delete the rows a policy no longer keeps, and leave every kept row alone. */
  async function dropUnkept(kept) {
    const rows = await readAll();
    const gone = Object.keys(rows).filter((url) => !kept[url]).map(itemKey);
    if (gone.length > 0) await persistent.removeMany(gone);
    return gone.length;
  }

  /**
   * One visit, folded into the row for that address.
   *
   * An open is an open: a reload, a duplicated tab and a new window are three opens of the same address and the
   * count says three. Nothing here compares times — the event that calls this fires once per finished page load,
   * so a count can only be raised by a page actually being opened again.
   */
  function counted(canonical, existing, incognito, at) {
    return existing
      ? { ...existing, visits: existing.visits + 1, lastSeenAt: stamp(at), private: incognito }
      : {
          url: canonical,
          host: new URL(canonical).hostname,
          visits: 1,
          firstSeenAt: stamp(at),
          lastSeenAt: stamp(at),
          private: incognito
        };
  }

  /**
   * Count one visit. Returns a word, never throws: a tab event handler that throws is a tab the person cannot use,
   * and a refusal here is an answer, not an error.
   */
  async function captureInner(url, { incognito = false, at = now() } = {}) {
    const policy = await readPolicy();
    if (!policy.enabled) return 'off';

    const seen = canonicalUrl(url);
    if (seen === null) return 'invalid';
    if (incognito && !policy.includeIncognito) return 'incognito';
    if (isExcluded(seen, policy.exclude)) return 'excluded';

    /* A rule can say that this site is recorded as a hostname or as one row, so a video page and the video page
       opened twice are the same row as the site's front door. */
    const canonical = recordedUrl(seen, policy.levels);
    const existing = await persistent.get(itemKey(canonical));

    const stored = (await persistent.get(DAY_KEY)) ?? null;
    const today = dayOf(at);
    const used = stored && stored.date === today ? stored.count : 0;

    /* The cap bounds how many new addresses a day may add. A row that is already held is not a new address, so
       re-opening one page must not spend the day's budget. */
    if (policy.dailyCap > 0 && used >= policy.dailyCap && !existing) return 'capped';

    await persistent.put(itemKey(canonical), counted(canonical, existing, incognito, at));
    if (!existing) await persistent.put(DAY_KEY, { date: today, count: used + 1 });
    return 'captured';
  }

  /**
   * What the page shows. A visit floor is a view filter, not a capture gate: the row is kept and hidden, so raising
   * the floor later finds the history instead of losing it.
   */
  async function listInner() {
    const policy = await readPolicy();
    const kept = survived(await readAll(), policy, now());
    return {
      policy,
      items: Object.values(kept)
        .filter((item) => (Number.isInteger(item.visits) ? item.visits : 0) >= policy.minVisits)
        .map((item) => ({ ...item }))
    };
  }

  /**
   * Forget these addresses. Promotion is this call, made after the bookmark exists: it is what makes "the same
   * entry in both sections" impossible, and it is idempotent so a lost reply can be retried.
   */
  async function forgetInner(urls) {
    const wanted = new Set(
      (Array.isArray(urls) ? urls : []).map(canonicalUrl).filter((url) => url !== null)
    );
    if (wanted.size === 0) return 0;

    const keys = [];
    for (const url of wanted) if ((await persistent.get(itemKey(url))) !== undefined) keys.push(itemKey(url));
    if (keys.length > 0) await persistent.removeMany(keys);
    return keys.length;
  }

  /**
   * Change the policy, then apply it to what is already held: a policy push carries the exclusion list, and an
   * exclusion that only stopped future captures would leave the rows the person just decided to hide in the section.
   */
  async function setPolicyInner(patch) {
    const current = await readPolicy();
    const next = await writePolicy({ ...current, ...(patch && typeof patch === 'object' ? patch : {}) });
    await dropUnkept(survived(await readAll(), next, now()));
    return next;
  }

  /**
   * Exclude these scopes and drop every row they cover. The sweep runs against the policy as it was persisted, not
   * against the entries handed in: past the exclusion cap a rule can be dropped, and deleting rows for a rule that
   * does not exist would lose data to nothing.
   */
  async function excludeInner(entries) {
    const current = await readPolicy();
    const next = await writePolicy({
      ...current,
      exclude: [...current.exclude, ...(Array.isArray(entries) ? entries : [])]
    });

    const kept = {};
    for (const item of Object.values(await readAll())) {
      if (!isExcluded(item.url, next.exclude)) kept[item.url] = item;
    }
    await dropUnkept(kept);

    return next;
  }

  /**
   * Delete everything collected: the rows, the day's counter and the policy's exclusion list. The policy itself
   * stays, so collection keeps the shape the vault gave it — clearing is "forget what you have", not "stop".
   */
  async function clearInner() {
    const rows = await readAll();
    const keys = Object.keys(rows).map(itemKey);
    if (keys.length > 0) await persistent.removeMany(keys);
    await persistent.remove(DAY_KEY);
    return 0;
  }

  /** The place a cap or a retention window is applied to the store, on a timer and not on the visit. */
  async function tidyInner(at = now()) {
    const policy = await readPolicy();
    const kept = survived(await readAll(), policy, at);
    await dropUnkept(kept);
    return Object.keys(kept).length;
  }

  return {
    capture: (url, options) => exclusive(() => captureInner(url, options)),
    list: () => exclusive(() => listInner()),
    forget: (urls) => exclusive(() => forgetInner(urls)),
    promote: (urls) => exclusive(() => forgetInner(urls)),
    dismiss: (urls) => exclusive(() => forgetInner(urls)),
    setPolicy: (patch) => exclusive(() => setPolicyInner(patch)),
    exclude: (entries) => exclusive(() => excludeInner(entries)),
    clear: () => exclusive(() => clearInner()),
    tidy: (at) => exclusive(() => tidyInner(at))
  };
}
