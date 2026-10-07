const { test, expect } = require('@playwright/test');
test.use({ hasTouch: true, isMobile: true });

async function openCaptain(page, permissions = {}) {
  const employee = { id: 'captain-touch', name: 'Service Captain', role: 'captain', tableScope: 'assigned_areas', areas: ['AC'], idleMinutes: 120, permissions: { captainApp: true, createOrders: true, addRounds: true, viewKots: true, moveTables: true, requestBills: true, ...permissions } };
  const orders = [{ id: 'counter-table', mode: 'table', table_area: 'AC', table_number: 1, status: 'accepted', captain_accessible: true, items: [{ name: 'Soup', quantity: 1 }], total: 100, created_at: new Date().toISOString() }];
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    let body = {};
    if (path === '/api/captain/accounts') body = { captains: [employee] };
    else if (path === '/api/captain/login') body = { token: 'test-touch-token', captain: employee };
    else if (path === '/api/staff/session') body = { employee };
    else if (path === '/api/orders/operations') body = { config: { tableAreas: [{ name: 'AC', from: 1, to: 12 }, { name: 'BAR', from: 1, to: 3 }] } };
    else if (path === '/api/orders') body = orders;
    else if (path === '/api/orders/menu') body = [{ key: 'soup', name: 'Soup', category: 'Soup', price: 100, portions: { Regular: 100 } }];
    else if (path === '/api/orders/availability') body = [];
    else if (path.endsWith('/move')) {
      const destination = route.request().postDataJSON();
      orders[0].table_area = destination.tableArea;
      orders[0].table_number = destination.tableNumber;
      body = { ok: true };
    } else if (path.includes('ready-alerts')) body = { alerts: [] };
    else if (path.includes('kots')) body = { rounds: [] };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.goto('/captain.html');
  await page.locator('[data-captain-id="captain-touch"]').click();
  await page.locator('#captain-pin').fill('1234');
  await page.locator('#captain-pin-form').dispatchEvent('submit');
  await expect(page.locator('.table-tile')).toHaveCount(12);
}

for (const size of [{ width: 360, height: 780 }, { width: 390, height: 844 }, { width: 810, height: 1080 }, { width: 1180, height: 820 }]) {
  test(`Captain fits ${size.width}×${size.height} with touch-safe fields and actions`, async ({ page }) => {
    await page.setViewportSize(size);
    await openCaptain(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath('captain-board.png'), fullPage: true });
    const actions = page.locator('[data-table-actions]').first();
    const bounds = await actions.boundingBox();
    expect(bounds.width).toBeGreaterThanOrEqual(44);
    expect(bounds.height).toBeGreaterThanOrEqual(44);
    await actions.tap();
    await expect(page.locator('#captain-table-actions')).toBeVisible();
    const sheet = await page.locator('#captain-table-actions').boundingBox();
    expect(sheet.x).toBeGreaterThanOrEqual(0);
    expect(sheet.x + sheet.width).toBeLessThanOrEqual(size.width + 1);
    await page.locator('[data-captain-table-action="move"]').click();
    await expect(page.locator('#captain-move-sheet')).toBeVisible();
    await expect(page.locator('#captain-move-sheet')).toHaveCSS('opacity', '1');
    await page.screenshot({ path: test.info().outputPath('captain-move.png') });
    expect(await page.locator('#captain-move-number option').count()).toBe(11);
    expect(await page.locator('#captain-move-area option').allTextContents()).toEqual(['AC']);
    expect(await page.locator('#captain-move-number').evaluate((field) => parseFloat(getComputedStyle(field).fontSize))).toBeGreaterThanOrEqual(16);
    await page.locator('[data-close-move]').last().click();
    await page.locator('.table-tile').nth(1).click();
    await expect(page.locator('#menu-screen')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test('long press tolerates finger jitter, avoids selection and does not consume the next tap', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openCaptain(page);
  const tile = page.locator('.table-tile.is-active').first();
  expect(await tile.evaluate((element) => getComputedStyle(element).userSelect)).toBe('none');
  await tile.dispatchEvent('pointerdown', { pointerId: 7, isPrimary: true, button: 0, clientX: 50, clientY: 200 });
  await tile.dispatchEvent('pointermove', { pointerId: 7, clientX: 53, clientY: 203 });
  await expect(page.locator('#captain-table-actions')).toBeVisible();
  await tile.dispatchEvent('pointerup', { pointerId: 7 });
  await tile.dispatchEvent('click');
  await expect(page.locator('#tables-screen')).toBeVisible();
  await page.locator('[data-captain-table-actions-close]').click();
  await page.locator('.table-tile').nth(1).click();
  await expect(page.locator('#menu-screen')).toBeVisible();
  expect(await page.evaluate(() => window.getSelection().toString())).toBe('');
});

test('scroll and cancelled touches do not open actions; move uses the in-app picker', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openCaptain(page);
  const tile = page.locator('.table-tile.is-active').first();
  await tile.dispatchEvent('pointerdown', { pointerId: 7, isPrimary: true, button: 0, clientX: 50, clientY: 200 });
  await tile.dispatchEvent('pointermove', { pointerId: 7, clientX: 50, clientY: 230 });
  await page.waitForTimeout(550);
  await expect(page.locator('#captain-table-actions')).not.toBeVisible();
  await tile.dispatchEvent('pointerdown', { pointerId: 8, isPrimary: true, button: 0, clientX: 50, clientY: 200 });
  await page.dispatchEvent('body', 'pointercancel', { pointerId: 8 });
  await page.waitForTimeout(550);
  await expect(page.locator('#captain-table-actions')).not.toBeVisible();
  await page.locator('[data-table-actions]').first().click();
  await page.locator('[data-captain-table-action="move"]').click();
  await page.locator('#captain-move-number').selectOption('2');
  const moved = page.waitForRequest('**/api/captain/orders/counter-table/move');
  await page.locator('#captain-move-confirm').click();
  expect((await moved).postDataJSON()).toEqual({ tableArea: 'AC', tableNumber: 2 });
  await expect(page.locator('#captain-move-sheet')).not.toBeVisible();
  await expect(page.locator('.table-tile.is-active')).toHaveAttribute('data-table-number', '2');
});

test('restricted actions stay hidden and revoking a session closes open sheets', async ({ page }) => {
  await openCaptain(page, { moveTables: false, requestBills: false });
  await page.locator('[data-table-actions]').first().click();
  await expect(page.locator('[data-captain-table-action="move"]')).toBeHidden();
  await expect(page.locator('[data-captain-table-action="bill"]')).toBeHidden();
  await page.route('**/api/staff/session', (route) => route.fulfill({ status: 401, contentType: 'application/json', body: '{}' }));
  await page.evaluate(() => load());
  await expect(page.locator('dialog[open]')).toHaveCount(0);
  await expect(page.locator('#captain-login')).toBeVisible();
  await expect(page.locator('.captain-app')).toBeHidden();
});

test('a real touch hold opens actions and rotation keeps the sheet inside the screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openCaptain(page);
  const tile = page.locator('.table-tile.is-active').first();
  await tile.scrollIntoViewIfNeeded();
  const bounds = await tile.boundingBox();
  const touch = await page.context().newCDPSession(page);
  const point = { x: bounds.x + 30, y: bounds.y + 40 };
  await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
  await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: point.x + 3, y: point.y + 2 }] });
  await expect(page.locator('#captain-table-actions')).toBeVisible();
  await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.setViewportSize({ width: 844, height: 390 });
  const sheet = await page.locator('#captain-table-actions').boundingBox();
  expect(sheet.y).toBeGreaterThanOrEqual(0);
  expect(sheet.y + sheet.height).toBeLessThanOrEqual(391);
  await page.locator('[data-captain-table-actions-close]').tap();
  await page.locator('.table-tile').nth(1).tap();
  await expect(page.locator('#menu-screen')).toBeVisible();
});
