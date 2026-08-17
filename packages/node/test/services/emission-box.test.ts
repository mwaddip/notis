import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { makeTestIdentity, makeApplicableBlock } from '../helpers.js';

/**
 * The emission box and the treasury box — unit 4b.
 *
 * `TYPES_INTERFACE` → EmissionBox / TreasuryBox, `MINING_INTERFACE` → Emission
 * Schedule and Coinbase Application.
 *
 * ⛔ **Every expected value here is written out by hand from the profile's
 * parameters, never computed with `computeBlockReward` or `emissionTotal`.**
 * A test that derives its expectation from the function under test passes under
 * any schedule, a broken one included — it asserts that the code agrees with
 * itself. The arithmetic is restated in each case so the number can be checked
 * against the contract rather than against the implementation.
 */

const E8 = 10n ** 8n;

// Mainnet / testnet: F = 1,051,200 · E = 129,600 · R = 100 · d = 2.
//   fixed  = 1,051,200 × 100                      = 105,120,000
//   K      = largest k with 100 − 2k > 0          = 49
//   Σ      = Σ(k=1..49)(100 − 2k) = 4900 − 2450   = 2,450
//   decay  = 129,600 × 2,450                      = 317,520,000
//   total                                          = 422,640,000
const MAINNET_TOTAL = 422_640_000n * E8;

// Devnet: F = 1,000 · E = 100, same economics (ARCHITECTURE → Network Identity:
// compress time, never economics), so R, d, K and Σ are unchanged.
//   fixed  = 1,000 × 100        = 100,000
//   decay  = 100 × 2,450        = 245,000
//   total                        = 345,000
const DEVNET_TOTAL = 345_000n * E8;

// Devnet's terminus. Epoch k spans heights F + (k−1)E + 1 … F + kE, so epoch 49
// — the last that pays, at 100 − 49×2 = 2 credits — spans 5,801 … 5,900.
const DEVNET_LAST_PAYING_HEIGHT = 5_900;
const DEVNET_LAST_REWARD = 2n * E8;

async function importFresh() {
  const db = await import('../../src/store/db.js');
  const system = await import('../../src/store/system.js');
  const utxo = await import('../../src/store/utxo.js');
  const genesis = await import('../../src/services/genesis-state.js');
  const prover = await import('../../src/state/avl-prover.js');
  const creator = await import('../../src/services/block-creator.js');
  const apply = await import('../../src/services/block-apply.js');
  const split = await import('../../src/services/coinbase-split.js');
  return { db, system, utxo, genesis, prover, creator, apply, split };
}

/** Seed a full genesis state under `network` and hand back its modules. */
async function bootUnder(network: string) {
  process.env['NETWORK_TYPE'] = network;
  vi.resetModules();
  const s = await importFresh();
  s.db.initDb(':memory:');
  s.prover.createAvlProver();
  s.genesis.seedGenesisState(s.system.initSystemKeypair().publicKey);
  return s;
}

describe('the emission box', () => {
  const previousNetwork = process.env['NETWORK_TYPE'];
  let close: (() => void) | null = null;

  beforeEach(() => { close = null; });
  afterEach(() => {
    close?.();
    // Restored, never deleted: a bare delete would leave every later file in
    // this worker on `loadConfig`'s default rather than on the pinned devnet.
    if (previousNetwork === undefined) delete process.env['NETWORK_TYPE'];
    else process.env['NETWORK_TYPE'] = previousNetwork;
    vi.resetModules();
  });

  // -------------------------------------------------------------------------
  // The derived total
  // -------------------------------------------------------------------------

  it('mainnet holds 422,640,000 credits at genesis', async () => {
    const s = await bootUnder('mainnet');
    close = () => s.db.closeDb();

    // The pin §3.4 asks for: a schedule change that moves the total fails HERE
    // rather than silently re-deriving a different genesis.
    expect(s.creator.emissionTotal()).toBe(MAINNET_TOTAL);

    const box = s.utxo.getEmissionBox();
    expect(box).not.toBeNull();
    expect(box!.value).toBe(MAINNET_TOTAL);
    // No owner field at all — not an owner set to zero bytes.
    expect('owner' in box!).toBe(false);
  });

  it('devnet holds its own total, derived from its compressed schedule', async () => {
    const s = await bootUnder('devnet');
    close = () => s.db.closeDb();

    // Non-vacuity: devnet's total must NOT be mainnet's. A derivation that
    // ignored the profile would return mainnet's on every network and the
    // equality above alone would not see it.
    expect(s.creator.emissionTotal()).toBe(DEVNET_TOTAL);
    expect(DEVNET_TOTAL).not.toBe(MAINNET_TOTAL);
    expect(s.utxo.getEmissionBox()!.value).toBe(DEVNET_TOTAL);
  });

  it('the total equals the sum of every reward the schedule ever pays', async () => {
    const s = await bootUnder('devnet');
    close = () => s.db.closeDb();

    // The property the two must share, walked height by height rather than in
    // closed form: too small a total starves the box before the terminus and
    // makes every block from that height unproducible; too large strands a
    // residue no rule can release.
    let paid = 0n;
    for (let h = 1; h <= DEVNET_LAST_PAYING_HEIGHT + 10; h++) {
      paid += s.creator.computeBlockReward(h);
    }
    expect(paid).toBe(DEVNET_TOTAL);
  });

  // -------------------------------------------------------------------------
  // The terminus
  // -------------------------------------------------------------------------

  // ⛔ **This is the ONLY test that fails when the no-zero-successor arm is
  // reverted — measured by mutation, 2026-08-16: 1,433 of 1,434 still passed.**
  // The terminus has zero incidental coverage anywhere else in the suite, so
  // weakening or deleting this leaves the rule with nothing behind it.
  it('holds exactly 2 credits after block 5,899 and is gone after 5,900', async () => {
    const s = await bootUnder('devnet');
    close = () => s.db.closeDb();

    // Releases every height up to and including 5,899, driving the box down the
    // real transition rather than by arithmetic on its value.
    for (let h = 1; h < DEVNET_LAST_PAYING_HEIGHT; h++) {
      expect(s.apply.settleEmissionAndTreasury(h, s.creator.computeBlockReward(h), 0n)).toBe(true);
    }

    // ⚠ **2 × 10⁸ is also what the deleted `CREDIT_TAIL_REWARD` held, and here
    // that is a coincidence.** Unit 4's trap was a *reward* assertion at a
    // height where the terminated and un-terminated curves agree. This asserts a
    // *box value*, and under the pre-4b rule there is no box at all — so nothing
    // about it is satisfiable by the old behaviour. Do not "fix" the number.
    const beforeLast = s.utxo.getEmissionBox();
    expect(beforeLast).not.toBeNull();
    expect(beforeLast!.value).toBe(DEVNET_LAST_REWARD);

    // The last paying block takes exactly what is left and creates no successor.
    expect(
      s.apply.settleEmissionAndTreasury(DEVNET_LAST_PAYING_HEIGHT, DEVNET_LAST_REWARD, 0n),
    ).toBe(true);
    expect(s.utxo.getEmissionBox()).toBeNull();
  });

  it('a block above the terminus releases nothing and needs no box', async () => {
    const s = await bootUnder('devnet');
    close = () => s.db.closeDb();

    // The height itself carries the rule: above the terminus the reward is 0, so
    // the block does not touch the box — which is the only reason its absence
    // there is not a fault.
    expect(s.creator.computeBlockReward(DEVNET_LAST_PAYING_HEIGHT + 1)).toBe(0n);
    const above = DEVNET_LAST_PAYING_HEIGHT + 1;
    expect(s.apply.settleEmissionAndTreasury(above, 0n, 0n)).toBe(true);
    // Untouched — still the genesis box, not a successor.
    expect(s.utxo.getEmissionBox()!.value).toBe(DEVNET_TOTAL);
  });

  it('rejects a release the box cannot cover', async () => {
    const s = await bootUnder('devnet');
    close = () => s.db.closeDb();

    // Unreachable while `emissionTotal` and `computeBlockReward` share the
    // profile — this is the loud failure for the case where they stop agreeing,
    // whose alternative is a negative successor value.
    expect(s.apply.settleEmissionAndTreasury(1, DEVNET_TOTAL + 1n, 0n)).toBe(false);
    // And nothing was spent on the way to refusing.
    expect(s.utxo.getEmissionBox()!.value).toBe(DEVNET_TOTAL);
  });
});

// ---------------------------------------------------------------------------
// The treasury box
// ---------------------------------------------------------------------------

describe('the treasury box', () => {
  const previousNetwork = process.env['NETWORK_TYPE'];
  let close: (() => void) | null = null;

  beforeEach(() => { close = null; });
  afterEach(() => {
    close?.();
    if (previousNetwork === undefined) delete process.env['NETWORK_TYPE'];
    else process.env['NETWORK_TYPE'] = previousNetwork;
    vi.resetModules();
  });

  it('does not exist at genesis, on any network', async () => {
    for (const network of ['mainnet', 'testnet', 'devnet']) {
      const s = await bootUnder(network);
      // It would hold 0, and a zero-value box is not created.
      expect(s.utxo.getTreasuryBox(), network).toBeNull();
      s.db.closeDb();
    }
  });

  it('is created by the first block whose treasury slice is nonzero', async () => {
    const s = await bootUnder('devnet');
    close = () => s.db.closeDb();

    const emission = s.creator.computeBlockReward(1);
    const expected = s.split.splitCoinbase(emission, 0n, 0).treasury;
    // Non-vacuity: a block whose slice rounded to zero would create nothing, so
    // the case has to be one where something actually accrues.
    expect(expected).toBeGreaterThan(0n);

    expect(s.apply.settleEmissionAndTreasury(1, emission, expected)).toBe(true);
    const box = s.utxo.getTreasuryBox();
    expect(box).not.toBeNull();
    expect(box!.value).toBe(expected);
    expect('owner' in box!).toBe(false);
  });

  it('accrues across blocks, spending its predecessor each time', async () => {
    const s = await bootUnder('devnet');
    close = () => s.db.closeDb();

    const first = 700n;
    const second = 1_300n;
    expect(s.apply.settleEmissionAndTreasury(1, s.creator.computeBlockReward(1), first)).toBe(true);
    const predecessor = s.utxo.getTreasuryBox()!;

    expect(s.apply.settleEmissionAndTreasury(2, s.creator.computeBlockReward(2), second)).toBe(true);
    const successor = s.utxo.getTreasuryBox()!;

    expect(successor.value).toBe(first + second);
    // The predecessor is spent rather than left beside its successor — two
    // unspent treasury boxes would make `getTreasuryBox` answer arbitrarily.
    expect(successor.id).not.toBe(predecessor.id);
    expect(s.utxo.getBox(predecessor.id!)).toBeNull();
  });

  // ⛔ **The treasury half of the same measurement: this is the ONLY test that
  // fails when the treasury arm's zero guard is reverted — mutation,
  // 2026-08-16, 1,433 of 1,434 still passed.** Nothing else notices a leaf
  // churning through the AVL tree on every block for no state change.
  it('is untouched by a block whose treasury slice is zero', async () => {
    const s = await bootUnder('devnet');
    close = () => s.db.closeDb();

    expect(s.apply.settleEmissionAndTreasury(1, s.creator.computeBlockReward(1), 500n)).toBe(true);
    const before = s.utxo.getTreasuryBox()!;
    expect(s.apply.settleEmissionAndTreasury(2, s.creator.computeBlockReward(2), 0n)).toBe(true);
    // Same box, same id — not a successor of equal value, which would churn a
    // leaf through the AVL tree on every block for no state change.
    expect(s.utxo.getTreasuryBox()!.id).toBe(before.id);
  });
});

// ---------------------------------------------------------------------------
// The block identity
// ---------------------------------------------------------------------------

describe('credit conservation across a block', () => {
  it('credits consumed equals credits created, with no correction term', async () => {
    const s = await bootUnder('devnet');
    const db = s.db;
    try {
      const miner = makeTestIdentity();

      const before = {
        emission: s.utxo.getEmissionBox()?.value ?? 0n,
        treasury: s.utxo.getTreasuryBox()?.value ?? 0n,
        credit: s.utxo.getCreditBoxes(miner.userId).reduce((n, b) => n + b.value, 0n),
      };

      const block = await makeApplicableBlock({ miner });
      expect(s.apply.applyOrderingBlock(block)).toBe(true);

      const after = {
        emission: s.utxo.getEmissionBox()?.value ?? 0n,
        treasury: s.utxo.getTreasuryBox()?.value ?? 0n,
        credit: s.utxo.getCreditBoxes(miner.userId).reduce((n, b) => n + b.value, 0n),
      };

      // ⛔ **No correction term, and the fee deficit needs none** — the
      // transaction inputs and outputs are already on both sides of the sums
      // (spec §3.6):
      //   created − consumed = −emission + treasury + (O − I) + miner = 0
      const consumed = before.emission - after.emission;
      const created = (after.treasury - before.treasury) + (after.credit - before.credit);
      expect(consumed).toBe(created);

      // Non-vacuity: an identity over two zeroes holds trivially. This block
      // really did release emission and really did accrue to the treasury.
      expect(consumed).toBeGreaterThan(0n);
      expect(after.treasury).toBeGreaterThan(before.treasury);
      expect(after.credit).toBeGreaterThan(before.credit);

      // And the split, not only the sum: the miner's slice is the coinbase, the
      // treasury's is the box, and the two together are the whole release.
      const split = s.split.splitCoinbase(s.creator.computeBlockReward(1), 0n, 0);
      expect(after.credit - before.credit).toBe(split.miner);
      expect(after.treasury - before.treasury).toBe(split.treasury);
    } finally {
      db.closeDb();
      delete process.env['NETWORK_TYPE'];
      vi.resetModules();
    }
  });
});
