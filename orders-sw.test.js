/** @jest-environment node */
const fs = require('fs');
const vm = require('vm');

function worker() {
  const listeners = new Map(), saved = new Map();
  const key = request => new URL(typeof request === 'string' ? request : request.url, 'https://restaurant.test').href;
  const cache = {
    put: jest.fn(async (request, response) => { saved.set(key(request), response.clone()); }),
    match: jest.fn(async request => saved.get(key(request))?.clone()),
    keys: jest.fn(async () => [...saved.keys()].map(url => new Request(url))),
    delete: jest.fn(async request => saved.delete(key(request))),
  };
  const fetcher = jest.fn();
  vm.runInNewContext(fs.readFileSync(require.resolve('./orders-sw.js'), 'utf8'), {
    self: { location: { origin: 'https://restaurant.test' }, addEventListener: (name, listener) => listeners.set(name, listener) },
    caches: { open: async () => cache }, fetch: fetcher, URL, Response,
  });
  const get = async (path, options) => {
    let result;
    listeners.get('fetch')({ request: new Request(`https://restaurant.test${path}`, options), respondWith: promise => { result = promise; } });
    return result;
  };
  const clear = async () => {
    let pending;
    listeners.get('message')({ data: { type: 'CLEAR_STAFF_DATA' }, waitUntil: promise => { pending = promise; } });
    await pending;
  };
  return { fetcher, get, cache, clear };
}

for (const filtered of ['/api/orders?history=1&date=2026-10-14', '/api/orders?search=9999&history=0']) {
  test(`${filtered} cannot replace the offline current-order snapshot`, async () => {
    const { fetcher, get } = worker();
    fetcher.mockResolvedValueOnce(Response.json([{ id: 'current-table' }]));
    await get('/api/orders?history=0&search=&date=');
    fetcher.mockResolvedValueOnce(Response.json([{ id: 'filtered-order' }]));
    await get(filtered);
    fetcher.mockRejectedValue(new TypeError('Offline'));
    expect(await (await get('/api/orders')).json()).toEqual([{ id: 'current-table' }]);
    expect(await (await get(filtered)).json()).toEqual([{ id: 'filtered-order' }]);
  });
}

test('an uncached history search cannot show the current orders as historical results', async () => {
  const { fetcher, get } = worker();
  fetcher.mockResolvedValueOnce(Response.json([{ id: 'current-table' }]));
  await get('/api/orders');
  fetcher.mockRejectedValue(new TypeError('Offline'));
  const response = await get('/api/orders?history=1&date=2026-10-01');
  expect(response.status).toBe(503);
  expect(await response.json()).toHaveProperty('error');
});

test('temporary server failure falls back to the last successful Orders read', async () => {
  const { fetcher, get } = worker();
  fetcher.mockResolvedValueOnce(Response.json([{ id: 'cached-order' }]));
  await get('/api/orders');
  fetcher.mockResolvedValueOnce(Response.json({ error: 'Busy' }, { status: 503 }));
  expect(await (await get('/api/orders')).json()).toEqual([{ id: 'cached-order' }]);
});

test.each([401, 403])('HTTP %s invalidates private cached data instead of exposing it on the next offline read', async status => {
  const { fetcher, get } = worker();
  fetcher.mockResolvedValueOnce(Response.json([{ id: 'prior-employee-order' }]));
  await get('/api/orders');
  fetcher.mockResolvedValueOnce(Response.json({ error: 'Sign in again' }, { status }));
  expect((await get('/api/orders')).status).toBe(status);
  fetcher.mockRejectedValue(new TypeError('Offline'));
  expect((await get('/api/orders')).status).toBe(503);
});

test('Captain token requests never use the billing console cache', async () => {
  const { fetcher, get } = worker();
  fetcher.mockResolvedValueOnce(Response.json([{ id: 'billing-private' }]));
  await get('/api/orders');
  expect(await get('/api/orders', { headers: { 'X-Captain-Session': 'another-account' } })).toBeUndefined();
  expect(fetcher).toHaveBeenCalledTimes(1);
});

test('cache storage errors do not replace a valid server response', async () => {
  const { fetcher, get, cache } = worker();
  cache.put.mockRejectedValue(new Error('Quota exceeded'));
  fetcher.mockResolvedValue(Response.json([{ id: 'confirmed-live-order' }]));
  expect(await (await get('/api/orders')).json()).toEqual([{ id: 'confirmed-live-order' }]);
});

test('an old in-flight response cannot repopulate cached reads after an account change', async () => {
  const { fetcher, get, clear } = worker();
  let finish;
  fetcher.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  const pending = get('/api/orders');
  await clear();
  finish(Response.json([{ id: 'old-account' }]));
  await pending;
  fetcher.mockRejectedValue(new TypeError('Offline'));
  expect((await get('/api/orders')).status).toBe(503);
});
