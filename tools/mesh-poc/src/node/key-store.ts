// The node's key file (`MESH_INTERFACE → Identity`): `KeyPair.secretKey`, 48 bytes,
// created mode 0600 on first start, refused at any other length and never overwritten.
// Node-only because it reads and writes a file (`MESH_INTERFACE → Place in the
// workspace`).

import { readFile, writeFile } from 'node:fs/promises';
import { ed25519 } from '@noble/curves/ed25519.js';
import { ED25519_PKCS8_PREFIX, hexToBytes } from '@dagsocial/types';
import { MeshKeyError, nodeKeyFromKeyPair, seedOfSecretKey } from '../identity.js';
import type { NodeKey } from '../identity.js';

const PKCS8_PREFIX_BYTES = hexToBytes(ED25519_PKCS8_PREFIX);
const SECRET_KEY_LEN = PKCS8_PREFIX_BYTES.length + 32;

export async function loadOrCreateNodeKey(path: string): Promise<NodeKey> {
  let secretKey: Uint8Array;
  let seed: Uint8Array;
  try {
    const buf = await readFile(path);
    secretKey = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    // `seedOfSecretKey` throws `MeshKeyError` on a wrong length or prefix — read
    // before any write, so a refused file stays as it was.
    seed = seedOfSecretKey(secretKey);
  } catch (err) {
    if (err instanceof MeshKeyError) throw err;
    if ((err as { code?: string }).code !== 'ENOENT') {
      throw new MeshKeyError(`${path}: ${(err as Error).message}`);
    }
    // Fresh key: a random 32-byte seed through `@noble/curves`' Ed25519, laid out
    // as `TYPES_INTERFACE → Identity` says. Written with `wx` so a concurrent
    // starter never overwrites the first key.
    seed = ed25519.utils.randomSecretKey();
    secretKey = new Uint8Array(SECRET_KEY_LEN);
    secretKey.set(PKCS8_PREFIX_BYTES, 0);
    secretKey.set(seed, PKCS8_PREFIX_BYTES.length);
    await writeFile(path, secretKey, { mode: 0o600, flag: 'wx' });
  }
  const publicKey = ed25519.getPublicKey(seed);
  return nodeKeyFromKeyPair({ publicKey, secretKey });
}
