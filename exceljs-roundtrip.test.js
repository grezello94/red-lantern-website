/** @jest-environment node */
const ExcelJS = require('exceljs');

test('Excel menu workbooks retain values, formatting and extended rule IDs through export and import', async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Food Menu');
  sheet.addRows([
    ['Category', 'Item', 'Price'],
    ['Soups', 'Tomato Soup', 125.5],
    ['Mains', 'Paneer Curry', 240],
  ]);
  sheet.getRow(1).font = { bold: true };
  sheet.getColumn(3).numFmt = '0.00';
  sheet.addConditionalFormatting({
    ref: 'C2:C3',
    rules: [{
      type: 'iconSet', iconSet: '3Triangles',
      cfvo: [{ type: 'percent', value: 0 }, { type: 'percent', value: 33 }, { type: 'percent', value: 67 }],
    }],
  });

  let restored = workbook;
  for (let round = 0; round < 2; round += 1) {
    const exported = await restored.xlsx.writeBuffer();
    restored = new ExcelJS.Workbook();
    await restored.xlsx.load(exported);
    const imported = restored.getWorksheet('Food Menu');
    expect(imported.getRow(2).values.slice(1)).toEqual(['Soups', 'Tomato Soup', 125.5]);
    expect(imported.getRow(3).values.slice(1)).toEqual(['Mains', 'Paneer Curry', 240]);
    expect(imported.getRow(1).font.bold).toBe(true);
    expect(imported.getCell('C2').numFmt).toBe('0.00');
    expect(imported.conditionalFormattings).toEqual([expect.objectContaining({
      ref: 'C2:C3', rules: [expect.objectContaining({
        type: 'iconSet', iconSet: '3Triangles',
        x14Id: expect.stringMatching(/^\{[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}\}$/i),
      })],
    })]);
  }
});
