import crypto from 'node:crypto';
import { config } from './config.js';
import { badRequest } from './errors.js';

// Encryption for secrets kept in the database (e.g. SMTP passwords): AES-256-GCM with a key derived from
// SETTINGS_ENCRYPTION_KEY (or SESSION_SECRET). Values are stored as "v1:<iv>:<tag>:<ciphertext>" in base64url.

function key() {
  const secret = config.encryptionSecret;
  if (!secret) throw badRequest('Saving passwords needs SETTINGS_ENCRYPTION_KEY (or SESSION_SECRET) set in the server environment');
  return crypto.createHash('sha256').update(`nexonweb-settings:${secret}`).digest();
}

export const canEncrypt = () => !!config.encryptionSecret;

export function encryptSecret(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), data.toString('base64url')].join(':');
}

/** Returns null when the value cannot be decrypted (e.g. the key changed), so callers can report it. */
export function decryptSecret(stored: string | null | undefined): string | null {
  if (!stored) return null;
  try {
    const [v, iv, tag, data] = stored.split(':');
    if (v !== 'v1') return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
