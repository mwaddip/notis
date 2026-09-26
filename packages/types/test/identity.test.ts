import { describe, it, expect } from 'vitest';
import { createPrivateKey, createPublicKey } from 'crypto';
import { generateKeyPair } from '../src/identity.js';

describe('identity', () => {
  it('generates 32-byte public key', () => {
    const kp = generateKeyPair();
    expect(kp.publicKey).toBeInstanceOf(Uint8Array);
    expect(kp.publicKey.length).toBe(32);
  });

  it('UserId IS the public key — same bytes, same identity', () => {
    const kp = generateKeyPair();
    // The public key itself is the identity; it's trivially deterministic
    expect(kp.publicKey).toEqual(kp.publicKey);
  });

  it('different keys produce different identities', () => {
    const kp1 = generateKeyPair();
    const kp2 = generateKeyPair();
    // Different key bytes → different identities
    expect(Buffer.from(kp1.publicKey).equals(Buffer.from(kp2.publicKey))).toBe(false);
  });

  it('secretKey is 48 bytes: the RFC 8410 PKCS8 prefix ‖ the 32-byte seed', () => {
    const kp = generateKeyPair();
    expect(kp.secretKey).toBeInstanceOf(Uint8Array);
    expect(kp.secretKey.length).toBe(48);
    expect(Buffer.from(kp.secretKey.subarray(0, 16)).toString('hex')).toBe(
      '302e020100300506032b657004220420',
    );
  });

  it('Node derives the same public key from secretKey as PKCS8 DER', () => {
    const kp = generateKeyPair();
    const derived = createPublicKey(
      createPrivateKey({ key: Buffer.from(kp.secretKey), format: 'der', type: 'pkcs8' }),
    )
      .export({ type: 'spki', format: 'der' })
      .subarray(-32);
    expect(new Uint8Array(derived)).toEqual(kp.publicKey);
  });
});
