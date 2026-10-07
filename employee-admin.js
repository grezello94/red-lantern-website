(() => {
  const Staff = window.RedLanternStaff;
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const permissionHelp = {"captainApp": "Opens the Captain / waiter app. Individual action permissions and assigned table access still apply.", "billingConsole": "Opens the Orders and billing console. Printing, editing and payments require their separate permissions.", "register": "Opens the checkout Register. Collecting payments and viewing collection summaries require separate permissions.", "kitchenDisplay": "Opens kitchen displays. Changing preparation status requires Update kitchen preparation status.", "deliveryApp": "Opens the delivery workspace for deliveries assigned to this employee. Updating progress requires its separate permission.", "onlineAcceptance": "Shows incoming online QR orders in the acceptance workspace. Accepting or rejecting them requires the acceptance permission.", "createOrders": "Creates dine-in orders on tables allowed by this employee’s table scope and dining areas.", "pickupOrders": "Creates pickup / takeaway orders. Captain takeaway must also be enabled in restaurant settings.", "deliveryOrders": "Creates delivery orders. Captain home delivery must also be enabled in restaurant settings.", "addRounds": "Adds new items or another round to an accessible active order. Editing existing quantities requires a separate permission.", "viewKots": "Views kitchen order tickets (KOTs) and preparation progress for accessible orders. Does not grant status changes.", "releaseKots": "Sends or reprints kitchen tickets. Captain printing must be enabled; physical output needs configured kitchen printers and the print bridge.", "editOrders": "Changes existing order / KOT item quantities. A reason is required when the reason setting below is enabled.", "cancelOrders": "Cancels accessible orders and their kitchen tickets. This is separate from editing individual item quantities.", "acceptOrders": "Accepts or rejects incoming online orders. Rejecting an already active order also requires cancellation permission.", "updateKitchen": "Updates kitchen preparation progress. Payment settlement and delivery completion use their separate actions.", "markServed": "Marks ready kitchen tickets as served from the Captain app for accessible orders.", "moveTables": "Moves an accessible order to another table. The destination must be within the employee’s allowed dining areas.", "addTables": "Adds a table in an allowed dining area. Does not grant broader printer or routing configuration access.", "requestBills": "Generates, requests or reprints bills for accessible orders. Does not collect payment; printing needs a configured printer and print bridge.", "requestService": "Sends water or assistance requests from the Captain app for accessible tables.", "clearTables": "Clears a settled table after payment so it can be used for the next guest. Does not settle unpaid orders.", "assignTables": "Assigns accessible table orders to eligible active service employees. Area restrictions still apply.", "takePayments": "Collects payment and settles accessible orders using the available payment methods. Register workspace access is a separate permission.", "applyDiscounts": "Applies discounts to active dine-in orders within the maximum discount set below. Requires a nonzero limit and a discount reason.", "specialDiscounts": "Applies special discounts to active dine-in orders. The same assigned maximum and reason requirement apply; this does not bypass the limit.", "readHistory": "Views previous orders and daily collection summaries within the employee’s allowed order access.", "manageDeliveries": "Assigns accessible delivery orders to eligible active delivery employees.", "fulfillDeliveries": "Updates delivery progress for accessible assigned deliveries. Does not grant payment settlement.", "storeToggle": "Opens or closes restaurant-wide online ordering. Existing orders remain available for processing.", "itemToggle": "Changes menu item availability for ordering. This affects restaurant-wide availability, not just this employee.", "setPriority": "Sets an accessible order’s priority. Order priority must also be enabled in Captain App settings.", "operationsManage": "Changes printer configuration, kitchen routing and table allocation. This grants operational configuration access."};
  const styles = document.createElement('style');
  styles.textContent = `.employee-tabs{display:flex;gap:8px;border-bottom:1px solid #e8e0dd;margin-bottom:22px;padding-bottom:10px}.employee-tabs button{padding:10px 16px;border:0;border-radius:10px;background:#f6f3f2;color:#4b5563;font-weight:700}.employee-tabs button[aria-selected=true]{background:#9e1834;color:white}.employee-panel[hidden]{display:none!important}.employee-permission-group{border:1px solid #e8e0dd;border-radius:14px;padding:16px;margin:14px 0}.employee-permission-group h3{margin:0 0 12px;font-size:15px}.employee-permission-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,245px),1fr));gap:14px}.employee-permission-grid label{display:flex;gap:10px;align-items:flex-start;font-size:14px;line-height:1.4}.employee-permission-grid input{width:17px!important;height:17px;margin:2px 0 0;flex:none}.employee-audit-row{padding:14px 0;border-bottom:1px solid #eee;display:grid;grid-template-columns:1fr 1fr;gap:8px}.employee-audit-row small{display:block;color:#64748b;margin-top:5px}.employee-role-description{color:#64748b;font-size:13px}.employee-login-note{padding:12px 16px;background:#faf7f5;border-radius:10px;line-height:1.6}@media(max-width:600px){.employee-audit-row{grid-template-columns:1fr}}`;
  styles.textContent += `
    .captain-account-card{overflow:hidden}
    .captain-account-body{color:#273345}
    .employee-tabs button{min-height:44px;cursor:pointer}
    .captain-account-body :is(button,input,select):focus-visible{outline:3px solid #9e1834;outline-offset:3px}
    .employee-section-intro{margin:0 0 20px}
    .employee-section-intro h3{font-size:17px;margin:0 0 6px}
    .employee-section-intro p{color:#64748b;font-size:14px;line-height:1.6;margin:0;max-width:720px}
    .employee-panel .form-grid{grid-template-columns:repeat(2,minmax(0,1fr));align-items:start}
    .employee-permission-group{background:#fff;padding:20px;margin:18px 0}
    .employee-permission-group h3{padding-bottom:12px;border-bottom:1px solid #f0e9e6;color:#273345}
    .employee-permission-grid{grid-template-columns:repeat(3,minmax(0,1fr));gap:8px 16px}
    .employee-permission-grid label{padding:10px;border-radius:8px;cursor:pointer;min-height:44px;box-sizing:border-box;text-transform:none!important;font-weight:500!important;letter-spacing:normal!important}
    .employee-permission-grid label:hover{background:#faf6f5}
    .employee-permission-grid label:has(input:checked){background:#fcf3f5}
    .captain-account-body input[type=checkbox]{accent-color:#9e1834;width:18px!important;height:18px;flex:none}
    .captain-area-options{min-height:64px;box-sizing:border-box;flex-wrap:wrap}
    .captain-area-options label{min-height:40px;cursor:pointer}
    .employee-panel input[type=number]{width:100%;min-height:44px;box-sizing:border-box;padding:10px 12px;border:1px solid #d9c9c1;border-radius:9px;background:#fff;color:#273345;font:inherit;margin-top:8px}
    .employee-panel :disabled{background:#f3f4f6;color:#64748b;cursor:not-allowed}
    .employee-panel .help-text{line-height:1.5;margin-top:8px}
    .employee-panel label:has([data-employee-reason]){display:flex;gap:10px;align-items:flex-start;text-transform:none;font-size:14px;letter-spacing:normal;line-height:1.5;padding:12px;background:#faf7f5;border-radius:10px}
    .captain-account-body>.btn-delete{margin-top:24px}
    @media(max-width:1100px){.employee-permission-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
    @media(max-width:600px){.employee-panel .form-grid,.employee-permission-grid{grid-template-columns:1fr}.employee-permission-group{padding:14px}.captain-account-body{padding:14px}.employee-tabs button{flex:1}.captain-account-head{flex-wrap:wrap;gap:10px}}
  `;
  styles.textContent += `
    .captain-settings-card .employee-permission-grid .captain-setting-toggle{position:relative;align-items:center;gap:16px;min-height:56px;padding:12px;border:1px solid #eee5e7;border-radius:12px;cursor:pointer}
    .captain-setting-label{flex:1;min-width:0;line-height:1.5}
    .captain-settings-card .captain-setting-toggle input[role=switch]{position:absolute;right:12px;width:48px!important;height:28px;margin:0;opacity:0;cursor:pointer}
    .captain-setting-track{position:relative;display:block;flex:none;width:48px;height:28px;border:1px solid #a8b0bd;border-radius:999px;background:#cbd1da;transition:background .16s,border-color .16s;pointer-events:none}
    .captain-setting-track::after{content:'';position:absolute;top:3px;left:3px;width:20px;height:20px;border-radius:50%;background:#fff;box-shadow:0 1px 3px #0003;transition:transform .16s}
    .captain-setting-toggle input:checked+.captain-setting-track{background:#9e1834;border-color:#9e1834}
    .captain-setting-toggle input:checked+.captain-setting-track::after{transform:translateX(20px)}
    .captain-setting-toggle input:focus-visible+.captain-setting-track{outline:3px solid #9e1834;outline-offset:4px}
    .captain-setting-toggle:has(input:disabled){opacity:.6;cursor:not-allowed}
    @media(prefers-reduced-motion:reduce){.captain-setting-track,.captain-setting-track::after{transition:none}}
  `;
  styles.textContent += `
    .employee-permission-option{display:flex;align-items:center;min-width:0;border-radius:8px}
    .employee-permission-option:has(input:checked){background:#fcf3f5}
    .employee-permission-option label{flex:1;min-width:0}
    .employee-permission-help{flex:none;width:44px;height:44px;padding:0!important;border:0;background:transparent;color:#64748b;font-size:20px;cursor:pointer;border-radius:8px}
    .employee-permission-help:hover{background:#f3e8ec;color:#9e1834}
    .permission-description{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}
    #employee-permission-tooltip{position:fixed;z-index:10000;box-sizing:border-box;width:340px;padding:14px 16px;background:#273345;color:#fff;border:1px solid #566174;border-radius:12px;box-shadow:0 6px 24px #0003;font:14px/1.6 system-ui;pointer-events:none}
    #employee-permission-tooltip[hidden]{display:none}
  `;
  document.head.appendChild(styles);
  const tooltip = document.createElement('div');
  tooltip.id = 'employee-permission-tooltip';
  tooltip.setAttribute('role', 'tooltip');
  tooltip.hidden = true;
  document.body.appendChild(tooltip);
  let helpOwner = null;
  let pinned = false;
  const hideHelp = () => {
    helpOwner?.querySelector('button').setAttribute('aria-expanded', 'false');
    helpOwner = null; pinned = false; tooltip.hidden = true;
  };
  const showHelp = (row) => {
    if (helpOwner !== row) hideHelp();
    helpOwner = row;
    tooltip.textContent = row.dataset.permissionHelp;
    tooltip.hidden = false;
    tooltip.style.width = Math.min(340, innerWidth - 24) + 'px';
    const rect = row.getBoundingClientRect();
    tooltip.style.left = Math.max(12, Math.min(rect.left, innerWidth - tooltip.offsetWidth - 12)) + 'px';
    tooltip.style.top = Math.max(12, Math.min(rect.bottom + 8, innerHeight - tooltip.offsetHeight - 12)) + 'px';
  };
  document.addEventListener('pointerover', event => {
    const row = event.target.closest('.employee-permission-option');
    if (row && !pinned && event.pointerType !== 'touch') showHelp(row);
  });
  document.addEventListener('pointermove', event => {
    const row = event.target.closest('.employee-permission-option');
    if (row && !pinned && event.pointerType !== 'touch' && tooltip.hidden) showHelp(row);
  });
  document.addEventListener('pointerout', event => {
    if (!pinned && helpOwner && !helpOwner.contains(event.relatedTarget)) hideHelp();
  });
  document.addEventListener('focusin', event => {
    const row = event.target.closest('.employee-permission-option');
    if (row) showHelp(row);
  });
  document.addEventListener('focusout', event => {
    if (!pinned && helpOwner && !helpOwner.contains(event.relatedTarget)) hideHelp();
  });
  document.addEventListener('click', event => {
    const button = event.target.closest('.employee-permission-help');
    if (button) {
      const row = button.closest('.employee-permission-option');
      if (helpOwner === row && pinned) hideHelp();
      else { showHelp(row); pinned = true; button.setAttribute('aria-expanded', 'true'); }
    } else if (helpOwner && !helpOwner.contains(event.target)) hideHelp();
  });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') hideHelp(); });
  window.addEventListener('resize', hideHelp);
  document.addEventListener('scroll', () => { if (helpOwner) showHelp(helpOwner); }, true);
  window.renderEmployeeCards = (employees, areas) => employees.map((employee, index) => {
    const role = Staff.normalizeRole(employee.role), rights = Staff.permissions(employee), scope = employee.tableScope || 'own';
    const field = (label, attribute, value, type = 'text', extra = '') => `<div class="form-group"><label for="employee-${attribute}-${index}">${label}</label><input id="employee-${attribute}-${index}" type="${type}" data-${attribute}="${index}" value="${esc(value)}" ${extra}></div>`;
    return `<article class="captain-account-card" data-captain-card="${index}">
      <header class="captain-account-head"><div><b>${esc(employee.name || 'New employee')}</b><small>${esc(Staff.roles[role].label)} · ${esc(employee.areas?.join(' · ') || 'All dining areas')}</small></div><span class="${employee.active === false ? 'is-off' : ''}">${employee.active === false ? '● Disabled' : '● Active'}</span></header>
      <div class="captain-account-body"><div class="employee-tabs" role="tablist" aria-label="Employee settings"><button type="button" role="tab" id="employee-basic-tab-${index}" aria-controls="employee-basic-panel-${index}" tabindex="0" aria-selected="true" data-employee-tab="basic">Basic details</button><button type="button" role="tab" id="employee-permissions-tab-${index}" aria-controls="employee-permissions-panel-${index}" tabindex="-1" aria-selected="false" data-employee-tab="permissions">Permissions</button></div>
      <section class="employee-panel" role="tabpanel" id="employee-basic-panel-${index}" aria-labelledby="employee-basic-tab-${index}" data-employee-panel="basic"><div class="form-grid">
        ${field('Name', 'captain-name', employee.name, 'text', 'autocomplete="name"')}
        <div class="form-group"><label for="captain-role-${index}">User type</label><select id="captain-role-${index}" data-captain-role="${index}">${Object.entries(Staff.roles).map(([key, value]) => `<option value="${key}" ${key === role ? 'selected' : ''}>${esc(value.label)}</option>`).join('')}</select><p class="employee-role-description" data-employee-role-description>${esc(Staff.roles[role].description)}</p></div>
        ${field('Username', 'employee-username', employee.username || employee.id, 'text', 'autocomplete="off" autocapitalize="none" maxlength="64"')}
        ${field('User code', 'employee-code', employee.userCode || employee.id, 'text', 'maxlength="40"')}
        ${field(employee.passwordConfigured ? 'Change password (leave blank to keep)' : 'Password (or use a PIN)', 'employee-password', employee.password || '', 'password', 'autocomplete="new-password" minlength="8" maxlength="128"')}
        ${field('Phone', 'employee-phone', employee.phone || '', 'tel', 'autocomplete="tel" maxlength="30"')}
        <div class="form-group"><label for="employee-pin-${index}">Staff PIN</label><div class="captain-pin-control"><input id="employee-pin-${index}" type="password" data-captain-pin="${index}" value="${esc(employee.pin || '')}" inputmode="numeric" maxlength="6" autocomplete="new-password"><button type="button" class="captain-pin-toggle" data-captain-pin-toggle="${index}">Show PIN</button></div><div class="captain-current-pin" data-captain-current-pin="${index}" hidden>Current PIN: <b></b></div><div class="captain-pin-actions"><button type="button" data-captain-pin-generate="${index}">Generate new PIN</button><button type="button" data-captain-pin-copy="${index}" disabled>Copy new PIN</button></div><small class="captain-pin-help">${employee.pinConfigured ? employee.pinViewable ? 'PIN saved. Use Show PIN when helping this employee.' : 'Set a new PIN once to enable viewing this older PIN.' : 'Set a 4–6 digit PIN for Captain / waiter phone sign-in.'}</small></div>
        <div class="form-group"><label>Account status</label><label><input data-captain-active="${index}" type="checkbox" ${employee.active !== false ? 'checked' : ''}> Employee can sign in</label><p class="help-text">Disabling an account revokes access on its next request.</p></div>
      </div><p class="employee-login-note">Use the username and password or PIN at <a href="/staff-login" target="_blank" rel="noopener">Staff sign-in</a>. Captains and waiters can also choose their name and enter their PIN in the Captain app.</p></section>
      <section class="employee-panel" role="tabpanel" id="employee-permissions-panel-${index}" aria-labelledby="employee-permissions-tab-${index}" data-employee-panel="permissions" hidden>
        <div class="employee-section-intro"><h3>Order access</h3><p>Choose which orders this employee can work on, then enable their workspaces and actions below. Changes take effect after saving.</p></div><div class="form-grid"><div class="form-group"><label for="captain-scope-${index}">Active table access</label><select id="captain-scope-${index}" data-captain-scope="${index}"><option value="own" ${scope === 'own' ? 'selected' : ''}>Only orders opened by or assigned to this employee</option><option value="assigned_areas" ${scope === 'assigned_areas' ? 'selected' : ''}>All orders in assigned areas, including counter orders</option><option value="all" ${scope === 'all' ? 'selected' : ''}>All table orders (within selected areas, if any)</option></select></div><div class="form-group"><label>Assigned dining areas</label><div class="captain-area-options">${areas.map((area) => `<label><input data-captain-area="${index}" value="${esc(area)}" type="checkbox" ${employee.areas?.includes(area) ? 'checked' : ''}> ${esc(area)}</label>`).join('') || '<p>Allocate dining areas in Orders → Operations first.</p>'}</div><p class="help-text">Select at least one area for “All orders in assigned areas”. Other scopes allow every area when no areas are selected.</p></div></div>
        ${Object.entries(Staff.groups).map(([group, permissions]) => `<div class="employee-permission-group"><h3>${esc(group)}</h3><div class="employee-permission-grid">${Object.entries(permissions).map(([key, label]) => `<div class="employee-permission-option" data-permission-help="${esc(permissionHelp[key])}"><label><input type="checkbox" aria-describedby="permission-help-${index}-${key}" data-captain-permission="${index}" value="${key}" ${rights[key] ? 'checked' : ''}> ${esc(label)}</label><button type="button" class="employee-permission-help" aria-label="About ${esc(label)}" aria-expanded="false">ⓘ</button><span class="permission-description" id="permission-help-${index}-${key}">${esc(permissionHelp[key])}</span></div>`).join('')}</div></div>`).join('')}
        <div class="form-grid"><div class="form-group"><label><input type="checkbox" data-employee-reason="${index}" ${employee.requireEditReason !== false ? 'checked' : ''}> Require a reason when editing / deleting KOT items</label></div><div class="form-group"><label>Maximum discount</label><select data-employee-discount-type="${index}" aria-label="Discount limit type"><option value="fixed" ${employee.discountLimit?.type !== 'percent' ? 'selected' : ''}>Fixed amount (₹)</option><option value="percent" ${employee.discountLimit?.type === 'percent' ? 'selected' : ''}>Percentage (%)</option></select><input type="number" min="0" step="0.01" data-employee-discount-value="${index}" value="${Number(employee.discountLimit?.value || 0)}" aria-label="Discount limit"><p class="help-text">Discount permission and a nonzero limit are both required.</p></div></div>
      </section><button type="button" data-captain-remove="${index}" class="btn-delete">Remove employee</button></div></article>`;
  }).join('') || '<p class="captain-empty-state">Add an employee, choose a role and assign their access.</p>';
  document.addEventListener('click', (event) => {
    const tab = event.target.closest('[data-employee-tab]');
    if (tab) {
      const card = tab.closest('[data-captain-card]');
      card.querySelectorAll('[data-employee-tab]').forEach((button) => { button.setAttribute('aria-selected', String(button === tab)); button.tabIndex = button === tab ? 0 : -1; });
      card.querySelectorAll('[data-employee-panel]').forEach((panel) => { panel.hidden = panel.dataset.employeePanel !== tab.dataset.employeeTab; });
    }
  });
  document.addEventListener('keydown', (event) => {
    const tab = event.target.closest('[data-employee-tab]');
    if (!tab || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const tabs = [...tab.closest('[role="tablist"]').querySelectorAll('[role="tab"]')];
    const next = event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs[tabs.length - 1] : tabs[(tabs.indexOf(tab) + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
    next.click();
    next.focus();
  });
  function syncControls(card) {
    const scope = card.querySelector('[data-captain-scope]');
    const selected = card.querySelectorAll('[data-captain-area]:checked').length;
    scope.setCustomValidity(scope.value === 'assigned_areas' && !selected ? 'Select at least one assigned dining area.' : '');
    const discount = card.querySelector('[data-employee-discount-value]');
    const enabled = ['applyDiscounts', 'specialDiscounts'].some((key) => card.querySelector(`[data-captain-permission][value="${key}"]`)?.checked);
    const type = card.querySelector('[data-employee-discount-type]');
    discount.disabled = type.disabled = !enabled;
    discount.max = type.value === 'percent' ? '100' : '';
    discount.closest('.form-group').querySelector('.help-text').textContent = enabled ? 'Set a nonzero limit to allow discounts. Percentage limits cannot exceed 100%.' : 'Enable “Apply discounts” in Payments to set a limit.';
  }
  document.addEventListener('change', (event) => {
    const card = event.target.closest('[data-captain-card]');
    if (card) syncControls(card);
  });
  const list = document.getElementById('captain-admin-list');
  if (list) new MutationObserver(() => list.querySelectorAll('[data-captain-card]').forEach(syncControls)).observe(list, { childList: true });
  document.addEventListener('change', (event) => {
    const role = event.target.closest('[data-captain-role]');
    if (!role) return;
    const card = role.closest('[data-captain-card]');
    card.querySelector('[data-employee-role-description]').textContent = Staff.roles[role.value].description;
    card.querySelector('[data-captain-scope]').value = role.value === 'billing' ? 'all' : 'own';
  });
  const section = document.getElementById('tab-captain-app');
  const settingsCard = document.createElement('section');
  settingsCard.className = 'card captain-settings-card';
  settingsCard.innerHTML = `<h2>Captain App settings</h2><p class="help-text">Restaurant-wide behavior. Employee permissions still control who may perform each action. Save using “Save all changes”.</p>${Object.entries(Staff.captainSettingGroups).map(([group, settings]) => `<div class="employee-permission-group"><h3>${esc(group)}</h3><div class="employee-permission-grid">${Object.entries(settings).map(([key, label]) => `<label class="captain-setting-toggle"><span class="captain-setting-label">${esc(label)}</span><input type="checkbox" role="switch" aria-label="${esc(label)}" data-captain-setting="${key}"><span class="captain-setting-track" aria-hidden="true"></span></label>`).join('')}</div></div>`).join('')}<div class="form-grid"><div class="form-group"><label for="captain-item-sort">Item list order</label><select id="captain-item-sort" data-captain-setting="itemSort"><option value="rank">Item rank / popularity</option><option value="az">A–Z</option></select></div><div class="form-group"><label for="captain-notifications">Kitchen notifications</label><select id="captain-notifications" data-captain-setting="notifications"><option value="kot">Entire KOT ready</option><option value="item">Individual items ready (Smart KDS)</option><option value="none">No notifications</option></select></div></div><p class="help-text">Printers use Orders → Operations and the print bridge. Pair Bluetooth printers with the bridge computer and select their installed printer queue. Mandatory printing requires a configured kitchen printer and Send / reprint KOT permission.</p>`;
  section.insertBefore(settingsCard, section.querySelector('.card'));
  window.renderCaptainSettings = (settings) => {
    const normalized = Staff.captainSettings(settings);
    settingsCard.querySelectorAll('[data-captain-setting]').forEach((input) => { if (input.type === 'checkbox') input.checked = normalized[input.dataset.captainSetting]; else input.value = normalized[input.dataset.captainSetting]; });
  };
  window.collectCaptainSettings = () => Object.fromEntries([...settingsCard.querySelectorAll('[data-captain-setting]')].map((input) => [input.dataset.captainSetting, input.type === 'checkbox' ? input.checked : input.value]));
  window.renderCaptainSettings({});
  const audit = document.createElement('section');
  audit.className = 'card';
  audit.innerHTML = '<h2>Employee access log</h2><p class="help-text">Account changes and employee actions, with the operator and time.</p><button type="button" id="employee-audit-refresh">Refresh log</button><div id="employee-audit-list" aria-live="polite"></div>';
  if (!section) return;
  section.appendChild(audit);
  async function loadAudit() {
    const root = document.getElementById('employee-audit-list');
    try {
      const response = await fetch('/api/admin/employees/audit', { cache: 'no-store' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      root.innerHTML = (data.events || []).map((entry) => `<article class="employee-audit-row"><div><b>${esc(entry.details?.name || entry.employee_id)} · ${esc(entry.action)}</b><small>${esc(entry.details?.changedFields?.join(', ') || entry.details?.path || '')}</small></div><div>${esc(entry.actor_name)}<small>${esc(new Date(entry.created_at).toLocaleString('en-IN'))} · ${esc(entry.user_agent || '')}</small></div></article>`).join('') || '<p class="help-text">No employee changes recorded yet.</p>';
    } catch (error) { root.textContent = error.message || 'Unable to load the employee access log.'; }
  }
  document.getElementById('employee-audit-refresh').addEventListener('click', loadAudit);
  document.addEventListener('admin-tab-change', (event) => { if (event.detail?.targetId === 'tab-captain-app') void loadAudit(); });
  if (location.hash === '#tab-captain-app') void loadAudit();
})();
