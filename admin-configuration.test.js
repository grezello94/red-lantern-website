const fs = require('fs');
const Staff = require('./staff-domain');
const { inferMenuProductionKnowledge } = require('./smart-kds-domain');
const cms = fs.readFileSync('admin-cms.js', 'utf8');
const employeeAdminSource = fs.readFileSync('employee-admin.js', 'utf8');
const functionSource = (name, next) => cms.slice(cms.indexOf(`function ${name}(`), cms.indexOf(`function ${next}(`));
const setupSource = functionSource('setupSmartKds', 'setupSmartKdsProfiles');
const profilesSource = functionSource('setupSmartKdsProfiles', 'setupSmartKdsTiming');
const overridesSource = functionSource('setupSmartKdsTimingOverrides', 'setupSmartKdsFairness');
const config = {
  displayMode: 'normal', mode: 'shadow', courseOrder: ['soup'],
  courseDefaults: { soup: { targetMin: 5, targetMax: 10, spacingAfterMin: 2 } },
  timing: { platingMinutes: 2, handoffBufferMinutes: 1, courseReadyToleranceMinutes: 3, parcelDefaultTargetMinutes: 20 },
  batching: { defaultWindowSeconds: 30, defaultMaxBatchSize: 4 }, fairness: { starvationAfterMinutes: 10 },
  serviceRisk: { firstFoodAfterMinutes: 15, serviceGapAfterMinutes: 10 },
  riskThresholds: { watchMinutes: 5, startSoonMinutes: 2, criticalOverdueMinutes: 10 },
};
const stations = [{ station_id: 'kitchen', station_name: 'Kitchen', printer_id: 'kot', max_concurrent_tasks: 3, enabled: true }];
const dishes = ['Soup', 'Starter'].map((name, index) => ({ itemKey: `dish-${index}`, name, category: name,
  menuType: 'food', profile: { course: index ? 'starter' : 'soup', stationId: 'kitchen', prepTimeEstimate: 5,
    minPrepTime: 3, maxPrepTime: 8, platingTime: 1, handoffBuffer: 1, parallelCapacityCost: 1,
    maxBatchSize: 4, optimalBatchSize: 2, batchWindowSeconds: 30, maxHoldTime: 5, priorityModifier: 0 } }));
const response = (data, status = 200) => ({ ok: status < 400, status, json: async () => JSON.parse(JSON.stringify(data)) });
const flush = async () => { for (let index = 0; index < 8; index += 1) await Promise.resolve(); };
function change(input, value, event = 'input') {
  input.value = String(value); input.dispatchEvent(new Event(event, { bubbles: true }));
}
function settingsMarkup() {
  const ids = ['plating','handoff','tolerance','parcel','batch-window','batch-max','starvation','first-food-risk',
    'service-gap-risk','watch-window','start-soon','critical-overdue'];
  return '<button type="button" data-target="tab-smart-kds">Kitchen</button><div id="smart-kds-status"></div>' +
    '<form id="smart-kds-config-form"><select id="smart-kds-display-mode"><option>normal</option></select>' +
    '<select id="smart-kds-scheduling-mode"><option>shadow</option></select>' +
    ids.map((id) => `<input id="smart-kds-${id}" type="number">`).join('') +
    '<div id="smart-kds-course-defaults"></div><button type="submit">Save setup</button></form>' +
    '<div id="smart-kds-stations"></div><button id="smart-kds-save-stations">Save stations</button>';
}
function profilesMarkup() {
  return '<button type="button" data-target="tab-smart-kds">Kitchen</button>' +
    '<button data-smart-kds-panel-target="profiles" aria-current="page">Profiles</button>' +
    '<div id="smart-kds-profile-list"></div><div id="smart-kds-profile-status"></div>' +
    '<input id="smart-kds-profile-search"><select id="smart-kds-profile-course-filter"></select>' +
    '<div id="smart-kds-profile-count"></div><div id="smart-kds-menu-understanding" hidden></div>' +
    '<button id="smart-kds-load-more-profiles">More</button>';
}

describe('Admin kitchen configuration draft integrity', () => {
  let originalFetch, listeners;
  beforeEach(() => {
    document.head.innerHTML = ''; document.body.innerHTML = ''; localStorage.clear();
    originalFetch = window.fetch;
    window.fetch = jest.fn(async (url, options = {}) => {
      const body = options.body && JSON.parse(options.body);
      if (url.endsWith('/menu-profiles'))
        return response(options.method === 'PUT' ? { saved: body.profiles.map((profile) => ({ profile })) }
          : { items: dishes, stations, coverage: {} });
      if (url.endsWith('/stations')) return response({ stations: body.stations });
      return response({ config: body?.config || (body?.courseOrder ? body : config), stations });
    });
    listeners = jest.spyOn(document, 'addEventListener');
  });
  afterEach(() => {
    listeners.mock.calls.forEach(([type, listener, options]) => document.removeEventListener(type, listener, options));
    jest.restoreAllMocks(); window.fetch = originalFetch;
  });
  const setup = async () => { document.body.innerHTML = settingsMarkup(); window.eval(setupSource + '\nsetupSmartKds();'); await flush(); };
  const profiles = async () => { document.body.innerHTML = profilesMarkup(); window.eval(profilesSource + '\nsetupSmartKdsProfiles();'); await flush(); };
  const field = (index, name = 'prepTimeEstimate') => document.querySelector(`[data-profile-key="dish-${index}"] [data-profile-field="${name}"]`);
  const save = (index) => document.querySelector(`[data-profile-key="dish-${index}"] [data-save-profile]`).click();

  test('returning to Kitchen preserves unsaved setup and station configuration', async () => {
    await setup();
    change(document.getElementById('smart-kds-plating'), 7);
    change(document.querySelector('[data-station-capacity]'), 9);
    document.querySelector('[data-target="tab-smart-kds"]').click(); await flush();
    expect(document.getElementById('smart-kds-plating')).toHaveValue(7);
    expect(document.querySelector('[data-station-capacity]')).toHaveValue(9);
    expect(window.fetch).toHaveBeenCalledTimes(1);
  });
  test('an initial failed settings read cannot publish empty defaults or erase stations', async () => {
    window.fetch.mockResolvedValue(response({ error: 'Unavailable' }, 503));
    await setup();
    expect(document.querySelector('#smart-kds-config-form button')).toBeDisabled();
    expect(document.getElementById('smart-kds-save-stations')).toBeDisabled();
    document.getElementById('smart-kds-config-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    document.getElementById('smart-kds-save-stations').click(); await flush();
    expect(window.fetch.mock.calls.some(([, options]) => options?.method === 'PUT')).toBe(false);
    window.fetch.mockResolvedValue(response({ config, stations }));
    document.querySelector('[data-target="tab-smart-kds"]').click(); await flush();
    expect(document.querySelector('#smart-kds-config-form button')).not.toBeDisabled();
  });
  test('a late settings refresh cannot overwrite a timing edit made while the read was pending', async () => {
    await setup();
    let release;
    window.fetch.mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));
    document.querySelector('[data-target="tab-smart-kds"]').click();
    change(document.getElementById('smart-kds-plating'), 8);
    release(response({ config, stations })); await flush();
    expect(document.getElementById('smart-kds-plating')).toHaveValue(8);
  });
  test('a late setup save keeps a newer course target for the next save', async () => {
    await setup();
    const target = document.querySelector('[data-target-min]'); change(target, 6);
    let release;
    window.fetch.mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));
    document.getElementById('smart-kds-config-form').dispatchEvent(new Event('submit', { cancelable: true }));
    change(target, 9); release(response({ config })); await flush();
    expect(document.querySelector('[data-target-min]')).toHaveValue(9);
    expect(document.getElementById('smart-kds-status')).toHaveTextContent('Newer edits remain unsaved');
    document.getElementById('smart-kds-config-form').dispatchEvent(new Event('submit', { cancelable: true })); await flush();
    expect(JSON.parse(window.fetch.mock.calls.at(-1)[1].body).config.courseDefaults.soup.targetMin).toBe(9);
  });
  test('a late station save retains a newer capacity change', async () => {
    await setup(); change(document.querySelector('[data-station-capacity]'), 4);
    let release;
    window.fetch.mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));
    document.getElementById('smart-kds-save-stations').click();
    change(document.querySelector('[data-station-capacity]'), 8);
    release(response({ stations })); await flush();
    expect(document.querySelector('[data-station-capacity]')).toHaveValue(8);
  });
  test('setup saves preserve activation and category/station timing overrides owned by other panels', async () => {
    const saved = { ...config, enabled: true, timing: { ...config.timing,
      categoryTargetAdjustments: { 'food::Soup': 4 }, stationTargetAdjustments: { kitchen: 3 }, stationHandoffAdjustments: { kitchen: 2 } } };
    window.fetch.mockResolvedValueOnce(response({ config: saved, stations }));
    await setup(); change(document.getElementById('smart-kds-plating'), 7);
    document.getElementById('smart-kds-config-form').dispatchEvent(new Event('submit', { cancelable: true })); await flush();
    const submitted = JSON.parse(window.fetch.mock.calls.at(-1)[1].body).config;
    expect(submitted.enabled).toBe(true);
    expect(submitted.timing).toMatchObject({ platingMinutes: 7, categoryTargetAdjustments: { 'food::Soup': 4 },
      stationTargetAdjustments: { kitchen: 3 }, stationHandoffAdjustments: { kitchen: 2 } });
  });
  test('a timing adjustment saved in another panel remains in the next setup save', async () => {
    await setup(); change(document.getElementById('smart-kds-plating'), 6);
    document.dispatchEvent(new CustomEvent('admin-smart-kds-config-saved', { detail: { config: {
      ...config, timing: { ...config.timing, categoryTargetAdjustments: { 'food::Soup': 8 } },
    } } }));
    document.getElementById('smart-kds-config-form').dispatchEvent(new Event('submit', { cancelable: true })); await flush();
    expect(JSON.parse(window.fetch.mock.calls.at(-1)[1].body).config.timing)
      .toMatchObject({ platingMinutes: 6, categoryTargetAdjustments: { 'food::Soup': 8 } });
  });
  async function adjustments() {
    document.body.innerHTML = '<button data-target="tab-smart-kds">Kitchen</button>' +
      '<select id="smart-kds-category-override"></select><input id="smart-kds-category-adjustment" type="number">' +
      '<select id="smart-kds-station-override"></select><input id="smart-kds-station-target-adjustment" type="number">' +
      '<input id="smart-kds-station-adjustment" type="number"><button id="smart-kds-save-timing-overrides">Save</button>' +
      '<div id="smart-kds-timing-overrides-status"></div>';
    window.eval(overridesSource + '\nsetupSmartKdsTimingOverrides();');
    document.querySelector('[data-target="tab-smart-kds"]').click(); await flush();
  }
  test('timing-adjustment saves preserve newly saved setup settings from the other panel', async () => {
    await adjustments();
    document.dispatchEvent(new CustomEvent('admin-smart-kds-config-saved', { detail: { config: {
      ...config, timing: { ...config.timing, platingMinutes: 9 },
    } } }));
    change(document.getElementById('smart-kds-category-adjustment'), 3);
    document.getElementById('smart-kds-save-timing-overrides').click(); await flush();
    const submitted = JSON.parse(window.fetch.mock.calls.at(-1)[1].body);
    expect(submitted.timing).toMatchObject({ platingMinutes: 9, categoryTargetAdjustments: { 'food::Soup': 3 } });
  });
  test('late timing-adjustment responses keep newer values for a later save', async () => {
    await adjustments(); change(document.getElementById('smart-kds-category-adjustment'), 3);
    let release;
    window.fetch.mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));
    document.getElementById('smart-kds-save-timing-overrides').click();
    const submitted = JSON.parse(window.fetch.mock.calls.at(-1)[1].body);
    change(document.getElementById('smart-kds-category-adjustment'), 7);
    release(response({ config: submitted })); await flush();
    expect(document.getElementById('smart-kds-category-adjustment')).toHaveValue(7);
    expect(document.getElementById('smart-kds-timing-overrides-status')).toHaveTextContent('Newer edits remain unsaved');
  });
  test('category filtering retains unsaved dish production settings', async () => {
    await profiles(); change(field(0), 17);
    const filter = document.getElementById('smart-kds-profile-course-filter');
    change(filter, 'food::Starter', 'change'); change(filter, '', 'change');
    expect(field(0)).toHaveValue(17);
    document.querySelector('[data-target="tab-smart-kds"]').click(); await flush();
    expect(field(0)).toHaveValue(17);
    expect(window.fetch).toHaveBeenCalledTimes(1);
  });
  test('saving one dish does not discard another dish’s unsaved station or timing', async () => {
    await profiles(); change(field(0), 12); change(field(1), 19);
    save(0); await flush();
    expect(field(1)).toHaveValue(19);
    save(1); await flush();
    expect(JSON.parse(window.fetch.mock.calls.at(-1)[1].body).profiles[0].prepTimeEstimate).toBe(19);
  });
  test('a late dish save preserves newer edits and sends them on the next save', async () => {
    await profiles(); change(field(0), 11);
    let release;
    window.fetch.mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));
    save(0); const submitted = JSON.parse(window.fetch.mock.calls.at(-1)[1].body).profiles[0];
    change(field(0), 18); release(response({ saved: [{ profile: submitted }] })); await flush();
    expect(field(0)).toHaveValue(18);
    expect(document.getElementById('smart-kds-profile-status')).toHaveTextContent('Newer edits remain unsaved');
    save(0); await flush();
    expect(JSON.parse(window.fetch.mock.calls.at(-1)[1].body).profiles[0].prepTimeEstimate).toBe(18);
  });
  test('malformed successful profile responses retain the draft and do not claim it was saved', async () => {
    await profiles(); change(field(0), 15); window.fetch.mockResolvedValueOnce(response({ ok: true }));
    save(0); await flush();
    expect(field(0)).toHaveValue(15);
    expect(document.getElementById('smart-kds-profile-status')).toHaveTextContent('did not confirm');
  });
  test('menu understanding exposes seafood preparation and batch suggestions without changing saved fields', async () => {
    const fish = { ...dishes[0], name: 'Fish Fry', category: 'Seafood', profile: {
      ...dishes[0].profile, batchable: false, maxBatchSize: 1,
      menuKnowledge: inferMenuProductionKnowledge({ name: 'Fish Fry', category: 'Seafood' }),
    } };
    window.fetch.mockResolvedValueOnce(response({ items: [fish], stations, coverage: {},
      menuKnowledge: { inferred: 1, fallback: 0, seafoodPreparationAlerts: 1 } }));
    await profiles();
    const summary = document.getElementById('smart-kds-menu-understanding');
    expect(summary).not.toHaveAttribute('hidden');
    expect(summary).toHaveTextContent('1 mapped · 0 need chef review · 1 seafood preparation alerts');
    const knowledge = document.querySelector('[data-profile-knowledge]');
    expect(knowledge).toHaveTextContent('Seafood fry · Suggested station: Fryer');
    expect(knowledge).toHaveTextContent('Chef: calibrate cooking times');
    expect(document.querySelector('[data-profile-preparation-alert]')).toHaveTextContent('Check seafood portions and chilled/thawed stock now');
    expect(document.querySelector('[data-profile-batch-suggestion]')).toHaveTextContent('maximum 3');
    expect(document.querySelector('[data-profile-batch-suggestion]')).toHaveTextContent('enable batching and save');
    expect(field(0)).toHaveValue(5);
    expect(field(0, 'maxBatchSize')).toHaveValue(1);
    expect(field(0, 'batchable')).not.toBeChecked();
    expect(window.fetch).toHaveBeenCalledTimes(1);
    change(field(0), 9); save(0); await flush();
    expect(JSON.parse(window.fetch.mock.calls.at(-1)[1].body).profiles[0]).toMatchObject({ prepTimeEstimate: 9, batchable: false, maxBatchSize: 1 });
    expect(document.querySelector('[data-profile-knowledge]')).toHaveTextContent('Seafood fry');
  });
  test('fallback menu advice is reviewable and escapes ingredient messages', async () => {
    const item = { ...dishes[0], profile: { ...dishes[0].profile, menuKnowledge: {
      family: 'unclassified', confidence: 'fallback', suggestedStation: 'kitchen',
      preparationAlert: '<img src=x onerror=alert(1)>', batchSuggestion: {},
    } } };
    window.fetch.mockResolvedValueOnce(response({ items: [item], stations, coverage: {},
      menuKnowledge: { inferred: 0, fallback: 1, seafoodPreparationAlerts: 0 } }));
    await profiles();
    expect(document.querySelector('[data-profile-knowledge]')).toHaveTextContent('Limited menu match; chef review needed.');
    expect(document.querySelector('[data-profile-preparation-alert]')).toHaveTextContent('<img src=x onerror=alert(1)>');
    expect(document.querySelector('[data-profile-preparation-alert] img')).toBeNull();
    expect(field(0)).toHaveValue(5);
  });
});

test('switching employee role clears obsolete assigned-area validation after updating its scope', async () => {
  document.body.innerHTML = '<section id="tab-captain-app"><div id="captain-admin-list"></div></section>';
  window.RedLanternStaff = Staff;
  window.eval(employeeAdminSource);
  document.getElementById('captain-admin-list').innerHTML = window.renderEmployeeCards([
    { id: 'employee', name: 'Employee', role: 'captain', tableScope: 'assigned_areas', areas: [] },
  ], ['AC']);
  await flush();
  const scope = document.querySelector('[data-captain-scope]');
  expect(scope.checkValidity()).toBe(false);
  change(document.querySelector('[data-captain-role]'), 'billing', 'change');
  expect(scope.value).toBe('all');
  expect(scope.checkValidity()).toBe(true);
});
