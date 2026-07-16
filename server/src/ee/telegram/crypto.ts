/* SPDX-License-Identifier: LicenseRef-FormFlow-EE — Commercial. See LICENSE-EE. Not covered by MIT. */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export interface EncryptedSecret {
  version: 1;
  nonce: string;
  authTag: string;
  ciphertext: string;
}

const isCanonicalBase64 = (value: unknown, decodedLength?: number): value is string => {
  if (typeof value !== 'string') return false;
  const decoded = Buffer.from(value, 'base64');
  return decoded.toString('base64') === value && (decodedLength === undefined || decoded.length === decodedLength);
};

export function isEncryptedSecret(value: unknown): value is EncryptedSecret {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const secret = value as Record<string, unknown>;
  return secret.version === 1 && isCanonicalBase64(secret.nonce, 12) &&
    isCanonicalBase64(secret.authTag, 16) && isCanonicalBase64(secret.ciphertext);
}

function decodeKey(encoded: string | undefined): Buffer {
  if (!encoded) throw new Error('FORMFLOW_ENCRYPTION_KEY is required to store Telegram credentials.');
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== 32 || key.toString('base64') !== encoded) {
    throw new Error('FORMFLOW_ENCRYPTION_KEY must be exactly 32 bytes encoded as base64.');
  }
  return key;
}

export function assertEncryptionKey(encodedKey: string | undefined): void {
  decodeKey(encodedKey);
}

export function encryptSecret(value: string, encodedKey: string | undefined): EncryptedSecret {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', decodeKey(encodedKey), nonce);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return {
    version: 1,
    nonce: nonce.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

export function decryptSecret(secret: EncryptedSecret, encodedKey: string | undefined): string {
  try {
    if (!isEncryptedSecret(secret)) throw new Error('invalid envelope');
    const nonce = Buffer.from(secret.nonce, 'base64');
    const tag = Buffer.from(secret.authTag, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', decodeKey(encodedKey), nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(Buffer.from(secret.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new Error('The stored Telegram credential could not be authenticated. Replace the credential or restore the encryption key.');
  }
}
