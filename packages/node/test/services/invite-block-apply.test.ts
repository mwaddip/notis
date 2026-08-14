// ---------------------------------------------------------------------------
// The invite's block-application half.
//
// Everything a transaction cannot do lives here: the claim's `invitedAtBlock`
// write, the cancellation's bond return, and the probation-deadline settlement
// with its burn. None of the three is expressible as a user transaction — a
// bond's guard is `block_apply` and no signature satisfies it — so a suite over
// `validateTx` cannot see any of them (NODE_INTERFACE → "Bond transition
// rules").
//
// The settlement cases mock `inviteProbationBlocks` down to a handful of
// blocks. What has to hold is that the sweep fires at exactly
// `invitedAtBlock + INVITE_PROBATION_BLOCKS` on exactly the vested amount, and
// that is the same height comparison at 3 as at 43200 — mining forty-three
// thousand real blocks would test the same arithmetic after several hours of
// PoW. The mock is what every timescale-dependent suite in this package uses.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  INVITE_BOND_KARMA,
  INVITE_BOND_VEST_PER_LIKES,
  INVITE_KARMA_AMOUNT,
  PROTOCOL_VERSION,
} from '@dagsocial/types';
import type {
  BondBox,
  InviteBox,
  KarmaBox,
  UtxoTransaction,
} from '@dagsocial/types';
import {
  makeKarmaBox,
  makeTestConfig,
  makeTestIdentity,
  mineNextBlock,
  seedAsOneTx,
  signTransaction,
  type TestIdentity,
} from '../helpers.js';

/** Short enough that the deadline is reachable by mining a few real blocks. */
const PROBATION = 3;

const testConfig = makeTestConfig({
  dbPath: ':memory:',
  networkType: 'devnet' as const,
  nodeRole: 'miner' as const,
  orderingBlockPowTargetBits: 3072,
  inviteProbationBlocks: PROBATION,
});

async function importDb() {
  return await import('../../src/store/db.js');
}
async function importUtxo() {
  return await import('../../src/store/utxo.js');
}
async function importRecords() {
  return await import('../../src/store/identity-records.js');
}
async function importMempool() {
  return await import('../../src/store/mempool.js');
}
async function importLikes() {
  return await import('../../src/store/likes.js');
}
async function importTopology() {
  return await import('../../src/store/topology.js');
}
async function importBlockCreator() {
  return await import('../../src/services/block-creator.js');
}
async function importAvl() {
  return await import('../../src/state/avl-prover.js');
}

describe('the invite at block application', () => {
  beforeEach(async () => {
    // The probation length reaches the store's `getMaturedBonds` through the
    // config singleton, so the mock has to be in place before any module in the
    // graph is imported.
    vi.doMock('../../src/config.js', async () => {
      const actual = await vi.importActual<typeof import('../../src/config.js')>(
        '../../src/config.js',
      );
      return {
        ...actual,
        config: Object.freeze({ ...actual.config, inviteProbationBlocks: PROBATION }),
      };
    });
    vi.resetModules();
  });

  afterEach(async () => {
    try {
      (await importBlockCreator()).stopBlockCreator();
    } catch {
      // never imported
    }
    vi.doUnmock('../../src/config.js');
    vi.resetModules();
  });

  /**
   * Bring up a store with a live prover, and seed one invite/bond pair.
   *
   * The prover is live because every path under test writes to it — a mint, a
   * consume, a record put — and a suite without one would assert the SQL side of
   * settlement while leaving the `stateRoot` untouched.
   */
  async function seedPair(bondValue = INVITE_BOND_KARMA) {
    const db = await importDb();
    db.initDb(':memory:');
    const utxo = await importUtxo();
    const avl = await importAvl();
    avl.createAvlProver();

    const inviter = makeTestIdentity();
    const invitee = makeTestIdentity();

    const [invite, bond] = seedAsOneTx([
      {
        boxType: 'invite' as const,
        value: 0n,
        inviterId: inviter.userId,
        inviteePublicKey: invitee.userId,
        guard: 'invite_dual' as const,
      },
      {
        boxType: 'bond' as const,
        value: bondValue,
        inviterId: inviter.userId,
        inviteePublicKey: invitee.userId,
        guard: 'block_apply' as const,
      },
    ]);
    utxo.insertBox(invite!);
    utxo.insertBox(bond!);

    return {
      utxo, inviter, invitee,
      invite: invite as InviteBox,
      bond: bond as BondBox,
    };
  }

  /** Invite → one KarmaBox of INVITE_KARMA_AMOUNT, invitee-signed. */
  function claimTx(invite: InviteBox, invitee: TestIdentity): UtxoTransaction {
    const tx: UtxoTransaction = {
      inputs: [invite.id!],
      outputs: [{
        boxType: 'karma',
        value: INVITE_KARMA_AMOUNT,
        owner: invitee.userId,
        guard: 'owner_signature',
      } as KarmaBox],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(tx, invitee.privateKey, Buffer.from(invitee.userId).toString('hex'));
    return tx;
  }

  /** Invite → nothing, inviter-signed. */
  function cancelTx(invite: InviteBox, inviter: TestIdentity): UtxoTransaction {
    const tx: UtxoTransaction = {
      inputs: [invite.id!],
      outputs: [],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(tx, inviter.privateKey, Buffer.from(inviter.userId).toString('hex'));
    return tx;
  }

  async function mineOne() {
    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);
    return mineNextBlock(bc);
  }

  // -------------------------------------------------------------------------
  // The claim
  // -------------------------------------------------------------------------

  it('a claim mints the karma and records the height on the invitee', async () => {
    const { utxo, invite, invitee } = await seedPair();
    const mempool = await importMempool();
    const records = await importRecords();

    mempool.insertUtxoTx(claimTx(invite, invitee), null, 1000);
    const block = await mineOne();
    expect(block).not.toBeNull();
    const height = block!.header.height;

    // The mint: karma that did not exist before, owned by the named key.
    expect(utxo.getKarmaValue(invitee.userId)).toBe(INVITE_KARMA_AMOUNT);
    // The invite is spent; the bond is NOT — it waits for its deadline.
    expect(utxo.getBox(invite.id!)).toBeNull();
    expect(utxo.getBondFor(invitee.userId)).not.toBeNull();

    // The height, recorded once and read by two rules.
    const record = records.getIdentityRecord(invitee.userId);
    expect(record!.invitedAtBlock).toBe(height);
    // The claim's own karma output bumped the activity clock in the same block,
    // and the record write must carry that through rather than overwrite it.
    expect(record!.lastActivityBlock).toBe(height);
  });

  it('a claim bars the key from any further invite', async () => {
    // The other half of what `invitedAtBlock` is for. Once written, an invite
    // create naming the same key is refused by the transition arm.
    const { utxo, invite, invitee } = await seedPair();
    const mempool = await importMempool();
    const engine = await import('../../src/services/utxo-engine.js');
    const records = await importRecords();
    const cooldowns = await import('../../src/store/vouch-cooldowns.js');

    mempool.insertUtxoTx(claimTx(invite, invitee), null, 1000);
    expect(await mineOne()).not.toBeNull();

    const secondInviter = makeTestIdentity();
    const karma = makeKarmaBox(100n, secondInviter.userId, 0, 9);
    utxo.insertBox(karma);
    const second: UtxoTransaction = {
      inputs: [karma.id!],
      outputs: [
        {
          boxType: 'karma', value: 100n - INVITE_BOND_KARMA,
          owner: secondInviter.userId, guard: 'owner_signature',
        } as KarmaBox,
        {
          boxType: 'invite', value: 0n, inviterId: secondInviter.userId,
          inviteePublicKey: invitee.userId, guard: 'invite_dual',
        } as InviteBox,
        {
          boxType: 'bond', value: INVITE_BOND_KARMA, inviterId: secondInviter.userId,
          inviteePublicKey: invitee.userId, guard: 'block_apply',
        } as BondBox,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(second, secondInviter.privateKey, Buffer.from(secondInviter.userId).toString('hex'));

    const result = engine.validateTx({
      getBox: utxo.getBox,
      insertBox: utxo.insertBox,
      consumeBox: utxo.consumeBox,
      getKarmaBox: utxo.getKarmaBox,
      getKarmaValue: utxo.getKarmaValue,
      getIdentityRecord: records.getIdentityRecord,
      hasActiveVouchCooldown: cooldowns.hasActiveVouchCooldown,
      runInTransaction: (fn: () => void) => fn(),
    }, second, 2);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('invited only once');
  });

  // -------------------------------------------------------------------------
  // The cancellation
  // -------------------------------------------------------------------------

  it('a cancel returns the whole bond to the inviter', async () => {
    const { utxo, invite, inviter, invitee, bond } = await seedPair();
    const mempool = await importMempool();
    const records = await importRecords();

    expect(utxo.getKarmaValue(inviter.userId)).toBe(0n);

    mempool.insertUtxoTx(cancelTx(invite, inviter), null, 1000);
    expect(await mineOne()).not.toBeNull();

    // Whole, not vested: a cancellation happens before any claim, so there is
    // no probation to have failed.
    expect(utxo.getKarmaValue(inviter.userId)).toBe(bond.value);
    expect(utxo.getBox(bond.id!)).toBeNull();
    expect(utxo.getBondFor(invitee.userId)).toBeNull();
    expect(utxo.getInviteFor(invitee.userId)).toBeNull();

    // No claim happened, so the invitee's key is not barred and no clock ran.
    expect(records.getIdentityRecord(invitee.userId)?.invitedAtBlock ?? 0).toBe(0);
  });

  // -------------------------------------------------------------------------
  // The settlement sweep
  // -------------------------------------------------------------------------

  /**
   * Claim at height 1, give the invitee `likes` received likes, then mine to the
   * deadline and return what the inviter holds.
   *
   * Likes are `like_records` against posts the invitee authored in
   * `block_topology` — the two tables `getLikesReceivedCount` joins, and the
   * same authorship authority prune authorization reads.
   */
  async function claimThenSettle(likes: number, bondValue = INVITE_BOND_KARMA) {
    const seeded = await seedPair(bondValue);
    const { utxo, inviter, invitee, invite, bond } = seeded;
    const mempool = await importMempool();
    const records = await importRecords();
    const likeStore = await importLikes();
    const topology = await importTopology();

    mempool.insertUtxoTx(claimTx(invite, invitee), null, 1000);
    const claimBlock = await mineOne();
    expect(claimBlock).not.toBeNull();
    const invitedAtBlock = claimBlock!.header.height;
    expect(records.getIdentityRecord(invitee.userId)!.invitedAtBlock).toBe(invitedAtBlock);

    const inviteeHex = Buffer.from(invitee.userId).toString('hex');
    for (let i = 0; i < likes; i++) {
      const postId = i.toString(16).padStart(2, '0').repeat(32);
      topology.insertBlockTopology(postId, [], inviteeHex, invitedAtBlock);
      likeStore.insertLikeRecord(postId, new Uint8Array(32).fill(i + 1), invitedAtBlock);
    }

    const deadline = invitedAtBlock + PROBATION;
    const heights: number[] = [];
    while (heights.at(-1) !== deadline) {
      const block = await mineOne();
      expect(block).not.toBeNull();
      heights.push(block!.header.height);
      // Before the deadline the bond is untouched — the sweep is keyed on one
      // height, not on "past the deadline".
      if (block!.header.height < deadline) {
        expect(utxo.getBox(bond.id!), `height ${block!.header.height}`).not.toBeNull();
      }
    }

    return { ...seeded, invitedAtBlock, deadline, inviterKarma: utxo.getKarmaValue(inviter.userId) };
  }

  it('the sweep vests one karma per five likes and burns the rest', async () => {
    // 40 likes → floor(40 / 5) = 8 vested out of a 25-karma bond; 17 burn.
    const { utxo, bond, inviterKarma } = await claimThenSettle(40);

    const expected = BigInt(Math.floor(40 / INVITE_BOND_VEST_PER_LIKES));
    expect(expected).toBe(8n);
    expect(inviterKarma).toBe(expected);
    // The bond is consumed whole; the unvested part is destroyed rather than
    // parked in a remainder box.
    expect(utxo.getBox(bond.id!)).toBeNull();
    expect(inviterKarma).toBeLessThan(bond.value);
  });

  it('an invitee nobody liked forfeits the bond entirely', async () => {
    const { utxo, bond, inviter, inviterKarma } = await claimThenSettle(0);

    expect(inviterKarma).toBe(0n);
    expect(utxo.getBox(bond.id!)).toBeNull();
    // Nothing minted at all, not a zero-value box: `mintKarma` returns early at
    // 0, so a fully-forfeit bond leaves the inviter with no karma box.
    expect(utxo.getKarmaBox(inviter.userId)).toBeNull();
  });

  it('vesting is capped at the bond — extra likes mint nothing more', async () => {
    // 5 × 25 = 125 likes fully vests a 25-karma bond; 200 would vest 40 without
    // the `min`, minting 15 karma out of nothing.
    const { utxo, bond, inviterKarma } = await claimThenSettle(200);

    expect(inviterKarma).toBe(bond.value);
    expect(inviterKarma).toBe(INVITE_BOND_KARMA);
    expect(utxo.getBox(bond.id!)).toBeNull();
  });

  it('the sweep fires once, at the deadline, and not on later blocks', async () => {
    const { utxo, inviter, inviterKarma } = await claimThenSettle(40);

    // Two more blocks past the deadline: the bond is gone, so there is nothing
    // for a re-firing sweep to consume — and the inviter's balance must not
    // move again.
    expect(await mineOne()).not.toBeNull();
    expect(await mineOne()).not.toBeNull();
    expect(utxo.getKarmaValue(inviter.userId)).toBe(inviterKarma);
  });

  it('an UNCLAIMED bond does not settle when the chain reaches the probation length', async () => {
    // The sharp edge of the `0 = never invited` sentinel. The sweep resolves
    // `invitedAtBlock = height − INVITE_PROBATION_BLOCKS`, so at exactly height
    // `INVITE_PROBATION_BLOCKS` that expression is 0 — and unguarded, EVERY
    // identity that never claimed matches at once. Every open invite's bond
    // would settle for free, in one block, on a schedule nobody chose.
    //
    // ⚠ `getMaturedBonds` holds this shut TWICE — an early return and a SQL
    // predicate, the same rule in two languages — so this case only fails when
    // both are removed. Measured: weakening either alone leaves it green.
    const { utxo, inviter, invitee, bond } = await seedPair();
    const records = await importRecords();

    // The invitee has a record and has never been invited — the state of any
    // identity that has received karma, which is what makes the sentinel
    // collision reachable rather than hypothetical. A key with no record at all
    // would not match the sweep's join either way and would leave the guard
    // untested.
    records.putIdentityRecord(invitee.userId, {
      lastActivityBlock: 1,
      lastDecayBlock: 0,
      likeCarry: 0n,
      invitedAtBlock: 0,
    });
    expect(records.getIdentityRecord(invitee.userId)!.invitedAtBlock).toBe(0);

    let height = 0;
    while (height < PROBATION + 1) {
      const block = await mineOne();
      expect(block).not.toBeNull();
      height = block!.header.height;
    }

    // Past the height the sentinel would have matched at, and the bond has not
    // moved: an invite that was never claimed starts no clock at all.
    expect(utxo.getBox(bond.id!)).not.toBeNull();
    expect(utxo.getKarmaValue(inviter.userId)).toBe(0n);
    expect(utxo.getBondFor(invitee.userId)!.id).toBe(bond.id);
  });

  it('likes on someone else s posts do not vest this bond', async () => {
    // `getLikesReceivedCount` joins through `block_topology.author`, so the
    // count is the invitee's own received likes and not every like in the
    // chain. Without the join the bond would vest on the network's activity.
    const seeded = await seedPair();
    const { utxo, inviter, invitee, invite, bond } = seeded;
    const mempool = await importMempool();
    const likeStore = await importLikes();
    const topology = await importTopology();
    const records = await importRecords();

    mempool.insertUtxoTx(claimTx(invite, invitee), null, 1000);
    const claimBlock = await mineOne();
    const invitedAtBlock = claimBlock!.header.height;

    // 40 likes, every one of them on a stranger's post.
    const strangerHex = Buffer.from(makeTestIdentity().userId).toString('hex');
    for (let i = 0; i < 40; i++) {
      const postId = i.toString(16).padStart(2, '0').repeat(32);
      topology.insertBlockTopology(postId, [], strangerHex, invitedAtBlock);
      likeStore.insertLikeRecord(postId, new Uint8Array(32).fill(i + 1), invitedAtBlock);
    }

    const deadline = records.getIdentityRecord(invitee.userId)!.invitedAtBlock + PROBATION;
    let height = invitedAtBlock;
    while (height !== deadline) {
      const block = await mineOne();
      expect(block).not.toBeNull();
      height = block!.header.height;
    }

    expect(utxo.getKarmaValue(inviter.userId)).toBe(0n);
    expect(utxo.getBox(bond.id!)).toBeNull();
  });
});
