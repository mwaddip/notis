// ---------------------------------------------------------------------------
// The invite's block-application half.
//
// Everything a transaction cannot do lives here: the claim's `invitedAtBlock`
// write, the cancellation's bond return, and the probation-deadline settlement
// with its burn. None of the three is expressible as a user transaction — a
// bond is consumed by no user transition, so no signature reaches it — a suite over
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
  makeLikeTx,
  makePost,
  makeTestConfig,
  makeTestIdentity,
  mineNextBlock,
  seedAsOneTx,
  signTransaction,
  type TestIdentity, fixturePostId, fillerTx, seedPostTx, activateProverOverStore } from '../helpers.js';

/** Short enough that the deadline is reachable by mining a few real blocks. */
const PROBATION = 3;

/** One pre-seeded like: the post to publish, and the karma box that likes it. */
interface LikeFixture {
  post: ReturnType<typeof makePost>;
  postTx: UtxoTransaction;
  postId: string;
  liker: TestIdentity;
  karma: KarmaBox;
}

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

describe('the invite at block application', () => {
  beforeEach(async () => {
    // The probation length reaches `processMaturedBonds` through the config
    // singleton, so the mock has to be in place before any module in the graph
    // is imported.
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
  async function seedPair(
    bondValue = INVITE_BOND_KARMA,
    likeRounds: Array<{ count: number; nonceBase: number }> = [],
  ) {
    const db = await importDb();
    db.initDb(':memory:');
    const utxo = await importUtxo();

    const inviter = makeTestIdentity();
    const invitee = makeTestIdentity();

    const [invite, bond] = seedAsOneTx([
      {
        boxType: 'invite' as const,
        value: 0n,
        inviterId: inviter.userId,
        inviteePublicKey: invitee.userId,
      },
      {
        boxType: 'bond' as const,
        value: bondValue,
        inviterId: inviter.userId,
        inviteePublicKey: invitee.userId,
      },
    ]);
    utxo.insertBox(invite!);
    utxo.insertBox(bond!);

    // Every like round's boxes, seeded here rather than between the blocks that
    // spend them: a karma box inserted after the bootstrap is one the tree never
    // received, and the block spending it would ask for a removal the tree
    // refuses. `poolLikes` pools and mines each batch later.
    const likeBatches: LikeFixture[][] = [];
    for (const round of likeRounds) {
      const batch: LikeFixture[] = [];
      for (let i = 0; i < round.count; i++) {
        const nonce = round.nonceBase + i;
        const { post, tx: postTx, postId } = await seedPostTx(invitee, `post ${nonce}`);
        const liker = makeTestIdentity();
        const karma = makeKarmaBox(100n, liker.userId, 0, 500 + nonce);
        utxo.insertBox(karma);
        batch.push({ post, postTx, postId, liker, karma });
      }
      likeBatches.push(batch);
    }

    // Last, so the tree is built over the invite, the bond and every like box
    // the blocks below spend. Still ahead of `startBlockCreator`, which is what
    // the emission box this also seeds has to precede: the creator's first
    // `rebuildTemplate` speculates over a body this store cannot apply without
    // one, and a `body-rejected` speculation **evicts the included mempool
    // entries** — so a seed arriving later would leave the creator building
    // correct, empty blocks over a pool it had already thrown away.
    await activateProverOverStore();

    return {
      utxo, inviter, invitee, likeBatches,
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

    mempool.insertUtxoTx(claimTx(invite, invitee), 1000);
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
    // The claim is the record-CREATING event for every legal invitee, and a key
    // that holds a record is already an account — so one claim is what makes a
    // second invite for the same key unrepresentable.
    const { utxo, invite, invitee } = await seedPair();
    const mempool = await importMempool();
    const engine = await import('../../src/services/utxo-engine.js');
    const records = await importRecords();
    const cooldowns = await import('../../src/store/vouch-cooldowns.js');

    mempool.insertUtxoTx(claimTx(invite, invitee), 1000);
    expect(await mineOne()).not.toBeNull();

    const secondInviter = makeTestIdentity();
    const karma = makeKarmaBox(100n, secondInviter.userId, 0, 9);
    utxo.insertBox(karma);
    const second: UtxoTransaction = {
      inputs: [karma.id!],
      outputs: [
        {
          boxType: 'karma', value: 100n - INVITE_BOND_KARMA,
          owner: secondInviter.userId, 
        } as KarmaBox,
        {
          boxType: 'invite', value: 0n, inviterId: secondInviter.userId,
          inviteePublicKey: invitee.userId, 
        } as InviteBox,
        {
          boxType: 'bond', value: INVITE_BOND_KARMA, inviterId: secondInviter.userId,
          inviteePublicKey: invitee.userId, 
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
    expect(result.error).toContain('may not name an existing account');
  });

  // -------------------------------------------------------------------------
  // The cancellation
  // -------------------------------------------------------------------------

  it('a cancel returns the whole bond to the inviter', async () => {
    const { utxo, invite, inviter, invitee, bond } = await seedPair();
    const mempool = await importMempool();
    const records = await importRecords();

    expect(utxo.getKarmaValue(inviter.userId)).toBe(0n);

    mempool.insertUtxoTx(cancelTx(invite, inviter), 1000);
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
   * Claim, set the invitee's lifetime like count, mine to the deadline, and
   * return what the inviter holds.
   *
   * The count is written on the identity record, which is where the settlement
   * reads it and where per-block like settlement writes it. `earnLikes` below is
   * the end-to-end case that proves those two agree; these seed it directly, for
   * the same reason `invitedAtBlock` is seeded rather than mined for — the
   * arithmetic under test is the vesting, not the counter's writer.
   */
  async function claimThenSettle(likes: bigint, bondValue = INVITE_BOND_KARMA) {
    const seeded = await seedPair(bondValue);
    const { utxo, inviter, invitee, invite, bond } = seeded;
    const mempool = await importMempool();
    const records = await importRecords();

    mempool.insertUtxoTx(claimTx(invite, invitee), 1000);
    const claimBlock = await mineOne();
    expect(claimBlock).not.toBeNull();
    const invitedAtBlock = claimBlock!.header.height;

    const claimed = records.getIdentityRecord(invitee.userId)!;
    expect(claimed.invitedAtBlock).toBe(invitedAtBlock);
    records.putIdentityRecord(invitee.userId, { ...claimed, lifetimeLikesReceived: likes });

    const deadline = invitedAtBlock + PROBATION;
    let height = invitedAtBlock;
    while (height !== deadline) {
      const block = await mineOne();
      expect(block).not.toBeNull();
      height = block!.header.height;
      // Before the deadline the bond is untouched — the sweep is keyed on one
      // height, not on "past the deadline".
      if (height < deadline) {
        expect(utxo.getBox(bond.id!), `height ${height}`).not.toBeNull();
      }
    }

    return { ...seeded, invitedAtBlock, deadline, inviterKarma: utxo.getKarmaValue(inviter.userId) };
  }

  it('the sweep vests one karma per five likes and burns the rest', async () => {
    // 40 likes → floor(40 / 5) = 8 vested out of a 25-karma bond; 17 burn.
    const { utxo, bond, inviterKarma } = await claimThenSettle(40n);

    const expected = 40n / BigInt(INVITE_BOND_VEST_PER_LIKES);
    expect(expected).toBe(8n);
    expect(inviterKarma).toBe(expected);
    // The bond is consumed whole; the unvested part is destroyed rather than
    // parked in a remainder box.
    expect(utxo.getBox(bond.id!)).toBeNull();
    expect(inviterKarma).toBeLessThan(bond.value);
  });

  it('an invitee nobody liked forfeits the bond entirely', async () => {
    const { utxo, bond, inviter, inviterKarma } = await claimThenSettle(0n);

    expect(inviterKarma).toBe(0n);
    expect(utxo.getBox(bond.id!)).toBeNull();
    // Nothing minted at all, not a zero-value box: `mintKarma` returns early at
    // 0, so a fully-forfeit bond leaves the inviter with no karma box.
    expect(utxo.getKarmaBox(inviter.userId)).toBeNull();
  });

  it('vesting is capped at the bond — extra likes mint nothing more', async () => {
    // 5 × 25 = 125 likes fully vests a 25-karma bond; 200 would vest 40 without
    // the `min`, minting 15 karma out of nothing.
    const { utxo, bond, inviterKarma } = await claimThenSettle(200n);

    expect(inviterKarma).toBe(bond.value);
    expect(inviterKarma).toBe(INVITE_BOND_KARMA);
    expect(utxo.getBox(bond.id!)).toBeNull();
  });

  it('the sweep fires once, at the deadline, and not on later blocks', async () => {
    const { utxo, inviter, inviterKarma } = await claimThenSettle(40n);

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
    // ⚠ The rule is held shut TWICE — `processMaturedBonds`' early return and
    // `getBondsInvitedAt`'s SQL predicate, the same rule in two languages — so
    // this case only fails when both are removed. Measured: weakening either
    // alone leaves it green.
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
      lifetimeLikesReceived: 0n,
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

  // -------------------------------------------------------------------------
  // The counter, and what may not lower it
  // -------------------------------------------------------------------------

  /**
   * Earn `count` likes for `author` in ONE block, through the real pipeline —
   * so per-block like settlement is what moves the counter, not a fixture.
   *
   * Each like targets a post the same block confirms: apply rejects a like on an
   * unconfirmed target, and topology lands before the transaction loop, so
   * confirm-and-like-in-one-block is the valid shape. Distinct posts and
   * distinct likers, because one liker may like a post once.
   */
  /** Pool one pre-seeded batch of posts and their likes, and mine it. */
  async function poolLikes(batch: LikeFixture[]) {
    const posts = await import('../../src/store/posts.js');
    const mempool = await importMempool();
    const types = await import('@dagsocial/types');

    for (const { post, postTx, postId, liker, karma } of batch) {
      posts.insertPost(postId, post, types.encodePost(post));
      mempool.insertUtxoTx(postTx, 1000);
      mempool.insertUtxoTx(makeLikeTx(liker, karma, postId), 1000);
    }

    expect(await mineOne()).not.toBeNull();
    return batch.map((f) => f.postId);
  }

  /** Mine until the chain tip is `target`. */
  async function mineTo(target: number) {
    const ordering = await import('../../src/store/ordering.js');
    while (ordering.getCurrentHeight() < target) {
      expect(await mineOne()).not.toBeNull();
    }
    expect(ordering.getCurrentHeight()).toBe(target);
  }

  it('per-block like settlement ACCUMULATES the counter across blocks, and settlement reads it', async () => {
    // End to end: no fixture writes the count. If the settlement's reader and
    // the settlement's writer disagreed about the field, nothing else in this
    // suite would see it.
    //
    // Every like is earned AFTER the claim, and that is now the only reachable
    // order: an invite may not name an existing account, so a legal invitee has
    // no record — and therefore no karma, no posts and no likes — until the
    // claim creates one. "The claim drops a pre-existing counter" is closed by
    // construction rather than by a test.
    //
    // The likes are split across TWO blocks on purpose. That is what separates
    // accumulation from overwriting: a settlement that assigned this block's
    // count instead of adding it would leave the same total after a single
    // block and only diverge here.
    const { utxo, inviter, invitee, invite, bond, likeBatches } = await seedPair(
      INVITE_BOND_KARMA,
      [{ count: 3, nonceBase: 0 }, { count: 2, nonceBase: 10 }],
    );
    const mempool = await importMempool();
    const records = await importRecords();

    mempool.insertUtxoTx(claimTx(invite, invitee), 1000);
    const invitedAtBlock = (await mineOne())!.header.height;
    expect(records.getIdentityRecord(invitee.userId)!.lifetimeLikesReceived).toBe(0n);

    // Block A: three likes. Block B: two more. floor(5 / 5) = 1 karma vested.
    await poolLikes(likeBatches[0]!);
    expect(records.getIdentityRecord(invitee.userId)!.lifetimeLikesReceived).toBe(3n);
    await poolLikes(likeBatches[1]!);
    expect(records.getIdentityRecord(invitee.userId)!.lifetimeLikesReceived)
      .toBe(BigInt(INVITE_BOND_VEST_PER_LIKES));

    await mineTo(invitedAtBlock + PROBATION);

    expect(utxo.getBox(bond.id!)).toBeNull();
    expect(utxo.getKarmaValue(inviter.userId)).toBe(1n);
  });

  it('destroying the like-records does not lower the count a bond settles on', async () => {
    // ⚠ The defect the counter exists to close. Deleting every row of
    // `like_records` is exactly what prune settlement does to that table, and it
    // is a THIRD PARTY's action: the thread's author prunes, and under a count
    // derived from those rows the inviter — who did nothing — loses karma.
    // Design track §1.4.1 forbids destroying someone else's stake.
    const { utxo, inviter, invitee, invite, bond, likeBatches } = await seedPair(
      INVITE_BOND_KARMA,
      [{ count: INVITE_BOND_VEST_PER_LIKES, nonceBase: 100 }],
    );
    const mempool = await importMempool();
    const records = await importRecords();
    const db = await importDb();

    mempool.insertUtxoTx(claimTx(invite, invitee), 1000);
    const invitedAtBlock = (await mineOne())!.header.height;

    const postIds = await poolLikes(likeBatches[0]!);
    const earned = records.getIdentityRecord(invitee.userId)!.lifetimeLikesReceived;
    expect(earned).toBe(BigInt(INVITE_BOND_VEST_PER_LIKES));

    // Every like-record gone — the state prune leaves behind.
    db.getDb().prepare('DELETE FROM like_records').run();
    const likeStore = await importLikes();
    for (const postId of postIds) expect(likeStore.getLikeRecordCount(postId)).toBe(0);

    // The counter is untouched, and the bond still vests on it.
    expect(records.getIdentityRecord(invitee.userId)!.lifetimeLikesReceived).toBe(earned);

    await mineTo(invitedAtBlock + PROBATION);

    expect(utxo.getBox(bond!.id!)).toBeNull();
    expect(utxo.getKarmaValue(inviter.userId)).toBe(1n);
  });
});

// ---------------------------------------------------------------------------
// The decay writer, at the sweep's own height.
//
// Its own suite because it needs the decay knobs compressed as well as the
// probation length, and every case above asserts exact karma balances that a
// firing decay would move. The probation length here is deliberately longer
// than the stale threshold — which is the property devnet's 540 exists to give
// a real network (`network.ts` → inviteProbationBlocks).
// ---------------------------------------------------------------------------

const DECAY_PROBATION = 8;
const DECAY_STALE = 3;

describe('the invite at block application — decay adjacency', () => {
  beforeEach(async () => {
    vi.doMock('../../src/config.js', async () => {
      const actual = await vi.importActual<typeof import('../../src/config.js')>(
        '../../src/config.js',
      );
      return {
        ...actual,
        config: Object.freeze({
          ...actual.config,
          inviteProbationBlocks: DECAY_PROBATION,
          karmaStaleThresholdBlocks: DECAY_STALE,
          karmaDecayIntervalBlocks: 1,
        }),
      };
    });
    vi.resetModules();
  });

  afterEach(async () => {
    try {
      (await import('../../src/services/block-creator.js')).stopBlockCreator();
    } catch {
      // never imported
    }
    vi.doUnmock('../../src/config.js');
    vi.resetModules();
  });

  it('decay carries the counter through, and the sweep reads it in the same block', async () => {
    // Decay is step 12 of block application and the bond sweep is 12c, so at the
    // deadline the decay writer rewrites this record and the settlement reads it
    // back **in the same block**. A decay that passed `0` instead of the stored
    // value compiles, and would forfeit a bond the invitee had earned.
    //
    // This is the adjacency a probation shorter than the stale threshold makes
    // unreachable: under it the two never meet on one record, and the carry-
    // through goes untested on the only network the suite runs.
    const db = await import('../../src/store/db.js');
    db.initDb(':memory:');
    const utxo = await import('../../src/store/utxo.js');
    const records = await import('../../src/store/identity-records.js');
    const mempool = await import('../../src/store/mempool.js');
    const posts = await import('../../src/store/posts.js');
    const ordering = await import('../../src/store/ordering.js');
    const bc = await import('../../src/services/block-creator.js');
    const types = await import('@dagsocial/types');

    const cfg = makeTestConfig({
      dbPath: ':memory:',
      networkType: 'devnet' as const,
      nodeRole: 'miner' as const,
      orderingBlockPowTargetBits: 3072,
      inviteProbationBlocks: DECAY_PROBATION,
    });
    const mine = async () => {
      bc.startBlockCreator(cfg);
      const block = await mineNextBlock(bc);
      expect(block).not.toBeNull();
      return block!;
    };

    const inviter = makeTestIdentity();
    const invitee = makeTestIdentity();
    const [invite, bond] = seedAsOneTx([
      {
        boxType: 'invite' as const, value: 0n, inviterId: inviter.userId,
        inviteePublicKey: invitee.userId, 
      },
      {
        boxType: 'bond' as const, value: INVITE_BOND_KARMA, inviterId: inviter.userId,
        inviteePublicKey: invitee.userId, 
      },
    ]);
    utxo.insertBox(invite!);
    utxo.insertBox(bond!);

    // Every box the run spends, seeded before the tree is built from the store.
    // The transactions are pooled block by block below; only the boxes have to
    // be here, because a box the tree never received is one the block that
    // spends it cannot remove.
    const likeFixtures = [];
    for (let i = 0; i < INVITE_BOND_VEST_PER_LIKES; i++) {
      const { tx: postTx, postId } = await seedPostTx(invitee, `decay post ${i}`);
      const liker = makeTestIdentity();
      const karma = makeKarmaBox(100n, liker.userId, 0, 900 + i);
      utxo.insertBox(karma);
      likeFixtures.push({ postTx, postId, liker, karma });
    }

    // Last, so the tree covers every box the blocks below spend, and still ahead
    // of the first `startBlockCreator`, which the emission box it seeds must
    // precede.
    await activateProverOverStore();

    const claim: UtxoTransaction = {
      inputs: [invite!.id!],
      outputs: [{
        boxType: 'karma', value: INVITE_KARMA_AMOUNT, owner: invitee.userId,
      } as KarmaBox],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(claim, invitee.privateKey, Buffer.from(invitee.userId).toString('hex'));
    mempool.insertUtxoTx(claim, 1000);
    const invitedAtBlock = (await mine()).header.height;

    // Five likes in one block → floor(5 / 5) = 1 karma vested at the deadline.
    for (const { postTx, postId, liker, karma } of likeFixtures) {
      // The post transaction itself, ahead of the like that targets it: a like
      // is rejected unless `block_topology` already names its target, and that
      // row is written when this transaction applies (NODE_INTERFACE → Post
      // transactions). Both ride the same block, in this order.
      mempool.insertUtxoTx(postTx, 1000);
      mempool.insertUtxoTx(makeLikeTx(liker, karma, postId), 1000);
    }
    await mine();
    const earned = records.getIdentityRecord(invitee.userId)!.lifetimeLikesReceived;
    expect(earned).toBe(BigInt(INVITE_BOND_VEST_PER_LIKES));

    const deadline = invitedAtBlock + DECAY_PROBATION;
    while (ordering.getCurrentHeight() < deadline) await mine();

    // Decay really fired on the invitee — without this the case would pass on a
    // chain where the two writers never met, which is the whole hazard.
    const after = records.getIdentityRecord(invitee.userId)!;
    expect(after.lastDecayBlock).toBeGreaterThan(0);
    // ...and the counter survived every one of those writes.
    expect(after.lifetimeLikesReceived).toBe(earned);
    // ...so the bond settled on it rather than forfeiting.
    expect(utxo.getBox(bond!.id!)).toBeNull();
    expect(utxo.getKarmaValue(inviter.userId)).toBe(1n);
  });
});
