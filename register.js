const $ = (selector) => document.querySelector(selector);
const lists = { table: $('#tables-list'), parcel: $('#parcels-list') };
const money = (value) =>
  new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 2,
  }).format(Number(value || 0));
const escapeHtml = (value) =>
  String(value ?? '').replace(
    /[&<>'"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[c]
  );
const elapsed = (date) => {
  const min = Math.max(0, Math.floor((Date.now() - new Date(date).getTime()) / 60000));
  return min < 60 ? `${min}m` : `${Math.floor(min / 60)}h ${min % 60}m`;
};
let orders = [];
let registerLoadInFlight = null;
let registerRefreshRequested = false;
let registerAuthRevision = 0;
const clearedRegisterOrders = new Set();
try {
  const saved = JSON.parse(sessionStorage.getItem('red-lantern-register-cleared') || '[]');
  if (Array.isArray(saved)) saved.forEach(id => clearedRegisterOrders.add(String(id)));
} catch {}
function registerActor() { return window.currentEmployee?.id || ''; }
function clearedOrderKey(order) { return JSON.stringify([registerActor(), String(order.id)]); }
function requireRegisterPermission(right) {
  if (window.employeeCan && !window.employeeCan(right))
    throw new Error('This action is not enabled for your staff account.');
}
async function registerJson(url, options = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    let data;
    try { data = await response.json(); }
    catch {
      if (response.ok) throw new Error('The service has not confirmed a valid response. Retry to check the same request.');
      data = {};
    }
    return { response, data };
  } catch (error) {
    if (controller.signal.aborted) throw new Error('The service did not respond in time. Retry to check the same request.');
    throw error;
  } finally { clearTimeout(timeout); }
}
function icon(name) {
  return name === 'print'
    ? '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 8V3h10v5M7 17H4a1 1 0 0 1-1-1v-6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v6a1 1 0 0 1-1 1h-3"/><path d="M7 14h10v7H7z"/><path d="M17 11h1"/></svg>'
    : 'View order';
}
function active(order) {
  return !['rejected', 'cancelled'].includes(order.status) &&
    !(order.status === 'completed' && clearedRegisterOrders.has(clearedOrderKey(order)));
}
function displayOrder(order, kind) {
  const settled = order.status === 'completed';
  const table = kind === 'table';
  const needsAcceptance = !table && order.status === 'new';
  const identifier =
    order.customer_phone && !order.customer_phone.startsWith('walkin-') ? order.customer_phone : `Bill #${String(order.daily_order_number || '').padStart(2, '0')}`;
  const tableNumber = String(order.table_number || '').padStart(2, '0');
  const name = table
    ? order.customer_name || order.table_area || 'Dine-in'
    : order.customer_name || 'Counter Pick';
  const captainNames = table
    ? String(order.captain_names || '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean)
    : [];
  const captainLabel = captainNames.length
    ? `${captainNames.length === 1 ? 'Captain' : 'Captains'}: ${captainNames.join(' · ')}`
    : '';
  const unpaid = ['due', 'not_paid'].includes(order.settlement_type);
  const outstanding = order.settlement_type === 'part' && order.settlement_amount != null
    ? Math.max(0, Number(order.total || 0) - Number(order.settlement_amount)) : 0;
  const paid = unpaid ? `Unpaid · ${money(order.total)} due`
    : outstanding ? `Part paid · ${money(outstanding)} due`
      : order.settlement_type ? `Paid via ${String(order.settlement_type).toUpperCase()}` : 'Settled';
  const tableIdentity = `<div class="table-identity"><div class="token"><span>${escapeHtml(order.table_area || 'Table')}</span><b>${escapeHtml(tableNumber)}</b></div>${captainLabel ? `<small class="captain-assignment">${escapeHtml(captainLabel)}</small>` : ''}</div>`;
  return `<article data-order-id="${escapeHtml(order.id)}" class="order-strip ${table ? '' : 'parcel-strip'} ${settled ? 'settled' : ''} ${needsAcceptance ? 'needs-acceptance' : ''}">${table ? tableIdentity : `<div class="token">${escapeHtml(identifier)}</div>`}<div class="meta"><b>${escapeHtml(name)}${settled ? ` <small>• ${escapeHtml(paid)}</small>` : ''}</b><small>${needsAcceptance ? 'New order · waiting for acceptance' : settled ? 'Settled' : table ? 'Occupied' : 'Counter Pick'} • ${elapsed(order.created_at)}</small></div><div class="amount">${money(order.total)}</div><div class="actions">${needsAcceptance ? `<button class="accept-order" data-accept="${escapeHtml(order.id)}">✓ Accept</button>` : settled ? `<button class="clear" data-clear="${escapeHtml(order.id)}">✓ Ready to Clear</button><button class="icon" data-reprint="${escapeHtml(order.id)}" title="Reprint receipt" aria-label="Reprint receipt">${icon('print')}</button>` : `<button data-view="${escapeHtml(order.id)}">${icon('view')}</button><button class="icon" data-reprint="${escapeHtml(order.id)}" title="Reprint existing bill" aria-label="Reprint existing bill">${icon('print')}</button><span class="pay-group"><button data-pay="cash" data-id="${escapeHtml(order.id)}">Cash</button><button data-pay="upi" data-id="${escapeHtml(order.id)}">UPI</button><button data-pay="card" data-id="${escapeHtml(order.id)}">Card</button><button data-pay="zomato" data-id="${escapeHtml(order.id)}">Zomato</button><button data-pay="split" data-id="${escapeHtml(order.id)}">Split</button></span>`}</div></article>`;
}
function render() {
  const tables = orders.filter((o) => active(o) && o.mode === 'table'),
    parcels = orders.filter((o) => active(o) && o.mode !== 'table');
  lists.table.innerHTML =
    tables.map((o) => displayOrder(o, 'table')).join('') || $('#empty-template').innerHTML;
  lists.parcel.innerHTML =
    parcels.map((o) => displayOrder(o, 'parcel')).join('') || $('#empty-template').innerHTML;
  const activeTables = tables.filter((o) => o.status !== 'completed').length,
    activeParcels = parcels.filter((o) => o.status !== 'completed').length;
  $('#active-tables').textContent = `${activeTables} Active`;
  $('#pending-parcels').textContent = `${activeParcels} Pending`;
  $('#table-badge').textContent = `${activeTables} Active`;
  $('#parcel-badge').textContent = `${activeParcels} Pending`;
}
async function load({ fresh = false } = {}) {
  if (registerLoadInFlight) {
    if (fresh) registerRefreshRequested = true;
    return registerLoadInFlight;
  }
  registerLoadInFlight = (async () => {
    do { registerRefreshRequested = false; await refreshRegister(); }
    while (registerRefreshRequested);
  })();
  try { await registerLoadInFlight; }
  finally { registerLoadInFlight = null; }
}
async function refreshRegister() {
  const revision = registerAuthRevision;
  try {
    const { response, data } = await registerJson('/api/orders', { cache: 'no-store' });
    if (response.status === 401 && data?.loginUrl) {
      window.location.replace(data.loginUrl);
      return;
    }
    if (!response.ok) throw new Error(data?.error);
    if (revision !== registerAuthRevision) return;
    if (!Array.isArray(data) || data.some(order => !order || typeof order !== 'object' || !order.id ||
      order.total == null || !Number.isFinite(Number(order.total)) || Number(order.total) < 0))
      throw new Error('The order list could not be confirmed.');
    orders = data;
    $('#connection-dot').style.background = '#10b981';
    $('#connection-label').textContent = 'Live';
    $('#register-connection-notice').hidden = true;
    render();
  } catch (error) {
    $('#connection-dot').style.background = '#f43f5e';
    $('#connection-label').textContent = 'Offline';
    $('#register-connection-notice').hidden = false;
    $('#register-connection-notice p').textContent = 'Connection lost. Displayed orders may be out of date.';
  }
}
const savedItemTotal = (item) =>
  Number(item.quantity || 0) *
  (Number(String(item.price || '').replace(/[^0-9.]/g, '')) +
    (item.style ? 10 : 0) +
    (window.RedLanternAddons?.lineModifierTotal(item) || 0));
const savedItemLabel = (item) => {
  const extras = window.RedLanternAddons?.modifierText(item.modifiers) || '';
  return `${item.quantity}× ${item.name}${item.portion ? ` · ${item.portion}` : ''}${extras ? ` + ${extras}` : ''}`;
};
const receiptPrintsInFlight = new Map();
const receiptPrintAttempts = new Map();
let billViewSequence = 0;
async function receipt(id, print = false) {
  requireRegisterPermission('requestBills');
  if (print && receiptPrintsInFlight.has(id)) return receiptPrintsInFlight.get(id);
  const sequence = print ? null : ++billViewSequence;
  const request = prepareReceipt(id, print, sequence, registerActor());
  if (print) receiptPrintsInFlight.set(id, request);
  try {
    return await request;
  } finally {
    if (print) receiptPrintsInFlight.delete(id);
  }
}
async function prepareReceipt(id, print = false, sequence = null, actor = registerActor()) {
  const { response, data: order } = await registerJson(`/api/orders/${encodeURIComponent(id)}/print`, {
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(order?.error || 'Unable to load bill.');
  if (actor !== registerActor()) throw new Error('The signed-in staff account changed. Reopen this bill.');
  if (!order || typeof order !== 'object' || !order.id || !Array.isArray(order.items))
    throw new Error('The receipt has not been confirmed. Retry to load this bill.');
  if (print) {
    const origin = window.RED_LANTERN_CONFIG?.printBridgeOrigin || 'http://127.0.0.1:9124';
    const [{ response: health, data: bridge }, { response: configResponse, data: configuration }] = await Promise.all([
      registerJson(`${origin}/health`, { cache: 'no-store' }, 5000),
      registerJson('/api/orders/operations?configOnly=1', { cache: 'no-store' }, 5000),
    ]);
    if (!health.ok || !configResponse.ok)
      throw new Error('Printing is unavailable. Check Print Bridge in Orders → Operations.');
    if (actor !== registerActor()) throw new Error('The signed-in staff account changed. Reopen this bill.');
    requireRegisterPermission('requestBills');
    const domain = window.RedLanternPrinterDomain;
    const printers = domain.configuredPrintersFor(
      configuration?.config,
      'bill',
      bridge?.workstation?.id
    );
    if (!printers.length)
      throw new Error('No Bill printer is assigned to this computer. Check Orders → Operations.');
    const key = JSON.stringify([registerActor(), id]);
    const signature = JSON.stringify([order.items, order.total, order.discount_amount, order.loyalty_points_redeemed,
      order.loyalty_discount_amount, order.customer_name, order.customer_phone, order.special_request,
      order.table_area, order.table_number, printers]);
    let attempt = receiptPrintAttempts.get(key);
    if (!attempt || attempt.signature !== signature) {
      attempt = { signature, batch: crypto.randomUUID(), completed: new Set(), order };
      receiptPrintAttempts.set(key, attempt);
    }
    const results = await Promise.allSettled(
      printers.map(async (printer) => {
        if (attempt.completed.has(printer.id)) return;
        const { response: result, data: body } = await registerJson(`${origin}/v1/print-bill`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            printJobId: `register-bill:${attempt.batch}:${printer.id}`,
            printerName: printer.deviceName,
            workstationId: printer.workstationId || bridge.workstation?.id,
            order: attempt.order,
            settings: domain.printerFormat(printer, 'bill'),
          }),
        });
        if (!result.ok || result.status === 202 || body.pending || body.uncertain || body.ok === false)
          throw new Error(body.error || 'Printing is pending or needs review.');
        attempt.completed.add(printer.id);
      })
    );
    if (results.some((result) => result.status === 'rejected'))
      throw new Error(
        'Receipt printing needs attention. Check assigned Bill printers before reprinting; a copy may already exist.'
      );
    receiptPrintAttempts.delete(key);
    return;
  }
  if (sequence !== null && sequence !== billViewSequence) return;
  $('#bill-content').innerHTML =
    `<div class=bill><h2>Bill #${escapeHtml(order.daily_order_number)}</h2><p>${escapeHtml(order.mode === 'table' ? `${order.table_area || 'Table'} · Table ${order.table_number || ''}` : order.customer_phone || 'Counter parcel')} · ${escapeHtml(order.customer_name || 'Counter Pick')}</p><div class=bill-items>${order.items.map((i) => `<div class=bill-item><span>${escapeHtml(savedItemLabel(i))}</span><b>${money(savedItemTotal(i))}</b></div>`).join('')}</div><div class=bill-total><span><span>GST</span><span>Included</span></span><span><b>Total</b><b>${money(order.total)}</b></span></div><button class=reprint-receipt data-reprint="${escapeHtml(id)}">⎙ Reprint Receipt Only</button></div>`;
  $('#bill-modal').showModal();
}
let paymentOrder = null,
  paymentType = '',
  paymentSplit = false;
let paymentSaving = false;
let paymentActor = '';
const paymentAttempts = new Map();
function lockRegisterPayment(saving) {
  paymentSaving = saving;
  document.getElementById('payment-modal').setAttribute('aria-busy', String(saving));
  document.querySelectorAll('#payment-modal input, #payment-modal select, #payment-modal button').forEach(control => { control.disabled = saving; });
}
function paymentName(type) {
  return (
    {
      cash: 'Cash',
      upi: 'UPI / GPay',
      card: 'Card',
      zomato: 'Zomato',
      other: 'Other',
      due: 'Due',
      not_paid: 'Not paid',
      part: 'Split payment',
    }[type] || 'Not recorded'
  );
}
const paidPaymentTypes = new Set(['cash', 'upi', 'card', 'zomato', 'other']);
const paymentOptions = ['cash', 'upi', 'card', 'zomato', 'other', 'due'];
const validRegisterMoney = value => Number.isFinite(value) && value >= 0 && Math.abs(value * 100 - Math.round(value * 100)) < 0.000001;
function splitPaymentRows() {
  return [...document.querySelectorAll('.payment-split-row')].map((row) => ({
    row,
    type: row.querySelector('.split-type').value,
    amount: Number(row.querySelector('.split-applied').value || 0),
    received: Number(row.querySelector('.split-received').value || 0),
  }));
}
function syncSplitRow(row) {
  const type = row.querySelector('.split-type').value,
    applied = row.querySelector('.split-applied'),
    received = row.querySelector('.split-received'),
    unpaid = !paidPaymentTypes.has(type);
  row.classList.toggle('is-due', unpaid);
  received.disabled = unpaid;
  if (unpaid) received.value = '0.00';
  else if (!received.value || received.dataset.auto === 'true') received.value = applied.value;
}
function addSplitPayment(type = 'cash', amount = 0) {
  const row = document.createElement('div');
  row.className = 'payment-split-row';
  row.innerHTML = `<label>Method<select class="split-type">${paymentOptions.map((option) => `<option value="${option}" ${option === type ? 'selected' : ''}>${escapeHtml(paymentName(option))}</option>`).join('')}</select></label><label>Applied<input class="split-applied" type="number" min="0" step="0.01" inputmode="decimal" value="${Number(amount || 0).toFixed(2)}"></label><label class="split-received-wrap">Received<input class="split-received" type="number" min="0" step="0.01" inputmode="decimal" value="${Number(amount || 0).toFixed(2)}" data-auto="true"></label><button type="button" class="split-remove" aria-label="Remove payment">×</button>`;
  document.getElementById('payment-split-rows').append(row);
  syncSplitRow(row);
  updatePaymentPreview();
}
function updatePaymentPreview() {
  if (!paymentOrder) return;
  if (paymentSaving) { document.getElementById('payment-confirm').disabled = true; return; }
  if (paymentSplit) {
    const total = Number(paymentOrder.total || 0),
      rows = splitPaymentRows(),
      allocated = rows.reduce(
        (sum, row) => sum + (Number.isFinite(row.amount) ? row.amount : 0),
        0
      ),
      collected = rows.reduce(
        (sum, row) => sum + (paidPaymentTypes.has(row.type) && row.amount > 0 ? row.amount : 0),
        0
      ),
      change = rows.reduce(
        (sum, row) => sum + (row.type === 'cash' ? Math.max(0, row.received - row.amount) : 0),
        0
      ),
      tip = rows.reduce(
        (sum, row) => sum + (row.type === 'upi' ? Math.max(0, row.received - row.amount) : 0),
        0
      ),
      invalidRow = rows.some(
        (row) =>
          !row.type ||
          !validRegisterMoney(row.amount) ||
          (row.amount === 0 && !(total === 0 && rows.length === 1)) ||
          (paidPaymentTypes.has(row.type) &&
            (!validRegisterMoney(row.received) || row.received < row.amount)) ||
          (!['cash', 'upi'].includes(row.type) &&
            paidPaymentTypes.has(row.type) &&
            row.received > row.amount)
      ),
      difference = Math.round((total - allocated) * 100) / 100,
      preview = document.getElementById('payment-preview'),
      confirm = document.getElementById('payment-confirm');
    document.getElementById('payment-allocated').textContent = money(allocated);
    document.getElementById('payment-collected').textContent = money(collected);
    document.getElementById('payment-outstanding').textContent = money(
      Math.max(0, total - collected)
    );
    confirm.disabled = invalidRow || rows.length === 0 || Math.abs(difference) > 0.009;
    if (invalidRow) {
      preview.textContent = 'Every method needs a valid amount. Received cannot be short.';
      preview.dataset.state = 'due';
    } else if (difference > 0.009) {
      preview.textContent = `Still to allocate: ${money(difference)}`;
      preview.dataset.state = 'due';
    } else if (difference < -0.009) {
      preview.textContent = `Allocation exceeds the bill by ${money(Math.abs(difference))}.`;
      preview.dataset.state = 'due';
    } else {
      const notes = [
        change ? `Return ${money(change)} cash change` : '',
        tip ? `Record ${money(tip)} UPI tip` : '',
        collected < total ? `${money(total - collected)} remains due` : '',
      ].filter(Boolean);
      preview.textContent = notes.join(' · ') || 'The full bill is allocated and ready to save.';
      preview.dataset.state = tip ? 'tip' : change ? 'change' : 'exact';
    }
    return;
  }
  const due = Number(paymentOrder.total || 0),
    received = Number(document.getElementById('payment-received').value || 0),
    preview = document.getElementById('payment-preview'),
    confirm = document.getElementById('payment-confirm');
  if (!validRegisterMoney(received) || received < due) {
    preview.textContent = `Still due: ${money(Math.max(0, due - (Number.isFinite(received) ? received : 0)))}`;
    preview.dataset.state = 'due';
    confirm.disabled = true;
    return;
  }
  const difference = received - due;
  confirm.disabled = false;
  if (paymentType === 'cash') {
    preview.textContent = difference
      ? `Return change: ${money(difference)}`
      : 'Exact cash received.';
    preview.dataset.state = difference ? 'change' : 'exact';
  } else if (paymentType === 'upi') {
    preview.textContent = difference
      ? `Tip to record: ${money(difference)}`
      : 'Exact UPI payment received.';
    preview.dataset.state = difference ? 'tip' : 'exact';
  } else if (difference) {
    preview.textContent = `${paymentName(paymentType)} must match the exact bill amount.`;
    preview.dataset.state = 'due';
    confirm.disabled = true;
  } else {
    preview.textContent = 'Payment amount matches the bill.';
    preview.dataset.state = 'exact';
  }
}
function openPayment(id, type) {
  if (paymentSaving) return;
  requireRegisterPermission('takePayments');
  const order = orders.find((o) => String(o.id) === String(id));
  if (!order) return;
  if (!['accepted', 'preparing', 'ready'].includes(order.status))
    throw new Error('This order must be accepted before collecting payment.');
  paymentOrder = { ...order };
  paymentActor = registerActor();
  $('#register-service-notice')?.remove();
  paymentSplit = type === 'split';
  paymentType = paymentSplit ? '' : type;
  document.getElementById('payment-title').textContent = paymentSplit
    ? 'Split payment'
    : `${paymentName(paymentType)} payment`;
  document.getElementById('payment-order').textContent =
    `${order.mode === 'table' ? `${order.table_area || 'Table'} · Table ${String(order.table_number || '').padStart(2, '0')}` : 'Parcel'} · Bill #${String(order.daily_order_number || '').padStart(2, '0')}`;
  document.getElementById('payment-due').textContent = money(order.total);
  document.getElementById('payment-single').hidden = paymentSplit;
  document.getElementById('payment-split').hidden = !paymentSplit;
  document.getElementById('payment-received-label').textContent =
    paymentType === 'cash'
      ? 'Cash received from customer'
      : paymentType === 'upi'
        ? 'UPI / GPay received'
        : 'Amount received';
  document.getElementById('payment-received').value = Number(order.total || 0).toFixed(2);
  const shortcuts = document.getElementById('payment-cash-shortcuts');
  shortcuts.hidden = paymentSplit || type !== 'cash';
  const total = Number(order.total || 0);
  const roundAmounts = [...new Set([Math.ceil(total / 100) * 100, Math.ceil(total / 500) * 500, Math.ceil(total / 1000) * 1000])].filter(amount => amount > total);
  shortcuts.innerHTML = `<button type="button" data-cash-amount="${total}">Exact amount</button>${roundAmounts.map(amount => `<button type="button" data-cash-amount="${amount}">${money(amount)}</button>`).join('')}`;

  document.getElementById('payment-split-rows').replaceChildren();
  if (paymentSplit) addSplitPayment('cash', Number(order.total || 0));
  document.getElementById('payment-confirm').textContent = paymentSplit
    ? 'Save split payment'
    : `Save ${paymentName(paymentType)} payment`;
  updatePaymentPreview();
  document.getElementById('payment-modal').classList.toggle('is-split', paymentSplit);
  document.getElementById('payment-modal').showModal();
  if (!paymentSplit) {
    document.getElementById('payment-received').focus();
    document.getElementById('payment-received').select();
  }
}
async function savePayment() {
  if (!paymentOrder || paymentSaving) return;
  requireRegisterPermission('takePayments');
  if (paymentActor !== registerActor()) throw new Error('The signed-in staff account changed. Reopen this bill before collecting payment.');
  updatePaymentPreview();
  if (document.getElementById('payment-confirm').disabled) throw new Error('Review the payment amounts before saving.');
  const received = Number(document.getElementById('payment-received').value || 0),
    payments = paymentSplit
      ? splitPaymentRows().map((row) => ({
          paymentType: row.type,
          amount: row.amount,
          paymentReceived: paidPaymentTypes.has(row.type) ? row.received : 0,
        }))
      : null,
    confirm = document.getElementById('payment-confirm');
  const selectedOrder = paymentOrder;
  const payload = {
    ...(paymentSplit ? { payments } : { paymentType, amount: Number(selectedOrder.total || 0), paymentReceived: received }),
    expectedUpdatedAt: selectedOrder.order_version || selectedOrder.updated_at,
    actorEmployeeId: paymentActor,
  };
  const signature = JSON.stringify([selectedOrder.id, payload]);
  let requestId = paymentAttempts.get(signature);
  if (!requestId) { requestId = `register-${crypto.randomUUID()}`; paymentAttempts.set(signature, requestId); }
  lockRegisterPayment(true);
  confirm.textContent = 'Saving securely…';
  try {
    const { response, data } = await registerJson(`/api/orders/${encodeURIComponent(selectedOrder.id)}/settle`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Settlement-Id': requestId,
        },
        body: JSON.stringify(payload),
      });
    if (!response.ok) throw new Error(data?.error || 'Payment could not be saved.');
    if (data?.ok !== true) throw new Error('The payment has not been confirmed as saved. Retry to check the same payment request.');
    paymentAttempts.delete(signature);
    document.getElementById('payment-modal').close();
    paymentOrder = null;
    await load({ fresh: true });
  } finally {
    lockRegisterPayment(false);
    document.querySelectorAll('.payment-split-row').forEach(syncSplitRow);
    updatePaymentPreview();
    confirm.textContent = paymentSplit
      ? 'Save split payment'
      : `Save ${paymentName(paymentType)} payment`;
  }
}
function legacyPayment(order) {
  const unpaid = !order.settlement_type || ['due', 'not_paid'].includes(order.settlement_type);
  return {
    paymentType: order.settlement_type,
    appliedAmount: Number(order.total || 0),
    collectedAmount: unpaid ? 0 : Number(order.settlement_amount ?? order.total ?? 0),
  };
}
function legacyPayments(order) {
  if (order.settlement_type !== 'part') return [legacyPayment(order)];
  const total = Number(order.total || 0), collected = Math.max(0, Math.min(total, Number(order.settlement_amount || 0)));
  return [
    ...(collected ? [{ paymentType: 'part', appliedAmount: collected, collectedAmount: collected }] : []),
    ...(collected < total ? [{ paymentType: 'due', appliedAmount: total - collected, collectedAmount: 0 }] : []),
  ];
}
let summaryPrinting = false;
async function printSummary() {
  if (summaryPrinting) return;
  requireRegisterPermission('readHistory');
  const actor = registerActor(), revision = registerAuthRevision;
  const popup = window.open('', 'red-lantern-register-summary', 'popup=yes,width=1100,height=720');
  if (!popup) throw new Error('Allow pop-ups to print the register summary.');
  summaryPrinting = true;
  try {
  const chosenDay = document.getElementById('summary-date').value,
    { response, data } = await registerJson(
      `/api/register/summary${chosenDay ? `?date=${encodeURIComponent(chosenDay)}` : ''}`,
      { cache: 'no-store' }
    );
  if (!response.ok) throw new Error(data?.error || 'Unable to prepare the register summary.');
  if (revision !== registerAuthRevision || actor !== registerActor())
    throw new Error('The signed-in staff account changed. Reopen the summary.');
  if (!Array.isArray(data?.orders)) throw new Error('The register summary has not been confirmed. Retry to load it.');
  const rows = data.orders,
    rowsWithPayments = rows.map((order) => {
      const payments =
          Array.isArray(order.payments) && order.payments.length
            ? order.payments
            : legacyPayments(order),
        orderCollected = payments.reduce(
          (sum, payment) => sum + Number(payment.collectedAmount || 0),
          0
        );
      return { order, payments, orderCollected };
    }),
    sales = rows.reduce((sum, order) => sum + Number(order.total || 0), 0),
    collected = rowsWithPayments.reduce((sum, row) => sum + row.orderCollected, 0),
    tips = rows.reduce((sum, order) => sum + Number(order.tip_amount || 0), 0);
  popup.document.write(
    `<!doctype html><title>Register summary</title><style>body{font:12px Arial;padding:22px;color:#111}h1,p{margin:0 0 7px}table{width:100%;border-collapse:collapse;margin-top:18px}th,td{padding:8px;text-align:left;border-bottom:1px solid #ddd}th{font-size:10px;text-transform:uppercase;background:#f3f3f3}.right{text-align:right}.total{margin-top:18px;font-size:14px;font-weight:bold}</style><h1>Red Lantern Restaurant — Register Summary</h1><p>Date: ${escapeHtml(data.day || '')}</p><table><thead><tr><th>Bill</th><th>Type</th><th>Table / Parcel</th><th>Customer</th><th>Payment allocation</th><th class=right>Bill total</th><th class=right>Collected</th><th class=right>Due</th><th class=right>Change</th><th class=right>Tip</th></tr></thead><tbody>${rowsWithPayments.map(({ order, payments, orderCollected }) => `<tr><td>#${escapeHtml(order.daily_order_number)}</td><td>${order.mode === 'table' ? 'Dine-in' : 'Parcel'}</td><td>${escapeHtml(order.mode === 'table' ? `${order.table_area || 'Table'} · Table ${String(order.table_number || '').padStart(2, '0')}` : order.customer_phone || 'Walk-in')}</td><td>${escapeHtml(order.customer_name || 'Walk-in customer')}</td><td>${escapeHtml(payments.map((payment) => `${paymentName(payment.paymentType)} ${money(payment.appliedAmount)}`).join(' + '))}</td><td class=right>${money(order.total)}</td><td class=right>${money(orderCollected)}</td><td class=right>${money(Math.max(0, Number(order.total || 0) - orderCollected))}</td><td class=right>${money(order.change_due)}</td><td class=right>${money(order.tip_amount)}</td></tr>`).join('') || '<tr><td colspan=10>No completed payments for this date.</td></tr>'}</tbody></table><p class=total>Sales: ${money(sales)} &nbsp; | &nbsp; Collected: ${money(collected)} &nbsp; | &nbsp; Outstanding: ${money(Math.max(0, sales - collected))} &nbsp; | &nbsp; Tips: ${money(tips)}</p><script>onload=()=>print()<\/script>`
  );
  popup.document.close();
  } catch (error) { popup.close(); throw error; }
  finally { summaryPrinting = false; }
}
async function acceptOrder(id) {
  requireRegisterPermission('acceptOrders');
  const { response, data } = await registerJson(`/api/orders/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'accepted', actorEmployeeId: registerActor() }),
  });
  if (!response.ok) throw new Error(data?.error || 'Order could not be accepted.');
  if (data?.ok !== true) throw new Error('The order acceptance has not been confirmed. Retry to check its status.');
  await load({ fresh: true });
}
document.addEventListener('click', async (event) => {
  const target = event.target.closest('button');
  if (!target) return;
  try {
    if (target.dataset.view) await receipt(target.dataset.view);
    if (target.dataset.reprint) await receipt(target.dataset.reprint, true);
    if (target.dataset.pay) openPayment(target.dataset.id, target.dataset.pay);
    if (target.dataset.accept) await acceptOrder(target.dataset.accept);
    if (target.dataset.clear) {
      requireRegisterPermission('clearTables');
      const cleared = orders.find(order => String(order.id) === target.dataset.clear && order.status === 'completed');
      if (!cleared) throw new Error('Only a settled order can be cleared.');
      clearedRegisterOrders.add(clearedOrderKey(cleared));
      try { sessionStorage.setItem('red-lantern-register-cleared', JSON.stringify([...clearedRegisterOrders])); } catch {}
      orders = orders.filter((o) => String(o.id) !== target.dataset.clear);
      render();
    }
    if (target.id === 'register-retry') await load();
    const cashAmount = target.closest('[data-cash-amount]');
    if (cashAmount) { $('#payment-received').value = Number(cashAmount.dataset.cashAmount).toFixed(2); updatePaymentPreview(); }
    if (target.id === 'payment-confirm') await savePayment();
    if (target.id === 'payment-add-method') {
      const rows = splitPaymentRows(),
        total = Number(paymentOrder?.total || 0),
        allocated = rows.reduce((sum, row) => sum + row.amount, 0),
        remaining = Math.max(0, Math.round((total - allocated) * 100) / 100);
      if (!remaining && rows.length === 1) {
        const firstAmount = Math.floor((total * 100) / 2) / 100,
          firstApplied = rows[0].row.querySelector('.split-applied'),
          firstReceived = rows[0].row.querySelector('.split-received');
        firstApplied.value = firstAmount.toFixed(2);
        if (firstReceived.dataset.auto === 'true') firstReceived.value = firstApplied.value;
        addSplitPayment('upi', total - firstAmount);
      } else addSplitPayment('upi', remaining);
    }
    if (target.id === 'payment-add-due') {
      const rows = splitPaymentRows(),
        total = Number(paymentOrder?.total || 0),
        allocated = rows.reduce((sum, row) => sum + row.amount, 0),
        remaining = Math.max(0, Math.round((total - allocated) * 100) / 100);
      if (remaining) addSplitPayment('due', remaining);
    }
    if (target.classList.contains('split-remove')) {
      target.closest('.payment-split-row')?.remove();
      updatePaymentPreview();
    }
    if (target.id === 'print-summary') await printSummary();
    if (target.id === 'staff-sign-out') {
      if (paymentSaving) throw new Error('Wait for the current payment confirmation before signing out.');
      const { response, data } = await registerJson('/api/orders/session', { method: 'DELETE' });
      if (!response.ok || data?.ok !== true) throw new Error(data?.error || 'Sign out could not be confirmed. Try again.');
      window.location.replace('/staff-login?next=%2Fregister');
    }
    if (target.closest('.payment-close,.payment-cancel') && !paymentSaving)
      document.getElementById('payment-modal').close();
  } catch (error) {
    let notice = document.getElementById('register-service-notice');
    if (!notice) {
      notice = document.createElement('p');
      notice.id = 'register-service-notice';
      notice.setAttribute('role', 'status');
      (document.querySelector("dialog[open]") || document.body).prepend(notice);
    }
    notice.textContent = error.message === 'Failed to fetch' ? 'Unable to reach the server or print bridge. Check the connection and try again.' : error.message;
  }
});
$('.modal-close').addEventListener('click', () => { billViewSequence += 1; $('#bill-modal').close(); });
document.getElementById('payment-modal').addEventListener('cancel', event => { if (paymentSaving) event.preventDefault(); });
function clearRegisterViews() {
  registerAuthRevision += 1;
  orders = [];
  billViewSequence += 1;
  $('#bill-modal').close();
  $('#payment-modal').close();
  paymentOrder = null;
  render();
  $('#connection-label').textContent = 'Refresh needed';
  $('#register-connection-notice').hidden = false;
  $('#register-connection-notice p').textContent = 'Staff access changed. Refresh Register to load the current account’s orders.';
}
window.addEventListener('red-lantern-auth-changed', clearRegisterViews);
window.addEventListener('storage', event => {
  if (event.key === 'red-lantern-staff-access-profile-v1' || event.key === null) clearRegisterViews();
});
document.getElementById('payment-received').addEventListener('input', updatePaymentPreview);
document.getElementById('payment-split-rows').addEventListener('input', (event) => {
  const row = event.target.closest('.payment-split-row');
  if (!row) return;
  if (event.target.classList.contains('split-received')) event.target.dataset.auto = 'false';
  if (event.target.classList.contains('split-applied')) {
    const received = row.querySelector('.split-received');
    if (received.dataset.auto === 'true' && !received.disabled) received.value = event.target.value;
  }
  updatePaymentPreview();
});
document.getElementById('payment-split-rows').addEventListener('change', (event) => {
  const row = event.target.closest('.payment-split-row');
  if (!row) return;
  if (event.target.classList.contains('split-type')) syncSplitRow(row);
  updatePaymentPreview();
});
document.getElementById('summary-date').value = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
}).format(new Date());
function tick() {
  $('#clock').textContent = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  }).format(new Date());
}
tick();
setInterval(tick, 1000);
load();
setInterval(load, 15000);
