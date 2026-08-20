const { dispatchBridgeAction } = require('./sync');

/**
 * Flush queued bridge actions from the local ledger.
 * @param {{ fetchFn?: typeof fetch, dispatchFn?: typeof dispatchBridgeAction, printBridgeOrigin?: string }} [options]
 * @returns {Promise<{ queuedAtStart: number, processed: number }>}
 */
async function flushBridgeLedger({ fetchFn = fetch, dispatchFn = dispatchBridgeAction, printBridgeOrigin = (typeof window !== 'undefined' ? /** @type {Window & { RED_LANTERN_CONFIG?: { printBridgeOrigin?: string } }} */ (window).RED_LANTERN_CONFIG?.printBridgeOrigin : undefined) || 'http://127.0.0.1:9124' } = {}) {
  if (!fetchFn) throw new Error('fetchFn required');
  // Read queued actions from local print bridge ledger
  const response = await fetchFn(`${printBridgeOrigin}/v1/ledger/actions?status=queued`, { cache: 'no-store' });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !Array.isArray(body.actions)) throw new Error(body.error || 'Unable to read the local order ledger.');
  let pending = body.actions.length;
  let processed = 0;
  for (const action of body.actions) {
    try {
      await dispatchFn(action);
      // mark synced
      await fetchFn(`${printBridgeOrigin}/v1/ledger/actions/${encodeURIComponent(action.id)}/synced`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) }).catch(() => {});
      pending = Math.max(0, pending - 1);
      processed += 1;
    } catch (error) {
      /** @type {Error & { status?: number }} */
      const typedError = error instanceof Error ? error : new Error(String(error));
      const status = typedError.status ?? 0;
      // client error that needs blocking
      if (status >= 400 && status < 500 && status !== 409) {
        await fetchFn(`${printBridgeOrigin}/v1/ledger/actions/${encodeURIComponent(action.id)}/blocked`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: typedError.message || 'Blocked' }) }).catch(() => {});
      }
      break;
    }
  }
  return { queuedAtStart: body.actions.length, processed };
}

module.exports = { flushBridgeLedger };
