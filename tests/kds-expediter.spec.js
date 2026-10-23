const { test, expect } = require('@playwright/test');

test.use({ serviceWorkers: 'block', timezoneId: 'UTC' });

const startAt = '2026-10-22T12:00:00.000Z';
const readyAt = '2026-10-22T12:12:00.000Z';
function task(id, options = {}) {
  return {
    taskKey: `task-${id}`, orderId: id, orderNumber: 1, mode: 'table', tableArea: 'AC', tableNumber: 1,
    stationId: 'wok', itemName: 'Fried Rice', category: 'Rice', quantity: 2,
    taskState: 'ordered', action: 'start-now', baseAction: 'start-now', capacityState: 'allocated',
    expediter: { signal: 'green', label: 'Start now', instruction: 'Wok, start 2 Fried Rice for AC 01 now. Ready at 5:42 pm.', reason: 'Station capacity is available.', startAt, readyAt },
    ...options,
  };
}
function snapshot(tasks = [task('a')]) {
  return {
    recommendations: tasks, taskStates: [], batches: [], staleOrders: [], schedulingMode: 'manual', realtimeCursor: 0,
    stations: [{ id: 'wok', name: 'Wok' }, { id: 'bar', name: 'Drinks' }], summary: {},
    expediter: {
      generatedAt: startAt,
      load: { level: 'busy', label: 'Busy kitchen', activeOrders: 7, activePortions: 8, queuedPortions: 16, atRiskTasks: 1, estimatedClearMinutes: 24 },
      stations: [{ stationId: 'wok', stationName: 'Wok', enabled: true, totalCapacity: 6, occupiedCapacity: 6, queuedPortions: 12, estimatedClearMinutes: 24, level: 'busy' }],
      alerts: [], calls: tasks.map(entry => ({ id: `${entry.taskKey}:start`, type: 'start', signal: entry.expediter.signal, instruction: entry.expediter.instruction, taskKeys: [entry.taskKey], stationId: entry.stationId, startAt, readyAt })),
    },
  };
}
async function openKitchen(page, initial, options = {}) {
  const state = { snapshot: initial, status: 200, actions: [] };
  await page.addInitScript(station => {
    window.setInterval = () => 0;
    window.EventSource = undefined;
    if (station) localStorage.setItem('redLanternSmartKdsStation', station);
    window.spokenCalls = []; window.callerCancels = 0; window.callerChimes = 0;
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: {
      speak(utterance) { window.spokenCalls.push(utterance.text); queueMicrotask(() => utterance.onend?.()); },
      cancel() { window.callerCancels += 1; },
    } });
    window.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
    window.AudioContext = class {
      currentTime = 0; destination = {};
      resume() { return Promise.resolve(); }
      createOscillator() { return { frequency: { setValueAtTime() {} }, connect() {}, disconnect() {}, start() { window.callerChimes += 1; }, stop() {} }; }
      createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {}, disconnect() {} }; }
    };
  }, options.station);
  await page.route('**/api/staff/session', async route => {
    if (options.sessionGate) await options.sessionGate;
    await route.fulfill({ json: options.session || { legacy: true } });
  });
  await page.route('**/api/orders/smart-kds/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/actions')) {
      const action = route.request().postDataJSON();
      state.actions.push(action);
      options.onAction?.(action, state);
      return route.fulfill({ json: { ok: true } });
    }
    return route.fulfill({ status: path.endsWith('/recommendations') ? state.status : 200,
      json: path.endsWith('/recommendations') ? state.snapshot : { cursor: 0, events: [] } });
  });
  await page.goto('/smart-kds.html');
  await expect(page.locator('#live')).toHaveText(initial.schedulingMode === 'manual' ? 'Live' : 'View only');
  return state;
}

test('caller shows explicit traffic signals, start/ready times and station workload', async ({ page }) => {
  const green = task('a');
  const yellow = task('b', { action: 'prepare-next', expediter: { ...green.expediter, signal: 'yellow', label: 'Get ready', instruction: 'Wok, get ready for 2 noodles. Start at 5:35 pm.', reason: 'Waiting for the wok to free up.' } });
  const red = task('c', { expediter: { ...green.expediter, signal: 'red', label: 'Missed start', instruction: 'Wok, 2 noodles have not started. Check now.', reason: 'No preparation has been confirmed.' } });
  await openKitchen(page, snapshot([green, yellow, red]));
  await expect(page.locator('[data-task-card][data-task="task-a"]')).toHaveAttribute('data-signal', 'green');
  await expect(page.locator('[data-task-card][data-task="task-b"]')).toHaveAttribute('data-signal', 'yellow');
  const late = page.locator('[data-task-card][data-task="task-c"]');
  await expect(late).toHaveAttribute('data-signal', 'red');
  await expect(late).toContainText('Missed start');
  await expect(late).toContainText('No preparation has been confirmed');
  await expect(page.locator('#board [data-task-card][data-signal="red"]')).toHaveCount(1);
  await expect(page.locator('[data-task-card][data-task="task-b"] .task-schedule')).toContainText(/Start.*05:30.*pm/i);
  await expect(page.locator('#kitchen-load')).toContainText('Busy kitchen');
  await expect(page.locator('#kitchen-load')).toContainText('16 portions queued');
  await expect(page.locator('#kitchen-load')).toContainText('6 / 6 capacity');
  await expect(page.locator('#kitchen-load')).toContainText('24 min');
});

test('fish readiness is called immediately while its cooking course is still held', async ({ page }) => {
  const prep = 'Check chilled or thawed fish stock now; begin kitchen-approved thawing if needed. Keep this main course held.';
  const fish = task('fish', { itemName: 'Fish Chilli', category: 'Seafood', action: 'hold-for-course', capacityState: 'hold-for-course',
    expediter: { signal: 'yellow', label: 'Wait for course', instruction: 'Hold Fish Chilli until starters are ready.', prepAlert: prep, prepAlertImmediate: true, startAt: null, readyAt: null } });
  const initial = snapshot([fish]);
  initial.expediter.alerts = [{ id: 'prep:task-fish', type: 'ingredient-prep', severity: 'warning', urgent: true, taskKey: 'task-fish', stationId: 'wok', message: prep }];
  initial.expediter.calls = [{ id: 'prep:task-fish', type: 'prep', signal: 'yellow', urgent: true, taskKeys: ['task-fish'], stationId: 'wok', instruction: prep }];
  await openKitchen(page, initial);
  await expect(page.locator('#kitchen-alerts')).toContainText('Check chilled or thawed fish stock');
  await expect(page.locator('#kitchen-briefing')).toContainText('Keep this main course held');
  await expect(page.locator('#board [data-status="waiting"] .ingredient-alert')).toContainText(prep);
  await expect(page.locator('#board [data-status="waiting"] .ready-by')).toHaveCount(0);
  await expect(page.locator('#board [data-status="waiting"] .task-schedule')).not.toContainText('Start');
  await expect(page.locator('#board [data-status="waiting"] button').first()).toBeDisabled();
  expect(await page.evaluate(() => window.spokenCalls)).toEqual([]);
  await page.locator('#caller-toggle').click();
  await expect.poll(() => page.evaluate(() => window.spokenCalls)).toEqual([prep]);
  expect(await page.evaluate(() => window.callerChimes)).toBe(1);
});

test('voice requires opt-in, deduplicates repeat polls and announces new urgency', async ({ page }) => {
  const state = await openKitchen(page, snapshot());
  await page.evaluate(() => load());
  expect(await page.evaluate(() => window.spokenCalls)).toEqual([]);
  await page.locator('#caller-toggle').click();
  await expect.poll(() => page.evaluate(() => window.spokenCalls.length)).toBe(1);
  await page.evaluate(async () => { await load(); await load(); render(); });
  expect(await page.evaluate(() => window.spokenCalls.length)).toBe(1);
  state.snapshot.expediter.calls[0] = { ...state.snapshot.expediter.calls[0], id: 'task-a:missed-start', signal: 'red', urgent: true, instruction: 'Wok, Fried Rice has not started. Check now.' };
  await page.evaluate(() => load());
  await expect.poll(() => page.evaluate(() => window.spokenCalls.length)).toBe(2);
  expect(await page.evaluate(() => window.callerChimes)).toBe(1);
  await page.locator('#caller-toggle').click();
  state.snapshot.expediter.calls[0].id = 'task-a:new-call';
  await page.evaluate(() => load());
  expect(await page.evaluate(() => window.spokenCalls.length)).toBe(2);
});

test('station display calls and alerts stay with the selected station', async ({ page }) => {
  const initial = snapshot([task('a'), task('drink', { stationId: 'bar', itemName: 'Lime Soda', expediter: { signal: 'green', instruction: 'Drinks, make 1 Lime Soda now.' } })]);
  initial.expediter.alerts = [{ id: 'bar:alert', type: 'late', severity: 'critical', stationId: 'bar', taskKey: 'task-drink', message: 'Drinks needs attention.' }];
  await openKitchen(page, initial, { station: 'wok' });
  await expect(page.locator('#kitchen-alerts')).toBeHidden();
  await expect(page.locator('#kitchen-briefing')).not.toContainText('Lime Soda');
  await page.locator('#caller-toggle').click();
  await expect.poll(() => page.evaluate(() => window.spokenCalls.length)).toBe(1);
  expect((await page.evaluate(() => window.spokenCalls)).join(' ')).not.toContain('Drinks');
  await page.locator('#station-filter').selectOption('bar');
  await expect(page.locator('#kitchen-briefing')).toContainText('Lime Soda');
  await expect.poll(() => page.evaluate(() => window.spokenCalls.length)).toBe(2);
});

test('shadow and expired sessions stop caller audio and clear private instructions', async ({ page }) => {
  const initial = snapshot();
  initial.schedulingMode = 'shadow';
  const state = await openKitchen(page, initial);
  await expect(page.locator('#caller-toggle')).toBeDisabled();
  state.snapshot.schedulingMode = 'manual';
  await page.evaluate(() => load());
  await page.locator('#caller-toggle').click();
  await expect.poll(() => page.evaluate(() => window.spokenCalls.length)).toBe(1);
  const cancels = await page.evaluate(() => window.callerCancels);
  state.status = 401;
  state.snapshot = { error: 'Sign in again.' };
  await page.evaluate(() => load());
  await expect(page.locator('#board [data-task-card]')).toHaveCount(0);
  await expect(page.locator('#kitchen-load')).toBeHidden();
  await expect(page.locator('#kitchen-alerts')).toBeHidden();
  await expect(page.locator('#kitchen-briefing')).not.toContainText('Fried Rice');
  await expect(page.locator('#caller-toggle')).toBeDisabled();
  expect(await page.evaluate(() => window.callerCancels)).toBeGreaterThan(cancels);
});

test('safe bulk call preserves portions and table allocations with one start action', async ({ page }) => {
  const first = task('a', { quantity: 2 });
  const second = task('b', { quantity: 3, tableNumber: 2, orderNumber: 2 });
  const initial = snapshot([first, second]);
  initial.batches = [{ batchId: 'safe-rice', batchGroupId: 'Fried Rice', action: 'fire-batch', stationId: 'wok', totalQuantity: 5, reason: 'Compatible items fit station capacity.', allocations: [first, second] }];
  initial.expediter.calls = [{ id: 'batch:safe-rice:start', type: 'batch', batchId: 'safe-rice', signal: 'green', instruction: 'Wok, start 5 Fried Rice together for AC 01 and AC 02. Ready at 5:42 pm.', taskKeys: ['task-a', 'task-b'], stationId: 'wok', startAt, readyAt }];
  const state = await openKitchen(page, initial);
  await expect(page.locator('.batch-card')).toContainText('Start 5 portions together');
  await expect(page.locator('.batch-orders')).toContainText('AC 01');
  await expect(page.locator('.batch-orders')).toContainText('AC 02');
  await expect(page.locator('#batch-list [data-batch-action]')).toHaveCount(1);
  await expect(page.locator('#board [data-task-card]')).toHaveCount(2);
  state.snapshot.taskStates = [{ task_id: 'task-b', task_state: 'served' }];
  await page.evaluate(() => load());
  await expect(page.locator('[data-batch-action]')).toHaveCount(0);
  await expect(page.locator('#kitchen-briefing')).not.toContainText('start 5 Fried Rice');
});

test('queued bulk quantities remain visible and capacity locks survive a control resync', async ({ page }) => {
  const queued = task('a', { capacityState: 'capacity-wait', action: 'wait-capacity', expediter: { signal: 'yellow', label: 'Prepare next', instruction: 'Keep 2 Fried Rice ready; wait for the station slot.' } });
  const initial = snapshot([queued]);
  initial.batches = [{ batchId: 'queued', batchGroupId: 'Rice', action: 'fire-batch', stationId: 'wok', totalQuantity: 2, allocations: [queued] }];
  initial.expediter.calls = [{ id: 'batch:queued:wait', batchId: 'queued', type: 'batch', signal: 'yellow', taskKeys: ['task-a'], stationId: 'wok', instruction: 'Stage 2 Fried Rice. Wait for a free wok.' }];
  const state = await openKitchen(page, initial);
  await expect(page.locator('.batch-card')).toHaveAttribute('data-signal', 'yellow');
  await expect(page.locator('.batch-card')).toContainText('2 portions together');
  await expect(page.locator('#batch-list [data-batch-action]')).toBeDisabled();
  await expect(page.locator('#next-action-button:not(:disabled)')).toHaveCount(0);
  await page.evaluate(() => syncKitchenPending());
  await expect(page.locator('#batch-list [data-batch-action]')).toBeDisabled();
  await expect(page.locator('#next-action-button:not(:disabled)')).toHaveCount(0);
  state.snapshot.recommendations[0].expediter.signal = 'red';
  await page.evaluate(() => load());
  await expect(page.locator('.batch-card')).toHaveAttribute('data-signal', 'red');
  await expect(page.locator('#batch-list [data-batch-action]')).toBeDisabled();
  await expect(page.locator('#next-action-button:not(:disabled)')).toHaveCount(0);
});

test('forecast ready time stays separate from service target and yellow never commands an immediate start', async ({ page }) => {
  const queued = task('a', { targetServeAt: startAt, expediter: { signal: 'yellow', label: 'Prepare next', instruction: 'Keep Fried Rice ready; estimated start in 5 min.', reason: 'Wok is occupied.', startAt, readyAt, delayMinutes: 12 } });
  await openKitchen(page, snapshot([queued]));
  const card = page.locator('[data-task-card]');
  await expect(card.locator('.ready-by')).toContainText('Est. ready');
  await expect(card.locator('.ready-by')).toContainText(/05:42.*pm/i);
  await expect(card.locator('.task-schedule')).toContainText(/Due.*05:30.*pm/i);
  await expect(card).toContainText('+12 min late');
  await expect(card.locator('.task-command')).toContainText('estimated start in 5 min');
  await expect(card).not.toContainText('Start this dish now');
  await expect(card.locator('button').first()).toBeDisabled();
});

test('an overdue cooking item asks the chef to check progress', async ({ page }) => {
  const overdue = task('a', { taskState: 'preparing', expediter: { signal: 'red', label: 'Check cooking', instruction: 'Check Fried Rice now; cooking is over its estimate. Confirm progress or mark ready when finished.' } });
  await openKitchen(page, snapshot([overdue]));
  await expect(page.locator('[data-task-card] .task-command')).toContainText('Check Fried Rice now');
  await expect(page.locator('[data-task-card]')).not.toContainText('Keep cooking this dish');
  await expect(page.locator('#board [data-action="ready"]')).toBeEnabled();
});

test('surge caller stays compact while the board retains every task', async ({ page }) => {
  const initial = snapshot(Array.from({ length: 20 }, (_, index) => task(String(index))));
  initial.expediter.alerts = Array.from({ length: 12 }, (_, index) => ({ id: `late-${index}`, type: 'missed-start', severity: 'critical', taskKey: `task-${index}`, stationId: 'wok', message: `Check order ${index} now.` }));
  await openKitchen(page, initial);
  await expect(page.locator('#caller-calls-list [data-call-id]')).toHaveCount(8);
  await expect(page.locator('#caller-calls-list')).toContainText('next 8 of 20 calls');
  await expect(page.locator('#board [data-task-card]')).toHaveCount(6);
  await expect(page.locator('#board-total')).toContainText('20 orders');
  const seen = new Set();
  for (let index = 0; index < 4; index += 1) {
    for (const key of await page.locator('#board [data-task-card]').evaluateAll(rows => rows.map(row => row.dataset.task))) seen.add(key);
    if (index < 3) await page.locator('#board-next').click();
  }
  expect(seen.size).toBe(20);
  await expect(page.locator('#kitchen-alerts h2')).toContainText('12 total');
  await expect(page.locator('.additional-alerts')).not.toHaveAttribute('open');
  await page.locator('#alerts-toggle').click();
  await page.locator('.additional-alerts summary').click();
  await expect(page.locator('[data-alert-id="late-11"]')).toBeVisible();
  await page.locator('[data-close-dialog="alerts-dialog"]').click();
  await page.locator('#caller-toggle').click();
  await expect.poll(() => page.evaluate(() => window.spokenCalls.length)).toBe(12);
  await page.evaluate(async () => { await load(); render(); });
  expect(await page.evaluate(() => window.spokenCalls.length)).toBe(12);
});

test('new workflow acknowledgements suppress older start advice and queued voice', async ({ page }) => {
  const initial = snapshot();
  initial.recommendations[0].action = 'manual-hold';
  initial.expediter.alerts = [{ id: 'task-a:missed-start', type: 'missed-start', severity: 'critical', taskKey: 'task-a', stationId: 'wok', message: 'Fried Rice has not started.' }];
  initial.taskStates = [{ task_id: 'task-a', task_state: 'preparing' }];
  await openKitchen(page, initial);
  const card = page.locator('[data-task-card]');
  await expect(card).toHaveAttribute('data-signal', 'neutral');
  await expect(card).toContainText('Keep cooking this dish');
  await expect(card).not.toContainText('Wok, start 2 Fried Rice');
  await expect(page.locator('#caller-calls-list [data-call-id]')).toHaveCount(0);
  await expect(page.locator('#kitchen-alerts')).toBeHidden();
  await expect(page.locator('#board [data-action="ready"]')).toBeEnabled();
  await page.locator('#caller-toggle').click();
  expect(await page.evaluate(() => window.spokenCalls)).toEqual([]);
});

test('cooking style and special instructions are visible as escaped text', async ({ page }) => {
  const note = 'No onion <img src=x onerror="window.kdsUnsafeNote = true">';
  await openKitchen(page, snapshot([task('a', { style: 'Extra spicy', note })]));
  const card = page.locator('[data-task-card]');
  await expect(card).toContainText('Style: Extra spicy');
  await expect(card).toContainText(note);
  await expect(card.locator('img')).toHaveCount(0);
  expect(await page.evaluate(() => window.kdsUnsafeNote)).toBeUndefined();
});

test('shadow mode keeps named Mark ready controls visible and explains how actions are enabled', async ({ page }) => {
  const initial = snapshot([task('a'), task('b', { taskState: 'preparing' })]);
  initial.schedulingMode = 'shadow';
  await openKitchen(page, initial);
  const ready = page.getByRole('button', { name: 'Mark ready', exact: true });
  await expect(ready).toHaveCount(2);
  await expect(ready.first()).toBeVisible();
  await expect(ready.first()).toBeDisabled();
  await expect(ready.last()).toBeVisible();
  await expect(ready.last()).toBeDisabled();
  await expect(page.locator('#kitchen-mode-notice')).toContainText('Shadow mode');
  await expect(page.locator('#kitchen-mode-notice a')).toHaveAttribute('href', '/admin#tab-smart-kds');
  await expect(page.locator('#kitchen-mode-notice')).toContainText('Admin → Smart KDS → Setup');
});

test('display-only staff see a disabled Mark ready control with their permission explanation', async ({ page }) => {
  await openKitchen(page, snapshot(), { session: { employee: { id: 'viewer', name: 'Viewer', role: 'captain', permissions: { kitchenDisplay: true, updateKitchen: false } } } });
  await expect(page.getByRole('button', { name: 'Mark ready', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Mark ready', exact: true })).toBeDisabled();
  await expect(page.locator('#kitchen-mode-notice')).toContainText('your staff account cannot update');
});

test('late staff verification keeps Mark ready visible while disabling unauthorized actions', async ({ page }) => {
  let release;
  const sessionGate = new Promise(resolve => { release = resolve; });
  const state = await openKitchen(page, snapshot(), { sessionGate, session: { employee: { id: 'viewer', name: 'Viewer', role: 'captain', permissions: { kitchenDisplay: true, updateKitchen: false } } } });
  release();
  const ready = page.getByRole('button', { name: 'Mark ready', exact: true });
  await expect(ready).toBeDisabled();
  await expect(ready).toBeVisible();
  await expect(page.locator('#kitchen-mode-notice')).toContainText('your staff account cannot update');
  await page.evaluate(() => { document.querySelector('[data-ready-control]').click(); });
  expect(state.actions).toEqual([]);
});

test('queued food can be marked ready before its forecast and the next snapshot shows completion', async ({ page }) => {
  const queued = task('a', { action: 'wait-capacity', capacityState: 'capacity-wait', expediter: { signal: 'yellow', label: 'Prepare next', instruction: 'Keep Fried Rice ready for the next station slot.', startAt: '2050-01-01T12:00:00.000Z', readyAt: '2050-01-01T12:20:00.000Z' } });
  const next = task('b', { action: 'wait-capacity', capacityState: 'capacity-wait', expediter: { signal: 'yellow', instruction: 'Wait for the wok.' } });
  const initial = snapshot([queued, next]);
  initial.expediter.alerts = [{ id: 'late-a', type: 'missed-start', severity: 'critical', taskKey: 'task-a', stationId: 'wok', message: 'Old start warning.' }];
  const state = await openKitchen(page, initial, { onAction(action, current) {
    current.snapshot.taskStates = [{ task_id: action.taskKey, task_state: 'ready' }];
    current.snapshot.recommendations[0] = { ...queued, taskState: 'ready', expediter: { signal: 'neutral', label: 'Ready for expo', instruction: 'Collect Fried Rice for expo.' } };
    current.snapshot.recommendations[1] = task('b');
    current.snapshot.expediter.alerts = [];
    current.snapshot.expediter.calls = [{ id: 'task-a:ready', type: 'expo', signal: 'neutral', taskKeys: ['task-a'], stationId: 'wok', instruction: 'Collect Fried Rice for expo.' }, { id: 'task-b:start', type: 'start', signal: 'green', taskKeys: ['task-b'], stationId: 'wok', instruction: 'Start the next Fried Rice now.' }];
  } });
  await expect(page.locator('#board [data-action="ready"][data-task="task-a"]')).toBeEnabled();
  await page.locator('#board [data-action="ready"][data-task="task-a"]').click();
  await expect(page.locator('#board [data-status="ready"][data-task="task-a"][data-task-card]')).toBeVisible();
  expect(state.actions).toEqual([{ action: 'ready', taskKey: 'task-a', orderId: 'a', stationId: 'wok' }]);
  await expect(page.locator('#board [data-action="expo"][data-task="task-a"]')).toBeEnabled();
  await expect(page.locator('#board [data-action="ready"][data-task="task-a"]')).toHaveCount(0);
  await expect(page.locator('#kitchen-alerts')).toBeHidden();
  await expect(page.locator('#kitchen-briefing')).not.toContainText('Old start warning');
  await expect(page.locator('#board [data-action="start"][data-task="task-b"]')).toBeEnabled();
});

test('physical completion is available on course-held ordered and actively preparing dishes', async ({ page }) => {
  const heldCourse = task('a', { action: 'hold-for-course', capacityState: 'hold-for-course', expediter: { signal: 'yellow', label: 'Hold cooking', instruction: 'Cooking waits for course release.', readyAt: '2050-01-01T12:00:00.000Z' } });
  const preparing = task('b', { taskState: 'preparing', expediter: { signal: 'neutral', label: 'Cooking', instruction: 'Cooking has started.', readyAt: '2050-01-01T12:00:00.000Z' } });
  const state = await openKitchen(page, snapshot([heldCourse, preparing]));
  await expect(page.locator('#board [data-action="ready"][data-task="task-a"]')).toBeEnabled();
  const primary = page.locator('#board [data-action="ready"][data-task="task-b"]');
  await expect(primary).toHaveClass(/primary/);
  await expect(primary).toBeEnabled();
  await primary.click();
  expect(state.actions[0]).toEqual({ action: 'ready', taskKey: 'task-b', orderId: 'b', stationId: 'wok' });
});

test('batch allocations expose individual Mark ready controls and lock batch start while completion saves', async ({ page }) => {
  const first = task('a'), second = task('b');
  const initial = snapshot([first, second]);
  initial.batches = [{ batchId: 'rice', batchGroupId: 'Rice', action: 'fire-batch', stationId: 'wok', totalQuantity: 4, allocations: [first, second] }];
  const state = await openKitchen(page, initial);
  await expect(page.locator('.batch-allocation [data-action="ready"]')).toHaveCount(2);
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const actions = [];
  await page.route('**/api/orders/smart-kds/actions', async route => {
    actions.push(route.request().postDataJSON());
    await held;
    state.snapshot.taskStates = [{ task_id: 'task-a', task_state: 'ready' }];
    await route.fulfill({ json: { ok: true } });
  });
  const pending = page.waitForRequest('**/api/orders/smart-kds/actions');
  await page.locator('#batches-toggle').click();
  await page.locator('#batch-list [data-action="ready"][data-task="task-a"]').click();
  await pending;
  try {
    await page.evaluate(() => { render(); syncKitchenPending(); document.querySelector('[data-action="ready"][data-task="task-a"]').click(); });
    await expect(page.locator('#board [data-action="ready"][data-task="task-a"]')).toBeDisabled();
    await expect(page.locator('#batch-list [data-batch-action]')).toBeDisabled();
    await expect(page.locator('#next-action-button:not(:disabled)')).toHaveCount(0);
    await expect(page.locator('#board [data-action="ready"][data-task="task-b"]')).toBeEnabled();
    expect(actions).toEqual([{ action: 'ready', taskKey: 'task-a', orderId: 'a', stationId: 'wok' }]);
  } finally { release(); }
  await expect(page.locator('#board [data-action="expo"][data-task="task-a"]')).toBeEnabled();
  await expect(page.locator('#board [data-action="ready"][data-task="task-b"]')).toBeEnabled();
});

test('Mark ready requires a station and excludes held or already completed workflow states', async ({ page }) => {
  const initial = snapshot([task('a', { stationId: '' }), task('held', { taskState: 'held' }), task('ready', { taskState: 'ready' }), task('expo', { taskState: 'expo' }), task('served', { taskState: 'served' })]);
  await openKitchen(page, initial);
  await expect(page.locator('#board [data-action="ready"]')).toHaveCount(1);
  await expect(page.locator('#board [data-action="ready"][data-task="task-a"]')).toBeDisabled();
  await page.evaluate(() => syncKitchenPending());
  await expect(page.locator('#board [data-action="ready"][data-task="task-a"]')).toBeDisabled();
  await expect(page.locator('[data-task-card][data-task="task-a"]')).toContainText('Assign a kitchen station before marking this item ready.');
  await expect(page.locator('#board [data-action="expo"][data-task="task-ready"]')).toBeEnabled();
  await expect(page.locator('#board [data-action="serve"][data-task="task-expo"]')).toBeEnabled();
});

test('running top-ups retain their badge and escaped notes through start and ready actions', async ({ page }) => {
  const orderNote = 'RUNNING extra portion <img src=x onerror="window.kdsUnsafeOrderNote = true">';
  const instruction = 'Running order / additional portion, priority: Start 2 Fried Rice for AC table 2 now.';
  const running = task('running', { orderNumber: 2, tableNumber: 2, finalRank: 1, runningOrder: true, runningOrderReason: 'Customer is already eating.', note: 'No onion', orderNote,
    expediter: { signal: 'green', phase: 'start', label: 'Start now', instruction, startAt, readyAt } });
  const ordinary = task('ordinary', { orderNumber: 1, finalRank: 2 });
  const initial = snapshot([ordinary, running]);
  initial.expediter.calls = [{ id: 'ordinary:start', type: 'start', priority: 10, signal: 'green', instruction: 'Start the ordinary Fried Rice.', taskKeys: ['task-ordinary'], stationId: 'wok' }, { id: 'running:start', type: 'start', priority: 1, signal: 'green', runningOrder: true, instruction, taskKeys: ['task-running'], stationId: 'wok' }];
  const state = await openKitchen(page, initial, { onAction(action, current) {
    const entry = current.snapshot.recommendations.find(item => item.taskKey === action.taskKey);
    entry.taskState = action.action === 'start' ? 'preparing' : 'ready';
    entry.expediter = { signal: 'neutral', phase: entry.taskState === 'ready' ? 'ready' : 'cooking', label: entry.taskState === 'ready' ? 'Ready for expo' : 'Cooking', instruction: 'Running order / additional portion, priority: confirm progress.' };
    current.snapshot.taskStates = [{ task_id: entry.taskKey, task_state: entry.taskState }];
    current.snapshot.expediter.calls = current.snapshot.expediter.calls.filter(call => !call.taskKeys.includes(entry.taskKey));
  } });
  await expect(page.locator('[data-order-ticket]').first()).toHaveAttribute('data-order', 'running');
  const row = page.locator('#board [data-task-card][data-task="task-running"]');
  await expect(row.locator('.running-order-badge')).toHaveText('RUNNING · Priority top-up');
  await expect(row).toHaveAttribute('data-signal', 'green');
  await expect(row).toContainText('Note: No onion');
  await expect(row).toContainText(`Order note: ${orderNote}`);
  await expect(row.locator('img')).toHaveCount(0);
  expect(await page.evaluate(() => window.kdsUnsafeOrderNote)).toBeUndefined();
  await expect(page.locator('[data-order-ticket][data-order="running"] .ticket-running-cue')).toHaveText('RUN 1');
  await expect(page.locator('#kitchen-briefing')).toContainText('Running top-up');
  await expect(page.locator('#caller-calls-list')).toContainText(instruction);
  await row.locator('[data-action="start"]').click();
  await expect(row).toHaveAttribute('data-state', 'preparing');
  await expect(row.locator('.running-order-badge')).toBeVisible();
  await row.locator('[data-action="ready"]').click();
  await expect(row).toHaveAttribute('data-state', 'ready');
  await expect(row.locator('.running-order-badge')).toBeVisible();
  expect(state.actions.map(action => action.action)).toEqual(['start', 'ready']);
});

test('blocked running top-ups stay behind actionable starts and ahead of ordinary waiting work', async ({ page }) => {
  const blockedInstruction = 'Running order / additional portion, priority: Expo, prioritize the next available station slot.';
  const running = task('running', { finalRank: 1, runningOrder: true, runningOrderReason: 'Additional portion for an occupied table.', note: 'rUnNiNg', orderNote: 'rUnNiNg', capacityState: 'capacity-wait', action: 'wait-capacity',
    expediter: { signal: 'red', phase: 'blocked', label: 'Needs expo', instruction: blockedInstruction } });
  const ordinary = task('ordinary', { finalRank: 2, capacityState: 'capacity-wait', action: 'wait-capacity', latestSafeStartAt: '2020-01-01T00:00:00Z', expediter: { signal: 'yellow', phase: 'next', label: 'Prepare next', instruction: 'Wait for capacity.' } });
  const actionable = task('start', { finalRank: 20 });
  const initial = snapshot([ordinary, running, actionable]);
  initial.expediter.calls = [{ id: 'running:blocked', type: 'check', priority: 1, signal: 'red', runningOrder: true, instruction: blockedInstruction, taskKeys: ['task-running'], stationId: 'wok' }, { id: 'start:start', type: 'start', priority: 20, signal: 'green', instruction: 'Start the allocated Fried Rice now.', taskKeys: ['task-start'], stationId: 'wok' }];
  await openKitchen(page, initial);
  expect(await page.locator('[data-order-ticket]').evaluateAll(tickets => tickets.map(ticket => ticket.dataset.order))).toEqual(['start', 'running', 'ordinary']);
  const row = page.locator('#board [data-task-card][data-task="task-running"]');
  await expect(row).toHaveAttribute('data-status', 'waiting');
  await expect(row).toHaveAttribute('data-signal', 'red');
  await expect(row.locator('.running-order-badge')).toBeVisible();
  await expect(row.locator('[data-action="start"]')).toBeDisabled();
  await page.evaluate(() => syncKitchenPending());
  await expect(row.locator('[data-action="start"]')).toBeDisabled();
  await expect(row.locator('[data-action="ready"]')).toBeEnabled();
  await expect(row.locator('.item-note')).toHaveText('Note: rUnNiNg');
  await expect(page.locator('#kitchen-briefing')).toHaveAttribute('data-task', 'task-start');
  await expect(page.locator('#next-action-button')).toBeEnabled();
  await expect(page.locator('#caller-calls-list')).toContainText(blockedInstruction);
});

test('learned timing labels show only applied recorded estimates and explain sparse history in the load panel', async ({ page }) => {
  const learned = { applied: true, sampleCount: 6, loadBand: 'busy', estimateMinutes: 9, baselineMinutes: 12, confidence: 0.8, reason: 'Measured from confirmed preparation starts and ready items.' };
  const initial = snapshot([task('learned', { learning: learned }), task('sparse', { learning: { ...learned, applied: false, sampleCount: 2 } }), task('empty', { learning: { ...learned, sampleCount: 0 } })]);
  initial.learning = { enabled: true, qualifyingSamples: 8, learnedTasks: 1, trackedDishes: 2 };
  const state = await openKitchen(page, initial);
  await expect(page.locator('#board .learned-timing')).toHaveCount(1);
  const label = page.locator('[data-task="task-learned"][data-task-card] .learned-timing');
  await expect(label).toHaveText('Learned 9 min · busy');
  await expect(label).toHaveAttribute('title', /6 recorded kitchen timings.*Configured estimate: 12 min/);
  await expect(page.locator('#board [data-action="start"][data-task="task-learned"]')).toBeEnabled();
  await page.locator('#load-toggle').click();
  await expect(page.locator('.learning-summary')).toContainText('8 qualifying timings');
  await expect(page.locator('.learning-summary')).toContainText('1 active learned estimate');
  await expect(page.locator('.learning-summary')).toContainText('recorded start and ready confirmations');
  state.snapshot.learning = { enabled: true, qualifyingSamples: 2, learnedTasks: 0, trackedDishes: 1 };
  state.snapshot.recommendations[0].learning = { ...learned, applied: false, sampleCount: 2 };
  await page.evaluate(() => load());
  await expect(page.locator('#board .learned-timing')).toHaveCount(0);
  await expect(page.locator('.learning-summary')).toContainText('Configured estimates remain in use');
  state.snapshot.learning = { enabled: true, qualifyingSamples: 0, learnedTasks: 0, trackedDishes: 0 };
  await page.evaluate(() => load());
  await expect(page.locator('.learning-summary')).toContainText('0 qualifying timings');
  await expect(page.locator('#board .learned-timing')).toHaveCount(0);
});

test('cross-table soup batches show every allocation and the earliest safe grouping deadline', async ({ page }) => {
  const first = task('a', { itemName: 'Chicken Clear Soup', category: 'Soup', quantity: 2, course: 'soup', courseMode: 'course-wise', action: 'prepare-next',
    expediter: { signal: 'yellow', phase: 'next', label: 'Prepare next', instruction: 'Keep soup portions ready for the safe batch window.' } });
  const second = { ...first, taskKey: 'task-b', orderId: 'b', orderNumber: 2, tableArea: 'Garden', tableNumber: 8, quantity: 3 };
  const close = new Date(Date.now() + 2 * 60_000).toISOString();
  const initial = snapshot([first, second]);
  initial.batches = [{ batchId: 'soup-tables', batchGroupId: 'Chicken Clear Soup', action: 'wait-for-batch', waitingForMore: true, stationId: 'wok', totalQuantity: 5,
    holdUntilAt: close, windowClosesAt: new Date(Date.now() + 6 * 60_000).toISOString(), latestSafeStartAt: new Date(Date.now() + 3 * 60_000).toISOString(), allocations: [first, second] }];
  const state = await openKitchen(page, initial);
  await page.locator('#batches-toggle').click();
  await expect(page.locator('#batches-dialog h2')).toContainText('Cook together');
  await expect(page.locator('.batch-card')).toContainText('5 portions together');
  await expect(page.locator('.batch-allocation-heading')).toContainText('Table / order allocations');
  await expect(page.locator('.batch-orders')).toContainText('AC 01');
  await expect(page.locator('.batch-orders')).toContainText('Garden 08');
  await expect(page.locator('.batch-orders')).toContainText('2× Chicken Clear Soup');
  await expect(page.locator('.batch-orders')).toContainText('3× Chicken Clear Soup');
  await expect(page.locator('.batch-course-context').first()).toContainText('soup · course wise');
  await expect(page.locator('.batch-window')).toHaveAttribute('data-hold-until', close);
  await expect(page.locator('.batch-window')).toContainText('2 min remaining');
  await expect(page.locator('#batch-list [data-batch-action]')).toBeDisabled();
  await expect(page.locator('#next-action-button:not(:disabled)')).toHaveCount(0);
  state.snapshot.batches[0].holdUntilAt = new Date(Date.now() - 60_000).toISOString();
  await page.evaluate(() => load());
  await expect(page.locator('.batch-window')).toContainText('Grouping window reached');
  await expect(page.locator('#batch-list [data-batch-action]')).toBeDisabled();
  await expect(page.locator('#next-action-button:not(:disabled)')).toHaveCount(0);
  expect(state.actions).toEqual([]);
});

test('an empty cook-together drawer points to existing menu batch setup without inventing batch limits', async ({ page }) => {
  await openKitchen(page, snapshot());
  await page.locator('#batches-toggle').click();
  await expect(page.locator('#batch-list')).toContainText('Enable compatible soup/rice batches and set portions per batch');
  await expect(page.locator('#batch-list a')).toHaveAttribute('href', '/admin#tab-smart-kds');
  await expect(page.locator('#batch-list a')).toHaveAttribute('data-kds-panel', 'profiles');
  await expect(page.locator('#batch-list [data-batch-action]')).toHaveCount(0);
});

test('learned timings and bulk suggestions never start a held serve-together main course', async ({ page }) => {
  const main = task('main', { orderId: 'a', itemName: 'Chicken Biryani', category: 'Main', course: 'main', courseMode: 'serve-together', action: 'hold-for-course', pacingState: 'hold-for-course', capacityState: 'hold-for-course',
    learning: { applied: true, sampleCount: 8, loadBand: 'quiet', estimateMinutes: 8, baselineMinutes: 12 },
    expediter: { signal: 'yellow', phase: 'hold', label: 'Hold for table', instruction: 'Keep this main course held until the table is ready to receive its food together.', startAt: null, readyAt: null } });
  const starter = task('starter', { orderId: 'a', itemName: 'Chicken Lollipop', course: 'starter' });
  const initial = snapshot([main, starter]);
  initial.learning = { enabled: true, qualifyingSamples: 8, learnedTasks: 1, trackedDishes: 1 };
  initial.batches = [{ batchId: 'held-main', batchGroupId: 'Biryani', action: 'fire-batch', stationId: 'wok', totalQuantity: 2, allocations: [main] }];
  const state = await openKitchen(page, initial);
  const row = page.locator('#board [data-task-card][data-task="task-main"]');
  await expect(row).toHaveAttribute('data-status', 'waiting');
  await expect(row.locator('.learned-timing')).toHaveText('Learned 8 min · quiet');
  await expect(row.locator('[data-action="start"]')).toBeDisabled();
  await expect(row.locator('[data-action="ready"]')).toBeEnabled();
  await expect(page.locator('#board [data-action="start"][data-task="task-starter"]')).toBeEnabled();
  await expect(page.locator('#batches-count')).toHaveText('0');
  await page.evaluate(() => { syncKitchenPending(); document.querySelector('#board [data-action="start"][data-task="task-main"]').click(); });
  await expect(row.locator('[data-action="start"]')).toBeDisabled();
  expect(state.actions).toEqual([]);
});
