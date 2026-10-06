(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.RedLanternOrderWindows = api;
})(typeof window === 'undefined' ? null : window, function () {
  const validTime = (value) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value || ''));

  function normalize(enabled, start, end) {
    if (!enabled)
      return {
        enabled: false,
        start: validTime(start) ? start : '10:00',
        end: validTime(end) ? end : '22:00',
      };
    if (!validTime(start) || !validTime(end) || start === end)
      throw new Error('Choose different valid start and end times for each enabled order window.');
    return { enabled: true, start, end };
  }

  function minutesInKolkata(now = new Date()) {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Kolkata',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      })
        .formatToParts(now)
        .filter((part) => part.type !== 'literal')
        .map((part) => [part.type, part.value])
    );
    return Number(parts.hour) * 60 + Number(parts.minute);
  }

  function isOpen(window, now = new Date()) {
    if (!window?.enabled) return true;
    if (!validTime(window.start) || !validTime(window.end) || window.start === window.end)
      return false;
    const start = Number(window.start.slice(0, 2)) * 60 + Number(window.start.slice(3));
    const end = Number(window.end.slice(0, 2)) * 60 + Number(window.end.slice(3));
    const current = minutesInKolkata(now);
    return start < end
      ? current >= start && current < end
      : current >= start || current < end;
  }

  function state(menu, now = new Date()) {
    return {
      cardOpen: isOpen(menu?.cardOrderWindow, now),
      deliveryOpen: isOpen(menu?.deliveryOrderWindow, now),
    };
  }

  return { normalize, isOpen, state };
});
