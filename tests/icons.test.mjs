/**
 * The paced icon queue, and what a refused request is allowed to mean.
 *
 * The page asks the Worker for an icon or a title, and the Worker spends one shared budget of
 * thirty requests per ten seconds per source on both routes. These cases drive the queue in fake
 * time, so what is under test is arithmetic rather than wall-clock luck: no two starts closer
 * together than the derived gap, never more than thirty starts in a rolling ten seconds, and a
 * refusal that leaves the host eligible instead of stamping it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ICON_MIN_GAP_MS,
  OUTCOME_NONE,
  OUTCOME_REFUSED,
  OUTCOME_VALUE,
  createRequestQueue,
  fetchIcon,
  fetchIconOutcome,
  isAnswer,
  retryDelayMs,
  stampAnswers
} from '../public/icons.js';
import { hostKey } from '../public/device-store.js';

const publicDir = join(dirname(dirname(fileURLToPath(import.meta.url))), 'public');
const publicSources = readdirSync(publicDir).filter((name) => name.endsWith('.js'));
const readPublic = (name) => readFileSync(join(publicDir, name), 'utf8');

/* A clock that moves only when something waits. A sweep of a hundred and twenty hosts at the
   real pace takes about forty-six seconds; the property being tested does not need them to pass. */
function fakeClock() {
  let time = 0;
  return {
    now: () => time,
    wait: (ms) => {
      time += ms;
      return Promise.resolve();
    },
    get time() {
      return time;
    }
  };
}

/** A 1×1 PNG, which is enough: `shrink` reads the bytes and the size, not the pixels. */
const PNG = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  )
);

/* Node has Blob and Response but no FileReader, and the raw fallback in `shrink` uses one — the
   same path a browser without `createImageBitmap` takes. Stubbed so the test drives the real code
   rather than a branch invented for it. */
class StubFileReader {
  readAsDataURL(blob) {
    blob
      .arrayBuffer()
      .then((buffer) => {
        this.result = `data:${blob.type};base64,${Buffer.from(buffer).toString('base64')}`;
        this.onload?.();
      })
      .catch((error) => {
        this.error = error;
        this.onerror?.();
      });
  }
}

/** Runs `body` with `globalThis.fetch` answering from `respond`, then puts the real one back. */
async function withFetch(respond, body) {
  const original = globalThis.fetch;
  const previousReader = globalThis.FileReader;
  const asked = [];

  globalThis.fetch = async (url, options) => {
    asked.push({ url: String(url), options });
    return respond(String(url), options);
  };
  globalThis.FileReader = StubFileReader;

  try {
    return { asked, result: await body() };
  } finally {
    globalThis.fetch = original;
    globalThis.FileReader = previousReader;
  }
}

test('the gap is the ceiling divided out, not a number someone liked', () => {
  /* src/index.js declares LIMITS.fetch as 30 requests per 10 seconds and counts the icon and
     title routes as that one class. 10000/30 = 333.3ms; anything slower is safe, anything faster
     is a request the edge refuses. */
  assert.ok(ICON_MIN_GAP_MS >= Math.ceil(10_000 / 30), `a ${ICON_MIN_GAP_MS}ms gap is under the ceiling`);
  assert.ok(ICON_MIN_GAP_MS < 1_000, 'a gap this large would make a sweep look broken to its owner');
});

test('a sweep of a hundred and twenty hosts never starts more than the ceiling allows', async () => {
  /* Four times one window's budget, which is the order of a page reloaded after a clear: every
     visible collected row asks at once. On the tree this replaced, all of them started in one
     tick and the tail was answered with 429s, so those rows kept lettered tiles. */
  const clock = fakeClock();
  const queue = createRequestQueue({ now: clock.now, wait: clock.wait });
  const starts = [];

  await Promise.all(
    Array.from({ length: 120 }, () =>
      queue.run(async () => {
        starts.push(clock.now());
      })
    )
  );

  assert.equal(starts.length, 120, 'every queued request ran');

  for (let at = 1; at < starts.length; at += 1) {
    const gap = starts[at] - starts[at - 1];
    assert.ok(
      gap >= ICON_MIN_GAP_MS,
      `requests ${at - 1} and ${at} started ${gap}ms apart, inside the ${ICON_MIN_GAP_MS}ms the limit allows`
    );
  }

  /* The window is checked as a rolling one ending at every start, because that is the shape the
     edge counts: a burst of thirty late in a window is refused even if the window began quietly. */
  const window = 10_000;
  let worst = 0;
  for (let end = 0; end < starts.length; end += 1) {
    let first = end;
    while (first > 0 && starts[end] - starts[first - 1] < window) first -= 1;
    worst = Math.max(worst, end - first + 1);
  }

  assert.ok(worst <= 30, `${worst} requests started inside one ${window}ms window`);
  assert.ok(starts[starts.length - 1] >= 119 * ICON_MIN_GAP_MS, 'the last host was paced behind the rest');
});

test('a refusal is not stamped, and the host is scheduled for a retry', async () => {
  const { result: outcome } = await withFetch(
    () =>
      new Response(JSON.stringify({ error: 'rate_limited' }), {
        status: 429,
        headers: { 'content-type': 'application/json', 'retry-after': '10' }
      }),
    () => fetchIconOutcome('itsfoss.com', { fresh: true })
  );

  assert.equal(outcome.kind, OUTCOME_REFUSED, 'the edge refused; the host did not answer');
  assert.equal(isAnswer(outcome), false);
  assert.equal(outcome.retryAfterMs, 10_000, 'the edge said ten seconds, and that is honoured');

  /* The seven-day index is the thing that must not move: an entry here is a host that keeps its
     lettered tile for a week because the edge was busy for a moment. */
  const tries = {};
  const retry = await stampAnswers(tries, [{ host: 'itsfoss.com', outcome, attempt: 0 }], 1_700_000_000_000);

  assert.deepEqual(tries, {}, 'a refusal wrote an entry into the retry index');
  assert.equal(retry.length, 1, 'a refused host must be left with a retry');
  assert.equal(retry[0].host, 'itsfoss.com');
  assert.equal(retry[0].delayMs, 10_000, 'the retry waits as long as the edge asked');
});

test('a definitive answer is stamped, so the host is not asked again for a week', async () => {
  const { asked, result: outcome } = await withFetch(
    () =>
      new Response(PNG, {
        status: 200,
        headers: { 'content-type': 'image/png', 'cache-control': 'no-store' }
      }),
    () => fetchIconOutcome('itsfoss.com', { fresh: true })
  );

  assert.equal(outcome.kind, OUTCOME_VALUE);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].url.startsWith('/api/icon?h='), true, 'the request is same-origin and names only a hash');

  const at = 1_700_000_000_000;
  const tries = {};
  const retry = await stampAnswers(tries, [{ host: 'itsfoss.com', outcome, attempt: 0 }], at);

  assert.deepEqual(Object.keys(tries), [await hostKey('itsfoss.com')], 'an answer is what earns the stamp');
  assert.equal(tries[await hostKey('itsfoss.com')], at);
  assert.deepEqual(retry, [], 'an answered host is not retried');
});

test('"no icon" is an answer and settles the host, while a 502 does not', async () => {
  const missing = await withFetch(
    () => new Response(null, { status: 404, headers: { 'cache-control': 'no-store' } }),
    () => fetchIconOutcome('itsfoss.com')
  );
  assert.equal(missing.result.kind, OUTCOME_NONE);
  assert.equal(isAnswer(missing.result), true, 'a host with no icon would otherwise be asked every launch');

  const broken = await withFetch(
    () => new Response(null, { status: 502, headers: { 'cache-control': 'no-store' } }),
    () => fetchIconOutcome('itsfoss.com')
  );
  assert.equal(broken.result.kind, OUTCOME_REFUSED);
  assert.equal(isAnswer(broken.result), false, 'a failed proxy hop is not "this host has no icon"');
});

test('a request that never left is a refusal, not a missing icon', async () => {
  const { result } = await withFetch(
    () => {
      throw new TypeError('network down');
    },
    () => fetchIconOutcome('itsfoss.com')
  );

  assert.equal(result.kind, OUTCOME_REFUSED, 'a transport failure would have stamped the host for a week');
  assert.equal(isAnswer(result), false);
});

test('the retry pause grows and is capped, and never undercuts what the edge asked', () => {
  assert.equal(retryDelayMs(0), 2_000);
  assert.equal(retryDelayMs(1), 4_000);
  assert.equal(retryDelayMs(2), 8_000);
  assert.equal(retryDelayMs(5), 60_000, 'consecutive refusals stop growing at a minute');
  assert.equal(retryDelayMs(9), 60_000);
  assert.equal(retryDelayMs(0, 12_000), 12_000, 'a longer instruction from the edge wins');
});

test('a no-store response is still served and still decodes', async () => {
  /* The header is about the browser's copy, not about the bytes: a response the page cannot use
     would make the icon path useless, and the one thing `no-store` may change is whether a copy
     survives the tab. */
  const { result: icon, asked } = await withFetch(
    () =>
      new Response(PNG, {
        status: 200,
        headers: { 'content-type': 'image/png', 'cache-control': 'no-store' }
      }),
    () => fetchIcon('itsfoss.com')
  );

  assert.equal(asked.length, 1);
  assert.equal(typeof icon, 'string');
  assert.equal(icon.startsWith('data:image/png'), true, `expected a data URI, got ${String(icon).slice(0, 40)}`);
});

test('nothing in the page asks a bookmarked site for its icon', () => {
  /* A direct request to the bookmark's own host would tell that site this browser exists, that
     this device visits it, and that the vault holds it — the one thing the proxy exists to
     prevent. So every request the page makes is same-origin, to /api/. */
  const offenders = [];
  let inspected = 0;

  for (const name of publicSources) {
    const text = readPublic(name);

    for (const match of text.matchAll(/(^|[^\w$])((?:this\.)?fetch)\s*\(/g)) {
      inspected += 1;
      const callee = match[2];
      const rest = text.slice(match.index + match[0].length).trimStart();
      const bare = rest.replace(/^['"`]/, '');
      const sameOrigin = /^\/api\//.test(bare) || /^\$\{(API|TITLE_API)\}/.test(bare);
      /* The sync client's own fetch is handed a base that defaults to `/api`, on this origin; it
         is never the host of a bookmark. */
      const clientBase = callee === 'this.fetch' && /^\$\{this\.base\}/.test(bare);
      /* sw.js hands its own handler the request it was given, which is same-origin by
         construction and never built from anything a bookmark holds. */
      const workerRequest = name === 'sw.js' && /^request\b/.test(bare);
      if (!sameOrigin && !clientBase && !workerRequest) offenders.push(`${name}: ${callee}(${bare.slice(0, 40)}`);
    }
  }

  assert.deepEqual(offenders, [], 'a fetch names something other than this origin’s own API');
  assert.ok(inspected >= 5, `expected to inspect the page's requests, saw ${inspected}`);

  const viaIconFile = publicSources.filter((name) => readPublic(name).includes('favicon.ico'));
  assert.deepEqual(viaIconFile, [], 'an icon file on a bookmark’s host is one edit away from being requested');

  /* And no image is ever built from a bookmark's host: a tile's `src` is a stored data URI. */
  const imageSources = [];
  for (const name of publicSources) {
    for (const match of readPublic(name).matchAll(/el\('img',\s*\{\s*src:\s*([^,}]+)/g)) {
      imageSources.push([name, match[1].trim()]);
    }
  }
  assert.ok(imageSources.length >= 3, `expected to inspect the page's images, saw ${imageSources.length}`);
  for (const [name, value] of imageSources) {
    assert.equal(
      /host|https?:|^\$\{/.test(value),
      false,
      `${name} builds an image src from ${value}, which would request a bookmarked site`
    );
  }
});
