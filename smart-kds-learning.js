// Observational calibration only: the chef profile, service promise and actual
// kitchen acknowledgements remain authoritative. Estimates are one full wave
// from an actual Preparing acknowledgement to an actual Ready acknowledgement.
const MINUTE = 60_000;
const BANDS = new Set(['quiet', 'busy', 'surge']);
const ACTIVE = new Set(['ordered', 'eligible', 'scheduled', 'fired', 'preparing']);
const TERMINAL = new Set(['ready', 'expo', 'served', 'cancelled', 'superseded']);
const finite = (value, fallback = null) => value !== null && value !== '' && Number.isFinite(Number(value)) ? Number(value) : fallback;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const timestamp = (value) => value == null || value === '' ? null : finite(new Date(value).getTime());
const bandOf = (value) => BANDS.has(String(value || '').toLowerCase()) ? String(value).toLowerCase() : 'unknown';
const text = (value) => String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
const profileOf = (source) => source.profile || source.profileSnapshot || source.profile_snapshot || {};

function recipeNote(value) {
  // Remove only recognized operational phrases. Ingredient instructions such
  // as "no onion" remain part of the recipe identity and are never rewritten.
  const note = text(value);
  const running = /(^|[^\p{L}\p{N}_])running(?=$|[^\p{L}\p{N}_])/iu.test(note);
  return (running ? note.replace(/(^|[^\p{L}\p{N}_])running(?=$|[^\p{L}\p{N}_])/giu, '$1 ')
    .replace(/^\s*order\b/, ' ').replace(/\b(?:extra|additional)\s+portions?\b/g, ' ') : note)
    .replace(/[\s,;:|\-–—]+/g, ' ').trim();
}

function modifiersKey(modifiers) {
  return (Array.isArray(modifiers) ? modifiers : []).map((group) => [
    text(group.groupId || group.groupName || group.name),
    (Array.isArray(group.options) ? group.options : []).map((option) => [
      text(option.optionId || option.name || option.label), text(option.name || option.label),
      Math.max(1, finite(option.quantity, 1)),
    ]).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
  ]).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function dishKey(source) {
  const explicit = source.itemKey || source.item_key || profileOf(source).itemKey;
  if (explicit) return text(explicit);
  const name = source.itemName || source.name || source.item_name;
  return name ? [source.menuType || 'food', source.category || '', name].map(text).join('::') : '';
}

function kitchenLearningKey(source = {}, loadBand = source.loadBand) {
  const key = dishKey(source);
  return key ? JSON.stringify([key, String(source.stationId ?? source.station_id ?? ''), text(source.portion), text(source.style), modifiersKey(source.modifiers),
    recipeNote(source.note), recipeNote(source.orderNote), finite(source.quantity ?? source.requested_quantity, 1), bandOf(loadBand)]) : '';
}

function waves(source = {}) {
  const profile = profileOf(source);
  const amount = Math.max(1, finite(source.quantity ?? source.requested_quantity, 1));
  const approved = typeof profile.batchable === 'boolean' ? profile.batchable : source.batchable === true;
  const size = approved
    ? Math.max(1, finite(profile.maxBatchSize ?? source.maxBatchSize, 1)) : 1;
  return Math.ceil(amount / size);
}

function stationKey(station) { return String(station.station_id ?? station.stationId ?? station.id ?? ''); }

function stationCapacity(station = {}) {
  if (station.enabled === false) return 0;
  return Math.max(0, finite(station.available_capacity ?? station.availableCapacity ?? station.totalCapacity ?? station.max_concurrent_tasks, 0));
}

function loadUnits(task) {
  const state = task.taskState || task.task_state || 'ordered';
  if (!ACTIVE.has(state)) return 0;
  if (!['fired', 'preparing'].includes(state) && (['hold-for-course', 'manual-hold', 'served'].includes(task.pacingState)
    || ['hold', 'defer'].includes(task.manualOverride?.action))) return 0;
  return waves(task) * Math.max(1, finite(profileOf(task).parallelCapacityCost, 1));
}

function classifyLearningLoad({ recommendations = [], stations = [], stationId } = {}) {
  const selected = (Array.isArray(stations) ? stations : []).filter((station) => stationId == null || stationKey(station) === String(stationId));
  const capacity = selected.reduce((sum, station) => sum + stationCapacity(station), 0);
  if (!capacity) return 'unknown';
  const ids = new Set(selected.map(stationKey));
  const unique = new Map();
  (Array.isArray(recommendations) ? recommendations : []).forEach((task, index) => {
    if (ids.has(String(task.stationId ?? task.station_id ?? ''))) unique.set(task.taskKey || task.task_id || `row:${index}`, task);
  });
  const units = new Map();
  for (const [key, task] of unique) {
    const batch = ['fired', 'preparing'].includes(task.taskState || task.task_state)
      && (task.activeBatchId || task.active_batch_id);
    const groupKey = batch ? `batch:${task.stationId || task.station_id}:${batch}` : `task:${key}`;
    const work = batch ? Math.max(1, finite(profileOf(task).parallelCapacityCost, 1)) : loadUnits(task);
    units.set(groupKey, Math.max(units.get(groupKey) || 0, work));
  }
  const pressure = [...units.values()].reduce((sum, work) => sum + work, 0) / capacity;
  return pressure >= 5 ? 'surge' : pressure > 2 ? 'busy' : 'quiet';
}

function calculateLoadBands(options = {}) {
  return Object.fromEntries((Array.isArray(options.stations) ? options.stations : []).map((station) => [
    stationKey(station), classifyLearningLoad({ ...options, stationId: stationKey(station) }),
  ]));
}

function percentile(values, quantile) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const at = (sorted.length - 1) * quantile;
  const lower = Math.floor(at);
  return sorted[lower] + (sorted[Math.ceil(at)] - sorted[lower]) * (at - lower);
}

function learnKitchenPatterns({ samples = [], now = new Date(), minimumSamples = 5, windowDays = 30, maxSamples = 2000, enabled = true } = {}) {
  const current = timestamp(now) ?? Date.now();
  const minimum = clamp(Math.floor(finite(minimumSamples, 5)), 5, 100);
  const limit = clamp(Math.floor(finite(maxSamples, 2000)), 1, 10000);
  const cutoff = current - clamp(finite(windowDays, 30), 1, 90) * 24 * 60 * MINUTE;
  const input = Array.isArray(samples) ? samples : [];
  const rejectedByReason = {};
  const reject = (reason) => { rejectedByReason[reason] = (rejectedByReason[reason] || 0) + 1; };
  const unique = new Map();
  const observedBatches = new Set();
  if (enabled) input.forEach((sample) => {
    if (!sample || typeof sample !== 'object') { reject('incomplete'); return; }
    const preparing = timestamp(sample.preparingAt ?? sample.preparing_at);
    const ready = timestamp(sample.readyAt ?? sample.ready_at);
    if (preparing == null || ready == null || sample.readyConfirmedWithoutRecordedStart === true) { reject('unconfirmed-start'); return; }
    if (ready <= preparing || ready > current || preparing < cutoff) { reject('invalid-time'); return; }
    const minutes = (ready - preparing) / MINUTE;
    if (minutes < 0.5 || minutes > 240) { reject('absurd-duration'); return; }
    const quantity = finite(sample.quantity ?? sample.requested_quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || waves(sample) !== 1
      || finite(sample.cookingWaves ?? sample.cooking_waves, 1) !== 1) { reject('multiple-or-unknown-waves'); return; }
    const batchId = sample.batchId || sample.activeBatchId || sample.active_batch_id;
    if (batchId && (sample.batchTaskCount ?? sample.batch_task_count) !== 1) { reject('correlated-batch'); return; }
    const loadBand = bandOf(sample.loadBand ?? sample.load_band);
    const key = kitchenLearningKey(sample, loadBand);
    if (!key) { reject('missing-dish'); return; }
    const sampleId = String(sample.sampleId ?? sample.sample_id ?? sample.eventId ?? sample.event_id
      ?? JSON.stringify([key, sample.taskKey || sample.task_id || '', preparing, ready, quantity]));
    if (unique.has(sampleId) || (batchId && observedBatches.has(String(batchId)))) { reject('duplicate'); return; }
    if (batchId) observedBatches.add(String(batchId));
    unique.set(sampleId, { key, dish: dishKey(sample), minutes, ready, loadBand, sampleId });
  });
  const recent = [...unique.values()].sort((left, right) => right.ready - left.ready || left.sampleId.localeCompare(right.sampleId)).slice(0, limit);
  if (unique.size > recent.length) rejectedByReason['sample-limit'] = unique.size - recent.length;
  const grouped = new Map();
  recent.forEach((sample) => {
    if (!grouped.has(sample.key)) grouped.set(sample.key, []);
    grouped.get(sample.key).push(sample);
  });
  const groups = {};
  for (const [key, entries] of grouped) {
    const durations = entries.map((entry) => entry.minutes);
    const median = percentile(durations, 0.5);
    const deviation = percentile(durations.map((value) => Math.abs(value - median)), 0.5);
    const tolerance = Math.max(2, deviation * 1.4826 * 3);
    const clean = durations.filter((value) => Math.abs(value - median) <= tolerance);
    if (clean.length < durations.length) rejectedByReason.outlier = (rejectedByReason.outlier || 0) + durations.length - clean.length;
    groups[key] = {
      sampleCount: clean.length, rawSampleCount: durations.length, loadBand: entries[0].loadBand,
      percentileMinutes: percentile(clean, 0.85), medianMinutes: percentile(clean, 0.5),
      minimumMinutes: Math.min(...clean), maximumMinutes: Math.max(...clean),
      latestSampleAt: new Date(entries[0].ready).toISOString(),
    };
  }
  const values = Object.values(groups);
  const qualifyingSamples = values.reduce((sum, group) => sum + group.sampleCount, 0);
  return {
    version: 1, generatedAt: new Date(current).toISOString(), minimumSamples: minimum, groups,
    summary: { enabled: !!enabled, receivedSamples: input.length, qualifyingSamples,
      rejectedSamples: input.length - qualifyingSamples, trackedDishes: new Set(recent.map((entry) => entry.dish)).size,
      learnedGroups: values.filter((group) => group.sampleCount >= minimum).length,
      unknownLoadSamples: values.filter((group) => group.loadBand === 'unknown').reduce((sum, group) => sum + group.sampleCount, 0),
      learnedTasks: 0, rejectedByReason },
  };
}

function baselineTiming(task) {
  const profile = profileOf(task);
  const overhead = Math.max(0, finite(profile.platingTime, 0)) + Math.max(0, finite(profile.handoffBuffer, 0));
  const maximum = Math.max(1, finite(profile.maxPrepTime, finite(profile.prepTimeEstimate, 1)), finite(profile.prepTimeEstimate, 1));
  const minimum = Math.min(maximum, Math.max(1, finite(profile.minPrepTime, finite(profile.prepTimeEstimate, maximum))));
  const baseline = Math.max(maximum + overhead, finite(task.prepWindowMinutes, 0));
  return { baseline, minimum: minimum + overhead, maximum: 2 * (maximum + overhead) };
}

function applyKitchenLearning({ recommendations = [], model = {}, loadBand, loadByStation, stations = [], enabled = true, now = new Date() } = {}) {
  const current = timestamp(now) ?? Date.now();
  const bands = loadByStation || calculateLoadBands({ recommendations, stations });
  const minimum = Math.max(5, finite(model.minimumSamples, 5));
  const active = !!enabled && model.summary?.enabled !== false;
  let learnedTasks = 0;
  const tasks = (Array.isArray(recommendations) ? recommendations : []).map((task) => {
    const station = String(task.stationId ?? task.station_id ?? '');
    const currentBand = bandOf((bands instanceof Map ? bands.get(station) : bands[station]) ?? loadBand ?? task.learningLoadBand);
    const baseline = baselineTiming(task);
    const group = model.groups?.[kitchenLearningKey(task, currentBand)];
    let reason = !active ? 'Kitchen timing learning is disabled' : 'Not enough compatible recorded preparation samples';
    const count = finite(group?.sampleCount, 0);
    let applied = active && count >= minimum && finite(group?.percentileMinutes) != null;
    if (TERMINAL.has(task.taskState || task.task_state)) { applied = false; reason = 'Finished food keeps its recorded kitchen state'; }
    if (group && (timestamp(group.latestSampleAt) == null || current - timestamp(group.latestSampleAt) > 30 * 24 * 60 * MINUTE)) {
      applied = false; reason = 'Compatible recorded preparation samples have expired';
    }
    const weight = count >= 20 ? 0.75 : count >= 10 ? 0.65 : 0.5;
    const estimateMinutes = applied ? Math.min(baseline.maximum, Math.ceil(clamp(baseline.baseline * (1 - weight) + group.percentileMinutes * weight, baseline.minimum, baseline.maximum))) : baseline.baseline;
    const confidence = !applied ? 'none' : currentBand === 'unknown' ? 'low' : count >= 20 ? 'high' : count >= 10 ? 'medium' : 'low';
    if (applied) { learnedTasks += 1; reason = currentBand === 'unknown'
      ? 'Calibrated from recorded preparing-to-ready times with unknown historical kitchen load'
      : `Calibrated from compatible recorded preparing-to-ready times during ${currentBand} service`; }
    return { ...task, learning: { applied, sampleCount: count, loadBand: currentBand, estimateMinutes,
      baselineMinutes: baseline.baseline, confidence, reason, singleWave: true } };
  });
  return { recommendations: tasks, summary: { ...model.summary, enabled: active, learnedTasks,
    trackedDishes: model.summary?.trackedDishes || 0, qualifyingSamples: model.summary?.qualifyingSamples || 0 } };
}

module.exports = { learnKitchenPatterns, applyKitchenLearning, classifyLearningLoad, calculateLoadBands, kitchenLearningKey };
