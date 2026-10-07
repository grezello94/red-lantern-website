(() => {
  const Staff = window.RedLanternStaff;
  window.employeeCan = (right) => !window.currentEmployee || Staff.can(window.currentEmployee, right);
  const style = document.createElement('style');
  style.textContent = '[data-employee-denied]{display:none!important}.employee-console-bar{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:9px 18px;background:#f8eef1;color:#71172b;font:13px system-ui}.employee-console-bar a{color:inherit;font-weight:750;margin-left:14px}.employee-order-actions-link{display:inline-block;padding:8px 12px;border-radius:8px;color:#8e1935;background:#f9eef1;font:700 13px system-ui;text-decoration:none}';
  document.head.appendChild(style);
  function apply() {
    if (!window.currentEmployee) return;
    const rules = {
      takePayments: '.pay-group,[data-pay],[data-settle-table-order],#payment-confirm',
      requestBills: '[data-reprint],.print,[onclick^="printOrder"],[data-table-menu-action="bill"],[data-table-menu-action="reprint"]',
      cancelOrders: '.cancel-order,[onclick^="cancelOrder"]',
      editOrders: '.modify-order,[data-modify-order],[data-kot-item-edit],[data-kot-item-delete]',
      clearTables: '[data-clear],[data-clear-service]',
      moveTables: '[data-move-table-order],[data-table-menu-action="move"]',
      itemToggle: '#availability-toggle',
      readHistory: '[data-order-view="history"],#print-summary,#summary-date,.summary-date-label',
      createOrders: '[data-counter-mode="dine-in"]',
      pickupOrders: '[data-counter-mode="takeaway"],.take-away-order-button',
      operationsManage: '[data-operations-tab="printers"],[data-operations-tab="table-allocation"],[data-operations-tab="printer-routing"],[data-operations-tab="printing"],[data-add-table-area],[data-save-table-allocation]',
      releaseKots: '[data-print-kot]',
      updateKitchen: '.ticket-action[data-action]',
      acceptOrders: '[data-accept]',
    };
    for (const [right, selector] of Object.entries(rules)) document.querySelectorAll(selector).forEach((element) => {
      element.toggleAttribute('data-employee-denied', !window.employeeCan(right));
    });
    document.querySelectorAll('[onclick^="setStatus"]').forEach((element) => {
      const status = element.getAttribute('onclick').match(/,\s*'([^']+)'/)?.[1];
      const right = ['accepted','rejected'].includes(status) ? 'acceptOrders' : 'updateKitchen';
      element.toggleAttribute('data-employee-denied', status === 'completed' || !window.employeeCan(right));
    });
    document.querySelectorAll('a[href="/orders"],a[href="/register"],a[href="/kds"],a[href="/smart-kds"],a[href="/captain"]').forEach((element) => {
      element.toggleAttribute('data-employee-denied', !window.employeeCan(Staff.pagePermission(element.getAttribute('href'))));
    });
    document.querySelectorAll('article[data-order-id]').forEach((card) => {
      if (card.querySelector('.employee-order-actions-link')) return;
      const link = document.createElement('a');
      link.className = 'employee-order-actions-link';
      link.href = `/staff?order=${encodeURIComponent(card.dataset.orderId)}`;
      link.textContent = 'Employee actions / assignments';
      card.querySelector('.actions')?.appendChild(link);
    });
  }
  const observer = new MutationObserver(() => { if (window.currentEmployee) apply(); });
  observer.observe(document.body, { childList: true, subtree: true });
  async function refresh() {
    try {
      const response = await fetch('/api/staff/session', { cache: 'no-store' });
      const data = await response.json();
      if (!response.ok || !data.employee) return;
      window.currentEmployee = data.employee;
      let bar = document.querySelector('.employee-console-bar');
      if (!bar) { bar = document.createElement('div'); bar.className = 'employee-console-bar'; document.body.prepend(bar); }
      bar.replaceChildren();
      const label = document.createElement('span');
      label.textContent = `${data.employee.name} · ${Staff.roles[data.employee.role].label}`;
      const home = document.createElement('a'); home.href = '/staff'; home.textContent = 'My workspace';
      bar.append(label, home);
      apply();
    } catch (_) { /* Existing pages display their own connection state. */ }
  }
  void refresh();
  setInterval(() => { if (!document.hidden) void refresh(); }, 30000);
})();
