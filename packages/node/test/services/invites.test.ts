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
  MEMPOOL_EXPIRY_BLOCKS,
  KARMA_STALE_THRESHOLD_BLOCKS,
  KARMA_DECAY_INTERVAL_BLOCKS,
  KARMA_DECAY_AMOUNT,
  KARMA_MINIMUM,
} from '@dagsocial/types';
import type {
  AnyBox,
  BondBox,
  CandidateOf,
  CreditBox,
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
  FIXTURE_BOND_KARMA,
} from '../helpers.js';
import { config } from '../../src/config.js';

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
      createdAtBlock: 0,
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
      inviteBondMin: config.inviteBondMin,
      inviteBondMax: config.inviteBondMax,
      decayCfg: {
        staleThresholdBlocks: KARMA_STALE_THRESHOLD_BLOCKS,
        decayIntervalBlocks: KARMA_DECAY_INTERVAL_BLOCKS,
        decayAmount: KARMA_DECAY_AMOUNT,
        karmaMinimum: KARMA_MINIMUM,
      },
      storageRentPeriodBlocks: 40,
      getBoxProvenance: () => null,
      getTopologyAuthor: () => null,
      getPendingPostAuthor: () => null,
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
    const bondValue = overrides.bondValue ?? FIXTURE_BOND_KARMA;
    const karmaOut: CandidateOf<KarmaBox> = {
      boxType: 'karma',
      value: karmaIn.value - bondValue,
      createdAtBlock: 0,
      owner: inviterId,
    };
    const bondOut: CandidateOf<BondBox> = {
      boxType: 'bond',
      value: bondValue,
      createdAtBlock: 0,
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
    expect(computeTxId(decodeTx(pooled[0]!.utxoTxBytes!))).toBe(result.txId);
  });

  it('createInvite charges only the bond', () => {
    // `FIXTURE_BOND_KARMA` is not paid here: it comes out of the karma pool at
    // settlement, so the invite conserves value like any other transaction
    // (ARCHITECTURE → Invite System). A create that paid both would fail
    // conservation.
    const karma = createKarmaBox(inviterId, 100n, 1);
    const tx = buildCreateTx(karma, inviteePubKey);

    const karmaOut = tx.outputs[0] as CandidateOf<KarmaBox>;
    expect(karmaOut.value).toBe(100n - FIXTURE_BOND_KARMA);
    expect(validateTx(deps, tx, 5).valid).toBe(true);
  });

  it('createInvite rejects an inviter who cannot fund the bond', () => {
    // The change box is empty and the bond still asks for the full stake, so
    // this is a transaction the client can build and sign — the balance is what
    // refuses it, ahead of conservation.
    const karma = createKarmaBox(inviterId, FIXTURE_BOND_KARMA - 1n, 1);
    const tx: UtxoTransaction = {
      inputs: [karma.id!],
      outputs: [
        { boxType: 'karma', value: 1n,  createdAtBlock: 0,owner: inviterId } as CandidateOf<KarmaBox>,
        {
          boxType: 'bond', value: FIXTURE_BOND_KARMA, inviterId,
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
      memberSinceBlock: 0,
      memberBar: 0,
      memberVouches: 0,
      memberLikes: 0n,
      invitesUsed: 0,
    });
    const karma = createKarmaBox(inviterId, 100n, 1);
    const tx = buildCreateTx(karma, inviteePubKey);

    expect(() => createInvite(deps, tx, 5)).toThrow(/is already an account/);
  });

  it('createInvite rejects an ESTABLISHED account that was never invited', () => {
    // ⚠ The karma-printing case, and the reason the bar is record existence
    // rather than `invitedAtBlock !== 0`. Every genesis committee member and
    // every faucet recipient holds karma without ever having been invited.
    // Naming one draws it `FIXTURE_BOND_KARMA` out of the pool, and the bond
    // then vests in full against likes that key had ALREADY earned — so the
    // whole stake comes back and the inviter's only cost is a probation-length
    // lock.
    storePutIdentityRecord(inviteePubKey, {
      lastActivityBlock: 3,
      lastDecayBlock: 0,
      invitedAtBlock: 0,
      lifetimeLikesReceived: 900n,
      memberSinceBlock: 0,
      memberBar: 0,
      memberVouches: 0,
      memberLikes: 0n,
      invitesUsed: 0,
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

  it('createInvite rejects a bond under the network floor', () => {
    // The floor is the whole cost of an invite and the network's only sybil
    // price. Conservation alone permits any value — the karma change output just
    // keeps the difference — so this pin is what makes the price real.
    const karma = createKarmaBox(inviterId, 100n, 1);
    const tx = buildCreateTx(karma, inviteePubKey, {
      bondValue: config.inviteBondMin - 1n,
    });

    expect(() => createInvite(deps, tx, 5)).toThrow(/An invite bond must hold between/);
  });

  it('createInvite rejects a bond over the network ceiling', () => {
    // The other boundary. A ceiling exists because the grant equals the bond and
    // the grant is a pool draw: without one, a single invite could name the
    // whole supply.
    const karma = createKarmaBox(inviterId, config.inviteBondMax + 100n, 1);
    const tx = buildCreateTx(karma, inviteePubKey, {
      bondValue: config.inviteBondMax + 1n,
    });

    expect(() => createInvite(deps, tx, 5)).toThrow(/An invite bond must hold between/);
  });

  it('createInvite accepts a bond at each endpoint, and the bond IS the grant', () => {
    // The endpoints are inclusive, and the two rejections above prove nothing
    // without them — a rule that refused everything would pass both.
    for (const bondValue of [config.inviteBondMin, config.inviteBondMax]) {
      const karma = createKarmaBox(inviterId, config.inviteBondMax + 100n, Number(bondValue));
      const tx = buildCreateTx(karma, rawPublicKey(generateKeyPairSync('ed25519').publicKey), {
        bondValue,
      });
      expect(createInvite(deps, tx, 5).status).toBe('pending');
      expect((tx.outputs[1] as CandidateOf<BondBox>).value).toBe(bondValue);
    }
  });

  // ⛔ **The case a fixed threshold passes.** This inviter clears the floor, so a
  // gate reading a constant admits them and conservation then refuses the
  // transaction — which is the diagnosis this layer exists to replace. Built by
  // hand for the reason the case above is: an empty change box makes it a
  // transaction a client can build and sign.
  it('createInvite rejects an inviter who clears the floor but not their own bond', () => {
    // One under the ceiling: this inviter clears the floor and every fixed
    // threshold below the ceiling, so the only gate that refuses them is one
    // reading the bond they actually named.
    const held = config.inviteBondMax - 1n;
    const karma = createKarmaBox(inviterId, held, 1);
    const tx: UtxoTransaction = {
      inputs: [karma.id!],
      outputs: [
        { boxType: 'karma', value: 1n,  createdAtBlock: 0,owner: inviterId } as CandidateOf<KarmaBox>,
        {
          boxType: 'bond', value: config.inviteBondMax, inviterId,
          inviteePublicKey: inviteePubKey,
        } as CandidateOf<BondBox>,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(tx, inviterPrivKey, inviterPubKeyHex);

    expect(() => createInvite(deps, tx, 5))
      .toThrow(new RegExp(`this invite bonds ${config.inviteBondMax}, inviter holds ${held}`));
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
    // ⛔ **Every user transaction conserves unconditionally** (NODE_INTERFACE →
    // validateTx step 7). `FIXTURE_BOND_KARMA` is spent from the karma pool by
    // the block's settlement transaction, so the inviter pays the bond and
    // nothing else, and the sums balance exactly.
    const karma = createKarmaBox(inviterId, 100n, 1);
    const tx = buildCreateTx(karma, inviteePubKey);

    const inSum = karma.value;
    const outSum = tx.outputs.reduce((sum, o) => sum + o.value, 0n);
    expect(outSum).toBe(inSum);
    expect(validateTx(deps, tx, 5).valid).toBe(true);
  });

  // -----------------------------------------------------------------------
  // NODE_INTERFACE → Karma transition rules: the karma output is optional
  // -----------------------------------------------------------------------

  it('createInvite accepts a bond alone when the inviter spends exactly', () => {
    const karma = createKarmaBox(inviterId, FIXTURE_BOND_KARMA, 1);
    const tx: UtxoTransaction = {
      inputs: [karma.id!],
      outputs: [
        {
          boxType: 'bond',
          value: FIXTURE_BOND_KARMA,
          createdAtBlock: 0,
          inviterId,
          inviteePublicKey: inviteePubKey,
        } as CandidateOf<BondBox>,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(tx, inviterPrivKey, inviterPubKeyHex);
    expect(createInvite(deps, tx, 5).status).toBe('pending');
  });

  it('createInvite rejects two bonds', () => {
    const invitee2 = rawPublicKey(generateKeyPairSync('ed25519').publicKey);
    const karma = createKarmaBox(inviterId, 100n, 1);
    const tx: UtxoTransaction = {
      inputs: [karma.id!],
      outputs: [
        {
          boxType: 'bond', value: FIXTURE_BOND_KARMA, createdAtBlock: 0,
          inviterId, inviteePublicKey: inviteePubKey,
        } as CandidateOf<BondBox>,
        {
          boxType: 'bond', value: FIXTURE_BOND_KARMA, createdAtBlock: 0,
          inviterId, inviteePublicKey: invitee2,
        } as CandidateOf<BondBox>,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(tx, inviterPrivKey, inviterPubKeyHex);
    expect(() => createInvite(deps, tx, 5)).toThrow(/exactly 1 bond/);
  });

  it('createInvite rejects a bond plus a foreign box type', () => {
    const karma = createKarmaBox(inviterId, 100n, 1);
    const tx: UtxoTransaction = {
      inputs: [karma.id!],
      outputs: [
        {
          boxType: 'bond', value: FIXTURE_BOND_KARMA, createdAtBlock: 0,
          inviterId, inviteePublicKey: inviteePubKey,
        } as CandidateOf<BondBox>,
        {
          boxType: 'credit', value: 100n - FIXTURE_BOND_KARMA,
          owner: inviterId, createdAtBlock: 0,
        } as CandidateOf<CreditBox>,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(tx, inviterPrivKey, inviterPubKeyHex);
    expect(() => createInvite(deps, tx, 5)).toThrow(/exactly 1 bond/);
  });

  // -----------------------------------------------------------------------
  // ⛔ NO user transaction carries a karma surplus
  // -----------------------------------------------------------------------

  it('no shape at all may carry a karma surplus', () => {
    // A plain karma spend that mints itself FIXTURE_BOND_KARMA is refused by
    // strict conservation — and now there is no shape the gate would have let
    // through, because the exception list is empty.
    const karma = createKarmaBox(inviterId, 100n, 1);
    const tx: UtxoTransaction = {
      inputs: [karma.id!],
      outputs: [
        {
          boxType: 'karma',
          value: 100n + FIXTURE_BOND_KARMA,
          createdAtBlock: 0,
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
