const Staff = require('./staff-domain');

describe('employee roles and order scope', () => {
  test('role defaults grant actual workspaces and keep financial rights explicit', () => {
    expect(Staff.home({ role: 'billing' })).toBe('/orders');
    expect(Staff.home({ role: 'delivery' })).toBe('/staff');
    expect(Staff.can({ role: 'waiter' }, 'takePayments')).toBe(false);
    expect(Staff.can({ role: 'captain' }, 'applyDiscounts')).toBe(false);
    expect(Staff.can({ role: 'delivery' }, 'billingConsole')).toBe(false);
    expect(Staff.can({ role: 'online_acceptance' }, 'acceptOrders')).toBe(true);
  });
  test('individual revocations override defaults and unknown rights are denied', () => {
    expect(Staff.can({ role: 'billing', permissions: { takePayments: false } }, 'takePayments')).toBe(false);
    expect(Staff.can({ role: 'billing' }, 'admin')).toBe(false);
  });
  test('a counter-created table can be managed with explicit area access', () => {
    const order = { mode: 'table', table_area: 'AC', employee_assigned_id: 'biller' };
    expect(Staff.orderAccessible({ id: 'cap', role: 'captain', areas: ['AC'], tableScope: 'own' }, order)).toBe(false);
    expect(Staff.orderAccessible({ id: 'cap', role: 'captain', areas: ['AC'], tableScope: 'assigned_areas' }, order)).toBe(true);
    expect(Staff.orderAccessible({ id: 'cap', role: 'captain', areas: ['BAR'], tableScope: 'all' }, order)).toBe(false);
  });
  test('explicit assignment controls ownership while occupancy remains visible', () => {
    const employee = { id: 'waiter', role: 'waiter', tableScope: 'own', areas: ['AC'] };
    const order = { mode: 'table', table_area: 'AC', captain_id: 'old-captain', employee_assigned_id: 'waiter' };
    expect(Staff.orderAccessible(employee, order)).toBe(true);
    expect(Staff.orderAccessible({ ...employee, id: 'old-captain' }, order)).toBe(false);
    expect(Staff.orderAccessible({ ...employee, id: 'other' }, order, { occupancy: true })).toBe(true);
  });
  test('a delivery worker cannot read another worker’s delivery or table orders', () => {
    const employee = { id: 'driver', role: 'delivery' };
    expect(Staff.orderAccessible(employee, { mode: 'card', fulfillment_type: 'delivery', delivery_employee_id: 'driver' })).toBe(true);
    expect(Staff.orderAccessible(employee, { mode: 'card', fulfillment_type: 'delivery', delivery_employee_id: 'other' })).toBe(false);
    expect(Staff.orderAccessible(employee, { mode: 'table', captain_id: 'other' })).toBe(false);
  });
  test('online staff see QR orders but cannot read counter orders', () => {
    expect(Staff.orderAccessible({ id: 'online', role: 'online_acceptance' }, { mode: 'card' })).toBe(true);
    expect(Staff.orderAccessible({ id: 'online', role: 'online_acceptance' }, { mode: 'counter' })).toBe(false);
  });
  test.each([
    ['POST','/api/orders/one/settle',{},'takePayments'],
    ['PATCH','/api/orders/one/items',{},'editOrders'],
    ['PATCH','/api/orders/one',{status:'cancelled'},'cancelOrders'],
    ['PATCH','/api/orders/one',{status:'accepted'},'acceptOrders'],
    ['PUT','/api/orders/operations',{},'operationsManage'],
    ['PUT','/api/orders/availability/item',{},'itemToggle'],
    ['POST','/api/orders/one/delivery-progress',{},'fulfillDeliveries'],
  ])('maps %s %s to its specific right', (method, path, body, right) => {
    expect(Staff.routePermission(method,path,body)).toBe(right);
  });
  test('unknown mutation endpoints fail closed', () => {
    expect(Staff.routePermission('DELETE','/api/orders/unlisted-operation')).toBeNull();
  });
  test('discount limits compare amounts even when the caller changes the input type', () => {
    expect(Staff.discountAmount({type:'percent',value:10},{type:'fixed',value:50},500)).toBe(50);
    expect(() => Staff.discountAmount({type:'fixed',value:50},{type:'percent',value:20},500)).toThrow('assigned limit');
    expect(() => Staff.discountAmount({type:'fixed',value:50},{type:'fixed',value:-1},500)).toThrow('valid discount');
  });
});
