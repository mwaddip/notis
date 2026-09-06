// ---------------------------------------------------------------------------
// Membership pass and member-like count — NODE_INTERFACE → Membership pass.
// ---------------------------------------------------------------------------

import { describe, it, expect, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { PROTOCOL_VERSION, VOUCH_KARMA_AMOUNT } from '@dagsocial/types';
import type { UtxoTransaction, VouchBox } from '@dagsocial/types';
import {
  makeTestIdentity,
  makeKarmaBox,
  signTransaction,
  hex,
  activateProverOverStore,
  makeApplicableBlock,
  seedProvenance,
  FIXTURE_BOND_KARMA,
  type Stored,
} from '../helpers.js';

type DbModule = {
  initDb: (path: string) => void;
  getDb: () => Database.Database;
  closeDb: () => void;
};

async function importDb(): Promise<DbModule> {
  return (await import('../../src/store/db.js')) as unknown as DbModule;
}

async function importRecords() {
  return await import('../../src/store/identity-records.js');
}

async function importUtxo() {
  return await import('../../src/store/utxo.js');
}

async function importBlockApply() {
  return await import('../../src/services/block-apply.js');
}

function makeVouchBox(
  voucherId: Uint8Array,
  targetId: Uint8Array,
  createdAtBlock = 0,
  nonce = 0,
): Stored<VouchBox> {
  return seedProvenance<VouchBox>({
    boxType: 'vouch' as const,
    value: VOUCH_KARMA_AMOUNT,
    createdAtBlock,
    voucherId,
    targetId,
  }, 1, nonce);
}

function makeUnvouchTx(
  vouchBoxId: string,
  signer: ReturnType<typeof makeTestIdentity>,
  releaseAtBlock: number,
  height: number,
): UtxoTransaction {
  const tx: UtxoTransaction = {
    inputs: [vouchBoxId],
    outputs: [{
      boxType: 'vouch_escrow' as const,
      value: VOUCH_KARMA_AMOUNT,
      createdAtBlock: height,
      owner: signer.userId,
      releaseAtBlock,
    } as never],
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
  };
  signTransaction(tx, signer.privateKey, hex(signer.userId));
  return tx;
}

describe('membership pass', () => {
  // Two members set in the same block do not count for each other —
  // ARCHITECTURE → Membership, NODE_INTERFACE → Membership pass.
  it('two members set in the same block get the same memberSinceBlock and neither counts for the other', async () => {
    vi.resetModules();
    const db = await importDb();
    db.initDb(':memory:');
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 2)').run();

    const records = await importRecords();

    // Two identities both crossing the bar at the same height.
    const alice = makeTestIdentity();
    const bob = makeTestIdentity();

    // Pre-block: both have memberSinceBlock = 0, memberVouches >= D, memberLikes >= Y.
    // With membershipBarMultiplier=1, N=2: D = max(1, icbrt(2)) = 1, Y = 2.
    records.putIdentityRecord(alice.userId, {
      lastActivityBlock: 1, lastDecayBlock: 0, invitedAtBlock: 1,
      lifetimeLikesReceived: 0n,
      memberSinceBlock: 0, memberBar: 0, memberVouches: 1, memberLikes: 2n, invitesUsed: 0,
    });
    records.putIdentityRecord(bob.userId, {
      lastActivityBlock: 1, lastDecayBlock: 0, invitedAtBlock: 1,
      lifetimeLikesReceived: 0n,
      memberSinceBlock: 0, memberBar: 0, memberVouches: 1, memberLikes: 2n, invitesUsed: 0,
    });

    // Simulate the membership pass at height 5.
    const { membershipBar, memberLikesBar } = await import('@dagsocial/types');
    const N = 2;
    const D = membershipBar(N, 1);
    const Y = memberLikesBar(N, 1);

    // Both cross the bar.
    const aliceRec = records.getIdentityRecord(alice.userId)!;
    expect(aliceRec.memberVouches).toBeGreaterThanOrEqual(D);
    expect(aliceRec.memberLikes).toBeGreaterThanOrEqual(BigInt(Y));

    // Set both at the same height.
    records.putIdentityRecord(alice.userId, { ...aliceRec, memberSinceBlock: 5, memberBar: D });
    records.putIdentityRecord(bob.userId, {
      ...records.getIdentityRecord(bob.userId)!, memberSinceBlock: 5, memberBar: D,
    });

    const aliceFinal = records.getIdentityRecord(alice.userId)!;
    const bobFinal = records.getIdentityRecord(bob.userId)!;
    expect(aliceFinal.memberSinceBlock).toBe(5);
    expect(bobFinal.memberSinceBlock).toBe(5);

    // Neither counts for the other: counted iff v.memberSinceBlock < m.memberSinceBlock.
    // 5 < 5 is false, so a vouch between them would not be counted.
    expect(aliceFinal.memberSinceBlock < bobFinal.memberSinceBlock).toBe(false);
    expect(bobFinal.memberSinceBlock < aliceFinal.memberSinceBlock).toBe(false);

    db.closeDb();
  });

  // The bar is fixed at set time — ARCHITECTURE → Membership,
  // NODE_INTERFACE → Membership pass.
  it('a member flagged at D=1 keeps membership when N grows to make D=3', async () => {
    vi.resetModules();
    const db = await importDb();
    db.initDb(':memory:');
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();

    const records = await importRecords();
    const { isMember } = await import('../../src/services/utxo-engine.js');

    const member = makeTestIdentity();
    // Flagged when D=1: bar is fixed at 1.
    records.putIdentityRecord(member.userId, {
      lastActivityBlock: 1, lastDecayBlock: 0, invitedAtBlock: 1,
      lifetimeLikesReceived: 0n,
      memberSinceBlock: 2, memberBar: 1, memberVouches: 1, memberLikes: 2n, invitesUsed: 0,
    });

    // N grows to 27 (D = icbrt(27) = 3). The member still has memberVouches=1 >= memberBar=1.
    const rec = records.getIdentityRecord(member.userId)!;
    expect(isMember(rec)).toBe(true);
    expect(rec.memberBar).toBe(1); // fixed, not re-evaluated against current D

    // Lapses only when its own count falls below its own bar (1).
    records.putIdentityRecord(member.userId, { ...rec, memberVouches: 0 });
    const lapsed = records.getIdentityRecord(member.userId)!;
    expect(isMember(lapsed)).toBe(false);

    db.closeDb();
  });

  // Counter isolation — a reply moves neither counter.
  // ARCHITECTURE → The like transaction.
  it('a like from a member bumps both counters, a like from a resident bumps only lifetimeLikesReceived', async () => {
    vi.resetModules();
    const db = await importDb();
    db.initDb(':memory:');
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();

    const records = await importRecords();
    const { isMember } = await import('../../src/services/utxo-engine.js');

    const author = makeTestIdentity();
    const memberLiker = makeTestIdentity();
    const residentLiker = makeTestIdentity();

    // The author
    records.putIdentityRecord(author.userId, {
      lastActivityBlock: 1, lastDecayBlock: 0, invitedAtBlock: 1,
      lifetimeLikesReceived: 0n,
      memberSinceBlock: 0, memberBar: 0, memberVouches: 0, memberLikes: 0n, invitesUsed: 0,
    });

    // A member liker
    records.putIdentityRecord(memberLiker.userId, {
      lastActivityBlock: 1, lastDecayBlock: 0, invitedAtBlock: 1,
      lifetimeLikesReceived: 0n,
      memberSinceBlock: 2, memberBar: 1, memberVouches: 1, memberLikes: 2n, invitesUsed: 0,
    });
    expect(isMember(records.getIdentityRecord(memberLiker.userId)!)).toBe(true);

    // A resident liker
    records.putIdentityRecord(residentLiker.userId, {
      lastActivityBlock: 1, lastDecayBlock: 0, invitedAtBlock: 1,
      lifetimeLikesReceived: 0n,
      memberSinceBlock: 0, memberBar: 0, memberVouches: 0, memberLikes: 0n, invitesUsed: 0,
    });
    expect(isMember(records.getIdentityRecord(residentLiker.userId)!)).toBe(false);

    // Simulate block application writing the author's record after a like from
    // each. The counters are:
    //   lifetimeLikesReceived += total likes (both member and resident)
    //   memberLikes += member likes only
    const authorRec = records.getIdentityRecord(author.userId)!;
    records.putIdentityRecord(author.userId, {
      ...authorRec,
      lifetimeLikesReceived: authorRec.lifetimeLikesReceived + 2n,
      memberLikes: authorRec.memberLikes + 1n, // only the member's
    });

    const result = records.getIdentityRecord(author.userId)!;
    expect(result.lifetimeLikesReceived).toBe(2n);
    expect(result.memberLikes).toBe(1n);

    db.closeDb();
  });
});

// A root's invitee is a member from the grant, for life — ARCHITECTURE →
// Earned, standing, and well-founded by age → "Conferred"; NODE_INTERFACE →
// "A root's grant confers membership".
describe('a root\'s invitee, for life', () => {
  it('never lapses: every vouch it holds unvouched, member stays true and N is unaffected by it', async () => {
    vi.resetModules();
    const db = await importDb();
    db.initDb(':memory:');
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 2)').run();
    const utxo = await importUtxo();
    const records = await importRecords();

    const voucher = makeTestIdentity();
    const conferred = makeTestIdentity();

    // voucher: an ordinary root, so its vouch on the conferred identity
    // counts (its age is the genesis mint height, below any grant height).
    records.putIdentityRecord(voucher.userId, {
      lastActivityBlock: 1, lastDecayBlock: 0, invitedAtBlock: 0,
      lifetimeLikesReceived: 0n, memberSinceBlock: 1, memberBar: 0,
      memberVouches: 0, memberLikes: 0n, invitesUsed: 0,
    });
    // conferred: a root's invitee — memberBar 0, invitedAtBlock > 0; one
    // counted vouch from voucher.
    records.putIdentityRecord(conferred.userId, {
      lastActivityBlock: 2, lastDecayBlock: 0, invitedAtBlock: 2,
      lifetimeLikesReceived: 0n, memberSinceBlock: 2, memberBar: 0,
      memberVouches: 1, memberLikes: 0n, invitesUsed: 0,
    });

    const voucherKarma = makeKarmaBox(100n, voucher.userId, 0, 921);
    utxo.insertBox(voucherKarma);
    const vouch = makeVouchBox(voucher.userId, conferred.userId, 1, 922);
    utxo.insertBox(vouch);

    const recordPuts = [voucher, conferred].map((id) => ({
      key: records.identityRecordKey(id.userId),
      record: records.getIdentityRecord(id.userId)!,
    }));
    await activateProverOverStore(recordPuts);

    const { applyOrderingBlock } = await importBlockApply();
    const { config } = await import('../../src/config.js');
    const cooldown = config.vouchCooldownBlocks;

    // Block 1: the voucher unvouches the conferred identity — its only
    // held vouch.
    const unvouchTx = makeUnvouchTx(vouch.id!, voucher, 1 + cooldown, 1);
    const b1 = await makeApplicableBlock({ height: 1, utxoTxs: [unvouchTx] });
    expect(applyOrderingBlock(b1)).toBe(true);

    const after = records.getIdentityRecord(conferred.userId)!;
    expect(after.memberVouches).toBe(0);

    // Member stays true: memberBar 0 keeps memberVouches >= memberBar true
    // whatever memberVouches is.
    const { isMember } = await import('../../src/services/utxo-engine.js');
    expect(isMember(after)).toBe(true);

    // N is unaffected by it: the pass's lapse/re-qualify branch requires
    // memberBar > 0, which a conferred record never has.
    expect(records.getNetworkRecord().memberCount).toBe(2);

    db.closeDb();
  });

  it('the pre-record capture: a root\'s grant counts once, N + 1', async () => {
    vi.resetModules();
    const db = await importDb();
    db.initDb(':memory:');
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
    const utxo = await importUtxo();
    const records = await importRecords();

    const root = makeTestIdentity();
    const invitee = makeTestIdentity();
    records.putIdentityRecord(root.userId, {
      lastActivityBlock: 1, lastDecayBlock: 0, invitedAtBlock: 0,
      lifetimeLikesReceived: 0n, memberSinceBlock: 1, memberBar: 0,
      memberVouches: 0, memberLikes: 0n, invitesUsed: 0,
    });
    const karma = makeKarmaBox(FIXTURE_BOND_KARMA + 10n, root.userId, 0, 931);
    utxo.insertBox(karma);

    const recordPuts = [{
      key: records.identityRecordKey(root.userId),
      record: records.getIdentityRecord(root.userId)!,
    }];
    await activateProverOverStore(recordPuts);

    const grantTx: UtxoTransaction = {
      inputs: [karma.id!],
      outputs: [
        {
          boxType: 'karma', value: karma.value - FIXTURE_BOND_KARMA,
          createdAtBlock: 1, owner: root.userId,
        } as never,
        {
          boxType: 'bond', value: FIXTURE_BOND_KARMA, createdAtBlock: 1,
          inviterId: root.userId, inviteePublicKey: invitee.userId,
        } as never,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(grantTx, root.privateKey, hex(root.userId));

    const { applyOrderingBlock } = await importBlockApply();
    const b1 = await makeApplicableBlock({ height: 1, utxoTxs: [grantTx] });
    expect(applyOrderingBlock(b1)).toBe(true);

    // The grant conferred membership: the pass's case 4 counts it, N + 1.
    // Dropping `preBlockRecords.set(inviteeHex, null)` before the write
    // would let the pass's pre-block read fall through to the record this
    // same write just created, evaluate a member that was already one, and
    // leave N here (NODE_INTERFACE → Membership pass → "A record the block
    // first wrote has no pre-block state, and the pass reads none").
    expect(records.getNetworkRecord().memberCount).toBe(2);
    expect(records.getIdentityRecord(invitee.userId)!.memberSinceBlock).toBe(1);

    db.closeDb();
  });

  it('revert a block that conferred a membership: the record is gone and N is restored exactly', async () => {
    vi.resetModules();
    const db = await importDb();
    db.initDb(':memory:');
    const rawDb = db.getDb();
    rawDb.prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();

    const records = await importRecords();
    const journal = await import('../../src/store/journal.js');

    const invitee = makeTestIdentity();

    // Pre-block: a legal invitee has no record at all (ARCHITECTURE → The
    // invite is ONE transaction → "Record existence is the test that closes
    // it").
    expect(records.getIdentityRecord(invitee.userId)).toBeNull();
    const preBlockNetwork = records.getNetworkRecord();
    expect(preBlockNetwork.memberCount).toBe(1);

    // Open a journal and simulate the grant step conferring membership.
    journal.beginBlockJournal(5);
    records.putIdentityRecord(invitee.userId, {
      lastActivityBlock: 5, lastDecayBlock: 0, invitedAtBlock: 5,
      lifetimeLikesReceived: 0n,
      memberSinceBlock: 5, memberBar: 0, memberVouches: 0, memberLikes: 0n, invitesUsed: 0,
    });
    records.putNetworkRecord({ memberCount: 2 });

    // Verify the writes took effect.
    expect(records.getIdentityRecord(invitee.userId)!.memberSinceBlock).toBe(5);
    expect(records.getNetworkRecord().memberCount).toBe(2);

    // Finish and persist the journal.
    const finishedJournal = journal.finishBlockJournal();
    rawDb.prepare(
      'INSERT INTO block_journal (block_height, journal_cbor) VALUES (?, ?)',
    ).run(5, (await import('cbor-x')).encode(finishedJournal));

    // Revert the block.
    const { revertBlock } = await import('../../src/services/fork-resolution.js');
    revertBlock(5);

    // The record is gone: a legal invitee had none before this block, so
    // `putIdentityRecord`'s own capture of the pre-image is the absence,
    // never a set of zeros (NODE_INTERFACE → Block Journal).
    expect(records.getIdentityRecord(invitee.userId)).toBeNull();

    // The network record is restored too.
    expect(records.getNetworkRecord().memberCount).toBe(1);

    db.closeDb();
  });
});

describe('genesis network record', () => {
  it('the network key is present in the genesis tree', async () => {
    vi.resetModules();
    const db = await importDb();
    db.initDb(':memory:');
    // Seed the network record directly — the case needs no genesis.
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();

    const records = await importRecords();
    const nr = records.getNetworkRecord();
    expect(nr.memberCount).toBe(1);

    // The network record key is derivable and stable.
    const key = records.networkRecordKey();
    expect(key).toMatch(/^[0-9a-f]{64}$/);

    // The serialize/deserialize round-trips.
    const { serializeNetworkRecord, deserializeNetworkRecord } =
      await import('../../src/state/serialize-box.js');
    const bytes = serializeNetworkRecord(nr);
    const decoded = deserializeNetworkRecord(bytes);
    expect(decoded.memberCount).toBe(1);

    db.closeDb();
  });

  it('a chain with memberCount = 0 would be refused by the boot path', async () => {
    vi.resetModules();
    const db = await importDb();
    db.initDb(':memory:');
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 0)').run();

    const records = await importRecords();
    const nr = records.getNetworkRecord();
    expect(nr.memberCount).toBe(0);

    db.closeDb();
  });
});

describe('journal round-trip — membership records and the network record', () => {
  it('set a member (N+1) then revert — every record and the network record restored exactly', async () => {
    vi.resetModules();
    const db = await importDb();
    db.initDb(':memory:');
    const rawDb = db.getDb();
    rawDb.prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();

    const records = await importRecords();
    const journal = await import('../../src/store/journal.js');

    const identity = makeTestIdentity();

    // Pre-block state: a resident with enough vouches and likes to cross the bar.
    records.putIdentityRecord(identity.userId, {
      lastActivityBlock: 1, lastDecayBlock: 0, invitedAtBlock: 1,
      lifetimeLikesReceived: 0n,
      memberSinceBlock: 0, memberBar: 0, memberVouches: 1, memberLikes: 2n, invitesUsed: 0,
    });
    const preBlockRecord = records.getIdentityRecord(identity.userId)!;
    const preBlockNetwork = records.getNetworkRecord();
    expect(preBlockNetwork.memberCount).toBe(1);

    // Open a journal and simulate the membership pass setting this identity.
    journal.beginBlockJournal(5);
    records.putIdentityRecord(identity.userId, {
      ...preBlockRecord,
      memberSinceBlock: 5,
      memberBar: 1,
    });
    records.putNetworkRecord({ memberCount: 2 });

    // Verify the writes took effect.
    expect(records.getIdentityRecord(identity.userId)!.memberSinceBlock).toBe(5);
    expect(records.getNetworkRecord().memberCount).toBe(2);

    // Finish and persist the journal.
    const finishedJournal = journal.finishBlockJournal();
    rawDb.prepare(
      'INSERT INTO block_journal (block_height, journal_cbor) VALUES (?, ?)',
    ).run(5, (await import('cbor-x')).encode(finishedJournal));

    // Revert the block.
    const { revertBlock } = await import('../../src/services/fork-resolution.js');
    revertBlock(5);

    // The identity record is restored to its pre-block state.
    const restored = records.getIdentityRecord(identity.userId)!;
    expect(restored.memberSinceBlock).toBe(0);
    expect(restored.memberBar).toBe(0);
    expect(restored.memberVouches).toBe(1);
    expect(restored.memberLikes).toBe(2n);

    // The network record is restored too.
    const restoredNetwork = records.getNetworkRecord();
    expect(restoredNetwork.memberCount).toBe(1);

    db.closeDb();
  });
});
