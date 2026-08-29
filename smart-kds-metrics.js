function time(value) {
  if (value === null || value === undefined || value === '') return null;
  const result = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(result) ? result : null;
}

function minutesBetween(start, end) {
  const from = time(start), to = time(end);
  return from === null || to === null || to < from ? null : (to - from) / 60_000;
}

function average(values = []) {
  const valid = values.filter((value) => Number.isFinite(value));
  return valid.length ? Math.round((valid.reduce((sum, value) => sum + value, 0) / valid.length) * 10) / 10 : null;
}

function asObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  try { return JSON.parse(value || '{}'); } catch (_) { return {}; }
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  try { return JSON.parse(value || '[]'); } catch (_) { return []; }
}

function groupByOrder(rows = []) {
  return rows.reduce((grouped, row) => {
    const key = String(row.order_id || '');
    if (!key) return grouped;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
    return grouped;
  }, new Map());
}

// Service events are immutable delivery history. A course row intentionally
// represents only the current state and can be reopened by a later add-on.
function deliveryTimesForOrder(courseRows = [], serviceRows = []) {
  const fromEvents = serviceRows.map((row) => time(row.served_at)).filter((value) => value !== null);
  const source = fromEvents.length ? fromEvents : courseRows.map((row) => time(row.served_at)).filter((value) => value !== null);
  return source.sort((left, right) => left - right);
}

function buildKitchenMetrics({
  orders = [], courses = [], tasks = [], batches = [], events = [], decisions = [], orderEvents = [], serviceEvents = [], stations = [], rangeStart, now = new Date(),
} = {}) {
  const start = time(rangeStart) ?? time(now) ?? Date.now();
  const end = time(now) ?? Date.now();
  const orderById = new Map(orders.map((order) => [String(order.id), order]));
  const allCoursesByOrder = groupByOrder(courses.filter((course) => orderById.has(String(course.order_id))));
  const serviceEventsByOrder = groupByOrder(serviceEvents.filter((event) => orderById.has(String(event.order_id))));
  const servedCourses = courses.filter((course) => course.served_at && orderById.has(String(course.order_id)));
  const courseDurations = servedCourses.map((course) => ({
    course: String(course.course_type || 'other'),
    minutes: minutesBetween(orderById.get(String(course.order_id))?.created_at, course.served_at),
    late: time(course.latest_acceptable_serve_at) !== null && time(course.served_at) > time(course.latest_acceptable_serve_at),
  }));
  const firstFood = [];
  const orderSla = [];
  const serviceGaps = [];
  allCoursesByOrder.forEach((orderCourses, orderId) => {
    const order = orderById.get(orderId);
    const servedAt = deliveryTimesForOrder(orderCourses, serviceEventsByOrder.get(orderId) || []);
    if (String(order?.mode) === 'table' && servedAt.length) {
      const firstFoodMinutes = minutesBetween(order.created_at, servedAt[0]);
      if (firstFoodMinutes !== null) firstFood.push(firstFoodMinutes);
      for (let index = 1; index < servedAt.length; index += 1) serviceGaps.push((servedAt[index] - servedAt[index - 1]) / 60_000);
    }
    // Only completed orders are SLA-eligible. An add-on changes the current
    // course state back to unfinished, so it correctly waits for its delivery.
    const complete = orderCourses.length > 0 && orderCourses.every((course) => course.course_state === 'served' || Boolean(course.served_at));
    if (complete) orderSla.push({ late: orderCourses.some((course) => time(course.latest_acceptable_serve_at) !== null && time(course.served_at) > time(course.latest_acceptable_serve_at)) });
  });
  const courseMetrics = ['soup', 'starter', 'main'].map((course) => {
    const matches = courseDurations.filter((item) => item.course === course);
    const served = matches.length;
    const late = matches.filter((item) => item.late).length;
    return { course, served, late, averageServiceMinutes: average(matches.map((item) => item.minutes)), slaPercent: served ? Math.round(((served - late) / served) * 1000) / 10 : null };
  });
  const stationById = new Map(stations.map((station) => [String(station.station_id), station]));
  const prepEstimateErrors = tasks.map((task) => {
    const actual = minutesBetween(task.preparing_at, task.ready_at);
    const estimated = Number(asObject(task.profile_snapshot).prepTimeEstimate || 0);
    return Number.isFinite(actual) && estimated > 0 ? Math.abs(actual - estimated) : null;
  });
  const stationTasks = new Map();
  tasks.forEach((task) => {
    const stationId = String(task.station_id || 'unassigned');
    if (!stationTasks.has(stationId)) stationTasks.set(stationId, []);
    stationTasks.get(stationId).push(task);
  });
  const rangeMinutes = Math.max(1, (end - start) / 60_000);
  const stationMetrics = [...stationTasks.entries()].map(([stationId, rows]) => {
    const station = stationById.get(stationId) || {};
    const capacity = Math.max(1, Number(station.max_concurrent_tasks || 1));
    const prepDurations = rows.map((task) => minutesBetween(task.preparing_at, task.ready_at || now));
    const actualPrep = rows.map((task) => minutesBetween(task.preparing_at, task.ready_at));
    const estimates = rows.map((task) => Number(asObject(task.profile_snapshot).prepTimeEstimate || 0));
    const totalBusy = prepDurations.filter(Number.isFinite).reduce((sum, value) => sum + value, 0);
    const pairedAccuracy = actualPrep.map((value, index) => Number.isFinite(value) && estimates[index] > 0 ? Math.abs(value - estimates[index]) : null);
    return {
      stationId, stationName: station.station_name || stationId, capacity,
      tasks: rows.length,
      averageQueueMinutes: average(rows.map((task) => minutesBetween(task.created_at, task.preparing_at))),
      averagePrepMinutes: average(actualPrep),
      prepEstimateErrorMinutes: average(pairedAccuracy),
      utilizationPercent: Math.min(100, Math.round((totalBusy / (rangeMinutes * capacity)) * 1000) / 10),
    };
  }).sort((left, right) => left.stationName.localeCompare(right.stationName));
  const firedBatches = batches.filter((batch) => batch.fired_at);
  const batchSizes = firedBatches.map((batch) => Number(asObject(batch.config_snapshot).totalQuantity || 0)).filter((value) => value > 0);
  const batchEfficiency = firedBatches.map((batch) => {
    const snapshot = asObject(batch.config_snapshot);
    const max = Number(snapshot.maxBatchSize || 0), total = Number(snapshot.totalQuantity || 0);
    return max > 0 && total > 0 ? Math.min(100, (total / max) * 100) : null;
  });
  const eventType = (event) => String(event.event_type || '');
  const overrideCount = events.filter((event) => eventType(event).startsWith('override-')).length;
  const staffActionCount = events.filter((event) => /^(manual-|override-)/.test(eventType(event))).length;
  const audits = events.map((event) => ({ type: 'action', at: event.created_at, taskId: event.task_id, orderId: event.order_id, action: event.event_type, actor: event.actor_id || 'System', details: asObject(event.details) }));
  const orderAudits = orderEvents.map((event) => {
    const details = asObject(event.details);
    return { type: 'order-event', at: event.created_at, orderId: event.order_id, action: event.event_type, actor: details.operator || details.captainName || details.captainId || 'System', details };
  });
  const decisionAudits = decisions.map((decision) => ({ type: 'decision', at: decision.calculated_at, taskId: decision.task_id, orderId: decision.order_id, action: decision.action, rank: decision.priority_rank, reasonCodes: asArray(decision.reason_codes), details: asObject(decision.input_snapshot) }));
  return {
    generatedAt: new Date(end).toISOString(),
    summary: {
      averageFirstFoodMinutes: average(firstFood),
      ordersMeasured: orderSla.length,
      orderSlaPercent: orderSla.length ? Math.round(((orderSla.length - orderSla.filter((item) => item.late).length) / orderSla.length) * 1000) / 10 : null,
      lateOrders: orderSla.filter((item) => item.late).length,
      lateCourses: courseDurations.filter((item) => item.late).length,
      averageReadyToServedMinutes: average(tasks.map((task) => minutesBetween(task.ready_at, task.served_at))),
      averagePrepEstimateErrorMinutes: average(prepEstimateErrors),
      averageServiceGapMinutes: average(serviceGaps),
      tableServiceGaps: serviceGaps.length,
      refires: events.filter((event) => eventType(event) === 'override-refire').length,
      cancellations: tasks.filter((task) => task.cancelled_at).length,
      manualOverrides: overrideCount,
      staffActions: staffActionCount,
      firedBatches: firedBatches.length,
      averageBatchSize: average(batchSizes),
      batchEfficiencyPercent: average(batchEfficiency),
    },
    courses: courseMetrics,
    stations: stationMetrics,
    audit: [...audits, ...orderAudits, ...decisionAudits].sort((left, right) => (time(right.at) || 0) - (time(left.at) || 0)).slice(0, 250),
  };
}

module.exports = { asObject, average, minutesBetween, buildKitchenMetrics, deliveryTimesForOrder };
