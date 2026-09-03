const Addons = require('./addons-domain');

const groups = [
  {
    id: 'extras',
    name: 'Extras',
    displayName: 'Choose extras',
    selection: 'multiple',
    min: 1,
    max: 2,
    assignedItemKeys: [Addons.itemKey('food', 'Pizza', 'Margherita')],
    options: [
      { id: 'cheese', name: 'Cheese', price: 50 },
      { id: 'olive', name: 'Olives', price: 30 },
    ],
  },
];

test('finds assigned add-on groups by stable menu item key', () => {
  expect(Addons.groupsForItem(groups, 'food', 'Pizza', 'Margherita')).toHaveLength(1);
  expect(Addons.groupsForItem(groups, 'food', 'Pizza', 'Pepperoni')).toHaveLength(0);
});

test('validates min/max and calculates authoritative add-on price', () => {
  expect(Addons.validateSelections(groups, []).ok).toBe(false);
  const result = Addons.validateSelections(groups, [
    { groupId: 'extras', options: [{ optionId: 'cheese' }, { optionId: 'olive' }] },
  ]);
  expect(result).toMatchObject({ ok: true, total: 80 });
  expect(result.modifiers[0].options[0]).toMatchObject({
    optionId: 'cheese',
    name: 'Cheese',
    price: 50,
  });
});

test('rejects stale or forged option IDs', () => {
  expect(
    Addons.validateSelections(groups, [{ groupId: 'fake', options: [{ optionId: 'free' }] }]).ok
  ).toBe(false);
  expect(
    Addons.validateSelections(groups, [{ groupId: 'extras', options: [{ optionId: 'free' }] }]).ok
  ).toBe(false);
});

test('rejects sold-out choices and does not expose a group with no active choices', () => {
  const soldOut = [
    {
      ...groups[0],
      options: [{ id: 'cheese', name: 'Cheese', price: 50, active: false }],
    },
  ];
  expect(
    Addons.validateSelections(soldOut, [{ groupId: 'extras', options: [{ optionId: 'cheese' }] }])
  ).toMatchObject({ ok: false });
  expect(Addons.groupsForItem(soldOut, 'food', 'Pizza', 'Margherita')).toEqual([]);
});

test('counts multiple-choice quantities against the maximum', () => {
  expect(
    Addons.validateSelections(groups, [
      { groupId: 'extras', options: [{ optionId: 'cheese', quantity: 3 }] },
    ])
  ).toMatchObject({ ok: false });
});

test('reads saved modifier snapshots for historical totals and labels', () => {
  const snapshot = {
    modifierTotal: 80,
    modifiers: [
      {
        groupId: 'extras',
        groupName: 'Choose extras',
        options: [
          { optionId: 'cheese', name: 'Cheese', price: 50, quantity: 1 },
          { optionId: 'olive', name: 'Olives', price: 30, quantity: 1 },
        ],
      },
    ],
  };
  expect(Addons.lineModifierTotal(snapshot)).toBe(80);
  expect(Addons.modifierText(snapshot.modifiers)).toBe('Cheese, Olives');
});

test('gives legacy options deterministic IDs across repeated reads', () => {
  const legacy = [
    {
      name: 'Sauces',
      options: [
        { name: 'Mint', price: 10 },
        { name: 'Mint', price: 20 },
      ],
    },
  ];
  const first = Addons.normalizeGroups(legacy)[0];
  const second = Addons.normalizeGroups(legacy)[0];
  expect(first.id).toBe(second.id);
  expect(first.options[0].id).toBe(second.options[0].id);
  expect(first.options[0].id).not.toBe(first.options[1].id);
});
