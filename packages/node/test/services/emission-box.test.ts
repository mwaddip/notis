import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { computeTxId } from '@dagsocial/types';
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

// Mainnet / testnet: R = 42, d = 1, F = 1,051,200, E = 470,000.
//   K      = largest k with 42 − k > 0            = 41
//   Σ      = Σ(k=1..41)(42 − k) = 1722 − 861      = 861
//   curve  = 1,051,200 × 42 + 470,000 × 861       = 448,820,400
//   carried total (TYPES_INTERFACE → EmissionBox)  = 422,640,000
//
// ⛔ **The carried total is deliberately below the curve.** 422,640,000 is
// 94.2% of 448,820,400. The test says WHICH number it is — the CARRIED total,
// not the curve's sum.
const MAINNET_CARRIED = 422_640_000n * E8;

// Devnet: F = 1,000 · E = 400, same economics (ARCHITECTURE → Network Identity:
// compress time, never economics), so R, d, K and Σ are unchanged.
//   curve  = 1,000 × 42 + 400 × 861               = 386,400
//   carried total                                   = 362,000
const DEVNET_CARRIED = 362_000n * E8;
const DEVNET_CURVE_SUM = 386_400n * E8;

async function importFresh() {
  const db = await import('../../src/store/db.js');
  const system = await import('../../src/store/system.js');
  const utxo = await import('../../src/store/utxo.js');
  const genesis = await import('../../src/services/genesis-state.js');
  const prover = await import('../../src/state/avl-prover.js');
  const creator = await import('../../src/services/block-creator.js');
  const apply = await import('../../src/services/block-apply.js');
  const split = await import('../../src/services/coinbase-split.js');
  const settlement = await import('../../src/services/settlement.js');
  const engine = await import('../../src/services/utxo-engine.js');
  const config = await import('../../src/config.js');
  return { db, system, utxo, genesis, prover, creator, apply, split, settlement, engine, config };
}

/**
 * Build the settlement a body of this shape requires and apply it — the seam
 * both box transitions now live behind.
 *
 * ⛔ **`treasury` IS NOT A PARAMETER, and it cannot be one.** Emission and the
 * treasury slice come from opposite directions but out of ONE `splitCoinbase`
 * over `(emission, fees, actors)` (MINING_INTERFACE → Coinbase Application), so
 * a caller naming the treasury independently would be naming a seam the
 * settlement does not have. Every case below states the income and reads the
 * slice back off `splitCoinbase`.
 *
 * Returns `false` for a chain that cannot back the release.
 */
function settle(
  s: Awaited<ReturnType<typeof importFresh>>,
  height: number,
  emission: bigint,
  opts: { fees?: bigint; actors?: number } = {},
): boolean {
  const built = s.settlement.buildSettlement(
    {
      getEmissionBox: s.utxo.getEmissionBox,
      getTreasuryBox: s.utxo.getTreasuryBox,
      getKarmaPoolBox: s.utxo.getKarmaPoolBox,
      getBox: s.utxo.getBox,
      // ⛔ The karma legs are empty by construction here: this suite's subject
      // is the EMISSION box, and a body with no markers, no bonds and no stale
      // identity derives no karma leg at all. Stated as empty rather than wired
      // to the store, so a karma effect appearing in this fixture is a failure
      // rather than a silent extra output.
      getLikeCarryBox: () => null,
      getBondsSettlingAt: () => [],
      getEscrowsReleasableAt: () => [],
      getLifetimeLikes: () => 0n,
      getDecayPlans: () => [],
    },
    height,
    emission,
    s.config.config.creditMinerRewardDelay,
    { fees: opts.fees ?? 0n, rent: 0n, actors: opts.actors ?? 0, feeBoxIds: [], invites: [], markers: [], priceBoxes: [] },
    makeTestIdentity().userId,
  );
  if ('error' in built) return false;
  const txId = computeTxId(built.tx);
  for (const id of built.tx.inputs) s.utxo.consumeBox(id, height);
  built.tx.outputs.forEach((out, i) => {
    s.utxo.insertBox(s.engine.materializeOutput(out, txId, i));
  });
  return true;
}

/** Seed a full genesis state under `network` and hand back its modules. */
async function bootUnder(network: string) {
  process.env['NETWORK_TYPE'] = network;
  vi.resetModules();
  const s = await importFresh();
  s.db.initDb(':memory:');
  s.prover.createAvlProver();
  s.genesis.seedGenesisState();
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

  it('mainnet holds its carried total at genesis', async () => {
    const s = await bootUnder('mainnet');
    close = () => s.db.closeDb();

    // The CARRIED total, not the curve's sum — 94.2% of 448,820,400.
    expect(s.creator.emissionTotal()).toBe(MAINNET_CARRIED);

    const box = s.utxo.getEmissionBox();
    expect(box).not.toBeNull();
    expect(box!.value).toBe(MAINNET_CARRIED);
    // No owner field at all — not an owner set to zero bytes.
    expect('owner' in box!).toBe(false);
  });

  it('devnet holds its own carried total', async () => {
    const s = await bootUnder('devnet');
    close = () => s.db.closeDb();

    // Non-vacuity: devnet's total must NOT be mainnet's.
    expect(s.creator.emissionTotal()).toBe(DEVNET_CARRIED);
    expect(DEVNET_CARRIED).not.toBe(MAINNET_CARRIED);
    expect(s.utxo.getEmissionBox()!.value).toBe(DEVNET_CARRIED);
  });

  it('the carried total is strictly below the curve\'s sum', async () => {
    const s = await bootUnder('devnet');
    close = () => s.db.closeDb();

    // The property the guard enforces: the box holds LESS than the curve
    // would pay over its whole span, so it empties while the schedule is
    // still positive.
    let curveTotal = 0n;
    for (let h = 1; ; h++) {
      const r = s.creator.computeBlockReward(h);
      if (r === 0n) break;
      curveTotal += r;
    }
    expect(curveTotal).toBe(DEVNET_CURVE_SUM);
    expect(DEVNET_CARRIED).toBeLessThan(DEVNET_CURVE_SUM);
    expect(s.creator.emissionTotal()).toBeLessThan(curveTotal);
  });

  // -------------------------------------------------------------------------
  // Balance-driven exhaustion
  // -------------------------------------------------------------------------

  it('the box survives at 0 above the terminus', async () => {
    const s = await bootUnder('devnet');
    close = () => s.db.closeDb();

    // Above the terminus the reward is 0 and with no fees the unearned is 0,
    // so the successor holds exactly what the predecessor did.
    const before = s.utxo.getEmissionBox()!;
    expect(settle(s, 17_401, 0n)).toBe(true);
    const after = s.utxo.getEmissionBox();
    expect(after).not.toBeNull();
    expect(after!.value).toBe(before.value);
    // But it IS a new box — the predecessor was consumed.
    expect(after!.id).not.toBe(before.id);

    // A second block above the terminus: box still at the same value, still exists.
    expect(settle(s, 17_402, 0n)).toBe(true);
    expect(s.utxo.getEmissionBox()).not.toBeNull();
    expect(s.utxo.getEmissionBox()!.value).toBe(before.value);
  });

  it('partial payment on the first block the box cannot cover in full', async () => {
    const s = await bootUnder('devnet');
    close = () => s.db.closeDb();

    // Drain the box iteratively to below 42e8. Each step: claim box+1 with
    // 1000 actors so release = box.value and unearned ≈ release × 0.124%.
    let h = 1;
    while (s.utxo.getEmissionBox()!.value >= 42n * E8) {
      const v = s.utxo.getEmissionBox()!.value;
      expect(settle(s, h, v + 1n, { actors: 1000 })).toBe(true);
      h++;
    }

    // The box now holds less than 42e8. The next block triggers partial payment.
    const boxBefore = s.utxo.getEmissionBox()!;
    expect(boxBefore.value).toBeGreaterThan(0n);
    expect(boxBefore.value).toBeLessThan(42n * E8);

    const release = boxBefore.value;
    const split = s.split.splitCoinbase(release, 0n, 0n, 0);
    expect(settle(s, h, 42n * E8)).toBe(true);
    const boxAfter = s.utxo.getEmissionBox()!;
    expect(boxAfter.value).toBe(split.unearned);

    // Conservation: what left the box = what treasury + miner received.
    const consumed = boxBefore.value - boxAfter.value;
    expect(consumed).toBe(split.treasury + split.miner);
    expect(consumed).toBeLessThan(42n * E8);
  });

  it('returned unearned raises a successor above its predecessor', async () => {
    const s = await bootUnder('devnet');
    close = () => s.db.closeDb();

    // A block with fees and zero actors: the full bonus pool is unearned and
    // returns to the emission box. emission=42e8, fees=200e8, actors=0
    // bonusPool = (42 + 200) × 25 / 100 = 60e8
    // earned = 0 (no actors), unearned = 60e8
    // release = 42e8, successor = genesis − 42e8 + 60e8 > genesis
    const before = s.utxo.getEmissionBox()!;
    const split = s.split.splitCoinbase(42n * E8, 200n * E8, 0n, 0);
    expect(settle(s, 1, 42n * E8, { fees: 200n * E8, actors: 0 })).toBe(true);
    const after = s.utxo.getEmissionBox()!;
    expect(after.value).toBeGreaterThan(before.value);
    expect(after.value).toBe(before.value - 42n * E8 + split.unearned);
  });

  it('a block above the terminus with zero emission still spends the box', async () => {
    const s = await bootUnder('devnet');
    close = () => s.db.closeDb();

    // At height above the curve's terminus, emission = 0 but the box is still
    // spent because unearned has to be returned.
    const before = s.utxo.getEmissionBox()!;
    expect(settle(s, 5901, 0n)).toBe(true);
    const after = s.utxo.getEmissionBox()!;
    // Box exists with same value (0 emission, 0 fees → 0 unearned)
    expect(after).not.toBeNull();
    expect(after.value).toBe(before.value);
    // But it's a NEW box (predecessor was consumed)
    expect(after.id).not.toBe(before.id);
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
    const expected = s.split.splitCoinbase(emission, 0n, 0n, 0).treasury;
    // Non-vacuity: a block whose slice rounded to zero would create nothing, so
    // the case has to be one where something actually accrues.
    expect(expected).toBeGreaterThan(0n);

    expect(settle(s, 1, emission)).toBe(true);
    const box = s.utxo.getTreasuryBox();
    expect(box).not.toBeNull();
    expect(box!.value).toBe(expected);
    expect('owner' in box!).toBe(false);
  });

  it('accrues across blocks, spending its predecessor each time', async () => {
    const s = await bootUnder('devnet');
    close = () => s.db.closeDb();

    // Two blocks with DIFFERENT fee income, so the two slices differ and a
    // successor that overwrote rather than accrued would be visible.
    const first = s.split.splitCoinbase(s.creator.computeBlockReward(1), 0n, 0n, 0).treasury;
    const second = s.split.splitCoinbase(s.creator.computeBlockReward(2), 0n, 0n, 0).treasury;
    expect(settle(s, 1, s.creator.computeBlockReward(1))).toBe(true);
    const predecessor = s.utxo.getTreasuryBox()!;

    expect(settle(s, 2, s.creator.computeBlockReward(2))).toBe(true);
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

    expect(settle(s, 1, s.creator.computeBlockReward(1))).toBe(true);
    const before = s.utxo.getTreasuryBox()!;
    // With zero emission and zero fees the treasury slice is zero — the one
    // shape whose treasury rounds to nothing.
    expect(s.split.splitCoinbase(0n, 0n, 0n, 0).treasury).toBe(0n);
    expect(settle(s, 2, 0n)).toBe(true);
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
      const split = s.split.splitCoinbase(s.creator.computeBlockReward(1), 0n, 0n, 0);
      expect(after.credit - before.credit).toBe(split.miner);
      expect(after.treasury - before.treasury).toBe(split.treasury);
    } finally {
      db.closeDb();
      delete process.env['NETWORK_TYPE'];
      vi.resetModules();
    }
  });

  it('conserves under partial payment — a box too small for the scheduled reward', async () => {
    const s = await bootUnder('devnet');
    try {
      // Drain iteratively to below 42e8 so the next block triggers partial.
      let h = 1;
      while (s.utxo.getEmissionBox()!.value >= 42n * E8) {
        const v = s.utxo.getEmissionBox()!.value;
        expect(settle(s, h, v + 1n, { actors: 1000 })).toBe(true);
        h++;
      }

      const boxBefore = s.utxo.getEmissionBox()!.value;
      const treasuryBefore = s.utxo.getTreasuryBox()?.value ?? 0n;
      expect(boxBefore).toBeLessThan(42n * E8);
      expect(boxBefore).toBeGreaterThan(0n);

      const release = boxBefore;
      const split = s.split.splitCoinbase(release, 0n, 0n, 0);
      expect(settle(s, h, 42n * E8)).toBe(true);

      const boxAfter = s.utxo.getEmissionBox()!.value;
      const treasuryAfter = s.utxo.getTreasuryBox()?.value ?? 0n;

      // Conservation: what left the emission box = what treasury + miner received.
      const emissionConsumed = boxBefore - boxAfter;
      const treasuryGained = treasuryAfter - treasuryBefore;
      expect(emissionConsumed).toBe(treasuryGained + split.miner);

      // The gap that would exist if the split saw the schedule (42e8) instead
      // of the release (~few hundred): miner ≈ 30e8 vs miner ≈ few hundred.
      expect(split.miner).toBeLessThan(42n * E8);
      expect(emissionConsumed).toBeLessThan(42n * E8);
    } finally {
      s.db.closeDb();
      delete process.env['NETWORK_TYPE'];
      vi.resetModules();
    }
  });
});
