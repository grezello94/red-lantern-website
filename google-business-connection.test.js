/** @jest-environment node */
'use strict';

const { parseEnv } = require('node:util');
const {
  GoogleBusinessConnectionError,
  GOOGLE_SCOPE,
  buildAuthorizationUrl,
  exchangeAuthorizationCode,
  discoverBusinessLocation,
  updateEnvText,
} = require('./google-business-connection');

const authorization = {
  clientId: 'test-client', clientSecret: 'test-secret',
  redirectUri: 'http://127.0.0.1:43117/oauth/callback',
  code: 'test-code', codeVerifier: 'test-verifier',
};

function fetchPages(pages) {
  return jest.fn(async () => {
    const page = pages.shift();
    if (!page) throw new Error('Unexpected request.');
    return { ok: page.ok !== false, status: page.status || 200, json: async () => page.data };
  });
}

describe('Google Business Profile authorization', () => {
  test('builds consent with state, a PKCE challenge and offline Business Profile permission', () => {
    const url = new URL(buildAuthorizationUrl({
      ...authorization, state: 'state with + and /', codeChallenge: 'S256-challenge',
    }));
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: authorization.clientId, redirect_uri: authorization.redirectUri,
      response_type: 'code', scope: GOOGLE_SCOPE, state: 'state with + and /',
      access_type: 'offline', prompt: 'consent',
      code_challenge: 'S256-challenge', code_challenge_method: 'S256',
    });
    expect(url.searchParams.has('client_secret')).toBe(false);
  });

  test('exchanges a code server-side with PKCE and returns only required tokens', async () => {
    const fetcher = fetchPages([{ data: {
      access_token: 'access', refresh_token: 'refresh', scope: GOOGLE_SCOPE, extra: 'unused',
    } }]);
    await expect(exchangeAuthorizationCode(authorization, fetcher))
      .resolves.toEqual({ accessToken: 'access', refreshToken: 'refresh' });
    const [url, options] = fetcher.mock.calls[0];
    expect(url).toBe('https://oauth2.googleapis.com/token');
    expect(Object.fromEntries(options.body)).toMatchObject({
      client_secret: 'test-secret', code_verifier: 'test-verifier',
      redirect_uri: authorization.redirectUri, grant_type: 'authorization_code',
    });
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  test.each([
    ['invalid_grant', /Start the connection again/],
    ['invalid_client', /client ID, client secret/],
    ['redirect_uri_mismatch', /exact callback URL/],
    ['invalid_scope', /business.manage/],
    ['untrusted-secret-error', /declined the authorization/],
  ])('sanitizes the %s token error', async (error, message) => {
    const fetcher = fetchPages([{ ok: false, status: 400, data: {
      error, error_description: 'private-secret-value', access_token: 'private-secret-token',
    } }]);
    const failure = await exchangeAuthorizationCode(authorization, fetcher).catch(value => value);
    expect(failure).toBeInstanceOf(GoogleBusinessConnectionError);
    expect(failure.message).toMatch(message);
    expect(failure.message).not.toMatch(/private-secret|untrusted-secret/);
  });

  test('does not expose network errors or malformed response bodies', async () => {
    for (const fetcher of [
      jest.fn(async () => { throw new Error('private-token-in-url'); }),
      jest.fn(async () => ({ json: async () => { throw new Error('private-response'); } })),
    ]) {
      await expect(exchangeAuthorizationCode(authorization, fetcher))
        .rejects.toThrow('Unable to reach Google or read its response.');
    }
  });

  test('requires Business Profile consent and offline authorization', async () => {
    const lackingScope = fetchPages([{ data: {
      access_token: 'access', refresh_token: 'refresh', scope: 'openid email',
    } }]);
    await expect(exchangeAuthorizationCode(authorization, lackingScope)).rejects.toThrow(GOOGLE_SCOPE);
    const lackingRefresh = fetchPages([{ data: { access_token: 'access' } }]);
    await expect(exchangeAuthorizationCode(authorization, lackingRefresh)).rejects.toThrow('offline authorization');
  });
});

describe('Business Profile account and location discovery', () => {
  test('follows account and location pages and exactly matches the configured numeric location', async () => {
    const fetcher = fetchPages([
      { data: { accounts: [{ name: 'accounts/100' }], nextPageToken: 'accounts-next' } },
      { data: { accounts: [{ name: 'accounts/200' }] } },
      { data: { locations: [{ name: 'locations/1234' }], nextPageToken: 'locations-next' } },
      { data: { locations: [{ name: 'locations/123', title: 'Red Lantern' }] } },
      { data: { locations: [{ name: 'locations/987', title: 'Another business' }] } },
    ]);
    await expect(discoverBusinessLocation({ accessToken: 'private-access', locationId: 'locations/123' }, fetcher))
      .resolves.toEqual({ accountId: '100', locationId: '123', title: 'Red Lantern' });
    const requests = fetcher.mock.calls.map(([url]) => new URL(url));
    expect(requests[0].origin).toBe('https://mybusinessaccountmanagement.googleapis.com');
    expect(requests[0].searchParams.get('pageSize')).toBe('20');
    expect(requests[1].searchParams.get('pageToken')).toBe('accounts-next');
    expect(requests[2].origin).toBe('https://mybusinessbusinessinformation.googleapis.com');
    expect(requests[2].pathname).toBe('/v1/accounts/100/locations');
    expect(requests[2].searchParams.get('readMask')).toBe('name,title');
    expect(requests[2].searchParams.get('pageSize')).toBe('100');
    expect(requests[3].searchParams.get('pageToken')).toBe('locations-next');
    for (const [, options] of fetcher.mock.calls) {
      expect(options.headers.Authorization).toBe('Bearer private-access');
      expect(options.signal).toBeInstanceOf(AbortSignal);
    }
  });

  test('rejects ambiguous matches across accounts', async () => {
    const fetcher = fetchPages([
      { data: { accounts: [{ name: 'accounts/100' }, { name: 'accounts/200' }] } },
      { data: { locations: [{ name: 'locations/123' }] } },
      { data: { locations: [{ name: 'locations/123' }] } },
    ]);
    await expect(discoverBusinessLocation({ accessToken: 'access', locationId: '123' }, fetcher))
      .rejects.toThrow('multiple Google Business accounts');
  });

  test('requires owner or manager access to the exact configured location', async () => {
    const fetcher = fetchPages([
      { data: { accounts: [{ name: 'accounts/100' }] } },
      { data: { locations: [{ name: 'locations/1234' }] } },
    ]);
    await expect(discoverBusinessLocation({ accessToken: 'access', locationId: '123' }, fetcher))
      .rejects.toThrow('owner or manager');
  });

  test('fails closed with actionable permission guidance and no raw Google error data', async () => {
    const fetcher = fetchPages([{ ok: false, status: 403, data: {
      error: { message: 'private-project-or-token', status: 'PERMISSION_DENIED' },
    } }]);
    const failure = await discoverBusinessLocation({ accessToken: 'access', locationId: '123' }, fetcher)
      .catch(value => value);
    expect(failure.message).toMatch(/business.manage/);
    expect(failure.message).toMatch(/API approval/);
    expect(failure.message).not.toContain('private-project-or-token');
  });

  test.each(['accounts', 'locations'])('rejects repeated %s page tokens', async field => {
    const pages = field === 'accounts'
      ? [
        { data: { accounts: [], nextPageToken: 'again' } },
        { data: { accounts: [], nextPageToken: 'again' } },
      ]
      : [
        { data: { accounts: [{ name: 'accounts/100' }] } },
        { data: { locations: [], nextPageToken: 'again' } },
        { data: { locations: [], nextPageToken: 'again' } },
      ];
    await expect(discoverBusinessLocation({ accessToken: 'access', locationId: '123' }, fetchPages(pages)))
      .rejects.toThrow('repeated or invalid page token');
  });

  test('rejects a Maps Place ID without sending any request', async () => {
    const fetcher = jest.fn();
    await expect(discoverBusinessLocation({ accessToken: 'access', locationId: 'ChIJ-place-id' }, fetcher))
      .rejects.toThrow('Maps Place ID');
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('Local environment updates', () => {
  test('preserves unrelated credentials and CRLF and updates every duplicate key', () => {
    const original = '# local settings\r\nSECRET="keep = # exactly"\r\nTOKEN=old\r\n\r\nexport TOKEN = stale\r\nLAST=unchanged';
    const result = updateEnvText(original, { TOKEN: 'fresh#value', ACCOUNT_ID: '100' });
    expect(result).toBe('# local settings\r\nSECRET="keep = # exactly"\r\nTOKEN=\'fresh#value\'\r\n\r\nexport TOKEN = \'fresh#value\'\r\nLAST=unchanged\r\nACCOUNT_ID=\'100\'\r\n');
    expect(parseEnv(result)).toMatchObject({ SECRET: 'keep = # exactly', TOKEN: 'fresh#value', ACCOUNT_ID: '100' });
  });

  test('quotes values with whitespace, comments, quotes and literal backslashes safely', () => {
    const values = { A: ' space # and "quote" ', B: "customer's review", C: 'literal\\nvalue' };
    expect(parseEnv(updateEnvText('', values))).toEqual(values);
  });

  test('does not mistake lines inside an unrelated multiline credential for assignments', () => {
    const original = 'SECRET="first\nTOKEN=part-of-secret\nlast"\nTOKEN=old\n';
    expect(updateEnvText(original, { TOKEN: 'new' }))
      .toBe('SECRET="first\nTOKEN=part-of-secret\nlast"\nTOKEN=\'new\'\n');
  });

  test('replaces an existing multiline updated value without leaving its old continuation', () => {
    expect(updateEnvText('TOKEN="old\ncontinued"\nSECRET=keep\n', { TOKEN: 'new' }))
      .toBe('TOKEN=\'new\'\nSECRET=keep\n');
  });

  test.each([
    [{ 'INVALID-KEY': 'value' }],
    [{ VALID: 'value\nINJECTED=yes' }],
    [{ VALID: 'value\rINJECTED=yes' }],
    [{ VALID: 'null\0byte' }],
    [{ VALID: 'both\'and"quotes' }],
  ])('rejects unsafe names or values without changing input', updates => {
    expect(() => updateEnvText('SECRET=keep\n', updates)).toThrow();
  });

  test('rejects an unterminated existing quoted value before appending new settings', () => {
    expect(() => updateEnvText('SECRET="unfinished', { TOKEN: 'new' }))
      .toThrow('unterminated quoted value');
  });
});
