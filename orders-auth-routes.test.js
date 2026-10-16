/** @jest-environment node */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const mockCaptainConfig = {
  settings: { idleMinutes: 15 },
  captains: [
    { id: 'Captain-A', name: 'Captain A', username: 'captain-a', role: 'captain', active: true, areas: ['AC'], tableScope: 'own' },
    { id: 'Driver-A', name: 'Driver A', username: 'driver-a', role: 'delivery', active: true, areas: [], tableScope: 'own' },
  ],
};
const mockOrders = [
  { id: 'MiXeD-Order', mode: 'table', table_area: 'AC', table_number: 1, captain_id: 'Captain-A', status: 'accepted' },
  { id: 'MiXeD-Other', mode: 'table', table_area: 'AC', table_number: 2, captain_id: 'Someone-Else', status: 'accepted' },
  { id: 'Part/Case', mode: 'table', table_area: 'AC', table_number: 3, captain_id: 'Captain-A', status: 'accepted' },
];
// Exercise real HTTP middleware without loading local credentials or reaching
// any external database, cloud upload, or push notification service.
const mockSql = jest.fn(async (strings, ...values) => {
  const query = typeof strings === 'string' ? strings : strings.join('$');
  if (query.includes('SELECT data FROM website_content'))
    return [{ data: values[0] === 'captain_content' ? mockCaptainConfig : {} }];
  if (query.includes('FROM direct_orders o WHERE o.id='))
    return mockOrders.filter((order) => order.id === values[0]);
  return [];
});
jest.mock('@neondatabase/serverless', () => ({ neon: () => mockSql, neonConfig: {} }));
jest.mock('web-push', () => ({ setVapidDetails: jest.fn(), sendNotification: jest.fn() }));
jest.mock('cloudinary', () => ({ v2: { config: jest.fn(), uploader: { upload: jest.fn() } } }));

describe('Orders and Captain route authentication variants', () => {
  let server, origin, ordersCookie, captainCookie, driverCookie, temporaryUploads, existsSpy, readSpy;
  const environment = new Map();
  const username = 'orders-route-fixture';
  const password = 'fixture-password-with-no-production-access';
  const basic = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;

  async function request(requestPath, { method = 'GET', body, cookie, headers = {} } = {}) {
    const response = await fetch(origin + requestPath, {
      method,
      redirect: 'manual',
      headers: {
        ...(cookie ? { Cookie: cookie } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, headers: response.headers, text: await response.text() };
  }

  async function employeeLogin(employeeUsername) {
    const result = await request('/api/orders/session', {
      method: 'POST', body: { username: employeeUsername, password: '1234' },
    });
    expect(result.status).toBe(200);
    return result.headers.get('set-cookie').split(';')[0];
  }

  beforeAll(async () => {
    const originalExists = fs.existsSync;
    const originalRead = fs.readFileSync;
    existsSpy = jest.spyOn(fs, 'existsSync').mockImplementation((filename) =>
      path.basename(String(filename)) === '.env' ? false : originalExists(filename)
    );
    readSpy = jest.spyOn(fs, 'readFileSync').mockImplementation((filename, ...options) => {
      if (path.basename(String(filename)) === '.env') throw new Error('Tests must not read .env');
      return originalRead(filename, ...options);
    });
    temporaryUploads = fs.mkdtempSync(path.join(os.tmpdir(), 'red-lantern-orders-auth-'));
    const fixtures = {
      ORDERS_USERNAME: username,
      ORDERS_PASSWORD: password,
      ORDERS_SESSION_SECRET: 'fixture-orders-session-secret',
      CAPTAIN_SESSION_SECRET: 'fixture-captain-session-secret',
      NEON_DATABASE_URL: 'postgresql://fixture:fixture@localhost/fixture',
      UPLOADS_DIR: temporaryUploads,
    };
    Object.entries(fixtures).forEach(([key, value]) => {
      environment.set(key, process.env[key]);
      process.env[key] = value;
    });
    for (const employee of mockCaptainConfig.captains)
      employee.pinHash = crypto.scryptSync('1234', `captain:${employee.id}`, 64).toString('hex');
    let app;
    jest.isolateModules(() => { app = require('./server'); });
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
    const login = await request('/api/orders/session', { method: 'POST', body: { username, password } });
    expect(login.status).toBe(200);
    ordersCookie = login.headers.get('set-cookie').split(';')[0];
    captainCookie = await employeeLogin('captain-a');
    driverCookie = await employeeLogin('driver-a');
  });

  beforeEach(() => mockSql.mockClear());

  afterAll(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    expect(readSpy.mock.calls.some(([filename]) => path.basename(String(filename)) === '.env')).toBe(false);
    readSpy.mockRestore();
    existsSpy.mockRestore();
    fs.rmSync(temporaryUploads, { recursive: true, force: true });
    environment.forEach((value, key) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    });
  });

  test.each([
    ['/orders', '/orders'],
    ['/Orders/', '/orders'],
    ['/ORDERS.HTML/', '/orders.html'],
    ['/%6frders.html', '/orders.html'],
    ['/%2forders.html', '/orders.html'],
    ['/unused%2f..%2forders.html', '/orders.html'],
    ['/REGISTER/', '/register'],
    ['/KDS/', '/kds'],
    ['/SMART-KDS/', '/smart-kds'],
    ['/KITCHEN-DISPLAY/', '/kitchen-display'],
  ])('anonymous GET %s requires sign-in before protected content is served', async (variant, destination) => {
    const result = await request(`${variant}?view=table%20orders`);
    expect(result.status).toBe(302);
    const location = new URL(result.headers.get('location'), origin);
    expect(location.pathname).toBe('/staff-login');
    expect(location.searchParams.get('scope')).toBe('orders');
    expect(location.searchParams.get('next')).toBe(`${destination}?view=table%20orders`);
    expect(mockSql).not.toHaveBeenCalled();
  });

  test.each(['/Orders/', '/REGISTER/'])('anonymous HEAD %s also requires sign-in', async (variant) => {
    const result = await request(variant, { method: 'HEAD' });
    expect(result.status).toBe(302);
    expect(result.headers.get('location')).toMatch(/^\/staff-login\?scope=orders&next=/);
    expect(result.text).toBe('');
    expect(mockSql).not.toHaveBeenCalled();
  });

  test.each([
    ['GET', '/API/ORDERS/'],
    ['GET', '/Api/Register/Summary/'],
    ['GET', '/API/STAFF/EMPLOYEES/'],
    ['POST', '/API/ORDERS/COUNTER/'],
    ['POST', '/API/ORDERS/Example/SETTLE/'],
    ['PUT', '/api/orders/availability/..%2F..%2F..%2Fpublic'],
    ['PATCH', '/API/ORDERS/..%2F..%2Fstaff-login'],
    ['PATCH', '/api/orders/Order-ID%2F..%2Fsession'],
    ['GET', '/api/orders/session/extra'],
  ])('anonymous %s %s is rejected before a data handler runs', async (method, variant) => {
    const result = await request(variant, { method });
    expect(result.status).toBe(401);
    expect(JSON.parse(result.text).code).toBe('staff_auth_required');
    expect(mockSql).not.toHaveBeenCalled();
  });

  test.each(['/ORDERS.JS/', '/%6frders.js', '/REGISTER.CSS/'])('protected asset %s requires sign-in', async (variant) => {
    const result = await request(variant);
    expect(result.status).toBe(401);
    expect(mockSql).not.toHaveBeenCalled();
  });

  test.each(['/order', '/ORDER/', '/%6frder'])('%s redirects to Orders and preserves the query', async (variant) => {
    const result = await request(`${variant}?table=AC%201&view=billing`);
    expect(result.status).toBe(302);
    expect(result.headers.get('location')).toBe('/orders?table=AC%201&view=billing');
    const destination = await request(result.headers.get('location'));
    expect(destination.status).toBe(302);
    expect(destination.headers.get('location')).toMatch(/^\/staff-login\?scope=orders&next=/);
    expect(mockSql).not.toHaveBeenCalled();
  });

  test('legacy login and logout routes remain public with case and trailing slash variants', async () => {
    const login = await request('/API/ORDERS/SESSION/', {
      method: 'POST', body: { username, password, next: '/ORDERS/?view=table%20orders#billing' },
    });
    expect(login.status).toBe(200);
    expect(JSON.parse(login.text).next).toBe('/orders?view=table%20orders#billing');
    expect(login.headers.get('set-cookie')).toMatch(/^rl_orders_session=/);
    const logout = await request('/API/ORDERS/SESSION/', { method: 'DELETE' });
    expect(logout.status).toBe(200);
    expect(logout.headers.get('set-cookie')).toMatch(/^rl_orders_session=;/);
  });

  test.each([
    { cookie: () => ordersCookie },
    { headers: { Authorization: basic } },
  ])('legacy credentials authorize uppercase API paths', async (options) => {
    const result = await request('/API/ORDERS/__auth_probe__/', {
      ...options, ...(options.cookie ? { cookie: options.cookie() } : {}),
    });
    expect(result.status).toBe(404);
    expect(mockSql).not.toHaveBeenCalled();
  });

  test.each(['/ORDERS/', '/ORDERS.HTML/', '/%6frders.html'])('Captain employees cannot enter billing pages via %s', async (variant) => {
    const result = await request(variant, { cookie: captainCookie });
    expect(result.status).toBe(302);
    expect(result.headers.get('location')).toBe('/staff?denied=billingConsole');
  });

  test('non-Captain employees cannot reach Captain APIs through case variants', async () => {
    const result = await request('/API/CAPTAIN/MENU-INSIGHTS/', { cookie: driverCookie });
    expect(result.status).toBe(403);
    expect(JSON.parse(result.text).error).toContain('Captain workspace');
  });

  test('expired employee credentials cannot bypass an uppercase Orders API', async () => {
    const result = await request('/API/ORDERS/', { cookie: 'rl_employee_session=invalid' });
    expect(result.status).toBe(401);
    expect(JSON.parse(result.text).error).toContain('expired or was revoked');
    expect(mockSql).not.toHaveBeenCalled();
  });
  test('queued mutations stay bound to the employee who prepared them', async () => {
    const result = await request('/API/ORDERS/COUNTER/', {
      method: 'POST', cookie: driverCookie, body: { actorEmployeeId: 'Captain-A' },
    });
    expect(result.status).toBe(403);
    expect(JSON.parse(result.text).code).toBe('employee_session_changed');
    const legacy = await request('/API/ORDERS/COUNTER/', {
      method: 'POST', headers: { Authorization: basic }, body: { actorEmployeeId: 'Captain-A' },
    });
    expect(legacy.status).toBe(401);
    expect(JSON.parse(legacy.text).code).toBe('employee_session_changed');
    const matching = await request('/API/STAFF/__actor_probe__/', {
      method: 'POST', cookie: captainCookie, body: { actorEmployeeId: 'Captain-A' },
    });
    expect(matching.status).toBe(404);
  });

  test('restricted employee permissions also apply to uppercase mutation routes', async () => {
    const result = await request('/API/ORDERS/MiXeD-Order/SETTLE/', {
      method: 'POST', cookie: captainCookie, body: { paymentType: 'cash', amount: 100 },
    });
    expect(result.status).toBe(403);
    expect(JSON.parse(result.text).code).toBe('employee_permission_denied');
    expect(JSON.parse(result.text).error).toContain('Collect and settle payments');
  });

  test.each(['MiXeD-Order', 'Part%2FCase'])('allowed order IDs retain their original case and encoded parameters: %s', async (orderId) => {
    const result = await request(`/API/ORDERS/${orderId}/KOTS/`, { cookie: captainCookie });
    expect(result.status).toBe(200);
    expect(JSON.parse(result.text)).toEqual([]);
    const accessLookup = mockSql.mock.calls.find(([strings]) => strings.join('$').includes('FROM direct_orders o WHERE o.id='));
    expect(accessLookup[1]).toBe(decodeURIComponent(orderId));
  });

  test('uppercase KOT routes still enforce the employee order scope', async () => {
    const result = await request('/API/ORDERS/MiXeD-Other/KOTS/', { cookie: captainCookie });
    expect(result.status).toBe(403);
    expect(JSON.parse(result.text).error).toContain('outside your assigned access');
    expect(mockSql.mock.calls.some(([strings]) => strings.join('$').includes('FROM order_kots WHERE order_id='))).toBe(false);
  });

  test('normalized employee session and Captain sign-in routes remain public', async () => {
    const session = await request('/API/STAFF/SESSION/', { cookie: captainCookie });
    expect(session.status).toBe(200);
    expect(JSON.parse(session.text).employee.id).toBe('Captain-A');
    const login = await request('/API/CAPTAIN/LOGIN/', {
      method: 'POST', body: { id: 'Captain-A', pin: '1234' },
    });
    expect(login.status).toBe(200);
    expect(JSON.parse(login.text).captain.id).toBe('Captain-A');
    const accounts = await request('/API/CAPTAIN/ACCOUNTS/');
    expect(accounts.status).toBe(200);
    expect(JSON.parse(accounts.text).captains.map((employee) => employee.id)).toEqual(['Captain-A']);
  });
});
