/** @jest-environment node */
'use strict';

const http = require('http');
const express = require('express');
const { EventEmitter } = require('events');
const {
  classifyRequest,
  createLoadControl,
  installHandlerTracking,
  trackedHandler,
} = require('./server-load-control');

function deferred() {
  let resolve;
  const promise = new Promise((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe('Server admission under concurrent HTTP work', () => {
  let app, server, control, origin, gates, calls, clients;

  function gate(key) {
    if (!gates.has(key))
      gates.set(key, { work: deferred(), started: deferred(), closed: deferred() });
    return gates.get(key);
  }

  function request(path, method = 'GET') {
    let client;
    const promise = new Promise((resolve, reject) => {
      client = http.request(origin + path, { method }, (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          body += chunk;
        });
        response.on('end', () =>
          resolve({
            status: response.statusCode,
            headers: response.headers,
            data: body ? JSON.parse(body) : null,
          })
        );
        response.on('error', reject);
      });
      client.on('error', reject);
      client.end();
    });
    // An aborted client is intentionally exercised below, without leaving an
    // unhandled rejection while waiting for the server's close signal.
    promise.catch(() => {});
    clients.add(client);
    client.once('close', () => clients.delete(client));
    return { client, promise };
  }

  async function held(key, method = 'GET', path = '/api/work') {
    const result = request(`${path}?key=${key}`, method);
    await gate(key).started.promise;
    return result;
  }

  function stream(key) {
    let client;
    const promise = new Promise((resolve, reject) => {
      client = http.request(`${origin}/api/orders/smart-kds/stream?key=${key}`, (response) => {
        response.on('error', () => {});
        response.resume();
        resolve({ client, response, status: response.statusCode });
      });
      client.on('error', reject);
      client.end();
    });
    promise.catch(() => {});
    clients.add(client);
    client.once('close', () => clients.delete(client));
    return promise;
  }

  beforeEach(async () => {
    gates = new Map();
    calls = [];
    clients = new Set();
    control = createLoadControl({
      maxTotal: 4,
      maxReads: 2,
      maxMutations: 3,
      maxHeavy: 1,
      maxStreams: 1,
      env: {},
    });
    app = express();
    installHandlerTracking(app);
    app.use(control.middleware);
    app.use(express.json());
    app.get('/api/healthz', (req, res) => res.json({ ok: true }));
    app.get('/api/readyz', (req, res) => res.json({ ok: !control.snapshot().draining }));
    app.get('/public', (req, res) => res.json({ public: true }));
    async function work(req, res) {
      const key = req.query.key;
      const current = gate(key);
      calls.push(key);
      res.once('close', current.closed.resolve);
      current.started.resolve();
      await current.work.promise;
      if (!res.destroyed) res.json({ completed: key });
    }
    app.get('/api/work', work);
    app.post('/api/work', work);
    app.post('/api/admin/air-menu/extract', work);
    app.get('/api/early-response', async (req, res) => {
      const current = gate(req.query.key);
      current.started.resolve();
      res.json({ saved: true });
      await current.work.promise;
    });
    app.get('/api/orders/smart-kds/stream', async (req, res) => {
      const release = control.admitStream(req, res);
      if (!release) return;
      const current = gate(req.query.key);
      res.once('close', current.closed.resolve);
      res.set('Content-Type', 'text/event-stream');
      res.flushHeaders();
      res.write('event: connected\ndata: {}\n\n');
    });
    app.get('/api/failure', async () => {
      throw new Error('fixture failure');
    });
    app.use((error, req, res, next) =>
      res.status(error.status || 500).json({ error: error.message })
    );
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
  });

  afterEach(async () => {
    for (const current of gates.values()) current.work.resolve();
    for (const client of clients) client.destroy();
    await control.awaitIdle(1000);
    await new Promise((resolve) => server.close(resolve));
  });

  test('read saturation preserves write capacity and health access', async () => {
    const first = await held('read-1');
    const second = await held('read-2');
    const rejected = await request('/api/work?key=excess-read').promise;
    expect(rejected.status).toBe(503);
    expect(rejected.headers['retry-after']).toBe('2');
    expect(rejected.data.code).toBe('server_busy');
    expect(calls).not.toContain('excess-read');
    const write = await held('write-1', 'POST');
    expect(control.snapshot().active).toMatchObject({ total: 3, read: 2, mutation: 1 });
    expect((await request('/api/healthz').promise).status).toBe(200);
    expect((await request('/public').promise).status).toBe(200);
    gate('read-1').work.resolve();
    gate('read-2').work.resolve();
    gate('write-1').work.resolve();
    await Promise.all([first.promise, second.promise, write.promise]);
    expect(await control.awaitIdle(1000)).toBe(true);
  });

  test('a common ceiling bounds mixed lanes and recovers after real work completes', async () => {
    const operations = [
      await held('r1'),
      await held('r2'),
      await held('w1', 'POST'),
      await held('w2', 'POST'),
    ];
    expect((await request('/api/work?key=w3', 'POST').promise).status).toBe(503);
    expect(control.snapshot().peak.total).toBe(4);
    gate('r1').work.resolve();
    await operations[0].promise;
    const recovered = await held('w3-retry', 'POST');
    expect(calls).toContain('w3-retry');
    for (const key of ['r2', 'w1', 'w2', 'w3-retry']) gate(key).work.resolve();
    await Promise.all([...operations.slice(1).map((entry) => entry.promise), recovered.promise]);
    expect(await control.awaitIdle(1000)).toBe(true);
  });

  test('heavy imports have their own allowance while ordinary orders continue', async () => {
    const heavy = await held('import', 'POST', '/api/admin/air-menu/extract');
    const rejected = await request('/api/admin/air-menu/extract?key=second-import', 'POST').promise;
    expect(rejected.status).toBe(503);
    expect(calls).not.toContain('second-import');
    const order = await held('order', 'POST');
    expect(control.snapshot().active).toMatchObject({ total: 2, heavy: 1, mutation: 1 });
    gate('import').work.resolve();
    gate('order').work.resolve();
    await Promise.all([heavy.promise, order.promise]);
  });

  test('mutation saturation is bounded without preventing read access', async () => {
    const writes = [
      await held('write-a', 'POST'),
      await held('write-b', 'POST'),
      await held('write-c', 'POST'),
    ];
    expect((await request('/api/work?key=write-d', 'POST').promise).status).toBe(503);
    expect(calls).not.toContain('write-d');
    const read = await held('read-during-write-pressure');
    expect(control.snapshot().active).toMatchObject({ total: 4, read: 1, mutation: 3 });
    for (const key of ['write-a', 'write-b', 'write-c', 'read-during-write-pressure'])
      gate(key).work.resolve();
    await Promise.all([...writes.map((entry) => entry.promise), read.promise]);
  });

  test('disconnecting a browser cannot free a slot while its async write is still running', async () => {
    const operation = await held('aborted-write', 'POST');
    operation.client.destroy();
    await gate('aborted-write').closed.promise;
    expect(control.snapshot().active.mutation).toBe(1);
    expect(await control.awaitIdle(10)).toBe(false);
    gate('aborted-write').work.resolve();
    expect(await control.awaitIdle(1000)).toBe(true);
    expect(control.snapshot().active.total).toBe(0);
    expect(control.snapshot().completed).toBe(1);
  });

  test('a response sent before an awaited follow-up finishes retains its slot', async () => {
    const response = await request('/api/early-response?key=follow-up').promise;
    expect(response.status).toBe(200);
    expect(control.snapshot().active.total).toBe(1);
    gate('follow-up').work.resolve();
    expect(await control.awaitIdle(1000)).toBe(true);
  });

  test('hundreds of rejected requests do not start handlers or exceed the bound', async () => {
    const first = await held('busy-1');
    const second = await held('busy-2');
    const responses = await Promise.all(
      Array.from({ length: 120 }, (_, index) => request(`/api/work?key=overflow-${index}`).promise)
    );
    expect(responses.every((response) => response.status === 503)).toBe(true);
    expect(calls).toEqual(['busy-1', 'busy-2']);
    expect(control.snapshot().peak.read).toBe(2);
    expect(control.snapshot().rejected.read).toBe(120);
    expect((await request('/api/healthz').promise).status).toBe(200);
    gate('busy-1').work.resolve();
    gate('busy-2').work.resolve();
    await Promise.all([first.promise, second.promise]);
  });

  test('long-lived event streams use a separate finite allowance and clean up on close', async () => {
    const first = await stream('stream-1');
    expect(first.status).toBe(200);
    expect(control.snapshot().active).toMatchObject({ total: 0, stream: 1 });
    const declined = await stream('stream-2');
    expect(declined.status).toBe(503);
    const work = await held('ordinary-order', 'POST');
    expect(control.snapshot().active.mutation).toBe(1);
    first.client.destroy();
    await gate('stream-1').closed.promise;
    expect(control.snapshot().active.stream).toBe(0);
    const replacement = await stream('stream-3');
    expect(replacement.status).toBe(200);
    replacement.client.destroy();
    await gate('stream-3').closed.promise;
    gate('ordinary-order').work.resolve();
    await work.promise;
    expect(await control.awaitIdle(1000)).toBe(true);
  });

  test('draining rejects new work but permits health and existing operations to finish', async () => {
    const activeOrder = await held('saving', 'POST');
    const activeStream = await stream('old-stream');
    control.beginDrain();
    const declined = await request('/api/work?key=new-order', 'POST').promise;
    expect(declined.status).toBe(503);
    expect(declined.data.code).toBe('server_restarting');
    expect((await request('/api/healthz').promise).status).toBe(200);
    expect((await request('/api/readyz').promise).data.ok).toBe(false);
    expect((await stream('new-stream')).status).toBe(503);
    expect(await control.awaitIdle(10)).toBe(false);
    gate('saving').work.resolve();
    await activeOrder.promise;
    expect(await control.awaitIdle(10)).toBe(false);
    activeStream.client.destroy();
    await gate('old-stream').closed.promise;
    expect(await control.awaitIdle(1000)).toBe(true);
    expect(control.snapshot().rejected.draining).toBe(2);
  });

  test('parser failures and rejected async handlers also release admission', async () => {
    const failed = await request('/api/failure').promise;
    expect(failed.status).toBe(500);
    expect(await control.awaitIdle(1000)).toBe(true);
    const malformed = await new Promise((resolve, reject) => {
      const client = http.request(
        origin + '/api/work',
        { method: 'POST', headers: { 'Content-Type': 'application/json' } },
        (response) => {
          response.resume();
          response.on('end', () => resolve(response.statusCode));
        }
      );
      client.on('error', reject);
      client.end('{');
    });
    expect(malformed).toBe(400);
    expect(await control.awaitIdle(1000)).toBe(true);
    expect(control.snapshot().active.total).toBe(0);
  });

  test('route tracking preserves Express settings and nested callbacks', async () => {
    app.set('fixture-setting', 'value');
    expect(app.get('fixture-setting')).toBe('value');
    installHandlerTracking(app);
    app.get('/api/nested', [
      [(req, res, next) => next(), async (req, res) => res.json({ nested: true })],
    ]);
    expect((await request('/api/nested').promise).data).toEqual({ nested: true });
    expect(await control.awaitIdle(1000)).toBe(true);
  });
});

test.each([
  ['GET', '/api/work', 'read'],
  ['POST', '/api/direct-orders', 'mutation'],
  ['PATCH', '/api/orders/one/discount', 'mutation'],
  ['POST', '/api/update-home', 'heavy'],
  ['POST', '/api/admin/trusted-contacts/import', 'heavy'],
  ['POST', '/api/admin/air-menu/extract-bar', 'heavy'],
  ['POST', '/api/growth-ai', 'heavy'],
  ['GET', '/api/admin/analytics/stream', 'stream'],
  ['GET', '/API/ORDERS/SMART-KDS/STREAM/', 'stream'],
  ['GET', '/api/healthz', null],
  ['GET', '/api/readyz', null],
  ['GET', '/orders', null],
])('classifies %s %s into %s without inspecting credentials', (method, path, lane) => {
  expect(classifyRequest({ method, path })).toBe(lane);
});

test('bad configuration falls back safely and snapshots cannot mutate the limiter', () => {
  const control = createLoadControl({
    maxTotal: 3,
    maxReads: 80000,
    env: { SERVER_MAX_HEAVY_REQUESTS: '-5' },
  });
  const snapshot = control.snapshot();
  expect(snapshot.limits).toMatchObject({ total: 3, read: 3, mutation: 3, heavy: 2, stream: 128 });
  snapshot.active.total = 400;
  snapshot.limits.total = 0;
  expect(control.snapshot().active.total).toBe(0);
  expect(control.snapshot().limits.total).toBe(3);
});

test('explicit handler tracking handles auth middleware before a route starts', async () => {
  const control = createLoadControl({ env: {} });
  const response = new EventEmitter();
  const request = { path: '/api/work', method: 'GET' };
  control.middleware(request, response, () => {});
  const completion = deferred();
  const handler = trackedHandler(async () => completion.promise);
  const running = handler(request, response, () => {});
  response.emit('close');
  expect(control.snapshot().active.total).toBe(1);
  completion.resolve();
  await running;
  expect(control.snapshot().active.total).toBe(0);
});
