const fs = require('node:fs');
const path = require('node:path');
const {
  inferMenuProductionKnowledge,
  summarizeMenuProductionKnowledge,
  inferDefaultCourse,
  defaultMenuProductionProfile,
  normalizeMenuProductionProfile,
  defaultSmartKdsConfig,
} = require('./smart-kds-domain');

describe('menu-aware production knowledge', () => {
  test('covers the locally published Chinese, tandoor and Goan seafood menu', () => {
    const html = fs.readFileSync(path.join(__dirname, 'menu.html'), 'utf8');
    const items = [...html.matchAll(/<article class="menu-item-card\b[^"]*"[\s\S]*?<h3>([^<]+)<\/h3>/g)]
      .map((match) => ({ name: match[1], menuType: 'food' }));
    const coverage = summarizeMenuProductionKnowledge(items);
    expect(coverage.total).toBeGreaterThanOrEqual(15);
    expect(coverage.fallback).toBe(0);
    expect(coverage.seafoodPreparationAlerts).toBe(4);
    expect(coverage.byFamily).toMatchObject({ tandoor: 3, soup: 2, 'wok-main': 2 });
  });

  test.each([
    ['Ginger Chicken', 'Starters', 'starter'],
    ['Mushroom Chilli', 'Starters', 'starter'],
    ['Mushroom Fried Rice', 'Chinese Specialties', 'main'],
    ['Chilli Garlic Noodles', 'Starters', 'main'],
    ['Sweet Corn Chicken Soup', 'Soups & Starters', 'soup'],
    ['Chicken Lollipop', 'Soups & Starters', 'starter'],
    ['Sweet and Sour Chicken', 'Chinese Specialties', 'other'],
    ['Paneer Tikka Masala', 'Tandoor', 'main'],
    ['Masala French Fries', 'Quick Bites', 'starter'],
    ['Prawn Butter Garlic', 'Seafood Specialties', 'starter'],
    ['Beer Battered Fish', 'Goan Specialties', 'starter'],
    ['Water Chestnut Chilli', 'Chinese Specialties', 'starter'],
    ['Pomfret Rechado', 'Goan Specialties', 'starter'],
    ['Fresh Lime Soda', 'Beverages', 'drink'],
    ['Ginger Ale', 'Beverages', 'drink'],
    ['Rum Raisin Ice Cream', 'Desserts', 'dessert'],
  ])('assigns %s by dish tokens instead of matching parts of words or broad categories', (name, category, course) => {
    expect(inferDefaultCourse(category, name, 'food')).toBe(course);
  });

  test('separates inferred cooking time from course service promises and actual routing', () => {
    const config = defaultSmartKdsConfig();
    config.courseDefaults.main = { targetMin: 45, targetMax: 60 };
    const profile = defaultMenuProductionProfile({ name: 'Chicken Schezwan Fried Rice', category: 'Chinese Specialties', stationId: 'printer-kitchen-1' }, config);
    expect(profile).toMatchObject({ stationId: 'printer-kitchen-1', course: 'main', prepTimeEstimate: 10, maxPrepTime: 14, batchable: false });
    expect(profile.menuKnowledge).toMatchObject({ confidence: 'inferred', suggestedStation: 'wok' });
  });

  test.each(['Goan Fish Curry', 'Fish Fry', 'Golden Fried Prawns', 'Pomfret Rava Fry', 'Kingfish Tikka', 'Squid Butter Garlic'])('%s immediately prompts ingredient readiness without assuming a defrost duration', (name) => {
    const knowledge = inferMenuProductionKnowledge({ name, category: 'Seafood' });
    expect(knowledge).toMatchObject({ immediatePreparationAlert: true, canPrePrep: true, longPrepItem: true, preparationLeadMinutes: 15 });
    expect(knowledge.preparationAlert).toContain('If frozen');
    expect(knowledge.preparationAlert).toContain('flag any unavailable portions');
    expect(knowledge).not.toHaveProperty('thawMinutes');
  });

  test('uses recipe names ahead of generic family categories and avoids seafood alerts for veg', () => {
    expect(inferMenuProductionKnowledge({ name: 'Veg Crispy', category: 'Tandoor' }).family).toBe('fried-starter');
    expect(inferMenuProductionKnowledge({ name: 'Fish Fry', category: 'Rice and Noodles' }).family).toBe('seafood-fry');
    expect(inferMenuProductionKnowledge({ name: 'Paneer Tikka', category: 'Seafood' }).immediatePreparationAlert).toBe(false);
    expect(inferMenuProductionKnowledge({ name: 'Water Chestnut Chilli', category: 'Chinese Specialties' }).family).toBe('wok-starter');
    expect(inferMenuProductionKnowledge({ name: 'Fish Fry', category: 'Bar Menu', menuType: 'bar' }).course).toBe('drink');
  });

  test.each(['Beer Battered Fish', 'Fish Fingers', 'Pomfret Rechado', 'Pomfret Recheado', 'Bangdo Rava Fry', 'King Fish Rawa Fry', 'Squids Tempura'])('%s retains seafood staging and the fryer cooking window', (name) => {
    const knowledge = inferMenuProductionKnowledge({ name, category: 'Goan Specialties', menuType: 'food' });
    expect(knowledge).toMatchObject({ family: 'seafood-fry', suggestedStation: 'fryer', prepTimeEstimate: 18, maxPrepTime: 24, immediatePreparationAlert: true });
    expect(knowledge.course).not.toBe('drink');
  });

  test('recognizes spaced seafood categories but excludes named vegetarian recipes', () => {
    expect(inferMenuProductionKnowledge({ name: 'Catch of the Day', category: 'Sea Food' }).immediatePreparationAlert).toBe(true);
    expect(inferMenuProductionKnowledge({ name: 'Paneer Butter Garlic', category: 'Sea Food' }).immediatePreparationAlert).toBe(false);
  });

  test('preserves explicit chef timings, routing, capacity, holding and batch settings', () => {
    const saved = {
      course: 'main', stationId: 'fish-chef', prepTimeEstimate: 9, minPrepTime: 7, maxPrepTime: 11,
      longPrepItem: false, canPrePrep: false, canHoldAfterCooking: true, maxHoldTime: 2,
      parallelCapacityCost: 3, batchable: true, batchGroupId: 'approved-fish-fry', maxBatchSize: 2, optimalBatchSize: 2,
    };
    const profile = normalizeMenuProductionProfile(saved, { name: 'Fish Fry', category: 'Seafood' }, defaultSmartKdsConfig());
    expect(profile).toMatchObject(saved);
    expect(profile.immediatePreparationAlert).toBe(true);
  });

  test('does not permit inferred batch suggestions to execute without a saved chef profile', () => {
    const profile = normalizeMenuProductionProfile({}, { name: 'Chicken Fried Rice', category: 'Chinese' }, defaultSmartKdsConfig());
    expect(profile).toMatchObject({ batchable: false, batchGroupId: '', maxBatchSize: 1 });
    expect(profile.menuKnowledge.batchSuggestion).toMatchObject({ batchable: true, sameDishOnly: true, requiresChefConfirmation: true, maxBatchSize: 2 });
  });

  test('distinguishes long tandoor work, limited wok batches, fast breads and quality-sensitive fried items', () => {
    const chicken = inferMenuProductionKnowledge({ name: 'Tandoori Chicken Full' });
    const rice = inferMenuProductionKnowledge({ name: 'Veg Hakka Noodles' });
    const bread = inferMenuProductionKnowledge({ name: 'Garlic Naan' });
    const fry = inferMenuProductionKnowledge({ name: 'Chicken Crispy' });
    expect(chicken.parallelCapacityCost).toBe(2);
    expect(chicken.maxPrepTime).toBeGreaterThan(rice.maxPrepTime);
    expect(bread.maxPrepTime).toBeLessThan(rice.maxPrepTime);
    expect(rice.batchSuggestion.maxBatchSize).toBe(2);
    expect(fry.canHoldAfterCooking).toBe(false);
  });

  test('labels unfamiliar recipes as fallback and preserves generic service-based defaults', () => {
    const item = { name: 'Chef Surprise', category: 'Specials' };
    const profile = defaultMenuProductionProfile(item, defaultSmartKdsConfig());
    expect(profile).toMatchObject({ course: 'other', prepTimeEstimate: 20, maxPrepTime: 30, stationId: '', longPrepItem: false });
    expect(profile.menuKnowledge.confidence).toBe('fallback');
    expect(profile.menuKnowledge.batchSuggestion.batchable).toBe(false);
  });
});
