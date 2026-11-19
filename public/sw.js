/**
 * The app's own offline cache, scoped to the root of its own origin.
 *
 * It is separate from the site's worker on purpose: this app ships from a different repository
 * and a different deploy, so its cache has to be bumped by its own changes rather than by a
 * site commit. A page inside this scope is controlled by this registration, not by the one at
 * the origin root.
 *
 * BUMP CACHE_NAME whenever any file below changes, or a returning visitor keeps the old copy.
 * It is a digest of those files' bytes, checked by `npm run check`: a change to one of them fails
 * the check and prints the name this line has to carry, so the bump is not a thing a person has
 * to remember at deploy time.
 * The API is never cached: a stale vault read would be worse than no answer at all.
 */

const CACHE_NAME = 'bookmarks-b5b6c50e2a';
const SHELL = [
  '/',
  '/index.html',
  '/bookmarks.css',
  '/icon.svg',
  '/favicon-32.png',
  '/apple-touch-icon.png',
  '/icon-192.png',
  '/icon-512.png',
  '/manifest.webmanifest',
  '/theme.js',
  '/app.js',
  '/crypto.js',
  '/device-store.js',
  '/hygiene.js',
  '/lock-signal.js',
  '/views.js',
  '/vault.js',
  '/bookmarks.js',
  '/import-export.js',
  '/tiles.js',
  '/stamps.js',
  '/sync.js',
  '/icons.js',
  '/wordlist.js',
  '/collected.js',
  '/collector.js',
  '/css/tokens.css',
  '/css/themes.css'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith('bookmarks-') && key !== CACHE_NAME)
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

/* Only a successful same-origin document is this app. A 404, a refusal from the edge, or a
   redirect that ended on another origin is not a copy of this page, and storing one under `/`
   would replace the offline app with that answer until a new worker installs. */
function storesShell(response) {
  if (!response.ok) return false;
  if (response.type === 'opaque' || response.type === 'opaqueredirect') return false;

  const type = response.headers.get('content-type') ?? '';
  if (!type.toLowerCase().includes('text/html')) return false;

  try {
    return new URL(response.url).origin === self.location.origin;
  } catch {
    return false;
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(async (response) => {
          if (storesShell(response)) {
            const copy = response.clone();
            const cache = await caches.open(CACHE_NAME);
            await cache.put('/', copy);
          }
          return response;
        })
        .catch(() => caches.match('/'))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then(
      (cached) =>
        cached ??
        fetch(request).then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        })
    )
  );
});
