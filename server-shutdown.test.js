/** @jest-environment node */
'use strict';

const express = require('express');
const http = require('http');
const { createLoadControl, installHandlerTracking } = require('./server-load-control');
const { installGracefulShutdown } = require('./server-shutdown');

function deferred() {
  let resolve;
  const promise = new Promise((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe('Graceful deployment shutdown', () => {
  let app,
    server,
    origin,
    control,
    work,
    started,
    streamClosed,
    backgroundTasks,
    transport,
    log,
    clients;

  function request(path) {
    let client;
    const promise = new Promise((resolve, reject) => {
      client = http.get(origin + path, (response) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          text += chunk;
        });
        response.on('end', () =>
          resolve({ status: response.statusCode, data: text ? JSON.parse(text) : null })
        );
        response.on('error', reject);
      });
      client.on('error', reject);
    });
    promise.catch(() => {});
    clients.add(client);
    client.once('close', () => clients.delete(client));
    return { client, promise };
  }

  function configure(extra = {}) {
    return installGracefulShutdown(server, {
      loadControl: control,
      backgroundTasks,
      databaseTransport: transport,
      log,
      timeoutMs: 1000,
      ...extra,
    });
  }

  beforeEach(async () => {
    clients = new Set();
    work = deferred();
    started = deferred();
    streamClosed = deferred();
    backgroundTasks = new Set();
    transport = { close: jest.fn(async () => {}), destroy: jest.fn(async () => {}) };
    log = jest.fn();
    control = createLoadControl({ maxTotal: 1, maxReads: 1, maxMutations: 1, env: {} });
    app = express();
    installHandlerTracking(app);
    app.use(control.middleware);
    app.get('/api/readyz', (req, res) => res.json({ ready: !control.snapshot().draining }));
    app.get('/api/healthz', (req, res) => res.json({ ok: true }));
    app.get('/api/work', async (req, res) => {
      started.resolve();
      await work.promise;
      if (!res.destroyed) res.json({ saved: true });
    });
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
  });

  afterEach(async () => {
    work.resolve();
    for (const client of clients) client.destroy();
    await control.awaitIdle(1000);
    await new Promise((resolve) => server.close(resolve));
  });

  test('an in-flight HTTP operation survives shutdown and transport closes last', async () => {
    const active = request('/api/work');
    await started.promise;
    // A readiness/liveness check remains accessible while ordinary API work
    // has exhausted the request capacity and the HTTP listener is still open.
    expect((await request('/api/readyz').promise).data.ready).toBe(true);
    expect((await request('/api/healthz').promise).status).toBe(200);
    const coordinator = configure();
    const shutdown = coordinator.shutdown();
    expect(control.snapshot().draining).toBe(true);
    expect(transport.close).not.toHaveBeenCalled();
    expect(coordinator.shutdown()).toBe(shutdown);
    const newRequest = await request('/api/work').promise.catch((error) => ({ code: error.code }));
    expect(
      newRequest.status === 503 || ['ECONNREFUSED', 'ECONNRESET'].includes(newRequest.code)
    ).toBe(true);
    work.resolve();
    expect(await active.promise).toEqual({ status: 200, data: { saved: true } });
    expect(await shutdown).toEqual({ graceful: true });
    expect(transport.close).toHaveBeenCalledTimes(1);
    expect(transport.destroy).not.toHaveBeenCalled();
  });

  test('background tasks created by finishing handlers drain before database closure', async () => {
    const audit = deferred();
    app.get('/api/save-with-audit', async (req, res) => {
      started.resolve();
      await work.promise;
      res.json({ saved: true });
      backgroundTasks.add(audit.promise);
    });
    const active = request('/api/save-with-audit');
    await started.promise;
    const shutdown = configure().shutdown();
    work.resolve();
    expect((await active.promise).status).toBe(200);
    await new Promise((resolve) => setImmediate(resolve));
    expect(transport.close).not.toHaveBeenCalled();
    audit.resolve();
    expect(await shutdown).toEqual({ graceful: true });
    expect(backgroundTasks.size).toBe(0);
    expect(transport.close).toHaveBeenCalledTimes(1);
  });

  test('rechecks background tasks added by other background work', async () => {
    const first = deferred();
    const second = deferred();
    const firstTask = first.promise.then(() => backgroundTasks.add(second.promise));
    backgroundTasks.add(firstTask);
    const shutdown = configure().shutdown();
    first.resolve();
    await firstTask;
    await new Promise((resolve) => setImmediate(resolve));
    expect(transport.close).not.toHaveBeenCalled();
    second.resolve();
    expect(await shutdown).toEqual({ graceful: true });
    expect(transport.close).toHaveBeenCalledTimes(1);
    expect(backgroundTasks.size).toBe(0);
  });

  test('closes event streams so they do not hold a deployment open indefinitely', async () => {
    let streamResponse;
    app.get('/api/orders/smart-kds/stream', async (req, res) => {
      if (!control.admitStream(req, res)) return;
      streamResponse = res;
      res.once('close', streamClosed.resolve);
      res.set('Content-Type', 'text/event-stream');
      res.flushHeaders();
      res.write('data: {}\n\n');
    });
    const client = http.get(origin + '/api/orders/smart-kds/stream');
    clients.add(client);
    const response = await new Promise((resolve, reject) => {
      client.on('response', resolve);
      client.on('error', reject);
    });
    response.resume();
    response.on('error', () => {});
    expect(control.snapshot().active.stream).toBe(1);
    const closeStreams = jest.fn(() => streamResponse.end());
    const shutdown = configure({ closeStreams }).shutdown();
    await streamClosed.promise;
    expect(await shutdown).toEqual({ graceful: true });
    expect(closeStreams).toHaveBeenCalledTimes(1);
    expect(control.snapshot().active.stream).toBe(0);
  });

  test('disconnecting an HTTP client still waits for its actual tracked operation', async () => {
    const active = request('/api/work');
    await started.promise;
    const shutdown = configure().shutdown();
    active.client.destroy();
    await new Promise((resolve) => active.client.once('close', resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(transport.close).not.toHaveBeenCalled();
    expect(control.snapshot().active.total).toBe(1);
    work.resolve();
    expect(await shutdown).toEqual({ graceful: true });
    expect(transport.close).toHaveBeenCalledTimes(1);
  });

  test('an overall deadline force-closes a stuck request and does not wait forever', async () => {
    const active = request('/api/work');
    await started.promise;
    const shutdown = configure({ timeoutMs: 35 }).shutdown();
    expect(await shutdown).toEqual({ graceful: false });
    expect(transport.close).not.toHaveBeenCalled();
    expect(transport.destroy).toHaveBeenCalledTimes(1);
    await expect(active.promise).rejects.toBeDefined();
    work.resolve();
    expect(await control.awaitIdle(1000)).toBe(true);
    expect(transport.close).not.toHaveBeenCalled();
  });

  test('transport close is also bounded by the overall deadline', async () => {
    const closing = deferred();
    transport.close.mockImplementation(() => closing.promise);
    expect(await configure({ timeoutMs: 35 }).shutdown()).toEqual({ graceful: false });
    expect(transport.close).toHaveBeenCalledTimes(1);
    expect(transport.destroy).toHaveBeenCalledTimes(1);
    closing.resolve();
  });

  test('rejected background tasks are consumed and removed rather than crashing shutdown', async () => {
    const failedTask = Promise.reject(new Error('fixture audit failure'));
    // Its producer may have its own rejection handler, as the server does.
    failedTask.catch(() => {});
    backgroundTasks.add(failedTask);
    expect(await configure().shutdown()).toEqual({ graceful: true });
    expect(backgroundTasks.size).toBe(0);
    expect(log).toHaveBeenCalledWith(
      'Background operation failed during shutdown.',
      expect.any(Error)
    );
  });

  test('cleanup failures are reported without a rejected shutdown promise', async () => {
    transport.destroy.mockRejectedValue(new Error('fixture destroy failure'));
    const result = await configure({
      closeStreams: () => {
        throw new Error('fixture streams failure');
      },
    }).shutdown();
    expect(result).toEqual({ graceful: false });
    await new Promise((resolve) => setImmediate(resolve));
    expect(log).toHaveBeenCalledWith(
      'Unable to force-close database transport.',
      expect.any(Error)
    );
  });
});
