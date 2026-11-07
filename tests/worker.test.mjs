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
  return new Request(`https://b.332321.xyz/w/bookmarks/api${path}`, options);
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
    new Request('https://b.332321.xyz/w/bookmarks/'),
    harness().env
  );

  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-security-policy'), /default-src 'self'/);
  assert.match(response.headers.get('content-security-policy'), /script-src 'self'/);
  assert.match(await response.text(), /title>app/);
});

test('the bare path redirects to the slashed one', async () => {
  const response = await worker.fetch(
    new Request('https://b.332321.xyz/w/bookmarks'),
    harness().env
  );

  assert.equal(response.status, 301);
  assert.equal(response.headers.get('location'), 'https://b.332321.xyz/w/bookmarks/');
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

  for (const host of ['b.332321.xyz', 'www.332321.xyz']) {
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
    new Request('https://b.332321.xyz/w/bookmarks/'),
    env
  );
  assert.equal(canonical.status, 200);
  assert.match(await canonical.text(), /title>app/);
});

/* --------------------------------------------------------------- icon service */

const ICON_HOST = 'example.com';
const ICON_HASH = createHash('sha256').update(ICON_HOST).digest('base64url');

function iconRequest({ host = ICON_HOST, hash = ICON_HASH } = {}) {
  return new Request(`https://b.332321.xyz/w/bookmarks/api/icon?h=${hash}`, {
    headers: host ? { 'x-icon-host': host } : {}
  });
}

async function withFetch(implementation, run) {
  const original = globalThis.fetch;
  globalThis.fetch = implementation;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
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
    new Request('https://b.332321.xyz/w/bookmarks/api/icon?h=x'),
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

test('the old www path redirects to the app host', async () => {
  const response = await worker.fetch(
    new Request('https://www.332321.xyz/w/bookmarks/'),
    harness().env
  );

  assert.equal(response.status, 301);
  assert.equal(response.headers.get('location'), 'https://b.332321.xyz/w/bookmarks/');
});

test('the site stylesheets are proxied with a cache header', async () => {
  const asked = [];

  const response = await withFetch(
    async (url) => {
      asked.push(url);
      return new Response(':root{}', { headers: { 'content-type': 'text/css' } });
    },
    () => worker.fetch(new Request('https://b.332321.xyz/css/tokens.css'), harness().env)
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/css');
  assert.match(response.headers.get('cache-control'), /max-age=86400/);
  assert.deepEqual(asked, ['https://www.332321.xyz/css/tokens.css']);
});

/* -------------------------------------------------------------- title service */

function titleRequest({ host = ICON_HOST, hash = ICON_HASH, method = 'GET' } = {}) {
  return new Request(`https://b.332321.xyz/w/bookmarks/api/title?h=${hash}`, {
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
