#!/usr/bin/env node
'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  buildAuthorizationUrl,
  exchangeAuthorizationCode,
  discoverBusinessLocation,
  updateEnvText,
  GoogleBusinessConnectionError,
} = require('../google-business-connection');

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[char]);
const sameSecret = (value, expected) => {
  const supplied = Buffer.from(String(value || ''));
  const correct = Buffer.from(expected);
  return supplied.length === correct.length && crypto.timingSafeEqual(supplied, correct);
};

function saveConnection(envPath, updates) {
  if (fs.lstatSync(envPath).isSymbolicLink()) {
    throw new Error('The local .env is a symbolic link. Update its connection settings manually.');
  }
  const updated = updateEnvText(fs.readFileSync(envPath, 'utf8'), updates);
  const temporary = `${envPath}.google-connect-${crypto.randomBytes(8).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temporary, updated, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, envPath);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function createSetupServer({
  clientId,
  clientSecret,
  locationId,
  envPath = path.join(__dirname, '..', '.env'),
  port = 8765,
  exchange = exchangeAuthorizationCode,
  discover = discoverBusinessLocation,
  save = saveConnection,
  fetchImpl = fetch,
  onEvent = () => {},
  now = Date.now,
}) {
  if (!clientId || !clientSecret || !locationId) {
    throw new Error('Configure the Google OAuth client ID, client secret, and restaurant location ID in .env first.');
  }
  const origin = `http://127.0.0.1:${port}`;
  const redirectUri = `${origin}/google/callback`;
  const session = crypto.randomBytes(32).toString('base64url');
  let pending;
  let stage = 'awaiting_signin';
  let message = '';

  function send(res, status, body, type = 'text/html; charset=utf-8', referrerPolicy = 'no-referrer') {
    res.writeHead(status, {
      'Content-Type': type,
      'Cache-Control': 'no-store',
      'Referrer-Policy': referrerPolicy,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://accounts.google.com; frame-ancestors 'none'; base-uri 'none'",
    });
    res.end(body);
  }

  function page() {
    const connected = stage === 'connected';
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect Google reviews · Red Lantern</title><style>
      *{box-sizing:border-box}body{margin:0;background:#f3f6fb;color:#20304a;font:16px/1.6 system-ui,sans-serif}main{max-width:760px;margin:56px auto;padding:32px;background:white;border:1px solid #e0e7f0;border-radius:20px;box-shadow:0 14px 45px #20304a0a}h1{font-size:28px;line-height:1.2;margin:8px 0 18px}h2{font-size:17px;margin:24px 0 8px}p{color:#52657b}.eyebrow{font-size:12px;font-weight:800;color:#bd2944;letter-spacing:.08em;text-transform:uppercase}code{display:block;padding:12px;background:#f4f7fb;border:1px solid #dfe7f1;border-radius:8px;overflow-wrap:anywhere;font-size:13px}a{color:#9a1d35}button,.button{display:inline-block;border:0;border-radius:10px;padding:13px 20px;background:#bd2944;color:white;font:700 15px system-ui,sans-serif;text-decoration:none;cursor:pointer}.notice{padding:14px 18px;border:1px solid #eed3a7;background:#fff9ef;border-radius:10px}.success{border-color:#b7ddc6;background:#f0faf3}.muted{font-size:13px}li{margin:8px 0}@media(max-width:600px){main{margin:16px;padding:22px}h1{font-size:24px}}
    </style></head><body><main><span class="eyebrow">Red Lantern · Google reviews</span><h1>${connected ? 'Google connection saved' : 'Connect your restaurant’s Google reviews'}</h1>
      ${message ? `<p class="notice ${connected ? 'success' : ''}" role="status">${escapeHtml(message)}</p>` : ''}
      ${connected ? '<p>The Google authorization and matching Business account ID are saved in your local app configuration.</p><p>Return to the chat so the app can reload the connection and import your reviews.</p><a class="button" href="http://localhost:3002/admin">Open restaurant admin</a>' : `
      <p>Sign in with the Google account that owns or manages Red Lantern. This setup identifies the restaurant and checks review access before saving the connection.</p>
      <h2>1. Register this return address in Google Cloud</h2>
      <p>Open <a href="https://console.cloud.google.com/auth/clients" target="_blank" rel="noreferrer">Google Auth Platform → Clients</a> and select the client listed below. For a <strong>Web application</strong> client, add this exact address under <strong>Authorized redirect URIs</strong>, keep your existing addresses, and save. A <strong>Desktop app</strong> client can continue directly with its loopback callback.</p><code>${escapeHtml(redirectUri)}</code>
      <p class="muted">Match the client already configured for this app:</p><code>${escapeHtml(clientId)}</code>
      <h2>2. Authorize with Google</h2><p>After saving the return address, continue below. Google will ask for Business Profile access; the importer uses it to read this restaurant’s reviews.</p>
      <form method="post" action="/connect"><input type="hidden" name="csrf" value="${session}"><button type="submit">Continue with Google</button></form>
      <h2>If Google blocks the connection</h2><ul><li><strong>redirect_uri_mismatch:</strong> add the exact return address above to this OAuth client.</li><li><strong>Access blocked / testing:</strong> add your owner/manager email as a test user in Google Auth Platform → Audience.</li><li><strong>API access:</strong> confirm the project has Business Profile API approval and enable Google My Business API, My Business Account Management API, and My Business Business Information API.</li></ul>
      <p class="muted">Tokens are exchanged on this computer and saved in its ignored .env file. <a href="https://developers.google.com/my-business/content/prereqs" target="_blank" rel="noreferrer">Google’s API access requirements</a></p>`}
    </main></body></html>`;
  }

  async function handle(req, res) {
    if (req.headers.host !== `127.0.0.1:${port}`) {
      send(res, 403, 'Use the local setup address shown in the terminal.');
      return;
    }
    const url = new URL(req.url, origin);
    const cookie = String(req.headers.cookie || '').split(';').map((part) => part.trim())
      .find((part) => part.startsWith('rl_google_setup='))?.slice('rl_google_setup='.length);
    const sessionValid = sameSecret(cookie, session);
    if (req.method === 'GET' && url.pathname === '/status') {
      send(res, 200, JSON.stringify({ stage, message }), 'application/json');
      return;
    }
    if (req.method === 'GET' && url.pathname === '/') {
      res.setHeader('Set-Cookie', `rl_google_setup=${session}; HttpOnly; SameSite=Lax; Path=/; Max-Age=3600`);
      // Native form POSTs inherit this document policy. no-referrer makes Chrome
      // send Origin:null, which correctly fails the same-origin CSRF check below.
      send(res, 200, page(), 'text/html; charset=utf-8', 'same-origin');
      return;
    }
    if (req.method === 'GET' && url.pathname === '/connect') {
      res.writeHead(303, { Location: '/', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
      res.end();
      return;
    }
    if (!sessionValid) {
      send(res, 403, '<p>Open the local setup page in this browser before connecting.</p><p><a href="/">Return to Google setup</a></p>');
      return;
    }
    if (req.method === 'POST' && url.pathname === '/connect') {
      if (req.headers.origin !== origin || stage === 'connecting' || stage === 'connected') {
        send(res, 403, '<p>Open the local setup page to start a new connection.</p><p><a href="/">Return to Google setup</a></p>');
        return;
      }
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 2048) { send(res, 413, 'Request too large.'); return; }
      }
      if (!sameSecret(new URLSearchParams(body).get('csrf'), session)) {
        send(res, 403, '<p>This setup page is out of date.</p><p><a href="/">Reload Google setup and try again</a></p>');
        return;
      }
      const codeVerifier = crypto.randomBytes(48).toString('base64url');
      pending = {
        state: crypto.randomBytes(32).toString('base64url'),
        codeVerifier,
        expiresAt: now() + 10 * 60 * 1000,
      };
      const target = buildAuthorizationUrl({
        clientId, redirectUri, state: pending.state,
        codeChallenge: crypto.createHash('sha256').update(codeVerifier).digest('base64url'),
      });
      stage = 'awaiting_google';
      message = '';
      res.writeHead(303, { Location: target, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
      res.end();
      return;
    }
    if (req.method === 'GET' && url.pathname === '/google/callback') {
      if (!pending || pending.expiresAt <= now() || !sameSecret(url.searchParams.get('state'), pending.state)) {
        send(res, 400, 'This Google sign-in attempt expired or does not match. Return to the setup page and try again.');
        return;
      }
      const flow = pending;
      pending = undefined;
      if (url.searchParams.has('error') || !url.searchParams.get('code')) {
        stage = 'error';
        message = 'Google authorization was not completed. Continue with Google again when ready.';
      } else {
        stage = 'connecting';
        onEvent('Google authorization received. Checking the restaurant and review access.');
        try {
          const tokens = await exchange({
            clientId, clientSecret, redirectUri,
            code: url.searchParams.get('code'), codeVerifier: flow.codeVerifier,
          }, fetchImpl);
          const location = await discover({ accessToken: tokens.accessToken, locationId }, fetchImpl);
          const reviewUrl = new URL(`https://mybusiness.googleapis.com/v4/accounts/${encodeURIComponent(location.accountId)}/locations/${encodeURIComponent(location.locationId)}/reviews`);
          reviewUrl.searchParams.set('pageSize', '1');
          const check = await fetchImpl(reviewUrl, {
            headers: { Authorization: `Bearer ${tokens.accessToken}` },
            signal: AbortSignal.timeout(20000),
          });
          if (!check.ok) {
            throw new GoogleBusinessConnectionError(check.status === 403 || check.status === 429
              ? 'Google sign-in succeeded, but review API access is blocked. Check Business Profile API approval, enabled APIs, and quota in Google Cloud, then retry.'
              : 'Google sign-in succeeded, but this restaurant’s reviews could not be read. Confirm the profile is verified and your account manages it, then retry.');
          }
          await save(envPath, {
            GOOGLE_BUSINESS_ACCOUNT_ID: location.accountId,
            GOOGLE_BUSINESS_LOCATION_ID: location.locationId,
            GOOGLE_BUSINESS_OAUTH_REFRESH_TOKEN: tokens.refreshToken,
            GOOGLE_REVIEWS_SYNC_LIMIT: '0',
          });
          stage = 'connected';
          message = `Connected to ${location.title || 'your restaurant'}. Google review access is verified.`;
          onEvent('Google Business connection verified and saved locally. Restart the app to import reviews.');
        } catch (error) {
          stage = 'error';
          message = error.name === 'TimeoutError' || error.name === 'AbortError'
            ? 'Google took too long to respond. Continue with Google again to retry.'
            : error instanceof GoogleBusinessConnectionError
              ? error.message
              : 'The Google connection could not be completed or saved locally. Check your network and local .env permissions, then try again.';
          onEvent('Google setup needs attention. See the local setup page for details.');
        }
      }
      res.writeHead(303, { Location: '/', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
      res.end();
      return;
    }
    send(res, 404, 'Not found.');
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) send(res, 500, 'Local setup failed. Reload this page and try again.');
      else res.end();
    });
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  return { server, origin, redirectUri, getStatus: () => ({ stage, message }) };
}

if (require.main === module) {
  const setup = createSetupServer({
    clientId: process.env.GOOGLE_BUSINESS_OAUTH_CLIENT_ID,
    clientSecret: process.env.GOOGLE_BUSINESS_OAUTH_CLIENT_SECRET,
    locationId: process.env.GOOGLE_BUSINESS_LOCATION_ID,
    onEvent: (message) => console.log(message),
  });
  setup.server.listen(8765, '127.0.0.1', () => {
    console.log(`Google Business setup: ${setup.origin}`);
    console.log(`Authorized redirect URI: ${setup.redirectUri}`);
  });
  setup.server.on('error', () => {
    console.error('Could not start the local Google setup on port 8765. Check whether it is already running.');
    process.exitCode = 1;
  });
  setTimeout(() => setup.server.close(), 60 * 60 * 1000).unref();
}

module.exports = { createSetupServer, saveConnection };
