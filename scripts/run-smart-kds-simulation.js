const { simulateKitchen, createRushScenario } = require('../smart-kds-simulation');

const scenario = createRushScenario({ tables: 20, parcels: 5, itemsPerOrder: 4 });
const result = simulateKitchen({ ...scenario, durationMinutes: 180 });
console.log(JSON.stringify({ scenario: { tables: 20, parcels: 5, tasks: scenario.tasks.length }, summary: result.summary, validation: { targetMisses: result.validation.targetMisses.length, starved: result.validation.starved.length, capacityBreaches: result.validation.capacityBreaches.length, courseSequenceViolations: result.validation.courseSequenceViolations.length, synchronizationViolations: result.validation.synchronizationViolations.length, duplicateStarts: result.validation.duplicateStarts.length }, firstEvents: result.events.slice(0, 10) }, null, 2));
