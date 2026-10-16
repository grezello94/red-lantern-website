const { test, expect } = require('@playwright/test');
const Staff = require('../staff-domain');

test.use({ serviceWorkers: 'block' });

async function openCaptain(page) {
  await page.addInitScript(() => { window.setInterval = () => 0; });
  const employees = [
    { id: 'reliable-ac', name: 'AC Captain', areas: ['AC'] },
    { id: 'reliable-bar', name: 'Bar Captain', areas: ['BAR'] },
  ].map(employee => ({ ...employee, active: true, role: 'captain', idleMinutes: 120, tableScope: 'assigned_areas', captainSettings: Staff.captainSettings({ autoSync: false, waiterAssignment: true }), permissions: Staff.permissions({ role: 'captain', permissions: { editOrders: true, takePayments: true, assignTables: true, pickupOrders: true, deliveryOrders: true } }) }));
  const orders = [{ id: 'active-ac', mode: 'table', table_area: 'AC', table_number: 1, captain_accessible: true, employee_assigned_id: employees[0].id, status: 'accepted', total: 100, daily_order_number: 1, updated_at: '2026-10-15T10:00:00.123Z', order_version: '2026-10-15T10:00:00.123456Z', items: [{ name: 'Soup', category: 'Soup', quantity: 1, price: 100 }] }];
  const writes = [];
  let signedOut = false;
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (request.method() !== 'GET' && request.method() !== 'DELETE') writes.push({ path, body: request.postDataJSON() });
    let payload = {};
    if (path === '/api/staff/session') {
      if (request.method() === 'DELETE') signedOut = true;
      else if (signedOut && !request.headers()['x-captain-session']) return route.fulfill({ status: 401, json: {} });
      else {
        const employee = request.headers()['x-captain-session'] === 'reliable-bar-token' ? employees[1] : employees[0];
        payload = { employee, token: `${employee.id}-token` };
      }
    } else if (path === '/api/captain/accounts') payload = { captains: employees };
    else if (path === '/api/captain/login') {
      const employee = employees.find(entry => entry.id === request.postDataJSON().id);
      payload = { captain: employee, token: `${employee.id}-token` };
    } else if (path === '/api/orders/operations') payload = { config: { tableAreas: [{ name: 'AC', from: 1, to: 3 }, { name: 'BAR', from: 1, to: 2 }] } };
    else if (path === '/api/orders/menu') payload = [{ key: 'soup', menuType: 'food', name: 'Soup', category: 'Soup', price: 100 }];
    else if (path === '/api/orders') payload = request.headers()['x-captain-session'] === 'reliable-bar-token' ? [] : orders;
    else if (path === '/api/orders/availability') payload = [];
    else if (path === '/api/captain/ready-alerts') payload = { alerts: [] };
    else if (path === '/api/staff/employees') payload = { employees: [] };
    else if (path === '/api/orders/counter') payload = { id: 'queued-saved', orderNumber: 2 };
    await route.fulfill({ status: 200, json: payload });
  });
  await page.goto('/captain.html');
  await expect(page.locator('.table-tile')).toHaveCount(3);
  return { writes, orders };
}

async function switchCaptain(page) {
  await page.evaluate(() => signOut());
  await page.locator('[data-captain-id="reliable-bar"]').click();
  await page.locator('#captain-pin').fill('1234');
  await page.locator('#captain-pin-form').dispatchEvent('submit');
  await expect(page.locator('.table-tile')).toHaveCount(2);
}

async function serviceTools(page) {
  await page.locator('#captain-nav-toggle').click();
  await page.locator('#captain-open-tools').click();
}

test('an uncertain saved request cannot be recovered with a new idempotency ID', async ({ page }) => {
  await openCaptain(page);
  await page.evaluate(() => {
    state.pending = [{ kind: 'order', status: 'queued', attemptedAt: Date.now(), payload: { clientRequestId: 'uncertain-request', mode: 'table', tableArea: 'AC', tableNumber: 2, sendKot: false, items: [{ name: 'Soup', category: 'Soup', portion: 'Regular', price: 100, quantity: 1 }] } }];
    recoverPending(0);
  });
  expect(await page.evaluate(() => state.pending.map(entry => entry.payload.clientRequestId))).toEqual(['uncertain-request']);
  await expect(page.locator('#tables-screen')).toBeVisible();
  await expect(page.locator('#captain-pending-sync')).toContainText('confirm');
});

test('queued drafts retain their expected table when recovered for editing', async ({ page }) => {
  await openCaptain(page);
  await page.evaluate(() => {
    queuePending({ clientRequestId: 'never-sent', mode: 'table', tableArea: 'AC', tableNumber: 1, tableOrderId: '', items: [{ name: 'Soup', category: 'Soup', portion: 'Regular', price: 100, quantity: 1 }] });
    recoverPending(0);
  });
  expect(await page.evaluate(() => state.table.orderId)).toBe('');
  await expect(page.locator('#cart-count')).toHaveText('1 item');
});

test('discarding during a sync cannot remove the following unsent order', async ({ page }) => {
  await openCaptain(page);
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const requests = [];
  await page.route('**/api/orders/counter', async route => {
    const payload = route.request().postDataJSON();
    requests.push(payload.clientRequestId);
    if (payload.clientRequestId === 'first') {
      await held;
      return route.fulfill({ status: 200, json: { id: 'saved-first', orderNumber: 2 } });
    }
    return route.fulfill({ status: 400, json: { error: 'Review this second order.' } });
  });
  await page.evaluate(() => {
    for (const id of ['first', 'second']) queuePending({ clientRequestId: id, mode: 'table', tableArea: 'AC', tableNumber: 2, sendKot: false, items: [{ name: 'Soup', quantity: 1, price: 100 }] });
    window.pendingCaptainSync = flushPending();
  });
  await expect.poll(() => requests.length).toBe(1);
  page.on('dialog', dialog => dialog.accept());
  await page.evaluate(() => discardPending(0));
  release();
  await page.evaluate(() => window.pendingCaptainSync);
  expect(requests).toEqual(['first', 'second']);
  expect(await page.evaluate(() => state.pending.map(entry => entry.payload.clientRequestId))).toEqual(['second']);
});

test('cart quantity controls respect the maximum supported by the order API', async ({ page }) => {
  await openCaptain(page);
  await page.locator('.table-tile').nth(1).click();
  await page.evaluate(() => { addSimpleItem(state.menu[0]); state.cart[0].quantity = 20; setScreen('review'); });
  await page.locator('#cart-list [data-cart-change="1"]').click();
  expect(await page.evaluate(() => state.cart[0].quantity)).toBe(20);
});

test('an expired tool response cannot sign out the next captain', async ({ page }) => {
  await openCaptain(page);
  let release;
  const held = new Promise(resolve => { release = resolve; });
  await page.route('**/api/orders/active-ac/items', async route => {
    await held;
    await route.fulfill({ status: 401, json: { error: 'Expired old session.' } });
  });
  await page.evaluate(() => window.openCaptainOrderTools(state.orders[0]));
  await page.locator('[data-native-order-action="edit"]').click();
  await page.locator('[name="reason"]').fill('Guest request');
  const pending = page.waitForRequest('**/api/orders/active-ac/items');
  await page.locator('#captain-tool-save').click();
  await pending;
  await switchCaptain(page);
  const response = page.waitForResponse('**/api/orders/active-ac/items');
  release();
  await response;
  await expect(page.locator('#captain-profile')).toContainText('Bar Captain');
  await expect(page.locator('#captain-login')).toBeHidden();
});

test('closing a loading tool prevents its result from replacing another sheet', async ({ page }) => {
  await openCaptain(page);
  let release;
  const held = new Promise(resolve => { release = resolve; });
  await page.route('**/api/captain/printers', async route => {
    await held;
    await route.fulfill({ status: 200, json: { printers: [] } });
  });
  await serviceTools(page);
  const pending = page.waitForRequest('**/api/captain/printers');
  await page.locator('[data-service-tool="printers"]').click();
  await pending;
  await page.locator('[data-close-tool]').first().click();
  await serviceTools(page);
  await page.locator('[data-service-tool="preferences"]').click();
  const response = page.waitForResponse('**/api/captain/printers');
  release();
  await response;
  await expect(page.locator('#captain-tool-title')).toHaveText('Captain App settings');
});

test('a tool form rejects duplicate submissions while its first save is pending', async ({ page }) => {
  await openCaptain(page);
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const requests = [];
  await page.route('**/api/orders/active-ac/items', async route => {
    requests.push(route.request().postDataJSON());
    await held;
    await route.fulfill({ status: 200, json: { ok: true } });
  });
  await page.evaluate(() => window.openCaptainOrderTools(state.orders[0]));
  await page.locator('[data-native-order-action="edit"]').click();
  await page.locator('[name="reason"]').fill('Guest request');
  await page.evaluate(() => {
    $('#captain-tool-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    $('#captain-tool-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  await expect.poll(() => requests.length).toBeGreaterThan(0);
  try {
    expect(requests).toHaveLength(1);
    expect(requests[0].expectedUpdatedAt).toBe('2026-10-15T10:00:00.123456Z');
  } finally {
    release();
  }
});

test('an order response without an order ID leaves the original request queued', async ({ page }) => {
  await openCaptain(page);
  await page.route('**/api/orders/counter', route => route.fulfill({ status: 200, json: {} }));
  await page.evaluate(async () => {
    queuePending({ clientRequestId: 'missing-order-id', mode: 'table', tableArea: 'AC', tableNumber: 2, sendKot: false, items: [{ name: 'Soup', price: 100, quantity: 1 }] });
    await flushPending();
  });
  expect(await page.evaluate(() => state.pending.map(entry => entry.payload.clientRequestId))).toEqual(['missing-order-id']);
});

test('a KOT response without a ticket number leaves its saved retry queued', async ({ page }) => {
  await openCaptain(page);
  await page.route('**/api/orders/active-ac/kots', route => route.fulfill({ status: 200, json: {} }));
  await page.evaluate(async () => {
    queueKotRetry({ clientRequestId: 'missing-kot-number', items: [{ name: 'Soup', price: 100, quantity: 1 }] }, { id: 'active-ac', orderNumber: 1 });
    await flushPending();
  });
  expect(await page.evaluate(() => state.pending.map(entry => entry.savedOrderId))).toEqual(['active-ac']);
});

test('a submitting draft stays fixed until its receipt is confirmed', async ({ page }) => {
  await openCaptain(page);
  let release;
  const held = new Promise(resolve => { release = resolve; });
  await page.route('**/api/orders/counter', async route => {
    await held;
    await route.fulfill({ status: 200, json: { id: 'draft-confirmed', orderNumber: 2 } });
  });
  await page.locator('.table-tile').nth(1).click();
  await page.evaluate(() => { addSimpleItem(state.menu[0]); $('#send-kot').checked = false; setScreen('review'); });
  const pending = page.waitForRequest('**/api/orders/counter');
  await page.locator('#place-order').click();
  await pending;
  try {
    await expect(page.locator('#cart-list [data-cart-change="1"]')).toBeDisabled();
    await expect(page.locator('#customer-name')).toBeDisabled();
    await page.locator('#review-screen [data-captain-back]').click();
    await expect(page.locator('#review-screen')).toBeVisible();
    await page.evaluate(() => addSimpleItem(state.menu[0]));
    expect(await page.evaluate(() => state.cart[0].quantity)).toBe(1);
  } finally {
    release();
  }
});

test('switching accounts restores only the signed-in captain offline journal', async ({ page }) => {
  await openCaptain(page);
  await page.evaluate(() => queuePending({ clientRequestId: 'ac-only', mode: 'table', tableArea: 'AC', tableNumber: 2, items: [] }));
  await switchCaptain(page);
  expect(await page.evaluate(() => state.pending)).toEqual([]);
  await page.evaluate(() => {
    queuePending({ clientRequestId: 'bar-only', mode: 'table', tableArea: 'BAR', tableNumber: 1, items: [] });
    signOut();
  });
  await page.locator('[data-captain-id="reliable-ac"]').click();
  await page.locator('#captain-pin').fill('1234');
  await page.locator('#captain-pin-form').dispatchEvent('submit');
  await expect(page.locator('.table-tile')).toHaveCount(3);
  expect(await page.evaluate(() => state.pending.map(entry => entry.payload.clientRequestId))).toEqual(['ac-only']);
});

test('a queued delivery clears its matching draft after journal recovery', async ({ page }) => {
  await openCaptain(page);
  const key = await page.evaluate(() => {
    state.table = { area: '', number: 0, mode: 'takeaway', fulfillmentType: 'delivery' };
    addSimpleItem(state.menu[0]);
    const key = draftKey();
    queuePending({ clientRequestId: 'queued-delivery', mode: 'takeaway', fulfillmentType: 'delivery', tableArea: '', tableNumber: 0, items: state.cart.map(({ key, ...item }) => item) });
    state.table = null; state.cart = [];
    loadPending();
    return key;
  });
  expect(await page.evaluate(key => localStorage.getItem(key), key)).toBeNull();
});

test('changing a course preserves all items when the merged quantity exceeds one line', async ({ page }) => {
  await openCaptain(page);
  await page.locator('.table-tile').nth(1).click();
  await page.evaluate(() => {
    addSimpleItem(state.menu[0]);
    state.cart[0].quantity = 15;
    const line = { ...state.cart[0], quantity: 10, courseOverride: 'starter' };
    line.key = itemKey(line); state.cart.push(line);
    setScreen('review');
  });
  await page.locator('#cart-list [data-cart-course="1"]').selectOption('');
  expect(await page.evaluate(() => itemCount())).toBe(25);
  expect(await page.evaluate(() => state.cart.every(line => line.quantity <= 20))).toBe(true);
});

test('requesting service on one table does not disable the next table request', async ({ page }) => {
  const { orders } = await openCaptain(page);
  await page.evaluate(order => { state.orders.push({ ...order, id: 'active-two', table_number: 2 }); renderTables(); }, orders[0]);
  await page.locator('.table-tile').first().click();
  await page.locator('[data-table-service="water_requested"]').click();
  await expect(page.locator('[data-table-service="water_requested"]')).toHaveText('Requested ✓');
  await page.locator('#menu-screen [data-captain-back]').click();
  await page.locator('.table-tile').nth(1).click();
  await expect(page.locator('[data-table-service="water_requested"]')).toBeEnabled();
  await expect(page.locator('[data-table-service="water_requested"]')).toHaveText('Request water');
});

test('a delayed location response cannot request a bill for a different table', async ({ page }) => {
  const { writes, orders } = await openCaptain(page);
  await page.evaluate(order => {
    state.orders.push({ ...order, id: 'active-two', table_number: 2 }); renderTables();
    captainPrintLocation = () => new Promise(resolve => { window.releaseBillLocation = resolve; });
  }, orders[0]);
  await page.locator('.table-tile').first().click();
  await page.locator('[data-table-service="bill_requested"]').click();
  await page.waitForFunction(() => window.releaseBillLocation);
  await page.locator('#menu-screen [data-captain-back]').click();
  await page.locator('.table-tile').nth(1).click();
  await page.evaluate(async () => { window.releaseBillLocation({ latitude: 1, longitude: 1 }); await Promise.resolve(); });
  expect(writes.some(write => write.path.includes('/service'))).toBe(false);
  await expect(page.locator('[data-table-service="bill_requested"]')).toBeEnabled();
});

test('payment retries reuse the same request ID after an unreadable success response', async ({ page }) => {
  await openCaptain(page);
  const payments = [];
  await page.route('**/api/orders/active-ac/settle', route => {
    payments.push(route.request().postDataJSON());
    return payments.length === 1
      ? route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":' })
      : route.fulfill({ status: 200, json: { ok: true, duplicate: true } });
  });
  await page.evaluate(() => window.openCaptainOrderTools(state.orders[0]));
  await page.locator('[data-native-order-action="pay"]').click();
  await page.locator('#captain-tool-save').click();
  await expect(page.locator('#captain-tool-error')).toContainText('did not confirm');
  await expect(page.locator('#captain-tool-sheet')).toBeVisible();
  await page.locator('#captain-tool-save').click();
  await expect.poll(() => payments.length).toBe(2);
  expect(payments[0].requestId).toBeTruthy();
  expect(payments[1].requestId).toBe(payments[0].requestId);
});

test('an uncertain queued order is confirmed by replaying its original request ID', async ({ page }) => {
  await openCaptain(page);
  const requests = [];
  await page.route('**/api/orders/counter', route => {
    requests.push(route.request().postDataJSON());
    return route.fulfill({ status: 200, json: requests.length === 1 ? {} : { id: 'already-saved', orderNumber: 2, duplicate: true } });
  });
  await page.evaluate(async () => {
    queuePending({ clientRequestId: 'original-uncertain-id', mode: 'table', tableArea: 'AC', tableNumber: 2, sendKot: false, items: [{ name: 'Soup', price: 100, quantity: 1 }] });
    await flushPending();
    recoverPending(0);
  });
  expect(await page.evaluate(() => state.pending.length)).toBe(1);
  await page.evaluate(() => flushPending());
  expect(requests.map(request => request.clientRequestId)).toEqual(['original-uncertain-id', 'original-uncertain-id']);
  expect(await page.evaluate(() => state.pending)).toEqual([]);
});

test('a cleared browser journal cannot resurrect an older IndexedDB order', async ({ page }) => {
  await openCaptain(page);
  await page.evaluate(async () => {
    const stale = { kind: 'order', status: 'queued', attemptedAt: Date.now(), payload: { clientRequestId: 'old-already-confirmed', items: [] } };
    await writePendingJournal({ key: pendingKey(), updatedAt: Date.now() - 1000, entries: [stale] });
    const persist = writePendingJournal;
    writePendingJournal = async () => {};
    state.pending = []; savePending();
    state.pendingUpdatedAt = 0;
    loadPending();
    await readPendingJournal();
    writePendingJournal = persist;
  });
  expect(await page.evaluate(() => state.pending)).toEqual([]);
});

test('adding items after a failed KOT starts a new round without losing the saved retry', async ({ page }) => {
  await openCaptain(page);
  await page.route('**/api/orders/queued-saved/kots', route => route.fulfill({ status: 500, json: { error: 'Kitchen unavailable.' } }));
  await page.locator('.table-tile').nth(1).click();
  await page.evaluate(() => { addSimpleItem(state.menu[0]); setScreen('review'); });
  await page.locator('#place-order').click();
  await expect(page.locator('#place-order')).toHaveText('Retry KOT ↗');
  await page.locator('#review-screen [data-captain-back]').click();
  await page.evaluate(() => addSimpleItem(state.menu[0]));
  expect(await page.evaluate(() => state.kotRetry)).toBeNull();
  expect(await page.evaluate(() => state.table.orderId)).toBe('queued-saved');
  expect(await page.evaluate(() => state.pending.filter(entry => entry.kind === 'kot-retry').map(entry => entry.savedOrderId))).toEqual(['queued-saved']);
  await expect(page.locator('#cart-count')).toHaveText('1 item');
});

test('a saved KOT retry does not erase a later matching item draft', async ({ page }) => {
  await openCaptain(page);
  await page.locator('.table-tile').first().click();
  const key = await page.evaluate(() => {
    addSimpleItem(state.menu[0]);
    const key = draftKey();
    queueKotRetry({ clientRequestId: 'earlier-round', mode: 'table', tableArea: 'AC', tableNumber: 1, items: state.cart.map(({ key, ...line }) => line) }, { id: 'active-ac', orderNumber: 1 });
    loadPending();
    return key;
  });
  expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key))?.cart?.length, key)).toBe(1);
});

test('the main KOT retry honors its waiter and clears the pending banner', async ({ page }) => {
  await openCaptain(page);
  const requests = [];
  await page.route('**/api/orders/queued-saved/kots', route => {
    requests.push(route.request().postDataJSON());
    return requests.length === 1
      ? route.fulfill({ status: 500, json: { error: 'Kitchen unavailable.' } })
      : route.fulfill({ status: 200, json: { kotNumber: 1 } });
  });
  await page.locator('.table-tile').nth(1).click();
  await page.evaluate(() => { addSimpleItem(state.menu[0]); setScreen('review'); });
  await page.locator('#place-order').click();
  await expect(page.locator('#place-order')).toHaveText('Retry KOT ↗');
  await page.evaluate(() => {
    $('#captain-kot-waiter').innerHTML = '<option value="waiter-one" selected>Waiter One</option>';
  });
  await page.locator('#place-order').click();
  await expect(page.locator('#tables-screen')).toBeVisible();
  expect(requests[1]).toEqual({ waiterId: 'waiter-one' });
  await expect(page.locator('#captain-pending-sync')).toBeHidden();
});
