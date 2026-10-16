/** @jest-environment node */
const fs = require('fs');
const vm = require('vm');

function session() {
  const entries = new Map([
    ['https://restaurant.test/api/orders', Response.json([{ id: 'prior-account-order' }])],
    ['https://restaurant.test/orders', new Response('installed shell')],
  ]);
  const local = new Map([
    ['red-lantern-counter-orders', '[{"clientRequestId":"keep-me"}]'],
    ['red-lantern-table-order-snapshot', '[{"id":"old-table"}]'],
    ['red-lantern-printer-pairing-v1', '{"paired":true}'],
    ['red-lantern-staff-access-profile-v1', '{"employee":{"id":"old-account"}}'],
  ]);
  const key = request => typeof request === 'string' ? request : request.url;
  const cache = {
    keys: async () => [...entries.keys()].map(url => new Request(url)),
    delete: async request => entries.delete(key(request)),
  };
  const fetcher = jest.fn();
  const window = { fetch: fetcher, dispatchEvent: jest.fn() };
  vm.runInNewContext(fs.readFileSync(require.resolve('./auth-cache.js'), 'utf8'), {
    window, location: { href: 'https://restaurant.test/orders', origin: 'https://restaurant.test' }, navigator: {},
    caches: { keys: async () => ['red-lantern-orders-v42'], open: async () => cache },
    localStorage: { removeItem: name => local.delete(name) }, URL,
    CustomEvent: class CustomEvent { constructor(type) { this.type = type; } },
  });
  return { window, fetcher, entries, local };
}

test.each([
  ['/api/orders/session', 'POST', 200], ['/api/staff/session', 'DELETE', 200],
  ['/API/CAPTAIN/LOGIN/', 'POST', 200], ['/api/staff/session', 'GET', 401],
])('%s %s HTTP %s clears prior account reads and preserves durable work', async (path, method, status) => {
  const { window, fetcher, entries, local } = session();
  const response = Response.json({}, { status });
  fetcher.mockResolvedValue(response);
  expect(await window.fetch(path, { method })).toBe(response);
  expect(entries.has('https://restaurant.test/api/orders')).toBe(false);
  expect(entries.has('https://restaurant.test/orders')).toBe(true);
  expect(local.has('red-lantern-table-order-snapshot')).toBe(false);
  expect(local.has('red-lantern-staff-access-profile-v1')).toBe(false);
  expect(window.dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'red-lantern-auth-changed' }));
  expect(local.get('red-lantern-counter-orders')).toContain('keep-me');
  expect(local.has('red-lantern-printer-pairing-v1')).toBe(true);
});

test.each([
  ['/api/orders/session', 'POST', 401], ['/api/orders/counter', 'POST', 201],
  ['https://elsewhere.test/api/orders/session', 'POST', 200],
])('%s %s HTTP %s does not clear the active account cache', async (path, method, status) => {
  const { window, fetcher, entries } = session();
  fetcher.mockResolvedValue(Response.json({}, { status }));
  await window.fetch(path, { method });
  expect(entries.has('https://restaurant.test/api/orders')).toBe(true);
});
