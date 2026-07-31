const CACHE = 'red-lantern-orders-v12';
const ORDER_SHELL = ['/orders', '/orders.js?v=20', '/orders.css?v=7', '/orders-logo.css?v=7', '/orders-fixes.css?v=10', '/orders.webmanifest?v=7', '/images/red-lantern-logo-600.webp'];
// These keep every read-only Orders screen usable after a refresh without internet.
const OFFLINE_DATA = ['/api/orders', '/api/orders/live-summary', '/api/orders/menu', '/api/orders/availability', '/api/orders/operations'];
async function cacheResponse(request, response) { if (response?.ok) (await caches.open(CACHE)).put(request, response.clone()); return response; }
self.addEventListener('install', (event) => event.waitUntil((async () => { await Promise.all([...ORDER_SHELL, ...OFFLINE_DATA].map(async (url) => { try { await cacheResponse(url, await fetch(url, { credentials: 'same-origin' })); } catch {} })); await self.skipWaiting(); })()));
self.addEventListener('activate', (event) => event.waitUntil((async () => { await Promise.all((await caches.keys()).filter((key) => key.startsWith('red-lantern-orders-') && key !== CACHE).map((key) => caches.delete(key))); await self.clients.claim(); })()));
self.addEventListener('fetch', (event) => {
  const { request } = event; if (request.method !== 'GET') return;
  const url = new URL(request.url); if (url.origin !== self.location.origin) return;
  const isOrdersData = url.pathname === '/api/orders' || ['/api/orders/live-summary', '/api/orders/menu', '/api/orders/availability', '/api/orders/operations'].includes(url.pathname);
  const isOrdersShell = url.pathname === '/orders' || url.pathname === '/orders.html' || /\/orders(?:-fixes|-logo)?\.css$|\/orders\.js$|\/orders\.webmanifest$/.test(url.pathname);
  if (!isOrdersData && !isOrdersShell) return;
  event.respondWith((async () => {
    try {
      const network = await fetch(request);
      // Authentication failures are valid online responses. Do not replace the
      // browser's Basic Auth prompt with an offline fallback screen.
      if (network.ok || network.status === 401 || network.status === 403 || !isOrdersShell) {
        await cacheResponse(request, network);
        // Search/history URLs change on every view; retain a current-order fallback too.
        if (url.pathname === '/api/orders' && network.ok) (await caches.open(CACHE)).put('/api/orders', network.clone());
        return network;
      }
    } catch {}
    const cache = await caches.open(CACHE);
    const cached = await cache.match(request, { ignoreSearch: isOrdersShell }) || (url.pathname === '/api/orders' ? await cache.match('/api/orders') : undefined) || (isOrdersShell ? await cache.match('/orders') : undefined);
    if (cached) return cached;
    if (request.mode === 'navigate') return new Response('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Red Lantern Orders</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#eef3f9;color:#17264a;font:600 16px system-ui,sans-serif}.card{max-width:420px;margin:24px;padding:28px;border:1px solid #d8e2ee;border-radius:16px;background:#fff;box-shadow:0 12px 32px rgba(20,42,74,.12)}h1{margin:0 0 10px;font-size:24px}p{color:#60718a;line-height:1.5}button{margin-top:8px;padding:11px 15px;border:0;border-radius:8px;color:#fff;background:#7d1e35;font:800 14px inherit;cursor:pointer}</style><main class="card"><h1>Orders needs a connection</h1><p>The local Orders server or network is unavailable. Your installed app has not loaded an offline copy yet.</p><button onclick="location.reload()">Try again</button></main>', { status:503, headers:{ 'Content-Type':'text/html; charset=utf-8', 'Cache-Control':'no-store' } });
    return new Response(JSON.stringify({ error: 'Offline data is not available on this device yet.' }), { status:503, headers: { 'Content-Type': 'application/json' } });
  })());
});
self.addEventListener('push', (event) => { let data = { title: 'New Direct Order', body: 'Open Direct Orders to view it.', url: '/orders' }; try { data = { ...data, ...event.data.json() }; } catch {} event.waitUntil(self.registration.showNotification(data.title, { body: data.body, icon: '/images/red-lantern-logo-600.webp', badge: '/images/red-lantern-logo-600.webp', tag: data.tag || 'red-lantern-order', renotify: true, data: { url: data.url || '/orders' } })); });
self.addEventListener('notificationclick', (event) => { event.notification.close(); event.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => { const current = windows.find((client) => client.url.includes('/orders')); return current ? current.focus() : clients.openWindow(event.notification.data?.url || '/orders'); })); });
