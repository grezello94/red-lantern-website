'use strict';

// Bound the complete Neon HTTP query, including response-body consumption.
// Never automatically retry here: an interrupted write may have committed.
function createDatabaseTransport({ fetch, dispatcher, maxActive = 24, maxPending = 128,
  queueTimeoutMs = 2000, queryTimeoutMs = 15000, maxResponseBytes = 32 * 1024 * 1024 }) {
  let active = 0;
  let closed = false;
  const pending = [];
  const idleWaiters = new Set();
  const capacityError = (message) => Object.assign(new Error(message), { code: 'DATABASE_BUSY' });
  function acquire() {
    if (closed) return Promise.reject(capacityError('Database transport is closing.'));
    if (active < maxActive) { active += 1; return Promise.resolve(); }
    if (pending.length >= maxPending) return Promise.reject(capacityError('Database is busy. Retry shortly.'));
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject };
      entry.timer = setTimeout(() => {
        const index = pending.indexOf(entry);
        if (index !== -1) pending.splice(index, 1);
        reject(capacityError('Database queue timed out. Retry shortly.'));
      }, queueTimeoutMs);
      pending.push(entry);
    });
  }
  function release() {
    const next = pending.shift();
    if (next) { clearTimeout(next.timer); next.resolve(); }
    else active -= 1;
    if (!active && !pending.length) for (const resolve of idleWaiters) resolve();
  }
  async function fetchQuery(url, options = {}) {
    await acquire();
    const deadline = AbortSignal.timeout(queryTimeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
    try {
      const response = await fetch(url, { ...options, signal, dispatcher });
      const declaredSize = Number(response.headers.get('content-length') || 0);
      if (declaredSize > maxResponseBytes) {
        await response.body?.cancel();
        throw new Error('Database response exceeded its memory limit.');
      }
      const chunks = [];
      let size = 0;
      if (response.body) {
        const reader = response.body.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > maxResponseBytes) throw new Error('Database response exceeded its memory limit.');
            chunks.push(value);
          }
        } catch (error) {
          await reader.cancel().catch(() => {});
          throw error;
        } finally { reader.releaseLock(); }
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      // Neon consumes json()/text() after this function returns. Buffering here
      // keeps the semaphore and deadline alive until the complete query arrives.
      return new Response([204, 205, 304].includes(response.status) ? null : bytes, {
        status: response.status, statusText: response.statusText, headers: response.headers,
      });
    } finally { release(); }
  }
  async function close() {
    closed = true;
    for (const entry of pending.splice(0)) {
      clearTimeout(entry.timer);
      entry.reject(capacityError('Database transport is closing.'));
    }
    if (active) await new Promise((resolve) => idleWaiters.add(resolve));
    idleWaiters.clear();
    await dispatcher?.close();
  }
  async function destroy() {
    closed = true;
    for (const entry of pending.splice(0)) {
      clearTimeout(entry.timer);
      entry.reject(capacityError('Database transport is closing.'));
    }
    await dispatcher?.destroy();
  }
  return { fetch: fetchQuery, close, destroy, snapshot: () => ({ active, pending: pending.length, maxActive, maxPending, closed }) };
}

module.exports = { createDatabaseTransport };
