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

test('an urgent order event refreshes the billing console without waiting for the fallback poll', async ({
  page,
}) => {
  let orderReads = 0;
  await page.route(/\/api\/orders\?.*/, async (route) => {
    orderReads += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: '[]',
    });
  });
  await page.goto('/orders.html');
  const readsBeforeEvent = orderReads;
  await page.evaluate(() => window.requestFastOrdersRefresh());
  await expect.poll(() => orderReads, { timeout: 500 }).toBeGreaterThan(readsBeforeEvent);
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
              paperWidth: 80,
              formats: {
                bill: { paperWidth: 58, fontFamily: 'Georgia' },
                kot: { paperWidth: 80, fontFamily: 'Consolas' },
              },
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
  expect(billJobs.find((job) => job.printerName === 'Backup Queue').settings.fontFamily).toBe(
    'Georgia'
  );
});

test('one routed KOT can be dispatched concurrently to multiple printer queues', async ({ page }) => {
  const kotJobs = [];
  await page.route('http://127.0.0.1:4173/api/orders/operations', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        config: {
          printers: [
            {
              id: 'kitchen',
              name: 'Kitchen',
              capabilities: ['kot'],
              deviceName: 'Kitchen Queue',
              formats: { kot: { fontFamily: 'Arial' } },
            },
            {
              id: 'expo',
              name: 'Expo',
              capabilities: ['kot'],
              deviceName: 'Expo Queue',
              formats: { kot: { fontFamily: 'Consolas' } },
            },
          ],
          routes: [],
        },
        menu: [],
      }),
    });
  });
  await page.route('http://127.0.0.1:4173/api/orders/order-2/kots', async (route) => {
    const item = { name: 'Mirrored item', category: 'STARTER', quantity: 1 };
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({
        kotNumber: 12,
        order: { id: 'order-2', daily_order_number: 2, mode: 'table' },
        tickets: [
          {
            printerId: 'kitchen',
            printerName: 'Kitchen Queue',
            printerLabel: 'Kitchen',
            items: [item],
          },
          {
            printerId: 'expo',
            printerName: 'Expo Queue',
            printerLabel: 'Expo',
            items: [item],
          },
        ],
      }),
    });
  });
  await page.goto('/orders.html');
  await page.unroute('http://127.0.0.1:9124/**');
  await page.route('http://127.0.0.1:9124/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/v1/print-kot') kotJobs.push(route.request().postDataJSON());
    await route.fulfill({
      status: pathname === '/v1/print-kot' ? 201 : 200,
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ ok: true }),
    });
  });

  const result = await page.evaluate(() =>
    window.autoPrintOrder({ id: 'order-2', mode: 'table', status: 'accepted' })
  );
  expect(result.ok).toBe(true);
  expect(kotJobs).toHaveLength(2);
  expect(kotJobs.map((job) => job.printerName).sort()).toEqual(['Expo Queue', 'Kitchen Queue']);
  expect(kotJobs.find((job) => job.printerName === 'Expo Queue').settings.fontFamily).toBe(
    'Consolas'
  );
});
