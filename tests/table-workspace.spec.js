const { test, expect } = require('@playwright/test');

test.use({ serviceWorkers: 'block' });

const menu = [
  { key: 'food:veg-crispy', menuType: 'food', name: 'Veg Crispy', category: 'Starters', price: 200 },
  { key: 'food:chicken-soup', menuType: 'food', name: 'Chicken Clear Soup', category: 'Soup', price: 120 },
];

function tableOrder(id, area, number, overrides = {}) {
  return {
    id, mode: 'table', status: 'ready', table_area: area, table_number: number,
    daily_order_number: number, customer_name: 'Walk-in customer', customer_phone: `walkin-${id}`,
    created_at: new Date(Date.now() - 18 * 60000).toISOString(), total: 200,
    items: [{ name: 'Veg Crispy', category: 'Starters', quantity: 1, price: 200 }],
    ...overrides,
  };
}

async function tableApp(page, { crowded = false } = {}) {
  const config = {
    printers: [
      { id: 'kitchen', name: 'Kitchen Printer', type: 'kot', enabled: true, deviceName: 'Kitchen queue', workstationId: 'table-workspace' },
      { id: 'bill', name: 'Bill Printer', type: 'bill', enabled: true, deviceName: 'Bill queue', workstationId: 'table-workspace' },
    ],
    routes: [{ id: 'starters-kitchen', category: 'Starters', printerId: 'kitchen' }],
    tableAreas: [
      { name: 'AC', from: 1, to: 6 },
      { name: 'NON AC', from: 1, to: crowded ? 22 : 18 },
      { name: 'BAR', from: 1, to: 5 },
    ],
  };
  const orders = [
    tableOrder('ac-kot', 'AC', 1),
    tableOrder('ac-saved', 'AC', 2, { status: 'saved', customer_name: 'Anita', customer_phone: '9999999999', special_request: 'Less spicy', total: 400, items: [{ name: 'Veg Crispy', category: 'Starters', quantity: 2, price: 200 }] }),
    tableOrder('ac-printed', 'AC', 3, { bill_printed_at: new Date().toISOString() }),
    tableOrder('non-ac-held', 'NON AC', 6, { status: 'held' }),
    tableOrder('bar-kot', 'BAR', 2),
    tableOrder('settled-table', 'NON AC', 1, { status: 'completed' }),
    { ...tableOrder('delivery-order', '', 0), mode: 'online', status: 'new', fulfillment_type: 'delivery', customer_name: 'Delivery guest' },
    { ...tableOrder('pickup-order', '', 0), mode: 'online', status: 'new', fulfillment_type: 'pickup', customer_name: 'Pickup guest' },
  ];
  const mutations = [];
  const billJobs = [];
  const dialogs = [];
  const orderReads = [];
  page.on('dialog', async dialog => { dialogs.push(dialog.message()); await dialog.dismiss(); });
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    let payload = { ok: true };
    if (path === '/api/orders') {
      orderReads.push(url.search);
      payload = orders;
    } else if (path === '/api/orders/menu') payload = menu;
    else if (path === '/api/orders/availability' || path.endsWith('/kitchen-statuses') || path.endsWith('/kot-history')) payload = [];
    else if (path === '/api/orders/operations') payload = { config, menu };
    else if (path === '/api/orders/live-summary') payload = { activeOrderCount: 7, latestOrderNumber: 8, sessionOpen: true, acceptingOrders: true };
    else if (path === '/api/loyalty') payload = { points: 0 };
    else if (path.endsWith('/kots')) {
      const id = decodeURIComponent(path.split('/')[3]), order = orders.find(item => item.id === id);
      const history = ['ac-kot', 'ac-printed', 'bar-kot'].includes(id) ? [{
        kot_number: 1, created_at: order.created_at,
        tickets: [{ printerId: 'kitchen', printerName: 'Kitchen queue', printerLabel: 'Kitchen Printer', items: order.items }],
      }] : [];
      payload = request.method() === 'POST' ? { kotNumber: 1, tickets: history[0]?.tickets || [], order } : history;
    } else if (path.endsWith('/print')) {
      payload = orders.find(item => item.id === decodeURIComponent(path.split('/')[3]));
    } else if (path.endsWith('/table') && request.method() === 'PATCH') {
      const id = decodeURIComponent(path.split('/')[3]), submitted = request.postDataJSON();
      mutations.push({ id, action: 'move', ...submitted });
      Object.assign(orders.find(item => item.id === id), { table_area: submitted.tableArea, table_number: submitted.tableNumber });
    } else if (path.endsWith('/bill-printed') && request.method() === 'POST') {
      const id = decodeURIComponent(path.split('/')[3]);
      mutations.push({ id, action: 'bill-printed' });
      orders.find(item => item.id === id).bill_printed_at = new Date().toISOString();
    } else if (path.endsWith('/settle') && request.method() === 'POST') {
      const id = decodeURIComponent(path.split('/')[3]), submitted = request.postDataJSON();
      mutations.push({ id, action: 'settle', ...submitted, settlementHeader: request.headers()['x-settlement-id'] });
      orders.find(item => item.id === id).status = 'completed';
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(payload) });
  });
  await page.route('http://127.0.0.1:9124/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    let payload = { ok: true, version: '2026.10.08.2', workstation: { id: 'table-workspace' }, ledger: 'ready' };
    if (path === '/v1/config') payload.config = config;
    if (path === '/v1/setup-status') payload = { ...payload, configuredBillPrinterCount: 1, configuredKotRouteCount: 1, printers: [{ id: 'Kitchen queue', name: 'Kitchen queue' }, { id: 'Bill queue', name: 'Bill queue' }] };
    if (path === '/v1/printers') payload.printers = [{ id: 'Kitchen queue', name: 'Kitchen queue' }, { id: 'Bill queue', name: 'Bill queue' }];
    if (path === '/v1/ledger/actions') payload.actions = [];
    if (path === '/v1/print-bill') billJobs.push(request.postDataJSON());
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(payload) });
  });
  await page.goto('/orders.html');
  await expect(page.locator('#table-view-panel')).toBeVisible();
  await expect(page.locator('#table-view-content [data-dine-table-number]')).toHaveCount(crowded ? 33 : 29);
  await expect(tile(page, 'AC', 1)).toHaveClass(/is-kot/);
  return { mutations, billJobs, dialogs, orders, orderReads };
}

const tile = (page, area, number) => page.locator(`#table-view-content [data-dine-table-area="${area}"][data-dine-table-number="${number}"]`);

test('allocated areas distinguish available, saved, held, KOT and printed tables', async ({ page }) => {
  const { dialogs } = await tableApp(page);
  await expect(page.locator('.table-area')).toHaveCount(3);
  await expect(page.locator('.table-area').filter({ has: page.locator('h3', { hasText: /^AC$/ }) }).locator('[data-dine-table-number]')).toHaveCount(6);
  await expect(page.locator('.table-area').filter({ has: page.locator('h3', { hasText: /^NON AC$/ }) }).locator('[data-dine-table-number]')).toHaveCount(18);
  await expect(page.locator('.table-area').filter({ has: page.locator('h3', { hasText: /^BAR$/ }) }).locator('[data-dine-table-number]')).toHaveCount(5);
  await expect(tile(page, 'AC', 2)).toHaveClass(/is-running/);
  await expect(tile(page, 'NON AC', 6)).toHaveClass(/is-running/);
  await expect(tile(page, 'AC', 3)).toHaveClass(/is-printed/);
  await expect(tile(page, 'BAR', 2)).toHaveClass(/is-kot/);
  await expect(tile(page, 'NON AC', 1)).toHaveClass(/is-blank/);
  await expect(page.locator('[data-open-saved-table]')).toHaveCount(2);
  expect(dialogs).toEqual([]);
});

test('header controls open the requested workspace and installation help', async ({ page }) => {
  const { dialogs } = await tableApp(page);
  await page.locator('#live-orders-toggle').click();
  await expect(page.locator('#live-orders-panel')).toBeVisible();
  await expect(page.locator('#live-orders-toggle')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#table-view-panel')).toBeHidden();
  await page.locator('#operations-toggle').click();
  await expect(page.locator('#operations-panel')).toBeVisible();
  await expect(page.locator('#live-orders-panel')).toBeHidden();
  await page.locator('#availability-toggle').click();
  await expect(page.locator('#availability')).toBeVisible();
  await expect(page.locator('#operations-panel')).toBeHidden();
  await page.locator('#install-shortcut').click();
  await expect(page.locator('#shortcut-dialog')).toBeVisible();
  await expect(page.locator('#shortcut-steps')).toContainText(/Install app|Create shortcut/);
  await page.locator('#shortcut-close').click();
  await expect(page.locator('#shortcut-dialog')).toBeHidden();
  await page.locator('#new-order-action').click();
  await expect(page.locator('#table-view-panel')).toBeVisible();
  expect(dialogs).toEqual([]);
});

test('area, state and guest search combine without losing table identity', async ({ page }) => {
  await tableApp(page);
  await expect(page.locator('#table-view-stats')).toContainText('29');
  await page.locator('#table-area-filter').selectOption('NON AC');
  await expect(page.locator('#table-view-content [data-dine-table-number]')).toHaveCount(18);
  await page.locator('[data-table-status="active"]').click();
  await expect(page.locator('#table-view-content [data-dine-table-number]')).toHaveCount(1);
  await expect(tile(page, 'NON AC', 6)).toBeVisible();
  await page.locator('#table-area-filter').selectOption('all');
  await page.locator('#table-search').fill('Anita');
  await expect(page.locator('#table-view-content [data-dine-table-number]')).toHaveCount(1);
  await expect(tile(page, 'AC', 2)).toBeVisible();
  await page.locator('#table-search').fill('');
  await page.locator('[data-table-status="printed"]').click();
  await expect(page.locator('#table-view-content [data-dine-table-number]')).toHaveCount(1);
  await expect(tile(page, 'AC', 3)).toBeVisible();
  await page.locator('[data-table-status="available"]').click();
  await expect(page.locator('#table-view-content [data-dine-table-number]')).toHaveCount(24);
  await expect(tile(page, 'NON AC', 1)).toBeVisible();
  await page.locator('[data-table-status="all"]').click();
  await page.locator('#table-search').fill('BAR');
  await expect(page.locator('#table-view-content [data-dine-table-number]')).toHaveCount(5);
  await page.locator('#table-search').fill('no such table');
  await expect(page.locator('#table-view-content [data-dine-table-number]')).toHaveCount(0);
  await expect(page.locator('#table-view-content')).toContainText(/no.*match|no.*table/i);
  await page.locator('#table-search').fill('');
  await expect(page.locator('#table-view-content [data-dine-table-number]')).toHaveCount(29);
});

test('Delivery shows delivery orders immediately and Refresh restores the allocated floor plan', async ({ page }) => {
  const { orderReads, dialogs } = await tableApp(page);
  await page.locator('[data-fulfillment-filter="delivery"]').click();
  await expect(page.locator('#live-orders-panel')).toBeVisible();
  await expect(page.locator('#table-view-panel')).toBeHidden();
  await expect(page.locator('[data-fulfillment-filter="delivery"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#orders [data-order-id]')).toHaveCount(1);
  await expect(page.locator('#orders [data-order-id="delivery-order"]')).toBeVisible();
  const initialReads = orderReads.length;
  await page.locator('.header-actions button[onclick]').click();
  await expect(page.locator('#table-view-panel')).toBeVisible();
  await expect(page.locator('#table-view-content [data-dine-table-number]')).toHaveCount(29);
  await expect.poll(() => orderReads.length).toBeGreaterThan(initialReads);
  expect(dialogs).toEqual([]);
});

test('an available table opens a clean dine-in order and Takeaway opens its own workspace', async ({ page }) => {
  await tableApp(page);
  await tile(page, 'NON AC', 18).click();
  await expect(page.locator('#counter-order-panel')).toBeVisible();
  await expect(page.locator('#counter-order-panel .counter-order-head h2')).toHaveText('NON AC · Table 18');
  await expect(page.locator('#counter-cart-items .counter-cart-line')).toHaveCount(0);
  await expect(page.locator('#counter-customer-name')).toHaveValue('');
  await expect(page.locator('[data-dine-action="kot-print"]')).toBeVisible();
  await page.locator('#new-order-action').click();
  await expect(page.locator('#counter-order-panel')).toBeHidden();
  await page.locator('[data-fulfillment-filter="pickup"]').click();
  await expect(page.locator('#counter-order-panel .counter-order-head h2')).toHaveText('Takeaway');
  await expect(page.locator('#counter-place-order')).toBeVisible();
  await expect(page.locator('#dine-in-actions')).toBeHidden();
});

test('View order and saved-bill shortcuts load the correct guest, items and total', async ({ page }) => {
  await tableApp(page);
  await page.locator('[data-view-table-order="ac-saved"]').click();
  await expect(page.locator('#counter-order-panel .counter-order-head h2')).toHaveText('AC · Table 02');
  await expect(page.locator('#counter-customer-name')).toHaveValue('Anita');
  await expect(page.locator('#counter-customer-phone')).toHaveValue('9999999999');
  await expect(page.locator('#counter-special-request')).toHaveValue('Less spicy');
  await expect(page.locator('#counter-total')).toHaveText('₹400');
  await expect(page.locator('#counter-cart-items .counter-cart-line')).toHaveCount(1);
  await expect(page.locator('#counter-cart-items .counter-quantity b')).toHaveText('2');
  await page.locator('#new-order-action').click();
  await page.locator('[data-open-saved-table="NON AC"][data-open-saved-number="6"]').click();
  await expect(page.locator('#counter-order-panel .counter-order-head h2')).toHaveText('NON AC · Table 06');
  await expect(page.locator('#counter-customer-phone')).toHaveValue('');
  await expect(page.locator('#counter-total')).toHaveText('₹200');
});

test('move mode transfers one active table and excludes occupied and source destinations', async ({ page }) => {
  const { mutations, dialogs } = await tableApp(page);
  await page.locator('[data-toggle-move-kot]').click();
  await expect(page.locator('[data-toggle-move-kot]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('[data-move-table-order]')).toHaveCount(5);
  await expect(page.locator('[data-print-table-bill]')).toHaveCount(0);
  await tile(page, 'AC', 1).click();
  await expect(page.locator('#move-table-dialog')).toBeVisible();
  await expect(page.locator('#move-table-dialog [data-move-table-area="AC"][data-move-table-number="1"]')).toHaveCount(0);
  await expect(page.locator('#move-table-dialog [data-move-table-area="AC"][data-move-table-number="2"]')).toHaveCount(0);
  await expect(page.locator('#move-table-dialog [data-move-table-area="AC"][data-move-table-number="3"]')).toHaveCount(0);
  await expect(page.locator('#move-table-dialog [data-move-table-area="NON AC"][data-move-table-number="6"]')).toHaveCount(0);
  await page.locator('#move-table-dialog [data-move-table-area="BAR"][data-move-table-number="5"]').click();
  await page.locator('.move-table-confirm').click();
  await expect(page.locator('#move-table-dialog')).toBeHidden();
  expect(mutations.filter(item => item.action === 'move')).toEqual([{ id: 'ac-kot', action: 'move', tableArea: 'BAR', tableNumber: 5 }]);
  await expect(tile(page, 'AC', 1)).toHaveClass(/is-blank/);
  await expect(tile(page, 'BAR', 5)).toHaveAttribute('data-move-table-order', 'ac-kot');
  expect(dialogs).toEqual([]);
});

test('printer action prints the selected bill and settlement frees that exact table', async ({ page }) => {
  const { billJobs, mutations, dialogs } = await tableApp(page);
  await page.locator('[data-print-table-bill="ac-saved"]').click();
  await expect.poll(() => billJobs.length).toBe(1);
  expect(billJobs[0]).toMatchObject({ printerName: 'Bill queue', order: { id: 'ac-saved', table_area: 'AC', table_number: 2, total: 400 } });
  expect(billJobs[0].printJobId).toMatch(/^manual-bill:ac-saved:/);
  await expect(tile(page, 'AC', 2)).toHaveAttribute('data-settle-table-order', 'ac-saved');
  await tile(page, 'AC', 2).click();
  await expect(page.locator('#settle-table-dialog')).toBeVisible();
  await expect(page.locator('#settlement-amount')).toHaveValue('400');
  await page.locator('input[name="settlement-type"][value="upi"]').check();
  await page.locator('.settle-confirm').click();
  await expect(page.locator('#settle-table-dialog')).toBeHidden();
  const settlement = mutations.find(item => item.action === 'settle');
  expect(settlement).toMatchObject({ id: 'ac-saved', paymentType: 'upi', amount: 400 });
  expect(settlement.requestId).toMatch(/^settlement-/);
  expect(settlement.settlementHeader).toBe(settlement.requestId);
  await expect(tile(page, 'AC', 2)).toHaveClass(/is-blank/);
  await expect(tile(page, 'AC', 3)).toHaveClass(/is-printed/);
  expect(billJobs).toHaveLength(1);
  expect(dialogs).toEqual([]);
});

for (const viewport of [{ width: 1440, height: 900 }, { width: 1180, height: 820 }, { width: 810, height: 1080 }, { width: 390, height: 844 }]) {
  test(`header and 33-table floor plan fit ${viewport.width}×${viewport.height} with touch controls`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await tableApp(page, { crowded: true });
    const layout = await page.evaluate(() => {
      const controls = [...document.querySelectorAll('.header-actions button, .fulfillment-actions button, #table-view-panel button')].filter(button => button.getClientRects().length);
      return {
        viewport: innerWidth, document: document.documentElement.scrollWidth,
        narrowControls: controls.filter(button => { const box = button.getBoundingClientRect(); return box.width < 43.5 || box.height < 43.5; }).map(button => ({ label: button.getAttribute('aria-label') || button.textContent, width: button.getBoundingClientRect().width, height: button.getBoundingClientRect().height })),
        clippedCards: [...document.querySelectorAll('#table-view-panel .table-tile')].filter(card => { const box = card.getBoundingClientRect(); return box.left < 0 || box.right > innerWidth + 1; }).length,
      };
    });
    expect(layout.document).toBe(layout.viewport);
    expect(layout.clippedCards).toBe(0);
    expect(layout.narrowControls).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath(`table-workspace-${viewport.width}.png`), fullPage: true });
  });
}
