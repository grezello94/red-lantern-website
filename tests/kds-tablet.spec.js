const { test, expect } = require('@playwright/test');

test.use({ serviceWorkers: 'block', timezoneId: 'Asia/Kolkata' });

function rushSnapshot(orderCount = 72, itemsPerOrder = 2) {
  const now = Date.now();
  const recommendations = [];
  const states = ['ordered', 'preparing', 'ordered', 'ordered', 'ready', 'expo'];
  for (let index = 0; index < orderCount; index += 1) {
    const variant = index % states.length;
    for (let item = 0; item < itemsPerOrder; item += 1) {
      const taskKey = `order-${index + 1}:line-${item + 1}`;
      const taskState = states[variant];
      const cooking = taskState === 'preparing';
      const completed = ['ready', 'expo'].includes(taskState);
      const start = variant === 0;
      const itemName = index === 7 ? 'Fish Rawa Fry' : item ? 'Chicken Manchurian' : 'Veg Fried Rice';
      recommendations.push({
        taskKey, orderId: `order-${index + 1}`, orderNumber: index + 1,
        mode: 'table', tableArea: index % 2 ? 'Garden' : 'AC', tableNumber: index + 1,
        stationId: 'wok', itemName, category: item ? 'Starters' : 'Rice', quantity: item + 1,
        portion: 'Full', style: index === 7 ? 'Extra spicy' : '', note: index === 7 ? 'No egg' : '',
        taskState, action: completed ? 'ready-for-expo' : cooking ? 'in-progress' : start ? 'start-now' : variant === 3 ? 'hold-for-course' : 'wait-capacity',
        baseAction: start ? 'start-now' : 'prepare-next',
        capacityState: start ? 'allocated' : cooking ? 'in-progress' : completed ? 'ready-for-expo' : variant === 3 ? 'hold-for-course' : 'capacity-wait',
        finalRank: index * itemsPerOrder + item + 1,
        orderedAt: new Date(now - (8 + index % 12) * 60_000).toISOString(),
        targetServeAt: new Date(now + 15 * 60_000).toISOString(),
        latestSafeStartAt: new Date(now + (start ? -1 : 5) * 60_000).toISOString(),
        expediter: {
          signal: start ? 'green' : cooking || completed ? 'neutral' : 'yellow',
          label: start ? 'Start now' : cooking ? 'Cooking' : completed ? 'Ready for expo' : 'Prepare next',
          phase: start ? 'start' : cooking ? 'cooking' : completed ? 'ready' : variant === 3 ? 'hold' : 'next',
          instruction: `${start ? 'Start' : cooking ? 'Continue' : completed ? 'Collect' : 'Keep ready'} ${item + 1} ${itemName} for table ${index + 1}.`,
          reason: start ? 'Station capacity available' : 'Follow the recorded kitchen state and station queue.',
          startAt: variant === 3 ? null : new Date(now + (start ? 0 : 5) * 60_000).toISOString(),
          readyAt: variant === 3 ? null : new Date(now + 15 * 60_000).toISOString(),
          prepAlert: index === 7 ? 'Check chilled/thawed fish portions now.' : null,
        },
      });
    }
  }
  return {
    generatedAt: new Date(now).toISOString(), recommendations,
    taskStates: recommendations.map(task => ({ task_id: task.taskKey, task_state: task.taskState })),
    schedulingMode: 'manual', realtimeCursor: 0, summary: {}, staleOrders: [], batches: [],
    stations: [{ id: 'wok', name: 'Wok', enabled: true }],
    expediter: {
      generatedAt: new Date(now).toISOString(),
      load: { level: 'surge', label: 'Kitchen under pressure', activeOrders: orderCount, activePortions: 24, queuedPortions: 144, atRiskTasks: 12, estimatedClearMinutes: 42 },
      stations: [{ stationId: 'wok', stationName: 'Wok', totalCapacity: 4, occupiedCapacity: 4, queuedPortions: 144, estimatedClearMinutes: 42, level: 'surge', enabled: true }],
      alerts: recommendations.filter(task => task.expediter.prepAlert).map(task => ({ id: `prep:${task.taskKey}`, type: 'prep', severity: 'warning', urgent: true, taskKey: task.taskKey, stationId: 'wok', message: `${task.itemName}: check chilled/thawed fish portions now.` })),
      calls: recommendations.filter(task => task.expediter.signal === 'green').map(task => ({ id: `start:${task.taskKey}`, type: 'start', priority: 10, signal: 'green', instruction: task.expediter.instruction, taskKeys: [task.taskKey], stationId: 'wok', startAt: task.expediter.startAt, readyAt: task.expediter.readyAt })),
    },
  };
}

async function openBoard(page, snapshot = rushSnapshot()) {
  const state = { snapshot, actions: [] };
  await page.addInitScript(() => { window.setInterval = () => 0; window.EventSource = undefined; });
  await page.route('**/api/staff/session', route => route.fulfill({ json: { legacy: true } }));
  await page.route('**/api/orders/smart-kds/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/actions')) {
      const action = route.request().postDataJSON();
      state.actions.push(action);
      const entry = state.snapshot.recommendations.find(task => task.taskKey === action.taskKey);
      if (entry && action.action === 'ready') {
        entry.taskState = 'ready'; entry.action = 'ready-for-expo'; entry.capacityState = 'ready-for-expo';
        entry.expediter = { signal: 'neutral', phase: 'ready', label: 'Ready for expo', instruction: 'Collect this finished dish for expo.' };
        state.snapshot.taskStates.find(task => task.task_id === action.taskKey).task_state = 'ready';
        state.snapshot.expediter.calls = state.snapshot.expediter.calls.filter(call => !call.taskKeys.includes(action.taskKey));
        state.snapshot.expediter.alerts = state.snapshot.expediter.alerts.filter(alert => alert.taskKey !== action.taskKey);
      }
      return route.fulfill({ json: { ok: true, status: entry?.taskState } });
    }
    return route.fulfill({ json: path.endsWith('/recommendations') ? state.snapshot : { cursor: 0, events: [] } });
  });
  await page.goto('/smart-kds.html');
  await expect(page.locator('[data-order-ticket]').first()).toBeVisible();
  return state;
}

test('100 orders stay complete across tablet pages without rendering the whole rush at once', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await openBoard(page, rushSnapshot(100, 4));
  await expect(page.locator('[data-order-ticket]')).toHaveCount(6);
  await expect(page.locator('#board-total')).toContainText('100');
  const seen = new Set();
  for (let pageIndex = 0; pageIndex < 17; pageIndex += 1) {
    const ids = await page.locator('[data-order-ticket]').evaluateAll(cards => cards.map(card => card.dataset.order));
    ids.forEach(id => { expect(seen.has(id)).toBe(false); seen.add(id); });
    if (pageIndex < 16) await page.locator('#board-next').click();
  }
  expect(seen.size).toBe(100);
  await expect(page.locator('#board-next')).toBeDisabled();
  await page.locator('#board-prev').click();
  await expect(page.locator('[data-order-ticket]')).toHaveCount(6);
});

test('landscape tablet exposes six ticket cards with touch-sized completion actions above the fold', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await openBoard(page);
  const cards = page.locator('[data-order-ticket]');
  await expect(cards).toHaveCount(6);
  for (let index = 0; index < 6; index += 1) {
    const card = cards.nth(index);
    const button = card.locator('[data-action="ready"]').first();
    await expect(button).toBeVisible();
    const bounds = await button.boundingBox();
    expect(bounds.width).toBeGreaterThanOrEqual(44);
    expect(bounds.height).toBeGreaterThanOrEqual(44);
    expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(768);
    const unblocked = await button.evaluate(element => {
      const bounds = element.getBoundingClientRect();
      return element.contains(document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2));
    });
    expect(unblocked).toBe(true);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(1024);
  await page.screenshot({ path: '/tmp/red-lantern-kds-tablet-1024.png' });
});

test('quiet service uses the full board height so all five completion buttons fit without inner scrolling', async ({ page }) => {
  const snapshot = rushSnapshot(2, 3);
  snapshot.recommendations = snapshot.recommendations.filter(task => task.taskKey !== 'order-1:line-3');
  snapshot.taskStates = snapshot.taskStates.filter(task => task.task_id !== 'order-1:line-3');
  await page.setViewportSize({ width: 1024, height: 768 });
  await openBoard(page, snapshot);
  for (const viewport of [{ width: 1024, height: 768 }, { width: 810, height: 1080 }]) {
    await page.setViewportSize(viewport);
    await expect(page.locator('#board')).toHaveAttribute('data-ticket-count', '2');
    await expect(page.locator('#board [data-action="ready"]')).toHaveCount(5);
    const layout = await page.locator('#board').evaluate(board => ({
      rows: getComputedStyle(board).gridTemplateRows.split(' ').length,
      cards: [...board.querySelectorAll('[data-order-ticket]')].map(card => ({
        height: card.getBoundingClientRect().height,
        boardHeight: board.getBoundingClientRect().height,
        scrollHeight: card.querySelector('.ticket-items').scrollHeight,
        visibleHeight: card.querySelector('.ticket-items').clientHeight,
      })),
      buttons: [...board.querySelectorAll('[data-action="ready"]')].map(button => {
        const bounds = button.getBoundingClientRect();
        return { bottom: bounds.bottom, unblocked: button.contains(document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)) };
      }),
    }));
    expect(layout.rows).toBe(1);
    for (const card of layout.cards) {
      expect(card.height).toBeGreaterThanOrEqual(card.boardHeight - 1);
      expect(card.scrollHeight).toBeLessThanOrEqual(card.visibleHeight + 1);
    }
    for (const button of layout.buttons) {
      expect(button.unblocked).toBe(true);
      expect(button.bottom).toBeLessThanOrEqual(viewport.height);
    }
  }
});

test('four portrait tickets use two occupied rows while the six-card page stays unchanged', async ({ page }) => {
  await page.setViewportSize({ width: 810, height: 1080 });
  const state = await openBoard(page, rushSnapshot(4));
  await expect(page.locator('[data-order-ticket]')).toHaveCount(4);
  expect(await page.locator('#board').evaluate(board => getComputedStyle(board).gridTemplateRows.split(' ').length)).toBe(2);
  state.snapshot = rushSnapshot(6);
  await page.evaluate(() => load());
  await expect(page.locator('[data-order-ticket]')).toHaveCount(6);
  expect(await page.locator('#board').evaluate(board => getComputedStyle(board).gridTemplateRows.split(' ').length)).toBe(3);
});

test('search and status tabs locate one order without losing chef notes or the queue totals', async ({ page }) => {
  await page.setViewportSize({ width: 810, height: 1080 });
  await openBoard(page);
  await page.locator('#board-search').fill('No egg');
  await expect(page.locator('[data-order-ticket]')).toHaveCount(1);
  const card = page.locator('[data-order-ticket]');
  await expect(card).toContainText('Fish Rawa Fry');
  await expect(card).toContainText('Extra spicy');
  await expect(card).toContainText('No egg');
  await page.locator('#board-search').clear();
  await page.locator('[data-board-status="cooking"]').click();
  await expect(page.locator('[data-task-card]').first()).toHaveAttribute('data-state', 'preparing');
  expect(await page.locator('[data-task-card]').evaluateAll(rows => rows.every(row => row.dataset.state === 'preparing'))).toBe(true);
  await page.locator('[data-board-status="ready"]').click();
  expect(await page.locator('[data-task-card]').evaluateAll(rows => rows.every(row => ['ready', 'expo'].includes(row.dataset.state)))).toBe(true);
  await page.locator('[data-board-status="all"]').click();
  await expect(page.locator('#board-total')).toContainText('72');
  await expect(page.locator('#board-prev')).toBeDisabled();
});

test('queued food can be marked ready on the tablet without acknowledging a fabricated start', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  const state = await openBoard(page);
  await page.locator('#board-search').fill('order-3');
  // Searching by display order number is also supported by the board model.
  if (await page.locator('[data-order-ticket][data-order="order-3"]').count() === 0) await page.locator('#board-search').fill('3');
  const card = page.locator('[data-order-ticket][data-order="order-3"]');
  await expect(card).toBeVisible();
  const task = card.locator('[data-task-card]').first();
  const key = await task.getAttribute('data-task');
  await task.locator('[data-action="ready"]').click();
  await expect.poll(() => state.actions.length).toBe(1);
  expect(state.actions[0]).toMatchObject({ action: 'ready', taskKey: key, orderId: 'order-3' });
  expect(state.actions.some(action => action.action === 'start')).toBe(false);
  await page.locator('#board-search').clear();
  await page.locator('[data-board-status="ready"]').click();
  await page.locator('#board-search').fill('order-3');
  if (await page.locator('[data-order-ticket][data-order="order-3"]').count() === 0) await page.locator('#board-search').fill('3');
  await expect(page.locator(`[data-task-card][data-task="${key}"]`)).toHaveAttribute('data-state', 'ready');
});

test('portrait and phone layouts keep the board within the viewport width', async ({ page }) => {
  await page.setViewportSize({ width: 810, height: 1080 });
  await openBoard(page, rushSnapshot(60, 6));
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(810);
  await expect(page.locator('#board-pagination')).toBeVisible();
  await page.screenshot({ path: '/tmp/red-lantern-kds-tablet-810.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await expect(page.locator('#board-search')).toBeVisible();
  await expect(page.locator('[data-action="ready"]').first()).toBeVisible();
});

test('rush snapshot refresh preserves the selected page until a search or status change', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await openBoard(page, rushSnapshot(100));
  await page.locator('#board-next').click();
  const before = await page.locator('[data-order-ticket]').evaluateAll(cards => cards.map(card => card.dataset.order));
  await page.evaluate(() => load());
  expect(await page.locator('[data-order-ticket]').evaluateAll(cards => cards.map(card => card.dataset.order))).toEqual(before);
  await page.locator('[data-board-status="waiting"]').click();
  await expect(page.locator('#board-prev')).toBeDisabled();
});
