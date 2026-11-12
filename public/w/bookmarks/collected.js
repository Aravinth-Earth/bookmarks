/**
 * Collected links — folding the extension's rows into what the section shows.
 *
 * The extension stores one row per address. Every view here is a read-time fold of those rows, so changing the
 * level never loses a count: a page belongs to one host and a host to one site, and each level sums to the same
 * total.
 *
 * Two orders, and only one of them is a ranking. `visits` ranks the level's own rows against each other with no
 * parent above them — a subdomain with five visits sits where five visits belongs even when its site has
 * thousands. `domain` groups: a site holds its hosts, a host holds its addresses, and the counts roll up. A
 * roll-up is a sum of rows that are also on screen, so it is never compared against them in the same ranking.
 */

export const LEVELS = Object.freeze(['domains', 'hosts', 'addresses']);
/* `visits`, `recent` and `name` rank one level's own rows; `domain` is the only grouped order. The first three are
   the toolbar's own sort modes, so the section can follow the control that is already on the page. */
export const ORDERS = Object.freeze(['visits', 'recent', 'name', 'domain']);
export const DEFAULT_LEVEL = 'addresses';
export const DEFAULT_ORDER = 'visits';

/* A site is the registrable name, and the list of two-part suffixes is a table rather than a public-suffix list:
   a suffix that is missing folds two sites into one row, which is cosmetic and one line to fix. */
const SECOND_LEVEL = new Set([
  'co.in', 'co.uk', 'co.jp', 'co.nz', 'co.za', 'co.il', 'co.id', 'co.kr', 'co.th', 'co.ve',
  'com.au', 'com.br', 'com.cn', 'com.mx', 'com.sg', 'com.tr', 'com.tw', 'com.ar', 'com.hk', 'com.my',
  'net.in', 'org.in', 'ac.in', 'gov.in', 'nic.in', 'res.in', 'edu.in', 'firm.in', 'gen.in', 'ind.in',
  'github.io', 'gitlab.io', 'netlify.app', 'vercel.app', 'pages.dev', 'workers.dev', 'web.app',
  'firebaseapp.com', 'herokuapp.com', 'azurewebsites.net', 'blogspot.com', 'wordpress.com',
  'substack.com', 'neocities.org', 'appspot.com', 'onrender.com', 'glitch.me', 'surge.sh',
  'deno.dev', 'val.town', 'bearblog.dev', 'hashnode.dev', 's3.amazonaws.com'
]);

/** The site a host belongs to: the last two labels, or three when the last two are a known suffix. */
export function siteOf(host) {
  const labels = String(host ?? '').toLowerCase().split('.').filter(Boolean);

  /* An address is its own site: `127.0.0.1` has two labels but no registrable name, and taking the last two would
     turn it into `0.1`. */
  if (labels.length === 4 && labels.every((label) => /^\d{1,3}$/.test(label))) return labels.join('.');
  if (labels.length <= 2) return labels.join('.');
  const lastTwo = labels.slice(-2).join('.');
  return SECOND_LEVEL.has(lastTwo) ? labels.slice(-3).join('.') : lastTwo;
}

/**
 * The label of one address: what the browser's own address bar shows, without the scheme.
 *
 * `ta.wikipedia.org/wiki/முதற்பக்கம்` is a page a person recognises; `%E0%AE%AE...` is the same page written for a
 * machine, and a path on its own loses the site it belongs to — so the host stays and the escapes are decoded.
 */
export function addressLabel(url) {
  let shown = url;
  try {
    const parsed = new URL(url);
    shown = `${parsed.host}${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }

  try {
    return decodeURI(shown).replace(/\/$/, '') || shown;
  } catch {
    return shown.replace(/\/$/, '');
  }
}

/* The level names the group; a row names what it is. `domains`.slice(0, -1) is `domain`, but `addresses` is not. */
const KIND = Object.freeze({ domains: 'site', hosts: 'host', addresses: 'address' });

/**
 * The recording rule that covers a hostname, or null.
 *
 * The rules are the extension's, mirrored here so an existing list folds the same way a new visit is recorded — a
 * rule added today changes what the section shows today, not only what it collects tomorrow.
 */
export function levelFor(host, levels = []) {
  const name = String(host ?? '').toLowerCase();
  for (const rule of Array.isArray(levels) ? levels : []) {
    if (name === rule.site || name.endsWith(`.${rule.site}`)) return rule;
  }
  return null;
}

/** The address a visit is counted under, given the rules. `address` and no rule both keep the page itself. */
export function recordedUrl(url, levels = []) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }

  const rule = levelFor(parsed.hostname, levels);
  if (rule === null || rule.level === 'address') return url;

  /* `host` keeps the port, so a local or self-hosted address survives the fold; `site` uses the name the rule was
     written with. */
  const name = rule.level === 'host' ? parsed.host : rule.site;
  return `${parsed.protocol}//${name}/`;
}

/**
 * The rows as the rules say they should be counted: every address the extension holds, folded to the level its site
 * asked for, with repeats summed.
 */
function recordedItems(items, levels) {
  const folded = new Map();

  for (const item of items) {
    const url = recordedUrl(item.url, levels);
    const seen = folded.get(url);
    if (seen) {
      seen.visits += item.visits;
      if (item.lastSeenAt > seen.lastSeenAt) seen.lastSeenAt = item.lastSeenAt;
      continue;
    }
    folded.set(url, { url, host: hostOf(url), visits: item.visits, lastSeenAt: item.lastSeenAt });
  }

  return [...folded.values()];
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function byVisits(left, right) {
  if (right.visits !== left.visits) return right.visits - left.visits;
  return String(left.label).localeCompare(String(right.label));
}

/** One unit at the requested level: a site, a host, or a single address. */
function unitsFor(items, level) {
  const units = new Map();

  for (const item of items) {
    const key =
      level === 'addresses' ? item.url : level === 'hosts' ? item.host : siteOf(item.host);
    const label = level === 'addresses' ? addressLabel(item.url) : level === 'hosts' ? item.host : key;

    const unit = units.get(key) ?? {
      key,
      kind: KIND[level],
      label,
      url: null,
      visits: 0,
      lastSeenAt: null,
      addresses: []
    };
    unit.visits += item.visits;
    unit.addresses.push(item.url);
    if (typeof item.lastSeenAt === 'string' && (unit.lastSeenAt === null || item.lastSeenAt > unit.lastSeenAt)) {
      unit.lastSeenAt = item.lastSeenAt;
    }

    /* An address row adds itself; a row that rolls children up adds its root, because promoting every page under a
       site from one tap would spend the vault's cap in a single click. The root keeps the scheme and the port the
       page actually used, so a self-hosted address does not come back as a bare host root. */
    if (level === 'addresses') {
      unit.url = item.url;
    } else if (unit.url === null) {
      try {
        const parsed = new URL(item.url);
        unit.url = `${parsed.protocol}//${level === 'hosts' ? parsed.host : key}/`;
      } catch {
        unit.url = `https://${key}/`;
      }
    }
    units.set(key, unit);
  }

  return units;
}

function byOrder(order) {
  if (order === 'recent') {
    return (left, right) =>
      String(right.lastSeenAt ?? '').localeCompare(String(left.lastSeenAt ?? '')) || byVisits(left, right);
  }
  if (order === 'name') return (left, right) => String(left.label).localeCompare(String(right.label));
  return byVisits;
}

function rowsOf(units, held, depth, order = 'visits') {
  return [...units.values()]
    .filter((unit) => {
      const kept = unit.addresses.filter((url) => !held.has(url));
      return kept.length > 0;
    })
    .map((unit) => {
      const kept = unit.addresses.filter((url) => !held.has(url));
      return {
        key: unit.key,
        kind: unit.kind,
        label: unit.label,
        url: unit.url,
        visits: unit.visits,
        lastSeenAt: unit.lastSeenAt,
        depth,
        /* A unit whose every address is already in the vault has nothing left to add. */
        addable: kept.length > 0
      };
    })
    .sort(byOrder(order));
}

/**
 * The rows the section draws.
 *
 * `held` is the addresses the vault already holds — those are dropped here rather than skipped while drawing, so
 * an address can never appear in both sections even when an approval's reply was lost.
 */
export function fold(items, { level = DEFAULT_LEVEL, order = DEFAULT_ORDER, held = [], levels = [] } = {}) {
  const heldSet = new Set(held);
  const stored = (Array.isArray(items) ? items : []).filter(
    (item) => item && typeof item.url === 'string' && Number.isInteger(item.visits) && item.visits > 0
  );
  const usable = recordedItems(stored, levels);
  if (usable.length === 0) return [];

  const levelIsKnown = LEVELS.includes(level);
  const safeLevel = levelIsKnown ? level : DEFAULT_LEVEL;

  if (order !== 'domain') {
    return rowsOf(unitsFor(usable, safeLevel), heldSet, 0, order).map((row) => ({ ...row, isParent: false }));
  }

  const sites = unitsFor(usable, 'domains');
  const hosts = unitsFor(usable, 'hosts');
  const rows = [];

  for (const site of rowsOf(sites, heldSet, 0, 'visits')) {
    const siteHosts = [...hosts.values()].filter((host) => siteOf(host.key) === site.key);
    const hasChildren = safeLevel !== 'domains';
    rows.push({ ...site, isParent: hasChildren });

    if (!hasChildren) continue;

    for (const host of rowsOf(new Map(siteHosts.map((h) => [h.key, h])), heldSet, 1, 'visits')) {
      const pages = usable.filter((item) => item.host === host.key);

      /* A recording rule can leave a host holding nothing but its own root. Drawing that under itself would put two
         identical rows in the list, so the single child is dropped and the host stands alone. A host with real pages
         keeps every one of them, including a page at the root when there are others beside it. */
      let children = safeLevel === 'addresses' ? rowsOf(unitsFor(pages, 'addresses'), heldSet, 2, 'visits') : [];
      if (children.length === 1 && children[0].url === host.url) children = [];

      rows.push({ ...host, isParent: children.length > 0 });
      for (const page of children) rows.push(page);
    }
  }

  return rows;
}

/**
 * The counts the vault's own bookmarks should take from the extension.
 *
 * Every address the extension counted keeps counting whether or not it is in the vault, so opening a saved bookmark
 * from the browser's own list raises its count here too. The extension's number is this device's total, so the slot
 * only ever moves up to it — returning it twice changes nothing.
 */
export function openCounts(items, bookmarks, deviceId) {
  const visits = new Map(
    (Array.isArray(items) ? items : []).map((item) => [item.url, Number.isInteger(item.visits) ? item.visits : 0])
  );

  /* Only this device's slot is compared and only this device's slot is written: another device's visits are its own,
     and a device that wrote both would be the one way to count the same visit twice. */
  const changes = [];
  for (const bookmark of Array.isArray(bookmarks) ? bookmarks : []) {
    const total = visits.get(bookmark.url);
    if (total === undefined) continue;
    if (total > (bookmark.uses?.[deviceId] ?? 0)) {
      changes.push({ id: bookmark.id, openCount: total });
    }
  }
  return changes;
}

/** What the heading counts, and what the rows add up to. */
export function summarise(items, held = [], levels = []) {
  const heldSet = new Set(held);
  const everywhere = (Array.isArray(items) ? items : []).filter((item) => item && !heldSet.has(item.url));
  const fresh = recordedItems(everywhere, levels);

  return {
    addresses: fresh.length,
    visits: fresh.reduce((total, item) => total + (Number.isInteger(item.visits) ? item.visits : 0), 0),
    hosts: new Set(fresh.map((item) => item.host)).size,
    sites: new Set(fresh.map((item) => siteOf(item.host))).size
  };
}
