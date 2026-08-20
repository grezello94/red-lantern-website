// Small, test-only copies of pure helpers from `orders.js` to allow unit tests
/**
 * @param {number|string|undefined} [value]
 * @returns {string}
 */
function counterMoney(value = 0) {
  return `₹${Math.round(Number(value) || 0)}`;
}

/**
 * @param {{ price?: number, halfPrice?: number, fullPrice?: number, withBonePrice?: number, bonelessPrice?: number, price30ml?: number, price60ml?: number, price90ml?: number, price180ml?: number }} item
 * @returns {Array<[string, string, number]>}
 */
function counterPortionOptions(item) {
  /** @type {Array<[string, string, number]>} */
  const options = [
    ['', 'Regular', Number(item.price ?? 0)],
    ['Half', 'Half', Number(item.halfPrice ?? 0)],
    ['Full', 'Full', Number(item.fullPrice ?? 0)],
    ['With Bone', 'With Bone', Number(item.withBonePrice ?? 0)],
    ['Boneless', 'Boneless', Number(item.bonelessPrice ?? 0)],
    ['30 ml', '30 ml', Number(item.price30ml ?? 0)],
    ['60 ml', '60 ml', Number(item.price60ml ?? 0)],
    ['90 ml', '90 ml', Number(item.price90ml ?? 0)],
    ['180 ml', '180 ml', Number(item.price180ml ?? 0)]
  ];
  return options.filter(([, , price]) => Number(String(price || '').replace(/[^0-9.]/g, '')) > 0);
}

module.exports = { counterMoney, counterPortionOptions };
