// The node's identity — one Ed25519 key in two spellings (`MESH_INTERFACE → Identity`):
// the 64-lowercase-hex Notis spelling, and the libp2p peer id whose identity-multihash
// digest is the protobuf-encoded Ed25519 public key. The key file is `KeyPair.secretKey`,
// 48 bytes, created mode 0600 on first start, refused at any other length.

import type { KeyPair } from '@dagsocial/types';
import type { PeerId, PrivateKey } from '@libp2p/interface';

export class MeshKeyError extends Error {
  override readonly name = 'MeshKeyError';
}

export interface NodeKey {
  readonly keyPair: KeyPair;
  readonly notisId: string;
  readonly privateKey: PrivateKey;
  readonly peerId: PeerId;
}

export function nodeKeyFromKeyPair(_kp: KeyPair): NodeKey {
  throw new Error('not implemented yet');
}

export async function loadOrCreateNodeKey(_path: string): Promise<NodeKey> {
  throw new Error('not implemented yet');
}

export function peerIdFromNotisId(_notisId: string): PeerId {
  throw new Error('not implemented yet');
}

export function notisIdFromPeerId(_peerId: PeerId): string {
  throw new Error('not implemented yet');
}
