function time(value, fallback = Number.POSITIVE_INFINITY) {
  const result = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(result) ? result : fallback;
}

function compareTasks(left, right) {
  const rank = Number(left.rank || Number.MAX_SAFE_INTEGER) - Number(right.rank || Number.MAX_SAFE_INTEGER);
  if (rank) return rank;
  const safeStart = time(left.latestSafeStartAt) - time(right.latestSafeStartAt);
  if (safeStart) return safeStart;
  const ordered = time(left.orderedAt) - time(right.orderedAt);
  if (ordered) return ordered;
  const leftKey = String(left.taskKey || '');
  const rightKey = String(right.taskKey || '');
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

function modifierFingerprint(task = {}) {
  return [task.portion, task.style, task.note]
    .map((value) => String(value || '').trim().toLowerCase())
    .join('::');
}

function batchCompatibilityKey(task = {}) {
  const profile = task.profile || {};
  if (!profile.batchable || !profile.batchGroupId || !task.stationId) return '';
  return [String(profile.batchGroupId).trim().toLowerCase(), String(task.stationId), modifierFingerprint(task)].join('|');
}

function decideBatch({ earliest, now, batchWindowSeconds, totalQuantity, maxBatchSize, optimalBatchSize }) {
  const current = time(now, Date.now());
  const safeStart = time(earliest.latestSafeStartAt);
  const windowClosesAt = time(earliest.orderedAt, current) + Math.max(0, Number(batchWindowSeconds || 0)) * 1000;
  if (current >= safeStart)
    return { action: 'fire-batch', reason: 'Latest safe start time reached', windowClosesAt: new Date(windowClosesAt).toISOString() };
  if (totalQuantity >= maxBatchSize)
    return { action: 'fire-batch', reason: 'Maximum compatible batch size reached', windowClosesAt: new Date(windowClosesAt).toISOString() };
  if (totalQuantity >= optimalBatchSize)
    return { action: 'fire-batch', reason: 'Optimal compatible batch size reached', windowClosesAt: new Date(windowClosesAt).toISOString() };
  if (current >= windowClosesAt)
    return { action: 'fire-batch', reason: 'Batch window closed while preparation is still safe', windowClosesAt: new Date(windowClosesAt).toISOString() };
  return { action: 'wait-for-batch', reason: 'Compatible batch window remains safely open', windowClosesAt: new Date(windowClosesAt).toISOString() };
}

function buildBatches({ now = new Date(), recommendations = [], atomicTasks = false } = {}) {
  const grouped = new Map();
  recommendations.forEach((task) => {
    // A monitor task can still be a useful member of a safely-open batch. It
    // must not disappear simply because it is not individually urgent yet.
    if (task.taskState && !['ordered', 'eligible', 'scheduled'].includes(String(task.taskState))) return;
    if (['hold-for-course', 'manual-hold', 'served'].includes(String(task.pacingState || ''))) return;
    const key = batchCompatibilityKey(task);
    if (!key) return;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(task);
  });
  const batches = [];
  for (const [key, tasks] of grouped) {
    const ordered = [...tasks].sort(compareTasks);
    const total = ordered.reduce((sum, task) => sum + Math.max(0, Number(task.quantity || 0)), 0);
    if (total < 2) continue;
    const maxBatchSize = Math.max(1, Math.min(...ordered.map((task) => Number(task.profile?.maxBatchSize || 1))));
    const optimalBatchSize = Math.max(1, Math.min(maxBatchSize, ...ordered.map((task) => Number(task.profile?.optimalBatchSize || maxBatchSize))));
    const batchWindowSeconds = Math.max(0, Math.min(...ordered.map((task) => Number(task.profile?.batchWindowSeconds || 0))));
    const queue = ordered.map((task) => ({ task, remaining: Math.max(0, Number(task.quantity || 0)) }))
      .filter((entry) => entry.remaining > 0);
    let batchIndex = 0;
    while (queue.some((entry) => entry.remaining > 0)) {
      let remainingCapacity = maxBatchSize;
      const allocations = [];
      queue.forEach((entry) => {
        if (!remainingCapacity || !entry.remaining) return;
        if (atomicTasks && entry.remaining > remainingCapacity) return;
        const quantity = atomicTasks ? entry.remaining : Math.min(entry.remaining, remainingCapacity);
        entry.remaining -= quantity;
        remainingCapacity -= quantity;
        allocations.push({
          taskKey: entry.task.taskKey,
          orderId: entry.task.orderId,
          orderNumber: entry.task.orderNumber,
          itemName: entry.task.itemName,
          quantity,
          rank: entry.task.rank,
        });
      });
      if (!allocations.length) break;
      const earliest = queue
        .map((entry) => entry.task)
        .find((task) => allocations.some((allocation) => allocation.taskKey === task.taskKey));
      const totalQuantity = allocations.reduce((sum, allocation) => sum + allocation.quantity, 0);
      const decision = decideBatch({ earliest, now, batchWindowSeconds, totalQuantity, maxBatchSize, optimalBatchSize });
      batches.push({
        batchKey: `${key}#${++batchIndex}`,
        batchGroupId: earliest.profile.batchGroupId,
        stationId: earliest.stationId,
        modifierFingerprint: modifierFingerprint(earliest),
        totalQuantity,
        maxBatchSize,
        optimalBatchSize,
        batchWindowSeconds,
        parallelCapacityCost: Math.max(1, ...allocations.map((allocation) => Number(ordered.find((task) => task.taskKey === allocation.taskKey)?.profile?.parallelCapacityCost || 1))),
        latestSafeStartAt: earliest.latestSafeStartAt,
        targetServeAt: earliest.targetServeAt,
        allocations,
        ...decision,
      });
    }
  }
  return batches.sort((left, right) => {
    const action = left.action === right.action ? 0 : left.action === 'fire-batch' ? -1 : 1;
    const safeStart = time(left.latestSafeStartAt) - time(right.latestSafeStartAt);
    if (action || safeStart) return action || safeStart;
    return String(left.batchKey) < String(right.batchKey) ? -1 : String(left.batchKey) > String(right.batchKey) ? 1 : 0;
  });
}

module.exports = { buildBatches, batchCompatibilityKey, modifierFingerprint, decideBatch };
