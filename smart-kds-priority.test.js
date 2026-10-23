const {
  hasRunningNote,
  runningOrderMetadata,
  isRunningOrderEligible,
} = require('./smart-kds-priority');
const { scheduleKitchen } = require('./smart-kds-scheduler');
const { applyFairness } = require('./smart-kds-fairness');
const { applyServiceRiskPriority } = require('./smart-kds-service-risk');
const { buildBatches, modifierFingerprint } = require('./smart-kds-batching');
const { allocateStationCapacity } = require('./smart-kds-capacity');
const { buildUnifiedRecommendations } = require('./smart-kds-unified');
const { buildKitchenExpediter } = require('./smart-kds-expediter');

const now = '2026-10-23T12:00:00.000Z';
const at = (minutes) => new Date(Date.parse(now) + minutes * 60_000).toISOString();
const task = (key, changes = {}) => ({
  taskKey: key,
  orderId: key,
  orderNumber: key,
  itemName: 'Veg fried rice',
  quantity: 1,
  stationId: 'wok',
  taskState: 'ordered',
  pacingState: 'current-course',
  orderedAt: at(-5),
  latestSafeStartAt: at(-1),
  plannedStartAt: at(-1),
  targetServeAt: at(9),
  latestAcceptableServeAt: at(20),
  prepWindowMinutes: 10,
  profile: { prepTimeEstimate: 8, maxPrepTime: 10, parallelCapacityCost: 1 },
  ...changes,
});

function plan(tasks, { occupied = 0, risks = [] } = {}) {
  const scheduled = scheduleKitchen({ tasks, now });
  const fairness = applyFairness({ recommendations: scheduled, now });
  const recommendations = applyServiceRiskPriority({
    recommendations: fairness.recommendations,
    risks,
  });
  const batches = buildBatches({ recommendations, now, atomicTasks: true });
  const capacity = allocateStationCapacity({
    recommendations,
    batches,
    stations: [
      {
        station_id: 'wok',
        station_name: 'Wok',
        enabled: true,
        max_concurrent_tasks: 1,
        occupied_capacity: occupied,
      },
    ],
  });
  const unified = buildUnifiedRecommendations({
    fairness: { ...fairness, recommendations },
    capacity,
    serviceRisk: { risks },
  });
  return {
    scheduled,
    fairness,
    capacity,
    batches,
    unified,
    ...buildKitchenExpediter({
      now,
      recommendations: unified.recommendations,
      stationPlans: capacity.stationPlans,
      batches,
    }),
  };
}

describe('Running additional-portion priority', () => {
  test.each([
    'running',
    'RUNNING',
    'No onion, Running!',
    '(running) additional portion',
    'running - table already eating',
  ])('recognizes standalone chef note %s', (note) => {
    expect(hasRunningNote(note)).toBe(true);
  });

  test.each([
    'overrunning',
    'runningman',
    'prerunning',
    'running_order',
    'running123',
    'αrunning',
    'run',
    '',
  ])('does not recognize a partial word %s', (note) => {
    expect(hasRunningNote(note)).toBe(false);
  });

  test('reads item and order-round notes without treating a dish name as an instruction', () => {
    expect(
      runningOrderMetadata({ itemName: 'Running chicken', category: 'Running specials' })
    ).toEqual({ runningOrder: false, runningOrderReason: '' });
    expect(runningOrderMetadata({ orderNote: 'RUNNING, serve hot' })).toMatchObject({
      runningOrder: true,
      runningOrderReason: expect.stringContaining('additional portion'),
    });
  });

  test('a new running top-up takes the next free slot before ordinary work across every re-sort', () => {
    const normal = task('normal', { orderedAt: at(-20) });
    const topUp = task('top-up', {
      note: 'RUNNING',
      orderedAt: now,
      latestSafeStartAt: at(15),
      plannedStartAt: at(15),
      targetServeAt: at(25),
    });
    const result = plan([normal, topUp], {
      risks: [
        { id: 'normal', riskType: 'service-gap-risk', severity: 'watch', reason: 'Service gap' },
      ],
    });
    for (const recommendations of [
      result.scheduled,
      result.fairness.recommendations,
      result.unified.recommendations,
      result.recommendations,
    ]) {
      expect(recommendations.map((item) => item.taskKey)).toEqual(['top-up', 'normal']);
    }
    expect(result.capacity.allocated[0].workKey).toBe('top-up');
    expect(result.recommendations[0]).toMatchObject({
      runningOrder: true,
      latestSafeStartAt: at(15),
      targetServeAt: at(25),
      capacityState: 'allocated',
      baseAction: 'start-now',
    });
    expect(result.recommendations[0].expediter).toMatchObject({
      signal: 'green',
      startAt: now,
      readyAt: at(10),
    });
    expect(result.recommendations[1].expediter.startAt).toBe(at(10));
    expect(result.expediter.calls[0]).toMatchObject({
      runningOrder: true,
      instruction: expect.stringContaining('Running order / additional portion, priority:'),
    });
  });

  test('critical overdue work and an explicit rush stay ahead of a running top-up', () => {
    const critical = task('critical', { latestAcceptableServeAt: at(-1), targetServeAt: at(-10) });
    const rush = task('rush', {
      manualOverride: { action: 'rush' },
      latestSafeStartAt: at(10),
      targetServeAt: at(20),
    });
    const running = task('running', { note: 'running' });
    const result = plan([running, rush, critical]);
    expect(result.recommendations.map((item) => item.taskKey)).toEqual([
      'critical',
      'rush',
      'running',
    ]);
    expect(result.capacity.allocated[0].workKey).toBe('critical');
    expect(result.recommendations.map((item) => item.expediter.startAt)).toEqual([
      now,
      at(10),
      at(20),
    ]);
  });

  test('critical recorded service risk is protected while a normal risk cannot erase the top-up priority', () => {
    const result = plan([task('running', { note: 'running' }), task('service-critical')], {
      risks: [
        {
          id: 'service-critical',
          riskType: 'first-food-risk',
          severity: 'critical',
          reason: 'No food served',
        },
      ],
    });
    expect(result.recommendations[0].taskKey).toBe('service-critical');
    expect(result.capacity.allocated[0].workKey).toBe('service-critical');
  });

  test.each([
    { taskState: 'held' },
    { pacingState: 'manual-hold' },
    { pacingState: 'hold-for-course' },
    { manualOverride: { action: 'hold' } },
    { manualOverride: { action: 'defer' } },
    { taskState: 'fired' },
    { taskState: 'preparing' },
    { taskState: 'ready' },
    { taskState: 'expo' },
    { taskState: 'served' },
    { taskState: 'cancelled' },
    { taskState: 'superseded' },
  ])('never releases or re-fires a blocked or acknowledged state: %j', (changes) => {
    const item = task('blocked', { note: 'running', ...changes });
    expect(isRunningOrderEligible(item)).toBe(false);
    expect(scheduleKitchen({ tasks: [item], now })).toEqual([]);
  });

  test('running waits for occupied capacity and clearly asks expo for the next slot', () => {
    const result = plan(
      [
        task('normal'),
        task('running', {
          orderNote: 'Running top-up',
          latestSafeStartAt: at(10),
          targetServeAt: at(20),
        }),
      ],
      { occupied: 1 }
    );
    const running = result.recommendations[0];
    expect(result.capacity.allocated).toHaveLength(0);
    expect(running).toMatchObject({ taskKey: 'running', capacityState: 'capacity-wait' });
    expect(running.expediter.signal).toBe('yellow');
    expect(Date.parse(running.expediter.startAt)).toBeGreaterThan(Date.parse(now));
    expect(running.expediter.instruction).toContain('next eligible station slot');
    expect(running.expediter.instruction).toContain('Round note: Running top-up');
    expect(result.recommendations[1].expediter.startAt > running.expediter.startAt).toBe(true);
  });

  test('a compatible running batch does not wait for an optimal size and keeps its earliest actual deadline', () => {
    const profile = {
      batchable: true,
      batchGroupId: 'rice',
      maxBatchSize: 8,
      optimalBatchSize: 8,
      batchWindowSeconds: 180,
      prepTimeEstimate: 8,
      maxPrepTime: 10,
    };
    const recommendations = [
      task('normal', {
        profile,
        orderNote: 'running',
        latestSafeStartAt: at(2),
        targetServeAt: at(12),
        rank: 10,
      }),
      task('top-up', {
        profile,
        orderNote: 'running',
        latestSafeStartAt: at(15),
        targetServeAt: at(25),
        rank: 1,
      }),
    ];
    const batches = buildBatches({ recommendations, now, atomicTasks: true });
    expect(batches).toHaveLength(1);
    expect(batches[0]).toMatchObject({
      action: 'fire-batch',
      runningOrder: true,
      totalQuantity: 2,
      latestSafeStartAt: at(2),
    });
    expect(batches[0].reason).toContain('do not wait');
    expect(modifierFingerprint({ orderNote: 'Running, no onion' })).not.toBe(
      modifierFingerprint({ orderNote: 'Running, extra onion' })
    );
  });
});
