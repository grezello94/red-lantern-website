const { resolveAnalyticsRange, percentChange } = require('./analytics-domain');

describe('analytics date ranges', () => {
  const now = new Date('2026-09-14T14:30:00.000Z');

  test('uses the Kolkata business day for today and its comparison', () => {
    expect(resolveAnalyticsRange({ preset: 'today' }, now)).toMatchObject({
      from: '2026-09-14',
      to: '2026-09-14',
      startUtc: '2026-09-13T18:30:00.000Z',
      endUtc: '2026-09-14T18:30:00.000Z',
      previous: { from: '2026-09-13', to: '2026-09-13' },
    });
  });

  test('creates month, year and custom inclusive ranges', () => {
    expect(resolveAnalyticsRange({ preset: 'month' }, now)).toMatchObject({
      from: '2026-09-01',
      to: '2026-09-14',
      days: 14,
    });
    expect(resolveAnalyticsRange({ preset: 'year' }, now)).toMatchObject({
      from: '2026-01-01',
      to: '2026-09-14',
    });
    expect(
      resolveAnalyticsRange({ preset: 'custom', from: '2026-08-20', to: '2026-08-25' }, now)
    ).toMatchObject({ from: '2026-08-20', to: '2026-08-25', days: 6 });
  });

  test('rejects incomplete, reversed and excessively long custom ranges', () => {
    expect(() => resolveAnalyticsRange({ preset: 'custom', from: '2026-09-01' }, now)).toThrow(
      'Choose both'
    );
    expect(() =>
      resolveAnalyticsRange({ preset: 'custom', from: '2026-09-15', to: '2026-09-01' }, now)
    ).toThrow('start date');
    expect(() =>
      resolveAnalyticsRange({ preset: 'custom', from: '2020-01-01', to: '2026-09-01' }, now)
    ).toThrow('three years');
  });
});

describe('analytics comparison', () => {
  test('calculates changes without inventing a percentage from zero', () => {
    expect(percentChange(120, 100)).toBe(20);
    expect(percentChange(80, 100)).toBe(-20);
    expect(percentChange(0, 0)).toBe(0);
    expect(percentChange(100, 0)).toBeNull();
  });
});
