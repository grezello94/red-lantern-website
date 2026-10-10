/** @jest-environment node */
const { createDatabaseTransport } = require('./database-transport');

const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('a slow query body retains its slot; queued work proceeds only after full consumption', async () => {
  let stream;
  const fetch = jest.fn(async () => new Response(new ReadableStream({ start(controller) { stream = controller; } })));
  const transport = createDatabaseTransport({ fetch, maxActive: 1, maxPending: 1 });
  const first = transport.fetch('https://database.invalid/sql');
  await tick();
  const second = transport.fetch('https://database.invalid/sql');
  await tick();
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(transport.snapshot()).toMatchObject({ active: 1, pending: 1 });
  stream.enqueue(new TextEncoder().encode('{"ok":true}')); stream.close();
  expect(await (await first).json()).toEqual({ ok: true });
  await tick();
  expect(fetch).toHaveBeenCalledTimes(2);
  stream.close(); await second;
  expect(transport.snapshot().active).toBe(0);
});

test('saturation and expired queue entries reject without executing extra database writes', async () => {
  const hold = deferred();
  const fetch = jest.fn(async () => { await hold.promise; return new Response('[]'); });
  const transport = createDatabaseTransport({ fetch, maxActive: 1, maxPending: 1, queueTimeoutMs: 20 });
  const active = transport.fetch('https://database.invalid/sql', { method: 'POST' });
  const queued = transport.fetch('https://database.invalid/sql', { method: 'POST' });
  const rejected = expect(queued).rejects.toMatchObject({ code: 'DATABASE_BUSY' });
  await expect(transport.fetch('https://database.invalid/sql')).rejects.toMatchObject({ code: 'DATABASE_BUSY' });
  await rejected;
  expect(fetch).toHaveBeenCalledTimes(1);
  hold.resolve(); await active;
  await transport.fetch('https://database.invalid/sql');
  expect(transport.snapshot()).toMatchObject({ active: 0, pending: 0 });
});

test('the total deadline aborts a stalled body and frees capacity without retrying the write', async () => {
  const fetch = jest.fn(async (_, options) => new Response(new ReadableStream({
    start(controller) { options.signal.addEventListener('abort', () => controller.error(options.signal.reason), { once: true }); },
  })));
  const transport = createDatabaseTransport({ fetch, maxActive: 1, queryTimeoutMs: 20 });
  await expect(transport.fetch('https://database.invalid/sql', { method: 'POST' })).rejects.toThrow();
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(transport.snapshot().active).toBe(0);
});

test('oversized query responses are bounded and shutdown waits for accepted work', async () => {
  const transport = createDatabaseTransport({ fetch: async () => new Response('oversized'), maxResponseBytes: 3 });
  await expect(transport.fetch('https://database.invalid/sql')).rejects.toThrow('memory limit');
  const hold = deferred();
  const dispatcher = { close: jest.fn() };
  const draining = createDatabaseTransport({ fetch: async () => { await hold.promise; return new Response('[]'); }, dispatcher });
  const accepted = draining.fetch('https://database.invalid/sql');
  await tick();
  const close = draining.close();
  await expect(draining.fetch('https://database.invalid/sql')).rejects.toMatchObject({ code: 'DATABASE_BUSY' });
  expect(dispatcher.close).not.toHaveBeenCalled();
  hold.resolve(); await accepted; await close;
  expect(dispatcher.close).toHaveBeenCalledTimes(1);
});
