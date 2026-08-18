import {
  computeTxId,
  MEMPOOL_EXPIRY_BLOCKS,
} from '@dagsocial/types';
import type { BondBox, KarmaBox, UtxoTransaction } from '@dagsocial/types';
import { materializeOutput, validateTx } from './utxo-engine.js';
import { admitTx } from './admit-tx.js';
import type { UtxoEngineDeps } from './utxo-engine.js';
import { ClientError } from './client-error.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
//
// One step, and no secret in it (NODE_INTERFACE → Invites). The invitee shares
// their public key out of band; the inviter posts one transaction and the
// block's settlement grants the invitee their karma out of the pool.
//
// Every rule this enforces is a consensus rule `validateTx` also enforces — the
// service layer restates none of them. What it adds is the diagnosis: a client
// gets "that key is already an account" rather than "invalid transition".

/**
 * Create an invite. The client builds an inviter-signed transaction consuming a
 * KarmaBox and producing karma + bond outputs.
 *
 * ⛔ **The bond is the whole cost.** The invitee's grant equals the bond and
 * comes out of the karma pool at settlement, so the inviter never pays it twice
 * and the transaction conserves like any other (ARCHITECTURE → Invite System).
 *
 * The invite is **pending** until the next ordering block is confirmed.
 */
export function createInvite(
  deps: UtxoEngineDeps,
  tx: UtxoTransaction,
  currentBlockHeight: number,
): {
  status: 'pending';
  txId: string;
  expiresAtHeight: number;
  bondBox: BondBox;
  tx: UtxoTransaction;
} {
  // ---- 1. Extract the inviter from the consumed KarmaBox input ----
  const karmaInput = tx.inputs
    .map((id) => deps.getBox(id))
    .find((box): box is KarmaBox => box?.boxType === 'karma');
  if (!karmaInput) {
    throw new ClientError('No karma box input found in transaction');
  }

  // ---- 2. Verify outputs: exactly 1 karma + 1 bond ----
  const karmaOutputs = tx.outputs.filter((o) => o.boxType === 'karma');
  const bondOutputs = tx.outputs.filter((o) => o.boxType === 'bond');

  if (tx.outputs.length !== 2 || karmaOutputs.length !== 1 || bondOutputs.length !== 1) {
    throw new ClientError(
      'An invite requires exactly 2 outputs: 1 karma + 1 bond',
    );
  }

  // ---- 3. Verify the inviter can afford the bond ----
  //
  // The whole cost of an invite, and the network's only sybil price. Read as the
  // inviter's summed balance rather than off this transaction's inputs, so the
  // diagnosis is "you do not hold enough" rather than "this transaction does not
  // balance" — conservation says the latter either way.
  //
  // ⛔ **Against THIS invite's bond, not against a constant.** The inviter picks
  // the bond from the network's range, so a fixed threshold passes an inviter
  // who cannot afford the one they named — and the rejection then arrives from
  // conservation, which is the message this layer exists to replace.
  const bondValue = (bondOutputs[0] as BondBox).value;
  const inviterBalance = deps.getKarmaValue(karmaInput.owner);
  if (inviterBalance < bondValue) {
    throw new ClientError(
      `Insufficient karma to invite: this invite bonds ${bondValue}, ` +
      `inviter holds ${inviterBalance}`,
    );
  }

  // ---- 4. Verify the named key is not already an account ----
  //
  // Consensus-enforced in the invite transition; restated here for the
  // diagnosis, because "that key is already an account" is the one rejection a
  // well-formed client cannot predict from its own state.
  //
  // ⚠ **This check is a courtesy and is no longer sufficient on its own**, the
  // way the vouch balance gate is. A record-existence query cannot see a sibling
  // transaction in the same block naming the same key; the consensus rule "no
  // other bond in this block names this key" is block application's
  // (NODE_INTERFACE → Legal box transitions).
  const bondOut = bondOutputs[0] as BondBox;
  const inviteeRecord = deps.getIdentityRecord(bondOut.inviteePublicKey);
  if (inviteeRecord !== null) {
    throw new ClientError(
      `${Buffer.from(bondOut.inviteePublicKey).toString('hex')} is already an ` +
      `account; an invite may only name a key that is not one`,
    );
  }

  // ---- 5. Validate transaction (shape, conservation, authorization, transitions) ----
  const result = validateTx(deps, tx, currentBlockHeight);
  if (!result.valid) {
    throw new ClientError(`Invalid invite transaction: ${result.error}`);
  }

  // ---- 6. Insert into mempool ----
  //
  // `expiresAtHeight` is this MEMPOOL ENTRY's expiry. The bond settles
  // `INVITE_PROBATION_BLOCKS` after this block, so nothing about the invite
  // itself stays open.
  const expiresAtHeight = currentBlockHeight + MEMPOOL_EXPIRY_BLOCKS;
  admitTx(tx, expiresAtHeight);

  // ---- 7. Return result ----
  //
  // `txId` is computed FIRST, before any provenance is attached: it hashes the
  // output *candidates*, so attaching first would feed provenance into the very
  // id it is derived from. `computeTxId` routes outputs through
  // `canonicalBoxBytes` and so does not observe provenance — which makes getting
  // this backwards silent rather than an error.
  const txId = computeTxId(tx);

  // The id must equal what block application will store, so it is materialized
  // exactly the way that path materializes it; `tx` here is client-supplied
  // decoded CBOR, so the strip-before-append in `materializeOutput` is
  // load-bearing.
  return {
    status: 'pending',
    txId,
    expiresAtHeight,
    bondBox: materializeOutput(bondOut, txId, tx.outputs.indexOf(bondOut)) as BondBox,
    tx,
  };
}
