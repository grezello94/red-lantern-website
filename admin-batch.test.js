/** @jest-environment node */
const http = require('http');
const fs = require('fs');
const nativeRequire = process.getBuiltinModule('module').createRequire(__filename);
const { PGlite } = nativeRequire('@electric-sql/pglite');

let mockDatabase;
function mockQuery(strings, ...values) {
  const text = typeof strings === 'string' ? strings
    : strings.reduce((result, part, index) => result + (index ? `$${index}` : '') + part, '');
  const params = (typeof strings === 'string' ? values[0] || [] : values).map((value) =>
    Object.prototype.toString.call(value) === '[object Date]' ? value.toISOString() : value);
  let pending;
  return { text, params,
    then(resolve, reject) {
      pending ||= mockDatabase.query(text, params).then((result) => result.rows);
      return pending.then(resolve, reject);
    },
    catch(reject) { return this.then(undefined, reject); },
  };
}
mockQuery.transaction = async (callback) => {
  const queries = callback(mockQuery);
  return mockDatabase.transaction(async (tx) => {
    const results = [];
    for (const query of queries) results.push((await tx.query(query.text, query.params)).rows);
    return results;
  });
};
jest.mock('@neondatabase/serverless', () => ({ neon: () => mockQuery, neonConfig: {} }));
jest.mock('web-push', () => ({ setVapidDetails: jest.fn(), sendNotification: jest.fn() }));
jest.mock('cloudinary', () => ({ v2: { config: jest.fn(), uploader: { upload: jest.fn() } } }));

describe('Admin kitchen configuration batches commit completely or remain unchanged', () => {
  let server, origin, environment, existsSpy, readSpy, consoleError;
  const basic = `Basic ${Buffer.from('batch-admin:isolated-admin-password').toString('base64')}`;
  const soup = 'food::soups::soup', rice = 'food::mains::rice';
  const profile = (itemKey, prepTimeEstimate = 17) => ({ itemKey, prepTimeEstimate, stationId: 'kitchen' });
  const station = (stationId = 'kitchen', max = 9) => ({ station_id: stationId, station_name: stationId,
    printer_id: 'kot', max_concurrent_tasks: max, enabled: true });
  async function request(path, body) {
    const response = await fetch(origin + path, { method: body === undefined ? 'GET' : 'PUT',
      headers: { Authorization: basic, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json() };
  }
  const profiles = (body) => request('/api/admin/smart-kds/menu-profiles', body);
  const stations = (body) => request('/api/admin/smart-kds/stations', body);
  const savedProfiles = async () => (await mockDatabase.query(
    'SELECT item_key,prep_time_estimate,profile_version FROM menu_production_profiles ORDER BY item_key')).rows;
  const savedStations = async () => (await mockDatabase.query(
    'SELECT s.station_id,s.max_concurrent_tasks,s.version,k.available_capacity,k.version AS state_version FROM kitchen_stations s LEFT JOIN kitchen_station_state k USING(station_id) ORDER BY s.station_id')).rows;

  beforeAll(async () => {
    environment = { ...process.env };
    Object.assign(process.env, { NEON_DATABASE_URL: 'postgresql://isolated:isolated@localhost/isolated',
      ADMIN_USERNAME: 'batch-admin', ADMIN_PASSWORD: 'isolated-admin-password',
      PUBLIC_CONTENT_CACHE_MS: '0', SECTION_CONTENT_CACHE_MS: '0', SMART_KDS_READ_CACHE_MS: '0', SLOW_REQUEST_MS: '600000' });
    const originalExists = fs.existsSync, originalRead = fs.readFileSync;
    existsSpy = jest.spyOn(fs, 'existsSync').mockImplementation((filename) =>
      String(filename).endsWith('/.env') ? false : originalExists(filename));
    readSpy = jest.spyOn(fs, 'readFileSync').mockImplementation((filename, ...options) => {
      if (String(filename).endsWith('/.env')) throw new Error('Tests must not read local credentials');
      return originalRead(filename, ...options);
    });
    consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockDatabase = new PGlite(); await mockDatabase.waitReady;
    let app;
    jest.isolateModules(() => { app = require('./server'); });
    await app.prepareDatabase();
    await mockDatabase.query('INSERT INTO website_content (id,data) VALUES ($1,$2)', ['air_menu_content', JSON.stringify({
      items: [{ name: 'Soup', category: 'Soups', price: '₹100' }, { name: 'Rice', category: 'Mains', price: '₹150' }],
    })]);
    await mockDatabase.query("INSERT INTO order_operations_config (config_key,config) VALUES ('default',$1) ON CONFLICT(config_key) DO UPDATE SET config=EXCLUDED.config", [
      JSON.stringify({ printers: [], routes: [] }),
    ]);
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
  }, 30000);
  beforeEach(async () => {
    await mockDatabase.exec(`ALTER TABLE kitchen_station_state DROP CONSTRAINT IF EXISTS batch_state_rejection;
      ALTER TABLE menu_production_profiles DROP CONSTRAINT IF EXISTS batch_profile_rejection;
      TRUNCATE kitchen_stations,kitchen_station_state,menu_production_profiles,kitchen_realtime_events CASCADE;
      INSERT INTO kitchen_stations(station_id,station_name,printer_id,max_concurrent_tasks) VALUES ('kitchen','Kitchen','kot',3);
      INSERT INTO kitchen_station_state(station_id,available_capacity) VALUES ('kitchen',3);`);
    // Warm baseline profiles through the public Admin read so later assertions
    // distinguish the requested changes from normal initial profile creation.
    expect((await profiles()).status).toBe(200);
  });
  afterAll(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (mockDatabase) await mockDatabase.close();
    expect(readSpy.mock.calls.some(([filename]) => String(filename).endsWith('/.env'))).toBe(false);
    existsSpy.mockRestore(); readSpy.mockRestore(); consoleError.mockRestore(); process.env = environment;
  });

  test.each(['missing-item', 'unknown-station'])('a later %s rejects the entire profile batch before changing its first item', async (invalid) => {
    const before = await savedProfiles();
    const invalidProfile = invalid === 'missing-item' ? profile('food::missing::dish') : { ...profile(rice), stationId: 'missing' };
    const result = await profiles({ profiles: [profile(soup), invalidProfile] });
    expect(result.status).toBe(400);
    expect(await savedProfiles()).toEqual(before);
  });
  test('an invalid profile batch does not create missing defaults as a side effect of validation', async () => {
    await mockDatabase.exec('TRUNCATE menu_production_profiles');
    expect((await profiles({ profiles: [profile('food::missing::dish')] })).status).toBe(400);
    expect(await savedProfiles()).toEqual([]);
  });
  test('a database failure on a later profile rolls back earlier profile changes', async () => {
    const before = await savedProfiles();
    await mockDatabase.exec(`ALTER TABLE menu_production_profiles ADD CONSTRAINT batch_profile_rejection
      CHECK (item_key<>'food::mains::rice' OR prep_time_estimate<>13)`);
    expect((await profiles({ profiles: [profile(soup), profile(rice, 13)] })).status).toBe(500);
    expect(await savedProfiles()).toEqual(before);
  });
  test('a successful profile batch updates every selected dish exactly once', async () => {
    const before = await savedProfiles();
    const result = await profiles({ profiles: [profile(soup, 17), profile(rice, 21)] });
    expect(result.status).toBe(200); expect(result.data.saved).toHaveLength(2);
    expect(await savedProfiles()).toEqual(before.map((item) => ({ ...item, prep_time_estimate: item.item_key === soup ? 17 : 21,
      profile_version: item.profile_version + 1 })));
  });
  test('a later malformed station rejects the batch without changing earlier stations', async () => {
    const before = await savedStations();
    expect((await stations({ stations: [station(), {}] })).status).toBe(400);
    expect(await savedStations()).toEqual(before);
  });
  test('a station-state write failure rolls back both station records and all earlier changes', async () => {
    const before = await savedStations();
    await mockDatabase.exec("ALTER TABLE kitchen_station_state ADD CONSTRAINT batch_state_rejection CHECK(station_id<>'failing')");
    expect((await stations({ stations: [station(), station('failing', 7)] })).status).toBe(500);
    expect(await savedStations()).toEqual(before);
    expect((await mockDatabase.query("SELECT * FROM kitchen_station_state WHERE station_id='failing'")).rows).toEqual([]);
  });
  test('successful station batches update matching station and capacity state together', async () => {
    expect((await stations({ stations: [station(), station('second', 5)] })).status).toBe(200);
    expect(await savedStations()).toEqual([
      { station_id: 'kitchen', max_concurrent_tasks: 9, version: 2, available_capacity: 9, state_version: 2 },
      { station_id: 'second', max_concurrent_tasks: 5, version: 1, available_capacity: 5, state_version: 1 },
    ]);
  });
  test.each(['profiles', 'stations'])('%s rejects oversize and duplicate batches instead of silently trimming or applying them twice', async (kind) => {
    const send = kind === 'profiles' ? profiles : stations;
    const row = kind === 'profiles' ? profile(soup) : station();
    const before = kind === 'profiles' ? await savedProfiles() : await savedStations();
    expect((await send({ [kind]: Array.from({ length: 251 }, () => row) })).status).toBe(400);
    expect((await send({ [kind]: [row, row] })).status).toBe(400);
    expect(kind === 'profiles' ? await savedProfiles() : await savedStations()).toEqual(before);
  });
  test.each(['profiles', 'stations'])('%s rejects malformed batch envelopes', async (kind) => {
    const send = kind === 'profiles' ? profiles : stations;
    expect((await send({ [kind]: {} })).status).toBe(400);
  });
  test.each(['profiles', 'stations'])('%s rejects malformed numeric settings before applying earlier entries', async (kind) => {
    const send = kind === 'profiles' ? profiles : stations;
    const valid = kind === 'profiles' ? profile(soup) : station();
    const invalid = kind === 'profiles' ? { ...profile(rice), prepTimeEstimate: true }
      : { ...station('second'), max_concurrent_tasks: true };
    const before = kind === 'profiles' ? await savedProfiles() : await savedStations();
    expect((await send({ [kind]: [valid, invalid] })).status).toBe(400);
    expect(kind === 'profiles' ? await savedProfiles() : await savedStations()).toEqual(before);
  });
});
