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
      return [
        ...new Set(printer.capabilities.map(normalizeCapability).filter(Boolean)),
      ];
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

  function configuredPrintersFor(config, capability) {
    return [
      ...new Map(
        (Array.isArray(config?.printers) ? config.printers : [])
          .filter(
            (printer) =>
              printerSupports(printer, capability) && String(printer.deviceName || '').trim()
          )
          .map((printer) => [String(printer.deviceName).trim(), printer])
      ).values(),
    ];
  }

  function capabilityLabel(capability) {
    return CAPABILITY_LABELS[normalizeCapability(capability)] || String(capability || 'Printer');
  }

  return {
    CAPABILITIES,
    capabilityLabel,
    configuredPrintersFor,
    printerCapabilities,
    printerSupports,
    setPrinterCapability,
  };
});
