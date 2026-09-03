const { billText, kotText } = require('./print-bridge');

const modifiers = [
  {
    groupId: 'extras',
    groupName: 'Choose an extra',
    options: [{ optionId: 'cheese', name: 'Cheese', price: 50, quantity: 1 }],
  },
];

test('KOT output identifies duplicate copies and prints saved add-on choices', () => {
  const output = kotText({
    order: {
      kotNumber: 2,
      reprint: true,
      mode: 'table',
      tableArea: 'DINING',
      tableNumber: 3,
    },
    items: [{ name: 'Test Soup', portion: 'Regular', quantity: 1, modifiers }],
  });

  expect(output).toContain('DUPLICATE COPY');
  expect(output).toContain('__KOTITEM__1|Test Soup');
  expect(output).toContain('__KOTMODIFIER__+ Cheese');
});

test('bill output includes add-ons in the label and authoritative line amount', () => {
  const output = billText({
    order: {
      id: 'bill-addon-order',
      daily_order_number: 3,
      created_at: '2026-09-03T12:00:00.000Z',
      items: [
        {
          name: 'Test Soup',
          portion: 'Regular',
          quantity: 2,
          price: '₹110',
          modifierTotal: 50,
          modifiers,
        },
      ],
    },
  });

  expect(output).toContain('__ITEM__  + Cheese|||');
  expect(output).toContain('__ITEM__Test Soup (Regular)|2|160.00|320.00');
  expect(output).toContain('__TOTAL__GRAND TOTAL|₹320');
});
