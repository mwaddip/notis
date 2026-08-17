import {
  describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  generateKeyPairSync,
  type KeyObject,
} from 'crypto';
import {
  computeTxId,
  decodeTx,
  PROTOCOL_VERSION,
  INVITE_KARMA_AMOUNT,
  INVITE_BOND_KARMA,
  MEMPOOL_EXPIRY_BLOCKS,
} from '@dagsocial/types';
import type {
  AnyBox,
  BondBox,
  CandidateOf,
  InviteBox,
  KarmaBox,
  UtxoTransaction,
} from '@dagsocial/types';
import Database from 'better-sqlite3';

import {
  initDb,
  closeDb,
  getDb,
  getKarmaBox,
  getKarmaBoxes,
  insertBox as storeInsertBox,
  getBox as storeGetBox,
  getIdentityRecord as storeGetIdentityRecord,
  putIdentityRecord as storePutIdentityRecord,
  consumeBox as storeConsumeBox,
  hasActiveVouchCooldown as storeHasActiveVouchCooldown,
  getPendingEntries,
} from '../../src/store/index.js';
import { createInvite, claimInvite, cancelInvite } from '../../src/services/invites.js';
import { validateTx } from '../../src/services/utxo-engine.js';
import type { UtxoEngineDeps } from '../../src/services/utxo-engine.js';
import {
  rawPublicKey,
  seedInviteAndBond,
  seedProvenance,
  signTransaction,
  type Stored,
} from '../helpers.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create and insert a karma box, returning it with its computed id. */
function createKarmaBox(
  owner: Uint8Array,
  value: bigint,
  seed: number,
): Stored<KarmaBox> {
  const box = seedProvenance<KarmaBox>(
    {
      boxType: 'karma',
      value,
      owner,
    },
    seed,
  );
  storeInsertBox(box);
  return box;
}

/**
 * Seed an invite + bond pair into the store.
 *
 * Delegates to the shared `seedInviteAndBond`, which owns the pairing rule and
 * the provenance discriminator. `label` is required there for a reason visible
 * right here: every call site below passes near-identical values, so without the
 * discriminator they would produce the same invite id, bond id and
 * `(txId, index)`.
 */
function insertInviteAndBond(
  label: string,
  inviterId: Uint8Array,
  inviteePublicKey: Uint8Array,
  seed = 1,
  bondValue = INVITE_BOND_KARMA,
): { inviteBox: Stored<InviteBox>; bondBox: Stored<BondBox> } {
  const { invite, bond } = seedInviteAndBond({
    label,
    inviterId,
    inviteePublicKey,
    bondValue,
    seedHeight: seed,
  });
  storeInsertBox(invite);
  storeInsertBox(bond);
  return { inviteBox: invite, bondBox: bond };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('invites service', () => {
  let db: Database.Database;
  let inviterPubKey: Uint8Array;
  let inviterPrivKey: KeyObject;
  let inviterPubKeyHex: string;
  let inviterId: Uint8Array;
  let inviteePubKey: Uint8Array;
  let inviteePubKeyHex: string;
  let inviteePrivKey: KeyObject;

  function makeDeps(): UtxoEngineDeps {
    return {
      getBox: (id: string): AnyBox | null => {
        const box = storeGetBox(id);
        if (!box) return null;
        const r = db
          .prepare('SELECT spent_at_block FROM utxo_boxes WHERE id = ?')
          .get(id) as { spent_at_block: number | null } | undefined;
        return r && r.spent_at_block === null ? box : null;
      },
      getIdentityRecord: storeGetIdentityRecord,
      insertBox: (box: AnyBox) => storeInsertBox(box),
      consumeBox: (id: string, atBlock: number) => storeConsumeBox(id, atBlock),
      getKarmaBox: (owner: Uint8Array) => getKarmaBox(owner),
      getKarmaValue: (owner: Uint8Array) =>
        getKarmaBoxes(owner).reduce((sum, b) => sum + b.value, 0n),
      hasActiveVouchCooldown: storeHasActiveVouchCooldown,
      runInTransaction: (fn: () => void) => {
        (db.transaction(fn) as () => void)();
      },
    };
  }

  let deps: UtxoEngineDeps;

  beforeEach(() => {
    initDb(':memory:');
    db = getDb();

    const inviterKeys = generateKeyPairSync('ed25519');
    inviterPubKey = rawPublicKey(inviterKeys.publicKey);
    inviterPrivKey = inviterKeys.privateKey;
    inviterPubKeyHex = Buffer.from(inviterPubKey).toString('hex');
    inviterId = inviterPubKey;

    const inviteeKeys = generateKeyPairSync('ed25519');
    inviteePubKey = rawPublicKey(inviteeKeys.publicKey);
    inviteePrivKey = inviteeKeys.privateKey;
    inviteePubKeyHex = Buffer.from(inviteePubKey).toString('hex');

    deps = makeDeps();
  });

  afterEach(() => {
    closeDb();
  });

  // -----------------------------------------------------------------------
  // Builders — the three shapes a client sends
  // -----------------------------------------------------------------------

  /** K(v) → K(v − bond) + Invite(0) + Bond(bond), inviter-signed. */
  function buildCreateTx(
    karmaIn: Stored<KarmaBox>,
    invitee: Uint8Array,
    overrides: {
      inviteValue?: bigint;
      bondValue?: bigint;
      inviteInviterId?: Uint8Array;
      bondInvitee?: Uint8Array;
    } = {},
  ): UtxoTransaction {
    const bondValue = overrides.bondValue ?? INVITE_BOND_KARMA;
    const karmaOut: CandidateOf<KarmaBox> = {
      boxType: 'karma',
      value: karmaIn.value - bondValue - (overrides.inviteValue ?? 0n),
      owner: inviterId,
    };
    const inviteOut: CandidateOf<InviteBox> = {
      boxType: 'invite',
      value: overrides.inviteValue ?? 0n,
      inviterId: overrides.inviteInviterId ?? inviterId,
      inviteePublicKey: invitee,
    };
    const bondOut: CandidateOf<BondBox> = {
      boxType: 'bond',
      value: bondValue,
      inviterId,
      inviteePublicKey: overrides.bondInvitee ?? invitee,
    };
    const tx: UtxoTransaction = {
      inputs: [karmaIn.id!],
      outputs: [karmaOut, inviteOut, bondOut],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(tx, inviterPrivKey, inviterPubKeyHex);
    return tx;
  }

  /** Invite → one KarmaBox of INVITE_KARMA_AMOUNT, invitee-signed. */
  function buildClaimTx(
    invite: Stored<InviteBox>,
    opts: { owner?: Uint8Array; value?: bigint; signer?: 'invitee' | 'inviter' } = {},
  ): UtxoTransaction {
    const tx: UtxoTransaction = {
      inputs: [invite.id!],
      outputs: [
        {
          boxType: 'karma',
          value: opts.value ?? INVITE_KARMA_AMOUNT,
          owner: opts.owner ?? inviteePubKey,
        } as CandidateOf<KarmaBox>,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    if (opts.signer === 'inviter') {
      signTransaction(tx, inviterPrivKey, inviterPubKeyHex);
    } else {
      signTransaction(tx, inviteePrivKey, inviteePubKeyHex);
    }
    return tx;
  }

  /** Invite → nothing, inviter-signed. */
  function buildCancelTx(
    invite: Stored<InviteBox>,
    signer: 'inviter' | 'invitee' = 'inviter',
  ): UtxoTransaction {
    const tx: UtxoTransaction = {
      inputs: [invite.id!],
      outputs: [],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    if (signer === 'inviter') {
      signTransaction(tx, inviterPrivKey, inviterPubKeyHex);
    } else {
      signTransaction(tx, inviteePrivKey, inviteePubKeyHex);
    }
    return tx;
  }

  // -----------------------------------------------------------------------
  // create
  // -----------------------------------------------------------------------

  it('createInvite returns pending and inserts into mempool', () => {
    const karma = createKarmaBox(inviterId, 100n, 1);
    const tx = buildCreateTx(karma, inviteePubKey);

    const result = createInvite(deps, tx, 5);

    expect(result.status).toBe('pending');
    expect(result.txId).toBe(computeTxId(tx));
    expect(result.expiresAtHeight).toBe(5 + MEMPOOL_EXPIRY_BLOCKS);
    // Both ids are the ones block application will store: the same
    // `materializeOutput` at the same positions.
    expect(result.inviteBox.txId).toBe(result.txId);
    expect(result.inviteBox.index).toBe(1);
    expect(result.bondBox.index).toBe(2);

    const pooled = getPendingEntries(100);
    expect(pooled).toHaveLength(1);
    expect(computeTxId(decodeTx(pooled[0]!.utxoTxCbor!))).toBe(result.txId);
  });

  it('createInvite charges only the bond — the mint is at the claim', () => {
    // `INVITE_KARMA_AMOUNT` is not paid here: the invite holds 0 and creation
    // conserves value like any other transaction (ARCHITECTURE → Invite
    // creation). A create that paid both would fail conservation.
    const karma = createKarmaBox(inviterId, 100n, 1);
    const tx = buildCreateTx(karma, inviteePubKey);

    const karmaOut = tx.outputs[0] as CandidateOf<KarmaBox>;
    expect(karmaOut.value).toBe(100n - INVITE_BOND_KARMA);
    expect(validateTx(deps, tx, 5).valid).toBe(true);
  });

  it('createInvite rejects an inviter who cannot fund the bond', () => {
    // The change box is empty and the bond still asks for the full stake, so
    // this is a transaction the client can build and sign — the balance is what
    // refuses it, ahead of conservation.
    const karma = createKarmaBox(inviterId, INVITE_BOND_KARMA - 1n, 1);
    const tx: UtxoTransaction = {
      inputs: [karma.id!],
      outputs: [
        { boxType: 'karma', value: 0n, owner: inviterId } as CandidateOf<KarmaBox>,
        {
          boxType: 'invite', value: 0n, inviterId,
          inviteePublicKey: inviteePubKey, 
        } as CandidateOf<InviteBox>,
        {
          boxType: 'bond', value: INVITE_BOND_KARMA, inviterId,
          inviteePublicKey: inviteePubKey, 
        } as CandidateOf<BondBox>,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(tx, inviterPrivKey, inviterPubKeyHex);

    expect(() => createInvite(deps, tx, 5)).toThrow(/Insufficient karma to invite/);
  });

  it('createInvite rejects a key that has already been invited', () => {
    // A claimed key holds a record, so the bar catches it — but by record
    // existence, not by the height it carries.
    storePutIdentityRecord(inviteePubKey, {
      lastActivityBlock: 3,
      lastDecayBlock: 0,
      likeCarry: 0n,
      invitedAtBlock: 3,
      lifetimeLikesReceived: 0n,
    });
    const karma = createKarmaBox(inviterId, 100n, 1);
    const tx = buildCreateTx(karma, inviteePubKey);

    expect(() => createInvite(deps, tx, 5)).toThrow(/is already an account/);
  });

  it('createInvite rejects an ESTABLISHED account that was never invited', () => {
    // ⚠ The karma-printing case, and the reason the bar is record existence
    // rather than `invitedAtBlock !== 0`. Every genesis committee member and
    // every faucet recipient holds karma without ever having been invited.
    // Naming one mints it `INVITE_KARMA_AMOUNT` from nothing, and the bond then
    // vests in full against likes that key had ALREADY earned — so the whole
    // stake comes back and the inviter's only cost is a probation-length lock.
    storePutIdentityRecord(inviteePubKey, {
      lastActivityBlock: 3,
      lastDecayBlock: 0,
      likeCarry: 0n,
      invitedAtBlock: 0,          // never invited
      lifetimeLikesReceived: 900n, // and long since past a full vest
    });
    const karma = createKarmaBox(inviterId, 100n, 1);
    const tx = buildCreateTx(karma, inviteePubKey);

    expect(() => createInvite(deps, tx, 5)).toThrow(/is already an account/);
    // Consensus refuses it too, not only the service.
    const result = validateTx(deps, tx, 5);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('may not name an existing account');
  });

  it('createInvite accepts a key with no record at all', () => {
    // Non-vacuity for the bar, and the whole legal case: a key with no record
    // has never held karma, so it has never posted and never been liked.
    expect(storeGetIdentityRecord(inviteePubKey)).toBeNull();
    const karma = createKarmaBox(inviterId, 100n, 1);
    const tx = buildCreateTx(karma, inviteePubKey);

    expect(createInvite(deps, tx, 5).status).toBe('pending');
  });

  it('createInvite rejects an invite and bond naming different invitees', () => {
    // The pair is the pairing. Unpinned, the claim would start a probation
    // clock no bond is dated by, and the bond would settle against a stranger.
    const karma = createKarmaBox(inviterId, 100n, 1);
    const other = rawPublicKey(generateKeyPairSync('ed25519').publicKey);
    const tx = buildCreateTx(karma, inviteePubKey, { bondInvitee: other });

    expect(() => createInvite(deps, tx, 5)).toThrow(/same inviteePublicKey/);
  });

  it('createInvite rejects an InviteBox holding karma', () => {
    const karma = createKarmaBox(inviterId, 100n, 1);
    const tx = buildCreateTx(karma, inviteePubKey, { inviteValue: 25n });

    expect(() => createInvite(deps, tx, 5)).toThrow(/InviteBox must hold 0 karma/);
  });

  it('createInvite rejects a pair naming someone else as inviter', () => {
    const karma = createKarmaBox(inviterId, 100n, 1);
    const other = rawPublicKey(generateKeyPairSync('ed25519').publicKey);
    const tx = buildCreateTx(karma, inviteePubKey, { inviteInviterId: other });

    expect(() => createInvite(deps, tx, 5)).toThrow(/inviterId must be the karma input's owner/);
  });

  // -----------------------------------------------------------------------
  // claim
  // -----------------------------------------------------------------------

  it('claimInvite returns pending and mints to the named key', () => {
    const { inviteBox } = insertInviteAndBond('claim-ok', inviterId, inviteePubKey);
    const tx = buildClaimTx(inviteBox);

    const result = claimInvite(deps, tx, 7);

    expect(result.status).toBe('pending');
    expect(Buffer.from(result.userId).toString('hex')).toBe(inviteePubKeyHex);
    expect(result.karmaBoxId).toHaveLength(64);
    expect(getPendingEntries(100)).toHaveLength(1);
  });

  it('a claim needs no bond input — the karma is minted, not moved', () => {
    // The whole shape: one invite in, one karma box out, and a surplus of
    // exactly INVITE_KARMA_AMOUNT that the conservation carve admits in this
    // shape and no other.
    const { inviteBox, bondBox } = insertInviteAndBond('claim-shape', inviterId, inviteePubKey);
    const tx = buildClaimTx(inviteBox);

    expect(tx.inputs).toEqual([inviteBox.id!]);
    expect(validateTx(deps, tx, 7).valid).toBe(true);
    // And naming the bond alongside it is refused, because a bond has no
    // user-transaction shape at all.
    const withBond: UtxoTransaction = { ...tx, inputs: [inviteBox.id!, bondBox.id!] };
    signTransaction(withBond, inviteePrivKey, inviteePubKeyHex);
    expect(validateTx(deps, withBond, 7).valid).toBe(false);
  });

  it('claimInvite rejects a karma output owned by anyone but the named invitee', () => {
    const { inviteBox } = insertInviteAndBond('claim-owner', inviterId, inviteePubKey);
    const other = rawPublicKey(generateKeyPairSync('ed25519').publicKey);
    const tx = buildClaimTx(inviteBox, { owner: other });

    expect(() => claimInvite(deps, tx, 7)).toThrow(/must be the invitee named on the InviteBox/);
  });

  it('claimInvite rejects a claim minting anything but INVITE_KARMA_AMOUNT', () => {
    const { inviteBox } = insertInviteAndBond('claim-amount', inviterId, inviteePubKey);
    const tx = buildClaimTx(inviteBox, { value: INVITE_KARMA_AMOUNT + 1n });

    expect(() => claimInvite(deps, tx, 7)).toThrow(/must mint exactly/);
  });

  it('claimInvite rejects an inviter-signed claim', () => {
    // Either named key may sign, and the transition arm decides which
    // shape that key may take. An inviter-signed claim would mint the invitee's
    // karma without them, bar their key from any further invite, and start a
    // probation clock they never asked for.
    const { inviteBox } = insertInviteAndBond('claim-signer', inviterId, inviteePubKey);
    const tx = buildClaimTx(inviteBox, { signer: 'inviter' });

    expect(() => claimInvite(deps, tx, 7)).toThrow(/must be signed by the invitee/);
  });

  it('claimInvite rejects a spent invite', () => {
    const { inviteBox } = insertInviteAndBond('claim-spent', inviterId, inviteePubKey);
    storeConsumeBox(inviteBox.id!, 6);
    const tx = buildClaimTx(inviteBox);

    expect(() => claimInvite(deps, tx, 7)).toThrow(/Invite box not found/);
  });

  // -----------------------------------------------------------------------
  // cancel
  // -----------------------------------------------------------------------

  it('cancelInvite returns pending on a zero-output spend', () => {
    const { inviteBox } = insertInviteAndBond('cancel-ok', inviterId, inviteePubKey);
    const tx = buildCancelTx(inviteBox);

    const result = cancelInvite(deps, tx, 9);

    expect(result.status).toBe('pending');
    expect(result.txId).toBe(computeTxId(tx));
    expect(getPendingEntries(100)).toHaveLength(1);
  });

  it('a cancel conserves — the box holds nothing to return', () => {
    // Zero outputs and zero inputs by value, so this needs no conservation
    // exemption of its own; the bond comes back through block application.
    const { inviteBox } = insertInviteAndBond('cancel-conserves', inviterId, inviteePubKey);
    const tx = buildCancelTx(inviteBox);

    expect(inviteBox.value).toBe(0n);
    expect(validateTx(deps, tx, 9).valid).toBe(true);
  });

  it('cancelInvite rejects an invitee-signed cancel', () => {
    const { inviteBox } = insertInviteAndBond('cancel-signer', inviterId, inviteePubKey);
    const tx = buildCancelTx(inviteBox, 'invitee');

    expect(() => cancelInvite(deps, tx, 9)).toThrow(/carries no signature from the invite/);
  });

  it('cancelInvite rejects an invite already claimed or cancelled', () => {
    const { inviteBox } = insertInviteAndBond('cancel-spent', inviterId, inviteePubKey);
    storeConsumeBox(inviteBox.id!, 8);
    const tx = buildCancelTx(inviteBox);

    expect(() => cancelInvite(deps, tx, 9)).toThrow(/not found or already spent/);
  });

  // -----------------------------------------------------------------------
  // The surplus is the claim's alone
  // -----------------------------------------------------------------------

  it('no other shape may carry a karma surplus', () => {
    // The biconditional's other half: a plain karma spend that mints itself
    // INVITE_KARMA_AMOUNT is refused by strict conservation, so the carve is
    // confined to the claim shape rather than being a general allowance.
    const karma = createKarmaBox(inviterId, 100n, 1);
    const tx: UtxoTransaction = {
      inputs: [karma.id!],
      outputs: [
        {
          boxType: 'karma',
          value: 100n + INVITE_KARMA_AMOUNT,
          owner: inviterId,
        } as CandidateOf<KarmaBox>,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(tx, inviterPrivKey, inviterPubKeyHex);

    const result = validateTx(deps, tx, 5);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('non-conservation');
  });
});
