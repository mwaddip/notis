// NODE_INTERFACE → Karma decay → "Decay starts at the grace window's end, and
// from nothing", "A squaring writes the height it settles through, never its
// own height", "A block squares every identity it touches or pays",
// "The floor forgives what it stops"; and "The income leg pays each owner
// once". Each case enters through `applyBlock` over a block built by
// `candidateBlock` and asserts the effects (`lastDecayBlock`, the
// settlement's inputs and outputs, the pool's change, the owner's boxes
// after). A case marked `it.fails` is one the current tree gets wrong.
import { describe, it, expect } from 'vitest';
import {
  KARMA_DECAY_AMOUNT,
  KARMA_MINIMUM,
  LIKES_PER_KARMA_PAYOUT,
  decodeTx,
  effectiveKarma,
  profileFor,
} from '@dagsocial/types';
import type {
  AnyBox,
  DecayCfg,
  KarmaBox,
  OrderingBlock,
  UtxoTransaction,
} from '@dagsocial/types';
import { applyBlock, materializeOutput } from '@dagsocial/consensus';
import type { ApplyContext } from '@dagsocial/consensus';
import {
  MemoryStateView,
  applyContextFor,
  bondBox,
  candidateBlock,
  claimTx,
  consolidateTx,
  hex,
  identityRecord,
  incomeBox,
  karmaBox,
  likeTx,
  protocolBox,
  seedProvenance,
  seededIdentity,
  uid,
  writeEffects,
  type Built,
} from './helpers.js';

const PROFILE = profileFor('devnet');

// The window and the interval the cases name — `T` and `I` throughout. The
// first file-wide pair applies to every case but (b); (b) names its own `I`
// to show a squaring whose height is not a multiple of the interval away
// from the clock's start.
const T = 6;
const I = 3;
const CFG: DecayCfg = {
  staleThresholdBlocks: T,
  decayIntervalBlocks: I,
  decayAmount: KARMA_DECAY_AMOUNT,
  karmaMinimum: KARMA_MINIMUM,
};
const CTX: ApplyContext = {
  ...applyContextFor(PROFILE),
  inviteProbationBlocks: 3,
  storageRentPeriodBlocks: 4,
  vouchCooldownBlocks: 3,
  decayCfg: CFG,
};

const miner = seededIdentity('squared-set/miner');

/** A view with the four protocol boxes and the miner's identity record. */
function genesisView(): MemoryStateView {
  const view = new MemoryStateView({ memberCount: 1 });
  let nonce = 1;
  view.insertBox(protocolBox('emission', PROFILE.creditEmissionTotal, nonce++));
  view.insertBox(protocolBox('karma_pool', 1_000_000n, nonce++));
  view.putIdentityRecord(miner.userId, identityRecord({ memberSinceBlock: 1 }));
  return view;
}

function putConfirmedPost(view: MemoryStateView, postId: string, author: Uint8Array, height: number): void {
  view.insertPost(postId);
  view.insertBlockTopology(postId, author, height);
}

function applied(view: MemoryStateView, height: number, txs: Built[], ctx: ApplyContext = CTX): OrderingBlock {
  const block = candidateBlock(view, height, txs, miner.userId, ctx);
  const result = applyBlock(view, block, ctx);
  if (!result.ok) throw new Error(`block ${height} refused: ${result.reason}`);
  writeEffects(view, result.effects, height);
  return block;
}

/** The block's settlement, decoded, with the ids its outputs take. */
function settlementOf(block: OrderingBlock): { tx: UtxoTransaction; inputs: string[]; out: AnyBox[] } {
  const bytes = block.utxoTxTree.utxoTxs.at(-1)!;
  const id = block.utxoTxTree.utxoTxIds.at(-1)!;
  const tx = decodeTx(bytes);
  return { tx, inputs: tx.inputs, out: tx.outputs.map((o, i) => materializeOutput(o, id, i)) };
}

const karmaOutputs = (out: AnyBox[], owner: Uint8Array): KarmaBox[] =>
  out.filter((o): o is KarmaBox => o.boxType === 'karma' && hex((o as KarmaBox).owner) === hex(owner));

// ---------------------------------------------------------------------------
// Rule 1 — the window-end clock and the settled-through height
// ---------------------------------------------------------------------------

describe('rule 1: decay starts at the window\'s end, and from nothing', () => {
  // (a) An owner touched at `A + T` owes nothing: `clockStart = max(A + T,
  // lastDecayBlock) = A + T`, so `owedPeriods = 0`. The settlement does not
  // charge their post-body karma box, and the clock does not move. Here with
  // `T = 6`, `I = 3`, `A = 0`.
  it('(a1) touched at A + T with T=6, I=3: no decay charge, no clock write', () => {
    const view = genesisView();
    const owner = seededIdentity('a1/owner');
    view.putIdentityRecord(owner.userId, identityRecord({ lastActivityBlock: 0 }));
    const ownBox = karmaBox(owner.userId, 50n, 1, 0);
    view.insertBox(ownBox);

    const H = T; // 6, exactly at the window's end
    const consolidate = consolidateTx(owner, [ownBox], H);
    const block = applied(view, H, [consolidate]);
    const settlement = settlementOf(block);

    // Owner's post-body karma box (the consolidate's change) is NOT a
    // settlement input: no squaring fires at the window's end.
    expect(settlement.inputs).not.toContain(consolidate.out[0]!.id);
    // The owner's record carries no decay clock.
    expect(view.getIdentityRecord(owner.userId)!.lastDecayBlock).toBe(0);
    // The owner's post-body karma box stands untouched.
    const after = view.getKarmaBoxes(owner.userId);
    expect(after).toHaveLength(1);
    expect(after[0]!.value).toBe(50n);
  });

  // (a) Touched one interval past the window's end — `H = A + T + I` — one
  // whole period is burned: `owedPeriods = 1`, burn = `decayAmount`.
  it('(a2) touched at A + T + I with T=6, I=3: one period burned, newValue is face minus decayAmount', () => {
    const view = genesisView();
    const owner = seededIdentity('a2/owner');
    view.putIdentityRecord(owner.userId, identityRecord({ lastActivityBlock: 0 }));
    const ownBox = karmaBox(owner.userId, 50n, 1, 0);
    view.insertBox(ownBox);

    const H = T + I; // 9
    const consolidate = consolidateTx(owner, [ownBox], H);
    const block = applied(view, H, [consolidate]);
    const settlement = settlementOf(block);

    // The decay leg charges the consolidate's change box and emits one
    // unmarked karma box of the effective value — face 50 less one period
    // of 5 is 45.
    expect(settlement.inputs).toContain(consolidate.out[0]!.id);
    const emitted = karmaOutputs(settlement.out, owner.userId);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.income).toBeUndefined();
    expect(emitted[0]!.value).toBe(50n - KARMA_DECAY_AMOUNT);
  });

  // (b) A squaring at `A + T + 2I + 3` writes `lastDecayBlock =
  // A + T + 2I`, not `A + T + 2I + 3`. Chosen with `I = 4` so the `+3`
  // offset falls strictly inside a period and the two heights differ.
  const CFG_B: DecayCfg = { ...CFG, decayIntervalBlocks: 4 };
  const CTX_B: ApplyContext = { ...CTX, decayCfg: CFG_B };
  it('(b) a squaring at A + T + 2I + 3 with T=6, I=4 writes lastDecayBlock = A + T + 2I = 14', () => {
    const view = genesisView();
    const owner = seededIdentity('b/owner');
    view.putIdentityRecord(owner.userId, identityRecord({ lastActivityBlock: 0 }));
    const ownBox = karmaBox(owner.userId, 100n, 1, 0);
    view.insertBox(ownBox);

    const H = T + 2 * 4 + 3; // 17
    const consolidate = consolidateTx(owner, [ownBox], H);
    applied(view, H, [consolidate], CTX_B);

    // `clockStart = T = 6`, periods at H = floor((17 − 6) / 4) = 2,
    // settledThrough = 6 + 2·4 = 14.
    expect(view.getIdentityRecord(owner.userId)!.lastDecayBlock).toBe(T + 2 * 4);
  });
});

// ---------------------------------------------------------------------------
// Rules 2–4 — the squared set is touched owners AND paid owners, and a
// zero-burn plan is a clock write with no leg
// ---------------------------------------------------------------------------

describe('rule 2–4: a block squares every identity it touches or pays', () => {
  // (c) A stale author paid by a like in a block that does not touch them is
  // squared in it: own and income box consumed, `effective` emitted
  // unmarked, the burn to the pool, the payout in a new income box, the
  // clock written. Here the author holds `own = 50` and `income = 20`, is
  // stale from `A = 0`, and the block at `H = 20` carries one like whose
  // marker tips a pre-seeded accrual of 4 to a payout — `q = 1`,
  // `paid = q · (x − 1) = 4`.
  it.fails('(c) a stale author paid by a like is squared: own + income consumed, effective unmarked, payout in new income box, clock written', () => {
    const view = genesisView();
    const author = seededIdentity('c/author');
    view.putIdentityRecord(author.userId, identityRecord({ lastActivityBlock: 0 }));
    const authorOwn = karmaBox(author.userId, 50n, 1, 0);
    const authorIncome = incomeBox(author.userId, 20n, 2, 0);
    view.insertBox(authorOwn);
    view.insertBox(authorIncome);

    const liker = seededIdentity('c/liker');
    view.putIdentityRecord(liker.userId, identityRecord({ lastActivityBlock: 19 }));
    view.insertBox(karmaBox(liker.userId, 11n, 3, 0));

    const postId = hex(uid('c/post'));
    putConfirmedPost(view, postId, author.userId, 0);
    view.insertBox(seedProvenance<AnyBox>(
      { boxType: 'like_accrual', value: 4n, createdAtBlock: 0, author: author.userId },
      0, 100,
    ));

    const H = 20;
    const like = likeTx(liker, view.getKarmaBoxes(liker.userId)[0]!, postId, author.userId, H);
    const block = applied(view, H, [like]);
    const settlement = settlementOf(block);

    // Both of the author's pre-body karma boxes are inputs: own + income.
    expect(settlement.inputs).toContain(authorOwn.id);
    expect(settlement.inputs).toContain(authorIncome.id);

    // One unmarked karma output (decay's replacement) at the effective
    // value — face 70, periods = floor((20 − 6) / 3) = 4, owed = 20,
    // effective = 50 (above the floor).
    const emitted = karmaOutputs(settlement.out, author.userId);
    const unmarked = emitted.filter((o) => o.income !== true);
    const marked = emitted.filter((o) => o.income === true);
    expect(unmarked).toHaveLength(1);
    expect(unmarked[0]!.value).toBe(50n);

    // One marked karma output — the payout, as a fresh income box.
    expect(marked).toHaveLength(1);
    expect(marked[0]!.value).toBe(BigInt(LIKES_PER_KARMA_PAYOUT - 1));

    // The clock lands at settledThrough = T + 4·I = 6 + 12 = 18.
    expect(view.getIdentityRecord(author.userId)!.lastDecayBlock).toBe(T + 4 * I);
  });

  // (d) The same for a stale inviter paid a vested bond. Empty body + a
  // pre-existing bond settling at `H`. The inviter is in the squared set.
  it.fails('(d) a stale inviter paid a vested bond is squared: own consumed, effective unmarked, vested amount in income box, clock written', () => {
    const view = genesisView();
    const inviter = seededIdentity('d/inviter');
    view.putIdentityRecord(inviter.userId, identityRecord({ lastActivityBlock: 0, memberSinceBlock: 1 }));
    const inviterOwn = karmaBox(inviter.userId, 50n, 1, 0);
    view.insertBox(inviterOwn);

    const invitee = seededIdentity('d/invitee');
    view.putIdentityRecord(invitee.userId, identityRecord({
      invitedAtBlock: 1,
      lifetimeLikesReceived: 1_000_000n,
      memberSinceBlock: 1,
    }));
    const bond = bondBox(inviter.userId, invitee.userId, 2, 1);
    view.insertBox(bond);

    const H = 20;
    const block = applied(view, H, []);
    const settlement = settlementOf(block);

    // The inviter's own box is a settlement input (the decay leg).
    expect(settlement.inputs).toContain(inviterOwn.id);
    // The bond is a settlement input (the bond leg).
    expect(settlement.inputs).toContain(bond.id);

    // Decay's replacement: an unmarked karma box of effective value —
    // face 50, periods = 4, owed = 20, effective = 30.
    const emitted = karmaOutputs(settlement.out, inviter.userId);
    const unmarked = emitted.filter((o) => o.income !== true);
    const marked = emitted.filter((o) => o.income === true);
    expect(unmarked).toHaveLength(1);
    expect(unmarked[0]!.value).toBe(30n);

    // One marked karma output — the vested bond, as a fresh income box.
    expect(marked).toHaveLength(1);
    expect(marked[0]!.value).toBe(bond.value);

    // The clock lands at settledThrough = T + 4·I = 18.
    expect(view.getIdentityRecord(inviter.userId)!.lastDecayBlock).toBe(T + 4 * I);
  });

  // (e) The floor: a stale author whose karma is one own box at
  // `KARMA_MINIMUM`, paid `P` by the block — the block writes the clock,
  // consumes none of their boxes (none in pre-body state), the payout in
  // a new income box; and the floor's clock-write forgives the owed
  // periods it stopped at.
  it.fails('(e) the floor: a stale author at KARMA_MINIMUM paid by a like has their clock written, no leg; at settledThrough + I the floor stands', () => {
    const view = genesisView();
    const author = seededIdentity('e/author');
    view.putIdentityRecord(author.userId, identityRecord({ lastActivityBlock: 0 }));
    const authorOwn = karmaBox(author.userId, KARMA_MINIMUM, 1, 0);
    view.insertBox(authorOwn);

    const liker = seededIdentity('e/liker');
    view.putIdentityRecord(liker.userId, identityRecord({ lastActivityBlock: 19 }));
    view.insertBox(karmaBox(liker.userId, 11n, 2, 0));

    const postId = hex(uid('e/post'));
    putConfirmedPost(view, postId, author.userId, 0);
    view.insertBox(seedProvenance<AnyBox>(
      { boxType: 'like_accrual', value: 4n, createdAtBlock: 0, author: author.userId },
      0, 100,
    ));

    const H = 20;
    const like = likeTx(liker, view.getKarmaBoxes(liker.userId)[0]!, postId, author.userId, H);
    const block = applied(view, H, [like]);
    const settlement = settlementOf(block);

    // The author's own box is NOT a settlement input — a zero-burn
    // squaring names none of its boxes.
    expect(settlement.inputs).not.toContain(authorOwn.id);
    // No unmarked karma output for the author — the own box stands.
    const emitted = karmaOutputs(settlement.out, author.userId);
    const unmarked = emitted.filter((o) => o.income !== true);
    const marked = emitted.filter((o) => o.income === true);
    expect(unmarked).toHaveLength(0);
    // One marked karma output — the payout, as a fresh income box.
    const P = BigInt(LIKES_PER_KARMA_PAYOUT - 1);
    expect(marked).toHaveLength(1);
    expect(marked[0]!.value).toBe(P);

    // Clock written to settledThrough = T + 4·I = 18.
    const settledThrough = T + 4 * I;
    expect(view.getIdentityRecord(author.userId)!.lastDecayBlock).toBe(settledThrough);

    // After the block: effective karma over the two boxes and the record
    // answers KARMA_MINIMUM + P.
    const held = view.getKarmaBoxes(author.userId);
    const face = held.reduce((s, b) => s + b.value, 0n);
    expect(face).toBe(KARMA_MINIMUM + P);
    expect(effectiveKarma(face, view.getIdentityRecord(author.userId), H, CFG)).toBe(KARMA_MINIMUM + P);

    // At settledThrough + I the valuation is
    // max(KARMA_MINIMUM + P − KARMA_DECAY_AMOUNT, KARMA_MINIMUM).
    const atNext = settledThrough + I;
    const expected = (KARMA_MINIMUM + P - KARMA_DECAY_AMOUNT) > KARMA_MINIMUM
      ? KARMA_MINIMUM + P - KARMA_DECAY_AMOUNT
      : KARMA_MINIMUM;
    expect(effectiveKarma(face, view.getIdentityRecord(author.userId), atNext, CFG)).toBe(expected);
  });

  // (f) A paid owner holding no karma box: a clock write and the income
  // box, no leg. Empty body + a pre-existing bond settling for the
  // inviter, who holds no karma.
  it.fails('(f) a paid owner holding no karma box: clock written and income box emitted, no decay leg', () => {
    const view = genesisView();
    const inviter = seededIdentity('f/inviter');
    view.putIdentityRecord(inviter.userId, identityRecord({ lastActivityBlock: 0, memberSinceBlock: 1 }));
    // No karma boxes for the inviter.

    const invitee = seededIdentity('f/invitee');
    view.putIdentityRecord(invitee.userId, identityRecord({
      invitedAtBlock: 1,
      lifetimeLikesReceived: 1_000_000n,
      memberSinceBlock: 1,
    }));
    const bond = bondBox(inviter.userId, invitee.userId, 2, 1);
    view.insertBox(bond);

    const H = 20;
    const block = applied(view, H, []);
    const settlement = settlementOf(block);

    // No karma input of the inviter is named: they had none pre-body.
    const inviterKarmaInputs = settlement.inputs.filter((id) => {
      const box = view.getBox(id);
      return box !== null && box.boxType === 'karma' && hex((box as KarmaBox).owner) === hex(inviter.userId);
    });
    expect(inviterKarmaInputs).toHaveLength(0);
    // No unmarked karma output for the inviter — the plan is a clock
    // write and no leg.
    const emitted = karmaOutputs(settlement.out, inviter.userId);
    const unmarked = emitted.filter((o) => o.income !== true);
    const marked = emitted.filter((o) => o.income === true);
    expect(unmarked).toHaveLength(0);
    // One marked karma output — the vested bond, as the fresh income box.
    expect(marked).toHaveLength(1);
    expect(marked[0]!.value).toBe(bond.value);
    // The clock lands at settledThrough = T + 4·I.
    expect(view.getIdentityRecord(inviter.userId)!.lastDecayBlock).toBe(T + 4 * I);
  });

  // (g) An owner touched at its floor: a free name claim. The claim's own
  // box of value 10 (the floor) is spent and re-emitted at the same value;
  // the clock is written, no leg.
  it.fails('(g) an owner touched at its floor (free name claim): clock written, no leg', () => {
    const view = genesisView();
    const owner = seededIdentity('g/owner');
    view.putIdentityRecord(owner.userId, identityRecord({ lastActivityBlock: 0 }));
    const ownBox = karmaBox(owner.userId, KARMA_MINIMUM, 1, 0);
    view.insertBox(ownBox);

    const H = 20;
    const claim = claimTx(owner, ownBox, 'Floor', H);
    const block = applied(view, H, [claim]);
    const settlement = settlementOf(block);

    // The claim's own-box change is NOT a settlement input — a zero-burn
    // squaring names none of the owner's boxes.
    expect(settlement.inputs).not.toContain(claim.out[0]!.id);
    // No karma output of the owner from the settlement — the claim's
    // own-box change stands.
    const emitted = karmaOutputs(settlement.out, owner.userId);
    expect(emitted).toHaveLength(0);

    // Clock written to settledThrough = T + 4·I.
    expect(view.getIdentityRecord(owner.userId)!.lastDecayBlock).toBe(T + 4 * I);
  });

  // (h) An owner neither touched nor paid is not squared, and its clock
  // does not move. A control: both the current tree and the rule agree.
  it('(h) an owner neither touched nor paid: not squared, clock untouched', () => {
    const view = genesisView();
    const owner = seededIdentity('h/owner');
    const seedRecord = identityRecord({ lastActivityBlock: 0 });
    view.putIdentityRecord(owner.userId, seedRecord);
    view.insertBox(karmaBox(owner.userId, 100n, 1, 0));

    const H = 20;
    const block = applied(view, H, []);
    const settlement = settlementOf(block);

    const inputBoxOwners = settlement.inputs
      .map((id) => view.getBox(id))
      .filter((box): box is AnyBox => box !== null && box.boxType === 'karma')
      .map((box) => hex((box as KarmaBox).owner));
    expect(inputBoxOwners).not.toContain(hex(owner.userId));

    expect(karmaOutputs(settlement.out, owner.userId)).toHaveLength(0);
    expect(view.getIdentityRecord(owner.userId)).toEqual(seedRecord);
  });
});

