const RUNNING_REASON = 'Running order / additional portion, priority for a table already eating';
const PENDING = new Set(['ordered', 'eligible', 'scheduled']);
const HOLDS = new Set(['hold-for-course', 'manual-hold', 'served']);

function hasRunningNote(note) {
  return /(^|[^\p{L}\p{N}_])running(?=$|[^\p{L}\p{N}_])/iu.test(String(note || ''));
}

function runningOrderMetadata(task = {}) {
  const runningOrder = hasRunningNote(task.note) || hasRunningNote(task.orderNote);
  return { runningOrder, runningOrderReason: runningOrder ? RUNNING_REASON : '' };
}

function annotateRunningOrder(task = {}) {
  const metadata = runningOrderMetadata(task);
  return task.runningOrder === true && !metadata.runningOrder
    ? { ...task, runningOrderReason: task.runningOrderReason || RUNNING_REASON }
    : { ...task, ...metadata };
}

function isPriorityEligible(task = {}) {
  return (
    PENDING.has(String(task.taskState || 'ordered')) &&
    (!task.workflowState || PENDING.has(String(task.workflowState))) &&
    !HOLDS.has(String(task.pacingState || '')) &&
    !['hold', 'defer'].includes(task.manualOverride?.action)
  );
}

function isRunningOrderEligible(task = {}) {
  return (
    isPriorityEligible(task) &&
    (task.runningOrder === true || runningOrderMetadata(task).runningOrder)
  );
}

// Carry the scheduler's safety classes through later independent re-sorts.
// A critical service-risk flag may also protect genuinely actionable work.
function kitchenPriorityTier(task = {}) {
  if (!isPriorityEligible(task)) return 3;
  const action = task.baseAction || task.action;
  if (
    task.priorityClass === 'critical' ||
    ['critical', 'overdue'].includes(task.state) ||
    (task.serviceRiskSeverity === 'critical' && ['start-now', 'prepare-next'].includes(action))
  )
    return 0;
  if (
    task.priorityClass === 'manual-rush' ||
    ['rush', 'fire-now'].includes(task.manualOverride?.action)
  )
    return 1;
  return isRunningOrderEligible(task) ? 2 : 3;
}

function compareKitchenPriority(left, right) {
  return kitchenPriorityTier(left) - kitchenPriorityTier(right);
}

module.exports = {
  hasRunningNote,
  runningOrderMetadata,
  annotateRunningOrder,
  isRunningOrderEligible,
  kitchenPriorityTier,
  compareKitchenPriority,
};
