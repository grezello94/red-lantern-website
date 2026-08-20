const { dispatchBridgeAction } = require('../src/orders/sync');

describe('dispatchBridgeAction', () => {
  test('order-status sends PATCH to order URL', async () => {
    const mockFetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true }) });
    const action = { type: 'order-status', payload: { orderId: 'abc123', status: 'preparing' } };
    const result = await dispatchBridgeAction(action, { fetchFn: mockFetch });
    expect(result).toEqual({ success: true });
    expect(mockFetch).toHaveBeenCalledWith('/api/orders/abc123', expect.objectContaining({ method: 'PATCH' }));
  });

  test('availability-update PUT when unavailableUntil present', async () => {
    const mockFetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    const action = { type: 'availability-update', payload: { key: 'item:1', unavailableUntil: '2026-12-31T00:00:00Z' } };
    await dispatchBridgeAction(action, { fetchFn: mockFetch });
    expect(mockFetch).toHaveBeenCalledWith('/api/orders/availability/item%3A1', expect.objectContaining({ method: 'PUT' }));
  });

  test('availability-update DELETE when no unavailableUntil', async () => {
    const mockFetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    const action = { type: 'availability-update', payload: { key: 'item:2' } };
    await dispatchBridgeAction(action, { fetchFn: mockFetch });
    expect(mockFetch).toHaveBeenCalledWith('/api/orders/availability/item%3A2', { method: 'DELETE' });
  });

  test('unsupported action throws', async () => {
    await expect(dispatchBridgeAction({ type: 'unknown' }, { fetchFn: jest.fn() })).rejects.toThrow('Unsupported offline action type.');
  });
});
