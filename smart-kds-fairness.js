function asTime(value, fallback = Date.now()) {
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(time) ? time : fallback;
}

function waitMinutes(task, now) {
  return Math.max(0, Math.floor((asTime(now) - asTime(task.orderedAt, asTime(now))) / 60_000));
}

function urgencyBucket(task = {}) {
  if (task.action === 'start-now') return 0;
  if (task.action === 'prepare-next') return 1;
  return 2;
}

function isFairnessEligible(task = {}) {
  const taskState = String(task.taskState || 'ordered');
  const pacingState = String(task.pacingState || '');
  if (!['ordered', 'eligible', 'scheduled'].includes(taskState)) return false;
  if (['hold-for-course', 'manual-hold', 'served'].includes(pacingState)) return false;
  // Deadlines already outrank fairness, and monitor work is not yet safe to
  // pull forward. Fairness applies to genuinely waiting preparation work.
  return task.action === 'prepare-next';
}

function compareFairness(left, right) {
  const urgency = urgencyBucket(left) - urgencyBucket(right);
  if (urgency) return urgency;
  if (left.fairnessPriorityTier !== right.fairnessPriorityTier)
    return right.fairnessPriorityTier - left.fairnessPriorityTier;
  if (left.fairnessPriorityTier && left.waitedMinutes !== right.waitedMinutes)
    return right.waitedMinutes - left.waitedMinutes;
  const original = Number(left.originalRank || left.rank || Number.MAX_SAFE_INTEGER) - Number(right.originalRank || right.rank || Number.MAX_SAFE_INTEGER);
  if (original) return original;
  const leftKey = String(left.taskKey || '');
  const rightKey = String(right.taskKey || '');
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

function applyFairness({ recommendations = [], starvationAfterMinutes = 25, now = new Date() } = {}) {
  const threshold = Math.max(1, Math.min(240, Number(starvationAfterMinutes) || 25));
  const protectedTasks = recommendations.map((task) => {
    const waitedMinutes = waitMinutes(task, now);
    const fairnessTier = Math.floor(waitedMinutes / threshold);
    const fairnessEligible = isFairnessEligible(task);
    const protectedByFairness = fairnessEligible && fairnessTier > 0;
    const reasons = [...(task.reasons || [])];
    if (protectedByFairness)
      reasons.push(`Waiting ${waitedMinutes} min; anti-starvation threshold is ${threshold} min`);
    return {
      ...task,
      originalRank: Number(task.rank || Number.MAX_SAFE_INTEGER),
      waitedMinutes,
      fairnessTier,
      fairnessPriorityTier: protectedByFairness ? fairnessTier : 0,
      fairnessEligible,
      protectedByFairness,
      fairnessReason: protectedByFairness
        ? 'Anti-starvation protection applied'
        : !fairnessEligible
          ? 'Not eligible for automatic fairness promotion'
          : 'Within fairness waiting threshold',
      reasons,
    };
  }).sort(compareFairness).map((task, index) => ({ ...task, rank: index + 1, fairnessRank: index + 1 }));
  return {
    recommendations: protectedTasks,
    summary: {
      tasks: protectedTasks.length,
      protected: protectedTasks.filter((task) => task.protectedByFairness).length,
      eligible: protectedTasks.filter((task) => task.fairnessEligible).length,
      excluded: protectedTasks.filter((task) => !task.fairnessEligible).length,
      thresholdMinutes: threshold,
      longestWaitMinutes: protectedTasks.reduce((longest, task) => Math.max(longest, task.waitedMinutes), 0),
    },
  };
}

module.exports = { waitMinutes, isFairnessEligible, applyFairness, compareFairness };
