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
function icon(name) {
  return name === 'print' ? '⎙' : '◉ View';
}
function active(order) {
  return !['rejected', 'cancelled'].includes(order.status);
}
function displayOrder(order, kind) {
  const settled = order.status === 'completed';
  const table = kind === 'table';
  const needsAcceptance = !table && order.status === 'new';
  const identifier =
    order.customer_phone || `Token #TK-${String(order.daily_order_number || '').padStart(3, '0')}`;
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
  const paid = order.settlement_type
    ? `Paid via ${String(order.settlement_type).toUpperCase()}`
    : 'Settled';
  const tableIdentity = `<div class="table-identity"><div class="token"><span>Table</span><b>${escapeHtml(tableNumber)}</b></div>${captainLabel ? `<small class="captain-assignment">${escapeHtml(captainLabel)}</small>` : ''}</div>`;
  return `<article class="order-strip ${table ? '' : 'parcel-strip'} ${settled ? 'settled' : ''} ${needsAcceptance ? 'needs-acceptance' : ''}">${table ? tableIdentity : `<div class="token">${escapeHtml(identifier)}</div>`}<div class="meta"><b>${escapeHtml(name)}${settled ? ` <small>• ${escapeHtml(paid)}</small>` : ''}</b><small>${needsAcceptance ? 'New order · waiting for acceptance' : settled ? 'Settled' : table ? 'Occupied' : 'Counter Pick'} • ${elapsed(order.created_at)}</small></div><div class="amount">${money(order.total)}</div><div class="actions">${needsAcceptance ? `<button class="accept-order" data-accept="${order.id}">✓ Accept</button>` : settled ? `<button class="clear" data-clear="${order.id}">✓ Ready to Clear</button><button class="icon" data-reprint="${order.id}" title="Reprint receipt">${icon('print')}</button>` : `<button data-view="${order.id}">${icon('view')}</button><button class="icon" data-reprint="${order.id}" title="Reprint existing bill">${icon('print')}</button><span class="pay-group"><button data-pay="cash" data-id="${order.id}">Cash</button><button data-pay="upi" data-id="${order.id}">UPI</button><button data-pay="card" data-id="${order.id}">Card</button><button data-pay="zomato" data-id="${order.id}">Zomato</button><button data-pay="split" data-id="${order.id}">Split</button></span>`}</div></article>`;
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
async function load() {
  try {
    const response = await fetch('/api/orders', { cache: 'no-store' });
    const data = await response.json();
    if (response.status === 401 && data.loginUrl) {
      window.location.replace(data.loginUrl);
      return;
    }
    if (!response.ok) throw new Error(data.error);
    orders = Array.isArray(data) ? data : [];
    $('#connection-dot').style.background = '#10b981';
    $('#connection-label').textContent = 'Live';
    render();
  } catch (error) {
    $('#connection-dot').style.background = '#f43f5e';
    $('#connection-label').textContent = 'Offline';
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
const receiptPrintsInFlight = new Set();
async function receipt(id, print = false) {
  if (print && receiptPrintsInFlight.has(id)) return;
  if (print) receiptPrintsInFlight.add(id);
  try {
    return await prepareReceipt(id, print);
  } finally {
    if (print) receiptPrintsInFlight.delete(id);
  }
}
async function prepareReceipt(id, print = false) {
  const response = await fetch(`/api/orders/${encodeURIComponent(id)}/print`, {
    cache: 'no-store',
  });
  const order = await response.json();
  if (!response.ok) throw new Error(order.error || 'Unable to load bill.');
  if (print) {
    const origin = window.RED_LANTERN_CONFIG?.printBridgeOrigin || 'http://127.0.0.1:9124';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);
    let health;
    let configResponse;
    try {
      [health, configResponse] = await Promise.all([
        fetch(`${origin}/health`, { signal: controller.signal, cache: 'no-store' }),
        fetch('/api/orders/operations?configOnly=1', {
          signal: controller.signal,
          cache: 'no-store',
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    if (!health.ok || !configResponse.ok)
      throw new Error('Printing is unavailable. Check Print Bridge in Orders → Operations.');
    const bridge = await health.json();
    const configuration = await configResponse.json();
    const domain = window.RedLanternPrinterDomain;
    const printers = domain.configuredPrintersFor(
      configuration.config,
      'bill',
      bridge.workstation?.id
    );
    if (!printers.length)
      throw new Error('No Bill printer is assigned to this computer. Check Orders → Operations.');
    const batch = crypto.randomUUID();
    const results = await Promise.allSettled(
      printers.map(async (printer) => {
        const result = await fetch(`${origin}/v1/print-bill`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            printJobId: `register-bill:${batch}:${printer.id}`,
            printerName: printer.deviceName,
            workstationId: printer.workstationId || bridge.workstation?.id,
            order,
            settings: domain.printerFormat(printer, 'bill'),
          }),
        });
        const body = await result.json().catch(() => ({}));
        if (!result.ok || result.status === 202 || body.pending)
          throw new Error(body.error || 'Printing is pending or unavailable.');
      })
    );
    if (results.some((result) => result.status === 'rejected'))
      throw new Error(
        'Receipt printing needs attention. Check assigned Bill printers before reprinting; a copy may already exist.'
      );
    return;
  }
  $('#bill-content').innerHTML =
    `<div class=bill><h2>Bill #${escapeHtml(order.daily_order_number)}</h2><p>${escapeHtml(order.mode === 'table' ? `Table ${order.table_number || ''}` : order.customer_phone || 'Counter parcel')} · ${escapeHtml(order.customer_name || 'Counter Pick')}</p><div class=bill-items>${(order.items || []).map((i) => `<div class=bill-item><span>${escapeHtml(savedItemLabel(i))}</span><b>${money(savedItemTotal(i))}</b></div>`).join('')}</div><div class=bill-total><span><span>GST</span><span>Included</span></span><span><b>Total</b><b>${money(order.total)}</b></span></div><button class=reprint-receipt data-reprint="${escapeHtml(id)}">⎙ Reprint Receipt Only</button></div>`;
  $('#bill-modal').showModal();
}
let paymentOrder = null,
  paymentType = '',
  paymentSplit = false;
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
          !Number.isFinite(row.amount) ||
          row.amount <= 0 ||
          (paidPaymentTypes.has(row.type) &&
            (!Number.isFinite(row.received) || row.received < row.amount)) ||
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
  if (!Number.isFinite(received) || received < due) {
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
  const order = orders.find((o) => String(o.id) === String(id));
  if (!order) return;
  paymentOrder = order;
  paymentSplit = type === 'split';
  paymentType = paymentSplit ? '' : type;
  document.getElementById('payment-title').textContent = paymentSplit
    ? 'Split payment'
    : `${paymentName(paymentType)} payment`;
  document.getElementById('payment-order').textContent =
    `${order.mode === 'table' ? `Table ${String(order.table_number || '').padStart(2, '0')}` : 'Parcel'} · Bill #${String(order.daily_order_number || '').padStart(2, '0')}`;
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
  if (!paymentOrder) return;
  const received = Number(document.getElementById('payment-received').value || 0),
    payments = paymentSplit
      ? splitPaymentRows().map((row) => ({
          paymentType: row.type,
          amount: row.amount,
          paymentReceived: paidPaymentTypes.has(row.type) ? row.received : 0,
        }))
      : null,
    confirm = document.getElementById('payment-confirm');
  confirm.disabled = true;
  confirm.textContent = 'Saving securely…';
  try {
    const response = await fetch(`/api/orders/${encodeURIComponent(paymentOrder.id)}/settle`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Settlement-Id': `register-${paymentOrder.id}-${Date.now()}`,
        },
        body: JSON.stringify(
          paymentSplit
            ? { payments }
            : {
                paymentType,
                amount: Number(paymentOrder.total || 0),
                paymentReceived: received,
              }
        ),
      }),
      data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Payment could not be saved.');
    document.getElementById('payment-modal').close();
    paymentOrder = null;
    await load();
  } finally {
    confirm.disabled = false;
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
async function printSummary() {
  const chosenDay = document.getElementById('summary-date').value,
    response = await fetch(
      `/api/register/summary${chosenDay ? `?date=${encodeURIComponent(chosenDay)}` : ''}`,
      { cache: 'no-store' }
    ),
    data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Unable to prepare the register summary.');
  const rows = Array.isArray(data.orders) ? data.orders : [],
    rowsWithPayments = rows.map((order) => {
      const payments =
          Array.isArray(order.payments) && order.payments.length
            ? order.payments
            : [legacyPayment(order)],
        orderCollected = payments.reduce(
          (sum, payment) => sum + Number(payment.collectedAmount || 0),
          0
        );
      return { order, payments, orderCollected };
    }),
    sales = rows.reduce((sum, order) => sum + Number(order.total || 0), 0),
    collected = rowsWithPayments.reduce((sum, row) => sum + row.orderCollected, 0),
    tips = rows.reduce((sum, order) => sum + Number(order.tip_amount || 0), 0),
    popup = window.open('', 'red-lantern-register-summary', 'popup=yes,width=1100,height=720');
  if (!popup) throw new Error('Allow pop-ups to print the register summary.');
  popup.document.write(
    `<!doctype html><title>Register summary</title><style>body{font:12px Arial;padding:22px;color:#111}h1,p{margin:0 0 7px}table{width:100%;border-collapse:collapse;margin-top:18px}th,td{padding:8px;text-align:left;border-bottom:1px solid #ddd}th{font-size:10px;text-transform:uppercase;background:#f3f3f3}.right{text-align:right}.total{margin-top:18px;font-size:14px;font-weight:bold}</style><h1>Red Lantern Restaurant — Register Summary</h1><p>Date: ${escapeHtml(data.day || '')}</p><table><thead><tr><th>Bill</th><th>Type</th><th>Table / Parcel</th><th>Customer</th><th>Payment allocation</th><th class=right>Bill total</th><th class=right>Collected</th><th class=right>Due</th><th class=right>Change</th><th class=right>Tip</th></tr></thead><tbody>${rowsWithPayments.map(({ order, payments, orderCollected }) => `<tr><td>#${escapeHtml(order.daily_order_number)}</td><td>${order.mode === 'table' ? 'Dine-in' : 'Parcel'}</td><td>${escapeHtml(order.mode === 'table' ? `Table ${String(order.table_number || '').padStart(2, '0')}` : order.customer_phone || 'Walk-in')}</td><td>${escapeHtml(order.customer_name || 'Walk-in customer')}</td><td>${escapeHtml(payments.map((payment) => `${paymentName(payment.paymentType)} ${money(payment.appliedAmount)}`).join(' + '))}</td><td class=right>${money(order.total)}</td><td class=right>${money(orderCollected)}</td><td class=right>${money(Math.max(0, Number(order.total || 0) - orderCollected))}</td><td class=right>${money(order.change_due)}</td><td class=right>${money(order.tip_amount)}</td></tr>`).join('') || '<tr><td colspan=10>No completed payments for this date.</td></tr>'}</tbody></table><p class=total>Sales: ${money(sales)} &nbsp; | &nbsp; Collected: ${money(collected)} &nbsp; | &nbsp; Outstanding: ${money(Math.max(0, sales - collected))} &nbsp; | &nbsp; Tips: ${money(tips)}</p><script>onload=()=>print()<\/script>`
  );
  popup.document.close();
}
async function acceptOrder(id) {
  const response = await fetch(`/api/orders/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'accepted' }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Order could not be accepted.');
  await load();
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
      orders = orders.filter((o) => String(o.id) !== target.dataset.clear);
      render();
    }
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
      await fetch('/api/orders/session', { method: 'DELETE' });
      window.location.replace('/staff-login?next=%2Fregister');
    }
    if (target.closest('.payment-close,.payment-cancel'))
      document.getElementById('payment-modal').close();
  } catch (error) {
    let notice = document.getElementById('register-service-notice');
    if (!notice) {
      notice = document.createElement('p');
      notice.id = 'register-service-notice';
      notice.setAttribute('role', 'status');
      (document.querySelector("dialog[open]") || document.body).prepend(notice);
    }
    notice.textContent = error.message;
  }
});
$('.modal-close').addEventListener('click', () => $('#bill-modal').close());
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
