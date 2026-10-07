(function exposePrinterDomain(root, factory) {
  const domain = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = domain;
  if (root) root.RedLanternPrinterDomain = domain;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createPrinterDomain() {
  const CAPABILITIES = Object.freeze(['bill', 'kot']);
  const CAPABILITY_LABELS = Object.freeze({ bill: 'Bill', kot: 'KOT' });

  function normalizeCapability(value) {
    const capability = String(value || '')
      .trim()
      .toLowerCase();
    return CAPABILITIES.includes(capability) ? capability : '';
  }

  function printerCapabilities(printer) {
    if (!printer || typeof printer !== 'object') return [];
    if (Array.isArray(printer.capabilities))
      return [...new Set(printer.capabilities.map(normalizeCapability).filter(Boolean))];
    const legacy = normalizeCapability(printer.type);
    return legacy ? [legacy] : [];
  }

  function printerSupports(printer, capability) {
    const normalized = normalizeCapability(capability);
    return !!normalized && printerCapabilities(printer).includes(normalized);
  }

  function setPrinterCapability(printer, capability, enabled) {
    const normalized = normalizeCapability(capability);
    if (!printer || typeof printer !== 'object' || !normalized) return printer;
    const capabilities = new Set(printerCapabilities(printer));
    if (enabled) capabilities.add(normalized);
    else capabilities.delete(normalized);
    printer.capabilities = [...capabilities];
    // Retain a legacy primary type for older deployed clients during rolling
    // upgrades. Capability-aware code never relies on this field.
    if (!printer.capabilities.includes(printer.type))
      printer.type = printer.capabilities[0] || 'kot';
    return printer;
  }

  function printerFormat(printer, capability) {
    if (!printer || typeof printer !== 'object') return {};
    const normalized = normalizeCapability(capability);
    const saved =
      normalized && printer.formats && typeof printer.formats === 'object'
        ? printer.formats[normalized]
        : null;
    return saved && typeof saved === 'object' && !Array.isArray(saved)
      ? { ...printer, ...saved }
      : { ...printer };
  }

  function setPrinterFormat(printer, capability, settings) {
    const normalized = normalizeCapability(capability);
    if (!printer || typeof printer !== 'object' || !normalized) return printer;
    const current =
      printer.formats && typeof printer.formats === 'object' && !Array.isArray(printer.formats)
        ? printer.formats
        : {};
    const next =
      settings && typeof settings === 'object' && !Array.isArray(settings) ? settings : {};
    printer.formats = { ...current, [normalized]: { ...(current[normalized] || {}), ...next } };
    return printer;
  }

  function printerBelongsToWorkstation(printer, workstationId) {
    const expected = String(workstationId || '').trim();
    if (!expected) return true;
    const assigned = String(printer?.workstationId || '').trim();
    // Legacy printers remain usable during the one-time automatic migration.
    return !assigned || assigned === expected;
  }

  function configuredPrintersFor(config, capability, workstationId = '') {
    return [
      ...new Map(
        (Array.isArray(config?.printers) ? config.printers : [])
          .filter(
            (printer) =>
              printerSupports(printer, capability) &&
              String(printer.deviceName || '').trim() &&
              printerBelongsToWorkstation(printer, workstationId)
          )
          .map((printer) => [String(printer.deviceName).trim(), printer])
      ).values(),
    ];
  }

  function capabilityLabel(capability) {
    return CAPABILITY_LABELS[normalizeCapability(capability)] || String(capability || 'Printer');
  }

  function resolveSystemPrinter(requestedName, printers) {
    const requested = String(requestedName || '').trim();
    const queues = Array.isArray(printers) ? printers : [];
    // Names are case-insensitive on Windows. Do not strip punctuation or infer
    // a printer's role: two different physical queues can have similar names.
    const exact = queues.find((printer) => String(printer.name || '').trim() === requested);
    if (exact) return exact;
    const caseMatches = queues.filter(
      (printer) =>
        String(printer.name || '')
          .trim()
          .toLowerCase() === requested.toLowerCase()
    );
    if (caseMatches.length === 1) return caseMatches[0];
    // Older configurations sometimes stored a TCP/IP address or port name.
    // Adopt it only when the OS exposes exactly one queue for that endpoint.
    const aliasMatches = queues.filter((printer) =>
      [printer.host, printer.portName]
        .filter(Boolean)
        .some((alias) => String(alias).trim().toLowerCase() === requested.toLowerCase())
    );
    return aliasMatches.length === 1 ? aliasMatches[0] : null;
  }

  return {
    CAPABILITIES,
    capabilityLabel,
    configuredPrintersFor,
    printerFormat,
    printerBelongsToWorkstation,
    printerCapabilities,
    printerSupports,
    resolveSystemPrinter,
    setPrinterCapability,
    setPrinterFormat,
  };
});
