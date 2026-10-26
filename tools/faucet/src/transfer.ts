import { selectBoxes } from '@dagsocial/types';
import type { UtxoTransaction } from '@dagsocial/types';
import type { FaucetConfig } from './config.js';
import { InsufficientFundsError, checkRecipient, signAndRender } from './tx.js';
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
  boxes: BoxRef[],
  toHex: string,
  height: number,
  protocolVersion: number,
): BuiltTx {
  checkRecipient(cfg, toHex, 'recipient');

  // NODE_INTERFACE → Faucet → "Every other answer is the service's own or the
  // node's, never one dressed as the other." — for a credit grant, 503 is one
  // whose first page of the pending view cannot cover it; the throw rides
  // `relay` to that status.
  const total = boxes.reduce((sum, b) => sum + b.value, 0n);
  if (total < cfg.creditAmount) {
    throw new InsufficientFundsError(
      `insufficient credits: the grant is ${cfg.creditAmount}, the faucet holds ${total}`,
    );
  }

  const selected = selectBoxes(boxes, cfg.creditAmount);
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
    // The era the node reported, never a constant of this build — a client signs
    // the era the node reports (WEB_INTERFACE → Invariants).
    protocolVersion,
  };

  // The payment is `outputs[0]`; change (when present) is `outputs[1]`. Its id
  // rides on `BuiltTx.payment`, derived by `signAndRender` from the same output
  // the signature covers (TYPES_INTERFACE → BoxId).
  return signAndRender(cfg, tx, 0);
}
