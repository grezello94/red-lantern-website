function capacityByTask(capacity = {}) {
  const map = new Map();
  [...(capacity.allocated || []), ...(capacity.capacityWait || []), ...(capacity.unassigned || [])].forEach((work) => {
    const taskKeys = work.kind === 'batch' ? (work.allocations || []).map((item) => item.taskKey) : [work.workKey];
    taskKeys.forEach((key) => map.set(key, work));
  });
  return map;
}

function buildUnifiedRecommendations({ fairness = {}, capacity = {}, serviceRisk = {} } = {}) {
  const byTask = capacityByTask(capacity);
  const riskByOrder = new Map((serviceRisk.risks || []).map((risk) => [String(risk.id || ''), risk]));
  const recommendations = (fairness.recommendations || []).map((task) => {
    const capacityWork = byTask.get(task.taskKey);
    const risk = riskByOrder.get(String(task.orderId || ''));
    const capacityState = task.taskState === 'held' ? 'manual-hold' : task.taskState === 'fired' ? 'fired' : task.taskState === 'preparing' ? 'in-progress' : task.taskState === 'ready' ? 'ready-for-expo' : task.taskState === 'expo' ? 'at-expo' : ['hold-for-course', 'manual-hold'].includes(task.pacingState) ? task.pacingState : capacityWork?.capacityState || 'unassigned';
    const baseAction = task.action;
    let action = task.action;
    let reason = task.priorityReason || task.fairnessReason;
    if (['held', 'fired', 'preparing', 'ready', 'expo'].includes(task.taskState)) {
      reason = task.taskState === 'held' ? 'Held by an authorised kitchen override' : task.taskState === 'fired' ? 'Food has been fired and is awaiting preparation' : task.taskState === 'preparing' ? 'Preparation is in progress' : task.taskState === 'ready' ? 'Food is ready for expo' : 'Food is waiting at expo for service';
    } else if (capacityState === 'manual-hold') {
      action = 'manual-hold';
      reason = task.pacingReason || 'Manual-fire course preference';
    } else if (capacityState === 'hold-for-course') {
      action = 'hold-for-course';
      reason = task.pacingReason || 'Waiting for the prior course';
    } else if (['capacity-wait', 'capacity-too-large'].includes(capacityState)) {
      action = 'wait-capacity';
      reason = capacityWork.capacityReason;
    } else if (capacityState === 'unassigned') {
      action = 'assign-station';
      reason = capacityWork?.capacityReason || 'No kitchen station assigned';
    } else if (risk?.riskType && risk.riskType !== 'on-track') {
      action = 'service-risk';
      reason = risk.reason;
    } else if (task.protectedByFairness) {
      action = 'fairness-protected';
      reason = task.fairnessReason;
    }
    return { ...task, baseAction, action, finalReason: reason, capacityState, stationCapacityVersion: capacityWork?.stationCapacityVersion ?? null, serviceRisk: risk?.riskType || 'on-track', serviceRiskSeverity: risk?.severity || 'on-track' };
  }).sort((left, right) => {
    const urgency = (left.baseAction === 'start-now' ? 0 : left.baseAction === 'prepare-next' ? 1 : 2) - (right.baseAction === 'start-now' ? 0 : right.baseAction === 'prepare-next' ? 1 : 2);
    if (urgency) return urgency;
    const risk = (right.serviceRiskSeverity === 'critical' ? 2 : right.serviceRiskSeverity === 'watch' ? 1 : 0) - (left.serviceRiskSeverity === 'critical' ? 2 : left.serviceRiskSeverity === 'watch' ? 1 : 0);
    return risk || Number(left.fairnessRank || 0) - Number(right.fairnessRank || 0);
  }).map((task, index) => ({ ...task, finalRank: index + 1 }));
  return {
    recommendations,
    summary: {
      tasks: recommendations.length,
      startNow: recommendations.filter((task) => task.action === 'start-now').length,
      waitingCapacity: recommendations.filter((task) => task.action === 'wait-capacity').length,
      needsStation: recommendations.filter((task) => task.action === 'assign-station').length,
      fairnessProtected: recommendations.filter((task) => task.action === 'fairness-protected').length,
      serviceRisk: recommendations.filter((task) => task.action === 'service-risk').length,
    },
  };
}

module.exports = { buildUnifiedRecommendations, capacityByTask };
