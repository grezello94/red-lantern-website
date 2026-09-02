const { test, expect } = require('@playwright/test');

async function expectNoPageOverflow(page) {
  const overflow = await page.evaluate(() => ({
    viewport: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    bodyWidth: document.body.scrollWidth,
  }));
  expect(overflow.documentWidth).toBeLessThanOrEqual(overflow.viewport);
  expect(overflow.bodyWidth).toBeLessThanOrEqual(overflow.viewport);
}

async function expectContained(page, selector) {
  const failures = await page.locator(selector).evaluateAll((roots) =>
    roots.flatMap((root, rootIndex) => {
      const parent = root.getBoundingClientRect();
      return [...root.querySelectorAll('*')]
        .filter((node) => {
          const style = getComputedStyle(node);
          const box = node.getBoundingClientRect();
          return style.display !== 'none' && style.visibility !== 'hidden' && box.width && box.height;
        })
        .filter((node) => {
          const box = node.getBoundingClientRect();
          return (
            box.left < parent.left - 1 ||
            box.right > parent.right + 1 ||
            box.top < parent.top - 1 ||
            box.bottom > parent.bottom + 1
          );
        })
        .map((node) => ({
          root: rootIndex,
          node: node.className || node.tagName,
          text: node.textContent.trim().slice(0, 80),
        }));
    })
  );
  expect(failures).toEqual([]);
}

test.beforeEach(async ({ page }) => {
  await page.route('http://127.0.0.1:9124/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const body =
      url.pathname === '/health'
        ? { ok: true, service: 'Test Print Bridge', ledger: 'ready' }
        : url.pathname === '/v1/printers'
          ? { printers: [] }
          : url.pathname === '/v1/setup-status'
            ? { ok: true, ledger: 'ready', printerCount: 0 }
            : url.pathname === '/v1/config'
              ? { config: { printers: [], routes: [] } }
              : { ok: true };
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify(body),
    });
  });
});

test('orders page loads with expected title', async ({ page }) => {
  await page.goto('/orders.html');
  await expect(page).toHaveTitle(/Red Lantern Orders/i);
  await expect(page.getByRole('navigation', { name: 'Orders workspace' })).toBeVisible();
  await expect(page.locator('#orders')).toHaveCount(1);
});

test('occupied table details and actions stay contained inside the table card', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      'red-lantern-table-allocation',
      JSON.stringify([{ id: 'non-ac', name: 'NON AC', from: 1, to: 2 }])
    );
  });
  await page.route(/\/api\/orders\?.*/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        {
          id: 'table-order-1',
          mode: 'table',
          table_area: 'NON AC',
          table_number: 1,
          status: 'accepted',
          created_at: new Date().toISOString(),
          customer_name: 'Walk-in customer',
          total: 270,
          items: [],
        },
      ]),
    });
  });

  await page.goto('/orders.html');
  const occupied = page.locator('.table-tile.is-running');
  await expect(occupied).toBeVisible();

  const layout = await occupied.evaluate((card) => {
    const box = (node) => {
      const bounds = node.getBoundingClientRect();
      return {
        left: bounds.left,
        top: bounds.top,
        right: bounds.right,
        bottom: bounds.bottom,
        width: bounds.width,
        height: bounds.height,
      };
    };
    return {
      card: box(card),
      heading: box(card.querySelector('.table-tile-top')),
      status: box(card.querySelector('.table-tile-top em')),
      info: box(card.querySelector('.table-tile-info')),
      guest: box(card.querySelector('.table-tile-info small')),
      amount: box(card.querySelector('.table-tile-info strong')),
      actions: box(card.parentElement.querySelector('.table-tile-actions')),
      action: box(card.parentElement.querySelector('.table-tile-action')),
    };
  });

  expect(layout.status.left).toBeGreaterThanOrEqual(layout.card.left);
  expect(layout.status.right).toBeLessThanOrEqual(layout.card.right);
  expect(layout.info.top).toBeGreaterThanOrEqual(layout.heading.bottom);
  expect(layout.info.right).toBeLessThanOrEqual(layout.card.right);
  expect(layout.guest.right).toBeLessThanOrEqual(layout.card.right);
  expect(layout.guest.bottom).toBeLessThanOrEqual(layout.actions.top);
  expect(layout.amount.right).toBeLessThanOrEqual(layout.actions.left);
  expect(layout.actions.right).toBeLessThanOrEqual(layout.card.right);
  expect(layout.actions.bottom).toBeLessThanOrEqual(layout.card.bottom);
  expect(layout.action.width).toBeGreaterThanOrEqual(34);
  expect(layout.action.height).toBeGreaterThanOrEqual(34);

  const availableOrder = await page.locator('.table-tile.is-blank').evaluate((card) => {
    const number = card.querySelector('.table-tile-top b').getBoundingClientRect();
    const label = card.querySelector(':scope > small').getBoundingClientRect();
    return { numberBottom: number.bottom, labelTop: label.top };
  });
  expect(availableOrder.labelTop).toBeGreaterThanOrEqual(availableOrder.numberBottom);
});

test('orders tables and live-order cards remain contained on desktop and phone widths', async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      'red-lantern-table-allocation',
      JSON.stringify([
        { id: 'restaurant-outdoor', name: 'OUTDOOR FAMILY DINING AREA', from: 1, to: 3 },
      ])
    );
  });
  await page.route(/\/api\/orders\?.*/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        {
          id: 'a-very-long-order-reference-that-must-not-break-the-card-layout',
          mode: 'table',
          table_area: 'OUTDOOR FAMILY DINING AREA',
          table_number: 1,
          status: 'preparing',
          created_at: new Date().toISOString(),
          customer_name: 'A customer name deliberately long enough to require safe truncation',
          customer_phone: '9999999999',
          special_request:
            'Please prepare this carefully with a long operational note that must wrap inside the card.',
          total: 1270,
          items: [
            {
              name: 'Extra long restaurant dish name with preparation details',
              quantity: 2,
              price: 635,
            },
          ],
        },
      ]),
    });
  });

  for (const viewport of [
    { width: 1280, height: 900 },
    { width: 360, height: 780 },
  ]) {
    await page.setViewportSize(viewport);
    await page.goto('/orders.html');
    await page.locator('[data-orders-rail="tables"]').click();
    await expect(page.locator('.table-tile.is-running, .table-tile.is-kot')).toBeVisible();
    await expectNoPageOverflow(page);
    await expectContained(page, '.table-tile-wrap');

    await page.locator('[data-orders-rail="live"]').click();
    await expect(page.locator('.order')).toBeVisible();
    await expectNoPageOverflow(page);
    await expectContained(page, '.order');
  }
});

test('captain page loads with login screen', async ({ page }) => {
  await page.goto('/captain.html');
  await expect(page).toHaveTitle(/Captain/i);
  await expect(page.locator('#captain-login')).toBeVisible();
  await expect(page.locator('#captain-account-list')).toBeVisible();
});

test('captain table board and menu cards stay contained on desktop and phone widths', async ({
  page,
}) => {
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    let body = {};
    if (url.pathname === '/api/captain/accounts') {
      body = {
        captains: [
          {
            id: 'captain-1',
            name: 'Captain With A Long Display Name',
            areas: ['OUTDOOR FAMILY DINING AREA'],
          },
        ],
      };
    } else if (url.pathname === '/api/captain/login') {
      body = {
        token: 'test-token',
        captain: {
          id: 'captain-1',
          name: 'Captain With A Long Display Name',
          areas: ['OUTDOOR FAMILY DINING AREA'],
          idleMinutes: 120,
        },
      };
    } else if (url.pathname === '/api/orders/operations') {
      body = {
        config: {
          tableAreas: [
            { id: 'restaurant-outdoor', name: 'OUTDOOR FAMILY DINING AREA', from: 1, to: 4 },
          ],
        },
      };
    } else if (url.pathname === '/api/orders/menu') {
      body = [
        {
          key: 'dish-1',
          name: 'Extra long restaurant dish name with preparation details',
          category: 'CHEF SPECIAL RECOMMENDATIONS WITH A LONG CATEGORY NAME',
          price: 495,
        },
      ];
    } else if (url.pathname === '/api/orders') {
      body = [
        {
          id: 'captain-table-order-1',
          captain_id: 'captain-1',
          mode: 'table',
          table_area: 'OUTDOOR FAMILY DINING AREA',
          table_number: 1,
          status: 'preparing',
          created_at: new Date().toISOString(),
          items: [],
          total: 495,
        },
      ];
    } else if (url.pathname === '/api/orders/availability') {
      body = [];
    } else if (url.pathname === '/api/captain/menu-insights') {
      body = { items: [] };
    } else if (url.pathname === '/api/captain/ready-alerts') {
      body = { alerts: [] };
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });

  await page.goto('/captain.html');
  await page.locator('[data-captain-id="captain-1"]').click();
  await page.locator('#captain-pin').fill('1234');
  await page.locator('#captain-pin-form').dispatchEvent('submit');
  await expect(page.locator('.captain-app')).toBeVisible();
  await expect(page.locator('#table-board .table-tile')).toHaveCount(4);

  for (const viewport of [
    { width: 1280, height: 900 },
    { width: 360, height: 780 },
  ]) {
    await page.setViewportSize(viewport);
    await expectNoPageOverflow(page);
    await expectContained(page, '#table-board .table-tile');

    await page.locator('#table-board .table-tile').nth(1).click();
    await expect(page.locator('#menu-screen')).toBeVisible();
    await expect(page.locator('.menu-item')).toBeVisible();
    await expectNoPageOverflow(page);
    await expectContained(page, '.menu-item');
    await page.locator('[data-captain-back]').first().click();
    await expect(page.locator('#tables-screen')).toBeVisible();
  }
});

test('an urgent order event refreshes the billing console without waiting for the fallback poll', async ({
  page,
}) => {
  let orderReads = 0;
  await page.route(/\/api\/orders\?.*/, async (route) => {
    orderReads += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: '[]',
    });
  });
  await page.goto('/orders.html');
  const readsBeforeEvent = orderReads;
  await page.evaluate(() => window.requestFastOrdersRefresh());
  await expect.poll(() => orderReads, { timeout: 500 }).toBeGreaterThan(readsBeforeEvent);
});

test('a bill is sent once to every configured Bill printer with its own settings', async ({
  page,
}) => {
  const billJobs = [];
  await page.route('http://127.0.0.1:4173/api/orders/operations', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        config: {
          printers: [
            {
              id: 'bill-front',
              name: 'Front Bill',
              capabilities: ['bill'],
              type: 'bill',
              deviceName: 'Front Queue',
              paperWidth: 80,
            },
            {
              id: 'bill-backup',
              name: 'Backup Bill',
              capabilities: ['bill', 'kot'],
              type: 'kot',
              deviceName: 'Backup Queue',
              paperWidth: 80,
              formats: {
                bill: { paperWidth: 58, fontFamily: 'Georgia' },
                kot: { paperWidth: 80, fontFamily: 'Consolas' },
              },
            },
          ],
          routes: [],
        },
        menu: [],
      }),
    });
  });
  await page.route('http://127.0.0.1:4173/api/orders/order-1/print', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        id: 'order-1',
        created_at: '2026-08-31T12:00:00.000Z',
        items: [{ name: 'Test item', quantity: 1, price: 100 }],
        total: 100,
      }),
    });
  });
  await page.goto('/orders.html');
  await page.unroute('http://127.0.0.1:9124/**');
  await page.route('http://127.0.0.1:9124/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/v1/print-bill') billJobs.push(route.request().postDataJSON());
    await route.fulfill({
      status: pathname === '/v1/print-bill' ? 201 : 200,
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: pathname === '/v1/printers' ? '{"printers":[]}' : '{"ok":true}',
    });
  });
  await page.evaluate(() => window.printOrder('order-1'));

  expect(billJobs).toHaveLength(2);
  expect(billJobs.map((job) => job.printerName).sort()).toEqual([
    'Backup Queue',
    'Front Queue',
  ]);
  expect(new Set(billJobs.map((job) => job.printJobId)).size).toBe(2);
  expect(billJobs.find((job) => job.printerName === 'Front Queue').settings.paperWidth).toBe(80);
  expect(billJobs.find((job) => job.printerName === 'Backup Queue').settings.paperWidth).toBe(58);
  expect(billJobs.find((job) => job.printerName === 'Backup Queue').settings.fontFamily).toBe(
    'Georgia'
  );
});

test('one routed KOT can be dispatched concurrently to multiple printer queues', async ({ page }) => {
  const kotJobs = [];
  await page.route('http://127.0.0.1:4173/api/orders/operations', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        config: {
          printers: [
            {
              id: 'kitchen',
              name: 'Kitchen',
              capabilities: ['kot'],
              deviceName: 'Kitchen Queue',
              formats: { kot: { fontFamily: 'Arial' } },
            },
            {
              id: 'expo',
              name: 'Expo',
              capabilities: ['kot'],
              deviceName: 'Expo Queue',
              formats: { kot: { fontFamily: 'Consolas' } },
            },
          ],
          routes: [],
        },
        menu: [],
      }),
    });
  });
  await page.route('http://127.0.0.1:4173/api/orders/order-2/kots', async (route) => {
    const item = { name: 'Mirrored item', category: 'STARTER', quantity: 1 };
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({
        kotNumber: 12,
        order: { id: 'order-2', daily_order_number: 2, mode: 'table' },
        tickets: [
          {
            printerId: 'kitchen',
            printerName: 'Kitchen Queue',
            printerLabel: 'Kitchen',
            items: [item],
          },
          {
            printerId: 'expo',
            printerName: 'Expo Queue',
            printerLabel: 'Expo',
            items: [item],
          },
        ],
      }),
    });
  });
  await page.goto('/orders.html');
  await page.unroute('http://127.0.0.1:9124/**');
  await page.route('http://127.0.0.1:9124/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/v1/print-kot') kotJobs.push(route.request().postDataJSON());
    await route.fulfill({
      status: pathname === '/v1/print-kot' ? 201 : 200,
      contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ ok: true }),
    });
  });

  const result = await page.evaluate(() =>
    window.autoPrintOrder({ id: 'order-2', mode: 'table', status: 'accepted' })
  );
  expect(result.ok).toBe(true);
  expect(kotJobs).toHaveLength(2);
  expect(kotJobs.map((job) => job.printerName).sort()).toEqual(['Expo Queue', 'Kitchen Queue']);
  expect(kotJobs.find((job) => job.printerName === 'Expo Queue').settings.fontFamily).toBe(
    'Consolas'
  );
});
