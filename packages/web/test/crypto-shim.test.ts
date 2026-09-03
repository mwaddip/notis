import { describe, it, expect } from 'vitest';
import { createHash as nodeCreateHash, generateKeyPairSync as nodeGenerateKeyPairSync, createPublicKey as nodeCreatePublicKey, sign as nodeSign, verify as nodeVerify } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { Buffer } from 'buffer';
import { createHash, generateKeyPairSync, createPublicKey, verify } from '../src/shim/crypto';

// The shim is a BUILD-TIME substitution: under Node the real `crypto` is present
// and the substitution never happens, so this suite cannot prove the shim is
// wired into the bundle (that is the browser binding check). What it CAN prove,
// and must, is that the pure-TS primitives the shim stands on are byte-identical
// to Node's. A one-byte difference in the hash produces ids the node rejects, and
// neither package's own tests would notice.
// WEB_INTERFACE → The browser reaches @dagsocial/types through a build-time shim

const enc = new TextEncoder();

function toHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

describe('crypto shim — createHash(blake2b512) is byte-identical to Node', () => {
  // Empty, one byte, the golden content strings, every byte value, and a long
  // run — a difference in padding, block boundary or finalization shows here.
  const allBytes = new Uint8Array(256);
  for (let i = 0; i < 256; i++) allBytes[i] = i;
  const inputs: Uint8Array[] = [
    new Uint8Array(0),
    enc.encode('x'),
    enc.encode('dagsocial golden vector ✓'),
    enc.encode('héllo 日本 😀'),
    allBytes,
    new Uint8Array(1000).fill(0xab),
  ];

  it('single .update over varied inputs matches Node digest for digest', () => {
    for (const input of inputs) {
      const shim = createHash('blake2b512').update(input).digest();
      const node = nodeCreateHash('blake2b512').update(input).digest();
      expect(toHex(shim)).toBe(toHex(node));
      expect(shim.length).toBe(64);
    }
  });

  it('chained .update accumulates exactly as Node — the computeContentHash shape', () => {
    const domain = enc.encode('dagsocial/post-content/1');
    const content = enc.encode('dagsocial golden vector ✓');
    const shim = createHash('blake2b512').update(domain).update(content).digest();
    const node = nodeCreateHash('blake2b512').update(domain).update(content).digest();
    expect(toHex(shim)).toBe(toHex(node));
  });

  it('reproduces the frozen golden contentHash vectors', () => {
    // computeContentHash(content) = blake2b512(POST_CONTENT_DOMAIN ‖ utf8(content))[0:32].
    const domain = enc.encode('dagsocial/post-content/1');
    const golden: Array<[string, string]> = [
      ['dagsocial golden vector ✓', '9745d058b1dbd844c81b91384cad9bbcff0896560987f64c50e4e924477c5569'],
      ['x', '50e56e6bf756c33474cf419a860e0bd2287462b9eae0004f19c281a5791f6da0'],
      ['héllo 日本 😀', '5f5a14d56a2edea0b8b555cc8e50688680c48f85ffdce5d6cb84c3bc8b2a4a2b'],
    ];
    for (const [content, expected] of golden) {
      const digest = createHash('blake2b512').update(domain).update(enc.encode(content)).digest();
      expect(toHex(digest.subarray(0, 32))).toBe(expected);
      // The exact path types/validation read a digest through — Buffer.subarray
      // stays a Buffer, so .toString('hex') is lowercase hex.
      expect(digest.toString('hex', 0, 32)).toBe(expected);
    }
  });

  it('rejects an unsupported algorithm rather than hashing wrongly', () => {
    expect(() => createHash('sha256')).toThrow(/unsupported hash algorithm/);
  });
});

describe('crypto shim — Ed25519 verify interoperates with Node', () => {
  const message = enc.encode('an ordering-block hash the validator signs');

  it('accepts a signature Node produced, over the SPKI DER the verifier wraps', () => {
    const { publicKey, privateKey } = nodeGenerateKeyPairSync('ed25519');
    const signature = nodeSign(null, message, privateKey);
    const spkiDer = publicKey.export({ type: 'spki', format: 'der' });

    const keyObj = createPublicKey({ key: spkiDer, format: 'der', type: 'spki' });
    expect(verify(null, message, keyObj, signature)).toBe(true);

    // A flipped signature byte and a flipped message byte both fail.
    const badSig = Uint8Array.from(signature);
    badSig[0] = badSig[0]! ^ 0x01;
    expect(verify(null, message, keyObj, badSig)).toBe(false);
    const badMsg = Uint8Array.from(message);
    badMsg[0] = badMsg[0]! ^ 0x01;
    expect(verify(null, badMsg, keyObj, signature)).toBe(false);
    expect(verify(null, message, keyObj, signature.subarray(0, 63))).toBe(false);
  });
});

describe('crypto shim — generateKeyPairSync yields Node-compatible Ed25519 DER', () => {
  it('exports canonical SPKI/PKCS8 DER that Node parses and that round-trips', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const spki = publicKey.export({ type: 'spki', format: 'der' });
    const pkcs8 = privateKey.export({ type: 'pkcs8', format: 'der' });

    // RFC 8410 fixed wrappers: 12-byte prefix + 32 key bytes; 16-byte prefix + 32 seed bytes.
    expect(spki.length).toBe(44);
    expect(pkcs8.length).toBe(48);
    expect(Buffer.from(spki).toString('hex', 0, 12)).toBe('302a300506032b6570032100');
    expect(Buffer.from(pkcs8).toString('hex', 0, 16)).toBe('302e020100300506032b657004220420');

    // Node accepts the shim's SPKI, and a signature the shim's seed produces
    // verifies under Node against it — the shim's keypair is a real, matching pair.
    const seed = pkcs8.subarray(16);
    const message = enc.encode('interop');
    const signature = ed25519.sign(message, seed);
    const nodeKey = nodeCreatePublicKey({ key: spki, format: 'der', type: 'spki' });
    expect(nodeVerify(null, message, nodeKey, signature)).toBe(true);

    // And the shim verifies the same signature through its own KeyObject.
    expect(verify(null, message, publicKey, signature)).toBe(true);
  });
});
