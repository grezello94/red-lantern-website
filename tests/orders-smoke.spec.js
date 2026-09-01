const { test, expect } = require('@playwright/test');

test.beforeEach(async ({ page }) => {
  await page.route('http://127.0.0.1:9124/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const body =
      url.pathname === '/health'
        ? { ok: true, service: 'Test Print Bridge', ledger: 'ready' }
        : url.pathname === '/v1/printers'
          ? { printers: [] }
          : url.pathname === '/v1/setup-status'
            ? { ok: true, ledger: 'ready', printerCount: 0 }
            : url.pathname === '/v1/config'
              ? { config: { printers: [], routes: [] } }
              : { ok: true };
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify(body),
    });
  });
});

test('orders page loads with expected title', async ({ page }) => {
  await page.goto('/orders.html');
  await expect(page).toHaveTitle(/Red Lantern Orders/i);
  await expect(page.getByRole('navigation', { name: 'Orders workspace' })).toBeVisible();
  await expect(page.locator('#orders')).toHaveCount(1);
});

test('captain page loads with login screen', async ({ page }) => {
  await page.goto('/captain.html');
  await expect(page).toHaveTitle(/Captain/i);
  await expect(page.locator('#captain-login')).toBeVisible();
  await expect(page.locator('#captain-account-list')).toBeVisible();
});

test('a bill is sent once to every configured Bill printer with its own settings', async ({
  page,
}) => {
  const billJobs = [];
  await page.route('http://127.0.0.1:4173/api/orders/operations', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        config: {
          printers: [
            {
              id: 'bill-front',
              name: 'Front Bill',
              capabilities: ['bill'],
              type: 'bill',
              deviceName: 'Front Queue',
              paperWidth: 80,
            },
            {
              id: 'bill-backup',
              name: 'Backup Bill',
              capabilities: ['bill', 'kot'],
              type: 'kot',
              deviceName: 'Backup Queue',
              paperWidth: 58,
            },
          ],
          routes: [],
        },
        menu: [],
      }),
    });
  });
  await page.route('http://127.0.0.1:4173/api/orders/order-1/print', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: 'order-1',
        created_at: '2026-08-31T12:00:00.000Z',
        items: [{ name: 'Test item', quantity: 1, price: 100 }],
        total: 100,
      }),
    });
  });
  await page.goto('/orders.html');
  await page.unroute('http://127.0.0.1:9124/**');
  await page.route('http://127.0.0.1:9124/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/v1/print-bill') billJobs.push(route.request().postDataJSON());
    await route.fulfill({
      status: pathname === '/v1/print-bill' ? 201 : 200,
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: pathname === '/v1/printers' ? '{"printers":[]}' : '{"ok":true}',
    });
  });
  await page.evaluate(() => window.printOrder('order-1'));

  expect(billJobs).toHaveLength(2);
  expect(billJobs.map((job) => job.printerName).sort()).toEqual([
    'Backup Queue',
    'Front Queue',
  ]);
  expect(new Set(billJobs.map((job) => job.printJobId)).size).toBe(2);
  expect(billJobs.find((job) => job.printerName === 'Front Queue').settings.paperWidth).toBe(80);
  expect(billJobs.find((job) => job.printerName === 'Backup Queue').settings.paperWidth).toBe(58);
});
