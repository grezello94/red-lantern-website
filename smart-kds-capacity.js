function asTime(value, fallback = Number.POSITIVE_INFINITY) {
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(time) ? time : fallback;
}

function compareWork(left, right) {
  const leftRank = Number(left.rank || Number.MAX_SAFE_INTEGER);
  const rightRank = Number(right.rank || Number.MAX_SAFE_INTEGER);
  if (leftRank !== rightRank) return leftRank - rightRank;
  const safeStart = asTime(left.latestSafeStartAt) - asTime(right.latestSafeStartAt);
  if (safeStart) return safeStart;
  const leftKey = String(left.workKey || '');
  const rightKey = String(right.workKey || '');
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

function capacityForStation(station = {}) {
  if (station.enabled === false) return 0;
  const capacity = Number(station.available_capacity ?? station.max_concurrent_tasks ?? 1);
  return Number.isFinite(capacity) ? Math.max(0, Math.min(50, Math.floor(capacity))) : 1;
}

function occupiedCapacityForStation(station = {}) {
  const occupied = Number(station.occupied_capacity ?? station.occupiedCapacity ?? 0);
  // Never hide work that is already on a station. A live count higher than the
  // configured limit is an important operational warning, not a value to clamp.
  return Number.isFinite(occupied) ? Math.max(0, Math.floor(occupied)) : 0;
}

function capacityCost(value) {
  const cost = Number(value);
  return Number.isFinite(cost) ? Math.max(1, Math.min(50, Math.floor(cost))) : 1;
}

function isCapacityEligibleTask(task = {}) {
  if (!task || task.action === 'monitor') return false;
  if (['hold-for-course', 'manual-hold', 'served'].includes(String(task.pacingState || ''))) return false;
  const state = String(task.taskState || 'ordered');
  return ['ordered', 'eligible', 'scheduled'].includes(state);
}

function toCapacityWork({ recommendations = [], batches = [] } = {}) {
  const batchedTaskKeys = new Set();
  const work = [];
  ;(Array.isArray(batches) ? batches : [])
    .forEach((batch) => {
      const allocations = Array.isArray(batch?.allocations) ? batch.allocations : [];
      allocations.forEach((allocation) => batchedTaskKeys.add(allocation.taskKey));
      if (!allocations.length) return;
      if (batch.action !== 'fire-batch') return;
      const rank = Math.min(...allocations.map((allocation) => Number(allocation.rank) || Number.MAX_SAFE_INTEGER));
      work.push({
        workKey: batch.batchKey,
        kind: 'batch',
        action: 'start-now',
        rank,
        stationId: batch.stationId,
        capacityCost: capacityCost(batch.parallelCapacityCost),
        latestSafeStartAt: batch.latestSafeStartAt,
        label: `${batch.batchGroupId} batch · ${batch.totalQuantity} portions`,
        allocations,
        reasons: [batch.reason, 'Compatible batch uses one station allocation'],
      });
    });
  recommendations
    .filter((task) => isCapacityEligibleTask(task) && !batchedTaskKeys.has(task.taskKey))
    .forEach((task) => {
      work.push({
        workKey: task.taskKey,
        kind: 'task',
        action: task.action,
        rank: task.rank,
        stationId: task.stationId,
        capacityCost: capacityCost(task.profile?.parallelCapacityCost),
        latestSafeStartAt: task.latestSafeStartAt,
        label: `${task.quantity}× ${task.itemName}`,
        task,
        reasons: task.reasons || [],
      });
    });
  return work.sort(compareWork);
}

function allocateStationCapacity({ stations = [], recommendations = [], batches = [] } = {}) {
  const states = new Map(
    stations.map((station) => [
      String(station.station_id || station.stationId || ''),
      (() => {
        const totalCapacity = capacityForStation(station);
        const occupiedCapacity = occupiedCapacityForStation(station);
        return {
        stationId: String(station.station_id || station.stationId || ''),
        stationName: String(station.station_name || station.stationName || station.station_id || ''),
        enabled: station.enabled !== false,
        capacityVersion: Math.max(0, Number.parseInt(station.capacity_version ?? station.capacityVersion, 10) || 0),
        totalCapacity,
        occupiedCapacity,
        usedCapacity: occupiedCapacity,
        overCapacity: Math.max(0, occupiedCapacity - totalCapacity),
        allocations: [],
        };
      })(),
    ])
  );
  const unassigned = [];
  const capacityWait = [];
  const allocated = [];
  toCapacityWork({ recommendations, batches }).forEach((work) => {
    const station = states.get(String(work.stationId || ''));
    if (!station) {
      unassigned.push({ ...work, capacityState: 'unassigned', capacityReason: 'No kitchen station assigned' });
      return;
    }
    if (!station.enabled || station.totalCapacity < 1) {
      const result = { ...work, capacityState: 'capacity-wait', capacityReason: 'Station is unavailable', stationCapacityVersion: station.capacityVersion };
      station.allocations.push(result);
      capacityWait.push(result);
      return;
    }
    if (work.capacityCost > station.totalCapacity) {
      const result = {
        ...work,
        capacityState: 'capacity-too-large',
        capacityReason: `Work needs ${work.capacityCost} capacity, but this station is configured for ${station.totalCapacity}`,
        stationCapacityVersion: station.capacityVersion,
      };
      station.allocations.push(result);
      capacityWait.push(result);
      return;
    }
    if (station.usedCapacity + work.capacityCost <= station.totalCapacity) {
      const result = { ...work, capacityState: 'allocated', capacityReason: 'Station capacity available', stationCapacityVersion: station.capacityVersion };
      station.usedCapacity += work.capacityCost;
      station.allocations.push(result);
      allocated.push(result);
      return;
    }
    const result = {
      ...work,
      capacityState: 'capacity-wait',
      capacityReason: station.enabled ? 'Station capacity is fully allocated to higher-priority work' : 'Station is unavailable',
      stationCapacityVersion: station.capacityVersion,
    };
    station.allocations.push(result);
    capacityWait.push(result);
  });
  const stationPlans = [...states.values()]
    .map((station) => ({ ...station, remainingCapacity: Math.max(0, station.totalCapacity - station.usedCapacity) }))
    .sort((left, right) => (left.stationName < right.stationName ? -1 : left.stationName > right.stationName ? 1 : 0));
  return {
    stationPlans,
    allocated,
    capacityWait,
    unassigned,
    overCapacity: stationPlans.reduce((total, station) => total + Number(station.overCapacity || 0), 0),
    overCapacityStations: stationPlans.filter((station) => Number(station.overCapacity || 0) > 0).length,
  };
}

module.exports = { allocateStationCapacity, capacityForStation, occupiedCapacityForStation, toCapacityWork };
