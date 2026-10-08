/** @jest-environment node */
const http = require('http');

let mockState;
const mockSql = jest.fn(async (strings, ...values) => {
  const query = typeof strings === 'string' ? strings : strings.join('$');
  mockState.queries.push(query);
  if (query.includes('LIMIT 0')) return [];
  if (query.includes('SELECT data FROM website_content'))
    return [{ data: { items: [{ name: 'Soup', category: 'Soups' }], barItems: [] } }];
  if (query.startsWith('SELECT config') && query.includes('FROM order_operations_config'))
    return mockState.config ? [{ config: structuredClone(mockState.config), config_revision: mockState.revision.toString() }] : [];
  if (query.startsWith('INSERT INTO order_operations_config')) {
    const config = JSON.parse(values[0]);
    if (mockState.beforeSave) {
      const beforeSave = mockState.beforeSave;
      mockState.beforeSave = null;
      beforeSave();
    }
    if (mockState.config && !values[1] && values[2] !== mockState.revision.toString()) return [];
    mockState.config = query.includes('jsonb_set')
      ? { ...(mockState.config || { printers: [], routes: [] }), tableAreas: config.tableAreas }
      : config;
    mockState.revision += 1n;
    return [{ config: structuredClone(mockState.config), config_revision: mockState.revision.toString() }];
  }
  return [];
});
jest.mock('@neondatabase/serverless', () => ({ neon: () => mockSql, neonConfig: {} }));
jest.mock('web-push', () => ({ setVapidDetails: jest.fn(), sendNotification: jest.fn() }));

describe('durable cloud printer pairing', () => {
  let app, server, origin;
  const pairedPrinter = { id: 'kitchen', name: 'Kitchen', capabilities: ['kot', 'bill'],
    deviceId: 'system:queue', deviceName: 'Kitchen Queue', workstationId: 'ws_counter', workstationName: 'Counter PC' };
  const routing = { id: 'soups', category: 'Soups', itemName: '', printerId: 'kitchen' };
  const diningArea = { id: 'ac', name: 'AC', from: 1, to: 10 };
  beforeAll(() => {
    process.env.NEON_DATABASE_URL = 'postgresql://test:test@localhost/test';
    process.env.ORDERS_USERNAME = 'pairing-test';
    process.env.ORDERS_PASSWORD = 'pairing-test-password';
    jest.isolateModules(() => { app = require('./server'); });
  });
  beforeEach(async () => {
    mockState = { config: { printers: [pairedPrinter], routes: [routing], tableAreas: [diningArea] },
      revision: 9007199254740993n, queries: [], beforeSave: null };
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
  });
  afterEach(async () => { await new Promise((resolve) => server.close(resolve)); });
  async function request(path = '/api/orders/operations', { method = 'GET', body } = {}) {
    const response = await fetch(origin + path, { method,
      headers: { Authorization: `Basic ${Buffer.from('pairing-test:pairing-test-password').toString('base64')}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, data: await response.json(), headers: response.headers };
  }
  test.each(['', '?configOnly=1'])('returns exact durable revision in every printing payload %s', async (query) => {
    const first = await request(`/api/orders/operations${query}`);
    const again = await request(`/api/orders/operations${query}`);
    expect(first.status).toBe(200);
    expect(first.data.configRevision).toBe('9007199254740993');
    expect(first.data.config.configRevision).toBe(first.data.configRevision);
    expect(again.data.configRevision).toBe(first.data.configRevision);
    expect(first.data.config.printers[0].workstationId).toBe('ws_counter');
    expect(first.headers.get('cache-control')).toBe('no-store');
  });
  test('saving routing preserves omitted queue and workstation binding fields from an older client', async () => {
    const body = { expectedConfigRevision: mockState.revision.toString(), config: {
      printers: [{ id: 'kitchen', name: 'Kitchen', capabilities: ['kot', 'bill'] }], routes: [routing],
    } };
    const saved = await request(undefined, { method: 'PUT', body });
    expect(saved.status).toBe(200);
    expect(saved.data.config.printers[0]).toMatchObject(pairedPrinter);
    expect(saved.data.config.tableAreas).toEqual([diningArea]);
    expect(saved.data.configRevision).toBe('9007199254740994');
    expect(saved.data.config.configRevision).toBe(saved.data.configRevision);
    expect(mockState.config.configRevision).toBeUndefined();
  });
  test('rejects stale offline edits without deleting an established printer', async () => {
    const saved = await request(undefined, { method: 'PUT', body: {
      expectedConfigRevision: '9007199254740992', config: { printers: [], routes: [] },
    } });
    expect(saved.status).toBe(409);
    expect(saved.data.code).toBe('operations_config_conflict');
    expect(mockState.config.printers).toEqual([pairedPrinter]);
    expect(mockState.config.routes).toEqual([routing]);
  });
  test('compares the revision inside the atomic write, so an overlapping save cannot erase pairing', async () => {
    const revision = mockState.revision.toString();
    mockState.beforeSave = () => {
      mockState.config.printers.push({ ...pairedPrinter, id: 'bar', deviceId: 'system:bar', deviceName: 'Bar Queue' });
      mockState.revision += 1n;
    };
    const saved = await request(undefined, { method: 'PUT', body: {
      expectedConfigRevision: revision, config: { printers: [], routes: [] },
    } });
    expect(saved.status).toBe(409);
    expect(mockState.config.printers.map((printer) => printer.id)).toEqual(['kitchen', 'bar']);
  });
  test('an explicit deletion with the current revision persists and gets a newer revision', async () => {
    const saved = await request(undefined, { method: 'PUT', body: { config: {
      configRevision: mockState.revision.toString(), printers: [], routes: [], tableAreas: [diningArea],
    } } });
    expect(saved.status).toBe(200);
    expect(BigInt(saved.data.configRevision)).toBeGreaterThan(9007199254740993n);
    expect((await request()).data.config.printers).toEqual([]);
    expect((await request()).data.configRevision).toBe(saved.data.configRevision);
  });
  test.each([{ tableAreas: [] }, { printers: [] }, { printers: [], routes: null }])('a partial/default payload cannot replace printer pairing: %j', async (config) => {
    const saved = await request(undefined, { method: 'PUT', body: { config } });
    expect(saved.status).toBe(400);
    expect(mockState.config.printers).toEqual([pairedPrinter]);
    expect(mockState.queries.some((query) => query.startsWith('INSERT INTO order_operations_config'))).toBe(false);
  });
  test('saving only tables atomically retains concurrent printer changes', async () => {
    mockState.beforeSave = () => {
      mockState.config.printers.push({ ...pairedPrinter, id: 'bar', deviceId: 'system:bar', deviceName: 'Bar Queue' });
      mockState.revision += 1n;
    };
    const saved = await request('/api/orders/operations/table-areas', { method: 'PUT',
      body: { tableAreas: [{ ...diningArea, to: 20 }] } });
    expect(saved.status).toBe(200);
    expect(saved.data.config.printers.map((printer) => printer.id)).toEqual(['kitchen', 'bar']);
    expect(saved.data.tableAreas[0].to).toBe(20);
    expect(saved.data.config.configRevision).toBe(saved.data.configRevision);
  });
  test('rejects stale table edits when their revision is supplied', async () => {
    const saved = await request('/api/orders/operations/table-areas', { method: 'PUT',
      body: { expectedConfigRevision: '1', tableAreas: [] } });
    expect(saved.status).toBe(409);
    expect(mockState.config.tableAreas).toEqual([diningArea]);
  });
  test('first setup uses revision zero and receives a durable revision on save', async () => {
    mockState.config = null;
    mockState.revision = 0n;
    expect((await request()).data.configRevision).toBe('0');
    const saved = await request(undefined, { method: 'PUT', body: {
      expectedConfigRevision: '0', config: { printers: [pairedPrinter], routes: [routing] },
    } });
    expect(saved.status).toBe(200);
    expect(saved.data.configRevision).toBe('1');
    expect((await request()).data.config.printers[0].workstationId).toBe('ws_counter');
  });
  test('legacy complete clients can save without a revision during the rollout', async () => {
    const saved = await request(undefined, { method: 'PUT', body: { config: mockState.config } });
    expect(saved.status).toBe(200);
    expect(saved.data.config.printers[0].workstationId).toBe('ws_counter');
  });
  test.each(['yesterday', '-1', '1.1', ''])('invalid revision %j does not change saved pairing', async (expectedConfigRevision) => {
    const saved = await request(undefined, { method: 'PUT', body: {
      expectedConfigRevision, config: { printers: [], routes: [] },
    } });
    expect(saved.status).toBe(400);
    expect(mockState.config.printers).toEqual([pairedPrinter]);
  });
});
