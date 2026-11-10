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
export const ORDERS = Object.freeze(['visits', 'domain']);
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
  if (labels.length <= 2) return labels.join('.');
  const lastTwo = labels.slice(-2).join('.');
  return SECOND_LEVEL.has(lastTwo) ? labels.slice(-3).join('.') : lastTwo;
}

/** The label of one address: its path and query, since the host is on its own line. */
export function addressLabel(url) {
  try {
    const parsed = new URL(url);
    const rest = `${parsed.pathname}${parsed.search}`;
    return rest === '/' ? '/' : rest.replace(/\/$/, '');
  } catch {
    return url;
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
    const label =
      level === 'addresses' ? addressLabel(item.url) : level === 'hosts' ? item.host : key;

    const unit = units.get(key) ?? {
      key,
      kind: level.slice(0, -1),
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

    /* An address row adds itself; a row that rolls children up adds its root, because promoting every page under
       a site from one tap would spend the vault's cap in a single click. */
    if (level === 'addresses') unit.url = item.url;
    else if (unit.url === null) unit.url = `https://${key}/`;
    units.set(key, unit);
  }

  return units;
}

function rowsOf(units, held, depth) {
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
    .sort(byVisits);
}

/**
 * The rows the section draws.
 *
 * `held` is the addresses the vault already holds — those are dropped here rather than skipped while drawing, so
 * an address can never appear in both sections even when an approval's reply was lost.
 */
export function fold(items, { level = DEFAULT_LEVEL, order = DEFAULT_ORDER, held = [] } = {}) {
  const heldSet = new Set(held);
  const usable = (Array.isArray(items) ? items : []).filter(
    (item) => item && typeof item.url === 'string' && Number.isInteger(item.visits) && item.visits > 0
  );
  if (usable.length === 0) return [];

  const levelIsKnown = LEVELS.includes(level);
  const safeLevel = levelIsKnown ? level : DEFAULT_LEVEL;

  if (order !== 'domain') {
    return rowsOf(unitsFor(usable, safeLevel), heldSet, 0).map((row) => ({ ...row, isParent: false }));
  }

  const sites = unitsFor(usable, 'domains');
  const hosts = unitsFor(usable, 'hosts');
  const rows = [];

  for (const site of rowsOf(sites, heldSet, 0)) {
    const siteHosts = [...hosts.values()].filter((host) => siteOf(host.key) === site.key);
    const hasChildren = safeLevel !== 'domains';
    rows.push({ ...site, isParent: hasChildren });

    if (!hasChildren) continue;

    for (const host of rowsOf(new Map(siteHosts.map((h) => [h.key, h])), heldSet, 1)) {
      const pages = usable.filter((item) => item.host === host.key);
      const hasPages = safeLevel === 'addresses';
      rows.push({ ...host, isParent: hasPages });

      if (!hasPages) continue;
      for (const page of rowsOf(unitsFor(pages, 'addresses'), heldSet, 2)) rows.push(page);
    }
  }

  return rows;
}

/** What the heading counts, and what the rows add up to. */
export function summarise(items, held = []) {
  const heldSet = new Set(held);
  const fresh = (Array.isArray(items) ? items : []).filter((item) => item && !heldSet.has(item.url));

  return {
    addresses: fresh.length,
    visits: fresh.reduce((total, item) => total + (Number.isInteger(item.visits) ? item.visits : 0), 0),
    hosts: new Set(fresh.map((item) => item.host)).size,
    sites: new Set(fresh.map((item) => siteOf(item.host))).size
  };
}
