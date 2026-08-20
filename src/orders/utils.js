/**
 * @typedef {Object} MenuItemLike
 * @property {number} [price]
 * @property {number} [halfPrice]
 * @property {number} [fullPrice]
 * @property {number} [withBonePrice]
 * @property {number} [bonelessPrice]
 * @property {number} [price30ml]
 * @property {number} [price60ml]
 * @property {number} [price90ml]
 * @property {number} [price180ml]
 */

/**
 * Escape HTML-sensitive characters for safe DOM output.
 * @param {unknown} value
 * @returns {string}
 */
function esc(value) {
  /** @type {Record<string, string>} */
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return String(value ?? '').replace(/[&<>"']/g, (character) => /** @type {Record<string, string>} */ (map)[character] ?? character);
}

/**
 * Format a value as INR with no decimals.
 * @param {number|string|undefined} [value]
 * @returns {string}
 */
function counterMoney(value = 0) {
  return `₹${Math.round(Number(value) || 0)}`;
}

/**
 * Return valid portion options for a menu item.
 * @param {MenuItemLike} item
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

module.exports = { esc, counterMoney, counterPortionOptions };
