const root = document.getElementById('orders');
const availability = document.getElementById('availability');
const menuSearch = document.getElementById('menu-search');
const menuResults = document.getElementById('menu-results');
const orderSearch = document.getElementById('order-search');
const historyDate = document.getElementById('history-date');
let known = new Set();
let firstLoad = true;
let menuItems = [];
let unavailable = new Map();
let availabilityFilter = 'all';
let menuType = 'food';
let installPrompt = null;
let orderSearchTimer = null;
let orderView = 'current';
let activeOrderDay = '';
let orderRecords = new Map();
let historyAll = false;
let orderStatusFilter = 'all';
let operationsConfig = { printers: [], routes: [] };
let operationsMenu = [];
let operationsTab = 'kots';
const orderSearchPanel = document.querySelector('.order-search-panel');
const liveOrdersPanel = document.createElement('section');
liveOrdersPanel.id = 'live-orders-panel';
liveOrdersPanel.hidden = true;
if (orderSearchPanel && root) {
  orderSearchPanel.before(liveOrdersPanel);
  liveOrdersPanel.append(orderSearchPanel, root);
}
const orderStatusFilters = document.createElement('div');
orderStatusFilters.id = 'order-status-filters';
orderStatusFilters.setAttribute('aria-label', 'Filter live orders by status');
orderStatusFilters.innerHTML = [['all', 'All orders'], ['accepted', 'Accepted'], ['preparing', 'Preparing'], ['ready', 'Ready'], ['completed', 'Completed'], ['rejected', 'Rejected']].map(([value, label]) => `<button type="button" class="order-status-filter ${value === 'all' ? 'is-active' : ''} status-${value}" data-order-status-filter="${value}" aria-pressed="${value === 'all'}">${label}</button>`).join('');
orderSearchPanel?.after(orderStatusFilters);
const liveOrdersToggle = document.createElement('button');
liveOrdersToggle.type = 'button';
liveOrdersToggle.id = 'live-orders-toggle';
liveOrdersToggle.className = 'live-orders-toggle';
liveOrdersToggle.setAttribute('aria-expanded', 'false');
liveOrdersToggle.innerHTML = '<span class="live-dot" aria-hidden="true"></span><span>Live orders</span><b id="live-orders-count">0</b>';
document.querySelector('.header-actions')?.prepend(liveOrdersToggle);
const operationsPanel = document.createElement('section');
operationsPanel.id = 'operations-panel';
operationsPanel.hidden = true;
operationsPanel.innerHTML = '<div class="operations-head"><div><span class="eyebrow">Staff workspace</span><h2>Operations</h2><p>Review routed KOTs and configure kitchen, tandoori, bar, and bill printers.</p></div><button type="button" id="operations-close" class="quiet-button">Close</button></div><div id="operations-tabs" class="operation-launches"><button type="button" data-operations-tab="kots" class="operation-launch is-active"><span class="operation-icon kot-icon" aria-hidden="true">⌑</span><span><b>KOT queue</b><small>View and print live kitchen tickets</small></span><i aria-hidden="true">›</i></button><button type="button" data-operations-tab="printers" class="operation-launch"><span class="operation-icon printer-icon" aria-hidden="true">▣</span><span><b>Printer routing</b><small>Assign categories and items to printers</small></span><i aria-hidden="true">›</i></button></div><div id="operations-content"></div>';
availability.before(operationsPanel);
const operationsToggle = document.createElement('button');
operationsToggle.type = 'button';
operationsToggle.id = 'operations-toggle';
operationsToggle.className = 'operations-toggle';
operationsToggle.setAttribute('aria-expanded', 'false');
operationsToggle.innerHTML = '<span aria-hidden="true">⚙</span> Operations';
document.querySelector('.header-actions')?.insertBefore(operationsToggle, document.getElementById('availability-toggle'));
const liveOrdersStyles = document.createElement('style');
liveOrdersStyles.textContent = `.live-orders-toggle{display:inline-flex;align-items:center;gap:8px;color:#15335b;background:#fff;box-shadow:0 3px 11px rgba(7,20,45,.16)}.live-orders-toggle:hover,.live-orders-toggle.is-open{color:#fff;background:#168451}.live-dot{width:8px;height:8px;border-radius:50%;background:#e3342f;box-shadow:0 0 0 3px rgba(227,52,47,.14)}.live-orders-toggle.is-open .live-dot{background:#d9ffe9;box-shadow:0 0 0 3px rgba(217,255,233,.2)}.live-orders-toggle b{display:grid;min-width:19px;height:19px;place-items:center;padding:0 4px;border-radius:999px;color:#fff;background:#e3342f;font-size:10px}.live-orders-toggle.is-open b{color:#168451;background:#fff}#live-orders-panel{margin-top:20px}#live-orders-panel[hidden]{display:none}#live-orders-panel .order-search-panel{margin-top:0}#live-orders-panel main{padding-top:20px}#order-status-filters{display:flex;flex-wrap:wrap;gap:8px;margin:12px 28px 0}.order-status-filter{padding:8px 12px;border:1px solid transparent;border-radius:9px;font-size:11px}.order-status-filter.status-all{color:#fff;background:#263d68}.order-status-filter.status-accepted{color:#fff;background:#e3342f}.order-status-filter.status-preparing{color:#3d2a00;background:#f5a21a}.order-status-filter.status-ready{color:#fff;background:#168451}.order-status-filter.status-completed{color:#fff;background:#506078}.order-status-filter.status-rejected{color:#fff;background:#9b2634}.order-status-filter:not(.is-active){color:#68778e;background:#fff;border-color:#dce4ee;box-shadow:none}.order-status-filter:hover{transform:none;filter:none;border-color:currentColor}.order-status-filter.is-active{box-shadow:0 4px 11px rgba(31,48,80,.2)}@media(max-width:600px){.live-orders-toggle span:not(.live-dot){display:none}.live-orders-toggle{padding-inline:9px}#live-orders-panel{margin-top:14px}#order-status-filters{margin:10px 16px 0;gap:6px}.order-status-filter{padding:7px 9px;font-size:10px}}`;
document.head.appendChild(liveOrdersStyles);
const operationsStyles = document.createElement('style');
operationsStyles.textContent = `#operations-panel{margin:20px 28px 0;padding:24px;border:1px solid #dce4ee;border-radius:18px;background:#fff;box-shadow:0 14px 34px rgba(24,39,70,.09)}#operations-panel[hidden]{display:none}.operations-toggle{display:inline-flex;align-items:center;gap:7px;color:#fff;background:#53647e}.operations-toggle span{font-size:16px}.operations-toggle.is-open{background:#243b63}.operations-head{display:flex;justify-content:space-between;gap:16px}.operations-head h2{margin:4px 0;font-size:22px}.operations-head p{margin:0;color:#68778e}.operations-tabs{display:inline-flex;gap:4px;margin:20px 0 14px;padding:4px;border-radius:10px;background:#eef3f8}.operations-tabs button{padding:8px 12px;color:#627188;background:transparent;font-size:12px}.operations-tabs button.is-active{color:#fff;background:#263d68}.operations-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:12px}.operation-printer,.kot-ticket{padding:15px;border:1px solid #e1e8f0;border-radius:12px;background:#fff}.operation-printer-head,.kot-ticket-head{display:flex;justify-content:space-between;gap:10px;align-items:start}.operation-printer h3,.kot-ticket h3{margin:0;color:#23334e;font-size:15px}.printer-type{padding:4px 7px;border-radius:999px;color:#53647e;background:#eef3f8;font-size:10px;font-weight:900;text-transform:uppercase}.printer-type.kot{color:#087348;background:#e8f7ef}.operation-printer p{margin:8px 0 0;color:#6e7d91;font-size:12px}.operation-printer button{margin-top:12px;padding:7px 9px;color:#a52a39;background:#fff0f0;font-size:11px}.operations-form{display:grid;grid-template-columns:1.4fr .75fr auto;gap:9px;align-items:end;margin:13px 0}.operations-form label{display:grid;gap:4px;color:#5e6d83;font-size:10px;font-weight:900;letter-spacing:.04em;text-transform:uppercase}.operations-form input,.operations-form select{width:100%;padding:9px;border:1px solid #d4deea;border-radius:8px;color:#26344e;background:#fff;font:600 12px Manrope,sans-serif}.operations-form button{padding:10px 12px;background:#263d68;font-size:11px}.routing-list{display:grid;gap:8px;margin-top:13px}.route-row{display:flex;justify-content:space-between;gap:12px;align-items:center;padding:11px 12px;border:1px solid #e5ebf2;border-radius:9px;background:#f9fbfd;font-size:12px}.route-row b{color:#23334e}.route-row span{color:#718097}.route-row button{padding:6px 8px;color:#a52a39;background:#fff0f0;font-size:10px}.operations-save{margin-top:15px;background:#168451}.kot-ticket{border-left:4px solid #e3342f}.kot-ticket p{margin:6px 0;color:#718097;font-size:11px}.kot-items{margin:12px 0;padding:10px 0;border-block:1px solid #edf0f4}.kot-items div{padding:4px 0;color:#2f3e55;font-size:12px}.kot-items b{color:#c42b28}.kot-ticket button{padding:8px 10px;background:#263d68;font-size:11px}.operations-empty{padding:25px;color:#718097;border:1px dashed #d4deea;border-radius:12px;text-align:center}@media(max-width:600px){#operations-panel{margin:14px 16px 0;padding:16px}.operations-head p{font-size:12px}.operations-form{grid-template-columns:1fr}.operations-form button{width:100%}.operations-grid{grid-template-columns:1fr}}`;
document.head.appendChild(operationsStyles);
const operationsLauncherStyles = document.createElement('style');
operationsLauncherStyles.textContent = `.operation-launches{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin:22px 0 18px}.operation-launch{display:grid;grid-template-columns:44px minmax(0,1fr) auto;gap:12px;align-items:center;padding:15px;border:1px solid #dfe7f1;border-radius:13px;color:#273852;background:#fff;text-align:left;box-shadow:0 3px 10px rgba(31,52,88,.035)}.operation-launch:hover{transform:translateY(-1px);filter:none;border-color:#aebfd4;box-shadow:0 8px 18px rgba(31,52,88,.1)}.operation-launch.is-active{border-color:#263d68;background:linear-gradient(135deg,#263d68,#35578d);color:#fff}.operation-icon{display:grid;width:44px;height:44px;place-items:center;border-radius:12px;color:#263d68;background:#e9f0fa;font-size:26px;font-weight:900}.operation-launch.is-active .operation-icon{color:#263d68;background:#fff}.operation-launch b,.operation-launch small{display:block}.operation-launch b{font-size:14px}.operation-launch small{margin-top:3px;color:#74839a;font-size:11px;font-weight:600;line-height:1.35}.operation-launch.is-active small{color:#d9e5f7}.operation-launch i{font-size:25px;font-style:normal;font-weight:400}@media(max-width:600px){.operation-launches{grid-template-columns:1fr}.operation-launch{padding:13px}}`;
document.head.appendChild(operationsLauncherStyles);
const operationsRoutingStyles = document.createElement('style');
operationsRoutingStyles.textContent = `.operations-section{padding:20px;border:1px solid #e2e9f1;border-radius:15px;background:linear-gradient(145deg,#fff,#fbfcfe)}.operations-section+.operations-section{margin-top:16px}.operations-section-head{display:flex;align-items:start;justify-content:space-between;gap:16px}.operations-section-head h3{margin:3px 0 5px;color:#1f2e47;font-size:18px}.operations-section-head p{max-width:660px;margin:0;color:#6a7890;font-size:12px;line-height:1.5}.operations-count{padding:7px 9px;border-radius:999px;color:#36547d;background:#edf3fb;font-size:10px;font-weight:900;white-space:nowrap}.operations-printer-form,.operations-route-form{display:grid;gap:10px;align-items:end;margin:18px 0}.operations-printer-form{grid-template-columns:minmax(260px,1.5fr) minmax(170px,.65fr) auto}.operations-route-form{grid-template-columns:minmax(180px,1fr) minmax(180px,1fr) minmax(180px,1fr) auto}.operations-printer-form label,.operations-route-form label{display:grid;gap:5px;color:#55657b;font-size:10px;font-weight:900;letter-spacing:.05em;text-transform:uppercase}.operations-printer-form input,.operations-printer-form select,.operations-route-form select{width:100%;min-height:42px;padding:10px 11px;border:1px solid #d5dfeb;border-radius:9px;color:#23334e;background:#fff;font:700 12px Manrope,sans-serif}.operations-printer-form input:focus,.operations-printer-form select:focus,.operations-route-form select:focus{outline:0;border-color:#2e67b1;box-shadow:0 0 0 3px rgba(46,103,177,.12)}.operations-printer-form button,.operations-route-form button{min-height:42px;padding:10px 13px;background:#263d68;font-size:11px;white-space:nowrap}.operations-printer-form button span{font-size:16px}.printer-grid{grid-template-columns:repeat(auto-fill,minmax(255px,1fr))}.operation-printer{min-height:134px;border-color:#dfe7f0;box-shadow:0 4px 12px rgba(30,51,83,.05)}.operation-printer-head{display:grid;grid-template-columns:38px minmax(0,1fr) auto;gap:10px}.printer-card-icon{display:grid;width:38px;height:38px;place-items:center;border-radius:10px;color:#087348;background:#e8f7ef;font-size:22px;font-weight:900}.printer-card-icon.bill{color:#315487;background:#eaf1ff}.operation-printer p{line-height:1.4}.routing-section{background:linear-gradient(145deg,#fffdf8,#fff)}.route-row{display:grid;grid-template-columns:28px minmax(0,1fr) auto}.route-icon{display:grid;width:26px;height:26px;place-items:center;border-radius:7px;color:#087348;background:#e8f7ef;font-size:16px}.route-row span{display:block;margin-top:3px}.operations-save-bar{display:flex;align-items:center;justify-content:space-between;gap:14px;margin-top:16px;padding:13px 15px;border:1px solid #cce8d8;border-radius:12px;background:#f3fbf6;color:#527260;font-size:12px;font-weight:700}.operations-save{margin:0!important;padding:10px 14px;white-space:nowrap}@media(max-width:760px){.operations-printer-form,.operations-route-form{grid-template-columns:1fr}.operations-printer-form button,.operations-route-form button{width:100%}.operations-section{padding:16px}.operations-section-head{align-items:flex-start}.operations-save-bar{align-items:stretch;flex-direction:column}.operations-save{width:100%}}`;
document.head.appendChild(operationsRoutingStyles);

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#039;' })[char]);
const money = (value) => `₹${Number(value || 0).toFixed(0)}`;
const tomorrowLocal = () => { const date = new Date(Date.now() + 86400000); date.setSeconds(0, 0); return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
const toPushKey = (value) => { const padding = '='.repeat((4 - value.length % 4) % 4); const raw = atob((value + padding).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(raw, (character) => character.charCodeAt(0)); };

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/orders-sw.js?v=6');
document.getElementById('enable-notifications')?.addEventListener('click', async () => {
  const button = document.getElementById('enable-notifications');
  const notificationApi = window.Notification;
  try {
    if (!notificationApi || !('PushManager' in window) || !('serviceWorker' in navigator)) throw new Error('Push alerts need the installed Orders shortcut. Use Install shortcut first.');
    button.disabled = true;
    button.textContent = 'Enabling…';
    const permission = await notificationApi.requestPermission();
    if (permission !== 'granted') throw new Error('Alerts were not allowed. Enable notifications for RL Orders in this device’s settings.');
    const keyResponse = await fetch('/api/orders/push-key', { cache: 'no-store' });
    const keyBody = await keyResponse.json();
    if (!keyResponse.ok) throw new Error(keyBody.error || 'Push alerts are not configured yet.');
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription() || await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: toPushKey(keyBody.publicKey) });
    const saveResponse = await fetch('/api/orders/push-subscriptions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ subscription }) });
    const saveBody = await saveResponse.json();
    if (!saveResponse.ok) throw new Error(saveBody.error || 'Unable to enable push alerts.');
    button.textContent = 'Alerts enabled';
  } catch (error) {
    button.textContent = 'Enable alerts';
    const dialog = document.getElementById('shortcut-dialog');
    document.getElementById('shortcut-message').textContent = error.message;
    document.getElementById('shortcut-steps').innerHTML = '<li>Install the RL Orders shortcut on this device.</li><li>Open it once and tap Enable alerts.</li><li>Allow notifications when your device asks.</li>';
    if (typeof dialog?.showModal === 'function') dialog.showModal(); else alert(error.message);
  } finally { button.disabled = false; }
});

async function loadOrders() {
  try {
    let query = String(orderSearch?.value || '').replace(/\D/g, '').slice(0, 16);
    const date = historyAll ? '' : String(historyDate?.value || '');
    const response = await fetch(`/api/orders?search=${encodeURIComponent(query)}&history=${orderView === 'history' ? '1' : '0'}&date=${encodeURIComponent(date)}`, { cache: 'no-store' });
    if (!response.ok) throw new Error('Unable to refresh orders.');
    const rows = await response.json();
    if (!Array.isArray(rows)) throw new Error('Unable to read orders. Please refresh.');
    orderRecords = new Map(rows.map((order) => [order.id, order]));
    const orderDay = response.headers.get('X-Orders-Day') || '';
    const sessionOpen = response.headers.get('X-Orders-Session') !== 'closed';
    if (activeOrderDay && orderDay && activeOrderDay !== orderDay && orderSearch) { orderSearch.value = ''; query = ''; }
    activeOrderDay = orderDay || activeOrderDay;
    const ids = new Set(rows.map((order) => order.id));
    const notificationApi = window.Notification;
    if (orderView === 'current' && !firstLoad && notificationApi && notificationApi.permission === 'granted') rows.filter((order) => !known.has(order.id) && order.status === 'new').forEach((order) => new notificationApi('New Direct Order', { body: `${order.customer_name || 'Guest'} · ${order.customer_phone}`, icon: '/images/red-lantern-logo-600.webp' }));
    if (orderView === 'current') known = ids;
    const liveCount = document.getElementById('live-orders-count');
    if (liveCount && orderView === 'current') liveCount.textContent = String(rows.length);
    firstLoad = false;
    const visibleRows = orderStatusFilter === 'all' ? rows : rows.filter((order) => order.status === orderStatusFilter);
    const emptyMessage = query ? 'No orders match that number.' : orderView === 'current' && !sessionOpen ? 'The restaurant is closed. Today\'s orders are safely available in Order history.' : 'No direct orders yet.';
    const filteredEmpty = orderStatusFilter !== 'all' ? `No ${orderStatusFilter} orders in this view.` : emptyMessage;
    root.innerHTML = visibleRows.map(renderOrder).join('') || `<div class="empty-state">${filteredEmpty}</div>`;
    const clearButton = document.getElementById('clear-order-search');
    const searchStatus = document.getElementById('order-search-status');
    if (clearButton) clearButton.hidden = !query;
    if (searchStatus) searchStatus.textContent = query ? `${visibleRows.length} matching order${visibleRows.length === 1 ? '' : 's'}` : orderView === 'history' ? `History · ${date || 'choose a date'}` : sessionOpen ? `${visibleRows.length} ${orderStatusFilter === 'all' ? 'current' : orderStatusFilter} order${visibleRows.length === 1 ? '' : 's'}` : 'Session closed · orders archived';
  } catch (error) {
    root.innerHTML = `<div class="empty-state">${esc(error.message)}</div>`;
  }
}

function renderOrder(order) {
  const items = Array.isArray(order.items) ? order.items : [];
  const itemCount = items.reduce((count, item) => count + Number(item.quantity || 0), 0);
  const fallbackTotal = items.reduce((sum, item) => sum + Number(item.quantity || 0) * (Number(String(item.price || '').replace(/[^0-9.]/g, '')) + (item.style ? 10 : 0)), 0);
  const storedTotal = Number(order.total);
  const total = storedTotal > 0 ? storedTotal : fallbackTotal;
  const age = Math.max(0, Math.floor((Date.now() - new Date(order.created_at)) / 60000));
  const placedAt = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true }).format(new Date(order.created_at));
  const orderCount = Number(order.customer_order_count || 1);
  const history = order.customer_last_order_at ? `Last ordered: ${new Date(order.customer_last_order_at).toLocaleDateString('en-IN')}` : 'First order';
  const dailyNumber = Number(order.daily_order_number);
  const orderNumber = Number.isFinite(dailyNumber) && dailyNumber > 0 ? String(dailyNumber).padStart(2, '0') : '—';
  const controls = ['cancelled', 'completed', 'rejected'].includes(order.status) ? '' : ['accepted', 'preparing', 'ready', 'completed', 'rejected'].map((status) => `<button onclick="setStatus('${esc(order.id)}','${status}')">${status}</button>`).join('');
  const canModify = age < 10 && ['new', 'accepted', 'preparing'].includes(order.status);
  return `<article class="order" data-order-id="${esc(order.id)}"><div class="order-heading"><span class="daily-order-number">Order #${orderNumber}</span><span class="order-status">${esc(order.status)}</span></div><div class="order-reference">Ref ${esc(order.id)}</div><div class="order-time">${age} min ago</div><div class="placed-at"><span>Placed</span>${esc(placedAt)} <small>Goa time</small></div><div class="meta">${esc(order.customer_name || 'Guest')} · <b class="phone">${esc(order.customer_phone)}</b></div><div class="customer-trust"><b>${orderCount === 1 ? 'New customer' : `${orderCount} orders from this number`}</b><span>${history}</span></div>${order.special_request ? `<div class="request">Special request: ${esc(order.special_request)}</div>` : ''}${order.cancellation_reason ? `<div class="request">Cancelled: ${esc(order.cancellation_reason)}</div>` : ''}<div class="items">${items.map((item) => `<div><b>${Number(item.quantity || 0)}×</b> ${esc(item.name)} ${item.portion ? `(${esc(item.portion)})` : ''}${item.style ? ` — ${esc(item.style)} (+₹10)` : ''}</div>`).join('')}</div><div class="totals"><b>${itemCount} item${itemCount === 1 ? '' : 's'}</b><strong>Total ${money(total)}</strong></div><div class="actions">${controls}${canModify ? `<button class="modify-order" data-modify-order="${esc(order.id)}">Modify order</button>` : ''}<button class="print" onclick="printOrder('${esc(order.id)}')">Print</button></div></article>`;
}

async function setStatus(id, status) {
  await fetch(`/api/orders/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) });
  loadOrders();
}

function openModifyOrder(id) {
  const order = orderRecords.get(id);
  if (!order || !Array.isArray(order.items)) return;
  let dialog = document.getElementById('modify-order-dialog');
  if (!dialog) { dialog = document.createElement('dialog'); dialog.id = 'modify-order-dialog'; dialog.className = 'modify-order-dialog'; document.body.appendChild(dialog); }
  const rows = order.items.map((item, index) => `<label><span>${esc(item.name)}${item.portion ? ` · ${esc(item.portion)}` : ''}</span><input type="number" min="0" max="20" value="${Number(item.quantity || 0)}" data-modify-quantity="${index}"></label>`).join('');
  dialog.innerHTML = `<button class="modify-close" aria-label="Close">×</button><span class="eyebrow">Staff only · first 10 minutes</span><h2>Modify order #${esc(String(order.daily_order_number || '').padStart(2, '0'))}</h2><p>Update quantities or set an item to 0 to remove it. Prices stay controlled by Admin.</p><div class="modify-items">${rows}</div><button class="modify-save">Save changes</button>`;
  dialog.showModal();
  dialog.querySelector('.modify-close').addEventListener('click', () => dialog.close());
  dialog.querySelector('.modify-save').addEventListener('click', async () => { const button = dialog.querySelector('.modify-save'); button.disabled = true; try { const quantities = [...dialog.querySelectorAll('[data-modify-quantity]')].map((input) => Number(input.value || 0)); const response = await fetch(`/api/orders/${encodeURIComponent(id)}/items`, { method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ quantities }) }); const body = await response.json(); if (!response.ok) throw new Error(body.error || 'Unable to modify this order.'); dialog.close(); loadOrders(); } catch (error) { button.disabled = false; window.alert(error.message); } });
}

async function printOrder(id) {
  const popup = window.open('', 'red-lantern-receipt', 'popup=yes,width=420,height=720');
  if (!popup) { alert('Please allow pop-ups to print the receipt.'); return; }
  try {
    popup.document.write('<!doctype html><title>Preparing receipt…</title>');
    const response = await fetch(`/api/orders/${encodeURIComponent(id)}/print`, { cache: 'no-store' });
    const order = await response.json();
    if (!response.ok) throw new Error(order.error || 'Unable to prepare this receipt.');
    const items = Array.isArray(order.items) ? order.items : [];
    const itemPrice = (item) => Number(String(item.price || '').replace(/[^0-9.]/g, '')) + (item.style ? 10 : 0);
    const quantity = items.reduce((total, item) => total + Number(item.quantity || 0), 0);
    const calculatedTotal = items.reduce((total, item) => total + Number(item.quantity || 0) * itemPrice(item), 0);
    const grandTotal = Number(order.total) > 0 ? Number(order.total) : calculatedTotal;
    const dailyNumber = Number(order.daily_order_number);
    const token = Number.isFinite(dailyNumber) && dailyNumber > 0 ? String(dailyNumber).padStart(2, '0') : '—';
    const placedAt = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true }).format(new Date(order.created_at));
    const orderType = order.fulfillment_type || (order.mode === 'table' ? 'Pick Up' : 'Delivery');
    const itemRows = items.map((item) => {
      const label = `${item.name || 'Item'}${item.portion ? ` (${item.portion})` : ''}${item.style ? ` — ${item.style}` : ''}`;
      const qty = Number(item.quantity || 0);
      return `<tr><td class="item-name">${esc(label)}</td><td>${qty}</td><td>${money(itemPrice(item))}</td><td>${money(qty * itemPrice(item))}</td></tr>`;
    }).join('');
    popup.document.open();
    popup.document.write(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Red Lantern · Token ${esc(token)}</title><style>@page{size:80mm auto;margin:4mm}*{box-sizing:border-box}body{width:72mm;margin:0;color:#111;font:12px Arial,sans-serif}.center{text-align:center}.restaurant{font-size:18px;font-weight:800;letter-spacing:.2px}.sub{margin:3px 0;color:#333}.rule{border:0;border-top:1px dashed #222;margin:10px 0}.wallet{padding:7px 0;font-weight:700}.details{line-height:1.55}.details b{display:inline-block;min-width:68px}table{width:100%;border-collapse:collapse;margin-top:8px;font-size:11px}th{padding:5px 0;border-bottom:1px solid #222;text-align:right;font-size:10px}th:first-child{text-align:left}td{padding:5px 0;vertical-align:top;text-align:right;border-bottom:1px dotted #bbb}.item-name{text-align:left;padding-right:5px}.totals{display:flex;justify-content:space-between;font-size:13px;font-weight:700}.grand{display:flex;justify-content:space-between;margin-top:6px;font-size:16px;font-weight:800}.note{margin-top:8px;font-size:10px;line-height:1.4}.footer{margin-top:14px;font-size:10px;text-align:center;color:#333}@media print{body{width:72mm}}</style></head><body><div class="center"><div class="restaurant">RED LANTERN RESTAURANT</div><div class="sub">Restaurant Mobile Number: 9922853605</div><div class="sub">Direct Order Receipt</div></div><hr class="rule"><div class="wallet">Wallet Points: ${Number(order.loyalty_points || 0)}</div><div class="details"><div><b>Name:</b> ${esc(order.customer_name || 'Not provided')}</div><div><b>Mobile:</b> ${esc(order.customer_phone || '—')}</div><div><b>Type:</b> ${esc(orderType)}</div><div><b>Token No:</b> ${esc(token)}</div><div><b>Placed:</b> ${esc(placedAt)}</div></div>${order.special_request ? `<div class="note"><b>Special request:</b> ${esc(order.special_request)}</div>` : ''}<hr class="rule"><table><thead><tr><th>Item</th><th>Qty</th><th>Price</th><th>Amount</th></tr></thead><tbody>${itemRows}</tbody></table><hr class="rule"><div class="totals"><span>Total Qty: ${quantity}</span><span>Items: ${items.length}</span></div><div class="grand"><span>GRAND TOTAL</span><span>${money(grandTotal)}</span></div><hr class="rule"><div class="footer">Thank you for ordering with us!<br>Red Lantern Restaurant</div><script>window.onload=()=>setTimeout(()=>window.print(),150);window.onafterprint=()=>window.close();<\/script></body></html>`);
    popup.document.close();
  } catch (error) {
    popup.close();
    alert(error.message || 'Unable to prepare this receipt.');
  }
}

const operationId = () => `op_${Date.now().toString(36)}${Math.random().toString(36).slice(2,7)}`;
const routePrinter = (item) => {
  const printers = new Map(operationsConfig.printers.map((printer) => [printer.id, printer]));
  const routes = operationsConfig.routes.filter((route) => printers.get(route.printerId)?.type === 'kot');
  const route = routes.find((entry) => entry.category === item.category && entry.itemName === item.name) || routes.find((entry) => entry.category === item.category && !entry.itemName);
  return route ? printers.get(route.printerId) : null;
};
function renderOperations() {
  const content = document.getElementById('operations-content');
  if (!content) return;
  if (operationsTab === 'kots') {
    const activeOrders = [...orderRecords.values()].filter((order) => !['completed','rejected','cancelled'].includes(order.status));
    const tickets = new Map();
    activeOrders.forEach((order) => (Array.isArray(order.items) ? order.items : []).forEach((item) => {
      const printer = routePrinter(item);
      const key = `${order.id}::${printer?.id || 'unassigned'}`;
      if (!tickets.has(key)) tickets.set(key, { order, printer, items: [] });
      tickets.get(key).items.push(item);
    }));
    content.innerHTML = `<p class="help-text">KOTs are grouped by the printer rules below. Items without a matching rule stay clearly marked as <strong>Unassigned</strong>.</p><div class="operations-grid">${[...tickets.values()].map((ticket) => { const number=String(ticket.order.daily_order_number||'—').padStart(2,'0'); return `<article class="kot-ticket"><div class="kot-ticket-head"><div><h3>Order #${esc(number)}</h3><p>${esc(ticket.order.customer_name || 'Guest')} · ${esc(ticket.order.customer_phone)}</p></div><span class="printer-type kot">${esc(ticket.printer?.name || 'Unassigned')}</span></div><div class="kot-items">${ticket.items.map((item) => `<div><b>${Number(item.quantity||0)}×</b> ${esc(item.name)}${item.portion?` · ${esc(item.portion)}`:''}${item.style?` · ${esc(item.style)}`:''}</div>`).join('')}</div><button type="button" data-print-kot="${esc(ticket.order.id)}" data-printer-id="${esc(ticket.printer?.id || '')}">Print KOT</button></article>`; }).join('') || '<div class="operations-empty">No live KOTs right now. New and active orders will appear here.</div>'}</div>`;
  } else {
    const kotPrinters = operationsConfig.printers.filter((printer) => printer.type === 'kot');
    const categories = [...new Set(operationsMenu.map((item) => item.category).filter(Boolean))].sort();
    const printerOptions = kotPrinters.map((printer) => `<option value="${esc(printer.id)}">${esc(printer.name)}</option>`).join('');
    content.innerHTML = `<section class="operations-section"><div class="operations-section-head"><div><span class="eyebrow">Step 1</span><h3>Printers</h3><p>Create every printer used by your restaurant. You can add as many KOT and Bill printers as needed.</p></div><span class="operations-count">${operationsConfig.printers.length} configured</span></div><div class="operations-printer-form"><label>Printer name<input id="operation-printer-name" maxlength="60" placeholder="e.g. Tandoori Printer"></label><label>Printer type<select id="operation-printer-type"><option value="kot">KOT printer</option><option value="bill">Bill printer</option></select></label><button type="button" id="operation-add-printer"><span aria-hidden="true">＋</span> Add printer</button></div><div class="operations-grid printer-grid">${operationsConfig.printers.map((printer) => `<article class="operation-printer"><div class="operation-printer-head"><span class="printer-card-icon ${esc(printer.type)}" aria-hidden="true">${printer.type === 'bill' ? '▣' : '⌑'}</span><div><h3>${esc(printer.name)}</h3><p>${printer.type === 'bill' ? 'Counter / bill receipt printer' : 'Kitchen order ticket printer'}</p></div><span class="printer-type ${esc(printer.type)}">${esc(printer.type)}</span></div><button type="button" data-delete-printer="${esc(printer.id)}">Remove</button></article>`).join('') || '<div class="operations-empty">Add your first printer to start routing KOTs.</div>'}</div></section><section class="operations-section routing-section"><div class="operations-section-head"><div><span class="eyebrow">Step 2</span><h3>KOT routing</h3><p>Send an entire category—or one specific item—to the right kitchen printer.</p></div><span class="operations-count">${operationsConfig.routes.length} rules</span></div><div class="operations-route-form"><label>Send to printer<select id="operation-route-printer"><option value="">Choose KOT printer</option>${printerOptions}</select></label><label>Category<select id="operation-route-category"><option value="">Choose category</option>${categories.map((category) => `<option value="${esc(category)}">${esc(category)}</option>`).join('')}</select></label><label>Specific item <select id="operation-route-item"><option value="">Entire category</option></select></label><button type="button" id="operation-add-route">Add route</button></div><div class="routing-list">${operationsConfig.routes.map((route) => { const printer=operationsConfig.printers.find((item)=>item.id===route.printerId); return `<div class="route-row"><span class="route-icon" aria-hidden="true">⌑</span><div><b>${esc(route.category)}${route.itemName ? ` · ${esc(route.itemName)}` : ' · all items'}</b><span>Print on ${esc(printer?.name || 'Missing printer')}</span></div><button type="button" data-delete-route="${esc(route.id)}">Remove</button></div>`; }).join('') || '<div class="operations-empty">No KOT routes yet. Add a category or item rule above.</div>'}</div></section><div class="operations-save-bar"><span>Changes are saved only when you confirm.</span><button type="button" id="operations-save" class="operations-save">Save printer configuration</button></div>`;
  }
}
async function loadOperations() {
  const response = await fetch('/api/orders/operations', { cache:'no-store' });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Unable to load Operations.');
  operationsConfig = data.config || { printers:[], routes:[] };
  operationsMenu = Array.isArray(data.menu) ? data.menu : [];
  renderOperations();
}
async function saveOperations() {
  const response = await fetch('/api/orders/operations', { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ config:operationsConfig }) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Unable to save printer configuration.');
  operationsConfig = data.config;
  renderOperations();
}
function printKot(orderId, printerId) {
  const order = orderRecords.get(orderId);
  if (!order) return;
  const printer = operationsConfig.printers.find((item) => item.id === printerId);
  const items = (Array.isArray(order.items) ? order.items : []).filter((item) => (routePrinter(item)?.id || '') === (printerId || ''));
  if (!items.length) return;
  const popup = window.open('', 'red-lantern-kot', 'popup=yes,width=390,height=600');
  if (!popup) { alert('Please allow pop-ups to print this KOT.'); return; }
  const number=String(order.daily_order_number||'—').padStart(2,'0');
  popup.document.write(`<!doctype html><title>KOT #${esc(number)}</title><style>@page{size:80mm auto;margin:4mm}body{width:72mm;margin:0;font:12px Arial;color:#111}.center{text-align:center}.name{font-size:17px;font-weight:800}.rule{border:0;border-top:1px dashed #111;margin:9px 0}.item{padding:5px 0;font-size:13px}.item b{font-size:15px}small{color:#444}</style><div class="center"><div class="name">RED LANTERN RESTAURANT</div><b>KITCHEN ORDER TICKET</b><br><small>${esc(printer?.name || 'Unassigned')}</small></div><hr class="rule"><b>Token No: ${esc(number)}</b><br><small>${esc(order.customer_name || 'Guest')} · ${esc(order.fulfillment_type === 'pickup' ? 'Pick Up' : 'Delivery')}</small><hr class="rule">${items.map((item)=>`<div class="item"><b>${Number(item.quantity||0)}×</b> ${esc(item.name)}${item.portion?` (${esc(item.portion)})`:''}${item.style?` · ${esc(item.style)}`:''}</div>`).join('')}${order.special_request?`<hr class="rule"><b>Note:</b> ${esc(order.special_request)}`:''}<hr class="rule"><div class="center"><small>Order #${esc(number)}</small></div><script>window.onload=()=>setTimeout(()=>window.print(),120);window.onafterprint=()=>window.close();<\/script>`);
  popup.document.close();
}

async function loadAvailability() {
  const [menuResponse, availabilityResponse] = await Promise.all([fetch('/api/orders/menu', { cache: 'no-store' }), fetch('/api/orders/availability', { cache: 'no-store' })]);
  if (!menuResponse.ok || !availabilityResponse.ok) throw new Error('Menu availability could not be loaded.');
  menuItems = await menuResponse.json();
  unavailable = new Map((await availabilityResponse.json()).map((item) => [item.item_key, item.unavailable_until]));
  renderAvailability();
}

function renderAvailability() {
  const query = String(menuSearch.value || '').trim().toLowerCase();
  const typeItems = menuItems.filter((item) => item.menuType === menuType);
  const activeUnavailable = new Set([...unavailable].filter(([, until]) => new Date(until) > new Date()).map(([key]) => key));
  const unavailableForType = typeItems.filter((item) => activeUnavailable.has(item.key)).length;
  const inStockCount = typeItems.length - unavailableForType;
  document.getElementById('menu-type-tabs').innerHTML = [['food', 'Food Menu'], ['bar', 'Bar Menu']].map(([value, label]) => `<button class="menu-type-tab ${menuType === value ? 'is-active' : ''}" data-menu-type="${value}" aria-pressed="${menuType === value}">${label}<span>${menuItems.filter((item) => item.menuType === value).length}</span></button>`).join('');
  menuSearch.placeholder = `Search ${menuType === 'food' ? 'food' : 'bar'} menu`;
  document.getElementById('availability-counts').innerHTML = `<span class="stock-count in">${inStockCount} in stock</span><span class="stock-count out">${unavailableForType} unavailable</span>`;
  document.getElementById('availability-filters').innerHTML = [['all', 'All items'], ['in', 'In stock'], ['out', 'Unavailable']].map(([value, label]) => `<button class="filter-button ${availabilityFilter === value ? 'is-active' : ''}" data-availability-filter="${value}" aria-pressed="${availabilityFilter === value}">${label}</button>`).join('');
  const visible = typeItems.filter((item) => {
    const isOut = activeUnavailable.has(item.key);
    return `${item.name} ${item.category}`.toLowerCase().includes(query) && (availabilityFilter === 'all' || (availabilityFilter === 'out' ? isOut : !isOut));
  }).sort((a, b) => `${a.category} ${a.name}`.localeCompare(`${b.category} ${b.name}`));
  menuResults.innerHTML = visible.length ? visible.map((item) => {
    const until = activeUnavailable.has(item.key) ? unavailable.get(item.key) : null;
    const status = until ? `Out until ${new Date(until).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}` : 'In stock';
    return `<article class="menu-item ${until ? 'is-out' : ''}" data-key="${esc(item.key)}"><div class="menu-item-name"><b>${esc(item.name)}</b><span>${esc(item.category || 'Menu')}</span></div><div class="availability-state"><i aria-hidden="true"></i>${status}</div><div class="availability-controls">${until ? `<button class="stock-in" data-stock-action="restore">Mark in stock</button>` : `<button class="stock-tomorrow" data-stock-action="tomorrow">Out until tomorrow</button><label><span>Custom restock</span><input type="datetime-local" value="${tomorrowLocal()}" data-stock-until></label><button class="stock-date" data-stock-action="date">Mark unavailable</button>`}</div></article>`;
  }).join('') : '<div class="empty-state">No menu items match that search.</div>';
}

async function updateAvailability(key, unavailableUntil) {
  const url = `/api/orders/availability/${encodeURIComponent(key)}`;
  const response = await fetch(url, unavailableUntil ? { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ unavailableUntil }) } : { method: 'DELETE' });
  if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.error || 'Unable to update availability.'); }
  await loadAvailability();
}

document.getElementById('availability-toggle')?.addEventListener('click', async () => {
  const isOpening = availability.hidden;
  availability.hidden = !isOpening;
  document.getElementById('availability-toggle').setAttribute('aria-expanded', String(isOpening));
  if (isOpening) { try { await loadAvailability(); } catch (error) { menuResults.innerHTML = `<div class="empty-state">${esc(error.message)}</div>`; } }
});
liveOrdersToggle.addEventListener('click', () => {
  const isOpening = liveOrdersPanel.hidden;
  liveOrdersPanel.hidden = !isOpening;
  liveOrdersToggle.classList.toggle('is-open', isOpening);
  liveOrdersToggle.setAttribute('aria-expanded', String(isOpening));
  if (isOpening) {
    orderView = 'current';
    historyAll = false;
    document.querySelectorAll('[data-order-view]').forEach((tab) => tab.classList.toggle('is-active', tab.dataset.orderView === 'current'));
    const dateWrap = document.getElementById('history-date-wrap');
    if (dateWrap) dateWrap.hidden = true;
    loadOrders();
    liveOrdersPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
});
document.getElementById('availability-close')?.addEventListener('click', () => { availability.hidden = true; document.getElementById('availability-toggle').setAttribute('aria-expanded', 'false'); });
operationsToggle.addEventListener('click', async () => {
  const opening = operationsPanel.hidden;
  operationsPanel.hidden = !opening;
  operationsToggle.classList.toggle('is-open', opening);
  operationsToggle.setAttribute('aria-expanded', String(opening));
  if (!opening) return;
  document.getElementById('operations-content').innerHTML = '<div class="operations-empty">Loading Operations…</div>';
  try { await loadOrders(); await loadOperations(); operationsPanel.scrollIntoView({ behavior:'smooth', block:'start' }); } catch (error) { document.getElementById('operations-content').innerHTML = `<div class="operations-empty">${esc(error.message)}</div>`; }
});
document.getElementById('operations-close')?.addEventListener('click', () => { operationsPanel.hidden = true; operationsToggle.classList.remove('is-open'); operationsToggle.setAttribute('aria-expanded','false'); });
document.getElementById('operations-tabs')?.addEventListener('click', (event) => {
  const button = event.target.closest('[data-operations-tab]');
  if (!button) return;
  operationsTab = button.dataset.operationsTab;
  document.querySelectorAll('[data-operations-tab]').forEach((tab) => tab.classList.toggle('is-active', tab === button));
  renderOperations();
});
document.getElementById('operations-content')?.addEventListener('change', (event) => {
  if (event.target.id !== 'operation-route-category') return;
  const itemSelect = document.getElementById('operation-route-item');
  const category = event.target.value;
  itemSelect.innerHTML = `<option value="">Entire category</option>${operationsMenu.filter((item) => item.category === category).sort((a,b)=>a.name.localeCompare(b.name)).map((item) => `<option value="${esc(item.name)}">${esc(item.name)}</option>`).join('')}`;
});
document.getElementById('operations-content')?.addEventListener('click', async (event) => {
  const addPrinter = event.target.closest('#operation-add-printer');
  if (addPrinter) { const name=String(document.getElementById('operation-printer-name')?.value||'').trim(); const type=document.getElementById('operation-printer-type')?.value==='bill'?'bill':'kot'; if (!name) { document.getElementById('operation-printer-name')?.focus(); return; } operationsConfig.printers.push({ id:operationId(), name, type }); renderOperations(); return; }
  const removePrinter = event.target.closest('[data-delete-printer]');
  if (removePrinter) { const id=removePrinter.dataset.deletePrinter; operationsConfig.printers=operationsConfig.printers.filter((printer)=>printer.id!==id); operationsConfig.routes=operationsConfig.routes.filter((route)=>route.printerId!==id); renderOperations(); return; }
  const addRoute = event.target.closest('#operation-add-route');
  if (addRoute) { const printerId=document.getElementById('operation-route-printer')?.value||''; const category=document.getElementById('operation-route-category')?.value||''; const itemName=document.getElementById('operation-route-item')?.value||''; if (!printerId || !category) { alert('Choose a KOT printer and a category first.'); return; } const duplicate=operationsConfig.routes.some((route)=>route.printerId===printerId&&route.category===category&&route.itemName===itemName); if (!duplicate) operationsConfig.routes.push({ id:operationId(), printerId, category, itemName }); renderOperations(); return; }
  const removeRoute = event.target.closest('[data-delete-route]');
  if (removeRoute) { operationsConfig.routes=operationsConfig.routes.filter((route)=>route.id!==removeRoute.dataset.deleteRoute); renderOperations(); return; }
  if (event.target.closest('#operations-save')) { const button=event.target.closest('#operations-save'); button.disabled=true; button.textContent='Saving…'; try { await saveOperations(); } catch(error) { alert(error.message); button.disabled=false; button.textContent='Save printer configuration'; } return; }
  const kot = event.target.closest('[data-print-kot]');
  if (kot) printKot(kot.dataset.printKot, kot.dataset.printerId);
});
orderStatusFilters.addEventListener('click', (event) => {
  const button = event.target.closest('[data-order-status-filter]');
  if (!button) return;
  orderStatusFilter = button.dataset.orderStatusFilter;
  orderStatusFilters.querySelectorAll('[data-order-status-filter]').forEach((filter) => {
    const selected = filter === button;
    filter.classList.toggle('is-active', selected);
    filter.setAttribute('aria-pressed', String(selected));
  });
  loadOrders();
});
menuSearch?.addEventListener('input', renderAvailability);
document.getElementById('availability-filters')?.addEventListener('click', (event) => {
  const button = event.target.closest('[data-availability-filter]');
  if (!button) return;
  availabilityFilter = button.dataset.availabilityFilter;
  renderAvailability();
});
document.getElementById('menu-type-tabs')?.addEventListener('click', (event) => {
  const button = event.target.closest('[data-menu-type]');
  if (!button) return;
  menuType = button.dataset.menuType;
  availabilityFilter = 'all';
  menuSearch.value = '';
  renderAvailability();
});
window.addEventListener('beforeinstallprompt', (event) => { event.preventDefault(); installPrompt = event; });
document.getElementById('install-shortcut')?.addEventListener('click', async () => {
  const dialog = document.getElementById('shortcut-dialog');
  const message = document.getElementById('shortcut-message');
  const steps = document.getElementById('shortcut-steps');
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  if (installPrompt) {
    installPrompt.prompt();
    await installPrompt.userChoice;
    installPrompt = null;
    return;
  }
  if (isIOS) {
    message.textContent = 'Add a secure Direct Orders icon to this iPhone.';
    steps.innerHTML = '<li>Tap the Share button in Safari.</li><li>Choose <strong>Add to Home Screen</strong>.</li><li>Name it “RL Orders”, then tap Add.</li>';
  } else {
    message.textContent = 'Create a desktop shortcut for Direct Orders.';
    steps.innerHTML = '<li>Open the browser menu (⋮).</li><li>Choose <strong>Install app</strong> or <strong>Create shortcut</strong>.</li><li>Pin “RL Orders” to the taskbar or desktop.</li>';
  }
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else alert(`${message.textContent}\n\n${steps.textContent}`);
});
document.getElementById('shortcut-close')?.addEventListener('click', () => document.getElementById('shortcut-dialog')?.close());
orderSearch?.addEventListener('input', () => { clearTimeout(orderSearchTimer); orderSearchTimer = setTimeout(loadOrders, 180); });
document.getElementById('clear-order-search')?.addEventListener('click', () => { if (orderSearch) { orderSearch.value = ''; orderSearch.focus(); } loadOrders(); });
historyDate?.addEventListener('change', () => { historyAll = false; loadOrders(); });
document.getElementById('all-history')?.addEventListener('click', () => { historyAll = true; if (historyDate) historyDate.value = ''; loadOrders(); });
document.getElementById('order-view-tabs')?.addEventListener('click', (event) => {
  const button = event.target.closest('[data-order-view]');
  if (!button) return;
  orderView = button.dataset.orderView;
  document.querySelectorAll('[data-order-view]').forEach((tab) => tab.classList.toggle('is-active', tab === button));
  const dateWrap = document.getElementById('history-date-wrap');
  if (dateWrap) dateWrap.hidden = orderView !== 'history';
  if (orderView === 'history' && historyDate && !historyDate.value && !historyAll) { historyDate.value = new Date().toISOString().slice(0, 10); }
  loadOrders();
});
root.addEventListener('click', (event) => { const button = event.target.closest('[data-modify-order]'); if (button) openModifyOrder(button.dataset.modifyOrder); });
menuResults?.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-stock-action]');
  if (!button) return;
  const row = button.closest('[data-key]');
  const key = row?.dataset.key;
  if (!key) return;
  button.disabled = true;
  try {
    const action = button.dataset.stockAction;
    const dateInput = row.querySelector('[data-stock-until]');
    await updateAvailability(key, action === 'restore' ? null : action === 'tomorrow' ? new Date(Date.now() + 86400000).toISOString() : new Date(dateInput.value).toISOString());
  } catch (error) { alert(error.message); button.disabled = false; }
});

loadOrders();
setInterval(loadOrders, 3000);
