// ---------------------------------------------------------------------------
// The invite's block-application half.
//
// Everything a transaction cannot do lives here: the settlement's grant out of
// the karma pool, the `invitedAtBlock` write, the within-block duplicate-invitee
// refusal, and the probation-deadline settlement with its burn. None of them is
// expressible as a user transaction — a bond is consumed by no user transition,
// so no signature reaches it — and a suite over `validateTx` cannot see any of
// them (NODE_INTERFACE → "Bond transition rules").
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
  INVITE_BOND_VEST_PER_LIKES,
  PROTOCOL_VERSION,
  KARMA_STALE_THRESHOLD_BLOCKS,
  KARMA_DECAY_INTERVAL_BLOCKS,
  KARMA_DECAY_AMOUNT,
  KARMA_MINIMUM,
} from '@dagsocial/types';
import type {
  BondBox,
  KarmaBox,
  UtxoTransaction,
} from '@dagsocial/types';
import { config } from '../../src/config.js';
import {
  makeKarmaBox,
  makeLikeTx,
  makeTestConfig,
  makeTestIdentity,
  mineNextBlock,
  seedAsOneTx,
  signTransaction,
  uid,
  type TestIdentity, seedPostTx, makePostCommit, activateProverOverStore,
  seedKarmaPoolBox, makeApplicableBlock,
  FIXTURE_BOND_KARMA,
} from '../helpers.js';

/** Short enough that the deadline is reachable by mining a few real blocks. */
const PROBATION = 3;

/** One pre-seeded like: the post to publish, and the karma box that likes it. */
interface LikeFixture {
  commit: import('@dagsocial/types').PostCommit;
  content: string;
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
async function importBlockCreator() {
  return await import('../../src/services/block-creator.js');
}

/**
 * karma(v) → karma(v − bond) + BondBox — the whole invite, inviter-signed.
 *
 * The invitee's `FIXTURE_BOND_KARMA` is nowhere in it: the block's settlement
 * spends the pool for that (ARCHITECTURE → Invite System).
 */
function inviteTx(
  inviter: TestIdentity,
  invitee: TestIdentity,
  karmaIn: KarmaBox,
  bondValue = FIXTURE_BOND_KARMA,
): UtxoTransaction {
  const tx: UtxoTransaction = {
    inputs: [karmaIn.id!],
    outputs: [
      {
        boxType: 'karma',
        value: karmaIn.value - bondValue,
        createdAtBlock: 0,
        owner: inviter.userId,
      } as KarmaBox,
      {
        boxType: 'bond',
        value: bondValue,
        createdAtBlock: 0,
        inviterId: inviter.userId,
        inviteePublicKey: invitee.userId,
      } as BondBox,
    ],
    signatures: {},
    protocolVersion: PROTOCOL_VERSION,
  };
  signTransaction(tx, inviter.privateKey, Buffer.from(inviter.userId).toString('hex'));
  return tx;
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
   * Bring up a store with a live prover, the karma pool, and one bond already in
   * place — the state an invite leaves behind once its block has applied.
   *
   * ⛔ **The pool is not optional.** The settlement spends it to grant the
   * invitee, so a store without one cannot produce a block whose body creates a
   * bond (ARCHITECTURE → The conservation axiom).
   *
   * The prover is live because every path under test writes to it — a mint, a
   * consume, a record put — and a suite without one would assert the SQL side of
   * settlement while leaving the `stateRoot` untouched.
   */
  async function seedPair(
    bondValue = FIXTURE_BOND_KARMA,
    likeRounds: Array<{ count: number; nonceBase: number }> = [],
  ) {
    const db = await importDb();
    db.initDb(':memory:');
    const utxo = await importUtxo();
    await seedKarmaPoolBox();

    const inviter = makeTestIdentity();
    const invitee = makeTestIdentity();

    const [bond] = seedAsOneTx([
      {
        boxType: 'bond' as const,
        value: bondValue,
        createdAtBlock: 0,
        inviterId: inviter.userId,
        inviteePublicKey: invitee.userId,
      },
    ]);
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
        const { commit, tx: postTx, postId, content } = await seedPostTx(invitee, `post ${nonce}`);
        const liker = makeTestIdentity();
        const karma = makeKarmaBox(100n, liker.userId, 0, 500 + nonce);
        utxo.insertBox(karma);
        batch.push({ commit, content, postTx, postId, liker, karma });
      }
      likeBatches.push(batch);
    }

    // Last, so the tree is built over the pool, the bond and every like box
    // the blocks below spend. Still ahead of `startBlockCreator`, which is what
    // the emission box this also seeds has to precede: the creator's first
    // `rebuildTemplate` speculates over a body this store cannot apply without
    // one, and a `body-rejected` speculation **evicts the included mempool
    // entries** — so a seed arriving later would leave the creator building
    // correct, empty blocks over a pool it had already thrown away.
    await activateProverOverStore();

    return {
      utxo, inviter, invitee, likeBatches,
      bond: bond as BondBox,
    };
  }


  /**
   * Start the invitee's probation clock, the way the settlement's grant does.
   *
   * ⛔ **Seeded rather than mined, for the reason `lifetimeLikesReceived` is:**
   * the arithmetic under test below is the vesting, not the writer. The
   * end-to-end path — an invite transaction whose block's settlement writes this
   * height — is the subject of its own case at the top of this file.
   */
  async function startProbation(invitee: TestIdentity, invitedAtBlock: number): Promise<void> {
    const records = await importRecords();
    const before = records.getIdentityRecord(invitee.userId);
    records.putIdentityRecord(invitee.userId, {
      lastActivityBlock: before?.lastActivityBlock ?? invitedAtBlock,
      lastDecayBlock: before?.lastDecayBlock ?? 0,
      invitedAtBlock,
      lifetimeLikesReceived: before?.lifetimeLikesReceived ?? 0n,
    });
  }

  async function mineOne() {
    const bc = await importBlockCreator();
    bc.startBlockCreator(testConfig);
    return mineNextBlock(bc);
  }

  // -------------------------------------------------------------------------
  // The claim
  // -------------------------------------------------------------------------

  it('the settlement grants the invitee out of the pool and records the height', async () => {
    // ⛔ **The grant is a POOL SPEND, not a mint** (ARCHITECTURE → The
    // conservation axiom). One bond, one grant: the pairing is structural, so
    // the settlement reads the bond the body created and needs no marker.
    const db = await importDb();
    db.initDb(':memory:');
    const utxo = await importUtxo();
    await seedKarmaPoolBox();

    const inviter = makeTestIdentity();
    const invitee = makeTestIdentity();
    const karma = makeKarmaBox(FIXTURE_BOND_KARMA + 10n, inviter.userId, 0, 77);
    utxo.insertBox(karma);
    await activateProverOverStore();

    const poolBefore = utxo.getKarmaPoolBox()!.value;

    const mempool = await importMempool();
    const records = await importRecords();
    mempool.insertUtxoTx(inviteTx(inviter, invitee, karma), 1000);
    const block = await mineOne();
    expect(block).not.toBeNull();
    const height = block!.header.height;

    // The grant landed on the key the bond names …
    expect(utxo.getKarmaValue(invitee.userId)).toBe(FIXTURE_BOND_KARMA);
    // … and the pool paid for it, exactly.
    expect(utxo.getKarmaPoolBox()!.value).toBe(poolBefore - FIXTURE_BOND_KARMA);
    // The bond is live: it waits for its deadline.
    expect(utxo.getBondFor(invitee.userId)).not.toBeNull();
    // The inviter paid the bond and nothing else.
    expect(utxo.getKarmaValue(inviter.userId)).toBe(10n);

    const record = records.getIdentityRecord(invitee.userId);
    expect(record!.invitedAtBlock).toBe(height);
    // The clock epoch: lastActivityBlock starts at the claim height, not 0
    // (NODE_INTERFACE → Identity Records). The grant output carries
    // nonActivity: true, so insertBox does not bump the clock — the epoch is
    // the record write's.
    expect(record!.lastActivityBlock).toBe(height);
  });

  it('an invitee acting within the staleness threshold is NOT squared', async () => {
    // The positive path: the clock epoch means a freshly-granted invitee is
    // not stale, so their first self-action does not trigger decay squaring
    // and the granted face value survives intact minus the act's own cost.
    const db = await importDb();
    db.initDb(':memory:');
    const utxo = await importUtxo();
    await seedKarmaPoolBox();

    const inviter = makeTestIdentity();
    const invitee = makeTestIdentity();
    const karma = makeKarmaBox(FIXTURE_BOND_KARMA + 10n, inviter.userId, 0, 77);
    utxo.insertBox(karma);

    await activateProverOverStore();

    const mempool = await importMempool();
    const records = await importRecords();
    const types = await import('@dagsocial/types');

    // Block 1: the invite.
    mempool.insertUtxoTx(inviteTx(inviter, invitee, karma), 1000);
    const inviteBlock = await mineOne();
    expect(inviteBlock).not.toBeNull();
    const claimHeight = inviteBlock!.header.height;
    expect(records.getIdentityRecord(invitee.userId)!.lastActivityBlock).toBe(claimHeight);

    const grantedKarma = utxo.getKarmaValue(invitee.userId);
    expect(grantedKarma).toBe(FIXTURE_BOND_KARMA);

    // Block 2 (within the threshold): the invitee posts — a self-action that
    // touches their karma via the post-lock. Build the tx against the
    // GRANTED karma box, not a pre-seeded fixture. The settlement must NOT
    // square them because they are not stale: claimHeight + 1 is well within
    // KARMA_STALE_THRESHOLD_BLOCKS of the claim.
    const grantedBox = utxo.getKarmaBoxes(invitee.userId);
    expect(grantedBox.length).toBe(1);

    const postCommit = makePostCommit(invitee.userId, 'first post');
    const { POST_LOCK_THREAD_COST } = types;
    const postTx: UtxoTransaction = {
      inputs: [grantedBox[0]!.id!],
      outputs: [
        { boxType: 'karma', value: grantedKarma - POST_LOCK_THREAD_COST, createdAtBlock: 0, owner: invitee.userId } as never,
        { boxType: 'post_lock', value: POST_LOCK_THREAD_COST, createdAtBlock: 0, originalValue: POST_LOCK_THREAD_COST, owner: invitee.userId } as never,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
      post: postCommit,
    };
    signTransaction(postTx, invitee.privateKey, Buffer.from(invitee.userId).toString('hex'));

    const postId = types.computePostId(types.computeTxId(postTx), 0);
    const posts = await import('../../src/store/posts.js');
    posts.insertPost(postId, postCommit, 'first post');
    mempool.insertUtxoTx(postTx, 1000);
    const postBlock = await mineOne();
    expect(postBlock).not.toBeNull();

    // Face value after posting: granted minus the thread lock cost. No decay
    // squaring happened — the full granted amount is still there, less only
    // the lock.
    const afterPost = utxo.getKarmaValue(invitee.userId);
    expect(afterPost).toBe(grantedKarma - POST_LOCK_THREAD_COST);

    // The mechanism: lastActivityBlock is still the claim height (the post
    // advances it to block 2, which is even more recent).
    const afterRecord = records.getIdentityRecord(invitee.userId)!;
    expect(afterRecord.lastActivityBlock).toBeGreaterThanOrEqual(claimHeight);
  });

  it('an invitee idle past the threshold decays from the claim height, not from 0', async () => {
    // The boundary path: the epoch shifts where decay measures from. An
    // invitee whose clock started at 0 would owe periods back to genesis; one
    // whose clock starts at the claim height owes only from there.
    //
    // Pick a claim height and test height so the owed-periods differ enough
    // to produce different effective karma. With KARMA_DECAY_AMOUNT = 5 and
    // FIXTURE_BOND_KARMA = 25, it takes 3 periods to reach the floor (10).
    // The claim-epoch identity must owe <= 2 periods while the clock-0
    // identity owes >= 3.
    const db = await importDb();
    db.initDb(':memory:');
    const records = await importRecords();

    const { isIdentityStale, owedPeriods: owedPeriodsFromDecay, effectiveKarma } =
      await import('../../src/services/decay.js');

    // Claimed at a height that puts the claim-epoch owed periods at exactly 1
    // when measured at boundaryHeight, while the clock-0 identity owes many
    // more. claimHeight chosen so (boundaryHeight - claimHeight) / interval = 1.
    const claimHeight = KARMA_STALE_THRESHOLD_BLOCKS;
    const boundaryHeight = claimHeight + KARMA_STALE_THRESHOLD_BLOCKS + KARMA_DECAY_INTERVAL_BLOCKS;

    records.putIdentityRecord(uid('boundary-invitee'), {
      lastActivityBlock: claimHeight,
      lastDecayBlock: 0,
      invitedAtBlock: claimHeight,
      lifetimeLikesReceived: 0n,
    });

    const cfg = {
      staleThresholdBlocks: KARMA_STALE_THRESHOLD_BLOCKS,
      decayIntervalBlocks: KARMA_DECAY_INTERVAL_BLOCKS,
      decayAmount: BigInt(KARMA_DECAY_AMOUNT),
      karmaMinimum: BigInt(KARMA_MINIMUM),
    };

    const record = records.getIdentityRecord(uid('boundary-invitee'))!;

    // Stale: the identity has been idle for threshold + interval blocks.
    expect(isIdentityStale(record, boundaryHeight, cfg.staleThresholdBlocks)).toBe(true);
    const periods = owedPeriodsFromDecay(record, boundaryHeight, cfg.decayIntervalBlocks);
    // owedPeriods = floor((boundaryHeight − claimHeight) / interval) = threshold/interval + 1 = 29
    expect(periods).toBe(Math.floor(KARMA_STALE_THRESHOLD_BLOCKS / KARMA_DECAY_INTERVAL_BLOCKS) + 1);

    // Contrast: with clock 0 the owed periods are much larger.
    const clockZero = { ...record, lastActivityBlock: 0 };
    const periodsFromZero = owedPeriodsFromDecay(clockZero, boundaryHeight, cfg.decayIntervalBlocks);
    expect(periodsFromZero).toBeGreaterThan(periods);

    // Effective karma: from the claim height, only 29 periods of decay
    // (5 × 29 = 145, which exceeds 25 → clamped to min(25, 10) = 10).
    // But from clock 0, even MORE periods are owed.
    // To show the difference clearly, use a larger face value.
    const face = 200n;
    const effective = effectiveKarma(face, record, boundaryHeight, cfg);
    const effectiveFromZero = effectiveKarma(face, clockZero, boundaryHeight, cfg);
    // From the claim height: 200 - 29*5 = 200 - 145 = 55
    expect(effective).toBe(face - BigInt(periods) * cfg.decayAmount);
    // From clock 0: many more periods, floored to minimum.
    expect(effectiveFromZero).toBeLessThan(effective);
  });

  it('the grant bars the key from any further invite', async () => {
    // The settlement's grant is the record-CREATING event for every legal
    // invitee, and a key that holds a record is already an account — so one
    // grant is what makes a second invite for the same key unrepresentable in a
    // LATER block.
    const db = await importDb();
    db.initDb(':memory:');
    const utxo = await importUtxo();
    await seedKarmaPoolBox();

    const inviter = makeTestIdentity();
    const invitee = makeTestIdentity();
    const karma = makeKarmaBox(FIXTURE_BOND_KARMA + 10n, inviter.userId, 0, 78);
    utxo.insertBox(karma);
    const secondInviter = makeTestIdentity();
    const karma2 = makeKarmaBox(FIXTURE_BOND_KARMA + 10n, secondInviter.userId, 0, 79);
    utxo.insertBox(karma2);
    await activateProverOverStore();

    const mempool = await importMempool();
    const engine = await import('../../src/services/utxo-engine.js');
    const records = await importRecords();

    mempool.insertUtxoTx(inviteTx(inviter, invitee, karma), 1000);
    expect(await mineOne()).not.toBeNull();

    const second = inviteTx(secondInviter, invitee, karma2);
    const result = engine.validateTx({
      getBox: utxo.getBox,
      insertBox: utxo.insertBox,
      consumeBox: utxo.consumeBox,
      getKarmaBox: utxo.getKarmaBox,
      getKarmaValue: utxo.getKarmaValue,
      getIdentityRecord: records.getIdentityRecord,
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
      getTopologyAuthor: () => null,
      runInTransaction: (fn: () => void) => fn(),
    }, second, 2);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('may not name an existing account');
  });

  // -------------------------------------------------------------------------
  // The grant is the bond, and the bond is the inviter's to choose
  // -------------------------------------------------------------------------

  // ⛔ **TWO BONDS OF DIFFERENT VALUES IN ONE BLOCK.** A fixture using one value
  // passes equally against a settlement that multiplies a constant by the
  // invitee count, which is the shape this replaces — so the two amounts have to
  // differ for the assertion to have a subject.
  it('grants each invitee exactly the bond that named them', async () => {
    const db = await importDb();
    db.initDb(':memory:');
    const utxo = await importUtxo();
    await seedKarmaPoolBox();

    const small = config.inviteBondMin;
    const large = config.inviteBondMax;
    expect(small).not.toBe(large);

    const a = makeTestIdentity();
    const b = makeTestIdentity();
    const inviteeA = makeTestIdentity();
    const inviteeB = makeTestIdentity();
    const karmaA = makeKarmaBox(large + 10n, a.userId, 0, 91);
    const karmaB = makeKarmaBox(large + 10n, b.userId, 0, 92);
    utxo.insertBox(karmaA);
    utxo.insertBox(karmaB);
    await activateProverOverStore();

    const poolBefore = utxo.getKarmaPoolBox()!.value;
    const blockApply = await import('../../src/services/block-apply.js');

    const block = await makeApplicableBlock({
      utxoTxs: [
        inviteTx(a, inviteeA, karmaA, small),
        inviteTx(b, inviteeB, karmaB, large),
      ],
    });
    expect(blockApply.applyOrderingBlock(block)).toBe(true);

    expect(utxo.getKarmaValue(inviteeA.userId)).toBe(small);
    expect(utxo.getKarmaValue(inviteeB.userId)).toBe(large);
    // The pool is the grants' only source, so what left it equals what arrived —
    // and nothing more.
    expect(utxo.getKarmaPoolBox()!.value).toBe(poolBefore - (small + large));
  });

  // -------------------------------------------------------------------------
  // ⛔ Two inviters, one key, one block — the rule the collapse OWES
  // -------------------------------------------------------------------------

  it('a block whose body names one invitee twice does not apply', async () => {
    // ⛔ **A STATED RULE, because nothing else absorbs the collision**
    // (NODE_INTERFACE → Legal box transitions). One bond is one grant, so a
    // second bond naming a key an earlier transaction in this block already
    // named draws a second `FIXTURE_BOND_KARMA` out of the pool for one key.
    //
    // ⚠ **The record-existence test cannot see this.** The grant that writes
    // Bob's record is the settlement's, and it runs AFTER every embedded
    // transaction — so at the moment the second invite is validated Bob still
    // holds no record and that gate passes. Only an apply-time rule keyed on the
    // block's own body catches it.
    const db = await importDb();
    db.initDb(':memory:');
    const utxo = await importUtxo();
    await seedKarmaPoolBox();

    const invitee = makeTestIdentity();
    const a = makeTestIdentity();
    const b = makeTestIdentity();
    const karmaA = makeKarmaBox(FIXTURE_BOND_KARMA + 10n, a.userId, 0, 81);
    const karmaB = makeKarmaBox(FIXTURE_BOND_KARMA + 10n, b.userId, 0, 82);
    utxo.insertBox(karmaA);
    utxo.insertBox(karmaB);
    await activateProverOverStore();

    const blockApply = await import('../../src/services/block-apply.js');
    const records = await importRecords();

    // Both invites in ONE body, built directly — the creator's own fill skips
    // the second as an assembly preference, so a mined block could never carry
    // the pair and the consensus rule would go untested through that path.
    const block = await makeApplicableBlock({
      utxoTxs: [inviteTx(a, invitee, karmaA), inviteTx(b, invitee, karmaB)],
    });

    expect(blockApply.applyOrderingBlock(block)).toBe(false);

    // Nothing applied: no grant, no record, and both karma boxes untouched.
    expect(records.getIdentityRecord(invitee.userId)).toBeNull();
    expect(utxo.getKarmaValue(invitee.userId)).toBe(0n);
    expect(utxo.getBox(karmaA.id!)).not.toBeNull();
    expect(utxo.getBox(karmaB.id!)).not.toBeNull();
  });

  it('non-vacuity: the same two invites in SEPARATE blocks — the first applies', async () => {
    // Without this the rejection above could be the body failing for any other
    // reason. One invite alone applies and grants; the second is then refused by
    // the record-existence gate instead, which is the LATER-block half.
    const db = await importDb();
    db.initDb(':memory:');
    const utxo = await importUtxo();
    await seedKarmaPoolBox();

    const invitee = makeTestIdentity();
    const a = makeTestIdentity();
    const karmaA = makeKarmaBox(FIXTURE_BOND_KARMA + 10n, a.userId, 0, 83);
    utxo.insertBox(karmaA);
    await activateProverOverStore();

    const blockApply = await import('../../src/services/block-apply.js');
    const records = await importRecords();

    const block = await makeApplicableBlock({ utxoTxs: [inviteTx(a, invitee, karmaA)] });
    expect(blockApply.applyOrderingBlock(block)).toBe(true);
    expect(utxo.getKarmaValue(invitee.userId)).toBe(FIXTURE_BOND_KARMA);
    expect(records.getIdentityRecord(invitee.userId)!.invitedAtBlock).toBe(1);
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
  async function claimThenSettle(likes: bigint, bondValue = FIXTURE_BOND_KARMA) {
    const seeded = await seedPair(bondValue);
    const { utxo, inviter, invitee, bond } = seeded;
    await importMempool();
    const records = await importRecords();

    const firstBlock = await mineOne();
    expect(firstBlock).not.toBeNull();
    const invitedAtBlock = firstBlock!.header.height;

    await startProbation(invitee, invitedAtBlock);
    const started = records.getIdentityRecord(invitee.userId)!;
    expect(started.invitedAtBlock).toBe(invitedAtBlock);
    records.putIdentityRecord(invitee.userId, { ...started, lifetimeLikesReceived: likes });

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

  it('the sweep vests one karma per INVITE_BOND_VEST_PER_LIKES likes and burns the rest', async () => {
    // 40 likes → floor(40 / 3) = 13 vested out of a 25-karma bond; 12 burn. The
    // pin is derived from the ratio and then stated, so a retune moves one
    // number here rather than leaving the assertion true of whatever V becomes.
    const { utxo, bond, inviterKarma } = await claimThenSettle(40n);

    const expected = 40n / BigInt(INVITE_BOND_VEST_PER_LIKES);
    expect(expected).toBe(13n);
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
    // Nothing minted at all, not a zero-value box: `transferKarma` skips a
    // zero-value credit, so a fully-forfeit bond leaves the inviter with no
    // karma box.
    expect(utxo.getKarmaBox(inviter.userId)).toBeNull();
  });

  it('vesting is capped at the bond — extra likes mint nothing more', async () => {
    // 3 × 25 = 75 likes fully vests a 25-karma bond; 200 would vest 66 without
    // the `min`, minting 41 karma out of nothing.
    const { utxo, bond, inviterKarma } = await claimThenSettle(200n);

    expect(inviterKarma).toBe(bond.value);
    expect(inviterKarma).toBe(FIXTURE_BOND_KARMA);
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
  /**
   * Pool one pre-seeded batch of posts and their likes, and mine it.
   *
   * ⛔ **`author` is a parameter now, because the like's marker names it.** The
   * engine pins the marker against `block_topology` (NODE_INTERFACE → Karma
   * transition rules), so every post in a batch is the same author's — which is
   * already true of these fixtures: the invitee is the one earning the likes
   * that vest their inviter's bond.
   */
  async function poolLikes(batch: LikeFixture[], inviteeKey: Uint8Array) {
    const posts = await import('../../src/store/posts.js');
    const mempool = await importMempool();
    await import('@dagsocial/types');

    for (const { commit, content, postTx, postId, liker, karma } of batch) {
      posts.insertPost(postId, commit, content);
      mempool.insertUtxoTx(postTx, 1000);
      mempool.insertUtxoTx(makeLikeTx(liker, karma, postId, inviteeKey), 1000);
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
    const { utxo, inviter, invitee, bond, likeBatches } = await seedPair(
      FIXTURE_BOND_KARMA,
      [{ count: 3, nonceBase: 0 }, { count: 2, nonceBase: 10 }],
    );
    await importMempool();
    const records = await importRecords();

    const invitedAtBlock = (await mineOne())!.header.height;
    await startProbation(invitee, invitedAtBlock);
    expect(records.getIdentityRecord(invitee.userId)!.lifetimeLikesReceived).toBe(0n);

    // Block A: three likes. Block B: two more. floor(5 / 3) = 1 karma vested.
    await poolLikes(likeBatches[0]!, invitee.userId);
    expect(records.getIdentityRecord(invitee.userId)!.lifetimeLikesReceived).toBe(3n);
    await poolLikes(likeBatches[1]!, invitee.userId);
    // The SUM of the two batches, not the vesting ratio: what this test claims
    // is that the second block adds to the first, and reading the ratio here
    // would make the assertion true of a settlement that overwrote whenever the
    // batches happened to sum to it.
    expect(records.getIdentityRecord(invitee.userId)!.lifetimeLikesReceived).toBe(5n);

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
    const { utxo, inviter, invitee, bond, likeBatches } = await seedPair(
      FIXTURE_BOND_KARMA,
      [{ count: INVITE_BOND_VEST_PER_LIKES, nonceBase: 100 }],
    );
    await importMempool();
    const records = await importRecords();
    const db = await importDb();

    const invitedAtBlock = (await mineOne())!.header.height;
    await startProbation(invitee, invitedAtBlock);

    const postIds = await poolLikes(likeBatches[0]!, invitee.userId);
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

  it('the counter survives to the bond deadline under virtual decay', async () => {
    // Under virtual decay the invitee is untouched at the deadline, so no
    // decay settlement leg fires — the counter is trivially preserved. The
    // write-collision between decay and bond settlement needs a touch at the
    // deadline height; an empty block cannot reach it.
    const db = await import('../../src/store/db.js');
    db.initDb(':memory:');
    const utxo = await import('../../src/store/utxo.js');
    const records = await import('../../src/store/identity-records.js');
    const mempool = await import('../../src/store/mempool.js');
    await import('../../src/store/posts.js');
    const ordering = await import('../../src/store/ordering.js');
    const bc = await import('../../src/services/block-creator.js');
    await import('@dagsocial/types');

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
    // ⛔ **The invite rides a real block here**, because the invitee's karma has
    // to come from the settlement's grant: decay acts on karma boxes, and a
    // hand-seeded bond leaves the invitee holding nothing for it to act on.
    await seedKarmaPoolBox();
    const inviterKarma = makeKarmaBox(FIXTURE_BOND_KARMA + 5n, inviter.userId, 0, 880);
    utxo.insertBox(inviterKarma);

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

    // The invitee already holds the karma boxes their posts will lock, so the
    // grant is asserted as a DELTA rather than as a balance.
    const inviteeBefore = utxo.getKarmaValue(invitee.userId);
    mempool.insertUtxoTx(inviteTx(inviter, invitee, inviterKarma), 1000);
    const invitedAtBlock = (await mine()).header.height;
    // The settlement granted, and the grant started the clock.
    expect(utxo.getKarmaValue(invitee.userId)).toBe(inviteeBefore + FIXTURE_BOND_KARMA);
    expect(records.getIdentityRecord(invitee.userId)!.invitedAtBlock).toBe(invitedAtBlock);
    const bond = utxo.getBondFor(invitee.userId)!;

    // Five likes in one block → floor(5 / 5) = 1 karma vested at the deadline.
    for (const { postTx, postId, liker, karma } of likeFixtures) {
      // The post transaction itself, ahead of the like that targets it: a like
      // is rejected unless `block_topology` already names its target, and that
      // row is written when this transaction applies (NODE_INTERFACE → Post
      // transactions). Both ride the same block, in this order.
      mempool.insertUtxoTx(postTx, 1000);
      mempool.insertUtxoTx(makeLikeTx(liker, karma, postId, invitee.userId), 1000);
    }
    await mine();
    const earned = records.getIdentityRecord(invitee.userId)!.lifetimeLikesReceived;
    expect(earned).toBe(BigInt(INVITE_BOND_VEST_PER_LIKES));

    const deadline = invitedAtBlock + DECAY_PROBATION;
    while (ordering.getCurrentHeight() < deadline) await mine();

    // Under virtual decay no empty block touches the invitee, so no decay
    // fires and the clock is unchanged from the last touch.
    const after = records.getIdentityRecord(invitee.userId)!;
    expect(after.lifetimeLikesReceived).toBe(earned);
    // The bond settled on the correct counter — no forfeit.
    expect(utxo.getBox(bond.id!)).toBeNull();
    expect(utxo.getKarmaValue(inviter.userId)).toBe(5n + 1n);
  });
});
