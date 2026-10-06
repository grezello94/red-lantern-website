const crypto = require('crypto');

function keyFromSecret(secret) {
  if (!secret) throw new Error('Captain PIN viewing requires an encryption secret.');
  return crypto.createHash('sha256').update('red-lantern-captain-pin-v1\0').update(secret).digest();
}

function encryptCaptainPin(pin, captainId, secret) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyFromSecret(secret), iv);
  cipher.setAAD(Buffer.from(String(captainId)));
  const ciphertext = Buffer.concat([cipher.update(String(pin), 'utf8'), cipher.final()]);
  return [
    'v1',
    iv.toString('base64url'),
    ciphertext.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
  ].join('.');
}

function decryptCaptainPin(value, captainId, secret) {
  const [version, iv, ciphertext, tag, extra] = String(value || '').split('.');
  if (version !== 'v1' || !iv || !ciphertext || !tag || extra)
    throw new Error('Captain PIN cannot be viewed. Set a new PIN.');
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    keyFromSecret(secret),
    Buffer.from(iv, 'base64url')
  );
  decipher.setAAD(Buffer.from(String(captainId)));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  const pin = Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
  if (!/^\d{4,6}$/.test(pin)) throw new Error('Captain PIN cannot be viewed. Set a new PIN.');
  return pin;
}

module.exports = { encryptCaptainPin, decryptCaptainPin };
