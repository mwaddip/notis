import { USERNAME_BURN_PRICE } from '@dagsocial/types';
import type { UtxoTransaction } from '@dagsocial/types';
import type { Identity } from '../identities.js';
import { signAndRender, type BoxRef, type BuiltTx } from './render.js';

export function buildBurnTx(
  holder: Identity,
  karmaBoxes: BoxRef[],
  usernameBoxId: string,
  height: number,
  protocolVersion: number,
): BuiltTx {
  const karmaTotal = karmaBoxes.reduce((sum, b) => sum + b.value, 0n);
  const changeValue = karmaTotal - USERNAME_BURN_PRICE;
  const owner = Buffer.from(holder.publicKeyHex, 'hex');

  const outputs: UtxoTransaction['outputs'] = [];
  if (changeValue > 0n) {
    outputs.push({ boxType: 'karma', value: changeValue, createdAtBlock: height, owner });
  }
  outputs.push({ boxType: 'karma_price', value: USERNAME_BURN_PRICE, createdAtBlock: height });

  const tx: UtxoTransaction = {
    inputs: [...karmaBoxes.map((b) => b.boxId), usernameBoxId],
    outputs,
    signatures: {},
    protocolVersion,
  };

  return signAndRender(holder, tx);
}
