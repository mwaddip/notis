// NET_INTERFACE → The node key.
//
// The reader and writer of the node's libp2p identity file. The file holds the
// `KeyPair.secretKey` as the identity contract lays it out
// (TYPES_INTERFACE → Identity).

import { readFile, writeFile } from 'node:fs/promises';
import { generateKeyPairFromSeed } from '@libp2p/crypto/keys';
import { ED25519_PKCS8_PREFIX, hexToBytes } from '@dagsocial/types';
import type { KeyPair } from '@dagsocial/types';
import { generateKeyPair } from '@dagsocial/types';

// NET_INTERFACE → The node key → "The key file holds the key's `KeyPair.secretKey`"
export class NodeKeyError extends Error {
  override readonly name = 'NodeKeyError';
}

// TYPES_INTERFACE → Identity. 16 bytes of RFC 8410 PKCS8 prefix, then 32 bytes
// of seed; the whole secretKey is 48 bytes.
const PKCS8_PREFIX_BYTES = hexToBytes(ED25519_PKCS8_PREFIX);
const PKCS8_PREFIX_LEN = PKCS8_PREFIX_BYTES.length;
const SECRET_KEY_LEN = PKCS8_PREFIX_LEN + 32;

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// NET_INTERFACE → The node key → "The key file holds the key's `KeyPair.secretKey`":
// the key file is the 48-byte secretKey; the publicKey is derived from its seed.
export async function derivePublicKeyFromSeed(seed: Uint8Array): Promise<Uint8Array> {
  const pk = await generateKeyPairFromSeed('Ed25519', seed);
  return pk.publicKey.raw;
}

/**
 * NET_INTERFACE → The node key → "A node runs under one key, and the key persists".
 * Reads the key file at `path` and answers the `KeyPair`, its `publicKey` derived
 * from the file's seed; where no file is at `path`, writes a fresh key with
 * mode 0600 opened exclusively and answers it. Refuses a file of any other length
 * than 48, a 48-byte file that does not open with `ED25519_PKCS8_PREFIX`, or a
 * path it cannot read or write with `NodeKeyError`, naming the path.
 */
export async function loadNodeKey(path: string): Promise<KeyPair> {
  let secretKey: Uint8Array;
  try {
    const buf = await readFile(path);
    secretKey = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      const fresh = generateKeyPair();
      try {
        await writeFile(path, fresh.secretKey, { mode: 0o600, flag: 'wx' });
      } catch (werr) {
        throw new NodeKeyError(`${path}: ${(werr as Error).message}`);
      }
      return fresh;
    }
    throw new NodeKeyError(`${path}: ${(err as Error).message}`);
  }
  if (secretKey.length !== SECRET_KEY_LEN) {
    throw new NodeKeyError(
      `${path}: secretKey length ${secretKey.length}, must be ${SECRET_KEY_LEN}`,
    );
  }
  if (!bytesEqual(secretKey.subarray(0, PKCS8_PREFIX_LEN), PKCS8_PREFIX_BYTES)) {
    throw new NodeKeyError(
      `${path}: secretKey does not carry the RFC 8410 PKCS8 prefix`,
    );
  }
  const seed = secretKey.subarray(PKCS8_PREFIX_LEN);
  const publicKey = await derivePublicKeyFromSeed(seed);
  return { publicKey, secretKey };
}
