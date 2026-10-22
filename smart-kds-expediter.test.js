const { buildKitchenExpediter, earliestSlot } = require('./smart-kds-expediter');
const { buildBatches } = require('./smart-kds-batching');

const now = '2026-10-21T13:00:00.000Z';
const at = (minutes) => new Date(Date.parse(now) + minutes * 60_000).toISOString();
const station = (changes = {}) => ({
  stationId: 'wok',
  stationName: 'Wok',
  enabled: true,
  totalCapacity: 1,
  occupiedCapacity: 0,
  ...changes,
});
const task = (id, changes = {}) => ({
  taskKey: id,
  orderId: id,
  orderNumber: id,
  itemName: 'Chicken rice',
  quantity: 1,
  taskState: 'ordered',
  stationId: 'wok',
  action: 'start-now',
  baseAction: 'start-now',
  capacityState: 'allocated',
  finalRank: 1,
  orderedAt: at(-5),
  latestSafeStartAt: now,
  plannedStartAt: now,
  targetServeAt: at(12),
  latestAcceptableServeAt: at(20),
  prepWindowMinutes: 10,
  profile: { prepTimeEstimate: 8, maxPrepTime: 10, parallelCapacityCost: 1, batchable: false },
  ...changes,
});
const plan = (tasks, changes = {}) =>
  buildKitchenExpediter({ now, recommendations: tasks, stationPlans: [station()], ...changes });

describe('Kitchen expediter', () => {
  test('quiet service gives an actionable green call and preserves saved deadlines and state', () => {
    const original = task('one', { tableArea: 'Garden', tableNumber: 4 });
    const before = JSON.stringify(original);
    const result = plan([original]);
    expect(result.recommendations[0].expediter).toMatchObject({
      signal: 'green',
      label: 'Start now',
      startAt: now,
      readyAt: at(10),
      queueMinutes: 0,
    });
    expect(result.expediter.calls[0].instruction).toContain('Garden table 4');
    expect(result.expediter.load).toMatchObject({
      activeOrders: 1,
      queuedPortions: 1,
      atRiskTasks: 0,
    });
    expect(JSON.stringify(original)).toBe(before);
    expect(result.recommendations[0].taskState).toBe('ordered');
  });

  test('individual and shared batch instructions retain portion, style, add-ons, and chef notes', () => {
    const customization = {
      portion: 'Full',
      style: 'Dry',
      note: 'No onion',
      modifiers: [
        { groupId: 'extras', options: [{ optionId: 'egg', name: 'Extra egg', quantity: 2 }] },
      ],
    };
    const individual = plan([task('custom', customization)]);
    const instruction = individual.expediter.calls[0].instruction;
    for (const detail of ['Portion: Full', 'Style: Dry', '2× Extra egg', 'No onion']) {
      expect(instruction).toContain(detail);
    }
    const profile = {
      prepTimeEstimate: 8,
      maxPrepTime: 10,
      batchable: true,
      batchGroupId: 'rice',
      maxBatchSize: 4,
      optimalBatchSize: 4,
    };
    const tasks = [
      task('batch-a', { ...customization, profile }),
      task('batch-b', { ...customization, profile, finalRank: 2 }),
    ];
    const batches = buildBatches({ now, recommendations: tasks, atomicTasks: true });
    const shared = plan(tasks, { batches }).expediter.calls.find((call) => call.type === 'batch');
    for (const detail of ['Portion: Full', 'Style: Dry', '2× Extra egg', 'No onion']) {
      expect(shared.instruction).toContain(detail);
    }
    expect(shared.instruction.match(/No onion/g)).toHaveLength(1);
  });

  test('100-item rush forecasts serial station load without colliding work or moving deadlines', () => {
    const tasks = Array.from({ length: 100 }, (_, index) =>
      task(`order-${index}`, {
        finalRank: index + 1,
        capacityState: index < 4 ? 'allocated' : 'capacity-wait',
      })
    );
    const result = plan(tasks, { stationPlans: [station({ totalCapacity: 4 })] });
    const recommendations = result.recommendations;
    expect(result.expediter.load).toMatchObject({
      level: 'surge',
      queuedPortions: 100,
      estimatedClearMinutes: 250,
    });
    expect(recommendations.filter((entry) => entry.expediter.signal === 'green')).toHaveLength(4);
    expect(recommendations[4].expediter).toMatchObject({
      signal: 'yellow',
      startAt: at(10),
      readyAt: at(20),
      delayMinutes: 8,
    });
    expect(recommendations.every((entry) => entry.targetServeAt === at(12))).toBe(true);
    expect(result.expediter.alerts.some((entry) => entry.type === 'queue-delay')).toBe(true);
    expect(result.expediter.calls).toHaveLength(100);
  });

  test('missed starts turn red only after the acknowledgement grace, never mark food physically started', () => {
    const result = plan([task('forgotten', { latestSafeStartAt: at(-3) })]);
    expect(result.recommendations[0].expediter).toMatchObject({
      signal: 'red',
      phase: 'missed-start',
    });
    expect(result.expediter.alerts[0]).toMatchObject({
      id: 'task:forgotten:missed-start',
      type: 'missed-start',
      severity: 'critical',
    });
    expect(result.recommendations[0].taskState).toBe('ordered');
  });

  test('fired but unacknowledged work reserves one slot, then raises a distinct red call', () => {
    const result = plan(
      [
        task('fired', { taskState: 'fired', firedAt: at(-3), capacityState: 'fired' }),
        task('next', { finalRank: 2, capacityState: 'capacity-wait' }),
      ],
      { stationPlans: [station({ occupiedCapacity: 1 })] }
    );
    expect(result.recommendations[0].expediter).toMatchObject({
      signal: 'red',
      phase: 'fired-unacknowledged',
    });
    expect(result.recommendations[1].expediter).toMatchObject({
      signal: 'yellow',
      startAt: at(10),
    });
    expect(result.expediter.alerts.some((entry) => entry.type === 'unknown-active')).toBe(false);
    expect(
      plan([task('fired', { taskState: 'fired', firedAt: at(-1) })]).recommendations[0].expediter
        .signal
    ).toBe('green');
  });

  test('acknowledged preparation uses its actual start, counts active batches once, and warns when cooking is late', () => {
    const active = (id) =>
      task(id, {
        taskState: 'preparing',
        preparingAt: at(-5),
        activeBatchId: 'active-batch',
        capacityState: 'in-progress',
      });
    const result = plan(
      [active('a'), active('b'), task('waiting', { finalRank: 2, capacityState: 'capacity-wait' })],
      { stationPlans: [station({ occupiedCapacity: 1 })] }
    );
    expect(result.recommendations[0].expediter).toMatchObject({
      signal: 'neutral',
      readyAt: at(5),
    });
    expect(result.recommendations[2].expediter.startAt).toBe(at(5));
    const late = plan([task('late', { taskState: 'preparing', preparingAt: at(-15) })]);
    expect(late.recommendations[0].expediter).toMatchObject({
      signal: 'red',
      phase: 'cook-overdue',
    });
    expect(Date.parse(late.recommendations[0].expediter.readyAt)).toBeGreaterThan(Date.parse(now));
  });

  test('held and future fish gets an immediate ingredient check without a cooking command or fabricated thaw time', () => {
    const fish = task('fish', {
      itemName: 'Fish fry',
      taskState: 'held',
      pacingState: 'manual-hold',
      latestSafeStartAt: at(30),
      profile: {
        prepTimeEstimate: 18,
        maxPrepTime: 24,
        immediatePreparationAlert: true,
        preparationLeadMinutes: 15,
        preparationAlert:
          'Check chilled/thawed stock now; if frozen begin the kitchen-approved thawing process.',
      },
    });
    const result = plan([fish]);
    expect(result.recommendations[0].expediter).toMatchObject({
      signal: 'yellow',
      phase: 'hold',
      startAt: null,
      readyAt: null,
      prepAlertImmediate: true,
    });
    expect(result.expediter.calls).toHaveLength(1);
    expect(result.expediter.calls[0]).toMatchObject({
      id: 'prep:fish',
      type: 'prep',
      urgent: true,
    });
    expect(result.expediter.calls[0].instruction).toContain('Cooking remains on hold');
    expect(result.expediter.load).toMatchObject({
      queuedPortions: 0,
      heldPortions: 1,
      atRiskTasks: 0,
    });
  });

  test('future work stays yellow until its cooking window and occupies no present slot', () => {
    const future = task('future', {
      action: 'monitor',
      baseAction: 'monitor',
      capacityState: 'unassigned',
      plannedStartAt: at(20),
      latestSafeStartAt: at(20),
      targetServeAt: at(30),
      finalRank: 1,
    });
    const due = task('due', { finalRank: 2 });
    const result = plan([future, due]);
    expect(result.recommendations[0].expediter).toMatchObject({
      signal: 'yellow',
      startAt: at(20),
      readyAt: at(30),
    });
    expect(result.recommendations[1].expediter).toMatchObject({
      signal: 'green',
      startAt: now,
      readyAt: at(10),
    });
  });

  test('unavailable, missing, and undersized stations require expo, with no false ready ETA', () => {
    for (const change of [
      { stationPlans: [station({ enabled: false })] },
      { stationPlans: [] },
      { stationPlans: [station({ totalCapacity: 0 })] },
    ]) {
      const result = plan([task('blocked')], change);
      expect(result.recommendations[0].expediter).toMatchObject({
        signal: 'red',
        startAt: null,
        readyAt: null,
      });
      expect(result.expediter.calls[0].instruction).not.toContain('Start 1');
    }
    const result = plan([task('large', { profile: { parallelCapacityCost: 2 } })]);
    expect(result.recommendations[0].expediter.reason).toContain('exceeds station capacity');
  });

  test('capacity-wait cannot turn green even if an estimate finds a free slot', () => {
    const result = plan([task('capacity-wait', { capacityState: 'capacity-wait' })]);
    expect(result.recommendations[0].expediter.signal).toBe('yellow');
    expect(result.expediter.calls[0].instruction).toContain('expo must confirm');
  });

  test('bulk lines forecast all portions and ask the chef to confirm batches', () => {
    const result = plan([task('bulk', { quantity: 30 })]);
    expect(result.recommendations[0].expediter).toMatchObject({
      readyAt: at(300),
      cookingWaves: 30,
    });
    expect(result.expediter.calls[0].instruction).toContain('30 conservative cooking waves');
    expect(result.expediter.calls[0].instruction).toContain('chef must confirm');
  });

  test('bulk preparation gets an earlier effective deadline while saved service promises remain fixed', () => {
    const original = task('bulk-future', {
      quantity: 30,
      action: 'monitor',
      baseAction: 'monitor',
      latestSafeStartAt: at(20),
      plannedStartAt: at(20),
      targetServeAt: at(30),
    });
    const result = plan([original]);
    expect(result.recommendations[0]).toMatchObject({
      latestSafeStartAt: at(20),
      targetServeAt: at(30),
      bulkLatestSafeStartAt: at(-270),
      effectiveLatestSafeStartAt: at(-270),
    });
    expect(result.recommendations[0].expediter).toMatchObject({
      signal: 'red',
      startAt: now,
      readyAt: at(300),
    });
  });

  test('prepare-next remains yellow before the planned start for food that cannot be held', () => {
    const original = task('next-window', {
      action: 'prepare-next',
      baseAction: 'prepare-next',
      plannedStartAt: at(4),
      latestSafeStartAt: at(4),
      targetServeAt: at(14),
    });
    const result = plan([original]);
    expect(result.recommendations[0].expediter).toMatchObject({
      signal: 'yellow',
      startAt: at(4),
      readyAt: at(14),
    });
    const safeHold = plan([
      { ...original, profile: { ...original.profile, canHoldAfterCooking: true, maxHoldTime: 4 } },
    ]);
    expect(safeHold.recommendations[0].expediter).toMatchObject({
      signal: 'green',
      startAt: now,
      readyAt: at(10),
    });
  });

  test('approved compatible batches use one allocation and one cook call; modifiers never merge implicitly', () => {
    const profile = {
      prepTimeEstimate: 8,
      maxPrepTime: 10,
      parallelCapacityCost: 1,
      batchable: true,
      batchGroupId: 'rice',
      maxBatchSize: 4,
      optimalBatchSize: 4,
    };
    const tasks = [
      task('a', { quantity: 2, profile }),
      task('b', { quantity: 2, profile, finalRank: 2 }),
    ];
    const batches = buildBatches({ now, recommendations: tasks, atomicTasks: true }).map(
      (batch) => ({ ...batch, batchId: 'rice-batch' })
    );
    const result = plan(tasks, { batches });
    expect(result.expediter.calls).toHaveLength(1);
    expect(result.expediter.calls[0]).toMatchObject({
      id: 'batch:rice-batch:start',
      type: 'batch',
      signal: 'green',
      quantity: 4,
      taskKeys: ['a', 'b'],
    });
    expect(result.recommendations.map((entry) => entry.expediter.readyAt)).toEqual([
      at(10),
      at(10),
    ]);
    const changed = plan([tasks[0], { ...tasks[1], note: 'no chilli' }], { batches });
    expect(changed.expediter.calls.filter((call) => call.type === 'batch')).toHaveLength(0);
    expect(changed.recommendations[1].expediter.startAt).toBe(at(10));
  });

  test('served/cancelled/superseded and stale orders have no cooking calls; ready items only go to expo', () => {
    const result = plan(
      [
        task('served', { taskState: 'served' }),
        task('cancelled', { taskState: 'cancelled' }),
        task('superseded', { taskState: 'superseded' }),
        task('stale'),
        task('ready', { taskState: 'ready', targetServeAt: at(-10) }),
      ],
      { staleOrders: [{ id: 'stale', orderNumber: 5 }] }
    );
    expect(result.recommendations).toHaveLength(1);
    expect(result.recommendations[0].expediter).toMatchObject({
      signal: 'neutral',
      label: 'Ready for expo',
      delayMinutes: 0,
    });
    expect(result.expediter.calls).toHaveLength(1);
    expect(result.expediter.calls[0].type).toBe('expo');
    expect(result.expediter.alerts[0].type).toBe('stale-order');
  });

  test('null preparation timestamps do not become epoch dates or a false cooking-overdue alert', () => {
    const result = plan([task('unknown', { taskState: 'preparing', preparingAt: null })]);
    expect(result.recommendations[0].expediter).toMatchObject({
      signal: 'neutral',
      startAt: now,
      readyAt: at(10),
    });
  });

  test('acknowledged cooking in a manual-fire course is active work rather than held portions', () => {
    const result = plan([
      task('manual-cooking', {
        taskState: 'preparing',
        preparingAt: at(-5),
        pacingState: 'manual-hold',
      }),
    ]);
    expect(result.expediter.load).toMatchObject({ activePortions: 1, heldPortions: 0 });
    expect(result.recommendations[0].expediter.label).toBe('Cooking');
  });

  test('unknown occupied slots are retained in estimates, and interval scheduling fits gaps safely', () => {
    const result = plan([task('waiting', { capacityState: 'capacity-wait' })], {
      stationPlans: [station({ occupiedCapacity: 1 })],
    });
    expect(result.recommendations[0].expediter.startAt).toBe(at(15));
    expect(result.expediter.alerts[0].type).toBe('unknown-active');
    expect(earliestSlot([{ start: 20, end: 30, cost: 1 }], 1, 1, 0, 10)).toBe(0);
    expect(earliestSlot([{ start: 20, end: 30, cost: 1 }], 1, 1, 15, 10)).toBe(30);
    expect(earliestSlot([{ start: 0, end: 10, cost: 1 }], 2, 2, 0, 5)).toBe(10);
  });
});
