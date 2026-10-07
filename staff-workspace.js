(() => {
  const Staff = window.RedLanternStaff;
  const $ = (selector) => document.querySelector(selector);
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const money = (value) => `₹${Number(value || 0).toFixed(2)}`;
  let employee, orders = [], directory = [], menu = [], unavailable = new Set(), saveAction;
  const can = (right) => Staff.can(employee, right);
  async function api(url, method = 'GET', body) {
    const response = await fetch(url, { method, cache: 'no-store', headers: body ? { 'Content-Type': 'application/json' } : {}, ...(body ? { body: JSON.stringify(body) } : {}) });
    const data = await response.json().catch(() => ({}));
    if (response.status === 401) { location.replace('/staff-login?next=%2Fstaff'); throw new Error('Sign in again.'); }
    if (!response.ok) throw new Error(data.error || 'Unable to complete this action.');
    return data;
  }
  function dialog(title, fields, action) {
    $('#staff-action-title').textContent = title;
    $('#staff-action-fields').innerHTML = fields;
    $('#staff-action-error').textContent = '';
    saveAction = action;
    $('#staff-action-dialog').showModal();
  }
  const reasonField = (required = true) => `<label>Reason<textarea name="reason" minlength="3" maxlength="240" ${required ? 'required' : ''}></textarea></label>`;
  function renderOrders() {
    const focus = new URLSearchParams(location.search).get('order');
    const visible = orders.filter((order) => Staff.orderAccessible(employee, order) && (can('readHistory') || !['cancelled','rejected'].includes(order.status)));
    $('#staff-orders-title').textContent = employee.role === 'delivery' ? 'Assigned deliveries' : employee.role === 'online_acceptance' ? 'Incoming QR orders' : 'Orders in your access';
    $('#staff-order-list').innerHTML = visible.map((order) => {
      const active = ['saved','held','accepted','preparing','ready'].includes(order.status);
      const name = order.mode === 'table' ? `${order.table_area} · Table ${String(order.table_number).padStart(2,'0')}` : order.fulfillment_type === 'delivery' ? 'Delivery' : 'Pickup / takeaway';
      const button = (action, label, extra = '') => `<button type="button" data-order-action="${action}" data-order="${esc(order.id)}" ${extra}>${label}</button>`;
      const buttons = [];
      if (can('acceptOrders') && order.status === 'new') buttons.push(button('accept','Accept','class="primary"'), button('reject','Reject','class="danger"'));
      if (can('editOrders') && (active || order.status === 'new')) buttons.push(button('edit','Edit items / KOT'));
      if (can('cancelOrders') && (active || order.status === 'new')) buttons.push(button('cancel','Cancel order / KOT','class="danger"'));
      if (can('assignTables') && active && order.mode === 'table') buttons.push(button('assign','Assign Captain / waiter'));
      if (can('manageDeliveries') && order.fulfillment_type === 'delivery' && !['picked_up','delivered'].includes(order.delivery_status) && !['cancelled','rejected','completed'].includes(order.status)) buttons.push(button('assign-delivery','Assign delivery staff'));
      if (can('fulfillDeliveries') && order.delivery_employee_id === employee.id && order.delivery_status === 'assigned' && ['ready','completed'].includes(order.status)) buttons.push(button('pickup','Picked up','class="primary"'));
      if (can('fulfillDeliveries') && order.delivery_employee_id === employee.id && order.delivery_status === 'picked_up') buttons.push(button('delivered','Delivered','class="primary"'));
      if (can('takePayments') && ['accepted','preparing','ready'].includes(order.status)) buttons.push(button('pay','Collect payment'));
      if (can('applyDiscounts') && active && order.mode === 'table') buttons.push(button('discount','Apply discount'));
      if (can('viewKots')) buttons.push(button('kots','View KOTs'));
      if (can('requestBills') && active && order.mode === 'table' && can('captainApp')) buttons.push(button('bill','Request bill printing'));
      const assigned = directory.find((entry) => entry.id === (order.mode === 'table' ? order.employee_assigned_id : order.delivery_employee_id));
      return `<article class="order-card ${focus === order.id ? 'is-focused' : ''}"><div class="order-heading"><h3>Order #${String(order.daily_order_number || '').padStart(2,'0')}</h3><small>${esc(order.status)}</small></div><p><b>${esc(name)}</b></p><p class="meta">${esc(order.customer_name || 'Walk-in guest')}${order.customer_phone && !order.customer_phone.startsWith('walkin-') ? ` · <a href="tel:${esc(order.customer_phone)}">${esc(order.customer_phone)}</a>` : ''}</p>${assigned ? `<p class="meta">Assigned to ${esc(assigned.name)}</p>` : ''}${order.fulfillment_type === 'delivery' ? `<p class="meta">Delivery: ${esc((order.delivery_status || 'unassigned').replaceAll('_',' '))}</p>` : ''}<ul>${(order.items || []).map((item) => `<li>${Number(item.quantity)} × ${esc(item.name)} ${esc(item.portion || '')}</li>`).join('')}</ul>${order.special_request ? `<p class="meta">${esc(order.special_request)}</p>` : ''}<p class="order-total">${money(order.total)}</p>${Number(order.discount_amount) ? `<p class="meta">Discount ${money(order.discount_amount)} · ${esc(order.discount_reason)}</p>` : ''}<div class="order-actions">${buttons.join('')}</div></article>`;
    }).join('') || '<p class="empty">No orders in your assigned access right now.</p>';
  }
  async function load() {
    try {
      const session = await api('/api/staff/session');
      if (!session.employee) { location.replace('/orders'); return; }
      employee = session.employee;
      $('#staff-name').textContent = employee.name;
      $('#staff-role').textContent = Staff.roles[employee.role].label;
      $('#staff-scope').textContent = employee.role === 'delivery' ? 'Only deliveries assigned to your account are available.' : employee.areas.length ? `Assigned areas: ${employee.areas.join(' · ')}` : employee.tableScope === 'own' ? 'Orders opened by or assigned to you.' : 'All permitted orders.';
      $('#staff-workspaces').innerHTML = [['captainApp','/captain','Captain app'],['billingConsole','/orders','Orders'],['register','/register','Register'],['kitchenDisplay','/kds','Kitchen']].filter(([right]) => can(right)).map(([,url,label]) => `<a href="${url}">${label}</a>`).join('');
      orders = await api('/api/orders');
      if (can('assignTables') || can('manageDeliveries')) directory = (await api('/api/staff/employees')).employees || [];
      $('#staff-store-controls').hidden = !can('storeToggle');
      if (can('storeToggle')) $('#staff-store-open').checked = (await api('/api/staff/store')).open;
      $('#staff-table-controls').hidden = !can('addTables');
      if (can('addTables')) {
        const data = await api('/api/orders/operations?configOnly=1');
        $('#staff-new-table-area').innerHTML = (data.config?.tableAreas || []).filter((area) => !employee.areas.length || employee.areas.includes(area.name)).map((area) => `<option value="${esc(area.name)}">${esc(area.name)}</option>`).join('');
      }
      $('#staff-item-controls').hidden = !can('itemToggle');
      if (can('itemToggle')) {
        menu = await api('/api/orders/menu');
        unavailable = new Set((await api('/api/orders/availability')).map((row) => row.item_key));
        renderItems();
      }
      renderOrders();
      $('#staff-status').textContent = new URLSearchParams(location.search).has('denied') ? 'That workspace is not enabled for your account. Your available work is shown here.' : '';
    } catch (error) { $('#staff-status').textContent = error.message; }
  }
  function renderItems() {
    const search = $('#staff-item-search').value.toLowerCase();
    $('#staff-items').innerHTML = menu.filter((item) => `${item.name} ${item.category}`.toLowerCase().includes(search)).map((item) => `<label class="availability-item"><span>${esc(item.name)}<small> · ${esc(item.category)}</small></span><input type="checkbox" data-availability-key="${esc(item.key)}" ${unavailable.has(item.key) ? '' : 'checked'} aria-label="${esc(item.name)} available"></label>`).join('');
  }
  $('#staff-item-search').addEventListener('input', renderItems);
  $('#staff-items').addEventListener('change', async (event) => {
    const input = event.target.closest('[data-availability-key]'); if (!input) return;
    input.disabled = true;
    try { await api(`/api/orders/availability/${encodeURIComponent(input.dataset.availabilityKey)}`, input.checked ? 'DELETE' : 'PUT', input.checked ? undefined : { unavailableUntil: new Date(Date.now() + 24*60*60*1000).toISOString() }); }
    catch (error) { input.checked = !input.checked; $('#staff-status').textContent = error.message; }
    finally { input.disabled = false; }
  });
  $('#staff-store-open').addEventListener('change', async (event) => {
    event.target.disabled = true;
    try { await api('/api/staff/store', 'PATCH', { open: event.target.checked }); }
    catch (error) { event.target.checked = !event.target.checked; $('#staff-status').textContent = error.message; }
    finally { event.target.disabled = false; }
  });
  $('#staff-add-table').addEventListener('click', async () => {
    try { const result = await api('/api/orders/operations/add-table', 'POST', { area: $('#staff-new-table-area').value }); $('#staff-status').textContent = `Table ${result.tableNumber} added.`; }
    catch (error) { $('#staff-status').textContent = error.message; }
  });
  $('#staff-order-list').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-order-action]'); if (!button) return;
    const order = orders.find((entry) => entry.id === button.dataset.order); if (!order) return;
    const base = `/api/orders/${encodeURIComponent(order.id)}`, action = button.dataset.orderAction;
    try {
      if (action === 'accept') { await api(base,'PATCH',{status:'accepted'}); await load(); return; }
      if (['pickup','delivered'].includes(action)) { await api(`${base}/delivery-progress`,'POST',{status:action === 'pickup' ? 'picked_up' : 'delivered'}); await load(); return; }
      if (['cancel','reject'].includes(action)) dialog(action === 'cancel' ? 'Cancel order and KOTs' : 'Reject incoming order', reasonField(), (form) => api(base,'PATCH',{status:action === 'cancel' ? 'cancelled' : 'rejected',reason:form.get('reason')}));
      if (action === 'edit') dialog('Edit order / KOT items', (order.items || []).map((item,index) => `<label class="edit-item">${esc(item.name)} ${esc(item.portion || '')}<input type="number" name="quantity-${index}" value="${Number(item.quantity)}" min="0" max="20" step="1" required></label>`).join('') + reasonField(employee.requireEditReason !== false), (form) => api(`${base}/items`,'PATCH',{ quantities: order.items.map((_,index) => Number(form.get(`quantity-${index}`))), reason:form.get('reason'), expectedUpdatedAt: order.updated_at }));
      if (['assign','assign-delivery'].includes(action)) {
        const candidates = directory.filter((entry) => action === 'assign' ? entry.tableService && (!entry.areas.length || entry.areas.includes(order.table_area)) : entry.delivery);
        if (!candidates.length) throw new Error('Create an active employee with the relevant workspace access in Admin → Captain App & Employees first.');
        dialog(action === 'assign' ? 'Assign table service' : 'Assign delivery staff', `<label>Employee<select name="employee">${candidates.map((entry) => `<option value="${esc(entry.id)}">${esc(entry.name)} · ${esc(Staff.roles[entry.role].label)}</option>`).join('')}</select></label>`, (form) => api(`${base}/${action === 'assign' ? 'assignment' : 'delivery-assignment'}`,'POST',{employeeId:form.get('employee')}));
      }
      if (action === 'pay') dialog('Collect payment', `<p>Amount due: <b>${money(order.total)}</b></p><label>Method<select name="method"><option value="cash">Cash</option><option value="upi">UPI</option><option value="card">Card</option></select></label><label>Amount received<input name="received" type="number" min="${Number(order.total)}" step="0.01" value="${Number(order.total)}" required></label>`, (form) => api(`${base}/settle`,'POST',{requestId:crypto.randomUUID(),paymentType:form.get('method'),amount:Number(order.total),paymentReceived:Number(form.get('received'))}));
      if (action === 'discount') dialog('Apply dine-in discount', `<p>Your limit: ${employee.discountLimit.type === 'percent' ? `${employee.discountLimit.value}%` : money(employee.discountLimit.value)}</p><label>Type<select name="type"><option value="fixed">Amount (₹)</option><option value="percent">Percentage (%)</option></select></label><label>Value<input name="value" type="number" min="0" step="0.01" required></label>${reasonField()}`, (form) => api(`${base}/discount`,'POST',{type:form.get('type'),value:Number(form.get('value')),reason:form.get('reason')}));
      if (action === 'kots') {
        const history = await api(`${base}/kots`);
        dialog('Kitchen order tickets', history.map((kot) => `<p><b>KOT #${Number(kot.kot_number)}</b></p>${(kot.tickets || []).map((ticket) => `<p>${esc(ticket.printerLabel || 'Kitchen')}</p><ul>${(ticket.items || []).map((item) => `<li>${Number(item.quantity)} × ${esc(item.name)}</li>`).join('')}</ul>`).join('')}`).join('') || '<p>No KOTs sent yet.</p>', async () => {});
        $('#staff-action-save').hidden = true;
      } else $('#staff-action-save').hidden = false;
      if (action === 'bill') {
        const proximity = await new Promise((resolve,reject) => navigator.geolocation ? navigator.geolocation.getCurrentPosition((position) => resolve({latitude:position.coords.latitude,longitude:position.coords.longitude,accuracy:position.coords.accuracy}),() => reject(new Error('Allow location to request bill printing.')),{timeout:10000}) : reject(new Error('Location is unavailable.')));
        await api(`/api/captain/orders/${encodeURIComponent(order.id)}/service`,'POST',{serviceState:'bill_requested',proximity});
        $('#staff-status').textContent = 'Bill request sent to the counter for printing.';
      }
    } catch (error) { $('#staff-status').textContent = error.message; }
  });
  $('#staff-action-form').addEventListener('submit', async (event) => {
    event.preventDefault(); const button = $('#staff-action-save'); button.disabled = true;
    try { await saveAction(new FormData(event.target)); $('#staff-action-dialog').close(); await load(); }
    catch (error) { $('#staff-action-error').textContent = error.message; }
    finally { button.disabled = false; }
  });
  $('#staff-action-close').addEventListener('click', () => $('#staff-action-dialog').close());
  $('#staff-refresh').addEventListener('click', load);
  $('#staff-logout').addEventListener('click', async () => { await api('/api/staff/session','DELETE'); sessionStorage.removeItem('red-lantern-captain-session'); localStorage.removeItem('red-lantern-captain-session'); location.replace('/staff-login'); });
  void load();
  setInterval(() => { if (!document.hidden && !$('#staff-action-dialog').open) void load(); }, 15000);
})();
