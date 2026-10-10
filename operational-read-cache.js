'use strict';

function createOperationalReadCache({ ttlMs = 500, maxEntries = 128 } = {}) {
  const entries = new Map();
  function clear() { entries.clear(); }
  async function read(key, load) {
    let entry = entries.get(key);
    if (!entry || entry.expiresAt <= Date.now()) {
      if (entries.size >= maxEntries) entries.delete(entries.keys().next().value);
      entry = { promise: null, expiresAt: Infinity };
      // Set the entry before executing load; overlapping reads share one SQL
      // snapshot, while each caller gets an independent result for auth/filtering.
      entries.set(key, entry);
      entry.promise = Promise.resolve().then(load).then((value) => {
        if (entries.get(key) === entry) entry.expiresAt = Date.now() + ttlMs;
        return value;
      }).catch((error) => {
        if (entries.get(key) === entry) entries.delete(key);
        throw error;
      });
    }
    return structuredClone(await entry.promise);
  }
  return { read, clear, size: () => entries.size };
}

module.exports = { createOperationalReadCache };
