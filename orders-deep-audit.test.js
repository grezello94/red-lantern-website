/** @jest-environment node */
const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
const nativeRequire = process.getBuiltinModule('module').createRequire(__filename);
const { PGlite } = nativeRequire('@electric-sql/pglite');

let mockDatabase, mockAfterQuery, mockDatabaseError;
function mockQuery(strings, ...values) {
  const text = typeof strings === 'string' ? strings
    : strings.reduce((result, part, index) => result + (index ? `$${index}` : '') + part, '');
  const params = (typeof strings === 'string' ? values[0] || [] : values).map((value) =>
    Object.prototype.toString.call(value) === '[object Date]' ? value.toISOString() : value);
  let pending;
  return { text, params,
    then(resolve, reject) {
      pending ||= (async () => {
        const result = await mockDatabase.query(text, params).catch(error => {
          mockDatabaseError = error.message;
          throw error;
        });
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
  return mockDatabase.transaction(async (tx) => {
    const results = [];
    for (const query of queries) results.push((await tx.query(query.text, query.params).catch(error => {
      mockDatabaseError = error.message;
      throw error;
    })).rows);
    return results;
  });
};
jest.mock('@neondatabase/serverless', () => ({ neon: () => mockQuery, neonConfig: {} }));
jest.mock('web-push', () => ({ setVapidDetails: jest.fn(), sendNotification: jest.fn() }));
jest.mock('cloudinary', () => ({ v2: { config: jest.fn(), uploader: { upload: jest.fn() } } }));

describe('deep Orders and Captain financial and stale-request regressions', () => {
  let server, origin, captainToken, environment, existsSpy, readSpy, consoleError;
  const basic = `Basic ${Buffer.from('deep-audit:isolated-password').toString('base64')}`;
  const originalItems = [{ lineId: 'sold-line', name: 'Soup', category: 'Soups', price: '₹100', quantity: 5 }];
  const menu = (loyalty = {}) => ({ items: [{ name: 'Soup', category: 'Soups', price: '₹100' }],
    loyalty: { enabled: true, spend: 10, earn: 1, pointValue: 1, ...loyalty } });

  async function request(path, method = 'GET', body, captain = false, headers = {}) {
    const response = await fetch(origin + path, { method, redirect: 'manual',
      headers: { ...(captain ? { 'X-Captain-Session': captainToken } : { Authorization: basic }),
        ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json() };
  }
  async function setMenu(value) {
    await mockDatabase.query('UPDATE website_content SET data=$1 WHERE id=$2', [JSON.stringify(value), 'air_menu_content']);
  }
  async function seed({ total = 500, redeemed = 0, discount = 0, version = '2026-10-10 02:03:04.123100+00' } = {}) {
    await mockDatabase.query(`INSERT INTO direct_orders (id,status,mode,customer_name,customer_phone,items,total,
      order_day,daily_order_number,table_area,table_number,fulfillment_type,loyalty_points_redeemed,discount_amount,
      loyalty_points_earned,updated_at) VALUES ('table-one','accepted','table','Guest','9876543210',$1,$2,
      (NOW() AT TIME ZONE 'Asia/Kolkata')::date,1,'AC',1,'dine_in',$3,$4,50,$5)`,
    [JSON.stringify(originalItems), total, redeemed, discount, version]);
  }
  const currentOrder = async () => (await request('/api/orders')).data.find((order) => order.id === 'table-one');
  const payload = (order) => ({ clientRequestId: 'workspace-request', tableOrderId: order.id,
    expectedUpdatedAt: order.order_version || order.updated_at, tableArea: 'AC', tableNumber: 1,
    action: 'save', items: order.items });
  const settle = () => request('/api/orders/table-one/settle', 'POST', { paymentType: 'cash', paymentReceived: 500 }, false,
    { 'X-Settlement-Id': 'isolated-settlement' });
  function pauseOwnerRead(fragment = 'SELECT o.id,o.mode') {
    let reached, release, paused = false;
    const ready = new Promise((resolve) => { reached = resolve; });
    const waiting = new Promise((resolve) => { release = resolve; });
    mockAfterQuery = async (query) => {
      if (!paused && query.includes(fragment)) { paused = true; reached(); await waiting; }
    };
    return { ready, release };
  }

  beforeAll(async () => {
    environment = { ...process.env };
    Object.assign(process.env, { NEON_DATABASE_URL: 'postgresql://isolated:isolated@localhost/isolated',
      ORDERS_USERNAME: 'deep-audit', ORDERS_PASSWORD: 'isolated-password',
      CAPTAIN_SESSION_SECRET: 'isolated-deep-audit-captain-secret',
      PUBLIC_CONTENT_CACHE_MS: '0', SECTION_CONTENT_CACHE_MS: '0', SLOW_REQUEST_MS: '600000' });
    const originalExists = fs.existsSync, originalRead = fs.readFileSync;
    existsSpy = jest.spyOn(fs, 'existsSync').mockImplementation((filename) =>
      String(filename).endsWith('/.env') ? false : originalExists(filename));
    readSpy = jest.spyOn(fs, 'readFileSync').mockImplementation((filename, ...options) => {
      if (String(filename).endsWith('/.env')) throw new Error('Tests must not read local credentials');
      return originalRead(filename, ...options);
    });
    consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockDatabase = new PGlite();
    await mockDatabase.waitReady;
    let app;
    jest.isolateModules(() => { app = require('./server'); });
    await app.prepareDatabase();
    await mockDatabase.exec(`CREATE TABLE IF NOT EXISTS loyalty_accounts (customer_phone TEXT PRIMARY KEY,
      points INTEGER NOT NULL DEFAULT 0 CHECK(points>=0),total_earned INTEGER NOT NULL DEFAULT 0,
      total_redeemed INTEGER NOT NULL DEFAULT 0,updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
      CREATE TABLE IF NOT EXISTS order_kot_round_status (order_id TEXT NOT NULL,kot_number INTEGER NOT NULL,
      printer_id TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'accepted',updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY(order_id,kot_number,printer_id));
      CREATE TABLE IF NOT EXISTS order_kot_station_status (order_id TEXT NOT NULL,printer_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'accepted',updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),PRIMARY KEY(order_id,printer_id));`);
    const captain = { id: 'deep-captain', name: 'Deep Captain', role: 'captain', active: true,
      areas: ['AC'], tableScope: 'all', pinHash: crypto.scryptSync('123456', 'captain:deep-captain', 64).toString('hex') };
    await mockDatabase.query('INSERT INTO website_content (id,data) VALUES ($1,$2),($3,$4)', [
      'air_menu_content', JSON.stringify(menu()), 'captain_content', JSON.stringify({ captains: [captain], settings: {} }),
    ]);
    await mockDatabase.query("INSERT INTO order_operations_config (config_key,config) VALUES ('default',$1) ON CONFLICT (config_key) DO UPDATE SET config=EXCLUDED.config", [
      JSON.stringify({ printers: [], routes: [], tableAreas: [{ name: 'AC', from: 1, to: 20 }] }),
    ]);
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
    captainToken = (await request('/api/captain/login', 'POST', { id: captain.id, pin: '123456' })).data.token;
    expect(captainToken).toBeTruthy();
    expect((await request('/api/orders/availability')).status).toBe(200);
  }, 30000);
  beforeEach(async () => {
    mockAfterQuery = null;
    mockDatabaseError = null;
    await mockDatabase.exec(`TRUNCATE direct_orders,order_events,order_payments,order_kots,order_kot_round_status,
      order_kot_station_status,captain_order_requests,loyalty_accounts,menu_availability,kitchen_order_courses,kitchen_production_tasks,kitchen_task_events,kitchen_service_events CASCADE`);
    await setMenu(menu());
  });
  afterAll(async () => {
    mockAfterQuery = null;
    if (server) await new Promise((resolve) => server.close(resolve));
    if (mockDatabase) await mockDatabase.close();
    expect(readSpy.mock.calls.some(([filename]) => String(filename).endsWith('/.env'))).toBe(false);
    existsSpy.mockRestore(); readSpy.mockRestore(); consoleError.mockRestore();
    process.env = environment;
  });

  test('order list exposes a lossless PostgreSQL revision for client snapshots', async () => {
    await seed();
    expect((await currentOrder()).order_version).toBe('2026-10-10T02:03:04.123100Z');
  });
  test.each(['workspace', 'quantities'])('same-millisecond revisions cannot overwrite newer items through %s', async (route) => {
    await seed();
    const order = await currentOrder();
    await mockDatabase.query("UPDATE direct_orders SET items=$1,total=600,updated_at='2026-10-10 02:03:04.123900+00'", [
      JSON.stringify([{ ...originalItems[0], quantity: 6 }]),
    ]);
    const result = route === 'workspace'
      ? await request('/api/orders/counter', 'POST', payload(order))
      : await request('/api/orders/table-one/items', 'PATCH', { quantities: [4], expectedUpdatedAt: order.order_version || order.updated_at });
    expect(result.status).toBe(409);
    expect(Number((await mockDatabase.query('SELECT total FROM direct_orders')).rows[0].total)).toBe(600);
  });
  test('a current lossless revision still permits a full-cart edit', async () => {
    await seed();
    const result = await request('/api/orders/counter', 'POST', payload(await currentOrder()));
    expect(result.status).toBe(201);
  });
  test.each(['workspace', 'quantities'])('additional units have new kitchen source IDs through %s', async route => {
    await seed();
    const order = await currentOrder();
    const body = payload(order);
    body.items[0].quantity = 6;
    const result = route === 'workspace'
      ? await request('/api/orders/counter', 'POST', body)
      : await request('/api/orders/table-one/items', 'PATCH', { quantities: [6], expectedUpdatedAt: order.order_version });
    expect({ status: result.status, databaseError: mockDatabaseError }).toEqual({ status: route === 'workspace' ? 201 : 200, databaseError: null });
    const saved = (await mockDatabase.query('SELECT items,total FROM direct_orders')).rows[0];
    expect(saved.items).toHaveLength(2);
    expect(saved.items[0]).toMatchObject({ lineId: 'sold-line', quantity: 5 });
    expect(saved.items[1]).toMatchObject({ name: 'Soup', quantity: 1, price: '₹100' });
    expect(saved.items[1].lineId).not.toBe('sold-line');
    expect(saved.items[1].orderedAt).toBeTruthy();
    expect(Number(saved.total)).toBe(600);
  });
  test('a reopened bill preserves more than thirty saved kitchen lines', async () => {
    await seed();
    const lines = Array.from({ length: 31 }, (_, index) => ({ ...originalItems[0], lineId: `line-${index}`, quantity: 1 }));
    await mockDatabase.query('UPDATE direct_orders SET items=$1,total=3100', [JSON.stringify(lines)]);
    expect((await request('/api/orders/counter', 'POST', payload(await currentOrder()))).status).toBe(201);
    expect((await mockDatabase.query('SELECT items FROM direct_orders')).rows[0].items).toHaveLength(31);
  });
  test.each(['workspace', 'quantities'])('legacy cooked source identity survives additions through %s', async route => {
    await seed();
    const { lineId, ...legacy } = originalItems[0];
    await mockDatabase.query('UPDATE direct_orders SET items=$1', [JSON.stringify([legacy])]);
    await mockDatabase.exec("INSERT INTO kitchen_production_tasks(task_id,order_id,source_line_id,requested_quantity,task_state) VALUES ('table-one:legacy-0','table-one','legacy-0',5,'ready')");
    const body = payload(await currentOrder()); body.items[0].quantity = 6;
    const result = route === 'workspace' ? await request('/api/orders/counter', 'POST', body)
      : await request('/api/orders/table-one/items', 'PATCH', { quantities: [6] });
    expect(result.status).toBe(route === 'workspace' ? 201 : 200);
    const saved = (await mockDatabase.query('SELECT items FROM direct_orders')).rows[0].items;
    expect(saved[0]).toMatchObject({ lineId: 'legacy-0', quantity: 5 });
    expect(saved[1]).toMatchObject({ quantity: 1 });
    expect(saved[1].lineId).not.toMatch(/^legacy-/);
    expect((await mockDatabase.query("SELECT task_state FROM kitchen_production_tasks WHERE task_id='table-one:legacy-0'")).rows[0].task_state).toBe('ready');
  });
  test('removing a preceding legacy item preserves the surviving source identity', async () => {
    await seed();
    const { lineId, ...legacy } = originalItems[0];
    await mockDatabase.query('UPDATE direct_orders SET items=$1,total=600', [JSON.stringify([{ ...legacy, quantity: 1, note: 'First' }, legacy])]);
    expect((await request('/api/orders/table-one/items', 'PATCH', { quantities: [0, 5] })).status).toBe(200);
    expect((await mockDatabase.query('SELECT items FROM direct_orders')).rows[0].items).toEqual([expect.objectContaining({ lineId: 'legacy-1', quantity: 5 })]);
  });
  test.each(['removed', 'out of stock'])('quantity editing cannot add more units of an item that is %s', async reason => {
    await seed();
    if (reason === 'removed') await setMenu({ ...menu(), items: [] });
    else {
      await request('/api/orders/availability');
      await mockDatabase.query("INSERT INTO menu_availability(item_key,unavailable_until) VALUES ('soups::soup',NOW()+INTERVAL '1 hour') ON CONFLICT(item_key) DO UPDATE SET unavailable_until=EXCLUDED.unavailable_until");
    }
    expect((await request('/api/orders/table-one/items', 'PATCH', { quantities: [6] })).status).toBe(409);
    expect(Number((await mockDatabase.query('SELECT total FROM direct_orders')).rows[0].total)).toBe(500);
    expect((await request('/api/orders/table-one/items', 'PATCH', { quantities: [4] })).status).toBe(200);
  });

  async function seedKitchen({ sharedSource = false } = {}) {
    await seed();
    const lines = [{ ...originalItems[0], quantity: 1 }, { ...originalItems[0], lineId: sharedSource ? 'sold-line' : 'added-line', quantity: 1 }];
    await mockDatabase.query('UPDATE direct_orders SET items=$1,total=200', [JSON.stringify(sharedSource ? [{ ...lines[0], quantity: 2 }] : lines)]);
    for (let index = 0; index < 2; index++) {
      await mockDatabase.query(`INSERT INTO order_kots (order_id,order_number,tickets,kot_day,daily_kot_number)
        VALUES ('table-one',1,$1,(NOW() AT TIME ZONE 'Asia/Kolkata')::date,$2)`, [
        JSON.stringify([{ printerId: 'kitchen', printerLabel: 'Kitchen', items: [lines[index]] }]), index + 1]);
      await mockDatabase.query("INSERT INTO order_kot_round_status(order_id,kot_number,printer_id,status) VALUES ('table-one',$1,'kitchen','accepted')", [index + 1]);
    }
    for (const lineId of new Set(lines.map(line => line.lineId)))
      await mockDatabase.query(`INSERT INTO kitchen_production_tasks (task_id,order_id,source_line_id,station_id,course_type,requested_quantity,task_state)
        VALUES ($1,'table-one',$2,'kitchen','starters',1,'ordered')`, [`task-${lineId}`, lineId]);
  }
  const kitchenUpdate = (round, status = 'ready', expectedStatus = 'accepted', printer = 'kitchen') =>
    request(`/api/orders/table-one/kitchen-status/${printer}`, 'PATCH', { kotNumber: round, status, expectedStatus });
  test('KDS exposes every active kitchen round for the same station', async () => {
    await seedKitchen();
    const result = await request('/api/orders/kitchen-statuses');
    expect(result.status).toBe(200);
    expect(result.data.map(row => Number(row.kot_number)).sort()).toEqual([1, 2]);
  });
  test('ready updates only its round and keeps the station pending until every round is ready', async () => {
    await seedKitchen();
    const result = await kitchenUpdate(1);
    expect({ status: result.status, databaseError: mockDatabaseError }).toEqual({ status: 200, databaseError: null });
    expect((await mockDatabase.query('SELECT source_line_id,task_state FROM kitchen_production_tasks ORDER BY source_line_id')).rows)
      .toEqual([{ source_line_id: 'added-line', task_state: 'ordered' }, { source_line_id: 'sold-line', task_state: 'ready' }]);
    expect((await mockDatabase.query('SELECT status FROM order_kot_station_status')).rows[0].status).toBe('accepted');
    expect((await kitchenUpdate(2)).status).toBe(200);
    expect((await mockDatabase.query('SELECT status FROM order_kot_station_status')).rows[0].status).toBe('ready');
  });
  test('invalid kitchen rounds and stations cannot create phantom status rows', async () => {
    await seedKitchen();
    expect((await kitchenUpdate(99)).status).toBe(404);
    expect((await kitchenUpdate(1, 'ready', 'accepted', 'unknown')).status).toBe(404);
    expect((await mockDatabase.query('SELECT * FROM order_kot_round_status')).rows).toHaveLength(2);
  });
  test('a historical KOT without IDs advances only retained legacy tasks, leaving new additions untouched', async () => {
    await seedKitchen();
    const first = { ...originalItems[0], lineId: 'legacy-0', quantity: 1 };
    const extra = { ...first, lineId: 'added-line' };
    await mockDatabase.query('UPDATE direct_orders SET items=$1', [JSON.stringify([first, extra])]);
    const { lineId, ...oldTicketLine } = first;
    await mockDatabase.query('UPDATE order_kots SET tickets=$1 WHERE daily_kot_number=1', [JSON.stringify([{ printerId: 'kitchen', items: [oldTicketLine] }])]);
    await mockDatabase.exec("UPDATE kitchen_production_tasks SET task_id='table-one:legacy-0',source_line_id='legacy-0' WHERE source_line_id='sold-line'");
    expect((await kitchenUpdate(1)).status).toBe(200);
    expect((await mockDatabase.query('SELECT source_line_id,task_state FROM kitchen_production_tasks ORDER BY source_line_id')).rows)
      .toEqual([{ source_line_id: 'added-line', task_state: 'ordered' }, { source_line_id: 'legacy-0', task_state: 'ready' }]);
    expect((await request('/api/captain/orders/table-one/kots/1/served', 'POST', {}, true)).status).toBe(200);
    expect((await mockDatabase.query('SELECT source_line_id,task_state FROM kitchen_production_tasks ORDER BY source_line_id')).rows)
      .toEqual([{ source_line_id: 'added-line', task_state: 'ordered' }, { source_line_id: 'legacy-0', task_state: 'served' }]);
  });
  test.each(['courseOverride', 'menuType'])('legacy KOT matching preserves distinct %s identities', async field => {
    await seedKitchen();
    const first = { ...originalItems[0], lineId: 'legacy-0', quantity: 1, [field]: field === 'menuType' ? 'food' : 'starter' };
    const other = { ...first, lineId: 'legacy-1', [field]: field === 'menuType' ? 'bar' : 'main' };
    await mockDatabase.query('UPDATE direct_orders SET items=$1', [JSON.stringify([first, other])]);
    const { lineId, ...ticket } = first;
    await mockDatabase.query('UPDATE order_kots SET tickets=$1 WHERE daily_kot_number=1', [JSON.stringify([{ printerId: 'kitchen', items: [ticket] }])]);
    await mockDatabase.exec(`DELETE FROM order_kots WHERE daily_kot_number=2; DELETE FROM order_kot_round_status WHERE kot_number=2;
      UPDATE kitchen_production_tasks SET source_line_id='legacy-0',course_type='starter' WHERE source_line_id='sold-line';
      UPDATE kitchen_production_tasks SET source_line_id='legacy-1',course_type='main' WHERE source_line_id='added-line'`);
    expect((await kitchenUpdate(1)).status).toBe(200);
    expect((await mockDatabase.query('SELECT source_line_id,task_state FROM kitchen_production_tasks ORDER BY source_line_id')).rows)
      .toEqual([{ source_line_id: 'legacy-0', task_state: 'ready' }, { source_line_id: 'legacy-1', task_state: 'ordered' }]);
    expect((await request('/api/captain/orders/table-one/kots/1/served', 'POST', {}, true)).status).toBe(200);
    expect((await mockDatabase.query('SELECT source_line_id,task_state FROM kitchen_production_tasks ORDER BY source_line_id')).rows)
      .toEqual([{ source_line_id: 'legacy-0', task_state: 'served' }, { source_line_id: 'legacy-1', task_state: 'ordered' }]);
  });
  test('kitchen updates reject stale transitions and do not regress ready or served tickets', async () => {
    await seedKitchen();
    expect((await kitchenUpdate(1, 'preparing', 'ready')).status).toBe(409);
    expect((await kitchenUpdate(1)).status).toBe(200);
    expect((await kitchenUpdate(1, 'preparing', 'ready')).status).toBe(409);
    await mockDatabase.exec("UPDATE order_kot_round_status SET status='served' WHERE kot_number=1");
    expect((await kitchenUpdate(1, 'ready', 'served')).status).toBe(409);
  });
  test('a settled order cannot receive a kitchen update validated against its old snapshot', async () => {
    await seedKitchen();
    const pause = pauseOwnerRead('SELECT o.id,o.items,o.mode');
    const pending = kitchenUpdate(1);
    await pause.ready;
    try { await mockDatabase.exec("UPDATE direct_orders SET status='completed',updated_at=NOW()"); }
    finally { pause.release(); }
    expect((await pending).status).toBe(409);
    expect((await mockDatabase.query('SELECT DISTINCT status FROM order_kot_round_status')).rows).toEqual([{ status: 'accepted' }]);
  });
  test('legacy shared kitchen source IDs wait for all containing rounds before becoming ready or served', async () => {
    await seedKitchen({ sharedSource: true });
    expect((await kitchenUpdate(1)).status).toBe(200);
    expect((await mockDatabase.query('SELECT task_state FROM kitchen_production_tasks')).rows[0].task_state).toBe('ordered');
    expect((await request('/api/captain/orders/table-one/kots/1/served', 'POST', {}, true)).status).toBe(200);
    expect((await mockDatabase.query('SELECT task_state FROM kitchen_production_tasks')).rows[0].task_state).toBe('ordered');
    expect((await kitchenUpdate(2)).status).toBe(200);
    expect((await mockDatabase.query('SELECT task_state FROM kitchen_production_tasks')).rows[0].task_state).toBe('ready');
    expect((await request('/api/captain/orders/table-one/kots/2/served', 'POST', {}, true)).status).toBe(200);
    expect((await mockDatabase.query('SELECT task_state FROM kitchen_production_tasks')).rows[0].task_state).toBe('served');
  });
  test.each([
    ['disabled', { enabled: false }],
    ['repriced', { pointValue: 2 }],
  ])('quantity edits preserve the sold wallet deduction when loyalty is %s', async (_, loyalty) => {
    await seed({ total: 430, redeemed: 20, discount: 50 });
    await setMenu(menu(loyalty));
    const result = await request('/api/orders/table-one/items', 'PATCH', { quantities: [4] });
    expect(result.status).toBe(200);
    expect(Number((await mockDatabase.query('SELECT total FROM direct_orders')).rows[0].total)).toBe(330);
  });
  test('full-cart saves preserve the monetary wallet deduction after point values change', async () => {
    await seed({ total: 430, redeemed: 20, discount: 50 });
    await setMenu(menu({ pointValue: 2 }));
    const result = await request('/api/orders/counter', 'POST', payload(await currentOrder()));
    expect(result.status).toBe(201);
    expect(result.data.total).toBe(430);
  });
  test('a fully discounted zero-value bill can settle and release its table', async () => {
    await seed();
    expect((await request('/api/orders/table-one/discount', 'POST', { type: 'fixed', value: 500, reason: 'Manager complimentary bill' })).status).toBe(200);
    const result = await request('/api/orders/table-one/settle', 'POST', { paymentType: 'cash', paymentReceived: 0 });
    expect(result.status).toBe(200);
    const order = (await mockDatabase.query('SELECT status,settlement_amount FROM direct_orders')).rows[0];
    expect(order.status).toBe('completed');
    expect(Number(order.settlement_amount)).toBe(0);
  });
  test('a settlement request ID cannot silently acknowledge different tender details', async () => {
    await seed();
    expect((await settle()).status).toBe(200);
    const changed = await request('/api/orders/table-one/settle', 'POST', { paymentType: 'upi', paymentReceived: 500 }, false,
      { 'X-Settlement-Id': 'isolated-settlement' });
    expect(changed.status).toBe(409);
    expect(changed.data.code).toBe('request_id_reused');
    expect((await settle()).data.duplicate).toBe(true);
    expect((await mockDatabase.query('SELECT payment_type FROM order_payments')).rows).toEqual([{ payment_type: 'cash' }]);
  });
  test('payment uses the reviewed client revision before accepting changed tender totals', async () => {
    await seed();
    const order = await currentOrder();
    await mockDatabase.exec("UPDATE direct_orders SET total=600,updated_at='2026-10-10 02:03:04.123900+00'");
    const changed = await request('/api/orders/table-one/settle', 'POST', {
      paymentType: 'upi', expectedUpdatedAt: order.order_version || order.updated_at,
    });
    expect(changed.status).toBe(409);
    expect(changed.data.code).toBe('bill_changed');
    expect((await mockDatabase.query('SELECT * FROM order_payments')).rows).toHaveLength(0);
  });
  test('a table moved to another area cannot receive an employee assignment validated against its old area', async () => {
    await seed();
    const pause = pauseOwnerRead('SELECT table_area,status');
    const pending = request('/api/orders/table-one/assignment', 'POST', { employeeId: 'deep-captain' });
    await pause.ready;
    try { await mockDatabase.exec("UPDATE direct_orders SET table_area='BAR',updated_at=NOW()"); }
    finally { pause.release(); }
    expect((await pending).status).toBe(409);
    expect((await mockDatabase.query('SELECT employee_assigned_id FROM direct_orders')).rows[0].employee_assigned_id).toBeNull();
  });
  test.each(['discount', 'move'])('a reviewed revision prevents stale %s requests from changing a newer bill', async (action) => {
    await seed();
    const order = await currentOrder();
    await mockDatabase.exec("UPDATE direct_orders SET updated_at='2026-10-10 02:03:04.123900+00'");
    const expectedUpdatedAt = order.order_version || order.updated_at;
    const result = action === 'discount'
      ? await request('/api/orders/table-one/discount', 'POST', { type: 'fixed', value: 50, reason: 'Guest offer', expectedUpdatedAt })
      : await request('/api/orders/table-one/table', 'PATCH', { tableArea: 'AC', tableNumber: 2, expectedUpdatedAt });
    expect(result.status).toBe(409);
    const saved = (await mockDatabase.query('SELECT table_number,total FROM direct_orders')).rows[0];
    expect(saved.table_number).toBe(1);
    expect(Number(saved.total)).toBe(500);
  });
  test.each(['service', 'served'])('Captain %s cannot mutate an order settled after its access snapshot', async (action) => {
    await seed();
    if (action === 'served')
      await mockDatabase.exec("INSERT INTO order_kot_round_status(order_id,kot_number,printer_id,status) VALUES ('table-one',1,'kitchen','ready')");
    const pause = pauseOwnerRead();
    const pending = action === 'service'
      ? request('/api/captain/orders/table-one/service', 'POST', { serviceState: 'water_requested' }, true)
      : request('/api/captain/orders/table-one/kots/1/served', 'POST', {}, true);
    await pause.ready;
    try { expect((await settle()).status).toBe(200); }
    finally { pause.release(); }
    expect((await pending).status).toBe(409);
    if (action === 'service')
      expect((await mockDatabase.query('SELECT service_state FROM direct_orders')).rows[0].service_state).not.toBe('water_requested');
    else
      expect((await mockDatabase.query('SELECT status FROM order_kot_round_status')).rows[0].status).toBe('ready');
  });
  test('Captain drafts, successive KOT rounds, service, discount, split settlement and Register reporting agree', async () => {
    const config = await request('/api/orders/operations', 'PUT', { config: {
      printers: [{ id: 'kitchen', name: 'Kitchen', deviceName: 'Test Queue', type: 'kot' }],
      routes: [{ id: 'soup-route', printerId: 'kitchen', category: 'Soups' }],
      tableAreas: [{ id: 'ac', name: 'AC', from: 1, to: 20 }],
    } });
    expect(config.status).toBe(200);
    const saved = await request('/api/orders/counter', 'POST', { source: 'captain', clientRequestId: 'complete-flow',
      tableArea: 'AC', tableNumber: 1, customerName: 'Flow Guest', customerPhone: '9876543210', action: 'save',
      items: [{ name: 'Soup', category: 'Soups', quantity: 1 }] }, true);
    expect(saved.status).toBe(201);
    const id = saved.data.id;
    expect((await request('/api/orders')).data.find(order => order.id === id).status).toBe('saved');
    const round1 = await request(`/api/orders/${id}/kots`, 'POST', {}, true);
    expect(round1.status).toBe(201);
    expect(round1.data.tickets[0].items[0].quantity).toBe(1);
    expect((await request(`/api/orders/${id}/kitchen-status/kitchen`, 'PATCH', {
      kotNumber: round1.data.kotNumber, status: 'preparing', expectedStatus: 'accepted',
    })).status).toBe(200);
    expect((await request(`/api/orders/${id}/kitchen-status/kitchen`, 'PATCH', {
      kotNumber: round1.data.kotNumber, status: 'ready', expectedStatus: 'preparing',
    })).status).toBe(200);
    expect((await request('/api/captain/ready-alerts', 'GET', undefined, true)).data.alerts)
      .toEqual(expect.arrayContaining([expect.objectContaining({ id, kot_number: Number(round1.data.kotNumber) })]));
    expect((await request(`/api/captain/orders/${id}/kots/${round1.data.kotNumber}/served`, 'POST', {}, true)).status).toBe(200);
    const first = (await request('/api/orders')).data.find(order => order.id === id);
    const added = await request('/api/orders/counter', 'POST', { ...payload(first), clientRequestId: 'complete-flow-addition',
      action: 'submit', items: [{ ...first.items[0], quantity: 2 }] });
    expect(added.status).toBe(201);
    const round2 = await request(`/api/orders/${id}/kots`, 'POST', {});
    expect(round2.status).toBe(201);
    expect(round2.data.tickets[0].items).toEqual([expect.objectContaining({ quantity: 1 })]);
    expect(round2.data.tickets[0].items[0].lineId).not.toBe(round1.data.tickets[0].items[0].lineId);
    expect((await request(`/api/orders/${id}/kitchen-status/kitchen`, 'PATCH', {
      kotNumber: round2.data.kotNumber, status: 'ready', expectedStatus: 'accepted',
    })).status).toBe(200);
    expect((await request(`/api/captain/orders/${id}/kots/${round2.data.kotNumber}/served`, 'POST', {}, true)).status).toBe(200);
    expect((await request(`/api/orders/${id}/discount`, 'POST', { type: 'fixed', value: 20, reason: 'Guest offer' })).status).toBe(200);
    const bill = (await request('/api/orders')).data.find(order => order.id === id);
    expect(Number(bill.total)).toBe(180);
    const payment = { expectedUpdatedAt: bill.order_version, payments: [
      { paymentType: 'cash', amount: 100, paymentReceived: 150 }, { paymentType: 'upi', amount: 80, paymentReceived: 80 },
    ] };
    const paid = await request(`/api/orders/${id}/settle`, 'POST', payment, false, { 'X-Settlement-Id': 'complete-flow-payment' });
    expect(paid.status).toBe(200);
    expect(paid.data).toMatchObject({ total: 180, changeDue: 50, outstanding: 0, settlementType: 'part' });
    expect((await request(`/api/orders/${id}/settle`, 'POST', payment, false, { 'X-Settlement-Id': 'complete-flow-payment' })).data.duplicate).toBe(true);
    const summary = await request('/api/register/summary');
    expect(summary.status).toBe(200);
    expect(summary.data.orders).toHaveLength(1);
    expect(summary.data.orders[0]).toMatchObject({ id, settlement_type: 'part', payments: [
      expect.objectContaining({ paymentType: 'cash', appliedAmount: 100, changeAmount: 50 }),
      expect.objectContaining({ paymentType: 'upi', appliedAmount: 80 }),
    ] });
    expect((await mockDatabase.query('SELECT COUNT(*)::integer AS count FROM order_payments WHERE order_id=$1', [id])).rows[0].count).toBe(2);
    expect((await request('/api/captain/ready-alerts', 'GET', undefined, true)).data.alerts).toEqual([]);
    expect((await request('/api/orders/counter', 'POST', { source: 'captain', clientRequestId: 'complete-flow-next-guest',
      tableArea: 'AC', tableNumber: 1, action: 'save', items: [{ name: 'Soup', category: 'Soups', quantity: 1 }] }, true)).status).toBe(201);
  });
});
