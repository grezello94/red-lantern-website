const $ = (s) => document.querySelector(s);
const esc = (v) =>
  String(v ?? '').replace(
    /[&<>'"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[c]
  );
const state = { station: 'all', orders: [], operations: null, history: [], statuses: [] };
const Addons = window.RedLanternAddons;
const pendingActions = new Set();
let loadPromise = null, reloadRequested = false;
const ticketKey = (order, kot, printer) => JSON.stringify([String(order), Number(kot), String(printer)]);
const fulfillment = (order) =>
  order.mode === 'table'
    ? 'Dine-in'
    : order.fulfillment_type === 'delivery'
      ? 'Delivery'
      : 'Counter / pickup';
const lineIdentity = (item) => JSON.stringify([
  item.name || '', item.category || '', item.portion || '',
  item.style || '', item.note || '', Addons.selectionFingerprint(item.modifiers),
]);
const lineId = (item) => String(item.lineId || item.sourceLineId || '');
function tickets() {
  const printers = state.operations?.printers || [],
    all = [];
  state.orders
    .filter((o) => ['accepted', 'preparing', 'ready'].includes(o.status))
    .forEach((order) => {
      const rounds = state.history.filter(round => round.id === order.id && Number(round.kot_number) > 0)
        .sort((left, right) => new Date(right.created_at) - new Date(left.created_at) || Number(right.kot_number) - Number(left.kot_number));
      const remainingByPrinter = new Map(), seen = new Set();
      for (const round of rounds) {
        for (const saved of Array.isArray(round.tickets) ? round.tickets : []) {
          const configured = printers.find(entry => saved.printerId ? entry.id === saved.printerId : entry.name === saved.printerLabel);
          const printer = { id: saved.printerId || configured?.id || '', name: saved.printerLabel || configured?.name || saved.printerName || 'Kitchen' };
          const station = printer.id || printer.name;
          const key = ticketKey(order.id, round.kot_number, station);
          if (seen.has(key)) continue;
          seen.add(key);
          if (!remainingByPrinter.has(station)) remainingByPrinter.set(station,
            (Array.isArray(order.items) ? order.items : []).map(item => ({ id: lineId(item), identity: lineIdentity(item), remaining: Math.max(0, Number(item.quantity) || 0) })));
          const pool = remainingByPrinter.get(station), items = [];
          for (const item of Array.isArray(saved.items) ? saved.items : []) {
            const id = lineId(item), identity = lineIdentity(item);
            let requested = Math.max(0, Number(item.quantity) || 0), quantity = 0;
            for (const current of pool) {
              if (!requested || !(id ? current.id === id : current.identity === identity)) continue;
              const used = Math.min(requested, current.remaining);
              quantity += used; requested -= used; current.remaining -= used;
            }
            if (quantity > 0) items.push({ ...item, quantity });
          }
          const status = state.statuses.find(entry => ticketKey(entry.order_id, entry.kot_number, entry.printer_id) === ticketKey(order.id, round.kot_number, printer.id))?.status || 'accepted';
          if (items.length && status !== 'served') all.push({ order, printer, items, round, saved, status });
        }
      }
      if (!rounds.length && order.items?.length) all.push({ order, printer: { id: '', name: 'Awaiting kitchen ticket' }, items: order.items, round: null, status: 'accepted' });
    });
  return all.sort((a, b) => new Date(a.round?.created_at || a.order.created_at) - new Date(b.round?.created_at || b.order.created_at) || Number(a.round?.kot_number || 0) - Number(b.round?.kot_number || 0));
}
function render() {
  const all = tickets(),
    stations = [...new Map(all.filter(ticket => ticket.printer.id).map((t) => [t.printer.id, t.printer])).values()];
  if (state.station !== 'all' && !stations.some(station => station.id === state.station)) state.station = 'all';
  const visible = state.station === 'all' ? all : all.filter((t) => t.printer.id === state.station);
  $('#kds-live-count').textContent = `${all.length} live KOT${all.length === 1 ? '' : 's'}`;
  $('#kds-stations').innerHTML =
    `<button class="${state.station === 'all' ? 'is-active' : ''}" data-station="all">All stations</button>${stations.map((s) => `<button class="${state.station === s.id ? 'is-active' : ''}" data-station="${esc(s.id)}">${esc(s.name)}</button>`).join('')}`;
  $('#kds-grid').innerHTML =
    visible
      .map((ticket) => {
        const kot = ticket.round,
          saved = ticket.saved,
          items = ticket.items,
          kotNo = kot?.kot_number || '',
          key = ticketKey(ticket.order.id, kotNo, ticket.printer.id),
          status = ticket.status,
          age = Math.max(
            0,
            Math.floor((Date.now() - new Date(kot?.created_at || ticket.order.created_at)) / 60000)
          ),
          table = ticket.order.mode === 'table',
          label = table
            ? `${ticket.order.table_area || ''} ${String(ticket.order.table_number || '').padStart(2, '0')}`.trim()
            : fulfillment(ticket.order),
          action =
            status === 'accepted'
              ? ['preparing', 'Start preparation']
              : status === 'preparing'
                ? ['ready', 'Mark food ready']
                : null;
        return `<article class="kds-ticket" data-state="${esc(status)}"><div class="ticket-top"><div><span>KOT no.</span><b>${kotNo ? `#${esc(kotNo)}` : 'Pending print'}</b></div><div class="table-badge ${table ? '' : 'is-parcel'}"><small>${table ? 'Table' : 'Type'}</small><b>${esc(label || '—')}</b></div><div><span>Order</span><b>#${esc(String(ticket.order.daily_order_number || '').padStart(2, '0'))}</b></div></div><div class="ticket-meta"><span>${esc(ticket.order.customer_name || 'Walk-in customer')}</span><b>◷ ${age < 60 ? `${age} min` : `${Math.floor(age / 60)}h ${age % 60}m`}</b></div><div class="ticket-station">${esc(ticket.printer.name)} · ${esc(fulfillment(ticket.order))}${saved?.waiterName ? ` · Waiter: ${esc(saved.waiterName)}` : ''}${ticket.order.service_priority === 'urgent' ? ' · URGENT' : ''}</div><div class="ticket-items">${items.map((i) => { const extras = Addons.modifierText(i.modifiers); return `<div><b>${Number(i.quantity || 0)}×</b><span>${esc(i.name)}${i.portion ? ` · ${esc(i.portion)}` : ''}${extras ? `<small>+ ${esc(extras)}</small>` : ''}${i.note ? `<small>Note: ${esc(i.note)}</small>` : ''}</span></div>`; }).join('')}</div>${ticket.order.special_request ? `<p class="ticket-note">Note: ${esc(ticket.order.special_request)}</p>` : ''}${action && kotNo && ticket.printer.id ? `<button class="ticket-action ${action[0] === 'ready' ? 'is-ready' : ''}" data-action="${action[0]}" data-current-status="${esc(status)}" data-order="${esc(ticket.order.id)}" data-printer="${esc(ticket.printer.id)}" data-kot="${esc(kotNo)}" ${pendingActions.has(key) ? 'disabled' : ''}>${action[1]}</button>` : `<button class="ticket-action is-ready" disabled>${!kotNo ? 'Waiting for KOT' : !ticket.printer.id ? 'Printer not assigned' : 'Food is ready'}</button>`}</article>`;
      })
      .join('') ||
    '<div class="kds-empty"><b>No live KOTs for this station</b>New accepted orders will appear here automatically.</div>';
}
async function kitchenJson(url, options = {}) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const data = await response.json().catch(error => { if (response.ok) throw error; return null; });
    if (!response.ok) {
      const error = new Error(data?.error || 'Unable to load kitchen display.');
      error.status = response.status;
      throw error;
    }
    return data;
  } finally { clearTimeout(timer); }
}
function load() {
  if (loadPromise) { reloadRequested = true; return loadPromise; }
  const promise = (async () => {
    do {
      reloadRequested = false;
      await refresh();
    } while (reloadRequested);
  })().finally(() => { if (loadPromise === promise) loadPromise = null; });
  loadPromise = promise;
  return promise;
}
async function refresh() {
  try {
    const [orders, ops, history, statuses] = await Promise.all(
      [
        '/api/orders?history=0',
        '/api/orders/operations',
        '/api/orders/kot-history',
        '/api/orders/kitchen-statuses',
      ].map(url => kitchenJson(url, { cache: 'no-store' }))
    );
    if (![orders, history, statuses].every(Array.isArray) || !ops || typeof ops !== 'object') throw new Error('Kitchen data was incomplete. Retrying the last saved display.');
    state.orders = orders;
    state.operations = ops.config || {};
    state.history = history;
    state.statuses = statuses;
    $('#kds-status').textContent = 'Live · updates every 3 seconds';
    $('#kds-status').classList.remove('is-error');
    render();
  } catch (error) {
    if ([401, 403].includes(error.status)) {
      state.orders = []; state.history = []; state.statuses = []; state.operations = null;
      render();
    }
    $('#kds-status').textContent = error.message || 'Kitchen display is offline.';
    $('#kds-status').classList.add('is-error');
  }
}
document.addEventListener('click', async (e) => {
  const button = e.target.closest('button');
  if (!button) return;
  if (button.dataset.station) {
    state.station = button.dataset.station;
    render();
    return;
  }
  if (button.id === 'kds-fullscreen') {
    const result = !document.fullscreenElement ? document.documentElement.requestFullscreen?.() : document.exitFullscreen?.();
    result?.catch(() => { $('#kds-status').textContent = 'Fullscreen is unavailable in this browser.'; });
    return;
  }
  if (!button.dataset.action) return;
  if (window.employeeCan && !window.employeeCan('updateKitchen')) return;
  const key = ticketKey(button.dataset.order, button.dataset.kot, button.dataset.printer);
  if (pendingActions.has(key) || button.disabled) return;
  pendingActions.add(key);
  button.disabled = true;
  try {
    const d = await kitchenJson(
        `/api/orders/${encodeURIComponent(button.dataset.order)}/kitchen-status/${encodeURIComponent(button.dataset.printer)}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            status: button.dataset.action,
            kotNumber: Number(button.dataset.kot),
            expectedStatus: button.dataset.currentStatus,
          }),
        }
      );
    if (d?.ok !== true) throw new Error('The kitchen update was not confirmed. Refresh before retrying.');
    await load();
  } catch (error) {
    alert(error.message);
  } finally {
    pendingActions.delete(key);
    render();
  }
});
function clock() {
  $('#kds-clock').textContent = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  }).format(new Date());
}
clock();
setInterval(clock, 1000);
load();
setInterval(() => { if (!loadPromise && !document.hidden) void load(); }, 3000);
