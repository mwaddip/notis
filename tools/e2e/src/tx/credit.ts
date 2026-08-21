import { selectBoxes, PROTOCOL_VERSION } from '@dagsocial/types';
import type { UtxoTransaction } from '@dagsocial/types';
import type { Identity } from '../identities.js';
import { signAndRender, type BoxRef, type BuiltTx } from './render.js';

export function buildCreditTransferTx(
  sender: Identity,
  boxes: BoxRef[],
  recipient: Identity,
  amount: bigint,
  height: number,
): BuiltTx {
  const sorted = [...boxes].sort((a, b) => (b.value > a.value ? 1 : b.value < a.value ? -1 : 0));
  const selected = selectBoxes(sorted, amount);
  const selectedTotal = selected.reduce((sum, b) => sum + b.value, 0n);
  const changeValue = selectedTotal - amount;

  const senderKey = Buffer.from(sender.publicKeyHex, 'hex');
  const recipientKey = Buffer.from(recipient.publicKeyHex, 'hex');
  const outputs: UtxoTransaction['outputs'] = [
    { boxType: 'credit', value: amount, createdAtBlock: height, owner: recipientKey },
  ];
  if (changeValue > 0n) {
    outputs.push({
      boxType: 'credit',
      value: changeValue,
      createdAtBlock: height,
      owner: senderKey,
    });
  }

  const tx: UtxoTransaction = {
    inputs: selected.map((b) => b.boxId),
    outputs,
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
  };

  return signAndRender(sender, tx);
}
