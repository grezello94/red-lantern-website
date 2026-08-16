// Keep the Captain app installable, but never serve a stale login page or
// JavaScript bundle. Staff access always comes from the current server build.
const CACHE = 'red-lantern-captain-v6';
const STATIC_ASSETS = [
  '/captain.css',
  '/captain-ux.css',
  '/captain.webmanifest',
  '/images/red-lantern-logo-600.webp'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(STATIC_ASSETS))
      .catch(() => undefined)
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys
        .filter((key) => key.startsWith('red-lantern-captain-') && key !== CACHE)
        .map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  // HTML, scripts and all APIs must always be fetched fresh. Caching these was
  // the source of a login screen that had no corresponding Captain account.
  const isStaticAsset = /\/(captain(?:-ux)?\.css|captain\.webmanifest)$/.test(url.pathname)
    || url.pathname === '/images/red-lantern-logo-600.webp';
  if (!isStaticAsset) return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) caches.open(CACHE).then((cache) => cache.put(request, response.clone()));
        return response;
      })
      .catch(() => caches.match(request).then((cached) => cached || Response.error()))
  );
});
