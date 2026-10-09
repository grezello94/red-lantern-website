/** @jest-environment node */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

// HTTP requests exercise the real middleware and static routes. Nothing may
// reach a real database, cloud upload, push service, or local credentials file.
const mockSql = jest.fn(async () => []);
jest.mock('@neondatabase/serverless', () => ({ neon: () => mockSql, neonConfig: {} }));
jest.mock('web-push', () => ({ setVapidDetails: jest.fn(), sendNotification: jest.fn() }));
jest.mock('cloudinary', () => ({ v2: { config: jest.fn(), uploader: { upload: jest.fn() } } }));

describe('Admin routes, login destinations, and asset freshness', () => {
  let server, origin, cookie, temporaryUploads, existsSpy, readSpy;
  const environment = new Map();
  const username = 'admin-route-fixture';
  const password = 'fixture-password-with-no-production-access';
  const basic = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;

  async function request(requestPath, { method = 'GET', body, authenticated = false, headers = {} } = {}) {
    const response = await fetch(origin + requestPath, {
      method,
      redirect: 'manual',
      headers: {
        ...(authenticated ? { Cookie: cookie } : {}),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, headers: response.headers, text: await response.text() };
  }

  async function login(next = '/admin', requestPath = '/api/admin/session') {
    const result = await request(requestPath, { method: 'POST', body: { username, password, next } });
    expect(result.status).toBe(200);
    return { ...result, data: JSON.parse(result.text) };
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
    temporaryUploads = fs.mkdtempSync(path.join(os.tmpdir(), 'red-lantern-admin-auth-'));
    const fixtures = {
      ADMIN_USERNAME: username,
      ADMIN_PASSWORD: password,
      ADMIN_SESSION_SECRET: 'fixture-admin-session-secret',
      NEON_DATABASE_URL: 'postgresql://fixture:fixture@localhost/fixture',
      UPLOADS_DIR: temporaryUploads,
    };
    Object.entries(fixtures).forEach(([key, value]) => {
      environment.set(key, process.env[key]);
      process.env[key] = value;
    });
    let app;
    jest.isolateModules(() => { app = require('./server'); });
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
    cookie = (await login()).headers.get('set-cookie').split(';')[0];
  });

  beforeEach(() => mockSql.mockClear());

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
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
    ['/admin', '/admin'],
    ['/admin/', '/admin'],
    ['/ADMIN/', '/admin'],
    ['/Admin.HTML/', '/admin'],
    ['/admin%2ehtml', '/admin'],
    ['/%61dmin', '/admin'],
    ['/dashboard', '/dashboard'],
    ['/dashboard/', '/dashboard'],
    ['/Dashboard', '/dashboard'],
    ['/DASHBOARD.HTML/', '/dashboard'],
  ])('anonymous GET %s requires login before any private HTML is served', async (variant, canonical) => {
    const result = await request(`${variant}?view=staff%20access`);
    expect(result.status).toBe(302);
    const location = new URL(result.headers.get('location'), origin);
    expect(location.pathname).toBe('/staff-login');
    expect(location.searchParams.get('scope')).toBe('admin');
    expect(location.searchParams.get('next')).toBe(`${canonical}?view=staff%20access`);
    expect(result.text).not.toContain('admin-workspace-bar');
    expect(result.headers.get('cache-control')).toContain('no-store');
    expect(mockSql).not.toHaveBeenCalled();
  });

  test.each(['/ADMIN/', '/dashboard/', '/Admin.HTML/'])('anonymous HEAD %s also requires login', async (variant) => {
    const result = await request(variant, { method: 'HEAD' });
    expect(result.status).toBe(302);
    expect(result.headers.get('location')).toMatch(/^\/staff-login\?scope=admin&next=/);
    expect(result.text).toBe('');
    expect(mockSql).not.toHaveBeenCalled();
  });

  test.each([
    ['GET', '/API/ADMIN/CONTENT/'],
    ['GET', '/Api/Admin/Health/'],
    ['POST', '/API/UPDATE-HOME/'],
    ['POST', '/API/GROWTH-AI/'],
    ['GET', '/api/admin/session/extra'],
  ])('anonymous %s %s cannot reach protected API handlers', async (method, variant) => {
    const result = await request(variant, { method });
    expect(result.status).toBe(401);
    expect(JSON.parse(result.text).code).toBe('admin_auth_required');
    expect(result.headers.get('cache-control')).toContain('no-store');
    expect(mockSql).not.toHaveBeenCalled();
  });

  test.each(['/admin-cms.js', '/ADMIN-CMS.JS/', '/%61dmin-cms.js'])('anonymous %s cannot receive the protected CMS script', async (variant) => {
    const result = await request(variant);
    expect(result.status).toBe(401);
    expect(result.headers.get('cache-control')).toContain('no-store');
    expect(mockSql).not.toHaveBeenCalled();
  });

  test.each(['/%2fadmin.html', '//admin.html', '/unused%2f..%2fadmin.html'])('decoded static alias %s also stays behind sign-in', async (variant) => {
    const result = await request(variant);
    expect(result.status).toBe(302);
    expect(result.headers.get('location')).toMatch(/^\/staff-login\?scope=admin&next=/);
    expect(result.text).not.toContain('admin-workspace-bar');
    expect(result.headers.get('cache-control')).toContain('no-store');
    expect(mockSql).not.toHaveBeenCalled();
  });

  test('the normalized session route remains public and canonicalizes its safe destination', async () => {
    const result = await login('/ADMIN.HTML/?view=menu%20editor#tab-air-menu', '/API/ADMIN/SESSION/');
    expect(result.data.next).toBe('/admin?view=menu%20editor#tab-air-menu');
    expect(result.headers.get('set-cookie')).toContain('HttpOnly');
    expect(result.headers.get('set-cookie')).toContain('SameSite=Lax');
    expect(result.headers.get('cache-control')).toBe('no-store');
    expect(mockSql).not.toHaveBeenCalled();
  });

  test('external or unrecognized login destinations cannot redirect away from the Admin pages', async () => {
    expect((await login('https://example.invalid/DASHBOARD/?range=month#collections')).data.next)
      .toBe('/dashboard?range=month#collections');
    expect((await login('//example.invalid/unrelated')).data.next).toBe('/admin');
    expect((await login('/orders')).data.next).toBe('/admin');
    expect(mockSql).not.toHaveBeenCalled();
  });

  test('the normalized logout route clears the Admin cookie without requiring a session', async () => {
    const result = await request('/API/ADMIN/SESSION/', { method: 'DELETE' });
    expect(result.status).toBe(200);
    expect(JSON.parse(result.text).ok).toBe(true);
    expect(result.headers.get('set-cookie')).toMatch(/^rl_admin_session=;/);
    expect(result.headers.get('cache-control')).toBe('no-store');
    expect(mockSql).not.toHaveBeenCalled();
  });

  test('legacy Basic authentication still authorizes uppercase API paths without invoking any data handler', async () => {
    // There is deliberately no handler at this probe URL. A 404 proves the
    // authenticated request passed the gate without consulting a database.
    const result = await request('/API/ADMIN/__auth_probe__/', { headers: { Authorization: basic } });
    expect(result.status).toBe(404);
    expect(mockSql).not.toHaveBeenCalled();
  });

  test.each([
    ['/Admin/', '/admin'],
    ['/admin.html', '/admin'],
    ['/admin%2ehtml', '/admin'],
    ['/DASHBOARD/', '/dashboard'],
    ['/dashboard.html', '/dashboard'],
  ])('authenticated %s canonicalizes to %s while preserving query parameters', async (variant, canonical) => {
    const result = await request(`${variant}?section=menu%20editor`, { authenticated: true });
    expect(result.status).toBe(302);
    expect(result.headers.get('location')).toBe(`${canonical}?section=menu%20editor`);
    expect(result.headers.get('cache-control')).toContain('no-store');
    expect(mockSql).not.toHaveBeenCalled();
  });

  test('authenticated HEAD redirects before serving variant page URLs', async () => {
    const result = await request('/ADMIN/?view=staff', { authenticated: true, method: 'HEAD' });
    expect(result.status).toBe(302);
    expect(result.headers.get('location')).toBe('/admin?view=staff');
    expect(result.text).toBe('');
    expect(mockSql).not.toHaveBeenCalled();
  });

  test.each(['/admin', '/dashboard'])('authenticated %s HTML cannot remain in a shared or stale browser cache', async (canonical) => {
    const result = await request(canonical, { authenticated: true });
    expect(result.status).toBe(200);
    expect(result.headers.get('content-type')).toContain('text/html');
    expect(result.headers.get('cache-control')).toBe('private, no-store, max-age=0');
    expect(mockSql).not.toHaveBeenCalled();
  });

  test.each([
    '/admin-workspace.js?v=2',
    '/admin-workspace.css?v=2',
    '/admin-air-menu.css?v=2',
    '/admin-analytics.js?v=5',
    '/admin-analytics.css?v=4',
    '/employee-admin.js?v=4',
    '/admin-cms.js?v=fixture',
  ])('%s revalidates before reuse and never serves a stale Admin implementation', async (asset) => {
    const result = await request(asset, { authenticated: true });
    expect(result.status).toBe(200);
    expect(result.headers.get('cache-control')).toBe('private, no-cache, max-age=0, must-revalidate');
    expect(result.headers.get('etag')).toBeTruthy();
    const conditional = await request(asset, {
      authenticated: true,
      // Node fetch adds Cache-Control: no-cache to explicit conditional
      // requests unless supplied, which intentionally forces a full 200.
      headers: { 'If-None-Match': result.headers.get('etag'), 'Cache-Control': 'max-age=0' },
    });
    expect(conditional.status).toBe(304);
    expect(conditional.headers.get('cache-control')).toBe('private, no-cache, max-age=0, must-revalidate');
    expect(mockSql).not.toHaveBeenCalled();
  });

  test('public menu asset caching keeps its existing behavior', async () => {
    const result = await request('/air-menu.js?v=fixture');
    expect(result.status).toBe(200);
    expect(result.headers.get('cache-control')).toBe('public, max-age=3600, stale-while-revalidate=86400');
    expect(mockSql).not.toHaveBeenCalled();
  });
});
