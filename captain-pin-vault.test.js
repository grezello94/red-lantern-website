const { encryptCaptainPin, decryptCaptainPin } = require('./captain-pin-vault');

test('encrypts a Captain PIN for admin viewing and binds it to the Captain account', () => {
  const encrypted = encryptCaptainPin('482916', 'cap_lalit', 'stable-admin-secret');
  expect(encrypted).not.toContain('482916');
  expect(decryptCaptainPin(encrypted, 'cap_lalit', 'stable-admin-secret')).toBe('482916');
  expect(() => decryptCaptainPin(encrypted, 'cap_other', 'stable-admin-secret')).toThrow();
  expect(() => decryptCaptainPin(encrypted, 'cap_lalit', 'wrong-secret')).toThrow();
});
