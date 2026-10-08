const { test, expect } = require('@playwright/test');

test.use({ serviceWorkers: 'block' });

const menu = [
  {
    key: 'food:veg-crispy',
    menuType: 'food',
    name: 'Veg Crispy',
    category: 'Starters',
    price: 200,
  },
  {
    key: 'food:pepper-wings',
    menuType: 'food',
    name: 'Chicken Pepper Wings Special',
    category: 'Starters',
    price: 250,
  },
  {
    key: 'food:chicken-soup',
    menuType: 'food',
    name: 'Chicken Clear Soup',
    category: 'Soup',
    halfPrice: 110,
    fullPrice: 190,
  },
  {
    key: 'food:chilli-chicken',
    menuType: 'food',
    name: 'Chicken Chilli',
    category: 'Starters',
    halfPrice: 150,
    fullPrice: 280,
    gravyStyleAvailable: true,
  },
  {
    key: 'food:unavailable-soup',
    menuType: 'food',
    name: 'Unavailable Mushroom Soup',
    category: 'Soup',
    price: 170,
  },
  {
    key: 'food:restocked-tikka',
    menuType: 'food',
    name: 'Restocked Paneer Tikka',
    category: 'Tandoor',
    price: 220,
  },
  {
    key: 'bar:virgin-mojito',
    menuType: 'bar',
    name: 'Virgin Mojito',
    category: 'Mocktails',
    price: 200,
  },
];

const printerConfig = {
  printers: [
    {
      id: 'kitchen',
      name: 'Kitchen Printer',
      type: 'kot',
      enabled: true,
      deviceName: 'Kitchen queue',
      workstationId: 'counter-workspace',
    },
  ],
  routes: [
    { id: 'route-starters', category: 'Starters', printerId: 'kitchen' },
    { id: 'route-soup', category: 'Soup', printerId: 'kitchen' },
  ],
  tableAreas: [{ name: 'NON AC', from: 6, to: 8 }],
};

async function counterApp(page, { failKot = false } = {}) {
  const savedRequests = [];
  const ledgerActions = [];
  const printJobs = [];
  const dialogs = [];
  let savedOrder = null;
  page.on('dialog', async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.dismiss();
  });
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    let payload = { ok: true };
    if (path === '/api/orders/counter' && request.method() === 'POST') {
      const submitted = request.postDataJSON();
      savedRequests.push(submitted);
      savedOrder = {
        id: 'counter-workspace-order',
        mode: 'table',
        status: submitted.action === 'save' ? 'saved' : 'accepted',
        table_area: submitted.tableArea,
        table_number: submitted.tableNumber,
        daily_order_number: 2,
        customer_name: submitted.customerName || 'Walk-in customer',
        customer_phone: submitted.customerPhone || 'walkin-counter-test',
        special_request: submitted.specialRequest,
        created_at: new Date().toISOString(),
        items: submitted.items,
        total: submitted.items.reduce(
          (sum, item) => sum + (item.price + (item.style ? 10 : 0)) * item.quantity,
          0
        ),
      };
      payload = { id: savedOrder.id, orderNumber: 2, status: savedOrder.status };
    } else if (path === '/api/orders') payload = savedOrder ? [savedOrder] : [];
    else if (path === '/api/orders/menu') payload = menu;
    else if (path === '/api/orders/availability')
      payload = [
        {
          item_key: 'food:unavailable-soup',
          unavailable_until: new Date(Date.now() + 3600000).toISOString(),
        },
        {
          item_key: 'food:restocked-tikka',
          unavailable_until: new Date(Date.now() - 3600000).toISOString(),
        },
      ];
    else if (path === '/api/orders/operations') payload = { config: printerConfig, menu };
    else if (path === '/api/orders/live-summary')
      payload = {
        activeOrderCount: savedOrder ? 1 : 0,
        latestOrderNumber: savedOrder ? 2 : 0,
        sessionOpen: true,
        acceptingOrders: true,
      };
    else if (path.endsWith('/kots')) {
      if (failKot)
        return route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Kitchen ticket service is temporarily unavailable.' }),
        });
      const kot = {
        kot_number: 1,
        created_at: new Date().toISOString(),
        tickets: [
          {
            printerId: 'kitchen',
            printerName: 'Kitchen queue',
            printerLabel: 'Kitchen Printer',
            items: savedOrder?.items || [],
          },
        ],
      };
      payload =
        request.method() === 'POST'
          ? { kotNumber: 1, tickets: kot.tickets, order: savedOrder }
          : [kot];
    } else if (path.endsWith('/kitchen-statuses') || path.endsWith('/kot-history')) payload = [];
    else if (path === '/api/loyalty') payload = { points: 0 };
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(payload) });
  });
  await page.route('http://127.0.0.1:9124/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    let payload = {
      ok: true,
      version: '2026.10.08.2',
      workstation: { id: 'counter-workspace' },
      ledger: 'ready',
    };
    if (path === '/v1/setup-status')
      payload = {
        ...payload,
        printers: [{ id: 'Kitchen queue', name: 'Kitchen queue' }],
        configuredBillPrinterCount: 0,
        configuredKotRouteCount: 2,
      };
    if (path === '/v1/printers')
      payload.printers = [{ id: 'Kitchen queue', name: 'Kitchen queue' }];
    if (path === '/v1/config') payload.config = printerConfig;
    if (path === '/v1/ledger/actions') {
      payload.actions = [];
      if (request.method() === 'POST') {
        ledgerActions.push(request.postDataJSON());
        payload.action = { status: 'queued' };
      }
    }
    if (path === '/v1/print-kot') printJobs.push(request.postDataJSON());
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(payload) });
  });
  await page.goto('/orders.html');
  await expect(
    page.locator('[data-dine-table-area="NON AC"][data-dine-table-number="6"]')
  ).toBeVisible();
  await page.locator('[data-dine-table-area="NON AC"][data-dine-table-number="6"]').click();
  await expect(page.locator('#counter-order-panel')).toBeVisible();
  await expect(page.locator('#counter-menu-items [data-counter-item]')).toHaveCount(6);
  return { savedRequests, ledgerActions, printJobs, dialogs };
}

const menuItem = (page, name) =>
  page
    .locator('#counter-menu-items [data-counter-item]')
    .filter({ has: page.locator('b', { hasText: name }) });
const cartLine = (page, name) =>
  page.locator('#counter-cart-items .counter-cart-line').filter({ hasText: name });

async function openCart(page) {
  const mobileToggle = page.locator('#mobile-cart-toggle');
  if (
    (await mobileToggle.isVisible()) &&
    !(await page
      .locator('#counter-order-panel')
      .evaluate((panel) => panel.classList.contains('mobile-cart-open')))
  )
    await mobileToggle.click();
}

test('category and search work together while unavailable items stay out of the order menu', async ({
  page,
}) => {
  await counterApp(page);
  await expect(menuItem(page, 'Unavailable Mushroom Soup')).toHaveCount(0);
  await expect(menuItem(page, 'Restocked Paneer Tikka')).toBeVisible();
  await page.locator('[data-counter-category="Soup"]').click();
  await expect(page.locator('#counter-menu-items [data-counter-item]')).toHaveCount(1);
  await expect(menuItem(page, 'Chicken Clear Soup')).toBeVisible();
  await page.locator('#counter-menu-search').fill('crispy');
  await expect(page.locator('#counter-menu-items [data-counter-item]')).toHaveCount(0);
  await expect(page.locator('#counter-menu-items')).toContainText(/no.*match/i);
  await page.locator('[data-counter-category="all"]').click();
  await expect(menuItem(page, 'Veg Crispy')).toBeVisible();
  await page.locator('#counter-menu-search').fill('');
  await page.locator('[data-counter-category="Mocktails"]').click();
  await expect(menuItem(page, 'Virgin Mojito')).toBeVisible();
  await expect(page.locator('#counter-menu-items [data-counter-item]')).toHaveCount(1);
});

test('portions, preparation styles and quantity changes calculate totals without losing the customer draft', async ({
  page,
}) => {
  const { dialogs } = await counterApp(page);
  await page.locator('#counter-customer-name').fill('Mira');
  await page.locator('#counter-customer-phone').fill('9876543210');
  await page.locator('#counter-special-request').fill('Less spicy, please');
  await menuItem(page, 'Veg Crispy').click();
  await menuItem(page, 'Veg Crispy').click();
  await expect(menuItem(page, 'Veg Crispy')).toHaveClass(/is-selected/);
  await expect(menuItem(page, 'Veg Crispy').locator('.counter-item-count')).toHaveText('2');
  await expect(cartLine(page, 'Veg Crispy').locator('.counter-quantity b')).toHaveText('2');
  await expect(page.locator('#counter-total')).toHaveText('₹400');
  await menuItem(page, 'Chicken Chilli').click();
  const dialog = page.locator('#counter-choice-dialog');
  await expect(dialog).toBeVisible();
  await dialog.locator('input[name="counter-portion"][value="Full"]').check();
  await dialog.locator('input[name="counter-style"][value="Gravy"]').check();
  await page.locator('#counter-choice-add').click();
  await expect(dialog).toBeHidden();
  await expect(cartLine(page, 'Chicken Chilli')).toContainText(/Full.*Gravy.*₹290 each/);
  await expect(page.locator('#counter-total')).toHaveText('₹690');
  await cartLine(page, 'Chicken Chilli').locator('[data-counter-change="1"]').click();
  await expect(page.locator('#counter-total')).toHaveText('₹980');
  await cartLine(page, 'Veg Crispy').locator('[data-counter-change="-1"]').click();
  await expect(page.locator('#counter-total')).toHaveText('₹780');
  await cartLine(page, 'Veg Crispy').locator('[data-counter-change="-1"]').click();
  await expect(cartLine(page, 'Veg Crispy')).toHaveCount(0);
  await expect(page.locator('#counter-total')).toHaveText('₹580');
  await page.locator('[data-counter-category="Soup"]').click();
  await page.locator('#counter-menu-search').fill('clear');
  await expect(page.locator('#counter-customer-name')).toHaveValue('Mira');
  await expect(page.locator('#counter-customer-phone')).toHaveValue('9876543210');
  await expect(page.locator('#counter-special-request')).toHaveValue('Less spicy, please');
  await expect(page.locator('#counter-total')).toHaveText('₹580');
  await page.locator('#counter-clear').click();
  await expect(page.locator('#counter-cart-items .counter-cart-line')).toHaveCount(0);
  await expect(page.locator('#counter-total')).toHaveText('₹0');
  await expect(page.locator('#counter-customer-name')).toHaveValue('Mira');
  expect(dialogs).toEqual([]);
});

test('saving from the dine-in workspace records the customer and can reopen the saved bill', async ({
  page,
}) => {
  const { savedRequests, ledgerActions, printJobs, dialogs } = await counterApp(page);
  await menuItem(page, 'Veg Crispy').click();
  await page.locator('#counter-customer-name').fill('Mira');
  await page.locator('#counter-special-request').fill('Serve starters first');
  await page.locator('[data-dine-action="save"]').click();
  await expect.poll(() => savedRequests.length).toBe(1);
  await expect(page.locator('#counter-order-status')).toContainText(/saved/i);
  expect(savedRequests[0]).toMatchObject({
    action: 'save',
    tableArea: 'NON AC',
    tableNumber: 6,
    customerName: 'Mira',
    specialRequest: 'Serve starters first',
    items: [{ name: 'Veg Crispy', price: 200, quantity: 1 }],
  });
  expect(savedRequests[0].clientRequestId).toMatch(/^counter-/);
  expect(ledgerActions).toHaveLength(1);
  expect(ledgerActions[0]).toMatchObject({
    id: savedRequests[0].clientRequestId,
    type: 'counter-order',
    payload: savedRequests[0],
  });
  expect(printJobs).toEqual([]);
  await page.locator('[data-open-saved-table="NON AC"][data-open-saved-number="6"]').click();
  await expect(cartLine(page, 'Veg Crispy')).toBeVisible();
  await expect(page.locator('#counter-customer-name')).toHaveValue('Mira');
  await expect(page.locator('#counter-special-request')).toHaveValue('Serve starters first');
  await expect(page.locator('#counter-total')).toHaveText('₹200');
  expect(dialogs).toEqual([]);
});

test('Send KOT saves the order and dispatches one stable kitchen job', async ({ page }) => {
  const { savedRequests, printJobs, dialogs } = await counterApp(page);
  await menuItem(page, 'Veg Crispy').click();
  await page.locator('[data-dine-action="kot-print"]').click();
  await expect(page.locator('#counter-order-status')).toContainText(/KOTs sent/i);
  expect(savedRequests).toHaveLength(1);
  expect(savedRequests[0]).toMatchObject({
    action: 'kot-print',
    tableArea: 'NON AC',
    tableNumber: 6,
  });
  await expect.poll(() => printJobs.length).toBe(1);
  expect(printJobs[0]).toMatchObject({
    printJobId: 'auto-kot:counter-workspace-order:1:Kitchen queue',
    printerName: 'Kitchen queue',
    items: [{ name: 'Veg Crispy', quantity: 1 }],
  });
  await page.evaluate(() => recoverPendingPrinting());
  expect(printJobs).toHaveLength(1);
  expect(await page.evaluate(() => counterCart)).toEqual([]);
  expect(dialogs).toEqual([]);
});

test('a KOT service outage keeps the saved order and never resubmits it as an offline draft', async ({
  page,
}) => {
  const { savedRequests, printJobs, dialogs } = await counterApp(page, { failKot: true });
  await menuItem(page, 'Veg Crispy').click();
  await page.locator('[data-dine-action="kot-print"]').click();
  await expect(page.locator('#counter-order-status')).toContainText(/order saved/i);
  await expect(page.locator('#counter-order-status')).toContainText(/retry|queued|waiting/i);
  expect(savedRequests).toHaveLength(1);
  expect(printJobs).toEqual([]);
  expect(await page.evaluate(() => counterCart)).toEqual([]);
  expect(await page.evaluate(() => queuedCounterOrders())).toEqual([]);
  expect(dialogs).toEqual([]);
});

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 1180, height: 820 },
  { width: 810, height: 1080 },
  { width: 390, height: 844 },
]) {
  test(`counter workspace and variant dialog fit ${viewport.width}×${viewport.height}`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    await counterApp(page);
    await page
      .locator('#counter-order-panel')
      .screenshot({ path: testInfo.outputPath(`counter-workspace-${viewport.width}.png`) });
    const layout = await page.locator('#counter-order-panel').evaluate((panel) => ({
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: innerWidth,
      left: panel.getBoundingClientRect().left,
      right: panel.getBoundingClientRect().right,
      searchHeight: document.getElementById('counter-menu-search').getBoundingClientRect().height,
      controls: [...panel.querySelectorAll('[data-counter-category], [data-counter-item]')].map(
        (control) => control.getBoundingClientRect().height
      ),
    }));
    expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth + 1);
    expect(layout.left).toBeGreaterThanOrEqual(0);
    expect(layout.right).toBeLessThanOrEqual(layout.viewportWidth);
    expect(layout.searchHeight).toBeGreaterThanOrEqual(44);
    expect(Math.min(...layout.controls)).toBeGreaterThanOrEqual(44);
    await menuItem(page, 'Chicken Chilli').click();
    const dialog = page.locator('#counter-choice-dialog');
    await expect(dialog).toBeVisible();
    await dialog.screenshot({ path: testInfo.outputPath(`counter-variant-${viewport.width}.png`) });
    const modalLayout = await dialog.evaluate((modal) => {
      const bounds = modal.getBoundingClientRect();
      return {
        left: bounds.left,
        right: bounds.right,
        top: bounds.top,
        bottom: bounds.bottom,
        width: bounds.width,
        viewportWidth: innerWidth,
        viewportHeight: innerHeight,
        controlHeights: [
          ...modal.querySelectorAll(
            '.counter-choice-options label, .counter-style-options label, #counter-choice-add, [data-counter-choice-close]'
          ),
        ].map((control) => control.getBoundingClientRect().height),
      };
    });
    expect(modalLayout.left).toBeGreaterThanOrEqual(0);
    expect(modalLayout.right).toBeLessThanOrEqual(modalLayout.viewportWidth);
    expect(modalLayout.top).toBeGreaterThanOrEqual(0);
    expect(modalLayout.bottom).toBeLessThanOrEqual(modalLayout.viewportHeight);
    expect(modalLayout.width).toBeGreaterThanOrEqual(Math.min(480, viewport.width - 48));
    expect(Math.min(...modalLayout.controlHeights)).toBeGreaterThanOrEqual(44);
    await page.locator('#counter-choice-add').click();
    if (viewport.width === 390) {
      await expect(page.locator('#mobile-cart-toggle')).toBeVisible();
      await expect(page.locator('#mobile-cart-count')).toHaveText('1');
      await expect(page.locator('#mobile-cart-toggle')).toContainText('₹150');
    }
    await openCart(page);
    if (viewport.width <= 900) await expect(page.locator('#mobile-add-status')).toBeHidden();
    const quantityHeights = await page
      .locator('#counter-cart-items [data-counter-qty]')
      .evaluateAll((buttons) => buttons.map((button) => button.getBoundingClientRect().height));
    expect(Math.min(...quantityHeights)).toBeGreaterThanOrEqual(44);
    await cartLine(page, 'Chicken Chilli').locator('[data-counter-change="1"]').click();
    await expect(page.locator('#counter-total')).toHaveText('₹300');
    await expect(page.locator('#counter-cart-count')).toContainText(/2 items/);
    if (viewport.width <= 900) await expect(page.locator('#mobile-add-status')).toBeHidden();
    await page
      .locator('.counter-cart')
      .screenshot({ path: testInfo.outputPath(`counter-cart-${viewport.width}.png`) });
    const cartBounds = await page.locator('.counter-cart').evaluate((cart) => ({
      left: cart.getBoundingClientRect().left,
      right: cart.getBoundingClientRect().right,
      viewport: innerWidth,
    }));
    expect(cartBounds.left).toBeGreaterThanOrEqual(0);
    expect(cartBounds.right).toBeLessThanOrEqual(cartBounds.viewport);
    await expect(page.locator('[data-dine-action="kot-print"]')).toBeVisible();
    if (viewport.width === 390) {
      await page.locator('#mobile-cart-close').click();
      await expect(page.locator('#counter-order-panel')).not.toHaveClass(/mobile-cart-open/);
      await expect(page.locator('#mobile-cart-count')).toHaveText('2');
      await expect(page.locator('#mobile-cart-toggle')).toContainText('₹300');
      await page.locator('#mobile-cart-toggle').click();
      await expect(page.locator('#counter-order-panel')).toHaveClass(/mobile-cart-open/);
      await page.keyboard.press('Escape');
      await expect(page.locator('#counter-order-panel')).not.toHaveClass(/mobile-cart-open/);
      await expect(page.locator('#mobile-cart-toggle')).toBeFocused();
    }
  });
}
