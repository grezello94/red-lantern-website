const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const QRCode = require('qrcode');
const ExcelJS = require('exceljs');
const webpush = require('web-push');

const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf8')
    .split(/\r?\n/)
    .forEach((line) => {
      const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
      if (!match || process.env[match[1]]) return;
      process.env[match[1]] = String(match[2] || '')
        .replace(/^["']|["']$/g, '')
        .trim();
    });
}

const multer = require('multer');
const { neon } = require('@neondatabase/serverless');

function cleanEnvUrl(name) {
  if (!process.env[name]) return '';
  const cleanValue = process.env[name]
    .replace(/^["']|["']$/g, '')
    .trim()
    .replace(/^=+/, '');
  process.env[name] = cleanValue;
  return cleanValue;
}

if (process.env.CLOUDINARY_URL) {
  const cleanCloudinaryUrl = cleanEnvUrl('CLOUDINARY_URL');
  if (cleanCloudinaryUrl.startsWith('cloudinary://')) {
    process.env.CLOUDINARY_URL = cleanCloudinaryUrl;
  } else {
    console.warn(
      'Invalid CLOUDINARY_URL format. It should be: cloudinary://API_KEY:API_SECRET@CLOUD_NAME'
    );
    delete process.env.CLOUDINARY_URL;
  }
}

const cloudinary = require('cloudinary').v2;

if (
  process.env.CLOUDINARY_CLOUD_NAME &&
  process.env.CLOUDINARY_API_KEY &&
  process.env.CLOUDINARY_API_SECRET
) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME.trim(),
    api_key: process.env.CLOUDINARY_API_KEY.trim(),
    api_secret: process.env.CLOUDINARY_API_SECRET.trim(),
    secure: true,
  });
} else if (process.env.CLOUDINARY_URL) {
  const cleanUrl = process.env.CLOUDINARY_URL.replace(/^["']|["']$/g, '').trim();
  const match = cleanUrl.match(/^cloudinary:\/\/([^:]+):([^@]+)@(.+)$/);
  if (match) {
    cloudinary.config({
      api_key: match[1].trim(),
      api_secret: match[2].trim(),
      cloud_name: match[3].trim(),
      secure: true,
    });
  } else {
    console.warn(
      '⚠️ CLOUDINARY_URL format looks incorrect. It should be: cloudinary://API_KEY:API_SECRET@CLOUD_NAME'
    );
  }
}

const app = express();
app.set('trust proxy', 1);
const port = process.env.PORT || 3001;
const host = process.env.HOST || '0.0.0.0';
let uploadsDir = process.env.VERCEL
  ? path.join('/tmp', 'red-lantern-uploads')
  : path.join(__dirname, 'uploads');

try {
  fs.mkdirSync(uploadsDir, { recursive: true });
} catch (error) {
  // Local uploads are optional. Never prevent the website from starting because
  // a serverless filesystem is read-only or its temporary storage is unavailable.
  console.warn(`Local uploads disabled: ${error.message}`);
  uploadsDir = null;
}

let sql = null;
const neonDatabaseUrl = cleanEnvUrl('NEON_DATABASE_URL');
if (neonDatabaseUrl) {
  if (neonDatabaseUrl.startsWith('postgresql://') || neonDatabaseUrl.startsWith('postgres://')) {
    try {
      sql = neon(neonDatabaseUrl);
    } catch (error) {
      console.warn(
        'Neon URL format is invalid. Admin saves are disabled until NEON_DATABASE_URL is fixed.'
      );
    }
  } else {
    console.warn(
      'Neon URL format is invalid. It should start with postgresql:// or postgres://. Admin saves are disabled until NEON_DATABASE_URL is fixed.'
    );
  }
} else {
  console.warn('Neon URL not found. Admin page will load, but saving changes is disabled.');
}

let diagnosticsTablePromise = null;
const slowRequestMs = Number(process.env.SLOW_REQUEST_MS || 3500);

function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return String(value || req.ip || req.socket.remoteAddress || 'unknown')
    .split(',')[0]
    .trim();
}

function hashIp(req) {
  return crypto.createHash('sha256').update(clientIp(req)).digest('hex').slice(0, 16);
}

// QR checkout endpoints must remain public, so use a small in-memory guard to
// reduce brute-force lookup and retry storms. Database idempotency remains the
// source of truth; this only protects an individual running server instance.
const publicRequestWindows = new Map();
function allowPublicRequest(req, res, scope, limit, windowMs) {
  const now = Date.now();
  const key = `${scope}:${hashIp(req)}`;
  const previous = (publicRequestWindows.get(key) || []).filter(
    (timestamp) => now - timestamp < windowMs
  );
  if (previous.length >= limit) {
    const retryAfter = Math.max(1, Math.ceil((windowMs - (now - previous[0])) / 1000));
    res.set('Retry-After', String(retryAfter));
    res.status(429).json({ error: 'Too many requests. Please wait a moment and try again.' });
    logDiagnostic({
      level: 'warning',
      category: 'security',
      message: 'Public QR endpoint rate limit reached.',
      method: req.method,
      path: req.path,
      statusCode: 429,
      ipHash: hashIp(req),
      userAgent: req.headers['user-agent'] || '',
      details: { scope },
    });
    return false;
  }
  previous.push(now);
  publicRequestWindows.set(key, previous);
  if (publicRequestWindows.size > 5000) {
    for (const [entryKey, timestamps] of publicRequestWindows)
      if (!timestamps.some((timestamp) => now - timestamp < windowMs))
        publicRequestWindows.delete(entryKey);
  }
  return true;
}

function dailyQrVisitorId(req) {
  const dateBucket = new Date().toISOString().slice(0, 10);
  const secret =
    process.env.AIR_MENU_SECRET || process.env.ADMIN_PASSWORD || 'red-lantern-qr-visitors';
  return crypto
    .createHmac('sha256', secret)
    .update(`${dateBucket}:${clientIp(req)}`)
    .digest('hex')
    .slice(0, 12);
}

function safeScanHeader(value) {
  const text = String(Array.isArray(value) ? value[0] : value || '').slice(0, 120);
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

function qrScanDetails(req, mode) {
  return {
    mode,
    qrType: mode === 'card' ? 'Business Card QR' : 'Table QR',
    country: safeScanHeader(req.headers['x-vercel-ip-country']),
    region: safeScanHeader(req.headers['x-vercel-ip-country-region']),
    city: safeScanHeader(req.headers['x-vercel-ip-city']),
  };
}

function distanceInMetres(aLat, aLng, bLat, bLng) { const r=(value)=>value*Math.PI/180, dLat=r(bLat-aLat), dLng=r(bLng-aLng), a=Math.sin(dLat/2)**2+Math.cos(r(aLat))*Math.cos(r(bLat))*Math.sin(dLng/2)**2; return 6371000*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a)); }

function diagnosticSolution(category, message = '') {
  const text = String(message).toLowerCase();
  if (category === 'security')
    return 'Check the request path and IP hash. If repeated, keep admin credentials strong and consider blocking the source in Vercel Firewall.';
  if (category === 'auth')
    return 'Confirm ADMIN_USERNAME and ADMIN_PASSWORD in Vercel Environment Variables. If failures repeat, rotate the admin password.';
  if (category === 'cms-save' && text.includes('cloudinary'))
    return 'Check CLOUDINARY_URL or Cloudinary API credentials in Vercel, then redeploy and try the image upload again.';
  if (category === 'cms-save' && (text.includes('neon') || text.includes('database')))
    return 'Check NEON_DATABASE_URL in Vercel and confirm the Neon database is active.';
  if (category === 'performance')
    return 'Open Vercel Observability for this path, check database/API calls, and reduce image or payload size if this repeats.';
  if (category === 'frontend')
    return 'Open the listed page in the browser, reproduce the action, and check the script/file named in the log details.';
  if (category === 'orders') {
    if (text.includes('printer') || text.includes('kot'))
      return 'Check that Print Bridge is running on the counter device, the LAN printer is online, and category routing is saved in Orders → Operations.';
    if (text.includes('offline') || text.includes('network') || text.includes('internet'))
      return 'The order was kept safely on the device. Restore the internet connection and leave Orders open so it can sync automatically.';
    if (text.includes('menu') || text.includes('availability'))
      return 'Open Orders → Menu availability, confirm the item is in stock, then refresh the counter menu.';
    return 'Check the Orders console connection and Database Health. If this repeats, copy this log and inspect the listed Orders route.';
  }
  if (category === 'server')
    return 'Check the exact route and stack/location in this log, then inspect the matching server route in server.js.';
  return 'Review the route, message, and details below. If repeated, fix the referenced page or server route first.';
}

function diagnosticLocation(category, pathValue = '', details = {}) {
  if (details.location) return details.location;
  if (category === 'frontend') return details.source || pathValue || 'Browser page';
  if (category === 'cms-save') return `Admin CMS save route: ${pathValue || '/api/update-*'}`;
  if (category === 'auth') return 'Admin authentication middleware';
  if (category === 'security') return 'Request security middleware';
  if (category === 'performance') return `Slow route: ${pathValue || 'unknown'}`;
  if (category === 'orders') return details.source || pathValue || 'Orders console';
  return pathValue || 'Server';
}

async function ensureDiagnosticsTable() {
  if (!sql) return false;
  if (!diagnosticsTablePromise) {
    diagnosticsTablePromise = sql`
      CREATE TABLE IF NOT EXISTS website_diagnostics (
        id BIGSERIAL PRIMARY KEY,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        level TEXT NOT NULL,
        category TEXT NOT NULL,
        message TEXT NOT NULL,
        solution TEXT,
        location TEXT,
        method TEXT,
        path TEXT,
        status_code INTEGER,
        duration_ms INTEGER,
        ip_hash TEXT,
        user_agent TEXT,
        details JSONB NOT NULL DEFAULT '{}'::jsonb
      );
    `;
  }
  await diagnosticsTablePromise;
  return true;
}

async function writeDiagnostic(event = {}) {
  if (!sql) return;
  try {
    await ensureDiagnosticsTable();
    const details = event.details || {};
    const category = event.category || 'server';
    const message = String(event.message || 'Website diagnostic event').slice(0, 500);
    const pathValue = event.path || '';
    await sql`
      INSERT INTO website_diagnostics (
        level, category, message, solution, location, method, path, status_code,
        duration_ms, ip_hash, user_agent, details
      ) VALUES (
        ${event.level || 'info'},
        ${category},
        ${message},
        ${event.solution || diagnosticSolution(category, message)},
        ${event.location || diagnosticLocation(category, pathValue, details)},
        ${event.method || null},
        ${pathValue || null},
        ${event.statusCode || null},
        ${event.durationMs || null},
        ${event.ipHash || null},
        ${event.userAgent || null},
        ${details}
      )
    `;
  } catch (error) {
    console.error('Diagnostic log error:', error.message);
  }
}

function logDiagnostic(event) {
  writeDiagnostic(event).catch((error) => {
    console.error('Diagnostic log error:', error.message);
  });
}

const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: {
    fileSize: 6 * 1024 * 1024,
    files: 12,
  },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype || !file.mimetype.startsWith('image/')) {
      return cb(new Error('Only image uploads are allowed.'));
    }
    return cb(null, true);
  },
});

const menuFileUpload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    const extension = path.extname(file.originalname).toLowerCase();
    const isMenuFile = extension === '.pdf' || extension === '.csv' || extension === '.xlsx';
    cb(isMenuFile ? null : new Error('Please upload a PDF, CSV, or XLSX file.'), isMenuFile);
  },
});
const trustedContactUpload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    const extension = path.extname(file.originalname).toLowerCase();
    cb(extension === '.xlsx' ? null : new Error('Upload an Excel (.xlsx) contacts file.'), extension === '.xlsx');
  },
});

function securityHeaders(req, res, next) {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(self)',
    'Cross-Origin-Resource-Policy': 'same-origin',
  });
  next();
}

function secureCompare(a = '', b = '') {
  const aHash = crypto.createHash('sha256').update(String(a)).digest();
  const bHash = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(aHash, bHash);
}

function isProtectedAdminPath(req) {
  return (
    req.path === '/admin' ||
    req.path === '/admin.html' ||
    req.path === '/admin-cms.js' ||
    req.path === '/api/admin/content' ||
    req.path === '/api/admin/logs' ||
    req.path === '/api/admin/orders-errors' ||
    req.path === '/api/admin/qr-scans' ||
    req.path === '/api/admin/health' ||
    req.path === '/api/admin/customer-insights' ||
    req.path === '/api/admin/trusted-contacts' ||
    req.path.startsWith('/api/admin/trusted-contacts/') ||
    req.path === '/api/admin/table-qr-codes' ||
    req.path.startsWith('/api/admin/table-qr-codes/') ||
    req.path.startsWith('/api/admin/qr/') ||
    req.path.startsWith('/api/admin/air-menu/') ||
    req.path.startsWith('/api/update-') ||
    req.path === '/api/growth-ai'
  );
}

const adminAttempts = new Map();
const maxAdminFailures = 8;
const adminLockMs = 15 * 60 * 1000;

function adminAttemptKey(req) {
  return req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
}

function isAdminLocked(req) {
  const key = adminAttemptKey(req);
  const entry = adminAttempts.get(key);
  if (!entry) return false;
  if (Date.now() > entry.lockUntil) {
    adminAttempts.delete(key);
    return false;
  }
  return entry.failures >= maxAdminFailures;
}

function recordAdminFailure(req) {
  const key = adminAttemptKey(req);
  const entry = adminAttempts.get(key) || { failures: 0, lockUntil: 0 };
  entry.failures += 1;
  if (entry.failures >= maxAdminFailures) entry.lockUntil = Date.now() + adminLockMs;
  adminAttempts.set(key, entry);
}

function clearAdminFailures(req) {
  adminAttempts.delete(adminAttemptKey(req));
}

function requireAdmin(req, res, next) {
  if (!isProtectedAdminPath(req)) return next();

  if (isAdminLocked(req)) {
    logDiagnostic({
      level: 'error',
      category: 'auth',
      message: 'Admin login temporarily locked after repeated failures.',
      method: req.method,
      path: req.path,
      statusCode: 429,
      ipHash: hashIp(req),
      userAgent: req.headers['user-agent'] || '',
      details: { failures: maxAdminFailures },
    });
    return res.status(429).send('Too many failed login attempts. Try again later.');
  }

  const expectedUser = process.env.ADMIN_USERNAME;
  const expectedPass = process.env.ADMIN_PASSWORD;
  if (!expectedUser || !expectedPass) {
    console.error('Admin access is disabled because ADMIN_USERNAME or ADMIN_PASSWORD is missing.');
    logDiagnostic({
      level: 'error',
      category: 'auth',
      message: 'Admin access is disabled because ADMIN_USERNAME or ADMIN_PASSWORD is missing.',
      method: req.method,
      path: req.path,
      statusCode: 503,
      ipHash: hashIp(req),
      userAgent: req.headers['user-agent'] || '',
    });
    return res.status(503).send('Admin access is not configured.');
  }

  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme !== 'Basic' || !encoded) {
    res.set('WWW-Authenticate', 'Basic realm="Red Lantern Admin", charset="UTF-8"');
    return res.status(401).send('Authentication required.');
  }

  const [username, ...passwordParts] = Buffer.from(encoded, 'base64').toString('utf8').split(':');
  const password = passwordParts.join(':');
  if (secureCompare(username, expectedUser) && secureCompare(password, expectedPass)) {
    clearAdminFailures(req);
    return next();
  }

  recordAdminFailure(req);
  logDiagnostic({
    level: 'warning',
    category: 'auth',
    message: 'Failed admin login attempt.',
    method: req.method,
    path: req.path,
    statusCode: 401,
    ipHash: hashIp(req),
    userAgent: req.headers['user-agent'] || '',
    details: { username: username ? 'provided' : 'missing' },
  });
  res.set('WWW-Authenticate', 'Basic realm="Red Lantern Admin", charset="UTF-8"');
  return res.status(401).send('Invalid username or password.');
}

async function requireOrdersConsole(req, res, next) {
  const captainReadRoute =
    req.method === 'GET' &&
    [
      '/api/orders',
      '/api/orders/operations',
      '/api/orders/menu',
      '/api/orders/availability',
      '/api/captain/menu-insights',
    ].includes(req.path);
  const captainOrderRoute = req.method === 'POST' && req.path === '/api/orders/counter';
  const captainKotRoute = req.method === 'POST' && /^\/api\/orders\/[^/]+\/kots$/.test(req.path);
  const captainSession = req.get('X-Captain-Session');
  const captainRoute = captainReadRoute || captainOrderRoute || captainKotRoute;
  const captain =
    captainRoute && captainSession ? await getActiveCaptainSession(captainSession) : null;
  if (captain) {
    req.captain = captain;
    return next();
  }
  if (captainRoute && captainSession)
    return res.status(401).json({ error: 'Captain sign-in has expired. Sign in again.' });
  const protectedPath =
    req.path === '/orders' ||
    req.path === '/orders.html' ||
    req.path === '/register' ||
    req.path === '/register.html' ||
    req.path === '/register.js' ||
    req.path === '/register.css' ||
    req.path === '/orders.js' ||
    req.path === '/orders.css' ||
    req.path.startsWith('/api/orders');
  if (!protectedPath) return next();
  const username = process.env.ORDERS_USERNAME;
  const password = process.env.ORDERS_PASSWORD;
  if (!username || !password)
    return res
      .status(503)
      .send('Orders console is not configured. Add ORDERS_USERNAME and ORDERS_PASSWORD.');
  const [scheme, encoded] = String(req.headers.authorization || '').split(' ');
  const [providedUser, ...providedPassword] =
    scheme === 'Basic' && encoded ? Buffer.from(encoded, 'base64').toString('utf8').split(':') : [];
  if (
    !secureCompare(providedUser || '', username) ||
    !secureCompare(providedPassword.join(':'), password)
  ) {
    res.set('WWW-Authenticate', 'Basic realm="Red Lantern Orders", charset="UTF-8"');
    return res.status(401).send('Authentication required.');
  }
  next();
}

function requestDiagnostics(req, res, next) {
  const started = Date.now();
  res.on('finish', () => {
    const durationMs = Date.now() - started;
    if (res.statusCode >= 500) {
      logDiagnostic({
        level: 'error',
        category: 'server',
        message: `Server returned ${res.statusCode} for ${req.method} ${req.path}.`,
        method: req.method,
        path: req.path,
        statusCode: res.statusCode,
        durationMs,
        ipHash: hashIp(req),
        userAgent: req.headers['user-agent'] || '',
      });
    } else if (durationMs >= slowRequestMs && !req.path.startsWith('/api/admin/logs')) {
      logDiagnostic({
        level: 'warning',
        category: 'performance',
        message: `Slow request: ${req.method} ${req.path} took ${durationMs}ms.`,
        method: req.method,
        path: req.path,
        statusCode: res.statusCode,
        durationMs,
        ipHash: hashIp(req),
        userAgent: req.headers['user-agent'] || '',
      });
    }
  });
  next();
}

function blockSensitiveFiles(req, res, next) {
  let requestPath = req.path;
  try {
    requestPath = decodeURIComponent(req.path).replace(/\\/g, '/');
  } catch {
    return res.status(400).send('Bad request.');
  }
  const basename = path.basename(requestPath);
  const blockedRoots = ['/.git', '/.vercel', '/node_modules'];
  const blockedFiles = new Set([
    '.env',
    '.env.local',
    '.env.example',
    '.gitignore',
    'server.js',
    'init-db.js',
    'package.json',
    'package-lock.json',
    'vercel.json',
    'claude-install.ps1',
  ]);

  if (
    blockedRoots.some((root) => requestPath === root || requestPath.startsWith(`${root}/`)) ||
    blockedFiles.has(basename)
  ) {
    logDiagnostic({
      level: 'warning',
      category: 'security',
      message: `Blocked request for sensitive file or folder: ${requestPath}`,
      method: req.method,
      path: requestPath,
      statusCode: 404,
      ipHash: hashIp(req),
      userAgent: req.headers['user-agent'] || '',
    });
    return res.status(404).send('Not found.');
  }

  return next();
}

app.use(securityHeaders);
app.use(requestDiagnostics);
app.use(requireAdmin);
app.use(requireOrdersConsole);
app.use(blockSensitiveFiles);

const cleanPageRoutes = new Map([
  ['/home', 'index.html'],
  ['/menu', 'menu.html'],
  ['/about', 'about.html'],
  ['/blogs', 'blogs.html'],
  ['/contact', 'contact.html'],
  ['/blog', 'blog-post.html'],
  ['/orders', 'orders.html'],
  ['/register', 'register.html'],
  ['/captain', 'captain.html'],
  ['/track-order', 'track-order.html'],
]);

const legacyPageRedirects = new Map([
  ['/index.html', '/home'],
  ['/menu.html', '/menu'],
  ['/about.html', '/about'],
  ['/blogs.html', '/blogs'],
  ['/contact.html', '/contact'],
]);

app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  if (req.path === '/') return res.redirect(301, '/home');
  if (req.path === '/air-menu.html') return res.redirect(302, '/menu');
  if (req.path === '/blog-post.html') {
    const slug = String(req.query.slug || '').trim();
    return res.redirect(301, slug ? `/blog/${encodeURIComponent(slug)}` : '/blog');
  }
  if (legacyPageRedirects.has(req.path))
    return res.redirect(301, legacyPageRedirects.get(req.path));
  return next();
});

app.use(
  express.static(__dirname, {
    dotfiles: 'deny',
    index: false,
    maxAge: '1h',
    setHeaders: (res, filePath) => {
      const publicPath = String(filePath).replace(/\\/g, '/');
      if (
        /\/(?:orders|register|captain|track-order)(?:\.html|\.js|\.css|-fixes\.css|-logo\.css|-sw\.js|\.webmanifest)$/i.test(
          publicPath
        )
      ) {
        res.set('Cache-Control', 'no-store, max-age=0');
        return;
      }
      if (/\.(?:avif|webp|png|jpe?g|gif|svg|ico)$/i.test(filePath)) {
        res.set('Cache-Control', 'public, max-age=604800, immutable');
      } else if (/\.(?:css|js)$/i.test(filePath)) {
        res.set('Cache-Control', 'public, max-age=3600, stale-while-revalidate=86400');
      }
    },
  })
);
if (uploadsDir) {
  app.use(
    '/uploads',
    express.static(uploadsDir, {
      dotfiles: 'deny',
      index: false,
      maxAge: '7d',
      immutable: true,
    })
  );
}
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(express.json({ limit: '1mb' }));

const collections = {
  home: 'home_content',
  menu: 'menu_content',
  airMenu: 'air_menu_content',
  about: 'about_content',
  blogs: 'blogs_content',
  contact: 'contact_content',
  captain: 'captain_content',
  global: 'global_content',
};

const labels = {
  home: 'Home Page',
  menu: 'Menu Page',
  airMenu: 'Air Menu',
  about: 'About Page',
  blogs: 'Blogs Page',
  contact: 'Contact Page',
  captain: 'Captain App',
  global: 'Global Settings',
};

let publicContentCache = null;
let contentRevisionsTableReady = null;
let directOrdersTableReady = null;
let kotsTableReady = null;
let loyaltyTableReady = null;
let trustedContactsTableReady = null;
let creditTableReady = null;
let menuAvailabilityTableReady = null;
let pushSubscriptionsTableReady = null;
let operationsConfigTableReady = null;
let orderPrintJobsTableReady = null;
let kotStationStatusTableReady = null;
let kotRoundStatusTableReady = null;
let orderEventsTableReady = null;
async function ensureOrderEventsTable() {
  if (!sql) throw new Error('Orders database is not configured.');
  if (!orderEventsTableReady)
    orderEventsTableReady = (async () => {
      await sql`CREATE TABLE IF NOT EXISTS order_events (event_id BIGSERIAL PRIMARY KEY, order_id TEXT NOT NULL, event_type TEXT NOT NULL, details JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`;
      await sql`CREATE INDEX IF NOT EXISTS order_events_order_created_index ON order_events (order_id, created_at DESC)`;
    })();
  return orderEventsTableReady;
}
async function recordOrderEvent(orderId, eventType, details = {}) {
  try {
    if (!orderId) return;
    await ensureOrderEventsTable();
    await sql`INSERT INTO order_events (order_id,event_type,details) VALUES (${String(orderId).slice(0, 120)},${String(eventType).slice(0, 80)},${JSON.stringify(details || {})})`;
  } catch (error) {
    console.error(`Order event log failed (${eventType}):`, error.message);
  }
}
async function ensureKotStationStatusTable() {
  if (!sql) throw new Error('Orders database is not configured.');
  if (!kotStationStatusTableReady)
    kotStationStatusTableReady = sql`CREATE TABLE IF NOT EXISTS order_kot_station_status (order_id TEXT NOT NULL, printer_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'accepted', updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (order_id, printer_id))`;
  return kotStationStatusTableReady;
}
async function ensureKotRoundStatusTable() {
  if (!sql) throw new Error('Orders database is not configured.');
  if (!kotRoundStatusTableReady)
    kotRoundStatusTableReady = sql`CREATE TABLE IF NOT EXISTS order_kot_round_status (order_id TEXT NOT NULL, kot_number INTEGER NOT NULL, printer_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'accepted', updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (order_id, kot_number, printer_id))`;
  return kotRoundStatusTableReady;
}
async function ensureOrderPrintJobsTable() {
  if (!sql) throw new Error('Orders database is not configured.');
  if (!orderPrintJobsTableReady)
    orderPrintJobsTableReady = sql`CREATE TABLE IF NOT EXISTS order_print_jobs (order_id TEXT NOT NULL, job_type TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', lease_expires_at TIMESTAMPTZ, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), PRIMARY KEY (order_id, job_type))`;
  return orderPrintJobsTableReady;
}
async function ensureOperationsConfigTable() {
  if (!sql) throw new Error('Orders database is not configured.');
  if (!operationsConfigTableReady)
    operationsConfigTableReady = sql`CREATE TABLE IF NOT EXISTS order_operations_config (config_key TEXT PRIMARY KEY, config JSONB NOT NULL DEFAULT '{"printers":[],"routes":[]}'::jsonb, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`;
  return operationsConfigTableReady;
}
async function ensureMenuAvailabilityTable() {
  if (!sql) throw new Error('Orders database is not configured.');
  if (!menuAvailabilityTableReady)
    menuAvailabilityTableReady = sql`CREATE TABLE IF NOT EXISTS menu_availability (item_key TEXT PRIMARY KEY, unavailable_until TIMESTAMPTZ NOT NULL)`;
  return menuAvailabilityTableReady;
}
async function ensureDirectOrdersTable() {
  if (!sql) throw new Error('Orders database is not configured.');
  if (!directOrdersTableReady)
    directOrdersTableReady = (async () => {
      await sql`CREATE TABLE IF NOT EXISTS direct_orders (id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'new', mode TEXT NOT NULL, customer_name TEXT, customer_phone TEXT NOT NULL, special_request TEXT, items JSONB NOT NULL, total NUMERIC NOT NULL DEFAULT 0, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`;
      await sql`ALTER TABLE direct_orders ADD COLUMN IF NOT EXISTS order_day DATE`;
      await sql`ALTER TABLE direct_orders ADD COLUMN IF NOT EXISTS daily_order_number INTEGER`;
      await sql`ALTER TABLE direct_orders ADD COLUMN IF NOT EXISTS bill_year INTEGER`;
      await sql`ALTER TABLE direct_orders ADD COLUMN IF NOT EXISTS bill_number INTEGER`;
      await sql`ALTER TABLE direct_orders ADD COLUMN IF NOT EXISTS tracking_token TEXT`;
      await sql`ALTER TABLE direct_orders ADD COLUMN IF NOT EXISTS cancellation_reason TEXT`;
      await sql`ALTER TABLE direct_orders ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ`;
      await sql`ALTER TABLE direct_orders ADD COLUMN IF NOT EXISTS loyalty_points_redeemed INTEGER NOT NULL DEFAULT 0`;
      await sql`ALTER TABLE direct_orders ADD COLUMN IF NOT EXISTS loyalty_points_earned INTEGER NOT NULL DEFAULT 0`;
      await sql`ALTER TABLE direct_orders ADD COLUMN IF NOT EXISTS loyalty_awarded_at TIMESTAMPTZ`;
      await sql`ALTER TABLE direct_orders ADD COLUMN IF NOT EXISTS fulfillment_type TEXT`;
      await sql`ALTER TABLE direct_orders ADD COLUMN IF NOT EXISTS client_request_id TEXT`;
      await sql`ALTER TABLE direct_orders ADD COLUMN IF NOT EXISTS table_area TEXT`;
      await sql`ALTER TABLE direct_orders ADD COLUMN IF NOT EXISTS table_number INTEGER`;
      await sql`ALTER TABLE direct_orders ADD COLUMN IF NOT EXISTS bill_printed_at TIMESTAMPTZ`;
      await sql`ALTER TABLE direct_orders ADD COLUMN IF NOT EXISTS settled_at TIMESTAMPTZ`;
      await sql`ALTER TABLE direct_orders ADD COLUMN IF NOT EXISTS settlement_type TEXT`;
      await sql`ALTER TABLE direct_orders ADD COLUMN IF NOT EXISTS settlement_amount NUMERIC`;
      await sql`ALTER TABLE direct_orders ADD COLUMN IF NOT EXISTS payment_received NUMERIC`;
      await sql`ALTER TABLE direct_orders ADD COLUMN IF NOT EXISTS change_due NUMERIC NOT NULL DEFAULT 0`;
      await sql`ALTER TABLE direct_orders ADD COLUMN IF NOT EXISTS tip_amount NUMERIC NOT NULL DEFAULT 0`;
      await sql`ALTER TABLE direct_orders ADD COLUMN IF NOT EXISTS settlement_request_id TEXT`;
      await sql`ALTER TABLE direct_orders ADD COLUMN IF NOT EXISTS service_state TEXT NOT NULL DEFAULT 'active'`;
      await sql`ALTER TABLE direct_orders ADD COLUMN IF NOT EXISTS service_requested_at TIMESTAMPTZ`;
      await sql`UPDATE direct_orders SET order_day=(created_at AT TIME ZONE 'Asia/Kolkata')::date WHERE order_day IS NULL`;
      await sql`WITH numbered AS (SELECT id, ROW_NUMBER() OVER (PARTITION BY order_day ORDER BY created_at, id)::integer AS daily_number FROM direct_orders) UPDATE direct_orders AS orders SET daily_order_number=numbered.daily_number FROM numbered WHERE orders.id=numbered.id AND orders.daily_order_number IS NULL`;
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS direct_orders_day_number_unique ON direct_orders (order_day, daily_order_number) WHERE daily_order_number IS NOT NULL`;
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS direct_orders_bill_year_number_unique ON direct_orders (bill_year, bill_number) WHERE bill_year IS NOT NULL AND bill_number IS NOT NULL`;
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS direct_orders_tracking_token_unique ON direct_orders (tracking_token) WHERE tracking_token IS NOT NULL`;
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS direct_orders_client_request_unique ON direct_orders (client_request_id) WHERE client_request_id IS NOT NULL`;
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS direct_orders_settlement_request_unique ON direct_orders (settlement_request_id) WHERE settlement_request_id IS NOT NULL`;
      await sql`CREATE INDEX IF NOT EXISTS direct_orders_day_created_index ON direct_orders (order_day, created_at DESC)`;
      await sql`CREATE INDEX IF NOT EXISTS direct_orders_phone_created_index ON direct_orders (customer_phone, created_at DESC)`;
      await sql`CREATE TABLE IF NOT EXISTS direct_order_counters (order_day DATE PRIMARY KEY, next_number INTEGER NOT NULL)`;
      await sql`CREATE TABLE IF NOT EXISTS direct_order_bill_counters (bill_year INTEGER PRIMARY KEY, next_number INTEGER NOT NULL)`;
    })();
  return directOrdersTableReady;
}
async function ensureKotsTable() {
  if (!sql) throw new Error('Orders database is not configured.');
  if (!kotsTableReady)
    kotsTableReady = (async () => {
      await sql`CREATE TABLE IF NOT EXISTS order_kots (kot_number BIGSERIAL PRIMARY KEY, order_id TEXT NOT NULL, order_number INTEGER, tickets JSONB NOT NULL DEFAULT '[]'::jsonb, item_fingerprint TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`;
      await sql`ALTER TABLE order_kots ADD COLUMN IF NOT EXISTS item_fingerprint TEXT`;
      await sql`ALTER TABLE order_kots ADD COLUMN IF NOT EXISTS kot_day DATE`;
      await sql`ALTER TABLE order_kots ADD COLUMN IF NOT EXISTS daily_kot_number INTEGER`;
      await sql`UPDATE order_kots SET kot_day=(created_at AT TIME ZONE 'Asia/Kolkata')::date WHERE kot_day IS NULL`;
      await sql`WITH numbered AS (SELECT kot_number, ROW_NUMBER() OVER (PARTITION BY kot_day ORDER BY created_at, kot_number)::integer AS daily_number FROM order_kots) UPDATE order_kots AS kots SET daily_kot_number=numbered.daily_number FROM numbered WHERE kots.kot_number=numbered.kot_number AND kots.daily_kot_number IS NULL`;
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS order_kots_day_number_unique ON order_kots (kot_day, daily_kot_number) WHERE daily_kot_number IS NOT NULL`;
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS order_kots_fingerprint_unique ON order_kots (order_id, item_fingerprint) WHERE item_fingerprint IS NOT NULL`;
      await sql`CREATE TABLE IF NOT EXISTS order_kot_counters (kot_day DATE PRIMARY KEY, next_number INTEGER NOT NULL)`;
    })();
  return kotsTableReady;
}
async function ensureLoyaltyTable() {
  if (!sql) throw new Error('Orders database is not configured.');
  if (!loyaltyTableReady)
    loyaltyTableReady = (async () => {
      await sql`CREATE TABLE IF NOT EXISTS loyalty_accounts (customer_phone TEXT PRIMARY KEY, points INTEGER NOT NULL DEFAULT 0 CHECK (points >= 0), total_earned INTEGER NOT NULL DEFAULT 0, total_redeemed INTEGER NOT NULL DEFAULT 0, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`;
      await sql`ALTER TABLE loyalty_accounts ADD COLUMN IF NOT EXISTS total_earned INTEGER NOT NULL DEFAULT 0`;
      await sql`ALTER TABLE loyalty_accounts ADD COLUMN IF NOT EXISTS total_redeemed INTEGER NOT NULL DEFAULT 0`;
      await sql`ALTER TABLE loyalty_accounts ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`;
    })();
  return loyaltyTableReady;
}
async function ensureTrustedContactsTable() {
  if (!sql) throw new Error('Orders database is not configured.');
  await ensureDirectOrdersTable();
  if (!trustedContactsTableReady)
    trustedContactsTableReady = (async () => {
      await sql`CREATE TABLE IF NOT EXISTS trusted_contacts (customer_phone TEXT PRIMARY KEY, customer_name TEXT NOT NULL DEFAULT '', blocked BOOLEAN NOT NULL DEFAULT FALSE, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`;
      await sql`CREATE INDEX IF NOT EXISTS trusted_contacts_active_index ON trusted_contacts (blocked, updated_at DESC)`;
      await sql`INSERT INTO trusted_contacts (customer_phone,customer_name) SELECT DISTINCT ON (customer_phone) customer_phone,COALESCE(customer_name,'') FROM direct_orders WHERE status='completed' ORDER BY customer_phone,created_at DESC ON CONFLICT (customer_phone) DO NOTHING`;
    })();
  return trustedContactsTableReady;
}
async function ensureCreditTable() {
  if (!sql) throw new Error('Orders database is not configured.');
  if (!creditTableReady)
    creditTableReady = sql`CREATE TABLE IF NOT EXISTS customer_credit (customer_phone TEXT PRIMARY KEY, balance NUMERIC NOT NULL DEFAULT 0 CHECK (balance >= 0), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`;
  return creditTableReady;
}
function kolkataOrderDay(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const value = Object.fromEntries(
    parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value])
  );
  return `${value.year}-${value.month}-${value.day}`;
}
async function nextDailyOrderNumber() {
  await ensureDirectOrdersTable();
  const orderDay = kolkataOrderDay();
  const rows =
    await sql`INSERT INTO direct_order_counters (order_day, next_number) SELECT ${orderDay}::date, COALESCE(MAX(daily_order_number), 0) + 1 FROM direct_orders WHERE order_day=${orderDay}::date ON CONFLICT (order_day) DO UPDATE SET next_number=direct_order_counters.next_number + 1 RETURNING next_number`;
  return { orderDay, number: Number(rows[0].next_number) };
}
async function nextAnnualBillNumber() {
  await ensureDirectOrdersTable();
  const billYear = Number(kolkataOrderDay().slice(0, 4));
  const rows =
    await sql`INSERT INTO direct_order_bill_counters (bill_year, next_number) SELECT ${billYear}, COALESCE(MAX(bill_number), 0) + 1 FROM direct_orders WHERE bill_year=${billYear} ON CONFLICT (bill_year) DO UPDATE SET next_number=direct_order_bill_counters.next_number + 1 RETURNING next_number`;
  return { billYear, number: Number(rows[0].next_number) };
}
async function nextDailyKotNumber() {
  await ensureKotsTable();
  const kotDay = kolkataOrderDay();
  const rows =
    await sql`INSERT INTO order_kot_counters (kot_day, next_number) SELECT ${kotDay}::date, COALESCE(MAX(daily_kot_number), 0) + 1 FROM order_kots WHERE kot_day=${kotDay}::date ON CONFLICT (kot_day) DO UPDATE SET next_number=order_kot_counters.next_number + 1 RETURNING next_number`;
  return { kotDay, number: Number(rows[0].next_number) };
}
async function ensurePushSubscriptionsTable() {
  if (!sql) throw new Error('Orders database is not configured.');
  if (!pushSubscriptionsTableReady)
    pushSubscriptionsTableReady = sql`CREATE TABLE IF NOT EXISTS order_push_subscriptions (endpoint TEXT PRIMARY KEY, subscription JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`;
  return pushSubscriptionsTableReady;
}
let pushEnabled = false;
try {
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY && process.env.VAPID_SUBJECT) {
    webpush.setVapidDetails(
      process.env.VAPID_SUBJECT,
      process.env.VAPID_PUBLIC_KEY,
      process.env.VAPID_PRIVATE_KEY
    );
    pushEnabled = true;
  }
} catch (error) {
  console.warn('Web push is disabled because VAPID settings are invalid:', error.message);
}
async function notifyDirectOrder(order) {
  if (!pushEnabled || !sql) return;
  try {
    await ensurePushSubscriptionsTable();
    const subscriptions = await sql`SELECT endpoint, subscription FROM order_push_subscriptions`;
    const dailyOrder = String(order.dailyOrderNumber || '').padStart(2, '0');
    const payload = JSON.stringify({
      title: `New Order #${dailyOrder}`,
      body: `${order.itemCount} item${order.itemCount === 1 ? '' : 's'} · ₹${Number(order.total || 0).toFixed(0)}`,
      url: '/orders',
      tag: `order-${order.id}`,
    });
    const results = await Promise.allSettled(
      subscriptions.map((row) => webpush.sendNotification(row.subscription, payload))
    );
    await Promise.all(
      results.map((result, index) => {
        const statusCode = result.status === 'rejected' ? result.reason?.statusCode : 0;
        return statusCode === 404 || statusCode === 410
          ? sql`DELETE FROM order_push_subscriptions WHERE endpoint=${subscriptions[index].endpoint}`
          : Promise.resolve();
      })
    );
  } catch (error) {
    console.warn('Order push notification failed:', error.message);
  }
}
const publicContentCacheMs = Number(process.env.PUBLIC_CONTENT_CACHE_MS || 60000);

function clearPublicContentCache() {
  publicContentCache = null;
}

const asArray = (value) => {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
};

const slugify = (value) =>
  String(value || '')
    .toLowerCase()
    .trim()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || `post-${Date.now()}`;

const firstFile = (files, name) => {
  const file = files.find((item) => item.fieldname === name);
  return file ? file.publicUrl : '';
};

const indexedFile = (files, name, index) => {
  const file = files.find((item) => item.fieldname === `${name}_${index}`);
  return file ? file.publicUrl : '';
};

async function getSection(section) {
  if (!sql) return {};
  try {
    const rows = await sql`SELECT data FROM website_content WHERE id = ${collections[section]}`;
    return rows.length ? rows[0].data || {} : {};
  } catch (err) {
    console.error('Neon DB Error:', err);
    return {};
  }
}

async function ensureContentRevisionsTable() {
  if (!sql) throw new Error('Neon is not configured.');
  if (!contentRevisionsTableReady)
    contentRevisionsTableReady = (async () => {
      await sql`CREATE TABLE IF NOT EXISTS website_content_revisions (revision_id BIGSERIAL PRIMARY KEY, section TEXT NOT NULL, data JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`;
      await sql`CREATE INDEX IF NOT EXISTS website_content_revisions_section_created_index ON website_content_revisions (section, created_at DESC)`;
    })();
  return contentRevisionsTableReady;
}

async function saveSection(section, data) {
  if (!sql) throw new Error('Neon is not configured. Add NEON_DATABASE_URL to your .env file.');
  const existing = await getSection(section);
  const merged = { ...existing, ...data };
  if (section === 'airMenu' && Object.keys(existing).length) {
    await ensureContentRevisionsTable();
    await sql`INSERT INTO website_content_revisions (section, data) VALUES (${section}, ${existing})`;
    await sql`DELETE FROM website_content_revisions WHERE section=${section} AND revision_id NOT IN (SELECT revision_id FROM website_content_revisions WHERE section=${section} ORDER BY revision_id DESC LIMIT 30)`;
  }
  await sql`
    INSERT INTO website_content (id, data) 
    VALUES (${collections[section]}, ${merged})
    ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data
  `;
  if (section === 'airMenu') ordersOperatingStatusCache.expiresAt = 0;
}

function normalizeHome(body, files) {
  const reviewNames = asArray(body.reviewName);
  const reviewStars = asArray(body.reviewStars);
  const reviewTexts = asArray(body.reviewText);

  return {
    heroTitle: body.heroTitle,
    heroSubtitle: body.heroSubtitle,
    heroImage: firstFile(files, 'heroImage') || body.currentHeroImage || '',
    welcomeTitle: body.welcomeTitle,
    welcomeText: body.welcomeText,
    welcomeImage: firstFile(files, 'welcomeImage') || body.currentWelcomeImage || '',
    featureOneTitle: body.featureOneTitle,
    featureOneText: body.featureOneText,
    featureTwoTitle: body.featureTwoTitle,
    featureTwoText: body.featureTwoText,
    featureThreeTitle: body.featureThreeTitle,
    featureThreeText: body.featureThreeText,
    blogSectionTitle: body.blogSectionTitle,
    blogSectionSubtitle: body.blogSectionSubtitle,
    reviews: reviewNames
      .map((name, index) => ({
        name,
        stars: reviewStars[index] || '★★★★★',
        text: reviewTexts[index] || '',
      }))
      .filter((review) => review.name || review.text),
  };
}

function normalizeMenu(body, files) {
  const names = asArray(body.dishName);
  const prices = asArray(body.dishPrice);
  const descriptions = asArray(body.dishDesc);
  const categories = asArray(body.dishCategory);
  const badges = asArray(body.dishBadge);
  const currentImages = asArray(body.currentDishImage);

  return {
    pageTitle: body.menuPageTitle || 'Our Menu',
    pageSubtitle:
      body.menuPageSubtitle ||
      'Explore our diverse selection of authentic Chinese and Goan dishes.',
    note:
      body.menuNote || 'Menu availability may vary. Please call us for pricing and daily specials.',
    dishes: names
      .map((name, index) => ({
        name,
        price: prices[index] || '',
        description: descriptions[index] || '',
        category: categories[index] || 'Signature Dishes',
        badge: badges[index] || '',
        image: indexedFile(files, 'dishPhoto', index) || currentImages[index] || '',
      }))
      .filter((dish) => dish.name),
  };
}

function dietaryFromMenuCategory(category) {
  const value = String(category || '').trim();
  if (/\bnon\s*[-/]?\s*veg\b|\bnonveg\b/i.test(value)) return 'nonveg';
  if (/\bveg(?:etarian)?\b/i.test(value)) return 'veg';
  return '';
}

function normalizeAirMenu(body) {
  const names = asArray(body.airItemName);
  const prices = asArray(body.airItemPrice);
  const fullPrices = asArray(body.airItemFullPrice);
  const halfPrices = asArray(body.airItemHalfPrice);
  const withBonePrices = asArray(body.airItemWithBonePrice);
  const bonelessPrices = asArray(body.airItemBonelessPrice);
  const categories = asArray(body.airItemCategory);
  const types = asArray(body.airItemType);
  const descriptions = asArray(body.airItemDescription);
  const dietaryValues = asArray(body.airItemDietary);
  const bestSellers = asArray(body.airItemBestSeller);
  const mustHaves = asArray(body.airItemMustHave);
  const gravyStyleAvailable = asArray(body.airItemGravyStyleAvailable);
  const barNames = asArray(body.airBarItemName);
  const barPrices = asArray(body.airBarItemPrice);
  const bar30mlPrices = asArray(body.airBarItem30mlPrice);
  const bar60mlPrices = asArray(body.airBarItem60mlPrice);
  const bar90mlPrices = asArray(body.airBarItem90mlPrice);
  const bar180mlPrices = asArray(body.airBarItem180mlPrice);
  const barCategories = asArray(body.airBarItemCategory);
  const barTypes = asArray(body.airBarItemType);
  const barDescriptions = asArray(body.airBarItemDescription);
  const barBestSellers = asArray(body.airBarItemBestSeller);
  let categoryVisibility = {};
  try {
    const parsed = JSON.parse(body.airCategoryVisibility || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) categoryVisibility = parsed;
  } catch {
    categoryVisibility = {};
  }
  let categoryOrder = [];
  try {
    const parsed = JSON.parse(body.airCategoryOrder || '[]');
    if (Array.isArray(parsed))
      categoryOrder = parsed
        .map((category) => String(category || '').trim())
        .filter(Boolean)
        .slice(0, 200);
  } catch {
    categoryOrder = [];
  }
  let addonGroups = [];
  try {
    const parsed = JSON.parse(body.airAddonGroups || '[]');
    if (Array.isArray(parsed))
      addonGroups = parsed
        .slice(0, 100)
        .map((group) => {
          const selection = group.selection === 'multiple' ? 'multiple' : 'single',
            max =
              selection === 'single'
                ? 1
                : Math.max(1, Math.min(20, Math.floor(Number(group.max) || 1))),
            min = Math.min(max, Math.max(0, Math.min(20, Math.floor(Number(group.min) || 0))));
          return {
            id: String(group.id || crypto.randomUUID())
              .replace(/[^a-zA-Z0-9_-]/g, '')
              .slice(0, 60),
            name: String(group.name || '')
              .trim()
              .slice(0, 80),
            displayName: String(group.displayName || '')
              .trim()
              .slice(0, 100),
            min,
            max,
            selection,
            active: group.active !== false,
            options: (Array.isArray(group.options) ? group.options : [])
              .slice(0, 50)
              .map((option) => ({
                name: String(option.name || '')
                  .trim()
                  .slice(0, 80),
                price: Math.max(0, Math.min(100000, Number(option.price) || 0)),
                dietary: option.dietary === 'nonveg' ? 'nonveg' : 'veg',
              }))
              .filter((option) => option.name),
          };
        })
        .filter((group) => group.id && group.name);
  } catch {
    addonGroups = [];
  }
  let tableQrDisabled = {};
  try {
    const parsed = JSON.parse(body.airTableQrDisabled || '{}');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) tableQrDisabled = parsed;
  } catch {
    tableQrDisabled = {};
  }
  const isValidTime = (value) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value || ''));
  const proximity={ latitude:Number.isFinite(Number(body.airProximityLatitude))&&Number(body.airProximityLatitude)>=-90&&Number(body.airProximityLatitude)<=90?Number(body.airProximityLatitude):null, longitude:Number.isFinite(Number(body.airProximityLongitude))&&Number(body.airProximityLongitude)>=-180&&Number(body.airProximityLongitude)<=180?Number(body.airProximityLongitude):null, tableRadius:Math.max(0,Math.min(100000,Math.floor(Number(body.airTableProximityRadius)||0))), cardRadius:Math.max(0,Math.min(100000,Math.floor(Number(body.airCardProximityRadius)||0))), locked:body.airProximityLocked === 'on' };
  const scheduleWasSubmitted = [
    'airService1Open',
    'airService1Close',
    'airService2Open',
    'airService2Close',
  ].some((key) => Object.prototype.hasOwnProperty.call(body, key));
  const serviceWindows = scheduleWasSubmitted
    ? [
        [body.airService1Open, body.airService1Close],
        [body.airService2Open, body.airService2Close],
      ]
        .filter(([open, close]) => isValidTime(open) && isValidTime(close))
        .map(([open, close]) => ({ open, close }))
    : [
        { open: '12:30', close: '15:00' },
        { open: '18:30', close: '00:00' },
      ];
  return {
    pageTitle: body.airMenuTitle || 'Our Menu',
    pageSubtitle: body.airMenuSubtitle || 'Explore our freshly prepared food and beverages.',
    note: body.airMenuNote || 'Availability may vary. Please ask our team about today’s specials.',
    tableLive: body.airTableLive === 'on',
    cardLive: body.airCardLive === 'on',
    tableDirectOrders: body.airTableDirectOrders === 'on',
    cardDirectOrders: body.airCardDirectOrders === 'on',
    deliveryEnabled: body.airDeliveryEnabled === 'on',
    showTablePrices: body.airShowTablePrices === 'on',
    showCardPrices: body.airShowCardPrices === 'on',
    cardCallEnabled: body.airCardCallEnabled === 'on',
    cardOrderPhone: String(body.airCardOrderPhone || '').trim(),
    proximity,
    loyalty: {
      enabled: body.airLoyaltyEnabled === 'on',
      spend: Math.max(1, Math.min(100000, Math.floor(Number(body.airLoyaltySpend) || 10))),
      earn: Math.max(1, Math.min(10000, Math.floor(Number(body.airLoyaltyEarn) || 1))),
      minRedeem: Math.max(1, Math.min(100000, Math.floor(Number(body.airLoyaltyMinRedeem) || 100))),
      pointValue: Math.max(0.01, Math.min(1000, Number(body.airLoyaltyPointValue) || 1)),
    },
    serviceWindows,
    restaurantClosed: body.airRestaurantClosed === 'on',
    closedAt: '',
    reopensAt: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(String(body.airReopensAt || ''))
      ? String(body.airReopensAt)
      : '',
    closureMessage: String(body.airClosureMessage || '')
      .trim()
      .slice(0, 240),
    categoryVisibility,
    categoryOrder,
    tableQrDisabled,
    addonGroups,
    sourceFileName: body.airSourceFileName || '',
    barSourceFileName: body.airBarSourceFileName || '',
    items: dedupeMenuItems(
      names
        .map((name, index) => ({
          name: String(name || '').trim(),
          price: String(prices[index] || '').trim(),
          fullPrice: String(fullPrices[index] || '').trim(),
          halfPrice: String(halfPrices[index] || '').trim(),
          withBonePrice: String(withBonePrices[index] || '').trim(),
          bonelessPrice: String(bonelessPrices[index] || '').trim(),
          category: String(categories[index] || 'Menu').trim() || 'Menu',
          type: types[index] === 'beverage' ? 'beverage' : 'food',
          description: String(descriptions[index] || '').trim(),
          dietary:
            dietaryValues[index] === 'nonveg'
              ? 'nonveg'
              : dietaryValues[index] === 'veg'
                ? 'veg'
                : dietaryFromMenuCategory(categories[index]),
          bestSeller: bestSellers[index] === 'true',
          mustHave: mustHaves[index] === 'true',
          gravyStyleAvailable: gravyStyleAvailable[index] === 'true',
        }))
        .filter((item) => item.name)
    ),
    barItems: dedupeMenuItems(
      barNames
        .map((name, index) => ({
          name: String(name || '').trim(),
          price: String(barPrices[index] || '').trim(),
          price30ml: String(bar30mlPrices[index] || '').trim(),
          price60ml: String(bar60mlPrices[index] || '').trim(),
          price90ml: String(bar90mlPrices[index] || '').trim(),
          price180ml: String(bar180mlPrices[index] || '').trim(),
          category: String(barCategories[index] || 'Bar Menu').trim() || 'Bar Menu',
          type: barTypes[index] === 'food' ? 'food' : 'beverage',
          description: String(barDescriptions[index] || '').trim(),
          dietary: '',
          bestSeller: barBestSellers[index] === 'true',
          mustHave: false,
          isBar: true,
        }))
        .filter((item) => item.name)
    ),
  };
}

function addAirMenuExportSheet(workbook, name, columns, rows) {
  const sheet = workbook.addWorksheet(name, {
    views: [{ state: 'frozen', ySplit: 1, showGridLines: false }],
    properties: { tabColor: { argb: name === 'Food Menu' ? 'FFB4533C' : 'FF9A6B3D' } },
  });
  sheet.columns = columns.map((column) => ({
    header: column.label,
    key: column.key,
    width: column.width,
  }));
  sheet.autoFilter = { from: 'A1', to: `${String.fromCharCode(64 + columns.length)}1` };

  const header = sheet.getRow(1);
  header.height = 27;
  header.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, name: 'Arial', size: 11 };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF5A4037' } };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    cell.border = { bottom: { style: 'medium', color: { argb: 'FFC8A27A' } } };
  });

  rows.forEach((row, index) => {
    const excelRow = sheet.addRow(row);
    excelRow.height = 22;
    excelRow.eachCell((cell) => {
      cell.font = { name: 'Arial', size: 10, color: { argb: 'FF1F2937' } };
      cell.alignment = { vertical: 'middle', wrapText: true };
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: index % 2 ? 'FFFBF8F5' : 'FFFFFFFF' },
      };
      cell.border = { bottom: { style: 'thin', color: { argb: 'FFEAE3DC' } } };
    });
  });
  return sheet;
}

function exportMenuPrice(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const number = text.replace(/[₹,\s]/g, '').replace(/^rs\.?/i, '');
  return /^\d+(?:\.\d+)?$/.test(number) ? Number(number) : text;
}

function formatExportPriceColumns(sheet, columns) {
  columns.forEach((column) => {
    sheet.getColumn(column).numFmt = '"₹"#,##0';
    sheet.getColumn(column).alignment = { horizontal: 'right', vertical: 'middle' };
  });
}

async function createAirMenuExport(menu = {}) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Red Lantern Restaurant';
  workbook.created = new Date();
  workbook.properties.title = 'Red Lantern Air Menu';
  workbook.properties.subject = 'Editable food and bar menu export';

  const instructions = workbook.addWorksheet('Read Me');
  instructions.columns = [{ width: 28 }, { width: 105 }];
  instructions.addRows([
    ['RED LANTERN AIR MENU', 'Editable Food and Bar Menu Workbook'],
    [
      'How to use',
      'Edit the Food Menu and Bar Menu sheets, then upload this same file through the matching Import Food Menu or Import Bar Menu control in Admin. The correct sheet is selected automatically.',
    ],
    [
      'Food flags',
      'Use Yes or No for Best Seller, Must Have, and Gravy / Semi-Gravy. Enable the Gravy / Semi-Gravy option only for dishes that can be ordered either way. Use Veg, Non-Veg, or leave Dietary blank; category names containing Veg or Non-Veg also set the dietary mark automatically.',
    ],
    [
      'Prices',
      'Enter a number or a price with ₹. Leave a pricing column blank when it does not apply.',
    ],
    [
      'Important',
      'Save this file as .xlsx. Publish the Air Menu in Admin after importing your changes.',
    ],
  ]);
  instructions.getRow(1).height = 30;
  instructions.getRow(1).eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, name: 'Arial', size: 12 };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF5A4037' } };
  });
  instructions.eachRow((row, rowNumber) =>
    row.eachCell((cell) => {
      cell.alignment = { vertical: 'middle', wrapText: true };
      if (rowNumber > 1)
        cell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: rowNumber % 2 ? 'FFFFFBF8' : 'FFFFFFFF' },
        };
    })
  );
  instructions.getColumn(1).eachCell((cell) => {
    cell.font = { ...(cell.font || {}), bold: true, name: 'Arial' };
  });

  const foodSheet = addAirMenuExportSheet(
    workbook,
    'Food Menu',
    [
      { key: 'name', label: 'Item Name', width: 31 },
      { key: 'category', label: 'Category', width: 22 },
      { key: 'dietary', label: 'Veg / Non-Veg', width: 15 },
      { key: 'price', label: 'Price', width: 12 },
      { key: 'halfPrice', label: 'Half', width: 11 },
      { key: 'fullPrice', label: 'Full', width: 11 },
      { key: 'withBonePrice', label: 'With Bone', width: 13 },
      { key: 'bonelessPrice', label: 'Boneless', width: 13 },
      { key: 'description', label: 'Description', width: 38 },
      { key: 'bestSeller', label: 'Best Seller', width: 13 },
      { key: 'mustHave', label: 'Must Have', width: 13 },
      { key: 'gravyStyleAvailable', label: 'Gravy / Semi-Gravy', width: 18 },
      { key: 'type', label: 'Type', width: 12 },
    ],
    (menu.items || []).map((item) => ({
      name: item.name || '',
      category: item.category || 'Menu',
      dietary: item.dietary === 'nonveg' ? 'Non-Veg' : item.dietary === 'veg' ? 'Veg' : '',
      price: exportMenuPrice(item.price),
      halfPrice: exportMenuPrice(item.halfPrice),
      fullPrice: exportMenuPrice(item.fullPrice),
      withBonePrice: exportMenuPrice(item.withBonePrice),
      bonelessPrice: exportMenuPrice(item.bonelessPrice),
      description: item.description || '',
      bestSeller: item.bestSeller ? 'Yes' : 'No',
      mustHave: item.mustHave ? 'Yes' : 'No',
      gravyStyleAvailable:
        item.gravyStyleAvailable || item.gravyAvailable || item.semiGravyAvailable ? 'Yes' : 'No',
      type: item.type === 'beverage' ? 'Beverage' : 'Food',
    }))
  );
  formatExportPriceColumns(foodSheet, ['D', 'E', 'F', 'G', 'H']);
  foodSheet.dataValidations.add('C2:C1000', {
    type: 'list',
    allowBlank: true,
    formulae: ['"Veg,Non-Veg"'],
  });
  foodSheet.dataValidations.add('J2:L1000', {
    type: 'list',
    allowBlank: false,
    formulae: ['"Yes,No"'],
  });
  foodSheet.dataValidations.add('M2:M1000', {
    type: 'list',
    allowBlank: false,
    formulae: ['"Food,Beverage"'],
  });

  const barSheet = addAirMenuExportSheet(
    workbook,
    'Bar Menu',
    [
      { key: 'name', label: 'Item Name', width: 31 },
      { key: 'category', label: 'Category', width: 22 },
      { key: 'price', label: 'Price', width: 12 },
      { key: 'price30ml', label: '30 ML', width: 12 },
      { key: 'price60ml', label: '60 ML', width: 12 },
      { key: 'price90ml', label: '90 ML', width: 12 },
      { key: 'price180ml', label: '180 ML', width: 12 },
      { key: 'description', label: 'Description', width: 38 },
      { key: 'bestSeller', label: 'Best Seller', width: 13 },
      { key: 'type', label: 'Type', width: 12 },
    ],
    (menu.barItems || []).map((item) => ({
      name: item.name || '',
      category: item.category || 'Bar Menu',
      price: exportMenuPrice(item.price),
      price30ml: exportMenuPrice(item.price30ml),
      price60ml: exportMenuPrice(item.price60ml),
      price90ml: exportMenuPrice(item.price90ml),
      price180ml: exportMenuPrice(item.price180ml),
      description: item.description || '',
      bestSeller: item.bestSeller ? 'Yes' : 'No',
      type: item.type === 'food' ? 'Food' : 'Beverage',
    }))
  );
  formatExportPriceColumns(barSheet, ['C', 'D', 'E', 'F', 'G']);
  barSheet.dataValidations.add('I2:I1000', {
    type: 'list',
    allowBlank: false,
    formulae: ['"Yes,No"'],
  });
  barSheet.dataValidations.add('J2:J1000', {
    type: 'list',
    allowBlank: false,
    formulae: ['"Food,Beverage"'],
  });
  return workbook;
}

function menuItemKey(item = {}) {
  return `${String(item.category || 'menu')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')}::${String(item.name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')}`;
}

function dedupeMenuItems(items = []) {
  const seen = new Set();
  return items.filter((item) => {
    const key = menuItemKey(item);
    if (!item.name || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function stripHtml(value) {
  return String(value || '').replace(/<[^>]*>/g, ' ');
}

function cleanDescriptionText(value) {
  return stripHtml(value)
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function trimDescription(value, maxLength) {
  const text = cleanDescriptionText(value);
  if (text.length <= maxLength) return text;

  const clipped = text.slice(0, maxLength + 1);
  const boundary = Math.max(
    clipped.lastIndexOf('. '),
    clipped.lastIndexOf(', '),
    clipped.lastIndexOf(' ')
  );
  const trimmed = clipped.slice(0, boundary > 80 ? boundary : maxLength).replace(/[,\s.]+$/, '');
  return `${trimmed}.`;
}

function firstUsefulSentence(value) {
  const text = cleanDescriptionText(value);
  if (!text) return '';
  const sentences = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [text];
  return cleanDescriptionText(
    sentences.find((sentence) => cleanDescriptionText(sentence).length >= 55) || sentences[0]
  );
}

function includesLocalContext(value) {
  return /red lantern|colva|south goa|goa/i.test(value);
}

function generatedBlogDescriptions(title, content) {
  const cleanTitle = cleanDescriptionText(title);
  const lead = firstUsefulSentence(content) || cleanTitle;
  const localPhrase = 'Red Lantern Restaurant in Colva, South Goa';

  const excerptSeed =
    cleanTitle && lead && !lead.toLowerCase().includes(cleanTitle.toLowerCase())
      ? `${cleanTitle}: ${lead}`
      : lead || cleanTitle;
  const excerpt = trimDescription(excerptSeed, 165);

  const leadHasTitle = cleanTitle && lead.toLowerCase().includes(cleanTitle.toLowerCase());
  const seoSeed =
    lead && !leadHasTitle
      ? `${lead} Visit ${localPhrase} for Chinese and Goan food in Colva.`
      : `${cleanTitle || lead} at ${localPhrase}.`;
  const seoDescription = trimDescription(
    includesLocalContext(seoSeed) ? seoSeed : `${seoSeed} Discover Chinese and Goan food in Colva.`,
    155
  );

  return { excerpt, seoDescription };
}

function readTimeMinutes(value) {
  const words = stripHtml(value).trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.ceil(words / 200));
}

function formatBlogDate(value) {
  const timestamp = indiaScheduleTime(value) || Date.now();
  return new Intl.DateTimeFormat('en-IN', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'Asia/Kolkata',
  }).format(new Date(timestamp));
}

function blogMetaFromSchedule(publishAt, content) {
  return `${formatBlogDate(publishAt)} · ${readTimeMinutes(content)} min read`;
}

function googleBusinessConfig() {
  const resourceId = (value, prefix) =>
    String(value || '')
      .trim()
      .replace(new RegExp(`^${prefix}/`, 'i'), '');
  return {
    accountId: resourceId(process.env.GOOGLE_BUSINESS_ACCOUNT_ID, 'accounts'),
    locationId: resourceId(process.env.GOOGLE_BUSINESS_LOCATION_ID, 'locations'),
    clientId: String(process.env.GOOGLE_BUSINESS_OAUTH_CLIENT_ID || '').trim(),
    clientSecret: String(process.env.GOOGLE_BUSINESS_OAUTH_CLIENT_SECRET || '').trim(),
    refreshToken: String(process.env.GOOGLE_BUSINESS_OAUTH_REFRESH_TOKEN || '').trim(),
    syncLimit: Math.min(Math.max(Number(process.env.GOOGLE_REVIEWS_SYNC_LIMIT || 30), 1), 100),
  };
}

function assertGoogleBusinessConfig(config) {
  const missing = Object.entries({
    GOOGLE_BUSINESS_ACCOUNT_ID: config.accountId,
    GOOGLE_BUSINESS_LOCATION_ID: config.locationId,
    GOOGLE_BUSINESS_OAUTH_CLIENT_ID: config.clientId,
    GOOGLE_BUSINESS_OAUTH_CLIENT_SECRET: config.clientSecret,
    GOOGLE_BUSINESS_OAUTH_REFRESH_TOKEN: config.refreshToken,
  })
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (missing.length) {
    const error = new Error(
      `Google Business Profile sync is not configured. Missing: ${missing.join(', ')}`
    );
    error.statusCode = 503;
    throw error;
  }
}

async function googleBusinessAccessToken(config) {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: config.refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(data.error_description || data.error || 'Google OAuth token refresh failed.');
  return data.access_token;
}

function normalizeGoogleReview(review = {}) {
  const reviewer = review.reviewer || {};
  const text = cleanDescriptionText(review.comment || '');
  return {
    name: reviewer.displayName || 'Google reviewer',
    stars: '★★★★★',
    text,
    googleReviewName: review.name || '',
    googleReviewId: review.reviewId || '',
    googleCreateTime: review.createTime || '',
    googleUpdateTime: review.updateTime || '',
  };
}

async function fetchFiveStarGoogleReviews() {
  const config = googleBusinessConfig();
  assertGoogleBusinessConfig(config);
  const accessToken = await googleBusinessAccessToken(config);
  const reviews = [];
  let pageToken = '';

  do {
    const url = new URL(
      `https://mybusiness.googleapis.com/v4/accounts/${encodeURIComponent(config.accountId)}/locations/${encodeURIComponent(config.locationId)}/reviews`
    );
    url.searchParams.set('pageSize', '50');
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const data = await response.json();
    if (!response.ok)
      throw new Error(data.error?.message || 'Google Business Profile reviews request failed.');

    reviews.push(
      ...(data.reviews || [])
        .filter((review) => review.starRating === 'FIVE')
        .map(normalizeGoogleReview)
        .filter((review) => review.text)
    );
    pageToken = data.nextPageToken || '';
  } while (pageToken && reviews.length < config.syncLimit);

  return reviews.slice(0, config.syncLimit);
}

function mergeReviews(existingReviews = [], googleReviews = []) {
  const seen = new Set();
  const merged = [];
  [...googleReviews, ...existingReviews].forEach((review) => {
    const key =
      review.googleReviewName ||
      `${cleanDescriptionText(review.name)}:${cleanDescriptionText(review.text).slice(0, 120)}`;
    if (!review.text || seen.has(key)) return;
    seen.add(key);
    merged.push(review);
  });
  return merged;
}

function normalizeBlogs(body, files) {
  const titles = asArray(body.blogTitle);
  const excerpts = asArray(body.blogExcerpt);
  const contents = asArray(body.blogContent);
  const seoTitles = asArray(body.blogSeoTitle);
  const seoDescriptions = asArray(body.blogSeoDescription);
  const publishAts = asArray(body.blogPublishAt);
  const currentImages = asArray(body.currentBlogImage);
  const currentArticleImages = asArray(body.currentBlogArticleImage);

  return {
    pageTitle: body.blogPageTitle || 'Red Lantern Journal',
    pageSubtitle: body.blogPageSubtitle || 'Stories, recipes, and local guides from South Goa.',
    posts: titles
      .map((title, index) => {
        const content = contents[index] || '';
        const generated = generatedBlogDescriptions(title, content || excerpts[index] || '');
        const excerpt = cleanDescriptionText(excerpts[index]) || generated.excerpt;
        return {
          title,
          slug: slugify(title),
          publishAt: publishAts[index] || '',
          meta: blogMetaFromSchedule(publishAts[index], content || excerpt || ''),
          excerpt,
          content,
          image: indexedFile(files, 'blogImage', index) || currentImages[index] || '',
          articleImage:
            indexedFile(files, 'blogArticleImage', index) || currentArticleImages[index] || '',
          seoTitle: seoTitles[index] || title,
          seoDescription:
            cleanDescriptionText(seoDescriptions[index]) || generated.seoDescription || excerpt,
        };
      })
      .filter((post) => post.title),
  };
}

function normalizeAbout(body, files) {
  return {
    heroTitle: body.aboutHeroTitle,
    heroSubtitle: body.aboutHeroSubtitle,
    storyTitle: body.aboutStoryTitle,
    storyText: body.aboutStoryText,
    heroImage: firstFile(files, 'aboutHeroImage') || '',
    storyImage: firstFile(files, 'aboutStoryImage') || '',
  };
}

function normalizeGlobal(body) {
  return {
    footerDescription: body.footerDescription,
    zomatoUrl: body.zomatoUrl,
    swiggyUrl: body.swiggyUrl,
    siteUrl: body.siteUrl,
    seoTitle: body.seoTitle,
    seoDescription: body.seoDescription,
    seoKeywords: body.seoKeywords,
    ogImage: body.ogImage,
    instagramUrl: body.instagramUrl,
    googleBusinessUrl: body.googleBusinessUrl,
    gaMeasurementId: body.gaMeasurementId,
    googleAdsId: body.googleAdsId,
    googleCallConversionLabel: body.googleCallConversionLabel,
    googleOrderConversionLabel: body.googleOrderConversionLabel,
    googleDirectionsConversionLabel: body.googleDirectionsConversionLabel,
    metaPixelId: body.metaPixelId,
    targetLocations: body.targetLocations,
    targetCuisines: body.targetCuisines,
    competitorNames: body.competitorNames,
    competitorResearchNotes: body.competitorResearchNotes,
  };
}

function normalizeContact(body) {
  return {
    address: body.address,
    hours: body.hours,
    phone: body.phone,
    email: body.email,
    mapEmbedUrl: body.mapEmbedUrl,
  };
}

function normalizeSection(section, body, files) {
  if (section === 'home') return normalizeHome(body, files);
  if (section === 'menu') return normalizeMenu(body, files);
  if (section === 'airMenu') return normalizeAirMenu(body);
  if (section === 'blogs') return normalizeBlogs(body, files);
  if (section === 'about') return normalizeAbout(body, files);
  if (section === 'global') return normalizeGlobal(body);
  if (section === 'contact') return normalizeContact(body);
  return body;
}

const indiaOffsetMinutes = 5.5 * 60;

function indiaScheduleTime(value) {
  if (!value) return 0;
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!match) {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  const [, year, month, day, hour, minute] = match.map(Number);
  return Date.UTC(year, month - 1, day, hour, minute) - indiaOffsetMinutes * 60 * 1000;
}

function publishedPosts(posts = [], now = Date.now()) {
  return posts.filter((post) => !post.publishAt || indiaScheduleTime(post.publishAt) <= now);
}

function filterScheduledBlogs(blogs = {}) {
  return {
    ...blogs,
    posts: publishedPosts(blogs.posts || []),
  };
}

async function getAllContent(includeScheduled = false, includePrivate = false) {
  const entries = await Promise.all(
    Object.keys(collections).map(async (section) => [section, await getSection(section)])
  );
  const content = Object.fromEntries(entries);
  if (temporaryClosureExpired(content.airMenu)) {
    content.airMenu = {
      ...content.airMenu,
      restaurantClosed: false,
      closedAt: '',
      reopensAt: '',
      closureMessage: '',
    };
    await saveSection('airMenu', {
      restaurantClosed: false,
      closedAt: '',
      reopensAt: '',
      closureMessage: '',
    });
    clearPublicContentCache();
  }
  if (!includeScheduled && content.blogs) content.blogs = filterScheduledBlogs(content.blogs);
  if (!includePrivate) delete content.airMenu;
  return content;
}

async function getCachedPublicContent() {
  const now = Date.now();
  if (publicContentCache && now - publicContentCache.createdAt < publicContentCacheMs) {
    return publicContentCache.content;
  }

  const content = await getAllContent();
  publicContentCache = { content, createdAt: now };
  return content;
}

function trimForPrompt(content) {
  const global = content.global || {};
  const contact = content.contact || {};
  const menu = content.menu || {};
  const blogs = content.blogs || {};

  return {
    business: {
      name: 'Red Lantern Restaurant',
      location: contact.address || 'Colva, South Goa',
      hours: contact.hours || '',
      phone: contact.phone || '',
      website: global.siteUrl || '',
      orderLinks: {
        zomato: global.zomatoUrl || '',
        swiggy: global.swiggyUrl || '',
      },
    },
    seo: {
      title: global.seoTitle || '',
      description: global.seoDescription || '',
      keywords: global.seoKeywords || '',
      targetLocations: global.targetLocations || '',
      targetSearches: global.targetCuisines || '',
      competitors: global.competitorNames || '',
      researchNotes: global.competitorResearchNotes || '',
    },
    menu: {
      pageTitle: menu.pageTitle || '',
      pageSubtitle: menu.pageSubtitle || '',
      dishes: (menu.dishes || []).slice(0, 20).map((dish) => ({
        name: dish.name || '',
        category: dish.category || '',
        badge: dish.badge || '',
        description: dish.description || '',
      })),
    },
    blogs: {
      count: (blogs.posts || []).length,
      posts: (blogs.posts || []).slice(0, 12).map((post) => ({
        title: post.title || '',
        slug: post.slug || '',
        excerpt: post.excerpt || '',
        seoTitle: post.seoTitle || '',
        seoDescription: post.seoDescription || '',
      })),
    },
  };
}

function parseAiJson(text) {
  const cleaned = String(text || '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```$/i, '')
    .trim();
  return JSON.parse(cleaned);
}

async function generateAiGrowthPlan(content) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    const error = new Error(
      'Missing OPENAI_API_KEY. Add it to a local .env file or server environment to enable real AI growth ideas.'
    );
    error.statusCode = 503;
    throw error;
  }

  const model = process.env.OPENAI_GROWTH_MODEL || 'gpt-5';
  const today = new Date().toISOString().slice(0, 10);
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      reasoning: { effort: 'low' },
      tools: [
        {
          type: 'web_search',
          user_location: {
            type: 'approximate',
            country: 'IN',
            city: 'Colva',
            region: 'Goa',
            timezone: 'Asia/Kolkata',
          },
        },
      ],
      tool_choice: 'auto',
      include: ['web_search_call.action.sources'],
      max_output_tokens: 2200,
      text: {
        format: {
          type: 'json_schema',
          name: 'restaurant_growth_plan',
          strict: true,
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              summary: { type: 'string' },
              trendSignals: {
                type: 'array',
                minItems: 3,
                maxItems: 6,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    title: { type: 'string' },
                    detail: { type: 'string' },
                    priority: { type: 'string' },
                  },
                  required: ['title', 'detail', 'priority'],
                },
              },
              priorityActions: {
                type: 'array',
                minItems: 5,
                maxItems: 8,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    title: { type: 'string' },
                    detail: { type: 'string' },
                    impact: { type: 'string' },
                  },
                  required: ['title', 'detail', 'impact'],
                },
              },
              seoWinningMoves: {
                type: 'array',
                minItems: 5,
                maxItems: 8,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    title: { type: 'string' },
                    detail: { type: 'string' },
                    searchTarget: { type: 'string' },
                  },
                  required: ['title', 'detail', 'searchTarget'],
                },
              },
              contentIdeas: {
                type: 'array',
                minItems: 5,
                maxItems: 8,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    title: { type: 'string' },
                    searchIntent: { type: 'string' },
                    outline: { type: 'string' },
                    keywords: { type: 'array', items: { type: 'string' } },
                  },
                  required: ['title', 'searchIntent', 'outline', 'keywords'],
                },
              },
              adIdeas: {
                type: 'array',
                minItems: 3,
                maxItems: 6,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    campaign: { type: 'string' },
                    audience: { type: 'string' },
                    message: { type: 'string' },
                    landingPage: { type: 'string' },
                  },
                  required: ['campaign', 'audience', 'message', 'landingPage'],
                },
              },
              missingWebsiteItems: {
                type: 'array',
                minItems: 3,
                maxItems: 8,
                items: { type: 'string' },
              },
              sources: {
                type: 'array',
                maxItems: 8,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    title: { type: 'string' },
                    url: { type: 'string' },
                  },
                  required: ['title', 'url'],
                },
              },
            },
            required: [
              'summary',
              'trendSignals',
              'priorityActions',
              'seoWinningMoves',
              'contentIdeas',
              'adIdeas',
              'missingWebsiteItems',
              'sources',
            ],
          },
        },
      },
      instructions:
        'You are a senior local SEO and restaurant growth strategist. Your primary objective is to help the restaurant compete for top visibility in Google Maps/local pack and organic food searches. Use live web search when helpful. Give practical actions for ranking and conversions, but never guarantee first-page ranking. Return only valid JSON matching the schema.',
      input: `Today is ${today}. Create a current SEO-first growth plan for this restaurant to compete for food and restaurant searches around Colva and South Goa. Prioritize: Google Business Profile/local pack visibility, high-intent landing pages, menu SEO, blog topic clusters, review strategy, competitor positioning, technical/schema improvements, and measurable conversion tracking. Use the website/CMS data below, competitor inputs, and current search/travel/food trends. Be specific and action-oriented.\n\nCMS data:\n${JSON.stringify(trimForPrompt(content), null, 2)}`,
    }),
  });

  const body = await response.json();
  if (!response.ok) {
    const error = new Error(body.error?.message || 'OpenAI request failed.');
    error.statusCode = response.status;
    throw error;
  }

  return parseAiJson(body.output_text);
}

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

const airMenuLifetimeMs = 2 * 60 * 60 * 1000;
const airMenuSecret =
  process.env.AIR_MENU_SECRET || process.env.ADMIN_PASSWORD || 'red-lantern-local-air-menu';

function airMenuSignature(mode, expires) {
  return crypto
    .createHmac('sha256', airMenuSecret)
    .update(`${mode}:${expires}`)
    .digest('base64url');
}

function validAirMenuAccess(mode, expires, signature) {
  if (!['table', 'card'].includes(mode)) return false;
  const expiresAt = Number(expires);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return false;
  return secureCompare(signature, airMenuSignature(mode, expiresAt));
}

function formatIndiaTime(minutes) {
  const hour = Math.floor(minutes / 60) % 24;
  const minute = minutes % 60;
  const suffix = hour >= 12 ? 'PM' : 'AM';
  return `${hour % 12 || 12}:${String(minute).padStart(2, '0')} ${suffix}`;
}

function temporaryClosureReopenAt(menu = {}) {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(String(menu.reopensAt || ''))
    ? new Date(`${menu.reopensAt}:00+05:30`)
    : null;
}

function temporaryClosureExpired(menu = {}, now = new Date()) {
  const reopenAt = temporaryClosureReopenAt(menu);
  return menu.restaurantClosed === true && reopenAt && reopenAt <= now;
}

function restaurantStatus(menu, now = new Date()) {
  const localReopen = temporaryClosureReopenAt(menu);
    const closureMessage =
    String(menu.closureMessage || '').trim() || 'The restaurant is currently closed.';
  if (menu.restaurantClosed === true && (!localReopen || localReopen > now)) {
    const reopen = localReopen
      ? new Intl.DateTimeFormat('en-IN', {
          timeZone: 'Asia/Kolkata',
          dateStyle: 'medium',
          timeStyle: 'short',
        }).format(localReopen)
      : '';
    return {
      open: false,
      message: closureMessage,
      closedAt: menu.closedAt
        ? new Intl.DateTimeFormat('en-IN', {
            timeZone: 'Asia/Kolkata',
            dateStyle: 'medium',
          }).format(new Date(menu.closedAt))
        : '',
      reopensAt: reopen
        ? `We will reopen on ${reopen}.`
        : 'Please check back soon for our reopening time.',
    };
  }
  const windows =
    Array.isArray(menu.serviceWindows) && menu.serviceWindows.length
      ? menu.serviceWindows
      : [
          { open: '12:30', close: '15:00' },
          { open: '18:30', close: '00:00' },
        ];
  const clockParts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Kolkata',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(now)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value])
  );
  const currentMinutes = Number(clockParts.hour) * 60 + Number(clockParts.minute);
  const parsed = windows
    .map((window) => {
      const open = String(window.open || '');
      const close = String(window.close || '');
      return {
        open: Number(open.slice(0, 2)) * 60 + Number(open.slice(3)),
        close: Number(close.slice(0, 2)) * 60 + Number(close.slice(3)),
      };
    })
    .filter(
      (window) =>
        Number.isFinite(window.open) &&
        Number.isFinite(window.close) &&
        window.open !== window.close
    );
  if (
    !parsed.length ||
    parsed.some((window) =>
      window.open < window.close
        ? currentMinutes >= window.open && currentMinutes < window.close
        : currentMinutes >= window.open || currentMinutes < window.close
    )
  )
    return { open: true };
  const next = parsed
    .map((window) => ({ ...window, tomorrow: currentMinutes >= window.open }))
    .sort((a, b) => Number(a.tomorrow) - Number(b.tomorrow) || a.open - b.open)[0];
  return {
    open: false,
    message: 'The restaurant is currently closed.',
    reopensAt: `We will open ${next.tomorrow ? 'tomorrow' : 'today'} at ${formatIndiaTime(next.open)}.`,
  };
}

let ordersOperatingStatusCache = { expiresAt: 0, value: { open: true } };
async function getOrdersOperatingStatus() {
  if (ordersOperatingStatusCache.expiresAt > Date.now()) return ordersOperatingStatusCache.value;
  const value = restaurantStatus(await getSection('airMenu'));
  ordersOperatingStatusCache = { value, expiresAt: Date.now() + 15000 };
  return value;
}

function likelyMenuCategory(line) {
  if (!line || line.length < 2 || line.length > 55 || /\d/.test(line)) return false;
  const letters = line.replace(/[^a-z]/gi, '');
  if (letters.length < 2) return false;
  const upper = line.replace(/[^A-Z]/g, '').length / letters.length;
  return (
    upper > 0.65 ||
    /^(starters?|soups?|salads?|mains?|desserts?|beverages?|drinks?|rice|noodles|breads?|seafood|chicken|mutton|vegetarian|non.?veg)/i.test(
      line
    )
  );
}

function airMenuItemType(category, name) {
  return /beverage|drink|mocktail|cocktail|juice|shake|lassi|tea|coffee|beer|wine|spirit|whisky|rum|vodka|gin|water|soda/i.test(
    `${category} ${name}`
  )
    ? 'beverage'
    : 'food';
}

function inferMenuCategory(name, suppliedCategory = '') {
  const item = String(name || '').toLowerCase();
  const supplied = String(suppliedCategory || '').trim();
  const generic =
    !supplied ||
    /^(menu|other|others|misc|miscellaneous|food|items?|uncategorized)$/i.test(supplied);
  if (!generic) return supplied;

  const categoryRules = [
    ['Hot Beverages', /\b(tea|coffee|espresso|cappuccino|latte|hot chocolate)\b/],
    [
      'Mocktails & Cold Beverages',
      /\b(mocktail|mojito|juice|shake|lassi|soda|soft drink|coke|sprite|fanta|water|lime|lemonade|iced tea|cold coffee)\b/,
    ],
    ['Alcoholic Beverages', /\b(beer|wine|whisky|whiskey|rum|vodka|gin|brandy|tequila|cocktail)\b/],
    ['Soups', /\b(soup|broth|shorba)\b/],
    ['Salads', /\b(salad|coleslaw)\b/],
    [
      'Desserts',
      /\b(ice cream|brownie|cake|pudding|custard|gulab|dessert|sweet|mousse|caramel|falooda|kulfi)\b/,
    ],
    ['Rice & Biryani', /\b(rice|biryani|pulao|pilaf)\b/],
    ['Noodles', /\b(noodle|chow ?mein|hakka|mein|chopsuey|chop suey)\b/],
    ['Breads', /\b(naan|roti|paratha|kulcha|bread|pav|chapati)\b/],
    [
      'Starters & Snacks',
      /\b(starter|spring roll|manchurian|kebab|kabab|tikka|lollipop|pakora|crispy|cutlet|samosa|wings|snack)\b/,
    ],
    [
      'Seafood',
      /\b(fish|prawn|shrimp|squid|calamari|crab|lobster|seafood|kingfish|pomfret|rawas)\b/,
    ],
    ['Chicken', /\b(chicken|murgh)\b/],
    ['Mutton & Lamb', /\b(mutton|lamb|goat|keema)\b/],
    ['Egg Dishes', /\b(egg|omelette|omelet)\b/],
    [
      'Vegetarian Mains',
      /\b(paneer|mushroom|baby corn|gobi|cauliflower|vegetable|veg\b|dal\b|chana|rajma|aloo|potato)\b/,
    ],
  ];
  const match = categoryRules.find(([, pattern]) => pattern.test(item));
  return match ? match[0] : 'Main Course';
}

function parseMenuText(rawText) {
  const lines = String(rawText || '')
    .split(/\r?\n/)
    .map((line) =>
      line
        .replace(/[|•·]+/g, ' ')
        .replace(/\.{2,}/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
    )
    .filter(Boolean);
  const items = [];
  let category = 'Menu';
  const priceAtEnd = /^(.{2,}?)\s+(?:(₹|Rs\.?|INR)\s*)?(\d{2,5}(?:\.\d{1,2})?)\s*\/?-?$/i;

  lines.forEach((line) => {
    if (likelyMenuCategory(line)) {
      category = line.replace(/[:\-]+$/, '').trim();
      return;
    }
    const match = line.match(priceAtEnd);
    if (!match) return;
    let name = match[1]
      .replace(/^[\d.)\-\s]+/, '')
      .replace(/\s+\d{1,2}\s*$/, '')
      .trim();
    if (name.length < 2 || /^(page|phone|tel|gst|tax|total|subtotal)$/i.test(name)) return;
    const currency = match[2] || '₹';
    let price = `${/^rs/i.test(currency) ? '₹' : currency}${match[3]}`;
    let halfPrice = '';
    let fullPrice = '';
    const precedingPrice = name.match(/\s(?:₹|Rs\.?|INR)?\s*(\d{2,5}(?:\.\d{1,2})?)\s*$/i);
    if (precedingPrice) {
      name = name.slice(0, precedingPrice.index).trim();
      halfPrice = `₹${precedingPrice[1]}`;
      fullPrice = price;
      price = '';
    }
    const resolvedCategory = inferMenuCategory(name, category);
    items.push({
      name,
      price,
      halfPrice,
      fullPrice,
      category: resolvedCategory,
      type: airMenuItemType(resolvedCategory, name),
      description: '',
      dietary: dietaryFromMenuCategory(resolvedCategory),
      bestSeller: false,
      mustHave: false,
    });
  });

  return items.filter(
    (item, index) =>
      !items
        .slice(0, index)
        .some(
          (prior) =>
            prior.name.toLowerCase() === item.name.toLowerCase() &&
            prior.price === item.price &&
            prior.category.toLowerCase() === item.category.toLowerCase()
        )
  );
}

function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const source = String(text || '').replace(/^\uFEFF/, '');
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === '"') {
      if (quoted && source[index + 1] === '"') {
        field += '"';
        index += 1;
      } else quoted = !quoted;
    } else if (character === ',' && !quoted) {
      row.push(field.trim());
      field = '';
    } else if ((character === '\n' || character === '\r') && !quoted) {
      if (character === '\r' && source[index + 1] === '\n') index += 1;
      row.push(field.trim());
      field = '';
      if (row.some(Boolean)) rows.push(row);
      row = [];
    } else field += character;
  }
  row.push(field.trim());
  if (row.some(Boolean)) rows.push(row);
  return rows;
}

function extractAirMenuFromCsv(file) {
  const rows = parseCsvRows(file.buffer.toString('utf8'));
  if (!rows.length) return { items: [], extractionMethod: 'csv', pageCount: 0 };
  const normalizedHeaders = rows[0].map((value) => value.toLowerCase().replace(/[^a-z0-9]/g, ''));
  const findHeader = (names) => normalizedHeaders.findIndex((header) => names.includes(header));
  let nameIndex = findHeader([
    'item',
    'itemname',
    'name',
    'dish',
    'dishname',
    'menuitem',
    'product',
  ]);
  let priceIndex = findHeader(['price', 'rate', 'amount', 'cost', 'mrp']);
  let fullPriceIndex = findHeader(['fullprice', 'full', 'fullrate', 'pricefull']);
  let halfPriceIndex = findHeader(['halfprice', 'half', 'halfrate', 'pricehalf']);
  let withBonePriceIndex = findHeader(['withbone', 'withboneprice', 'bonein', 'boneinprice']);
  let bonelessPriceIndex = findHeader(['boneless', 'bonelessprice']);
  let categoryIndex = findHeader(['category', 'section', 'group', 'menucategory', 'course']);
  let typeIndex = findHeader(['type', 'itemtype', 'foodtype', 'kind']);
  let descriptionIndex = findHeader([
    'description',
    'details',
    'itemdescription',
    'desc',
    'ingredients',
  ]);
  let dietaryIndex = findHeader(['dietary', 'diet', 'vegornonveg', 'vegnonveg', 'foodpreference']);
  let bestSellerIndex = findHeader(['bestseller', 'bestselling', 'popular', 'isbestSeller']);
  let mustHaveIndex = findHeader(['musthave', 'musttry', 'recommended', 'chefchoice']);
  let gravyStyleIndex = findHeader([
    'gravystyleavailable',
    'gravystyle',
    'gravysemigravy',
    'gravy',
    'gravyavailable',
  ]);
  let semiGravyIndex = findHeader(['semigravy', 'semigravyavailable']);
  const hasHeaders =
    nameIndex >= 0 ||
    priceIndex >= 0 ||
    fullPriceIndex >= 0 ||
    halfPriceIndex >= 0 ||
    withBonePriceIndex >= 0 ||
    bonelessPriceIndex >= 0 ||
    categoryIndex >= 0 ||
    typeIndex >= 0 ||
    descriptionIndex >= 0 ||
    dietaryIndex >= 0 ||
    bestSellerIndex >= 0 ||
    mustHaveIndex >= 0 ||
    gravyStyleIndex >= 0 ||
    semiGravyIndex >= 0;
  if (nameIndex < 0) nameIndex = 0;
  if (priceIndex < 0) priceIndex = 1;
  if (categoryIndex < 0) categoryIndex = 2;
  const dataRows = hasHeaders ? rows.slice(1) : rows;

  const items = dataRows
    .map((columns) => {
      const name = String(columns[nameIndex] || '').trim();
      const rawPrice = String(columns[priceIndex] || '').trim();
      const rawFullPrice = fullPriceIndex >= 0 ? String(columns[fullPriceIndex] || '').trim() : '';
      const rawHalfPrice = halfPriceIndex >= 0 ? String(columns[halfPriceIndex] || '').trim() : '';
      const rawWithBonePrice =
        withBonePriceIndex >= 0 ? String(columns[withBonePriceIndex] || '').trim() : '';
      const rawBonelessPrice =
        bonelessPriceIndex >= 0 ? String(columns[bonelessPriceIndex] || '').trim() : '';
      const suppliedCategory = String(columns[categoryIndex] || '').trim();
      const suppliedType = String(columns[typeIndex] || '').toLowerCase();
      const price =
        rawPrice && !/[₹$€£]|\b(?:rs|inr)\b/i.test(rawPrice)
          ? `₹${rawPrice}`
          : rawPrice.replace(/^rs\.?\s*/i, '₹');
      const formatImportedPrice = (value) =>
        value && !/[₹$€£]|\b(?:rs|inr)\b/i.test(value)
          ? `₹${value}`
          : value.replace(/^rs\.?\s*/i, '₹');
      const resolvedCategory = inferMenuCategory(name, suppliedCategory);
      const importedDietary =
        dietaryIndex >= 0 && /non[\s-]?veg/i.test(String(columns[dietaryIndex] || ''))
          ? 'nonveg'
          : dietaryIndex >= 0 && /veg/i.test(String(columns[dietaryIndex] || ''))
            ? 'veg'
            : '';
      return {
        name,
        price,
        fullPrice: formatImportedPrice(rawFullPrice),
        halfPrice: formatImportedPrice(rawHalfPrice),
        withBonePrice: formatImportedPrice(rawWithBonePrice),
        bonelessPrice: formatImportedPrice(rawBonelessPrice),
        category: resolvedCategory,
        type: /beverage|drink/i.test(suppliedType)
          ? 'beverage'
          : /food/i.test(suppliedType)
            ? 'food'
            : airMenuItemType(resolvedCategory, name),
        description: descriptionIndex >= 0 ? String(columns[descriptionIndex] || '').trim() : '',
        dietary: importedDietary || dietaryFromMenuCategory(resolvedCategory),
        bestSeller:
          bestSellerIndex >= 0 &&
          /^(1|true|yes|y|checked|best seller|popular)$/i.test(
            String(columns[bestSellerIndex] || '').trim()
          ),
        mustHave:
          mustHaveIndex >= 0 &&
          /^(1|true|yes|y|checked|must have|must try|recommended)$/i.test(
            String(columns[mustHaveIndex] || '').trim()
          ),
        gravyStyleAvailable:
          (gravyStyleIndex >= 0 &&
            /^(1|true|yes|y|checked|gravy|semi[-\s]?gravy)$/i.test(
              String(columns[gravyStyleIndex] || '').trim()
            )) ||
          (semiGravyIndex >= 0 &&
            /^(1|true|yes|y|checked|semi[-\s]?gravy)$/i.test(
              String(columns[semiGravyIndex] || '').trim()
            )),
      };
    })
    .filter((item) => item.name);

  return { items: dedupeMenuItems(items), extractionMethod: 'csv', pageCount: 0 };
}

function spreadsheetCellText(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value !== 'object') return String(value).trim();
  if (value.result !== undefined) return spreadsheetCellText(value.result);
  if (Array.isArray(value.richText))
    return value.richText
      .map((part) => part.text || '')
      .join('')
      .trim();
  if (value.text !== undefined) return String(value.text).trim();
  return String(value).trim();
}

async function workbookRows(file, preferredSheetNames = []) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(file.buffer);
  const preferredNames = preferredSheetNames.map((name) => String(name).toLowerCase());
  const worksheet =
    workbook.worksheets.find((sheet) =>
      preferredNames.includes(String(sheet.name).toLowerCase())
    ) || workbook.worksheets[0];
  if (!worksheet) return [];
  const rows = [];
  worksheet.eachRow({ includeEmpty: false }, (row) => {
    const values = row.values.slice(1).map(spreadsheetCellText);
    if (values.some(Boolean)) rows.push(values);
  });
  return rows;
}

function rowsAsCsv(rows) {
  return rows
    .map((row) => row.map((value) => `"${String(value || '').replace(/"/g, '""')}"`).join(','))
    .join('\n');
}

async function extractAirMenuFromXlsx(file) {
  const extraction = extractAirMenuFromCsv({
    buffer: Buffer.from(rowsAsCsv(await workbookRows(file, ['Food Menu', 'Food']))),
  });
  return { ...extraction, extractionMethod: 'xlsx' };
}

function formatImportedPrice(value) {
  const clean = String(value || '').trim();
  if (!clean) return '';
  return !/[₹$€£]|\b(?:rs|inr)\b/i.test(clean) ? `₹${clean}` : clean.replace(/^rs\.?\s*/i, '₹');
}

function extractBarMenuFromRows(rows, extractionMethod = 'csv') {
  if (!rows.length) return { items: [], extractionMethod, pageCount: 0 };
  const headers = rows[0].map((value) =>
    String(value || '')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '')
  );
  const findHeader = (names) => headers.findIndex((header) => names.includes(header));
  let nameIndex = findHeader([
    'item',
    'itemname',
    'name',
    'drink',
    'drinkname',
    'brand',
    'product',
  ]);
  let priceIndex = findHeader(['price', 'rate', 'amount', 'cost', 'mrp']);
  let price30Index = findHeader(['30ml', 'price30ml', '30mlprice', '30', 'smallpeg']);
  let price60Index = findHeader(['60ml', 'price60ml', '60mlprice', '60', 'largepeg']);
  let price90Index = findHeader(['90ml', 'price90ml', '90mlprice', '90']);
  let price180Index = findHeader(['180ml', 'price180ml', '180mlprice', '180', 'quarter']);
  let categoryIndex = findHeader(['category', 'section', 'group', 'barcategory', 'kind']);
  let typeIndex = findHeader(['type', 'itemtype', 'drinktype']);
  let descriptionIndex = findHeader(['description', 'details', 'desc', 'notes']);
  let bestSellerIndex = findHeader(['bestseller', 'bestselling', 'popular', 'recommended']);
  const hasHeaders = [
    nameIndex,
    priceIndex,
    price30Index,
    price60Index,
    price90Index,
    price180Index,
    categoryIndex,
    typeIndex,
    descriptionIndex,
    bestSellerIndex,
  ].some((index) => index >= 0);
  if (nameIndex < 0) nameIndex = 0;
  if (priceIndex < 0) priceIndex = 1;
  if (price30Index < 0) price30Index = 2;
  if (price60Index < 0) price60Index = 3;
  if (categoryIndex < 0) categoryIndex = 4;
  if (typeIndex < 0) typeIndex = 5;
  if (descriptionIndex < 0) descriptionIndex = 6;
  if (bestSellerIndex < 0) bestSellerIndex = 7;
  const dataRows = hasHeaders ? rows.slice(1) : rows;
  const items = dataRows
    .map((columns) => {
      const name = String(columns[nameIndex] || '').trim();
      const suppliedCategory = String(columns[categoryIndex] || '').trim();
      return {
        name,
        price: formatImportedPrice(columns[priceIndex]),
        price30ml: formatImportedPrice(columns[price30Index]),
        price60ml: formatImportedPrice(columns[price60Index]),
        price90ml: price90Index >= 0 ? formatImportedPrice(columns[price90Index]) : '',
        price180ml: price180Index >= 0 ? formatImportedPrice(columns[price180Index]) : '',
        category: suppliedCategory || 'Bar Menu',
        type: /food/i.test(String(columns[typeIndex] || '')) ? 'food' : 'beverage',
        description: String(columns[descriptionIndex] || '').trim(),
        dietary: '',
        bestSeller: /^(1|true|yes|y|checked|best seller|popular|recommended)$/i.test(
          String(columns[bestSellerIndex] || '').trim()
        ),
        mustHave: false,
        isBar: true,
      };
    })
    .filter((item) => item.name);
  return { items: dedupeMenuItems(items), extractionMethod, pageCount: 0 };
}

function barCategoryHeading(line) {
  const clean = String(line || '')
    .replace(/[:\-]+$/, '')
    .trim();
  if (!clean || clean.length > 60 || /\d/.test(clean)) return '';
  const known =
    /\b(whisk(?:y|ey)|scotch|bourbon|rum|vodka|gin|brandy|cognac|tequila|liqueur|spirits?|feni|beer|wine|champagne|sparkling|cocktails?|mocktails?|shooters?|aperitifs?|bar menu|bar bites?|bar snacks?|draught|bottled|imported|domestic|beverages?)\b/i.test(
      clean
    );
  return known ? clean : '';
}

function isFoodOnlyHeading(line) {
  const clean = String(line || '').trim();
  return (
    likelyMenuCategory(clean) &&
    /\b(starters?|soups?|salads?|main course|biryani|rice|noodles|breads?|seafood|chicken|mutton|vegetarian|non.?veg|desserts?)\b/i.test(
      clean
    )
  );
}

function isAlcoholMenuItem(item = {}) {
  return /\b(bar menu|alcohol|spirits?|feni|beer|wine|whisk(?:y|ey)|scotch|bourbon|rum|vodka|gin|brandy|cognac|liqueur|tequila|cocktail|champagne)\b/i.test(
    `${item.category || ''} ${item.name || ''}`
  );
}

function parseBarMenuText(rawText) {
  const lines = String(rawText || '')
    .split(/\r?\n/)
    .map((line) =>
      line
        .replace(/[|•·]+/g, ' ')
        .replace(/\.{2,}/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
    )
    .filter(Boolean);
  const items = [];
  let category = 'Bar Menu';
  let activeSizes = [];
  let acceptingBarRows = true;
  const validSizes = [30, 60, 90, 180];

  lines.forEach((originalLine) => {
    const sizeHeaders = [...originalLine.matchAll(/\b(30|60|90|180)\s*ml\b/gi)]
      .map((match) => ({ size: Number(match[1]), index: match.index }))
      .sort((a, b) => a.index - b.index)
      .map((entry) => entry.size);
    if (sizeHeaders.length && /price|rate|ml|peg/i.test(originalLine)) {
      activeSizes = [...new Set(sizeHeaders)].filter((size) => validSizes.includes(size));
      return;
    }

    const heading = barCategoryHeading(originalLine);
    if (heading) {
      category = heading;
      acceptingBarRows = true;
      return;
    }
    if (isFoodOnlyHeading(originalLine)) {
      acceptingBarRows = false;
      return;
    }
    if (!acceptingBarRows) return;
    if (
      /\b(item name|description|category|best seller|menu|page|phone|contact|gst|tax)\b/i.test(
        originalLine
      ) &&
      !/\d{2,5}/.test(originalLine)
    )
      return;

    const numberMatches = [...originalLine.matchAll(/(?:₹|Rs\.?|INR)?\s*(\d{2,5}(?:\.\d{1,2})?)/gi)]
      .filter(
        (match) => !/^\s*ml\b/i.test(originalLine.slice((match.index || 0) + match[0].length))
      )
      .filter((match) => {
        const remainder = originalLine.slice(match.index || 0);
        return !/[a-z]/i.test(remainder.replace(/(?:₹|Rs\.?|INR|ml|peg)/gi, ''));
      });
    if (!numberMatches.length) return;

    const firstPriceIndex = numberMatches[0].index || 0;
    const bestSeller = /\b(best\s*seller|popular|recommended)\b|★|⭐/i.test(originalLine);
    const name = originalLine
      .slice(0, firstPriceIndex)
      .replace(/\b(best\s*seller|popular|recommended)\b|[★⭐*]+/gi, '')
      .replace(/[.\-–—:\s]+$/, '')
      .replace(/^[\d.)\-\s]+/, '')
      .trim();
    if (
      name.length < 2 ||
      /^(total|subtotal|price|rate|amount|30\s*ml|60\s*ml|90\s*ml|180\s*ml)$/i.test(name)
    )
      return;
    const values = numberMatches.map((match) => formatImportedPrice(match[1]));
    const prices = { price: '', price30ml: '', price60ml: '', price90ml: '', price180ml: '' };
    if (activeSizes.length) {
      values.slice(0, activeSizes.length).forEach((value, index) => {
        prices[`price${activeSizes[index]}ml`] = value;
      });
      if (values.length > activeSizes.length) prices.price = values[values.length - 1];
    } else if (values.length === 1) {
      prices.price = values[0];
    } else {
      values.slice(0, 4).forEach((value, index) => {
        prices[`price${validSizes[index]}ml`] = value;
      });
    }
    const foodType =
      /\b(snack|starter|fries|peanut|masala|chicken|fish|prawn|paneer|kebab|tikka|salad)\b/i.test(
        `${category} ${name}`
      );
    items.push({
      name,
      ...prices,
      category,
      type: foodType ? 'food' : 'beverage',
      description: '',
      dietary: '',
      bestSeller,
      mustHave: false,
      isBar: true,
    });
  });
  return dedupeMenuItems(items);
}

async function extractBarMenu(file) {
  const extension = path.extname(file.originalname).toLowerCase();
  if (extension === '.csv')
    return extractBarMenuFromRows(parseCsvRows(file.buffer.toString('utf8')), 'csv');
  if (extension === '.xlsx')
    return extractBarMenuFromRows(await workbookRows(file, ['Bar Menu', 'Bar']), 'xlsx');
  const pdfExtraction = await extractAirMenuFromPdf(file);
  const parsedBarItems = parseBarMenuText(pdfExtraction.rawText || '');
  return {
    ...pdfExtraction,
    items: parsedBarItems.length
      ? parsedBarItems
      : pdfExtraction.items
          .filter(
            (item) =>
              item.type === 'beverage' ||
              airMenuItemType(item.category, item.name) === 'beverage' ||
              isAlcoholMenuItem(item)
          )
          .map((item) => ({
            name: item.name,
            price: item.price || '',
            price30ml: item.halfPrice || '',
            price60ml: item.fullPrice || '',
            price90ml: '',
            price180ml: '',
            category: item.category && item.category !== 'Menu' ? item.category : 'Bar Menu',
            type: 'beverage',
            description: item.description || '',
            dietary: '',
            bestSeller: false,
            mustHave: false,
            isBar: true,
          })),
    extractionMethod: pdfExtraction.extractionMethod,
  };
}

async function extractAirMenuFromPdf(file) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const { createCanvas } = require('@napi-rs/canvas');
  const standardFontDataUrl = `${pathToFileURL(path.join(__dirname, 'node_modules/pdfjs-dist/standard_fonts')).href}/`;
  const pdf = await pdfjs.getDocument({
    data: new Uint8Array(file.buffer),
    disableWorker: true,
    standardFontDataUrl,
  }).promise;
  const pageCount = Math.min(pdf.numPages, 20);
  const pageTexts = [];

  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    const rows = [];
    content.items.forEach((item) => {
      const x = Number(item.transform?.[4] || 0);
      const y = Number(item.transform?.[5] || 0);
      let row = rows.find((candidate) => Math.abs(candidate.y - y) <= 2);
      if (!row) {
        row = { y, items: [] };
        rows.push(row);
      }
      row.items.push({ x, text: item.str || '' });
    });
    const pageText = rows
      .sort((a, b) => b.y - a.y)
      .map((row) =>
        row.items
          .sort((a, b) => a.x - b.x)
          .map((item) => item.text)
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim()
      )
      .filter(Boolean)
      .join('\n');
    pageTexts.push(pageText);
  }

  let extractionMethod = 'embedded-text';
  let rawText = pageTexts.join('\n');
  let items = parseMenuText(rawText);

  if (items.length < 3) {
    const { createWorker, OEM } = require('tesseract.js');
    const language = require('@tesseract.js-data/eng');
    const worker = await createWorker(language.code, OEM.LSTM_ONLY, {
      langPath: language.langPath,
      gzip: language.gzip,
      logger: () => {},
    });
    const ocrPages = [];
    try {
      for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
        const page = await pdf.getPage(pageNumber);
        const viewport = page.getViewport({ scale: 2 });
        const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
        await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
        const result = await worker.recognize(canvas.toBuffer('image/png'));
        ocrPages.push(result.data.text || '');
      }
    } finally {
      await worker.terminate();
    }
    extractionMethod = 'ocr';
    rawText = ocrPages.join('\n');
    items = parseMenuText(rawText);
  }

  return { items, extractionMethod, pageCount, rawText };
}

const tableQrKey = (areaId, tableNumber) => `${String(areaId || '').trim()}:${Number(tableNumber)}`;

async function resolveTableQr(areaId, tableNumber) {
  const id = String(areaId || '').trim();
  const number = Number.parseInt(tableNumber, 10);
  if (!id || !Number.isInteger(number) || number < 1 || number > 9999) return null;
  await ensureOperationsConfigTable();
  const rows =
    await sql`SELECT config FROM order_operations_config WHERE config_key='default' LIMIT 1`;
  const areas = Array.isArray(rows[0]?.config?.tableAreas) ? rows[0].config.tableAreas : [];
  const area = areas.find(
    (candidate) =>
      String(candidate.id || '') === id &&
      number >= Number(candidate.from) &&
      number <= Number(candidate.to)
  );
  return area
    ? { id, number, name: String(area.name || '').trim(), key: tableQrKey(id, number) }
    : null;
}

app.get('/scan/:mode', async (req, res) => {
  const mode = req.params.mode;
  if (!['table', 'card'].includes(mode)) return res.redirect(302, '/menu');
  try {
    const menu = await getSection('airMenu');
    const tableQr =
      mode === 'table' && (req.query.area || req.query.table)
        ? await resolveTableQr(req.query.area, req.query.table)
        : null;
    if (mode === 'table' && (req.query.area || req.query.table) && !tableQr)
      return res.redirect(302, 'https://www.redlanternrestaurant.in/menu');
    if (tableQr && menu.tableQrDisabled?.[tableQr.key])
      return res.redirect(302, 'https://www.redlanternrestaurant.in/menu');
    if (
      (mode === 'table' && menu.tableLive === false) ||
      (mode === 'card' && menu.cardLive === false)
    ) {
      return res.redirect(302, 'https://www.redlanternrestaurant.in/menu');
    }
    const scanDetails = qrScanDetails(req, mode);
    await writeDiagnostic({
      level: 'info',
      category: 'qr-scan',
      message: `${scanDetails.qrType} scanned`,
      solution: 'No action required. Use the QR Scan Log dashboard to monitor engagement.',
      location: scanDetails.qrType,
      method: req.method,
      path: req.path,
      statusCode: 302,
      ipHash: dailyQrVisitorId(req),
      details: scanDetails,
    });
    const expires = Date.now() + airMenuLifetimeMs;
    const signature = airMenuSignature(mode, expires);
    res.set('Cache-Control', 'no-store');
    return res.redirect(
      302,
      `/air-menu?mode=${mode}&expires=${expires}&signature=${encodeURIComponent(signature)}${tableQr ? `&area=${encodeURIComponent(tableQr.id)}&table=${tableQr.number}` : ''}`
    );
  } catch (error) {
    // A database or analytics outage must not strand customers at a 500 page.
    console.error(`QR ${mode} scan failed; using website menu fallback:`, error);
    res.set('Cache-Control', 'no-store');
    return res.redirect(302, 'https://www.redlanternrestaurant.in/menu');
  }
});

app.get('/air-menu', (req, res) => {
  if (!validAirMenuAccess(req.query.mode, req.query.expires, req.query.signature)) {
    return res.redirect(302, 'https://www.redlanternrestaurant.in/menu');
  }
  res.set('Cache-Control', 'no-store');
  return res.sendFile(path.join(__dirname, 'air-menu.html'));
});

app.get('/api/air-menu', async (req, res) => {
  if (!validAirMenuAccess(req.query.mode, req.query.expires, req.query.signature)) {
    return res
      .status(410)
      .json({ expired: true, redirect: 'https://www.redlanternrestaurant.in/menu' });
  }
  const menu = await getSection('airMenu');
  const tableQr =
    req.query.mode === 'table' && (req.query.area || req.query.table)
      ? await resolveTableQr(req.query.area, req.query.table)
      : null;
  if (req.query.mode === 'table' && (req.query.area || req.query.table) && !tableQr)
    return res.status(410).json({ unavailable: true, redirect: 'https://www.redlanternrestaurant.in/menu' });
  if (tableQr && menu.tableQrDisabled?.[tableQr.key])
    return res.status(410).json({ unavailable: true, redirect: 'https://www.redlanternrestaurant.in/menu' });
  const dishes = [
    ...(Array.isArray(menu.items) ? menu.items : []),
    ...(Array.isArray(menu.barItems)
      ? menu.barItems.map((item) => ({ ...item, isBar: true }))
      : []),
  ];
  const isCard = req.query.mode === 'card';
  const isLive = isCard ? menu.cardLive !== false : menu.tableLive !== false;
  if (!isLive)
    return res
      .status(410)
      .json({ unavailable: true, redirect: 'https://www.redlanternrestaurant.in/menu' });
  const operatingStatus = restaurantStatus(menu);
  if (!operatingStatus.open)
    return res.json({
      closed: true,
      pageTitle: menu.pageTitle || 'Our Menu',
      pageSubtitle: menu.pageSubtitle || '',
      note: menu.note || '',
      message: operatingStatus.message,
      closedAt: operatingStatus.closedAt,
      reopensAt: operatingStatus.reopensAt,
      tableLabel: tableQr ? `${tableQr.name} Table ${tableQr.number}` : '',
      tableArea: tableQr?.name || '',
      tableNumber: tableQr?.number || null,
      mode: req.query.mode,
      expires: Number(req.query.expires),
      dishes: [],
    });
  const visibility =
    menu.categoryVisibility && typeof menu.categoryVisibility === 'object'
      ? menu.categoryVisibility
      : {};
  let unavailable = new Set();
  try {
    await ensureMenuAvailabilityTable();
    const rows = await sql`SELECT item_key FROM menu_availability WHERE unavailable_until > NOW()`;
    unavailable = new Set(rows.map((row) => row.item_key));
  } catch (error) {
    console.warn('Menu availability lookup failed:', error.message);
  }
  const visibleDishes = dishes.filter((dish) => {
    const itemKey = `${String(dish.category || '').toLowerCase()}::${String(dish.name || '').toLowerCase()}`;
    if (unavailable.has(itemKey)) return false;
    const setting = visibility[dish.category];
    if (setting && setting[isCard ? 'card' : 'table'] === false) return false;
    if (
      isCard &&
      !setting &&
      (dish.isBar ||
        /\b(bar menu|alcohol|spirits?|feni|beer|wine|whisky|whiskey|scotch|bourbon|rum|vodka|gin|brandy|cognac|liqueur|tequila|cocktail)\b/i.test(
          dish.category || ''
        ))
    )
      return false;
    return true;
  });
  res.set('Cache-Control', 'no-store');
  res.json({
    pageTitle: menu.pageTitle || 'Our Menu',
    pageSubtitle: menu.pageSubtitle || '',
    note: menu.note || '',
    showPrices: isCard ? menu.showCardPrices === true : menu.showTablePrices !== false,
    directOrdersEnabled: isCard ? menu.cardDirectOrders !== false : menu.tableDirectOrders === true,
    deliveryEnabled: menu.deliveryEnabled !== false,
    cardCallEnabled: isCard && menu.cardCallEnabled === true,
    cardOrderPhone: String(menu.cardOrderPhone || ''),
    proximity:{required:Boolean(Number(isCard?menu.proximity?.cardRadius:menu.proximity?.tableRadius)>0&&Number.isFinite(Number(menu.proximity?.latitude))&&Number.isFinite(Number(menu.proximity?.longitude))),radius:Math.max(0,Number(isCard?menu.proximity?.cardRadius:menu.proximity?.tableRadius)||0),latitude:Number(menu.proximity?.latitude),longitude:Number(menu.proximity?.longitude)},
    tableLabel: tableQr ? `${tableQr.name} Table ${tableQr.number}` : '',
    tableArea: tableQr?.name || '',
    tableNumber: tableQr?.number || null,
    mode: req.query.mode,
    expires: Number(req.query.expires),
    dishes: visibleDishes,
  });
});

app.post('/api/direct-orders', async (req, res) => {
  if (!allowPublicRequest(req, res, 'direct-order', 30, 60 * 1000)) return;
  let directClientRequestId = '';
  try {
    const {
      mode,
      expires,
      signature,
      customerPhone,
      customerName,
      specialRequest,
      fulfillmentType, proximity,
      items = [],
    } = req.body || {};
    const clientRequestId = String(req.get('X-Direct-Order-Id') || req.body?.clientRequestId || '')
      .trim()
      .slice(0, 80);
    directClientRequestId = clientRequestId;
    if (!validAirMenuAccess(mode, expires, signature))
      return res.status(410).json({ error: 'This QR session has expired. Please scan again.' });
    const menu = await getSection('airMenu');
    const enabled =
      mode === 'card' ? menu.cardDirectOrders !== false : menu.tableDirectOrders === true;
    if (!enabled)
      return res.status(403).json({ error: 'Direct ordering is unavailable for this QR menu.' });
    const requiredRadius=Math.max(0,Number(mode==='card'?menu.proximity?.cardRadius:menu.proximity?.tableRadius)||0), restaurantLatitude=Number(menu.proximity?.latitude), restaurantLongitude=Number(menu.proximity?.longitude);
    if(requiredRadius>0&&Number.isFinite(restaurantLatitude)&&Number.isFinite(restaurantLongitude)){const latitude=Number(proximity?.latitude),longitude=Number(proximity?.longitude),accuracy=Number(proximity?.accuracy);if(!Number.isFinite(latitude)||!Number.isFinite(longitude))return res.status(403).json({error:'Location permission is required to place an order from this QR code.'});const tolerance=Math.min(100,Math.max(0,Number.isFinite(accuracy)?accuracy:0));if(distanceInMetres(restaurantLatitude,restaurantLongitude,latitude,longitude)>requiredRadius+tolerance)return res.status(403).json({error:`You need to be within ${requiredRadius} m of the restaurant to place this order.`});}
    const operatingStatus = restaurantStatus(menu);
    if (!operatingStatus.open)
      return res
        .status(423)
        .json({ error: `${operatingStatus.message} ${operatingStatus.reopensAt}`.trim() });
    const phone = String(customerPhone || '').replace(/\D/g, '');
    if (phone.length < 7) return res.status(400).json({ error: 'Enter a valid mobile number.' });
    const fulfilment =
      String(fulfillmentType || '').toLowerCase() === 'pickup'
        ? 'pickup'
        : String(fulfillmentType || '').toLowerCase() === 'delivery'
          ? 'delivery'
          : mode === 'table'
            ? 'pickup'
            : 'delivery';
    if (fulfilment === 'delivery' && menu.deliveryEnabled === false)
      return res
        .status(403)
        .json({ error: 'Delivery is temporarily unavailable. Please choose pickup.' });
    const priceNumber = (value) => Number(String(value || '').replace(/[^0-9.]/g, '')) || 0;
    const displayItemName = (value) =>
      String(value || '')
        .replace(/[.…·]{2,}/g, ' ')
        .replace(/\s+\d{2,5}(?:\.\d{1,2})?\s*\/?\s*$/, '')
        .replace(/\s+/g, ' ')
        .trim();
    const menuItems = [
      ...(Array.isArray(menu.items) ? menu.items : []),
      ...(Array.isArray(menu.barItems) ? menu.barItems : []),
    ];
    const portionPrice = (item, portion) => {
      const key = String(portion || '')
        .trim()
        .toLowerCase();
      const prices = {
        half: item.halfPrice,
        full: item.fullPrice,
        'with bone': item.withBonePrice,
        boneless: item.bonelessPrice,
        '30 ml': item.price30ml,
        '60 ml': item.price60ml,
        '90 ml': item.price90ml,
        '180 ml': item.price180ml,
      };
      return prices[key] || item.price || '';
    };
    const submittedItems = Array.isArray(items)
      ? items.filter((item) => Number(item.quantity) > 0).slice(0, 30)
      : [];
    const cleanItems = submittedItems
      .map((item) => {
        const name = String(item.name || '')
          .trim()
          .slice(0, 100);
        const category = String(item.category || '')
          .trim()
          .slice(0, 80);
        const source = menuItems.find(
          (dish) =>
            displayItemName(dish.name).toLowerCase() === name.toLowerCase() &&
            String(dish.category || '')
              .trim()
              .toLowerCase() === category.toLowerCase()
        );
        if (!source) return null;
        const style =
          /^(gravy|semi-gravy)$/i.test(String(item.style || '').trim()) &&
          (source.gravyStyleAvailable || source.gravyAvailable || source.semiGravyAvailable)
            ? String(item.style).trim()
            : '';
        const price = portionPrice(source, item.portion);
        if (!priceNumber(price)) return null;
        return {
          name: displayItemName(source.name).slice(0, 100),
          category: String(source.category || '').slice(0, 80),
          portion: String(item.portion || '').slice(0, 40),
          style,
          quantity: Math.min(20, Number(item.quantity) || 0),
          price: `₹${priceNumber(price)}`,
          availabilityKey: `${String(source.category || '').toLowerCase()}::${String(source.name || '').toLowerCase()}`,
        };
      })
      .filter(Boolean);
    if (
      !cleanItems.length ||
      cleanItems.length !== submittedItems.length ||
      cleanItems.some((item) => !item.name)
    )
      return res
        .status(400)
        .json({
          error:
            'One or more selected items are no longer available. Refresh the menu and try again.',
        });
    await ensureDirectOrdersTable();
    if (clientRequestId) {
      const existing =
        await sql`SELECT id,status,daily_order_number,tracking_token,loyalty_points_earned,loyalty_points_redeemed FROM direct_orders WHERE client_request_id=${clientRequestId} LIMIT 1`;
      if (existing.length)
        return res.json({
          id: existing[0].id,
          status: existing[0].status,
          orderNumber: String(existing[0].daily_order_number).padStart(2, '0'),
          trackingUrl: `/track-order?token=${encodeURIComponent(existing[0].tracking_token)}`,
          loyaltyPointsEarned: Number(existing[0].loyalty_points_earned || 0),
          loyaltyPointsRedeemed: Number(existing[0].loyalty_points_redeemed || 0),
          duplicate: true,
        });
    }
    await ensureMenuAvailabilityTable();
    const unavailableRows =
      await sql`SELECT item_key FROM menu_availability WHERE unavailable_until > NOW()`;
    const unavailableKeys = new Set(unavailableRows.map((row) => row.item_key));
    if (cleanItems.some((item) => unavailableKeys.has(item.availabilityKey)))
      return res
        .status(409)
        .json({
          error: 'One or more selected items have just gone out of stock. Please refresh the menu.',
        });
    const loyalty = {
      enabled: menu.loyalty?.enabled !== false,
      spend: Math.max(1, Number(menu.loyalty?.spend) || 10),
      earn: Math.max(1, Number(menu.loyalty?.earn) || 1),
      minRedeem: Math.max(1, Number(menu.loyalty?.minRedeem) || 100),
      pointValue: Math.max(0.01, Number(menu.loyalty?.pointValue) || 1),
    };
    const requestedLoyaltyPoints = loyalty.enabled
      ? Math.max(0, Math.floor(Number(req.body?.loyaltyPoints) || 0))
      : 0;
    // Saved contacts and customers with a completed earlier order are trusted for
    // auto-acceptance. A blocked number always remains a new order for the counter.
    await ensureTrustedContactsTable();
    const trustedCustomerRows = await sql`SELECT EXISTS (SELECT 1 FROM direct_orders WHERE customer_phone=${phone} AND status='completed') AS has_completed_order, COALESCE((SELECT blocked FROM trusted_contacts WHERE customer_phone=${phone}),FALSE) AS is_blocked, EXISTS (SELECT 1 FROM trusted_contacts WHERE customer_phone=${phone} AND blocked=FALSE) AS is_saved_contact`;
    const trustedCustomer = trustedCustomerRows[0] || {};
    const isBlockedCustomer =
      trustedCustomer.is_blocked === true || trustedCustomer.is_blocked === 't';
    const hasCompletedOrder =
      trustedCustomer.has_completed_order === true || trustedCustomer.has_completed_order === 't';
    const isSavedContact =
      trustedCustomer.is_saved_contact === true || trustedCustomer.is_saved_contact === 't';
    const isTrustedCustomer = !isBlockedCustomer && (hasCompletedOrder || isSavedContact);
    const initialStatus = isTrustedCustomer ? 'accepted' : 'new';
    const [{ orderDay, number: dailyOrderNumber }, { billYear, number: billNumber }] =
      await Promise.all([nextDailyOrderNumber(), nextAnnualBillNumber()]);
    const id = `RL${Date.now().toString(36).toUpperCase()}${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
    const trackingToken = crypto.randomBytes(24).toString('base64url');
    const subtotal = cleanItems.reduce(
      (sum, item) => sum + item.quantity * (priceNumber(item.price) + (item.style ? 10 : 0)),
      0
    );
    const redemptionValue = requestedLoyaltyPoints * loyalty.pointValue;
    if (
      requestedLoyaltyPoints &&
      (requestedLoyaltyPoints < loyalty.minRedeem || redemptionValue > subtotal)
    )
      return res
        .status(400)
        .json({ error: `Use at least ${loyalty.minRedeem} points, up to the order total.` });
    const total = subtotal - redemptionValue;
    const loyaltyPointsEarned = loyalty.enabled
      ? Math.floor(total / loyalty.spend) * loyalty.earn
      : 0;
    const savedItems = cleanItems.map(({ availabilityKey, ...item }) => item);
    if (requestedLoyaltyPoints) {
      await ensureLoyaltyTable();
      const inserted =
        await sql`WITH redeemed AS (UPDATE loyalty_accounts SET points=points-${requestedLoyaltyPoints}, total_redeemed=total_redeemed+${requestedLoyaltyPoints}, updated_at=NOW() WHERE customer_phone=${phone} AND points >= ${requestedLoyaltyPoints} AND points >= 100 RETURNING customer_phone) INSERT INTO direct_orders (id, status, mode, customer_name, customer_phone, special_request, items, total, order_day, daily_order_number, bill_year, bill_number, tracking_token, loyalty_points_redeemed, loyalty_points_earned, client_request_id, fulfillment_type) SELECT ${id}, ${initialStatus}, ${mode}, ${String(
          customerName || ''
        )
          .trim()
          .slice(0, 80)}, ${phone}, ${String(specialRequest || '')
          .trim()
          .slice(
            0,
            240
          )}, ${JSON.stringify(savedItems)}, ${total}, ${orderDay}::date, ${dailyOrderNumber}, ${billYear}, ${billNumber}, ${trackingToken}, ${requestedLoyaltyPoints}, ${loyaltyPointsEarned}, ${clientRequestId || null}, ${fulfilment} FROM redeemed RETURNING id`;
      if (!inserted.length)
        return res
          .status(409)
          .json({ error: 'Your points balance changed. Please check your points and try again.' });
    } else
      await sql`INSERT INTO direct_orders (id, status, mode, customer_name, customer_phone, special_request, items, total, order_day, daily_order_number, bill_year, bill_number, tracking_token, loyalty_points_redeemed, loyalty_points_earned, client_request_id, fulfillment_type) VALUES (${id}, ${initialStatus}, ${mode}, ${String(
        customerName || ''
      )
        .trim()
        .slice(0, 80)}, ${phone}, ${String(specialRequest || '')
        .trim()
        .slice(
          0,
          240
        )}, ${JSON.stringify(savedItems)}, ${total}, ${orderDay}::date, ${dailyOrderNumber}, ${billYear}, ${billNumber}, ${trackingToken}, 0, ${loyaltyPointsEarned}, ${clientRequestId || null}, ${fulfilment})`;
    await recordOrderEvent(id, 'created', {
      source: 'qr',
      status: initialStatus,
      fulfillment: fulfilment,
      loyaltyRedeemed: requestedLoyaltyPoints,
      loyaltyEarned: loyaltyPointsEarned,
      itemCount: savedItems.reduce((count, item) => count + Number(item.quantity || 0), 0),
    });
    const suppliedName = String(customerName || '').trim().slice(0, 80);
    if (suppliedName)
      await sql`UPDATE trusted_contacts SET customer_name=${suppliedName},updated_at=NOW() WHERE customer_phone=${phone} AND customer_name=''`;
    // The order is already safely stored. Push delivery must never delay or block it.
    void notifyDirectOrder({
      id,
      dailyOrderNumber,
      total,
      itemCount: savedItems.reduce((count, item) => count + Number(item.quantity || 0), 0),
    });
    res.json({
      id,
      status: initialStatus,
      autoAccepted: isTrustedCustomer,
      orderNumber: String(dailyOrderNumber).padStart(2, '0'),
      trackingUrl: `/track-order?token=${encodeURIComponent(trackingToken)}`,
      loyaltyPointsEarned,
      loyaltyPointsRedeemed: requestedLoyaltyPoints,
    });
  } catch (error) {
    // A simultaneous retry can lose the initial lookup but still lose safely to
    // the unique client_request_id constraint. Return the already-created order.
    if (directClientRequestId) {
      try {
        await ensureDirectOrdersTable();
        const existing =
          await sql`SELECT id,status,daily_order_number,tracking_token,loyalty_points_earned,loyalty_points_redeemed FROM direct_orders WHERE client_request_id=${directClientRequestId} LIMIT 1`;
        if (existing.length)
          return res.json({
            id: existing[0].id,
            status: existing[0].status,
            orderNumber: String(existing[0].daily_order_number).padStart(2, '0'),
            trackingUrl: `/track-order?token=${encodeURIComponent(existing[0].tracking_token)}`,
            loyaltyPointsEarned: Number(existing[0].loyalty_points_earned || 0),
            loyaltyPointsRedeemed: Number(existing[0].loyalty_points_redeemed || 0),
            duplicate: true,
          });
      } catch (_) {}
    }
    res.status(500).json({ error: 'Unable to place the order. Please call us instead.' });
  }
});

app.post('/api/orders/counter', async (req, res) => {
  let counterClientRequestId = '';
  try {
    const {
      customerName,
      customerPhone,
      specialRequest,
      loyaltyPoints,
      tableArea,
      tableNumber,
      tableOrderId,
      items = [],
      action = 'submit',
      source = '',
    } = req.body || {};
    const captain =
      source === 'captain' ? await getActiveCaptainSession(req.get('X-Captain-Session')) : null;
    if (source === 'captain' && !captain)
      return res.status(401).json({ error: 'Captain sign-in has expired. Sign in again.' });
    const clientRequestId = String(req.get('X-Counter-Order-Id') || req.body?.clientRequestId || '')
      .trim()
      .slice(0, 80);
    counterClientRequestId = clientRequestId;
    const menu = await getSection('airMenu');
    const priceNumber = (value) => Number(String(value || '').replace(/[^0-9.]/g, '')) || 0;
    const displayItemName = (value) =>
      String(value || '')
        .replace(/[.…·]{2,}/g, ' ')
        .replace(/\s+\d{2,5}(?:\.\d{1,2})?\s*\/?\s*$/, '')
        .replace(/\s+/g, ' ')
        .trim();
    const menuItems = [...(menu.items || []), ...(menu.barItems || [])];
    const portionPrice = (item, portion) =>
      ({
        half: item.halfPrice,
        full: item.fullPrice,
        'with bone': item.withBonePrice,
        boneless: item.bonelessPrice,
        '30 ml': item.price30ml,
        '60 ml': item.price60ml,
        '90 ml': item.price90ml,
        '180 ml': item.price180ml,
      })[
        String(portion || '')
          .trim()
          .toLowerCase()
      ] ||
      item.price ||
      '';
    const submitted = Array.isArray(items)
      ? items.filter((item) => Number(item.quantity) > 0).slice(0, 30)
      : [];
    const clean = submitted
      .map((item) => {
        const name = String(item.name || '')
            .trim()
            .slice(0, 100),
          category = String(item.category || '')
            .trim()
            .slice(0, 80);
        const source = menuItems.find(
          (dish) =>
            displayItemName(dish.name).toLowerCase() === name.toLowerCase() &&
            String(dish.category || '')
              .trim()
              .toLowerCase() === category.toLowerCase()
        );
        const price = source && portionPrice(source, item.portion);
        if (!source || !priceNumber(price)) return null;
        const style =
          /^(gravy|semi-gravy)$/i.test(String(item.style || '').trim()) &&
          (source.gravyStyleAvailable || source.gravyAvailable || source.semiGravyAvailable)
            ? String(item.style).trim()
            : '';
        return {
          name: displayItemName(source.name).slice(0, 100),
          category: String(source.category || '').slice(0, 80),
          portion: String(item.portion || '').slice(0, 40),
          style,
          note: String(item.note || '')
            .trim()
            .slice(0, 80),
          quantity: Math.min(20, Number(item.quantity) || 0),
          price: `₹${priceNumber(price)}`,
          availabilityKey: `${String(source.category || '').toLowerCase()}::${String(source.name || '').toLowerCase()}`,
        };
      })
      .filter(Boolean);
    if (!clean.length || clean.length !== submitted.length)
      return res.status(400).json({ error: 'Choose at least one current menu item.' });
    await ensureDirectOrdersTable();
    await ensureMenuAvailabilityTable();
    if (clientRequestId) {
      const existing =
        await sql`SELECT id,daily_order_number,total FROM direct_orders WHERE client_request_id=${clientRequestId} LIMIT 1`;
      if (existing.length)
        return res.json({
          id: existing[0].id,
          orderNumber: String(existing[0].daily_order_number).padStart(2, '0'),
          total: Number(existing[0].total),
          duplicate: true,
        });
    }
    const unavailable = new Set(
      (await sql`SELECT item_key FROM menu_availability WHERE unavailable_until > NOW()`).map(
        (row) => row.item_key
      )
    );
    if (clean.some((item) => unavailable.has(item.availabilityKey)))
      return res.status(409).json({ error: 'One or more selected items are out of stock.' });
    const [{ orderDay, number }, { billYear, number: billNumber }] = await Promise.all([
      nextDailyOrderNumber(),
      nextAnnualBillNumber(),
    ]);
    const id = `RL${Date.now().toString(36).toUpperCase()}${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
    const saved = clean.map(({ availabilityKey, ...item }) => item),
      subtotal = saved.reduce(
        (sum, item) => sum + item.quantity * (priceNumber(item.price) + (item.style ? 10 : 0)),
        0
      );
    const suppliedPhone = String(customerPhone || '')
      .replace(/\D/g, '')
      .slice(0, 16);
    const loyalty = {
      enabled: menu.loyalty?.enabled !== false,
      spend: Math.max(1, Number(menu.loyalty?.spend) || 10),
      earn: Math.max(1, Number(menu.loyalty?.earn) || 1),
      minRedeem: Math.max(1, Number(menu.loyalty?.minRedeem) || 100),
      pointValue: Math.max(0.01, Number(menu.loyalty?.pointValue) || 1),
    };
    const requestedLoyaltyPoints = loyalty.enabled
      ? Math.max(0, Math.floor(Number(loyaltyPoints) || 0))
      : 0;
    if (
      requestedLoyaltyPoints &&
      (suppliedPhone.length < 7 ||
        requestedLoyaltyPoints < loyalty.minRedeem ||
        requestedLoyaltyPoints * loyalty.pointValue > subtotal)
    )
      return res
        .status(400)
        .json({
          error: `Use a valid mobile number and at least ${loyalty.minRedeem} points, up to the order total.`,
        });
    const dineInArea = String(tableArea || '')
        .trim()
        .slice(0, 60),
      dineInNumber = Number.parseInt(tableNumber, 10);
    const isDineIn =
      !!dineInArea && Number.isInteger(dineInNumber) && dineInNumber > 0 && dineInNumber <= 9999;
    if (isDineIn && captain && captain.areas.length && !captain.areas.includes(dineInArea))
      return res
        .status(403)
        .json({ error: 'This table area is not assigned to your Captain account.' });
    const activeTable = isDineIn
      ? await sql`SELECT id,items,total,daily_order_number,loyalty_points_redeemed,status FROM direct_orders WHERE mode='table' AND table_area=${dineInArea} AND table_number=${dineInNumber} AND order_day=${orderDay}::date AND status IN ('saved','held','accepted','preparing','ready') LIMIT 1`
      : [];
    const expectedTableOrderId = String(tableOrderId || '')
      .trim()
      .slice(0, 120);
    const tableConflict = activeTable[0]
      ? {
          id: activeTable[0].id,
          orderNumber: String(activeTable[0].daily_order_number).padStart(2, '0'),
          status: activeTable[0].status,
          items: Array.isArray(activeTable[0].items) ? activeTable[0].items : [],
        }
      : null;
    if (
      source === 'captain' &&
      expectedTableOrderId &&
      (!activeTable.length || activeTable[0].id !== expectedTableOrderId)
    )
      return res
        .status(409)
        .json({
          error:
            'This table changed while the order was being prepared. Review the offline order before merging it.',
          code: 'table_changed',
          conflict: tableConflict,
        });
    if (source === 'captain' && !expectedTableOrderId && activeTable.length)
      return res
        .status(409)
        .json({
          error: 'This table is now active. Review the offline order before merging it.',
          code: 'table_changed',
          conflict: tableConflict,
        });
    if (activeTable.length && source !== 'captain')
      return res
        .status(409)
        .json({
          error:
            'This table is already active. Add items from the Orders console to keep one bill and one KOT flow.',
        });
    const orderMode = isDineIn ? 'table' : 'counter',
      fulfillment = isDineIn ? 'dine_in' : 'takeaway';
    const dineInAction =
      isDineIn && ['save', 'hold'].includes(String(action)) ? String(action) : 'submit';
    const initialStatus =
      dineInAction === 'hold' ? 'held' : dineInAction === 'save' ? 'saved' : 'accepted';
    const phone = suppliedPhone || `walkin-${id}`,
      total = subtotal - requestedLoyaltyPoints * loyalty.pointValue,
      earned = loyalty.enabled
        ? Math.floor((subtotal - requestedLoyaltyPoints * loyalty.pointValue) / loyalty.spend) *
          loyalty.earn
        : 0,
      trackingToken = crypto.randomBytes(24).toString('base64url');
    if (activeTable.length && source === 'captain') {
      const existingItems = Array.isArray(activeTable[0].items) ? activeTable[0].items : [];
      const merged = [...existingItems];
      saved.forEach((item) => {
        const match = merged.find(
          (current) =>
            current.name === item.name &&
            current.category === item.category &&
            current.portion === item.portion &&
            current.style === item.style &&
            String(current.note || '') === String(item.note || '')
        );
        if (match)
          match.quantity = Math.min(20, Number(match.quantity || 0) + Number(item.quantity || 0));
        else merged.push(item);
      });
      const nextTotal =
        merged.reduce(
          (sum, item) =>
            sum + Number(item.quantity || 0) * (priceNumber(item.price) + (item.style ? 10 : 0)),
          0
        ) -
        Number(activeTable[0].loyalty_points_redeemed || 0) * loyalty.pointValue;
      await sql`UPDATE direct_orders SET items=${JSON.stringify(merged)},total=${nextTotal},special_request=CASE WHEN ${String(specialRequest || '').trim()}='' THEN special_request WHEN special_request='' THEN ${String(
        specialRequest || ''
      )
        .trim()
        .slice(0, 240)} ELSE special_request || ' · ' || ${String(specialRequest || '')
        .trim()
        .slice(0, 240)} END,updated_at=NOW() WHERE id=${activeTable[0].id}`;
      await recordOrderEvent(activeTable[0].id, 'captain-items-added', {
        itemCount: saved.reduce((count, item) => count + Number(item.quantity || 0), 0),
        source: 'captain',
        captainId: captain.id,
        captainName: captain.name,
      });
      return res
        .status(201)
        .json({
          id: activeTable[0].id,
          status: activeTable[0].status,
          orderNumber: String(activeTable[0].daily_order_number).padStart(2, '0'),
          total: nextTotal,
          continued: true,
        });
    }
    if (requestedLoyaltyPoints) {
      await ensureLoyaltyTable();
      const inserted =
        await sql`WITH redeemed AS (UPDATE loyalty_accounts SET points=points-${requestedLoyaltyPoints},total_redeemed=total_redeemed+${requestedLoyaltyPoints},updated_at=NOW() WHERE customer_phone=${phone} AND points>=${requestedLoyaltyPoints} AND points>=100 RETURNING customer_phone) INSERT INTO direct_orders (id,status,mode,customer_name,customer_phone,special_request,items,total,order_day,daily_order_number,bill_year,bill_number,tracking_token,loyalty_points_redeemed,loyalty_points_earned,fulfillment_type,client_request_id,table_area,table_number) SELECT ${id},${initialStatus},${orderMode},${String(
          customerName || 'Walk-in customer'
        )
          .trim()
          .slice(0, 80)},${phone},${String(specialRequest || '')
          .trim()
          .slice(
            0,
            240
          )},${JSON.stringify(saved)},${total},${orderDay}::date,${number},${billYear},${billNumber},${trackingToken},${requestedLoyaltyPoints},${earned},${fulfillment},${clientRequestId || null},${isDineIn ? dineInArea : null},${isDineIn ? dineInNumber : null} FROM redeemed RETURNING id`;
      if (!inserted.length)
        return res
          .status(409)
          .json({ error: 'Wallet points changed. Check the customer balance and try again.' });
    } else
      await sql`INSERT INTO direct_orders (id,status,mode,customer_name,customer_phone,special_request,items,total,order_day,daily_order_number,bill_year,bill_number,tracking_token,loyalty_points_redeemed,loyalty_points_earned,fulfillment_type,client_request_id,table_area,table_number) VALUES (${id},${initialStatus},${orderMode},${String(
        customerName || 'Walk-in customer'
      )
        .trim()
        .slice(0, 80)},${phone},${String(specialRequest || '')
        .trim()
        .slice(
          0,
          240
        )},${JSON.stringify(saved)},${total},${orderDay}::date,${number},${billYear},${billNumber},${trackingToken},0,${earned},${fulfillment},${clientRequestId || null},${isDineIn ? dineInArea : null},${isDineIn ? dineInNumber : null})`;
    await recordOrderEvent(id, 'created', {
      source: captain ? 'captain' : isDineIn ? 'dine-in' : 'counter',
      status: initialStatus,
      fulfillment,
      tableArea: isDineIn ? dineInArea : '',
      tableNumber: isDineIn ? dineInNumber : null,
      loyaltyRedeemed: requestedLoyaltyPoints,
      loyaltyEarned: earned,
      itemCount: saved.reduce((count, item) => count + Number(item.quantity || 0), 0),
      ...(captain ? { captainId: captain.id, captainName: captain.name } : {}),
    });
    if (initialStatus === 'accepted')
      void notifyDirectOrder({
        id,
        dailyOrderNumber: number,
        total,
        itemCount: saved.reduce((count, item) => count + Number(item.quantity || 0), 0),
      });
    res
      .status(201)
      .json({
        id,
        status: initialStatus,
        autoAccepted: initialStatus === 'accepted',
        orderNumber: String(number).padStart(2, '0'),
        total,
      });
  } catch (error) {
    if (counterClientRequestId) {
      try {
        await ensureDirectOrdersTable();
        const existing =
          await sql`SELECT id,status,daily_order_number,total FROM direct_orders WHERE client_request_id=${counterClientRequestId} LIMIT 1`;
        if (existing.length)
          return res.json({
            id: existing[0].id,
            status: existing[0].status,
            orderNumber: String(existing[0].daily_order_number).padStart(2, '0'),
            total: Number(existing[0].total),
            duplicate: true,
          });
      } catch (_) {}
    }
    res.status(500).json({ error: 'Unable to save the counter order.' });
  }
});
app.get('/api/orders', async (req, res) => {
  try {
    await Promise.all([ensureDirectOrdersTable(), ensureOrderEventsTable()]);
    const search = String(req.query.search || '')
      .replace(/\D/g, '')
      .slice(0, 16);
    const like = `%${search}%`;
    const today = kolkataOrderDay();
    const history = req.query.history === '1';
    const requestedDay = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || ''))
      ? String(req.query.date)
      : '';
    const operatingStatus = await getOrdersOperatingStatus();
    const select =
      "SELECT o.*, (SELECT COUNT(*) FROM direct_orders h WHERE h.customer_phone=o.customer_phone) AS customer_order_count, (SELECT MAX(h.created_at) FROM direct_orders h WHERE h.customer_phone=o.customer_phone AND h.id<>o.id) AS customer_last_order_at, COALESCE((SELECT e.details->>'captainId' FROM order_events e WHERE e.order_id=o.id AND e.event_type='created' ORDER BY e.created_at ASC LIMIT 1),'') AS captain_id, COALESCE((SELECT string_agg(DISTINCT NULLIF(TRIM(e.details->>'captainName'), ''), ', ') FROM order_events e WHERE e.order_id=o.id AND e.event_type IN ('created','captain-items-added')),'') AS captain_names FROM direct_orders o";
    res.set({
      'Cache-Control': 'no-store',
      'X-Orders-Day': today,
      'X-Orders-View': history ? 'history' : 'current',
      'X-Orders-Session': operatingStatus.open ? 'open' : 'closed',
    });
    let orders;
    if (history && !requestedDay)
      orders = await sql(
        `${select} WHERE ($1='' OR o.customer_phone LIKE $2 OR CAST(o.daily_order_number AS TEXT) LIKE $2) ORDER BY o.created_at DESC LIMIT 100`,
        [search, like]
      );
    else if (history)
      orders = await sql(
        `${select} WHERE o.order_day=$1::date AND ($2='' OR o.customer_phone LIKE $3 OR CAST(o.daily_order_number AS TEXT) LIKE $3) ORDER BY o.created_at DESC LIMIT 100`,
        [requestedDay || today, search, like]
      );
    else
      orders = await sql(
        `${select} WHERE o.order_day=$1::date AND ($2='' OR o.customer_phone LIKE $3 OR CAST(o.daily_order_number AS TEXT) LIKE $3) ORDER BY o.created_at DESC LIMIT 100`,
        [today, search, like]
      );
    if (req.captain) {
      const areas = Array.isArray(req.captain.areas) ? req.captain.areas : [];
      orders = orders.filter(
        (order) =>
          order.mode === 'table' &&
          (!areas.length || areas.includes(String(order.table_area || '')))
      );
    }
    res.json(orders);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
app.get('/api/orders/live-summary', async (req, res) => {
  try {
    await ensureDirectOrdersTable();
    const orderDay = kolkataOrderDay();
    const rows =
      await sql`SELECT COUNT(*) FILTER (WHERE status IN ('new','accepted','preparing','ready'))::integer AS active_order_count, COALESCE(MAX(daily_order_number) FILTER (WHERE status IN ('new','accepted','preparing','ready')),0)::integer AS latest_active_order_number, COALESCE(MAX(daily_order_number),0)::integer AS latest_order_number FROM direct_orders WHERE order_day=${orderDay}::date`;
    res.set('Cache-Control', 'no-store');
    res.json({
      orderDay,
      activeOrderCount: Number(rows[0]?.active_order_count || 0),
      latestActiveOrderNumber: Number(rows[0]?.latest_active_order_number || 0),
      latestOrderNumber: Number(rows[0]?.latest_order_number || 0),
    });
  } catch (error) {
    res.status(500).json({ error: 'Unable to load live order status.' });
  }
});
app.get('/api/orders/:id/print', async (req, res) => {
  try {
    await ensureDirectOrdersTable();
    await ensureLoyaltyTable();
    const rows =
      await sql`SELECT o.*, COALESCE(l.points, 0) AS loyalty_points FROM direct_orders o LEFT JOIN loyalty_accounts l ON l.customer_phone=o.customer_phone WHERE o.id=${req.params.id} LIMIT 1`;
    if (!rows.length) return res.status(404).json({ error: 'Order not found.' });
    res.set('Cache-Control', 'no-store');
    res.json(rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Unable to prepare this receipt.' });
  }
});
app.post('/api/orders/:id/bill-print/claim', async (req, res) => {
  try {
    await ensureDirectOrdersTable();
    await ensureOrderPrintJobsTable();
    const order = await sql`SELECT id FROM direct_orders WHERE id=${req.params.id} LIMIT 1`;
    if (!order.length) return res.status(404).json({ error: 'Order not found.' });
    await sql`INSERT INTO order_print_jobs (order_id,job_type,status) VALUES (${req.params.id},'bill','queued') ON CONFLICT (order_id,job_type) DO NOTHING`;
    const claimed =
      await sql`UPDATE order_print_jobs SET status='printing',lease_expires_at=NOW()+INTERVAL '45 seconds',updated_at=NOW() WHERE order_id=${req.params.id} AND job_type='bill' AND (status IN ('queued','failed') OR (status='printing' AND lease_expires_at<NOW())) RETURNING order_id`;
    res.json({ claimed: !!claimed.length });
  } catch (error) {
    res.status(500).json({ error: 'Unable to claim bill print job.' });
  }
});
app.post('/api/orders/:id/bill-print/:result', async (req, res) => {
  try {
    if (!['complete', 'failed'].includes(req.params.result))
      return res.status(400).json({ error: 'Invalid print result.' });
    await ensureOrderPrintJobsTable();
    await sql`UPDATE order_print_jobs SET status=${req.params.result === 'complete' ? 'printed' : 'failed'},lease_expires_at=NULL,updated_at=NOW() WHERE order_id=${req.params.id} AND job_type='bill'`;
    await recordOrderEvent(
      req.params.id,
      req.params.result === 'complete' ? 'bill-print-completed' : 'bill-print-failed',
      {}
    );
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: 'Unable to update bill print job.' });
  }
});
app.get('/api/order-tracking/:token', async (req, res) => {
  try {
    await ensureDirectOrdersTable();
    const token = String(req.params.token || '');
    if (!/^[A-Za-z0-9_-]{24,128}$/.test(token))
      return res.status(404).json({ error: 'Order not found.' });
    const rows =
      await sql`SELECT daily_order_number, order_day, status, fulfillment_type, items, total, special_request, cancellation_reason, created_at, updated_at FROM direct_orders WHERE tracking_token=${token} LIMIT 1`;
    if (!rows.length) return res.status(404).json({ error: 'Order not found.' });
    res.set('Cache-Control', 'no-store');
    res.json(rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Unable to load this order.' });
  }
});
app.post('/api/loyalty', async (req, res) => {
  if (!allowPublicRequest(req, res, 'loyalty-lookup', 60, 60 * 1000)) return;
  try {
    await ensureLoyaltyTable();
    const phone = String(req.body?.phone || '').replace(/\D/g, '');
    if (phone.length < 7) return res.status(400).json({ error: 'Enter a valid mobile number.' });
    const rows =
      await sql`SELECT points FROM loyalty_accounts WHERE customer_phone=${phone} LIMIT 1`;
    const points = Number(rows[0]?.points || 0);
    res.set('Cache-Control', 'no-store');
    res.json({ points, eligible: points >= 100 });
  } catch (error) {
    res.status(500).json({ error: 'Unable to load loyalty points.' });
  }
});
app.post('/api/order-tracking/:token/cancel', async (req, res) => {
  if (!allowPublicRequest(req, res, 'guest-cancel', 10, 60 * 1000)) return;
  try {
    await ensureDirectOrdersTable();
    await ensureLoyaltyTable();
    const token = String(req.params.token || '');
    const reason = String(req.body?.reason || '')
      .trim()
      .slice(0, 240);
    if (!/^[A-Za-z0-9_-]{24,128}$/.test(token))
      return res.status(404).json({ error: 'Order not found.' });
    if (reason.length < 3)
      return res.status(400).json({ error: 'Please tell us why you need to cancel.' });
    const cancelled =
      await sql`WITH cancelled AS (UPDATE direct_orders SET status='cancelled', cancellation_reason=${reason}, cancelled_at=NOW(), service_state='available', service_requested_at=NULL, updated_at=NOW() WHERE tracking_token=${token} AND status='new' RETURNING id,customer_phone,loyalty_points_redeemed), refunded AS (UPDATE loyalty_accounts account SET points=account.points+cancelled.loyalty_points_redeemed, total_redeemed=GREATEST(0,account.total_redeemed-cancelled.loyalty_points_redeemed), updated_at=NOW() FROM cancelled WHERE account.customer_phone=cancelled.customer_phone AND cancelled.loyalty_points_redeemed>0) SELECT id,customer_phone,loyalty_points_redeemed FROM cancelled`;
    if (cancelled.length) {
      const order = cancelled[0];
      const redeemed = Math.max(0, Number(order.loyalty_points_redeemed || 0));
      await recordOrderEvent(order.id, 'cancelled', {
        source: 'guest',
        reason,
        loyaltyRefunded: redeemed,
      });
      return res.json({ ok: true });
    }
    const alreadyCancelled =
      await sql`SELECT id FROM direct_orders WHERE tracking_token=${token} AND status='cancelled'`;
    if (!alreadyCancelled.length)
      return res
        .status(409)
        .json({
          error: 'This order is already being handled. Please call the restaurant for help.',
        });
    res.json({ ok: true, unchanged: true });
  } catch (error) {
    res.status(500).json({ error: 'Unable to cancel this order. Please call the restaurant.' });
  }
});
app.patch('/api/orders/:id/items', async (req, res) => {
  try {
    await ensureDirectOrdersTable();
    const originalRows =
      await sql`SELECT items, loyalty_points_redeemed FROM direct_orders WHERE id=${req.params.id} LIMIT 1`;
    if (!originalRows.length) return res.status(404).json({ error: 'Order not found.' });
    const original = Array.isArray(originalRows[0].items) ? originalRows[0].items : [];
    const quantities = Array.isArray(req.body?.quantities) ? req.body.quantities : [];
    const items = original
      .map((item, index) => ({
        ...item,
        quantity: Math.max(0, Math.min(20, Number(quantities[index]) || 0)),
      }))
      .filter((item) => item.quantity > 0);
    if (!items.length)
      return res.status(400).json({ error: 'Keep at least one item in the order.' });
    const price = (value) => Number(String(value || '').replace(/[^0-9.]/g, '')) || 0;
    const subtotal = items.reduce(
      (sum, item) => sum + item.quantity * (price(item.price) + (item.style ? 10 : 0)),
      0
    );
    const menu = await getSection('airMenu');
    const loyalty = {
      enabled: menu.loyalty?.enabled !== false,
      spend: Math.max(1, Number(menu.loyalty?.spend) || 10),
      earn: Math.max(1, Number(menu.loyalty?.earn) || 1),
      pointValue: Math.max(0.01, Number(menu.loyalty?.pointValue) || 1),
    };
    const redeemed = loyalty.enabled
      ? Math.max(0, Number(originalRows[0].loyalty_points_redeemed || 0))
      : 0;
    if (redeemed * loyalty.pointValue > subtotal)
      return res
        .status(409)
        .json({
          error: 'This change would make the redeemed loyalty points larger than the order total.',
        });
    const total = subtotal - redeemed * loyalty.pointValue;
    const earned = loyalty.enabled ? Math.floor(total / loyalty.spend) * loyalty.earn : 0;
    const rows =
      await sql`UPDATE direct_orders SET items=${JSON.stringify(items)}, total=${total}, loyalty_points_earned=${earned}, updated_at=NOW() WHERE id=${req.params.id} AND created_at >= NOW() - INTERVAL '10 minutes' AND status IN ('new','accepted','preparing') RETURNING id`;
    if (!rows.length)
      return res
        .status(409)
        .json({
          error:
            'Orders can only be modified during the first 10 minutes while they are being handled.',
        });
    await recordOrderEvent(req.params.id, 'items-updated', {
      itemCount: items.reduce((count, item) => count + Number(item.quantity || 0), 0),
      total,
      loyaltyEarned: earned,
    });
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: 'Unable to modify this order.' });
  }
});
app.get('/api/orders/push-key', (req, res) => {
  if (!pushEnabled)
    return res.status(503).json({ error: 'Push notifications have not been configured yet.' });
  res.set('Cache-Control', 'no-store');
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
});
app.post('/api/orders/push-subscriptions', async (req, res) => {
  try {
    if (!pushEnabled)
      return res.status(503).json({ error: 'Push notifications have not been configured yet.' });
    const subscription = req.body?.subscription;
    if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth)
      return res.status(400).json({ error: 'Invalid push subscription.' });
    await ensurePushSubscriptionsTable();
    await sql`INSERT INTO order_push_subscriptions (endpoint, subscription) VALUES (${String(subscription.endpoint)}, ${JSON.stringify(subscription)}) ON CONFLICT (endpoint) DO UPDATE SET subscription=EXCLUDED.subscription, updated_at=NOW()`;
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: 'Unable to save push subscription.' });
  }
});
app.patch('/api/orders/:id', async (req, res) => {
  try {
    await ensureDirectOrdersTable();
    await ensureLoyaltyTable();
    const status = String(req.body?.status || '');
    const cancellationReason = String(req.body?.reason || '')
      .trim()
      .slice(0, 240);
    const transitions = {
      new: ['accepted', 'rejected', 'cancelled'],
      accepted: ['preparing', 'ready', 'completed', 'rejected', 'cancelled'],
      preparing: ['ready', 'completed', 'rejected', 'cancelled'],
      ready: ['completed', 'rejected', 'cancelled'],
    };
    const currentRows =
      await sql`SELECT status,customer_phone,customer_name FROM direct_orders WHERE id=${req.params.id} LIMIT 1`;
    if (!currentRows.length) return res.status(404).json({ error: 'Order not found.' });
    const previous = String(currentRows[0].status || '');
    if (previous === status) return res.json({ ok: true, unchanged: true, status });
    if (!transitions[previous]?.includes(status))
      return res
        .status(409)
        .json({
          error: `An order cannot move from ${previous || 'its current state'} to ${status || 'that state'}.`,
        });
    if (status === 'cancelled' && cancellationReason.length < 3)
      return res.status(400).json({ error: 'Enter a brief reason for cancelling this order.' });
    const [changed] = await sql.transaction((tx) => [
      tx`UPDATE direct_orders SET status=${status}, cancellation_reason=${status === 'cancelled' ? cancellationReason : null}, cancelled_at=${status === 'cancelled' ? new Date() : null}, service_state=CASE WHEN ${status} IN ('rejected','cancelled') THEN 'available' ELSE service_state END, service_requested_at=CASE WHEN ${status} IN ('rejected','cancelled') THEN NULL ELSE service_requested_at END, updated_at=NOW() WHERE id=${req.params.id} AND status=${previous} RETURNING id`,
      ...(status === 'completed'
        ? [
            tx`WITH awarded AS (UPDATE direct_orders SET loyalty_awarded_at=NOW() WHERE id=${req.params.id} AND status='completed' AND loyalty_awarded_at IS NULL RETURNING customer_phone, loyalty_points_earned) INSERT INTO loyalty_accounts (customer_phone, points, total_earned) SELECT customer_phone, loyalty_points_earned, loyalty_points_earned FROM awarded ON CONFLICT (customer_phone) DO UPDATE SET points=loyalty_accounts.points+EXCLUDED.points, total_earned=loyalty_accounts.total_earned+EXCLUDED.total_earned, updated_at=NOW()`,
          ]
        : []),
      ...(['rejected', 'cancelled'].includes(status)
        ? [
            tx`WITH reversed AS (UPDATE direct_orders SET loyalty_awarded_at=NULL WHERE id=${req.params.id} AND loyalty_awarded_at IS NOT NULL RETURNING customer_phone, loyalty_points_earned) UPDATE loyalty_accounts a SET points=GREATEST(0, a.points-reversed.loyalty_points_earned), total_earned=GREATEST(0, a.total_earned-reversed.loyalty_points_earned), updated_at=NOW() FROM reversed WHERE a.customer_phone=reversed.customer_phone`,
            tx`WITH redeem AS (SELECT customer_phone, loyalty_points_redeemed FROM direct_orders WHERE id=${req.params.id} AND status=${status} AND loyalty_points_redeemed > 0), cleared AS (UPDATE direct_orders o SET loyalty_points_redeemed=0 FROM redeem WHERE o.id=${req.params.id} RETURNING redeem.customer_phone, redeem.loyalty_points_redeemed) UPDATE loyalty_accounts a SET points=a.points+cleared.loyalty_points_redeemed, total_redeemed=GREATEST(0,a.total_redeemed-cleared.loyalty_points_redeemed), updated_at=NOW() FROM cleared WHERE a.customer_phone=cleared.customer_phone`,
          ]
        : []),
    ]);
    if (!changed.length)
      return res
        .status(409)
        .json({ error: 'This order changed on another device. Refresh and try again.' });
    if (status === 'completed') {
      await ensureTrustedContactsTable();
      const customer = currentRows[0];
      await sql`INSERT INTO trusted_contacts (customer_phone,customer_name) VALUES (${customer.customer_phone},${String(customer.customer_name || '').trim().slice(0, 80)}) ON CONFLICT (customer_phone) DO UPDATE SET customer_name=CASE WHEN trusted_contacts.customer_name='' AND EXCLUDED.customer_name<>'' THEN EXCLUDED.customer_name ELSE trusted_contacts.customer_name END, updated_at=NOW()`;
    }
    await recordOrderEvent(req.params.id, 'status-changed', {
      from: previous,
      to: status,
      ...(status === 'cancelled' ? { reason: cancellationReason } : {}),
    });
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/orders/:id/bill-printed', async (req, res) => {
  try {
    await ensureDirectOrdersTable();
    const rows =
      await sql`UPDATE direct_orders SET bill_printed_at=COALESCE(bill_printed_at,NOW()),updated_at=NOW() WHERE id=${req.params.id} AND mode='table' AND status IN ('accepted','preparing','ready') RETURNING id,bill_printed_at`;
    if (!rows.length)
      return res
        .status(409)
        .json({ error: 'Only an active dine-in order can be marked as bill printed.' });
    await recordOrderEvent(req.params.id, 'bill-printed', {});
    res.json({ ok: true, order: rows[0] });
  } catch (error) {
    res.status(500).json({ error: 'Unable to mark the bill as printed.' });
  }
});

app.post('/api/orders/:id/settle', async (req, res) => {
  try {
    await ensureDirectOrdersTable();
    await ensureLoyaltyTable();
    const paymentType = ['cash', 'upi', 'card', 'due', 'other', 'not_paid', 'part'].includes(
      String(req.body?.paymentType || '')
    )
      ? String(req.body.paymentType)
      : '';
    const requestedAmount = Math.max(0, Number(req.body?.amount) || 0);
    const suppliedReceived = Number(req.body?.paymentReceived);
    const requestId = String(req.get('X-Settlement-Id') || req.body?.requestId || '')
      .trim()
      .slice(0, 100);
    if (!paymentType) return res.status(400).json({ error: 'Choose a payment type.' });
    if (requestId) {
      const existing =
        await sql`SELECT id FROM direct_orders WHERE id=${req.params.id} AND settlement_request_id=${requestId} LIMIT 1`;
      if (existing.length) return res.json({ ok: true, duplicate: true });
    }
    const orderRows =
      await sql`SELECT total FROM direct_orders WHERE id=${req.params.id} AND status IN ('accepted','preparing','ready') LIMIT 1`;
    if (!orderRows.length)
      return res.status(409).json({ error: 'This order is not waiting for payment.' });
    const total = Math.max(0, Number(orderRows[0].total) || 0);
    const paymentReceived = Number.isFinite(suppliedReceived)
      ? Math.max(0, suppliedReceived)
      : requestedAmount || total;
    if (['cash', 'upi', 'card', 'other'].includes(paymentType) && paymentReceived < total)
      return res.status(400).json({ error: 'Payment received cannot be less than the order total.' });
    const changeDue = paymentType === 'cash' ? Math.max(0, paymentReceived - total) : 0;
    const tipAmount = paymentType === 'upi' ? Math.max(0, paymentReceived - total) : 0;
    const [rows] = await sql.transaction((tx) => [
      tx`UPDATE direct_orders SET status='completed',settled_at=NOW(),settlement_type=${paymentType},settlement_amount=${total},payment_received=${paymentReceived},change_due=${changeDue},tip_amount=${tipAmount},settlement_request_id=${requestId || null},updated_at=NOW() WHERE id=${req.params.id} AND status IN ('accepted','preparing','ready') RETURNING customer_phone,customer_name,loyalty_points_earned`,
      tx`WITH awarded AS (UPDATE direct_orders SET loyalty_awarded_at=NOW() WHERE id=${req.params.id} AND status='completed' AND loyalty_awarded_at IS NULL RETURNING customer_phone,loyalty_points_earned) INSERT INTO loyalty_accounts (customer_phone,points,total_earned) SELECT customer_phone,loyalty_points_earned,loyalty_points_earned FROM awarded ON CONFLICT (customer_phone) DO UPDATE SET points=loyalty_accounts.points+EXCLUDED.points,total_earned=loyalty_accounts.total_earned+EXCLUDED.total_earned,updated_at=NOW()`,
    ]);
    if (!rows.length)
      return res.status(409).json({ error: 'This table is not waiting for settlement.' });
    await ensureTrustedContactsTable();
    await sql`INSERT INTO trusted_contacts (customer_phone,customer_name) VALUES (${rows[0].customer_phone},${String(rows[0].customer_name || '').trim().slice(0, 80)}) ON CONFLICT (customer_phone) DO UPDATE SET customer_name=CASE WHEN trusted_contacts.customer_name='' AND EXCLUDED.customer_name<>'' THEN EXCLUDED.customer_name ELSE trusted_contacts.customer_name END, updated_at=NOW()`;
    await recordOrderEvent(req.params.id, 'settled', {
      paymentType,
      amount: total,
      paymentReceived,
      changeDue,
      tipAmount,
      requestId,
    });
    res.json({ ok: true, total, paymentReceived, changeDue, tipAmount });
  } catch (error) {
    res.status(500).json({ error: 'Unable to save this payment.' });
  }
});

app.get('/api/register/summary', async (req, res) => {
  try {
    await ensureDirectOrdersTable();
    const day = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || ''))
      ? String(req.query.date)
      : kolkataOrderDay();
    const orders =
      await sql`SELECT daily_order_number,mode,table_area,table_number,customer_name,customer_phone,total,settlement_type,settlement_amount,payment_received,change_due,tip_amount,settled_at,created_at FROM direct_orders WHERE order_day=${day}::date AND status='completed' ORDER BY COALESCE(settled_at,created_at),daily_order_number`;
    res.set('Cache-Control', 'no-store');
    res.json({ day, orders });
  } catch (error) {
    res.status(500).json({ error: 'Unable to prepare the register summary.' });
  }
});
app.get('/api/orders/availability', async (req, res) => {
  try {
    await ensureMenuAvailabilityTable();
    res.json(await sql`SELECT * FROM menu_availability WHERE unavailable_until > NOW()`);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.get('/api/orders/menu', async (req, res) => {
  try {
    const menu = await getSection('airMenu');
    const order = Array.isArray(menu.categoryOrder) ? menu.categoryOrder : [];
    const format = (items, menuType) =>
      items
        .map((item) => ({
          name: item.name,
          category: item.category,
          menuType,
          key: `${String(item.category || '').toLowerCase()}::${String(item.name || '').toLowerCase()}`,
          categoryOrderIndex: order.indexOf(item.category),
          price: item.price,
          halfPrice: item.halfPrice,
          fullPrice: item.fullPrice,
          withBonePrice: item.withBonePrice,
          bonelessPrice: item.bonelessPrice,
          price30ml: item.price30ml,
          price60ml: item.price60ml,
          price90ml: item.price90ml,
          price180ml: item.price180ml,
          gravyStyleAvailable: !!(
            item.gravyStyleAvailable ||
            item.gravyAvailable ||
            item.semiGravyAvailable
          ),
        }))
        .filter((item) => item.name);
    res.json([...format(menu.items || [], 'food'), ...format(menu.barItems || [], 'bar')]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.get('/api/orders/operations', async (req, res) => {
  try {
    await ensureOperationsConfigTable();
    const rows =
      await sql`SELECT config FROM order_operations_config WHERE config_key='default' LIMIT 1`;
    const menu = await getSection('airMenu');
    const format = (items, menuType) =>
      items
        .map((item) => ({
          name: String(item.name || ''),
          category: String(item.category || ''),
          menuType,
          withBonePrice: String(item.withBonePrice || ''),
          bonelessPrice: String(item.bonelessPrice || ''),
        }))
        .filter((item) => item.name);
    const config =
      rows[0]?.config && typeof rows[0].config === 'object'
        ? rows[0].config
        : { printers: [], routes: [] };
    res.set('Cache-Control', 'no-store');
    res.json({
      config: {
        printers: Array.isArray(config.printers) ? config.printers : [],
        routes: Array.isArray(config.routes) ? config.routes : [],
        tableAreas: Array.isArray(config.tableAreas) ? config.tableAreas : [],
      },
      menu: [...format(menu.items || [], 'food'), ...format(menu.barItems || [], 'bar')],
    });
  } catch (error) {
    res.status(500).json({ error: 'Unable to load Operations configuration.' });
  }
});
app.post('/api/orders/:id/kots', async (req, res) => {
  try {
    await ensureDirectOrdersTable();
    await ensureOperationsConfigTable();
    await ensureKotsTable();
    await ensureKotStationStatusTable();
    await ensureKotRoundStatusTable();
    const [orderRows, configRows, previous] = await Promise.all([
      sql`SELECT id, mode, daily_order_number, customer_name, customer_phone, fulfillment_type, table_area, table_number, special_request, items, created_at FROM direct_orders WHERE id=${req.params.id} LIMIT 1`,
      sql`SELECT config FROM order_operations_config WHERE config_key='default' LIMIT 1`,
      sql`SELECT tickets FROM order_kots WHERE order_id=${req.params.id}`,
    ]);
    if (!orderRows.length) return res.status(404).json({ error: 'Order not found.' });
    if (req.captain) {
      const assignedAreas = Array.isArray(req.captain.areas) ? req.captain.areas : [];
      if (
        orderRows[0].mode !== 'table' ||
        (assignedAreas.length && !assignedAreas.includes(String(orderRows[0].table_area || '')))
      )
        return res
          .status(403)
          .json({ error: 'This order is not assigned to your Captain account.' });
    }
    const config = configRows[0]?.config || { printers: [], routes: [] };
    const printers = Array.isArray(config.printers) ? config.printers : [];
    const routes = Array.isArray(config.routes) ? config.routes : [];
    const kotItemKey = (item) =>
      `${item.category || ''}::${item.name || ''}::${item.portion || ''}::${item.style || ''}::${item.note || ''}`;
    const sent = new Map();
    previous.forEach((kot) => {
      const quantities = new Map();
      (Array.isArray(kot.tickets) ? kot.tickets : []).forEach((ticket) =>
        (Array.isArray(ticket.items) ? ticket.items : []).forEach((item) => {
          const key = kotItemKey(item);
          quantities.set(key, Math.max(quantities.get(key) || 0, Number(item.quantity || 0)));
        })
      );
      quantities.forEach((quantity, key) => sent.set(key, (sent.get(key) || 0) + quantity));
    });
    const pending = (Array.isArray(orderRows[0].items) ? orderRows[0].items : [])
      .map((item) => {
        const key = kotItemKey(item);
        const quantity = Math.max(0, Number(item.quantity || 0) - (sent.get(key) || 0));
        return quantity ? { ...item, quantity } : null;
      })
      .filter(Boolean);
    if (!pending.length) {
      const latest =
        await sql`SELECT COALESCE(daily_kot_number, kot_number) AS kot_number, tickets FROM order_kots WHERE order_id=${orderRows[0].id} ORDER BY created_at DESC, kot_number DESC LIMIT 1`;
      return res
        .status(409)
        .json({
          error: 'No new items to send.',
          latestKot: latest[0] || null,
          order: orderRows[0],
        });
    }
    const groups = new Map();
    for (const item of pending) {
      const matchingRoutes = routes.filter((route) =>
        route.category === '*'
          ? !route.itemName && !route.portion
          : route.category === item.category &&
            ((!route.itemName && !route.portion) ||
              (route.itemName === item.name && (!route.portion || route.portion === item.portion)))
      );
      const printedBy = new Set();
      matchingRoutes.forEach((route) => {
        const printer = printers.find(
          (candidate) =>
            candidate.id === route.printerId && candidate.type === 'kot' && candidate.deviceName
        );
        if (!printer || printedBy.has(printer.id)) return;
        printedBy.add(printer.id);
        if (!groups.has(printer.id))
          groups.set(printer.id, {
            printerId: printer.id,
            printerName: printer.deviceName,
            printerLabel: printer.name,
            items: [],
          });
        groups.get(printer.id).items.push(item);
      });
    }
    if (!groups.size)
      return res
        .status(400)
        .json({ error: 'No routed KOT items have an assigned system printer.' });
    const tickets = [...groups.values()];
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify(pending)).digest('hex');
    const { kotDay, number: dailyKotNumber } = await nextDailyKotNumber();
    const created =
      await sql`INSERT INTO order_kots (order_id, order_number, tickets, item_fingerprint, kot_day, daily_kot_number) VALUES (${orderRows[0].id}, ${orderRows[0].daily_order_number}, ${JSON.stringify(tickets)}, ${fingerprint}, ${kotDay}::date, ${dailyKotNumber}) ON CONFLICT (order_id, item_fingerprint) WHERE item_fingerprint IS NOT NULL DO NOTHING RETURNING daily_kot_number AS kot_number`;
    if (!created.length) {
      const existing =
        await sql`SELECT COALESCE(daily_kot_number, kot_number) AS kot_number, tickets FROM order_kots WHERE order_id=${orderRows[0].id} AND item_fingerprint=${fingerprint} LIMIT 1`;
      return res
        .status(200)
        .json({
          kotNumber: existing[0].kot_number,
          order: orderRows[0],
          tickets: existing[0].tickets,
          reused: true,
        });
    }
    await Promise.all(
      tickets.map((ticket) =>
        Promise.all([
          sql`INSERT INTO order_kot_round_status (order_id,kot_number,printer_id,status) VALUES (${orderRows[0].id},${created[0].kot_number},${ticket.printerId},'accepted') ON CONFLICT (order_id,kot_number,printer_id) DO UPDATE SET status='accepted',updated_at=NOW()`,
          sql`INSERT INTO order_kot_station_status (order_id,printer_id,status) VALUES (${orderRows[0].id},${ticket.printerId},'accepted') ON CONFLICT (order_id,printer_id) DO UPDATE SET status='accepted',updated_at=NOW()`,
        ])
      )
    );
    await recordOrderEvent(orderRows[0].id, 'kot-created', {
      kotNumber: created[0].kot_number,
      printerCount: tickets.length,
      itemCount: pending.reduce((count, item) => count + Number(item.quantity || 0), 0),
    });
    res.status(201).json({ kotNumber: created[0].kot_number, order: orderRows[0], tickets });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Unable to create KOT.' });
  }
});
app.get('/api/orders/:id/kots', async (req, res) => {
  try {
    await ensureKotsTable();
    res.json(
      await sql`SELECT COALESCE(daily_kot_number, kot_number) AS kot_number, tickets, created_at FROM order_kots WHERE order_id=${req.params.id} ORDER BY created_at DESC, kot_number DESC`
    );
  } catch (error) {
    res.status(500).json({ error: 'Unable to load KOT history.' });
  }
});
app.get('/api/orders/kot-history', async (req, res) => {
  try {
    await ensureDirectOrdersTable();
    await ensureKotsTable();
    const day = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || ''))
      ? String(req.query.date)
      : kolkataOrderDay();
    const rows =
      await sql`SELECT o.id,o.daily_order_number,o.mode,o.customer_name,o.customer_phone,o.fulfillment_type,o.status,o.completed_at,COALESCE(k.daily_kot_number,k.kot_number) AS kot_number,k.tickets,k.created_at FROM order_kots k JOIN direct_orders o ON o.id=k.order_id WHERE o.order_day=${day}::date ORDER BY k.created_at DESC,k.kot_number DESC LIMIT 400`;
    res.set('Cache-Control', 'no-store');
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: 'Unable to load KOT history.' });
  }
});
app.get('/api/orders/kitchen-statuses', async (req, res) => {
  try {
    await ensureDirectOrdersTable();
    await ensureKotRoundStatusTable();
    const day = kolkataOrderDay();
    const rows =
      await sql`SELECT DISTINCT ON (s.order_id,s.printer_id) s.order_id,s.kot_number,s.printer_id,s.status,s.updated_at FROM order_kot_round_status s JOIN direct_orders o ON o.id=s.order_id WHERE o.order_day=${day}::date AND o.status IN ('accepted','preparing','ready') ORDER BY s.order_id,s.printer_id,s.kot_number DESC`;
    res.set('Cache-Control', 'no-store');
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: 'Unable to load kitchen display statuses.' });
  }
});
app.patch('/api/orders/:id/table', async (req, res) => {
  try {
    await ensureDirectOrdersTable();
    await ensureOperationsConfigTable();
    const tableArea = String(req.body?.tableArea || '')
        .trim()
        .slice(0, 60),
      tableNumber = Number.parseInt(req.body?.tableNumber, 10);
    if (!tableArea || !Number.isInteger(tableNumber) || tableNumber < 1 || tableNumber > 9999)
      return res.status(400).json({ error: 'Choose a valid destination table.' });
    const today = kolkataOrderDay();
    const [orderRows, configRows] = await Promise.all([
      sql`SELECT id,status,table_area,table_number FROM direct_orders WHERE id=${req.params.id} AND mode='table' AND order_day=${today}::date LIMIT 1`,
      sql`SELECT config FROM order_operations_config WHERE config_key='default' LIMIT 1`,
    ]);
    const order = orderRows[0];
    if (!order) return res.status(404).json({ error: 'Table order not found.' });
    if (!['saved', 'held', 'accepted', 'preparing', 'ready'].includes(order.status))
      return res.status(409).json({ error: 'Only an active table order can be moved.' });
    const areas = Array.isArray(configRows[0]?.config?.tableAreas)
      ? configRows[0].config.tableAreas
      : [];
    if (
      !areas.some(
        (area) =>
          String(area.name || '') === tableArea &&
          tableNumber >= Number(area.from) &&
          tableNumber <= Number(area.to)
      )
    )
      return res
        .status(400)
        .json({ error: 'The destination table is not allocated in Operations.' });
    if (String(order.table_area) === tableArea && Number(order.table_number) === tableNumber)
      return res.json({ ok: true, tableArea, tableNumber, unchanged: true });
    const occupied =
      await sql`SELECT id FROM direct_orders WHERE mode='table' AND table_area=${tableArea} AND table_number=${tableNumber} AND order_day=${today}::date AND status IN ('saved','held','accepted','preparing','ready') AND id<>${req.params.id} LIMIT 1`;
    if (occupied.length)
      return res.status(409).json({ error: 'That destination table already has an active order.' });
    await sql`UPDATE direct_orders SET table_area=${tableArea},table_number=${tableNumber} WHERE id=${req.params.id}`;
    await recordOrderEvent(req.params.id, 'table-moved', {
      fromArea: order.table_area,
      fromNumber: Number(order.table_number),
      toArea: tableArea,
      toNumber: tableNumber,
    });
    res.json({ ok: true, tableArea, tableNumber });
  } catch (error) {
    res.status(500).json({ error: 'Unable to move the table order.' });
  }
});
app.patch('/api/orders/:id/kitchen-status/:printerId', async (req, res) => {
  try {
    await ensureDirectOrdersTable();
    await ensureKotStationStatusTable();
    await ensureKotRoundStatusTable();
    const status = ['accepted', 'preparing', 'ready'].includes(String(req.body?.status || ''))
        ? String(req.body.status)
        : '',
      kotNumber = Number.parseInt(req.body?.kotNumber, 10);
    const printerId = String(req.params.printerId || '')
      .replace(/[^a-zA-Z0-9_-]/g, '')
      .slice(0, 80);
    if (!status || !printerId || !Number.isInteger(kotNumber) || kotNumber < 1)
      return res.status(400).json({ error: 'Choose a valid KOT status update.' });
    const found =
      await sql`SELECT id FROM direct_orders WHERE id=${req.params.id} AND status NOT IN ('completed','rejected','cancelled') LIMIT 1`;
    if (!found.length) return res.status(404).json({ error: 'That active order was not found.' });
    await sql`INSERT INTO order_kot_round_status (order_id,kot_number,printer_id,status) VALUES (${req.params.id},${kotNumber},${printerId},${status}) ON CONFLICT (order_id,kot_number,printer_id) DO UPDATE SET status=EXCLUDED.status,updated_at=NOW()`;
    await sql`INSERT INTO order_kot_station_status (order_id,printer_id,status) VALUES (${req.params.id},${printerId},${status}) ON CONFLICT (order_id,printer_id) DO UPDATE SET status=EXCLUDED.status,updated_at=NOW()`;
    await recordOrderEvent(req.params.id, 'kitchen-status', { printerId, kotNumber, status });
    res.json({ ok: true, status, kotNumber });
  } catch (error) {
    res.status(500).json({ error: 'Unable to update kitchen status.' });
  }
});
app.put('/api/orders/operations/table-areas', async (req, res) => {
  try {
    await ensureOperationsConfigTable();
    const source = req.body || {};
    const tableAreas = (Array.isArray(source.tableAreas) ? source.tableAreas : [])
      .slice(0, 60)
      .map((area) => ({
        id: String(area.id || crypto.randomUUID())
          .replace(/[^a-zA-Z0-9_-]/g, '')
          .slice(0, 60),
        name: String(area.name || '')
          .trim()
          .slice(0, 60),
        from: Number.parseInt(area.from, 10),
        to: Number.parseInt(area.to, 10),
      }))
      .filter(
        (area) =>
          area.id &&
          area.name &&
          Number.isInteger(area.from) &&
          Number.isInteger(area.to) &&
          area.from > 0 &&
          area.to >= area.from &&
          area.to <= 9999
      );
    const rows =
      await sql`SELECT config FROM order_operations_config WHERE config_key='default' LIMIT 1`;
    const existing =
      rows[0]?.config && typeof rows[0].config === 'object'
        ? rows[0].config
        : { printers: [], routes: [] };
    const config = { ...existing, tableAreas };
    await sql`INSERT INTO order_operations_config (config_key, config, updated_at) VALUES ('default', ${JSON.stringify(config)}, NOW()) ON CONFLICT (config_key) DO UPDATE SET config=EXCLUDED.config, updated_at=NOW()`;
    res.json({ ok: true, tableAreas });
  } catch (error) {
    res.status(500).json({ error: 'Unable to save table allocation.' });
  }
});
app.put('/api/orders/operations', async (req, res) => {
  try {
    await ensureOperationsConfigTable();
    const source = req.body?.config || {};
    const printers = (Array.isArray(source.printers) ? source.printers : [])
      .slice(0, 250)
      .map((printer) => {
        const port = Number.parseInt(printer.port, 10),
          layout = (value, min, max, fallback) =>
            Math.max(min, Math.min(max, Number(value) || fallback));
        return {
          id: String(printer.id || crypto.randomUUID())
            .replace(/[^a-zA-Z0-9_-]/g, '')
            .slice(0, 60),
          name: String(printer.name || '')
            .trim()
            .slice(0, 60),
          restaurantName: String(printer.restaurantName || 'Red Lantern Restaurant')
            .trim()
            .slice(0, 60),
          type: printer.type === 'bill' ? 'bill' : 'kot',
          connection: 'system',
          host: String(printer.host || '')
            .trim()
            .slice(0, 253),
          port: Number.isInteger(port) && port > 0 && port <= 65535 ? port : 9100,
          deviceId: String(printer.deviceId || '')
            .trim()
            .slice(0, 160),
          deviceName: String(printer.deviceName || '')
            .trim()
            .slice(0, 120),
          paperWidth: Number(printer.paperWidth) === 58 ? 58 : 80,
          receiptHeader: String(printer.receiptHeader || '')
            .trim()
            .slice(0, 160),
          receiptFooter: String(printer.receiptFooter || '')
            .trim()
            .slice(0, 160),
          showRestaurantName: printer.showRestaurantName !== false,
          showItemSerial: !!printer.showItemSerial,
          showCustomer: printer.showCustomer !== false,
          kotDetailsCentered: !!printer.kotDetailsCentered,
          quantityFirst: printer.quantityFirst !== false,
          showNotes: printer.showNotes !== false,
          extraSpace: Math.max(0, Math.min(2, Number(printer.extraSpace) || 0)),
          fontFamily: [
            'Arial',
            'Calibri',
            'Verdana',
            'Tahoma',
            'Trebuchet MS',
            'Georgia',
            'Times New Roman',
            'Courier New',
            'Consolas',
            'Lucida Console',
          ].includes(String(printer.fontFamily))
            ? String(printer.fontFamily)
            : 'Arial',
          fontSize: Math.max(8, Math.min(13, Number(printer.fontSize) || 10)),
          headerFontSize: Math.max(12, Math.min(18, Number(printer.headerFontSize) || 15)),
          headerBold: printer.headerBold !== false,
          footerBold: !!printer.footerBold,
          billingMainWidth: layout(printer.billingMainWidth, 160, 400, 280),
          billingOuterTop: layout(printer.billingOuterTop, 0, 40, 0),
          billingOuterRight: layout(printer.billingOuterRight, 0, 40, 0),
          billingOuterBottom: layout(printer.billingOuterBottom, 0, 40, 0),
          billingOuterLeft: layout(printer.billingOuterLeft, 0, 40, 0),
          billingItemBoxHeight: layout(printer.billingItemBoxHeight, 0, 40, 0),
          restaurantNameFontSize: layout(printer.restaurantNameFontSize, 8, 24, 14),
          headerFooterFontSize: layout(printer.headerFooterFontSize, 8, 20, 13),
          dateBillFontSize: layout(printer.dateBillFontSize, 8, 20, 13),
          itemListingFontSize: layout(printer.itemListingFontSize, 8, 20, 13),
          grandTotalFontSize: layout(printer.grandTotalFontSize, 10, 26, 14),
          serialColumnWidth: layout(printer.serialColumnWidth, 0, 40, 10),
          quantityColumnWidth: layout(printer.quantityColumnWidth, 8, 60, 20),
          priceColumnWidth: layout(printer.priceColumnWidth, 15, 100, 40),
          amountColumnWidth: layout(printer.amountColumnWidth, 15, 120, 55),
          itemRowGap: layout(printer.itemRowGap, 0, 20, 5),
          separatorGap: layout(printer.separatorGap, 0, 20, 5),
          separatorThickness: layout(printer.separatorThickness, 1, 4, 1),
          kotHeaderFontSize: layout(printer.kotHeaderFontSize, 8, 24, 12),
          kotTitleFontSize: layout(printer.kotTitleFontSize, 10, 26, 15),
          kotMetaFontSize: layout(printer.kotMetaFontSize, 8, 20, 10),
          kotItemFontSize: layout(printer.kotItemFontSize, 8, 22, 12),
          kotFooterFontSize: layout(printer.kotFooterFontSize, 8, 20, 10),
          kotBottomFeedLines: layout(printer.kotBottomFeedLines, 0, 12, 3),
          itemsPerPage: layout(printer.itemsPerPage, 0, 80, 0),
        };
      })
      .filter((printer) => printer.id && printer.name);
    if (new Set(printers.map((printer) => printer.id)).size !== printers.length)
      return res
        .status(400)
        .json({ error: 'Each configured printer must have a unique saved ID.' });
    const printerIds = new Set(printers.map((printer) => printer.id));
    const menu = await getSection('airMenu');
    const allItems = [...(menu.items || []), ...(menu.barItems || [])].map((item) => ({
      name: String(item.name || ''),
      category: String(item.category || ''),
      portions: [
        item.withBonePrice ? 'With Bone' : '',
        item.bonelessPrice ? 'Boneless' : '',
      ].filter(Boolean),
    }));
    const categories = new Set(allItems.map((item) => item.category));
    const validItem = (category, name, portion = '') =>
      allItems.some(
        (item) =>
          item.category === category &&
          item.name === name &&
          (!portion || item.portions.includes(portion))
      );
    const routes = (Array.isArray(source.routes) ? source.routes : [])
      .slice(0, 2000)
      .map((route) => ({
        id: String(route.id || crypto.randomUUID())
          .replace(/[^a-zA-Z0-9_-]/g, '')
          .slice(0, 60),
        printerId: String(route.printerId || ''),
        category: String(route.category || ''),
        itemName: String(route.itemName || ''),
        portion: String(route.portion || '')
          .trim()
          .slice(0, 40),
      }))
      .filter(
        (route) =>
          route.id &&
          printerIds.has(route.printerId) &&
          (route.category === '*'
            ? !route.itemName && !route.portion
            : categories.has(route.category) &&
              (!route.itemName
                ? !route.portion
                : validItem(route.category, route.itemName, route.portion)))
      );
    if (new Set(routes.map((route) => route.id)).size !== routes.length)
      return res.status(400).json({ error: 'Each routing rule must have a unique saved ID.' });
    const assignedTargets = new Set();
    for (const route of routes) {
      const target = `${route.category}::${route.itemName || '*'}::${route.portion || '*'}`;
      if (assignedTargets.has(target))
        return res
          .status(400)
          .json({
            error: `${route.itemName || route.category}${route.portion ? ` (${route.portion})` : ''} is already routed to another printer. Remove its existing route first.`,
          });
      assignedTargets.add(target);
    }
    const tableAreas = (Array.isArray(source.tableAreas) ? source.tableAreas : [])
      .slice(0, 60)
      .map((area) => ({
        id: String(area.id || crypto.randomUUID())
          .replace(/[^a-zA-Z0-9_-]/g, '')
          .slice(0, 60),
        name: String(area.name || '')
          .trim()
          .slice(0, 60),
        from: Number.parseInt(area.from, 10),
        to: Number.parseInt(area.to, 10),
      }))
      .filter(
        (area) =>
          area.id &&
          area.name &&
          Number.isInteger(area.from) &&
          Number.isInteger(area.to) &&
          area.from > 0 &&
          area.to >= area.from &&
          area.to <= 9999
      );
    const config = { printers, routes, tableAreas };
    await sql`INSERT INTO order_operations_config (config_key, config, updated_at) VALUES ('default', ${JSON.stringify(config)}, NOW()) ON CONFLICT (config_key) DO UPDATE SET config=EXCLUDED.config, updated_at=NOW()`;
    res.json({ ok: true, config });
  } catch (error) {
    res.status(500).json({ error: 'Unable to save Operations configuration.' });
  }
});
app.put('/api/orders/availability/:key', async (req, res) => {
  try {
    await ensureMenuAvailabilityTable();
    const until = new Date(req.body.unavailableUntil);
    if (Number.isNaN(+until) || until <= new Date())
      return res.status(400).json({ error: 'Choose a future restock time.' });
    const menu = await getSection('airMenu');
    const menuKeys = new Set(
      [...(menu.items || []), ...(menu.barItems || [])].map(
        (item) =>
          `${String(item.category || '').toLowerCase()}::${String(item.name || '').toLowerCase()}`
      )
    );
    if (!menuKeys.has(req.params.key))
      return res.status(404).json({ error: 'That menu item no longer exists.' });
    await sql`INSERT INTO menu_availability (item_key,unavailable_until) VALUES (${req.params.key},${until.toISOString()}) ON CONFLICT (item_key) DO UPDATE SET unavailable_until=EXCLUDED.unavailable_until`;
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.delete('/api/orders/availability/:key', async (req, res) => {
  try {
    await ensureMenuAvailabilityTable();
    await sql`DELETE FROM menu_availability WHERE item_key=${req.params.key}`;
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/air-menu/export', async (req, res) => {
  try {
    const workbook = await createAirMenuExport(await getSection('airMenu'));
    const fileDate = new Date().toISOString().slice(0, 10);
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="red-lantern-air-menu-${fileDate}.xlsx"`,
      'Cache-Control': 'no-store',
    });
    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    logDiagnostic({
      level: 'error',
      category: 'cms-save',
      message: `Air Menu export failed: ${error.message}`,
      method: req.method,
      path: req.path,
      statusCode: 500,
      ipHash: hashIp(req),
      userAgent: req.headers['user-agent'] || '',
    });
    res.status(500).json({ error: 'Unable to export the Air Menu workbook.' });
  }
});

app.post('/api/admin/air-menu/extract', menuFileUpload.single('menuFile'), async (req, res) => {
  try {
    if (!req.file)
      return res.status(400).json({ error: 'Choose a menu PDF, CSV, or XLSX file first.' });
    const extension = path.extname(req.file.originalname).toLowerCase();
    const extraction =
      extension === '.csv'
        ? extractAirMenuFromCsv(req.file)
        : extension === '.xlsx'
          ? await extractAirMenuFromXlsx(req.file)
          : await extractAirMenuFromPdf(req.file);
    const separatedItems = extraction.items.filter((item) => !isAlcoholMenuItem(item));
    const skippedBarItems = extraction.items.length - separatedItems.length;
    res.set('Cache-Control', 'no-store');
    res.json({
      fileName: req.file.originalname,
      itemCount: separatedItems.length,
      items: separatedItems,
      skippedBarItems,
      extractionMethod: extraction.extractionMethod,
      pageCount: extraction.pageCount,
      warning: separatedItems.length
        ? skippedBarItems
          ? `${skippedBarItems} bar item${skippedBarItems === 1 ? ' was' : 's were'} skipped. Import those through the separate Bar Menu section.`
          : ''
        : extension === '.csv'
          ? 'No menu rows were found. Check that the CSV contains item/name and price columns.'
          : 'OCR found text, but no item/price pairs were recognised. Add items manually or try a clearer PDF.',
    });
  } catch (error) {
    logDiagnostic({
      level: 'error',
      category: 'cms-save',
      message: `Air Menu PDF extraction failed: ${error.message}`,
      method: req.method,
      path: req.path,
      statusCode: error.statusCode || 500,
      ipHash: hashIp(req),
      userAgent: req.headers['user-agent'] || '',
    });
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

app.post('/api/admin/air-menu/extract-bar', menuFileUpload.single('menuFile'), async (req, res) => {
  try {
    if (!req.file)
      return res.status(400).json({ error: 'Choose a Bar Menu PDF, CSV, or XLSX file first.' });
    const extraction = await extractBarMenu(req.file);
    res.set('Cache-Control', 'no-store');
    res.json({
      fileName: req.file.originalname,
      itemCount: extraction.items.length,
      items: extraction.items,
      extractionMethod: extraction.extractionMethod,
      pageCount: extraction.pageCount || 0,
      warning: extraction.items.length
        ? ''
        : 'No bar-menu rows were recognised. Check the file headings or try a clearer PDF.',
    });
  } catch (error) {
    logDiagnostic({
      level: 'error',
      category: 'cms-save',
      message: `Bar Menu extraction failed: ${error.message}`,
      method: req.method,
      path: req.path,
      statusCode: error.statusCode || 500,
      ipHash: hashIp(req),
      userAgent: req.headers['user-agent'] || '',
    });
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

app.post('/api/admin/air-menu/dietary', async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    const category = String(req.body.category || '').trim();
    const dietary =
      req.body.dietary === 'nonveg' ? 'nonveg' : req.body.dietary === 'veg' ? 'veg' : '';
    if (!name) return res.status(400).json({ error: 'Item name is required.' });
    const menu = await getSection('airMenu');
    let updated = false;
    const targetKey = menuItemKey({ name, category });
    menu.items = (menu.items || []).map((item) => {
      if (menuItemKey(item) !== targetKey) return item;
      updated = true;
      return { ...item, dietary };
    });
    if (!updated)
      return res
        .status(404)
        .json({ error: 'Publish the Air Menu once before using instant dietary updates.' });
    await saveSection('airMenu', menu);
    clearPublicContentCache();
    res.json({ saved: true, dietary });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/admin/air-menu/gravy-style', async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    const category = String(req.body.category || '').trim();
    const gravyStyleAvailable = req.body.gravyStyleAvailable === true;
    if (!name) return res.status(400).json({ error: 'Item name is required.' });
    const menu = await getSection('airMenu');
    let updated = false;
    const targetKey = menuItemKey({ name, category });
    menu.items = (menu.items || []).map((item) => {
      if (menuItemKey(item) !== targetKey) return item;
      updated = true;
      return { ...item, gravyStyleAvailable };
    });
    if (!updated)
      return res
        .status(404)
        .json({ error: 'Publish the Air Menu once before changing this setting.' });
    await saveSection('airMenu', menu);
    clearPublicContentCache();
    res.json({ saved: true, gravyStyleAvailable });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.patch('/api/admin/air-menu/proximity-lock', async (req, res) => {
  try {
    const menu = await getSection('airMenu');
    const locked = req.body?.locked === true;
    const proximity = { ...(menu.proximity || {}), locked };
    if (locked && (!Number.isFinite(Number(proximity.latitude)) || !Number.isFinite(Number(proximity.longitude))))
      return res.status(400).json({ error: 'Save a valid restaurant latitude and longitude before locking them.' });
    await saveSection('airMenu', { proximity });
    clearPublicContentCache();
    res.json({ ok: true, locked });
  } catch (error) {
    res.status(500).json({ error: 'Unable to save the coordinate lock.' });
  }
});

app.get('/api/admin/qr/:mode', async (req, res) => {
  const mode = req.params.mode;
  if (!['table', 'card'].includes(mode)) return res.status(404).end();
  try {
    const permanentQrBaseUrl = String(
      process.env.AIR_MENU_QR_BASE_URL || 'https://www.redlanternrestaurant.in'
    ).replace(/\/$/, '');
    const tableQr =
      mode === 'table' && (req.query.area || req.query.table)
        ? await resolveTableQr(req.query.area, req.query.table)
        : null;
    if (mode === 'table' && (req.query.area || req.query.table) && !tableQr)
      return res.status(404).send('Table QR code not found.');
    const target = `${permanentQrBaseUrl}/scan/${mode}${tableQr ? `?area=${encodeURIComponent(tableQr.id)}&table=${tableQr.number}` : ''}`;
    const qrSvg = await QRCode.toString(target, {
      type: 'svg',
      errorCorrectionLevel: 'H',
      margin: 2,
      color: { dark: '#17120f', light: '#ffffff' },
      width: 720,
    });
    const centerLabel = [
      '<g aria-label="Scan for Menu">',
      '<rect x="17.25" y="17.25" width="10.5" height="10.5" rx="1.2" fill="#ffffff" stroke="#dc2626" stroke-width="0.45"/>',
      '<text x="22.5" y="20.8" text-anchor="middle" fill="#111827" font-family="Arial, Helvetica, sans-serif" font-size="2.15" font-weight="800" letter-spacing="0.12">SCAN</text>',
      '<text x="22.5" y="23.1" text-anchor="middle" fill="#dc2626" font-family="Arial, Helvetica, sans-serif" font-size="1.35" font-weight="800" letter-spacing="0.08">FOR</text>',
      `<text x="22.5" y="25.85" text-anchor="middle" fill="#111827" font-family="Arial, Helvetica, sans-serif" font-size="${tableQr ? '1.4' : '2.15'}" font-weight="800" letter-spacing="0.08">${tableQr ? `${String(tableQr.name).slice(0, 10).toUpperCase()} ${tableQr.number}` : 'MENU'}</text>`,
      '</g>',
    ].join('');
    const svg = qrSvg.replace('</svg>', `${centerLabel}</svg>`);
    res.set({
      'Content-Type': 'image/svg+xml; charset=utf-8',
      'Content-Disposition': `inline; filename="red-lantern-${mode}-menu-qr.svg"`,
      'Cache-Control': 'no-store',
    });
    res.send(svg);
  } catch (error) {
    res.status(500).send('Unable to generate QR code.');
  }
});

app.get('/api/admin/table-qr-codes', async (req, res) => {
  try {
    await ensureOperationsConfigTable();
    const [rows, menu] = await Promise.all([
      sql`SELECT config FROM order_operations_config WHERE config_key='default' LIMIT 1`,
      getSection('airMenu'),
    ]);
    const areas = Array.isArray(rows[0]?.config?.tableAreas) ? rows[0].config.tableAreas : [];
    const codes = areas.flatMap((area) =>
      Array.from({ length: Math.max(0, Number(area.to) - Number(area.from) + 1) }, (_, index) => {
        const number = Number(area.from) + index;
        const key = tableQrKey(area.id, number);
        return { areaId: String(area.id), areaName: String(area.name), tableNumber: number, enabled: !menu.tableQrDisabled?.[key] };
      })
    );
    res.set('Cache-Control', 'no-store');
    res.json({ codes });
  } catch (error) {
    res.status(500).json({ error: 'Unable to load table QR codes.' });
  }
});

app.put('/api/admin/table-qr-codes/:areaId/:tableNumber', async (req, res) => {
  try {
    const tableQr = await resolveTableQr(req.params.areaId, req.params.tableNumber);
    if (!tableQr) return res.status(404).json({ error: 'Table QR code not found.' });
    const menu = await getSection('airMenu');
    const disabled = { ...(menu.tableQrDisabled || {}) };
    if (req.body?.enabled === false) disabled[tableQr.key] = true;
    else delete disabled[tableQr.key];
    await saveSection('airMenu', { tableQrDisabled: disabled });
    res.json({ ok: true, enabled: !disabled[tableQr.key] });
  } catch (error) {
    res.status(500).json({ error: 'Unable to update this table QR code.' });
  }
});

cleanPageRoutes.forEach((file, route) => {
  app.get(route, (req, res) => {
    if (route === '/orders' || route === '/captain')
      res.set('Cache-Control', 'no-store, max-age=0');
    res.sendFile(path.join(__dirname, file));
  });
});

function escapeHtmlAttribute(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function injectBlogMeta(html, post = {}, global = {}) {
  const title = escapeHtmlAttribute(post.seoTitle || post.title || 'Red Lantern Journal');
  const description = escapeHtmlAttribute(
    post.seoDescription ||
      post.excerpt ||
      global.seoDescription ||
      'Read food guides and restaurant stories from Red Lantern Restaurant in Colva, Goa.'
  );
  const image = escapeHtmlAttribute(
    post.image || global.ogImage || '/images/red-lantern-logo-600.webp'
  );

  return html
    .replace(/<title>[\s\S]*?<\/title>/i, `<title>${title}</title>`)
    .replace(
      /<meta name="description" content="[^"]*"\s*\/?>/i,
      `<meta name="description" content="${description}" />`
    )
    .replace(
      '</head>',
      `    <meta property="og:title" content="${title}" />\n    <meta property="og:description" content="${description}" />\n    <meta property="og:image" content="${image}" />\n    <meta name="twitter:title" content="${title}" />\n    <meta name="twitter:description" content="${description}" />\n    <meta name="twitter:image" content="${image}" />\n  </head>`
    );
}

app.get('/blog/:slug', async (req, res) => {
  try {
    const [blogs, global] = await Promise.all([getSection('blogs'), getSection('global')]);
    const post = publishedPosts(blogs.posts || []).find((item) => item.slug === req.params.slug);
    if (!post) return res.sendFile(path.join(__dirname, 'blog-post.html'));

    const html = fs.readFileSync(path.join(__dirname, 'blog-post.html'), 'utf8');
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(injectBlogMeta(html, post, global));
  } catch (error) {
    console.error('Blog meta render error:', error);
    res.sendFile(path.join(__dirname, 'blog-post.html'));
  }
});

app.get('/api/content', async (req, res) => {
  try {
    res.set('Cache-Control', 'public, max-age=60, s-maxage=300, stale-while-revalidate=600');
    res.json(await getCachedPublicContent());
  } catch (error) {
    console.error('Neon error:', error);
    logDiagnostic({
      level: 'error',
      category: 'server',
      message: `Public content API failed: ${error.message}`,
      method: req.method,
      path: req.path,
      statusCode: 500,
      ipHash: hashIp(req),
      userAgent: req.headers['user-agent'] || '',
      details: { stack: error.stack },
    });
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/admin/trusted-contacts', async (req, res) => {
  try {
    await Promise.all([ensureTrustedContactsTable(), ensureDirectOrdersTable()]);
    const search = String(req.query.search || '').trim().slice(0, 80);
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(20, Number.parseInt(req.query.limit, 10) || 50));
    const offset = (page - 1) * limit;
    const like = `%${search}%`;
    const select = `SELECT c.customer_phone,c.customer_name,c.blocked,c.created_at,c.updated_at,last_order.items AS last_items,last_order.total AS last_total,last_order.created_at AS last_order_at,last_order.status AS last_order_status FROM trusted_contacts c LEFT JOIN LATERAL (SELECT items,total,created_at,status FROM direct_orders WHERE customer_phone=c.customer_phone AND status NOT IN ('cancelled','rejected') ORDER BY created_at DESC LIMIT 1) last_order ON TRUE`;
    const contacts = search
      ? await sql(`${select} WHERE c.customer_phone LIKE $1 OR c.customer_name ILIKE $1 ORDER BY c.blocked,c.customer_name NULLS LAST,c.updated_at DESC LIMIT $2 OFFSET $3`, [like, limit, offset])
      : await sql(`${select} ORDER BY c.blocked,c.customer_name NULLS LAST,c.updated_at DESC LIMIT $1 OFFSET $2`, [limit, offset]);
    const countRows = search
      ? await sql`SELECT COUNT(*)::int AS count FROM trusted_contacts WHERE customer_phone LIKE ${like} OR customer_name ILIKE ${like}`
      : await sql`SELECT COUNT(*)::int AS count FROM trusted_contacts`;
    res.set('Cache-Control', 'no-store');
    res.json({ contacts, page, limit, total: Number(countRows[0]?.count || 0) });
  } catch (error) {
    res.status(500).json({ error: 'Unable to load verified contacts.' });
  }
});

app.post('/api/admin/trusted-contacts', async (req, res) => {
  try {
    await ensureTrustedContactsTable();
    const rawContacts = Array.isArray(req.body?.contacts) ? req.body.contacts : [req.body || {}];
    const contacts = rawContacts
      .slice(0, 1000)
      .map((contact) => ({
        phone: String(contact.phone || contact.customerPhone || '').replace(/\D/g, ''),
        name: String(contact.name || contact.customerName || '').trim().slice(0, 80),
      }))
      .filter((contact) => contact.phone.length >= 7 && contact.phone.length <= 16);
    if (!contacts.length)
      return res.status(400).json({ error: 'Add at least one valid mobile number.' });
    for (const contact of contacts)
      await sql`INSERT INTO trusted_contacts (customer_phone,customer_name) VALUES (${contact.phone},${contact.name}) ON CONFLICT (customer_phone) DO UPDATE SET customer_name=CASE WHEN EXCLUDED.customer_name='' THEN trusted_contacts.customer_name ELSE EXCLUDED.customer_name END, blocked=FALSE, updated_at=NOW()`;
    res.status(201).json({ ok: true, added: contacts.length });
  } catch (error) {
    res.status(500).json({ error: 'Unable to save verified contacts.' });
  }
});

app.get('/api/admin/trusted-contacts/template', async (req, res) => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Trusted Contacts');
  sheet.columns = [
    { header: 'Name (Optional)', key: 'name', width: 28 },
    { header: 'Mobile Number', key: 'phone', width: 20 },
  ];
  sheet.getRow(1).font = { bold: true };
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FDE68A' } };
  sheet.addRow({ name: 'Example Customer', phone: '9876543210' });
  sheet.getCell('A3').value = 'Leave the name blank if you do not have it.';
  sheet.mergeCells('A3:B3');
  res.set({
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': 'attachment; filename="red-lantern-trusted-contacts-template.xlsx"',
  });
  await workbook.xlsx.write(res);
  res.end();
});

app.post('/api/admin/trusted-contacts/import', trustedContactUpload.single('contactsFile'), async (req, res) => {
  try {
    if (!req.file?.buffer) return res.status(400).json({ error: 'Choose an Excel contacts file first.' });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(req.file.buffer);
    const sheet = workbook.worksheets[0];
    if (!sheet) return res.status(400).json({ error: 'The Excel file has no worksheet.' });
    const headers = {};
    sheet.getRow(1).eachCell((cell, column) => {
      headers[String(cell.text || '').trim().toLowerCase().replace(/[^a-z]/g, '')] = column;
    });
    const phoneColumn = headers.mobilenumber || headers.mobile || headers.phone || headers.phonenumber;
    const nameColumn = headers.name || headers.customername;
    if (!phoneColumn)
      return res.status(400).json({ error: 'Use a “Mobile Number” column in the first row.' });
    const contacts = [];
    sheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1 || contacts.length >= 1000) return;
      const phone = String(row.getCell(phoneColumn).text || '').replace(/\D/g, '');
      if (phone.length >= 7 && phone.length <= 16)
        contacts.push({
          phone,
          name: nameColumn ? String(row.getCell(nameColumn).text || '').trim().slice(0, 80) : '',
        });
    });
    if (!contacts.length)
      return res.status(400).json({ error: 'No valid mobile numbers were found in the file.' });
    await ensureTrustedContactsTable();
    for (const contact of contacts)
      await sql`INSERT INTO trusted_contacts (customer_phone,customer_name) VALUES (${contact.phone},${contact.name}) ON CONFLICT (customer_phone) DO UPDATE SET customer_name=CASE WHEN EXCLUDED.customer_name='' THEN trusted_contacts.customer_name ELSE EXCLUDED.customer_name END, blocked=FALSE, updated_at=NOW()`;
    res.status(201).json({ ok: true, added: contacts.length });
  } catch (error) {
    res.status(400).json({ error: error.message || 'Unable to import this contacts file.' });
  }
});

app.patch('/api/admin/trusted-contacts/:phone', async (req, res) => {
  try {
    await ensureTrustedContactsTable();
    const phone = String(req.params.phone || '').replace(/\D/g, '');
    if (phone.length < 7 || phone.length > 16)
      return res.status(400).json({ error: 'Invalid mobile number.' });
    const name = String(req.body?.name || '').trim().slice(0, 80);
    const blocked = req.body?.blocked === true;
    const saved = await sql`UPDATE trusted_contacts SET customer_name=${name},blocked=${blocked},updated_at=NOW() WHERE customer_phone=${phone} RETURNING customer_phone`;
    if (!saved.length) return res.status(404).json({ error: 'Contact not found.' });
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: 'Unable to update this contact.' });
  }
});

app.get('/api/admin/customer-insights', async (req, res) => {
  try {
    await ensureDirectOrdersTable();
    await ensureLoyaltyTable();
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || ''))
      ? String(req.query.date)
      : '';
    const search = String(req.query.search || '')
      .trim()
      .slice(0, 80);
    const digits = search.replace(/\D/g, '');
    const like = `%${search}%`;
    const digitLike = `%${digits}%`;
    let orders;
    if (date && search)
      orders =
        await sql`SELECT o.*, COALESCE(l.points,0) AS loyalty_points FROM direct_orders o LEFT JOIN loyalty_accounts l ON l.customer_phone=o.customer_phone WHERE o.order_day=${date}::date AND (o.customer_name ILIKE ${like} OR o.customer_phone LIKE ${digitLike} OR CAST(o.daily_order_number AS TEXT) LIKE ${digitLike}) ORDER BY o.created_at DESC LIMIT 200`;
    else if (date)
      orders =
        await sql`SELECT o.*, COALESCE(l.points,0) AS loyalty_points FROM direct_orders o LEFT JOIN loyalty_accounts l ON l.customer_phone=o.customer_phone WHERE o.order_day=${date}::date ORDER BY o.created_at DESC LIMIT 200`;
    else if (search)
      orders =
        await sql`SELECT o.*, COALESCE(l.points,0) AS loyalty_points FROM direct_orders o LEFT JOIN loyalty_accounts l ON l.customer_phone=o.customer_phone WHERE o.customer_name ILIKE ${like} OR o.customer_phone LIKE ${digitLike} OR CAST(o.daily_order_number AS TEXT) LIKE ${digitLike} ORDER BY o.created_at DESC LIMIT 200`;
    else
      orders =
        await sql`SELECT o.*, COALESCE(l.points,0) AS loyalty_points FROM direct_orders o LEFT JOIN loyalty_accounts l ON l.customer_phone=o.customer_phone ORDER BY o.created_at DESC LIMIT 200`;
    const leaderboard =
      await sql`SELECT customer_phone, points, total_earned, total_redeemed FROM loyalty_accounts ORDER BY points DESC, total_earned DESC LIMIT 12`;
    const total = orders.reduce((sum, row) => sum + Number(row.total || 0), 0);
    res.set('Cache-Control', 'no-store');
    res.json({
      orders,
      leaderboard,
      summary: {
        orders: orders.length,
        total,
        points: leaderboard.reduce((sum, row) => sum + Number(row.points || 0), 0),
        credit: 0,
      },
    });
  } catch (error) {
    console.error('Customer insights error:', error);
    res.status(500).json({ error: 'Unable to load customer insights.' });
  }
});

app.get('/api/admin/content', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    res.json(await getAllContent(true, true));
  } catch (error) {
    console.error('Neon error:', error);
    logDiagnostic({
      level: 'error',
      category: 'server',
      message: `Admin content API failed: ${error.message}`,
      method: req.method,
      path: req.path,
      statusCode: 500,
      ipHash: hashIp(req),
      userAgent: req.headers['user-agent'] || '',
      details: { stack: error.stack },
    });
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/admin/captains', async (req, res) => {
  try {
    await ensureOperationsConfigTable();
    const [config, rows] = await Promise.all([
      getSection('captain'),
      sql`SELECT config FROM order_operations_config WHERE config_key='default' LIMIT 1`,
    ]);
    const areas = Array.isArray(rows[0]?.config?.tableAreas)
        ? rows[0].config.tableAreas.map((area) => String(area.name || '').trim()).filter(Boolean)
        : [],
      idleMinutes = Math.max(2, Math.min(120, Number(config.settings?.idleMinutes) || 15));
    res.json({
      captains: (Array.isArray(config.captains) ? config.captains : []).map(
        ({ pinHash, ...captain }) => ({ ...captain, pinConfigured: !!pinHash })
      ),
      areas,
      settings: { idleMinutes },
    });
  } catch (error) {
    res.status(500).json({ error: 'Unable to load Captain accounts.' });
  }
});
app.get('/api/admin/captains/activity', async (req, res) => {
  try {
    await Promise.all([
      ensureDirectOrdersTable(),
      ensureOrderEventsTable(),
      ensureOperationsConfigTable(),
    ]);
    const day = kolkataOrderDay(),
      [events, config, operations] = await Promise.all([
        sql`SELECT e.event_id,e.event_type,e.created_at AS event_at,e.details,o.id AS order_id,o.daily_order_number,o.table_area,o.table_number,o.status,o.items,o.total,o.service_state,o.service_requested_at FROM order_events e JOIN direct_orders o ON o.id=e.order_id WHERE o.order_day=${day}::date AND e.event_type IN ('created','captain-items-added','table-service-request','kot-served') AND COALESCE(e.details->>'captainId','')<>'' ORDER BY e.created_at DESC LIMIT 500`,
        getSection('captain'),
        sql`SELECT config FROM order_operations_config WHERE config_key='default' LIMIT 1`,
      ]);
    const captains = (Array.isArray(config.captains) ? config.captains : [])
        .map((captain) => ({
          id: String(captain.id || ''),
          name: String(captain.name || ''),
          active: captain.active !== false,
        }))
        .filter((captain) => captain.id && captain.name),
      areas = (
        Array.isArray(operations[0]?.config?.tableAreas) ? operations[0].config.tableAreas : []
      )
        .map((area) => String(area.name || '').trim())
        .filter(Boolean);
    res.set('Cache-Control', 'no-store');
    res.json({ day, events, captains, areas });
  } catch (error) {
    res.status(500).json({ error: 'Unable to load Captain activity.' });
  }
});
app.put('/api/admin/captains', async (req, res) => {
  try {
    await ensureOperationsConfigTable();
    const [existing, rows] = await Promise.all([
      getSection('captain'),
      sql`SELECT config FROM order_operations_config WHERE config_key='default' LIMIT 1`,
    ]);
    const availableAreas = new Set(
        (Array.isArray(rows[0]?.config?.tableAreas) ? rows[0].config.tableAreas : [])
          .map((area) => String(area.name || '').trim())
          .filter(Boolean)
      ),
      idleMinutes = Math.max(2, Math.min(120, Number(req.body?.settings?.idleMinutes) || 15));
    const old = new Map(
      (Array.isArray(existing.captains) ? existing.captains : []).map((captain) => [
        captain.id,
        captain,
      ])
    );
    const submitted = Array.isArray(req.body?.captains) ? req.body.captains : [];
    if (submitted.length > 50) return res.status(400).json({ error: 'Too many Captain accounts.' });
    const captains = submitted.map((entry) => {
      const id = String(entry.id || crypto.randomUUID())
          .replace(/[^a-zA-Z0-9_-]/g, '')
          .slice(0, 64),
        name = String(entry.name || '')
          .trim()
          .slice(0, 60),
        areas = [
          ...new Set(
            (Array.isArray(entry.areas) ? entry.areas : [])
              .map((area) => String(area).trim().slice(0, 60))
              .filter(Boolean)
          ),
        ],
        pin = String(entry.pin || '');
      if (areas.some((area) => !availableAreas.has(area)))
        throw new Error('Choose assigned areas from the current table setup.');
      if (!id || !name) throw new Error('Every Captain needs a name.');
      if (pin && !/^\d{4,6}$/.test(pin)) throw new Error('PINs must contain 4 to 6 digits.');
      const previous = old.get(id);
      if (!previous?.pinHash && !pin) throw new Error(`Set a PIN for ${name}.`);
      const pinHash = pin
        ? crypto.scryptSync(pin, `captain:${id}`, 64).toString('hex')
        : previous.pinHash;
      return { id, name, areas, active: entry.active !== false, pinHash };
    });
    await saveSection('captain', { captains, settings: { idleMinutes } });
    res.json({
      captains: captains.map(({ pinHash, ...captain }) => ({
        ...captain,
        pinConfigured: !!pinHash,
      })),
      settings: { idleMinutes },
    });
  } catch (error) {
    res.status(400).json({ error: error.message || 'Unable to save Captain accounts.' });
  }
});
const captainSessionSecret =
  process.env.CAPTAIN_SESSION_SECRET ||
  process.env.ADMIN_PASSWORD ||
  crypto.randomBytes(32).toString('hex');
const captainSession = (captain) => {
  const payload = Buffer.from(
    JSON.stringify({
      id: captain.id,
      name: captain.name,
      areas: captain.areas || [],
      exp: Date.now() + 12 * 60 * 60 * 1000,
    })
  ).toString('base64url');
  return `${payload}.${crypto.createHmac('sha256', captainSessionSecret).update(payload).digest('base64url')}`;
};
const readCaptainSession = (token) => {
  try {
    const [payload, signature] = String(token || '').split('.'),
      expected = crypto
        .createHmac('sha256', captainSessionSecret)
        .update(payload || '')
        .digest('base64url');
    if (
      !payload ||
      !signature ||
      signature.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
    )
      return null;
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return data.exp > Date.now() && data.id && data.name ? data : null;
  } catch {
    return null;
  }
};
const getActiveCaptainSession = async (token) => {
  const session = readCaptainSession(token);
  if (!session) return null;
  try {
    const config = await getSection('captain'),
      captain = (config.captains || []).find(
        (entry) => entry.id === session.id && entry.active !== false && entry.pinHash
      );
    return captain ? { ...session, name: captain.name, areas: captain.areas || [] } : null;
  } catch {
    return null;
  }
};
app.get('/api/captain/accounts', async (req, res) => {
  try {
    const config = await getSection('captain');
    res.set('Cache-Control', 'no-store');
    res.json({
      captains: (Array.isArray(config.captains) ? config.captains : [])
        .filter((captain) => captain.active !== false && captain.pinHash)
        .map(({ id, name, areas }) => ({ id, name, areas: areas || [] })),
    });
  } catch (error) {
    res.status(500).json({ error: 'Unable to load Captain accounts.' });
  }
});
app.post('/api/captain/login', async (req, res) => {
  if (!allowPublicRequest(req, res, 'captain-login', 8, 5 * 60 * 1000)) return;
  try {
    const config = await getSection('captain'),
      captain = (config.captains || []).find((entry) => entry.id === String(req.body?.id || '')),
      idleMinutes = Math.max(2, Math.min(120, Number(config.settings?.idleMinutes) || 15));
    const pin = String(req.body?.pin || ''),
      stored = captain?.pinHash ? Buffer.from(captain.pinHash, 'hex') : null,
      attempt = captain?.id ? crypto.scryptSync(pin, `captain:${captain.id}`, 64) : null;
    if (
      !captain ||
      !captain.active ||
      !stored ||
      stored.length !== attempt.length ||
      !crypto.timingSafeEqual(stored, attempt)
    )
      return res.status(401).json({ error: 'Incorrect PIN.' });
    res.set('Cache-Control', 'no-store');
    res.json({
      captain: { id: captain.id, name: captain.name, areas: captain.areas || [], idleMinutes },
      token: captainSession(captain),
    });
  } catch (error) {
    res.status(500).json({ error: 'Unable to sign in.' });
  }
});
app.get('/api/captain/menu-insights', async (req, res) => {
  const captain = await getActiveCaptainSession(req.get('X-Captain-Session'));
  if (!captain)
    return res.status(401).json({ error: 'Captain sign-in has expired. Sign in again.' });
  try {
    await ensureDirectOrdersTable();
    const rows =
      await sql`SELECT item->>'name' AS name,item->>'category' AS category,SUM(COALESCE((item->>'quantity')::numeric,0))::integer AS quantity FROM direct_orders o CROSS JOIN LATERAL jsonb_array_elements(COALESCE(o.items,'[]'::jsonb)) item WHERE o.created_at >= NOW()-INTERVAL '30 days' AND o.status NOT IN ('rejected','cancelled') GROUP BY item->>'name',item->>'category' ORDER BY quantity DESC,name ASC LIMIT 12`;
    res.set('Cache-Control', 'no-store');
    res.json({
      periodDays: 30,
      items: rows
        .map((row) => ({
          name: String(row.name || ''),
          category: String(row.category || ''),
          quantity: Number(row.quantity || 0),
        }))
        .filter((row) => row.name && row.quantity > 0),
    });
  } catch (error) {
    res.status(500).json({ error: 'Unable to load menu insights.' });
  }
});
app.get('/api/captain/ready-alerts', async (req, res) => {
  const captain = await getActiveCaptainSession(req.get('X-Captain-Session'));
  if (!captain)
    return res.status(401).json({ error: 'Captain sign-in has expired. Sign in again.' });
  try {
    await Promise.all([
      ensureDirectOrdersTable(),
      ensureOrderEventsTable(),
      ensureKotsTable(),
      ensureKotRoundStatusTable(),
    ]);
    const day = kolkataOrderDay(),
      alerts =
        await sql`SELECT o.id,o.daily_order_number,o.table_area,o.table_number,o.updated_at,latest.kot_number,MAX(s.updated_at) AS ready_at FROM direct_orders o JOIN order_events e ON e.order_id=o.id AND e.event_type='created' AND e.details->>'captainId'=${captain.id} JOIN (SELECT order_id,MAX(COALESCE(daily_kot_number,kot_number)) AS kot_number FROM order_kots GROUP BY order_id) latest ON latest.order_id=o.id JOIN order_kot_round_status s ON s.order_id=o.id AND s.kot_number=latest.kot_number WHERE o.order_day=${day}::date AND o.mode='table' AND o.status IN ('accepted','preparing','ready') GROUP BY o.id,o.daily_order_number,o.table_area,o.table_number,o.updated_at,latest.kot_number HAVING COUNT(*)>0 AND COUNT(*) FILTER (WHERE s.status='ready')=COUNT(*) ORDER BY ready_at DESC LIMIT 20`;
    res.set('Cache-Control', 'no-store');
    res.json({ alerts });
  } catch (error) {
    res.status(500).json({ error: 'Unable to load ready-to-serve alerts.' });
  }
});
app.post('/api/captain/orders/:id/kots/:kotNumber/served', async (req, res) => {
  const captain = await getActiveCaptainSession(req.get('X-Captain-Session')),
    kotNumber = Number.parseInt(req.params.kotNumber, 10);
  if (!captain)
    return res.status(401).json({ error: 'Captain sign-in has expired. Sign in again.' });
  if (!Number.isInteger(kotNumber) || kotNumber < 1)
    return res.status(400).json({ error: 'Invalid KOT round.' });
  try {
    await Promise.all([
      ensureDirectOrdersTable(),
      ensureOrderEventsTable(),
      ensureKotRoundStatusTable(),
    ]);
    const owner =
      await sql`SELECT o.id FROM direct_orders o JOIN order_events e ON e.order_id=o.id AND e.event_type='created' AND e.details->>'captainId'=${captain.id} WHERE o.id=${req.params.id} AND o.mode='table' AND o.status IN ('accepted','preparing','ready') LIMIT 1`;
    if (!owner.length)
      return res
        .status(404)
        .json({ error: 'That active table order is not assigned to this Captain.' });
    const served =
      await sql`UPDATE order_kot_round_status SET status='served',updated_at=NOW() WHERE order_id=${req.params.id} AND kot_number=${kotNumber} AND status='ready' RETURNING printer_id`;
    if (!served.length)
      return res.status(409).json({ error: 'This KOT round is not ready to serve.' });
    await recordOrderEvent(req.params.id, 'kot-served', {
      kotNumber,
      captainId: captain.id,
      captainName: captain.name,
      printerCount: served.length,
    });
    res.json({ ok: true, kotNumber });
  } catch (error) {
    res.status(500).json({ error: 'Unable to mark this KOT round served.' });
  }
});
app.get('/api/captain/orders/:id/kot-progress', async (req, res) => {
  const captain = await getActiveCaptainSession(req.get('X-Captain-Session'));
  if (!captain)
    return res.status(401).json({ error: 'Captain sign-in has expired. Sign in again.' });
  try {
    await Promise.all([
      ensureDirectOrdersTable(),
      ensureOrderEventsTable(),
      ensureKotRoundStatusTable(),
    ]);
    const owner =
      await sql`SELECT o.id FROM direct_orders o JOIN order_events e ON e.order_id=o.id AND e.event_type='created' AND e.details->>'captainId'=${captain.id} WHERE o.id=${req.params.id} AND o.mode='table' AND o.status IN ('accepted','preparing','ready') LIMIT 1`;
    if (!owner.length)
      return res
        .status(404)
        .json({ error: 'That active table order is not assigned to this Captain.' });
    const rounds =
      await sql`SELECT kot_number,COUNT(*)::integer AS stations,COUNT(*) FILTER (WHERE status='preparing')::integer AS preparing,COUNT(*) FILTER (WHERE status='ready')::integer AS ready,COUNT(*) FILTER (WHERE status='served')::integer AS served FROM order_kot_round_status WHERE order_id=${req.params.id} GROUP BY kot_number ORDER BY kot_number DESC LIMIT 8`;
    res.set('Cache-Control', 'no-store');
    res.json({
      rounds: rounds.map((round) => ({
        kotNumber: Number(round.kot_number),
        stations: Number(round.stations || 0),
        preparing: Number(round.preparing || 0),
        ready: Number(round.ready || 0),
        served: Number(round.served || 0),
      })),
    });
  } catch (error) {
    res.status(500).json({ error: 'Unable to load kitchen progress.' });
  }
});
app.post('/api/captain/orders/:id/service', async (req, res) => {
  const captain = await getActiveCaptainSession(req.get('X-Captain-Session')),
    serviceState = ['bill_requested', 'assistance_requested', 'water_requested'].includes(
      String(req.body?.serviceState || '')
    )
      ? String(req.body.serviceState)
      : '';
  if (!captain)
    return res.status(401).json({ error: 'Captain sign-in has expired. Sign in again.' });
  if (!serviceState)
    return res.status(400).json({ error: 'Choose a valid table service request.' });
  try {
    await Promise.all([ensureDirectOrdersTable(), ensureOrderEventsTable()]);
    if (serviceState === 'bill_requested') {
      const menu = await getSection('airMenu');
      const restaurantLatitude = Number(menu.proximity?.latitude);
      const restaurantLongitude = Number(menu.proximity?.longitude);
      const requiredRadius = Math.max(0, Number(menu.proximity?.tableRadius) || 0);
      if (
        !requiredRadius ||
        !Number.isFinite(restaurantLatitude) ||
        !Number.isFinite(restaurantLongitude)
      )
        return res.status(409).json({
          error:
            'Captain bill printing needs the restaurant location and Table proximity radius saved in Air Menu settings.',
        });
      const latitude = Number(req.body?.proximity?.latitude);
      const longitude = Number(req.body?.proximity?.longitude);
      const accuracy = Number(req.body?.proximity?.accuracy);
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude))
        return res.status(403).json({
          error: 'Location permission is required to print a bill from Captain.',
        });
      const tolerance = Math.min(100, Math.max(0, Number.isFinite(accuracy) ? accuracy : 0));
      if (
        distanceInMetres(restaurantLatitude, restaurantLongitude, latitude, longitude) >
        requiredRadius + tolerance
      )
        return res.status(403).json({
          error: `You need to be within ${requiredRadius} m of the restaurant to print a bill.`,
        });
    }
    const owner =
      await sql`SELECT o.id FROM direct_orders o JOIN order_events e ON e.order_id=o.id AND e.event_type='created' AND e.details->>'captainId'=${captain.id} WHERE o.id=${req.params.id} AND o.mode='table' AND o.status IN ('accepted','preparing','ready') LIMIT 1`;
    if (!owner.length)
      return res
        .status(404)
        .json({ error: 'That active table order is not assigned to this Captain.' });
    await sql`UPDATE direct_orders SET service_state=${serviceState},service_requested_at=NOW(),updated_at=NOW() WHERE id=${req.params.id}`;
    await recordOrderEvent(req.params.id, 'table-service-request', {
      serviceState,
      captainId: captain.id,
      captainName: captain.name,
    });
    res.json({ ok: true, serviceState });
  } catch (error) {
    res.status(500).json({ error: 'Unable to send the table service request.' });
  }
});
app.patch('/api/orders/:id/service', async (req, res) => {
  const serviceState = ['active', 'cleaning', 'available'].includes(
    String(req.body?.serviceState || '')
  )
    ? String(req.body.serviceState)
    : '';
  if (!serviceState) return res.status(400).json({ error: 'Choose a valid service state.' });
  try {
    await Promise.all([ensureDirectOrdersTable(), ensureOrderEventsTable()]);
    const updated =
      await sql`UPDATE direct_orders SET service_state=${serviceState},service_requested_at=CASE WHEN ${serviceState}='active' THEN NULL ELSE service_requested_at END,updated_at=NOW() WHERE id=${req.params.id} AND mode='table' AND status NOT IN ('completed','rejected','cancelled') RETURNING id`;
    if (!updated.length)
      return res.status(404).json({ error: 'That active table order was not found.' });
    await recordOrderEvent(req.params.id, 'table-service-updated', { serviceState });
    res.json({ ok: true, serviceState });
  } catch (error) {
    res.status(500).json({ error: 'Unable to update table service.' });
  }
});

app.post('/api/captain/orders/:id/move', async (req, res) => {
  const captain = await getActiveCaptainSession(req.get('X-Captain-Session')),
    tableArea = String(req.body?.tableArea || '')
      .trim()
      .slice(0, 60),
    tableNumber = Number.parseInt(req.body?.tableNumber, 10);
  if (!captain)
    return res.status(401).json({ error: 'Captain sign-in has expired. Sign in again.' });
  if (!tableArea || !Number.isInteger(tableNumber) || tableNumber < 1)
    return res.status(400).json({ error: 'Choose a valid destination table.' });
  try {
    await Promise.all([
      ensureDirectOrdersTable(),
      ensureOrderEventsTable(),
      ensureOperationsConfigTable(),
    ]);
    const owner =
      await sql`SELECT o.table_area,o.table_number FROM direct_orders o JOIN order_events e ON e.order_id=o.id AND e.event_type='created' AND e.details->>'captainId'=${captain.id} WHERE o.id=${req.params.id} AND o.mode='table' AND o.status IN ('saved','held','accepted','preparing','ready') LIMIT 1`;
    if (!owner.length)
      return res
        .status(404)
        .json({ error: 'That active table order is not assigned to this Captain.' });
    const config =
        await sql`SELECT config FROM order_operations_config WHERE config_key='default' LIMIT 1`,
      areas = config[0]?.config?.tableAreas || [];
    if (
      !areas.some(
        (area) =>
          String(area.name) === tableArea &&
          tableNumber >= Number(area.from) &&
          tableNumber <= Number(area.to)
      )
    )
      return res.status(400).json({ error: 'Choose an allocated table.' });
    const occupied =
      await sql`SELECT id FROM direct_orders WHERE mode='table' AND table_area=${tableArea} AND table_number=${tableNumber} AND status IN ('saved','held','accepted','preparing','ready') AND id<>${req.params.id} LIMIT 1`;
    if (occupied.length)
      return res.status(409).json({ error: 'That table already has an active order.' });
    await sql`UPDATE direct_orders SET table_area=${tableArea},table_number=${tableNumber},updated_at=NOW() WHERE id=${req.params.id}`;
    await recordOrderEvent(req.params.id, 'table-moved', {
      fromArea: owner[0].table_area,
      fromNumber: Number(owner[0].table_number),
      toArea: tableArea,
      toNumber: tableNumber,
      captainId: captain.id,
    });
    res.json({ ok: true, tableArea, tableNumber });
  } catch (error) {
    res.status(500).json({ error: 'Unable to move this table.' });
  }
});
app.post('/api/admin/google-reviews/sync', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    const googleReviews = await fetchFiveStarGoogleReviews();
    const home = await getSection('home');
    const existingReviews = Array.isArray(home.reviews) ? home.reviews : [];
    const existingKeys = new Set(
      existingReviews.map(
        (review) =>
          review.googleReviewName ||
          `${cleanDescriptionText(review.name)}:${cleanDescriptionText(review.text).slice(0, 120)}`
      )
    );
    const importedCount = googleReviews.filter(
      (review) =>
        !existingKeys.has(
          review.googleReviewName ||
            `${cleanDescriptionText(review.name)}:${cleanDescriptionText(review.text).slice(0, 120)}`
        )
    ).length;
    const reviews = mergeReviews(existingReviews, googleReviews);

    await saveSection('home', { reviews });
    clearPublicContentCache();
    logDiagnostic({
      level: 'info',
      category: 'cms-save',
      message: `Synced ${importedCount} new 5-star Google reviews.`,
      method: req.method,
      path: req.path,
      statusCode: 200,
      ipHash: hashIp(req),
      userAgent: req.headers['user-agent'] || '',
      details: {
        importedCount,
        totalFiveStar: reviews.length,
      },
    });

    res.json({
      importedCount,
      totalFiveStar: reviews.length,
      reviews,
    });
  } catch (error) {
    console.error('Google reviews sync error:', error);
    logDiagnostic({
      level: 'error',
      category: 'server',
      message: `Google reviews sync failed: ${error.message}`,
      method: req.method,
      path: req.path,
      statusCode: error.statusCode || 500,
      ipHash: hashIp(req),
      userAgent: req.headers['user-agent'] || '',
      details: { stack: error.stack },
    });
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

app.get('/api/admin/qr-scans', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    if (!sql)
      return res
        .status(503)
        .json({ error: 'Neon is not configured, so QR scan logs cannot be stored.' });
    const limit = Math.min(Math.max(Number(req.query.limit || 100), 1), 500);
    await ensureDiagnosticsTable();
    const [rows, summaryRows] = await Promise.all([
      sql`
        SELECT id, created_at, message, ip_hash, details,
               COUNT(*) OVER (PARTITION BY ip_hash)::int AS visitor_scan_count
        FROM website_diagnostics
        WHERE category = 'qr-scan'
        ORDER BY created_at DESC
        LIMIT ${limit}
      `,
      sql`
        SELECT
          COUNT(*)::int AS total_scans,
          COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '24 hours')::int AS scans_24h,
          COUNT(*) FILTER (WHERE details->>'mode' = 'table')::int AS table_scans,
          COUNT(*) FILTER (WHERE details->>'mode' = 'card')::int AS card_scans,
          COUNT(DISTINCT ip_hash) FILTER (WHERE created_at >= NOW() - INTERVAL '24 hours')::int AS unique_24h
        FROM website_diagnostics
        WHERE category = 'qr-scan'
      `,
    ]);
    res.json({ scans: rows, summary: summaryRows[0] || {} });
  } catch (error) {
    console.error('QR scan logs read error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/admin/qr-scans', async (req, res) => {
  try {
    if (!sql)
      return res
        .status(503)
        .json({ error: 'Neon is not configured, so QR scan logs cannot be cleared.' });
    await ensureDiagnosticsTable();
    await sql`DELETE FROM website_diagnostics WHERE category = 'qr-scan'`;
    res.json({ ok: true });
  } catch (error) {
    console.error('QR scan logs clear error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/admin/logs', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    if (!sql)
      return res
        .status(503)
        .json({ error: 'Neon is not configured, so diagnostics logs cannot be stored.' });
    const limit = Math.min(Math.max(Number(req.query.limit || 80), 1), 200);
    await ensureDiagnosticsTable();
    const rows = await sql`
      SELECT id, created_at, level, category, message, solution, location, method, path,
             status_code, duration_ms, ip_hash, user_agent, details
      FROM website_diagnostics
      WHERE category <> 'qr-scan'
      ORDER BY created_at DESC
      LIMIT ${limit}
    `;
    res.json({ logs: rows });
  } catch (error) {
    console.error('Diagnostics read error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/admin/logs', async (req, res) => {
  try {
    if (!sql)
      return res
        .status(503)
        .json({ error: 'Neon is not configured, so diagnostics logs cannot be cleared.' });
    await ensureDiagnosticsTable();
    await sql`DELETE FROM website_diagnostics`;
    await writeDiagnostic({
      level: 'info',
      category: 'admin',
      message: 'Diagnostics log was cleared from the admin dashboard.',
      method: req.method,
      path: req.path,
      ipHash: hashIp(req),
      userAgent: req.headers['user-agent'] || '',
    });
    res.json({ ok: true });
  } catch (error) {
    console.error('Diagnostics clear error:', error);
    res.status(500).json({ error: error.message });
  }
});

function ordersDiagnosticSolution(log = {}) {
  const text = `${log.message || ''} ${log.path || ''}`.toLowerCase();
  if (text.includes('printer') || text.includes('kot'))
    return 'Check Print Bridge, LAN connectivity, printer power, and category routing in Orders → Operations.';
  if (text.includes('offline') || text.includes('network') || text.includes('fetch'))
    return 'Keep the Orders screen open, restore internet, and let queued counter orders sync automatically.';
  if (text.includes('availability') || text.includes('menu'))
    return 'Check Menu availability and confirm the dish has a valid price in Air Menu.';
  if (Number(log.status_code) >= 500)
    return 'Check Database Health first. If it is healthy, copy this event and inspect the matching Orders route in server.js.';
  return (
    log.solution ||
    'Review the route and time of this Orders event. If it repeats, copy the record for technical support.'
  );
}

app.get('/api/admin/orders-errors', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    if (!sql)
      return res
        .status(503)
        .json({ error: 'Neon is not configured, so Orders error logs cannot be loaded.' });
    const limit = Math.min(Math.max(Number(req.query.limit || 100), 1), 200);
    await ensureDiagnosticsTable();
    const rows =
      await sql`SELECT id,created_at,level,category,message,solution,location,method,path,status_code,duration_ms,details FROM website_diagnostics WHERE (category='orders' OR path LIKE '/api/orders%') AND level IN ('error','warning') ORDER BY created_at DESC LIMIT ${limit}`;
    res.json({ logs: rows.map((log) => ({ ...log, solution: ordersDiagnosticSolution(log) })) });
  } catch (error) {
    console.error('Orders diagnostics read error:', error);
    res.status(500).json({ error: 'Unable to load Orders error logs.' });
  }
});

app.delete('/api/admin/orders-errors', async (req, res) => {
  try {
    if (!sql)
      return res
        .status(503)
        .json({ error: 'Neon is not configured, so Orders error logs cannot be cleared.' });
    await ensureDiagnosticsTable();
    await sql`DELETE FROM website_diagnostics WHERE category='orders' OR path LIKE '/api/orders%'`;
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: 'Unable to clear Orders error logs.' });
  }
});

app.get('/api/admin/health', async (req, res) => {
  const checks = {
    server: { ok: true, message: 'Server function responded.' },
    database: { ok: false, message: 'Not checked.' },
    cloudinary: { ok: false, message: 'Not checked.' },
    environment: { ok: false, message: 'Not checked.' },
    ordersConsole: { ok: false, message: 'Not checked.' },
  };
  let databaseMetrics = null;

  try {
    if (!sql) {
      checks.database.message = 'NEON_DATABASE_URL is missing or invalid.';
    } else {
      const startedAt = Date.now();
      await sql`SELECT 1`;
      const latencyMs = Date.now() - startedAt;
      await Promise.all([
        ensureDirectOrdersTable(),
        ensureKotsTable(),
        ensureOperationsConfigTable(),
        ensureMenuAvailabilityTable(),
        ensureLoyaltyTable(),
        ensurePushSubscriptionsTable(),
      ]);
      const [
        orders,
        kots,
        printers,
        availability,
        loyalty,
        subscriptions,
        latestOrder,
        databaseSize,
      ] = await Promise.all([
        sql`SELECT COUNT(*)::int AS count FROM direct_orders`,
        sql`SELECT COUNT(*)::int AS count FROM order_kots`,
        sql`SELECT COUNT(*)::int AS count FROM order_operations_config`,
        sql`SELECT COUNT(*)::int AS count FROM menu_availability WHERE unavailable_until > NOW()`,
        sql`SELECT COUNT(*)::int AS count FROM loyalty_accounts`,
        sql`SELECT COUNT(*)::int AS count FROM order_push_subscriptions`,
        sql`SELECT MAX(created_at) AS created_at FROM direct_orders`,
        sql`SELECT pg_database_size(current_database())::bigint AS bytes`,
      ]);
      const warningBytes = Math.max(0, Number(process.env.DB_STORAGE_WARNING_BYTES || 536870912));
      const sizeBytes = Number(databaseSize[0]?.bytes || 0);
      databaseMetrics = {
        latencyMs,
        sizeBytes,
        warningBytes,
        latestOrderAt: latestOrder[0]?.created_at || null,
        counts: {
          orders: Number(orders[0]?.count || 0),
          kots: Number(kots[0]?.count || 0),
          printerConfigs: Number(printers[0]?.count || 0),
          unavailableItems: Number(availability[0]?.count || 0),
          loyaltyAccounts: Number(loyalty[0]?.count || 0),
          alertDevices: Number(subscriptions[0]?.count || 0),
        },
        storageWarning: warningBytes > 0 && sizeBytes >= warningBytes,
      };
      checks.database = {
        ok: !databaseMetrics.storageWarning && latencyMs < 1000,
        message: `Neon responded in ${latencyMs} ms${databaseMetrics.storageWarning ? ' · storage warning' : ''}.`,
      };
    }

    const cloudinaryConfig = cloudinary.config();
    checks.cloudinary =
      cloudinaryConfig.cloud_name && cloudinaryConfig.api_key
        ? { ok: true, message: 'Cloudinary credentials are configured.' }
        : { ok: false, message: 'Cloudinary credentials are missing. Image uploads may fail.' };

    checks.environment =
      process.env.ADMIN_USERNAME && process.env.ADMIN_PASSWORD
        ? { ok: true, message: 'Admin credentials are configured.' }
        : { ok: false, message: 'ADMIN_USERNAME or ADMIN_PASSWORD is missing.' };
    checks.ordersConsole =
      process.env.ORDERS_USERNAME && process.env.ORDERS_PASSWORD
        ? { ok: true, message: 'Orders console credentials are configured.' }
        : { ok: false, message: 'ORDERS_USERNAME or ORDERS_PASSWORD is missing.' };

    const ok = Object.values(checks).every((check) => check.ok);
    res.status(ok ? 200 : 503).json({
      ok,
      checkedAt: new Date().toISOString(),
      checks,
      databaseMetrics,
    });
  } catch (error) {
    logDiagnostic({
      level: 'error',
      category: 'server',
      message: `Health check failed: ${error.message}`,
      method: req.method,
      path: req.path,
      statusCode: 500,
      ipHash: hashIp(req),
      userAgent: req.headers['user-agent'] || '',
      details: { stack: error.stack },
    });
    res.status(500).json({
      ok: false,
      checkedAt: new Date().toISOString(),
      checks,
      error: error.message,
    });
  }
});

app.post('/api/client-log', async (req, res) => {
  try {
    const body = req.body || {};
    const category =
      body.category === 'performance'
        ? 'performance'
        : body.category === 'orders'
          ? 'orders'
          : 'frontend';
    const level = body.level === 'warning' || category === 'performance' ? 'warning' : 'error';
    await writeDiagnostic({
      level,
      category,
      message: body.message || 'Browser-side website issue reported.',
      method: category === 'performance' ? 'PAGE' : 'BROWSER',
      path: body.path || req.headers.referer || req.path,
      durationMs: Number(body.durationMs) || null,
      ipHash: hashIp(req),
      userAgent: req.headers['user-agent'] || '',
      details: {
        reportedVia: `${req.method} ${req.path}`,
        source: body.source || '',
        line: body.line || '',
        column: body.column || '',
        stack: String(body.stack || '').slice(0, 1200),
        href: body.href || '',
        metric: body.metric || '',
        timings: body.timings || {},
      },
    });
    res.status(204).end();
  } catch (error) {
    console.error('Client log error:', error);
    res.status(204).end();
  }
});

app.get('/api/content/:section', async (req, res) => {
  if (!collections[req.params.section] || req.params.section === 'airMenu')
    return res.status(404).json({ error: 'Unknown content section.' });

  try {
    res.set('Cache-Control', 'public, max-age=60, s-maxage=300, stale-while-revalidate=600');
    const section = await getSection(req.params.section);
    res.json(req.params.section === 'blogs' ? filterScheduledBlogs(section) : section);
  } catch (error) {
    console.error('Neon error:', error);
    logDiagnostic({
      level: 'error',
      category: 'server',
      message: `Content API failed for ${req.params.section}: ${error.message}`,
      method: req.method,
      path: req.path,
      statusCode: 500,
      ipHash: hashIp(req),
      userAgent: req.headers['user-agent'] || '',
      details: { stack: error.stack },
    });
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/blogs/:slug', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    const blogs = await getSection('blogs');
    const post = publishedPosts(blogs.posts || []).find((item) => item.slug === req.params.slug);
    if (!post) return res.status(404).json({ error: 'Blog post not found.' });
    res.json(post);
  } catch (error) {
    console.error('Neon error:', error);
    logDiagnostic({
      level: 'error',
      category: 'server',
      message: `Blog API failed for ${req.params.slug}: ${error.message}`,
      method: req.method,
      path: req.path,
      statusCode: 500,
      ipHash: hashIp(req),
      userAgent: req.headers['user-agent'] || '',
      details: { stack: error.stack },
    });
    res.status(500).json({ error: error.message });
  }
});

const xmlEscape = (value) =>
  String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

const absoluteSiteUrl = (url, siteUrl) => {
  try {
    return new URL(url, siteUrl).href;
  } catch {
    return url;
  }
};

function publicSiteUrl(req, global = {}) {
  const configured = String(global.siteUrl || '')
    .trim()
    .replace(/\/$/, '');
  if (configured && !configured.includes('localhost')) return configured;

  const hostHeader = req.headers['x-forwarded-host'] || req.headers.host;
  const hostValue = Array.isArray(hostHeader) ? hostHeader[0] : hostHeader;
  if (hostValue && !String(hostValue).includes('localhost')) {
    const protoHeader = req.headers['x-forwarded-proto'];
    const proto = Array.isArray(protoHeader) ? protoHeader[0] : protoHeader;
    return `${proto || 'https'}://${hostValue}`.replace(/\/$/, '');
  }

  return `http://localhost:${port}`;
}

app.get('/sitemap.xml', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const global = await getSection('global');
  const menu = await getSection('menu');
  const blogs = filterScheduledBlogs(await getSection('blogs'));
  const siteUrl = publicSiteUrl(req, global);
  const today = new Date().toISOString().slice(0, 10);
  const menuImages = (menu.dishes || [])
    .filter((dish) => dish.image)
    .map((dish) => ({
      loc: absoluteSiteUrl(dish.image, siteUrl),
      title: `${dish.name} at Red Lantern Restaurant in Colva`,
    }));
  const urls = [
    {
      loc: `${siteUrl}/home`,
      priority: '1.0',
      changefreq: 'weekly',
      images: [
        global.ogImage
          ? {
              loc: absoluteSiteUrl(global.ogImage, siteUrl),
              title: 'Red Lantern Restaurant in Colva Goa',
            }
          : null,
      ].filter(Boolean),
    },
    { loc: `${siteUrl}/menu`, priority: '0.9', changefreq: 'weekly', images: menuImages },
    { loc: `${siteUrl}/contact`, priority: '0.8', changefreq: 'monthly' },
    { loc: `${siteUrl}/about`, priority: '0.7', changefreq: 'monthly' },
    { loc: `${siteUrl}/blogs`, priority: '0.7', changefreq: 'weekly' },
  ];
  (blogs.posts || []).forEach((post) => {
    urls.push({
      loc: `${siteUrl}/blog/${encodeURIComponent(post.slug)}`,
      priority: '0.6',
      changefreq: 'monthly',
      images: post.image ? [{ loc: absoluteSiteUrl(post.image, siteUrl), title: post.title }] : [],
    });
  });

  res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
${urls.map((url) => `  <url><loc>${xmlEscape(url.loc)}</loc><lastmod>${today}</lastmod><changefreq>${url.changefreq}</changefreq><priority>${url.priority}</priority>${(url.images || []).map((image) => `<image:image><image:loc>${xmlEscape(image.loc)}</image:loc><image:title>${xmlEscape(image.title)}</image:title></image:image>`).join('')}</url>`).join('\n')}
</urlset>`);
});

app.get('/rss.xml', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const global = await getSection('global');
  const blogs = filterScheduledBlogs(await getSection('blogs'));
  const siteUrl = publicSiteUrl(req, global);
  const posts = blogs.posts || [];

  res.type('application/rss+xml').send(`<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>${xmlEscape(blogs.pageTitle || 'Red Lantern Journal')}</title>
    <link>${xmlEscape(`${siteUrl}/blogs`)}</link>
    <description>${xmlEscape(blogs.pageSubtitle || 'Food guides, restaurant stories, and menu updates from Red Lantern Restaurant in Colva, Goa.')}</description>
    <language>en-IN</language>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
    ${posts.map((post) => `<item><title>${xmlEscape(post.title)}</title><link>${xmlEscape(`${siteUrl}/blog/${encodeURIComponent(post.slug)}`)}</link><guid>${xmlEscape(`${siteUrl}/blog/${encodeURIComponent(post.slug)}`)}</guid><description>${xmlEscape(post.seoDescription || post.excerpt || '')}</description></item>`).join('\n    ')}
  </channel>
</rss>`);
});

app.post('/api/growth-ai', async (req, res) => {
  try {
    const content = await getAllContent();
    const plan = await generateAiGrowthPlan(content);
    res.json({
      generatedAt: new Date().toISOString(),
      plan,
    });
  } catch (error) {
    console.error('AI growth error:', error);
    logDiagnostic({
      level: 'error',
      category: 'server',
      message: `AI growth plan failed: ${error.message}`,
      method: req.method,
      path: req.path,
      statusCode: error.statusCode || 500,
      ipHash: hashIp(req),
      userAgent: req.headers['user-agent'] || '',
      details: { stack: error.stack },
    });
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

Object.keys(collections).forEach((section) => {
  app.post(`/api/update-${section}`, upload.any(), async (req, res) => {
    try {
      if (req.files && req.files.length > 0) {
        if (!process.env.CLOUDINARY_URL && !process.env.CLOUDINARY_API_KEY) {
          console.warn('Missing CLOUDINARY_URL, images will not be uploaded to cloud.');
          throw new Error('Cloudinary is not configured. Add credentials to your .env file.');
        }
        const cConfig = cloudinary.config();
        if (!cConfig.api_key) {
          throw new Error(
            `Cloudinary API Key is missing! Found Cloud Name: ${cConfig.cloud_name ? 'Yes' : 'No'}.`
          );
        }

        for (const file of req.files) {
          const safeBase = path
            .basename(file.originalname, path.extname(file.originalname))
            .replace(/[^a-z0-9]+/gi, '-')
            .replace(/^-|-$/g, '')
            .toLowerCase();
          const filename = `${Date.now()}-${safeBase}`;
          const result = await new Promise((resolve, reject) => {
            const stream = cloudinary.uploader.upload_stream(
              {
                folder: 'red_lantern_uploads',
                public_id: filename,
                resource_type: 'image',
                format: 'webp',
                transformation: [
                  {
                    width: 1600,
                    height: 1600,
                    crop: 'limit',
                    quality: 'auto:best',
                    fetch_format: 'webp',
                  },
                ],
                api_key: cConfig.api_key,
                api_secret: cConfig.api_secret,
                cloud_name: cConfig.cloud_name,
              },
              (error, result) => {
                if (error) reject(error);
                else resolve(result);
              }
            );
            stream.end(file.buffer);
          });

          file.publicUrl = result.secure_url;
        }
      }
      const normalized = normalizeSection(section, req.body, req.files || []);
      if (section === 'airMenu') {
        const existing = await getSection('airMenu');
        normalized.closedAt = normalized.restaurantClosed
          ? existing.restaurantClosed && existing.closedAt
            ? existing.closedAt
            : new Date().toISOString()
          : '';
        if (existing.proximity?.locked && req.body.airProximityLocked === 'on') {
          normalized.proximity.latitude = existing.proximity.latitude;
          normalized.proximity.longitude = existing.proximity.longitude;
        }
        const existingItems = [...(existing.items || []), ...(existing.barItems || [])].filter(
          (item) => item?.name
        ).length;
        const submittedItems = [...(normalized.items || []), ...(normalized.barItems || [])].filter(
          (item) => item?.name
        ).length;
        if (existingItems && !submittedItems && req.body.airMenuConfirmEmpty !== 'on')
          throw new Error(
            'Your saved menu has items, but this publish contains none. The menu was not changed. If you truly want to clear every item, confirm that choice in Admin and publish again.'
          );
      }
      await saveSection(section, normalized);
      clearPublicContentCache();
      logDiagnostic({
        level: 'info',
        category: 'cms-save',
        message: `${labels[section]} changes saved successfully.`,
        method: req.method,
        path: req.path,
        statusCode: 200,
        ipHash: hashIp(req),
        userAgent: req.headers['user-agent'] || '',
        details: {
          section,
          uploadedFiles: (req.files || []).length,
        },
      });
      res.send(
        `<h2>Success!</h2><p>${labels[section]} changes saved to Neon.</p><a href="/admin">Go Back to Dashboard</a>`
      );
    } catch (error) {
      console.error('Save error:', error);
      logDiagnostic({
        level: 'error',
        category: 'cms-save',
        message: `${labels[section]} save failed: ${error.message}`,
        method: req.method,
        path: req.path,
        statusCode: 500,
        ipHash: hashIp(req),
        userAgent: req.headers['user-agent'] || '',
        details: {
          section,
          uploadedFiles: (req.files || []).length,
          stack: error.stack,
        },
      });
      res.status(500).send('Database error: ' + error.message);
    }
  });
});

app.use((error, req, res, next) => {
  if (!error) return next();
  console.error('Unhandled request error:', error);
  logDiagnostic({
    level: 'error',
    category: 'server',
    message: `Unhandled request error: ${error.message}`,
    method: req.method,
    path: req.path,
    statusCode: error.status || 500,
    ipHash: hashIp(req),
    userAgent: req.headers['user-agent'] || '',
    details: { stack: error.stack },
  });
  if (res.headersSent) return next(error);
  res.status(error.status || 500).send(error.message || 'Server error.');
});

// Only start server automatically if not running in a Vercel serverless environment
if (!process.env.VERCEL) {
  const server = app.listen(port, host, () => {
    console.log(`Red Lantern backend running on ${host}:${port}`);
  });

  server.on('error', (error) => {
    console.error('Server failed to start:', error);
    process.exit(1);
  });
}

module.exports = app;
