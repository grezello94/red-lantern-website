const { test, expect } = require('@playwright/test');

test.use({ serviceWorkers: 'block' });

const menu = [
  { key: 'food:chicken-biryani', menuType: 'food', name: 'Chicken Biryani', category: 'Biryani', price: 280 },
  { key: 'food:mushroom-biryani', menuType: 'food', name: 'Mushroom Biryani', category: 'Biryani', price: 220 },
  { key: 'food:vegetable-soup', menuType: 'food', name: 'Vegetable Soup', category: 'Soup', price: 140 },
  { key: 'food:chicken-soup', menuType: 'food', name: 'Chicken Clear Soup', category: 'Soup', price: 170 },
  { key: 'food:veg-crispy', menuType: 'food', name: 'Veg Crispy', category: 'Starters', price: 200 },
  { key: 'food:pepper-wings', menuType: 'food', name: 'Chicken Pepper Wings Special', category: 'Starters', price: 250 },
  { key: 'bar:virgin-mojito', menuType: 'bar', name: 'Virgin Mojito', category: 'Mocktails', price: 200 },
  { key: 'bar:old-fashioned', menuType: 'bar', name: 'Old Fashioned', category: 'Cocktails', price: 450 },
];

function localDateTime(timestamp) {
  const date = new Date(timestamp);
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 16);
}

async function availabilityApp(page, {
  failNextMutation = false,
  failRefreshAfterMutation = false,
  holdFirstMutation = false,
  mushroomRestockUntil = null,
} = {}) {
  const mutations = [];
  const queuedActions = [];
  const failedRefreshes = [];
  const availabilityReads = [];
  const dialogs = [];
  const stock = new Map([
    ['food:mushroom-biryani', mushroomRestockUntil || new Date(Date.now() + 3600000).toISOString()],
    ['bar:old-fashioned', new Date(Date.now() + 7200000).toISOString()],
  ]);
  let failMutation = failNextMutation;
  let releaseMutation;
  const firstMutationReleased = new Promise((resolve) => { releaseMutation = resolve; });
  page.on('dialog', async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.dismiss();
  });
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === 'GET' && ['/api/orders/menu', '/api/orders/availability'].includes(path))
      availabilityReads.push(path);
    if (path.startsWith('/api/orders/availability/')) {
      const key = decodeURIComponent(path.slice('/api/orders/availability/'.length));
      const payload = request.method() === 'PUT' ? request.postDataJSON() : null;
      mutations.push({ key, method: request.method(), payload });
      if (holdFirstMutation && mutations.length === 1) await firstMutationReleased;
      if (failMutation) {
        failMutation = false;
        return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Could not save availability. Please try again.' }) });
      }
      if (payload) stock.set(key, payload.unavailableUntil);
      else stock.delete(key);
      return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    }
    if (failRefreshAfterMutation && mutations.length && request.method() === 'GET' &&
        ['/api/orders/menu', '/api/orders/availability'].includes(path)) {
      failedRefreshes.push(path);
      return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Menu refresh is temporarily unavailable.' }) });
    }
    let payload = { ok: true };
    if (path === '/api/orders/menu') payload = menu;
    if (path === '/api/orders/availability') payload = Array.from(stock, ([item_key, unavailable_until]) => ({ item_key, unavailable_until }));
    if (path === '/api/orders' || path.endsWith('/kitchen-statuses') || path.endsWith('/kot-history')) payload = [];
    if (path === '/api/orders/operations') payload = { config: { printers: [], routes: [], tableAreas: [] }, menu };
    if (path.endsWith('/live-summary')) payload = { activeOrderCount: 0, sessionOpen: true, acceptingOrders: true };
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(payload) });
  });
  await page.route('http://127.0.0.1:9124/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    let payload = { ok: true, workstation: { id: 'availability-test-counter' }, ledger: 'ready' };
    if (path === '/v1/config') payload.config = { printers: [], routes: [], tableAreas: [] };
    if (path === '/v1/setup-status') payload = { ...payload, printers: [], configuredBillPrinterCount: 0, configuredKotRouteCount: 0 };
    if (path === '/v1/ledger/actions') {
      payload.actions = [];
      if (route.request().method() === 'POST') {
        queuedActions.push(route.request().postDataJSON());
        payload.action = { status: 'queued' };
      }
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(payload) });
  });
  await page.goto('/orders.html');
  await page.locator('#availability-toggle').click();
  await expect(page.locator('#availability')).toBeVisible();
  await expect(page.locator('#menu-results .menu-item')).toHaveCount(6);
  return { mutations, queuedActions, failedRefreshes, availabilityReads, releaseMutation, dialogs, stock };
}

const cards = (page) => page.locator('#menu-results .menu-item');
const card = (page, key) => page.locator(`#menu-results .menu-item[data-key="${key}"]`);
const filter = (page, value) => page.locator(`#availability-filters [data-availability-filter="${value}"]`);

test('menu search, category and stock filters combine; reset keeps the selected menu', async ({ page }) => {
  await availabilityApp(page);
  await expect(page.locator('#availability-counts')).toContainText('5');
  await page.locator('#availability-category').selectOption('Biryani');
  await expect(cards(page)).toHaveCount(2);
  await page.locator('#menu-search').fill('chicken');
  await expect(cards(page)).toHaveCount(1);
  await expect(card(page, 'food:chicken-biryani')).toBeVisible();
  await filter(page, 'out').click();
  await expect(cards(page)).toHaveCount(0);
  await page.locator('#availability-reset').click();
  await expect(cards(page)).toHaveCount(6);
  await expect(page.locator('#menu-search')).toHaveValue('');
  await expect(page.locator('#availability-category')).toHaveValue('all');
  await expect(filter(page, 'all')).toHaveAttribute('aria-pressed', 'true');

  await page.locator('#menu-type-tabs [data-menu-type="bar"]').click();
  await expect(cards(page)).toHaveCount(2);
  await page.locator('#availability-category').selectOption('Cocktails');
  await page.locator('#menu-search').fill('fashioned');
  await filter(page, 'out').click();
  await expect(card(page, 'bar:old-fashioned')).toBeVisible();
  await page.locator('#availability-reset').click();
  await expect(cards(page)).toHaveCount(2);
  await expect(page.locator('#menu-type-tabs [data-menu-type="bar"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#availability-category')).toHaveValue('all');
  await expect(page.locator('#menu-search')).toHaveValue('');
  await expect(filter(page, 'all')).toHaveAttribute('aria-pressed', 'true');
});

test('availability switch pauses the right item until tomorrow and restores it without losing filters', async ({ page }) => {
  const { mutations, dialogs } = await availabilityApp(page);
  await page.locator('#availability-category').selectOption('Biryani');
  await page.locator('#menu-search').fill('chicken');
  const item = card(page, 'food:chicken-biryani');
  await expect(item.locator('.availability-switch')).toHaveAttribute('role', 'switch');
  await expect(item.locator('.availability-switch')).toHaveAttribute('aria-checked', 'true');
  const before = Date.now();
  await item.locator('.availability-switch').click();
  await expect(item.locator('.availability-switch')).toHaveAttribute('aria-checked', 'false');
  expect(mutations).toHaveLength(1);
  expect(mutations[0]).toMatchObject({ key: 'food:chicken-biryani', method: 'PUT' });
  // The default quick action pauses for a day; no date input or extra confirmation is required.
  const restock = Date.parse(mutations[0].payload.unavailableUntil);
  expect(restock).toBeGreaterThan(before + 23 * 3600000);
  expect(restock).toBeLessThan(before + 25 * 3600000);
  await expect(page.locator('#availability-category')).toHaveValue('Biryani');
  await expect(page.locator('#menu-search')).toHaveValue('chicken');
  await expect(cards(page)).toHaveCount(1);
  await item.locator('.availability-switch').focus();
  await page.keyboard.press('Space');
  await expect(item.locator('.availability-switch')).toHaveAttribute('aria-checked', 'true');
  expect(mutations[1]).toEqual({ key: 'food:chicken-biryani', method: 'DELETE', payload: null });
  expect(dialogs).toEqual([]);
});

test('return-time scheduling validates future dates and edits an already unavailable item', async ({ page }) => {
  const { mutations, dialogs } = await availabilityApp(page);
  const item = card(page, 'food:mushroom-biryani');
  await expect(item.locator('.availability-switch')).toHaveAttribute('aria-checked', 'false');
  await item.locator('.availability-schedule').click();
  const dialog = page.locator('#availability-schedule-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Mushroom Biryani');
  const input = page.locator('#availability-schedule-until');
  await input.fill(localDateTime(Date.now() - 3600000));
  await page.locator('#availability-schedule-save').click();
  await expect(page.locator('#availability-schedule-error')).toContainText(/future|later|after|ahead/i);
  expect(mutations).toHaveLength(0);
  await expect(dialog).toBeVisible();
  await page.locator('[data-restock-preset="1h"]').click();
  const restock = Date.parse(await input.inputValue());
  expect(restock).toBeGreaterThan(Date.now() + 55 * 60000);
  expect(restock).toBeLessThan(Date.now() + 65 * 60000);
  await page.locator('#availability-schedule-save').click();
  await expect(dialog).toBeHidden();
  expect(mutations).toHaveLength(1);
  expect(mutations[0]).toMatchObject({ key: 'food:mushroom-biryani', method: 'PUT' });
  expect(Date.parse(mutations[0].payload.unavailableUntil)).toBe(restock);
  await expect(item.locator('.availability-switch')).toHaveAttribute('aria-checked', 'false');
  expect(dialogs).toEqual([]);
});

test('a failed schedule save keeps the selected item and date available for retry', async ({ page }) => {
  const { mutations, dialogs } = await availabilityApp(page, { failNextMutation: true });
  await page.locator('#menu-type-tabs [data-menu-type="bar"]').click();
  const item = card(page, 'bar:virgin-mojito');
  await item.locator('.availability-schedule').click();
  await page.locator('[data-restock-preset="tomorrow"]').click();
  const date = await page.locator('#availability-schedule-until').inputValue();
  await page.locator('#availability-schedule-save').click();
  await expect(page.locator('#availability-schedule-dialog')).toBeVisible();
  await expect(page.locator('#availability-schedule-error')).toContainText('Please try again');
  await expect(page.locator('#availability-schedule-until')).toHaveValue(date);
  await expect(page.locator('#availability-schedule-save')).toBeEnabled();
  await expect(item.locator('.availability-switch')).toHaveAttribute('aria-checked', 'true');
  await page.locator('#availability-schedule-save').click();
  await expect(page.locator('#availability-schedule-dialog')).toBeHidden();
  await expect(item.locator('.availability-switch')).toHaveAttribute('aria-checked', 'false');
  expect(mutations).toHaveLength(2);
  expect(mutations[0]).toEqual(mutations[1]);
  expect(mutations[1]).toMatchObject({ key: 'bar:virgin-mojito', method: 'PUT' });
  expect(dialogs).toEqual([]);
});

test('an offline stock change uses the local ledger and updates the displayed item', async ({ page }) => {
  const { mutations, queuedActions, dialogs } = await availabilityApp(page);
  await page.evaluate(() => Object.defineProperty(navigator, 'onLine', { configurable: true, value: false }));
  const item = card(page, 'food:veg-crispy');
  await item.locator('.availability-switch').click();
  await expect(item.locator('.availability-switch')).toHaveAttribute('aria-checked', 'false');
  expect(mutations).toEqual([]);
  expect(queuedActions).toHaveLength(1);
  expect(queuedActions[0]).toMatchObject({
    type: 'availability-update',
    payload: { key: 'food:veg-crispy' },
  });
  expect(Date.parse(queuedActions[0].payload.unavailableUntil)).toBeGreaterThan(Date.now());
  expect(dialogs).toEqual([]);
});

test('a successful stock change survives a failed menu refresh and remains saved after reload', async ({ page }) => {
  const { mutations, failedRefreshes, dialogs } = await availabilityApp(page, { failRefreshAfterMutation: true });
  const item = card(page, 'food:veg-crispy');
  await item.locator('.availability-switch').click();
  await expect(item).toHaveAttribute('aria-busy', 'false');
  await expect(item.locator('.availability-switch')).toHaveAttribute('aria-checked', 'false');
  expect(mutations).toHaveLength(1);
  expect(failedRefreshes).toContain('/api/orders/menu');
  expect(failedRefreshes).toContain('/api/orders/availability');
  const cachedAvailability = await page.evaluate(() => JSON.parse(
    localStorage.getItem('red-lantern-counter-menu-snapshot')
  ).availability);
  expect(cachedAvailability).toContainEqual({
    item_key: 'food:veg-crispy',
    unavailable_until: mutations[0].payload.unavailableUntil,
  });
  await page.reload();
  await page.locator('#availability-toggle').click();
  await expect(card(page, 'food:veg-crispy').locator('.availability-switch')).toHaveAttribute('aria-checked', 'false');
  expect(mutations).toHaveLength(1);
  expect(dialogs).toEqual([]);
});

test('a slow stock change disables the busy item and prevents duplicate submissions', async ({ page }) => {
  const { mutations, releaseMutation, dialogs } = await availabilityApp(page, { holdFirstMutation: true });
  const item = card(page, 'food:chicken-biryani');
  const toggle = item.locator('.availability-switch');
  await toggle.click();
  await expect.poll(() => mutations.length).toBe(1);
  await expect(item).toHaveAttribute('aria-busy', 'true');
  await expect(toggle).toBeDisabled();
  await expect(item.locator('.availability-schedule')).toBeDisabled();
  // Repeated taps during the outstanding request cannot start a second mutation.
  const bounds = await toggle.boundingBox();
  await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  expect(mutations).toHaveLength(1);
  releaseMutation();
  await expect(item).toHaveAttribute('aria-busy', 'false');
  await expect(toggle).toBeEnabled();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect(item.locator('.availability-schedule')).toBeEnabled();
  expect(mutations).toHaveLength(1);
  expect(dialogs).toEqual([]);
});

test('a scheduled return updates visible stock status and counts without refreshing or clearing filters', async ({ page }) => {
  const now = Date.now();
  await page.clock.install({ time: new Date(now) });
  const { mutations, availabilityReads, dialogs } = await availabilityApp(page, {
    mushroomRestockUntil: new Date(now + 60000).toISOString(),
  });
  await page.locator('#availability-category').selectOption('Biryani');
  await page.locator('#menu-search').fill('mushroom');
  const item = card(page, 'food:mushroom-biryani');
  await expect(item.locator('.availability-switch')).toHaveAttribute('aria-checked', 'false');
  await expect(item.locator('.availability-state')).toHaveText('Paused');
  await expect(page.locator('#availability-counts .stock-count.in b')).toHaveText('5');
  await expect(page.locator('#availability-counts .stock-count.out b')).toHaveText('1');
  const readsBeforeReturn = [...availabilityReads];

  await page.clock.fastForward(90000);

  await expect(item.locator('.availability-switch')).toHaveAttribute('aria-checked', 'true');
  await expect(item.locator('.availability-state')).toHaveText('In stock');
  await expect(item.locator('.availability-return strong')).toHaveText('Ready to order');
  await expect(page.locator('#availability-counts .stock-count.in b')).toHaveText('6');
  await expect(page.locator('#availability-counts .stock-count.out b')).toHaveText('0');
  await expect(page.locator('#availability-category')).toHaveValue('Biryani');
  await expect(page.locator('#menu-search')).toHaveValue('mushroom');
  await expect(cards(page)).toHaveCount(1);
  expect(availabilityReads).toEqual(readsBeforeReturn);
  expect(mutations).toEqual([]);
  expect(dialogs).toEqual([]);
});

for (const size of [
  { width: 1440, height: 900, columns: 4 },
  { width: 1180, height: 820, columns: 3 },
  { width: 810, height: 1080, columns: 2 },
  { width: 390, height: 844, columns: 1 },
]) {
  test(`availability controls and return-time dialog fit ${size.width}×${size.height}`, async ({ page }) => {
    await page.setViewportSize({ width: size.width, height: size.height });
    await availabilityApp(page);
    await expect(page.locator('#menu-search')).toBeVisible();
    await expect(page.locator('#availability-category')).toBeVisible();
    expect(await page.locator('#menu-results').evaluate((grid) =>
      getComputedStyle(grid).gridTemplateColumns.trim().split(/\s+/).length
    )).toBe(size.columns);
    const item = card(page, 'food:chicken-biryani');
    const switchBounds = await item.locator('.availability-switch').boundingBox();
    expect(switchBounds.height).toBeGreaterThanOrEqual(44);
    await item.locator('.availability-schedule').click();
    await expect(page.locator('#availability-schedule-dialog')).toBeVisible();
    await page.locator('#availability-schedule-save').scrollIntoViewIfNeeded();
    await expect(page.locator('#availability-schedule-save')).toBeInViewport();
    const layout = await page.locator('#availability-schedule-dialog').evaluate((dialog) => ({
      left: dialog.getBoundingClientRect().left,
      right: dialog.getBoundingClientRect().right,
      internalWidth: dialog.scrollWidth,
      clientWidth: dialog.clientWidth,
      pageWidth: document.documentElement.scrollWidth,
      viewport: innerWidth,
    }));
    expect(layout.left).toBeGreaterThanOrEqual(0);
    expect(layout.right).toBeLessThanOrEqual(layout.viewport);
    expect(layout.internalWidth).toBeLessThanOrEqual(layout.clientWidth);
    expect(layout.pageWidth).toBeLessThanOrEqual(layout.viewport);
    await page.screenshot({ path: test.info().outputPath(`availability-schedule-${size.width}.png`) });
    await page.keyboard.press('Escape');
    await expect(page.locator('#availability-schedule-dialog')).toBeHidden();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`availability-panel-${size.width}.png`) });
  });
}
