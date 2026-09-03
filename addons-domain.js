(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RedLanternAddons = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const text = (value, limit = 120) =>
    String(value || '')
      .trim()
      .slice(0, limit);
  const token = (value) =>
    text(value, 160)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '');
  const money = (value) => Math.max(0, Math.min(100000, Number(value) || 0));
  const safeId = (value, prefix) => {
    const clean = text(value, 80).replace(/[^a-zA-Z0-9_-]/g, '');
    return (
      clean || `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`
    );
  };

  function itemKey(menuType, category, name) {
    return `${token(menuType || 'food')}::${token(category || 'menu')}::${token(name)}`;
  }

  function normalizeOption(option = {}, fallbackId = '') {
    return {
      id: safeId(option.id || fallbackId, 'option'),
      name: text(option.name, 80),
      price: money(option.price),
      dietary: option.dietary === 'nonveg' ? 'nonveg' : 'veg',
      active: option.active !== false,
    };
  }

  function normalizeGroup(group = {}, fallbackId = '') {
    const selection = group.selection === 'multiple' ? 'multiple' : 'single';
    const max =
      selection === 'single' ? 1 : Math.max(1, Math.min(20, Math.floor(Number(group.max) || 1)));
    const min = Math.min(max, Math.max(0, Math.min(20, Math.floor(Number(group.min) || 0))));
    const id = safeId(group.id || fallbackId, 'addon');
    return {
      id,
      name: text(group.name, 80),
      displayName: text(group.displayName, 100),
      selection,
      min,
      max,
      active: group.active !== false,
      assignedItemKeys: [
        ...new Set(
          (Array.isArray(group.assignedItemKeys) ? group.assignedItemKeys : [])
            .map((key) => text(key, 260))
            .filter(Boolean)
        ),
      ],
      options: (Array.isArray(group.options) ? group.options : [])
        .slice(0, 50)
        .map((option, index) =>
          normalizeOption(
            option,
            `option-${token(id)}-${index + 1}-${token(option?.name) || 'choice'}`
          )
        )
        .filter((option) => option.name),
    };
  }

  function normalizeGroups(groups = []) {
    return (Array.isArray(groups) ? groups : [])
      .slice(0, 100)
      .map((group, index) =>
        normalizeGroup(group, `addon-${index + 1}-${token(group?.name) || 'group'}`)
      )
      .filter((group) => group.name);
  }

  function groupsForItem(groups, menuType, category, name, includeInactive = false) {
    const key = itemKey(menuType, category, name);
    return normalizeGroups(groups).filter(
      (group) =>
        group.assignedItemKeys.includes(key) &&
        (includeInactive || (group.active && group.options.some((option) => option.active)))
    );
  }

  function selectionFingerprint(modifiers = []) {
    return (Array.isArray(modifiers) ? modifiers : [])
      .flatMap((group) =>
        (group.options || []).map(
          (option) => `${group.groupId}:${option.optionId}:${Number(option.quantity || 1)}`
        )
      )
      .sort()
      .join('|');
  }

  function validateSelections(groups, submitted = []) {
    const availableGroups = normalizeGroups(groups).filter((group) => group.active);
    const submittedByGroup = new Map(
      (Array.isArray(submitted) ? submitted : []).map((entry) => [
        String(entry.groupId || ''),
        entry,
      ])
    );
    const modifiers = [];
    let total = 0;
    for (const group of availableGroups) {
      const submittedGroup = submittedByGroup.get(group.id) || {};
      const rawOptions = Array.isArray(submittedGroup.options) ? submittedGroup.options : [];
      const optionQuantities = new Map();
      rawOptions.forEach((entry) => {
        const optionId = String(entry.optionId || '');
        const quantity = Math.max(1, Math.min(20, Math.floor(Number(entry.quantity) || 1)));
        if (optionId)
          optionQuantities.set(optionId, (optionQuantities.get(optionId) || 0) + quantity);
      });
      const selectableOptionIds = new Set(
        group.options.filter((option) => option.active).map((option) => option.id)
      );
      if ([...optionQuantities.keys()].some((optionId) => !selectableOptionIds.has(optionId)))
        return {
          ok: false,
          error: `One or more choices from ${group.displayName || group.name} are no longer available.`,
        };
      const chosen = group.options
        .filter((option) => option.active && optionQuantities.has(option.id))
        .map((option) => ({
          optionId: option.id,
          name: option.name,
          price: option.price,
          quantity: group.selection === 'single' ? 1 : optionQuantities.get(option.id),
        }));
      const selectionCount = chosen.reduce((sum, option) => sum + option.quantity, 0);
      if (selectionCount < group.min)
        return {
          ok: false,
          error: `Choose at least ${group.min} option${group.min === 1 ? '' : 's'} from ${group.displayName || group.name}.`,
        };
      if (selectionCount > group.max)
        return {
          ok: false,
          error: `Choose no more than ${group.max} option${group.max === 1 ? '' : 's'} from ${group.displayName || group.name}.`,
        };
      if (group.selection === 'single' && chosen.length > 1)
        return {
          ok: false,
          error: `Choose only one option from ${group.displayName || group.name}.`,
        };
      if (chosen.length) {
        const groupTotal = chosen.reduce((sum, option) => sum + option.price * option.quantity, 0);
        total += groupTotal;
        modifiers.push({
          groupId: group.id,
          groupName: group.displayName || group.name,
          options: chosen,
          total: groupTotal,
        });
      }
    }
    const validGroupIds = new Set(availableGroups.map((group) => group.id));
    if ([...submittedByGroup.keys()].some((id) => id && !validGroupIds.has(id)))
      return { ok: false, error: 'One or more add-on choices are no longer available.' };
    return { ok: true, modifiers, total };
  }

  function lineModifierTotal(line = {}) {
    if (Number.isFinite(Number(line.modifierTotal))) return money(line.modifierTotal);
    return (Array.isArray(line.modifiers) ? line.modifiers : []).reduce(
      (sum, group) =>
        sum +
        (group.options || []).reduce(
          (optionSum, option) =>
            optionSum + money(option.price) * Math.max(1, Number(option.quantity) || 1),
          0
        ),
      0
    );
  }

  function modifierText(modifiers = []) {
    return (Array.isArray(modifiers) ? modifiers : [])
      .flatMap((group) =>
        (group.options || []).map(
          (option) =>
            `${Number(option.quantity || 1) > 1 ? `${Number(option.quantity)}× ` : ''}${option.name}`
        )
      )
      .join(', ');
  }

  return {
    itemKey,
    normalizeOption,
    normalizeGroup,
    normalizeGroups,
    groupsForItem,
    validateSelections,
    selectionFingerprint,
    lineModifierTotal,
    modifierText,
  };
});
