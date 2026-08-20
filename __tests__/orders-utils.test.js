const { counterMoney, counterPortionOptions } = require('../test-helpers/orders-utils');

describe('orders utils', () => {
  test('counterMoney formats rupee amounts', () => {
    expect(counterMoney('120.3')).toBe('₹120');
    expect(counterMoney(undefined)).toBe('₹0');
    expect(counterMoney('0')).toBe('₹0');
  });

  test('counterPortionOptions filters invalid prices', () => {
    const item = { price: 200, halfPrice: 0, fullPrice: 0, bonelessPrice: 150 };
    const options = counterPortionOptions(item);
    // should include 'Regular' and 'Boneless' only
    expect(options.some(([, label]) => label === 'Regular')).toBe(true);
    expect(options.some(([, label]) => label === 'Boneless')).toBe(true);
    expect(options.length).toBeGreaterThanOrEqual(1);
  });
});
