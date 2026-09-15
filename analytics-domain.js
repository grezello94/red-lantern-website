const ANALYTICS_PRESETS = new Set(['today', 'yesterday', 'month', 'year', 'custom']);

function isoDay(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function shiftDay(day, amount) {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function daysBetween(from, to) {
  return Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86400000);
}

function rangeLabel(preset, from, to) {
  if (preset === 'today') return 'Today';
  if (preset === 'yesterday') return 'Yesterday';
  if (preset === 'month') return 'This month';
  if (preset === 'year') return 'This year';
  const format = (day, options) =>
    new Intl.DateTimeFormat('en-IN', { timeZone: 'UTC', ...options }).format(
      new Date(`${day}T12:00:00Z`)
    );
  if (from === to) return format(from, { day: 'numeric', month: 'short', year: 'numeric' });
  return `${format(from, { day: 'numeric', month: 'short' })} – ${format(to, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })}`;
}

function resolveAnalyticsRange(query = {}, now = new Date()) {
  const preset = ANALYTICS_PRESETS.has(String(query.preset || '').toLowerCase())
    ? String(query.preset).toLowerCase()
    : 'today';
  const today = isoDay(now);
  let from = today;
  let to = today;

  if (preset === 'yesterday') from = to = shiftDay(today, -1);
  if (preset === 'month') from = `${today.slice(0, 7)}-01`;
  if (preset === 'year') from = `${today.slice(0, 4)}-01-01`;
  if (preset === 'custom') {
    from = String(query.from || '');
    to = String(query.to || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to))
      throw new Error('Choose both a valid start date and end date.');
    if (from > to) throw new Error('The start date cannot be after the end date.');
    if (daysBetween(from, to) > 1095)
      throw new Error('Choose a custom period of three years or less.');
  }

  const days = daysBetween(from, to) + 1;
  const previousTo = shiftDay(from, -1);
  const previousFrom = shiftDay(previousTo, -(days - 1));
  return {
    preset,
    label: rangeLabel(preset, from, to),
    from,
    to,
    days,
    startUtc: new Date(`${from}T00:00:00+05:30`).toISOString(),
    endUtc: new Date(`${shiftDay(to, 1)}T00:00:00+05:30`).toISOString(),
    previous: {
      from: previousFrom,
      to: previousTo,
      startUtc: new Date(`${previousFrom}T00:00:00+05:30`).toISOString(),
      endUtc: new Date(`${from}T00:00:00+05:30`).toISOString(),
    },
  };
}

function percentChange(current, previous) {
  const currentValue = Number(current || 0);
  const previousValue = Number(previous || 0);
  if (!previousValue) return currentValue ? null : 0;
  return Math.round(((currentValue - previousValue) / previousValue) * 1000) / 10;
}

module.exports = { resolveAnalyticsRange, percentChange, shiftDay };
