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
let selectedStation = localStorage.getItem('redLanternSmartKdsStation') || 'all';
// Kitchen staff should always see the complete priority list. Category is
// retained as a manager-only diagnostic control, never as a remembered filter
// that could accidentally hide urgent work at the start of a shift.
let selectedCategory = 'all';
const Addons = window.RedLanternAddons;
const pendingKitchenActions = new Set();
const kitchenActionKey = (orderId, taskKey) => JSON.stringify([String(orderId), String(taskKey)]);
const kitchenCanAct = () => data.schedulingMode === 'manual' && (!window.employeeCan || window.employeeCan('updateKitchen'));
const taskIsPending = (task) => pendingKitchenActions.has(kitchenActionKey(task.orderId, task.taskKey));
let timelineSequence = 0;
function syncKitchenPending() {
  document.querySelectorAll('#board button[data-task][data-order]').forEach(button => {
    button.disabled = !kitchenCanAct() || pendingKitchenActions.has(kitchenActionKey(button.dataset.order, button.dataset.task));
  });
  document.querySelectorAll('#board [data-batch-action]').forEach(button => {
    button.disabled = !kitchenCanAct() || pendingKitchenActions.has(`batch:${button.dataset.batch}`);
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
  return `${task.quantity}× ${task.itemName}${task.portion ? ` · ${task.portion}` : ''}${extras ? ` + ${extras}` : ''}`;
}
function filteredTasks() {
  const tasks = Array.isArray(data.recommendations) ? data.recommendations : [];
  const states = taskStateMap();
  return tasks.filter(
    (task) =>
      !['served', 'cancelled', 'superseded'].includes(states.get(task.taskKey) || task.taskState) &&
      (selectedStation === 'all' || String(task.stationId || '') === selectedStation) &&
      (selectedCategory === 'all' || menuCategory(task) === selectedCategory)
  );
}
function timeUntil(date) {
  const target = new Date(date).getTime();
  if (!Number.isFinite(target)) return '';
  const minutes = Math.ceil((target - Date.now()) / 60_000);
  return minutes <= 0 ? `Start overdue by ${Math.abs(minutes)} min` : `Start within ${minutes} min`;
}
function kitchenTime(value) {
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
  if (state === 'fired' || state === 'preparing') return 'now';
  if (state === 'held' || ['manual-hold', 'wait-capacity', 'hold-for-course', 'assign-station'].includes(task.action)) return 'hold';
  // "Overdue" means the kitchen should look at the item now. It is not, by
  // itself, proof that a guest's table is at risk. Keep that distinction clear
  // so the board does not turn every delayed item into a service-risk alert.
  if (task.action === 'service-risk' || task.serviceRiskSeverity === 'critical') return 'risk';
  if (task.baseAction === 'start-now' || task.action === 'start-now') return 'now';
  if (['critical', 'overdue'].includes(String(task.state || ''))) return 'now';
  if (task.baseAction === 'prepare-next' || task.action === 'prepare-next') return 'next';
  return 'hold';
}
function taskCard(task, state) {
  const primary = taskAction(task, state);
  const unavailable =
    state === 'ordered' && task.capacityState !== 'allocated'
      ? 'Waiting for capacity'
      : state === 'held'
        ? 'Held by kitchen'
        : 'Action unavailable';
  const control = primary && kitchenCanAct()
    ? `<button class="primary ${esc(primary[0])}" data-action="${esc(primary[0])}" data-task="${esc(task.taskKey)}" data-order="${esc(task.orderId)}" data-station="${esc(task.stationId)}" ${taskIsPending(task) ? 'disabled' : ''}>${esc(primary[1])}</button>`
    : primary ? `<button class="primary" disabled>${data.schedulingMode !== 'manual' ? 'Shadow mode · view only' : 'View only'}</button>`
    : `<button disabled>${esc(unavailable)}</button>`;
  const table = taskLocation(task);
  const target = kitchenTime(task.targetServeAt);
  const actionLabel = kitchenActionLabel(task, state);
  return `<article class="card" data-task-card data-task="${esc(task.taskKey)}" data-order="${esc(task.orderId)}">
    <header><div><small class="card-category">${esc(menuCategory(task))}</small><b>${esc(taskDish(task))}</b><small>${esc(`${table} · Order #${String(task.orderNumber || '—').padStart(2, '0')}`)}</small></div>${target ? `<span class="ready-by"><small>READY BY</small><b>${esc(target)}</b></span>` : `<span class="station">${esc(stationLabel(task.stationId))}</span>`}</header>
    <div class="body"><div class="task-command"><span>${esc(actionLabel)}</span><b>${esc(kitchenCommand(task, state))}</b></div>
      <div class="actions">${control}<button class="secondary" type="button" data-timeline-order="${esc(task.orderId)}">View timeline</button></div>
    </div>
  </article>`;
}
function renderKitchenBriefing(tasks, states) {
  const root = $('#kitchen-briefing');
  if (!root) return;
  const current = tasks
    .map((task) => ({ task, state: states.get(task.taskKey) || task.taskState || 'ordered' }))
    .filter(({ state }) => !['held', 'served', 'cancelled', 'superseded'].includes(state));
  const commands = current
    .filter(({ task }) => task.action !== 'fairness-protected' || task.baseAction === 'start-now')
    .filter(({ task, state }) => taskGroup(task, state) !== 'hold')
    .slice(0, 4);
  if (!commands.length) {
    root.innerHTML = `<div class="briefing-heading"><div><span>CHEF BRIEFING</span><h2>No current cooking instruction</h2><p>There is no live work to call to the kitchen for this display.</p></div></div>`;
    return;
  }
  root.innerHTML = `<div class="briefing-heading"><div><span>KITCHEN CALLS</span><h2>Make these dishes first</h2><p>Follow the list from 1 onwards. Update each dish when it is ready.</p></div><b>${commands.length} to make</b></div><ol class="briefing-list">${commands.map(({ task, state }, index) => `<li><span>${index + 1}</span><div><small>${esc(`${menuCategory(task)} · ${kitchenActionLabel(task, state)}`)}</small><b>${esc(taskInstruction(task, state))}</b><p>${esc(taskLocation(task))}</p></div></li>`).join('')}</ol>`;
}
function groupSection(group, tasks, states) {
  const labels = {
    now: ['🔥 Make now', 'Start these dishes first.'],
    risk: ['🚨 Make first', 'These tables need food first.'],
    next: ['🟡 Make next', 'Prepare these after the work above.'],
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
  select.innerHTML = `<option value="all">Global expediter · all stations</option>${[...known.values()].map((station) => `<option value="${esc(station.id)}">${esc(station.name || station.id)}${station.enabled === false ? ' · unavailable' : ''}</option>`).join('')}`;
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
  renderStaleOrders();
  renderStationFilter();
  renderCategoryFilter();
  const tasks = filteredTasks();
  const states = taskStateMap();
  renderKitchenBriefing(tasks, states);
  const visible = tasks.map((task) => ({
    task,
    state: states.get(task.taskKey) || task.taskState || 'ordered',
  }));
  const totals = {
    startNow: visible.filter(
      ({ task, state }) => taskGroup(task, state) !== 'hold' && (task.baseAction === 'start-now' || task.action === 'start-now')
    ).length,
    serviceRisk: visible.filter(
      ({ task }) => task.action === 'service-risk' || task.serviceRiskSeverity === 'critical'
    ).length,
    waitingCapacity: visible.filter(({ task }) =>
      ['capacity-wait', 'capacity-too-large'].includes(task.capacityState)
    ).length,
    ready: visible.filter(({ state }) => ['ready', 'expo'].includes(state)).length,
  };
  const batches = (data.batches || []).filter(
    (batch) =>
      batch.action === 'fire-batch' &&
      batch.batchId &&
      (selectedStation === 'all' || String(batch.stationId) === selectedStation) &&
      batch.allocations?.length && batch.allocations.every(allocation => visible.some(({ task, state }) => String(task.taskKey) === String(allocation.taskKey) && ['ordered', 'eligible', 'scheduled'].includes(state)))
  );
  $('#summary').innerHTML = [
    ['startNow', 'Start now', 'now'],
    ['serviceRisk', 'Table risk', 'risk'],
    ['waitingCapacity', 'Capacity queue', 'hold'],
    ['ready', 'Ready / expo', 'ready'],
  ]
    .map(
      ([key, label, section]) =>
        `<button type="button" data-jump-section="${section}"><b>${Number(totals[key] || 0)}</b><span>${label}</span></button>`
    )
    .join('');
  const batchTaskKeys = new Set(
    batches.flatMap((batch) =>
      (batch.allocations || []).map((allocation) => String(allocation.taskKey || ''))
    )
  );
  const batchCards = batches.length
    ? `<section id="section-batches" class="action-section now"><header><div><h2>🍳 Ready batches</h2><p>Start one batch action; its individual items are intentionally kept out of the list below.</p></div><b>${batches.length}</b></header><div class="batch-grid">${batches
        .map(
          (batch) =>
            `<article class="batch-card"><div><b>Batch · ${esc(batch.batchGroupId || 'Kitchen')}</b><small>${esc(stationLabel(batch.stationId))} · ${Number(batch.totalQuantity || 0)} portions · ${esc(batch.reason)}</small><div class="batch-orders">${(
              batch.allocations || []
            )
              .map((item) => {
                const dish = taskDish(item);
                return `<span>${esc(item.orderNumber ? `Order #${String(item.orderNumber).padStart(2, '0')} · ${dish}` : dish)}</span>`;
              })
              .join(
                ''
              )}</div></div><button data-batch-action data-batch="${esc(batch.batchId)}" ${!kitchenCanAct() || pendingKitchenActions.has(`batch:${batch.batchId}`) ? 'disabled' : ''}>Start batch</button></article>`
        )
        .join('')}</div></section>`
    : '';
  const groups = { now: [], risk: [], next: [], hold: [], ready: [] };
  visible
    .filter(({ task }) => !batchTaskKeys.has(String(task.taskKey)))
    .forEach(({ task, state }) => groups[taskGroup(task, state)].push(task));
  const sections = ['now', 'risk', 'next', 'hold', 'ready']
    .map((group) => groupSection(group, groups[group], states))
    .join('');
  $('#board').innerHTML =
    batchCards + sections ||
    '<div class="empty"><b>No current kitchen work for this display.</b><br>Earlier unresolved orders, if any, are shown above for review in Normal KDS.</div>';
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
    const operatorInput = $('#operator');
    if (operatorInput && !operatorInput.value)
      operatorInput.value = localStorage.getItem('redLanternKitchenOperator') || '';
    const manual = payload.schedulingMode === 'manual';
    $('#live').textContent = manual ? 'Manual kitchen actions' : 'Shadow recommendations';
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
      setLiveStatus(error.message);
      const denied = [401, 403].includes(error.status);
      if (denied) {
        data = { recommendations: [], taskStates: [], batches: [], stations: [], staleOrders: [], summary: {}, schedulingMode: 'shadow' };
        $('#timeline-dialog').close(); $('#override-dialog').close();
        render();
      }
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
  const timeline = event.target.closest('[data-timeline-order]');
  if (timeline) return showTimeline(timeline.dataset.timelineOrder);
  const batch = event.target.closest('[data-batch-action]');
  const action = event.target.closest('[data-action]');
  if (!batch && !action) return;
  if (!kitchenCanAct()) return;
  const button = batch || action;
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
      const reason = String(window.prompt('Why are you starting this batch?') || '').trim();
      if (reason.length < 3) {
        return;
      }
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
  selectedStation = event.target.value || 'all';
  localStorage.setItem('redLanternSmartKdsStation', selectedStation);
  render();
});
$('#category-filter').addEventListener('change', (event) => {
  selectedCategory = event.target.value || 'all';
  render();
});
$('#operator').addEventListener('change', () => operator());
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
load();
pollForUpdates();
connectLiveUpdates();
setInterval(pollForUpdates, 4000);
// Time alone changes urgency even when no user touches an order. Recalculate
// frequently enough to cross a safe-start boundary without relying on SSE.
setInterval(() => { if (!loadInFlight && !document.hidden) void load(); }, 5000);
