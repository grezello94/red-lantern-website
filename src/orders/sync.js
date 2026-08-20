/**
 * @typedef {Object} BridgeAction
 * @property {string} type
 * @property {Record<string, any>} [payload]
 */

/**
 * Dispatch a queued bridge action to the relevant backend endpoint.
 * @param {BridgeAction} action
 * @param {{ fetchFn?: typeof fetch, printBridgeOrigin?: string }} [options]
 * @returns {Promise<Record<string, any>>}
 */
async function dispatchBridgeAction(action, { fetchFn = fetch, printBridgeOrigin = (typeof window !== 'undefined' ? /** @type {Window & { RED_LANTERN_CONFIG?: { printBridgeOrigin?: string } }} */ (window).RED_LANTERN_CONFIG?.printBridgeOrigin : undefined) || 'http://127.0.0.1:9124' } = {}) {
  if (!action || typeof action.type !== 'string') throw new Error('Invalid action');
  const payload = action.payload || {};
  let response;
  if (action.type === 'counter-order') {
    response = await fetchFn('/api/orders/counter', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Counter-Order-Id': payload.clientRequestId }, body: JSON.stringify(payload) });
  } else if (action.type === 'order-status') {
    response = await fetchFn(`/api/orders/${encodeURIComponent(payload.orderId)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: payload.status }) });
  } else if (action.type === 'order-items') {
    response = await fetchFn(`/api/orders/${encodeURIComponent(payload.orderId)}/items`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ quantities: payload.quantities }) });
  } else if (action.type === 'order-table') {
    response = await fetchFn(`/api/orders/${encodeURIComponent(payload.orderId)}/table`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tableArea: payload.tableArea, tableNumber: payload.tableNumber }) });
  } else if (action.type === 'kitchen-status') {
    response = await fetchFn(`/api/orders/${encodeURIComponent(payload.orderId)}/kitchen-status/${encodeURIComponent(payload.printerId)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: payload.status }) });
  } else if (action.type === 'availability-update') {
    if (payload.unavailableUntil) {
      response = await fetchFn(`/api/orders/availability/${encodeURIComponent(payload.key)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ unavailableUntil: payload.unavailableUntil }) });
    } else {
      response = await fetchFn(`/api/orders/availability/${encodeURIComponent(payload.key)}`, { method: 'DELETE' });
    }
  } else if (action.type === 'operations-config') {
    response = await fetchFn('/api/orders/operations', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ config: payload.config }) });
  } else if (action.type === 'table-areas') {
    response = await fetchFn('/api/orders/operations/table-areas', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tableAreas: payload.tableAreas }) });
  } else if (action.type === 'settlement') {
    response = await fetchFn(`/api/orders/${encodeURIComponent(payload.orderId)}/settle`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Settlement-Id': payload.requestId }, body: JSON.stringify({ paymentType: payload.paymentType, amount: payload.amount, requestId: payload.requestId }) });
  } else {
    throw new Error('Unsupported offline action type.');
  }
  const body = await (response && typeof response.json === 'function' ? response.json().catch(() => ({})) : Promise.resolve({}));
  if (!response || !response.ok) {
    const err = /** @type {Error & { status?: number }} */ (new Error(body.error || 'Unable to dispatch bridge action.'));
    err.status = response ? response.status : 0;
    throw err;
  }
  return body;
}

module.exports = { dispatchBridgeAction };
