const { buildBatches } = require('./smart-kds-batching');
const { allocateStationCapacity } = require('./smart-kds-capacity');
const { buildUnifiedRecommendations } = require('./smart-kds-unified');
const { buildKitchenExpediter } = require('./smart-kds-expediter');

const now = '2026-10-23T12:00:00.000Z';
const at = (minutes) => new Date(Date.parse(now) + minutes * 60_000).toISOString();
const profile = {
  batchable: true,
  batchGroupId: 'soup',
  maxBatchSize: 8,
  optimalBatchSize: 8,
  batchWindowSeconds: 300,
  prepTimeEstimate: 8,
  maxPrepTime: 10,
  parallelCapacityCost: 1,
};
const task = (id, changes = {}) => ({
  taskKey: id,
  orderId: id,
  orderNumber: id,
  itemName: 'Veg manchow soup',
  category: 'Soup',
  quantity: 1,
  stationId: 'wok',
  tableArea: 'Garden',
  tableNumber: id,
  mode: 'table',
  course: 'soup',
  courseMode: 'as_ready',
  pacingState: 'current-course',
  taskState: 'ordered',
  action: 'monitor',
  rank: 1,
  orderedAt: now,
  latestSafeStartAt: at(10),
  effectiveLatestSafeStartAt: at(10),
  targetServeAt: at(20),
  plannedStartAt: at(10),
  prepWindowMinutes: 10,
  profile,
  ...changes,
});
const build = (tasks, minutes = 0) =>
  buildBatches({ now: at(minutes), recommendations: tasks, atomicTasks: true });

describe('Cross-table peak batching', () => {
  test('a known quiet kitchen cooks an approved singleton immediately instead of collecting unnecessarily', () => {
    const batches = build([task('quiet', { learning: { loadBand: 'quiet' } })]);
    expect(batches[0]).toMatchObject({
      action: 'fire-batch',
      plannedFireAt: now,
      reason: 'Quiet kitchen; no need to wait for more portions',
    });
  });

  test('busy or surge service retains the bounded collection window, while missing load metadata keeps existing semantics', () => {
    for (const loadBand of ['busy', 'surge', undefined]) {
      const batches = build([task('collect', { learning: loadBand ? { loadBand } : undefined })]);
      expect(batches[0]).toMatchObject({
        action: 'wait-for-batch',
        plannedFireAt: at(5),
        holdUntilAt: at(5),
      });
      expect(
        build([task('collect', { learning: loadBand ? { loadBand } : undefined })], 5)[0].action
      ).toBe('fire-batch');
    }
  });

  test('quiet service still respects serve-together timing and explicit course holds', () => {
    const item = task('quiet-sync', {
      learning: { loadBand: 'quiet' },
      courseMode: 'serve_together',
      pacingState: 'sync-watch',
      targetServeAt: at(20),
      profile: { ...profile, canHoldAfterCooking: false },
    });
    expect(build([item])[0]).toMatchObject({
      action: 'wait-for-batch',
      earliestStartAt: at(10),
      plannedFireAt: at(10),
    });
    expect(build([{ ...item, pacingState: 'hold-for-course' }])).toEqual([]);
  });

  test('two soups collect for five minutes from the oldest receipt, preserving every table allocation', () => {
    const tasks = [task('1'), task('2', { orderedAt: at(2), rank: 2 })];
    const batches = build(tasks, 2);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toMatchObject({
      action: 'wait-for-batch',
      totalQuantity: 2,
      tableCount: 2,
      collectionStartedAt: now,
      windowClosesAt: at(5),
      holdUntilAt: at(5),
      plannedFireAt: at(5),
    });
    expect(batches[0].allocations).toEqual([
      expect.objectContaining({
        tableArea: 'Garden',
        tableNumber: '1',
        course: 'soup',
        courseMode: 'as_ready',
        targetServeAt: at(20),
      }),
      expect.objectContaining({ tableNumber: '2' }),
    ]);
    expect(build(tasks, 5)[0].action).toBe('fire-batch');
    expect(build(tasks, 6)[0].action).toBe('fire-batch');
  });

  test('a new arrival cannot restart an older collection clock, even when it has a higher rank', () => {
    const tasks = [
      task('old', { rank: 20 }),
      task('new', { rank: 1, orderedAt: at(4), latestSafeStartAt: at(9) }),
    ];
    expect(build(tasks, 4)[0]).toMatchObject({
      collectionStartedAt: now,
      windowClosesAt: at(5),
      holdUntilAt: at(5),
    });
    expect(build(tasks, 6)[0].action).toBe('fire-batch');
  });

  test('explicit six-minute and shorter chef windows remain explicit', () => {
    for (const [seconds, closes] of [
      [360, 6],
      [60, 1],
    ]) {
      const tasks = [task('one', { profile: { ...profile, batchWindowSeconds: seconds } })];
      expect(build(tasks)[0].holdUntilAt).toBe(at(closes));
      expect(build(tasks, closes)[0].action).toBe('fire-batch');
    }
  });

  test('an earlier effective deadline closes collection before the configured window', () => {
    const tasks = [task('1', { effectiveLatestSafeStartAt: at(2) }), task('2', { rank: 2 })];
    expect(build(tasks)[0]).toMatchObject({
      holdUntilAt: at(2),
      latestSafeStartAt: at(2),
      plannedFireAt: at(2),
    });
    expect(build(tasks, 2)[0].action).toBe('fire-batch');
  });

  test('a singleton holds without reserving capacity, then becomes an actionable one-portion batch', () => {
    const item = task('single');
    const batches = build([item]);
    const stations = [
      { station_id: 'wok', station_name: 'Wok', enabled: true, max_concurrent_tasks: 1 },
    ];
    const capacity = allocateStationCapacity({ recommendations: [item], batches, stations });
    expect(capacity.stationPlans[0]).toMatchObject({ usedCapacity: 0, remainingCapacity: 1 });
    const unified = buildUnifiedRecommendations({
      fairness: { recommendations: [item] },
      capacity,
    });
    expect(unified.recommendations[0]).toMatchObject({
      action: 'wait-for-batch',
      capacityState: 'batch-window-wait',
      stationId: 'wok',
      batchHoldUntilAt: at(5),
    });
    const forecast = buildKitchenExpediter({
      now,
      recommendations: unified.recommendations,
      batches,
      stationPlans: capacity.stationPlans,
    });
    expect(forecast.recommendations[0].expediter).toMatchObject({
      signal: 'yellow',
      startAt: at(5),
      readyAt: at(15),
    });
    const closed = build([item], 5);
    expect(closed[0]).toMatchObject({ action: 'fire-batch', totalQuantity: 1 });
    expect(
      allocateStationCapacity({ recommendations: [item], batches: closed, stations }).allocated
    ).toHaveLength(1);
  });

  test('rice, biryani, and different soup recipes cannot merge through a shared batch group', () => {
    const tasks = [
      task('rice', { itemName: 'Veg fried rice', category: 'Rice' }),
      task('biryani', { itemName: 'Veg biryani', category: 'Rice' }),
      task('soup'),
      task('chicken-soup', { itemName: 'Chicken manchow soup' }),
    ];
    expect(build(tasks)).toHaveLength(4);
    expect(build(tasks).every((batch) => batch.allocations.length === 1)).toBe(true);
  });

  test('chef notes, order-round notes, portions, styles, and add-ons preserve recipe compatibility', () => {
    const differences = [
      { note: 'No onion' },
      { orderNote: 'No onion this round' },
      { portion: 'Half' },
      { style: 'Dry' },
      { modifiers: [{ groupId: 'extra', options: [{ optionId: 'egg', name: 'Egg' }] }] },
    ];
    for (const difference of differences) {
      expect(build([task('plain'), task('changed', difference)])).toHaveLength(2);
    }
  });

  test('starter-dependent courses, manual holds, and already cooking food cannot enter a new batch', () => {
    const excluded = [
      { pacingState: 'hold-for-course' },
      { pacingState: 'manual-hold' },
      { taskState: 'held' },
      { taskState: 'preparing' },
      { taskState: 'fired' },
      { taskState: 'ready' },
      { taskState: 'served' },
    ];
    const tasks = [
      task('new'),
      ...excluded.map((change, index) => task(`excluded-${index}`, change)),
    ];
    expect(
      build(tasks).flatMap((batch) => batch.allocations.map((allocation) => allocation.taskKey))
    ).toEqual(['new']);
  });

  test('a later serve-together table never delays an older soup or forces it to finish before its permitted holding window', () => {
    const old = task('old', {
      latestSafeStartAt: at(5),
      effectiveLatestSafeStartAt: at(5),
      targetServeAt: at(15),
    });
    const later = task('later', {
      courseMode: 'serve_together',
      pacingState: 'sync-watch',
      plannedStartAt: at(20),
      latestSafeStartAt: at(20),
      effectiveLatestSafeStartAt: at(20),
      targetServeAt: at(30),
    });
    const batches = build([old, later]);
    expect(batches).toHaveLength(2);
    expect(batches.find((batch) => batch.allocations[0].taskKey === 'old')).toMatchObject({
      plannedFireAt: at(5),
      holdUntilAt: at(5),
    });
    expect(batches.find((batch) => batch.allocations[0].taskKey === 'later')).toMatchObject({
      earliestStartAt: at(20),
      plannedFireAt: at(20),
    });
  });

  test('aligned serve-together tables may share a batch, but collection closure does not force early cooking', () => {
    const together = (id) =>
      task(id, {
        courseMode: 'serve_together',
        pacingState: 'sync-watch',
        targetServeAt: at(20),
        plannedStartAt: at(10),
        profile: { ...profile, optimalBatchSize: 2 },
      });
    const batches = build([together('1'), together('2')]);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toMatchObject({
      action: 'wait-for-batch',
      holdUntilAt: at(5),
      earliestStartAt: at(10),
      plannedFireAt: at(10),
    });
    expect(build([together('1'), together('2')], 6)[0].action).toBe('wait-for-batch');
    expect(build([together('1'), together('2')], 10)[0].action).toBe('fire-batch');
    const capacity = allocateStationCapacity({
      recommendations: [together('1'), together('2')],
      batches,
      stations: [{ station_id: 'wok', max_concurrent_tasks: 1 }],
    });
    const unified = buildUnifiedRecommendations({
      fairness: { recommendations: [together('1'), together('2')] },
      capacity,
    });
    expect(
      buildKitchenExpediter({
        now,
        recommendations: unified.recommendations,
        batches,
        stationPlans: capacity.stationPlans,
      }).recommendations.every((item) => item.expediter.startAt === at(10))
    ).toBe(true);
  });

  test('only chef-approved holding time can pull a synchronized batch earlier', () => {
    const together = (id, hold) =>
      task(id, {
        courseMode: 'serve_together',
        pacingState: 'sync-watch',
        targetServeAt: at(20),
        profile: { ...profile, optimalBatchSize: 2, canHoldAfterCooking: hold, maxHoldTime: 5 },
      });
    expect(build([together('1', false), together('2', false)])[0].earliestStartAt).toBe(at(10));
    expect(build([together('1', true), together('2', true)])[0].earliestStartAt).toBe(at(5));
  });

  test('approved maximum and optimal quantities fire immediately without splitting atomic production records', () => {
    const tasks = [
      task('1', { quantity: 3, profile: { ...profile, maxBatchSize: 4, optimalBatchSize: 4 } }),
      task('2', { quantity: 3, profile: { ...profile, maxBatchSize: 4, optimalBatchSize: 4 } }),
      task('3', { quantity: 1, profile: { ...profile, maxBatchSize: 4, optimalBatchSize: 4 } }),
    ];
    const batches = build(tasks);
    expect(batches.map((batch) => batch.totalQuantity)).toEqual([4, 3]);
    expect(batches[0].action).toBe('fire-batch');
    expect(
      batches.flatMap((batch) => batch.allocations.map((allocation) => allocation.quantity)).sort()
    ).toEqual([1, 3, 3]);
    expect(build([task('oversized', { quantity: 9 })])).toEqual([]);
  });

  test.each([
    { note: 'running' },
    { manualOverride: { action: 'rush' } },
    { state: 'critical', priorityClass: 'critical' },
  ])('priority instructions never incur an extra collection delay: %j', (change) => {
    expect(build([task('urgent', change)])[0]).toMatchObject({
      action: 'fire-batch',
      plannedFireAt: now,
    });
  });

  test('running priority never overrides a serve-together quality floor, and contradictory deadlines require expo', () => {
    const item = task('running-sync', {
      note: 'RUNNING',
      courseMode: 'serve_together',
      pacingState: 'sync-watch',
      targetServeAt: at(20),
      plannedStartAt: at(10),
      profile: { ...profile, canHoldAfterCooking: false },
    });
    expect(build([item])[0]).toMatchObject({
      action: 'wait-for-batch',
      earliestStartAt: at(10),
      plannedFireAt: at(10),
      runningOrder: true,
    });
    const conflict = {
      ...item,
      latestSafeStartAt: at(-2),
      effectiveLatestSafeStartAt: at(-2),
      priorityClass: 'critical',
    };
    const batches = build([conflict]);
    expect(batches[0]).toMatchObject({ action: 'wait-for-batch', timingConflict: true });
    const capacity = allocateStationCapacity({
      recommendations: [conflict],
      batches,
      stations: [{ station_id: 'wok', max_concurrent_tasks: 1 }],
    });
    const unified = buildUnifiedRecommendations({
      fairness: { recommendations: [conflict] },
      capacity,
    });
    const forecast = buildKitchenExpediter({
      now,
      recommendations: unified.recommendations,
      batches,
      stationPlans: capacity.stationPlans,
    });
    expect(forecast.recommendations[0].expediter).toMatchObject({
      signal: 'red',
      instruction: expect.stringContaining('do not cook the batch early'),
    });
    const unbatched = {
      ...item,
      baseAction: 'start-now',
      action: 'start-now',
      capacityState: 'allocated',
      profile: { ...item.profile, batchable: false },
    };
    expect(
      buildKitchenExpediter({
        now,
        recommendations: [unbatched],
        stationPlans: [{ stationId: 'wok', totalCapacity: 1 }],
      }).recommendations[0].expediter
    ).toMatchObject({ signal: 'yellow', startAt: at(10) });
  });

  test('profiles remain opt-in and new arrivals cannot append to cooking allocations', () => {
    expect(build([task('unapproved', { profile: { ...profile, batchable: false } })])).toEqual([]);
    const first = build([task('first')], 5)[0];
    expect(first.totalQuantity).toBe(1);
    const next = build(
      [task('first', { taskState: 'preparing' }), task('later', { orderedAt: at(6) })],
      6
    );
    expect(next).toHaveLength(1);
    expect(next[0].allocations.map((allocation) => allocation.taskKey)).toEqual(['later']);
    expect(next[0].collectionStartedAt).toBe(at(6));
  });

  test('individual faster calibration cannot shorten an untrained shared batch or its active reservation', () => {
    const tasks = [
      task('1', {
        profile: { ...profile, optimalBatchSize: 2 },
        learning: { applied: true, estimateMinutes: 4 },
      }),
      task('2', {
        profile: { ...profile, optimalBatchSize: 2 },
        learning: { applied: true, estimateMinutes: 6 },
      }),
    ];
    const batches = build(tasks);
    const stations = [{ station_id: 'wok', max_concurrent_tasks: 1 }];
    const capacity = allocateStationCapacity({ recommendations: tasks, batches, stations });
    const unified = buildUnifiedRecommendations({ fairness: { recommendations: tasks }, capacity });
    const forecast = buildKitchenExpediter({
      now,
      recommendations: unified.recommendations,
      batches,
      stationPlans: capacity.stationPlans,
    });
    expect(forecast.recommendations.every((item) => item.expediter.readyAt === at(10))).toBe(true);
    const active = tasks.map((item) => ({
      ...item,
      taskState: 'preparing',
      preparingAt: now,
      activeBatchId: 'shared',
    }));
    const cooking = buildKitchenExpediter({
      now: at(6),
      recommendations: active,
      stationPlans: [{ stationId: 'wok', totalCapacity: 1, occupiedCapacity: 1 }],
    });
    expect(
      cooking.recommendations.every(
        (item) => item.expediter.readyAt === at(10) && item.expediter.signal !== 'red'
      )
    ).toBe(true);
    const slow = tasks.map((item) => ({
      ...item,
      learning: { applied: true, estimateMinutes: 15 },
    }));
    const slowBatches = build(slow);
    const slowCapacity = allocateStationCapacity({
      recommendations: slow,
      batches: slowBatches,
      stations,
    });
    const slowUnified = buildUnifiedRecommendations({
      fairness: { recommendations: slow },
      capacity: slowCapacity,
    });
    expect(
      buildKitchenExpediter({
        now,
        recommendations: slowUnified.recommendations,
        batches: slowBatches,
        stationPlans: slowCapacity.stationPlans,
      }).recommendations.every((item) => item.expediter.readyAt === at(15))
    ).toBe(true);
  });
});
