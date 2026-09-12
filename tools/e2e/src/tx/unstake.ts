import type { UtxoTransaction } from '@dagsocial/types';
import type { Identity } from '../identities.js';
import { signAndRender, type BuiltTx } from './render.js';

// NODE_INTERFACE → Backer transition rules
export function buildUnstakeTx(
  owner: Identity,
  stakeBoxId: string,
  stakeWeight: bigint,
  unstakeWeight: bigint,
  height: number,
  protocolVersion: number,
): BuiltTx {
  const ownerBuf = Buffer.from(owner.publicKeyHex, 'hex');
  const remaining = stakeWeight - unstakeWeight;

  const outputs: UtxoTransaction['outputs'] = [
    { boxType: 'backer_unstake', value: 0n, owner: ownerBuf, weight: unstakeWeight, createdAtBlock: height },
  ];
  if (remaining > 0n) {
    outputs.push({ boxType: 'backer_stake', value: 0n, owner: ownerBuf, weight: remaining, createdAtBlock: height });
  }

  const tx: UtxoTransaction = {
    inputs: [stakeBoxId],
    outputs,
    signatures: {},
    protocolVersion,
  };

  return signAndRender(owner, tx);
}
