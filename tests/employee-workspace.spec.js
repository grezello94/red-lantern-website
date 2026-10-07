const { test, expect } = require('@playwright/test');
const Staff = require('../staff-domain');

async function mockWorkspace(page, employee, orders, onRequest = () => {}) {
  await page.route('**/api/**', async (route) => {
    const request = route.request(), url = new URL(request.url());
    onRequest(request, url);
    const payloads = {
      '/api/staff/session': { employee: {name:'Employee',active:true,areas:[],tableScope:'own',discountLimit:{type:'fixed',value:0},...employee,permissions:Staff.permissions(employee)}, token:'test-token' },
      '/api/orders': orders,
      '/api/staff/employees': { employees:[{id:'waiter-ac',name:'AC Waiter',role:'waiter',areas:['AC'],tableService:true},{id:'waiter-bar',name:'BAR Waiter',role:'waiter',areas:['BAR'],tableService:true},{id:'driver',name:'Delivery Employee',role:'delivery',areas:[],delivery:true}] },
      '/api/staff/store': {open:true},
      '/api/orders/menu': [{key:'soup::soup',name:'Soup',category:'SOUP'}],
      '/api/orders/availability': [],
      '/api/orders/operations': {config:{tableAreas:[{name:'AC',from:1,to:6}]}},
    };
    await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(request.method() === 'GET' ? payloads[url.pathname] || {} : {ok:true})});
  });
}
const delivery = (id,employeeId) => ({id,mode:'card',fulfillment_type:'delivery',delivery_employee_id:employeeId,delivery_status:'assigned',status:'ready',daily_order_number:id === 'one' ? 1 : 2,total:100,items:[{name:'Soup',quantity:1}],customer_name:'Guest',customer_phone:'9876543210'});

test('delivery workspace shows only assigned deliveries and sends pickup progress', async ({page}) => {
  await page.setViewportSize({width:390,height:844});
  let update;
  await mockWorkspace(page,{id:'driver',role:'delivery'},[delivery('one','driver'),delivery('two','other')],(request,url) => {
    if (url.pathname.endsWith('/delivery-progress')) update = request.postDataJSON();
  });
  await page.goto('/staff.html');
  await expect(page.locator('.order-card')).toHaveCount(1);
  await expect(page.locator('[data-order-action="pay"]')).toHaveCount(0);
  await expect(page.locator('[data-order-action="cancel"]')).toHaveCount(0);
  await page.locator('[data-order-action="pickup"]').click();
  await expect.poll(() => update?.status).toBe('picked_up');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
test('online acceptance controls follow explicitly granted availability permissions', async ({page}) => {
  let storeUpdate;
  await mockWorkspace(page,{id:'online',role:'online_acceptance',permissions:{storeToggle:true,itemToggle:true}},[{...delivery('one',null),status:'new'}],(request,url) => {
    if (url.pathname === '/api/staff/store' && request.method() === 'PATCH') storeUpdate = request.postDataJSON();
  });
  await page.goto('/staff.html');
  await expect(page.locator('[data-order-action="accept"]')).toBeVisible();
  await expect(page.locator('#staff-store-controls')).toBeVisible();
  await expect(page.locator('#staff-items')).toContainText('Soup');
  await expect(page.locator('[data-order-action="pay"]')).toHaveCount(0);
  await page.locator('#staff-store-open').uncheck();
  await expect.poll(() => storeUpdate?.open).toBe(false);
});
test('biller assigns a counter-created table to an eligible waiter', async ({page}) => {
  let assigned;
  await mockWorkspace(page,{id:'biller',role:'billing',tableScope:'all'},[{id:'counter-table',mode:'table',table_area:'AC',table_number:6,status:'accepted',daily_order_number:6,total:100,items:[{name:'Soup',quantity:1}]}],(request,url) => {
    if (url.pathname.endsWith('/assignment')) assigned = request.postDataJSON();
  });
  await page.goto('/staff.html');
  await page.locator('[data-order-action="assign"]').click();
  await expect(page.locator('select[name="employee"]')).toContainText('AC Waiter');
  await expect(page.locator('select[name="employee"]')).not.toContainText('BAR Waiter');
  await page.locator('#staff-action-save').click();
  await expect.poll(() => assigned?.employeeId).toBe('waiter-ac');
});
