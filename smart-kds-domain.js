const SMART_KDS_CONFIG_VERSION = 2;

const COURSE_TYPES = ['drink', 'soup', 'starter', 'main', 'side', 'dessert', 'other'];
const SCHEDULING_MODES = ['shadow', 'manual'];
const DISPLAY_MODES = ['normal', 'smart'];
const TASK_STATES = ['ordered', 'held', 'eligible', 'scheduled', 'fired', 'preparing', 'ready', 'expo', 'served', 'cancelled', 'superseded'];
const PROFILE_VERSION = 1;

function clampInteger(value, fallback, minimum, maximum) {
  const number = Number.parseInt(value, 10);
  return Number.isInteger(number) ? Math.max(minimum, Math.min(maximum, number)) : fallback;
}
function normalizeAdjustmentMap(source = {}) {
  const result = {};
  Object.entries(source && typeof source === 'object' ? source : {}).slice(0, 300).forEach(([key, value]) => {
    const cleanKey = String(key || '').trim().slice(0, 180);
    if (cleanKey) result[cleanKey] = clampInteger(value, 0, -60, 60);
  });
  return result;
}

function defaultSmartKdsConfig() {
  return {
    version: SMART_KDS_CONFIG_VERSION,
    enabled: false,
    mode: 'shadow',
    // This selects the kitchen workspace. It never enables automatic firing.
    displayMode: 'normal',
    courseOrder: [...COURSE_TYPES],
    courseDefaults: {
      drink: { targetMin: 8, targetMax: 12, spacingAfterMin: 0 },
      soup: { targetMin: 12, targetMax: 16, spacingAfterMin: 3 },
      // Starters are the first served course whenever the table has no soup.
      // Keep their default promise inside the restaurant's 15–25 minute window.
      starter: { targetMin: 15, targetMax: 25, spacingAfterMin: 5 },
      main: { targetMin: 28, targetMax: 38, spacingAfterMin: 0 },
      side: { targetMin: 24, targetMax: 34, spacingAfterMin: 0 },
      dessert: { targetMin: 10, targetMax: 15, spacingAfterMin: 0 },
      other: { targetMin: 20, targetMax: 30, spacingAfterMin: 0 },
    },
    timing: {
      platingMinutes: 2,
      handoffBufferMinutes: 2,
      courseReadyToleranceMinutes: 3,
      parcelDefaultTargetMinutes: 25,
      categoryTargetAdjustments: {},
      stationTargetAdjustments: {},
      stationHandoffAdjustments: {},
    },
    batching: { defaultWindowSeconds: 180, defaultMaxBatchSize: 8 },
    fairness: { starvationAfterMinutes: 25 },
    serviceRisk: { firstFoodAfterMinutes: 18, serviceGapAfterMinutes: 18 },
    riskThresholds: { watchMinutes: 8, startSoonMinutes: 4, criticalOverdueMinutes: 10 },
  };
}

function smartKdsMenuItemKey(menuType, category, name) {
  return [menuType, category, name]
    .map((value) => String(value || '').trim().toLowerCase().replace(/\s+/g, ' '))
    .join('::')
    .slice(0, 300);
}

function inferDefaultCourse(category, name, menuType = 'food') {
  const value = `${category || ''} ${name || ''}`.toLowerCase();
  if (menuType === 'bar' || /beverage|drink|mocktail|cocktail|juice|shake|lassi|tea|coffee|water|soda|beer|wine|whisk|rum|vodka|gin/.test(value)) return 'drink';
  if (/soup|broth|shorba/.test(value)) return 'soup';
  if (/dessert|ice.?cream|sweet|brownie|pudding|gulab|kulfi/.test(value)) return 'dessert';
  if (/bread|naan|roti|paratha|salad|raita|papad|side/.test(value)) return 'side';
  if (/starter|appetizer|lollipop|wings|fry|finger|tikka|kebab|65|chilli/.test(value)) return 'starter';
  if (/main|rice|noodle|biryani|sizzler|pasta|curry|gravy|thali/.test(value)) return 'main';
  return 'other';
}

function defaultMenuProductionProfile(item = {}, schedulingConfig = {}) {
  const course = COURSE_TYPES.includes(item.course) ? item.course : inferDefaultCourse(item.category, item.name, item.menuType);
  const courseTiming = schedulingConfig.courseDefaults?.[course] || { targetMin: 20, targetMax: 30 };
  const prepEstimate = clampInteger(courseTiming.targetMin, 20, 1, 240);
  return {
    version: PROFILE_VERSION,
    itemKey: String(item.itemKey || ''),
    course,
    stationId: item.stationId ? String(item.stationId) : '',
    prepTimeEstimate: prepEstimate,
    minPrepTime: Math.max(1, prepEstimate - 3),
    maxPrepTime: Math.max(prepEstimate, clampInteger(courseTiming.targetMax, 30, 1, 300)),
    platingTime: clampInteger(schedulingConfig.timing?.platingMinutes, 2, 0, 60),
    handoffBuffer: clampInteger(schedulingConfig.timing?.handoffBufferMinutes, 2, 0, 60),
    targetAdjustmentMinutes: 0,
    // Batching is deliberately opt-in. Compatibility and capacity must be
    // approved in the menu production profile, never guessed from a name.
    batchable: false,
    batchGroupId: '',
    maxBatchSize: clampInteger(schedulingConfig.batching?.defaultMaxBatchSize, 8, 1, 100),
    optimalBatchSize: clampInteger(schedulingConfig.batching?.defaultMaxBatchSize, 8, 1, 100),
    batchWindowSeconds: clampInteger(schedulingConfig.batching?.defaultWindowSeconds, 180, 0, 3600),
    parallelCapacityCost: 1,
    longPrepItem: false,
    requiresPreviousCourse: false,
    canPrePrep: false,
    canHoldAfterCooking: false,
    maxHoldTime: 0,
    priorityModifier: 0,
  };
}

function normalizeMenuProductionProfile(source = {}, item = {}, schedulingConfig = {}) {
  const defaults = defaultMenuProductionProfile(item, schedulingConfig);
  const course = COURSE_TYPES.includes(String(source.course || '').toLowerCase())
    ? String(source.course).toLowerCase()
    : defaults.course;
  const prepTimeEstimate = clampInteger(source.prepTimeEstimate, defaults.prepTimeEstimate, 1, 240);
  const minPrepTime = Math.min(prepTimeEstimate, clampInteger(source.minPrepTime, defaults.minPrepTime, 1, 240));
  const maxPrepTime = Math.max(prepTimeEstimate, clampInteger(source.maxPrepTime, defaults.maxPrepTime, 1, 300));
  const batchable = source.batchable === true;
  const maxBatchSize = batchable ? clampInteger(source.maxBatchSize, defaults.maxBatchSize, 1, 100) : 1;
  const optimalBatchSize = batchable
    ? Math.min(maxBatchSize, clampInteger(source.optimalBatchSize, defaults.optimalBatchSize, 1, 100))
    : 1;
  const canHoldAfterCooking = source.canHoldAfterCooking === true;
  return {
    ...defaults,
    version: PROFILE_VERSION,
    course,
    stationId: String(source.stationId || defaults.stationId || '').trim().slice(0, 120),
    prepTimeEstimate,
    minPrepTime,
    maxPrepTime,
    platingTime: clampInteger(source.platingTime, defaults.platingTime, 0, 60),
    handoffBuffer: clampInteger(source.handoffBuffer, defaults.handoffBuffer, 0, 60),
    targetAdjustmentMinutes: clampInteger(
      source.targetAdjustmentMinutes,
      defaults.targetAdjustmentMinutes,
      -60,
      60
    ),
    batchable,
    batchGroupId: batchable ? String(source.batchGroupId || '').trim().slice(0, 120) : '',
    maxBatchSize,
    optimalBatchSize,
    batchWindowSeconds: batchable ? clampInteger(source.batchWindowSeconds, defaults.batchWindowSeconds, 0, 3600) : 0,
    parallelCapacityCost: clampInteger(source.parallelCapacityCost, defaults.parallelCapacityCost, 1, 50),
    longPrepItem: source.longPrepItem === true,
    requiresPreviousCourse: source.requiresPreviousCourse === true,
    canPrePrep: source.canPrePrep === true,
    canHoldAfterCooking,
    maxHoldTime: canHoldAfterCooking ? clampInteger(source.maxHoldTime, defaults.maxHoldTime, 1, 240) : 0,
    priorityModifier: clampInteger(source.priorityModifier, defaults.priorityModifier, -100, 100),
  };
}

function normalizeSmartKdsConfig(source = {}) {
  const defaults = defaultSmartKdsConfig();
  const requestedOrder = Array.isArray(source.courseOrder) ? source.courseOrder : defaults.courseOrder;
  const courseOrder = [...new Set(requestedOrder.map((value) => String(value || '').toLowerCase()))]
    .filter((course) => COURSE_TYPES.includes(course));
  COURSE_TYPES.forEach((course) => {
    if (!courseOrder.includes(course)) courseOrder.push(course);
  });
  const courseDefaults = {};
  COURSE_TYPES.forEach((course) => {
    const baseline = defaults.courseDefaults[course];
    const value = source.courseDefaults?.[course] || {};
    const targetMin = clampInteger(value.targetMin, baseline.targetMin, 1, 240);
    const targetMax = Math.max(targetMin, clampInteger(value.targetMax, baseline.targetMax, 1, 300));
    courseDefaults[course] = {
      targetMin,
      targetMax,
      spacingAfterMin: clampInteger(value.spacingAfterMin, baseline.spacingAfterMin, 0, 120),
    };
  });
  return {
    version: SMART_KDS_CONFIG_VERSION,
    // Phase 1 deliberately cannot enable automated firing or prioritisation.
    enabled: false,
    mode: SCHEDULING_MODES.includes(source.mode) ? source.mode : defaults.mode,
    displayMode: DISPLAY_MODES.includes(source.displayMode) ? source.displayMode : defaults.displayMode,
    courseOrder,
    courseDefaults,
    timing: {
      platingMinutes: clampInteger(source.timing?.platingMinutes, defaults.timing.platingMinutes, 0, 60),
      handoffBufferMinutes: clampInteger(source.timing?.handoffBufferMinutes, defaults.timing.handoffBufferMinutes, 0, 60),
      courseReadyToleranceMinutes: clampInteger(source.timing?.courseReadyToleranceMinutes, defaults.timing.courseReadyToleranceMinutes, 0, 60),
      parcelDefaultTargetMinutes: clampInteger(source.timing?.parcelDefaultTargetMinutes, defaults.timing.parcelDefaultTargetMinutes, 1, 240),
      categoryTargetAdjustments: normalizeAdjustmentMap(source.timing?.categoryTargetAdjustments),
      stationTargetAdjustments: normalizeAdjustmentMap(source.timing?.stationTargetAdjustments),
      stationHandoffAdjustments: normalizeAdjustmentMap(source.timing?.stationHandoffAdjustments),
    },
    batching: {
      defaultWindowSeconds: clampInteger(source.batching?.defaultWindowSeconds, defaults.batching.defaultWindowSeconds, 0, 3600),
      defaultMaxBatchSize: clampInteger(source.batching?.defaultMaxBatchSize, defaults.batching.defaultMaxBatchSize, 1, 100),
    },
    fairness: {
      starvationAfterMinutes: clampInteger(source.fairness?.starvationAfterMinutes, defaults.fairness.starvationAfterMinutes, 1, 240),
    },
    serviceRisk: {
      firstFoodAfterMinutes: clampInteger(source.serviceRisk?.firstFoodAfterMinutes, defaults.serviceRisk.firstFoodAfterMinutes, 1, 240),
      serviceGapAfterMinutes: clampInteger(source.serviceRisk?.serviceGapAfterMinutes, defaults.serviceRisk.serviceGapAfterMinutes, 1, 240),
    },
    riskThresholds: {
      watchMinutes: clampInteger(source.riskThresholds?.watchMinutes, defaults.riskThresholds.watchMinutes, 1, 120),
      startSoonMinutes: clampInteger(source.riskThresholds?.startSoonMinutes, defaults.riskThresholds.startSoonMinutes, 0, 120),
      criticalOverdueMinutes: clampInteger(source.riskThresholds?.criticalOverdueMinutes, defaults.riskThresholds.criticalOverdueMinutes, 1, 240),
    },
  };
}

function isTaskState(value) {
  return TASK_STATES.includes(String(value || '').toLowerCase());
}

module.exports = {
  SMART_KDS_CONFIG_VERSION,
  COURSE_TYPES,
  SCHEDULING_MODES,
  DISPLAY_MODES,
  TASK_STATES,
  PROFILE_VERSION,
  defaultSmartKdsConfig,
  normalizeSmartKdsConfig,
  isTaskState,
  smartKdsMenuItemKey,
  inferDefaultCourse,
  defaultMenuProductionProfile,
  normalizeMenuProductionProfile,
};
