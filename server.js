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
      process.env[match[1]] = String(match[2] || '').replace(/^["']|["']$/g, '').trim();
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
    console.warn("Invalid CLOUDINARY_URL format. It should be: cloudinary://API_KEY:API_SECRET@CLOUD_NAME");
    delete process.env.CLOUDINARY_URL;
  }
}

const cloudinary = require('cloudinary').v2;

if (process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME.trim(),
    api_key: process.env.CLOUDINARY_API_KEY.trim(),
    api_secret: process.env.CLOUDINARY_API_SECRET.trim(),
    secure: true
  });
} else if (process.env.CLOUDINARY_URL) {
  const cleanUrl = process.env.CLOUDINARY_URL.replace(/^["']|["']$/g, '').trim();
  const match = cleanUrl.match(/^cloudinary:\/\/([^:]+):([^@]+)@(.+)$/);
  if (match) {
    cloudinary.config({
      api_key: match[1].trim(),
      api_secret: match[2].trim(),
      cloud_name: match[3].trim(),
      secure: true
    });
  } else {
    console.warn("⚠️ CLOUDINARY_URL format looks incorrect. It should be: cloudinary://API_KEY:API_SECRET@CLOUD_NAME");
  }
}

const app = express();
app.set('trust proxy', 1);
const port = process.env.PORT || 3001;
const host = process.env.HOST || '0.0.0.0';
let uploadsDir = process.env.VERCEL ? path.join('/tmp', 'red-lantern-uploads') : path.join(__dirname, 'uploads');

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
      console.warn('Neon URL format is invalid. Admin saves are disabled until NEON_DATABASE_URL is fixed.');
    }
  } else {
    console.warn('Neon URL format is invalid. It should start with postgresql:// or postgres://. Admin saves are disabled until NEON_DATABASE_URL is fixed.');
  }
} else {
  console.warn('Neon URL not found. Admin page will load, but saving changes is disabled.');
}

let diagnosticsTablePromise = null;
const slowRequestMs = Number(process.env.SLOW_REQUEST_MS || 3500);

function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return String(value || req.ip || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
}

function hashIp(req) {
  return crypto.createHash('sha256').update(clientIp(req)).digest('hex').slice(0, 16);
}

function dailyQrVisitorId(req) {
  const dateBucket = new Date().toISOString().slice(0, 10);
  const secret = process.env.AIR_MENU_SECRET || process.env.ADMIN_PASSWORD || 'red-lantern-qr-visitors';
  return crypto.createHmac('sha256', secret).update(`${dateBucket}:${clientIp(req)}`).digest('hex').slice(0, 12);
}

function safeScanHeader(value) {
  const text = String(Array.isArray(value) ? value[0] : value || '').slice(0, 120);
  try { return decodeURIComponent(text); } catch { return text; }
}

function qrScanDetails(req, mode) {
  return {
    mode,
    qrType: mode === 'card' ? 'Business Card QR' : 'Table QR',
    country: safeScanHeader(req.headers['x-vercel-ip-country']),
    region: safeScanHeader(req.headers['x-vercel-ip-country-region']),
    city: safeScanHeader(req.headers['x-vercel-ip-city'])
  };
}

function diagnosticSolution(category, message = '') {
  const text = String(message).toLowerCase();
  if (category === 'security') return 'Check the request path and IP hash. If repeated, keep admin credentials strong and consider blocking the source in Vercel Firewall.';
  if (category === 'auth') return 'Confirm ADMIN_USERNAME and ADMIN_PASSWORD in Vercel Environment Variables. If failures repeat, rotate the admin password.';
  if (category === 'cms-save' && text.includes('cloudinary')) return 'Check CLOUDINARY_URL or Cloudinary API credentials in Vercel, then redeploy and try the image upload again.';
  if (category === 'cms-save' && (text.includes('neon') || text.includes('database'))) return 'Check NEON_DATABASE_URL in Vercel and confirm the Neon database is active.';
  if (category === 'performance') return 'Open Vercel Observability for this path, check database/API calls, and reduce image or payload size if this repeats.';
  if (category === 'frontend') return 'Open the listed page in the browser, reproduce the action, and check the script/file named in the log details.';
  if (category === 'server') return 'Check the exact route and stack/location in this log, then inspect the matching server route in server.js.';
  return 'Review the route, message, and details below. If repeated, fix the referenced page or server route first.';
}

function diagnosticLocation(category, pathValue = '', details = {}) {
  if (details.location) return details.location;
  if (category === 'frontend') return details.source || pathValue || 'Browser page';
  if (category === 'cms-save') return `Admin CMS save route: ${pathValue || '/api/update-*'}`;
  if (category === 'auth') return 'Admin authentication middleware';
  if (category === 'security') return 'Request security middleware';
  if (category === 'performance') return `Slow route: ${pathValue || 'unknown'}`;
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
    files: 12
  },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype || !file.mimetype.startsWith('image/')) {
      return cb(new Error('Only image uploads are allowed.'));
    }
    return cb(null, true);
  }
});

const menuFileUpload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    const extension = path.extname(file.originalname).toLowerCase();
    const isMenuFile = extension === '.pdf' || extension === '.csv' || extension === '.xlsx';
    cb(isMenuFile ? null : new Error('Please upload a PDF, CSV, or XLSX file.'), isMenuFile);
  }
});

function securityHeaders(req, res, next) {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Cross-Origin-Resource-Policy': 'same-origin'
  });
  next();
}

function secureCompare(a = '', b = '') {
  const aHash = crypto.createHash('sha256').update(String(a)).digest();
  const bHash = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(aHash, bHash);
}

function isProtectedAdminPath(req) {
  return req.path === '/admin'
    || req.path === '/admin.html'
    || req.path === '/admin-cms.js'
    || req.path === '/api/admin/content'
    || req.path === '/api/admin/logs'
    || req.path === '/api/admin/qr-scans'
    || req.path === '/api/admin/health'
    || req.path.startsWith('/api/admin/qr/')
    || req.path.startsWith('/api/admin/air-menu/')
    || req.path.startsWith('/api/update-')
    || req.path === '/api/growth-ai';
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
      details: { failures: maxAdminFailures }
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
      userAgent: req.headers['user-agent'] || ''
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
    details: { username: username ? 'provided' : 'missing' }
  });
  res.set('WWW-Authenticate', 'Basic realm="Red Lantern Admin", charset="UTF-8"');
  return res.status(401).send('Invalid username or password.');
}

function requireOrdersConsole(req, res, next) {
  const protectedPath = req.path === '/orders' || req.path === '/orders.html' || req.path === '/orders.js' || req.path === '/orders.css' || req.path.startsWith('/api/orders');
  if (!protectedPath) return next();
  const username = process.env.ORDERS_USERNAME;
  const password = process.env.ORDERS_PASSWORD;
  if (!username || !password) return res.status(503).send('Orders console is not configured. Add ORDERS_USERNAME and ORDERS_PASSWORD.');
  const [scheme, encoded] = String(req.headers.authorization || '').split(' ');
  const [providedUser, ...providedPassword] = scheme === 'Basic' && encoded ? Buffer.from(encoded, 'base64').toString('utf8').split(':') : [];
  if (!secureCompare(providedUser || '', username) || !secureCompare(providedPassword.join(':'), password)) {
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
        userAgent: req.headers['user-agent'] || ''
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
        userAgent: req.headers['user-agent'] || ''
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
    'claude-install.ps1'
  ]);

  if (blockedRoots.some((root) => requestPath === root || requestPath.startsWith(`${root}/`))
    || blockedFiles.has(basename)) {
    logDiagnostic({
      level: 'warning',
      category: 'security',
      message: `Blocked request for sensitive file or folder: ${requestPath}`,
      method: req.method,
      path: requestPath,
      statusCode: 404,
      ipHash: hashIp(req),
      userAgent: req.headers['user-agent'] || ''
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
  ['/orders', 'orders.html']
]);

const legacyPageRedirects = new Map([
  ['/index.html', '/home'],
  ['/menu.html', '/menu'],
  ['/about.html', '/about'],
  ['/blogs.html', '/blogs'],
  ['/contact.html', '/contact']
]);

app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  if (req.path === '/') return res.redirect(301, '/home');
  if (req.path === '/air-menu.html') return res.redirect(302, '/menu');
  if (req.path === '/blog-post.html') {
    const slug = String(req.query.slug || '').trim();
    return res.redirect(301, slug ? `/blog/${encodeURIComponent(slug)}` : '/blog');
  }
  if (legacyPageRedirects.has(req.path)) return res.redirect(301, legacyPageRedirects.get(req.path));
  return next();
});

app.use(express.static(__dirname, {
  dotfiles: 'deny',
  index: false,
  maxAge: '1h',
  setHeaders: (res, filePath) => {
    if (/\/orders(?:\.html|\.js|\.css|-fixes\.css|-logo\.css|-sw\.js|\.webmanifest)$/i.test(filePath)) {
      res.set('Cache-Control', 'no-store, max-age=0');
      return;
    }
    if (/\.(?:avif|webp|png|jpe?g|gif|svg|ico)$/i.test(filePath)) {
      res.set('Cache-Control', 'public, max-age=604800, immutable');
    } else if (/\.(?:css|js)$/i.test(filePath)) {
      res.set('Cache-Control', 'public, max-age=3600, stale-while-revalidate=86400');
    }
  }
}));
if (uploadsDir) {
  app.use('/uploads', express.static(uploadsDir, {
    dotfiles: 'deny',
    index: false,
    maxAge: '7d',
    immutable: true
  }));
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
  global: 'global_content'
};

const labels = {
  home: 'Home Page',
  menu: 'Menu Page',
  airMenu: 'Air Menu',
  about: 'About Page',
  blogs: 'Blogs Page',
  contact: 'Contact Page',
  global: 'Global Settings'
};

let publicContentCache = null;
let directOrdersTableReady = null;
let menuAvailabilityTableReady = null;
let pushSubscriptionsTableReady = null;
async function ensureMenuAvailabilityTable() {
  if (!sql) throw new Error('Orders database is not configured.');
  if (!menuAvailabilityTableReady) menuAvailabilityTableReady = sql`CREATE TABLE IF NOT EXISTS menu_availability (item_key TEXT PRIMARY KEY, unavailable_until TIMESTAMPTZ NOT NULL)`;
  return menuAvailabilityTableReady;
}
async function ensureDirectOrdersTable() {
  if (!sql) throw new Error('Orders database is not configured.');
  if (!directOrdersTableReady) directOrdersTableReady = (async () => {
    await sql`CREATE TABLE IF NOT EXISTS direct_orders (id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'new', mode TEXT NOT NULL, customer_name TEXT, customer_phone TEXT NOT NULL, special_request TEXT, items JSONB NOT NULL, total NUMERIC NOT NULL DEFAULT 0, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`;
    await sql`ALTER TABLE direct_orders ADD COLUMN IF NOT EXISTS order_day DATE`;
    await sql`ALTER TABLE direct_orders ADD COLUMN IF NOT EXISTS daily_order_number INTEGER`;
    await sql`UPDATE direct_orders SET order_day=(created_at AT TIME ZONE 'Asia/Kolkata')::date WHERE order_day IS NULL`;
    await sql`WITH numbered AS (SELECT id, ROW_NUMBER() OVER (PARTITION BY order_day ORDER BY created_at, id)::integer AS daily_number FROM direct_orders) UPDATE direct_orders AS orders SET daily_order_number=numbered.daily_number FROM numbered WHERE orders.id=numbered.id AND orders.daily_order_number IS NULL`;
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS direct_orders_day_number_unique ON direct_orders (order_day, daily_order_number) WHERE daily_order_number IS NOT NULL`;
    await sql`CREATE TABLE IF NOT EXISTS direct_order_counters (order_day DATE PRIMARY KEY, next_number INTEGER NOT NULL)`;
  })();
  return directOrdersTableReady;
}
function kolkataOrderDay(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const value = Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}
async function nextDailyOrderNumber() {
  await ensureDirectOrdersTable();
  const orderDay = kolkataOrderDay();
  const rows = await sql`INSERT INTO direct_order_counters (order_day, next_number) SELECT ${orderDay}::date, COALESCE(MAX(daily_order_number), 0) + 1 FROM direct_orders WHERE order_day=${orderDay}::date ON CONFLICT (order_day) DO UPDATE SET next_number=direct_order_counters.next_number + 1 RETURNING next_number`;
  return { orderDay, number: Number(rows[0].next_number) };
}
async function ensurePushSubscriptionsTable() {
  if (!sql) throw new Error('Orders database is not configured.');
  if (!pushSubscriptionsTableReady) pushSubscriptionsTableReady = sql`CREATE TABLE IF NOT EXISTS order_push_subscriptions (endpoint TEXT PRIMARY KEY, subscription JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`;
  return pushSubscriptionsTableReady;
}
let pushEnabled = false;
try {
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY && process.env.VAPID_SUBJECT) {
    webpush.setVapidDetails(process.env.VAPID_SUBJECT, process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);
    pushEnabled = true;
  }
} catch (error) { console.warn('Web push is disabled because VAPID settings are invalid:', error.message); }
async function notifyDirectOrder(order) {
  if (!pushEnabled || !sql) return;
  try {
    await ensurePushSubscriptionsTable();
    const subscriptions = await sql`SELECT endpoint, subscription FROM order_push_subscriptions`;
    const dailyOrder = String(order.dailyOrderNumber || '').padStart(2, '0');
    const payload = JSON.stringify({ title: `New Order #${dailyOrder}`, body: `${order.itemCount} item${order.itemCount === 1 ? '' : 's'} · ₹${Number(order.total || 0).toFixed(0)}`, url: '/orders', tag: `order-${order.id}` });
    const results = await Promise.allSettled(subscriptions.map((row) => webpush.sendNotification(row.subscription, payload)));
    await Promise.all(results.map((result, index) => {
      const statusCode = result.status === 'rejected' ? result.reason?.statusCode : 0;
      return statusCode === 404 || statusCode === 410 ? sql`DELETE FROM order_push_subscriptions WHERE endpoint=${subscriptions[index].endpoint}` : Promise.resolve();
    }));
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

const slugify = (value) => String(value || '')
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

async function saveSection(section, data) {
  if (!sql) throw new Error('Neon is not configured. Add NEON_DATABASE_URL to your .env file.');
  const existing = await getSection(section);
  const merged = { ...existing, ...data };
  await sql`
    INSERT INTO website_content (id, data) 
    VALUES (${collections[section]}, ${merged})
    ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data
  `;
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
    reviews: reviewNames.map((name, index) => ({
      name,
      stars: reviewStars[index] || '★★★★★',
      text: reviewTexts[index] || ''
    })).filter((review) => review.name || review.text)
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
    pageSubtitle: body.menuPageSubtitle || 'Explore our diverse selection of authentic Chinese and Goan dishes.',
    note: body.menuNote || 'Menu availability may vary. Please call us for pricing and daily specials.',
    dishes: names.map((name, index) => ({
      name,
      price: prices[index] || '',
      description: descriptions[index] || '',
      category: categories[index] || 'Signature Dishes',
      badge: badges[index] || '',
      image: indexedFile(files, 'dishPhoto', index) || currentImages[index] || ''
    })).filter((dish) => dish.name)
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
  const isValidTime = (value) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value || ''));
  const scheduleWasSubmitted = ['airService1Open', 'airService1Close', 'airService2Open', 'airService2Close'].some((key) => Object.prototype.hasOwnProperty.call(body, key));
  const serviceWindows = scheduleWasSubmitted
    ? [[body.airService1Open, body.airService1Close], [body.airService2Open, body.airService2Close]].filter(([open, close]) => isValidTime(open) && isValidTime(close)).map(([open, close]) => ({ open, close }))
    : [{ open: '12:30', close: '15:00' }, { open: '18:30', close: '00:00' }];
  return {
    pageTitle: body.airMenuTitle || 'Our Menu',
    pageSubtitle: body.airMenuSubtitle || 'Explore our freshly prepared food and beverages.',
    note: body.airMenuNote || 'Availability may vary. Please ask our team about today’s specials.',
    tableLive: body.airTableLive === 'on',
    cardLive: body.airCardLive === 'on',
    tableDirectOrders: body.airTableDirectOrders === 'on',
    cardDirectOrders: body.airCardDirectOrders === 'on',
    showTablePrices: body.airShowTablePrices === 'on',
    showCardPrices: body.airShowCardPrices === 'on',
    cardCallEnabled: body.airCardCallEnabled === 'on',
    cardOrderPhone: String(body.airCardOrderPhone || '').trim(),
    serviceWindows,
    restaurantClosed: body.airRestaurantClosed === 'on',
    reopensAt: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(String(body.airReopensAt || '')) ? String(body.airReopensAt) : '',
    closureMessage: String(body.airClosureMessage || '').trim().slice(0, 240),
    categoryVisibility,
    sourceFileName: body.airSourceFileName || '',
    barSourceFileName: body.airBarSourceFileName || '',
    items: dedupeMenuItems(names.map((name, index) => ({
      name: String(name || '').trim(),
      price: String(prices[index] || '').trim(),
      fullPrice: String(fullPrices[index] || '').trim(),
      halfPrice: String(halfPrices[index] || '').trim(),
      withBonePrice: String(withBonePrices[index] || '').trim(),
      bonelessPrice: String(bonelessPrices[index] || '').trim(),
      category: String(categories[index] || 'Menu').trim() || 'Menu',
      type: types[index] === 'beverage' ? 'beverage' : 'food',
      description: String(descriptions[index] || '').trim(),
      dietary: dietaryValues[index] === 'nonveg' ? 'nonveg' : dietaryValues[index] === 'veg' ? 'veg' : dietaryFromMenuCategory(categories[index]),
      bestSeller: bestSellers[index] === 'true',
      mustHave: mustHaves[index] === 'true',
      gravyStyleAvailable: gravyStyleAvailable[index] === 'true'
    })).filter((item) => item.name)),
    barItems: dedupeMenuItems(barNames.map((name, index) => ({
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
      isBar: true
    })).filter((item) => item.name))
  };
}

function addAirMenuExportSheet(workbook, name, columns, rows) {
  const sheet = workbook.addWorksheet(name, {
    views: [{ state: 'frozen', ySplit: 1, showGridLines: false }],
    properties: { tabColor: { argb: name === 'Food Menu' ? 'FFB4533C' : 'FF9A6B3D' } }
  });
  sheet.columns = columns.map((column) => ({ header: column.label, key: column.key, width: column.width }));
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
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: index % 2 ? 'FFFBF8F5' : 'FFFFFFFF' } };
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
    ['How to use', 'Edit the Food Menu and Bar Menu sheets, then upload this same file through the matching Import Food Menu or Import Bar Menu control in Admin. The correct sheet is selected automatically.'],
    ['Food flags', 'Use Yes or No for Best Seller, Must Have, and Gravy / Semi-Gravy. Enable the Gravy / Semi-Gravy option only for dishes that can be ordered either way. Use Veg, Non-Veg, or leave Dietary blank; category names containing Veg or Non-Veg also set the dietary mark automatically.'],
    ['Prices', 'Enter a number or a price with ₹. Leave a pricing column blank when it does not apply.'],
    ['Important', 'Save this file as .xlsx. Publish the Air Menu in Admin after importing your changes.']
  ]);
  instructions.getRow(1).height = 30;
  instructions.getRow(1).eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, name: 'Arial', size: 12 };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF5A4037' } };
  });
  instructions.eachRow((row, rowNumber) => row.eachCell((cell) => {
    cell.alignment = { vertical: 'middle', wrapText: true };
    if (rowNumber > 1) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: rowNumber % 2 ? 'FFFFFBF8' : 'FFFFFFFF' } };
  }));
  instructions.getColumn(1).eachCell((cell) => { cell.font = { ...(cell.font || {}), bold: true, name: 'Arial' }; });

  const foodSheet = addAirMenuExportSheet(workbook, 'Food Menu', [
    { key: 'name', label: 'Item Name', width: 31 }, { key: 'category', label: 'Category', width: 22 },
    { key: 'dietary', label: 'Veg / Non-Veg', width: 15 }, { key: 'price', label: 'Price', width: 12 },
    { key: 'halfPrice', label: 'Half', width: 11 }, { key: 'fullPrice', label: 'Full', width: 11 },
    { key: 'withBonePrice', label: 'With Bone', width: 13 }, { key: 'bonelessPrice', label: 'Boneless', width: 13 },
    { key: 'description', label: 'Description', width: 38 }, { key: 'bestSeller', label: 'Best Seller', width: 13 },
    { key: 'mustHave', label: 'Must Have', width: 13 }, { key: 'gravyStyleAvailable', label: 'Gravy / Semi-Gravy', width: 18 },
    { key: 'type', label: 'Type', width: 12 }
  ], (menu.items || []).map((item) => ({
    name: item.name || '', category: item.category || 'Menu', dietary: item.dietary === 'nonveg' ? 'Non-Veg' : item.dietary === 'veg' ? 'Veg' : '',
    price: exportMenuPrice(item.price), halfPrice: exportMenuPrice(item.halfPrice), fullPrice: exportMenuPrice(item.fullPrice), withBonePrice: exportMenuPrice(item.withBonePrice), bonelessPrice: exportMenuPrice(item.bonelessPrice),
    description: item.description || '', bestSeller: item.bestSeller ? 'Yes' : 'No', mustHave: item.mustHave ? 'Yes' : 'No', gravyStyleAvailable: item.gravyStyleAvailable || item.gravyAvailable || item.semiGravyAvailable ? 'Yes' : 'No', type: item.type === 'beverage' ? 'Beverage' : 'Food'
  })));
  formatExportPriceColumns(foodSheet, ['D', 'E', 'F', 'G', 'H']);
  foodSheet.dataValidations.add('C2:C1000', { type: 'list', allowBlank: true, formulae: ['"Veg,Non-Veg"'] });
  foodSheet.dataValidations.add('J2:L1000', { type: 'list', allowBlank: false, formulae: ['"Yes,No"'] });
  foodSheet.dataValidations.add('M2:M1000', { type: 'list', allowBlank: false, formulae: ['"Food,Beverage"'] });

  const barSheet = addAirMenuExportSheet(workbook, 'Bar Menu', [
    { key: 'name', label: 'Item Name', width: 31 }, { key: 'category', label: 'Category', width: 22 },
    { key: 'price', label: 'Price', width: 12 }, { key: 'price30ml', label: '30 ML', width: 12 },
    { key: 'price60ml', label: '60 ML', width: 12 }, { key: 'price90ml', label: '90 ML', width: 12 },
    { key: 'price180ml', label: '180 ML', width: 12 }, { key: 'description', label: 'Description', width: 38 },
    { key: 'bestSeller', label: 'Best Seller', width: 13 }, { key: 'type', label: 'Type', width: 12 }
  ], (menu.barItems || []).map((item) => ({
    name: item.name || '', category: item.category || 'Bar Menu', price: exportMenuPrice(item.price), price30ml: exportMenuPrice(item.price30ml), price60ml: exportMenuPrice(item.price60ml), price90ml: exportMenuPrice(item.price90ml), price180ml: exportMenuPrice(item.price180ml),
    description: item.description || '', bestSeller: item.bestSeller ? 'Yes' : 'No', type: item.type === 'food' ? 'Food' : 'Beverage'
  })));
  formatExportPriceColumns(barSheet, ['C', 'D', 'E', 'F', 'G']);
  barSheet.dataValidations.add('I2:I1000', { type: 'list', allowBlank: false, formulae: ['"Yes,No"'] });
  barSheet.dataValidations.add('J2:J1000', { type: 'list', allowBlank: false, formulae: ['"Food,Beverage"'] });
  return workbook;
}

function menuItemKey(item = {}) {
  return `${String(item.category || 'menu').toLowerCase().replace(/[^a-z0-9]/g, '')}::${String(item.name || '').toLowerCase().replace(/[^a-z0-9]/g, '')}`;
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
  return cleanDescriptionText(sentences.find((sentence) => cleanDescriptionText(sentence).length >= 55) || sentences[0]);
}

function includesLocalContext(value) {
  return /red lantern|colva|south goa|goa/i.test(value);
}

function generatedBlogDescriptions(title, content) {
  const cleanTitle = cleanDescriptionText(title);
  const lead = firstUsefulSentence(content) || cleanTitle;
  const localPhrase = 'Red Lantern Restaurant in Colva, South Goa';

  const excerptSeed = cleanTitle && lead && !lead.toLowerCase().includes(cleanTitle.toLowerCase())
    ? `${cleanTitle}: ${lead}`
    : lead || cleanTitle;
  const excerpt = trimDescription(excerptSeed, 165);

  const leadHasTitle = cleanTitle && lead.toLowerCase().includes(cleanTitle.toLowerCase());
  const seoSeed = lead && !leadHasTitle
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
    timeZone: 'Asia/Kolkata'
  }).format(new Date(timestamp));
}

function blogMetaFromSchedule(publishAt, content) {
  return `${formatBlogDate(publishAt)} · ${readTimeMinutes(content)} min read`;
}

function googleBusinessConfig() {
  const resourceId = (value, prefix) => String(value || '').trim().replace(new RegExp(`^${prefix}/`, 'i'), '');
  return {
    accountId: resourceId(process.env.GOOGLE_BUSINESS_ACCOUNT_ID, 'accounts'),
    locationId: resourceId(process.env.GOOGLE_BUSINESS_LOCATION_ID, 'locations'),
    clientId: String(process.env.GOOGLE_BUSINESS_OAUTH_CLIENT_ID || '').trim(),
    clientSecret: String(process.env.GOOGLE_BUSINESS_OAUTH_CLIENT_SECRET || '').trim(),
    refreshToken: String(process.env.GOOGLE_BUSINESS_OAUTH_REFRESH_TOKEN || '').trim(),
    syncLimit: Math.min(Math.max(Number(process.env.GOOGLE_REVIEWS_SYNC_LIMIT || 30), 1), 100)
  };
}

function assertGoogleBusinessConfig(config) {
  const missing = Object.entries({
    GOOGLE_BUSINESS_ACCOUNT_ID: config.accountId,
    GOOGLE_BUSINESS_LOCATION_ID: config.locationId,
    GOOGLE_BUSINESS_OAUTH_CLIENT_ID: config.clientId,
    GOOGLE_BUSINESS_OAUTH_CLIENT_SECRET: config.clientSecret,
    GOOGLE_BUSINESS_OAUTH_REFRESH_TOKEN: config.refreshToken
  }).filter(([, value]) => !value).map(([name]) => name);

  if (missing.length) {
    const error = new Error(`Google Business Profile sync is not configured. Missing: ${missing.join(', ')}`);
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
      grant_type: 'refresh_token'
    })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error_description || data.error || 'Google OAuth token refresh failed.');
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
    googleUpdateTime: review.updateTime || ''
  };
}

async function fetchFiveStarGoogleReviews() {
  const config = googleBusinessConfig();
  assertGoogleBusinessConfig(config);
  const accessToken = await googleBusinessAccessToken(config);
  const reviews = [];
  let pageToken = '';

  do {
    const url = new URL(`https://mybusiness.googleapis.com/v4/accounts/${encodeURIComponent(config.accountId)}/locations/${encodeURIComponent(config.locationId)}/reviews`);
    url.searchParams.set('pageSize', '50');
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || 'Google Business Profile reviews request failed.');

    reviews.push(...(data.reviews || [])
      .filter((review) => review.starRating === 'FIVE')
      .map(normalizeGoogleReview)
      .filter((review) => review.text));
    pageToken = data.nextPageToken || '';
  } while (pageToken && reviews.length < config.syncLimit);

  return reviews.slice(0, config.syncLimit);
}

function mergeReviews(existingReviews = [], googleReviews = []) {
  const seen = new Set();
  const merged = [];
  [...googleReviews, ...existingReviews].forEach((review) => {
    const key = review.googleReviewName || `${cleanDescriptionText(review.name)}:${cleanDescriptionText(review.text).slice(0, 120)}`;
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
    posts: titles.map((title, index) => {
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
        articleImage: indexedFile(files, 'blogArticleImage', index) || currentArticleImages[index] || '',
        seoTitle: seoTitles[index] || title,
        seoDescription: cleanDescriptionText(seoDescriptions[index]) || generated.seoDescription || excerpt
      };
    }).filter((post) => post.title)
  };
}

function normalizeAbout(body, files) {
  return {
    heroTitle: body.aboutHeroTitle,
    heroSubtitle: body.aboutHeroSubtitle,
    storyTitle: body.aboutStoryTitle,
    storyText: body.aboutStoryText,
    heroImage: firstFile(files, 'aboutHeroImage') || '',
    storyImage: firstFile(files, 'aboutStoryImage') || ''
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
    competitorResearchNotes: body.competitorResearchNotes
  };
}

function normalizeContact(body) {
  return {
    address: body.address,
    hours: body.hours,
    phone: body.phone,
    email: body.email,
    mapEmbedUrl: body.mapEmbedUrl
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
  return Date.UTC(year, month - 1, day, hour, minute) - (indiaOffsetMinutes * 60 * 1000);
}

function publishedPosts(posts = [], now = Date.now()) {
  return posts.filter((post) => !post.publishAt || indiaScheduleTime(post.publishAt) <= now);
}

function filterScheduledBlogs(blogs = {}) {
  return {
    ...blogs,
    posts: publishedPosts(blogs.posts || [])
  };
}

async function getAllContent(includeScheduled = false, includePrivate = false) {
  const entries = await Promise.all(Object.keys(collections).map(async (section) => [section, await getSection(section)]));
  const content = Object.fromEntries(entries);
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
        swiggy: global.swiggyUrl || ''
      }
    },
    seo: {
      title: global.seoTitle || '',
      description: global.seoDescription || '',
      keywords: global.seoKeywords || '',
      targetLocations: global.targetLocations || '',
      targetSearches: global.targetCuisines || '',
      competitors: global.competitorNames || '',
      researchNotes: global.competitorResearchNotes || ''
    },
    menu: {
      pageTitle: menu.pageTitle || '',
      pageSubtitle: menu.pageSubtitle || '',
      dishes: (menu.dishes || []).slice(0, 20).map((dish) => ({
        name: dish.name || '',
        category: dish.category || '',
        badge: dish.badge || '',
        description: dish.description || ''
      }))
    },
    blogs: {
      count: (blogs.posts || []).length,
      posts: (blogs.posts || []).slice(0, 12).map((post) => ({
        title: post.title || '',
        slug: post.slug || '',
        excerpt: post.excerpt || '',
        seoTitle: post.seoTitle || '',
        seoDescription: post.seoDescription || ''
      }))
    }
  };
}

function parseAiJson(text) {
  const cleaned = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim();
  return JSON.parse(cleaned);
}

async function generateAiGrowthPlan(content) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    const error = new Error('Missing OPENAI_API_KEY. Add it to a local .env file or server environment to enable real AI growth ideas.');
    error.statusCode = 503;
    throw error;
  }

  const model = process.env.OPENAI_GROWTH_MODEL || 'gpt-5';
  const today = new Date().toISOString().slice(0, 10);
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model,
      reasoning: { effort: 'low' },
      tools: [{
        type: 'web_search',
        user_location: {
          type: 'approximate',
          country: 'IN',
          city: 'Colva',
          region: 'Goa',
          timezone: 'Asia/Kolkata'
        }
      }],
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
                    priority: { type: 'string' }
                  },
                  required: ['title', 'detail', 'priority']
                }
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
                    impact: { type: 'string' }
                  },
                  required: ['title', 'detail', 'impact']
                }
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
                    searchTarget: { type: 'string' }
                  },
                  required: ['title', 'detail', 'searchTarget']
                }
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
                    keywords: { type: 'array', items: { type: 'string' } }
                  },
                  required: ['title', 'searchIntent', 'outline', 'keywords']
                }
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
                    landingPage: { type: 'string' }
                  },
                  required: ['campaign', 'audience', 'message', 'landingPage']
                }
              },
              missingWebsiteItems: {
                type: 'array',
                minItems: 3,
                maxItems: 8,
                items: { type: 'string' }
              },
              sources: {
                type: 'array',
                maxItems: 8,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    title: { type: 'string' },
                    url: { type: 'string' }
                  },
                  required: ['title', 'url']
                }
              }
            },
            required: ['summary', 'trendSignals', 'priorityActions', 'seoWinningMoves', 'contentIdeas', 'adIdeas', 'missingWebsiteItems', 'sources']
          }
        }
      },
      instructions: 'You are a senior local SEO and restaurant growth strategist. Your primary objective is to help the restaurant compete for top visibility in Google Maps/local pack and organic food searches. Use live web search when helpful. Give practical actions for ranking and conversions, but never guarantee first-page ranking. Return only valid JSON matching the schema.',
      input: `Today is ${today}. Create a current SEO-first growth plan for this restaurant to compete for food and restaurant searches around Colva and South Goa. Prioritize: Google Business Profile/local pack visibility, high-intent landing pages, menu SEO, blog topic clusters, review strategy, competitor positioning, technical/schema improvements, and measurable conversion tracking. Use the website/CMS data below, competitor inputs, and current search/travel/food trends. Be specific and action-oriented.\n\nCMS data:\n${JSON.stringify(trimForPrompt(content), null, 2)}`
    })
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
const airMenuSecret = process.env.AIR_MENU_SECRET || process.env.ADMIN_PASSWORD || 'red-lantern-local-air-menu';

function airMenuSignature(mode, expires) {
  return crypto.createHmac('sha256', airMenuSecret)
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

function restaurantStatus(menu, now = new Date()) {
  const localReopen = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(String(menu.reopensAt || '')) ? new Date(`${menu.reopensAt}:00+05:30`) : null;
  const closureMessage = String(menu.closureMessage || '').trim() || 'The restaurant is currently closed.';
  if (menu.restaurantClosed === true && (!localReopen || localReopen > now)) {
    const reopen = localReopen ? new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }).format(localReopen) : '';
    return { open: false, message: closureMessage, reopensAt: reopen ? `We will reopen on ${reopen}.` : 'Please check back soon for our reopening time.' };
  }
  const windows = Array.isArray(menu.serviceWindows) && menu.serviceWindows.length ? menu.serviceWindows : [{ open: '12:30', close: '15:00' }, { open: '18:30', close: '00:00' }];
  const clockParts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  const currentMinutes = Number(clockParts.hour) * 60 + Number(clockParts.minute);
  const parsed = windows.map((window) => { const open = String(window.open || ''); const close = String(window.close || ''); return { open: Number(open.slice(0, 2)) * 60 + Number(open.slice(3)), close: Number(close.slice(0, 2)) * 60 + Number(close.slice(3)) }; }).filter((window) => Number.isFinite(window.open) && Number.isFinite(window.close) && window.open !== window.close);
  if (!parsed.length || parsed.some((window) => window.open < window.close ? currentMinutes >= window.open && currentMinutes < window.close : currentMinutes >= window.open || currentMinutes < window.close)) return { open: true };
  const next = parsed.map((window) => ({ ...window, tomorrow: currentMinutes >= window.open })).sort((a, b) => Number(a.tomorrow) - Number(b.tomorrow) || a.open - b.open)[0];
  return { open: false, message: 'The restaurant is currently closed.', reopensAt: `We will open ${next.tomorrow ? 'tomorrow' : 'today'} at ${formatIndiaTime(next.open)}.` };
}

function likelyMenuCategory(line) {
  if (!line || line.length < 2 || line.length > 55 || /\d/.test(line)) return false;
  const letters = line.replace(/[^a-z]/gi, '');
  if (letters.length < 2) return false;
  const upper = line.replace(/[^A-Z]/g, '').length / letters.length;
  return upper > 0.65 || /^(starters?|soups?|salads?|mains?|desserts?|beverages?|drinks?|rice|noodles|breads?|seafood|chicken|mutton|vegetarian|non.?veg)/i.test(line);
}

function airMenuItemType(category, name) {
  return /beverage|drink|mocktail|cocktail|juice|shake|lassi|tea|coffee|beer|wine|spirit|whisky|rum|vodka|gin|water|soda/i.test(`${category} ${name}`)
    ? 'beverage'
    : 'food';
}

function inferMenuCategory(name, suppliedCategory = '') {
  const item = String(name || '').toLowerCase();
  const supplied = String(suppliedCategory || '').trim();
  const generic = !supplied || /^(menu|other|others|misc|miscellaneous|food|items?|uncategorized)$/i.test(supplied);
  if (!generic) return supplied;

  const categoryRules = [
    ['Hot Beverages', /\b(tea|coffee|espresso|cappuccino|latte|hot chocolate)\b/],
    ['Mocktails & Cold Beverages', /\b(mocktail|mojito|juice|shake|lassi|soda|soft drink|coke|sprite|fanta|water|lime|lemonade|iced tea|cold coffee)\b/],
    ['Alcoholic Beverages', /\b(beer|wine|whisky|whiskey|rum|vodka|gin|brandy|tequila|cocktail)\b/],
    ['Soups', /\b(soup|broth|shorba)\b/],
    ['Salads', /\b(salad|coleslaw)\b/],
    ['Desserts', /\b(ice cream|brownie|cake|pudding|custard|gulab|dessert|sweet|mousse|caramel|falooda|kulfi)\b/],
    ['Rice & Biryani', /\b(rice|biryani|pulao|pilaf)\b/],
    ['Noodles', /\b(noodle|chow ?mein|hakka|mein|chopsuey|chop suey)\b/],
    ['Breads', /\b(naan|roti|paratha|kulcha|bread|pav|chapati)\b/],
    ['Starters & Snacks', /\b(starter|spring roll|manchurian|kebab|kabab|tikka|lollipop|pakora|crispy|cutlet|samosa|wings|snack)\b/],
    ['Seafood', /\b(fish|prawn|shrimp|squid|calamari|crab|lobster|seafood|kingfish|pomfret|rawas)\b/],
    ['Chicken', /\b(chicken|murgh)\b/],
    ['Mutton & Lamb', /\b(mutton|lamb|goat|keema)\b/],
    ['Egg Dishes', /\b(egg|omelette|omelet)\b/],
    ['Vegetarian Mains', /\b(paneer|mushroom|baby corn|gobi|cauliflower|vegetable|veg\b|dal\b|chana|rajma|aloo|potato)\b/]
  ];
  const match = categoryRules.find(([, pattern]) => pattern.test(item));
  return match ? match[0] : 'Main Course';
}

function parseMenuText(rawText) {
  const lines = String(rawText || '').split(/\r?\n/)
    .map((line) => line.replace(/[|•·]+/g, ' ').replace(/\.{2,}/g, ' ').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const items = [];
  let category = 'Menu';
  const priceAtEnd = /^(.{2,}?)\s+(?:(₹|Rs\.?|INR)\s*)?(\d{2,5}(?:\.\d{1,2})?)\s*\/?-?$/i;

  lines.forEach((line) => {
    if (likelyMenuCategory(line)) { category = line.replace(/[:\-]+$/, '').trim(); return; }
    const match = line.match(priceAtEnd);
    if (!match) return;
    let name = match[1].replace(/^[\d.)\-\s]+/, '').replace(/\s+\d{1,2}\s*$/, '').trim();
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
    items.push({ name, price, halfPrice, fullPrice, category: resolvedCategory, type: airMenuItemType(resolvedCategory, name), description: '', dietary: dietaryFromMenuCategory(resolvedCategory), bestSeller: false, mustHave: false });
  });

  return items.filter((item, index) => !items.slice(0, index).some((prior) =>
    prior.name.toLowerCase() === item.name.toLowerCase() && prior.price === item.price && prior.category.toLowerCase() === item.category.toLowerCase()));
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
      if (quoted && source[index + 1] === '"') { field += '"'; index += 1; }
      else quoted = !quoted;
    } else if (character === ',' && !quoted) {
      row.push(field.trim()); field = '';
    } else if ((character === '\n' || character === '\r') && !quoted) {
      if (character === '\r' && source[index + 1] === '\n') index += 1;
      row.push(field.trim()); field = '';
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
  let nameIndex = findHeader(['item', 'itemname', 'name', 'dish', 'dishname', 'menuitem', 'product']);
  let priceIndex = findHeader(['price', 'rate', 'amount', 'cost', 'mrp']);
  let fullPriceIndex = findHeader(['fullprice', 'full', 'fullrate', 'pricefull']);
  let halfPriceIndex = findHeader(['halfprice', 'half', 'halfrate', 'pricehalf']);
  let withBonePriceIndex = findHeader(['withbone', 'withboneprice', 'bonein', 'boneinprice']);
  let bonelessPriceIndex = findHeader(['boneless', 'bonelessprice']);
  let categoryIndex = findHeader(['category', 'section', 'group', 'menucategory', 'course']);
  let typeIndex = findHeader(['type', 'itemtype', 'foodtype', 'kind']);
  let descriptionIndex = findHeader(['description', 'details', 'itemdescription', 'desc', 'ingredients']);
  let dietaryIndex = findHeader(['dietary', 'diet', 'vegornonveg', 'vegnonveg', 'foodpreference']);
  let bestSellerIndex = findHeader(['bestseller', 'bestselling', 'popular', 'isbestSeller']);
  let mustHaveIndex = findHeader(['musthave', 'musttry', 'recommended', 'chefchoice']);
  let gravyStyleIndex = findHeader(['gravystyleavailable', 'gravystyle', 'gravysemigravy', 'gravy', 'gravyavailable']);
  let semiGravyIndex = findHeader(['semigravy', 'semigravyavailable']);
  const hasHeaders = nameIndex >= 0 || priceIndex >= 0 || fullPriceIndex >= 0 || halfPriceIndex >= 0 || withBonePriceIndex >= 0 || bonelessPriceIndex >= 0 || categoryIndex >= 0 || typeIndex >= 0 || descriptionIndex >= 0 || dietaryIndex >= 0 || bestSellerIndex >= 0 || mustHaveIndex >= 0 || gravyStyleIndex >= 0 || semiGravyIndex >= 0;
  if (nameIndex < 0) nameIndex = 0;
  if (priceIndex < 0) priceIndex = 1;
  if (categoryIndex < 0) categoryIndex = 2;
  const dataRows = hasHeaders ? rows.slice(1) : rows;

  const items = dataRows.map((columns) => {
    const name = String(columns[nameIndex] || '').trim();
    const rawPrice = String(columns[priceIndex] || '').trim();
    const rawFullPrice = fullPriceIndex >= 0 ? String(columns[fullPriceIndex] || '').trim() : '';
    const rawHalfPrice = halfPriceIndex >= 0 ? String(columns[halfPriceIndex] || '').trim() : '';
    const rawWithBonePrice = withBonePriceIndex >= 0 ? String(columns[withBonePriceIndex] || '').trim() : '';
    const rawBonelessPrice = bonelessPriceIndex >= 0 ? String(columns[bonelessPriceIndex] || '').trim() : '';
    const suppliedCategory = String(columns[categoryIndex] || '').trim();
    const suppliedType = String(columns[typeIndex] || '').toLowerCase();
    const price = rawPrice && !/[₹$€£]|\b(?:rs|inr)\b/i.test(rawPrice) ? `₹${rawPrice}` : rawPrice.replace(/^rs\.?\s*/i, '₹');
    const formatImportedPrice = (value) => value && !/[₹$€£]|\b(?:rs|inr)\b/i.test(value) ? `₹${value}` : value.replace(/^rs\.?\s*/i, '₹');
    const resolvedCategory = inferMenuCategory(name, suppliedCategory);
    const importedDietary = dietaryIndex >= 0 && /non[\s-]?veg/i.test(String(columns[dietaryIndex] || '')) ? 'nonveg' : dietaryIndex >= 0 && /veg/i.test(String(columns[dietaryIndex] || '')) ? 'veg' : '';
    return {
      name,
      price,
      fullPrice: formatImportedPrice(rawFullPrice),
      halfPrice: formatImportedPrice(rawHalfPrice),
      withBonePrice: formatImportedPrice(rawWithBonePrice),
      bonelessPrice: formatImportedPrice(rawBonelessPrice),
      category: resolvedCategory,
      type: /beverage|drink/i.test(suppliedType) ? 'beverage' : /food/i.test(suppliedType) ? 'food' : airMenuItemType(resolvedCategory, name),
      description: descriptionIndex >= 0 ? String(columns[descriptionIndex] || '').trim() : '',
      dietary: importedDietary || dietaryFromMenuCategory(resolvedCategory),
      bestSeller: bestSellerIndex >= 0 && /^(1|true|yes|y|checked|best seller|popular)$/i.test(String(columns[bestSellerIndex] || '').trim()),
      mustHave: mustHaveIndex >= 0 && /^(1|true|yes|y|checked|must have|must try|recommended)$/i.test(String(columns[mustHaveIndex] || '').trim()),
      gravyStyleAvailable: (gravyStyleIndex >= 0 && /^(1|true|yes|y|checked|gravy|semi[-\s]?gravy)$/i.test(String(columns[gravyStyleIndex] || '').trim())) || (semiGravyIndex >= 0 && /^(1|true|yes|y|checked|semi[-\s]?gravy)$/i.test(String(columns[semiGravyIndex] || '').trim()))
    };
  }).filter((item) => item.name);

  return { items: dedupeMenuItems(items), extractionMethod: 'csv', pageCount: 0 };
}

function spreadsheetCellText(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value !== 'object') return String(value).trim();
  if (value.result !== undefined) return spreadsheetCellText(value.result);
  if (Array.isArray(value.richText)) return value.richText.map((part) => part.text || '').join('').trim();
  if (value.text !== undefined) return String(value.text).trim();
  return String(value).trim();
}

async function workbookRows(file, preferredSheetNames = []) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(file.buffer);
  const preferredNames = preferredSheetNames.map((name) => String(name).toLowerCase());
  const worksheet = workbook.worksheets.find((sheet) => preferredNames.includes(String(sheet.name).toLowerCase())) || workbook.worksheets[0];
  if (!worksheet) return [];
  const rows = [];
  worksheet.eachRow({ includeEmpty: false }, (row) => {
    const values = row.values.slice(1).map(spreadsheetCellText);
    if (values.some(Boolean)) rows.push(values);
  });
  return rows;
}

function rowsAsCsv(rows) {
  return rows.map((row) => row.map((value) => `"${String(value || '').replace(/"/g, '""')}"`).join(',')).join('\n');
}

async function extractAirMenuFromXlsx(file) {
  const extraction = extractAirMenuFromCsv({ buffer: Buffer.from(rowsAsCsv(await workbookRows(file, ['Food Menu', 'Food'])) ) });
  return { ...extraction, extractionMethod: 'xlsx' };
}

function formatImportedPrice(value) {
  const clean = String(value || '').trim();
  if (!clean) return '';
  return !/[₹$€£]|\b(?:rs|inr)\b/i.test(clean) ? `₹${clean}` : clean.replace(/^rs\.?\s*/i, '₹');
}

function extractBarMenuFromRows(rows, extractionMethod = 'csv') {
  if (!rows.length) return { items: [], extractionMethod, pageCount: 0 };
  const headers = rows[0].map((value) => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, ''));
  const findHeader = (names) => headers.findIndex((header) => names.includes(header));
  let nameIndex = findHeader(['item', 'itemname', 'name', 'drink', 'drinkname', 'brand', 'product']);
  let priceIndex = findHeader(['price', 'rate', 'amount', 'cost', 'mrp']);
  let price30Index = findHeader(['30ml', 'price30ml', '30mlprice', '30', 'smallpeg']);
  let price60Index = findHeader(['60ml', 'price60ml', '60mlprice', '60', 'largepeg']);
  let price90Index = findHeader(['90ml', 'price90ml', '90mlprice', '90']);
  let price180Index = findHeader(['180ml', 'price180ml', '180mlprice', '180', 'quarter']);
  let categoryIndex = findHeader(['category', 'section', 'group', 'barcategory', 'kind']);
  let typeIndex = findHeader(['type', 'itemtype', 'drinktype']);
  let descriptionIndex = findHeader(['description', 'details', 'desc', 'notes']);
  let bestSellerIndex = findHeader(['bestseller', 'bestselling', 'popular', 'recommended']);
  const hasHeaders = [nameIndex, priceIndex, price30Index, price60Index, price90Index, price180Index, categoryIndex, typeIndex, descriptionIndex, bestSellerIndex].some((index) => index >= 0);
  if (nameIndex < 0) nameIndex = 0;
  if (priceIndex < 0) priceIndex = 1;
  if (price30Index < 0) price30Index = 2;
  if (price60Index < 0) price60Index = 3;
  if (categoryIndex < 0) categoryIndex = 4;
  if (typeIndex < 0) typeIndex = 5;
  if (descriptionIndex < 0) descriptionIndex = 6;
  if (bestSellerIndex < 0) bestSellerIndex = 7;
  const dataRows = hasHeaders ? rows.slice(1) : rows;
  const items = dataRows.map((columns) => {
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
      bestSeller: /^(1|true|yes|y|checked|best seller|popular|recommended)$/i.test(String(columns[bestSellerIndex] || '').trim()),
      mustHave: false,
      isBar: true
    };
  }).filter((item) => item.name);
  return { items: dedupeMenuItems(items), extractionMethod, pageCount: 0 };
}

function barCategoryHeading(line) {
  const clean = String(line || '').replace(/[:\-]+$/, '').trim();
  if (!clean || clean.length > 60 || /\d/.test(clean)) return '';
  const known = /\b(whisk(?:y|ey)|scotch|bourbon|rum|vodka|gin|brandy|cognac|tequila|liqueur|spirits?|feni|beer|wine|champagne|sparkling|cocktails?|mocktails?|shooters?|aperitifs?|bar menu|bar bites?|bar snacks?|draught|bottled|imported|domestic|beverages?)\b/i.test(clean);
  return known ? clean : '';
}

function isFoodOnlyHeading(line) {
  const clean = String(line || '').trim();
  return likelyMenuCategory(clean) && /\b(starters?|soups?|salads?|main course|biryani|rice|noodles|breads?|seafood|chicken|mutton|vegetarian|non.?veg|desserts?)\b/i.test(clean);
}

function isAlcoholMenuItem(item = {}) {
  return /\b(bar menu|alcohol|spirits?|feni|beer|wine|whisk(?:y|ey)|scotch|bourbon|rum|vodka|gin|brandy|cognac|liqueur|tequila|cocktail|champagne)\b/i.test(`${item.category || ''} ${item.name || ''}`);
}

function parseBarMenuText(rawText) {
  const lines = String(rawText || '').split(/\r?\n/)
    .map((line) => line.replace(/[|•·]+/g, ' ').replace(/\.{2,}/g, ' ').replace(/\s+/g, ' ').trim())
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
    if (heading) { category = heading; acceptingBarRows = true; return; }
    if (isFoodOnlyHeading(originalLine)) { acceptingBarRows = false; return; }
    if (!acceptingBarRows) return;
    if (/\b(item name|description|category|best seller|menu|page|phone|contact|gst|tax)\b/i.test(originalLine) && !/\d{2,5}/.test(originalLine)) return;

    const numberMatches = [...originalLine.matchAll(/(?:₹|Rs\.?|INR)?\s*(\d{2,5}(?:\.\d{1,2})?)/gi)]
      .filter((match) => !/^\s*ml\b/i.test(originalLine.slice((match.index || 0) + match[0].length)))
      .filter((match) => {
        const remainder = originalLine.slice(match.index || 0);
        return !/[a-z]/i.test(remainder.replace(/(?:₹|Rs\.?|INR|ml|peg)/gi, ''));
      });
    if (!numberMatches.length) return;

    const firstPriceIndex = numberMatches[0].index || 0;
    const bestSeller = /\b(best\s*seller|popular|recommended)\b|★|⭐/i.test(originalLine);
    const name = originalLine.slice(0, firstPriceIndex)
      .replace(/\b(best\s*seller|popular|recommended)\b|[★⭐*]+/gi, '')
      .replace(/[.\-–—:\s]+$/, '').replace(/^[\d.)\-\s]+/, '').trim();
    if (name.length < 2 || /^(total|subtotal|price|rate|amount|30\s*ml|60\s*ml|90\s*ml|180\s*ml)$/i.test(name)) return;
    const values = numberMatches.map((match) => formatImportedPrice(match[1]));
    const prices = { price: '', price30ml: '', price60ml: '', price90ml: '', price180ml: '' };
    if (activeSizes.length) {
      values.slice(0, activeSizes.length).forEach((value, index) => { prices[`price${activeSizes[index]}ml`] = value; });
      if (values.length > activeSizes.length) prices.price = values[values.length - 1];
    } else if (values.length === 1) {
      prices.price = values[0];
    } else {
      values.slice(0, 4).forEach((value, index) => { prices[`price${validSizes[index]}ml`] = value; });
    }
    const foodType = /\b(snack|starter|fries|peanut|masala|chicken|fish|prawn|paneer|kebab|tikka|salad)\b/i.test(`${category} ${name}`);
    items.push({
      name, ...prices, category, type: foodType ? 'food' : 'beverage', description: '', dietary: '',
      bestSeller, mustHave: false, isBar: true
    });
  });
  return dedupeMenuItems(items);
}

async function extractBarMenu(file) {
  const extension = path.extname(file.originalname).toLowerCase();
  if (extension === '.csv') return extractBarMenuFromRows(parseCsvRows(file.buffer.toString('utf8')), 'csv');
  if (extension === '.xlsx') return extractBarMenuFromRows(await workbookRows(file, ['Bar Menu', 'Bar']), 'xlsx');
  const pdfExtraction = await extractAirMenuFromPdf(file);
  const parsedBarItems = parseBarMenuText(pdfExtraction.rawText || '');
  return {
    ...pdfExtraction,
    items: parsedBarItems.length ? parsedBarItems : pdfExtraction.items
      .filter((item) => item.type === 'beverage' || airMenuItemType(item.category, item.name) === 'beverage' || isAlcoholMenuItem(item))
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
      isBar: true
    })),
    extractionMethod: pdfExtraction.extractionMethod
  };
}

async function extractAirMenuFromPdf(file) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const { createCanvas } = require('@napi-rs/canvas');
  const standardFontDataUrl = `${pathToFileURL(path.join(__dirname, 'node_modules/pdfjs-dist/standard_fonts')).href}/`;
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(file.buffer), disableWorker: true, standardFontDataUrl }).promise;
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
      if (!row) { row = { y, items: [] }; rows.push(row); }
      row.items.push({ x, text: item.str || '' });
    });
    const pageText = rows.sort((a, b) => b.y - a.y)
      .map((row) => row.items.sort((a, b) => a.x - b.x).map((item) => item.text).join(' ').replace(/\s+/g, ' ').trim())
      .filter(Boolean).join('\n');
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
      logger: () => {}
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

app.get('/scan/:mode', async (req, res) => {
  const mode = req.params.mode;
  if (!['table', 'card'].includes(mode)) return res.redirect(302, '/menu');
  try {
    const menu = await getSection('airMenu');
    if ((mode === 'table' && menu.tableLive === false) || (mode === 'card' && menu.cardLive === false)) {
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
      details: scanDetails
    });
    const expires = Date.now() + airMenuLifetimeMs;
    const signature = airMenuSignature(mode, expires);
    res.set('Cache-Control', 'no-store');
    return res.redirect(302, `/air-menu?mode=${mode}&expires=${expires}&signature=${encodeURIComponent(signature)}`);
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
    return res.status(410).json({ expired: true, redirect: 'https://www.redlanternrestaurant.in/menu' });
  }
  const menu = await getSection('airMenu');
  const dishes = [
    ...(Array.isArray(menu.items) ? menu.items : []),
    ...(Array.isArray(menu.barItems) ? menu.barItems.map((item) => ({ ...item, isBar: true })) : [])
  ];
  const isCard = req.query.mode === 'card';
  const isLive = isCard ? menu.cardLive !== false : menu.tableLive !== false;
  if (!isLive) return res.status(410).json({ unavailable: true, redirect: 'https://www.redlanternrestaurant.in/menu' });
  const operatingStatus = restaurantStatus(menu);
  if (!operatingStatus.open) return res.json({ closed: true, pageTitle: menu.pageTitle || 'Our Menu', pageSubtitle: menu.pageSubtitle || '', note: menu.note || '', message: operatingStatus.message, reopensAt: operatingStatus.reopensAt, mode: req.query.mode, expires: Number(req.query.expires), dishes: [] });
  const visibility = menu.categoryVisibility && typeof menu.categoryVisibility === 'object' ? menu.categoryVisibility : {};
  let unavailable = new Set();
  try { await ensureMenuAvailabilityTable(); const rows = await sql`SELECT item_key FROM menu_availability WHERE unavailable_until > NOW()`; unavailable = new Set(rows.map((row) => row.item_key)); } catch (error) { console.warn('Menu availability lookup failed:', error.message); }
  const visibleDishes = dishes.filter((dish) => {
    const itemKey = `${String(dish.category || '').toLowerCase()}::${String(dish.name || '').toLowerCase()}`;
    if (unavailable.has(itemKey)) return false;
    const setting = visibility[dish.category];
    if (setting && setting[isCard ? 'card' : 'table'] === false) return false;
    if (isCard && !setting && (dish.isBar || /\b(bar menu|alcohol|spirits?|feni|beer|wine|whisky|whiskey|scotch|bourbon|rum|vodka|gin|brandy|cognac|liqueur|tequila|cocktail)\b/i.test(dish.category || ''))) return false;
    return true;
  });
  res.set('Cache-Control', 'no-store');
  res.json({
    pageTitle: menu.pageTitle || 'Our Menu',
    pageSubtitle: menu.pageSubtitle || '',
    note: menu.note || '',
    showPrices: isCard ? menu.showCardPrices === true : menu.showTablePrices !== false,
    directOrdersEnabled: isCard ? menu.cardDirectOrders !== false : menu.tableDirectOrders === true,
    cardCallEnabled: isCard && menu.cardCallEnabled === true,
    cardOrderPhone: isCard ? String(menu.cardOrderPhone || '') : '',
    mode: req.query.mode,
    expires: Number(req.query.expires),
    dishes: visibleDishes
  });
});

app.post('/api/direct-orders', async (req, res) => {
  try {
    const { mode, expires, signature, customerPhone, customerName, specialRequest, items = [] } = req.body || {};
    if (!validAirMenuAccess(mode, expires, signature)) return res.status(410).json({ error: 'This QR session has expired. Please scan again.' });
    const menu = await getSection('airMenu');
    const enabled = mode === 'card' ? menu.cardDirectOrders !== false : menu.tableDirectOrders === true;
    if (!enabled) return res.status(403).json({ error: 'Direct ordering is unavailable for this QR menu.' });
    const operatingStatus = restaurantStatus(menu);
    if (!operatingStatus.open) return res.status(423).json({ error: `${operatingStatus.message} ${operatingStatus.reopensAt}`.trim() });
    const phone = String(customerPhone || '').replace(/\D/g, '');
    if (phone.length < 7) return res.status(400).json({ error: 'Enter a valid mobile number.' });
    const priceNumber = (value) => Number(String(value || '').replace(/[^0-9.]/g, '')) || 0;
    const displayItemName = (value) => String(value || '').replace(/[.…·]{2,}/g, ' ').replace(/\s+\d{2,5}(?:\.\d{1,2})?\s*\/?\s*$/, '').replace(/\s+/g, ' ').trim();
    const menuItems = [...(Array.isArray(menu.items) ? menu.items : []), ...(Array.isArray(menu.barItems) ? menu.barItems : [])];
    const portionPrice = (item, portion) => {
      const key = String(portion || '').trim().toLowerCase();
      const prices = { half: item.halfPrice, full: item.fullPrice, 'with bone': item.withBonePrice, boneless: item.bonelessPrice, '30 ml': item.price30ml, '60 ml': item.price60ml, '90 ml': item.price90ml, '180 ml': item.price180ml };
      return prices[key] || item.price || '';
    };
    const submittedItems = Array.isArray(items) ? items.filter((item) => Number(item.quantity) > 0).slice(0, 30) : [];
    const cleanItems = submittedItems.map((item) => {
      const name = String(item.name || '').trim().slice(0, 100);
      const category = String(item.category || '').trim().slice(0, 80);
      const source = menuItems.find((dish) => displayItemName(dish.name).toLowerCase() === name.toLowerCase() && String(dish.category || '').trim().toLowerCase() === category.toLowerCase());
      if (!source) return null;
      const style = /^(gravy|semi-gravy)$/i.test(String(item.style || '').trim()) && (source.gravyStyleAvailable || source.gravyAvailable || source.semiGravyAvailable) ? String(item.style).trim() : '';
      const price = portionPrice(source, item.portion);
      if (!priceNumber(price)) return null;
      return { name: displayItemName(source.name).slice(0, 100), category: String(source.category || '').slice(0, 80), portion: String(item.portion || '').slice(0, 40), style, quantity: Math.min(20, Number(item.quantity) || 0), price: `₹${priceNumber(price)}`, availabilityKey: `${String(source.category || '').toLowerCase()}::${String(source.name || '').toLowerCase()}` };
    }).filter(Boolean);
    if (!cleanItems.length || cleanItems.length !== submittedItems.length || cleanItems.some((item) => !item.name)) return res.status(400).json({ error: 'One or more selected items are no longer available. Refresh the menu and try again.' });
    await ensureDirectOrdersTable();
    await ensureMenuAvailabilityTable();
    const unavailableRows = await sql`SELECT item_key FROM menu_availability WHERE unavailable_until > NOW()`;
    const unavailableKeys = new Set(unavailableRows.map((row) => row.item_key));
    if (cleanItems.some((item) => unavailableKeys.has(item.availabilityKey))) return res.status(409).json({ error: 'One or more selected items have just gone out of stock. Please refresh the menu.' });
    const { orderDay, number: dailyOrderNumber } = await nextDailyOrderNumber();
    const id = `RL${Date.now().toString(36).toUpperCase()}${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
    const total = cleanItems.reduce((sum, item) => sum + item.quantity * (priceNumber(item.price) + (item.style ? 10 : 0)), 0);
    const savedItems = cleanItems.map(({ availabilityKey, ...item }) => item);
    await sql`INSERT INTO direct_orders (id, mode, customer_name, customer_phone, special_request, items, total, order_day, daily_order_number) VALUES (${id}, ${mode}, ${String(customerName || '').trim().slice(0, 80)}, ${phone}, ${String(specialRequest || '').trim().slice(0, 240)}, ${JSON.stringify(savedItems)}, ${total}, ${orderDay}::date, ${dailyOrderNumber})`;
    // The order is already safely stored. Push delivery must never delay or block it.
    void notifyDirectOrder({ id, dailyOrderNumber, total, itemCount: savedItems.reduce((count, item) => count + Number(item.quantity || 0), 0) });
    res.json({ id, status: 'new' });
  } catch (error) { res.status(500).json({ error: 'Unable to place the order. Please call us instead.' }); }
});

app.get('/api/orders', async (req, res) => { try { await ensureDirectOrdersTable(); const search=String(req.query.search||'').replace(/\D/g,'').slice(0,16); const like=`%${search}%`; const today=kolkataOrderDay(); const history=req.query.history==='1'; const requestedDay=/^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date||''))?String(req.query.date):today; const selectedDay=history?requestedDay:today; res.set({ 'Cache-Control':'no-store', 'X-Orders-Day': today, 'X-Orders-View': history?'history':'current' }); res.json(await sql`SELECT o.*, (SELECT COUNT(*) FROM direct_orders h WHERE h.customer_phone=o.customer_phone) AS customer_order_count, (SELECT MAX(h.created_at) FROM direct_orders h WHERE h.customer_phone=o.customer_phone AND h.id<>o.id) AS customer_last_order_at FROM direct_orders o WHERE o.order_day=${selectedDay}::date AND (${search}='' OR o.customer_phone LIKE ${like} OR CAST(o.daily_order_number AS TEXT) LIKE ${like}) ORDER BY o.created_at DESC LIMIT 100`); } catch (error) { res.status(500).json({ error: error.message }); } });
app.get('/api/orders/push-key', (req, res) => { if (!pushEnabled) return res.status(503).json({ error: 'Push notifications have not been configured yet.' }); res.set('Cache-Control', 'no-store'); res.json({ publicKey: process.env.VAPID_PUBLIC_KEY }); });
app.post('/api/orders/push-subscriptions', async (req, res) => { try { if (!pushEnabled) return res.status(503).json({ error: 'Push notifications have not been configured yet.' }); const subscription = req.body?.subscription; if (!subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) return res.status(400).json({ error: 'Invalid push subscription.' }); await ensurePushSubscriptionsTable(); await sql`INSERT INTO order_push_subscriptions (endpoint, subscription) VALUES (${String(subscription.endpoint)}, ${JSON.stringify(subscription)}) ON CONFLICT (endpoint) DO UPDATE SET subscription=EXCLUDED.subscription, updated_at=NOW()`; res.json({ ok: true }); } catch (error) { res.status(500).json({ error: 'Unable to save push subscription.' }); } });
app.patch('/api/orders/:id', async (req, res) => { try { await ensureDirectOrdersTable(); const status = ['new','accepted','preparing','ready','completed','rejected'].includes(req.body.status) ? req.body.status : 'new'; await sql`UPDATE direct_orders SET status=${status}, updated_at=NOW() WHERE id=${req.params.id}`; res.json({ ok:true }); } catch (error) { res.status(500).json({ error:error.message }); } });
app.get('/api/orders/availability', async (req,res)=>{try{await ensureMenuAvailabilityTable();res.json(await sql`SELECT * FROM menu_availability WHERE unavailable_until > NOW()`)}catch(e){res.status(500).json({error:e.message})}});
app.get('/api/orders/menu', async (req,res)=>{try{const menu=await getSection('airMenu');const format=(items,menuType)=>items.map(item=>({name:item.name,category:item.category,menuType,key:`${String(item.category||'').toLowerCase()}::${String(item.name||'').toLowerCase()}`})).filter(item=>item.name);res.json([...format(menu.items||[],'food'),...format(menu.barItems||[],'bar')])}catch(e){res.status(500).json({error:e.message})}});
app.put('/api/orders/availability/:key', async (req,res)=>{try{await ensureMenuAvailabilityTable();const until=new Date(req.body.unavailableUntil);if(Number.isNaN(+until)||until<=new Date())return res.status(400).json({error:'Choose a future restock time.'});const menu=await getSection('airMenu');const menuKeys=new Set([...(menu.items||[]),...(menu.barItems||[])].map(item=>`${String(item.category||'').toLowerCase()}::${String(item.name||'').toLowerCase()}`));if(!menuKeys.has(req.params.key))return res.status(404).json({error:'That menu item no longer exists.'});await sql`INSERT INTO menu_availability (item_key,unavailable_until) VALUES (${req.params.key},${until.toISOString()}) ON CONFLICT (item_key) DO UPDATE SET unavailable_until=EXCLUDED.unavailable_until`;res.json({ok:true})}catch(e){res.status(500).json({error:e.message})}});
app.delete('/api/orders/availability/:key', async (req,res)=>{try{await ensureMenuAvailabilityTable();await sql`DELETE FROM menu_availability WHERE item_key=${req.params.key}`;res.json({ok:true})}catch(e){res.status(500).json({error:e.message})}});

app.get('/api/admin/air-menu/export', async (req, res) => {
  try {
    const workbook = await createAirMenuExport(await getSection('airMenu'));
    const fileDate = new Date().toISOString().slice(0, 10);
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="red-lantern-air-menu-${fileDate}.xlsx"`,
      'Cache-Control': 'no-store'
    });
    await workbook.xlsx.write(res);
    res.end();
  } catch (error) {
    logDiagnostic({
      level: 'error', category: 'cms-save', message: `Air Menu export failed: ${error.message}`,
      method: req.method, path: req.path, statusCode: 500, ipHash: hashIp(req), userAgent: req.headers['user-agent'] || ''
    });
    res.status(500).json({ error: 'Unable to export the Air Menu workbook.' });
  }
});

app.post('/api/admin/air-menu/extract', menuFileUpload.single('menuFile'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Choose a menu PDF, CSV, or XLSX file first.' });
    const extension = path.extname(req.file.originalname).toLowerCase();
    const extraction = extension === '.csv' ? extractAirMenuFromCsv(req.file)
      : extension === '.xlsx' ? await extractAirMenuFromXlsx(req.file)
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
      warning: separatedItems.length ? (skippedBarItems ? `${skippedBarItems} bar item${skippedBarItems === 1 ? ' was' : 's were'} skipped. Import those through the separate Bar Menu section.` : '') : extension === '.csv'
        ? 'No menu rows were found. Check that the CSV contains item/name and price columns.'
        : 'OCR found text, but no item/price pairs were recognised. Add items manually or try a clearer PDF.'
    });
  } catch (error) {
    logDiagnostic({
      level: 'error', category: 'cms-save', message: `Air Menu PDF extraction failed: ${error.message}`,
      method: req.method, path: req.path, statusCode: error.statusCode || 500,
      ipHash: hashIp(req), userAgent: req.headers['user-agent'] || ''
    });
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

app.post('/api/admin/air-menu/extract-bar', menuFileUpload.single('menuFile'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Choose a Bar Menu PDF, CSV, or XLSX file first.' });
    const extraction = await extractBarMenu(req.file);
    res.set('Cache-Control', 'no-store');
    res.json({
      fileName: req.file.originalname,
      itemCount: extraction.items.length,
      items: extraction.items,
      extractionMethod: extraction.extractionMethod,
      pageCount: extraction.pageCount || 0,
      warning: extraction.items.length ? '' : 'No bar-menu rows were recognised. Check the file headings or try a clearer PDF.'
    });
  } catch (error) {
    logDiagnostic({
      level: 'error', category: 'cms-save', message: `Bar Menu extraction failed: ${error.message}`,
      method: req.method, path: req.path, statusCode: error.statusCode || 500,
      ipHash: hashIp(req), userAgent: req.headers['user-agent'] || ''
    });
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

app.post('/api/admin/air-menu/dietary', async (req, res) => {
  try {
    const name = String(req.body.name || '').trim();
    const category = String(req.body.category || '').trim();
    const dietary = req.body.dietary === 'nonveg' ? 'nonveg' : req.body.dietary === 'veg' ? 'veg' : '';
    if (!name) return res.status(400).json({ error: 'Item name is required.' });
    const menu = await getSection('airMenu');
    let updated = false;
    const targetKey = menuItemKey({ name, category });
    menu.items = (menu.items || []).map((item) => {
      if (menuItemKey(item) !== targetKey) return item;
      updated = true;
      return { ...item, dietary };
    });
    if (!updated) return res.status(404).json({ error: 'Publish the Air Menu once before using instant dietary updates.' });
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
    if (!updated) return res.status(404).json({ error: 'Publish the Air Menu once before changing this setting.' });
    await saveSection('airMenu', menu);
    clearPublicContentCache();
    res.json({ saved: true, gravyStyleAvailable });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/admin/qr/:mode', async (req, res) => {
  const mode = req.params.mode;
  if (!['table', 'card'].includes(mode)) return res.status(404).end();
  try {
    const permanentQrBaseUrl = String(process.env.AIR_MENU_QR_BASE_URL || 'https://www.redlanternrestaurant.in').replace(/\/$/, '');
    const target = `${permanentQrBaseUrl}/scan/${mode}`;
    const qrSvg = await QRCode.toString(target, {
      type: 'svg',
      errorCorrectionLevel: 'H',
      margin: 2,
      color: { dark: '#17120f', light: '#ffffff' },
      width: 720
    });
    const centerLabel = [
      '<g aria-label="Scan for Menu">',
      '<rect x="17.25" y="17.25" width="10.5" height="10.5" rx="1.2" fill="#ffffff" stroke="#dc2626" stroke-width="0.45"/>',
      '<text x="22.5" y="20.8" text-anchor="middle" fill="#111827" font-family="Arial, Helvetica, sans-serif" font-size="2.15" font-weight="800" letter-spacing="0.12">SCAN</text>',
      '<text x="22.5" y="23.1" text-anchor="middle" fill="#dc2626" font-family="Arial, Helvetica, sans-serif" font-size="1.35" font-weight="800" letter-spacing="0.08">FOR</text>',
      '<text x="22.5" y="25.85" text-anchor="middle" fill="#111827" font-family="Arial, Helvetica, sans-serif" font-size="2.15" font-weight="800" letter-spacing="0.08">MENU</text>',
      '</g>'
    ].join('');
    const svg = qrSvg.replace('</svg>', `${centerLabel}</svg>`);
    res.set({
      'Content-Type': 'image/svg+xml; charset=utf-8',
      'Content-Disposition': `inline; filename="red-lantern-${mode}-menu-qr.svg"`,
      'Cache-Control': 'no-store'
    });
    res.send(svg);
  } catch (error) {
    res.status(500).send('Unable to generate QR code.');
  }
});

cleanPageRoutes.forEach((file, route) => {
  app.get(route, (req, res) => {
    if (route === '/orders') res.set('Cache-Control', 'no-store, max-age=0');
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
  const description = escapeHtmlAttribute(post.seoDescription || post.excerpt || global.seoDescription || 'Read food guides and restaurant stories from Red Lantern Restaurant in Colva, Goa.');
  const image = escapeHtmlAttribute(post.image || global.ogImage || '/images/red-lantern-logo-600.webp');

  return html
    .replace(/<title>[\s\S]*?<\/title>/i, `<title>${title}</title>`)
    .replace(/<meta name="description" content="[^"]*"\s*\/?>/i, `<meta name="description" content="${description}" />`)
    .replace('</head>', `    <meta property="og:title" content="${title}" />\n    <meta property="og:description" content="${description}" />\n    <meta property="og:image" content="${image}" />\n    <meta name="twitter:title" content="${title}" />\n    <meta name="twitter:description" content="${description}" />\n    <meta name="twitter:image" content="${image}" />\n  </head>`);
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
      details: { stack: error.stack }
    });
    res.status(500).json({ error: error.message });
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
      details: { stack: error.stack }
    });
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/admin/google-reviews/sync', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    const googleReviews = await fetchFiveStarGoogleReviews();
    const home = await getSection('home');
    const existingReviews = Array.isArray(home.reviews) ? home.reviews : [];
    const existingKeys = new Set(existingReviews.map((review) => review.googleReviewName || `${cleanDescriptionText(review.name)}:${cleanDescriptionText(review.text).slice(0, 120)}`));
    const importedCount = googleReviews.filter((review) => !existingKeys.has(review.googleReviewName || `${cleanDescriptionText(review.name)}:${cleanDescriptionText(review.text).slice(0, 120)}`)).length;
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
        totalFiveStar: reviews.length
      }
    });

    res.json({
      importedCount,
      totalFiveStar: reviews.length,
      reviews
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
      details: { stack: error.stack }
    });
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

app.get('/api/admin/qr-scans', async (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    if (!sql) return res.status(503).json({ error: 'Neon is not configured, so QR scan logs cannot be stored.' });
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
      `
    ]);
    res.json({ scans: rows, summary: summaryRows[0] || {} });
  } catch (error) {
    console.error('QR scan logs read error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/admin/qr-scans', async (req, res) => {
  try {
    if (!sql) return res.status(503).json({ error: 'Neon is not configured, so QR scan logs cannot be cleared.' });
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
    if (!sql) return res.status(503).json({ error: 'Neon is not configured, so diagnostics logs cannot be stored.' });
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
    if (!sql) return res.status(503).json({ error: 'Neon is not configured, so diagnostics logs cannot be cleared.' });
    await ensureDiagnosticsTable();
    await sql`DELETE FROM website_diagnostics`;
    await writeDiagnostic({
      level: 'info',
      category: 'admin',
      message: 'Diagnostics log was cleared from the admin dashboard.',
      method: req.method,
      path: req.path,
      ipHash: hashIp(req),
      userAgent: req.headers['user-agent'] || ''
    });
    res.json({ ok: true });
  } catch (error) {
    console.error('Diagnostics clear error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/admin/health', async (req, res) => {
  const checks = {
    server: { ok: true, message: 'Server function responded.' },
    database: { ok: false, message: 'Not checked.' },
    cloudinary: { ok: false, message: 'Not checked.' },
    environment: { ok: false, message: 'Not checked.' }
  };

  try {
    if (!sql) {
      checks.database.message = 'NEON_DATABASE_URL is missing or invalid.';
    } else {
      await sql`SELECT 1`;
      checks.database = { ok: true, message: 'Neon database responded.' };
    }

    const cloudinaryConfig = cloudinary.config();
    checks.cloudinary = cloudinaryConfig.cloud_name && cloudinaryConfig.api_key
      ? { ok: true, message: 'Cloudinary credentials are configured.' }
      : { ok: false, message: 'Cloudinary credentials are missing. Image uploads may fail.' };

    checks.environment = process.env.ADMIN_USERNAME && process.env.ADMIN_PASSWORD
      ? { ok: true, message: 'Admin credentials are configured.' }
      : { ok: false, message: 'ADMIN_USERNAME or ADMIN_PASSWORD is missing.' };

    const ok = Object.values(checks).every((check) => check.ok);
    res.status(ok ? 200 : 503).json({
      ok,
      checkedAt: new Date().toISOString(),
      checks
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
      details: { stack: error.stack }
    });
    res.status(500).json({
      ok: false,
      checkedAt: new Date().toISOString(),
      checks,
      error: error.message
    });
  }
});

app.post('/api/client-log', async (req, res) => {
  try {
    const body = req.body || {};
    const category = body.category === 'performance' ? 'performance' : 'frontend';
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
        timings: body.timings || {}
      }
    });
    res.status(204).end();
  } catch (error) {
    console.error('Client log error:', error);
    res.status(204).end();
  }
});

app.get('/api/content/:section', async (req, res) => {
  if (!collections[req.params.section] || req.params.section === 'airMenu') return res.status(404).json({ error: 'Unknown content section.' });

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
      details: { stack: error.stack }
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
      details: { stack: error.stack }
    });
    res.status(500).json({ error: error.message });
  }
});

const xmlEscape = (value) => String(value || '')
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
  const configured = String(global.siteUrl || '').trim().replace(/\/$/, '');
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
      title: `${dish.name} at Red Lantern Restaurant in Colva`
    }));
  const urls = [
    { loc: `${siteUrl}/home`, priority: '1.0', changefreq: 'weekly', images: [global.ogImage ? { loc: absoluteSiteUrl(global.ogImage, siteUrl), title: 'Red Lantern Restaurant in Colva Goa' } : null].filter(Boolean) },
    { loc: `${siteUrl}/menu`, priority: '0.9', changefreq: 'weekly', images: menuImages },
    { loc: `${siteUrl}/contact`, priority: '0.8', changefreq: 'monthly' },
    { loc: `${siteUrl}/about`, priority: '0.7', changefreq: 'monthly' },
    { loc: `${siteUrl}/blogs`, priority: '0.7', changefreq: 'weekly' }
  ];
  (blogs.posts || []).forEach((post) => {
    urls.push({
      loc: `${siteUrl}/blog/${encodeURIComponent(post.slug)}`,
      priority: '0.6',
      changefreq: 'monthly',
      images: post.image ? [{ loc: absoluteSiteUrl(post.image, siteUrl), title: post.title }] : []
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
      plan
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
      details: { stack: error.stack }
    });
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

Object.keys(collections).forEach((section) => {
  app.post(`/api/update-${section}`, upload.any(), async (req, res) => {
    try {
      if (req.files && req.files.length > 0) {
        if (!process.env.CLOUDINARY_URL && !process.env.CLOUDINARY_API_KEY) {
           console.warn("Missing CLOUDINARY_URL, images will not be uploaded to cloud.");
           throw new Error('Cloudinary is not configured. Add credentials to your .env file.');
        }
        const cConfig = cloudinary.config();
        if (!cConfig.api_key) {
           throw new Error(`Cloudinary API Key is missing! Found Cloud Name: ${cConfig.cloud_name ? 'Yes' : 'No'}.`);
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
                    fetch_format: 'webp'
                  }
                ],
                api_key: cConfig.api_key,
                api_secret: cConfig.api_secret,
                cloud_name: cConfig.cloud_name
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
      await saveSection(section, normalizeSection(section, req.body, req.files || []));
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
          uploadedFiles: (req.files || []).length
        }
      });
      res.send(`<h2>Success!</h2><p>${labels[section]} changes saved to Neon.</p><a href="/admin">Go Back to Dashboard</a>`);
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
          stack: error.stack
        }
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
    details: { stack: error.stack }
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
