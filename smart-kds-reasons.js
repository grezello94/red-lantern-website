const REASON_CODES = new Set([
  'FIRST_COURSE', 'NEXT_EXPECTED_COURSE', 'LATEST_SAFE_START_APPROACHING', 'LATEST_SAFE_START_REACHED',
  'TARGET_TIME_AT_RISK', 'OVERDUE', 'NO_FOOD_SERVED_YET', 'SERVICE_GAP', 'BATCH_AVAILABLE',
  'BATCH_WINDOW_CLOSING', 'LONG_PREP_START_REQUIRED', 'STATION_CAPACITY_AVAILABLE', 'STATION_OVERLOADED',
  'WAITING_FOR_PREVIOUS_COURSE', 'SERVE_TOGETHER_SYNC', 'PARCEL_PROMISE_APPROACHING', 'MANUAL_PRIORITY',
  'STARVATION_PROTECTION',
]);

function reasonCodesForRecommendation(task = {}) {
  const codes = new Set();
  const text = [task.reason, task.finalReason, task.priorityReason, task.fairnessReason, task.pacingReason]
    .filter(Boolean).join(' ').toLowerCase();
  if (task.course === 'drink' || task.course === 'soup' || task.course === 'starter') codes.add('FIRST_COURSE');
  if (task.pacingState === 'hold-for-course' || /previous course/.test(text)) codes.add('WAITING_FOR_PREVIOUS_COURSE');
  if (task.pacingState === 'serve-together' || /together/.test(text)) codes.add('SERVE_TOGETHER_SYNC');
  if (/latest safe start.*approach/.test(text)) codes.add('LATEST_SAFE_START_APPROACHING');
  if (/latest safe start.*reach/.test(text)) codes.add('LATEST_SAFE_START_REACHED');
  if (/maximum service window|overdue/.test(text)) codes.add('OVERDUE');
  if (/target service window|at risk/.test(text)) codes.add('TARGET_TIME_AT_RISK');
  if (task.profile?.longPrepItem) codes.add('LONG_PREP_START_REQUIRED');
  if (task.mode === 'parcel' && (task.baseAction === 'start-now' || task.action === 'start-now')) codes.add('PARCEL_PROMISE_APPROACHING');
  if (task.protectedByFairness) codes.add('STARVATION_PROTECTION');
  if (task.manualOverride) codes.add('MANUAL_PRIORITY');
  if (task.capacityState === 'allocated') codes.add('STATION_CAPACITY_AVAILABLE');
  if (['capacity-wait', 'capacity-too-large'].includes(task.capacityState)) codes.add('STATION_OVERLOADED');
  if (/first food/.test(text)) codes.add('NO_FOOD_SERVED_YET');
  if (/service gap/.test(text)) codes.add('SERVICE_GAP');
  if (task.batchAction === 'fire-batch') codes.add('BATCH_AVAILABLE');
  if (task.batchAction === 'wait-for-batch') codes.add('BATCH_WINDOW_CLOSING');
  if (!codes.size) codes.add('NEXT_EXPECTED_COURSE');
  return [...codes].filter((code) => REASON_CODES.has(code));
}

module.exports = { REASON_CODES, reasonCodesForRecommendation };
