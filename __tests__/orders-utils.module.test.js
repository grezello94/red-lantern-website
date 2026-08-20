const { esc, counterMoney, counterPortionOptions } = require('../src/orders/utils');

describe('orders utils module', () => {
  test('esc escapes special characters', () => {
    expect(esc('<&"\'')).toBe('&lt;&amp;&quot;&#39;');
    expect(esc(null)).toBe('');
  });

  test('counterMoney formats rupee amounts', () => {
    expect(counterMoney('120.3')).toBe('₹120');
    expect(counterMoney()).toBe('₹0');
  });

  test('counterPortionOptions filters invalid prices', () => {
    const item = { price: 200, halfPrice: 0, bonelessPrice: 150 };
    const options = counterPortionOptions(item);
    expect(options.some(([, label]) => label === 'Regular')).toBe(true);
    expect(options.some(([, label]) => label === 'Boneless')).toBe(true);
  });
});
