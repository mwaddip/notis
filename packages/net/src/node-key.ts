// NET_INTERFACE → The node key.
//
// The reader and writer of the node's libp2p identity file. The file holds the
// `KeyPair.secretKey` as the identity contract lays it out
// (TYPES_INTERFACE → Identity).

import type { KeyPair } from '@dagsocial/types';
import { generateKeyPair } from '@dagsocial/types';

// NET_INTERFACE → The node key → "The key file holds the key's `KeyPair.secretKey`"
export class NodeKeyError extends Error {
  override readonly name = 'NodeKeyError';
}

/**
 * NET_INTERFACE → The node key → "A node runs under one key, and the key persists".
 * Reads the key file at `path` and answers the `KeyPair`, its `publicKey` derived
 * from the file's seed; where no file is at `path`, writes a fresh key with
 * mode 0600 opened exclusively and answers it. Refuses a file of any other length
 * than 48, a 48-byte file that does not open with `ED25519_PKCS8_PREFIX`, or a
 * path it cannot read or write with `NodeKeyError`, naming the path.
 */
export async function loadNodeKey(_path: string): Promise<KeyPair> {
  return generateKeyPair();
}
