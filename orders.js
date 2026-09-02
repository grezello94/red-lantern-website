const root = document.getElementById('orders');
const defaultBillHeader =
  'Colva Goa\n9922853605 / 9049558369\n[Follow] Insta ID:\nred_lantern_restaurant';
const defaultBillFooter =
  'Thank you for choosing us!\nKindly leave us a review\nGoogle | Zomato | Swiggy';
const availability = document.getElementById('availability');
const menuSearch = document.getElementById('menu-search');
const menuResults = document.getElementById('menu-results');
const orderSearch = document.getElementById('order-search');
const historyDate = document.getElementById('history-date');
let known = new Set();
let firstLoad = true;
let ordersRefreshInFlight = false;
let fastOrdersRefreshQueued = false;
let fastOrdersRefreshTimer = null;
let printUpdateCursor = null;
let printUpdatePollInFlight = false;
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
const {
  configuredPrintersFor,
  printerFormat,
  printerCapabilities,
  printerSupports,
  setPrinterCapability,
  setPrinterFormat,
} = window.RedLanternPrinterDomain;
let tableViewAreaFilter = 'all';
let tableViewSearch = '';
const tableAllocationCacheKey = 'red-lantern-table-allocation';
function readCachedTableAreas() {
  try {
    const value = JSON.parse(localStorage.getItem(tableAllocationCacheKey) || '[]');
    return Array.isArray(value) ? value : [];
  } catch (_) {
    return [];
  }
}
function cacheTableAreas(areas) {
  try {
    localStorage.setItem(
      tableAllocationCacheKey,
      JSON.stringify(Array.isArray(areas) ? areas : [])
    );
  } catch (_) {}
}
const operationsSnapshotKey = 'red-lantern-operations-snapshot';
function readCachedOperationsConfig() {
  try {
    const value = JSON.parse(localStorage.getItem(operationsSnapshotKey) || 'null');
    return value &&
      typeof value === 'object' &&
      Array.isArray(value.printers) &&
      Array.isArray(value.routes)
      ? value
      : null;
  } catch (_) {
    return null;
  }
}
function cacheOperationsConfig(config) {
  try {
    localStorage.setItem(
      operationsSnapshotKey,
      JSON.stringify({
        printers: Array.isArray(config?.printers) ? config.printers : [],
        routes: Array.isArray(config?.routes) ? config.routes : [],
        tableAreas: Array.isArray(config?.tableAreas) ? config.tableAreas : [],
      })
    );
  } catch (_) {}
}
const tableOrderSnapshotKey = 'red-lantern-table-order-snapshot';
function readCachedTableOrders() {
  try {
    const value = JSON.parse(localStorage.getItem(tableOrderSnapshotKey) || '[]');
    return Array.isArray(value)
      ? value.filter(
          (order) =>
            order && order.id && order.mode === 'table' && order.table_area && order.table_number
        )
      : [];
  } catch (_) {
    return [];
  }
}
function cacheTableOrders(orders) {
  try {
    const tables = (Array.isArray(orders) ? orders : [])
      .filter((order) => order?.mode === 'table' && order.table_area && order.table_number)
      .map((order) => ({
        id: order.id,
        mode: 'table',
        table_area: order.table_area,
        table_number: order.table_number,
        status: order.status,
        created_at: order.created_at,
        bill_printed_at: order.bill_printed_at || null,
      }));
    localStorage.setItem(tableOrderSnapshotKey, JSON.stringify(tables));
  } catch (_) {}
}
function reserveOfflineTable(payload) {
  if (!payload.tableArea || !payload.tableNumber) return;
  const id = `offline:${payload.clientRequestId}`;
  orderRecords.set(id, {
    id,
    mode: 'table',
    table_area: payload.tableArea,
    table_number: Number(payload.tableNumber),
    status: 'offline',
    created_at: new Date().toISOString(),
    items: payload.items || [],
    customer_name: payload.customerName || '',
    customer_phone: payload.customerPhone || '',
    special_request: payload.specialRequest || '',
  });
  cacheTableOrders([...orderRecords.values()]);
  if (!tableViewPanel.hidden) renderTableView();
}
let operationsMenu = [];
let operationKotHistory = new Map();
let completedKotHistory = [];
let kitchenStationStatuses = new Map();
const kdsStationSelectionKey = 'red-lantern-kds-stations';
function selectedKdsStations() {
  try {
    const value = JSON.parse(localStorage.getItem(kdsStationSelectionKey) || '[]');
    return Array.isArray(value) ? new Set(value.map(String)) : new Set();
  } catch {
    return new Set();
  }
}
function saveKdsStations(ids) {
  localStorage.setItem(kdsStationSelectionKey, JSON.stringify([...ids]));
}
let operationsTab = 'home';
let installedSystemPrinters = [];
let printBridgeState = 'checking';
let printBridgeConfigState = 'not-synced';
let printBridgeSetupStatus = null;
let assignmentPrinterId = '';
let assignmentMode = '';
let counterMenu = [];
let counterCart = [];
let counterCategory = 'all';
let counterChoiceItem = null;
let counterLoyaltyPoints = 0;
let counterLoyaltyTimer = null;
let counterTable = null;
let counterBillSplit = null;
const offlineCounterOrdersKey = 'red-lantern-counter-orders';
const deferredPrintsKey = 'red-lantern-deferred-prints';
const ordersWorkspaceKey = 'red-lantern-orders-last-workspace';
let counterSyncInProgress = false;
let deferredPrintSyncInProgress = false;
let bridgeLedgerPending = 0;
const printBridgeOrigin = (typeof window !== 'undefined' && window.RED_LANTERN_CONFIG && window.RED_LANTERN_CONFIG.printBridgeOrigin) || 'http://127.0.0.1:9124';

// Bridge support for extracted browser bridge
const bridgeSupport = typeof window !== 'undefined' && window.RedLanternOrders ? window.RedLanternOrders : null;
const bridgeDispatch = bridgeSupport && bridgeSupport.sync ? bridgeSupport.sync.dispatchBridgeAction : null;
const bridgeLedger = bridgeSupport && bridgeSupport.ledger ? bridgeSupport.ledger.flushBridgeLedger : null;

const ordersDiagnosticRecent = new Map();
const orderSearchPanel = document.querySelector('.order-search-panel');
const ordersConsoleStartedAt = Date.now();
const connectivity = document.createElement('p');
connectivity.id = 'orders-connectivity';
connectivity.setAttribute('role', 'status');
connectivity.setAttribute('aria-live', 'polite');
connectivity.setAttribute('aria-atomic', 'true');
document.querySelector('.orders-rail')?.after(connectivity);
let counterRequestAttempt = { signature: '', id: '' };
let counterOrderOperation = 0;
function counterRequestId(payload = {}) {
  const signature = JSON.stringify(payload);
  if (counterRequestAttempt.id && counterRequestAttempt.signature === signature)
    return counterRequestAttempt.id;
  counterRequestAttempt = {
    signature,
    id: `counter-${Date.now()}-${crypto.getRandomValues(new Uint32Array(1))[0].toString(36)}`,
  };
  return counterRequestAttempt.id;
}
function resetCounterRequestAttempt() {
  counterRequestAttempt = { signature: '', id: '' };
}
function settlementRequestId() {
  return `settlement-${Date.now()}-${crypto.getRandomValues(new Uint32Array(1))[0].toString(36)}`;
}
function offlineActionId(type) {
  return `${type}-${Date.now()}-${crypto.getRandomValues(new Uint32Array(1))[0].toString(36)}`;
}
function queuedCounterOrders() {
  try {
    return JSON.parse(localStorage.getItem(offlineCounterOrdersKey) || '[]');
  } catch {
    return [];
  }
}
function saveQueuedCounterOrders(orders) {
  localStorage.setItem(offlineCounterOrdersKey, JSON.stringify(orders));
}
function deferredPrints() {
  try {
    const value = JSON.parse(localStorage.getItem(deferredPrintsKey) || '[]');
    return Array.isArray(value) ? value.filter((entry) => entry?.id && entry?.mode) : [];
  } catch (_) {
    return [];
  }
}
function saveDeferredPrints(entries) {
  try {
    localStorage.setItem(deferredPrintsKey, JSON.stringify(entries.slice(-100)));
  } catch (_) {}
}
function deferAutomaticPrint(order) {
  if (!order?.id) return;
  const entries = deferredPrints();
  if (!entries.some((entry) => entry.id === order.id)) {
    entries.push({ id: order.id, mode: order.mode, status: order.status, queuedAt: new Date().toISOString() });
    saveDeferredPrints(entries);
  }
}
async function saveToBridgeLedger(payload) {
  const response = await fetch(`${printBridgeOrigin}/v1/ledger/actions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: payload.clientRequestId, type: 'counter-order', payload }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || 'The local order ledger is unavailable.');
  bridgeLedgerPending += body.action?.status === 'queued' ? 1 : 0;
  updateConnectivity();
  return body.action;
}
async function saveBridgeAction(type, payload) {
  const id = offlineActionId(type);
  const response = await fetch(`${printBridgeOrigin}/v1/ledger/actions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, type, payload }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || 'The local order ledger is unavailable.');
  bridgeLedgerPending += body.action?.status === 'queued' ? 1 : 0;
  updateConnectivity();
  return id;
}
async function dispatchBridgeAction(action) {
  const payload = action.payload || {};
  let response;
  if (action.type === 'counter-order') return sendCounterOrder(payload);
  if (action.type === 'order-status')
    response = await fetch(`/api/orders/${encodeURIComponent(payload.orderId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: payload.status }),
    });
  else if (action.type === 'order-items')
    response = await fetch(`/api/orders/${encodeURIComponent(payload.orderId)}/items`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quantities: payload.quantities }),
    });
  else if (action.type === 'order-table')
    response = await fetch(`/api/orders/${encodeURIComponent(payload.orderId)}/table`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tableArea: payload.tableArea, tableNumber: payload.tableNumber }),
    });
  else if (action.type === 'kitchen-status')
    response = await fetch(
      `/api/orders/${encodeURIComponent(payload.orderId)}/kitchen-status/${encodeURIComponent(payload.printerId)}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: payload.status }),
      }
    );
  else if (action.type === 'availability-update')
    response = await fetch(
      `/api/orders/availability/${encodeURIComponent(payload.key)}`,
      payload.unavailableUntil
        ? {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ unavailableUntil: payload.unavailableUntil }),
          }
        : { method: 'DELETE' }
    );
  else if (action.type === 'operations-config')
    response = await fetch('/api/orders/operations', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: payload.config }),
    });
  else if (action.type === 'table-areas')
    response = await fetch('/api/orders/operations/table-areas', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tableAreas: payload.tableAreas }),
    });
  else if (action.type === 'settlement')
    response = await fetch(`/api/orders/${encodeURIComponent(payload.orderId)}/settle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Settlement-Id': payload.requestId },
      body: JSON.stringify({
        paymentType: payload.paymentType,
        amount: payload.amount,
        requestId: payload.requestId,
      }),
    });
  else throw new Error('Unsupported offline action type.');
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || 'Unable to sync this offline change.');
    error.status = response.status;
    throw error;
  }
  return body;
}
async function queueWhenOffline(type, payload, applyLocal) {
  if (navigator.onLine) return false;
  await saveBridgeAction(type, payload);
  applyLocal?.();
  updateConnectivity(
    'Offline change saved safely on this computer. It will sync when internet returns.'
  );
  return true;
}
async function updateBridgeLedger(id, status, error = '') {
  const response = await fetch(
    `${printBridgeOrigin}/v1/ledger/actions/${encodeURIComponent(id)}/${status}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error }),
    }
  );
  if (!response.ok) throw new Error('Unable to update the local order ledger.');
}
async function flushBridgeLedger() {
  if (!navigator.onLine) return;
  const response = await fetch(`${printBridgeOrigin}/v1/ledger/actions?status=queued`, {
    cache: 'no-store',
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !Array.isArray(body.actions))
    throw new Error(body.error || 'Unable to read the local order ledger.');
  bridgeLedgerPending = body.actions.length;
  const queuedAtStart = body.actions.length;
  for (const action of body.actions) {
    try {
      const result = await dispatchBridgeAction(action);
      await updateBridgeLedger(action.id, 'synced');
      bridgeLedgerPending = Math.max(0, bridgeLedgerPending - 1);
      if (action.type === 'counter-order')
        void autoPrintOrder({
          id: result.id,
          mode: action.payload.tableArea ? 'table' : 'counter',
          status: result.status || 'accepted',
        });
      if (action.type === 'operations-config' && result?.config) {
        operationsConfig = result.config;
        cacheOperationsConfig(operationsConfig);
        void syncOperationsToPrintBridge(operationsConfig);
      }
      if (action.type === 'table-areas' && Array.isArray(result?.tableAreas)) {
        operationsConfig.tableAreas = result.tableAreas;
        cacheTableAreas(result.tableAreas);
        cacheOperationsConfig(operationsConfig);
      }
    } catch (error) {
      if (error.status >= 400 && error.status < 500 && error.status !== 409)
        await updateBridgeLedger(
          action.id,
          'blocked',
          error.message || 'This order needs staff review.'
        );
      break;
    }
  }
  updateConnectivity();
  return queuedAtStart;
}
function reportOrdersDiagnostic(payload = {}) {
  const source = payload.source || 'orders.js';
  const message = String(payload.message || 'Orders console issue.').slice(0, 400);
  const fingerprint = `${source}:${message}`;
  const previous = ordersDiagnosticRecent.get(fingerprint) || 0;
  if (Date.now() - previous < 5 * 60 * 1000) return;
  ordersDiagnosticRecent.set(fingerprint, Date.now());
  const body = JSON.stringify({
    category: 'orders',
    level: payload.level || 'error',
    path: '/orders',
    source,
    message,
    stack: String(payload.stack || '').slice(0, 1000),
  });
  fetch('/api/client-log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    keepalive: true,
  }).catch(() => {});
}
window.addEventListener('error', (event) =>
  reportOrdersDiagnostic({
    message: event.message || 'Orders browser script error.',
    source: event.filename || 'orders browser',
    stack: event.error?.stack || '',
  })
);
window.addEventListener('unhandledrejection', (event) =>
  reportOrdersDiagnostic({
    message: event.reason?.message || 'Orders browser request failed.',
    source: 'orders browser promise',
    stack: event.reason?.stack || String(event.reason || ''),
  })
);
function updateConnectivity(message) {
  const pending = queuedCounterOrders().length + bridgeLedgerPending,
    online = navigator.onLine;
  connectivity.hidden = online && !pending && !message;
  connectivity.className = online ? 'is-online' : 'is-offline';
  connectivity.textContent =
    message ||
    (!online
      ? `Offline mode — orders are saved on this device and will sync when internet returns.${pending ? ` ${pending} waiting.` : ''}`
      : pending
        ? `${pending} order${pending === 1 ? '' : 's'} waiting to sync.`
        : '');
}
async function sendCounterOrder(payload) {
  const response = await fetch('/api/orders/counter', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Counter-Order-Id': payload.clientRequestId },
    body: JSON.stringify(payload),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(result.error || 'Unable to save the order.');
    error.status = response.status;
    throw error;
  }
  return result;
}
async function flushQueuedCounterOrders() {
  if (counterSyncInProgress || !navigator.onLine) return;
  counterSyncInProgress = true;
  try {
    let bridgeQueuedAtStart = 0;
    try {
      bridgeQueuedAtStart = (await flushBridgeLedger()) || 0;
    } catch (_) {}
    let queued = queuedCounterOrders();
    const browserQueuedAtStart = queued.length;
    while (queued.length && navigator.onLine) {
      try {
        const result = await sendCounterOrder(queued[0]);
        autoPrintOrder({
          id: result.id,
          mode: queued[0].tableArea ? 'table' : 'counter',
          status: result.status || 'accepted',
        });
        queued.shift();
        saveQueuedCounterOrders(queued);
      } catch (error) {
        if (error.status >= 400 && error.status < 500 && error.status !== 409) {
          queued.shift();
          saveQueuedCounterOrders(queued);
          continue;
        }
        if (error.status === 409 && !queued[0].errorReported) {
          queued[0].errorReported = true;
          saveQueuedCounterOrders(queued);
          reportOrdersDiagnostic({
            level: 'warning',
            message: 'Queued counter order needs review: an item is no longer available.',
            source: 'offline order sync',
          });
        }
        break;
      }
    }
    if (!queued.length && (bridgeQueuedAtStart || browserQueuedAtStart)) {
      updateConnectivity('Queued orders synced successfully.');
      setTimeout(() => updateConnectivity(), 4000);
      loadOrders();
    } else if (!queued.length) updateConnectivity();
    else updateConnectivity();
  } finally {
    counterSyncInProgress = false;
  }
}
async function refreshAfterReconnect() {
  // Deliberately refresh data in place: never reload the page or disturb a counter order being typed.
  await Promise.allSettled([
    loadOrders(),
    counterPanel?.hidden
      ? Promise.resolve()
      : loadAvailability().then(() => {
          counterMenu = menuItems.filter((item) => !unavailable.has(item.key));
          renderCounterOrder();
        }),
    counterPanel?.hidden ? Promise.resolve() : refreshCounterLiveStatus(),
  ]);
}
window.addEventListener('online', () => {
  updateConnectivity('Internet restored — syncing queued orders…');
  refreshAfterReconnect();
  flushQueuedCounterOrders();
  flushDeferredAutomaticPrints();
});
window.addEventListener('offline', () => {
  updateConnectivity();
  reportOrdersDiagnostic({
    level: 'warning',
    message:
      'Orders console lost internet connection. Counter orders will be queued locally until reconnection.',
    source: 'connection monitor',
  });
});
updateConnectivity();
if (navigator.onLine) setTimeout(flushQueuedCounterOrders, 300);
document.querySelectorAll('[data-fulfillment-filter]').forEach((button) => {
  button.addEventListener('click', () => {
    const nextFilter = button.dataset.fulfillmentFilter || '';
    if (nextFilter === 'pickup') {
      openCounterOrder();
      return;
    }
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
orderStatusFilters.innerHTML = [
  ['all', 'All orders'],
  ['accepted', 'Accepted'],
  ['preparing', 'Preparing'],
  ['ready', 'Ready'],
  ['completed', 'Completed'],
  ['rejected', 'Rejected'],
]
  .map(
    ([value, label]) =>
      `<button type="button" class="order-status-filter ${value === 'all' ? 'is-active' : ''} status-${value}" data-order-status-filter="${value}" aria-pressed="${value === 'all'}">${label}</button>`
  )
  .join('');
orderSearchPanel?.after(orderStatusFilters);
const actionIcon = (name) => {
  const paths = {
    receipt: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3Z"/><path d="M9 8h6M9 12h6"/>',
    install:
      '<path d="M14 3h7v7"/><path d="M21 3 10 14"/><path d="M12 5H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7"/>',
    operations:
      '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.12 2.12-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.04 1.56V20.3h-3v-.08A1.7 1.7 0 0 0 10.66 18.66a1.7 1.7 0 0 0-1.88.34l-.06.06L6.6 16.94l.06-.06A1.7 1.7 0 0 0 7 15a1.7 1.7 0 0 0-1.56-1.04H5.3v-3h.14A1.7 1.7 0 0 0 7 9.92a1.7 1.7 0 0 0-.34-1.88L6.6 7.98 8.72 5.86l.06.06a1.7 1.7 0 0 0 1.88.34 1.7 1.7 0 0 0 1.04-1.56V4.62h3v.08a1.7 1.7 0 0 0 1.04 1.56 1.7 1.7 0 0 0 1.88-.34l.06-.06 2.12 2.12-.06.06A1.7 1.7 0 0 0 19.4 9.92a1.7 1.7 0 0 0 1.56 1.04h.14v3h-.14A1.7 1.7 0 0 0 19.4 15Z"/>',
    cutlery: '<path d="M4 3v8M7 3v8M4 7h3M5.5 11v10M14 3v8M14 3c3 1 4.5 3.8 4.5 8H14M14 11v10"/>',
    bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/>',
    refresh: '<path d="M20 11a8 8 0 0 0-14.9-4M4 4v4h4M4 13a8 8 0 0 0 14.9 4M20 20v-4h-4"/>',
  };
  return `<svg class="header-action-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || ''}</svg>`;
};
const liveOrdersToggle = document.getElementById('live-orders-toggle');
const operationsPanel = document.createElement('section');
operationsPanel.id = 'operations-panel';
operationsPanel.hidden = true;
operationsPanel.innerHTML =
  '<div class="operations-head"><div><span class="eyebrow">Staff workspace</span><h2>Operations</h2><p>Review routed KOTs and configure kitchen, tandoori, bar, and bill printers.</p></div><button type="button" id="operations-close" class="quiet-button">Close</button></div><div id="operations-content"></div>';
availability.before(operationsPanel);
const counterPanel = document.createElement('section');
counterPanel.id = 'counter-order-panel';
counterPanel.hidden = true;
counterPanel.innerHTML =
  '<div class="counter-order-head"><div><span class="eyebrow">Counter order</span><h2>Takeaway</h2><p>Build a walk-in or phone order, then send it directly to the kitchen.</p></div><button type="button" id="counter-order-close" class="new-order-button">New Order</button></div><div class="counter-order-layout"><div class="counter-menu"><label class="counter-search"><span aria-hidden="true">⌕</span><input id="counter-menu-search" type="search" placeholder="Search menu items"></label><div id="counter-categories" class="counter-categories"></div><div id="counter-menu-items" class="counter-menu-items"></div></div><aside class="counter-cart"><div class="counter-cart-head"><h3>Current order</h3><div><button type="button" id="view-table-kot" hidden>View KOT</button><button type="button" id="counter-clear" class="counter-clear">Clear</button></div></div><div id="counter-cart-items" class="counter-cart-items"></div><div class="counter-customer"><label>Customer name <input id="counter-customer-name" maxlength="80" placeholder="Walk-in customer"></label><label>Mobile number <input id="counter-customer-phone" inputmode="tel" maxlength="16" placeholder="Optional for walk-ins"></label><label>Serving preference <select id="counter-course-mode"><option value="normal_coursing">Serve course by course</option><option value="serve_together">Serve everything together</option><option value="as_ready">Serve items as ready</option><option value="manual_fire">Manual fire</option></select></label><label>Kitchen note <textarea id="counter-special-request" maxlength="240" placeholder="e.g. less spicy"></textarea></label></div><div class="counter-total"><span>Total</span><b id="counter-total">₹0</b></div><button type="button" id="counter-place-order" class="counter-place-order">Place takeaway order</button><p id="counter-order-status" class="counter-order-status" aria-live="polite"></p></aside></div><dialog id="counter-choice-dialog" class="counter-choice-dialog"><button type="button" class="dialog-close" data-counter-choice-close aria-label="Close">×</button><div id="counter-choice-content"></div></dialog>';
availability.before(counterPanel);
const counterPanelCloseButton = document.getElementById('counter-order-close');
if (counterPanelCloseButton) {
  counterPanelCloseButton.className = 'counter-back';
  counterPanelCloseButton.textContent = '← Table view';
}
const dineInActions = document.createElement('div');
dineInActions.id = 'dine-in-actions';
dineInActions.hidden = true;
dineInActions.innerHTML =
  '<button type="button" class="dine-in-split" data-dine-action="split">Split</button><button type="button" data-dine-action="save">Save</button><button type="button" data-dine-action="print">Print &amp; eBill</button><button type="button" class="dine-in-kot" data-dine-action="kot-print">Send KOT to kitchen</button><button type="button" class="dine-in-hold" data-dine-action="hold">Hold</button>';
counterPanel.querySelector('.counter-cart')?.append(dineInActions);
const splitBillDialog = document.createElement('dialog');
splitBillDialog.id = 'split-bill-dialog';
splitBillDialog.innerHTML =
  '<button type="button" class="split-close" aria-label="Close">×</button><h2>Split bill</h2><p>Choose how this table bill should be divided when it is printed. The kitchen still receives one KOT.</p><div class="split-tabs"><button type="button" data-split-mode="equal">Portion / percentage</button><button type="button" data-split-mode="group">Group wise</button><button type="button" data-split-mode="item">Item wise</button></div><div id="split-bill-content"></div><div class="split-actions"><button type="button" class="split-cancel">Cancel</button><button type="button" class="split-save">Save split</button></div>';
document.body.appendChild(splitBillDialog);
const tableViewPanel = document.createElement('section');
tableViewPanel.id = 'table-view-panel';
tableViewPanel.innerHTML =
  '<div class="table-view-head"><div><span class="eyebrow">Dine-in</span><h2>Dine-in management</h2><p>Select a table to start or continue its order.</p></div><div class="table-view-head-note"><b id="table-view-active-count">0</b><span>active tables</span></div></div><div id="table-view-content" class="table-view-content"><div class="table-view-empty">Loading allocated tables…</div></div>';
availability.before(tableViewPanel);
let moveKotItemsMode = false;
const moveTableDialog = document.createElement('dialog');
moveTableDialog.id = 'move-table-dialog';
moveTableDialog.innerHTML =
  '<button type="button" class="move-table-close" aria-label="Close">×</button><h2 id="move-table-title">Move KOT / Items</h2><p id="move-table-copy"></p><div class="move-tabs"><button type="button" class="is-active" data-move-mode="table">Table Wise</button><button type="button" data-move-mode="kot">KOT Wise</button><button type="button" data-move-mode="item">Item Wise</button></div><div id="move-table-options"></div><div id="move-table-target" class="move-table-target" aria-label="Available tables"></div><p id="move-table-status" aria-live="polite"></p><div><button type="button" class="move-table-cancel">Cancel</button><button type="button" class="move-table-confirm">Move</button></div>';
document.body.appendChild(moveTableDialog);
const settleTableDialog = document.createElement('dialog');
settleTableDialog.id = 'settle-table-dialog';
settleTableDialog.innerHTML =
  '<button type="button" class="settle-close" aria-label="Close">×</button><h2 id="settle-table-title">Settle &amp; Save</h2><p>Confirm payment to close this table and make it available.</p><fieldset><legend>Payment type</legend><label><input type="radio" name="settlement-type" value="cash" checked> Cash</label><label><input type="radio" name="settlement-type" value="upi"> UPI</label><label><input type="radio" name="settlement-type" value="card"> Card</label><label><input type="radio" name="settlement-type" value="due"> Due</label><label><input type="radio" name="settlement-type" value="other"> Other</label></fieldset><label>Settlement amount<input id="settlement-amount" type="number" min="0" step="0.01"></label><p id="settle-table-status" aria-live="polite"></p><div><button type="button" class="settle-cancel">Cancel</button><button type="button" class="settle-confirm">Settle &amp; Save</button></div>';
document.body.appendChild(settleTableDialog);
const viewKotDialog = document.createElement('dialog');
viewKotDialog.id = 'view-kot-dialog';
viewKotDialog.innerHTML =
  '<button type="button" class="view-kot-close" aria-label="Close">×</button><h2>Current KOTs</h2><div id="view-kot-content"></div>';
document.body.appendChild(viewKotDialog);
const counterWallet = document.createElement('div');
counterWallet.id = 'counter-wallet';
counterWallet.hidden = true;
counterWallet.innerHTML =
  '<span class="counter-wallet-label">Customer wallet</span><b id="counter-wallet-balance">Enter a mobile number to check points.</b><label id="counter-wallet-redeem-wrap" hidden>Use wallet points <input id="counter-wallet-redeem" type="number" min="100" step="1" inputmode="numeric" value="0"></label><small id="counter-wallet-note"></small>';
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
    const response = await fetch('/api/orders/live-summary', { cache: 'no-store' });
    if (!response.ok) throw new Error('Unavailable');
    const live = await response.json();
    const token = Number(live.latestActiveOrderNumber || live.latestOrderNumber || 0);
    counterLiveStatus.classList.remove('is-offline');
    counterLiveStatus.innerHTML = `<span>Live counter status</span><b>${token ? `Order #${String(token).padStart(2, '0')}` : 'No orders yet'}</b><small>${Number(live.activeOrderCount || 0)} active order${Number(live.activeOrderCount || 0) === 1 ? '' : 's'}</small>`;
  } catch {
    counterLiveStatus.classList.add('is-offline');
    counterLiveStatus.innerHTML =
      '<span>Live counter status</span><b>Offline</b><small>Updates resume automatically</small>';
  } finally {
    counterLiveStatusLoading = false;
  }
}
const operationsToggle = document.getElementById('operations-toggle');
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
  if (except !== 'counter') {
    counterPanel.hidden = true;
    document.body.classList.remove('is-counter-workspace');
  }
  if (except !== 'tables') tableViewPanel.hidden = true;
  const shortcutDialog = document.getElementById('shortcut-dialog');
  if (except !== 'shortcut' && shortcutDialog?.open) shortcutDialog.close();
};
function setOrdersRailActive(workspace) {
  document.querySelectorAll('[data-orders-rail]').forEach((item) => {
    item.classList.toggle('is-active', item.dataset.ordersRail === workspace);
  });
}
function rememberOrdersWorkspace(area, tab = '') {
  try {
    localStorage.setItem(ordersWorkspaceKey, JSON.stringify({ area, tab }));
  } catch (_) {}
}
function savedOrdersWorkspace() {
  try {
    const value = JSON.parse(localStorage.getItem(ordersWorkspaceKey) || 'null');
    return value && ['tables', 'counter', 'live', 'operations', 'availability'].includes(value.area)
      ? value
      : null;
  } catch (_) {
    return null;
  }
}
const counterPrice = (item) => {
  const options = [
    ['', item.price],
    ['Half', item.halfPrice],
    ['Full', item.fullPrice],
    ['With Bone', item.withBonePrice],
    ['Boneless', item.bonelessPrice],
    ['30 ml', item.price30ml],
    ['60 ml', item.price60ml],
    ['90 ml', item.price90ml],
    ['180 ml', item.price180ml],
  ].filter(([, price]) => Number(String(price || '').replace(/[^0-9.]/g, '')) > 0);
  return options[0] || ['', 0];
};
const counterPortionOptions = (item) =>
  [
    ['', 'Regular', item.price],
    ['Half', 'Half', item.halfPrice],
    ['Full', 'Full', item.fullPrice],
    ['With Bone', 'With Bone', item.withBonePrice],
    ['Boneless', 'Boneless', item.bonelessPrice],
    ['30 ml', '30 ml', item.price30ml],
    ['60 ml', '60 ml', item.price60ml],
    ['90 ml', '90 ml', item.price90ml],
    ['180 ml', '180 ml', item.price180ml],
  ].filter(([, , price]) => Number(String(price || '').replace(/[^0-9.]/g, '')) > 0);
const smartKdsCourseOptions = (defaultCourse = '', selected = '') =>
  `<option value="">Default${defaultCourse ? ` (${esc(defaultCourse)})` : ''}</option>${['drink', 'soup', 'starter', 'main', 'side', 'dessert', 'other'].map((course) => `<option value="${course}" ${selected === course ? 'selected' : ''}>${course[0].toUpperCase() + course.slice(1)}</option>`).join('')}`;
function updateCounterChoiceTotal() {
  const selectedPortion = document.querySelector('input[name="counter-portion"]:checked');
  const addButton = document.getElementById('counter-choice-add');
  const addPrice = document.getElementById('counter-choice-add-price');
  if (!selectedPortion || !addButton || !addPrice) return;
  const style = document.querySelector('input[name="counter-style"]:checked')?.value || '';
  const total = Number(selectedPortion.dataset.counterChoicePrice || 0) + (style ? 10 : 0);
  addPrice.textContent = counterMoney(total);
  addButton.setAttribute('aria-label', `Add to order for ${counterMoney(total)}`);
}
function openCounterChoice(item) {
  counterChoiceItem = item;
  const options = counterPortionOptions(item);
  const dialog = document.getElementById('counter-choice-dialog');
  document.getElementById('counter-choice-content').innerHTML =
    `<div class="counter-choice-title"><span>${esc(item.category || 'Menu')}</span><h2>${esc(item.name)}</h2></div><section class="counter-portion-section" aria-label="Select portion"><div class="counter-choice-section-head"><h3>Select portion</h3><small>Required</small></div><div class="counter-choice-options">${options.map(([value, label, price], index) => `<label><input type="radio" name="counter-portion" value="${esc(value)}" data-counter-choice-price="${Number(String(price).replace(/[^0-9.]/g, ''))}" ${index === 0 ? 'checked' : ''}><span><i aria-hidden="true"></i><strong>${esc(label)}</strong><b>${counterMoney(String(price).replace(/[^0-9.]/g, ''))}</b></span></label>`).join('')}</div></section>${item.gravyStyleAvailable ? '<fieldset class="counter-style-options"><legend>Preparation style</legend><label><input type="radio" name="counter-style" value="" checked> Regular</label><label><input type="radio" name="counter-style" value="Gravy"> Gravy <b>+₹10</b></label><label><input type="radio" name="counter-style" value="Semi-gravy"> Semi-gravy <b>+₹10</b></label></fieldset>' : ''}<label class="counter-course-choice"><span>Kitchen course</span><select id="counter-choice-course">${smartKdsCourseOptions(item.defaultCourse || '')}</select></label><button type="button" id="counter-choice-add" class="counter-place-order"><span><i aria-hidden="true">+</i>Add to order</span><b id="counter-choice-add-price"></b></button>`;
  updateCounterChoiceTotal();
  if (typeof dialog.showModal === 'function') dialog.showModal();
}
const counterMoney = (value) => `₹${Math.round(Number(value) || 0)}`;
function renderCounterOrder() {
  const search = String(document.getElementById('counter-menu-search')?.value || '')
    .trim()
    .toLowerCase();
  const categoryRank = (category) => {
    const value = String(category).toLowerCase();
    return [
      /starter|appetizer/,
      /soup/,
      /salad/,
      /quick.?bite|snack/,
      /tandoor|kebab|grill/,
      /chinese/,
      /rice|noodle/,
      /indian gravy|curry/,
      /biryani/,
      /bread|naan/,
      /main|special/,
      /dessert/,
    ].findIndex((pattern) => pattern.test(value));
  };
  const savedCategoryOrder = new Map(
    counterMenu
      .filter((item) => Number(item.categoryOrderIndex) >= 0)
      .map((item) => [item.category || 'Menu', Number(item.categoryOrderIndex)])
  );
  const categoriesFor = (menuType) =>
    [
      ...new Set(
        counterMenu
          .filter((item) => item.menuType === menuType)
          .map((item) => item.category || 'Menu')
      ),
    ].sort((a, b) => {
      const savedA = savedCategoryOrder.has(a) ? savedCategoryOrder.get(a) : 999,
        savedB = savedCategoryOrder.has(b) ? savedCategoryOrder.get(b) : 999;
      const rankA = categoryRank(a),
        rankB = categoryRank(b);
      return (
        savedA - savedB || (rankA < 0 ? 99 : rankA) - (rankB < 0 ? 99 : rankB) || a.localeCompare(b)
      );
    });
  const foodCategories = categoriesFor('food'),
    barCategories = categoriesFor('bar');
  const categoryButton = (category, label = category) =>
    `<button type="button" class="counter-category ${counterCategory === category ? 'is-active' : ''}" data-counter-category="${esc(category)}">${esc(label)}</button>`;
  document.getElementById('counter-categories').innerHTML =
    `${categoryButton('all', `All items · ${counterMenu.length}`)}<span class="counter-category-group">Food menu</span>${foodCategories.map((category) => categoryButton(category)).join('')}<span class="counter-category-group">Alcohol & bar</span>${barCategories.map((category) => categoryButton(category)).join('')}`;
  const visible = counterMenu.filter(
    (item) =>
      (counterCategory === 'all' || (item.category || 'Menu') === counterCategory) &&
      `${item.name} ${item.category}`.toLowerCase().includes(search)
  );
  document.getElementById('counter-menu-items').innerHTML =
    visible
      .map((item) => {
        const [portion, price] = counterPrice(item);
        return `<button type="button" class="counter-menu-item" data-counter-item="${counterMenu.indexOf(item)}"><span>${esc(item.category || 'Menu')}</span><b>${esc(item.name)}</b><small>${portion ? `${esc(portion)} · ` : ''}${counterMoney(String(price).replace(/[^0-9.]/g, ''))}</small><i aria-hidden="true">+</i></button>`;
      })
      .join('') || '<p class="counter-empty">No menu items match that search.</p>';
  const items = counterCart
    .map((line, index) => {
      const unit = line.price + (line.style ? 10 : 0);
      return `<div class="counter-cart-line"><div><b>${esc(line.name)}</b><small>${esc(line.portion || 'Regular')}${line.style ? ` · ${esc(line.style)}` : ''} · ${counterMoney(unit)} each</small><label class="counter-line-course">Course <select data-counter-course="${index}">${smartKdsCourseOptions(line.defaultCourse || '', line.courseOverride || '')}</select></label></div><div class="counter-quantity"><button type="button" data-counter-qty="${index}" data-counter-change="-1">−</button><b>${line.quantity}</b><button type="button" data-counter-qty="${index}" data-counter-change="1">+</button></div><strong>${counterMoney(unit * line.quantity)}</strong></div>`;
    })
    .join('');
  document.getElementById('counter-cart-items').innerHTML =
    items || '<p class="counter-empty">Choose items from the menu to start an order.</p>';
  const cartHeading = document.querySelector('#counter-order-panel .counter-cart-head h3');
  if (cartHeading) {
    const itemCount = counterCart.reduce((count, line) => count + Number(line.quantity || 0), 0);
    cartHeading.textContent = `Current order${itemCount ? ` · ${itemCount} item${itemCount === 1 ? '' : 's'}` : ''}`;
  }
  const subtotal = counterCart.reduce(
    (sum, line) => sum + (line.price + (line.style ? 10 : 0)) * line.quantity,
    0
  );
  const requestedPoints = Math.floor(
    Number(document.getElementById('counter-wallet-redeem')?.value || 0)
  );
  const usablePoints =
    counterLoyaltyPoints >= 100
      ? Math.min(counterLoyaltyPoints, subtotal, Math.max(0, requestedPoints))
      : 0;
  document.getElementById('counter-total').textContent = counterMoney(subtotal - usablePoints);
  const placeOrderButton = document.getElementById('counter-place-order');
  if (placeOrderButton) {
    const hasItems = counterCart.length > 0;
    placeOrderButton.disabled = !hasItems;
    placeOrderButton.title = hasItems ? '' : 'Add an item before placing the order.';
    document.querySelectorAll('#dine-in-actions button').forEach((button) => {
      if (button.classList.contains('is-processing')) return;
      button.disabled = !hasItems;
      button.title = hasItems ? '' : 'Add an item before using this action.';
    });
  }
  const note = document.getElementById('counter-wallet-note');
  if (note) note.textContent = usablePoints ? `₹${usablePoints} wallet discount applied.` : '';
}
async function loadCounterLoyalty() {
  const phone = String(document.getElementById('counter-customer-phone')?.value || '').replace(
    /\D/g,
    ''
  );
  const walletBalance = document.getElementById('counter-wallet-balance');
  const redeemWrap = document.getElementById('counter-wallet-redeem-wrap');
  const redeem = document.getElementById('counter-wallet-redeem');
  if (phone.length < 7) {
    counterLoyaltyPoints = 0;
    counterWallet.hidden = true;
    if (redeem) redeem.value = '0';
    renderCounterOrder();
    return;
  }
  counterWallet.hidden = false;
  if (walletBalance) walletBalance.textContent = 'Checking wallet points…';
  try {
    const response = await fetch('/api/loyalty', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error();
    counterLoyaltyPoints = Number(data.points || 0);
    if (walletBalance)
      walletBalance.textContent =
        counterLoyaltyPoints >= 100
          ? `${counterLoyaltyPoints} points available`
          : `${counterLoyaltyPoints} points · 100 needed to redeem`;
    if (redeemWrap) redeemWrap.hidden = counterLoyaltyPoints < 100;
    if (redeem) {
      redeem.max = String(counterLoyaltyPoints);
      if (counterLoyaltyPoints < 100) redeem.value = '0';
    }
  } catch {
    counterLoyaltyPoints = 0;
    if (walletBalance) walletBalance.textContent = 'Wallet points are unavailable right now.';
    if (redeemWrap) redeemWrap.hidden = true;
  }
  renderCounterOrder();
}
async function openCounterOrder(table = null) {
  // Remember only the workspace, never unfinished cart or customer data.
  // A refresh can safely reopen Takeaway without risking a duplicate order.
  rememberOrdersWorkspace(table ? 'tables' : 'counter');
  setOrdersRailActive(table ? 'tables' : 'counter');
  counterTable = table;
  const isDineIn = !!table;
  const title = document.querySelector('#counter-order-panel .counter-order-head h2');
  const subtitle = document.querySelector('#counter-order-panel .counter-order-head p');
  const eyebrow = document.querySelector('#counter-order-panel .counter-order-head .eyebrow');
  const placeButton = document.getElementById('counter-place-order');
  if (title)
    title.textContent = isDineIn
      ? `${table.area} · Table ${String(table.number).padStart(2, '0')}`
      : 'Takeaway';
  if (subtitle)
    subtitle.textContent = isDineIn
      ? 'Build a dine-in order, then send its KOT directly to the kitchen.'
      : 'Build a walk-in or phone order, then send it directly to the kitchen.';
  if (eyebrow) eyebrow.textContent = isDineIn ? 'Dine-in order' : 'Takeaway order';
  if (placeButton)
    placeButton.textContent = isDineIn
      ? `Place order · Table ${String(table.number).padStart(2, '0')}`
      : 'Place takeaway order';
  const viewKotButton = document.getElementById('view-table-kot');
  if (viewKotButton) {
    viewKotButton.hidden = !table?.orderId;
    viewKotButton.dataset.orderId = table?.orderId || '';
  }
  if (dineInActions) dineInActions.hidden = false;
  if (placeButton) placeButton.hidden = isDineIn;
  const opening = counterPanel.hidden;
  if (!opening) {
    counterPanel.hidden = true;
    document.body.classList.remove('is-counter-workspace');
    return;
  }
  closeOpenPanels('counter');
  counterPanel.hidden = false;
  document.body.classList.add('is-counter-workspace');
  window.scrollTo(0, 0);
  document.getElementById('counter-menu-items').innerHTML =
    '<p class="counter-empty">Loading menu…</p>';
  try {
    await Promise.all([loadAvailability(), refreshCounterLiveStatus()]);
    counterMenu = menuItems.filter((item) => !unavailable.has(item.key));
    renderCounterOrder();
    counterPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) {
    document.getElementById('counter-menu-items').innerHTML =
      `<p class="counter-empty">${esc(error.message)}</p>`;
    if (navigator.onLine)
      reportOrdersDiagnostic({
        message: `Counter menu could not load: ${error.message}`,
        source: 'counter menu',
      });
  }
}
const splitBillStyles = document.createElement('style');
splitBillStyles.textContent = `#split-bill-dialog{width:min(880px,calc(100vw - 28px));max-height:calc(100vh - 28px);padding:26px;border:0;border-radius:16px;color:#263b57;box-shadow:0 24px 70px rgba(20,32,52,.28)}#split-bill-dialog::backdrop{background:rgba(19,32,52,.45)}#split-bill-dialog h2{margin:0;font-size:23px}#split-bill-dialog>p{margin:7px 34px 20px 0;color:#697b91;font-size:13px;line-height:1.45}.split-close{position:absolute;top:14px;right:16px;width:34px;height:34px;border-radius:50%;color:#7c2533;background:#fff0f1;font-size:22px}.split-tabs{display:grid;grid-template-columns:repeat(3,1fr);border-bottom:1px solid #dbe5ef}.split-tabs button{padding:13px 8px;color:#51657d;background:#fff;font-weight:900}.split-tabs button.is-active{color:#9d2434;border-bottom:3px solid #c92a36;background:#fff2f3}.split-panel{padding:19px 0;min-height:255px}.split-counts{display:flex;flex-wrap:wrap;gap:8px;margin:15px 0}.split-counts button,.split-part-add{min-width:42px;padding:9px;border:1px solid #d8e1ec;border-radius:8px;color:#334b68;background:#fff;font-weight:900}.split-counts button.is-active,.split-part-add{color:#fff;background:#c92a36;border-color:#c92a36}.split-summary{padding:15px;border-radius:10px;color:#6d5120;background:#fff7df;font-size:14px}.split-group-list,.split-item-list{display:grid;gap:9px;margin-top:14px}.split-group-row,.split-item-row{display:flex;align-items:center;justify-content:space-between;gap:15px;padding:12px;border:1px solid #dfe7ef;border-radius:9px}.split-group-row small,.split-item-row small{display:block;margin-top:3px;color:#72839a}.split-item-row select{min-width:92px;padding:8px;border:1px solid #cbd8e5;border-radius:7px;background:#fff}.split-actions{display:flex;justify-content:flex-end;gap:10px;padding-top:17px;border-top:1px solid #e2e8ef}.split-actions button{padding:11px 16px;border-radius:8px;font-weight:900}.split-save{color:#fff;background:#c92a36}.split-cancel{color:#42566f;background:#f2f6fa}@media(max-width:600px){#split-bill-dialog{padding:20px}.split-tabs{grid-template-columns:1fr}.split-tabs button{border-bottom:1px solid #dbe5ef}.split-group-row,.split-item-row{align-items:flex-start;flex-direction:column}.split-item-row select{width:100%}}`;
document.head.appendChild(splitBillStyles);
const moveTableStyles = document.createElement('style');
moveTableStyles.textContent = `#move-table-dialog{width:min(760px,calc(100vw - 28px));padding:25px;border:0;border-radius:16px;color:#263b57;box-shadow:0 24px 70px rgba(20,32,52,.28)}#move-table-dialog::backdrop{background:rgba(19,32,52,.45)}#move-table-dialog h2{margin:0 0 7px}#move-table-dialog p{color:#68798f;font-size:13px;line-height:1.45}#move-table-dialog label{display:grid;gap:7px;margin:19px 0;color:#53677f;font-size:11px;font-weight:900;text-transform:uppercase}#move-table-target{padding:11px;border:1px solid #cfdbe8;border-radius:8px;color:#253b59;background:#fff;font:700 13px Manrope,sans-serif}.move-tabs{display:flex;border-bottom:1px solid #dbe3ec;margin:18px -25px 16px}.move-tabs button{padding:13px 25px!important;border-radius:0!important;background:#fff;color:#263b57}.move-tabs button.is-active{color:#b42638;background:#fff1f3;border-bottom:3px solid #c92a36}.move-choice-list{display:grid;gap:8px;max-height:190px;overflow:auto}.move-choice{display:flex;align-items:center;gap:10px;padding:10px 12px;border:1px solid #dbe3ec;border-radius:8px;cursor:pointer}.move-choice b{display:block}.move-choice small{color:#68798f}#move-table-dialog>div:last-child{display:flex;justify-content:flex-end;gap:9px;margin-top:20px}#move-table-dialog button{padding:10px 14px;border-radius:8px;font-weight:900}.move-table-close{position:absolute;top:13px;right:15px;width:34px;height:34px;padding:0!important;border-radius:50%!important;color:#7c2533;background:#fff0f1;font-size:22px}.move-table-confirm{color:#fff;background:#c92a36}.move-table-cancel{color:#42566f;background:#f2f6fa}@media(max-width:600px){#move-table-dialog{padding:20px}.move-tabs{margin-inline:-20px}.move-tabs button{padding:12px 10px!important;font-size:12px}}`;
document.head.appendChild(moveTableStyles);
const moveTablePickerStyles = document.createElement('style');
moveTablePickerStyles.textContent = `.move-table-target{display:grid;gap:16px;max-height:420px;margin-top:18px;overflow:auto}.move-table-area h3{margin:0 0 9px;color:#243650;font-size:14px}.move-table-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(72px,1fr));gap:10px}.move-table-choice{min-height:58px!important;padding:10px!important;border:1px dashed #9dabbc!important;border-radius:9px!important;color:#263d68!important;background:#fff!important;font-size:16px!important}.move-table-choice:hover{border-style:solid!important;border-color:#c92a36!important;background:#fff5f6!important}.move-table-choice.is-selected{color:#fff!important;border-style:solid!important;border-color:#c92a36!important;background:#c92a36!important;box-shadow:0 5px 12px rgba(201,42,54,.2)}@media(max-width:600px){.move-table-grid{grid-template-columns:repeat(auto-fill,minmax(58px,1fr));gap:8px}.move-table-choice{min-height:50px!important;font-size:14px!important}.move-table-target{max-height:330px}}`;
document.head.appendChild(moveTablePickerStyles);
let splitMode = 'equal',
  splitPartCount = 2,
  splitItemAssignments = [],
  splitPercentages = [50, 50];
function counterItemTotal(item) {
  return (Number(item.price) + (item.style ? 10 : 0)) * Number(item.quantity || 0);
}
function splitParts(count) {
  return Array.from({ length: count }, (_, index) => ({ label: `Part ${index + 1}`, items: [] }));
}
function renderSplitBill() {
  const content = document.getElementById('split-bill-content');
  if (!content) return;
  const total = counterCart.reduce((sum, item) => sum + counterItemTotal(item), 0);
  const counts = [2, 3, 4, 5, 6, 7, 8];
  if (splitMode === 'equal')
    content.innerHTML = `<div class="split-panel"><b>How many portions do you want to divide this bill into?</b><div class="split-counts">${counts.map((count) => `<button type="button" data-split-count="${count}" class="${count === splitPartCount ? 'is-active' : ''}">${count}</button>`).join('')}<input id="split-custom-count" type="number" min="2" max="20" value="${splitPartCount}" aria-label="Custom number of portions"></div><div class="split-group-list">${splitPercentages.map((percentage, index) => `<label class="split-group-row"><span><b>Part ${index + 1}</b><small>${counterMoney((total * percentage) / 100)}</small></span><span><input type="number" min="0.01" max="100" step="0.01" value="${percentage}" data-split-percentage="${index}"> %</span></label>`).join('')}</div><div class="split-summary">The percentages must total <b>100%</b>. Use equal shares or adjust each part.</div></div>`;
  else if (splitMode === 'group') {
    const groups = [
      ...new Map(counterCart.map((item) => [item.category || 'Other', []])).entries(),
    ];
    counterCart.forEach((item) =>
      groups.find(([category]) => category === (item.category || 'Other'))[1].push(item)
    );
    content.innerHTML = `<div class="split-panel"><b>Group items by menu category</b><p>Each category below will print as its own bill.</p><div class="split-group-list">${groups.map(([category, items]) => `<div class="split-group-row"><span><b>${esc(category)}</b><small>${items.map((item) => `${item.quantity}× ${esc(item.name)}`).join(', ')}</small></span><b>${counterMoney(items.reduce((sum, item) => sum + counterItemTotal(item), 0))}</b></div>`).join('')}</div></div>`;
  } else {
    const options = splitParts(splitPartCount)
      .map((part, index) => `<option value="${index}">${part.label}</option>`)
      .join('');
    content.innerHTML = `<div class="split-panel"><div><b>Assign each item to a bill</b><div class="split-counts">${counts
      .slice(0, 5)
      .map(
        (count) =>
          `<button type="button" data-split-count="${count}" class="${count === splitPartCount ? 'is-active' : ''}">${count} bills</button>`
      )
      .join(
        ''
      )}</div></div><div class="split-item-list">${counterCart.map((item, index) => `<label class="split-item-row"><span><b>${Number(item.quantity)}× ${esc(item.name)}</b><small>${esc(item.category || 'Other')}${item.portion ? ` · ${esc(item.portion)}` : ''} · ${counterMoney(counterItemTotal(item))}</small></span><select data-split-item="${index}">${options.replace(`value="${splitItemAssignments[index] || 0}"`, `value="${splitItemAssignments[index] || 0}" selected`)}</select></label>`).join('')}</div></div>`;
  }
  splitBillDialog
    .querySelectorAll('[data-split-mode]')
    .forEach((button) =>
      button.classList.toggle('is-active', button.dataset.splitMode === splitMode)
    );
}
function openSplitBill() {
  if (!counterCart.length) {
    document.getElementById('counter-order-status').textContent =
      'Add menu items before splitting a bill.';
    return;
  }
  splitMode = counterBillSplit?.mode || 'equal';
  splitPartCount = Math.max(2, counterBillSplit?.parts?.length || 2);
  splitPercentages =
    counterBillSplit?.mode === 'equal'
      ? counterBillSplit.parts.map((part) => Number(part.percentage) || 100 / splitPartCount)
      : Array.from({ length: splitPartCount }, () => 100 / splitPartCount);
  splitItemAssignments = counterCart.map((_, index) => index % splitPartCount);
  renderSplitBill();
  splitBillDialog.showModal();
}
function saveSplitBill() {
  let parts;
  if (splitMode === 'equal') {
    const percentageTotal = splitPercentages.reduce((sum, value) => sum + Number(value || 0), 0);
    if (Math.abs(percentageTotal - 100) > 0.01) {
      alert(`Percentages must total 100% (currently ${percentageTotal.toFixed(2)}%).`);
      return;
    }
    parts = splitParts(splitPartCount).map((part, index) => ({
      ...part,
      percentage: Number(splitPercentages[index]),
    }));
  } else if (splitMode === 'group')
    parts = [...new Map(counterCart.map((item) => [item.category || 'Other', []])).entries()].map(
      ([label]) => ({
        label,
        items: counterCart
          .filter((item) => (item.category || 'Other') === label)
          .map((item) => ({ ...item })),
      })
    );
  else {
    parts = splitParts(splitPartCount);
    counterCart.forEach((item, index) =>
      parts[Math.min(splitPartCount - 1, Number(splitItemAssignments[index]) || 0)].items.push({
        ...item,
      })
    );
    if (parts.some((part) => !part.items.length)) {
      alert('Assign at least one item to every bill, or reduce the number of bills.');
      return;
    }
  }
  counterBillSplit = { mode: splitMode, parts };
  splitBillDialog.close();
  document.getElementById('counter-order-status').textContent =
    `Split saved: ${parts.length} bill${parts.length === 1 ? '' : 's'} will print separately.`;
}
splitBillDialog.addEventListener('click', (event) => {
  const mode = event.target.closest('[data-split-mode]')?.dataset.splitMode;
  if (mode) {
    splitMode = mode;
    renderSplitBill();
    return;
  }
  const count = event.target.closest('[data-split-count]')?.dataset.splitCount;
  if (count) {
    splitPartCount = Number(count);
    splitPercentages = Array.from({ length: splitPartCount }, () => 100 / splitPartCount);
    splitItemAssignments = counterCart.map((_, index) => index % splitPartCount);
    renderSplitBill();
    return;
  }
  if (event.target.matches('[data-split-item]')) {
    splitItemAssignments[Number(event.target.dataset.splitItem)] = Number(event.target.value);
    return;
  }
  if (event.target.closest('.split-save')) {
    saveSplitBill();
    return;
  }
  if (event.target.closest('.split-cancel,.split-close')) splitBillDialog.close();
});
splitBillDialog.addEventListener('input', (event) => {
  if (event.target.id === 'split-custom-count') {
    splitPartCount = Math.max(2, Math.min(20, Number(event.target.value) || 2));
    splitPercentages = Array.from({ length: splitPartCount }, () => 100 / splitPartCount);
    renderSplitBill();
  }
  if (event.target.matches('[data-split-percentage]'))
    splitPercentages[Number(event.target.dataset.splitPercentage)] =
      Number(event.target.value) || 0;
});
splitBillDialog.addEventListener('change', (event) => {
  if (event.target.matches('[data-split-item]'))
    splitItemAssignments[Number(event.target.dataset.splitItem)] = Number(event.target.value);
});
function renderTableView() {
  const content = document.getElementById('table-view-content');
  if (!content) return;
  const areas = Array.isArray(operationsConfig.tableAreas) ? operationsConfig.tableAreas : [];
  if (!areas.length) {
    content.innerHTML = '';
    return;
  }
  const legend = [
    ['blank', 'Available'],
    ['running', 'Seated'],
    ['kot', 'KOT active'],
    ['printed', 'Bill ready'],
  ];
  const tableOrders = [...orderRecords.values()].filter(
    (order) => order.mode === 'table' && order.table_area && order.table_number
  );
  const tableState = (area, number) => {
    const order = tableOrders
      .filter(
        (item) =>
          String(item.table_area) === String(area) && Number(item.table_number) === Number(number)
      )
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
    if (!order) return { state: 'blank', label: 'Available', order: null };
    if (String(order.id || '').startsWith('offline:') || order.status === 'offline')
      return { state: 'running', label: 'Waiting to sync', order };
    const elapsedMinutes = Math.max(
      0,
      Math.floor((Date.now() - new Date(order.created_at).getTime()) / 60000)
    );
    const elapsedLabel =
      elapsedMinutes < 60
        ? `${elapsedMinutes} min ago`
        : `${Math.floor(elapsedMinutes / 60)}h ${elapsedMinutes % 60}m ago`;
    if (order.status === 'completed') return { state: 'paid', label: 'Paid · available', order };
    if (order.bill_printed_at) return { state: 'printed', label: 'Bill ready', order };
    if (['saved', 'held'].includes(order.status))
      return { state: 'running', label: elapsedLabel, order };
    if (['accepted', 'preparing', 'ready'].includes(order.status)) {
      const kots = operationKotHistory.get(order.id);
      return {
        state: Array.isArray(kots) && kots.length ? 'kot' : 'running',
        label: Array.isArray(kots) && kots.length ? 'KOT active' : elapsedLabel,
        order,
      };
    }
    return { state: 'running', label: String(order.status || 'Running'), order };
  };
  const activeTables = tableOrders.filter((order) => !['completed', 'cancelled', 'rejected'].includes(String(order.status))).length;
  const activeCount = document.getElementById('table-view-active-count');
  if (activeCount) activeCount.textContent = String(activeTables);
  const query = String(tableViewSearch || '').trim().toLowerCase();
  const visibleAreas = tableViewAreaFilter === 'all'
    ? areas
    : areas.filter((area) => String(area.name) === String(tableViewAreaFilter));
  const matchesSearch = (area, number, table) => {
    if (!query) return true;
    const order = table.order || {};
    const haystack = [area, number, order.customer_name, order.customer_phone, ...(Array.isArray(order.items) ? order.items.map((item) => item.name) : [])]
      .join(' ')
      .toLowerCase();
    return haystack.includes(query);
  };
  const zoneTabs = `<div class="table-floor-toolbar"><div class="table-zone-tabs" role="tablist" aria-label="Dining areas"><button type="button" class="${tableViewAreaFilter === 'all' ? 'is-active' : ''}" data-table-area-filter="all" aria-pressed="${tableViewAreaFilter === 'all'}">All areas</button>${areas.map((area) => `<button type="button" class="${tableViewAreaFilter === area.name ? 'is-active' : ''}" data-table-area-filter="${esc(area.name)}" aria-pressed="${tableViewAreaFilter === area.name}">${esc(area.name)}</button>`).join('')}</div><label class="table-search"><span aria-hidden="true">⌕</span><input id="table-view-search" type="search" autocomplete="off" placeholder="Search table or guest" value="${esc(tableViewSearch)}"></label></div>`;
  content.innerHTML = `${zoneTabs}<div class="table-view-legend" aria-label="Table status legend"><button type="button" class="table-move-toggle${moveKotItemsMode ? ' is-active' : ''}" data-toggle-move-kot aria-pressed="${moveKotItemsMode}"><i></i>Move KOT / Items</button>${legend.map(([state, label]) => `<span><i class="is-${state}"></i>${label}</span>`).join('')}</div>${visibleAreas
    .map((area) => {
      const tables = Array.from(
        { length: Number(area.to) - Number(area.from) + 1 },
        (_, index) => Number(area.from) + index
      ).map((number) => ({ number, table: tableState(area.name, number) }))
        .filter(({ number, table }) => matchesSearch(area.name, number, table));
      if (!tables.length) return '';
      const totalTables = Number(area.to) - Number(area.from) + 1;
      return `<section class="table-area"><div class="table-area-head"><h3>${esc(area.name)}</h3><span>${totalTables} table${totalTables === 1 ? '' : 's'}</span></div><div class="table-grid">${tables
        .map(({ number, table }) => {
          const tableNumber = number,
            active = table.state !== 'blank' && table.state !== 'paid',
            movable = active && moveKotItemsMode,
            settling = table.state === 'printed' && !moveKotItemsMode;
          const guest = table.order?.customer_name || 'Walk-in customer';
          const amount = Number(table.order?.total || 0);
          const status = movable ? 'Select to move' : settling ? 'Settle & save' : table.label;
          return `<button type="button" class="table-tile is-${table.state}${movable ? ' is-move-target' : ''}" data-dine-table-area="${esc(area.name)}" data-dine-table-number="${tableNumber}"${movable ? ` data-move-table-order="${esc(table.order.id)}"` : ''}${settling ? ` data-settle-table-order="${esc(table.order.id)}"` : ''} title="${esc(status)}"><div class="table-tile-top"><div><span>Table</span><b>${String(tableNumber).padStart(2, '0')}</b></div>${table.state !== 'blank' && table.state !== 'paid' ? `<em>${esc(status)}</em>` : ''}</div>${table.order && table.state !== 'paid' ? `<div class="table-tile-info"><small>${esc(guest)}</small><strong>${counterMoney(amount)}</strong></div>` : `<small>${esc(table.state === 'paid' ? 'Paid · available' : 'Available')}</small>`}</button>`;
        })
        .join('')}</div></section>`;
    })
    .join('') || '<div class="table-view-empty">No table or guest matches this search.</div>'}`;
  if (!moveKotItemsMode)
    content.querySelectorAll('.table-tile').forEach((tile) => {
      const table = tableState(tile.dataset.dineTableArea, Number(tile.dataset.dineTableNumber));
      if (!table.order || ['blank', 'paid'].includes(table.state)) return;
      const wrap = document.createElement('div');
      wrap.className = 'table-tile-wrap';
      const actions = document.createElement('div');
      actions.className = 'table-tile-actions';
      actions.setAttribute('role', 'group');
      actions.setAttribute(
        'aria-label',
        `Table ${String(tile.dataset.dineTableNumber).padStart(2, '0')} quick actions`
      );
      actions.innerHTML = `<button type="button" class="table-tile-action" data-print-table-bill="${esc(table.order.id)}" aria-label="Print bill for table ${esc(String(tile.dataset.dineTableNumber))}" title="Print bill"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9V3h12v6M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2M6 14h12v7H6zM18 12h.01"/></svg></button><button type="button" class="table-tile-action" data-view-table-order="${esc(table.order.id)}" aria-label="View order for table ${esc(String(tile.dataset.dineTableNumber))}" title="View order"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"/></svg></button>`;
      tile.replaceWith(wrap);
      wrap.append(tile, actions);
    });
  const storedBills = [...orderRecords.values()].filter(
    (order) => order.mode === 'table' && ['saved', 'held'].includes(order.status)
  );
  if (storedBills.length)
    content.insertAdjacentHTML(
      'beforeend',
      `<section class="saved-bills"><div><span class="eyebrow">Dine-in workspace</span><h3>Saved bills</h3><p>Saved bills have not printed. Held bills remain open for later service.</p></div><div class="saved-bills-list">${storedBills.map((order) => `<button type="button" class="saved-bill-open" data-open-saved-table="${esc(order.table_area || 'Dining')}" data-open-saved-number="${esc(order.table_number)}"><span class="saved-bill-status is-${esc(order.status)}">${esc(order.status)}</span><span><b>${esc(order.table_area || 'Dining')} · Table ${esc(String(order.table_number || '').padStart(2, '0'))}</b><small>Bill #${esc(String(order.bill_number || order.daily_order_number || '').padStart(2, '0'))} · ${counterMoney(order.total)}</small></span><span class="saved-bill-note">Open bill</span></button>`).join('')}</div></section>`
    );
}
async function showTableView() {
  setOrdersRailActive('tables');
  tableViewPanel.hidden = false;
  if (Array.isArray(operationsConfig.tableAreas) && operationsConfig.tableAreas.length)
    renderTableView();
  else
    document.getElementById('table-view-content').innerHTML =
      '<div class="table-view-empty">Loading allocated tables…</div>';
  try {
    await loadOrders();
    renderTableView();
    void loadOperations()
      .then(() => {
        if (!tableViewPanel.hidden) renderTableView();
      })
      .catch(() => {});
  } catch (error) {
    document.getElementById('table-view-content').innerHTML =
      `<div class="table-view-empty">${esc(error.message)}</div>`;
  }
}
function openMoveTable(orderId) {
  const order = orderRecords.get(orderId);
  if (!order) return;
  const occupied = new Set(
    [...orderRecords.values()]
      .filter(
        (item) =>
          item.id !== orderId &&
          item.mode === 'table' &&
          ['saved', 'held', 'accepted', 'preparing', 'ready'].includes(item.status)
      )
      .map((item) => `${item.table_area}::${item.table_number}`)
  );
  const targets = (operationsConfig.tableAreas || [])
    .flatMap((area) =>
      Array.from({ length: Number(area.to) - Number(area.from) + 1 }, (_, index) => ({
        area: area.name,
        number: Number(area.from) + index,
      }))
    )
    .filter(
      (table) =>
        !occupied.has(`${table.area}::${table.number}`) &&
        !(table.area === order.table_area && table.number === Number(order.table_number))
    );
  if (!targets.length) {
    alert('No available tables are configured.');
    return;
  }
  moveTableDialog.dataset.orderId = orderId;
  moveTableDialog.dataset.mode = 'table';
  document.getElementById('move-table-copy').textContent =
    `Choose what to move from ${order.table_area} · Table ${String(order.table_number).padStart(2, '0')}.`;
  const targetGroups = targets.reduce((groups, table) => {
    (groups[table.area] ||= []).push(table);
    return groups;
  }, {});
  document.getElementById('move-table-target').innerHTML = Object.entries(targetGroups)
    .map(
      ([area, tables]) =>
        `<section class="move-table-area"><h3>${esc(area)}</h3><div class="move-table-grid">${tables.map((table, index) => `<button type="button" class="move-table-choice${index === 0 && area === Object.keys(targetGroups)[0] ? ' is-selected' : ''}" data-move-table-area="${esc(table.area)}" data-move-table-number="${table.number}" aria-pressed="${index === 0 && area === Object.keys(targetGroups)[0] ? 'true' : 'false'}">${String(table.number).padStart(2, '0')}</button>`).join('')}</div></section>`
    )
    .join('');
  renderMoveOptions();
  document.getElementById('move-table-status').textContent = '';
  moveTableDialog.showModal();
}
function renderMoveOptions() {
  const order = orderRecords.get(moveTableDialog.dataset.orderId),
    mode = moveTableDialog.dataset.mode || 'table',
    content = document.getElementById('move-table-options');
  document
    .querySelectorAll('[data-move-mode]')
    .forEach((button) => button.classList.toggle('is-active', button.dataset.moveMode === mode));
  if (!order || !content) return;
  if (mode === 'table') {
    content.innerHTML =
      '<p><b>Table Wise:</b> move the complete running order and its KOT history to the selected empty table.</p>';
    return;
  }
  if (mode === 'kot') {
    const kots = operationKotHistory.get(order.id) || [];
    content.innerHTML = `<p><b>KOT Wise:</b> choose KOTs to transfer.</p><div class="move-choice-list">${kots.length ? kots.map((kot) => `<label class="move-choice"><input type="checkbox" value="${esc(kot.kot_number)}"><span><b>KOT #${esc(kot.kot_number)}</b><small>${esc(new Date(kot.created_at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }))}</small></span></label>`).join('') : '<p>No printed KOTs are available for this table.</p>'}</div>`;
    return;
  }
  content.innerHTML = `<p><b>Item Wise:</b> choose individual items to transfer.</p><div class="move-choice-list">${(order.items || []).map((item, index) => `<label class="move-choice"><input type="checkbox" value="${index}"><span><b>${Number(item.quantity || 0)}× ${esc(item.name)}</b><small>${esc(item.portion || item.category || '')}</small></span></label>`).join('') || '<p>No items are available for this table.</p>'}</div>`;
}
moveTableDialog.addEventListener('click', async (event) => {
  if (event.target.closest('.move-table-close,.move-table-cancel')) {
    moveTableDialog.close();
    return;
  }
  const modeButton = event.target.closest('[data-move-mode]');
  if (modeButton) {
    moveTableDialog.dataset.mode = modeButton.dataset.moveMode;
    renderMoveOptions();
    return;
  }
  const target = event.target.closest('[data-move-table-area]');
  if (target) {
    document.querySelectorAll('[data-move-table-area]').forEach((choice) => {
      const selected = choice === target;
      choice.classList.toggle('is-selected', selected);
      choice.setAttribute('aria-pressed', String(selected));
    });
    return;
  }
  if (!event.target.closest('.move-table-confirm')) return;
  if ((moveTableDialog.dataset.mode || 'table') !== 'table') {
    document.getElementById('move-table-status').textContent =
      'Select the KOTs or items, then use the transfer action that is being added to this workflow.';
    return;
  }
  const button = event.target.closest('.move-table-confirm'),
    selectedTarget = document.querySelector('[data-move-table-area].is-selected'),
    tableArea = selectedTarget?.dataset.moveTableArea || '',
    tableNumber = selectedTarget?.dataset.moveTableNumber || '';
  if (!tableArea || !tableNumber) {
    document.getElementById('move-table-status').textContent = 'Choose an available table first.';
    return;
  }
  button.disabled = true;
  document.getElementById('move-table-status').textContent = 'Moving table…';
  try {
    const payload = {
      orderId: moveTableDialog.dataset.orderId,
      tableArea,
      tableNumber: Number(tableNumber),
    };
    if (
      await queueWhenOffline('order-table', payload, () => {
        const order = orderRecords.get(payload.orderId);
        if (order) {
          order.table_area = tableArea;
          order.table_number = Number(tableNumber);
        }
        cacheTableOrders([...orderRecords.values()]);
        renderTableView();
      })
    ) {
      moveTableDialog.close();
      return;
    }
    const response = await fetch(`/api/orders/${encodeURIComponent(payload.orderId)}/table`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tableArea, tableNumber: Number(tableNumber) }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Unable to move the table.');
    moveTableDialog.close();
    await showTableView();
  } catch (error) {
    document.getElementById('move-table-status').textContent =
      error.message || 'Unable to move the table.';
  } finally {
    button.disabled = false;
  }
});
if (installButton)
  installButton.innerHTML = `${actionIcon('install')}<span>Install shortcut</span>`;
if (availabilityButton)
  availabilityButton.innerHTML = `${actionIcon('cutlery')}<span>Menu availability</span>`;
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
const newOrderStyles = document.createElement('style');
newOrderStyles.textContent =
  '.new-order-button{padding:10px 15px!important;border-radius:9px!important;color:#fff!important;background:linear-gradient(135deg,#3267bd,#24529d)!important;font-weight:900!important}';
document.head.appendChild(newOrderStyles);
const tableViewStyles = document.createElement('style');
tableViewStyles.textContent = `#table-view-panel{margin:20px 28px 0;padding:24px;border:1px solid #dce4ee;border-radius:18px;background:#f7f9fc}#table-view-panel[hidden]{display:none}.table-view-head h2{margin:4px 0;color:#243650}.table-view-content{margin-top:20px}.table-view-legend{display:flex;flex-wrap:wrap;align-items:center;gap:12px 18px;margin-bottom:18px;color:#52647c;font-size:12px;font-weight:800}.table-view-legend span,.table-move-toggle{display:inline-flex;align-items:center;gap:7px}.table-view-legend i,.table-move-toggle i{display:block;width:11px;height:11px;border-radius:50%;background:#e7ecf2}.table-move-toggle{padding:9px 12px;border-radius:9px;color:#1d2b40;background:#e9e9ea;font:800 12px Manrope,sans-serif}.table-move-toggle i{width:18px;height:18px;background:#fff}.table-move-toggle.is-active{color:#fff;background:#8bdca4}.table-view-legend .is-running{background:#5bc0eb}.table-view-legend .is-printed{background:#52c878}.table-view-legend .is-paid{background:#f4b860}.table-view-legend .is-kot{background:#f6c945}.table-area{padding:18px;border:1px solid #dfe7f0;border-radius:14px;background:#fff}.table-area+.table-area{margin-top:14px}.table-area-head{display:flex;justify-content:space-between;margin-bottom:14px}.table-area-head h3{margin:0;color:#243650}.table-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(116px,1fr));gap:12px}.table-tile{min-height:106px;padding:14px;border:1px dashed #cbd6e2;border-radius:12px;background:#fbfcfd}.table-tile.is-running{background:#e3f6fd;border-color:#5bc0eb}.table-tile.is-printed{background:#e7f8ec;border-color:#52c878}.table-tile.is-paid{background:#fff3df;border-color:#f4b860}.table-tile.is-kot{background:#fff8d8;border-color:#f6c945}.table-tile.is-move-target{background:#e8faee!important;border:1px solid #62d884!important;box-shadow:0 0 0 2px #62d88422}.table-tile span,.table-tile b,.table-tile small{display:block}.table-tile span{color:#7b8ba0;font-size:10px;font-weight:900;text-transform:uppercase}.table-tile b{margin:6px 0;color:#263d68;font-size:23px}.table-tile small{color:#168454;font-size:11px;font-weight:900}.table-tile.is-kot small{color:#c92a36}`;
document.head.appendChild(tableViewStyles);
const tableTileActionStyles = document.createElement('style');
tableTileActionStyles.textContent = `.table-tile-wrap{position:relative;min-width:0}.table-tile-wrap .table-tile{width:100%;height:100%}.table-tile-actions{position:absolute;right:8px;bottom:8px;display:flex;gap:5px}.table-tile-action{display:grid;width:30px;height:30px;place-items:center;padding:0;border:1px solid #abc1d8;border-radius:7px;color:#193a65;background:#fff;box-shadow:0 2px 5px rgba(25,49,80,.13);font-size:15px;font-weight:900}.table-tile-action:hover,.table-tile-action:focus-visible{border-color:#246ce0;color:#fff;background:#246ce0;outline:0}.table-tile-action:disabled{opacity:.65}@media(max-width:560px){.table-tile-actions{right:6px;bottom:6px}.table-tile-action{width:28px;height:28px}}`;
document.head.appendChild(tableTileActionStyles);
const tableTileIconStyles = document.createElement('style');
tableTileIconStyles.textContent = `.table-tile-action svg{width:20px;height:20px;fill:none;stroke:currentColor;stroke-linecap:round;stroke-linejoin:round;stroke-width:1.9}`;
document.head.appendChild(tableTileIconStyles);
const tableTileActionLayoutStyles = document.createElement('style');
tableTileActionLayoutStyles.textContent = `.table-tile-wrap{display:grid;gap:7px}.table-tile-actions{position:static;justify-content:center}.table-tile-wrap .table-tile{min-height:106px}`;
document.head.appendChild(tableTileActionLayoutStyles);
const tableViewReferenceStyles = document.createElement('style');
tableViewReferenceStyles.textContent = `
#table-view-panel{margin:22px 28px 0;padding:28px;border:1px solid #dfe7f0;border-radius:20px;background:#f6f8fc;box-shadow:0 12px 30px rgba(32,53,82,.06)}
.table-view-head{display:flex;align-items:end;justify-content:space-between;gap:18px}.table-view-head .eyebrow{color:#d32b38}.table-view-head h2{margin:4px 0;color:#182a45;font-size:27px;letter-spacing:-.04em}.table-view-head p{margin:0;color:#677991;font-weight:650}.table-view-head-note{display:grid;min-width:98px;padding:10px 13px;border:1px solid #d9e4ef;border-radius:13px;color:#71829a;background:#fff;text-align:center}.table-view-head-note b{color:#16375a;font-size:21px;line-height:1}.table-view-head-note span{margin-top:4px;font-size:10px;font-weight:900;letter-spacing:.05em;text-transform:uppercase}
.table-floor-toolbar{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:16px}.table-zone-tabs{display:flex;max-width:100%;gap:4px;overflow:auto;padding:4px;border:1px solid #dce5ef;border-radius:999px;background:#fff;box-shadow:0 2px 6px rgba(30,54,84,.04)}.table-zone-tabs button{flex:0 0 auto;min-height:36px;padding:7px 15px;border:0;border-radius:999px;color:#5a6b82;background:transparent;font-size:12px;font-weight:900}.table-zone-tabs button:hover{transform:none;filter:none;color:#1d304b;background:#eef3f8}.table-zone-tabs button.is-active{color:#fff;background:#1f304a;box-shadow:0 3px 8px rgba(25,44,69,.22)}
.table-search{display:flex;align-items:center;gap:8px;min-width:245px;padding:0 12px;border:1px solid #dce5ef;border-radius:999px;color:#8a9bb1;background:#fff}.table-search span{font-size:21px;line-height:1}.table-search input{width:100%;height:40px;border:0;outline:0;color:#23364f;background:transparent;font:700 12px Manrope,sans-serif}.table-search input::placeholder{color:#9aa9bd}
.table-view-legend{justify-content:flex-end;margin:0 0 20px;padding:0;color:#667990}.table-view-legend span{gap:7px}.table-view-legend .is-running{background:#12b981}.table-view-legend .is-printed{background:#7b61c9}.table-view-legend .is-paid{background:#f4b860}.table-view-legend .is-kot{background:#f59e0b}.table-move-toggle{margin-right:auto;border:1px solid #dce5ef;color:#50627a;background:#fff;box-shadow:0 2px 6px rgba(30,54,84,.04)}
.table-area{padding:0;border:0;background:transparent}.table-area+.table-area{margin-top:30px}.table-area-head{align-items:center;margin:0 0 14px}.table-area-head h3{color:#1d2d47;font-size:20px;letter-spacing:-.025em}.table-area-head h3:after{content:'';display:inline-block;width:clamp(80px,18vw,230px);height:1px;margin-left:14px;vertical-align:middle;background:#d8e2ee}.table-area-head span{color:#667a96;font-size:12px;font-weight:850}.table-grid{grid-template-columns:repeat(auto-fill,minmax(172px,1fr));gap:14px}
.table-tile-wrap{position:relative;display:block;min-width:0;min-height:154px}.table-tile-wrap .table-tile{height:100%;min-height:154px}.table-tile{display:flex;min-height:154px;padding:16px;border:1px solid #dce5ef;border-radius:16px;color:#21344e;background:#fff;text-align:left;box-shadow:0 5px 12px rgba(31,52,84,.08);transition:transform .16s,box-shadow .16s,border-color .16s}.table-tile:hover{transform:translateY(-2px);filter:none;border-color:#aebfd2;box-shadow:0 11px 21px rgba(31,52,84,.13)}.table-tile.is-blank{align-items:center;justify-content:center;border:2px dashed #ccd9e8;color:#9aabc0;background:transparent;text-align:center;box-shadow:none}.table-tile.is-blank:hover{border-color:#d32b38;background:#fff}.table-tile.is-blank .table-tile-top{display:block}.table-tile.is-blank .table-tile-top b{margin:6px 0 0;color:#c6d3e4;font-size:38px}.table-tile.is-blank>small{margin-top:7px;color:#8e9eb3;font-size:11px}.table-tile.is-running{border-left:5px solid #12b981;background:#fff}.table-tile.is-kot{border-left:5px solid #f4ac12;background:#fff}.table-tile.is-printed{border-left:5px solid #7b61c9;background:#fff}.table-tile.is-paid{align-items:center;justify-content:center;border:2px dashed #d7dfeb;color:#92a2b8;background:#f9fbfd;text-align:center;box-shadow:none}
.table-tile-top{display:flex;width:100%;justify-content:space-between;gap:9px}.table-tile-top span{color:#8798ad;font-size:10px;font-weight:900;letter-spacing:.1em;text-transform:uppercase}.table-tile-top b{margin:3px 0 0;color:#182a45;font-size:30px;line-height:1}.table-tile-top em{padding:6px 8px;border-radius:7px;color:#087a50;background:#eafaf3;font-size:10px;font-style:normal;font-weight:900;white-space:nowrap}.table-tile.is-kot .table-tile-top em{color:#a65d00;background:#fff6df}.table-tile.is-printed .table-tile-top em{color:#5e469e;background:#f0ecff}.table-tile-info{align-self:flex-end;width:100%;padding-bottom:25px}.table-tile-info small,.table-tile-info strong{display:block}.table-tile-info small{overflow:hidden;color:#687a92;font-size:11px;font-weight:750;text-overflow:ellipsis;white-space:nowrap}.table-tile-info strong{margin-top:4px;color:#087c50;font-size:18px}.table-tile.is-kot .table-tile-info strong{color:#243650}
.table-tile-actions{position:absolute;right:10px;bottom:10px;display:flex;gap:5px}.table-tile-action{width:29px;height:29px;border-color:#dbe5ef;border-radius:8px;color:#526780;background:#fff;box-shadow:0 2px 7px rgba(31,52,84,.12)}.table-tile-action:hover,.table-tile-action:focus-visible{color:#fff;background:#263d68}
/* Keep every card's content in one vertical flow. Without an explicit direction,
   occupied table metadata competes for the same horizontal row and escapes the card. */
.table-tile,.table-tile-wrap .table-tile{box-sizing:border-box;min-width:0;flex-direction:column;align-items:stretch;justify-content:flex-start;overflow:hidden}.table-tile:focus-visible{outline:3px solid #2563eb;outline-offset:2px}.table-tile-top{min-width:0;align-items:flex-start}.table-tile-top>div{min-width:0}.table-tile-top em{max-width:82px;overflow:hidden;line-height:1.15;text-align:center;text-overflow:ellipsis}.table-tile-info{box-sizing:border-box;align-self:stretch;min-width:0;margin-top:auto;padding:14px 0 0}.table-tile-info small,.table-tile-info strong{max-width:100%}.table-tile-info strong{max-width:calc(100% - 80px);margin-top:10px;line-height:1.1}.table-tile.is-blank,.table-tile.is-paid{align-items:center;justify-content:center}.table-tile.is-blank .table-tile-top{width:auto}.table-tile.is-blank>small{margin:7px 0 0}.table-tile-actions{z-index:1;right:12px;bottom:12px;gap:6px}.table-tile-action{width:34px;height:34px;border-radius:9px}
@media(max-width:780px){#table-view-panel{margin:14px 16px 0;padding:18px}.table-view-head{align-items:start}.table-view-head h2{font-size:23px}.table-floor-toolbar{align-items:stretch;flex-direction:column}.table-search{min-width:0}.table-view-legend{justify-content:flex-start}.table-move-toggle{margin-right:0}.table-grid{grid-template-columns:repeat(auto-fill,minmax(142px,1fr));gap:10px}.table-tile,.table-tile-wrap,.table-tile-wrap .table-tile{min-height:142px}.table-area-head h3:after{width:45px}.table-tile-top b{font-size:27px}}
`;
document.head.appendChild(tableViewReferenceStyles);
const settleTableStyles = document.createElement('style');
settleTableStyles.textContent = `#settle-table-dialog{width:min(620px,calc(100vw - 28px));padding:26px;border:0;border-radius:16px;color:#263b57;box-shadow:0 24px 70px #14213d55}#settle-table-dialog::backdrop{background:#14213d8a}#settle-table-dialog h2{margin:0}#settle-table-dialog>p{color:#68798f}#settle-table-dialog fieldset{display:flex;flex-wrap:wrap;gap:13px;margin:20px 0;padding:14px;border:1px solid #dbe4ee;border-radius:10px}#settle-table-dialog legend{font-weight:900}#settle-table-dialog label{display:grid;gap:7px;font-weight:800}#settle-table-dialog input[type=number]{padding:11px;border:1px solid #cfdbe8;border-radius:8px;font:700 14px Manrope,sans-serif}#settle-table-dialog>div:last-child{display:flex;justify-content:flex-end;gap:10px;margin-top:22px}#settle-table-dialog button{padding:11px 16px;border-radius:8px;font-weight:900}.settle-confirm{color:#fff;background:#c92a36}.settle-cancel{background:#f2f6fa}.settle-close{position:absolute;top:14px;right:16px;font-size:23px}`;
document.head.appendChild(settleTableStyles);
const viewKotStyles = document.createElement('style');
viewKotStyles.textContent = `#view-table-kot{margin-right:9px;color:#2563c9;background:#eef5ff;text-decoration:underline}#view-kot-dialog{width:min(620px,calc(100vw - 28px));max-height:80vh;padding:24px;border:0;border-radius:15px;color:#253b59;box-shadow:0 24px 70px #14213d55}#view-kot-dialog::backdrop{background:#14213d8a}#view-kot-dialog h2{margin:0 0 18px}.view-kot-close{position:absolute;right:15px;top:12px;font-size:23px}.view-kot-ticket{margin:12px 0;border:1px solid #dce5ef;border-radius:10px;overflow:hidden}.view-kot-ticket h3{margin:0;padding:11px 13px;background:#edf2f7;font-size:15px}.view-kot-ticket h3 small{float:right;color:#68798f}.view-kot-ticket div{display:flex;align-items:center;gap:8px;padding:10px 13px;border-top:1px solid #edf1f5}.view-kot-ticket span{margin-left:auto;font-weight:800}.view-kot-edit,.view-kot-delete{margin-left:8px;padding:5px 8px;border-radius:6px;font-size:10px;font-weight:900}.view-kot-edit{color:#1f5da8;background:#eef5ff}.view-kot-delete{color:#b4232b;background:#fff0f1}`;
document.head.appendChild(viewKotStyles);
const counterChoiceStyles = document.createElement('style');
counterChoiceStyles.textContent = `
.counter-choice-dialog{width:min(650px,calc(100vw - 32px));max-height:calc(100dvh - 32px);padding:0;border:0;border-radius:20px;color:#182641;background:#fff;box-shadow:0 28px 80px rgba(15,27,48,.35);overflow:auto}.counter-choice-dialog::backdrop{background:rgba(24,36,57,.56);backdrop-filter:blur(2px)}.counter-choice-dialog .dialog-close{position:absolute;z-index:2;top:18px;right:20px;display:grid;width:42px;height:42px;place-items:center;padding:0;border:1px solid #dce5ef;border-radius:10px;color:#71839a;background:#fff;font-size:28px;font-weight:400;line-height:1}.counter-choice-dialog .dialog-close:hover{color:#c31f35;border-color:#f0bdc4;background:#fff5f6;filter:none;transform:none}.counter-choice-title{padding:27px 32px 22px;border-bottom:1px solid #e8edf3}.counter-choice-title>span{display:block;margin-right:58px;color:#71829a;font-size:11px;font-weight:900;letter-spacing:.11em;text-transform:uppercase}.counter-choice-title>span:before{display:inline-block;width:13px;height:13px;margin-right:10px;border:2px solid #d3283d;border-radius:3px;vertical-align:-2px;background:radial-gradient(circle,#d3283d 0 4px,transparent 5px);content:''}.counter-choice-dialog h2{margin:5px 58px 0 0;color:#111d35;font-size:30px;line-height:1.1;letter-spacing:-.045em}.counter-portion-section{padding:26px 32px 8px}.counter-choice-section-head{display:flex;align-items:center;justify-content:space-between;gap:14px;margin-bottom:16px}.counter-choice-section-head h3{margin:0;color:#1e2b42;font-size:16px;letter-spacing:-.02em}.counter-choice-section-head small{padding:5px 8px;border-radius:6px;color:#62738b;background:#eef3f8;font-size:10px;font-weight:900;letter-spacing:.04em;text-transform:uppercase}.counter-choice-options{display:grid;gap:12px;margin:0}.counter-choice-options label{display:block;cursor:pointer}.counter-choice-options input{position:absolute;opacity:0;pointer-events:none}.counter-choice-options span{display:grid;grid-template-columns:28px minmax(0,1fr) auto;align-items:center;gap:13px;min-height:82px;padding:16px 20px;border:1px solid #dce5ef;border-radius:11px;color:#25334b;background:#fff;transition:border-color .16s,background .16s,box-shadow .16s}.counter-choice-options span:hover{border-color:#c1cfde;background:#fbfcfe}.counter-choice-options span i{display:block;width:21px;height:21px;border:2px solid #c7d4e2;border-radius:50%;background:#fff}.counter-choice-options span strong{font-size:20px;letter-spacing:-.02em}.counter-choice-options span b{color:#44536b;font-size:21px;letter-spacing:-.03em}.counter-choice-options input:checked+span{border:2px solid #c61f34;color:#1d2a41;background:#fffafa;box-shadow:0 5px 13px rgba(192,31,52,.07)}.counter-choice-options input:checked+span i{position:relative;border-color:#c61f34;background:#c61f34}.counter-choice-options input:checked+span i:after{position:absolute;top:4px;left:6px;width:6px;height:3px;border-bottom:2px solid #fff;border-left:2px solid #fff;transform:rotate(-45deg);content:''}.counter-choice-options input:checked+span b{color:#bd1e33}.counter-style-options{display:flex;flex-wrap:wrap;gap:9px;margin:18px 32px 0;padding:13px 15px;border:1px solid #e1e8f0;border-radius:11px}.counter-style-options legend{padding:0 5px;color:#63748b;font-size:11px;font-weight:900}.counter-style-options label{font-size:12px;font-weight:750}.counter-style-options b{color:#148251}.counter-course-choice{display:grid;gap:8px;margin:22px 32px 0;color:#1e2b42;font-size:16px;font-weight:850}.counter-course-choice select{width:100%;min-height:58px;padding:0 18px;border:1px solid #d7e1ec;border-radius:10px;color:#27364e;background:#f9fbfd;font:800 16px Manrope,sans-serif}.counter-course-choice select:focus{outline:0;border-color:#c61f34;box-shadow:0 0 0 3px rgba(198,31,52,.1)}.counter-choice-dialog #counter-choice-add{display:flex;width:calc(100% - 64px);align-items:center;justify-content:space-between;gap:12px;margin:26px 32px 32px;padding:18px 22px;border-radius:10px;color:#fff;background:linear-gradient(135deg,#d72d43,#bc172e);box-shadow:0 10px 18px rgba(190,26,49,.22);font-size:19px;font-weight:900}.counter-choice-dialog #counter-choice-add span{display:flex;align-items:center;gap:12px}.counter-choice-dialog #counter-choice-add i{font-size:29px;font-style:normal;font-weight:400;line-height:.5}.counter-choice-dialog #counter-choice-add b{font-size:22px;letter-spacing:-.03em}.counter-choice-dialog #counter-choice-add:hover{filter:brightness(1.03);transform:translateY(-1px)}@media(max-width:560px){.counter-choice-dialog{width:calc(100vw - 20px);border-radius:16px}.counter-choice-title{padding:23px 20px 18px}.counter-choice-dialog .dialog-close{top:14px;right:14px;width:37px;height:37px}.counter-choice-dialog h2{font-size:25px}.counter-portion-section{padding:21px 20px 4px}.counter-choice-options span{min-height:70px;padding:13px 15px}.counter-choice-options span strong{font-size:17px}.counter-choice-options span b{font-size:18px}.counter-style-options{margin-inline:20px}.counter-course-choice{margin-inline:20px;font-size:14px}.counter-course-choice select{min-height:50px;font-size:14px}.counter-choice-dialog #counter-choice-add{width:calc(100% - 40px);margin:22px 20px 20px;padding:16px;font-size:16px}.counter-choice-dialog #counter-choice-add b{font-size:19px}}
`;
document.head.appendChild(counterChoiceStyles);
const counterLayoutRefinements = document.createElement('style');
counterLayoutRefinements.textContent = `.counter-menu-items{align-items:start;grid-auto-rows:150px}.counter-menu-item{height:150px;min-height:0}.counter-category-group{display:block;padding:13px 14px 7px;color:#9a2635;background:#f8fafc;font-size:10px;font-weight:900;letter-spacing:.09em;text-transform:uppercase}.counter-category-group~.counter-category{min-height:54px}.counter-cart{height:auto;min-height:0;align-self:start}.counter-cart-items{display:block;height:clamp(190px,28vh,260px);min-height:0;flex:0 0 auto;overflow-y:auto;margin:14px 0}.counter-cart-line{min-height:0;height:72px;padding:10px 0}.counter-customer{flex:0 0 auto;margin-top:0}.counter-customer textarea{resize:none}.counter-total,.counter-place-order,.counter-order-status{flex:0 0 auto}@media(max-width:800px){.counter-menu-items{grid-auto-rows:130px}.counter-menu-item{height:130px}.counter-category-group{display:none}.counter-cart-items{height:220px;max-height:45vh}}`;
document.head.appendChild(counterLayoutRefinements);
const counterSmartKdsCourseStyles = document.createElement('style');
counterSmartKdsCourseStyles.textContent = `.counter-course-choice,.counter-line-course{display:flex;align-items:center;gap:7px;margin:12px 0;color:#5d6d84;font-size:11px;font-weight:900}.counter-course-choice select,.counter-line-course select{min-height:30px;padding:5px 7px;border:1px solid #d4deea;border-radius:7px;color:#26344e;background:#fff;font:700 11px Manrope,sans-serif}.counter-line-course{margin:7px 0 0;font-size:9px;text-transform:uppercase}.counter-cart-line{height:auto!important;min-height:72px}@media(max-width:800px){.counter-cart-line{min-height:84px}}`;
document.head.appendChild(counterSmartKdsCourseStyles);
const counterChoiceRefinementStyles = document.createElement('style');
counterChoiceRefinementStyles.textContent = `
#counter-choice-dialog .counter-course-choice{display:grid;align-items:stretch;gap:8px;margin:22px 32px 0;color:#1e2b42;font-size:16px;font-weight:850;text-transform:none}#counter-choice-dialog .counter-course-choice select{width:100%;min-height:58px;padding:0 18px;border:1px solid #d7e1ec;border-radius:10px;color:#27364e;background:#f9fbfd;font:800 16px Manrope,sans-serif}#counter-choice-dialog .counter-course-choice select:focus{outline:0;border-color:#c61f34;box-shadow:0 0 0 3px rgba(198,31,52,.1)}@media(max-width:560px){#counter-choice-dialog .counter-course-choice{margin-inline:20px;font-size:14px}#counter-choice-dialog .counter-course-choice select{min-height:50px;font-size:14px}}
`;
document.head.appendChild(counterChoiceRefinementStyles);
const counterChoiceCompactStyles = document.createElement('style');
counterChoiceCompactStyles.textContent = `
#counter-choice-dialog{width:min(590px,calc(100vw - 32px)}#counter-choice-dialog .dialog-close{top:15px;right:16px;width:38px;height:38px;font-size:25px}.counter-choice-title{padding:20px 26px 16px}.counter-choice-title>span{font-size:10px}.counter-choice-dialog h2{margin-top:4px;font-size:26px}.counter-portion-section{padding:18px 26px 3px}.counter-choice-section-head{margin-bottom:11px}.counter-choice-section-head h3{font-size:15px}.counter-choice-options{gap:9px}.counter-choice-options span{min-height:64px;padding:11px 15px;gap:11px}.counter-choice-options span strong{font-size:17px}.counter-choice-options span b{font-size:19px}.counter-style-options{margin:14px 26px 0;padding:10px 12px}.counter-course-choice,#counter-choice-dialog .counter-course-choice{gap:6px;margin:15px 26px 0;font-size:14px}.counter-course-choice select,#counter-choice-dialog .counter-course-choice select{min-height:48px;padding-inline:14px;font-size:14px}.counter-choice-dialog #counter-choice-add{width:calc(100% - 52px);margin:18px 26px 24px;padding:14px 18px;font-size:16px}.counter-choice-dialog #counter-choice-add i{font-size:24px}.counter-choice-dialog #counter-choice-add b{font-size:19px}@media(max-width:560px){#counter-choice-dialog{width:calc(100vw - 20px)}.counter-choice-title{padding:19px 18px 15px}.counter-portion-section{padding-inline:18px}.counter-choice-options span{min-height:61px}.counter-style-options{margin-inline:18px}.counter-course-choice,#counter-choice-dialog .counter-course-choice{margin-inline:18px}.counter-choice-dialog #counter-choice-add{width:calc(100% - 36px);margin:18px 18px 20px}}
`;
document.head.appendChild(counterChoiceCompactStyles);
const counterWorkspaceStyles = document.createElement('style');
counterWorkspaceStyles.textContent = `
#counter-order-panel{max-width:none;margin:14px 12px 0;padding:0;overflow:hidden;border:1px solid #dfe6ef;border-radius:16px;background:#f7f9fc;box-shadow:0 12px 28px rgba(30,48,77,.08)}
.counter-order-head{align-items:center;min-height:76px;padding:14px 20px;border-bottom:1px solid #e4eaf1;background:#fff}.counter-order-head .eyebrow{margin:0;color:#bc263d;font-size:10px}.counter-order-head h2{margin:3px 0 0;color:#172840;font-size:23px;letter-spacing:-.04em}.counter-order-head p{margin-top:3px;color:#728199;font-size:11px;font-weight:700}.counter-back{min-height:36px;padding:8px 11px;border:1px solid #dce4ee;border-radius:8px;color:#3e5778;background:#fff;font-size:11px;box-shadow:none}.counter-back:hover{border-color:#b7c7d9;color:#bd263d;background:#fff5f6;filter:none;transform:none}
.counter-order-layout{display:grid;grid-template-columns:minmax(0,1fr) minmax(350px,410px);gap:0;min-height:calc(100dvh - 190px);margin:0}.counter-menu{display:grid;grid-template-columns:210px minmax(0,1fr);grid-template-rows:76px minmax(0,1fr);gap:0;padding:0;border:0;border-radius:0;background:#f7f9fc}.counter-search{grid-column:2;grid-row:1;align-self:center;margin:0 20px;padding:0 14px;border-color:#e1e7ef;border-radius:10px;background:#fff}.counter-search:focus-within{border-color:#d33a4b;box-shadow:0 0 0 3px rgba(211,58,75,.1)}.counter-search input{height:44px;color:#243752;font-size:13px}.counter-search input::placeholder{color:#95a2b4}
.counter-categories{grid-column:1;grid-row:1 / 3;max-height:none;padding:12px 0;border:0;border-right:1px solid #e2e8f0;border-radius:0;background:#fff}.counter-category-group{padding:16px 18px 7px;color:#9a2638;background:#fff;font-size:9px}.counter-category{min-height:43px;padding:9px 18px;border:0;border-right:3px solid transparent;color:#596a81;background:#fff;font-size:12px}.counter-category:first-child{margin-bottom:4px;color:#b8253a;background:#fff5f6}.counter-category:hover{color:#bd263d;background:#fff7f8}.counter-category.is-active{color:#c3263c;border-right-color:#cf293f;background:#fff1f3;box-shadow:none}.counter-category-group~.counter-category{min-height:42px}
.counter-menu-items{grid-column:2;grid-row:2;align-content:start;grid-template-columns:repeat(auto-fill,minmax(174px,1fr));grid-auto-rows:142px;gap:14px;max-height:none;padding:4px 20px 22px;overflow:auto}.counter-menu-item{height:142px;padding:14px;border:1px solid #e1e7ef;border-left:3px solid #d63146;border-radius:12px;background:#fff;box-shadow:0 3px 9px rgba(34,53,83,.045)}.counter-menu-item:hover{border-color:#c9d4e1;border-left-color:#c52a40;background:#fff;box-shadow:0 8px 16px rgba(34,53,83,.09);transform:translateY(-1px)}.counter-menu-item span{color:#8391a5;font-size:9px}.counter-menu-item b{margin:7px 26px 7px 0;color:#243651;font-size:13px}.counter-menu-item small{position:absolute;bottom:14px;left:14px;color:#172940;font-size:18px}.counter-menu-item i{right:13px;bottom:13px;width:30px;height:30px;border-radius:8px;color:#6d819d;background:#f1f5f9;font-size:25px;font-weight:500}.counter-menu-item:hover i{color:#fff;background:#ca2c42}
.counter-cart{position:relative;min-height:0;max-height:calc(100dvh - 190px);padding:19px 20px;border:0;border-left:1px solid #e2e8f0;border-radius:0;background:#fff;box-shadow:none}.counter-cart-head{align-items:center;padding-bottom:14px;border-bottom:1px solid #e8edf3}.counter-cart-head h3{color:#172840;font-size:18px;letter-spacing:-.025em}.counter-clear{padding:7px 0;color:#c82b3f;background:transparent;font-size:10px}.counter-clear:hover{background:transparent;filter:none;transform:none;text-decoration:underline}.counter-cart-items{height:clamp(175px,31vh,300px);margin:12px 0;overflow-y:auto}.counter-cart-line{grid-template-columns:minmax(0,1fr) auto;gap:10px;min-height:0!important;height:auto!important;padding:12px 0}.counter-cart-line>strong{display:none}.counter-cart-line b{color:#263751;font-size:12px}.counter-cart-line small{font-size:10px}.counter-quantity{grid-column:2;grid-row:1;gap:0;border:1px solid #e0e7ef;border-radius:8px;overflow:hidden}.counter-quantity button{width:29px;height:29px;border-radius:0;color:#536b88;background:#fff;font-size:16px}.counter-quantity b{display:grid;min-width:28px;height:29px;place-items:center;border-inline:1px solid #e0e7ef;font-size:12px}.counter-line-course{grid-column:1 / -1;margin:2px 0 0}.counter-line-course select{min-height:26px;font-size:10px}
.counter-customer{grid-template-columns:1fr 1fr;gap:9px;margin-top:auto;padding-top:13px;border-top:1px solid #e8edf3}.counter-customer label{gap:5px;font-size:9px}.counter-customer label:nth-of-type(3),.counter-customer label:nth-of-type(4),#counter-wallet{grid-column:1 / -1}.counter-customer input,.counter-customer textarea,.counter-customer select{min-height:37px;padding:8px 10px;border-color:#e0e7ef;border-radius:8px;font-size:11px}.counter-customer textarea{min-height:44px}.counter-total{margin-top:13px;padding:14px 0;border-top:1px solid #e2e9f1}.counter-total span{color:#74849b;font-size:10px;text-transform:uppercase}.counter-total b{color:#172840;font-size:25px}.counter-place-order{padding:13px;border-radius:9px;background:linear-gradient(135deg,#d72e43,#b71931);box-shadow:0 7px 14px rgba(193,32,55,.16)}#dine-in-actions{gap:7px;margin-top:11px;padding-top:11px;border-top:1px solid #e8edf3}#dine-in-actions button{min-height:39px;font-size:10px}.counter-order-status{margin:7px 0 0}.counter-empty{grid-column:1/-1;margin:44px 0;color:#8291a5}
@media(max-width:1100px){.counter-order-layout{grid-template-columns:1fr;min-height:0}.counter-cart{max-height:none;border-top:1px solid #e2e8f0;border-left:0}.counter-cart-items{height:230px}.counter-menu{min-height:570px}}@media(max-width:760px){#counter-order-panel{margin:10px 12px 0}.counter-order-head{padding:13px 14px}.counter-order-head h2{font-size:19px}.counter-order-head p{display:none}.counter-order-layout{display:block}.counter-menu{display:grid;min-height:0;grid-template-columns:1fr;grid-template-rows:auto auto auto}.counter-search{grid-column:1;grid-row:1;margin:12px}.counter-categories{grid-column:1;grid-row:2;display:flex;max-height:none;padding:0 10px 10px;overflow-x:auto;border:0;border-bottom:1px solid #e2e8f0}.counter-category-group{display:none}.counter-category{width:auto;min-width:max-content;min-height:36px!important;padding:8px 11px;border-right:0;border-bottom:3px solid transparent;font-size:11px}.counter-category:first-child{margin:0}.counter-category.is-active{border-right:0;border-bottom-color:#ce293f}.counter-menu-items{grid-column:1;grid-row:3;grid-template-columns:repeat(2,minmax(0,1fr));grid-auto-rows:130px;gap:10px;padding:12px}.counter-menu-item{height:130px;padding:12px}.counter-menu-item small{left:12px;bottom:12px;font-size:15px}.counter-menu-item i{right:10px;bottom:10px;width:27px;height:27px}.counter-cart{padding:16px}.counter-customer{grid-template-columns:1fr}.counter-customer label:nth-of-type(3),.counter-customer label:nth-of-type(4){grid-column:auto}.counter-cart-items{height:220px}}
`;
document.head.appendChild(counterWorkspaceStyles);
const counterWorkspacePolishStyles = document.createElement('style');
counterWorkspacePolishStyles.textContent = `
.counter-menu-items{grid-template-columns:repeat(auto-fill,minmax(215px,1fr));grid-auto-rows:154px}.counter-menu-item{display:flex;height:154px;flex-direction:column;padding:15px}.counter-menu-item b{display:-webkit-box;overflow:hidden;margin:7px 32px 0 0;line-height:1.3;-webkit-line-clamp:2;-webkit-box-orient:vertical}.counter-menu-item small{position:static;display:block;margin-top:auto;padding-right:38px;overflow:hidden;font-size:16px;line-height:1.15;text-overflow:ellipsis;white-space:nowrap}.counter-menu-item i{right:14px;bottom:14px}.counter-cart-items .counter-empty{display:grid;min-height:142px;margin:6px 0;place-items:center;padding:18px;border:1px dashed #d5dfeb;border-radius:11px;color:#788aa2;background:#fafcff;font-size:11px;font-weight:750;line-height:1.45;text-align:center}.counter-cart-items .counter-empty:before{display:block;width:32px;height:32px;margin:0 auto 7px;place-content:center;border-radius:50%;color:#b3c0d0;background:#edf2f7;content:'+';font-size:21px;font-weight:500}@media(min-width:1750px){.counter-menu-items{grid-template-columns:repeat(auto-fill,minmax(230px,1fr))}}@media(max-width:760px){.counter-menu-items{grid-template-columns:repeat(2,minmax(0,1fr));grid-auto-rows:136px}.counter-menu-item{height:136px}.counter-menu-item small{font-size:14px}.counter-cart-items .counter-empty{min-height:110px}}
`;
document.head.appendChild(counterWorkspacePolishStyles);
const counterWorkspaceScrollStyles = document.createElement('style');
counterWorkspaceScrollStyles.textContent = `
@media(min-width:761px){body.is-counter-workspace{overflow:hidden}body.is-counter-workspace .fulfillment-actions,body.is-counter-workspace>.order-search-panel,body.is-counter-workspace>#orders,body.is-counter-workspace>#order-status-filters{display:none!important}body.is-counter-workspace #counter-order-panel{height:calc(100dvh - 94px);min-height:600px;margin-top:10px}body.is-counter-workspace .counter-order-layout{height:calc(100% - 76px);min-height:0}body.is-counter-workspace .counter-menu{height:100%;min-height:0}body.is-counter-workspace .counter-categories{min-height:0;overflow-y:auto}body.is-counter-workspace .counter-menu-items{min-height:0;height:100%;overflow-y:auto;overscroll-behavior:contain}body.is-counter-workspace .counter-cart{height:100%;max-height:none;min-height:0}body.is-counter-workspace .counter-cart-items{height:auto;min-height:0;flex:1 1 auto;overscroll-behavior:contain}body.is-counter-workspace .counter-cart-items .counter-empty{height:100%;min-height:0}body.is-counter-workspace .counter-customer{margin-top:0}body.is-counter-workspace .counter-order-status{min-height:0}}
`;
document.head.appendChild(counterWorkspaceScrollStyles);
const counterWorkspaceSafetyStyles = document.createElement('style');
counterWorkspaceSafetyStyles.textContent = `#dine-in-actions[hidden]{display:none!important}.counter-place-order:disabled{cursor:not-allowed;opacity:.48;box-shadow:none;filter:grayscale(.15)}`;
document.head.appendChild(counterWorkspaceSafetyStyles);
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
const bridgeReadinessStyles = document.createElement('style');
bridgeReadinessStyles.textContent = `.operations-setup-card{border-color:#bcd7ca;background:linear-gradient(135deg,#fbfffc,#f1fbf5)}.operations-setup-card .operations-home-icon{color:#087348;background:#e3f7eb}.bridge-readiness{padding:24px;border:1px solid #d9e8df;border-radius:16px;background:linear-gradient(145deg,#fff,#f8fcf9)}.bridge-check-grid{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:10px;margin:22px 0}.bridge-check{display:flex;gap:9px;align-items:flex-start;padding:13px;border:1px solid #e0e8ec;border-radius:11px;background:#fff}.bridge-check>span{display:grid;width:23px;height:23px;place-items:center;flex:0 0 23px;border-radius:50%;color:#596b82;background:#edf2f7;font-weight:900}.bridge-check.is-ok>span{color:#087348;background:#e4f8ec}.bridge-check.is-warn>span{color:#a85c14;background:#fff1dc}.bridge-check b,.bridge-check small{display:block}.bridge-check b{color:#283b56;font-size:12px}.bridge-check small{margin-top:3px;color:#728198;font-size:10px;line-height:1.35}.bridge-install-box{padding:17px;border:1px solid #ecd8b5;border-radius:13px;background:#fffaf0}.bridge-install-box>b{color:#574225;font-size:14px}.bridge-install-box p{margin:6px 0 10px;color:#6f604a;font-size:12px;line-height:1.45}.bridge-install-box code{display:block;padding:11px 12px;border-radius:9px;color:#263b59;background:#f0f4f8;font:800 12px ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-word}.bridge-install-box>div,.bridge-ready-actions{display:flex;gap:9px;align-items:center;margin-top:12px}.bridge-ready-actions{justify-content:flex-end}.bridge-ready-actions .quiet-button,.bridge-install-box .quiet-button{padding:10px 13px;border:1px solid #cdd9e6;border-radius:8px;color:#375170;background:#fff;font-size:12px;font-weight:800}@media(max-width:1000px){.bridge-check-grid{grid-template-columns:repeat(3,minmax(0,1fr))}}@media(max-width:620px){.bridge-readiness{padding:17px}.bridge-check-grid{grid-template-columns:1fr}.bridge-install-box>div,.bridge-ready-actions{align-items:stretch;flex-direction:column}.bridge-ready-actions{justify-content:stretch}.bridge-ready-actions button,.bridge-install-box button{width:100%}}`;
document.head.appendChild(bridgeReadinessStyles);
const bridgeDownloadStyles = document.createElement('style');
bridgeDownloadStyles.textContent = `.bridge-download{display:inline-flex;align-items:center;justify-content:center;padding:10px 13px;border:1px solid #168451;border-radius:8px;color:#fff!important;background:#168451!important;font-size:12px;font-weight:800;text-decoration:none}.bridge-download:hover{color:#fff;filter:brightness(.95)}.bridge-node-note{display:block;margin-top:10px;color:#78694f!important;font-size:11px!important}@media(max-width:620px){.bridge-install-box>div{align-items:stretch;flex-direction:column}.bridge-download{width:100%;text-align:center}}`;
document.head.appendChild(bridgeDownloadStyles);
const managePrintersStyles = document.createElement('style');
managePrintersStyles.textContent = `.manage-printers,.printer-assignment{padding:24px;border:1px solid #dfe7f1;border-radius:16px;background:#fff}.manage-printers-head{display:flex;justify-content:space-between;gap:18px;align-items:start}.manage-printers h3,.printer-assignment h3{margin:4px 0;color:#1e3150;font-size:23px}.manage-printers p,.printer-assignment p{margin:0;color:#687a91}.bridge-status{max-width:370px;padding:9px 12px;border-radius:9px;color:#8a5b13;background:#fff5dc;font-size:12px;font-weight:700}.bridge-status.online{color:#087348;background:#e8f7ef}.add-system-printer{display:flex;gap:10px;margin:22px 0}.add-system-printer select{flex:1;min-height:44px;padding:10px;border:1px solid #cfdceb;border-radius:9px}.add-system-printer button,.printer-table-row button{padding:10px 14px;background:#246ce0;color:#fff}.printer-table{border:1px solid #dfe6ee;border-radius:12px;overflow:hidden}.printer-table-head,.printer-table-row{display:grid;grid-template-columns:1.5fr .8fr 1fr auto;gap:16px;align-items:center;padding:16px 18px}.printer-table-head{color:#526680;background:#eef2f6;font-size:11px;font-weight:900;text-transform:uppercase}.printer-table-row+.printer-table-row{border-top:1px solid #e1e7ee}.printer-table-row b,.printer-table-row small{display:block}.printer-table-row b{color:#1d2f4a}.printer-table-row small{margin-top:4px;color:#76869a;font-size:11px}.assignment-tag{display:inline-block;margin:2px;padding:5px 9px;border-radius:999px;color:#087348;background:#e8f7ef;font-size:11px;font-style:normal;font-weight:800}.printer-table-row .remove-printer{margin-left:6px;color:#a52a39;background:#fff0f0}.assignment-back{display:inline-flex!important;align-items:center;min-height:38px;margin-bottom:17px;padding:8px 12px!important;border:1px solid #9bb7d9!important;border-radius:8px!important;color:#123a70!important;background:#dcecff!important;box-shadow:0 1px 2px rgba(18,58,112,.12);font-size:13px!important;font-weight:900!important}.assignment-back:hover,.assignment-back:focus-visible{border-color:#246ce0!important;color:#fff!important;background:#246ce0!important;outline:0;box-shadow:0 0 0 3px rgba(36,108,224,.2)}.assignment-choices{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;max-width:720px;margin-top:24px}.assignment-choices button{display:grid;gap:6px;padding:22px;text-align:left;color:#1e3150;background:#fff;border:1px solid #d6e0ea}.assignment-choices button:hover{border-color:#246ce0;background:#f4f8ff}.assignment-choices b{font-size:16px}.assignment-choices span{color:#718198}.assignment-category-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-top:22px}.assignment-category-grid label{display:flex;align-items:center;gap:9px;padding:12px;border:1px solid #dce5ee;border-radius:9px;color:#263b59;font-size:12px;font-weight:700}.assignment-category-grid input{width:17px;height:17px;accent-color:#168451}.assignment-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:22px}.assignment-actions button{padding:11px 15px;background:#eef3f8;color:#304562}.assignment-actions .operations-save{color:#fff;background:#168451}@media(max-width:760px){.manage-printers-head{display:grid}.printer-table-head{display:none}.printer-table-row{grid-template-columns:1fr;gap:8px}.add-system-printer{display:grid}.assignment-choices,.assignment-category-grid{grid-template-columns:1fr}}`;
document.head.appendChild(managePrintersStyles);
const printerRoutingSummaryStyles = document.createElement('style');
printerRoutingSummaryStyles.textContent = `.printer-table-row .routing-summary{margin-top:9px;padding:7px 9px;border-radius:7px;color:#355577;background:#f1f6fb;line-height:1.5}.printer-table-row .routing-summary b{display:inline;color:#23436c;font-size:11px}`;
document.head.appendChild(printerRoutingSummaryStyles);
const windowsOperationsPolishStyles = document.createElement('style');
windowsOperationsPolishStyles.textContent = `#operations-panel{max-width:1900px;margin:20px auto 32px;padding:clamp(24px,2vw,36px)}.manage-printers{padding:clamp(22px,2vw,32px);background:linear-gradient(145deg,#fff 0%,#fbfdff 100%)}.manage-printers-head{padding-bottom:20px;border-bottom:1px solid #e6edf5}.manage-printers h3{font-size:clamp(24px,1.6vw,30px);letter-spacing:-.03em}.manage-printers p{max-width:700px;font-size:14px;line-height:1.5}.bridge-status{display:flex;align-items:center;max-width:410px;min-height:42px;padding:10px 13px;font-size:12px;line-height:1.35}.add-system-printer{display:grid;grid-template-columns:minmax(210px,.72fr) minmax(220px,1fr) minmax(240px,1.1fr) auto;align-items:end;gap:14px;margin:24px 0}.add-printer-copy{display:grid;gap:4px;padding-bottom:2px}.add-printer-copy b{color:#203653;font-size:14px}.add-printer-copy span{color:#718299;font-size:12px;line-height:1.35}.quick-printer-name{display:grid;gap:6px;color:#526780;font-size:10px;font-weight:900;letter-spacing:.06em;text-transform:uppercase}.quick-printer-name input,.add-system-printer select{box-sizing:border-box;width:100%;min-height:48px;padding:11px 13px;border:1px solid #cfdceb;border-radius:9px;color:#203653;background:#fff;font:700 13px Manrope,sans-serif}.add-system-printer button{min-height:48px;padding:11px 17px;border-radius:10px;font-size:12px}.printer-card-list{display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:16px}.printer-card{display:grid;gap:18px;min-height:230px;padding:20px;border:1px solid #dbe5f0;border-radius:15px;background:#fff;box-shadow:0 5px 17px rgba(22,43,77,.055)}.printer-card:hover{border-color:#a9c1df;box-shadow:0 10px 24px rgba(22,43,77,.09)}.printer-card-top{display:grid;grid-template-columns:46px minmax(0,1fr) auto;gap:12px;align-items:start}.printer-card-mark{display:grid;width:46px;height:46px;place-items:center;border-radius:13px;color:#178154;background:#e8f8ef;font-size:23px;font-weight:900}.printer-card-mark.is-bill{color:#2d63ab;background:#eaf2ff}.printer-card-label{display:block;margin-bottom:3px;color:#71829b;font-size:10px;font-weight:900;letter-spacing:.08em;text-transform:uppercase}.printer-card h4{margin:0;color:#1c304f;font-size:17px;line-height:1.25}.printer-card p{margin:5px 0 0;overflow:hidden;color:#6d7f96;font-size:12px;text-overflow:ellipsis;white-space:nowrap}.printer-card-state{padding:6px 8px;border-radius:999px;color:#86611e;background:#fff4db;font-size:10px;font-weight:900;white-space:nowrap}.printer-card-state.is-ready{color:#087348;background:#e7f8ef}.printer-routing-summary{display:grid;gap:5px;min-height:64px;padding:12px;border:1px solid #e3ebf4;border-radius:10px;background:#f6f9fd}.printer-routing-summary b{color:#29486e;font-size:13px}.printer-routing-summary span{display:-webkit-box;overflow:hidden;color:#64768e;font-size:11px;line-height:1.45;-webkit-line-clamp:2;-webkit-box-orient:vertical}.printer-card-actions{display:flex;gap:9px;align-items:center}.printer-card-actions button{min-height:38px;padding:8px 12px;border-radius:8px;background:#246ce0;color:#fff;font-size:11px}.printer-card-actions .remove-printer{color:#aa2937;background:#fff0f1}@media(max-width:1100px){#operations-panel{margin:16px}.add-system-printer{grid-template-columns:1fr 1fr}.add-printer-copy{grid-column:1/-1}.bridge-status{max-width:none}}@media(max-width:640px){#operations-panel{margin:12px;padding:18px}.manage-printers{padding:18px}.manage-printers-head{display:grid;gap:14px}.add-system-printer{grid-template-columns:1fr}.printer-card-list{grid-template-columns:1fr}.printer-card{min-height:0}.printer-card-top{grid-template-columns:42px minmax(0,1fr)}.printer-card-state{grid-column:2;justify-self:start}.printer-card p{white-space:normal}.printer-card-actions{flex-wrap:wrap}}`;
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
const kitchenDisplayStyles = document.createElement('style');
kitchenDisplayStyles.textContent = `.kds{padding-top:10px}.kds-head{display:flex;justify-content:space-between;gap:18px;align-items:flex-start;margin-bottom:20px}.kds-head h3{margin:5px 0;color:#192d4b;font-size:25px}.kds-head p{margin:0;color:#6a7b91;font-size:13px}.kds-station-picker{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px}.kds-station-picker button{padding:8px 10px;border:1px solid #cddbe8;border-radius:8px;color:#51667f;background:#fff;font-size:11px;font-weight:900}.kds-station-picker button.is-active{border-color:#263d68;color:#fff;background:#263d68}.kds-station-picker span{color:#718197;font-size:11px}.kds-legend{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px}.kds-legend span{padding:6px 9px;border-radius:999px;background:#eef4fa;color:#52677f;font-size:10px;font-weight:900}.kds-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:16px}.kds-ticket{overflow:hidden;border:1px solid #dae5ee;border-radius:16px;background:#fff;box-shadow:0 8px 20px rgba(25,49,80,.08)}.kds-ticket[data-kds-status="accepted"]{border-top:5px solid #55b9df}.kds-ticket[data-kds-status="preparing"]{border-top:5px solid #f0ae27}.kds-ticket[data-kds-status="ready"]{border-top:5px solid #35a76a}.kds-ticket-top{display:flex;justify-content:space-between;gap:10px;padding:15px 16px 12px;background:#f8fbfd}.kds-ticket-top span{display:block;color:#6d8094;font-size:10px;font-weight:900;letter-spacing:.06em;text-transform:uppercase}.kds-ticket-top b{display:block;margin-top:4px;color:#203653;font-size:20px}.kds-table-badge{min-width:70px;margin-top:-15px;padding:11px 8px;border-radius:0 0 10px 10px;color:#fff;background:#2b9d60;text-align:center;box-shadow:0 5px 12px rgba(17,91,54,.16)}.kds-table-badge.is-counter{background:#d89120}.kds-table-badge small,.kds-table-badge b{display:block;color:inherit}.kds-table-badge small{font-size:9px;font-weight:800;text-transform:uppercase}.kds-table-badge b{margin-top:3px;font-size:18px}.kds-meta{display:flex;justify-content:space-between;gap:8px;padding:11px 16px;color:#52677f;font-size:12px}.kds-meta b{color:#b33842}.kds-station{margin:0 16px;padding:8px 10px;border-radius:8px;color:#107247;background:#e9f8ef;font-size:11px;font-weight:900}.kds-items{margin:12px 16px 0;padding:12px 0;border-top:1px solid #e7edf2;border-bottom:1px solid #e7edf2}.kds-items div{display:flex;justify-content:space-between;gap:12px;padding:5px 0;color:#263b57;font-size:14px;font-weight:800}.kds-items b{color:#b22736}.kds-note{margin:12px 16px 0;padding:9px 10px;border-radius:8px;color:#8b2834;background:#fff0f1;font-size:12px;font-weight:800}.kds-action{width:calc(100% - 32px);margin:15px 16px;padding:12px;border-radius:9px;color:#fff;background:#263d68;font-size:13px;font-weight:900}.kds-action.is-ready{background:#168451}.kds-action:disabled{opacity:.72}.kds-empty{grid-column:1/-1;padding:42px;border:1px dashed #cbd8e5;border-radius:15px;color:#718197;background:#fff;text-align:center}.kds-fullscreen{padding:9px 12px;border:1px solid #cbd9e7;border-radius:8px;color:#243b63;background:#fff;font-weight:900;font-size:11px}@media(max-width:620px){.kds-head{display:grid}.kds-grid{grid-template-columns:1fr}.kds-ticket-top b{font-size:18px}}`;
document.head.appendChild(kitchenDisplayStyles);
const tableAllocationStyles = document.createElement('style');
tableAllocationStyles.textContent = `.table-allocation-form{display:grid;grid-template-columns:minmax(230px,1.6fr) minmax(120px,.55fr) minmax(120px,.55fr) auto;gap:14px;align-items:end;margin:26px 0 18px;padding:20px;border:1px solid #dce7f2;border-radius:14px;background:linear-gradient(135deg,#f8fbff,#f3f8fd)}.table-allocation-form label{display:grid;gap:7px;color:#526780;font-size:11px;font-weight:900;letter-spacing:.06em;text-transform:uppercase}.table-allocation-form input{box-sizing:border-box;width:100%;min-height:46px;padding:10px 12px;border:1px solid #cbd9e8;border-radius:9px;color:#203653;background:#fff;font:700 14px Manrope,Arial,sans-serif}.table-allocation-form input:focus{border-color:#246ce0;outline:3px solid #dbeafe}.table-allocation-form button{min-height:46px;padding:10px 18px;border-radius:9px;white-space:nowrap}.table-allocation-list{display:grid;grid-template-columns:repeat(auto-fit,minmax(265px,1fr));gap:12px}.table-allocation-list article{display:flex;align-items:center;justify-content:space-between;gap:14px;min-height:86px;padding:16px 17px;border:1px solid #dce6f0;border-radius:12px;background:#fff;box-shadow:0 4px 13px rgba(25,49,80,.045)}.table-allocation-list article>div{display:grid;gap:5px}.table-allocation-list b{color:#1d3150;font-size:15px}.table-allocation-list span{color:#6a7d95;font-size:12px;font-weight:700}.table-allocation-list button{padding:8px 11px;border-radius:8px;color:#a82b3b;background:#fff0f1;font-size:11px;font-weight:900}.table-allocation-list .operations-empty{grid-column:1/-1;margin:0;padding:32px;border:1px dashed #cbd9e7;border-radius:12px;color:#718299;background:#fbfdff;text-align:center}.printer-assignment:has(.table-allocation-form)>h3{display:flex;align-items:center;gap:9px;font-size:26px}.printer-assignment:has(.table-allocation-form)>p{max-width:780px}@media(max-width:820px){.table-allocation-form{grid-template-columns:1fr 1fr}.table-allocation-form label:first-child{grid-column:1/-1}.table-allocation-form button{grid-column:1/-1;width:100%}}@media(max-width:520px){.table-allocation-form{grid-template-columns:1fr}.table-allocation-form label:first-child,.table-allocation-form button{grid-column:auto}.table-allocation-list{grid-template-columns:1fr}}`;
document.head.appendChild(tableAllocationStyles);
const printerActionStyles = document.createElement('style');
printerActionStyles.textContent = `.printer-card-actions{display:flex;align-items:center;justify-content:flex-end;gap:8px;margin-top:14px}.printer-action-icon{display:grid!important;width:38px;height:38px;place-items:center;padding:0!important;border:1px solid #d9e3ee!important;border-radius:9px!important;color:#304a72!important;background:#f8fbff!important;font-size:20px!important;line-height:1!important}.printer-action-icon:hover{border-color:#8ba5c5!important;background:#eaf2fd!important;transform:none!important}.printer-action-icon.is-delete{color:#b52c3b!important;background:#fff6f6!important}.printer-action-icon.is-delete:hover{border-color:#e6a5ad!important;background:#ffecee!important}.printer-assign-button{min-width:88px;height:38px;padding:0 14px!important;border:1px solid #263d68!important;border-radius:9px!important;color:#fff!important;background:#263d68!important;font-size:12px!important;font-weight:900!important}.printer-assign-button:hover{background:#34558a!important;transform:none!important}@media(max-width:520px){.printer-card-actions{justify-content:stretch}.printer-assign-button{flex:1}}`;
document.head.appendChild(printerActionStyles);
const managePrintersBackStyles = document.createElement('style');
managePrintersBackStyles.textContent = `.manage-printers-back{display:inline-flex;align-items:center;min-height:34px;margin:0 0 12px;padding:7px 10px;border:1px solid #9bb7d9;border-radius:8px;color:#123a70;background:#f4f8ff;font-size:12px;font-weight:900}.manage-printers-back:hover,.manage-printers-back:focus-visible{border-color:#246ce0;color:#fff;background:#246ce0;outline:0;box-shadow:0 0 0 3px rgba(36,108,224,.2)}`;
document.head.appendChild(managePrintersBackStyles);
const printerEditStyles = document.createElement('style');
printerEditStyles.textContent = `.printer-edit{max-width:1100px}.printer-edit>p{max-width:720px}.printer-edit-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;margin:24px 0}.printer-typography-fields{display:contents}.printer-layout-heading{grid-column:1/-1;margin:14px 0 -3px;padding:12px 14px;border-left:4px solid #b52936;border-radius:7px;background:#fff6f6;color:#7d1e35;font-size:12px;font-weight:900;letter-spacing:.04em;text-transform:uppercase}.printer-edit-grid label{display:grid;gap:7px;color:#4d5f78;font-size:11px;font-weight:900;letter-spacing:.06em;text-transform:uppercase}.printer-edit-grid label small{color:#77879c;font-size:10px;font-weight:700;letter-spacing:0;line-height:1.35;text-transform:none}.printer-edit-grid input:not([type=checkbox]),.printer-edit-grid select,.printer-edit-grid textarea{box-sizing:border-box;width:100%;min-height:44px;padding:10px 12px;border:1px solid #d2ddeb;border-radius:9px;color:#243650;background:#fff;font:700 13px Manrope,sans-serif}.printer-edit-grid textarea{min-height:88px;resize:vertical;line-height:1.45}.printer-edit-grid input:focus,.printer-edit-grid select:focus,.printer-edit-grid textarea:focus{outline:0;border-color:#2d66ad;box-shadow:0 0 0 3px rgba(45,102,173,.12)}.printer-edit-grid .printer-edit-check{display:flex;align-items:center;gap:9px;min-height:44px;padding:12px;border:1px solid #e0e7ef;border-radius:9px;color:#33445f;background:#fafcff;font-size:12px;letter-spacing:0;text-transform:none}.printer-edit-check input{width:18px;height:18px;margin:0;accent-color:#168451}.printer-edit .assignment-actions{margin-top:22px;padding-top:18px;border-top:1px solid #e3eaf2}@media(max-width:760px){.printer-edit-grid{grid-template-columns:1fr;gap:12px}.printer-edit .assignment-actions{flex-direction:column-reverse}.printer-edit .assignment-actions button{width:100%}}`;
printerEditStyles.textContent += `.printer-typography-fields{display:grid;grid-column:1/-1;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.printer-typography-fields>.printer-format-intro,.printer-typography-fields>.printer-format-group:last-child{grid-column:1/-1}.printer-format-fields{align-items:start}.printer-format-fields>label{display:flex;flex-direction:column;gap:7px;min-height:128px}.printer-format-fields>label>small{min-height:28px;order:3}.printer-format-fields>label>input,.printer-format-fields>label>select{order:2}.receipt-live-preview{grid-column:1/-1;display:grid;grid-template-columns:minmax(0,1fr) minmax(255px,330px);gap:24px;align-items:center;padding:22px;border:1px solid #d8e2ed;border-radius:14px;background:linear-gradient(135deg,#f7fbff,#eef5fa)}.receipt-live-preview>div:first-child{display:grid;gap:7px}.receipt-live-preview b{color:#1b3457;font-size:16px}.receipt-live-preview p{margin:0;color:#60738d;font-size:12px;line-height:1.5}.receipt-preview-paper{position:relative;justify-self:center;width:250px;min-height:390px;padding:calc(var(--top,0px) + 16px) calc(var(--right,0px) + 12px) calc(var(--bottom,0px) + 14px) calc(var(--left,0px) + 12px);border:1px solid #d8d1c7;border-radius:3px;background:#fffef9;box-shadow:0 12px 25px rgba(43,54,70,.16);color:#141414;font-family:var(--receipt-font,Arial),sans-serif;font-size:10px;line-height:1.28;transform:scale(var(--preview-scale,1));transform-origin:center}.receipt-preview-paper [data-preview-target]{cursor:pointer;border-radius:3px}.receipt-preview-paper [data-preview-target]:hover{outline:1px dashed #2d66ad;background:rgba(45,102,173,.08)}.receipt-preview-drag{position:absolute;z-index:3;display:grid;place-items:center;width:22px;height:22px;padding:0;border:1px solid #2d66ad;border-radius:50%;color:#fff;background:#2d66ad;box-shadow:0 2px 5px rgba(30,66,112,.25);font-size:12px;cursor:grab;touch-action:none}.receipt-preview-drag:active{cursor:grabbing}.receipt-preview-drag[data-preview-drag=left]{left:-12px;top:50%}.receipt-preview-drag[data-preview-drag=right]{right:-12px;top:50%}.receipt-preview-drag[data-preview-drag=top]{top:-12px;left:50%}.receipt-preview-drag[data-preview-drag=bottom]{bottom:-12px;left:50%}.receipt-preview-paper .rp-center{text-align:center}.receipt-preview-paper .rp-name{font-size:15px;font-weight:800}.receipt-preview-paper .rp-rule{height:1px;margin:10px 0;background:#232323}.receipt-preview-paper .rp-meta{display:flex;justify-content:space-between;gap:8px}.receipt-preview-paper .rp-table{display:grid;grid-template-columns:minmax(0,1fr) 24px 40px 52px;gap:4px}.receipt-preview-paper .rp-table span:not(:first-child){text-align:right}.receipt-preview-paper .rp-head{font-weight:800}.receipt-preview-paper .rp-grand{font-size:11px;font-weight:900}.receipt-preview-paper .rp-foot{margin-top:12px;text-align:center}@media(max-width:760px){.printer-typography-fields{grid-template-columns:1fr}.printer-typography-fields>.printer-format-group:last-child{grid-column:auto}.printer-format-fields>label{min-height:0}.receipt-live-preview{grid-template-columns:1fr}.receipt-preview-paper{transform:none}}`;
printerEditStyles.textContent += `.receipt-preview-column-drag{position:absolute;z-index:4;top:42%;bottom:22%;width:12px;padding:0;border:0;border-left:2px dashed #b52936;background:transparent;cursor:ew-resize;touch-action:none}.receipt-preview-column-drag::after{content:'↔';position:absolute;top:-18px;left:-8px;width:18px;height:18px;border-radius:50%;color:#fff;background:#b52936;font-size:11px;line-height:18px;text-align:center}.receipt-preview-column-drag:hover{border-left-color:#193a65}.receipt-column-values{grid-column:1/-1;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-top:4px;padding-top:12px;border-top:1px dashed #d8e2ed}.receipt-column-values label{min-height:0!important}`;
document.head.appendChild(printerEditStyles);
const esc = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' })[char]
  );
const money = (value) => `₹${Number(value || 0).toFixed(0)}`;
const fulfillmentLabel = (order) =>
  order?.mode === 'table'
    ? `${order.table_area || 'Dining'} · Table ${String(order.table_number || '').padStart(2, '0')}`
    : order?.mode === 'counter' || order?.fulfillment_type === 'takeaway'
      ? 'Takeaway'
      : order?.fulfillment_type === 'delivery'
        ? 'Delivery'
        : 'Pick Up';
const tomorrowLocal = () => {
  const date = new Date(Date.now() + 86400000);
  date.setSeconds(0, 0);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};
const toPushKey = (value) => {
  const padding = '='.repeat((4 - (value.length % 4)) % 4);
  const raw = atob((value + padding).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (character) => character.charCodeAt(0));
};

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/orders-sw.js?v=23');
document.getElementById('enable-notifications')?.addEventListener('click', async () => {
  closeOpenPanels();
  const button = document.getElementById('enable-notifications');
  const notificationApi = window.Notification;
  try {
    if (!notificationApi || !('PushManager' in window) || !('serviceWorker' in navigator))
      throw new Error(
        'Push alerts need the installed Orders shortcut. Use Install shortcut first.'
      );
    button.disabled = true;
    button.innerHTML = `${actionIcon('bell')}<span>Enabling…</span>`;
    const permission = await notificationApi.requestPermission();
    if (permission !== 'granted')
      throw new Error(
        'Alerts were not allowed. Enable notifications for RL Orders in this device’s settings.'
      );
    const keyResponse = await fetch('/api/orders/push-key', { cache: 'no-store' });
    const keyBody = await keyResponse.json();
    if (!keyResponse.ok) throw new Error(keyBody.error || 'Push alerts are not configured yet.');
    const registration = await navigator.serviceWorker.ready;
    const subscription =
      (await registration.pushManager.getSubscription()) ||
      (await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: toPushKey(keyBody.publicKey),
      }));
    const saveResponse = await fetch('/api/orders/push-subscriptions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription }),
    });
    const saveBody = await saveResponse.json();
    if (!saveResponse.ok) throw new Error(saveBody.error || 'Unable to enable push alerts.');
    button.innerHTML = `${actionIcon('bell')}<span>Alerts enabled</span>`;
  } catch (error) {
    button.innerHTML = `${actionIcon('bell')}<span>Enable alerts</span>`;
    const dialog = document.getElementById('shortcut-dialog');
    document.getElementById('shortcut-message').textContent = error.message;
    document.getElementById('shortcut-steps').innerHTML =
      '<li>Install the RL Orders shortcut on this device.</li><li>Open it once and tap Enable alerts.</li><li>Allow notifications when your device asks.</li>';
    if (typeof dialog?.showModal === 'function') dialog.showModal();
    else alert(error.message);
  } finally {
    button.disabled = false;
  }
});

async function loadOrders() {
  if (ordersRefreshInFlight) return;
  ordersRefreshInFlight = true;
  try {
    let query = String(orderSearch?.value || '')
      .replace(/\D/g, '')
      .slice(0, 16);
    const date = historyAll ? '' : String(historyDate?.value || '');
    const response = await fetch(
      `/api/orders?search=${encodeURIComponent(query)}&history=${orderView === 'history' ? '1' : '0'}&date=${encodeURIComponent(date)}`,
      { cache: 'no-store' }
    );
    if (!response.ok) throw new Error('Unable to refresh orders.');
    const rows = await response.json();
    if (!Array.isArray(rows)) throw new Error('Unable to read orders. Please refresh.');
    orderRecords = new Map(rows.map((order) => [order.id, order]));
    cacheTableOrders(rows);
    const orderDay = response.headers.get('X-Orders-Day') || '';
    const sessionOpen = response.headers.get('X-Orders-Session') !== 'closed';
    if (activeOrderDay && orderDay && activeOrderDay !== orderDay && orderSearch) {
      orderSearch.value = '';
      query = '';
    }
    activeOrderDay = orderDay || activeOrderDay;
    const ids = new Set(rows.map((order) => order.id));
    const notificationApi = window.Notification;
    if (
      orderView === 'current' &&
      !firstLoad &&
      notificationApi &&
      notificationApi.permission === 'granted'
    )
      rows
        .filter((order) => !known.has(order.id) && order.status === 'new')
        .forEach(
          (order) =>
            new notificationApi('New Direct Order', {
              body: `${order.customer_name || 'Guest'} · ${order.customer_phone}`,
              icon: '/images/red-lantern-logo-600.webp',
            })
        );
    if (orderView === 'current') known = ids;
    if (orderView === 'current') {
      const activeCount = String(
        rows.filter((order) => !['completed', 'rejected', 'cancelled'].includes(order.status)).length
      );
      document.querySelectorAll('#live-orders-count').forEach((count) => {
        count.textContent = activeCount;
      });
    }
    firstLoad = false;
    const statusRows =
      orderStatusFilter === 'all'
        ? rows
        : rows.filter((order) => order.status === orderStatusFilter);
    const visibleRows = fulfillmentFilter
      ? statusRows.filter(
          (order) => String(order.fulfillment_type || '').toLowerCase() === fulfillmentFilter
        )
      : statusRows;
    const emptyMessage = query
      ? 'No orders match that number.'
      : orderView === 'current' && !sessionOpen
        ? "The restaurant is closed. Today's orders are safely available in Order history."
        : 'No direct orders yet.';
    const filteredEmpty =
      orderStatusFilter !== 'all' ? `No ${orderStatusFilter} orders in this view.` : emptyMessage;
    const renderSignature = JSON.stringify({
      orderView,
      orderStatusFilter,
      fulfillmentFilter,
      query,
      date,
      sessionOpen,
      rows: visibleRows,
    });
    if (renderSignature !== renderedOrdersSignature) {
      root.innerHTML =
        visibleRows.map(renderOrder).join('') || `<div class="empty-state">${filteredEmpty}</div>`;
      renderedOrdersSignature = renderSignature;
      hasRenderedOrders = true;
    }
    root.classList.remove('is-stale');
    // This billing computer owns print dispatch. Retry all accepted live orders
    // after an outage or restart; stable bridge job IDs prevent duplicate tickets.
    if (orderView === 'current') {
      rows
        .filter(
          (order) =>
            order.status === 'accepted' ||
            (order.mode === 'table' && ['preparing', 'ready'].includes(order.status))
        )
        .forEach(autoPrintOrder);
      rows.filter((order) => order.mode === 'table' && order.service_state === 'bill_requested').forEach(
        autoPrintRequestedTableBill
      );
    }
    if (!tableViewPanel.hidden) renderTableView();
    const clearButton = document.getElementById('clear-order-search');
    const searchStatus = document.getElementById('order-search-status');
    if (clearButton) clearButton.hidden = !query;
    if (searchStatus)
      searchStatus.textContent = query
        ? `${visibleRows.length} matching order${visibleRows.length === 1 ? '' : 's'}`
        : orderView === 'history'
          ? `History · ${date || 'choose a date'}`
          : sessionOpen
            ? `${visibleRows.length} ${orderStatusFilter === 'all' ? 'current' : orderStatusFilter} order${visibleRows.length === 1 ? '' : 's'}`
            : 'Session closed · orders archived';
  } catch (error) {
    if (!hasRenderedOrders) {
      root.innerHTML = `<div class="empty-state">${esc(error.message)}</div>`;
      renderedOrdersSignature = '';
    } else {
      root.classList.add('is-stale');
      updateConnectivity('Connection problem — showing the last loaded orders.');
    }
    if (navigator.onLine)
      reportOrdersDiagnostic({
        message: `Live orders refresh failed: ${error.message}`,
        source: 'live orders refresh',
      });
  } finally {
    ordersRefreshInFlight = false;
    if (fastOrdersRefreshQueued) requestFastOrdersRefresh();
  }
}

function requestFastOrdersRefresh() {
  fastOrdersRefreshQueued = true;
  if (ordersRefreshInFlight || fastOrdersRefreshTimer) return;
  fastOrdersRefreshTimer = setTimeout(() => {
    fastOrdersRefreshTimer = null;
    fastOrdersRefreshQueued = false;
    void loadOrders();
  }, 25);
}

function printRelevantUpdate(type) {
  return /created|accepted|items-added|kot-created|bill-request|service-request|service-updated/i.test(
    String(type || '')
  );
}

async function pollPrintUpdates() {
  if (printUpdatePollInFlight || !navigator.onLine) return;
  printUpdatePollInFlight = true;
  try {
    const suffix = Number.isInteger(printUpdateCursor) ? `?after=${printUpdateCursor}` : '';
    const response = await fetch(`/api/orders/smart-kds/updates${suffix}`, {
      cache: 'no-store',
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || 'Unable to check printer updates.');
    const cursor = Number(payload.cursor);
    if (Number.isInteger(cursor) && cursor >= 0) printUpdateCursor = cursor;
    if ((payload.events || []).some((event) => printRelevantUpdate(event.type)))
      requestFastOrdersRefresh();
  } catch (_) {
    // The normal three-second refresh remains the final fallback.
  } finally {
    printUpdatePollInFlight = false;
  }
}

function connectFastPrintUpdates() {
  if (!window.EventSource) return;
  const stream = new EventSource('/api/orders/smart-kds/stream');
  stream.addEventListener('connected', () => {
    void pollPrintUpdates();
  });
  stream.addEventListener('smart-kds-update', (event) => {
    try {
      if (!printRelevantUpdate(JSON.parse(event.data || '{}').reason)) return;
    } catch (_) {}
    requestFastOrdersRefresh();
  });
}

function renderOrder(order) {
  const items = Array.isArray(order.items) ? order.items : [];
  const itemCount = items.reduce((count, item) => count + Number(item.quantity || 0), 0);
  const fallbackTotal = items.reduce(
    (sum, item) =>
      sum +
      Number(item.quantity || 0) *
        (Number(String(item.price || '').replace(/[^0-9.]/g, '')) + (item.style ? 10 : 0)),
    0
  );
  const storedTotal = Number(order.total);
  const total = storedTotal > 0 ? storedTotal : fallbackTotal;
  const age = Math.max(0, Math.floor((Date.now() - new Date(order.created_at)) / 60000));
  const placedAt = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  }).format(new Date(order.created_at));
  const orderCount = Number(order.customer_order_count || 1);
  const history = order.customer_last_order_at
    ? `Last ordered: ${new Date(order.customer_last_order_at).toLocaleDateString('en-IN')}`
    : 'First order';
  const dailyNumber = Number(order.daily_order_number);
  const orderNumber =
    Number.isFinite(dailyNumber) && dailyNumber > 0 ? String(dailyNumber).padStart(2, '0') : '—';
  const hasGuestContact =
    !!order.customer_phone && !String(order.customer_phone).startsWith('walkin-');
  const nextStatuses = {
    new: ['accepted', 'rejected'],
    accepted: ['preparing', 'ready', 'completed', 'rejected'],
    preparing: ['ready', 'completed', 'rejected'],
    ready: ['completed', 'rejected'],
  };
  const controls = (nextStatuses[order.status] || [])
    .map(
      (status) => `<button onclick="setStatus('${esc(order.id)}','${status}')">${status}</button>`
    )
    .join('');
  const canCancel = ['new', 'accepted', 'preparing', 'ready'].includes(order.status);
  const canModify = age < 10 && ['new', 'accepted', 'preparing'].includes(order.status);
  const service =
    order.mode === 'table' && order.service_state && order.service_state !== 'active'
      ? `<div class="request">Table service: <b>${esc(String(order.service_state).replace('_', ' '))}</b> <button data-clear-service="${esc(order.id)}">Handled</button></div>`
      : '';
  return `<article class="order" data-order-id="${esc(order.id)}"><div class="order-heading"><span class="daily-order-number">Order #${orderNumber}</span><span class="order-status">${esc(order.status)}</span></div><div class="order-reference">Ref ${esc(order.id)}</div><div class="order-time">${age} min ago</div><div class="placed-at"><span>Placed</span>${esc(placedAt)} <small>Goa time</small></div><div class="meta">${esc(order.customer_name || 'Walk-in customer')}${hasGuestContact ? ` · <b class="phone">${esc(order.customer_phone)}</b>` : ''}</div>${service}${hasGuestContact ? `<div class="customer-trust"><b>${orderCount === 1 ? 'New customer' : `${orderCount} orders from this number`}</b><span>${history}</span></div>` : ''}${order.special_request ? `<div class="request">Special request: ${esc(order.special_request)}</div>` : ''}${order.cancellation_reason ? `<div class="request">Cancelled: ${esc(order.cancellation_reason)}</div>` : ''}<div class="items">${items.map((item) => `<div><b>${Number(item.quantity || 0)}×</b> ${esc(item.name)} ${item.portion ? `(${esc(item.portion)})` : ''}${item.style ? ` — ${esc(item.style)} (+₹10)` : ''}</div>`).join('')}</div><div class="totals"><b>${itemCount} item${itemCount === 1 ? '' : 's'}</b><strong>Total ${money(total)}</strong></div><div class="actions">${controls}${canCancel ? `<button class="cancel-order" onclick="cancelOrder('${esc(order.id)}')">Cancel order</button>` : ''}${canModify ? `<button class="modify-order" data-modify-order="${esc(order.id)}">Modify order</button>` : ''}<button class="print" onclick="printOrder('${esc(order.id)}')">Print</button></div></article>`;
}

function renderOrders(rows) {
  const query = String(orderSearch?.value || '')
    .replace(/\D/g, '')
    .slice(0, 16);
  const statusRows =
    orderStatusFilter === 'all'
      ? rows
      : rows.filter((order) => order.status === orderStatusFilter);
  const visibleRows = fulfillmentFilter
    ? statusRows.filter(
        (order) => String(order.fulfillment_type || '').toLowerCase() === fulfillmentFilter
      )
    : statusRows;
  const searchedRows = query
    ? visibleRows.filter((order) => {
        const searchable = `${order.daily_order_number || ''}${order.customer_phone || ''}`.replace(
          /\D/g,
          ''
        );
        return searchable.includes(query);
      })
    : visibleRows;
  root.innerHTML =
    searchedRows.map(renderOrder).join('') ||
    `<div class="empty-state">${query ? 'No orders match that number.' : 'No orders in this view.'}</div>`;
  renderedOrdersSignature = '';
  hasRenderedOrders = true;
  if (!tableViewPanel.hidden) renderTableView();
}

async function setStatus(id, status, reason = '') {
  try {
    if (
      await queueWhenOffline('order-status', { orderId: id, status, reason }, () => {
        const order = orderRecords.get(id);
        if (order) order.status = status;
        renderOrders([...orderRecords.values()]);
      })
    )
      return;
    const response = await fetch(`/api/orders/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status, reason }),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || 'Unable to update the order status.');
    }
    await loadOrders();
    if (!operationsPanel?.hidden && ['kots', 'kitchen-display'].includes(operationsTab))
      await loadOperations();
  } catch (error) {
    alert(error.message || 'Unable to update the order status.');
  }
}
document.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-clear-service]');
  if (!button) return;
  button.disabled = true;
  try {
    const response = await fetch(
        `/api/orders/${encodeURIComponent(button.dataset.clearService)}/service`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ serviceState: 'active' }),
        }
      ),
      data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Unable to clear service request.');
    await loadOrders();
  } catch (error) {
    button.disabled = false;
    alert(error.message);
  }
});

async function cancelOrder(id) {
  const reason = window.prompt(
    'Why are you cancelling this order? This will remove it from the live kitchen queue.'
  );
  if (reason === null) return;
  if (reason.trim().length < 3) {
    alert('Please enter a brief cancellation reason.');
    return;
  }
  await setStatus(id, 'cancelled', reason.trim());
}

function openModifyOrder(id) {
  const order = orderRecords.get(id);
  if (!order || !Array.isArray(order.items)) return;
  let dialog = document.getElementById('modify-order-dialog');
  if (!dialog) {
    dialog = document.createElement('dialog');
    dialog.id = 'modify-order-dialog';
    dialog.className = 'modify-order-dialog';
    document.body.appendChild(dialog);
  }
  const rows = order.items
    .map(
      (item, index) =>
        `<label><span>${esc(item.name)}${item.portion ? ` · ${esc(item.portion)}` : ''}</span><input type="number" min="0" max="20" value="${Number(item.quantity || 0)}" data-modify-quantity="${index}"></label>`
    )
    .join('');
  dialog.innerHTML = `<button class="modify-close" aria-label="Close">×</button><span class="eyebrow">Staff only · first 10 minutes</span><h2>Modify order #${esc(String(order.daily_order_number || '').padStart(2, '0'))}</h2><p>Update quantities or set an item to 0 to remove it. Prices stay controlled by Admin.</p><div class="modify-items">${rows}</div><button class="modify-save">Save changes</button>`;
  dialog.showModal();
  dialog.querySelector('.modify-close').addEventListener('click', () => dialog.close());
  dialog.querySelector('.modify-save').addEventListener('click', async () => {
    const button = dialog.querySelector('.modify-save');
    button.disabled = true;
    try {
      const quantities = [...dialog.querySelectorAll('[data-modify-quantity]')].map((input) =>
        Number(input.value || 0)
      );
      if (
        await queueWhenOffline('order-items', { orderId: id, quantities }, () => {
          const order = orderRecords.get(id);
          if (order)
            order.items = (order.items || [])
              .map((item, index) => ({ ...item, quantity: quantities[index] }))
              .filter((item) => item.quantity > 0);
          renderOrders([...orderRecords.values()]);
        })
      ) {
        dialog.close();
        return;
      }
      const response = await fetch(`/api/orders/${encodeURIComponent(id)}/items`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ quantities }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Unable to modify this order.');
      dialog.close();
      loadOrders();
    } catch (error) {
      button.disabled = false;
      window.alert(error.message);
    }
  });
}

function splitReceiptParts(receipt, split) {
  if (!split?.parts?.length) return [receipt];
  const priceOf = (item) =>
    Number(String(item.price || 0).replace(/[^0-9.]/g, '')) + (item.style ? 10 : 0);
  const total = Math.max(
    0,
    Number(receipt.total) ||
      (receipt.items || []).reduce(
        (sum, item) => sum + priceOf(item) * Number(item.quantity || 0),
        0
      )
  );
  const percentageShares = split.mode === 'equal';
  let remaining = Math.round(total * 100);
  return split.parts
    .map((part, index) => {
      const items = percentageShares ? [] : (part.items || []).map((item) => ({ ...item }));
      const itemTotal = items.reduce(
        (sum, item) => sum + priceOf(item) * Number(item.quantity || 0),
        0
      );
      const cents = percentageShares
        ? index === split.parts.length - 1
          ? remaining
          : Math.round((total * 100 * Number(part.percentage || 0)) / 100)
        : Math.round(itemTotal * 100);
      remaining -= cents;
      const partTotal = cents / 100;
      return {
        ...receipt,
        items: percentageShares
          ? [{ name: `Bill share — ${part.label}`, quantity: 1, price: partTotal }]
          : items,
        total: partTotal,
        loyalty_points_redeemed: 0,
        special_request: [receipt.special_request, `Split bill: ${part.label}`]
          .filter(Boolean)
          .join(' · '),
      };
    })
    .filter((part) => Number(part.total) > 0);
}

async function requireCompletedBridgePrint(response, fallbackMessage) {
  const body = await response.json().catch(() => ({}));
  if (response.status === 202 || body.pending)
    throw new Error(
      'This print job is still in progress. Wait for it to finish; do not send another copy yet.'
    );
  if (!response.ok) throw new Error(body.error || fallbackMessage);
  return body;
}

async function printBillOnConfiguredPrinters(printers, order, printJobPrefix) {
  const results = await Promise.allSettled(
    printers.map(async (printer) => {
      const printerKey = String(printer.id || printer.deviceName)
        .replace(/[^a-zA-Z0-9_-]/g, '_')
        .slice(0, 80);
      const response = await fetch(`${printBridgeOrigin}/v1/print-bill`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          printJobId: `${printJobPrefix}:${printerKey}`,
          printerName: printer.deviceName,
          order,
          // Layout is always taken from the printer receiving this copy. No
          // bill queue inherits another printer's paper or typography settings.
          settings: printerFormat(printer, 'bill'),
        }),
      });
      await requireCompletedBridgePrint(response, `${printer.name || printer.deviceName} did not accept the bill.`);
      return printer;
    })
  );
  const failed = results
    .map((result, index) => ({ result, printer: printers[index] }))
    .filter(({ result }) => result.status === 'rejected');
  if (failed.length) {
    const printedCount = results.length - failed.length;
    const error = new Error(
      `${failed.length} of ${results.length} Bill printer${results.length === 1 ? '' : 's'} failed: ${failed
        .map(({ printer, result }) =>
          `${printer.name || printer.deviceName} (${result.reason?.message || 'unknown error'})`
        )
        .join('; ')}`
    );
    error.physicalPrintAttempted = true;
    error.printedCount = printedCount;
    throw error;
  }
  return results.length;
}

async function printOrder(id, split = null) {
  let physicalPrintAttempted = false;
  try {
    const bridgeResponse = await fetch(`${printBridgeOrigin}/v1/printers`, { cache: 'no-store' });
    if (!bridgeResponse.ok) throw new Error('Print Bridge is not available on this computer.');
    const operationsResponse = await fetch('/api/orders/operations', { cache: 'no-store' });
    const operations = await operationsResponse.json();
    if (!operationsResponse.ok)
      throw new Error(operations.error || 'Printer configuration could not load.');
    const billPrinters = configuredPrintersFor(operations.config, 'bill');
    if (!billPrinters.length) throw new Error('No Bill printer is configured.');
    const receiptResponse = await fetch(`/api/orders/${encodeURIComponent(id)}/print`, {
      cache: 'no-store',
    });
    const receipt = await receiptResponse.json();
    if (!receiptResponse.ok) throw new Error(receipt.error || 'Unable to prepare the receipt.');
    const receipts = splitReceiptParts(receipt, split);
    if (!receipts.length) throw new Error('Assign at least one item to every split bill.');
    const printBatchId = Date.now();
    for (const [index, part] of receipts.entries()) {
      physicalPrintAttempted = true;
      await printBillOnConfiguredPrinters(
        billPrinters,
        part,
        `manual-bill:${id}:${printBatchId}:${index + 1}`
      );
    }
    return;
  } catch (error) {
    reportOrdersDiagnostic({
      level: 'warning',
      message: `Direct bill reprint failed: ${error.message}`,
      source: 'manual bill printing',
    });
    if (physicalPrintAttempted || error.physicalPrintAttempted) {
      alert(
        `${error.message}\n\nCheck every assigned Bill printer before reprinting; one or more copies may already exist.`
      );
      if (split) throw error;
      return;
    }
    if (split) throw error;
  }
  const popup = window.open('', 'red-lantern-receipt', 'popup=yes,width=420,height=720');
  if (!popup) {
    alert('Please allow pop-ups to print the receipt.');
    return;
  }
  try {
    popup.document.write('<!doctype html><title>Preparing receipt…</title>');
    const response = await fetch(`/api/orders/${encodeURIComponent(id)}/print`, {
      cache: 'no-store',
    });
    const order = await response.json();
    if (!response.ok) throw new Error(order.error || 'Unable to prepare this receipt.');
    const items = Array.isArray(order.items) ? order.items : [];
    const itemPrice = (item) =>
      Number(String(item.price || '').replace(/[^0-9.]/g, '')) + (item.style ? 10 : 0);
    const quantity = items.reduce((total, item) => total + Number(item.quantity || 0), 0);
    const calculatedTotal = items.reduce(
      (total, item) => total + Number(item.quantity || 0) * itemPrice(item),
      0
    );
    const grandTotal = Number(order.total) > 0 ? Number(order.total) : calculatedTotal;
    const walletDiscount = Math.max(0, Math.floor(Number(order.loyalty_points_redeemed || 0)));
    const dailyNumber = Number(order.daily_order_number);
    const token =
      Number.isFinite(dailyNumber) && dailyNumber > 0 ? String(dailyNumber).padStart(2, '0') : '—';
    const placedAt = new Intl.DateTimeFormat('en-IN', {
      timeZone: 'Asia/Kolkata',
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    }).format(new Date(order.created_at));
    const orderType =
      order.mode === 'counter' || order.fulfillment_type === 'takeaway'
        ? 'TAKEAWAY ORDER'
        : order.fulfillment_type === 'delivery'
          ? 'DELIVERY ORDER'
          : order.mode === 'table'
            ? 'DINE IN ORDER'
            : 'QR ORDER';
    const itemRows = items
      .map((item) => {
        const label = `${item.name || 'Item'}${item.portion ? ` (${item.portion})` : ''}${item.style ? ` — ${item.style}` : ''}`;
        const qty = Number(item.quantity || 0);
        return `<tr><td class="item-name">${esc(label)}</td><td>${qty}</td><td>${money(itemPrice(item))}</td><td>${money(qty * itemPrice(item))}</td></tr>`;
      })
      .join('');
    popup.document.open();
    popup.document.write(
      `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Red Lantern · Token ${esc(token)}</title><style>@page{size:80mm auto;margin:4mm}*{box-sizing:border-box}body{width:72mm;margin:0;color:#111;font:12px Arial,sans-serif}.center{text-align:center}.restaurant{font-size:18px;font-weight:800;letter-spacing:.2px}.sub{margin:3px 0;color:#333}.rule{border:0;border-top:1px dashed #222;margin:10px 0}.wallet{padding:7px 0;font-weight:700}.details{line-height:1.55}.details b{display:inline-block;min-width:68px}table{width:100%;border-collapse:collapse;margin-top:8px;font-size:11px}th{padding:5px 0;border-bottom:1px solid #222;text-align:right;font-size:10px}th:first-child{text-align:left}td{padding:5px 0;vertical-align:top;text-align:right;border-bottom:1px dotted #bbb}.item-name{text-align:left;padding-right:5px}.totals{display:flex;justify-content:space-between;font-size:13px;font-weight:700}.grand{display:flex;justify-content:space-between;margin-top:6px;font-size:16px;font-weight:800}.note{margin-top:8px;font-size:10px;line-height:1.4}.footer{margin-top:14px;font-size:10px;text-align:center;color:#333}@media print{body{width:72mm}}</style></head><body><div class="center"><div class="restaurant">RED LANTERN RESTAURANT</div><div class="sub">Restaurant Mobile Number: 9922853605</div><div class="sub">Direct Order Receipt</div></div><hr class="rule"><div class="wallet">Wallet Points: ${Number(order.loyalty_points || 0)}</div><div class="details"><div><b>Name:</b> ${esc(order.customer_name || 'Not provided')}</div><div><b>Mobile:</b> ${esc(order.customer_phone || '—')}</div><div><b>Type:</b> ${esc(orderType)}</div><div><b>Token No:</b> ${esc(token)}</div><div><b>Placed:</b> ${esc(placedAt)}</div></div>${order.special_request ? `<div class="note"><b>Special request:</b> ${esc(order.special_request)}</div>` : ''}<hr class="rule"><table><thead><tr><th>Item</th><th>Qty</th><th>Price</th><th>Amount</th></tr></thead><tbody>${itemRows}</tbody></table><hr class="rule"><div class="totals"><span>Total Qty: ${quantity}</span><span>Items: ${items.length}</span></div><div class="totals"><span>Subtotal</span><span>${money(calculatedTotal)}</span></div>${walletDiscount ? `<div class="totals"><span>Wallet points discount</span><span>−${money(walletDiscount)}</span></div>` : ''}<div class="grand"><span>GRAND TOTAL</span><span>${money(grandTotal)}</span></div><hr class="rule"><div class="footer">Thank you for ordering with us!<br>Red Lantern Restaurant</div><script>window.onload=()=>setTimeout(()=>window.print(),150);window.onafterprint=()=>window.close();<\/script></body></html>`
    );
    popup.document.close();
  } catch (error) {
    popup.close();
    alert(error.message || 'Unable to prepare this receipt.');
  }
}

const operationId = () => `op_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const operationItemOptions = (item) => {
  const options = [];
  if (String(item.withBonePrice || '').trim())
    options.push({ label: 'With Bone', portion: 'With Bone' });
  if (String(item.bonelessPrice || '').trim())
    options.push({ label: 'Boneless', portion: 'Boneless' });
  return options;
};
const routePrinters = (item) => {
  const printers = new Map(operationsConfig.printers.map((printer) => [printer.id, printer]));
  const routes = operationsConfig.routes.filter(
    (route) => printerSupports(printers.get(route.printerId), 'kot')
  );
  return [
    ...new Map(
      routes
        .filter((route) =>
          route.category === '*'
            ? !route.itemName && !route.portion
            : route.category === item.category &&
              ((!route.itemName && !route.portion) ||
                (route.itemName === item.name &&
                  (!route.portion || route.portion === item.portion)))
        )
        .map((route) => [route.printerId, printers.get(route.printerId)])
    ).values(),
  ].filter(Boolean);
};
const routePrinter = (item) => routePrinters(item)[0] || null;
const selectedRouteCategories = () =>
  [...document.querySelectorAll('.operation-route-category-check:checked')].map(
    (input) => input.value
  );
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
  itemSelect.innerHTML = `<option value="">All selected categories</option>${operationsMenu
    .filter((item) => item.category === category)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((item) => `<option value="${esc(item.name)}">${esc(item.name)}</option>`)
    .join('')}`;
}
function assignedKinds(printer) {
  const kinds = [];
  if (printerSupports(printer, 'bill')) kinds.push('Bill');
  if (
    printerSupports(printer, 'kot') &&
    operationsConfig.routes.some((route) => route.printerId === printer.id)
  )
    kinds.push('KOT');
  return kinds;
}
function renderPrinterManagement() {
  const content = document.getElementById('operations-content');
  if (!content) return;
  const isPrinterEdit = assignmentMode === 'edit-bill' || assignmentMode === 'edit-kot';
  const editCapability = assignmentMode === 'edit-bill' ? 'bill' : 'kot';
  const savedPrinter = operationsConfig.printers.find((item) => item.id === assignmentPrinterId);
  const printer = isPrinterEdit ? printerFormat(savedPrinter, editCapability) : savedPrinter;
  const categories = [
    ...new Set(operationsMenu.map((item) => item.category).filter(Boolean)),
  ].sort();
  if (printer && assignmentMode) {
    const selected = new Set(
      operationsConfig.routes
        .filter((route) => route.printerId === printer.id && !route.itemName)
        .map((route) => route.category)
    );
    const selectedItems = new Set(
      operationsConfig.routes
        .filter((route) => route.printerId === printer.id && route.itemName)
        .map((route) => `${route.category}::${route.itemName}::${route.portion || ''}`)
    );
    content.innerHTML =
      isPrinterEdit
        ? `<section class="printer-assignment printer-edit"><button type="button" class="assignment-back" data-assignment-back>‹ Back</button><h3>Edit ${editCapability === 'bill' ? 'Bill' : 'KOT'} settings · ${esc(printer.name)}</h3><p>Set the printer name, system device, paper, and ${editCapability === 'bill' ? 'receipt' : 'KOT'} format. These settings belong only to this queue.</p><div class="printer-edit-grid"><label>Printer name<input id="printer-edit-name" maxlength="60" value="${esc(printer.name)}"></label><label>System printer<select id="printer-edit-device"><option value="${esc(printer.deviceId || '')}">${esc(printer.deviceName || 'Keep current system printer')}</option>${installedSystemPrinters
            .filter((item) => item.id !== printer.deviceId)
            .map((item) => `<option value="${esc(item.id)}">${esc(item.name)}</option>`)
            .join(
              ''
              )}</select></label><label>Paper width<select id="printer-edit-paper"><option value="80" ${String(printer.paperWidth || 80) === '80' ? 'selected' : ''}>80 mm (recommended)</option><option value="58" ${String(printer.paperWidth) === '58' ? 'selected' : ''}>58 mm</option></select></label><label>Header text<textarea id="printer-edit-header" maxlength="160">${esc(printer.receiptHeader || defaultBillHeader)}</textarea></label><label>Footer text<textarea id="printer-edit-footer" maxlength="160">${esc(printer.receiptFooter || defaultBillFooter)}</textarea></label><label class="printer-edit-check"><input id="printer-edit-show-name" type="checkbox" ${printer.showRestaurantName !== false ? 'checked' : ''}> Show restaurant name</label><label class="printer-edit-check"><input id="printer-edit-show-serial" type="checkbox" ${printer.showItemSerial ? 'checked' : ''}> Show item serial numbers</label>${editCapability === 'kot' ? `<label class="printer-edit-check"><input id="printer-edit-customer" type="checkbox" ${printer.showCustomer !== false ? 'checked' : ''}> Show customer details</label><label>Extra bottom space<select id="printer-edit-space"><option value="0">None</option><option value="1" ${Number(printer.extraSpace) === 1 ? 'selected' : ''}>Small</option><option value="2" ${Number(printer.extraSpace) === 2 ? 'selected' : ''}>Large</option></select></label>` : ''}</div><div class="assignment-actions"><button type="button" data-assignment-back>Cancel</button><button type="button" class="operations-save" data-save-printer-edit>Save printer settings</button></div></section>`
        : assignmentMode === 'choose'
          ? `<section class="printer-assignment"><button type="button" class="assignment-back" data-assignment-back>‹ Back</button><h3>Printer capabilities · ${esc(printer.name)}</h3><p>Enable either capability or both. One physical queue can handle Bills and routed KOTs with separate format controls.</p><div class="assignment-choices"><button type="button" data-assign-bill><b>▤ ${printerSupports(printer, 'bill') ? 'Disable Bill printing' : 'Enable Bill printing'}</b><span>${printerSupports(printer, 'bill') ? 'Currently receives every final Bill' : 'Customer receipts and bills'}</span></button><button type="button" data-assign-kot><b>⌑ Configure KOT routing</b><span>${printerSupports(printer, 'kot') ? 'KOT capability enabled' : 'Kitchen order tickets'}</span></button>${printerSupports(printer, 'bill') ? '<button type="button" data-edit-printer-capability="bill"><b>✎ Edit Bill format</b><span>Paper, receipt layout and typography</span></button>' : ''}${printerSupports(printer, 'kot') ? '<button type="button" data-edit-printer-capability="kot"><b>✎ Edit KOT format</b><span>Ticket typography and paper feed</span></button><button type="button" data-disable-kot><b>× Disable KOT printing</b><span>Removes this queue\'s KOT routes</span></button>' : ''}</div></section>`
          : `<section class="printer-assignment"><button type="button" class="assignment-back" data-assignment-back>‹ Back</button><h3>Assign KOT routing · ${esc(printer.name)}</h3><p>Assign whole categories, or expand a category and select only the dishes that belong on this station. Bone-in and boneless options can be routed separately.</p><label class="assignment-all-categories"><input type="checkbox" data-assignment-all-categories ${selected.has('*') ? 'checked' : ''}><span><b>All categories</b><small>Send every current and future menu category to this printer.</small></span></label><div class="assignment-category-grid">${categories
              .map((category) => {
                const items = operationsMenu
                  .filter((item) => item.category === category)
                  .sort((a, b) => a.name.localeCompare(b.name));
                return `<details class="assignment-category-card"><summary><label><input type="checkbox" data-assignment-category value="${esc(category)}" ${selected.has(category) ? 'checked' : ''}><span>${esc(category)}</span></label><i aria-hidden="true">⌄</i></summary><div class="assignment-item-list"><b>Individual dishes</b>${
                  items
                    .map((item) => {
                      const variants = operationItemOptions(item);
                      const allKey = `${category}::${item.name}::`;
                      return variants.length
                        ? `<div class="assignment-dish"><label><input type="checkbox" data-assignment-item data-category="${esc(category)}" value="${esc(item.name)}" ${selectedItems.has(allKey) ? 'checked' : ''}><span>${esc(item.name)} <small>all options</small></span></label><div class="assignment-variants">${variants.map((variant) => `<label><input type="checkbox" data-assignment-item data-category="${esc(category)}" data-portion="${esc(variant.portion)}" value="${esc(item.name)}" ${selectedItems.has(`${category}::${item.name}::${variant.portion}`) ? 'checked' : ''}><span>${esc(variant.label)}</span></label>`).join('')}</div></div>`
                        : `<label><input type="checkbox" data-assignment-item data-category="${esc(category)}" value="${esc(item.name)}" ${selectedItems.has(allKey) ? 'checked' : ''}><span>${esc(item.name)}</span></label>`;
                    })
                    .join('') || '<small>No dishes in this category yet.</small>'
                }</div></details>`;
              })
              .join(
                ''
              )}</div><div class="assignment-actions"><button type="button" data-assignment-back>Cancel</button><button type="button" class="operations-save" data-save-kot-assignment>Save KOT routing</button></div></section>`;
    if (isPrinterEdit) {
      const grid = content.querySelector('.printer-edit-grid');
      const anchor = content.querySelector('#printer-edit-header')?.closest('label');
      if (grid && anchor) {
        const typography = document.createElement('div');
        typography.className = 'printer-typography-fields';
        const fonts = [
          'Arial',
          'Calibri',
          'Verdana',
          'Tahoma',
          'Trebuchet MS',
          'Georgia',
          'Times New Roman',
          'Courier New',
          'Consolas',
          'Lucida Console',
        ];
        const field = (key, label, value, help = '') =>
          `<label>${label}<input id="printer-edit-${key}" type="number" min="0" max="400" value="${Number(printer[key] ?? value)}">${help ? `<small>${help}</small>` : ''}</label>`;
        if (editCapability === 'kot') {
          typography.innerHTML = `<div class="printer-format-intro"><span>KOT format</span><b>These font sizes are saved for this kitchen printer only.</b></div><section class="printer-format-group"><div class="printer-format-group-head"><span><b>Text style</b><small>Font and hierarchy for the kitchen ticket</small></span></div><div class="printer-format-fields"><label>Font family<select id="printer-edit-font-family">${fonts.map((font) => `<option value="${esc(font)}" ${String(printer.fontFamily || 'Arial') === font ? 'selected' : ''}>${esc(font)}</option>`).join('')}</select></label>${field('kotHeaderFontSize', 'Header text font size', 12)}${field('kotTitleFontSize', 'Kitchen title font size', 15)}${field('kotMetaFontSize', 'KOT details font size', 10)}${field('kotItemFontSize', 'Item font size', 12)}${field('kotFooterFontSize', 'Footer text font size', 10)}<label class="printer-edit-check"><input id="printer-edit-header-bold" type="checkbox" ${printer.headerBold !== false ? 'checked' : ''}> Bold header</label><label class="printer-edit-check"><input id="printer-edit-footer-bold" type="checkbox" ${printer.footerBold ? 'checked' : ''}> Bold footer</label></div></section><section class="printer-format-group"><div class="printer-format-group-head"><span><b>Spacing</b><small>Controls the ticket dividers and paper after the final line</small></span></div><div class="printer-format-fields">${field('separatorGap', 'Separator gap', 3)}${field('separatorThickness', 'Separator thickness', 1)}</div></section>`;
        } else {
          const billField = (key, label, value, help = '') =>
            field(
              key,
              label,
              Math.min(
                Number(printer[key] ?? value),
                key === 'itemListingFontSize' ? 10 : key === 'grandTotalFontSize' ? 11 : value
              ),
              help
            );
          typography.innerHTML = `<div class="printer-format-intro"><span>Bill format</span><b>These are the active controls used by the verified receipt layout.</b></div><details class="printer-format-group" open><summary><span><b>Paper & margins</b><small>Controls receipt width and safe printing area</small></span><i>⌄</i></summary><div class="printer-format-fields">${billField('billingMainWidth', 'Bill print width', 250, '250 is the verified printable width for this printer.')}${billField('billingOuterLeft', 'Left outer space', 14)}${billField('billingOuterTop', 'Top outer space', 0)}${billField('billingOuterRight', 'Right outer space', 0, 'Increase only if content reaches the right edge.')}${billField('billingOuterBottom', 'Bottom outer space', 0)}${billField('billingItemBoxHeight', 'Minimum item row height', 0)}</div></details><details class="printer-format-group"><summary><span><b>Text style</b><small>Font and hierarchy for the printed bill</small></span><i>⌄</i></summary><div class="printer-format-fields"><label>Font family<select id="printer-edit-font-family">${fonts.map((font) => `<option value="${esc(font)}" ${String(printer.fontFamily || 'Arial') === font ? 'selected' : ''}>${esc(font)}</option>`).join('')}</select></label>${billField('restaurantNameFontSize', 'Restaurant name font size', 15)}${billField('headerFooterFontSize', 'Header / footer font size', 10)}${billField('dateBillFontSize', 'Date / bill box font size', 10)}${billField('itemListingFontSize', 'Item listing font size', 10, 'Maximum 10 pt so the full four-column table fits.')}${billField('grandTotalFontSize', 'Grand total font size', 11, 'Maximum 11 pt so the final amount is never cut off.')}<label class="printer-edit-check"><input id="printer-edit-header-bold" type="checkbox" ${printer.headerBold !== false ? 'checked' : ''}> Bold restaurant name</label><label class="printer-edit-check"><input id="printer-edit-footer-bold" type="checkbox" ${printer.footerBold ? 'checked' : ''}> Bold footer</label></div></details><details class="printer-format-group"><summary><span><b>Items & spacing</b><small>Columns are automatically fitted to the verified 250-unit printable width</small></span><i>⌄</i></summary><div class="printer-format-fields">${billField('itemNameMinWidth', 'Minimum item-name width', 110, 'Qty, Price, and Amount are automatically protected and aligned.')}${billField('itemRowGap', 'Item row gap', 5)}${billField('separatorGap', 'Separator gap', 5)}${billField('separatorThickness', 'Separator thickness', 1)}</div></details>`;
        }
        if (editCapability === 'bill') {
          const nameControl = document.createElement('label');
          nameControl.innerHTML = `Restaurant name<input id="printer-edit-restaurant-name" maxlength="60" value="${esc(printer.restaurantName || 'Red Lantern Restaurant')}">`;
          typography.querySelectorAll('.printer-format-fields')[1]?.prepend(nameControl);
        }
        if (editCapability === 'kot') {
          const centerControl = document.createElement('label');
          centerControl.className = 'printer-edit-check';
          centerControl.innerHTML = `<input id="printer-edit-kot-details-centered" type="checkbox" ${printer.kotDetailsCentered ? 'checked' : ''}> Center KOT details`;
          typography.querySelector('.printer-format-fields')?.append(centerControl);
        }
        if (editCapability === 'bill') {
          const columns = document.createElement('div');
          columns.className = 'receipt-column-values';
          columns.innerHTML = `<label>Item column width<input id="printer-edit-itemNameMinWidth" type="number" min="50" max="220" value="${Math.max(50, Number(printer.itemNameMinWidth) || 110)}"></label><label>Qty column width<input id="printer-edit-quantityColumnWidth" type="number" min="25" max="60" value="${Math.max(28, Number(printer.quantityColumnWidth) || 28)}"></label><label>Price column width<input id="printer-edit-priceColumnWidth" type="number" min="40" max="100" value="${Math.max(46, Number(printer.priceColumnWidth) || 46)}"></label><label>Amount column width<input id="printer-edit-amountColumnWidth" type="number" min="52" max="120" value="${Math.max(60, Number(printer.amountColumnWidth) || 60)}"></label>`;
          typography.querySelectorAll('.printer-format-fields')[2]?.append(columns);
        }
        if (editCapability === 'bill') {
          const preview = document.createElement('aside');
          preview.className = 'receipt-live-preview';
          preview.innerHTML = `<div><b>Live bill preview</b><p>Click any receipt section to jump to its setting. This is a scaled 80 mm preview that updates before printing.</p></div><div class="receipt-preview-paper" data-receipt-preview-paper data-preview-target="billingMainWidth"><div class="rp-center rp-name" data-rp-name data-preview-target="restaurantNameFontSize">Red Lantern Restaurant</div><div class="rp-center" data-rp-header data-preview-target="header">Colva Goa<br>9922853605 / 9049558369<br>[Follow] Insta ID:<br>red_lantern_restaurant</div><div class="rp-rule"></div><div data-rp-date data-preview-target="dateBillFontSize">Date: 16/08/26 09:59 &nbsp;&nbsp; Dine In · AC</div><div class="rp-meta" data-preview-target="dateBillFontSize"><span>Cashier: biller</span><span>Bill No.: 05</span></div><b data-preview-target="dateBillFontSize">Token No.: 01</b><div class="rp-rule"></div><div class="rp-table rp-head" data-preview-target="itemListingFontSize"><span>Item</span><span>Qty</span><span>Price</span><span>Amount</span></div><div class="rp-rule"></div><div class="rp-table" data-preview-target="itemListingFontSize"><span>Tomato Salad<br>(Regular)</span><span>1</span><span>120.00</span><span>120.00</span></div><div class="rp-table" data-preview-target="itemListingFontSize"><span>Veg Sweet Corn<br>Soup (Regular)</span><span>1</span><span>120.00</span><span>120.00</span></div><div class="rp-rule"></div><div data-rp-summary data-preview-target="itemRowGap">Total Qty: 2 &nbsp;&nbsp; Sub Total: ₹240</div><div class="rp-grand" data-rp-grand data-preview-target="grandTotalFontSize">GRAND TOTAL: ₹240</div><div class="rp-rule"></div><div class="rp-foot" data-rp-footer data-preview-target="footer">Thank you for choosing us!<br>Kindly leave us a review<br>Google | Zomato | Swiggy</div></div>`;
          typography.prepend(preview);
          const paperPreview = preview.querySelector('[data-receipt-preview-paper]');
          paperPreview.insertAdjacentHTML(
            'beforeend',
            '<button type="button" class="receipt-preview-drag" data-preview-drag="left" title="Drag left margin">↔</button><button type="button" class="receipt-preview-drag" data-preview-drag="right" title="Drag right margin">↔</button><button type="button" class="receipt-preview-drag" data-preview-drag="top" title="Drag top margin">↕</button><button type="button" class="receipt-preview-drag" data-preview-drag="bottom" title="Drag bottom margin">↕</button>'
          );
          paperPreview.insertAdjacentHTML(
            'beforeend',
            '<button type="button" class="receipt-preview-column-drag" data-column-drag="item" title="Drag Item / Qty divider"></button><button type="button" class="receipt-preview-column-drag" data-column-drag="qty" title="Drag Qty / Price divider"></button><button type="button" class="receipt-preview-column-drag" data-column-drag="price" title="Drag Price / Amount divider"></button>'
          );
          const updatePreview = () => {
            const value = (key, fallback = 0) => {
              const parsed = Number(typography.querySelector(`#printer-edit-${key}`)?.value);
              return Number.isFinite(parsed) ? parsed : fallback;
            };
            const paper = preview.querySelector('[data-receipt-preview-paper]');
            paper.style.setProperty('--left', `${Math.min(30, value('billingOuterLeft')) / 3}px`);
            paper.style.setProperty('--right', `${Math.min(30, value('billingOuterRight')) / 3}px`);
            paper.style.setProperty('--top', `${Math.min(30, value('billingOuterTop')) / 3}px`);
            paper.style.setProperty(
              '--bottom',
              `${Math.min(30, value('billingOuterBottom')) / 3}px`
            );
            paper.style.setProperty(
              '--receipt-font',
              typography.querySelector('#printer-edit-font-family')?.value || 'Arial'
            );
            preview.querySelector('[data-rp-name]').textContent = String(
              typography.querySelector('#printer-edit-restaurant-name')?.value ||
                'Red Lantern Restaurant'
            );
            // Windows renders the receipt in points (1pt = 1.333 CSS px at
            // 96dpi) and reserves an 8-unit safe edge. Mirror that geometry
            // so the browser preview wraps at the same points as the print.
            paper.style.width = `${Math.max(180, Math.min(280, value('billingMainWidth', 250) - 8))}px`;
            const previewPoints = (points, min, max) =>
              Math.max(min, Math.min(max, points)) * 1.333;
            preview.querySelector('[data-rp-name]').style.fontSize =
              `${previewPoints(value('restaurantNameFontSize', 15), 10, 20)}px`;
            preview.querySelector('[data-rp-name]').style.display =
              document.getElementById('printer-edit-show-name')?.checked === false ? 'none' : '';
            preview.querySelector('[data-rp-name]').style.fontWeight =
              document.getElementById('printer-edit-header-bold')?.checked === false
                ? '400'
                : '800';
            preview.querySelector('[data-rp-header]').style.fontSize =
              `${previewPoints(value('headerFooterFontSize', 10), 8, 14)}px`;
            preview.querySelector('[data-rp-date]').style.fontSize =
              `${previewPoints(value('dateBillFontSize', 10), 8, 14)}px`;
            preview
              .querySelectorAll('.rp-table')
              .forEach(
                (row) =>
                  (row.style.fontSize = `${previewPoints(value('itemListingFontSize', 10), 8, 10)}px`)
              );
            const usableWidth = Math.max(160, value('billingMainWidth', 250) - 8),
              itemWidth = Math.max(50, value('itemNameMinWidth', 110)),
              quantityWidth = Math.max(28, value('quantityColumnWidth', 28)),
              priceWidth = Math.max(46, value('priceColumnWidth', 46)),
              amountWidth = Math.max(60, value('amountColumnWidth', 60));
            preview
              .querySelectorAll('.rp-table')
              .forEach(
                (row) =>
                  (row.style.gridTemplateColumns = `minmax(${Math.max(50, usableWidth - quantityWidth - priceWidth - amountWidth - 12)}px,1fr) ${quantityWidth}px ${priceWidth}px ${amountWidth}px`)
              );
            const previewContentLeft = 12 + value('billingOuterLeft') / 3,
              labelWidth = Math.max(
                50,
                usableWidth - quantityWidth - priceWidth - amountWidth - 12
              );
            const positions = {
              item: previewContentLeft + labelWidth,
              qty: previewContentLeft + labelWidth + quantityWidth + 4,
              price: previewContentLeft + labelWidth + quantityWidth + priceWidth + 8,
            };
            paperPreview.querySelectorAll('[data-column-drag]').forEach((handle) => {
              handle.style.left = `${positions[handle.dataset.columnDrag]}px`;
            });
            preview.querySelectorAll('.rp-table:not(.rp-head)').forEach((row) => {
              row.style.minHeight = `${Math.max(0, value('billingItemBoxHeight')) / 3}px`;
              row.style.marginBottom = `${Math.max(0, value('itemRowGap', 5)) / 3}px`;
            });
            preview.querySelectorAll('.rp-rule').forEach((rule) => {
              rule.style.margin = `${Math.max(0, value('separatorGap', 5)) / 2}px 0`;
              rule.style.height = `${Math.max(1, Math.min(4, value('separatorThickness', 1)))}px`;
            });
            preview.querySelector('[data-rp-grand]').style.fontSize =
              `${previewPoints(value('grandTotalFontSize', 11), 10, 11)}px`;
            preview.querySelector('[data-rp-footer]').style.fontWeight = document.getElementById(
              'printer-edit-footer-bold'
            )?.checked
              ? '800'
              : '400';
            preview.querySelector('[data-rp-header]').innerHTML = String(
              document.getElementById('printer-edit-header')?.value || defaultBillHeader
            ).replace(/\n/g, '<br>');
            preview.querySelector('[data-rp-footer]').innerHTML = String(
              document.getElementById('printer-edit-footer')?.value || defaultBillFooter
            ).replace(/\n/g, '<br>');
          };
          typography
            .querySelectorAll('input,select,textarea')
            .forEach((input) => input.addEventListener('input', updatePreview));
          document.getElementById('printer-edit-header')?.addEventListener('input', updatePreview);
          document.getElementById('printer-edit-footer')?.addEventListener('input', updatePreview);
          paperPreview.querySelectorAll('[data-preview-drag]').forEach((handle) =>
            handle.addEventListener('pointerdown', (event) => {
              event.preventDefault();
              event.stopPropagation();
              const edge = handle.dataset.previewDrag;
              const key = {
                left: 'billingOuterLeft',
                right: 'billingOuterRight',
                top: 'billingOuterTop',
                bottom: 'billingOuterBottom',
              }[edge];
              const input = typography.querySelector(`#printer-edit-${key}`);
              if (!input) return;
              const start = Number(input.value) || 0;
              const origin = edge === 'left' || edge === 'right' ? event.clientX : event.clientY;
              const move = (moveEvent) => {
                const distance =
                  (edge === 'left' || edge === 'right' ? moveEvent.clientX : moveEvent.clientY) -
                  origin;
                const direction = edge === 'left' || edge === 'top' ? 1 : -1;
                input.value = Math.max(
                  0,
                  Math.min(40, Math.round(start + distance * direction * 3))
                );
                input.dispatchEvent(new Event('input', { bubbles: true }));
              };
              const finish = () => {
                window.removeEventListener('pointermove', move);
                window.removeEventListener('pointerup', finish);
              };
              window.addEventListener('pointermove', move);
              window.addEventListener('pointerup', finish, { once: true });
            })
          );
          paperPreview.querySelectorAll('[data-column-drag]').forEach((handle) =>
            handle.addEventListener('pointerdown', (event) => {
              event.preventDefault();
              event.stopPropagation();
              const key = {
                item: 'itemNameMinWidth',
                qty: 'quantityColumnWidth',
                price: 'priceColumnWidth',
              }[handle.dataset.columnDrag];
              const input = typography.querySelector(`#printer-edit-${key}`);
              if (!input) return;
              const start = Number(input.value) || 0;
              const origin = event.clientX;
              const move = (moveEvent) => {
                input.value = Math.max(
                  Number(input.min) || 0,
                  Math.min(
                    Number(input.max) || 220,
                    Math.round(start + (moveEvent.clientX - origin))
                  )
                );
                input.dispatchEvent(new Event('input', { bubbles: true }));
              };
              const finish = () => {
                window.removeEventListener('pointermove', move);
                window.removeEventListener('pointerup', finish);
              };
              window.addEventListener('pointermove', move);
              window.addEventListener('pointerup', finish, { once: true });
            })
          );
          preview.addEventListener('click', (event) => {
            const section = event.target.closest('[data-preview-target]');
            const target = section?.dataset.previewTarget;
            if (!target) return;
            const input =
              target === 'header'
                ? document.getElementById('printer-edit-header')
                : target === 'footer'
                  ? document.getElementById('printer-edit-footer')
                  : target === 'restaurantNameFontSize'
                    ? document.getElementById('printer-edit-restaurant-name')
                    : document.getElementById(`printer-edit-${target}`);
            input?.scrollIntoView({ behavior: 'smooth', block: 'center' });
            input?.focus({ preventScroll: true });
          });
          updatePreview();
        }
        if (editCapability === 'kot') {
          const preview = document.createElement('aside');
          preview.className = 'receipt-live-preview';
          preview.innerHTML = `<div><b>Live KOT preview</b><p>Click a ticket section to jump to its setting. Text, hierarchy, dividers and customer details update as you edit.</p></div><div class="receipt-preview-paper" data-kot-preview><b data-kp-kot data-preview-target="kotMetaFontSize">KOT # 12</b><div data-kp-customer data-preview-target="showCustomer">Table: AC · 1<br>Guest: Walk-in customer</div><div class="rp-rule"></div><div data-kp-item data-preview-target="kotItemFontSize"></div><div data-kp-item data-preview-target="kotItemFontSize"></div><div class="rp-rule"></div><div class="rp-foot" data-kp-footer data-preview-target="kotBottomFeedLines"></div></div>`;
          typography.prepend(preview);
          const updateKotPreview = () => {
            const value = (key, fallback = 0) => {
              const parsed = Number(typography.querySelector(`#printer-edit-${key}`)?.value);
              return Number.isFinite(parsed) ? parsed : fallback;
            };
            const pt = (points, min, max) => Math.max(min, Math.min(max, points)) * 1.333;
            const paper = preview.querySelector('[data-kot-preview]');
            const paperWidth = Number(document.getElementById('printer-edit-paper')?.value) === 58
              ? 58
              : 80;
            // Keep the browser mock-up proportional to the paper selection so
            // staff can see the same wrapping difference before printing.
            paper.style.width = `${Math.round((280 * paperWidth) / 80)}px`;
            const centered = !!document.getElementById('printer-edit-kot-details-centered')
              ?.checked;
            const showSerial = !!document.getElementById('printer-edit-show-serial')?.checked;
            paper.style.setProperty(
              '--receipt-font',
              typography.querySelector('#printer-edit-font-family')?.value || 'Arial'
            );
            preview.querySelector('[data-kp-kot]').style.fontSize =
              `${pt(value('kotMetaFontSize', 10), 8, 18)}px`;
            preview.querySelector('[data-kp-kot]').style.textAlign = centered ? 'center' : 'left';
            preview.querySelector('[data-kp-customer]').style.fontSize =
              `${pt(value('kotMetaFontSize', 10), 8, 18)}px`;
            preview.querySelector('[data-kp-customer]').style.textAlign = centered
              ? 'center'
              : 'left';
            preview.querySelectorAll('[data-kp-item]').forEach((item, index) => {
              item.style.fontSize = `${pt(value('kotItemFontSize', 12), 8, 20)}px`;
              item.style.marginBottom = `${Math.max(0, value('itemRowGap', 5)) / 3}px`;
              item.textContent = `${showSerial ? `${index + 1}. ` : ''}${index === 0 ? '2x Chicken Tandoori (Full)' : '1x Cheese Garlic Naan'}`;
            });
            preview.querySelectorAll('.rp-rule').forEach((rule) => {
              rule.style.margin = `${Math.max(0, value('separatorGap', 3)) / 2}px 0`;
              rule.style.height = `${Math.max(1, Math.min(4, value('separatorThickness', 1)))}px`;
            });
            preview.querySelector('[data-kp-customer]').style.display =
              document.getElementById('printer-edit-customer')?.checked === false ? 'none' : '';
          };
          typography
            .querySelectorAll('input,select,textarea')
            .forEach((input) => input.addEventListener('input', updateKotPreview));
          [
            'printer-edit-customer',
            'printer-edit-show-serial',
            'printer-edit-kot-details-centered',
            'printer-edit-paper',
          ].forEach((id) =>
            document.getElementById(id)?.addEventListener('input', updateKotPreview)
          );
          preview.addEventListener('click', (event) => {
            const target = event.target.closest('[data-preview-target]')?.dataset.previewTarget;
            const input =
              target === 'header'
                ? document.getElementById('printer-edit-header')
                : target === 'footer'
                  ? document.getElementById('printer-edit-footer')
                  : target === 'showCustomer'
                    ? document.getElementById('printer-edit-show-customer')
                    : document.getElementById(`printer-edit-${target}`);
            input?.scrollIntoView({ behavior: 'smooth', block: 'center' });
            input?.focus({ preventScroll: true });
          });
          updateKotPreview();
          const updateKotFeed = () => {
            const rawFeed = Number(
              typography.querySelector('#printer-edit-kotBottomFeedLines')?.value
            );
            const feed = Number.isFinite(rawFeed) ? Math.max(0, rawFeed) : 3;
            const extra = Math.max(
              0,
              Number(document.getElementById('printer-edit-space')?.value) || 0
            );
            const feedSpace = preview.querySelector('[data-kp-footer]');
            preview.querySelector('[data-kot-preview]').style.minHeight = '0';
            feedSpace.textContent = '';
            feedSpace.style.display = 'block';
            feedSpace.style.height = `${(feed + extra * 2) * 14}px`;
            feedSpace.style.margin = '0';
          };
          typography
            .querySelectorAll('input,select')
            .forEach((input) => input.addEventListener('input', updateKotFeed));
          document.getElementById('printer-edit-space')?.addEventListener('input', updateKotFeed);
          updateKotFeed();
          preview.addEventListener(
            'click',
            (event) => {
              const target = event.target.closest('[data-preview-target]')?.dataset.previewTarget;
              const input =
                target === 'footer'
                    ? document.getElementById('printer-edit-kotBottomFeedLines')
                    : event.target.closest('.rp-rule')
                      ? document.getElementById('printer-edit-separatorGap')
                      : null;
              if (!input) return;
              event.stopImmediatePropagation();
              input.scrollIntoView({ behavior: 'smooth', block: 'center' });
              input.focus({ preventScroll: true });
            },
            true
          );
        }
        typography.querySelectorAll('.printer-format-group').forEach((group) => {
          const heading = group.querySelector('summary span');
          if (!heading) return;
          const fields = group.querySelector('.printer-format-fields');
          const section = document.createElement('section');
          section.className = 'printer-format-group';
          section.innerHTML = `<div class="printer-format-group-head">${heading.innerHTML}</div>`;
          section.append(fields);
          group.replaceWith(section);
        });
        if (editCapability === 'kot') {
          const spacing = document.createElement('section');
          spacing.className = 'printer-format-group';
          spacing.innerHTML = `<div class="printer-format-group-head"><span><b>Item & paper spacing</b><small>Controls space between KOT items and paper fed after the ticket</small></span></div><div class="printer-format-fields">${field('itemRowGap', 'Item row gap', 5)}${field('kotBottomFeedLines', 'Bottom feed lines', 3, 'Base paper feed after the KOT; Extra bottom space adds to this.')}</div>`;
          typography.append(spacing);
        }
        grid.insertBefore(typography, anchor);
        if (editCapability === 'kot') {
          [
            'printer-edit-header',
            'printer-edit-footer',
            'printer-edit-show-name',
            'printer-edit-footer-bold',
            'printer-edit-kotHeaderFontSize',
            'printer-edit-kotTitleFontSize',
            'printer-edit-kotFooterFontSize',
          ].forEach((id) => document.getElementById(id)?.closest('label')?.remove());
        }
      }
    }
    return;
  }
  const bridgeText =
    printBridgeState === 'available'
      ? 'Print Bridge is running — installed printers are available.'
      : 'Print Bridge is not detected on this computer.';
  content.innerHTML = `<section class="manage-printers"><div class="manage-printers-head"><div><span class="eyebrow">Printer setup</span><h3>Manage printers</h3><p>Connect any number of installed printers. Every Bill printer receives a bill copy using its own layout; KOT printers receive only their routed menu items.</p></div><span class="bridge-status ${printBridgeState === 'available' ? 'online' : ''}">${bridgeText}</span></div><div class="add-system-printer"><div class="add-printer-copy"><b>Add an installed printer</b><span>Choose a printer already available on this Windows computer.</span></div><label class="quick-printer-name">Printer name <input id="quick-printer-name" maxlength="60" placeholder="e.g. Kitchen Printer"></label><select id="quick-system-printer"><option value="">Choose installed printer</option>${installedSystemPrinters.map((item) => `<option value="${esc(item.id)}">${esc(item.name)}</option>`).join('')}</select><button type="button" id="quick-add-printer">＋ Add printer</button></div><div class="printer-card-list">${
    operationsConfig.printers
      .map((item) => {
        const kinds = assignedKinds(item);
        const capabilities = printerCapabilities(item);
        const isBillPrinter = capabilities.includes('bill');
        const isKotPrinter = capabilities.includes('kot');
        const routes = operationsConfig.routes.filter((route) => route.printerId === item.id);
        const allCategories = routes.some((route) => route.category === '*' && !route.itemName);
        const categories = [
          ...new Set(
            routes
              .filter((route) => route.category !== '*' && !route.itemName)
              .map((route) => route.category)
          ),
        ];
        const overrides = routes.filter((route) => route.itemName);
        const overrideNames = overrides.map(
          (route) => `${route.itemName}${route.portion ? ` — ${route.portion}` : ' · all options'}`
        );
        const assignment = allCategories
          ? 'All categories'
          : [
              categories.length
                ? `${categories.length} categor${categories.length === 1 ? 'y' : 'ies'}`
                : '',
              overrides.length
                ? `${overrides.length} selected dish${overrides.length === 1 ? '' : 'es'}`
                : '',
            ]
              .filter(Boolean)
              .join(' · ') || 'Not assigned yet';
        const summary = allCategories
          ? 'Receives every current and future menu category.'
          : [...categories, ...overrideNames].join(' · ');
        const capabilityLabel = capabilities.length
          ? `${capabilities.map((capability) => (capability === 'bill' ? 'Bill' : 'KOT')).join(' + ')} printer`
          : 'Unassigned printer';
        const assignmentLabel = isBillPrinter
          ? isKotPrinter
            ? `Bill enabled · KOT: ${assignment}`
            : 'Receives every final bill'
          : assignment;
        const assignmentSummary = isBillPrinter
          ? isKotPrinter
            ? `Bills use this queue's saved receipt format. KOT: ${summary || 'routing is not configured yet.'}`
            : `Uses ${item.deviceName || 'the selected queue'} with this printer's own saved paper and layout settings.`
          : summary || 'Choose Bill or KOT capabilities to complete setup.';
        return `<article class="printer-card"><div class="printer-card-top"><span class="printer-card-mark ${isBillPrinter ? 'is-bill' : ''}" aria-hidden="true">${isBillPrinter && isKotPrinter ? '▣' : isBillPrinter ? '▤' : '⌑'}</span><div><span class="printer-card-label">${esc(capabilityLabel)}</span><h4>${esc(item.name)}</h4><p>${esc(item.deviceName || 'System printer not assigned')}</p></div><span class="printer-card-state ${kinds.length ? 'is-ready' : ''}">${kinds.length ? 'Configured' : 'Needs assignment'}</span></div><div class="printer-routing-summary"><b>${esc(assignmentLabel)}</b><span>${esc(assignmentSummary)}</span></div><div class="printer-card-actions"><button type="button" data-rename-printer="${esc(item.id)}">Edit</button><button type="button" data-assign-printer="${esc(item.id)}">Configure capabilities</button><button type="button" class="remove-printer" data-delete-printer="${esc(item.id)}">Remove</button></div></article>`;
      })
      .join('') || '<div class="operations-empty">Choose an installed printer above to begin.</div>'
  }</div></section>`;
  content.querySelectorAll('[data-rename-printer]').forEach((button) => {
    button.className = 'printer-action-icon';
    button.title = 'Edit printer';
    button.setAttribute('aria-label', 'Edit printer');
    button.textContent = '✎';
  });
  const backToOperations = document.createElement('button');
  backToOperations.type = 'button';
  backToOperations.className = 'manage-printers-back';
  backToOperations.dataset.operationsTab = 'home';
  backToOperations.textContent = '← Back to Operations';
  content.querySelector('.manage-printers-head > div')?.prepend(backToOperations);
  const restartBridge = document.createElement('button');
  restartBridge.type = 'button';
  restartBridge.id = 'restart-print-bridge';
  restartBridge.textContent = 'Restart Print Bridge';
  content.querySelector('.manage-printers-head')?.append(restartBridge);
  content.querySelectorAll('[data-delete-printer]').forEach((button) => {
    button.className = 'printer-action-icon is-delete';
    button.title = 'Delete printer';
    button.setAttribute('aria-label', 'Delete printer');
    button.textContent = '⌫';
  });
  content.querySelectorAll('[data-assign-printer]').forEach((button) => {
    button.className = 'printer-assign-button';
    button.textContent = 'Assign';
  });
}
function renderTableAllocation() {
  const content = document.getElementById('operations-content');
  if (!content) return;
  const areas = Array.isArray(operationsConfig.tableAreas) ? operationsConfig.tableAreas : [];
  content.innerHTML = `<section class="printer-assignment"><button type="button" class="assignment-back" data-operations-tab="home">‹ Back</button><h3>▦ Table allocation</h3><p>Create each restaurant area, then give it an inclusive table-number range. Example: A/C tables 1–28 and Non-A/C tables 1–9. The same table number can exist in different areas.</p><div class="table-allocation-form" data-table-allocation-form><label>Area name<input id="table-area-name" maxlength="60" placeholder="e.g. Garden seating"></label><label>From table<input id="table-area-from" type="number" min="1" max="9999" inputmode="numeric" placeholder="1"></label><label>To table<input id="table-area-to" type="number" min="1" max="9999" inputmode="numeric" placeholder="20"></label><button type="button" class="operations-save" data-add-table-area>Add area</button></div><div class="table-allocation-list">${areas.map((area) => `<article><div><b>${esc(area.name)}</b><span>Tables ${esc(area.from)} to ${esc(area.to)} · ${Number(area.to) - Number(area.from) + 1} tables</span></div><div class="table-area-actions"><button type="button" data-edit-table-area="${esc(area.id)}">Edit</button><button type="button" data-remove-table-area="${esc(area.id)}">Remove</button></div></article>`).join('') || '<p class="operations-empty">No table areas configured yet.</p>'}</div><div class="assignment-actions"><button type="button" class="operations-save" data-save-table-allocation>Save table allocation</button></div></section>`;
}
function renderKitchenDisplay() {
  const content = document.getElementById('operations-content');
  if (!content) return;
  const active = [...orderRecords.values()].filter((order) =>
    ['accepted', 'preparing', 'ready'].includes(order.status)
  );
  const tickets = [];
  active.forEach((order) =>
    (Array.isArray(order.items) ? order.items : []).forEach((item) => {
      const stations = routePrinters(item);
      stations.forEach((printer) => {
        const key = `${order.id}::${printer.id}`;
        let ticket = tickets.find((entry) => entry.key === key);
        if (!ticket) {
          ticket = { key, order, printer, items: [] };
          tickets.push(ticket);
        }
        ticket.items.push(item);
      });
    })
  );
  tickets.sort((a, b) => new Date(a.order.created_at) - new Date(b.order.created_at));
  const stations = [
    ...new Map(tickets.map((ticket) => [ticket.printer.id, ticket.printer])).values(),
  ];
  const selectedStations = selectedKdsStations();
  const visibleTickets = selectedStations.size
    ? tickets.filter((ticket) => selectedStations.has(ticket.printer.id))
    : tickets;
  const renderTicket = (ticket) => {
    const history = Array.isArray(operationKotHistory.get(ticket.order.id))
      ? operationKotHistory.get(ticket.order.id)
      : [];
    const kot =
      history.find(
        (entry) =>
          Array.isArray(entry.tickets) &&
          entry.tickets.some(
            (saved) =>
              saved.printerId === ticket.printer.id || saved.printerLabel === ticket.printer.name
          )
      ) || history[0];
    const savedTicket = kot?.tickets?.find(
      (saved) => saved.printerId === ticket.printer.id || saved.printerLabel === ticket.printer.name
    );
    const kotItems =
      Array.isArray(savedTicket?.items) && savedTicket.items.length
        ? savedTicket.items
        : ticket.items;
    const started = new Date(kot?.created_at || ticket.order.created_at).getTime();
    const minutes = Math.max(0, Math.floor((Date.now() - started) / 60000));
    const elapsed =
      minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
    const isTable = ticket.order.mode === 'table';
    const tableText = isTable
      ? `${ticket.order.table_area || ''} ${String(ticket.order.table_number || '').padStart(2, '0')}`.trim()
      : fulfillmentLabel(ticket.order);
    const stationStatus =
      kitchenStationStatuses.get(
        `${ticket.order.id}::${kot?.kot_number || ''}::${ticket.printer.id}`
      ) || 'accepted';
    const action =
      stationStatus === 'accepted'
        ? ['preparing', 'Start preparation']
        : stationStatus === 'preparing'
          ? ['ready', 'Mark food ready']
          : ['', 'Food is ready'];
    return `<article class="kds-ticket" data-kds-status="${esc(stationStatus)}"><div class="kds-ticket-top"><div><span>KOT no.</span><b>${kot?.kot_number ? `#${esc(kot.kot_number)}` : 'Pending print'}</b></div><div class="kds-table-badge ${isTable ? '' : 'is-counter'}"><small>${isTable ? 'Table no.' : 'Order type'}</small><b>${esc(tableText || '—')}</b></div><div><span>Order</span><b>#${esc(String(ticket.order.daily_order_number || '').padStart(2, '0'))}</b></div></div><div class="kds-meta"><span>${esc(ticket.order.customer_name || 'Walk-in customer')}</span><b>◷ ${elapsed}</b></div><div class="kds-station">${esc(ticket.printer.name)} · ${esc(fulfillmentLabel(ticket.order))}</div><div class="kds-items">${kotItems.map((item) => `<div><span><b>${Number(item.quantity || 0)}×</b> ${esc(item.name)}${item.portion ? ` · ${esc(item.portion)}` : ''}</span></div>`).join('')}</div>${ticket.order.special_request ? `<p class="kds-note">Note: ${esc(ticket.order.special_request)}</p>` : ''}${action[0] && kot?.kot_number ? `<button type="button" class="kds-action ${action[0] === 'ready' ? 'is-ready' : ''}" data-kds-status-action="${esc(action[0])}" data-kds-order="${esc(ticket.order.id)}" data-kds-printer="${esc(ticket.printer.id)}" data-kds-kot="${esc(kot.kot_number)}">${action[1]}</button>` : `<button type="button" class="kds-action is-ready" disabled>${kot?.kot_number ? 'Food is ready' : 'Awaiting KOT'}</button>`}</article>`;
  };
  content.innerHTML = `<section class="kds"><div class="kds-head"><div><button type="button" class="assignment-back" data-operations-tab="home">‹ Back</button><h3>Kitchen display</h3><p>Choose which KOT-routed stations this screen should show. Printed KOTs continue as normal.</p><div class="kds-station-picker"><button type="button" class="${selectedStations.size ? '' : 'is-active'}" data-kds-station="all">All stations</button>${stations.map((station) => `<button type="button" class="${selectedStations.has(station.id) ? 'is-active' : ''}" data-kds-station="${esc(station.id)}">${esc(station.name)}</button>`).join('') || '<span>Configure a KOT route to add a kitchen station.</span>'}</div><div class="kds-legend"><span>Blue · accepted</span><span>Amber · preparing</span><span>Green · ready</span><span>Auto-refreshes every 3 seconds</span></div></div><button type="button" class="kds-fullscreen" data-kds-fullscreen>⛶ Full screen</button></div><div class="kds-grid">${visibleTickets.map(renderTicket).join('') || '<div class="kds-empty"><b>No active kitchen tickets for this screen</b><br>Choose another station above, or accept an order routed to this station.</div>'}</div></section>`;
}
function renderOperations() {
  const content = document.getElementById('operations-content');
  if (!content) return;
  if (operationsTab === 'home') {
    const activeOrders = [...orderRecords.values()].filter(
      (order) => !['completed', 'rejected', 'cancelled'].includes(order.status)
    );
    const bridgeConfigured =
      printBridgeSetupStatus?.ok &&
      Number(printBridgeSetupStatus.configuredBillPrinterCount) > 0 &&
      Number(printBridgeSetupStatus.configuredKotRouteCount) > 0 &&
      Number(printBridgeSetupStatus.ledgerSummary?.printJobs?.unresolvedFailed || 0) === 0;
    const bridgeSummary = bridgeConfigured
      ? `${printBridgeSetupStatus.platformLabel} · local ledger and KOT routing ready`
      : printBridgeSetupStatus?.ok
        ? 'Bridge is running · finish printer and KOT routing setup'
        : 'Check cloud, printer and offline readiness';
    content.innerHTML = `<section class="operations-home"><div class="operations-home-title"><span class="eyebrow">Operations</span><h3>Orders &amp; printing</h3><p>Open a workspace to manage the restaurant’s live order flow.</p></div><div class="operations-home-grid"><button type="button" class="operations-home-card operations-setup-card" data-operations-tab="setup"><span class="operations-home-icon" aria-hidden="true">◈</span><span><b>Print &amp; offline setup</b><small>${esc(bridgeSummary)}</small></span><i aria-hidden="true">›</i></button><button type="button" class="operations-home-card" data-operations-tab="kots"><span class="operations-home-icon" aria-hidden="true">⌑</span><span><b>Printed KOTs</b><small>${activeOrders.length} active order${activeOrders.length === 1 ? '' : 's'} · View, reprint and keep ticket records</small></span><i aria-hidden="true">›</i></button><button type="button" class="operations-home-card" data-operations-tab="kitchen-display"><span class="operations-home-icon" aria-hidden="true">▤</span><span><b>Kitchen display</b><small>Live screen tickets · Start preparation and mark food ready</small></span><i aria-hidden="true">›</i></button><button type="button" class="operations-home-card" data-operations-tab="printers"><span class="operations-home-icon" aria-hidden="true">▣</span><span><b>Manage printers</b><small>${operationsConfig.printers.length} printer${operationsConfig.printers.length === 1 ? '' : 's'} · Add, assign and manage bills or KOTs</small></span><i aria-hidden="true">›</i></button><button type="button" class="operations-home-card" data-operations-tab="tables"><span class="operations-home-icon" aria-hidden="true">▦</span><span><b>Table allocation</b><small>${(operationsConfig.tableAreas || []).length} area${(operationsConfig.tableAreas || []).length === 1 ? '' : 's'} · Name sections and assign table ranges</small></span><i aria-hidden="true">›</i></button></div></section>`;
    return;
  }
  if (operationsTab === 'setup') {
    renderPrintBridgeSetup();
    return;
  }
  if (operationsTab === 'tables') {
    renderTableAllocation();
    return;
  }
  if (operationsTab === 'kitchen-display') {
    renderKitchenDisplay();
    return;
  }
  if (operationsTab === 'kots') {
    const activeOrders = [...orderRecords.values()].filter(
      (order) => !['completed', 'rejected', 'cancelled'].includes(order.status)
    );
    const tickets = new Map();
    activeOrders.forEach((order) =>
      (Array.isArray(order.items) ? order.items : []).forEach((item) => {
        const printers = routePrinters(item);
        (printers.length ? printers : [null]).forEach((printer) => {
          const key = `${order.id}::${printer?.id || 'unassigned'}`;
          if (!tickets.has(key)) tickets.set(key, { order, printer, items: [] });
          tickets.get(key).items.push(item);
        });
      })
    );
    content.innerHTML = `<section class="kot-listing"><div class="kot-listing-head"><div><button type="button" class="assignment-back" data-operations-tab="home">‹ Back</button><h3>KOT listing</h3><p>Live kitchen tickets grouped by their assigned printer. KOT number is the primary kitchen reference.</p></div><span class="operations-count">${tickets.size} live ticket${tickets.size === 1 ? '' : 's'}</span></div><div class="kot-table-wrap"><table class="kot-table"><thead><tr><th>KOT no.</th><th>Order no.</th><th>Order type</th><th>Customer</th><th>Items</th><th>Created</th><th>Elapsed</th><th>Printer</th><th>Status</th><th>Action</th></tr></thead><tbody>${
      [...tickets.values()]
        .map((ticket) => {
          const orderNumber = String(ticket.order.daily_order_number || '—').padStart(2, '0');
          const type = fulfillmentLabel(ticket.order);
          const history = Array.isArray(operationKotHistory.get(ticket.order.id))
            ? operationKotHistory.get(ticket.order.id)
            : [];
          const savedKot =
            history.find(
              (entry) =>
                Array.isArray(entry.tickets) &&
                entry.tickets.some(
                  (savedTicket) => savedTicket.printerLabel === ticket.printer?.name
                )
            ) || history[0];
          const createdAt = savedKot?.created_at || ticket.order.created_at;
          const elapsedMinutes = createdAt
            ? Math.max(0, Math.floor((Date.now() - new Date(createdAt).getTime()) / 60000))
            : null;
          const elapsed =
            elapsedMinutes === null
              ? '—'
              : elapsedMinutes < 60
                ? `${elapsedMinutes} min`
                : `${Math.floor(elapsedMinutes / 60)} hr ${elapsedMinutes % 60} min`;
          return `<tr><td><b class="kot-number">${savedKot?.kot_number ? `#${esc(savedKot.kot_number)}` : '—'}</b><small>${savedKot ? 'Printed KOT' : 'Not printed yet'}</small></td><td><b>#${esc(orderNumber)}</b></td><td>${type}</td><td><b>${esc(ticket.order.customer_name || 'Guest')}</b><small>${esc(ticket.order.customer_phone || '—')}</small></td><td>${ticket.items.map((item) => `<span>${Number(item.quantity || 0)}× ${esc(item.name)}${item.portion ? ` · ${esc(item.portion)}` : ''}</span>`).join('')}</td><td>${createdAt ? new Date(createdAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '—'}</td><td><b>${elapsed}</b></td><td><span class="printer-type kot">${esc(ticket.printer?.name || 'Unassigned')}</span></td><td><span class="kot-status">${esc(ticket.order.status || 'new')}</span></td><td><button type="button" class="kot-print-action" data-print-kot="${esc(ticket.order.id)}" data-printer-id="${esc(ticket.printer?.id || '')}">${savedKot ? 'Reprint KOT' : 'Print KOT'}</button></td></tr>`;
        })
        .join('') ||
      '<tr><td colspan="10" class="kot-table-empty">No live KOTs right now. New and active orders will appear here.</td></tr>'
    }</tbody></table></div></section>`;
    content.insertAdjacentHTML(
      'beforeend',
      `<section class="kot-listing kot-history-listing"><div class="kot-listing-head"><div><h3>Today’s KOT record</h3><p>Every KOT printed today remains here, including KOTs from orders that are still open.</p></div><span class="operations-count">${completedKotHistory.length} printed KOT${completedKotHistory.length === 1 ? '' : 's'}</span></div><div class="kot-table-wrap"><table class="kot-table"><thead><tr><th>KOT no.</th><th>Order no.</th><th>Order type</th><th>Customer</th><th>Kitchen printer</th><th>Printed</th><th>Status</th></tr></thead><tbody>${
        completedKotHistory
          .map((entry) => {
            const printers = (Array.isArray(entry.tickets) ? entry.tickets : [])
              .map((ticket) => ticket.printerLabel || ticket.printerName || 'Kitchen printer')
              .join(', ');
            return `<tr><td><b class="kot-number">#${esc(entry.kot_number)}</b><small>Printed KOT</small></td><td><b>#${esc(String(entry.daily_order_number || '—').padStart(2, '0'))}</b></td><td>${esc(fulfillmentLabel(entry))}</td><td><b>${esc(entry.customer_name || 'Guest')}</b><small>${esc(entry.customer_phone || '—')}</small></td><td><span class="printer-type kot">${esc(printers)}</span></td><td>${entry.created_at ? new Date(entry.created_at).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '—'}</td><td><span class="kot-status">${esc(String(entry.status || 'printed').replace(/_/g, ' '))}</span></td></tr>`;
          })
          .join('') ||
        '<tr><td colspan="7" class="kot-table-empty">No KOTs have been printed today yet.</td></tr>'
      }</tbody></table></div></section>`
    );
  } else {
    renderPrinterManagement();
    return;
  }
}
function detectedDesktopPlatform() {
  const hint = String(
    navigator.userAgentData?.platform || navigator.platform || navigator.userAgent || ''
  ).toLowerCase();
  return /mac|iphone|ipad/.test(hint) ? 'macOS' : /win/.test(hint) ? 'Windows' : 'this computer';
}
function printBridgeSetupCommand(platform = detectedDesktopPlatform()) {
  return platform === 'macOS'
    ? 'bash ./install-print-bridge-macos.sh'
    : 'powershell -ExecutionPolicy Bypass -File .\\install-print-bridge-windows.ps1';
}
function renderPrintBridgeSetup() {
  const content = document.getElementById('operations-content');
  if (!content) return;
  const status = printBridgeSetupStatus;
  const platform = status?.platformLabel || detectedDesktopPlatform();
  const download =
    platform === 'macOS'
      ? 'https://github.com/grezello94/red-lantern-website/releases/latest/download/Red-Lantern-Print-Bridge-macOS.pkg'
      : 'https://github.com/grezello94/red-lantern-website/releases/latest/download/Red-Lantern-Print-Bridge-Windows-Setup.exe';
  const missingPrinters = Number(status?.missingConfiguredPrinterCount || 0),
    unavailablePrinters = Number(status?.unavailableConfiguredPrinterCount || 0),
    unreachablePrinters = Number(status?.unreachableConfiguredPrinterCount || 0),
    unroutedItems = Number(status?.unroutedItemCount || 0),
    configured =
      !!status?.cloud &&
      Number(status?.configuredBillPrinterCount || 0) > 0 &&
      Number(status?.configuredKotRouteCount || 0) > 0 &&
      !missingPrinters &&
      !unavailablePrinters &&
      !unreachablePrinters &&
      !unroutedItems;
  const failedJobs = Number(
      status?.ledgerSummary?.printJobs?.unresolvedIssues ??
        status?.ledgerSummary?.printJobs?.unresolvedFailed ??
        0
    ),
    failedIds = (Array.isArray(status?.recentPrintFailures) ? status.recentPrintFailures : [])
      .map((job) => job.id)
      .filter(Boolean),
    failureDetail = (Array.isArray(status?.recentPrintFailures) ? status.recentPrintFailures : [])
      .map(
        (job) =>
          `${job.kind.toUpperCase()} · ${job.printerName}${job.status === 'uncertain' ? ' · output uncertain' : ''}`
      )
      .join(' · ');
  const card = status?.checking
    ? `<span class="printing-status-icon is-checking" aria-hidden="true">…</span><div><h3>Preparing printing…</h3><p>This takes a moment.</p></div>`
    : status?.ok && failedJobs
      ? `<span class="printing-status-icon is-warning" aria-hidden="true">!</span><div><h3>Printing needs review</h3><p>${failedJobs} local print job${failedJobs === 1 ? '' : 's'} failed or ended with uncertain output${failureDetail ? ` (${esc(failureDetail)})` : ''}. Check for a physical slip and inspect the Windows printer queue before deliberately reprinting.</p><button type="button" class="quiet-button" data-acknowledge-print-failures="${esc(JSON.stringify(failedIds))}">Mark reviewed</button><button type="button" class="quiet-button" data-run-bridge-check>Check again</button></div>`
      : status?.ok && missingPrinters
        ? `<span class="printing-status-icon is-warning" aria-hidden="true">!</span><div><h3>Assigned printer is missing</h3><p>${missingPrinters} saved printer ${missingPrinters === 1 ? 'queue is' : 'queues are'} no longer installed in Windows/macOS. Reassign the device before service.</p><button type="button" class="quiet-button" data-operations-tab="printers">Manage printers</button><button type="button" class="quiet-button" data-run-bridge-check>Check again</button></div>`
        : status?.ok && unavailablePrinters
          ? `<span class="printing-status-icon is-warning" aria-hidden="true">!</span><div><h3>Printer queue is offline</h3><p>${unavailablePrinters} configured printer ${unavailablePrinters === 1 ? 'queue is' : 'queues are'} reporting Offline or Error in the operating system. Check power, cable/Wi-Fi, and the saved printer port before service.</p><button type="button" class="quiet-button" data-operations-tab="printers">Manage printers</button><button type="button" class="quiet-button" data-run-bridge-check>Check again</button></div>`
        : status?.ok && unreachablePrinters
          ? `<span class="printing-status-icon is-warning" aria-hidden="true">!</span><div><h3>Network printer is unreachable</h3><p>${unreachablePrinters} configured LAN printer ${unreachablePrinters === 1 ? 'endpoint is' : 'endpoints are'} not accepting connections. Check printer power, Ethernet/Wi-Fi, unique IP/MAC settings, and RAW port 9100.</p><button type="button" class="quiet-button" data-operations-tab="printers">Manage printers</button><button type="button" class="quiet-button" data-run-bridge-check>Check again</button></div>`
        : status?.ok && unroutedItems
          ? `<span class="printing-status-icon is-warning" aria-hidden="true">!</span><div><h3>Menu routing is incomplete</h3><p>${unroutedItems} menu item${unroutedItems === 1 ? '' : 's'} ${unroutedItems === 1 ? 'has' : 'have'} no live KOT printer route${status.unroutedItems?.length ? `: ${esc(status.unroutedItems.slice(0, 5).join(', '))}${unroutedItems > 5 ? '…' : ''}` : ''}.</p><button type="button" class="quiet-button" data-operations-tab="printers">Manage printers</button></div>`
          : status?.ok && !status.cloud
            ? `<span class="printing-status-icon is-warning" aria-hidden="true">!</span><div><h3>Cloud configuration is unavailable</h3><p>The local Bridge is running, but printer routes could not be checked against the live menu. Restore internet or sign in again, then check printing.</p><button type="button" class="quiet-button" data-run-bridge-check>Check again</button></div>`
      : status?.ok && configured
        ? `<span class="printing-status-icon" aria-hidden="true">✓</span><div><h3>Printing is ready</h3><p>This computer is ready to print bills and kitchen orders${status.version ? ` · Bridge ${esc(status.version)}` : ''}.</p><button type="button" class="quiet-button" data-run-bridge-check>Check again</button></div>`
        : status?.ok
          ? `<span class="printing-status-icon is-warning" aria-hidden="true">!</span><div><h3>Finish printer setup</h3><p>Print Bridge is running, but this computer needs an assigned Bill printer and a KOT route attached to a real system printer before service.</p><button type="button" class="quiet-button" data-operations-tab="printers">Manage printers</button><button type="button" class="quiet-button" data-run-bridge-check>Check again</button></div>`
          : `<span class="printing-status-icon is-warning" aria-hidden="true">!</span><div><h3>Set up printing</h3><p>${esc(status?.detail || `Install printing once on this ${platform} computer.`)}</p><a class="operations-save bridge-download" href="${download}">Set up printing</a><button type="button" class="quiet-button" data-run-bridge-check>Check again</button></div>`;
  content.innerHTML = `<section class="simple-printing-setup"><button type="button" class="assignment-back" data-operations-tab="home">‹ Back</button><span class="eyebrow">Printing</span><div class="simple-printing-card">${card}</div></section>`;
}

function unroutedOperationItems(menu, config) {
  const printers = new Map(
    (Array.isArray(config?.printers) ? config.printers : [])
      .filter((printer) => printerSupports(printer, 'kot') && printer.deviceName)
      .map((printer) => [String(printer.id), printer])
  );
  const routes = (Array.isArray(config?.routes) ? config.routes : []).filter((route) =>
    printers.has(String(route.printerId))
  );
  const missing = [];
  (Array.isArray(menu) ? menu : []).forEach((item) => {
    const portions = operationItemOptions(item).map((option) => option.portion);
    const variants = portions.length ? portions : [''];
    variants.forEach((portion) => {
      const routed = routes.some((route) =>
        route.category === '*'
          ? !route.itemName && !route.portion
          : route.category === item.category &&
            ((!route.itemName && !route.portion) ||
              (route.itemName === item.name && (!route.portion || route.portion === portion)))
      );
      if (!routed)
        missing.push(`${item.name || 'Unnamed item'}${portion ? ` (${portion})` : ''}`);
    });
  });
  return [...new Set(missing)];
}
async function checkPrintBridgeSetup() {
  printBridgeSetupStatus = { checking: true };
  renderPrintBridgeSetup();
  const cloudCheck = (async () => {
    const controller = new AbortController(),
      timeout = setTimeout(() => controller.abort(), 4000);
    try {
      const response = await fetch('/api/orders/operations', {
        cache: 'no-store',
        signal: controller.signal,
      });
      if (!response.ok) return null;
      return await response.json();
    } catch (_) {
      return false;
    } finally {
      clearTimeout(timeout);
    }
  })();
  try {
    const controller = new AbortController(),
      timeout = setTimeout(() => controller.abort(), 2800);
    const response = await fetch(`${printBridgeOrigin}/v1/setup-status`, {
      cache: 'no-store',
      signal: controller.signal,
    });
    clearTimeout(timeout);
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok)
      throw new Error(data.detail || data.error || 'The local service did not complete its check.');
    const cloudData = await cloudCheck,
      unrouted = cloudData
        ? unroutedOperationItems(cloudData.menu, cloudData.config)
        : [];
    printBridgeSetupStatus = {
      ...data,
      cloud: !!cloudData,
      unroutedItemCount: unrouted.length,
      unroutedItems: unrouted,
    };
    installedSystemPrinters = Array.from(
      { length: Number(data.printerCount) || 0 },
      (_, index) => installedSystemPrinters[index]
    ).filter(Boolean);
    printBridgeState = 'available';
    // Only the authenticated cloud response may refresh the machine's durable
    // printer routing. A failed/unauthenticated page load must never replace it
    // with the browser's empty startup defaults.
    if (cloudData?.config) void syncOperationsToPrintBridge(cloudData.config);
  } catch (error) {
    printBridgeSetupStatus = {
      ok: false,
      cloud: !!(await cloudCheck),
      detail: error.message || 'Print Bridge was not found.',
    };
    printBridgeState = 'offline';
  }
  renderPrintBridgeSetup();
}
async function loadOperations() {
  const response = await fetch('/api/orders/operations', { cache: 'no-store' });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Unable to load Operations.');
  operationsConfig = data.config || { printers: [], routes: [] };
  if (!Array.isArray(operationsConfig.tableAreas) || !operationsConfig.tableAreas.length)
    operationsConfig.tableAreas = readCachedTableAreas();
  else cacheTableAreas(operationsConfig.tableAreas);
  cacheOperationsConfig(operationsConfig);
  operationsMenu = Array.isArray(data.menu) ? data.menu : [];
  if (!navigator.onLine) {
    operationKotHistory = new Map();
    completedKotHistory = [];
    kitchenStationStatuses = new Map();
    renderOperations();
    return;
  }
  const completedHistoryPromise = fetch('/api/orders/kot-history', { cache: 'no-store' })
    .then(async (response) => (response.ok ? response.json() : []))
    .catch(() => []);
  const stationStatusPromise = fetch('/api/orders/kitchen-statuses', { cache: 'no-store' })
    .then(async (response) => (response.ok ? response.json() : []))
    .catch(() => []);
  const activeOrders = [...orderRecords.values()].filter(
    (order) => !['completed', 'rejected', 'cancelled'].includes(order.status)
  );
  const histories = await Promise.all(
    activeOrders.map(async (order) => {
      try {
        const historyResponse = await fetch(`/api/orders/${encodeURIComponent(order.id)}/kots`, {
          cache: 'no-store',
        });
        return [order.id, historyResponse.ok ? await historyResponse.json() : []];
      } catch (_) {
        return [order.id, []];
      }
    })
  );
  operationKotHistory = new Map(histories);
  // Keep every KOT punched today. Restricting this to completed orders made
  // valid KOTs disappear from the record while their orders were still open.
  completedKotHistory = await completedHistoryPromise;
  kitchenStationStatuses = new Map(
    (await stationStatusPromise).map((entry) => [
      `${entry.order_id}::${entry.kot_number}::${entry.printer_id}`,
      entry.status,
    ])
  );
  renderOperations();
}
async function discoverSystemPrinters() {
  printBridgeState = 'checking';
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2200);
    const response = await fetch(`${printBridgeOrigin}/v1/printers`, {
      cache: 'no-store',
      signal: controller.signal,
    });
    clearTimeout(timer);
    const body = await response.json();
    if (!response.ok || !Array.isArray(body.printers))
      throw new Error('Print Bridge did not return installed printers.');
    installedSystemPrinters = body.printers
      .map((printer) => ({
        id: String(printer.id || printer.name || ''),
        name: String(printer.name || ''),
      }))
      .filter((printer) => printer.id && printer.name);
    printBridgeState = 'available';
  } catch (_) {
    installedSystemPrinters = [];
    printBridgeState = 'offline';
  }
}
async function syncOperationsToPrintBridge(config) {
  if (printBridgeState !== 'available') {
    printBridgeConfigState = 'waiting-for-bridge';
    return false;
  }
  try {
    const controller = new AbortController(),
      timeout = setTimeout(() => controller.abort(), 2800);
    const response = await fetch(`${printBridgeOrigin}/v1/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!response.ok) throw new Error('Bridge sync failed.');
    printBridgeConfigState = 'synced';
    return true;
  } catch (_) {
    printBridgeConfigState = 'waiting-for-bridge';
    return false;
  }
}
async function saveOperations() {
  if (
    await queueWhenOffline('operations-config', { config: operationsConfig }, () => {
      cacheOperationsConfig(operationsConfig);
      renderOperations();
    })
  )
    return;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  let response;
  try {
    response = await fetch('/api/orders/operations', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: operationsConfig }),
      signal: controller.signal,
    });
  } catch (error) {
    if (error.name === 'AbortError')
      throw new Error('Saving took too long. Check the internet connection, then try again.');
    throw new Error('Unable to reach the server. Check the internet connection, then try again.');
  } finally {
    clearTimeout(timeout);
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Unable to save printer configuration.');
  operationsConfig = data.config;
  await syncOperationsToPrintBridge(operationsConfig);
  renderOperations();
}
async function saveTableAllocation(button) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  const originalLabel = button?.textContent || 'Save table allocation';
  if (button) {
    button.disabled = true;
    button.textContent = 'Saving…';
  }
  try {
    if (
      await queueWhenOffline(
        'table-areas',
        { tableAreas: operationsConfig.tableAreas || [] },
        () => {
          cacheTableAreas(operationsConfig.tableAreas);
          cacheOperationsConfig(operationsConfig);
        }
      )
    ) {
      if (button) {
        button.textContent = 'Saved offline ✓';
        setTimeout(() => {
          if (button.isConnected) {
            button.disabled = false;
            button.textContent = originalLabel;
          }
        }, 1600);
      }
      return;
    }
    const response = await fetch('/api/orders/operations/table-areas', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tableAreas: operationsConfig.tableAreas || [] }),
      signal: controller.signal,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Unable to save table allocation.');
    operationsConfig.tableAreas = Array.isArray(data.tableAreas) ? data.tableAreas : [];
    cacheTableAreas(operationsConfig.tableAreas);
    if (button) {
      button.textContent = 'Saved ✓';
      setTimeout(() => {
        if (button.isConnected) {
          button.disabled = false;
          button.textContent = originalLabel;
        }
      }, 1600);
    }
  } catch (error) {
    if (button) {
      button.disabled = false;
      button.textContent = originalLabel;
    }
    if (error.name === 'AbortError')
      throw new Error('Saving took too long. Check the internet connection, then try again.');
    throw error instanceof TypeError
      ? new Error('Unable to reach the server. Check the internet connection, then try again.')
      : error;
  } finally {
    clearTimeout(timeout);
  }
}
function addSelectedRoutes() {
  const printerId = String(document.getElementById('operation-route-printer')?.value || '');
  const categories = selectedRouteCategories();
  const itemName = String(document.getElementById('operation-route-item')?.value || '');
  const selectedItems = [...document.querySelectorAll('.operation-route-item-check:checked')]
    .map((input) => ({
      category: String(input.dataset.category || ''),
      itemName: String(input.value || ''),
    }))
    .filter((item) => item.category && item.itemName);
  const allCategories = !!document.getElementById('operation-route-all-categories')?.checked;
  if (!categories.length && !selectedItems.length && !allCategories) return false;
  if (!printerId) throw new Error('Choose a KOT printer before saving these categories.');
  if (allCategories) {
    operationsConfig.routes = operationsConfig.routes.filter(
      (route) =>
        !(
          route.printerId === printerId &&
          route.category === '*' &&
          !route.itemName &&
          !route.portion
        )
    );
    operationsConfig.routes.push({ id: operationId(), printerId, category: '*', itemName: '' });
    return true;
  }
  if (itemName && categories.length !== 1)
    throw new Error('Choose exactly one category to route a specific item.');
  categories.forEach((category) => {
    const duplicate = operationsConfig.routes.some(
      (route) =>
        route.printerId === printerId && route.category === category && route.itemName === itemName
    );
    if (!duplicate)
      operationsConfig.routes.push({ id: operationId(), printerId, category, itemName });
  });
  selectedItems.forEach(({ category, itemName: selectedItemName }) => {
    const duplicate = operationsConfig.routes.some(
      (route) =>
        route.printerId === printerId &&
        route.category === category &&
        route.itemName === selectedItemName
    );
    if (!duplicate)
      operationsConfig.routes.push({
        id: operationId(),
        printerId,
        category,
        itemName: selectedItemName,
      });
  });
  return true;
}
function printKot(orderId, printerId) {
  const order = orderRecords.get(orderId);
  if (!order) return;
  const printer = operationsConfig.printers.find((item) => item.id === printerId);
  const items = (Array.isArray(order.items) ? order.items : []).filter((item) =>
    routePrinters(item).some((route) => route.id === (printerId || ''))
  );
  if (!items.length) return;
  const popup = window.open('', 'red-lantern-kot', 'popup=yes,width=390,height=600');
  if (!popup) {
    alert('Please allow pop-ups to print this KOT.');
    return;
  }
  const number = String(order.daily_order_number || '—').padStart(2, '0');
  const tableLine =
    order.mode === 'table'
      ? `Table: ${order.table_area || 'Dining'} · ${order.table_number || '—'}`
      : `Order: ${fulfillmentLabel(order)}`;
  const guestLine = `Guest: ${order.customer_name || 'Walk-in customer'}`;
  popup.document.write(
    `<!doctype html><title>KOT #${esc(number)}</title><style>@page{size:80mm auto;margin:4mm}body{width:72mm;margin:0;font:12px Arial;color:#111}.center{text-align:center}.name{font-size:17px;font-weight:800}.rule{border:0;border-top:3px solid #111;margin:7px 0}.item{padding:3px 0;font-size:13px}.item b{font-size:15px}</style><div class="center"><div class="name">${esc(printer?.name || 'Unassigned')}</div></div><hr class="rule"><b>KOT # ${esc(number)}</b><br>${esc(tableLine)}<br>${esc(guestLine)}<hr class="rule">${items.map((item) => `<div class="item"><b>${Number(item.quantity || 0)}×</b> ${esc(item.name)}${item.portion ? ` (${esc(item.portion)})` : ''}${item.style ? ` · ${esc(item.style)}` : ''}</div>`).join('')}${order.special_request ? `<div class="item"><b>Note:</b> ${esc(order.special_request)}</div>` : ''}<hr class="rule"><script>window.onload=()=>setTimeout(()=>window.print(),120);window.onafterprint=()=>window.close();<\/script>`
  );
  popup.document.close();
}

async function dispatchKot(orderId, printerId) {
  const created = await fetch(`/api/orders/${encodeURIComponent(orderId)}/kots`, {
    method: 'POST',
  });
  const data = await created.json();
  if (!created.ok) {
    // The Reprint KOT action is already an explicit staff instruction. When
    // there are no new items, reuse the latest ticket immediately instead of
    // interrupting service with a browser confirmation dialog.
    if (data.latestKot) {
      data.kotNumber = data.latestKot.kot_number;
      data.tickets = data.latestKot.tickets;
      data.reprint = true;
    } else throw new Error(data.error || 'Unable to create KOT.');
  }
  if (data.reused)
    throw new Error(
      `KOT #${data.kotNumber} was already sent. Use Reprint if another copy is needed.`
    );
  await Promise.all(
    data.tickets.map(async (ticket) => {
      const response = await fetch(`${printBridgeOrigin}/v1/print-kot`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          printJobId: `manual-kot:${orderId}:${data.kotNumber}:${ticket.printerName}:${Date.now()}`,
          printerName: ticket.printerName,
          printerLabel: ticket.printerLabel,
          settings: printerFormat(
            operationsConfig.printers.find(
              (printer) => printer.deviceName === ticket.printerName
            ),
            'kot'
          ),
          items: ticket.items,
          order: {
            number: data.order.daily_order_number,
            kotNumber: data.kotNumber,
            reprint: !!data.reprint,
            customer: data.order.customer_name,
            tableArea: data.order.table_area,
            tableNumber: data.order.table_number,
            fulfillment: fulfillmentLabel(data.order),
            createdAt: data.order.created_at,
            note: data.order.special_request,
            source: data.order.order_source,
            captainName: data.order.captain_name,
            customerPhone: data.order.customer_phone,
            mode: data.order.mode,
          },
        }),
      });
      await requireCompletedBridgePrint(response, 'The Print Bridge could not send this KOT.');
    })
  );
}

const autoPrintInFlight = new Set();
const requestedTableBillInFlight = new Set();
async function autoPrintRequestedTableBill(order) {
  if (
    !order?.id ||
    order.mode !== 'table' ||
    order.service_state !== 'bill_requested' ||
    !['accepted', 'preparing', 'ready'].includes(order.status) ||
    requestedTableBillInFlight.has(order.id)
  )
    return;
  requestedTableBillInFlight.add(order.id);
  try {
    const bridge = await fetch(`${printBridgeOrigin}/health`, { cache: 'no-store' }).catch(() => null);
    if (!bridge?.ok) return;
    const operationsResponse = await fetch('/api/orders/operations', { cache: 'no-store' });
    const operations = await operationsResponse.json().catch(() => ({}));
    if (!operationsResponse.ok)
      throw new Error(operations.error || 'Printer configuration could not load.');
    const billPrinters = configuredPrintersFor(operations.config, 'bill');
    if (!billPrinters.length) throw new Error('No Bill printer is assigned in Operations.');
    const claimResponse = await fetch(`/api/orders/${encodeURIComponent(order.id)}/bill-print/claim`, {
      method: 'POST',
    });
    const claim = await claimResponse.json().catch(() => ({}));
    if (!claimResponse.ok) throw new Error(claim.error || 'Unable to reserve this bill for printing.');
    if (!claim.claimed) return;
    try {
      const receiptResponse = await fetch(`/api/orders/${encodeURIComponent(order.id)}/print`, {
        cache: 'no-store',
      });
      const receipt = await receiptResponse.json().catch(() => ({}));
      if (!receiptResponse.ok) throw new Error(receipt.error || 'Unable to prepare the receipt.');
      await printBillOnConfiguredPrinters(
        billPrinters,
        receipt,
        `captain-bill:${order.id}`
      );
      await fetch(`/api/orders/${encodeURIComponent(order.id)}/bill-print/complete`, {
        method: 'POST',
      });
      const marked = await fetch(`/api/orders/${encodeURIComponent(order.id)}/bill-printed`, {
        method: 'POST',
      });
      if (!marked.ok) throw new Error('Bill printed, but the table could not be marked for settlement.');
      await fetch(`/api/orders/${encodeURIComponent(order.id)}/service`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serviceState: 'active' }),
      });
      await loadOrders();
    } catch (error) {
      await fetch(`/api/orders/${encodeURIComponent(order.id)}/bill-print/failed`, {
        method: 'POST',
      }).catch(() => {});
      throw error;
    }
  } catch (error) {
    reportOrdersDiagnostic({
      level: 'warning',
      message: `Captain bill request could not print: ${error.message || 'Unknown error'}`,
      source: 'captain bill request',
    });
  } finally {
    requestedTableBillInFlight.delete(order.id);
  }
}
async function flushDeferredAutomaticPrints() {
  if (deferredPrintSyncInProgress || !navigator.onLine) return;
  const entries = deferredPrints();
  if (!entries.length) return;
  deferredPrintSyncInProgress = true;
  try {
    const health = await fetch(`${printBridgeOrigin}/health`, { cache: 'no-store' }).catch(() => null);
    if (!health?.ok) return;
    const remaining = [];
    for (const entry of entries) {
      const result = await autoPrintOrder(entry, { deferred: true });
      if (!result?.ok) {
        // Keep retrying only if the Bridge disappeared again. A reachable
        // Bridge that reports a printer/driver failure records that job for
        // staff review; repeatedly sending it could create duplicate slips.
        const bridgeStillOffline = !(await fetch(`${printBridgeOrigin}/health`, {
          cache: 'no-store',
        }).catch(() => null))?.ok;
        if (bridgeStillOffline) remaining.push(entry);
      }
    }
    saveDeferredPrints(remaining);
  } finally {
    deferredPrintSyncInProgress = false;
  }
}
async function autoPrintOrder(order, { deferred = false, kotOnly = false } = {}) {
  const canReleaseToKitchen =
    deferred ||
    order?.mode === 'counter' ||
    (order?.mode === 'table' && ['accepted', 'preparing', 'ready'].includes(order?.status));
  if (
    !order?.id ||
    !canReleaseToKitchen ||
    autoPrintInFlight.has(order.id) ||
    ['rejected', 'cancelled'].includes(order.status) ||
    (!deferred && order.status === 'completed')
  )
    return { ok: false, reason: 'This order is not ready to print yet.' };
  autoPrintInFlight.add(order.id);
  try {
    const bridge = await fetch(`${printBridgeOrigin}/health`, { cache: 'no-store' }).catch(() => null);
    if (!bridge?.ok) {
      const reason = 'Print Bridge is not available on this counter computer.';
      deferAutomaticPrint(order);
      reportOrdersDiagnostic({
        level: 'warning',
        message: `Automatic printing skipped: ${reason}`,
        source: 'automatic order printing',
      });
      return { ok: false, reason };
    }
    const operationsPromise = fetch('/api/orders/operations', { cache: 'no-store' }).then(
      async (response) => {
        const operations = await response.json();
        if (!response.ok)
          throw new Error(operations.error || 'Printer configuration could not load.');
        return Array.isArray(operations.config?.printers) ? operations.config.printers : [];
      }
    );
    const kotPromise = (async () => {
      try {
        const created = await fetch(`/api/orders/${encodeURIComponent(order.id)}/kots`, {
          method: 'POST',
        });
        const kot = await created.json().catch(() => ({}));
        const savedKot =
          !created.ok && created.status === 409 && kot.latestKot
            ? {
                kotNumber: kot.latestKot.kot_number,
                tickets: kot.latestKot.tickets,
                order: kot.order,
              }
            : kot;
        if (created.ok || savedKot.kotNumber) {
          const printers = await operationsPromise;
          await Promise.all(
            (savedKot.tickets || []).map(async (ticket) => {
              const settings = printerFormat(
                printers.find((printer) => printer.deviceName === ticket.printerName),
                'kot'
              );
              const response = await fetch(`${printBridgeOrigin}/v1/print-kot`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  printJobId: `auto-kot:${order.id}:${savedKot.kotNumber}:${ticket.printerName}`,
                  printerName: ticket.printerName,
                  printerLabel: ticket.printerLabel,
                  settings,
                  items: ticket.items,
                  order: {
                    number: savedKot.order?.daily_order_number,
                    kotNumber: savedKot.kotNumber,
                    customer: savedKot.order?.customer_name,
                    tableArea: savedKot.order?.table_area,
                    tableNumber: savedKot.order?.table_number,
                    fulfillment: fulfillmentLabel(savedKot.order),
                    createdAt: savedKot.order?.created_at,
                    note: savedKot.order?.special_request,
                    source: savedKot.order?.order_source,
                    captainName: savedKot.order?.captain_name,
                    customerPhone: savedKot.order?.customer_phone,
                    mode: savedKot.order?.mode,
                  },
                }),
              });
              await requireCompletedBridgePrint(response, 'KOT printer did not accept the job.');
            })
          );
        }
        if (!created.ok && created.status !== 409)
          throw new Error(kot.error || 'Unable to create the automatic KOT.');
        return { ok: true };
      } catch (error) {
        const reason = error.message || 'Automatic KOT printing failed.';
        reportOrdersDiagnostic({
          level: 'warning',
          message: `Automatic KOT printing failed: ${reason}`,
          source: 'automatic KOT printing',
        });
        return { ok: false, reason };
      }
    })();
    if (order.mode === 'table' || kotOnly) {
      const kotResult = await kotPromise;
      return kotResult.ok ? { ok: true, kotOnly: true } : kotResult;
    }
    // The bill starts at the same time as the KOT. Neither printer can delay the other.
    const billPromise = operationsPromise.then(async (printers) => {
      const billPrinters = configuredPrintersFor({ printers }, 'bill');
      if (!billPrinters.length) {
        const reason = 'No Bill printer is assigned in Operations.';
        reportOrdersDiagnostic({
          level: 'warning',
          message: `Automatic bill printing skipped: ${reason}`,
          source: 'automatic bill printing',
        });
        return { ok: false, reason };
      }
      const claimResponse = await fetch(
        `/api/orders/${encodeURIComponent(order.id)}/bill-print/claim`,
        { method: 'POST' }
      );
      const claim = await claimResponse.json().catch(() => ({}));
      if (!claimResponse.ok || !claim.claimed) return { ok: true };
      try {
        const receiptResponse = await fetch(`/api/orders/${encodeURIComponent(order.id)}/print`, {
          cache: 'no-store',
        });
        const receipt = await receiptResponse.json();
        if (!receiptResponse.ok) throw new Error(receipt.error || 'Unable to prepare the receipt.');
        await printBillOnConfiguredPrinters(billPrinters, receipt, `auto-bill:${order.id}`);
        await fetch(`/api/orders/${encodeURIComponent(order.id)}/bill-print/complete`, {
          method: 'POST',
        });
        return { ok: true };
      } catch (error) {
        await fetch(`/api/orders/${encodeURIComponent(order.id)}/bill-print/failed`, {
          method: 'POST',
        }).catch(() => {});
        throw error;
      }
    });
    const [, billResult] = await Promise.all([kotPromise, billPromise]);
    return billResult;
  } catch (error) {
    const reason = error.message || 'Automatic printing failed.';
    reportOrdersDiagnostic({
      message: `Automatic printing failed: ${reason}`,
      source: 'automatic order printing',
    });
    return { ok: false, reason };
  } finally {
    autoPrintInFlight.delete(order.id);
  }
}
const offlineMenuSnapshotKey = 'red-lantern-counter-menu-snapshot';
function saveOfflineMenuSnapshot(menu, availability) {
  try {
    localStorage.setItem(
      offlineMenuSnapshotKey,
      JSON.stringify({ menu, availability, savedAt: Date.now() })
    );
  } catch {}
}
function readOfflineMenuSnapshot() {
  try {
    const snapshot = JSON.parse(localStorage.getItem(offlineMenuSnapshotKey) || 'null');
    return Array.isArray(snapshot?.menu) && Array.isArray(snapshot?.availability) ? snapshot : null;
  } catch {
    return null;
  }
}
async function loadAvailability() {
  try {
    const [menuResponse, availabilityResponse] = await Promise.all([
      fetch('/api/orders/menu', { cache: 'no-store' }),
      fetch('/api/orders/availability', { cache: 'no-store' }),
    ]);
    if (!menuResponse.ok || !availabilityResponse.ok)
      throw new Error('Menu availability could not be loaded.');
    const menu = await menuResponse.json(),
      availability = await availabilityResponse.json();
    if (!Array.isArray(menu) || !Array.isArray(availability))
      throw new Error('Menu availability could not be read.');
    menuItems = menu;
    unavailable = new Map(availability.map((item) => [item.item_key, item.unavailable_until]));
    saveOfflineMenuSnapshot(menu, availability);
  } catch (error) {
    const snapshot = readOfflineMenuSnapshot();
    if (!snapshot) throw error;
    menuItems = snapshot.menu;
    unavailable = new Map(
      snapshot.availability.map((item) => [item.item_key, item.unavailable_until])
    );
  }
  renderAvailability();
}

function renderAvailability() {
  const query = String(menuSearch.value || '')
    .trim()
    .toLowerCase();
  const typeItems = menuItems.filter((item) => item.menuType === menuType);
  const activeUnavailable = new Set(
    [...unavailable].filter(([, until]) => new Date(until) > new Date()).map(([key]) => key)
  );
  const unavailableForType = typeItems.filter((item) => activeUnavailable.has(item.key)).length;
  const inStockCount = typeItems.length - unavailableForType;
  document.getElementById('menu-type-tabs').innerHTML = [
    ['food', 'Food Menu'],
    ['bar', 'Bar Menu'],
  ]
    .map(
      ([value, label]) =>
        `<button class="menu-type-tab ${menuType === value ? 'is-active' : ''}" data-menu-type="${value}" aria-pressed="${menuType === value}">${label}<span>${menuItems.filter((item) => item.menuType === value).length}</span></button>`
    )
    .join('');
  menuSearch.placeholder = `Search ${menuType === 'food' ? 'food' : 'bar'} menu`;
  document.getElementById('availability-counts').innerHTML =
    `<span class="stock-count in">${inStockCount} in stock</span><span class="stock-count out">${unavailableForType} unavailable</span>`;
  document.getElementById('availability-filters').innerHTML = [
    ['all', 'All items'],
    ['in', 'In stock'],
    ['out', 'Unavailable'],
  ]
    .map(
      ([value, label]) =>
        `<button class="filter-button ${availabilityFilter === value ? 'is-active' : ''}" data-availability-filter="${value}" aria-pressed="${availabilityFilter === value}">${label}</button>`
    )
    .join('');
  const visible = typeItems
    .filter((item) => {
      const isOut = activeUnavailable.has(item.key);
      return (
        `${item.name} ${item.category}`.toLowerCase().includes(query) &&
        (availabilityFilter === 'all' || (availabilityFilter === 'out' ? isOut : !isOut))
      );
    })
    .sort((a, b) => `${a.category} ${a.name}`.localeCompare(`${b.category} ${b.name}`));
  menuResults.innerHTML = visible.length
    ? visible
        .map((item) => {
          const until = activeUnavailable.has(item.key) ? unavailable.get(item.key) : null;
          const status = until
            ? `Out until ${new Date(until).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}`
            : 'In stock';
          return `<article class="menu-item ${until ? 'is-out' : ''}" data-key="${esc(item.key)}"><div class="menu-item-name"><b>${esc(item.name)}</b><span>${esc(item.category || 'Menu')}</span></div><div class="availability-state"><i aria-hidden="true"></i>${status}</div><div class="availability-controls">${until ? `<button class="stock-in" data-stock-action="restore">Mark in stock</button>` : `<button class="stock-tomorrow" data-stock-action="tomorrow">Out until tomorrow</button><label><span>Custom restock</span><input type="datetime-local" value="${tomorrowLocal()}" data-stock-until></label><button class="stock-date" data-stock-action="date">Mark unavailable</button>`}</div></article>`;
        })
        .join('')
    : '<div class="empty-state">No menu items match that search.</div>';
}

async function updateAvailability(key, unavailableUntil) {
  const url = `/api/orders/availability/${encodeURIComponent(key)}`;
  if (
    await queueWhenOffline('availability-update', { key, unavailableUntil }, () => {
      if (unavailableUntil) unavailable.set(key, unavailableUntil);
      else unavailable.delete(key);
      renderAvailability();
    })
  )
    return;
  const response = await fetch(
    url,
    unavailableUntil
      ? {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ unavailableUntil }),
        }
      : { method: 'DELETE' }
  );
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || 'Unable to update availability.');
  }
  await loadAvailability();
}

document.getElementById('availability-toggle')?.addEventListener('click', async () => {
  const isOpening = availability.hidden;
  if (isOpening) closeOpenPanels('availability');
  availability.hidden = !isOpening;
  document.getElementById('availability-toggle').setAttribute('aria-expanded', String(isOpening));
  if (!isOpening) {
    setOrdersRailActive('tables');
    rememberOrdersWorkspace('tables');
  }
  if (isOpening) {
    setOrdersRailActive('availability');
    rememberOrdersWorkspace('availability');
    try {
      await loadAvailability();
    } catch (error) {
      menuResults.innerHTML = `<div class="empty-state">${esc(error.message)}</div>`;
    }
  }
});
liveOrdersToggle.addEventListener('click', () => {
  const isOpening = liveOrdersPanel.hidden;
  if (isOpening) closeOpenPanels('live');
  liveOrdersPanel.hidden = !isOpening;
  liveOrdersToggle.classList.toggle('is-open', isOpening);
  liveOrdersToggle.setAttribute('aria-expanded', String(isOpening));
  if (!isOpening) {
    setOrdersRailActive('tables');
    rememberOrdersWorkspace('tables');
  }
  if (isOpening) {
    setOrdersRailActive('live');
    rememberOrdersWorkspace('live');
    orderView = 'current';
    historyAll = false;
    document
      .querySelectorAll('[data-order-view]')
      .forEach((tab) => tab.classList.toggle('is-active', tab.dataset.orderView === 'current'));
    const dateWrap = document.getElementById('history-date-wrap');
    if (dateWrap) dateWrap.hidden = true;
    loadOrders();
    liveOrdersPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
});
document.getElementById('availability-close')?.addEventListener('click', () => {
  availability.hidden = true;
  document.getElementById('availability-toggle').setAttribute('aria-expanded', 'false');
  setOrdersRailActive('tables');
  rememberOrdersWorkspace('tables');
});
document.getElementById('counter-order-close')?.addEventListener('click', () => {
  counterPanel.hidden = true;
  document.body.classList.remove('is-counter-workspace');
  rememberOrdersWorkspace('tables');
  showTableView();
});
document.getElementById('view-table-kot')?.addEventListener('click', () => {
  const orderId = document.getElementById('view-table-kot').dataset.orderId,
    order = orderRecords.get(orderId),
    entries = operationKotHistory.get(orderId) || [];
  if (!order) return;
  document.getElementById('view-kot-content').innerHTML = entries.length
    ? entries
        .map(
          (kot) =>
            `<section class="view-kot-ticket"><h3>KOT #${esc(kot.kot_number)} <small>${kot.created_at ? new Date(kot.created_at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : ''}</small></h3>${(
              kot.tickets || []
            )
              .flatMap((ticket) => ticket.items || [])
              .map((item) => {
                const index = (order.items || []).findIndex(
                  (candidate) =>
                    candidate.name === item.name &&
                    String(candidate.portion || '') === String(item.portion || '') &&
                    Number(candidate.quantity || 0) > 0
                );
                return `<div><b>${Number(item.quantity || 0)}×</b> ${esc(item.name)}${item.portion ? ` · ${esc(item.portion)}` : ''}<span>₹${Number(String(item.price || 0).replace(/[^0-9.]/g, '') || 0).toFixed(0)}</span>${index >= 0 ? `<button type="button" class="view-kot-edit" data-view-kot-edit="${index}">Edit qty</button><button type="button" class="view-kot-delete" data-view-kot-delete="${index}">Delete</button>` : ''}</div>`;
              })
              .join('')}</section>`
        )
        .join('')
    : '<p>No KOT has been sent for this table yet.</p>';
  viewKotDialog.showModal();
});
viewKotDialog.addEventListener('click', async (event) => {
  if (event.target.closest('.view-kot-close')) {
    viewKotDialog.close();
    return;
  }
  const edit = event.target.closest('[data-view-kot-edit]'),
    button = edit || event.target.closest('[data-view-kot-delete]');
  if (!button) return;
  const orderId = document.getElementById('view-table-kot')?.dataset.orderId,
    order = orderRecords.get(orderId),
    index = Number(edit ? edit.dataset.viewKotEdit : button.dataset.viewKotDelete);
  if (!order || !Number.isInteger(index)) return;
  let quantity = 0;
  if (edit) {
    const current = Number(order.items?.[index]?.quantity || 0),
      entered = prompt(
        `Quantity for ${order.items?.[index]?.name || 'this item'} (1–20):`,
        String(current)
      );
    if (entered === null) return;
    quantity = Number(entered);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 20) {
      alert('Enter a whole quantity from 1 to 20.');
      return;
    }
  } else if (!confirm('Delete this item from the active table bill?')) return;
  const quantities = (order.items || []).map((item, itemIndex) =>
    itemIndex === index ? quantity : Number(item.quantity || 0)
  );
  button.disabled = true;
  try {
    if (
      await queueWhenOffline('order-items', { orderId, quantities }, () => {
        order.items = order.items
          .map((item, itemIndex) => ({ ...item, quantity: quantities[itemIndex] }))
          .filter((item) => item.quantity > 0);
        cacheTableOrders([...orderRecords.values()]);
        renderTableView();
      })
    ) {
      viewKotDialog.close();
      return;
    }
    const response = await fetch(`/api/orders/${encodeURIComponent(orderId)}/items`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ quantities }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok)
      throw new Error(data.error || `Unable to ${edit ? 'modify' : 'delete'} this item.`);
    await loadOrders();
    viewKotDialog.close();
  } catch (error) {
    alert(error.message || `Unable to ${edit ? 'modify' : 'delete'} this item.`);
    button.disabled = false;
  }
});
document.getElementById('table-view-content')?.addEventListener('click', async (event) => {
  const areaFilter = event.target.closest('[data-table-area-filter]');
  if (areaFilter) {
    tableViewAreaFilter = areaFilter.dataset.tableAreaFilter || 'all';
    renderTableView();
    return;
  }
  if (event.target.closest('[data-toggle-move-kot]')) {
    moveKotItemsMode = !moveKotItemsMode;
    renderTableView();
    return;
  }
  const viewOrder = event.target.closest('[data-view-table-order]');
  if (viewOrder) {
    const order = orderRecords.get(viewOrder.dataset.viewTableOrder);
    if (!order) return;
    counterBillSplit = null;
    counterCart = (Array.isArray(order.items) ? order.items : []).map((item) => ({
      ...item,
      price: Number(String(item.price || 0).replace(/[^0-9.]/g, '')),
    }));
    await openCounterOrder({
      area: order.table_area || 'Dining',
      number: Number(order.table_number),
      orderId: order.id,
    });
    document.getElementById('counter-customer-name').value = order.customer_name || '';
    document.getElementById('counter-customer-phone').value = String(
      order.customer_phone || ''
    ).startsWith('walkin-')
      ? ''
      : order.customer_phone || '';
    document.getElementById('counter-special-request').value = order.special_request || '';
    renderCounterOrder();
    return;
  }
  const printBill = event.target.closest('[data-print-table-bill]');
  if (printBill) {
    const order = orderRecords.get(printBill.dataset.printTableBill);
    if (!order) return;
    printBill.disabled = true;
    printBill.textContent = '…';
    try {
      await printOrder(order.id);
      const marked = await fetch(`/api/orders/${encodeURIComponent(order.id)}/bill-printed`, {
        method: 'POST',
      });
      const data = await marked.json().catch(() => ({}));
      if (!marked.ok)
        throw new Error(
          data.error || 'Bill printed, but the table could not be marked for settlement.'
        );
      await loadOrders();
      renderTableView();
    } catch (error) {
      alert(error.message || 'Unable to print this table bill.');
      printBill.disabled = false;
      renderTableView();
    }
    return;
  }
  const moving = event.target.closest('[data-move-table-order]');
  if (moving) {
    openMoveTable(moving.dataset.moveTableOrder);
    return;
  }
  const settling = event.target.closest('[data-settle-table-order]');
  if (settling) {
    const order = orderRecords.get(settling.dataset.settleTableOrder);
    if (!order) return;
    settleTableDialog.dataset.orderId = order.id;
    document.getElementById('settle-table-title').textContent =
      `Settle & Save — ${order.table_area} ${order.table_number} [₹${Number(order.total || 0).toFixed(0)}]`;
    document.getElementById('settlement-amount').value = Number(order.total || 0).toFixed(0);
    document.getElementById('settle-table-status').textContent = '';
    settleTableDialog.showModal();
    return;
  }
  const saved = event.target.closest('[data-open-saved-table]');
  if (saved) {
    const order = [...orderRecords.values()].find(
      (item) =>
        item.mode === 'table' &&
        String(item.table_area || '') === saved.dataset.openSavedTable &&
        String(item.table_number || '') === saved.dataset.openSavedNumber &&
        ['saved', 'held'].includes(item.status)
    );
    if (!order) return;
    counterBillSplit = null;
    counterCart = (Array.isArray(order.items) ? order.items : []).map((item) => ({
      ...item,
      price: Number(String(item.price || 0).replace(/[^0-9.]/g, '')),
    }));
    await openCounterOrder({
      area: order.table_area || 'Dining',
      number: Number(order.table_number),
    });
    document.getElementById('counter-customer-name').value = order.customer_name || '';
    document.getElementById('counter-customer-phone').value = String(
      order.customer_phone || ''
    ).startsWith('walkin-')
      ? ''
      : order.customer_phone || '';
    document.getElementById('counter-special-request').value = order.special_request || '';
    renderCounterOrder();
    return;
  }
  const table = event.target.closest('[data-dine-table-number]');
  if (!table) return;
  counterBillSplit = null;
  const existing = [...orderRecords.values()].find(
    (order) =>
      order.mode === 'table' &&
      String(order.table_area) === String(table.dataset.dineTableArea || 'Dining') &&
      Number(order.table_number) === Number(table.dataset.dineTableNumber) &&
      !['completed', 'rejected', 'cancelled'].includes(order.status)
  );
  if (String(existing?.id || '').startsWith('offline:')) {
    alert(
      'This table order is safely stored on this device and waiting to sync. Reconnect to continue editing it.'
    );
    return;
  }
  openCounterOrder({
    area: table.dataset.dineTableArea || 'Dining',
    number: Number(table.dataset.dineTableNumber),
    orderId: existing?.id || '',
  });
});
document.getElementById('table-view-content')?.addEventListener('input', (event) => {
  if (event.target.id !== 'table-view-search') return;
  tableViewSearch = event.target.value || '';
  renderTableView();
});
const newOrderAction = document.createElement('button');
newOrderAction.type = 'button';
newOrderAction.id = 'new-order-action';
newOrderAction.className = 'fulfillment-action';
newOrderAction.textContent = 'New Order';
document.querySelector('[data-fulfillment-filter="pickup"]')?.before(newOrderAction);
const newOrderActionStyles = document.createElement('style');
newOrderActionStyles.textContent = '';
document.head.appendChild(newOrderActionStyles);
newOrderAction.addEventListener('click', async () => {
  closeOpenPanels('tables');
  rememberOrdersWorkspace('tables');
  await showTableView();
  tableViewPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
});
settleTableDialog.addEventListener('click', async (event) => {
  if (event.target.closest('.settle-close,.settle-cancel')) {
    settleTableDialog.close();
    return;
  }
  const button = event.target.closest('.settle-confirm');
  if (!button) return;
  button.disabled = true;
  const status = document.getElementById('settle-table-status');
  status.textContent = 'Settling table…';
  let settlementPayload = null;
  try {
    const paymentType =
        document.querySelector('input[name="settlement-type"]:checked')?.value || '',
      orderId = settleTableDialog.dataset.orderId,
      amount = Number(document.getElementById('settlement-amount').value || 0),
      requestId = settlementRequestId(),
      payload = { orderId, paymentType, amount, requestId };
    settlementPayload = payload;
    const applyLocal = () => {
      const order = orderRecords.get(orderId);
      if (order) order.status = 'completed';
      cacheTableOrders([...orderRecords.values()]);
      renderTableView();
    };
    if (await queueWhenOffline('settlement', payload, applyLocal)) {
      settleTableDialog.close();
      return;
    }
    const response = await fetch(`/api/orders/${encodeURIComponent(orderId)}/settle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Settlement-Id': requestId },
      body: JSON.stringify({ paymentType, amount, requestId }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Unable to settle this table.');
    settleTableDialog.close();
    await loadOrders();
    await showTableView();
  } catch (error) {
    if (settlementPayload && error instanceof TypeError) {
      try {
        await saveBridgeAction('settlement', settlementPayload);
        const order = orderRecords.get(settlementPayload.orderId);
        if (order) order.status = 'completed';
        cacheTableOrders([...orderRecords.values()]);
        renderTableView();
        settleTableDialog.close();
        updateConnectivity(
          'Settlement saved safely on this computer. It will sync when internet returns.'
        );
        return;
      } catch (ledgerError) {
        status.textContent = ledgerError.message || 'Unable to safely save this settlement.';
        return;
      }
    }
    status.textContent = error.message || 'Unable to settle this table.';
  } finally {
    button.disabled = false;
  }
});
document.getElementById('counter-menu-search')?.addEventListener('input', renderCounterOrder);
document.getElementById('counter-customer-phone')?.addEventListener('input', () => {
  clearTimeout(counterLoyaltyTimer);
  counterLoyaltyTimer = setTimeout(loadCounterLoyalty, 300);
});
const walletRedeemInput = document.getElementById('counter-wallet-redeem');
walletRedeemInput?.addEventListener('input', () => renderCounterOrder());
walletRedeemInput?.addEventListener('change', (event) => {
  const value = Math.max(0, Math.floor(Number(event.target.value) || 0));
  event.target.value = String(value >= 100 ? Math.min(value, counterLoyaltyPoints) : 0);
  renderCounterOrder();
});
document.getElementById('counter-categories')?.addEventListener('click', (event) => {
  const button = event.target.closest('[data-counter-category]');
  if (!button) return;
  counterCategory = button.dataset.counterCategory || 'all';
  renderCounterOrder();
});
document.getElementById('counter-menu-items')?.addEventListener('click', (event) => {
  const button = event.target.closest('[data-counter-item]');
  if (!button) return;
  const item = counterMenu[Number(button.dataset.counterItem)];
  if (!item) return;
  const options = counterPortionOptions(item);
  if (options.length > 1 || item.gravyStyleAvailable) {
    openCounterChoice(item);
    return;
  }
  const [portion, , rawPrice] = options[0] || ['', 'Regular', 0];
  const price = Number(String(rawPrice).replace(/[^0-9.]/g, ''));
  if (!price) {
    document.getElementById('counter-order-status').textContent =
      'This item has no price set in Menu Admin yet.';
    return;
  }
  const existing = counterCart.find(
    (line) =>
      line.name === item.name &&
      line.category === item.category &&
      line.menuType === item.menuType &&
      line.portion === portion &&
      !line.style &&
      !line.courseOverride
  );
  if (existing) existing.quantity += 1;
  else
    counterCart.push({
      name: item.name,
      category: item.category,
      menuType: item.menuType,
      portion,
      style: '',
      defaultCourse: item.defaultCourse || '',
      courseOverride: '',
      price,
      quantity: 1,
    });
  counterBillSplit = null;
  renderCounterOrder();
});
document.getElementById('counter-choice-dialog')?.addEventListener('change', (event) => {
  if (event.target.matches('input[name="counter-portion"], input[name="counter-style"]'))
    updateCounterChoiceTotal();
});
document.getElementById('counter-choice-dialog')?.addEventListener('click', (event) => {
  if (event.target.closest('[data-counter-choice-close]')) {
    document.getElementById('counter-choice-dialog').close();
    return;
  }
  if (!event.target.closest('#counter-choice-add') || !counterChoiceItem) return;
  const portionInput = document.querySelector('input[name="counter-portion"]:checked');
  const portion = portionInput?.value || '',
    price = Number(portionInput?.dataset.counterChoicePrice || 0);
  const style = document.querySelector('input[name="counter-style"]:checked')?.value || '';
  const courseOverride = document.getElementById('counter-choice-course')?.value || '';
  const existing = counterCart.find(
    (line) =>
      line.name === counterChoiceItem.name &&
      line.category === counterChoiceItem.category &&
      line.menuType === counterChoiceItem.menuType &&
      line.portion === portion &&
      line.style === style &&
      String(line.courseOverride || '') === courseOverride
  );
  if (existing) existing.quantity += 1;
  else
    counterCart.push({
      name: counterChoiceItem.name,
      category: counterChoiceItem.category,
      menuType: counterChoiceItem.menuType,
      portion,
      style,
      defaultCourse: counterChoiceItem.defaultCourse || '',
      courseOverride,
      price,
      quantity: 1,
    });
  counterBillSplit = null;
  document.getElementById('counter-choice-dialog').close();
  renderCounterOrder();
});
document.getElementById('counter-cart-items')?.addEventListener('click', (event) => {
  const button = event.target.closest('[data-counter-qty]');
  if (!button) return;
  const index = Number(button.dataset.counterQty),
    line = counterCart[index];
  if (!line) return;
  line.quantity += Number(button.dataset.counterChange);
  if (line.quantity <= 0) counterCart.splice(index, 1);
  counterBillSplit = null;
  renderCounterOrder();
});
document.getElementById('counter-cart-items')?.addEventListener('change', (event) => {
  const select = event.target.closest('[data-counter-course]');
  if (!select) return;
  const line = counterCart[Number(select.dataset.counterCourse)];
  if (!line) return;
  line.courseOverride = select.value || '';
  counterBillSplit = null;
  renderCounterOrder();
});
document.getElementById('counter-clear')?.addEventListener('click', () => {
  counterBillSplit = null;
  counterCart = [];
  resetCounterRequestAttempt();
  setCounterOrderStatus('');
  renderCounterOrder();
});
function setCounterOrderStatus(message, state = '') {
  const status = document.getElementById('counter-order-status');
  if (!status) return;
  status.textContent = message;
  if (state) status.dataset.state = state;
  else delete status.dataset.state;
}
async function submitDineInAction(action) {
  if (!counterCart.length) {
    setCounterOrderStatus('Add at least one menu item first.', 'error');
    return;
  }
  const isDineIn = !!counterTable;
  const operationId = ++counterOrderOperation;
  const button = document.querySelector(`[data-dine-action="${action}"]`);
  const actionButtons = [...document.querySelectorAll('#dine-in-actions button')];
  const idleButtonLabel = button?.textContent || '';
  actionButtons.forEach((actionButton) => {
    actionButton.disabled = true;
  });
  if (button) {
    button.classList.add('is-processing');
    button.setAttribute('aria-busy', 'true');
    button.textContent =
      action === 'kot-print'
        ? 'Saving KOT…'
        : action === 'print'
          ? 'Preparing bill…'
          : action === 'hold'
            ? 'Holding…'
            : 'Saving…';
  }
  const payload = {
    action,
    customerName: document.getElementById('counter-customer-name').value.trim(),
    customerPhone: document.getElementById('counter-customer-phone').value.trim(),
    specialRequest: document.getElementById('counter-special-request').value.trim(),
    courseMode: document.getElementById('counter-course-mode')?.value || 'normal_coursing',
    loyaltyPoints: Math.floor(Number(document.getElementById('counter-wallet-redeem')?.value || 0)),
    tableArea: counterTable?.area || '',
    tableNumber: counterTable?.number || '',
    items: counterCart.map((item) => ({ ...item })),
  };
  payload.clientRequestId = counterRequestId(payload);
  const orderLabel = isDineIn
    ? `${counterTable.area} · Table ${String(counterTable.number).padStart(2, '0')}`
    : 'Takeaway order';
  let savedInBridgeLedger = false;
  try {
    setCounterOrderStatus(
      action === 'hold'
        ? `Holding ${isDineIn ? 'table bill' : 'takeaway order'}…`
        : action === 'save'
          ? `Saving ${isDineIn ? 'table bill' : 'takeaway order'}…`
          : action === 'kot-print'
            ? 'Saving the order securely…'
            : `Saving ${isDineIn ? 'dine-in bill' : 'takeaway order'}…`,
      'sending'
    );
    if (['save', 'hold'].includes(action)) {
      try {
        await saveToBridgeLedger(payload);
        savedInBridgeLedger = true;
      } catch (ledgerError) {
        reportOrdersDiagnostic({
          level: 'warning',
          message: `Local ledger unavailable: ${ledgerError.message}`,
          source: isDineIn ? 'offline dine-in ledger' : 'offline takeaway ledger',
        });
      }
    }
    if (!navigator.onLine) {
      if (!['save', 'hold'].includes(action))
        throw new Error(
          'KOT and final bill printing need an online order confirmation. Save or hold the order first; it will sync safely when the connection returns.'
        );
      throw new TypeError('Offline');
    }
    const result = await sendCounterOrder(payload);
    if (savedInBridgeLedger) {
      await updateBridgeLedger(payload.clientRequestId, 'synced');
      bridgeLedgerPending = Math.max(0, bridgeLedgerPending - 1);
      updateConnectivity();
    }
    if (action === 'kot-print') {
      const savedOrderLabel = isDineIn
        ? orderLabel
        : `Takeaway order #${result.orderNumber}`;
      counterBillSplit = null;
      counterCart = [];
      resetCounterRequestAttempt();
      counterLoyaltyPoints = 0;
      document.getElementById('counter-customer-name').value = '';
      document.getElementById('counter-customer-phone').value = '';
      document.getElementById('counter-special-request').value = '';
      document.getElementById('counter-wallet-redeem').value = '0';
      counterWallet.hidden = true;
      renderCounterOrder();
      setCounterOrderStatus(
        `${savedOrderLabel} saved. Sending the KOT to the kitchen…`,
        'sending'
      );
      // Saving to the database is the success boundary for the POS. Printer
      // discovery and physical output continue without blocking the counter.
      void autoPrintOrder({
        id: result.id,
        mode: isDineIn ? 'table' : 'counter',
        status: result.status || 'accepted',
      }, { kotOnly: true }).then((printing) => {
        if (operationId !== counterOrderOperation) return;
        if (printing?.ok)
          setCounterOrderStatus(
            `${savedOrderLabel} saved — KOT sent to the configured kitchen printers.`,
            'success'
          );
        else
          setCounterOrderStatus(
            `${savedOrderLabel} is safely saved, but KOT printing needs attention. ${printing?.reason || 'Check Operations.'}`,
            'error'
          );
      });
      void loadOrders();
      void refreshCounterLiveStatus();
      if (isDineIn) void showTableView();
      return;
    } else if (action === 'print') {
      await printOrder(result.id, counterBillSplit);
      const marked = await fetch(`/api/orders/${encodeURIComponent(result.id)}/bill-printed`, {
        method: 'POST',
      });
      const markedData = await marked.json().catch(() => ({}));
      if (!marked.ok)
        throw new Error(
          markedData.error || 'Bill printed, but the table could not be marked for settlement.'
        );
      setCounterOrderStatus(
        isDineIn
          ? `${orderLabel}: bill printed and waiting for settlement.`
          : `${orderLabel}: eBill printed.`,
        'success'
      );
    } else
      setCounterOrderStatus(
        action === 'hold' ? `${orderLabel} is on hold.` : `${orderLabel} saved for later.`,
        'success'
      );
    counterBillSplit = null;
    counterCart = [];
    resetCounterRequestAttempt();
    renderCounterOrder();
    await loadOrders();
    if (isDineIn) await showTableView();
  } catch (error) {
    if (
      (!navigator.onLine || !error.status || error.status >= 500) &&
      ['save', 'hold'].includes(action)
    ) {
      if (!savedInBridgeLedger) {
        const queued = queuedCounterOrders();
        queued.push(payload);
        saveQueuedCounterOrders(queued);
      }
      if (isDineIn) reserveOfflineTable(payload);
      counterBillSplit = null;
      counterCart = [];
      resetCounterRequestAttempt();
      renderCounterOrder();
      setCounterOrderStatus(
        isDineIn
          ? `${orderLabel} is saved offline and reserved. It will sync automatically when internet returns.`
          : `${orderLabel} is saved offline. It will sync automatically when internet returns.`,
        'success'
      );
      updateConnectivity();
    } else
      setCounterOrderStatus(
        !error.status && /failed to fetch|network\s*error/i.test(String(error.message || ''))
          ? 'Unable to confirm the save because the connection was interrupted. Your order is still here—press Send KOT again.'
          : error.message ||
              `Unable to save this ${isDineIn ? 'dine-in bill' : 'takeaway order'}.`,
        'error'
      );
  } finally {
    if (button) {
      button.classList.remove('is-processing');
      button.removeAttribute('aria-busy');
      button.textContent = idleButtonLabel;
    }
    const hasItems = counterCart.length > 0;
    actionButtons.forEach((actionButton) => {
      actionButton.disabled = !hasItems;
    });
  }
}
document.getElementById('dine-in-actions')?.addEventListener('click', async (event) => {
  const action = event.target.closest('[data-dine-action]')?.dataset.dineAction;
  if (!action) return;
  if (action === 'split') {
    openSplitBill();
    return;
  }
  await submitDineInAction(action);
});
document.getElementById('counter-place-order')?.addEventListener('click', async () => {
  const status = document.getElementById('counter-order-status');
  if (!counterCart.length) {
    status.textContent = 'Add at least one menu item first.';
    return;
  }
  const button = document.getElementById('counter-place-order');
  const operationId = ++counterOrderOperation;
  button.disabled = true;
  const payload = {
    customerName: document.getElementById('counter-customer-name').value.trim(),
    customerPhone: document.getElementById('counter-customer-phone').value.trim(),
    specialRequest: document.getElementById('counter-special-request').value.trim(),
    courseMode: document.getElementById('counter-course-mode')?.value || 'normal_coursing',
    loyaltyPoints: Math.floor(Number(document.getElementById('counter-wallet-redeem')?.value || 0)),
    tableArea: counterTable?.area || '',
    tableNumber: counterTable?.number || '',
    items: counterCart.map((item) => ({ ...item })),
  };
  payload.clientRequestId = counterRequestId(payload);
  if (payload.loyaltyPoints >= 100) {
    const first = window.confirm(`Apply ₹${payload.loyaltyPoints} from this customer's wallet?`);
    const second =
      first &&
      window.confirm(
        `Final confirmation: deduct ${payload.loyaltyPoints} wallet points (₹${payload.loyaltyPoints}) from this order?`
      );
    if (!second) {
      button.disabled = false;
      status.textContent =
        'Wallet points were not applied. Review the amount before placing the order.';
      return;
    }
  }
  const orderLabel = counterTable
    ? `${counterTable.area} Table ${String(counterTable.number).padStart(2, '0')}`
    : 'takeaway';
  status.textContent = navigator.onLine
    ? `Saving ${orderLabel} order…`
    : 'Internet is unavailable — saving this order safely on this device…';
  let savedInBridgeLedger = false;
  try {
    let result;
    try {
      await saveToBridgeLedger(payload);
      savedInBridgeLedger = true;
    } catch (ledgerError) {
      reportOrdersDiagnostic({
        level: 'warning',
        message: `Local ledger unavailable: ${ledgerError.message}`,
        source: 'offline order ledger',
      });
    }
    if (!navigator.onLine) throw new TypeError('Offline');
    result = await sendCounterOrder(payload);
    if (savedInBridgeLedger) {
      await updateBridgeLedger(payload.clientRequestId, 'synced');
      bridgeLedgerPending = Math.max(0, bridgeLedgerPending - 1);
      updateConnectivity();
    }
    status.textContent = `${counterTable ? `${counterTable.area} Table ${String(counterTable.number).padStart(2, '0')}` : `Takeaway order #${result.orderNumber}`} accepted. Sending KOTs…`;
    counterCart = [];
    resetCounterRequestAttempt();
    counterLoyaltyPoints = 0;
    document.getElementById('counter-customer-name').value = '';
    document.getElementById('counter-customer-phone').value = '';
    document.getElementById('counter-special-request').value = '';
    document.getElementById('counter-wallet-redeem').value = '0';
    counterWallet.hidden = true;
    renderCounterOrder();
    void autoPrintOrder({
      id: result.id,
      mode: counterTable ? 'table' : 'counter',
      status: result.status || 'accepted',
    }).then((printing) => {
      if (operationId !== counterOrderOperation) return;
      if (printing?.ok)
        status.textContent = `${counterTable ? `${counterTable.area} Table ${String(counterTable.number).padStart(2, '0')}` : `Takeaway order #${result.orderNumber}`} accepted. KOTs were sent to the configured kitchens.`;
      else if (printing?.reason)
        status.textContent = `${orderLabel} order accepted. ${printing.reason} Check Operations / Orders Error Logs.`;
    });
    loadOrders();
    refreshCounterLiveStatus();
  } catch (error) {
    if (!navigator.onLine || !error.status || error.status >= 500) {
      if (!savedInBridgeLedger) {
        const queued = queuedCounterOrders();
        queued.push(payload);
        saveQueuedCounterOrders(queued);
      }
      reserveOfflineTable(payload);
      counterCart = [];
      resetCounterRequestAttempt();
      document.getElementById('counter-customer-name').value = '';
      document.getElementById('counter-customer-phone').value = '';
      document.getElementById('counter-special-request').value = '';
      renderCounterOrder();
      status.textContent = counterTable
        ? 'Table order saved offline and the table is reserved. It will sync automatically when internet returns.'
        : 'Takeaway order saved offline. It will be sent automatically when internet returns.';
      updateConnectivity();
    } else {
      if (savedInBridgeLedger) {
        try {
          await updateBridgeLedger(payload.clientRequestId, 'blocked', error.message);
        } catch (_) {}
      }
      status.textContent = error.message;
    }
  } finally {
    button.disabled = false;
  }
});
operationsToggle.addEventListener('click', async () => {
  const opening = operationsPanel.hidden;
  if (opening) closeOpenPanels('operations');
  operationsPanel.hidden = !opening;
  operationsToggle.classList.toggle('is-open', opening);
  operationsToggle.setAttribute('aria-expanded', String(opening));
  if (!opening) {
    setOrdersRailActive('tables');
    rememberOrdersWorkspace('tables');
    return;
  }
  setOrdersRailActive('operations');
  rememberOrdersWorkspace('operations', operationsTab);
  const hasSnapshot =
    (operationsConfig.printers || []).length ||
    (operationsConfig.routes || []).length ||
    (operationsConfig.tableAreas || []).length;
  if (hasSnapshot) renderOperations();
  else
    document.getElementById('operations-content').innerHTML =
      '<div class="operations-empty">Loading Operations…</div>';
  operationsPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  try {
    await loadOrders();
    renderOperations();
  } catch (error) {
    if (!hasSnapshot)
      document.getElementById('operations-content').innerHTML =
        `<div class="operations-empty">${esc(error.message)}</div>`;
  }
  void loadOperations()
    .then(() => {
      if (!operationsPanel.hidden) renderOperations();
    })
    .catch(() => {});
  void discoverSystemPrinters();
});
document.querySelector('.orders-rail')?.addEventListener('click', async (event) => {
  const control = event.target.closest('[data-orders-rail]');
  if (!control) return;
  const workspace = control.dataset.ordersRail;
  if (workspace === 'tables') {
    event.preventDefault();
    closeOpenPanels('tables');
    rememberOrdersWorkspace('tables');
    await showTableView();
    tableViewPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  if (workspace === 'counter') {
    event.preventDefault();
    if (counterPanel.hidden) await openCounterOrder();
    else counterPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  if (workspace === 'live') {
    event.preventDefault();
    if (liveOrdersPanel.hidden) liveOrdersToggle.click();
    else liveOrdersPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  if (workspace === 'availability') {
    event.preventDefault();
    if (availability.hidden) availabilityButton?.click();
    else availability.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  if (workspace === 'operations') {
    event.preventDefault();
    if (operationsPanel.hidden) operationsToggle.click();
    else operationsPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
});
document.getElementById('operations-close')?.addEventListener('click', async () => {
  operationsPanel.hidden = true;
  operationsToggle.classList.remove('is-open');
  operationsToggle.setAttribute('aria-expanded', 'false');
  rememberOrdersWorkspace('tables');
  await showTableView();
});
document.getElementById('operations-content')?.addEventListener('change', (event) => {
  if (event.target.id === 'operation-route-all-categories') {
    const enabled = event.target.checked;
    if (!enabled)
      operationsConfig.routes = operationsConfig.routes.filter(
        (route) => !(route.category === '*' && !route.itemName)
      );
    document
      .querySelectorAll('.operation-route-category-check, .operation-route-item-check')
      .forEach((input) => {
        input.disabled = enabled;
        if (enabled) input.checked = false;
      });
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
    rememberOrdersWorkspace('operations', operationsTab);
    assignmentPrinterId = '';
    assignmentMode = '';
    renderOperations();
    if (operationsTab === 'setup') void checkPrintBridgeSetup();
    return;
  }
  const runBridgeCheck = event.target.closest('[data-run-bridge-check]');
  if (runBridgeCheck) {
    void checkPrintBridgeSetup();
    return;
  }
  const acknowledgeFailures = event.target.closest('[data-acknowledge-print-failures]');
  if (acknowledgeFailures) {
    let ids = [];
    try {
      ids = JSON.parse(acknowledgeFailures.dataset.acknowledgePrintFailures || '[]');
    } catch (_) {}
    if (
      !ids.length ||
      !confirm(
        'Mark these failed jobs as reviewed only after you have reprinted or otherwise accounted for every affected Bill/KOT.'
      )
    )
      return;
    acknowledgeFailures.disabled = true;
    try {
      const response = await fetch(`${printBridgeOrigin}/v1/print-jobs/acknowledge`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids }),
        }),
        data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Unable to mark the print jobs reviewed.');
      await checkPrintBridgeSetup();
    } catch (error) {
      alert(error.message || 'Unable to mark the print jobs reviewed.');
      acknowledgeFailures.disabled = false;
    }
    return;
  }
  const copyBridgeSetup = event.target.closest('[data-copy-bridge-setup]');
  if (copyBridgeSetup) {
    try {
      await navigator.clipboard.writeText(copyBridgeSetup.dataset.command || '');
      copyBridgeSetup.textContent = 'Copied';
      setTimeout(() => {
        if (copyBridgeSetup.isConnected)
          copyBridgeSetup.textContent = `Copy ${detectedDesktopPlatform() === 'macOS' ? 'Terminal' : 'PowerShell'} command`;
      }, 1600);
    } catch (_) {
      alert(
        `Run this command in Terminal / PowerShell:\n\n${copyBridgeSetup.dataset.command || ''}`
      );
    }
    return;
  }
  const kdsAction = event.target.closest('[data-kds-status-action]');
  if (kdsAction) {
    const nextStatus = kdsAction.dataset.kdsStatusAction;
    const orderId = kdsAction.dataset.kdsOrder;
    const printerId = kdsAction.dataset.kdsPrinter,
      kotNumber = Number(kdsAction.dataset.kdsKot);
    if (
      !orderId ||
      !printerId ||
      !Number.isInteger(kotNumber) ||
      !['preparing', 'ready'].includes(nextStatus)
    )
      return;
    kdsAction.disabled = true;
    kdsAction.textContent = nextStatus === 'preparing' ? 'Starting…' : 'Marking ready…';
    try {
      if (
        await queueWhenOffline(
          'kitchen-status',
          { orderId, printerId, kotNumber, status: nextStatus },
          () => {
            kitchenStationStatuses.set(`${orderId}::${kotNumber}::${printerId}`, nextStatus);
            renderKitchenDisplay();
          }
        )
      ) {
        return;
      }
      const response = await fetch(
        `/api/orders/${encodeURIComponent(orderId)}/kitchen-status/${encodeURIComponent(printerId)}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ kotNumber, status: nextStatus }),
        }
      );
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || 'Unable to update kitchen ticket.');
      await loadOperations();
    } catch (error) {
      kdsAction.disabled = false;
      alert(error.message);
    }
    return;
  }
  if (event.target.closest('[data-kds-fullscreen]')) {
    const display = event.target.closest('.kds');
    try {
      if (!document.fullscreenElement) await display?.requestFullscreen?.();
      else await document.exitFullscreen?.();
    } catch (_) {
      alert('Full screen is not available in this browser.');
    }
    return;
  }
  const stationToggle = event.target.closest('[data-kds-station]');
  if (stationToggle) {
    const stationId = stationToggle.dataset.kdsStation || '';
    const selected = selectedKdsStations();
    if (stationId === 'all') selected.clear();
    else if (selected.has(stationId)) selected.delete(stationId);
    else selected.add(stationId);
    saveKdsStations(selected);
    renderKitchenDisplay();
    return;
  }
  if (event.target.closest('[data-add-table-area]')) {
    const allocationForm = document.querySelector('[data-table-allocation-form]');
    const editingAreaId = allocationForm?.dataset.editingArea || '';
    const name = String(document.getElementById('table-area-name')?.value || '').trim();
    const fromInput = document.getElementById('table-area-from');
    const toInput = document.getElementById('table-area-to');
    const from = fromInput?.valueAsNumber;
    const to = toInput?.valueAsNumber;
    if (!name) {
      alert('Enter an area name.');
      document.getElementById('table-area-name')?.focus();
      return;
    }
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 1 || to < from) {
      alert(
        'Enter whole table numbers. “To table” must be the same as or higher than “From table”.'
      );
      fromInput?.focus();
      return;
    }
    operationsConfig.tableAreas = editingAreaId
      ? (operationsConfig.tableAreas || []).map((area) =>
          area.id === editingAreaId ? { ...area, name, from, to } : area
        )
      : [...(operationsConfig.tableAreas || []), { id: operationId(), name, from, to }];
    cacheTableAreas(operationsConfig.tableAreas);
    try {
      await saveTableAllocation(null);
      renderTableAllocation();
    } catch (error) {
      alert(
        error.message ||
          'Unable to save the table area to the server. It remains saved on this device.'
      );
      renderTableAllocation();
    }
    return;
  }
  const editTableArea = event.target.closest('[data-edit-table-area]');
  if (editTableArea) {
    const area = (operationsConfig.tableAreas || []).find(
      (item) => item.id === editTableArea.dataset.editTableArea
    );
    if (!area) return;
    const form = document.querySelector('[data-table-allocation-form]');
    if (!form) return;
    form.dataset.editingArea = area.id;
    document.getElementById('table-area-name').value = area.name;
    document.getElementById('table-area-from').value = area.from;
    document.getElementById('table-area-to').value = area.to;
    const button = form.querySelector('[data-add-table-area]');
    if (button) button.textContent = 'Update area';
    document.getElementById('table-area-name')?.focus();
    form.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }
  const removeTableArea = event.target.closest('[data-remove-table-area]');
  if (removeTableArea) {
    operationsConfig.tableAreas = (operationsConfig.tableAreas || []).filter(
      (area) => area.id !== removeTableArea.dataset.removeTableArea
    );
    renderTableAllocation();
    return;
  }
  if (event.target.closest('[data-save-table-allocation]')) {
    const button = event.target.closest('[data-save-table-allocation]');
    try {
      await saveTableAllocation(button);
    } catch (error) {
      alert(error.message);
    }
    return;
  }
  const expandCategory = event.target.closest('[data-route-category-expand]');
  if (expandCategory) {
    event.preventDefault();
    const preview = expandCategory.closest('.category-choice')?.nextElementSibling;
    if (preview?.classList.contains('category-item-preview')) {
      preview.hidden = !preview.hidden;
      expandCategory.classList.toggle('is-open', !preview.hidden);
    }
    return;
  }
  const copyBridgeCommand = event.target.closest('#copy-print-bridge-command');
  if (copyBridgeCommand) {
    try {
      await navigator.clipboard.writeText(copyBridgeCommand.dataset.command || '');
      copyBridgeCommand.textContent = 'Copied';
      setTimeout(() => {
        copyBridgeCommand.textContent = 'Copy setup command';
      }, 1600);
    } catch (_) {
      alert(
        `Run this command in Terminal / PowerShell:\n\n${copyBridgeCommand.dataset.command || ''}`
      );
    }
    return;
  }
  const restartBridge = event.target.closest('#restart-print-bridge');
  if (restartBridge) {
    if (
      !confirm(
        'Restart Print Bridge on this computer? Printing will be unavailable for a few seconds.'
      )
    )
      return;
    restartBridge.disabled = true;
    restartBridge.textContent = 'Restarting…';
    try {
      const response = await fetch(`${printBridgeOrigin}/v1/restart`, { method: 'POST' });
      if (!response.ok) throw new Error('Print Bridge could not restart.');
      await new Promise((resolve) => setTimeout(resolve, 1800));
      await discoverSystemPrinters();
      renderOperations();
      alert(
        printBridgeState === 'available'
          ? 'Print Bridge restarted successfully.'
          : 'Restart requested, but Print Bridge has not come back online yet.'
      );
    } catch (error) {
      alert(error.message || 'Unable to restart Print Bridge.');
    }
    return;
  }
  const quickAdd = event.target.closest('#quick-add-printer');
  if (quickAdd) {
    const select = document.getElementById('quick-system-printer');
    const deviceId = String(select?.value || '');
    const deviceName = String(select?.selectedOptions?.[0]?.textContent || '');
    const name =
      String(document.getElementById('quick-printer-name')?.value || '')
        .trim()
        .slice(0, 60) || deviceName;
    if (!deviceId) {
      alert('Choose an installed system printer first.');
      return;
    }
    if (operationsConfig.printers.some((printer) => printer.deviceId === deviceId)) {
      alert('This system printer has already been added.');
      return;
    }
    operationsConfig.printers.push({
      id: operationId(),
      name,
      capabilities: [],
      type: 'kot',
      connection: 'system',
      deviceId,
      deviceName,
    });
    renderOperations();
    return;
  }
  const renamePrinter = event.target.closest('[data-rename-printer]');
  if (renamePrinter) {
    assignmentPrinterId = renamePrinter.dataset.renamePrinter || '';
    const printer = operationsConfig.printers.find((item) => item.id === assignmentPrinterId);
    assignmentMode = printerSupports(printer, 'bill')
      ? 'edit-bill'
      : printerSupports(printer, 'kot')
        ? 'edit-kot'
        : 'choose';
    renderOperations();
    return;
  }
  if (event.target.closest('[data-save-printer-edit]')) {
    const printer = operationsConfig.printers.find((item) => item.id === assignmentPrinterId);
    if (!printer) return;
    const capability = assignmentMode === 'edit-bill' ? 'bill' : 'kot';
    const format = printerFormat(printer, capability);
    const name = String(document.getElementById('printer-edit-name')?.value || '')
      .trim()
      .slice(0, 60);
    if (!name) {
      alert('Enter a printer name.');
      return;
    }
    const device = document.getElementById('printer-edit-device');
    const numberSetting = (key, min, max, fallback) => {
      const parsed = Number(document.getElementById(`printer-edit-${key}`)?.value);
      return Math.max(min, Math.min(max, Number.isFinite(parsed) ? parsed : fallback));
    };
    printer.name = name;
    printer.deviceId = String(device?.value || printer.deviceId || '');
    printer.deviceName = String(
      device?.selectedOptions?.[0]?.textContent || printer.deviceName || ''
    ).trim();
    format.paperWidth =
      Number(document.getElementById('printer-edit-paper')?.value) == 58 ? 58 : 80;
    format.receiptHeader = String(document.getElementById('printer-edit-header')?.value || '')
      .trim()
      .slice(0, 160);
    format.receiptFooter = String(document.getElementById('printer-edit-footer')?.value || '')
      .trim()
      .slice(0, 160);
    const restaurantNameControl = document.getElementById('printer-edit-restaurant-name');
    if (restaurantNameControl)
      format.restaurantName = String(
        restaurantNameControl.value || 'Red Lantern Restaurant'
      )
        .trim()
        .slice(0, 60);
    format.showRestaurantName = !!document.getElementById('printer-edit-show-name')?.checked;
    format.showItemSerial = !!document.getElementById('printer-edit-show-serial')?.checked;
    const customerControl = document.getElementById('printer-edit-customer');
    if (customerControl) format.showCustomer = !!customerControl.checked;
    const centeredControl = document.getElementById('printer-edit-kot-details-centered');
    if (centeredControl) format.kotDetailsCentered = !!centeredControl.checked;
    // Kitchen tickets have one standard order: quantity always leads the item.
    format.quantityFirst = true;
    const notesControl = document.getElementById('printer-edit-notes');
    format.showNotes = notesControl ? !!notesControl.checked : format.showNotes !== false;
    format.extraSpace = Math.max(
      0,
      Math.min(2, Number(document.getElementById('printer-edit-space')?.value) || 0)
    );
    const fields = {
      billingMainWidth: [160, 400, 250],
      billingOuterTop: [0, 40, 0],
      billingOuterRight: [0, 40, 0],
      billingOuterBottom: [0, 40, 0],
      billingOuterLeft: [0, 40, 14],
      billingItemBoxHeight: [0, 40, 0],
      restaurantNameFontSize: [8, 24, 15],
      headerFooterFontSize: [8, 20, 10],
      dateBillFontSize: [8, 20, 10],
      itemListingFontSize: [8, 10, 10],
      grandTotalFontSize: [10, 11, 11],
      serialColumnWidth: [0, 40, 10],
      itemNameMinWidth: [50, 220, 110],
      quantityColumnWidth: [8, 60, 28],
      priceColumnWidth: [15, 100, 46],
      amountColumnWidth: [15, 120, 60],
      itemRowGap: [0, 20, 5],
      separatorGap: [0, 20, 5],
      separatorThickness: [1, 4, 1],
      kotHeaderFontSize: [8, 24, 12],
      kotTitleFontSize: [10, 26, 15],
      kotMetaFontSize: [8, 20, 10],
      kotItemFontSize: [8, 22, 12],
      kotFooterFontSize: [8, 20, 10],
      kotBottomFeedLines: [0, 12, 3],
    };
    Object.entries(fields).forEach(([key, [min, max, fallback]]) => {
      const input = document.getElementById(`printer-edit-${key}`);
      if (input) format[key] = numberSetting(key, min, max, fallback);
    });
    format.fontFamily = String(
      document.getElementById('printer-edit-font-family')?.value || 'Arial'
    );
    format.headerBold = !!document.getElementById('printer-edit-header-bold')?.checked;
    format.footerBold = !!document.getElementById('printer-edit-footer-bold')?.checked;
    const formatKeys = [
      'paperWidth',
      'restaurantName',
      'receiptHeader',
      'receiptFooter',
      'showRestaurantName',
      'showItemSerial',
      'showCustomer',
      'kotDetailsCentered',
      'quantityFirst',
      'showNotes',
      'extraSpace',
      'fontFamily',
      'fontSize',
      'headerFontSize',
      'headerBold',
      'footerBold',
      'billingMainWidth',
      'billingOuterTop',
      'billingOuterRight',
      'billingOuterBottom',
      'billingOuterLeft',
      'billingItemBoxHeight',
      'restaurantNameFontSize',
      'headerFooterFontSize',
      'dateBillFontSize',
      'itemListingFontSize',
      'grandTotalFontSize',
      'serialColumnWidth',
      'itemNameMinWidth',
      'quantityColumnWidth',
      'priceColumnWidth',
      'amountColumnWidth',
      'itemRowGap',
      'separatorGap',
      'separatorThickness',
      'kotHeaderFontSize',
      'kotTitleFontSize',
      'kotMetaFontSize',
      'kotItemFontSize',
      'kotFooterFontSize',
      'kotBottomFeedLines',
      'itemsPerPage',
    ];
    setPrinterFormat(
      printer,
      capability,
      Object.fromEntries(formatKeys.filter((key) => format[key] !== undefined).map((key) => [key, format[key]]))
    );
    try {
      await saveOperations();
      assignmentPrinterId = '';
      assignmentMode = '';
      renderOperations();
    } catch (error) {
      alert(error.message);
    }
    return;
  }
  const assignPrinter = event.target.closest('[data-assign-printer]');
  if (assignPrinter) {
    assignmentPrinterId = assignPrinter.dataset.assignPrinter || '';
    assignmentMode = 'choose';
    renderOperations();
    return;
  }
  const editPrinterCapability = event.target.closest('[data-edit-printer-capability]');
  if (editPrinterCapability) {
    assignmentMode =
      editPrinterCapability.dataset.editPrinterCapability === 'bill' ? 'edit-bill' : 'edit-kot';
    renderOperations();
    return;
  }
  if (event.target.closest('[data-assignment-back]')) {
    assignmentPrinterId = '';
    assignmentMode = '';
    renderOperations();
    return;
  }
  if (event.target.closest('[data-assign-bill]')) {
    const printer = operationsConfig.printers.find((item) => item.id === assignmentPrinterId);
    if (printer) {
      setPrinterCapability(printer, 'bill', !printerSupports(printer, 'bill'));
      try {
        await saveOperations();
        assignmentPrinterId = '';
        assignmentMode = '';
        renderOperations();
      } catch (error) {
        alert(error.message);
      }
    }
    return;
  }
  if (event.target.closest('[data-assign-kot]')) {
    assignmentMode = 'kot';
    renderOperations();
    return;
  }
  if (event.target.closest('[data-disable-kot]')) {
    const printer = operationsConfig.printers.find((item) => item.id === assignmentPrinterId);
    if (!printer) return;
    setPrinterCapability(printer, 'kot', false);
    operationsConfig.routes = operationsConfig.routes.filter(
      (route) => route.printerId !== printer.id
    );
    try {
      await saveOperations();
      assignmentPrinterId = '';
      assignmentMode = '';
      renderOperations();
    } catch (error) {
      alert(error.message);
    }
    return;
  }
  if (event.target.closest('[data-save-kot-assignment]')) {
    const printer = operationsConfig.printers.find((item) => item.id === assignmentPrinterId);
    const allCategories = !!document.querySelector('[data-assignment-all-categories]')?.checked;
    const categories = [...document.querySelectorAll('[data-assignment-category]:checked')].map(
      (input) => input.value
    );
    const items = [...document.querySelectorAll('[data-assignment-item]:checked')]
      .map((input) => ({
        category: input.dataset.category || '',
        itemName: input.value || '',
        portion: input.dataset.portion || '',
      }))
      .filter((item) => item.category && item.itemName);
    if (!allCategories && !categories.length && !items.length) {
      alert('Select all categories, a category, or at least one dish.');
      return;
    }
    if (printer) {
      setPrinterCapability(printer, 'kot', true);
      operationsConfig.routes = operationsConfig.routes.filter(
        (route) => route.printerId !== printer.id
      );
      if (allCategories)
        operationsConfig.routes.push({
          id: operationId(),
          printerId: printer.id,
          category: '*',
          itemName: '',
        });
      categories.forEach((category) =>
        operationsConfig.routes.push({
          id: operationId(),
          printerId: printer.id,
          category,
          itemName: '',
        })
      );
      items.forEach((item) =>
        operationsConfig.routes.push({
          id: operationId(),
          printerId: printer.id,
          category: item.category,
          itemName: item.itemName,
          portion: item.portion,
        })
      );
      try {
        await saveOperations();
        assignmentPrinterId = '';
        assignmentMode = '';
        renderOperations();
      } catch (error) {
        alert(error.message);
      }
    }
    return;
  }
  const addPrinter = event.target.closest('#operation-add-printer');
  if (addPrinter) {
    const name = String(document.getElementById('operation-printer-name')?.value || '').trim();
    const type =
      document.getElementById('operation-printer-type')?.value === 'bill' ? 'bill' : 'kot';
    const deviceSelect = document.getElementById('operation-printer-device');
    const deviceId = String(deviceSelect?.value || '').trim();
    const deviceName = deviceId
      ? String(deviceSelect?.selectedOptions?.[0]?.textContent || '').trim()
      : '';
    if (!name) {
      document.getElementById('operation-printer-name')?.focus();
      return;
    }
    if (!deviceId && printBridgeState === 'available') {
      alert('Choose an installed system printer first.');
      return;
    }
    operationsConfig.printers.push({
      id: operationId(),
      name,
      capabilities: [type],
      type,
      connection: 'system',
      deviceId,
      deviceName,
    });
    renderOperations();
    return;
  }
  const removePrinter = event.target.closest('[data-delete-printer]');
  if (removePrinter) {
    const id = removePrinter.dataset.deletePrinter;
    const printer = operationsConfig.printers.find((item) => item.id === id);
    const routeCount = operationsConfig.routes.filter((route) => route.printerId === id).length;
    const confirmation = prompt(
      `Remove ${printer?.name || 'this printer'}?\n\nThis will also remove ${routeCount} routing rule${routeCount === 1 ? '' : 's'}.\n\nType 1111 or YES to confirm.`
    );
    if (!/^(1111|yes)$/i.test(String(confirmation || '').trim())) return;
    operationsConfig.printers = operationsConfig.printers.filter((printer) => printer.id !== id);
    operationsConfig.routes = operationsConfig.routes.filter((route) => route.printerId !== id);
    renderOperations();
    return;
  }
  const addRoute = event.target.closest('#operation-add-route');
  if (addRoute) {
    try {
      if (!addSelectedRoutes()) {
        alert('Choose a KOT printer and at least one category first.');
        return;
      }
      renderOperations();
    } catch (error) {
      alert(error.message);
    }
    return;
  }
  const removeRoute = event.target.closest('[data-delete-route]');
  if (removeRoute) {
    operationsConfig.routes = operationsConfig.routes.filter(
      (route) => route.id !== removeRoute.dataset.deleteRoute
    );
    renderOperations();
    return;
  }
  if (event.target.closest('#operations-save')) {
    const button = event.target.closest('#operations-save');
    try {
      addSelectedRoutes();
    } catch (error) {
      alert(error.message);
      return;
    }
    button.disabled = true;
    button.textContent = 'Saving…';
    try {
      await saveOperations();
    } catch (error) {
      alert(error.message);
      button.disabled = false;
      button.textContent = 'Save printer configuration';
    }
    return;
  }
  const kot = event.target.closest('[data-print-kot]');
  if (kot) {
    try {
      await dispatchKot(kot.dataset.printKot, kot.dataset.printerId);
      await loadOperations();
    } catch (error) {
      reportOrdersDiagnostic({
        message: `KOT printing failed: ${error.message}`,
        source: 'KOT print bridge',
      });
      alert(error.message);
    }
  }
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
window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  installPrompt = event;
});
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
    steps.innerHTML =
      '<li>Tap the Share button in Safari.</li><li>Choose <strong>Add to Home Screen</strong>.</li><li>Name it “RL Orders”, then tap Add.</li>';
  } else {
    message.textContent = 'Create a desktop shortcut for Direct Orders.';
    steps.innerHTML =
      '<li>Open the browser menu (⋮).</li><li>Choose <strong>Install app</strong> or <strong>Create shortcut</strong>.</li><li>Pin “RL Orders” to the taskbar or desktop.</li>';
  }
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else alert(`${message.textContent}\n\n${steps.textContent}`);
});
document
  .getElementById('shortcut-close')
  ?.addEventListener('click', () => document.getElementById('shortcut-dialog')?.close());
orderSearch?.addEventListener('input', () => {
  clearTimeout(orderSearchTimer);
  orderSearchTimer = setTimeout(loadOrders, 180);
});
document.getElementById('clear-order-search')?.addEventListener('click', () => {
  if (orderSearch) {
    orderSearch.value = '';
    orderSearch.focus();
  }
  loadOrders();
});
historyDate?.addEventListener('change', () => {
  historyAll = false;
  loadOrders();
});
document.getElementById('all-history')?.addEventListener('click', () => {
  historyAll = true;
  if (historyDate) historyDate.value = '';
  loadOrders();
});
document.getElementById('order-view-tabs')?.addEventListener('click', (event) => {
  const button = event.target.closest('[data-order-view]');
  if (!button) return;
  orderView = button.dataset.orderView;
  document
    .querySelectorAll('[data-order-view]')
    .forEach((tab) => tab.classList.toggle('is-active', tab === button));
  const dateWrap = document.getElementById('history-date-wrap');
  if (dateWrap) dateWrap.hidden = orderView !== 'history';
  if (orderView === 'history' && historyDate && !historyDate.value && !historyAll) {
    historyDate.value = new Date().toISOString().slice(0, 10);
  }
  loadOrders();
});
root.addEventListener('click', (event) => {
  const button = event.target.closest('[data-modify-order]');
  if (button) openModifyOrder(button.dataset.modifyOrder);
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
    await updateAvailability(
      key,
      action === 'restore'
        ? null
        : action === 'tomorrow'
          ? new Date(Date.now() + 86400000).toISOString()
          : new Date(dateInput.value).toISOString()
    );
  } catch (error) {
    reportOrdersDiagnostic({
      message: `Menu availability update failed: ${error.message}`,
      source: 'menu availability',
    });
    alert(error.message);
    button.disabled = false;
  }
});

const cachedTableAreas = readCachedTableAreas();
const cachedTableOrders = readCachedTableOrders();
const cachedOperationsConfig = readCachedOperationsConfig();
if (cachedOperationsConfig) operationsConfig = cachedOperationsConfig;
if (cachedTableAreas.length) operationsConfig.tableAreas = cachedTableAreas;
if (cachedTableOrders.length)
  orderRecords = new Map(cachedTableOrders.map((order) => [order.id, order]));
if (cachedTableAreas.length) {
  tableViewPanel.hidden = false;
  renderTableView();
}
async function restoreLastOrdersWorkspace() {
  const saved = savedOrdersWorkspace();
  if (!saved || saved.area === 'tables') return;
  if (saved.area === 'counter') {
    await openCounterOrder();
    return;
  }
  if (saved.area === 'live') {
    closeOpenPanels('live');
    liveOrdersPanel.hidden = false;
    liveOrdersToggle.classList.add('is-open');
    liveOrdersToggle.setAttribute('aria-expanded', 'true');
    setOrdersRailActive('live');
    return;
  }
  if (saved.area === 'availability') {
    closeOpenPanels('availability');
    availability.hidden = false;
    availabilityButton?.setAttribute('aria-expanded', 'true');
    setOrdersRailActive('availability');
    try {
      await loadAvailability();
    } catch (_) {}
    return;
  }
  if (saved.area !== 'operations') return;
  const allowedTabs = new Set(['home', 'setup', 'tables', 'kots', 'kitchen-display', 'printers']);
  operationsTab = allowedTabs.has(saved.tab) ? saved.tab : 'home';
  closeOpenPanels('operations');
  operationsPanel.hidden = false;
  operationsToggle.classList.add('is-open');
  operationsToggle.setAttribute('aria-expanded', 'true');
  setOrdersRailActive('operations');
  renderOperations();
  try {
    await loadOrders();
    await loadOperations();
  } catch (_) {}
  if (!operationsPanel.hidden) renderOperations();
  if (operationsTab === 'setup') void checkPrintBridgeSetup();
  void discoverSystemPrinters();
}
// Detect the local workstation service on every app launch. This keeps the
// Operations readiness state current without requiring staff to press Check again.
void checkPrintBridgeSetup();
loadOrders();
showTableView();
void restoreLastOrdersWorkspace();
void pollPrintUpdates();
connectFastPrintUpdates();
if ('serviceWorker' in navigator)
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data?.type === 'order-update') requestFastOrdersRefresh();
  });
setInterval(loadOrders, 3000);
// Same-instance SSE is effectively immediate. This small persisted-event poll
// covers serverless instance changes and reconnects without reloading all orders.
setInterval(pollPrintUpdates, 1000);
// Cloud reconciliation is deliberately slower than the live table refresh:
// it retries durable local work promptly without flooding the API or printers.
setInterval(() => {
  if (navigator.onLine)
    flushQueuedCounterOrders().catch((error) =>
      reportOrdersDiagnostic({
        level: 'warning',
        message: `Offline ledger sync retry failed: ${error.message}`,
        source: 'offline ledger retry',
      })
    );
}, 15000);
// A bridge outage must delay printing, never silently discard the automatic KOT/bill.
setInterval(() => {
  void flushDeferredAutomaticPrints();
}, 10000);
setInterval(() => {
  if (!operationsPanel.hidden && operationsTab === 'kitchen-display')
    loadOperations().catch(() => {});
}, 3000);
setInterval(() => {
  if (!counterPanel.hidden) refreshCounterLiveStatus();
}, 1000);
