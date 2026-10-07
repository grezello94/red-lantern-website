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

for (const size of [{width:810,height:1080}, {width:1180,height:820}, {width:1440,height:900}]) {
  test(`Register dialogs and touch controls fit ${size.width}×${size.height}`, async ({ page }) => {
    await page.setViewportSize(size);
    await page.route('**/api/**', async route => {
      const path = new URL(route.request().url()).pathname;
      let data = {};
      if (path === '/api/orders') data = [registerOrder(), {...registerOrder(),id:'parcel-test',mode:'counter',daily_order_number:13}];
      if (path.endsWith('/print')) data = {...registerOrder(),items:[{name:'Vegetable fried rice',quantity:2,price:400}]};
      await route.fulfill({contentType:'application/json',body:JSON.stringify(data)});
    });
    await page.goto('/register.html');
    await expect(page.locator('.parcel-strip .token')).toHaveText('Bill #13');
    const cash = page.locator('[data-pay="cash"]').first();
    expect((await cash.boundingBox()).height).toBeGreaterThanOrEqual(48);
    await cash.click();
    const modal = page.locator('#payment-modal');
    await expect(modal).toBeVisible();
    const bounds = await modal.boundingBox();
    expect(bounds.width).toBeGreaterThanOrEqual(620);
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(size.height);
    await page.locator('[data-cash-amount="1000"]').click();
    await expect(page.locator('#payment-preview')).toHaveText('Return change: ₹200.00');
    await page.locator('#payment-received').fill('700');
    await expect(page.locator('#payment-confirm')).toBeDisabled();
    await page.locator('[data-cash-amount="800"]').click();
    await expect(page.locator('#payment-confirm')).toBeEnabled();
    await page.screenshot({path:test.info().outputPath('register-cash-tablet.png')});
    await page.locator('.payment-cancel').click();
    await page.locator('[data-pay="split"]').first().click();
    for (let index=0; index<3; index++) await page.locator('#payment-add-method').click();
    await page.locator('#payment-confirm').scrollIntoViewIfNeeded();
    await expect(page.locator('#payment-confirm')).toBeInViewport();
    expect(await modal.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.locator('.payment-cancel').click();
    await page.locator('[data-view]').first().click();
    await expect(page.locator('#bill-modal')).toBeVisible();
    expect((await page.locator('#bill-modal').boundingBox()).width).toBeGreaterThanOrEqual(700);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test('Register connection failures show an actionable banner and recover on retry', async ({page}) => {
  let offline=true;
  await page.route('**/api/orders', async route => {
    if (offline) return route.abort();
    return route.fulfill({contentType:'application/json',body:JSON.stringify([registerOrder()])});
  });
  await page.goto('/register.html');
  await expect(page.locator('#register-connection-notice')).toBeVisible();
  await expect(page.locator('#connection-label')).toHaveText('Offline');
  offline=false;
  await page.locator('#register-retry').click();
  await expect(page.locator('#register-connection-notice')).toBeHidden();
  await expect(page.locator('#connection-label')).toHaveText('Live');
  await expect(page.locator('.order-strip')).toHaveCount(1);
});

test('Register theme toggle persists and covers payment, split and bill dialogs', async ({page}) => {
  await page.setViewportSize({width:1180,height:820});
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    const order = {...registerOrder(),items:[{name:'Rice',quantity:1,price:800}]};
    await route.fulfill({contentType:'application/json',body:JSON.stringify(path === '/api/orders' ? [order] : path.endsWith('/print') ? order : {})});
  });
  await page.goto('/register.html');
  await expect(page.locator('html')).toHaveAttribute('data-theme','dark');
  await page.getByRole('button',{name:'Switch to light mode'}).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme','light');
  await expect(page.locator('#register-theme-toggle')).toHaveAttribute('aria-pressed','true');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme','light');
  await page.locator('[data-pay="cash"]').click();
  await expect(page.locator('#payment-modal')).toHaveCSS('background-color','rgb(255, 255, 255)');
  await page.screenshot({path:test.info().outputPath('register-light-payment.png')});
  await page.locator('.payment-cancel').click();
  await page.locator('[data-pay="split"]').click();
  await expect(page.locator('.payment-split-row')).toHaveCSS('background-color','rgb(247, 249, 253)');
  await page.locator('.payment-cancel').click();
  await page.locator('[data-view]').click();
  await expect(page.locator('#bill-modal')).toHaveCSS('background-color','rgb(255, 255, 255)');
  await page.locator('.modal-close').click();
  await page.setViewportSize({width:390,height:844});
  await expect(page.locator('#register-theme-toggle')).toBeVisible();
  await expect(page.locator('[data-theme-label]')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button',{name:'Switch to dark mode'}).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme','dark');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme','dark');
});
