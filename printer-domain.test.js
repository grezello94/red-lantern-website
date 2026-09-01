const {
  configuredPrintersFor,
  printerCapabilities,
  printerSupports,
  setPrinterCapability,
} = require('./printer-domain');

describe('printer capability domain', () => {
  test('keeps legacy single-type configurations working', () => {
    expect(printerCapabilities({ type: 'bill' })).toEqual(['bill']);
    expect(printerSupports({ type: 'kot' }, 'kot')).toBe(true);
  });

  test('supports one queue serving Bill and KOT', () => {
    const printer = { type: 'kot', capabilities: ['bill', 'kot'] };
    expect(printerSupports(printer, 'bill')).toBe(true);
    expect(printerSupports(printer, 'kot')).toBe(true);
  });

  test('an explicit empty capability list remains unassigned', () => {
    expect(printerCapabilities({ type: 'kot', capabilities: [] })).toEqual([]);
  });

  test('capabilities can be enabled and disabled without removing another role', () => {
    const printer = { type: 'kot' };
    setPrinterCapability(printer, 'bill', true);
    expect(printerCapabilities(printer)).toEqual(['kot', 'bill']);
    setPrinterCapability(printer, 'kot', false);
    expect(printerCapabilities(printer)).toEqual(['bill']);
  });

  test('dispatch selects every capable queue once and preserves its settings', () => {
    const config = {
      printers: [
        { id: 'one', capabilities: ['bill'], deviceName: 'Queue A', paperWidth: 80 },
        { id: 'duplicate', capabilities: ['bill'], deviceName: 'Queue A', paperWidth: 58 },
        { id: 'dual', capabilities: ['bill', 'kot'], deviceName: 'Queue B', paperWidth: 58 },
        { id: 'kot', capabilities: ['kot'], deviceName: 'Queue C' },
      ],
    };
    const printers = configuredPrintersFor(config, 'bill');
    expect(printers.map((printer) => printer.deviceName)).toEqual(['Queue A', 'Queue B']);
    expect(printers.map((printer) => printer.paperWidth)).toEqual([58, 58]);
  });
});
