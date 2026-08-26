import { leafHash, buildMerkleRoot, PROTOCOL_VERSION } from '@dagsocial/types';
import type { UtxoTransaction } from '@dagsocial/types';
import type { Identity } from '../identities.js';
import { signAndRender, type BoxRef, type BuiltTx } from './render.js';

export function buildPruneTx(
  author: Identity,
  boxes: BoxRef[],
  rootPostHash: string,
  subtreePostIds: string[],
  height: number,
): BuiltTx {
  const totalValue = boxes.reduce((sum, b) => sum + b.value, 0n);
  const owner = Buffer.from(author.publicKeyHex, 'hex');

  const sortedIds = [...subtreePostIds].sort();
  const leaves = sortedIds.map((id) => leafHash('stump', Buffer.from(id, 'hex')));
  const merkleRoot = buildMerkleRoot(leaves);

  const tx: UtxoTransaction = {
    inputs: boxes.map((b) => b.boxId),
    outputs: [
      { boxType: 'karma', value: totalValue, createdAtBlock: height, owner },
    ],
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
    prune: {
      rootPostHash,
      subtreePostIds: sortedIds,
      subtreeMerkleRoot: merkleRoot,
    },
  };

  return signAndRender(author, tx);
}
