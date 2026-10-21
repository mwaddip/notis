import {
  membershipBar,
  KARMA_MINIMUM,
} from '@dagsocial/types';
import type { BondBox, KarmaBox, UtxoTransaction } from '@dagsocial/types';
import { materializeOutput, validateTx } from '@dagsocial/consensus';
import { admitWriteTx } from './admit-tx.js';
import { availableInvites } from './invites-available.js';
import type { UtxoEngineDeps } from '@dagsocial/consensus';
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

  // ---- 0. The inviter is a root, or a member with an invite available ----
  // The number both the gate (MEMPOOL_INTERFACE → Correctness gates) and this
  // service read is `availableInvites`, one definition — a pure function the
  // service hands its `deps` reads and admission the store's.
  const inviterRecord = deps.getIdentityRecord(karmaInput.owner);
  const nr = deps.getNetworkRecord();
  const available = availableInvites(inviterRecord, nr.memberCount, deps.membershipBarMultiplier);
  if (available === 'no-record') {
    throw new ClientError('Inviter holds no identity record');
  }
  if (available === 'none') {
    throw new ClientError('Only a root or a member may invite');
  }
  if (typeof available === 'number' && available < 1) {
    const d = membershipBar(nr.memberCount, deps.membershipBarMultiplier);
    throw new ClientError(
      `No invites available (vouches: ${inviterRecord!.memberVouches}, ` +
      `D: ${d}, used: ${inviterRecord!.invitesUsed})`,
    );
  }

  // ---- 2. Verify outputs: exactly 1 bond, at most 1 karma, nothing else ----
  const karmaOutputs = tx.outputs.filter((o) => o.boxType === 'karma');
  const bondOutputs = tx.outputs.filter((o) => o.boxType === 'bond');

  if (bondOutputs.length !== 1 || karmaOutputs.length > 1 ||
      tx.outputs.length !== 1 + karmaOutputs.length) {
    throw new ClientError(
      'An invite requires exactly 1 bond and at most 1 karma output',
    );
  }

  // ---- 3. Verify the inviter can afford the bond above the floor ----
  //
  // An invite's bond is a karma spend of `bondValue`, which must leave the
  // floor standing (NODE_INTERFACE → Karma transition rules → "Only a post
  // spends the floor"; → "Engine inputs the rule needs"): the inviter's
  // `remaining = held − owed` must be at least `bondValue + KARMA_MINIMUM`.
  //
  // ⛔ **Against THIS invite's bond, not against a constant.** The inviter picks
  // the bond from the network's range, so a fixed threshold passes an inviter
  // who cannot afford the one they named — and the rejection then arrives from
  // conservation, which is the message this layer exists to replace.
  const bondValue = (bondOutputs[0] as BondBox).value;
  const inviterHeld = deps.getKarmaValue(karmaInput.owner);
  const inviterOwed = deps.getKarmaOwed(karmaInput.owner, currentBlockHeight);
  const inviterRemaining = inviterHeld - inviterOwed;
  if (inviterRemaining < bondValue + KARMA_MINIMUM) {
    throw new ClientError(
      `Insufficient karma to invite: this invite bonds ${bondValue} and ` +
      `the floor is ${KARMA_MINIMUM}, inviter holds ${inviterRemaining}`,
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

  // ---- 5. Admission (NODE_INTERFACE → Service Layer Architecture → "One
  //         function admits"). `expiresAtHeight` is this MEMPOOL ENTRY's
  //         expiry. The bond settles `INVITE_PROBATION_BLOCKS` after this
  //         block, so nothing about the invite itself stays open.
  const { txId, expiresAtHeight } = admitWriteTx(
    (t, h) => validateTx(deps, t, h),
    tx,
    currentBlockHeight,
    'Invalid invite transaction: ',
  );

  // ---- 6. Return result ----
  //
  // `txId` from the admit seam is `validateTx`'s own — the hash of the output
  // *candidates*, so attaching provenance first would feed provenance into
  // the very id it is derived from. `computeTxId` routes outputs through
  // `canonicalBoxBytes` and so does not observe provenance — which makes
  // getting this backwards silent rather than an error.

  // The id must equal what block application will store, so it is materialized
  // exactly the way that path materializes it; `tx` here is client-supplied
  // decoded JSON, so the strip-before-append in `materializeOutput` is
  // load-bearing.
  return {
    status: 'pending',
    txId,
    expiresAtHeight,
    bondBox: materializeOutput(bondOut, txId, tx.outputs.indexOf(bondOut)) as BondBox,
    tx,
  };
}
