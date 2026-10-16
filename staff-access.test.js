const fs = require('fs');
const path = require('path');
const Staff = require('./staff-domain');
const source = fs.readFileSync(path.join(__dirname, 'staff-access.js'), 'utf8');
const profileKey = 'red-lantern-staff-access-profile-v1';

describe('verified employee permissions across offline reloads and auth changes', () => {
  let online, intervals, observers, windowListeners, documentListeners, originalFetch;
  const employee = { id: 'billing-a', name: 'Billing A', role: 'billing', requireEditReason: true,
    permissions: { takePayments: false, cancelOrders: false, requestBills: true, createOrders: true } };
  const response = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data });
  const flush = async () => { for (let index = 0; index < 8; index += 1) await Promise.resolve(); };
  function resetRuntime() {
    observers.forEach((observer) => observer.disconnect()); observers.length = 0;
    windowListeners.mock.calls.forEach(([type, listener, options]) => window.removeEventListener(type, listener, options));
    documentListeners.mock.calls.forEach(([type, listener, options]) => document.removeEventListener(type, listener, options));
    windowListeners.mockClear(); documentListeners.mockClear(); intervals.length = 0;
    document.head.innerHTML = '';
    document.body.innerHTML = '<button data-pay>Pay</button><button class="cancel-order">Cancel</button>' +
      '<button data-reprint>Print</button><button data-dine-action="save">Save</button>' +
      '<button id="counter-place-order">Create</button><a href="/orders">Orders</a>';
    delete window.currentEmployee;
    delete window.employeeCan;
  }
  function launch() { window.eval(source); }
  async function refresh() { intervals[0](); await flush(); }

  beforeEach(() => {
    intervals = []; observers = [];
    originalFetch = window.fetch;
    window.fetch = jest.fn();
    window.RedLanternStaff = Staff;
    const Observer = window.MutationObserver;
    jest.spyOn(window, 'MutationObserver').mockImplementation((callback) => {
      const observer = new Observer(callback); observers.push(observer); return observer;
    });
    windowListeners = jest.spyOn(window, 'addEventListener');
    documentListeners = jest.spyOn(document, 'addEventListener');
    jest.spyOn(window, 'setInterval').mockImplementation((callback) => { intervals.push(callback); return intervals.length; });
    jest.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    online = jest.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
    localStorage.clear(); resetRuntime();
  });
  afterEach(() => {
    resetRuntime(); localStorage.clear(); jest.restoreAllMocks();
    window.fetch = originalFetch;
    delete window.RedLanternStaff;
  });

  test('restricted employees retain their verified role on an offline reload without storing session tokens', async () => {
    window.fetch.mockResolvedValue(response({ employee: { ...employee, token: 'secret-token' }, token: 'secret-token' }));
    launch(); await flush();
    expect(window.employeeCan('takePayments')).toBe(false);
    expect(document.querySelector('[data-pay]')).toHaveAttribute('data-employee-denied');
    expect(window.employeeCan('requestBills')).toBe(true);
    expect(localStorage.getItem(profileKey)).not.toContain('secret-token');
    expect(JSON.parse(localStorage.getItem(profileKey)).employee.permissions.takePayments).toBe(false);

    resetRuntime(); online.mockReturnValue(false);
    window.fetch.mockRejectedValue(new TypeError('Offline'));
    launch(); await flush();
    expect(window.currentEmployee.id).toBe(employee.id);
    expect(window.employeeCan('takePayments')).toBe(false);
    expect(window.employeeCan('cancelOrders')).toBe(false);
    expect(window.employeeCan('requestBills')).toBe(true);
    expect(document.querySelector('[data-reprint]')).not.toHaveAttribute('data-employee-denied');
  });

  test('unknown offline sessions deny controls and cannot trigger hidden actions', async () => {
    online.mockReturnValue(false); window.fetch.mockRejectedValue(new TypeError('Offline'));
    launch(); await flush();
    expect(window.employeeCan('takePayments')).toBe(false);
    expect(window.employeeCan('createOrders')).toBe(false);
    expect(document.querySelector('[data-dine-action]')).toHaveAttribute('data-employee-denied');
    expect(document.querySelector('#counter-place-order')).toHaveAttribute('data-employee-denied');
    const action = jest.fn(); document.querySelector('[data-pay]').addEventListener('click', action);
    document.querySelector('[data-pay]').click();
    expect(action).not.toHaveBeenCalled();
  });

  test('an unknown failed session check denies actions even if the browser still reports online', async () => {
    window.fetch.mockRejectedValue(new TypeError('Network unavailable'));
    launch(); await flush();
    expect(window.employeeCan('takePayments')).toBe(false);
    expect(localStorage.getItem(profileKey)).toBeNull();
  });

  test.each([401, 403])('explicit %s revocation clears cached identity and immediately denies stale controls', async (status) => {
    window.fetch.mockResolvedValueOnce(response({ employee }));
    launch(); await flush();
    expect(window.employeeCan('requestBills')).toBe(true);
    window.fetch.mockResolvedValue(response({ error: 'Sign in again' }, status));
    await refresh();
    expect(window.currentEmployee).toBeNull();
    expect(localStorage.getItem(profileKey)).toBeNull();
    expect(window.employeeCan('requestBills')).toBe(false);
    expect(document.querySelector('[data-reprint]')).toHaveAttribute('data-employee-denied');
    expect(document.querySelector('.employee-console-bar')).not.toHaveTextContent(employee.name);
  });

  test('an explicitly verified legacy session keeps its existing behavior offline', async () => {
    window.fetch.mockResolvedValue(response({ legacy: true, employee: null }));
    launch(); await flush();
    expect(window.employeeCan('takePayments')).toBe(true);
    expect(JSON.parse(localStorage.getItem(profileKey))).toEqual({ version: 1, legacy: true });
    resetRuntime(); online.mockReturnValue(false); window.fetch.mockRejectedValue(new TypeError('Offline'));
    launch(); await flush();
    expect(window.employeeCan('takePayments')).toBe(true);
    expect(document.querySelector('[data-pay]')).not.toHaveAttribute('data-employee-denied');
  });
  test('a proxy HTML 401 denies access before attempting to parse a session body', async () => {
    window.fetch.mockResolvedValueOnce(response({ employee }));
    launch(); await flush();
    const parse = jest.fn(async () => { throw new SyntaxError('HTML sign-in response'); });
    window.fetch.mockResolvedValue({ ok: false, status: 401, json: parse });
    await refresh();
    expect(parse).not.toHaveBeenCalled();
    expect(window.currentEmployee).toBeNull();
    expect(window.employeeCan('requestBills')).toBe(false);
    expect(localStorage.getItem(profileKey)).toBeNull();
  });

  test('an auth change cannot be undone by an earlier in-flight successful session response', async () => {
    localStorage.setItem(profileKey, JSON.stringify({ version: 1, employee }));
    let resolve;
    window.fetch.mockReturnValue(new Promise((done) => { resolve = done; }));
    launch();
    expect(window.employeeCan('requestBills')).toBe(true);
    window.dispatchEvent(new CustomEvent('red-lantern-auth-changed'));
    resolve(response({ employee })); await flush();
    expect(window.currentEmployee).toBeNull();
    expect(window.employeeCan('requestBills')).toBe(false);
    expect(localStorage.getItem(profileKey)).toBeNull();
  });

  test('another tab clearing authentication also invalidates the local profile', async () => {
    window.fetch.mockResolvedValue(response({ employee }));
    launch(); await flush();
    window.dispatchEvent(new StorageEvent('storage', { key: profileKey, newValue: null }));
    expect(window.currentEmployee).toBeNull();
    expect(window.employeeCan('requestBills')).toBe(false);
    expect(document.querySelector('[data-reprint]')).toHaveAttribute('data-employee-denied');
  });
});
