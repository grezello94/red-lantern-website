const MINUTE = 60_000;

function positive(value, fallback = 1) {
  const result = Number(value);
  return Number.isFinite(result) && result > 0 ? result : fallback;
}

function cookingWaves(task = {}) {
  const approvedSize = task.profile?.batchable === true ? positive(task.profile.maxBatchSize) : 1;
  return Math.ceil(positive(task.quantity) / approvedSize);
}

function conservativePreparationMilliseconds(task = {}) {
  const learnedMinutes = Number(task.learning?.estimateMinutes);
  if (task.learning?.applied === true && Number.isFinite(learnedMinutes) && learnedMinutes > 0)
    return learnedMinutes * cookingWaves(task) * MINUTE;
  const profile = task.profile || {};
  const cookMinutes = Math.max(positive(profile.prepTimeEstimate), positive(profile.maxPrepTime));
  const overhead =
    Math.max(0, Number(profile.platingTime) || 0) + Math.max(0, Number(profile.handoffBuffer) || 0);
  const singleWaveMinutes = Math.max(
    1,
    Number(task.prepWindowMinutes) || 0,
    cookMinutes + overhead
  );
  return singleWaveMinutes * cookingWaves(task) * MINUTE;
}

function buildPreparationPlan(task = {}) {
  const waves = cookingWaves(task);
  const target = task.targetServeAt == null ? NaN : new Date(task.targetServeAt).getTime();
  const originalStart =
    task.latestSafeStartAt == null ? NaN : new Date(task.latestSafeStartAt).getTime();
  const bulkStart =
    waves > 1 && Number.isFinite(target) ? target - conservativePreparationMilliseconds(task) : NaN;
  const learningStart = task.learning?.applied === true && Number.isFinite(target)
    ? target - conservativePreparationMilliseconds(task) : NaN;
  const effectiveStart = Math.min(
    Number.isFinite(originalStart) ? originalStart : Infinity,
    Number.isFinite(bulkStart) ? bulkStart : Infinity,
    Number.isFinite(learningStart) ? learningStart : Infinity
  );
  return {
    cookingWaves: waves,
    bulkLatestSafeStartAt: Number.isFinite(bulkStart) ? new Date(bulkStart).toISOString() : null,
    learningLatestSafeStartAt: Number.isFinite(learningStart) ? new Date(learningStart).toISOString() : null,
    effectiveLatestSafeStartAt: Number.isFinite(effectiveStart)
      ? new Date(effectiveStart).toISOString()
      : null,
  };
}

module.exports = { cookingWaves, conservativePreparationMilliseconds, buildPreparationPlan };
