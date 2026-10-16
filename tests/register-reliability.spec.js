const { test, expect } = require('@playwright/test');

test.use({ serviceWorkers: 'block' });
const original = {
  id: 'register-reliable', mode: 'table', status: 'accepted', table_area: 'AC', table_number: 1,
  total: 100.55, daily_order_number: 8, customer_name: 'Guest', customer_phone: 'walkin-reliable',
  created_at: '2026-10-15T06:00:00Z', updated_at: '2026-10-15T06:00:00.123Z',
  order_version: '2026-10-15T06:00:00.123456Z', items: [{ name: 'Soup', quantity: 1, price: 100.55 }],
};
async function registerApp(page, options = {}) {
  const state = { orders: [{ ...original }], payments: [], jobs: [] };
  await page.addInitScript(() => { window.setInterval = () => 0; });
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    let data = { ok: true };
    if (path === '/api/staff/session') data = { legacy: true, employee: null };
    else if (path === '/api/orders') data = options.listData?.() || state.orders;
    else if (path.endsWith('/settle')) {
      state.payments.push({ body: request.postDataJSON(), requestId: request.headers()['x-settlement-id'] });
      if (options.settle && await options.settle(route, state)) return;
      state.orders[0].status = 'completed'; state.orders[0].settlement_type = 'cash';
    } else if (path.endsWith('/print')) data = state.orders[0];
    else if (path === '/api/orders/operations') data = { config: { printers: [{ id: 'bill', name: 'Bill', enabled: true, type: 'bill', deviceName: 'Counter', workstationId: 'register-test' }] } };
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) });
  });
  await page.route('http://127.0.0.1:9124/**', async route => {
    const path = new URL(route.request().url()).pathname;
    let data = { ok: true, workstation: { id: 'register-test' } };
    if (path === '/v1/print-bill') {
      state.jobs.push(route.request().postDataJSON());
      if (options.print && await options.print(route, state)) return;
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) });
  });
  await page.goto('/register.html');
  await expect(page.locator('.order-strip')).toHaveCount(1);
  return state;
}

test('a payment response lost after commit is safely confirmed with the original request ID', async ({ page }) => {
  const state = await registerApp(page, { settle: async (route, state) => {
    state.orders[0].status = 'completed'; state.orders[0].settlement_type = 'cash';
    if (state.payments.length === 1) { await route.abort(); return true; }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true, duplicate: true }) });
    return true;
  } });
  await page.locator('[data-pay="cash"]').click();
  await page.locator('#payment-confirm').click();
  await expect(page.locator('#register-service-notice')).toBeVisible();
  await expect(page.locator('#payment-modal')).toBeVisible();
  await page.locator('#payment-confirm').click();
  await expect(page.locator('#payment-modal')).toBeHidden();
  await expect(page.locator('.order-strip')).toContainText('Paid via CASH');
  expect(state.payments).toHaveLength(2);
  expect(state.payments[0].requestId).toBe(state.payments[1].requestId);
  expect(state.payments[0].body.expectedUpdatedAt).toBe(original.order_version);
});

test('Escape and another payment selection cannot replace a payment awaiting confirmation', async ({ page }) => {
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  await registerApp(page, { settle: async () => { await blocked; return false; } });
  await page.locator('[data-pay="cash"]').click();
  await page.locator('#payment-confirm').click();
  await expect(page.locator('#payment-confirm')).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(page.locator('#payment-modal')).toBeVisible();
  await page.evaluate(() => openPayment('different-order', 'upi'));
  await expect(page.locator('#payment-title')).toHaveText('Cash payment');
  release();
  await expect(page.locator('#payment-modal')).toBeHidden();
});

test('an unconfirmed list response preserves the visible orders and offers retry', async ({ page }) => {
  let invalid = false;
  await registerApp(page, { listData: () => invalid ? { ok: true } : null });
  invalid = true;
  await page.evaluate(() => load());
  await expect(page.locator('.order-strip')).toHaveCount(1);
  await expect(page.locator('#connection-label')).toHaveText('Offline');
  await expect(page.locator('#register-connection-notice')).toBeVisible();
});

test('an uncertain receipt remains available for retry using the same printer job', async ({ page }) => {
  const state = await registerApp(page, { print: async (route, state) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(state.jobs.length === 1 ? { ok: true, uncertain: true } : { ok: true }) });
    return true;
  } });
  await page.locator('[data-reprint]').click();
  await expect(page.locator('#register-service-notice')).toContainText('printing needs attention');
  await page.locator('[data-reprint]').click();
  await expect.poll(() => state.jobs.length).toBe(2);
  expect(state.jobs[0].printJobId).toBe(state.jobs[1].printJobId);
});
