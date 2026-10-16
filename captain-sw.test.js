/** @jest-environment node */
const fs = require('fs');
const vm = require('vm');

function worker() {
  const listeners = new Map(), saved = new Map();
  const key = request => new URL(typeof request === 'string' ? request : request.url, 'https://restaurant.test').href;
  const cache = {
    addAll: jest.fn(async () => {}),
    put: jest.fn(async (request, response) => { saved.set(key(request), response.clone()); }),
    match: jest.fn(async (request, options) => {
      if (!options?.ignoreSearch) return saved.get(key(request))?.clone();
      const path = new URL(key(request)).pathname;
      return [...saved.entries()].find(([url]) => new URL(url).pathname === path)?.[1].clone();
    }),
  };
  const fetcher = jest.fn();
  vm.runInNewContext(fs.readFileSync(require.resolve('./captain-sw.js'), 'utf8'), {
    self: { location: { origin: 'https://restaurant.test' }, addEventListener: (name, listener) => listeners.set(name, listener), skipWaiting: jest.fn() },
    caches: { open: async () => cache }, fetch: fetcher, URL, Response,
  });
  const get = (path, mode = 'same-origin') => {
    let result;
    listeners.get('fetch')({ request: { url: `https://restaurant.test${path}`, method: 'GET', mode }, respondWith: promise => { result = promise; } });
    return result;
  };
  const install = () => {
    let result;
    listeners.get('install')({ waitUntil: promise => { result = promise; } });
    return result;
  };
  return { get, cache, fetcher, install };
}

test.each(['/captain.html', '/captain/'])('%s reopens the installed Captain shell offline', async alias => {
  const { get, cache, fetcher } = worker();
  await cache.put('/captain', new Response('<title>Captain shell</title>'));
  fetcher.mockRejectedValue(new TypeError('Offline'));
  expect(await (await get(alias, 'navigate')).text()).toContain('Captain shell');
});

test('Captain retains its runtime configuration for offline startup', async () => {
  const { get, fetcher } = worker();
  fetcher.mockResolvedValueOnce(new Response('window.RED_LANTERN_CONFIG = {};'));
  await get('/client-config.js');
  fetcher.mockRejectedValue(new TypeError('Offline'));
  expect(await (await get('/client-config.js')).text()).toContain('RED_LANTERN_CONFIG');
});

test('a cache write failure does not fail a live Captain asset request', async () => {
  const { get, cache, fetcher } = worker();
  cache.put.mockRejectedValue(new Error('Storage full'));
  fetcher.mockResolvedValue(new Response('const captainReady = true;'));
  expect(await (await get('/captain.js')).text()).toContain('captainReady');
});

test('the installed shell precaches every script and stylesheet at the version referenced by its HTML', async () => {
  const { cache, install } = worker();
  const html = fs.readFileSync(require.resolve('./captain.html'), 'utf8');
  const assets = [...html.matchAll(/(?:src|href)="(\/[^"\s]+\.(?:js|css)(?:\?[^"\s]+)?)"/g)].map(match => match[1]);
  await install();
  expect(assets.length).toBeGreaterThan(10);
  expect(cache.addAll).toHaveBeenCalledWith(expect.arrayContaining(assets));
});

test('offline requests select the exact current helper even when an old unversioned copy was cached first', async () => {
  const { get, cache, fetcher } = worker();
  await cache.put('/captain-tools.js', new Response('old helper'));
  await cache.put('/captain-tools.js?v=1', new Response('previous helper'));
  await cache.put('/captain-tools.js?v=2', new Response('current helper'));
  fetcher.mockRejectedValue(new TypeError('Offline'));
  expect(await (await get('/captain-tools.js?v=2')).text()).toBe('current helper');
});

test('an unavailable helper revision fails instead of silently using another release', async () => {
  const { get, cache, fetcher } = worker();
  await cache.put('/order-request.js', new Response('legacy helper'));
  await cache.put('/order-request.js?v=2', new Response('previous helper'));
  fetcher.mockRejectedValue(new TypeError('Offline'));
  expect((await get('/order-request.js?v=3')).type).toBe('error');
});
