const { missingDatabaseSchema, schemaProbe } = require('./database-readiness');

describe('database schema readiness', () => {
  test.each(['42P01', '42703'])('recognises recoverable PostgreSQL schema error %s', (code) => {
    expect(missingDatabaseSchema({ code })).toBe(true);
  });

  test('does not hide connection or query failures', async () => {
    const error = Object.assign(new Error('database unavailable'), { code: '08006' });
    await expect(schemaProbe(async () => Promise.reject(error))).rejects.toBe(error);
  });

  test('runs migrations only when a table or required column is missing', async () => {
    await expect(schemaProbe(async () => undefined)).resolves.toBe(true);
    await expect(
      schemaProbe(async () => Promise.reject(Object.assign(new Error('missing'), { code: '42P01' })))
    ).resolves.toBe(false);
  });
});
