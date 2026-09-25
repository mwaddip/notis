import { describe, it, expect } from 'vitest';
import {
  KARMA_DECAY_AMOUNT,
  KARMA_MINIMUM,
  PROTOCOL_VERSION,
  STORAGE_RENT_PER_BYTE,
  boxRecordBytes,
  computeTxId,
  decodeTx,
  encodeTx,
  profileFor,
} from '@dagsocial/types';
import type { AnyBox, AnyBoxCandidate, CreditBox, KarmaBox, OrderingBlock, UtxoTransaction, VouchBox } from '@dagsocial/types';
import { applyBlock, materializeOutput } from '@dagsocial/consensus';
import type { ApplyContext, BlockEffects } from '@dagsocial/consensus';
import {
  MemoryStateView,
  applyContextFor,
  burnTx,
  candidateBlock,
  changeOf,
  claimTx,
  consolidateTx,
  creditSendTx,
  finish,
  hex,
  identityRecord,
  inviteTx,
  karmaBox,
  likeTx,
  protocolBox,
  replyTx,
  seedProvenance,
  seededIdentity,
  threadTx,
  unvouchTx,
  vouchTx,
  withdrawTx,
  writeEffects,
  type Built,
} from './helpers.js';

/**
 * `applyBlock` over a stub view (CONSENSUS_INTERFACE → Applying a block): a
 * chain of blocks, each settled by the producer's build over the view the
 * applier then reads, each block's effects written into the view before the
 * next; and bodies each refused on a read of what an earlier transaction in the
 * same block wrote. Between them every kind of write is followed by a read of
 * it: a box inserted and spent, an identity record, a name and a holder record
 * written and removed, an escrow, a vouch, an owner's karma, an author's accrual
 * boxes, a post's topology and standing, and a like record.
 *
 * The profile numbers are devnet's, the timescales shortened so that the
 * cooldown, the probation, decay and rent all come due within a few blocks.
 */

const ctx: ApplyContext = {
  ...applyContextFor(profileFor('devnet')),
  inviteProbationBlocks: 3,
  storageRentPeriodBlocks: 4,
  vouchCooldownBlocks: 3,
  decayCfg: { staleThresholdBlocks: 6, decayIntervalBlocks: 3, decayAmount: KARMA_DECAY_AMOUNT, karmaMinimum: KARMA_MINIMUM },
};

const miner = seededIdentity('apply/miner');
const [r1, r2, r3] = [seededIdentity('apply/root-1'), seededIdentity('apply/root-2'), seededIdentity('apply/root-3')];
const t = seededIdentity('apply/target');
const x = seededIdentity('apply/second-target');
const [u, v, w] = [seededIdentity('apply/name-holder'), seededIdentity('apply/passing-name'), seededIdentity('apply/withdrawer')];
const [l1, l2] = [seededIdentity('apply/liker-1'), seededIdentity('apply/liker-2')];
const [c1, c2] = [seededIdentity('apply/credit-sender'), seededIdentity('apply/credit-recipient')];
const [i1, i2] = [seededIdentity('apply/invitee-1'), seededIdentity('apply/invitee-2')];
const CREDIT = 10n ** 8n;

/** Three roots, residents holding karma and a record, a credit holder, and the protocol boxes. */
function genesis(): { view: MemoryStateView; c1Credit: CreditBox } {
  const view = new MemoryStateView({ memberCount: 3 });
  let nonce = 1;
  const root = identityRecord({ memberSinceBlock: 1 });
  for (const [who, values] of [[r1, [1000n]], [r2, [1000n]], [r3, [6n, 6n]]] as const) {
    for (const value of values) view.insertBox(karmaBox(who.userId, value, nonce++, 0));
    view.putIdentityRecord(who.userId, root);
  }
  for (const who of [t, x, u, v, w, l1, l2]) {
    view.insertBox(karmaBox(who.userId, 100n, nonce++, 0));
    view.putIdentityRecord(who.userId, identityRecord());
  }
  const c1Credit = seedProvenance<CreditBox>(
    { boxType: 'credit', value: 100n * CREDIT, createdAtBlock: 0, owner: c1.userId },
    0,
    nonce++,
  );
  view.insertBox(c1Credit);
  view.insertBox(protocolBox('emission', profileFor('devnet').creditEmissionTotal, nonce++));
  view.insertBox(protocolBox('karma_pool', 1_000_000n, nonce++));
  return { view, c1Credit };
}

const largest = (view: MemoryStateView, who: { userId: Uint8Array }): KarmaBox => {
  const box = view.getKarmaBoxes(who.userId)[0];
  if (!box) throw new Error(`${hex(who.userId).slice(0, 8)} holds no karma`);
  return box;
};

/** Each mutation as one line, so a block's writes compare as a list. */
function summary(mutations: BlockEffects['mutations']): string[] {
  return mutations.map((m) => {
    switch (m.kind) {
      case 'box':
        return m.op === 'insert' ? `+${m.box.boxType}:${m.boxId}` : `-${m.boxId}`;
      case 'record':
        return `record:${hex(m.identityId)}`;
      case 'network':
        return `network:${m.record.memberCount}`;
      case 'username':
        return `name:${m.nameLower}:${m.row === null ? 'remove' : 'put'}:held=${m.heldBefore}`;
      case 'holder':
        return `holder:${hex(m.owner)}:${m.record === null ? 'remove' : 'put'}:held=${m.heldBefore}`;
    }
  });
}

/** The block's settlement, decoded, with the ids its outputs take. */
function settlementOf(block: OrderingBlock): { inputs: string[]; out: AnyBox[] } {
  const bytes = block.utxoTxTree.utxoTxs.at(-1)!;
  const id = block.utxoTxTree.utxoTxIds.at(-1)!;
  const tx = decodeTx(bytes);
  return { inputs: tx.inputs, out: tx.outputs.map((o, i) => materializeOutput(o, id, i)) };
}

function applied(view: MemoryStateView, block: OrderingBlock): BlockEffects {
  const before = view.digest();
  const result = applyBlock(view, block, ctx);
  expect(view.digest()).toBe(before);
  if (!result.ok) throw new Error(`block ${block.header.height} was refused: ${result.reason}`);
  return result.effects;
}

/** A body the block's rules refuse, and the phrase of the rule it breaks. */
function expectRefused(view: MemoryStateView, height: number, txs: Built[], rule: string): void {
  const before = view.digest();
  const result = applyBlock(view, candidateBlock(view, height, txs, miner.userId, ctx), ctx);
  expect(result).toEqual({ ok: false, reason: expect.stringContaining(rule) });
  expect(view.digest()).toBe(before);
}

describe('applyBlock — a chain of blocks over a stub view', () => {
  const { view, c1Credit } = genesis();
  const blocks = new Map<number, { block: OrderingBlock; effects: BlockEffects; after: MemoryStateView }>();
  const step = (height: number, txs: Built[]): BlockEffects => {
    const block = candidateBlock(view, height, txs, miner.userId, ctx);
    const effects = applied(view, block);
    writeEffects(view, effects, height);
    blocks.set(height, { block, effects, after: view.clone() });
    return effects;
  };
  const emission = view.getEmissionBox()!;
  const pool = view.getKarmaPoolBox()!;

  // Block 1's transactions, which later blocks name.
  const tInput = largest(view, t);
  const r1Input = largest(view, r1);
  const r2Input = largest(view, r2);
  const wInput = largest(view, w);
  const tThread = threadTx(t, tInput, 'the target opens a thread', 1);
  const r2Reply = replyTx(r2, r2Input, 'a reply in the block that confirms its parent', tThread.postId, t.userId, 1);
  const r1Like = likeTx(r1, r1Input, tThread.postId, t.userId, 1);
  const wThread = threadTx(w, wInput, 'a thread its author withdraws', 1);

  it('block 1: a thread, a reply and a like in the block confirming the thread — every write in order', () => {
    const effects = step(1, [tThread, r2Reply, r1Like, wThread]);
    const { block } = blocks.get(1)!;
    const settlement = settlementOf(block);

    expect(effects.posts.map((p) => p.postId)).toEqual([tThread.postId, r2Reply.postId, wThread.postId]);
    expect(effects.likeRecords).toEqual([{ targetPostId: tThread.postId, likerId: r1.userId }]);
    expect(effects.withdrawals).toEqual([]);
    expect(effects.appliedTxs).toEqual(
      [tThread, r2Reply, r1Like, wThread].map((b) => ({ txId: b.txId, txBytes: encodeTx(b.tx) })),
    );
    expect(settlement.inputs).toEqual([
      emission.id,
      r2Reply.out[2]!.id, r1Like.out[1]!.id,
      tThread.out[1]!.id, r2Reply.out[1]!.id, wThread.out[1]!.id,
      pool.id,
    ]);
    expect(summary(effects.mutations)).toEqual([
      `-${tInput.id}`, `+karma:${tThread.out[0]!.id}`, `+karma_price:${tThread.out[1]!.id}`, `record:${hex(t.userId)}`,
      `-${r2Input.id}`, `+karma:${r2Reply.out[0]!.id}`, `+karma_price:${r2Reply.out[1]!.id}`,
      `+like_accrual:${r2Reply.out[2]!.id}`, `record:${hex(r2.userId)}`,
      `-${r1Input.id}`, `+karma:${r1Like.out[0]!.id}`, `+like_accrual:${r1Like.out[1]!.id}`,
      `-${wInput.id}`, `+karma:${wThread.out[0]!.id}`, `+karma_price:${wThread.out[1]!.id}`, `record:${hex(w.userId)}`,
      ...settlement.inputs.map((id) => `-${id}`),
      ...settlement.out.map((b) => `+${b.boxType}:${b.id}`),
      `record:${hex(t.userId)}`,
    ]);

    // The activity bump and the like counter each read the other's write.
    expect(view.getIdentityRecord(t.userId)).toEqual(identityRecord({
      lastActivityBlock: 1, lifetimeLikesReceived: 1n, memberLikes: 1n,
    }));
    expect(view.getTopologyAuthor(r2Reply.postId)).toEqual(r2.userId);
    expect(view.getLikeAccrualBoxes(t.userId).map((b) => b.value)).toEqual([2n]);
  });

  // Block 2's transactions.
  let r1Vouch: Built;
  let r2Invite: Built;
  let uClaim: Built;
  let c1Send: Built;

  it('block 2: a vouch and a member\'s like set the target, a root\'s invite confers, chained spends apply', () => {
    // Two boxes of 6 consolidated, then a vouch the consolidated 12 alone clears the bar for.
    const r3Consolidate = consolidateTx(r3, view.getKarmaBoxes(r3.userId), 2);
    const r3Vouch = vouchTx(r3, changeOf(r3Consolidate), x.userId, 2);
    r1Vouch = vouchTx(r1, largest(view, r1), t.userId, 2);
    const r2Like = likeTx(r2, largest(view, r2), tThread.postId, t.userId, 2);
    r2Invite = inviteTx(r2, changeOf(r2Like), i1.userId, 25n, 2);
    uClaim = claimTx(u, largest(view, u), 'Pinned', 2);
    c1Send = creditSendTx(c1, c1Credit, 40n * CREDIT, c2.userId, CREDIT, 2);
    const l1Like = likeTx(l1, largest(view, l1), tThread.postId, t.userId, 2);
    const l1Reply = replyTx(l1, changeOf(l1Like), 'a reply paid from its own change', wThread.postId, w.userId, 2);
    const carry = view.getLikeAccrualBoxes(t.userId)[0]!;
    const effects = step(2, [r3Consolidate, r3Vouch, r1Vouch, r2Like, r2Invite, uClaim, c1Send, l1Like, l1Reply]);
    const settlement = settlementOf(blocks.get(2)!.block);

    expect(settlement.inputs).toContain(carry.id);
    expect(settlement.inputs).toContain(c1Send.out[2]!.id);
    expect(summary(effects.mutations)).toContain('network:5');
    expect(view.getIdentityRecord(t.userId)).toEqual(identityRecord({
      lastActivityBlock: 1,
      lifetimeLikesReceived: 3n,
      memberLikes: 2n,
      memberVouches: 1,
      memberSinceBlock: 2,
      memberBar: 1,
    }));
    expect(view.getIdentityRecord(i1.userId)).toEqual(identityRecord({
      lastActivityBlock: 2, invitedAtBlock: 2, memberSinceBlock: 2,
    }));
    expect(view.getKarmaBoxes(i1.userId).map((b) => b.value)).toEqual([25n]);
    expect(view.getIdentityRecord(r2.userId)?.invitesUsed).toBe(1);
    expect(view.getNetworkRecord()).toEqual({ memberCount: 5 });
    expect(view.getUsernameByOwner(u.userId)?.nameLower).toBe('pinned');
    expect(view.getVouchBoxes(r3.userId, x.userId)).toHaveLength(1);
    expect(view.getIdentityRecord(x.userId)?.memberVouches).toBe(1);
  });

  it('block 3: a name claimed and burned in one block — the name and holder keys are created, then removed', () => {
    const vClaim = claimTx(v, largest(view, v), 'Fleeting', 3);
    const vBurn = burnTx(v, changeOf(vClaim), vClaim.out[1]!, 3);
    const effects = step(3, [vClaim, vBurn]);

    expect(summary(effects.mutations).filter((line) => /^(name|holder):/.test(line))).toEqual([
      'name:fleeting:put:held=false',
      `holder:${hex(v.userId)}:put:held=false`,
      'name:fleeting:remove:held=true',
      `holder:${hex(v.userId)}:remove:held=true`,
    ]);
    expect(view.getUsername('fleeting')).toBeNull();
    expect(view.getUsernameByOwner(v.userId)).toBeNull();
  });

  it('block 4: a burn, its owner\'s next claim and another\'s claim of the burned name each read the removal', () => {
    const uBurn = burnTx(u, largest(view, u), uClaim.out[1]!, 4);
    const uSecond = claimTx(u, changeOf(uBurn), 'Second', 4);
    const wPinned = claimTx(w, largest(view, w), 'pinned', 4);
    const effects = step(4, [uBurn, uSecond, wPinned]);

    expect(summary(effects.mutations).filter((line) => /^(name|holder):/.test(line))).toEqual([
      'name:pinned:remove:held=true',
      `holder:${hex(u.userId)}:remove:held=true`,
      'name:second:put:held=false',
      `holder:${hex(u.userId)}:put:held=false`,
      'name:pinned:put:held=false',
      `holder:${hex(w.userId)}:put:held=false`,
    ]);
    expect(view.getUsernameByOwner(u.userId)?.nameLower).toBe('second');
    expect(view.getUsername('pinned')?.owner).toBe(hex(w.userId));
  });

  let unvouchEscrow: AnyBox;

  it('block 5: a like and a withdrawal of one post, an unvouch that lapses its target, the bond settling', () => {
    const l2Like = likeTx(l2, largest(view, l2), wThread.postId, w.userId, 5);
    const wWithdraw = withdrawTx(w, largest(view, w), wThread.postId, 5);
    const staked = r1Vouch.out[1]! as VouchBox;
    const r1Unvouch = unvouchTx(r1, staked, ctx.vouchCooldownBlocks, 5);
    unvouchEscrow = r1Unvouch.out[0]!;
    const effects = step(5, [l2Like, wWithdraw, r1Unvouch]);
    const settlement = settlementOf(blocks.get(5)!.block);

    expect(effects.withdrawals).toEqual([wThread.postId]);
    expect(effects.likeRecords).toEqual([{ targetPostId: wThread.postId, likerId: l2.userId }]);
    expect(view.getPostStanding(wThread.postId)).toBe('withdrawn');
    // Releasable at creation (cast at 2, cooldown 3), and not in pre-body state.
    expect(settlement.inputs).not.toContain(unvouchEscrow.id);
    expect(view.getBox(unvouchEscrow.id!)).toEqual(unvouchEscrow);
    // Invited at 2 with a probation of 3: the bond settles here, read after this
    // block wrote the target's record.
    expect(settlement.inputs).toContain(r2Invite.out[1]!.id);
    expect(view.getIdentityRecord(t.userId)?.memberVouches).toBe(0);
    expect(view.getNetworkRecord()).toEqual({ memberCount: 4 });
  });

  it('block 6: an empty body releases the escrow the last block created', () => {
    step(6, []);
    const settlement = settlementOf(blocks.get(6)!.block);
    expect(settlement.inputs).toContain(unvouchEscrow.id);
    expect(settlement.out).toContainEqual(expect.objectContaining({ boxType: 'karma', value: 1n, owner: r1.userId }));
    expect(view.getVouchEscrowsFor(r1.userId)).toEqual([]);
  });

  it('block 8: decay squares the stale owners the body touches, one of them posting; rent collects a dormant box', () => {
    const l2Karma = view.getKarmaBoxes(l2.userId);
    const consolidate = consolidateTx(l2, l2Karma, 8);
    const xThread = threadTx(x, largest(view, x), 'a stale owner posts', 8);
    const dormant = c1Send.out[0]! as CreditBox;
    const charge = STORAGE_RENT_PER_BYTE * BigInt(boxRecordBytes(dormant, dormant.txId, dormant.index).length);
    const rent = finish({
      inputs: [dormant.id!],
      outputs: [
        { boxType: 'credit', value: dormant.value - charge, createdAtBlock: 8, owner: dormant.owner } as AnyBoxCandidate,
        { boxType: 'fee', value: charge, createdAtBlock: 8 } as AnyBoxCandidate,
      ],
      signatures: {},
      protocolVersion: PROTOCOL_VERSION,
    }, null);
    step(8, [consolidate, xThread, rent]);
    const settlement = settlementOf(blocks.get(8)!.block);

    // Each stale at 8 with two whole intervals owed, 10 burned: 99 face leaves 89,
    // and the poster's 95 change leaves 85 — the staleness read before its post.
    expect(settlement.inputs).toContain(consolidate.out[0]!.id);
    expect(settlement.inputs).toContain(xThread.out[0]!.id);
    expect(settlement.inputs).toContain(rent.out[1]!.id);
    expect(view.getKarmaBoxes(l2.userId).map((b) => b.value)).toEqual([89n]);
    expect(view.getKarmaBoxes(x.userId).map((b) => b.value)).toEqual([85n]);
    expect(view.getIdentityRecord(l2.userId)).toEqual(identityRecord({ lastDecayBlock: 8 }));
    // Written twice in the block: the activity bump, then the decay clock.
    expect(view.getIdentityRecord(x.userId)).toEqual(identityRecord({ lastActivityBlock: 8, lastDecayBlock: 8, memberVouches: 1 }));
    const xWrites = blocks.get(8)!.effects.mutations
      .filter((m) => m.kind === 'record' && hex(m.identityId) === hex(x.userId));
    expect(xWrites).toHaveLength(2);
  });

  describe('bodies refused on a read of an earlier write in the same block', () => {
    const at2 = (): MemoryStateView => blocks.get(2)!.after;

    it('a second vouch for one pair', () => {
      const first = vouchTx(r2, largest(at2(), r2), x.userId, 3);
      expectRefused(at2(), 3, [first, vouchTx(r2, changeOf(first), x.userId, 3)], 'A live vouch already exists');
    });

    it('a cast behind the voucher\'s own unvouch', () => {
      const unvouch = unvouchTx(r1, r1Vouch.out[1]! as VouchBox, ctx.vouchCooldownBlocks, 3);
      expectRefused(at2(), 3, [unvouch, vouchTx(r1, largest(at2(), r1), x.userId, 3)], 'Vouch cast is locked');
    });

    it('a vouch after the voucher\'s own spend took it below the bar', () => {
      const spend = threadTx(r3, largest(at2(), r3), 'a root spends down', 3);
      expectRefused(at2(), 3, [spend, vouchTx(r3, changeOf(spend), t.userId, 3)], 'Vouch cast requires a karma balance');
    });

    it('one name claimed twice', () => {
      expectRefused(at2(), 3, [
        claimTx(l1, largest(at2(), l1), 'twice', 3),
        claimTx(l2, largest(at2(), l2), 'Twice', 3),
      ], 'name taken');
    });

    it('two names for one identity', () => {
      const first = claimTx(l2, largest(at2(), l2), 'one', 3);
      expectRefused(at2(), 3, [first, claimTx(l2, changeOf(first), 'two', 3)], 'identity holds a name');
    });

    it('one box spent twice', () => {
      const input = largest(at2(), l2);
      expectRefused(at2(), 3, [threadTx(l2, input, 'first', 3), threadTx(l2, input, 'second', 3)], 'unresolved input');
    });

    it('one post liked twice by one liker', () => {
      const first = likeTx(l2, largest(at2(), l2), tThread.postId, t.userId, 3);
      expectRefused(at2(), 3, [first, likeTx(l2, changeOf(first), tThread.postId, t.userId, 3)], 'duplicates an existing like-record');
    });

    it('a withdrawal in the block confirming the post', () => {
      const post = threadTx(l2, largest(at2(), l2), 'withdrawn too soon', 3);
      expectRefused(at2(), 3, [post, withdrawTx(l2, changeOf(post), post.postId, 3)], 'is not confirmed in an earlier block');
    });

    it('two bonds naming one invitee', () => {
      expectRefused(at2(), 3, [
        inviteTx(r1, largest(at2(), r1), i2.userId, 25n, 3),
        inviteTx(r2, largest(at2(), r2), i2.userId, 25n, 3),
      ], 'which another bond in this block already names');
    });

    it('a like on a post an earlier block withdrew', () => {
      const at5 = blocks.get(5)!.after;
      expectRefused(at5, 6, [likeTx(l1, largest(at5, l1), wThread.postId, w.userId, 6)], 'withdrawn or unknown post');
    });

    it('a like on a post no block confirmed', () => {
      expectRefused(at2(), 3, [likeTx(l1, largest(at2(), l1), 'ab'.repeat(32), t.userId, 3)], 'is not confirmed, so it names no author');
    });
  });

  describe('the body itself', () => {
    const at2 = (): MemoryStateView => blocks.get(2)!.after;
    const refusedAs = (block: OrderingBlock, rule: string): void => {
      expect(applyBlock(at2(), block, ctx)).toEqual({ ok: false, reason: expect.stringContaining(rule) });
    };
    const valid = (): OrderingBlock =>
      candidateBlock(at2(), 3, [threadTx(l1, largest(at2(), l1), 'a thread at height 3', 3)], miner.userId, ctx);

    it('an empty body carries no settlement', () => {
      const block = valid();
      refusedAs({ ...block, utxoTxTree: { utxoTxIds: [], utxoTxs: [] } }, 'body carries no settlement transaction');
    });

    it('a declared id with no bytes, bytes that do not decode, and an id the bytes do not produce', () => {
      const block = valid();
      const { utxoTxIds, utxoTxs } = block.utxoTxTree;
      refusedAs({ ...block, utxoTxTree: { utxoTxIds, utxoTxs: utxoTxs.slice(0, 1) } }, 'carries no body');
      refusedAs({ ...block, utxoTxTree: { utxoTxIds, utxoTxs: [new Uint8Array([1, 2, 3]), utxoTxs[1]!] } }, 'did not decode');
      refusedAs({ ...block, utxoTxTree: { utxoTxIds: ['cd'.repeat(32), utxoTxIds[1]!], utxoTxs } }, 'declares an id its bytes do not produce');
    });

    it('a settlement whose coinbase is one base unit short', () => {
      const block = valid();
      const settlement = decodeTx(block.utxoTxTree.utxoTxs[1]!);
      const coinbase = settlement.outputs.at(-1)!;
      const short: UtxoTransaction = {
        ...settlement,
        outputs: [...settlement.outputs.slice(0, -1), { ...coinbase, value: coinbase.value - 1n } as AnyBoxCandidate],
      };
      refusedAs({
        ...block,
        utxoTxTree: {
          utxoTxIds: [block.utxoTxTree.utxoTxIds[0]!, computeTxId(short)],
          utxoTxs: [block.utxoTxTree.utxoTxs[0]!, encodeTx(short)],
        },
      }, 'coinbase value');
    });

    it('reads no header field but the height and the validator, and answers the same effects twice', () => {
      const block = valid();
      const reheadered: OrderingBlock = {
        ...block,
        header: { ...block.header, powNonce: 7, createdAt: 99, stateRoot: 'ff'.repeat(33), prevBlockHash: 'ee'.repeat(32) },
        validatorSignature: new Uint8Array(64).fill(9),
      };
      const first = applyBlock(at2(), block, ctx);
      expect(first.ok).toBe(true);
      expect(applyBlock(at2(), block, ctx)).toEqual(first);
      expect(applyBlock(at2(), reheadered, ctx)).toEqual(first);
    });

    it('a view that throws is not a verdict: the throw leaves applyBlock unchanged', () => {
      const broken = at2().clone();
      const corrupt = new Error('the view found its storage corrupt');
      broken.getNetworkRecord = () => { throw corrupt; };
      expect(() => applyBlock(broken, candidateBlock(at2(), 3, [], miner.userId, ctx), ctx)).toThrow(corrupt);
    });
  });
});
