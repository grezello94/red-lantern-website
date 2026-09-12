const { test, expect } = require('@playwright/test');

test('Captain table board stays vertically scrollable on desktop', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    let body = {};
    if (url.pathname === '/api/captain/accounts') {
      body = {
        captains: [{ id: 'captain-1', name: 'Grezello', areas: ['AC', 'NON AC', 'BAR'] }],
      };
    } else if (url.pathname === '/api/captain/login') {
      body = {
        token: 'test-token',
        captain: {
          id: 'captain-1',
          name: 'Grezello',
          areas: ['AC', 'NON AC', 'BAR'],
          idleMinutes: 120,
        },
      };
    } else if (url.pathname === '/api/orders/operations') {
      body = {
        config: {
          tableAreas: [
            { id: 'ac', name: 'AC', from: 1, to: 6 },
            { id: 'non-ac', name: 'NON AC', from: 1, to: 18 },
            { id: 'bar', name: 'BAR', from: 1, to: 5 },
          ],
        },
      };
    } else if (
      url.pathname === '/api/orders/menu' ||
      url.pathname === '/api/orders' ||
      url.pathname === '/api/orders/availability'
    ) {
      body = [];
    } else if (url.pathname === '/api/captain/menu-insights') {
      body = { items: [] };
    } else if (url.pathname === '/api/captain/ready-alerts') {
      body = { alerts: [] };
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
  });

  await page.goto('/captain.html');
  await page.locator('[data-captain-id="captain-1"]').click();
  await page.locator('#captain-pin').fill('1234');
  await page.locator('#captain-pin-form').dispatchEvent('submit');
  await expect(page.locator('#table-board .table-tile')).toHaveCount(29);

  const dimensions = await page.evaluate(() => ({
    viewport: window.innerHeight,
    scrollHeight: document.scrollingElement.scrollHeight,
    bodyOverflow: getComputedStyle(document.body).overflow,
    htmlOverflow: getComputedStyle(document.documentElement).overflow,
  }));
  expect(dimensions.scrollHeight).toBeGreaterThan(dimensions.viewport);
  expect(dimensions.bodyOverflow).not.toContain('hidden');
  expect(dimensions.htmlOverflow).not.toContain('hidden');

  await page.locator('#area-tabs').hover();
  await page.mouse.wheel(0, 700);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
});
