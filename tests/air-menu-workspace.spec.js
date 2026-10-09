const { test, expect } = require('@playwright/test');

test.use({ serviceWorkers: 'block' });

const dishes = [
  { name: 'Masala French Fries', category: 'Quick Bites', price: '170', dietary: 'veg' },
  { name: 'Garlic French Fries', category: 'Quick Bites', price: '150', dietary: 'veg' },
  { name: 'Tomato Salad', category: 'Salads', price: '120', dietary: 'veg' },
  { name: 'Chicken Clear Soup', category: 'Soup', halfPrice: '110', fullPrice: '190', dietary: 'nonveg' },
  { name: 'Veg Crispy', category: 'Starters', price: '200', dietary: 'veg', bestSeller: true },
  { name: 'Chicken Chilli', category: 'Starters', halfPrice: '150', fullPrice: '280', dietary: 'nonveg', gravyStyleAvailable: true },
  {
    name: 'Paneer Tikka', category: 'Tandoor', price: '220', dietary: 'veg', gravyStyleAvailable: true,
    addonGroups: [{
      id: 'paneer-extra', name: 'Extra topping', displayName: 'Extra topping', selection: 'single', min: 1, max: 1,
      options: [{ id: 'cheese', name: 'Cheese', price: 40, dietary: 'veg', active: true }],
    }],
  },
  {
    name: 'Red Lantern Signature Tandoori Vegetable Platter', category: 'Tandoor', price: '300', dietary: 'veg', mustHave: true,
    description: 'Fresh vegetables and paneer with our signature marinade, served with mint chutney.',
  },
  { name: 'Virgin Mojito', category: 'Mocktails', price: '200', type: 'beverage', isBar: true },
  { name: 'Signature Whisky', category: 'Spirits', price30ml: '120', price60ml: '240', price90ml: '360', price180ml: '720', type: 'beverage', isBar: true },
];

async function guestMenu(page, overrides = {}) {
  const requests = [];
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    let body = { ok: true };
    if (path === '/api/air-menu') body = {
      mode: 'card', pageTitle: 'Our Menu', pageSubtitle: 'Explore freshly prepared food and beverages.',
      note: 'Please confirm the final bill with our team.', dishes, showPrices: true,
      directOrdersEnabled: true, deliveryEnabled: true, cardOrderPhone: '+91 98765 43210',
      cardCallEnabled: true, cardOrderWindow: { enabled: false }, deliveryOrderWindow: { enabled: false },
      ...overrides,
    };
    else if (path === '/api/loyalty') body = { points: 0 };
    else if (path === '/api/direct-orders' && request.method() === 'POST') {
      requests.push({ body: request.postDataJSON(), requestId: request.headers()['x-direct-order-id'] });
      body = { orderNumber: 42, autoAccepted: true, trackingUrl: '/order-status?token=fixture' };
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });
  const mode = overrides.mode || 'card';
  await page.goto(`/air-menu.html?mode=${mode}&expires=${Date.now() + 3600000}&signature=air-menu-workspace`);
  await expect(page.locator('#menu-content .dish:visible')).toHaveCount(8);
  return { requests, errors };
}

const dish = (page, name) => page.locator('#menu-content .dish').filter({ has: page.locator('h3', { hasText: name }) });
const summaryLine = (page, name) => page.locator('#order-summary-items .summary-item').filter({ hasText: name });
const price = amount => new RegExp(`₹\\s*${Number(amount).toLocaleString('en-IN')}(?:\\.00)?\\b`);

async function selectCategory(page, name) {
  const option = page.locator('#category-select option').filter({ hasText: new RegExp(`^${name}\\b`, 'i') }).first();
  await page.locator('#category-select').selectOption(await option.getAttribute('value'));
}

test('Food and Bar menus show their own dishes, category counts and selected tab', async ({ page }) => {
  const { errors } = await guestMenu(page);
  const food = page.locator('#menu-type-nav [data-menu-type="food"]');
  const bar = page.locator('#menu-type-nav [data-menu-type="bar"]');
  await expect(food).toHaveAttribute('aria-pressed', 'true');
  await expect(food).toContainText('8');
  await expect(bar).toContainText('2');
  await expect(page.locator('#menu-results-summary')).toContainText(/8.*(?:food|dish|item)/i);
  await expect(dish(page, 'Virgin Mojito')).toBeHidden();
  await bar.click();
  await expect(bar).toHaveAttribute('aria-pressed', 'true');
  await expect(food).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('#menu-content .dish:visible')).toHaveCount(2);
  await expect(page.locator('#menu-results-summary')).toContainText(/2.*(?:bar|drink|dish|item)/i);
  await expect(dish(page, 'Virgin Mojito')).toBeVisible();
  await expect(page.locator('#category-nav button').filter({ hasText: 'Quick Bites' })).toBeHidden();
  await food.click();
  await expect(page.locator('#menu-content .dish:visible')).toHaveCount(8);
  expect(errors).toEqual([]);
});

test('search updates visible counts and prevents navigation to hidden categories', async ({ page }) => {
  await guestMenu(page);
  await expect(page.locator('#menu-search')).toHaveAccessibleName(/search/i);
  await page.locator('#menu-search').fill('Soup');
  await expect(page.locator('#menu-content .dish:visible')).toHaveCount(1);
  await expect(page.locator('#menu-results-summary')).toContainText(/1.*(?:dish|item|result)/i);
  await expect(page.locator('#category-nav button').filter({ hasText: 'Quick Bites' })).toBeHidden();
  await expect(page.locator('#category-select option').filter({ hasText: 'Quick Bites' })).toHaveCount(0);
  await expect(page.locator('#category-nav button').filter({ hasText: 'Soup' })).toBeVisible();
  await page.locator('#menu-search').fill('No such dish');
  await expect(page.locator('#menu-content .dish:visible')).toHaveCount(0);
  await expect(page.locator('#search-empty')).toBeVisible();
  await expect(page.locator('#menu-results-summary')).toContainText(/0.*(?:dish|item|result)/i);
  await page.locator('#menu-search').fill('');
  await expect(page.locator('#search-empty')).toBeHidden();
  await expect(page.locator('#menu-content .dish:visible')).toHaveCount(8);
});

test('category dropdown and chips jump to matching sections while other dishes remain available', async ({ page }) => {
  await guestMenu(page);
  await selectCategory(page, 'Soup');
  const soupChip = page.locator('#category-nav [data-target="food-soup"]');
  await expect(soupChip).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#food-soup')).toBeInViewport();
  await expect(page.locator('#menu-content .dish:visible')).toHaveCount(8);
  await page.locator('#category-nav [data-target="food-tandoor"]').click();
  await expect(page.locator('#category-select')).toHaveValue('food-tandoor');
  await expect(page.locator('#category-nav [data-target="food-tandoor"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#food-tandoor')).toBeInViewport();
});

test('selection totals include quantities and portions, survive reload and clear together', async ({ page }) => {
  await guestMenu(page);
  const fries = dish(page, 'Masala French Fries');
  await fries.locator('[data-order-action="plus"]').click();
  await fries.locator('[data-order-action="plus"]').click();
  const halfSoup = dish(page, 'Chicken Clear Soup').locator('.order-picker').filter({ hasText: 'Half' });
  await halfSoup.locator('[data-order-action="plus"]').click();
  await expect(fries).toHaveClass(/selected/);
  await expect(page.locator('#order-count')).toHaveText('3');
  await expect(page.locator('#order-fab-total')).toContainText(price(450));
  await page.locator('#open-order-summary').click();
  await expect(page.locator('#order-subtotal')).toContainText(price(450));
  await expect(page.locator('#order-summary')).toContainText(/estimated total/i);
  await summaryLine(page, 'Masala French Fries').locator('[data-order-action="minus"]').click();
  await expect(page.locator('#order-subtotal')).toContainText(price(280));
  await page.locator('#close-order-summary').click();
  await page.reload();
  await expect(page.locator('#order-count')).toHaveText('2');
  await expect(page.locator('#order-fab-total')).toContainText(price(280));
  await expect(fries.locator('[data-order-quantity]')).toHaveText('1');
  await page.locator('#open-order-summary').click();
  await page.locator('#clear-order').click();
  await expect(page.locator('#order-count')).toHaveText('0');
  await expect(page.locator('#open-order-summary')).toBeHidden();
  await expect(page.locator('#order-summary-items .summary-item')).toHaveCount(0);
});

test('bar measures remain separate selections and use each measure price in the estimate', async ({ page }) => {
  await guestMenu(page);
  await page.locator('#menu-type-nav [data-menu-type="bar"]').click();
  const whisky = dish(page, 'Signature Whisky');
  const thirty = whisky.locator('.order-picker').filter({ hasText: /^30 ML/ });
  const sixty = whisky.locator('.order-picker').filter({ hasText: /^60 ML/ });
  await expect(whisky.locator('.order-picker')).toHaveCount(4);
  await thirty.locator('[data-order-action="plus"]').click();
  await thirty.locator('[data-order-action="plus"]').click();
  await sixty.locator('[data-order-action="plus"]').click();
  await expect(page.locator('#order-count')).toHaveText('3');
  await expect(page.locator('#order-fab-total')).toContainText(price(480));
  await page.locator('#open-order-summary').click();
  await expect(summaryLine(page, 'Signature Whisky')).toHaveCount(2);
  await expect(page.locator('#order-subtotal')).toContainText(price(480));
  await expect(summaryLine(page, 'Signature Whisky').filter({ hasText: '30 ML' }).locator('.summary-quantity b')).toHaveText('2');
  await expect(summaryLine(page, 'Signature Whisky').filter({ hasText: '60 ML' }).locator('.summary-quantity b')).toHaveText('1');
});

test('guests can return from Gravy to Dry and summary choices keep the menu picker in sync', async ({ page }) => {
  await guestMenu(page);
  const halfChilli = dish(page, 'Chicken Chilli').locator('.order-picker').filter({ hasText: /^Half/ });
  await halfChilli.locator('[data-order-action="plus"]').click();
  await halfChilli.getByRole('radio', { name: /^Gravy/ }).check();
  await expect(page.locator('#order-fab-total')).toContainText(price(160));
  await halfChilli.getByRole('radio', { name: /^Dry/ }).check();
  await expect(page.locator('#order-fab-total')).toContainText(price(150));
  await page.locator('#open-order-summary').click();
  await summaryLine(page, 'Chicken Chilli').getByRole('radio', { name: /^Gravy/ }).check();
  await expect(page.locator('#order-subtotal')).toContainText(price(160));
  await page.locator('#close-order-summary').click();
  await expect(halfChilli.getByRole('radio', { name: /^Gravy/ })).toBeChecked();
  await expect(halfChilli.locator('[data-order-quantity]')).toHaveText('1');
  await halfChilli.locator('[data-order-action="plus"]').click();
  await expect(page.locator('#order-fab-total')).toContainText(price(320));
  await page.locator('#open-order-summary').click();
  await summaryLine(page, 'Chicken Chilli').getByRole('radio', { name: /^Dry/ }).check();
  await expect(page.locator('#order-subtotal')).toContainText(price(300));
  await expect(page.locator('#order-summary-items .summary-item')).toHaveCount(1);
});

test('required add-ons retain their surcharge and choices when guests change preparation style', async ({ page }) => {
  await guestMenu(page);
  await dish(page, 'Paneer Tikka').locator('[data-order-action="plus"]').click();
  await expect(page.locator('.air-addon-dialog')).toBeVisible();
  await expect(page.locator('#air-addon-add')).toBeDisabled();
  await page.locator('[data-air-addon-group="paneer-extra"] label').filter({ hasText: 'Cheese' }).click();
  await expect(page.locator('#air-addon-add')).toBeEnabled();
  await page.locator('#air-addon-add').click();
  await expect(page.locator('#order-fab-total')).toContainText(price(260));
  await page.locator('#open-order-summary').click();
  await expect(summaryLine(page, 'Paneer Tikka')).toContainText('Cheese');
  await summaryLine(page, 'Paneer Tikka').getByRole('radio', { name: /^Gravy/ }).check();
  await expect(summaryLine(page, 'Paneer Tikka')).toContainText('Cheese');
  await expect(page.locator('#order-subtotal')).toContainText(price(270));
  await page.locator('#close-order-summary').click();
  await page.reload();
  await expect(dish(page, 'Paneer Tikka').getByRole('radio', { name: /^Gravy/ })).toBeChecked();
  await expect(dish(page, 'Paneer Tikka').locator('[data-order-quantity]')).toHaveText('1');
  await expect(page.locator('#order-fab-total')).toContainText(price(270));
  await page.locator('#open-order-summary').click();
  await expect(summaryLine(page, 'Paneer Tikka')).toContainText('Cheese');
  await summaryLine(page, 'Paneer Tikka').getByRole('radio', { name: /^Dry/ }).check();
  await expect(page.locator('#order-subtotal')).toContainText(price(260));
  await expect(summaryLine(page, 'Paneer Tikka')).toContainText('Cheese');
  await page.locator('#close-order-summary').click();
  await page.reload();
  await page.locator('#open-order-summary').click();
  await expect(summaryLine(page, 'Paneer Tikka')).toContainText('Cheese');
  await expect(page.locator('#order-subtotal')).toContainText(price(260));
  await page.locator('#close-order-summary').click();
  await expect(dish(page, 'Paneer Tikka').locator('[data-order-quantity]')).toHaveText('1');
  await dish(page, 'Paneer Tikka').locator('[data-order-action="minus"]').click();
  await expect(page.locator('#order-count')).toHaveText('0');
  await expect(page.locator('#open-order-summary')).toBeHidden();
});

test('hidden-price menus preserve selection controls without revealing prices or totals', async ({ page }) => {
  await guestMenu(page, { showPrices: false });
  await expect(page.locator('.dish-price, .portion-prices')).toHaveCount(0);
  await dish(page, 'Masala French Fries').locator('[data-order-action="plus"]').click();
  await expect(page.locator('#open-order-summary')).toBeVisible();
  await expect(page.locator('#order-fab-total')).toBeHidden();
  await page.locator('#open-order-summary').click();
  await expect(page.locator('#order-subtotal')).toBeHidden();
  await expect(summaryLine(page, 'Masala French Fries')).toBeVisible();
  await expect(page.locator('#share-whatsapp')).not.toHaveAttribute('href', /%E2%82%B9/);
  await page.locator('#close-order-summary').click();
  const halfChilli = dish(page, 'Chicken Chilli').locator('.order-picker').filter({ hasText: /^Half/ });
  await halfChilli.locator('[data-order-action="plus"]').click();
  expect(await halfChilli.innerText()).not.toContain('₹');
  await page.locator('#open-order-summary').click();
  expect(await summaryLine(page, 'Chicken Chilli').innerText()).not.toContain('₹');
  await page.locator('#close-order-summary').click();
  await dish(page, 'Paneer Tikka').locator('[data-order-action="plus"]').click();
  await expect(page.locator('.air-addon-dialog')).toBeVisible();
  expect(await page.locator('.air-addon-dialog').innerText()).not.toContain('₹');
  await page.locator('[data-air-addon-close]').click();
});

test('a table QR retains table identity and submits its selected dish once through direct ordering', async ({ page }) => {
  const { requests, errors } = await guestMenu(page, { mode: 'table', tableLabel: 'AC Table 2', tableArea: 'AC', tableNumber: 2 });
  await expect(page.locator('#table-identity')).toContainText('AC');
  await expect(page.locator('#table-identity')).toContainText('2');
  await dish(page, 'Masala French Fries').locator('[data-order-action="plus"]').click();
  await page.locator('#open-order-summary').click();
  await expect(page.locator('#share-whatsapp')).toBeHidden();
  await page.locator('#order-customer-name').fill('Table guest');
  await page.locator('#order-customer-phone').fill('9876543210');
  await page.locator('#place-direct-order').click();
  await expect(page.locator('#confirmation-order-number')).toHaveText('#42');
  await expect(page.locator('#view-order-status')).toHaveAttribute('href', '/order-status?token=fixture');
  expect(requests).toHaveLength(1);
  expect(requests[0].body).toMatchObject({ mode: 'table', customerName: 'Table guest', customerPhone: '9876543210' });
  expect(requests[0].body.items).toEqual([expect.objectContaining({ name: 'Masala French Fries', quantity: 1, price: '170' })]);
  expect(requests[0].requestId).toBe(requests[0].body.clientRequestId);
  await page.locator('#place-another-order').click();
  await expect(page.locator('#order-confirmation')).toBeHidden();
  await expect(page.locator('#order-summary .order-dialog-head')).toBeVisible();
  await expect(page.locator('#order-summary-items .summary-item')).toHaveCount(0);
  expect(requests).toHaveLength(1);
  expect(errors).toEqual([]);
});

for (const viewport of [{ width: 320, height: 700 }, { width: 390, height: 844 }, { width: 810, height: 1080 }]) {
  test(`ten selected items stay compact and usable at ${viewport.width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    const { requests, errors } = await guestMenu(page);
    // Eight dishes, with both soup and chilli portions, make ten separate selection rows.
    for (const name of ['Masala French Fries', 'Garlic French Fries', 'Tomato Salad', 'Veg Crispy', 'Red Lantern Signature Tandoori Vegetable Platter']) {
      await dish(page, name).locator('[data-order-action="plus"]').click();
    }
    for (const name of ['Chicken Clear Soup', 'Chicken Chilli']) {
      const buttons = dish(page, name).locator('[data-order-action="plus"]');
      for (const button of await buttons.all()) await button.click();
    }
    await dish(page, 'Paneer Tikka').locator('[data-order-action="plus"]').click();
    await page.locator('[data-air-addon-group="paneer-extra"] label').filter({ hasText: 'Cheese' }).click();
    await page.locator('#air-addon-add').click();
    await page.locator('#open-order-summary').click();
    await expect(page.locator('.summary-item')).toHaveCount(10);
    await expect(page.locator('#order-subtotal')).toContainText(price(1930));
    const layout = await page.locator('#order-summary').evaluate(dialog => {
      const box = dialog.getBoundingClientRect();
      return {
        width: dialog.clientWidth, scrollWidth: dialog.scrollWidth,
        top: box.top, bottom: box.bottom, viewportHeight: innerHeight,
        narrowButtons: [...dialog.querySelectorAll('.summary-quantity button')].filter(button => button.offsetWidth < 44 || button.offsetHeight < 44).length,
        clippedRows: [...dialog.querySelectorAll('.summary-item')].filter(row => row.scrollWidth > row.clientWidth + 1).length,
        misplacedQuantities: [...dialog.querySelectorAll('.summary-item')].filter(row => row.querySelector('.summary-quantity').getBoundingClientRect().left < row.firstElementChild.getBoundingClientRect().right - 1).length,
      };
    });
    expect(layout.scrollWidth).toBeLessThanOrEqual(layout.width + 1);
    expect(layout.top).toBeGreaterThanOrEqual(0);
    expect(layout.bottom).toBeLessThanOrEqual(layout.viewportHeight + 1);
    expect(layout.narrowButtons).toBe(0);
    expect(layout.clippedRows).toBe(0);
    expect(layout.misplacedQuantities).toBe(0);
    expect((await summaryLine(page, 'Masala French Fries').boundingBox()).height).toBeLessThan(96);
    await page.screenshot({ path: testInfo.outputPath(`air-menu-ten-items-${viewport.width}.png`) });

    const halfChilli = summaryLine(page, 'Chicken Chilli').filter({ hasText: 'Half' });
    await halfChilli.getByRole('radio', { name: /^Gravy/ }).check();
    await expect(page.locator('#order-subtotal')).toContainText(price(1940));
    await expect(summaryLine(page, 'Paneer Tikka')).toContainText('Cheese');
    await summaryLine(page, 'Masala French Fries').locator('[data-order-action="plus"]').click();
    await expect(page.locator('#order-subtotal')).toContainText(price(2110));
    await summaryLine(page, 'Masala French Fries').locator('[data-order-action="minus"]').click();
    await expect(page.locator('#order-subtotal')).toContainText(price(1940));
    await page.locator('#order-customer-name').fill('Ten item guest');
    await page.locator('#order-customer-phone').fill('9876543210');
    await page.screenshot({ path: testInfo.outputPath(`air-menu-ten-items-checkout-${viewport.width}.png`) });
    await page.locator('#place-direct-order').click();
    await expect(page.locator('#confirmation-order-number')).toHaveText('#42');
    expect(requests).toHaveLength(1);
    expect(requests[0].body.items).toHaveLength(10);
    expect(requests[0].body.items.find(item => item.name === 'Paneer Tikka').modifiers).toEqual([expect.objectContaining({ options: [expect.objectContaining({ name: 'Cheese' })] })]);
    expect(errors).toEqual([]);
  });
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 810, height: 1080 }, { width: 390, height: 844 }]) {
  test(`guest menu and order summary fit ${viewport.width}×${viewport.height} with touch-size quantities`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await guestMenu(page);
    const menuLayout = await page.evaluate(() => ({
      viewport: innerWidth, width: document.documentElement.scrollWidth,
      clippedDishes: [...document.querySelectorAll('.dish')].filter(card => !card.hidden).filter(card => {
        const box = card.getBoundingClientRect();
        return box.left < 0 || box.right > innerWidth + 1 || card.scrollWidth > card.clientWidth + 1;
      }).length,
      narrowQuantities: [...document.querySelectorAll('.dish [data-order-action]')].filter(button => button.getClientRects().length).filter(button => {
        const box = button.getBoundingClientRect();
        return box.width < 43.5 || box.height < 43.5;
      }).map(button => button.getAttribute('aria-label') || button.textContent),
    }));
    expect(menuLayout.width).toBe(menuLayout.viewport);
    expect(menuLayout.clippedDishes).toBe(0);
    expect(menuLayout.narrowQuantities).toEqual([]);
    await expect(dish(page, 'Masala French Fries').locator('[data-order-action="plus"]')).toHaveAccessibleName(/Masala French Fries/i);
    await page.screenshot({ path: testInfo.outputPath(`air-menu-${viewport.width}.png`), fullPage: true });
    await dish(page, 'Masala French Fries').locator('[data-order-action="plus"]').click();
    await page.locator('#open-order-summary').click();
    const dialog = await page.locator('#order-summary').evaluate(element => {
      const box = element.getBoundingClientRect();
      return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, width: element.clientWidth, scrollWidth: element.scrollWidth, viewportWidth: innerWidth, viewportHeight: innerHeight };
    });
    expect(dialog.left).toBeGreaterThanOrEqual(0);
    expect(dialog.right).toBeLessThanOrEqual(dialog.viewportWidth);
    expect(dialog.top).toBeGreaterThanOrEqual(0);
    expect(dialog.bottom).toBeLessThanOrEqual(dialog.viewportHeight + 1);
    expect(dialog.scrollWidth).toBeLessThanOrEqual(dialog.width + 1);
    const summaryButtons = await page.locator('#order-summary [data-order-action]').evaluateAll(buttons => buttons.map(button => {
      const box = button.getBoundingClientRect();
      return { width: box.width, height: box.height };
    }));
    for (const button of summaryButtons) {
      expect(button.width).toBeGreaterThanOrEqual(43.5);
      expect(button.height).toBeGreaterThanOrEqual(43.5);
    }
    await page.screenshot({ path: testInfo.outputPath(`air-menu-summary-${viewport.width}.png`) });
    await page.locator('#close-order-summary').click();
    await page.locator('#menu-type-nav [data-menu-type="bar"]').click();
    const barWidth = await dish(page, 'Signature Whisky').evaluate(element => ({ width: element.clientWidth, scroll: element.scrollWidth }));
    expect(barWidth.scroll).toBeLessThanOrEqual(barWidth.width + 1);
    await page.screenshot({ path: testInfo.outputPath(`air-menu-bar-${viewport.width}.png`), fullPage: true });
  });
}
