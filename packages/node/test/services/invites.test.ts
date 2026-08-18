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
  hasActiveVouchEscrow as storeHasActiveVouchEscrow,
  getPendingEntries,
} from '../../src/store/index.js';
import { createInvite } from '../../src/services/invites.js';
import { validateTx } from '../../src/services/utxo-engine.js';
import type { UtxoEngineDeps } from '../../src/services/utxo-engine.js';
import {
  rawPublicKey,
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
      hasActiveVouchEscrow: () => false,
      vouchCooldownBlocks: 2,
      getTopologyAuthor: () => null,
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

  /** K(v) → K(v − bond) + Bond(bond), inviter-signed — the whole invite. */
  function buildCreateTx(
    karmaIn: Stored<KarmaBox>,
    invitee: Uint8Array,
    overrides: {
      bondValue?: bigint;
      bondInviterId?: Uint8Array;
    } = {},
  ): UtxoTransaction {
    const bondValue = overrides.bondValue ?? INVITE_BOND_KARMA;
    const karmaOut: CandidateOf<KarmaBox> = {
      boxType: 'karma',
      value: karmaIn.value - bondValue,
      owner: inviterId,
    };
    const bondOut: CandidateOf<BondBox> = {
      boxType: 'bond',
      value: bondValue,
      inviterId: overrides.bondInviterId ?? inviterId,
      inviteePublicKey: invitee,
    };
    const tx: UtxoTransaction = {
      inputs: [karmaIn.id!],
      outputs: [karmaOut, bondOut],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(tx, inviterPrivKey, inviterPubKeyHex);
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
    // ⛔ **One box id, not two** — the response carries `bondBoxId` alone
    // (NODE_INTERFACE → Invites). It is the id block application will store:
    // the same `materializeOutput` at the same position.
    expect(result.bondBox.txId).toBe(result.txId);
    expect(result.bondBox.index).toBe(1);

    const pooled = getPendingEntries(100);
    expect(pooled).toHaveLength(1);
    expect(computeTxId(decodeTx(pooled[0]!.utxoTxCbor!))).toBe(result.txId);
  });

  it('createInvite charges only the bond', () => {
    // `INVITE_KARMA_AMOUNT` is not paid here: it comes out of the karma pool at
    // settlement, so the invite conserves value like any other transaction
    // (ARCHITECTURE → Invite System). A create that paid both would fail
    // conservation.
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
    // A granted key holds a record, so the bar catches it — but by record
    // existence, not by the height it carries.
    storePutIdentityRecord(inviteePubKey, {
      lastActivityBlock: 3,
      lastDecayBlock: 0,
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
    // Naming one draws it `INVITE_KARMA_AMOUNT` out of the pool, and the bond
    // then vests in full against likes that key had ALREADY earned — so the
    // whole stake comes back and the inviter's only cost is a probation-length
    // lock.
    storePutIdentityRecord(inviteePubKey, {
      lastActivityBlock: 3,
      lastDecayBlock: 0,
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

  it('createInvite rejects a bond holding anything but INVITE_BOND_KARMA', () => {
    // The bond is the whole cost of an invite and the network's only sybil
    // price. Conservation alone permits any value — the karma change output just
    // keeps the difference — so this pin is what makes the price real.
    const karma = createKarmaBox(inviterId, 100n, 1);
    const tx = buildCreateTx(karma, inviteePubKey, { bondValue: INVITE_BOND_KARMA - 1n });

    expect(() => createInvite(deps, tx, 5))
      .toThrow(new RegExp(`BondBox must hold exactly ${INVITE_BOND_KARMA}`));
  });

  it('createInvite rejects a bond naming someone else as inviter', () => {
    // Unpinned, the creator emits a bond naming a stranger and the
    // probation-deadline settlement pays them.
    const karma = createKarmaBox(inviterId, 100n, 1);
    const other = rawPublicKey(generateKeyPairSync('ed25519').publicKey);
    const tx = buildCreateTx(karma, inviteePubKey, { bondInviterId: other });

    expect(() => createInvite(deps, tx, 5)).toThrow(/inviterId must be the karma input's owner/);
  });

  // -----------------------------------------------------------------------
  // ⛔ NO user transaction carries a karma surplus
  // -----------------------------------------------------------------------

  it('the invite itself conserves — the grant comes from the pool', () => {
    // ⛔ **The invite-claim surplus is GONE, and with it the last one**
    // (NODE_INTERFACE → validateTx step 5). `INVITE_KARMA_AMOUNT` is spent from
    // the karma pool by the block's settlement transaction, so the inviter pays
    // the bond and nothing else, and the sums balance exactly.
    const karma = createKarmaBox(inviterId, 100n, 1);
    const tx = buildCreateTx(karma, inviteePubKey);

    const inSum = karma.value;
    const outSum = tx.outputs.reduce((sum, o) => sum + o.value, 0n);
    expect(outSum).toBe(inSum);
    expect(validateTx(deps, tx, 5).valid).toBe(true);
  });

  it('no shape at all may carry a karma surplus', () => {
    // A plain karma spend that mints itself INVITE_KARMA_AMOUNT is refused by
    // strict conservation — and now there is no shape the gate would have let
    // through, because the exception list is empty.
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
