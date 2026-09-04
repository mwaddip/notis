import { ed25519 } from '@noble/curves/ed25519.js';
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { scryptAsync } from '@noble/hashes/scrypt.js';
import { randomBytes } from '@noble/hashes/utils.js';

// The identity envelope — WEB_INTERFACE → The identity module. The stored value
// and the exported file are one shape, so importing an encrypted file is storing
// it: scrypt derives a 32-byte key from the passphrase and salt, ChaCha20-Poly1305
// seals the 32-byte seed under it, and the public key and version ride as
// associated data — a file whose header is edited fails to open rather than
// opening as another key. Pure: no storage, no module state. Both primitives are
// in Node's own crypto (scryptSync, createDecipheriv('chacha20-poly1305')), so a
// Node tool opens the file with the standard library; the randomness is
// getRandomValues, which no secure context gates, so there is no Web Crypto.

/** The envelope version — the file's `version`, and one byte of the AAD. */
export const ENVELOPE_VERSION = 1;

// scrypt cost — WEB_INTERFACE → The identity module. The parameters travel in the
// envelope, so N can rise later with no version bump.
export const SCRYPT_N = 65536;
export const SCRYPT_R = 8;
export const SCRYPT_P = 1;

/** The fixed RFC 8410 PKCS8 wrapper for an Ed25519 seed — a 16-byte prefix before
 *  the 32-byte seed (WEB_INTERFACE → The identity module, the Key generation row).
 *  The sealed plaintext is the seed alone; this is what a clear file's 48-byte DER
 *  carries in front of it. */
const PKCS8_PREFIX_HEX = '302e020100300506032b657004220420';

const HEX = /^(?:[0-9a-f]{2})+$/;
const HEX64 = /^[0-9a-f]{64}$/;

/** A refusal a human reads — WEB_INTERFACE → The identity module: each failure
 *  names what is wrong. */
export class IdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IdentityError';
  }
}

/** The scrypt cost parameters carried in an envelope's `kdf`. */
export interface ScryptParams {
  N: number;
  r: number;
  p: number;
}

/** The encrypted envelope — WEB_INTERFACE → The identity module, one shape at rest
 *  and in the file both. */
export interface Envelope {
  version: number;
  pubKeyHex: string;
  kdf: { name: 'scrypt'; salt: string } & ScryptParams;
  cipher: { name: 'chacha20-poly1305'; nonce: string };
  ciphertext: string; // the 32-byte seed ‖ the 16-byte tag, hex
}

/** The demo UI's clear export shape — a file shape only (WEB_INTERFACE → The
 *  identity module, the Import row). */
export interface ClearFile {
  pubKeyHex: string;
  privKeyBase64: string;
}

/** What parseFile hands back: the kind, the public key, and — already validated —
 *  the seed for a clear file or the envelope for an encrypted one. */
export type ParsedFile =
  | { kind: 'clear'; pubKeyHex: string; seed: Uint8Array }
  | { kind: 'encrypted'; pubKeyHex: string; envelope: Envelope };

const DEFAULT_PARAMS: ScryptParams = { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P };

/** The public key and version as associated data — an edited header changes the
 *  AAD, so the seal fails to open rather than opening as another key
 *  (WEB_INTERFACE → The identity module). */
function aad(pubKeyHex: string, version: number): Uint8Array {
  const pub = hexToBytes(pubKeyHex);
  const out = new Uint8Array(pub.length + 1);
  out.set(pub, 0);
  out[pub.length] = version & 0xff;
  return out;
}

/** scrypt over the UTF-8 passphrase → a 32-byte key. Async so the page does not
 *  freeze (WEB_INTERFACE → The identity module); the same derivation Node's
 *  scryptSync makes over the same bytes. */
function deriveKey(passphrase: string, salt: Uint8Array, params: ScryptParams): Promise<Uint8Array> {
  return scryptAsync(new TextEncoder().encode(passphrase), salt, {
    N: params.N,
    r: params.r,
    p: params.p,
    dkLen: 32,
  });
}

/** Seal a 32-byte seed under a passphrase — a fresh salt and nonce every time, so
 *  a derived key is used for exactly one seal, which is what makes a random 12-byte
 *  nonce safe (WEB_INTERFACE → The identity module). */
export async function seal(
  seed: Uint8Array,
  pubKeyHex: string,
  passphrase: string,
  params: ScryptParams = DEFAULT_PARAMS,
): Promise<Envelope> {
  if (seed.length !== 32) throw new IdentityError('a seed to seal must be 32 bytes.');
  if (!HEX64.test(pubKeyHex)) throw new IdentityError('a public key to seal under must be 64 hex characters.');
  const salt = randomBytes(16);
  const nonce = randomBytes(12);
  const key = await deriveKey(passphrase, salt, params);
  const ciphertext = chacha20poly1305(key, nonce, aad(pubKeyHex, ENVELOPE_VERSION)).encrypt(seed);
  return {
    version: ENVELOPE_VERSION,
    pubKeyHex,
    kdf: { name: 'scrypt', salt: toHex(salt), N: params.N, r: params.r, p: params.p },
    cipher: { name: 'chacha20-poly1305', nonce: toHex(nonce) },
    ciphertext: toHex(ciphertext),
  };
}

/** Open an envelope with a passphrase, returning the 32-byte seed. A wrong
 *  passphrase, an edited header (the AAD) and a flipped byte all fail the tag and
 *  are refused the same way — they are indistinguishable, which is the point of an
 *  AEAD (WEB_INTERFACE → The identity module). After decrypt the public key is
 *  recomputed and must equal the envelope's. */
export async function open(envelope: Envelope, passphrase: string): Promise<Uint8Array> {
  const salt = hexToBytes(requireHex(envelope.kdf?.salt, 'salt'));
  const nonce = hexToBytes(requireHex(envelope.cipher?.nonce, 'nonce'));
  const ciphertext = hexToBytes(requireHex(envelope.ciphertext, 'ciphertext'));
  const key = await deriveKey(passphrase, salt, { N: envelope.kdf.N, r: envelope.kdf.r, p: envelope.kdf.p });
  let seed: Uint8Array;
  try {
    seed = chacha20poly1305(key, nonce, aad(envelope.pubKeyHex, envelope.version)).decrypt(ciphertext);
  } catch {
    throw new IdentityError('that passphrase does not open this key.');
  }
  if (toHex(ed25519.getPublicKey(seed)) !== envelope.pubKeyHex) {
    throw new IdentityError('the file names a public key its private key does not produce.');
  }
  return seed;
}

/** Distinguish the clear and encrypted file shapes and validate each — WEB_INTERFACE
 *  → The identity module. A clear file is checked to its seed here (48-byte PKCS8,
 *  the RFC 8410 prefix, the recomputed key); an encrypted file's structure is
 *  checked, and open verifies the rest under the passphrase. */
export function parseFile(text: string): ParsedFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new IdentityError('that is not a valid identity file.');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new IdentityError('that is not an identity file.');
  }
  const o = parsed as Record<string, unknown>;
  if (typeof o.pubKeyHex !== 'string' || !HEX64.test(o.pubKeyHex)) {
    throw new IdentityError('the file has no valid public key.');
  }
  const pubKeyHex = o.pubKeyHex;
  if (typeof o.ciphertext === 'string') {
    return { kind: 'encrypted', pubKeyHex, envelope: parseEnvelope(o, pubKeyHex) };
  }
  if (typeof o.privKeyBase64 === 'string') {
    return { kind: 'clear', pubKeyHex, seed: seedFromClear(pubKeyHex, o.privKeyBase64) };
  }
  throw new IdentityError('that is not an identity file.');
}

// ---------------------------------------------------------------------------

/** Validate an encrypted file's structure into an Envelope; open checks the rest. */
function parseEnvelope(o: Record<string, unknown>, pubKeyHex: string): Envelope {
  if (o.version !== ENVELOPE_VERSION) {
    throw new IdentityError('the file is an identity version this client does not read.');
  }
  const kdf = o.kdf as Record<string, unknown> | undefined;
  if (
    !kdf ||
    kdf.name !== 'scrypt' ||
    typeof kdf.salt !== 'string' ||
    typeof kdf.N !== 'number' ||
    typeof kdf.r !== 'number' ||
    typeof kdf.p !== 'number'
  ) {
    throw new IdentityError('the file has no scrypt parameters.');
  }
  const cipher = o.cipher as Record<string, unknown> | undefined;
  if (!cipher || cipher.name !== 'chacha20-poly1305' || typeof cipher.nonce !== 'string') {
    throw new IdentityError('the file has no cipher parameters.');
  }
  return {
    version: ENVELOPE_VERSION,
    pubKeyHex,
    kdf: { name: 'scrypt', salt: kdf.salt, N: kdf.N, r: kdf.r, p: kdf.p },
    cipher: { name: 'chacha20-poly1305', nonce: cipher.nonce },
    ciphertext: o.ciphertext as string,
  };
}

/** The clear shape's three refusals — a wrong length, a wrong prefix, a key the
 *  seed does not produce (WEB_INTERFACE → The identity module, the Import row). */
function seedFromClear(pubKeyHex: string, privKeyBase64: string): Uint8Array {
  let der: Uint8Array;
  try {
    der = base64ToBytes(privKeyBase64);
  } catch {
    throw new IdentityError('the private key is not valid base64.');
  }
  if (der.length !== 48) {
    throw new IdentityError('the private key is not a 48-byte PKCS8 key.');
  }
  if (toHex(der.subarray(0, 16)) !== PKCS8_PREFIX_HEX) {
    throw new IdentityError('the private key is not an Ed25519 PKCS8 key.');
  }
  const seed = new Uint8Array(der.subarray(16));
  if (toHex(ed25519.getPublicKey(seed)) !== pubKeyHex) {
    throw new IdentityError('the file names a public key its private key does not produce.');
  }
  return seed;
}

function requireHex(v: unknown, what: string): string {
  if (typeof v !== 'string' || !HEX.test(v)) {
    throw new IdentityError(`the file's ${what} is not valid hex.`);
  }
  return v;
}

// Hex and base64 without a Node `Buffer`: the client holds no Node global. atob and
// btoa are in the DOM lib and present under vitest too. Identity code shares these.

export function toHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

export function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
