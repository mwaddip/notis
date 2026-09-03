// The build-time `crypto` shim
// (WEB_INTERFACE → The browser reaches @dagsocial/types through a build-time shim).
// vite resolves the bare `crypto` specifier to this module, so @dagsocial/types
// reaches the two symbols it imports from Node's `crypto` — createHash and
// generateKeyPairSync — over pure-TS primitives. `Buffer`, the other Node global
// it uses but never imports, is supplied to the bundle separately.
//
// The shim carries only what the client's module graph reaches: createPublicKey
// and verify are @dagsocial/validation's, and the client does not depend on it,
// so they arrive with the code that calls them, not here.
// WEB_INTERFACE → "The shim carries only what the client's own module graph reaches, and nothing on speculation"
//
// ⛔ The hashing MUST be byte-identical to Node's createHash('blake2b512'):
// every protocol id is a blake2b-512 digest truncated to 32 bytes, so a shim
// that differs by one byte produces ids the node rejects. Pinned against Node's
// real implementation by test/crypto-shim.test.ts, and against live node data in
// a browser by the binding check.
//
// ⚠ No WASM — @noble/hashes and @noble/curves are pure TS (OVERRIDES rule 15).

import { Buffer } from 'buffer';
import { blake2b } from '@noble/hashes/blake2.js';
import { ed25519 } from '@noble/curves/ed25519.js';

// ---------------------------------------------------------------------------
// Hashing — createHash('blake2b512')
// ---------------------------------------------------------------------------

// The consumers chain `.update(bytes)` any number of times, then read the
// digest as `.digest().subarray(0, 32).toString('hex')` (five sites) or wrap
// `.digest().subarray(0, 32)` in a Uint8Array. `.digest()` therefore returns a
// `Buffer`, whose `.subarray()` stays a Buffer and whose `.toString('hex')` is
// lowercase hex — a plain Uint8Array would stringify to comma-joined decimals.
class Blake2b512 {
  private readonly h = blake2b.create({ dkLen: 64 });

  update(data: Uint8Array): this {
    this.h.update(data);
    return this;
  }

  digest(): Buffer {
    return Buffer.from(this.h.digest());
  }
}

/** Node `createHash`, narrowed to the one algorithm the protocol hashes with. */
export function createHash(algorithm: string): Blake2b512 {
  if (algorithm !== 'blake2b512') {
    throw new Error(`crypto shim: unsupported hash algorithm '${algorithm}'`);
  }
  return new Blake2b512();
}

// ---------------------------------------------------------------------------
// Ed25519 — key generation
// ---------------------------------------------------------------------------
//
// @dagsocial/types speaks Node's KeyObject dialect: `generateKeyPairSync('ed25519')`
// yields objects with `.export({ type, format })`. Ed25519 SPKI/PKCS8 DER are the
// fixed RFC 8410 wrappers — a 12-byte prefix before the 32 raw public-key bytes,
// a 16-byte prefix before the 32-byte seed — so a KeyObject here is just the raw
// key it carries.

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

/** A public KeyObject: it carries the 32 raw Ed25519 bytes and exports SPKI DER. */
export class PublicKeyObject {
  constructor(private readonly raw: Uint8Array) {}

  export(opts: { type: string; format: string }): Buffer {
    if (opts.type !== 'spki' || opts.format !== 'der') {
      throw new Error(`crypto shim: unsupported public key export ${opts.type}/${opts.format}`);
    }
    return Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(this.raw)]);
  }
}

/** A private KeyObject: it carries the 32-byte seed and exports PKCS8 DER. */
export class PrivateKeyObject {
  constructor(readonly seed: Uint8Array) {}

  export(opts: { type: string; format: string }): Buffer {
    if (opts.type !== 'pkcs8' || opts.format !== 'der') {
      throw new Error(`crypto shim: unsupported private key export ${opts.type}/${opts.format}`);
    }
    return Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(this.seed)]);
  }
}

export function generateKeyPairSync(type: string): { publicKey: PublicKeyObject; privateKey: PrivateKeyObject } {
  if (type !== 'ed25519') {
    throw new Error(`crypto shim: unsupported key type '${type}'`);
  }
  const seed = ed25519.utils.randomSecretKey();
  const publicKey = new PublicKeyObject(ed25519.getPublicKey(seed));
  return { publicKey, privateKey: new PrivateKeyObject(seed) };
}
