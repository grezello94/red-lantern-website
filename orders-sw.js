const CACHE = 'red-lantern-orders-v43';
let privateDataGeneration = 0;
const ORDER_SHELL = [
  '/orders',
  '/client-config.js',
  '/auth-cache.js?v=1',
  '/staff-domain.js?v=2',
  '/staff-access.js?v=2',
  '/src/orders/browser-bridge.js',
  '/printer-domain.js?v=2',
  '/addons-domain.js?v=1',
  '/order-request.js?v=3',
  '/orders.js?v=66',
  '/orders.css?v=7',
  '/orders-logo.css?v=7',
  '/orders-fixes.css?v=28',
  '/orders.webmanifest?v=7',
  '/images/red-lantern-logo-600.webp',
];
// These keep every read-only Orders screen usable after a refresh without internet.
const OFFLINE_DATA = [
  '/api/orders',
  '/api/orders/live-summary',
  '/api/orders/menu',
  '/api/orders/availability',
  '/api/orders/operations',
];
async function cacheResponse(request, response, generation) {
  try {
    if (response?.ok && !response.redirected) {
      const cache = await caches.open(CACHE);
      if (generation !== undefined && generation !== privateDataGeneration) return response;
      await cache.put(request, response.clone());
    }
  } catch (_) { /* Offline storage is best effort; preserve live server responses. */ }
  return response;
}
async function clearPrivateData() {
  privateDataGeneration += 1;
  try {
    const cache = await caches.open(CACHE);
    await Promise.all((await cache.keys()).filter(request => new URL(request.url).pathname.startsWith('/api/'))
      .map(request => cache.delete(request)));
  } catch (_) {}
}
self.addEventListener('message', event => {
  if (event.data?.type !== 'CLEAR_STAFF_DATA') return;
  event.waitUntil(clearPrivateData().then(() => event.ports?.[0]?.postMessage({ cleared: true })));
});
self.addEventListener('install', (event) =>
  event.waitUntil(
    (async () => {
      await Promise.all(
        [...ORDER_SHELL, ...OFFLINE_DATA].map(async (url) => {
          const generation = privateDataGeneration;
          try {
            await cacheResponse(url, await fetch(url, { credentials: 'same-origin' }),
              OFFLINE_DATA.includes(url) ? generation : undefined);
          } catch {}
        })
      );
      await self.skipWaiting();
    })()
  )
);
self.addEventListener('activate', (event) =>
  event.waitUntil(
    (async () => {
      await Promise.all(
        (await caches.keys())
          .filter((key) => key.startsWith('red-lantern-orders-') && key !== CACHE)
          .map((key) => caches.delete(key))
      );
      await self.clients.claim();
    })()
  )
);
self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // Captain's account-scoped offline journal owns these responses. They must
  // never share the billing console's cached data, including during migration.
  if (request.headers.has('X-Captain-Session')) return;
  const isOrdersData =
    url.pathname === '/api/orders' ||
    [
      '/api/orders/live-summary',
      '/api/orders/menu',
      '/api/orders/availability',
      '/api/orders/operations',
    ].includes(url.pathname);
  const isCurrentOrdersRequest = url.pathname === '/api/orders' &&
    !url.searchParams.get('search') && url.searchParams.get('history') !== '1' &&
    !url.searchParams.get('date');
  const isOrdersShell =
    ['/order', '/orders', '/orders.html'].includes(url.pathname.replace(/\/+$/, '')) ||
    ['/client-config.js', '/auth-cache.js', '/staff-domain.js', '/staff-access.js', '/src/orders/browser-bridge.js', '/printer-domain.js', '/order-request.js'].includes(url.pathname) ||
    /\/orders(?:-fixes|-logo)?\.css$|\/orders\.js$|\/orders\.webmanifest$|\/addons-domain\.js$/.test(
      url.pathname
    );
  if (!isOrdersData && !isOrdersShell) return;
  event.respondWith(
    (async () => {
      const generation = privateDataGeneration;
      let network;
      try {
        network = await fetch(request);
        // Authentication failures are valid online responses. Do not replace the
        // browser's Basic Auth prompt with an offline fallback screen.
        if (network.status === 401 || network.status === 403) {
          if (isOrdersData) await clearPrivateData();
          return network;
        }
        if (network.ok || (network.status < 500 && ![408, 425, 429].includes(network.status))) {
          await cacheResponse(request, network, isOrdersData ? generation : undefined);
          // Search/history URLs change on every view; retain a current-order fallback too.
          if (isCurrentOrdersRequest && network.ok && generation === privateDataGeneration)
            await cacheResponse('/api/orders', network, generation);
          return network;
        }
      } catch {}
      try {
        const cache = await caches.open(CACHE);
        const cached =
          (await cache.match(request, { ignoreSearch: isOrdersShell })) ||
          (isCurrentOrdersRequest ? await cache.match('/api/orders') : undefined) ||
          (isOrdersShell && request.mode === 'navigate' ? await cache.match('/orders') : undefined);
        if (cached) return cached;
      } catch (_) {}
      if (network) return network;
      if (request.mode === 'navigate')
        return new Response(
          '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Red Lantern Orders</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#eef3f9;color:#17264a;font:600 16px system-ui,sans-serif}.card{max-width:420px;margin:24px;padding:28px;border:1px solid #d8e2ee;border-radius:16px;background:#fff;box-shadow:0 12px 32px rgba(20,42,74,.12)}h1{margin:0 0 10px;font-size:24px}p{color:#60718a;line-height:1.5}button{margin-top:8px;padding:11px 15px;border:0;border-radius:8px;color:#fff;background:#7d1e35;font:800 14px inherit;cursor:pointer}</style><main class="card"><h1>Orders needs a connection</h1><p>The local Orders server or network is unavailable. Your installed app has not loaded an offline copy yet.</p><button onclick="location.reload()">Try again</button></main>',
          {
            status: 503,
            headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
          }
        );
      return new Response(
        JSON.stringify({ error: 'Offline data is not available on this device yet.' }),
        { status: 503, headers: { 'Content-Type': 'application/json' } }
      );
    })()
  );
});
self.addEventListener('push', (event) => {
  let data = { title: 'New Direct Order', body: 'Open Direct Orders to view it.', url: '/orders' };
  try {
    data = { ...data, ...event.data.json() };
  } catch {}
  event.waitUntil(
    Promise.all([
      self.registration.showNotification(data.title, {
        body: data.body,
        icon: '/images/red-lantern-logo-600.webp',
        badge: '/images/red-lantern-logo-600.webp',
        tag: data.tag || 'red-lantern-order',
        renotify: true,
        data: { url: data.url || '/orders' },
      }),
      clients
        .matchAll({ type: 'window', includeUncontrolled: true })
        .then((windows) =>
          windows.forEach((client) => client.postMessage({ type: 'order-update' }))
        ),
    ])
  );
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      const current = windows.find((client) => client.url.includes('/orders'));
      return current
        ? current.focus()
        : clients.openWindow(event.notification.data?.url || '/orders');
    })
  );
});
