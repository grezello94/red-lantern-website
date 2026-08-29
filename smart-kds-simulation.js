const { defaultSmartKdsConfig } = require('./smart-kds-domain');
const { scheduleKitchen } = require('./smart-kds-scheduler');
const { buildBatches } = require('./smart-kds-batching');
const { allocateStationCapacity } = require('./smart-kds-capacity');
const { buildCoursePacing } = require('./smart-kds-pacing');
const { applyFairness } = require('./smart-kds-fairness');

function asTime(value) {
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(time) ? time : 0;
}

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function resolvedConfig(config = {}) {
  const defaults = defaultSmartKdsConfig();
  return {
    ...defaults,
    ...config,
    timing: { ...defaults.timing, ...(config.timing || {}) },
    fairness: { ...defaults.fairness, ...(config.fairness || {}) },
  };
}

function activeCapacity(stations, tasks) {
  return stations.map((station) => ({
    ...station,
    occupied_capacity: [...new Map(tasks.filter((task) => task.workflowState === 'preparing' && task.stationId === station.station_id)
      .map((task) => [task.activeBatchId || task.taskKey, Math.max(1, Number(task.activeCapacityCost || task.profile?.parallelCapacityCost || 1))])).values()]
      .reduce((total, cost) => total + cost, 0),
  }));
}

function courseStates(tasks = []) {
  const groups = new Map();
  tasks.forEach((task) => {
    const course = String(task.course || 'other');
    if (!groups.has(course)) groups.set(course, []);
    groups.get(course).push(task);
  });
  return Object.fromEntries([...groups].map(([course, rows]) => [
    course,
    rows.every((task) => ['served', 'cancelled'].includes(task.workflowState)) ? 'served' : 'ordered',
  ]));
}

function applyCoursePacing(tasks, now, config) {
  const byOrder = new Map();
  tasks.forEach((task) => {
    if (!byOrder.has(task.orderId)) byOrder.set(task.orderId, []);
    byOrder.get(task.orderId).push(task);
  });
  for (const [orderId, orderTasks] of byOrder) {
    const first = orderTasks[0] || {};
    const paced = buildCoursePacing({
      config,
      now,
      order: {
        id: orderId,
        mode: first.mode || first.orderType || 'table',
        courseMode: first.courseMode || first.course_mode,
        courseStates: courseStates(orderTasks),
        tasks: orderTasks,
      },
    });
    const pacedByKey = new Map(paced.tasks.map((task) => [task.taskKey, task]));
    orderTasks.forEach((task) => {
      const next = pacedByKey.get(task.taskKey);
      if (!next) return;
      task.pacingState = next.pacingState;
      task.pacingReason = next.pacingReason;
      task.plannedStartAt = next.plannedStartAt;
      task.readyWindowStartAt = next.readyWindowStartAt;
      task.readyWindowEndAt = next.readyWindowEndAt;
      task.targetServeAt = next.pacingTargetServeAt || next.targetServeAt || task.targetServeAt;
      task.latestAcceptableServeAt = next.pacingLatestAcceptableServeAt || next.latestAcceptableServeAt || task.latestAcceptableServeAt;
      task.latestSafeStartAt = next.pacingLatestSafeStartAt || next.latestSafeStartAt || task.latestSafeStartAt;
    });
  }
}

function applyAllocation(work, tasks, now, events) {
  const keys = work.kind === 'batch' ? work.allocations.map((allocation) => allocation.taskKey) : [work.workKey];
  keys.forEach((key) => {
    const task = tasks.find((candidate) => candidate.taskKey === key);
    if (!task || task.workflowState !== 'ordered') return;
    task.workflowState = 'preparing';
    task.activeBatchId = work.kind === 'batch' ? work.workKey : '';
    task.activeCapacityCost = Math.max(1, Number(work.capacityCost || task.profile?.parallelCapacityCost || 1));
    task.startedAt = now.toISOString();
    task.completeAt = new Date(now.getTime() + Math.max(1, Number(task.prepWindowMinutes || 1)) * 60_000).toISOString();
    events.push({ type: 'started', taskKey: task.taskKey, at: task.startedAt, stationId: task.stationId });
  });
}

function applySimulationEvents(events = [], work = [], offset = 0, now = new Date(), history = []) {
  events.filter((event) => Number(event.atMinutes) === offset).forEach((event) => {
    if (event.type !== 'cancel') return;
    const task = work.find((entry) => entry.taskKey === event.taskKey);
    if (!task || ['served', 'cancelled'].includes(task.workflowState)) return;
    task.workflowState = 'cancelled';
    task.cancelledAt = now.toISOString();
    history.push({ type: 'cancelled', taskKey: task.taskKey, at: task.cancelledAt, stationId: task.stationId, reason: event.reason || 'Simulation cancellation' });
  });
}

function serveReadyTasks(work, now, events, serviceDelayMinutes = 0) {
  const delayMs = Math.max(0, Number(serviceDelayMinutes || 0)) * 60_000;
  const togetherOrders = new Map();
  work.filter((task) => String(task.courseMode || task.course_mode || '') === 'serve_together').forEach((task) => {
    if (!togetherOrders.has(task.orderId)) togetherOrders.set(task.orderId, []);
    togetherOrders.get(task.orderId).push(task);
  });
  const serve = (task) => {
    task.workflowState = 'served';
    task.servedAt = now.toISOString();
    events.push({ type: 'served', taskKey: task.taskKey, at: task.servedAt, stationId: task.stationId });
  };
  togetherOrders.forEach((tasks) => {
    const active = tasks.filter((task) => task.workflowState !== 'cancelled');
    const allReady = active.length && active.every((task) => ['ready', 'served'].includes(task.workflowState));
    const delayed = active.every((task) => !task.readyAt || asTime(task.readyAt) + delayMs <= now.getTime());
    if (allReady && delayed) active.filter((task) => task.workflowState === 'ready').forEach(serve);
  });
  work.filter((task) => task.workflowState === 'ready' && !togetherOrders.has(task.orderId))
    .filter((task) => asTime(task.readyAt) + delayMs <= now.getTime())
    .forEach(serve);
}

function courseSequenceViolations(tasks = [], config = {}) {
  const positions = new Map((config.courseOrder || []).map((course, index) => [course, index]));
  const byOrder = new Map();
  tasks.forEach((task) => {
    if (!byOrder.has(task.orderId)) byOrder.set(task.orderId, []);
    byOrder.get(task.orderId).push(task);
  });
  const violations = [];
  byOrder.forEach((orderTasks) => orderTasks.forEach((task) => {
    if (!task.startedAt || task.profile?.longPrepItem || task.profile?.canPrePrep || !task.profile?.requiresPreviousCourse) return;
    const position = positions.get(task.course) ?? Number.MAX_SAFE_INTEGER;
    const previous = orderTasks.filter((candidate) => (positions.get(candidate.course) ?? Number.MAX_SAFE_INTEGER) < position && candidate.workflowState !== 'cancelled');
    if (!previous.length) return;
    const allServed = previous.every((candidate) => candidate.workflowState === 'served');
    const latestServed = Math.max(...previous.map((candidate) => asTime(candidate.servedAt)));
    if (!allServed || asTime(task.startedAt) < latestServed)
      violations.push({ taskKey: task.taskKey, reason: 'Started before its required earlier course was served' });
  }));
  return violations;
}

function synchronizationViolations(tasks = [], config = {}) {
  const toleranceMs = Math.max(0, Number(config.timing?.courseReadyToleranceMinutes || 0)) * 60_000;
  const byOrder = new Map();
  tasks.filter((task) => String(task.courseMode || task.course_mode || '') === 'serve_together').forEach((task) => {
    if (!byOrder.has(task.orderId)) byOrder.set(task.orderId, []);
    byOrder.get(task.orderId).push(task);
  });
  const violations = [];
  byOrder.forEach((orderTasks, orderId) => {
    const served = orderTasks.filter((task) => task.workflowState !== 'cancelled').map((task) => asTime(task.servedAt)).filter(Boolean);
    if (served.length > 1 && Math.max(...served) - Math.min(...served) > toleranceMs)
      violations.push({ orderId, spreadMinutes: (Math.max(...served) - Math.min(...served)) / 60_000 });
  });
  return violations;
}

function simulateKitchen({ startAt, durationMinutes = 60, tickMinutes = 1, stations = [], tasks = [], config = {}, events: simulationEvents = [], serviceDelayMinutes = 0 } = {}) {
  const start = new Date(startAt || '2026-08-27T19:00:00.000Z');
  const settings = resolvedConfig(config);
  const work = clone(tasks).map((task) => ({ ...task, state: task.state || 'on-track', workflowState: task.workflowState || 'ordered' }));
  const events = [];
  const ticks = [];
  const capacityBreaches = [];
  const tick = Math.max(1, Number(tickMinutes || 1));
  for (let offset = 0; offset <= durationMinutes; offset += tick) {
    const now = new Date(start.getTime() + offset * 60_000);
    applySimulationEvents(simulationEvents, work, offset, now, events);
    work.filter((task) => task.workflowState === 'preparing' && asTime(task.completeAt) <= now.getTime()).forEach((task) => {
      task.workflowState = 'ready'; task.readyAt = now.toISOString();
      events.push({ type: 'ready', taskKey: task.taskKey, at: task.readyAt, stationId: task.stationId });
    });
    serveReadyTasks(work, now, events, serviceDelayMinutes);
    applyCoursePacing(work, now, settings);
    const arrived = work.filter((task) => task.workflowState === 'ordered' && asTime(task.orderedAt) <= now.getTime());
    const scheduled = scheduleKitchen({ now, tasks: arrived });
    const fair = applyFairness({ recommendations: scheduled, starvationAfterMinutes: settings.fairness.starvationAfterMinutes, now });
    const batches = buildBatches({ now, recommendations: fair.recommendations });
    const capacity = allocateStationCapacity({ stations: activeCapacity(stations, work), recommendations: fair.recommendations, batches });
    capacity.allocated.forEach((allocation) => applyAllocation(allocation, work, now, events));
    activeCapacity(stations, work).forEach((station) => {
      const limit = Math.max(0, Number(station.max_concurrent_tasks || station.available_capacity || 0));
      if (Number(station.occupied_capacity || 0) > limit)
        capacityBreaches.push({ stationId: station.station_id, at: now.toISOString(), occupied: station.occupied_capacity, limit });
    });
    ticks.push({
      at: now.toISOString(),
      recommendations: fair.recommendations.map((task) => task.taskKey),
      allocated: capacity.allocated.map((item) => item.workKey),
      waiting: capacity.capacityWait.map((item) => item.workKey),
      pending: work.filter((task) => task.workflowState === 'ordered' && asTime(task.orderedAt) > now.getTime()).map((task) => task.taskKey),
    });
  }
  const duplicates = events.filter((event) => event.type === 'started').reduce((result, event) => {
    result[event.taskKey] = (result[event.taskKey] || 0) + 1; return result;
  }, {});
  const end = new Date(start.getTime() + durationMinutes * 60_000);
  const targetMisses = work.filter((task) => task.workflowState !== 'cancelled' && task.servedAt && asTime(task.servedAt) > asTime(task.latestAcceptableServeAt || task.targetServeAt));
  const starved = work.filter((task) => task.workflowState === 'ordered' && asTime(task.orderedAt) <= end.getTime() && end.getTime() - asTime(task.orderedAt) >= Number(settings.fairness.starvationAfterMinutes) * 60_000);
  const sequenceViolations = courseSequenceViolations(work, settings);
  const syncViolations = synchronizationViolations(work, settings);
  return {
    tasks: work, events, ticks,
    summary: {
      total: work.length,
      started: work.filter((task) => task.startedAt).length,
      ready: work.filter((task) => task.readyAt).length,
      served: work.filter((task) => task.workflowState === 'served').length,
      cancelled: work.filter((task) => task.workflowState === 'cancelled').length,
      duplicateStarts: Object.values(duplicates).filter((count) => count > 1).length,
      unfinished: work.filter((task) => task.workflowState === 'ordered' || task.workflowState === 'preparing' || task.workflowState === 'ready' || task.workflowState === 'expo').length,
      targetMisses: targetMisses.length,
      starved: starved.length,
      capacityBreaches: capacityBreaches.length,
      courseSequenceViolations: sequenceViolations.length,
      synchronizationViolations: syncViolations.length,
    },
    validation: {
      targetMisses: targetMisses.map((task) => task.taskKey),
      starved: starved.map((task) => task.taskKey),
      capacityBreaches,
      courseSequenceViolations: sequenceViolations,
      synchronizationViolations: syncViolations,
      duplicateStarts: Object.keys(duplicates).filter((taskKey) => duplicates[taskKey] > 1),
    },
  };
}

function createRushScenario({ tables = 20, parcels = 5, itemsPerOrder = 4, startAt = '2026-08-27T19:00:00.000Z' } = {}) {
  const tasks = [];
  const courses = ['soup', 'starter', 'main', 'side'];
  const stations = [
    { station_id: 'soup', station_name: 'Soup', enabled: true, max_concurrent_tasks: 3 },
    { station_id: 'wok', station_name: 'Wok', enabled: true, max_concurrent_tasks: 4 },
    { station_id: 'tandoor', station_name: 'Tandoor', enabled: true, max_concurrent_tasks: 3 },
  ];
  const totalOrders = tables + parcels;
  for (let order = 0; order < totalOrders; order += 1) {
    const mode = order < tables ? 'table' : 'parcel';
    for (let item = 0; item < itemsPerOrder; item += 1) {
      const course = courses[item % courses.length];
      const stationId = course === 'soup' ? 'soup' : item % 3 === 0 ? 'tandoor' : 'wok';
      const ordered = new Date(asTime(startAt) + order * 20_000);
      const target = new Date(ordered.getTime() + (course === 'main' ? 28 : 16) * 60_000);
      const prep = course === 'main' ? 14 : course === 'soup' ? 7 : 10;
      tasks.push({
        taskKey: `order-${order}:line-${item}`, orderId: `order-${order}`, orderNumber: order + 1,
        itemName: `${course}-${item}`, mode, course, stationId, quantity: 1, orderedAt: ordered.toISOString(),
        targetServeAt: target.toISOString(), latestAcceptableServeAt: new Date(target.getTime() + 8 * 60_000).toISOString(), latestSafeStartAt: new Date(target.getTime() - prep * 60_000).toISOString(),
        prepWindowMinutes: prep, state: 'on-track', profile: { parallelCapacityCost: 1, batchable: course === 'soup', batchGroupId: course === 'soup' ? 'SOUP' : '', maxBatchSize: 8, optimalBatchSize: 8, batchWindowSeconds: 180, requiresPreviousCourse: mode === 'table' && course !== 'soup', longPrepItem: course === 'main' },
      });
    }
  }
  return { startAt, stations, tasks };
}

module.exports = { simulateKitchen, createRushScenario, activeCapacity, applyCoursePacing, courseStates };
