// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { scryptSync, createDecipheriv } from 'node:crypto';
import { generateKeyPair } from '@dagsocial/types';
import {
  seal,
  open,
  parseFile,
  toHex,
  hexToBytes,
  bytesToBase64,
  ENVELOPE_VERSION,
  SCRYPT_N,
  SCRYPT_R,
  SCRYPT_P,
  type Envelope,
  type ScryptParams,
} from '../src/identity/envelope';

// The envelope codec — WEB_INTERFACE → The identity module. seal→open round trips
// the seed; a wrong passphrase, an edited header and a flipped byte are each
// refused; parseFile distinguishes the clear and encrypted shapes; and a Node
// stdlib decrypt recovers a seed the codec sealed, the "any Node tool opens it"
// claim by a second implementation. The seal runs under happy-dom's getRandomValues
// with no Web Crypto reached.

// A small cost keeps the suite fast; one case runs at the production N and prints
// the cost. The parameters travel in the envelope, so open reads whatever seal wrote.
const SMALL: ScryptParams = { N: 1024, r: 8, p: 1 };

function freshKey(): { seed: Uint8Array; pubKeyHex: string; privKeyBase64: string } {
  const kp = generateKeyPair();
  const der = kp.secretKey; // 48-byte PKCS8 DER: the 16-byte prefix then the seed
  return {
    seed: new Uint8Array(der.subarray(16)),
    pubKeyHex: toHex(kp.publicKey),
    privKeyBase64: bytesToBase64(der),
  };
}

function flipHexChar(hex: string, i = 0): string {
  const flipped = hex[i] === '0' ? '1' : '0';
  return hex.slice(0, i) + flipped + hex.slice(i + 1);
}

describe('envelope — seal and open', () => {
  it('seal → open round trips the 32-byte seed', async () => {
    const { seed, pubKeyHex } = freshKey();
    const env = await seal(seed, pubKeyHex, 'a correct horse', SMALL);
    expect(env.version).toBe(ENVELOPE_VERSION);
    expect(env.pubKeyHex).toBe(pubKeyHex);
    expect(env.kdf).toEqual({ name: 'scrypt', salt: expect.any(String), N: 1024, r: 8, p: 1 });
    expect(env.cipher).toEqual({ name: 'chacha20-poly1305', nonce: expect.any(String) });
    // 32-byte seed ‖ 16-byte tag → 48 bytes → 96 hex.
    expect(env.ciphertext).toHaveLength(96);
    expect(toHex(await open(env, 'a correct horse'))).toBe(toHex(seed));
  });

  it('a fresh salt and nonce every seal', async () => {
    const { seed, pubKeyHex } = freshKey();
    const a = await seal(seed, pubKeyHex, 'pw', SMALL);
    const b = await seal(seed, pubKeyHex, 'pw', SMALL);
    expect(a.kdf.salt).not.toBe(b.kdf.salt);
    expect(a.cipher.nonce).not.toBe(b.cipher.nonce);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it('a wrong passphrase is refused', async () => {
    const { seed, pubKeyHex } = freshKey();
    const env = await seal(seed, pubKeyHex, 'right', SMALL);
    await expect(open(env, 'wrong')).rejects.toThrow(/does not open this key/);
  });

  it('an edited pubKeyHex in the header (the AAD) is refused', async () => {
    const { seed, pubKeyHex } = freshKey();
    const env = await seal(seed, pubKeyHex, 'pw', SMALL);
    const other = freshKey().pubKeyHex;
    await expect(open({ ...env, pubKeyHex: other }, 'pw')).rejects.toThrow(/does not open this key/);
  });

  it('a flipped ciphertext byte is refused', async () => {
    const { seed, pubKeyHex } = freshKey();
    const env = await seal(seed, pubKeyHex, 'pw', SMALL);
    await expect(open({ ...env, ciphertext: flipHexChar(env.ciphertext) }, 'pw')).rejects.toThrow(
      /does not open this key/,
    );
  });

  it('seal refuses a seed that is not 32 bytes and a bad public key', async () => {
    const { pubKeyHex } = freshKey();
    await expect(seal(new Uint8Array(31), pubKeyHex, 'pw', SMALL)).rejects.toThrow(/32 bytes/);
    await expect(seal(new Uint8Array(32), 'zz', 'pw', SMALL)).rejects.toThrow(/64 hex/);
  });
});

describe('envelope — parseFile distinguishes the shapes', () => {
  it('an encrypted file parses to its envelope', async () => {
    const { seed, pubKeyHex } = freshKey();
    const env = await seal(seed, pubKeyHex, 'pw', SMALL);
    const parsed = parseFile(JSON.stringify(env));
    expect(parsed.kind).toBe('encrypted');
    expect(parsed.pubKeyHex).toBe(pubKeyHex);
    if (parsed.kind !== 'encrypted') throw new Error('unreachable');
    expect(toHex(await open(parsed.envelope, 'pw'))).toBe(toHex(seed));
  });

  it('a clear file parses to its seed', () => {
    const { seed, pubKeyHex, privKeyBase64 } = freshKey();
    const parsed = parseFile(JSON.stringify({ pubKeyHex, privKeyBase64 }));
    expect(parsed.kind).toBe('clear');
    expect(parsed.pubKeyHex).toBe(pubKeyHex);
    if (parsed.kind !== 'clear') throw new Error('unreachable');
    expect(toHex(parsed.seed)).toBe(toHex(seed));
  });

  it('a clear file is refused for a wrong length, a wrong prefix, a mismatched key', () => {
    const { pubKeyHex, privKeyBase64 } = freshKey();
    const der = Array.from(atob(privKeyBase64), (c) => c.charCodeAt(0));

    // 47 bytes — not a PKCS8 Ed25519 key.
    const short = bytesToBase64(new Uint8Array(der.slice(0, 47)));
    expect(() => parseFile(JSON.stringify({ pubKeyHex, privKeyBase64: short }))).toThrow(/48-byte/);

    // 48 bytes, the RFC 8410 prefix's first byte corrupted.
    const badPrefixBytes = new Uint8Array(der);
    badPrefixBytes[0] = 0xff;
    const badPrefix = bytesToBase64(badPrefixBytes);
    expect(() => parseFile(JSON.stringify({ pubKeyHex, privKeyBase64: badPrefix }))).toThrow(/PKCS8/);

    // A valid seed whose named public key is a different keypair's.
    const other = freshKey().pubKeyHex;
    expect(() => parseFile(JSON.stringify({ pubKeyHex: other, privKeyBase64 }))).toThrow(/does not produce/);
  });

  it('parseFile refuses non-JSON, a non-object, a missing key, and neither shape', () => {
    expect(() => parseFile('not json at all')).toThrow(/valid identity file/);
    expect(() => parseFile('123')).toThrow(/identity file/);
    expect(() => parseFile(JSON.stringify({ pubKeyHex: 'zz' }))).toThrow(/valid public key/);
    expect(() => parseFile(JSON.stringify({ pubKeyHex: 'ab'.repeat(32) }))).toThrow(/not an identity file/);
  });

  it('parseFile refuses an envelope of an unread version and one missing its parameters', async () => {
    const { seed, pubKeyHex } = freshKey();
    const env = await seal(seed, pubKeyHex, 'pw', SMALL);
    expect(() => parseFile(JSON.stringify({ ...env, version: 2 }))).toThrow(/version this client does not read/);
    const noKdf = { ...env } as Record<string, unknown>;
    delete noKdf.kdf;
    expect(() => parseFile(JSON.stringify(noKdf))).toThrow(/scrypt parameters/);
    const noCipher = { ...env } as Record<string, unknown>;
    delete noCipher.cipher;
    expect(() => parseFile(JSON.stringify(noCipher))).toThrow(/cipher parameters/);
  });
});

describe('envelope — interop and no Web Crypto', () => {
  it('a Node stdlib decrypt of a module-sealed envelope recovers the seed', async () => {
    const { seed, pubKeyHex } = freshKey();
    const passphrase = 'a correct horse battery staple';
    const env: Envelope = await seal(seed, pubKeyHex, passphrase, SMALL);

    // scryptSync over the same UTF-8 bytes and salt → the same 32-byte key. Node's
    // default maxmem is 32 MiB; raise it to fit the cost the envelope names.
    const key = scryptSync(new TextEncoder().encode(passphrase), hexToBytes(env.kdf.salt), 32, {
      N: env.kdf.N,
      r: env.kdf.r,
      p: env.kdf.p,
      maxmem: 128 * env.kdf.N * env.kdf.r * 2,
    });
    const nonce = hexToBytes(env.cipher.nonce);
    const full = hexToBytes(env.ciphertext);
    // noble appends the 16-byte tag to the ciphertext; Node takes it separately.
    const body = full.subarray(0, full.length - 16);
    const tag = full.subarray(full.length - 16);
    const pub = hexToBytes(pubKeyHex);
    const ad = new Uint8Array(pub.length + 1);
    ad.set(pub, 0);
    ad[pub.length] = env.version;

    const decipher = createDecipheriv('chacha20-poly1305', key, nonce, { authTagLength: 16 });
    decipher.setAAD(ad, { plaintextLength: 32 });
    decipher.setAuthTag(tag);
    const head = decipher.update(body);
    const rest = decipher.final();
    const recovered = new Uint8Array(head.length + rest.length);
    recovered.set(head, 0);
    recovered.set(rest, head.length);
    expect(toHex(recovered)).toBe(toHex(seed));
  });

  it('seals and opens with crypto.subtle stubbed to throw — noble reaches no Web Crypto', async () => {
    const { seed, pubKeyHex } = freshKey();
    const cryptoObj = globalThis.crypto as unknown as Record<string, unknown>;
    const original = Object.getOwnPropertyDescriptor(cryptoObj, 'subtle');
    Object.defineProperty(cryptoObj, 'subtle', {
      configurable: true,
      get() {
        throw new Error('crypto.subtle was reached');
      },
    });
    try {
      const env = await seal(seed, pubKeyHex, 'pw', SMALL);
      expect(toHex(await open(env, 'pw'))).toBe(toHex(seed));
    } finally {
      if (original) Object.defineProperty(cryptoObj, 'subtle', original);
      else delete cryptoObj.subtle;
    }
  });

  it('derives at the production N — a cost paid once per unlock, printed here', async () => {
    const { seed, pubKeyHex } = freshKey();
    const t0 = performance.now();
    const env = await seal(seed, pubKeyHex, 'production cost', { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
    const ms = performance.now() - t0;
    expect(env.kdf.N).toBe(SCRYPT_N);
    expect(toHex(await open(env, 'production cost'))).toBe(toHex(seed));
    console.log(`scrypt seal at N=${SCRYPT_N} r=${SCRYPT_R} p=${SCRYPT_P}: ${Math.round(ms)}ms`);
  });
});
