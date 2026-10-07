// Captain tools share the authenticated session, order access and offline journal.
(() => {
  const Staff = window.RedLanternStaff;
  const sheet = document.createElement('dialog');
  sheet.id = 'captain-tool-sheet';
  sheet.className = 'captain-tool-sheet';
  sheet.setAttribute('aria-labelledby', 'captain-tool-title');
  sheet.innerHTML = '<form id="captain-tool-form"><header><h2 id="captain-tool-title"></h2><button type="button" data-close-tool aria-label="Close service tool">×</button></header><div id="captain-tool-content"></div><p id="captain-tool-error" role="status" aria-live="polite"></p><footer><button type="button" data-close-tool>Close</button><button type="submit" id="captain-tool-save">Save</button></footer></form>';
  document.body.append(sheet);
  let saveAction = null, printerOptions = [], waiterDirectory = [], waiterLoading = false;
  const waiterWrap = document.createElement('label');
  waiterWrap.className = 'captain-kot-waiter';
  waiterWrap.hidden = true;
  waiterWrap.innerHTML = 'Assign waiter to this KOT<select id="captain-kot-waiter"><option value="">Current captain</option></select>';
  $('#review-screen .guest-details').after(waiterWrap);
  async function api(path, method = 'GET', body) {
    if (!state.captain) throw new Error('Sign in to use this tool.');
    if (!navigator.onLine) throw new Error('Connect to the server to use this tool. Offline orders remain in Unsuccessful KOTs.');
    const response = await fetchWithTimeout(path, { method, cache: 'no-store', headers: { ...captainHeaders(), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const data = await response.json().catch(() => ({}));
    if (response.status === 401) { signOut('Your session expired. Sign in again.'); throw new Error('Sign in again.'); }
    if (!response.ok) throw new Error(data.error || 'Unable to complete this action.');
    return data;
  }
  function open(title, content, action = null, buttonLabel = 'Save') {
    $('#captain-tool-title').textContent = title;
    $('#captain-tool-content').innerHTML = content;
    $('#captain-tool-error').textContent = '';
    $('#captain-tool-save').hidden = !action;
    $('#captain-tool-save').textContent = buttonLabel;
    saveAction = action;
    if (!sheet.open) sheet.showModal();
  }
  sheet.querySelectorAll('[data-close-tool]').forEach(button => button.addEventListener('click', () => sheet.close()));
  $('#captain-tool-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (!saveAction) return;
    const button = $('#captain-tool-save');
    button.disabled = true;
    try { await saveAction(new FormData(event.target)); sheet.close(); await load(); showCaptainToast('Changes saved.', 'success'); }
    catch (error) { $('#captain-tool-error').textContent = error.message; }
    finally { button.disabled = false; }
  });
  const reason = required => `<label>Reason<textarea name="reason" minlength="3" maxlength="240" ${required ? 'required' : ''} placeholder="Explain this change for the audit log"></textarea></label>`;
  const tools = [ ['sync','Sync data','Refresh tables, menu and failed orders'], ['menu','Update menu','Get the latest items, prices and availability'], ['unsuccessful','Unsuccessful KOTs','Review saved orders and retry failed tickets'], ['pending','Pending bills','Generated or requested bills awaiting payment'], ['server','Server connection','Check the server address and connectivity'], ['notifications','Notifications','Enable kitchen alerts on this device'], ['printers','Printer settings','Kitchen queues and paper formats'], ['preferences','App settings','View the settings assigned by your administrator'] ];
  $('#captain-open-tools').addEventListener('click', () => {
    document.querySelector('button[data-captain-nav-close]')?.click();
    open('Service tools', `<div class="captain-tool-list">${tools.map(([key,label,detail]) => `<button type="button" data-service-tool="${key}"><b>${label}</b><small>${detail}</small><span>›</span></button>`).join('')}</div>`);
  });
  window.applyCaptainToolsUI = () => {
    $('#captain-voice-search').hidden = !captainSettings().speechSearch;
    waiterWrap.hidden = !captainSettings().waiterAssignment || !captainAllowed('assignTables');
    if (!waiterWrap.hidden && navigator.onLine && !waiterLoading) {
      waiterLoading = true;
      api('/api/staff/employees').then(data => { waiterDirectory = data.employees || []; updateWaiters(); }).catch(() => {}).finally(() => { waiterLoading = false; });
    }

    document.querySelectorAll('[data-captain-table-action="manage"]').forEach(button => { button.textContent = 'Order actions & payments'; });
  };
  function updateWaiters() {
    const selected = $('#captain-kot-waiter').dataset.draftWaiter || $('#captain-kot-waiter').value;
    $('#captain-kot-waiter').innerHTML = '<option value="">Current captain</option>' + waiterDirectory.filter(employee => employee.tableService && (!employee.areas.length || employee.areas.includes(state.table?.area))).map(employee => `<option value="${esc(employee.id)}">${esc(employee.name)}</option>`).join('');
    if ([...$('#captain-kot-waiter').options].some(option => option.value === selected)) $('#captain-kot-waiter').value = selected;
    delete $('#captain-kot-waiter').dataset.draftWaiter;
  }
  $('#captain-kot-waiter').addEventListener('change', saveDraft);
  const baseSetScreen = setScreen;
  setScreen = function(screen) { baseSetScreen(screen); if (screen === 'review') updateWaiters(); };
  window.openCaptainAddTable = () => open('Add a new table', `<p>Add the next table number to an assigned dining area.</p><label>Dining area<select name="area" required>${state.areas.map(area => `<option value="${esc(area.name)}">${esc(area.name)}</option>`).join('')}</select></label>`, async form => {
    if (!captainAllowed('addTables')) throw new Error('Adding tables is not enabled for your account.');
    await api('/api/orders/operations/add-table','POST',{area:form.get('area')});
  }, 'Add table');
  window.openCaptainGuestDetails = () => open('Guest details', '<p>Optional guest details for this order.</p><label>Name<input name="name" maxlength="80" autocomplete="name"></label><label>Mobile<input name="phone" type="tel" maxlength="16" autocomplete="tel"></label>', async form => {
    $('#customer-name').value = form.get('name'); $('#customer-phone').value = form.get('phone'); saveDraft();
  }, 'Continue to menu');
  window.openCaptainOrderTools = order => {
    const grants = [['edit','editOrders','Edit KOT items'],['cancel','cancelOrders','Cancel order and KOTs'],['pay','takePayments','Collect payment'],['discount','applyDiscounts','Dine-in discount'],['special','specialDiscounts','Special discount'],['assign','assignTables','Assign waiter'],['priority','setPriority','Set priority']];
    open(`${order.mode === 'table' ? `${order.table_area} · Table ${order.table_number}` : 'Order'} · ${money(order.total)}`, `<p>Order #${esc(order.daily_order_number || order.id)} · ${esc(order.status)}</p><div class="captain-tool-list">${grants.filter(([key,right]) => captainAllowed(right) && (!['discount','special','assign'].includes(key) || order.mode === 'table') && (key !== 'assign' || captainSettings().waiterAssignment) && (key !== 'priority' || captainSettings().enablePriority)).map(([key,,label]) => `<button type="button" data-native-order-action="${key}" data-native-order="${esc(order.id)}"><b>${label}</b><span>›</span></button>`).join('')}</div>`);
  };
  async function orderAction(order, action) {
    const base = `/api/orders/${encodeURIComponent(order.id)}`;
    if (action === 'edit') open('Edit KOT items', `<p>Set quantity to zero to remove an item. Already printed tickets remain in the audit history.</p>${(order.items || []).map((item,index) => `<label>${esc(item.name)} ${esc(item.portion || '')}<input type="number" name="q-${index}" min="0" max="20" step="1" value="${Number(item.quantity)}" required></label>`).join('')}${reason(state.captain.requireEditReason !== false)}`, form => api(`${base}/items`, 'PATCH', { quantities: order.items.map((_,index) => Number(form.get(`q-${index}`))), reason: form.get('reason'), expectedUpdatedAt: order.updated_at }));
    if (action === 'cancel') open('Cancel order and KOTs', `<p>This cancels the entire order and its kitchen tickets.</p>${reason(true)}`, form => api(base,'PATCH',{status:'cancelled',reason:form.get('reason')}), 'Confirm cancellation');
    if (action === 'pay') {
      const paymentRequestId = crypto.randomUUID();
      open('Collect payment', `<p>Amount due: <b>${money(order.total)}</b></p><label>Payment method<select name="method"><option value="cash">Cash</option><option value="upi">UPI</option><option value="card">Card</option></select></label><label>Amount received<input type="number" name="received" min="${Number(order.total)}" step="0.01" value="${Number(order.total)}" required></label>`, form => api(`${base}/settle`, 'POST', { requestId: paymentRequestId, paymentType:form.get('method'),amount:Number(order.total),paymentReceived:Number(form.get('received')) }), 'Settle payment');
    }
    if (['discount','special'].includes(action)) {
      const policy = state.captain.discountLimit || { type:'fixed',value:0 };
      open(action === 'special' ? 'Special dine-in discount' : 'Dine-in discount', `<p>Assigned limit: <b>${policy.type === 'percent' ? `${Number(policy.value)}%` : money(policy.value)}</b>. Special discounts use the same approved limit.</p><label>Type<select name="type"><option value="fixed">Amount (₹)</option><option value="percent">Percentage (%)</option></select></label><label>Value<input name="value" type="number" min="0" step="0.01" required></label>${reason(true)}`, form => api(`${base}/discount`, 'POST', {type:form.get('type'),value:Number(form.get('value')),reason:form.get('reason'),special:action === 'special'}));
    }
    if (action === 'assign') {
      const directory = (await api('/api/staff/employees')).employees || [];
      const eligible = directory.filter(employee => employee.tableService && (!employee.areas.length || employee.areas.includes(order.table_area)));
      if (!eligible.length) throw new Error('No eligible waiter is assigned to this dining area.');
      open('Assign waiter', `<p>This waiter receives the table and its kitchen tickets.</p><label>Waiter<select name="employee">${eligible.map(employee => `<option value="${esc(employee.id)}">${esc(employee.name)}</option>`).join('')}</select></label>`, form => api(`${base}/assignment`, 'POST', {employeeId:form.get('employee')}));
    }
    if (action === 'priority') open('Order priority', '<p>Urgent orders receive higher priority in Smart KDS. Kitchen timing and capacity rules still apply.</p><label>Priority<select name="priority"><option value="normal">Normal</option><option value="urgent">Urgent</option></select></label>', form => api(`${base}/priority`, 'POST', {priority:form.get('priority')}));
  }
  async function serviceTool(key) {
    if (['sync','menu'].includes(key)) {
      $('#captain-tool-error').textContent = 'Syncing with the server…';
      await api('/api/staff/session');
      if (!(await load())) throw new Error('The live menu or table data could not be refreshed. Check the connection and retry.');
      if (key === 'sync') await flushPending();
      $('#captain-tool-error').textContent = state.pendingError || (key === 'menu' ? 'Menu and availability refreshed.' : 'Data synced. Orders needing review remain in Unsuccessful KOTs.');
    }
    if (key === 'unsuccessful') open('Unsuccessful KOTs', `<p>Orders waiting for the server and saved orders whose kitchen ticket failed. Review conflicts before merging.</p><div class="pending-sync-list">${state.pending.map((entry,index) => pendingOrderCard(entry,index)).join('') || '<p>No unsuccessful KOTs or queued orders.</p>'}</div>${state.pending.length ? '<button type="button" data-sync-pending>Retry sync now</button>' : ''}`);
    if (key === 'pending') {
      await load();
      const bills = state.orders.filter(order => order.mode === 'table' && order.captain_accessible !== false && Staff.orderAccessible(state.captain,order) && ['saved','held','accepted','preparing','ready'].includes(order.status) && (order.bill_printed_at || order.service_state === 'bill_requested'));
      open('Pending bills', `<p>Unpaid tables with a generated or requested bill.</p><div class="captain-tool-list">${bills.map(order => `<button type="button" data-native-order="${esc(order.id)}"><b>${esc(order.table_area)} · Table ${order.table_number}</b><small>${money(order.total)} · ${order.bill_printed_at ? 'Bill generated' : 'Bill requested'}</small><span>›</span></button>`).join('') || '<p>No pending bills in your assigned access.</p>'}</div>`);
    }
    if (key === 'server') {
      open('Server connection', `<p>Configured server address</p><code>${esc(location.origin)}</code><p>The app uses this server for menu, KOT and payment requests. For a local server, its host appears in this address; hosted installations do not use a restaurant LAN IP.</p><p id="captain-server-result">Checking authenticated connection…</p>`);
      const started = performance.now();
      await api('/api/staff/session');
      $('#captain-server-result').textContent = `Connected · ${Math.round(performance.now()-started)} ms`;
    }
    if (key === 'notifications') {
      if (!('Notification' in window)) throw new Error('This browser does not support system notifications. Kitchen updates still appear in the app.');
      const permission = await Notification.requestPermission();
      open('Kitchen notifications', `<p>Device permission: <b>${esc(permission)}</b></p><p>Restaurant setting: <b>${esc(captainSettings().notifications)}</b>. Item alerts require Smart KDS item readiness; KOT alerts use the kitchen ticket status.</p><p>${permission === 'denied' ? 'Enable notifications in the browser or device settings to receive system alerts.' : 'Keep this app open for live kitchen updates. Notifications follow your assigned order access.'}</p>`);
    }
    if (key === 'preferences') open('Captain App settings', `<p>Configured by your administrator.</p>${Object.entries(Staff.captainSettingGroups).map(([group, settings]) => `<h3>${esc(group)}</h3><dl>${Object.entries(settings).map(([setting,label]) => `<div><dt>${esc(label)}</dt><dd>${captainSettings()[setting] ? 'On' : 'Off'}</dd></div>`).join('')}</dl>`).join('')}<p>Item order: ${captainSettings().itemSort === 'az' ? 'A–Z' : 'Popularity'} · Notifications: ${esc(captainSettings().notifications)}</p>`);
    if (key === 'printers') {
      const data = await api('/api/captain/printers');
      printerOptions = data.printers || [];
      open('Kitchen printers', `<p>Bluetooth printers must be paired with the print bridge computer and installed as a system printer queue. Paper and cutter behavior use that printer’s driver.</p>${(data.printers || []).map(printer => `<article class="captain-printer"><b>${esc(printer.name || printer.deviceName)}</b><p>${esc(printer.deviceName)} · ${Number(printer.paperWidth) === 58 ? '2 inch / 58 mm' : '3 inch / 80 mm'}</p><small>${esc(printer.workstationName || 'Print bridge')} · Serial numbers ${printer.showItemSerial ? 'on' : 'off'}</small>${captainAllowed('operationsManage') ? `<button type="button" data-edit-kitchen-printer="${esc(printer.id)}">Edit format</button>` : ''}</article>`).join('') || '<p>No kitchen printer configured. Ask an administrator to configure Orders → Operations.</p>'}<p>Custom forms and automatic cutting are configured in the system printer driver.</p>`);
    }
  }
  sheet.addEventListener('click', async event => {
    const tool = event.target.closest('[data-service-tool]');
    const printerButton = event.target.closest('[data-edit-kitchen-printer]');
    const orderButton = event.target.closest('[data-native-order]');
    const pendingButton = event.target.closest('[data-sync-pending], [data-recover-pending], [data-retry-pending-kot], [data-accept-pending], [data-discard-pending]');
    try {
      if (printerButton) {
        const printer = printerOptions.find(entry => entry.id === printerButton.dataset.editKitchenPrinter);
        if (!printer || !captainAllowed('operationsManage')) throw new Error('Printer configuration is not enabled.');
        open(`Format · ${printer.name || printer.deviceName}`, '<label>Paper width<select name="width"><option value="58">2 inch / 58 mm</option><option value="80">3 inch / 80 mm</option></select></label><label class="captain-tool-check"><input type="checkbox" name="serial"> Print item serial numbers</label><p>Use the printer driver for custom paper forms and cutter settings.</p>', form => api(`/api/captain/printers/${encodeURIComponent(printer.id)}`,'PATCH',{paperWidth:Number(form.get('width')),showItemSerial:form.has('serial')}));
        sheet.querySelector('[name="width"]').value = String(Number(printer.paperWidth) === 58 ? 58 : 80);
        sheet.querySelector('[name="serial"]').checked = !!printer.showItemSerial;
      }
      if (tool) { tool.disabled = true; await serviceTool(tool.dataset.serviceTool); }
      if (orderButton) {
        const order = state.orders.find(order => order.id === orderButton.dataset.nativeOrder);
        if (!order || !Staff.orderAccessible(state.captain,order)) throw new Error('This order changed or is outside your access. Refresh the table board.');
        if (orderButton.dataset.nativeOrderAction) await orderAction(order,orderButton.dataset.nativeOrderAction);
        else window.openCaptainOrderTools(order);
      }
      if (pendingButton) {
        if (pendingButton.matches('[data-sync-pending], [data-retry-pending-kot]')) await flushPending();
        else { handlePendingAction(event); sheet.close(); }
        if (sheet.open) serviceTool('unsuccessful');
      }
    } catch (error) { $('#captain-tool-error').textContent = error.message; }
    finally { if (tool?.isConnected) tool.disabled = false; }
  });
  let recognition;
  $('#captain-voice-search').addEventListener('click', () => {
    const Speech = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Speech) return showCaptainToast('Voice search is unavailable in this browser. Use the search field.', 'error');
    if (recognition) return recognition.stop();
    recognition = new Speech();
    recognition.lang = 'en-IN';
    recognition.interimResults = false;
    recognition.onresult = event => { $('#menu-search').value = event.results[0][0].transcript; renderMenu(); };
    recognition.onerror = () => showCaptainToast('Voice search could not hear you. Check microphone access or type your search.', 'error');
    recognition.onend = () => { recognition = null; $('#captain-voice-search').textContent = '🎙'; };
    $('#captain-voice-search').textContent = '■';
    try { recognition.start(); } catch { recognition = null; showCaptainToast('Unable to start voice search.', 'error'); }
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) recognition?.stop(); });
  window.applyCaptainToolsUI();
})();
