/**
 * Cryptographic primitives:
 *  - AES-256-GCM envelope for stored credentials (S3/GCS keys, MotherDuck tokens)
 *  - scrypt password hashing (Node built-in, memory-hard, no native deps)
 *  - API token generation + SHA-256 hashing (tokens are never stored in plaintext)
 */
import crypto from 'node:crypto';

export interface EncryptedPayload {
  ciphertext: string; // base64
  iv: string; // base64 (12 bytes)
  tag: string; // base64 (16 bytes)
}

export class CredentialCipher {
  private readonly key: Buffer;
  constructor(hexKey: string) {
    if (!/^[0-9a-fA-F]{64}$/.test(hexKey)) throw new Error('CredentialCipher requires a 32-byte hex key');
    this.key = Buffer.from(hexKey, 'hex');
  }

  encrypt(plaintext: string, aad?: string): EncryptedPayload {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    if (aad) cipher.setAAD(Buffer.from(aad, 'utf8'));
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return { ciphertext: ct.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
  }

  decrypt(payload: EncryptedPayload, aad?: string): string {
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, Buffer.from(payload.iv, 'base64'));
    if (aad) decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
    const pt = Buffer.concat([decipher.update(Buffer.from(payload.ciphertext, 'base64')), decipher.final()]);
    return pt.toString('utf8');
  }

  encryptJson(value: unknown, aad?: string): EncryptedPayload {
    return this.encrypt(JSON.stringify(value), aad);
  }

  decryptJson<T = unknown>(payload: EncryptedPayload, aad?: string): T {
    return JSON.parse(this.decrypt(payload, aad)) as T;
  }
}

// ---- Passwords (scrypt) ----
const SCRYPT_N = 1 << 15;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const hash = await new Promise<Buffer>((resolve, reject) =>
    crypto.scrypt(password, salt, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: 128 * SCRYPT_N * SCRYPT_R * 2 }, (err, key) => (err ? reject(err) : resolve(key))),
  );
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  if (!stored) return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const salt = Buffer.from(parts[4]!, 'base64');
  const expected = Buffer.from(parts[5]!, 'base64');
  const actual = await new Promise<Buffer>((resolve, reject) =>
    crypto.scrypt(password, salt, expected.length, { N, r, p, maxmem: 128 * N * r * 2 }, (err, key) => (err ? reject(err) : resolve(key))),
  );
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

// ---- API tokens ----
export const API_TOKEN_PREFIX = 'dv_';

export function generateApiToken(): { token: string; hash: string; prefix: string } {
  const token = API_TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token), prefix: token.slice(0, 10) };
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

export function newId(): string {
  return crypto.randomUUID();
}
