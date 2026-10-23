const {
  learnKitchenPatterns, applyKitchenLearning, classifyLearningLoad, calculateLoadBands, kitchenLearningKey,
} = require('./smart-kds-learning');
const { conservativePreparationMilliseconds, buildPreparationPlan } = require('./smart-kds-preparation');

const now = '2026-10-23T12:00:00.000Z';
const at = (minutes) => new Date(Date.parse(now) + minutes * 60_000).toISOString();
const profile = { itemKey: 'food::rice::veg fried rice', prepTimeEstimate: 8, minPrepTime: 6, maxPrepTime: 10,
  platingTime: 2, handoffBuffer: 2, batchable: false, maxBatchSize: 1, parallelCapacityCost: 1 };
const task = (changes = {}) => ({ taskKey: 'order:rice', orderId: 'order', itemKey: profile.itemKey,
  itemName: 'Veg Fried Rice', category: 'Rice', stationId: 'kitchen', quantity: 1, taskState: 'ordered',
  portion: 'Regular', style: '', note: '', orderNote: '', profile,
  targetServeAt: at(20), latestSafeStartAt: at(6), prepWindowMinutes: 14, ...changes });
const sample = (index, duration, changes = {}) => ({ ...task(), sampleId: `sample-${index}`, loadBand: 'quiet',
  preparingAt: at(-1000 - index * 100), readyAt: at(-1000 - index * 100 + duration), ...changes });
const train = (samples, options = {}) => learnKitchenPatterns({ samples, now, ...options });
const apply = (model, changes = {}, options = {}) => applyKitchenLearning({ recommendations: [task(changes)], model, now, loadBand: 'quiet', ...options });
const deepFreeze = (value) => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value); Object.values(value).forEach(deepFreeze);
  }
  return value;
};

describe('observational kitchen timing calibration', () => {
  test('quiet and busy samples calibrate the same dish separately from recorded load', () => {
    const model = train([
      ...[8, 9, 10, 10, 11].map((minutes, index) => sample(index, minutes)),
      ...[18, 20, 21, 22, 23].map((minutes, index) => sample(index + 10, minutes, { loadBand: 'busy' })),
    ]);
    const quiet = apply(model).recommendations[0].learning;
    const busy = apply(model, {}, { loadBand: 'busy' }).recommendations[0].learning;
    expect(quiet).toMatchObject({ applied: true, sampleCount: 5, loadBand: 'quiet', baselineMinutes: 14, singleWave: true });
    expect(busy).toMatchObject({ applied: true, sampleCount: 5, loadBand: 'busy' });
    expect(busy.estimateMinutes).toBeGreaterThan(quiet.estimateMinutes);
    expect(model.summary).toMatchObject({ qualifyingSamples: 10, trackedDishes: 1, learnedGroups: 2 });
    expect(apply(model, {}, { loadBand: 'surge' }).recommendations[0].learning.applied).toBe(false);
  });

  test('the same dish uses independent calibration at different kitchen stations', () => {
    const model = train([
      ...Array.from({ length: 5 }, (_, index) => sample(index, 10, { stationId: 'kitchen' })),
      ...Array.from({ length: 5 }, (_, index) => sample(index + 10, 22, { stationId: 'wok' })),
    ]);
    const kitchen = apply(model).recommendations[0].learning;
    const wok = apply(model, { stationId: 'wok' }).recommendations[0].learning;
    expect(kitchen).toMatchObject({ applied: true, sampleCount: 5 });
    expect(wok).toMatchObject({ applied: true, sampleCount: 5 });
    expect(wok.estimateMinutes).toBeGreaterThan(kitchen.estimateMinutes);
    expect(apply(model, { stationId: 'tandoor' }).recommendations[0].learning.applied).toBe(false);
  });

  test('at least five compatible real starts are required even if the caller requests a lower threshold', () => {
    const model = train([8, 9, 10, 11].map((minutes, index) => sample(index, minutes)), { minimumSamples: 1 });
    expect(model.minimumSamples).toBe(5);
    expect(apply(model).recommendations[0].learning).toMatchObject({ applied: false, sampleCount: 4, estimateMinutes: 14 });
    expect(apply(model).summary.learnedTasks).toBe(0);
  });

  test('robust percentile ignores an isolated long delay and still requires five retained samples', () => {
    const clean = [10, 10, 11, 11, 12].map((minutes, index) => sample(index, minutes));
    const withOutlier = train([...clean, sample(10, 200)]);
    expect(withOutlier.summary.rejectedByReason.outlier).toBe(1);
    expect(apply(withOutlier).recommendations[0].learning).toMatchObject({ applied: true, sampleCount: 5 });
    expect(apply(withOutlier).recommendations[0].learning.estimateMinutes).toBe(apply(train(clean)).recommendations[0].learning.estimateMinutes);
    expect(apply(train([...clean.slice(0, 4), sample(10, 200)])).recommendations[0].learning.applied).toBe(false);
  });

  test('missing starts, incomplete feedback, negative/absurd times and future timestamps never create samples', () => {
    const invalid = [
      sample(1, 10, { preparingAt: null }), sample(2, 10, { readyAt: null }),
      sample(3, -1), sample(4, 0), sample(5, 0.1), sample(6, 241),
      sample(7, 10, { readyAt: at(1) }), sample(8, 10, { readyConfirmedWithoutRecordedStart: true }),
    ];
    const model = train(invalid);
    expect(model.summary.qualifyingSamples).toBe(0);
    expect(model.summary.learnedGroups).toBe(0);
    expect(apply(model).recommendations[0].learning.applied).toBe(false);
  });

  test('unknown historical load is recorded separately and cannot masquerade as busy or quiet', () => {
    const model = train([10, 11, 11, 12, 12].map((minutes, index) => sample(index, minutes, { loadBand: undefined })));
    expect(model.summary.unknownLoadSamples).toBe(5);
    expect(apply(model).recommendations[0].learning.applied).toBe(false);
    expect(apply(model, {}, { loadBand: 'busy' }).recommendations[0].learning.applied).toBe(false);
    expect(apply(model, {}, { loadBand: 'unknown' }).recommendations[0].learning)
      .toMatchObject({ applied: true, loadBand: 'unknown', confidence: 'low' });
  });

  test('recipe notes, portions, styles, menu identity and modifier choices remain incompatible', () => {
    const special = { note: 'No onion', orderNote: 'No salt', portion: 'Half', style: 'Gravy',
      modifiers: [{ groupId: 'sauce', options: [{ optionId: 'chilli', name: 'Extra chilli', quantity: 1 }] }] };
    const model = train([10, 11, 11, 12, 12].map((minutes, index) => sample(index, minutes, special)));
    expect(apply(model, special).recommendations[0].learning.applied).toBe(true);
    for (const changes of [{ note: 'Extra onion' }, { orderNote: 'Extra salt' }, { portion: 'Full' }, { style: 'Plain' },
      { itemKey: 'different-item' }, { modifiers: [{ groupId: 'sauce', options: [{ optionId: 'garlic', name: 'Garlic' }] }] }]) {
      expect(apply(model, { ...special, ...changes }).recommendations[0].learning.applied).toBe(false);
    }
    expect(kitchenLearningKey(task({ note: 'RUNNING - extra portion; no onion' }), 'quiet'))
      .toBe(kitchenLearningKey(task({ note: 'No onion' }), 'quiet'));
    expect(kitchenLearningKey(task({ note: 'extra portion of garlic' }), 'quiet'))
      .not.toBe(kitchenLearningKey(task({ note: 'of garlic' }), 'quiet'));
  });

  test('batch correlations, multiwave portions and unknown quantities never become independent cook samples', () => {
    const samples = [
      sample(1, 10, { quantity: 2 }), sample(2, 10, { cookingWaves: 2 }),
      sample(3, 10, { quantity: undefined }), sample(4, 10, { quantity: 1.5 }),
      sample(5, 10, { batchId: 'approved-batch' }), sample(6, 10, { active_batch_id: 'approved-batch' }),
    ];
    expect(train(samples).summary.qualifyingSamples).toBe(0);
    const approved = { ...profile, batchable: true, maxBatchSize: 4 };
    expect(train([sample(8, 10, { quantity: 4, profile: approved })]).summary.qualifyingSamples).toBe(1);
    expect(train([sample(8, 10, { quantity: 5, profile: approved })]).summary.qualifyingSamples).toBe(0);
  });

  test('explicit single-task batches learn independent approved waves while shared or unknown batches remain excluded', () => {
    const approved = { ...profile, batchable: true, maxBatchSize: 4 };
    const independent = Array.from({ length: 5 }, (_, index) => sample(index, 20, {
      quantity: 4, profile: approved, batchId: `single-task-batch-${index}`, batchTaskCount: 1,
    }));
    const duplicate = { ...independent[0], sampleId: 'same-physical-batch-another-event' };
    const model = train([...independent, duplicate,
      sample(10, 20, { quantity: 4, profile: approved, batchId: 'shared', batchTaskCount: 2 }),
      sample(11, 20, { quantity: 4, profile: approved, batchId: 'unknown' }),
      sample(12, 20, { quantity: 4, profile: approved, batchId: 'string-count', batchTaskCount: '1' }),
      sample(13, 20, { quantity: 5, profile: approved, batchId: 'two-waves', batchTaskCount: 1 }),
    ]);
    expect(model.summary).toMatchObject({ qualifyingSamples: 5,
      rejectedByReason: { duplicate: 1, 'correlated-batch': 3, 'multiple-or-unknown-waves': 1 } });
    expect(apply(model, { quantity: 4, profile: approved }).recommendations[0].learning)
      .toMatchObject({ applied: true, sampleCount: 5 });
  });

  test('recent bounded independent observations are deduplicated and stale models expire', () => {
    const history = Array.from({ length: 10 }, (_, index) => sample(index, 10));
    const model = train([...history, history[0], sample(30, 10, { preparingAt: at(-31 * 24 * 60), readyAt: at(-31 * 24 * 60 + 10) })], { maxSamples: 5 });
    expect(model.summary).toMatchObject({ qualifyingSamples: 5, rejectedByReason: { duplicate: 1, 'invalid-time': 1, 'sample-limit': 5 } });
    expect(apply(model).recommendations[0].learning.applied).toBe(true);
    expect(apply(model, {}, { now: at(31 * 24 * 60) }).recommendations[0].learning.applied).toBe(false);
  });

  test('estimates stay above chef minimum and at most twice the full chef maximum without double overhead', () => {
    const fast = train(Array.from({ length: 30 }, (_, index) => sample(index, 1)));
    const slow = train(Array.from({ length: 30 }, (_, index) => sample(index, 150)));
    expect(apply(fast).recommendations[0].learning.estimateMinutes).toBe(10);
    expect(apply(slow).recommendations[0].learning.estimateMinutes).toBe(28);
    const bulk = apply(slow, { quantity: 10 }).recommendations[0];
    expect(bulk.learning).toMatchObject({ applied: false, estimateMinutes: 14, singleWave: true });
    expect(bulk.quantity).toBe(10);
    expect(bulk.profile).toEqual(profile);
  });

  test('learning never changes chef profiles, deadlines, notes, capacities or acknowledgement states', () => {
    const model = train(Array.from({ length: 5 }, (_, index) => sample(index, 20)));
    const original = deepFreeze(task({ note: 'RUNNING - extra portion', taskState: 'preparing', preparingAt: at(-2), capacityState: 'in-progress' }));
    const before = JSON.stringify(original);
    const result = applyKitchenLearning({ recommendations: [original], model, loadBand: 'quiet', now });
    expect(result.recommendations[0].learning.applied).toBe(true);
    const { learning, ...unchanged } = result.recommendations[0];
    expect(unchanged).toEqual(original);
    expect(JSON.stringify(original)).toBe(before);
    expect(apply(model, { taskState: 'served' }).recommendations[0].learning.applied).toBe(false);
    expect(apply(model, {}, { enabled: false }).recommendations[0].learning.applied).toBe(false);
  });

  test('historical SQL aliases require real timestamps and preserve the recorded band', () => {
    const input = Array.from({ length: 5 }, (_, index) => {
      const value = sample(index, 12);
      const { preparingAt, readyAt, quantity, loadBand, ...rest } = value;
      return { ...rest, preparing_at: preparingAt, ready_at: readyAt, requested_quantity: quantity, load_band: loadBand };
    });
    expect(apply(train(input)).recommendations[0].learning.applied).toBe(true);
  });

  test('recording and forecasting share the same station pressure bands without inventing missing capacity', () => {
    const stations = [{ station_id: 'kitchen', max_concurrent_tasks: 2, enabled: true }, { station_id: 'wok', available_capacity: 1 }];
    const recommendations = [task({ quantity: 10 }), task({ taskKey: 'wok:item', stationId: 'wok', quantity: 3 })];
    expect(calculateLoadBands({ recommendations, stations })).toEqual({ kitchen: 'surge', wok: 'busy' });
    expect(classifyLearningLoad({ recommendations: [task({ quantity: 4 })], stations, stationId: 'kitchen' })).toBe('quiet');
    expect(classifyLearningLoad({ recommendations: [task({ quantity: 6 })], stations, stationId: 'kitchen' })).toBe('busy');
    expect(classifyLearningLoad({ recommendations, stations: [], stationId: 'kitchen' })).toBe('unknown');
    expect(classifyLearningLoad({ recommendations, stations: [{ station_id: 'kitchen', available_capacity: 0 }], stationId: 'kitchen' })).toBe('unknown');
    expect(classifyLearningLoad({ recommendations: [task({ taskState: 'held', quantity: 100 })], stations, stationId: 'kitchen' })).toBe('quiet');
    expect(classifyLearningLoad({ recommendations: [task({ taskState: 'ready', quantity: 100 })], stations, stationId: 'kitchen' })).toBe('quiet');
    const batchMembers = Array.from({ length: 8 }, (_, index) => task({ taskKey: `batch:${index}`, taskState: 'preparing', activeBatchId: 'one-batch' }));
    expect(classifyLearningLoad({ recommendations: batchMembers, stations, stationId: 'kitchen' })).toBe('quiet');
    expect(classifyLearningLoad({ recommendations: batchMembers.map((entry) => ({ ...entry, taskState: 'ordered' })), stations, stationId: 'kitchen' })).toBe('busy');
    const model = train(Array.from({ length: 5 }, (_, index) => sample(index, 20, { loadBand: 'surge' })));
    expect(applyKitchenLearning({ recommendations, model, stations, now }).recommendations[0].learning.loadBand).toBe('surge');
  });

  test('learned full-wave elapsed time integrates without adding buffers or multiplying approved portions twice', () => {
    const approved = { ...profile, batchable: true, maxBatchSize: 4 };
    const model = train(Array.from({ length: 5 }, (_, index) => sample(index, 20, { quantity: 4, profile: approved })));
    const learned = apply(model, { quantity: 4, profile: approved }).recommendations[0];
    expect(learned.learning.applied).toBe(true);
    expect(conservativePreparationMilliseconds(learned)).toBe(learned.learning.estimateMinutes * 60_000);
    expect(conservativePreparationMilliseconds({ ...learned, quantity: 8 })).toBe(learned.learning.estimateMinutes * 2 * 60_000);
    expect(apply(model, { quantity: 1, profile: approved }).recommendations[0].learning.applied).toBe(false);
  });

  test('slower learned preparation pulls effective start earlier while faster observations never postpone the saved start', () => {
    const slower = apply(train(Array.from({ length: 5 }, (_, index) => sample(index, 24)))).recommendations[0];
    const faster = apply(train(Array.from({ length: 5 }, (_, index) => sample(index, 10)))).recommendations[0];
    const slowPlan = buildPreparationPlan(slower), fastPlan = buildPreparationPlan(faster);
    expect(Date.parse(slowPlan.effectiveLatestSafeStartAt)).toBeLessThan(Date.parse(slower.latestSafeStartAt));
    expect(Date.parse(fastPlan.learningLatestSafeStartAt)).toBeGreaterThan(Date.parse(faster.latestSafeStartAt));
    expect(fastPlan.effectiveLatestSafeStartAt).toBe(faster.latestSafeStartAt);
    expect(slower.targetServeAt).toBe(at(20));
    expect(slower.latestSafeStartAt).toBe(at(6));
  });
});
