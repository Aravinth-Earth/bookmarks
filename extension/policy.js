/**
 * The capture policy — the one place that decides what the extension may keep.
 *
 * The defaults are the promise: every visit is a candidate, nothing is gated, and collection is off until the
 * vault hands over a policy that says otherwise. Every field a stored or received object can carry is re-derived
 * here, so a hand-edited `chrome.storage` value cannot widen what is kept — a value that is not a number is not a
 * number, and undefined must not become "unlimited" — and a `0` means "no limit" only when it was written as one.
 *
 * Nothing in this file touches `chrome.*`: it is imported by the service worker and by `node --test` alike.
 */

export const MAX_URL_LENGTH = 2048;
export const MAX_EXCLUSIONS = 200;

/* The same three words the vault's tracking levels use: a site, a host, a path. `subdomain` was the word before
   the levels existed and is still accepted, because a stored policy must keep working unedited. */
export const SCOPES = Object.freeze(['site', 'host', 'path']);

/* How a site is recorded, chosen per site: every page (`address`), one row per hostname (`host`), or one row for the
   site and everything under it (`site`). A person who reads YouTube all day does not want a row per video, and the
   same person still wants every page of a documentation site. */
export const RECORD_LEVELS = Object.freeze(['site', 'host', 'address']);
export const MAX_LEVELS = 200;

export const DEFAULT_POLICY = Object.freeze({
  enabled: false,
  levels: Object.freeze([]),
  includeIncognito: false,
  minVisits: 1,
  dailyCap: 0,
  maxEntries: 2000,
  retentionDays: 60,
  exclude: Object.freeze([])
});

/* A query string carries secrets as often as it carries state: an OAuth code, a reset token, a presigned-URL
   signature, a session id. The list is stored in plain text on disk, so a parameter whose name says it is a
   credential is dropped before the address is ever written. It is a denylist, not a filter that can be right —
   the honest description is "the ones that are always secret", and the README says so. */
/* A name that says it is a credential, whoever wrote it: `token`, `access_token`, `X-Amz-Security-Token`,
   `X-Amz-Signature`, `sentry_key`. Exact names cover the common ones; the fragments cover the prefixed forms a
   cloud storage or a single sign-on provider invents, which is where signed URLs live. */
const SECRET_EXACT = new Set([
  'token', 'auth', 'authorization', 'bearer', 'code', 'state', 'ticket', 'otp', 'nonce',
  'sig', 'key', 'pw', 'sid', 'session', 'sessionid', 'jsessionid', 'phpsessid'
]);

const SECRET_FRAGMENTS = [
  'token', 'secret', 'signature', 'password', 'passwd', 'credential', 'session', 'apikey', 'api_key',
  'api-key', 'accesskey', 'privatekey', 'authkey'
];

function namesASecret(name) {
  const lowered = name.toLowerCase();
  return SECRET_EXACT.has(lowered) || SECRET_FRAGMENTS.some((fragment) => lowered.includes(fragment));
}

/**
 * A URL as the extension stores it, or null.
 *
 * Only http and https are kept — `chrome://`, `brave://`, `file://` and an extension's own pages are not links
 * anyone can open again from a vault. The fragment is dropped: `#section` is the same document, and keeping it
 * would split one page into as many rows as it has anchors. Embedded credentials are removed and the query
 * parameters that name a secret are dropped, because this string is written to disk unencrypted.
 */
export function canonicalUrl(input) {
  if (typeof input !== 'string') return null;

  const trimmed = input.trim();
  if (trimmed === '' || trimmed.length > MAX_URL_LENGTH) return null;

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (!parsed.hostname.includes('.') && parsed.hostname !== 'localhost') return null;

  parsed.hash = '';
  parsed.username = '';
  parsed.password = '';

  for (const name of [...parsed.searchParams.keys()]) {
    if (namesASecret(name)) parsed.searchParams.delete(name);
  }

  const href = parsed.href;
  return href.length > MAX_URL_LENGTH ? null : href;
}

/* Only a number is a number. `Number(null)` is 0 and `Number('')` is 0, and both of those would have turned a
   corrupted value into "unlimited" — the opposite of what the default is for. */
function whole(value, fallback, minimum) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum) return fallback;
  return value;
}

/** One exclusion, normalised, or null when it does not name something that can be matched. */
export function normalizeExclude(entry) {
  if (!entry || typeof entry !== 'object') return null;

  const named = entry.scope === 'subdomain' ? 'site' : entry.scope;
  const scope = SCOPES.includes(named) ? named : null;
  if (scope === null) return null;

  const raw = typeof entry.value === 'string' ? entry.value.trim() : '';
  if (raw === '') return null;

  if (scope === 'path') {
    /* The host is case-insensitive and the path is not, so only the host is lowered — lowering the whole value
       made `shop.example/Orders` a rule that could never match the page it was written for. */
    const url = canonicalUrl(raw.includes('://') ? raw : `https://${raw}`);
    if (!url) return null;
    const parsed = new URL(url);
    return { scope, value: `${parsed.hostname.toLowerCase()}${parsed.pathname}` };
  }

  /* A pasted URL brings a path, a query and sometimes a port; a host rule is about the hostname alone, and the
     port is not part of the name the browser compares against. */
  const host = raw
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/[/?#].*$/, '')
    .replace(/:\d+$/, '');

  if (!host.includes('.') && host !== 'localhost') return null;
  return { scope, value: host };
}

/**
 * One recording rule, normalised, or null when it does not name something that can be matched.
 *
 * The rule names a site and what to keep from it. A rule is matched on the host and its subdomains, the same
 * boundary the `site` exclusion uses, so `youtube.com` covers `www.youtube.com` and not `notyoutube.com`.
 */
export function normalizeLevel(entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (!RECORD_LEVELS.includes(entry.level)) return null;

  const raw = typeof entry.site === 'string' ? entry.site.trim() : '';
  if (raw === '') return null;

  const host = raw
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/[/?#].*$/, '')
    .replace(/:\d+$/, '');

  if (!host.includes('.') && host !== 'localhost') return null;
  return { site: host, level: entry.level };
}

/** The rule that covers this hostname, or null. */
export function levelFor(host, levels = []) {
  const name = String(host ?? '').toLowerCase();
  for (const rule of levels) {
    if (name === rule.site || name.endsWith(`.${rule.site}`)) return rule;
  }
  return null;
}

/**
 * The address a visit is recorded under.
 *
 * With no rule, or a rule that says `address`, the page itself is kept. `host` records the hostname's root and
 * `site` records the name the rule was written with — so `www.youtube.com` and `m.youtube.com` stay separate under
 * `host`, while `site` folds both into one row.
 */
export function recordedUrl(url, levels = []) {
  const canonical = canonicalUrl(url);
  if (canonical === null) return null;

  const parsed = new URL(canonical);
  const rule = levelFor(parsed.hostname, levels);
  if (rule === null || rule.level === 'address') return canonical;

  /* `host` keeps the port, so a local or self-hosted address survives the fold; `site` uses the name the rule was
     written with. */
  const name = rule.level === 'host' ? parsed.host : rule.site;
  return `${parsed.protocol}//${name}/`;
}

/** A policy as the extension will hold it. Unknown fields are dropped, not carried forward. */
export function normalizePolicy(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const exclude = Array.isArray(source.exclude) ? source.exclude : [];

  const seen = new Set();
  const kept = [];
  for (const entry of exclude) {
    const normalized = normalizeExclude(entry);
    if (normalized === null) continue;
    const key = `${normalized.scope}|${normalized.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(normalized);
  }

  const levels = Array.isArray(source.levels) ? source.levels : [];
  const seenSites = new Set();
  const keptLevels = [];
  for (const entry of levels) {
    const normalized = normalizeLevel(entry);
    if (normalized === null || seenSites.has(normalized.site)) continue;
    seenSites.add(normalized.site);
    keptLevels.push(normalized);
  }

  return {
    enabled: source.enabled === true,
    levels: keptLevels.slice(0, MAX_LEVELS),
    includeIncognito: source.includeIncognito === true,
    minVisits: whole(source.minVisits, DEFAULT_POLICY.minVisits, 1),
    dailyCap: whole(source.dailyCap, DEFAULT_POLICY.dailyCap, 0),
    maxEntries: whole(source.maxEntries, DEFAULT_POLICY.maxEntries, 0),
    retentionDays: whole(source.retentionDays, DEFAULT_POLICY.retentionDays, 0),
    exclude: kept.slice(0, MAX_EXCLUSIONS)
  };
}

/**
 * Whether a URL is excluded.
 *
 * The match is over the host and the path, never the scheme, so an exclusion written from a plain-http visit still
 * covers the secure page — the two are the same site, and a guard that let one through would be the bug it exists
 * to prevent. A path is whole segments: excluding `/orders` must not also exclude `/orders-old`. A URL that cannot
 * be canonicalised is treated as excluded, because there is no reason to store something that can never be opened
 * again — and `capture` reaches this only after its own refusal, so the rule holds on both paths.
 */
export function isExcluded(url, exclude = []) {
  const canonical = canonicalUrl(url);
  if (canonical === null) return true;

  const parsed = new URL(canonical);
  const host = parsed.hostname;

  for (const entry of exclude) {
    if (!entry) continue;

    if (entry.scope === 'host' && host === entry.value) return true;

    if (entry.scope === 'site' && (host === entry.value || host.endsWith(`.${entry.value}`))) return true;

    if (entry.scope === 'path') {
      const slash = entry.value.indexOf('/');
      const entryHost = slash === -1 ? entry.value : entry.value.slice(0, slash);
      const entryPath = slash === -1 ? '/' : entry.value.slice(slash);
      const whole =
        entryPath === '/' ||
        parsed.pathname === entryPath ||
        parsed.pathname.startsWith(`${entryPath}/`);
      if (host === entryHost && whole) return true;
    }
  }

  return false;
}
