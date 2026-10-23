const {
  annotateRunningOrder,
  isRunningOrderEligible,
  kitchenPriorityTier,
  compareKitchenPriority,
} = require('./smart-kds-priority');
const {
  conservativePreparationMilliseconds,
  buildPreparationPlan,
} = require('./smart-kds-preparation');

function time(value, fallback = Number.POSITIVE_INFINITY) {
  if (value == null || value === '') return fallback;
  const result = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(result) ? result : fallback;
}
const iso = (value) => (Number.isFinite(value) ? new Date(value).toISOString() : null);
const positive = (value, fallback = 1) =>
  Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback;

function batchPreparationMilliseconds(task) {
  // Individual calibration is not evidence that a shared pan cooks faster.
  return Math.max(
    conservativePreparationMilliseconds(task),
    conservativePreparationMilliseconds({ ...task, learning: undefined })
  );
}

function safeStart(task) {
  return Math.min(
    time(task.latestSafeStartAt),
    time(task.effectiveLatestSafeStartAt),
    time(buildPreparationPlan(task).effectiveLatestSafeStartAt)
  );
}

function compareTasks(left, right) {
  return (
    compareKitchenPriority(left, right) ||
    positive(left.rank, Number.MAX_SAFE_INTEGER) - positive(right.rank, Number.MAX_SAFE_INTEGER) ||
    safeStart(left) - safeStart(right) ||
    time(left.orderedAt) - time(right.orderedAt) ||
    String(left.taskKey || '').localeCompare(String(right.taskKey || ''))
  );
}

function modifierFingerprint(task = {}) {
  const addonFingerprint = (Array.isArray(task.modifiers) ? task.modifiers : [])
    .flatMap((group) =>
      (group.options || []).map(
        (option) =>
          `${group.groupId || group.groupName}:${option.optionId || option.name}:${option.quantity || 1}`
      )
    )
    .sort()
    .join('|');
  return [task.portion, task.style, task.note, task.orderNote, addonFingerprint]
    .map((value) =>
      String(value || '')
        .trim()
        .toLowerCase()
    )
    .join('::');
}

function batchCompatibilityKey(task = {}) {
  const profile = task.profile || {};
  if (!profile.batchable || !profile.batchGroupId || !task.stationId) return '';
  // Approval of a pan limit never means rice and biryani are one recipe.
  const identity = String(
    task.itemKey || profile.itemKey || `${task.category || ''}::${task.itemName || ''}`
  )
    .trim()
    .toLowerCase();
  return [
    String(profile.batchGroupId).trim().toLowerCase(),
    String(task.stationId),
    identity,
    modifierFingerprint(task),
  ].join('|');
}

function earliestCookingStart(task, batchDuration, now) {
  if (
    task.courseMode !== 'serve_together' &&
    !['sync-watch', 'sync-start'].includes(task.pacingState)
  )
    return now;
  const target = time(task.pacingTargetServeAt || task.targetServeAt);
  const hold = task.profile?.canHoldAfterCooking
    ? Math.max(0, Number(task.profile.maxHoldTime) || 0) * 60_000
    : 0;
  if (Number.isFinite(target)) return Math.max(now, target - batchDuration - hold);
  return Math.max(now, time(task.plannedStartAt, now) - hold);
}

function decideBatch({
  earliest = {},
  members = [earliest],
  now,
  batchWindowSeconds = 0,
  totalQuantity,
  maxBatchSize,
  optimalBatchSize,
  runningOrder = false,
}) {
  const current = time(now, Date.now());
  const safe = Math.min(...members.map(safeStart));
  const collectionStarted = Math.min(...members.map((task) => time(task.orderedAt, current)));
  const windowCloses = collectionStarted + Math.max(0, Number(batchWindowSeconds) || 0) * 1000;
  const holdUntil = Math.min(windowCloses, safe);
  const duration = Math.max(...members.map(batchPreparationMilliseconds));
  const earliestStart = Math.max(
    current,
    ...members.map((task) => earliestCookingStart(task, duration, current))
  );
  const urgent = runningOrder || members.some((task) => kitchenPriorityTier(task) < 3);
  const full = totalQuantity >= maxBatchSize;
  const optimal = totalQuantity >= optimalBatchSize;
  const quietKitchen =
    members.length > 0 && members.every((task) => task.learning?.loadBand === 'quiet');
  const trigger =
    current >= safe || urgent || full || optimal || quietKitchen || current >= windowCloses;
  const plannedFire = Math.max(earliestStart, trigger ? current : holdUntil);
  const timingConflict = earliestStart > Math.max(current, safe);
  const metadata = {
    collectionStartedAt: iso(collectionStarted),
    windowClosesAt: iso(windowCloses),
    holdUntilAt: iso(holdUntil),
    earliestStartAt: iso(earliestStart),
    plannedFireAt: iso(plannedFire),
    timingConflict,
  };
  if (current < earliestStart && timingConflict)
    return {
      action: 'wait-for-batch',
      reason:
        'Synchronized cooking window conflicts with the saved safe start; expo must resolve timing',
      ...metadata,
    };
  if (current < earliestStart)
    return {
      action: 'wait-for-batch',
      reason:
        current >= holdUntil
          ? 'Collection closed; waiting for the synchronized cooking window'
          : 'Collect compatible portions within the synchronized cooking window',
      ...metadata,
    };
  if (current >= safe)
    return { action: 'fire-batch', reason: 'Latest safe start time reached', ...metadata };
  if (runningOrder || members.some(isRunningOrderEligible))
    return {
      action: 'fire-batch',
      reason: 'Running order / additional portion, priority; do not wait for more portions',
      ...metadata,
    };
  if (urgent)
    return {
      action: 'fire-batch',
      reason: 'Critical service or manual priority; do not wait for more portions',
      ...metadata,
    };
  if (full)
    return { action: 'fire-batch', reason: 'Maximum compatible batch size reached', ...metadata };
  if (optimal)
    return { action: 'fire-batch', reason: 'Optimal compatible batch size reached', ...metadata };
  if (quietKitchen)
    return {
      action: 'fire-batch',
      reason: 'Quiet kitchen; no need to wait for more portions',
      ...metadata,
    };
  if (current >= windowCloses)
    return {
      action: 'fire-batch',
      reason: 'Batch window closed while preparation is still safe',
      ...metadata,
    };
  return {
    action: 'wait-for-batch',
    reason: 'Compatible batch window remains safely open',
    ...metadata,
  };
}

function groupSettings(members) {
  const maximum = Math.max(
    1,
    Math.min(...members.map((task) => positive(task.profile?.maxBatchSize)))
  );
  return {
    maxBatchSize: maximum,
    optimalBatchSize: Math.min(
      maximum,
      ...members.map((task) => positive(task.profile?.optimalBatchSize, maximum))
    ),
    batchWindowSeconds: Math.max(
      0,
      Math.min(...members.map((task) => Math.max(0, Number(task.profile?.batchWindowSeconds) || 0)))
    ),
  };
}

function timingCompatible(members, now) {
  if (members.length < 2) return true;
  const settings = groupSettings(members);
  const common = decideBatch({
    members,
    now,
    totalQuantity: members.reduce((sum, task) => sum + task.quantity, 0),
    ...settings,
  });
  const duration = Math.max(...members.map(batchPreparationMilliseconds));
  const floor = Math.max(...members.map((task) => earliestCookingStart(task, duration, now)));
  const earliestSafe = Math.min(...members.map(safeStart));
  // Joining a later table must neither miss an older deadline nor extend an
  // older item's collection window merely to synchronize the later table.
  if (floor > Math.max(now, earliestSafe)) return false;
  const earliestSoloRelease = Math.min(
    ...members.map((task) =>
      time(
        decideBatch({
          earliest: task,
          members: [task],
          now,
          totalQuantity: task.quantity,
          ...groupSettings([task]),
        }).plannedFireAt
      )
    )
  );
  return time(common.plannedFireAt) <= earliestSoloRelease;
}

function allocationFor(task, quantity) {
  return {
    taskKey: task.taskKey,
    orderId: task.orderId,
    orderNumber: task.orderNumber,
    itemName: task.itemName,
    modifiers: task.modifiers,
    portion: task.portion,
    style: task.style,
    note: task.note || '',
    orderNote: task.orderNote || '',
    quantity,
    rank: task.rank,
    tableArea: task.tableArea || '',
    tableNumber: task.tableNumber || null,
    course: task.course || '',
    courseMode: task.courseMode || '',
    pacingState: task.pacingState || '',
    targetServeAt: task.targetServeAt || null,
    latestAcceptableServeAt: task.latestAcceptableServeAt || null,
    latestSafeStartAt: task.latestSafeStartAt || null,
    effectiveLatestSafeStartAt: iso(safeStart(task)),
    plannedStartAt: task.plannedStartAt || null,
  };
}

function buildBatches({ now = new Date(), recommendations = [], atomicTasks = false } = {}) {
  const current = time(now, Date.now());
  const grouped = new Map();
  recommendations.map(annotateRunningOrder).forEach((task) => {
    if (task.taskState && !['ordered', 'eligible', 'scheduled'].includes(String(task.taskState)))
      return;
    if (['hold-for-course', 'manual-hold', 'served'].includes(String(task.pacingState || '')))
      return;
    if (['hold', 'defer'].includes(task.manualOverride?.action)) return;
    const key = batchCompatibilityKey(task);
    if (!key) return;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(task);
  });
  const batches = [];
  for (const [key, tasks] of grouped) {
    const queue = [...tasks]
      .sort(compareTasks)
      .map((task) => ({ task, remaining: Math.max(0, Number(task.quantity) || 0) }))
      .filter((entry) => entry.remaining > 0);
    let batchIndex = 0;
    while (queue.some((entry) => entry.remaining > 0)) {
      const members = [];
      const allocations = [];
      for (const entry of queue) {
        if (!entry.remaining) continue;
        const settings = groupSettings([...members, entry.task]);
        const remainingCapacity =
          settings.maxBatchSize -
          allocations.reduce((sum, allocation) => sum + allocation.quantity, 0);
        if (remainingCapacity < 1 || (atomicTasks && entry.remaining > remainingCapacity)) continue;
        const quantity = atomicTasks
          ? entry.remaining
          : Math.min(entry.remaining, remainingCapacity);
        const portion = { ...entry.task, quantity };
        if (!timingCompatible([...members, portion], current)) continue;
        members.push(portion);
        allocations.push(allocationFor(portion, quantity));
        entry.remaining -= quantity;
      }
      // Atomic production records larger than their approved pan limit are
      // left for the caller to split/reassign, never partially acknowledged.
      if (!allocations.length) break;
      const settings = groupSettings(members);
      const earliest = [...members].sort((a, b) => safeStart(a) - safeStart(b))[0];
      const totalQuantity = allocations.reduce((sum, allocation) => sum + allocation.quantity, 0);
      const runningOrder = members.some(isRunningOrderEligible);
      const priority = Math.min(...members.map(kitchenPriorityTier));
      const tableIds = new Set(
        members
          .filter((task) => task.tableNumber != null && task.tableNumber !== '')
          .map((task) => `${task.tableArea || ''}:${task.tableNumber}`)
      );
      batches.push({
        batchKey: `${key}#${++batchIndex}`,
        batchGroupId: earliest.profile.batchGroupId,
        stationId: earliest.stationId,
        modifierFingerprint: modifierFingerprint(earliest),
        totalQuantity,
        ...settings,
        tableCount: tableIds.size,
        orderCount: new Set(members.map((task) => task.orderId)).size,
        runningOrder,
        runningOrderReason: runningOrder
          ? members.find(isRunningOrderEligible).runningOrderReason
          : '',
        priorityClass:
          priority === 0
            ? 'critical'
            : priority === 1
              ? 'manual-rush'
              : runningOrder
                ? 'running'
                : 'normal',
        parallelCapacityCost: Math.max(
          1,
          ...members.map((task) => positive(task.profile?.parallelCapacityCost))
        ),
        latestSafeStartAt: iso(safeStart(earliest)),
        targetServeAt: earliest.targetServeAt,
        allocations,
        ...decideBatch({
          earliest,
          members,
          now: current,
          totalQuantity,
          runningOrder,
          ...settings,
        }),
      });
    }
  }
  return batches.sort(
    (left, right) =>
      compareKitchenPriority(left, right) ||
      (left.action === right.action ? 0 : left.action === 'fire-batch' ? -1 : 1) ||
      time(left.latestSafeStartAt) - time(right.latestSafeStartAt) ||
      String(left.batchKey).localeCompare(String(right.batchKey))
  );
}

module.exports = {
  buildBatches,
  batchCompatibilityKey,
  modifierFingerprint,
  decideBatch,
  batchPreparationMilliseconds,
};
