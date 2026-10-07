/** @jest-environment jsdom */
const fs = require('fs');
const Staff = require('./staff-domain');

test('collecting employee drafts preserves credentials, areas and every permission before rerendering', () => {
  document.body.innerHTML = '<section id="tab-captain-app"><div id="captain-admin-list"></div></section>';
  window.RedLanternStaff = Staff;
  window.eval(fs.readFileSync('employee-admin.js', 'utf8'));
  const accounts = [{ id:'cap',name:'Old name',role:'captain',areas:[] }];
  document.getElementById('captain-admin-list').innerHTML = window.renderEmployeeCards(accounts, ['AC']);
  document.querySelector('[data-captain-name]').value = 'Edited name';
  document.querySelector('[data-captain-pin]').value = '654321';
  document.querySelector('[data-employee-password]').value = 'new-password';
  document.querySelector('[data-captain-area]').checked = true;
  document.querySelector('[value="takePayments"]').checked = true;
  document.querySelector('[data-employee-discount-value]').value = '50';
  const html = fs.readFileSync('admin.html','utf8');
  const helper = html.slice(html.indexOf('      const collectCaptainEdits ='), html.indexOf('      const renderCaptains ='));
  const collect = new Function('captainAccounts','captainPermissionLabels','document',helper + '\nreturn collectCaptainEdits();');
  const drafts = collect(accounts,Staff.labels,document);
  expect(drafts[0]).toMatchObject({name:'Edited name',pin:'654321',password:'new-password',areas:['AC'],permissions:{takePayments:true},discountLimit:{type:'fixed',value:50}});
  document.getElementById('captain-admin-list').innerHTML = window.renderEmployeeCards(drafts, ['AC']);
  expect(document.querySelector('[data-captain-pin]').value).toBe('654321');
  expect(document.querySelector('[data-employee-password]').value).toBe('new-password');
  expect(document.querySelector('[value="takePayments"]').checked).toBe(true);
});
