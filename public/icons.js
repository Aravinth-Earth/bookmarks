/**
 * Bookmarks — the favicon path, without a request from this page to any bookmarked site.
 *
 * The Worker asks a site for the icon it declares, or the one at its root, and serves the bytes
 * back from our own origin. Because that is same-origin the page can read them, and because it can
 * read them the image can be downscaled and stored inside the sealed vault. After that the icon is
 * offline, and the host is asked again only if the icon is still missing a week later.
 *
 * The site learns that this Worker asked it for an icon, at that moment. The hostname is what the
 * request names; the query string carries only its SHA-256.
 *
 * Two rules shape this module. Every request to either route goes through the one queue below, so
 * a page that has just been cleared cannot open forty sockets in one tick. And every request comes
 * back as an outcome rather than a string, because "this host has no icon" and "the edge refused
 * this page" are different facts: only the first one settles a host.
 */

import { hostKey } from './device-store.js';

const API = '/api/icon';
const TITLE_API = '/api/title';
const MAX_BYTES = 64 * 1024;
const RAW_FALLBACK_BYTES = 8 * 1024;
const TILE_PX = 32;

/* ---- one queue, paced by the ceiling the Worker already documents ---------------------------- */

/* `src/index.js` declares LIMITS.fetch as 30 requests per 10 seconds per source, and ROUTE_CLASS
   counts the icon route and the title route in that same `fetch` class — one budget shared by
   both. So the fastest this page may start requests, sustained, is one every 10000/30 = 334ms.
   The gap below is that arithmetic, not a tuning knob: change the ceiling and this follows. */
const FETCH_LIMIT = 30;
const FETCH_PERIOD_S = 10;
/* On top of the arithmetic. The edge counts a request when it arrives, and it arrives a few tens
   of milliseconds after this page calls `fetch`, over a network whose latency varies either way;
   the margin keeps two of our calls from landing inside one of the edge's ten-second windows at a
   boundary. It is why a full run of a few hundred hosts takes a couple of minutes: that is the
   ceiling working, not a fault. */
const QUEUE_SLACK_MS = 50;

/** The smallest gap between two request starts that keeps a sweep under the ceiling. */
export const ICON_MIN_GAP_MS = Math.ceil((FETCH_PERIOD_S * 1000) / FETCH_LIMIT) + QUEUE_SLACK_MS;

function afterDelay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A queue that starts one task at a time, no closer together than `gap`.
 *
 * Start-to-start: the gap runs from when one request began, not from when the one before it
 * finished, so a slow host costs its own duration and no more. Nothing starts inside the gap, so
 * two requests are never in flight there.
 *
 * `now` and `wait` are injectable so a test can drive hundreds of hosts through it in fake time;
 * the browser uses the module-level instance below. The queue is deliberately not parallel: the
 * ceiling is per source, and a page cannot ask the edge to treat its own requests as several.
 */
export function createRequestQueue({ now = () => Date.now(), wait = afterDelay, gap = ICON_MIN_GAP_MS } = {}) {
  let gate = Promise.resolve();
  let lastStart = -Infinity;

  /**
   * Runs `task` once the gap allows it, and resolves with what it returns. A task that fails
   * rejects its own caller and does not hold the queue: the gate opens before the task runs.
   */
  function run(task) {
    const opened = gate.then(async () => {
      const idle = now() - lastStart;
      if (idle < gap) await wait(gap - idle);
      lastStart = now();
    });
    gate = opened.then(
      () => {},
      () => {}
    );
    return opened.then(task);
  }

  return { run, gap };
}

/* The page's one queue. The collected sweep, the vault sweep and the name suggestion all reach
   the proxy through it, so the three together cannot add up to a burst. */
const requests = createRequestQueue();

/* ---- what a request came back as ------------------------------------------------------------- */

/** The host answered with something worth keeping: an icon, or a title. */
export const OUTCOME_VALUE = 'value';
/** The host answered and there is nothing to keep. Final: asking again today hears the same. */
export const OUTCOME_NONE = 'none';
/** No answer at all: the edge declined, or the request never arrived. Still worth asking. */
export const OUTCOME_REFUSED = 'refused';

function valueOutcome(value, status = 200) {
  return { kind: OUTCOME_VALUE, value, status, retryAfterMs: 0 };
}

function noneOutcome(status = 0) {
  return { kind: OUTCOME_NONE, value: null, status, retryAfterMs: 0 };
}

function refusedOutcome(status = 0, retryAfterMs = 0) {
  return { kind: OUTCOME_REFUSED, value: null, status, retryAfterMs };
}

/**
 * Whether an outcome settles a host. Only an answer may be written to the retry index: stamping a
 * refusal there would keep a lettered tile for a week because the edge was busy for a moment.
 */
export function isAnswer(outcome) {
  return outcome?.kind === OUTCOME_VALUE || outcome?.kind === OUTCOME_NONE;
}

/**
 * The hosts a sweep may ask for, decided by who asked.
 *
 * Every request names a host, so a sweep is a list of the sites in a vault, handed to the server one
 * request at a time. It runs only for a person's own request — the Settings action that fetches the
 * missing icons. An import is not that request: one file names a whole library at once, and the
 * person has not looked at it yet. Neither is a page open. Both reach this with no grant and get no
 * host back.
 *
 * The default is empty on purpose. A caller that does not say who asked makes no request, rather
 * than a quiet one nobody can see; a caller that means it passes `explicit: true`.
 *
 * @param {Iterable<string>} hosts
 * @param {{explicit?: boolean}} [options] `explicit` is true only for a person's own request.
 * @returns {string[]} the hosts to ask, without repeats and without the empty ones.
 */
export function sweepHosts(hosts, { explicit = false } = {}) {
  if (explicit !== true) return [];

  const asked = [];
  const seen = new Set();
  for (const host of hosts) {
    if (typeof host !== 'string' || host === '' || seen.has(host)) continue;
    seen.add(host);
    asked.push(host);
  }
  return asked;
}

/**
 * How long the edge asked this page to wait, in milliseconds.
 *
 * `tooMany()` in src/index.js sends `retry-after` as whole seconds. Anything unreadable is no
 * instruction, not an instruction to wait forever.
 */
function retryAfterMsFrom(response) {
  const raw = response.headers.get('retry-after');
  if (typeof raw !== 'string' || raw.trim() === '') return 0;

  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);

  const when = Date.parse(raw);
  return Number.isFinite(when) ? Math.max(0, when - Date.now()) : 0;
}

/* A refusal is about this page's budget, not about the host, so the host is asked again — but not
   at once: a list that hits the ceiling once hits it again if every host retries at the same
   instant. Two seconds, doubling per consecutive refusal, never more than a minute. */
const RETRY_BASE_MS = 2_000;
const RETRY_CAP_MS = 60_000;

/** The pause before a refused host may be asked again. `attempt` counts refusals, from zero. */
export function retryDelayMs(attempt, retryAfterMs = 0) {
  const grown = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * 2 ** Math.min(Math.max(attempt, 0), 5));
  return Math.max(grown, Number.isFinite(retryAfterMs) ? retryAfterMs : 0);
}

/**
 * Folds a sweep's outcomes into the retry index.
 *
 * Only an answer is written. A refusal leaves the entry exactly as it was, so the host stays
 * eligible instead of being skipped for the seven days a real answer earns, and comes back in the
 * returned list with the pause it should be tried after.
 *
 * `tries` is the document's `iconTries` map — digest-keyed, sealed with the vault — `results` is
 * `[{ host, outcome, attempt }]` in the order they were asked, and `at` is when the answers
 * arrived. The caller owns the map and what happens to it; this only folds the answers in.
 */
export async function stampAnswers(tries, results, at) {
  const retry = [];

  for (const { host, outcome, attempt = 0 } of results) {
    if (isAnswer(outcome)) {
      tries[await hostKey(host)] = at;
    } else {
      retry.push({ host, attempt, delayMs: retryDelayMs(attempt, outcome.retryAfterMs) });
    }
  }

  return retry;
}

/* ---- the request itself ---------------------------------------------------------------------- */

function toBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The cache key the server recomputes before it fetches anything. */
export async function hostHash(hostname) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(hostname));
  return toBase64Url(new Uint8Array(digest));
}

function toDataUri(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error ?? new Error('could not read the icon'));
    reader.readAsDataURL(blob);
  });
}

/**
 * Decode, centre and downscale to a 32px PNG.
 *
 * A 5KB favicon becomes about 1KB, which is what lets a few hundred of them live inside a vault
 * that still has to fit through the sync cap. A format the browser cannot decode (some SVGs)
 * is kept as-is only when it is already small.
 */
async function shrink(blob) {
  if (typeof createImageBitmap !== 'function') {
    return blob.size <= RAW_FALLBACK_BYTES ? toDataUri(blob) : null;
  }

  try {
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    canvas.width = TILE_PX;
    canvas.height = TILE_PX;

    const context = canvas.getContext('2d');
    if (!context) throw new Error('no 2d context');

    const scale = Math.min(TILE_PX / bitmap.width, TILE_PX / bitmap.height);
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));

    context.drawImage(bitmap, (TILE_PX - width) / 2, (TILE_PX - height) / 2, width, height);
    bitmap.close?.();
    return canvas.toDataURL('image/png');
  } catch {
    if (blob.size > RAW_FALLBACK_BYTES) return null;
    return toDataUri(blob);
  }
}

/**
 * A host the icon proxy will refuse anyway: loopback, a private network name, or a bare address.
 *
 * Asking would put an error in the console on every load and spend a request to be told no, and the lettered tile
 * is the right answer for these anyway — there is nobody to ask.
 */
export function uniconable(hostname) {
  const host = hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    return true;
  }
  if (/^[\d.]+$/.test(host) || host.startsWith('[')) return true;
  return /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host);
}

async function iconOutcome(hostname, { fresh = false } = {}) {
  /* Nobody to ask: not a refusal, and not something to try again either. */
  if (typeof hostname !== 'string' || hostname === '') return noneOutcome();
  if (uniconable(hostname)) return noneOutcome();

  const hash = await hostHash(hostname);

  let response;
  try {
    response = await requests.run(() =>
      fetch(`${API}?h=${hash}`, {
        headers: { 'x-icon-host': hostname },
        credentials: 'same-origin',
        ...(fresh ? { cache: 'reload' } : {})
      })
    );
  } catch {
    /* The request never arrived, or the answer stopped halfway: nothing was learned about the host. */
    return refusedOutcome();
  }

  /* 404 and 413 are the Worker's own verdict — no icon there, or an icon too large to keep — and
     both are final. */
  if (response.status === 404 || response.status === 413) return noneOutcome(response.status);
  if (!response.ok) return refusedOutcome(response.status, retryAfterMsFrom(response));

  const blob = await response.blob().catch(() => null);
  /* A 200 whose body could not be read is a broken transfer, not a verdict on the icon. */
  if (!blob) return refusedOutcome(response.status);
  if (blob.size === 0 || blob.size > MAX_BYTES) return noneOutcome(response.status);

  const icon = await shrink(blob).catch(() => null);
  /* A 200 whose bytes this browser cannot decode is still the host's answer — the same bytes would
     come back tomorrow — so it settles the host with nothing kept. */
  return icon ? valueOutcome(icon, response.status) : noneOutcome(response.status);
}

/**
 * What the icon route answered. Never rejects: an icon is an enhancement, and every failure has an
 * outcome of its own.
 */
export async function fetchIconOutcome(hostname, options = {}) {
  try {
    return await iconOutcome(hostname, options);
  } catch {
    return refusedOutcome();
  }
}

/**
 * One icon as a data URI, or null.
 *
 * A thin wrapper for callers that only need the picture. Anything that writes the retry index has
 * to use `fetchIconOutcome` instead: a null here cannot say whether the host has no icon or the
 * edge refused this page, and stamping the second as if it were the first costs a week.
 *
 * @param {string} hostname
 * @param {{fresh?: boolean}} [options] `fresh` bypasses a cached "no icon" answer, which is
 *   what an explicit "fetch missing icons" run means.
 * @returns {Promise<string | null>}
 */
export async function fetchIcon(hostname, { fresh = false } = {}) {
  const outcome = await fetchIconOutcome(hostname, { fresh });
  return outcome.kind === OUTCOME_VALUE ? outcome.value : null;
}

async function titleOutcome(hostname) {
  if (typeof hostname !== 'string' || hostname === '') return noneOutcome();

  let response;
  try {
    const hash = await hostHash(hostname);
    response = await requests.run(() =>
      fetch(`${TITLE_API}?h=${hash}`, {
        headers: { 'x-page-host': hostname },
        credentials: 'same-origin'
      })
    );
  } catch {
    return refusedOutcome();
  }

  if (response.status === 404) return noneOutcome(response.status);
  if (!response.ok) return refusedOutcome(response.status, retryAfterMsFrom(response));

  const payload = await response.json().catch(() => null);
  /* A 200 that is not the JSON the route writes is a broken transfer, not "no title". */
  if (!payload || typeof payload !== 'object') return refusedOutcome(response.status);

  const title = typeof payload.title === 'string' ? payload.title.trim() : '';
  return title === '' ? noneOutcome(response.status) : valueOutcome(title, response.status);
}

/** What the title route answered, with the same outcome shape as the icon route. */
export async function fetchPageTitleOutcome(hostname) {
  try {
    return await titleOutcome(hostname);
  } catch {
    return refusedOutcome();
  }
}

/**
 * The page's own <title>, for the name field, or null.
 *
 * Same shape as the icon: the host rides in a header, the query carries only its hash, a miss is
 * simply no suggestion, and the request is paced by the same queue. A title is never written to
 * the retry index, so the thin shape is enough here.
 */
export async function fetchPageTitle(hostname) {
  const outcome = await fetchPageTitleOutcome(hostname);
  return outcome.kind === OUTCOME_VALUE ? outcome.value : null;
}
