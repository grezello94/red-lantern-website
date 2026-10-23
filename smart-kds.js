const $ = (selector) => document.querySelector(selector);
const esc = (value) =>
  String(value ?? '').replace(
    /[&<>'"]/g,
    (character) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        "'": '&#39;',
        '"': '&quot;',
      })[character]
  );

let data = {
  recommendations: [],
  summary: {},
  taskStates: [],
  batches: [],
  stations: [],
  staleOrders: [],
};
let liveConnected = false;
let refreshTimer = null;
let updateCursor = null;
let loadSequence = 0;
let loadInFlight = null;
let reloadRequested = false;
let updateCheckInFlight = false;
let kitchenSnapshotFresh = false;
let kitchenCallerEnabled = false;
const seenKitchenCalls = new Set();
let kitchenVoiceQueue = [];
let kitchenSpeaking = null;
let kitchenSpeechGeneration = 0;
let kitchenAudioContext = null;
let lastKitchenChimeAt = 0;
let selectedStation = localStorage.getItem('redLanternSmartKdsStation') || 'all';
// Kitchen staff should always see the complete priority list. Category is
// retained as a manager-only diagnostic control, never as a remembered filter
// that could accidentally hide urgent work at the start of a shift.
let selectedCategory = 'all';
let selectedBoardStatus = 'all';
let boardQuery = '';
let boardPage = 1;
const boardPageSize = 6;
let lastBoardView = null;
let lastKitchenFocus = null;
const Addons = window.RedLanternAddons;
const pendingKitchenActions = new Set();
const kitchenActionKey = (orderId, taskKey) => JSON.stringify([String(orderId), String(taskKey)]);
const kitchenHasPermission = () => !window.employeeCan || window.employeeCan('updateKitchen');
const kitchenCanAct = () => kitchenSnapshotFresh && data.schedulingMode === 'manual' && kitchenHasPermission();
const taskIsPending = (task) => pendingKitchenActions.has(kitchenActionKey(task.orderId, task.taskKey));
const taskCanMarkReady = state => ['ordered', 'eligible', 'scheduled', 'fired', 'preparing'].includes(state);
const taskHasStation = task => Boolean(String(task?.stationId || '').trim());
let timelineSequence = 0;
function syncKitchenPending() {
  const states = taskStateMap();
  document.querySelectorAll('#board button[data-task][data-order], #batch-list button[data-task][data-order], #kitchen-briefing button[data-task][data-order]').forEach(button => {
    const task = (data.recommendations || []).find(entry => String(entry.taskKey) === String(button.dataset.task) && String(entry.orderId) === String(button.dataset.order));
    const readyUnavailable = button.hasAttribute('data-ready-control') && (!task || !taskHasStation(task) || !taskCanMarkReady(states.get(task.taskKey) || task.taskState || 'ordered'));
    const startUnavailable = button.hasAttribute('data-start-control') && (!task || !taskStartAllowed(task, states.get(task.taskKey) || task.taskState || 'ordered'));
    button.disabled = !kitchenCanAct() || readyUnavailable || startUnavailable || pendingKitchenActions.has(kitchenActionKey(button.dataset.order, button.dataset.task));
  });
  document.querySelectorAll('#batch-list [data-batch-action], #kitchen-briefing [data-batch-action]').forEach(button => {
    const batch = (data.batches || []).find(entry => String(entry.batchId) === String(button.dataset.batch));
    button.disabled = !kitchenCanAct() || !batchHasCapacity(batch, data.recommendations || []) || batchIsPending(batch);
  });
}
async function smartKdsJson(path, options = {}) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(path, { ...options, signal: controller.signal });
    const payload = await response.json().catch(error => { if (response.ok) throw error; return null; });
    if (!response.ok) {
      const error = new Error(payload?.error || 'Unable to complete the kitchen request.');
      error.status = response.status;
      throw error;
    }
    return payload;
  } finally { clearTimeout(timer); }
}

function operator() {
  const input = $('#operator');
  const value = String(
    input?.value || localStorage.getItem('redLanternKitchenOperator') || ''
  ).trim();
  if (value) localStorage.setItem('redLanternKitchenOperator', value.slice(0, 100));
  return value || 'Kitchen console';
}

function title(value) {
  return String(value || '').replace(/-/g, ' ');
}
function setLiveStatus(message) {
  $('#status').textContent = message;
}
function queueLoad() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(load, 120);
}
function taskStateMap() {
  return new Map((data.taskStates || []).map((task) => [task.task_id, task.task_state]));
}
function stationLabel(stationId) {
  const station = (data.stations || []).find((entry) => String(entry.id) === String(stationId));
  return station?.name || stationId || 'Station not assigned';
}
function menuCategory(task) {
  return String(task?.category || 'Menu').trim() || 'Menu';
}
function taskDish(task) {
  const extras = Addons.modifierText(task.modifiers);
  const style = String(task.style || '').trim(), note = String(task.note || '').trim();
  return `${task.quantity}× ${task.itemName}${task.portion ? ` · ${task.portion}` : ''}${style ? ` · Style: ${style}` : ''}${extras ? ` + ${extras}` : ''}${note ? ` · Note: ${note}` : ''}`;
}
function filteredTasks() {
  const tasks = Array.isArray(data.recommendations) ? data.recommendations : [];
  const states = taskStateMap();
  return tasks.filter(
    (task) =>
      !['served', 'cancelled', 'superseded'].includes(states.get(task.taskKey) || task.taskState) &&
      (selectedStation === 'all' || String(task.stationId || '') === selectedStation) &&
      (selectedCategory === 'all' || menuCategory(task) === selectedCategory)
  ).map(task => {
    const recordedState = states.get(task.taskKey);
    // State acknowledgements can be newer than the scheduler's advice when
    // another kitchen screen acts during snapshot generation. Use the saved
    // workflow state until the next forecast catches up.
    return recordedState && recordedState !== (task.taskState || 'ordered')
      ? { ...task, expediter: null, expediterStale: true, action: ['fired', 'preparing', 'ready', 'expo'].includes(recordedState) ? 'monitor' : task.action }
      : task;
  });
}
function timeUntil(date) {
  const target = new Date(date).getTime();
  if (!Number.isFinite(target)) return '';
  const minutes = Math.ceil((target - Date.now()) / 60_000);
  return minutes <= 0 ? `Start overdue by ${Math.abs(minutes)} min` : `Start within ${minutes} min`;
}
function kitchenTime(value) {
  if (value == null || value === '') return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const time = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  }).format(date);
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' });
  const sameDay = day.format(date) === day.format(new Date());
  return sameDay
    ? time
    : `${date.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short' })} · ${time}`;
}
function taskLocation(task) {
  return task.mode === 'table'
    ? `${task.tableArea || 'Table'} ${String(task.tableNumber || '—').padStart(2, '0')}`
    : title(task.fulfillmentType || task.mode || 'order');
}
function taskInstruction(task, state) {
  if (task.expediter?.instruction) return task.expediter.instruction;
  const dish = taskDish(task);
  const location = taskLocation(task);
  const target = kitchenTime(task.targetServeAt);
  const start = kitchenTime(task.plannedStartAt || task.latestSafeStartAt);
  if (state === 'held' || task.action === 'manual-hold') return `Hold ${dish} for ${location} until kitchen staff releases it.`;
  if (state === 'ready' || state === 'expo') return `Send ${dish} for ${location} to expo now.`;
  if (state === 'fired') return `Start ${dish} for ${location} now${target ? ` · target ready ${target}` : ''}.`;
  if (state === 'preparing')
    return `Continue ${dish} for ${location}${target ? ` · target ready ${target}` : ''}.`;
  if (
    task.capacityState === 'allocated' &&
    (task.baseAction === 'start-now' ||
      task.action === 'start-now' ||
      task.action === 'service-risk')
  )
    return `Prepare ${dish} for ${location} now${target ? ` · target ready ${target}` : ''}.`;
  if (task.action === 'prepare-next' || task.baseAction === 'prepare-next')
    return `Prepare ${dish} for ${location}${start ? ` at ${start}` : ' next'}${target ? ` · target ready ${target}` : ''}.`;
  if (task.action === 'wait-capacity')
    return `Do not start ${dish} for ${location} yet · the station is at capacity${start ? `, review at ${start}` : ''}.`;
  if (task.action === 'hold-for-course' || task.capacityState === 'hold-for-course')
    return `Hold ${dish} for ${location} until the earlier course is ready.`;
  if (task.action === 'assign-station')
    return `Assign a kitchen station before preparing ${dish} for ${location}.`;
  return `Review ${dish} for ${location}${target ? ` · target ready ${target}` : ''}.`;
}
function kitchenActionLabel(task, state) {
  if (state === 'held' || task.action === 'manual-hold') return 'Wait';
  if (state === 'ready' || state === 'expo') return 'Send out now';
  if (state === 'fired') return 'Make now';
  if (state === 'preparing') return 'Cooking now';
  if (task.action === 'service-risk') return 'Make first';
  if (task.action === 'wait-capacity' || task.action === 'hold-for-course') return 'Wait';
  if (task.action === 'assign-station') return 'Assign station';
  if (task.baseAction === 'prepare-next' || task.action === 'prepare-next') return 'Make next';
  return 'Make now';
}
function kitchenCommand(task, state) {
  if (state === 'held' || task.action === 'manual-hold') return 'Wait until kitchen staff releases this dish';
  if (state === 'ready' || state === 'expo') return 'Take this dish to expo now';
  if (state === 'fired') return 'Start preparation for this dish';
  if (state === 'preparing') return 'Keep cooking this dish';
  if (task.action === 'wait-capacity') return 'Wait until the station is free';
  if (task.action === 'hold-for-course' || task.capacityState === 'hold-for-course')
    return 'Wait for the earlier course';
  if (task.action === 'assign-station') return 'Choose a kitchen station first';
  if (task.baseAction === 'prepare-next' || task.action === 'prepare-next')
    return 'Prepare this dish next';
  return 'Start this dish now';
}
function taskAction(task, state) {
  if (task.expediter?.signal === 'yellow' && ['ordered', 'eligible', 'scheduled'].includes(state)) return null;
  if (['ordered', 'eligible', 'scheduled'].includes(state) && task.capacityState === 'allocated')
    return ['start', 'Start preparation'];
  if (state === 'fired') return ['start', 'Start preparation'];
  if (state === 'preparing') return ['ready', 'Mark ready'];
  if (state === 'ready') return ['expo', 'Send to expo'];
  if (state === 'expo') return ['serve', 'Mark served'];
  return null;
}
function taskGroup(task, state) {
  if (state === 'ready' || state === 'expo') return 'ready';
  if (state === 'held' || ['manual-hold', 'wait-capacity', 'hold-for-course', 'assign-station'].includes(task.action)) return 'hold';
  if (task.expediter?.signal === 'red') return 'risk';
  if (state === 'fired' || state === 'preparing') return 'now';
  if (task.expediter?.signal === 'green') return 'now';
  if (task.expediter?.signal === 'yellow') return 'next';
  // "Overdue" means the kitchen should look at the item now. It is not, by
  // itself, proof that a guest's table is at risk. Keep that distinction clear
  // so the board does not turn every delayed item into a service-risk alert.
  if (task.action === 'service-risk' || task.serviceRiskSeverity === 'critical') return 'risk';
  if (task.baseAction === 'start-now' || task.action === 'start-now') return 'now';
  if (['critical', 'overdue'].includes(String(task.state || ''))) return 'now';
  if (task.baseAction === 'prepare-next' || task.action === 'prepare-next') return 'next';
  return 'hold';
}
function taskSignal(task, state) {
  const signal = task.expediter?.signal;
  if (['green', 'yellow', 'red', 'neutral'].includes(signal)) return signal;
  if (['ready', 'expo', 'preparing'].includes(state)) return 'neutral';
  if (state === 'held' || ['manual-hold', 'wait-capacity', 'hold-for-course', 'assign-station'].includes(task.action)) return 'yellow';
  if (taskGroup(task, state) === 'risk' || ['critical', 'overdue'].includes(task.state)) return 'red';
  return taskGroup(task, state) === 'now' ? 'green' : 'yellow';
}
function signalLabel(signal) {
  return { green: 'Start now', yellow: 'Get ready / wait', red: 'Needs attention', neutral: 'In progress / ready' }[signal] || 'Review';
}
function markReadyControl(task, state, primary = false) {
  if (!taskCanMarkReady(state)) return '';
  const missingStation = !taskHasStation(task);
  const disabled = !kitchenCanAct() || missingStation || taskIsPending(task);
  return `<button type="button" class="ready mark-ready ${primary ? 'primary' : 'physical-ready'}" data-ready-control data-action="ready" data-task="${esc(task.taskKey)}" data-order="${esc(task.orderId)}" data-station="${esc(task.stationId)}" ${disabled ? 'disabled' : ''}${missingStation ? ' title="Assign a kitchen station before marking this item ready."' : ''}>Mark ready</button>`;
}
function renderKitchenModeNotice() {
  const root = $('#kitchen-mode-notice');
  if (!root) return;
  const mode = !data.schedulingMode ? 'loading' : data.schedulingMode !== 'manual' ? 'shadow' : !kitchenSnapshotFresh ? 'stale' : !kitchenHasPermission() ? 'readonly' : 'manual';
  root.hidden = ['loading', 'manual'].includes(mode);
  if (root.dataset.mode === mode) return;
  root.dataset.mode = mode;
  root.innerHTML = mode === 'shadow'
    ? '<b>Shadow mode · kitchen buttons are view only</b><p>To record preparation and ready items, an administrator must enable Manual kitchen actions in <a href="/admin#tab-smart-kds" data-kds-setup-link>Admin → Smart KDS → Setup</a>.</p>'
    : mode === 'stale'
      ? '<b>Reconnecting · last kitchen board</b><p>Actions resume when the current queue is confirmed. Food already cooking remains on screen.</p>'
    : mode === 'readonly'
      ? '<b>View only · your staff account cannot update kitchen items</b><p>Ask an administrator to enable your Update kitchen permission. Kitchen mode is managed in <a href="/admin#tab-smart-kds" data-kds-setup-link>Admin → Smart KDS → Setup</a>.</p>'
      : '';
}
function taskStartAllowed(task, state) {
  const view = task.boardStatus || window.RedLanternKdsBoard?.getTaskView({ ...task, taskState: state });
  return taskHasStation(task) && (state === 'fired' ||
    (['ordered', 'eligible', 'scheduled'].includes(state) && view !== 'waiting' && taskAction(task, state)?.[0] === 'start'));
}
function startControl(task, state) {
  const available = kitchenCanAct() && taskStartAllowed(task, state) && !taskIsPending(task);
  const reason = !taskHasStation(task) ? 'Assign a station first' : !kitchenCanAct() ? 'Kitchen actions are view only' : 'Waiting for the preparation window or station capacity';
  return `<button type="button" class="primary start start-control" data-start-control data-action="start" data-task="${esc(task.taskKey)}" data-order="${esc(task.orderId)}" data-station="${esc(task.stationId)}" ${available ? '' : 'disabled'} title="${esc(available ? 'Start preparation' : reason)}">Start</button>`;
}
function learnedTimingLabel(task) {
  const learning = task.learning;
  const estimate = Number(learning?.estimateMinutes), samples = Number(learning?.sampleCount);
  if (data.learning?.enabled === false || learning?.applied !== true || !Number.isFinite(estimate) || estimate <= 0 || !Number.isFinite(samples) || samples < 1) return '';
  const band = ['quiet', 'busy', 'surge'].includes(learning.loadBand) ? learning.loadBand : '';
  const minutes = Math.round(estimate * 10) / 10;
  const baseline = Number(learning.baselineMinutes);
  const reason = `${Math.floor(samples)} recorded kitchen timings${band ? ` during ${band} service` : ''}.${Number.isFinite(baseline) && baseline > 0 ? ` Configured estimate: ${Math.round(baseline * 10) / 10} min.` : ''}${learning.reason ? ` ${learning.reason}` : ''}`;
  return `<span class="learned-timing" title="${esc(reason)}">Learned ${minutes} min${band ? ` · ${band}` : ''}</span>`;
}
function taskCard(task, state) {
  const pending = ['ordered', 'eligible', 'scheduled', 'fired'].includes(state);
  const signal = taskSignal(task, state);
  const status = task.boardStatus || (['ready', 'expo'].includes(state) ? 'ready' : state === 'preparing' ? 'cooking' : taskStartAllowed(task, state) ? 'start' : 'waiting');
  const label = task.expediter?.label || ({ preparing: 'Cooking', ready: 'Ready for expo', expo: 'At expo', held: 'Held' }[state]) || (status === 'start' ? 'Start now' : 'Waiting');
  const target = kitchenTime(task.targetServeAt);
  const forecast = kitchenTime(task.expediter?.readyAt);
  const start = kitchenTime(task.expediter ? task.expediter.startAt : task.plannedStartAt || task.latestSafeStartAt);
  const separateOrderNote = String(task.orderNote || '').trim() && String(task.orderNote).trim() !== String(task.note || '').trim();
  const extras = [task.portion, task.style ? `Style: ${task.style}` : '', Addons.modifierText(task.modifiers), task.note ? `Note: ${task.note}` : '', separateOrderNote ? `Order note: ${task.orderNote}` : ''].filter(Boolean).join(' · ');
  let controls = pending ? startControl(task, state) + markReadyControl(task, state)
    : state === 'preparing' ? markReadyControl(task, state, true)
    : ['ready', 'expo'].includes(state) ? `<button type="button" class="primary ${state === 'ready' ? 'expo' : 'serve'}" data-action="${state === 'ready' ? 'expo' : 'serve'}" data-task="${esc(task.taskKey)}" data-order="${esc(task.orderId)}" data-station="${esc(task.stationId)}" ${!kitchenCanAct() || taskIsPending(task) ? 'disabled' : ''}>${state === 'ready' ? 'Send to expo' : 'Mark served'}</button>`
    : '<button type="button" class="held-control" disabled>Held</button>';
  return `<article class="card kds-item signal-${signal}" data-task-card data-task="${esc(task.taskKey)}" data-order="${esc(task.orderId)}" data-state="${esc(state)}" data-status="${esc(status)}" data-signal="${signal}" data-running-order="${task.runningOrder === true}" data-next="${lastKitchenFocus?.taskKeys?.includes(task.taskKey) === true}">
    <div class="item-heading"><b><span class="item-quantity">${esc(task.quantity)}×</span> ${esc(task.itemName)}</b><span class="item-status">${esc(label)}</span></div>
    ${task.runningOrder === true ? `<span class="running-order-badge" title="${esc(task.runningOrderReason || 'Priority top-up for a customer who is already eating.')}">RUNNING · Priority top-up</span>` : ''}
    ${extras ? `<p class="item-note">${esc(extras)}</p>` : ''}
    <div class="item-bottom"><div class="item-times task-schedule">${status === 'waiting' && start ? `<span>Start ${esc(start)}</span>` : forecast ? `<span class="ready-by">Est. ready ${esc(forecast)}</span>` : `<span>${esc(label)}</span>`}${Number(task.expediter?.delayMinutes) > 0 ? `<span class="forecast-delay">+${Math.ceil(Number(task.expediter.delayMinutes))} min late</span>` : ''}<span class="item-detail item-secondary-times">${esc(stationLabel(task.stationId))}${target ? ` · Due ${esc(target)}` : ''}${forecast && status === 'waiting' ? `<span class="ready-by"> · Est. ready ${esc(forecast)}</span>` : ''}${learnedTimingLabel(task)}</span></div><div class="actions">${controls}</div></div>
    ${task.expediter?.prepAlert ? `<p class="ingredient-alert" title="${esc(task.expediter.prepAlert)}"><b>Prep alert</b> ${esc(task.expediter.prepAlert)}</p>` : ''}
    ${taskCanMarkReady(state) && !taskHasStation(task) ? '<p class="station-required">Assign a kitchen station before marking this item ready.</p>' : ''}
    <div class="item-detail"><p class="task-command">${esc(task.expediter?.instruction || kitchenCommand(task, state))}</p>${task.expediter?.reason ? `<p class="expediter-reason">${esc(task.expediter.reason)}</p>` : ''}<button class="secondary" type="button" data-timeline-order="${esc(task.orderId)}">View timeline</button></div>
  </article>`;
}
function orderTicket(order) {
  const signal = order.tasks.some(task => taskSignal(task, task.taskState) === 'red') ? 'red' : order.tasks.some(task => task.boardStatus === 'start') ? 'green' : order.tasks.every(task => ['ready', 'expo'].includes(task.taskState)) ? 'ready' : 'neutral';
  const runningCount = order.tasks.filter(task => task.runningOrder === true).length;
  return `<article class="order-ticket ticket-${signal}" data-order-ticket data-order="${esc(order.orderId)}" data-running-count="${runningCount}"><header class="ticket-head"><h2>${esc(order.location || taskLocation(order.tasks[0]))}</h2>${runningCount ? `<span class="ticket-running-cue" title="${runningCount} priority top-up item${runningCount === 1 ? '' : 's'}" aria-label="${runningCount} running priority top-up item${runningCount === 1 ? '' : 's'}">RUN ${runningCount}</span>` : ''}<span class="ticket-order">#${esc(String(order.orderNumber || '—').padStart(2, '0'))}</span><small>${order.tasks.length} item${order.tasks.length === 1 ? '' : 's'}</small></header><div class="ticket-items" tabindex="0" aria-label="Items for order ${esc(order.orderNumber || order.orderId)}">${order.tasks.map(task => taskCard(task, task.taskState || 'ordered')).join('')}</div></article>`;
}
function visibleBatches(tasks, states) {
  return (data.batches || []).filter(batch =>
    ['fire-batch', 'wait-for-batch'].includes(batch.action) && batch.batchId &&
    (selectedStation === 'all' || String(batch.stationId) === selectedStation) &&
    batch.allocations?.length && batch.allocations.every(allocation => tasks.some(task =>
      String(task.taskKey) === String(allocation.taskKey) &&
      ['ordered', 'eligible', 'scheduled'].includes(states.get(task.taskKey) || task.taskState || 'ordered') &&
      !['manual-hold', 'hold-for-course'].includes(task.action) &&
      !['manual-hold', 'hold-for-course'].includes(task.pacingState) &&
      !['hold', 'defer'].includes(task.manualOverride?.action) &&
      Number(allocation.quantity) === Number(task.quantity)
    ))
  );
}
function batchHasCapacity(batch, tasks) {
  return Boolean(batch?.action === 'fire-batch' && batch.allocations?.length && batch.allocations.every(allocation => {
    const task = tasks.find(entry => String(entry.taskKey) === String(allocation.taskKey));
    const state = taskStateMap().get(task?.taskKey) || task?.taskState || 'ordered';
    return task && task.capacityState === 'allocated' && ['ordered', 'eligible', 'scheduled'].includes(state) && task.expediter?.signal !== 'yellow';
  }));
}
function batchIsPending(batch) {
  return Boolean(batch && (pendingKitchenActions.has(`batch:${batch.batchId}`) || (batch.allocations || []).some(allocation => {
    const task = (data.recommendations || []).find(entry => String(entry.taskKey) === String(allocation.taskKey)) || allocation;
    return taskIsPending(task);
  })));
}
function batchWindowNote(batch) {
  if (batch.action !== 'wait-for-batch') return '';
  const times = [batch.holdUntilAt, batch.windowClosesAt, batch.latestSafeStartAt].filter(value => value != null && value !== '').map(value => new Date(value).getTime()).filter(Number.isFinite);
  if (!times.length) return '';
  const closesAt = Math.min(...times), remaining = Math.ceil((closesAt - Date.now()) / 60_000);
  return `<p class="batch-window" data-hold-until="${esc(new Date(closesAt).toISOString())}">${remaining > 0 ? `Safe grouping closes ${esc(kitchenTime(closesAt))} · ${remaining} min remaining` : 'Grouping window reached · refresh checks preparation and capacity'}</p>`;
}
function batchCard(batch, tasks, calls) {
  const members = batch.allocations.map(allocation => tasks.find(task => String(task.taskKey) === String(allocation.taskKey)));
  const call = calls.find(entry => String(entry.batchId) === String(batch.batchId));
  const canStart = batchHasCapacity(batch, tasks);
  const signal = members.some(task => task?.expediter?.signal === 'red') ? 'red' : canStart ? 'green' : 'yellow';
  const label = canStart ? 'Start' : signal === 'red' ? 'Check overdue batch' : 'Get ready for';
  return `<article class="batch-card signal-${signal}" data-signal="${signal}"><div><b>${label} ${Number(batch.totalQuantity || 0)} portions together · ${esc(batch.batchGroupId || 'Kitchen')}</b><small>${esc(stationLabel(batch.stationId))} · ${esc(batch.reason)}</small>${call?.instruction ? `<p class="expediter-instruction">${esc(call.instruction)}</p>` : ''}<div class="task-schedule">${call?.startAt ? `<span>Start ${esc(kitchenTime(call.startAt))}</span>` : ''}${call?.readyAt ? `<span>Est. ready ${esc(kitchenTime(call.readyAt))}</span>` : ''}</div>${batchWindowNote(batch)}${!canStart ? '<p class="batch-wait">Wait for the planned batch window and an available station slot.</p>' : ''}<small class="batch-allocation-heading">Table / order allocations · keep portions separate</small><div class="batch-orders">${batch.allocations.map((item, index) => {
    const task = members[index];
    const state = taskStateMap().get(task?.taskKey) || task?.taskState || 'ordered';
    const allocation = { ...task, ...item };
    const course = allocation.course ? title(allocation.course) : '';
    const courseMode = allocation.courseMode ? title(allocation.courseMode) : '';
    return `<div class="batch-allocation"><span>${esc(`${task ? `${taskLocation(allocation)} · ` : ''}${allocation.orderNumber ? `Order #${String(allocation.orderNumber).padStart(2, '0')} · ` : ''}${taskDish(allocation)}${task?.targetServeAt ? ` · service target ${kitchenTime(task.targetServeAt)}` : ''}`)}${course || courseMode ? `<small class="batch-course-context">${esc([course, courseMode].filter(Boolean).join(' · '))}</small>` : ''}</span>${task ? markReadyControl(task, state) : ''}${task && !taskHasStation(task) ? '<small>Assign a kitchen station before marking this item ready.</small>' : ''}</div>`;
  }).join('')}</div><p class="ready-help">Mark ready confirms only that order's item is finished.</p></div><button data-batch-action data-batch="${esc(batch.batchId)}" ${!canStart || !kitchenCanAct() || batchIsPending(batch) ? 'disabled' : ''}>${canStart ? 'Start batch' : 'Waiting for station / window'}</button></article>`;
}
function visibleExpediter(tasks, states) {
  const keys = new Set(tasks.filter(task => !task.expediterStale).map(task => String(task.taskKey)));
  const safeBatches = new Set(visibleBatches(tasks, states).map(batch => String(batch.batchId)));
  const stationMatches = entry => selectedStation === 'all' || String(entry.stationId || '') === selectedStation;
  const result = {
    alerts: (Array.isArray(data.expediter?.alerts) ? data.expediter.alerts : []).filter(alert =>
      alert.type !== 'stale-order' && stationMatches(alert) && (!alert.taskKey || keys.has(String(alert.taskKey)))
    ),
    calls: (Array.isArray(data.expediter?.calls) ? data.expediter.calls : []).filter(call =>
      stationMatches(call) && Array.isArray(call.taskKeys) && call.taskKeys.length &&
      call.taskKeys.every(key => keys.has(String(key))) &&
      (!call.batchId || safeBatches.has(String(call.batchId)))
    ),
  };
  const byKey = new Map(tasks.map(task => [String(task.taskKey), task]));
  const priority = call => {
    const members = (call.taskKeys || []).map(key => byKey.get(String(key))).filter(Boolean);
    if (members.some(task => window.RedLanternKdsBoard.getTaskView({ ...task, taskState: states.get(task.taskKey) || task.taskState || 'ordered' }) === 'start')) return 0;
    if (call.type === 'prep') return 1;
    if (members.some(task => (states.get(task.taskKey) || task.taskState) === 'preparing')) return 2;
    return call.type === 'expo' ? 4 : 3;
  };
  result.calls.sort((left, right) => priority(left) - priority(right) || Number(left.priority || 0) - Number(right.priority || 0));
  return result;
}
function renderKitchenLoad() {
  const root = $('#kitchen-load');
  const load = data.expediter?.load;
  root.hidden = !load;
  if (!load) { root.innerHTML = ''; return; }
  const stations = (Array.isArray(data.expediter?.stations) ? data.expediter.stations : [])
    .filter(station => selectedStation === 'all' || String(station.stationId) === selectedStation);
  const count = value => Math.max(0, Math.round(Number(value) || 0));
  root.dataset.level = ['quiet', 'steady', 'busy', 'surge'].includes(load.level) ? load.level : 'steady';
  const learning = data.learning;
  const samples = count(learning?.qualifyingSamples), learnedTasks = count(learning?.learnedTasks);
  const learningSummary = learning ? `<div class="learning-summary"><b>Recorded kitchen timings</b><span>${samples} qualifying timing${samples === 1 ? '' : 's'} · ${count(learning.trackedDishes)} dishes tracked · ${learnedTasks} active learned estimate${learnedTasks === 1 ? '' : 's'}</span><p>${learning.enabled === false ? 'Timing learning is off. Configured estimates are in use.' : learnedTasks > 0 && samples > 0 ? 'Applied estimates use recorded start and ready confirmations for the current kitchen load.' : 'Configured estimates remain in use until there is enough recorded history for the current kitchen load.'}</p></div>` : '';
  root.innerHTML = `<div class="load-overview"><div><small>KITCHEN LOAD</small><b>${esc(load.label || title(load.level))}</b></div><span>${count(load.activeOrders)} active orders</span><span>${count(load.activePortions)} portions cooking</span><span>${count(load.queuedPortions)} portions queued</span><span>${count(load.atRiskTasks)} need attention</span><strong>Queue forecast · ${count(load.estimatedClearMinutes)} min</strong></div><div class="station-loads">${stations.map(station => `<div class="station-load" data-level="${esc(station.level)}"><b>${esc(station.stationName || stationLabel(station.stationId))}${station.enabled === false ? ' · unavailable' : ''}</b><span>${count(station.occupiedCapacity)} / ${count(station.totalCapacity)} capacity · ${count(station.queuedPortions)} queued</span><small>${station.enabled === false ? 'Reassign waiting work' : `Estimated clear in ${count(station.estimatedClearMinutes)} min`}</small></div>`).join('')}</div>${learningSummary}<p class="forecast-note">Forecast uses configured prep times, qualified kitchen timings when available, and station capacity. Confirm each start and ready action to keep it current.</p>`;
}
function renderKitchenAlerts(alerts) {
  const root = $('#kitchen-alerts');
  const expanded = Boolean(root.querySelector('.additional-alerts[open]'));
  root.hidden = !alerts.length;
  const priority = alert => String(alert.type).includes('prep') && alert.urgent ? 0 : alert.severity === 'critical' ? 1 : 2;
  const sorted = [...alerts].sort((left, right) => priority(left) - priority(right));
  const alertItem = alert => `<li class="kitchen-alert ${alert.severity === 'critical' ? 'signal-red' : 'signal-yellow'}" data-alert-id="${esc(alert.id)}"><b>${esc(alert.type === 'prep' || String(alert.type).includes('prep') ? 'Ingredient readiness' : alert.severity === 'critical' ? 'Needs attention' : 'Kitchen notice')}</b><span>${esc(alert.message)}</span>${alert.stationId ? `<small>${esc(stationLabel(alert.stationId))}</small>` : ''}</li>`;
  root.innerHTML = alerts.length ? `<h2>Kitchen alerts <span>${alerts.length} total · ${alerts.filter(alert => alert.severity === 'critical').length} need attention</span></h2><ul>${sorted.slice(0, 6).map(alertItem).join('')}</ul>${alerts.length > 6 ? `<details class="additional-alerts"><summary>Show ${alerts.length - 6} more alerts · item warnings also remain on the board</summary><ul>${sorted.slice(6).map(alertItem).join('')}</ul></details>` : ''}` : '';
  if (expanded && root.querySelector('.additional-alerts')) root.querySelector('.additional-alerts').open = true;
}
function kitchenSpeechSupported() {
  return Boolean(window.speechSynthesis?.speak && window.SpeechSynthesisUtterance);
}
function kitchenSoundSupported() {
  return Boolean(window.AudioContext || window.webkitAudioContext);
}
function kitchenCallerAllowed() {
  return kitchenSnapshotFresh && data.schedulingMode === 'manual' && Boolean(data.expediter) &&
    (!window.employeeCan || window.employeeCan('kitchenDisplay')) && !document.hidden;
}
function pauseKitchenCaller() {
  kitchenSpeechGeneration += 1;
  kitchenVoiceQueue = [];
  kitchenSpeaking = null;
  try { window.speechSynthesis?.cancel(); } catch (_) {}
}
function syncKitchenCallerControls() {
  const button = $('#caller-toggle'), status = $('#caller-status');
  const supported = kitchenSpeechSupported() || kitchenSoundSupported();
  button.disabled = !supported || (!kitchenCallerEnabled && (!kitchenSnapshotFresh || data.schedulingMode !== 'manual' || !data.expediter ||
    Boolean(window.employeeCan && !window.employeeCan('kitchenDisplay'))));
  button.setAttribute('aria-pressed', String(kitchenCallerEnabled));
  button.textContent = `${kitchenSpeechSupported() ? 'Voice' : 'Sounds'} ${kitchenCallerEnabled ? 'on' : 'off'}`;
  status.textContent = !supported ? 'Voice and alert sounds are unavailable in this browser.'
    : !kitchenSnapshotFresh ? 'Caller paused until live kitchen data returns.'
    : data.schedulingMode !== 'manual' ? 'Shadow preview · voice caller is paused.'
    : window.employeeCan && !window.employeeCan('kitchenDisplay') ? 'Sign in to restore the kitchen caller.'
    : !data.expediter ? 'Caller is waiting for the kitchen schedule.'
    : !kitchenCallerEnabled ? 'Caller is off. Instructions stay on screen.'
    : document.hidden ? 'Caller paused while this display is hidden.'
    : kitchenSpeechSupported() ? 'Caller on · new priority calls and ingredient alerts for this display.'
    : 'Alert chime on · follow the instructions on screen.';
  button.title = status.textContent;
}
function playKitchenChime() {
  if (!kitchenAudioContext || Date.now() - lastKitchenChimeAt < 1000) return;
  try {
    const oscillator = kitchenAudioContext.createOscillator();
    const gain = kitchenAudioContext.createGain();
    const now = kitchenAudioContext.currentTime;
    oscillator.frequency.setValueAtTime(740, now);
    oscillator.frequency.setValueAtTime(990, now + 0.13);
    gain.gain.setValueAtTime(0.12, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.3);
    oscillator.connect(gain); gain.connect(kitchenAudioContext.destination);
    oscillator.start(now); oscillator.stop(now + 0.31);
    oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
    lastKitchenChimeAt = Date.now();
  } catch (_) { /* The visible alerts remain available if device audio fails. */ }
}
function speakNextKitchenCall() {
  if (!kitchenCallerEnabled || !kitchenCallerAllowed() || kitchenSpeaking || !kitchenSpeechSupported()) return;
  const entry = kitchenVoiceQueue.shift();
  if (!entry) return;
  const generation = kitchenSpeechGeneration;
  const utterance = new window.SpeechSynthesisUtterance(entry.message);
  utterance.lang = 'en-IN';
  utterance.rate = 0.95;
  kitchenSpeaking = entry;
  const finish = () => {
    if (generation !== kitchenSpeechGeneration) return;
    kitchenSpeaking = null;
    speakNextKitchenCall();
  };
  utterance.onend = finish;
  utterance.onerror = finish;
  try { window.speechSynthesis.speak(utterance); }
  catch (_) { kitchenSpeaking = null; $('#caller-status').textContent = 'Voice could not play. Follow the calls on screen.'; }
}
function syncKitchenCaller(expediter) {
  syncKitchenCallerControls();
  if (!kitchenCallerEnabled || !kitchenCallerAllowed()) { pauseKitchenCaller(); return; }
  const calls = expediter.calls;
  const runningKeys = new Set((data.recommendations || []).filter(task => task.runningOrder === true).map(task => String(task.taskKey)));
  const runningCall = call => call.runningOrder === true || (call.taskKeys || []).some(key => runningKeys.has(String(key)));
  const calledTasks = new Set(calls.flatMap(call => call.taskKeys || []));
  const entries = [
    ...expediter.alerts.filter(alert => (alert.urgent || alert.severity === 'critical' || String(alert.type).includes('prep')) &&
      (!alert.taskKey || !calledTasks.has(alert.taskKey))).map(alert => ({
      key: `alert:${alert.id}:${alert.severity}`, message: alert.message, urgent: true, priority: String(alert.type).includes('prep') ? 0 : 1,
    })),
    ...calls.map(call => ({ key: `call:${call.id}:${call.signal}${runningCall(call) ? ':running' : ''}`, message: `${call.instruction}${call.startAt ? ` Planned start ${kitchenTime(call.startAt)}.` : ''}${call.readyAt ? ` Estimated ready ${kitchenTime(call.readyAt)}.` : ''}`,
      urgent: call.urgent || call.signal === 'red' || call.type === 'prep' || runningCall(call),
      priority: call.type === 'prep' ? 0 : call.signal === 'red' ? 1 : 2 })),
  ].filter(entry => entry.message && entry.key).sort((left, right) => left.priority - right.priority);
  const current = new Set(entries.map(entry => entry.key));
  kitchenVoiceQueue = kitchenVoiceQueue.filter(entry => current.has(entry.key));
  if (kitchenSpeaking && !current.has(kitchenSpeaking.key)) {
    const waiting = kitchenVoiceQueue;
    pauseKitchenCaller();
    kitchenVoiceQueue = waiting;
  }
  const incoming = entries.slice(0, 12).filter(entry => !seenKitchenCalls.has(entry.key));
  if (incoming.some(entry => entry.urgent)) playKitchenChime();
  // A new urgent call interrupts an ordinary call. It is put back in the queue
  // only if its instruction still exists in the latest authoritative snapshot.
  if (incoming.some(entry => entry.urgent) && kitchenSpeaking && !kitchenSpeaking.urgent) {
    const interrupted = kitchenSpeaking;
    const waiting = kitchenVoiceQueue;
    pauseKitchenCaller();
    kitchenVoiceQueue = [interrupted, ...waiting];
  }
  incoming.forEach(entry => { seenKitchenCalls.add(entry.key); kitchenVoiceQueue.push(entry); });
  kitchenVoiceQueue.sort((left, right) => left.priority - right.priority);
  // Cap speech waiting on a busy shift. Unspoken calls can be selected again
  // at the next snapshot instead of building an obsolete speech backlog.
  kitchenVoiceQueue.splice(12).forEach(entry => seenKitchenCalls.delete(entry.key));
  if (seenKitchenCalls.size > 1000) {
    for (const key of seenKitchenCalls) {
      if (!current.has(key)) seenKitchenCalls.delete(key);
      if (seenKitchenCalls.size <= 1000) break;
    }
  }
  if (kitchenSpeechSupported()) speakNextKitchenCall();
  else kitchenVoiceQueue = [];
}
function renderKitchenBriefing(tasks, states, calls) {
  const root = $('#kitchen-briefing');
  const focus = window.RedLanternKdsBoard.buildKitchenFocus({ recommendations: tasks,
    taskStates: data.taskStates || [], batches: data.batches || [], preferredTaskKey: lastKitchenFocus?.taskKeys?.[0] });
  lastKitchenFocus = focus;
  const task = focus.task || focus.tasks?.[0];
  const scope = selectedStation === 'all' ? 'All stations' : stationLabel(selectedStation);
  let label = 'Kitchen clear', heading = 'No orders waiting', context = 'New orders will appear here.', signal = 'neutral', control = '';
  if (task) {
    const destination = focus.kind === 'batch'
      ? focus.batch.allocations.map(item => `${taskLocation({ ...task, ...item })}: ${item.quantity}×`).join(' · ')
      : `${taskLocation(task)} · Order #${String(task.orderNumber || '—').padStart(2, '0')}`;
    const separateNote = task.orderNote && task.orderNote !== task.note ? `Round note: ${task.orderNote}` : '';
    const recipe = [task.portion, task.style, Addons.modifierText(task.modifiers), task.note ? `Note: ${task.note}` : '', separateNote].filter(Boolean).join(' · ');
    context = [stationLabel(task.stationId), destination, recipe].filter(Boolean).join(' · ');
    signal = taskSignal(task, task.taskState || 'ordered');
    const dish = `${focus.remainingPortions || task.quantity}× ${task.itemName}`;
    if (focus.action === 'start-batch') {
      label = 'Cook together now'; heading = `Prepare ${dish}`;
      control = `<button id="next-action-button" type="button" data-batch-action data-batch="${esc(focus.batchId)}" ${!kitchenCanAct() || batchIsPending(focus.batch) ? 'disabled' : ''}>Start batch</button>`;
    } else if (focus.action === 'start') {
      label = task.runningOrder ? 'Running top-up · start now' : focus.status === 'confirm-start' ? 'Confirm preparation' : 'Do this next · start now';
      heading = `Prepare ${dish}`;
      control = `<button id="next-action-button" class="start-control" data-start-control type="button" data-action="start" data-task="${esc(task.taskKey)}" data-order="${esc(task.orderId)}" data-station="${esc(task.stationId)}" ${!kitchenCanAct() || taskIsPending(task) ? 'disabled' : ''}>${focus.status === 'confirm-start' ? 'Confirm start' : 'Start cooking'}</button>`;
    } else {
      const prep = calls.find(call => call.type === 'prep' && call.taskKeys?.includes(task.taskKey));
      const state = task.taskState || 'ordered';
      const red = signal === 'red';
      label = red ? 'Needs attention · check now' : prep ? 'Get ingredients ready' : focus.status === 'ready' ? 'Ready for collection' : focus.status === 'cooking' ? 'Cooking in progress' : 'Get ready · wait to start';
      heading = `${red ? 'Check' : prep ? 'Prepare ingredients for' : focus.status === 'ready' ? 'Collect' : focus.status === 'cooking' ? 'Cooking' : 'Next'} ${dish}`;
      const explanation = prep?.instruction || task.expediter?.reason || focus.reason;
      context += explanation ? ` · ${explanation}` : '';
      if (focus.status === 'waiting' && task.expediter?.startAt && !['held'].includes(state)) context += ` · Planned start ${kitchenTime(task.expediter.startAt)}`;
    }
  } else if (tasks.length) {
    label = 'Review the queue'; heading = 'Follow the item instructions'; context = 'Check the current cooking and waiting items below.';
  }
  if (!kitchenSnapshotFresh && data.schedulingMode) {
    label = 'Reconnecting'; heading = 'Checking the current kitchen queue';
    context = 'Last board is retained. Actions resume with live confirmation.'; signal = 'yellow';
  }
  root.dataset.signal = signal;
  root.dataset.task = task?.taskKey || '';
  root.innerHTML = `<div class="next-action-copy"><span id="next-action-label">${esc(label)} <small>· ${esc(scope)} · all orders</small></span><h2 id="next-action-title">${esc(heading)}</h2><p id="next-action-context">${esc(context)}</p></div><div class="next-action-controls">${control}<button type="button" data-open-calls>All instructions${calls.length ? ` (${calls.length})` : ''}</button></div>`;
  const shown = calls.slice(0, 8);
  $('#caller-calls-list').innerHTML = `<p class="drawer-intro">${calls.length ? `Showing the next ${shown.length} of ${calls.length} calls. All orders remain on the board.` : 'No current cooking instruction.'}</p><ol class="briefing-list">${shown.map((call, index) => `<li class="signal-${['green', 'yellow', 'red', 'neutral'].includes(call.signal) ? call.signal : 'neutral'}" data-call-id="${esc(call.id)}"><span>${index + 1}</span><div><small>${esc(`${stationLabel(call.stationId)} · ${signalLabel(call.signal)}`)}</small><b>${esc(call.instruction)}</b><p>${call.startAt ? `Start ${esc(kitchenTime(call.startAt))}` : ''}${call.readyAt ? ` · est. ready ${esc(kitchenTime(call.readyAt))}` : ''}</p></div></li>`).join('')}</ol>`;
}

function groupSection(group, tasks, states) {
  const labels = {
    now: ['🔥 Make now', 'Start these dishes first.'],
    risk: ['🚨 Needs attention', 'Check these dishes now; follow each instruction.'],
    next: ['🟡 Get ready', 'Prepare ingredients and follow the planned start time.'],
    hold: ['⏸ Waiting', 'Do not start these yet.'],
    ready: ['✅ Ready to send', 'Take this food to expo or the table.'],
  };
  const [heading, description] = labels[group];
  if (!tasks.length) return '';
  return `<section id="section-${group}" class="action-section ${group}"><header><div><h2>${heading}</h2><p>${description}</p></div><b>${tasks.length}</b></header><div class="card-grid">${tasks.map((task) => taskCard(task, states.get(task.taskKey) || task.taskState || 'ordered')).join('')}</div></section>`;
}
function orderLabel(order) {
  if (String(order.mode || '').toLowerCase() === 'table')
    return `${order.tableArea || 'Table'} ${String(order.tableNumber || '—').padStart(2, '0')}`;
  return title(order.fulfillmentType || order.mode || 'Order');
}
function renderStaleOrders() {
  const root = $('#stale-orders');
  if (!root) return;
  const stale = Array.isArray(data.staleOrders) ? data.staleOrders : [];
  const settings = $('#manager-toggle');
  settings.querySelector('.older-order-count')?.remove();
  if (stale.length) settings.insertAdjacentHTML('beforeend', `<small class="older-order-count">${stale.length} older</small>`);
  settings.title = stale.length ? `${stale.length} earlier-shift orders need manager review` : 'Kitchen settings and details';
  root.hidden = !stale.length;
  if (!stale.length) {
    root.innerHTML = '';
    return;
  }
  const listed = stale
    .slice(0, 3)
    .map(
      (order) =>
        `<li>${esc(`${orderLabel(order)} · Order #${String(order.orderNumber || '—').padStart(2, '0')}`)}</li>`
    )
    .join('');
  root.innerHTML = `<div class="stale-orders-copy"><span class="stale-orders-icon" aria-hidden="true">!</span><div><b>${stale.length} earlier unresolved order${stale.length === 1 ? '' : 's'} need review</b><p>There has been no update for over 12 hours. Smart KDS has kept ${stale.length === 1 ? 'it' : 'them'} out of today's kitchen recommendations.</p>${listed ? `<ul>${listed}${stale.length > 3 ? `<li>+ ${stale.length - 3} more</li>` : ''}</ul>` : ''}</div></div><a class="normal stale-orders-link" href="/kds">Review in Normal KDS</a>`;
}
function renderStationFilter() {
  const select = $('#station-filter');
  const known = new Map((data.stations || []).map((station) => [String(station.id), station]));
  (data.recommendations || []).forEach((task) => {
    if (task.stationId && !known.has(String(task.stationId)))
      known.set(String(task.stationId), {
        id: task.stationId,
        name: task.stationId,
        enabled: true,
      });
  });
  if (selectedStation !== 'all' && !known.has(selectedStation)) selectedStation = 'all';
  select.innerHTML = `<option value="all">All kitchen stations</option>${[...known.values()].map((station) => `<option value="${esc(station.id)}">${esc(station.name || station.id)}${station.enabled === false ? ' · unavailable' : ''}</option>`).join('')}`;
  select.value = selectedStation;
  $('#display-mode-copy').textContent =
    selectedStation === 'all'
      ? 'Global expediter · all kitchen stations'
      : `${stationLabel(selectedStation)} station display`;
}
function renderCategoryFilter() {
  const select = $('#category-filter');
  if (!select) return;
  const categories = [...new Set((data.recommendations || []).map(menuCategory))].sort(
    (left, right) => left.localeCompare(right)
  );
  if (selectedCategory !== 'all' && !categories.includes(selectedCategory))
    selectedCategory = 'all';
  select.innerHTML = `<option value="all">All menu categories</option>${categories.map((category) => `<option value="${esc(category)}">${esc(category)}</option>`).join('')}`;
  select.value = selectedCategory;
}
function render() {
  renderKitchenModeNotice();
  renderStaleOrders();
  renderStationFilter();
  renderCategoryFilter();
  const tasks = filteredTasks();
  const states = taskStateMap();
  const expediter = visibleExpediter(tasks, states);
  renderKitchenLoad();
  renderKitchenAlerts(expediter.alerts);
  renderKitchenBriefing(tasks, states, expediter.calls);
  const view = window.RedLanternKdsBoard.buildBoardView({ recommendations: tasks, taskStates: data.taskStates || [], query: boardQuery, view: selectedBoardStatus, page: boardPage, pageSize: boardPageSize, batches: data.batches || [] });
  lastBoardView = view;
  boardPage = view.page;
  const scrollPositions = new Map([...document.querySelectorAll('[data-order-ticket]')].map(ticket => [ticket.dataset.order, ticket.querySelector('.ticket-items')?.scrollTop || 0]));
  $('#board').dataset.ticketCount = String(view.orders.length);
  $('#board').innerHTML = view.orders.length ? view.orders.map(orderTicket).join('') : `<div class="empty"><b>${tasks.length ? 'No items match this view.' : 'Kitchen clear'}</b><p>${tasks.length ? 'Try another status or search.' : 'New orders will appear here.'}</p></div>`;
  document.querySelectorAll('[data-order-ticket]').forEach(ticket => { ticket.querySelector('.ticket-items').scrollTop = scrollPositions.get(ticket.dataset.order) || 0; });
  document.querySelectorAll('[data-board-status]').forEach(button => {
    button.setAttribute('aria-pressed', String(button.dataset.boardStatus === selectedBoardStatus));
    const label = { all: 'All', start: 'Start now', cooking: 'Cooking', waiting: 'Get ready', ready: 'Ready', attention: 'Needs attention' }[button.dataset.boardStatus];
    button.innerHTML = `${label} <b>${Number(view.counts[button.dataset.boardStatus] || 0)}</b>`;
  });
  $('#board-total').innerHTML = `<b>${view.totalOrders}</b> orders · ${view.totalItems} items${view.totalOrders ? ` <span>· showing ${(view.page - 1) * view.pageSize + 1}–${Math.min(view.page * view.pageSize, view.totalOrders)}</span>` : ''}`;
  $('#board-page-label').textContent = `Page ${view.page} / ${view.pageCount}`;
  $('#board-prev').disabled = view.page <= 1;
  $('#board-next').disabled = view.page >= view.pageCount;
  $('#alerts-count').textContent = String(expediter.alerts.length);
  const prepCount = expediter.alerts.filter(alert => String(alert.type).includes('prep')).length;
  $('#alerts-toggle').querySelector('.prep-alert-count')?.remove();
  if (prepCount) $('#alerts-toggle').insertAdjacentHTML('beforeend', `<small class="prep-alert-count">${prepCount} prep</small>`);
  $('#alerts-toggle').dataset.urgent = String(expediter.alerts.some(alert => alert.severity === 'critical' || alert.urgent));
  $('#alerts-toggle').title = `${expediter.alerts.length} kitchen alerts, including ${expediter.alerts.filter(alert => alert.severity === 'critical').length} urgent`;
  const batches = visibleBatches(tasks, states);
  $('#batches-count').textContent = String(batches.length);
  $('#batch-list').innerHTML = batches.length ? batches.map(batch => batchCard(batch, tasks, expediter.calls)).join('') : '<p class="drawer-intro">No approved batches at this station.</p><p class="drawer-intro">Enable compatible soup/rice batches and set portions per batch in <a href="/admin#tab-smart-kds" data-kds-setup-link data-kds-panel="profiles">Smart KDS menu setup</a>.</p>';
  const load = data.expediter?.load;
  $('#load-toggle').textContent = load ? `Workload · ${Number(load.queuedPortions || 0)} queued` : `${tasks.length} live items`;
  $('#summary').innerHTML = `<p>${view.allOrders || view.totalOrders} orders at this display · ${view.counts.all} live items</p>`;
  syncKitchenPending();
  syncKitchenCaller(expediter);
}
function load() {
  // The live recommendation endpoint performs a full scheduling snapshot.
  // Never overlap snapshots: a slow one followed by the five-second refresh
  // used to queue several expensive calculations and leave the board loading.
  if (loadInFlight) {
    reloadRequested = true;
    return loadInFlight;
  }
  const promise = (async () => {
    do {
      reloadRequested = false;
      await refreshSmartKds();
    } while (reloadRequested);
  })().finally(() => { if (loadInFlight === promise) loadInFlight = null; });
  loadInFlight = promise;
  return promise;
}
async function refreshSmartKds() {
  const request = ++loadSequence;
  try {
    const payload = await smartKdsJson('/api/orders/smart-kds/recommendations', { cache: 'no-store' });
    if (!payload || !Array.isArray(payload.recommendations)) throw new Error('Kitchen recommendations were incomplete. Retaining the last display.');
    if (['taskStates', 'stations', 'batches', 'staleOrders'].some(key => payload[key] != null && !Array.isArray(payload[key]))) throw new Error('Kitchen recommendations were incomplete. Retaining the last display.');
    if (request !== loadSequence) return;
    data = payload;
    kitchenSnapshotFresh = true;
    const operatorInput = $('#operator');
    if (operatorInput && !operatorInput.value)
      operatorInput.value = localStorage.getItem('redLanternKitchenOperator') || '';
    const manual = payload.schedulingMode === 'manual';
    $('#live').textContent = manual ? 'Live' : 'View only';
    $('#live').title = manual ? 'Live kitchen · confirm each start and completion' : 'Shadow recommendations · kitchen actions are view only';
    $('#live').className = `live-state ${manual ? 'manual' : 'shadow'}`;
    const snapshotCursor = Number(payload.realtimeCursor);
    if (Number.isInteger(snapshotCursor) && snapshotCursor >= 0)
      updateCursor = Number.isInteger(updateCursor)
        ? Math.max(updateCursor, snapshotCursor)
        : snapshotCursor;
    setLiveStatus(
      liveConnected
        ? 'Live board · updates instantly · staff actions only'
        : 'Live board · reconnecting · staff actions only'
    );
    render();
  } catch (error) {
    if (request === loadSequence) {
      kitchenSnapshotFresh = false;
      pauseKitchenCaller();
      setLiveStatus(error.message);
      const denied = [401, 403].includes(error.status);
      if (denied) {
        kitchenCallerEnabled = false;
        seenKitchenCalls.clear();
        data = { recommendations: [], taskStates: [], batches: [], stations: [], staleOrders: [], summary: {}, schedulingMode: 'shadow' };
        document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
        render();
      }
      render();
      syncKitchenCallerControls();
      $('#live').textContent = denied ? 'Sign in to view kitchen work' : 'Connection problem · last board';
      $('#live').className = 'live-state stale';
    }
  }
}
async function pollForUpdates() {
  if (updateCheckInFlight) return;
  updateCheckInFlight = true;
  try {
    const suffix = Number.isInteger(updateCursor) ? `?after=${updateCursor}` : '';
    const payload = await smartKdsJson(`/api/orders/smart-kds/updates${suffix}`, { cache: 'no-store' });
    if (Number.isInteger(Number(payload.cursor))) updateCursor = Math.max(Number(updateCursor) || 0, Number(payload.cursor));
    if (payload.events?.length) queueLoad();
  } catch (_) {
    // The regular refresh keeps the display usable during a brief network loss.
  } finally {
    updateCheckInFlight = false;
  }
}
function formatTime(value) {
  if (value == null || value === '') return '—';
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: true }).format(
        date
      )
    : '—';
}
async function showTimeline(orderId) {
  const request = ++timelineSequence;
  const dialog = $('#timeline-dialog');
  const content = $('#timeline-content');
  $('#timeline-title').textContent = 'Loading timeline…';
  content.innerHTML = '<p class="timeline-loading">Loading saved kitchen events…</p>';
  if (!dialog.open) dialog.showModal();
  try {
    const payload = await smartKdsJson(
      `/api/orders/smart-kds/orders/${encodeURIComponent(orderId)}/timeline`,
      { cache: 'no-store' }
    );
    if (request !== timelineSequence || !dialog.open) return;
    const order = payload.order || {};
    const heading =
      order.mode === 'table'
        ? `${order.tableArea || 'Table'} ${String(order.tableNumber || '—').padStart(2, '0')}`
        : title(order.fulfillmentType || order.mode || 'Order');
    $('#timeline-title').textContent =
      `${heading} · Order #${String(order.orderNumber || '—').padStart(2, '0')}`;
    content.innerHTML = payload.timeline?.length
      ? payload.timeline
          .map(
            (task) =>
              `<article class="timeline-task"><header><div><b>${esc(`${task.quantity}× ${task.itemName}`)}</b><small>${esc(title(task.course))} · ${esc(stationLabel(task.stationId))} · ${esc(title(task.state))}</small></div></header><ol>${(task.events || []).map((event) => `<li><time>${esc(formatTime(event.at))}</time><span>${esc(title(event.type))}${event.actor ? ` · ${esc(event.actor)}` : ''}</span></li>`).join('')}</ol></article>`
          )
          .join('')
      : '<p class="timeline-loading">No Smart KDS production tasks have been saved for this order yet.</p>';
  } catch (error) {
    if (request !== timelineSequence || !dialog.open) return;
    content.innerHTML = `<p class="timeline-loading error">${esc(error.message)}</p>`;
  }
}
document.addEventListener('click', async (event) => {
  const setupLink = event.target.closest('[data-kds-setup-link]');
  if (setupLink) {
    localStorage.setItem('redLanternSmartKdsAdminPanel', setupLink.dataset.kdsPanel === 'profiles' ? 'profiles' : 'setup');
    return;
  }
  const timeline = event.target.closest('[data-timeline-order]');
  if (timeline) return showTimeline(timeline.dataset.timelineOrder);
  const batch = event.target.closest('[data-batch-action]');
  const action = event.target.closest('[data-action]');
  if (!batch && !action) return;
  if (!kitchenCanAct()) return;
  if (action?.dataset.action === 'start') {
    const task = (data.recommendations || []).find(entry => String(entry.taskKey) === String(action.dataset.task) && String(entry.orderId) === String(action.dataset.order));
    const state = taskStateMap().get(task?.taskKey) || task?.taskState || 'ordered';
    if (!task || !taskStartAllowed(task, state)) return;
  }
  if (action?.dataset.action === 'ready') {
    const task = (data.recommendations || []).find(entry => String(entry.taskKey) === String(action.dataset.task) && String(entry.orderId) === String(action.dataset.order));
    const state = taskStateMap().get(task?.taskKey) || task?.taskState || 'ordered';
    if (!task || !taskHasStation(task) || !taskCanMarkReady(state)) return;
  }
  const button = batch || action;
  if (batch && !batchHasCapacity((data.batches || []).find(entry => String(entry.batchId) === String(batch.dataset.batch)), data.recommendations || [])) return;
  const keys = batch
    ? [`batch:${batch.dataset.batch}`, ...((data.batches || []).find(entry => String(entry.batchId) === String(batch.dataset.batch))?.allocations || []).map(task => kitchenActionKey(task.orderId, task.taskKey))]
    : [kitchenActionKey(action.dataset.order, action.dataset.task)];
  if (button.disabled || keys.some(key => pendingKitchenActions.has(key))) return;
  keys.forEach(key => pendingKitchenActions.add(key));
  syncKitchenPending();
  button.disabled = true;
  try {
    let payload;
    if (batch) {
      const reason = 'Kitchen confirmed the compatible cooking batch';
      payload = await smartKdsJson(
        `/api/orders/smart-kds/batches/${encodeURIComponent(batch.dataset.batch)}/start`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Kitchen-Operator': operator() },
          body: JSON.stringify({ reason }),
        }
      );
    } else {
      payload = await smartKdsJson('/api/orders/smart-kds/actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Kitchen-Operator': operator() },
        body: JSON.stringify({
          action: action.dataset.action,
          taskKey: action.dataset.task,
          orderId: action.dataset.order,
          stationId: action.dataset.station,
        }),
      });
    }
    if (payload?.ok !== true) throw new Error('The kitchen action was not confirmed. Refresh before retrying.');
    await load();
  } catch (error) {
    await load();
    alert(error.message);
  } finally {
    keys.forEach(key => pendingKitchenActions.delete(key));
    render();
  }
});
$('#station-filter').addEventListener('change', (event) => {
  pauseKitchenCaller();
  selectedStation = event.target.value || 'all';
  boardPage = 1;
  localStorage.setItem('redLanternSmartKdsStation', selectedStation);
  render();
});
$('#category-filter').addEventListener('change', (event) => {
  pauseKitchenCaller();
  selectedCategory = event.target.value || 'all';
  boardPage = 1;
  render();
});
$('#operator').addEventListener('change', () => operator());
$('#board-search').addEventListener('input', event => {
  boardQuery = event.target.value;
  boardPage = 1;
  render();
});
$('#board-status').addEventListener('click', event => {
  const button = event.target.closest('[data-board-status]');
  if (!button) return;
  selectedBoardStatus = button.dataset.boardStatus;
  boardPage = 1;
  render();
});
$('#board-prev').addEventListener('click', () => { if (boardPage > 1) { boardPage -= 1; render(); } });
$('#board-next').addEventListener('click', () => { if (boardPage < (lastBoardView?.pageCount || 1)) { boardPage += 1; render(); } });
const kitchenDrawers = { 'alerts-toggle': 'alerts-dialog', 'batches-toggle': 'batches-dialog', 'load-toggle': 'load-dialog', 'manager-toggle': 'manager-dialog' };
Object.entries(kitchenDrawers).forEach(([button, dialog]) => {
  document.getElementById(button).addEventListener('click', () => document.getElementById(dialog).showModal());
});
document.addEventListener('click', event => {
  if (event.target.closest('[data-open-calls]')) document.getElementById('calls-dialog').showModal();
  const close = event.target.closest('[data-close-dialog]');
  if (close) document.getElementById(close.dataset.closeDialog)?.close();
});
document.querySelectorAll('.kitchen-dialog').forEach(dialog => dialog.addEventListener('click', event => {
  if (event.target === dialog) {
    const bounds = dialog.getBoundingClientRect();
    if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
  }
}));
$('#caller-toggle').addEventListener('click', () => {
  if (kitchenCallerEnabled) {
    kitchenCallerEnabled = false;
    pauseKitchenCaller();
    syncKitchenCallerControls();
    return;
  }
  if (!kitchenCallerAllowed()) return;
  kitchenCallerEnabled = true;
  seenKitchenCalls.clear();
  if (kitchenSoundSupported()) {
    try {
      const Audio = window.AudioContext || window.webkitAudioContext;
      kitchenAudioContext ||= new Audio();
      kitchenAudioContext.resume?.().catch(() => {});
    } catch (_) {}
  }
  syncKitchenCaller(visibleExpediter(filteredTasks(), taskStateMap()));
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) pauseKitchenCaller();
  syncKitchenCallerControls();
  if (!document.hidden) void load();
});
window.addEventListener('red-lantern-auth-changed', () => {
  kitchenCallerEnabled = false;
  pauseKitchenCaller();
  syncKitchenCallerControls();
  syncKitchenPending();
  renderKitchenModeNotice();
});
window.addEventListener('pagehide', pauseKitchenCaller);
window.addEventListener('storage', event => {
  if (event.key === 'red-lantern-staff-access-profile-v1' || event.key === null) {
    kitchenCallerEnabled = false;
    pauseKitchenCaller();
    syncKitchenCallerControls();
    syncKitchenPending();
    renderKitchenModeNotice();
  }
});
$('#kitchen-detail-controls')?.addEventListener('change', event => {
  document.body.classList.toggle('show-kitchen-controls', event.target.checked);
});
document.addEventListener('click', (event) => {
  const jump = event.target.closest('[data-jump-section]');
  if (!jump) return;
  document
    .getElementById(`section-${jump.dataset.jumpSection}`)
    ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
});
$('#timeline-close').addEventListener('click', () => $('#timeline-dialog').close());
$('#timeline-dialog').addEventListener('close', () => { if (!$('#timeline-dialog').open) timelineSequence += 1; });
$('#timeline-dialog').addEventListener('click', (event) => {
  if (event.target === $('#timeline-dialog')) $('#timeline-dialog').close();
});
$('#fullscreen').onclick = () => {
  const result = document.fullscreenElement ? document.exitFullscreen?.() : document.documentElement.requestFullscreen?.();
  result?.catch(() => setLiveStatus('Fullscreen is unavailable in this browser.'));
};
function updateKitchenClock() {
  $('#clock').textContent = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  }).format(new Date());
}
updateKitchenClock();
setInterval(updateKitchenClock, 1000);
function connectLiveUpdates() {
  if (!window.EventSource) return;
  const stream = new EventSource('/api/orders/smart-kds/stream');
  stream.addEventListener('connected', () => {
    liveConnected = true;
    setLiveStatus('Live board · updates instantly · staff actions only');
    queueLoad();
  });
  stream.addEventListener('smart-kds-update', queueLoad);
  stream.onerror = () => {
    liveConnected = false;
    setLiveStatus('Live board · reconnecting · staff actions only');
  };
}
// Staff access can finish verifying after the first board snapshot. Keep the
// completion control visible and disabled when that verification is read only.
const kitchenAccessObserver = new MutationObserver(() => {
  syncKitchenPending();
  renderKitchenModeNotice();
});
['#board', '#batch-list', '#kitchen-briefing'].forEach(selector => kitchenAccessObserver.observe($(selector), { attributes: true, subtree: true, attributeFilter: ['data-employee-denied'] }));
load();
pollForUpdates();
connectLiveUpdates();
setInterval(pollForUpdates, 4000);
// Time alone changes urgency even when no user touches an order. Recalculate
// frequently enough to cross a safe-start boundary without relying on SSE.
setInterval(() => { if (!loadInFlight && !document.hidden) void load(); }, 5000);
