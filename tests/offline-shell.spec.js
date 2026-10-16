const { test, expect } = require('@playwright/test');
const http = require('http');
const fs = require('fs');
const path = require('path');
const Staff = require('../staff-domain');

// Real service workers, requests, navigation and CacheStorage. This fixture
// serves only local assets and fixed API data; it never starts the real server.
let server, origin, legacyCaptainHelper = false;
const employee = { id: 'offline-captain', name: 'Offline Captain', role: 'captain', active: true,
  areas: ['AC'], tableScope: 'assigned_areas', idleMinutes: 120,
  permissions: Staff.permissions({ role: 'captain', permissions: { billingConsole: true } }) };
const fixtures = {
  '/api/staff/session': { employee, token: 'offline-fixture-token' },
  '/api/captain/accounts': { captains: [employee] },
  '/api/captain/ready-alerts': { alerts: [] },
  '/api/captain/menu-insights': { items: [] },
  '/api/orders': [],
  '/api/orders/menu': [{ key: 'soup', name: 'Soup', category: 'Soup', price: 100 }],
  '/api/orders/availability': [],
  '/api/orders/operations': { config: { tableAreas: [{ name: 'AC', from: 1, to: 3 }], printers: [], routes: [] } },
  '/api/orders/live-summary': { activeOrderCount: 0, acceptingOrders: true, sessionOpen: true },
};
test.beforeAll(async () => {
  server = http.createServer((request, response) => {
    const pathname = new URL(request.url, 'http://fixture.test').pathname;
    if (pathname.startsWith('/api/')) {
      response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify(fixtures[pathname] || {}));
      return;
    }
    const aliases = { '/orders': 'orders.html', '/captain': 'captain.html' };
    const relative = aliases[pathname] || pathname.slice(1);
    const root = path.resolve(__dirname, '..'), filename = path.resolve(root, relative);
    if (!filename.startsWith(root + path.sep) || !/\.(html|js|css|png|webp|webmanifest)$/.test(filename)) {
      response.writeHead(404).end(); return;
    }
    fs.readFile(filename, (error, body) => {
      if (error) { response.writeHead(404).end(); return; }
      const type = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
        '.png': 'image/png', '.webp': 'image/webp', '.webmanifest': 'application/manifest+json' }[path.extname(filename)];
      const captainHelper = pathname === '/captain-tools.js';
      if (captainHelper) body = Buffer.concat([
        Buffer.from(`window.__captainHelperRelease = ${JSON.stringify(legacyCaptainHelper ? 'legacy' : 'current')};\n`), body,
      ]);
      response.writeHead(200, { 'Content-Type': type,
        'Cache-Control': captainHelper ? 'public, max-age=3600, stale-while-revalidate=86400' : 'no-store' });
      response.end(body);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});

test('a Captain worker upgrade retains the current helper offline despite a fresh legacy HTTP-cache entry', async ({ context }) => {
  const page = await context.newPage();
  // Seed the unversioned URL used by the previously installed Captain worker.
  legacyCaptainHelper = true;
  try {
    await page.goto(origin + '/staff-login.html');
    expect(await page.evaluate(async () => (await fetch('/captain-tools.js')).text())).toContain('__captainHelperRelease = "legacy"');
  } finally { legacyCaptainHelper = false; }
  expect(await page.evaluate(async () => (await fetch('/captain-tools.js')).text())).toContain('__captainHelperRelease = "legacy"');
  await page.goto(origin + '/captain');
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller?.scriptURL || '')).toContain('/captain-sw.js');
  await expect.poll(() => page.evaluate(() => window.__captainHelperRelease)).toBe('current');
  const installedHelpers = await page.evaluate(async () => {
    const key = (await caches.keys()).find(key => key.startsWith('red-lantern-captain-'));
    return (await (await caches.open(key)).keys()).filter(request => new URL(request.url).pathname === '/captain-tools.js')
      .map(request => new URL(request.url).search);
  });
  expect(installedHelpers).toEqual(['?v=2']);
  // HTTP cache expiry/eviction must leave the installed app's own current copy
  // usable. Clear only Chromium's HTTP cache, retaining Service Worker storage.
  await (await context.newCDPSession(page)).send('Network.clearBrowserCache');
  await context.setOffline(true);
  await page.reload();
  await expect.poll(() => page.evaluate(() => window.__captainHelperRelease)).toBe('current');
  await expect(page).toHaveTitle(/Captain/);
});
test.afterAll(async () => {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
});

test('Orders and Captain keep independent workers and both reopen offline through their URL aliases', async ({ context }) => {
  await context.route('http://127.0.0.1:9124/**', route => route.fulfill({ status: 503, body: '{}' }));
  const orders = await context.newPage();
  await orders.goto(origin + '/orders');
  await expect.poll(() => orders.evaluate(() => navigator.serviceWorker.controller?.scriptURL || '')).toContain('/orders-sw.js');
  const captain = await context.newPage();
  await captain.goto(origin + '/captain');
  await expect.poll(() => captain.evaluate(() => navigator.serviceWorker.controller?.scriptURL || '')).toContain('/captain-sw.js');
  const registrations = await captain.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).map(registration => registration.scope));
  expect(registrations).toEqual(expect.arrayContaining([origin + '/order', origin + '/captain']));
  expect(await orders.evaluate(() => navigator.serviceWorker.controller.scriptURL)).toContain('/orders-sw.js');
  await context.setOffline(true);
  await orders.goto(origin + '/order');
  await expect(orders.locator('#table-view-panel')).toBeVisible();
  await captain.goto(origin + '/captain.html');
  await expect(captain).toHaveTitle(/Captain/);
  await expect(captain.locator('#captain-login, .captain-app').filter({ visible: true }).first()).toBeVisible();
  expect(await captain.evaluate(() => typeof window.RED_LANTERN_CONFIG)).toBe('object');
});

test('signing into another account removes cached Orders reads while preserving queued work and the installed shell', async ({ context }) => {
  const page = await context.newPage();
  const queued = { clientRequestId: 'keep-queued', actorEmployeeId: 'previous-employee',
    items: [{ name: 'Soup', category: 'Soup', quantity: 1, price: 100 }] };
  await page.goto(origin + '/orders');
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller?.scriptURL || '')).toContain('/orders-sw.js');
  await page.evaluate(async queued => {
    const cache = await caches.open('red-lantern-orders-auth-fixture');
    await cache.put('/api/orders?history=1', Response.json([{ customer_name: 'Prior account guest' }]));
    await cache.put('/orders', new Response('installed shell'));
    localStorage.setItem('red-lantern-counter-orders', JSON.stringify([queued]));
    localStorage.setItem('red-lantern-table-order-snapshot', JSON.stringify([{ id: 'old-table' }]));
    await fetch('/api/orders/session', { method: 'POST', body: '{}' });
  }, queued);
  const saved = await page.evaluate(async () => {
    const cache = await caches.open('red-lantern-orders-auth-fixture');
    return { privateResponse: !!await cache.match('/api/orders?history=1'), shell: await (await cache.match('/orders')).text(),
      queue: JSON.parse(localStorage.getItem('red-lantern-counter-orders')), oldTable: localStorage.getItem('red-lantern-table-order-snapshot') };
  });
  expect(saved).toEqual({ privateResponse: false, shell: 'installed shell', queue: [queued], oldTable: null });
});
