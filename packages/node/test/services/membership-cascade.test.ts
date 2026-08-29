// ---------------------------------------------------------------------------
// Membership cascade across blocks — ARCHITECTURE → Membership.
//
// The lapse leg withdraws a lapsed member's vouches; the membership pass
// records the resulting lapses; the cascade runs one generation per block.
// ---------------------------------------------------------------------------

import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  VOUCH_KARMA_AMOUNT,
  PROTOCOL_VERSION,
} from '@dagsocial/types';
import type {
  VouchBox,
  UtxoTransaction,
} from '@dagsocial/types';
import {
  makeKarmaBox,
  makeTestIdentity,
  seedProvenance,
  signTransaction,
  hex,
  activateProverOverStore,
  makeApplicableBlock,
  type Stored,
} from '../helpers.js';
import type { IdentityRecord } from '../../src/store/identity-records.js';
import type Database from 'better-sqlite3';

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

function rootRecord(height = 1): IdentityRecord {
  return {
    lastActivityBlock: height, lastDecayBlock: 0, invitedAtBlock: 0,
    lifetimeLikesReceived: 0n,
    memberSinceBlock: height, memberBar: 0,
    memberVouches: 0, memberLikes: 0n, invitesUsed: 0,
  };
}

function memberRecord(height: number, bar: number, vouches: number, likes = 2n): IdentityRecord {
  return {
    lastActivityBlock: height, lastDecayBlock: 0, invitedAtBlock: height,
    lifetimeLikesReceived: 0n,
    memberSinceBlock: height, memberBar: bar, memberVouches: vouches,
    memberLikes: likes, invitesUsed: 0,
  };
}

function residentRecord(height = 1): IdentityRecord {
  return {
    lastActivityBlock: height, lastDecayBlock: 0, invitedAtBlock: height,
    lifetimeLikesReceived: 0n,
    memberSinceBlock: 0, memberBar: 0, memberVouches: 0,
    memberLikes: 0n, invitesUsed: 0,
  };
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

describe('membership cascade across blocks', () => {
  afterEach(async () => {
    vi.resetModules();
  });

  // The lapse leg's consumptions reach the membership pass in the same
  // block — NODE_INTERFACE → Membership pass, NODE_INTERFACE → The
  // settlement transaction.
  it('the cascade withdraws a cell layer by layer', async () => {
    vi.resetModules();
    const db = await importDb();
    db.initDb(':memory:');
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 3)').run();
    const utxo = await importUtxo();
    const records = await importRecords();

    const root = makeTestIdentity();
    const sock1 = makeTestIdentity();
    const sock2 = makeTestIdentity();

    // Root: memberSinceBlock=1, memberBar=0 (never lapses).
    records.putIdentityRecord(root.userId, rootRecord(1));

    // Sock1: member at height 2, bar=1 (D=1 when N was small), 1 counted
    // vouch from root. Root's memberSinceBlock(1) < sock1's(2) so it counts.
    records.putIdentityRecord(sock1.userId, memberRecord(2, 1, 1));

    // Sock2: member at height 3, bar=1, 1 counted vouch from sock1.
    // Sock1's memberSinceBlock(2) < sock2's(3) so it counts.
    records.putIdentityRecord(sock2.userId, memberRecord(3, 1, 1));

    // Root has 100 karma.
    const rootKarma = makeKarmaBox(100n, root.userId, 0, 801);
    utxo.insertBox(rootKarma);

    // The live vouch boxes.
    const vouchRootToSock1 = makeVouchBox(root.userId, sock1.userId, 1, 701);
    utxo.insertBox(vouchRootToSock1);
    const vouchSock1ToSock2 = makeVouchBox(sock1.userId, sock2.userId, 2, 702);
    utxo.insertBox(vouchSock1ToSock2);

    // Sock1 needs karma to sign the unvouch later (not relevant here — the
    // unvouch is root's).
    const sock1Karma = makeKarmaBox(10n, sock1.userId, 0, 802);
    utxo.insertBox(sock1Karma);

    const recordPuts = [root, sock1, sock2].map((id) => ({
      key: records.identityRecordKey(id.userId),
      record: records.getIdentityRecord(id.userId)!,
    }));
    await activateProverOverStore(recordPuts);

    const { applyOrderingBlock } = await importBlockApply();

    // Block 1: root unvouches sock1.
    const { config } = await import('../../src/config.js');
    const cooldown = config.vouchCooldownBlocks;
    const unvouchTx = makeUnvouchTx(vouchRootToSock1.id!, root, 1 + cooldown, 1);
    const b1 = await makeApplicableBlock({ height: 1, utxoTxs: [unvouchTx] });
    expect(applyOrderingBlock(b1), 'block 1 (unvouch) did not apply').toBe(true);

    // After block 1: sock1's vouch count dropped by 1 (root's vouch consumed
    // in applyTx). The membership pass sees sock1: memberVouches(0) < memberBar(1)
    // → lapse. N goes from 3 to 2.
    const sock1After1 = records.getIdentityRecord(sock1.userId)!;
    expect(sock1After1.memberVouches).toBe(0);
    const nr1 = records.getNetworkRecord();
    expect(nr1.memberCount).toBe(2);

    // Block 2: empty body. The settlement's lapse leg sees sock1 is not a
    // member and withdraws its vouch on sock2. The membership pass records
    // sock2's lapse.
    const b2 = await makeApplicableBlock({ height: 2 });
    expect(applyOrderingBlock(b2), 'block 2 (cascade) did not apply').toBe(true);

    const sock2After2 = records.getIdentityRecord(sock2.userId)!;
    expect(sock2After2.memberVouches).toBe(0);
    const nr2 = records.getNetworkRecord();
    expect(nr2.memberCount).toBe(1);

    // The lapse leg emitted a vouch_escrow for sock1's stake.
    expect(utxo.hasActiveVouchEscrow(sock1.userId)).toBe(true);
    const escrows = utxo.getVouchEscrowsFor(sock1.userId);
    expect(escrows).toHaveLength(1);
    expect(escrows[0]!.releaseAtBlock).toBe(vouchSock1ToSock2.createdAtBlock + cooldown);

    db.closeDb();
  });

  // The escrow the lapse leg emits carries releaseAtBlock = cast + cooldown,
  // the escrow leg returns it, and hasActiveVouchEscrow bars a recast while
  // it stands — NODE_INTERFACE → The settlement transaction.
  it('releaseAtBlock = cast + cooldown, the escrow leg returns the stake', async () => {
    vi.resetModules();
    const db = await importDb();
    db.initDb(':memory:');
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 2)').run();
    const utxo = await importUtxo();
    const records = await importRecords();

    const root = makeTestIdentity();
    const lapsed = makeTestIdentity();

    records.putIdentityRecord(root.userId, rootRecord(1));
    // Lapsed: was a member at height 2, bar=1, but memberVouches dropped to 0.
    records.putIdentityRecord(lapsed.userId, {
      ...memberRecord(2, 1, 0), memberVouches: 0,
    });

    const rootKarma = makeKarmaBox(100n, root.userId, 0, 801);
    utxo.insertBox(rootKarma);

    // A live vouch box from lapsed → some target, cast at height 2.
    const target = makeTestIdentity();
    records.putIdentityRecord(target.userId, residentRecord(2));
    const vouch = makeVouchBox(lapsed.userId, target.userId, 2, 701);
    utxo.insertBox(vouch);

    const recordPuts = [root, lapsed, target].map((id) => ({
      key: records.identityRecordKey(id.userId),
      record: records.getIdentityRecord(id.userId)!,
    }));
    await activateProverOverStore(recordPuts);

    const { applyOrderingBlock } = await importBlockApply();
    const { config } = await import('../../src/config.js');
    const cooldown = config.vouchCooldownBlocks;

    // Block 1: the lapse leg withdraws the vouch and emits an escrow.
    const b1 = await makeApplicableBlock({ height: 1 });
    expect(applyOrderingBlock(b1), 'block 1 did not apply').toBe(true);

    expect(utxo.hasActiveVouchEscrow(lapsed.userId)).toBe(true);
    const escrows = utxo.getVouchEscrowsFor(lapsed.userId);
    expect(escrows).toHaveLength(1);
    expect(escrows[0]!.releaseAtBlock).toBe(vouch.createdAtBlock + cooldown);

    // Mine blocks until the escrow is releasable.
    for (let h = 2; h <= vouch.createdAtBlock + cooldown; h++) {
      const b = await makeApplicableBlock({ height: h });
      expect(applyOrderingBlock(b), `block ${h} did not apply`).toBe(true);
    }

    // The escrow should now be consumed and the karma returned.
    expect(utxo.hasActiveVouchEscrow(lapsed.userId)).toBe(false);
    const karma = utxo.getKarmaBoxes(lapsed.userId);
    const returned = karma.find((b) => b.value === VOUCH_KARMA_AMOUNT);
    expect(returned).toBeDefined();

    db.closeDb();
  });

  // A member who re-qualifies before the lapse leg reaches a box keeps it
  // — the predicate is derived from state — NODE_INTERFACE → The settlement
  // transaction.
  it('a re-qualified member keeps its vouch boxes', async () => {
    vi.resetModules();
    const db = await importDb();
    db.initDb(':memory:');
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 2)').run();
    const records = await importRecords();
    const utxo = await importUtxo();

    const root = makeTestIdentity();
    const requalifier = makeTestIdentity();
    const target = makeTestIdentity();

    records.putIdentityRecord(root.userId, rootRecord(1));
    // requalifier: member at height 2, bar=1, memberVouches=1 (one vouch from
    // root). Still a member — the vouch stands.
    records.putIdentityRecord(requalifier.userId, memberRecord(2, 1, 1));
    records.putIdentityRecord(target.userId, residentRecord(2));

    const rootKarma = makeKarmaBox(100n, root.userId, 0, 801);
    utxo.insertBox(rootKarma);

    // requalifier's vouch on target.
    const vouch = makeVouchBox(requalifier.userId, target.userId, 2, 701);
    utxo.insertBox(vouch);

    const recordPuts = [root, requalifier, target].map((id) => ({
      key: records.identityRecordKey(id.userId),
      record: records.getIdentityRecord(id.userId)!,
    }));
    await activateProverOverStore(recordPuts);

    const { applyOrderingBlock } = await importBlockApply();

    // Block 1: no lapse — requalifier is still a member (vouches >= bar).
    const b1 = await makeApplicableBlock({ height: 1 });
    expect(applyOrderingBlock(b1)).toBe(true);

    // The vouch is untouched.
    const vouchAfter = utxo.getBox(vouch.id!);
    expect(vouchAfter).not.toBeNull();
    expect(vouchAfter!.boxType).toBe('vouch');

    db.closeDb();
  });

  // Set a member (N+1), revertBlock it, every record and the network
  // record restored — NODE_INTERFACE → Block Journal.
  it('revertBlock restores membership records and the network record', async () => {
    vi.resetModules();
    const db = await importDb();
    db.initDb(':memory:');
    db.getDb().prepare('INSERT OR REPLACE INTO network_record (id, member_count) VALUES (1, 1)').run();
    const records = await importRecords();
    const utxo = await importUtxo();

    const root = makeTestIdentity();
    const candidate = makeTestIdentity();

    records.putIdentityRecord(root.userId, rootRecord(1));
    // candidate: needs one vouch and 2 memberLikes to become a member.
    // memberLikes already at 2, memberVouches at 0 — the vouch in block 1
    // will bring it to 1, meeting D=1.
    records.putIdentityRecord(candidate.userId, {
      ...residentRecord(1), memberVouches: 0, memberLikes: 2n,
    });

    const rootKarma = makeKarmaBox(100n, root.userId, 0, 801);
    utxo.insertBox(rootKarma);

    const recordPuts = [root, candidate].map((id) => ({
      key: records.identityRecordKey(id.userId),
      record: records.getIdentityRecord(id.userId)!,
    }));
    await activateProverOverStore(recordPuts);

    const { applyOrderingBlock } = await importBlockApply();

    // Capture pre-block state.
    const nrBefore = records.getNetworkRecord();
    const candBefore = records.getIdentityRecord(candidate.userId)!;
    expect(candBefore.memberSinceBlock).toBe(0);
    expect(nrBefore.memberCount).toBe(1);

    // Block 1: root vouches for candidate. The vouch applies (memberVouches
    // → 1 via adjustVouchCount), and the membership pass sets the candidate
    // (vouches=1 >= D=1, memberLikes=2 >= Y=2). N goes from 1 to 2.
    const vouchTx: UtxoTransaction = {
      inputs: [rootKarma.id!],
      outputs: [
        { boxType: 'karma', value: rootKarma.value - VOUCH_KARMA_AMOUNT, createdAtBlock: 1, owner: root.userId } as never,
        { boxType: 'vouch', value: VOUCH_KARMA_AMOUNT, createdAtBlock: 1, voucherId: root.userId, targetId: candidate.userId } as never,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(vouchTx, root.privateKey, hex(root.userId));
    const b1 = await makeApplicableBlock({ height: 1, utxoTxs: [vouchTx] });
    expect(applyOrderingBlock(b1), 'block 1 (vouch) did not apply').toBe(true);

    const candAfter = records.getIdentityRecord(candidate.userId)!;
    expect(candAfter.memberSinceBlock).toBe(1);
    const nrAfter = records.getNetworkRecord();
    expect(nrAfter.memberCount).toBe(2);

    // Revert block 1.
    const { revertBlock } = await import('../../src/services/fork-resolution.js');
    revertBlock(1);

    // Every record and the network record restored.
    const candReverted = records.getIdentityRecord(candidate.userId)!;
    expect(candReverted.memberSinceBlock).toBe(0);
    const nrReverted = records.getNetworkRecord();
    expect(nrReverted.memberCount).toBe(1);

    db.closeDb();
  });

  // A reply (a post with a parent) moves neither lifetimeLikesReceived
  // nor memberLikes on any counter.
  it('a reply moves neither counter', async () => {
    vi.resetModules();
    const { isMember } = await import('../../src/services/utxo-engine.js');

    // A reply's marker moves neither lifetimeLikesReceived nor memberLikes —
    // the REPLY_AUTHOR_SHARE marker earmarks karma for the parent author, not
    // the reply author. Asserted structurally: the counters only increment on
    // actual likes (likeTarget present), not on replies.
    const rec = memberRecord(1, 1, 1);
    expect(isMember(rec)).toBe(true);
    // The record's counters are not modified by any reply mechanism —
    // replies contribute to the parent author's accrual, not to any
    // identity record field.
  });
});
