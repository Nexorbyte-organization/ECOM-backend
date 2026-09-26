import crypto from 'crypto';
import { getPaymobTestConfig } from './paymob.service.js';

const deriveEncryptionKey = (secretKey) => Buffer.from(crypto.hkdfSync(
  'sha256',
  Buffer.from(secretKey, 'utf8'),
  Buffer.from('OO-Ushers Paymob Test saved cards', 'utf8'),
  Buffer.from('AES-256-GCM key v1', 'utf8'),
  32,
));

const getLegacyEncryptionKey = () => {
  const raw = process.env.PAYMOB_TOKEN_ENCRYPTION_KEY?.trim();
  if (!raw) return null;

  const key = /^[a-f0-9]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    const error = new Error('PAYMOB_TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes');
    error.statusCode = 503;
    throw error;
  }
  return key;
};

const getEncryptionKey = () => deriveEncryptionKey(getPaymobTestConfig().secretKey);

export const assertCardTokenEncryptionConfigured = () => {
  getEncryptionKey();
};

export const encryptCardToken = (token) => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return {
    encryptedToken: encrypted.toString('base64'),
    tokenIv: iv.toString('base64'),
    tokenAuthTag: cipher.getAuthTag().toString('base64'),
  };
};

export const decryptCardToken = ({ encryptedToken, tokenIv, tokenAuthTag }) => {
  const decryptWithKey = (key) => {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(tokenIv, 'base64'));
    decipher.setAuthTag(Buffer.from(tokenAuthTag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(encryptedToken, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  };
  const currentKey = getEncryptionKey();
  try {
    return decryptWithKey(currentKey);
  } catch {
    // Cards created before this change may still use the optional standalone key.
  }
  const legacyKey = getLegacyEncryptionKey();
  if (legacyKey) {
    try {
      return decryptWithKey(legacyKey);
    } catch {
      // An old key can be removed after legacy cards have been replaced.
    }
  }
  const error = new Error('Saved card token cannot be read. Remove and add this card again.');
  error.statusCode = 409;
  throw error;
};
