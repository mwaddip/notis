import { describe, it, expect } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { verifyEd25519 } from '../src/index.js';

// verifyEd25519 — VALIDATION_INTERFACE → Acceptance criterion: strict RFC 8032
// / FIPS 186-5 through @noble/curves, pinned to `{ zip215: false }` rather
// than the library's permissive ZIP-215 default, and total on malformed input.

/** Decode a hex string (no `0x` prefix) into raw bytes. */
const h = (hex: string): Uint8Array => new Uint8Array(Buffer.from(hex, 'hex'));

/**
 * RFC 8032 §7.1 "Test Vectors for Ed25519" (https://www.rfc-editor.org/rfc/rfc8032)
 * — TEST 1, TEST 2, TEST 3 and TEST SHA(abc). Only publicKey/message/signature
 * are needed here: this exercises verification, not signing.
 */
const RFC8032_VECTORS: Array<{ name: string; publicKey: Uint8Array; message: Uint8Array; signature: Uint8Array }> = [
  {
    name: 'TEST 1',
    publicKey: h('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a'),
    message: h(''),
    signature: h(
      'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b',
    ),
  },
  {
    name: 'TEST 2',
    publicKey: h('3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c'),
    message: h('72'),
    signature: h(
      '92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00',
    ),
  },
  {
    name: 'TEST 3',
    publicKey: h('fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025'),
    message: h('af82'),
    signature: h(
      '6291d657deec24024827e69c3abe01a30ce548a284743a445e3680d7db5ac3ac18ff9b538d16f290ae67f760984dc6594a7c15e9716ed28dc027beceea1ec40a',
    ),
  },
  {
    name: 'TEST SHA(abc)',
    publicKey: h('ec172b93ad5e563bf4932c70e1245034c35467ef2efd4d64ebf819683467e2bf'),
    message: h(
      'ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f',
    ),
    signature: h(
      'dc2a4459e7369633a52b1bf277839a00201009a3efbf3ecb69bea2186c26b58909351fc9ac90b3ecfdfbc7c66431e0303dca179c138ac17ad9bef1177331a704',
    ),
  },
];

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
