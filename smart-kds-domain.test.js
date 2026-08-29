const {
  COURSE_TYPES,
  TASK_STATES,
  defaultSmartKdsConfig,
  normalizeSmartKdsConfig,
  smartKdsMenuItemKey,
  inferDefaultCourse,
  defaultMenuProductionProfile,
  normalizeMenuProductionProfile,
} = require('./smart-kds-domain');
const { calculateProductionTiming, calculateTargetServeAt } = require('./smart-kds-timing');
const { scheduleKitchen } = require('./smart-kds-scheduler');
const { buildBatches } = require('./smart-kds-batching');
const { allocateStationCapacity } = require('./smart-kds-capacity');
const { buildCoursePacing, buildCoursePacingPreview } = require('./smart-kds-pacing');
const { applyFairness } = require('./smart-kds-fairness');
const { buildUnifiedRecommendations } = require('./smart-kds-unified');
const { evaluateServiceRisk, applyServiceRiskPriority } = require('./smart-kds-service-risk');

describe('Smart KDS Phase 1 configuration', () => {
  test('has deterministic safe defaults', () => {
    const config = defaultSmartKdsConfig();
    expect(config.enabled).toBe(false);
    expect(config.mode).toBe('shadow');
    expect(config.courseOrder).toEqual(COURSE_TYPES);
    expect(config.batching.defaultMaxBatchSize).toBe(8);
  });

  test('defines every persisted kitchen task state and accepts a complete custom configuration', () => {
    expect(TASK_STATES).toEqual(['ordered', 'held', 'eligible', 'scheduled', 'fired', 'preparing', 'ready', 'expo', 'served', 'cancelled', 'superseded']);
    const config = normalizeSmartKdsConfig({
      mode: 'manual', courseOrder: ['main', 'starter', 'soup'],
      batching: { defaultWindowSeconds: 90, defaultMaxBatchSize: 12 },
      riskThresholds: { watchMinutes: 7, startSoonMinutes: 2, criticalOverdueMinutes: 14 },
    });
    expect(config).toMatchObject({ mode: 'manual', courseOrder: ['main', 'starter', 'soup', 'drink', 'side', 'dessert', 'other'], batching: { defaultWindowSeconds: 90, defaultMaxBatchSize: 12 }, riskThresholds: { watchMinutes: 7, startSoonMinutes: 2, criticalOverdueMinutes: 14 } });
  });

  test('keeps Phase 1 automation disabled and bounds invalid configuration', () => {
    const config = normalizeSmartKdsConfig({
      enabled: true,
      mode: 'anything-else',
      courseOrder: ['main', 'drink', 'main'],
      courseDefaults: { main: { targetMin: 40, targetMax: 20, spacingAfterMin: 999 } },
      timing: { platingMinutes: -5 },
    });
    expect(config.enabled).toBe(false);
    expect(config.mode).toBe('shadow');
    expect(config.courseDefaults.main).toEqual({ targetMin: 40, targetMax: 40, spacingAfterMin: 120 });
    expect(config.timing.platingMinutes).toBe(0);
    expect(config.courseOrder).toEqual(['main', 'drink', 'soup', 'starter', 'side', 'dessert', 'other']);
  });

  test('stores an explicit normal or Smart kitchen workspace without enabling automation', () => {
    expect(normalizeSmartKdsConfig({ displayMode: 'smart', enabled: true })).toMatchObject({ displayMode: 'smart', enabled: false });
    expect(normalizeSmartKdsConfig({ displayMode: 'anything-else' }).displayMode).toBe('normal');
  });

  test('creates a stable production-profile key and deterministic course suggestion', () => {
    expect(smartKdsMenuItemKey('food', ' Soups ', 'Chicken Manchow Soup')).toBe(
      'food::soups::chicken manchow soup'
    );
    expect(inferDefaultCourse('Soups', 'Chicken Manchow Soup')).toBe('soup');
    expect(inferDefaultCourse('Bar Menu', 'Fresh Lime Soda', 'bar')).toBe('drink');
  });

  test('gives every new menu item a complete deterministic production profile', () => {
    const config = defaultSmartKdsConfig();
    const profile = defaultMenuProductionProfile(
      { itemKey: smartKdsMenuItemKey('food', 'Soups', 'Chicken Manchow Soup'), menuType: 'food', category: 'Soups', name: 'Chicken Manchow Soup' },
      config
    );
    expect(profile).toMatchObject({
      course: 'soup', stationId: '', prepTimeEstimate: 12, minPrepTime: 9,
      maxPrepTime: 16, platingTime: 2, handoffBuffer: 2, batchable: false,
      maxBatchSize: 8, optimalBatchSize: 8, batchWindowSeconds: 180,
      parallelCapacityCost: 1, longPrepItem: false, requiresPreviousCourse: false,
      canPrePrep: false, canHoldAfterCooking: false, maxHoldTime: 0, priorityModifier: 0,
    });
  });

  test('normalizes profile limits without enabling any scheduling action', () => {
    const profile = normalizeMenuProductionProfile(
      {
        course: 'main', prepTimeEstimate: 20, minPrepTime: 30, maxPrepTime: 10,
        batchable: true, maxBatchSize: 4, optimalBatchSize: 9, batchWindowSeconds: 100,
        canHoldAfterCooking: false, maxHoldTime: 20, priorityModifier: 999,
      },
      { itemKey: 'food::mains::test', name: 'Test', category: 'Mains', menuType: 'food' },
      defaultSmartKdsConfig()
    );
    expect(profile.minPrepTime).toBe(20);
    expect(profile.maxPrepTime).toBe(20);
    expect(profile.optimalBatchSize).toBe(4);
    expect(profile.maxHoldTime).toBe(0);
    expect(profile.priorityModifier).toBe(100);
  });

  test('stores bounded dish and station target adjustments for deterministic Phase 3 timing', () => {
    const config = normalizeSmartKdsConfig({
      timing: { stationTargetAdjustments: { wok: -4, expo: 999 } },
    });
    const profile = normalizeMenuProductionProfile(
      { targetAdjustmentMinutes: -99 },
      { itemKey: 'food::mains::rice', name: 'Fried Rice', category: 'Mains', menuType: 'food' },
      config
    );
    expect(config.timing.stationTargetAdjustments).toEqual({ wok: -4, expo: 60 });
    expect(profile.targetAdjustmentMinutes).toBe(-60);
    const timing = calculateProductionTiming({
      orderedAt: '2026-08-27T12:00:00.000Z', mode: 'table', course: 'main', presentCourses: ['main'],
      profile: { prepTimeEstimate: 10, maxPrepTime: 10, platingTime: 0, handoffBuffer: 0 },
      targetAdjustmentMinutes: -6, config, now: '2026-08-27T12:00:00.000Z',
    });
    expect(timing).toMatchObject({
      targetServeAt: '2026-08-27T12:22:00.000Z',
      latestAcceptableServeAt: '2026-08-27T12:32:00.000Z',
      latestSafeStartAt: '2026-08-27T12:12:00.000Z',
    });
  });

  test('calculates a dine-in target and latest safe start deterministically', () => {
    const config = defaultSmartKdsConfig();
    const target = calculateTargetServeAt({
      orderedAt: '2026-08-27T12:00:00.000Z', mode: 'table', course: 'starter', presentCourses: ['soup', 'starter'], config,
    });
    expect(target.toISOString()).toBe('2026-08-27T12:18:00.000Z');
    expect(calculateProductionTiming({
      orderedAt: '2026-08-27T12:00:00.000Z', mode: 'table', course: 'starter', presentCourses: ['soup', 'starter'],
      profile: { prepTimeEstimate: 12, platingTime: 2, handoffBuffer: 2 }, config, now: '2026-08-27T12:05:00.000Z',
    })).toMatchObject({ latestSafeStartAt: '2026-08-27T12:02:00.000Z', state: 'start-now', reason: 'Latest safe start time reached' });
  });

  test('uses the parcel target rather than dine-in course pacing', () => {
    const timing = calculateProductionTiming({
      orderedAt: '2026-08-27T12:00:00.000Z', mode: 'parcel', course: 'main', profile: { prepTimeEstimate: 10, platingTime: 2, handoffBuffer: 2 },
      config: defaultSmartKdsConfig(), now: '2026-08-27T12:09:00.000Z',
    });
    expect(timing.targetServeAt).toBe('2026-08-27T12:25:00.000Z');
    expect(timing.latestSafeStartAt).toBe('2026-08-27T12:11:00.000Z');
    expect(timing.state).toBe('start-soon');
  });

  test('keeps missing timing configuration on safe defaults', () => {
    const timing = calculateProductionTiming({
      orderedAt: '2026-08-27T12:00:00.000Z', mode: 'parcel', course: 'main',
      profile: { prepTimeEstimate: 10 }, config: { timing: { parcelDefaultTargetMinutes: 30 } }, now: '2026-08-27T12:00:00.000Z',
    });
    expect(timing.targetServeAt).toBe('2026-08-27T12:30:00.000Z');
    expect(timing.prepWindowMinutes).toBe(14);
  });

  test('uses a saved per-order course when calculating timing', () => {
    const config = defaultSmartKdsConfig();
    const profileDefault = calculateProductionTiming({
      orderedAt: '2026-08-27T12:00:00.000Z', mode: 'table', course: 'main', presentCourses: ['main'],
      profile: { prepTimeEstimate: 8, platingTime: 0, handoffBuffer: 0 }, config, now: '2026-08-27T12:00:00.000Z',
    });
    const overridden = calculateProductionTiming({
      orderedAt: '2026-08-27T12:00:00.000Z', mode: 'table', course: 'starter', presentCourses: ['starter'],
      profile: { prepTimeEstimate: 8, platingTime: 0, handoffBuffer: 0 }, config, now: '2026-08-27T12:00:00.000Z',
    });
    expect(overridden.targetServeAt).toBe('2026-08-27T12:15:00.000Z');
    expect(profileDefault.targetServeAt).toBe('2026-08-27T12:28:00.000Z');
  });

  test('keeps the configured maximum service target as a distinct hard deadline', () => {
    const timing = calculateProductionTiming({
      orderedAt: '2026-08-27T12:00:00.000Z', mode: 'table', course: 'soup', presentCourses: ['soup'],
      profile: { prepTimeEstimate: 3, platingTime: 0, handoffBuffer: 0 }, config: defaultSmartKdsConfig(), now: '2026-08-27T12:13:00.000Z',
    });
    expect(timing).toMatchObject({ targetServeAt: '2026-08-27T12:12:00.000Z', latestAcceptableServeAt: '2026-08-27T12:16:00.000Z', state: 'at-risk' });
  });

  test('returns every explicit timing escalation state without hiding critical overdue work', () => {
    const config = defaultSmartKdsConfig();
    const source = { orderedAt: '2026-08-27T12:00:00.000Z', mode: 'table', course: 'soup', presentCourses: ['soup'], profile: { prepTimeEstimate: 3, maxPrepTime: 3, platingTime: 0, handoffBuffer: 0 }, config };
    expect(calculateProductionTiming({ ...source, now: '2026-08-27T12:00:00.000Z' }).state).toBe('safe');
    expect(calculateProductionTiming({ ...source, now: '2026-08-27T12:02:00.000Z' }).state).toBe('watch');
    expect(calculateProductionTiming({ ...source, now: '2026-08-27T12:05:00.000Z' }).state).toBe('start-soon');
    expect(calculateProductionTiming({ ...source, now: '2026-08-27T12:09:01.000Z' }).state).toBe('start-now');
    expect(calculateProductionTiming({ ...source, now: '2026-08-27T12:12:01.000Z' }).state).toBe('at-risk');
    expect(calculateProductionTiming({ ...source, now: '2026-08-27T12:16:01.000Z' }).state).toBe('overdue');
    expect(calculateProductionTiming({ ...source, now: '2026-08-27T12:26:01.000Z' }).state).toBe('critical');
  });

  test('ranks active work deterministically by the earliest safe start', () => {
    const input = {
      now: '2026-08-27T12:05:00.000Z',
      tasks: [
        { taskKey: 'B', orderNumber: 2, orderedAt: '2026-08-27T12:01:00.000Z', targetServeAt: '2026-08-27T12:30:00.000Z', latestSafeStartAt: '2026-08-27T12:20:00.000Z', state: 'on-track', profile: { priorityModifier: 100 } },
        { taskKey: 'A', orderNumber: 1, orderedAt: '2026-08-27T12:00:00.000Z', targetServeAt: '2026-08-27T12:20:00.000Z', latestSafeStartAt: '2026-08-27T12:05:00.000Z', state: 'start-now', profile: { longPrepItem: true } },
        { taskKey: 'C', orderNumber: 3, orderedAt: '2026-08-27T12:02:00.000Z', targetServeAt: '2026-08-27T12:22:00.000Z', latestSafeStartAt: '2026-08-27T12:08:00.000Z', state: 'prepare-next', profile: {} },
      ],
    };
    const first = scheduleKitchen(input);
    expect(first.map((task) => task.taskKey)).toEqual(['A', 'C', 'B']);
    expect(first[0]).toMatchObject({ rank: 1, action: 'start-now', reasons: ['Latest safe start time reached', 'Long-prep item'] });
    expect(scheduleKitchen(input)).toEqual(first);
  });

  test('treats cancellation, active preparation, and course dependencies as hard scheduler exclusions', () => {
    const now = '2026-08-27T12:00:00.000Z';
    const timing = {
      targetServeAt: '2026-08-27T12:20:00.000Z',
      latestSafeStartAt: '2026-08-27T12:10:00.000Z',
    };
    const recommendations = scheduleKitchen({
      now,
      tasks: [
        { taskKey: 'eligible', ...timing, taskState: 'eligible', orderedAt: now, profile: {} },
        { taskKey: 'cancelled', ...timing, taskState: 'cancelled', orderedAt: now, profile: {} },
        { taskKey: 'preparing', ...timing, taskState: 'preparing', orderedAt: now, profile: {} },
        { taskKey: 'held-course', ...timing, taskState: 'ordered', pacingState: 'hold-for-course', orderedAt: now, profile: {} },
        { taskKey: 'manual-hold', ...timing, taskState: 'held', orderedAt: now, profile: {} },
      ],
    });
    expect(recommendations.map((task) => task.taskKey)).toEqual(['eligible']);
  });

  test('keeps maximum-deadline work ahead of manual priority and remains stable under input reordering', () => {
    const now = '2026-08-27T12:20:00.000Z';
    const overdue = {
      taskKey: 'overdue', taskState: 'ordered', orderedAt: '2026-08-27T12:00:00.000Z',
      targetServeAt: '2026-08-27T12:10:00.000Z', latestAcceptableServeAt: '2026-08-27T12:15:00.000Z',
      latestSafeStartAt: '2026-08-27T12:02:00.000Z', profile: {},
    };
    const rushed = {
      taskKey: 'rushed', taskState: 'ordered', orderedAt: '2026-08-27T12:05:00.000Z',
      targetServeAt: '2026-08-27T12:30:00.000Z', latestAcceptableServeAt: '2026-08-27T12:40:00.000Z',
      latestSafeStartAt: '2026-08-27T12:25:00.000Z', manualOverride: { action: 'rush' }, profile: {},
    };
    const currentCourse = {
      taskKey: 'current-course', taskState: 'ordered', pacingState: 'current-course', orderedAt: '2026-08-27T12:04:00.000Z',
      targetServeAt: '2026-08-27T12:30:00.000Z', latestSafeStartAt: '2026-08-27T12:25:00.000Z', profile: {},
    };
    const first = scheduleKitchen({ now, tasks: [rushed, currentCourse, overdue] });
    expect(first.map((task) => task.taskKey)).toEqual(['overdue', 'rushed', 'current-course']);
    expect(first[0].priorityReason).toBe('Maximum service window passed');
    expect(first[1].priorityReason).toBe('Manual priority override');
    expect(scheduleKitchen({ now, tasks: [overdue, currentCourse, rushed] })).toEqual(first);
  });

  test('splits a compatible allocation at the maximum batch size and closes it at its safe start', () => {
    const batches = buildBatches({
      now: '2026-08-27T12:05:00.000Z',
      recommendations: [
        { taskKey: 'A', orderId: 'A', orderNumber: 1, rank: 1, itemName: 'Soup', quantity: 5, orderedAt: '2026-08-27T12:00:00.000Z', latestSafeStartAt: '2026-08-27T12:05:00.000Z', targetServeAt: '2026-08-27T12:20:00.000Z', stationId: 'soup', action: 'start-now', profile: { batchable: true, batchGroupId: 'MANCHOW', maxBatchSize: 6, batchWindowSeconds: 300 } },
        { taskKey: 'B', orderId: 'B', orderNumber: 2, rank: 2, itemName: 'Soup', quantity: 3, orderedAt: '2026-08-27T12:02:00.000Z', latestSafeStartAt: '2026-08-27T12:08:00.000Z', targetServeAt: '2026-08-27T12:23:00.000Z', stationId: 'soup', action: 'prepare-next', profile: { batchable: true, batchGroupId: 'MANCHOW', maxBatchSize: 6, batchWindowSeconds: 300 } },
      ],
    });
    expect(batches.map((batch) => batch.totalQuantity)).toEqual([6, 2]);
    expect(batches[0]).toMatchObject({ action: 'fire-batch', reason: 'Latest safe start time reached' });
    expect(batches[1]).toMatchObject({ action: 'wait-for-batch', reason: 'Compatible batch window remains safely open' });
    expect(batches[0].allocations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ taskKey: 'A', quantity: 5 }),
        expect.objectContaining({ taskKey: 'B', quantity: 1 }),
      ])
    );
  });

  test('never loses an oversized compatible quantity and can preserve atomic production tasks', () => {
    const recommendation = (key, quantity, rank = 1, maxBatchSize = 8) => ({
      taskKey: key, orderId: key, rank, itemName: 'Soup', quantity,
      orderedAt: '2026-08-27T12:00:00.000Z', latestSafeStartAt: '2026-08-27T12:20:00.000Z', targetServeAt: '2026-08-27T12:30:00.000Z',
      stationId: 'soup', action: 'monitor', profile: { batchable: true, batchGroupId: 'MANCHOW', maxBatchSize, optimalBatchSize: maxBatchSize, batchWindowSeconds: 300 },
    });
    const split = buildBatches({ now: '2026-08-27T12:01:00.000Z', recommendations: [recommendation('large-line', 13)] });
    expect(split.map((batch) => batch.totalQuantity)).toEqual([8, 5]);
    expect(split.flatMap((batch) => batch.allocations).reduce((total, allocation) => total + allocation.quantity, 0)).toBe(13);

    const atomic = buildBatches({
      now: '2026-08-27T12:01:00.000Z', atomicTasks: true,
      recommendations: [recommendation('first', 5, 1, 6), recommendation('second', 3, 2, 6)],
    });
    expect(atomic.map((batch) => batch.totalQuantity)).toEqual([5, 3]);
    expect(atomic.flatMap((batch) => batch.allocations)).toEqual(expect.arrayContaining([
      expect.objectContaining({ taskKey: 'first', quantity: 5 }),
      expect.objectContaining({ taskKey: 'second', quantity: 3 }),
    ]));
  });

  test('holds a safely-open batch that includes otherwise monitor-only work', () => {
    const batches = buildBatches({
      now: '2026-08-27T12:00:30.000Z',
      recommendations: [
        { taskKey: 'A', rank: 1, quantity: 1, orderedAt: '2026-08-27T12:00:00.000Z', latestSafeStartAt: '2026-08-27T12:10:00.000Z', targetServeAt: '2026-08-27T12:20:00.000Z', stationId: 'fryer', action: 'monitor', profile: { batchable: true, batchGroupId: 'FRIES', maxBatchSize: 5, optimalBatchSize: 3, batchWindowSeconds: 180 } },
        { taskKey: 'B', rank: 2, quantity: 1, orderedAt: '2026-08-27T12:00:20.000Z', latestSafeStartAt: '2026-08-27T12:11:00.000Z', targetServeAt: '2026-08-27T12:21:00.000Z', stationId: 'fryer', action: 'monitor', profile: { batchable: true, batchGroupId: 'FRIES', maxBatchSize: 5, optimalBatchSize: 3, batchWindowSeconds: 180 } },
      ],
    });
    expect(batches).toHaveLength(1);
    expect(batches[0]).toMatchObject({ totalQuantity: 2, action: 'wait-for-batch', reason: 'Compatible batch window remains safely open' });
  });

  test('uses the maximum saved prep time for conservative safe-start calculations', () => {
    const timing = calculateProductionTiming({
      orderedAt: '2026-08-27T12:00:00.000Z', mode: 'parcel', course: 'main',
      profile: { prepTimeEstimate: 10, minPrepTime: 6, maxPrepTime: 18, platingTime: 2, handoffBuffer: 1 },
      config: { timing: { parcelDefaultTargetMinutes: 30 } }, now: '2026-08-27T12:05:00.000Z',
    });
    expect(timing).toMatchObject({ minimumPrepWindowMinutes: 9, estimatedPrepWindowMinutes: 13, prepWindowMinutes: 21, latestSafeStartAt: '2026-08-27T12:09:00.000Z' });
  });

  test('keeps incompatible modifiers out of the same batch', () => {
    const batches = buildBatches({
      now: '2026-08-27T12:00:10.000Z',
      recommendations: [
        { taskKey: 'A', rank: 1, quantity: 1, orderedAt: '2026-08-27T12:00:00.000Z', latestSafeStartAt: '2026-08-27T12:10:00.000Z', targetServeAt: '2026-08-27T12:20:00.000Z', stationId: 'wok', style: 'gravy', action: 'prepare-next', profile: { batchable: true, batchGroupId: 'RICE', maxBatchSize: 5, batchWindowSeconds: 300 } },
        { taskKey: 'B', rank: 2, quantity: 1, orderedAt: '2026-08-27T12:00:00.000Z', latestSafeStartAt: '2026-08-27T12:10:00.000Z', targetServeAt: '2026-08-27T12:20:00.000Z', stationId: 'wok', style: 'semi-gravy', action: 'prepare-next', profile: { batchable: true, batchGroupId: 'RICE', maxBatchSize: 5, batchWindowSeconds: 300 } },
      ],
    });
    expect(batches).toEqual([]);
  });

  test('allocates station capacity to the highest-priority work first', () => {
    const result = allocateStationCapacity({
      stations: [{ station_id: 'wok', station_name: 'Wok', enabled: true, max_concurrent_tasks: 3 }],
      recommendations: [
        { taskKey: 'A', rank: 1, action: 'start-now', stationId: 'wok', latestSafeStartAt: '2026-08-27T12:00:00.000Z', quantity: 1, itemName: 'Rice', profile: { parallelCapacityCost: 2 } },
        { taskKey: 'B', rank: 2, action: 'start-now', stationId: 'wok', latestSafeStartAt: '2026-08-27T12:01:00.000Z', quantity: 1, itemName: 'Noodles', profile: { parallelCapacityCost: 2 } },
        { taskKey: 'C', rank: 3, action: 'prepare-next', stationId: '', latestSafeStartAt: '2026-08-27T12:02:00.000Z', quantity: 1, itemName: 'Unassigned', profile: { parallelCapacityCost: 1 } },
      ],
    });
    expect(result.allocated.map((work) => work.workKey)).toEqual(['A']);
    expect(result.capacityWait[0]).toMatchObject({ workKey: 'B', capacityState: 'capacity-wait' });
    expect(result.unassigned[0]).toMatchObject({ workKey: 'C', capacityState: 'unassigned' });
    expect(result.stationPlans[0]).toMatchObject({ usedCapacity: 2, remainingCapacity: 1 });
  });

  test('holds capacity for a compatible batch until that batch should fire', () => {
    const result = allocateStationCapacity({
      stations: [{ station_id: 'fryer', station_name: 'Fryer', enabled: true, max_concurrent_tasks: 1 }],
      recommendations: [
        { taskKey: 'A', rank: 1, action: 'start-now', stationId: 'fryer', latestSafeStartAt: '2026-08-27T12:00:00.000Z', quantity: 1, itemName: 'Fries', profile: {} },
      ],
      batches: [{ batchKey: 'fries#1', batchGroupId: 'FRIES', action: 'wait-for-batch', stationId: 'fryer', totalQuantity: 1, allocations: [{ taskKey: 'A', rank: 1 }] }],
    });
    expect(result.allocated).toEqual([]);
    expect(result.stationPlans[0]).toMatchObject({ usedCapacity: 0, remainingCapacity: 1 });
  });

  test('paces courses while allowing a long-prep future course to begin safely', () => {
    const paced = buildCoursePacing({
      now: '2026-08-27T12:10:00.000Z',
      config: defaultSmartKdsConfig(),
      order: {
        mode: 'table',
        tasks: [
          { taskKey: 'soup', itemName: 'Soup', course: 'soup', targetServeAt: '2026-08-27T12:15:00.000Z', prepWindowMinutes: 5, profile: {} },
          { taskKey: 'starter', itemName: 'Starter', course: 'starter', targetServeAt: '2026-08-27T12:25:00.000Z', prepWindowMinutes: 8, profile: { requiresPreviousCourse: true } },
          { taskKey: 'main', itemName: 'Sizzler', course: 'main', targetServeAt: '2026-08-27T12:32:00.000Z', prepWindowMinutes: 25, profile: { longPrepItem: true } },
        ],
      },
    });
    expect(paced.nextExpectedCourse).toBe('soup');
    expect(paced.tasks.map((task) => task.pacingState)).toEqual(['current-course', 'hold-for-course', 'pre-prep']);
    expect(paced.tasks[2]).toMatchObject({ pacingReason: 'Long-prep item should begin before the prior course finishes' });
  });

  test('keeps batching configuration-driven instead of guessing from menu names', () => {
    const config = defaultSmartKdsConfig();
    expect(defaultMenuProductionProfile({ menuType: 'food', category: 'RICE & NOODLES', name: 'Chicken Fried Rice' }, config)).toMatchObject({ batchable: false });
    expect(normalizeMenuProductionProfile({ batchable: true, batchGroupId: 'FRIED_RICE_BASE', maxBatchSize: 10, optimalBatchSize: 8 }, { menuType: 'food', category: 'RICE & NOODLES', name: 'Chicken Fried Rice' }, config)).toMatchObject({ batchable: true, batchGroupId: 'FRIED_RICE_BASE', maxBatchSize: 10, optimalBatchSize: 8 });
  });

  test('keeps soup first while releasing mains in time to follow it', () => {
    const config = defaultSmartKdsConfig();
    const soupAndMain = (now) => buildCoursePacing({
      now,
      config,
      order: {
        mode: 'table',
        tasks: [
          { taskKey: 'soup', itemName: 'Chicken Clear Soup', course: 'soup', targetServeAt: '2026-08-27T12:12:00.000Z', prepWindowMinutes: 8, profile: {} },
          { taskKey: 'main', itemName: 'Chicken Fried Rice', course: 'main', targetServeAt: '2026-08-27T12:31:00.000Z', prepWindowMinutes: 20, profile: {} },
        ],
      },
    });
    const atOrder = soupAndMain('2026-08-27T12:00:00.000Z');
    const nearSoupService = soupAndMain('2026-08-27T12:11:00.000Z');
    expect(atOrder.nextExpectedCourse).toBe('soup');
    expect(atOrder.tasks.map((task) => task.pacingState)).toEqual(['current-course', 'hold-for-course']);
    expect(nearSoupService.tasks.map((task) => task.pacingState)).toEqual(['current-course', 'pre-prep']);
    expect(calculateTargetServeAt({ orderedAt: '2026-08-27T12:00:00.000Z', mode: 'table', course: 'starter', presentCourses: ['starter'], config }).toISOString()).toBe('2026-08-27T12:15:00.000Z');
  });

  test('synchronizes serve-together items around one ready window', () => {
    const paced = buildCoursePacing({
      now: '2026-08-27T12:00:00.000Z',
      config: defaultSmartKdsConfig(),
      order: {
        mode: 'table', courseMode: 'serve_together',
        tasks: [
          { taskKey: 'pasta', itemName: 'Pasta', course: 'main', targetServeAt: '2026-08-27T12:25:00.000Z', prepWindowMinutes: 15, profile: {} },
          { taskKey: 'rice', itemName: 'Rice', course: 'side', targetServeAt: '2026-08-27T12:30:00.000Z', prepWindowMinutes: 10, profile: {} },
        ],
      },
    });
    expect(paced.tasks.map((task) => task.plannedStartAt)).toEqual(['2026-08-27T12:15:00.000Z', '2026-08-27T12:20:00.000Z']);
    expect(paced.tasks.map((task) => task.pacingState)).toEqual(['sync-watch', 'sync-watch']);
    expect(buildCoursePacingPreview({ orders: [paced], config: defaultSmartKdsConfig() }).summary.synchronized).toBe(2);
  });

  test('synchronizes dishes in one course without violating the earliest saved service window', () => {
    const paced = buildCoursePacing({
      now: '2026-08-27T12:00:00.000Z', config: defaultSmartKdsConfig(),
      order: {
        mode: 'table',
        tasks: [
          { taskKey: 'tikka', itemName: 'Tikka', course: 'starter', targetServeAt: '2026-08-27T12:25:00.000Z', latestAcceptableServeAt: '2026-08-27T12:32:00.000Z', latestSafeStartAt: '2026-08-27T12:15:00.000Z', prepWindowMinutes: 15, profile: {} },
          { taskKey: 'rice', itemName: 'Rice', course: 'starter', targetServeAt: '2026-08-27T12:30:00.000Z', latestAcceptableServeAt: '2026-08-27T12:27:00.000Z', latestSafeStartAt: '2026-08-27T12:17:00.000Z', prepWindowMinutes: 10, profile: {} },
        ],
      },
    });
    expect(paced.courses[0]).toMatchObject({ targetServeAt: '2026-08-27T12:27:00.000Z', latestAcceptableServeAt: '2026-08-27T12:27:00.000Z' });
    expect(paced.tasks.map((task) => task.plannedStartAt)).toEqual(['2026-08-27T12:12:00.000Z', '2026-08-27T12:17:00.000Z']);
    expect(paced.tasks.map((task) => task.pacingTargetServeAt)).toEqual(['2026-08-27T12:27:00.000Z', '2026-08-27T12:27:00.000Z']);
  });

  test('uses a synchronized planned start to fire work before an unsafe delay', () => {
    const task = buildCoursePacing({
      now: '2026-08-27T12:10:00.000Z', config: defaultSmartKdsConfig(),
      order: { mode: 'table', courseMode: 'serve_together', tasks: [{ taskKey: 'pasta', itemName: 'Pasta', course: 'main', targetServeAt: '2026-08-27T12:25:00.000Z', latestSafeStartAt: '2026-08-27T12:20:00.000Z', prepWindowMinutes: 15, profile: {} }] },
    }).tasks[0];
    const recommendation = scheduleKitchen({ now: '2026-08-27T12:10:00.000Z', tasks: [{ ...task, taskState: 'ordered', targetServeAt: task.pacingTargetServeAt, latestSafeStartAt: task.pacingLatestSafeStartAt }] });
    expect(recommendation[0]).toMatchObject({ action: 'start-now', priorityReason: 'Latest safe start time reached' });
  });

  test('keeps parcel and takeaway pacing as-ready even if a table-only preference was supplied', () => {
    const paced = buildCoursePacing({
      now: '2026-08-27T12:00:00.000Z', config: defaultSmartKdsConfig(),
      order: { mode: 'parcel', courseMode: 'manual_fire', tasks: [{ taskKey: 'parcel', itemName: 'Parcel', course: 'main', targetServeAt: '2026-08-27T12:20:00.000Z', prepWindowMinutes: 10, profile: {} }] },
    });
    expect(paced).toMatchObject({ courseMode: 'as_ready', nextExpectedCourse: null });
    expect(paced.tasks[0].pacingState).toBe('as-ready');
  });

  test('keeps course and manual holds visible but outside automatic batch and capacity allocation', () => {
    const manual = buildCoursePacing({
      now: '2026-08-27T12:00:00.000Z', config: defaultSmartKdsConfig(),
      order: { mode: 'table', courseMode: 'manual_fire', tasks: [{ taskKey: 'manual-main', itemName: 'Main', course: 'main', targetServeAt: '2026-08-27T12:25:00.000Z', prepWindowMinutes: 12, profile: { batchable: true, batchGroupId: 'MAIN', maxBatchSize: 4 } }] },
    }).tasks[0];
    const unified = buildUnifiedRecommendations({ fairness: { recommendations: [{ ...manual, action: 'monitor', taskState: 'ordered' }] }, capacity: {} });
    expect(unified.recommendations[0]).toMatchObject({ action: 'manual-hold', capacityState: 'manual-hold' });
    expect(buildBatches({ now: '2026-08-27T12:00:00.000Z', recommendations: [{ ...manual, taskState: 'ordered', stationId: 'wok', quantity: 2 }] })).toEqual([]);
    expect(allocateStationCapacity({ stations: [{ station_id: 'wok', enabled: true, max_concurrent_tasks: 2 }], recommendations: [{ ...manual, taskState: 'ordered', stationId: 'wok', quantity: 1, action: 'start-now' }] }).allocated).toEqual([]);
  });

  test('advances the next expected course after the previous course is served', () => {
    const paced = buildCoursePacing({
      now: '2026-08-27T12:00:00.000Z', config: defaultSmartKdsConfig(),
      order: {
        mode: 'table', courseStates: { soup: 'served', starter: 'ordered' },
        tasks: [
          { taskKey: 'soup', itemName: 'Soup', course: 'soup', targetServeAt: '2026-08-27T12:15:00.000Z', prepWindowMinutes: 5, profile: {} },
          { taskKey: 'starter', itemName: 'Starter', course: 'starter', targetServeAt: '2026-08-27T12:25:00.000Z', prepWindowMinutes: 8, profile: {} },
        ],
      },
    });
    expect(paced.nextExpectedCourse).toBe('starter');
    expect(paced.tasks.map((task) => task.pacingState)).toEqual(['served', 'current-course']);
  });

  test('protects an eligible older task from endless overtaking without displacing an urgent deadline', () => {
    const fairness = applyFairness({
      now: '2026-08-27T12:30:00.000Z', starvationAfterMinutes: 20,
      recommendations: [
        { taskKey: 'urgent', rank: 2, action: 'start-now', orderedAt: '2026-08-27T12:25:00.000Z', reasons: ['Latest safe start time reached'] },
        { taskKey: 'old', rank: 3, action: 'prepare-next', orderedAt: '2026-08-27T11:45:00.000Z', reasons: ['Latest safe start approaching'] },
        { taskKey: 'new', rank: 1, action: 'prepare-next', orderedAt: '2026-08-27T12:20:00.000Z', reasons: [] },
      ],
    });
    expect(fairness.recommendations.map((task) => task.taskKey)).toEqual(['urgent', 'old', 'new']);
    expect(fairness.recommendations[1]).toMatchObject({ protectedByFairness: true, waitedMinutes: 45, fairnessTier: 2 });
    expect(fairness.summary).toMatchObject({ protected: 1, longestWaitMinutes: 45 });
  });

  test('uses the actual wait within a fairness tier and sends that fair rank into station allocation', () => {
    const fairness = applyFairness({
      now: '2026-08-27T13:00:00.000Z', starvationAfterMinutes: 25,
      recommendations: [
        { taskKey: 'newer', orderId: 'newer', rank: 1, action: 'prepare-next', orderedAt: '2026-08-27T12:34:00.000Z', stationId: 'wok', quantity: 1, itemName: 'Newer', profile: { parallelCapacityCost: 1 } },
        { taskKey: 'older', orderId: 'older', rank: 2, action: 'prepare-next', orderedAt: '2026-08-27T12:11:00.000Z', stationId: 'wok', quantity: 1, itemName: 'Older', profile: { parallelCapacityCost: 1 } },
      ],
    });
    expect(fairness.recommendations.map((task) => task.taskKey)).toEqual(['older', 'newer']);
    expect(fairness.recommendations[0]).toMatchObject({ originalRank: 2, rank: 1, fairnessRank: 1, protectedByFairness: true });
    const capacity = allocateStationCapacity({ stations: [{ station_id: 'wok', enabled: true, max_concurrent_tasks: 1 }], recommendations: fairness.recommendations });
    expect(capacity.allocated.map((work) => work.workKey)).toEqual(['older']);
    expect(capacity.capacityWait.map((work) => work.workKey)).toEqual(['newer']);
    const unified = buildUnifiedRecommendations({ fairness, capacity });
    expect(unified.recommendations.find((task) => task.taskKey === 'older')).toMatchObject({ action: 'fairness-protected', capacityState: 'allocated' });
    expect(unified.recommendations.find((task) => task.taskKey === 'newer')).toMatchObject({ action: 'wait-capacity', capacityState: 'capacity-wait' });
  });

  test('does not promote manual or course-held work merely because it has waited', () => {
    const fairness = applyFairness({
      now: '2026-08-27T13:00:00.000Z', starvationAfterMinutes: 20,
      recommendations: [
        { taskKey: 'manual', rank: 1, action: 'manual-hold', pacingState: 'manual-hold', orderedAt: '2026-08-27T11:00:00.000Z' },
        { taskKey: 'course', rank: 2, action: 'hold-for-course', pacingState: 'hold-for-course', orderedAt: '2026-08-27T11:00:00.000Z' },
      ],
    });
    expect(fairness.recommendations.every((task) => !task.protectedByFairness && !task.fairnessEligible)).toBe(true);
    expect(fairness.summary).toMatchObject({ protected: 0, eligible: 0, excluded: 2 });
  });

  test('reserves live preparing work before allocating new station capacity', () => {
    const result = allocateStationCapacity({
      stations: [{ station_id: 'wok', station_name: 'Wok', enabled: true, max_concurrent_tasks: 2, occupied_capacity: 1 }],
      recommendations: [{ taskKey: 'A', rank: 1, action: 'start-now', stationId: 'wok', latestSafeStartAt: '2026-08-27T12:00:00.000Z', quantity: 1, itemName: 'Rice', profile: { parallelCapacityCost: 2 } }],
    });
    expect(result.capacityWait[0]).toMatchObject({ workKey: 'A', capacityState: 'capacity-wait' });
    expect(result.stationPlans[0]).toMatchObject({ occupiedCapacity: 1, usedCapacity: 1, remainingCapacity: 1 });
  });

  test('accounts for eligible and scheduled work and never hides a live station overload', () => {
    const result = allocateStationCapacity({
      stations: [{ station_id: 'wok', station_name: 'Wok', enabled: true, max_concurrent_tasks: 2, occupied_capacity: 4 }],
      recommendations: [
        { taskKey: 'eligible', taskState: 'eligible', rank: 1, action: 'start-now', stationId: 'wok', latestSafeStartAt: '2026-08-27T12:00:00.000Z', quantity: 1, itemName: 'Rice', profile: { parallelCapacityCost: 1 } },
        { taskKey: 'scheduled', taskState: 'scheduled', rank: 2, action: 'prepare-next', stationId: 'wok', latestSafeStartAt: '2026-08-27T12:01:00.000Z', quantity: 1, itemName: 'Noodles', profile: { parallelCapacityCost: 1 } },
      ],
    });
    expect(result.capacityWait.map((work) => work.workKey)).toEqual(['eligible', 'scheduled']);
    expect(result.stationPlans[0]).toMatchObject({ occupiedCapacity: 4, usedCapacity: 4, overCapacity: 2, remainingCapacity: 0 });
    expect(result).toMatchObject({ overCapacity: 2, overCapacityStations: 1 });
  });

  test('blocks disabled or impossible station work with an actionable capacity reason', () => {
    const disabled = allocateStationCapacity({
      stations: [{ station_id: 'grill', station_name: 'Grill', enabled: false, max_concurrent_tasks: 3 }],
      recommendations: [{ taskKey: 'steak', rank: 1, action: 'start-now', stationId: 'grill', latestSafeStartAt: '2026-08-27T12:00:00.000Z', quantity: 1, itemName: 'Steak', profile: { parallelCapacityCost: 1 } }],
    });
    expect(disabled.capacityWait[0]).toMatchObject({ capacityState: 'capacity-wait', capacityReason: 'Station is unavailable' });

    const tooLarge = allocateStationCapacity({
      stations: [{ station_id: 'wok', station_name: 'Wok', enabled: true, max_concurrent_tasks: 2 }],
      recommendations: [{ taskKey: 'large', rank: 1, action: 'start-now', stationId: 'wok', latestSafeStartAt: '2026-08-27T12:00:00.000Z', quantity: 1, itemName: 'Large wok prep', profile: { parallelCapacityCost: 3 } }],
    });
    expect(tooLarge.capacityWait[0]).toMatchObject({ capacityState: 'capacity-too-large', capacityReason: expect.stringContaining('Work needs 3 capacity') });
    expect(buildUnifiedRecommendations({ fairness: { recommendations: [{ taskKey: 'large', action: 'start-now' }] }, capacity: tooLarge }).recommendations[0])
      .toMatchObject({ action: 'wait-capacity', capacityState: 'capacity-too-large' });
  });

  test('carries a station capacity version with every allocation for safe concurrent starts', () => {
    const result = allocateStationCapacity({
      stations: [{ station_id: 'wok', station_name: 'Wok', enabled: true, max_concurrent_tasks: 2, capacity_version: 7 }],
      recommendations: [{ taskKey: 'rice', rank: 1, action: 'start-now', stationId: 'wok', latestSafeStartAt: '2026-08-27T12:00:00.000Z', quantity: 1, itemName: 'Rice', profile: { parallelCapacityCost: 1 } }],
    });
    expect(result.allocated[0]).toMatchObject({ workKey: 'rice', stationCapacityVersion: 7, capacityState: 'allocated' });
  });

  test('never allocates a task that is already being prepared or ready', () => {
    const result = allocateStationCapacity({
      stations: [{ station_id: 'wok', station_name: 'Wok', enabled: true, max_concurrent_tasks: 2 }],
      recommendations: [
        { taskKey: 'preparing', taskState: 'preparing', rank: 1, action: 'in-progress', stationId: 'wok', latestSafeStartAt: '2026-08-27T12:00:00.000Z', profile: {} },
        { taskKey: 'ready', taskState: 'ready', rank: 2, action: 'ready-for-expo', stationId: 'wok', latestSafeStartAt: '2026-08-27T12:00:00.000Z', profile: {} },
      ],
    });
    expect(result.allocated).toEqual([]);
    expect(result.capacityWait).toEqual([]);
    expect(result.stationPlans[0]).toMatchObject({ usedCapacity: 0, remainingCapacity: 2 });
  });

  test('builds one final recommendation with capacity as a hard constraint', () => {
    const unified = buildUnifiedRecommendations({
      fairness: { recommendations: [{ taskKey: 'A', action: 'start-now', priorityReason: 'Latest safe start time reached', protectedByFairness: false }] },
      capacity: { capacityWait: [{ workKey: 'A', kind: 'task', capacityState: 'capacity-wait', capacityReason: 'Station capacity is fully allocated to higher-priority work' }] },
    });
    expect(unified.recommendations[0]).toMatchObject({ action: 'wait-capacity', capacityState: 'capacity-wait' });
  });

  test('keeps every active production lifecycle state visible and actionable on the board', () => {
    const unified = buildUnifiedRecommendations({
      fairness: { recommendations: [
        { taskKey: 'fired', taskState: 'fired', action: 'fired', priorityReason: 'Food has been fired and is awaiting preparation' },
        { taskKey: 'preparing', taskState: 'preparing', action: 'in-progress' },
        { taskKey: 'ready', taskState: 'ready', action: 'ready-for-expo' },
        { taskKey: 'expo', taskState: 'expo', action: 'at-expo' },
      ] },
    });
    expect(unified.recommendations).toEqual(expect.arrayContaining([
      expect.objectContaining({ taskKey: 'fired', action: 'fired', capacityState: 'fired' }),
      expect.objectContaining({ taskKey: 'preparing', action: 'in-progress', capacityState: 'in-progress' }),
      expect.objectContaining({ taskKey: 'ready', action: 'ready-for-expo', capacityState: 'ready-for-expo' }),
      expect.objectContaining({ taskKey: 'expo', action: 'at-expo', capacityState: 'at-expo' }),
    ]));
  });

  test('boosts an eligible table item with critical service risk without bypassing capacity', () => {
    const unified = buildUnifiedRecommendations({
      fairness: { recommendations: [{ taskKey: 'A', orderId: 'table-risk', action: 'prepare-next', rank: 1, fairnessRank: 1 }] },
      capacity: { allocated: [{ workKey: 'A', kind: 'task', capacityState: 'allocated' }] },
      serviceRisk: { risks: [{ id: 'table-risk', riskType: 'first-food-risk', severity: 'critical', reason: 'No food served after 25 minutes' }] },
    });
    expect(unified.recommendations[0]).toMatchObject({ action: 'service-risk', serviceRisk: 'first-food-risk' });
  });

  test('flags both no-first-food and service-gap table risk deterministically', () => {
    const risks = evaluateServiceRisk({ now: '2026-08-27T12:30:00.000Z', config: { serviceRisk: { firstFoodAfterMinutes: 18, serviceGapAfterMinutes: 15 } }, orders: [
      { orderNumber: 1, mode: 'table', orderedAt: '2026-08-27T12:00:00.000Z', courseEvents: [] },
      { orderNumber: 2, mode: 'table', orderedAt: '2026-08-27T12:00:00.000Z', courseEvents: [{ course: 'soup', servedAt: '2026-08-27T12:10:00.000Z' }] },
    ] });
    expect(risks.summary).toMatchObject({ firstFoodRisk: 1, serviceGapRisk: 1, critical: 1 });
    expect(risks.risks.map((risk) => risk.riskType)).toEqual(['first-food-risk', 'service-gap-risk']);
  });

  test('closes service risk once every persisted course has been served', () => {
    const risks = evaluateServiceRisk({
      now: '2026-08-27T13:00:00.000Z',
      config: { serviceRisk: { firstFoodAfterMinutes: 18, serviceGapAfterMinutes: 15 } },
      orders: [{
        orderNumber: 3,
        mode: 'table',
        orderedAt: '2026-08-27T12:00:00.000Z',
        hasPendingFood: false,
        courseEvents: [{ course: 'main', servedAt: '2026-08-27T12:10:00.000Z' }],
      }],
    });
    expect(risks.risks[0]).toMatchObject({ riskType: 'on-track', severity: 'on-track', hasPendingFood: false, reason: 'All ordered courses have been served' });
    expect(risks.summary).toMatchObject({ completedService: 1, serviceGapRisk: 0 });
  });

  test('uses the latest valid delivery event for a reopened course', () => {
    const risks = evaluateServiceRisk({
      now: '2026-08-27T12:40:00.000Z',
      config: { serviceRisk: { firstFoodAfterMinutes: 18, serviceGapAfterMinutes: 15 } },
      orders: [{
        orderNumber: 4,
        mode: 'table',
        orderedAt: '2026-08-27T12:00:00.000Z',
        hasPendingFood: true,
        courseEvents: [
          { course: 'soup', servedAt: '2026-08-27T12:10:00.000Z' },
          { course: 'soup', servedAt: 'not-a-date' },
          { course: 'soup', servedAt: '2026-08-27T12:28:00.000Z' },
        ],
      }],
    });
    expect(risks.risks[0]).toMatchObject({ riskType: 'on-track', minutesSinceLastFood: 12, lastServedAt: '2026-08-27T12:28:00.000Z' });
  });

  test('allocates scarce capacity to critical table service before a lower-risk peer', () => {
    const recommendations = applyServiceRiskPriority({
      recommendations: [
        { taskKey: 'normal', orderId: 'normal-order', taskState: 'ordered', action: 'start-now', rank: 1, fairnessRank: 1, stationId: 'wok', quantity: 1, itemName: 'Normal', profile: { parallelCapacityCost: 1 } },
        { taskKey: 'critical', orderId: 'critical-order', taskState: 'ordered', action: 'start-now', rank: 2, fairnessRank: 2, stationId: 'wok', quantity: 1, itemName: 'Critical', profile: { parallelCapacityCost: 1 } },
      ],
      risks: [{ id: 'critical-order', riskType: 'first-food-risk', severity: 'critical', reason: 'No food served after 30 minutes' }],
    });
    const capacity = allocateStationCapacity({
      stations: [{ station_id: 'wok', station_name: 'Wok', enabled: true, max_concurrent_tasks: 1 }],
      recommendations,
    });
    expect(recommendations.map((task) => task.taskKey)).toEqual(['critical', 'normal']);
    expect(capacity.allocated.map((work) => work.workKey)).toEqual(['critical']);
    expect(capacity.capacityWait.map((work) => work.workKey)).toEqual(['normal']);
  });
});
