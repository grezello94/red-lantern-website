'use strict';

const GOOGLE_SCOPE = 'https://www.googleapis.com/auth/business.manage';
const requestTimeoutMs = 20000;

class GoogleBusinessConnectionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GoogleBusinessConnectionError';
  }
}

function buildAuthorizationUrl({ clientId, redirectUri, state, codeChallenge }) {
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: GOOGLE_SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  }).toString();
  return url.toString();
}

async function googleRequest(url, options, fetchImpl) {
  try {
    const response = await fetchImpl(url, {
      ...options,
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    const data = await response.json();
    if (!data || typeof data !== 'object') throw new GoogleBusinessConnectionError('Unexpected response.');
    return { response, data };
  } catch {
    throw new GoogleBusinessConnectionError('Unable to reach Google or read its response. Check your connection and try again.');
  }
}

async function exchangeAuthorizationCode(
  { clientId, clientSecret, redirectUri, code, codeVerifier },
  fetchImpl = fetch
) {
  const { response, data } = await googleRequest('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      code,
      code_verifier: codeVerifier,
      grant_type: 'authorization_code',
    }),
  }, fetchImpl);

  if (!response.ok) {
    if (data.error === 'invalid_client' || data.error === 'unauthorized_client')
      throw new GoogleBusinessConnectionError('Check the OAuth client ID, client secret and client type in Google Cloud.');
    if (data.error === 'redirect_uri_mismatch')
      throw new GoogleBusinessConnectionError('Register this exact callback URL in the Google OAuth client, then reconnect.');
    if (data.error === 'invalid_scope')
      throw new GoogleBusinessConnectionError(`Reconnect and approve the Google Business Profile scope: ${GOOGLE_SCOPE}.`);
    if (data.error === 'invalid_grant')
      throw new GoogleBusinessConnectionError('Google authorization expired or could not be verified. Start the connection again.');
    throw new GoogleBusinessConnectionError('Google declined the authorization exchange. Check the OAuth app configuration and reconnect.');
  }

  if (typeof data.scope === 'string' && !data.scope.split(/\s+/).includes(GOOGLE_SCOPE))
    throw new GoogleBusinessConnectionError(`Google Business Profile permission is missing. Reconnect and approve ${GOOGLE_SCOPE}.`);
  if (typeof data.access_token !== 'string' || !data.access_token.trim())
    throw new GoogleBusinessConnectionError('Google did not return an access token. Start the connection again.');
  if (typeof data.refresh_token !== 'string' || !data.refresh_token.trim())
    throw new GoogleBusinessConnectionError('Google did not return offline authorization. Reconnect and approve access again.');
  return { accessToken: data.access_token, refreshToken: data.refresh_token };
}

async function businessPage(url, accessToken, fetchImpl) {
  const { response, data } = await googleRequest(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  }, fetchImpl);
  if (response.ok) return data;
  if (response.status === 401)
    throw new GoogleBusinessConnectionError('Google authorization has expired. Reconnect the Google account and try again.');
  if (response.status === 403)
    throw new GoogleBusinessConnectionError(`Google Business Profile access was denied. Approve ${GOOGLE_SCOPE}, use an owner or manager account, and check API approval and enabled APIs in Google Cloud.`);
  if (response.status === 429)
    throw new GoogleBusinessConnectionError('Google Business Profile API quota is unavailable. Check API access and quota in Google Cloud.');
  throw new GoogleBusinessConnectionError('Google could not list Business Profile accounts or locations. Check API access and try again.');
}

async function paginatedItems(baseUrl, field, accessToken, fetchImpl) {
  const items = [];
  const seenTokens = new Set();
  let pageToken = '';
  do {
    const url = new URL(baseUrl);
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const data = await businessPage(url, accessToken, fetchImpl);
    if (data[field] !== undefined && !Array.isArray(data[field]))
      throw new GoogleBusinessConnectionError('Google returned an unexpected Business Profile list. Try connecting again.');
    items.push(...(data[field] || []));
    pageToken = data.nextPageToken || '';
    if (typeof pageToken !== 'string' || (pageToken && seenTokens.has(pageToken)))
      throw new GoogleBusinessConnectionError('Google returned a repeated or invalid page token. No connection was saved; try again.');
    if (pageToken) seenTokens.add(pageToken);
  } while (pageToken);
  return items;
}

async function discoverBusinessLocation({ accessToken, locationId }, fetchImpl = fetch) {
  const wantedId = String(locationId || '').replace(/^locations\//, '');
  if (!/^\d+$/.test(wantedId))
    throw new GoogleBusinessConnectionError('Set the numeric Google Business Profile location ID before connecting. A Maps Place ID cannot be used.');
  if (typeof accessToken !== 'string' || !accessToken)
    throw new GoogleBusinessConnectionError('Google authorization is missing. Reconnect and approve Business Profile access.');

  const accountUrl = new URL('https://mybusinessaccountmanagement.googleapis.com/v1/accounts');
  accountUrl.searchParams.set('pageSize', '20');
  const accounts = await paginatedItems(accountUrl, 'accounts', accessToken, fetchImpl);
  const accountNames = new Set(accounts.map(account => account?.name));
  const matches = new Map();
  for (const accountName of accountNames) {
    const accountMatch = /^accounts\/(\d+)$/.exec(String(accountName || ''));
    if (!accountMatch)
      throw new GoogleBusinessConnectionError('Google returned an unexpected account identifier. Try connecting again.');
    const locationUrl = new URL(`https://mybusinessbusinessinformation.googleapis.com/v1/${accountName}/locations`);
    locationUrl.searchParams.set('readMask', 'name,title');
    locationUrl.searchParams.set('pageSize', '100');
    const locations = await paginatedItems(locationUrl, 'locations', accessToken, fetchImpl);
    for (const location of locations) {
      if (location?.name !== `locations/${wantedId}`) continue;
      matches.set(accountName, {
        accountId: accountMatch[1],
        locationId: wantedId,
        title: typeof location.title === 'string' ? location.title : '',
      });
    }
  }
  if (!matches.size)
    throw new GoogleBusinessConnectionError('This Google account cannot access the configured restaurant location. Sign in as its owner or manager and check the Business Profile location ID.');
  if (matches.size > 1)
    throw new GoogleBusinessConnectionError('The restaurant location appears under multiple Google Business accounts. Choose the correct account before saving a connection.');
  return [...matches.values()][0];
}

function quoteEnvValue(value) {
  if (typeof value !== 'string' || /[\r\n\0]/.test(value))
    throw new GoogleBusinessConnectionError('Environment values must be strings without newlines or null bytes.');
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes('"') && !value.includes('\\n')) return `"${value}"`;
  throw new GoogleBusinessConnectionError('This environment value cannot be safely quoted. Use a value without mixed quote characters.');
}

function updateEnvText(existingText, updates) {
  const replacements = new Map(Object.entries(updates).map(([key, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
      throw new GoogleBusinessConnectionError('Invalid environment variable name.');
    return [key, quoteEnvValue(value)];
  }));
  if (!replacements.size) return existingText;
  const newline = existingText.match(/\r\n|\n|\r/)?.[0] || '\n';
  const lines = existingText.match(/[^\r\n]*(?:\r\n|\n|\r|$)/g).filter(Boolean);
  const seenKeys = new Set();
  let output = '';
  for (let index = 0; index < lines.length; index += 1) {
    const firstLine = lines[index];
    const match = firstLine.replace(/[\r\n]+$/, '').match(/^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)(\s*=\s*)(.*)$/);
    let original = firstLine;
    let lastLine = firstLine;
    if (match && /^['"`]/.test(match[4]) && !match[4].slice(1).includes(match[4][0])) {
      const quote = match[4][0];
      let closed = false;
      while (index + 1 < lines.length) {
        lastLine = lines[++index];
        original += lastLine;
        if (lastLine.includes(quote)) { closed = true; break; }
      }
      if (!closed) throw new GoogleBusinessConnectionError('The existing environment file contains an unterminated quoted value.');
    }
    if (!match || !replacements.has(match[2])) { output += original; continue; }
    seenKeys.add(match[2]);
    output += `${match[1]}${match[2]}${match[3]}${replacements.get(match[2])}${lastLine.match(/\r\n$|\n$|\r$/)?.[0] || ''}`;
  }
  for (const [key, value] of replacements) {
    if (seenKeys.has(key)) continue;
    if (output && !/[\r\n]$/.test(output)) output += newline;
    output += `${key}=${value}${newline}`;
  }
  return output;
}

module.exports = {
  GoogleBusinessConnectionError,
  GOOGLE_SCOPE,
  buildAuthorizationUrl,
  exchangeAuthorizationCode,
  discoverBusinessLocation,
  updateEnvText,
};
