/** @jest-environment node */
const http = require('http');
const fs = require('fs');

let mockState;
const mockSql = jest.fn(async (strings, ...values) => {
  const query = typeof strings === 'string' ? strings : strings.join('$');
  mockState.queries.push(query);
  const isOrderProbe = query.includes('orders.service_priority') && query.includes('LIMIT 0');
  if (isOrderProbe && mockState.probeFailures > 0) {
    mockState.probeFailures--;
    throw Object.assign(new Error('temporary database connection failure'), { code: '08006' });
  }
  if (isOrderProbe && mockState.missingPriority)
    throw Object.assign(new Error('column orders.service_priority does not exist'), { code: '42703' });
  if (query.includes('ADD COLUMN IF NOT EXISTS service_priority')) {
    if (mockState.migrationFailures > 0) {
      mockState.migrationFailures--;
      throw Object.assign(new Error('connection lost during migration'), { code: '08006' });
    }
    if (!mockState.ignoreMigration) mockState.missingPriority = false;
  }
  if (query.includes('FROM direct_orders o WHERE o.id=')) {
    if (mockState.kotFailures > 0) {
      mockState.kotFailures--;
      throw Object.assign(new Error('column o.service_priority does not exist'), { code: '42703' });
    }
    return [{ id: values[0], status: 'accepted', mode: 'counter', daily_order_number: 1,
      customer_name: 'Walk-in customer', customer_phone: 'walkin-test', service_priority: 'normal',
      items: [{ name: 'Soup', category: 'Soups', quantity: 1 }] }];
  }
  if (query.includes('SELECT config FROM order_operations_config'))
    return [{ config: { printers: [{ id: 'kitchen', name: 'Kitchen', deviceName: 'Kitchen Queue', type: 'kot' }],
      routes: [{ printerId: 'kitchen', category: 'Soups' }] } }];
  if (query.includes('INSERT INTO order_kot_counters')) return [{ next_number: 1 }];
  if (query.includes('INSERT INTO order_kots (order_id')) return [{ kot_number: 1 }];
  if (query.includes('SELECT id FROM direct_orders WHERE')) return [{ id: values[0] }];
  if (query.includes('UPDATE order_print_jobs SET status=\'printing\'')) {
    if (['queued', 'failed'].includes(mockState.billStatus) || mockState.billLeaseExpired) {
      mockState.billStatus = 'printing';
      mockState.billLeaseExpired = false;
      return [{ order_id: values[0] }];
    }
  }
  if (query.includes('SELECT status,lease_expires_at FROM order_print_jobs'))
    return [{ status: mockState.billStatus, lease_expires_at: new Date(Date.now() + 45000).toISOString() }];
  return [];
});
jest.mock('@neondatabase/serverless', () => ({ neon: () => mockSql, neonConfig: {} }));
mockSql.transaction = (callback) => Promise.all(callback(mockSql));
jest.mock('web-push', () => ({ setVapidDetails: jest.fn(), sendNotification: jest.fn() }));

describe('Orders schema upgrade and reconnect recovery', () => {
  let app, server, origin, consoleError;
  beforeEach(async () => {
    mockState = { queries: [], missingPriority: false, probeFailures: 0,
      migrationFailures: 0, kotFailures: 0, ignoreMigration: false,
      billStatus: 'queued', billLeaseExpired: false };
    process.env.NEON_DATABASE_URL = 'postgresql://test:test@localhost/test';
    process.env.ORDERS_USERNAME = 'schema-test';
    process.env.ORDERS_PASSWORD = 'schema-test-password';
    consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.isolateModules(() => { app = require('./server'); });
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
  });
  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    consoleError.mockRestore();
  });
  async function request(path, method = 'GET', authenticated = true) {
    const response = await fetch(origin + path, {
      method,
      headers: authenticated ? { Authorization: `Basic ${Buffer.from('schema-test:schema-test-password').toString('base64')}` } : {},
    });
    return { status: response.status, data: await response.json(), headers: response.headers };
  }
  test('upgrades yesterday’s database before its first KOT without a separate manual migration', async () => {
    mockState.missingPriority = true;
    const result = await request('/api/orders/saved-order/kots', 'POST');
    expect(result.status).toBe(201);
    expect(result.data.kotNumber).toBe(1);
    expect(result.data.tickets[0].printerName).toBe('Kitchen Queue');
    expect(mockState.missingPriority).toBe(false);
    const probes = mockState.queries.filter((query) => query.includes('orders.service_priority') && query.includes('LIMIT 0'));
    expect(probes).toHaveLength(2);
  });
  test('readiness upgrades the database before declaring printing ready', async () => {
    mockState.missingPriority = true;
    const result = await request('/api/orders/readiness');
    expect(result.status).toBe(200);
    expect(result.data).toMatchObject({ ok: true, schemaReady: true, schemaVersion: '2026-10-08-printing' });
    expect(result.headers.get('cache-control')).toBe('no-store');
    expect(mockState.missingPriority).toBe(false);
  });
  test('an incomplete migration fails readiness instead of reporting success', async () => {
    mockState.missingPriority = true;
    mockState.ignoreMigration = true;
    const result = await request('/api/orders/readiness');
    expect(result.status).toBe(503);
    expect(result.data.schemaReady).toBe(false);
    expect(result.data.error).not.toContain('service_priority');
    mockState.ignoreMigration = false;
    expect((await request('/api/orders/readiness')).status).toBe(200);
  });
  test.each(['probeFailures', 'migrationFailures'])('recovers in the same server instance after a transient %s', async (failure) => {
    mockState.missingPriority = failure === 'migrationFailures';
    mockState[failure] = 1;
    expect((await request('/api/orders/readiness')).status).toBe(503);
    expect((await request('/api/orders/readiness')).status).toBe(200);
  });
  test('KOT failure retains the saved order, logs the underlying error and gives a retryable response', async () => {
    await app.locals.prepareOrdersDatabase();
    mockState.kotFailures = 1;
    const failure = await request('/api/orders/saved-order/kots', 'POST');
    expect(failure.status).toBe(503);
    expect(failure.data).toMatchObject({ code: 'kot_preparation_unavailable', retryable: true, orderId: 'saved-order' });
    expect(failure.data.error).not.toContain('service_priority');
    expect(consoleError).toHaveBeenCalledWith('KOT preparation failed:', 'column o.service_priority does not exist');
    expect(mockState.queries.some((query) => /DELETE FROM direct_orders/.test(query))).toBe(false);
    expect((await request('/api/orders/saved-order/kots', 'POST')).status).toBe(201);
  });
  test('database readiness requires staff authentication', async () => {
    const result = await request('/api/orders/readiness', 'GET', false);
    expect(result.status).toBe(401);
    expect(mockState.queries.some((query) => query.includes('ADD COLUMN'))).toBe(false);
  });
  test('an active bill-print lease remains pending until it is printed or can be reclaimed', async () => {
    const first = await request('/api/orders/saved-order/bill-print/claim', 'POST');
    expect(first.data).toMatchObject({ claimed: true, status: 'printing' });
    const pending = await request('/api/orders/saved-order/bill-print/claim', 'POST');
    expect(pending.data).toMatchObject({ claimed: false, status: 'printing' });
    expect(pending.data.leaseExpiresAt).toBeTruthy();
    mockState.billLeaseExpired = true;
    expect((await request('/api/orders/saved-order/bill-print/claim', 'POST')).data)
      .toMatchObject({ claimed: true, status: 'printing' });
    mockState.billStatus = 'printed';
    expect((await request('/api/orders/saved-order/bill-print/claim', 'POST')).data)
      .toMatchObject({ claimed: false, status: 'printed' });
  });
  test('the database preparation CLI uses the same migrations as PWA readiness', async () => {
    mockState.missingPriority = true;
    const result = await app.prepareDatabase();
    expect(result.schemaReady).toBe(true);
    expect(mockState.missingPriority).toBe(false);
    expect(mockState.queries.some((query) => query.includes('CREATE TABLE IF NOT EXISTS website_content'))).toBe(true);
  });
  test('every direct-order migration column is covered by the readiness query', () => {
    const source = fs.readFileSync(require.resolve('./server'), 'utf8');
    const probe = source.slice(source.indexOf('async function probeDirectOrdersSchema'), source.indexOf('async function ensureDirectOrdersTable'));
    const migration = source.slice(source.indexOf('async function ensureDirectOrdersTable'), source.indexOf('async function ensureOrderPaymentsTable'));
    const columns = [...migration.matchAll(/ALTER TABLE direct_orders ADD COLUMN IF NOT EXISTS (\w+)/g)].map((match) => match[1]);
    expect(columns.length).toBeGreaterThan(25);
    for (const column of columns) expect(probe).toContain(`orders.${column}`);
  });
});
