import {
  computeTxId,
  INVITE_BOND_KARMA,
  INVITE_KARMA_AMOUNT,
  MEMPOOL_EXPIRY_BLOCKS,
} from '@dagsocial/types';
import type { InviteBox, BondBox, KarmaBox, UtxoTransaction } from '@dagsocial/types';
import { materializeOutput, validateTx } from './utxo-engine.js';
import { admitTx } from './admit-tx.js';
import type { UtxoEngineDeps } from './utxo-engine.js';
import { ClientError } from './client-error.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
//
// Two steps, not three, and no secret in any of them (NODE_INTERFACE →
// Invites). The invitee shares their public key out of band; from there each
// party acts under its own signature.
//
// Every rule these three enforce is a consensus rule `validateTx` also enforces
// — the service layer restates none of them. What it adds is the diagnosis: a
// client gets "no open invite names this key" rather than "input box not found".

/**
 * Create an invite. The client builds an inviter-signed transaction consuming a
 * KarmaBox and producing karma + invite + bond outputs.
 *
 * The inviter pays only the bond: `INVITE_KARMA_AMOUNT` is minted at the claim,
 * not paid here, so creation conserves value like any other transaction.
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
  inviteBox: InviteBox;
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

  // ---- 2. Verify outputs: exactly 1 karma + 1 invite + 1 bond ----
  const karmaOutputs = tx.outputs.filter((o) => o.boxType === 'karma');
  const inviteOutputs = tx.outputs.filter((o) => o.boxType === 'invite');
  const bondOutputs = tx.outputs.filter((o) => o.boxType === 'bond');

  if (tx.outputs.length !== 3 || karmaOutputs.length !== 1 || inviteOutputs.length !== 1 || bondOutputs.length !== 1) {
    throw new ClientError(
      'Invite creation requires exactly 3 outputs: 1 karma + 1 invite + 1 bond',
    );
  }

  // ---- 3. Verify the inviter can afford the bond ----
  //
  // The whole cost of an invite, and the network's only sybil price. Read as the
  // inviter's summed balance rather than off this transaction's inputs, so the
  // diagnosis is "you do not hold enough" rather than "this transaction does not
  // balance" — conservation says the latter either way.
  const inviterBalance = deps.getKarmaValue(karmaInput.owner);
  if (inviterBalance < INVITE_BOND_KARMA) {
    throw new ClientError(
      `Insufficient karma to invite: the bond is ${INVITE_BOND_KARMA}, ` +
      `inviter holds ${inviterBalance}`,
    );
  }

  // ---- 4. Verify the named key is not already an account ----
  //
  // Consensus-enforced in the invite-create transition; restated here for the
  // diagnosis, because "that key is already an account" is the one rejection a
  // well-formed client cannot predict from its own state.
  const inviteOut = inviteOutputs[0] as InviteBox;
  const bondOut = bondOutputs[0] as BondBox;
  const inviteeRecord = deps.getIdentityRecord(inviteOut.inviteePublicKey);
  if (inviteeRecord !== null) {
    throw new ClientError(
      `${Buffer.from(inviteOut.inviteePublicKey).toString('hex')} is already an ` +
      `account; an invite may only name a key that is not one`,
    );
  }

  // ---- 5. Validate transaction (shape, conservation, guards, transitions) ----
  const result = validateTx(deps, tx, currentBlockHeight);
  if (!result.valid) {
    throw new ClientError(`Invalid invite create transaction: ${result.error}`);
  }

  // ---- 6. Insert into mempool ----
  //
  // `expiresAtHeight` is this MEMPOOL ENTRY's expiry, never the invite's: an
  // invite has no deadline and stays claimable until the inviter cancels
  // (NODE_INTERFACE → Invites).
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

  // These two ids must equal what block application will store, so they are
  // materialized exactly the way that path materializes them; `tx` here is
  // client-supplied decoded CBOR, so the strip-before-append in
  // `materializeOutput` is load-bearing.
  return {
    status: 'pending',
    txId,
    expiresAtHeight,
    inviteBox: materializeOutput(inviteOut, txId, tx.outputs.indexOf(inviteOut)) as InviteBox,
    bondBox: materializeOutput(bondOut, txId, tx.outputs.indexOf(bondOut)) as BondBox,
    tx,
  };
}

/**
 * Claim an invite. The invitee builds a transaction consuming the InviteBox that
 * names their key and producing one KarmaBox of `INVITE_KARMA_AMOUNT`.
 *
 * **The bond is not an input.** The karma is minted, not moved — this is the
 * only transaction in the system that may create karma, and the conservation
 * gate admits a surplus of exactly `INVITE_KARMA_AMOUNT` in this shape and no
 * other.
 *
 * Block application then writes `invitedAtBlock`, which starts the probation
 * clock and bars the key from any further invite. The claim is **pending** until
 * the next ordering block is confirmed.
 */
export function claimInvite(
  deps: UtxoEngineDeps,
  tx: UtxoTransaction,
  currentBlockHeight: number,
): {
  status: 'pending';
  txId: string;
  expiresAtHeight: number;
  userId: Uint8Array;
  karmaBoxId: string;
  tx: UtxoTransaction;
} {
  // ---- 1. Extract the InviteBox input ----
  if (tx.inputs.length !== 1) {
    throw new ClientError('A claim consumes exactly one input: the InviteBox');
  }
  const inviteBoxId = tx.inputs[0]!;
  const inviteBox = deps.getBox(inviteBoxId);
  if (!inviteBox || inviteBox.boxType !== 'invite') {
    throw new ClientError(`Invite box not found: ${inviteBoxId}`);
  }
  const invite = inviteBox as InviteBox;

  // ---- 2. Verify the output is the invitee's karma box ----
  const karmaOutput = tx.outputs.find((o): o is KarmaBox => o.boxType === 'karma');
  if (!karmaOutput) {
    throw new ClientError('Transaction must produce a KarmaBox for the invitee');
  }
  if (!Buffer.from(invite.inviteePublicKey).equals(karmaOutput.owner)) {
    throw new ClientError(
      'Karma output owner must be the invitee named on the InviteBox',
      403,
    );
  }

  // ---- 3. Validate transaction ----
  //
  // `validateTx` checks the `invite_dual` guard against the invitee's signature,
  // the surplus against the conservation carve, and the claim transition.
  const result = validateTx(deps, tx, currentBlockHeight);
  if (!result.valid) {
    throw new ClientError(`Invalid invite claim transaction: ${result.error}`);
  }

  // ---- 4. Insert into mempool ----
  const expiresAtHeight = currentBlockHeight + MEMPOOL_EXPIRY_BLOCKS;
  admitTx(tx, expiresAtHeight);

  // ---- 5. Return result ----
  // txId first, then provenance — see createInvite.
  const txId = computeTxId(tx);
  const karmaBoxId = materializeOutput(
    karmaOutput,
    txId,
    tx.outputs.indexOf(karmaOutput),
  ).id!;

  return {
    status: 'pending',
    txId,
    expiresAtHeight,
    userId: invite.inviteePublicKey,
    karmaBoxId,
    tx,
  };
}

/**
 * Cancel an open invite. The inviter builds a transaction consuming the
 * InviteBox and producing **no outputs**; the box holds `0`, so this conserves.
 *
 * The bond is not named and could not be spent: block application returns it to
 * the inviter, resolved by `inviteePublicKey`. The cancellation is **pending**
 * until the next ordering block is confirmed.
 */
export function cancelInvite(
  deps: UtxoEngineDeps,
  tx: UtxoTransaction,
  currentBlockHeight: number,
): {
  status: 'pending';
  txId: string;
  expiresAtHeight: number;
  tx: UtxoTransaction;
} {
  // ---- 1. Extract the InviteBox input ----
  if (tx.inputs.length !== 1) {
    throw new ClientError('A cancel consumes exactly one input: the InviteBox');
  }
  const inviteBoxId = tx.inputs[0]!;
  const inviteBox = deps.getBox(inviteBoxId);
  if (!inviteBox || inviteBox.boxType !== 'invite') {
    // Covers both "never existed" and "already claimed or cancelled": `getBox`
    // returns null for a spent box.
    throw new ClientError(`Invite box not found or already spent: ${inviteBoxId}`);
  }

  // ---- 2. Verify the signer is the inviter ----
  //
  // Consensus-enforced by the `invite_dual` guard's cancel path; restated here
  // for the 403, which `validateTx` has no vocabulary for.
  const inv = inviteBox as InviteBox;
  const inviterHex = Buffer.from(inv.inviterId).toString('hex');
  if (!tx.signatures[inviterHex]) {
    throw new ClientError(
      'Inviter mismatch: the cancel carries no signature from the invite\'s inviterId',
      403,
    );
  }

  // ---- 3. Validate transaction ----
  const result = validateTx(deps, tx, currentBlockHeight);
  if (!result.valid) {
    throw new ClientError(`Invalid invite cancel transaction: ${result.error}`);
  }

  // ---- 4. Insert into mempool ----
  const expiresAtHeight = currentBlockHeight + MEMPOOL_EXPIRY_BLOCKS;
  admitTx(tx, expiresAtHeight);

  // ---- 5. Return result ----
  const txId = computeTxId(tx);

  return {
    status: 'pending',
    txId,
    expiresAtHeight,
    tx,
  };
}
