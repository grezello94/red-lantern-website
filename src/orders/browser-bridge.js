(function (global) {
  /** @type {Window & { RED_LANTERN_CONFIG?: { printBridgeOrigin?: string }, RedLanternOrders?: { utils?: any, sync?: any, ledger?: any } }} */
  const runtimeWindow = /** @type {any} */ (global);
  const config = runtimeWindow.RED_LANTERN_CONFIG || {};
  const printBridgeOrigin = config.printBridgeOrigin || 'http://127.0.0.1:9124';

  /**
   * @param {{ type: string, payload?: Record<string, any> }} action
   * @param {{ fetchFn?: typeof fetch, printBridgeOrigin?: string }} [options]
   * @returns {Promise<any>}
   */
  function dispatchBridgeAction(action, options = {}) {
    const payload = action && action.payload ? action.payload : {};
    const fetchFn = options.fetchFn || runtimeWindow.fetch;
    const runtimeOrigin = options.printBridgeOrigin || printBridgeOrigin;
    if (!action || typeof action.type !== 'string') {
      return Promise.reject(new Error('Invalid action'));
    }

    let responsePromise;
    if (action.type === 'counter-order') {
      responsePromise = fetchFn('/api/orders/counter', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Counter-Order-Id': payload.clientRequestId },
        body: JSON.stringify(payload),
      });
    } else if (action.type === 'order-status') {
      responsePromise = fetchFn(`/api/orders/${encodeURIComponent(payload.orderId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: payload.status }),
      });
    } else if (action.type === 'order-items') {
      responsePromise = fetchFn(`/api/orders/${encodeURIComponent(payload.orderId)}/items`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ quantities: payload.quantities }),
      });
    } else if (action.type === 'order-table') {
      responsePromise = fetchFn(`/api/orders/${encodeURIComponent(payload.orderId)}/table`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tableArea: payload.tableArea, tableNumber: payload.tableNumber }),
      });
    } else if (action.type === 'kitchen-status') {
      responsePromise = fetchFn(
        `/api/orders/${encodeURIComponent(payload.orderId)}/kitchen-status/${encodeURIComponent(payload.printerId)}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: payload.status }),
        }
      );
    } else if (action.type === 'availability-update') {
      responsePromise = fetchFn(
        `/api/orders/availability/${encodeURIComponent(payload.key)}`,
        payload.unavailableUntil
          ? {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ unavailableUntil: payload.unavailableUntil }),
            }
          : { method: 'DELETE' }
      );
    } else if (action.type === 'operations-config') {
      responsePromise = fetchFn('/api/orders/operations', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: payload.config }),
      });
    } else if (action.type === 'table-areas') {
      responsePromise = fetchFn('/api/orders/operations/table-areas', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tableAreas: payload.tableAreas }),
      });
    } else if (action.type === 'settlement') {
      responsePromise = fetchFn(`/api/orders/${encodeURIComponent(payload.orderId)}/settle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Settlement-Id': payload.requestId },
        body: JSON.stringify({ paymentType: payload.paymentType, amount: payload.amount, requestId: payload.requestId }),
      });
    } else {
      return Promise.reject(new Error('Unsupported offline action type.'));
    }

    return responsePromise.then(async (response) => {
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        const err = /** @type {Error & { status?: number }} */ (new Error(body.error || 'Unable to dispatch bridge action.'));
        err.status = response.status || 0;
        throw err;
      }
      return body;
    });
  }

  /**
   * @param {{ fetchFn?: typeof fetch, dispatchFn?: typeof dispatchBridgeAction, printBridgeOrigin?: string }} [options]
   * @returns {Promise<{ queuedAtStart: number, processed: number }>}
   */
  async function flushBridgeLedger(options = {}) {
    const fetchFn = options.fetchFn || runtimeWindow.fetch;
    const dispatchFn = options.dispatchFn || dispatchBridgeAction;
    const effectiveOrigin = options.printBridgeOrigin || printBridgeOrigin;
    const response = await fetchFn(`${effectiveOrigin}/v1/ledger/actions?status=queued`, { cache: 'no-store' });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !Array.isArray(body.actions)) {
      throw new Error(body.error || 'Unable to read the local order ledger.');
    }

    let processed = 0;
    for (const action of body.actions) {
      try {
        await dispatchFn(action, { fetchFn, printBridgeOrigin: effectiveOrigin });
        await fetchFn(`${effectiveOrigin}/v1/ledger/actions/${encodeURIComponent(action.id)}/synced`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        }).catch(() => {});
        processed += 1;
      } catch (error) {
        const typedError = error instanceof Error ? error : new Error(String(error));
        const status = /** @type {Error & { status?: number }} */ (typedError).status || 0;
        if (status >= 400 && status < 500 && status !== 409) {
          await fetchFn(`${effectiveOrigin}/v1/ledger/actions/${encodeURIComponent(action.id)}/blocked`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: typedError.message || 'Blocked' }),
          }).catch(() => {});
        }
        break;
      }
    }
    return { queuedAtStart: body.actions.length, processed };
  }

  const redLanternOrders = runtimeWindow.RedLanternOrders || { utils: {}, sync: {}, ledger: {} };
  redLanternOrders.sync = redLanternOrders.sync || { dispatchBridgeAction };
  redLanternOrders.ledger = redLanternOrders.ledger || { flushBridgeLedger };
  runtimeWindow.RedLanternOrders = redLanternOrders;
})(typeof window !== 'undefined' ? window : globalThis);
