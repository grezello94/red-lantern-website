/** @jest-environment node */
const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
const nativeRequire = process.getBuiltinModule('module').createRequire(__filename);
const { PGlite } = nativeRequire('@electric-sql/pglite');

let mockDatabase;
function mockQuery(strings, ...values) {
  const text = typeof strings === 'string' ? strings
    : strings.reduce((result, part, index) => result + (index ? `$${index}` : '') + part, '');
  const params = (typeof strings === 'string' ? values[0] || [] : values).map((value) =>
    Object.prototype.toString.call(value) === '[object Date]' ? value.toISOString() : value);
  let pending;
  return { text, params,
    then(resolve, reject) {
      pending ||= mockDatabase.query(text, params).then((result) => result.rows);
      return pending.then(resolve, reject);
    },
    catch(reject) { return this.then(undefined, reject); },
  };
}
mockQuery.transaction = async (callback) => {
  const queries = callback(mockQuery);
  return mockDatabase.transaction(async (tx) => {
    const results = [];
    for (const query of queries) results.push((await tx.query(query.text, query.params)).rows);
    return results;
  });
};
jest.mock('@neondatabase/serverless', () => ({ neon: () => mockQuery, neonConfig: {} }));
jest.mock('web-push', () => ({ setVapidDetails: jest.fn(), sendNotification: jest.fn() }));
jest.mock('cloudinary', () => ({ v2: { config: jest.fn(), uploader: { upload: jest.fn() } } }));

describe('Kitchen caller with real order, profile and workflow SQL', () => {
  let server, origin, environment, existsSpy, readSpy, consoleError;
  const authorization = `Basic ${Buffer.from('caller-test:isolated-password').toString('base64')}`;
  const fish = { lineId: 'fish-line', name: 'King Fish Rawa Fry', category: 'Goan Fish', price: '₹300', quantity: 1 };
  const rice = { lineId: 'rice-line', name: 'Veg Fried Rice', category: 'Rice', price: '₹200', quantity: 1 };
  const fishKey = 'food::goan fish::king fish rawa fry';
  const riceKey = 'food::rice::veg fried rice';
  async function request(path, method = 'GET', body) {
    const response = await fetch(origin + path, { method,
      headers: { Authorization: authorization, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json() };
  }
  const board = () => request('/api/orders/smart-kds/recommendations');
  async function seed(id, items, minutesAgo = 0) {
    await mockDatabase.query(`INSERT INTO direct_orders (id,status,mode,fulfillment_type,course_mode,
      daily_order_number,customer_name,customer_phone,items,total,created_at,updated_at,order_day)
      VALUES ($1,'accepted','parcel','takeaway','as_ready',$2,'Test Guest','9876543210',$3,500,
      NOW()-($4::text||' minutes')::interval,NOW(),(NOW() AT TIME ZONE 'Asia/Kolkata')::date)`,
    [id, Number(id.replace(/\D/g, '')) || 1, JSON.stringify(items), minutesAgo]);
  }
  async function saveProfile(itemKey, values) {
    const result = await request('/api/admin/smart-kds/menu-profiles', 'PUT', {
      profiles: [{ itemKey, stationId: 'kitchen', ...values }],
    });
    expect(result.status).toBe(200);
  }

  beforeAll(async () => {
    environment = { ...process.env };
    Object.assign(process.env, { NEON_DATABASE_URL: 'postgresql://isolated:isolated@localhost/isolated',
      ADMIN_USERNAME: 'caller-test', ADMIN_PASSWORD: 'isolated-password',
      ORDERS_USERNAME: 'caller-test', ORDERS_PASSWORD: 'isolated-password',
      PUBLIC_CONTENT_CACHE_MS: '0', SECTION_CONTENT_CACHE_MS: '0', SMART_KDS_READ_CACHE_MS: '0',
      CAPTAIN_SESSION_SECRET: 'isolated-caller-captain-session', SLOW_REQUEST_MS: '600000' });
    const originalExists = fs.existsSync, originalRead = fs.readFileSync;
    existsSpy = jest.spyOn(fs, 'existsSync').mockImplementation((filename) =>
      String(filename).endsWith('/.env') ? false : originalExists(filename));
    readSpy = jest.spyOn(fs, 'readFileSync').mockImplementation((filename, ...options) => {
      if (String(filename).endsWith('/.env')) throw new Error('Caller tests must not read local credentials');
      return originalRead(filename, ...options);
    });
    consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockDatabase = new PGlite();
    await mockDatabase.waitReady;
    let app;
    jest.isolateModules(() => { app = require('./server'); });
    await app.prepareDatabase();
    await mockDatabase.query('INSERT INTO website_content (id,data) VALUES ($1,$2)', [
      'air_menu_content', JSON.stringify({ items: [fish, rice] }),
    ]);
    await mockDatabase.query('INSERT INTO website_content (id,data) VALUES ($1,$2)', [
      'captain_content', JSON.stringify({ captains: [{ id: 'caller-captain', name: 'Caller Captain',
        role: 'captain', active: true, areas: ['AC'], tableScope: 'all',
        pinHash: crypto.scryptSync('123456', 'captain:caller-captain', 64).toString('hex') }], settings: {} }),
    ]);
    await mockDatabase.query("INSERT INTO order_operations_config (config_key,config) VALUES ('default',$1) ON CONFLICT(config_key) DO UPDATE SET config=EXCLUDED.config", [
      JSON.stringify({ printers: [{ id: 'kitchen', name: 'Kitchen', type: 'kot' }],
        routes: [{ category: '*', printerId: 'kitchen' }], tableAreas: [{ name: 'AC', from: 1, to: 20 }] }),
    ]);
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
  }, 30000);
  beforeEach(async () => {
    await mockDatabase.exec(`TRUNCATE direct_orders,order_events,kitchen_order_courses,kitchen_production_tasks,
      kitchen_task_events,kitchen_service_events,kitchen_batches,kitchen_batch_allocations,
      kitchen_scheduler_decisions,kitchen_manual_overrides,menu_production_profiles,captain_order_requests CASCADE`);
    const config = await request('/api/admin/smart-kds/config', 'PUT', { config: { mode: 'manual', displayMode: 'smart' } });
    expect(config.status).toBe(200);
    expect((await request('/api/admin/smart-kds/menu-profiles')).status).toBe(200);
    await mockDatabase.exec("UPDATE kitchen_stations SET max_concurrent_tasks=1; UPDATE kitchen_station_state SET available_capacity=1");
  });
  afterAll(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (mockDatabase) await mockDatabase.close();
    expect(readSpy.mock.calls.some(([filename]) => String(filename).endsWith('/.env'))).toBe(false);
    existsSpy.mockRestore(); readSpy.mockRestore(); consoleError.mockRestore();
    process.env = environment;
  });

  test('a fish order immediately reaches the caller without claiming it has started', async () => {
    await seed('order-1', [fish]);
    const response = await board();
    expect(response.status).toBe(200);
    expect(response.data.recommendations).toHaveLength(1);
    expect(response.data.recommendations[0]).toMatchObject({ taskState: 'ordered' });
    expect(response.data.expediter.alerts.some((alert) => /fish|stock|thaw/i.test(alert.instruction || alert.message || ''))).toBe(true);
    expect((await mockDatabase.query('SELECT task_state,preparing_at FROM kitchen_production_tasks')).rows)
      .toEqual([expect.objectContaining({ task_state: 'ordered', preparing_at: null })]);
  });

  test('missed preparation stays red across polls and cooking feedback removes the missed-start signal', async () => {
    await saveProfile(riceKey, { prepTimeEstimate: 8, minPrepTime: 6, maxPrepTime: 10 });
    await seed('order-1', [rice], 30);
    const first = await board();
    expect(first.status).toBe(200);
    const task = first.data.recommendations[0];
    expect(task.expediter.signal).toBe('red');
    expect((await board()).data.recommendations[0].latestSafeStartAt).toBe(task.latestSafeStartAt);
    const action = { taskKey: task.taskKey, orderId: task.orderId, stationId: task.stationId, action: 'start' };
    expect((await request('/api/orders/smart-kds/actions', 'POST', action)).status).toBe(200);
    const started = (await board()).data.recommendations[0];
    expect(started.taskState).toBe('preparing');
    expect(started.preparingAt).toBeTruthy();
    expect(started.expediter.label).not.toMatch(/not started|missed start|unstarted/i);
    expect((await request('/api/orders/smart-kds/actions', 'POST', { ...action, action: 'ready' })).status).toBe(200);
    expect((await board()).data.recommendations[0].taskState).toBe('ready');
  });

  test.each(['ordered', 'eligible', 'scheduled', 'fired', 'preparing'])('staff can confirm food ready early from %s without inventing a start or serving it', async (state) => {
    await saveProfile(riceKey, { prepTimeEstimate: 8, minPrepTime: 6, maxPrepTime: 10 });
    await seed('order-1', [rice]);
    const task = (await board()).data.recommendations[0];
    expect(Date.parse(task.latestSafeStartAt)).toBeGreaterThan(Date.now());
    await mockDatabase.query(`UPDATE kitchen_production_tasks SET task_state=$1,
      fired_at=CASE WHEN $1 IN ('fired','preparing') THEN NOW() ELSE NULL END,
      preparing_at=CASE WHEN $1='preparing' THEN NOW() ELSE NULL END WHERE task_id=$2`, [state, task.taskKey]);
    const before = (await mockDatabase.query('SELECT fired_at,preparing_at,scheduled_at FROM kitchen_production_tasks WHERE task_id=$1', [task.taskKey])).rows[0];
    const stationBefore = (await mockDatabase.query("SELECT version FROM kitchen_station_state WHERE station_id='kitchen'")).rows[0].version;
    const action = { taskKey: task.taskKey, orderId: task.orderId, stationId: task.stationId, action: 'ready' };
    expect((await request('/api/orders/smart-kds/actions', 'POST', action))).toMatchObject({ status: 200, data: { status: 'ready' } });
    const actual = (await mockDatabase.query('SELECT task_state,fired_at,preparing_at,scheduled_at,ready_at,served_at FROM kitchen_production_tasks WHERE task_id=$1', [task.taskKey])).rows[0];
    expect(actual).toMatchObject({ task_state: 'ready', fired_at: before.fired_at, preparing_at: before.preparing_at, scheduled_at: before.scheduled_at, served_at: null });
    expect(actual.ready_at).toBeTruthy();
    const audit = (await mockDatabase.query("SELECT details FROM kitchen_task_events WHERE task_id=$1 AND event_type='manual-ready'", [task.taskKey])).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0].details).toMatchObject({ readyConfirmedWithoutRecordedStart: state !== 'preparing', confirmedReadyAt: actual.ready_at.toISOString() });
    expect((await mockDatabase.query("SELECT version FROM kitchen_station_state WHERE station_id='kitchen'")).rows[0].version).toBe(stationBefore);
    expect((await mockDatabase.query('SELECT COUNT(*)::int AS count FROM kitchen_service_events')).rows[0].count).toBe(0);
    expect((await board()).data.recommendations[0]).toMatchObject({ taskState: 'ready', readyAt: actual.ready_at.toISOString() });
    expect((await request('/api/orders/smart-kds/actions', 'POST', action)).status).toBe(409);
  });

  test('ready confirmation works for a task waiting for station capacity', async () => {
    await saveProfile(riceKey, { prepTimeEstimate: 8, minPrepTime: 6, maxPrepTime: 10 });
    await seed('order-1', [rice], 20);
    await seed('order-2', [rice], 19);
    const waiting = (await board()).data.recommendations.find((task) => task.capacityState === 'capacity-wait');
    expect(waiting).toBeTruthy();
    const action = { taskKey: waiting.taskKey, orderId: waiting.orderId, stationId: waiting.stationId, action: 'ready' };
    expect((await request('/api/orders/smart-kds/actions', 'POST', action)).status).toBe(200);
    const actual = (await mockDatabase.query('SELECT task_state,preparing_at,fired_at,ready_at,served_at FROM kitchen_production_tasks WHERE task_id=$1', [waiting.taskKey])).rows[0];
    expect(actual).toMatchObject({ task_state: 'ready', preparing_at: null, fired_at: null, served_at: null });
    expect(actual.ready_at).toBeTruthy();
  });

  test('ready on active cooking releases its slot immediately for the next task', async () => {
    await saveProfile(riceKey, { prepTimeEstimate: 8, minPrepTime: 6, maxPrepTime: 10 });
    await seed('order-1', [rice], 20);
    await seed('order-2', [rice], 19);
    const first = (await board()).data.recommendations.find((task) => task.capacityState === 'allocated');
    const action = { taskKey: first.taskKey, orderId: first.orderId, stationId: first.stationId, action: 'start' };
    expect((await request('/api/orders/smart-kds/actions', 'POST', action)).status).toBe(200);
    expect((await board()).data.expediter.stations[0].occupiedCapacity).toBe(1);
    expect((await request('/api/orders/smart-kds/actions', 'POST', { ...action, action: 'ready' })).status).toBe(200);
    const next = (await board()).data;
    expect(next.expediter.stations[0].occupiedCapacity).toBe(0);
    expect(next.recommendations.find((task) => task.orderId !== first.orderId).capacityState).toBe('allocated');
  });

  test('course-held ordered food can be confirmed ready while an explicit task hold still rejects it', async () => {
    await seed('order-1', [rice]);
    await mockDatabase.exec("UPDATE direct_orders SET mode='table',course_mode='manual_fire'");
    const task = (await board()).data.recommendations[0];
    expect(task.capacityState).toBe('manual-hold');
    const action = { taskKey: task.taskKey, orderId: task.orderId, stationId: task.stationId, action: 'ready' };
    expect((await request('/api/orders/smart-kds/actions', 'POST', action)).status).toBe(200);
    await mockDatabase.query("UPDATE kitchen_production_tasks SET task_state='held',ready_at=NULL WHERE task_id=$1", [task.taskKey]);
    expect((await request('/api/orders/smart-kds/actions', 'POST', action)).status).toBe(409);
    expect((await mockDatabase.query('SELECT task_state,ready_at FROM kitchen_production_tasks WHERE task_id=$1', [task.taskKey])).rows[0]).toEqual({ task_state: 'held', ready_at: null });
  });

  test('shadow mode, incorrect task identity, and terminal states reject ready confirmation', async () => {
    await seed('order-1', [rice]);
    const task = (await board()).data.recommendations[0];
    const action = { taskKey: task.taskKey, orderId: task.orderId, stationId: task.stationId, action: 'ready' };
    await request('/api/admin/smart-kds/config', 'PUT', { config: { mode: 'shadow', displayMode: 'smart' } });
    expect((await request('/api/orders/smart-kds/actions', 'POST', action)).status).toBe(409);
    await request('/api/admin/smart-kds/config', 'PUT', { config: { mode: 'manual', displayMode: 'smart' } });
    expect((await request('/api/orders/smart-kds/actions', 'POST', { ...action, stationId: 'different-station' })).status).toBe(404);
    expect((await request('/api/orders/smart-kds/actions', 'POST', { ...action, orderId: 'different-order' })).status).toBe(404);
    for (const state of ['ready', 'expo', 'served', 'cancelled', 'superseded']) {
      await mockDatabase.query('UPDATE kitchen_production_tasks SET task_state=$1 WHERE task_id=$2', [state, task.taskKey]);
      const response = await request('/api/orders/smart-kds/actions', 'POST', action);
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);
      expect((await mockDatabase.query('SELECT task_state FROM kitchen_production_tasks WHERE task_id=$1', [task.taskKey])).rows[0].task_state).toBe(state);
    }
    expect((await mockDatabase.query("SELECT COUNT(*)::int AS count FROM kitchen_task_events WHERE event_type='manual-ready'")).rows[0].count).toBe(0);
  });

  test('a busy station forecasts queued work without changing the service promise or starting it', async () => {
    await saveProfile(riceKey, { prepTimeEstimate: 8, minPrepTime: 6, maxPrepTime: 10 });
    await seed('order-1', [rice], 20);
    await seed('order-2', [rice], 19);
    await seed('order-3', [rice], 18);
    const first = await board();
    expect(first.status).toBe(200);
    const waiting = first.data.recommendations.filter((task) => task.action === 'wait-capacity');
    expect(waiting).toHaveLength(2);
    expect(first.data.expediter.load.activeOrders).toBe(3);
    expect(waiting.every((task) => task.expediter.startAt && task.expediter.readyAt)).toBe(true);
    expect((await mockDatabase.query("SELECT COUNT(*)::int AS count FROM kitchen_production_tasks WHERE task_state='preparing'")).rows[0].count).toBe(0);
    const second = await board();
    expect(second.data.recommendations.map((task) => task.targetServeAt))
      .toEqual(first.data.recommendations.map((task) => task.targetServeAt));
  });

  test('chef profile overrides survive menu knowledge and a held fish still gets a stock alert', async () => {
    await saveProfile(fishKey, { prepTimeEstimate: 27, minPrepTime: 25, maxPrepTime: 32,
      canPrePrep: false, requiresPreviousCourse: true });
    await seed('order-1', [fish]);
    await mockDatabase.exec("UPDATE direct_orders SET mode='table',course_mode='manual_fire'");
    const response = await board();
    expect(response.status).toBe(200);
    const task = response.data.recommendations[0];
    expect(task.profile).toMatchObject({ prepTimeEstimate: 27, maxPrepTime: 32, canPrePrep: false });
    expect(task.capacityState).toBe('manual-hold');
    expect(task.expediter.signal).not.toBe('green');
    expect(response.data.expediter.alerts.some((alert) => /fish|stock|thaw/i.test(alert.instruction || alert.message || ''))).toBe(true);
  });

  test('an approved bulk line splits into complete traceable batches and reserves one cooking slot', async () => {
    await saveProfile(riceKey, { prepTimeEstimate: 8, minPrepTime: 6, maxPrepTime: 10,
      batchable: true, batchGroupId: riceKey, maxBatchSize: 4, optimalBatchSize: 4, batchWindowSeconds: 0 });
    await seed('order-1', [{ ...rice, quantity: 9 }], 20);
    const response = await board();
    expect(response.status).toBe(200);
    expect(response.data.recommendations.map((task) => task.quantity)).toEqual([4, 4, 1]);
    expect(response.data.recommendations.every((task) => task.sourceLineId === rice.lineId)).toBe(true);
    const firstBatch = response.data.batches.find((batch) => batch.allocations.some((allocation) =>
      response.data.recommendations.some((task) => task.taskKey === allocation.taskKey && task.capacityState === 'allocated')));
    expect(firstBatch).toBeTruthy();
    const started = await request(`/api/orders/smart-kds/batches/${firstBatch.batchId}/start`, 'POST', { reason: 'Chef begins approved batch' });
    expect(started.status).toBe(200);
    expect(started.data.tasksStarted).toBe(firstBatch.allocations.length);
    const next = await board();
    expect(next.status).toBe(200);
    expect(next.data.expediter.stations[0].occupiedCapacity).toBe(1);
    expect(next.data.recommendations.filter((task) => task.taskState === 'ordered').every((task) => task.expediter.signal !== 'green')).toBe(true);
    const quantities = (await mockDatabase.query('SELECT SUM(requested_quantity)::int AS portions FROM kitchen_production_tasks')).rows[0];
    expect(quantities.portions).toBe(9);
  });

  test('untouched legacy defaults gain menu timing while an edited profile keeps the chef timing', async () => {
    await mockDatabase.exec(`UPDATE menu_production_profiles SET prep_time_estimate=28,min_prep_time=25,max_prep_time=38,
      course_type='main',parallel_capacity_cost=1,long_prep_item=false,can_pre_prep=false,can_hold_after_cooking=false,
      max_hold_time=0,profile_version=1,created_at='2026-10-01',updated_at='2026-10-01'
      WHERE item_key='${riceKey}'`);
    // Saving settings invalidates the same caches used after an operator edit.
    await request('/api/admin/smart-kds/config', 'PUT', { config: { mode: 'manual', displayMode: 'smart' } });
    const inferred = (await request('/api/admin/smart-kds/menu-profiles')).data.items.find((item) => item.itemKey === riceKey);
    expect(inferred.profile.prepTimeEstimate).toBeLessThan(28);
    await saveProfile(riceKey, { prepTimeEstimate: 23, minPrepTime: 21, maxPrepTime: 26 });
    const edited = (await request('/api/admin/smart-kds/menu-profiles')).data.items.find((item) => item.itemKey === riceKey);
    expect(edited.profile).toMatchObject({ prepTimeEstimate: 23, minPrepTime: 21, maxPrepTime: 26 });
  });

  test.each([false, true])('approved batches preserve chef notes (same note: %s)', async (sameNote) => {
    await saveProfile(riceKey, { prepTimeEstimate: 8, minPrepTime: 6, maxPrepTime: 10,
      batchable: true, batchGroupId: riceKey, maxBatchSize: 4, optimalBatchSize: 4, batchWindowSeconds: 0 });
    await seed('order-1', [{ ...rice, note: 'No onion' }], 20);
    await seed('order-2', [{ ...rice, note: sameNote ? 'No onion' : 'Extra chilli' }], 20);
    const response = await board();
    expect(response.status).toBe(200);
    expect(response.data.recommendations.every((task) => task.note)).toBe(true);
    expect(response.data.batches).toHaveLength(sameNote ? 1 : 2);
    expect(response.data.batches.every((batch) => new Set(batch.allocations.map((allocation) => allocation.note)).size === 1)).toBe(true);
    if (!sameNote) expect(response.data.batches.map((batch) => batch.totalQuantity)).toEqual([1, 1]);
    expect(response.data.expediter.calls.map((call) => call.instruction).join(' ')).toContain('No onion');
    if (sameNote) expect(response.data.batches[0].totalQuantity).toBe(2);
  });

  test('a new bulk order is actionable before the single-portion cooking window', async () => {
    await saveProfile(riceKey, { prepTimeEstimate: 8, minPrepTime: 6, maxPrepTime: 10, batchable: false });
    await seed('order-1', [{ ...rice, quantity: 30 }]);
    const response = await board();
    expect(response.status).toBe(200);
    const task = response.data.recommendations[0];
    expect(Date.parse(task.latestSafeStartAt)).toBeGreaterThan(Date.now());
    expect(Date.parse(task.effectiveLatestSafeStartAt)).toBeLessThan(Date.now());
    expect(task).toMatchObject({ baseAction: 'start-now', capacityState: 'allocated' });
    expect(task.expediter.cookingWaves).toBe(30);
    expect(task.expediter.instruction).toContain('30 conservative cooking waves');
    expect(task.expediter.signal).not.toBe('yellow');
  });

  test('yesterday\'s unresolved cooking cannot occupy today\'s kitchen station', async () => {
    await saveProfile(riceKey, { prepTimeEstimate: 8, minPrepTime: 6, maxPrepTime: 10 });
    await seed('order-1', [rice], 20);
    expect((await board()).status).toBe(200);
    await mockDatabase.exec("UPDATE kitchen_production_tasks SET task_state='preparing',preparing_at=NOW()-INTERVAL '1 day'; UPDATE direct_orders SET created_at=NOW()-INTERVAL '1 day',updated_at=NOW()-INTERVAL '1 day'");
    await seed('order-2', [rice], 20);
    await request('/api/admin/smart-kds/config', 'PUT', { config: { mode: 'manual', displayMode: 'smart' } });
    const response = await board();
    expect(response.status).toBe(200);
    expect(response.data.staleOrders).toHaveLength(1);
    expect(response.data.recommendations).toHaveLength(1);
    expect(response.data.recommendations[0]).toMatchObject({ orderId: 'order-2', capacityState: 'allocated' });
    expect(response.data.expediter.stations[0].occupiedCapacity).toBe(0);
    expect(response.data.expediter.calls.every((call) => !call.taskKeys.some((key) => key.startsWith('order-1:')))).toBe(true);
  });

  test('already cooking food appears once when its course is held in manual-fire mode', async () => {
    await saveProfile(riceKey, { prepTimeEstimate: 8, minPrepTime: 6, maxPrepTime: 10 });
    await seed('order-1', [rice], 20);
    expect((await board()).status).toBe(200);
    await mockDatabase.exec("UPDATE direct_orders SET mode='table',course_mode='manual_fire'; UPDATE kitchen_production_tasks SET task_state='preparing',preparing_at=NOW()");
    await request('/api/admin/smart-kds/config', 'PUT', { config: { mode: 'manual', displayMode: 'smart' } });
    const response = await board();
    expect(response.status).toBe(200);
    expect(response.data.recommendations).toHaveLength(1);
    expect(response.data.recommendations[0]).toMatchObject({ taskState: 'preparing' });
    expect(response.data.expediter.load.activePortions).toBe(1);
  });

  test('a newly submitted RUNNING item note gets the one free slot ahead of ordinary work and retains its chef note', async () => {
    await saveProfile(riceKey, { prepTimeEstimate: 8, minPrepTime: 6, maxPrepTime: 10 });
    await seed('order-1', [rice], 15);
    const note = 'RUNNING - extra portion';
    const created = await request('/api/orders/counter', 'POST', {
      clientRequestId: 'running-item-note-checkout', action: 'submit', mode: 'parcel', fulfillmentType: 'takeaway',
      customerName: 'Additional Portion', customerPhone: '9876543210', items: [{ ...rice, note }],
    });
    expect(created.status).toBe(201);
    const response = await board();
    expect(response.status).toBe(200);
    const running = response.data.recommendations.find((task) => task.orderId === created.data.id);
    const regular = response.data.recommendations.find((task) => task.orderId === 'order-1');
    expect(running).toMatchObject({ note, runningOrder: true, baseAction: 'start-now', capacityState: 'allocated', taskState: 'ordered' });
    expect(running.runningOrderReason).toMatch(/running|additional portion/i);
    expect(running.expediter.signal).toBe('green');
    expect(Date.parse(running.latestSafeStartAt)).toBeGreaterThan(Date.now());
    expect(response.data.recommendations.indexOf(running)).toBeLessThan(response.data.recommendations.indexOf(regular));
    expect(regular.capacityState).toBe('capacity-wait');
    expect(response.data.expediter.calls.find((call) => call.taskKeys?.includes(running.taskKey)).instruction).toContain(note);
    expect((await mockDatabase.query('SELECT items FROM direct_orders WHERE id=$1', [created.data.id])).rows[0].items[0].note).toBe(note);
    expect((await mockDatabase.query('SELECT preparing_at FROM kitchen_production_tasks WHERE task_id=$1', [running.taskKey])).rows[0].preparing_at).toBeNull();
  });

  test('legacy order special requests recognize case-insensitive standalone running without matching overrunning or runninglate', async () => {
    await saveProfile(riceKey, { prepTimeEstimate: 8, minPrepTime: 6, maxPrepTime: 10 });
    await seed('order-1', [{ ...rice, note: 'Overrunning delivery window' }]);
    await seed('order-2', [{ ...rice, note: 'runninglate' }]);
    await seed('order-3', [{ ...rice, note: '' }]);
    await mockDatabase.query('UPDATE direct_orders SET special_request=$1 WHERE id=$2', ['rUnNiNg, extra portion for this guest', 'order-3']);
    const response = await board();
    expect(response.status).toBe(200);
    expect(response.data.recommendations.find((task) => task.orderId === 'order-3'))
      .toMatchObject({ runningOrder: true, capacityState: 'allocated' });
    expect(response.data.recommendations.filter((task) => task.orderId !== 'order-3').every((task) => task.runningOrder === false)).toBe(true);
  });

  test('running priority waits for physically occupied capacity and never starts food automatically', async () => {
    await saveProfile(riceKey, { prepTimeEstimate: 8, minPrepTime: 6, maxPrepTime: 10 });
    await seed('order-1', [rice], 15);
    const active = (await board()).data.recommendations[0];
    expect((await request('/api/orders/smart-kds/actions', 'POST', {
      taskKey: active.taskKey, orderId: active.orderId, stationId: active.stationId, action: 'start',
    })).status).toBe(200);
    await seed('order-2', [{ ...rice, note: 'RUNNING - extra portion' }]);
    const response = await board();
    expect(response.status).toBe(200);
    const running = response.data.recommendations.find((task) => task.orderId === 'order-2');
    expect(running).toMatchObject({ runningOrder: true, taskState: 'ordered', capacityState: 'capacity-wait' });
    expect(running.expediter.signal).not.toBe('green');
    expect(Date.parse(running.expediter.startAt)).toBeGreaterThan(Date.now());
    expect((await request('/api/orders/smart-kds/actions', 'POST', {
      taskKey: running.taskKey, orderId: running.orderId, stationId: running.stationId, action: 'start',
    })).status).toBe(409);
    expect((await mockDatabase.query('SELECT task_state,preparing_at FROM kitchen_production_tasks WHERE task_id=$1', [running.taskKey])).rows[0])
      .toEqual({ task_state: 'ordered', preparing_at: null });
  });

  test('running chef notes respect manual course holds and are excluded after service', async () => {
    await seed('order-1', [{ ...rice, note: 'running - guest wants an additional portion' }]);
    await mockDatabase.exec("UPDATE direct_orders SET mode='table',course_mode='manual_fire'");
    const response = await board();
    expect(response.status).toBe(200);
    const running = response.data.recommendations[0];
    expect(running).toMatchObject({ runningOrder: true, capacityState: 'manual-hold', taskState: 'ordered' });
    expect(running.expediter.signal).not.toBe('green');
    expect(running.expediter.startAt).toBeNull();
    expect((await request('/api/orders/smart-kds/actions', 'POST', {
      taskKey: running.taskKey, orderId: running.orderId, stationId: running.stationId, action: 'start',
    })).status).toBe(409);
    await mockDatabase.query("UPDATE kitchen_production_tasks SET task_state='served',served_at=NOW() WHERE task_id=$1", [running.taskKey]);
    const served = await board();
    expect(served.status).toBe(200);
    expect(served.data.recommendations).toEqual([]);
    expect(served.data.expediter.calls).toEqual([]);
  });

  test('critical overdue work still receives the free slot before a running additional portion', async () => {
    await saveProfile(riceKey, { prepTimeEstimate: 8, minPrepTime: 6, maxPrepTime: 10 });
    await seed('order-1', [rice], 40);
    await seed('order-2', [{ ...rice, note: 'Running - extra portion' }]);
    const response = await board();
    expect(response.status).toBe(200);
    expect(response.data.recommendations.find((task) => task.orderId === 'order-1').capacityState).toBe('allocated');
    expect(response.data.recommendations.find((task) => task.orderId === 'order-2')).toMatchObject({ runningOrder: true, capacityState: 'capacity-wait' });
  });

  test('Captain running round notes apply only to their added lines, including a later round with an empty note', async () => {
    await saveProfile(riceKey, { prepTimeEstimate: 8, minPrepTime: 6, maxPrepTime: 10 });
    const login = await request('/api/captain/login', 'POST', { id: 'caller-captain', pin: '123456' });
    expect(login.status).toBe(200);
    const captainRequest = async (body) => {
      const response = await fetch(origin + '/api/orders/counter', { method: 'POST',
        headers: { 'X-Captain-Session': login.data.token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: 'captain', tableArea: 'AC', tableNumber: 1, action: 'submit', courseMode: 'as_ready', ...body }) });
      return { status: response.status, data: await response.json() };
    };
    const first = await captainRequest({ clientRequestId: 'running-round-original', specialRequest: 'No onion', items: [{ ...rice, note: '' }] });
    expect(first.status).toBe(201);
    const second = await captainRequest({ clientRequestId: 'running-round-additional', tableOrderId: first.data.id,
      specialRequest: 'RUNNING - extra portion', items: [{ ...rice, note: 'Extra chilli' }] });
    expect(second).toMatchObject({ status: 201, data: { continued: true, id: first.data.id } });
    const third = await captainRequest({ clientRequestId: 'running-round-later', tableOrderId: first.data.id,
      specialRequest: '', items: [{ ...rice, note: 'No salt' }] });
    expect(third.status).toBe(201);
    const stored = (await mockDatabase.query('SELECT items,special_request FROM direct_orders WHERE id=$1', [first.data.id])).rows[0];
    expect(stored.special_request).toContain('RUNNING');
    expect(stored.items.map((item) => item.orderNote)).toEqual(['No onion', 'RUNNING - extra portion', '']);
    const response = await board();
    expect(response.status).toBe(200);
    expect(response.data.recommendations).toHaveLength(3);
    const running = response.data.recommendations.find((task) => task.sourceLineId === stored.items[1].lineId);
    expect(running).toMatchObject({ runningOrder: true, orderNote: 'RUNNING - extra portion', note: 'Extra chilli', capacityState: 'allocated' });
    expect(response.data.recommendations.filter((task) => task !== running).every((task) => task.runningOrder === false)).toBe(true);
  });

  test('actual start and ready acknowledgements record one learning sample with the original recorded station load', async () => {
    await saveProfile(riceKey, { prepTimeEstimate: 8, minPrepTime: 6, maxPrepTime: 10 });
    await seed('order-1', [rice], 15);
    const task = (await board()).data.recommendations[0];
    const identity = { taskKey: task.taskKey, orderId: task.orderId, stationId: task.stationId };
    expect((await request('/api/orders/smart-kds/actions', 'POST', { ...identity, action: 'start' })).status).toBe(200);
    const startedEvent = (await mockDatabase.query("SELECT details FROM kitchen_task_events WHERE task_id=$1 AND event_type='manual-start'", [task.taskKey])).rows[0];
    expect(startedEvent.details.learningContext).toMatchObject({ itemKey: riceKey, quantity: 1, loadBand: 'quiet' });
    const startedAt = new Date(Date.now() - 10 * 60_000).toISOString();
    // Advance the physical observation, without sleeping or fabricating a
    // missing start. The saved context must match this exact cooking attempt.
    await mockDatabase.query('UPDATE kitchen_production_tasks SET preparing_at=$2 WHERE task_id=$1', [task.taskKey, startedAt]);
    await mockDatabase.query("UPDATE kitchen_task_events SET details=jsonb_set(details,'{learningContext,preparingAt}',to_jsonb($2::text)) WHERE task_id=$1 AND event_type='manual-start'", [task.taskKey, startedAt]);
    expect((await request('/api/orders/smart-kds/actions', 'POST', { ...identity, action: 'ready' })).status).toBe(200);
    const readyEvent = (await mockDatabase.query("SELECT details FROM kitchen_task_events WHERE task_id=$1 AND event_type='manual-ready'", [task.taskKey])).rows[0];
    expect(readyEvent.details.learningSample).toMatchObject({ itemKey: riceKey, quantity: 1, preparingAt: startedAt, loadBand: 'quiet' });
    expect(Date.parse(readyEvent.details.learningSample.readyAt) - Date.parse(startedAt)).toBeGreaterThanOrEqual(10 * 60_000);
    const response = await board();
    expect(response.status).toBe(200);
    expect(response.data.learning).toMatchObject({ qualifyingSamples: 1, learnedTasks: 0 });
    expect(response.data.recommendations[0].taskState).toBe('ready');
  });

  test('ready feedback without an actual recorded start never creates a learning sample', async () => {
    await seed('order-1', [rice]);
    const task = (await board()).data.recommendations[0];
    expect((await request('/api/orders/smart-kds/actions', 'POST', {
      taskKey: task.taskKey, orderId: task.orderId, stationId: task.stationId, action: 'ready',
    })).status).toBe(200);
    const event = (await mockDatabase.query("SELECT details FROM kitchen_task_events WHERE task_id=$1 AND event_type='manual-ready'", [task.taskKey])).rows[0];
    expect(event.details.readyConfirmedWithoutRecordedStart).toBe(true);
    expect(event.details.learningSample).toBeUndefined();
    expect((await board()).data.learning.qualifyingSamples).toBe(0);
  });

  test('holding and resuming cooking does not reuse its interrupted start as a learning sample', async () => {
    await saveProfile(riceKey, { prepTimeEstimate: 8, minPrepTime: 6, maxPrepTime: 10 });
    await seed('order-1', [rice], 15);
    const task = (await board()).data.recommendations[0];
    const identity = { taskKey: task.taskKey, orderId: task.orderId, stationId: task.stationId };
    expect((await request('/api/orders/smart-kds/actions', 'POST', { ...identity, action: 'start' })).status).toBe(200);
    const startedAt = new Date(Date.now() - 10 * 60_000).toISOString();
    await mockDatabase.query('UPDATE kitchen_production_tasks SET preparing_at=$2 WHERE task_id=$1', [task.taskKey, startedAt]);
    await mockDatabase.query("UPDATE kitchen_task_events SET details=jsonb_set(details,'{learningContext,preparingAt}',to_jsonb($2::text)) WHERE task_id=$1 AND event_type='manual-start'", [task.taskKey, startedAt]);
    for (const action of ['hold', 'resume']) {
      expect((await request('/api/orders/smart-kds/overrides', 'POST', { ...identity, action, reason: 'Guest pauses then resumes this dish' })).status).toBe(200);
    }
    expect((await request('/api/orders/smart-kds/actions', 'POST', { ...identity, action: 'ready' })).status).toBe(200);
    const event = (await mockDatabase.query("SELECT details FROM kitchen_task_events WHERE task_id=$1 AND event_type='manual-ready'", [task.taskKey])).rows[0];
    expect(event.details.learningSample).toBeUndefined();
    expect((await board()).data.learning.qualifyingSamples).toBe(0);
  });

  test('one approved Cook together task records an independent single-wave learning observation', async () => {
    await saveProfile(riceKey, { prepTimeEstimate: 8, minPrepTime: 6, maxPrepTime: 10,
      batchable: true, batchGroupId: riceKey, maxBatchSize: 4, optimalBatchSize: 4, batchWindowSeconds: 0 });
    await seed('order-1', [{ ...rice, quantity: 4 }], 20);
    const response = await board();
    expect(response.status).toBe(200);
    const task = response.data.recommendations[0];
    const batch = response.data.batches.find((entry) => entry.allocations.some((allocation) => allocation.taskKey === task.taskKey));
    expect(batch.allocations).toHaveLength(1);
    expect((await request(`/api/orders/smart-kds/batches/${batch.batchId}/start`, 'POST', { reason: 'Chef begins one approved cooking wave' })).status).toBe(200);
    const context = (await mockDatabase.query("SELECT details FROM kitchen_task_events WHERE task_id=$1 AND event_type='batch-start'", [task.taskKey])).rows[0].details.learningContext;
    expect(context).toMatchObject({ batchId: batch.batchId, batchTaskCount: 1, quantity: 4, cookingWaves: 1 });
    const startedAt = new Date(Date.now() - 10 * 60_000).toISOString();
    await mockDatabase.query('UPDATE kitchen_production_tasks SET preparing_at=$2 WHERE task_id=$1', [task.taskKey, startedAt]);
    await mockDatabase.query("UPDATE kitchen_task_events SET details=jsonb_set(details,'{learningContext,preparingAt}',to_jsonb($2::text)) WHERE task_id=$1 AND event_type='batch-start'", [task.taskKey, startedAt]);
    expect((await request('/api/orders/smart-kds/actions', 'POST', { taskKey: task.taskKey, orderId: task.orderId,
      stationId: task.stationId, action: 'ready' })).status).toBe(200);
    const completed = (await mockDatabase.query("SELECT details FROM kitchen_task_events WHERE task_id=$1 AND event_type='manual-ready'", [task.taskKey])).rows[0].details.learningSample;
    expect(completed).toMatchObject({ batchId: batch.batchId, batchTaskCount: 1, preparingAt: startedAt });
    expect((await board()).data.learning.qualifyingSamples).toBe(1);
  });

  test.each(['change-course', 'move-station'])('%s invalidates recorded starts for every sibling production chunk', async (action) => {
    await saveProfile(riceKey, { prepTimeEstimate: 8, minPrepTime: 6, maxPrepTime: 10,
      batchable: true, batchGroupId: riceKey, maxBatchSize: 2, optimalBatchSize: 2, batchWindowSeconds: 0 });
    await mockDatabase.exec("UPDATE kitchen_stations SET max_concurrent_tasks=2; UPDATE kitchen_station_state SET available_capacity=2");
    if (action === 'move-station') {
      await mockDatabase.exec("INSERT INTO kitchen_stations(station_id,station_name,enabled,max_concurrent_tasks) VALUES('wok','Wok',true,2) ON CONFLICT(station_id) DO UPDATE SET enabled=true,max_concurrent_tasks=2; INSERT INTO kitchen_station_state(station_id,available_capacity) VALUES('wok',2) ON CONFLICT(station_id) DO UPDATE SET available_capacity=2");
    }
    await seed('order-1', [{ ...rice, quantity: 3 }], 20);
    const initial = await board();
    expect(initial.status).toBe(200);
    expect(initial.data.recommendations).toHaveLength(2);
    const selected = initial.data.recommendations.find((task) => task.quantity === 2);
    const sibling = initial.data.recommendations.find((task) => task.quantity === 1);
    expect(selected.sourceLineId).toBe(sibling.sourceLineId);
    expect((await request('/api/orders/smart-kds/actions', 'POST', { taskKey: sibling.taskKey,
      orderId: sibling.orderId, stationId: sibling.stationId, action: 'start' })).status).toBe(200);
    const startedAt = new Date(Date.now() - 10 * 60_000).toISOString();
    await mockDatabase.query('UPDATE kitchen_production_tasks SET preparing_at=$2 WHERE task_id=$1', [sibling.taskKey, startedAt]);
    await mockDatabase.query("UPDATE kitchen_task_events SET details=jsonb_set(details,'{learningContext,preparingAt}',to_jsonb($2::text)) WHERE task_id=$1 AND event_type='manual-start'", [sibling.taskKey, startedAt]);
    const changed = await request('/api/orders/smart-kds/overrides', 'POST', {
      taskKey: selected.taskKey, orderId: selected.orderId, action, reason: 'Chef changes this split production line',
      ...(action === 'change-course' ? { course: 'starter' } : { stationId: 'wok' }),
    });
    expect(changed.status).toBe(200);
    const barriers = (await mockDatabase.query("SELECT task_id FROM kitchen_task_events WHERE order_id=$1 AND event_type='learning-context-invalidated'", [selected.orderId])).rows;
    expect(barriers.map((event) => event.task_id).sort()).toEqual([selected.taskKey, sibling.taskKey].sort());
    const current = (await board()).data.recommendations.find((task) => task.taskKey === sibling.taskKey);
    expect(current.taskState).toBe('preparing');
    expect(action === 'change-course' ? current.course : current.stationId).toBe(action === 'change-course' ? 'starter' : 'wok');
    expect((await request('/api/orders/smart-kds/actions', 'POST', { taskKey: current.taskKey,
      orderId: current.orderId, stationId: current.stationId, action: 'ready' })).status).toBe(200);
    const completed = (await mockDatabase.query("SELECT details FROM kitchen_task_events WHERE task_id=$1 AND event_type='manual-ready'", [sibling.taskKey])).rows[0];
    expect(completed.details.learningSample).toBeUndefined();
    expect((await board()).data.learning.qualifyingSamples).toBe(0);
  });

  test('five recorded samples per load band adapt the live forecast without changing chef profiles or saved service promises', async () => {
    await saveProfile(riceKey, { prepTimeEstimate: 8, minPrepTime: 6, maxPrepTime: 10 });
    for (const loadBand of ['quiet', 'busy']) {
      for (let index = 0; index < 5; index += 1) {
        const preparingAt = new Date(Date.now() - (120 + index * 30) * 60_000).toISOString();
        const readyAt = new Date(Date.parse(preparingAt) + (loadBand === 'quiet' ? 8 + index : 18 + index) * 60_000).toISOString();
        const learningSample = { itemKey: riceKey, itemName: rice.name, category: rice.category, stationId: 'kitchen',
          portion: '', style: '', modifiers: [], note: '', orderNote: '', quantity: 1, cookingWaves: 1,
          profile: { prepTimeEstimate: 8, minPrepTime: 6, maxPrepTime: 10, platingTime: 2, handoffBuffer: 2, batchable: false },
          loadBand, preparingAt, readyAt };
        await mockDatabase.query("INSERT INTO kitchen_task_events(task_id,order_id,event_type,details) VALUES($1,$2,'manual-ready',$3)",
          [`history-${loadBand}-${index}`, `history-${loadBand}-${index}`, JSON.stringify({ learningSample })]);
      }
    }
    await seed('order-1', [rice]);
    const quiet = await board();
    expect(quiet.status).toBe(200);
    const quietTask = quiet.data.recommendations[0];
    expect(quietTask.learning).toMatchObject({ applied: true, sampleCount: 5, loadBand: 'quiet' });
    for (let index = 2; index <= 3; index += 1) {
      const created = await request('/api/orders/counter', 'POST', { clientRequestId: `learning-load-order-${index}`,
        action: 'submit', mode: 'parcel', fulfillmentType: 'takeaway', customerName: 'Load Test Guest',
        customerPhone: '9876543210', items: [rice] });
      expect(created.status).toBe(201);
    }
    const busy = await board();
    expect(busy.status).toBe(200);
    const busyTask = busy.data.recommendations.find((task) => task.orderId === 'order-1');
    expect(busy.data.recommendations).toHaveLength(3);
    expect(busyTask.learning).toMatchObject({ applied: true, sampleCount: 5, loadBand: 'busy' });
    expect(busyTask.learning.estimateMinutes).toBeGreaterThan(quietTask.learning.estimateMinutes);
    expect(busyTask.targetServeAt).toBe(quietTask.targetServeAt);
    expect(busyTask.latestSafeStartAt).toBe(quietTask.latestSafeStartAt);
    expect(Date.parse(busyTask.effectiveLatestSafeStartAt)).toBeLessThan(Date.parse(quietTask.effectiveLatestSafeStartAt));
    expect(busyTask.profile).toMatchObject({ prepTimeEstimate: 8, minPrepTime: 6, maxPrepTime: 10 });
    expect((await mockDatabase.query("SELECT COUNT(*)::int AS count FROM kitchen_production_tasks WHERE preparing_at IS NOT NULL")).rows[0].count).toBe(0);
    expect(busy.data.learning).toMatchObject({ qualifyingSamples: 10, learnedTasks: 3 });
  });
});
