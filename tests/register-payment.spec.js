const { test, expect } = require('@playwright/test');

function registerOrder(status = 'accepted') {
  return {
    id: 'order-payment-test',
    status,
    mode: 'table',
    table_area: 'AC',
    table_number: 2,
    customer_name: 'Walk-in customer',
    customer_phone: 'walkin-test',
    daily_order_number: 12,
    total: 800,
    created_at: new Date().toISOString(),
    ...(status === 'completed' ? { settlement_type: 'part' } : {}),
  };
}

test('Register records a split payment and remains usable on a phone', async ({ page }) => {
  let settled = false;
  let settlementPayload = null;
  await page.route('**/api/orders**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === '/api/orders' && request.method() === 'GET') {
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify([registerOrder(settled ? 'completed' : 'accepted')]),
      });
    }
    if (url.pathname.endsWith('/settle') && request.method() === 'POST') {
      settlementPayload = request.postDataJSON();
      settled = true;
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ ok: true }),
      });
    }
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/register.html');
  await expect(page.locator('[data-pay="split"]')).toBeVisible();
  await page.locator('[data-pay="split"]').click();
  await expect(page.locator('#payment-modal')).toBeVisible();
  await page.locator('#payment-add-method').click();
  await expect(page.locator('.payment-split-row')).toHaveCount(2);
  await page.locator('.payment-split-row').nth(1).locator('.split-type').selectOption('zomato');
  await expect(page.locator('#payment-allocated')).toHaveText('₹800.00');
  await expect(page.locator('#payment-confirm')).toBeEnabled();
  await page.locator('#payment-confirm').click();
  await expect.poll(() => settlementPayload).not.toBeNull();
  expect(settlementPayload.payments).toEqual([
    { paymentType: 'cash', amount: 400, paymentReceived: 400 },
    { paymentType: 'zomato', amount: 400, paymentReceived: 400 },
  ]);
  await expect(page.locator('.order-strip')).toContainText('Paid via PART');

  const overflow = await page.evaluate(() => ({
    viewport: window.innerWidth,
    body: document.body.scrollWidth,
    document: document.documentElement.scrollWidth,
  }));
  expect(overflow.body).toBeLessThanOrEqual(overflow.viewport);
  expect(overflow.document).toBeLessThanOrEqual(overflow.viewport);
});

test('Register reprints through Bridge without a browser popup', async ({ page }) => {
  const jobs = [];
  const popups = [];
  page.on('popup', (popup) => popups.push(popup));
  await page.route('**/api/orders**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    let data = [];
    if (path.endsWith('/print'))
      data = { ...registerOrder(), items: [{ name: 'Rice', quantity: 1, price: 800 }] };
    else if (path.endsWith('/operations'))
      data = {
        config: {
          printers: [
            {
              id: 'bill',
              enabled: true,
              type: 'bill',
              deviceName: 'Counter',
              workstationId: 'counter-1',
            },
          ],
        },
      };
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(data) });
  });
  await page.route('http://127.0.0.1:9124/**', async (route) => {
    if (route.request().url().endsWith('/v1/print-bill')) jobs.push(route.request().postDataJSON());
    await route.fulfill({
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ ok: true, workstation: { id: 'counter-1' } }),
    });
  });
  await page.goto('/register.html');
  await page.evaluate(() =>
    Promise.all([
      window.receipt('order-payment-test', true),
      window.receipt('order-payment-test', true),
    ])
  );
  expect(jobs).toHaveLength(1);
  expect(jobs[0].printerName).toBe('Counter');
  expect(popups).toEqual([]);
});
