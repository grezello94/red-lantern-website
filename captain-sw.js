// Offline app shell only. Live operational data is handled by Captain's
// account-scoped snapshot in local storage, never cached as a shared API response.
const CACHE = 'red-lantern-captain-v39';
const STATIC_ASSETS = [
  '/captain',
  '/client-config.js',
  '/auth-cache.js?v=1',
  '/captain.css?v=2',
  '/captain-ux.css?v=53',
  '/captain-modern.css?v=2',
  '/captain-native.css?v=1',
  '/captain.js?v=66',
  '/captain-tools.js?v=2',
  '/captain-tools.css?v=1',
  '/staff-domain.js?v=2',
  '/order-request.js?v=3',
  '/addons-domain.js?v=1',
  '/captain.webmanifest',
  '/images/red-lantern-logo-600.webp',
  '/images/red-lantern-home-1400.webp',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(STATIC_ASSETS))
      .catch(() => undefined)
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
            .filter((key) => key.startsWith('red-lantern-captain-') && key !== CACHE)
            .map((key) => caches.delete(key))
        )
      )
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
  const isStaticAsset =
    ['/captain', '/captain.html'].includes(url.pathname.replace(/\/+$/, '')) ||
    ['/client-config.js', '/auth-cache.js'].includes(url.pathname) ||
    /\/(captain(?:-ux|-modern|-native|-tools)?\.css|captain(?:-tools)?\.js|captain\.webmanifest|addons-domain\.js|staff-domain\.js|order-request\.js)$/.test(url.pathname) ||
    ['/images/red-lantern-logo-600.webp', '/images/red-lantern-home-1400.webp'].includes(
      url.pathname
    );
  if (!isStaticAsset) return;

  event.respondWith(
    (async () => {
      let network;
      try {
        network = await fetch(request);
        if (network.ok) {
          try {
            if (!network.redirected) await (await caches.open(CACHE)).put(request, network.clone());
          } catch (_) { /* Storage failure must not discard a valid network response. */ }
          return network;
        }
        if (network.status < 500 && ![408, 425, 429].includes(network.status)) return network;
      } catch (_) {}
      try {
        const cache = await caches.open(CACHE);
        // Query versions identify the helper contract used by this HTML. An
        // older cached helper must never satisfy a different release's URL.
        const cached = await cache.match(request) ||
          (request.mode === 'navigate' ? await cache.match('/captain') : undefined);
        if (cached) return cached;
      } catch (_) {}
      return network || Response.error();
    })()
  );
});
