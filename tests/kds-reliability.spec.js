const { test, expect } = require('@playwright/test');

test.use({ serviceWorkers: 'block', timezoneId: 'UTC' });

const created = new Date(Date.now() - 60000).toISOString();
const order = { id: 'table-ac', mode: 'table', status: 'accepted', table_area: 'AC', table_number: 1, daily_order_number: 1, created_at: created, items: [{ name: 'Soup', category: 'Soup', quantity: 3 }, { name: 'Rice', category: 'Main', quantity: 1 }] };
const printer = { id: 'kitchen', name: 'Kitchen', type: 'kot', capabilities: ['kot'] };
const history = [
  { ...order, kot_number: 2, tickets: [{ printerId: 'kitchen', printerLabel: 'Kitchen', items: [{ name: 'Soup', category: 'Soup', quantity: 1 }, { name: 'Rice', category: 'Main', quantity: 1 }] }] },
  { ...order, kot_number: 1, tickets: [{ printerId: 'kitchen', printerLabel: 'Kitchen', items: [{ name: 'Soup', category: 'Soup', quantity: 2 }] }] },
];

async function prepare(page, session = { legacy: true }) {
  await page.addInitScript(() => { window.setInterval = () => 0; window.EventSource = undefined; });
  await page.route('**/api/staff/session', route => route.fulfill({ json: session }));
}

async function normalKds(page, options = {}) {
  await prepare(page);
  await page.route('**/api/orders**', async route => {
    const path = new URL(route.request().url()).pathname;
    let json = {};
    if (path === '/api/orders') json = [options.order || order];
    else if (path === '/api/orders/operations') json = { config: { printers: [options.printer || printer], routes: options.routes || [{ category: '*', printerId: 'kitchen' }] } };
    else if (path === '/api/orders/kot-history') json = options.history ?? history;
    else if (path === '/api/orders/kitchen-statuses') json = [{ order_id: order.id, printer_id: 'kitchen', kot_number: 1, status: 'preparing' }, { order_id: order.id, printer_id: 'kitchen', kot_number: 2, status: 'accepted' }];
    await route.fulfill({ json });
  });
  await page.goto('/kds.html');
  await expect(page.locator('#kds-status')).toContainText('Live');
}

function task(id, overrides = {}) {
  return { taskKey: `task-${id}`, orderId: id, orderNumber: id === 'a' ? 1 : 2, mode: 'table', tableArea: 'AC', tableNumber: id === 'a' ? 1 : 2, stationId: 'kitchen', itemName: id === 'a' ? 'Soup' : 'Rice', category: id === 'a' ? 'Soup' : 'Main', quantity: 1, action: 'start-now', baseAction: 'start-now', capacityState: 'allocated', taskState: 'ordered', ...overrides };
}

async function smartKds(page, options = {}) {
  await prepare(page, options.session);
  const snapshot = { recommendations: options.tasks || [task('a'), task('b')], taskStates: options.states || [], batches: options.batches || [], stations: [{ id: 'kitchen', name: 'Kitchen' }], summary: {}, staleOrders: [], schedulingMode: options.mode || 'manual', realtimeCursor: 0 };
  await page.route('**/api/orders/smart-kds/**', async route => {
    const path = new URL(route.request().url()).pathname;
    await route.fulfill({ json: path.endsWith('/recommendations') ? snapshot : path.endsWith('/updates') ? { cursor: 0, events: [] } : { ok: true } });
  });
  await page.goto('/smart-kds.html');
  await expect(page.locator('#live')).toHaveText(options.mode === 'shadow' ? 'Shadow recommendations' : 'Manual kitchen actions');
}

test('normal KDS preserves separate KOT rounds and their saved quantities', async ({ page }) => {
  await normalKds(page);
  await expect(page.locator('.kds-ticket')).toHaveCount(2);
  const first = page.locator('.kds-ticket').filter({ has: page.locator('[data-kot="1"]') });
  const second = page.locator('.kds-ticket').filter({ has: page.locator('[data-kot="2"]') });
  await expect(first).toContainText('2×');
  await expect(first).not.toContainText('Rice');
  await expect(second).toContainText('1×');
  await expect(first.locator('[data-action]')).toHaveAttribute('data-action', 'ready');
  await expect(second.locator('[data-action]')).toHaveAttribute('data-action', 'preparing');
});

test('normal KDS supports a shared bill and KOT printer without duplicating overlapping routes', async ({ page }) => {
  await normalKds(page, { printer: { ...printer, type: 'bill', capabilities: ['bill', 'kot'] }, history: [history[1]], routes: [{ category: '*', printerId: 'kitchen' }, { category: 'Soup', printerId: 'kitchen' }] });
  await expect(page.locator('.kds-ticket')).toHaveCount(1);
  await expect(page.locator('.ticket-items > div')).toHaveCount(1);
  await expect(page.locator('.ticket-items')).not.toContainText('Rice');
});

test('normal KDS identifies an unprinted order as waiting for its ticket', async ({ page }) => {
  await normalKds(page, { history: [] });
  await expect(page.locator('.ticket-action')).toContainText('Waiting for KOT');
});

test('normal KDS keeps an action locked when station changes rerender its card', async ({ page }) => {
  await normalKds(page, { history: [history[1]] });
  let release;
  const held = new Promise(resolve => { release = resolve; });
  await page.route('**/api/orders/table-ac/kitchen-status/kitchen', async route => { await held; await route.fulfill({ json: { ok: true } }); });
  const request = page.waitForRequest('**/api/orders/table-ac/kitchen-status/kitchen');
  await page.locator('.ticket-action[data-action]').click();
  await request;
  await page.locator('[data-station="kitchen"]').click();
  try { await expect(page.locator('.ticket-action[data-action]')).toBeDisabled(); }
  finally { release(); }
});

test('Smart KDS places held and capacity-blocked work in waiting instead of make now', async ({ page }) => {
  await smartKds(page, { tasks: [task('a', { taskState: 'held', capacityState: 'manual-hold' }), task('b', { action: 'wait-capacity', capacityState: 'capacity-wait' })] });
  await expect(page.locator('#section-hold [data-task-card]')).toHaveCount(2);
  await expect(page.locator('#section-hold')).not.toContainText('Start this dish now');
});

test('Smart KDS shadow recommendations do not expose manual kitchen actions', async ({ page }) => {
  await smartKds(page, { mode: 'shadow' });
  await expect(page.locator('#board .primary').first()).toBeDisabled();
  await expect(page.locator('[data-smart-override]')).toHaveCount(0);
});

test('Smart KDS honors a display-only employee permission', async ({ page }) => {
  await smartKds(page, { session: { employee: { id: 'viewer', name: 'Viewer', role: 'captain', permissions: { kitchenDisplay: true, updateKitchen: false } } } });
  await expect(page.locator('#board .primary').first()).toBeDisabled();
  await expect(page.locator('[data-smart-override]')).toHaveCount(0);
});

test('a delayed Smart KDS timeline cannot replace the next order timeline', async ({ page }) => {
  await smartKds(page);
  let release;
  const held = new Promise(resolve => { release = resolve; });
  await page.route('**/api/orders/smart-kds/orders/*/timeline', async route => {
    const old = route.request().url().includes('/a/timeline');
    if (old) await held;
    await route.fulfill({ json: { order: { mode: 'table', tableArea: 'AC', tableNumber: old ? 1 : 2, orderNumber: old ? 1 : 2 }, timeline: [] } });
  });
  const request = page.waitForRequest('**/api/orders/smart-kds/orders/a/timeline');
  await page.evaluate(() => { window.oldTimeline = showTimeline('a'); });
  await request;
  await page.locator('#timeline-close').click();
  await page.evaluate(() => showTimeline('b'));
  release();
  await page.evaluate(() => window.oldTimeline);
  await expect(page.locator('#timeline-title')).toContainText('AC 02');
});

test('Smart KDS rejects duplicate override form submissions', async ({ page }) => {
  await smartKds(page);
  await page.locator('.manager-details summary').click();
  await page.locator('#kitchen-detail-controls').check();
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const requests = [];
  await page.route('**/api/orders/smart-kds/overrides', async route => { requests.push(route.request().postDataJSON()); await held; await route.fulfill({ json: { ok: true } }); });
  await page.locator('[data-smart-override="hold"]').first().click();
  await page.locator('#override-reason').fill('Kitchen pause');
  await page.evaluate(() => {
    $('#override-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    $('#override-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  await expect.poll(() => requests.length).toBeGreaterThan(0);
  try { expect(requests).toHaveLength(1); }
  finally { release(); }
});

test('normal KDS reduces corrected quantities on older rounds and hides served tickets', async ({ page }) => {
  const item = { lineId: 'same-source', name: 'Soup', category: 'Soup', quantity: 3 };
  const rounds = [1, 2].map(kot => ({ ...order, kot_number: kot, tickets: [{ printerId: 'kitchen', items: [{ ...item, quantity: 2 }] }] }));
  await normalKds(page, { order: { ...order, items: [item] }, history: rounds });
  const older = page.locator('.kds-ticket').filter({ has: page.locator('[data-kot="1"]') });
  const newer = page.locator('.kds-ticket').filter({ has: page.locator('[data-kot="2"]') });
  await expect(older.locator('.ticket-items')).toContainText('1×');
  await expect(newer.locator('.ticket-items')).toContainText('2×');
  await page.evaluate(() => { state.statuses.find(status => status.kot_number === 2).status = 'served'; render(); });
  await expect(page.locator('.kds-ticket')).toHaveCount(1);
  await expect(page.locator('.ticket-items')).toContainText('1×');
});

test('normal KDS coalesces overlapping refreshes without applying an older final state', async ({ page }) => {
  await normalKds(page, { history: [history[1]] });
  let release;
  const held = new Promise(resolve => { release = resolve; });
  let reads = 0;
  await page.route('**/api/orders?history=0', async route => {
    reads += 1;
    const first = reads === 1;
    if (first) await held;
    await route.fulfill({ json: [{ ...order, status: first ? 'accepted' : 'ready' }] });
  });
  await page.evaluate(() => { window.firstKitchenLoad = load(); });
  await expect.poll(() => reads).toBe(1);
  await page.evaluate(() => { window.secondKitchenLoad = load(); });
  release();
  await page.evaluate(() => Promise.all([window.firstKitchenLoad, window.secondKitchenLoad]));
  expect(await page.evaluate(() => state.orders[0].status)).toBe('ready');
  expect(reads).toBe(2);
});

test('Smart KDS keeps a pending action locked after its board refreshes', async ({ page }) => {
  await smartKds(page);
  let release;
  const held = new Promise(resolve => { release = resolve; });
  await page.route('**/api/orders/smart-kds/actions', async route => { await held; await route.fulfill({ json: { ok: true } }); });
  const pending = page.waitForRequest('**/api/orders/smart-kds/actions');
  await page.locator('[data-action][data-task="task-a"]').click();
  await pending;
  await page.evaluate(() => render());
  try { await expect(page.locator('[data-action][data-task="task-a"]')).toBeDisabled(); }
  finally { release(); }
});

test('finishing an earlier override cannot close a different task form', async ({ page }) => {
  await smartKds(page);
  await page.locator('.manager-details summary').click();
  await page.locator('#kitchen-detail-controls').check();
  let release;
  const held = new Promise(resolve => { release = resolve; });
  await page.route('**/api/orders/smart-kds/overrides', async route => { await held; await route.fulfill({ json: { ok: true } }); });
  await page.locator('[data-smart-override="hold"][data-task="task-a"]').click();
  await page.locator('#override-reason').fill('Pause soup');
  const pending = page.waitForRequest('**/api/orders/smart-kds/overrides');
  await page.locator('#override-submit').click();
  await pending;
  await page.locator('#override-close').click();
  await page.locator('[data-smart-override="hold"][data-task="task-b"]').click();
  const refreshed = page.waitForRequest('**/api/orders/smart-kds/recommendations');
  release();
  await refreshed;
  await expect(page.locator('#override-dialog')).toBeVisible();
  await expect(page.locator('#override-task')).toContainText('Rice');
  await expect(page.locator('#override-submit')).toBeEnabled();
});

test('Smart KDS hides completed task states even when a scheduling snapshot still includes them', async ({ page }) => {
  await smartKds(page, { states: [{ task_id: 'task-a', task_state: 'served' }] });
  await expect(page.locator('#board [data-task-card]')).toHaveCount(1);
  await expect(page.locator('#board')).not.toContainText('Soup');
});

test('Smart KDS uses restaurant time when the kitchen device timezone differs', async ({ page }) => {
  await smartKds(page);
  expect(await page.evaluate(() => formatTime('2026-10-15T12:00:00.000Z'))).toMatch(/05:30.*pm/i);
});

test('Smart KDS makes a failed refresh visible while retaining the last board', async ({ page }) => {
  await smartKds(page);
  await page.route('**/api/orders/smart-kds/recommendations', route => route.fulfill({ status: 503, json: { error: 'Try again.' } }));
  await page.evaluate(() => load());
  await expect(page.locator('#live')).toContainText('Connection problem');
  await expect(page.locator('#board [data-task-card]')).toHaveCount(2);
});

test('Smart KDS tells staff to start a fired dish instead of assuming cooking already began', async ({ page }) => {
  await smartKds(page, { tasks: [task('a', { taskState: 'fired', capacityState: 'fired' })] });
  await expect(page.locator('#board')).toContainText('Start preparation for this dish');
  await expect(page.locator('#board')).not.toContainText('Keep cooking');
  await expect(page.locator('[data-action="start"]')).toBeEnabled();
});

test('normal KDS clears private orders after its session expires', async ({ page }) => {
  await normalKds(page);
  await page.route('**/api/orders?history=0', route => route.fulfill({ status: 401, json: { error: 'Sign in again.' } }));
  await page.evaluate(() => load());
  await expect(page.locator('.kds-ticket')).toHaveCount(0);
  await expect(page.locator('#kds-status')).toContainText('Sign in again');
});

test('Smart KDS clears private work after its session expires', async ({ page }) => {
  await smartKds(page);
  await page.route('**/api/orders/smart-kds/recommendations', route => route.fulfill({ status: 401, json: { error: 'Sign in again.' } }));
  await page.evaluate(() => load());
  await expect(page.locator('#board [data-task-card]')).toHaveCount(0);
  await expect(page.locator('#live')).toContainText('Sign in');
});
