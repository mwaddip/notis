import { selectBoxes } from '@dagsocial/types';
import type { UtxoTransaction } from '@dagsocial/types';
import type { Identity } from '../identities.js';
import { signAndRender, type BoxRef, type BuiltTx } from './render.js';

export function buildInviteTx(
  faucet: Identity,
  boxes: BoxRef[],
  invitee: Identity,
  bondAmount: bigint,
  height: number,
  protocolVersion: number,
): BuiltTx {
  const sorted = [...boxes].sort((a, b) => (b.value > a.value ? 1 : b.value < a.value ? -1 : 0));
  const selected = selectBoxes(sorted, bondAmount);
  const selectedTotal = selected.reduce((sum, b) => sum + b.value, 0n);
  const changeValue = selectedTotal - bondAmount;

  const owner = Buffer.from(faucet.publicKeyHex, 'hex');
  const outputs: UtxoTransaction['outputs'] = [];
  if (changeValue > 0n) {
    outputs.push({ boxType: 'karma', value: changeValue, createdAtBlock: height, owner });
  }
  outputs.push({
    boxType: 'bond',
    value: bondAmount,
    createdAtBlock: height,
    inviterId: owner,
    inviteePublicKey: Buffer.from(invitee.publicKeyHex, 'hex'),
  });

  const tx: UtxoTransaction = {
    inputs: selected.map((b) => b.boxId),
    outputs,
    signatures: {},
    protocolVersion,
  };

  return signAndRender(faucet, tx);
}
