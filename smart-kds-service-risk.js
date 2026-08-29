function asTime(value, fallback = Date.now()) {
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(time) ? time : fallback;
}

function validTime(value) {
  const result = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(result) ? result : null;
}

function isDineIn(order = {}) { return String(order.mode || '').toLowerCase() === 'table'; }

function evaluateServiceRisk({ orders = [], config = {}, now = new Date() } = {}) {
  const firstFoodAfterMinutes = Math.max(1, Math.min(240, Number(config.serviceRisk?.firstFoodAfterMinutes || 18)));
  const serviceGapAfterMinutes = Math.max(1, Math.min(240, Number(config.serviceRisk?.serviceGapAfterMinutes || 18)));
  const current = asTime(now);
  const risks = orders.filter(isDineIn).map((order) => {
    const courseEvents = Array.isArray(order.courseEvents) ? order.courseEvents : [];
    const served = courseEvents
      .filter((course) => validTime(course.servedAt) !== null)
      .sort((a, b) => validTime(a.servedAt) - validTime(b.servedAt));
    const hasPendingFood = order.hasPendingFood !== false;
    const ageMinutes = Math.max(0, Math.floor((current - asTime(order.orderedAt, current)) / 60_000));
    const lastServedAt = served.at(-1)?.servedAt || null;
    const minutesSinceLastFood = lastServedAt ? Math.max(0, Math.floor((current - asTime(lastServedAt)) / 60_000)) : ageMinutes;
    const noFoodRisk = hasPendingFood && !lastServedAt && ageMinutes >= firstFoodAfterMinutes;
    const gapRisk = hasPendingFood && !!lastServedAt && minutesSinceLastFood >= serviceGapAfterMinutes;
    const threshold = noFoodRisk ? firstFoodAfterMinutes : serviceGapAfterMinutes;
    const risk = noFoodRisk || gapRisk;
    const severity = !risk ? 'on-track' : minutesSinceLastFood >= threshold + 10 ? 'critical' : 'watch';
    return {
      ...order, hasEverReceivedFood: !!lastServedAt, hasPendingFood, lastServedAt, ageMinutes, minutesSinceLastFood,
      riskType: noFoodRisk ? 'first-food-risk' : gapRisk ? 'service-gap-risk' : 'on-track',
      severity,
      reason: noFoodRisk ? `No food served after ${ageMinutes} minutes` : gapRisk ? `No food served for ${minutesSinceLastFood} minutes` : !hasPendingFood ? 'All ordered courses have been served' : 'Table service is within the configured risk window',
    };
  }).sort((left, right) => (right.severity === 'critical') - (left.severity === 'critical') || right.minutesSinceLastFood - left.minutesSinceLastFood || Number(left.orderNumber || 0) - Number(right.orderNumber || 0));
  return { risks, summary: { tables: risks.length, firstFoodRisk: risks.filter((risk) => risk.riskType === 'first-food-risk').length, serviceGapRisk: risks.filter((risk) => risk.riskType === 'service-gap-risk').length, critical: risks.filter((risk) => risk.severity === 'critical').length, completedService: risks.filter((risk) => !risk.hasPendingFood).length } };
}

function serviceRiskPriority(severity) {
  return severity === 'critical' ? 2 : severity === 'watch' ? 1 : 0;
}

function isServiceRiskEligible(task = {}) {
  const state = String(task.taskState || 'ordered');
  if (!['ordered', 'eligible', 'scheduled'].includes(state)) return false;
  if (['hold-for-course', 'manual-hold', 'served'].includes(String(task.pacingState || ''))) return false;
  return ['start-now', 'prepare-next'].includes(String(task.action || ''));
}

function applyServiceRiskPriority({ recommendations = [], risks = [] } = {}) {
  const riskByOrder = new Map((Array.isArray(risks) ? risks : []).map((risk) => [String(risk.id || ''), risk]));
  return (Array.isArray(recommendations) ? recommendations : [])
    .map((task) => {
      const risk = riskByOrder.get(String(task.orderId || ''));
      const priority = isServiceRiskEligible(task) ? serviceRiskPriority(risk?.severity) : 0;
      return {
        ...task,
        originalRiskRank: Number(task.rank || Number.MAX_SAFE_INTEGER),
        serviceRisk: risk?.riskType || 'on-track',
        serviceRiskSeverity: risk?.severity || 'on-track',
        serviceRiskReason: risk?.reason || '',
        serviceRiskPriority: priority,
      };
    })
    .sort((left, right) => {
      const urgency = (left.action === 'start-now' ? 0 : left.action === 'prepare-next' ? 1 : 2) - (right.action === 'start-now' ? 0 : right.action === 'prepare-next' ? 1 : 2);
      if (urgency) return urgency;
      if (left.serviceRiskPriority !== right.serviceRiskPriority) return right.serviceRiskPriority - left.serviceRiskPriority;
      const fairness = Number(left.fairnessRank || left.originalRiskRank) - Number(right.fairnessRank || right.originalRiskRank);
      if (fairness) return fairness;
      return String(left.taskKey || '').localeCompare(String(right.taskKey || ''));
    })
    .map((task, index) => ({ ...task, rank: index + 1, serviceRiskRank: index + 1 }));
}

module.exports = { evaluateServiceRisk, serviceRiskPriority, isServiceRiskEligible, applyServiceRiskPriority };
