/**
 * The app's own offline cache, scoped to the root of its own origin.
 *
 * It is separate from the site's worker on purpose: this app ships from a different repository
 * and a different deploy, so its cache has to be bumped by its own changes rather than by a
 * site commit. A page inside this scope is controlled by this registration, not by the one at
 * the origin root.
 *
 * BUMP CACHE_NAME whenever any file below changes, or a returning visitor keeps the old copy.
 * The API is never cached: a stale vault read would be worse than no answer at all.
 */

const CACHE_NAME = 'bookmarks-v83';
const SHELL = [
  '/',
  '/index.html',
  '/bookmarks.css',
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

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put('/', copy));
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
