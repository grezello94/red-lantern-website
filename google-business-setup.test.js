/** @jest-environment node */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { GoogleBusinessConnectionError } = require('./google-business-connection');
const { createSetupServer, saveConnection } = require('./scripts/connect-google-business');

const setupHost = '127.0.0.1:8765';
const setupOrigin = `http://${setupHost}`;
const tokenValues = { accessToken: 'private-access-token', refreshToken: 'private-refresh-token' };

// Dispatch directly through the Node request listener; no listening socket or live Google calls.
function request(server, { method = 'GET', url = '/', headers = {}, body = '' } = {}) {
  return new Promise((resolve, reject) => {
    const req = Readable.from(body ? [body] : []);
    Object.assign(req, { method, url, headers: { host: setupHost, ...headers } });
    const res = {
      status: 200, headers: {}, headersSent: false,
      setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
      writeHead(status, values) {
        this.status = status;
        for (const [name, value] of Object.entries(values)) this.setHeader(name, value);
        this.headersSent = true;
      },
      end(value = '') { resolve({ status: this.status, headers: this.headers, body: String(value) }); },
    };
    try { server.emit('request', req, res); } catch (error) { reject(error); }
  });
}

function setup(extra = {}) {
  const exchange = jest.fn(async () => tokenValues);
  const discover = jest.fn(async () => ({ accountId: '100', locationId: '123', title: 'Red Lantern' }));
  const save = jest.fn();
  const fetchImpl = jest.fn(async () => ({ ok: true, status: 200 }));
  const onEvent = jest.fn();
  return {
    ...createSetupServer({
      clientId: 'test-client', clientSecret: 'private-client-secret', locationId: '123',
      envPath: '/test-only/.env', exchange, discover, save, fetchImpl, onEvent, ...extra,
    }),
    exchange, discover, save, fetchImpl, onEvent,
  };
}

async function sessionFor(server) {
  const page = await request(server);
  const cookie = page.headers['set-cookie'].split(';')[0];
  const csrf = page.body.match(/name="csrf" value="([^"]+)"/)[1];
  return { cookie, csrf, page };
}

async function startFlow(server) {
  const session = await sessionFor(server);
  const response = await request(server, {
    method: 'POST', url: '/connect',
    headers: { cookie: session.cookie, origin: setupOrigin },
    body: new URLSearchParams({ csrf: session.csrf }).toString(),
  });
  expect(response.status).toBe(303);
  expect(response.headers['referrer-policy']).toBe('no-referrer');
  return { ...session, authUrl: new URL(response.headers.location) };
}

function callback(server, flow, extra = {}) {
  const url = new URL('/google/callback', setupOrigin);
  url.searchParams.set('state', flow.authUrl.searchParams.get('state'));
  url.searchParams.set('code', 'private-authorization-code');
  return request(server, { url: url.pathname + url.search, headers: { cookie: flow.cookie }, ...extra });
}

function expectNoSecrets(value) {
  expect(JSON.stringify(value)).not.toMatch(/private-access-token|private-refresh-token|private-client-secret|private-authorization-code/);
}

describe('Loopback Google setup protection', () => {
  test('rejects foreign Host values before setting session state', async () => {
    const current = setup();
    const result = await request(current.server, { headers: { host: 'foreign.example:8765' } });
    expect(result.status).toBe(403);
    expect(result.headers['set-cookie']).toBeUndefined();
    expect(current.exchange).not.toHaveBeenCalled();
  });

  test('requires a setup session, same origin, and matching CSRF token', async () => {
    const current = setup();
    const initial = await request(current.server, {
      method: 'POST', url: '/connect', headers: { origin: setupOrigin }, body: 'csrf=guessed',
    });
    expect(initial.status).toBe(403);
    const { cookie, csrf, page } = await sessionFor(current.server);
    expect(page.headers['set-cookie']).toContain('HttpOnly; SameSite=Lax');
    expect(page.headers['referrer-policy']).toBe('same-origin');
    expect(page.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(page.headers['content-security-policy'].split(';').map(value => value.trim())
      .find(value => value.startsWith('form-action ')))
      .toBe("form-action 'self' https://accounts.google.com");
    expectNoSecrets(page);
    for (const [origin, body] of [
      ['https://foreign.example', new URLSearchParams({ csrf }).toString()],
      ['null', new URLSearchParams({ csrf }).toString()],
      [undefined, new URLSearchParams({ csrf }).toString()],
      [setupOrigin, 'csrf=guessed'],
    ]) {
      const response = await request(current.server, {
        method: 'POST', url: '/connect', headers: { cookie, origin }, body,
      });
      expect(response.status).toBe(403);
    }
    expect(current.exchange).not.toHaveBeenCalled();
  });

  test('rejects callbacks with missing sessions, invalid states, or expired states', async () => {
    let time = 1000;
    const current = setup({ now: () => time });
    const flow = await startFlow(current.server);
    const noSession = await callback(current.server, flow, { headers: {} });
    expect(noSession.status).toBe(403);
    const invalidState = await request(current.server, {
      url: '/google/callback?state=wrong&code=private-authorization-code',
      headers: { cookie: flow.cookie },
    });
    expect(invalidState.status).toBe(400);
    time += 10 * 60 * 1000;
    const expired = await callback(current.server, flow);
    expect(expired.status).toBe(400);
    expect(current.exchange).not.toHaveBeenCalled();
    expect(current.save).not.toHaveBeenCalled();
    expectNoSecrets([noSession, invalidState, expired]);
  });

  test('handles a declined OAuth grant without reflecting raw error details', async () => {
    const current = setup();
    const flow = await startFlow(current.server);
    const url = `/google/callback?state=${flow.authUrl.searchParams.get('state')}&error=access_denied&error_description=private-refresh-token`;
    const response = await request(current.server, { url, headers: { cookie: flow.cookie } });
    expect(response.status).toBe(303);
    expect(current.getStatus().stage).toBe('error');
    expect(current.save).not.toHaveBeenCalled();
    expectNoSecrets(await request(current.server));
    expectNoSecrets(current.getStatus());
  });
});

describe('Verified Google setup persistence', () => {
  test('saves only after the exact restaurant review endpoint confirms access', async () => {
    const order = [];
    const current = setup();
    current.fetchImpl.mockImplementation(async () => { order.push('review-read'); return { ok: true, status: 200 }; });
    current.save.mockImplementation(() => order.push('save'));
    const flow = await startFlow(current.server);
    const response = await callback(current.server, flow);
    expect(response.status).toBe(303);
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(order).toEqual(['review-read', 'save']);
    expect(current.exchange).toHaveBeenCalledWith(expect.objectContaining({
      code: 'private-authorization-code', redirectUri: `${setupOrigin}/google/callback`,
      codeVerifier: expect.any(String),
    }), current.fetchImpl);
    expect(current.discover).toHaveBeenCalledWith({ accessToken: 'private-access-token', locationId: '123' }, current.fetchImpl);
    const [url, options] = current.fetchImpl.mock.calls[0];
    expect(url.origin).toBe('https://mybusiness.googleapis.com');
    expect(url.pathname).toBe('/v4/accounts/100/locations/123/reviews');
    expect(url.searchParams.get('pageSize')).toBe('1');
    expect(options.headers.Authorization).toBe('Bearer private-access-token');
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(current.save).toHaveBeenCalledWith('/test-only/.env', {
      GOOGLE_BUSINESS_ACCOUNT_ID: '100', GOOGLE_BUSINESS_LOCATION_ID: '123',
      GOOGLE_BUSINESS_OAUTH_REFRESH_TOKEN: 'private-refresh-token', GOOGLE_REVIEWS_SYNC_LIMIT: '0',
    });
    expect(current.getStatus().stage).toBe('connected');
    expectNoSecrets(current.getStatus());
    expectNoSecrets(await request(current.server));
    expectNoSecrets(current.onEvent.mock.calls);
    const replay = await callback(current.server, flow);
    expect(replay.status).toBe(400);
    expect(current.save).toHaveBeenCalledTimes(1);
  });

  test.each([401, 403, 429, 503])('never saves when the review access check returns %i', async status => {
    const current = setup();
    current.fetchImpl.mockResolvedValue({ ok: false, status });
    await callback(current.server, await startFlow(current.server));
    expect(current.getStatus().stage).toBe('error');
    expect(current.save).not.toHaveBeenCalled();
    expectNoSecrets(await request(current.server));
  });

  test('displays trusted actionable errors and prevents raw transport or filesystem errors from leaking secrets', async () => {
    const current = setup();
    const trusted = new GoogleBusinessConnectionError('Approve the Google Business Profile scope and reconnect.');
    current.exchange.mockRejectedValueOnce(trusted);
    await callback(current.server, await startFlow(current.server));
    expect(current.getStatus().message).toBe(trusted.message);
    current.fetchImpl.mockRejectedValueOnce(new Error('Network failure private-access-token private-client-secret'));
    await callback(current.server, await startFlow(current.server));
    expect(current.save).not.toHaveBeenCalled();
    expectNoSecrets(current.getStatus());
    expectNoSecrets(await request(current.server));
    current.save.mockImplementationOnce(() => { throw new Error('Disk failure private-refresh-token'); });
    await callback(current.server, await startFlow(current.server));
    expect(current.getStatus().stage).toBe('error');
    expectNoSecrets(current.getStatus());
    expectNoSecrets(await request(current.server));
  });
});

describe('Atomic local connection saving', () => {
  let directory;
  beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'red-lantern-google-test-')); });
  afterEach(() => { fs.rmSync(directory, { recursive: true, force: true }); });

  test('preserves unrelated configuration, writes private permissions, and leaves no temporary credentials behind', () => {
    const envPath = path.join(directory, '.env');
    fs.writeFileSync(envPath, 'DATABASE=keep\nTOKEN=old\n');
    saveConnection(envPath, { TOKEN: 'new-token' });
    expect(fs.readFileSync(envPath, 'utf8')).toBe("DATABASE=keep\nTOKEN='new-token'\n");
    expect(fs.statSync(envPath).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(directory)).toEqual(['.env']);
  });

  test('rejects symlinks and unsafe updates without overwriting the original configuration', () => {
    const target = path.join(directory, 'real.env');
    const link = path.join(directory, '.env');
    fs.writeFileSync(target, 'DATABASE=keep\n');
    fs.symlinkSync(target, link);
    expect(() => saveConnection(link, { TOKEN: 'new' })).toThrow('symbolic link');
    expect(() => saveConnection(target, { TOKEN: 'bad\nINJECTED=yes' })).toThrow();
    expect(fs.readFileSync(target, 'utf8')).toBe('DATABASE=keep\n');
    expect(fs.readdirSync(directory).sort()).toEqual(['.env', 'real.env']);
  });
});
