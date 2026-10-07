(function (root, factory) {
  const domain = factory();
  if (typeof module === 'object' && module.exports) module.exports = domain;
  else root.RedLanternStaff = domain;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const groups = {
    'Workspaces': { captainApp: 'Captain / waiter phone app', billingConsole: 'Orders and billing console', register: 'Register and settlement', kitchenDisplay: 'Kitchen displays', deliveryApp: 'Assigned delivery workspace', onlineAcceptance: 'Online order acceptance' },
    'Orders and kitchen tickets': { createOrders: 'Create dine-in orders', pickupOrders: 'Create pickup / takeaway orders', deliveryOrders: 'Create delivery orders', addRounds: 'Add items to active orders', viewKots: 'View KOTs and kitchen progress', releaseKots: 'Send or reprint KOTs', editOrders: 'Edit order / KOT item quantities', cancelOrders: 'Cancel orders and their KOTs', acceptOrders: 'Accept or reject incoming online orders', updateKitchen: 'Update kitchen preparation status' },
    'Tables and service': { markServed: 'Mark KOTs served', moveTables: 'Move tables', addTables: 'Add a table in an assigned area', requestBills: 'Generate / request bill printing', requestService: 'Request water or assistance', clearTables: 'Clear a settled table', assignTables: 'Assign table orders to an employee' },
    'Payments': { takePayments: 'Collect and settle payments', applyDiscounts: 'Apply discounts within the assigned limit', readHistory: 'View previous orders and daily collection summary' },
    'Delivery and online availability': { manageDeliveries: 'Assign delivery staff', fulfillDeliveries: 'Update assigned delivery progress', storeToggle: 'Open / close online ordering', itemToggle: 'Change item availability' },
    'Configuration': { operationsManage: 'Configure printers, routing and table allocation' },
  };
  const labels = Object.assign({}, ...Object.values(groups));
  const keys = Object.keys(labels);
  const roles = {
    captain: { label: 'Captain', description: 'Table service, order rounds, KOTs and bill requests.', grants: ['captainApp','createOrders','addRounds','viewKots','releaseKots','markServed','moveTables','requestBills','requestService'] },
    waiter: { label: 'Waiter', description: 'Take table orders and serve ready food in assigned areas.', grants: ['captainApp','createOrders','addRounds','viewKots','releaseKots','markServed','requestService'] },
    billing: { label: 'Billing User', description: 'Create orders, print bills, settle payments and assign service staff.', grants: ['billingConsole','register','createOrders','pickupOrders','deliveryOrders','addRounds','viewKots','releaseKots','editOrders','cancelOrders','acceptOrders','moveTables','requestBills','takePayments','clearTables','assignTables','manageDeliveries','readHistory'] },
    delivery: { label: 'Delivery Boy', description: 'See only deliveries assigned to you and update their progress.', grants: ['deliveryApp','fulfillDeliveries'] },
    online_acceptance: { label: 'Online Acceptance App', description: 'Accept or reject QR pickup and delivery orders.', grants: ['onlineAcceptance','acceptOrders'] },
  };
  function normalizeRole(role) { return Object.hasOwn(roles, role) ? role : 'captain'; }
  function permissions(employee = {}) {
    const defaults = new Set(roles[normalizeRole(employee.role)].grants);
    // Old Captain accounts could take takeaway orders before roles existed.
    if (!employee.role) defaults.add('pickupOrders');
    return Object.fromEntries(keys.map((key) => [key,
      typeof employee.permissions?.[key] === 'boolean' ? employee.permissions[key] : defaults.has(key)]));
  }
  function can(employee, permission) { return !!employee && permissions(employee)[permission] === true; }
  function home(employee) {
    const rights = permissions(employee);
    if (rights.billingConsole) return '/orders';
    if (rights.register) return '/register';
    if (rights.captainApp) return '/captain';
    if (rights.kitchenDisplay) return '/kds';
    return '/staff';
  }
  function pagePermission(path) {
    if (/^\/orders(?:\.html)?$/.test(path)) return 'billingConsole';
    if (/^\/register(?:\.html)?$/.test(path)) return 'register';
    if (/^\/(?:kds|smart-kds)(?:\.html)?$/.test(path) || path === '/kitchen-display') return 'kitchenDisplay';
    if (/^\/captain(?:\.html)?$/.test(path)) return 'captainApp';
    return null;
  }
  function orderAccessible(employee, order, { occupancy = false } = {}) {
    if (!employee || !order) return false;
    const rights = permissions(employee);
    if (order.mode === 'table') {
      if (employee.areas?.length && !employee.areas.includes(String(order.table_area || ''))) return false;
      if (occupancy) return rights.captainApp || rights.billingConsole || rights.register;
      const scope = employee.tableScope || 'own';
      return scope === 'all' || scope === 'assigned_areas' ||
        String(order.employee_assigned_id || order.captain_id || '') === String(employee.id);
    }
    if (rights.deliveryApp && String(order.delivery_employee_id || '') === String(employee.id)) return true;
    if (rights.onlineAcceptance && order.mode === 'card') return true;
    if (rights.kitchenDisplay) return true;
    if (rights.billingConsole || rights.register) {
      return order.fulfillment_type === 'delivery' ? rights.deliveryOrders : rights.pickupOrders;
    }
    return String(order.employee_assigned_id || order.captain_id || '') === String(employee.id) &&
      (order.fulfillment_type === 'delivery' ? rights.deliveryOrders : rights.pickupOrders);
  }
  function routePermission(method, path, body = {}) {
    if (/^\/api\/orders\/[^/]+\/settle$/.test(path) && method === 'POST') return 'takePayments';
    if (/^\/api\/orders\/[^/]+\/discount$/.test(path)) return 'applyDiscounts';
    if (/^\/api\/orders\/[^/]+\/assignment$/.test(path)) return 'assignTables';
    if (/^\/api\/orders\/[^/]+\/delivery-assignment$/.test(path)) return 'manageDeliveries';
    if (/^\/api\/orders\/[^/]+\/delivery-progress$/.test(path)) return 'fulfillDeliveries';
    if (/^\/api\/orders\/[^/]+\/items$/.test(path)) return 'editOrders';
    if (/^\/api\/orders\/[^/]+\/table$/.test(path)) return 'moveTables';
    if (/^\/api\/orders\/[^/]+\/service$/.test(path)) return 'clearTables';
    if (/^\/api\/orders\/[^/]+\/kots$/.test(path)) return method === 'GET' ? 'viewKots' : 'releaseKots';
    if (/^\/api\/orders\/[^/]+\/(?:print|bill-printed|bill-print\/.*)$/.test(path)) return 'requestBills';
    if (/^\/api\/orders\/[^/]+$/.test(path) && method === 'PATCH') {
      if (['cancelled','rejected'].includes(body.status)) return body.status === 'rejected' ? 'acceptOrders' : 'cancelOrders';
      if (body.status === 'accepted') return 'acceptOrders';
      return 'updateKitchen';
    }
    if (path === '/api/orders/operations/table-areas') return 'operationsManage';
    if (path === '/api/orders/operations/add-table') return 'addTables';
    if (path === '/api/orders/operations') return method === 'GET' ? 'read' : 'operationsManage';
    if (path.startsWith('/api/orders/availability/')) return 'itemToggle';
    if (path === '/api/orders/counter') return 'create';
    if (path.startsWith('/api/orders/smart-kds/')) return method === 'GET' ? 'kitchenDisplay' : 'updateKitchen';
    if (/\/kitchen-status\//.test(path)) return 'updateKitchen';
    if (['/api/orders/kitchen-statuses','/api/orders/kot-history'].includes(path)) return 'viewKots';
    if (path === '/api/register/summary') return 'readHistory';
    if (['/api/orders','/api/orders/menu','/api/orders/availability','/api/orders/live-summary','/api/orders/push-key','/api/orders/push-subscriptions'].includes(path)) return 'read';
    return null;
  }
  function discountAmount(policy = {}, input = {}, subtotal) {
    const amount = Number(input.value);
    if (!Number.isFinite(amount) || amount < 0) throw new Error('Enter a valid discount.');
    if (!['fixed','percent'].includes(input.type)) throw new Error('Choose a fixed or percentage discount.');
    const base = Math.max(0, Number(subtotal) || 0);
    const discount = input.type === 'percent' ? base * amount / 100 : amount;
    const limit = policy.type === 'percent' ? base * Number(policy.value || 0) / 100 : Number(policy.value || 0);
    if (discount > base || discount > limit + 0.005) throw new Error('This discount exceeds your assigned limit.');
    return Math.round(discount * 100) / 100;
  }
  return { groups, labels, keys, roles, normalizeRole, permissions, can, home, pagePermission, orderAccessible, routePermission, discountAmount };
});
