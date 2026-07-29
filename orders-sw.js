const CACHE = 'red-lantern-orders-v7';
const ORDER_SHELL = ['/orders', '/orders.js?v=19', '/orders.css?v=7', '/orders-logo.css?v=7', '/orders-fixes.css?v=10', '/orders.webmanifest?v=7', '/images/red-lantern-logo-600.webp'];
async function cacheResponse(request, response) { if (response?.ok) (await caches.open(CACHE)).put(request, response.clone()); return response; }
self.addEventListener('install', (event) => event.waitUntil((async () => { await Promise.all(ORDER_SHELL.map(async (url) => { try { await cacheResponse(url, await fetch(url, { credentials: 'same-origin' })); } catch {} })); await self.skipWaiting(); })()));
self.addEventListener('activate', (event) => event.waitUntil((async () => { await Promise.all((await caches.keys()).filter((key) => key.startsWith('red-lantern-orders-') && key !== CACHE).map((key) => caches.delete(key))); await self.clients.claim(); })()));
self.addEventListener('fetch', (event) => {
  const { request } = event; if (request.method !== 'GET') return;
  const url = new URL(request.url); if (url.origin !== self.location.origin) return;
  const isMenuData = url.pathname === '/api/orders/menu' || url.pathname === '/api/orders/availability';
  const isOrdersShell = url.pathname === '/orders' || url.pathname === '/orders.html' || /\/orders(?:-fixes|-logo)?\.css$|\/orders\.js$|\/orders\.webmanifest$/.test(url.pathname);
  if (!isMenuData && !isOrdersShell) return;
  event.respondWith((async () => { try { return await cacheResponse(request, await fetch(request)); } catch { const cache = await caches.open(CACHE); return (await cache.match(request, { ignoreSearch: isOrdersShell })) || (isOrdersShell ? await cache.match('/orders') : undefined) || new Response(JSON.stringify({ error: 'Offline data is not available on this device yet.' }), { status: 503, headers: { 'Content-Type': 'application/json' } }); } })());
});
self.addEventListener('push', (event) => { let data = { title: 'New Direct Order', body: 'Open Direct Orders to view it.', url: '/orders' }; try { data = { ...data, ...event.data.json() }; } catch {} event.waitUntil(self.registration.showNotification(data.title, { body: data.body, icon: '/images/red-lantern-logo-600.webp', badge: '/images/red-lantern-logo-600.webp', tag: data.tag || 'red-lantern-order', renotify: true, data: { url: data.url || '/orders' } })); });
self.addEventListener('notificationclick', (event) => { event.notification.close(); event.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => { const current = windows.find((client) => client.url.includes('/orders')); return current ? current.focus() : clients.openWindow(event.notification.data?.url || '/orders'); })); });
