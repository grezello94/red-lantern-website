const $ = (selector) => document.querySelector(selector);
const esc = (value) => String(value ?? '').replace(/[&<>'"]/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
}[character]));

let data = { recommendations: [], summary: {}, taskStates: [], batches: [], stations: [], staleOrders: [] };
let liveConnected = false;
let refreshTimer = null;
let updateCursor = null;
let loadSequence = 0;
let loadInFlight = false;
let reloadRequested = false;
let updateCheckInFlight = false;
let selectedStation = localStorage.getItem('redLanternSmartKdsStation') || 'all';
// Kitchen staff should always see the complete priority list. Category is
// retained as a manager-only diagnostic control, never as a remembered filter
// that could accidentally hide urgent work at the start of a shift.
let selectedCategory = 'all';

function operator() {
  const input = $('#operator');
  const value = String(input?.value || localStorage.getItem('redLanternKitchenOperator') || '').trim();
  if (value) localStorage.setItem('redLanternKitchenOperator', value.slice(0, 100));
  return value || 'Kitchen console';
}

function title(value) { return String(value || '').replace(/-/g, ' '); }
function setLiveStatus(message) { $('#status').textContent = message; }
function queueLoad() { clearTimeout(refreshTimer); refreshTimer = setTimeout(load, 120); }
function taskStateMap() { return new Map((data.taskStates || []).map((task) => [task.task_id, task.task_state])); }
function stationLabel(stationId) {
  const station = (data.stations || []).find((entry) => String(entry.id) === String(stationId));
  return station?.name || stationId || 'Station not assigned';
}
function menuCategory(task) { return String(task?.category || 'Menu').trim() || 'Menu'; }
function filteredTasks() {
  const tasks = Array.isArray(data.recommendations) ? data.recommendations : [];
  return tasks.filter((task) => (
    (selectedStation === 'all' || String(task.stationId || '') === selectedStation) &&
    (selectedCategory === 'all' || menuCategory(task) === selectedCategory)
  ));
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
  const time = new Intl.DateTimeFormat('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true }).format(date);
  const today = new Date();
  const sameDay = date.getFullYear() === today.getFullYear() && date.getMonth() === today.getMonth() && date.getDate() === today.getDate();
  return sameDay ? time : `${date.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })} · ${time}`;
}
function taskLocation(task) {
  return task.mode === 'table'
    ? `${task.tableArea || 'Table'} ${String(task.tableNumber || '—').padStart(2, '0')}`
    : title(task.fulfillmentType || task.mode || 'order');
}
function taskInstruction(task, state) {
  const dish = `${task.quantity}× ${task.itemName}`;
  const location = taskLocation(task);
  const target = kitchenTime(task.targetServeAt);
  const start = kitchenTime(task.plannedStartAt || task.latestSafeStartAt);
  if (state === 'ready' || state === 'expo') return `Send ${dish} for ${location} to expo now.`;
  if (state === 'fired' || state === 'preparing') return `Continue ${dish} for ${location}${target ? ` · target ready ${target}` : ''}.`;
  if (task.capacityState === 'allocated' && (task.baseAction === 'start-now' || task.action === 'start-now' || task.action === 'service-risk'))
    return `Prepare ${dish} for ${location} now${target ? ` · target ready ${target}` : ''}.`;
  if (task.action === 'prepare-next' || task.baseAction === 'prepare-next')
    return `Prepare ${dish} for ${location}${start ? ` at ${start}` : ' next'}${target ? ` · target ready ${target}` : ''}.`;
  if (task.action === 'wait-capacity') return `Do not start ${dish} for ${location} yet · the station is at capacity${start ? `, review at ${start}` : ''}.`;
  if (task.action === 'hold-for-course' || task.capacityState === 'hold-for-course') return `Hold ${dish} for ${location} until the earlier course is ready.`;
  if (task.action === 'assign-station') return `Assign a kitchen station before preparing ${dish} for ${location}.`;
  return `Review ${dish} for ${location}${target ? ` · target ready ${target}` : ''}.`;
}
function kitchenActionLabel(task, state) {
  if (state === 'ready' || state === 'expo') return 'Send out now';
  if (state === 'fired' || state === 'preparing') return 'Cooking now';
  if (task.action === 'service-risk') return 'Make first';
  if (task.action === 'wait-capacity' || task.action === 'hold-for-course') return 'Wait';
  if (task.action === 'assign-station') return 'Assign station';
  if (task.baseAction === 'prepare-next' || task.action === 'prepare-next') return 'Make next';
  return 'Make now';
}
function kitchenCommand(task, state) {
  if (state === 'ready' || state === 'expo') return 'Take this dish to expo now';
  if (state === 'fired' || state === 'preparing') return 'Keep cooking this dish';
  if (task.action === 'wait-capacity') return 'Wait until the station is free';
  if (task.action === 'hold-for-course' || task.capacityState === 'hold-for-course') return 'Wait for the earlier course';
  if (task.action === 'assign-station') return 'Choose a kitchen station first';
  if (task.baseAction === 'prepare-next' || task.action === 'prepare-next') return 'Prepare this dish next';
  return 'Start this dish now';
}
function taskAction(task, state) {
  if (['ordered', 'eligible', 'scheduled'].includes(state) && task.capacityState === 'allocated') return ['start', 'Start preparation'];
  if (state === 'fired') return ['start', 'Start preparation'];
  if (state === 'preparing') return ['ready', 'Mark ready'];
  if (state === 'ready') return ['expo', 'Send to expo'];
  if (state === 'expo') return ['serve', 'Mark served'];
  return null;
}
function taskGroup(task, state) {
  if (state === 'ready' || state === 'expo') return 'ready';
  if (state === 'fired' || state === 'preparing') return 'now';
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
  const unavailable = state === 'ordered' && task.capacityState !== 'allocated'
    ? 'Waiting for capacity'
    : state === 'held' ? 'Held by kitchen'
      : 'Action unavailable';
  const control = primary
    ? `<button class="primary ${esc(primary[0])}" data-action="${esc(primary[0])}" data-task="${esc(task.taskKey)}" data-order="${esc(task.orderId)}" data-station="${esc(task.stationId)}">${esc(primary[1])}</button>`
    : `<button disabled>${esc(unavailable)}</button>`;
  const table = taskLocation(task);
  const target = kitchenTime(task.targetServeAt);
  const actionLabel = kitchenActionLabel(task, state);
  return `<article class="card" data-task-card data-task="${esc(task.taskKey)}" data-order="${esc(task.orderId)}">
    <header><div><small class="card-category">${esc(menuCategory(task))}</small><b>${esc(`${task.quantity}× ${task.itemName}`)}</b><small>${esc(`${table} · Order #${String(task.orderNumber || '—').padStart(2, '0')}`)}</small></div>${target ? `<span class="ready-by"><small>READY BY</small><b>${esc(target)}</b></span>` : `<span class="station">${esc(stationLabel(task.stationId))}</span>`}</header>
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
  const listed = stale.slice(0, 3).map((order) => `<li>${esc(`${orderLabel(order)} · Order #${String(order.orderNumber || '—').padStart(2, '0')}`)}</li>`).join('');
  root.innerHTML = `<div class="stale-orders-copy"><span class="stale-orders-icon" aria-hidden="true">!</span><div><b>${stale.length} earlier unresolved order${stale.length === 1 ? '' : 's'} need review</b><p>There has been no update for over 12 hours. Smart KDS has kept ${stale.length === 1 ? 'it' : 'them'} out of today's kitchen recommendations.</p>${listed ? `<ul>${listed}${stale.length > 3 ? `<li>+ ${stale.length - 3} more</li>` : ''}</ul>` : ''}</div></div><a class="normal stale-orders-link" href="/kds">Review in Normal KDS</a>`;
}
function renderStationFilter() {
  const select = $('#station-filter');
  const known = new Map((data.stations || []).map((station) => [String(station.id), station]));
  (data.recommendations || []).forEach((task) => {
    if (task.stationId && !known.has(String(task.stationId))) known.set(String(task.stationId), { id: task.stationId, name: task.stationId, enabled: true });
  });
  if (selectedStation !== 'all' && !known.has(selectedStation)) selectedStation = 'all';
  select.innerHTML = `<option value="all">Global expediter · all stations</option>${[...known.values()].map((station) => `<option value="${esc(station.id)}">${esc(station.name || station.id)}${station.enabled === false ? ' · unavailable' : ''}</option>`).join('')}`;
  select.value = selectedStation;
  $('#display-mode-copy').textContent = selectedStation === 'all' ? 'Global expediter · all kitchen stations' : `${stationLabel(selectedStation)} station display`;
}
function renderCategoryFilter() {
  const select = $('#category-filter');
  if (!select) return;
  const categories = [...new Set((data.recommendations || []).map(menuCategory))].sort((left, right) => left.localeCompare(right));
  if (selectedCategory !== 'all' && !categories.includes(selectedCategory)) selectedCategory = 'all';
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
  const visible = tasks.map((task) => ({ task, state: states.get(task.taskKey) || task.taskState || 'ordered' }));
  const totals = {
    startNow: visible.filter(({ task }) => task.baseAction === 'start-now' || task.action === 'start-now').length,
    serviceRisk: visible.filter(({ task }) => task.action === 'service-risk' || task.serviceRiskSeverity === 'critical').length,
    waitingCapacity: visible.filter(({ task }) => ['capacity-wait', 'capacity-too-large'].includes(task.capacityState)).length,
    ready: visible.filter(({ state }) => ['ready', 'expo'].includes(state)).length,
  };
  const batches = (data.batches || []).filter((batch) => batch.action === 'fire-batch' && batch.batchId && (selectedStation === 'all' || String(batch.stationId) === selectedStation));
  $('#summary').innerHTML = [['startNow', 'Start now', 'now'], ['serviceRisk', 'Table risk', 'risk'], ['waitingCapacity', 'Capacity queue', 'hold'], ['ready', 'Ready / expo', 'ready']]
    .map(([key, label, section]) => `<button type="button" data-jump-section="${section}"><b>${Number(totals[key] || 0)}</b><span>${label}</span></button>`).join('');
  const batchTaskKeys = new Set(batches.flatMap((batch) => (batch.allocations || []).map((allocation) => String(allocation.taskKey || ''))));
  const batchCards = batches.length ? `<section id="section-batches" class="action-section now"><header><div><h2>🍳 Ready batches</h2><p>Start one batch action; its individual items are intentionally kept out of the list below.</p></div><b>${batches.length}</b></header><div class="batch-grid">${batches.map((batch) => `<article class="batch-card"><div><b>Batch · ${esc(batch.batchGroupId || 'Kitchen')}</b><small>${esc(stationLabel(batch.stationId))} · ${Number(batch.totalQuantity || 0)} portions · ${esc(batch.reason)}</small><div class="batch-orders">${(batch.allocations || []).map((item) => `<span>${esc(item.orderNumber ? `Order #${String(item.orderNumber).padStart(2, '0')} · ${item.quantity}× ${item.itemName}` : `${item.quantity}× ${item.itemName}`)}</span>`).join('')}</div></div><button data-batch-action data-batch="${esc(batch.batchId)}">Start batch</button></article>`).join('')}</div></section>` : '';
  const groups = { now: [], risk: [], next: [], hold: [], ready: [] };
  visible.filter(({ task }) => !batchTaskKeys.has(String(task.taskKey))).forEach(({ task, state }) => groups[taskGroup(task, state)].push(task));
  const sections = ['now', 'risk', 'next', 'hold', 'ready'].map((group) => groupSection(group, groups[group], states)).join('');
  $('#board').innerHTML = batchCards + sections || '<div class="empty"><b>No current kitchen work for this display.</b><br>Earlier unresolved orders, if any, are shown above for review in Normal KDS.</div>';
}
async function load() {
  // The live recommendation endpoint performs a full scheduling snapshot.
  // Never overlap snapshots: a slow one followed by the five-second refresh
  // used to queue several expensive calculations and leave the board loading.
  if (loadInFlight) {
    reloadRequested = true;
    return;
  }
  loadInFlight = true;
  const request = ++loadSequence;
  try {
    const response = await fetch('/api/orders/smart-kds/recommendations', { cache: 'no-store' });
    const payload = await response.json();
    if (!response.ok) throw Error(payload.error || 'Unable to load Smart KDS.');
    if (request !== loadSequence) return;
    data = payload;
    const operatorInput = $('#operator');
    if (operatorInput && !operatorInput.value) operatorInput.value = localStorage.getItem('redLanternKitchenOperator') || '';
    const manual = payload.schedulingMode === 'manual';
    $('#live').textContent = manual ? 'Manual kitchen actions' : 'Shadow recommendations';
    $('#live').className = `live-state ${manual ? 'manual' : 'shadow'}`;
    const snapshotCursor = Number(payload.realtimeCursor);
    if (Number.isInteger(snapshotCursor) && snapshotCursor >= 0)
      updateCursor = Number.isInteger(updateCursor) ? Math.max(updateCursor, snapshotCursor) : snapshotCursor;
    setLiveStatus(liveConnected ? 'Live board · updates instantly · staff actions only' : 'Live board · reconnecting · staff actions only');
    render();
  } catch (error) {
    if (request === loadSequence) setLiveStatus(error.message);
  } finally {
    loadInFlight = false;
    if (reloadRequested) {
      reloadRequested = false;
      queueLoad();
    }
  }
}
async function pollForUpdates() {
  if (updateCheckInFlight) return;
  updateCheckInFlight = true;
  try {
    const suffix = Number.isInteger(updateCursor) ? `?after=${updateCursor}` : '';
    const response = await fetch(`/api/orders/smart-kds/updates${suffix}`, { cache: 'no-store' });
    const payload = await response.json();
    if (!response.ok) throw Error(payload.error || 'Unable to check Smart KDS updates.');
    if (Number.isInteger(Number(payload.cursor))) updateCursor = Number(payload.cursor);
    if (payload.events?.length) queueLoad();
  } catch (_) {
    // The regular refresh keeps the display usable during a brief network loss.
  } finally { updateCheckInFlight = false; }
}
function formatTime(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true }).format(date) : '—';
}
async function showTimeline(orderId) {
  const dialog = $('#timeline-dialog');
  const content = $('#timeline-content');
  $('#timeline-title').textContent = 'Loading timeline…';
  content.innerHTML = '<p class="timeline-loading">Loading saved kitchen events…</p>';
  dialog.showModal();
  try {
    const response = await fetch(`/api/orders/smart-kds/orders/${encodeURIComponent(orderId)}/timeline`, { cache: 'no-store' });
    const payload = await response.json();
    if (!response.ok) throw Error(payload.error || 'Unable to load the order timeline.');
    const order = payload.order || {};
    const heading = order.mode === 'table' ? `${order.tableArea || 'Table'} ${String(order.tableNumber || '—').padStart(2, '0')}` : title(order.fulfillmentType || order.mode || 'Order');
    $('#timeline-title').textContent = `${heading} · Order #${String(order.orderNumber || '—').padStart(2, '0')}`;
    content.innerHTML = payload.timeline?.length ? payload.timeline.map((task) => `<article class="timeline-task"><header><div><b>${esc(`${task.quantity}× ${task.itemName}`)}</b><small>${esc(title(task.course))} · ${esc(stationLabel(task.stationId))} · ${esc(title(task.state))}</small></div></header><ol>${(task.events || []).map((event) => `<li><time>${esc(formatTime(event.at))}</time><span>${esc(title(event.type))}${event.actor ? ` · ${esc(event.actor)}` : ''}</span></li>`).join('')}</ol></article>`).join('') : '<p class="timeline-loading">No Smart KDS production tasks have been saved for this order yet.</p>';
  } catch (error) {
    content.innerHTML = `<p class="timeline-loading error">${esc(error.message)}</p>`;
  }
}
document.addEventListener('click', async (event) => {
  const timeline = event.target.closest('[data-timeline-order]');
  if (timeline) return showTimeline(timeline.dataset.timelineOrder);
  const batch = event.target.closest('[data-batch-action]');
  const action = event.target.closest('[data-action]');
  if (!batch && !action) return;
  const button = batch || action;
  button.disabled = true;
  try {
    let response;
    if (batch) {
      const reason = String(window.prompt('Why are you starting this batch?') || '').trim();
      if (reason.length < 3) { button.disabled = false; return; }
      response = await fetch(`/api/orders/smart-kds/batches/${encodeURIComponent(batch.dataset.batch)}/start`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Kitchen-Operator': operator() }, body: JSON.stringify({ reason }) });
    } else {
      response = await fetch('/api/orders/smart-kds/actions', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Kitchen-Operator': operator() }, body: JSON.stringify({ action: action.dataset.action, taskKey: action.dataset.task, orderId: action.dataset.order, stationId: action.dataset.station }) });
    }
    const payload = await response.json();
    if (!response.ok) throw Error(payload.error || 'Action failed.');
    await load();
  } catch (error) { alert(error.message); button.disabled = false; }
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
document.addEventListener('click', (event) => {
  const jump = event.target.closest('[data-jump-section]');
  if (!jump) return;
  document.getElementById(`section-${jump.dataset.jumpSection}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
});
$('#timeline-close').addEventListener('click', () => $('#timeline-dialog').close());
$('#timeline-dialog').addEventListener('click', (event) => { if (event.target === $('#timeline-dialog')) $('#timeline-dialog').close(); });
$('#fullscreen').onclick = () => document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen();
setInterval(() => { $('#clock').textContent = new Intl.DateTimeFormat('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true }).format(new Date()); }, 1000);
function connectLiveUpdates() {
  if (!window.EventSource) return;
  const stream = new EventSource('/api/orders/smart-kds/stream');
  stream.addEventListener('connected', () => { liveConnected = true; setLiveStatus('Live board · updates instantly · staff actions only'); queueLoad(); });
  stream.addEventListener('smart-kds-update', queueLoad);
  stream.onerror = () => { liveConnected = false; setLiveStatus('Live board · reconnecting · staff actions only'); };
}
load();
pollForUpdates();
connectLiveUpdates();
setInterval(pollForUpdates, 4000);
// Time alone changes urgency even when no user touches an order. Recalculate
// frequently enough to cross a safe-start boundary without relying on SSE.
setInterval(load, 5000);
