const { test, expect } = require('@playwright/test');

test.use({ serviceWorkers: 'block' });

test('orders page loads with expected title', async ({ page }) => {
  await page.goto('/orders.html');
  await expect(page).toHaveTitle(/Red Lantern Orders/i);
  await expect(page.locator('header')).toBeVisible();
  await expect(page.locator('#orders')).toHaveCount(1);
});

test('captain page loads with login screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route('**/api/captain/accounts', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        captains: [{ id: 'captain-1', name: 'Ravi', areas: ['Dining Hall'] }],
      }),
    })
  );
  await page.goto('/captain.html');
  await expect(page).toHaveTitle(/Captain/i);
  await expect(page.locator('#captain-login')).toBeVisible();
  await expect(page.locator('#captain-account-list')).toBeVisible();
  await expect(page.locator('.captain-header')).toBeHidden();
  await expect(page.locator('.captain-auth-card')).toBeInViewport();

  const layout = await page.locator('.captain-auth-card').evaluate((card) => ({
    cardLeft: card.getBoundingClientRect().left,
    cardRight: card.getBoundingClientRect().right,
    documentWidth: document.documentElement.scrollWidth,
    viewportWidth: window.innerWidth,
  }));
  expect(layout.cardLeft).toBeGreaterThanOrEqual(0);
  expect(layout.cardRight).toBeLessThanOrEqual(layout.viewportWidth);
  expect(layout.documentWidth).toBe(layout.viewportWidth);
});
