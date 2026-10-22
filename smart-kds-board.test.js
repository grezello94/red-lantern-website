const fs = require('node:fs');
const vm = require('node:vm');
const { buildBoardView, buildKitchenBoard, normalizeTasks, getTaskView } = require('./smart-kds-board');

const task = (key, changes = {}) => ({
  taskKey: key, orderId: key.split(':')[0], orderNumber: 12, mode: 'table', tableArea: 'Garden', tableNumber: 4,
  itemName: 'Fish Fry', quantity: 1, taskState: 'ordered', stationId: 'fish', category: 'Goan Fish',
  capacityState: 'allocated', action: 'start-now', finalRank: 2,
  latestSafeStartAt: '2026-10-22T12:00:00.000Z', targetServeAt: '2026-10-22T12:20:00.000Z',
  orderedAt: '2026-10-22T11:55:00.000Z', expediter: { signal: 'green', phase: 'start', instruction: 'Start Fish Fry now.' },
  ...changes,
});
const freeze = (value) => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value); Object.values(value).forEach(freeze);
  }
  return value;
};

describe('tablet kitchen board model', () => {
  test('exports the same pure model in CommonJS and browser globals', () => {
    expect(buildKitchenBoard).toBe(buildBoardView);
    const browser = {};
    vm.runInNewContext(fs.readFileSync(require.resolve('./smart-kds-board'), 'utf8'), browser);
    expect(browser.RedLanternKdsBoard).toBe(browser.RedLanternKitchenBoard);
    expect(browser.RedLanternKdsBoard.buildKitchenBoard({ tasks: [task('one:item')], status: 'start' }).totalItems).toBe(1);
  });

  test('latest recorded state wins over duplicate recommendations and stale caller instructions', () => {
    const recommendations = [task('one:fish', { version: 1, quantity: 2 }), task('one:fish', { version: 2, quantity: 3 }), task('two:rice')];
    const taskStates = [
      { task_id: 'one:fish', task_state: 'ready', version: 4, updated_at: '2026-10-22T12:05:00Z' },
      { task_id: 'one:fish', task_state: 'preparing', version: 3, updated_at: '2026-10-22T12:06:00Z' },
      { task_id: 'two:rice', task_state: 'served', version: 4 },
    ];
    const view = buildBoardView({ recommendations, taskStates });
    expect(view.totalItems).toBe(1);
    expect(view.totalPortions).toBe(3);
    expect(view.orders[0].tasks[0]).toMatchObject({ taskState: 'ready', boardStatus: 'ready', boardStateChanged: true });
    expect(view.orders[0].tasks[0].expediter).toBeUndefined();
    expect(view.counts).toEqual({ all: 1, start: 0, cooking: 0, waiting: 0, ready: 1 });
  });

  test('uses updated time when recorded versions tie and never resurrects a terminal task', () => {
    const states = [
      { task_id: 'one:fish', task_state: 'cancelled', version: 2, updated_at: '2026-10-22T12:05:00Z' },
      { task_id: 'one:fish', task_state: 'ordered', version: 2, updated_at: '2026-10-22T12:00:00Z' },
    ];
    expect(normalizeTasks([task('one:fish')], states)).toEqual([]);
    expect(normalizeTasks([task('one:fish')], [...states, { task_id: 'one:fish', task_state: 'ordered', version: 3 }])[0].taskState).toBe('ordered');
  });

  test('puts actionable starts before blocked red tickets and preserves scheduler rank within starts', () => {
    const recommendations = Array.from({ length: 12 }, (_, index) => task(`blocked-${index}:item`, {
      capacityState: 'capacity-wait', finalRank: index + 1,
      expediter: { signal: 'red', phase: 'missed-start' },
    })).concat([
      task('start-later-deadline:item', { finalRank: 13, latestSafeStartAt: '2026-10-22T12:02:00Z' }),
      task('start-earlier-deadline:item', { finalRank: 14, latestSafeStartAt: '2026-10-22T11:50:00Z' }),
      task('fired:item', { taskState: 'fired', finalRank: 15 }),
      task('cooking:item', { taskState: 'preparing', finalRank: 16 }),
      task('ready:item', { taskState: 'ready', finalRank: 17 }),
    ]);
    const view = buildBoardView({ recommendations, pageSize: 6 });
    expect(view.orders.slice(0, 4).map((order) => order.orderId)).toEqual(['start-later-deadline', 'start-earlier-deadline', 'fired', 'cooking']);
    expect(view.counts).toEqual({ all: 17, start: 3, cooking: 1, waiting: 12, ready: 1 });
    expect(view.attentionCounts.blocked).toBe(12);
  });

  test('honors backend critical and running ranks ahead of older ordinary waiting deadlines', () => {
    const waiting = { capacityState: 'capacity-wait', action: 'wait-capacity', expediter: { signal: 'yellow', phase: 'next' } };
    const recommendations = [
      task('ordinary:item', { ...waiting, finalRank: 3, latestSafeStartAt: '2026-10-22T10:00:00Z' }),
      task('running:item', { ...waiting, finalRank: 2, runningOrder: true, runningOrderReason: 'Customer is already eating.', note: 'No onion', orderNote: 'RUNNING extra portion', latestSafeStartAt: '2026-10-22T12:30:00Z' }),
      task('critical:item', { ...waiting, finalRank: 1, expediter: { signal: 'red', phase: 'blocked' } }),
      task('actionable:item', { finalRank: 100 }),
    ];
    const view = buildBoardView({ recommendations });
    expect(view.orders.map(order => order.orderId)).toEqual(['actionable', 'critical', 'running', 'ordinary']);
    const running = view.orders.find(order => order.orderId === 'running');
    expect(running.runningCount).toBe(1);
    expect(running.tasks[0]).toMatchObject({ runningOrder: true, boardStatus: 'waiting', note: 'No onion', orderNote: 'RUNNING extra portion' });
    expect(getTaskView(running.tasks[0])).toBe('waiting');
    expect(buildBoardView({ recommendations, query: 'extra portion' }).orders[0].orderId).toBe('running');
  });

  test('uses running as a waiting fallback when ranks are absent without displacing starts or cooking', () => {
    const waiting = { capacityState: 'capacity-wait', action: 'wait-capacity', finalRank: undefined, rank: undefined, expediter: { signal: 'yellow', phase: 'next' } };
    const recommendations = [
      task('normal:item', { ...waiting, latestSafeStartAt: '2026-10-22T09:00:00Z' }),
      task('running:item', { ...waiting, runningOrder: true, latestSafeStartAt: '2026-10-22T12:30:00Z' }),
      task('cooking:item', { taskState: 'preparing' }), task('start:item'),
    ];
    expect(buildBoardView({ recommendations }).orders.map(order => order.orderId)).toEqual(['start', 'cooking', 'running', 'normal']);
  });

  test('keeps running metadata through recorded completion and never infers it from notes in the browser', () => {
    const recommendations = [task('running:item', { runningOrder: true, runningOrderReason: 'Additional portion', note: 'No onion', orderNote: 'RUNNING' }), task('ordinary:item', { runningOrder: false, note: 'running' })];
    const result = buildBoardView({ recommendations, taskStates: [{ task_id: 'running:item', task_state: 'ready' }] });
    const finished = result.orders.find(order => order.orderId === 'running');
    expect(finished.runningCount).toBe(1);
    expect(finished.tasks[0]).toMatchObject({ runningOrder: true, taskState: 'ready', boardStatus: 'ready', orderNote: 'RUNNING' });
    expect(result.orders.find(order => order.orderId === 'ordinary').runningCount).toBe(0);
    expect(JSON.stringify(recommendations)).toContain('"runningOrder":false');
  });

  test('one mixed-status order contributes matching rows to each tab without duplicate tickets', () => {
    const recommendations = [
      task('one:start'), task('one:cooking', { taskState: 'preparing' }),
      task('one:wait', { taskState: 'held', expediter: { signal: 'yellow' } }),
      task('one:ready', { taskState: 'ready' }), task('one:expo', { taskState: 'expo' }),
    ];
    const all = buildBoardView({ recommendations });
    expect(all.totalOrders).toBe(1);
    expect(all.orders[0].tasks).toHaveLength(5);
    expect(all.counts).toEqual({ all: 5, start: 1, cooking: 1, waiting: 1, ready: 2 });
    expect(all.orderCounts).toEqual({ all: 1, start: 1, cooking: 1, waiting: 1, ready: 1 });
    for (const view of ['start', 'cooking', 'waiting', 'ready']) {
      const filtered = buildBoardView({ recommendations, view });
      expect(filtered.totalItems).toBe(all.counts[view]);
      expect(filtered.orders[0].tasks.every((entry) => entry.boardStatus === view)).toBe(true);
      expect(filtered.counts).toEqual(all.counts);
    }
  });

  test('preserves complete quantities, portions, styles, notes and modifiers without mutating shared input', () => {
    const recommendations = freeze([
      task('one:half', { quantity: 12, portion: 'Half', style: 'Rawa', note: 'No salt', modifiers: [{ groupName: 'Sauce', options: [{ name: 'Extra garlic', quantity: 2 }] }] }),
      task('one:full', { quantity: 25, portion: 'Full', style: 'Plain', note: 'No chilli' }),
    ]);
    const original = JSON.stringify(recommendations);
    const result = buildBoardView({ recommendations });
    expect(result.totalPortions).toBe(37);
    expect(result.orders[0].tasks).toHaveLength(2);
    expect(result.orders[0].tasks.find((entry) => entry.taskKey === 'one:half')).toMatchObject(recommendations[0]);
    result.orders[0].tasks.find((entry) => entry.taskKey === 'one:half').modifiers[0].options[0].name = 'Edited result';
    expect(JSON.stringify(recommendations)).toBe(original);
  });

  test.each([
    ['Garden table 4', 2], ['order #12', 2], ['garlic', 1], ['No salt', 1], ['Goan Fish', 2], ['Rawa Half', 1], ['table 14', 0],
  ])('searches table, order, dish, kitchen notes, category and modifiers: %s', (query, expected) => {
    const recommendations = [
      task('one:fish', { note: 'No salt', portion: 'Half', style: 'Rawa', modifiers: [{ options: [{ name: 'Extra garlic' }] }] }),
      task('one:prawn', { itemName: 'Prawn Curry' }),
    ];
    expect(buildBoardView({ recommendations, query }).totalItems).toBe(expected);
  });

  test('station and search scope full tab counts before selecting a tab', () => {
    const recommendations = [task('one:fish'), task('two:fish', { taskState: 'preparing' }), task('three:rice', { stationId: 'wok', itemName: 'Rice' })];
    const result = buildBoardView({ recommendations, stationId: 'fish', query: 'fish', view: 'cooking' });
    expect(result.counts).toEqual({ all: 2, start: 1, cooking: 1, waiting: 0, ready: 0 });
    expect(result.totalOrders).toBe(1);
    expect(result.allOrders).toBe(2);
    expect(result.orders[0].orderId).toBe('two');
  });

  test('an approved batch stays an optional separate listing and never consumes its order members', () => {
    const recommendations = [task('one:fish', { quantity: 3 }), task('two:fish', { quantity: 2 })];
    const batch = { batchId: 'approved', action: 'fire-batch', stationId: 'fish', totalQuantity: 5,
      allocations: [{ taskKey: 'one:fish', quantity: 3 }, { taskKey: 'two:fish', quantity: 2 }] };
    const result = buildBoardView({ recommendations, batches: [batch] });
    expect(result.matchingBatches).toHaveLength(1);
    expect(result.totalOrders).toBe(2);
    expect(result.totalPortions).toBe(5);
    expect(result.orders.flatMap((order) => order.tasks).map((entry) => entry.taskKey)).toEqual(['one:fish', 'two:fish']);
    expect(buildBoardView({ recommendations, batches: [batch], taskStates: [{ task_id: 'one:fish', task_state: 'ready' }] }).matchingBatches).toEqual([]);
    expect(buildBoardView({ recommendations, batches: [{ ...batch, allocations: [{ taskKey: 'one:fish', quantity: 1 }] }] }).matchingBatches).toEqual([]);
  });

  test('clamps pages after filtering or workflow completion and supports smaller screens', () => {
    const recommendations = Array.from({ length: 13 }, (_, index) => task(`order-${index}:item`, { orderNumber: index + 1 }));
    expect(buildBoardView({ recommendations, page: 999, pageSize: 6 })).toMatchObject({ page: 3, pageCount: 3 });
    expect(buildBoardView({ recommendations, page: 3, query: 'order 1' })).toMatchObject({ page: 1, totalOrders: 1 });
    const done = recommendations.slice(0, 12).map((entry) => ({ task_id: entry.taskKey, task_state: 'served' }));
    expect(buildBoardView({ recommendations, taskStates: done, page: 3 })).toMatchObject({ page: 1, pageCount: 1, totalOrders: 1 });
    expect(buildBoardView({ recommendations, pageSize: 4 }).orders).toHaveLength(4);
    expect(buildBoardView({ recommendations, pageSize: 2 }).orders).toHaveLength(2);
    expect(buildBoardView({ recommendations: [], page: 5 })).toMatchObject({ page: 1, pageCount: 1, totalOrders: 0, totalItems: 0 });
  });

  test('100 orders and 1,000 items survive every page and filter without losing or doubling portions', () => {
    const states = ['ordered', 'preparing', 'held', 'ready', 'expo'];
    const recommendations = freeze(Array.from({ length: 100 }, (_, order) => Array.from({ length: 10 }, (_, item) => task(`order-${order}:item-${item}`, {
      orderNumber: order + 1, tableNumber: order + 1, finalRank: order * 10 + item + 1,
      quantity: item % 3 + 1, taskState: states[item % states.length], note: item % 2 ? 'No salt' : 'Extra garlic',
    }))).flat());
    const before = JSON.stringify(recommendations);
    for (const view of ['all', 'start', 'cooking', 'waiting', 'ready']) {
      const first = buildBoardView({ recommendations, view, pageSize: 6 });
      const expected = recommendations.filter((entry) => view === 'all' || getTaskView(entry) === view);
      const seen = [];
      for (let page = 1; page <= first.pageCount; page += 1) {
        const result = buildBoardView({ recommendations, view, page, pageSize: 6 });
        expect(result.orders.length).toBeLessThanOrEqual(6);
        seen.push(...result.orders.flatMap((order) => order.tasks));
      }
      expect(new Set(seen.map((entry) => entry.taskKey)).size).toBe(expected.length);
      expect(seen).toHaveLength(expected.length);
      expect(seen.reduce((sum, entry) => sum + entry.quantity, 0)).toBe(expected.reduce((sum, entry) => sum + entry.quantity, 0));
      expect(first.totalOrders).toBe(100);
      expect(first.totalItems).toBe(expected.length);
      expect(first.pageCount).toBe(17);
    }
    const matching = buildBoardView({ recommendations, query: 'garlic' });
    expect(matching.totalItems).toBe(500);
    expect(matching.totalOrders).toBe(100);
    expect(matching.filteredTasks.every((entry) => entry.note === 'Extra garlic')).toBe(true);
    expect(JSON.stringify(recommendations)).toBe(before);
  });

  test('tied tickets remain stable by order ID regardless of input order', () => {
    const recommendations = [task('z-task', { orderId: 'a-order' }), task('a-task', { orderId: 'z-order' })];
    expect(buildBoardView({ recommendations }).orders.map((order) => order.orderId)).toEqual(['a-order', 'z-order']);
    expect(buildBoardView({ recommendations: [...recommendations].reverse() }).orders.map((order) => order.orderId)).toEqual(['a-order', 'z-order']);
  });
});
