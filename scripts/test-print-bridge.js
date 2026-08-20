#!/usr/bin/env node
/* Minimal end-to-end check for the local-only Print Bridge and SQLite ledger. */
const { spawn } = require('child_process');
const fs = require('fs/promises');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');

function request(port, pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.body ? JSON.stringify(options.body) : '';
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: pathname,
        method: options.method || 'GET',
        headers: body
          ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }
          : {},
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          let parsed = {};
          try {
            parsed = JSON.parse(data);
          } catch (_) {}
          if (res.statusCode >= 200 && res.statusCode < 300) return resolve(parsed);
          reject(new Error(parsed.error || `Bridge returned HTTP ${res.statusCode}.`));
        });
      }
    );
    req.on('error', reject);
    req.end(body);
  });
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function main() {
  const port = await freePort();
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'red-lantern-bridge-test-'));
  const child = spawn(process.execPath, ['print-bridge.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: { ...process.env, PRINT_BRIDGE_PORT: String(port), PRINT_BRIDGE_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });
  try {
    let health;
    for (let attempt = 0; attempt < 25; attempt += 1) {
      try {
        health = await request(port, '/health');
        break;
      } catch (_) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    if (!health?.ok || health.ledger !== 'ready' || !health.version)
      throw new Error(`Bridge health check failed. ${output}`);
    const queued = await request(port, '/v1/ledger/actions', {
      method: 'POST',
      body: {
        id: 'smoke-counter-1',
        type: 'counter-order',
        payload: {
          clientRequestId: 'smoke-counter-1',
          items: [{ name: 'Smoke test', quantity: 1 }],
        },
      },
    });
    if (queued.action?.status !== 'queued')
      throw new Error('Bridge did not persist the queued ledger action.');
    const status = await request(port, '/health');
    if (status.ledgerSummary?.pendingActions !== 1)
      throw new Error('Bridge ledger health did not report the queued action.');
    const setup = await request(port, '/v1/setup-status');
    if (
      !setup.ok ||
      !setup.version ||
      setup.ledgerSummary?.pendingActions !== 1 ||
      !Array.isArray(setup.recentPrintFailures) ||
      typeof setup.ledgerSummary?.printJobs?.unresolvedFailed !== 'number'
    )
      throw new Error('Bridge setup status did not expose the durable ledger state.');
    console.log('Print Bridge smoke test passed.');
  } finally {
    child.kill();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
