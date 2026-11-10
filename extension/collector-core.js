/**
 * The collector — a count of the addresses this browser opened, and the ways a row leaves it.
 *
 * Nothing here measures time. A visit is one navigation to one address; how long the page stayed open, and which
 * tab was in front, are not asked and not stored. That is why there is no dwell state, no timer and no session
 * store: the only question this module answers is "which addresses, and how many times".
 *
 * Every function is over an injected store and an injected clock, so `node --test` runs the whole thing without a
 * browser. Every mutation runs through one promise chain: a tab event and a restore of ten tabs arrive as
 * independent promises, each write is a read-modify-write over the whole map, and without the chain the last writer
 * wins and a visit is dropped.
 *
 * No row here is ever encrypted or synced. The list is plain text on this device, and leaving it here is what
 * makes "collected links are local only" true without a single conditional about sync.
 */

import { canonicalUrl, DEFAULT_POLICY, isExcluded, normalizePolicy } from './policy.js';

export const ITEMS_KEY = 'items';
export const POLICY_KEY = 'policy';
export const DAY_KEY = 'day';

/* The same navigation can arrive twice — a page that resolves, then reports a new URL for the same document. Under
   half a minute that is one visit, not two; it is a guard against double events, not a measure of how long anyone
   stayed. */
export const VISIT_DEBOUNCE_MS = 30_000;

const DAY_MS = 86_400_000;

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

  async function readItems() {
    const stored = await persistent.get(ITEMS_KEY);
    return stored && typeof stored === 'object' ? stored : {};
  }

  async function writeItems(items) {
    await persistent.put(ITEMS_KEY, items);
    return items;
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

  /** One visit, folded into the row for that address. Returns the word the caller reports. */
  function countIn(items, canonical, incognito, at) {
    const existing = items[canonical];
    if (existing && at - Date.parse(existing.lastSeenAt) < VISIT_DEBOUNCE_MS) return 'debounced';

    items[canonical] = existing
      ? { ...existing, visits: existing.visits + 1, lastSeenAt: stamp(at), private: incognito }
      : {
          url: canonical,
          host: new URL(canonical).hostname,
          visits: 1,
          firstSeenAt: stamp(at),
          lastSeenAt: stamp(at),
          private: incognito
        };

    return 'captured';
  }

  /**
   * Count one visit. Returns a word, never throws: a tab event handler that throws is a tab the person cannot use,
   * and a refusal here is an answer, not an error.
   */
  async function captureInner(url, { incognito = false, at = now() } = {}) {
    const policy = await readPolicy();
    if (!policy.enabled) return 'off';

    const canonical = canonicalUrl(url);
    if (canonical === null) return 'invalid';
    if (incognito && !policy.includeIncognito) return 'incognito';
    if (isExcluded(canonical, policy.exclude)) return 'excluded';

    const items = await readItems();
    const existing = items[canonical];
    const stored = (await persistent.get(DAY_KEY)) ?? null;
    const today = dayOf(at);
    const used = stored && stored.date === today ? stored.count : 0;

    /* The cap bounds how many new addresses a day may add. A row that is already held is not a new address, so
       re-opening one page must not spend the day's budget. */
    if (policy.dailyCap > 0 && used >= policy.dailyCap && !existing) return 'capped';

    const outcome = countIn(items, canonical, incognito, at);
    if (outcome === 'debounced') return outcome;

    await writeItems(survived(items, policy, at));
    if (!existing) await persistent.put(DAY_KEY, { date: today, count: used + 1 });
    return outcome;
  }

  /**
   * What the page shows. A visit floor is a view filter, not a capture gate: the row is kept and hidden, so raising
   * the floor later finds the history instead of losing it.
   */
  async function listInner() {
    const policy = await readPolicy();
    const kept = survived(await readItems(), policy, now());
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

    const items = await readItems();
    let removed = 0;
    for (const url of wanted) {
      if (items[url]) {
        delete items[url];
        removed += 1;
      }
    }
    await writeItems(items);
    return removed;
  }

  /**
   * Change the policy, then apply it to what is already held: a policy push carries the exclusion list, and an
   * exclusion that only stopped future captures would leave the rows the person just decided to hide in the section.
   */
  async function setPolicyInner(patch) {
    const current = await readPolicy();
    const next = await writePolicy({ ...current, ...(patch && typeof patch === 'object' ? patch : {}) });
    await writeItems(survived(await readItems(), next, now()));
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
    for (const item of Object.values(await readItems())) {
      if (!isExcluded(item.url, next.exclude)) kept[item.url] = item;
    }
    await writeItems(kept);

    return next;
  }

  async function tidyInner(at = now()) {
    const policy = await readPolicy();
    const items = survived(await readItems(), policy, at);
    await writeItems(items);
    return Object.keys(items).length;
  }

  return {
    capture: (url, options) => exclusive(() => captureInner(url, options)),
    list: () => exclusive(() => listInner()),
    forget: (urls) => exclusive(() => forgetInner(urls)),
    promote: (urls) => exclusive(() => forgetInner(urls)),
    dismiss: (urls) => exclusive(() => forgetInner(urls)),
    setPolicy: (patch) => exclusive(() => setPolicyInner(patch)),
    exclude: (entries) => exclusive(() => excludeInner(entries)),
    tidy: (at) => exclusive(() => tidyInner(at))
  };
}
