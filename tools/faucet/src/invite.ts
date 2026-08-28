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
 * The karma change output is emitted iff `changeValue > 0n` — an exact spend
 * produces the bond alone (TYPES_INTERFACE → Box value domain).
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
  const outputs: UtxoTransaction['outputs'] = [];
  if (changeValue > 0n) {
    outputs.push({ boxType: 'karma', value: changeValue, createdAtBlock: height, owner });
  }
  outputs.push({
    boxType: 'bond',
    value: cfg.bondAmount,
    createdAtBlock: height,
    inviterId: owner,
    inviteePublicKey: Buffer.from(inviteeHex, 'hex'),
  });
  const tx: UtxoTransaction = {
    inputs: selected.map((b) => b.boxId),
    outputs,
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
  };

  return signAndRender(cfg, tx, changeValue > 0n ? 0 : null);
}
