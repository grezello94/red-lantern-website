const root = document.getElementById('orders');
const availability = document.getElementById('availability');
const menuSearch = document.getElementById('menu-search');
const menuResults = document.getElementById('menu-results');
const orderSearch = document.getElementById('order-search');
const historyDate = document.getElementById('history-date');
let known = new Set();
let firstLoad = true;
let ordersRefreshInFlight = false;
let renderedOrdersSignature = '';
let hasRenderedOrders = false;
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
let fulfillmentFilter = '';
let operationsConfig = { printers: [], routes: [] };
let operationsMenu = [];
let operationKotHistory = new Map();
let operationsTab = 'home';
let installedSystemPrinters = [];
let printBridgeState = 'checking';
let printBridgeConfigState = 'not-synced';
let assignmentPrinterId = '';
let assignmentMode = '';
let counterMenu = [];
let counterCart = [];
let counterCategory = 'all';
let counterChoiceItem = null;
let counterLoyaltyPoints = 0;
let counterLoyaltyTimer = null;
const offlineCounterOrdersKey = 'red-lantern-counter-orders';
let counterSyncInProgress = false;
const ordersDiagnosticRecent = new Map();
const orderSearchPanel = document.querySelector('.order-search-panel');
const ordersConsoleStartedAt = Date.now();
const connectivity = document.createElement('p');
connectivity.id = 'orders-connectivity';
document.querySelector('header')?.after(connectivity);
function counterRequestId() { return `counter-${Date.now()}-${crypto.getRandomValues(new Uint32Array(1))[0].toString(36)}`; }
function queuedCounterOrders() { try { return JSON.parse(localStorage.getItem(offlineCounterOrdersKey) || '[]'); } catch { return []; } }
function saveQueuedCounterOrders(orders) { localStorage.setItem(offlineCounterOrdersKey, JSON.stringify(orders)); }
function reportOrdersDiagnostic(payload = {}) {
  const source = payload.source || 'orders.js';
  const message = String(payload.message || 'Orders console issue.').slice(0, 400);
  const fingerprint = `${source}:${message}`;
  const previous = ordersDiagnosticRecent.get(fingerprint) || 0;
  if (Date.now() - previous < 5 * 60 * 1000) return;
  ordersDiagnosticRecent.set(fingerprint, Date.now());
  const body = JSON.stringify({ category:'orders', level:payload.level || 'error', path:'/orders', source, message, stack:String(payload.stack || '').slice(0, 1000) });
  fetch('/api/client-log', { method:'POST', headers:{ 'Content-Type':'application/json' }, body, keepalive:true }).catch(() => {});
}
window.addEventListener('error', (event) => reportOrdersDiagnostic({ message:event.message || 'Orders browser script error.', source:event.filename || 'orders browser', stack:event.error?.stack || '' }));
window.addEventListener('unhandledrejection', (event) => reportOrdersDiagnostic({ message:event.reason?.message || 'Orders browser request failed.', source:'orders browser promise', stack:event.reason?.stack || String(event.reason || '') }));
function updateConnectivity(message) {
  const pending = queuedCounterOrders().length, online = navigator.onLine;
  connectivity.hidden = online && !pending && !message;
  connectivity.className = online ? 'is-online' : 'is-offline';
  connectivity.textContent = message || (!online ? `Offline mode — orders are saved on this device and will sync when internet returns.${pending ? ` ${pending} waiting.` : ''}` : pending ? `${pending} order${pending === 1 ? '' : 's'} waiting to sync.` : '');
}
async function sendCounterOrder(payload) {
  const response = await fetch('/api/orders/counter', { method:'POST', headers:{ 'Content-Type':'application/json', 'X-Counter-Order-Id':payload.clientRequestId }, body:JSON.stringify(payload) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) { const error = new Error(result.error || 'Unable to save the order.'); error.status = response.status; throw error; }
  return result;
}
async function flushQueuedCounterOrders() {
  if (counterSyncInProgress || !navigator.onLine) return;
  counterSyncInProgress = true;
  try {
    let queued = queuedCounterOrders();
    while (queued.length && navigator.onLine) {
      try {
        const result = await sendCounterOrder(queued[0]);
        autoPrintOrder({ id:result.id, mode:'counter', status:result.status || 'accepted' });
        queued.shift(); saveQueuedCounterOrders(queued);
      }
      catch (error) {
        if (error.status >= 400 && error.status < 500 && error.status !== 409) { queued.shift(); saveQueuedCounterOrders(queued); continue; }
        if (error.status === 409 && !queued[0].errorReported) { queued[0].errorReported = true; saveQueuedCounterOrders(queued); reportOrdersDiagnostic({ level:'warning', message:'Queued counter order needs review: an item is no longer available.', source:'offline order sync' }); }
        break;
      }
    }
    if (!queued.length) { updateConnectivity('Queued orders synced successfully.'); setTimeout(() => updateConnectivity(), 4000); loadOrders(); }
    else updateConnectivity();
  } finally { counterSyncInProgress = false; }
}
async function refreshAfterReconnect() {
  // Deliberately refresh data in place: never reload the page or disturb a counter order being typed.
  await Promise.allSettled([
    loadOrders(),
    counterPanel?.hidden ? Promise.resolve() : loadAvailability().then(() => { counterMenu = menuItems.filter((item) => !unavailable.has(item.key)); renderCounterOrder(); }),
    counterPanel?.hidden ? Promise.resolve() : refreshCounterLiveStatus()
  ]);
}
window.addEventListener('online', () => { updateConnectivity('Internet restored — syncing queued orders…'); refreshAfterReconnect(); flushQueuedCounterOrders(); });
window.addEventListener('offline', () => { updateConnectivity(); reportOrdersDiagnostic({ level:'warning', message:'Orders console lost internet connection. Counter orders will be queued locally until reconnection.', source:'connection monitor' }); });
updateConnectivity();
if (navigator.onLine) setTimeout(flushQueuedCounterOrders, 300);
document.querySelectorAll('[data-fulfillment-filter]').forEach((button) => {
  button.addEventListener('click', () => {
    const nextFilter = button.dataset.fulfillmentFilter || '';
    if (nextFilter === 'pickup') { openCounterOrder(); return; }
    fulfillmentFilter = fulfillmentFilter === nextFilter ? '' : nextFilter;
    document.querySelectorAll('[data-fulfillment-filter]').forEach((item) => {
      const isActive = item.dataset.fulfillmentFilter === fulfillmentFilter;
      item.classList.toggle('is-active', isActive);
      item.setAttribute('aria-pressed', String(isActive));
    });
    loadOrders();
  });
});
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
const actionIcon = (name) => {
  const paths = {
    receipt: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3Z"/><path d="M9 8h6M9 12h6"/>',
    install: '<path d="M14 3h7v7"/><path d="M21 3 10 14"/><path d="M12 5H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7"/>',
    operations: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.12 2.12-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.04 1.56V20.3h-3v-.08A1.7 1.7 0 0 0 10.66 18.66a1.7 1.7 0 0 0-1.88.34l-.06.06L6.6 16.94l.06-.06A1.7 1.7 0 0 0 7 15a1.7 1.7 0 0 0-1.56-1.04H5.3v-3h.14A1.7 1.7 0 0 0 7 9.92a1.7 1.7 0 0 0-.34-1.88L6.6 7.98 8.72 5.86l.06.06a1.7 1.7 0 0 0 1.88.34 1.7 1.7 0 0 0 1.04-1.56V4.62h3v.08a1.7 1.7 0 0 0 1.04 1.56 1.7 1.7 0 0 0 1.88-.34l.06-.06 2.12 2.12-.06.06A1.7 1.7 0 0 0 19.4 9.92a1.7 1.7 0 0 0 1.56 1.04h.14v3h-.14A1.7 1.7 0 0 0 19.4 15Z"/>',
    cutlery: '<path d="M4 3v8M7 3v8M4 7h3M5.5 11v10M14 3v8M14 3c3 1 4.5 3.8 4.5 8H14M14 11v10"/>',
    bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/>',
    refresh: '<path d="M20 11a8 8 0 0 0-14.9-4M4 4v4h4M4 13a8 8 0 0 0 14.9 4M20 20v-4h-4"/>'
  };
  return `<svg class="header-action-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || ''}</svg>`;
};
const liveOrdersToggle = document.createElement('button');
liveOrdersToggle.type = 'button';
liveOrdersToggle.id = 'live-orders-toggle';
liveOrdersToggle.className = 'live-orders-toggle';
liveOrdersToggle.setAttribute('aria-expanded', 'false');
liveOrdersToggle.innerHTML = `${actionIcon('receipt')}<span>Live orders</span><b id="live-orders-count">0</b>`;
document.querySelector('.header-actions')?.prepend(liveOrdersToggle);
const operationsPanel = document.createElement('section');
operationsPanel.id = 'operations-panel';
operationsPanel.hidden = true;
operationsPanel.innerHTML = '<div class="operations-head"><div><span class="eyebrow">Staff workspace</span><h2>Operations</h2><p>Review routed KOTs and configure kitchen, tandoori, bar, and bill printers.</p></div><button type="button" id="operations-close" class="quiet-button">Close</button></div><div id="operations-tabs" class="operation-launches"><button type="button" data-operations-tab="kots" class="operation-launch is-active"><span class="operation-icon kot-icon" aria-hidden="true">⌑</span><span><b>KOT queue</b><small>View and print live kitchen tickets</small></span><i aria-hidden="true">›</i></button><button type="button" data-operations-tab="printers" class="operation-launch"><span class="operation-icon printer-icon" aria-hidden="true">▣</span><span><b>Printer routing</b><small>Assign categories and items to printers</small></span><i aria-hidden="true">›</i></button></div><div id="operations-content"></div>';
document.getElementById('operations-tabs')?.remove();
availability.before(operationsPanel);
const counterPanel = document.createElement('section');
counterPanel.id = 'counter-order-panel';
counterPanel.hidden = true;
counterPanel.innerHTML = '<div class="counter-order-head"><div><span class="eyebrow">Counter order</span><h2>Takeaway</h2><p>Build a walk-in or phone order, then send it directly to the kitchen.</p></div><button type="button" id="counter-order-close" class="quiet-button">Close</button></div><div class="counter-order-layout"><div class="counter-menu"><label class="counter-search"><span aria-hidden="true">⌕</span><input id="counter-menu-search" type="search" placeholder="Search menu items"></label><div id="counter-categories" class="counter-categories"></div><div id="counter-menu-items" class="counter-menu-items"></div></div><aside class="counter-cart"><div class="counter-cart-head"><h3>Current order</h3><button type="button" id="counter-clear" class="counter-clear">Clear</button></div><div id="counter-cart-items" class="counter-cart-items"></div><div class="counter-customer"><label>Customer name <input id="counter-customer-name" maxlength="80" placeholder="Walk-in customer"></label><label>Mobile number <input id="counter-customer-phone" inputmode="tel" maxlength="16" placeholder="Optional for walk-ins"></label><label>Kitchen note <textarea id="counter-special-request" maxlength="240" placeholder="e.g. less spicy"></textarea></label></div><div class="counter-total"><span>Total</span><b id="counter-total">₹0</b></div><button type="button" id="counter-place-order" class="counter-place-order">Place takeaway order</button><p id="counter-order-status" class="counter-order-status" aria-live="polite"></p></aside></div><dialog id="counter-choice-dialog" class="counter-choice-dialog"><button type="button" class="dialog-close" data-counter-choice-close aria-label="Close">×</button><div id="counter-choice-content"></div></dialog>';
availability.before(counterPanel);
const counterWallet = document.createElement('div');
counterWallet.id = 'counter-wallet';
counterWallet.hidden = true;
counterWallet.innerHTML = '<span class="counter-wallet-label">Customer wallet</span><b id="counter-wallet-balance">Enter a mobile number to check points.</b><label id="counter-wallet-redeem-wrap" hidden>Use wallet points <input id="counter-wallet-redeem" type="number" min="100" step="1" inputmode="numeric" value="0"></label><small id="counter-wallet-note"></small>';
counterPanel.querySelector('.counter-customer label:nth-of-type(3)')?.before(counterWallet);
const counterLiveStatus = document.createElement('div');
counterLiveStatus.id = 'counter-live-status';
counterLiveStatus.setAttribute('aria-live', 'polite');
counterLiveStatus.innerHTML = '<span>Live counter status</span><b>Loading…</b>';
counterPanel.querySelector('.counter-cart')?.prepend(counterLiveStatus);
let counterLiveStatusLoading = false;
async function refreshCounterLiveStatus() {
  if (counterLiveStatusLoading || counterPanel.hidden) return;
  counterLiveStatusLoading = true;
  try {
    const response = await fetch('/api/orders/live-summary', { cache:'no-store' });
    if (!response.ok) throw new Error('Unavailable');
    const live = await response.json();
    const token = Number(live.latestActiveOrderNumber || live.latestOrderNumber || 0);
    counterLiveStatus.classList.remove('is-offline');
    counterLiveStatus.innerHTML = `<span>Live counter status</span><b>${token ? `Order #${String(token).padStart(2,'0')}` : 'No orders yet'}</b><small>${Number(live.activeOrderCount || 0)} active order${Number(live.activeOrderCount || 0) === 1 ? '' : 's'}</small>`;
  } catch {
    counterLiveStatus.classList.add('is-offline');
    counterLiveStatus.innerHTML = '<span>Live counter status</span><b>Offline</b><small>Updates resume automatically</small>';
  } finally { counterLiveStatusLoading = false; }
}
const operationsToggle = document.createElement('button');
operationsToggle.type = 'button';
operationsToggle.id = 'operations-toggle';
operationsToggle.className = 'operations-toggle';
operationsToggle.setAttribute('aria-expanded', 'false');
operationsToggle.innerHTML = `${actionIcon('operations')}<span>Operations</span>`;
document.querySelector('.header-actions')?.insertBefore(operationsToggle, document.getElementById('availability-toggle'));
const installButton = document.getElementById('install-shortcut');
const availabilityButton = document.getElementById('availability-toggle');
const alertsButton = document.getElementById('enable-notifications');
const refreshButton = document.querySelector('.header-actions button[onclick]');
const closeOpenPanels = (except = null) => {
  if (except !== 'live') {
    liveOrdersPanel.hidden = true;
    liveOrdersToggle.classList.remove('is-open');
    liveOrdersToggle.setAttribute('aria-expanded', 'false');
  }
  if (except !== 'operations') {
    operationsPanel.hidden = true;
    operationsToggle.classList.remove('is-open');
    operationsToggle.setAttribute('aria-expanded', 'false');
  }
  if (except !== 'availability') {
    availability.hidden = true;
    availabilityButton?.setAttribute('aria-expanded', 'false');
  }
  if (except !== 'counter') counterPanel.hidden = true;
  const shortcutDialog = document.getElementById('shortcut-dialog');
  if (except !== 'shortcut' && shortcutDialog?.open) shortcutDialog.close();
};
const counterPrice = (item) => {
  const options = [['', item.price], ['Half', item.halfPrice], ['Full', item.fullPrice], ['With Bone', item.withBonePrice], ['Boneless', item.bonelessPrice], ['30 ml', item.price30ml], ['60 ml', item.price60ml], ['90 ml', item.price90ml], ['180 ml', item.price180ml]].filter(([, price]) => Number(String(price || '').replace(/[^0-9.]/g, '')) > 0);
  return options[0] || ['', 0];
};
const counterPortionOptions = (item) => [['', 'Regular', item.price], ['Half', 'Half', item.halfPrice], ['Full', 'Full', item.fullPrice], ['With Bone', 'With Bone', item.withBonePrice], ['Boneless', 'Boneless', item.bonelessPrice], ['30 ml', '30 ml', item.price30ml], ['60 ml', '60 ml', item.price60ml], ['90 ml', '90 ml', item.price90ml], ['180 ml', '180 ml', item.price180ml]].filter(([, , price]) => Number(String(price || '').replace(/[^0-9.]/g, '')) > 0);
function openCounterChoice(item) {
  counterChoiceItem = item;
  const options = counterPortionOptions(item);
  const dialog = document.getElementById('counter-choice-dialog');
  document.getElementById('counter-choice-content').innerHTML = `<span class="eyebrow">Add to parcel</span><h2>${esc(item.name)}</h2><p>${esc(item.category || 'Menu')}</p><div class="counter-choice-options">${options.map(([value, label, price], index) => `<label><input type="radio" name="counter-portion" value="${esc(value)}" data-counter-choice-price="${Number(String(price).replace(/[^0-9.]/g, ''))}" ${index === 0 ? 'checked' : ''}><span>${esc(label)} <b>${counterMoney(String(price).replace(/[^0-9.]/g, ''))}</b></span></label>`).join('')}</div>${item.gravyStyleAvailable ? '<fieldset class="counter-style-options"><legend>Preparation style</legend><label><input type="radio" name="counter-style" value="" checked> Regular</label><label><input type="radio" name="counter-style" value="Gravy"> Gravy <b>+₹10</b></label><label><input type="radio" name="counter-style" value="Semi-gravy"> Semi-gravy <b>+₹10</b></label></fieldset>' : ''}<button type="button" id="counter-choice-add" class="counter-place-order">Add to order</button>`;
  if (typeof dialog.showModal === 'function') dialog.showModal();
}
const counterMoney = (value) => `₹${Math.round(Number(value) || 0)}`;
function renderCounterOrder() {
  const search = String(document.getElementById('counter-menu-search')?.value || '').trim().toLowerCase();
  const categoryRank = (category) => { const value=String(category).toLowerCase(); return [/starter|appetizer/, /soup/, /salad/, /quick.?bite|snack/, /tandoor|kebab|grill/, /chinese/, /rice|noodle/, /indian gravy|curry/, /biryani/, /bread|naan/, /main|special/, /dessert/].findIndex((pattern)=>pattern.test(value)); };
  const savedCategoryOrder = new Map(counterMenu.filter((item) => Number(item.categoryOrderIndex) >= 0).map((item) => [item.category || 'Menu', Number(item.categoryOrderIndex)]));
  const categoriesFor = (menuType) => [...new Set(counterMenu.filter((item) => item.menuType === menuType).map((item) => item.category || 'Menu'))].sort((a,b) => { const savedA=savedCategoryOrder.has(a) ? savedCategoryOrder.get(a) : 999, savedB=savedCategoryOrder.has(b) ? savedCategoryOrder.get(b) : 999; const rankA=categoryRank(a), rankB=categoryRank(b); return savedA - savedB || (rankA < 0 ? 99 : rankA) - (rankB < 0 ? 99 : rankB) || a.localeCompare(b); });
  const foodCategories = categoriesFor('food'), barCategories = categoriesFor('bar');
  const categoryButton = (category, label = category) => `<button type="button" class="counter-category ${counterCategory === category ? 'is-active' : ''}" data-counter-category="${esc(category)}">${esc(label)}</button>`;
  document.getElementById('counter-categories').innerHTML = `${categoryButton('all', 'All items')}<span class="counter-category-group">Food menu</span>${foodCategories.map((category) => categoryButton(category)).join('')}<span class="counter-category-group">Alcohol & bar</span>${barCategories.map((category) => categoryButton(category)).join('')}`;
  const visible = counterMenu.filter((item) => (counterCategory === 'all' || (item.category || 'Menu') === counterCategory) && `${item.name} ${item.category}`.toLowerCase().includes(search));
  document.getElementById('counter-menu-items').innerHTML = visible.map((item) => { const [portion, price] = counterPrice(item); return `<button type="button" class="counter-menu-item" data-counter-item="${counterMenu.indexOf(item)}"><span>${esc(item.category || 'Menu')}</span><b>${esc(item.name)}</b><small>${portion ? `${esc(portion)} · ` : ''}${counterMoney(String(price).replace(/[^0-9.]/g, ''))}</small><i aria-hidden="true">+</i></button>`; }).join('') || '<p class="counter-empty">No menu items match that search.</p>';
  const items = counterCart.map((line, index) => { const unit = line.price + (line.style ? 10 : 0); return `<div class="counter-cart-line"><div><b>${esc(line.name)}</b><small>${esc(line.portion || 'Regular')}${line.style ? ` · ${esc(line.style)}` : ''} · ${counterMoney(unit)} each</small></div><div class="counter-quantity"><button type="button" data-counter-qty="${index}" data-counter-change="-1">−</button><b>${line.quantity}</b><button type="button" data-counter-qty="${index}" data-counter-change="1">+</button></div><strong>${counterMoney(unit * line.quantity)}</strong></div>`; }).join('');
  document.getElementById('counter-cart-items').innerHTML = items || '<p class="counter-empty">Choose items from the menu to start an order.</p>';
  const subtotal = counterCart.reduce((sum, line) => sum + (line.price + (line.style ? 10 : 0)) * line.quantity, 0);
  const requestedPoints = Math.floor(Number(document.getElementById('counter-wallet-redeem')?.value || 0));
  const usablePoints = counterLoyaltyPoints >= 100 ? Math.min(counterLoyaltyPoints, subtotal, Math.max(0, requestedPoints)) : 0;
  document.getElementById('counter-total').textContent = counterMoney(subtotal - usablePoints);
  const note = document.getElementById('counter-wallet-note');
  if (note) note.textContent = usablePoints ? `₹${usablePoints} wallet discount applied.` : '';
}
async function loadCounterLoyalty() {
  const phone = String(document.getElementById('counter-customer-phone')?.value || '').replace(/\D/g, '');
  const walletBalance = document.getElementById('counter-wallet-balance');
  const redeemWrap = document.getElementById('counter-wallet-redeem-wrap');
  const redeem = document.getElementById('counter-wallet-redeem');
  if (phone.length < 7) { counterLoyaltyPoints = 0; counterWallet.hidden = true; if (redeem) redeem.value = '0'; renderCounterOrder(); return; }
  counterWallet.hidden = false; if (walletBalance) walletBalance.textContent = 'Checking wallet points…';
  try {
    const response = await fetch('/api/loyalty', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ phone }) });
    const data = await response.json(); if (!response.ok) throw new Error();
    counterLoyaltyPoints = Number(data.points || 0);
    if (walletBalance) walletBalance.textContent = counterLoyaltyPoints >= 100 ? `${counterLoyaltyPoints} points available` : `${counterLoyaltyPoints} points · 100 needed to redeem`;
    if (redeemWrap) redeemWrap.hidden = counterLoyaltyPoints < 100;
    if (redeem) { redeem.max = String(counterLoyaltyPoints); if (counterLoyaltyPoints < 100) redeem.value = '0'; }
  } catch { counterLoyaltyPoints = 0; if (walletBalance) walletBalance.textContent = 'Wallet points are unavailable right now.'; if (redeemWrap) redeemWrap.hidden = true; }
  renderCounterOrder();
}
async function openCounterOrder() {
  const opening = counterPanel.hidden;
  if (!opening) { counterPanel.hidden = true; return; }
  closeOpenPanels('counter');
  counterPanel.hidden = false;
  document.getElementById('counter-menu-items').innerHTML = '<p class="counter-empty">Loading menu…</p>';
  try { await Promise.all([loadAvailability(), refreshCounterLiveStatus()]); counterMenu = menuItems.filter((item) => !unavailable.has(item.key)); renderCounterOrder(); counterPanel.scrollIntoView({ behavior:'smooth', block:'start' }); } catch (error) { document.getElementById('counter-menu-items').innerHTML = `<p class="counter-empty">${esc(error.message)}</p>`; if (navigator.onLine) reportOrdersDiagnostic({ message:`Counter menu could not load: ${error.message}`, source:'counter menu' }); }
}
if (installButton) installButton.innerHTML = `${actionIcon('install')}<span>Install shortcut</span>`;
if (availabilityButton) availabilityButton.innerHTML = `${actionIcon('cutlery')}<span>Menu availability</span>`;
if (alertsButton) alertsButton.innerHTML = `${actionIcon('bell')}<span>Enable alerts</span>`;
if (refreshButton) refreshButton.innerHTML = `${actionIcon('refresh')}<span>Refresh</span>`;
const liveOrdersStyles = document.createElement('style');
liveOrdersStyles.textContent = `.live-orders-toggle{display:inline-flex;align-items:center;gap:8px;color:#15335b;background:#fff;box-shadow:0 3px 11px rgba(7,20,45,.16)}.live-orders-toggle:hover,.live-orders-toggle.is-open{color:#fff;background:#168451}.live-dot{width:8px;height:8px;border-radius:50%;background:#e3342f;box-shadow:0 0 0 3px rgba(227,52,47,.14)}.live-orders-toggle.is-open .live-dot{background:#d9ffe9;box-shadow:0 0 0 3px rgba(217,255,233,.2)}.live-orders-toggle b{display:grid;min-width:19px;height:19px;place-items:center;padding:0 4px;border-radius:999px;color:#fff;background:#e3342f;font-size:10px}.live-orders-toggle.is-open b{color:#168451;background:#fff}#live-orders-panel{margin-top:20px}#live-orders-panel[hidden]{display:none}#live-orders-panel .order-search-panel{margin-top:0}#live-orders-panel main{padding-top:20px}#order-status-filters{display:flex;flex-wrap:wrap;gap:8px;margin:12px 28px 0}.order-status-filter{padding:8px 12px;border:1px solid transparent;border-radius:9px;font-size:11px}.order-status-filter.status-all{color:#fff;background:#263d68}.order-status-filter.status-accepted{color:#fff;background:#e3342f}.order-status-filter.status-preparing{color:#3d2a00;background:#f5a21a}.order-status-filter.status-ready{color:#fff;background:#168451}.order-status-filter.status-completed{color:#fff;background:#506078}.order-status-filter.status-rejected{color:#fff;background:#9b2634}.order-status-filter:not(.is-active){color:#68778e;background:#fff;border-color:#dce4ee;box-shadow:none}.order-status-filter:hover{transform:none;filter:none;border-color:currentColor}.order-status-filter.is-active{box-shadow:0 4px 11px rgba(31,48,80,.2)}@media(max-width:600px){.live-orders-toggle span:not(.live-dot){display:none}.live-orders-toggle{padding-inline:9px}#live-orders-panel{margin-top:14px}#order-status-filters{margin:10px 16px 0;gap:6px}.order-status-filter{padding:7px 9px;font-size:10px}}`;
document.head.appendChild(liveOrdersStyles);
const headerActionStyles = document.createElement('style');
headerActionStyles.textContent = `.header-actions button,.live-orders-toggle{display:inline-flex;align-items:center;justify-content:center;gap:8px}.header-action-icon{width:20px;height:20px;flex:0 0 20px}.live-orders-toggle{color:#fff;background:linear-gradient(135deg,#158951,#0f7545)}.live-orders-toggle:hover,.live-orders-toggle.is-open{color:#fff;background:linear-gradient(135deg,#0e7544,#0b603a)}.live-orders-toggle b{color:#d22731;background:#fff}.operations-toggle{color:#fff!important;background:linear-gradient(135deg,#3267bd,#24529d)!important;border:1px solid rgba(255,255,255,.72)!important}.operations-toggle:hover,.operations-toggle.is-open{background:linear-gradient(135deg,#2554a2,#173d7d)!important}.install-shortcut{color:#18365f!important;background:#fff!important}.availability-toggle{color:#132b4c!important;background:linear-gradient(135deg,#ffc548,#f9a92a)!important}.header-actions #enable-notifications,.header-actions button[onclick]{color:#fff!important;background:linear-gradient(135deg,#e93838,#c9242d)!important}@media(max-width:600px){.header-action-icon{width:18px;height:18px;flex-basis:18px}.header-actions button span{display:none}.header-actions button{padding-inline:10px!important}.live-orders-toggle span{display:none}}`;
document.head.appendChild(headerActionStyles);
const operationsStyles = document.createElement('style');
operationsStyles.textContent = `#operations-panel{margin:20px 28px 0;padding:24px;border:1px solid #dce4ee;border-radius:18px;background:#fff;box-shadow:0 14px 34px rgba(24,39,70,.09)}#operations-panel[hidden]{display:none}.operations-toggle{display:inline-flex;align-items:center;gap:7px;color:#fff;background:#53647e}.operations-toggle span{font-size:16px}.operations-toggle.is-open{background:#243b63}.operations-head{display:flex;justify-content:space-between;gap:16px}.operations-head h2{margin:4px 0;font-size:22px}.operations-head p{margin:0;color:#68778e}.operations-tabs{display:inline-flex;gap:4px;margin:20px 0 14px;padding:4px;border-radius:10px;background:#eef3f8}.operations-tabs button{padding:8px 12px;color:#627188;background:transparent;font-size:12px}.operations-tabs button.is-active{color:#fff;background:#263d68}.operations-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:12px}.operation-printer,.kot-ticket{padding:15px;border:1px solid #e1e8f0;border-radius:12px;background:#fff}.operation-printer-head,.kot-ticket-head{display:flex;justify-content:space-between;gap:10px;align-items:start}.operation-printer h3,.kot-ticket h3{margin:0;color:#23334e;font-size:15px}.printer-type{padding:4px 7px;border-radius:999px;color:#53647e;background:#eef3f8;font-size:10px;font-weight:900;text-transform:uppercase}.printer-type.kot{color:#087348;background:#e8f7ef}.operation-printer p{margin:8px 0 0;color:#6e7d91;font-size:12px}.operation-printer button{margin-top:12px;padding:7px 9px;color:#a52a39;background:#fff0f0;font-size:11px}.operations-form{display:grid;grid-template-columns:1.4fr .75fr auto;gap:9px;align-items:end;margin:13px 0}.operations-form label{display:grid;gap:4px;color:#5e6d83;font-size:10px;font-weight:900;letter-spacing:.04em;text-transform:uppercase}.operations-form input,.operations-form select{width:100%;padding:9px;border:1px solid #d4deea;border-radius:8px;color:#26344e;background:#fff;font:600 12px Manrope,sans-serif}.operations-form button{padding:10px 12px;background:#263d68;font-size:11px}.routing-list{display:grid;gap:8px;margin-top:13px}.route-row{display:flex;justify-content:space-between;gap:12px;align-items:center;padding:11px 12px;border:1px solid #e5ebf2;border-radius:9px;background:#f9fbfd;font-size:12px}.route-row b{color:#23334e}.route-row span{color:#718097}.route-row button{padding:6px 8px;color:#a52a39;background:#fff0f0;font-size:10px}.operations-save{margin-top:15px;background:#168451}.kot-ticket{border-left:4px solid #e3342f}.kot-ticket p{margin:6px 0;color:#718097;font-size:11px}.kot-items{margin:12px 0;padding:10px 0;border-block:1px solid #edf0f4}.kot-items div{padding:4px 0;color:#2f3e55;font-size:12px}.kot-items b{color:#c42b28}.kot-ticket button{padding:8px 10px;background:#263d68;font-size:11px}.operations-empty{padding:25px;color:#718097;border:1px dashed #d4deea;border-radius:12px;text-align:center}@media(max-width:600px){#operations-panel{margin:14px 16px 0;padding:16px}.operations-head p{font-size:12px}.operations-form{grid-template-columns:1fr}.operations-form button{width:100%}.operations-grid{grid-template-columns:1fr}}`;
document.head.appendChild(operationsStyles);
const operationsLauncherStyles = document.createElement('style');
operationsLauncherStyles.textContent = `.operation-launches{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin:22px 0 18px}.operation-launch{display:grid;grid-template-columns:44px minmax(0,1fr) auto;gap:12px;align-items:center;padding:15px;border:1px solid #dfe7f1;border-radius:13px;color:#273852;background:#fff;text-align:left;box-shadow:0 3px 10px rgba(31,52,88,.035)}.operation-launch:hover{transform:translateY(-1px);filter:none;border-color:#aebfd4;box-shadow:0 8px 18px rgba(31,52,88,.1)}.operation-launch.is-active{border-color:#263d68;background:linear-gradient(135deg,#263d68,#35578d);color:#fff}.operation-icon{display:grid;width:44px;height:44px;place-items:center;border-radius:12px;color:#263d68;background:#e9f0fa;font-size:26px;font-weight:900}.operation-launch.is-active .operation-icon{color:#263d68;background:#fff}.operation-launch b,.operation-launch small{display:block}.operation-launch b{font-size:14px}.operation-launch small{margin-top:3px;color:#74839a;font-size:11px;font-weight:600;line-height:1.35}.operation-launch.is-active small{color:#d9e5f7}.operation-launch i{font-size:25px;font-style:normal;font-weight:400}@media(max-width:600px){.operation-launches{grid-template-columns:1fr}.operation-launch{padding:13px}}`;
document.head.appendChild(operationsLauncherStyles);
const counterOrderStyles = document.createElement('style');
counterOrderStyles.textContent = `#counter-order-panel{margin:20px 28px 0;padding:24px;border:1px solid #dce4ee;border-radius:18px;background:#f7f9fc;box-shadow:0 14px 34px rgba(24,39,70,.09)}#counter-order-panel[hidden]{display:none}.counter-order-head,.counter-cart-head{display:flex;justify-content:space-between;align-items:start;gap:14px}.counter-order-head h2{margin:4px 0;font-size:24px}.counter-order-head p{margin:0;color:#68778e}.counter-order-layout{display:grid;grid-template-columns:minmax(0,1.55fr) minmax(300px,.8fr);gap:18px;margin-top:20px}.counter-menu,.counter-cart{padding:16px;border:1px solid #dfe7f0;border-radius:14px;background:#fff}.counter-menu{display:grid;grid-template-columns:235px minmax(0,1fr);grid-template-rows:auto minmax(0,1fr);gap:14px}.counter-search{grid-column:1/-1;display:flex;gap:8px;align-items:center;padding:0 12px;border:1px solid #cfdbea;border-radius:10px;background:#fff}.counter-search input{width:100%;height:42px;border:0;outline:0;font:700 13px Manrope,sans-serif}.counter-categories{display:flex;flex-direction:column;gap:0;max-height:530px;overflow:auto;border:1px solid #e0e7ef;border-radius:11px;background:#fff}.counter-category{width:100%;min-height:58px;padding:12px 14px;border:0;border-bottom:1px solid #e9eef4;border-radius:0;color:#40516a;background:#fff;text-align:left;font-size:14px;font-weight:800}.counter-category:first-child{color:#a82a38;background:#fff0f1}.counter-category:last-child{border-bottom:0}.counter-category:hover{color:#263d68;background:#f3f7fc;transform:none;filter:none}.counter-category.is-active{color:#fff;background:#263d68}.counter-menu-items{display:grid;grid-template-columns:repeat(auto-fill,minmax(155px,1fr));gap:10px;max-height:530px;overflow:auto}.counter-menu-item{position:relative;min-height:108px;padding:13px;border:1px solid #dce5ef;border-left:4px solid #d93642;border-radius:10px;color:#25364f;background:#fff;text-align:left;box-shadow:0 3px 8px rgba(25,44,75,.04)}.counter-menu-item:hover{transform:translateY(-1px);border-color:#9bb1cc;border-left-color:#d93642;filter:none}.counter-menu-item span,.counter-menu-item b,.counter-menu-item small{display:block}.counter-menu-item span{color:#7c8ba0;font-size:9px;font-weight:900;text-transform:uppercase}.counter-menu-item b{margin:7px 22px 5px 0;font-size:13px;line-height:1.25}.counter-menu-item small{color:#178554;font-size:11px;font-weight:900}.counter-menu-item i{position:absolute;right:10px;bottom:9px;display:grid;width:23px;height:23px;place-items:center;border-radius:50%;color:#fff;background:#263d68;font-size:18px;font-style:normal}.counter-cart{display:flex;min-height:500px;flex-direction:column}.counter-cart-head h3{margin:0;font-size:16px}.counter-clear{padding:5px 8px;color:#a72c38;background:#fff0f1;font-size:10px}.counter-cart-items{display:grid;gap:9px;margin:14px 0}.counter-cart-line{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:8px;align-items:center;padding:10px 0;border-bottom:1px solid #edf1f5}.counter-cart-line b,.counter-cart-line small{display:block}.counter-cart-line b{font-size:12px}.counter-cart-line small{margin-top:3px;color:#718097;font-size:10px}.counter-cart-line strong{font-size:12px}.counter-quantity{display:flex;align-items:center;gap:6px}.counter-quantity button{display:grid;width:24px;height:24px;place-items:center;padding:0;color:#263d68;background:#edf3fb;font-size:16px}.counter-customer{display:grid;gap:9px;margin-top:auto}.counter-customer label{display:grid;gap:4px;color:#5d6d84;font-size:10px;font-weight:900;text-transform:uppercase}.counter-customer input,.counter-customer textarea{width:100%;padding:9px 10px;border:1px solid #d4deea;border-radius:8px;color:#26344e;font:600 12px Manrope,sans-serif}.counter-customer textarea{min-height:58px;resize:vertical}.counter-total{display:flex;justify-content:space-between;align-items:center;margin-top:14px;padding:13px 0;border-top:2px solid #e2e9f1;color:#5a6a80;font-weight:800}.counter-total b{color:#bd3038;font-size:21px}.counter-place-order{width:100%;padding:13px;color:#fff;background:linear-gradient(135deg,#d93642,#ab1e30);font-size:13px}.counter-order-status{min-height:18px;margin:9px 0 0;color:#53647e;font-size:11px;font-weight:700}.counter-empty{margin:20px 0;color:#75849a;font-size:12px;text-align:center}@media(max-width:800px){#counter-order-panel{margin:14px 16px 0;padding:16px}.counter-order-layout{grid-template-columns:1fr}.counter-menu{grid-template-columns:1fr}.counter-search{grid-column:auto}.counter-categories{display:flex;flex-direction:row;max-height:none;overflow:auto}.counter-category{width:auto;min-width:max-content;min-height:42px;border-bottom:0;border-right:1px solid #e9eef4;font-size:11px}.counter-cart{min-height:0}.counter-menu-items{max-height:none}}`;
document.head.appendChild(counterOrderStyles);
const counterChoiceStyles = document.createElement('style');
counterChoiceStyles.textContent = `.counter-choice-dialog{width:min(430px,calc(100vw - 32px));padding:24px;border:0;border-radius:16px;color:#26344e;box-shadow:0 20px 60px rgba(14,29,55,.25)}.counter-choice-dialog::backdrop{background:rgba(21,34,58,.46)}.counter-choice-dialog h2{margin:4px 30px 3px 0;font-size:21px}.counter-choice-dialog p{margin:0;color:#718097;font-size:12px}.counter-choice-options{display:grid;gap:8px;margin:18px 0}.counter-choice-options label{cursor:pointer}.counter-choice-options input{position:absolute;opacity:0}.counter-choice-options span{display:flex;justify-content:space-between;padding:12px;border:1px solid #d9e3ef;border-radius:9px;font-size:13px;font-weight:800}.counter-choice-options input:checked+span{border-color:#263d68;color:#fff;background:#263d68}.counter-style-options{display:flex;flex-wrap:wrap;gap:8px;margin:16px 0;padding:12px;border:1px solid #e0e7ef;border-radius:9px}.counter-style-options legend{padding:0 4px;color:#68778e;font-size:11px;font-weight:900}.counter-style-options label{font-size:12px;font-weight:700}.counter-style-options b{color:#148251}`;
document.head.appendChild(counterChoiceStyles);
const counterLayoutRefinements = document.createElement('style');
counterLayoutRefinements.textContent = `.counter-menu-items{align-items:start;grid-auto-rows:150px}.counter-menu-item{height:150px;min-height:0}.counter-category-group{display:block;padding:13px 14px 7px;color:#9a2635;background:#f8fafc;font-size:10px;font-weight:900;letter-spacing:.09em;text-transform:uppercase}.counter-category-group~.counter-category{min-height:54px}.counter-cart{height:auto;min-height:0;align-self:start}.counter-cart-items{display:block;height:clamp(190px,28vh,260px);min-height:0;flex:0 0 auto;overflow-y:auto;margin:14px 0}.counter-cart-line{min-height:0;height:72px;padding:10px 0}.counter-customer{flex:0 0 auto;margin-top:0}.counter-customer textarea{resize:none}.counter-total,.counter-place-order,.counter-order-status{flex:0 0 auto}@media(max-width:800px){.counter-menu-items{grid-auto-rows:130px}.counter-menu-item{height:130px}.counter-category-group{display:none}.counter-cart-items{height:220px;max-height:45vh}}`;
document.head.appendChild(counterLayoutRefinements);
const operationsRoutingStyles = document.createElement('style');
operationsRoutingStyles.textContent = `.operations-section{padding:20px;border:1px solid #e2e9f1;border-radius:15px;background:linear-gradient(145deg,#fff,#fbfcfe)}.operations-section+.operations-section{margin-top:16px}.operations-section-head{display:flex;align-items:start;justify-content:space-between;gap:16px}.operations-section-head h3{margin:3px 0 5px;color:#1f2e47;font-size:18px}.operations-section-head p{max-width:660px;margin:0;color:#6a7890;font-size:12px;line-height:1.5}.operations-count{padding:7px 9px;border-radius:999px;color:#36547d;background:#edf3fb;font-size:10px;font-weight:900;white-space:nowrap}.operations-printer-form,.operations-route-form{display:grid;gap:10px;align-items:end;margin:18px 0}.operations-printer-form{grid-template-columns:minmax(180px,1.2fr) minmax(130px,.55fr) minmax(180px,.9fr) 90px auto}.operations-route-form{grid-template-columns:minmax(180px,.8fr) minmax(320px,1.4fr) auto}.operations-printer-form label,.operations-route-form label{display:grid;gap:5px;color:#55657b;font-size:10px;font-weight:900;letter-spacing:.05em;text-transform:uppercase}.operations-printer-form input,.operations-printer-form select,.operations-route-form select{width:100%;min-height:42px;padding:10px 11px;border:1px solid #d5dfeb;border-radius:9px;color:#23334e;background:#fff;font:700 12px Manrope,sans-serif}.operations-printer-form input:focus,.operations-printer-form select:focus,.operations-route-form select:focus,.category-search:focus{outline:0;border-color:#2e67b1;box-shadow:0 0 0 3px rgba(46,103,177,.12)}.operations-printer-form button,.operations-route-form button{min-height:42px;padding:10px 13px;background:#263d68;font-size:11px;white-space:nowrap}.operations-printer-form button span{font-size:16px}.printer-grid{grid-template-columns:repeat(auto-fill,minmax(255px,1fr))}.operation-printer{min-height:146px;border-color:#dfe7f0;box-shadow:0 4px 12px rgba(30,51,83,.05)}.operation-printer-head{display:grid;grid-template-columns:38px minmax(0,1fr) auto;gap:10px}.printer-card-icon{display:grid;width:38px;height:38px;place-items:center;border-radius:10px;color:#087348;background:#e8f7ef;font-size:22px;font-weight:900}.printer-card-icon.bill{color:#315487;background:#eaf1ff}.operation-printer p{line-height:1.4}.printer-endpoint{margin:9px 0!important;padding:7px 9px;border-radius:8px;color:#56708f!important;background:#f2f6fb;font:800 10px ui-monospace,SFMono-Regular,Menlo,monospace!important}.printer-endpoint.is-pending{color:#9a6c20!important;background:#fff8e9}.routing-section{background:linear-gradient(145deg,#fffdf8,#fff)}.category-picker{border:1px solid #d5dfeb;border-radius:10px;background:#fff;padding:9px}.category-picker-top{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:8px}.category-picker-top b{color:#23334e;font-size:12px}.category-picker-top span{color:#64748b;font-size:10px;font-weight:800}.category-search{width:100%;min-height:37px;border:1px solid #d5dfeb;border-radius:8px;padding:8px 10px;font:700 12px Manrope,sans-serif}.category-checklist{display:grid;grid-template-columns:repeat(auto-fit,minmax(155px,1fr));gap:7px;max-height:190px;overflow:auto;margin-top:9px;padding-right:2px}.category-choice{display:flex!important;align-items:center;gap:8px;padding:8px 9px;border:1px solid #e2e9f1;border-radius:8px;color:#33445f!important;background:#fbfcfe;font-size:11px!important;letter-spacing:0!important;text-transform:none!important;cursor:pointer}.category-choice:hover{border-color:#a9bdd8;background:#f1f6fd}.category-choice input{width:16px;height:16px;accent-color:#1e8b59}.category-choice.is-hidden{display:none!important}.route-row{display:grid;grid-template-columns:28px minmax(0,1fr) auto}.route-icon{display:grid;width:26px;height:26px;place-items:center;border-radius:7px;color:#087348;background:#e8f7ef;font-size:16px}.route-row span{display:block;margin-top:3px}.operations-save-bar{display:flex;align-items:center;justify-content:space-between;gap:14px;margin-top:16px;padding:13px 15px;border:1px solid #cce8d8;border-radius:12px;background:#f3fbf6;color:#527260;font-size:12px;font-weight:700}.operations-save{margin:0!important;padding:10px 14px;white-space:nowrap}@media(max-width:900px){.operations-printer-form{grid-template-columns:1fr 1fr}.operations-printer-form button{width:100%}}@media(max-width:760px){.operations-printer-form,.operations-route-form{grid-template-columns:1fr}.operations-printer-form button,.operations-route-form button{width:100%}.operations-section{padding:16px}.operations-section-head{align-items:flex-start}.category-checklist{grid-template-columns:1fr}.operations-save-bar{align-items:stretch;flex-direction:column}.operations-save{width:100%}}`;
document.head.appendChild(operationsRoutingStyles);
const printerConnectionStyles = document.createElement('style');
printerConnectionStyles.textContent = `.operations-printer-form{grid-template-columns:repeat(auto-fit,minmax(160px,1fr))}.operations-printer-form button{align-self:end}`;
document.head.appendChild(printerConnectionStyles);
const operationsPolishStyles = document.createElement('style');
operationsPolishStyles.textContent = `#operations-panel{max-width:1680px;margin:24px auto;padding:30px}.operations-head h2{font-size:28px}.operations-head p{font-size:14px}.operation-launches{gap:14px;margin:24px 0}.operation-launch{min-height:84px;padding:18px}.operation-launch b{font-size:16px}.operation-launch small{font-size:12px}.operations-section{padding:24px}.operations-section-head h3{font-size:21px}.operations-section-head p{font-size:14px}.operations-count{padding:8px 11px;font-size:11px}.operations-printer-form{grid-template-columns:minmax(240px,1.3fr) minmax(175px,.7fr) minmax(300px,1.15fr) auto;gap:14px}.operations-printer-form label,.operations-route-form label{gap:7px;font-size:11px}.operations-printer-form input,.operations-printer-form select,.operations-route-form select{min-height:46px;padding:11px 13px;font-size:13px}.operations-printer-form button,.operations-route-form button{min-height:46px;padding:11px 16px;font-size:12px}.printer-grid{margin-top:20px}.operation-printer{min-height:156px;padding:18px}.operations-route-form{grid-template-columns:minmax(250px,.8fr) minmax(460px,1.55fr);gap:18px;align-items:start}.route-side-controls{display:grid;gap:13px}.route-side-controls button{width:100%;margin-top:3px}.category-picker{padding:15px;border-radius:12px;box-shadow:0 3px 12px rgba(29,51,83,.04)}.category-picker-top b{font-size:14px}.category-picker-top span{font-size:11px}.category-search{min-height:42px;font-size:13px}.category-checklist{grid-template-columns:repeat(3,minmax(150px,1fr));gap:9px;max-height:260px;padding:2px}.category-choice{min-height:42px;padding:10px 11px;font-size:12px!important}.category-choice input{width:18px;height:18px}.routing-list{margin-top:18px}.route-row{padding:13px 14px;font-size:13px}.operations-save-bar{margin-top:20px;padding:15px 17px;font-size:13px}@media(max-width:1100px){.operations-printer-form{grid-template-columns:1fr 1fr}.operations-route-form{grid-template-columns:1fr}.category-checklist{grid-template-columns:repeat(3,minmax(145px,1fr))}}@media(max-width:680px){#operations-panel{margin:14px 12px;padding:18px}.operations-head h2{font-size:24px}.operations-section{padding:17px}.operations-printer-form{grid-template-columns:1fr}.category-checklist{grid-template-columns:1fr}.operation-launches{grid-template-columns:1fr}.operations-save-bar{font-size:12px}}`;
document.head.appendChild(operationsPolishStyles);
const printerSetupStyles = document.createElement('style');
printerSetupStyles.textContent = `.operations-section:first-child{background:linear-gradient(145deg,#fff,#f8fbff)}.printer-setup-flow{display:flex;align-items:center;gap:12px;max-width:980px;margin:18px 0 20px;padding:12px 14px;border:1px solid #dbe8f7;border-radius:12px;background:#f5f9fe}.printer-setup-flow i{display:grid;width:34px;height:34px;place-items:center;flex:0 0 34px;border-radius:10px;color:#fff;background:#284778;font-size:17px;font-style:normal}.printer-setup-flow b,.printer-setup-flow span{display:block}.printer-setup-flow b{color:#243958;font-size:13px}.printer-setup-flow span{margin-top:2px;color:#6d7d95;font-size:12px;line-height:1.4}.operations-printer-form{max-width:1380px;padding:16px;border:1px solid #e0eaf5;border-radius:14px;background:#fff;box-shadow:0 5px 15px rgba(31,57,93,.035)}.operations-printer-form>*{min-width:0}.operations-printer-form input,.operations-printer-form select{box-sizing:border-box}.operations-printer-form button{min-width:132px}.printer-grid .operations-empty{grid-column:1/-1;min-height:116px;display:grid;place-items:center;margin-top:4px;border-style:dashed;background:#fbfdff;font-size:13px}.printer-grid{margin-top:16px}@media(max-width:760px){.printer-setup-flow{align-items:flex-start}.operations-printer-form{padding:14px}.operations-printer-form button{min-width:0}}`;
document.head.appendChild(printerSetupStyles);
const categoryBoardStyles = document.createElement('style');
categoryBoardStyles.textContent = `.all-categories-choice{display:flex!important;align-items:center;gap:11px;margin-bottom:8px;padding:12px;border:1px solid #dce7f2;border-radius:10px;color:#253854!important;background:linear-gradient(135deg,#fbfdff,#f3f8ff);font-size:13px!important;letter-spacing:0!important;text-transform:none!important;cursor:pointer}.all-categories-choice input{width:18px;height:18px;accent-color:#168451}.all-categories-choice span{display:grid;gap:2px;flex:1}.all-categories-choice b{font-size:13px}.all-categories-choice small{color:#728299;font-size:11px;font-weight:600}.all-categories-choice em{font-size:18px;font-style:normal;color:#587091}.all-categories-help{margin:0 3px 11px;color:#738198;font-size:11px;line-height:1.45}.category-choice{position:relative;padding-right:36px!important}.category-choice:has(input:checked){border-color:#8fcfad;background:#eefbf4;color:#176d49!important}.category-choice input:disabled{opacity:.45}.category-expand{position:absolute;right:7px;top:50%;display:grid;width:25px!important;min-height:25px!important;place-items:center;padding:0!important;transform:translateY(-50%);color:#52657e!important;background:transparent!important;font-size:15px!important}.category-expand.is-open{transform:translateY(-50%) rotate(180deg)}.category-item-preview{grid-column:1/-1;display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:7px 14px;margin:-4px 0 4px;padding:12px;border:1px solid #dfe9f3;border-radius:9px;background:#f7faff;color:#53647c;font-size:11px}.category-item-preview[hidden]{display:none}.category-item-preview>div{grid-column:1/-1;display:flex;justify-content:space-between;gap:12px;color:#263b59}.category-item-preview b{font-size:11px}.category-item-choice{display:flex!important;align-items:center;gap:7px;color:#465a75!important;font-size:11px!important;letter-spacing:0!important;text-transform:none!important;cursor:pointer}.category-item-choice input{width:15px;height:15px;accent-color:#168451}.category-item-choice span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.category-item-choice:has(input:checked){color:#12794c!important;font-weight:800}@media(max-width:680px){.category-item-preview{grid-template-columns:1fr}.category-item-preview>div{display:grid;gap:3px}}`;
document.head.appendChild(categoryBoardStyles);
const printBridgeSetupStyles = document.createElement('style');
printBridgeSetupStyles.textContent = `.printer-setup-flow{max-width:1380px}.bridge-setup{margin-left:auto;display:grid;gap:5px;max-width:510px;padding:10px 12px;border:1px solid #cfe2d8;border-radius:10px;background:#fff}.bridge-setup b{color:#087348}.bridge-setup span{font-size:11px}.bridge-setup code{padding:6px 8px;border-radius:6px;color:#243958;background:#edf3f8;font:700 10px ui-monospace,monospace;word-break:break-word}.bridge-setup button{justify-self:start;padding:6px 9px;color:#fff;background:#284778;font-size:10px}@media(max-width:900px){.printer-setup-flow{align-items:flex-start;flex-wrap:wrap}.bridge-setup{width:100%;max-width:none;margin-left:0}}`;
document.head.appendChild(printBridgeSetupStyles);
const managePrintersStyles = document.createElement('style');
managePrintersStyles.textContent = `.manage-printers,.printer-assignment{padding:24px;border:1px solid #dfe7f1;border-radius:16px;background:#fff}.manage-printers-head{display:flex;justify-content:space-between;gap:18px;align-items:start}.manage-printers h3,.printer-assignment h3{margin:4px 0;color:#1e3150;font-size:23px}.manage-printers p,.printer-assignment p{margin:0;color:#687a91}.bridge-status{max-width:370px;padding:9px 12px;border-radius:9px;color:#8a5b13;background:#fff5dc;font-size:12px;font-weight:700}.bridge-status.online{color:#087348;background:#e8f7ef}.add-system-printer{display:flex;gap:10px;margin:22px 0}.add-system-printer select{flex:1;min-height:44px;padding:10px;border:1px solid #cfdceb;border-radius:9px}.add-system-printer button,.printer-table-row button{padding:10px 14px;background:#246ce0;color:#fff}.printer-table{border:1px solid #dfe6ee;border-radius:12px;overflow:hidden}.printer-table-head,.printer-table-row{display:grid;grid-template-columns:1.5fr .8fr 1fr auto;gap:16px;align-items:center;padding:16px 18px}.printer-table-head{color:#526680;background:#eef2f6;font-size:11px;font-weight:900;text-transform:uppercase}.printer-table-row+.printer-table-row{border-top:1px solid #e1e7ee}.printer-table-row b,.printer-table-row small{display:block}.printer-table-row b{color:#1d2f4a}.printer-table-row small{margin-top:4px;color:#76869a;font-size:11px}.assignment-tag{display:inline-block;margin:2px;padding:5px 9px;border-radius:999px;color:#087348;background:#e8f7ef;font-size:11px;font-style:normal;font-weight:800}.printer-table-row .remove-printer{margin-left:6px;color:#a52a39;background:#fff0f0}.assignment-back{display:inline-flex!important;align-items:center;min-height:38px;margin-bottom:17px;padding:8px 12px!important;border:1px solid #9bb7d9!important;border-radius:8px!important;color:#123a70!important;background:#dcecff!important;box-shadow:0 1px 2px rgba(18,58,112,.12);font-size:13px!important;font-weight:900!important}.assignment-back:hover,.assignment-back:focus-visible{border-color:#246ce0!important;color:#fff!important;background:#246ce0!important;outline:0;box-shadow:0 0 0 3px rgba(36,108,224,.2)}.assignment-choices{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;max-width:720px;margin-top:24px}.assignment-choices button{display:grid;gap:6px;padding:22px;text-align:left;color:#1e3150;background:#fff;border:1px solid #d6e0ea}.assignment-choices button:hover{border-color:#246ce0;background:#f4f8ff}.assignment-choices b{font-size:16px}.assignment-choices span{color:#718198}.assignment-category-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-top:22px}.assignment-category-grid label{display:flex;align-items:center;gap:9px;padding:12px;border:1px solid #dce5ee;border-radius:9px;color:#263b59;font-size:12px;font-weight:700}.assignment-category-grid input{width:17px;height:17px;accent-color:#168451}.assignment-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:22px}.assignment-actions button{padding:11px 15px;background:#eef3f8;color:#304562}.assignment-actions .operations-save{color:#fff;background:#168451}@media(max-width:760px){.manage-printers-head{display:grid}.printer-table-head{display:none}.printer-table-row{grid-template-columns:1fr;gap:8px}.add-system-printer{display:grid}.assignment-choices,.assignment-category-grid{grid-template-columns:1fr}}`;
document.head.appendChild(managePrintersStyles);
const printerRoutingSummaryStyles = document.createElement('style');
printerRoutingSummaryStyles.textContent = `.printer-table-row .routing-summary{margin-top:9px;padding:7px 9px;border-radius:7px;color:#355577;background:#f1f6fb;line-height:1.5}.printer-table-row .routing-summary b{display:inline;color:#23436c;font-size:11px}`;
document.head.appendChild(printerRoutingSummaryStyles);
const windowsOperationsPolishStyles = document.createElement('style');
windowsOperationsPolishStyles.textContent = `#operations-panel{max-width:1900px;margin:20px auto 32px;padding:clamp(24px,2vw,36px)}.manage-printers{padding:clamp(22px,2vw,32px);background:linear-gradient(145deg,#fff 0%,#fbfdff 100%)}.manage-printers-head{padding-bottom:20px;border-bottom:1px solid #e6edf5}.manage-printers h3{font-size:clamp(24px,1.6vw,30px);letter-spacing:-.03em}.manage-printers p{max-width:700px;font-size:14px;line-height:1.5}.bridge-status{display:flex;align-items:center;max-width:410px;min-height:42px;padding:10px 13px;font-size:12px;line-height:1.35}.add-system-printer{display:grid;grid-template-columns:minmax(210px,.72fr) minmax(280px,1.28fr) auto;align-items:end;gap:14px;margin:24px 0}.add-printer-copy{display:grid;gap:4px;padding-bottom:2px}.add-printer-copy b{color:#203653;font-size:14px}.add-printer-copy span{color:#718299;font-size:12px;line-height:1.35}.add-system-printer select{min-height:48px;padding:11px 13px;color:#203653;font:700 13px Manrope,sans-serif}.add-system-printer button{min-height:48px;padding:11px 17px;border-radius:10px;font-size:12px}.printer-card-list{display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:16px}.printer-card{display:grid;gap:18px;min-height:230px;padding:20px;border:1px solid #dbe5f0;border-radius:15px;background:#fff;box-shadow:0 5px 17px rgba(22,43,77,.055)}.printer-card:hover{border-color:#a9c1df;box-shadow:0 10px 24px rgba(22,43,77,.09)}.printer-card-top{display:grid;grid-template-columns:46px minmax(0,1fr) auto;gap:12px;align-items:start}.printer-card-mark{display:grid;width:46px;height:46px;place-items:center;border-radius:13px;color:#178154;background:#e8f8ef;font-size:23px;font-weight:900}.printer-card-mark.is-bill{color:#2d63ab;background:#eaf2ff}.printer-card-label{display:block;margin-bottom:3px;color:#71829b;font-size:10px;font-weight:900;letter-spacing:.08em;text-transform:uppercase}.printer-card h4{margin:0;color:#1c304f;font-size:17px;line-height:1.25}.printer-card p{margin:5px 0 0;overflow:hidden;color:#6d7f96;font-size:12px;text-overflow:ellipsis;white-space:nowrap}.printer-card-state{padding:6px 8px;border-radius:999px;color:#86611e;background:#fff4db;font-size:10px;font-weight:900;white-space:nowrap}.printer-card-state.is-ready{color:#087348;background:#e7f8ef}.printer-routing-summary{display:grid;gap:5px;min-height:64px;padding:12px;border:1px solid #e3ebf4;border-radius:10px;background:#f6f9fd}.printer-routing-summary b{color:#29486e;font-size:13px}.printer-routing-summary span{display:-webkit-box;overflow:hidden;color:#64768e;font-size:11px;line-height:1.45;-webkit-line-clamp:2;-webkit-box-orient:vertical}.printer-card-actions{display:flex;gap:9px;align-items:center}.printer-card-actions button{min-height:38px;padding:8px 12px;border-radius:8px;background:#246ce0;color:#fff;font-size:11px}.printer-card-actions .remove-printer{color:#aa2937;background:#fff0f1}@media(max-width:960px){#operations-panel{margin:16px}.add-system-printer{grid-template-columns:1fr 1fr}.add-printer-copy{grid-column:1/-1}.bridge-status{max-width:none}}@media(max-width:640px){#operations-panel{margin:12px;padding:18px}.manage-printers{padding:18px}.manage-printers-head{display:grid;gap:14px}.add-system-printer{grid-template-columns:1fr}.printer-card-list{grid-template-columns:1fr}.printer-card{min-height:0}.printer-card-top{grid-template-columns:42px minmax(0,1fr)}.printer-card-state{grid-column:2;justify-self:start}.printer-card p{white-space:normal}.printer-card-actions{flex-wrap:wrap}}`;
document.head.appendChild(windowsOperationsPolishStyles);
const itemRoutingAssignmentStyles = document.createElement('style');
itemRoutingAssignmentStyles.textContent = `.printer-assignment{max-width:1280px;margin:0 auto;padding:clamp(22px,3vw,36px)}.printer-assignment>p{max-width:720px;font-size:14px;line-height:1.5}.assignment-all-categories{display:flex;align-items:center;gap:12px;margin-top:24px;padding:14px 16px;border:1px solid #d7e6f4;border-radius:12px;background:linear-gradient(135deg,#f8fbff,#eef6ff);cursor:pointer}.assignment-all-categories input{width:19px;height:19px;accent-color:#168451}.assignment-all-categories span{display:grid;gap:3px}.assignment-all-categories b{color:#223b5d;font-size:14px}.assignment-all-categories small{color:#6d7e96;font-size:12px}.assignment-category-grid{grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:11px;max-width:none}.assignment-category-card{border:1px solid #dbe5ef;border-radius:10px;background:#fff;overflow:hidden}.assignment-category-card summary{display:flex;align-items:center;justify-content:space-between;min-height:50px;padding:0 12px;cursor:pointer;list-style:none}.assignment-category-card summary::-webkit-details-marker{display:none}.assignment-category-card summary>label{flex:1;margin:0;border:0;background:transparent}.assignment-category-card summary i{color:#67809d;font-size:16px;font-style:normal;transition:transform .15s ease}.assignment-category-card[open] summary i{transform:rotate(180deg)}.assignment-item-list{display:grid;gap:8px;padding:12px;border-top:1px solid #e6edf4;background:#f8fbfe}.assignment-item-list>b{color:#51647e;font-size:10px;letter-spacing:.07em;text-transform:uppercase}.assignment-item-list label{display:flex;align-items:center;gap:8px;padding:3px 0;color:#3b516f;font-size:12px;font-weight:700}.assignment-item-list input{width:16px;height:16px;accent-color:#168451}.assignment-item-list small{color:#7a899c;font-size:12px}.assignment-dish{display:grid;gap:6px;padding:7px 9px;border:1px solid #dce6f1;border-radius:9px;background:#fff}.assignment-dish>label small{margin-left:auto;color:#71839a;font-weight:600;text-transform:uppercase;font-size:10px;letter-spacing:.04em}.assignment-variants{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;padding:7px 0 0 24px;border-top:1px solid #edf1f5}.assignment-variants label{font-size:11px;color:#60748d}.assignment-actions{padding-top:20px;border-top:1px solid #e7edf4}@media(max-width:640px){.assignment-category-grid{grid-template-columns:1fr}.assignment-variants{grid-template-columns:1fr}.assignment-actions{align-items:stretch;flex-direction:column}.assignment-actions button{width:100%}}`;
document.head.appendChild(itemRoutingAssignmentStyles);
const operationsWorkspaceStyles = document.createElement('style');
operationsWorkspaceStyles.textContent = `.operations-home{padding-top:20px}.operations-home-title h3,.kot-listing h3{margin:4px 0 5px;color:#192d4b;font-size:24px}.operations-home-title p,.kot-listing p{margin:0;color:#6a7b91;font-size:13px}.operations-home-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;margin-top:22px}.operations-home-card{display:grid;grid-template-columns:52px minmax(0,1fr) auto;gap:15px;align-items:center;min-height:112px;padding:20px;border:1px solid #dce5ef;border-radius:14px;color:#1d3150;background:#fff;text-align:left;box-shadow:0 4px 14px rgba(25,49,80,.045)}.operations-home-card:hover{border-color:#92add0;background:#f8fbff;box-shadow:0 9px 22px rgba(25,49,80,.1);transform:translateY(-1px)}.operations-home-icon{display:grid;width:52px;height:52px;place-items:center;border-radius:50%;color:#7d1e35;background:#f9edf0;font-size:27px;font-weight:900}.operations-home-card b,.operations-home-card small{display:block}.operations-home-card b{font-size:17px}.operations-home-card small{margin-top:5px;color:#6d7f97;font-size:12px;line-height:1.45}.operations-home-card i{color:#7d1e35;font-size:25px;font-style:normal}.kot-listing{padding-top:10px}.kot-listing-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:20px}.kot-listing-head .assignment-back{margin-bottom:15px}.kot-table-wrap{overflow:auto;border:1px solid #dce5ef;border-radius:13px;background:#fff}.kot-table{width:100%;min-width:900px;border-collapse:collapse;text-align:left}.kot-table th{padding:14px 15px;color:#53677f;background:#f4f7fa;font-size:11px;font-weight:900;letter-spacing:.04em;text-transform:uppercase}.kot-table td{padding:15px;border-top:1px solid #e4eaf1;color:#263b57;font-size:12px;vertical-align:middle}.kot-table td>b,.kot-table td small{display:block}.kot-table td small{margin-top:4px;color:#74849a}.kot-table td:nth-child(4){display:grid;gap:5px;min-width:210px}.kot-status{display:inline-block;padding:5px 8px;border-radius:999px;color:#174e79;background:#e7f4ff;font-size:10px;font-weight:900;text-transform:capitalize}.kot-print-action{min-height:36px;padding:8px 11px;border-radius:8px;color:#fff;background:#7d1e35;font-size:11px;font-weight:900;white-space:nowrap}.kot-print-action:hover{background:#571023}.kot-table-empty{padding:30px!important;color:#718197!important;text-align:center}@media(max-width:720px){.operations-home-grid{grid-template-columns:1fr}.operations-home-card{min-height:96px;padding:16px}.kot-listing-head{display:grid}.kot-listing-head .operations-count{justify-self:start}}`;
document.head.appendChild(operationsWorkspaceStyles);
const kotListingPriorityStyles = document.createElement('style');
kotListingPriorityStyles.textContent = `.kot-table{min-width:1280px}.kot-table td:nth-child(5){min-width:230px}.kot-table td:nth-child(6){min-width:145px}.kot-table td:nth-child(7){white-space:nowrap}.kot-number{color:#7d1e35;font-size:15px}.kot-table td:first-child{background:#fff8fa}.kot-table th:first-child{color:#7d1e35}`;
document.head.appendChild(kotListingPriorityStyles);

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#039;' })[char]);
const money = (value) => `₹${Number(value || 0).toFixed(0)}`;
const fulfillmentLabel = (order) => order?.mode === 'counter' || order?.fulfillment_type === 'takeaway' ? 'Takeaway' : order?.fulfillment_type === 'delivery' ? 'Delivery' : 'Pick Up';
const tomorrowLocal = () => { const date = new Date(Date.now() + 86400000); date.setSeconds(0, 0); return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
const toPushKey = (value) => { const padding = '='.repeat((4 - value.length % 4) % 4); const raw = atob((value + padding).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from(raw, (character) => character.charCodeAt(0)); };

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/orders-sw.js?v=10');
document.getElementById('enable-notifications')?.addEventListener('click', async () => {
  closeOpenPanels();
  const button = document.getElementById('enable-notifications');
  const notificationApi = window.Notification;
  try {
    if (!notificationApi || !('PushManager' in window) || !('serviceWorker' in navigator)) throw new Error('Push alerts need the installed Orders shortcut. Use Install shortcut first.');
    button.disabled = true;
    button.innerHTML = `${actionIcon('bell')}<span>Enabling…</span>`;
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
    button.innerHTML = `${actionIcon('bell')}<span>Alerts enabled</span>`;
  } catch (error) {
    button.innerHTML = `${actionIcon('bell')}<span>Enable alerts</span>`;
    const dialog = document.getElementById('shortcut-dialog');
    document.getElementById('shortcut-message').textContent = error.message;
    document.getElementById('shortcut-steps').innerHTML = '<li>Install the RL Orders shortcut on this device.</li><li>Open it once and tap Enable alerts.</li><li>Allow notifications when your device asks.</li>';
    if (typeof dialog?.showModal === 'function') dialog.showModal(); else alert(error.message);
  } finally { button.disabled = false; }
});

async function loadOrders() {
  if (ordersRefreshInFlight) return;
  ordersRefreshInFlight = true;
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
    const statusRows = orderStatusFilter === 'all' ? rows : rows.filter((order) => order.status === orderStatusFilter);
    const visibleRows = fulfillmentFilter ? statusRows.filter((order) => String(order.fulfillment_type || '').toLowerCase() === fulfillmentFilter) : statusRows;
    const emptyMessage = query ? 'No orders match that number.' : orderView === 'current' && !sessionOpen ? 'The restaurant is closed. Today\'s orders are safely available in Order history.' : 'No direct orders yet.';
    const filteredEmpty = orderStatusFilter !== 'all' ? `No ${orderStatusFilter} orders in this view.` : emptyMessage;
    const renderSignature = JSON.stringify({ orderView, orderStatusFilter, fulfillmentFilter, query, date, sessionOpen, rows: visibleRows });
    if (renderSignature !== renderedOrdersSignature) {
      root.innerHTML = visibleRows.map(renderOrder).join('') || `<div class="empty-state">${filteredEmpty}</div>`;
      renderedOrdersSignature = renderSignature;
      hasRenderedOrders = true;
    }
    root.classList.remove('is-stale');
    if (orderView === 'current') rows.filter((order) => new Date(order.created_at).getTime() >= ordersConsoleStartedAt - 15 * 60 * 1000).forEach(autoPrintOrder);
    const clearButton = document.getElementById('clear-order-search');
    const searchStatus = document.getElementById('order-search-status');
    if (clearButton) clearButton.hidden = !query;
    if (searchStatus) searchStatus.textContent = query ? `${visibleRows.length} matching order${visibleRows.length === 1 ? '' : 's'}` : orderView === 'history' ? `History · ${date || 'choose a date'}` : sessionOpen ? `${visibleRows.length} ${orderStatusFilter === 'all' ? 'current' : orderStatusFilter} order${visibleRows.length === 1 ? '' : 's'}` : 'Session closed · orders archived';
  } catch (error) {
    if (!hasRenderedOrders) {
      root.innerHTML = `<div class="empty-state">${esc(error.message)}</div>`;
      renderedOrdersSignature = '';
    } else {
      root.classList.add('is-stale');
      updateConnectivity('Connection problem — showing the last loaded orders.');
    }
    if (navigator.onLine) reportOrdersDiagnostic({ message:`Live orders refresh failed: ${error.message}`, source:'live orders refresh' });
  } finally { ordersRefreshInFlight = false; }
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
  try {
    const bridgeResponse = await fetch('http://127.0.0.1:9124/v1/printers', { cache:'no-store' });
    if (!bridgeResponse.ok) throw new Error('Print Bridge is not available on this computer.');
    const operationsResponse = await fetch('/api/orders/operations', { cache:'no-store' });
    const operations = await operationsResponse.json();
    if (!operationsResponse.ok) throw new Error(operations.error || 'Printer configuration could not load.');
    const billPrinter = (operations.config?.printers || []).find((printer) => printer.type === 'bill' && printer.deviceName);
    if (!billPrinter) throw new Error('No Bill printer is configured.');
    const receiptResponse = await fetch(`/api/orders/${encodeURIComponent(id)}/print`, { cache:'no-store' });
    const receipt = await receiptResponse.json();
    if (!receiptResponse.ok) throw new Error(receipt.error || 'Unable to prepare the receipt.');
    const printed = await fetch('http://127.0.0.1:9124/v1/print-bill', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ printerName:billPrinter.deviceName, order:receipt }) });
    if (!printed.ok) throw new Error((await printed.json().catch(() => ({}))).error || 'Bill printer did not accept the job.');
    return;
  } catch (error) {
    reportOrdersDiagnostic({ level:'warning', message:`Direct bill reprint failed: ${error.message}`, source:'manual bill printing' });
  }
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
    const walletDiscount = Math.max(0, Math.floor(Number(order.loyalty_points_redeemed || 0)));
    const dailyNumber = Number(order.daily_order_number);
    const token = Number.isFinite(dailyNumber) && dailyNumber > 0 ? String(dailyNumber).padStart(2, '0') : '—';
    const placedAt = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true }).format(new Date(order.created_at));
    const orderType = fulfillmentLabel(order);
    const itemRows = items.map((item) => {
      const label = `${item.name || 'Item'}${item.portion ? ` (${item.portion})` : ''}${item.style ? ` — ${item.style}` : ''}`;
      const qty = Number(item.quantity || 0);
      return `<tr><td class="item-name">${esc(label)}</td><td>${qty}</td><td>${money(itemPrice(item))}</td><td>${money(qty * itemPrice(item))}</td></tr>`;
    }).join('');
    popup.document.open();
    popup.document.write(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Red Lantern · Token ${esc(token)}</title><style>@page{size:80mm auto;margin:4mm}*{box-sizing:border-box}body{width:72mm;margin:0;color:#111;font:12px Arial,sans-serif}.center{text-align:center}.restaurant{font-size:18px;font-weight:800;letter-spacing:.2px}.sub{margin:3px 0;color:#333}.rule{border:0;border-top:1px dashed #222;margin:10px 0}.wallet{padding:7px 0;font-weight:700}.details{line-height:1.55}.details b{display:inline-block;min-width:68px}table{width:100%;border-collapse:collapse;margin-top:8px;font-size:11px}th{padding:5px 0;border-bottom:1px solid #222;text-align:right;font-size:10px}th:first-child{text-align:left}td{padding:5px 0;vertical-align:top;text-align:right;border-bottom:1px dotted #bbb}.item-name{text-align:left;padding-right:5px}.totals{display:flex;justify-content:space-between;font-size:13px;font-weight:700}.grand{display:flex;justify-content:space-between;margin-top:6px;font-size:16px;font-weight:800}.note{margin-top:8px;font-size:10px;line-height:1.4}.footer{margin-top:14px;font-size:10px;text-align:center;color:#333}@media print{body{width:72mm}}</style></head><body><div class="center"><div class="restaurant">RED LANTERN RESTAURANT</div><div class="sub">Restaurant Mobile Number: 9922853605</div><div class="sub">Direct Order Receipt</div></div><hr class="rule"><div class="wallet">Wallet Points: ${Number(order.loyalty_points || 0)}</div><div class="details"><div><b>Name:</b> ${esc(order.customer_name || 'Not provided')}</div><div><b>Mobile:</b> ${esc(order.customer_phone || '—')}</div><div><b>Type:</b> ${esc(orderType)}</div><div><b>Token No:</b> ${esc(token)}</div><div><b>Placed:</b> ${esc(placedAt)}</div></div>${order.special_request ? `<div class="note"><b>Special request:</b> ${esc(order.special_request)}</div>` : ''}<hr class="rule"><table><thead><tr><th>Item</th><th>Qty</th><th>Price</th><th>Amount</th></tr></thead><tbody>${itemRows}</tbody></table><hr class="rule"><div class="totals"><span>Total Qty: ${quantity}</span><span>Items: ${items.length}</span></div><div class="totals"><span>Subtotal</span><span>${money(calculatedTotal)}</span></div>${walletDiscount ? `<div class="totals"><span>Wallet points discount</span><span>−${money(walletDiscount)}</span></div>` : ''}<div class="grand"><span>GRAND TOTAL</span><span>${money(grandTotal)}</span></div><hr class="rule"><div class="footer">Thank you for ordering with us!<br>Red Lantern Restaurant</div><script>window.onload=()=>setTimeout(()=>window.print(),150);window.onafterprint=()=>window.close();<\/script></body></html>`);
    popup.document.close();
  } catch (error) {
    popup.close();
    alert(error.message || 'Unable to prepare this receipt.');
  }
}

const operationId = () => `op_${Date.now().toString(36)}${Math.random().toString(36).slice(2,7)}`;
const operationItemOptions = (item) => {
  const options = [];
  if (String(item.withBonePrice || '').trim()) options.push({ label: 'With Bone', portion: 'With Bone' });
  if (String(item.bonelessPrice || '').trim()) options.push({ label: 'Boneless', portion: 'Boneless' });
  return options;
};
const routePrinters = (item) => {
  const printers = new Map(operationsConfig.printers.map((printer) => [printer.id, printer]));
  const routes = operationsConfig.routes.filter((route) => printers.get(route.printerId)?.type === 'kot');
  return [...new Map(routes.filter((route) => route.category === '*' ? !route.itemName && !route.portion : route.category === item.category && ((!route.itemName && !route.portion) || (route.itemName === item.name && (!route.portion || route.portion === item.portion)))).map((route) => [route.printerId, printers.get(route.printerId)])).values()].filter(Boolean);
};
const routePrinter = (item) => routePrinters(item)[0] || null;
const selectedRouteCategories = () => [...document.querySelectorAll('.operation-route-category-check:checked')].map((input) => input.value);
function refreshRouteItemOptions() {
  const itemSelect = document.getElementById('operation-route-item');
  if (!itemSelect) return;
  const selected = selectedRouteCategories();
  if (selected.length !== 1) {
    itemSelect.disabled = true;
    itemSelect.innerHTML = `<option value="">${selected.length ? 'Choose one category for an item override' : 'Select a category first'}</option>`;
    return;
  }
  const category = selected[0];
  itemSelect.disabled = false;
  itemSelect.innerHTML = `<option value="">All selected categories</option>${operationsMenu.filter((item) => item.category === category).sort((a,b)=>a.name.localeCompare(b.name)).map((item) => `<option value="${esc(item.name)}">${esc(item.name)}</option>`).join('')}`;
}
function assignedKinds(printer) {
  const kinds = [];
  if (printer.type === 'bill') kinds.push('Bill');
  if (operationsConfig.routes.some((route) => route.printerId === printer.id)) kinds.push('KOT');
  return kinds;
}
function renderPrinterManagement() {
  const content = document.getElementById('operations-content');
  if (!content) return;
  const printer = operationsConfig.printers.find((item) => item.id === assignmentPrinterId);
  const categories = [...new Set(operationsMenu.map((item) => item.category).filter(Boolean))].sort();
  if (printer && assignmentMode) {
    const selected = new Set(operationsConfig.routes.filter((route) => route.printerId === printer.id && !route.itemName).map((route) => route.category));
    const selectedItems = new Set(operationsConfig.routes.filter((route) => route.printerId === printer.id && route.itemName).map((route) => `${route.category}::${route.itemName}::${route.portion || ''}`));
    content.innerHTML = assignmentMode === 'choose'
      ? `<section class="printer-assignment"><button type="button" class="assignment-back" data-assignment-back>‹ Back</button><h3>Assign printer · ${esc(printer.name)}</h3><p>Choose how this installed printer will be used.</p><div class="assignment-choices"><button type="button" data-assign-bill><b>▤ Assign to Bill</b><span>Customer receipts and bills</span></button><button type="button" data-assign-kot><b>⌑ Assign to KOT</b><span>Kitchen order tickets</span></button></div></section>`
      : `<section class="printer-assignment"><button type="button" class="assignment-back" data-assignment-back>‹ Back</button><h3>Assign KOT routing · ${esc(printer.name)}</h3><p>Assign whole categories, or expand a category and select only the dishes that belong on this station. Bone-in and boneless options can be routed separately.</p><label class="assignment-all-categories"><input type="checkbox" data-assignment-all-categories ${selected.has('*') ? 'checked' : ''}><span><b>All categories</b><small>Send every current and future menu category to this printer.</small></span></label><div class="assignment-category-grid">${categories.map((category) => { const items=operationsMenu.filter((item)=>item.category===category).sort((a,b)=>a.name.localeCompare(b.name)); return `<details class="assignment-category-card"><summary><label><input type="checkbox" data-assignment-category value="${esc(category)}" ${selected.has(category) ? 'checked' : ''}><span>${esc(category)}</span></label><i aria-hidden="true">⌄</i></summary><div class="assignment-item-list"><b>Individual dishes</b>${items.map((item)=>{const variants=operationItemOptions(item); const allKey=`${category}::${item.name}::`; return variants.length ? `<div class="assignment-dish"><label><input type="checkbox" data-assignment-item data-category="${esc(category)}" value="${esc(item.name)}" ${selectedItems.has(allKey) ? 'checked' : ''}><span>${esc(item.name)} <small>all options</small></span></label><div class="assignment-variants">${variants.map((variant)=>`<label><input type="checkbox" data-assignment-item data-category="${esc(category)}" data-portion="${esc(variant.portion)}" value="${esc(item.name)}" ${selectedItems.has(`${category}::${item.name}::${variant.portion}`) ? 'checked' : ''}><span>${esc(variant.label)}</span></label>`).join('')}</div></div>` : `<label><input type="checkbox" data-assignment-item data-category="${esc(category)}" value="${esc(item.name)}" ${selectedItems.has(allKey) ? 'checked' : ''}><span>${esc(item.name)}</span></label>`;}).join('') || '<small>No dishes in this category yet.</small>'}</div></details>`; }).join('')}</div><div class="assignment-actions"><button type="button" data-assignment-back>Cancel</button><button type="button" class="operations-save" data-save-kot-assignment>Save KOT routing</button></div></section>`;
    return;
  }
  const bridgeText = printBridgeState === 'available' ? 'Print Bridge is running — installed printers are available.' : 'Print Bridge is not detected on this computer.';
  content.innerHTML = `<section class="manage-printers"><div class="manage-printers-head"><div><span class="eyebrow">Printer setup</span><h3>Manage printers</h3><p>Connect each installed printer once, then choose whether it handles bills or specific kitchen categories.</p></div><span class="bridge-status ${printBridgeState === 'available' ? 'online' : ''}">${bridgeText}</span></div><div class="add-system-printer"><div class="add-printer-copy"><b>Add an installed printer</b><span>Choose a printer already available on this Windows computer.</span></div><select id="quick-system-printer"><option value="">Choose installed printer</option>${installedSystemPrinters.map((item) => `<option value="${esc(item.id)}">${esc(item.name)}</option>`).join('')}</select><button type="button" id="quick-add-printer">＋ Add printer</button></div><div class="printer-card-list">${operationsConfig.printers.map((item) => { const kinds=assignedKinds(item); const routes=operationsConfig.routes.filter((route)=>route.printerId===item.id); const allCategories=routes.some((route)=>route.category==='*'&&!route.itemName); const categories=[...new Set(routes.filter((route)=>route.category!=='*'&&!route.itemName).map((route)=>route.category))]; const overrides=routes.filter((route)=>route.itemName); const overrideNames=overrides.map((route)=>`${route.itemName}${route.portion ? ` — ${route.portion}` : ' · all options'}`); const assignment=allCategories ? 'All categories' : [categories.length ? `${categories.length} categor${categories.length===1?'y':'ies'}` : '', overrides.length ? `${overrides.length} selected dish${overrides.length===1?'':'es'}` : ''].filter(Boolean).join(' · ') || 'Not assigned yet'; const summary=allCategories ? 'Receives every current and future menu category.' : [...categories, ...overrideNames].join(' · '); return `<article class="printer-card"><div class="printer-card-top"><span class="printer-card-mark ${item.type==='bill'?'is-bill':''}" aria-hidden="true">${item.type==='bill'?'▤':'⌑'}</span><div><span class="printer-card-label">${item.type==='bill'?'Bill printer':'KOT printer'}</span><h4>${esc(item.name)}</h4><p>${esc(item.deviceName || 'System printer not assigned')}</p></div><span class="printer-card-state ${kinds.length?'is-ready':''}">${kinds.length?'Configured':'Needs assignment'}</span></div><div class="printer-routing-summary"><b>${esc(assignment)}</b><span>${esc(summary || 'Choose Bill or KOT categories to complete setup.')}</span></div><div class="printer-card-actions"><button type="button" data-assign-printer="${esc(item.id)}">Configure routing</button><button type="button" class="remove-printer" data-delete-printer="${esc(item.id)}">Remove</button></div></article>`; }).join('') || '<div class="operations-empty">Choose an installed printer above to begin.</div>'}</div></section>`;
  content.querySelectorAll('.printer-card').forEach((card, index) => {
    const configured = operationsConfig.printers[index];
    if (configured?.type !== 'bill') return;
    const title = card.querySelector('.printer-routing-summary b');
    const description = card.querySelector('.printer-routing-summary span');
    if (title) title.textContent = 'Final bill printing enabled';
    if (description) description.textContent = configured.deviceName ? `All final customer bills print on ${configured.deviceName}.` : 'Choose an installed system printer to enable final bill printing.';
  });
}
function refreshBillPrinterSummary() {
  document.querySelectorAll('.printer-card').forEach((card, index) => {
    const printer = operationsConfig.printers[index];
    if (printer?.type !== 'bill') return;
    const summary = card.querySelector('.printer-routing-summary');
    if (!summary) return;
    const title = summary.querySelector('b');
    const description = summary.querySelector('span');
    if (title) title.textContent = 'Final bill printing enabled';
    if (description) description.textContent = printer.deviceName ? `All final customer bills print on ${printer.deviceName}.` : 'Choose an installed system printer to enable final bill printing.';
  });
}
function renderOperations() {
  const content = document.getElementById('operations-content');
  if (!content) return;
  if (operationsTab === 'home') {
    const activeOrders = [...orderRecords.values()].filter((order) => !['completed','rejected','cancelled'].includes(order.status));
    content.innerHTML = `<section class="operations-home"><div class="operations-home-title"><span class="eyebrow">Operations</span><h3>Orders &amp; printing</h3><p>Open a workspace to manage the restaurant’s live order flow.</p></div><div class="operations-home-grid"><button type="button" class="operations-home-card" data-operations-tab="kots"><span class="operations-home-icon" aria-hidden="true">⌑</span><span><b>KOTs</b><small>${activeOrders.length} active order${activeOrders.length===1?'':'s'} · View and print kitchen tickets</small></span><i aria-hidden="true">›</i></button><button type="button" class="operations-home-card" data-operations-tab="printers"><span class="operations-home-icon" aria-hidden="true">▣</span><span><b>Printer routing</b><small>${operationsConfig.printers.length} printer${operationsConfig.printers.length===1?'':'s'} · Configure kitchen and bill printing</small></span><i aria-hidden="true">›</i></button></div></section>`;
    return;
  }
  if (operationsTab === 'kots') {
    const activeOrders = [...orderRecords.values()].filter((order) => !['completed','rejected','cancelled'].includes(order.status));
    const tickets = new Map();
    activeOrders.forEach((order) => (Array.isArray(order.items) ? order.items : []).forEach((item) => {
      const printers = routePrinters(item);
      (printers.length ? printers : [null]).forEach((printer) => { const key = `${order.id}::${printer?.id || 'unassigned'}`; if (!tickets.has(key)) tickets.set(key, { order, printer, items: [] }); tickets.get(key).items.push(item); });
    }));
    content.innerHTML = `<section class="kot-listing"><div class="kot-listing-head"><div><button type="button" class="assignment-back" data-operations-tab="home">‹ Back</button><h3>KOT listing</h3><p>Live kitchen tickets grouped by their assigned printer. KOT number is the primary kitchen reference.</p></div><span class="operations-count">${tickets.size} live ticket${tickets.size===1?'':'s'}</span></div><div class="kot-table-wrap"><table class="kot-table"><thead><tr><th>KOT no.</th><th>Order no.</th><th>Order type</th><th>Customer</th><th>Items</th><th>Created</th><th>Elapsed</th><th>Printer</th><th>Status</th><th>Action</th></tr></thead><tbody>${[...tickets.values()].map((ticket) => { const orderNumber=String(ticket.order.daily_order_number||'—').padStart(2,'0'); const type=fulfillmentLabel(ticket.order); const history=Array.isArray(operationKotHistory.get(ticket.order.id))?operationKotHistory.get(ticket.order.id):[]; const savedKot=history.find((entry)=>Array.isArray(entry.tickets)&&entry.tickets.some((savedTicket)=>savedTicket.printerLabel===ticket.printer?.name)) || history[0]; const createdAt=savedKot?.created_at || ticket.order.created_at; const elapsedMinutes=createdAt?Math.max(0,Math.floor((Date.now()-new Date(createdAt).getTime())/60000)):null; const elapsed=elapsedMinutes===null?'—':elapsedMinutes<60?`${elapsedMinutes} min`:`${Math.floor(elapsedMinutes/60)} hr ${elapsedMinutes%60} min`; return `<tr><td><b class="kot-number">${savedKot?.kot_number ? `#${esc(savedKot.kot_number)}` : '—'}</b><small>${savedKot ? 'Printed KOT' : 'Not printed yet'}</small></td><td><b>#${esc(orderNumber)}</b></td><td>${type}</td><td><b>${esc(ticket.order.customer_name || 'Guest')}</b><small>${esc(ticket.order.customer_phone || '—')}</small></td><td>${ticket.items.map((item)=>`<span>${Number(item.quantity||0)}× ${esc(item.name)}${item.portion?` · ${esc(item.portion)}`:''}</span>`).join('')}</td><td>${createdAt ? new Date(createdAt).toLocaleString('en-IN',{dateStyle:'medium',timeStyle:'short'}) : '—'}</td><td><b>${elapsed}</b></td><td><span class="printer-type kot">${esc(ticket.printer?.name || 'Unassigned')}</span></td><td><span class="kot-status">${esc(ticket.order.status || 'new')}</span></td><td><button type="button" class="kot-print-action" data-print-kot="${esc(ticket.order.id)}" data-printer-id="${esc(ticket.printer?.id || '')}">${savedKot ? 'Reprint KOT' : 'Print KOT'}</button></td></tr>`; }).join('') || '<tr><td colspan="10" class="kot-table-empty">No live KOTs right now. New and active orders will appear here.</td></tr>'}</tbody></table></div></section>`;
  } else {
    renderPrinterManagement();
    refreshBillPrinterSummary();
    return;
    const kotPrinters = operationsConfig.printers.filter((printer) => printer.type === 'kot');
    const categories = [...new Set(operationsMenu.map((item) => item.category).filter(Boolean))].sort();
    const printerOptions = kotPrinters.map((printer) => `<option value="${esc(printer.id)}">${esc(printer.name)}</option>`).join('');
    content.innerHTML = `<section class="operations-section"><div class="operations-section-head"><div><span class="eyebrow">Step 1</span><h3>Printers</h3><p>Create every printer used by your restaurant. You can add as many KOT and Bill printers as needed.</p></div><span class="operations-count">${operationsConfig.printers.length} configured</span></div><div class="operations-printer-form"><label>Printer name<input id="operation-printer-name" maxlength="60" placeholder="e.g. Tandoori Printer"></label><label>Printer type<select id="operation-printer-type"><option value="kot">KOT printer</option><option value="bill">Bill printer</option></select></label><button type="button" id="operation-add-printer"><span aria-hidden="true">＋</span> Add printer</button></div><div class="operations-grid printer-grid">${operationsConfig.printers.map((printer) => `<article class="operation-printer"><div class="operation-printer-head"><span class="printer-card-icon ${esc(printer.type)}" aria-hidden="true">${printer.type === 'bill' ? '▣' : '⌑'}</span><div><h3>${esc(printer.name)}</h3><p>${printer.type === 'bill' ? 'Counter / bill receipt printer' : 'Kitchen order ticket printer'}</p></div><span class="printer-type ${esc(printer.type)}">${esc(printer.type)}</span></div><button type="button" data-delete-printer="${esc(printer.id)}">Remove</button></article>`).join('') || '<div class="operations-empty">Add your first printer to start routing KOTs.</div>'}</div></section><section class="operations-section routing-section"><div class="operations-section-head"><div><span class="eyebrow">Step 2</span><h3>KOT routing</h3><p>Select every category this printer should receive. Use the item override only for a single-item exception.</p></div><span class="operations-count">${operationsConfig.routes.length} rules</span></div><div class="operations-route-form"><label>Send to printer<select id="operation-route-printer"><option value="">Choose KOT printer</option>${printerOptions}</select></label><div class="category-picker"><div class="category-picker-top"><b>Categories for this printer</b><span id="route-category-count">0 selected</span></div><input id="operation-route-category-search" class="category-search" type="search" placeholder="Search categories"><div id="operation-route-categories" class="category-checklist">${categories.map((category) => `<label class="category-choice"><input class="operation-route-category-check" type="checkbox" value="${esc(category)}"><span>${esc(category)}</span></label>`).join('')}</div></div><label>Specific item <select id="operation-route-item" disabled><option value="">Select one category first</option></select></label><button type="button" id="operation-add-route">Add selected routes</button></div><div class="routing-list">${operationsConfig.routes.map((route) => { const printer=operationsConfig.printers.find((item)=>item.id===route.printerId); return `<div class="route-row"><span class="route-icon" aria-hidden="true">⌑</span><div><b>${esc(route.category)}${route.itemName ? ` · ${esc(route.itemName)}` : ' · all items'}</b><span>Print on ${esc(printer?.name || 'Missing printer')}</span></div><button type="button" data-delete-route="${esc(route.id)}">Remove</button></div>`; }).join('') || '<div class="operations-empty">No KOT routes yet. Select one or more categories above to set up routing.</div>'}</div></section><div class="operations-save-bar"><span>Changes are saved only when you confirm.</span><button type="button" id="operations-save" class="operations-save">Save printer configuration</button></div>`;
    const printerForm = document.querySelector('.operations-printer-form');
    const addPrinterButton = document.getElementById('operation-add-printer');
    if (printerForm && addPrinterButton) {
      const setupFlow = document.createElement('div');
      setupFlow.className = 'printer-setup-flow';
      const isMac = /macintosh|mac os x/i.test(navigator.userAgent);
      const bridgeCommand = isMac ? 'bash ./install-print-bridge-macos.sh' : 'powershell -ExecutionPolicy Bypass -File .\\install-print-bridge-windows.ps1';
      const bridgeLabel = printBridgeState === 'available' ? 'Print Bridge is running on this computer.' : 'Print Bridge is not running on this computer.';
      setupFlow.innerHTML = `<i aria-hidden="true">▣</i><div><b>Add a restaurant printer</b><span>Give it a clear role, select its installed system printer, then assign its menu categories in Step 2.</span></div><div class="bridge-setup"><b>${bridgeLabel}</b><span>One-time setup on every computer that has printers. Open Terminal / PowerShell in the website folder, then run:</span><code>${esc(bridgeCommand)}</code><button type="button" id="copy-print-bridge-command" data-command="${esc(bridgeCommand)}">Copy setup command</button></div>`;
      printerForm.before(setupFlow);
      const deviceField = document.createElement('label');
      const bridgeMessage = printBridgeState === 'checking' ? 'Detecting installed printers…' : printBridgeState === 'offline' ? 'Print Bridge not detected' : 'Choose installed printer';
      deviceField.innerHTML = `Installed system printer<select id="operation-printer-device"><option value="">${bridgeMessage}</option>${installedSystemPrinters.map((printer) => `<option value="${esc(printer.id)}">${esc(printer.name)}</option>`).join('')}</select>`;
      printerForm.insertBefore(deviceField, addPrinterButton);
    }
    document.querySelectorAll('.operation-printer').forEach((card, index) => {
      const printer = operationsConfig.printers[index];
      if (!printer) return;
      const endpoint = document.createElement('p');
      endpoint.className = `printer-endpoint${printer.deviceName ? '' : ' is-pending'}`;
      endpoint.textContent = printer.deviceName ? `System printer · ${printer.deviceName}` : 'System printer to be assigned during installation';
      card.querySelector('.operation-printer-head')?.after(endpoint);
    });
    const routeForm = document.querySelector('.operations-route-form');
    const categoryPicker = routeForm?.querySelector('.category-picker');
    const printerControl = document.getElementById('operation-route-printer')?.closest('label');
    const itemControl = document.getElementById('operation-route-item')?.closest('label');
    const addRouteButton = document.getElementById('operation-add-route');
    if (routeForm && categoryPicker && printerControl && itemControl && addRouteButton) {
      const controls = document.createElement('div');
      controls.className = 'route-side-controls';
      controls.append(printerControl, itemControl, addRouteButton);
      routeForm.prepend(controls);

      const assignedCategoryCount = new Set(operationsConfig.routes.filter((route) => route.category !== '*' && !route.itemName).map((route) => route.category)).size;
      const assignedItemCount = operationsConfig.routes.filter((route) => route.itemName).length;
      const allRoute = operationsConfig.routes.find((route) => route.category === '*' && !route.itemName);
      categoryPicker.insertAdjacentHTML('afterbegin', `<label class="all-categories-choice"><input id="operation-route-all-categories" type="checkbox" ${allRoute ? 'checked' : ''}><span><b>All categories</b><small>${allRoute ? `Assigned to ${esc(operationsConfig.printers.find((printer) => printer.id === allRoute.printerId)?.name || 'a KOT printer')}` : `${assignedCategoryCount} categories assigned · ${assignedItemCount} item overrides`}</small></span><em>⌄</em></label><p class="all-categories-help">Use this only when one station should receive every current and future category. Category or item rules still take priority.</p>`);
      if (allRoute) document.querySelectorAll('.operation-route-category-check, .operation-route-item-check').forEach((input) => { input.disabled = true; input.checked = false; });
      document.querySelectorAll('.category-choice').forEach((choice) => {
        const category = choice.querySelector('input')?.value || '';
        const items = operationsMenu.filter((item) => item.category === category).sort((a, b) => a.name.localeCompare(b.name));
        const assigned = operationsConfig.routes.filter((route) => route.category === category);
        const preview = document.createElement('div');
        preview.className = 'category-item-preview';
        preview.hidden = true;
        preview.innerHTML = `<div><b>Select individual dishes</b><span>${assigned.length ? `${assigned.length} routing rule${assigned.length === 1 ? '' : 's'} saved` : `${items.length} menu item${items.length === 1 ? '' : 's'}`}</span></div>${items.map((item) => `<label class="category-item-choice"><input class="operation-route-item-check" type="checkbox" value="${esc(item.name)}" data-category="${esc(category)}"><span>${esc(item.name)}</span></label>`).join('') || '<span>No menu items yet</span>'}`;
        const toggle = document.createElement('button');
        toggle.type = 'button'; toggle.className = 'category-expand'; toggle.dataset.routeCategoryExpand = category; toggle.setAttribute('aria-label', `Show ${category} items`); toggle.textContent = '⌄';
        choice.append(toggle); choice.after(preview);
      });
    }
    const saveStatus = document.querySelector('.operations-save-bar span');
    if (saveStatus) {
      saveStatus.textContent = printBridgeConfigState === 'synced'
        ? 'Saved securely in the cloud and on this restaurant computer.'
        : printBridgeConfigState === 'waiting-for-bridge'
          ? 'Saved securely in the cloud. The local offline copy will sync when Print Bridge is running.'
          : 'Save once. The local Print Bridge will retain this routing for offline use.';
    }
  }
}
async function loadOperations() {
  const response = await fetch('/api/orders/operations', { cache:'no-store' });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Unable to load Operations.');
  operationsConfig = data.config || { printers:[], routes:[] };
  operationsMenu = Array.isArray(data.menu) ? data.menu : [];
  const activeOrders = [...orderRecords.values()].filter((order) => !['completed','rejected','cancelled'].includes(order.status));
  const histories = await Promise.all(activeOrders.map(async (order) => {
    try {
      const historyResponse = await fetch(`/api/orders/${encodeURIComponent(order.id)}/kots`, { cache:'no-store' });
      return [order.id, historyResponse.ok ? await historyResponse.json() : []];
    } catch (_) { return [order.id, []]; }
  }));
  operationKotHistory = new Map(histories);
  renderOperations();
}
async function discoverSystemPrinters() {
  printBridgeState = 'checking';
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2200);
    const response = await fetch('http://127.0.0.1:9124/v1/printers', { cache:'no-store', signal:controller.signal });
    clearTimeout(timer);
    const body = await response.json();
    if (!response.ok || !Array.isArray(body.printers)) throw new Error('Print Bridge did not return installed printers.');
    installedSystemPrinters = body.printers.map((printer) => ({ id:String(printer.id || printer.name || ''), name:String(printer.name || '') })).filter((printer) => printer.id && printer.name);
    printBridgeState = 'available';
  } catch (_) {
    installedSystemPrinters = [];
    printBridgeState = 'offline';
  }
}
async function syncOperationsToPrintBridge(config) {
  if (printBridgeState !== 'available') { printBridgeConfigState = 'waiting-for-bridge'; return false; }
  try {
    const response = await fetch('http://127.0.0.1:9124/v1/config', { method:'PUT', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ config }) });
    if (!response.ok) throw new Error('Bridge sync failed.');
    printBridgeConfigState = 'synced';
    return true;
  } catch (_) {
    printBridgeConfigState = 'waiting-for-bridge';
    return false;
  }
}
async function saveOperations() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  let response;
  try {
    response = await fetch('/api/orders/operations', { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ config:operationsConfig }), signal:controller.signal });
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('Saving took too long. Check the internet connection, then try again.');
    throw new Error('Unable to reach the server. Check the internet connection, then try again.');
  } finally { clearTimeout(timeout); }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Unable to save printer configuration.');
  operationsConfig = data.config;
  await syncOperationsToPrintBridge(operationsConfig);
  renderOperations();
}
function addSelectedRoutes() {
  const printerId=String(document.getElementById('operation-route-printer')?.value||'');
  const categories=selectedRouteCategories();
  const itemName=String(document.getElementById('operation-route-item')?.value||'');
  const selectedItems=[...document.querySelectorAll('.operation-route-item-check:checked')].map((input)=>({ category:String(input.dataset.category||''), itemName:String(input.value||'') })).filter((item)=>item.category&&item.itemName);
  const allCategories=!!document.getElementById('operation-route-all-categories')?.checked;
  if (!categories.length && !selectedItems.length && !allCategories) return false;
  if (!printerId) throw new Error('Choose a KOT printer before saving these categories.');
  if (allCategories) {
    operationsConfig.routes = operationsConfig.routes.filter((route) => !(route.category === '*' && !route.itemName));
    operationsConfig.routes.push({ id: operationId(), printerId, category: '*', itemName: '' });
    return true;
  }
  if (itemName && categories.length !== 1) throw new Error('Choose exactly one category to route a specific item.');
  categories.forEach((category) => {
    const duplicate=operationsConfig.routes.some((route)=>route.printerId===printerId&&route.category===category&&route.itemName===itemName);
    if (!duplicate) operationsConfig.routes.push({ id:operationId(), printerId, category, itemName });
  });
  selectedItems.forEach(({ category, itemName: selectedItemName }) => {
    const duplicate=operationsConfig.routes.some((route)=>route.printerId===printerId&&route.category===category&&route.itemName===selectedItemName);
    if (!duplicate) operationsConfig.routes.push({ id:operationId(), printerId, category, itemName:selectedItemName });
  });
  return true;
}
function printKot(orderId, printerId) {
  const order = orderRecords.get(orderId);
  if (!order) return;
  const printer = operationsConfig.printers.find((item) => item.id === printerId);
  const items = (Array.isArray(order.items) ? order.items : []).filter((item) => routePrinters(item).some((route) => route.id === (printerId || '')));
  if (!items.length) return;
  const popup = window.open('', 'red-lantern-kot', 'popup=yes,width=390,height=600');
  if (!popup) { alert('Please allow pop-ups to print this KOT.'); return; }
  const number=String(order.daily_order_number||'—').padStart(2,'0');
  popup.document.write(`<!doctype html><title>KOT #${esc(number)}</title><style>@page{size:80mm auto;margin:4mm}body{width:72mm;margin:0;font:12px Arial;color:#111}.center{text-align:center}.name{font-size:17px;font-weight:800}.rule{border:0;border-top:1px dashed #111;margin:9px 0}.item{padding:5px 0;font-size:13px}.item b{font-size:15px}small{color:#444}</style><div class="center"><div class="name">RED LANTERN RESTAURANT</div><b>KITCHEN ORDER TICKET</b><br><small>${esc(printer?.name || 'Unassigned')}</small></div><hr class="rule"><b>Token No: ${esc(number)}</b><br><small>${esc(order.customer_name || 'Guest')} · ${esc(fulfillmentLabel(order))}</small><hr class="rule">${items.map((item)=>`<div class="item"><b>${Number(item.quantity||0)}×</b> ${esc(item.name)}${item.portion?` (${esc(item.portion)})`:''}${item.style?` · ${esc(item.style)}`:''}</div>`).join('')}${order.special_request?`<hr class="rule"><b>Note:</b> ${esc(order.special_request)}`:''}<hr class="rule"><div class="center"><small>Order #${esc(number)}</small></div><script>window.onload=()=>setTimeout(()=>window.print(),120);window.onafterprint=()=>window.close();<\/script>`);
  popup.document.close();
}

async function dispatchKot(orderId, printerId) {
  const created=await fetch(`/api/orders/${encodeURIComponent(orderId)}/kots`, { method:'POST' }); const data=await created.json(); if (!created.ok) { if (data.latestKot && confirm(`No new items. Reprint KOT #${data.latestKot.kot_number}?`)) { data.kotNumber=data.latestKot.kot_number; data.tickets=data.latestKot.tickets; data.order=data.order; data.reprint=true; } else throw new Error(data.error || 'Unable to create KOT.'); } if (data.reused) throw new Error(`KOT #${data.kotNumber} was already sent. Use Reprint if another copy is needed.`);
  await Promise.all(data.tickets.map(async (ticket) => { const response=await fetch('http://127.0.0.1:9124/v1/print-kot',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({printerName:ticket.printerName,items:ticket.items,order:{number:data.order.daily_order_number, kotNumber:data.kotNumber, reprint:!!data.reprint, customer:data.order.customer_name, phone:data.order.customer_phone, fulfillment:fulfillmentLabel(data.order),note:data.order.special_request}})}); const body=await response.json().catch(()=>({})); if(!response.ok) throw new Error(body.error||'The Print Bridge could not send this KOT.'); }));
}

const autoPrintInFlight = new Set();
async function autoPrintOrder(order) {
  const canReleaseToKitchen = order?.mode === 'counter' || order?.status === 'accepted';
  if (!order?.id || !canReleaseToKitchen || autoPrintInFlight.has(order.id) || ['completed','rejected','cancelled'].includes(order.status)) return { ok:false, reason:'This order is not ready to print yet.' };
  autoPrintInFlight.add(order.id);
  try {
    const bridge = await fetch('http://127.0.0.1:9124/v1/printers', { cache:'no-store' });
    if (!bridge.ok) { const reason='Print Bridge is not available on this counter computer.'; reportOrdersDiagnostic({ level:'warning', message:`Automatic printing skipped: ${reason}`, source:'automatic order printing' }); return { ok:false, reason }; }
    const operationsResponse = await fetch('/api/orders/operations', { cache:'no-store' });
    const operations = await operationsResponse.json();
    if (!operationsResponse.ok) throw new Error(operations.error || 'Printer configuration could not load.');
    const printers = Array.isArray(operations.config?.printers) ? operations.config.printers : [];
    try {
      const created = await fetch(`/api/orders/${encodeURIComponent(order.id)}/kots`, { method:'POST' });
      const kot = await created.json().catch(() => ({}));
      if (created.ok && !kot.reused) await Promise.all((kot.tickets || []).map(async (ticket) => {
        const response = await fetch('http://127.0.0.1:9124/v1/print-kot', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ printerName:ticket.printerName, items:ticket.items, order:{ number:kot.order?.daily_order_number, kotNumber:kot.kotNumber, customer:kot.order?.customer_name, phone:kot.order?.customer_phone, fulfillment:fulfillmentLabel(kot.order), note:kot.order?.special_request } }) });
        if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || 'KOT printer did not accept the job.');
      }));
      if (!created.ok && created.status !== 409) throw new Error(kot.error || 'Unable to create the automatic KOT.');
    } catch (error) {
      reportOrdersDiagnostic({ level:'warning', message:`Automatic KOT printing failed: ${error.message}`, source:'automatic KOT printing' });
    }
    const billPrinter = printers.find((printer) => printer.type === 'bill' && printer.deviceName);
    if (!billPrinter) { const reason='No Bill printer is assigned in Operations.'; reportOrdersDiagnostic({ level:'warning', message:`Automatic bill printing skipped: ${reason}`, source:'automatic bill printing' }); return { ok:false, reason }; }
    const claimResponse = await fetch(`/api/orders/${encodeURIComponent(order.id)}/bill-print/claim`, { method:'POST' });
    const claim = await claimResponse.json().catch(() => ({}));
    if (!claimResponse.ok || !claim.claimed) return;
    try {
      const receiptResponse = await fetch(`/api/orders/${encodeURIComponent(order.id)}/print`, { cache:'no-store' });
      const receipt = await receiptResponse.json();
      if (!receiptResponse.ok) throw new Error(receipt.error || 'Unable to prepare the receipt.');
      const printed = await fetch('http://127.0.0.1:9124/v1/print-bill', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ printerName:billPrinter.deviceName, order:receipt }) });
      if (!printed.ok) throw new Error((await printed.json().catch(() => ({}))).error || 'Bill printer did not accept the job.');
      await fetch(`/api/orders/${encodeURIComponent(order.id)}/bill-print/complete`, { method:'POST' });
      return { ok:true };
    } catch (error) {
      await fetch(`/api/orders/${encodeURIComponent(order.id)}/bill-print/failed`, { method:'POST' }).catch(() => {});
      throw error;
    }
  } catch (error) { const reason=error.message || 'Automatic printing failed.'; reportOrdersDiagnostic({ message:`Automatic printing failed: ${reason}`, source:'automatic order printing' }); return { ok:false, reason }; }
  finally { autoPrintInFlight.delete(order.id); }
}
const offlineMenuSnapshotKey = 'red-lantern-counter-menu-snapshot';
function saveOfflineMenuSnapshot(menu, availability) { try { localStorage.setItem(offlineMenuSnapshotKey, JSON.stringify({ menu, availability, savedAt:Date.now() })); } catch {} }
function readOfflineMenuSnapshot() { try { const snapshot=JSON.parse(localStorage.getItem(offlineMenuSnapshotKey) || 'null'); return Array.isArray(snapshot?.menu) && Array.isArray(snapshot?.availability) ? snapshot : null; } catch { return null; } }
async function loadAvailability() {
  try {
    const [menuResponse, availabilityResponse] = await Promise.all([fetch('/api/orders/menu', { cache: 'no-store' }), fetch('/api/orders/availability', { cache: 'no-store' })]);
    if (!menuResponse.ok || !availabilityResponse.ok) throw new Error('Menu availability could not be loaded.');
    const menu = await menuResponse.json(), availability = await availabilityResponse.json();
    if (!Array.isArray(menu) || !Array.isArray(availability)) throw new Error('Menu availability could not be read.');
    menuItems = menu;
    unavailable = new Map(availability.map((item) => [item.item_key, item.unavailable_until]));
    saveOfflineMenuSnapshot(menu, availability);
  } catch (error) {
    const snapshot = readOfflineMenuSnapshot();
    if (!snapshot) throw error;
    menuItems = snapshot.menu;
    unavailable = new Map(snapshot.availability.map((item) => [item.item_key, item.unavailable_until]));
  }
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
  if (isOpening) closeOpenPanels('availability');
  availability.hidden = !isOpening;
  document.getElementById('availability-toggle').setAttribute('aria-expanded', String(isOpening));
  if (isOpening) { try { await loadAvailability(); } catch (error) { menuResults.innerHTML = `<div class="empty-state">${esc(error.message)}</div>`; } }
});
liveOrdersToggle.addEventListener('click', () => {
  const isOpening = liveOrdersPanel.hidden;
  if (isOpening) closeOpenPanels('live');
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
document.getElementById('counter-order-close')?.addEventListener('click', () => { counterPanel.hidden = true; });
document.getElementById('counter-menu-search')?.addEventListener('input', renderCounterOrder);
document.getElementById('counter-customer-phone')?.addEventListener('input', () => { clearTimeout(counterLoyaltyTimer); counterLoyaltyTimer = setTimeout(loadCounterLoyalty, 300); });
document.getElementById('counter-wallet-redeem')?.addEventListener('input', (event) => { const value=Math.max(0,Math.floor(Number(event.target.value)||0)); event.target.value=String(value >= 100 ? Math.min(value,counterLoyaltyPoints) : 0); renderCounterOrder(); });
document.getElementById('counter-categories')?.addEventListener('click', (event) => {
  const button = event.target.closest('[data-counter-category]');
  if (!button) return;
  counterCategory = button.dataset.counterCategory || 'all'; renderCounterOrder();
});
document.getElementById('counter-menu-items')?.addEventListener('click', (event) => {
  const button = event.target.closest('[data-counter-item]');
  if (!button) return;
  const item = counterMenu[Number(button.dataset.counterItem)]; if (!item) return;
  const options = counterPortionOptions(item);
  if (options.length > 1 || item.gravyStyleAvailable) { openCounterChoice(item); return; }
  const [portion, , rawPrice] = options[0] || ['', 'Regular', 0];
  const price = Number(String(rawPrice).replace(/[^0-9.]/g, ''));
  if (!price) { document.getElementById('counter-order-status').textContent = 'This item has no price set in Menu Admin yet.'; return; }
  const existing = counterCart.find((line) => line.name === item.name && line.category === item.category && line.portion === portion && !line.style);
  if (existing) existing.quantity += 1;
  else counterCart.push({ name:item.name, category:item.category, portion, style:'', price, quantity:1 });
  renderCounterOrder();
});
document.getElementById('counter-choice-dialog')?.addEventListener('click', (event) => {
  if (event.target.closest('[data-counter-choice-close]')) { document.getElementById('counter-choice-dialog').close(); return; }
  if (!event.target.closest('#counter-choice-add') || !counterChoiceItem) return;
  const portionInput = document.querySelector('input[name="counter-portion"]:checked');
  const portion = portionInput?.value || '', price = Number(portionInput?.dataset.counterChoicePrice || 0);
  const style = document.querySelector('input[name="counter-style"]:checked')?.value || '';
  const existing = counterCart.find((line) => line.name === counterChoiceItem.name && line.category === counterChoiceItem.category && line.portion === portion && line.style === style);
  if (existing) existing.quantity += 1;
  else counterCart.push({ name:counterChoiceItem.name, category:counterChoiceItem.category, portion, style, price, quantity:1 });
  document.getElementById('counter-choice-dialog').close(); renderCounterOrder();
});
document.getElementById('counter-cart-items')?.addEventListener('click', (event) => {
  const button = event.target.closest('[data-counter-qty]'); if (!button) return;
  const index = Number(button.dataset.counterQty), line = counterCart[index]; if (!line) return;
  line.quantity += Number(button.dataset.counterChange); if (line.quantity <= 0) counterCart.splice(index, 1); renderCounterOrder();
});
document.getElementById('counter-clear')?.addEventListener('click', () => { counterCart = []; document.getElementById('counter-order-status').textContent = ''; renderCounterOrder(); });
document.getElementById('counter-place-order')?.addEventListener('click', async () => {
  const status = document.getElementById('counter-order-status');
  if (!counterCart.length) { status.textContent = 'Add at least one menu item first.'; return; }
  const button = document.getElementById('counter-place-order'); button.disabled = true;
  const payload = { clientRequestId:counterRequestId(), customerName:document.getElementById('counter-customer-name').value.trim(), customerPhone:document.getElementById('counter-customer-phone').value.trim(), specialRequest:document.getElementById('counter-special-request').value.trim(), loyaltyPoints:Math.floor(Number(document.getElementById('counter-wallet-redeem')?.value || 0)), items:counterCart.map((item) => ({ ...item })) };
  if (payload.loyaltyPoints >= 100) {
    const first = window.confirm(`Apply ₹${payload.loyaltyPoints} from this customer's wallet?`);
    const second = first && window.confirm(`Final confirmation: deduct ${payload.loyaltyPoints} wallet points (₹${payload.loyaltyPoints}) from this order?`);
    if (!second) { button.disabled = false; status.textContent = 'Wallet points were not applied. Review the amount before placing the order.'; return; }
  }
  status.textContent = navigator.onLine ? 'Saving takeaway order…' : 'Internet is unavailable — saving this order safely on this device…';
  try {
    let result;
    if (!navigator.onLine) throw new TypeError('Offline');
    result = await sendCounterOrder(payload);
    status.textContent = `Takeaway order #${result.orderNumber} accepted. Sending KOTs and final bill…`; counterCart = []; counterLoyaltyPoints = 0; document.getElementById('counter-customer-name').value = ''; document.getElementById('counter-customer-phone').value = ''; document.getElementById('counter-special-request').value = ''; document.getElementById('counter-wallet-redeem').value = '0'; counterWallet.hidden = true; renderCounterOrder(); void autoPrintOrder({ id:result.id, mode:'counter', status:result.status || 'accepted' }).then((printing) => { if (printing?.ok) status.textContent = `Takeaway order #${result.orderNumber} accepted. KOTs and final bill were sent to the configured printers.`; else if (printing?.reason) status.textContent = `Takeaway order #${result.orderNumber} accepted. ${printing.reason} Check Operations / Orders Error Logs.`; }); loadOrders(); refreshCounterLiveStatus();
  } catch (error) {
    if (!navigator.onLine || !error.status || error.status >= 500) {
      const queued = queuedCounterOrders(); queued.push(payload); saveQueuedCounterOrders(queued);
      counterCart = []; document.getElementById('counter-customer-name').value = ''; document.getElementById('counter-customer-phone').value = ''; document.getElementById('counter-special-request').value = ''; renderCounterOrder();
      status.textContent = 'Takeaway order saved offline. It will be sent automatically when internet returns.'; updateConnectivity();
    } else status.textContent = error.message;
  } finally { button.disabled = false; }
});
operationsToggle.addEventListener('click', async () => {
  const opening = operationsPanel.hidden;
  if (opening) closeOpenPanels('operations');
  operationsPanel.hidden = !opening;
  operationsToggle.classList.toggle('is-open', opening);
  operationsToggle.setAttribute('aria-expanded', String(opening));
  if (!opening) return;
  document.getElementById('operations-content').innerHTML = '<div class="operations-empty">Loading Operations…</div>';
  try { await loadOrders(); await loadOperations(); await discoverSystemPrinters(); renderOperations(); operationsPanel.scrollIntoView({ behavior:'smooth', block:'start' }); } catch (error) { document.getElementById('operations-content').innerHTML = `<div class="operations-empty">${esc(error.message)}</div>`; }
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
  if (event.target.id === 'operation-route-all-categories') {
    const enabled = event.target.checked;
    if (!enabled) operationsConfig.routes = operationsConfig.routes.filter((route) => !(route.category === '*' && !route.itemName));
    document.querySelectorAll('.operation-route-category-check, .operation-route-item-check').forEach((input) => { input.disabled = enabled; if (enabled) input.checked = false; });
    document.getElementById('operation-route-item').disabled = enabled;
    const counter = document.getElementById('route-category-count');
    if (counter) counter.textContent = enabled ? 'All categories' : '0 selected';
    return;
  }
  if (!event.target.matches('.operation-route-category-check')) return;
  const selected = selectedRouteCategories();
  const counter = document.getElementById('route-category-count');
  if (counter) counter.textContent = `${selected.length} selected`;
  refreshRouteItemOptions();
});
document.getElementById('operations-content')?.addEventListener('input', (event) => {
  if (event.target.id !== 'operation-route-category-search') return;
  const query = event.target.value.trim().toLowerCase();
  document.querySelectorAll('.category-choice').forEach((choice) => {
    choice.classList.toggle('is-hidden', !choice.textContent.toLowerCase().includes(query));
  });
});
document.getElementById('operations-content')?.addEventListener('click', async (event) => {
  const operationsNavigation = event.target.closest('[data-operations-tab]');
  if (operationsNavigation) {
    operationsTab = operationsNavigation.dataset.operationsTab || 'home';
    assignmentPrinterId = '';
    assignmentMode = '';
    renderOperations();
    return;
  }
  const expandCategory = event.target.closest('[data-route-category-expand]');
  if (expandCategory) {
    event.preventDefault();
    const preview = expandCategory.closest('.category-choice')?.nextElementSibling;
    if (preview?.classList.contains('category-item-preview')) { preview.hidden = !preview.hidden; expandCategory.classList.toggle('is-open', !preview.hidden); }
    return;
  }
  const copyBridgeCommand = event.target.closest('#copy-print-bridge-command');
  if (copyBridgeCommand) { try { await navigator.clipboard.writeText(copyBridgeCommand.dataset.command || ''); copyBridgeCommand.textContent='Copied'; setTimeout(() => { copyBridgeCommand.textContent='Copy setup command'; }, 1600); } catch (_) { alert(`Run this command in Terminal / PowerShell:\n\n${copyBridgeCommand.dataset.command || ''}`); } return; }
  const quickAdd = event.target.closest('#quick-add-printer');
  if (quickAdd) { const select=document.getElementById('quick-system-printer'); const deviceId=String(select?.value||''); const deviceName=String(select?.selectedOptions?.[0]?.textContent||''); if (!deviceId) { alert('Choose an installed system printer first.'); return; } if (operationsConfig.printers.some((printer) => printer.deviceId === deviceId)) { alert('This system printer has already been added.'); return; } operationsConfig.printers.push({ id:operationId(), name:deviceName, type:'kot', connection:'system', deviceId, deviceName }); renderOperations(); return; }
  const assignPrinter = event.target.closest('[data-assign-printer]');
  if (assignPrinter) { assignmentPrinterId=assignPrinter.dataset.assignPrinter || ''; assignmentMode='choose'; renderOperations(); return; }
  if (event.target.closest('[data-assignment-back]')) { assignmentPrinterId=''; assignmentMode=''; renderOperations(); return; }
  if (event.target.closest('[data-assign-bill]')) { const printer=operationsConfig.printers.find((item)=>item.id===assignmentPrinterId); if (printer) { printer.type='bill'; operationsConfig.routes=operationsConfig.routes.filter((route)=>route.printerId!==printer.id); try { await saveOperations(); assignmentPrinterId=''; assignmentMode=''; renderOperations(); } catch (error) { alert(error.message); } } return; }
  if (event.target.closest('[data-assign-kot]')) { assignmentMode='kot'; renderOperations(); return; }
  if (event.target.closest('[data-save-kot-assignment]')) { const printer=operationsConfig.printers.find((item)=>item.id===assignmentPrinterId); const allCategories=!!document.querySelector('[data-assignment-all-categories]')?.checked; const categories=[...document.querySelectorAll('[data-assignment-category]:checked')].map((input)=>input.value); const items=[...document.querySelectorAll('[data-assignment-item]:checked')].map((input)=>({category:input.dataset.category||'',itemName:input.value||'',portion:input.dataset.portion||''})).filter((item)=>item.category&&item.itemName); if (!allCategories && !categories.length && !items.length) { alert('Select all categories, a category, or at least one dish.'); return; } if (printer) { printer.type='kot'; operationsConfig.routes=operationsConfig.routes.filter((route)=>route.printerId!==printer.id); if (allCategories) operationsConfig.routes.push({ id:operationId(), printerId:printer.id, category:'*', itemName:'' }); categories.forEach((category)=>operationsConfig.routes.push({ id:operationId(), printerId:printer.id, category, itemName:'' })); items.forEach((item)=>operationsConfig.routes.push({ id:operationId(), printerId:printer.id, category:item.category, itemName:item.itemName, portion:item.portion })); try { await saveOperations(); assignmentPrinterId=''; assignmentMode=''; renderOperations(); } catch (error) { alert(error.message); } } return; }
  const addPrinter = event.target.closest('#operation-add-printer');
  if (addPrinter) { const name=String(document.getElementById('operation-printer-name')?.value||'').trim(); const type=document.getElementById('operation-printer-type')?.value==='bill'?'bill':'kot'; const deviceSelect=document.getElementById('operation-printer-device'); const deviceId=String(deviceSelect?.value||'').trim(); const deviceName=deviceId ? String(deviceSelect?.selectedOptions?.[0]?.textContent||'').trim() : ''; if (!name) { document.getElementById('operation-printer-name')?.focus(); return; } if (!deviceId && printBridgeState === 'available') { alert('Choose an installed system printer first.'); return; } operationsConfig.printers.push({ id:operationId(), name, type, connection:'system', deviceId, deviceName }); renderOperations(); return; }
  const removePrinter = event.target.closest('[data-delete-printer]');
  if (removePrinter) { const id=removePrinter.dataset.deletePrinter; const printer=operationsConfig.printers.find((item)=>item.id===id); const routeCount=operationsConfig.routes.filter((route)=>route.printerId===id).length; const confirmation=prompt(`Remove ${printer?.name || 'this printer'}?\n\nThis will also remove ${routeCount} routing rule${routeCount===1?'':'s'}.\n\nType 1111 or YES to confirm.`); if (!/^(1111|yes)$/i.test(String(confirmation||'').trim())) return; operationsConfig.printers=operationsConfig.printers.filter((printer)=>printer.id!==id); operationsConfig.routes=operationsConfig.routes.filter((route)=>route.printerId!==id); renderOperations(); return; }
  const addRoute = event.target.closest('#operation-add-route');
  if (addRoute) { try { if (!addSelectedRoutes()) { alert('Choose a KOT printer and at least one category first.'); return; } renderOperations(); } catch (error) { alert(error.message); } return; }
  const removeRoute = event.target.closest('[data-delete-route]');
  if (removeRoute) { operationsConfig.routes=operationsConfig.routes.filter((route)=>route.id!==removeRoute.dataset.deleteRoute); renderOperations(); return; }
  if (event.target.closest('#operations-save')) { const button=event.target.closest('#operations-save'); try { addSelectedRoutes(); } catch (error) { alert(error.message); return; } button.disabled=true; button.textContent='Saving…'; try { await saveOperations(); } catch(error) { alert(error.message); button.disabled=false; button.textContent='Save printer configuration'; } return; }
  const kot = event.target.closest('[data-print-kot]');
  if (kot) { try { await dispatchKot(kot.dataset.printKot, kot.dataset.printerId); await loadOperations(); } catch (error) { reportOrdersDiagnostic({ message:`KOT printing failed: ${error.message}`, source:'KOT print bridge' }); alert(error.message); } }
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
  closeOpenPanels('shortcut');
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
  } catch (error) { reportOrdersDiagnostic({ message:`Menu availability update failed: ${error.message}`, source:'menu availability' }); alert(error.message); button.disabled = false; }
});

loadOrders();
setInterval(loadOrders, 3000);
setInterval(() => { if (!counterPanel.hidden) refreshCounterLiveStatus(); }, 1000);
