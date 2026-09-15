const { test, expect } = require('@playwright/test');

async function expectNoPageOverflow(page) {
  const overflow = await page.evaluate(() => ({
    viewport: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    bodyWidth: document.body.scrollWidth,
  }));
  expect(overflow.documentWidth).toBeLessThanOrEqual(overflow.viewport);
  expect(overflow.bodyWidth).toBeLessThanOrEqual(overflow.viewport);
}

function sampleContent() {
  const items = Array.from({ length: 100 }, (_, index) => ({
    name: `Food item ${index + 1}`,
    category: index % 2 ? 'SOUP' : 'STARTER',
    price: `₹${100 + index}`,
    type: 'food',
  }));
  const barItems = Array.from({ length: 50 }, (_, index) => ({
    name: `Bar item ${index + 1}`,
    category: 'BEVERAGES',
    price: `₹${150 + index}`,
    type: 'beverage',
  }));
  return {
    home: {},
    menu: {},
    about: {},
    blogs: {},
    contact: {},
    global: {},
    airMenu: { items, barItems, proximity: { locked: true } },
  };
}

async function mockAdmin(page, { onRequest, content = sampleContent() } = {}) {
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    onRequest?.(request, url);
    let body = {};
    let contentType = 'application/json';
    if (url.pathname === '/api/admin/content') body = content;
    else if (url.pathname === '/api/admin/analytics')
      body = {
        generatedAt: '2026-09-14T12:00:00.000Z',
        range: {
          preset: url.searchParams.get('preset') || 'today',
          label: url.searchParams.get('preset') === 'custom' ? '1 Sept – 14 Sept 2026' : 'Today',
          from: url.searchParams.get('from') || '2026-09-14',
          to: url.searchParams.get('to') || '2026-09-14',
          days: url.searchParams.get('preset') === 'custom' ? 14 : 1,
        },
        summary: {
          net_sales: 12500,
          collected: 11750,
          outstanding: 750,
          completed_bills: 24,
          average_bill: 521,
          total_orders: 28,
          order_value: 13200,
          live_orders: 2,
          cancelled_orders: 1,
          rejected_orders: 1,
          tips: 180,
        },
        comparison: { sales: 12.5, bills: 9.1, averageBill: 3.2 },
        channels: [
          { channel: 'dine_in', bills: 15, sales: 8000 },
          { channel: 'takeaway', bills: 9, sales: 4500 },
        ],
        payments: [
          { payment_type: 'upi', bills: 16, amount: 8000, outstanding: 0, tips: 180 },
          { payment_type: 'cash', bills: 8, amount: 3750, outstanding: 0, change: 250 },
          { payment_type: 'due', bills: 1, amount: 0, outstanding: 750 },
        ],
        trend: [
          { day: '2026-09-13', bills: 11, sales: 5000 },
          { day: '2026-09-14', bills: 13, sales: 7500 },
        ],
        topItems: [{ name: 'Chicken Crispy', portion: 'Regular', quantity: 18, sales: 3960 }],
        recentOrders: [
          {
            daily_order_number: 28,
            bill_number: 1028,
            mode: 'table',
            table_area: 'NON AC',
            table_number: 3,
            total: 920,
            status: 'completed',
            settlement_type: 'part',
            payment_methods: ['cash', 'upi'],
            created_at: '2026-09-14T11:00:00.000Z',
          },
        ],
        kots: {
          summary: { total_kots: 30, cancelled_kots: 2, modified_kots: 3, shifted_kots: 1 },
          exceptions: [
            {
              kind: 'shifted',
              event_at: '2026-09-14T11:10:00.000Z',
              daily_order_number: 28,
              kot_number: 30,
              table_area: 'NON AC',
              table_number: 3,
              affected_kots: 1,
              details: { fromArea: 'AC', fromNumber: 2, toArea: 'NON AC', toNumber: 3 },
            },
          ],
        },
        bills: {
          summary: {
            issued_bills: 28,
            completed_bills: 24,
            cancelled_bills: 1,
            modified_bills: 1,
            printed_bills: 24,
          },
          exceptions: [
            {
              kind: 'cancelled',
              event_at: '2026-09-14T10:00:00.000Z',
              daily_order_number: 20,
              bill_number: 1020,
              mode: 'counter',
              total: 450,
              details: { reason: 'Guest changed plan' },
            },
          ],
        },
        definitions: {
          sales: 'Completed bills only.',
          collections: 'Money actually collected.',
          outstanding: 'Unpaid completed bill balances.',
          cancelledKot: 'Stored KOT rounds attached to a cancelled order.',
          modifiedKot: 'Items changed after the first KOT.',
          shiftedKot: 'Table moved after the first KOT.',
          cancelledBill: 'A numbered cancelled bill.',
          modifiedBill: 'Items changed after printing.',
        },
      };
    else if (url.pathname === '/api/admin/trusted-contacts')
      body = {
        contacts: [
          {
            customer_phone: '9876543210',
            customer_name: 'A trusted customer with a deliberately long name',
            blocked: false,
            last_items: [
              {
                name: 'A long latest-order dish name that must remain inside its strip',
                quantity: 2,
              },
            ],
            last_order_at: '2026-09-01T10:00:00.000Z',
          },
        ],
        page: 1,
        limit: 50,
        total: 1,
      };
    else if (url.pathname === '/api/admin/table-qr-codes')
      body = {
        codes: [{ areaId: 'ac', areaName: 'AC', tableNumber: 1, enabled: true }],
      };
    else if (url.pathname.startsWith('/api/update-')) {
      body = 'Saved';
      contentType = 'text/plain';
    }
    await route.fulfill({
      status: 200,
      contentType,
      body: contentType === 'application/json' ? JSON.stringify(body) : body,
    });
  });
}

test('sales dashboard presents operational controls and fits a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockAdmin(page);
  await page.goto('/admin.html#tab-sales-dashboard');

  await expect(page.locator('#tab-sales-dashboard')).toHaveClass(/active/);
  await expect(page.locator('#analytics-kpis')).toContainText('₹12,500');
  await expect(page.locator('#analytics-kot-stats')).toContainText('Cancelled');
  await expect(page.locator('#analytics-bill-stats')).toContainText('Modified after print');
  await expect(page.locator('#analytics-kot-exceptions')).toContainText('shifted');
  await expect(page.locator('#analytics-bill-exceptions')).toContainText('Guest changed plan');
  await expect(page.locator('#analytics-recent-orders')).toContainText('Cash + UPI / GPay');
  await expectNoPageOverflow(page);

  await page.locator('[data-analytics-preset="custom"]').click();
  await expect(page.locator('#analytics-custom-range')).toBeVisible();
  await page.locator('#analytics-from').fill('2026-09-01');
  await page.locator('#analytics-to').fill('2026-09-14');
  await page.locator('#analytics-apply-range').click();
  await expect(page.locator('#analytics-range-label')).toContainText('1 Sept');
  await expectNoPageOverflow(page);
});

test('dedicated dashboard presents the same analytics at /dashboard', async ({ page }) => {
  let analyticsLoads = 0;
  await page.setViewportSize({ width: 390, height: 844 });
  await mockAdmin(page, {
    onRequest: (_request, url) => {
      if (url.pathname === '/api/admin/analytics') analyticsLoads += 1;
    },
  });
  await page.goto('/dashboard.html');

  await expect(page).toHaveTitle(/Sales Dashboard/);
  await expect(page.locator('#analytics-kpis')).toContainText('₹12,500');
  await expect(page.locator('#analytics-kot-stats')).toContainText('Cancelled');
  await expect(page.locator('#dashboard-logout')).toBeVisible();
  await expect(page.locator('#analytics-sync-state')).toBeVisible();
  await expectNoPageOverflow(page);

  const initialLoads = analyticsLoads;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect.poll(() => analyticsLoads).toBeGreaterThan(initialLoads);

  for (const viewport of [
    { width: 320, height: 568 },
    { width: 360, height: 800 },
    { width: 768, height: 1024 },
    { width: 1280, height: 800 },
  ]) {
    await page.setViewportSize(viewport);
    await expectNoPageOverflow(page);
  }

  await page.setViewportSize({ width: 320, height: 568 });
  await expect(page.locator('.analytics-kpis')).toHaveCSS('grid-template-columns', /\d+px/);
  expect(
    await page.locator('.analytics-kpis').evaluate((element) =>
      getComputedStyle(element).gridTemplateColumns.trim().split(/\s+/).length,
    ),
  ).toBe(1);
  await expect(page.locator('.analytics-table-hint').first()).toBeVisible();
  const mobileTable = await page.locator('.analytics-table-wrap').first().evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  expect(mobileTable.scrollWidth).toBeGreaterThan(mobileTable.clientWidth);
});

test('admin restores a trusted-contact deep link after refresh and fits a phone', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockAdmin(page);
  await page.goto('/admin.html#tab-trusted-contacts');

  await expect(page.locator('#tab-trusted-contacts')).toHaveClass(/active/);
  await expect(page.locator('#trusted-contact-count')).toContainText('1 trusted contact');
  await expect(page.locator('.trusted-contact-strip')).toBeVisible();
  await expectNoPageOverflow(page);

  await page.reload();
  await expect(page.locator('#tab-trusted-contacts')).toHaveClass(/active/);
  await expect(page.locator('#trusted-contact-count')).toContainText('1 trusted contact');
  await expectNoPageOverflow(page);
});

test('Air Menu defers large sheets, preserves all rows on save, and does not preload QR images', async ({
  page,
}) => {
  const requestedUrls = [];
  await mockAdmin(page, {
    onRequest: (request, url) => {
      requestedUrls.push(url);
    },
  });
  await page.goto('/admin.html#tab-air-menu');

  await expect(page.locator('#air-food-sheet-count')).toHaveText('100 items');
  await expect(page.locator('#air-bar-sheet-count')).toHaveText('50 items');
  await expect(page.locator('#air-items-container .air-item-entry')).toHaveCount(0);
  await expect(page.locator('#air-bar-items-container .air-bar-item-entry')).toHaveCount(0);
  expect(
    requestedUrls.filter(
      (url) => url.pathname === '/api/admin/qr/table' && url.searchParams.has('area')
    )
  ).toHaveLength(0);

  await page.locator('form[action="/api/update-airMenu"]').evaluate((form) => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  await expect(page.locator('#air-items-container .air-item-entry')).toHaveCount(100);
  await expect(page.locator('#air-bar-items-container .air-bar-item-entry')).toHaveCount(50);
  const savedNames = await page.locator('form[action="/api/update-airMenu"]').evaluate((form) => ({
    food: new FormData(form).getAll('airItemName[]'),
    bar: new FormData(form).getAll('airBarItemName[]'),
  }));
  expect(savedNames.food).toHaveLength(100);
  expect(savedNames.food).toContain('Food item 100');
  expect(savedNames.bar).toHaveLength(50);
  expect(savedNames.bar).toContain('Bar item 50');
});

test('Admin preserves add-on rules, availability and dish assignments in the saved payload', async ({
  page,
}) => {
  const content = sampleContent();
  content.airMenu.addonGroups = [
    {
      id: 'extras',
      name: 'Extras',
      displayName: 'Choose extras',
      selection: 'multiple',
      min: 1,
      max: 2,
      active: true,
      assignedItemKeys: [],
      options: [
        { id: 'cheese', name: 'Cheese', price: 50, dietary: 'veg', active: true },
        { id: 'olive', name: 'Olives', price: 30, dietary: 'veg', active: true },
      ],
    },
  ];
  await mockAdmin(page, { content });
  await page.goto('/admin.html#tab-air-menu');

  const group = page.locator('[data-addon-group="extras"]');
  await expect(group).toBeVisible();
  await expect(group.locator('[data-addon-field="min"]')).toHaveValue('1');
  await expect(group.locator('[data-addon-field="max"]')).toHaveValue('2');
  await group.locator('[data-addon-option="active"][data-option-index="1"]').uncheck();
  await expect(group.locator('.addon-option-active').nth(1)).toContainText('No');
  await group.locator('[data-addon-assign]').click();
  await page.locator('#addon-assignment-list input').first().check();
  await page.locator('.addon-assignment-save').click();
  await expect(group.locator('[data-addon-assign] b')).toHaveText('1');

  const saved = await page.locator('#air-addon-groups').inputValue();
  expect(JSON.parse(saved)).toMatchObject([
    {
      id: 'extras',
      min: 1,
      max: 2,
      selection: 'multiple',
      assignedItemKeys: [expect.any(String)],
      options: [
        { id: 'cheese', price: 50, active: true },
        { id: 'olive', price: 30, active: false },
      ],
    },
  ]);
});
