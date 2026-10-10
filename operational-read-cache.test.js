/** @jest-environment node */
const { createOperationalReadCache } = require('./operational-read-cache');

test('simultaneous devices share a snapshot but cannot change each other’s results', async () => {
  const cache = createOperationalReadCache();
  const load = jest.fn(async () => [{ id: 'order-1', created_at: new Date(), items: [{ quantity: 1 }] }]);
  const rows = await Promise.all(Array.from({ length: 50 }, () => cache.read('orders', load)));
  expect(load).toHaveBeenCalledTimes(1);
  rows[0][0].items[0].quantity = 99;
  expect(rows[1][0].items[0].quantity).toBe(1);
  expect(Number.isFinite(rows[1][0].created_at.getTime())).toBe(true);
});

test('a write invalidates pending reads; stale completion never replaces fresh data', async () => {
  const cache = createOperationalReadCache();
  let finishOld;
  const old = cache.read('orders', () => new Promise((resolve) => { finishOld = resolve; }));
  await Promise.resolve();
  cache.clear();
  expect(await cache.read('orders', async () => ['new'])).toEqual(['new']);
  finishOld(['old']); await old;
  expect(await cache.read('orders', async () => ['incorrect'])).toEqual(['new']);
});

test('failed queries recover and distinct search/auth keys have a finite cache', async () => {
  const cache = createOperationalReadCache({ maxEntries: 2 });
  await expect(cache.read('admin', async () => { throw new Error('offline'); })).rejects.toThrow('offline');
  expect(await cache.read('admin', async () => ['full'])).toEqual(['full']);
  expect(await cache.read('captain', async () => ['limited'])).toEqual(['limited']);
  await cache.read('search', async () => ['searched']);
  expect(cache.size()).toBe(2);
});
