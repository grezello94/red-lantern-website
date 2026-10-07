(() => {
  const Staff = window.RedLanternStaff;
  const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const styles = document.createElement('style');
  styles.textContent = `.employee-tabs{display:flex;gap:8px;border-bottom:1px solid #e8e0dd;margin-bottom:22px;padding-bottom:10px}.employee-tabs button{padding:10px 16px;border:0;border-radius:10px;background:#f6f3f2;color:#4b5563;font-weight:700}.employee-tabs button[aria-selected=true]{background:#9e1834;color:white}.employee-panel[hidden]{display:none!important}.employee-permission-group{border:1px solid #e8e0dd;border-radius:14px;padding:16px;margin:14px 0}.employee-permission-group h3{margin:0 0 12px;font-size:15px}.employee-permission-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,245px),1fr));gap:14px}.employee-permission-grid label{display:flex;gap:10px;align-items:flex-start;font-size:14px;line-height:1.4}.employee-permission-grid input{width:17px!important;height:17px;margin:2px 0 0;flex:none}.employee-audit-row{padding:14px 0;border-bottom:1px solid #eee;display:grid;grid-template-columns:1fr 1fr;gap:8px}.employee-audit-row small{display:block;color:#64748b;margin-top:5px}.employee-role-description{color:#64748b;font-size:13px}.employee-login-note{padding:12px 16px;background:#faf7f5;border-radius:10px;line-height:1.6}@media(max-width:600px){.employee-audit-row{grid-template-columns:1fr}}`;
  document.head.appendChild(styles);
  window.renderEmployeeCards = (employees, areas) => employees.map((employee, index) => {
    const role = Staff.normalizeRole(employee.role), rights = Staff.permissions(employee), scope = employee.tableScope || 'own';
    const field = (label, attribute, value, type = 'text', extra = '') => `<div class="form-group"><label for="employee-${attribute}-${index}">${label}</label><input id="employee-${attribute}-${index}" type="${type}" data-${attribute}="${index}" value="${esc(value)}" ${extra}></div>`;
    return `<article class="captain-account-card" data-captain-card="${index}">
      <header class="captain-account-head"><div><b>${esc(employee.name || 'New employee')}</b><small>${esc(Staff.roles[role].label)} · ${esc(employee.areas?.join(' · ') || 'All dining areas')}</small></div><span class="${employee.active === false ? 'is-off' : ''}">${employee.active === false ? '● Disabled' : '● Active'}</span></header>
      <div class="captain-account-body"><div class="employee-tabs" role="tablist" aria-label="Employee settings"><button type="button" role="tab" aria-selected="true" data-employee-tab="basic">Basic details</button><button type="button" role="tab" aria-selected="false" data-employee-tab="permissions">Permissions</button></div>
      <section class="employee-panel" data-employee-panel="basic"><div class="form-grid">
        ${field('Name', 'captain-name', employee.name, 'text', 'autocomplete="name"')}
        <div class="form-group"><label for="captain-role-${index}">User type</label><select id="captain-role-${index}" data-captain-role="${index}">${Object.entries(Staff.roles).map(([key, value]) => `<option value="${key}" ${key === role ? 'selected' : ''}>${esc(value.label)}</option>`).join('')}</select><p class="employee-role-description" data-employee-role-description>${esc(Staff.roles[role].description)}</p></div>
        ${field('Username', 'employee-username', employee.username || employee.id, 'text', 'autocomplete="off" autocapitalize="none" maxlength="64"')}
        ${field('User code', 'employee-code', employee.userCode || employee.id, 'text', 'maxlength="40"')}
        ${field(employee.passwordConfigured ? 'Change password (leave blank to keep)' : 'Password (or use a PIN)', 'employee-password', '', 'password', 'autocomplete="new-password" minlength="8" maxlength="128"')}
        ${field('Phone', 'employee-phone', employee.phone || '', 'tel', 'autocomplete="tel" maxlength="30"')}
        <div class="form-group"><label for="employee-pin-${index}">Staff PIN</label><div class="captain-pin-control"><input id="employee-pin-${index}" type="password" data-captain-pin="${index}" inputmode="numeric" maxlength="6" autocomplete="new-password"><button type="button" class="captain-pin-toggle" data-captain-pin-toggle="${index}">Show PIN</button></div><div class="captain-current-pin" data-captain-current-pin="${index}" hidden>Current PIN: <b></b></div><div class="captain-pin-actions"><button type="button" data-captain-pin-generate="${index}">Generate new PIN</button><button type="button" data-captain-pin-copy="${index}" disabled>Copy new PIN</button></div><small class="captain-pin-help">${employee.pinConfigured ? employee.pinViewable ? 'PIN saved. Use Show PIN when helping this employee.' : 'Set a new PIN once to enable viewing this older PIN.' : 'Set a 4–6 digit PIN for Captain / waiter phone sign-in.'}</small></div>
        <div class="form-group"><label>Account status</label><label><input data-captain-active="${index}" type="checkbox" ${employee.active !== false ? 'checked' : ''}> Employee can sign in</label><p class="help-text">Disabling an account revokes access on its next request.</p></div>
      </div><p class="employee-login-note">Use the username and password or PIN at <a href="/staff-login" target="_blank" rel="noopener">Staff sign-in</a>. Captains and waiters can also choose their name and enter their PIN in the Captain app.</p></section>
      <section class="employee-panel" data-employee-panel="permissions" hidden>
        <div class="form-grid"><div class="form-group"><label for="captain-scope-${index}">Active table access</label><select id="captain-scope-${index}" data-captain-scope="${index}"><option value="own" ${scope === 'own' ? 'selected' : ''}>Only orders opened by or assigned to this employee</option><option value="assigned_areas" ${scope === 'assigned_areas' ? 'selected' : ''}>All orders in assigned areas, including counter orders</option><option value="all" ${scope === 'all' ? 'selected' : ''}>All table orders (within selected areas, if any)</option></select></div><div class="form-group"><label>Assigned dining areas</label><div class="captain-area-options">${areas.map((area) => `<label><input data-captain-area="${index}" value="${esc(area)}" type="checkbox" ${employee.areas?.includes(area) ? 'checked' : ''}> ${esc(area)}</label>`).join('') || '<p>Allocate dining areas in Orders → Operations first.</p>'}</div><p class="help-text">Select at least one area for “All orders in assigned areas”. Other scopes allow every area when no areas are selected.</p></div></div>
        ${Object.entries(Staff.groups).map(([group, permissions]) => `<div class="employee-permission-group"><h3>${esc(group)}</h3><div class="employee-permission-grid">${Object.entries(permissions).map(([key, label]) => `<label><input type="checkbox" data-captain-permission="${index}" value="${key}" ${rights[key] ? 'checked' : ''}> ${esc(label)}</label>`).join('')}</div></div>`).join('')}
        <div class="form-grid"><div class="form-group"><label><input type="checkbox" data-employee-reason="${index}" ${employee.requireEditReason !== false ? 'checked' : ''}> Require a reason when editing / deleting KOT items</label></div><div class="form-group"><label>Maximum discount</label><select data-employee-discount-type="${index}" aria-label="Discount limit type"><option value="fixed" ${employee.discountLimit?.type !== 'percent' ? 'selected' : ''}>Fixed amount (₹)</option><option value="percent" ${employee.discountLimit?.type === 'percent' ? 'selected' : ''}>Percentage (%)</option></select><input type="number" min="0" step="0.01" data-employee-discount-value="${index}" value="${Number(employee.discountLimit?.value || 0)}" aria-label="Discount limit"><p class="help-text">Discount permission and a nonzero limit are both required.</p></div></div>
      </section><button type="button" data-captain-remove="${index}" class="btn-delete">Remove employee</button></div></article>`;
  }).join('') || '<p class="captain-empty-state">Add an employee, choose a role and assign their access.</p>';
  document.addEventListener('click', (event) => {
    const tab = event.target.closest('[data-employee-tab]');
    if (tab) {
      const card = tab.closest('[data-captain-card]');
      card.querySelectorAll('[data-employee-tab]').forEach((button) => button.setAttribute('aria-selected', String(button === tab)));
      card.querySelectorAll('[data-employee-panel]').forEach((panel) => { panel.hidden = panel.dataset.employeePanel !== tab.dataset.employeeTab; });
    }
  });
  document.addEventListener('change', (event) => {
    const role = event.target.closest('[data-captain-role]');
    if (!role) return;
    const card = role.closest('[data-captain-card]');
    card.querySelector('[data-employee-role-description]').textContent = Staff.roles[role.value].description;
    card.querySelector('[data-captain-scope]').value = role.value === 'billing' ? 'all' : 'own';
  });
  const section = document.getElementById('tab-captain-app');
  const audit = document.createElement('section');
  audit.className = 'card';
  audit.innerHTML = '<h2>Employee access log</h2><p class="help-text">Account changes and employee actions, with the operator and time.</p><button type="button" id="employee-audit-refresh">Refresh log</button><div id="employee-audit-list" aria-live="polite"></div>';
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
