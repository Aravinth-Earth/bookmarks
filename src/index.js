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
const PREVIEW = '/w/bookmarks-preview';
const API_PREFIX = `${CANONICAL}/api`;
const VERSION = '0.1.0';

/* In production the route is scoped to /w/bookmarks/*, so these two files are served by the
   static site and never reach this Worker. Under `wrangler dev` there is no zone and every path
   arrives here, so they are proxied from the canonical origin to keep local identical. The
   allowlist is the guard: production cannot reach this branch, and widening it would still only
   proxy two stylesheets. */
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
 * the session and the sealed vault live. `/accounts` is the one admin-only route, and it is
 * what creates an object in the first place.
 */
const ACCOUNT_ID = /^[A-Za-z0-9_-]{22}$/;

function safeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || left.length !== right.length) {
    return false;
  }
  let difference = 0;
  for (let at = 0; at < left.length; at += 1) {
    difference |= left.charCodeAt(at) ^ right.charCodeAt(at);
  }
  return difference === 0;
}

async function createAccount(request, env) {
  if (request.method !== 'POST') return json({ error: 'method' }, 405);

  const header = request.headers.get('authorization') ?? '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!env.PROVISION_TOKEN || !match || !safeEqual(match[1].trim(), env.PROVISION_TOKEN)) {
    return json({ error: 'unauthorized' }, 401);
  }

  const body = await request.json().catch(() => null);
  const accountId = body?.accountId;
  const authSecret = body?.authSecret;
  if (!ACCOUNT_ID.test(accountId ?? '') || typeof authSecret !== 'string') {
    return json({ error: 'invalid' }, 400);
  }

  const stub = env.VAULTS.get(env.VAULTS.idFromName(accountId));
  const response = await stub.fetch(
    new Request('https://vault/account', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId, authSecret })
    })
  );
  return new Response(response.body, {
    status: response.status,
    headers: response.headers
  });
}

const ICON_PATH = '/icon';
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

  const bytes = await readCapped(page, ICON_PAGE_MAX_BYTES);
  if (!bytes) return null;

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

async function handleApi(request, env, url) {
  const path = url.pathname.slice(API_PREFIX.length);

  if (path === '/health') return json({ ok: true, version: VERSION });
  if (path === ICON_PATH) return handleIcon(request, url);
  if (path === '/accounts') return createAccount(request, env);

  if (path.startsWith('/a/')) {
    const rest = path.slice('/a/'.length);
    const slash = rest.indexOf('/');
    if (slash === -1) return json({ error: 'not_found' }, 404);

    const accountId = rest.slice(0, slash);
    if (!ACCOUNT_ID.test(accountId)) return json({ error: 'bad_account' }, 400);

    const stub = env.VAULTS.get(env.VAULTS.idFromName(accountId));
    const target = new URL(`https://vault${rest.slice(slash)}`, 'https://vault');
    return stub.fetch(new Request(target, request));
  }

  return json({ error: 'not_found' }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
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
      return fetch(`https://www.332321.xyz${url.pathname}`);
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

/* The class the binding in wrangler.toml names. */
export { Vault } from './vault.js';
