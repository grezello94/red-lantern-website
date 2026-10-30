const { test, expect } = require('@playwright/test');
const { createSetupServer } = require('../scripts/connect-google-business');

const port = 8766;
const origin = `http://127.0.0.1:${port}`;
let setup;
let exchanges = 0;
const saves = [];

test.beforeAll(async () => {
  setup = createSetupServer({
    port,
    clientId: 'browser-test-client',
    clientSecret: 'browser-test-client-secret',
    locationId: '123',
    envPath: '/browser-test-only/.env',
    exchange: async () => {
      exchanges += 1;
      return { accessToken: 'browser-test-access-token', refreshToken: 'browser-test-refresh-token' };
    },
    discover: async () => ({ accountId: '100', locationId: '123', title: 'Red Lantern test restaurant' }),
    fetchImpl: async () => ({ ok: true, status: 200 }),
    save: async (envPath, updates) => { saves.push({ envPath, updates }); },
  });
  await new Promise((resolve, reject) => {
    setup.server.once('error', reject);
    setup.server.listen(port, '127.0.0.1', resolve);
  });
});

test.afterAll(async () => {
  if (setup?.server.listening)
    await new Promise((resolve, reject) => setup.server.close(error => error ? reject(error) : resolve()));
});

test('native Google sign-in form preserves its Origin and produces the permitted OAuth redirect', async ({ page }) => {
  let authorizationUrl;
  let postedOrigin;
  page.on('request', request => {
    if (request.url() === `${origin}/connect` && request.method() === 'POST')
      postedOrigin = request.headers().origin;
  });
  // Stop at the local 303. Redirect-chain requests bypass Playwright's route
  // handlers, so mocking only the Google destination would contact Google.
  await page.route(`${origin}/connect`, async route => {
    const response = await route.fetch({ maxRedirects: 0 });
    expect(response.status()).toBe(303);
    expect(response.headers()['referrer-policy']).toBe('no-referrer');
    authorizationUrl = new URL(response.headers().location);
    await route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><title>Mock Google authorization</title><h1>Google authorization reached</h1>',
    });
  });
  const response = await page.goto(origin);
  expect(response.headers()['referrer-policy']).toBe('same-origin');
  expect(response.headers()['content-security-policy']).toContain("form-action 'self' https://accounts.google.com;");
  await page.getByRole('button', { name: 'Continue with Google' }).click();
  expect(postedOrigin).toBe(origin);
  await expect(page.getByRole('heading', { name: 'Google authorization reached' })).toBeVisible();
  expect(authorizationUrl.origin).toBe('https://accounts.google.com');
  expect(authorizationUrl.searchParams.get('redirect_uri')).toBe(`${origin}/google/callback`);
  expect(setup.getStatus().stage).toBe('awaiting_google');
  expect(saves).toHaveLength(0);

  const callback = new URL('/google/callback', origin);
  callback.searchParams.set('state', authorizationUrl.searchParams.get('state'));
  callback.searchParams.set('code', 'browser-test-authorization-code');
  await page.goto(callback.toString());
  await expect(page.getByRole('heading', { name: 'Google connection saved' })).toBeVisible();
  expect(setup.getStatus().stage).toBe('connected');
  expect(exchanges).toBe(1);
  expect(saves).toHaveLength(1);
  expect(saves[0]).toEqual({
    envPath: '/browser-test-only/.env',
    updates: {
      GOOGLE_BUSINESS_ACCOUNT_ID: '100',
      GOOGLE_BUSINESS_LOCATION_ID: '123',
      GOOGLE_BUSINESS_OAUTH_REFRESH_TOKEN: 'browser-test-refresh-token',
      GOOGLE_REVIEWS_SYNC_LIMIT: '0',
    },
  });
  await expect(page.locator('body')).not.toContainText('browser-test-access-token');
  await expect(page.locator('body')).not.toContainText('browser-test-refresh-token');
});
