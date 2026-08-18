import { selectBoxes, PROTOCOL_VERSION } from '@dagsocial/types';
import type { UtxoTransaction } from '@dagsocial/types';
import type { FaucetConfig } from './config.js';
import { InsufficientFundsError, checkRecipient, signAndRender, valueDescending } from './tx.js';
import type { BoxRef, BuiltTx } from './tx.js';

/**
 * Build and sign an invite: `karma → karma + bond`.
 *
 * ⛔ **The bond IS the request** — the block's settlement grants the bond's own
 * value to its `inviteePublicKey`, one bond one grant, so this transaction is
 * the whole of what the faucet sends (ARCHITECTURE → Invite System).
 *
 * ⛔ **The karma change output is emitted whatever it holds.** A karma
 * transition must produce at least one karma output (NODE_INTERFACE → Karma
 * transition rules), so an exact spend still carries a zero-value change box —
 * and that box is index 0, which is where the pending chain picks up.
 */
export function buildInviteTx(
  cfg: FaucetConfig,
  boxes: readonly BoxRef[],
  inviteeHex: string,
  height: number,
): BuiltTx {
  checkRecipient(cfg, inviteeHex, 'invitee');

  const total = boxes.reduce((sum, b) => sum + b.value, 0n);
  if (total < cfg.bondAmount) {
    throw new InsufficientFundsError(
      `insufficient karma: the bond is ${cfg.bondAmount}, the faucet holds ${total}`,
    );
  }

  const selected = selectBoxes(valueDescending(boxes), cfg.bondAmount);
  const selectedTotal = selected.reduce((sum, b) => sum + b.value, 0n);
  const changeValue = selectedTotal - cfg.bondAmount;

  // Candidates: no id and no provenance. `computeTxId` hashes outputs through
  // `canonicalBoxBytes`, which encodes neither, so attaching them would invent
  // fields the signature does not cover.
  const owner = Buffer.from(cfg.publicKeyHex, 'hex');
  const tx: UtxoTransaction = {
    inputs: selected.map((b) => b.boxId),
    outputs: [
      { boxType: 'karma', value: changeValue, createdAtBlock: height, owner },
      {
        boxType: 'bond',
        value: cfg.bondAmount,
        createdAtBlock: height,
        inviterId: owner,
        inviteePublicKey: Buffer.from(inviteeHex, 'hex'),
      },
    ],
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
  };

  // The karma change is output 0, and the pending chain picks up from it.
  return signAndRender(cfg, tx, 0);
}
