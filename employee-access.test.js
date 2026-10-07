/** @jest-environment node */
const http = require('http');
const crypto = require('crypto');
const Staff = require('./staff-domain');
let mockConfig, mockOrders;
const mockSql = jest.fn(async (strings, ...values) => {
  const query = typeof strings === 'string' ? strings : strings.join('$');
  if (query.includes('SELECT data FROM website_content')) {
    return [{ data: values[0] === 'captain_content' ? structuredClone(mockConfig) : { serviceWindowsEnabled: false, proximity: {latitude:15,longitude:74,tableRadius:200} } }];
  }
  if (query.includes('INSERT INTO website_content (id, data)')) { mockConfig = structuredClone(values[1]); return []; }
  if (query.includes('SELECT config FROM order_operations_config')) return [{ config: { tableAreas: [{name:'AC',from:1,to:10}] } }];
  if (query.includes('FROM direct_orders o WHERE o.id=')) return mockOrders.filter((order) => order.id === values[0]);
  if (query.includes('FROM direct_orders o') && !query.includes('LIMIT 0') && !query.includes('GROUP BY')) return mockOrders;
  return [];
});
jest.mock('@neondatabase/serverless', () => ({ neon: () => mockSql, neonConfig: {} }));
jest.mock('web-push', () => ({ setVapidDetails: jest.fn(), sendNotification: jest.fn() }));

describe('employee server authorization', () => {
  let server, origin, app;
  const pinHash = (id) => crypto.scryptSync('1234', `captain:${id}`, 64).toString('hex');
  beforeAll(async () => {
    process.env.NEON_DATABASE_URL = 'postgresql://test:test@localhost/test';
    process.env.ADMIN_USERNAME = 'test-admin';
    process.env.ADMIN_PASSWORD = 'test-admin-password';
    process.env.CAPTAIN_SESSION_SECRET = 'test-employee-session-secret';
    mockConfig = { settings:{idleMinutes:15}, captains:[
      {id:'own',name:'Own Captain',username:'own',userCode:'own',role:'captain',active:true,areas:['AC'],tableScope:'own',pinHash:pinHash('own')},
      {id:'area',name:'Area Captain',username:'area',userCode:'area',role:'captain',active:true,areas:['AC'],tableScope:'assigned_areas',pinHash:pinHash('area')},
      {id:'driver',name:'Delivery Employee',username:'driver',userCode:'driver',role:'delivery',active:true,areas:[],tableScope:'own',pinHash:pinHash('driver')},
    ] };
    mockOrders = [
      {id:'counter-table',mode:'table',table_area:'AC',table_number:6,status:'accepted',employee_assigned_id:'biller',captain_id:'',items:[{name:'Soup',quantity:1}],total:100},
      {id:'own-table',mode:'table',table_area:'AC',table_number:2,status:'accepted',employee_assigned_id:'own',captain_id:'own',items:[],total:100},
      {id:'delivery-a',mode:'card',fulfillment_type:'delivery',delivery_employee_id:'driver',status:'ready',items:[],total:100},
      {id:'delivery-b',mode:'card',fulfillment_type:'delivery',delivery_employee_id:'other',status:'ready',items:[],total:100},
    ];
    app = require('./server');
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0,'127.0.0.1',resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => { await new Promise((resolve) => server.close(resolve)); });
  async function request(path, {method='GET',body,cookie,admin=false} = {}) {
    const response = await fetch(origin+path,{method,headers:{...(body ? {'Content-Type':'application/json'} : {}),...(cookie ? {Cookie:cookie} : {}),...(admin ? {Authorization:`Basic ${Buffer.from('test-admin:test-admin-password').toString('base64')}`} : {})},...(body ? {body:JSON.stringify(body)} : {})});
    return {status:response.status,data:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};
  }
  async function login(username) { const result = await request('/api/orders/session',{method:'POST',body:{username,password:'1234'}}); expect(result.status).toBe(200); return result.cookie; }
  test('area access permits a bill request for a counter-created table; own scope denies it', async () => {
    const own = await login('own');
    const area = await login('area');
    const body = {serviceState:'bill_requested',proximity:{latitude:15,longitude:74,accuracy:5}};
    expect((await request('/api/captain/orders/counter-table/service',{method:'POST',cookie:own,body})).status).toBe(404);
    expect((await request('/api/captain/orders/counter-table/service',{method:'POST',cookie:area,body})).status).toBe(200);
  });
  test('the server blocks payment collection without permission even on an owned order', async () => {
    const cookie = await login('own');
    const result = await request('/api/orders/own-table/settle',{method:'POST',cookie,body:{paymentType:'cash',amount:100}});
    expect(result.status).toBe(403);
    expect(result.data.code).toBe('employee_permission_denied');
  });
  test('delivery workers only receive assigned orders and cannot enter table actions', async () => {
    const cookie = await login('driver');
    const result = await request('/api/orders',{cookie});
    expect(result.status).toBe(200);
    expect(result.data.map((order) => order.id)).toEqual(['delivery-a']);
    expect((await request('/api/orders/delivery-b/delivery-progress',{method:'POST',cookie,body:{status:'picked_up'}})).status).toBe(403);
    expect((await request('/api/orders/own-table/items',{method:'PATCH',cookie,body:{quantities:[1]}})).status).toBe(403);
  });
  test('Captain service settings are returned with sessions and enforced on direct requests', async () => {
    const cookie = await login('own');
    mockConfig.settings.homeDelivery = false;
    mockConfig.settings.takeAway = false;
    mockConfig.captains[0].permissions = { deliveryOrders:true,pickupOrders:true };
    expect((await request('/api/admin/captains',{method:'PUT',admin:true,body:mockConfig})).status).toBe(200);
    expect((await request('/api/staff/session',{cookie})).data.employee.captainSettings.homeDelivery).toBe(false);
    const delivery = await request('/api/orders/counter',{method:'POST',cookie,body:{fulfillmentType:'delivery'}});
    expect(delivery.status).toBe(403);
    expect(delivery.data.error).toContain('Home delivery');
    expect((await request('/api/orders/counter',{method:'POST',cookie,body:{}})).status).toBe(403);
    mockConfig.settings.takeAway = mockConfig.settings.homeDelivery = true;
    mockConfig.settings.mandatoryKot = true;
    expect((await request('/api/admin/captains',{method:'PUT',admin:true,body:mockConfig})).status).toBe(200);
    expect((await request('/api/orders/counter',{method:'POST',cookie,body:{tableArea:'AC',sendKot:false,action:'save'}})).status).toBe(403);
    mockConfig.settings.mandatoryKot = false;
    expect((await request('/api/admin/captains',{method:'PUT',admin:true,body:mockConfig})).status).toBe(200);
  });
  test('special discounts and priority cannot bypass permission checks', async () => {
    const cookie = await login('own');
    expect((await request('/api/orders/own-table/discount',{method:'POST',cookie,body:{special:true,type:'fixed',value:10,reason:'Guest courtesy'}})).status).toBe(403);
    expect((await request('/api/orders/own-table/priority',{method:'POST',cookie,body:{priority:'urgent'}})).status).toBe(403);
  });
  test('permission changes and deactivation affect an existing session immediately', async () => {
    const cookie = await login('area');
    const captains = mockConfig.captains.map((employee) => ({...employee,permissions:Staff.permissions(employee)}));
    captains.find((employee) => employee.id === 'area').permissions.requestBills = false;
    const saved = await request('/api/admin/captains',{method:'PUT',admin:true,body:{captains,settings:{idleMinutes:15}}});
    expect(saved.status).toBe(200);
    expect(saved.data.captains[0]).not.toHaveProperty('pinHash');
    expect(saved.data.captains[0]).not.toHaveProperty('passwordHash');
    expect((await request('/api/orders/counter-table/print',{cookie})).status).toBe(403);
    captains.find((employee) => employee.id === 'area').active = false;
    expect((await request('/api/admin/captains',{method:'PUT',admin:true,body:{captains}})).status).toBe(200);
    expect((await request('/api/staff/session',{cookie})).status).toBe(401);
  });
});
