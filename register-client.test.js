const fs = require('fs');
const path = require('path');
const registerSource = fs.readFileSync(path.join(__dirname, 'register.js'), 'utf8');
const registerHtml = fs.readFileSync(path.join(__dirname, 'register.html'), 'utf8');

function reply(data, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => data };
}
const order = {
  id: 'register-unit-order', mode: 'table', table_area: 'AC', table_number: 1,
  status: 'accepted', total: 100.55, daily_order_number: 1,
  order_version: '2026-10-15T06:00:00.123456Z', updated_at: '2026-10-15T06:00:00.123Z',
  created_at: '2026-10-15T05:00:00.000Z', customer_name: 'Guest',
  customer_phone: 'walkin-unit', items: [{ name: 'Soup', price: 100.55, quantity: 1 }],
};
let api, fetcher, listeners, addListener, windowListeners, addWindowListener, nextId;
async function settleMicrotasks() { for (let index = 0; index < 10; index += 1) await Promise.resolve(); }

beforeEach(async () => {
  document.documentElement.innerHTML = registerHtml.replace(/<!doctype[^>]*>/i, '');
  localStorage.clear(); sessionStorage.clear();
  delete window.currentEmployee;
  window.employeeCan = () => true;
  window.RedLanternAddons = require('./addons-domain');
  window.RedLanternPrinterDomain = require('./printer-domain');
  nextId = 0;
  window.crypto.randomUUID = jest.fn(() => `register-fixture-${++nextId}`);
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); this.dispatchEvent(new Event('close')); };
  jest.spyOn(global, 'setInterval').mockReturnValue(0);
  listeners = [];
  const originalAdd = document.addEventListener.bind(document);
  addListener = jest.spyOn(document, 'addEventListener').mockImplementation((type, handler, options) => { listeners.push({ type, handler, options }); originalAdd(type, handler, options); });
  windowListeners = [];
  const originalWindowAdd = window.addEventListener.bind(window);
  addWindowListener = jest.spyOn(window, 'addEventListener').mockImplementation((type, handler, options) => { windowListeners.push({ type, handler, options }); originalWindowAdd(type, handler, options); });
  fetcher = jest.fn(async input => String(input) === '/api/orders' ? reply([order]) : reply({ ok: true }));
  global.fetch = window.fetch = fetcher;
  new Function(`${registerSource}\nwindow.registerTestApi = { load, openPayment, savePayment, receipt, printSummary, render, updatePaymentPreview, getOrders: () => orders };`)();
  api = window.registerTestApi;
  await settleMicrotasks();
});
afterEach(() => {
  listeners.forEach(({ type, handler, options }) => document.removeEventListener(type, handler, options));
  windowListeners.forEach(({ type, handler, options }) => window.removeEventListener(type, handler, options));
  addWindowListener.mockRestore();
  addListener.mockRestore();
  jest.restoreAllMocks();
  jest.useRealTimers();
  delete window.registerTestApi;
});

test('settlement submits the reviewed precise version and staff actor binding', async () => {
  window.currentEmployee = { id: 'billing-one' };
  api.openPayment(order.id, 'cash');
  await api.savePayment();
  const [url, options] = fetcher.mock.calls.find(([input]) => String(input).endsWith('/settle'));
  expect(url).toContain(order.id);
  expect(JSON.parse(options.body)).toMatchObject({ expectedUpdatedAt: order.order_version, actorEmployeeId: 'billing-one' });
});

test('retrying a lost payment response retains the same settlement request identifier', async () => {
  const ids = [];
  fetcher.mockImplementation(async (input, options) => {
    if (String(input).endsWith('/settle')) {
      ids.push(options.headers['X-Settlement-Id']);
      if (ids.length === 1) throw new TypeError('Failed to fetch');
      return reply({ ok: true });
    }
    return reply([order]);
  });
  api.openPayment(order.id, 'cash');
  await expect(api.savePayment()).rejects.toThrow();
  await new Promise(resolve => setTimeout(resolve, 2));
  await api.savePayment();
  expect(ids).toHaveLength(2);
  expect(ids[0]).toBe(ids[1]);
});

test('an unconfirmed successful payment response keeps the payment dialog open', async () => {
  fetcher.mockImplementation(async input => String(input).endsWith('/settle') ? reply({}) : reply([order]));
  api.openPayment(order.id, 'cash');
  await expect(api.savePayment()).rejects.toThrow(/confirm|saved/i);
  expect(document.getElementById('payment-modal')).toHaveAttribute('open');
});

test('typing during an active payment save cannot enable a second confirmation', async () => {
  let release;
  fetcher.mockImplementation(input => String(input).endsWith('/settle') ? new Promise(resolve => { release = () => resolve(reply({ ok: true })); }) : Promise.resolve(reply([order])));
  api.openPayment(order.id, 'cash');
  const saving = api.savePayment();
  document.getElementById('payment-received').value = '200';
  api.updatePaymentPreview();
  expect(document.getElementById('payment-confirm')).toBeDisabled();
  const cancel = new Event('cancel', { cancelable: true });
  document.getElementById('payment-modal').dispatchEvent(cancel);
  expect(cancel.defaultPrevented).toBe(true);
  release(); await saving;
});

test('malformed list responses retain the last known orders and show a connection problem', async () => {
  fetcher.mockResolvedValue(reply({ ok: true }));
  await api.load();
  expect(api.getOrders().map(row => row.id)).toEqual([order.id]);
  expect(document.getElementById('connection-label')).toHaveTextContent('Offline');
});

test('cleared completed orders stay hidden after the automatic list refresh', async () => {
  fetcher.mockResolvedValue(reply([{ ...order, status: 'completed' }]));
  await api.load();
  document.querySelector('[data-clear]').click();
  await settleMicrotasks();
  expect(document.querySelectorAll('.order-strip')).toHaveLength(0);
  await api.load();
  expect(document.querySelectorAll('.order-strip')).toHaveLength(0);
});

test('table identities include the dining area', () => {
  expect(document.querySelector('.order-strip')).toHaveTextContent('AC');
});

function mockPrinting(onPrint) {
  const printers = ['first', 'second'].map(id => ({ id, type: 'bill', enabled: true, deviceName: id, workstationId: 'unit-counter' }));
  fetcher.mockImplementation(async (input, options) => {
    const url = String(input);
    if (url.endsWith('/print')) return reply(order);
    if (url.endsWith('/health')) return reply({ ok: true, workstation: { id: 'unit-counter' } });
    if (url.includes('/operations')) return reply({ config: { printers } });
    if (url.endsWith('/v1/print-bill')) return onPrint(JSON.parse(options.body), options);
    return reply([order]);
  });
}

test('partial printer retries preserve job IDs and skip receipts already acknowledged', async () => {
  const jobs = [];
  let recovered = false;
  mockPrinting(async job => { jobs.push(job); return job.printerName === 'second' && !recovered ? reply({ error: 'Offline' }, 503) : reply({ ok: true }); });
  await expect(api.receipt(order.id, true)).rejects.toThrow(/printing needs attention/i);
  recovered = true;
  await api.receipt(order.id, true);
  expect(jobs.filter(job => job.printerName === 'first')).toHaveLength(1);
  const secondJobs = jobs.filter(job => job.printerName === 'second');
  expect(secondJobs).toHaveLength(2);
  expect(secondJobs[0].printJobId).toBe(secondJobs[1].printJobId);
});

test('uncertain printer responses remain unacknowledged and retain their job for review', async () => {
  const jobs = [];
  mockPrinting(async job => { jobs.push(job); return reply({ ok: true, uncertain: true }); });
  await expect(api.receipt(order.id, true)).rejects.toThrow(/printing needs attention/i);
  await expect(api.receipt(order.id, true)).rejects.toThrow(/printing needs attention/i);
  expect(jobs[0].printJobId).toBe(jobs[2].printJobId);
});

test('late bill reads cannot overwrite the receipt currently selected', async () => {
  let first;
  fetcher.mockImplementation(input => String(input).includes('/first/print')
    ? new Promise(resolve => { first = () => resolve(reply({ ...order, id: 'first', daily_order_number: 11 })); })
    : Promise.resolve(reply({ ...order, id: 'second', daily_order_number: 22 })));
  const pending = api.receipt('first');
  await api.receipt('second');
  first(); await pending;
  expect(document.getElementById('bill-content')).toHaveTextContent('Bill #22');
  expect(document.getElementById('bill-content')).not.toHaveTextContent('Bill #11');
});

test('a fresh read requested during an existing load waits for a trailing current snapshot', async () => {
  let first;
  let reads = 0;
  fetcher.mockImplementation(() => ++reads === 1 ? new Promise(resolve => { first = () => resolve(reply([order])); }) : Promise.resolve(reply([{ ...order, status: 'completed' }])));
  const pending = api.load();
  const fresh = api.load({ fresh: true });
  first(); await Promise.all([pending, fresh]);
  expect(reads).toBe(2);
  expect(api.getOrders()[0].status).toBe('completed');
});

test('zero-value split payments can be saved and sub-paise inputs cannot', async () => {
  fetcher.mockResolvedValue(reply([{ ...order, total: 0 }]));
  await api.load();
  api.openPayment(order.id, 'split');
  expect(document.getElementById('payment-confirm')).toBeEnabled();
  document.querySelector('.split-applied').value = '0.001';
  api.updatePaymentPreview();
  expect(document.getElementById('payment-confirm')).toBeDisabled();
});

test('summary printing opens its popup before waiting for data and accurately allocates legacy partial payments', async () => {
  let release;
  let html = '';
  const popup = { document: { write: jest.fn(value => { html += value; }), close: jest.fn() }, close: jest.fn() };
  const opening = jest.spyOn(window, 'open').mockReturnValue(popup);
  fetcher.mockImplementation(() => new Promise(resolve => { release = () => resolve(reply({ day: '2026-10-15', orders: [{ ...order, total: 800, settlement_type: 'part', settlement_amount: 300, payments: [] }] })); }));
  const pending = api.printSummary();
  expect(opening).toHaveBeenCalledTimes(1);
  release(); await pending;
  expect(html).toContain('Split payment ₹300.00 + Due ₹500.00');
  expect(html).toContain('AC · Table 01');
});

test('Register action grants are checked before issuing protected requests', async () => {
  window.employeeCan = () => false;
  const calls = fetcher.mock.calls.length;
  expect(() => api.openPayment(order.id, 'cash')).toThrow(/not enabled/);
  await expect(api.receipt(order.id, true)).rejects.toThrow(/not enabled/);
  await expect(api.printSummary()).rejects.toThrow(/not enabled/);
  expect(fetcher).toHaveBeenCalledTimes(calls);
});

test('a failed sign-out response is reported without pretending sign out succeeded', async () => {
  fetcher.mockResolvedValue(reply({ error: 'Sign out service unavailable' }, 503));
  document.getElementById('staff-sign-out').click();
  await settleMicrotasks();
  expect(document.getElementById('register-service-notice')).toHaveTextContent('Sign out service unavailable');
});

test('authentication changes clear Register views and prevent an older response restoring them', async () => {
  api.openPayment(order.id, 'cash');
  let release;
  fetcher.mockImplementation(() => new Promise(resolve => { release = () => resolve(reply([order])); }));
  const pending = api.load();
  window.dispatchEvent(new Event('red-lantern-auth-changed'));
  expect(api.getOrders()).toEqual([]);
  expect(document.getElementById('payment-modal')).not.toHaveAttribute('open');
  release(); await pending;
  expect(api.getOrders()).toEqual([]);
  expect(document.querySelectorAll('.order-strip')).toHaveLength(0);
});

test('printer requests time out without losing their stable retry identity', async () => {
  jest.useFakeTimers();
  const jobs = [];
  let stalled = true;
  mockPrinting((job, options) => {
    jobs.push(job);
    if (!stalled) return Promise.resolve(reply({ ok: true }));
    return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
  });
  const rejection = expect(api.receipt(order.id, true)).rejects.toThrow(/printing needs attention/i);
  await settleMicrotasks();
  await jest.advanceTimersByTimeAsync(10001);
  await rejection;
  stalled = false;
  await api.receipt(order.id, true);
  expect(jobs[0].printJobId).toBe(jobs[2].printJobId);
});

test.each([[null], [{ ...order, total: 'invalid amount' }]])('invalid individual list rows cannot replace a valid Register snapshot', async malformed => {
  fetcher.mockResolvedValue(reply([malformed]));
  await api.load();
  expect(api.getOrders().map(row => row.id)).toEqual([order.id]);
  expect(document.getElementById('connection-label')).toHaveTextContent('Offline');
});

test('unpaid and partially paid completed orders show the outstanding amount', async () => {
  fetcher.mockResolvedValue(reply([{ ...order, id: 'due-order', status: 'completed', total: 800, settlement_type: 'due' },
    { ...order, id: 'part-order', status: 'completed', total: 800, settlement_type: 'part', settlement_amount: 300 }]));
  await api.load();
  expect(document.querySelector('[data-order-id="due-order"]')).toHaveTextContent('Unpaid · ₹800.00 due');
  expect(document.querySelector('[data-order-id="part-order"]')).toHaveTextContent('Part paid · ₹500.00 due');
});

test('a summary from the previous authenticated account is discarded before printing', async () => {
  let release;
  const popup = { document: { write: jest.fn(), close: jest.fn() }, close: jest.fn() };
  jest.spyOn(window, 'open').mockReturnValue(popup);
  fetcher.mockImplementation(() => new Promise(resolve => { release = () => resolve(reply({ orders: [order] })); }));
  const summary = api.printSummary();
  window.dispatchEvent(new Event('red-lantern-auth-changed'));
  release();
  await expect(summary).rejects.toThrow(/account changed/);
  expect(popup.document.write).not.toHaveBeenCalled();
  expect(popup.close).toHaveBeenCalled();
});

test('staff changes in another tab clear old Register rows and payment details', () => {
  api.openPayment(order.id, 'cash');
  window.dispatchEvent(new StorageEvent('storage', { key: 'red-lantern-staff-access-profile-v1', oldValue: '{"employee":{"id":"old"}}', newValue: '{"employee":{"id":"new"}}' }));
  expect(api.getOrders()).toEqual([]);
  expect(document.getElementById('payment-modal')).not.toHaveAttribute('open');
  expect(document.getElementById('connection-label')).toHaveTextContent('Refresh needed');
});
