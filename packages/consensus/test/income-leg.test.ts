// NODE_INTERFACE → The settlement transaction → "The income leg pays each
// owner once": a block pays every owner one income box, consuming the
// pre-body income box the body did not spend and decay did not charge, and
// emitting one box marked `income: true` whose value is the sum of the like
// payout, every vested bond settling to them and every escrow returning.
// The two input and output orders are consensus, compared position by
// position by `checkSettlement`.
//
// Cases a tree that still emits one unmarked karma box per leg gets wrong
// stand as `it.fails` — the rule's commit flips each to `it`.
import { describe, it, expect } from 'vitest';
import {
  KARMA_DECAY_AMOUNT,
  KARMA_MINIMUM,
  LIKES_PER_KARMA_PAYOUT,
  PROTOCOL_VERSION,
  bytesToHex,
  computeTxId,
  decodeTx,
  encodeTx,
  hexToBytes,
  postKey,
  postRecordBytes,
  profileFor,
} from '@dagsocial/types';
import type {
  AnyBox,
  AnyBoxCandidate,
  IdentityRecord,
  KarmaBox,
  NetworkRecord,
  OrderingBlock,
  UtxoTransaction,
} from '@dagsocial/types';
import {
  applyBlock,
  buildBlockSettlement,
  seedTreeWrites,
  treeStateView,
} from '@dagsocial/consensus';
import type { ApplyContext } from '@dagsocial/consensus';
import {
  MemoryStateView,
  applyContextFor,
  bondBox,
  candidateBlock,
  consolidateTx,
  escrowBox,
  finish,
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
import { proveBlock, proverFrom, replayBlock } from './block-proof.js';
import { mapSessionFrom } from './tree-session-map.js';

const PROFILE = profileFor('devnet');
const CTX: ApplyContext = {
  ...applyContextFor(PROFILE),
  inviteProbationBlocks: 3,
  storageRentPeriodBlocks: 4,
  vouchCooldownBlocks: 3,
  decayCfg: {
    staleThresholdBlocks: 6,
    decayIntervalBlocks: 3,
    decayAmount: KARMA_DECAY_AMOUNT,
    karmaMinimum: KARMA_MINIMUM,
  },
};
const miner = seededIdentity('income-leg/miner');

/** A view holding the four protocol boxes and the miner's identity record. */
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

function applied(view: MemoryStateView, height: number, txs: Built[]): OrderingBlock {
  const block = candidateBlock(view, height, txs, miner.userId, CTX);
  const result = applyBlock(view, block, CTX);
  if (!result.ok) throw new Error(`block ${height} was refused: ${result.reason}`);
  writeEffects(view, result.effects, height);
  return block;
}

const settlementOf = (block: OrderingBlock): UtxoTransaction =>
  decodeTx(block.utxoTxTree.utxoTxs.at(-1)!);

const karmaOutputs = (tx: UtxoTransaction, owner: Uint8Array): KarmaBox[] =>
  tx.outputs.filter((o): o is KarmaBox =>
    o.boxType === 'karma' && hex((o as KarmaBox).owner) === hex(owner),
  );

// ---------------------------------------------------------------------------
// Payouts gather — twenty blocks of likes land in one marked box
// ---------------------------------------------------------------------------

describe('an author paid in twenty consecutive blocks ends with one marked box of the sum', () => {
  it(
    'the author holds their own box, untouched, and one income box whose value is the sum of the payouts',
    () => {
      const view = genesisView();
      const author = seededIdentity('payouts-gather/author');
      const authorRec = identityRecord({ lastActivityBlock: 0 });
      view.putIdentityRecord(author.userId, authorRec);
      const authorOwnBox = karmaBox(author.userId, 10n, 1, 0);
      view.insertBox(authorOwnBox);

      const BLOCKS = 20;
      // One liker per block, each holding enough karma for one like above the
      // floor: 11 face karma, with `lastActivityBlock: i` so no liker is stale
      // at the block it signs — effective karma stays 11, remaining ≥ floor.
      const likers = Array.from({ length: BLOCKS }, (_, i) =>
        seededIdentity(`payouts-gather/liker-${i}`),
      );
      let nonce = 100;
      for (let i = 0; i < BLOCKS; i++) {
        const liker = likers[i]!;
        view.insertBox(karmaBox(liker.userId, 11n, nonce++, 0));
        view.putIdentityRecord(liker.userId, identityRecord({ lastActivityBlock: 1 + i }));
      }

      // One post the author owns, confirmed in a block before.
      const postId = hex(uid('payouts-gather/post'));
      putConfirmedPost(view, postId, author.userId, 1);

      // Each block has one like on the one post from a distinct liker; the
      // author never spends. x = LIKES_PER_KARMA_PAYOUT. After B blocks, the
      // marker count is B. q = ⌊B / x⌋, paid = q·(x − 1), carry = B mod x.
      for (let h = 2; h < 2 + BLOCKS; h++) {
        const liker = likers[h - 2]!;
        const like = likeTx(liker, view.getKarmaBoxes(liker.userId)[0]!, postId, author.userId, h);
        applied(view, h, [like]);
      }

      // After 20 blocks: 1 + 20 markers over x = 5 is 4 full payouts of 4 each
      // (totalling 16), carry = 0 — the author's income holds 16.
      const held = view.getKarmaBoxes(author.userId);
      const own = held.filter((b) => b.income !== true);
      const income = held.filter((b) => b.income === true);
      expect(own).toHaveLength(1);
      expect(own[0]!.id).toBe(authorOwnBox.id);
      expect(income).toHaveLength(1);
      const expectedPaid = BigInt((Math.floor(BLOCKS / LIKES_PER_KARMA_PAYOUT))) * BigInt(LIKES_PER_KARMA_PAYOUT - 1);
      expect(income[0]!.value).toBe(expectedPaid);
    },
  );
});

// ---------------------------------------------------------------------------
// One output per owner in one block — like + bond + escrow
// ---------------------------------------------------------------------------

describe('three legs settling to one owner in one block emit one marked box', () => {
  it(
    'the owner is the liked author, the vesting bond\'s inviter and the escrow\'s owner — one marked output of the sum',
    () => {
      const view = genesisView();
      const owner = seededIdentity('one-output/owner');
      view.putIdentityRecord(owner.userId, identityRecord({ lastActivityBlock: 0, memberSinceBlock: 1 }));
      view.insertBox(karmaBox(owner.userId, 50n, 1, 0));

      // A bond at the owner's probation-end height. The bond settles for the
      // vested portion = min(lifetimeLikesReceived(invitee) / VEST_PER, bond.value).
      // We seed invitee's lifetimeLikesReceived high so the bond vests fully.
      const invitee = seededIdentity('one-output/invitee');
      view.putIdentityRecord(invitee.userId, identityRecord({
        invitedAtBlock: 1,
        lifetimeLikesReceived: 1_000_000n,
      }));
      const bond = bondBox(owner.userId, invitee.userId, 2, 1);
      view.insertBox(bond);

      // An escrow at or past releaseAtBlock for owner, who gets its value.
      const escrow = escrowBox(owner.userId, 2, 3, 1);
      view.insertBox(escrow);

      // One like whose payout settles to owner.
      const liker = seededIdentity('one-output/liker');
      view.putIdentityRecord(liker.userId, identityRecord({ lastActivityBlock: 0 }));
      view.insertBox(karmaBox(liker.userId, 11n, 10, 0));
      const postId = hex(uid('one-output/post'));
      putConfirmedPost(view, postId, owner.userId, 0);

      // Pre-seed one carry box of 4 under the author — the carry a prior
      // block's settlement would have left, so this block's one new marker
      // tips the total to LIKES_PER_KARMA_PAYOUT and the payout fires: q = 1,
      // paid = q*(x−1) = 4.
      view.insertBox(
        seedProvenance<AnyBox>(
          { boxType: 'like_accrual', value: 4n, createdAtBlock: 0, author: owner.userId },
          0,
          500,
        ),
      );

      const H = 1 + CTX.inviteProbationBlocks; // first block the bond settles
      const like = likeTx(liker, view.getKarmaBoxes(liker.userId)[0]!, postId, owner.userId, H);
      const block = applied(view, H, [like]);
      const settlement = settlementOf(block);

      const income = karmaOutputs(settlement, owner.userId).filter((o) => o.income === true);
      expect(income).toHaveLength(1);
      // like payout q*(x-1) + bond vested value + escrow value.
      const expected = BigInt(LIKES_PER_KARMA_PAYOUT - 1) + bond.value + escrow.value;
      expect(income[0]!.value).toBe(expected);
      expect(karmaOutputs(settlement, owner.userId)).toHaveLength(1);
    },
  );
});

// ---------------------------------------------------------------------------
// A first payout — no income input, one fresh marked output
// ---------------------------------------------------------------------------

describe('a first payout: an owner with no income box gets one', () => {
  it('the settlement names no karma input of theirs and emits one marked box of the payout', () => {
    const view = genesisView();
    const author = seededIdentity('first/author');
    view.putIdentityRecord(author.userId, identityRecord());
    const liker = seededIdentity('first/liker');
    view.putIdentityRecord(liker.userId, identityRecord({ lastActivityBlock: 0 }));
    view.insertBox(karmaBox(liker.userId, 11n, 1, 0));
    const postId = hex(uid('first/post'));
    putConfirmedPost(view, postId, author.userId, 0);
    // One carry box of 4 under the author — the carry a prior block would
    // have left, so this block's new marker makes the total 5 (= x), q = 1,
    // paid = 4.
    view.insertBox(
      seedProvenance<AnyBox>(
        { boxType: 'like_accrual', value: 4n, createdAtBlock: 0, author: author.userId },
        0,
        100,
      ),
    );

    const H = 2;
    const like = likeTx(liker, view.getKarmaBoxes(liker.userId)[0]!, postId, author.userId, H);
    const block = applied(view, H, [like]);
    const settlement = settlementOf(block);

    // No karma input of the author: pre-body state held none for them.
    const authorInputIds = new Set<string>();
    for (const inp of settlement.inputs) {
      const box = view.getBox(inp) ?? null;
      if (box?.boxType === 'karma' && hex((box as KarmaBox).owner) === hex(author.userId)) {
        authorInputIds.add(inp);
      }
    }
    expect(authorInputIds.size).toBe(0);

    const outs = karmaOutputs(settlement, author.userId);
    expect(outs).toHaveLength(1);
    expect(outs[0]!.income).toBe(true);
    expect(outs[0]!.value).toBe(BigInt(LIKES_PER_KARMA_PAYOUT - 1));
  });
});

// ---------------------------------------------------------------------------
// Owner took it first — byte-identical build vs apply
// ---------------------------------------------------------------------------

describe('the owner spends their income box in the same block they are paid', () => {
  it(
    'applyBlock over the overlay and buildBlockSettlement over pre-body state answer the same settlement, byte for byte',
    () => {
      const view = genesisView();
      const owner = seededIdentity('took-first/owner');
      view.putIdentityRecord(owner.userId, identityRecord({ lastActivityBlock: 0 }));
      // Owner holds their own box and an income box. The spend names both,
      // which rule 3 of the karma arm requires — every unmarked karma box
      // the owner holds among the inputs.
      view.insertBox(karmaBox(owner.userId, 20n, 1, 0));
      view.insertBox(incomeBox(owner.userId, 15n, 2, 0));

      // One liker whose like credits owner as author.
      const liker = seededIdentity('took-first/liker');
      view.putIdentityRecord(liker.userId, identityRecord({ lastActivityBlock: 0 }));
      view.insertBox(karmaBox(liker.userId, 11n, 3, 0));
      const postId = hex(uid('took-first/post'));
      putConfirmedPost(view, postId, owner.userId, 0);
      view.insertBox(
        seedProvenance<AnyBox>(
          { boxType: 'like_accrual', value: 4n, createdAtBlock: 0, author: owner.userId },
          0,
          200,
        ),
      );

      const H = 2;
      // Owner spends both of their karma boxes — rule 3 of the karma arm
      // (NODE_INTERFACE → Karma transition rules).
      const spend = consolidateTx(owner, view.getKarmaBoxes(owner.userId), H);
      const like = likeTx(liker, view.getKarmaBoxes(liker.userId)[0]!, postId, owner.userId, H);

      // The producer's build over pre-body state.
      const body = [spend, like].map((b) => ({ txId: b.txId, txBytes: encodeTx(b.tx) }));
      const built = buildBlockSettlement(view, body, H, miner.userId, miner.userId, CTX);
      if ('error' in built) throw new Error(built.error);

      // The applier's path: run applyBlock and compare the resulting
      // settlement bytes to the producer's.
      const block = applied(view, H, [spend, like]);
      const applierSettlement = settlementOf(block);
      expect(encodeTx(applierSettlement)).toEqual(encodeTx(built.tx));

      // No pre-body input of the owner is named; one fresh marked output
      // stands for the payout. The pre-body income box's id is spent by the
      // body, so it never reaches the settlement's input list.
      const outs = karmaOutputs(built.tx, owner.userId).filter((o) => o.income === true);
      expect(outs).toHaveLength(1);
      expect(outs[0]!.value).toBe(BigInt(LIKES_PER_KARMA_PAYOUT - 1));
    },
  );
});

// ---------------------------------------------------------------------------
// Decay is two inputs at most and one output
// ---------------------------------------------------------------------------

describe('decay is two inputs at most', () => {
  it(
    'a stale owner holding an own box and an income box spends; decay charges both and emits one unmarked box',
    () => {
      const view = genesisView();
      const owner = seededIdentity('decay/owner');
      // No activity: decay has interval 3 and threshold 6 under CTX.
      view.putIdentityRecord(owner.userId, identityRecord());
      const ownBox = karmaBox(owner.userId, 20n, 1, 0);
      const incomeBoxOwned = incomeBox(owner.userId, 30n, 2, 0);
      view.insertBox(ownBox);
      view.insertBox(incomeBoxOwned);

      const H = 20;
      // Owner spends the own box; the income box stands and decay charges it,
      // beside the body's change output.
      const spend = consolidateTx(owner, [ownBox], H);
      const block = applied(view, H, [spend]);
      const settlement = settlementOf(block);

      // The settlement charges the pre-body income box and the body's change
      // output — the two inputs the decay leg names.
      expect(settlement.inputs).toContain(incomeBoxOwned.id);
      expect(settlement.inputs).toContain(spend.out[0]!.id);
      // The owner ends with one unmarked box: the decay replacement.
      const after = view.getKarmaBoxes(owner.userId);
      expect(after).toHaveLength(1);
      expect(after[0]!.income).toBeUndefined();
    },
  );
});

// ---------------------------------------------------------------------------
// The invite grant and decay's replacement are unmarked
// ---------------------------------------------------------------------------

describe('the invite grant and decay\'s replacement stay unmarked', () => {
  it('an invite grant is a karma output without the income mark', () => {
    const view = genesisView();
    const inviter = seededIdentity('grant/inviter');
    view.putIdentityRecord(inviter.userId, identityRecord({ memberSinceBlock: 1 }));
    view.insertBox(karmaBox(inviter.userId, 100n, 1, 0));
    const invitee = seededIdentity('grant/invitee');
    // No existing identity record — the invitee is new.

    const H = 2;
    const inviteBox = {
      boxType: 'bond' as const,
      value: 25n,
      createdAtBlock: H,
      inviterId: inviter.userId,
      inviteePublicKey: invitee.userId,
    };
    const inviteTx = finish({
      inputs: [view.getKarmaBoxes(inviter.userId)[0]!.id!],
      outputs: [
        { boxType: 'karma', value: 75n, createdAtBlock: H, owner: inviter.userId } as AnyBoxCandidate,
        inviteBox as AnyBoxCandidate,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    }, inviter);
    const block = applied(view, H, [inviteTx]);
    const settlement = settlementOf(block);

    // The invite grant is emitted as a karma output owned by the invitee —
    // unmarked, so no `income` key.
    const grantToInvitee = karmaOutputs(settlement, invitee.userId);
    expect(grantToInvitee).toHaveLength(1);
    expect(grantToInvitee[0]!.income).toBeUndefined();
    expect(grantToInvitee[0]!.value).toBe(25n);
  });
});

// ---------------------------------------------------------------------------
// The two wrong settlements are refused
// ---------------------------------------------------------------------------

describe('settlements that do not pay through the income leg are refused', () => {
  it('a settlement paying a liked author with a fresh unmarked box is refused by position', () => {
    const view = genesisView();
    const author = seededIdentity('wrong-fresh/author');
    view.putIdentityRecord(author.userId, identityRecord());
    const liker = seededIdentity('wrong-fresh/liker');
    view.putIdentityRecord(liker.userId, identityRecord({ lastActivityBlock: 0 }));
    view.insertBox(karmaBox(liker.userId, 11n, 1, 0));
    const postId = hex(uid('wrong-fresh/post'));
    putConfirmedPost(view, postId, author.userId, 0);
    view.insertBox(
      seedProvenance<AnyBox>(
        { boxType: 'like_accrual', value: 4n, createdAtBlock: 0, author: author.userId },
        0,
        300,
      ),
    );
    const H = 2;
    const like = likeTx(liker, view.getKarmaBoxes(liker.userId)[0]!, postId, author.userId, H);
    const block = candidateBlock(view, H, [like], miner.userId, CTX);
    const settlement = settlementOf(block);
    // Rebuild the settlement with the author's karma output unmarked (the
    // retired shape): the applier's checkSettlement refuses it.
    const outs = settlement.outputs.map((o) => {
      if (o.boxType === 'karma' && hex((o as KarmaBox).owner) === hex(author.userId) && (o as KarmaBox).income === true) {
        const unmarked: AnyBoxCandidate = { ...o };
        delete (unmarked as Record<string, unknown>).income;
        return unmarked;
      }
      return o;
    });
    const tampered: UtxoTransaction = { ...settlement, outputs: outs };
    const tamperedBytes = encodeTx(tampered);
    block.utxoTxTree.utxoTxs[block.utxoTxTree.utxoTxs.length - 1] = tamperedBytes;
    block.utxoTxTree.utxoTxIds[block.utxoTxTree.utxoTxIds.length - 1] = computeTxId(tampered);
    const result = applyBlock(view, block, CTX);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // The reason is the output-position comparison's: the derivation
      // emits a marked income box where the tampered settlement emits an
      // unmarked one.
      expect(result.reason).toMatch(/settlement output/);
      expect(result.reason).toContain('income=true');
    }
  });

  it('a settlement omitting the income box it must consume is refused', () => {
    const view = genesisView();
    const author = seededIdentity('wrong-omit/author');
    view.putIdentityRecord(author.userId, identityRecord());
    view.insertBox(incomeBox(author.userId, 7n, 1, 0));
    const liker = seededIdentity('wrong-omit/liker');
    view.putIdentityRecord(liker.userId, identityRecord({ lastActivityBlock: 0 }));
    view.insertBox(karmaBox(liker.userId, 11n, 2, 0));
    const postId = hex(uid('wrong-omit/post'));
    putConfirmedPost(view, postId, author.userId, 0);
    view.insertBox(
      seedProvenance<AnyBox>(
        { boxType: 'like_accrual', value: 4n, createdAtBlock: 0, author: author.userId },
        0,
        400,
      ),
    );

    const H = 2;
    const like = likeTx(liker, view.getKarmaBoxes(liker.userId)[0]!, postId, author.userId, H);
    const block = candidateBlock(view, H, [like], miner.userId, CTX);
    const settlement = settlementOf(block);
    // Rebuild without the author's income input: a settlement that pays into
    // a new income box without consuming the one that stands.
    const authorIncomeId = view.getKarmaBoxes(author.userId).find((b) => b.income === true)!.id!;
    const inputs = settlement.inputs.filter((id) => id !== authorIncomeId);
    const tampered: UtxoTransaction = { ...settlement, inputs };
    block.utxoTxTree.utxoTxs[block.utxoTxTree.utxoTxs.length - 1] = encodeTx(tampered);
    block.utxoTxTree.utxoTxIds[block.utxoTxTree.utxoTxIds.length - 1] = computeTxId(tampered);
    const result = applyBlock(view, block, CTX);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // The reason is the input count comparison: the tampered settlement
      // consumes one box fewer than the derivation.
      expect(result.reason).toMatch(/settlement consumes/);
    }
  });
});

// ---------------------------------------------------------------------------
// Paid, decayed and swept in one block
// ---------------------------------------------------------------------------

describe('a stale owner spends both karma boxes in the block they are paid', () => {
  it(
    'decay charges the body\'s change, the income leg emits one fresh marked box, applyBlock and buildBlockSettlement answer the same bytes',
    () => {
      const view = genesisView();
      const owner = seededIdentity('swept-and-paid/owner');
      // lastActivityBlock = 0, so the owner is stale at any H ≥
      // staleThresholdBlocks = 6.
      view.putIdentityRecord(owner.userId, identityRecord());
      const ownBox = karmaBox(owner.userId, 20n, 1, 0);
      const incomeBoxOwned = incomeBox(owner.userId, 30n, 2, 0);
      view.insertBox(ownBox);
      view.insertBox(incomeBoxOwned);

      // One liker whose like credits owner as author.
      const liker = seededIdentity('swept-and-paid/liker');
      view.putIdentityRecord(liker.userId, identityRecord({ lastActivityBlock: 20 }));
      view.insertBox(karmaBox(liker.userId, 11n, 3, 0));
      const postId = hex(uid('swept-and-paid/post'));
      putConfirmedPost(view, postId, owner.userId, 0);
      // One pre-seeded carry of 4 so the one new marker brings the author's
      // total to LIKES_PER_KARMA_PAYOUT and the payout fires.
      view.insertBox(
        seedProvenance<AnyBox>(
          { boxType: 'like_accrual', value: 4n, createdAtBlock: 0, author: owner.userId },
          0,
          600,
        ),
      );

      const H = 20;
      // Owner spends BOTH karma boxes — rule 3 of the karma arm permits an
      // income box to ride beside the own box (NODE_INTERFACE → Karma
      // transition rules → "An identity holds at most two karma boxes").
      const spend = consolidateTx(owner, view.getKarmaBoxes(owner.userId), H);
      const like = likeTx(liker, view.getKarmaBoxes(liker.userId)[0]!, postId, owner.userId, H);

      // The producer's build over pre-body state matches the applier's.
      const body = [spend, like].map((b) => ({ txId: b.txId, txBytes: encodeTx(b.tx) }));
      const built = buildBlockSettlement(view, body, H, miner.userId, miner.userId, CTX);
      if ('error' in built) throw new Error(built.error);

      const block = applied(view, H, [spend, like]);
      const applierSettlement = settlementOf(block);
      expect(encodeTx(applierSettlement)).toEqual(encodeTx(built.tx));

      // Decay fires on the body's change — the one karma box post-body —
      // and emits one unmarked box of the effective value; the income leg
      // names no karma input for the owner (the body already spent them)
      // and emits one fresh marked box of the payout.
      const changeId = spend.out[0]!.id!;
      expect(applierSettlement.inputs).toContain(changeId);
      expect(applierSettlement.inputs).not.toContain(ownBox.id);
      expect(applierSettlement.inputs).not.toContain(incomeBoxOwned.id);
      expect(new Set(applierSettlement.inputs).size).toBe(applierSettlement.inputs.length);

      const after = view.getKarmaBoxes(owner.userId);
      expect(after).toHaveLength(2);
      const ownAfter = after.filter((b) => b.income !== true);
      const incomeAfter = after.filter((b) => b.income === true);
      expect(ownAfter).toHaveLength(1);
      expect(incomeAfter).toHaveLength(1);
      expect(incomeAfter[0]!.value).toBe(BigInt(LIKES_PER_KARMA_PAYOUT - 1));
    },
  );
});

// ---------------------------------------------------------------------------
// Paid and decayed, not swept
// ---------------------------------------------------------------------------

describe('a stale owner spends the own box alone in the block they are paid', () => {
  it(
    'decay consumes the income box with the change, the income leg names no input and emits one fresh marked box, both builders agree byte for byte',
    () => {
      const view = genesisView();
      const owner = seededIdentity('not-swept/owner');
      view.putIdentityRecord(owner.userId, identityRecord());
      const ownBox = karmaBox(owner.userId, 20n, 1, 0);
      const incomeBoxOwned = incomeBox(owner.userId, 30n, 2, 0);
      view.insertBox(ownBox);
      view.insertBox(incomeBoxOwned);

      const liker = seededIdentity('not-swept/liker');
      view.putIdentityRecord(liker.userId, identityRecord({ lastActivityBlock: 20 }));
      view.insertBox(karmaBox(liker.userId, 11n, 3, 0));
      const postId = hex(uid('not-swept/post'));
      putConfirmedPost(view, postId, owner.userId, 0);
      view.insertBox(
        seedProvenance<AnyBox>(
          { boxType: 'like_accrual', value: 4n, createdAtBlock: 0, author: owner.userId },
          0,
          700,
        ),
      );

      const H = 20;
      // Owner spends the own box alone; the income box stands pre-body.
      const spend = consolidateTx(owner, [ownBox], H);
      const like = likeTx(liker, view.getKarmaBoxes(liker.userId)[0]!, postId, owner.userId, H);

      const body = [spend, like].map((b) => ({ txId: b.txId, txBytes: encodeTx(b.tx) }));
      const built = buildBlockSettlement(view, body, H, miner.userId, miner.userId, CTX);
      if ('error' in built) throw new Error(built.error);

      const block = applied(view, H, [spend, like]);
      const applierSettlement = settlementOf(block);
      expect(encodeTx(applierSettlement)).toEqual(encodeTx(built.tx));

      // Decay consumes both — the income box standing pre-body and the
      // body's change (NODE_INTERFACE → Karma decay → "The leg is two
      // inputs at most and one output") — and emits one unmarked box. The
      // income leg takes the income box out through decay's excludeIds and
      // emits one fresh marked box of the payout.
      const changeId = spend.out[0]!.id!;
      expect(applierSettlement.inputs).toContain(incomeBoxOwned.id);
      expect(applierSettlement.inputs).toContain(changeId);
      expect(applierSettlement.inputs).not.toContain(ownBox.id);
      expect(new Set(applierSettlement.inputs).size).toBe(applierSettlement.inputs.length);

      const after = view.getKarmaBoxes(owner.userId);
      expect(after).toHaveLength(2);
      const ownAfter = after.filter((b) => b.income !== true);
      const incomeAfter = after.filter((b) => b.income === true);
      expect(ownAfter).toHaveLength(1);
      expect(incomeAfter).toHaveLength(1);
      expect(incomeAfter[0]!.value).toBe(BigInt(LIKES_PER_KARMA_PAYOUT - 1));
    },
  );
});

// ---------------------------------------------------------------------------
// Twenty blocks over the tree view
// ---------------------------------------------------------------------------

describe('an author paid in twenty consecutive blocks over the tree view', () => {
  it(
    'ends with their own box and one marked box of the sum, and one of the blocks replays from its proof alone',
    () => {
      // Seed a MapTreeSession for building and a BatchAVLProver for
      // proving: both carry the identical initial writes
      // (CONSENSUS_INTERFACE → The tree session · The block proof).
      const author = seededIdentity('twenty-over-tree/author');
      const authorOwn = karmaBox(author.userId, 10n, 1, 0);
      const BLOCKS = 20;
      const likers = Array.from({ length: BLOCKS }, (_, i) =>
        seededIdentity(`twenty-over-tree/liker-${i}`),
      );
      const initialBoxes: AnyBox[] = [
        protocolBox('emission', PROFILE.creditEmissionTotal, 2000),
        protocolBox('karma_pool', 1_000_000n, 2001),
        authorOwn as AnyBox,
      ];
      let seedNonce = 2100;
      for (let i = 0; i < BLOCKS; i++) {
        initialBoxes.push(karmaBox(likers[i]!.userId, 11n, seedNonce++, 0));
      }
      const authorRec: IdentityRecord = identityRecord();
      const initialRecords: Array<{ identityId: Uint8Array; record: IdentityRecord }> = [
        { identityId: miner.userId, record: identityRecord({ memberSinceBlock: 1 }) },
        { identityId: author.userId, record: authorRec },
      ];
      for (let i = 0; i < BLOCKS; i++) {
        initialRecords.push({
          identityId: likers[i]!.userId,
          // lastActivityBlock = 2 + i − 1 keeps each liker fresh at the
          // block they sign, so decay never fires on them.
          record: identityRecord({ lastActivityBlock: 1 + i }),
        });
      }
      const network: NetworkRecord = { memberCount: 1 };

      const initialWrites = seedTreeWrites(initialBoxes, initialRecords, network);
      const session = mapSessionFrom(initialWrites);
      const prover = proverFrom(initialWrites);

      // The author's confirmed post, inserted into both the MapTreeSession
      // and the prover before the first block. The tree view answers a
      // post's author and standing from this row.
      const postId = bytesToHex(uid('twenty-over-tree/post'));
      const postSeed = [
        {
          tag: 'Insert' as const,
          key: postKey(hexToBytes(postId)),
          value: postRecordBytes({ author: author.userId, height: 1, standing: 'live' as const }),
        },
      ];
      session.apply(postSeed);
      for (const w of postSeed) {
        if (!prover.performOneOperation(w).success) throw new Error('prover refused post seed');
      }
      prover.generateProof();

      const chain: Array<{
        height: number;
        block: OrderingBlock;
        parentDigest: Uint8Array;
        proof: Uint8Array;
        digest: Uint8Array;
      }> = [];

      for (let i = 0; i < BLOCKS; i++) {
        const H = 2 + i;
        const liker = likers[i]!;
        const buildView = treeStateView(session);
        const likerBox = buildView.getKarmaBoxes(liker.userId)[0]!;
        const like = likeTx(liker, likerBox, postId, author.userId, H);
        const block = candidateBlock(buildView, H, [like], miner.userId, CTX);
        const parentDigest = prover.digest();
        const proven = proveBlock(prover, block, CTX);
        if (!proven.result.ok) {
          throw new Error(`block ${H} was refused over the prover: ${proven.result.reason}`);
        }
        session.apply(proven.writes);
        chain.push({ height: H, block, parentDigest, proof: proven.proof, digest: proven.digest });
      }

      // After the twenty blocks the tree holds the author's unchanged own
      // box and one marked income box whose value is the sum of the
      // payouts.
      const finalView = treeStateView(session);
      const held = finalView.getKarmaBoxes(author.userId);
      expect(held).toHaveLength(2);
      const ownHeld = held.filter((b) => b.income !== true);
      const incomeHeld = held.filter((b) => b.income === true);
      expect(ownHeld).toHaveLength(1);
      expect(ownHeld[0]!.id).toBe(authorOwn.id);
      expect(incomeHeld).toHaveLength(1);
      const expectedPayout = BigInt(Math.floor(BLOCKS / LIKES_PER_KARMA_PAYOUT)) * BigInt(LIKES_PER_KARMA_PAYOUT - 1);
      expect(incomeHeld[0]!.value).toBe(expectedPayout);

      // One of the twenty blocks replays from its parent's digest and its
      // proof alone, to the same digest proveBlock answered
      // (CONSENSUS_INTERFACE → The tree session).
      const picked = chain[Math.floor(chain.length / 2)]!;
      const replay = replayBlock(picked.parentDigest, picked.proof, picked.block, CTX);
      expect(replay.digest).toEqual(picked.digest);
    },
  );
});
