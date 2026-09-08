import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32;

export interface EncryptedCredentials {
  /** Encrypted bytes with the 16-byte GCM auth tag appended, base64-encoded. */
  ciphertext: string;
  iv: string;
}

/** `key` must be exactly 32 bytes — the composition root reads it from env (options-in, never process.env here). */
export function encryptCredentials(key: Buffer, plaintext: string): EncryptedCredentials {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return {
    ciphertext: Buffer.concat([encrypted, authTag]).toString('base64'),
    iv: iv.toString('base64'),
  };
}

/** Throws (never returns garbage) if the ciphertext/IV was tampered with or the key is wrong — GCM's auth tag check. */
export function decryptCredentials(key: Buffer, encrypted: EncryptedCredentials): string {
  const combined = Buffer.from(encrypted.ciphertext, 'base64');
  const authTag = combined.subarray(combined.length - AUTH_TAG_LENGTH);
  const ciphertext = combined.subarray(0, combined.length - AUTH_TAG_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(encrypted.iv, 'base64'));
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

  return plaintext.toString('utf8');
}

/** Parses `INTEGRATION_CREDENTIALS_KEY` (base64) into the 32-byte key `encryptCredentials`/`decryptCredentials` expect. */
export function parseCredentialsKey(base64Key: string): Buffer {
  const key = Buffer.from(base64Key, 'base64');
  if (key.length !== KEY_LENGTH) {
    throw new Error(
      `INTEGRATION_CREDENTIALS_KEY must decode to exactly ${KEY_LENGTH} bytes, got ${key.length}`,
    );
  }
  return key;
}
