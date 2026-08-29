const { defaultSmartKdsConfig } = require('./smart-kds-domain');

function asDate(value, fallback = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date;
}

function isDineIn(order = {}) {
  return String(order.mode || '').toLowerCase() === 'table' || String(order.orderType || '').toLowerCase() === 'dine_in';
}

function timingConfig(config = {}) {
  const defaults = defaultSmartKdsConfig();
  return {
    ...defaults,
    ...config,
    timing: { ...defaults.timing, ...(config.timing || {}) },
    riskThresholds: { ...defaults.riskThresholds, ...(config.riskThresholds || {}) },
    courseDefaults: { ...defaults.courseDefaults, ...(config.courseDefaults || {}) },
  };
}

function timingState({ now, targetServeAt, latestAcceptableServeAt, latestSafeStartAt, watchMinutes = 0, startSoonMinutes = 0, criticalOverdueMinutes = 10 }) {
  const current = asDate(now);
  const target = asDate(targetServeAt);
  const latestSafeStart = asDate(latestSafeStartAt);
  const latestAcceptable = asDate(latestAcceptableServeAt || targetServeAt);
  if (current >= latestAcceptable.getTime() + Math.max(1, Number(criticalOverdueMinutes || 10)) * 60_000)
    return { state: 'critical', reason: 'Maximum service window has been exceeded for too long' };
  if (current >= latestAcceptable) return { state: 'overdue', reason: 'Maximum service window passed' };
  if (current >= target) return { state: 'at-risk', reason: 'Target service window has passed' };
  if (current >= latestSafeStart)
    return { state: 'start-now', reason: 'Latest safe start time reached' };
  if (current.getTime() >= latestSafeStart.getTime() - startSoonMinutes * 60_000)
    return { state: 'start-soon', reason: 'Latest safe start approaching' };
  if (current.getTime() >= latestSafeStart.getTime() - Math.max(startSoonMinutes, watchMinutes) * 60_000)
    return { state: 'watch', reason: 'Safe-start window is approaching' };
  return { state: 'safe', reason: 'Within planned timing window' };
}

function calculateTargetServeAt({ orderedAt, mode, course, presentCourses = [], targetAdjustmentMinutes = 0, config = {}, target = 'min' }) {
  const settings = timingConfig(config);
  const orderTime = asDate(orderedAt);
  if (!isDineIn({ mode }))
    return new Date(orderTime.getTime() + Number(settings.timing?.parcelDefaultTargetMinutes || 25) * 60_000);
  const courseOrder = Array.isArray(settings.courseOrder) ? settings.courseOrder : [];
  const selectedCourse = courseOrder.includes(course) ? course : 'other';
  const courseTarget = Number(settings.courseDefaults?.[selectedCourse]?.[target === 'max' ? 'targetMax' : 'targetMin'] || 20);
  const currentIndex = courseOrder.indexOf(selectedCourse);
  const present = new Set(presentCourses);
  const precedingSpacing = courseOrder.slice(0, Math.max(0, currentIndex)).reduce((total, earlier) => {
    return present.has(earlier)
      ? total + Number(settings.courseDefaults?.[earlier]?.spacingAfterMin || 0)
      : total;
  }, 0);
  return new Date(orderTime.getTime() + Math.max(1, courseTarget + precedingSpacing + Number(targetAdjustmentMinutes || 0)) * 60_000);
}

function calculateProductionTiming({ orderedAt, mode, course, presentCourses, profile = {}, targetAdjustmentMinutes = 0, config = {}, now = new Date() }) {
  const settings = timingConfig(config);
  const targetServeAt = calculateTargetServeAt({ orderedAt, mode, course, presentCourses, targetAdjustmentMinutes, config: settings });
  const latestAcceptableServeAt = calculateTargetServeAt({ orderedAt, mode, course, presentCourses, targetAdjustmentMinutes, config: settings, target: 'max' });
  const preparationMinutes = Math.max(1, Number(profile.prepTimeEstimate || 1));
  const minimumPreparationMinutes = Math.max(1, Math.min(preparationMinutes, Number(profile.minPrepTime || preparationMinutes)));
  // Safe-start decisions must use the slowest verified prep time, not an optimistic average.
  const conservativePreparationMinutes = Math.max(preparationMinutes, Number(profile.maxPrepTime || preparationMinutes));
  const platingMinutes = Math.max(0, Number(profile.platingTime ?? settings.timing?.platingMinutes ?? 0));
  const handoffMinutes = Math.max(0, Number(profile.handoffBuffer ?? settings.timing?.handoffBufferMinutes ?? 0));
  const latestSafeStartAt = new Date(
    targetServeAt.getTime() - (conservativePreparationMinutes + platingMinutes + handoffMinutes) * 60_000
  );
  const criticalAt = new Date(
    latestAcceptableServeAt.getTime() + Math.max(1, Number(settings.riskThresholds?.criticalOverdueMinutes || 10)) * 60_000
  );
  const status = timingState({
    now,
    targetServeAt,
    latestAcceptableServeAt,
    latestSafeStartAt,
    watchMinutes: Number(settings.riskThresholds?.watchMinutes || 0),
    startSoonMinutes: Number(settings.riskThresholds?.startSoonMinutes || 0),
    criticalOverdueMinutes: Number(settings.riskThresholds?.criticalOverdueMinutes || 10),
  });
  return {
    targetServeAt: targetServeAt.toISOString(),
    latestAcceptableServeAt: latestAcceptableServeAt.toISOString(),
    latestSafeStartAt: latestSafeStartAt.toISOString(),
    criticalAt: criticalAt.toISOString(),
    minimumPrepWindowMinutes: minimumPreparationMinutes + platingMinutes + handoffMinutes,
    estimatedPrepWindowMinutes: preparationMinutes + platingMinutes + handoffMinutes,
    prepWindowMinutes: conservativePreparationMinutes + platingMinutes + handoffMinutes,
    ...status,
  };
}

module.exports = { calculateTargetServeAt, calculateProductionTiming, timingState, timingConfig };
