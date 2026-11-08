/**
 * Bookmarks — the Worker in front of the app.
 *
 * Two jobs: serve the static app through the ASSETS binding while adding the site's security
 * headers, and hand /api/* to the handlers below.
 *
 * Nothing here can read a vault. A bookmark, a name, a click count and an icon arrive as one
 * AES-GCM blob sealed in the browser under a key derived from a phrase this process never sees.
 * The account id and the auth secret are the only account-shaped values it holds, and neither
 * opens anything.
 */

import { digestHex, logEvent } from './events.js';

const CANONICAL = '/w/bookmarks';
/* The app's own host. Anything under the old www path is sent here, so the app is never used
   on an origin that other site pages can read storage from. */
const APP_HOST = 'b.332321.xyz';
const API_PREFIX = `${CANONICAL}/api`;
const VERSION = '0.1.0';

/* The two site stylesheets the app uses. They live on www; on the app's own host they are
   proxied from there, so the browser still sees a same-origin request and the CSP needs no
   exception. The allowlist is the guard: only these two paths are ever fetched. */
const SITE_STYLESHEETS = new Set(['/css/tokens.css', '/css/themes.css']);

/* The same policy the rest of the site's Worker-served apps carry, and the reason no inline
   script exists in this app: `script-src 'self'` would refuse one. `img-src` allows data: so a
   stored icon is a data URI inside the sealed blob, never a request to a bookmarked site. */
const SECURITY_HEADERS = {
  'content-security-policy': [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "object-src 'none'"
  ].join('; '),
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-content-type-options': 'nosniff',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'cross-origin-opener-policy': 'same-origin',
  'strict-transport-security': 'max-age=15552000; includeSubDomains; preload'
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  });
}

function redirect(url, pathname) {
  const target = new URL(url);
  target.pathname = pathname;
  return new Response(null, {
    status: 301,
    headers: { location: target.toString(), 'cache-control': 'no-store' }
  });
}

/* The site's two stylesheets live on the site host and are served from the app host, which is
   the one that holds the sealed vault. The request names one fixed origin and one of two fixed
   paths, follows no redirect, and answers with a header set written here rather than copied from
   the site: a header the site sets — a cookie in particular — would otherwise be stored against
   the vault's own origin. */
const STYLESHEET_TIMEOUT_MS = 5000;

function stylesheetUnavailable() {
  return new Response(null, {
    status: 502,
    headers: { 'cache-control': 'no-store' }
  });
}

async function proxyStylesheet(pathname, request) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response(null, {
      status: 405,
      headers: { allow: 'GET, HEAD', 'cache-control': 'no-store' }
    });
  }

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), STYLESHEET_TIMEOUT_MS);

  try {
    const upstream = await fetch(`https://www.332321.xyz${pathname}`, {
      method: 'GET',
      redirect: 'manual',
      signal: abort.signal,
      headers: { accept: 'text/css' }
    });

    /* Only a direct 200 that says it is CSS is passed on. A redirect is refused rather than
       followed, so the destination is never a host this file did not name. */
    const type = upstream.headers.get('content-type') ?? '';
    if (upstream.status !== 200 || !/^text\/css\b/i.test(type)) {
      if (upstream.body) await upstream.body.cancel().catch(() => {});
      return stylesheetUnavailable();
    }

    const headers = {
      'content-type': 'text/css; charset=utf-8',
      'cache-control': 'public, max-age=86400',
      'x-content-type-options': 'nosniff'
    };
    const etag = upstream.headers.get('etag');
    const lastModified = upstream.headers.get('last-modified');
    if (etag) headers.etag = etag;
    if (lastModified) headers['last-modified'] = lastModified;

    return new Response(request.method === 'HEAD' ? null : upstream.body, { status: 200, headers });
  } catch {
    return stylesheetUnavailable();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Has this source spent its class's budget?
 *
 * The counter is held against a digest of the class name and the caller's address, so no
 * address is stored and none is logged. A class whose binding is absent is not counted;
 * `npm run check` refuses that state in the configuration a deploy would ship.
 */
async function overLimit(env, className, request) {
  const rule = LIMITS[className];
  const binding = env?.[rule.binding];
  if (!binding) return false;

  const address = request.headers.get('cf-connecting-ip') ?? '';
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${className}\n${address}`)
  );
  const { success } = await binding.limit({ key: toBase64Url(new Uint8Array(digest)) });
  return !success;
}

/* 429 and nothing else: the class is refused before its route runs, so the refusal writes
   nothing and fetches nothing on the caller's behalf. */
function tooMany(className) {
  return new Response(JSON.stringify({ error: 'rate_limited' }), {
    status: 429,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'retry-after': String(LIMITS[className].period)
    }
  });
}

/**
 * The source a sign-in is counted against, as a digest.
 *
 * The edge writes `cf-connecting-ip` on every request, and the object keys a failed proof on
 * this value so one place cannot spend another's attempts. Only the digest is forwarded, so the
 * object never holds an address, and the header is set here rather than passed through: a value
 * the caller sent is replaced, not read.
 */
async function sourceDigest(request) {
  return digestHex(`vault\n${request.headers.get('cf-connecting-ip') ?? ''}`);
}

/** The caller's request again, at the object, carrying the source the Worker decided on. */
function forwardTo(stub, target, request, source) {
  const headers = new Headers(request.headers);
  headers.set('x-vault-source', source);

  const init = { method: request.method, headers };
  if (request.body) {
    init.body = request.body;
    /* A body that arrives as a stream has to say it is sent once. */
    init.duplex = 'half';
  }
  return stub.fetch(new Request(target, init));
}

/**
 * Run a route unless its source is over the class's ceiling.
 *
 * The refusal writes one line naming the class and the length of the window the caller has to
 * wait, and nothing about the caller: no address, no digest of one, no path.
 */
async function limited(env, className, request, run) {
  if (className && (await overLimit(env, className, request))) {
    await logEvent('rate_limited', {
      route: className,
      reason: 'over_limit',
      retry_after: LIMITS[className].period
    });
    return tooMany(className);
  }
  return run();
}

/* The page is served at one prefix and that prefix is known here, so the 404 is generated in
   this file: its link back to the app and the site's security headers then match the rest of
   what the Worker returns, rather than whatever the asset binding would answer on its own. */
function notFound() {
  return new Response(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Not found</title>
<style>
  :root { color-scheme: dark light; }
  body { margin: 0; background: #0d1117; color: #e6edf3;
         font: 16px/1.6 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  main { max-width: 42rem; margin: 0 auto; padding: 3rem 1.25rem; }
  h1 { margin: 0 0 0.5rem; font-size: 2rem; }
  p { color: #9198a1; }
  a { color: #4c8dff; }
</style>
</head>
<body>
<main>
  <h1>Not found</h1>
  <p>That page does not exist.</p>
  <p><a href="${CANONICAL}/">Back to Bookmarks</a></p>
</main>
</body>
</html>
`, {
    status: 404,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }
  });
}

/**
 * The API. Every response is same-origin, so the page needs no CORS and the CSP needs no
 * exception. Only GETs read; every write is a POST or PUT with a JSON body.
 *
 * `/a/<accountId>/…` is forwarded to that account's Durable Object, which is where the nonce,
 * the session and the sealed vault live. That object also has operator routes, but they are
 * reachable only through a Durable Object binding: a public `/a/<id>/admin-…` path is a 404
 * and never reaches the object.
 */
const ACCOUNT_ID = /^[A-Za-z0-9_-]{22}$/;

const ICON_PATH = '/icon';
/* A page's own <title>, so the add form can suggest a name instead of showing a bare host. */
const TITLE_PATH = '/title';
const TITLE_MAX_CHARS = 120;
const ICON_MAX_BYTES = 64 * 1024;
const ICON_PAGE_MAX_BYTES = 256 * 1024;
const ICON_TIMEOUT_MS = 10_000;
const ICON_TYPES = new Set([
  'image/x-icon',
  'image/vnd.microsoft.icon',
  'image/png',
  'image/svg+xml',
  'image/jpeg',
  'image/webp',
  'image/gif'
]);

/**
 * What one source may spend per class, and the binding that counts it.
 *
 * The ceilings are the cost model: a sign-in request spends as much of its minute as eighteen
 * icon fetches, or six vault requests. The routes that write, or that fetch somewhere else,
 * are the ones a caller may spend least of. Each binding is a [[ratelimits]] entry in
 * wrangler.toml with the same name, limit and period; `npm run check` fails when they differ.
 */
/* Counters are held by the edge location that answers a request, so each number is a ceiling
   per location rather than a global one. One source held on a single location is limited
   exactly; one spread across locations can reach a multiple of it. */
export const LIMITS = {
  signin: { binding: 'SIGNIN_LIMIT', limit: 10, period: 60 },
  fetch: { binding: 'FETCH_LIMIT', limit: 30, period: 10 },
  vault: { binding: 'VAULT_LIMIT', limit: 60, period: 60 }
};

/* The class each route is counted as. Anything absent here is answered without a counter:
   /health reads two constants, and an unknown path is a 404. */
const ROUTE_CLASS = {
  '/account': 'signin',
  '/challenge': 'signin',
  '/login': 'signin',
  '/logout': 'vault',
  '/sessions': 'vault',
  '/vault': 'vault',
  [ICON_PATH]: 'fetch',
  [TITLE_PATH]: 'fetch'
};

/**
 * The class an API path is counted as, for a boundary line written after dispatch threw.
 *
 * The path is read the same way `handleApi` reads it — the direct route, or the route after
 * `/a/<accountId>` — so a boundary line names the class whose route failed rather than a guess.
 */
function routeClassOf(pathname) {
  const path = pathname.slice(API_PREFIX.length);
  if (ROUTE_CLASS[path]) return ROUTE_CLASS[path];

  const forwarded = path.match(/^\/a\/[^/]+\/([^/]+)/);
  return (forwarded && ROUTE_CLASS[`/${forwarded[1]}`]) || 'api';
}

/** The account an API path names, if it names one that is well formed. */
function accountOf(pathname) {
  const match = pathname.slice(API_PREFIX.length).match(/^\/a\/([^/]+)\//);
  return match && ACCOUNT_ID.test(match[1]) ? match[1] : undefined;
}

const USER_AGENT = 'Bookmarks/0.1 (+https://www.332321.xyz/w/bookmarks/)';

/* A hostname, not a URL: no scheme, no port, no path, no IP literal, no single label. */
const HOSTNAME = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

/* At most three redirects are followed, so a chain cannot be used to keep asking.
   A fourth Location is the end of the chain. */
const MAX_REDIRECTS = 3;

/* ---------------------------------------------------------- destination policy */

/**
 * Where the icon and title proxies may be sent.
 *
 * Both routes take a hostname from the caller and fetch it, so the destination is checked at
 * the first hop and again after every redirect. Two checks are made, cheapest first:
 *
 * 1. The name. IP literals, which the URL parser has already normalised before this sees them;
 *    names reserved for private use; wildcard resolvers that carry an address inside the name
 *    (nip.io and its relatives); cloud metadata-service names; and any dotted quad embedded in
 *    a longer name.
 * 2. The answer. A public-looking name can have an A or AAAA record for loopback, RFC1918,
 *    link-local, CGNAT, multicast or a metadata service, and the runtime would connect to it
 *    without complaint. Every host is therefore resolved over DNS over HTTPS before it is
 *    fetched, and refused when any returned address is one the literal rules already refuse.
 *
 * A hop that names a port is refused as well. The caller names a hostname, never a port, and the
 * two proxies speak to the default TLS port only; a Location such as `https://host:8443/…` would
 * otherwise let one caller sweep ports on any host the service can resolve.
 *
 * The resolution is a separate query from the connection the runtime opens, so the answer that
 * was checked and the address that is connected to are not guaranteed to be the same one: a
 * record that changes between the lookup and the fetch (DNS rebinding) can still reach an
 * address this code never saw. Closing that needs a fetch pinned to the checked address, which
 * the Workers fetch API does not expose. The window is narrowed, not closed.
 */
const PRIVATE_SUFFIXES = [
  '.internal',
  '.local',
  '.localhost',
  '.localdomain',
  '.home.arpa',
  '.lan',
  '.intranet',
  '.corp',
  '.private',
  '.home',
  '.test',
  '.invalid',
  '.example',
  '.svc'
];

/* Hosts whose whole purpose is to answer with an address written in the name. */
const WILDCARD_HOSTS = [
  '.nip.io',
  '.sslip.io',
  '.xip.io',
  '.traefik.me',
  '.lvh.me',
  '.localtest.me',
  '.vcap.me',
  '.localhost.direct',
  /* Public wildcard resolvers: every label under them answers with loopback. `local.gd` serves
     a public address at its apex today, but no label under it is a real destination. */
  '.localho.st',
  '.local.gd'
];

/* Names of the metadata services that answer from inside a network, not the public internet. */
const METADATA_HOSTS = new Set([
  'metadata',
  'instance-data',
  'metadata.goog',
  'metadata.google.internal',
  'metadata.azure.internal',
  'metadata.tencentyun.com',
  'metadata.oraclecloud.com',
  'kubernetes.default.svc'
]);

/** Four decimal octets, or null. A URL has already normalised octets, so plain decimal is enough. */
function parseIpv4(host) {
  const parts = host.split('.');
  if (parts.length !== 4) return null;

  const octets = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    octets.push(value);
  }
  return octets;
}

/** Private, loopback, link-local, CGNAT, documentation, multicast or reserved IPv4. */
function ipv4Refused([a, b, c]) {
  return (
    a === 0 || /* "this network", and 0.0.0.0 itself */
    a === 10 || /* private */
    a === 127 || /* loopback */
    (a === 100 && b >= 64 && b <= 127) || /* carrier-grade NAT */
    (a === 169 && b === 254) || /* link-local, where cloud metadata lives */
    (a === 172 && b >= 16 && b <= 31) || /* private */
    (a === 192 && b === 0 && (c === 0 || c === 2)) || /* protocol assignments, documentation */
    (a === 192 && b === 168) || /* private */
    (a === 198 && (b === 18 || b === 19)) || /* benchmarking */
    (a === 198 && b === 51 && c === 100) || /* documentation */
    (a === 203 && b === 0 && c === 113) || /* documentation */
    a >= 224 /* multicast, reserved, broadcast */
  );
}

/** Sixteen bytes of an IPv6 literal, or null. Accepts `::`, a full form and a dotted-quad tail. */
function ipv6Bytes(text) {
  let value = text.toLowerCase();

  const embedded = value.match(/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (embedded) {
    const octets = embedded.slice(1).map(Number);
    if (octets.some((octet) => octet > 255)) return null;
    const high = ((octets[0] << 8) | octets[1]).toString(16);
    const low = ((octets[2] << 8) | octets[3]).toString(16);
    value = `${value.slice(0, -embedded[0].length)}${high}:${low}`;
  }

  const halves = value.split('::');
  if (halves.length > 2) return null;

  const left = halves[0] === '' ? [] : halves[0].split(':');
  const right = halves.length === 2 && halves[1] !== '' ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;

  const groups = [...left, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...right];
  if (groups.length !== 8) return null;

  const bytes = [];
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    const word = Number.parseInt(group, 16);
    bytes.push(word >> 8, word & 0xff);
  }
  return bytes;
}

/** Loopback, unspecified, unique-local, link-local, multicast, documentation, or a tunnel. */
function ipv6Refused(bytes) {
  const first = bytes[0];
  const second = bytes[1];
  const zero = (from, to) => bytes.slice(from, to).every((byte) => byte === 0);
  const ipv4At = (at) => ipv4Refused(bytes.slice(at, at + 4));

  if (zero(0, 16)) return true; /* :: */
  if (zero(0, 15) && bytes[15] === 1) return true; /* ::1 */
  if ((first & 0xfe) === 0xfc) return true; /* fc00::/7, unique local */
  if (first === 0xfe && (second & 0xc0) === 0x80) return true; /* fe80::/10, link-local */
  if (first === 0xff) return true; /* multicast */
  if (first === 0x20 && second === 0x02) return true; /* 6to4, an IPv4 address inside the name */

  if (first === 0x20 && second === 0x01) {
    if (bytes[2] === 0x0d && bytes[3] === 0xb8) return true; /* documentation */
    if (zero(2, 8)) return true; /* Teredo */
  }

  if (first === 0x01 && second === 0x00 && zero(2, 8)) return true; /* 100::/64 discard */

  /* IPv4-mapped (::ffff:0:0/96) and IPv4-compatible (::/96) addresses are their IPv4 address. */
  if (zero(0, 10) && bytes[10] === 0xff && bytes[11] === 0xff) return ipv4At(12);
  if (zero(0, 12)) return ipv4At(12);

  /* NAT64 carries an IPv4 address in the last four bytes too. */
  if (first === 0x00 && second === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b && zero(4, 12)) {
    return ipv4At(12);
  }

  return false;
}

/**
 * True when a URL names a port other than the default one for its scheme.
 *
 * The two proxies exist to read an icon and a title over ordinary https, and the caller names a
 * hostname with no port. A Location that adds one — `https://host:8443/…` — would make the
 * service a port probe against any host it can resolve, so such a hop is refused rather than
 * followed. The URL parser drops an explicit `:443` for https, so a non-empty `port` is always a
 * port the caller did not name.
 */
function portRefused(url) {
  return url.port !== '';
}

/**
 * True when a destination must not be contacted.
 *
 * Accepts a URL's `hostname` (an IPv6 literal still carries its brackets) or a header value.
 * A trailing dot is dropped, because `example.com.` names the same host as `example.com`, and
 * the suffix rules would otherwise miss it.
 */
function destinationRefused(hostname) {
  const host = String(hostname)
    .toLowerCase()
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .replace(/\.$/, '');
  if (host === '') return true;

  if (host.includes(':')) {
    const bytes = ipv6Bytes(host);
    return bytes === null || ipv6Refused(bytes);
  }

  const literal = parseIpv4(host);
  if (literal) return ipv4Refused(literal);

  if (METADATA_HOSTS.has(host)) return true;

  for (const suffix of [...PRIVATE_SUFFIXES, ...WILDCARD_HOSTS]) {
    if (host === suffix.slice(1) || host.endsWith(suffix)) return true;
  }

  /* A private dotted quad can also sit in the middle of a longer name, as wildcard resolvers
     publish it. Any four-label window that parses as a refused address refuses the host. */
  const labels = host.split('.');
  for (let at = 0; at + 4 <= labels.length; at += 1) {
    const embedded = parseIpv4(labels.slice(at, at + 4).join('.'));
    if (embedded && ipv4Refused(embedded)) return true;
  }

  return false;
}

/* ----------------------------------------------------- destination resolution */

/* The resolver the proxies ask before a fetch. The runtime has no resolver in the request path,
   so the name is turned into addresses here, over DNS over HTTPS with JSON answers. */
const DOH_ENDPOINT = 'https://cloudflare-dns.com/dns-query';

/* A verdict is reused for a minute, so a burst for one host resolves once. The table holds at
   most a hundred hosts; expired entries are dropped on write, and the oldest insertion is
   evicted when the table is full. */
const DNS_TTL_MS = 60_000;
const DNS_CACHE_MAX = 100;

/** host -> { refused, expires }. Insertion order is the eviction order. */
const dnsVerdicts = new Map();

/** True when a resolved address is private, or is not an address at all. */
function addressRefused(address) {
  const literal = parseIpv4(address);
  if (literal) return ipv4Refused(literal);

  const bytes = ipv6Bytes(address);
  return bytes === null || ipv6Refused(bytes);
}

/**
 * The addresses one DoH answer names, `[]` when the name has no record of that type, or null
 * when the answer cannot be read and the destination therefore cannot be vouched for.
 *
 * Fail closed: a non-200 status, a body that is not a DNS answer, a `Status` other than 0 (a
 * name that does not exist, a failing resolver) and an `Answer` that is not an array are all
 * null. `Status` 0 with no `Answer` at all is NODATA for the type asked, which is normal for a
 * name with only an A or only an AAAA record; it is the two answers together that must name at
 * least one address.
 */
async function dohAddresses(host, type, signal) {
  let response;
  try {
    response = await fetch(`${DOH_ENDPOINT}?name=${encodeURIComponent(host)}&type=${type}`, {
      headers: { accept: 'application/dns-json' },
      redirect: 'manual',
      signal
    });
  } catch {
    return null;
  }

  if (response.status !== 200) {
    if (response.body) await response.body.cancel().catch(() => {});
    return null;
  }

  let body;
  try {
    body = await response.json();
  } catch {
    return null;
  }

  if (!body || typeof body !== 'object' || body.Status !== 0) return null;
  if (body.Answer === undefined) return [];
  if (!Array.isArray(body.Answer)) return null;

  const recordType = type === 'A' ? 1 : 28;
  const addresses = [];
  for (const answer of body.Answer) {
    if (!answer || typeof answer !== 'object' || answer.type !== recordType) continue;
    if (typeof answer.data !== 'string') return null;
    addresses.push(answer.data);
  }
  return addresses;
}

/** Resolve a hostname and answer whether it must not be contacted. */
async function lookupRefused(host, signal) {
  const [v4, v6] = await Promise.all([
    dohAddresses(host, 'A', signal),
    dohAddresses(host, 'AAAA', signal)
  ]);

  /* A lookup cut short by the request's own deadline is that request's timeout, not a verdict
     about the host; the route answers it the way it answers any fetch that ran out of time. */
  if ((v4 === null || v6 === null) && signal?.aborted) throw new Error('aborted');
  if (v4 === null || v6 === null) return true;

  const addresses = [...v4, ...v6];
  /* No address at all is nothing to vouch for. */
  if (addresses.length === 0) return true;

  return addresses.some(addressRefused);
}

/**
 * Whether a hostname must not be fetched because of what it resolves to.
 *
 * An address literal is decided by the literal rules alone; there is nothing to look up. Every
 * other name is resolved, and the verdict — allowed or refused — is remembered for DNS_TTL_MS.
 * A resolution that cannot be completed refuses: a check that did not happen cannot vouch for
 * the destination.
 */
async function resolvesRefused(hostname, signal) {
  const host = String(hostname)
    .toLowerCase()
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .replace(/\.$/, '');
  if (host === '') return true;
  if (parseIpv4(host) || host.includes(':')) return destinationRefused(host);

  const cached = dnsVerdicts.get(host);
  if (cached && cached.expires > Date.now()) return cached.refused;

  const refused = await lookupRefused(host, signal);

  const now = Date.now();
  for (const [name, entry] of dnsVerdicts) {
    if (entry.expires <= now) dnsVerdicts.delete(name);
  }
  if (dnsVerdicts.size >= DNS_CACHE_MAX) dnsVerdicts.delete(dnsVerdicts.keys().next().value);
  dnsVerdicts.set(host, { refused, expires: now + DNS_TTL_MS });

  return refused;
}

function toBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hostHash(hostname) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(hostname));
  return toBase64Url(new Uint8Array(digest));
}

/* The wait for an upstream host. A binding may shorten it: the tests hold the same code to a few
   hundred milliseconds rather than ten seconds. */
function iconTimeoutOf(env) {
  const ms = Number(env?.ICON_TIMEOUT_MS);
  return Number.isFinite(ms) && ms > 0 ? ms : ICON_TIMEOUT_MS;
}

/**
 * One step of a stream read, given up at once when the request aborts.
 *
 * Aborting a fetch stops a request that has not answered, and the runtime also errors a body
 * that already started arriving. This race does not rely on that: a host that sends a byte every
 * few seconds is still a stream that would otherwise keep the invocation alive, so the read is
 * abandoned here the moment the signal fires. The reader is cancelled alongside, so the bytes
 * nobody will read stop being received.
 */
function untilAborted(read, signal) {
  if (!signal) return read;

  return new Promise((resolve, reject) => {
    const aborted = () => reject(new Error('aborted'));
    if (signal.aborted) {
      aborted();
      return;
    }

    signal.addEventListener('abort', aborted, { once: true });
    read.then(
      (step) => {
        signal.removeEventListener('abort', aborted);
        resolve(step);
      },
      (error) => {
        signal.removeEventListener('abort', aborted);
        reject(error);
      }
    );
  });
}

/** Read at most `max` bytes, cancelling the stream the moment it exceeds the cap. */
/**
 * The first `max` bytes of a response, then stop reading.
 *
 * A page is worth reading only as far as its <head>: refusing a body because the whole document
 * is over the cap is why sites with large pages (github.com, itsfoss.com) answered "no icon" and
 * had no title to offer. Images still go through readCapped, where a short read would corrupt.
 */
async function readPrefix(response, max, signal) {
  if (!response.body) return new Uint8Array(0);

  const reader = response.body.getReader();
  const close = () => {
    reader.cancel().catch(() => {});
  };
  signal?.addEventListener('abort', close, { once: true });

  const chunks = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await untilAborted(reader.read(), signal);
      if (done) break;

      const room = max - total;
      if (value.byteLength >= room) {
        chunks.push(value.subarray(0, room));
        total += room;
        await reader.cancel();
        break;
      }

      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    signal?.removeEventListener('abort', close);
  }

  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
}

async function readCapped(response, max, signal) {
  if (!response.body) return new Uint8Array(0);

  const reader = response.body.getReader();
  const close = () => {
    reader.cancel().catch(() => {});
  };
  signal?.addEventListener('abort', close, { once: true });

  const chunks = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await untilAborted(reader.read(), signal);
      if (done) break;

      total += value.byteLength;
      if (total > max) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    signal?.removeEventListener('abort', close);
  }

  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
}

function iconTypeOf(response) {
  const type = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  return ICON_TYPES.has(type) ? type : null;
}

/**
 * Fetch one URL, following at most MAX_REDIRECTS redirects by hand.
 *
 * `redirect: 'follow'` lets a page answer with a Location that reaches a host the caller was
 * never allowed to name, and the runtime would not check it. Every hop is therefore checked
 * before it is asked: https only, on the default port, and a destination the same rules accept.
 * A refused hop ends the chain with `null`, which the caller treats as no answer.
 *
 * `wikipedia.org` serves its icon from `en.wikipedia.org`, so redirects are still followed by
 * hand; the local runtime does not complete that chain on its own.
 *
 * Returns the response and the URL it came from, so a relative href resolves against where the
 * page actually ended up.
 */
async function fetchChain(target, init, signal) {
  let current = new URL(target);

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    if (current.protocol !== 'https:' || portRefused(current)) return null;
    if (destinationRefused(current.hostname)) return null;
    /* A public name can answer with a private address; the answer is checked before the fetch,
       on the first hop and on every redirect. */
    if (await resolvesRefused(current.hostname, signal)) return null;

    const response = await fetch(current.toString(), { ...init, redirect: 'manual', signal });

    if (response.status < 300 || response.status >= 400) return { response, url: current };

    const location = response.headers.get('location');
    if (!location) return null;

    if (response.body) await response.body.cancel().catch(() => {});

    try {
      current = new URL(location, current);
    } catch {
      return null;
    }
  }

  return null;
}

async function followToImage(target, signal) {
  const step = await fetchChain(
    target,
    { headers: { accept: 'image/*', 'user-agent': USER_AGENT } },
    signal
  );
  return step ? step.response : null;
}

/**
 * Find the icon a page declares, for the half of the web that does not serve `/favicon.ico`.
 * Only the first `<link rel="...icon...">` is used; the href is resolved against the page and
 * must be https, at a destination the same rules accept.
 */
async function discoverIcon(hostname, signal) {
  const pageUrl = `https://${hostname}/`;

  let step;
  try {
    step = await fetchChain(
      pageUrl,
      { headers: { accept: 'text/html', 'user-agent': USER_AGENT } },
      signal
    );
  } catch {
    /* A page that ran out of time is the same refusal the icon route reports; this helper
       answers it as "no declared icon", so the line is written here. A host that simply could
       not be reached is an ordinary miss and writes nothing. */
    if (signal?.aborted) {
      await logEvent('proxy_refused', { route: ROUTE_CLASS[ICON_PATH], reason: 'timeout' });
    }
    return null;
  }

  if (!step || !step.response.ok) return null;
  const page = step.response;
  const pageType = (page.headers.get('content-type') ?? '').toLowerCase();
  if (!pageType.includes('text/html')) return null;

  const bytes = await readPrefix(page, ICON_PAGE_MAX_BYTES, signal);

  const html = new TextDecoder().decode(bytes);
  const link = html.match(/<link\b[^>]*\brel\s*=\s*["']?[^"'>]*\bicon\b[^"'>]*["']?[^>]*>/i);
  if (!link) return null;

  const href = link[0].match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1];
  if (!href) return null;

  try {
    const url = new URL(href, step.url);
    if (url.protocol !== 'https:' || portRefused(url)) return null;
    if (destinationRefused(url.hostname)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * A refusal from one of the two proxy routes: one line, then the same 400 it always answered.
 *
 * `reason` is one of the fixed codes: bad_host, blocked_host or bad_hash. The hostname the
 * caller supplied is never part of the line — it is the one value on this route that belongs to
 * the caller.
 */
async function proxyRefused(reason) {
  await logEvent('proxy_refused', { route: ROUTE_CLASS[ICON_PATH], reason });
  return json({ error: reason }, 400);
}

/**
 * The icon service.
 *
 * The hostname travels in a header, not the query string, and the URL carries only its SHA-256.
 * That keeps the domain out of the request path — which is the part Cloudflare's logs record —
 * and gives every host one stable URL. The hash is re-derived here, so a caller cannot name a
 * host under a key that host does not produce.
 *
 * The Worker is the only party that contacts the bookmarked site: it asks the host for
 * `/favicon.ico`, then for the icon the page declares, following redirects. A host that answers
 * with neither is asked again a week later, and only while the vault still has no icon for it.
 * No hostname is logged by this code.
 */
async function handleIcon(request, url, timeoutMs = ICON_TIMEOUT_MS) {
  if (request.method !== 'GET') return json({ error: 'method' }, 405);

  const hostname = (request.headers.get('x-icon-host') ?? '').trim();
  if (!HOSTNAME.test(hostname)) return proxyRefused('bad_host');
  if (destinationRefused(hostname)) return proxyRefused('blocked_host');

  const claimed = url.searchParams.get('h') ?? '';
  if (claimed !== (await hostHash(hostname))) return proxyRefused('bad_hash');

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);

  /* Everything the host sends is read inside this block, and the timer is cleared only once the
     read has finished or thrown: a host that answers with headers and then trickles its body
     would otherwise keep the invocation alive with no bound. */
  try {
    /* The name checks above cannot see a public-looking name that answers with a private
       address. The lookup is part of this request, and its refusal keeps the shape the name
       check already answers. */
    if (await resolvesRefused(hostname, abort.signal)) return proxyRefused('blocked_host');

    let upstream = await followToImage(`https://${hostname}/favicon.ico`, abort.signal);
    let type = upstream ? iconTypeOf(upstream) : null;

    if (!type) {
      /* A page that answered /favicon.ico with HTML, or with nothing useful, may still declare
         an icon. Only one extra request, and only for a host the caller named. */
      if (upstream?.body) await upstream.body.cancel().catch(() => {});
      const declared = await discoverIcon(hostname, abort.signal);
      if (declared) {
        upstream = await followToImage(declared, abort.signal);
        type = upstream ? iconTypeOf(upstream) : null;
      }
    }

    if (!upstream || !upstream.ok || !type) {
      return new Response(null, {
        status: 404,
        headers: { 'cache-control': 'public, max-age=600' }
      });
    }

    const declaredLength = Number(upstream.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > ICON_MAX_BYTES) {
      return new Response(null, {
        status: 413,
        headers: { 'cache-control': 'public, max-age=600' }
      });
    }

    const bytes = await readCapped(upstream, ICON_MAX_BYTES, abort.signal);
    if (!bytes || bytes.byteLength === 0) {
      return new Response(null, {
        status: bytes ? 404 : 413,
        headers: { 'cache-control': 'public, max-age=600' }
      });
    }

    return new Response(bytes, {
      status: 200,
      headers: {
        'content-type': type,
        'content-length': String(bytes.byteLength),
        'cache-control': 'public, max-age=2592000, immutable',
        'x-content-type-options': 'nosniff',
        /* These bytes come from a host the caller named, and one of the accepted types is SVG,
           which can carry script. The page only ever reads an icon as a subresource, so it is
           answered as a download; and a browser that did navigate to it lands in an opaque
           origin where nothing loads and no script runs, rather than on our origin beside the
           sealed vault. */
        'content-disposition': 'attachment',
        'content-security-policy': "default-src 'none'; sandbox"
      }
    });
  } catch {
    /* The timeout abort and a failed connection are the two ways this route gives up on a host
       it was allowed to ask. The reason says which, and the host is not named. */
    await logEvent('proxy_refused', {
      route: ROUTE_CLASS[ICON_PATH],
      reason: abort.signal.aborted ? 'timeout' : 'fetch_failed'
    });
    return new Response(null, {
      status: 502,
      headers: { 'cache-control': 'public, max-age=300' }
    });
  } finally {
    clearTimeout(timer);
  }
}

/** A small JSON answer with a real cache lifetime, for values that rarely change. */
function cachedJson(body, maxAge) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': `public, max-age=${maxAge}`,
      'content-security-policy': "default-src 'none'",
      'x-content-type-options': 'nosniff'
    }
  });
}

/** The handful of entities that actually turn up inside a <title>, decoded. */
function decodeEntities(text) {
  const fromCode = (value) => {
    try {
      return String.fromCodePoint(value);
    } catch {
      return '';
    }
  };

  return String(text)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => fromCode(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => fromCode(Number(dec)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

/**
 * The page's own title, read from the same document the icon discovery already reads.
 *
 * Only the origin is fetched, never a path a caller names, so this cannot be pointed at an
 * arbitrary URL on someone's server; the answer is one short string and nothing else.
 */
async function fetchPageTitle(hostname, signal) {
  let step;
  try {
    step = await fetchChain(
      `https://${hostname}/`,
      { headers: { accept: 'text/html', 'user-agent': USER_AGENT } },
      signal
    );
  } catch {
    /* The title route answers a timeout as "no title", so the refusal is recorded here. */
    if (signal?.aborted) {
      await logEvent('proxy_refused', { route: ROUTE_CLASS[TITLE_PATH], reason: 'timeout' });
    }
    return null;
  }

  if (!step || !step.response.ok) return null;
  const page = step.response;
  const type = (page.headers.get('content-type') ?? '').toLowerCase();
  if (!type.includes('text/html')) return null;

  const bytes = await readPrefix(page, ICON_PAGE_MAX_BYTES, signal);

  const html = new TextDecoder().decode(bytes);
  const match = html.match(/<title[^>]*>([\s\S]{0,400}?)<\/title>/i);
  if (!match) return null;

  const title = decodeEntities(match[1]).replace(/\s+/g, ' ').trim();
  return title === '' ? null : title.slice(0, TITLE_MAX_CHARS);
}

/**
 * `GET /api/title` with `x-page-host` and `h = sha256(host)`.
 *
 * The same shape as the icon route: the host travels in a header, the URL carries only its
 * hash, and nothing about the caller, an account or a vault is involved.
 */
async function handleTitle(request, url, timeoutMs = ICON_TIMEOUT_MS) {
  if (request.method !== 'GET') return json({ error: 'method' }, 405);

  const hostname = (request.headers.get('x-page-host') ?? '').trim();
  if (!HOSTNAME.test(hostname)) return proxyRefused('bad_host');
  if (destinationRefused(hostname)) return proxyRefused('blocked_host');

  const claimed = url.searchParams.get('h') ?? '';
  if (claimed !== (await hostHash(hostname))) return proxyRefused('bad_hash');

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);

  try {
    /* Same lookup as the icon route: the name is not enough to vouch for the destination. */
    if (await resolvesRefused(hostname, abort.signal)) return proxyRefused('blocked_host');

    const title = await fetchPageTitle(hostname, abort.signal);
    return title ? cachedJson({ title }, 604_800) : json({ error: 'no_title' }, 404);
  } catch {
    await logEvent('proxy_refused', {
      route: ROUTE_CLASS[TITLE_PATH],
      reason: abort.signal.aborted ? 'timeout' : 'fetch_failed'
    });
    return json({ error: 'failed' }, 502);
  } finally {
    clearTimeout(timer);
  }
}

async function handleApi(request, env, url) {
  const path = url.pathname.slice(API_PREFIX.length);

  if (path === '/health') return json({ ok: true, version: VERSION });

  if (path === ICON_PATH) {
    return limited(env, ROUTE_CLASS[ICON_PATH], request, () =>
      handleIcon(request, url, iconTimeoutOf(env))
    );
  }
  if (path === TITLE_PATH) {
    return limited(env, ROUTE_CLASS[TITLE_PATH], request, () =>
      handleTitle(request, url, iconTimeoutOf(env))
    );
  }

  if (path.startsWith('/a/')) {
    const rest = path.slice('/a/'.length);
    const slash = rest.indexOf('/');
    if (slash === -1) return json({ error: 'not_found' }, 404);

    const accountId = rest.slice(0, slash);
    if (!ACCOUNT_ID.test(accountId)) return json({ error: 'bad_account' }, 400);

    /* The object's operator routes answer only a Worker bound to it; through the public API
       they do not exist. */
    const forward = rest.slice(slash);
    if (forward.startsWith('/admin-')) return json({ error: 'not_found' }, 404);

    const stub = env.VAULTS.get(env.VAULTS.idFromName(accountId));
    const target = new URL(`https://vault${forward}`, 'https://vault');
    return limited(env, ROUTE_CLASS[forward], request, async () =>
      forwardTo(stub, target, request, await sourceDigest(request))
    );
  }

  return json({ error: 'not_found' }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    /* The app moved to its own host. Anything still pointed at the old path is sent there so
       no one keeps using the copy that shares storage with the rest of the site. */
    if (
      url.hostname === 'www.332321.xyz' &&
      (url.pathname === CANONICAL || url.pathname.startsWith(`${CANONICAL}/`))
    ) {
      const target = new URL(url);
      target.hostname = APP_HOST;
      return new Response(null, {
        status: 301,
        headers: { location: target.toString(), 'cache-control': 'no-store' }
      });
    }

    if (url.pathname === CANONICAL) return redirect(url, `${CANONICAL}/`);

    if (SITE_STYLESHEETS.has(url.pathname)) {
      return limited(env, 'fetch', request, () => proxyStylesheet(url.pathname, request));
    }

    if (url.pathname === API_PREFIX || url.pathname.startsWith(`${API_PREFIX}/`)) {
      try {
        return await handleApi(request, env, url);
      } catch {
        /* One line at the boundary, then the same 500 the caller always got. The class and the
           account are read from the path, so an exception inside an object is attributable
           without naming the account or the route's arguments. */
        await logEvent('server_error', {
          route: routeClassOf(url.pathname),
          reason: 'unhandled',
          account: accountOf(url.pathname)
        });
        return json({ error: 'internal' }, 500);
      }
    }

    const assetUrl = new URL(url.pathname + url.search, url.origin);
    const response = await env.ASSETS.fetch(new Request(assetUrl, request));
    const headers = new Headers(response.headers);

    if (response.status === 404) {
      const page = notFound();
      for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
      for (const [name, value] of page.headers) headers.set(name, value);
      return new Response(page.body, { status: 404, headers });
    }

    for (const [name, value] of Object.entries(SECURITY_HEADERS)) headers.set(name, value);
    if (!headers.has('cache-control')) {
      headers.set('cache-control', 'public, max-age=0, must-revalidate');
    }
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers
    });
  }
};

/* The classes the bindings in wrangler.toml name. */
export { Vault } from './vault.js';
export { Registry } from './registry.js';
