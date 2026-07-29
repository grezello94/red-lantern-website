/*
 * Red Lantern Print Bridge
 *
 * Run this on the restaurant computer that has the LAN/USB printers installed:
 *   npm run print-bridge
 *
 * The Orders console uses this local service only to discover printer names.
 * Printing is intentionally not exposed until the KOT dispatch workflow is enabled.
 */
const http = require('http');
const { execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');

const PORT = Number(process.env.PRINT_BRIDGE_PORT || 9124);
const storageDir = process.env.PRINT_BRIDGE_DATA_DIR || path.join(os.homedir(), '.red-lantern-print-bridge');
const configFile = path.join(storageDir, 'printer-config.json');
const queueFile = path.join(storageDir, 'kot-queue.json');

function run(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { windowsHide: true, timeout: 5000 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(String(stdout || ''));
    });
  });
}

async function installedPrinters() {
  let output = '';
  if (process.platform === 'win32') {
    // Different Windows installations expose printer data through different
    // management providers, so try all supported built-in discovery routes.
    const attempts = [
      ['powershell.exe', ['-NoProfile', '-Command', 'Get-CimInstance -ClassName Win32_Printer | Select-Object -ExpandProperty Name']],
      ['powershell.exe', ['-NoProfile', '-Command', 'Get-Printer | Select-Object -ExpandProperty Name']],
      ['wmic.exe', ['printer', 'get', 'name', '/value']]
    ];
    const failures = [];
    for (const [command, args] of attempts) {
      try { output = await run(command, args); break; }
      catch (error) { failures.push(error.message); }
    }
    if (!output && failures.length === attempts.length) {
      throw new Error('Windows could not read installed printers. Confirm the Print Spooler is running and install the printer manufacturer’s Windows driver.');
    }
    const names = output.includes('Name=')
      ? output.split(/\r?\n/).map((line) => line.replace(/^Name=/i, ''))
      : output.split(/\r?\n/);
    return formatPrinters(names);
  }
  if (process.platform === 'darwin') {
    try { output = await run('lpstat', ['-p']); }
    catch (_) { throw new Error('macOS printing is unavailable. Add the printer in System Settings > Printers & Scanners, then install its AirPrint or manufacturer driver.'); }
    return formatPrinters(output.split(/\r?\n/).map((line) => {
      const match = line.match(/^printer\s+([^\s]+)/i);
      return match ? match[1] : '';
    }));
  } else {
    try { output = await run('lpstat', ['-p']); }
    catch (_) { throw new Error('CUPS printer discovery is unavailable. Install and configure CUPS and the printer driver.'); }
    return formatPrinters(output.split(/\r?\n/).map((line) => {
      const match = line.match(/^printer\s+([^\s]+)/i);
      return match ? match[1] : '';
    }));
  }
}

function formatPrinters(names) {
  return [...new Set(names.map((name) => name.trim()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({ id: name, name }));
}

async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

async function writeJson(file, value) {
  await fs.mkdir(storageDir, { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(value, null, 2), 'utf8');
  await fs.rename(temporary, file);
}

async function printText(printerName, text) {
  const file = path.join(os.tmpdir(), `red-lantern-kot-${crypto.randomUUID()}.txt`);
  await fs.writeFile(file, text, 'utf8');
  try {
    if (process.platform === 'win32') {
      const quote = (value) => String(value).replace(/'/g, "''");
      const script = `$content = Get-Content -LiteralPath '${quote(file)}' -Raw; $content | Out-Printer -Name '${quote(printerName)}'`;
      await run('powershell.exe', ['-NoProfile', '-Command', script]);
    } else {
      await run('lp', ['-d', printerName, file]);
    }
  } finally { await fs.unlink(file).catch(() => {}); }
}

function kotText(payload) {
  const order = payload.order || {};
  const items = Array.isArray(payload.items) ? payload.items : [];
  const line = '-'.repeat(34);
  return ['RED LANTERN RESTAURANT', 'KITCHEN ORDER TICKET', line, `Order #${order.number || order.id || '—'}`, `${order.customer || 'Guest'} · ${order.fulfillment || 'Order'}`, line, ...items.map((item) => `${Number(item.quantity || 0)}x ${item.name || 'Item'}${item.portion ? ` (${item.portion})` : ''}${item.style ? ` · ${item.style}` : ''}`), order.note ? `${line}\nNote: ${order.note}` : '', line, new Date().toLocaleString(), '\n\n\n'].filter(Boolean).join('\n');
}

function allowedOrigin(request) {
  const origin = request.headers.origin || '';
  if (!origin || /^https:\/\/(www\.)?redlanternrestaurant\.in$/i.test(origin) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)) return origin || '*';
  return '';
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { raw += chunk; if (raw.length > 512000) reject(new Error('Request too large.')); });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch (_) { reject(new Error('Invalid JSON.')); } });
    req.on('error', reject);
  });
}

function reply(res, status, body, origin = '') {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    ...(origin ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {}),
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const origin = allowedOrigin(req);
  if (req.headers.origin && !origin) return reply(res, 403, { error: 'This website is not allowed to access the Print Bridge.' });
  if (req.method === 'OPTIONS') return reply(res, 204, {}, origin);
  if (req.method === 'GET' && req.url === '/health') return reply(res, 200, { ok: true, service: 'Red Lantern Print Bridge' }, origin);
  if (req.method === 'GET' && req.url === '/v1/printers') {
    try { return reply(res, 200, { printers: await installedPrinters() }, origin); }
    catch (error) { return reply(res, 500, { error: 'Unable to read installed printers.', detail: error.message }, origin); }
  }
  if (req.method === 'GET' && req.url === '/v1/config') {
    try { return reply(res, 200, { config: await readJson(configFile, { printers: [], routes: [] }) }, origin); }
    catch (error) { return reply(res, 500, { error: 'Unable to read local printer configuration.', detail: error.message }, origin); }
  }
  if (req.method === 'PUT' && req.url === '/v1/config') {
    try {
      const config = (await readBody(req)).config || {};
      const printers = (Array.isArray(config.printers) ? config.printers : []).slice(0, 250)
        .map((printer) => ({ id: String(printer.id || '').slice(0, 60), name: String(printer.name || '').trim().slice(0, 60), type: printer.type === 'bill' ? 'bill' : 'kot', deviceId: String(printer.deviceId || '').slice(0, 160), deviceName: String(printer.deviceName || '').slice(0, 120) }))
        .filter((printer) => printer.id && printer.name);
      const printerIds = new Set(printers.map((printer) => printer.id));
      const routes = (Array.isArray(config.routes) ? config.routes : []).slice(0, 2000)
        .map((route) => ({ id: String(route.id || '').slice(0, 60), printerId: String(route.printerId || '').slice(0, 60), category: String(route.category || '').trim().slice(0, 100), itemName: String(route.itemName || '').trim().slice(0, 160) }))
        .filter((route) => route.id && printerIds.has(route.printerId) && route.category);
      const safeConfig = { printers, routes, savedAt: new Date().toISOString() };
      await writeJson(configFile, safeConfig);
      return reply(res, 200, { ok: true, savedAt: safeConfig.savedAt }, origin);
    } catch (error) { return reply(res, 400, { error: error.message || 'Unable to save local printer configuration.' }, origin); }
  }
  if (req.method === 'GET' && req.url === '/v1/kot-queue') {
    try { return reply(res, 200, { jobs: await readJson(queueFile, []) }, origin); }
    catch (error) { return reply(res, 500, { error: 'Unable to read local KOT queue.', detail: error.message }, origin); }
  }
  if (req.method === 'POST' && req.url === '/v1/kot-queue') {
    try {
      const payload = await readBody(req);
      const printerId = String(payload.printerId || '').slice(0, 60);
      const items = Array.isArray(payload.items) ? payload.items.slice(0, 100) : [];
      if (!printerId || !items.length) throw new Error('A KOT needs a printer and at least one item.');
      const jobs = await readJson(queueFile, []);
      const job = { id: crypto.randomUUID(), status: 'queued', queuedAt: new Date().toISOString(), order: payload.order || null, printerId, items };
      jobs.push(job);
      await writeJson(queueFile, jobs.slice(-1000));
      return reply(res, 201, { ok: true, job }, origin);
    } catch (error) { return reply(res, 400, { error: error.message || 'Unable to queue KOT.' }, origin); }
  }
  if (req.method === 'POST' && req.url === '/v1/print-kot') {
    try {
      const payload = await readBody(req);
      const printerName = String(payload.printerName || '').trim().slice(0, 160);
      const items = Array.isArray(payload.items) ? payload.items.slice(0, 100) : [];
      if (!printerName || !items.length) throw new Error('A printer and at least one KOT item are required.');
      await printText(printerName, kotText({ ...payload, items }));
      return reply(res, 201, { ok: true, printerName }, origin);
    } catch (error) { return reply(res, 400, { error: error.message || 'Unable to print KOT.' }, origin); }
  }
  return reply(res, 404, { error: 'Not found.' }, origin);
});
server.on('error', (error) => {
  console.error(`Red Lantern Print Bridge could not start: ${error.message}`);
  process.exitCode = 1;
});
server.listen(PORT, '127.0.0.1', () => {
  console.log(`Red Lantern Print Bridge is running at http://127.0.0.1:${PORT}`);
});
