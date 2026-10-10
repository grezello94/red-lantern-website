/** @jest-environment node */
const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
// Load its WASM bootstrap in Node's native module context; Jest's VM does
// not provide the dynamic-import callback used to read local WASM artifacts.
const nativeRequire = process.getBuiltinModule('module').createRequire(__filename);
const { PGlite } = nativeRequire('@electric-sql/pglite');

// Exercise the real HTTP handlers and their unchanged parameterized SQL against
// an isolated PostgreSQL engine. No credentials, DNS, or production DB are used.
let mockDatabase, mockBeforeQuery, mockAfterQuery;
function mockQuery(strings, ...values) {
  const text = typeof strings === 'string'
    ? strings
    : strings.reduce((result, part, index) => result + (index ? `$${index}` : '') + part, '');
  const params = (typeof strings === 'string' ? values[0] || [] : values).map((value) =>
    Object.prototype.toString.call(value) === '[object Date]' ? value.toISOString() : value);
  let pending;
  return {
    text, params,
    then(resolve, reject) {
      pending ||= (async () => {
        if (mockBeforeQuery) await mockBeforeQuery(text, params);
        const result = await mockDatabase.query(text, params);
        if (mockAfterQuery) await mockAfterQuery(text, params, result.rows);
        return result.rows;
      })();
      return pending.then(resolve, reject);
    },
    catch(reject) { return this.then(undefined, reject); },
  };
}
mockQuery.transaction = async (callback) => {
  const queries = callback(mockQuery);
  if (mockBeforeQuery) await mockBeforeQuery('BEGIN', queries);
  return mockDatabase.transaction(async (tx) => {
    const results = [];
    for (const query of queries) results.push((await tx.query(query.text, query.params)).rows);
    return results;
  });
};
jest.mock('@neondatabase/serverless', () => ({ neon: () => mockQuery, neonConfig: {} }));
jest.mock('web-push', () => ({ setVapidDetails: jest.fn(), sendNotification: jest.fn() }));

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

// A deterministic interleave represents two workstations reading the same bill
// before one commits. Each transaction still runs through real PostgreSQL.
function pauseAfterRead(fragment) {
  const reached = deferred(), release = deferred();
  let paused = false;
  mockAfterQuery = async (query) => {
    if (!paused && query.includes(fragment)) {
      paused = true;
      reached.resolve();
      await release.promise;
    }
  };
  return { reached: reached.promise, release: release.resolve };
}

describe('simultaneous restaurant orders and payment integrity', () => {
  let app, server, origin, captainToken, envSnapshot, envGuard, consoleError;
  const auth = `Basic ${Buffer.from('concurrency-test:concurrency-password').toString('base64')}`;
  beforeAll(async () => {
    envSnapshot = { ...process.env };
    process.env.NEON_DATABASE_URL = 'postgresql://isolated:isolated@localhost/isolated';
    process.env.ORDERS_USERNAME = 'concurrency-test';
    process.env.ORDERS_PASSWORD = 'concurrency-password';
    process.env.CAPTAIN_SESSION_SECRET = 'isolated-captain-test-secret';
    process.env.PUBLIC_CONTENT_CACHE_MS = '0';
    process.env.SECTION_CONTENT_CACHE_MS = '0';
    process.env.SLOW_REQUEST_MS = '600000';
    // The application normally loads .env itself. Explicitly prohibit that in
    // this test so a developer's live credentials can never be consumed.
    const originalExists = fs.existsSync;
    envGuard = jest.spyOn(fs, 'existsSync').mockImplementation((file) =>
      String(file).endsWith('/.env') ? false : originalExists(file));
    consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockDatabase = new PGlite();
    await mockDatabase.waitReady;
    jest.isolateModules(() => { app = require('./server'); });
    await app.prepareDatabase();
    await mockDatabase.exec(`CREATE TABLE IF NOT EXISTS loyalty_accounts (
      customer_phone TEXT PRIMARY KEY, points INTEGER NOT NULL DEFAULT 0 CHECK(points>=0),
      total_earned INTEGER NOT NULL DEFAULT 0, total_redeemed INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());`);
    const captain = { id: 'captain-one', name: 'Captain One', role: 'captain', active: true,
      tableScope: 'all', areas: ['AC'], permissions: { pickupOrders: true },
      pinHash: crypto.scryptSync('123456', 'captain:captain-one', 64).toString('hex') };
    await mockDatabase.query('INSERT INTO website_content (id,data) VALUES ($1,$2),($3,$4)', [
      'air_menu_content', JSON.stringify({ loyalty: { enabled: true, spend: 10, earn: 1 },
        items: [{ name: 'Soup', category: 'Soups', price: '₹100' }] }),
      'captain_content', JSON.stringify({ captains: [captain], settings: {} }),
    ]);
    await mockDatabase.query("INSERT INTO order_operations_config (config_key,config) VALUES ('default',$1) ON CONFLICT (config_key) DO UPDATE SET config=EXCLUDED.config", [
      JSON.stringify({ printers: [], routes: [], tableAreas: [{ name: 'AC', from: 1, to: 30 }] }),
    ]);
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
    const login = await request('/api/captain/login', 'POST', { id: captain.id, pin: '123456' }, false);
    expect(login.status).toBe(200);
    captainToken = login.data.token;
  }, 30000);
  beforeEach(async () => {
    mockBeforeQuery = mockAfterQuery = null;
    await mockDatabase.exec(`TRUNCATE direct_orders, order_payments, order_events,
      captain_order_requests, order_kots, loyalty_accounts, kitchen_order_courses,
      kitchen_production_tasks, kitchen_task_events, kitchen_service_events CASCADE;`);
  });
  afterAll(async () => {
    mockBeforeQuery = mockAfterQuery = null;
    if (server) await new Promise((resolve) => server.close(resolve));
    if (mockDatabase) await mockDatabase.close();
    envGuard?.mockRestore();
    consoleError?.mockRestore();
    process.env = envSnapshot;
  });
  async function request(path, method = 'GET', body, authenticated = true, extraHeaders = {}) {
    const response = await fetch(origin + path, { method,
      headers: { ...(authenticated ? { Authorization: auth } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}), ...extraHeaders },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json() };
  }
  async function seedOrder(id = 'table-one', total = 500, status = 'accepted', table = 1) {
    await mockDatabase.query(`INSERT INTO direct_orders (id,status,mode,customer_name,customer_phone,
      items,total,order_day,daily_order_number,table_area,table_number,fulfillment_type,loyalty_points_earned)
      VALUES ($1,$2,'table','Guest','9876543210',$3,$4,(NOW() AT TIME ZONE 'Asia/Kolkata')::date,$5,'AC',$5,'dine_in',50)`,
      [id, status, JSON.stringify([{ lineId: 'original-line', name: 'Soup', category: 'Soups',
        price: '₹100', quantity: total / 100 }]), total, table]);
    return (await mockDatabase.query('SELECT * FROM direct_orders WHERE id=$1', [id])).rows[0];
  }
  async function addRound(requestId, orderId = 'table-one', table = 1) {
    return request('/api/orders/counter', 'POST', { source: 'captain', clientRequestId: requestId,
      tableArea: 'AC', tableNumber: table, tableOrderId: orderId, action: 'save',
      items: [{ name: 'Soup', category: 'Soups', quantity: 1 }] }, false,
    { 'X-Captain-Session': captainToken });
  }
  async function pay(requestId, paymentType = 'cash') {
    return request('/api/orders/table-one/settle', 'POST', { paymentType, paymentReceived: 500 }, true,
      { 'X-Settlement-Id': requestId });
  }
  async function configureKitchenPrinter() {
    await mockDatabase.query("UPDATE order_operations_config SET config=$1 WHERE config_key='default'", [
      JSON.stringify({ printers: [{ id: 'kitchen', name: 'Kitchen', deviceName: 'Kitchen Queue', type: 'kot' }],
        routes: [{ printerId: 'kitchen', category: 'Soups' }], tableAreas: [{ name: 'AC', from: 1, to: 30 }] }),
    ]);
  }
  const releaseKot = () => request('/api/orders/table-one/kots', 'POST', {});
  async function sentKitchenQuantity() {
    const rows = (await mockDatabase.query('SELECT tickets FROM order_kots')).rows;
    return rows.flatMap((row) => row.tickets).flatMap((ticket) => ticket.items)
      .reduce((sum, item) => sum + Number(item.quantity), 0);
  }
  test('first Captain add returns the committed order rather than a false table conflict', async () => {
    await seedOrder();
    const result = await addRound('first-round');
    expect(result.status).toBe(201);
    expect(result.data).toMatchObject({ id: 'table-one', continued: true, duplicate: false, total: 600 });
    const saved = (await mockDatabase.query('SELECT total,items FROM direct_orders')).rows[0];
    expect(Number(saved.total)).toBe(600);
    expect(saved.items).toHaveLength(2);
  });
  test('simultaneous retries append one round once', async () => {
    await seedOrder();
    const results = await Promise.all(Array.from({ length: 12 }, () => addRound('one-round')));
    expect(results.every((result) => result.status === 201)).toBe(true);
    expect(results.filter((result) => result.data.duplicate === false)).toHaveLength(1);
    const saved = (await mockDatabase.query('SELECT total,items FROM direct_orders')).rows[0];
    expect(Number(saved.total)).toBe(600);
    expect(saved.items).toHaveLength(2);
    expect((await mockDatabase.query('SELECT * FROM captain_order_requests')).rows).toHaveLength(1);
  });
  test('distinct simultaneous Captain rounds preserve every item and the bill total', async () => {
    await seedOrder();
    const results = await Promise.all(Array.from({ length: 16 }, (_, index) => addRound(`round-${index}`)));
    expect(results.every((result) => result.status === 201 && !result.data.duplicate)).toBe(true);
    const saved = (await mockDatabase.query('SELECT total,items FROM direct_orders')).rows[0];
    expect(Number(saved.total)).toBe(2100);
    expect(saved.items).toHaveLength(17);
  });
  test('a bill settled before a pending Captain round cannot gain unpaid extra items', async () => {
    await seedOrder();
    const pause = pauseAfterRead('SELECT o.*,');
    const pending = addRound('late-round');
    await pause.reached;
    try { expect((await pay('settled-first')).status).toBe(200); }
    finally { pause.release(); }
    expect((await pending).status).toBe(409);
    const saved = (await mockDatabase.query('SELECT total,status,items FROM direct_orders')).rows[0];
    expect(saved.status).toBe('completed');
    expect(Number(saved.total)).toBe(500);
    expect(saved.items).toHaveLength(1);
  });
  test('unchanged PostgreSQL microsecond timestamps permit settlement and retry only once', async () => {
    await seedOrder();
    await mockDatabase.exec("UPDATE direct_orders SET updated_at='2026-10-10 02:03:04.123456+00'");
    const results = await Promise.all([pay('same-payment'), pay('same-payment')]);
    expect(results.every((result) => result.status === 200)).toBe(true);
    expect((await mockDatabase.query('SELECT * FROM order_payments')).rows).toHaveLength(1);
    const wallet = (await mockDatabase.query('SELECT points FROM loyalty_accounts')).rows[0];
    expect(wallet.points).toBe(50);
  });
  test('an item added after the payment screen read cannot be settled at the old total', async () => {
    await seedOrder();
    const pause = pauseAfterRead('SELECT total,updated_at::text');
    const payment = pay('stale-total');
    await pause.reached;
    try { expect((await addRound('extra-soup')).status).toBe(201); }
    finally { pause.release(); }
    expect(await payment).toMatchObject({ status: 409, data: { code: 'bill_changed' } });
    const saved = (await mockDatabase.query('SELECT status,total FROM direct_orders')).rows[0];
    expect(saved.status).toBe('accepted');
    expect(Number(saved.total)).toBe(600);
    expect((await mockDatabase.query('SELECT * FROM order_payments')).rows).toHaveLength(0);
    expect((await mockDatabase.query('SELECT * FROM loyalty_accounts')).rows).toHaveLength(0);
  });
  test('losing full payment cannot award loyalty on a winning due settlement', async () => {
    await seedOrder();
    const pause = pauseAfterRead('SELECT total,updated_at::text');
    const fullPayment = pay('losing-full');
    await pause.reached;
    try { expect((await pay('winning-due', 'due')).status).toBe(200); }
    finally { pause.release(); }
    expect((await fullPayment).status).toBe(409);
    const payments = (await mockDatabase.query('SELECT * FROM order_payments')).rows;
    expect(payments).toHaveLength(1);
    expect(payments[0].payment_type).toBe('due');
    expect((await mockDatabase.query('SELECT * FROM loyalty_accounts')).rows).toHaveLength(0);
  });
  test('losing cancellation cannot reverse a concurrent completion reward', async () => {
    await seedOrder();
    const pause = pauseAfterRead('SELECT status,customer_phone,customer_name');
    const cancellation = request('/api/orders/table-one', 'PATCH', { status: 'cancelled', reason: 'Changed mind' });
    await pause.reached;
    try { expect((await pay('completion-wins')).status).toBe(200); }
    finally { pause.release(); }
    expect((await cancellation).status).toBe(409);
    expect((await mockDatabase.query('SELECT points FROM loyalty_accounts')).rows[0].points).toBe(50);
    expect((await mockDatabase.query('SELECT loyalty_awarded_at FROM direct_orders')).rows[0].loyalty_awarded_at).not.toBeNull();
  });
  test('quantity edits and discounts accept unchanged microsecond versions', async () => {
    await seedOrder();
    await mockDatabase.exec("UPDATE direct_orders SET updated_at='2026-10-10 02:03:04.123456+00'");
    expect((await request('/api/orders/table-one/items', 'PATCH', { quantities: [4] })).status).toBe(200);
    expect((await request('/api/orders/table-one/discount', 'POST', { type: 'fixed', value: 20, reason: 'Guest offer' })).status).toBe(200);
  });
  test('current orders retain older active tickets after more than 100 newer completions', async () => {
    await seedOrder('old-active', 500, 'accepted', 1);
    await mockDatabase.exec(`UPDATE direct_orders SET created_at=NOW()-INTERVAL '2 hours';
      INSERT INTO direct_orders (id,status,mode,customer_phone,items,total,order_day,daily_order_number,created_at)
      SELECT 'closed-'||n,'completed','counter','walkin-'||n,'[]'::jsonb,100,
        (NOW() AT TIME ZONE 'Asia/Kolkata')::date,n+1,NOW()-n*INTERVAL '1 second'
      FROM generate_series(1,140) n;`);
    const current = await request('/api/orders');
    expect(current.status).toBe(200);
    expect(current.data.some((order) => order.id === 'old-active')).toBe(true);
    expect(current.data.filter((order) => order.status === 'completed')).toHaveLength(100);
    expect(current.data).toHaveLength(101);
    const history = await request('/api/orders?history=1');
    expect(history.status).toBe(200);
    expect(history.data).toHaveLength(100);
  });
  test('expanded current lists still hide orders outside Captain areas', async () => {
    await seedOrder();
    await seedOrder('outside-area', 500, 'accepted', 2);
    await mockDatabase.query("UPDATE direct_orders SET table_area='BAR' WHERE id='outside-area'");
    const current = await request('/api/orders', 'GET', undefined, false, { 'X-Captain-Session': captainToken });
    expect(current.status).toBe(200);
    expect(current.data.map((order) => order.id)).toEqual(['table-one']);
  });
  test('simultaneous kitchen release retries create one round', async () => {
    await seedOrder(); await configureKitchenPrinter();
    const results = await Promise.all(Array.from({ length: 12 }, releaseKot));
    expect(results.filter((result) => ![200, 201, 409].includes(result.status))).toEqual([]);
    expect(results.filter((result) => result.status === 409)
      .every((result) => result.data.error === 'No new items to send.')).toBe(true);
    expect(results.filter((result) => result.status === 201)).toHaveLength(1);
    expect((await mockDatabase.query('SELECT * FROM order_kots')).rows).toHaveLength(1);
    expect(await sentKitchenQuantity()).toBe(5);
  });
  test('an order changed while a KOT snapshot is held retries without sending stale quantities', async () => {
    await seedOrder(); await configureKitchenPrinter();
    const pause = pauseAfterRead('SELECT tickets FROM order_kots');
    const pending = releaseKot();
    await pause.reached;
    try { expect((await addRound('added-before-release')).status).toBe(201); }
    finally { pause.release(); }
    expect(await pending).toMatchObject({ status: 503, data: { code: 'kot_snapshot_changed' } });
    expect(await sentKitchenQuantity()).toBe(0);
    expect((await releaseKot()).status).toBe(201);
    expect(await sentKitchenQuantity()).toBe(6);
  });
  test('overlapping KOT snapshots with different fingerprints cannot oversend an add-on', async () => {
    await seedOrder(); await configureKitchenPrinter();
    expect((await releaseKot()).status).toBe(201);
    expect((await addRound('second-round')).status).toBe(201);
    const pause = pauseAfterRead('SELECT tickets FROM order_kots');
    const stale = releaseKot();
    await pause.reached;
    try {
      expect((await addRound('third-round')).status).toBe(201);
      expect((await releaseKot()).status).toBe(201);
    } finally { pause.release(); }
    expect(await stale).toMatchObject({ status: 503, data: { code: 'kot_snapshot_changed' } });
    expect(await sentKitchenQuantity()).toBe(7);
    expect((await releaseKot()).status).toBe(409);
    expect(await sentKitchenQuantity()).toBe(7);
  });
  test('a kitchen round created during a quantity edit forces review of its correction ledger', async () => {
    await seedOrder(); await configureKitchenPrinter();
    const pause = pauseAfterRead('SELECT tickets FROM order_kots');
    const edit = request('/api/orders/table-one/items', 'PATCH', { quantities: [4] });
    await pause.reached;
    try { expect((await releaseKot()).status).toBe(201); }
    finally { pause.release(); }
    expect(await edit).toMatchObject({ status: 409, data: { code: 'order_changed' } });
    expect((await request('/api/orders/table-one/items', 'PATCH', { quantities: [4] })).status).toBe(200);
    const changes = (await mockDatabase.query("SELECT details FROM order_events WHERE event_type='items-updated'")).rows;
    expect(changes).toHaveLength(1);
    expect(changes[0].details.kotReductions[0].quantity).toBe(1);
    expect((await addRound('after-reduction')).status).toBe(201);
    expect((await releaseKot()).status).toBe(201);
    expect(await sentKitchenQuantity()).toBe(6);
  });
});
