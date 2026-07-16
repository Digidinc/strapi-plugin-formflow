/* SPDX-License-Identifier: LicenseRef-FormFlow-EE — Commercial. See LICENSE-EE. Not covered by MIT. */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export interface EncryptedSecret {
  version: 1;
  nonce: string;
  authTag: string;
  ciphertext: string;
}

function decodeKey(encoded: string | undefined): Buffer {
  if (!encoded) throw new Error('FORMFLOW_ENCRYPTION_KEY is required to store Telegram credentials.');
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== 32 || key.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')) {
    throw new Error('FORMFLOW_ENCRYPTION_KEY must be exactly 32 bytes encoded as base64.');
  }
  return key;
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
    if (secret.version !== 1) throw new Error('unsupported version');
    const nonce = Buffer.from(secret.nonce, 'base64');
    const tag = Buffer.from(secret.authTag, 'base64');
    if (nonce.length !== 12 || tag.length !== 16) throw new Error('invalid envelope');
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
