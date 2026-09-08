const TrustedContacts = require('./trusted-contacts-domain');

describe('trusted contact imports', () => {
  test('keeps every unique valid contact beyond the former 1,000-row limit', () => {
    const rows = Array.from({ length: 2505 }, (_, index) => ({
      phone: String(7000000000 + index),
      name: index % 2 ? '' : `Customer ${index}`,
    }));

    const result = TrustedContacts.prepareTrustedContacts(rows);

    expect(result.contacts).toHaveLength(2505);
    expect(result.duplicateRows).toBe(0);
    expect(result.invalidRows).toBe(0);
  });

  test('allows each phone once and reports duplicate spreadsheet rows', () => {
    const result = TrustedContacts.prepareTrustedContacts([
      { phone: '98765 43210', name: '' },
      { phone: '+91 98765 43210', name: 'Different number because country code is present' },
      { phone: '9876543210', name: 'Asha' },
      { phone: '9876543210', name: 'Ignored duplicate name' },
    ]);

    expect(result.contacts).toEqual([
      { phone: '9876543210', name: 'Asha' },
      { phone: '919876543210', name: 'Different number because country code is present' },
    ]);
    expect(result.duplicateRows).toBe(2);
    expect(result.duplicatePhones).toEqual(['9876543210']);
  });

  test('skips blank and invalid values instead of creating damaged contacts', () => {
    const result = TrustedContacts.prepareTrustedContacts([
      { phone: '', name: 'No phone' },
      { phone: '123', name: 'Too short' },
      { phone: '9.876543210123456e+20', name: 'Unsafe Excel number' },
      { phone: '(987) 654-3210', name: 'Valid' },
    ]);

    expect(result.contacts).toEqual([{ phone: '9876543210', name: 'Valid' }]);
    expect(result.blankRows).toBe(1);
    expect(result.invalidRows).toBe(2);
  });

  test('reads text, formulas, and rich text from spreadsheet cells', () => {
    expect(TrustedContacts.cellText({ text: ' 9876543210 ' })).toBe('9876543210');
    expect(TrustedContacts.cellText({ value: { result: 9876543210 } })).toBe('9876543210');
    expect(
      TrustedContacts.cellText({ value: { richText: [{ text: '98765' }, { text: '43210' }] } })
    ).toBe('9876543210');
  });

  test('splits database writes into predictable batches', () => {
    expect(TrustedContacts.chunks([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });
});
