import { createHash, sign, createPrivateKey } from 'crypto';
import { leafHash, buildMerkleRoot } from '@dagsocial/types';
import type { Identity } from '../identities.js';

export interface PruneIntentJson {
  rootPostHash: string;
  authorId: string;
  subtreeMerkleRoot: string;
  subtreePostIds: string[];
  signature: string;
}

export function buildPruneIntent(
  author: Identity,
  rootPostHash: string,
  subtreePostIds: string[],
): PruneIntentJson {
  const sorted = [...subtreePostIds].sort();
  const leaves = sorted.map((id) => leafHash('stump', Buffer.from(id, 'hex')));
  const merkleRoot = buildMerkleRoot(leaves);

  const preimage = createHash('blake2b512')
    .update(rootPostHash)
    .update(merkleRoot)
    .digest()
    .subarray(0, 32);

  const privKey = createPrivateKey({ key: author.secretKey, format: 'der', type: 'pkcs8' });
  const sig = sign(null, preimage, privKey);

  return {
    rootPostHash,
    authorId: author.publicKeyHex,
    subtreeMerkleRoot: Buffer.from(merkleRoot).toString('hex'),
    subtreePostIds: sorted,
    signature: Buffer.from(sig).toString('hex'),
  };
}
