const OrderWindows = require('./order-windows');

const at = (time) => new Date(`2026-10-06T${time}:00+05:30`);

test('Business Card and Delivery windows are independent and end times are exclusive', () => {
  const menu = {
    cardOrderWindow: OrderWindows.normalize(true, '10:00', '22:00'),
    deliveryOrderWindow: OrderWindows.normalize(true, '10:00', '21:00'),
  };
  expect(OrderWindows.state(menu, at('20:59'))).toEqual({ cardOpen: true, deliveryOpen: true });
  expect(OrderWindows.state(menu, at('21:00'))).toEqual({ cardOpen: true, deliveryOpen: false });
  expect(OrderWindows.state(menu, at('22:00'))).toEqual({ cardOpen: false, deliveryOpen: false });
});

test('disabled windows stay open and an overnight window crosses midnight', () => {
  expect(OrderWindows.isOpen({ enabled: false }, at('03:00'))).toBe(true);
  const overnight = OrderWindows.normalize(true, '18:30', '00:30');
  expect(OrderWindows.isOpen(overnight, at('23:59'))).toBe(true);
  expect(OrderWindows.isOpen(overnight, at('00:15'))).toBe(true);
  expect(OrderWindows.isOpen(overnight, at('00:30'))).toBe(false);
  expect(() => OrderWindows.normalize(true, '21:00', '21:00')).toThrow();
});
