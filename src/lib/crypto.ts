import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Plaid access-token encryption at rest.
 *
 * A Plaid access_token gives us 90 days of read-access to a customer's
 * bank. Treating it as a regular varchar column would mean a DB backup
 * leak = an Open Banking consent leak. We encrypt with AES-256-GCM
 * and store ciphertext + IV + auth tag in a single base64 envelope.
 *
 * The actual key lives in KMS (AWS KMS, GCP KMS, or HashiCorp Vault) —
 * here we read it from env for local dev. The keyId column on
 * PlaidItem lets us rotate keys: re-encrypt rows under the new key in
 * a background job, then retire the old key once `keyId` no longer
 * references it anywhere.
 *
 * GCM rather than CBC: authenticated encryption stops ciphertext
 * tampering, which matters because we never want a corrupted token
 * blob to silently decrypt to garbage and trigger a wave of Plaid 401s.
 */

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;        // 96-bit IV is the GCM-recommended size
const AUTH_TAG_LEN = 16;

export interface EncryptedToken {
  ciphertext: string;     // base64(iv || ciphertext || authTag)
  keyId: string;
}

function loadKey(): Buffer {
  const raw = process.env.ACCESS_TOKEN_AES_KEY;
  if (!raw) throw new Error('ACCESS_TOKEN_AES_KEY not set');
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error('ACCESS_TOKEN_AES_KEY must be 32 bytes (base64-encoded)');
  return key;
}

export function encryptAccessToken(plaintext: string): EncryptedToken {
  const key = loadKey();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: Buffer.concat([iv, enc, tag]).toString('base64'),
    keyId: process.env.ACCESS_TOKEN_KEY_ID ?? 'local-dev-key',
  };
}

export function decryptAccessToken(envelope: EncryptedToken): string {
  const key = loadKey();
  const blob = Buffer.from(envelope.ciphertext, 'base64');
  if (blob.length < IV_LEN + AUTH_TAG_LEN + 1) throw new Error('ciphertext too short');
  const iv = blob.subarray(0, IV_LEN);
  const tag = blob.subarray(blob.length - AUTH_TAG_LEN);
  const ct = blob.subarray(IV_LEN, blob.length - AUTH_TAG_LEN);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}
