const { test, expect } = require('@playwright/test');

test('orders page loads with expected title', async ({ page }) => {
  await page.goto('/orders.html');
  await expect(page).toHaveTitle(/Red Lantern Orders/i);
  await expect(page.locator('header')).toBeVisible();
  await expect(page.locator('#orders')).toHaveCount(1);
});

test('captain page loads with login screen', async ({ page }) => {
  await page.goto('/captain.html');
  await expect(page).toHaveTitle(/Captain/i);
  await expect(page.locator('#captain-login')).toBeVisible();
  await expect(page.locator('#captain-account-list')).toBeVisible();
});
