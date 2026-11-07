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

const CANONICAL = '/w/bookmarks';
/* The app's own host. Anything under the old www path is sent here, so the app is never used
   on an origin that other site pages can read storage from. */
const APP_HOST = 'b.332321.xyz';
const PREVIEW = '/w/bookmarks-preview';
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

/* A missing page has to link back to the prefix that served it, and one static file cannot know
   which prefix that was — so the 404 is generated here, where the prefix is known. */
function notFound(prefix) {
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
  <p><a href="${prefix}/">Back to Bookmarks</a></p>
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

const USER_AGENT = 'Bookmarks/0.1 (+https://www.332321.xyz/w/bookmarks/)';

/* A hostname, not a URL: no scheme, no port, no path, no IP literal, no single label. */
const HOSTNAME = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

function toBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hostHash(hostname) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(hostname));
  return toBase64Url(new Uint8Array(digest));
}

/** Read at most `max` bytes, cancelling the stream the moment it exceeds the cap. */
/**
 * The first `max` bytes of a response, then stop reading.
 *
 * A page is worth reading only as far as its <head>: refusing a body because the whole document
 * is over the cap is why sites with large pages (github.com, itsfoss.com) answered "no icon" and
 * had no title to offer. Images still go through readCapped, where a short read would corrupt.
 */
async function readPrefix(response, max) {
  if (!response.body) return new Uint8Array(0);

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();
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

  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
}

async function readCapped(response, max) {
  if (!response.body) return new Uint8Array(0);

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;

    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
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
 * Follow a short redirect chain by hand.
 *
 * `wikipedia.org` serves its icon from `en.wikipedia.org`, so redirects must be followed. They
 * are followed here rather than by the runtime because the local runtime does not complete this
 * chain, and because each hop is checked: https only, at most three of them.
 */
async function followToImage(target, signal) {
  let current = target;

  for (let hop = 0; hop < 4; hop += 1) {
    const response = await fetch(current, {
      headers: {
        accept: 'image/*',
        'user-agent': USER_AGENT
      },
      redirect: 'manual',
      signal
    });

    if (response.status < 300 || response.status >= 400) return response;

    const location = response.headers.get('location');
    if (!location) return response;

    const next = new URL(location, current);
    if (next.protocol !== 'https:') return null;

    current = next.toString();
  }

  return null;
}

/**
 * Find the icon a page declares, for the half of the web that does not serve `/favicon.ico`.
 * Only the first `<link rel="...icon...">` is used; the href is resolved against the page and
 * must be https.
 */
async function discoverIcon(hostname, signal) {
  const pageUrl = `https://${hostname}/`;

  let page;
  try {
    page = await fetch(pageUrl, {
      headers: { accept: 'text/html', 'user-agent': USER_AGENT },
      redirect: 'follow',
      signal
    });
  } catch {
    return null;
  }

  if (!page.ok) return null;
  const pageType = (page.headers.get('content-type') ?? '').toLowerCase();
  if (!pageType.includes('text/html')) return null;

  const bytes = await readPrefix(page, ICON_PAGE_MAX_BYTES);

  const html = new TextDecoder().decode(bytes);
  const link = html.match(/<link\b[^>]*\brel\s*=\s*["']?[^"'>]*\bicon\b[^"'>]*["']?[^>]*>/i);
  if (!link) return null;

  const href = link[0].match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1];
  if (!href) return null;

  try {
    const url = new URL(href, pageUrl);
    return url.protocol === 'https:' ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * The icon service.
 *
 * The hostname travels in a header, not the query string, and the URL carries only its SHA-256.
 * That keeps the domain out of the request path — which is the part Cloudflare's logs record —
 * while still giving the edge a deterministic cache key per host. The hash is re-derived here,
 * so a caller cannot ask for a host that does not match the key it is cached under.
 *
 * The Worker is the only party that contacts the bookmarked site, once, and every other user is
 * served the cached bytes. No hostname is logged by this code.
 */
async function handleIcon(request, url) {
  if (request.method !== 'GET') return json({ error: 'method' }, 405);

  const hostname = (request.headers.get('x-icon-host') ?? '').trim();
  if (!HOSTNAME.test(hostname)) return json({ error: 'bad_host' }, 400);

  const claimed = url.searchParams.get('h') ?? '';
  if (claimed !== (await hostHash(hostname))) return json({ error: 'bad_hash' }, 400);

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), ICON_TIMEOUT_MS);

  let upstream = null;
  let type = null;

  try {
    upstream = await followToImage(`https://${hostname}/favicon.ico`, abort.signal);
    type = upstream ? iconTypeOf(upstream) : null;

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
  } catch {
    return new Response(null, {
      status: 502,
      headers: { 'cache-control': 'public, max-age=300' }
    });
  } finally {
    clearTimeout(timer);
  }

  if (!upstream || !upstream.ok || !type) {
    return new Response(null, {
      status: 404,
      headers: { 'cache-control': 'public, max-age=600' }
    });
  }

  const declared = Number(upstream.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > ICON_MAX_BYTES) {
    return new Response(null, {
      status: 413,
      headers: { 'cache-control': 'public, max-age=600' }
    });
  }

  const bytes = await readCapped(upstream, ICON_MAX_BYTES);
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
      'content-security-policy': "default-src 'none'"
    }
  });
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
  let page;
  try {
    page = await fetch(`https://${hostname}/`, {
      headers: { accept: 'text/html', 'user-agent': USER_AGENT },
      redirect: 'follow',
      signal
    });
  } catch {
    return null;
  }

  if (!page.ok) return null;
  const type = (page.headers.get('content-type') ?? '').toLowerCase();
  if (!type.includes('text/html')) return null;

  const bytes = await readPrefix(page, ICON_PAGE_MAX_BYTES);

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
async function handleTitle(request, url) {
  if (request.method !== 'GET') return json({ error: 'method' }, 405);

  const hostname = (request.headers.get('x-page-host') ?? '').trim();
  if (!HOSTNAME.test(hostname)) return json({ error: 'bad_host' }, 400);

  const claimed = url.searchParams.get('h') ?? '';
  if (claimed !== (await hostHash(hostname))) return json({ error: 'bad_hash' }, 400);

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), ICON_TIMEOUT_MS);

  try {
    const title = await fetchPageTitle(hostname, abort.signal);
    return title ? cachedJson({ title }, 604_800) : json({ error: 'no_title' }, 404);
  } catch {
    return json({ error: 'failed' }, 502);
  } finally {
    clearTimeout(timer);
  }
}

async function handleApi(request, env, url) {
  const path = url.pathname.slice(API_PREFIX.length);

  if (path === '/health') return json({ ok: true, version: VERSION });
  if (path === ICON_PATH) return handleIcon(request, url);
  if (path === TITLE_PATH) return handleTitle(request, url);

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
    return stub.fetch(new Request(target, request));
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

    const prefix =
      url.pathname === PREVIEW || url.pathname.startsWith(`${PREVIEW}/`) ? PREVIEW : CANONICAL;

    /* The preview route serves the canonical asset tree, so a file is never moved at cutover:
       /w/bookmarks-preview/style.css reads /w/bookmarks/style.css. */
    if (url.pathname === PREVIEW) return redirect(url, `${PREVIEW}/`);
    if (url.pathname.startsWith(`${PREVIEW}/`)) {
      url.pathname = CANONICAL + url.pathname.slice(PREVIEW.length);
    }

    if (url.pathname === CANONICAL) return redirect(url, `${CANONICAL}/`);

    if (SITE_STYLESHEETS.has(url.pathname)) {
      const upstream = await fetch(`https://www.332321.xyz${url.pathname}`);
      const headers = new Headers(upstream.headers);
      headers.set('cache-control', 'public, max-age=86400');
      return new Response(upstream.body, { status: upstream.status, headers });
    }

    if (url.pathname === API_PREFIX || url.pathname.startsWith(`${API_PREFIX}/`)) {
      try {
        return await handleApi(request, env, url);
      } catch {
        return json({ error: 'internal' }, 500);
      }
    }

    const assetUrl = new URL(url.pathname + url.search, url.origin);
    const response = await env.ASSETS.fetch(new Request(assetUrl, request));
    const headers = new Headers(response.headers);

    if (response.status === 404) {
      const page = notFound(prefix);
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
