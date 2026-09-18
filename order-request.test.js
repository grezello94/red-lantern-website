const ReliableOrderRequests = require('./order-request');

function response(status, data = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => data,
  };
}

describe('reliable order requests', () => {
  test('retries a temporary server failure and succeeds', async () => {
    const fetcher = jest
      .fn()
      .mockResolvedValueOnce(response(503, { error: 'Busy' }))
      .mockResolvedValueOnce(response(201, { id: 'order-1' }));
    const result = await ReliableOrderRequests.json(
      '/api/orders/counter',
      { method: 'POST', body: '{"clientRequestId":"same-id"}' },
      { fetcher, delays: [0], timeoutMs: 1000 }
    );

    expect(result.data.id).toBe('order-1');
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0][1].body).toBe(fetcher.mock.calls[1][1].body);
  });

  test('retries an interrupted connection without changing the payload', async () => {
    const fetcher = jest
      .fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(response(200, { id: 'existing-order', duplicate: true }));
    const init = {
      method: 'POST',
      headers: { 'X-Counter-Order-Id': 'one-request-id' },
      body: '{"clientRequestId":"one-request-id"}',
    };
    const result = await ReliableOrderRequests.json('/api/orders/counter', init, {
      fetcher,
      delays: [0],
      timeoutMs: 1000,
    });

    expect(result.data.duplicate).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[1][1].headers['X-Counter-Order-Id']).toBe('one-request-id');
  });

  test('does not retry validation or table-conflict responses', async () => {
    const fetcher = jest.fn().mockResolvedValue(response(409, { code: 'table_changed' }));
    const result = await ReliableOrderRequests.json(
      '/api/orders/counter',
      {},
      {
        fetcher,
        delays: [0],
        timeoutMs: 1000,
      }
    );

    expect(result.response.status).toBe(409);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

test('missing Retry-After uses backoff instead of retrying immediately', async () => {
  const onRetry = jest.fn();
  const fetcher = jest
    .fn()
    .mockResolvedValueOnce(response(503))
    .mockResolvedValueOnce(response(200, { id: 'saved' }));
  await ReliableOrderRequests.json('/orders', {}, { fetcher, delays: [10], onRetry });
  expect(onRetry).toHaveBeenCalledWith(expect.objectContaining({ delayMs: 10 }));
});
