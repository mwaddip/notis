import type { UtxoTransaction } from '@dagsocial/types';
import type { FaucetConfig } from './config.js';
import { InsufficientFundsError, checkRecipient, signAndRender } from './tx.js';
import type { BoxRef, BuiltTx } from './tx.js';

/**
 * Build and sign an invite: `karma → karma + bond`.
 *
 * ⛔ **The bond IS the request** — the block's settlement grants the bond's own
 * value to its `inviteePublicKey`, one bond one grant, so this transaction is
 * the whole of what the faucet sends (ARCHITECTURE → Invite System).
 *
 * The karma change output is emitted iff the selected inputs' sum exceeds the
 * bond — an exact spend produces the bond alone (TYPES_INTERFACE → Box value
 * domain).
 *
 * ⛔ **The drained verdict is the server's**, read from the karma listing's
 * `effective` (NODE_INTERFACE → Faucet → "Every other answer is the service's
 * own or the node's, never one dressed as the other."); the builder only
 * refuses when the owner's two karma boxes cannot cover the bond at all
 * (→ Karma transition rules → "An identity holds at most two karma boxes").
 */
export function buildInviteTx(
  cfg: FaucetConfig,
  boxes: readonly BoxRef[],
  inviteeHex: string,
  height: number,
  protocolVersion: number,
): BuiltTx {
  checkRecipient(cfg, inviteeHex, 'invitee');

  const selected = selectKarmaInputs(boxes, cfg.bondAmount);
  const selectedTotal = selected.reduce((sum, b) => sum + b.value, 0n);
  const changeValue = selectedTotal - cfg.bondAmount;

  // Candidates: no id and no provenance. `computeTxId` hashes outputs through
  // `canonicalBoxBytes`, which encodes neither, so attaching them would invent
  // fields the signature does not cover.
  //
  // The change output is unmarked — a user transaction may not write `income`
  // (NODE_INTERFACE → Karma transition rules → "An identity holds at most two karma boxes").
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
    // The era the node reported, never a constant of this build — a client signs
    // the era the node reports (WEB_INTERFACE → Invariants).
    protocolVersion,
  };

  return signAndRender(cfg, tx);
}

/**
 * The invite's karma inputs: the owner's own box, their own box beside their
 * income box, or — when they hold no own box — the income box alone.
 *
 * NODE_INTERFACE → Karma transition rules → "An identity holds at most two karma boxes"
 */
function selectKarmaInputs(boxes: readonly BoxRef[], bond: bigint): readonly BoxRef[] {
  const own = boxes.filter((b) => b.income !== true);
  const incomeBoxes = boxes.filter((b) => b.income === true);
  if (own.length > 1) {
    throw new Error(`the owner holds ${own.length} own karma boxes, at most one is allowed`);
  }
  if (incomeBoxes.length > 1) {
    throw new Error(`the owner holds ${incomeBoxes.length} income karma boxes, at most one is allowed`);
  }
  const ownBox = own[0];
  const incomeBox = incomeBoxes[0];
  if (ownBox !== undefined && ownBox.value >= bond) {
    return [ownBox];
  }
  if (ownBox !== undefined && incomeBox !== undefined && ownBox.value + incomeBox.value >= bond) {
    return [ownBox, incomeBox];
  }
  if (ownBox === undefined && incomeBox !== undefined && incomeBox.value >= bond) {
    return [incomeBox];
  }
  // The pair cannot cover the bond. The outer drained check catches this, so
  // the throw here guards selection from a boxes array that would smuggle a
  // short spend past that gate — the owner's `held` as the pending view has
  // left it is the single source of truth.
  throw new InsufficientFundsError(
    `insufficient karma: the owner's boxes total ${boxes.reduce((s, b) => s + b.value, 0n)} and cannot cover the bond ${bond}`,
  );
}
