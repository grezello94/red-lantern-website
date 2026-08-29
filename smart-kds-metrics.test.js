const { buildKitchenMetrics } = require('./smart-kds-metrics');

const base = '2026-08-27T12:00:00.000Z';

describe('Smart KDS Phase 13 metrics and audit', () => {
  test('calculates service, SLA, station, batch, and exception measures from saved records', () => {
    const report = buildKitchenMetrics({
      rangeStart: base, now: '2026-08-27T13:00:00.000Z',
      orders: [{ id: 'order-1', mode: 'table', created_at: base }],
      courses: [
        { order_id: 'order-1', course_type: 'soup', served_at: '2026-08-27T12:10:00.000Z', latest_acceptable_serve_at: '2026-08-27T12:12:00.000Z' },
        { order_id: 'order-1', course_type: 'main', served_at: '2026-08-27T12:32:00.000Z', latest_acceptable_serve_at: '2026-08-27T12:30:00.000Z' },
      ],
      tasks: [{ task_id: 'order-1:line-1', order_id: 'order-1', station_id: 'wok', profile_snapshot: { prepTimeEstimate: 12 }, created_at: base, preparing_at: '2026-08-27T12:05:00.000Z', ready_at: '2026-08-27T12:17:00.000Z', served_at: '2026-08-27T12:20:00.000Z' }],
      stations: [{ station_id: 'wok', station_name: 'Wok', max_concurrent_tasks: 2 }],
      batches: [{ fired_at: '2026-08-27T12:05:00.000Z', config_snapshot: { totalQuantity: 4, maxBatchSize: 5 } }],
      events: [{ event_type: 'override-refire', created_at: '2026-08-27T12:25:00.000Z' }, { event_type: 'override-hold', created_at: '2026-08-27T12:26:00.000Z', actor_id: 'Asha' }],
      decisions: [{ action: 'start-now', task_id: 'order-1:line-1', order_id: 'order-1', priority_rank: 1, reason_codes: ['LATEST_SAFE_START_REACHED'], calculated_at: '2026-08-27T12:04:00.000Z' }],
    });
    expect(report.summary).toMatchObject({ averageFirstFoodMinutes: 10, orderSlaPercent: 0, lateOrders: 1, lateCourses: 1, averageReadyToServedMinutes: 3, averagePrepEstimateErrorMinutes: 0, refires: 1, manualOverrides: 2, averageBatchSize: 4, batchEfficiencyPercent: 80 });
    expect(report.courses.find((course) => course.course === 'soup')).toMatchObject({ served: 1, late: 0, averageServiceMinutes: 10, slaPercent: 100 });
    expect(report.stations[0]).toMatchObject({ stationName: 'Wok', averageQueueMinutes: 5, averagePrepMinutes: 12, prepEstimateErrorMinutes: 0 });
    expect(report.audit).toHaveLength(3);
  });

  test('returns empty-safe measures where historical records are not available', () => {
    const report = buildKitchenMetrics({ rangeStart: base, now: '2026-08-27T13:00:00.000Z' });
    expect(report.summary).toMatchObject({ averageFirstFoodMinutes: null, orderSlaPercent: null, lateOrders: 0, averageBatchSize: null });
    expect(report.audit).toEqual([]);
  });

  test('measures SLA only after every current course is served and uses immutable service events for add-on delivery gaps', () => {
    const report = buildKitchenMetrics({
      rangeStart: base, now: '2026-08-27T13:00:00.000Z',
      orders: [
        { id: 'complete', mode: 'table', created_at: base },
        { id: 'in-progress', mode: 'table', created_at: base },
      ],
      courses: [
        { order_id: 'complete', course_type: 'starter', course_state: 'served', served_at: '2026-08-27T12:08:00.000Z', latest_acceptable_serve_at: '2026-08-27T12:10:00.000Z' },
        { order_id: 'complete', course_type: 'main', course_state: 'served', served_at: '2026-08-27T12:40:00.000Z', latest_acceptable_serve_at: '2026-08-27T12:35:00.000Z' },
        { order_id: 'in-progress', course_type: 'starter', course_state: 'served', served_at: '2026-08-27T12:09:00.000Z', latest_acceptable_serve_at: '2026-08-27T12:10:00.000Z' },
        { order_id: 'in-progress', course_type: 'main', course_state: 'ordered', served_at: null, latest_acceptable_serve_at: '2026-08-27T12:30:00.000Z' },
      ],
      serviceEvents: [
        { order_id: 'complete', course_type: 'starter', served_at: '2026-08-27T12:08:00.000Z' },
        { order_id: 'complete', course_type: 'starter', served_at: '2026-08-27T12:18:00.000Z' },
        { order_id: 'complete', course_type: 'main', served_at: '2026-08-27T12:40:00.000Z' },
      ],
      events: [{ event_type: 'manual-ready', created_at: '2026-08-27T12:09:00.000Z' }, { event_type: 'override-hold', created_at: '2026-08-27T12:10:00.000Z' }],
      orderEvents: [{ order_id: 'complete', event_type: 'kot-served', details: { captainName: 'Ravi' }, created_at: '2026-08-27T12:18:00.000Z' }],
    });
    expect(report.summary).toMatchObject({ ordersMeasured: 1, orderSlaPercent: 0, lateOrders: 1, averageFirstFoodMinutes: 8.5, tableServiceGaps: 2, averageServiceGapMinutes: 16, manualOverrides: 1, staffActions: 2 });
    expect(report.audit.some((entry) => entry.type === 'order-event' && entry.actor === 'Ravi')).toBe(true);
  });
});
