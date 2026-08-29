const { defaultSmartKdsConfig } = require('./smart-kds-domain');
const { calculateProductionTiming } = require('./smart-kds-timing');
const { buildBatches } = require('./smart-kds-batching');
const { allocateStationCapacity } = require('./smart-kds-capacity');
const { buildCoursePacing } = require('./smart-kds-pacing');
const { evaluateServiceRisk } = require('./smart-kds-service-risk');
const { simulateKitchen, createRushScenario } = require('./smart-kds-simulation');
const { applyTaskAction } = require('./smart-kds-workflow');
const { reasonCodesForRecommendation } = require('./smart-kds-reasons');

const now = '2026-08-27T19:00:00.000Z';
const asDate = (value) => new Date(value).getTime();
const task = (key, overrides = {}) => ({
  taskKey: key, orderId: key.split(':')[0], orderNumber: 1, itemName: key, course: 'main', stationId: 'wok', quantity: 1,
  orderedAt: now, targetServeAt: '2026-08-27T19:25:00.000Z', latestSafeStartAt: '2026-08-27T19:10:00.000Z', prepWindowMinutes: 5,
  state: 'on-track', profile: { parallelCapacityCost: 1 }, ...overrides,
});

describe('Smart KDS Phase 12 mandatory simulations', () => {
  test('1. soup becomes urgent before the maximum service target passes', () => {
    const timing = calculateProductionTiming({ orderedAt: now, mode: 'table', course: 'soup', presentCourses: ['soup'], profile: { prepTimeEstimate: 3 }, config: defaultSmartKdsConfig(), now: '2026-08-27T19:13:00.000Z' });
    expect(timing).toMatchObject({ state: 'at-risk', latestAcceptableServeAt: '2026-08-27T19:16:00.000Z' });
  });

  test('2–4. courses advance correctly, including a starter-first and main-only table', () => {
    const config = defaultSmartKdsConfig();
    const paced = buildCoursePacing({ config, now, order: { mode: 'table', courseStates: { soup: 'served' }, tasks: [task('a:soup', { course: 'soup' }), task('a:starter', { course: 'starter' }), task('a:main', { course: 'main', profile: { longPrepItem: true } })] } });
    expect(paced.nextExpectedCourse).toBe('starter');
    expect(buildCoursePacing({ config, now, order: { mode: 'table', tasks: [task('b:starter', { course: 'starter' })] } }).nextExpectedCourse).toBe('starter');
    expect(buildCoursePacing({ config, now, order: { mode: 'table', tasks: [task('c:main', { course: 'main' })] } }).nextExpectedCourse).toBe('main');
  });

  test('5–7. compatible batches combine safely and split at maximum batch size', () => {
    const soup = (key, quantity, orderedAt, latestSafeStartAt) => task(key, { itemName: 'Soup', course: 'soup', stationId: 'soup', quantity, orderedAt, latestSafeStartAt, profile: { batchable: true, batchGroupId: 'SOUP', maxBatchSize: 8, batchWindowSeconds: 180 } });
    const batches = buildBatches({ now, recommendations: [soup('a', 5, now, now), soup('b', 5, '2026-08-27T19:01:00.000Z', '2026-08-27T19:12:00.000Z'), soup('c', 3, '2026-08-27T19:02:00.000Z', '2026-08-27T19:13:00.000Z')] });
    expect(batches.map((batch) => batch.totalQuantity)).toEqual([8, 5]);
    expect(batches[0].action).toBe('fire-batch');
  });

  test('6. a near-deadline soup fires instead of waiting for a later compatible batch', () => {
    const soup = (key, orderedAt, latestSafeStartAt) => task(key, {
      itemName: 'Soup', course: 'soup', stationId: 'soup', orderedAt, latestSafeStartAt,
      profile: { batchable: true, batchGroupId: 'SOUP', maxBatchSize: 8, optimalBatchSize: 8, batchWindowSeconds: 180 },
    });
    const batches = buildBatches({ now, recommendations: [
      soup('old-soup', now, now),
      soup('later-soup', '2026-08-27T19:02:00.000Z', '2026-08-27T19:14:00.000Z'),
    ] });
    expect(batches[0]).toMatchObject({ action: 'fire-batch', reason: 'Latest safe start time reached' });
    expect(batches[0].allocations.map((entry) => entry.taskKey)).toContain('old-soup');
  });

  test('a single eligible rice dish proceeds at its safe-start time instead of waiting for a batch', () => {
    const rice = task('single-rice', {
      itemName: 'Chicken Fried Rice', course: 'main', stationId: 'wok', latestSafeStartAt: now,
      profile: { batchable: true, batchGroupId: 'food::rice::chicken fried rice', maxBatchSize: 10, optimalBatchSize: 10 },
    });
    expect(buildBatches({ now, recommendations: [rice] })).toEqual([]);
    expect(require('./smart-kds-scheduler').scheduleKitchen({ now, tasks: [rice] })[0]).toMatchObject({ taskKey: 'single-rice', action: 'start-now' });
  });

  test('8. old long-prep work cannot starve behind later quick work', () => {
    const result = simulateKitchen({ startAt: now, durationMinutes: 20, stations: [{ station_id: 'wok', enabled: true, max_concurrent_tasks: 1 }], tasks: [task('old:sizzler', { latestSafeStartAt: now, prepWindowMinutes: 15, profile: { longPrepItem: true } }), task('new:quick', { orderNumber: 2, orderedAt: '2026-08-27T19:05:00.000Z', latestSafeStartAt: '2026-08-27T19:15:00.000Z' })] });
    expect(result.events.find((event) => event.type === 'started').taskKey).toBe('old:sizzler');
  });

  test('9–10. serve-together timing and table service risk remain deterministic', () => {
    const together = buildCoursePacing({ config: defaultSmartKdsConfig(), now, order: { mode: 'table', courseMode: 'serve_together', tasks: [task('pasta', { prepWindowMinutes: 15 }), task('rice', { prepWindowMinutes: 10, targetServeAt: '2026-08-27T19:30:00.000Z' })] } });
    expect(together.tasks[0].plannedStartAt).toBe('2026-08-27T19:15:00.000Z');
    expect(evaluateServiceRisk({ now: '2026-08-27T19:25:00.000Z', config: defaultSmartKdsConfig(), orders: [{ mode: 'table', orderNumber: 1, orderedAt: now, courseEvents: [] }] }).risks[0].riskType).toBe('first-food-risk');
  });

  test('simulation honours arrivals, course gates, and synchronized service', () => {
    const future = task('future:item', {
      orderedAt: '2026-08-27T19:05:00.000Z', latestSafeStartAt: '2026-08-27T19:05:00.000Z', prepWindowMinutes: 2,
    });
    const sequenced = [
      task('course:soup', { course: 'soup', latestSafeStartAt: now, targetServeAt: '2026-08-27T19:05:00.000Z', prepWindowMinutes: 2, profile: { parallelCapacityCost: 1 } }),
      task('course:starter', { course: 'starter', targetServeAt: '2026-08-27T19:12:00.000Z', latestSafeStartAt: '2026-08-27T19:10:00.000Z', prepWindowMinutes: 2, profile: { parallelCapacityCost: 1, requiresPreviousCourse: true } }),
    ];
    const together = [
      task('together:pasta', { course: 'main', courseMode: 'serve_together', targetServeAt: '2026-08-27T19:30:00.000Z', latestSafeStartAt: '2026-08-27T19:15:00.000Z', prepWindowMinutes: 15, profile: { parallelCapacityCost: 1 } }),
      task('together:rice', { course: 'main', courseMode: 'serve_together', targetServeAt: '2026-08-27T19:30:00.000Z', latestSafeStartAt: '2026-08-27T19:20:00.000Z', prepWindowMinutes: 10, profile: { parallelCapacityCost: 1 } }),
    ];
    const result = simulateKitchen({
      startAt: now, durationMinutes: 35,
      stations: [{ station_id: 'wok', enabled: true, max_concurrent_tasks: 4 }],
      tasks: [future, ...sequenced, ...together],
    });
    const futureStart = result.events.find((event) => event.type === 'started' && event.taskKey === 'future:item');
    const soup = result.tasks.find((entry) => entry.taskKey === 'course:soup');
    const starter = result.tasks.find((entry) => entry.taskKey === 'course:starter');
    const pasta = result.tasks.find((entry) => entry.taskKey === 'together:pasta');
    const rice = result.tasks.find((entry) => entry.taskKey === 'together:rice');
    expect(asDate(futureStart.at)).toBeGreaterThanOrEqual(asDate('2026-08-27T19:05:00.000Z'));
    expect(asDate(starter.startedAt)).toBeGreaterThanOrEqual(asDate(soup.servedAt));
    expect(pasta.servedAt).toBe(rice.servedAt);
    expect(result.validation).toMatchObject({ courseSequenceViolations: [], synchronizationViolations: [] });
  });

  test('11–14. capacity, cancellation, add-on courses, and parcel deadlines are safe', () => {
    const capacity = allocateStationCapacity({ stations: [{ station_id: 'wok', enabled: true, max_concurrent_tasks: 1, occupied_capacity: 1 }], recommendations: [task('waiting')] });
    expect(capacity.capacityWait).toHaveLength(1);
    const cancelled = simulateKitchen({ startAt: now, durationMinutes: 12, stations: [{ station_id: 'wok', enabled: true, max_concurrent_tasks: 1 }], tasks: [task('cancelled', { latestSafeStartAt: now, prepWindowMinutes: 10 })], events: [{ type: 'cancel', taskKey: 'cancelled', atMinutes: 1 }] });
    expect(cancelled.summary).toMatchObject({ started: 1, cancelled: 1, ready: 0 });
    expect(cancelled.events.find((event) => event.type === 'cancelled')).toMatchObject({ taskKey: 'cancelled' });
    expect(buildCoursePacing({ config: defaultSmartKdsConfig(), now, order: { mode: 'table', courseStates: { soup: 'served' }, tasks: [task('addon', { course: 'starter' })] } }).nextExpectedCourse).toBe('starter');
    expect(calculateProductionTiming({ orderedAt: now, mode: 'parcel', course: 'main', profile: { prepTimeEstimate: 10 }, config: defaultSmartKdsConfig(), now: '2026-08-27T19:12:00.000Z' }).state).toBe('start-now');
  });

  test('15. a 100-item rush is repeatable, capacity-safe, and loses no task identity', () => {
    const scenario = createRushScenario({ tables: 20, parcels: 5, itemsPerOrder: 4, startAt: now });
    expect(scenario.tasks).toHaveLength(100);
    const first = simulateKitchen({ ...scenario, durationMinutes: 180 });
    const second = simulateKitchen({ ...scenario, durationMinutes: 180 });
    expect(first.events).toEqual(second.events);
    expect(new Set(first.tasks.map((entry) => entry.taskKey)).size).toBe(100);
    expect(first.summary.duplicateStarts).toBe(0);
    expect(first.summary.capacityBreaches).toBe(0);
    expect(first.summary.unfinished).toBe(0);
    expect(first.summary.starved).toBe(0);
    expect(first.summary.courseSequenceViolations).toBe(0);
    expect(first.summary.synchronizationViolations).toBe(0);
  });

  test('reports SLA pressure instead of hiding it when a rush exceeds configured capacity', () => {
    const scenario = createRushScenario({ tables: 20, parcels: 5, itemsPerOrder: 4, startAt: now });
    const result = simulateKitchen({ ...scenario, durationMinutes: 60 });
    expect(result.summary.targetMisses).toBeGreaterThan(0);
    expect(result.summary.capacityBreaches).toBe(0);
    expect(result.summary.duplicateStarts).toBe(0);
  });

  test('rejects duplicate, cancelled, and out-of-order kitchen commands deterministically', () => {
    const first = applyTaskAction('ordered', 'start');
    expect(first).toMatchObject({ applied: true, state: 'preparing' });
    expect(applyTaskAction(first.state, 'start')).toMatchObject({ applied: false, reason: 'state-conflict' });
    expect(applyTaskAction('cancelled', 'ready')).toMatchObject({ applied: false, reason: 'state-conflict' });
    expect(applyTaskAction('ordered', 'ready')).toMatchObject({ applied: false, expected: ['preparing'] });
  });

  test('validates the complete persisted task lifecycle from scheduling through service', () => {
    expect(applyTaskAction('ordered', 'schedule')).toMatchObject({ applied: true, state: 'scheduled' });
    expect(applyTaskAction('scheduled', 'fire')).toMatchObject({ applied: true, state: 'fired' });
    expect(applyTaskAction('fired', 'start')).toMatchObject({ applied: true, state: 'preparing' });
    expect(applyTaskAction('preparing', 'ready')).toMatchObject({ applied: true, state: 'ready' });
    expect(applyTaskAction('ready', 'expo')).toMatchObject({ applied: true, state: 'expo' });
    expect(applyTaskAction('expo', 'serve')).toMatchObject({ applied: true, state: 'served' });
    expect(applyTaskAction('not-a-state', 'start')).toMatchObject({ applied: false, reason: 'state-conflict' });
  });

  test('attaches explicit kitchen reason codes without exposing opaque scheduler scores', () => {
    const codes = reasonCodesForRecommendation({
      course: 'soup', baseAction: 'start-now', action: 'start-now', capacityState: 'allocated',
      finalReason: 'Latest safe start time reached', profile: { longPrepItem: true },
    });
    expect(codes).toEqual(expect.arrayContaining(['FIRST_COURSE', 'LATEST_SAFE_START_REACHED', 'LONG_PREP_START_REQUIRED', 'STATION_CAPACITY_AVAILABLE']));
  });
});
