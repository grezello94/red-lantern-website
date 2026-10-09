const { test, expect } = require('@playwright/test');

const tabs = [
  'home',
  'menu',
  'about',
  'blogs',
  'contact',
  'footer',
  'customer-insights',
  'captain-app',
  'smart-kds',
  'air-menu',
  'trusted-contacts',
  'growth',
  'qr-scans',
  'logs',
  'orders-errors',
  'database-health',
];

function fixture() {
  return {
    home: {
      heroTitle: 'Welcome to Red Lantern',
      heroSubtitle: 'Fresh Goan food',
      welcomeTitle: 'Garden dining',
      welcomeText: 'Dinner beneath the lanterns',
      featureOneTitle: 'Fresh food',
      featureOneText: 'Made to order',
      reviews: [{ name: 'Guest', text: 'A wonderful dinner', stars: '★★★★★' }],
    },
    menu: {},
    about: {},
    blogs: {},
    contact: {
      address: 'Colva, Goa',
      phone: '9876543210',
      email: 'hello@example.test',
      hours: '12:30–00:00',
    },
    global: { footerDescription: 'Family dining in Goa', seoTitle: 'Red Lantern Restaurant' },
    airMenu: {
      pageTitle: 'Our Garden Menu',
      pageSubtitle: 'Fresh food and drinks',
      note: 'Ask about today’s specials.',
      items: [
        { name: 'Tomato Soup', category: 'SOUP', price: '₹120', type: 'food', dietary: 'veg' },
        { name: 'Mushroom Soup', category: 'SOUP', price: '₹130', type: 'food', dietary: 'veg' },
        {
          name: 'Chicken Pepper Wings Special',
          category: 'NON VEG STARTER',
          price: '₹250',
          type: 'food',
          dietary: 'nonveg',
        },
        {
          name: 'Veg Crispy',
          category: 'VEG STARTER',
          price: '₹200',
          type: 'food',
          dietary: 'veg',
        },
      ],
      barItems: [
        { name: 'Kingfisher', category: 'BEER', price: '₹220', type: 'beverage' },
        { name: 'House Red Wine', category: 'WINE', price: '₹300', type: 'beverage' },
      ],
      categoryOrder: ['SOUP', 'NON VEG STARTER', 'VEG STARTER', 'BEER', 'WINE'],
      proximity: {
        locked: true,
        latitude: 15.2789,
        longitude: 73.9221,
        tableRadius: 100,
        cardRadius: 0,
      },
      loyalty: { spend: 10, earn: 1, minRedeem: 100, pointValue: 1, enabled: true },
      addonGroups: [
        {
          id: 'extras',
          name: 'Extras',
          displayName: 'Choose extras',
          selection: 'multiple',
          min: 0,
          max: 2,
          active: true,
          assignedItemKeys: [],
          options: [
            { id: 'cheese', name: 'Cheese', price: 50, dietary: 'veg', active: true },
            { id: 'olive', name: 'Olives', price: 30, dietary: 'veg', active: true },
          ],
        },
      ],
    },
  };
}

function analytics(url) {
  return {
    generatedAt: '2026-10-08T12:00:00Z',
    range: {
      preset: url.searchParams.get('preset') || 'today',
      label: 'Today',
      from: '2026-10-08',
      to: '2026-10-08',
      days: 1,
    },
    summary: {
      net_sales: 12500,
      collected: 11750,
      outstanding: 750,
      completed_bills: 24,
      average_bill: 521,
      total_orders: 28,
      order_value: 13200,
      live_orders: 2,
      cancelled_orders: 1,
      rejected_orders: 1,
      tips: 180,
    },
    comparison: { sales: 12, bills: 9, averageBill: 3 },
    channels: [
      { channel: 'dine_in', bills: 15, sales: 8000 },
      { channel: 'takeaway', bills: 9, sales: 4500 },
    ],
    payments: [
      { payment_type: 'upi', bills: 16, amount: 8000 },
      { payment_type: 'cash', bills: 8, amount: 3750 },
    ],
    trend: [{ day: '2026-10-08', bills: 24, sales: 12500 }],
    topItems: [
      { name: 'Chicken Pepper Wings Special', portion: 'Regular', quantity: 18, sales: 4500 },
    ],
    recentOrders: [
      {
        daily_order_number: 28,
        bill_number: 1028,
        mode: 'table',
        table_area: 'NON AC',
        table_number: 3,
        total: 920,
        status: 'completed',
        settlement_type: 'part',
        payment_methods: ['cash', 'upi'],
        created_at: '2026-10-08T11:00:00Z',
      },
    ],
    kots: {
      summary: { total_kots: 30, cancelled_kots: 2, modified_kots: 3, shifted_kots: 1 },
      exceptions: [],
    },
    bills: {
      summary: {
        issued_bills: 28,
        completed_bills: 24,
        cancelled_bills: 1,
        modified_bills: 1,
        printed_bills: 24,
      },
      exceptions: [],
    },
    definitions: {},
  };
}

const kitchenConfig = {
  displayMode: 'normal',
  mode: 'shadow',
  courseOrder: ['soup', 'starter', 'main'],
  courseDefaults: {
    soup: { targetMin: 5, targetMax: 10, spacingAfterMin: 2 },
    starter: { targetMin: 10, targetMax: 15, spacingAfterMin: 3 },
    main: { targetMin: 15, targetMax: 25, spacingAfterMin: 0 },
  },
  timing: {
    platingMinutes: 2,
    handoffBufferMinutes: 1,
    courseReadyToleranceMinutes: 3,
    parcelDefaultTargetMinutes: 20,
  },
  batching: { defaultWindowSeconds: 30, defaultMaxBatchSize: 4 },
  fairness: { starvationAfterMinutes: 10 },
  serviceRisk: { firstFoodAfterMinutes: 15, serviceGapAfterMinutes: 10 },
  riskThresholds: { watchMinutes: 5, startSoonMinutes: 2, criticalOverdueMinutes: 10 },
};

async function mockAdmin(page, options = {}) {
  const content = options.content || fixture();
  const requests = [];
  let qrEnabled = true;
  let accounts = options.accounts || [
    {
      id: 'cap_lalit',
      name: 'Lalit',
      role: 'captain',
      areas: ['AC'],
      tableScope: 'own',
      active: true,
      pinConfigured: true,
      pinViewable: true,
    },
  ];
  let employeeSettings = { idleMinutes: 15 };
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    requests.push(request);
    options.onRequest?.(request, url);
    let body = {},
      contentType = 'application/json',
      status = 200;
    if (url.pathname === '/api/admin/content') {
      await options.beforeContentLoad?.(request, url);
      status = options.failContentLoad?.() ? 503 : 200;
      body = status === 503 ? { error: 'Saved content temporarily unavailable' } : content;
    } else if (url.pathname.startsWith('/api/update-')) {
      await options.beforeSave?.(request, url);
      status = options.failSave?.() ? 500 : 200;
      body = status === 500 ? 'Save service temporarily unavailable' : 'Saved';
      contentType = 'text/plain';
    } else if (url.pathname === '/api/admin/analytics') body = analytics(url);
    else if (url.pathname === '/api/admin/captains') {
      if (request.method() === 'PUT') {
        const snapshot = request.postDataJSON();
        await options.beforeCaptainSave?.(request, url);
        status = options.failCaptainSave?.() ? 500 : 200;
        if (status === 200) {
          accounts = snapshot.captains.map((account) => ({
            ...account,
            pin: '',
            password: '',
            pinConfigured: account.pinConfigured || !!account.pin,
            pinViewable: true,
          }));
          employeeSettings = snapshot.settings;
        }
      } else await options.beforeCaptainLoad?.(request, url);
      body =
        status === 500
          ? { error: 'Employee service temporarily unavailable' }
          : { captains: accounts, areas: ['AC', 'NON AC', 'BAR'], settings: employeeSettings };
    } else if (url.pathname === '/api/admin/captains/activity')
      body = { captains: [{ id: 'cap_lalit', name: 'Lalit' }], areas: ['AC'], events: [] };
    else if (url.pathname === '/api/admin/customer-insights')
      body = { orders: [], customers: [], leaderboard: [], summary: { points: 0, credit: 0 } };
    else if (url.pathname === '/api/admin/trusted-contacts')
      body = {
        contacts: [
          {
            customer_phone: '9876543210',
            customer_name: 'A returning guest with a deliberately lengthy name',
            blocked: false,
            last_items: [{ name: 'Chicken Pepper Wings Special', quantity: 2 }],
            last_order_at: '2026-10-08T12:00:00Z',
          },
        ],
        page: 1,
        limit: 50,
        total: 1,
      };
    else if (url.pathname === '/api/admin/health')
      body = {
        ok: true,
        checkedAt: '2026-10-08T12:00:00Z',
        checks: {
          database: { ok: true, message: 'Connected' },
          printer: { ok: true, message: 'Printer service available' },
        },
        databaseMetrics: {
          latencyMs: 32,
          sizeBytes: 123456789,
          latestOrderAt: '2026-10-08T12:00:00Z',
          counts: {
            orders: 10428,
            payments: 10300,
            kots: 13128,
            printerConfigs: 4,
            unavailableItems: 3,
            loyaltyAccounts: 526,
            alertDevices: 4,
          },
        },
      };
    else if (url.pathname === '/api/admin/qr-scans')
      body = {
        summary: {
          total_scans: 984,
          scans_24h: 43,
          unique_24h: 28,
          table_scans: 632,
          card_scans: 352,
        },
        scans: [
          {
            created_at: '2026-10-08T12:00:00Z',
            ip_hash: 'anonymous-visitor',
            visitor_scan_count: 2,
            details: {
              qrType: 'Table QR',
              city: 'Colva',
              region: 'Goa',
              country: 'India',
              mode: 'table',
            },
          },
        ],
      };
    else if (url.pathname === '/api/admin/logs')
      body = {
        logs: [
          {
            id: 'log-1',
            level: 'info',
            message: 'Website content saved',
            created_at: '2026-10-08T12:00:00Z',
            source: 'Admin workspace',
            details: { section: 'Air Menu', note: 'longvalue'.repeat(30) },
          },
        ],
      };
    else if (url.pathname === '/api/admin/orders-errors') body = { logs: [] };
    else if (url.pathname === '/api/admin/table-qr-codes')
      body = { codes: [{ areaId: 'ac', areaName: 'AC', tableNumber: 1, enabled: qrEnabled }] };
    else if (url.pathname === '/api/admin/table-qr-codes/ac/1') {
      qrEnabled = request.postDataJSON().enabled;
      body = { ok: true };
    } else if (url.pathname.startsWith('/api/admin/qr/')) {
      body =
        '<svg xmlns="http://www.w3.org/2000/svg" width="132" height="132"><rect width="132" height="132" fill="white"/><path fill="black" d="M8 8h40v40H8zM84 8h40v40H84zM8 84h40v40H8zM66 66h26v26H66z"/></svg>';
      contentType = 'image/svg+xml';
    } else if (url.pathname === '/api/admin/air-menu/extract')
      body = {
        fileName: 'food.csv',
        extractionMethod: 'csv',
        items: [
          {
            name: 'Roasted Tomato Soup',
            category: 'SOUP',
            price: '₹160',
            type: 'food',
            dietary: 'veg',
          },
        ],
      };
    else if (url.pathname === '/api/admin/air-menu/extract-bar')
      body = {
        fileName: 'bar.csv',
        extractionMethod: 'csv',
        items: [{ name: 'Craft Lager', category: 'BEER', price: '₹280', type: 'beverage' }],
      };
    else if (url.pathname === '/api/admin/smart-kds/config')
      body = {
        config: request.method() === 'PUT' ? request.postDataJSON().config : kitchenConfig,
        stations: [
          {
            station_id: 'kitchen',
            station_name: 'Kitchen',
            printer_id: 'kitchen-printer',
            max_concurrent_tasks: 3,
            enabled: true,
          },
        ],
        message: 'Smart KDS is staff-controlled.',
      };
    else if (url.pathname === '/api/admin/smart-kds/profiles')
      body = { items: [], stations: [], coverage: {} };
    else if (url.pathname.startsWith('/api/admin/smart-kds/'))
      body = {
        stations: [],
        summary: {},
        orders: [],
        tasks: [],
        recommendations: [],
        courses: [],
        audit: [],
        message: 'No active kitchen work',
        rangeDays: 30,
      };
    await route.fulfill({
      status,
      contentType,
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });
  });
  return requests;
}

function fieldValues(request, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`name="${escaped}"\\r\\n\\r\\n([\\s\\S]*?)\\r\\n--`, 'g');
  return [...String(request.postDataBuffer()).matchAll(pattern)].map((match) => match[1]);
}

async function goToTab(page, tab) {
  const nav = page.locator(`.sidebar .nav-item[data-target="tab-${tab}"]`);
  if (!(await nav.isVisible())) await page.locator('#admin-nav-toggle').click();
  await nav.click();
  await expect(page.locator(`#tab-${tab}`)).toHaveClass(/active/);
  await expect(nav).toHaveAttribute('aria-current', 'page');
}

async function expectNoOverflow(page, label = '') {
  const result = await page.evaluate(() => ({
    viewport: innerWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }));
  expect(result.document, `${label}: document width`).toBeLessThanOrEqual(result.viewport);
  expect(result.body, `${label}: body width`).toBeLessThanOrEqual(result.viewport);
}

async function publish(page, action) {
  const form = page.locator(`form[action="${action}"]`);
  await form.locator('button[type="submit"]').click();
  await expect(page.locator('#admin-save-toast')).toHaveClass(/is-visible/);
}

test('saved content loading keeps menu and website editors locked until their existing data is ready', async ({
  page,
}) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const requests = await mockAdmin(page, { beforeContentLoad: () => gate });
  await page.goto('/admin.html#tab-air-menu');
  const form = page.locator('form[action="/api/update-airMenu"]');
  await expect(form).toHaveAttribute('data-admin-content-state', 'loading');
  await expect(page.locator('[name="airMenuTitle"]')).toBeDisabled();
  await expect(page.locator('#air-menu-file')).toBeDisabled();
  await expect(page.locator('#extract-air-menu')).toBeDisabled();
  await expect(form.locator('button[type="submit"]')).toBeDisabled();
  await form.evaluate((element) =>
    element.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  );
  await goToTab(page, 'home');
  await expect(page.locator('#heroTitle')).toBeDisabled();
  expect(
    requests.filter((request) => new URL(request.url()).pathname.startsWith('/api/update-'))
  ).toHaveLength(0);
  release();
  await expect(page.locator('#heroTitle')).toHaveValue('Welcome to Red Lantern');
  await expect(page.locator('#heroTitle')).toBeEnabled();
  await expect(form).toHaveAttribute('data-admin-content-state', 'ready');
  await expect(page.locator('.admin-content-load-status')).toBeHidden();
  await goToTab(page, 'air-menu');
  await expect(page.locator('[name="airMenuTitle"]')).toHaveValue('Our Garden Menu');
  await expect(page.locator('#air-menu-file')).toBeEnabled();
  await expect(page.locator('[name="airProximityLatitude"]')).toHaveJSProperty('readOnly', true);
  await expect(page.locator('[name="airProximityLongitude"]')).toHaveJSProperty('readOnly', true);
  await expect(page.locator('[name="airProximityLatitude"]')).toHaveClass(/is-locked/);
});

test('failed content loading blocks accidental saves and Retry restores the saved website fields', async ({
  page,
}) => {
  let fail = true;
  const requests = await mockAdmin(page, { failContentLoad: () => fail });
  await page.goto('/admin.html');
  const form = page.locator('form[action="/api/update-home"]');
  await expect(form).toHaveAttribute('data-admin-content-state', 'error');
  await expect(page.locator('.admin-content-load-status')).toContainText(
    'Saved content could not be loaded'
  );
  await expect(page.locator('#heroTitle')).toBeDisabled();
  await expect(form.locator('button[type="submit"]')).toBeDisabled();
  await form.evaluate((element) =>
    element.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  );
  expect(
    requests.filter((request) => new URL(request.url()).pathname === '/api/update-home')
  ).toHaveLength(0);
  fail = false;
  await page.locator('.admin-content-load-retry').click();
  await expect(form).toHaveAttribute('data-admin-content-state', 'ready');
  await expect(page.locator('#heroTitle')).toHaveValue('Welcome to Red Lantern');
  await expect(page.locator('#heroTitle')).toBeEnabled();
  expect(
    requests.filter((request) => new URL(request.url()).pathname === '/api/admin/content')
  ).toHaveLength(2);
});

test('content retry keeps the active workspace and independent employee drafts intact', async ({
  page,
}) => {
  let fail = true;
  const requests = await mockAdmin(page, { failContentLoad: () => fail });
  await page.goto('/admin.html#tab-captain-app');
  await expect(page.locator('.admin-content-load-retry')).toBeVisible();
  await expect(page.locator('[data-captain-name="0"]')).toHaveValue('Lalit');
  await expect(page.locator('[data-captain-name="0"]')).toBeEnabled();
  await page.locator('[data-captain-name="0"]').fill('Lalit Garden Captain');
  const loads = requests.filter(
    (request) =>
      new URL(request.url()).pathname === '/api/admin/captains' && request.method() === 'GET'
  ).length;
  fail = false;
  await page.locator('.admin-content-load-retry').click();
  await expect(page.locator('.admin-content-load-status')).toBeHidden();
  await expect(page.locator('#tab-captain-app')).toHaveClass(/active/);
  await expect(page).toHaveURL(/#tab-captain-app$/);
  await expect(page.locator('[data-captain-name="0"]')).toHaveValue('Lalit Garden Captain');
  expect(
    requests.filter(
      (request) =>
        new URL(request.url()).pathname === '/api/admin/captains' && request.method() === 'GET'
    )
  ).toHaveLength(loads);
});

test('all admin destinations remain accessible and expose the active workspace', async ({
  page,
}) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await mockAdmin(page);
  await page.goto('/admin.html');
  await expect(page.locator('body')).toHaveClass(/admin-workspace/);
  await expect(page.locator('.sidebar .admin-nav-icon')).toHaveCount(17);
  await expect(page.locator('.sidebar [data-target="tab-sales-dashboard"]')).toHaveAttribute(
    'href',
    '/dashboard'
  );
  for (const tab of tabs) {
    await goToTab(page, tab);
    await expect(page.locator('.sidebar [aria-current="page"]')).toHaveCount(1);
    await expect(page.locator('#admin-workspace-title')).toHaveText(
      await page.locator(`#tab-${tab} > .header h1`).innerText()
    );
    await expect(page).toHaveURL(new RegExp(`#tab-${tab}$`));
  }
  expect(errors).toEqual([]);
});

test('sidebar search filters destinations without changing the current draft', async ({ page }) => {
  await mockAdmin(page);
  await page.goto('/admin.html');
  await expect(page.locator('#heroTitle')).toHaveValue('Welcome to Red Lantern');
  await page.locator('#heroTitle').fill('A draft to preserve');
  const search = page.locator('#admin-sidebar-search');
  await search.fill('air menu');
  await expect(page.locator('.sidebar .nav-item:visible')).toHaveCount(1);
  await expect(page.locator('.sidebar .nav-item:visible')).toContainText('Air Menu');
  await expect(page.locator('#tab-home')).toHaveClass(/active/);
  await search.fill('zz-no-matching-section');
  await expect(page.locator('.sidebar .nav-item:visible')).toHaveCount(0);
  await expect(page.locator('#admin-nav-empty')).toBeVisible();
  await search.fill('');
  await expect(page.locator('.sidebar .nav-item:visible')).toHaveCount(17);
  await expect(page.locator('#admin-nav-empty')).toBeHidden();
  await expect(page.locator('#heroTitle')).toHaveValue('A draft to preserve');
});

test('navigation works from the keyboard and restores a direct link after refresh', async ({
  page,
}) => {
  await mockAdmin(page);
  await page.goto('/admin.html#tab-contact');
  const menu = page.locator('.sidebar [data-target="tab-menu"]');
  await expect(menu).toHaveAttribute('role', 'button');
  await menu.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#tab-menu')).toHaveClass(/active/);
  const air = page.locator('.sidebar [data-target="tab-air-menu"]');
  await air.focus();
  await page.keyboard.press('Space');
  await expect(page.locator('#tab-air-menu')).toHaveClass(/active/);
  await page.reload();
  await expect(page.locator('#tab-air-menu')).toHaveClass(/active/);
  await expect(air).toHaveAttribute('aria-current', 'page');
});

test('mobile navigation exposes search and closes after selection or Escape', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockAdmin(page);
  await page.goto('/admin.html');
  const toggle = page.locator('#admin-nav-toggle');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#admin-sidebar-search')).toBeVisible();
  await page.locator('#admin-sidebar-search').fill('captain');
  await page.locator('.sidebar [data-target="tab-captain-app"]').click();
  await expect(page.locator('#tab-captain-app')).toHaveClass(/active/);
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  await page.keyboard.press('Escape');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expectNoOverflow(page);
});

test('section shortcuts preserve website fields and submit the complete existing form', async ({
  page,
}) => {
  const requests = await mockAdmin(page);
  await page.goto('/admin.html');
  await expect(page.locator('#heroTitle')).toHaveValue('Welcome to Red Lantern');
  await page.locator('#heroTitle').fill('Garden dining, reimagined');
  const jump = page.locator('#tab-home .admin-section-nav a').last();
  const target = await jump.getAttribute('href');
  await jump.click();
  await expect(page.locator(target)).toBeVisible();
  await expect(page).toHaveURL(/admin\.html$/);
  await page.locator('[name="blogSectionTitle"]').fill('Stories from the garden');
  await expect(page.locator('#heroTitle')).toHaveValue('Garden dining, reimagined');
  await publish(page, '/api/update-home');
  const saved = requests.find((request) => new URL(request.url()).pathname === '/api/update-home');
  expect(saved.method()).toBe('POST');
  expect(fieldValues(saved, 'heroTitle')).toEqual(['Garden dining, reimagined']);
  expect(fieldValues(saved, 'welcomeText')).toEqual(['Dinner beneath the lanterns']);
  expect(fieldValues(saved, 'blogSectionTitle')).toEqual(['Stories from the garden']);
  expect(fieldValues(saved, 'reviewName[]')).toEqual(['Guest']);
});

test('Food and Bar imports replace their own categories and retain all settings on publish', async ({
  page,
}) => {
  const requests = await mockAdmin(page);
  await page.goto('/admin.html#tab-air-menu');
  await expect(page.locator('#air-food-sheet-count')).toHaveText('4 items');
  await page.locator('[name="airMenuTitle"]').fill('Red Lantern · Night Garden');
  await page.locator('#air-menu-file').setInputFiles({
    name: 'food.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('name,category,price\nRoasted Tomato Soup,SOUP,160'),
  });
  await page.locator('#extract-air-menu').click();
  await expect(page.locator('#air-extract-status')).toContainText(
    'Other categories were preserved'
  );
  await page.locator('#air-bar-menu-file').setInputFiles({
    name: 'bar.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('name,category,price\nCraft Lager,BEER,280'),
  });
  await page.locator('#extract-air-bar-menu').click();
  await expect(page.locator('#air-bar-extract-status')).toContainText(
    'Other bar categories were preserved'
  );
  await publish(page, '/api/update-airMenu');
  const saved = requests.find(
    (request) => new URL(request.url()).pathname === '/api/update-airMenu'
  );
  expect(fieldValues(saved, 'airItemName[]')).toEqual(
    expect.arrayContaining(['Roasted Tomato Soup', 'Chicken Pepper Wings Special', 'Veg Crispy'])
  );
  expect(fieldValues(saved, 'airItemName[]')).not.toContain('Tomato Soup');
  expect(fieldValues(saved, 'airBarItemName[]')).toEqual(
    expect.arrayContaining(['Craft Lager', 'House Red Wine'])
  );
  expect(fieldValues(saved, 'airBarItemName[]')).not.toContain('Kingfisher');
  expect(fieldValues(saved, 'airMenuTitle')).toEqual(['Red Lantern · Night Garden']);
  expect(fieldValues(saved, 'airSourceFileName')).toEqual(['food.csv']);
  expect(fieldValues(saved, 'airBarSourceFileName')).toEqual(['bar.csv']);
  expect(fieldValues(saved, 'airLoyaltySpend')).toEqual(['10']);
  expect(fieldValues(saved, 'airTableProximityRadius')).toEqual(['100']);
  expect(fieldValues(saved, 'airProximityLatitude')).toEqual(['15.2789']);
  expect(fieldValues(saved, 'airProximityLongitude')).toEqual(['73.9221']);
  expect(JSON.parse(fieldValues(saved, 'airAddonGroups')[0])[0].name).toBe('Extras');
});

test('Air Menu workflow steps navigate to the right work without publishing a draft', async ({
  page,
}) => {
  const requests = await mockAdmin(page);
  await page.goto('/admin.html#tab-air-menu');
  await expect(page.locator('#air-food-sheet-count')).toHaveText('4 items');
  await page.locator('[name="airMenuTitle"]').fill('A review draft');
  await page.locator('[data-admin-workflow="review"]').click();
  await expect(page.locator('details.air-menu-sheet')).toHaveAttribute('open', '');
  await expect(page.locator('#air-items-container .air-item-entry')).toHaveCount(4);
  await page.locator('[data-admin-workflow="publish"]').click();
  await expect(page.locator('#tab-air-menu .admin-save-bar')).toBeVisible();
  await expect(page.locator('[name="airMenuTitle"]')).toHaveValue('A review draft');
  expect(
    requests.filter((request) => new URL(request.url()).pathname === '/api/update-airMenu')
  ).toHaveLength(0);
  await expect(page).toHaveURL(/#tab-air-menu$/);
});

test('cancelling an empty Air Menu confirmation does not publish or clear the live menu', async ({
  page,
}) => {
  const content = fixture();
  content.airMenu.items = [];
  content.airMenu.barItems = [];
  await mockAdmin(page, { content });
  await page.goto('/admin.html#tab-air-menu');
  await expect(page.locator('#air-food-sheet-count')).toHaveText('0 items');
  let confirmations = 0;
  page.on('dialog', async (dialog) => {
    confirmations += 1;
    await dialog.dismiss();
  });
  const sent = page
    .waitForRequest((request) => new URL(request.url()).pathname === '/api/update-airMenu', {
      timeout: 700,
    })
    .then(
      () => true,
      () => false
    );
  await page.locator('form[action="/api/update-airMenu"] button[type="submit"]').click();
  expect(await sent).toBe(false);
  expect(confirmations).toBe(1);
  await expect(page.locator('#admin-save-toast')).toBeHidden();
});

test('Air shortcuts open the food sheet and edits, category visibility and add-ons reach the saved payload', async ({
  page,
}) => {
  const requests = await mockAdmin(page);
  await page.goto('/admin.html#tab-air-menu');
  await expect(page.locator('#air-food-sheet-count')).toHaveText('4 items');
  await expect(page.locator('#air-items-container .air-item-entry')).toHaveCount(0);
  const foodSection = await page.locator('details.air-menu-sheet').getAttribute('id');
  const foodJump = page.locator(`#tab-air-menu [data-admin-section-link="${foodSection}"]`);
  await foodJump.click();
  await expect(page.locator('details.air-menu-sheet')).toHaveAttribute('open', '');
  await expect(page.locator('#air-items-container .air-item-entry')).toHaveCount(4);
  await page.locator('[name="airItemPrice[]"]').first().fill('₹145');
  await page.locator('[data-category="SOUP"] [data-view="card"]').uncheck();
  const group = page.locator('[data-addon-group="extras"]');
  await group.locator('[data-addon-option="active"][data-option-index="1"]').uncheck();
  await group.locator('[data-addon-assign]').click();
  await page.locator('#addon-assignment-search').fill('Veg Crispy');
  await page.locator('#addon-assignment-list input').check();
  await page.locator('.addon-assignment-save').click();
  await publish(page, '/api/update-airMenu');
  const saved = requests.find(
    (request) => new URL(request.url()).pathname === '/api/update-airMenu'
  );
  expect(fieldValues(saved, 'airItemPrice[]')[0]).toBe('₹145');
  expect(fieldValues(saved, 'airBarItemName[]')).toHaveLength(2);
  expect(JSON.parse(fieldValues(saved, 'airCategoryVisibility')[0]).SOUP.card).toBe(false);
  const extras = JSON.parse(fieldValues(saved, 'airAddonGroups')[0])[0];
  expect(extras.assignedItemKeys).toHaveLength(1);
  expect(extras.options[1].active).toBe(false);
});

test('Table QR enablement is saved immediately and QR previews load only on request', async ({
  page,
}) => {
  const requests = await mockAdmin(page);
  await page.goto('/admin.html#tab-air-menu');
  const toggle = page.locator('[data-table-qr-area="ac"][data-table-qr-number="1"]');
  await expect(toggle).toBeChecked();
  expect(
    requests.filter((request) => new URL(request.url()).searchParams.has('area'))
  ).toHaveLength(0);
  await page.locator('[data-show-table-qr]').click();
  await expect(page.locator('[data-table-qr-image]')).toBeVisible();
  await expect
    .poll(
      () => requests.filter((request) => new URL(request.url()).searchParams.has('area')).length
    )
    .toBe(1);
  await toggle.uncheck();
  await expect(toggle).not.toBeChecked();
  const saved = requests.find(
    (request) => new URL(request.url()).pathname === '/api/admin/table-qr-codes/ac/1'
  );
  expect(saved.method()).toBe('PUT');
  expect(saved.postDataJSON()).toEqual({ enabled: false });
});

test('failed website saves keep drafts and show a useful error before retry', async ({ page }) => {
  let fail = true;
  const requests = await mockAdmin(page, { failSave: () => fail });
  await page.goto('/admin.html#tab-contact');
  await expect(page.locator('[name="address"]')).toHaveValue('Colva, Goa');
  await page.locator('[name="address"]').fill('Garden Road, Colva, Goa');
  const form = page.locator('form[action="/api/update-contact"]');
  await form.locator('button[type="submit"]').click();
  await expect(form.locator('.save-status')).toContainText('Save service temporarily unavailable');
  await expect(page.locator('[name="address"]')).toHaveValue('Garden Road, Colva, Goa');
  fail = false;
  await publish(page, '/api/update-contact');
  const saves = requests.filter(
    (request) => new URL(request.url()).pathname === '/api/update-contact'
  );
  expect(saves).toHaveLength(2);
  expect(fieldValues(saves[1], 'phone')).toEqual(['9876543210']);
});

test('edits made during a delayed save stay marked unsaved when the earlier version succeeds', async ({
  page,
}) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const requests = await mockAdmin(page, { beforeSave: () => gate });
  await page.goto('/admin.html');
  await expect(page.locator('#heroTitle')).toHaveValue('Welcome to Red Lantern');
  const form = page.locator('form[action="/api/update-home"]');
  await page.locator('#heroTitle').fill('First version to publish');
  await form.locator('button[type="submit"]').click();
  await expect(form).toHaveAttribute('data-admin-saving', 'true');
  await expect
    .poll(
      () =>
        requests.filter((request) => new URL(request.url()).pathname === '/api/update-home').length
    )
    .toBe(1);
  await page.locator('#heroTitle').fill('A newer version still in progress');
  release();
  await expect(form).not.toHaveAttribute('data-admin-saving', 'true');
  await expect(form).toHaveClass(/has-admin-draft/);
  await expect(form.locator('.admin-save-copy strong')).toHaveText('Unsaved changes');
  await expect(page.locator('#heroTitle')).toHaveValue('A newer version still in progress');
  const saved = requests.find((request) => new URL(request.url()).pathname === '/api/update-home');
  expect(fieldValues(saved, 'heroTitle')).toEqual(['First version to publish']);
});

test('repeated submit events while a save is pending send one request and finish normally', async ({
  page,
}) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const requests = await mockAdmin(page, { beforeSave: () => gate });
  await page.goto('/admin.html');
  await expect(page.locator('#heroTitle')).toHaveValue('Welcome to Red Lantern');
  const form = page.locator('form[action="/api/update-home"]');
  await page.locator('#heroTitle').fill('Publish once');
  await form.locator('button[type="submit"]').click();
  await expect(form.locator('button[type="submit"]')).toBeDisabled();
  await expect
    .poll(
      () =>
        requests.filter((request) => new URL(request.url()).pathname === '/api/update-home').length
    )
    .toBe(1);
  await form.evaluate((element) => {
    element.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    element.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  release();
  await expect(form.locator('button[type="submit"]')).toBeEnabled();
  await expect(form).not.toHaveClass(/has-admin-draft/);
  await expect(form.locator('.admin-save-copy strong')).toHaveText('Changes published');
  expect(
    requests.filter((request) => new URL(request.url()).pathname === '/api/update-home')
  ).toHaveLength(1);
});

test('Captain permission drafts survive navigation and save to the original account endpoint', async ({
  page,
}) => {
  const requests = await mockAdmin(page);
  await page.goto('/admin.html#tab-captain-app');
  const card = page.locator('[data-captain-card="0"]');
  await expect(card).toBeVisible();
  await card.getByRole('tab', { name: 'Permissions' }).click();
  await card.locator('[data-captain-permission][value="applyDiscounts"]').check();
  await card.locator('[data-employee-discount-value]').fill('250');
  await goToTab(page, 'air-menu');
  await goToTab(page, 'captain-app');
  await expect(card.locator('[data-employee-discount-value]')).toHaveValue('250');
  await page.locator('#captain-save').click();
  await expect
    .poll(
      () =>
        requests.filter(
          (request) =>
            new URL(request.url()).pathname === '/api/admin/captains' && request.method() === 'PUT'
        ).length
    )
    .toBe(1);
  const saved = requests
    .find(
      (request) =>
        new URL(request.url()).pathname === '/api/admin/captains' && request.method() === 'PUT'
    )
    .postDataJSON();
  expect(saved.captains[0].permissions.applyDiscounts).toBe(true);
  expect(saved.captains[0].discountLimit.value).toBe(250);
});

test('a late employee refresh cannot replace a name edited while it is loading', async ({
  page,
}) => {
  let release,
    loads = 0;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const requests = await mockAdmin(page, {
    beforeCaptainLoad: () => {
      loads += 1;
      if (loads === 2) return gate;
    },
  });
  await page.goto('/admin.html#tab-captain-app');
  await expect(page.locator('[data-captain-name="0"]')).toHaveValue('Lalit');
  await goToTab(page, 'air-menu');
  await goToTab(page, 'captain-app');
  await expect.poll(() => loads).toBe(2);
  await page.locator('[data-captain-name="0"]').fill('Lalit Night Shift');
  release();
  await page.locator('#captain-save').click();
  await expect
    .poll(
      () =>
        requests.filter(
          (request) =>
            new URL(request.url()).pathname === '/api/admin/captains' && request.method() === 'PUT'
        ).length
    )
    .toBe(1);
  const saved = requests.find(
    (request) =>
      new URL(request.url()).pathname === '/api/admin/captains' && request.method() === 'PUT'
  );
  expect(saved.postDataJSON().captains[0].name).toBe('Lalit Night Shift');
});

test('a name edited during employee saving remains a draft and reaches the next save', async ({
  page,
}) => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const requests = await mockAdmin(page, { beforeCaptainSave: () => gate });
  await page.goto('/admin.html#tab-captain-app');
  await expect(page.locator('[data-captain-name="0"]')).toHaveValue('Lalit');
  await page.locator('[data-captain-name="0"]').fill('Lalit Evening Shift');
  await page.locator('#captain-save').click();
  await expect
    .poll(
      () =>
        requests.filter(
          (request) =>
            new URL(request.url()).pathname === '/api/admin/captains' && request.method() === 'PUT'
        ).length
    )
    .toBe(1);
  await page.locator('[data-captain-name="0"]').fill('Lalit Duty Manager');
  release();
  await expect(page.locator('#captain-save')).toBeEnabled();
  await expect(page.locator('[data-captain-name="0"]')).toHaveValue('Lalit Duty Manager');
  await page.locator('#captain-save').click();
  await expect
    .poll(
      () =>
        requests.filter(
          (request) =>
            new URL(request.url()).pathname === '/api/admin/captains' && request.method() === 'PUT'
        ).length
    )
    .toBe(2);
  const saves = requests.filter(
    (request) =>
      new URL(request.url()).pathname === '/api/admin/captains' && request.method() === 'PUT'
  );
  expect(saves[0].postDataJSON().captains[0].name).toBe('Lalit Evening Shift');
  expect(saves[1].postDataJSON().captains[0].name).toBe('Lalit Duty Manager');
});

test('failed employee saving retains name and idle settings for a successful retry', async ({
  page,
}) => {
  let fail = true;
  const requests = await mockAdmin(page, { failCaptainSave: () => fail });
  await page.goto('/admin.html#tab-captain-app');
  await expect(page.locator('[data-captain-name="0"]')).toHaveValue('Lalit');
  await page.locator('[data-captain-name="0"]').fill('Lalit Garden Captain');
  await page.locator('#captain-idle-minutes').fill('20');
  await page.locator('#captain-save').click();
  await expect(page.locator('#captain-admin-status')).toContainText(
    'Employee service temporarily unavailable'
  );
  await expect(page.locator('[data-captain-name="0"]')).toHaveValue('Lalit Garden Captain');
  await expect(page.locator('#captain-idle-minutes')).toHaveValue('20');
  fail = false;
  await page.locator('#captain-save').click();
  await expect
    .poll(
      () =>
        requests.filter(
          (request) =>
            new URL(request.url()).pathname === '/api/admin/captains' && request.method() === 'PUT'
        ).length
    )
    .toBe(2);
  const saves = requests.filter(
    (request) =>
      new URL(request.url()).pathname === '/api/admin/captains' && request.method() === 'PUT'
  );
  expect(saves[1].postDataJSON().captains[0].name).toBe('Lalit Garden Captain');
  expect(saves[1].postDataJSON().settings.idleMinutes).toBe(20);
});

for (const fail of [false, true]) {
  test(`employee removal ${fail ? 'failure restores the account' : 'success removes only the chosen account'} while retaining newer drafts`, async ({
    page,
  }) => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const requests = await mockAdmin(page, {
      accounts: [
        {
          id: 'cap_lalit',
          name: 'Lalit',
          role: 'captain',
          active: true,
          areas: ['AC'],
          tableScope: 'own',
          pinConfigured: true,
        },
        {
          id: 'cap_mira',
          name: 'Mira',
          role: 'captain',
          active: true,
          areas: ['AC'],
          tableScope: 'own',
          pinConfigured: true,
        },
      ],
      beforeCaptainSave: () => gate,
      failCaptainSave: () => fail,
    });
    await page.goto('/admin.html#tab-captain-app');
    await expect(page.locator('[data-captain-name="1"]')).toHaveValue('Mira');
    await page.locator('[data-captain-name="1"]').fill('Mira Night Shift');
    page.on('dialog', (dialog) => dialog.accept());
    await page.locator('[data-captain-remove="0"]').click();
    await expect
      .poll(
        () =>
          requests.filter(
            (request) =>
              new URL(request.url()).pathname === '/api/admin/captains' &&
              request.method() === 'PUT'
          ).length
      )
      .toBe(1);
    await page.locator('[data-captain-name="0"]').fill('Mira Duty Manager');
    release();
    await expect(page.locator('#captain-save')).toBeEnabled();
    await expect(page.locator('[data-captain-card]')).toHaveCount(fail ? 2 : 1);
    await expect(page.locator(`[data-captain-name="${fail ? 1 : 0}"]`)).toHaveValue(
      'Mira Duty Manager'
    );
    if (fail) await expect(page.locator('[data-captain-name="0"]')).toHaveValue('Lalit');
    const saved = requests
      .find(
        (request) =>
          new URL(request.url()).pathname === '/api/admin/captains' && request.method() === 'PUT'
      )
      .postDataJSON();
    expect(saved.captains).toHaveLength(1);
    expect(saved.captains[0]).toMatchObject({ id: 'cap_mira', name: 'Mira Night Shift' });
  });
}

test('Smart KDS subworkspaces retain edited setup values and save all planning defaults', async ({
  page,
}) => {
  const requests = await mockAdmin(page);
  await page.goto('/admin.html#tab-smart-kds');
  await expect(page.locator('#smart-kds-plating')).toHaveValue('2');
  await page.locator('#smart-kds-plating').fill('4');
  await page.locator('[data-smart-kds-panel-target="stations"]').click();
  await expect(page.locator('[data-smart-kds-panel="stations"]')).toBeVisible();
  await page.locator('[data-smart-kds-panel-target="setup"]').click();
  await expect(page.locator('#smart-kds-plating')).toHaveValue('4');
  await page.locator('#smart-kds-config-form button[type="submit"]').click();
  await expect(page.locator('#smart-kds-status')).toContainText('settings saved');
  const saved = requests
    .find(
      (request) =>
        new URL(request.url()).pathname === '/api/admin/smart-kds/config' &&
        request.method() === 'PUT'
    )
    .postDataJSON();
  expect(saved.config.timing).toMatchObject({
    platingMinutes: 4,
    handoffBufferMinutes: 1,
    parcelDefaultTargetMinutes: 20,
  });
  expect(saved.config.courseDefaults.soup).toMatchObject({ targetMin: 5, targetMax: 10 });
});

test('analytics keeps the correct figures and refresh action inside the new workspace', async ({
  page,
}) => {
  const requests = await mockAdmin(page);
  await page.goto('/admin.html#tab-sales-dashboard');
  await expect(page.locator('#analytics-kpis')).toContainText('₹12,500');
  await expect(page.locator('#analytics-recent-orders')).toContainText('Cash + UPI / GPay');
  const before = requests.filter(
    (request) => new URL(request.url()).pathname === '/api/admin/analytics'
  ).length;
  await page.locator('#analytics-refresh').click();
  await expect
    .poll(
      () =>
        requests.filter((request) => new URL(request.url()).pathname === '/api/admin/analytics')
          .length
    )
    .toBeGreaterThan(before);
});

test('populated Customer and Orders history stays readable and its filters and bill viewer work', async ({
  page,
}) => {
  await mockAdmin(page);
  const orders = Array.from({ length: 40 }, (_, index) => ({
    id: `history-${index}`,
    daily_order_number: index + 1,
    customer_name: index === 0 ? 'Asha Fernandes' : 'Walk-in customer',
    customer_phone: index === 0 ? '9876543210' : `walkin-${index}`,
    mode: index % 2 ? 'card' : 'table',
    table_area: 'AC',
    table_number: 1,
    status:
      index === 38 ? 'cancelled' : index === 39 ? 'rejected' : index % 2 ? 'completed' : 'accepted',
    created_at: '2026-10-08T12:00:00Z',
    total: 450,
    loyalty_points: 10,
    credit_balance: 0,
    items: [{ name: 'Chicken Pepper Wings Special', portion: 'Regular', quantity: 1, price: 450 }],
  }));
  const queries = [];
  await page.route('**/api/admin/customer-insights?**', async (route) => {
    const url = new URL(route.request().url());
    queries.push(url);
    const query = (url.searchParams.get('search') || '').toLowerCase();
    const filtered = orders.filter(
      (order) =>
        !query || `${order.customer_name} ${order.customer_phone}`.toLowerCase().includes(query)
    );
    await route.fulfill({
      json: {
        orders: filtered,
        leaderboard: [
          { customer_phone: '9876543210', points: 170, total_earned: 170, total_redeemed: 0 },
        ],
        summary: { points: 609, credit: 0 },
      },
    });
  });
  await page.goto('/admin.html#tab-customer-insights');
  await expect(page.locator('#customer-insight-orders tr')).toHaveCount(40);
  await expect
    .poll(() =>
      page
        .locator('#tab-customer-insights h1')
        .evaluate(
          (element) =>
            element.getBoundingClientRect().top -
            document.getElementById('admin-workspace-bar').getBoundingClientRect().bottom
        )
    )
    .toBeGreaterThanOrEqual(0);
  await expect(page.locator('#customer-insight-stats')).toContainText('₹17100');
  await expect(page.locator('.insight-stat').filter({ hasText: 'Orders included' })).toContainText(
    '38'
  );
  const history = page.locator('#tab-customer-insights .insight-table-wrap');
  expect(await history.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(
    true
  );
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 810, height: 1080 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await page.mouse.move(0, 0);
    await expectNoOverflow(page, `populated Customer and Orders at ${viewport.width}px`);
    await page.screenshot({
      path: `/tmp/red-lantern-admin-customer-insights-${viewport.width}.png`,
      animations: 'disabled',
    });
  }
  await page.locator('#insight-search').fill('Asha');
  await expect(page.locator('#customer-insight-orders tr')).toHaveCount(1);
  await page.locator('[data-insight-order="history-0"]').click();
  const bill = page.locator('#customer-order-bill-dialog');
  await expect(bill).toBeVisible();
  await expect(bill).toContainText('Asha Fernandes');
  await expect(bill).toContainText('Chicken Pepper Wings Special');
  await expect(bill).toContainText('Grand total ₹450');
  await expectNoOverflow(page, 'bill viewer on phone');
  await bill.locator('.bill-close').click();
  await expect(bill).not.toBeVisible();
  await page.locator('#insight-date').fill('2026-10-08');
  await expect.poll(() => queries.at(-1).searchParams.get('date')).toBe('2026-10-08');
  const before = queries.length;
  await page.locator('#refresh-customer-insights').click();
  await expect.poll(() => queries.length).toBeGreaterThan(before);
  expect(queries.at(-1).searchParams.get('search')).toBe('Asha');
});

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 1180, height: 820 },
  { width: 810, height: 1080 },
  { width: 390, height: 844 },
]) {
  test(`all Admin sections fit ${viewport.width}px with readable controls`, async ({ page }) => {
    test.setTimeout(90000);
    await page.setViewportSize(viewport);
    await mockAdmin(page);
    await page.goto('/admin.html#tab-air-menu');
    await expect(page.locator('#air-food-sheet-count')).toHaveText('4 items');
    for (const tab of tabs) {
      await goToTab(page, tab);
      await expectNoOverflow(page, `tab-${tab} at ${viewport.width}px`);
      await expect(page.locator(`#tab-${tab} > .header h1`)).toBeVisible();
      if (
        (viewport.width === 1440 && tab === 'home') ||
        ['air-menu', 'captain-app', 'trusted-contacts', 'smart-kds', 'logs'].includes(tab)
      ) {
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.screenshot({
          path: `/tmp/red-lantern-admin-${tab}-${viewport.width}.png`,
          animations: 'disabled',
        });
      }
    }
    await goToTab(page, 'air-menu');
    await page.locator('details.air-menu-sheet > summary').click();
    await expect(page.locator('#air-items-container .air-item-entry')).toHaveCount(4);
    await expectNoOverflow(page, 'expanded food spreadsheet');
    const sheet = await page
      .locator('details.air-menu-sheet .air-sheet-wrap')
      .evaluate((element) => ({ client: element.clientWidth, scroll: element.scrollWidth }));
    expect(sheet.scroll).toBeGreaterThanOrEqual(sheet.client);
    await goToTab(page, 'captain-app');
    await page.locator('[data-captain-card="0"]').getByRole('tab', { name: 'Permissions' }).click();
    await expectNoOverflow(page, 'Captain permissions');
    await page
      .locator('[data-captain-card="0"] [data-employee-panel="permissions"]')
      .scrollIntoViewIfNeeded();
    await page.screenshot({
      path: `/tmp/red-lantern-admin-captain-permissions-${viewport.width}.png`,
      animations: 'disabled',
    });
    await page.goto('/admin.html#tab-sales-dashboard');
    await expect(page.locator('#analytics-kpis')).toContainText('₹12,500');
    await expectNoOverflow(page, 'analytics');
    if (viewport.width === 1440)
      await page.screenshot({
        path: '/tmp/red-lantern-admin-analytics-1440.png',
        animations: 'disabled',
      });
    if (viewport.width === 810)
      await page.screenshot({
        path: '/tmp/red-lantern-admin-analytics-810.png',
        animations: 'disabled',
      });
  });
}
