import { describe, it, expect } from 'vitest';
import { CredentialCipher, hashPassword, verifyPassword, generateApiToken, hashToken } from '../security/crypto.js';

const KEY = 'a'.repeat(64);

describe('CredentialCipher (AES-256-GCM)', () => {
  it('round-trips and produces distinct IVs', () => {
    const c = new CredentialCipher(KEY);
    const a = c.encrypt('secret');
    const b = c.encrypt('secret');
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(c.decrypt(a)).toBe('secret');
    expect(Buffer.from(a.iv, 'base64').length).toBe(12);
    expect(Buffer.from(a.tag, 'base64').length).toBe(16);
  });
  it('detects tampering and wrong AAD', () => {
    const c = new CredentialCipher(KEY);
    const p = c.encryptJson({ token: 'x' }, 'row-1');
    expect(c.decryptJson(p, 'row-1')).toEqual({ token: 'x' });
    expect(() => c.decryptJson(p, 'row-2')).toThrow();
    const tampered = { ...p, ciphertext: Buffer.from('zzzz').toString('base64') };
    expect(() => c.decrypt(tampered, 'row-1')).toThrow();
  });
  it('rejects wrong key sizes', () => {
    expect(() => new CredentialCipher('abc')).toThrow();
    expect(() => new CredentialCipher('b'.repeat(64)).decrypt(new CredentialCipher(KEY).encrypt('x'))).toThrow();
  });
});

describe('passwords', () => {
  it('hashes with scrypt and verifies', async () => {
    const h = await hashPassword('correct horse battery');
    expect(h.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword('correct horse battery', h)).toBe(true);
    expect(await verifyPassword('wrong', h)).toBe(false);
    expect(await verifyPassword('x', null)).toBe(false);
    expect(await verifyPassword('x', 'garbage')).toBe(false);
  });
});

describe('api tokens', () => {
  it('generates dv_ tokens and stable hashes', () => {
    const t = generateApiToken();
    expect(t.token.startsWith('dv_')).toBe(true);
    expect(t.hash).toBe(hashToken(t.token));
    expect(t.hash).toHaveLength(64);
    expect(generateApiToken().token).not.toBe(t.token);
  });
});
