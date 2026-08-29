function asTime(value, fallback = Number.POSITIVE_INFINITY) {
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(time) ? time : fallback;
}

function lexicalCompare(left, right) {
  const a = String(left || '');
  const b = String(right || '');
  return a < b ? -1 : a > b ? 1 : 0;
}

const SCHEDULABLE_TASK_STATES = new Set(['ordered', 'eligible', 'scheduled']);
const BLOCKED_PACING_STATES = new Set(['hold-for-course', 'manual-hold', 'served']);

function isSchedulableTask(task = {}) {
  if (!task || !task.taskKey || !task.targetServeAt || !task.latestSafeStartAt) return false;
  if (!Number.isFinite(asTime(task.targetServeAt)) || !Number.isFinite(asTime(task.latestSafeStartAt)))
    return false;
  if (task.taskState && !SCHEDULABLE_TASK_STATES.has(String(task.taskState))) return false;
  if (task.workflowState && !SCHEDULABLE_TASK_STATES.has(String(task.workflowState))) return false;
  if (BLOCKED_PACING_STATES.has(String(task.pacingState || ''))) return false;
  const override = String(task.manualOverride?.action || '').toLowerCase();
  return !['hold', 'defer'].includes(override);
}

function taskUrgency(task, now) {
  const current = asTime(now, Date.now());
  const target = asTime(task.targetServeAt);
  const latestAcceptable = asTime(task.latestAcceptableServeAt || task.targetServeAt);
  const latestSafeStart = asTime(task.latestSafeStartAt);
  const manualAction = String(task.manualOverride?.action || '').toLowerCase();
  const criticalAt = asTime(task.criticalAt, Number.POSITIVE_INFINITY);
  if (current >= criticalAt)
    return { bucket: 0, action: 'start-now', reason: 'Maximum service window has been exceeded for too long' };
  if (current >= latestAcceptable)
    return { bucket: 0, action: 'start-now', reason: 'Maximum service window passed' };
  if (['rush', 'fire-now'].includes(manualAction))
    return { bucket: 1, action: 'start-now', reason: 'Manual priority override' };
  if (current >= target) return { bucket: 2, action: 'start-now', reason: 'Target serve time passed' };
  if (current >= latestSafeStart)
    return { bucket: 3, action: 'start-now', reason: 'Latest safe start time reached' };
  if (['start-soon', 'prepare-next'].includes(String(task.state || '')) || current >= asTime(task.plannedStartAt, Number.POSITIVE_INFINITY))
    return { bucket: 4, action: 'prepare-next', reason: 'Latest safe start approaching' };
  return { bucket: 5, action: 'monitor', reason: 'Within planned timing window' };
}

function compareCandidates(left, right) {
  if (left.urgency.bucket !== right.urgency.bucket)
    return left.urgency.bucket - right.urgency.bucket;
  const leftSafe = asTime(left.task.latestSafeStartAt);
  const rightSafe = asTime(right.task.latestSafeStartAt);
  if (leftSafe !== rightSafe) return leftSafe - rightSafe;
  const leftCourse = left.task.pacingState === 'current-course' ? 0 : 1;
  const rightCourse = right.task.pacingState === 'current-course' ? 0 : 1;
  if (leftCourse !== rightCourse) return leftCourse - rightCourse;
  const leftModifier = Number(left.task.profile?.priorityModifier || 0);
  const rightModifier = Number(right.task.profile?.priorityModifier || 0);
  if (leftModifier !== rightModifier) return rightModifier - leftModifier;
  const leftOrdered = asTime(left.task.orderedAt);
  const rightOrdered = asTime(right.task.orderedAt);
  if (leftOrdered !== rightOrdered) return leftOrdered - rightOrdered;
  const leftOrder = Number(left.task.orderNumber || 0);
  const rightOrder = Number(right.task.orderNumber || 0);
  if (leftOrder !== rightOrder) return leftOrder - rightOrder;
  return lexicalCompare(left.task.taskKey, right.task.taskKey);
}

function scheduleKitchen({ now = new Date(), tasks = [] } = {}) {
  const candidates = tasks
    .filter(isSchedulableTask)
    .map((task) => ({ task, urgency: taskUrgency(task, now) }))
    .sort(compareCandidates);
  return candidates.map((candidate, index) => {
    const { task, urgency } = candidate;
    const reasons = [urgency.reason];
    if (task.pacingState === 'current-course') reasons.push('Next expected course');
    if (task.profile?.longPrepItem) reasons.push('Long-prep item');
    if (Number(task.profile?.priorityModifier || 0) > 0) reasons.push('Dish priority modifier applied');
    return {
      ...task,
      rank: index + 1,
      action: urgency.action,
      priorityReason: reasons[0],
      reasons,
    };
  });
}

module.exports = { SCHEDULABLE_TASK_STATES, isSchedulableTask, scheduleKitchen, taskUrgency, compareCandidates };
