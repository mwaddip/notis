import { describe, it, expect } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { verifyEd25519 } from '../src/index.js';
import { RFC8032_VECTORS } from './rfc8032-vectors.js';

// verifyEd25519 — VALIDATION_INTERFACE → Acceptance criterion: strict RFC 8032
// / FIPS 186-5 through @noble/curves, pinned to `{ zip215: false }` rather
// than the library's permissive ZIP-215 default, and total on malformed input.

describe('verifyEd25519', () => {
  it.each(RFC8032_VECTORS)('verifies the RFC 8032 §7.1 vector $name', ({ publicKey, message, signature }) => {
    expect(verifyEd25519(signature, message, publicKey)).toBe(true);
  });

  describe('the two malleation forms', () => {
    // VALIDATION_INTERFACE → Acceptance criterion, "Its tests": a scalar
    // raised by the group order (S + L) and the high-bit variant both refuse.
    const genuine = RFC8032_VECTORS[0]!; // TEST 1
    const r = genuine.signature.subarray(0, 32);
    const s = genuine.signature.subarray(32, 64);

    /** Little-endian bytes to a bigint. */
    const leToBigInt = (b: Uint8Array): bigint => {
      let v = 0n;
      for (let i = b.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(b[i]!);
      return v;
    };
    /** A bigint to fixed-length little-endian bytes. */
    const bigIntToLe = (value: bigint, len: number): Uint8Array => {
      const out = new Uint8Array(len);
      let v = value;
      for (let i = 0; i < len; i++) {
        out[i] = Number(v & 0xffn);
        v >>= 8n;
      }
      return out;
    };
    // The Ed25519 group order L (RFC 8032 §5.1).
    const L = 2n ** 252n + 27742317777372353535851937790883648493n;

    it('refuses S + L, the scalar raised by the group order', () => {
      const sPlusL = bigIntToLe(leToBigInt(s) + L, 32);
      const malleated = new Uint8Array(64);
      malleated.set(r, 0);
      malleated.set(sPlusL, 32);
      expect(verifyEd25519(malleated, genuine.message, genuine.publicKey)).toBe(false);
    });

    it('refuses the signature with the high bit of its last byte set', () => {
      const malleated = new Uint8Array(genuine.signature);
      malleated[63] = malleated[63]! | 0x80;
      expect(verifyEd25519(malleated, genuine.message, genuine.publicKey)).toBe(false);
    });
  });

  describe('strict mode, not the library default', () => {
    // VALIDATION_INTERFACE → Acceptance criterion: `{ zip215: false }`, never
    // ZIP-215. Constructed case: the identity point's encoding (x=0, y=1 —
    // compressed as y little-endian with the sign bit, the top bit of byte 31,
    // 0 for x's even parity) as both the public key and R, with S = 0. A
    // small-order public key contributes nothing to the check equation and
    // S = 0 makes the right-hand side the identity too, so ZIP-215's
    // permissive decode accepts this for any message; strict RFC 8032 / FIPS
    // 186-5 refuses a small-order public key outright, before the check
    // equation runs — the class of case "Taming the many EdDSAs" (Chalkias,
    // Garillot, Nikolaenko, 2020) and the `ed25519-speccheck` repository's
    // small-order vectors cover.
    const identityPoint = new Uint8Array(32);
    identityPoint[0] = 1;
    const signature = new Uint8Array(64);
    signature.set(identityPoint, 0); // R = the identity point; bytes 32..64 stay 0 (S = 0)
    const message = new TextEncoder().encode('anything at all');

    it('the library default (ZIP-215) accepts it — the regression this pin catches', () => {
      expect(ed25519.verify(signature, message, identityPoint)).toBe(true);
    });

    it('verifyEd25519 refuses it', () => {
      expect(verifyEd25519(signature, message, identityPoint)).toBe(false);
    });
  });

  describe('totality', () => {
    // VALIDATION_INTERFACE → Acceptance criterion, "It is total": a signature
    // that is not 64 bytes, a key that is not 32, or a key that does not
    // decode to a point answers `false`, never a throw.
    const valid = RFC8032_VECTORS[0]!; // TEST 1

    it('refuses a 63- or 65-byte signature without throwing', () => {
      for (const len of [63, 65]) {
        const bad = new Uint8Array(len);
        expect(() => verifyEd25519(bad, valid.message, valid.publicKey)).not.toThrow();
        expect(verifyEd25519(bad, valid.message, valid.publicKey)).toBe(false);
      }
    });

    it('refuses a 31- or 33-byte key without throwing', () => {
      for (const len of [31, 33]) {
        const bad = new Uint8Array(len);
        expect(() => verifyEd25519(valid.signature, valid.message, bad)).not.toThrow();
        expect(verifyEd25519(valid.signature, valid.message, bad)).toBe(false);
      }
    });

    it('refuses a 32-byte key that does not decode to a point, without throwing', () => {
      const offCurve = new Uint8Array(32).fill(0xff);
      expect(() => verifyEd25519(valid.signature, valid.message, offCurve)).not.toThrow();
      expect(verifyEd25519(valid.signature, valid.message, offCurve)).toBe(false);
    });

    it('refuses non-Uint8Array inputs without throwing, in every argument position', () => {
      const bad: unknown[] = ['abc', null, [1, 2, 3]];
      for (const b of bad) {
        expect(() => verifyEd25519(b as any, valid.message, valid.publicKey)).not.toThrow();
        expect(verifyEd25519(b as any, valid.message, valid.publicKey)).toBe(false);
        expect(() => verifyEd25519(valid.signature, b as any, valid.publicKey)).not.toThrow();
        expect(verifyEd25519(valid.signature, b as any, valid.publicKey)).toBe(false);
        expect(() => verifyEd25519(valid.signature, valid.message, b as any)).not.toThrow();
        expect(verifyEd25519(valid.signature, valid.message, b as any)).toBe(false);
      }
    });
  });
});
