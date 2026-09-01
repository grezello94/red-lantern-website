const {
  configuredPrintersFor,
  printerFormat,
  printerCapabilities,
  printerSupports,
  setPrinterCapability,
  setPrinterFormat,
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

  test('Bill and KOT formats remain independent on a dual-purpose queue', () => {
    const printer = { id: 'dual', capabilities: ['bill', 'kot'], paperWidth: 80 };
    setPrinterFormat(printer, 'bill', { fontFamily: 'Arial', separatorGap: 5 });
    setPrinterFormat(printer, 'kot', { fontFamily: 'Consolas', separatorGap: 2 });
    expect(printerFormat(printer, 'bill')).toMatchObject({
      fontFamily: 'Arial',
      separatorGap: 5,
    });
    expect(printerFormat(printer, 'kot')).toMatchObject({
      fontFamily: 'Consolas',
      separatorGap: 2,
    });
    expect(printer.paperWidth).toBe(80);
  });

  test('legacy top-level format settings remain the fallback during migration', () => {
    expect(printerFormat({ type: 'kot', fontFamily: 'Tahoma' }, 'kot').fontFamily).toBe(
      'Tahoma'
    );
  });
});
