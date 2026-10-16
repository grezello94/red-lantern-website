const { test, expect } = require('@playwright/test');

test.use({ serviceWorkers: 'block' });

const order = {
  id: 'occupied-table', mode: 'table', status: 'saved', table_area: 'AC', table_number: 1,
  daily_order_number: 1, customer_name: 'Anita', customer_phone: '9999999999',
  special_request: 'Less spicy', created_at: new Date().toISOString(), updated_at: '2026-10-15T06:00:00.000Z', total: 400,
  items: [{ name: 'Veg Crispy', category: 'Starters', quantity: 2, price: 200 }],
};
const menu = [{ key: 'food:veg-crispy', menuType: 'food', name: 'Veg Crispy', category: 'Starters', price: 200 }];
const config = { printers: [], routes: [], tableAreas: [{ name: 'AC', from: 1, to: 2 }] };

async function ordersApp(page, options = {}) {
  const actions = [];
  const dialogs = [];
  const reads = [];
  const requests = [];
  // Keep tests independent of periodic reconciliation; explicit calls exercise it below.
  await page.addInitScript(() => {
    window.testIntervals = [];
    window.setInterval = (callback, delay) => { window.testIntervals.push({ callback, delay }); return 0; };
  });
  page.on('dialog', async dialog => {
    dialogs.push(dialog.message());
    if (options.onDialog) await options.onDialog(dialog);
    else await dialog.dismiss();
  });
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    if (options.onCloud && await options.onCloud(route, path)) return;
    let payload = { ok: true };
    if (path === '/api/orders') {
      reads.push(url.search);
      if (options.onRead && await options.onRead(route, url)) return;
      payload = url.searchParams.get('history') === '1' ? [] : [options.order || order];
    } else if (path === '/api/orders/counter') {
      requests.push(request.postDataJSON());
      if (options.onCounter && await options.onCounter(route, request)) return;
      payload = { id: 'saved-counter', orderNumber: 2, status: 'saved' };
    } else if (path === '/api/orders/menu') payload = menu;
    else if (path === '/api/orders/operations') payload = { config: options.config || config, menu };
    else if (path === '/api/orders/availability' || path.endsWith('/kots') || path.endsWith('/kot-history') || path.endsWith('/kitchen-statuses')) payload = [];
    else if (path === '/api/orders/live-summary') payload = { activeOrderCount: 1, latestOrderNumber: 1, sessionOpen: true, acceptingOrders: true };
    else if (path === '/api/loyalty') payload = { points: 0 };
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(payload) });
  });
  await page.route('http://127.0.0.1:9124/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (options.onBridge && await options.onBridge(route, path)) return;
    let payload = { ok: true, version: '2026.10.08.2', workstation: { id: 'test' }, ledger: 'ready' };
    if (path === '/v1/config') payload.config = config;
    if (path === '/v1/printers') payload.printers = [];
    if (path === '/v1/ledger/actions') {
      payload.actions = options.queuedActions || [];
      if (request.method() === 'POST') { actions.push(request.postDataJSON()); payload.action = { status: 'queued' }; }
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(payload) });
  });
  await page.goto('/orders.html');
  await expect(page.locator('#table-view-content [data-dine-table-number]')).toHaveCount(2);
  await expect(page.locator('[data-dine-table-number="1"]')).toHaveClass(options.order?.bill_printed_at ? /is-printed/ : /is-running/);
  return { actions, dialogs, reads, requests };
}

test('opening an occupied table loads its guest and items', async ({ page }) => {
  await ordersApp(page);
  await page.locator('[data-dine-table-number="1"]').click();
  await expect(page.locator('#counter-customer-name')).toHaveValue('Anita');
  await expect(page.locator('#counter-customer-phone')).toHaveValue('9999999999');
  await expect(page.locator('#counter-special-request')).toHaveValue('Less spicy');
  await expect(page.locator('#counter-cart-items .counter-cart-line')).toHaveCount(1);
  await expect(page.locator('#counter-total')).toHaveText('₹400');
});

test('a zero-value discounted order keeps its authoritative total in the live list', async ({ page }) => {
  await ordersApp(page, { order: { ...order, total: 0, discount_amount: 400 } });
  await expect(page.locator('[data-order-id="occupied-table"] .totals strong')).toHaveText('Total ₹0');
});

test('account changes clear Orders guest data and reject an older in-flight refresh', async ({ page }) => {
  let hold = false, release, reached;
  const waiting = new Promise(resolve => { release = resolve; });
  const requested = new Promise(resolve => { reached = resolve; });
  await ordersApp(page, { onRead: async route => {
    if (!hold) return false;
    reached(); await waiting;
    await route.fulfill({ json: [order] });
    return true;
  } });
  await page.locator('[data-dine-table-number="1"]').click();
  await expect(page.locator('#counter-customer-name')).toHaveValue('Anita');
  hold = true;
  await page.evaluate(() => { window.olderOrdersLoad = loadOrders(); });
  await requested;
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('red-lantern-auth-changed')));
  release();
  await page.evaluate(() => window.olderOrdersLoad);
  await expect(page.locator('#counter-customer-name')).toHaveValue('');
  await expect(page.locator('#counter-customer-phone')).toHaveValue('');
  await expect(page.locator('#counter-cart-items .counter-cart-line')).toHaveCount(0);
  await expect(page.locator('[data-order-id="occupied-table"]')).toHaveCount(0);
  await expect(page.locator('#table-view-content')).toContainText('Sign in');
});

test('expired Orders access clears the displayed guest and table work', async ({ page }) => {
  let expired = false;
  await ordersApp(page, { onRead: async route => {
    if (!expired) return false;
    await route.fulfill({ status: 401, json: { error: 'Sign in again' } });
    return true;
  } });
  await page.locator('[data-dine-table-number="1"]').click();
  expired = true;
  await page.evaluate(() => loadOrders());
  await expect(page.locator('#counter-customer-name')).toHaveValue('');
  await expect(page.locator('[data-order-id="occupied-table"]')).toHaveCount(0);
  await expect(page.locator('#table-view-content')).toContainText('Sign in');
});

test('reopened discounted bills retain their payable total and cannot redeem more wallet points', async ({ page }) => {
  const discounted = { ...order, total: 430, discount_amount: 50, loyalty_points_redeemed: 20,
    items: [{ ...order.items[0], price: 250 }] };
  const { requests } = await ordersApp(page, { order: discounted });
  await page.locator('[data-dine-table-number="1"]').click();
  await expect(page.locator('#counter-total')).toHaveText('₹430');
  await expect(page.locator('#mobile-cart-total')).toHaveText('₹430');
  await expect(page.locator('#counter-wallet-redeem')).toBeDisabled();
  await page.evaluate(() => loadCounterLoyalty());
  await expect(page.locator('#counter-wallet-redeem')).toBeDisabled();
  await page.locator('[data-dine-action="split"]').click();
  await expect(page.locator('.split-group-row small')).toHaveText(['₹215', '₹215']);
  await page.locator('.split-cancel').click();
  const parts = await page.evaluate(receipt => splitReceiptParts(receipt, {
    mode: 'item', parts: [{ label: 'First', items: [{ ...receipt.items[0], quantity: 1 }] }, { label: 'Second', items: [{ ...receipt.items[0], quantity: 1 }] }],
  }), discounted);
  expect(parts.map(part => part.total)).toEqual([215, 215]);
  await page.evaluate(() => { document.getElementById('counter-wallet-redeem').value = '100'; });
  await page.locator('[data-dine-action="save"]').click();
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0].loyaltyPoints).toBe(0);
});

test('a wallet lookup from the previous workspace cannot unlock redemption on an existing bill', async ({ page }) => {
  await ordersApp(page);
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  await page.route('**/api/loyalty', async route => {
    await blocked;
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ points: 1000 }) });
  });
  await page.locator('[data-fulfillment-filter="pickup"]').click();
  await page.locator('#counter-customer-phone').fill('8888888888');
  await page.evaluate(() => { window.pendingWallet = loadCounterLoyalty(); });
  await page.evaluate(() => openCounterOrder({ area: 'AC', number: 1, orderId: 'occupied-table' }));
  release();
  await page.evaluate(() => window.pendingWallet);
  await expect(page.locator('#counter-wallet-redeem')).toBeDisabled();
  await expect(page.locator('#counter-total')).toHaveText('₹400');
});

test('switching from a table to Takeaway opens a clean order workspace', async ({ page }) => {
  await ordersApp(page);
  await page.locator('[data-view-table-order="occupied-table"]').click();
  await expect(page.locator('#counter-total')).toHaveText('₹400');
  await page.locator('[data-fulfillment-filter="pickup"]').click();
  await expect(page.locator('#counter-order-panel')).toBeVisible();
  await expect(page.locator('#counter-customer-name')).toHaveValue('');
  await expect(page.locator('#counter-cart-items .counter-cart-line')).toHaveCount(0);
  await expect(page.locator('#counter-place-order')).toBeVisible();
});

test('saving an existing table sends its full draft and the revision captured when opened', async ({ page }) => {
  const { requests, dialogs } = await ordersApp(page);
  await page.locator('[data-dine-table-number="1"]').click();
  await page.evaluate(() => { window.currentEmployee = { requireEditReason: true }; window.employeeCan = () => true; });
  await page.locator('[data-counter-item="0"]').click();
  await page.evaluate(() => { orderRecords.get('occupied-table').updated_at = '2026-10-15T06:01:00.000Z'; });
  await page.locator('[data-dine-action="save"]').click();
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0]).toMatchObject({
    tableOrderId: 'occupied-table', expectedUpdatedAt: order.updated_at,
    items: [{ name: 'Veg Crispy', quantity: 3, price: 200 }],
  });
  expect(dialogs).toEqual([]);
});

test('different dine-in actions cannot submit the same draft concurrently', async ({ page }) => {
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const { requests } = await ordersApp(page, { onCounter: async route => {
    await blocked;
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ id: 'occupied-table', status: 'saved' }) });
    return true;
  } });
  await page.locator('[data-dine-table-number="1"]').click();
  await page.evaluate(() => { window.pendingSave = submitDineInAction('save'); });
  await expect.poll(() => requests.length).toBe(1);
  await expect(page.locator('[data-dine-action="hold"]')).toBeDisabled();
  await page.evaluate(() => submitDineInAction('hold'));
  expect(requests).toHaveLength(1);
  release();
  await page.evaluate(() => window.pendingSave);
});

test('cancelling the required edit reason retains the changed table draft', async ({ page }) => {
  const { requests, dialogs } = await ordersApp(page);
  await page.locator('[data-dine-table-number="1"]').click();
  await page.evaluate(() => { window.currentEmployee = { requireEditReason: true }; window.employeeCan = () => true; });
  await page.locator('[data-counter-change="-1"]').click();
  await page.locator('[data-dine-action="save"]').click();
  expect(dialogs).toHaveLength(1);
  expect(requests).toHaveLength(0);
  await expect(page.locator('#counter-total')).toHaveText('₹200');
  await expect(page.locator('[data-dine-action="save"]')).toBeEnabled();
});

test('reducing a table line includes the employee edit reason', async ({ page }) => {
  const { requests } = await ordersApp(page, { onDialog: dialog => dialog.accept('Guest changed the order') });
  await page.locator('[data-dine-table-number="1"]').click();
  await page.evaluate(() => { window.currentEmployee = { requireEditReason: true }; window.employeeCan = () => true; });
  await page.locator('[data-counter-change="-1"]').click();
  await page.locator('[data-dine-action="save"]').click();
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0]).toMatchObject({ reason: 'Guest changed the order', items: [{ quantity: 1 }] });
});

test('offline status updates render the saved status without a script error', async ({ page }) => {
  const { actions, dialogs } = await ordersApp(page);
  await page.locator('#live-orders-toggle').click();
  await page.evaluate(() => Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false }));
  await page.evaluate(() => setStatus('occupied-table', 'accepted'));
  expect(actions).toContainEqual(expect.objectContaining({ type: 'order-status', payload: expect.objectContaining({ status: 'accepted' }) }));
  await expect(page.locator('#orders [data-order-id="occupied-table"] .order-status')).toHaveText('accepted');
  expect(dialogs).toEqual([]);
});

test('view changes during a pending refresh request the selected view before completing', async ({ page }) => {
  let release;
  let blockNext = false;
  const blocked = new Promise(resolve => { release = resolve; });
  const { reads } = await ordersApp(page, {
    onRead: async route => {
      if (!blockNext) return false;
      blockNext = false;
      await blocked;
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify([order]) });
      return true;
    },
  });
  await page.locator('#live-orders-toggle').click();
  blockNext = true;
  const count = reads.length;
  await page.evaluate(() => { window.pendingRefresh = loadOrders(); });
  await expect.poll(() => reads.length).toBeGreaterThan(count);
  await page.locator('[data-order-view="history"]').click();
  release();
  await page.evaluate(() => window.pendingRefresh);
  expect(reads.some(search => new URLSearchParams(search).get('history') === '1')).toBe(true);
  await expect(page.locator('#orders [data-order-id]')).toHaveCount(0);
});

test('automatic polling does not keep a slow explicit refresh pending', async ({ page }) => {
  let release;
  let blockNext = false;
  const blocked = new Promise(resolve => { release = resolve; });
  const { reads } = await ordersApp(page, { onRead: async route => {
    if (!blockNext) return false;
    blockNext = false;
    await blocked;
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify([order]) });
    return true;
  } });
  await page.evaluate(() => loadOrders());
  const count = reads.length;
  blockNext = true;
  await page.evaluate(() => { window.pendingRefresh = loadOrders(); });
  await expect.poll(() => reads.length).toBe(count + 1);
  await page.evaluate(() => window.testIntervals.filter(interval => interval.delay === 3000).forEach(interval => interval.callback()));
  release();
  await page.evaluate(() => window.pendingRefresh);
  expect(reads).toHaveLength(count + 1);
});

test('history does not erase the current table snapshot', async ({ page }) => {
  await ordersApp(page);
  await page.locator('#live-orders-toggle').click();
  await page.locator('[data-order-view="history"]').click();
  await expect(page.locator('#orders [data-order-id]')).toHaveCount(0);
  const cached = await page.evaluate(() => JSON.parse(localStorage.getItem('red-lantern-table-order-snapshot')));
  expect(cached.map(row => row.id)).toContain('occupied-table');
  await page.locator('#new-order-action').click();
  await expect(page.locator('[data-dine-table-number="1"]')).toHaveClass(/is-running/);
});

for (const status of [429, 401, 403]) test(`HTTP ${status} browser orders remain queued and can sync after recovery`, async ({ page }) => {
  let rateLimited = true;
  await ordersApp(page, { onCounter: async route => {
    if (!rateLimited) return false;
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ error: 'Try again shortly.' }) });
    return true;
  } });
  await page.waitForTimeout(400);
  await page.evaluate(() => localStorage.setItem('red-lantern-counter-orders', JSON.stringify([{ clientRequestId: 'rate-limited', items: [{ name: 'Veg Crispy', quantity: 1, price: 200 }] }])));
  await page.evaluate(() => flushQueuedCounterOrders());
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('red-lantern-counter-orders')).length)).toBe(1);
  rateLimited = false;
  await page.evaluate(() => flushQueuedCounterOrders());
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('red-lantern-counter-orders')).length)).toBe(0);
});

test('syncing an order preserves another order queued during its request', async ({ page }) => {
  let release;
  let blockNext = true;
  const blocked = new Promise(resolve => { release = resolve; });
  const { requests } = await ordersApp(page, { onCounter: async route => {
    if (!blockNext) return false;
    blockNext = false;
    await blocked;
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ id: 'saved-first', status: 'saved' }) });
    return true;
  } });
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    localStorage.setItem('red-lantern-counter-orders', JSON.stringify([{ clientRequestId: 'first', items: [] }]));
    window.pendingSync = flushQueuedCounterOrders();
  });
  await expect.poll(() => requests.length).toBe(1);
  await page.evaluate(() => {
    const queued = JSON.parse(localStorage.getItem('red-lantern-counter-orders'));
    queued.push({ clientRequestId: 'second', items: [] });
    localStorage.setItem('red-lantern-counter-orders', JSON.stringify(queued));
  });
  release();
  await page.evaluate(() => window.pendingSync);
  expect(requests.map(request => request.clientRequestId)).toEqual(['first', 'second']);
});

for (const storage of ['browser', 'bridge']) test(`a permanently rejected ${storage} order releases its offline table reservation`, async ({ page }) => {
  const queuedActions = [];
  await ordersApp(page, { queuedActions, onCounter: async route => {
    await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'This menu item no longer exists.' }) });
    return true;
  } });
  await page.waitForTimeout(400);
  const payload = { clientRequestId: 'invalid-table', tableArea: 'AC', tableNumber: 2, items: [] };
  if (storage === 'bridge') queuedActions.push({ id: payload.clientRequestId, type: 'counter-order', payload });
  await page.evaluate(({ payload, storage }) => {
    if (storage === 'browser') saveQueuedCounterOrders([payload]);
    reserveOfflineTable(payload);
  }, { payload, storage });
  await expect(page.locator('[data-dine-table-number="2"]')).toHaveClass(/is-running/);
  await page.evaluate(() => flushQueuedCounterOrders());
  await expect(page.locator('[data-dine-table-number="2"]')).toHaveClass(/is-blank/);
  const cached = await page.evaluate(() => JSON.parse(localStorage.getItem('red-lantern-table-order-snapshot')));
  expect(cached.map(row => row.id)).not.toContain('offline:invalid-table');
});

const billConfig = { ...config, printers: [{ id: 'bill', name: 'Bill printer', type: 'bill', enabled: true, deviceName: 'Bill queue', workstationId: 'test' }] };
for (const state of ['pending', 'uncertain']) test(`a ${state} manual print does not mark the table bill printed`, async ({ page }) => {
  const marked = [];
  const { dialogs } = await ordersApp(page, { config: billConfig,
    onCloud: async (route, path) => {
      if (path.endsWith('/bill-printed')) marked.push(path);
      if (!path.endsWith('/print')) return false;
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(order) });
      return true;
    },
    onBridge: async (route, path) => {
      if (path !== '/v1/print-bill') return false;
      await route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ ok: true, [state]: true }) });
      return true;
    },
  });
  await page.locator('[data-print-table-bill="occupied-table"]').click();
  await expect.poll(() => dialogs.length).toBe(1);
  expect(marked).toEqual([]);
});

test('concurrent manual print requests send a single receipt job', async ({ page }) => {
  const jobs = [];
  await ordersApp(page, { config: billConfig,
    onCloud: async (route, path) => {
      if (!path.endsWith('/print')) return false;
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(order) });
      return true;
    },
    onBridge: async (route, path) => { if (path === '/v1/print-bill') jobs.push(route.request().postDataJSON()); return false; },
  });
  await page.evaluate(() => Promise.all([printOrder('occupied-table', null, { requireBridge: true }), printOrder('occupied-table', null, { requireBridge: true })]));
  expect(jobs).toHaveLength(1);
});

test('zero-value bills and tiny split totals cannot gain a payable amount', async ({ page }) => {
  await ordersApp(page);
  const totals = await page.evaluate(() => {
    const receipt = { items: [{ name: 'Soup', price: 100, quantity: 1 }], total: 0 };
    const zero = splitReceiptParts(receipt, { mode: 'equal', parts: [{ label: 'First', percentage: 50 }, { label: 'Second', percentage: 50 }] });
    const tiny = splitReceiptParts({ ...receipt, total: 0.10 }, { mode: 'equal', parts: Array.from({ length: 20 }, (_, index) => ({ label: `Part ${index + 1}`, percentage: 5 })) });
    return { zero: zero.reduce((sum, part) => sum + Math.round(part.total * 100), 0), tiny: tiny.reduce((sum, part) => sum + Math.round(part.total * 100), 0) };
  });
  expect(totals).toEqual({ zero: 0, tiny: 10 });
});

test('split percentages must be positive even when their sum is 100', async ({ page }) => {
  const { dialogs } = await ordersApp(page);
  await page.locator('[data-dine-table-number="1"]').click();
  await page.evaluate(() => { openSplitBill(); splitPercentages = [-50, 150]; saveSplitBill(); });
  expect(dialogs).toHaveLength(1);
  await expect(page.locator('#split-bill-dialog')).toBeVisible();
  expect(await page.evaluate(() => counterBillSplit)).toBeNull();
});

test('fractional offline item edits are rejected before saving to the ledger', async ({ page }) => {
  const { actions, dialogs } = await ordersApp(page);
  await page.evaluate(() => { Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false }); openModifyOrder('occupied-table'); });
  await page.locator('[data-modify-quantity]').fill('1.5');
  await page.locator('.modify-save').click();
  await expect.poll(() => dialogs.length).toBe(1);
  expect(actions).toHaveLength(0);
  await expect(page.locator('#modify-order-dialog')).toBeVisible();
});

test('valid offline quantity edits update the displayed order total', async ({ page }) => {
  await ordersApp(page);
  await page.locator('#live-orders-toggle').click();
  await page.evaluate(() => { Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false }); openModifyOrder('occupied-table'); });
  await page.locator('[data-modify-quantity]').fill('1');
  await page.locator('.modify-save').click();
  await expect(page.locator('#modify-order-dialog')).toBeHidden();
  await expect(page.locator('#orders .totals strong')).toHaveText('Total ₹200');
});

test('table settlement retains paise and prevents underpaid offline cash settlements', async ({ page }) => {
  const printed = { ...order, status: 'ready', bill_printed_at: new Date().toISOString(), total: 400.55 };
  const { actions } = await ordersApp(page, { order: printed });
  await page.locator('[data-dine-table-number="1"]').click();
  await expect(page.locator('#settlement-amount')).toHaveValue('400.55');
  await page.evaluate(() => Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false }));
  await page.locator('#settlement-amount').fill('100');
  await page.locator('.settle-confirm').click();
  await expect(page.locator('#settle-table-dialog')).toBeVisible();
  await expect(page.locator('#settle-table-status')).toContainText(/amount|payment|bill/i);
  expect(actions).toHaveLength(0);
});

test('a failed bridge sync remains visibly pending instead of claiming success', async ({ page }) => {
  const actions = [];
  await ordersApp(page, { queuedActions: actions, onCounter: async route => {
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Try again' }) });
    return true;
  } });
  await page.waitForTimeout(400);
  actions.push({ id: 'still-pending', type: 'counter-order', payload: { clientRequestId: 'still-pending', items: [] } });
  await page.evaluate(() => flushQueuedCounterOrders());
  await expect(page.locator('#orders-connectivity')).toContainText('waiting to sync');
});

for (const storage of ['browser', 'bridge']) test(`a queued ${storage} order cannot silently submit under a different employee`, async ({ page }) => {
  const queuedActions = [];
  const { requests } = await ordersApp(page, { queuedActions });
  await page.waitForTimeout(400);
  const payload = { clientRequestId: 'bound-order', actorEmployeeId: 'first-employee', items: [] };
  if (storage === 'bridge') queuedActions.push({ id: payload.clientRequestId, type: 'counter-order', payload });
  await page.evaluate(({ storage, payload }) => {
    window.currentEmployee = { id: 'second-employee' }; window.employeeCan = () => true;
    if (storage === 'browser') saveQueuedCounterOrders([payload]);
  }, { storage, payload });
  await page.evaluate(() => flushQueuedCounterOrders());
  expect(requests).toHaveLength(0);
  await expect(page.locator('#orders-connectivity')).toContainText(/another staff account/);
  await page.evaluate(() => { window.currentEmployee = { id: 'first-employee' }; });
  await page.evaluate(() => flushQueuedCounterOrders());
  expect(requests).toHaveLength(1);
});

test('a pending offline edit retains its total across refreshes and blocks another stale edit', async ({ page }) => {
  const { actions, dialogs } = await ordersApp(page);
  await page.locator('#live-orders-toggle').click();
  await page.evaluate(() => { Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false }); openModifyOrder('occupied-table'); });
  await page.locator('[data-modify-quantity]').fill('1');
  await page.locator('.modify-save').click();
  await expect(page.locator('#modify-order-dialog')).toBeHidden();
  await page.evaluate(() => loadOrders());
  await expect(page.locator('#orders .totals strong')).toHaveText('Total ₹200');
  await page.evaluate(() => openModifyOrder('occupied-table'));
  expect(dialogs.at(-1)).toMatch(/waiting to sync/);
  expect(actions).toHaveLength(1);
});

test('malformed success responses cannot erase a queued order', async ({ page }) => {
  await ordersApp(page, { onCounter: async route => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{invalid json' });
    return true;
  } });
  await page.waitForTimeout(400);
  await page.evaluate(() => saveQueuedCounterOrders([{ clientRequestId: 'unconfirmed', items: [] }]));
  await page.evaluate(() => flushQueuedCounterOrders());
  expect(await page.evaluate(() => queuedCounterOrders().map(payload => payload.clientRequestId))).toEqual(['unconfirmed']);
});

test('retrying an ambiguous manual print reuses its print job identifier', async ({ page }) => {
  const jobs = [];
  await ordersApp(page, { config: billConfig,
    onCloud: async (route, path) => {
      if (!path.endsWith('/print')) return false;
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify(order) });
      return true;
    },
    onBridge: async (route, path) => {
      if (path !== '/v1/print-bill') return false;
      jobs.push(route.request().postDataJSON());
      await route.fulfill({ status: jobs.length === 1 ? 202 : 200, contentType: 'application/json', body: JSON.stringify(jobs.length === 1 ? { pending: true } : { ok: true }) });
      return true;
    },
  });
  await page.evaluate(async () => { try { await printOrder('occupied-table', null, { requireBridge: true }); } catch {} await printOrder('occupied-table', null, { requireBridge: true }); });
  expect(jobs).toHaveLength(2);
  expect(jobs[0].printJobId).toBe(jobs[1].printJobId);
});

test('an order save keeps its workspace and cart from changing until acknowledgement', async ({ page }) => {
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const { requests } = await ordersApp(page, { onCounter: async route => {
    await blocked;
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ id: 'saved-table', status: 'saved' }) });
    return true;
  } });
  await page.locator('[data-dine-table-number="1"]').click();
  await page.evaluate(() => { window.pendingSave = submitDineInAction('save'); });
  await expect.poll(() => requests.length).toBe(1);
  expect(await page.locator('#counter-cart-items').evaluate(element => element.inert)).toBe(true);
  expect(await page.locator('.fulfillment-actions').evaluate(element => element.inert)).toBe(true);
  await page.evaluate(() => openCounterOrder());
  await expect(page.locator('#counter-order-panel .counter-order-head h2')).toHaveText('AC · Table 01');
  release();
  await page.evaluate(() => window.pendingSave);
  expect(await page.locator('.fulfillment-actions').evaluate(element => element.inert)).toBe(false);
});

test('existing table saves preserve the full precision version reviewed when opened', async ({ page }) => {
  const version = '2026-10-15T06:00:00.123456Z';
  const { requests } = await ordersApp(page, { order: { ...order, order_version: version } });
  await page.locator('[data-dine-table-number="1"]').click();
  await page.locator('[data-dine-action="save"]').click();
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0].expectedUpdatedAt).toBe(version);
});

test('retrying an unconfirmed KOT save retains the original request identifier', async ({ page }) => {
  let attempts = 0;
  const { requests } = await ordersApp(page, { onCounter: async route => {
    if (++attempts > 1) return false;
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Response lost' }) });
    return true;
  } });
  await page.locator('[data-dine-table-number="2"]').click();
  await page.locator('[data-counter-item="0"]').click();
  await page.evaluate(() => submitDineInAction('kot-print'));
  await page.evaluate(() => submitDineInAction('kot-print'));
  expect(requests).toHaveLength(2);
  expect(requests[0].clientRequestId).toBe(requests[1].clientRequestId);
});

test('Takeaway and table drafts retain their own unsaved items and guest details across workspace switches', async ({ page }) => {
  await ordersApp(page);
  await page.locator('[data-fulfillment-filter="pickup"]').click();
  await page.locator('[data-counter-item="0"]').click();
  await page.locator('#counter-customer-name').fill('Takeaway guest');
  await page.locator('#new-order-action').click();
  await page.locator('[data-dine-table-number="1"]').click();
  await page.locator('[data-counter-change="1"]').click();
  await page.locator('#counter-special-request').fill('Table draft note');
  await page.locator('[data-fulfillment-filter="pickup"]').click();
  await expect(page.locator('#counter-total')).toHaveText('₹200');
  await expect(page.locator('#counter-customer-name')).toHaveValue('Takeaway guest');
  await expect(page.locator('#counter-cart-items .counter-quantity b')).toHaveText('1');
  await page.locator('#new-order-action').click();
  await page.locator('[data-dine-table-number="1"]').click();
  await expect(page.locator('#counter-cart-items .counter-quantity b')).toHaveText('3');
  await expect(page.locator('#counter-special-request')).toHaveValue('Table draft note');
  await expect(page.locator('#counter-customer-name')).toHaveValue('Anita');
});

test('a saved order draft cannot reappear as an unsent draft after switching workspaces', async ({ page }) => {
  await ordersApp(page);
  await page.locator('[data-fulfillment-filter="pickup"]').click();
  await page.locator('[data-counter-item="0"]').click();
  await page.locator('#counter-customer-name').fill('Already saved');
  await page.locator('#counter-place-order').click();
  await expect(page.locator('#counter-cart-items .counter-cart-line')).toHaveCount(0);
  await page.locator('#new-order-action').click();
  await page.locator('[data-dine-table-number="1"]').click();
  await page.locator('[data-fulfillment-filter="pickup"]').click();
  await expect(page.locator('#counter-cart-items .counter-cart-line')).toHaveCount(0);
  await expect(page.locator('#counter-customer-name')).toHaveValue('');
});

test('malformed queue entries are preserved for review while valid orders still sync', async ({ page }) => {
  const { requests } = await ordersApp(page);
  await page.waitForTimeout(400);
  const raw = JSON.stringify([null, { clientRequestId: 'valid-order', items: [] }, { customerName: 'Preserve this guest' }]);
  await page.evaluate(raw => localStorage.setItem('red-lantern-counter-orders', raw), raw);
  await page.evaluate(() => flushQueuedCounterOrders());
  expect(requests.map(payload => payload.clientRequestId)).toEqual(['valid-order']);
  const preserved = await page.evaluate(() => JSON.parse(localStorage.getItem('red-lantern-counter-orders-review')));
  expect(preserved[0].raw).toBe(raw);
  await expect(page.locator('#orders-connectivity')).toContainText(/manager review/);
});

test('unparseable queue data is retained exactly before an empty active queue is recovered', async ({ page }) => {
  await ordersApp(page);
  await page.waitForTimeout(400);
  const raw = '[{"clientRequestId":"must-not-disappear"';
  await page.evaluate(raw => localStorage.setItem('red-lantern-counter-orders', raw), raw);
  await page.evaluate(() => flushQueuedCounterOrders());
  const preserved = await page.evaluate(() => JSON.parse(localStorage.getItem('red-lantern-counter-orders-review')));
  expect(preserved[0].raw).toBe(raw);
  await expect(page.locator('#orders-connectivity')).toBeVisible();
});

test('permanently rejected browser orders retain their guest and items for manager review', async ({ page }) => {
  await ordersApp(page, { onCounter: async route => {
    await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'An old menu item needs review.' }) });
    return true;
  } });
  await page.waitForTimeout(400);
  const payload = { clientRequestId: 'rejected-review', customerName: 'Keep this guest', items: [{ name: 'Old menu item', quantity: 2, price: 200 }] };
  await page.evaluate(payload => saveQueuedCounterOrders([payload]), payload);
  await page.evaluate(() => flushQueuedCounterOrders());
  expect(await page.evaluate(() => queuedCounterOrders())).toEqual([]);
  const review = await page.evaluate(() => JSON.parse(localStorage.getItem('red-lantern-counter-orders-review')));
  expect(JSON.parse(review[0].raw)).toEqual(payload);
  expect(review[0].error).toContain('old menu item');
  await expect(page.locator('#orders-connectivity')).toContainText('manager review');
});

test('split receipts show each deduction once rather than copying the whole discount to every part', async ({ page }) => {
  await ordersApp(page);
  const result = await page.evaluate(() => {
    const receipt = { total: 430, discount_amount: 50, loyalty_points_redeemed: 20,
      items: [{ name: 'Soup', quantity: 2, price: 250 }] };
    const shares = splitReceiptParts(receipt, { mode: 'equal', parts: [{ label: 'First', percentage: 50 }, { label: 'Second', percentage: 50 }] });
    const itemParts = splitReceiptParts(receipt, { mode: 'item', parts: [{ label: 'First', items: [{ name: 'Soup', quantity: 1, price: 250 }] }, { label: 'Second', items: [{ name: 'Soup', quantity: 1, price: 250 }] }] });
    return { shares, itemParts };
  });
  expect(result.shares.map(part => [part.total, part.discount_amount, part.loyalty_points_redeemed])).toEqual([[215, 0, 0], [215, 0, 0]]);
  expect(result.itemParts.map(part => [part.total, part.discount_amount, part.loyalty_points_redeemed])).toEqual([[215, 25, 10], [215, 25, 10]]);
});

test('browser receipts include modifier charges, monetary wallet discounts and paise', async ({ page }) => {
  const receipt = { ...order, discount_amount: 10.25, loyalty_points_redeemed: 20, total: 190.25,
    items: [{ name: 'Soup', quantity: 2, price: 100, modifiers: [{ groupId: 'extras', options: [{ optionId: 'extra', name: 'Extra', quantity: 1, price: 5.25 }] }] }] };
  await ordersApp(page, { onCloud: async (route, path) => {
    if (!path.endsWith('/print')) return false;
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(receipt) });
    return true;
  } });
  const html = await page.evaluate(async () => {
    let html = '';
    window.open = () => ({ document: { open() { html = ''; }, write: content => { html += content; }, close() {} }, close() {} });
    await printOrder('occupied-table');
    return html;
  });
  expect(html).toContain('₹105.25');
  expect(html).toContain('₹210.50');
  expect(html).toContain('₹190.25');
  expect(html).toContain('Wallet points discount</span><span>−₹10');
});
