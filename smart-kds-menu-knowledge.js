// Menu-name estimates are a starting point for the expo, not measured recipes.
// Saved chef production profiles remain the authority for cooking and capacity.
const SEAFOOD = /\b(fish|sea\s*food|shellfish|prawns?|shrimps?|pomfrets?|king\s*fish|surmai|rawas|basa|salmon|sardines?|mackerel|bangda|bangdo|chonak|chonok|modso|lepo|snapper|tuna|squids?|calamari|crabs?|lobsters?|mussels?|oysters?|clams?|sea\s*bass|bombay\s*duck)\b/;
const DRINK = /\b(beverages?|drinks?|mocktails?|cocktails?|juices?|shakes?|lassi|tea|coffee|water|soda|beer|lager|wine|whisky|whiskey|rum|vodka|gin|brandy|tequila|liquor|spirits?)\b/;
const SOUP = /\b(soups?|broth|shorba)\b/;
const DESSERT = /\b(desserts?|ice\s*cream|brownie|pudding|gulab|kulfi|halwa|jalebi)\b/;
const BREAD = /\b(breads?|naan|roti|rotis|paratha|parotta|kulcha)\b/;
const COLD_SIDE = /\b(salads?|raita|papad)\b/;
const STARTER = /\b(starters?|appetizers?|lollipops?|wings?|fries|fry|fingers?|tikka|kebabs?|kababs?|65|chilli|chili|crispy|spring\s*rolls?|manchurian|pakora|cutlet|samosa|battered|breaded|tempura|reche?ado|rechad)\b/;
const MAIN = /\b(mains?|main\s*course|rice|noodles?|biryani|biriyani|sizzlers?|pasta|curry|curries|gravy|thali|dal|masala)\b/;

function words(value) {
  return String(value || '').toLowerCase().replace(/&amp;/g, '&').replace(/[-_]/g, ' ').replace(/\s+/g, ' ').trim();
}

function inferMenuCourse(name, category, menuType) {
  if (words(menuType) === 'bar') return 'drink';
  const foodIngredient = SEAFOOD.test(name) || /\b(chicken|mutton|lamb|beef|pork|duck|eggs?|paneer|mushrooms?|vegetables?|tofu|chestnuts?)\b/.test(name);
  const foodMethod = SOUP.test(name) || DESSERT.test(name) || BREAD.test(name) || COLD_SIDE.test(name)
    || /\b(rice|noodles?|biryani|biriyani|sizzlers?|pasta|curry|curries|gravy|thali|dal|tandoori|tikka|kebabs?|kababs?|fry|fried|crispy|battered|breaded|tempura)\b/.test(name);
  // Beer, soda and water can be recipe ingredients. A named food method or
  // protein takes precedence; ordinary Lime Soda and other drinks still match.
  const namedFood = foodIngredient || foodMethod;
  if (!namedFood && DRINK.test(name)) return 'drink';
  if (SOUP.test(name)) return 'soup';
  if (DESSERT.test(name)) return 'dessert';
  if (BREAD.test(name) || COLD_SIDE.test(name)) return 'side';
  // Dish names take precedence over broad categories such as Soups & Starters
  // or Chinese Specialties. "Chilli garlic noodles" is still a main course.
  if (/\b(rice|noodles?|biryani|biriyani|sizzlers?|pasta|curry|curries|gravy|thali|dal)\b/.test(name)) return 'main';
  if (/\bmasala\b/.test(name) && !/\b(fr(?:y|ies)|papad|peanuts?|chaat)\b/.test(name)) return 'main';
  if (SEAFOOD.test(name) && /\b(butter|garlic)\b/.test(name)) return 'starter';
  if (STARTER.test(name) || /\btandoori\b/.test(name)) return 'starter';
  if (MAIN.test(name)) return 'main';
  if (!namedFood && DRINK.test(category)) return 'drink';
  if (SOUP.test(category)) return 'soup';
  if (DESSERT.test(category) || /\bsweets?\b/.test(category)) return 'dessert';
  if (BREAD.test(category) || COLD_SIDE.test(category) || /\bsides?\b/.test(category)) return 'side';
  if (STARTER.test(category)) return 'starter';
  if (MAIN.test(category)) return 'main';
  return 'other';
}

function inferMenuProductionKnowledge(item = {}) {
  const name = words(item.name || item.itemName);
  const category = words(item.category);
  const course = inferMenuCourse(name, category, item.menuType);
  const seafood = SEAFOOD.test(name) || (SEAFOOD.test(category) && !/\b(veg|vegetable|paneer|mushroom|chicken|mutton|beef|pork|egg)\b/.test(name));
  const hasNamedMethod = /\b(rice|noodles?|pasta|biryani|biriyani|tandoori|tandoor|tikka|kebabs?|kababs?|curry|curries|gravy|masala|dal|lollipops?|wings?|crispy|spring\s*rolls?|fries|fry|fried|pakora|cutlet|samosa|fingers?|manchurian|chilli|chili|schezwan|szechuan|65|battered|breaded|tempura|reche?ado|rechad)\b/.test(name);
  const recipeWords = hasNamedMethod ? name : name + ' ' + category;
  let family = 'unclassified';
  let suggestedStation = 'kitchen';
  let times = [20, 15, 30];
  let batch = [1, 1];
  let canHoldAfterCooking = false;
  let maxHoldTime = 0;
  let parallelCapacityCost = 1;

  if (course === 'drink') {
    family = 'drink'; suggestedStation = 'bar'; times = [3, 1, 5]; batch = [4, 2];
  } else if (course === 'soup') {
    family = 'soup'; suggestedStation = 'wok'; times = [8, 6, 12]; batch = [4, 3];
    canHoldAfterCooking = true; maxHoldTime = 5;
  } else if (course === 'dessert') {
    family = 'dessert'; suggestedStation = 'cold'; times = /brownie|gulab/.test(name) ? [8, 5, 12] : [4, 2, 6]; batch = [4, 2];
  } else if (BREAD.test(name) || (course === 'side' && BREAD.test(category))) {
    family = 'bread'; suggestedStation = 'tandoor'; times = [6, 4, 9]; batch = [6, 4];
  } else if (COLD_SIDE.test(name) || (course === 'side' && COLD_SIDE.test(category))) {
    family = 'cold-side'; suggestedStation = 'cold'; times = [5, 3, 8]; batch = [4, 2];
  } else if (/\b(biryani|biriyani)\b/.test(recipeWords)) {
    family = 'biryani'; suggestedStation = 'curry'; times = [22, 18, 30]; batch = [4, 2];
  } else if (/\b(rice|noodles?|pasta)\b/.test(recipeWords)) {
    family = 'wok-main'; suggestedStation = 'wok'; times = [10, 7, 14]; batch = [2, 2];
  } else if (/\b(tandoori|tandoor|tikka|kebabs?|kababs?)\b/.test(recipeWords) && !/\b(curry|gravy|masala)\b/.test(name)) {
    family = 'tandoor'; suggestedStation = 'tandoor'; batch = [4, 2];
    const wholeBird = /\bchicken\b/.test(name) && !/\b(tikka|kebabs?|kababs?|wings?|boneless)\b/.test(name);
    times = wholeBird ? [25, 20, 35] : /\b(paneer|veg|vegetable|mushroom)\b/.test(name) ? [16, 12, 22] : [20, 15, 28];
    if (wholeBird || /\b(platter|sizzlers?)\b/.test(name)) parallelCapacityCost = 2;
  } else if (seafood) {
    if (/\b(curry|gravy|masala)\b/.test(name)) {
      family = 'seafood-curry'; suggestedStation = 'curry'; times = [20, 15, 28]; batch = [3, 2];
    } else if (/\b(fry|fried|crispy|rava|rawa|rechad|reche?ado|fingers?|battered|breaded|tempura)\b/.test(name)) {
      family = 'seafood-fry'; suggestedStation = 'fryer'; times = [18, 14, 24]; batch = [3, 2];
    } else {
      family = 'seafood-saute'; suggestedStation = 'wok'; times = [14, 10, 20]; batch = [2, 2];
    }
  } else if (/\b(curry|curries|gravy|masala|dal|mains?|main\s*course)\b/.test(recipeWords) && course === 'main') {
    family = 'curry'; suggestedStation = 'curry'; times = /\b(mutton|beef)\b/.test(name) ? [25, 20, 35] : [18, 14, 25]; batch = [3, 2];
  } else if (/\b(lollipops?|wings?)\b/.test(name)) {
    family = 'fried-chicken'; suggestedStation = 'fryer'; times = [18, 14, 24]; batch = [4, 2];
  } else if (/\b(crispy|spring\s*rolls?|fries|fry|fried|pakora|cutlet|samosa|fingers?)\b/.test(name)) {
    family = 'fried-starter'; suggestedStation = 'fryer'; times = [14, 10, 20]; batch = [4, 2];
  } else if (/\b(manchurian|chilli|chili|schezwan|szechuan|65)\b/.test(name)) {
    family = 'wok-starter'; suggestedStation = 'wok'; times = [14, 10, 20]; batch = [2, 2];
  } else if (course === 'starter') {
    family = 'starter'; suggestedStation = 'kitchen'; times = [15, 10, 22];
  } else if (course === 'main') {
    family = 'main'; suggestedStation = 'kitchen'; times = [20, 15, 30];
  } else if (course === 'side') {
    family = 'side'; suggestedStation = 'kitchen'; times = [8, 5, 12];
  }

  return {
    family,
    course,
    confidence: family === 'unclassified' || ['starter', 'main', 'side'].includes(family) ? 'fallback' : 'inferred',
    suggestedStation,
    prepTimeEstimate: times[0], minPrepTime: times[1], maxPrepTime: times[2],
    longPrepItem: seafood || (family !== 'unclassified' && times[2] >= 25),
    canPrePrep: seafood,
    canHoldAfterCooking,
    // This is a brief quality limit, never a storage-temperature prescription.
    maxHoldTime,
    parallelCapacityCost,
    // Ingredient readiness is separate from cooking; thaw duration cannot be
    // inferred from a dish name, portion, or order arrival time.
    preparationLeadMinutes: seafood ? 15 : 0,
    immediatePreparationAlert: seafood,
    preparationAlert: seafood
      ? 'Check seafood portions and chilled/thawed stock now. If frozen, start the kitchen-approved thawing process and flag any unavailable portions to expo.'
      : '',
    batchSuggestion: {
      batchable: batch[0] > 1,
      maxBatchSize: batch[0], optimalBatchSize: batch[1],
      batchWindowSeconds: ['soup', 'wok-main', 'biryani'].includes(family) ? 300 : 90,
      sameDishOnly: true, requiresChefConfirmation: true,
    },
  };
}

function summarizeMenuProductionKnowledge(items = []) {
  const summary = { total: 0, inferred: 0, fallback: 0, seafoodPreparationAlerts: 0, needsTimingVerification: 0, byFamily: {} };
  (Array.isArray(items) ? items : []).forEach((item) => {
    const knowledge = inferMenuProductionKnowledge(item);
    summary.total += 1;
    summary[knowledge.confidence] += 1;
    summary.seafoodPreparationAlerts += Number(knowledge.immediatePreparationAlert);
    summary.needsTimingVerification += 1;
    summary.byFamily[knowledge.family] = (summary.byFamily[knowledge.family] || 0) + 1;
  });
  return summary;
}

module.exports = { inferMenuProductionKnowledge, summarizeMenuProductionKnowledge };
