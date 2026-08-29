const { defaultSmartKdsConfig } = require('./smart-kds-domain');

const COURSE_PACING_MODES = ['normal_coursing', 'serve_together', 'as_ready', 'manual_fire'];

function asTime(value, fallback = Date.now()) {
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(time) ? time : fallback;
}

function isDineIn(order = {}) {
  return String(order.mode || '').toLowerCase() === 'table' || String(order.orderType || '').toLowerCase() === 'dine_in';
}

function normalizeCoursePacingMode(value, order = {}) {
  if (!isDineIn(order)) return 'as_ready';
  const mode = String(value || '').trim().toLowerCase();
  return COURSE_PACING_MODES.includes(mode) ? mode : 'normal_coursing';
}

function resolvedConfig(config = {}) {
  const defaults = defaultSmartKdsConfig();
  return {
    ...defaults,
    ...config,
    courseOrder: Array.isArray(config.courseOrder) ? config.courseOrder : defaults.courseOrder,
    timing: { ...defaults.timing, ...(config.timing || {}) },
  };
}

function taskStartAt(task = {}) {
  return new Date(asTime(task.targetServeAt) - Math.max(0, Number(task.prepWindowMinutes || 0)) * 60_000).toISOString();
}

function byCourseOrder(left, right, config) {
  const order = config.courseOrder || [];
  const leftPosition = order.indexOf(left);
  const rightPosition = order.indexOf(right);
  const leftIndex = leftPosition < 0 ? order.length : leftPosition;
  const rightIndex = rightPosition < 0 ? order.length : rightPosition;
  if (leftIndex !== rightIndex) return leftIndex - rightIndex;
  return String(left).localeCompare(String(right));
}

function validTime(value) {
  const result = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(result) ? result : null;
}

function sharedServiceTiming(tasks = [], fallback = Date.now()) {
  const targets = tasks.map((task) => validTime(task.targetServeAt)).filter((value) => value !== null);
  const desiredTargetAt = targets.length ? Math.max(...targets) : fallback;
  const maximums = tasks
    .map((task) => validTime(task.latestAcceptableServeAt))
    .filter((value) => value !== null);
  const latestAcceptableServeAt = maximums.length ? Math.min(...maximums) : null;
  return {
    // Do not synchronize a course later than one of its saved maximum service
    // windows. If the desired target is impossible, the plan moves earlier and
    // exposes that it needs kitchen attention rather than hiding an SLA breach.
    targetServeAt: Math.min(desiredTargetAt, latestAcceptableServeAt ?? desiredTargetAt),
    latestAcceptableServeAt,
  };
}

function paceTaskTiming(task = {}, timing = {}, fallback = Date.now()) {
  const prepMilliseconds = Math.max(0, Number(task.prepWindowMinutes || 0)) * 60_000;
  const target = Number(timing.targetServeAt || fallback);
  const originalLatestSafe = validTime(task.latestSafeStartAt);
  const taskLatestAcceptable = validTime(task.latestAcceptableServeAt);
  const sharedLatestAcceptable = timing.latestAcceptableServeAt ?? taskLatestAcceptable;
  const latestAcceptableServeAt = Math.min(
    sharedLatestAcceptable ?? Number.POSITIVE_INFINITY,
    taskLatestAcceptable ?? Number.POSITIVE_INFINITY
  );
  const calculatedSafeStart = target - prepMilliseconds;
  const latestSafeStartAt = Math.min(
    originalLatestSafe ?? Number.POSITIVE_INFINITY,
    calculatedSafeStart
  );
  return {
    plannedStartAt: new Date(calculatedSafeStart).toISOString(),
    pacingTargetServeAt: new Date(target).toISOString(),
    pacingLatestAcceptableServeAt: Number.isFinite(latestAcceptableServeAt)
      ? new Date(latestAcceptableServeAt).toISOString()
      : task.latestAcceptableServeAt || null,
    pacingLatestSafeStartAt: new Date(latestSafeStartAt).toISOString(),
  };
}

function buildCoursePacing({ order = {}, config = {}, now = new Date() } = {}) {
  const settings = resolvedConfig(config);
  const current = asTime(now);
  const mode = normalizeCoursePacingMode(order.courseMode || order.course_mode, order);
  const tasks = Array.isArray(order.tasks) ? order.tasks : [];
  const grouped = new Map();
  tasks.forEach((task) => {
    const course = String(task.course || 'other');
    if (!grouped.has(course)) grouped.set(course, []);
    grouped.get(course).push(task);
  });
  const courses = [...grouped.keys()].sort((left, right) => byCourseOrder(left, right, settings));
  const courseStates = order.courseStates && typeof order.courseStates === 'object' ? order.courseStates : {};
  const activeCourses = courses.filter((course) => String(courseStates[course] || 'ordered') !== 'served');
  const nextExpectedCourse = mode === 'normal_coursing' ? activeCourses[0] || null : null;
  const orderTogetherTiming = mode === 'serve_together' ? sharedServiceTiming(tasks, current) : null;
  const toleranceMinutes = Math.max(0, Number(settings.timing?.courseReadyToleranceMinutes || 0));
  const coursePlans = courses.map((course, index) => {
    const courseTasks = grouped.get(course) || [];
    const persistedState = String(courseStates[course] || 'ordered');
    const courseTiming = orderTogetherTiming || sharedServiceTiming(courseTasks, current);
    const targetServeAt = new Date(courseTiming.targetServeAt).toISOString();
    const planned = courseTasks.map((task) => {
      const applySynchronization = mode === 'serve_together' || mode === 'normal_coursing';
      const pacingTiming = applySynchronization
        ? paceTaskTiming(task, courseTiming, current)
        : paceTaskTiming(task, {
          targetServeAt: validTime(task.targetServeAt) ?? current,
          latestAcceptableServeAt: validTime(task.latestAcceptableServeAt),
        }, current);
      const plannedStartAt = pacingTiming.plannedStartAt;
      const isCurrentCourse = course === nextExpectedCourse;
      const profile = task.profile || {};
      let pacingState = 'as-ready';
      let pacingReason = 'Parcel and takeaway items are paced as ready';
      if (persistedState === 'served') {
        pacingState = 'served';
        pacingReason = 'This course has been marked served';
      } else if (mode === 'manual_fire') {
        pacingState = 'manual-hold';
        pacingReason = 'Manual-fire course preference';
      } else if (mode === 'serve_together') {
        pacingState = asTime(plannedStartAt) <= current ? 'sync-start' : 'sync-watch';
        pacingReason = 'Serve-together target synchronizes completion across this order';
      } else if (mode === 'normal_coursing') {
        if (isCurrentCourse) {
          pacingState = 'current-course';
          pacingReason = 'Next expected course for this table';
        } else if (profile.requiresPreviousCourse) {
          pacingState = 'hold-for-course';
          pacingReason = `Requires ${courses[Math.max(0, index - 1)] || 'previous'} course before preparation`;
        } else if (profile.canPrePrep || profile.longPrepItem || asTime(plannedStartAt) <= current) {
          pacingState = 'pre-prep';
          pacingReason = profile.longPrepItem
            ? 'Long-prep item should begin before the prior course finishes'
            : 'Preparation window permits safe pre-prep before the prior course';
        } else {
          pacingState = 'hold-for-course';
          pacingReason = `Waiting for ${nextExpectedCourse || 'the current'} course`;
        }
      } else if (mode === 'as_ready') {
        pacingState = 'as-ready';
        pacingReason = 'Order is configured to serve items as ready';
      }
      const readyWindowStartAt = new Date(asTime(targetServeAt) - toleranceMinutes * 60_000).toISOString();
      const readyWindowEndAt = new Date(asTime(targetServeAt) + toleranceMinutes * 60_000).toISOString();
      return {
        ...task,
        ...pacingTiming,
        readyWindowStartAt,
        readyWindowEndAt,
        pacingState,
        pacingReason,
      };
    });
    return {
      course,
      sequence: index + 1,
      state: persistedState === 'served' ? 'served' : course === nextExpectedCourse ? 'next' : mode === 'serve_together' ? 'together' : 'upcoming',
      targetServeAt,
      latestAcceptableServeAt: courseTiming.latestAcceptableServeAt
        ? new Date(courseTiming.latestAcceptableServeAt).toISOString()
        : null,
      readyWindowStartAt: new Date(asTime(targetServeAt) - toleranceMinutes * 60_000).toISOString(),
      readyWindowEndAt: new Date(asTime(targetServeAt) + toleranceMinutes * 60_000).toISOString(),
      tasks: planned,
    };
  });
  return {
    ...order,
    courseMode: mode,
    nextExpectedCourse,
    toleranceMinutes,
    courses: coursePlans,
    tasks: coursePlans.flatMap((course) => course.tasks),
  };
}

function buildCoursePacingPreview({ orders = [], config = {}, now = new Date() } = {}) {
  const pacedOrders = orders.map((order) => buildCoursePacing({ order, config, now }));
  const tasks = pacedOrders.flatMap((order) => order.tasks);
  const count = (state) => tasks.filter((task) => task.pacingState === state).length;
  return {
    orders: pacedOrders,
    summary: {
      orders: pacedOrders.length,
      courses: pacedOrders.reduce((total, order) => total + order.courses.length, 0),
      currentCourse: count('current-course'),
      prePrep: count('pre-prep'),
      holdForCourse: count('hold-for-course'),
      synchronized: count('sync-start') + count('sync-watch'),
      manualHold: count('manual-hold'),
      served: count('served'),
    },
  };
}

module.exports = {
  COURSE_PACING_MODES,
  normalizeCoursePacingMode,
  taskStartAt,
  buildCoursePacing,
  buildCoursePacingPreview,
};
