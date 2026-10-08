/** @jest-environment node */
jest.mock('child_process', () => ({ ...jest.requireActual('child_process'), execFile: jest.fn() }));
const http = require('http');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
const originalDataDir = process.env.PRINT_BRIDGE_DATA_DIR;
let bridge;
let directory;
let port;
let nativePrints;
let activePrints;
let maximumActivePrints;
let commands;
let execFile;
let tandoorStatus;
let discoveryAvailable;

function request(pathname, method = 'GET', body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: pathname,
        method,
        headers: {
          origin: 'https://www.redlanternrestaurant.in',
          'Content-Type': 'application/json',
        },
      },
      (res) => {
        let data = '';
        res.on('data', (part) => {
          data += part;
        });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data ? JSON.parse(data) : {} }));
      }
    );
    req.on('error', reject);
    req.end(body ? JSON.stringify(body) : '');
  });
}

async function startBridge() {
  jest.resetModules();
  execFile = require('child_process').execFile;
  execFile.mockImplementation((command, args, options, done) => {
    const script = args.join(' ');
    commands.push(script);
    if (script.includes('$doc.Print()')) {
      nativePrints += 1;
      activePrints += 1;
      maximumActivePrints = Math.max(maximumActivePrints, activePrints);
      return setTimeout(() => {
        activePrints -= 1;
        done(null, 'printed');
      }, 20);
    }
    if (script.includes('$ports=@{}') && !discoveryAvailable)
      return done(new Error('The Windows spooler is temporarily unavailable.'));
    if (script.includes('$ports=@{}'))
      return done(
        null,
        JSON.stringify([
          {
            Name: 'Tandoor Queue',
            Host: '192.168.31.97',
            PortName: 'IP_192.168.31.97',
            Port: 515,
            Protocol: 2,
            Status: tandoorStatus,
          },
          { Name: 'Bill Queue', Host: '', PortName: 'USB001', Status: 'Normal' },
        ])
      );
    if (script.includes('ConnectAsync')) return done(null, 'reachable');
    if (script.includes('Get-Service -Name Spooler')) return done(null, 'running');
    return done(new Error(`Unexpected native command: ${command}`));
  });
  bridge = require('./print-bridge');
  await new Promise((resolve) => bridge.server.listen(0, '127.0.0.1', resolve));
  port = bridge.server.address().port;
}

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-reliability-'));
  process.env.PRINT_BRIDGE_DATA_DIR = directory;
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  nativePrints = activePrints = maximumActivePrints = 0;
  commands = [];
  tandoorStatus = 'Offline';
  discoveryAvailable = true;
  await startBridge();
});
afterEach(async () => {
  await new Promise((resolve) => bridge.server.close(resolve));
  bridge.closeLedger();
  Object.defineProperty(process, 'platform', realPlatform);
  if (originalDataDir === undefined) delete process.env.PRINT_BRIDGE_DATA_DIR;
  else process.env.PRINT_BRIDGE_DATA_DIR = originalDataDir;
  await fs.rm(directory, { recursive: true, force: true });
});

test('trusted PWA origin receives local-network preflight compatibility headers', async () => {
  const result = await request('/health', 'OPTIONS');
  expect(result.status).toBe(204);
  expect(result.headers['access-control-allow-origin']).toBe('https://www.redlanternrestaurant.in');
  expect(result.headers['access-control-allow-private-network']).toBe('true');
});

test('setup waits for spooler recovery, uses one discovery snapshot and LPR port 515', async () => {
  const health = await request('/health');
  expect(health.body.capabilities).toMatchObject({ testPrint: true, durablePrintJobs: true });
  const config = await request('/v1/config', 'PUT', {
    config: {
      printers: [{ id: 'tandoor', name: 'Tandoor', type: 'kot', deviceName: '192.168.31.97' }],
      routes: [{ id: 'route', printerId: 'tandoor', category: '*' }],
    },
  });
  expect(config.status).toBe(200);
  const setup = await request('/v1/setup-status');
  expect(setup.body.configuredPrinterCount).toBe(1);
  expect(setup.body.printerBindings).toEqual([
    { id: 'tandoor', deviceName: 'Tandoor Queue', queueName: 'Tandoor Queue' },
  ]);
  expect(setup.body.unavailableConfiguredPrinterCount).toBe(0);
  expect(setup.body.unreachableConfiguredPrinterCount).toBe(0);
  expect(commands.filter((command) => command.includes('$ports=@{}'))).toHaveLength(1);
  expect(
    commands.findIndex((command) => command.includes('Get-Service -Name Spooler'))
  ).toBeLessThan(commands.findIndex((command) => command.includes('$ports=@{}')));
  expect(commands.find((command) => command.includes('ConnectAsync'))).toContain('$port=515');
});

test('test print accepts query strings and uniquely resolves legacy queue addresses', async () => {
  const result = await request('/v1/test-print?fresh=1', 'POST', { printerName: '192.168.31.97' });
  expect(result.status).toBe(200);
  expect(result.body.printerName).toBe('Tandoor Queue');
  expect(nativePrints).toBe(1);
  const missing = await request('/v1/test-print', 'POST', { printerName: 'Deleted Queue' });
  expect(missing.status).toBe(400);
  expect(missing.body.detail).toMatch(/not installed/);
  expect(nativePrints).toBe(1);
});

test('same queue serializes physical jobs and retried job stays deduplicated after Bridge restart', async () => {
  const payload = {
    printJobId: 'kot-1',
    printerName: 'Tandoor Queue',
    order: { id: 'order-1', kotNumber: 1, createdAt: '2026-10-08T01:00:00Z' },
    items: [{ name: 'Soup', quantity: 1 }],
  };
  const results = await Promise.all([
    request('/v1/print-kot', 'POST', payload),
    request('/v1/print-kot', 'POST', { ...payload, printJobId: 'kot-2' }),
  ]);
  expect(results.map((result) => result.status)).toEqual([201, 201]);
  expect(maximumActivePrints).toBe(1);
  expect(nativePrints).toBe(2);
  await new Promise((resolve) => bridge.server.close(resolve));
  bridge.closeLedger();
  await startBridge();
  const retry = await request('/v1/print-kot', 'POST', payload);
  expect(retry.body.duplicate).toBe(true);
  expect(nativePrints).toBe(2);
  const metadataChanged = await request('/v1/print-kot', 'POST', {
    ...payload,
    order: { ...payload.order, servicePriority: 'urgent', customer: 'Updated guest' },
  });
  expect(metadataChanged.body.duplicate).toBe(true);
  expect(metadataChanged.body.contentChanged).toBe(true);
  expect(nativePrints).toBe(2);
  const wrongMachine = await request('/v1/print-kot', 'POST', {
    ...payload,
    workstationId: 'ws_elsewhere',
  });
  expect(wrongMachine.status).toBe(400);
  expect(nativePrints).toBe(2);
});

test('reachable LAN port cannot conceal a real paper jam', async () => {
  tandoorStatus = 'PaperJam';
  const saved = await request('/v1/config', 'PUT', {
    config: {
      printers: [{ id: 'tandoor', name: 'Tandoor', type: 'kot', deviceName: 'Tandoor Queue' }],
    },
  });
  expect(saved.status).toBe(200);
  const setup = await request('/v1/setup-status');
  expect(setup.body.unreachableConfiguredPrinterCount).toBe(0);
  expect(setup.body.unavailableConfiguredPrinterCount).toBe(1);
});

async function pairCounter(revision = '1000') {
  const health = await request('/health');
  const result = await request('/v1/config', 'PUT', { revision, config: {
    printers: [{ id: 'tandoor', name: 'Tandoor', capabilities: ['kot', 'bill'],
      deviceName: 'Tandoor Queue', deviceId: 'Tandoor Queue', workstationId: health.body.workstation.id,
      formats: { kot: { fontSize: 12, receiptFooter: 'Counter footer' } } }],
    routes: [{ id: 'soups', printerId: 'tandoor', category: 'Soup' }],
    tableAreas: [{ name: 'AC', from: 1, to: 4 }],
  } });
  expect(result.status).toBe(200);
  expect(result.body.config.printers).toHaveLength(1);
  return { workstation: health.body.workstation, config: result.body.config };
}

async function restartBridge() {
  await new Promise(resolve => bridge.server.close(resolve));
  bridge.closeLedger();
  await startBridge();
}

test('paired workstation and queue bindings survive a restart with independent durable copies', async () => {
  const saved = await pairCounter();
  const primary = JSON.parse(await fs.readFile(path.join(directory, 'printer-config.json'), 'utf8'));
  const backup = JSON.parse(await fs.readFile(path.join(directory, 'printer-config.json.bak'), 'utf8'));
  expect(backup).toEqual(primary);
  await restartBridge();
  expect((await request('/health')).body.workstation.id).toBe(saved.workstation.id);
  const restored = (await request('/v1/config')).body.config;
  expect(restored).toEqual(saved.config);
  expect(restored.printers[0].formats.kot.receiptFooter).toBe('Counter footer');
  expect(restored.tableAreas).toEqual([{ name: 'AC', from: 1, to: 4 }]);
});

test.each(['primary', 'both'])('damaged %s JSON settings recover the established pairing without a new identity', async (copies) => {
  const saved = await pairCounter();
  await new Promise(resolve => bridge.server.close(resolve));
  bridge.closeLedger();
  for (const name of ['workstation.json', 'printer-config.json']) {
    await fs.writeFile(path.join(directory, name), '{interrupted write');
    if (copies === 'both') await fs.writeFile(path.join(directory, `${name}.bak`), '');
  }
  await startBridge();
  expect((await request('/health')).body.workstation.id).toBe(saved.workstation.id);
  expect((await request('/v1/config')).body.config).toEqual(saved.config);
  for (const name of ['workstation.json', 'workstation.json.bak'])
    expect(JSON.parse(await fs.readFile(path.join(directory, name), 'utf8')).id).toBe(saved.workstation.id);
  expect(JSON.parse(await fs.readFile(path.join(directory, 'printer-config.json'), 'utf8'))).toEqual(saved.config);
});

test('a changed workstation file cannot replace the identity remembered in the local ledger', async () => {
  const saved = await pairCounter();
  await fs.writeFile(path.join(directory, 'workstation.json'), JSON.stringify({ id: 'ws_accidental_replacement' }));
  await restartBridge();
  expect((await request('/health')).body.workstation.id).toBe(saved.workstation.id);
  expect((await request('/v1/config')).body.config.printers[0].workstationId).toBe(saved.workstation.id);
});

test('background sync with no discovery and an empty or stale payload keeps the established pairing', async () => {
  const saved = await pairCounter('9007199254740993');
  discoveryAvailable = false;
  await restartBridge();
  for (const revision of [undefined, '9007199254740992', '9007199254740993']) {
    const result = await request('/v1/config', 'PUT', { background: true, revision,
      config: { printers: [], routes: [] } });
    expect(result.status).toBe(200);
    expect(result.body.preserved).toBe(true);
    expect(result.body.config.printers).toEqual(saved.config.printers);
    expect(result.body.config.routes).toEqual(saved.config.routes);
    expect(result.body.config.configRevision).toBe('9007199254740993');
  }
  expect((await request('/health')).body.workstation.id).toBe(saved.workstation.id);
});

test('a newer authoritative revision propagates a deliberate deletion while stale sync cannot restore it', async () => {
  const saved = await pairCounter('9007199254740993');
  const deleted = await request('/v1/config', 'PUT', { background: true, revision: '9007199254740994',
    config: { printers: [], routes: [] } });
  expect(deleted.status).toBe(200);
  expect(deleted.body.preserved).toBe(false);
  expect(deleted.body.config.printers).toEqual([]);
  const stale = await request('/v1/config', 'PUT', { background: true, revision: '9007199254740993', config: saved.config });
  expect(stale.body.config.printers).toEqual([]);
  await restartBridge();
  expect((await request('/v1/config')).body.config.printers).toEqual([]);
  expect((await request('/health')).body.workstation.id).toBe(saved.workstation.id);
});

test('explicit deletion remains available without manufacturing a new workstation', async () => {
  const saved = await pairCounter();
  const deleted = await request('/v1/config', 'PUT', { background: false, config: { printers: [], routes: [] } });
  expect(deleted.status).toBe(200);
  expect(deleted.body.config.printers).toEqual([]);
  expect((await request('/health')).body.workstation.id).toBe(saved.workstation.id);
});
