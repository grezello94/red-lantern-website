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
    firstLoad = false;
    const emptyMessage = query ? 'No orders match that number.' : orderView === 'current' && !sessionOpen ? 'The restaurant is closed. Today\'s orders are safely available in Order history.' : 'No direct orders yet.';
    root.innerHTML = rows.map(renderOrder).join('') || `<div class="empty-state">${emptyMessage}</div>`;
    const clearButton = document.getElementById('clear-order-search');
    const searchStatus = document.getElementById('order-search-status');
    if (clearButton) clearButton.hidden = !query;
    if (searchStatus) searchStatus.textContent = query ? `${rows.length} matching order${rows.length === 1 ? '' : 's'}` : orderView === 'history' ? `History · ${date || 'choose a date'}` : sessionOpen ? 'Current session' : 'Session closed · orders archived';
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
document.getElementById('availability-close')?.addEventListener('click', () => { availability.hidden = true; document.getElementById('availability-toggle').setAttribute('aria-expanded', 'false'); });
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
