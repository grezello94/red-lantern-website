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

async function mockAdmin(page, { onRequest } = {}) {
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    onRequest?.(request, url);
    let body = {};
    let contentType = 'application/json';
    if (url.pathname === '/api/admin/content') body = sampleContent();
    else if (url.pathname === '/api/admin/trusted-contacts')
      body = {
        contacts: [
          {
            customer_phone: '9876543210',
            customer_name: 'A trusted customer with a deliberately long name',
            blocked: false,
            last_items: [
              { name: 'A long latest-order dish name that must remain inside its strip', quantity: 2 },
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

test('admin restores a trusted-contact deep link after refresh and fits a phone', async ({ page }) => {
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
  const savedNames = await page
    .locator('form[action="/api/update-airMenu"]')
    .evaluate((form) => ({
      food: new FormData(form).getAll('airItemName[]'),
      bar: new FormData(form).getAll('airBarItemName[]'),
    }));
  expect(savedNames.food).toHaveLength(100);
  expect(savedNames.food).toContain('Food item 100');
  expect(savedNames.bar).toHaveLength(50);
  expect(savedNames.bar).toContain('Bar item 50');
});
