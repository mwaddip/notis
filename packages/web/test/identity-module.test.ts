// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { createPublicKey as nodeCreatePublicKey, verify as nodeVerify } from 'node:crypto';
import { generateKeyPair, ED25519_SPKI_PREFIX } from '@dagsocial/types';
import { IdentityModule, IDENTITY_KEY } from '../src/identity/identity';

// The identity module holds one key, signs with it, and never lets the seed
// cross its boundary (WEB_INTERFACE → The identity module). Under vitest the
// vite alias routes @dagsocial/types' `crypto` through the shim, and Node's real
// `crypto.verify(null, …)` — the node's verifier path — confirms a signature the
// module makes, the way crypto-shim.test.ts reaches real Node crypto.

function toHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}
function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

beforeEach(() => {
  localStorage.clear();
});

describe('identity module — generation, export, import', () => {
  it('generate → export → import round trips in the demo UI shape', () => {
    const a = new IdentityModule();
    const id = a.generate();
    expect(id.pubKeyHex).toMatch(/^[0-9a-f]{64}$/);

    const text = a.exportJson();
    const parsed = JSON.parse(text);
    expect(parsed).toEqual({ pubKeyHex: id.pubKeyHex, privKeyBase64: expect.any(String) });

    // A fresh module with cleared storage has no identity, then imports that exact text.
    localStorage.clear();
    const b = new IdentityModule();
    expect(b.current()).toBeNull();
    expect(b.importJson(text).pubKeyHex).toBe(id.pubKeyHex);
    // The imported module can sign — the seed came across, not just the public key.
    expect(b.sign('ab'.repeat(32))).toHaveLength(128);
  });

  it('import validates rather than trusts: wrong length, wrong prefix, mismatched key', () => {
    const m = new IdentityModule();
    const kp = generateKeyPair();
    const pubKeyHex = toHex(kp.publicKey);
    const good = JSON.stringify({ pubKeyHex, privKeyBase64: bytesToBase64(kp.secretKey) });
    expect(m.importJson(good).pubKeyHex).toBe(pubKeyHex);

    // 47 bytes — not a PKCS8 Ed25519 key.
    const short = JSON.stringify({ pubKeyHex, privKeyBase64: bytesToBase64(kp.secretKey.subarray(0, 47)) });
    expect(() => m.importJson(short)).toThrow(/48-byte/);

    // 48 bytes, but the RFC 8410 prefix's first byte (0x30) is corrupted.
    const badPrefixBytes = new Uint8Array(kp.secretKey);
    badPrefixBytes[0] = 0xff;
    const badPrefix = JSON.stringify({ pubKeyHex, privKeyBase64: bytesToBase64(badPrefixBytes) });
    expect(() => m.importJson(badPrefix)).toThrow(/PKCS8/);

    // A valid shape whose named key is a different keypair's — the seed does not produce it.
    const other = generateKeyPair();
    const mismatch = JSON.stringify({ pubKeyHex: toHex(other.publicKey), privKeyBase64: bytesToBase64(kp.secretKey) });
    expect(() => m.importJson(mismatch)).toThrow(/does not produce/);

    // A failed import leaves the good identity loaded, uncorrupted.
    expect(m.current()).toEqual({ pubKeyHex });
  });

  it('import refuses non-JSON and a non-object', () => {
    const m = new IdentityModule();
    expect(() => m.importJson('not json at all')).toThrow(/valid identity file/);
    expect(() => m.importJson('123')).toThrow(/identity file/);
    expect(() => m.importJson(JSON.stringify({ pubKeyHex: 'zz' }))).toThrow(/public key/);
  });

  it('current() carries the public key alone — never the seed', () => {
    const m = new IdentityModule();
    m.generate();
    const cur = m.current();
    expect(cur).not.toBeNull();
    expect(Object.keys(cur!)).toEqual(['pubKeyHex']);
    // No private material by any name reachable through the public view.
    const asRecord = cur as unknown as Record<string, unknown>;
    expect(asRecord.privKeyBase64).toBeUndefined();
    expect(asRecord.seed).toBeUndefined();
  });

  it('forget() drops the identity from memory and storage', () => {
    const m = new IdentityModule();
    m.generate();
    m.forget();
    expect(m.current()).toBeNull();
    expect(localStorage.getItem(IDENTITY_KEY)).toBeNull();
    expect(() => m.sign('ab'.repeat(32))).toThrow(/no identity/);
    expect(() => m.exportJson()).toThrow(/no identity/);
  });
});

describe('identity module — persistence and storage guards', () => {
  it('a generated identity is restored by a fresh module, seed included', () => {
    const id = new IdentityModule().generate();
    const b = new IdentityModule();
    expect(b.current()).toEqual({ pubKeyHex: id.pubKeyHex });
    expect(b.sign('cd'.repeat(32))).toHaveLength(128);
  });

  it('a write that throws does not break a load — the identity lives for the session', () => {
    const m = new IdentityModule();
    const orig = localStorage.setItem.bind(localStorage);
    localStorage.setItem = () => {
      throw new Error('storage blocked');
    };
    try {
      const id = m.generate();
      expect(m.current()).toEqual({ pubKeyHex: id.pubKeyHex });
    } finally {
      localStorage.setItem = orig;
    }
  });

  it('a read that throws yields no identity rather than an exception', () => {
    const orig = localStorage.getItem.bind(localStorage);
    localStorage.getItem = () => {
      throw new Error('storage blocked');
    };
    try {
      expect(new IdentityModule().current()).toBeNull();
    } finally {
      localStorage.getItem = orig;
    }
  });

  it('a corrupt stored identity is left unloaded, not trusted', () => {
    localStorage.setItem(IDENTITY_KEY, '{ this is not valid json');
    expect(new IdentityModule().current()).toBeNull();
    localStorage.setItem(IDENTITY_KEY, JSON.stringify({ pubKeyHex: 'ab'.repeat(32), privKeyBase64: 'notbase64!!' }));
    expect(new IdentityModule().current()).toBeNull();
  });
});

describe('identity module — signing interop with the node verifier', () => {
  it('a signature verifies under Node crypto.verify(null, …) with the SPKI-wrapped key', () => {
    const m = new IdentityModule();
    const { pubKeyHex } = m.generate();
    const txIdHex = '9a'.repeat(32);
    const sigHex = m.sign(txIdHex);
    expect(sigHex).toHaveLength(128);

    // The node wraps the 32-byte key in the fixed SPKI prefix and verifies raw
    // Ed25519 over the 32 id bytes.
    const spki = hexToBytes(ED25519_SPKI_PREFIX + pubKeyHex);
    const key = nodeCreatePublicKey({ key: spki, format: 'der', type: 'spki' });
    expect(nodeVerify(null, hexToBytes(txIdHex), key, hexToBytes(sigHex))).toBe(true);
    // A different message does not verify against that signature.
    expect(nodeVerify(null, hexToBytes('00'.repeat(32)), key, hexToBytes(sigHex))).toBe(false);
  });

  it('sign refuses anything but 64 lowercase hex — it is the one path to the seed', () => {
    const m = new IdentityModule();
    m.generate();
    for (const bad of ['', 'abc', 'ab'.repeat(31), 'ab'.repeat(33), 'zz'.repeat(32), 'AB'.repeat(32), `${'ab'.repeat(32)} `]) {
      expect(() => m.sign(bad), bad).toThrow(/64 hex/);
    }
    expect(m.sign('ab'.repeat(32))).toHaveLength(128);
  });
});
