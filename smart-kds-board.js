(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else {
    root.RedLanternKdsBoard = api;
    root.RedLanternKitchenBoard = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const VIEWS = ['all', 'start', 'cooking', 'waiting', 'ready', 'attention'];
  const STATES = new Set(['ordered', 'held', 'eligible', 'scheduled', 'fired', 'preparing', 'ready', 'expo', 'served', 'cancelled', 'superseded']);
  const TERMINAL = new Set(['served', 'cancelled', 'superseded']);
  const PENDING = new Set(['ordered', 'eligible', 'scheduled']);
  const keyOf = (task) => String(task?.taskKey ?? task?.task_id ?? '').trim();
  const stateOf = (task) => String(task?.taskState ?? task?.task_state ?? task?.state ?? 'ordered').toLowerCase();
  const finite = (value, fallback = Infinity) => Number.isFinite(Number(value)) && value !== null && value !== '' ? Number(value) : fallback;
  const time = (value) => value == null || value === '' ? Infinity : finite(new Date(value).getTime());
  const quantity = (task) => Math.max(1, finite(task?.quantity, 1));
  const lexical = (left, right) => String(left) < String(right) ? -1 : String(left) > String(right) ? 1 : 0;

  function clone(value, seen = new WeakMap()) {
    if (!value || typeof value !== 'object') return value;
    if (value instanceof Date) return new Date(value.getTime());
    if (seen.has(value)) return seen.get(value);
    const result = Array.isArray(value) ? [] : {};
    seen.set(value, result);
    Object.keys(value).forEach((key) => { result[key] = clone(value[key], seen); });
    return result;
  }

  function newer(left, right) {
    const leftVersion = finite(left?.version, -1), rightVersion = finite(right?.version, -1);
    if (leftVersion !== rightVersion) return leftVersion > rightVersion ? left : right;
    const leftTime = time(left?.updated_at ?? left?.updatedAt ?? left?.recordedAt);
    const rightTime = time(right?.updated_at ?? right?.updatedAt ?? right?.recordedAt);
    if (leftTime !== rightTime) {
      if (leftTime === Infinity) return right;
      if (rightTime === Infinity) return left;
      return leftTime > rightTime ? left : right;
    }
    // Repeated snapshots without version metadata follow their supplied order.
    return right;
  }

  function isHeld(task) {
    return stateOf(task) === 'held' || ['hold-for-course', 'manual-hold', 'served'].includes(task.pacingState)
      || ['manual-hold', 'hold-for-course'].includes(task.action)
      || ['hold', 'defer'].includes(task.manualOverride?.action);
  }

  function getTaskView(task = {}) {
    const state = stateOf(task);
    if (TERMINAL.has(state)) return null;
    if (state === 'ready' || state === 'expo') return 'ready';
    if (state === 'preparing') return 'cooking';
    if (state === 'fired') return 'start';
    if (isHeld(task)) return 'waiting';
    if (PENDING.has(state) && task.capacityState === 'allocated' && (
      task.expediter?.signal === 'green' || (!task.expediter && [task.action, task.baseAction].includes('start-now'))
      || (task.expediter?.signal === 'red' && ['start', 'missed-start'].includes(task.expediter.phase))
    )) return 'start';
    return 'waiting';
  }

  function isAttentionTask(task = {}) {
    if (!getTaskView(task) || task.boardStateChanged) return false;
    return task.expediter?.signal === 'red'
      || (!task.expediter && PENDING.has(stateOf(task)) && ['critical', 'overdue'].includes(task.state));
  }

  function taskPriority(task) {
    const view = getTaskView(task);
    // A capacity-blocked warning must not displace the next work that cooks
    // can actually start. Critical warnings remain visible in their own tab.
    return view === 'start' ? 0 : view === 'cooking' ? 1 : view === 'ready' ? 3 : 2;
  }

  function comparePriority(left, right) {
    const priority = taskPriority(left) - taskPriority(right);
    if (priority) return priority;
    const rank = finite(left.finalRank ?? left.rank) - finite(right.finalRank ?? right.rank);
    const deadline = time(left.latestSafeStartAt ?? left.plannedStartAt) - time(right.latestSafeStartAt ?? right.plannedStartAt);
    const running = getTaskView(left) === 'waiting' ? Number(right.runningOrder === true) - Number(left.runningOrder === true) : 0;
    // The scheduler's rank already accounts for critical work and running
    // top-ups. Do not undo that decision by sorting an older deadline first.
    return rank || running || deadline
      || time(left.orderedAt) - time(right.orderedAt);
  }

  function compareTasks(left, right) {
    return comparePriority(left, right) || lexical(keyOf(left), keyOf(right));
  }

  function normalizeTasks(recommendations = [], taskStates = []) {
    const records = new Map();
    (Array.isArray(taskStates) ? taskStates : []).forEach((record) => {
      const key = keyOf(record);
      if (!key || !STATES.has(stateOf(record))) return;
      records.set(key, records.has(key) ? newer(records.get(key), record) : record);
    });
    const unique = new Map();
    (Array.isArray(recommendations) ? recommendations : []).forEach((task) => {
      const key = keyOf(task);
      if (!key) return;
      unique.set(key, unique.has(key) ? newer(unique.get(key), task) : task);
    });
    return [...unique.entries()].flatMap(([key, source]) => {
      const recorded = records.get(key);
      const sourceState = STATES.has(stateOf(source)) ? stateOf(source) : 'ordered';
      const state = recorded ? stateOf(recorded) : sourceState;
      if (TERMINAL.has(state)) return [];
      const task = clone(source);
      task.taskKey = key;
      task.orderId = String(source.orderId ?? source.order_id ?? `task:${key}`);
      task.taskState = state;
      task.quantity = quantity(source);
      const completed = recorded?.completed_quantity ?? recorded?.completedQuantity ?? source.completedQuantity ?? source.completed_quantity;
      if (completed != null) task.completedQuantity = Math.max(0, finite(completed, 0));
      // An acknowledgement can arrive after the scheduling snapshot. Never
      // label a recorded ready item "Start now" using its earlier advice.
      if (recorded && sourceState !== state) {
        delete task.expediter;
        task.boardStateChanged = true;
      }
      task.boardStatus = getTaskView(task);
      task.boardAttention = isAttentionTask(task);
      return [task];
    }).sort(compareTasks);
  }

  function searchWords(value) {
    return String(value ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
      .replace(/[#,:;|()[\]{}./_\-]+/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function modifierText(value) {
    if (Array.isArray(value)) return value.map(modifierText).join(' ');
    if (value && typeof value === 'object') return Object.entries(value)
      .filter(([key]) => !['price', 'quantity', 'groupId', 'optionId', 'id'].includes(key))
      .map(([, item]) => modifierText(item)).join(' ');
    return typeof value === 'string' ? value : '';
  }

  function location(task) {
    return String(task.mode || '').toLowerCase() === 'table' || task.tableNumber != null
      ? `${task.tableArea || 'Dining'} · Table ${task.tableNumber ?? '—'}`
      : String(task.fulfillmentType || task.mode || 'Order').replace(/_/g, ' ');
  }

  function matchesQuery(task, words) {
    if (!words.length) return true;
    const table = String(task.tableNumber ?? '');
    const order = String(task.orderNumber ?? '');
    const remaining = [];
    for (let index = 0; index < words.length; index += 1) {
      const combined = words[index].match(/^(table|order)(\d+)$/);
      const named = /^(table|order)$/.test(words[index]) && /^\d+$/.test(words[index + 1] || '');
      if (combined || named) {
        const field = (combined?.[1] || words[index]) === 'table' ? table : order;
        const requested = combined?.[2] || words[++index];
        if (!field || Number(field) !== Number(requested)) return false;
      } else remaining.push(words[index]);
    }
    const text = searchWords([
      task.orderId, task.orderNumber, `order ${order}`, `order${order}`, task.tableArea, location(task),
      table ? `table${table} table ${table} table ${table.padStart(2, '0')}` : '',
      task.itemName, task.name, task.category, task.note, task.orderNote, task.notes, task.specialRequest,
      task.portion, task.style, modifierText(task.modifiers),
    ].join(' '));
    const tokens = new Set(text.split(' '));
    return remaining.every((word) => /^\d+$/.test(word)
      ? tokens.has(word) : text.includes(word));
  }

  function groupOrders(tasks) {
    const groups = new Map();
    tasks.forEach((task) => {
      if (!groups.has(task.orderId)) groups.set(task.orderId, []);
      groups.get(task.orderId).push(task);
    });
    return [...groups.entries()].map(([orderId, members]) => {
      const ordered = [...members].sort(compareTasks);
      const first = ordered[0];
      const targets = ordered.map((task) => time(task.targetServeAt)).filter(Number.isFinite);
      const starts = ordered.map((task) => time(task.latestSafeStartAt ?? task.plannedStartAt)).filter(Number.isFinite);
      const counts = { start: 0, cooking: 0, waiting: 0, ready: 0 };
      ordered.forEach((task) => { counts[task.boardStatus] += 1; });
      return {
        orderId, orderNumber: first.orderNumber, mode: first.mode,
        fulfillmentType: first.fulfillmentType, tableArea: first.tableArea, tableNumber: first.tableNumber,
        customerName: first.customerName, location: location(first), tasks: ordered,
        priority: taskPriority(first), boardStatus: first.boardStatus, statusCounts: counts,
        earliestTarget: targets.length ? new Date(Math.min(...targets)).toISOString() : null,
        earliestStart: starts.length ? new Date(Math.min(...starts)).toISOString() : null,
        runningCount: ordered.filter((task) => task.runningOrder === true).length,
        attentionCount: ordered.filter(isAttentionTask).length,
        totalItems: ordered.length, totalPortions: ordered.reduce((sum, task) => sum + quantity(task), 0),
      };
    }).sort((left, right) => comparePriority(left.tasks[0], right.tasks[0]) || lexical(left.orderId, right.orderId));
  }

  function matchingBatches(batches, tasks) {
    const byKey = new Map(tasks.map((task) => [task.taskKey, task]));
    const unique = new Map();
    (Array.isArray(batches) ? batches : []).forEach((batch) => {
      const key = String(batch?.batchId || batch?.batchKey || '');
      const allocations = Array.isArray(batch?.allocations) ? batch.allocations : [];
      if (!key || !allocations.length || !['fire-batch', 'wait-for-batch'].includes(batch.action)) return;
      const keys = allocations.map(keyOf);
      if (new Set(keys).size !== keys.length || allocations.some((allocation) => {
        const task = byKey.get(keyOf(allocation));
        return !task || !PENDING.has(task.taskState) || isHeld(task)
          || String(task.stationId || '') !== String(batch.stationId || '')
          || finite(allocation.quantity, -1) !== quantity(task);
      })) return;
      unique.set(key, { ...clone(batch), taskKeys: keys });
    });
    return [...unique.values()].sort((left, right) => time(left.latestSafeStartAt) - time(right.latestSafeStartAt)
      || lexical(left.batchId || left.batchKey, right.batchId || right.batchKey));
  }

  function buildBoardView(options = {}) {
    const allTasks = normalizeTasks(options.recommendations ?? options.tasks, options.taskStates);
    const station = String(options.stationId || 'all');
    const query = searchWords(options.query).split(' ').filter(Boolean);
    const view = VIEWS.includes(options.view ?? options.status) ? options.view ?? options.status : 'all';
    const matchingTasks = allTasks.filter((task) => (station === 'all' || station === '*' || String(task.stationId || '') === station) && matchesQuery(task, query));
    const counts = { all: matchingTasks.length, start: 0, cooking: 0, waiting: 0, ready: 0, attention: 0 };
    const orderSets = Object.fromEntries(VIEWS.map((name) => [name, new Set()]));
    matchingTasks.forEach((task) => {
      counts[task.boardStatus] += 1;
      orderSets.all.add(task.orderId);
      orderSets[task.boardStatus].add(task.orderId);
      if (isAttentionTask(task)) { counts.attention += 1; orderSets.attention.add(task.orderId); }
    });
    const filteredTasks = matchingTasks.filter((task) => view === 'all' || (view === 'attention' ? isAttentionTask(task) : task.boardStatus === view));
    const orders = groupOrders(filteredTasks);
    const pageSize = Math.max(1, Math.min(100, Math.floor(finite(options.pageSize, 6))));
    const pageCount = Math.max(1, Math.ceil(orders.length / pageSize));
    const page = Math.max(1, Math.min(pageCount, Math.floor(finite(options.page, 1))));
    return {
      orders: orders.slice((page - 1) * pageSize, page * pageSize), counts,
      taskCounts: { ...counts }, orderCounts: Object.fromEntries(VIEWS.map((name) => [name, orderSets[name].size])),
      attentionCounts: {
        red: counts.attention,
        blocked: matchingTasks.filter((task) => isAttentionTask(task) && task.boardStatus === 'waiting').length,
      },
      allOrders: orderSets.all.size, totalOrders: orders.length,
      totalItems: filteredTasks.length, totalPortions: filteredTasks.reduce((sum, task) => sum + quantity(task), 0),
      page, pageCount, totalPages: pageCount, pageSize, view,
      allTasks, matchingTasks, filteredTasks, matchingBatches: matchingBatches(options.batches, filteredTasks),
    };
  }

  function remainingPortions(task) {
    return Math.max(0, quantity(task) - Math.max(0, finite(task.completedQuantity ?? task.completed_quantity, 0)));
  }

  function canStartTask(task, current) {
    const state = stateOf(task);
    if (isHeld(task) || !remainingPortions(task)) return false;
    if (state === 'fired') return true;
    if (!PENDING.has(state) || task.capacityState !== 'allocated' || getTaskView(task) !== 'start') return false;
    if (task.expediter?.phase === 'blocked') return false;
    const forecast = time(task.expediter?.startAt);
    return !Number.isFinite(forecast) || forecast <= current;
  }

  function buildKitchenFocus(options = {}) {
    // Focus is independent of the current tab and pagination. The caller may
    // scope its input to a station; every task remains on the normal board.
    const board = buildBoardView({ ...options, view: 'all', status: 'all', page: 1 });
    const tasks = board.matchingTasks;
    const byKey = new Map(tasks.map((task) => [task.taskKey, task]));
    const current = Number.isFinite(time(options.now)) ? time(options.now) : Date.now();
    const membersOfBatch = new Set();
    (Array.isArray(options.batches) ? options.batches : []).forEach((batch) => {
      if (!batch?.batchId || !['fire-batch', 'wait-for-batch'].includes(batch.action)) return;
      (batch.allocations || []).forEach((allocation) => {
        if (PENDING.has(stateOf(byKey.get(keyOf(allocation))))) membersOfBatch.add(keyOf(allocation));
      });
    });
    const candidates = [];
    board.matchingBatches.forEach((batch) => {
      if (!batch.batchId || batch.action !== 'fire-batch') return;
      const members = batch.taskKeys.map((key) => byKey.get(key)).sort(compareTasks);
      if (!members.every((task) => canStartTask(task, current) && remainingPortions(task) === quantity(task))) return;
      const release = time(batch.earliestStartAt);
      if (Number.isFinite(release) && release > current) return;
      candidates.push({ kind: 'batch', batchId: batch.batchId, taskKeys: batch.taskKeys,
        batch, tasks: members, anchor: members[0], status: 'start', action: 'start-batch',
        remainingPortions: members.reduce((sum, task) => sum + remainingPortions(task), 0),
        reason: 'Approved batch is released and all of its station allocations are available' });
    });
    tasks.forEach((task) => {
      if (!canStartTask(task, current) || (PENDING.has(stateOf(task)) && membersOfBatch.has(task.taskKey))) return;
      candidates.push({ kind: 'task', taskKey: task.taskKey, taskKeys: [task.taskKey], task, anchor: task,
        status: stateOf(task) === 'fired' ? 'confirm-start' : 'start', action: 'start', remainingPortions: remainingPortions(task),
        reason: stateOf(task) === 'fired' ? 'Confirm preparation for this already-fired item' : 'Station allocation and the preparation window permit this start' });
    });
    candidates.sort((left, right) => compareTasks(left.anchor, right.anchor) || lexical(left.batchId || left.taskKey, right.batchId || right.taskKey));
    let chosen = candidates[0];
    const preferred = candidates.find((candidate) => candidate.taskKeys.includes(String(options.preferredTaskKey || '')));
    // Retain an existing focus only for an exact priority/rank tie. A newly
    // urgent or higher-ranked item always receives the next focus instead.
    if (chosen && preferred && !comparePriority(chosen.anchor, preferred.anchor)) chosen = preferred;
    if (!chosen && tasks.length) {
      const fallback = [...tasks].sort((left, right) => Number(isAttentionTask(right)) - Number(isAttentionTask(left)) || compareTasks(left, right))[0];
      const status = getTaskView(fallback);
      const reason = status === 'cooking'
        ? fallback.expediter?.reason || 'Preparation is recorded; confirm Ready when the food is finished'
        : status === 'ready' ? 'Food is recorded ready; collect it for expo or service'
          : isHeld(fallback) ? fallback.pacingReason || 'Cooking remains on hold until an authorised release'
            : membersOfBatch.has(fallback.taskKey) ? 'Wait for the complete approved batch and its station capacity'
              : fallback.capacityState !== 'allocated' ? 'Expo must clear or assign station capacity before this item starts'
                : 'Wait for the planned preparation window or a refreshed kitchen allocation';
      chosen = { kind: 'task', taskKey: fallback.taskKey, taskKeys: [fallback.taskKey], task: fallback,
        status: status === 'start' ? 'waiting' : status, action: null, remainingPortions: status === 'ready' ? 0 : remainingPortions(fallback), reason };
    }
    const { anchor, ...result } = chosen || { kind: 'none', taskKeys: [], status: 'none', action: null, remainingPortions: 0,
      reason: 'No active kitchen work for this display' };
    return { ...result, attentionCount: board.counts.attention,
      blockedTasks: board.attentionCounts.blocked,
      totalRemainingPortions: tasks.filter((task) => task.boardStatus !== 'ready').reduce((sum, task) => sum + remainingPortions(task), 0) };
  }

  return { buildBoardView, buildKitchenBoard: buildBoardView, buildKitchenFocus, normalizeTasks, getTaskView, isAttentionTask, compareTasks };
});
