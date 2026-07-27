const root = document.getElementById('orders');
const availability = document.getElementById('availability');
const menuSearch = document.getElementById('menu-search');
const menuResults = document.getElementById('menu-results');
let known = new Set();
let firstLoad = true;
let menuItems = [];
let unavailable = new Map();
let availabilityFilter = 'all';

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#039;' })[char]);
const money = (value) => `₹${Number(value || 0).toFixed(0)}`;
const tomorrowLocal = () => { const date = new Date(Date.now() + 86400000); date.setSeconds(0, 0); return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/orders-sw.js');
document.getElementById('enable-notifications')?.addEventListener('click', async () => {
  if ('Notification' in window) await Notification.requestPermission();
});

async function loadOrders() {
  try {
    const response = await fetch('/api/orders', { cache: 'no-store' });
    if (!response.ok) throw new Error('Unable to refresh orders.');
    const rows = await response.json();
    const ids = new Set(rows.map((order) => order.id));
    if (!firstLoad && 'Notification' in window && Notification.permission === 'granted') rows.filter((order) => !known.has(order.id) && order.status === 'new').forEach((order) => new Notification('New Direct Order', { body: `${order.customer_name || 'Guest'} · ${order.customer_phone}`, icon: '/images/red-lantern-logo-600.webp' }));
    known = ids;
    firstLoad = false;
    root.innerHTML = rows.map(renderOrder).join('') || '<div class="empty-state">No direct orders yet.</div>';
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
  const orderCount = Number(order.customer_order_count || 1);
  const history = order.customer_last_order_at ? `Last ordered: ${new Date(order.customer_last_order_at).toLocaleDateString('en-IN')}` : 'First order';
  const controls = ['accepted', 'preparing', 'ready', 'completed', 'rejected'].map((status) => `<button onclick="setStatus('${esc(order.id)}','${status}')">${status}</button>`).join('');
  return `<article class="order"><h2>${esc(order.id)} · ${esc(order.status)}</h2><div class="order-time">${age} min ago</div><div class="meta">${esc(order.customer_name || 'Guest')} · <b class="phone">${esc(order.customer_phone)}</b></div><div class="customer-trust"><b>${orderCount === 1 ? 'New customer' : `${orderCount} orders from this number`}</b><span>${history}</span></div>${order.special_request ? `<div class="request">Special request: ${esc(order.special_request)}</div>` : ''}<div class="items">${items.map((item) => `<div><b>${Number(item.quantity || 0)}×</b> ${esc(item.name)} ${item.portion ? `(${esc(item.portion)})` : ''}${item.style ? ` — ${esc(item.style)} (+₹10)` : ''}</div>`).join('')}</div><div class="totals"><b>${itemCount} item${itemCount === 1 ? '' : 's'}</b><strong>Total ${money(total)}</strong></div><div class="actions">${controls}<button class="print" onclick="printOrder('${esc(order.id)}')">Print</button></div></article>`;
}

async function setStatus(id, status) {
  await fetch(`/api/orders/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) });
  loadOrders();
}

function printOrder(id) {
  document.querySelectorAll('.order').forEach((order) => { order.style.display = order.querySelector('h2').textContent.includes(id) ? 'block' : 'none'; });
  window.print();
  document.querySelectorAll('.order').forEach((order) => { order.style.display = ''; });
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
  const activeUnavailable = new Set([...unavailable].filter(([, until]) => new Date(until) > new Date()).map(([key]) => key));
  const inStockCount = menuItems.length - activeUnavailable.size;
  document.getElementById('availability-counts').innerHTML = `<span class="stock-count in">${inStockCount} in stock</span><span class="stock-count out">${activeUnavailable.size} unavailable</span>`;
  document.getElementById('availability-filters').innerHTML = [['all', 'All items'], ['in', 'In stock'], ['out', 'Unavailable']].map(([value, label]) => `<button class="filter-button ${availabilityFilter === value ? 'is-active' : ''}" data-availability-filter="${value}" aria-pressed="${availabilityFilter === value}">${label}</button>`).join('');
  const visible = menuItems.filter((item) => {
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
