import { selectBoxes, PROTOCOL_VERSION, VOUCH_KARMA_AMOUNT } from '@dagsocial/types';
import type { UtxoTransaction } from '@dagsocial/types';
import type { Identity } from '../identities.js';
import { signAndRender, type BoxRef, type BuiltTx } from './render.js';

export function buildVouchTx(
  voucher: Identity,
  boxes: BoxRef[],
  target: Identity,
  height: number,
): BuiltTx {
  const sorted = [...boxes].sort((a, b) => (b.value > a.value ? 1 : b.value < a.value ? -1 : 0));
  const selected = selectBoxes(sorted, VOUCH_KARMA_AMOUNT);
  const selectedTotal = selected.reduce((sum, b) => sum + b.value, 0n);
  const changeValue = selectedTotal - VOUCH_KARMA_AMOUNT;

  const owner = Buffer.from(voucher.publicKeyHex, 'hex');
  const tx: UtxoTransaction = {
    inputs: selected.map((b) => b.boxId),
    outputs: [
      { boxType: 'karma', value: changeValue, createdAtBlock: height, owner },
      {
        boxType: 'vouch',
        value: VOUCH_KARMA_AMOUNT,
        createdAtBlock: height,
        voucherId: owner,
        targetId: Buffer.from(target.publicKeyHex, 'hex'),
      },
    ],
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
  };

  return signAndRender(voucher, tx);
}

export function buildUnvouchTx(
  voucher: Identity,
  vouchBoxId: string,
  vouchValue: bigint,
  vouchCreatedAtBlock: number,
  height: number,
  vouchCooldownBlocks: number,
): BuiltTx {
  const owner = Buffer.from(voucher.publicKeyHex, 'hex');
  const tx: UtxoTransaction = {
    inputs: [vouchBoxId],
    outputs: [
      {
        boxType: 'vouch_escrow',
        value: vouchValue,
        createdAtBlock: height,
        owner,
        releaseAtBlock: vouchCreatedAtBlock + vouchCooldownBlocks,
      },
    ],
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
  };

  return signAndRender(voucher, tx);
}
