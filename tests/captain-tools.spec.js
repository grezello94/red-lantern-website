const { test, expect } = require('@playwright/test');
const Staff = require('../staff-domain');
async function openCaptain(page, settings = {}, grants = {}) {
  const employee = {id:'tools-cap',name:'Service Captain',role:'captain',active:true,areas:['AC'],tableScope:'assigned_areas',idleMinutes:120,captainSettings:Staff.captainSettings(settings),permissions:Staff.permissions({role:'captain',permissions:grants}),discountLimit:{type:'fixed',value:50}};
  const orders = [{id:'table-one',mode:'table',table_area:'AC',table_number:1,employee_assigned_id:employee.id,status:'accepted',daily_order_number:1,captain_accessible:true,customer_name:'Guest Alice',total:200,bill_printed_at:new Date().toISOString(),items:[{name:'Soup',category:'Soup',quantity:2}],updated_at:new Date().toISOString(),created_at:new Date().toISOString()}];
  const requests=[];
  await page.route('**/api/**', async route => {
    const req = route.request(), path = new URL(req.url()).pathname;
    if (req.method() !== 'GET') requests.push({path,body:req.postDataJSON()});
    const payloads = {'/api/staff/session':{employee,token:'test-tools-token'},'/api/captain/accounts':{captains:[employee]},'/api/captain/login':{captain:employee,token:'test-tools-token'},'/api/orders/operations':{config:{tableAreas:[{name:'AC',from:1,to:4}]}},'/api/orders':orders,'/api/orders/menu':[{key:'z',name:'Zesty Soup',category:'Soup',price:100},{key:'a',name:'Apple Juice',category:'Drinks',price:50}],'/api/orders/availability':[],'/api/captain/ready-alerts':{alerts:[]},'/api/staff/employees':{employees:[{id:'waiter',name:'Waiter One',tableService:true,areas:['AC']}]},'/api/captain/printers':{printers:[{id:'kitchen',name:'Kitchen',deviceName:'Kitchen queue',paperWidth:58}]}};
    await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(req.method() === 'GET' ? payloads[path] || {} : {ok:true})});
  });
  await page.goto('/captain.html');
  await expect(page.locator('.table-tile')).toHaveCount(4);
  return {requests,employee};
}
async function tools(page) {
  await page.locator('#captain-nav-toggle').click();
  await page.locator('#captain-open-tools').click();
  await expect(page.locator('#captain-tool-sheet')).toBeVisible();
}
test('service tools expose pending bills, server connection and unsuccessful KOT recovery', async ({page}) => {
  await page.setViewportSize({width:390,height:844});
  await openCaptain(page,{}, {takePayments:true});
  await tools(page);
  await page.locator('[data-service-tool="pending"]').click();
  await expect(page.locator('#captain-tool-content')).toContainText('Table 1');
  await page.locator('[data-native-order="table-one"]').click();
  await expect(page.locator('[data-native-order-action="pay"]')).toBeVisible();
  await page.locator('[data-close-tool]').first().click();
  await tools(page);
  await page.locator('[data-service-tool="server"]').click();
  await expect(page.locator('#captain-server-result')).toContainText('Connected');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
test('Captain edits and payments run inside the app with audit reason and stable payment ID', async ({page}) => {
  const {requests} = await openCaptain(page,{}, {editOrders:true,takePayments:true});
  await page.locator('[data-table-actions]').first().click();
  await page.locator('[data-captain-table-action="manage"]').click();
  await page.locator('[data-native-order-action="edit"]').click();
  await page.locator('[name="q-0"]').fill('1');
  await page.locator('[name="reason"]').fill('Guest changed quantity');
  await page.locator('#captain-tool-save').click();
  expect(requests.find(req => req.path.endsWith('/items')).body).toMatchObject({quantities:[1],reason:'Guest changed quantity'});
  await page.locator('[data-table-actions]').first().click();
  await page.locator('[data-captain-table-action="manage"]').click();
  await page.locator('[data-native-order-action="pay"]').click();
  await page.locator('#captain-tool-save').click();
  expect(requests.find(req => req.path.endsWith('/settle')).body).toMatchObject({paymentType:'cash',amount:200,paymentReceived:200});
  expect(page.url()).toContain('/captain.html');
});
test('settings govern service options, menu ordering, mandatory printing and automatic retry', async ({page}) => {
  await openCaptain(page,{takeAway:false,homeDelivery:false,itemSort:'az',mandatoryKot:true,autoSync:false,showCustomerName:true}, {pickupOrders:true,deliveryOrders:true});
  await expect(page.locator('[data-start-takeaway]')).toBeHidden();
  await expect(page.locator('[data-start-delivery]')).toBeHidden();
  await expect(page.locator('.captain-table-detail')).toContainText('Guest Alice');
  await page.locator('.table-tile').nth(1).click();
  await expect(page.locator('#menu-list .menu-item').first()).toContainText('Apple Juice');
  await expect(page.locator('#send-kot')).toBeChecked();
  await expect(page.locator('#send-kot')).toBeDisabled();
  const attempted = await page.evaluate(async () => {
    state.pending = [{payload:{clientRequestId:'queued',items:[]},status:'pending'}];
    let called = false;
    const original = postCaptainOrder;
    postCaptainOrder = async () => { called=true; return {}; };
    await flushPending({automatic:true});
    postCaptainOrder = original;
    state.pending=[];
    return called;
  });
  expect(attempted).toBe(false);
});

test('waiter and priority grants show their tools and printer formats can be saved', async ({page}) => {
  const {requests} = await openCaptain(page,{waiterAssignment:true,enablePriority:true}, {assignTables:true,setPriority:true,operationsManage:true});
  await page.locator('[data-table-actions]').first().click();
  await page.locator('[data-captain-table-action="manage"]').click();
  await page.locator('[data-native-order-action="priority"]').click();
  await page.locator('[name="priority"]').selectOption('urgent');
  await page.locator('#captain-tool-save').click();
  expect(requests.find(req => req.path.endsWith('/priority')).body).toEqual({priority:'urgent'});
  await tools(page);
  await page.locator('[data-service-tool="printers"]').click();
  await page.locator('[data-edit-kitchen-printer="kitchen"]').click();
  await page.locator('[name="width"]').selectOption('80');
  await page.locator('[name="serial"]').check();
  await page.locator('#captain-tool-save').click();
  expect(requests.find(req => req.path === '/api/captain/printers/kitchen').body).toEqual({paperWidth:80,showItemSerial:true});
});

test('failed order journal can be opened and manual retries remain available when auto-sync is off', async ({page}) => {
  await page.setViewportSize({width:390,height:844});
  await openCaptain(page,{autoSync:false});
  await page.evaluate(() => { state.pending=[{kind:'kot-retry',savedOrderId:'table-one',orderNumber:1,queuedAt:Date.now(),status:'kot-retry',payload:{clientRequestId:'retry-kot',tableArea:'AC',tableNumber:1,items:[{name:'Soup',quantity:1}]}}]; });
  await tools(page);
  await page.locator('[data-service-tool="unsuccessful"]').click();
  await expect(page.locator('#captain-tool-content')).toContainText('KOT waiting');
  await page.screenshot({path:test.info().outputPath('captain-unsuccessful-kots.png')});
  await page.locator('#captain-tool-content [data-sync-pending]').click();
  await expect(page.locator('#captain-tool-content')).toContainText('No unsuccessful KOTs');
});
