import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { decryptCredentials, encryptCredentials, parseCredentialsKey } from '../crypto';

const key = randomBytes(32);

describe('credential crypto', () => {
  it('round-trips plaintext through encrypt/decrypt', () => {
    const plaintext = 'gho_super-secret-token';
    const encrypted = encryptCredentials(key, plaintext);

    expect(decryptCredentials(key, encrypted)).toBe(plaintext);
  });

  it('produces a different IV (and ciphertext) on every call', () => {
    const a = encryptCredentials(key, 'same-plaintext');
    const b = encryptCredentials(key, 'same-plaintext');

    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it('fails to decrypt a tampered ciphertext', () => {
    const encrypted = encryptCredentials(key, 'secret');
    const tampered = {
      ...encrypted,
      ciphertext: Buffer.from(encrypted.ciphertext, 'base64').fill(0).toString('base64'),
    };

    expect(() => decryptCredentials(key, tampered)).toThrow();
  });

  it('fails to decrypt with the wrong key', () => {
    const encrypted = encryptCredentials(key, 'secret');
    const wrongKey = randomBytes(32);

    expect(() => decryptCredentials(wrongKey, encrypted)).toThrow();
  });

  it('parses a valid base64-encoded 32-byte key', () => {
    const parsed = parseCredentialsKey(key.toString('base64'));
    expect(parsed).toHaveLength(32);
    expect(parsed.equals(key)).toBe(true);
  });

  it('rejects a key that does not decode to 32 bytes', () => {
    expect(() => parseCredentialsKey(Buffer.from('too-short').toString('base64'))).toThrow(
      /32 bytes/,
    );
  });
});
