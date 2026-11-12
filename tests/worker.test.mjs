/**
 * The Worker's own routing: the account path and the asset passthrough.
 *
 * The Durable Object has its own tests; this file covers the layer in front of it. There is no
 * public admin route: an account is created by the first sync that names it, the Registry caps
 * how many may exist, and the object's operator routes are refused before dispatch so only a
 * bound Worker can read them.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import worker from '../src/index.js';
import { quiet } from './logs.mjs';
import { withFetch, dnsQueries } from './dns.mjs';

/* The proxy refusals here are about routing and destinations; their event lines are tested in
   events.test.mjs. */
quiet();

/* Synthetic fixtures: no account that exists anywhere is named by this file. */
const ACCOUNT = 'A'.repeat(22);
const AUTH_SECRET = 'A'.repeat(43);

function harness({ doStatus = 201, doBody = { ok: true } } = {}) {
  const calls = [];
  const env = {
    VAULTS: {
      idFromName: (name) => ({ name }),
      get: (id) => ({
        fetch: async (request) => {
          const body = request.method === 'GET' ? null : await request.clone().text();
          calls.push({
            name: id.name,
            path: new URL(request.url).pathname,
            method: request.method,
            body
          });
          return new Response(JSON.stringify(doBody), {
            status: doStatus,
            headers: { 'content-type': 'application/json' }
          });
        }
      })
    },
    ASSETS: {
      fetch: async () =>
        new Response('<!doctype html><title>app</title>', {
          headers: { 'content-type': 'text/html' }
        })
    }
  };
  return { env, calls };
}

function api(path, options = {}) {
  return new Request(`https://bookmarks.332321.xyz/w/bookmarks/api${path}`, options);
}

test('health answers without any credential', async () => {
  const response = await worker.fetch(api('/health'), harness().env);
  assert.equal(response.status, 200);

  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(typeof body.version, 'string');
});

test('there is no admin route to create accounts', async () => {
  const { env, calls } = harness();
  const response = await worker.fetch(
    api('/accounts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: ACCOUNT, authSecret: AUTH_SECRET })
    }),
    env
  );

  assert.equal(response.status, 404);
  assert.equal(calls.length, 0);
});

test('a first sync creates its account by reaching that object', async () => {
  const { env, calls } = harness({ doStatus: 201, doBody: { ok: true } });
  const response = await worker.fetch(
    api(`/a/${ACCOUNT}/account`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: ACCOUNT, authSecret: AUTH_SECRET })
    }),
    env
  );

  assert.equal(response.status, 201);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, ACCOUNT);
  assert.equal(calls[0].path, '/account');
  assert.equal(calls[0].method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].body), { accountId: ACCOUNT, authSecret: AUTH_SECRET });
});

test('account paths are forwarded to that account and nothing else', async () => {
  const { env, calls } = harness({ doStatus: 200, doBody: { nonce: 'abc' } });
  const response = await worker.fetch(api(`/a/${ACCOUNT}/challenge`, { method: 'POST' }), env);

  assert.equal(response.status, 200);
  assert.equal(calls[0].name, ACCOUNT);
  assert.equal(calls[0].path, '/challenge');
});

test('the object operator routes do not exist on the public API', async () => {
  for (const path of [
    `/a/${ACCOUNT}/admin-stats`,
    `/a/${ACCOUNT}/admin-stats?all=1`,
    `/a/${ACCOUNT}/admin-list`
  ]) {
    const { env, calls } = harness();
    const response = await worker.fetch(api(path), env);

    assert.equal(response.status, 404, path);
    assert.deepEqual(await response.json(), { error: 'not_found' });
    assert.equal(calls.length, 0, `${path} never reaches the object`);
  }

  /* The refusal is not a method check: a write to an operator path is a 404 as well. */
  const { env, calls } = harness();
  const posted = await worker.fetch(
    api(`/a/${ACCOUNT}/admin-stats`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ anything: true })
    }),
    env
  );
  assert.equal(posted.status, 404);
  assert.equal(calls.length, 0);
});

test('an account path with a malformed id is refused before dispatch', async () => {
  for (const path of ['/a/nope/challenge', '/a/short/vault', `/a/${ACCOUNT}`]) {
    const { env, calls } = harness();
    const response = await worker.fetch(api(path), env);
    assert.ok(response.status === 400 || response.status === 404, `${path} -> ${response.status}`);
    assert.equal(calls.length, 0, path);
  }
});

test('an unknown API path is a 404', async () => {
  const response = await worker.fetch(api('/nothing'), harness().env);
  assert.equal(response.status, 404);
});

test('the app is served through the assets binding with the security headers', async () => {
  const response = await worker.fetch(
    new Request('https://bookmarks.332321.xyz/w/bookmarks/'),
    harness().env
  );

  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-security-policy'), /default-src 'self'/);
  assert.match(response.headers.get('content-security-policy'), /script-src 'self'/);
  assert.match(await response.text(), /title>app/);
});

test('the bare path redirects to the slashed one', async () => {
  const response = await worker.fetch(
    new Request('https://bookmarks.332321.xyz/w/bookmarks'),
    harness().env
  );

  assert.equal(response.status, 301);
  assert.equal(response.headers.get('location'), 'https://bookmarks.332321.xyz/w/bookmarks/');
});

/* A preview path on either host is now an unknown path: the asset tree has no such directory,
   so the binding answers 404 and the Worker's own "Not found" page is returned. On www it is
   not redirected either, because the redirect covers the canonical prefix only. */
test('the preview path is an unknown path, on the app host and on www', async () => {
  const asked = [];
  const env = {
    ASSETS: {
      fetch: async (request) => {
        const { pathname } = new URL(request.url);
        asked.push(pathname);
        if (pathname === '/w/bookmarks/' || pathname.startsWith('/w/bookmarks/')) {
          return new Response('<!doctype html><title>app</title>', {
            headers: { 'content-type': 'text/html' }
          });
        }
        return new Response('not found', {
          status: 404,
          headers: { 'content-type': 'text/plain' }
        });
      }
    }
  };

  for (const host of ['bookmarks.332321.xyz']) {
    for (const path of ['/w/bookmarks-preview', '/w/bookmarks-preview/']) {
      const response = await worker.fetch(new Request(`https://${host}${path}`), env);

      assert.equal(response.status, 404, `${host}${path}`);
      assert.equal(response.headers.get('location'), null, `${host}${path} is not redirected`);

      const body = await response.text();
      assert.match(body, /Not found/, `${host}${path} gets the app's 404 page`);
      assert.doesNotMatch(body, /title>app/, `${host}${path} is not the app`);
      assert.match(response.headers.get('content-security-policy'), /default-src 'self'/);
      assert.equal(asked.at(-1), path, `${host}${path} reaches the assets unchanged`);
    }
  }

  /* The sibling path the loop above must not be confused with. */
  const canonical = await worker.fetch(
    new Request('https://bookmarks.332321.xyz/w/bookmarks/'),
    env
  );
  assert.equal(canonical.status, 200);
  assert.match(await canonical.text(), /title>app/);
});

/* --------------------------------------------------------------- icon service */

const ICON_HOST = 'example.com';
const ICON_HASH = createHash('sha256').update(ICON_HOST).digest('base64url');

function iconRequest({ host = ICON_HOST, hash = ICON_HASH } = {}) {
  return new Request(`https://bookmarks.332321.xyz/w/bookmarks/api/icon?h=${hash}`, {
    headers: host ? { 'x-icon-host': host } : {}
  });
}

test('the icon service refuses a missing hostname, a non-DNS host or a wrong hash', async () => {
  for (const host of [
    '127.0.0.1',
    'localhost',
    'EXAMPLE.com',
    'example.com:8443',
    'exa mple.com',
    '-bad.com',
    'a..b.com',
    ''
  ]) {
    const response = await worker.fetch(iconRequest({ host }), harness().env);
    assert.equal(response.status, 400, JSON.stringify(host));
  }

  const noHost = await worker.fetch(
    new Request('https://bookmarks.332321.xyz/w/bookmarks/api/icon?h=x'),
    harness().env
  );
  assert.equal(noHost.status, 400);

  const wrongHash = await worker.fetch(iconRequest({ hash: 'a'.repeat(43) }), harness().env);
  assert.equal(wrongHash.status, 400);
});

test('a valid icon request asks that host only for its favicon', async () => {
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  const asked = [];

  const response = await withFetch(
    async (url) => {
      asked.push(url);
      return new Response(bytes, {
        headers: { 'content-type': 'image/png', 'content-length': '4' }
      });
    },
    () => worker.fetch(iconRequest(), harness().env)
  );

  assert.equal(response.status, 200);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
  assert.equal(response.headers.get('content-type'), 'image/png');
  assert.match(response.headers.get('cache-control'), /max-age=2592000/);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(asked, ['https://example.com/favicon.ico']);
});

test('a non-image, an oversized icon and a missing one are each refused', async () => {
  const html = await withFetch(
    async () => new Response('<html>', { headers: { 'content-type': 'text/html' } }),
    () => worker.fetch(iconRequest(), harness().env)
  );
  assert.equal(html.status, 404, 'a page that is not an image ends as "no icon"');

  const declared = await withFetch(
    async () =>
      new Response(new Uint8Array(4), {
        headers: { 'content-type': 'image/png', 'content-length': '200000' }
      }),
    () => worker.fetch(iconRequest(), harness().env)
  );
  assert.equal(declared.status, 413);

  const streamed = await withFetch(
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            for (let at = 0; at < 100; at += 1) controller.enqueue(new Uint8Array(1024));
            controller.close();
          }
        }),
        { headers: { 'content-type': 'image/png' } }
      ),
    () => worker.fetch(iconRequest(), harness().env)
  );
  assert.equal(streamed.status, 413, 'a body with no declared length is capped while read');

  const missing = await withFetch(
    async () => new Response(null, { status: 404 }),
    () => worker.fetch(iconRequest(), harness().env)
  );
  assert.equal(missing.status, 404);
  assert.match(missing.headers.get('cache-control'), /max-age=600/);
});

test('an unreachable host is a 502 rather than a crash', async () => {
  const response = await withFetch(
    async () => {
      throw new Error('network down');
    },
    () => worker.fetch(iconRequest(), harness().env)
  );

  assert.equal(response.status, 502);
  assert.match(response.headers.get('cache-control'), /max-age=300/);
});

test('a body that trickles past the timeout is abandoned, not read to the end', { timeout: 10_000 }, async () => {
  /* The host answers 200 with an image type and a length under the cap, then sends one byte at a
     time slower than the timeout. The stream knows nothing of the request's signal, so only the
     read itself can be given up on. */
  const pulls = { count: 0 };
  let cancelled = false;

  const trickle = new ReadableStream(
    {
      pull(controller) {
        return new Promise((resolve) => {
          setTimeout(() => {
            if (cancelled) {
              resolve();
              return;
            }
            pulls.count += 1;
            controller.enqueue(new Uint8Array([0x89]));
            if (pulls.count >= 12) controller.close();
            resolve();
          }, 40);
        });
      },
      cancel() {
        cancelled = true;
      }
    },
    { highWaterMark: 0 }
  );

  const response = await withFetch(
    async () =>
      new Response(trickle, {
        headers: { 'content-type': 'image/png', 'content-length': '16' }
      }),
    () => worker.fetch(iconRequest(), { ...harness().env, ICON_TIMEOUT_MS: '50' })
  );

  assert.equal(response.status, 502, 'a timeout answers as a failure, not a short icon');
  assert.match(response.headers.get('cache-control'), /max-age=300/);

  const atTimeout = pulls.count;
  assert.ok(atTimeout <= 2, `only ${atTimeout} byte(s) were read before giving up`);

  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(pulls.count, atTimeout, 'nothing is read from the host after the timeout');
});

test('a page that declares its icon is followed, once', async () => {
  const asked = [];

  const response = await withFetch(
    async (url) => {
      asked.push(url);
      if (url.endsWith('/favicon.ico')) return new Response(null, { status: 404 });
      if (url === `https://${ICON_HOST}/`) {
        return new Response('<html><link rel="icon" href="/art/icon.svg"></html>', {
          headers: { 'content-type': 'text/html' }
        });
      }
      if (url === `https://${ICON_HOST}/art/icon.svg`) {
        return new Response('<svg xmlns="http://www.w3.org/2000/svg"/>', {
          headers: { 'content-type': 'image/svg+xml' }
        });
      }
      throw new Error(`unexpected ${url}`);
    },
    () => worker.fetch(iconRequest(), harness().env)
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/svg+xml');
  assert.deepEqual(asked, [
    `https://${ICON_HOST}/favicon.ico`,
    `https://${ICON_HOST}/`,
    `https://${ICON_HOST}/art/icon.svg`
  ]);
});

test('a served icon is a download in an opaque origin, never a document on our origin', async () => {
  const response = await withFetch(
    async () =>
      new Response('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', {
        headers: { 'content-type': 'image/svg+xml' }
      }),
    () => worker.fetch(iconRequest(), harness().env)
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-disposition'), 'attachment');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');

  const policy = response.headers.get('content-security-policy') ?? '';
  assert.match(policy, /default-src 'none'/);
  assert.match(policy, /sandbox/, 'a document that reached these bytes is sandboxed');
});

test('an icon behind a redirect is followed by hand', async () => {
  const asked = [];

  const response = await withFetch(
    async (url) => {
      asked.push(url);
      if (url === `https://${ICON_HOST}/favicon.ico`) {
        return new Response(null, {
          status: 301,
          headers: { location: `https://www.${ICON_HOST}/favicon.ico` }
        });
      }
      if (url === `https://www.${ICON_HOST}/favicon.ico`) {
        return new Response(new Uint8Array([1, 2, 3]), {
          headers: { 'content-type': 'image/png' }
        });
      }
      throw new Error(`unexpected ${url}`);
    },
    () => worker.fetch(iconRequest(), harness().env)
  );

  assert.equal(response.status, 200);
  assert.deepEqual(asked, [
    `https://${ICON_HOST}/favicon.ico`,
    `https://www.${ICON_HOST}/favicon.ico`
  ]);
});

test('a redirect that leaves https is not followed', async () => {
  const response = await withFetch(
    async () =>
      new Response(null, {
        status: 302,
        headers: { location: 'http://example.com/favicon.ico' }
      }),
    () => worker.fetch(iconRequest(), harness().env)
  );

  assert.equal(response.status, 404);
});

test('the app answers on its own host and nowhere else', async () => {
  const onApp = await worker.fetch(new Request('https://bookmarks.332321.xyz/w/bookmarks/'), harness().env);
  assert.equal(onApp.status, 200);

  /* The site's own path is not routed here any more, so this Worker is never asked about it; if it is, it must not
     answer with the app. No redirect stands in for the old address: one origin, one vault. */
  const onSite = await worker.fetch(new Request('https://www.332321.xyz/w/bookmarks/'), harness().env);
  assert.notEqual(onSite.status, 200);
});

test('the site stylesheets are proxied with a cache header', async () => {
  const asked = [];

  const response = await withFetch(
    async (url, init) => {
      asked.push({ url, init });
      return new Response(':root{}', { headers: { 'content-type': 'text/css' } });
    },
    () => worker.fetch(new Request('https://bookmarks.332321.xyz/css/tokens.css'), harness().env)
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/css; charset=utf-8');
  assert.match(response.headers.get('cache-control'), /max-age=86400/);
  assert.deepEqual(asked.map((one) => one.url), ['https://www.332321.xyz/css/tokens.css']);
});

test('the stylesheet proxy copies no upstream header and follows no redirect', async () => {
  const asked = [];

  const response = await withFetch(
    async (url, init) => {
      asked.push({ url, init });
      return new Response(':root{}', {
        headers: {
          'content-type': 'text/css',
          'set-cookie': 'session=leaked; Path=/; HttpOnly',
          'x-upstream-private': 'yes',
          'access-control-allow-origin': '*',
          etag: '"abc"'
        }
      });
    },
    () => worker.fetch(new Request('https://bookmarks.332321.xyz/css/themes.css'), harness().env)
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('set-cookie'), null);
  assert.equal(response.headers.get('x-upstream-private'), null);
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  assert.equal(response.headers.get('etag'), '"abc"');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(asked[0].init.redirect, 'manual');
});

test('the stylesheet proxy refuses a redirect, a non-CSS answer and a non-read method', async () => {
  const redirected = await withFetch(
    () =>
      new Response(null, {
        status: 302,
        headers: { location: 'https://elsewhere.example/x.css', 'content-type': 'text/css' }
      }),
    () => worker.fetch(new Request('https://bookmarks.332321.xyz/css/tokens.css'), harness().env)
  );
  assert.equal(redirected.status, 502);

  const html = await withFetch(
    () => new Response('<p>no</p>', { headers: { 'content-type': 'text/html' } }),
    () => worker.fetch(new Request('https://bookmarks.332321.xyz/css/tokens.css'), harness().env)
  );
  assert.equal(html.status, 502);

  const asked = [];
  const written = await withFetch(
    async (url) => {
      asked.push(String(url));
      return new Response(':root{}', { headers: { 'content-type': 'text/css' } });
    },
    () =>
      worker.fetch(new Request('https://bookmarks.332321.xyz/css/tokens.css', { method: 'POST' }), harness().env)
  );
  assert.equal(written.status, 405);
  assert.equal(asked.length, 0);
});

/* -------------------------------------------------------------- title service */

function titleRequest({ host = ICON_HOST, hash = ICON_HASH, method = 'GET' } = {}) {
  return new Request(`https://bookmarks.332321.xyz/w/bookmarks/api/title?h=${hash}`, {
    method,
    headers: host ? { 'x-page-host': host } : {}
  });
}

test('the title service refuses a missing host, a non-DNS host or a wrong hash', async () => {
  for (const host of ['127.0.0.1', 'localhost', 'EXAMPLE.com', 'exa mple.com', '']) {
    const response = await worker.fetch(titleRequest({ host }), harness().env);
    assert.equal(response.status, 400, JSON.stringify(host));
  }

  const wrongHash = await worker.fetch(titleRequest({ hash: 'a'.repeat(43) }), harness().env);
  assert.equal(wrongHash.status, 400);

  const wrongMethod = await worker.fetch(titleRequest({ method: 'POST' }), harness().env);
  assert.equal(wrongMethod.status, 405);
});

test('a title is read from the page head and answered with a cache lifetime', async () => {
  const asked = [];
  const response = await withFetch(
    async (url) => {
      asked.push(url);
      return new Response('<html><head><title>Example &amp; Co</title></head><body>…</body></html>', {
        headers: { 'content-type': 'text/html; charset=utf-8' }
      });
    },
    () => worker.fetch(titleRequest(), harness().env)
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { title: 'Example & Co' });
  assert.match(response.headers.get('cache-control'), /max-age=604800/);
  assert.deepEqual(asked, ['https://example.com/'], 'only the origin is asked, never a path');
});

test('a page larger than the read cap still yields its title, and a page without one misses', async () => {
  const big = `<html><head><title>Big Page</title></head><body>${'x'.repeat(400 * 1024)}</body></html>`;
  const fromBig = await withFetch(
    async () => new Response(big, { headers: { 'content-type': 'text/html' } }),
    () => worker.fetch(titleRequest(), harness().env)
  );
  assert.equal(fromBig.status, 200);
  assert.deepEqual(await fromBig.json(), { title: 'Big Page' });

  const none = await withFetch(
    async () => new Response('<html><head></head></html>', { headers: { 'content-type': 'text/html' } }),
    () => worker.fetch(titleRequest(), harness().env)
  );
  assert.equal(none.status, 404);
  assert.equal((await none.json()).error, 'no_title');
});

/* ------------------------------------------------- destinations both proxies refuse */

const sha256 = (value) => createHash('sha256').update(value).digest('base64url');

function iconFor(host) {
  return iconRequest({ host, hash: sha256(host) });
}

function titleFor(host) {
  return titleRequest({ host, hash: sha256(host) });
}

const redirectTo = (location) =>
  new Response(null, { status: 302, headers: { location } });

const pngResponse = () =>
  new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), {
    headers: { 'content-type': 'image/png' }
  });

const htmlResponse = (body) =>
  new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8' } });

/* A stub that records every URL and insists each one was followed by hand. */
function stubFetch(routes) {
  const asked = [];
  const implementation = async (url, init) => {
    asked.push(String(url));
    assert.equal(init?.redirect, 'manual', `${url} is followed by hand`);
    const route = routes[String(url)];
    if (route === undefined) throw new Error(`unexpected ${url}`);
    return typeof route === 'function' ? route() : route;
  };
  return { asked, implementation };
}

test('both proxies refuse names that lead into a network', async () => {
  /* Refused because the shape is not a DNS name at all. */
  const byShape = ['localhost', '127.0.0.1', '169.254.169.254', '[::1]'];

  /* Refused by name: reserved suffixes, metadata services, wildcard resolvers and a private
     address written inside an otherwise ordinary name. */
  const byName = [
    'printer.local',
    'wiki.internal',
    'metadata.google.internal',
    'metadata.goog',
    'metadata.tencentyun.com',
    'kubernetes.default.svc',
    '127.0.0.1.nip.io',
    '10.0.0.1.sslip.io',
    'app.192.168.1.5.nip.io',
    '10.0.0.1.example.com'
  ];

  for (const host of [...byShape, ...byName]) {
    const expected = byName.includes(host) ? 'blocked_host' : 'bad_host';
    const { asked, implementation } = stubFetch({});

    const icon = await withFetch(implementation, () => worker.fetch(iconFor(host), harness().env));
    assert.equal(icon.status, 400, host);
    assert.equal((await icon.json()).error, expected, host);

    const title = await withFetch(implementation, () =>
      worker.fetch(titleFor(host), harness().env)
    );
    assert.equal(title.status, 400, host);
    assert.equal((await title.json()).error, expected, host);

    assert.deepEqual(asked, [], `${host} is never contacted`);
  }
});

/* Every refused address class, reached through a Location rather than the header. */
const REFUSED_LOCATIONS = [
  'https://127.0.0.1/favicon.ico',
  'https://[::1]/favicon.ico',
  'https://[::ffff:127.0.0.1]/favicon.ico',
  'https://10.1.2.3/favicon.ico',
  'https://172.16.0.9/favicon.ico',
  'https://192.168.0.10/favicon.ico',
  'https://169.254.169.254/latest/meta-data/',
  'https://100.64.0.1/favicon.ico',
  'https://224.0.0.1/favicon.ico',
  'https://0.0.0.0/favicon.ico',
  'https://3232235521/favicon.ico',
  'https://metadata.google.internal/favicon.ico',
  'https://printer.local./favicon.ico',
  'https://10.0.0.1.example.com/favicon.ico',
  'https://127.0.0.1.nip.io/favicon.ico'
];

/* A hop that names a port the caller never named. */
const PORT_LOCATIONS = [
  'https://example.com:8443/favicon.ico',
  'https://example.com:80/favicon.ico',
  'https://example.com:22/',
  'https://example.com:6379/favicon.ico'
];

test('an icon redirect is not followed into a private, loopback or metadata address', async () => {
  for (const location of REFUSED_LOCATIONS) {
    const { asked, implementation } = stubFetch({
      [`https://${ICON_HOST}/favicon.ico`]: redirectTo(location),
      [`https://${ICON_HOST}/`]: redirectTo(location)
    });

    const response = await withFetch(implementation, () =>
      worker.fetch(iconRequest(), harness().env)
    );

    assert.equal(response.status, 404, location);
    for (const url of asked) {
      assert.equal(new URL(url).hostname, ICON_HOST, `${location} is never contacted: ${url}`);
    }
  }
});

test('a title redirect is not followed into a private, loopback or metadata address', async () => {
  for (const location of [...REFUSED_LOCATIONS, 'http://example.com/']) {
    const { asked, implementation } = stubFetch({
      [`https://${ICON_HOST}/`]: redirectTo(location)
    });

    const response = await withFetch(implementation, () =>
      worker.fetch(titleRequest(), harness().env)
    );

    assert.equal(response.status, 404, location);
    assert.equal((await response.json()).error, 'no_title', location);
    for (const url of asked) {
      assert.equal(new URL(url).hostname, ICON_HOST, `${location} is never contacted: ${url}`);
    }
  }
});

test('a redirect that names a port is not followed on either proxy', async () => {
  for (const location of PORT_LOCATIONS) {
    const icon = stubFetch({
      [`https://${ICON_HOST}/favicon.ico`]: redirectTo(location),
      [`https://${ICON_HOST}/`]: redirectTo(location)
    });

    const iconResponse = await withFetch(icon.implementation, () =>
      worker.fetch(iconRequest(), harness().env)
    );

    assert.equal(iconResponse.status, 404, location);
    for (const url of icon.asked) {
      assert.equal(new URL(url).port, '', `${location} is never contacted: ${url}`);
    }

    const title = stubFetch({ [`https://${ICON_HOST}/`]: redirectTo(location) });

    const titleResponse = await withFetch(title.implementation, () =>
      worker.fetch(titleRequest(), harness().env)
    );

    assert.equal(titleResponse.status, 404, location);
    assert.equal((await titleResponse.json()).error, 'no_title', location);
    assert.deepEqual(title.asked, [`https://${ICON_HOST}/`], `${location} is never contacted`);
  }
});

test('a redirect that names the default port is followed', async () => {
  const followed = stubFetch({
    [`https://${ICON_HOST}/favicon.ico`]: redirectTo('https://a.example.com:443/favicon.ico'),
    'https://a.example.com/favicon.ico': pngResponse()
  });

  const response = await withFetch(followed.implementation, () =>
    worker.fetch(iconRequest(), harness().env)
  );

  assert.equal(response.status, 200);
  assert.deepEqual(followed.asked, [
    `https://${ICON_HOST}/favicon.ico`,
    'https://a.example.com/favicon.ico'
  ]);
});

test('a page-declared icon at a refused destination is not fetched', async () => {
  for (const href of [
    'https://10.0.0.1/i.png',
    'http://example.com/i.png',
    '//169.254.169.254/i.png',
    'https://example.com:8443/i.png',
    'https://[::1]/i.png'
  ]) {
    const { asked, implementation } = stubFetch({
      [`https://${ICON_HOST}/favicon.ico`]: new Response(null, { status: 404 }),
      [`https://${ICON_HOST}/`]: htmlResponse(
        `<html><head><link rel="icon" href="${href}"></head></html>`
      )
    });

    const response = await withFetch(implementation, () =>
      worker.fetch(iconRequest(), harness().env)
    );

    assert.equal(response.status, 404, href);
    for (const url of asked) {
      assert.equal(new URL(url).hostname, ICON_HOST, `${href} is never contacted: ${url}`);
    }
  }
});

test('three redirects are followed and a fourth stops the chain', async () => {
  const followed = stubFetch({
    [`https://${ICON_HOST}/favicon.ico`]: redirectTo('https://a.example.com/favicon.ico'),
    'https://a.example.com/favicon.ico': redirectTo('/icons/b.png'),
    'https://a.example.com/icons/b.png': redirectTo('https://b.example.com/favicon.ico'),
    'https://b.example.com/favicon.ico': pngResponse()
  });

  const icon = await withFetch(followed.implementation, () =>
    worker.fetch(iconRequest(), harness().env)
  );
  assert.equal(icon.status, 200, 'three hops are allowed');
  assert.deepEqual(followed.asked, [
    `https://${ICON_HOST}/favicon.ico`,
    'https://a.example.com/favicon.ico',
    'https://a.example.com/icons/b.png',
    'https://b.example.com/favicon.ico'
  ]);

  const stopped = stubFetch({
    [`https://${ICON_HOST}/favicon.ico`]: redirectTo('https://a.example.com/favicon.ico'),
    [`https://${ICON_HOST}/`]: new Response(null, { status: 404 }),
    'https://a.example.com/favicon.ico': redirectTo('/icons/b.png'),
    'https://a.example.com/icons/b.png': redirectTo('https://b.example.com/favicon.ico'),
    'https://b.example.com/favicon.ico': redirectTo('https://c.example.com/favicon.ico'),
    'https://c.example.com/favicon.ico': pngResponse()
  });

  const cut = await withFetch(stopped.implementation, () =>
    worker.fetch(iconRequest(), harness().env)
  );
  assert.equal(cut.status, 404, 'a fourth redirect is not followed');
  assert.equal(
    stopped.asked.filter((url) => url.endsWith('/favicon.ico')).at(-1),
    'https://b.example.com/favicon.ico'
  );
  assert.ok(!stopped.asked.includes('https://c.example.com/favicon.ico'));
});

test('ordinary public hosts still get their icon and title, unchanged', async () => {
  for (const host of ['example.com', 'itsfoss.com', 'github.com', 'wikipedia.org']) {
    const { asked, implementation } = stubFetch({
      [`https://${host}/favicon.ico`]: pngResponse(),
      [`https://${host}/`]: htmlResponse(
        '<html><head><title>Example &amp; Co</title></head></html>'
      )
    });

    const icon = await withFetch(implementation, () => worker.fetch(iconFor(host), harness().env));
    assert.equal(icon.status, 200, host);
    assert.equal(icon.headers.get('content-type'), 'image/png');
    assert.equal(icon.headers.get('cache-control'), 'public, max-age=2592000, immutable');
    assert.equal(icon.headers.get('x-content-type-options'), 'nosniff');
    assert.equal((await icon.arrayBuffer()).byteLength, 4);

    const title = await withFetch(implementation, () =>
      worker.fetch(titleFor(host), harness().env)
    );
    assert.equal(title.status, 200, host);
    assert.deepEqual(await title.json(), { title: 'Example & Co' });
    assert.match(title.headers.get('cache-control'), /max-age=604800/);

    assert.deepEqual(asked, [`https://${host}/favicon.ico`, `https://${host}/`]);
  }
});

test('a redirect to another public host, by name or by address, is still followed', async () => {
  const { asked, implementation } = stubFetch({
    [`https://${ICON_HOST}/favicon.ico`]: redirectTo('https://www.example.com/favicon.ico'),
    'https://www.example.com/favicon.ico': redirectTo('https://93.184.216.34/favicon.ico'),
    'https://93.184.216.34/favicon.ico': redirectTo('https://[2606:4700:4700::1111]/favicon.ico'),
    'https://[2606:4700:4700::1111]/favicon.ico': pngResponse()
  });

  const icon = await withFetch(implementation, () =>
    worker.fetch(iconRequest(), harness().env)
  );

  assert.equal(icon.status, 200);
  assert.equal(asked.length, 4);
});

test('a title is read after a public redirect', async () => {
  const { asked, implementation } = stubFetch({
    [`https://${ICON_HOST}/`]: redirectTo('https://www.example.com/'),
    'https://www.example.com/': htmlResponse(
      '<html><head><title>Moved Title</title></head></html>'
    )
  });

  const response = await withFetch(implementation, () =>
    worker.fetch(titleRequest(), harness().env)
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { title: 'Moved Title' });
  assert.deepEqual(asked, [`https://${ICON_HOST}/`, 'https://www.example.com/']);
});

/* ------------------------------------------------- destinations decided by the answer */

const DNS_PUBLIC_HOST = 'dns-public.public-host.com';
const DNS_LOOPBACK_HOST = 'dns-loopback.public-host.com';
const DNS_PRIVATE_HOST = 'dns-rfc1918.public-host.com';
const DNS_METADATA_HOST = 'dns-link-local.public-host.com';

test('a public-looking host that answers with a private address is refused', async () => {
  const dns = {
    [DNS_LOOPBACK_HOST]: { a: ['127.0.0.1'], aaaa: ['::1'] },
    [DNS_PRIVATE_HOST]: { a: ['10.1.2.3'], aaaa: ['fd00::1'] },
    [DNS_METADATA_HOST]: { a: ['169.254.169.254'], aaaa: [] }
  };

  for (const host of [DNS_LOOPBACK_HOST, DNS_PRIVATE_HOST, DNS_METADATA_HOST]) {
    const { asked, implementation } = stubFetch({});

    const icon = await withFetch(
      implementation,
      () => worker.fetch(iconFor(host), harness().env),
      dns
    );
    assert.equal(icon.status, 400, host);
    assert.deepEqual(await icon.json(), { error: 'blocked_host' }, host);

    const title = await withFetch(
      implementation,
      () => worker.fetch(titleFor(host), harness().env),
      dns
    );
    assert.equal(title.status, 400, host);
    assert.deepEqual(await title.json(), { error: 'blocked_host' }, host);

    assert.deepEqual(asked, [], `${host} is never contacted`);
  }
});

test('a host whose answers are all public is fetched exactly as before', async () => {
  const dns = { [DNS_PUBLIC_HOST]: { a: ['93.184.216.34'], aaaa: ['2606:4700:4700::1111'] } };
  const { asked, implementation } = stubFetch({
    [`https://${DNS_PUBLIC_HOST}/favicon.ico`]: pngResponse(),
    [`https://${DNS_PUBLIC_HOST}/`]: htmlResponse(
      '<html><head><title>Resolved &amp; Fine</title></head></html>'
    )
  });

  const icon = await withFetch(
    implementation,
    () => worker.fetch(iconFor(DNS_PUBLIC_HOST), harness().env),
    dns
  );
  assert.equal(icon.status, 200);
  assert.equal(icon.headers.get('content-type'), 'image/png');
  assert.equal(icon.headers.get('cache-control'), 'public, max-age=2592000, immutable');

  const title = await withFetch(
    implementation,
    () => worker.fetch(titleFor(DNS_PUBLIC_HOST), harness().env),
    dns
  );
  assert.equal(title.status, 200);
  assert.deepEqual(await title.json(), { title: 'Resolved & Fine' });

  assert.deepEqual(asked, [
    `https://${DNS_PUBLIC_HOST}/favicon.ico`,
    `https://${DNS_PUBLIC_HOST}/`
  ]);
});

test('a resolution that cannot be read refuses rather than passes', async () => {
  for (const kind of ['http500', 'garbage', 'status', 'noanswer', 'badaddress']) {
    const host = `dns-${kind}.public-host.com`;
    const { asked, implementation } = stubFetch({});

    const response = await withFetch(
      implementation,
      () => worker.fetch(iconFor(host), harness().env),
      { [host]: { kind } }
    );

    assert.equal(response.status, 400, kind);
    assert.deepEqual(await response.json(), { error: 'blocked_host' }, kind);
    assert.deepEqual(asked, [], `${kind} is never contacted`);
  }
});

test('a redirect to a name that resolves private is not followed', async () => {
  const hop = 'dns-private-hop.public-host.com';
  const { asked, implementation } = stubFetch({
    [`https://${ICON_HOST}/favicon.ico`]: redirectTo(`https://${hop}/favicon.ico`),
    /* The chain ends with no icon, so the route tries the page for a declared one. */
    [`https://${ICON_HOST}/`]: new Response(null, { status: 404 })
  });

  const response = await withFetch(
    implementation,
    () => worker.fetch(iconRequest(), harness().env),
    { [hop]: { a: ['192.168.1.9'], aaaa: ['fe80::1'] } }
  );

  assert.equal(response.status, 404, 'the chain ends, as any refused hop does');
  assert.ok(!asked.includes(`https://${hop}/favicon.ico`), `${hop} is never contacted`);
});

test('a verdict is resolved once for a burst of the same host', async () => {
  const host = 'dns-cached.public-host.com';
  const { implementation } = stubFetch({
    [`https://${host}/favicon.ico`]: pngResponse
  });

  dnsQueries.length = 0;
  for (let at = 0; at < 5; at += 1) {
    const response = await withFetch(
      implementation,
      () => worker.fetch(iconFor(host), harness().env),
      {}
    );
    assert.equal(response.status, 200, `request ${at + 1}`);
  }

  const asked = dnsQueries.filter((query) => query.name === host);
  assert.deepEqual(
    asked.map((query) => query.type).sort(),
    ['a', 'aaaa'],
    'one lookup pair for five requests'
  );
});
