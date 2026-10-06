const { test, expect } = require('@playwright/test');

async function openCardMenu(page, windows) {
  await page.route('**/api/air-menu?*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        mode: 'card',
        pageTitle: 'Red Lantern',
        pageSubtitle: 'Menu',
        note: '',
        dishes: [],
        directOrdersEnabled: true,
        deliveryEnabled: true,
        cardOrderPhone: '+91 98765 43210',
        cardCallEnabled: false,
        ...windows,
      }),
    })
  );
  await page.goto(`/air-menu.html?mode=card&expires=${Date.now() + 3600000}&signature=test`);
}

test('closed Business Card QR window shows the call number and hides direct ordering', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-06T17:30:00Z'));
  await openCardMenu(page, {
    cardOrderWindow: { enabled: true, start: '10:00', end: '22:00' },
  });
  await expect(page.locator('#order-window-notice')).toContainText('Business Card QR direct ordering is closed');
  await expect(page.locator('#order-window-notice a')).toHaveAttribute('href', 'tel:+919876543210');
  await expect(page.locator('#place-direct-order')).toBeHidden();
});

test('closed delivery window keeps Business Card QR pickup available', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-10-06T16:00:00Z'));
  await openCardMenu(page, {
    cardOrderWindow: { enabled: true, start: '10:00', end: '22:00' },
    deliveryOrderWindow: { enabled: true, start: '10:00', end: '21:00' },
  });
  await expect(page.locator('#order-window-notice')).toContainText('Delivery ordering is closed');
  await expect(page.locator('#order-fulfillment-type option')).toHaveCount(1);
  await expect(page.locator('#order-fulfillment-type')).toHaveValue('pickup');
});
