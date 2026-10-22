const { batchCompatibilityKey } = require('./smart-kds-batching');
const { modifierText } = require('./addons-domain');
const { annotateRunningOrder, isRunningOrderEligible, kitchenPriorityTier, compareKitchenPriority } = require('./smart-kds-priority');
const {
  cookingWaves: waves,
  conservativePreparationMilliseconds: duration,
  buildPreparationPlan,
} = require('./smart-kds-preparation');

const MINUTE = 60_000;
const PENDING = new Set(['ordered', 'eligible', 'scheduled']);
const COMPLETE = new Set(['served', 'cancelled', 'superseded']);
const HELD = new Set(['hold-for-course', 'manual-hold', 'served']);

function timestamp(value, fallback = null) {
  if (value == null || value === '') return fallback;
  const result = new Date(value).getTime();
  return Number.isFinite(result) ? result : fallback;
}
const iso = (value) => (Number.isFinite(value) ? new Date(value).toISOString() : null);
const number = (value, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
const quantity = (task) => Math.max(1, number(task.quantity, 1));
const cost = (task) =>
  Math.max(1, Math.min(50, Math.floor(number(task.profile?.parallelCapacityCost, 1))));
const held = (task) =>
  task.taskState === 'held' ||
  (PENDING.has(task.taskState || 'ordered') &&
    (HELD.has(task.pacingState) || ['hold', 'defer'].includes(task.manualOverride?.action)));
const destination = (task) =>
  `${task.tableNumber ? `${task.tableArea ? `${task.tableArea} ` : ''}table ${task.tableNumber}, ` : ''}order ${task.orderNumber || task.orderId}`;

function boundedText(value, limit) {
  const clean = String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.length > limit ? `${clean.slice(0, limit - 1)}…` : clean;
}

function cookingLabel(task, name = task.itemName || 'item') {
  const details = [
    ['Portion', boundedText(task.portion, 80)],
    ['Style', boundedText(task.style, 80)],
    ['Add-ons', boundedText(modifierText(task.modifiers), 240)],
    ['Chef note', boundedText(task.note, 240)],
  ]
    .filter(([, value]) => value)
    .map(([label, value]) => `${label}: ${value}`);
  return `${boundedText(name, 200)}${details.length ? ` (${details.join('; ')})` : ''}`;
}

// A future reservation must not block a short job that fits before it. Check
// the whole interval rather than allocating a lane until its last future job.
function earliestSlot(bookings, capacity, required, release, milliseconds) {
  if (required > capacity || capacity < 1) return null;
  const candidates = [
    ...new Set([
      release,
      ...bookings.map((booking) => booking.end).filter((end) => end >= release),
    ]),
  ].sort((a, b) => a - b);
  for (const start of candidates) {
    const end = start + milliseconds;
    const overlapping = bookings.filter((booking) => booking.start < end && booking.end > start);
    const points = [
      start,
      ...overlapping.map((booking) => booking.start).filter((point) => point > start),
    ];
    if (
      points.every(
        (point) =>
          required +
            overlapping.reduce(
              (sum, booking) =>
                sum + (booking.start <= point && booking.end > point ? booking.cost : 0),
              0
            ) <=
          capacity
      )
    )
      return start;
  }
  return null;
}

function compareTasks(left, right) {
  return (
    compareKitchenPriority(left, right) ||
    number(left.finalRank || left.rank, Number.MAX_SAFE_INTEGER) -
      number(right.finalRank || right.rank, Number.MAX_SAFE_INTEGER) ||
    timestamp(left.effectiveLatestSafeStartAt || left.latestSafeStartAt, Infinity) -
      timestamp(right.effectiveLatestSafeStartAt || right.latestSafeStartAt, Infinity) ||
    String(left.taskKey).localeCompare(String(right.taskKey))
  );
}

function cookRelease(task, now) {
  if (
    (task.baseAction || task.action) === 'start-now' ||
    isRunningOrderEligible(task) ||
    ['rush', 'fire-now'].includes(task.manualOverride?.action)
  )
    return now;
  const planned = Math.min(
    timestamp(task.plannedStartAt, Infinity),
    timestamp(task.effectiveLatestSafeStartAt || task.latestSafeStartAt, Infinity)
  );
  const holdAllowance = task.profile?.canHoldAfterCooking
    ? Math.max(0, number(task.profile.maxHoldTime)) * MINUTE
    : 0;
  return Math.max(now, Number.isFinite(planned) ? planned - holdAllowance : now);
}

function stationLevel(station) {
  if (!station.enabled || station.totalCapacity < 1)
    return station.queuedTasks ? 'blocked' : 'quiet';
  const workMinutesPerSlot = station.workloadMinutes / station.totalCapacity;
  if (
    station.overCapacity > 0 ||
    workMinutesPerSlot >= 35 ||
    station.queuedTasks >= station.totalCapacity * 5
  )
    return 'surge';
  if (workMinutesPerSlot >= 20 || station.queuedTasks > station.totalCapacity * 2) return 'busy';
  return station.queuedTasks || station.occupiedCapacity ? 'steady' : 'quiet';
}

function makeWork(tasks, batches, now) {
  const byTask = new Map(tasks.map((task) => [task.taskKey, task]));
  const used = new Set();
  const work = [];
  for (const batch of batches) {
    const members = (batch.allocations || []).map((allocation) => byTask.get(allocation.taskKey));
    if (
      !members.length ||
      members.some(
        (task) =>
          !task || used.has(task.taskKey) || !PENDING.has(task.taskState || 'ordered') || held(task)
      )
    )
      continue;
    const compatibility = batchCompatibilityKey(members[0]);
    if (
      !compatibility ||
      members.some(
        (task) =>
          batchCompatibilityKey(task) !== compatibility || task.stationId !== batch.stationId
      )
    )
      continue;
    if (
      (batch.allocations || []).some(
        (allocation, index) => number(allocation.quantity) !== quantity(members[index])
      )
    )
      continue;
    const portions = members.reduce((sum, task) => sum + quantity(task), 0);
    if (
      portions >
      Math.min(...members.map((task) => Math.max(1, number(task.profile?.maxBatchSize, 1))))
    )
      continue;
    const safeStart = Math.min(
      ...members.map((task) => timestamp(task.latestSafeStartAt, Infinity))
    );
    const release =
      batch.action === 'fire-batch'
        ? now
        : Math.max(now, Math.min(timestamp(batch.windowClosesAt, safeStart), safeStart));
    members.forEach((task) => used.add(task.taskKey));
    work.push({
      id: batch.batchId || batch.batchKey,
      batch,
      tasks: members,
      stationId: batch.stationId,
      cost: Math.max(...members.map(cost)),
      duration: Math.max(...members.map(duration)),
      release,
      priorityTask: [...members].sort(compareKitchenPriority)[0],
      rank: Math.min(
        ...members.map((task) => number(task.finalRank || task.rank, Number.MAX_SAFE_INTEGER))
      ),
    });
  }
  tasks
    .filter(
      (task) => !used.has(task.taskKey) && PENDING.has(task.taskState || 'ordered') && !held(task)
    )
    .forEach((task) => {
      work.push({
        id: task.taskKey,
        tasks: [task],
        stationId: task.stationId,
        cost: cost(task),
        duration: duration(task),
        release: cookRelease(task, now),
        priorityTask: task,
        rank: number(task.finalRank || task.rank, Number.MAX_SAFE_INTEGER),
      });
    });
  return work.sort(
    (a, b) => compareKitchenPriority(a.priorityTask, b.priorityTask) || a.rank - b.rank || a.release - b.release || String(a.id).localeCompare(String(b.id))
  );
}

function prepInstruction(task, now) {
  const profile = task.profile || {};
  if (!PENDING.has(task.taskState || 'ordered') && task.taskState !== 'held') return null;
  const message = profile.preparationAlert || profile.menuKnowledge?.preparationAlert;
  const immediate =
    profile.immediatePreparationAlert === true ||
    profile.menuKnowledge?.immediatePreparationAlert === true;
  if (!message) return null;
  const lead =
    Math.max(
      0,
      number(profile.preparationLeadMinutes ?? profile.menuKnowledge?.preparationLeadMinutes)
    ) * MINUTE;
  const due = timestamp(task.effectiveLatestSafeStartAt || task.latestSafeStartAt, now) - lead;
  if (!immediate && now < due) return null;
  return { message, immediate };
}

/** Read-only advice derived from recorded kitchen acknowledgements. Never
 * infer that food was physically started, finished, thawed, or served. */
function buildKitchenExpediter({
  now = new Date(),
  recommendations = [],
  stationPlans = [],
  batches = [],
  staleOrders = [],
  config = {},
} = {}) {
  const current = timestamp(now, Date.now());
  const staleOrderIds = new Set(staleOrders.map((order) => String(order.id)));
  const tasks = recommendations
    .filter(
      (task) =>
        task?.taskKey && !COMPLETE.has(task.taskState) && !staleOrderIds.has(String(task.orderId))
    )
    .map((task) => ({ ...annotateRunningOrder(task), ...buildPreparationPlan(task) }))
    .sort(compareTasks);
  const alerts = [];
  const calls = [];
  const forecasts = new Map();
  const ackGrace = Math.max(1, number(config.expediter?.acknowledgementMinutes, 2)) * MINUTE;
  const missedGrace = Math.max(0, number(config.expediter?.missedStartGraceMinutes, 1)) * MINUTE;
  const stations = new Map(
    stationPlans.map((plan) => [
      String(plan.stationId || ''),
      {
        stationId: String(plan.stationId || ''),
        stationName: String(plan.stationName || plan.stationId || ''),
        enabled: plan.enabled !== false,
        totalCapacity: Math.max(0, Math.min(50, Math.floor(number(plan.totalCapacity)))),
        occupiedCapacity: Math.max(0, number(plan.occupiedCapacity)),
        overCapacity: Math.max(0, number(plan.overCapacity)),
        queuedPortions: 0,
        queuedTasks: 0,
        workloadMinutes: 0,
        estimatedClearMinutes: 0,
        bookings: [],
      },
    ])
  );

  // Count an acknowledged active batch only once. Fired-but-unacknowledged
  // jobs also reserve a slot: issuing more conflicting calls is not useful.
  const activeGroups = new Map();
  tasks
    .filter((task) => ['preparing', 'fired'].includes(task.taskState))
    .forEach((task) => {
      const key = `${task.stationId}:${task.activeBatchId || task.taskKey}`;
      if (!activeGroups.has(key)) activeGroups.set(key, []);
      activeGroups.get(key).push(task);
    });
  const knownOccupied = new Map();
  for (const members of activeGroups.values()) {
    const station = stations.get(String(members[0].stationId || ''));
    const required = Math.max(...members.map(cost));
    knownOccupied.set(station?.stationId, (knownOccupied.get(station?.stationId) || 0) + required);
    const ends = members.map((task) => {
      const started = timestamp(task.preparingAt || task.preparing_at);
      const expected = started == null ? current + duration(task) : started + duration(task);
      // Past estimates need staff confirmation. Reserve a small conservative
      // continuation rather than pretending the occupied station is free.
      return Math.max(
        current + (expected <= current ? Math.max(2 * MINUTE, duration(task) / 4) : 0),
        expected
      );
    });
    const end = Math.max(...ends);
    if (station) {
      station.bookings.push({ start: current, end, cost: required });
      station.workloadMinutes += ((end - current) / MINUTE) * required;
    }
    members.forEach((task, index) =>
      forecasts.set(task.taskKey, {
        start: timestamp(task.preparingAt || task.preparing_at, current),
        ready: ends[index],
        queue: 0,
        unknown: !timestamp(task.preparingAt || task.preparing_at),
      })
    );
  }
  for (const station of stations.values()) {
    const unknown = Math.max(
      0,
      station.occupiedCapacity - (knownOccupied.get(station.stationId) || 0)
    );
    if (unknown) {
      const estimate =
        Math.max(
          5,
          ...tasks
            .filter((task) => task.stationId === station.stationId)
            .map((task) => duration(task) / MINUTE),
          15
        ) * MINUTE;
      station.bookings.push({ start: current, end: current + estimate, cost: unknown });
      station.workloadMinutes += (estimate / MINUTE) * unknown;
      alerts.push({
        id: `station:${station.stationId}:unknown-active`,
        type: 'unknown-active',
        severity: 'info',
        urgent: false,
        stationId: station.stationId,
        message: `${station.stationName}: confirm remaining time for ${unknown} active station slot${unknown === 1 ? '' : 's'}; forecast uses an estimate.`,
      });
    }
  }

  const work = makeWork(tasks, batches, current);
  for (const unit of work) {
    const station = stations.get(String(unit.stationId || ''));
    let start = null;
    let blockedReason = 'Assign a kitchen station before cooking';
    if (station) {
      station.queuedTasks += unit.tasks.length;
      station.queuedPortions += unit.tasks.reduce((sum, task) => sum + quantity(task), 0);
      station.workloadMinutes += (unit.duration / MINUTE) * unit.cost;
      blockedReason =
        !station.enabled || station.totalCapacity < 1
          ? 'Station unavailable; ask expo to assign capacity'
          : unit.cost > station.totalCapacity
            ? 'Work exceeds station capacity; ask expo to split or reassign it'
            : '';
      if (!blockedReason)
        start = earliestSlot(
          station.bookings,
          station.totalCapacity,
          unit.cost,
          unit.release,
          unit.duration
        );
      if (start != null)
        station.bookings.push({ start, end: start + unit.duration, cost: unit.cost });
    }
    unit.tasks.forEach((task) =>
      forecasts.set(task.taskKey, {
        start,
        ready: start == null ? null : start + unit.duration,
        queue: start == null ? null : Math.max(0, (start - current) / MINUTE),
        blockedReason,
        unit,
      })
    );
  }

  const enriched = tasks.map((task) => {
    const state = task.taskState || 'ordered';
    const forecast = forecasts.get(task.taskKey) || {};
    const prep = prepInstruction(task, current);
    const latestStart = timestamp(task.effectiveLatestSafeStartAt || task.latestSafeStartAt);
    const target = timestamp(task.targetServeAt);
    const delayMinutes =
      forecast.ready == null || target == null
        ? 0
        : Math.max(0, Math.ceil((forecast.ready - target) / MINUTE));
    const label = `${quantity(task)}× ${cookingLabel(task)}`;
    let signal = 'yellow';
    let phase = 'next';
    let status = 'Prepare next';
    let instruction;
    let reason = task.finalReason || task.priorityReason || '';
    let priority = 50;
    let callType = 'next';
    if (held(task) && !['preparing', 'fired', 'ready', 'expo'].includes(state)) {
      phase = 'hold';
      status = 'Hold cooking';
      priority = 90;
      reason = task.pacingReason || 'Waiting for an authorised course release';
      instruction = `Keep ${label} on hold. ${reason}.`;
    } else if (state === 'ready' || state === 'expo') {
      phase = 'ready';
      signal = 'neutral';
      status = state === 'expo' ? 'At expo' : 'Ready for expo';
      priority = 25;
      callType = 'expo';
      reason = 'Kitchen has recorded this item ready; confirm service';
      instruction = `${label}: ${state === 'expo' ? 'send from expo' : 'collect for expo'} for ${destination(task)}.`;
    } else if (state === 'preparing') {
      const started = timestamp(task.preparingAt || task.preparing_at);
      const overdue = started != null && current >= started + duration(task) + missedGrace;
      phase = overdue ? 'cook-overdue' : 'cooking';
      signal = overdue ? 'red' : 'neutral';
      status = overdue ? 'Check cooking' : 'Cooking';
      priority = overdue ? 5 : 80;
      callType = 'check';
      reason = overdue
        ? 'Recorded preparation has exceeded its conservative cooking estimate'
        : 'Preparation was acknowledged by kitchen staff';
      instruction = overdue
        ? `Check ${label} now; cooking is over its estimate. Confirm progress or mark ready when finished.`
        : `${label} is cooking; mark ready when finished.`;
    } else if (state === 'fired') {
      const fired = timestamp(
        task.firedAt || task.fired_at || task.scheduledAt || task.scheduled_at
      );
      const overdue = fired == null || current - fired >= ackGrace;
      phase = overdue ? 'fired-unacknowledged' : 'fired';
      signal = overdue ? 'red' : 'green';
      status = overdue ? 'Start not acknowledged' : 'Confirm start';
      priority = overdue ? 0 : 10;
      callType = 'start';
      reason = 'Fired instruction is awaiting the cook’s preparation acknowledgement';
      instruction = `Confirm ${label} has started for ${destination(task)}; tap Preparing when work begins.`;
    } else if (forecast.blockedReason) {
      phase = 'blocked';
      signal = 'red';
      status = 'Needs expo';
      priority = 3;
      callType = 'check';
      reason = forecast.blockedReason;
      instruction = `${label}: ${reason}.`;
    } else if (latestStart != null && current > latestStart + missedGrace) {
      phase = 'missed-start';
      signal = 'red';
      status = 'Start overdue';
      priority = 1;
      callType = 'start';
      reason = 'Latest safe start passed without a recorded preparation start';
      instruction =
        forecast.start > current || task.capacityState !== 'allocated'
          ? `${label} for ${destination(task)}: start is overdue. Expo, clear capacity${forecast.queue ? `; next estimated slot is in ${Math.ceil(forecast.queue)} min` : ''}.`
          : `Start ${label} now for ${destination(task)}; acknowledge Preparing.`;
    } else if (
      forecast.start != null &&
      forecast.start <= current &&
      task.capacityState === 'allocated'
    ) {
      phase = 'start';
      signal = 'green';
      status = 'Start now';
      priority = 10;
      callType = 'start';
      reason =
        current < latestStart
          ? 'Station is free; starting within the permitted holding window protects the queue'
          : 'Preparation window has arrived and station capacity is available';
      instruction = `Start ${label} now for ${destination(task)}; acknowledge Preparing.`;
    } else {
      instruction = `Keep ${label} ready to cook for ${destination(task)}${forecast.queue != null && forecast.queue > 0 ? `; estimated start in ${Math.ceil(forecast.queue)} min` : task.capacityState !== 'allocated' ? '; expo must confirm a station slot before starting' : ''}.`;
      reason = delayMinutes
        ? `Station queue forecasts service ${delayMinutes} min after the saved target`
        : 'Waiting for its preparation window or an occupied station';
    }
    if (waves(task) > 1 && !held(task) && PENDING.has(state))
      instruction += ` Plan ${waves(task)} conservative cooking waves; chef must confirm any larger batch size.`;
    if (task.runningOrder) {
      instruction = `Running order / additional portion, priority: ${instruction}`;
      if (isRunningOrderEligible(task)) {
        const tier = kitchenPriorityTier(task);
        priority = Math.min(priority, tier === 0 ? 0 : tier === 1 ? 6 : 7);
        if (forecast.start > current || forecast.blockedReason) {
          instruction += ' Expo, prioritize this top-up for the next eligible station slot; do not interrupt cooking already in progress.';
        }
      }
    }
    const details = {
      signal,
      label: status,
      instruction,
      reason,
      startAt: held(task) && PENDING.has(state) ? null : iso(forecast.start),
      readyAt: held(task) && PENDING.has(state) ? null : iso(forecast.ready),
      queueMinutes: forecast.queue == null ? null : Math.ceil(forecast.queue),
      delayMinutes,
      cookingWaves: waves(task),
      prepAlert: prep?.message || null,
      prepAlertImmediate: !!prep?.immediate,
      batchId: forecast.unit?.batch?.batchId || null,
      phase,
      estimateOnly: true,
    };
    if (signal === 'red')
      alerts.push({
        id: `task:${task.taskKey}:${phase}`,
        type: phase,
        severity: 'critical',
        urgent: true,
        taskKey: task.taskKey,
        stationId: task.stationId,
        message: instruction,
      });
    if (delayMinutes && !held(task) && PENDING.has(state))
      alerts.push({
        id: `task:${task.taskKey}:queue-delay`,
        type: 'queue-delay',
        severity: 'warning',
        urgent: false,
        taskKey: task.taskKey,
        stationId: task.stationId,
        message: `${label}: estimated ready ${delayMinutes} min after target. Expo, review capacity and advise service staff.`,
      });
    if (phase !== 'hold' && phase !== 'cooking' && !forecast.unit?.batch)
      calls.push({
        id: `task:${task.taskKey}:${phase}`,
        priority,
        type: callType,
        urgent: signal === 'red',
        signal,
        instruction,
        taskKeys: [task.taskKey],
        stationId: task.stationId,
        itemName: task.itemName,
        runningOrder: task.runningOrder,
        runningOrderReason: task.runningOrderReason,
        quantity: quantity(task),
        startAt: details.startAt,
        readyAt: details.readyAt,
      });
    if (prep) {
      const message = `${label} for ${destination(task)}: ${prep.message}${held(task) ? ' Cooking remains on hold.' : ''}`;
      alerts.push({
        id: `prep:${task.taskKey}`,
        type: 'prep',
        severity: 'warning',
        urgent: prep.immediate,
        taskKey: task.taskKey,
        stationId: task.stationId,
        message,
      });
      calls.push({
        id: `prep:${task.taskKey}`,
        priority: 8,
        type: 'prep',
        urgent: prep.immediate,
        signal: 'yellow',
        instruction: message,
        taskKeys: [task.taskKey],
        stationId: task.stationId,
        itemName: task.itemName,
        runningOrder: task.runningOrder,
        runningOrderReason: task.runningOrderReason,
        quantity: quantity(task),
        startAt: null,
        readyAt: null,
      });
    }
    return { ...task, expediter: details };
  });

  for (const unit of work.filter((entry) => entry.batch)) {
    const members = enriched.filter((task) =>
      unit.tasks.some((member) => member.taskKey === task.taskKey)
    );
    const signal = members.some((task) => task.expediter.signal === 'red')
      ? 'red'
      : members.every((task) => task.expediter.signal === 'green')
        ? 'green'
        : 'yellow';
    const first = members[0];
    const phase = signal === 'red' ? 'late' : signal === 'green' ? 'start' : 'wait';
    const portions = members.reduce((sum, task) => sum + quantity(task), 0);
    const sharedLabel = cookingLabel(
      first,
      members
        .map((task) => task.itemName)
        .filter((name, index, list) => list.indexOf(name) === index)
        .join(', ')
    );
    const runningOrder = members.some((task) => task.runningOrder);
    const instruction = `${runningOrder ? 'Running order / additional portion, priority: ' : ''}${signal === 'green' ? 'Start' : signal === 'red' ? 'Expedite' : 'Stage'} approved batch: ${portions} portions of ${sharedLabel} for ${members
      .map(destination)
      .filter((name, index, list) => list.indexOf(name) === index)
      .join(
        '; '
      )}. ${signal === 'green' ? 'Use Start batch to acknowledge all allocations.' : signal === 'red' ? 'Expo, confirm the next free station slot.' : 'Wait for the displayed start time; keep order portions separate.'}`;
    calls.push({
      id: `batch:${unit.id}:${phase}`,
      priority: signal === 'red' ? 1 : runningOrder ? 7 : signal === 'green' ? 9 : 45,
      type: 'batch',
      urgent: signal === 'red',
      signal,
      instruction,
      taskKeys: members.map((task) => task.taskKey),
      batchId: unit.batch.batchId || null,
      stationId: unit.stationId,
      runningOrder,
      runningOrderReason: runningOrder ? members.find((task) => task.runningOrder).runningOrderReason : '',
      quantity: portions,
      startAt: first?.expediter.startAt || null,
      readyAt: first?.expediter.readyAt || null,
    });
  }
  const stationSummaries = [...stations.values()].map((station) => {
    station.estimatedClearMinutes = Math.ceil(
      Math.max(0, ...station.bookings.map((booking) => booking.end - current)) / MINUTE
    );
    station.workloadMinutes = Math.ceil(station.workloadMinutes);
    station.level = stationLevel(station);
    if (['busy', 'surge', 'blocked'].includes(station.level))
      alerts.push({
        id: `station:${station.stationId}:load`,
        type: 'station-load',
        severity: station.level === 'blocked' ? 'critical' : 'warning',
        urgent: station.level === 'blocked',
        stationId: station.stationId,
        message: `${station.stationName}: ${station.level}, ${station.queuedPortions} queued portions${station.level !== 'blocked' ? `; estimated queue clear in ${station.estimatedClearMinutes} min` : '; restore or reassign capacity'}.`,
      });
    const { bookings, ...summary } = station;
    return summary;
  });
  staleOrders.forEach((order) =>
    alerts.push({
      id: `stale:${order.id}`,
      type: 'stale-order',
      severity: 'warning',
      urgent: false,
      message: `Order ${order.orderNumber || order.id} is from an earlier inactive shift. Resolve it in the order board; it is excluded from cooking calls.`,
    })
  );
  const atRiskTasks = enriched.filter(
    (task) => task.expediter.signal === 'red' || task.expediter.delayMinutes > 0
  ).length;
  const activeOrders = new Set(tasks.map((task) => task.orderId)).size;
  const worst = stationSummaries.some((station) => ['surge', 'blocked'].includes(station.level))
    ? 'surge'
    : stationSummaries.some((station) => station.level === 'busy')
      ? 'busy'
      : tasks.length
        ? 'steady'
        : 'quiet';
  const load = {
    level: worst,
    label:
      worst === 'surge'
        ? 'Kitchen under pressure'
        : worst === 'busy'
          ? 'Busy kitchen'
          : atRiskTasks
            ? 'Kitchen needs attention'
            : worst === 'steady'
              ? 'Kitchen on track'
              : 'Kitchen quiet',
    activeOrders,
    queuedPortions: tasks
      .filter((task) => PENDING.has(task.taskState || 'ordered') && !held(task))
      .reduce((sum, task) => sum + quantity(task), 0),
    activePortions: tasks
      .filter((task) => ['fired', 'preparing'].includes(task.taskState))
      .reduce((sum, task) => sum + quantity(task), 0),
    heldPortions: tasks.filter(held).reduce((sum, task) => sum + quantity(task), 0),
    waitingTasks: enriched.filter((task) => task.expediter.signal === 'yellow').length,
    atRiskTasks,
    estimatedClearMinutes: Math.max(
      0,
      ...stationSummaries.map((station) => station.estimatedClearMinutes)
    ),
  };
  return {
    recommendations: enriched,
    expediter: {
      generatedAt: iso(current),
      load,
      stations: stationSummaries,
      alerts,
      calls: calls.sort(
        (left, right) =>
          left.priority - right.priority || String(left.id).localeCompare(String(right.id))
      ),
      estimateOnly: true,
    },
  };
}

module.exports = { buildKitchenExpediter, earliestSlot };
