import { selectBoxes, PROTOCOL_VERSION } from '@dagsocial/types';
import type { UtxoTransaction } from '@dagsocial/types';
import type { FaucetConfig } from './config.js';
import { InsufficientFundsError, checkRecipient, signAndRender, valueDescending } from './tx.js';
import type { BoxRef, BuiltTx } from './tx.js';

/**
 * Build and sign a credit transfer.
 *
 * ⛔ **Credits are tradeable, so this is an ordinary owner-signed transfer and
 * no rule governs it beyond conservation.** Karma cannot take this path at all
 * (NODE_INTERFACE → Karma transition rules), which is why the two endpoints do
 * different things rather than sharing one builder.
 *
 * A credit transition requires no output back to the input's owner, so an exact
 * spend emits the payment alone rather than a zero-value change box.
 */
export function buildCreditTransferTx(
  cfg: FaucetConfig,
  boxes: readonly BoxRef[],
  toHex: string,
  height: number,
): BuiltTx {
  checkRecipient(cfg, toHex, 'recipient');

  const total = boxes.reduce((sum, b) => sum + b.value, 0n);
  if (total < cfg.creditAmount) {
    throw new InsufficientFundsError(
      `insufficient credits: the grant is ${cfg.creditAmount}, the faucet holds ${total}`,
    );
  }

  const selected = selectBoxes(valueDescending(boxes), cfg.creditAmount);
  const selectedTotal = selected.reduce((sum, b) => sum + b.value, 0n);
  const changeValue = selectedTotal - cfg.creditAmount;

  const owner = Buffer.from(cfg.publicKeyHex, 'hex');
  const outputs: UtxoTransaction['outputs'] = [
    { boxType: 'credit', value: cfg.creditAmount, createdAtBlock: height, owner: Buffer.from(toHex, 'hex') },
  ];
  if (changeValue > 0n) {
    outputs.push({ boxType: 'credit', value: changeValue, createdAtBlock: height, owner });
  }

  const tx: UtxoTransaction = {
    inputs: selected.map((b) => b.boxId),
    outputs,
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
  };

  return signAndRender(cfg, tx, changeValue > 0n ? 1 : null);
}
