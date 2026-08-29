const recentKey = 'red-lantern-captain-recent-items',
  sessionKey = 'red-lantern-captain-session',
  loginSelectionKey = 'red-lantern-captain-login-selection',
  readyKey = 'red-lantern-captain-ready-seen';
// Keep the operational UI at a fixed scale on touch devices; one-finger scrolling remains enabled.
document.addEventListener('gesturestart', (event) => event.preventDefault(), { passive: false });
document.addEventListener('gesturechange', (event) => event.preventDefault(), { passive: false });
document.addEventListener('gestureend', (event) => event.preventDefault(), { passive: false });
document.addEventListener(
  'touchmove',
  (event) => {
    if (event.touches.length > 1) event.preventDefault();
  },
  { passive: false }
);
let lastCaptainTap = 0;
document.addEventListener(
  'touchend',
  (event) => {
    const now = Date.now();
    if (now - lastCaptainTap < 300) {
      event.preventDefault();
    }
    lastCaptainTap = now;
  },
  { passive: false }
);
const $ = (selector) => document.querySelector(selector);
const esc = (value) =>
  String(value ?? '').replace(
    /[&<>'"]/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]
  );
const money = (value) => `₹${Number(value || 0).toFixed(0)}`;
const readJSON = (key, fallback) => {
  try {
    return JSON.parse(sessionStorage.getItem(key) || '');
  } catch {
    return fallback;
  }
};
const state = {
  menu: [],
  areas: [],
  orders: [],
  salesInsights: [],
  area: '',
  tableFilter: 'all',
  table: null,
  lastTable: null,
  cart: [],
  category: 'all',
  choice: null,
  sending: false,
  screen: 'tables',
  recent: readJSON(recentKey, []),
  captain: readJSON(
    sessionKey,
    (() => {
      try {
        return JSON.parse(localStorage.getItem(sessionKey) || '');
      } catch {
        return null;
      }
    })()
  ),
  accounts: [],
  readyAlerts: [],
  readySeen: readJSON(readyKey, {}),
  readyNotified: readJSON('red-lantern-captain-ready-notified', {}),
  pending: [],
  pendingUpdatedAt: 0,
  syncingPending: false,
  pendingError: '',
  kotRetry: null,
};
const requestId = () =>
  `captain-${Date.now()}-${crypto.getRandomValues(new Uint32Array(1))[0].toString(36)}`;
async function fetchWithTimeout(input, init = {}, timeout = 7000) {
  const controller = new AbortController(),
    timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (error) {
    if (error.name === 'AbortError') {
      const timedOut = new Error('The network did not respond in time.');
      timedOut.transient = true;
      throw timedOut;
    }
    if (error instanceof TypeError) error.transient = true;
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
const captainIdleMs = () =>
  Math.max(2, Math.min(120, Number(state.captain?.idleMinutes) || 15)) * 60 * 1000;
let captainIdleTimer = null;
let captainToastTimer = null;
function showCaptainToast(message, type = 'success') {
  const toast = $('#captain-toast');
  if (!toast) return;
  clearTimeout(captainToastTimer);
  toast.textContent = message;
  toast.className = `captain-toast is-${type}`;
  toast.hidden = false;
  captainToastTimer = setTimeout(() => {
    toast.hidden = true;
  }, 4200);
}
const itemKey = (line) =>
  `${line.menuType || 'food'}::${line.name}::${line.category}::${line.portion}::${line.style}::${line.note || ''}::${line.courseOverride || ''}`;
const courseOptions = (defaultCourse = '', selected = '') =>
  `<option value="">Default${defaultCourse ? ` (${esc(defaultCourse)})` : ''}</option>${['drink', 'soup', 'starter', 'main', 'side', 'dessert', 'other'].map((course) => `<option value="${course}" ${selected === course ? 'selected' : ''}>${course[0].toUpperCase() + course.slice(1)}</option>`).join('')}`;
const captainHeaders = () =>
  state.captain?.token ? { 'X-Captain-Session': state.captain.token } : {};
function captainPrintLocation() {
  if (!navigator.geolocation)
    return Promise.reject(new Error('Location is required to print a bill from Captain.'));
  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      (position) =>
        resolve({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracy: position.coords.accuracy,
        }),
      (error) => {
        const message =
          error.code === error.PERMISSION_DENIED
            ? 'Allow location for Captain to print bills inside the restaurant.'
            : 'Current location is required to print a bill from Captain.';
        reject(new Error(message));
      },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 }
    );
  });
}
const captainDay = () =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
const draftKey = () =>
  state.captain && state.table
    ? `red-lantern-captain-draft:${captainDay()}:${state.captain.id}:${state.table.area}:${state.table.number}`
    : '';
const pendingKey = () => (state.captain ? `red-lantern-captain-pending:${state.captain.id}` : '');
const snapshotKey = () => (state.captain ? `red-lantern-captain-snapshot:${state.captain.id}` : '');
const readLocalJSON = (key, fallback) => {
  try {
    return JSON.parse(localStorage.getItem(key) || '');
  } catch {
    return fallback;
  }
};
const captainDbName = 'red-lantern-captain-offline-v1',
  captainDbStore = 'pending-orders';
function openCaptainDb() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) return reject(new Error('IndexedDB is unavailable.'));
    const request = indexedDB.open(captainDbName, 1);
    request.onupgradeneeded = () =>
      request.result.createObjectStore(captainDbStore, { keyPath: 'key' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Unable to open offline storage.'));
  });
}
async function writePendingJournal(record) {
  try {
    const db = await openCaptainDb();
    await new Promise((resolve, reject) => {
      const request = db
        .transaction(captainDbStore, 'readwrite')
        .objectStore(captainDbStore)
        .put(record);
      request.onsuccess = resolve;
      request.onerror = () => reject(request.error);
    });
    db.close();
  } catch {}
}
async function readPendingJournal() {
  const key = pendingKey();
  if (!key) return;
  try {
    const db = await openCaptainDb(),
      record = await new Promise((resolve, reject) => {
        const request = db
          .transaction(captainDbStore, 'readonly')
          .objectStore(captainDbStore)
          .get(key);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    db.close();
    if (key !== pendingKey()) return;
    if (
      record &&
      Number(record.updatedAt) > state.pendingUpdatedAt &&
      Array.isArray(record.entries)
    ) {
      state.pending = normalisePending(record.entries);
      state.pendingUpdatedAt = Number(record.updatedAt);
      renderPendingSync();
    }
  } catch {}
}
function saveOfflineSnapshot() {
  const key = snapshotKey();
  if (!key || !state.menu.length || !state.areas.length) return;
  try {
    localStorage.setItem(
      key,
      JSON.stringify({
        savedAt: Date.now(),
        areas: state.areas,
        menu: state.menu,
        orders: state.orders,
        salesOrders: state.salesOrders,
      })
    );
  } catch {}
}
function restoreOfflineSnapshot() {
  const snapshot = readLocalJSON(snapshotKey(), null);
  if (!snapshot || !Array.isArray(snapshot.menu) || !Array.isArray(snapshot.areas)) return false;
  state.areas = snapshot.areas;
  state.menu = snapshot.menu;
  state.orders = Array.isArray(snapshot.orders) ? snapshot.orders : [];
  state.salesOrders = Array.isArray(snapshot.salesOrders) ? snapshot.salesOrders : [];
  const when = new Date(Number(snapshot.savedAt) || Date.now()).toLocaleTimeString('en-IN', {
    hour: '2-digit',
    minute: '2-digit',
  });
  $('#captain-connection').textContent =
    `Offline · using saved menu and table snapshot from ${when}.`;
  renderTables();
  renderMenu();
  renderCaptainNav();
  return true;
}
function draftFields() {
  return {
    customerName: $('#customer-name')?.value || '',
    customerPhone: $('#customer-phone')?.value || '',
    courseMode: $('#course-mode')?.value || 'normal_coursing',
    specialRequest: $('#special-request')?.value || '',
  };
}
function saveDraft() {
  const key = draftKey();
  if (!key) return;
  const fields = draftFields();
  try {
    if (
      !state.cart.length &&
      !fields.customerName &&
      !fields.customerPhone &&
      !fields.specialRequest
    ) {
      localStorage.removeItem(key);
      return;
    }
    localStorage.setItem(key, JSON.stringify({ savedAt: Date.now(), cart: state.cart, fields }));
  } catch {}
}
function clearDraft() {
  const key = draftKey();
  if (key)
    try {
      localStorage.removeItem(key);
    } catch {}
}
function restoreDraft() {
  const key = draftKey(),
    notice = $('#captain-draft-status');
  notice.hidden = true;
  if (!key) return;
  const draft = readLocalJSON(key, null);
  if (!draft || Date.now() - Number(draft.savedAt || 0) > 24 * 60 * 60 * 1000) {
    try {
      localStorage.removeItem(key);
    } catch {}
    return;
  }
  const cart = Array.isArray(draft.cart)
    ? draft.cart
        .filter((line) => line && line.name && Number(line.quantity) > 0 && Number(line.price) > 0)
        .map((line) => ({
          ...line,
          quantity: Math.min(20, Number(line.quantity)),
          key: itemKey(line),
        }))
    : [];
  if (
    !cart.length &&
    !draft.fields?.customerName &&
    !draft.fields?.customerPhone &&
    !draft.fields?.specialRequest
  )
    return;
  state.cart = cart;
  $('#customer-name').value = draft.fields?.customerName || '';
  $('#customer-phone').value = draft.fields?.customerPhone || '';
  $('#course-mode').value = draft.fields?.courseMode || 'normal_coursing';
  $('#special-request').value = draft.fields?.specialRequest || '';
  notice.hidden = false;
  notice.textContent = `Restored unsent draft from ${new Date(draft.savedAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}.`;
}
function pendingItemCount(entry) {
  return (Array.isArray(entry?.payload?.items) ? entry.payload.items : []).reduce(
    (sum, item) => sum + Number(item.quantity || 0),
    0
  );
}
function normalisePending(entries) {
  return (Array.isArray(entries) ? entries : [])
    .filter((entry) => entry?.payload?.clientRequestId)
    .map((entry) => {
      const kind = entry.kind === 'kot-retry' ? 'kot-retry' : 'order';
      const status =
        kind === 'kot-retry' ? 'kot-retry' : entry.status === 'review' ? 'review' : 'queued';
      return { ...entry, kind, status };
    });
}
function savePending() {
  const key = pendingKey();
  if (!key) return;
  state.pendingUpdatedAt = Date.now();
  const record = { key, updatedAt: state.pendingUpdatedAt, entries: state.pending };
  try {
    if (state.pending.length) localStorage.setItem(key, JSON.stringify(record));
    else localStorage.removeItem(key);
  } catch {}
  void writePendingJournal(record);
}
function loadPending() {
  const key = pendingKey(),
    stored = key ? readLocalJSON(key, []) : [];
  state.pending = normalisePending(
    Array.isArray(stored) ? stored : Array.isArray(stored?.entries) ? stored.entries : []
  );
  state.pendingUpdatedAt = Array.isArray(stored) ? 0 : Number(stored?.updatedAt || 0);
  renderPendingSync();
  void readPendingJournal();
}
function pendingOrderCard(entry, index, inNav = false) {
  const order = entry.payload || {},
    items = Array.isArray(order.items) ? order.items : [],
    itemCount = pendingItemCount(entry),
    when = entry.queuedAt
      ? new Date(entry.queuedAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })
      : 'saved',
    conflict = entry.conflict,
    review = entry.status === 'review',
    kotRetry = entry.kind === 'kot-retry',
    live = conflict?.id
      ? `Live order #${esc(conflict.orderNumber || '')} is already open on this table.`
      : 'The table changed while this device was offline.',
    liveItems = (Array.isArray(conflict?.items) ? conflict.items : [])
      .slice(0, 4)
      .map((item) => `${Number(item.quantity || 0)}× ${esc(item.name)}`)
      .join(' · ');
  return `<article class="${review ? 'is-review' : ''}"><div><b>${kotRetry ? 'KOT waiting · ' : review ? 'Needs review · ' : ''}${esc(order.tableArea || 'Table')} · Table ${esc(String(order.tableNumber || ''))}</b><small>${kotRetry ? `Order #${esc(entry.orderNumber || '')} is saved; the kitchen has not been notified yet.` : review ? live : `${itemCount} item${itemCount === 1 ? '' : 's'} · ${when}`}</small>${review && liveItems ? `<em>Already on table: ${liveItems}</em>` : ''}<span>${items.map((item) => `${Number(item.quantity || 0)}× ${esc(item.name)}`).join(' · ')}</span></div><div>${review && conflict?.id ? `<button type="button" data-accept-pending="${index}">${inNav ? 'Review & merge' : 'Accept as new round'}</button>` : ''}${kotRetry ? `<button type="button" data-retry-pending-kot="${index}">Send KOT</button>` : ''}${!review && !kotRetry ? `<button type="button" data-recover-pending="${index}">Edit</button>` : ''}<button type="button" data-discard-pending="${index}">${review ? 'Reject' : kotRetry ? 'Dismiss' : 'Discard'}</button></div></article>`;
}
function renderPendingSync(message = '') {
  const root = $('#captain-pending-sync'),
    count = state.pending.length,
    reviews = state.pending.filter((entry) => entry.status === 'review').length,
    kotRetries = state.pending.filter((entry) => entry.kind === 'kot-retry').length,
    detail = message || state.pendingError;
  root.hidden = !count && !detail;
  root.innerHTML = count
    ? `<div class="pending-sync-head"><span aria-hidden="true">${reviews ? '!' : kotRetries ? 'K' : '↻'}</span><div><b>${reviews ? `${reviews} order${reviews === 1 ? '' : 's'} need table review` : kotRetries ? `${kotRetries} saved KOT${kotRetries === 1 ? '' : 's'} waiting to send` : `${count} order${count === 1 ? '' : 's'} waiting to sync`}</b><small>${detail || (reviews ? 'Discuss the live table order, then accept it as a new round or reject it.' : kotRetries ? 'The order is already saved. Send the KOT once the kitchen printer is available.' : navigator.onLine ? 'Ready to sync safely.' : 'Saved on this device until internet returns.')}</small></div>${navigator.onLine ? '<button type="button" data-sync-pending>Sync now</button>' : ''}</div><div class="pending-sync-list">${state.pending.map((entry, index) => pendingOrderCard(entry, index)).join('')}</div>`
    : detail
      ? `<span aria-hidden="true">!</span><div><b>Order sync needs attention</b><small>${esc(detail)}</small></div>`
      : '';
  renderCaptainNav();
}
function queuePending(payload) {
  state.pendingError = '';
  state.pending.push({
    id: `pending-${payload.clientRequestId}`,
    kind: 'order',
    payload,
    queuedAt: Date.now(),
    status: 'queued',
  });
  savePending();
  renderPendingSync();
}
function queueKotRetry(payload, savedOrder) {
  const index = state.pending.findIndex(
    (entry) => entry.kind === 'kot-retry' && entry.savedOrderId === savedOrder.id
  );
  const entry = {
    id: `pending-kot-${savedOrder.id}`,
    kind: 'kot-retry',
    payload,
    orderNumber: savedOrder.orderNumber,
    savedOrderId: savedOrder.id,
    queuedAt: Date.now(),
    status: 'kot-retry',
  };
  if (index >= 0) state.pending[index] = entry;
  else state.pending.push(entry);
  savePending();
  renderPendingSync();
}
function recoverPending(index) {
  const entry = state.pending[index],
    payload = entry?.payload;
  if (!payload) return;
  if (!state.areas.some((area) => area.name === payload.tableArea)) {
    state.pendingError = 'This saved order is for an area no longer assigned to this Captain.';
    renderPendingSync();
    return;
  }
  const active = activeTable(payload.tableArea, Number(payload.tableNumber));
  state.table = {
    area: payload.tableArea,
    number: Number(payload.tableNumber),
    orderId: active?.id || '',
  };
  state.cart = (Array.isArray(payload.items) ? payload.items : [])
    .filter((item) => item && item.name && Number(item.quantity) > 0)
    .map((item) => ({
      ...item,
      key: itemKey(item),
      quantity: Math.min(20, Number(item.quantity)),
    }));
  $('#customer-name').value = payload.customerName || '';
  $('#customer-phone').value = payload.customerPhone || '';
  $('#special-request').value = payload.specialRequest || '';
  state.pending.splice(index, 1);
  state.pendingError = '';
  savePending();
  renderPendingSync();
  renderTables();
  renderCart();
  setScreen('menu');
}
function acceptPendingConflict(index) {
  const entry = state.pending[index],
    payload = entry?.payload,
    conflict = entry?.conflict;
  if (!payload || entry.status !== 'review' || !conflict?.id) return;
  const count = pendingItemCount(entry),
    label = `${payload.tableArea || 'Table'} ${payload.tableNumber || ''}`.trim();
  if (
    !confirm(
      `Add these ${count} offline item${count === 1 ? '' : 's'} to the live ${label} order as a new round? Send only after confirming this with the other waiter.`
    )
  )
    return;
  entry.payload = { ...payload, tableOrderId: conflict.id };
  entry.status = 'queued';
  entry.conflict = null;
  entry.acceptedAt = Date.now();
  state.pendingError = '';
  savePending();
  renderPendingSync();
  void flushPending();
}
function discardPending(index) {
  const entry = state.pending[index],
    payload = entry?.payload;
  if (!payload) return;
  const label = `${payload.tableArea || 'Table'} ${payload.tableNumber || ''}`.trim(),
    review = entry.status === 'review';
  if (
    !confirm(
      `${review ? 'Reject and discard' : 'Discard'} the saved order for ${label}? This cannot be undone.`
    )
  )
    return;
  state.pending.splice(index, 1);
  state.pendingError = '';
  savePending();
  renderPendingSync();
}
function clearQueuedKotRetry(orderId) {
  const next = state.pending.filter(
    (entry) => entry.kind !== 'kot-retry' || entry.savedOrderId !== orderId
  );
  if (next.length === state.pending.length) return;
  state.pending = next;
  savePending();
}
async function postCaptainKot(orderId) {
  const response = await fetchWithTimeout(`/api/orders/${encodeURIComponent(orderId)}/kots`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...captainHeaders() },
    }),
    data = await response.json().catch(() => ({}));
  if (response.status === 401) {
    signOut('Captain sign-in has expired. Sign in again.');
    throw new Error('Captain sign-in has expired.');
  }
  if (response.status === 409 && data.latestKot?.kot_number) {
    clearQueuedKotRetry(orderId);
    return { kotNumber: data.latestKot.kot_number, reused: true };
  }
  if (!response.ok)
    throw new Error(
      data.error || 'The order is saved, but its KOT could not be sent. Please retry.'
    );
  clearQueuedKotRetry(orderId);
  return data;
}
async function postCaptainOrder(payload) {
  const response = await fetchWithTimeout('/api/orders/counter', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Counter-Order-Id': payload.clientRequestId,
        ...captainHeaders(),
      },
      body: JSON.stringify(payload),
    }),
    data = await response.json().catch(() => ({}));
  if (response.status === 401) {
    signOut('Your Captain session expired. Sign in again.');
    throw new Error('Captain sign-in has expired.');
  }
  if (!response.ok) {
    const error = new Error(data.error || 'Unable to save the order.');
    error.status = response.status;
    error.code = data.code || '';
    error.conflict = data.conflict || null;
    throw error;
  }
  if (payload.sendKot) {
    try {
      const kotData = await postCaptainKot(data.id);
      return { ...data, kotNumber: kotData.kotNumber, kotReused: !!kotData.reused };
    } catch (error) {
      queueKotRetry(payload, data);
      error.savedOrder = data;
      throw error;
    }
  }
  return data;
}
async function flushPending() {
  if (!state.captain || state.syncingPending || !state.pending.length || !navigator.onLine) return;
  state.syncingPending = true;
  state.pendingError = '';
  renderPendingSync('Syncing saved orders…');
  try {
    while (navigator.onLine) {
      const index = state.pending.findIndex((entry) => entry.status !== 'review');
      if (index < 0) break;
      const pending = state.pending[index];
      try {
        if (pending.kind === 'kot-retry') {
          await postCaptainKot(pending.savedOrderId);
          const settledIndex = state.pending.indexOf(pending);
          if (settledIndex >= 0) state.pending.splice(settledIndex, 1);
          savePending();
          continue;
        }
        await postCaptainOrder(pending.payload);
        state.pending.splice(index, 1);
        savePending();
      } catch (error) {
        if (error.savedOrder) {
          const originalIndex = state.pending.indexOf(pending);
          if (originalIndex >= 0) state.pending.splice(originalIndex, 1);
          savePending();
          continue;
        }
        if (error.code === 'table_changed') {
          state.pending[index] = {
            ...pending,
            status: 'review',
            conflict: error.conflict || null,
            reviewedAt: Date.now(),
          };
          savePending();
          continue;
        }
        state.pendingError = `Could not send ${pending.kind === 'kot-retry' ? 'the saved KOT' : 'a saved order'}: ${error.message}`;
        break;
      }
    }
    if (!state.pending.length) state.pendingError = '';
  } finally {
    state.syncingPending = false;
    renderPendingSync();
  }
}
function renderReadyAlerts() {
  const root = $('#captain-ready-alerts'),
    visible = state.readyAlerts.filter((alert) => !state.readySeen[alert.id]);
  root.hidden = !visible.length;
  root.innerHTML = visible
    .map(
      (alert) =>
        `<article><span aria-hidden="true">✓</span><div><b>Ready to serve · ${esc(alert.table_area)} Table ${String(alert.table_number || '').padStart(2, '0')}</b><small>Order #${esc(String(alert.daily_order_number || '').padStart(2, '0'))} · KOT #${esc(alert.kot_number)} is ready from the kitchen.</small></div><button type="button" data-ready-served="${esc(alert.id)}" data-ready-kot="${esc(alert.kot_number)}">Served</button></article>`
    )
    .join('');
  renderCaptainNav();
  if (state.areas.length) renderTables();
}
async function loadReadyAlerts() {
  if (!state.captain) return;
  try {
    const response = await fetch('/api/captain/ready-alerts', {
        cache: 'no-store',
        headers: captainHeaders(),
      }),
      data = await response.json();
    if (response.status === 401) {
      signOut('Your Captain session expired. Sign in again.');
      return;
    }
    if (!response.ok) throw new Error(data.error);
    state.readyAlerts = Array.isArray(data.alerts) ? data.alerts : [];
    state.readyAlerts
      .filter(
        (alert) =>
          !state.readySeen[alert.id] && !state.readyNotified[`${alert.id}:${alert.kot_number}`]
      )
      .forEach((alert) => {
        const key = `${alert.id}:${alert.kot_number}`;
        state.readyNotified[key] = Date.now();
        try {
          sessionStorage.setItem(
            'red-lantern-captain-ready-notified',
            JSON.stringify(state.readyNotified)
          );
        } catch {}
        if (navigator.vibrate) navigator.vibrate([160, 80, 160]);
        if (Notification.permission === 'granted')
          navigator.serviceWorker?.ready
            .then((registration) =>
              registration.showNotification(`Table ${alert.table_number} ready`, {
                body: `${alert.table_area} · Order #${String(alert.daily_order_number).padStart(2, '0')} · KOT #${alert.kot_number}`,
                icon: '/images/red-lantern-logo-600.webp',
                tag: key,
                renotify: true,
              })
            )
            .catch(() => {});
      });
    renderReadyAlerts();
  } catch {}
}
function priceOptions(item) {
  return [
    ['Half', item.halfPrice],
    ['Full', item.fullPrice],
    ['With bone', item.withBonePrice],
    ['Boneless', item.bonelessPrice],
    ['30 ml', item.price30ml],
    ['60 ml', item.price60ml],
    ['90 ml', item.price90ml],
    ['180 ml', item.price180ml],
    ['Regular', item.price],
  ]
    .map(([portion, value]) => [portion, Number(String(value || '').replace(/[^0-9.]/g, '')) || 0])
    .filter(([, value]) => value > 0);
}
function total() {
  return state.cart.reduce(
    (sum, line) => sum + line.quantity * (line.price + (line.style ? 10 : 0)),
    0
  );
}
function itemCount() {
  return state.cart.reduce((sum, line) => sum + line.quantity, 0);
}
function rememberItem(item) {
  const key = `${item.category || ''}::${item.name || ''}`;
  state.recent = [key, ...state.recent.filter((entry) => entry !== key)].slice(0, 12);
  try {
    sessionStorage.setItem(recentKey, JSON.stringify(state.recent));
  } catch {}
}
function activeTable(area, number) {
  return state.orders.find(
    (order) =>
      order.mode === 'table' &&
      String(order.table_area) === String(area) &&
      Number(order.table_number) === Number(number) &&
      !['completed', 'rejected', 'cancelled'].includes(order.status)
  );
}
function orderAge(order) {
  const minutes = order?.created_at
    ? Math.max(0, Math.floor((Date.now() - new Date(order.created_at).getTime()) / 60000))
    : 0;
  return minutes < 1
    ? 'just sent'
    : minutes < 60
      ? `${minutes} min ago`
      : `${Math.floor(minutes / 60)}h ${minutes % 60}m ago`;
}
async function loadKotProgress(orderId) {
  const root = $('#active-kot-progress');
  root.hidden = true;
  if (!orderId) return;
  try {
    const response = await fetch(
        `/api/captain/orders/${encodeURIComponent(orderId)}/kot-progress`,
        { cache: 'no-store', headers: captainHeaders() }
      ),
      data = await response.json();
    if (!response.ok || !Array.isArray(data.rounds) || !data.rounds.length) return;
    root.innerHTML = `<b>Kitchen progress</b><div>${data.rounds
      .map((round) => {
        const state =
          round.ready > 0
            ? 'ready'
            : round.preparing > 0
              ? 'preparing'
              : round.served === round.stations && round.stations
                ? 'served'
                : 'accepted';
        const label =
          state === 'ready'
            ? 'Ready to serve'
            : state === 'preparing'
              ? 'Preparing'
              : state === 'served'
                ? 'Served'
                : 'Accepted';
        return `<span class="is-${state}"><b>KOT ${round.kotNumber}</b><small>${label} · ${round.stations} station${round.stations === 1 ? '' : 's'}</small></span>`;
      })
      .join('')}</div>`;
    root.hidden = false;
  } catch {}
}
function setScreen(screen) {
  state.screen = screen;
  ['tables', 'menu', 'review'].forEach((name) => ($(`#${name}-screen`).hidden = name !== screen));
  $('#basket-bar').hidden = screen === 'tables' || !state.cart.length;
  if (screen === 'menu') {
    const isTakeaway = state.table?.mode === 'takeaway',
      active =
        !isTakeaway && state.table?.orderId
          ? activeTable(state.table.area, state.table.number)
          : null,
      summary = $('#active-bill-summary'),
      tableLabel = isTakeaway ? 'Takeaway' : `Table ${String(state.table.number).padStart(2, '0')}`,
      areaLabel = isTakeaway ? 'Takeaway order' : `${state.table.area} dining · ${tableLabel}`;
    $('#menu-table-title').textContent = 'Add order';
    $('#menu-order-mode').textContent = isTakeaway ? 'TAKEAWAY' : 'DINE-IN';
    $('#active-table-context').hidden = false;
    $('#active-table-context').textContent = active
      ? `Active bill #${String(active.daily_order_number || '').padStart(2, '0')} · ${active.status}. New items will go as a new KOT.`
      : areaLabel;
    summary.hidden = !active;
    if (active) {
      const lines = Array.isArray(active.items) ? active.items : [];
      $('#active-bill-total').textContent = money(active.total);
      $('#active-bill-items').innerHTML = lines.length
        ? lines
            .map(
              (item) =>
                `<p><b>${Number(item.quantity || 0)}×</b> ${esc(item.name)}${item.portion ? ` · ${esc(item.portion)}` : ''}${item.style ? ` · ${esc(item.style)}` : ''}${item.note ? ` <small>↳ ${esc(item.note)}</small>` : ''}</p>`
            )
            .join('')
        : '<p>No items are recorded yet.</p>';
    }
  }
  if (screen === 'review') {
    $('#review-table-title').textContent =
      state.table?.mode === 'takeaway'
        ? 'Takeaway order'
        : `Table ${String(state.table.number).padStart(2, '0')} · ${state.table.area}`;
    renderCart();
  }
  window.scrollTo({ top: 0, behavior: 'instant' });
}
function renderCaptainNav() {
  const nav = $('#captain-nav');
  if (!state.captain) {
    nav.hidden = true;
    return;
  }
  const active = state.orders.filter(
      (order) =>
        order.mode === 'table' &&
        !['completed', 'rejected', 'cancelled'].includes(order.status) &&
        String(order.captain_id || '') === String(state.captain.id)
    ),
    ready = state.readyAlerts.filter((alert) => !state.readySeen[alert.id]),
    reviews = state.pending
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => entry.status === 'review'),
    online = navigator.onLine;
  $('#captain-nav-name').textContent = state.captain.name;
  $('#captain-nav-avatar').textContent = String(state.captain.name || 'C')
    .trim()
    .slice(0, 1)
    .toUpperCase();
  $('#captain-nav-status').textContent = online
    ? 'Online · live service'
    : 'Offline · orders will sync safely';
  $('#captain-nav-summary').innerHTML =
    `<span class="is-active"><b>${active.length}</b> active tables</span><span class="is-ready"><b>${ready.length}</b> ready now</span><span class="${reviews.length || state.pending.length ? 'is-sync' : ''}"><b>${reviews.length || state.pending.length}</b> ${reviews.length ? 'need review' : 'waiting to sync'}</span>`;
  $('#captain-nav-cart').textContent = itemCount()
    ? `${itemCount()} item${itemCount() === 1 ? '' : 's'} · ${money(total())}`
    : 'No items in cart';
  const conflictRoot = $('#captain-nav-conflicts');
  conflictRoot.hidden = !reviews.length;
  $('#captain-nav-conflict-list').innerHTML = reviews
    .map(({ entry, index }) => pendingOrderCard(entry, index, true))
    .join('');
  $('#captain-nav-ready-list').innerHTML = ready.length
    ? ready
        .map(
          (alert) =>
            `<button type="button" data-captain-ready-table="${esc(alert.table_area)}" data-captain-ready-number="${Number(alert.table_number)}"><span>✓</span><div><b>Table ${String(alert.table_number).padStart(2, '0')} is ready</b><small>${esc(alert.table_area)} · KOT #${esc(alert.kot_number)}</small></div><i>›</i></button>`
        )
        .join('')
    : '<p><span aria-hidden="true">✓</span><b>Nothing ready right now</b><small>Kitchen updates will appear here automatically.</small></p>';
  $('#captain-nav-active-list').innerHTML = active.length
    ? active
        .map(
          (order) =>
            `<button type="button" data-captain-nav-table="${esc(order.table_area)}" data-captain-nav-number="${Number(order.table_number)}"><span>${esc(order.table_area)}</span><b>Table ${String(order.table_number).padStart(2, '0')}</b><small>${esc(String(order.status || 'active'))} · ${orderAge(order)}</small><i>›</i></button>`
        )
        .join('')
    : '<p><span aria-hidden="true">▦</span><b>No active tables</b><small>Your new table orders will appear here.</small></p>';
}
function setCaptainUI() {
  const profile = $('#captain-profile'),
    toggle = $('#captain-nav-toggle'),
    login = $('#captain-login'),
    app = document.querySelector('.captain-app');
  profile.hidden = !state.captain;
  toggle.hidden = !state.captain;
  app.hidden = !state.captain;
  if (state.captain) {
    profile.textContent = `● ${state.captain.name}`;
    profile.title = 'Tap to sign out';
    login.hidden = true;
    setScreen(state.screen || 'tables');
    renderCaptainNav();
  } else {
    $('#captain-nav').hidden = true;
    login.hidden = false;
    state.loginAccount = null;
    $('#captain-pin-form').hidden = true;
    $('#captain-account-list').hidden = false;
    $('#captain-selected-name').textContent = '';
    $('#captain-pin').value = '';
  }
}
function renderLogin() {
  const root = $('#captain-account-list');
  root.innerHTML = state.accounts.length
    ? state.accounts
        .map(
          (captain) =>
            `<button class="captain-account" type="button" data-captain-id="${esc(captain.id)}"><b>${esc(captain.name)}</b><small>${captain.areas?.length ? esc(captain.areas.join(' · ')) : 'All dining areas'}</small><span>Enter PIN ›</span></button>`
        )
        .join('')
    : '<p class="captain-login-status">No active Captain accounts. Ask an administrator to add one in Admin → Captain App.</p>';
}
function selectCaptain(id) {
  const captain = state.accounts.find((entry) => entry.id === id);
  if (!captain) {
    showAccountChooser('That Captain is no longer available. Choose another account.');
    return;
  }
  state.loginAccount = captain;
  try {
    sessionStorage.setItem(loginSelectionKey, captain.id);
  } catch {}
  $('#captain-account-list').hidden = true;
  $('#captain-pin-form').hidden = false;
  $('#captain-selected-name').textContent = `Signing in as ${captain.name}`;
  $('#captain-login-status').textContent = '';
  $('#captain-pin').value = '';
  setTimeout(() => $('#captain-pin').focus(), 0);
}
function showAccountChooser(message = '') {
  state.loginAccount = null;
  try {
    sessionStorage.removeItem(loginSelectionKey);
  } catch {}
  $('#captain-pin-form').hidden = true;
  $('#captain-account-list').hidden = false;
  $('#captain-login-status').textContent = message;
}
async function loadAccounts() {
  const root = $('#captain-account-list');
  if (!navigator.onLine) {
    root.innerHTML =
      '<p class="captain-login-status">Internet is needed to sign in on a new device. Reconnect, then choose your Captain account.</p>';
    return;
  }
  root.setAttribute('aria-busy', 'true');
  try {
    let data = null,
      lastError = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await fetchWithTimeout('/api/captain/accounts', {
            cache: 'no-store',
            headers: { 'Cache-Control': 'no-cache' },
          }),
          body = await response.json();
        if (!response.ok) throw new Error(body.error || 'Unable to load Captain accounts.');
        data = body;
        break;
      } catch (error) {
        lastError = error;
        if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 350));
      }
    }
    if (!data) throw lastError || new Error('Unable to load Captain accounts.');
    state.accounts = Array.isArray(data.captains) ? data.captains : [];
    renderLogin();
    const selectedId = state.loginAccount?.id || '';
    if (selectedId && !state.accounts.some((captain) => captain.id === selectedId))
      showAccountChooser('Your selected Captain account changed. Choose an account again.');
  } catch (error) {
    state.accounts = [];
    root.innerHTML = `<p class="captain-login-status">${esc(error.message || 'Unable to load Captain accounts.')} <button type="button" data-retry-captain-accounts>Try again</button></p>`;
  } finally {
    root.removeAttribute('aria-busy');
  }
}
function renderTableLoadFailure(message) {
  $('#table-quick-stats').hidden = true;
  $('#table-state-filters').innerHTML = '';
  $('#area-tabs').innerHTML = '';
  $('#table-board').innerHTML =
    `<section class="captain-load-failure"><span aria-hidden="true">⌁</span><div><b>Table board needs a connection</b><p>${esc(message)}</p><button type="button" data-retry-captain-load>Try again</button></div></section>`;
}
async function load() {
  if (!state.captain) {
    setCaptainUI();
    return;
  }
  if (!navigator.onLine) {
    if (!restoreOfflineSnapshot()) {
      const message =
        'You are offline and this device has no saved Captain snapshot yet. Connect once to save the menu and table board for later offline use.';
      $('#captain-connection').textContent = message;
      renderTableLoadFailure(message);
    }
    return;
  }
  try {
    $('#captain-connection').textContent = 'Loading live table status…';
    const options = { cache: 'no-store', headers: captainHeaders() },
      criticalUrls = ['/api/orders/operations', '/api/orders/menu', '/api/orders?history=0'],
      fetchCritical = async (url) => {
        let failure;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            const response = await fetchWithTimeout(url, options);
            if (response.status === 401) return response;
            if (response.ok) return response;
            failure = new Error(`Request failed (${response.status}).`);
          } catch (error) {
            failure = error;
          }
          if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 350));
        }
        throw failure || new Error('The server did not respond.');
      },
      [operations, menu, orders] = await Promise.all(criticalUrls.map(fetchCritical));
    if ([operations, menu, orders].some((response) => response.status === 401)) {
      signOut('Your Captain session expired. Sign in again.');
      return;
    }
    const [operationData, menuData, orderData] = await Promise.all([
        operations.json(),
        menu.json(),
        orders.json(),
      ]),
      [availabilityResult, insightResult] = await Promise.allSettled([
        fetchWithTimeout('/api/orders/availability', options, 2500),
        fetchWithTimeout('/api/captain/menu-insights', options, 2500),
      ]),
      availability =
        availabilityResult.status === 'fulfilled' && availabilityResult.value.ok
          ? availabilityResult.value
          : null,
      insights =
        insightResult.status === 'fulfilled' && insightResult.value.ok ? insightResult.value : null,
      [availabilityData, insightData] = await Promise.all([
        availability ? availability.json() : [],
        insights ? insights.json() : { items: [] },
      ]);
    const unavailable = new Set(
        (Array.isArray(availabilityData) ? availabilityData : []).map((item) => item.item_key)
      ),
      allAreas = Array.isArray(operationData.config?.tableAreas)
        ? operationData.config.tableAreas
        : [];
    state.areas = state.captain.areas?.length
      ? allAreas.filter((area) => state.captain.areas.includes(area.name))
      : allAreas;
    state.menu = (Array.isArray(menuData) ? menuData : []).map((item) => ({
      ...item,
      unavailable: unavailable.has(item.key),
    }));
    state.orders = Array.isArray(orderData) ? orderData : [];
    state.salesOrders = (Array.isArray(insightData.items) ? insightData.items : []).map((item) => ({
      items: [item],
    }));
    saveOfflineSnapshot();
    $('#captain-connection').textContent = `Live status · ${state.captain.name}`;
    renderTables();
    renderMenu();
    renderCaptainNav();
    void loadReadyAlerts();
  } catch (error) {
    if (!restoreOfflineSnapshot()) {
      const message =
        'The live table board could not be reached. Check the connection, then try again.';
      $('#captain-connection').textContent = message;
      renderTableLoadFailure(message);
    }
  }
}
function renderTables() {
  const tabs = $('#area-tabs'),
    stats = $('#table-quick-stats'),
    filters = $('#table-state-filters');
  if (!state.areas.length) {
    tabs.innerHTML = '';
    filters.innerHTML = '';
    stats.hidden = true;
    $('#table-board').innerHTML =
      '<p class="cart-empty">No table areas are assigned to this Captain. Ask an administrator to assign an area in Admin → Captain App.</p>';
    return;
  }
  if (!state.areas.some((area) => area.name === state.area) && state.area !== 'all')
    state.area = 'all';
  tabs.innerHTML = [['all', 'All tables'], ...state.areas.map((area) => [area.name, area.name])]
    .map(
      ([id, label]) =>
        `<button class="area-tab${state.area === id ? ' is-active' : ''}" data-area="${esc(id)}" type="button">${esc(label)}</button>`
    )
    .join('');
  const areas =
      state.area === 'all' ? state.areas : state.areas.filter((area) => area.name === state.area),
    cards = areas.flatMap((area) =>
      Array.from({ length: Number(area.to) - Number(area.from) + 1 }, (_, index) => ({
        area: area.name,
        number: Number(area.from) + index,
      }))
    ),
    meta = ({ area, number }) => {
      const active = activeTable(area, number),
        ready = state.readyAlerts.some(
          (alert) =>
            !state.readySeen[alert.id] &&
            alert.table_area === area &&
            Number(alert.table_number) === Number(number)
        ),
        service = String(active?.service_state || '');
      return { active, ready, service, attention: ready || !!service };
    },
    available = cards.filter((card) => !meta(card).active).length,
    occupied = cards.length - available,
    attention = cards.filter((card) => meta(card).attention).length;
  stats.hidden = false;
  stats.innerHTML = `<span><b>${cards.length}</b><small>Tables</small></span><span class="is-free"><b>${available}</b><small>Available</small></span>${occupied ? `<span class="is-live"><b>${occupied}</b><small>Active</small></span>` : ''}${attention ? `<span class="is-ready"><b>${attention}</b><small>Need attention</small></span>` : ''}<p>${state.area === 'all' ? 'Choose a table to begin an order.' : `${esc(state.area)} dining area`}</p>`;
  const filterEntries = [
    ['all', 'All tables', cards.length],
    ['available', 'Available', available],
    ['active', 'Active', occupied],
    ['attention', 'Attention', attention],
  ];
  filters.innerHTML = filterEntries
    .filter(([, key, count]) => key === 'All tables' || count)
    .map(
      ([key, label, count]) =>
        `<button type="button" data-table-filter="${key}" class="${state.tableFilter === key ? 'is-active' : ''}"><span>${label}</span><b>${count}</b></button>`
    )
    .join('');
  const matches = (card) => {
    const data = meta(card);
    return (
      state.tableFilter === 'all' ||
      (state.tableFilter === 'available' && !data.active) ||
      (state.tableFilter === 'active' && data.active) ||
      (state.tableFilter === 'attention' && data.attention)
    );
  };
  const tile = ({ area, number }) => {
    const { active, ready, service } = meta({ area, number }),
      selected = state.table?.area === area && state.table?.number === number,
      status = !active
        ? 'Available'
        : ready
          ? 'Ready to serve'
          : service === 'bill_requested'
            ? 'Bill requested'
            : service === 'water_requested'
              ? 'Water requested'
              : service === 'assistance_requested'
                ? 'Help requested'
                : `${String(active.status || 'Active').replace(/^./, (letter) => letter.toUpperCase())} · ${orderAge(active)}`,
      action = !active ? 'Start order' : ready ? 'Serve now' : 'Open order',
      stateClass = ready ? ' is-ready' : service ? ' is-service' : '';
    return `<button type="button" class="table-tile${active ? ' is-active' : ''}${selected ? ' is-selected' : ''}${stateClass}" data-table-area="${esc(area)}" data-table-number="${number}" aria-label="${esc(`${area} table ${number}: ${status}. ${action}`)}"><span>${esc(area)}</span><b>Table ${String(number).padStart(2, '0')}</b><small>${status}</small><em>${action} <i>→</i></em></button>`;
  };
  const groups = areas
    .map((area) => {
      const areaCards = Array.from(
          { length: Number(area.to) - Number(area.from) + 1 },
          (_, index) => ({ area: area.name, number: Number(area.from) + index })
        ),
        shown = areaCards.filter(matches),
        activeCount = areaCards.filter((card) => meta(card).active).length;
      if (!shown.length) return '';
      return `<section class="table-area-group"><header><div><b>${esc(area.name)}</b><small>${shown.length === areaCards.length ? `${areaCards.length} tables` : `${shown.length} of ${areaCards.length} tables`}</small></div><span>${activeCount ? `${activeCount} active` : 'All available'}</span></header><div class="table-area-grid">${shown.map(tile).join('')}</div></section>`;
    })
    .join('');
  $('#table-board').innerHTML = groups || '<p class="cart-empty">No tables match this filter.</p>';
}
function renderMenu() {
  const query = $('#menu-search').value.trim().toLowerCase(),
    available = state.menu.filter((item) => !item.unavailable),
    categories = [...new Set(available.map((item) => item.category || 'Menu'))].sort(),
    quick = new Set(state.recent);
  if (!categories.includes(state.category) && !['all', 'quick'].includes(state.category))
    state.category = 'all';
  const categoryEntries = [
      ['all', 'All items'],
      ...(quick.size ? [['quick', 'Quick order']] : []),
      ...categories.map((category) => [category, category]),
    ],
    activeLabel = categoryEntries.find(([key]) => key === state.category)?.[1] || 'Menu';
  $('#menu-category-label').textContent = activeLabel;
  $('#category-list').innerHTML = categoryEntries
    .map(
      ([key, label]) =>
        `<button class="category${state.category === key ? ' is-active' : ''}" type="button" data-category="${esc(key)}">${esc(label)}</button>`
    )
    .join('');
  $('#category-picker-list').innerHTML = categoryEntries
    .map(
      ([key, label]) =>
        `<button type="button" data-category-picker="${esc(key)}" class="${state.category === key ? 'is-active' : ''}"><span>${state.category === key ? '✓' : ' '}</span>${esc(label)}<b>›</b></button>`
    )
    .join('');
  const salesCount = new Map();
  state.salesOrders.forEach((order) =>
    (Array.isArray(order.items) ? order.items : []).forEach((line) => {
      const key = `${line.category || ''}::${line.name || ''}`;
      salesCount.set(key, (salesCount.get(key) || 0) + Number(line.quantity || 0));
    })
  );
  const bestItems = [...available]
      .filter((item) => salesCount.has(`${item.category || ''}::${item.name || ''}`))
      .sort(
        (a, b) =>
          (salesCount.get(`${b.category || ''}::${b.name || ''}`) || 0) -
          (salesCount.get(`${a.category || ''}::${a.name || ''}`) || 0)
      )
      .slice(0, 6),
    recentItems = state.recent
      .map((key) => available.find((item) => `${item.category || ''}::${item.name || ''}` === key))
      .filter(Boolean),
    quickItems = (bestItems.length ? bestItems : recentItems).slice(0, 6),
    quickRoot = $('#menu-quick-picks'),
    quickTitle = bestItems.length ? 'Best selling' : 'Quick order',
    quickDetail = bestItems.length ? 'Based on recent restaurant orders' : 'Recently added by you';
  quickRoot.hidden = !(state.category === 'all' && !query && quickItems.length);
  quickRoot.innerHTML = quickItems.length
    ? `<div><b>${quickTitle}</b><small>${quickDetail}</small></div><section>${quickItems.map((item) => `<button type="button" data-menu-index="${state.menu.indexOf(item)}"><span>${esc(item.name)}</span><b>${money((priceOptions(item)[0] || ['', 0])[1])}</b><i>+</i></button>`).join('')}</section>`
    : '';
  const visible = available
    .filter(
      (item) =>
        (state.category === 'all' ||
          (state.category === 'quick' && quick.has(`${item.category || ''}::${item.name || ''}`)) ||
          item.category === state.category) &&
        `${item.name} ${item.category}`.toLowerCase().includes(query)
    )
    .sort((a, b) =>
      state.category === 'quick'
        ? state.recent.indexOf(`${a.category || ''}::${a.name || ''}`) -
          state.recent.indexOf(`${b.category || ''}::${b.name || ''}`)
        : 0
    );
  $('#menu-list').innerHTML = visible.length
    ? visible
        .map((item) => {
          const options = priceOptions(item),
            first = options[0] || ['', 0],
            dietary = /\b(chicken|fish|prawn|meat|egg|mutton|beef|pork)\b/i.test(
              `${item.name} ${item.category}`
            )
              ? 'nonveg'
              : 'veg',
            inCart = state.cart
              .filter((line) => line.name === item.name && line.category === item.category)
              .reduce((sum, line) => sum + line.quantity, 0),
            index = state.menu.indexOf(item),
            control = inCart
              ? `<span class="menu-inline-quantity"><button type="button" data-menu-cart-change="-1" data-menu-index="${index}" aria-label="Remove one ${esc(item.name)}">−</button><b>${inCart}</b><button type="button" data-menu-cart-change="1" data-menu-index="${index}" aria-label="Add one ${esc(item.name)}">+</button></span>`
              : `<button type="button" class="menu-add-button" data-menu-index="${index}" aria-label="Add ${esc(item.name)}">+</button>`;
          return `<article class="menu-item${inCart ? ' is-added' : ''}" data-menu-index="${index}" data-menu-category-section="${esc(item.category || 'Menu')}" tabindex="0" role="button"><i class="diet ${dietary}"></i><span>${esc(item.category || 'Menu')}</span><b>${esc(item.name)}</b><small>${options.length > 1 ? 'From ' : ''}${money(first[1])}${options.length > 1 ? ' · choose' : ' · add'}</small>${control}</article>`;
        })
        .join('')
    : '<p class="cart-empty">No available dishes match your search.</p>';
}
function renderCart() {
  const count = itemCount(),
    amount = total(),
    lines = state.cart.length
      ? state.cart
          .map(
            (line, index) =>
              `<article class="cart-line"><span><b>${esc(line.name)}${line.portion ? ` · ${esc(line.portion)}` : ''}${line.style ? ` · ${esc(line.style)}` : ''}</b>${line.note ? `<small class="cart-note">↳ ${esc(line.note)}</small>` : ''}<small>${money(line.price)} each${line.style ? ' + ₹10 preparation' : ''}</small><label class="cart-course">Course <select data-cart-course="${index}">${courseOptions(line.defaultCourse || '', line.courseOverride || '')}</select></label><button type="button" class="cart-note-button" data-cart-note="${index}">${line.note ? 'Edit note' : 'Add note'}</button></span><div class="quantity"><button type="button" data-cart-change="-1" data-cart-index="${index}" aria-label="Remove one">−</button><b>${line.quantity}</b><button type="button" data-cart-change="1" data-cart-index="${index}" aria-label="Add one">+</button></div><b>${money(line.quantity * (line.price + (line.style ? 10 : 0)))}</b></article>`
          )
          .join('')
      : '<p class="cart-empty">No items yet. Add dishes from the menu.</p>';
  $('#cart-list').innerHTML = lines;
  $('#order-dock-list').innerHTML = lines;
  $('#cart-caption').textContent = count
    ? `${count} item${count === 1 ? '' : 's'} in this order.`
    : 'No items in this order.';
  $('#order-dock-caption').textContent = count
    ? `${count} item${count === 1 ? '' : 's'} · ready to review`
    : 'Choose dishes from the menu.';
  $('#order-dock-title').textContent =
    state.table?.mode === 'takeaway'
      ? 'Takeaway order'
      : state.table
        ? `Table ${String(state.table.number).padStart(2, '0')}`
        : 'Your order';
  $('#review-total').textContent = money(amount);
  $('#order-dock-total').textContent = money(amount);
  $('#cart-count').textContent = `${count} item${count === 1 ? '' : 's'}`;
  $('#basket-total').textContent = money(amount);
  $('#basket-bar').hidden = state.screen === 'tables' || !count;
  $('#place-order').disabled = !count || state.sending;
  const sendKot = $('#send-kot').checked;
  $('#place-order').textContent = state.sending
    ? state.kotRetry
      ? 'Sending KOT…'
      : 'Saving order…'
    : state.kotRetry
      ? 'Retry KOT ↗'
      : navigator.onLine
        ? sendKot
          ? 'Send to kitchen ↗'
          : 'Save order'
        : sendKot
          ? 'Save to sync ↗'
          : 'Save draft offline ↗';
  renderCaptainNav();
  saveDraft();
}
function openChoice(item) {
  const options = priceOptions(item);
  if (!options.length) return;
  state.choice = { item, option: options[0] };
  $('#choice-title').textContent = item.name;
  $('#choice-helper').textContent =
    options.length === 1
      ? 'This dish has one available portion.'
      : 'Choose a portion, then add a kitchen note only if needed.';
  $('#choice-add').textContent = `Add ${options[0][0]} · ${money(options[0][1])}`;
  $('#choice-options').innerHTML = options
    .map(
      ([portion, price], index) =>
        `<button type="button" class="choice-option${index === 0 ? ' is-selected' : ''}" data-choice-index="${index}"><b>${esc(portion)}</b><small>${money(price)}</small></button>`
    )
    .join('');
  const style = $('#style-options');
  style.hidden = !item.gravyStyleAvailable;
  style.querySelector('input[value=""]').checked = true;
  $('#choice-note').value = '';
  $('#choice-course').innerHTML = courseOptions(item.defaultCourse || '');
  $('#choice-sheet').showModal();
}
function addChoice() {
  const choice = state.choice;
  if (!choice) return;
  const style = $('input[name="captain-style"]:checked')?.value || '',
    note = $('#choice-note').value.trim(),
    courseOverride = $('#choice-course').value || '',
    [portion, price] = choice.option,
    key = itemKey({ menuType: choice.item.menuType, name: choice.item.name, category: choice.item.category, portion, style, note, courseOverride }),
    existing = state.cart.find((line) => line.key === key);
  if (existing) existing.quantity = Math.min(20, existing.quantity + 1);
  else
    state.cart.push({
      key,
      name: choice.item.name,
      category: choice.item.category,
      menuType: choice.item.menuType,
      portion,
      style,
      note,
      defaultCourse: choice.item.defaultCourse || '',
      courseOverride,
      price,
      quantity: 1,
    });
  rememberItem(choice.item);
  $('#choice-sheet').close();
  state.choice = null;
  renderCart();
  renderMenu();
}
function addSimpleItem(item) {
  const [portion, price] = priceOptions(item)[0] || [];
  if (!portion || !price) return;
  const key = itemKey({ menuType: item.menuType, name: item.name, category: item.category, portion, style: '', courseOverride: '' }),
    existing = state.cart.find((line) => line.key === key);
  if (existing) existing.quantity = Math.min(20, existing.quantity + 1);
  else
    state.cart.push({
      key,
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
  rememberItem(item);
  renderCart();
  renderMenu();
}
function signOut(message = 'Signed out.') {
  state.captain = null;
  state.loginAccount = null;
  state.table = null;
  state.cart = [];
  state.kotRetry = null;
  try {
    sessionStorage.removeItem(sessionKey);
    sessionStorage.removeItem(loginSelectionKey);
    localStorage.removeItem(sessionKey);
  } catch {}
  setCaptainUI();
  $('#captain-login-status').textContent = message;
  loadAccounts();
}
function resetCaptainIdleLock() {
  if (!state.captain) return;
  clearTimeout(captainIdleTimer);
  captainIdleTimer = setTimeout(() => {
    saveDraft();
    signOut('Session locked after inactivity. Sign in with your PIN to continue.');
  }, captainIdleMs());
}
$('#captain-account-list').addEventListener('click', (event) => {
  const button = event.target.closest('[data-captain-id]');
  if (button) selectCaptain(button.dataset.captainId);
  if (event.target.closest('[data-retry-captain-accounts]')) void loadAccounts();
});
$('#captain-change-account').addEventListener('click', () => showAccountChooser());
$('#captain-pin-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  let account = state.loginAccount;
  if (!account) {
    let savedId = '';
    try {
      savedId = sessionStorage.getItem(loginSelectionKey) || '';
    } catch {}
    account =
      state.accounts.find((captain) => captain.id === savedId) ||
      (state.accounts.length === 1 ? state.accounts[0] : null);
    if (account) state.loginAccount = account;
  }
  const pin = $('#captain-pin').value.trim(),
    status = $('#captain-login-status'),
    submit = $('#captain-login-submit');
  if (!account) {
    status.textContent = 'Choose your Captain name first.';
    $('#captain-pin-form').hidden = true;
    $('#captain-account-list').hidden = false;
    return;
  }
  if (!/^\d{4,6}$/.test(pin)) {
    status.textContent = 'Enter the 4 to 6 digit PIN set in Admin → Captain App.';
    return;
  }
  submit.disabled = true;
  status.textContent = 'Signing in…';
  try {
    const response = await fetch('/api/captain/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: account.id, pin }),
      }),
      data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Unable to sign in.');
    state.captain = { ...data.captain, token: data.token };
    sessionStorage.setItem(sessionKey, JSON.stringify(state.captain));
    localStorage.setItem(sessionKey, JSON.stringify(state.captain));
    if (navigator.storage?.persist) void navigator.storage.persist().catch(() => {});
    loadPending();
    setCaptainUI();
    resetCaptainIdleLock();
    await load();
    void flushPending();
  } catch (error) {
    status.textContent = error.message || 'Unable to sign in.';
    $('#captain-pin').select();
  } finally {
    submit.disabled = false;
  }
});
$('#captain-profile').addEventListener('click', () => {
  if (confirm(`Sign out ${state.captain?.name || 'Captain'}?`)) signOut();
});
$('#captain-nav-toggle').addEventListener('click', () => {
  renderCaptainNav();
  $('#captain-nav').hidden = false;
});
document
  .querySelectorAll('[data-captain-nav-close]')
  .forEach((button) => button.addEventListener('click', () => ($('#captain-nav').hidden = true)));
$('#captain-nav-signout').addEventListener('click', () => {
  if (confirm(`Sign out ${state.captain?.name || 'Captain'}?`)) signOut();
});
$('#captain-nav-links').addEventListener('click', (event) => {
  const button = event.target.closest('[data-captain-nav-screen]');
  if (!button) return;
  const screen = button.dataset.captainNavScreen;
  if (screen === 'review' && !state.cart.length) {
    $('#captain-nav').hidden = true;
    setScreen('tables');
    return;
  }
  $('#captain-nav').hidden = true;
  setScreen(screen);
});
$('#captain-nav-active-list').addEventListener('click', (event) => {
  const button = event.target.closest('[data-captain-nav-table]');
  if (!button) return;
  const area = button.dataset.captainNavTable,
    number = Number(button.dataset.captainNavNumber),
    active = activeTable(area, number);
  if (!active) return;
  state.table = { area, number, orderId: active.id };
  state.cart = [];
  $('#captain-nav').hidden = true;
  renderCart();
  setScreen('menu');
  void loadKotProgress(active.id);
});
$('#captain-nav-ready-list').addEventListener('click', (event) => {
  const button = event.target.closest('[data-captain-ready-table]');
  if (!button) return;
  const area = button.dataset.captainReadyTable,
    number = Number(button.dataset.captainReadyNumber),
    active = activeTable(area, number);
  if (!active) return;
  state.table = { area, number, orderId: active.id };
  state.cart = [];
  $('#captain-table-service').hidden = false;
  $('#captain-nav').hidden = true;
  renderCart();
  setScreen('menu');
});
$('#captain-ready-alerts').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-ready-served]');
  if (!button) return;
  button.disabled = true;
  try {
    const response = await fetch(
        `/api/captain/orders/${encodeURIComponent(button.dataset.readyServed)}/kots/${encodeURIComponent(button.dataset.readyKot)}/served`,
        { method: 'POST', headers: captainHeaders() }
      ),
      data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Unable to mark served.');
    state.readyAlerts = state.readyAlerts.filter(
      (alert) => alert.id !== button.dataset.readyServed
    );
    renderReadyAlerts();
    showCaptainToast('Marked as served.', 'success');
  } catch (error) {
    button.disabled = false;
    button.textContent = error.message || 'Try again';
  }
});
$('#captain-table-service').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-table-service]');
  if (!button || !state.table?.orderId) return;
  button.disabled = true;
  try {
    const response = await fetch(
        `/api/captain/orders/${encodeURIComponent(state.table.orderId)}/service`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...captainHeaders() },
          body: JSON.stringify({ serviceState: button.dataset.tableService }),
        }
      ),
      data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Unable to send request.');
    button.textContent = 'Requested ✓';
  } catch (error) {
    button.disabled = false;
    button.textContent = error.message || 'Try again';
  }
});
function handlePendingAction(event) {
  const sync = event.target.closest('[data-sync-pending]'),
    recover = event.target.closest('[data-recover-pending]'),
    retryKot = event.target.closest('[data-retry-pending-kot]'),
    accept = event.target.closest('[data-accept-pending]'),
    discard = event.target.closest('[data-discard-pending]');
  if (sync || retryKot) void flushPending();
  if (recover) recoverPending(Number(recover.dataset.recoverPending));
  if (accept) acceptPendingConflict(Number(accept.dataset.acceptPending));
  if (discard) discardPending(Number(discard.dataset.discardPending));
}
$('#captain-pending-sync').addEventListener('click', handlePendingAction);
$('#captain-nav-conflicts').addEventListener('click', handlePendingAction);
$('#area-tabs').addEventListener('click', (event) => {
  const button = event.target.closest('[data-area]');
  if (button) {
    state.area = button.dataset.area;
    renderTables();
  }
});
$('#table-state-filters').addEventListener('click', (event) => {
  const button = event.target.closest('[data-table-filter]');
  if (!button) return;
  state.tableFilter = button.dataset.tableFilter;
  renderTables();
});
$('#captain-order-action-toggle').addEventListener('click', () => {
  const list = $('#captain-order-action-list'),
    toggle = $('#captain-order-action-toggle');
  list.hidden = !list.hidden;
  toggle.classList.toggle('is-open', !list.hidden);
  toggle.setAttribute('aria-expanded', String(!list.hidden));
});
$('#captain-order-action-list').addEventListener('click', (event) => {
  const closeActions = () => {
    const list = $('#captain-order-action-list'),
      toggle = $('#captain-order-action-toggle');
    list.hidden = true;
    toggle.classList.remove('is-open');
    toggle.setAttribute('aria-expanded', 'false');
  };
  if (event.target.closest('[data-start-takeaway]')) {
    state.kotRetry = null;
    state.table = { area: '', number: 0, orderId: '', mode: 'takeaway' };
    state.cart = [];
    $('#captain-table-service').hidden = true;
    closeActions();
    renderCart();
    setScreen('menu');
    return;
  }
  if (event.target.closest('[data-new-table-help]')) {
    closeActions();
    $('#captain-connection').textContent = 'Choose an available table to start a dine-in order.';
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
});
$('#table-board').addEventListener('click', (event) => {
  const button = event.target.closest('[data-table-area]');
  if (!button) return;
  const active = activeTable(button.dataset.tableArea, Number(button.dataset.tableNumber));
  state.kotRetry = null;
  state.table = {
    area: button.dataset.tableArea,
    number: Number(button.dataset.tableNumber),
    orderId: active?.id || '',
  };
  $('#captain-table-service').hidden = !active;
  state.cart = [];
  restoreDraft();
  renderTables();
  renderCart();
  setScreen('menu');
  if (active) void loadKotProgress(active.id);
});
const categoryKey = (value) =>
  String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
function selectMenuCategory(category, { closePicker = false, scrollToDishes = false } = {}) {
  const selected = categoryKey(category),
    menuCategory = state.menu.find((item) => categoryKey(item.category) === selected)?.category;
  state.category = selected === 'all' || selected === 'quick' ? selected : menuCategory || category;
  $('#menu-search').value = '';
  if (closePicker && $('#category-sheet').open) $('#category-sheet').close();
  renderMenu();
  const dishes = $('#menu-list'),
    quickRoot = $('#menu-quick-picks'),
    recentItems = new Set(state.recent);
  if (selected !== 'all') {
    quickRoot.hidden = true;
    quickRoot.innerHTML = '';
    [...dishes.querySelectorAll('.menu-item')].forEach((card) => {
      const item = state.menu[Number(card.dataset.menuIndex)],
        matches =
          selected === 'quick'
            ? recentItems.has(`${item?.category || ''}::${item?.name || ''}`)
            : categoryKey(item?.category) === selected;
      if (!matches) card.remove();
    });
  }
  const shown = dishes.querySelectorAll('.menu-item').length;
  if (selected !== 'all' && shown) {
    const heading = document.createElement('h2');
    heading.className = 'menu-section-heading';
    heading.textContent = selected === 'quick' ? 'Quick order' : String(category).trim();
    dishes.prepend(heading);
  }
  if (selected !== 'all' && !shown)
    dishes.innerHTML = `<p class="cart-empty">No available dishes in ${esc(String(category).trim())}.</p>`;
  if (scrollToDishes) {
    const top = Math.max(0, dishes.getBoundingClientRect().top + window.scrollY - 18);
    document.scrollingElement.scrollTop = top;
    window.scrollTo({ top, behavior: 'smooth' });
    dishes.tabIndex = -1;
    dishes.focus({ preventScroll: true });
  }
  return shown;
}
$('#category-list').addEventListener('click', (event) => {
  const button = event.target.closest('[data-category]');
  if (button) selectMenuCategory(button.dataset.category);
});
$('#menu-category-toggle').addEventListener('click', () => {
  renderMenu();
  $('#category-sheet').showModal();
});
$('#category-close').addEventListener('click', () => $('#category-sheet').close());
$('#category-picker-list').addEventListener('click', (event) => {
  const button = event.target.closest('[data-category-picker]');
  if (!button) return;
  selectMenuCategory(button.dataset.categoryPicker, { closePicker: true, scrollToDishes: true });
});
document.addEventListener(
  'click',
  (event) => {
    const button = event.target.closest?.('[data-category-picker]');
    if (!button) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const shown = selectMenuCategory(button.dataset.categoryPicker, {
        closePicker: true,
        scrollToDishes: true,
      }),
      label = button.textContent.replace('›', '').trim();
    showCaptainToast(
      shown
        ? `Showing ${label} · ${shown} dish${shown === 1 ? '' : 'es'}.`
        : `No available dishes in ${label}.`,
      'success'
    );
  },
  true
);
function changeMenuItem(item, delta) {
  const options = priceOptions(item);
  if (delta > 0) {
    if (options.length === 1 && !item.gravyStyleAvailable) addSimpleItem(item);
    else openChoice(item);
    return;
  }
  const index = [...state.cart]
    .map((line, row) => ({ line, row }))
    .reverse()
    .find(({ line }) => line.name === item.name && line.category === item.category)?.row;
  if (index === undefined) return;
  state.cart[index].quantity -= 1;
  if (state.cart[index].quantity <= 0) state.cart.splice(index, 1);
  renderCart();
  renderMenu();
}
$('#menu-list').addEventListener('click', (event) => {
  const control = event.target.closest('[data-menu-cart-change]'),
    target = event.target.closest('[data-menu-index]'),
    item = state.menu[Number((control || target)?.dataset.menuIndex)];
  if (!item) return;
  if (control) {
    changeMenuItem(item, Number(control.dataset.menuCartChange));
    return;
  }
  const options = priceOptions(item);
  if (options.length === 1 && !item.gravyStyleAvailable) addSimpleItem(item);
  else openChoice(item);
});
$('#menu-list').addEventListener('keydown', (event) => {
  if ((event.key !== 'Enter' && event.key !== ' ') || event.target.closest('button')) return;
  const target = event.target.closest('.menu-item[data-menu-index]'),
    item = state.menu[Number(target?.dataset.menuIndex)];
  if (!item) return;
  event.preventDefault();
  const options = priceOptions(item);
  if (options.length === 1 && !item.gravyStyleAvailable) addSimpleItem(item);
  else openChoice(item);
});
$('#menu-quick-picks').addEventListener('click', (event) => {
  const button = event.target.closest('[data-menu-index]'),
    item = state.menu[Number(button?.dataset.menuIndex)];
  if (!item) return;
  const options = priceOptions(item);
  if (options.length === 1 && !item.gravyStyleAvailable) addSimpleItem(item);
  else openChoice(item);
});
$('#choice-options').addEventListener('click', (event) => {
  const button = event.target.closest('[data-choice-index]');
  if (!button || !state.choice) return;
  state.choice.option = priceOptions(state.choice.item)[Number(button.dataset.choiceIndex)];
  $('#choice-add').textContent = `Add ${state.choice.option[0]} · ${money(state.choice.option[1])}`;
  [...$('#choice-options').querySelectorAll('.choice-option')].forEach((option) =>
    option.classList.toggle('is-selected', option === button)
  );
});
$('#choice-add').addEventListener('click', addChoice);
$('#choice-close').addEventListener('click', () => $('#choice-sheet').close());
function changeCartQuantity(event) {
  const noteButton = event.target.closest('[data-cart-note]');
  if (noteButton) {
    const line = state.cart[Number(noteButton.dataset.cartNote)];
    if (!line) return;
    const note = prompt(`Kitchen note for ${line.name}`, line.note || '');
    if (note === null) return;
    line.note = note.trim().slice(0, 80);
    line.key = itemKey(line);
    renderCart();
    return;
  }
  const button = event.target.closest('[data-cart-index]');
  if (!button) return;
  const line = state.cart[Number(button.dataset.cartIndex)];
  if (!line) return;
  line.quantity += Number(button.dataset.cartChange);
  if (line.quantity <= 0) state.cart.splice(Number(button.dataset.cartIndex), 1);
  renderCart();
}
function changeCartCourse(event) {
  const select = event.target.closest('[data-cart-course]');
  if (!select) return;
  const index = Number(select.dataset.cartCourse);
  const line = state.cart[index];
  if (!line) return;
  line.courseOverride = select.value || '';
  line.key = itemKey(line);
  const duplicateIndex = state.cart.findIndex(
    (candidate, candidateIndex) => candidateIndex !== index && candidate.key === line.key
  );
  if (duplicateIndex >= 0) {
    state.cart[duplicateIndex].quantity = Math.min(
      20,
      Number(state.cart[duplicateIndex].quantity || 0) + Number(line.quantity || 0)
    );
    state.cart.splice(index, 1);
  }
  renderCart();
  renderMenu();
}
$('#cart-list').addEventListener('click', changeCartQuantity);
$('#order-dock-list').addEventListener('click', changeCartQuantity);
$('#cart-list').addEventListener('change', changeCartCourse);
$('#order-dock-list').addEventListener('change', changeCartCourse);
document.querySelectorAll('[data-open-review]').forEach((button) =>
  button.addEventListener('click', () => {
    if (state.cart.length) setScreen('review');
    else showCaptainToast('Add at least one dish before reviewing.', 'error');
  })
);
$('#menu-search').addEventListener('input', renderMenu);
$('#menu-search-toggle').addEventListener('click', () => {
  const wrap = $('#menu-search-wrap');
  wrap.hidden = !wrap.hidden;
  if (!wrap.hidden) $('#menu-search').focus();
});
$('#clear-menu-search').addEventListener('click', () => {
  $('#menu-search').value = '';
  renderMenu();
});
document
  .querySelectorAll('[data-captain-back]')
  .forEach((button) =>
    button.addEventListener('click', () => setScreen(state.screen === 'review' ? 'menu' : 'tables'))
  );
$('#basket-bar').addEventListener('click', () => setScreen('review'));
$('#refresh-captain').addEventListener('click', load);
$('#table-board').addEventListener('click', (event) => {
  if (event.target.closest('[data-retry-captain-load]')) void load();
});
$('#send-kot').addEventListener('change', renderCart);
$('#place-order').addEventListener('click', async () => {
  if (state.sending || !state.table || !state.cart.length) return;
  let payload = null;
  const status = $('#order-status'),
    isTakeaway = state.table.mode === 'takeaway',
    complete = async (data, sendKot) => {
      clearDraft();
      state.cart = [];
      state.table = null;
      state.kotRetry = null;
      $('#customer-name').value = '';
      $('#customer-phone').value = '';
      $('#special-request').value = '';
      await load();
      setScreen('tables');
      $('#captain-connection').textContent = sendKot
        ? `Order #${data.orderNumber} sent to the kitchen${data.kotNumber ? ` · KOT #${data.kotNumber}` : ''}.`
        : `Order #${data.orderNumber} saved. Kitchen has not been notified.`;
      showCaptainToast(
        sendKot
          ? `${isTakeaway ? 'Takeaway' : 'Table'} order #${data.orderNumber} sent to kitchen.`
          : `Order #${data.orderNumber} saved without a KOT.`,
        'success'
      );
    },
    saveForSync = () => {
      queuePending(payload);
      clearDraft();
      state.cart = [];
      state.table = null;
      $('#customer-name').value = '';
      $('#customer-phone').value = '';
      $('#special-request').value = '';
      setScreen('tables');
      $('#captain-connection').textContent =
        'Order saved on this device and will sync when internet returns.';
      showCaptainToast('Order saved safely. It will sync when internet returns.', 'offline');
    };
  state.sending = true;
  renderCart();
  try {
    if (state.kotRetry) {
      if (!navigator.onLine) throw new Error('You are offline. Reconnect to send this saved KOT.');
      status.textContent = `Sending KOT for saved order #${state.kotRetry.orderNumber}…`;
      const retry = state.kotRetry,
        kot = await postCaptainKot(retry.id);
      await complete({ orderNumber: retry.orderNumber, kotNumber: kot.kotNumber }, true);
      return;
    }
    const sendKot = $('#send-kot').checked;
    payload = {
      clientRequestId: requestId(),
      source: 'captain',
      action: sendKot ? 'submit' : 'save',
      sendKot,
      tableArea: state.table.area,
      tableNumber: state.table.number,
      tableOrderId: state.table.orderId || '',
      customerName: $('#customer-name').value.trim(),
      customerPhone: $('#customer-phone').value.trim(),
      courseMode: $('#course-mode').value || 'normal_coursing',
      specialRequest: $('#special-request').value.trim(),
      items: state.cart.map(({ key, ...item }) => item),
    };
    if (!navigator.onLine) {
      saveForSync();
      return;
    }
    status.textContent = sendKot ? 'Sending KOT to kitchen…' : 'Saving order without a KOT…';
    const data = await postCaptainOrder(payload);
    await complete(data, sendKot);
  } catch (error) {
    if (error.savedOrder) {
      state.kotRetry = { id: error.savedOrder.id, orderNumber: error.savedOrder.orderNumber };
      status.textContent = `Order #${error.savedOrder.orderNumber} is saved. Retry will send only its KOT.`;
      showCaptainToast(
        `Order #${error.savedOrder.orderNumber} was saved. Retry KOT to notify the kitchen.`,
        'error'
      );
    } else if (payload && error.transient) {
      saveForSync();
    } else {
      status.textContent = error.message || 'Unable to save the order.';
      showCaptainToast(error.message || 'Unable to save the order.', 'error');
    }
  } finally {
    state.sending = false;
    renderCart();
  }
});
['customer-name', 'customer-phone', 'course-mode', 'special-request'].forEach((id) =>
  $(`#${id}`).addEventListener('input', saveDraft)
);
function clock() {
  $('#captain-clock').textContent = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date());
}
window.addEventListener('online', async () => {
  await load();
  renderCart();
  void flushPending();
});
window.addEventListener('offline', () => {
  $('#captain-connection').textContent =
    'Internet unavailable — new orders can be saved to sync safely.';
  renderCart();
  renderPendingSync();
});
window.addEventListener('resize', () => renderCart());
window.addEventListener('pageshow', () => {
  if (!state.captain) {
    setCaptainUI();
    void loadAccounts();
  }
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') saveDraft();
  else resetCaptainIdleLock();
});
['pointerdown', 'keydown', 'touchstart'].forEach((eventName) =>
  document.addEventListener(eventName, resetCaptainIdleLock, { passive: true })
);
let editingCartNoteIndex = -1;
function openCartNote(index) {
  const line = state.cart[index];
  if (!line) return;
  editingCartNoteIndex = index;
  $('#line-note-title').textContent = `Note for ${line.name}`;
  $('#line-note-caption').textContent =
    `Visible on the kitchen ticket for ${line.portion || 'this'} portion.`;
  $('#line-note-input').value = line.note || '';
  $('#line-note-count').textContent = $('#line-note-input').value.length;
  $('#line-note-sheet').showModal();
  setTimeout(() => $('#line-note-input').focus(), 0);
}
document.addEventListener(
  'click',
  (event) => {
    const button = event.target.closest('[data-cart-note]');
    if (!button) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    openCartNote(Number(button.dataset.cartNote));
  },
  true
);
$('#line-note-input').addEventListener('input', () => {
  $('#line-note-count').textContent = $('#line-note-input').value.length;
});
$('#line-note-close').addEventListener('click', () => $('#line-note-sheet').close());
$('#line-note-cancel').addEventListener('click', () => $('#line-note-sheet').close());
$('#line-note-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const line = state.cart[editingCartNoteIndex];
  if (!line) return $('#line-note-sheet').close();
  line.note = $('#line-note-input').value.trim().slice(0, 80);
  line.key = itemKey(line);
  $('#line-note-sheet').close();
  editingCartNoteIndex = -1;
  renderCart();
});
const draftContextKey = () =>
  state.captain ? `red-lantern-captain-draft-context:${captainDay()}:${state.captain.id}` : '';
const persistCaptainDraft = saveDraft,
  removeCaptainDraft = clearDraft;
saveDraft = function () {
  persistCaptainDraft();
  const key = draftContextKey(),
    fields = draftFields(),
    hasDraft =
      !!state.table &&
      (state.cart.length || fields.customerName || fields.customerPhone || fields.specialRequest);
  if (!key) return;
  try {
    if (!hasDraft) {
      localStorage.removeItem(key);
      return;
    }
    localStorage.setItem(
      key,
      JSON.stringify({
        savedAt: Date.now(),
        screen: state.screen,
        table: {
          area: state.table.area,
          number: state.table.number,
          orderId: state.table.orderId || '',
          mode: state.table.mode || '',
        },
      })
    );
  } catch {}
};
clearDraft = function () {
  removeCaptainDraft();
  const key = draftContextKey();
  if (key)
    try {
      localStorage.removeItem(key);
    } catch {}
};
function restoreLatestDraft() {
  if (state.draftRestored || !state.captain || state.table || state.cart.length) return false;
  const context = readLocalJSON(draftContextKey(), null),
    table = context?.table;
  if (
    !table ||
    !table.area ||
    !Number(table.number) ||
    Date.now() - Number(context.savedAt || 0) > 24 * 60 * 60 * 1000
  )
    return false;
  if (table.mode !== 'takeaway' && !state.areas.some((area) => area.name === table.area))
    return false;
  state.table = {
    area: table.area,
    number: Number(table.number),
    orderId: table.orderId || '',
    mode: table.mode || '',
  };
  restoreDraft();
  if (!state.cart.length) {
    state.table = null;
    return false;
  }
  state.draftRestored = true;
  state.kotRetry = null;
  renderTables();
  renderMenu();
  renderCart();
  setScreen(context.screen === 'review' ? 'review' : 'menu');
  showCaptainToast('Your unsent order draft was restored.', 'success');
  return true;
}
window.addEventListener('pagehide', saveDraft);
window.addEventListener('beforeunload', saveDraft);
const loadLiveCaptainBoard = load;
let captainLoadPromise = null;
load = function () {
  if (captainLoadPromise) return captainLoadPromise;
  captainLoadPromise = (async () => {
    const showSnapshot =
        !!state.captain &&
        navigator.onLine &&
        !state.areas.length &&
        !state.menu.length &&
        restoreOfflineSnapshot(),
      request = loadLiveCaptainBoard();
    if (showSnapshot) {
      $('#captain-connection').textContent = 'Saved table board · syncing live status…';
      restoreLatestDraft();
    }
    const result = await request;
    restoreLatestDraft();
    return result;
  })().finally(() => {
    captainLoadPromise = null;
  });
  return captainLoadPromise;
};
const captainSetScreen = setScreen;
setScreen = function (screen) {
  if (screen === 'menu' && state.table) state.lastTable = { ...state.table };
  captainSetScreen(screen);
};
history.replaceState({ captain: true, screen: 'tables' }, '', location.href);
history.pushState({ captain: true, screen: 'tables' }, '', location.href);
const captainTableActionSheet = $('#captain-table-actions');
let captainHeldTable = null,
  captainHoldTimer = null,
  captainSuppressTableClick = false;
const captainTableActionStyles = document.createElement('style');
captainTableActionStyles.textContent = `.table-tile{background:#f3f4f6}.table-tile.is-ongoing{background:#fff0b8!important;border-color:#e4b82f}.table-tile.is-settlement{background:#daf7de!important;border-color:#79d58a}.table-tile mark{position:absolute;top:10px;right:10px;padding:3px 6px;border:0;border-radius:999px;color:#13713d;background:#a9f3b6;font-size:9px;font-weight:900}.table-tile.is-ongoing mark{color:#765800;background:#ffe568}.captain-table-actions{position:fixed;right:0;bottom:0;left:0;width:min(520px,100%);margin:0 auto;padding:20px;border:0;border-radius:22px 22px 0 0;box-shadow:0 -12px 36px #17243a42}.captain-table-actions::backdrop{background:#17243a88}.captain-table-actions>button{position:absolute;top:10px;right:14px;background:transparent;font-size:22px}.captain-table-actions h2{margin:0 0 16px;text-align:center;font-size:16px}.captain-table-actions>div{display:grid;grid-template-columns:1fr 1fr;gap:8px}.captain-table-actions [data-captain-table-action]{display:flex;gap:9px;align-items:center;justify-content:center;min-height:48px;border-radius:10px;color:#1d2d48;background:#f4f6fa;font-weight:800}.captain-table-actions [data-captain-table-action=bill]{grid-column:1/-1;justify-content:flex-start;padding-left:17px}`;
document.head.appendChild(captainTableActionStyles);
const baseCaptainRenderTables = renderTables;
renderTables = function () {
  baseCaptainRenderTables();
  document.querySelectorAll('#table-board .table-tile').forEach((tile) => {
    const order = activeTable(tile.dataset.tableArea, Number(tile.dataset.tableNumber));
    tile.classList.toggle('is-settlement', !!order?.bill_printed_at);
    tile.classList.toggle('is-ongoing', !!order && !order?.bill_printed_at);
    if (order) {
      const age = document.createElement('mark');
      age.textContent = `◷ ${orderAge(order)}`;
      tile.prepend(age);
    }
  });
};
function openCaptainTableActions(tile) {
  const order = activeTable(tile.dataset.tableArea, Number(tile.dataset.tableNumber));
  if (!order) return;
  captainHeldTable = {
    area: tile.dataset.tableArea,
    number: Number(tile.dataset.tableNumber),
    order,
  };
  $('#captain-table-actions-title').textContent = `Table No: ${captainHeldTable.number}`;
  captainTableActionSheet.showModal();
}
$('#table-board').addEventListener(
  'pointerdown',
  (event) => {
    const tile = event.target.closest('.table-tile.is-active');
    if (!tile) return;
    captainHoldTimer = setTimeout(() => {
      captainSuppressTableClick = true;
      openCaptainTableActions(tile);
      navigator.vibrate?.(25);
    }, 550);
  },
  { passive: true }
);
['pointerup', 'pointercancel', 'pointermove'].forEach((name) =>
  $('#table-board').addEventListener(name, () => clearTimeout(captainHoldTimer), { passive: true })
);
$('#table-board').addEventListener(
  'click',
  (event) => {
    if (captainSuppressTableClick) {
      captainSuppressTableClick = false;
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  },
  true
);
$('#table-board').addEventListener('contextmenu', (event) => {
  if (event.target.closest('.table-tile.is-active')) event.preventDefault();
});
captainTableActionSheet.addEventListener('click', async (event) => {
  if (event.target.closest('[data-captain-table-actions-close]'))
    return captainTableActionSheet.close();
  const action = event.target.closest('[data-captain-table-action]')?.dataset.captainTableAction;
  if (!action || !captainHeldTable) return;
  if (action === 'view') {
    const { area, number, order } = captainHeldTable;
    captainTableActionSheet.close();
    state.table = { area, number, orderId: order.id };
    state.cart = [];
    renderCart();
    setScreen('menu');
    void loadKotProgress(order.id);
    return;
  }
  if (action === 'bill') {
    const button = event.target.closest('[data-captain-table-action]');
    button.disabled = true;
    try {
      const proximity = await captainPrintLocation();
      const response = await fetch(
          `/api/captain/orders/${encodeURIComponent(captainHeldTable.order.id)}/service`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...captainHeaders() },
            body: JSON.stringify({ serviceState: 'bill_requested', proximity }),
          }
        ),
        data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Unable to request the bill.');
      captainTableActionSheet.close();
      showCaptainToast('Bill sent to the billing printer.', 'success');
    } catch (error) {
      showCaptainToast(error.message || 'Unable to request the bill.', 'error');
    } finally {
      button.disabled = false;
    }
    return;
  }
  showCaptainToast('Move Table is available from the counter POS.', 'offline');
});
window.addEventListener('popstate', () => {
  if (!state.captain) {
    history.pushState({ captain: true, screen: 'tables' }, '', location.href);
    return;
  }
  if (state.screen === 'review') {
    setScreen('menu');
    history.pushState({ captain: true, screen: 'menu' }, '', location.href);
  } else if (state.screen === 'menu') {
    setScreen('tables');
    history.pushState({ captain: true, screen: 'tables' }, '', location.href);
  } else if (state.lastTable) {
    state.table = { ...state.lastTable };
    state.lastTable = null;
    setScreen('menu');
    history.pushState({ captain: true, screen: 'menu' }, '', location.href);
  } else {
    history.pushState({ captain: true, screen: 'tables' }, '', location.href);
    setScreen('tables');
  }
});
clock();
setInterval(clock, 30000);
setCaptainUI();
if (state.captain) {
  loadPending();
  resetCaptainIdleLock();
  void (async () => {
    await load();
    await flushPending();
  })();
} else loadAccounts();
setInterval(() => {
  if (navigator.onLine && state.captain && state.screen === 'tables') {
    void load();
    void flushPending();
  }
}, 10000);
