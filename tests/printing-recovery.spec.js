const { test, expect } = require('@playwright/test');

test.use({ serviceWorkers: 'block' });

const printerConfig = {
  printers: [
    { id: 'kitchen', name: 'Kitchen Printer', type: 'kot', enabled: true, deviceName: 'Kitchen queue', workstationId: 'counter-1' },
    { id: 'bill', name: 'Bill Printer', type: 'bill', enabled: true, deviceName: 'Bill queue', workstationId: 'counter-1' },
  ],
  routes: [{ id: 'route-soup', category: 'Soup', printerId: 'kitchen' }],
  tableAreas: [{ name: 'AC', from: 1, to: 4 }],
};

function order(overrides = {}) {
  return {
    id: 'printing-recovery-order', mode: 'table', status: 'accepted', table_area: 'AC', table_number: 2,
    daily_order_number: 7, customer_name: 'Walk-in customer', customer_phone: 'walkin-print-test', total: 120,
    created_at: new Date().toISOString(), items: [{ name: 'Soup', category: 'Soup', quantity: 1, price: 120 }],
    ...overrides,
  };
}

function setupStatus(overrides = {}) {
  return {
    ok: true, version: '2026.10.08.1', platformLabel: 'Windows', ledger: 'ready', workstation: { id: 'counter-1' },
    configuredBillPrinterCount: 1, configuredKotRouteCount: 1,
    printers: [{ id: 'Kitchen queue', name: 'Kitchen queue' }, { id: 'Bill queue', name: 'Bill queue' }],
    ...overrides,
  };
}

async function mockPrintingApp(page, { cloud, bridge, bridgeOrigin = 'http://127.0.0.1:9124' } = {}) {
  const dialogs = [];
  page.on('dialog', async (dialog) => { dialogs.push(dialog.message()); await dialog.dismiss(); });
  if (bridgeOrigin !== 'http://127.0.0.1:9124') {
    await page.addInitScript((origin) => { window.RED_LANTERN_CONFIG = { printBridgeOrigin: origin }; }, bridgeOrigin);
  }
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (await cloud?.(route, path, route.request().method())) return;
    let payload = {};
    if (path === '/api/orders' || path.endsWith('/availability') || path.endsWith('/kitchen-statuses') || path.endsWith('/kot-history')) payload = [];
    if (path.endsWith('/menu')) payload = [{ key: 'soup', name: 'Soup', category: 'Soup', price: 120 }];
    if (path === '/api/orders/operations') payload = { config: printerConfig, menu: [] };
    if (path.endsWith('/live-summary')) payload = { activeOrderCount: 0, sessionOpen: true, acceptingOrders: true };
    if (path.endsWith('/bill-print/claim')) payload = { claimed: false };
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(payload) });
  });
  await page.route(`${bridgeOrigin}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (await bridge?.(route, path, route.request().method())) return;
    let payload = { ok: true };
    if (path === '/health') payload = { ok: true, version: '2026.10.08.1', workstation: { id: 'counter-1' }, ledger: 'ready' };
    if (path === '/v1/setup-status') payload = setupStatus();
    if (path === '/v1/printers') payload = { printers: setupStatus().printers, workstation: { id: 'counter-1' } };
    if (path === '/v1/ledger/actions') payload = { actions: [], action: { status: 'queued' } };
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(payload) });
  });
  await page.goto('/orders.html');
  await page.waitForFunction(() => typeof autoPrintOrder === 'function' && !ordersRefreshInFlight);
  return { dialogs };
}

test('a saved dine-in order stays saved when the KOT service fails', async ({ page }) => {
  const savedRequests = [];
  const { dialogs } = await mockPrintingApp(page, {
    cloud: async (route, path, method) => {
      if (path === '/api/orders/counter' && method === 'POST') {
        savedRequests.push(route.request().postDataJSON());
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ id: order().id, orderNumber: 7, status: 'accepted' }) });
        return true;
      }
      if (path.endsWith('/kots')) {
        await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'column o.service_priority does not exist' }) });
        return true;
      }
      if (path === '/api/orders') {
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify(savedRequests.length ? [order()] : []) });
        return true;
      }
    },
  });
  await page.evaluate(async () => {
    counterTable = { area: 'AC', number: 2 };
    counterCart = [{ name: 'Soup', category: 'Soup', quantity: 1, price: 120 }];
    counterPanel.hidden = false;
    renderCounterOrder();
    await submitDineInAction('kot-print');
  });
  await expect(page.locator('#counter-order-status')).toContainText(/saved|accepted/i);
  await expect(page.locator('#counter-order-status')).toContainText(/print|kitchen|KOT/i);
  expect(await page.evaluate(() => counterCart)).toEqual([]);
  expect(await page.evaluate(() => queuedCounterOrders())).toEqual([]);
  expect(savedRequests).toHaveLength(1);
  await page.evaluate(() => submitDineInAction('kot-print'));
  expect(savedRequests).toHaveLength(1);
  expect(dialogs).toEqual([]);
});

test('test printing falls back safely when an older Bridge lacks the test-print route', async ({ page }) => {
  const fallbackJobs = [];
  const { dialogs } = await mockPrintingApp(page, {
    bridge: async (route, path) => {
      if (path === '/v1/test-print') {
        await route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'Not found.' }) });
        return true;
      }
      if (path === '/v1/print-kot') fallbackJobs.push(route.request().postDataJSON());
    },
  });
  await page.evaluate((config) => {
    operationsConfig = config;
    installedSystemPrinters = [{ id: 'Kitchen queue', name: 'Kitchen queue' }];
    operationsPanel.hidden = false;
    operationsTab = 'printers';
    renderOperations();
  }, printerConfig);
  const testButton = page.locator('[data-test-printer="kitchen"]');
  await testButton.click();
  await expect(testButton).toContainText(/test sent|sent|printed/i);
  expect(fallbackJobs).toHaveLength(1);
  expect(fallbackJobs[0].printerName).toBe('Kitchen queue');
  expect(JSON.stringify(fallbackJobs[0])).toMatch(/test/i);
  expect(JSON.stringify(fallbackJobs[0])).not.toContain(order().id);
  expect(dialogs).toEqual([]);
});

test('printer readiness uses the latest cloud routes before judging the local setup', async ({ page }) => {
  let syncedConfig = null;
  const calls = [];
  await mockPrintingApp(page, {
    bridge: async (route, path, method) => {
      if (path === '/v1/config' && method === 'PUT') {
        calls.push('config');
        syncedConfig = route.request().postDataJSON();
      }
      if (path === '/v1/setup-status') {
        calls.push('status');
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify(setupStatus({
          configuredBillPrinterCount: syncedConfig ? 1 : 0,
          configuredKotRouteCount: syncedConfig ? 1 : 0,
        })) });
        return true;
      }
    },
  });
  await page.evaluate(() => checkPrintBridgeSetup());
  expect(syncedConfig.config || syncedConfig).toMatchObject({ printers: printerConfig.printers, routes: printerConfig.routes });
  const firstStatus = calls.indexOf('status');
  expect(firstStatus).toBeGreaterThan(0);
  expect(calls.slice(0, firstStatus)).toContain('config');
  expect(await page.evaluate(() => printBridgeSetupStatus.configuredBillPrinterCount)).toBe(1);
  expect(await page.evaluate(() => printBridgeSetupStatus.configuredKotRouteCount)).toBe(1);
});

test('recovery sends every saved KOT using stable job IDs, including older rounds', async ({ page }) => {
  const jobs = [];
  const recoveryOrder = order({ status: 'preparing' });
  const history = [1, 2].map((number) => ({
    kot_number: number,
    tickets: [{ printerId: 'kitchen', printerName: 'Kitchen queue', printerLabel: 'Kitchen Printer', items: [{ name: `Round ${number} soup`, quantity: 1 }] }],
  }));
  await mockPrintingApp(page, {
    cloud: async (route, path, method) => {
      if (path.endsWith('/kots')) {
        await route.fulfill({ status: method === 'POST' ? 409 : 200, contentType: 'application/json', body: JSON.stringify(method === 'POST'
          ? { error: 'No new items.', latestKot: history[1], order: recoveryOrder }
          : history) });
        return true;
      }
    },
    bridge: async (route, path) => {
      if (path === '/v1/print-kot') jobs.push(route.request().postDataJSON());
    },
  });
  const first = await page.evaluate((savedOrder) => autoPrintOrder(savedOrder), recoveryOrder);
  expect(first.ok).toBe(true);
  expect(jobs.map((job) => job.printJobId)).toEqual([
    `auto-kot:${recoveryOrder.id}:1:Kitchen queue`,
    `auto-kot:${recoveryOrder.id}:2:Kitchen queue`,
  ]);
  // An app restart clears browser memory, so only the durable Bridge job IDs
  // can prevent duplicate slips when the same saved rounds are scanned again.
  await page.reload();
  await page.waitForFunction(() => typeof autoPrintOrder === 'function' && !ordersRefreshInFlight);
  const second = await page.evaluate((savedOrder) => autoPrintOrder(savedOrder), recoveryOrder);
  expect(second.ok).toBe(true);
  expect(jobs.slice(2).map((job) => job.printJobId)).toEqual(jobs.slice(0, 2).map((job) => job.printJobId));
});

test('a returning Bridge recovers saved orders at the configured origin without a second slip', async ({ page }) => {
  let bridgeAvailable = false;
  const submittedJobIds = [];
  const physicalJobIds = new Set();
  const unexpectedDefaultRequests = [];
  const savedOrder = order();
  page.on('request', (request) => {
    if (request.url().startsWith('http://127.0.0.1:9124/')) unexpectedDefaultRequests.push(request.url());
  });
  const { dialogs } = await mockPrintingApp(page, {
    bridgeOrigin: 'http://127.0.0.1:9234',
    cloud: async (route, path, method) => {
      if (path === '/api/orders') {
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify([savedOrder]) });
        return true;
      }
      if (path.endsWith('/kots')) {
        const savedKot = { kot_number: 1, tickets: [{ printerName: 'Kitchen queue', items: savedOrder.items }] };
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify(method === 'POST'
          ? { kotNumber: 1, tickets: savedKot.tickets, order: savedOrder }
          : [savedKot]) });
        return true;
      }
    },
    bridge: async (route, path) => {
      if (path === '/health' && !bridgeAvailable) {
        await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'Printer service is starting.' }) });
        return true;
      }
      if (path === '/v1/print-kot') {
        const { printJobId } = route.request().postDataJSON();
        submittedJobIds.push(printJobId);
        const duplicate = physicalJobIds.has(printJobId);
        physicalJobIds.add(printJobId);
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, duplicate }) });
        return true;
      }
    },
  });
  await expect(page.locator('#orders-printing-status')).toContainText(/saved order.*waiting for printing/i);
  expect(submittedJobIds).toEqual([]);
  bridgeAvailable = true;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect.poll(() => submittedJobIds.length).toBe(1);
  await expect(page.locator('#orders-printing-status')).toBeHidden();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.evaluate(() => recoverPendingPrinting());
  expect(physicalJobIds.size).toBe(1);
  expect(submittedJobIds).toEqual([`auto-kot:${savedOrder.id}:1:Kitchen queue`]);
  expect(unexpectedDefaultRequests).toEqual([]);
  expect(dialogs).toEqual([]);
});

test('a busy bill claim remains pending and recovers after the cloud lease becomes available', async ({ page }) => {
  let claimAvailable = false;
  const billJobs = [];
  const savedOrder = order({ mode: 'counter', fulfillment_type: 'pickup' });
  await mockPrintingApp(page, {
    cloud: async (route, path, method) => {
      let payload;
      if (path.endsWith('/bill-print/claim')) payload = { claimed: claimAvailable, status: 'printing' };
      else if (path.endsWith('/print')) payload = savedOrder;
      else if (path.endsWith('/kots')) {
        const savedKot = { kot_number: 1, tickets: [{ printerName: 'Kitchen queue', items: savedOrder.items }] };
        payload = method === 'POST' ? { kotNumber: 1, tickets: savedKot.tickets, order: savedOrder } : [savedKot];
      } else return;
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(payload) });
      return true;
    },
    bridge: async (route, path) => {
      if (path === '/v1/print-bill') billJobs.push(route.request().postDataJSON());
    },
  });
  const busyResult = await page.evaluate((saved) => autoPrintOrder(saved), savedOrder);
  expect(busyResult.ok).toBe(false);
  expect(billJobs).toEqual([]);
  await expect(page.locator('#orders-printing-status')).toBeVisible();
  claimAvailable = true;
  const recovered = await page.evaluate((saved) => autoPrintOrder(saved), savedOrder);
  expect(recovered.ok).toBe(true);
  expect(billJobs).toHaveLength(1);
  expect(billJobs[0].printJobId).toBe(`auto-bill:${savedOrder.id}`);
  await expect(page.locator('#orders-printing-status')).toBeHidden();
  await page.evaluate((saved) => autoPrintOrder(saved), savedOrder);
  expect(billJobs).toHaveLength(1);
});

test('healthy local printers do not show full readiness while the cloud schema check fails', async ({ page }) => {
  await mockPrintingApp(page, {
    cloud: async (route, path) => {
      if (path !== '/api/orders/readiness') return;
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ ok: false, schemaReady: false }) });
      return true;
    },
  });
  await page.evaluate(async (config) => {
    operationsConfig = config;
    operationsPanel.hidden = false;
    operationsTab = 'setup';
    await checkPrintBridgeSetup();
    renderPrintBridgeSetup();
  }, printerConfig);
  expect(await page.evaluate(() => printBridgeSetupStatus.cloud)).toBe(false);
  await expect(page.locator('.simple-printing-card')).not.toContainText('Printing is ready');
  await expect(page.locator('.simple-printing-card .is-warning')).toBeVisible();
});

test('a confirmed takeaway still sends its KOT when the local ledger acknowledgement fails', async ({ page }) => {
  const savedRequests = [];
  const kotJobs = [];
  const savedOrder = order({ mode: 'counter', fulfillment_type: 'pickup' });
  const { dialogs } = await mockPrintingApp(page, {
    cloud: async (route, path, method) => {
      if (path === '/api/orders/counter' && method === 'POST') {
        savedRequests.push(route.request().postDataJSON());
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ id: savedOrder.id, orderNumber: 7, status: 'accepted' }) });
        return true;
      }
      if (path.endsWith('/kots')) {
        const savedKot = { kot_number: 1, tickets: [{ printerName: 'Kitchen queue', items: savedOrder.items }] };
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify(method === 'POST'
          ? { kotNumber: 1, tickets: savedKot.tickets, order: savedOrder }
          : [savedKot]) });
        return true;
      }
    },
    bridge: async (route, path) => {
      if (path.startsWith('/v1/ledger/actions/') && path.endsWith('/synced')) {
        await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Local ledger update failed.' }) });
        return true;
      }
      if (path === '/v1/print-kot') kotJobs.push(route.request().postDataJSON());
    },
  });
  await page.evaluate(() => {
    counterTable = null;
    counterCart = [{ name: 'Soup', category: 'Soup', quantity: 1, price: 120 }];
    counterPanel.hidden = false;
    renderCounterOrder();
  });
  await page.locator('#counter-place-order').click();
  await expect(page.locator('#counter-order-status')).toContainText(/accepted|saved/i);
  await expect.poll(() => kotJobs.length).toBe(1);
  expect(await page.evaluate(() => counterCart)).toEqual([]);
  expect(await page.evaluate(() => queuedCounterOrders())).toEqual([]);
  expect(savedRequests).toHaveLength(1);
  await page.locator('#counter-place-order').click();
  expect(savedRequests).toHaveLength(1);
  expect(dialogs).toEqual([]);
});

test('failed dine-in bill printing keeps the order saved and does not mark it printed or open a popup', async ({ page }) => {
  const savedRequests = [];
  const markedPrinted = [];
  const popups = [];
  page.on('popup', (popup) => popups.push(popup));
  const { dialogs } = await mockPrintingApp(page, {
    cloud: async (route, path, method) => {
      if (path === '/api/orders/counter' && method === 'POST') {
        savedRequests.push(route.request().postDataJSON());
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ id: order().id, orderNumber: 7, status: 'accepted' }) });
        return true;
      }
      if (path.endsWith('/print')) {
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify(order()) });
        return true;
      }
      if (path.endsWith('/bill-printed')) markedPrinted.push(path);
    },
    bridge: async (route, path) => {
      if (path !== '/v1/print-bill') return;
      await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Bill printer could not accept the job.' }) });
      return true;
    },
  });
  await page.evaluate(async () => {
    counterTable = { area: 'AC', number: 2 };
    counterCart = [{ name: 'Soup', category: 'Soup', quantity: 1, price: 120 }];
    counterPanel.hidden = false;
    renderCounterOrder();
    await submitDineInAction('print');
  });
  await expect(page.locator('#counter-order-status')).toContainText(/order saved/i);
  expect(await page.evaluate(() => counterCart)).toEqual([]);
  expect(await page.evaluate(() => queuedCounterOrders())).toEqual([]);
  expect(savedRequests).toHaveLength(1);
  expect(markedPrinted).toEqual([]);
  expect(popups).toEqual([]);
  expect(dialogs).toEqual([]);
});

test('a stalled cloud request expires and leaves printing recovery available', async ({ page }) => {
  await mockPrintingApp(page);
  const outcome = await page.evaluate(async () => {
    const originalFetch = window.fetch;
    window.fetch = (input, options) => input === '/api/hang'
      ? new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }))
      : originalFetch(input, options);
    const startedAt = performance.now();
    let status;
    try { await fetchOrdersService('/api/hang', {}, 50); }
    catch (error) { status = error.status; }
    finally { window.fetch = originalFetch; }
    const elapsed = performance.now() - startedAt;
    await recoverPendingPrinting();
    return { status, elapsed, recoveryActive: !!printingRecoveryRequest, activePrints: autoPrintInFlight.size };
  });
  expect(outcome.status).toBe(503);
  expect(outcome.elapsed).toBeGreaterThanOrEqual(40);
  expect(outcome.elapsed).toBeLessThan(1000);
  expect(outcome.recoveryActive).toBe(false);
  expect(outcome.activePrints).toBe(0);
});
