const { flushBridgeLedger } = require('../src/orders/ledger');

describe('flushBridgeLedger', () => {
  test('processes queued actions and marks them synced', async () => {
    const actions = [{ id: 'a1', type: 'counter-order', payload: {} }, { id: 'a2', type: 'order-status', payload: {} }];
    const fetchCalls = [];
    const fetchFn = jest.fn().mockImplementation((url, opts) => {
      fetchCalls.push({ url, opts });
      if (url.includes('/v1/ledger/actions?status=queued')) {
        return Promise.resolve({ ok: true, json: async () => ({ actions }) });
      }
      // any POST to /v1/ledger/actions/{id}/synced -> return ok
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
    const dispatched = [];
    const dispatchFn = jest.fn().mockImplementation(async (action) => { dispatched.push(action); return {}; });
    const result = await flushBridgeLedger({ fetchFn, dispatchFn, printBridgeOrigin: 'http://127.0.0.1:9124' });
    expect(result.queuedAtStart).toBe(2);
    expect(result.processed).toBe(2);
    expect(dispatchFn).toHaveBeenCalledTimes(2);
    expect(fetchFn).toHaveBeenCalled();
  });

  test('blocks and stops on client error', async () => {
    const actions = [{ id: 'b1', type: 'counter-order', payload: {} }, { id: 'b2', type: 'order-status', payload: {} }];
    const fetchCalls = [];
    const fetchFn = jest.fn().mockImplementation((url, opts) => {
      fetchCalls.push({ url, opts });
      if (url.includes('/v1/ledger/actions?status=queued')) {
        return Promise.resolve({ ok: true, json: async () => ({ actions }) });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });
    const dispatchFn = jest.fn().mockImplementation(async (action) => {
      if (action.id === 'b1') return {};
      const err = /** @type {Error & { status?: number }} */ (new Error('Not allowed'));
      err.status = 400;
      throw err;
    });
    const result = await flushBridgeLedger({ fetchFn, dispatchFn, printBridgeOrigin: 'http://127.0.0.1:9124' });
    expect(result.queuedAtStart).toBe(2);
    expect(result.processed).toBe(1);
    expect(fetchFn).toHaveBeenCalled();
  });
});
