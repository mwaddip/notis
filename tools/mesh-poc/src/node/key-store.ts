// The node's key file (`MESH_INTERFACE → Identity`): `KeyPair.secretKey`, 48 bytes,
// created mode 0600 on first start, refused at any other length and never overwritten.
// Node-only because it reads and writes a file; `MESH_INTERFACE → Place in the
// workspace` keeps every path that touches `node:` under `src/node/`.

import { readFile, writeFile } from 'node:fs/promises';
import { ed25519 } from '@noble/curves/ed25519.js';
import { ED25519_PKCS8_PREFIX, hexToBytes } from '@dagsocial/types';
import { MeshKeyError, nodeKeyFromKeyPair } from '../identity.js';
import type { NodeKey } from '../identity.js';

const PKCS8_PREFIX_BYTES = hexToBytes(ED25519_PKCS8_PREFIX);
const PKCS8_PREFIX_LEN = PKCS8_PREFIX_BYTES.length;   // 16
const SECRET_KEY_LEN = PKCS8_PREFIX_LEN + 32;         // 48

export async function loadOrCreateNodeKey(path: string): Promise<NodeKey> {
  let secretKey: Uint8Array;
  try {
    const buf = await readFile(path);
    secretKey = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    if (secretKey.length !== SECRET_KEY_LEN) {
      throw new MeshKeyError(`${path}: ${secretKey.length} bytes, must be ${SECRET_KEY_LEN}`);
    }
  } catch (err) {
    if (err instanceof MeshKeyError) throw err;
    const code = (err as { code?: string }).code;
    if (code !== 'ENOENT') {
      throw new MeshKeyError(`${path}: ${(err as Error).message}`);
    }
    // Fresh key: a random 32-byte seed through `@noble/curves`' Ed25519, laid out
    // as `TYPES_INTERFACE → Identity` says. Written with `wx` so a concurrent
    // starter never overwrites the first key.
    const seed = ed25519.utils.randomSecretKey();
    secretKey = new Uint8Array(SECRET_KEY_LEN);
    secretKey.set(PKCS8_PREFIX_BYTES, 0);
    secretKey.set(seed, PKCS8_PREFIX_LEN);
    await writeFile(path, secretKey, { mode: 0o600, flag: 'wx' });
  }
  const seed = secretKey.subarray(PKCS8_PREFIX_LEN);
  const publicKey = ed25519.getPublicKey(seed);
  return nodeKeyFromKeyPair({ publicKey, secretKey });
}
