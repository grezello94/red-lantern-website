(() => {
  const Staff = window.RedLanternStaff;
  const profileKey = 'red-lantern-staff-access-profile-v1';
  let mode = 'unknown', verificationFailed = false, authRevision = 0, refreshSequence = 0;
  function publicProfile(employee) {
    if (!employee || typeof employee !== 'object' || !employee.id || employee.active === false) return null;
    const profile = {};
    for (const key of ['id','name','username','userCode','role','active','areas','tableScope','requireEditReason','discountLimit','captainSettings','idleMinutes'])
      if (Object.hasOwn(employee, key)) profile[key] = employee[key];
    profile.permissions = Staff.permissions(employee);
    return profile;
  }
  function restore(value) {
    try {
      const saved = JSON.parse(value || 'null');
      if (saved?.version !== 1) return false;
      if (saved.legacy === true) {
        mode = 'legacy'; window.currentEmployee = null; return true;
      }
      const employee = publicProfile(saved.employee);
      if (!employee) return false;
      mode = 'employee'; window.currentEmployee = employee; return true;
    } catch (_) { return false; }
  }
  try { restore(localStorage.getItem(profileKey)); } catch (_) {}
  window.employeeCan = (right) => {
    if (mode === 'denied') return false;
    if (window.currentEmployee) return Staff.can(window.currentEmployee, right);
    if (mode === 'legacy') return true;
    // Existing online pages can finish loading while their first session check
    // is pending. Unknown offline sessions cannot authorize queued actions.
    return !verificationFailed && navigator.onLine !== false;
  };
  const style = document.createElement('style');
  style.textContent = '[data-employee-denied]{display:none!important}.employee-console-bar{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:9px 18px;background:#f8eef1;color:#71172b;font:13px system-ui}.employee-console-bar a{color:inherit;font-weight:750;margin-left:14px}.employee-order-actions-link{display:inline-block;padding:8px 12px;border-radius:8px;color:#8e1935;background:#f9eef1;font:700 13px system-ui;text-decoration:none}';
  document.head.appendChild(style);
  function apply() {
    const rules = {
      takePayments: '.pay-group,[data-pay],[data-settle-table-order],#payment-confirm',
      requestBills: '[data-reprint],.print,[onclick^="printOrder"],[data-table-menu-action="bill"],[data-table-menu-action="reprint"],[data-dine-action="print"],[data-dine-action="split"]',
      cancelOrders: '.cancel-order,[onclick^="cancelOrder"]',
      editOrders: '.modify-order,[data-modify-order],[data-kot-item-edit],[data-kot-item-delete]',
      clearTables: '[data-clear],[data-clear-service]',
      moveTables: '[data-move-table-order],[data-table-menu-action="move"]',
      itemToggle: '#availability-toggle',
      readHistory: '[data-order-view="history"],#print-summary,#summary-date,.summary-date-label',
      createOrders: '[data-counter-mode="dine-in"],[data-dine-action="save"],[data-dine-action="hold"]',
      pickupOrders: '[data-counter-mode="takeaway"],.take-away-order-button',
      operationsManage: '[data-operations-tab="printers"],[data-operations-tab="table-allocation"],[data-operations-tab="printer-routing"],[data-operations-tab="printing"],[data-add-table-area],[data-save-table-allocation]',
      releaseKots: '[data-print-kot],[data-dine-action="kot-print"]',
      updateKitchen: '.ticket-action[data-action], #board [data-action], #board [data-batch-action], [data-smart-override], #override-submit',
      acceptOrders: '[data-accept]',
    };
    for (const [right, selector] of Object.entries(rules)) document.querySelectorAll(selector).forEach((element) => {
      element.toggleAttribute('data-employee-denied', !window.employeeCan(right));
    });
    document.querySelectorAll('#counter-place-order').forEach((element) => {
      element.toggleAttribute('data-employee-denied', !['createOrders','pickupOrders','deliveryOrders'].some(window.employeeCan));
    });
    document.querySelectorAll('[onclick^="setStatus"]').forEach((element) => {
      const status = element.getAttribute('onclick').match(/,\s*'([^']+)'/)?.[1];
      const right = ['accepted','rejected'].includes(status) ? 'acceptOrders' : 'updateKitchen';
      element.toggleAttribute('data-employee-denied', (!!window.currentEmployee && status === 'completed') || !window.employeeCan(right));
    });
    document.querySelectorAll('a[href="/orders"],a[href="/register"],a[href="/kds"],a[href="/smart-kds"],a[href="/captain"]').forEach((element) => {
      element.toggleAttribute('data-employee-denied', !window.employeeCan(Staff.pagePermission(element.getAttribute('href'))));
    });
    document.querySelectorAll('article[data-order-id]').forEach((card) => {
      if (!window.currentEmployee) return;
      if (card.querySelector('.employee-order-actions-link')) return;
      const link = document.createElement('a');
      link.className = 'employee-order-actions-link';
      link.href = `/staff?order=${encodeURIComponent(card.dataset.orderId)}`;
      link.textContent = 'Employee actions / assignments';
      card.querySelector('.actions')?.appendChild(link);
    });
  }
  function renderBar() {
    let bar = document.querySelector('.employee-console-bar');
    const employee = window.currentEmployee;
    if (!employee && mode !== 'denied' && !(mode === 'unknown' && (verificationFailed || navigator.onLine === false))) {
      bar?.remove(); return;
    }
    if (!bar) { bar = document.createElement('div'); bar.className = 'employee-console-bar'; document.body.prepend(bar); }
    bar.replaceChildren();
    const label = document.createElement('span');
    label.textContent = employee
      ? `${employee.name || 'Employee'} · ${Staff.roles[employee.role]?.label || 'Employee'}`
      : 'Sign in online to restore staff access.';
    const home = document.createElement('a');
    home.href = employee ? '/staff' : '/staff-login'; home.textContent = employee ? 'My workspace' : 'Sign in';
    bar.append(label, home);
  }
  function deny() {
    mode = 'denied'; verificationFailed = true; window.currentEmployee = null;
    try { localStorage.removeItem(profileKey); } catch (_) {}
    renderBar(); apply();
  }
  const observer = new MutationObserver(apply);
  observer.observe(document.body, { childList: true, subtree: true });
  async function refresh() {
    const revision = authRevision, sequence = ++refreshSequence;
    try {
      const response = await fetch('/api/staff/session', { cache: 'no-store' });
      if (revision !== authRevision || sequence !== refreshSequence) return;
      if ([401, 403].includes(response.status)) { deny(); return; }
      const data = await response.json();
      if (revision !== authRevision || sequence !== refreshSequence) return;
      if (!response.ok) throw new Error('Employee access could not be verified.');
      const employee = publicProfile(data.employee);
      if (!employee && data.legacy !== true) return;
      verificationFailed = false;
      mode = employee ? 'employee' : 'legacy';
      window.currentEmployee = employee;
      try { localStorage.setItem(profileKey, JSON.stringify({ version: 1,
        ...(employee ? { employee } : { legacy: true }) })); } catch (_) {}
      renderBar(); apply();
    } catch (_) {
      if (revision !== authRevision || sequence !== refreshSequence) return;
      verificationFailed = true; renderBar(); apply();
    }
  }
  window.addEventListener('red-lantern-auth-changed', () => { authRevision += 1; deny(); });
  window.addEventListener('storage', (event) => {
    if (event.key !== profileKey && event.key !== null) return;
    authRevision += 1;
    if (event.newValue && restore(event.newValue)) { verificationFailed = false; renderBar(); apply(); }
    else deny();
  });
  window.addEventListener('offline', () => { renderBar(); apply(); });
  window.addEventListener('online', () => { void refresh(); });
  document.addEventListener('click', (event) => {
    if (!event.target.closest?.('[data-employee-denied]')) return;
    event.preventDefault(); event.stopImmediatePropagation();
  }, true);
  renderBar(); apply();
  void refresh();
  setInterval(() => { if (!document.hidden) void refresh(); }, 30000);
})();
