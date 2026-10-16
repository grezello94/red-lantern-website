const { test, expect } = require('@playwright/test');
const Staff = require('../staff-domain');

async function openCaptain(page) {
  const employees = [
    { id: 'captain-ac', name: 'AC Captain', areas: ['AC'] },
    { id: 'captain-bar', name: 'Bar Captain', areas: ['BAR'] },
  ].map(employee => ({ ...employee, role: 'captain', active: true, tableScope: 'assigned_areas', idleMinutes: 120, permissions: Staff.permissions({ role: 'captain', permissions: { pickupOrders: true } }) }));
  const orders = [{ id: 'ac-order', mode: 'table', table_area: 'AC', table_number: 1, captain_accessible: true, status: 'accepted', total: 100, items: [{ name: 'Soup', quantity: 1 }], customer_name: 'AC Guest' }];
  let signedOut = false;
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    let payload = {};
    if (path === '/api/staff/session') {
      if (request.method() === 'DELETE') signedOut = true;
      else if (signedOut && !request.headers()['x-captain-session']) return route.fulfill({ status: 401, json: {} });
      else {
        const employee = request.headers()['x-captain-session'] === 'captain-bar-token' ? employees[1] : employees[0];
        payload = { employee, token: `${employee.id}-token` };
      }
    } else if (path === '/api/captain/accounts') payload = { captains: employees };
    else if (path === '/api/captain/login') {
      const employee = employees.find(entry => entry.id === request.postDataJSON().id);
      payload = { captain: employee, token: `${employee.id}-token` };
    } else if (path === '/api/orders/operations') payload = { config: { tableAreas: [{ name: 'AC', from: 1, to: 3 }, { name: 'BAR', from: 1, to: 2 }] } };
    else if (path === '/api/orders/menu') payload = [{ key: 'soup', name: 'Soup', category: 'Soup', price: 100 }];
    else if (path === '/api/orders') payload = request.headers()['x-captain-session'] === 'captain-bar-token' ? [] : orders;
    else if (path === '/api/orders/availability') payload = [];
    else if (path === '/api/captain/ready-alerts') payload = { alerts: [] };
    await route.fulfill({ status: 200, json: payload });
  });
  await page.goto('/captain.html');
  await expect(page.locator('.table-tile')).toHaveCount(3);
}

async function login(page, id) {
  await page.locator(`[data-captain-id="${id}"]`).click();
  await page.locator('#captain-pin').fill('1234');
  await page.locator('#captain-pin-form').dispatchEvent('submit');
}

test('new tables clear guest details and reopening a table restores its own draft', async ({ page }) => {
  await openCaptain(page);
  await page.locator('.table-tile').nth(1).click();
  await page.evaluate(() => {
    $('#customer-name').value = 'Table Two Guest';
    $('#customer-phone').value = '9876543210';
    $('#special-request').value = 'No peanuts';
    $('#course-mode').value = 'serve_together';
    saveDraft();
  });
  await page.locator('#menu-screen [data-captain-back]').click();
  await page.locator('.table-tile').nth(2).click();
  await expect(page.locator('#customer-name')).toHaveValue('');
  await expect(page.locator('#customer-phone')).toHaveValue('');
  await expect(page.locator('#special-request')).toHaveValue('');
  await expect(page.locator('#course-mode')).toHaveValue('normal_coursing');
  await page.locator('#menu-screen [data-captain-back]').click();
  await page.locator('.table-tile').nth(1).click();
  await expect(page.locator('#customer-name')).toHaveValue('Table Two Guest');
  await expect(page.locator('#special-request')).toHaveValue('No peanuts');
  await expect(page.locator('#course-mode')).toHaveValue('serve_together');
});

test('opening an active table from the navigation preserves its unsent round', async ({ page }) => {
  await openCaptain(page);
  await page.locator('.table-tile').first().click();
  await page.evaluate(() => {
    addSimpleItem(state.menu[0]);
    $('#customer-name').value = 'Unsent Guest';
    saveDraft();
  });
  await page.locator('#captain-nav-toggle').click();
  await page.locator('[data-captain-nav-table="AC"]').click();
  await expect(page.locator('#cart-count')).toHaveText('1 item');
  await expect(page.locator('#customer-name')).toHaveValue('Unsent Guest');
});

test('switching captains from the menu starts on a clean table board', async ({ page }) => {
  await openCaptain(page);
  await page.locator('.table-tile').nth(1).click();
  await page.evaluate(() => signOut());
  await login(page, 'captain-bar');
  await expect(page.locator('#tables-screen')).toBeVisible();
  await expect(page.locator('.table-tile')).toHaveCount(2);
  await expect(page.locator('#captain-login')).toBeHidden();
  expect(await page.evaluate(() => ({ lastTable: state.lastTable, pending: state.pending, orders: state.orders }))).toEqual({ lastTable: null, pending: [], orders: [] });
});

test('an old table response cannot replace the next captain account data', async ({ page }) => {
  await openCaptain(page);
  let releaseOldResponse;
  const held = new Promise(resolve => { releaseOldResponse = resolve; });
  await page.route('**/api/orders?history=0', async route => {
    if (route.request().headers()['x-captain-session'] !== 'captain-ac-token') return route.fallback();
    await held;
    await route.fulfill({ status: 200, json: [{ id: 'old-captain-order', mode: 'table', table_area: 'AC', table_number: 1, status: 'accepted', customer_name: 'Private old guest', items: [] }] });
  });
  const oldRequest = page.waitForRequest(request => request.url().includes('/api/orders?history=0') && request.headers()['x-captain-session'] === 'captain-ac-token');
  await page.evaluate(() => { window.oldCaptainLoad = load(); });
  await oldRequest;
  await page.evaluate(() => signOut());
  await login(page, 'captain-bar');
  try {
    await expect(page.locator('.table-tile')).toHaveCount(2);
  } finally {
    releaseOldResponse();
  }
  await page.evaluate(() => window.oldCaptainLoad);
  expect(await page.evaluate(() => state.orders)).toEqual([]);
  await expect(page.locator('.table-tile')).toHaveCount(2);
});

test('an order response from the previous account cannot send a KOT as the next captain', async ({ page }) => {
  await openCaptain(page);
  let releaseOrder;
  const held = new Promise(resolve => { releaseOrder = resolve; });
  const kotRequests = [];
  await page.route('**/api/orders/counter', async route => {
    await held;
    await route.fulfill({ status: 200, json: { id: 'old-saved-order', orderNumber: 12 } });
  });
  await page.route('**/api/orders/old-saved-order/kots', async route => {
    kotRequests.push(route.request().headers()['x-captain-session']);
    await route.fulfill({ status: 200, json: { kotNumber: 1 } });
  });
  const oldRequest = page.waitForRequest('**/api/orders/counter');
  await page.evaluate(() => {
    window.oldCaptainPost = postCaptainOrder({ clientRequestId: 'old-captain-submit', sendKot: true, items: [] }).then(() => 'saved', error => error.message);
  });
  await oldRequest;
  try {
    await page.evaluate(() => signOut());
    await login(page, 'captain-bar');
    await expect(page.locator('.table-tile')).toHaveCount(2);
  } finally {
    releaseOrder();
  }
  expect(await page.evaluate(() => window.oldCaptainPost)).toContain('Captain account changed');
  expect(kotRequests).toEqual([]);
  expect(await page.evaluate(() => state.pending)).toEqual([]);
});

test('a previous captain conflict refresh cannot close the next captain draft', async ({ page }) => {
  await openCaptain(page);
  await page.route('**/api/orders/counter', route => route.fulfill({ status: 409, json: { code: 'table_changed', error: 'The table changed.', conflict: { id: 'conflicting-order' } } }));
  await page.locator('.table-tile').nth(1).click();
  await page.evaluate(() => {
    const originalLoad = load, session = captainSessionIdentity();
    load = () => {
      if (captainSessionIdentity() !== session) return originalLoad();
      window.conflictRefreshStarted = true;
      return new Promise(resolve => { window.releaseConflictRefresh = resolve; });
    };
    addSimpleItem(state.menu[0]);
    $('#send-kot').checked = false;
    setScreen('review');
  });
  await page.locator('#place-order').click();
  await page.waitForFunction(() => window.conflictRefreshStarted);
  await page.evaluate(() => signOut());
  await login(page, 'captain-bar');
  await expect(page.locator('.table-tile')).toHaveCount(2);
  await page.locator('.table-tile').first().click();
  await page.evaluate(async () => {
    addSimpleItem(state.menu[0]);
    window.releaseConflictRefresh(true);
    await Promise.resolve();
  });
  await expect(page.locator('#menu-screen')).toBeVisible();
  expect(await page.evaluate(() => state.pendingError)).toBe('');
  await expect(page.locator('#cart-count')).toHaveText('1 item');
});
