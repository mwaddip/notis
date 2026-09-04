import { ed25519 } from '@noble/curves/ed25519.js';
import { generateKeyPair } from '@dagsocial/types';
import { readStore, writeStore, removeStore } from '../prefs';

// The identity machinery — WEB_INTERFACE → The identity module. One identity at a
// time, stored under `notis.identity` in localStorage in the demo UI's export
// shape, so one key moves between the demo UI and this client in both
// directions. No encryption at rest; a passphrase is interface, and the identity
// interface is not this slice's.
//
// WEB_INTERFACE → "sign is the only path to the seed": current() returns the
// public key alone, and the 32-byte seed leaves this module only as an Ed25519
// signature over a transaction id. Signing is @noble/curves, pure TS through the
// same family the shim carries, so there is no Web Crypto and no secure-context
// requirement.

/** The public view of a loaded identity — the seed is never in it. */
export interface Identity {
  pubKeyHex: string; // 64 hex — the Ed25519 public key
}

/** The at-rest shape, byte-for-byte the demo UI's export file. */
export interface StoredIdentity {
  pubKeyHex: string; // 64 hex
  privKeyBase64: string; // base64 of the 48-byte PKCS8 DER of the Ed25519 seed
}

/** The localStorage key holding the one identity — WEB_INTERFACE → The identity module. */
export const IDENTITY_KEY = 'notis.identity';

// The fixed RFC 8410 PKCS8 wrapper for an Ed25519 seed: a 16-byte prefix before
// the 32-byte seed (WEB_INTERFACE → The identity module, the Import row). Node's
// generateKeyPairSync emits it and the demo UI stores it; a file whose first 16
// bytes are not this is not an Ed25519 key this client can sign with.
const PKCS8_PREFIX_HEX = '302e020100300506032b657004220420';

const HEX64 = /^[0-9a-f]{64}$/;

/** A refusal a human reads — WEB_INTERFACE → The identity module: import validates
 *  rather than trusts, and each failure names what is wrong. */
export class IdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IdentityError';
  }
}

export class IdentityModule {
  // The seed sits in JS memory only while an identity is loaded; it is never a
  // return value, and current() cannot reach it.
  private seed: Uint8Array | null = null;
  private pubKeyHex: string | null = null;
  private privKeyBase64: string | null = null;

  constructor() {
    this.restore();
  }

  /** The loaded identity's public half, or null — the read surface is unchanged
   *  when this is null (WEB_INTERFACE → The write surface). */
  current(): Identity | null {
    return this.pubKeyHex === null ? null : { pubKeyHex: this.pubKeyHex };
  }

  /** Make a fresh key through @dagsocial/types (its secretKey is already the
   *  48-byte PKCS8 DER the stored shape carries) and adopt it. */
  generate(): Identity {
    const kp = generateKeyPair();
    return this.adopt({ pubKeyHex: toHex(kp.publicKey), privKeyBase64: bytesToBase64(kp.secretKey) });
  }

  /** Validate and adopt an identity file's text, replacing any loaded identity. */
  importJson(text: string): Identity {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new IdentityError('that is not a valid identity file.');
    }
    return this.adopt(parseStored(parsed));
  }

  /** The stored shape as text — the reader's own file (WEB_INTERFACE → "A private
   *  key never travels to any server"). */
  exportJson(): string {
    if (this.pubKeyHex === null || this.privKeyBase64 === null) {
      throw new IdentityError('no identity is loaded to export.');
    }
    return JSON.stringify({ pubKeyHex: this.pubKeyHex, privKeyBase64: this.privKeyBase64 }, null, 2);
  }

  /** Drop the identity from memory and storage. */
  forget(): void {
    this.seed = null;
    this.pubKeyHex = null;
    this.privKeyBase64 = null;
    removeStore(IDENTITY_KEY);
  }

  /** Ed25519 over the 32 transaction-id bytes, 128 hex out — the only path to the
   *  seed (WEB_INTERFACE → "sign is the only path to the seed"). The input is
   *  validated because this method is reachable from the console in a dev build:
   *  a transaction id is exactly 64 lowercase hex, and anything else is refused
   *  rather than signed over garbage bytes. */
  sign(txIdHex: string): string {
    if (this.seed === null) throw new IdentityError('no identity is loaded to sign with.');
    if (!HEX64.test(txIdHex)) throw new IdentityError('a transaction id to sign must be 64 hex characters.');
    return toHex(ed25519.sign(hexToBytes(txIdHex), this.seed));
  }

  // -------------------------------------------------------------------------

  /** Validate a stored shape, load its seed, and persist it. */
  private adopt(stored: StoredIdentity): Identity {
    const seed = seedFromStored(stored);
    this.seed = seed;
    this.pubKeyHex = stored.pubKeyHex;
    this.privKeyBase64 = stored.privKeyBase64;
    writeStore(IDENTITY_KEY, JSON.stringify(stored));
    return { pubKeyHex: stored.pubKeyHex };
  }

  /** Load a stored identity at construction. A stored value that no longer
   *  validates is left unloaded rather than trusted — the seed never loads and
   *  current() stays null; localStorage is untrusted input, guarded like
   *  prefs.ts guards its own reads. */
  private restore(): void {
    const raw = readStore(IDENTITY_KEY);
    if (raw === null) return;
    let stored: StoredIdentity;
    let seed: Uint8Array;
    try {
      stored = parseStored(JSON.parse(raw));
      seed = seedFromStored(stored);
    } catch {
      return;
    }
    this.seed = seed;
    this.pubKeyHex = stored.pubKeyHex;
    this.privKeyBase64 = stored.privKeyBase64;
  }
}

/** The single identity module the app loads. */
export const identity = new IdentityModule();

// ---------------------------------------------------------------------------
// Validation and codec — WEB_INTERFACE → The identity module: import validates
// rather than trusts, so a file that names one key and carries another is refused.
// ---------------------------------------------------------------------------

function parseStored(parsed: unknown): StoredIdentity {
  if (typeof parsed !== 'object' || parsed === null) {
    throw new IdentityError('that is not an identity file.');
  }
  const o = parsed as Record<string, unknown>;
  if (typeof o.pubKeyHex !== 'string' || !HEX64.test(o.pubKeyHex)) {
    throw new IdentityError('the file has no valid public key.');
  }
  if (typeof o.privKeyBase64 !== 'string' || o.privKeyBase64 === '') {
    throw new IdentityError('the file has no private key.');
  }
  return { pubKeyHex: o.pubKeyHex, privKeyBase64: o.privKeyBase64 };
}

/** Decode the stored private half to a 32-byte seed, refusing a wrong length, a
 *  wrong prefix, or a public key the seed does not produce. */
function seedFromStored(stored: StoredIdentity): Uint8Array {
  const der = base64ToBytes(stored.privKeyBase64);
  if (der.length !== 48) {
    throw new IdentityError('the private key is not a 48-byte PKCS8 key.');
  }
  if (toHex(der.subarray(0, 16)) !== PKCS8_PREFIX_HEX) {
    throw new IdentityError('the private key is not an Ed25519 PKCS8 key.');
  }
  const seed = new Uint8Array(der.subarray(16));
  if (toHex(ed25519.getPublicKey(seed)) !== stored.pubKeyHex) {
    throw new IdentityError('the file names a public key its private key does not produce.');
  }
  return seed;
}

// Hex and base64 without a Node `Buffer`: the client holds no Node global.
// atob/btoa are in the DOM lib and present under vitest too (Node exposes both
// as globals), so this needs no import.

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

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
