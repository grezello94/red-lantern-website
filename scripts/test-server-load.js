#!/usr/bin/env node
/*
 * LOCAL ONLY: node scripts/test-server-load.js [--users=25,50,100] [--rounds=2]
 *   [--db-min-ms=20] [--db-max-ms=40] [--db-concurrency=24]
 *   [--slow-users=100] [--slow-db-ms=150] [--json=/tmp/report.json]
 *
 * Exercises the real Express middleware, staff sessions, order validation,
 * numbering, idempotency, polling and status changes. PostgreSQL and external
 * services are replaced with a delayed in-memory SQL fixture. This is a
 * repeatable concurrency regression test, NOT a production capacity benchmark.
 * It has no target URL option and refuses non-loopback fetches or .env reads.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const Module = require('node:module');
const crypto = require('node:crypto');
const { performance, monitorEventLoopDelay } = require('node:perf_hooks');
const { createLoadFixture, statement } = require('./load-server-fixture');

const options = Object.fromEntries(
  process.argv.slice(2).map((argument) => {
    assert.match(
      argument,
      /^--[a-z-]+=/,
      'Use named --option=value arguments; remote URLs are unsupported.'
    );
    const separator = argument.indexOf('=');
    return [argument.slice(2, separator), argument.slice(separator + 1)];
  })
);
for (const key of Object.keys(options))
  assert.ok(
    [
      'users',
      'rounds',
      'db-min-ms',
      'db-max-ms',
      'db-concurrency',
      'slow-users',
      'slow-db-ms',
      'json',
    ].includes(key),
    `Unknown option: ${key}`
  );
const stages = (options.users || '25,50,100').split(',').map(Number);
assert.ok(
  stages.length && stages.every((users) => Number.isInteger(users) && users > 0 && users <= 500),
  'Each local stage needs 1–500 virtual users.'
);
const numericOption = (name, fallback, maximum) => {
  const value = options[name] === undefined ? fallback : Number(options[name]);
  assert.ok(
    Number.isInteger(value) &&
      value >= (['db-min-ms', 'db-max-ms', 'slow-users'].includes(name) ? 0 : 1) &&
      value <= maximum,
    `Invalid ${name}.`
  );
  return value;
};
const settings = {
  stages,
  rounds: numericOption('rounds', 2, 10),
  minimumDelayMs: numericOption('db-min-ms', 20, 500),
  maximumDelayMs: numericOption('db-max-ms', 40, 500),
  concurrency: numericOption('db-concurrency', 24, 100),
  slowUsers: numericOption('slow-users', 100, 500),
  slowDelayMs: numericOption('slow-db-ms', 150, 1000),
};
assert.ok(
  settings.maximumDelayMs >= settings.minimumDelayMs,
  'db-max-ms must be at least db-min-ms.'
);

const fixture = createLoadFixture(settings);
const originalLoad = Module._load,
  originalExists = fs.existsSync,
  originalRead = fs.readFileSync,
  originalFetch = global.fetch;
const temporaryUploads = fs.mkdtempSync(path.join(os.tmpdir(), 'red-lantern-local-load-'));
const environment = { ...process.env };
const credentials = {
  username: 'local-load-fixture',
  password: 'local-load-with-no-production-access',
};
let server, origin, cookie;
const simulatedSqlUrl = 'https://isolated-local-load.invalid/sql';
const mockedNeon = { neonConfig: {} };
async function sendSimulatedSql(payload) {
  assert.equal(
    typeof mockedNeon.neonConfig.fetchFunction,
    'function',
    'The real server must configure its database HTTP transport.'
  );
  const response = await mockedNeon.neonConfig.fetchFunction(simulatedSqlUrl, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  const data = await response.json();
  if (data.error) throw Object.assign(new Error(data.error.message), { code: data.error.code });
  return data.rows;
}
const simulatedSql = (...arguments_) => sendSimulatedSql({ statement: statement(...arguments_) });
simulatedSql.transaction = (operation) =>
  sendSimulatedSql({
    transaction:
      typeof operation === 'function'
        ? operation((...arguments_) => statement(...arguments_))
        : operation,
  });
mockedNeon.neon = () => simulatedSql;
async function fetchSimulatedSql(url, options) {
  assert.equal(String(url), simulatedSqlUrl, 'The simulated SQL adapter forbids external HTTP.');
  const payload = JSON.parse(options.body);
  let result;
  try {
    const work = payload.transaction
      ? fixture.sql.transaction(payload.transaction)
      : fixture.sql(payload.statement.text, payload.statement.values);
    if (!options.signal) result = await work;
    else
      result = await new Promise((resolve, reject) => {
        const abort = () =>
          reject(options.signal.reason || new Error('Simulated SQL transport aborted.'));
        if (options.signal.aborted) return abort();
        options.signal.addEventListener('abort', abort, { once: true });
        work
          .then(resolve, reject)
          .finally(() => options.signal.removeEventListener('abort', abort));
      });
    return new Response(JSON.stringify({ rows: result }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: { message: error.message, code: error.code } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
const report = {
  kind: 'isolated-local-simulated-database',
  runtime: { node: process.version, platform: process.platform, architecture: process.arch },
  limitations: [
    'Not a production capacity promise: CPU, network, Neon compute, query plans, locks and Windows printer hardware are not measured.',
    'Virtual users use authenticated counter-console sessions; employee PIN sign-in, wallet redemption and print delivery are not part of this load mix.',
    'SQL is an explicit in-memory model with configurable latency and concurrency; it is not PostgreSQL and does not validate migration/query syntax.',
    'The real database transport limits are exercised through a simulated SQL wire adapter; Neon protocol, remote connection behavior and SQL plans are not reproduced.',
    'This tests concurrent bursts and slow database pressure, not a long-running production soak.',
  ],
  settings,
  stages: [],
  integrity: null,
  finalDatabase: null,
};

function rounded(value) {
  return Math.round(value * 10) / 10;
}
function summarize(samples) {
  const values = samples.map((sample) => sample.durationMs).sort((a, b) => a - b);
  const percentile = (fraction) =>
    values[Math.max(0, Math.ceil(values.length * fraction) - 1)] || 0;
  return {
    requests: samples.length,
    successful: samples.filter((sample) => sample.status >= 200 && sample.status < 300).length,
    successfulImmediately: samples.filter(
      (sample) =>
        sample.attemptStatuses?.length === 1 && sample.status >= 200 && sample.status < 300
    ).length,
    controlledOverloadResponses: samples.reduce(
      (count, sample) =>
        count +
        (sample.attemptStatuses || []).filter((status) => status === 429 || status === 503).length,
      0
    ),
    httpAttempts: samples.reduce(
      (count, sample) => count + (sample.attemptStatuses?.length || 1),
      0
    ),
    errors: samples
      .filter((sample) => sample.status < 200 || sample.status >= 300)
      .map(({ path: requestPath, status, error }) => ({ path: requestPath, status, error })),
    p50Ms: rounded(percentile(0.5)),
    p95Ms: rounded(percentile(0.95)),
    maximumMs: rounded(values.at(-1) || 0),
  };
}

async function singleRequest(
  requestPath,
  { method = 'GET', body, authenticated = true, requestId } = {}
) {
  const started = performance.now();
  try {
    const response = await fetch(origin + requestPath, {
      method,
      redirect: 'manual',
      signal: AbortSignal.timeout(30000),
      headers: {
        ...(authenticated ? { Cookie: cookie } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(requestId ? { 'X-Counter-Order-Id': requestId } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: text.slice(0, 120) };
    }
    return {
      path: requestPath,
      status: response.status,
      durationMs: performance.now() - started,
      data,
      headers: response.headers,
      error: data?.error,
    };
  } catch (error) {
    return {
      path: requestPath,
      status: 0,
      durationMs: performance.now() - started,
      error: error.message,
    };
  }
}

async function request(requestPath, options = {}) {
  const started = performance.now(),
    attemptStatuses = [];
  let result;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    result = await singleRequest(requestPath, options);
    attemptStatuses.push(result.status);
    if (![429, 503].includes(result.status)) break;
    const retryAfterSeconds = Number(result.headers?.get('retry-after'));
    const delayMs =
      Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
        ? Math.min(5000, retryAfterSeconds * 1000)
        : 500;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return { ...result, durationMs: performance.now() - started, attemptStatuses };
}

function orderBody(index = 0, extra = {}) {
  return {
    customerName: `Local fixture customer ${index}`,
    items: [0, 1, 2].map((offset) => ({
      name: fixture.menu.items[(index + offset) % fixture.menu.items.length].name,
      category: fixture.menu.items[(index + offset) % fixture.menu.items.length].category,
      quantity: 1,
      menuType: 'food',
    })),
    action: 'submit',
    ...extra,
  };
}

async function runStage(users, { label = 'normal-database', rounds = settings.rounds } = {}) {
  const samples = [],
    health = [],
    orders = [];
  const before = fixture.snapshot(),
    memoryBefore = process.memoryUsage(),
    started = performance.now();
  const lag = monitorEventLoopDelay({ resolution: 10 });
  lag.enable();
  let healthInFlight = false;
  const healthTimer = setInterval(() => {
    if (healthInFlight) return;
    healthInFlight = true;
    request('/api/healthz', { authenticated: false })
      .then((result) => {
        health.push(result);
      })
      .finally(() => {
        healthInFlight = false;
      });
  }, 50);
  let peakRss = memoryBefore.rss;
  const memoryTimer = setInterval(() => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  }, 50);
  try {
    await Promise.all(
      Array.from({ length: users }, (_, user) =>
        (async () => {
          for (let round = 0; round < rounds; round += 1) {
            const firstPoll = await request(
              user % 2 ? '/api/orders/menu' : '/api/orders/availability'
            );
            samples.push(firstPoll);
            const created = await request('/api/orders/counter', {
              method: 'POST',
              body: orderBody(user + round * users),
              requestId: `local-${label}-${users}-${round}-${user}`,
            });
            samples.push(created);
            orders.push(created);
            const polling = await Promise.all([
              request('/api/orders'),
              request('/api/orders/live-summary'),
            ]);
            samples.push(...polling);
            if (created.data?.id && user % 5 === 0)
              samples.push(
                await request(`/api/orders/${created.data.id}`, {
                  method: 'PATCH',
                  body: { status: 'preparing' },
                })
              );
          }
        })()
      )
    );
    const settled = await fixture.settle(30000);
    const elapsedSeconds = (performance.now() - started) / 1000;
    const memoryAfter = process.memoryUsage(),
      after = fixture.snapshot();
    const result = {
      label,
      users,
      rounds,
      elapsedSeconds: rounded(elapsedSeconds),
      ...summarize(samples),
      counterOrders: summarize(orders),
      health: summarize(health),
      requestsPerSecond: rounded(samples.length / elapsedSeconds),
      backgroundWorkSettled: settled,
      memory: {
        rssBeforeMiB: rounded(memoryBefore.rss / 1048576),
        peakRssMiB: rounded(peakRss / 1048576),
        rssAfterMiB: rounded(memoryAfter.rss / 1048576),
        heapUsedMiB: rounded(memoryAfter.heapUsed / 1048576),
      },
      eventLoop: { p95Ms: rounded(lag.percentile(95) / 1e6), maximumMs: rounded(lag.max / 1e6) },
      database: {
        newOrders: after.orders - before.orders,
        queries: after.queries - before.queries,
        queriesPerOrder: rounded(
          (after.queries - before.queries) / Math.max(1, after.orders - before.orders)
        ),
        peakWaitingQueries: after.peakWaitingQueries,
      },
    };
    report.stages.push(result);
    console.log(
      JSON.stringify({
        stage: users,
        label,
        counterOrders: result.counterOrders.successful,
        controlledOverloadResponses: result.controlledOverloadResponses,
        requestErrors: result.errors.length,
        orderP95Ms: result.counterOrders.p95Ms,
        healthP95Ms: result.health.p95Ms,
        peakRssMiB: result.memory.peakRssMiB,
        queries: result.database.queries,
        backgroundWorkSettled: settled,
      })
    );
    assert.equal(
      result.errors.length,
      0,
      `Unexpected request errors at ${users} simultaneous users.`
    );
    assert.equal(result.counterOrders.successful, users * rounds);
    assert.equal(
      result.database.newOrders,
      users * rounds,
      'Every unique submission must create exactly one order.'
    );
    assert.ok(settled, 'Background tasks did not settle within the local fixture deadline.');
    assert.ok(
      health.length &&
        health.every((sample) => sample.status === 200 && sample.attemptStatuses.length === 1),
      'Health checks must remain responsive immediately during the burst.'
    );
  } finally {
    clearInterval(healthTimer);
    clearInterval(memoryTimer);
    lag.disable();
  }
}

async function integrityChecks() {
  const duplicateBefore = fixture.orders.size;
  const duplicateResults = await Promise.all(
    Array.from({ length: 12 }, () =>
      request('/api/orders/counter', {
        method: 'POST',
        body: orderBody(),
        requestId: 'local-concurrent-duplicate',
      })
    )
  );
  assert.ok(
    duplicateResults.every((result) => [200, 201].includes(result.status)),
    'Duplicate requests must recover the saved result.'
  );
  assert.equal(new Set(duplicateResults.map((result) => result.data.id)).size, 1);
  assert.equal(fixture.orders.size - duplicateBefore, 1);
  const tableBefore = fixture.orders.size;
  const collisionResults = await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      request('/api/orders/counter', {
        method: 'POST',
        body: orderBody(index, { tableArea: 'AC', tableNumber: 1 }),
        requestId: `local-table-collision-${index}`,
      })
    )
  );
  report.integrity = {
    collisionResponses: collisionResults.map(({ status, data }) => ({
      status,
      code: data?.code,
      error: data?.error,
    })),
  };
  assert.equal(
    collisionResults.filter((result) => result.status === 201).length,
    1,
    'Only one order may claim a simultaneously selected table.'
  );
  assert.equal(collisionResults.filter((result) => result.status === 409).length, 7);
  assert.equal(fixture.orders.size - tableBefore, 1);
  const all = [...fixture.orders.values()];
  assert.equal(
    new Set(all.map((order) => `${order.order_day}:${order.daily_order_number}`)).size,
    all.length,
    'Daily order numbers must stay unique.'
  );
  assert.equal(
    new Set(all.map((order) => `${order.bill_year}:${order.bill_number}`)).size,
    all.length,
    'Bill numbers must stay unique.'
  );
  report.integrity = {
    concurrentRetries: duplicateResults.length,
    savedOrdersForRetries: 1,
    tableContenders: collisionResults.length,
    tableOrdersCreated: 1,
    tableConflicts: 7,
    uniqueOrderNumbers: true,
    uniqueBillNumbers: true,
  };
}

async function main() {
  // Ignore inherited application secrets. Fixtures do not read a credentials
  // file, preserve uploads, or have credentials for a real service.
  for (const key of Object.keys(process.env))
    if (
      /^(NEON_|DATABASE_|PG|ADMIN_|ORDERS_|AIR_MENU_|CLOUDINARY_|VAPID_|UPLOADS_|HOST$|PORT$)/.test(
        key
      )
    )
      delete process.env[key];
  Object.assign(process.env, {
    ORDERS_USERNAME: credentials.username,
    ORDERS_PASSWORD: credentials.password,
    ORDERS_SESSION_SECRET: 'isolated-local-load-session-secret',
    NEON_DATABASE_URL: 'postgresql://fixture:fixture@localhost/fixture',
    UPLOADS_DIR: temporaryUploads,
  });
  fs.existsSync = (filename) =>
    path.basename(String(filename)) === '.env' ? false : originalExists(filename);
  fs.readFileSync = (filename, ...arguments_) => {
    assert.notEqual(
      path.basename(String(filename)),
      '.env',
      'The local harness must never read .env.'
    );
    return originalRead(filename, ...arguments_);
  };
  Module._load = function (name, parent, isMain) {
    if (name === '@neondatabase/serverless') return mockedNeon;
    if (name === 'web-push')
      return {
        setVapidDetails() {},
        async sendNotification() {
          throw new Error('External push disabled in local load fixture.');
        },
      };
    if (name === 'cloudinary')
      return {
        v2: {
          config() {},
          uploader: {
            async upload() {
              throw new Error('External uploads disabled in local load fixture.');
            },
          },
        },
      };
    if (name === 'undici')
      return {
        Agent: class LocalFixtureAgent {
          async close() {}
        },
        fetch: fetchSimulatedSql,
      };
    return originalLoad.call(this, name, parent, isMain);
  };
  global.fetch = (input, ...arguments_) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    assert.equal(
      url.origin,
      origin,
      'The LOCAL load harness cannot send requests to any external system.'
    );
    return originalFetch(input, ...arguments_);
  };
  try {
    report.runtime.serverSha256 = crypto
      .createHash('sha256')
      .update(fs.readFileSync(path.join(__dirname, '..', 'server.js')))
      .digest('hex');
    const app = require('../server');
    await app.locals.prepareOrdersDatabase();
    server = http.createServer(app);
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    origin = `http://127.0.0.1:${server.address().port}`;
    const login = await request('/api/orders/session', {
      authenticated: false,
      method: 'POST',
      body: credentials,
    });
    assert.equal(login.status, 200, 'Local fixture staff session must authenticate.');
    cookie = login.headers.get('set-cookie').split(';')[0];
    // Warm schema and menu-profile caches before recording steady-state bursts.
    const warm = await request('/api/orders/counter', {
      method: 'POST',
      body: orderBody(),
      requestId: 'local-load-warmup',
    });
    assert.equal(warm.status, 201, JSON.stringify(warm.data));
    assert.ok(await fixture.settle());
    for (const users of settings.stages) await runStage(users);
    if (settings.slowUsers) {
      fixture.setDelay(settings.slowDelayMs, settings.slowDelayMs + 20);
      await runStage(settings.slowUsers, { label: 'slow-database-pressure', rounds: 1 });
      fixture.setDelay(settings.minimumDelayMs, settings.maximumDelayMs);
    }
    await integrityChecks();
    assert.ok(await fixture.settle());
    report.finalDatabase = fixture.snapshot();
    assert.deepEqual(
      report.finalDatabase.unknownQueries,
      [],
      'Any unmodeled SQL makes the fixture result invalid.'
    );
    report.passed = true;
  } catch (error) {
    report.passed = false;
    report.failure = error.message;
    report.finalDatabase = fixture.snapshot();
    process.exitCode = 1;
  } finally {
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    global.fetch = originalFetch;
    Module._load = originalLoad;
    fs.existsSync = originalExists;
    fs.readFileSync = originalRead;
    for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key];
    Object.assign(process.env, environment);
    fs.rmSync(temporaryUploads, { recursive: true, force: true });
  }
  if (options.json)
    fs.writeFileSync(path.resolve(options.json), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error('Local load harness failed:', error.message);
  process.exitCode = 1;
});
