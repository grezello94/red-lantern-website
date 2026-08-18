// Offline app shell only. Live operational data is handled by Captain's
// account-scoped snapshot in local storage, never cached as a shared API response.
const CACHE = 'red-lantern-captain-v21';
const STATIC_ASSETS = [
  '/captain',
  '/captain.css',
  '/captain-ux.css',
  '/captain-modern.css',
  '/captain.js',
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

  // API responses stay network-only. The shell is network-first so releases
  // arrive immediately, with a cache fallback only when the device is offline.
  const isStaticAsset = url.pathname === '/captain'
    || /\/(captain(?:-ux|-modern)?\.css|captain\.js|captain\.webmanifest)$/.test(url.pathname)
    || url.pathname === '/images/red-lantern-logo-600.webp';
  if (!isStaticAsset) return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) caches.open(CACHE).then((cache) => cache.put(request, response.clone()));
        return response;
      })
      .catch(() => caches.open(CACHE).then((cache) => cache.match(request, { ignoreSearch: true })).then((cached) => cached || Response.error()))
  );
});
