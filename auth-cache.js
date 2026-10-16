(() => {
  if (window.RedLanternAuthCache || typeof window.fetch !== 'function') return;
  async function clearStaffData() {
    try { localStorage.removeItem('red-lantern-table-order-snapshot'); } catch (_) {}
    try { localStorage.removeItem('red-lantern-staff-access-profile-v1'); } catch (_) {}
    window.dispatchEvent(new CustomEvent('red-lantern-auth-changed'));
    // The durable order journals and printer pairing remain available. Only
    // cached reads from the previous authenticated account are invalidated.
    try {
      const registrations = await navigator.serviceWorker?.getRegistrations?.() || [];
      const workers = [...new Set(registrations.flatMap(registration =>
        [registration.active, registration.waiting, registration.installing].filter(Boolean)))];
      await Promise.all(workers.map(worker => {
        if (new URL(worker.scriptURL).pathname !== '/orders-sw.js') return;
        return new Promise(resolve => {
          const channel = new MessageChannel();
          const finish = () => { clearTimeout(timer); channel.port1.close(); resolve(); };
          const timer = setTimeout(finish, 500);
          channel.port1.onmessage = finish;
          try { worker.postMessage({ type: 'CLEAR_STAFF_DATA' }, [channel.port2]); }
          catch (_) { finish(); }
        });
      }));
    } catch (_) {}
    try {
      await Promise.all((await caches.keys()).filter(key => key.startsWith('red-lantern-orders-')).map(async key => {
        const cache = await caches.open(key);
        await Promise.all((await cache.keys()).filter(request => new URL(request.url).pathname.startsWith('/api/'))
          .map(request => cache.delete(request)));
      }));
    } catch (_) {}
  }
  window.RedLanternAuthCache = { clearStaffData };
  const fetchStaff = window.fetch;
  window.fetch = async function (input, init) {
    const response = await fetchStaff.call(this, input, init);
    try {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, location.href);
      const method = String(init?.method || input?.method || 'GET').toUpperCase();
      const path = url.pathname.toLowerCase().replace(/\/+$/, '');
      const isSession = ['/api/orders/session', '/api/staff/session', '/api/captain/login'].includes(path);
      if (url.origin === location.origin && isSession &&
        ((response.ok && ['POST', 'DELETE'].includes(method)) ||
          (path === '/api/staff/session' && method === 'GET' && [401, 403].includes(response.status))))
        await clearStaffData();
    } catch (_) {}
    return response;
  };
})();
