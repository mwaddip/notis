// ---------------------------------------------------------------------------
// ⛔ THE CONSERVATION AXIOM, ASSERTED OVER THE LEDGER RATHER THAN OVER A PATH.
//
// `sum(every karma-bearing box) + pool` is constant at every height, from
// genesis (ARCHITECTURE → The conservation axiom). Every other suite in this
// package checks that one mechanism moved the value it was supposed to; this one
// checks that no mechanism moved value that came from nowhere, which is a
// different claim and the one the axiom actually makes.
//
// ## ⚠ IT IS A DIFFERENT SUM FROM `getTotalKarma`, AND CONFUSING THEM IS THE
// ERROR THE CONTRACT'S NOTE EXISTS TO PREVENT
//
// `getTotalKarma` reports **circulation** and excludes the pool deliberately: a
// figure that included it would be the genesis constant at every height on every
// network, which is to say it would stop reporting anything. The conservation
// total is `circulating + pool` — a different sum, over a different set, and
// asserting either against the other measures the wrong thing
// (NODE_INTERFACE → Three karma sets, and none derives from another).
//
// ## ⛔ THE SET IS ENUMERATED FROM `BOX_TYPE_TAGS`, NOT FROM A LIST WRITTEN HERE
//
// An invariant over a subset is worse than none, because it reads as the whole.
// So the classification below is **total over every box type the protocol has**,
// checked against `@dagsocial/types`' own table, and a type added later fails
// `every box type is classified` rather than being silently left out of the sum.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  BOX_TYPE_TAGS,
  INVITE_BOND_KARMA,
  INVITE_KARMA_AMOUNT,
  LIKE_KARMA_COST,
  LIKES_PER_KARMA_PAYOUT,
  PROTOCOL_VERSION,
  VOUCH_KARMA_AMOUNT,
} from '@dagsocial/types';
import type {
  BondBox,
  KarmaBox,
  LikeAccrualBox,
  UtxoTransaction,
  VouchBox,
  VouchEscrowBox,
} from '@dagsocial/types';
import {
  activateProverOverStore,
  makeApplicableBlock,
  makeKarmaBox,
  makeTestConfig,
  makeTestIdentity,
  seedPostTx,
  signTransaction,
  type TestIdentity,
} from '../helpers.js';

/** Short enough that a bond's deadline is reachable by mining a few blocks. */
const PROBATION = 3;
/** Short enough that an escrow releases inside a test's block budget. */
const COOLDOWN = 2;

const testConfig = makeTestConfig({
  dbPath: ':memory:',
  networkType: 'devnet' as const,
  nodeRole: 'miner' as const,
  orderingBlockPowTargetBits: 3072,
  inviteProbationBlocks: PROBATION,
  vouchCooldownBlocks: COOLDOWN,
});

// ---------------------------------------------------------------------------
// The conservation set — classified per type, exhaustively
// ---------------------------------------------------------------------------

/**
 * ⛔ **Every box type, with an explicit verdict.** Written out rather than
 * derived from `KARMA_SUPPLY_TYPES`, because that is the **supply** set and this
 * is the **conservation** set: they differ on `karma_pool` exactly, and a test
 * that reused the supply list would assert the circulation figure while claiming
 * to assert the axiom.
 */
const KARMA_BEARING: Readonly<Record<keyof typeof BOX_TYPE_TAGS, boolean>> = {
  karma: true,
  // Escrowed karma is held, not destroyed — the standing three.
  bond: true,
  post_lock: true,
  vouch: true,
  // The two this unit made reachable: a marker holds the liker's karma between
  // the like and the settlement, a carry box holds an author's remainder across
  // blocks, an escrow holds a voucher's stake for its cooldown.
  like_accrual: true,
  vouch_escrow: true,
  // ⛔ The half `getTotalKarma` excludes on purpose. Karma that exists and is not
  // in circulation.
  karma_pool: true,
  // The other ledger.
  credit: false,
  emission: false,
  treasury: false,
  fee: false,
  // Holds 0 by its type (TYPES_INTERFACE → GenesisProofBox).
  genesis_proof: false,
};

async function importDb() {
  return await import('../../src/store/db.js');
}
async function importUtxo() {
  return await import('../../src/store/utxo.js');
}
async function importBlockApply() {
  return await import('../../src/services/block-apply.js');
}
async function importRecords() {
  return await import('../../src/store/identity-records.js');
}
async function importTopology() {
  return await import('../../src/store/topology.js');
}

/**
 * `Σ karma-bearing box + pool`, read straight off the live UTXO set.
 *
 * ⛔ **It walks the boxes rather than any accumulator the node keeps.** The
 * karma-supply delta the store accounts at its choke point is derived from the
 * same inserts and consumes, so summing it would check the node's arithmetic
 * against itself. The rows are the ledger.
 */
async function conservationTotal(): Promise<bigint> {
  const { getDb } = await importDb();
  const rows = getDb()
    .prepare(
      `SELECT box_type, SUM(value) AS total FROM utxo_boxes
       WHERE spent_at_block IS NULL GROUP BY box_type`,
    )
    .safeIntegers()
    .all() as Array<{ box_type: string; total: bigint }>;
  let sum = 0n;
  for (const row of rows) {
    const bearing = KARMA_BEARING[row.box_type as keyof typeof BOX_TYPE_TAGS];
    // ⛔ An unclassified type is a failure, never a skip. Skipping is how an
    // invariant silently becomes an invariant over a subset.
    if (bearing === undefined) {
      throw new Error(`conservationTotal: unclassified box type ${row.box_type}`);
    }
    if (bearing) sum += row.total;
  }
  return sum;
}

describe('the conservation axiom holds over a chain', () => {
  beforeEach(async () => {
    vi.doMock('../../src/config.js', async () => {
      const actual = await vi.importActual<typeof import('../../src/config.js')>(
        '../../src/config.js',
      );
      return {
        ...actual,
        config: Object.freeze({
          ...actual.config,
          inviteProbationBlocks: PROBATION,
          vouchCooldownBlocks: COOLDOWN,
        }),
      };
    });
    vi.resetModules();
  });

  afterEach(async () => {
    vi.doUnmock('../../src/config.js');
    vi.resetModules();
  });

  it('every box type the protocol has is classified', () => {
    // ⛔ The guard that keeps this suite from quietly narrowing. A box type added
    // to `BOX_TYPE_TAGS` with no verdict here would otherwise drop out of the sum
    // and the invariant would keep passing over less of the ledger than it
    // claims.
    for (const boxType of Object.keys(BOX_TYPE_TAGS)) {
      expect(
        KARMA_BEARING[boxType as keyof typeof BOX_TYPE_TAGS],
        `${boxType} has no conservation verdict`,
      ).toBeTypeOf('boolean');
    }
    expect(Object.keys(KARMA_BEARING).sort()).toEqual(Object.keys(BOX_TYPE_TAGS).sort());
  });

  it('the conservation set is NOT the supply set, and differs on exactly the pool', async () => {
    // ⚠ The two lists are one member apart, and this says so out loud rather
    // than leaving a reader to compare them by eye. If they ever coincide, one of
    // them is wrong.
    const { KARMA_SUPPLY_TYPES } = await import('../../src/karma-supply.js');
    const conservation = Object.entries(KARMA_BEARING)
      .filter(([, bearing]) => bearing)
      .map(([t]) => t)
      .sort();
    const supply = ([...KARMA_SUPPLY_TYPES] as string[]).sort();
    expect(conservation.filter((t) => !supply.includes(t))).toEqual(['karma_pool']);
    expect(supply.filter((t) => !conservation.includes(t))).toEqual([]);
  });

  /**
   * A store holding the pool, an inviter, a voucher, an author and their likers
   * — every actor a path below needs, all seeded before the prover bootstraps.
   *
   * ⛔ **Seeding order is load-bearing.** A box inserted after
   * `activateProverOverStore` is one the tree never received, so the first block
   * spending it asks for a removal the tree refuses.
   */
  async function seedWorld() {
    const db = await importDb();
    db.initDb(':memory:');
    const utxo = await importUtxo();

    const inviter = makeTestIdentity();
    const invitee = makeTestIdentity();
    const voucher = makeTestIdentity();
    const target = makeTestIdentity();
    const author = makeTestIdentity();

    // The inviter's stake, the voucher's balance, and one liker per like.
    const inviterKarma = makeKarmaBox(200n, inviter.userId, 0, 901);
    const voucherKarma = makeKarmaBox(50n, voucher.userId, 0, 902);
    utxo.insertBox(inviterKarma);
    utxo.insertBox(voucherKarma);

    // The author's post, and enough likers to cross one payout threshold with a
    // remainder left over — so the block exercises the payout, the pool sink and
    // the carry box in one settlement.
    const { post, tx: postTx, postId } = await seedPostTx(author, 'the liked post');
    const likers: Array<{ who: TestIdentity; karma: KarmaBox }> = [];
    for (let i = 0; i < LIKES_PER_KARMA_PAYOUT + 1; i++) {
      const who = makeTestIdentity();
      const karma = makeKarmaBox(20n, who.userId, 0, 950 + i);
      utxo.insertBox(karma);
      likers.push({ who, karma });
    }

    // ⛔ **THE POOL IS SEEDED LAST, AND FROM WHAT IS ACTUALLY IN CIRCULATION.**
    // `pool = KARMA_SUPPLY_TOTAL − circulating` is the ledger's shape, not an
    // accounting convenience: a fixture that hand-seeds karma boxes and then
    // seeds a FULL pool has created karma at genesis, and the first burn that
    // returns any of it pushes the pool past the supply total — an out-of-domain
    // `value` the output shape refuses. Derived by summing the boxes rather than
    // by adding up the literals above, so a box added to this fixture cannot
    // silently unbalance it.
    const { ensureKarmaPoolBox } = await import('../../src/store/system.js');
    ensureKarmaPoolBox(await conservationTotal(), 0);

    await activateProverOverStore();
    return {
      utxo, inviter, invitee, voucher, target, author,
      inviterKarma, voucherKarma, post, postTx, postId, likers,
    };
  }

  /**
   * Apply a block and assert the total did not move.
   *
   * ⛔ **Measured before and after, at every height.** A single end-to-end
   * comparison would pass over a block that created value and a later one that
   * destroyed the same amount — which is the *"net-delta reconciliation is not
   * conservation"* shape the axiom names by hand.
   */
  async function applyAndConserve(
    block: Awaited<ReturnType<typeof makeApplicableBlock>>,
    what: string,
  ): Promise<void> {
    const before = await conservationTotal();
    const { applyOrderingBlock } = await importBlockApply();
    expect(applyOrderingBlock(block), `${what}: block did not apply`).toBe(true);
    const after = await conservationTotal();
    expect(after, `${what}: karma was created or destroyed`).toBe(before);
  }

  it('a like moves its cost into a marker and the settlement pays it out', async () => {
    const w = await seedWorld();
    const topology = await importTopology();

    // Height 1 confirms the post, so `block_topology` names its author — a
    // marker cannot be built before that (NODE_INTERFACE → Karma transition
    // rules: the author is resolved from `block_topology`).
    const b1 = await makeApplicableBlock({ height: 1, utxoTxs: [w.postTx] });
    await applyAndConserve(b1, 'the post block');
    topology.insertBlockTopology(w.postId, [], Buffer.from(w.author.userId).toString('hex'), 1);

    const authorHex = Buffer.from(w.author.userId).toString('hex');
    const likeTxs = w.likers.map(({ who, karma }) => {
      const tx: UtxoTransaction = {
        inputs: [karma.id!],
        outputs: [
          { boxType: 'karma', value: karma.value - LIKE_KARMA_COST, owner: who.userId } as KarmaBox,
          // ⛔ The marker carries the cost. Nothing is destroyed at cast.
          { boxType: 'like_accrual', value: LIKE_KARMA_COST, author: w.author.userId } as LikeAccrualBox,
        ],
        signatures: {},
        protocolVersion: PROTOCOL_VERSION,
        likeTarget: w.postId,
      };
      signTransaction(tx, who.privateKey, Buffer.from(who.userId).toString('hex'));
      return tx;
    });

    const utxo = await importUtxo();
    const before = await conservationTotal();
    const poolBefore = utxo.getKarmaPoolBox()!.value;
    // ⚠ **A delta, not an absolute.** The author already holds the change box
    // their own post transaction produced, so an absolute assertion here would
    // measure the fixture rather than the payout.
    const authorBefore = utxo.getKarmaValue(w.author.userId);

    const b2 = await makeApplicableBlock({ height: 2, utxoTxs: likeTxs });
    await applyAndConserve(b2, 'the like block');

    // ⛔ **The mechanism ran, not merely the arithmetic.** `x` likes pay the
    // author `x − 1`, one goes to the pool, and the remainder rides a carry box —
    // so a fixture with `x + 1` likers separates every leg from every other.
    expect(utxo.getKarmaValue(w.author.userId) - authorBefore).toBe(
      BigInt(LIKES_PER_KARMA_PAYOUT) - 1n,
    );
    // ⛔ **The pool is a SINK here and never a source** (ARCHITECTURE → Likes).
    // ⚠ **The author's figure alone does not carry the claim** — `x − 1` reaches
    // them whether the remaining 1 goes to the pool or nowhere, so the pool's
    // rise is the half that distinguishes a transfer from a destruction.
    expect(utxo.getKarmaPoolBox()!.value).toBe(poolBefore + 1n);
    const carry = utxo.getLikeCarryBox(w.author.userId, new Set<string>());
    expect(carry, 'the remainder rides a carry box').not.toBeNull();
    expect(carry!.value).toBe(1n);
    expect(Buffer.from(carry!.author).toString('hex')).toBe(authorHex);
    expect(await conservationTotal()).toBe(before);
  });

  it('an unvouch escrows the stake and the settlement releases it', async () => {
    const w = await seedWorld();
    const utxo = await importUtxo();

    // Cast: karma → karma + vouch.
    const castTx: UtxoTransaction = {
      inputs: [w.voucherKarma.id!],
      outputs: [
        {
          boxType: 'karma',
          value: w.voucherKarma.value - VOUCH_KARMA_AMOUNT,
          owner: w.voucher.userId,
        } as KarmaBox,
        {
          boxType: 'vouch',
          value: VOUCH_KARMA_AMOUNT,
          voucherId: w.voucher.userId,
          targetId: w.target.userId,
        } as VouchBox,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(castTx, w.voucher.privateKey, Buffer.from(w.voucher.userId).toString('hex'));
    const b1 = await makeApplicableBlock({ height: 1, utxoTxs: [castTx] });
    await applyAndConserve(b1, 'the vouch cast');

    const vouchBox = utxo
      .getUnspentBoxes()
      .find((b) => b.boxType === 'vouch') as VouchBox | undefined;
    expect(vouchBox, 'the cast created a VouchBox').toBeDefined();

    // Unvouch: vouch → vouch_escrow. ⛔ **The stake is HELD, not destroyed** —
    // the escrow is an ordinary output of the voucher's own transaction, so both
    // ends are named inside it (ARCHITECTURE → Vouch boxes).
    const unvouchTx: UtxoTransaction = {
      inputs: [vouchBox!.id!],
      outputs: [
        {
          boxType: 'vouch_escrow',
          value: vouchBox!.value,
          owner: w.voucher.userId,
          releaseAtBlock: 2 + COOLDOWN,
        } as VouchEscrowBox,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(unvouchTx, w.voucher.privateKey, Buffer.from(w.voucher.userId).toString('hex'));
    const b2 = await makeApplicableBlock({ height: 2, utxoTxs: [unvouchTx] });
    await applyAndConserve(b2, 'the unvouch');

    const escrow = utxo
      .getUnspentBoxes()
      .find((b) => b.boxType === 'vouch_escrow') as VouchEscrowBox | undefined;
    expect(escrow, 'the stake is held in a box, not destroyed').toBeDefined();
    expect(escrow!.value).toBe(vouchBox!.value);

    // Mine to the release height. The settlement consumes the escrow and returns
    // the karma to its owner.
    const heldBefore = utxo.getKarmaValue(w.voucher.userId);
    for (let h = 3; h <= 2 + COOLDOWN; h++) {
      await applyAndConserve(
        await makeApplicableBlock({ height: h }),
        `block ${h} on the way to release`,
      );
    }
    expect(
      utxo.getUnspentBoxes().some((b) => b.boxType === 'vouch_escrow'),
      'the escrow is spent at its release height',
    ).toBe(false);
    expect(utxo.getKarmaValue(w.voucher.userId)).toBe(heldBefore + vouchBox!.value);
  });

  it('a bond forfeit returns the unvested remainder to the pool', async () => {
    const w = await seedWorld();
    const utxo = await importUtxo();
    const records = await importRecords();

    const inviteTx: UtxoTransaction = {
      inputs: [w.inviterKarma.id!],
      outputs: [
        {
          boxType: 'karma',
          value: w.inviterKarma.value - INVITE_BOND_KARMA,
          owner: w.inviter.userId,
        } as KarmaBox,
        {
          boxType: 'bond',
          value: INVITE_BOND_KARMA,
          inviterId: w.inviter.userId,
          inviteePublicKey: w.invitee.userId,
        } as BondBox,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(inviteTx, w.inviter.privateKey, Buffer.from(w.inviter.userId).toString('hex'));

    const poolBefore = utxo.getKarmaPoolBox()!.value;
    const b1 = await makeApplicableBlock({ height: 1, utxoTxs: [inviteTx] });
    await applyAndConserve(b1, 'the invite');

    // The grant is a POOL SPEND: the invitee holds karma the pool no longer does.
    expect(utxo.getKarmaValue(w.invitee.userId)).toBe(INVITE_KARMA_AMOUNT);
    expect(utxo.getKarmaPoolBox()!.value).toBe(poolBefore - INVITE_KARMA_AMOUNT);
    expect(records.getIdentityRecord(w.invitee.userId)?.invitedAtBlock).toBe(1);

    // The invitee earns nothing, so the whole bond forfeits at the deadline.
    const poolAtDeadline = utxo.getKarmaPoolBox()!.value;
    const inviterBefore = utxo.getKarmaValue(w.inviter.userId);
    for (let h = 2; h <= 1 + PROBATION; h++) {
      await applyAndConserve(
        await makeApplicableBlock({ height: h }),
        `block ${h} on the way to the bond deadline`,
      );
    }

    // ⛔ **The forfeit is a transfer, and the sink is named.** ⚠ **Asserting
    // that the POOL ROSE by the bond is what carries the claim** — the inviter's
    // balance is unchanged whether the karma moved to the pool or ceased to
    // exist, so a balance check alone would pass on either.
    expect(
      utxo.getUnspentBoxes().some((b) => b.boxType === 'bond'),
      'the bond settled',
    ).toBe(false);
    expect(utxo.getKarmaValue(w.inviter.userId)).toBe(inviterBefore);
    expect(utxo.getKarmaPoolBox()!.value).toBe(poolAtDeadline + INVITE_BOND_KARMA);
  });

  it('a chain carrying every path at once conserves at every height', async () => {
    const w = await seedWorld();
    const topology = await importTopology();
    const utxo = await importUtxo();

    const genesisTotal = await conservationTotal();

    // 1 — the post, so the marker's author is resolvable.
    await applyAndConserve(
      await makeApplicableBlock({ height: 1, utxoTxs: [w.postTx] }),
      'height 1: the post',
    );
    topology.insertBlockTopology(w.postId, [], Buffer.from(w.author.userId).toString('hex'), 1);

    // 2 — the invite (a pool draw) and the vouch cast (an escrow-to-be), in one
    // body, so the settlement's pool leg is a NET figure rather than one draw.
    const inviteTx: UtxoTransaction = {
      inputs: [w.inviterKarma.id!],
      outputs: [
        {
          boxType: 'karma',
          value: w.inviterKarma.value - INVITE_BOND_KARMA,
          owner: w.inviter.userId,
        } as KarmaBox,
        {
          boxType: 'bond',
          value: INVITE_BOND_KARMA,
          inviterId: w.inviter.userId,
          inviteePublicKey: w.invitee.userId,
        } as BondBox,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(inviteTx, w.inviter.privateKey, Buffer.from(w.inviter.userId).toString('hex'));

    const castTx: UtxoTransaction = {
      inputs: [w.voucherKarma.id!],
      outputs: [
        {
          boxType: 'karma',
          value: w.voucherKarma.value - VOUCH_KARMA_AMOUNT,
          owner: w.voucher.userId,
        } as KarmaBox,
        {
          boxType: 'vouch',
          value: VOUCH_KARMA_AMOUNT,
          voucherId: w.voucher.userId,
          targetId: w.target.userId,
        } as VouchBox,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(castTx, w.voucher.privateKey, Buffer.from(w.voucher.userId).toString('hex'));

    await applyAndConserve(
      await makeApplicableBlock({ height: 2, utxoTxs: [inviteTx, castTx] }),
      'height 2: invite + vouch',
    );

    // 3 — the likes: markers in, a payout, a pool sink and a carry box out.
    const likeTxs = w.likers.map(({ who, karma }) => {
      const tx: UtxoTransaction = {
        inputs: [karma.id!],
        outputs: [
          { boxType: 'karma', value: karma.value - LIKE_KARMA_COST, owner: who.userId } as KarmaBox,
          { boxType: 'like_accrual', value: LIKE_KARMA_COST, author: w.author.userId } as LikeAccrualBox,
        ],
        signatures: {},
        protocolVersion: PROTOCOL_VERSION,
        likeTarget: w.postId,
      };
      signTransaction(tx, who.privateKey, Buffer.from(who.userId).toString('hex'));
      return tx;
    });
    await applyAndConserve(
      await makeApplicableBlock({ height: 3, utxoTxs: likeTxs }),
      'height 3: the likes',
    );

    // 4 — the unvouch, escrowing the stake.
    const vouchBox = utxo
      .getUnspentBoxes()
      .find((b) => b.boxType === 'vouch') as VouchBox;
    const unvouchTx: UtxoTransaction = {
      inputs: [vouchBox.id!],
      outputs: [
        {
          boxType: 'vouch_escrow',
          value: vouchBox.value,
          owner: w.voucher.userId,
          releaseAtBlock: 4 + COOLDOWN,
        } as VouchEscrowBox,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    };
    signTransaction(unvouchTx, w.voucher.privateKey, Buffer.from(w.voucher.userId).toString('hex'));
    await applyAndConserve(
      await makeApplicableBlock({ height: 4, utxoTxs: [unvouchTx] }),
      'height 4: the unvouch',
    );

    // 5..8 — empty blocks that carry the escrow release and the bond deadline.
    for (let h = 5; h <= 8; h++) {
      await applyAndConserve(
        await makeApplicableBlock({ height: h }),
        `height ${h}: settlement only`,
      );
    }

    // ⛔ Every path fired, and the total never moved.
    expect(
      utxo.getUnspentBoxes().some((b) => b.boxType === 'vouch_escrow'),
      'the escrow released',
    ).toBe(false);
    expect(
      utxo.getUnspentBoxes().some((b) => b.boxType === 'bond'),
      'the bond settled',
    ).toBe(false);
    expect(await conservationTotal()).toBe(genesisTotal);
  });
});
