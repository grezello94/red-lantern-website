'use strict';

// These limits bound work in one Node process. They are not a promise about
// user capacity: a user can issue several requests and each write can use
// multiple database calls. Keep reads and large imports from crowding out
// order/payment writes, while retaining a common ceiling.
const DEFAULT_LIMITS = Object.freeze({
  total: 64,
  read: 48,
  mutation: 24,
  heavy: 2,
  stream: 128,
});

const STREAM_PATHS = new Set(['/api/admin/analytics/stream', '/api/orders/smart-kds/stream']);
const HEALTH_PATHS = new Set(['/api/healthz', '/api/readyz']);
const HEAVY_PATHS = new Set([
  '/api/admin/air-menu/extract',
  '/api/admin/air-menu/extract-bar',
  '/api/admin/trusted-contacts/import',
  '/api/growth-ai',
  '/api/admin/google-reviews/sync',
]);

function positiveInteger(value, fallback, maximum = 4096) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= maximum ? parsed : fallback;
}

function requestPath(req) {
  let pathname = String(req.path || req.url || '').split('?')[0];
  try {
    pathname = decodeURIComponent(pathname);
  } catch (_) {
    /* Invalid URL is rejected elsewhere. */
  }
  return pathname.toLowerCase().replace(/\/+$/, '') || '/';
}

function classifyRequest(req) {
  const pathname = requestPath(req);
  if (HEALTH_PATHS.has(pathname) || !pathname.startsWith('/api/')) return null;
  const method = String(req.method || 'GET').toUpperCase();
  if ((method === 'GET' || method === 'HEAD') && STREAM_PATHS.has(pathname)) return 'stream';
  if (
    !['GET', 'HEAD', 'OPTIONS'].includes(method) &&
    (HEAVY_PATHS.has(pathname) || pathname.startsWith('/api/update-'))
  )
    return 'heavy';
  return ['GET', 'HEAD', 'OPTIONS'].includes(method) ? 'read' : 'mutation';
}

function sendBusy(res, draining, retryAfterSeconds) {
  res.set('Retry-After', String(retryAfterSeconds));
  res.set('Cache-Control', 'private, no-store');
  res.status(503).json({
    error: draining
      ? 'The service is restarting. Please retry in a moment.'
      : 'The system is busy. Please retry in a moment.',
    code: draining ? 'server_restarting' : 'server_busy',
    retryAfterSeconds,
  });
}

function createLoadControl(options = {}) {
  const env = options.env || process.env;
  const total = positiveInteger(
    options.maxTotal ?? env.SERVER_MAX_API_REQUESTS,
    DEFAULT_LIMITS.total
  );
  const limits = {
    total,
    read: Math.min(
      total,
      positiveInteger(options.maxReads ?? env.SERVER_MAX_READ_REQUESTS, DEFAULT_LIMITS.read)
    ),
    mutation: Math.min(
      total,
      positiveInteger(
        options.maxMutations ?? env.SERVER_MAX_MUTATION_REQUESTS,
        DEFAULT_LIMITS.mutation
      )
    ),
    heavy: Math.min(
      total,
      positiveInteger(options.maxHeavy ?? env.SERVER_MAX_HEAVY_REQUESTS, DEFAULT_LIMITS.heavy)
    ),
    stream: positiveInteger(
      options.maxStreams ?? env.SERVER_MAX_STREAM_CLIENTS,
      DEFAULT_LIMITS.stream
    ),
  };
  const retryAfterSeconds = positiveInteger(
    options.retryAfterSeconds ?? env.SERVER_BUSY_RETRY_SECONDS,
    2,
    60
  );
  const active = { total: 0, read: 0, mutation: 0, heavy: 0, stream: 0 };
  const rejected = { read: 0, mutation: 0, heavy: 0, stream: 0, draining: 0 };
  const peak = { ...active };
  const idleWaiters = new Set();
  let draining = false;
  let completed = 0;

  function notifyIdle() {
    if (active.total || active.stream) return;
    for (const waiter of [...idleWaiters]) waiter(true);
  }

  function reject(lane, res) {
    rejected[lane] += 1;
    if (draining) rejected.draining += 1;
    sendBusy(res, draining, retryAfterSeconds);
  }

  function middleware(req, res, next) {
    const lane = classifyRequest(req);
    // SSE is admitted separately before its response headers are flushed.
    if (!lane || lane === 'stream') return next();
    if (draining || active.total >= limits.total || active[lane] >= limits[lane]) {
      reject(lane, res);
      return;
    }
    active.total += 1;
    active[lane] += 1;
    peak.total = Math.max(peak.total, active.total);
    peak[lane] = Math.max(peak[lane], active[lane]);
    let handlers = 0;
    let responseComplete = false;
    let released = false;

    function releaseIfComplete() {
      if (released || !responseComplete || handlers) return;
      released = true;
      active.total -= 1;
      active[lane] -= 1;
      completed += 1;
      res.removeListener('finish', finish);
      res.removeListener('close', finish);
      res.removeListener('error', finish);
      notifyIdle();
    }

    function finish() {
      responseComplete = true;
      releaseIfComplete();
    }

    function beginHandler() {
      if (released) return () => {};
      handlers += 1;
      let done = false;
      return () => {
        if (done) return;
        done = true;
        handlers -= 1;
        releaseIfComplete();
      };
    }

    req.loadControl = {
      lane,
      beginHandler,
      async track(work) {
        const done = beginHandler();
        try {
          return await (typeof work === 'function' ? work() : work);
        } finally {
          done();
        }
      },
    };
    res.once('finish', finish);
    res.once('close', finish);
    res.once('error', finish);
    next();
  }

  function admitStream(req, res) {
    if (draining || active.stream >= limits.stream) {
      reject('stream', res);
      return null;
    }
    active.stream += 1;
    peak.stream = Math.max(peak.stream, active.stream);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      active.stream -= 1;
      res.removeListener('finish', release);
      res.removeListener('close', release);
      res.removeListener('error', release);
      notifyIdle();
    };
    res.once('finish', release);
    res.once('close', release);
    res.once('error', release);
    return release;
  }

  function awaitIdle(timeoutMs = 25000) {
    if (!active.total && !active.stream) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => finish(false), positiveInteger(timeoutMs, 25000, 300000));
      function finish(idle) {
        clearTimeout(timer);
        idleWaiters.delete(finish);
        resolve(idle);
      }
      idleWaiters.add(finish);
    });
  }

  return {
    middleware,
    admitStream,
    beginDrain() {
      draining = true;
    },
    awaitIdle,
    snapshot() {
      return {
        draining,
        limits: { ...limits },
        active: { ...active },
        peak: { ...peak },
        rejected: { ...rejected },
        completed,
      };
    },
  };
}

// Async Express handlers can continue working after a browser closes its
// socket. Keep their admission slots until they really settle, not merely
// until the response emits close. Auth/parser early responses still release
// their slots normally when no handler has been started.
function trackedHandler(handler) {
  return async function tracked(req, res, next) {
    const done = req.loadControl?.beginHandler() || (() => {});
    try {
      return await handler.call(this, req, res, next);
    } finally {
      done();
    }
  };
}

const TRACKING_INSTALLED = Symbol('load-control-handler-tracking');
function installHandlerTracking(app) {
  if (app[TRACKING_INSTALLED]) return;
  const transform = (handler) => {
    if (Array.isArray(handler)) return handler.map(transform);
    return typeof handler === 'function' &&
      Object.prototype.toString.call(handler) === '[object AsyncFunction]'
      ? trackedHandler(handler)
      : handler;
  };
  for (const method of ['get', 'post', 'put', 'patch', 'delete', 'all']) {
    const register = app[method];
    app[method] = function registerTrackedRoute(...args) {
      // app.get(name) reads an Express setting; it is not route registration.
      if (method === 'get' && args.length === 1) return register.apply(this, args);
      return register.call(this, args[0], ...args.slice(1).map(transform));
    };
  }
  app[TRACKING_INSTALLED] = true;
}

module.exports = {
  DEFAULT_LIMITS,
  classifyRequest,
  createLoadControl,
  trackedHandler,
  installHandlerTracking,
};
