const { test, expect } = require('@playwright/test');

test.use({ serviceWorkers: 'block', timezoneId: 'Asia/Kolkata' });

function dish(index, changes = {}) {
  const now = Date.now();
  return { taskKey: `dish-${index}`, orderId: `order-${index}`, orderNumber: index + 1,
    itemName: index === 0 ? 'Chicken Fried Rice' : 'Veg Manchow Soup', category: 'Kitchen',
    mode: 'table', tableArea: 'AC', tableNumber: index + 1, stationId: 'wok', quantity: 1,
    note: index === 0 ? 'No egg' : '', portion: 'Full', taskState: 'ordered',
    action: index === 0 ? 'start-now' : 'wait-capacity', baseAction: 'start-now',
    capacityState: index === 0 ? 'allocated' : 'capacity-wait', finalRank: index + 1,
    orderedAt: new Date(now - 5 * 60_000).toISOString(), targetServeAt: new Date(now + 10 * 60_000).toISOString(),
    expediter: { signal: index === 0 ? 'green' : index === 1 ? 'red' : 'yellow',
      phase: index === 0 ? 'start' : index === 1 ? 'blocked' : 'next',
      label: index === 0 ? 'Start now' : index === 1 ? 'Needs expo' : 'Wait for station',
      instruction: index === 0 ? 'Start Chicken Fried Rice for AC table 1 now.' : 'Wait for a station slot; do not start yet.',
      reason: index === 0 ? 'Capacity available' : 'Station is full; expo must clear capacity',
      startAt: new Date(now + (index === 0 ? -1 : 4) * 60_000).toISOString(),
      readyAt: new Date(now + 10 * 60_000).toISOString() }, ...changes };
}

async function openBoard(page, tasks = Array.from({ length: 50 }, (_, index) => dish(index)), batches = []) {
  const state = { status: 200, hold: false, release: null, actions: [], failAfterAction: false,
    snapshot: { schedulingMode: 'manual', recommendations: tasks, taskStates: [], batches,
      stations: [{ id: 'wok', name: 'Wok' }], staleOrders: [], summary: {}, realtimeCursor: 0,
      expediter: { calls: [], alerts: [], load: { label: 'Busy kitchen', queuedPortions: tasks.length } } } };
  await page.addInitScript(() => { window.setInterval = () => 0; window.EventSource = undefined; });
  await page.route('**/api/staff/session', route => route.fulfill({ json: { legacy: true } }));
  await page.route('**/api/orders/smart-kds/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/actions') || path.endsWith('/start')) {
      state.actions.push(route.request().postDataJSON());
      if (state.hold) await new Promise(resolve => { state.release = resolve; });
      if (state.failAfterAction) state.status = 503;
      else if (path.endsWith('/actions')) {
        const task = tasks.find(entry => entry.taskKey === state.actions.at(-1).taskKey);
        task.taskState = 'preparing'; task.expediter = { signal: 'neutral', phase: 'cooking', label: 'Cooking' };
      }
      return route.fulfill({ json: { ok: true } });
    }
    return route.fulfill({ status: path.endsWith('/recommendations') ? state.status : 200,
      json: path.endsWith('/recommendations') ? state.status === 200 ? state.snapshot : { error: 'Connection interrupted' } : { events: [], cursor: 0 } });
  });
  await page.goto('/smart-kds.html');
  await expect(page.locator('#live')).toHaveText('Live');
  return state;
}

test('busy tablet puts a real next dish, table, chef note and direct action above six organized tickets', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await openBoard(page);
  await expect(page.locator('#next-action-title')).toHaveText('Prepare 1× Chicken Fried Rice');
  await expect(page.locator('#next-action-context')).toContainText('AC 01');
  await expect(page.locator('#next-action-context')).toContainText('No egg');
  await expect(page.locator('#next-action-button')).toBeEnabled();
  await expect(page.locator('[data-order-ticket]')).toHaveCount(6);
  await expect(page.locator('#board-total')).toContainText('50 orders');
  await expect(page.locator('[data-board-status="attention"]')).toContainText('1');
  await expect(page.locator('.signal-legend')).toContainText('Green: start');
  const buttons = page.locator('[data-order-ticket] [data-action="ready"]');
  for (let index = 0; index < 6; index += 1) {
    const bounds = await buttons.nth(index).boundingBox();
    expect(bounds.height).toBeGreaterThanOrEqual(44);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(768);
  }
  await page.screenshot({ path: '/tmp/red-lantern-kds-clear-tablet.png' });
  await page.locator('#next-action-button').click();
  await expect.poll(() => page.locator('#board [data-task-card][data-task="dish-0"]').getAttribute('data-state')).toBe('preparing');
  await expect(page.locator('#calls-dialog')).not.toBeVisible();
});

test('attention filter exposes blocked work while station-wide next instruction remains actionable', async ({ page }) => {
  await openBoard(page);
  await page.locator('[data-board-status="attention"]').click();
  await expect(page.locator('#board [data-task-card]')).toHaveCount(1);
  await expect(page.locator('#board [data-action="start"]')).toBeDisabled();
  await expect(page.locator('#kitchen-briefing')).toHaveAttribute('data-task', 'dish-0');
  await expect(page.locator('#next-action-label')).toContainText('all orders');
  await expect(page.locator('#next-action-button')).toBeEnabled();
});

test('an entirely blocked queue gives an explicit check instruction without an impossible Start button', async ({ page }) => {
  await openBoard(page, [dish(1)]);
  await expect(page.locator('#next-action-label')).toContainText('Needs attention');
  await expect(page.locator('#next-action-context')).toContainText('expo must clear capacity');
  await expect(page.locator('#next-action-button')).toHaveCount(0);
});

test('earlier-shift cleanup remains in Settings without inflating current cooking alerts', async ({ page }) => {
  const state = await openBoard(page, []);
  state.snapshot.staleOrders = [{ id: 'old-order', orderNumber: 81, tableArea: 'AC', tableNumber: 4 }];
  state.snapshot.expediter.alerts = [{ id: 'stale:old-order', type: 'stale-order', severity: 'warning', message: 'Earlier shift needs manager review' }];
  await page.evaluate(() => load());
  await expect(page.locator('#alerts-count')).toHaveText('0');
  await expect(page.locator('#manager-toggle')).toContainText('1 older');
  await expect(page.locator('#next-action-title')).toHaveText('No orders waiting');
  await page.locator('#manager-toggle').click();
  await expect(page.locator('#stale-orders')).toBeVisible();
  await expect(page.locator('#stale-orders')).toContainText('81');
});

test('stale refresh blocks every copied action and successful reconnection restores the current queue', async ({ page }) => {
  const state = await openBoard(page);
  state.status = 503;
  await page.evaluate(() => load());
  await expect(page.locator('#kitchen-mode-notice')).toContainText('Reconnecting');
  await expect(page.locator('#board [data-action="start"]').first()).toBeDisabled();
  await expect(page.locator('#board [data-action="ready"]').first()).toBeDisabled();
  await expect(page.locator('#next-action-button')).toBeDisabled();
  state.status = 200;
  await page.evaluate(() => load());
  await expect(page.locator('#next-action-button')).toBeEnabled();
});

test('card and next-action copies share one pending operation even across a rerender', async ({ page }) => {
  const state = await openBoard(page);
  state.hold = true;
  await page.locator('#next-action-button').click();
  await expect.poll(() => state.actions.length).toBe(1);
  await page.evaluate(() => { render(); document.querySelector('#board [data-task="dish-0"] [data-action="start"]').click(); });
  await expect(page.locator('#next-action-button')).toBeDisabled();
  await expect(page.locator('#board [data-task="dish-0"] [data-action="start"]')).toBeDisabled();
  expect(state.actions).toHaveLength(1);
  state.release();
});

test('an acknowledged action followed by failed refresh does not unlock the previous instruction', async ({ page }) => {
  const state = await openBoard(page);
  state.failAfterAction = true;
  await page.locator('#next-action-button').click();
  await expect(page.locator('#live')).toContainText('Connection problem');
  await expect(page.locator('#next-action-button')).toBeDisabled();
  await expect(page.locator('#board [data-action="ready"]').first()).toBeDisabled();
  expect(state.actions).toHaveLength(1);
});

test('approved group starts with one tap and no routine reason prompt', async ({ page }) => {
  const tasks = [dish(0), dish(2, { capacityState: 'allocated', expediter: { ...dish(0).expediter } })];
  tasks[1].itemName = tasks[0].itemName;
  const batch = { batchId: 'rice-group', batchGroupId: 'Rice', stationId: 'wok', action: 'fire-batch', totalQuantity: 2,
    allocations: tasks.map(task => ({ taskKey: task.taskKey, orderId: task.orderId, quantity: 1 })) };
  const state = await openBoard(page, tasks, [batch]);
  let prompted = false; page.on('dialog', async dialog => { prompted = true; await dialog.dismiss(); });
  await expect(page.locator('#next-action-button')).toHaveText('Start batch');
  await page.locator('#next-action-button').click();
  await expect.poll(() => state.actions.length).toBe(1);
  expect(state.actions[0].reason).toContain('Kitchen confirmed');
  expect(prompted).toBe(false);
});
